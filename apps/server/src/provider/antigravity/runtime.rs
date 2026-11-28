//! One Antigravity chat session over `agy acp` (ACP v1). See
//! `docs/plans/2026-11-20-antigravity-terminal-design.md`, decisions D-A4 to D-A11.
//!
//! Logs carry method names, error codes and classes only: provider text, option values and
//! `_meta` (which names the account's plan) never reach `tracing`.
//!
//! Known limit: the shared transport closes the connection on a stdout line over 128 KiB
//! (`AcpConnectionConfig::max_stdout_line_bytes`). `agy` repeats a written file's content in the
//! non-standard `args` of every `tool_call` and `tool_call_update`, so writing a large file can
//! end the session with a line-too-long error.

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{Mutex, Notify, mpsc, oneshot};
use uuid::Uuid;

use super::acp::{
    AcpJsonRpcConnection, AcpProtocolError, IncomingEvent, JsonRpcErrorShape, acp_error_class,
    acp_error_reason, acp_turn_state,
};
use crate::provider::{
    ANTIGRAVITY_MIN_STEER_VERSION, OptionRefusal, RefusedOption, model_unavailable_refusal,
    option_needs_value_refusal, option_without_id_refusal, parse_semver_triple,
    unsupported_option_refusal,
};

const PROVIDER: &str = "antigravity";
const PROTOCOL_VERSION: u64 = 1;
const MINIMUM_VERSION: (u64, u64, u64) = (1, 5, 4);
/// The BiBCode option id of the thinking level, the id the ACP option parser publishes for the
/// `thought_level` category (`provider/cursor/model.rs`).
const REASONING_OPTION_ID: &str = "reasoning";
const THINKING_LEVEL_LABEL: &str = "Thinking level";

/// How long a cancelled turn may run before the runtime gives up on the process (D-A10).
pub const DEFAULT_CANCEL_GRACE: Duration = Duration::from_secs(10);

/// How long the handshake and session open may take before the chat shows that Antigravity is
/// slow to start. A live open answered in a few seconds. The start keeps waiting.
pub const START_NOTICE_DELAY: Duration = Duration::from_secs(60);

/// How long a configuration write on a running session may take. The CLI answers them at once
/// (measured); the bound keeps a wedged CLI from holding the shared provider supervisor.
pub const DEFAULT_CONTROL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
pub struct AntigravitySessionOptions {
    pub thread_id: String,
    pub cwd: String,
    pub runtime_mode: String,
    pub interaction_mode: String,
    pub model: Option<String>,
    pub resume_session_id: Option<String>,
    pub cancel_grace: Duration,
    /// Bounds each configuration request (model, thinking level, mode).
    pub control_timeout: Duration,
    /// The thread's options (the thinking level), written during the start.
    pub initial_options: Vec<Value>,
    pub code_review: bool,
}

#[derive(Clone, Debug)]
pub struct AntigravityRuntimeEvent {
    pub event_type: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub request_id: Option<String>,
    pub payload: Value,
}

#[derive(Clone, Debug, Error)]
pub enum AntigravityRuntimeError {
    #[error(transparent)]
    Protocol(#[from] AcpProtocolError),
    /// The CLI answered `-32000` "Authentication required". The user signs in; BiBCode never does.
    #[error(
        "Antigravity is not signed in. Open an Antigravity Terminal and run `agy`, or run `agy acp --login`, then send the message again."
    )]
    SignInRequired,
    /// Google disabled Antigravity for the signed-in account. Sending again cannot help, so the
    /// message fails once. Google's own notice follows the sentence, in the turn's error and the
    /// delivery's details alike.
    #[error(
        "Google has disabled Antigravity for this account. Appeal through Google to restore access. Google's message: {google_message}"
    )]
    AccountDisabled { google_message: String },
    /// The CLI is older than 1.5.4, speaks another ACP version, or has no working `agy acp`.
    #[error("{}", unsupported_version_message(.version.as_deref()))]
    UnsupportedVersion { version: Option<String> },
    /// The session did not acknowledge the mode the thread's permission setting needs.
    #[error(
        "Antigravity did not switch to its `{mode}` mode, so BiBCode stopped the chat to keep your permission setting. Run `agy update`, then try again."
    )]
    ModeUnavailable { mode: String },
    /// A configuration request went unanswered; the CLI's mode is unknown until rewritten.
    #[error(
        "Antigravity did not answer a settings change in time. Send the message again; if it keeps happening, stop the chat and start it again."
    )]
    ControlTimedOut,
    /// A resume or load answer named another conversation than the one asked for.
    #[error(
        "Antigravity reopened a different conversation than this chat's, so BiBCode stopped. Send the message again."
    )]
    SessionMismatch,
    #[error("Antigravity runtime has not started a provider session")]
    MissingProviderSessionId,
    #[error("Unknown pending request id {request_id}")]
    PendingRequestNotFound { request_id: String },
    #[error("Antigravity option update is unsupported: {0}")]
    UnsupportedOption(RefusedOption),
    #[error("Antigravity config update acknowledgement omitted configOptions")]
    MalformedConfigAcknowledgement,
    /// Steering could not be applied to the running turn (for example, CLI version `< 1.5.0`,
    /// pending approval/question, or no turn update yet); the message returns to the queue.
    #[error("{detail}")]
    SteerUnavailable { detail: String },
    /// Antigravity reported an account or model quota/usage limit during the turn (#429).
    #[error("{message}")]
    UsageLimitReached {
        message: String,
        resets_at: Option<String>,
    },
}

impl AntigravityRuntimeError {
    /// The class a log line may carry instead of the error's text.
    #[must_use]
    pub fn class(&self) -> &'static str {
        match self {
            Self::Protocol(error) => acp_error_class(error),
            Self::SignInRequired => "sign_in_required",
            Self::AccountDisabled { .. } => "account_disabled",
            Self::UnsupportedVersion { .. } => "unsupported_version",
            Self::ModeUnavailable { .. } => "mode_unavailable",
            Self::ControlTimedOut => "control_timeout",
            Self::SessionMismatch => "session_mismatch",
            Self::UnsupportedOption(_) => "unsupported_option",
            Self::MissingProviderSessionId
            | Self::PendingRequestNotFound { .. }
            | Self::MalformedConfigAcknowledgement => "runtime_error",
            Self::SteerUnavailable { .. } => "steer_unavailable",
            Self::UsageLimitReached { .. } => "provider_error",
        }
    }

    /// The sanitized failure reason a log line or turn completion event may carry without raw text.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Protocol(error) => acp_error_reason(error),
            Self::SignInRequired => "sign_in_required",
            Self::AccountDisabled { .. } => "account_disabled",
            Self::UnsupportedVersion { .. } => "unsupported_version",
            Self::ModeUnavailable { .. } => "mode_unavailable",
            Self::ControlTimedOut => "control_timeout",
            Self::SessionMismatch => "session_mismatch",
            Self::UnsupportedOption(_) => "unsupported_option",
            Self::MissingProviderSessionId => "missing_provider_session_id",
            Self::PendingRequestNotFound { .. } => "pending_request_not_found",
            Self::MalformedConfigAcknowledgement => "malformed_config_acknowledgement",
            Self::SteerUnavailable { .. } => "steer_unavailable",
            Self::UsageLimitReached { .. } => "usage_limit",
        }
    }

    /// The sanitized message written into `turn.completed` `errorMessage`: transport errors use
    /// fixed static descriptions so raw uncorrelated response IDs, paths, or tokens never leak.
    #[must_use]
    pub fn turn_error_message(&self) -> String {
        match self {
            Self::Protocol(error) if !matches!(error, AcpProtocolError::RemoteRequest { .. }) => {
                antigravity_transport_message(acp_error_reason(error))
            }
            _ => self.to_string(),
        }
    }
}

/// Fixed user-readable description for a sanitized ACP transport failure reason (no em dashes, no
/// raw stderr, paths, tokens, or uncorrelated response IDs).
pub(crate) fn antigravity_transport_message(reason: &str) -> String {
    match reason {
        "line_too_long" => {
            "Antigravity sent a message longer than BiBCode accepts (transport_error: line_too_long)"
                .to_owned()
        }
        "connection_closed" => {
            "Antigravity connection closed unexpectedly (transport_error: connection_closed)"
                .to_owned()
        }
        "read_failure" => {
            "Antigravity output read failed (transport_error: read_failure)".to_owned()
        }
        "write_failure" => {
            "Antigravity input write failed (transport_error: write_failure)".to_owned()
        }
        "invalid_message" => {
            "Antigravity sent an invalid protocol message (transport_error: invalid_message)"
                .to_owned()
        }
        "unknown_response" => {
            "Antigravity sent an uncorrelated protocol response (transport_error: unknown_response)"
                .to_owned()
        }
        _ => format!("Antigravity connection failed (transport_error: {reason})"),
    }
}

impl OptionRefusal for AntigravityRuntimeError {
    fn refused_option(&self) -> Option<&RefusedOption> {
        match self {
            Self::UnsupportedOption(refused) => Some(refused),
            _ => None,
        }
    }
}

fn unsupported_version_message(version: Option<&str>) -> String {
    match version {
        Some(version) => format!(
            "Antigravity chat needs CLI 1.5.4 or later; this one is {version}. Run `agy update`, then try again. The Antigravity Terminal still works."
        ),
        None => "Antigravity chat needs CLI 1.5.4 or later with a working `agy acp` that speaks ACP protocol 1. Run `agy update`, then try again. The Antigravity Terminal still works.".to_owned(),
    }
}

#[derive(Debug)]
pub struct AntigravityPromptReceipt {
    pub turn_id: String,
    accepted: oneshot::Receiver<Result<(), AntigravityRuntimeError>>,
    completion: oneshot::Receiver<Result<(), AntigravityRuntimeError>>,
}

impl AntigravityPromptReceipt {
    /// Resolves as soon as the CLI proves it accepted the prompt (first turn update, permission
    /// request, superseded-prompt completion, or the prompt's own completion), or fails if the
    /// prompt errors before any such signal arrives.
    pub async fn accepted(self) -> Result<(), AntigravityRuntimeError> {
        self.accepted.await.unwrap_or_else(|_| {
            Err(AcpProtocolError::Closed {
                reason: "Antigravity prompt acceptance task ended without an outcome".to_owned(),
            }
            .into())
        })
    }

    /// Resolves when the CLI answers the prompt, that is when the prompt finishes.
    pub async fn completion(self) -> Result<(), AntigravityRuntimeError> {
        self.completion.await.unwrap_or_else(|_| {
            Err(AcpProtocolError::Closed {
                reason: "Antigravity prompt receipt task ended without an outcome".to_owned(),
            }
            .into())
        })
    }
}

#[derive(Clone)]
pub struct AntigravitySessionRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    options: AntigravitySessionOptions,
    connection: AcpJsonRpcConnection,
    /// Everything a permission decision reads. A decision and its reply are made under this
    /// lock, and cancel and mode changes take it too, so none can slip between them. It is never
    /// held across a request to the CLI or a barrier.
    gate: Mutex<Gate>,
    /// Held by each mode confirmation from reading its target to settling its answer, so mode
    /// writes reach the CLI one at a time and each writes the latest target.
    mode_writes: Mutex<()>,
    config_options: Mutex<Vec<Value>>,
    legacy_models: AtomicBool,
    /// The start failed because the connection to the child broke, not on a refusal.
    start_lost_connection: AtomicBool,
    /// True once the runtime was closed or abandoned and cannot serve further turns.
    retired: AtomicBool,
    /// Google's message, when the CLI wrote on its error output that the account is disabled.
    account_disabled: std::sync::Mutex<Option<String>>,
    abandoned_turns: Mutex<HashSet<String>>,
    events_tx: mpsc::UnboundedSender<AntigravityRuntimeEvent>,
    events_rx: Mutex<mpsc::UnboundedReceiver<AntigravityRuntimeEvent>>,
    abandon: Notify,
    clock: std::sync::Mutex<Arc<dyn Fn() -> time::OffsetDateTime + Send + Sync>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct QuotaLimitNotice {
    message: String,
    resets_at: Option<String>,
}

