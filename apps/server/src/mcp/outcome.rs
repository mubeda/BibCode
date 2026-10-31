//! Owned mutations and recorded outcomes (#139, C4).
//!
//! Git and pull request RPCs carry no command receipt: re-running a commit makes a second
//! commit. A tool for one of them runs it through [`ToolCall::recorded`], which gives it two
//! guarantees.
//!
//! **Live controls.** The work runs under one cancellation token that fires when this
//! environment's MCP server is turned off, its ceiling drops to read-only, the session is
//! revoked, or `McpControl` shuts down; the RPC handler receives that token, so Git and the
//! hosting client stop as on a UI disconnect. Work the token interrupted is `unknown`, never
//! success: a push cut off mid-flight may or may not have reached the remote. So is work that
//! returns a failure marked by [`outcome_unknown`] (a host that stopped answering after the
//! request may have reached it), with the work's own failure kept. Turning a
//! capability set off does not interrupt work in flight (C4 lists only the four controls);
//! it refuses the next call.
//!
//! **At most once.** With a `clientRequestId`, the work is an *owned mutation*: it runs as a
//! task owned by `McpControl`, so a cancelled MCP call stops waiting but not the work, and it
//! holds its own maintenance admission and one of 2 per-session (8 per-environment) owned
//! slots until its outcome is written. Its row in `mcp_tool_requests` goes `running`, then
//! `done`, `failed` or `unknown`, and a retry returns the stored outcome without running
//! anything. An outcome that cannot be written is answered as `McpOutcomeUnknownError`
//! (`unrecorded`), never as the work's result. A `running` row with no in-process claim (a
//! restart or crash mid-call, or an outcome nothing could write) answers
//! `McpOutcomeUnknownError`.
//! Without a key the work runs inline, under the same controls plus the call's cancellation.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;

use super::{
    control::{
        ClientPrincipal, McpAccess, McpControl, RequestKey, STREAM_BUDGET, ToolCall, ToolResult,
        idempotency_conflict, now_iso, prune_request_rows, rpc_failure, storage_failure,
    },
    protocol::typed_tool_failure,
};
use crate::{
    RpcMutability,
    persistence::Database,
    rpc::{RpcRegistry, RpcSessionContext, STREAM_ENDED_TAG, StreamOutcome},
};

pub(crate) const OUTCOME_UNKNOWN_TAG: &str = "McpOutcomeUnknownError";
/// How long interrupted work may take to notice its token before it is dropped.
const INTERRUPT_GRACE: Duration = Duration::from_secs(10);

/// Why owned work stopped before it reported a result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Interruption {
    Disabled,
    ReadOnly,
    Revoked,
    Shutdown,
    /// The call's own cancellation (unkeyed work only).
    Cancelled,
    /// A stream-only RPC ended before its terminal event.
    StreamEnded,
    /// A `running` row that no process owns: BiBCode restarted or crashed mid-call.
    Restarted,
    /// The work ended but its outcome could not be written.
    Unrecorded,
    /// The host or remote stopped answering after the request may have reached it.
    NoAnswer,
}

impl Interruption {
    pub(crate) const fn reason(self) -> &'static str {
        match self {
            Self::Disabled => "mcp-disabled",
            Self::ReadOnly => "read-only",
            Self::Revoked => "revoked",
            Self::Shutdown => "shutdown",
            Self::Cancelled => "cancelled",
            Self::StreamEnded => "stream-ended",
            Self::Restarted => "restarted",
            Self::Unrecorded => "unrecorded",
            Self::NoAnswer => "no-answer",
        }
    }

    const fn because(self) -> &'static str {
        match self {
            Self::Disabled => "the MCP server was turned off while it ran",
            Self::ReadOnly => "this MCP connection became read-only while it ran",
            Self::Revoked => "this MCP connection's access was revoked while it ran",
            Self::Shutdown => "BiBCode shut down while it ran",
            Self::Cancelled => "the call was cancelled while it ran",
            Self::StreamEnded => "the operation stopped reporting before it finished",
            Self::Restarted => "BiBCode restarted while it ran",
            Self::Unrecorded => "BiBCode could not save its outcome",
            Self::NoAnswer => "the host stopped answering before it reported a result",
        }
    }
}

