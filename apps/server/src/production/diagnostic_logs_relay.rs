//! `bibcode diagnostics download` (#201): a command on this host asks for a connected
//! environment's diagnostic bundle, and the desktop app relays it after the user approves.
//!
//! No server holds a connection to another environment: the app does, so the bytes come
//! through it. The command posts to [`RELAY_PATH`] on this server with the per-boot token
//! from [`RELAY_ENDPOINT_FILE`] and reads one JSON line per [`RelayLine`]. The server
//! announces the request on `server.subscribeDiagnosticLogsRelay` to the desktop app's own
//! session only (never another paired device), the app asks the user, claims the request,
//! runs `server.downloadDiagnosticLogs` on the named environment with its own checks, and
//! sends the verified archive back with `server.sendDiagnosticLogsRelayItem`.
//!
//! One request at a time. A claim binds the request to the claiming session and connection;
//! items from any other, or for a request that is over, are refused. Each item is answered
//! only after the command took the one before, so the server holds at most one. The request
//! ends when it is answered, when nobody approves it within [`APPROVAL_DEADLINE`], when the
//! claimant's connection closes, when the claimant stalls, or when the command goes away;
//! subscribers then see `Closed`, which stops the app's download.

use std::{
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    body::{Body, to_bytes},
    extract::Request,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq as _;
use tokio::{
    sync::{Mutex, broadcast, mpsc, mpsc::error::SendTimeoutError},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    diagnostic_bundle::MAX_DIAGNOSTIC_ARCHIVE_BYTES,
    production::diagnostic_logs_rpc::DIAGNOSTIC_LOGS_CHUNK_BYTES,
    rpc::{RpcRegistry, RpcSessionContext, RpcStreamChunk},
};

pub const SUBSCRIBE_METHOD: &str = "server.subscribeDiagnosticLogsRelay";
pub const CLAIM_METHOD: &str = "server.claimDiagnosticLogsRelay";
pub const SEND_METHOD: &str = "server.sendDiagnosticLogsRelayItem";
/// The command's route on this server.
pub const RELAY_PATH: &str = "/api/diagnostics/relay";
/// In the state directory, while the server runs: its loopback URL and the command's token.
pub const RELAY_ENDPOINT_FILE: &str = "diagnostics-relay.json";
/// How long a request waits for someone to approve or deny it.
pub const APPROVAL_DEADLINE: Duration = Duration::from_secs(120);
/// How long an approved request may take to start: the app first downloads the whole
/// archive from the environment, whose own stream ends a link slower than about 1 KiB/s.
pub const START_DEADLINE: Duration = Duration::from_secs(10 * 60);
/// How long a started relay may wait for its next item, and an item for the command.
pub const ITEM_DEADLINE: Duration = Duration::from_secs(60);
/// The archive names the app may send: the shape `server.downloadDiagnosticLogs` uses.
pub const MAX_ARCHIVE_NAME_BYTES: usize = 128;
const MAX_ENVIRONMENT_SELECTOR_BYTES: usize = 256;
const MAX_FAILURE_MESSAGE_BYTES: usize = 2 * 1024;
const MAX_LISTED_ENVIRONMENTS: usize = 64;
const MAX_LISTED_FIELD_BYTES: usize = 256;
const MAX_MANIFEST_BYTES: usize = 16 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 4 * 1024;
const FAILURE_REASONS: [&str; 12] = [
    "unknown-environment",
    "ambiguous-environment",
    "not-connected",
    "unsupported",
    "unverified",
    "wrong-environment",
    "incomplete",
    "too-large",
    "not-permitted",
    "crash-dumps-refused",
    "server-failed",
    "connection-lost",
];

/// `true` for a name `server.downloadDiagnosticLogs` could have produced: no separator, no
/// leading dot, nothing but letters, digits, `.`, `_` and `-`, ending in `.zip`.
#[must_use]
pub fn is_archive_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    name.len() <= MAX_ARCHIVE_NAME_BYTES
        && name.len() > ".zip".len()
        && name.ends_with(".zip")
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Why a relay ended without the app answering it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EndReason {
    /// Another request is in progress.
    Busy,
    /// No desktop app is subscribed to this server.
    NoApp,
    /// Nobody approved or denied it in time.
    Expired,
    /// The approving window's connection closed (a reload, a quit, a lost socket).
    ConnectionLost,
    /// The app stopped sending, or the command stopped reading.
    Stalled,
    /// The app sent an item out of order or over a bound.
    Invalid,
}

impl EndReason {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::NoApp => "no-app",
            Self::Expired => "expired",
            Self::ConnectionLost => "connection-lost",
            Self::Stalled => "stalled",
            Self::Invalid => "invalid",
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::Busy => {
                "Another diagnostics download is waiting in BiBCode. Try again once it ends."
            }
            Self::NoApp => {
                "No BiBCode desktop window is connected to this server. Open BiBCode and try again."
            }
            Self::Expired => "Nobody approved the request in BiBCode within 2 minutes.",
            Self::ConnectionLost => {
                "The BiBCode window that approved the request closed or lost its connection."
            }
            Self::Stalled => "BiBCode stopped sending the logs.",
            Self::Invalid => "BiBCode sent an invalid archive. Nothing was saved.",
        }
    }
}

/// One line of the command's response, in order: `Waiting`, then `Denied` or `Failed`, or
/// `Started`, `Data`… and `Finished`; `Ended` stands in for any of them when the relay ended
/// without an answer.
#[derive(Clone, Debug, PartialEq)]
pub enum RelayLine {
    Waiting,
    Started {
        file_name: String,
        byte_length: u64,
        manifest: Value,
    },
    /// Base64, at most [`DIAGNOSTIC_LOGS_CHUNK_BYTES`] decoded.
    Data(String),
    Finished,
    Denied,
    Failed {
        reason: String,
        message: String,
        environments: Option<Value>,
    },
    Ended(EndReason),
}