impl QuotaLimitNotice {
    fn merge(first: Option<Self>, second: Option<Self>) -> Option<Self> {
        match (first, second) {
            (Some(a), Some(b)) => {
                if a.resets_at.is_some() {
                    Some(a)
                } else if b.resets_at.is_some() {
                    Some(b)
                } else {
                    Some(a)
                }
            }
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        }
    }
}

struct PreviousPrompt {
    seq: u64,
    wire_id: Option<String>,
    had_update: bool,
    /// True once stdout delivered the JSON-RPC response for `wire_id`, observed in exact wire
    /// order before any subsequent `session/update` notifications.
    wire_ended: bool,
    settled: Option<Result<Value, AntigravityRuntimeError>>,
    quota_notice: Option<QuotaLimitNotice>,
    quota_published: Option<QuotaLimitNotice>,
}

impl PreviousPrompt {
    fn unpublished_quota_notice(&self) -> Option<QuotaLimitNotice> {
        let settled_notice = match &self.settled {
            Some(Err(AntigravityRuntimeError::UsageLimitReached { message, resets_at })) => {
                Some(QuotaLimitNotice {
                    message: message.clone(),
                    resets_at: resets_at.clone(),
                })
            }
            _ => None,
        };
        QuotaLimitNotice::merge(self.quota_notice.clone(), settled_notice)
            .filter(|notice| self.quota_published.as_ref() != Some(notice))
    }
}

struct Gate {
    /// `None` until the open call and every update queued before its answer are handled, so a
    /// replayed history is dropped and no request during the open is answered.
    session_id: Option<String>,
    agent_version: Option<(u64, u64, u64)>,
    active_turn: Option<String>,
    active_prompt_seq: u64,
    active_prompt_wire_id: Option<String>,
    next_prompt_seq: u64,
    /// True once the currently running prompt has produced at least one turn update.
    active_turn_has_update: bool,
    /// Classified quota notice intercepted from an `agent_message_chunk` on `active_prompt_seq` (#429).
    active_prompt_quota_notice: Option<QuotaLimitNotice>,
    /// Last quota notice already published via `runtime.warning` for `active_prompt_seq` (#429).
    active_prompt_quota_published: Option<QuotaLimitNotice>,
    /// Non-none while a concurrent steer prompt is being written to the CLI.
    steer_in_flight: Option<u64>,
    /// Superseded prompt retained until the steered prompt's disposition is known, so a rejected
    /// steer never drops Prompt 1's completion or fails a still-running Prompt 1.
    previous_prompt: Option<PreviousPrompt>,
    /// Acceptance channel for the current active prompt (`active_prompt_seq`).
    pending_accept: Option<(u64, oneshot::Sender<Result<(), AntigravityRuntimeError>>)>,
    cancelled_turn: Option<String>,
    runtime_mode: String,
    interaction_mode: String,
    code_review: bool,
    /// The CLI's mode may differ from the one the thread needs: the next prompt writes it first.
    /// True until the first acknowledgement, so a failed start leaves no confirmed mode.
    mode_unconfirmed: bool,
    /// Bumped by every mode change: a mode write's answer counts only for the generation that
    /// sent it, so an older answer never confirms a newer setting.
    mode_generation: u64,
    pending: HashMap<String, PendingRequest>,
}

struct ClearedActiveTurn {
    pending: Vec<(String, PendingRequest)>,
    quota_notice: Option<QuotaLimitNotice>,
    quota_published: Option<QuotaLimitNotice>,
    prev_unpublished_notice: Option<QuotaLimitNotice>,
}

impl Gate {
    fn allocate_prompt_seq(&mut self) -> u64 {
        self.next_prompt_seq = self.next_prompt_seq.saturating_add(1);
        self.next_prompt_seq
    }

    fn clear_active_turn(&mut self, turn_id: &str) -> ClearedActiveTurn {
        let (quota_notice, quota_published, prev_unpublished_notice) =
            if self.active_turn.as_deref() == Some(turn_id) {
                self.active_turn = None;
                self.active_prompt_seq = 0;
                self.active_prompt_wire_id = None;
                self.active_turn_has_update = false;
                self.steer_in_flight = None;
                let prev_unpublished_notice = self
                    .previous_prompt
                    .take()
                    .and_then(|prev| prev.unpublished_quota_notice());
                (
                    self.active_prompt_quota_notice.take(),
                    self.active_prompt_quota_published.take(),
                    prev_unpublished_notice,
                )
            } else {
                (None, None, None)
            };
        ClearedActiveTurn {
            pending: self.take_pending(turn_id),
            quota_notice,
            quota_published,
            prev_unpublished_notice,
        }
    }

    fn resolve_pending_accept(&mut self, outcome: Result<(), AntigravityRuntimeError>) {
        if let Some((_, tx)) = self.pending_accept.take() {
            let _ = tx.send(outcome);
        }
    }

    fn resolve_pending_accept_for(
        &mut self,
        seq: u64,
        outcome: Result<(), AntigravityRuntimeError>,
    ) {
        if self
            .pending_accept
            .as_ref()
            .is_some_and(|(pending_seq, _)| *pending_seq == seq)
            && let Some((_, tx)) = self.pending_accept.take()
        {
            let _ = tx.send(outcome);
        }
    }
    fn mode_target(&self) -> &'static str {
        mode_for(&self.runtime_mode, &self.interaction_mode)
    }

    /// Also a new generation: a confirmation in flight can no longer clear it.
    fn unconfirm(&mut self) {
        self.mode_unconfirmed = true;
        self.mode_generation += 1;
    }

    /// The approvals of a turn that ended or was cancelled; they can never answer a later one.
    fn take_pending(&mut self, turn_id: &str) -> Vec<(String, PendingRequest)> {
        let ids = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.turn_id == turn_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| self.pending.remove(&id).map(|pending| (id, pending)))
            .collect()
    }
}

struct PendingRequest {
    /// The id exactly as the CLI sent it: numeric 1 and string "1" are different requests.
    wire_id: Value,
    turn_id: String,
    request_type: &'static str,
    allow_once: Option<String>,
    allow_always: Option<String>,
    reject_once: Option<String>,
}