/// The typed failure of work whose outcome cannot be known.
pub(crate) fn unknown_failure(interruption: Interruption) -> Value {
    let mut failure = typed_tool_failure(
        OUTCOME_UNKNOWN_TAG,
        &format!(
            "BiBCode cannot tell whether this ran: {}. Check git_status (or view_pull_request), then retry with a new clientRequestId.",
            interruption.because()
        ),
    );
    failure["structuredContent"]["error"]["reason"] = interruption.reason().into();
    outcome_unknown(failure)
}

/// Marks `failure` as the failure of work that may have taken effect: [`ToolCall::recorded`]
/// stores it as `unknown`, never `failed`, and a keyed retry replays it unchanged.
pub(crate) fn outcome_unknown(mut failure: Value) -> Value {
    failure["structuredContent"]["error"]["outcome"] = "unknown".into();
    failure
}

fn is_outcome_unknown(failure: &Value) -> bool {
    failure["structuredContent"]["error"]["outcome"] == "unknown"
}

/// The `clientRequestId`s whose recorded call runs in this process. A second call with the
/// same key waits for the first to write its outcome.
#[derive(Default)]
pub(crate) struct Claims(Mutex<HashMap<(String, String), watch::Receiver<bool>>>);

/// Holds a claim; dropping it, after the outcome is written, releases waiting retries.
struct Claim {
    control: McpControl,
    key: (String, String),
    done: watch::Sender<bool>,
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.control
            .inner
            .claims
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
        let _ = self.done.send(true);
    }
}

enum Claimed {
    Ours(Claim),
    Running(watch::Receiver<bool>),
}

/// What owned work may do: the call's credential and RPC registry, under the live controls'
/// token.
#[derive(Clone)]
pub(crate) struct Owned {
    control: McpControl,
    registry: RpcRegistry,
    context: RpcSessionContext,
    cancellation: CancellationToken,
}

#[allow(
    dead_code,
    reason = "slices G and P call every method; F0 tests the stream path"
)]
impl Owned {
    /// The token the live controls fire; pass it on to anything the work starts.
    pub(crate) fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    /// The thread `thread_id` names and the folder it works in, resolved inside the work so a
    /// keyed retry reads its recorded outcome even after the thread is gone.
    pub(crate) async fn target(
        &self,
        thread_id: &str,
    ) -> Result<super::target::ThreadTarget, Value> {
        super::target::thread_target(&self.control, thread_id).await
    }

    /// Runs unary RPC method `tag` with the call's credential and checks (B1).
    pub(crate) async fn invoke(&self, tag: &str, payload: Value) -> Result<Value, Value> {
        self.registry
            .invoke_local(
                tag,
                payload,
                self.context.clone(),
                self.cancellation.clone(),
            )
            .await
            .map_err(|error| rpc_failure(&error))
    }

    /// Runs stream method `tag` to its terminal event (C3). An early end is a failure tagged
    /// `McpStreamEndedError`, which [`ToolCall::recorded`] records as `unknown`.
    pub(crate) async fn invoke_stream(
        &self,
        tag: &str,
        payload: Value,
    ) -> Result<StreamOutcome, Value> {
        self.registry
            .invoke_local_stream(
                tag,
                payload,
                self.context.clone(),
                self.cancellation.clone(),
                STREAM_BUDGET,
            )
            .await
            .map_err(|error| rpc_failure(&error))
    }
}

/// The live controls of one piece of owned work: a token that fires on the first of the off
/// switch, read-only, revocation, shutdown and (for unkeyed work) the call's cancellation, and
/// which of them fired.
struct LiveControls {
    token: CancellationToken,
    fired: Arc<OnceLock<Interruption>>,
    settled: CancellationToken,
    _connection: crate::auth::AuthenticatedConnectionGuard,
}