impl RelayLine {
    #[must_use]
    pub fn to_json(&self) -> Value {
        match self {
            Self::Waiting => json!({ "type": "waiting" }),
            Self::Started {
                file_name,
                byte_length,
                manifest,
            } => json!({
                "type": "started",
                "fileName": file_name,
                "byteLength": byte_length,
                "manifest": manifest,
            }),
            Self::Data(data) => json!({ "type": "data", "data": data }),
            Self::Finished => json!({ "type": "finished" }),
            Self::Denied => json!({ "type": "denied" }),
            Self::Failed {
                reason,
                message,
                environments,
            } => {
                let mut line = json!({ "type": "failed", "reason": reason, "message": message });
                if let Some(environments) = environments {
                    line["environments"] = environments.clone();
                }
                line
            }
            Self::Ended(reason) => json!({
                "type": "ended",
                "reason": reason.as_str(),
                "message": reason.message(),
            }),
        }
    }

    fn is_answer(&self) -> bool {
        matches!(
            self,
            Self::Finished | Self::Denied | Self::Failed { .. } | Self::Ended(_)
        )
    }
}

/// The desktop app's own session on one connection: the only kind that may serve a relay.
#[derive(Clone)]
pub struct Claimant {
    session_id: String,
    connection_id: Uuid,
    closed: CancellationToken,
}

impl Claimant {
    /// The connection's claimant identity when its session is the desktop app's own (minted
    /// from the desktop bootstrap on this host); `None` for every other session, however
    /// broad its scopes, so no other device can be made to pull logs onto this host.
    pub(crate) fn of(context: &RpcSessionContext) -> Option<Self> {
        let principal = context.principal()?;
        (principal.subject == crate::auth::DESKTOP_BOOTSTRAP_SUBJECT).then(|| Self {
            session_id: principal.session_id.clone(),
            connection_id: context.connection_id(),
            closed: context.connection_closed(),
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_owned(),
            connection_id: Uuid::new_v4(),
            closed: CancellationToken::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn close_for_test(&self) {
        self.closed.cancel();
    }

    fn owns(&self, claim: &Claim) -> bool {
        self.session_id == claim.session_id && self.connection_id == claim.connection_id
    }
}

struct Claim {
    session_id: String,
    connection_id: Uuid,
    /// The declared archive length once `Started` arrived.
    expected: Option<u64>,
    received: u64,
    sending: bool,
}

struct Active {
    request_id: String,
    environment: String,
    include_crash_dumps: bool,
    output: mpsc::Sender<RelayLine>,
    /// The line the command reads when the relay ends without an answer.
    end_line: Arc<std::sync::Mutex<Option<RelayLine>>>,
    ended: CancellationToken,
    claim: Option<Claim>,
    deadline: Instant,
}

#[derive(Default)]
struct State {
    active: Option<Active>,
    /// The last request that ended, and whether the command left (an item for it is then
    /// `cancelled`, telling the app to stop its download, rather than `stale`).
    last_ended: Option<(String, bool)>,
}

struct Inner {
    state: Mutex<State>,
    events: broadcast::Sender<Value>,
    subscribers: AtomicUsize,
}

/// The relay between `bibcode diagnostics download` and the desktop app. Cloning shares it.
#[derive(Clone)]
pub struct DiagnosticLogsRelay {
    inner: Arc<Inner>,
}

impl Default for DiagnosticLogsRelay {
    fn default() -> Self {
        Self::new()
    }
}

/// What a command reads, line by line. Dropping it (the command went away) ends the relay.
pub struct RelayStream {
    relay: DiagnosticLogsRelay,
    request_id: String,
    receiver: mpsc::Receiver<RelayLine>,
    end_line: Arc<std::sync::Mutex<Option<RelayLine>>>,
    ended: CancellationToken,
    done: bool,
}

impl RelayStream {
    #[must_use]
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// The next line, `None` after the answer.
    pub async fn next(&mut self) -> Option<RelayLine> {
        if self.done {
            return None;
        }
        let line = tokio::select! {
            biased;
            line = self.receiver.recv() => line,
            () = self.ended.cancelled() => self.receiver.try_recv().ok(),
        };
        let line = line.or_else(|| {
            self.end_line
                .lock()
                .ok()
                .and_then(|mut end| end.take())
                .or(Some(RelayLine::Ended(EndReason::Stalled)))
        });
        if line.as_ref().is_some_and(RelayLine::is_answer) {
            self.done = true;
        }
        line
    }
}

impl Drop for RelayStream {
    fn drop(&mut self) {
        let relay = self.relay.clone();
        let request_id = std::mem::take(&mut self.request_id);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move { relay.end(&request_id, None, true).await });
        }
    }
}

fn relay_error(reason: &'static str, message: &str) -> Value {
    json!({ "_tag": "DiagnosticLogsRelayError", "reason": reason, "message": message })
}

fn not_desktop() -> Value {
    relay_error(
        "not-desktop",
        "Only the BiBCode desktop app on this computer can answer diagnostics requests.",
    )
}

#[derive(Deserialize)]
#[serde(tag = "_tag", deny_unknown_fields)]
enum ItemInput {
    Denied {},
    Failed {
        reason: String,
        message: String,
        #[serde(default)]
        environments: Option<Vec<ListedEnvironment>>,
    },
    Started {
        #[serde(rename = "fileName")]
        file_name: String,
        #[serde(rename = "byteLength")]
        byte_length: u64,
        manifest: Value,
    },
    Data {
        data: String,
    },
    Finished {},
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListedEnvironment {
    environment_id: String,
    label: String,
    connected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendInput {
    request_id: String,
    item: ItemInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimInput {
    request_id: String,
}

fn truncate(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// The checked line for `item`, or why it breaks the order or a bound.
fn checked_line(item: ItemInput, claim: &mut Claim) -> Result<RelayLine, &'static str> {
    match item {
        ItemInput::Denied {} if claim.expected.is_none() => Ok(RelayLine::Denied),
        ItemInput::Failed {
            reason,
            message,
            environments,
        } if claim.expected.is_none() => {
            if !FAILURE_REASONS.contains(&reason.as_str()) || message.trim().is_empty() {
                return Err("unknown failure reason or empty message");
            }
            let environments = match environments {
                None => None,
                Some(list) if list.len() > MAX_LISTED_ENVIRONMENTS => {
                    return Err("too many environments listed");
                }
                Some(list) => {
                    if list.iter().any(|entry| {
                        entry.environment_id.len() > MAX_LISTED_FIELD_BYTES
                            || entry.label.len() > MAX_LISTED_FIELD_BYTES
                    }) {
                        return Err("a listed environment is too long");
                    }
                    Some(serde_json::to_value(list).map_err(|_| "unlistable environments")?)
                }
            };
            Ok(RelayLine::Failed {
                reason,
                message: truncate(&message, MAX_FAILURE_MESSAGE_BYTES),
                environments,
            })
        }
        ItemInput::Started {
            file_name,
            byte_length,
            manifest,
        } if claim.expected.is_none() => {
            if !is_archive_name(&file_name) {
                return Err("archive name");
            }
            if byte_length > MAX_DIAGNOSTIC_ARCHIVE_BYTES as u64 {
                return Err("archive over the size limit");
            }
            if !manifest.is_object()
                || serde_json::to_vec(&manifest)
                    .map_or(true, |bytes| bytes.len() > MAX_MANIFEST_BYTES)
            {
                return Err("manifest");
            }
            claim.expected = Some(byte_length);
            Ok(RelayLine::Started {
                file_name,
                byte_length,
                manifest,
            })
        }
        ItemInput::Data { data } => {
            let Some(expected) = claim.expected else {
                return Err("data before Started");
            };
            // From the length alone, before anything is decoded.
            if data.is_empty() || data.len() > DIAGNOSTIC_LOGS_CHUNK_BYTES.div_ceil(3) * 4 {
                return Err("item size");
            }
            let decoded = STANDARD.decode(&data).map_err(|_| "item encoding")?;
            let length = decoded.len() as u64;
            if decoded.len() > DIAGNOSTIC_LOGS_CHUNK_BYTES || claim.received + length > expected {
                return Err("item size");
            }
            claim.received += length;
            Ok(RelayLine::Data(data))
        }
        ItemInput::Finished {} => match claim.expected {
            Some(expected) if claim.received == expected => Ok(RelayLine::Finished),
            _ => Err("finished before every byte arrived"),
        },
        _ => Err("item out of order"),
    }
}

impl DiagnosticLogsRelay {
    #[must_use]
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(16);
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                events,
                subscribers: AtomicUsize::new(0),
            }),
        }
    }