impl AntigravitySessionRuntime {
    pub fn new(
        options: AntigravitySessionOptions,
        connection: AcpJsonRpcConnection,
        mut incoming: mpsc::UnboundedReceiver<IncomingEvent>,
    ) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let gate = Gate {
            session_id: None,
            agent_version: None,
            active_turn: None,
            active_prompt_seq: 0,
            active_prompt_wire_id: None,
            next_prompt_seq: 0,
            active_turn_has_update: false,
            active_prompt_quota_notice: None,
            active_prompt_quota_published: None,
            steer_in_flight: None,
            previous_prompt: None,
            pending_accept: None,
            cancelled_turn: None,
            runtime_mode: options.runtime_mode.clone(),
            interaction_mode: options.interaction_mode.clone(),
            code_review: options.code_review,
            mode_unconfirmed: true,
            mode_generation: 0,
            pending: HashMap::new(),
        };
        let runtime = Self {
            inner: Arc::new(RuntimeInner {
                options,
                connection,
                gate: Mutex::new(gate),
                mode_writes: Mutex::new(()),
                config_options: Mutex::new(Vec::new()),
                legacy_models: AtomicBool::new(false),
                start_lost_connection: AtomicBool::new(false),
                retired: AtomicBool::new(false),
                account_disabled: std::sync::Mutex::new(None),
                abandoned_turns: Mutex::new(HashSet::new()),
                events_tx,
                events_rx: Mutex::new(events_rx),
                abandon: Notify::new(),
                clock: std::sync::Mutex::new(Arc::new(time::OffsetDateTime::now_utc)),
            }),
        };
        let reader = runtime.clone();
        tokio::spawn(async move {
            while let Some(event) = incoming.recv().await {
                let closed = matches!(event, IncomingEvent::Closed { .. });
                reader.handle_incoming(event).await;
                // Nothing follows a close, and the transport may keep the channel open.
                if closed {
                    break;
                }
            }
        });
        runtime
    }

    /// Initializes, checks the CLI, opens the session (resume, else load, else new), then
    /// writes the model, the thinking level and the mode. Returns the ACP session id.
    pub async fn start(&self) -> Result<String, AntigravityRuntimeError> {
        let mut result = self.start_session().await;
        if let Err(error) = &result {
            if matches!(
                error,
                AntigravityRuntimeError::Protocol(
                    AcpProtocolError::Closed { .. }
                        | AcpProtocolError::ReadFailure { .. }
                        | AcpProtocolError::WriteFailure { .. }
                )
            ) {
                self.inner
                    .start_lost_connection
                    .store(true, Ordering::SeqCst);
            }
            // A CLI that exits on a disabled account says so only on its error output, however
            // its start then failed.
            let disabled = self
                .inner
                .account_disabled
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if let Some(google_message) = disabled {
                result = Err(AntigravityRuntimeError::AccountDisabled { google_message });
            }
            // A start that failed mid-way: no session id may survive it.
            let mut gate = self.inner.gate.lock().await;
            gate.session_id = None;
            gate.unconfirm();
        }
        result
    }

    /// Closes the connection: the writer task ends and the CLI's stdin closes. The readers, and
    /// this runtime's reader task, end when the CLI's output closes.
    pub fn close(&self) {
        self.inner.retired.store(true, Ordering::SeqCst);
        self.inner.connection.shutdown();
    }

    /// Whether this runtime was closed or abandoned and cannot serve further turns.
    #[must_use]
    pub fn is_retired(&self) -> bool {
        self.inner.retired.load(Ordering::SeqCst)
    }

    /// Whether the underlying ACP transport has closed (so stream-end settlement is imminent or
    /// running and no new prompts may start on this connection).
    #[must_use]
    pub fn is_transport_closed(&self) -> bool {
        self.inner.connection.is_closed()
    }

    /// Whether a failed start lost its connection, so the child is exiting or gone.
    pub fn start_lost_connection(&self) -> bool {
        self.inner.start_lost_connection.load(Ordering::SeqCst)
    }

    async fn start_session(&self) -> Result<String, AntigravityRuntimeError> {
        let initialized = match self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                    // This server, at its own version.
                    "clientInfo": { "name": "bibcode-rust", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await
        {
            Ok(initialized) => initialized,
            // No working `agy acp`: the command is unknown, or the child exited before answering.
            Err(AntigravityRuntimeError::Protocol(
                AcpProtocolError::RemoteRequest { code: -32601, .. },
            )) => return Err(AntigravityRuntimeError::UnsupportedVersion { version: None }),
            Err(AntigravityRuntimeError::Protocol(
                AcpProtocolError::Closed { .. }
                | AcpProtocolError::WriteFailure { .. }
                | AcpProtocolError::ReadFailure { .. },
            )) => {
                self.inner
                    .start_lost_connection
                    .store(true, Ordering::SeqCst);
                return Err(AntigravityRuntimeError::UnsupportedVersion { version: None });
            }
            Err(error) => return Err(error),
        };
        if initialized.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
            return Err(AntigravityRuntimeError::UnsupportedVersion { version: None });
        }
        // A version that cannot be established is refused like an old one. Only the parsed
        // numbers reach the message, never the CLI's text.
        let Some(version) = initialized
            .pointer("/agentInfo/version")
            .and_then(Value::as_str)
            .and_then(parse_version)
        else {
            return Err(AntigravityRuntimeError::UnsupportedVersion { version: None });
        };
        if version < MINIMUM_VERSION {
            let (major, minor, patch) = version;
            return Err(AntigravityRuntimeError::UnsupportedVersion {
                version: Some(format!("{major}.{minor}.{patch}")),
            });
        }
        self.inner.gate.lock().await.agent_version = Some(version);
        let capabilities = initialized.get("agentCapabilities");
        let session_capabilities = capabilities.and_then(|capabilities| {
            capabilities
                .get("sessionCapabilities")
                .or_else(|| capabilities.get("session_capabilities"))
        });
        // Advertised as an object (`"resume": {}`), so presence is the signal.
        let can_resume = session_capabilities
            .and_then(|capabilities| capabilities.get("resume"))
            .is_some_and(|resume| !resume.is_null() && resume != &Value::Bool(false));
        let can_load = capabilities
            .and_then(|capabilities| {
                capabilities
                    .get("loadSession")
                    .or_else(|| capabilities.get("load_session"))
            })
            .and_then(Value::as_bool)
            == Some(true);
        let session_id = self.open(can_resume, can_load).await?;
        // A resumed session is back at the CLI's defaults (measured), so every open writes the
        // model, the thinking level and, last, the mode again, all inside the start deadline.
        self.apply_model(self.inner.options.model.as_deref())
            .await?;
        match self
            .set_options(self.inner.options.initial_options.clone())
            .await
        {
            // A refused level writes nothing; the supervisor's `set_options` reports it.
            Ok(()) | Err(AntigravityRuntimeError::UnsupportedOption(_)) => {}
            Err(error) => return Err(error),
        }
        self.confirm_mode().await?;
        self.emit("session.started", None, None, json!({}));
        self.emit("thread.started", None, None, json!({}));
        Ok(session_id)
    }

    async fn open(
        &self,
        can_resume: bool,
        can_load: bool,
    ) -> Result<String, AntigravityRuntimeError> {
        let cwd = &self.inner.options.cwd;
        let new_session = json!({ "cwd": cwd, "mcpServers": [] });
        let saved = self.inner.options.resume_session_id.clone();
        let (requested, response) = match saved {
            Some(saved) if can_resume => match self
                .request(
                    "session/resume",
                    json!({ "sessionId": saved, "cwd": cwd, "mcpServers": [] }),
                )
                .await
            {
                Ok(response) => (Some(saved), response),
                // Load of an unknown id succeeds (measured), so only resume can tell the
                // conversation is gone. Any other failure may be transient and keeps the id.
                Err(error) if is_missing_session(&error) => {
                    (None, self.request("session/new", new_session).await?)
                }
                Err(error) => return Err(error),
            },
            Some(saved) if can_load => {
                let response = self
                    .request(
                        "session/load",
                        json!({ "sessionId": saved, "cwd": cwd, "mcpServers": [] }),
                    )
                    .await?;
                (Some(saved), response)
            }
            _ => (None, self.request("session/new", new_session).await?),
        };
        let answered = response.get("sessionId").and_then(Value::as_str);
        let session_id = match (requested, answered) {
            // A reopen must come back as the conversation asked for; only `session/new`
            // creates a replacement.
            (Some(requested), Some(answered)) if answered != requested => {
                return Err(AntigravityRuntimeError::SessionMismatch);
            }
            (Some(requested), _) => requested,
            (None, answered) => answered
                .map(str::to_owned)
                .ok_or(AntigravityRuntimeError::MissingProviderSessionId)?,
        };
        // The answer resolves on the reader task while replayed updates may still wait in the
        // incoming queue; drain them while no session is accepted.
        let _ = self.inner.connection.barrier().await;
        *self.inner.config_options.lock().await = response
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.inner.legacy_models.store(
            response.pointer("/models/availableModels").is_some(),
            Ordering::SeqCst,
        );
        self.inner.gate.lock().await.session_id = Some(session_id.clone());
        Ok(session_id)
    }

    pub async fn set_model(&self, model: &str) -> Result<(), AntigravityRuntimeError> {
        self.apply_model(Some(model)).await
    }

    async fn apply_model(&self, model: Option<&str>) -> Result<(), AntigravityRuntimeError> {
        let Some(model) = model.map(str::trim).filter(|model| {
            !model.is_empty()
                && !model.eq_ignore_ascii_case("auto")
                && !model.eq_ignore_ascii_case("default")
        }) else {
            return Ok(());
        };
        let session_id = self.provider_session_id().await?;
        let options = self.inner.config_options.lock().await.clone();
        if let Some(descriptor) = option_by_category(&options, "model") {
            if !advertises(descriptor, model) {
                return Err(AntigravityRuntimeError::UnsupportedOption(
                    RefusedOption::new(
                        "Antigravity session does not advertise the requested model",
                        model_unavailable_refusal(model, "Antigravity"),
                    ),
                ));
            }
            self.write_config(&session_id, option_id(descriptor), json!(model))
                .await?;
        } else if self.inner.legacy_models.load(Ordering::SeqCst) {
            // Only the combined model-and-effort ids exist: they go out unchanged. The answer is
            // `{}`, so it cannot show the mode; the next prompt writes it again.
            let result = self
                .control(
                    "session/set_model",
                    json!({ "sessionId": session_id, "modelId": model }),
                )
                .await;
            self.inner.gate.lock().await.unconfirm();
            result?;
        }
        Ok(())
    }

    /// A configuration request on a running session, bounded so a silent CLI cannot hold it.
    async fn control(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, AntigravityRuntimeError> {
        tokio::time::timeout(
            self.inner.options.control_timeout,
            self.request(method, params),
        )
        .await
        .unwrap_or_else(|_| {
            tracing::warn!(
                provider = PROVIDER,
                method,
                "the provider did not answer a settings change in time"
            );
            Err(AntigravityRuntimeError::ControlTimedOut)
        })
    }

    /// Writes the turn's options. Only the thinking level (`reasoning`) exists, written to the
    /// advertised `thought_level` option. Its levels depend on the model, so the level is checked
    /// against the options the last model write returned.
    pub async fn set_options(&self, options: Vec<Value>) -> Result<(), AntigravityRuntimeError> {
        for option in options {
            let id = option.get("id").and_then(Value::as_str).ok_or_else(|| {
                AntigravityRuntimeError::UnsupportedOption(RefusedOption::new(
                    "Antigravity option is missing an id",
                    option_without_id_refusal(),
                ))
            })?;
            if id != REASONING_OPTION_ID {
                return Err(AntigravityRuntimeError::UnsupportedOption(
                    RefusedOption::new(
                        format!("Antigravity does not support option {id}"),
                        unsupported_option_refusal(id),
                    ),
                ));
            }
            let current = self.inner.config_options.lock().await.clone();
            let Some(descriptor) = option_by_category(&current, "thought_level") else {
                return Err(AntigravityRuntimeError::UnsupportedOption(
                    RefusedOption::new(
                        "Antigravity session did not advertise a thinking level",
                        unsupported_option_refusal(THINKING_LEVEL_LABEL),
                    ),
                ));
            };
            let label = descriptor
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(THINKING_LEVEL_LABEL);
            let Some(value) = option.get("value").and_then(Value::as_str) else {
                return Err(AntigravityRuntimeError::UnsupportedOption(
                    RefusedOption::new(
                        "Antigravity thinking level must be a string",
                        option_needs_value_refusal(label),
                    ),
                ));
            };
            if !advertises(descriptor, value) {
                return Err(AntigravityRuntimeError::UnsupportedOption(
                    RefusedOption::new(
                        "Antigravity session does not advertise the requested thinking level",
                        unsupported_option_refusal(&format!("{label} {value}")),
                    ),
                ));
            }
            // The level the start wrote is already current: the supervisor's write after the
            // start sends nothing.
            if descriptor.get("currentValue").and_then(Value::as_str) == Some(value) {
                continue;
            }
            let session_id = self.provider_session_id().await?;
            self.write_config(&session_id, option_id(descriptor), json!(value))
                .await?;
        }
        Ok(())
    }

    /// Writes one config option. Every answer lists the session's effective mode; one that is not
    /// the mode the thread needs leaves the mode unconfirmed, and so does an unanswered write.
    async fn write_config(
        &self,
        session_id: &str,
        config_id: &str,
        value: Value,
    ) -> Result<Vec<Value>, AntigravityRuntimeError> {
        let response = self
            .control(
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": value }),
            )
            .await;
        let options = response.and_then(|response| {
            response
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned()
                .ok_or(AntigravityRuntimeError::MalformedConfigAcknowledgement)
        });
        let mut gate = self.inner.gate.lock().await;
        let Ok(options) = options else {
            gate.unconfirm();
            return options;
        };
        if current_mode(&options) != Some(gate.mode_target()) {
            gate.unconfirm();
        }
        drop(gate);
        *self.inner.config_options.lock().await = options.clone();
        Ok(options)
    }

    /// Switches the runtime mode. Auto-answering stops before the write and comes back only when
    /// the CLI acknowledges `auto`. A failed switch to full access keeps the previous mode.
    pub async fn set_runtime_mode(&self, mode: &str) -> Result<(), AntigravityRuntimeError> {
        self.change_modes(Some(mode), None).await
    }

    pub async fn set_interaction_mode(&self, mode: &str) -> Result<(), AntigravityRuntimeError> {
        self.change_modes(None, Some(mode)).await
    }

    /// Records the thread's new mode as the one the CLI must run in, then writes it. There is no
    /// rollback: a failed write leaves the new mode unconfirmed, so the next prompt writes it
    /// first and is refused until the CLI acknowledges it.
    async fn change_modes(
        &self,
        runtime_mode: Option<&str>,
        interaction_mode: Option<&str>,
    ) -> Result<(), AntigravityRuntimeError> {
        {
            let mut gate = self.inner.gate.lock().await;
            if let Some(mode) = runtime_mode {
                gate.runtime_mode = mode.to_owned();
            }
            if let Some(mode) = interaction_mode {
                gate.interaction_mode = mode.to_owned();
            }
            gate.unconfirm();
        }
        self.confirm_mode().await
    }

    /// Writes the mode the thread needs and confirms it from the answer, but only if no mode
    /// change happened meanwhile; otherwise the mode stays unconfirmed for the newer write.
    async fn confirm_mode(&self) -> Result<(), AntigravityRuntimeError> {
        let _serial = self.inner.mode_writes.lock().await;
        let (target, generation) = {
            let gate = self.inner.gate.lock().await;
            // A confirmation that held the lock before this one already confirmed the latest
            // setting.
            if !gate.mode_unconfirmed {
                return Ok(());
            }
            (gate.mode_target(), gate.mode_generation)
        };
        let result = self.apply_mode(target).await;
        let mut gate = self.inner.gate.lock().await;
        match result {
            Ok(()) if gate.mode_generation == generation => {
                gate.mode_unconfirmed = false;
                Ok(())
            }
            Ok(()) => Ok(()),
            Err(error) => {
                if gate.mode_generation == generation {
                    gate.unconfirm();
                }
                Err(error)
            }
        }
    }

    /// Writes the advertised `mode` option and requires the answer to show it. No fallback to
    /// another mode or to `session/set_mode`: a missing or refused mode refuses (D-A5).
    async fn apply_mode(&self, target: &'static str) -> Result<(), AntigravityRuntimeError> {
        let unavailable = || AntigravityRuntimeError::ModeUnavailable {
            mode: target.to_owned(),
        };
        let session_id = self.provider_session_id().await?;
        let options = self.inner.config_options.lock().await.clone();
        let descriptor = option_by_category(&options, "mode")
            .filter(|descriptor| advertises(descriptor, target))
            .ok_or_else(unavailable)?;
        // The answer, not a later `current_mode_update`, acknowledges the mode: the CLI sends its
        // notifications late, inside the next prompt (measured).
        let acknowledged = match self
            .write_config(&session_id, option_id(descriptor), json!(target))
            .await
        {
            Ok(options) => options,
            // Answered, but without the options that would confirm the mode: refused like a
            // mode the answer does not show. Only an unanswered write stays retryable.
            Err(
                AntigravityRuntimeError::Protocol(AcpProtocolError::RemoteRequest { .. })
                | AntigravityRuntimeError::MalformedConfigAcknowledgement,
            ) => {
                return Err(unavailable());
            }
            Err(error) => return Err(error),
        };
        if current_mode(&acknowledged) != Some(target) {
            return Err(unavailable());
        }
        Ok(())
    }

    pub async fn send_turn_with_receipt(
        &self,
        input: Option<&str>,
        attachments: Vec<Value>,
    ) -> Result<AntigravityPromptReceipt, AntigravityRuntimeError> {
        if self.inner.retired.load(Ordering::SeqCst) {
            return Err(AntigravityRuntimeError::Protocol(
                AcpProtocolError::Closed {
                    reason: "Antigravity session retired".to_owned(),
                },
            ));
        }
        let session_id = self.provider_session_id().await?;
        let turn_id = format!("turn-{}", Uuid::new_v4());
        let (accepted_tx, accepted) = oneshot::channel();
        // A mode change landing during the confirmation gets one more confirmation; a second
        // one sends no prompt.
        let mut attempts = 0;
        let prompt_seq;
        loop {
            {
                let mut gate = self.inner.gate.lock().await;
                if !gate.mode_unconfirmed {
                    let seq = gate.allocate_prompt_seq();
                    gate.active_turn = Some(turn_id.clone());
                    gate.active_prompt_seq = seq;
                    gate.active_prompt_wire_id = None;
                    gate.active_turn_has_update = false;
                    gate.active_prompt_quota_notice = None;
                    gate.active_prompt_quota_published = None;
                    gate.steer_in_flight = None;
                    gate.previous_prompt = None;
                    gate.pending_accept = Some((seq, accepted_tx));
                    gate.cancelled_turn = None;
                    prompt_seq = seq;
                    break;
                }
                if attempts == 2 {
                    return Err(AntigravityRuntimeError::ModeUnavailable {
                        mode: gate.mode_target().to_owned(),
                    });
                }
            }
            attempts += 1;
            self.confirm_mode().await?;
        }
        self.emit("turn.started", Some(turn_id.clone()), None, json!({}));
        let connection = self.inner.connection.clone();
        let prompt = crate::provider::attachments::prompt_parts(input, attachments);
        let mut request = match connection
            .start_request(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": prompt }),
            )
            .await
        {
            Ok(request) => request,
            Err(error) => return Err(self.end_unsent_turn(&turn_id, prompt_seq, error).await),
        };
        {
            let mut gate = self.inner.gate.lock().await;
            if gate.active_prompt_seq == prompt_seq {
                gate.active_prompt_wire_id = request.correlation_id().map(str::to_owned);
            }
        }
        let completion = match request.written().await {
            Ok(()) => {
                self.track_prompt_response(turn_id.clone(), prompt_seq, false, request.response())
            }
            Err(failure) if failure.is_definitely_not_sent() => {
                return Err(self
                    .end_unsent_turn(&turn_id, prompt_seq, failure.into_error())
                    .await);
            }
            Err(failure) => self.track_prompt_response(
                turn_id.clone(),
                prompt_seq,
                false,
                std::future::ready(Err(failure.into_error())),
            ),
        };
        Ok(AntigravityPromptReceipt {
            turn_id,
            accepted,
            completion,
        })
    }

    /// Steers the currently running Antigravity turn by sending a second concurrent ACP
    /// `session/prompt` on the same session without ever sending `session/cancel` (#434).
    ///
    /// Refuses steering (leaving the follow-up queued) if the installed `agy` CLI version is
    /// `< 1.5.0`, the expected turn is no longer active or was cancelled, any permission/question
    /// is pending, or the running prompt has not yet produced its first update.
    pub async fn steer_turn(
        &self,
        input: Option<&str>,
        attachments: Vec<Value>,
        expected_turn_id: &str,
    ) -> Result<AntigravityPromptReceipt, AntigravityRuntimeError> {
        let prompt = crate::provider::attachments::prompt_parts(input, attachments);
        let (accepted_tx, accepted) = oneshot::channel();
        let connection = self.inner.connection.clone();
        // Serialize the eligibility check and queueing `session/prompt` under `gate` so neither a
        // permission request nor an explicit Stop can overtake the steer enqueue.
        let (mut request, prev_seq, prev_has_update, new_seq) = {
            let mut gate = self.inner.gate.lock().await;
            if self.inner.retired.load(Ordering::SeqCst) || connection.is_closed() {
                return Err(AntigravityRuntimeError::SteerUnavailable {
                    detail: "The Antigravity session ended before the steer could be sent."
                        .to_owned(),
                });
            }
            if !gate
                .agent_version
                .is_some_and(|version| version >= ANTIGRAVITY_MIN_STEER_VERSION)
            {
                return Err(AntigravityRuntimeError::SteerUnavailable {
                    detail: "Antigravity CLI 1.5.0 or later is required to steer a running turn."
                        .to_owned(),
                });
            }
            let Some(session_id) = gate.session_id.clone() else {
                return Err(AntigravityRuntimeError::MissingProviderSessionId);
            };
            if gate.active_turn.as_deref() != Some(expected_turn_id)
                || gate.cancelled_turn.as_deref() == Some(expected_turn_id)
            {
                return Err(AntigravityRuntimeError::SteerUnavailable {
                    detail: "The running turn ended before the steer could be sent.".to_owned(),
                });
            }
            if !gate.pending.is_empty() {
                return Err(AntigravityRuntimeError::SteerUnavailable {
                    detail: "Respond to the pending approval or question before steering."
                        .to_owned(),
                });
            }
            if !gate.active_turn_has_update {
                return Err(AntigravityRuntimeError::SteerUnavailable {
                    detail: "Wait for the running turn to start responding before steering."
                        .to_owned(),
                });
            }
            if gate.mode_unconfirmed {
                return Err(AntigravityRuntimeError::SteerUnavailable {
                    detail: "Wait for the mode update to finish before steering.".to_owned(),
                });
            }
            if gate.steer_in_flight.is_some() || gate.previous_prompt.is_some() {
                return Err(AntigravityRuntimeError::SteerUnavailable {
                    detail: "Another steer is already in progress.".to_owned(),
                });
            }
            let request = connection
                .start_request(
                    "session/prompt",
                    json!({ "sessionId": session_id, "prompt": prompt }),
                )
                .await
                .map_err(classify)?;
            let prev_seq = gate.active_prompt_seq;
            let prev_wire_id = gate.active_prompt_wire_id.take();
            let prev_has_update = gate.active_turn_has_update;
            let prev_quota_notice = gate.active_prompt_quota_notice.take();
            let prev_quota_published = gate.active_prompt_quota_published.take();
            let new_seq = gate.allocate_prompt_seq();
            let new_wire_id = request.correlation_id().map(str::to_owned);
            gate.previous_prompt = Some(PreviousPrompt {
                seq: prev_seq,
                wire_id: prev_wire_id,
                had_update: prev_has_update,
                wire_ended: false,
                settled: None,
                quota_notice: prev_quota_notice,
                quota_published: prev_quota_published,
            });
            gate.active_prompt_seq = new_seq;
            gate.active_prompt_wire_id = new_wire_id;
            gate.active_turn_has_update = false;
            gate.steer_in_flight = Some(new_seq);
            gate.pending_accept = Some((new_seq, accepted_tx));
            (request, prev_seq, prev_has_update, new_seq)
        };

        let turn_id = expected_turn_id.to_owned();
        let completion = match request.written().await {
            Ok(()) => {
                self.commit_written_steer(new_seq).await;
                self.track_prompt_response(turn_id.clone(), new_seq, true, request.response())
            }
            Err(failure) if failure.is_definitely_not_sent() => {
                self.rollback_unsent_steer(&turn_id, prev_seq, prev_has_update, new_seq)
                    .await;
                return Err(classify(failure.into_error()));
            }
            Err(failure) => {
                self.commit_written_steer(new_seq).await;
                self.track_prompt_response(
                    turn_id.clone(),
                    new_seq,
                    true,
                    std::future::ready(Err(failure.into_error())),
                )
            }
        };
        Ok(AntigravityPromptReceipt {
            turn_id,
            accepted,
            completion,
        })
    }

    async fn rollback_unsent_steer(
        &self,
        turn_id: &str,
        prev_seq: u64,
        prev_has_update: bool,
        new_seq: u64,
    ) {
        enum RollbackOutcome {
            None,
            PublishRestoredNotice(QuotaLimitNotice),
            SettlePrevious {
                pending: Vec<(String, PendingRequest)>,
                quota_notice: Option<QuotaLimitNotice>,
                quota_published: Option<QuotaLimitNotice>,
                delivery_accepted: bool,
                prev_result: Result<Value, AntigravityRuntimeError>,
            },
        }
        let outcome = {
            let mut gate = self.inner.gate.lock().await;
            if gate.steer_in_flight == Some(new_seq) {
                gate.steer_in_flight = None;
            }
            let prev = gate.previous_prompt.take();
            if gate.active_prompt_seq == new_seq {
                gate.pending_accept = None;
                match prev {
                    Some(PreviousPrompt {
                        seq,
                        had_update,
                        settled: Some(prev_result),
                        quota_notice,
                        quota_published,
                        ..
                    }) if seq == prev_seq => {
                        let cleared = gate.clear_active_turn(turn_id);
                        RollbackOutcome::SettlePrevious {
                            pending: cleared.pending,
                            quota_notice,
                            quota_published,
                            delivery_accepted: had_update,
                            prev_result,
                        }
                    }
                    other => {
                        gate.active_prompt_seq = prev_seq;
                        gate.active_prompt_wire_id = other.as_ref().and_then(|p| p.wire_id.clone());
                        gate.active_turn_has_update = prev_has_update;
                        let (restored_notice, restored_published) = match other {
                            Some(p) => (p.quota_notice, p.quota_published),
                            None => (None, None),
                        };
                        let publish = restored_notice
                            .as_ref()
                            .filter(|notice| restored_published.as_ref() != Some(*notice))
                            .cloned();
                        gate.active_prompt_quota_notice = restored_notice;
                        gate.active_prompt_quota_published = publish.clone().or(restored_published);
                        match publish {
                            Some(notice) => RollbackOutcome::PublishRestoredNotice(notice),
                            None => RollbackOutcome::None,
                        }
                    }
                }
            } else {
                RollbackOutcome::None
            }
        };
        match outcome {
            RollbackOutcome::None => {}
            RollbackOutcome::PublishRestoredNotice(notice) => {
                self.emit_usage_limit_warning(turn_id, &notice);
            }
            RollbackOutcome::SettlePrevious {
                pending,
                quota_notice,
                quota_published,
                delivery_accepted,
                prev_result,
            } => {
                self.cancel_pending_requests(pending);
                let _ = self
                    .emit_prompt_completion(
                        turn_id.to_owned(),
                        prev_result,
                        quota_notice,
                        quota_published,
                        None,
                        delivery_accepted,
                    )
                    .await;
            }
        }
    }

    async fn commit_written_steer(&self, new_seq: u64) {
        let mut gate = self.inner.gate.lock().await;
        if gate.steer_in_flight == Some(new_seq) {
            gate.steer_in_flight = None;
        }
    }

    /// A prompt that never reached the CLI: its turn is no longer active and ends as failed.
    async fn end_unsent_turn(
        &self,
        turn_id: &str,
        prompt_seq: u64,
        error: AcpProtocolError,
    ) -> AntigravityRuntimeError {
        let error = self.classify(error);
        let error_class = error.class();
        let error_reason = error.reason();
        tracing::warn!(
            provider = PROVIDER,
            error_class,
            error_reason,
            "antigravity turn failed before prompt delivery"
        );
        let pending = {
            let mut gate = self.inner.gate.lock().await;
            gate.resolve_pending_accept_for(prompt_seq, Err(error.clone()));
            gate.clear_active_turn(turn_id).pending
        };
        self.cancel_pending_requests(pending);
        self.emit(
            "turn.completed",
            Some(turn_id.to_owned()),
            None,
            json!({
                "state": "failed",
                "stopReason": "error",
                "errorMessage": error.turn_error_message(),
                "errorClass": error_class,
                "errorReason": error_reason,
            }),
        );
        error
    }

    fn cancel_pending_requests(&self, pending: Vec<(String, PendingRequest)>) {
        for (request_id, pending) in pending {
            self.emit(
                "request.resolved",
                Some(pending.turn_id),
                Some(request_id),
                json!({ "requestType": pending.request_type, "decision": "cancel" }),
            );
        }
    }

    fn now_utc(&self) -> time::OffsetDateTime {
        let clock = self
            .inner
            .clock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        clock()
    }

    fn classify(&self, error: AcpProtocolError) -> AntigravityRuntimeError {
        classify_with_clock(error, self.now_utc())
    }

    fn emit_usage_limit_warning(&self, turn_id: &str, notice: &QuotaLimitNotice) {
        let mut payload = json!({
            "usageLimit": true,
            "message": notice.message,
        });
        if let Some(resets_at) = &notice.resets_at {
            payload["resetsAt"] = json!(resets_at);
        }
        self.emit("runtime.warning", Some(turn_id.to_owned()), None, payload);
    }

    async fn emit_prompt_completion(
        &self,
        turn_id: String,
        result: Result<Value, AntigravityRuntimeError>,
        chunk_quota_notice: Option<QuotaLimitNotice>,
        published_quota_notice: Option<QuotaLimitNotice>,
        cancelled_prev_notice: Option<QuotaLimitNotice>,
        delivery_accepted: bool,
    ) -> Result<(), AntigravityRuntimeError> {
        let abandoned = self.inner.abandoned_turns.lock().await.remove(&turn_id);
        let emit_quota = |notice: QuotaLimitNotice, ensure_warning: bool| {
            let error = AntigravityRuntimeError::UsageLimitReached {
                message: notice.message.clone(),
                resets_at: notice.resets_at.clone(),
            };
            if !abandoned {
                if ensure_warning && published_quota_notice.as_ref() != Some(&notice) {
                    self.emit_usage_limit_warning(&turn_id, &notice);
                }
                tracing::warn!(
                    provider = PROVIDER,
                    error_class = error.class(),
                    error_reason = error.reason(),
                    has_reset_time = notice.resets_at.is_some(),
                    "antigravity turn hit usage limit"
                );
                let mut payload = json!({
                    "state": "failed",
                    "stopReason": "usage_limit",
                    "errorMessage": notice.message,
                    "errorClass": error.class(),
                    "errorReason": error.reason(),
                });
                if let Some(resets_at) = notice.resets_at {
                    payload["resetsAt"] = json!(resets_at);
                }
                self.emit("turn.completed", Some(turn_id.clone()), None, payload);
            }
            Err(error)
        };
        match result {
            Ok(response) => {
                let stop_reason = response
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or("end_turn");
                if stop_reason == "cancelled" {
                    let cancelled_notice = chunk_quota_notice
                        .filter(|notice| published_quota_notice.as_ref() != Some(notice))
                        .or(cancelled_prev_notice);
                    if !abandoned && let Some(notice) = cancelled_notice {
                        self.emit_usage_limit_warning(&turn_id, &notice);
                    }
                } else if let Some(notice) = chunk_quota_notice {
                    return emit_quota(notice, true);
                }
                let (state, failure_message) = acp_turn_state(stop_reason);
                let mut payload = json!({ "state": state, "stopReason": stop_reason });
                if let Some(message) = failure_message {
                    payload["errorMessage"] = json!(message);
                }
                if !abandoned {
                    self.emit("turn.completed", Some(turn_id), None, payload);
                }
                Ok(())
            }
            Err(error) => {
                let prompt_quota_notice = match &error {
                    AntigravityRuntimeError::UsageLimitReached { message, resets_at } => {
                        Some(QuotaLimitNotice {
                            message: message.clone(),
                            resets_at: resets_at.clone(),
                        })
                    }
                    _ => None,
                };
                let had_chunk_notice = chunk_quota_notice.is_some();
                if let Some(notice) =
                    QuotaLimitNotice::merge(chunk_quota_notice, prompt_quota_notice)
                {
                    // Publish a timeline warning whenever a chunk notice arrived OR delivery was
                    // already accepted (e.g. via `usage_update`), so the notice persists in turn
                    // history; when the prompt rejected before any update, the failed delivery
                    // card is the single visible notice.
                    let ensure_warning =
                        had_chunk_notice || published_quota_notice.is_some() || delivery_accepted;
                    return emit_quota(notice, ensure_warning);
                }
                let error_class = error.class();
                let error_reason = error.reason();
                if !abandoned {
                    tracing::warn!(
                        provider = PROVIDER,
                        error_class,
                        error_reason,
                        "antigravity turn failed"
                    );
                    self.emit(
                        "turn.completed",
                        Some(turn_id),
                        None,
                        json!({
                            "state": "failed",
                            "stopReason": "error",
                            "errorMessage": error.turn_error_message(),
                            "errorClass": error_class,
                            "errorReason": error_reason,
                        }),
                    );
                }
                Err(error)
            }
        }
    }

    fn track_prompt_response<F>(
        &self,
        turn_id: String,
        prompt_seq: u64,
        is_steer: bool,
        response: F,
    ) -> oneshot::Receiver<Result<(), AntigravityRuntimeError>>
    where
        F: Future<Output = Result<Value, AcpProtocolError>> + Send + 'static,
    {
        enum Resolution {
            Superseded(Result<(), AntigravityRuntimeError>),
            SteerRejectedKeepPrevious {
                steer_error: AntigravityRuntimeError,
                publish_restored_notice: Option<QuotaLimitNotice>,
            },
            SteerRejectedSettlePrevious {
                steer_error: AntigravityRuntimeError,
                pending: Vec<(String, PendingRequest)>,
                quota_notice: Option<QuotaLimitNotice>,
                quota_published: Option<QuotaLimitNotice>,
                delivery_accepted: bool,
                prev_result: Result<Value, AntigravityRuntimeError>,
            },
            CompleteTurn {
                pending: Vec<(String, PendingRequest)>,
                quota_notice: Option<QuotaLimitNotice>,
                quota_published: Option<QuotaLimitNotice>,
                cancelled_prev_notice: Option<QuotaLimitNotice>,
                delivery_accepted: bool,
                result: Result<Value, AntigravityRuntimeError>,
            },
        }

        let runtime = self.clone();
        let (completion_tx, completion) = oneshot::channel();
        tokio::spawn(async move {
            let raw_result = response.await;
            // Chunks the agent wrote before its answer may still wait in the incoming queue.
            let _ = runtime.inner.connection.barrier().await;
            // Classify once so the delivery acceptance error and turn completion error share the
            // exact same timestamp and message even across a wall-clock second boundary (#429).
            let result = raw_result.map_err(|error| runtime.classify(error));
            // Check ownership and perform the terminal state transition under ONE lock so a
            // concurrent steer cannot slip between them.
            let resolution = {
                let mut gate = runtime.inner.gate.lock().await;
                if let Some(prev) = gate
                    .previous_prompt
                    .as_mut()
                    .filter(|prev| prev.seq == prompt_seq)
                {
                    let outcome = match &result {
                        Ok(_) => Ok(()),
                        Err(error) => Err(error.clone()),
                    };
                    prev.settled = Some(result);
                    Resolution::Superseded(outcome)
                } else if gate.active_turn.as_deref() == Some(turn_id.as_str())
                    && gate.active_prompt_seq == prompt_seq
                {
                    let steer_rejection = is_steer
                        .then(|| result.as_ref().err().cloned())
                        .flatten()
                        .filter(|error| {
                            matches!(
                                error,
                                AntigravityRuntimeError::SignInRequired
                                    | AntigravityRuntimeError::AccountDisabled { .. }
                                    | AntigravityRuntimeError::UsageLimitReached { .. }
                                    | AntigravityRuntimeError::Protocol(
                                        AcpProtocolError::RemoteRequest { .. }
                                    )
                            )
                        });
                    if let Some(steer_error) = steer_rejection
                        && let Some(prev) = gate.previous_prompt.take()
                    {
                        gate.resolve_pending_accept_for(prompt_seq, Err(steer_error.clone()));
                        if let Some(prev_result) = prev.settled {
                            let cleared = gate.clear_active_turn(&turn_id);
                            Resolution::SteerRejectedSettlePrevious {
                                steer_error,
                                pending: cleared.pending,
                                quota_notice: prev.quota_notice,
                                quota_published: prev.quota_published,
                                delivery_accepted: prev.had_update,
                                prev_result,
                            }
                        } else {
                            gate.active_prompt_seq = prev.seq;
                            gate.active_prompt_wire_id = prev.wire_id;
                            gate.active_turn_has_update = prev.had_update;
                            let publish_restored_notice = prev
                                .quota_notice
                                .as_ref()
                                .filter(|notice| prev.quota_published.as_ref() != Some(*notice))
                                .cloned();
                            gate.active_prompt_quota_notice = prev.quota_notice;
                            gate.active_prompt_quota_published =
                                publish_restored_notice.clone().or(prev.quota_published);
                            gate.steer_in_flight = None;
                            Resolution::SteerRejectedKeepPrevious {
                                steer_error,
                                publish_restored_notice,
                            }
                        }
                    } else {
                        let accept_outcome = match &result {
                            Ok(_) => Ok(()),
                            Err(error) => Err(error.clone()),
                        };
                        let delivery_accepted = gate.active_turn_has_update;
                        gate.resolve_pending_accept_for(prompt_seq, accept_outcome);
                        let cleared = gate.clear_active_turn(&turn_id);
                        Resolution::CompleteTurn {
                            pending: cleared.pending,
                            quota_notice: cleared.quota_notice,
                            quota_published: cleared.quota_published,
                            cancelled_prev_notice: cleared.prev_unpublished_notice,
                            delivery_accepted,
                            result,
                        }
                    }
                } else {
                    let outcome = match result {
                        Ok(_) => Ok(()),
                        Err(error) => Err(error),
                    };
                    Resolution::Superseded(outcome)
                }
            };
            let outcome = match resolution {
                Resolution::Superseded(outcome) => outcome,
                Resolution::SteerRejectedKeepPrevious {
                    steer_error,
                    publish_restored_notice,
                } => {
                    if let Some(notice) = publish_restored_notice {
                        runtime.emit_usage_limit_warning(&turn_id, &notice);
                    }
                    Err(steer_error)
                }
                Resolution::SteerRejectedSettlePrevious {
                    steer_error,
                    pending,
                    quota_notice,
                    quota_published,
                    delivery_accepted,
                    prev_result,
                } => {
                    runtime.cancel_pending_requests(pending);
                    let _ = runtime
                        .emit_prompt_completion(
                            turn_id,
                            prev_result,
                            quota_notice,
                            quota_published,
                            None,
                            delivery_accepted,
                        )
                        .await;
                    Err(steer_error)
                }
                Resolution::CompleteTurn {
                    pending,
                    quota_notice,
                    quota_published,
                    cancelled_prev_notice,
                    delivery_accepted,
                    result,
                } => {
                    runtime.cancel_pending_requests(pending);
                    runtime
                        .emit_prompt_completion(
                            turn_id,
                            result,
                            quota_notice,
                            quota_published,
                            cancelled_prev_notice,
                            delivery_accepted,
                        )
                        .await
                }
            };
            let _ = completion_tx.send(outcome);
        });
        completion
    }

    /// Cancels the active turn: answers its pending approvals with `cancelled` (the ACP rule),
    /// sends `session/cancel`, and, if the CLI does not end the prompt within the grace period,
    /// completes the turn as cancelled and signals [`Self::abandoned`] so the driver stops the
    /// process (D-A10). With `requested`, only when it is that turn: a late stop for a turn that
    /// already ended must not stop the next one.
    pub async fn interrupt_turn(
        &self,
        requested: Option<&str>,
    ) -> Result<(), AntigravityRuntimeError> {
        let (turn_id, session_id) = {
            let mut gate = self.inner.gate.lock().await;
            let Some(turn_id) = gate.active_turn.clone() else {
                return Ok(());
            };
            if requested.is_some_and(|requested| requested != turn_id) {
                return Ok(());
            }
            // From here no request of this turn is answered with anything but `cancelled`.
            gate.cancelled_turn = Some(turn_id.clone());
            for (request_id, pending) in gate.take_pending(&turn_id) {
                let _ = self
                    .inner
                    .connection
                    .respond(
                        pending.wire_id,
                        json!({ "outcome": { "outcome": "cancelled" } }),
                    )
                    .await;
                self.emit(
                    "request.resolved",
                    Some(pending.turn_id),
                    Some(request_id),
                    json!({ "requestType": pending.request_type, "decision": "cancel" }),
                );
            }
            let session_id = gate
                .session_id
                .clone()
                .ok_or(AntigravityRuntimeError::MissingProviderSessionId)?;
            (turn_id, session_id)
        };
        self.inner
            .connection
            .notify("session/cancel", json!({ "sessionId": session_id }))
            .await
            .map_err(classify)?;
        let runtime = self.clone();
        let grace = self.inner.options.cancel_grace;
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            let unpublished_prev_notice = {
                let mut gate = runtime.inner.gate.lock().await;
                if gate.active_turn.as_deref() != Some(turn_id.as_str()) {
                    return;
                }
                gate.active_turn = None;
                gate.active_prompt_seq = 0;
                gate.active_turn_has_update = false;
                gate.active_prompt_quota_notice = None;
                gate.active_prompt_quota_published = None;
                gate.steer_in_flight = None;
                let unpublished_prev_notice = gate
                    .previous_prompt
                    .take()
                    .and_then(|prev| prev.unpublished_quota_notice());
                // An unacknowledged prompt whose cancel grace expired remains ambiguous.
                gate.resolve_pending_accept(Err(AntigravityRuntimeError::Protocol(
                    AcpProtocolError::Closed {
                        reason: "Antigravity did not end the cancelled turn".to_owned(),
                    },
                )));
                runtime
                    .inner
                    .abandoned_turns
                    .lock()
                    .await
                    .insert(turn_id.clone());
                unpublished_prev_notice
            };
            tracing::warn!(
                provider = PROVIDER,
                "the provider did not end a cancelled turn; stopping its process"
            );
            // Mark unavailable for new prompts before publishing cancellation so no prompt slips
            // in between turn settlement and driver shutdown.
            runtime.inner.retired.store(true, Ordering::SeqCst);
            if let Some(notice) = unpublished_prev_notice {
                runtime.emit_usage_limit_warning(&turn_id, &notice);
            }
            runtime.emit(
                "turn.completed",
                Some(turn_id),
                None,
                json!({ "state": "cancelled", "stopReason": "cancelled" }),
            );
            runtime.inner.abandon.notify_one();
        });
        Ok(())
    }

    /// Resolves once a cancelled turn went unanswered; the driver then stops the process.
    pub async fn abandoned(&self) {
        self.inner.abandon.notified().await;
    }

    pub async fn respond_to_request(
        &self,
        request_id: &str,
        decision: &str,
    ) -> Result<(), AntigravityRuntimeError> {
        let mut gate = self.inner.gate.lock().await;
        let pending = gate.pending.remove(request_id).ok_or_else(|| {
            AntigravityRuntimeError::PendingRequestNotFound {
                request_id: request_id.to_owned(),
            }
        })?;
        let selected = match decision {
            "acceptForSession" => pending.allow_always.or(pending.allow_once),
            "accept" => pending.allow_once,
            "decline" => pending.reject_once,
            _ => None,
        };
        let outcome = selected.map_or_else(
            || json!({ "outcome": "cancelled" }),
            |option_id| json!({ "outcome": "selected", "optionId": option_id }),
        );
        self.inner
            .connection
            .respond(pending.wire_id, json!({ "outcome": outcome }))
            .await
            .map_err(classify)?;
        drop(gate);
        self.emit(
            "request.resolved",
            Some(pending.turn_id),
            Some(request_id.to_owned()),
            json!({ "requestType": pending.request_type, "decision": decision }),
        );
        Ok(())
    }

    pub async fn next_event(&self) -> Option<AntigravityRuntimeEvent> {
        self.inner.events_rx.lock().await.recv().await
    }

    #[cfg(test)]
    async fn pending_request_ids(&self) -> Vec<String> {
        self.inner
            .gate
            .lock()
            .await
            .pending
            .keys()
            .cloned()
            .collect()
    }

    #[cfg(test)]
    pub(crate) async fn set_agent_version_for_test(&self, version: Option<(u64, u64, u64)>) {
        self.inner.gate.lock().await.agent_version = version;
    }

    #[cfg(test)]
    pub(crate) fn set_clock_for_test(
        &self,
        clock: impl Fn() -> time::OffsetDateTime + Send + Sync + 'static,
    ) {
        *self
            .inner
            .clock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(clock);
    }

    async fn handle_incoming(&self, event: IncomingEvent) {
        match event {
            IncomingEvent::Notification { method, params } => {
                self.handle_notification(&method, params).await;
            }
            IncomingEvent::Request {
                wire_id,
                method,
                params,
                ..
            } => {
                if let Err(error) = self.handle_request(wire_id, &method, params).await {
                    tracing::warn!(
                        provider = PROVIDER,
                        method = request_label(&method),
                        class = error.class(),
                        "failed to answer an ACP request"
                    );
                }
            }
            IncomingEvent::Stderr { message } => {
                if let Some(notice) = account_disabled_notice(&message) {
                    *self
                        .inner
                        .account_disabled
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(notice);
                }
                // Provider stderr can hold anything; only its size is logged.
                tracing::debug!(
                    provider = PROVIDER,
                    bytes = message.len(),
                    "dropped a provider stderr line"
                );
            }
            IncomingEvent::Closed { reason } => {
                let error_reason = acp_error_reason(&AcpProtocolError::Closed { reason });
                self.emit(
                    "session.exited",
                    None,
                    None,
                    json!({
                        "reason": antigravity_transport_message(error_reason),
                        "errorReason": error_reason,
                    }),
                );
            }
            IncomingEvent::Barrier(reached) => {
                let _ = reached.send(());
            }
            IncomingEvent::ResponseObserved { correlation_id } => {
                let mut gate = self.inner.gate.lock().await;
                if let Some(prev) = gate.previous_prompt.as_mut()
                    && prev.wire_id.as_deref() == Some(correlation_id.as_str())
                {
                    prev.wire_ended = true;
                }
            }
        }
    }

    async fn handle_notification(&self, method: &str, params: Value) {
        if method != "session/update" {
            // The method name comes from the CLI, so it stays out of the log.
            tracing::debug!(provider = PROVIDER, "dropped an unhandled ACP notification");
            return;
        }
        let (session_id, turn_id) = {
            let gate = self.inner.gate.lock().await;
            let turn_id = gate
                .active_turn
                .clone()
                .filter(|turn| gate.cancelled_turn.as_ref() != Some(turn));
            // A cancelled turn's updates stay dropped after it ended, until the next prompt.
            (
                gate.session_id.clone(),
                (
                    turn_id,
                    gate.active_turn.is_some() || gate.cancelled_turn.is_some(),
                ),
            )
        };
        if session_id.is_none()
            || params.get("sessionId").and_then(Value::as_str) != session_id.as_deref()
        {
            // A replay during open, or an update for another session.
            return;
        }
        let update = params.get("update").cloned().unwrap_or(Value::Null);
        let kind = update.get("sessionUpdate").and_then(Value::as_str);
        if kind == Some("config_option_update") {
            if let Some(options) = update.get("configOptions").and_then(Value::as_array) {
                *self.inner.config_options.lock().await = options.clone();
            }
            return;
        }
        // Updates of a cancelled turn are dropped; between turns they carry no turn.
        let (turn_id, has_active_turn) = turn_id;
        if has_active_turn && turn_id.is_none() {
            return;
        }
        let is_handled_turn_update = matches!(
            kind,
            Some(
                "agent_message_chunk" | "tool_call" | "tool_call_update" | "usage_update" | "plan"
            )
        );
        if is_handled_turn_update && turn_id.is_some() {
            let mut gate = self.inner.gate.lock().await;
            if gate.active_turn.as_deref() == turn_id.as_deref()
                && gate
                    .previous_prompt
                    .as_ref()
                    .is_none_or(|prev| prev.wire_ended || prev.settled.is_some())
            {
                // Keep `previous_prompt` until the steer request itself settles. An update
                // that arrives after Prompt 1's response — including the usage report that
                // follows `end_turn` — accepts the steer, but dropping Prompt 1 here would
                // discard its result. A later rejection of the steer would then fail the
                // whole turn instead of settling the prompt that already finished.
                gate.active_turn_has_update = true;
                gate.resolve_pending_accept(Ok(()));
            }
        }
        match kind {
            Some("agent_message_chunk") => {
                let content = update.get("content");
                if content
                    .and_then(|content| content.get("type"))
                    .and_then(Value::as_str)
                    != Some("text")
                {
                    return;
                }
                let delta = content
                    .and_then(|content| content.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(active_turn_id) = turn_id.as_deref()
                    && let Some(notice) = classify_quota_chunk(delta, self.now_utc())
                {
                    let to_publish = {
                        let mut gate = self.inner.gate.lock().await;
                        if gate.active_turn.as_deref() != Some(active_turn_id) {
                            None
                        } else if let Some(prev) = gate
                            .previous_prompt
                            .as_mut()
                            .filter(|prev| !prev.wire_ended && prev.settled.is_none())
                        {
                            // This chunk belongs to the superseded prompt before its wire response:
                            // retain it on `prev` so a healthy steer prompt settles cleanly, and
                            // restore/publish it only if the steer is rejected.
                            prev.quota_notice =
                                QuotaLimitNotice::merge(prev.quota_notice.take(), Some(notice));
                            None
                        } else {
                            let merged = QuotaLimitNotice::merge(
                                gate.active_prompt_quota_notice.take(),
                                Some(notice),
                            );
                            let publish = merged
                                .as_ref()
                                .filter(|next| {
                                    gate.active_prompt_quota_published.as_ref() != Some(*next)
                                })
                                .cloned();
                            gate.active_prompt_quota_notice = merged;
                            if let Some(published) = &publish {
                                gate.active_prompt_quota_published = Some(published.clone());
                            }
                            publish
                        }
                    };
                    if let Some(notice) = to_publish {
                        self.emit_usage_limit_warning(active_turn_id, &notice);
                    }
                    return;
                }
                self.emit(
                    "content.delta",
                    turn_id,
                    None,
                    json!({ "streamKind": "assistant_text", "delta": delta }),
                );
            }
            Some("tool_call" | "tool_call_update") => {
                // Only the ACP fields: agy's non-standard `name` and `args` are ignored.
                // shortcut: a partial `tool_call_update` without `kind` reads as a generic tool;
                // agy sends every field each time (measured). Remember kinds per call if not.
                let (event_type, status) = match update.get("status").and_then(Value::as_str) {
                    Some("completed") => ("item.completed", "completed"),
                    Some("failed") => ("item.completed", "failed"),
                    _ => ("item.updated", "inProgress"),
                };
                self.emit(
                    event_type,
                    turn_id,
                    None,
                    json!({
                        "itemType": item_type(update.get("kind").and_then(Value::as_str)),
                        "itemId": update.get("toolCallId").and_then(Value::as_str).unwrap_or("tool-call"),
                        "status": status,
                        "detail": update.get("title").and_then(Value::as_str).unwrap_or_default(),
                    }),
                );
            }
            Some("usage_update") => {
                // `used` is the context the session holds and `size` its window (measured).
                let Some(used) = update.get("used").and_then(Value::as_u64) else {
                    return;
                };
                let mut usage = json!({ "usedTokens": used });
                if let Some(size) = update.get("size").and_then(Value::as_u64) {
                    usage["maxTokens"] = json!(size);
                }
                self.emit(
                    "thread.token-usage.updated",
                    turn_id,
                    None,
                    json!({ "usage": usage }),
                );
            }
            Some("plan") => {
                let entries = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| {
                        let step = entry.get("content").and_then(Value::as_str)?.trim();
                        let status = match entry.get("status").and_then(Value::as_str) {
                            Some("completed") => "completed",
                            Some("in_progress") => "inProgress",
                            _ => "pending",
                        };
                        (!step.is_empty()).then(|| json!({ "step": step, "status": status }))
                    })
                    .collect::<Vec<_>>();
                self.emit(
                    "turn.plan.updated",
                    turn_id,
                    None,
                    json!({ "entries": entries }),
                );
            }
            _ => {
                tracing::debug!(
                    provider = PROVIDER,
                    "dropped an unhandled ACP session update"
                );
            }
        }
    }

    async fn handle_request(
        &self,
        wire_id: Value,
        method: &str,
        params: Value,
    ) -> Result<(), AntigravityRuntimeError> {
        let connection = &self.inner.connection;
        if method != "session/request_permission" {
            // No elicitation or other client method is offered (D-A7).
            tracing::debug!(provider = PROVIDER, "answered an unknown ACP request");
            connection
                .respond_error(
                    wire_id,
                    JsonRpcErrorShape {
                        code: -32601,
                        message: format!("Method not found: {method}"),
                        data: None,
                    },
                )
                .await?;
            return Ok(());
        }
        // BiBCode never approves by itself, in any mode: full access is the CLI's own `auto`
        // mode, which asks nothing (measured), and any request that still arrives goes to the
        // user. Only a cancel, the user's own, answers `cancelled` for them.
        let mut gate = self.inner.gate.lock().await;
        if gate
            .pending
            .values()
            .any(|pending| pending.wire_id == wire_id)
        {
            // Checked first: a reply in this id's name would read as the answer to the
            // outstanding request, which stays bound to its own operation.
            tracing::warn!(
                provider = PROVIDER,
                "refused a permission request reusing an outstanding id"
            );
            connection
                .respond_error(
                    wire_id,
                    JsonRpcErrorShape {
                        code: -32600,
                        message: "Invalid Request: id already in use".to_owned(),
                        data: None,
                    },
                )
                .await?;
            return Ok(());
        }
        let open_session = gate.session_id.is_some()
            && params.get("sessionId").and_then(Value::as_str) == gate.session_id.as_deref();
        let turn_id = gate
            .active_turn
            .clone()
            .filter(|turn| gate.cancelled_turn.as_ref() != Some(turn));
        let Some(turn_id) = turn_id.filter(|_| open_session) else {
            // Not this session's running turn: during the open, between turns, after a cancel,
            // or another session. Refused, never approved and never shown.
            connection
                .respond(wire_id, json!({ "outcome": { "outcome": "cancelled" } }))
                .await?;
            return Ok(());
        };
        if gate.code_review && mode_for(&gate.runtime_mode, &gate.interaction_mode) == "auto" {
            drop(gate);
            connection
                .respond(wire_id, json!({ "outcome": { "outcome": "cancelled" } }))
                .await?;
            return Ok(());
        }
        let options = params
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let allow_once = find_option_id(&options, "allow_once");
        let request_id = format!("approval:{}", Uuid::new_v4());
        let tool_call = params.get("toolCall");
        let request_type = match item_type(
            tool_call
                .and_then(|tool| tool.get("kind"))
                .and_then(Value::as_str),
        ) {
            "file_change" => "file_change_approval",
            _ => "exec_command_approval",
        };
        let detail = tool_call
            .and_then(|tool| tool.get("title"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        gate.pending.insert(
            request_id.clone(),
            PendingRequest {
                wire_id,
                turn_id: turn_id.clone(),
                request_type,
                allow_once,
                allow_always: find_option_id(&options, "allow_always"),
                reject_once: find_option_id(&options, "reject_once"),
            },
        );
        // The CLI proved it accepted the prompt by opening an approval for it —
        // only once any previous prompt has finished on the wire, so an approval
        // belonging to Prompt 1 cannot acknowledge an unconfirmed concurrent steer.
        if gate
            .previous_prompt
            .as_ref()
            .is_none_or(|prev| prev.wire_ended || prev.settled.is_some())
        {
            // Same as a session update: accepting the steer must not drop Prompt 1.
            gate.active_turn_has_update = true;
            gate.resolve_pending_accept(Ok(()));
        }
        // Emitted under the gate, so a cancel cannot resolve the request before it opens.
        self.emit(
            "request.opened",
            Some(turn_id),
            Some(request_id),
            json!({ "requestType": request_type, "detail": detail }),
        );
        Ok(())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, AntigravityRuntimeError> {
        self.inner
            .connection
            .request(method, params)
            .await
            .map_err(classify)
    }

    async fn provider_session_id(&self) -> Result<String, AntigravityRuntimeError> {
        self.inner
            .gate
            .lock()
            .await
            .session_id
            .clone()
            .ok_or(AntigravityRuntimeError::MissingProviderSessionId)
    }

    fn emit(
        &self,
        event_type: &str,
        turn_id: Option<String>,
        request_id: Option<String>,
        payload: Value,
    ) {
        let _ = self.inner.events_tx.send(AntigravityRuntimeEvent {
            event_type: event_type.to_owned(),
            thread_id: self.inner.options.thread_id.clone(),
            turn_id,
            request_id,
            payload,
        });
    }
}

/// Google's notice that the account may no longer use the service, when `message` carries it:
/// it says the service was disabled in this account and names the Terms of Service. Only the
/// notice is kept, cut out of whatever else the line holds, best effort: from "This service"
/// (or "disabled in this account") through "Terms of Service", and the appeal sentence when one
/// follows it.
fn account_disabled_notice(message: &str) -> Option<String> {
    const DISABLED: &str = "disabled in this account";
    const TERMS: &str = "terms of service";
    const OPENING: &str = "this service has been ";
    const APPEAL_END: &str = "this product.";
    // ASCII lowercasing keeps every byte offset, so the offsets index `message` too.
    let lower = message.to_ascii_lowercase();
    let disabled = lower.find(DISABLED)?;
    let terms = disabled + lower[disabled..].find(TERMS)? + TERMS.len();
    let start = lower[..disabled]
        .rfind(OPENING)
        .filter(|opening| opening + OPENING.len() == disabled)
        .unwrap_or(disabled);
    let notice = terms + usize::from(lower[terms..].starts_with('.'));
    let end = lower[notice..]
        .find(APPEAL_END)
        .filter(|offset| *offset < 200)
        .map_or(notice, |offset| notice + offset + APPEAL_END.len());
    Some(message[start..end].to_owned())
}

/// One classifier for every request: `-32000` "Authentication required" is the sign-in error,
/// Google's notice that the account is disabled is its own error, and quota-limit prompt errors
/// classify into `UsageLimitReached`; any other error passes through.
fn classify(error: AcpProtocolError) -> AntigravityRuntimeError {
    classify_with_clock(error, time::OffsetDateTime::now_utc())
}

fn classify_with_clock(
    error: AcpProtocolError,
    now: time::OffsetDateTime,
) -> AntigravityRuntimeError {
    if let AcpProtocolError::RemoteRequest { message, .. } = &error
        && let Some(google_message) = account_disabled_notice(message)
    {
        return AntigravityRuntimeError::AccountDisabled { google_message };
    }
    match &error {
        AcpProtocolError::RemoteRequest {
            code: -32000,
            message,
            ..
        } if message
            .to_ascii_lowercase()
            .contains("authentication required") =>
        {
            return AntigravityRuntimeError::SignInRequired;
        }
        _ => {}
    }
    if let Some(notice) = classify_quota_prompt_error(&error, now) {
        return AntigravityRuntimeError::UsageLimitReached {
            message: notice.message,
            resets_at: notice.resets_at,
        };
    }
    AntigravityRuntimeError::Protocol(error)
}

const QUOTA_CHUNK_MAX_CHARS: usize = 2_048;
const QUOTA_ERROR_SCAN_MAX_BYTES: usize = 8 * 1024;
const MAX_RESET_DURATION_SECS: u64 = 365 * 24 * 3600;
const MAX_RESET_DURATION_MILLIS: u128 = (MAX_RESET_DURATION_SECS as u128) * 1_000;

const PROMPT_ERROR_QUOTA_PHRASES: &[&str] = &[
    "individual quota reached",
    "exhausted your quota on this model",
    "exhausted your capacity on this model",
    "resource_exhausted",
    "exceeded your current quota",
    "quota exceeded for",
    "usage limit reached",
];

fn is_filesystem_quota_text(lower: &str) -> bool {
    const FILESYSTEM_QUOTA_MARKERS: &[&str] = &[
        "disk quota",
        "edquot",
        "filesystem",
        "file system",
        "no space left on device",
    ];
    FILESYSTEM_QUOTA_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

fn contains_phrase_boundary(text: &str, phrase: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = text[start..].find(phrase) {
        let abs = start + pos;
        let end = abs + phrase.len();
        let prev_ok = abs == 0
            || text[..abs]
                .chars()
                .next_back()
                .is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_');
        let next_ok = end == text.len()
            || text[end..]
                .chars()
                .next()
                .is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_');
        if prev_ok && next_ok {
            return true;
        }
        // Advance past the current char boundary to continue searching.
        let step = text[abs..].chars().next().map_or(1, char::len_utf8);
        start = abs + step;
    }
    false
}

fn matches_prompt_quota_allowlist(lower: &str) -> bool {
    PROMPT_ERROR_QUOTA_PHRASES
        .iter()
        .any(|phrase| contains_phrase_boundary(lower, phrase))
}

fn starts_with_phrase_boundary(text: &str, phrase: &str) -> bool {
    text.strip_prefix(phrase).is_some_and(|rest| {
        rest.chars()
            .next()
            .is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_')
    })
}

/// Classifies a single short ACP `agent_message_chunk` starting directly with `⚠` (`U+26A0`)
/// against the anchored quota notice allowlist (#429). Ordinary prose, indented warnings,
/// multi-line chunks, >2,048-char chunks, chunks without leading `⚠`, and filesystem/disk quota
/// strings never match.
fn classify_quota_chunk(text: &str, now: time::OffsetDateTime) -> Option<QuotaLimitNotice> {
    if text.contains('\n') || text.contains('\r') {
        return None;
    }
    if text.chars().count() > QUOTA_CHUNK_MAX_CHARS {
        return None;
    }
    let after_warning = text.strip_prefix('\u{26A0}')?;
    let body = after_warning
        .strip_prefix('\u{FE0F}')
        .unwrap_or(after_warning)
        .trim_start_matches([' ', '\t']);
    let body_lower = body.to_ascii_lowercase();
    if is_filesystem_quota_text(&body_lower) {
        return None;
    }
    let matches_allowlist = starts_with_phrase_boundary(&body_lower, "individual quota reached")
        || starts_with_phrase_boundary(&body_lower, "you have exhausted your quota on this model")
        || starts_with_phrase_boundary(
            &body_lower,
            "you have exhausted your capacity on this model",
        )
        || body_lower
            .strip_prefix("agent executor error:")
            .is_some_and(matches_prompt_quota_allowlist);
    if !matches_allowlist {
        return None;
    }
    let duration = parse_reset_duration(body);
    Some(format_usage_limit_notice(duration, now))
}

/// Classifies a `session/prompt` JSON-RPC error against the tight quota error allowlist (#429).
/// Non-prompt ACP control errors, bare HTTP 429 errors without an explicit quota phrase, and
/// filesystem/disk quota errors never match.
fn classify_quota_prompt_error(
    error: &AcpProtocolError,
    now: time::OffsetDateTime,
) -> Option<QuotaLimitNotice> {
    let AcpProtocolError::RemoteRequest {
        method,
        message,
        data,
        ..
    } = error
    else {
        return None;
    };
    if method != "session/prompt" {
        return None;
    }
    let mut message_buf = String::new();
    push_bounded(&mut message_buf, message, QUOTA_ERROR_SCAN_MAX_BYTES);
    let mut data_buf = String::new();
    if let Some(data) = data {
        collect_error_data_text(data, &mut data_buf, QUOTA_ERROR_SCAN_MAX_BYTES, 0);
    }
    let message_lower = message_buf.to_ascii_lowercase();
    let data_lower = data_buf.to_ascii_lowercase();
    if is_filesystem_quota_text(&message_lower) || is_filesystem_quota_text(&data_lower) {
        return None;
    }
    if !matches_prompt_quota_allowlist(&message_lower)
        && !matches_prompt_quota_allowlist(&data_lower)
    {
        return None;
    }
    let duration = parse_reset_duration(&message_buf).or_else(|| parse_reset_duration(&data_buf));
    Some(format_usage_limit_notice(duration, now))
}

fn push_bounded(out: &mut String, part: &str, max_bytes: usize) {
    if part.is_empty() || out.len() >= max_bytes {
        return;
    }
    if !out.is_empty() && out.len() < max_bytes {
        out.push(' ');
    }
    let remaining = max_bytes.saturating_sub(out.len());
    if part.len() <= remaining {
        out.push_str(part);
    } else {
        let mut end = remaining;
        while end > 0 && !part.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&part[..end]);
    }
}

fn collect_error_data_text(value: &Value, out: &mut String, max_bytes: usize, depth: usize) {
    if depth >= 4 || out.len() >= max_bytes {
        return;
    }
    match value {
        Value::String(text) => push_bounded(out, text, max_bytes),
        Value::Array(items) => {
            for item in items {
                collect_error_data_text(item, out, max_bytes, depth + 1);
            }
        }
        Value::Object(map) => {
            for (key, entry) in map {
                if matches!(
                    key.as_str(),
                    "code"
                        | "errno"
                        | "message"
                        | "detail"
                        | "details"
                        | "error"
                        | "reason"
                        | "status"
                ) {
                    collect_error_data_text(entry, out, max_bytes, depth + 1);
                }
            }
        }
        _ => {}
    }
}

/// Parses a relative reset duration following `Resets in`, `reset after`, or `retry in` in either
/// Go duration syntax (`2h30m0s`, `45m`) or unit words (`4 hours, 5 minutes`).
fn parse_reset_duration(text: &str) -> Option<Duration> {
    const INTRODUCERS: &[&str] = &["resets in", "reset after", "retry in"];
    let lower = text.to_ascii_lowercase();
    let mut matches: Vec<(usize, usize)> = Vec::new();
    for introducer in INTRODUCERS {
        let mut start = 0;
        while let Some(pos) = lower[start..].find(introducer) {
            let abs = start + pos;
            let after = abs + introducer.len();
            // Ensure the introducer is not glued inside a longer word.
            let prev_ok = abs == 0 || !lower.as_bytes()[abs - 1].is_ascii_alphabetic();
            let next_ok = after == lower.len() || !lower.as_bytes()[after].is_ascii_alphabetic();
            if prev_ok && next_ok {
                matches.push((abs, after));
            }
            start = after;
        }
    }
    matches.sort_unstable_by_key(|(pos, _)| *pos);
    for (_, after) in matches {
        if let Some(duration) = parse_duration_expression(&lower[after..]) {
            return Some(duration);
        }
    }
    None
}

fn parse_duration_expression(input: &str) -> Option<Duration> {
    let mut rest =
        input.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ':' || c == '~');
    for filler in ["approximately ", "about "] {
        if let Some(stripped) = rest.strip_prefix(filler) {
            rest = stripped.trim_start();
            break;
        }
    }

    let mut total_millis: u128 = 0;
    let mut components = 0usize;

    loop {
        if components > 0 {
            let trimmed = rest.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == ',');
            let trimmed = if let Some(after_and) = trimmed.strip_prefix("and")
                && after_and.starts_with(|c: char| c.is_ascii_whitespace())
            {
                after_and.trim_start()
            } else {
                trimmed
            };
            rest = trimmed;
        }

        let num_end = rest
            .bytes()
            .take_while(|b| b.is_ascii_digit() || *b == b'.')
            .count();
        if num_end == 0 {
            break;
        }
        let num_str = &rest[..num_end];
        if !num_str.bytes().any(|b| b.is_ascii_digit()) {
            break;
        }
        let Ok(value) = num_str.parse::<f64>() else {
            break;
        };
        if !value.is_finite() || value < 0.0 {
            break;
        }
        let after_num = rest[num_end..].trim_start_matches([' ', '\t']);
        let Some((unit_millis, unit_len)) = parse_duration_unit(after_num) else {
            break;
        };
        let added = (value * unit_millis).round();
        if !added.is_finite() || added < 0.0 {
            break;
        }
        total_millis = total_millis.saturating_add(added as u128);
        components += 1;
        rest = &after_num[unit_len..];
    }

    if components == 0 || total_millis == 0 {
        return None;
    }
    let clamped_millis = u64::try_from(total_millis.min(MAX_RESET_DURATION_MILLIS))
        .unwrap_or(MAX_RESET_DURATION_SECS * 1_000);
    Some(Duration::from_millis(clamped_millis))
}