impl LiveControls {
    /// Registers the work as one of the session's live connections, so revoking the session
    /// cancels it (and Authorized clients shows the agent as connected meanwhile). A session
    /// already revoked or expired is refused before anything runs.
    async fn start(
        control: &McpControl,
        principal: &ClientPrincipal,
        call: Option<CancellationToken>,
    ) -> Result<Self, Value> {
        let revoked = CancellationToken::new();
        let connection = control
            .auth()
            .mark_connected_guard(&principal.principal.session_id, revoked.clone())
            .await
            .map_err(|_| {
                typed_tool_failure(
                    "EnvironmentAuthenticationError",
                    "This MCP connection's access ended. Restart the MCP server in your agent.",
                )
            })?;
        let token = CancellationToken::new();
        let fired = Arc::new(OnceLock::new());
        let settled = CancellationToken::new();
        let mut settings = control.settings_signal();
        let shutdown = control.shutdown_token();
        let ceiling = principal.ceiling;
        let call = call.unwrap_or_default();
        tokio::spawn({
            let (token, fired, settled) = (token.clone(), Arc::clone(&fired), settled.clone());
            async move {
                let mut settings_open = true;
                let interruption = loop {
                    let current = *settings.borrow_and_update();
                    if !current.enabled {
                        break Some(Interruption::Disabled);
                    }
                    if ceiling.min(current.access) == McpAccess::ReadOnly {
                        break Some(Interruption::ReadOnly);
                    }
                    tokio::select! {
                        biased;
                        () = settled.cancelled() => break None,
                        () = shutdown.cancelled() => break Some(Interruption::Shutdown),
                        () = revoked.cancelled() => break Some(Interruption::Revoked),
                        () = call.cancelled() => break Some(Interruption::Cancelled),
                        changed = settings.changed(), if settings_open => {
                            settings_open = changed.is_ok();
                        }
                    }
                };
                if let Some(interruption) = interruption {
                    let _ = fired.set(interruption);
                    token.cancel();
                }
            }
        });
        Ok(Self {
            token,
            fired,
            settled,
            _connection: connection,
        })
    }

    /// Runs `work` under the token. Work that returns before the token fires is its own
    /// outcome; work the token interrupted is `unknown`, and work that ignores the token is
    /// dropped after a grace period.
    async fn run<F>(self, work: F) -> (ToolResult, Option<Interruption>)
    where
        F: Future<Output = ToolResult>,
    {
        tokio::pin!(work);
        let result = tokio::select! {
            biased;
            result = &mut work => Some(result),
            () = async {
                self.token.cancelled().await;
                tokio::time::sleep(INTERRUPT_GRACE).await;
            } => None,
        };
        self.settled.cancel();
        let interruption = self.fired.get().copied();
        match (result, interruption) {
            // Work that returned its own unknown outcome in time (a partial one, say) knows
            // more than that it was interrupted, and keeps it. A bare unknown takes the
            // interruption's reason instead.
            (Some(Err(failure)), Some(interruption))
                if is_outcome_unknown(&failure)
                    && failure["structuredContent"]["error"]["_tag"] != OUTCOME_UNKNOWN_TAG =>
            {
                (Err(failure), Some(interruption))
            }
            (_, Some(interruption)) => (Err(unknown_failure(interruption)), Some(interruption)),
            (Some(Err(failure)), None) if is_stream_ended(&failure) => (
                Err(unknown_failure(Interruption::StreamEnded)),
                Some(Interruption::StreamEnded),
            ),
            (Some(result), None) => (result, None),
            (None, None) => (
                Err(unknown_failure(Interruption::Shutdown)),
                Some(Interruption::Shutdown),
            ),
        }
    }
}

impl Drop for LiveControls {
    /// Ends the watcher however the work ended, a dropped call included.
    fn drop(&mut self) {
        self.settled.cancel();
    }
}

/// What an MCP-minted transfer URL is used for (#139 X5).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TransferUse {
    Download,
    Upload,
}

/// The live controls of one transfer an outside agent's URL started (#139 X5): a token that
/// fires when the agent's access to it ends. It takes no owned-mutation slot.
pub(crate) struct TransferControls {
    token: CancellationToken,
    settled: CancellationToken,
}