    /// Starts a request for the command. Fails at once with [`EndReason::NoApp`] when no
    /// desktop app could see it, and [`EndReason::Busy`] while another one runs.
    pub async fn start(
        &self,
        environment: &str,
        include_crash_dumps: bool,
    ) -> Result<RelayStream, EndReason> {
        if self.inner.subscribers.load(Ordering::Acquire) == 0 {
            return Err(EndReason::NoApp);
        }
        let request_id = format!("relay_{}", Uuid::new_v4().simple());
        let (output, receiver) = mpsc::channel(1);
        let end_line = Arc::new(std::sync::Mutex::new(None));
        let ended = CancellationToken::new();
        {
            let mut state = self.inner.state.lock().await;
            if state.active.is_some() {
                return Err(EndReason::Busy);
            }
            state.active = Some(Active {
                request_id: request_id.clone(),
                environment: environment.to_owned(),
                include_crash_dumps,
                output,
                end_line: end_line.clone(),
                ended: ended.clone(),
                claim: None,
                deadline: Instant::now() + APPROVAL_DEADLINE,
            });
        }
        let _ = self.inner.events.send(json!({
            "_tag": "Pending",
            "request": {
                "requestId": request_id,
                "environment": environment,
                "includeCrashDumps": include_crash_dumps,
            },
        }));
        tracing::info!(
            request_id = %request_id,
            include_crash_dumps,
            "diagnostics relay request waiting for approval"
        );
        tokio::spawn(
            self.clone()
                .watch_deadline(request_id.clone(), ended.clone()),
        );
        Ok(RelayStream {
            relay: self.clone(),
            request_id,
            receiver,
            end_line,
            ended,
            done: false,
        })
    }

    /// Ends the request at its deadline: approval while it waits, start or the next item once
    /// it is claimed. A deadline only moves later, so waking early just sleeps again.
    async fn watch_deadline(self, request_id: String, ended: CancellationToken) {
        loop {
            let deadline = {
                let state = self.inner.state.lock().await;
                match &state.active {
                    Some(active) if active.request_id == request_id => active.deadline,
                    _ => return,
                }
            };
            tokio::select! {
                () = ended.cancelled() => return,
                () = tokio::time::sleep_until(deadline) => {}
            }
            let reason = {
                let state = self.inner.state.lock().await;
                match &state.active {
                    Some(active) if active.request_id == request_id => {
                        if Instant::now() < active.deadline {
                            continue;
                        }
                        if active.claim.is_some() {
                            EndReason::Stalled
                        } else {
                            EndReason::Expired
                        }
                    }
                    _ => return,
                }
            };
            self.end(&request_id, Some(reason), false).await;
            return;
        }
    }