fn parse_duration_unit(text: &str) -> Option<(f64, usize)> {
    // Longest units first so `ms`/`milliseconds` match before `m`, and `minutes` before `min`/`m`.
    const UNITS: &[(&str, f64)] = &[
        ("milliseconds", 1.0),
        ("millisecond", 1.0),
        ("msecs", 1.0),
        ("msec", 1.0),
        ("ms", 1.0),
        ("seconds", 1_000.0),
        ("second", 1_000.0),
        ("secs", 1_000.0),
        ("sec", 1_000.0),
        ("minutes", 60_000.0),
        ("minute", 60_000.0),
        ("mins", 60_000.0),
        ("min", 60_000.0),
        ("hours", 3_600_000.0),
        ("hour", 3_600_000.0),
        ("hrs", 3_600_000.0),
        ("hr", 3_600_000.0),
        ("days", 86_400_000.0),
        ("day", 86_400_000.0),
        ("s", 1_000.0),
        ("m", 60_000.0),
        ("h", 3_600_000.0),
        ("d", 86_400_000.0),
    ];
    for &(token, millis) in UNITS {
        if let Some(after) = text.strip_prefix(token) {
            let boundary_ok = after
                .as_bytes()
                .first()
                .is_none_or(|b| !b.is_ascii_alphabetic());
            if boundary_ok {
                return Some((millis, token.len()));
            }
        }
    }
    None
}