impl TransferControls {
    /// Fires on shutdown, revocation (so Stop), the MCP server turned off or the Files set
    /// turned off, and for an upload a read-only ceiling (so Take over).
    pub(crate) fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for TransferControls {
    /// Ends the watcher, and with it the transfer's place among the live connections.
    fn drop(&mut self) {
        self.settled.cancel();
    }
}

impl McpControl {
    /// Starts the live controls of a transfer `session_id` minted, or `None` when that
    /// session's access to it has ended: revoked or expired, not an outside agent, the MCP
    /// server or the Files set off, or for an upload a read-only ceiling. The transfer counts
    /// as one of the session's live connections while it runs, so revocation cancels it.
    ///
    /// Take over and Hand back cancel a session's live work without revoking it; a download
    /// is then admitted again and goes on, while an upload under a read-only ceiling stops.
    pub(crate) async fn transfer_controls(
        &self,
        session_id: &str,
        transfer: TransferUse,
    ) -> Option<TransferControls> {
        let (mut connection, mut ended) = self.admit_transfer(session_id, transfer).await?;
        let token = CancellationToken::new();
        let settled = CancellationToken::new();
        let mut settings = self.settings_signal();
        let shutdown = self.shutdown_token();
        let control = self.clone();
        let session_id = session_id.to_owned();
        tokio::spawn({
            let (token, settled) = (token.clone(), settled.clone());
            async move {
                let mut settings_open = true;
                loop {
                    tokio::select! {
                        biased;
                        () = settled.cancelled() => return,
                        () = shutdown.cancelled() => break,
                        () = ended.cancelled() => {
                            drop(connection);
                            match control.admit_transfer(&session_id, transfer).await {
                                Some((again, token)) => (connection, ended) = (again, token),
                                None => break,
                            }
                        }
                        changed = settings.changed(), if settings_open => {
                            settings_open = changed.is_ok();
                            settings.borrow_and_update();
                            if !control.transfer_allowed(&session_id, transfer).await {
                                break;
                            }
                        }
                    }
                }
                token.cancel();
            }
        });
        Some(TransferControls { token, settled })
    }

    /// Registers the transfer as a live connection of `session_id` (refused once revoked or
    /// expired), then checks the rest of its access; the token fires on revocation.
    async fn admit_transfer(
        &self,
        session_id: &str,
        transfer: TransferUse,
    ) -> Option<(crate::auth::AuthenticatedConnectionGuard, CancellationToken)> {
        let ended = CancellationToken::new();
        let connection = self
            .auth()
            .mark_connected_guard(session_id, ended.clone())
            .await
            .ok()?;
        self.transfer_allowed(session_id, transfer)
            .await
            .then_some((connection, ended))
    }