    /// Ends `request_id` if it is still the active request: with `reason` as the command's
    /// last line (`None` after a normal answer or when the command left), then `Closed`.
    async fn end(&self, request_id: &str, reason: Option<EndReason>, command_left: bool) {
        let active = {
            let mut state = self.inner.state.lock().await;
            match &state.active {
                Some(active) if active.request_id == request_id => {
                    state.last_ended = Some((request_id.to_owned(), command_left));
                    state.active.take()
                }
                _ => None,
            }
        };
        let Some(active) = active else {
            return;
        };
        if let Some(reason) = reason {
            if let Ok(mut end) = active.end_line.lock() {
                *end = Some(RelayLine::Ended(reason));
            }
            tracing::warn!(
                request_id,
                reason = reason.as_str(),
                "diagnostics relay request ended without an answer"
            );
        } else if command_left {
            tracing::info!(
                request_id,
                "diagnostics relay request ended: the command left"
            );
        }
        active.ended.cancel();
        let _ = self
            .inner
            .events
            .send(json!({ "_tag": "Closed", "requestId": request_id }));
    }

    async fn pending_event(&self) -> Option<Value> {
        let state = self.inner.state.lock().await;
        let active = state.active.as_ref()?;
        active.claim.is_none().then(|| {
            json!({
                "_tag": "Pending",
                "request": {
                    "requestId": active.request_id,
                    "environment": active.environment,
                    "includeCrashDumps": active.include_crash_dumps,
                },
            })
        })
    }