fn format_relative_duration(duration: Duration) -> String {
    let total_secs = duration.as_secs();
    let days = total_secs / 86_400;
    let hours = (total_secs % 86_400) / 3_600;
    let minutes = (total_secs % 3_600) / 60;
    let seconds = total_secs % 60;
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if seconds > 0 || parts.is_empty() {
        parts.push(format!("{seconds}s"));
    }
    parts.join(" ")
}

fn format_usage_limit_notice(
    duration: Option<Duration>,
    now: time::OffsetDateTime,
) -> QuotaLimitNotice {
    let Some(duration) = duration else {
        return QuotaLimitNotice {
            message: "Antigravity usage limit reached. Try again later or switch models."
                .to_owned(),
            resets_at: None,
        };
    };
    let duration_millis = i64::try_from(duration.as_millis()).unwrap_or(i64::MAX);
    let resets_at_dt =
        (now + time::Duration::milliseconds(duration_millis)).to_offset(time::UtcOffset::UTC);
    let resets_at_iso = if resets_at_dt.millisecond() == 0 {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            resets_at_dt.year(),
            u8::from(resets_at_dt.month()),
            resets_at_dt.day(),
            resets_at_dt.hour(),
            resets_at_dt.minute(),
            resets_at_dt.second(),
        )
    } else {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            resets_at_dt.year(),
            u8::from(resets_at_dt.month()),
            resets_at_dt.day(),
            resets_at_dt.hour(),
            resets_at_dt.minute(),
            resets_at_dt.second(),
            resets_at_dt.millisecond(),
        )
    };
    // Round both the relative wait and the absolute UTC display time up independently so neither
    // is ever earlier than the real reset instant (even when `now` has sub-second milliseconds).
    let display_secs = u64::try_from(duration.as_millis().div_ceil(1_000))
        .unwrap_or(MAX_RESET_DURATION_SECS)
        .min(MAX_RESET_DURATION_SECS);
    let display_dt = if resets_at_dt.nanosecond() > 0 {
        resets_at_dt.replace_nanosecond(0).unwrap_or(resets_at_dt) + time::Duration::seconds(1)
    } else {
        resets_at_dt
    };
    let absolute_display = if display_dt.second() == 0 {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02} UTC",
            display_dt.year(),
            u8::from(display_dt.month()),
            display_dt.day(),
            display_dt.hour(),
            display_dt.minute(),
        )
    } else {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
            display_dt.year(),
            u8::from(display_dt.month()),
            display_dt.day(),
            display_dt.hour(),
            display_dt.minute(),
            display_dt.second(),
        )
    };
    let relative = format_relative_duration(Duration::from_secs(display_secs));
    QuotaLimitNotice {
        message: format!(
            "Antigravity usage limit reached. Resets at {absolute_display} (in {relative})."
        ),
        resets_at: Some(resets_at_iso),
    }
}