    async fn transfer_allowed(&self, session_id: &str, transfer: TransferUse) -> bool {
        let settings = self.settings();
        if !settings.enabled || !settings.capabilities.files {
            return false;
        }
        let (_, _, sessions) = self.auth().access_snapshot("").await;
        let Some(session) = sessions
            .into_iter()
            .find(|session| session.session_id == session_id)
        else {
            return false;
        };
        if session.subject != crate::auth::MCP_CLIENT_SUBJECT {
            return false;
        }
        let ceiling = session
            .mcp_access
            .as_deref()
            .and_then(McpAccess::parse)
            .unwrap_or(McpAccess::ReadOnly)
            .min(settings.access);
        transfer == TransferUse::Download || ceiling != McpAccess::ReadOnly
    }
}

fn is_stream_ended(failure: &Value) -> bool {
    failure["structuredContent"]["error"]["_tag"] == STREAM_ENDED_TAG
}

/// A stored row's answer.
fn stored_answer(state: &str, outcome: Option<&str>) -> Result<ToolResult, Value> {
    let parse = || -> Result<Value, Value> {
        outcome
            .and_then(|outcome| serde_json::from_str(outcome).ok())
            .ok_or_else(|| storage_failure("a recorded MCP outcome is unreadable"))
    };
    match state {
        "done" => Ok(Ok(parse()?)),
        "failed" | "unknown" => Ok(Err(parse()?)),
        _ => Err(storage_failure("a recorded MCP outcome has no state")),
    }
}

type Row = (String, String, String, Option<String>);

impl ToolCall<'_> {
    /// Runs `work`, a mutation with no command receipt, under the live controls; with a
    /// `clientRequestId`, at most once as an owned mutation whose outcome a retry reads back.
    /// `payload` is the RPC payload the work sends, stored with the row. See the module docs.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) async fn recorded<F, Fut>(&self, tool: &str, payload: &Value, work: F) -> ToolResult
    where
        F: FnOnce(Owned) -> Fut + Send + 'static,
        Fut: Future<Output = ToolResult> + Send + 'static,
    {
        let Some(key) = self.request_key(tool)? else {
            let controls = LiveControls::start(
                self.control,
                self.principal,
                Some(self.cancellation.clone()),
            )
            .await?;
            let owned = self.owned(controls.token.clone());
            return controls.run(work(owned)).await.0;
        };
        let claim = match self.claim(&key) {
            Claimed::Ours(claim) => claim,
            Claimed::Running(mut done) => {
                let shutdown = self.control.shutdown_token();
                tokio::select! {
                    biased;
                    () = self.cancellation.cancelled() => return Err(cancelled()),
                    () = shutdown.cancelled() => {
                        return Err(unknown_failure(Interruption::Shutdown));
                    }
                    _ = done.wait_for(|done| *done) => {}
                }
                return match self.read_row(&key).await? {
                    Some(row) => self.answer(&key, row, None).await,
                    None => Err(storage_failure("a recorded MCP outcome is missing")),
                };
            }
        };
        if let Some(row) = self.read_row(&key).await? {
            return self.answer(&key, row, Some(claim)).await;
        }
        let slot = self.control.admit_owned(&key.session_id)?;
        // The work's own maintenance admission: a unary handler drops its request's permit
        // before its work ends, and the call's request may end first. Update preparation
        // therefore waits for this until the outcome is written.
        let admission = self
            .control
            .registry()
            .admission_gate()
            .admit_named(RpcMutability::Mutation, format!("MCP {tool}"))
            .map_err(|error| {
                typed_tool_failure("UpdateMaintenanceActiveError", &error.to_string())
            })?;
        let controls = LiveControls::start(self.control, self.principal, None).await?;
        let payload_json = serde_json::to_string(payload).map_err(storage_failure)?;
        if !self.insert_running(&key, payload_json).await? {
            // Another process stored this key first.
            return match self.read_row(&key).await? {
                Some(row) => self.answer(&key, row, Some(claim)).await,
                None => Err(storage_failure("a recorded MCP outcome is missing")),
            };
        }
        let owned = self.owned(controls.token.clone());
        let database = self.control.repositories().database().clone();
        let (sender, receiver) = oneshot::channel();
        let row_key = key.clone();
        tokio::spawn(async move {
            let (result, interruption) = controls.run(work(owned)).await;
            let state = match (&result, interruption) {
                (_, Some(_)) => "unknown",
                (Err(failure), None) if is_outcome_unknown(failure) => "unknown",
                (Ok(_), None) => "done",
                (Err(_), None) => "failed",
            };
            let outcome = match &result {
                Ok(value) | Err(value) => value.to_string(),
            };
            let result = match settle(&database, &row_key, state, outcome).await {
                Ok(true) => result,
                written => {
                    tracing::warn!(?written, "an MCP tool could not record its outcome");
                    // Never answer what was not recorded. Record `unknown` instead; if that
                    // fails too, the row stays `running`, which a retry answers as unknown.
                    let failure = unknown_failure(Interruption::Unrecorded);
                    if let Err(error) =
                        settle(&database, &row_key, "unknown", failure.to_string()).await
                    {
                        tracing::warn!(%error, "an MCP tool could not record its unknown outcome");
                    }
                    Err(failure)
                }
            };
            // Released only once the outcome is settled (or could not be).
            drop(admission);
            drop(slot);
            drop(claim);
            let _ = sender.send(result);
        });
        tokio::select! {
            biased;
            result = receiver => result.unwrap_or_else(|_| Err(unknown_failure(Interruption::Shutdown))),
            // The work goes on; a retry with the same id reads its outcome.
            () = self.cancellation.cancelled() => Err(cancelled()),
        }
    }