    /// The desktop app's subscription: the waiting request, if any, then every new one and
    /// every `Closed`. While it lasts, a command's request can be seen.
    pub fn subscribe(
        &self,
        claimant: Option<Claimant>,
        cancellation: CancellationToken,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(16);
        let Some(claimant) = claimant else {
            let _ = sender.try_send(Err(not_desktop()));
            return receiver;
        };
        let relay = self.clone();
        // Before the task runs, so a request started right after this call already sees it.
        relay.inner.subscribers.fetch_add(1, Ordering::AcqRel);
        let mut events = relay.inner.events.subscribe();
        tokio::spawn(async move {
            struct Counted(Arc<Inner>);
            impl Drop for Counted {
                fn drop(&mut self) {
                    self.0.subscribers.fetch_sub(1, Ordering::AcqRel);
                }
            }
            let _counted = Counted(relay.inner.clone());
            let mut pending = relay.pending_event().await;
            loop {
                if let Some(event) = pending.take()
                    && sender.send(Ok(vec![event])).await.is_err()
                {
                    return;
                }
                tokio::select! {
                    () = cancellation.cancelled() => return,
                    () = claimant.closed.cancelled() => return,
                    event = events.recv() => match event {
                        Ok(event) => pending = Some(event),
                        // Missed events: the current request is all that matters.
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            pending = relay.pending_event().await;
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                }
            }
        });
        receiver
    }

    /// Takes the waiting request for `claimant`'s connection. `false` when it is not waiting
    /// any more (another window took it, it ended, or it never existed).
    pub async fn claim(&self, claimant: &Claimant, request_id: &str) -> bool {
        let ended = {
            let mut state = self.inner.state.lock().await;
            let Some(active) = state.active.as_mut() else {
                return false;
            };
            if active.request_id != request_id || active.claim.is_some() {
                return false;
            }
            active.claim = Some(Claim {
                session_id: claimant.session_id.clone(),
                connection_id: claimant.connection_id,
                expected: None,
                received: 0,
                sending: false,
            });
            active.deadline = Instant::now() + START_DEADLINE;
            active.ended.clone()
        };
        tracing::info!(request_id, "diagnostics relay request claimed");
        // A reload, quit or lost socket of the claiming window ends the request.
        let relay = self.clone();
        let closed = claimant.closed.clone();
        let request_id = request_id.to_owned();
        tokio::spawn(async move {
            tokio::select! {
                () = ended.cancelled() => {}
                () = closed.cancelled() => {
                    relay.end(&request_id, Some(EndReason::ConnectionLost), false).await;
                }
            }
        });
        true
    }

    async fn over(&self, request_id: &str) -> Value {
        let state = self.inner.state.lock().await;
        match &state.last_ended {
            Some((ended, true)) if ended == request_id => relay_error(
                "cancelled",
                "The command that asked for these logs went away. Stop the download.",
            ),
            _ => relay_error("stale", "This diagnostics request is over."),
        }
    }

    /// Forwards one item of `claimant`'s request to the command, once the command took the
    /// item before. An item that breaks the order or a bound ends the request.
    pub async fn send(&self, claimant: &Claimant, payload: Value) -> Result<(), Value> {
        let input: SendInput = serde_json::from_value(payload)
            .map_err(|error| relay_error("invalid", &format!("Invalid relay item: {error}")))?;
        let request_id = input.request_id;
        let (line, output, ended) = {
            let mut state = self.inner.state.lock().await;
            let Some(active) = state
                .active
                .as_mut()
                .filter(|active| active.request_id == request_id)
            else {
                drop(state);
                return Err(self.over(&request_id).await);
            };
            let Some(claim) = active.claim.as_mut().filter(|claim| claimant.owns(claim)) else {
                return Err(relay_error(
                    "stale",
                    "This diagnostics request belongs to another connection.",
                ));
            };
            if claim.sending {
                return Err(relay_error("invalid", "Send one relay item at a time."));
            }
            match checked_line(input.item, claim) {
                Ok(line) => {
                    claim.sending = true;
                    active.deadline = Instant::now() + ITEM_DEADLINE;
                    (line, active.output.clone(), active.ended.clone())
                }
                Err(problem) => {
                    drop(state);
                    tracing::warn!(%request_id, problem, "diagnostics relay item refused");
                    self.end(&request_id, Some(EndReason::Invalid), false).await;
                    return Err(relay_error(
                        "invalid",
                        &format!("Invalid relay item: {problem}."),
                    ));
                }
            }
        };
        let answer = line.is_answer();
        let sent = tokio::select! {
            sent = output.send_timeout(line, ITEM_DEADLINE) => sent,
            () = ended.cancelled() => return Err(self.over(&request_id).await),
        };
        match sent {
            Ok(()) => {}
            Err(SendTimeoutError::Timeout(_)) => {
                self.end(&request_id, Some(EndReason::Stalled), false).await;
                return Err(relay_error("stale", "The command stopped reading."));
            }
            Err(SendTimeoutError::Closed(_)) => {
                self.end(&request_id, None, true).await;
                return Err(self.over(&request_id).await);
            }
        }
        if answer {
            tracing::info!(%request_id, "diagnostics relay request answered");
            self.end(&request_id, None, false).await;
        } else {
            let mut state = self.inner.state.lock().await;
            if let Some(active) = state
                .active
                .as_mut()
                .filter(|active| active.request_id == request_id)
            {
                active.deadline = Instant::now() + ITEM_DEADLINE;
                if let Some(claim) = active.claim.as_mut() {
                    claim.sending = false;
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    async fn is_idle(&self) -> bool {
        self.inner.state.lock().await.active.is_none()
    }
}

/// Registers the desktop app's three relay methods. Each refuses a session that is not the
/// desktop app's own with `not-desktop`.
pub fn register_diagnostic_logs_relay_rpc(registry: &mut RpcRegistry, relay: DiagnosticLogsRelay) {
    let subscribe = relay.clone();
    registry.register_stream_with_context(
        SUBSCRIBE_METHOD,
        move |_request, context, cancellation| {
            subscribe.subscribe(Claimant::of(&context), cancellation)
        },
    );
    let claim = relay.clone();
    registry.register_unary_with_context(CLAIM_METHOD, move |request, context, _cancellation| {
        let relay = claim.clone();
        async move {
            let claimant = Claimant::of(&context).ok_or_else(not_desktop)?;
            let input: ClaimInput = serde_json::from_value(request.payload)
                .map_err(|error| relay_error("invalid", &format!("Invalid claim: {error}")))?;
            Ok(json!({ "claimed": relay.claim(&claimant, &input.request_id).await }))
        }
    });
    registry.register_unary_with_context(SEND_METHOD, move |request, context, _cancellation| {
        let relay = relay.clone();
        async move {
            let claimant = Claimant::of(&context).ok_or_else(not_desktop)?;
            relay.send(&claimant, request.payload).await?;
            Ok(json!({}))
        }
    });
}

/// The command's side of the relay on this server: the relay and the token the endpoint
/// file names.
#[derive(Clone)]
pub struct DiagnosticLogsRelayRoute {
    relay: DiagnosticLogsRelay,
    token: Arc<str>,
}

impl DiagnosticLogsRelayRoute {
    #[must_use]
    pub fn new(relay: DiagnosticLogsRelay, token: impl Into<Arc<str>>) -> Self {
        Self {
            relay,
            token: token.into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandRequest {
    environment: String,
    #[serde(default)]
    include_crash_dumps: bool,
}

fn route_error(status: StatusCode, tag: &str, message: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        axum::Json(json!({ "_tag": tag, "message": message })),
    )
        .into_response()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn token_matches(expected: &str, supplied: Option<&str>) -> bool {
    supplied.is_some_and(|supplied| {
        expected.len() == supplied.len()
            && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
    })
}

/// `POST` [`RELAY_PATH`] from a command on this host: only from this machine (a loopback
/// peer, or one on the address it reached), only with the endpoint file's token. The answer
/// is one JSON line per [`RelayLine`]; the command going away ends the request.
pub(crate) async fn relay_http(
    route: Option<DiagnosticLogsRelayRoute>,
    connection: crate::http::ConnectionInfo,
    request: Request,
) -> Response {
    let Some(route) = route else {
        return route_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "NativeRuntimeUnavailableError",
            "The native production runtime is unavailable.",
        );
    };
    let same_host = connection.is_ok_and(|axum::extract::ConnectInfo(addrs)| {
        addrs.peer.ip().is_loopback()
            || addrs
                .local
                .is_some_and(|local| local.ip() == addrs.peer.ip())
    });
    if !same_host {
        return route_error(
            StatusCode::FORBIDDEN,
            "DiagnosticLogsRelayForbiddenError",
            "Diagnostics downloads are accepted only from this computer.",
        );
    }
    let (parts, body) = request.into_parts();
    if !token_matches(&route.token, bearer(&parts.headers)) {
        return route_error(
            StatusCode::UNAUTHORIZED,
            "DiagnosticLogsRelayUnauthorizedError",
            "The diagnostics relay token is missing or out of date.",
        );
    }
    let Ok(body) = to_bytes(body, MAX_REQUEST_BODY_BYTES).await else {
        return route_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "DiagnosticLogsRelayInvalidError",
            "The request is too large.",
        );
    };
    let input = match serde_json::from_slice::<CommandRequest>(&body) {
        Ok(input)
            if !input.environment.trim().is_empty()
                && input.environment.len() <= MAX_ENVIRONMENT_SELECTOR_BYTES =>
        {
            input
        }
        _ => {
            return route_error(
                StatusCode::BAD_REQUEST,
                "DiagnosticLogsRelayInvalidError",
                "Name the environment, in at most 256 bytes.",
            );
        }
    };
    let first = match route
        .relay
        .start(input.environment.trim(), input.include_crash_dumps)
        .await
    {
        Ok(stream) => Ok(stream),
        Err(reason) => Err(RelayLine::Ended(reason)),
    };
    enum Phase {
        Waiting(RelayStream),
        Streaming(RelayStream),
        Refused(RelayLine),
        Done,
    }
    let phase = match first {
        Ok(stream) => Phase::Waiting(stream),
        Err(line) => Phase::Refused(line),
    };
    let lines = futures_util::stream::unfold(phase, |phase| async move {
        let (line, next) = match phase {
            Phase::Waiting(stream) => (RelayLine::Waiting, Phase::Streaming(stream)),
            Phase::Streaming(mut stream) => match stream.next().await {
                Some(line) => (line, Phase::Streaming(stream)),
                None => return None,
            },
            Phase::Refused(line) => (line, Phase::Done),
            Phase::Done => return None,
        };
        let mut encoded = line.to_json().to_string();
        encoded.push('\n');
        Some((
            Ok::<_, std::convert::Infallible>(bytes::Bytes::from(encoded)),
            next,
        ))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(lines))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// A fresh per-boot token for the command: 32 random bytes, hex.
pub fn new_relay_token() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// [`RELAY_ENDPOINT_FILE`] while the server runs; dropping it removes the file, unless a
/// later server has written its own there since.
pub struct RelayEndpointFile {
    path: PathBuf,
    token: String,
}

impl RelayEndpointFile {
    /// Writes the file readable by its owner only, through a temporary file and a rename,
    /// so a command never reads half of it.
    pub fn write(state_dir: &Path, url: &str, token: &str) -> io::Result<Self> {
        let path = state_dir.join(RELAY_ENDPOINT_FILE);
        let temporary = state_dir.join(format!(
            ".{RELAY_ENDPOINT_FILE}.{}",
            Uuid::new_v4().simple()
        ));
        let document = json!({ "version": 1, "url": url, "token": token });
        let written = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt as _;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(document.to_string().as_bytes())?;
            file.sync_all()?;
            std::fs::rename(&temporary, &path)
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(Self {
            path,
            token: token.to_owned(),
        })
    }
}

impl Drop for RelayEndpointFile {
    fn drop(&mut self) {
        let ours = std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|document| document["token"] == self.token.as_str());
        if ours && let Err(error) = std::fs::remove_file(&self.path) {
            tracing::warn!(%error, "could not remove the diagnostics relay endpoint file");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Value {
        json!({ "schemaVersion": 1, "storageInstanceId": "storage-remote" })
    }

    async fn subscribed(
        relay: &DiagnosticLogsRelay,
        claimant: &Claimant,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        let receiver = relay.subscribe(Some(claimant.clone()), CancellationToken::new());
        tokio::task::yield_now().await;
        receiver
    }

    async fn pending_id(events: &mut mpsc::Receiver<RpcStreamChunk>) -> String {
        let event = events.recv().await.expect("event").expect("ok").remove(0);
        assert_eq!(event["_tag"], "Pending");
        event["request"]["requestId"]
            .as_str()
            .expect("id")
            .to_owned()
    }

    fn item(request_id: &str, item: Value) -> Value {
        json!({ "requestId": request_id, "item": item })
    }

    #[test]
    fn archive_names_have_the_download_shape_only() {
        assert!(is_archive_name(
            "bibcode-diagnostics-omarchy-20261027T120000Z.zip"
        ));
        for forged in [
            "../evil.zip",
            "a/b.zip",
            "a\\b.zip",
            ".hidden.zip",
            ".zip",
            "logs.tar",
            "logs.zip\0",
            "C:evil.zip",
            "é.zip",
            "",
        ] {
            assert!(!is_archive_name(forged), "{forged:?}");
        }
        assert!(!is_archive_name(&format!(
            "{}.zip",
            "a".repeat(MAX_ARCHIVE_NAME_BYTES)
        )));
    }

    #[tokio::test]
    async fn without_a_desktop_window_a_request_fails_at_once() {
        let relay = DiagnosticLogsRelay::new();
        assert!(matches!(
            relay.start("Omarchy", false).await,
            Err(EndReason::NoApp)
        ));
    }

    #[tokio::test]
    async fn another_session_cannot_subscribe() {
        let relay = DiagnosticLogsRelay::new();
        let mut events = relay.subscribe(None, CancellationToken::new());
        let error = events.recv().await.expect("refusal").expect_err("refused");
        assert_eq!(error["reason"], "not-desktop");
        assert!(matches!(
            relay.start("Omarchy", false).await,
            Err(EndReason::NoApp)
        ));
    }

    #[tokio::test]
    async fn a_second_request_is_busy_while_one_runs() {
        let relay = DiagnosticLogsRelay::new();
        let app = Claimant::for_test("desktop");
        let _events = subscribed(&relay, &app).await;
        let _first = relay.start("Omarchy", false).await.expect("first");
        assert!(matches!(
            relay.start("Luna", false).await,
            Err(EndReason::Busy)
        ));
    }

    #[tokio::test]
    async fn an_approved_archive_reaches_the_command_in_order() {
        let relay = DiagnosticLogsRelay::new();
        let app = Claimant::for_test("desktop");
        let mut events = subscribed(&relay, &app).await;
        let mut stream = relay.start("Omarchy", true).await.expect("start");
        let id = pending_id(&mut events).await;
        assert!(relay.claim(&app, &id).await);
        // Another window answering later finds it taken.
        assert!(!relay.claim(&Claimant::for_test("desktop"), &id).await);

        let archive = vec![7_u8; DIAGNOSTIC_LOGS_CHUNK_BYTES + 10];
        let sender = relay.clone();
        let app_task = app.clone();
        let sent_id = id.clone();
        let chunks: Vec<String> = archive
            .chunks(DIAGNOSTIC_LOGS_CHUNK_BYTES)
            .map(|chunk| STANDARD.encode(chunk))
            .collect();
        let producer = tokio::spawn(async move {
            sender
                .send(
                    &app_task,
                    item(
                        &sent_id,
                        json!({
                            "_tag": "Started",
                            "fileName": "bibcode-diagnostics-omarchy.zip",
                            "byteLength": archive.len(),
                            "manifest": manifest(),
                        }),
                    ),
                )
                .await?;
            for chunk in chunks {
                sender
                    .send(
                        &app_task,
                        item(&sent_id, json!({ "_tag": "Data", "data": chunk })),
                    )
                    .await?;
            }
            sender
                .send(&app_task, item(&sent_id, json!({ "_tag": "Finished" })))
                .await
        });
        let mut lines = Vec::new();
        while let Some(line) = stream.next().await {
            lines.push(line);
        }
        producer
            .await
            .expect("producer")
            .expect("every item accepted");
        assert!(
            matches!(&lines[0], RelayLine::Started { byte_length, .. } if *byte_length == (DIAGNOSTIC_LOGS_CHUNK_BYTES + 10) as u64)
        );
        assert!(matches!(lines[1], RelayLine::Data(_)));
        assert!(matches!(lines[2], RelayLine::Data(_)));
        assert_eq!(lines[3], RelayLine::Finished);
        assert_eq!(lines.len(), 4);
        assert!(relay.is_idle().await);
        let closed = events.recv().await.expect("closed").expect("ok").remove(0);
        assert_eq!(closed, json!({ "_tag": "Closed", "requestId": id }));
        // An item after the answer is stale.
        let error = relay
            .send(&app, item(&id, json!({ "_tag": "Finished" })))
            .await
            .expect_err("over");
        assert_eq!(error["reason"], "stale");
    }

    #[tokio::test]
    async fn a_denial_reaches_the_command() {
        let relay = DiagnosticLogsRelay::new();
        let app = Claimant::for_test("desktop");
        let mut events = subscribed(&relay, &app).await;
        let mut stream = relay.start("Omarchy", false).await.expect("start");
        let id = pending_id(&mut events).await;
        assert!(relay.claim(&app, &id).await);
        relay
            .send(&app, item(&id, json!({ "_tag": "Denied" })))
            .await
            .expect("denied");
        assert_eq!(stream.next().await, Some(RelayLine::Denied));
        assert_eq!(stream.next().await, None);
    }

    #[tokio::test]
    async fn only_the_claiming_connection_may_send() {
        let relay = DiagnosticLogsRelay::new();
        let app = Claimant::for_test("desktop");
        let mut events = subscribed(&relay, &app).await;
        let _stream = relay.start("Omarchy", false).await.expect("start");
        let id = pending_id(&mut events).await;
        // Before a claim, nobody may send.
        let unclaimed = relay
            .send(&app, item(&id, json!({ "_tag": "Denied" })))
            .await
            .expect_err("unclaimed");
        assert_eq!(unclaimed["reason"], "stale");
        assert!(relay.claim(&app, &id).await);
        // The same session on another connection (another window) is not the claimant.
        let other = Claimant::for_test("desktop");
        let error = relay
            .send(&other, item(&id, json!({ "_tag": "Denied" })))
            .await
            .expect_err("other connection");
        assert_eq!(error["reason"], "stale");
        assert!(!relay.is_idle().await, "the claimant's request goes on");
    }

    #[tokio::test]
    async fn an_item_out_of_order_or_over_a_bound_ends_the_request() {
        for (items, problem) in [
            (
                vec![json!({ "_tag": "Data", "data": "AAAA" })],
                "data first",
            ),
            (
                vec![json!({
                    "_tag": "Started",
                    "fileName": "../escape.zip",
                    "byteLength": 3,
                    "manifest": manifest(),
                })],
                "forged name",
            ),
            (
                vec![json!({
                    "_tag": "Started",
                    "fileName": "logs.zip",
                    "byteLength": MAX_DIAGNOSTIC_ARCHIVE_BYTES + 1,
                    "manifest": manifest(),
                })],
                "over the archive limit",
            ),
            (
                vec![
                    json!({ "_tag": "Started", "fileName": "logs.zip", "byteLength": 2, "manifest": manifest() }),
                    json!({ "_tag": "Data", "data": STANDARD.encode([1_u8, 2, 3]) }),
                ],
                "more bytes than declared",
            ),
            (
                vec![
                    json!({ "_tag": "Started", "fileName": "logs.zip", "byteLength": DIAGNOSTIC_LOGS_CHUNK_BYTES + 1, "manifest": manifest() }),
                    json!({ "_tag": "Data", "data": STANDARD.encode(vec![0_u8; DIAGNOSTIC_LOGS_CHUNK_BYTES + 1]) }),
                ],
                "an item over 64 KiB",
            ),
            (
                vec![
                    json!({ "_tag": "Started", "fileName": "logs.zip", "byteLength": 4, "manifest": manifest() }),
                    json!({ "_tag": "Data", "data": STANDARD.encode([1_u8, 2]) }),
                    json!({ "_tag": "Finished" }),
                ],
                "short of the declared length",
            ),
            (
                vec![json!({ "_tag": "Failed", "reason": "made-up", "message": "x" })],
                "unknown failure reason",
            ),
        ] {
            let relay = DiagnosticLogsRelay::new();
            let app = Claimant::for_test("desktop");
            let mut events = subscribed(&relay, &app).await;
            let mut stream = relay.start("Omarchy", false).await.expect("start");
            let id = pending_id(&mut events).await;
            assert!(relay.claim(&app, &id).await);
            let reader = tokio::spawn(async move {
                let mut lines = Vec::new();
                while let Some(line) = stream.next().await {
                    lines.push(line);
                }
                lines
            });
            let mut refused = None;
            for value in items {
                if let Err(error) = relay.send(&app, item(&id, value)).await {
                    refused = Some(error);
                    break;
                }
            }
            let error = refused.unwrap_or_else(|| panic!("{problem}: accepted"));
            assert_eq!(error["reason"], "invalid", "{problem}");
            let lines = reader.await.expect("reader");
            assert_eq!(
                lines.last(),
                Some(&RelayLine::Ended(EndReason::Invalid)),
                "{problem}"
            );
            assert!(
                !lines.contains(&RelayLine::Finished),
                "{problem}: never reported as saved"
            );
            assert!(relay.is_idle().await, "{problem}: the slot is released");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_unanswered_request_expires_and_frees_the_slot() {
        let relay = DiagnosticLogsRelay::new();
        let app = Claimant::for_test("desktop");
        let mut events = subscribed(&relay, &app).await;
        let mut stream = relay.start("Omarchy", false).await.expect("start");
        let id = pending_id(&mut events).await;
        assert_eq!(
            stream.next().await,
            Some(RelayLine::Ended(EndReason::Expired))
        );
        assert!(relay.is_idle().await);
        let closed = events.recv().await.expect("closed").expect("ok").remove(0);
        assert_eq!(closed["_tag"], "Closed");
        // A claim or an item after expiry is refused.
        assert!(!relay.claim(&app, &id).await);
        let error = relay
            .send(&app, item(&id, json!({ "_tag": "Denied" })))
            .await
            .expect_err("expired");
        assert_eq!(error["reason"], "stale");
    }

    #[tokio::test(start_paused = true)]
    async fn a_claimant_that_never_starts_is_ended_at_the_start_deadline() {
        let relay = DiagnosticLogsRelay::new();
        let app = Claimant::for_test("desktop");
        let mut events = subscribed(&relay, &app).await;
        let mut stream = relay.start("Omarchy", false).await.expect("start");
        let id = pending_id(&mut events).await;
        assert!(relay.claim(&app, &id).await);
        tokio::time::advance(APPROVAL_DEADLINE + Duration::from_secs(1)).await;
        assert!(
            !relay.is_idle().await,
            "approval no longer bounds a claimed request"
        );
        assert_eq!(
            stream.next().await,
            Some(RelayLine::Ended(EndReason::Stalled))
        );
        assert!(relay.is_idle().await);
    }

    #[tokio::test]
    async fn the_claimants_disconnect_ends_the_request() {
        let relay = DiagnosticLogsRelay::new();
        let app = Claimant::for_test("desktop");
        let mut events = subscribed(&relay, &app).await;
        let mut stream = relay.start("Omarchy", false).await.expect("start");
        let id = pending_id(&mut events).await;
        assert!(relay.claim(&app, &id).await);
        app.close_for_test();
        assert_eq!(
            stream.next().await,
            Some(RelayLine::Ended(EndReason::ConnectionLost))
        );
        assert!(relay.is_idle().await);
    }

    #[tokio::test]
    async fn the_command_leaving_cancels_the_apps_download() {
        let relay = DiagnosticLogsRelay::new();
        let app = Claimant::for_test("desktop");
        let mut events = subscribed(&relay, &app).await;
        let stream = relay.start("Omarchy", false).await.expect("start");
        let id = pending_id(&mut events).await;
        assert!(relay.claim(&app, &id).await);
        drop(stream);
        // The app learns it from the subscription, which stops its download…
        let closed = events.recv().await.expect("closed").expect("ok").remove(0);
        assert_eq!(closed, json!({ "_tag": "Closed", "requestId": id }));
        assert!(relay.is_idle().await);
        // …and from the next item it sends.
        let error = relay
            .send(&app, item(&id, json!({ "_tag": "Denied" })))
            .await
            .expect_err("cancelled");
        assert_eq!(error["reason"], "cancelled");
    }

    #[tokio::test(start_paused = true)]
    async fn a_command_that_stops_reading_ends_the_request() {
        let relay = DiagnosticLogsRelay::new();
        let app = Claimant::for_test("desktop");
        let mut events = subscribed(&relay, &app).await;
        let _stream = relay.start("Omarchy", false).await.expect("start");
        let id = pending_id(&mut events).await;
        assert!(relay.claim(&app, &id).await);
        relay
            .send(&app, item(&id, json!({ "_tag": "Started", "fileName": "logs.zip", "byteLength": 6, "manifest": manifest() })))
            .await
            .expect("queued");
        // The command never reads: the next item waits at most the item deadline.
        let error = relay
            .send(
                &app,
                item(
                    &id,
                    json!({ "_tag": "Data", "data": STANDARD.encode([1_u8, 2, 3]) }),
                ),
            )
            .await
            .expect_err("stalled");
        assert_eq!(error["reason"], "stale");
        assert!(relay.is_idle().await);
    }

    #[tokio::test]
    async fn a_reconnected_window_sees_the_waiting_request() {
        let relay = DiagnosticLogsRelay::new();
        let first = Claimant::for_test("desktop");
        let _events = subscribed(&relay, &first).await;
        let _stream = relay.start("Omarchy", true).await.expect("start");
        let reloaded = Claimant::for_test("desktop-after-reload");
        let mut events = subscribed(&relay, &reloaded).await;
        let event = events.recv().await.expect("pending").expect("ok").remove(0);
        assert_eq!(event["request"]["environment"], "Omarchy");
        assert_eq!(event["request"]["includeCrashDumps"], true);
    }

    #[test]
    fn the_endpoint_file_is_owner_only_and_removed_with_its_server() {
        let dir = tempfile::tempdir().expect("dir");
        let file =
            RelayEndpointFile::write(dir.path(), "http://127.0.0.1:1", "abc").expect("write");
        let path = dir.path().join(RELAY_ENDPOINT_FILE);
        let document: Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
        assert_eq!(
            document,
            json!({ "version": 1, "url": "http://127.0.0.1:1", "token": "abc" })
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // A later server's file is left alone.
        let later =
            RelayEndpointFile::write(dir.path(), "http://127.0.0.1:2", "def").expect("later");
        drop(file);
        assert!(path.exists());
        drop(later);
        assert!(!path.exists());
    }
}