/// `session/resume` of an unknown id answers `-32603` "Failed to read session ..." (measured).
fn is_missing_session(error: &AntigravityRuntimeError) -> bool {
    matches!(
        error,
        AntigravityRuntimeError::Protocol(AcpProtocolError::RemoteRequest { code: -32603, message, .. })
            if message.contains("Failed to read session")
    )
}

/// The ACP mode a thread's permission and interaction modes ask for. An unknown runtime mode
/// asks before acting.
pub(crate) fn mode_for(runtime_mode: &str, interaction_mode: &str) -> &'static str {
    if interaction_mode == "plan" {
        return "plan";
    }
    match runtime_mode {
        "full-access" => "auto",
        "auto-accept-edits" => "accept-edits",
        _ => "default",
    }
}

fn item_type(kind: Option<&str>) -> &'static str {
    match kind {
        Some("edit" | "delete" | "move") => "file_change",
        Some("execute") => "command_execution",
        _ => "dynamic_tool_call",
    }
}

/// The config option for `category` (`model`, `thought_level`, `mode`): the one with that ACP
/// category, else one whose id is the category name, as the CLI may omit the category. The
/// inventory reads the session's options through it too, so a chat accepts what it advertised.
pub(crate) fn option_by_category<'a>(options: &'a [Value], category: &str) -> Option<&'a Value> {
    let named = |key: &str| {
        options
            .iter()
            .find(|option| option.get(key).and_then(Value::as_str) == Some(category))
    };
    named("category").or_else(|| named("id"))
}