    fn owned(&self, cancellation: CancellationToken) -> Owned {
        Owned {
            control: self.control.clone(),
            registry: self.control.registry().clone(),
            context: self.context(),
            cancellation,
        }
    }

    fn claim(&self, key: &RequestKey) -> Claimed {
        let id = (key.session_id.clone(), key.client_request_id.clone());
        let mut claims = self
            .control
            .inner
            .claims
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(running) = claims.get(&id) {
            return Claimed::Running(running.clone());
        }
        let (done, running) = watch::channel(false);
        claims.insert(id.clone(), running);
        Claimed::Ours(Claim {
            control: self.control.clone(),
            key: id,
            done,
        })
    }

    async fn read_row(&self, key: &RequestKey) -> Result<Option<Row>, Value> {
        let (session_id, client_request_id) =
            (key.session_id.clone(), key.client_request_id.clone());
        self.control
            .repositories()
            .database()
            .call(move |connection| {
                Ok(connection
                    .query_row(
                        "SELECT tool, arguments_digest, state, outcome_json FROM mcp_tool_requests WHERE session_id = ? AND client_request_id = ?",
                        params![session_id, client_request_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?)
            })
            .await
            .map_err(storage_failure)
    }

    /// Inserts the `running` row; `false` when one already exists.
    async fn insert_running(&self, key: &RequestKey, payload: String) -> Result<bool, Value> {
        let key = key.clone();
        self.control
            .repositories()
            .database()
            .call(move |connection| {
                let transaction = connection.transaction()?;
                prune_request_rows(&transaction)?;
                let inserted = transaction.execute(
                    "INSERT OR IGNORE INTO mcp_tool_requests (session_id, client_request_id, tool, arguments_digest, commands_json, created_at, state) VALUES (?, ?, ?, ?, ?, ?, 'running')",
                    params![key.session_id, key.client_request_id, key.tool, key.digest, payload, now_iso()],
                )?;
                transaction.commit()?;
                Ok(inserted == 1)
            })
            .await
            .map_err(storage_failure)
    }

    /// The answer of an existing row. A `running` row while this call holds the claim has no
    /// owner, so it is `unknown` from now on.
    async fn answer(&self, key: &RequestKey, row: Row, claim: Option<Claim>) -> ToolResult {
        let (tool, digest, state, outcome) = row;
        if tool != key.tool || digest != key.digest || state == "commands" {
            return Err(idempotency_conflict());
        }
        if state != "running" {
            return stored_answer(&state, outcome.as_deref())?;
        }
        let failure = unknown_failure(Interruption::Restarted);
        if claim.is_some() {
            let database = self.control.repositories().database();
            if let Err(error) = settle(database, key, "unknown", failure.to_string()).await {
                // Still unknown: the row stays `running`, and the next retry tries again.
                tracing::warn!(%error, "an MCP tool could not record an unowned outcome");
            }
        }
        drop(claim);
        Err(failure)
    }
}

/// Writes the outcome of `key`'s `running` row; `false` when no such row was there.
async fn settle(
    database: &Database,
    key: &RequestKey,
    state: &'static str,
    outcome: String,
) -> crate::persistence::Result<bool> {
    let (session_id, client_request_id) = (key.session_id.clone(), key.client_request_id.clone());
    database
        .call(move |connection| {
            let updated = connection.execute(
                "UPDATE mcp_tool_requests SET state = ?, outcome_json = ? WHERE session_id = ? AND client_request_id = ? AND state = 'running'",
                params![state, outcome, session_id, client_request_id],
            )?;
            Ok(updated == 1)
        })
        .await
}

fn cancelled() -> Value {
    typed_tool_failure(
        "McpCancelledError",
        "The call was cancelled; any work it started goes on. Retry with the same clientRequestId to read its outcome.",
    )
}