/// The session's effective mode, as a config answer lists it.
fn current_mode(options: &[Value]) -> Option<&str> {
    option_by_category(options, "mode")
        .and_then(|descriptor| descriptor.get("currentValue"))
        .and_then(Value::as_str)
}

/// A fixed name for a request method from the CLI, safe to log.
fn request_label(method: &str) -> &'static str {
    if method == "session/request_permission" {
        "session/request_permission"
    } else {
        "unknown"
    }
}

fn option_id(descriptor: &Value) -> &str {
    descriptor
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn advertises(descriptor: &Value, value: &str) -> bool {
    descriptor
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|option| option.get("value").and_then(Value::as_str) == Some(value))
}

fn find_option_id(options: &[Value], kind: &str) -> Option<String> {
    options.iter().find_map(|option| {
        (option.get("kind").and_then(Value::as_str) == Some(kind))
            .then(|| option.get("optionId").and_then(Value::as_str))
            .flatten()
            .map(str::to_owned)
    })
}

/// The first `major.minor.patch` in `text`.
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    parse_semver_triple(text)
}

/// A `model` and a `thought_level` option without a category, as the inventory's catalog test
/// reads them; the runtime test selects the level the inventory publishes from them.
#[cfg(test)]
pub(crate) fn uncategorized_level_options() -> Value {
    json!([
        { "id": "model", "currentValue": "alpha", "options": [{ "value": "alpha" }] },
        { "id": "thought_level", "name": "Thinking", "currentValue": "low",
          "options": [{ "value": "extra-high", "name": "Extra High" }, { "value": "low" }] }
    ])
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
