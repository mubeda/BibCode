#![cfg_attr(test, allow(dead_code))]

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    sync::{Mutex, Notify, mpsc, oneshot},
    task::JoinHandle,
};
use uuid::Uuid;

use crate::provider::{
    OptionRefusal, RefusedOption, RequestScope, default_model_unavailable_refusal,
};

use super::{
    acp::{
        AcpJsonRpcConnection, AcpProtocolError, AcpRequestWriteFailure, IncomingEvent,
        JsonRpcErrorShape, acp_error_class, acp_turn_state,
    },
    model::{
        acp_config_option_current_value, acp_model_descriptor, acp_model_values_are_bracketed,
        advertised_auto_model_value, resolve_acp_config_updates_with_baseline,
        resolve_acp_default_model_config, resolve_advertised_model_value,
        resolve_bracketed_model_options,
    },
};

const PROVIDER: &str = "cursor";

/// How long a Cursor turn may go without any update before BiBCode shows a notice on it. The turn
/// keeps running: the user decides whether to stop it. The clock pauses while the turn waits on
/// the user or on a tool Cursor reports running, and the notice clears with the next update.
pub const DEFAULT_SILENCE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// How long a stopped turn's cancelled prompt may take to be answered before BiBCode ends the turn
/// and stops the process, so nothing the old prompt still produces reaches the next message.
const STOP_CANCEL_GRACE: Duration = Duration::from_secs(10);
/// How long writing a prompt to the CLI may block before BiBCode stops the process.
const PROMPT_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a stopped process may take to fail the blocked write, which tells how much was sent.
const RETIRED_WRITE_SETTLE: Duration = Duration::from_secs(10);
const FIXED_EVENT_TIME: &str = "2026-07-10T00:00:00.000Z";

/// Phrases that mean the saved Cursor session itself is gone. A `session/load`
/// error that does not say this can be transient, so the saved id must be kept.
const GONE_CURSOR_SESSION_SNIPPETS: &[&str] = &[
    "not found",
    "does not exist",
    "doesn't exist",
    "no such session",
    "unknown session",
    "missing session",
];

/// `true` only when Cursor reported that this session cannot be loaded again.
fn session_load_is_permanently_gone(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    let names_session = lowered.contains("session") || lowered.contains("conversation");
    names_session
        && GONE_CURSOR_SESSION_SNIPPETS
            .iter()
            .any(|snippet| lowered.contains(snippet))
}

#[derive(Clone, Debug)]
pub struct CursorSessionOptions {
    pub thread_id: String,
    pub cwd: String,
    pub runtime_mode: String,
    pub interaction_mode: String,
    pub model: String,
    pub resume_session_id: Option<String>,
    pub mcp_servers: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorRuntimeEvent {
    pub event_id: String,
    pub provider: String,
    pub created_at: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug)]
pub struct CursorPromptReceipt {
    pub turn_id: String,
    completion: oneshot::Receiver<Result<(), CursorRuntimeError>>,
}

impl CursorPromptReceipt {
    pub async fn completion(self) -> Result<(), CursorRuntimeError> {
        self.completion.await.unwrap_or_else(|_| {
            Err(CursorRuntimeError::Protocol(AcpProtocolError::Closed {
                reason: "Cursor prompt receipt task ended without an outcome".to_owned(),
            }))
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorRuntimeEventStableView {
    #[serde(rename = "type")]
    pub event_type: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub payload: Value,
}

impl CursorRuntimeEvent {
    #[must_use]
    pub fn stable_view(&self) -> CursorRuntimeEventStableView {
        CursorRuntimeEventStableView {
            event_type: self.event_type.clone(),
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            item_id: self.item_id.clone(),
            request_id: self.request_id.clone(),
            payload: self.payload.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum CursorRuntimeError {
    #[error(transparent)]
    Protocol(#[from] AcpProtocolError),
    #[error("Cursor runtime has not started a provider session")]
    MissingProviderSessionId,
    #[error("Unknown pending request id {request_id}")]
    PendingRequestNotFound { request_id: String },
    /// The session refuses a turn's options, checked against what it advertises: an option or
    /// value it does not advertise, a configuration BiBCode can't work with, or a switch to the
    /// default model when the session advertises none. The same request is refused again on
    /// every retry.
    #[error("Cursor option update is unsupported: {0}")]
    UnsupportedOption(RefusedOption),
    /// A config update failed and every update applied before it was rolled back. The failure may
    /// be transient, so a retry may succeed.
    #[error("Cursor option update failed and was rolled back: {application}")]
    ConfigUpdateRolledBack { application: String },
    #[error("Cursor config update acknowledgement omitted configOptions")]
    MalformedConfigAcknowledgement,
    #[error("Cursor config update failed: {application}; compensation failed: {compensation}")]
    ConfigCompensationFailed {
        application: String,
        compensation: String,
    },
    #[error("Cursor session configuration is uncertain: {detail}")]
    ConfigurationUncertain { detail: String },
}

impl OptionRefusal for CursorRuntimeError {
    fn refused_option(&self) -> Option<&RefusedOption> {
        match self {
            Self::UnsupportedOption(refused) => Some(refused),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct CursorSessionRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    options: CursorSessionOptions,
    connection: Mutex<AcpJsonRpcConnection>,
    provider_session_id: Mutex<Option<String>>,
    config_options: Mutex<Vec<Value>>,
    baseline_config_options: Mutex<Vec<Value>>,
    default_model_config: Mutex<Option<(String, Value)>>,
    configuration_uncertain: Mutex<Option<String>>,
    mode_state: Mutex<Option<Value>>,
    runtime_mode: Mutex<String>,
    interaction_mode: Mutex<String>,
    active_turn_id: Mutex<Option<String>>,
    /// Turns announced with `turn.started` whose `turn.completed` is not emitted yet. Every path
    /// that ends a turn claims it here first, so a turn ends exactly once.
    unsettled_turns: std::sync::Mutex<HashSet<String>>,
    events_tx: mpsc::UnboundedSender<CursorRuntimeEvent>,
    events_rx: Mutex<mpsc::UnboundedReceiver<CursorRuntimeEvent>>,
    event_counter: Mutex<u64>,
    pending_requests: Mutex<HashMap<String, PendingRequest>>,
    task: Mutex<Option<JoinHandle<()>>>,
    /// The stopped turn whose late messages are dropped before any handler runs.
    ignore_turn_output: Mutex<Option<String>>,
    /// When the CLI last sent anything, and whether the active turn shows the silence notice. One
    /// lock covers both and is held while the notice or its clearing is emitted, so a notice is
    /// never published after newer activity.
    silence: Mutex<SilenceClock>,
    silence_timeout: std::sync::Mutex<Duration>,
    cancel_grace: std::sync::Mutex<Duration>,
    prompt_write_timeout: std::sync::Mutex<Duration>,
    retired_write_settle: std::sync::Mutex<Duration>,
    /// Tool calls of the active turn Cursor reports `in_progress`: a long command is silent, not
    /// stalled.
    open_tool_calls: std::sync::Mutex<HashSet<String>>,
    /// Set once the process is retired (a stop's cancel went unanswered, or a prompt write
    /// blocked): the CLI may still run the old prompt, so this runtime takes nothing more and the
    /// driver stops the process.
    abandoned: AtomicBool,
    abandon: Notify,
}

struct SilenceClock {
    last_activity: tokio::time::Instant,
    notice_shown: bool,
}

#[derive(Clone)]
struct PendingRequest {
    wire_id: Value,
    turn_id: Option<String>,
    accept_option_id: Option<String>,
    accept_for_session_option_id: Option<String>,
    reject_option_id: Option<String>,
    kind: PendingRequestKind,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum PendingRequestKind {
    Permission,
    UserInput,
    CursorQuestion,
}

impl CursorSessionRuntime {
    pub fn new(
        options: CursorSessionOptions,
        connection: AcpJsonRpcConnection,
        incoming: mpsc::UnboundedReceiver<IncomingEvent>,
    ) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let runtime_mode = options.runtime_mode.clone();
        let interaction_mode = options.interaction_mode.clone();
        let inner = Arc::new(RuntimeInner {
            options,
            connection: Mutex::new(connection.clone()),
            provider_session_id: Mutex::new(None),
            config_options: Mutex::new(Vec::new()),
            baseline_config_options: Mutex::new(Vec::new()),
            default_model_config: Mutex::new(None),
            configuration_uncertain: Mutex::new(None),
            mode_state: Mutex::new(None),
            runtime_mode: Mutex::new(runtime_mode),
            interaction_mode: Mutex::new(interaction_mode),
            active_turn_id: Mutex::new(None),
            unsettled_turns: std::sync::Mutex::new(HashSet::new()),
            events_tx,
            events_rx: Mutex::new(events_rx),
            event_counter: Mutex::new(0),
            pending_requests: Mutex::new(HashMap::new()),
            task: Mutex::new(None),
            ignore_turn_output: Mutex::new(None),
            silence: Mutex::new(SilenceClock {
                last_activity: tokio::time::Instant::now(),
                notice_shown: false,
            }),
            silence_timeout: std::sync::Mutex::new(DEFAULT_SILENCE_TIMEOUT),
            cancel_grace: std::sync::Mutex::new(STOP_CANCEL_GRACE),
            prompt_write_timeout: std::sync::Mutex::new(PROMPT_WRITE_TIMEOUT),
            retired_write_settle: std::sync::Mutex::new(RETIRED_WRITE_SETTLE),
            open_tool_calls: std::sync::Mutex::new(HashSet::new()),
            abandoned: AtomicBool::new(false),
            abandon: Notify::new(),
        });
        let runtime = Self { inner };
        runtime.attach_incoming(connection, incoming);
        runtime
    }

    /// Replaces [`DEFAULT_SILENCE_TIMEOUT`] for the turns sent from now on.
    pub fn set_silence_timeout(&self, timeout: Duration) {
        *lock(&self.inner.silence_timeout) = timeout;
    }

    /// Replaces the stop grace and the prompt write deadline, for tests.
    pub fn set_stop_deadlines(&self, cancel_grace: Duration, prompt_write: Duration) {
        *lock(&self.inner.cancel_grace) = cancel_grace;
        *lock(&self.inner.prompt_write_timeout) = prompt_write;
    }

    /// Resolves once the process is retired; the driver then stops it.
    pub async fn abandoned(&self) {
        self.inner.abandon.notified().await;
    }

    /// Whether the process is retired: the session takes nothing more and must be launched again.
    pub fn is_retired(&self) -> bool {
        self.inner.abandoned.load(Ordering::SeqCst)
    }

    /// An update arrived: the silence clock starts again and a shown notice clears.
    async fn note_activity(&self) {
        let mut silence = self.inner.silence.lock().await;
        silence.last_activity = tokio::time::Instant::now();
        if std::mem::take(&mut silence.notice_shown) {
            let turn_id = self.inner.active_turn_id.lock().await.clone();
            self.emit("turn.notice", turn_id, None, json!({ "message": null }))
                .await;
        }
    }

    /// Shows a notice on the turn once it has gone the silence timeout without an update while
    /// waiting on neither the user nor a tool Cursor reports running. It never ends the turn.
    fn watch_silence(&self, turn_id: String) {
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                let runtime = Self { inner };
                if runtime.inner.active_turn_id.lock().await.as_deref() != Some(turn_id.as_str()) {
                    return;
                }
                let waiting = runtime
                    .inner
                    .pending_requests
                    .lock()
                    .await
                    .values()
                    .any(|pending| pending.turn_id.as_deref() == Some(turn_id.as_str()))
                    || !lock(&runtime.inner.open_tool_calls).is_empty();
                let timeout = *lock(&runtime.inner.silence_timeout);
                // Held through the publish: an update waits for it, then clears the notice.
                let mut silence = runtime.inner.silence.lock().await;
                if waiting {
                    silence.last_activity = tokio::time::Instant::now();
                }
                let quiet = silence.last_activity.elapsed();
                let pause = if quiet < timeout {
                    (timeout - quiet).min(Duration::from_secs(1))
                } else {
                    if !std::mem::replace(&mut silence.notice_shown, true) {
                        tracing::warn!(
                            provider = PROVIDER,
                            quiet_secs = timeout.as_secs(),
                            "Cursor sent no update for the silence timeout; showing a notice"
                        );
                        runtime
                            .emit(
                                "turn.notice",
                                Some(turn_id.clone()),
                                None,
                                json!({ "message": silence_message(timeout) }),
                            )
                            .await;
                    }
                    Duration::from_secs(1).min(timeout)
                };
                drop(silence);
                drop(runtime);
                tokio::time::sleep(pause).await;
            }
        });
    }

    pub async fn start(&self) -> Result<String, CursorRuntimeError> {
        self.emit("session.started", None, None, json!({})).await;
        let connection = self.inner.connection.lock().await.clone();
        connection
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                    "clientInfo": { "name": "bibcode-rust", "version": "0.1.1" },
                }),
            )
            .await?;
        connection
            .request("authenticate", json!({ "methodId": "cursor_login" }))
            .await?;
        let new_session = json!({
            "cwd": self.inner.options.cwd,
            "mcpServers": self.inner.options.mcp_servers,
        });
        let mut loaded_session_id = self.inner.options.resume_session_id.clone();
        let response = match loaded_session_id.clone() {
            Some(session_id) => {
                match connection
                    .request("session/load", json!({ "sessionId": session_id }))
                    .await
                {
                    Ok(response) => response,
                    // The saved session is gone, so loading it again cannot succeed. Any other
                    // provider error may be transient and must keep the saved id for the next try.
                    Err(AcpProtocolError::RemoteRequest { message, .. })
                        if session_load_is_permanently_gone(&message) =>
                    {
                        loaded_session_id = None;
                        connection.request("session/new", new_session).await?
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            None => connection.request("session/new", new_session).await?,
        };
        let session_id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or(loaded_session_id);
        let session_id = session_id.ok_or(CursorRuntimeError::MissingProviderSessionId)?;
        *self.inner.provider_session_id.lock().await = Some(session_id.clone());
        let config_options = response
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        *self.inner.default_model_config.lock().await =
            resolve_acp_default_model_config(&Value::Array(config_options.clone())).ok();
        *self.inner.config_options.lock().await = config_options.clone();
        *self.inner.baseline_config_options.lock().await = config_options;
        *self.inner.mode_state.lock().await = response.get("modes").cloned();
        let model = self.inner.options.model.trim();
        // No model selected is Cursor's Auto as well.
        if model.is_empty() || model.eq_ignore_ascii_case("default") {
            // Auto is Cursor's advertised default value; without one it stays Cursor's choice.
            let options = self.inner.config_options.lock().await.clone();
            if acp_model_descriptor(&options).is_some_and(|descriptor| {
                advertised_auto_model_value(descriptor)
                    .is_some_and(|auto| descriptor.get("currentValue") != Some(&auto))
            }) {
                self.set_model("default").await?;
            }
        } else {
            self.set_model(model).await?;
        }
        self.apply_mode().await?;
        self.emit("thread.started", None, None, json!({})).await;
        Ok(session_id)
    }

    pub async fn set_model(&self, model: &str) -> Result<(), CursorRuntimeError> {
        self.ensure_usable().await?;
        let (config_id, value) = if model.trim().eq_ignore_ascii_case("default") {
            self.inner
                .default_model_config
                .lock()
                .await
                .clone()
                .ok_or_else(|| {
                    CursorRuntimeError::UnsupportedOption(RefusedOption::new(
                        "Cursor session did not advertise a reversible default model selection",
                        default_model_unavailable_refusal(),
                    ))
                })?
        } else {
            let options = self.inner.config_options.lock().await.clone();
            let Some(descriptor) = acp_model_descriptor(&options) else {
                return Ok(());
            };
            let Some(config_id) = descriptor.get("id").and_then(Value::as_str) else {
                return Ok(());
            };
            let value = resolve_advertised_model_value(descriptor, model)
                .map_err(CursorRuntimeError::UnsupportedOption)?;
            (config_id.to_owned(), value)
        };
        let options = self
            .set_config_option(&self.provider_session_id().await?, &config_id, value)
            .await?;
        *self.inner.config_options.lock().await = options.clone();
        *self.inner.baseline_config_options.lock().await = options;
        Ok(())
    }

    pub async fn set_options(&self, options: Vec<Value>) -> Result<(), CursorRuntimeError> {
        self.ensure_usable().await?;
        let mut current = self.inner.config_options.lock().await.clone();
        if acp_model_values_are_bracketed(&current) {
            return self.set_bracketed_options(&current, options).await;
        }
        let baseline = self.inner.baseline_config_options.lock().await.clone();
        let updates = resolve_acp_config_updates_with_baseline(
            &Value::Array(current.clone()),
            &Value::Array(baseline),
            &Value::Array(options),
        )
        .map_err(CursorRuntimeError::UnsupportedOption)?;
        let session_id = self.provider_session_id().await?;
        let mut applied = Vec::new();
        for update in updates {
            let config_id = update["configId"]
                .as_str()
                .expect("resolved ACP config updates have a string config id");
            let previous_value =
                acp_config_option_current_value(&Value::Array(current.clone()), config_id)
                    .map_err(CursorRuntimeError::UnsupportedOption)?;
            match self
                .set_config_option(&session_id, config_id, update["value"].clone())
                .await
            {
                Ok(next) => {
                    applied.push((config_id.to_owned(), previous_value));
                    current = next;
                    *self.inner.config_options.lock().await = current.clone();
                }
                Err(error @ CursorRuntimeError::MalformedConfigAcknowledgement) => {
                    applied.push((config_id.to_owned(), previous_value));
                    let error = self
                        .compensate_config_updates(&session_id, &mut current, applied, error)
                        .await;
                    self.latch_failed_compensation(&error).await;
                    return Err(error);
                }
                Err(error) => {
                    let error = self
                        .compensate_config_updates(&session_id, &mut current, applied, error)
                        .await;
                    self.latch_failed_compensation(&error).await;
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    /// Options of a session that folds them into its model values: a switch to the advertised
    /// value of the current model that holds them, or a refusal before anything is sent.
    async fn set_bracketed_options(
        &self,
        current: &[Value],
        options: Vec<Value>,
    ) -> Result<(), CursorRuntimeError> {
        let descriptor = acp_model_descriptor(current)
            .expect("bracketed model values come from a model config option");
        let baseline = self.inner.baseline_config_options.lock().await.clone();
        let baseline = acp_model_descriptor(&baseline)
            .and_then(|descriptor| descriptor.get("currentValue"))
            .and_then(Value::as_str);
        let Some(value) =
            resolve_bracketed_model_options(descriptor, &Value::Array(options), baseline)
                .map_err(CursorRuntimeError::UnsupportedOption)?
        else {
            return Ok(());
        };
        let config_id = descriptor
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("model")
            .to_owned();
        let previous = descriptor
            .get("currentValue")
            .cloned()
            .unwrap_or(Value::Null);
        let session_id = self.provider_session_id().await?;
        match self.set_config_option(&session_id, &config_id, value).await {
            Ok(next) => {
                *self.inner.config_options.lock().await = next;
                Ok(())
            }
            // The switch may have applied: it is written back, and a failed write-back latches
            // the session as uncertain, so a restore cannot read the stale value as current.
            Err(error @ CursorRuntimeError::MalformedConfigAcknowledgement) => {
                let mut current = current.to_vec();
                let error = self
                    .compensate_config_updates(
                        &session_id,
                        &mut current,
                        vec![(config_id, previous)],
                        error,
                    )
                    .await;
                self.latch_failed_compensation(&error).await;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: Value,
    ) -> Result<Vec<Value>, CursorRuntimeError> {
        let connection = self.inner.connection.lock().await.clone();
        let response = connection
            .request(
                "session/set_config_option",
                json!({
                    "sessionId": session_id,
                    "configId": config_id,
                    "value": value,
                }),
            )
            .await?;
        response
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
            .ok_or(CursorRuntimeError::MalformedConfigAcknowledgement)
    }

    async fn compensate_config_updates(
        &self,
        session_id: &str,
        current: &mut Vec<Value>,
        applied: Vec<(String, Value)>,
        application: CursorRuntimeError,
    ) -> CursorRuntimeError {
        let application = application.to_string();
        for (config_id, value) in applied.into_iter().rev() {
            match self.set_config_option(session_id, &config_id, value).await {
                Ok(next) => {
                    *current = next;
                    *self.inner.config_options.lock().await = current.clone();
                }
                Err(compensation) => {
                    return CursorRuntimeError::ConfigCompensationFailed {
                        application,
                        compensation: compensation.to_string(),
                    };
                }
            }
        }
        CursorRuntimeError::ConfigUpdateRolledBack { application }
    }

    pub async fn set_runtime_mode(&self, mode: &str) -> Result<(), CursorRuntimeError> {
        self.ensure_usable().await?;
        *self.inner.runtime_mode.lock().await = mode.to_owned();
        self.apply_mode().await
    }

    pub async fn set_interaction_mode(&self, mode: &str) -> Result<(), CursorRuntimeError> {
        self.ensure_usable().await?;
        *self.inner.interaction_mode.lock().await = mode.to_owned();
        self.apply_mode().await
    }

    async fn apply_mode(&self) -> Result<(), CursorRuntimeError> {
        self.ensure_usable().await?;
        let mode_state = self.inner.mode_state.lock().await.clone();
        let runtime_mode = self.inner.runtime_mode.lock().await.clone();
        let interaction_mode = self.inner.interaction_mode.lock().await.clone();
        let Some(mode_id) = crate::provider::acp_mode::resolve_requested_mode_id(
            mode_state.as_ref(),
            &runtime_mode,
            &interaction_mode,
        ) else {
            return Ok(());
        };
        self.inner
            .connection
            .lock()
            .await
            .request(
                "session/set_mode",
                json!({
                    "sessionId": self.provider_session_id().await?,
                    "modeId": mode_id,
                }),
            )
            .await?;
        if let Some(state) = self.inner.mode_state.lock().await.as_mut() {
            state["currentModeId"] = Value::String(mode_id);
        }
        Ok(())
    }

    pub async fn send_turn(
        &self,
        input: Option<&str>,
        attachments: Vec<Value>,
    ) -> Result<String, CursorRuntimeError> {
        let (session_id, turn_id, connection, prompt) =
            self.prepare_prompt(input, attachments).await?;
        let completion =
            self.track_prompt_response(connection.clone(), turn_id.clone(), async move {
                connection
                    .request(
                        "session/prompt",
                        json!({
                            "sessionId": session_id,
                            "prompt": prompt,
                        }),
                    )
                    .await
            });
        drop(completion);
        Ok(turn_id)
    }

    #[allow(clippy::result_large_err)]
    pub async fn send_turn_with_receipt(
        &self,
        input: Option<&str>,
        attachments: Vec<Value>,
    ) -> Result<CursorPromptReceipt, CursorRuntimeError> {
        let (session_id, turn_id, connection, prompt) =
            self.prepare_prompt(input, attachments).await?;
        let mut request = match connection
            .start_request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": prompt,
                }),
            )
            .await
        {
            Ok(request) => request,
            Err(error) => return self.end_unsent_turn(turn_id, error).await,
        };
        let write_deadline = *lock(&self.inner.prompt_write_timeout);
        let written = match tokio::time::timeout(write_deadline, request.written()).await {
            Ok(written) => written,
            Err(_) => {
                // A CLI that stops reading its input holds the write forever. The process is
                // stopped, which fails the write with the count of bytes it took: none means
                // the prompt was never sent.
                tracing::warn!(
                    provider = PROVIDER,
                    "writing a prompt to Cursor blocked past its deadline; stopping its process"
                );
                self.retire();
                let settle = *lock(&self.inner.retired_write_settle);
                tokio::time::timeout(settle, request.written())
                    .await
                    .unwrap_or_else(|_| {
                        Err(AcpRequestWriteFailure::unconfirmed(
                            "Cursor did not take the prompt and its process was stopped",
                        ))
                    })
            }
        };
        let completion = match written {
            Ok(()) => self.track_prompt_response(connection, turn_id.clone(), request.response()),
            Err(failure) if failure.is_definitely_not_sent() => {
                return self.end_unsent_turn(turn_id, failure.into_error()).await;
            }
            Err(failure) => self.track_prompt_response(
                connection,
                turn_id.clone(),
                std::future::ready(Err(failure.into_error())),
            ),
        };
        Ok(CursorPromptReceipt {
            turn_id,
            completion,
        })
    }

    /// A prompt that never reached the CLI: its announced turn ends once, so every `turn.started`
    /// has its `turn.completed`. An unsent prompt fails and may be sent again. One the user
    /// stopped ends as cancelled and settles as delivered, so the stopped message is never sent
    /// again; an unanswered stop may already have ended it.
    async fn end_unsent_turn(
        &self,
        turn_id: String,
        error: AcpProtocolError,
    ) -> Result<CursorPromptReceipt, CursorRuntimeError> {
        let stopped =
            self.inner.ignore_turn_output.lock().await.as_deref() == Some(turn_id.as_str());
        if self.claim_turn(&turn_id, false).await {
            let payload = if stopped {
                json!({ "state": "cancelled", "stopReason": "cancelled" })
            } else {
                json!({
                    "state": "failed",
                    "stopReason": "error",
                    "errorMessage": error.to_string(),
                    "errorClass": acp_error_class(&error),
                })
            };
            self.emit("turn.completed", Some(turn_id.clone()), None, payload)
                .await;
            if !stopped {
                return Err(error.into());
            }
        }
        let (settled, completion) = oneshot::channel();
        let _ = settled.send(Ok(()));
        Ok(CursorPromptReceipt {
            turn_id,
            completion,
        })
    }

    /// Claims the end of `turn_id`. Of every path that can end a turn (its prompt's answer, a
    /// prompt that was never sent, a stop the CLI did not answer), only the one that gets `true`
    /// emits its `turn.completed` and settles its delivery. With `only_if_active`, a turn a newer
    /// one has replaced is not claimed.
    async fn claim_turn(&self, turn_id: &str, only_if_active: bool) -> bool {
        let mut active = self.inner.active_turn_id.lock().await;
        let is_active = active.as_deref() == Some(turn_id);
        if (only_if_active && !is_active) || !lock(&self.inner.unsettled_turns).remove(turn_id) {
            return false;
        }
        if is_active {
            *active = None;
        }
        true
    }

    async fn prepare_prompt(
        &self,
        input: Option<&str>,
        attachments: Vec<Value>,
    ) -> Result<(String, String, AcpJsonRpcConnection, Vec<Value>), CursorRuntimeError> {
        self.ensure_usable().await?;
        let session_id = self.provider_session_id().await?;
        let turn_id = format!("turn-{}", Uuid::new_v4());
        *self.inner.active_turn_id.lock().await = Some(turn_id.clone());
        *self.inner.ignore_turn_output.lock().await = None;
        lock(&self.inner.unsettled_turns).insert(turn_id.clone());
        lock(&self.inner.open_tool_calls).clear();
        *self.inner.silence.lock().await = SilenceClock {
            last_activity: tokio::time::Instant::now(),
            notice_shown: false,
        };
        self.emit(
            "turn.started",
            Some(turn_id.clone()),
            None,
            json!({ "model": self.inner.options.model }),
        )
        .await;
        // Armed when the turn is announced, so a prompt write that blocks is silent too.
        self.watch_silence(turn_id.clone());
        let connection = self.inner.connection.lock().await.clone();
        let prompt = crate::provider::attachments::prompt_parts(input, attachments);
        Ok((session_id, turn_id, connection, prompt))
    }

    /// Refuses every prompt and setting once the process is retired, or while the session's
    /// configuration is uncertain.
    async fn ensure_usable(&self) -> Result<(), CursorRuntimeError> {
        if self.inner.abandoned.load(Ordering::SeqCst) {
            return Err(AcpProtocolError::Closed {
                reason: "Cursor stopped responding and its process was stopped".to_owned(),
            }
            .into());
        }
        self.inner
            .configuration_uncertain
            .lock()
            .await
            .clone()
            .map_or(Ok(()), |detail| {
                Err(CursorRuntimeError::ConfigurationUncertain { detail })
            })
    }

    async fn latch_failed_compensation(&self, error: &CursorRuntimeError) {
        if matches!(error, CursorRuntimeError::ConfigCompensationFailed { .. }) {
            *self.inner.configuration_uncertain.lock().await = Some(error.to_string());
        }
    }

    fn track_prompt_response<F>(
        &self,
        connection: AcpJsonRpcConnection,
        background_turn_id: String,
        response: F,
    ) -> oneshot::Receiver<Result<(), CursorRuntimeError>>
    where
        F: Future<Output = Result<Value, AcpProtocolError>> + Send + 'static,
    {
        let runtime = self.clone();
        let (completion_tx, completion) = oneshot::channel();
        tokio::spawn(async move {
            let result = response.await;
            // The response resolves on the reader task, while the chunks the agent wrote before
            // it may still wait in the incoming queue. Handle them first, so they keep this turn
            // and come before its `turn.completed`.
            let _ = connection.barrier().await;
            // A turn already ended, by a stop the CLI did not answer: its prompt was written, so
            // the delivery stays accepted, and the answer ends nothing twice.
            if !runtime.claim_turn(&background_turn_id, false).await {
                let _ = completion_tx.send(Ok(()));
                return;
            }
            match result {
                Ok(response) => {
                    let stop_reason = response
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("end_turn");
                    let (state, failure_message) = acp_turn_state(stop_reason);
                    let mut payload = json!({
                        "state": state,
                        "stopReason": stop_reason,
                    });
                    if let Some(message) = failure_message {
                        payload["errorMessage"] = json!(message);
                    }
                    runtime
                        .emit("turn.completed", Some(background_turn_id), None, payload)
                        .await;
                    let _ = completion_tx.send(Ok(()));
                }
                Err(error) => {
                    let detail = error.to_string();
                    // Attribute from the variant, not the flattened string: a
                    // JSON-RPC error is the agent's, a broken pipe is ours.
                    let class = acp_error_class(&error);
                    runtime
                        .emit(
                            "turn.completed",
                            Some(background_turn_id),
                            None,
                            json!({
                                "state": "failed",
                                "stopReason": "error",
                                "errorMessage": detail,
                                "errorClass": class,
                            }),
                        )
                        .await;
                    let _ = completion_tx.send(Err(error.into()));
                }
            }
        });
        completion
    }

    /// Latches the retirement before anything else, so no next prompt or setting reaches a CLI
    /// that may still run the old prompt, and asks the driver to stop the process.
    fn retire(&self) {
        self.inner.abandoned.store(true, Ordering::SeqCst);
        self.inner.abandon.notify_one();
    }

    /// Ends a stopped turn whose cancel the CLI did not answer within the grace: the turn ends
    /// once, as cancelled, and the process is retired.
    async fn end_unanswered_stop(&self, turn_id: String) {
        if !self.claim_turn(&turn_id, true).await {
            return;
        }
        tracing::warn!(
            provider = PROVIDER,
            "Cursor did not answer the cancel of a stopped turn; stopping its process"
        );
        lock(&self.inner.open_tool_calls).clear();
        // Retired before the turn ends, so the next message never reaches this process.
        self.inner.abandoned.store(true, Ordering::SeqCst);
        self.emit(
            "turn.completed",
            Some(turn_id),
            None,
            json!({ "state": "cancelled", "stopReason": "cancelled" }),
        )
        .await;
        self.inner.abandon.notify_one();
    }

    pub async fn interrupt_turn(&self) -> Result<(), CursorRuntimeError> {
        let Some(turn_id) = self.inner.active_turn_id.lock().await.clone() else {
            return Ok(());
        };
        *self.inner.ignore_turn_output.lock().await = Some(turn_id.clone());
        // The turn's output is ignored from here on, so its tool calls never report closing.
        lock(&self.inner.open_tool_calls).clear();
        let pending_ids = self
            .inner
            .pending_requests
            .lock()
            .await
            .iter()
            .filter_map(|(request_id, pending)| {
                (pending.turn_id.as_deref() == Some(turn_id.as_str())).then_some(request_id.clone())
            })
            .collect::<Vec<_>>();
        for request_id in pending_ids {
            let _ = self.respond_to_request(&request_id, "cancel").await;
        }
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .notify(
                "session/cancel",
                json!({ "sessionId": self.provider_session_id().await? }),
            )
            .await?;
        let runtime = self.clone();
        let grace = *lock(&self.inner.cancel_grace);
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            runtime.end_unanswered_stop(turn_id).await;
        });
        Ok(())
    }

    pub async fn respond_to_request(
        &self,
        request_id: &str,
        decision: &str,
    ) -> Result<(), CursorRuntimeError> {
        let pending = self
            .inner
            .pending_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| CursorRuntimeError::PendingRequestNotFound {
                request_id: request_id.to_owned(),
            })?;
        let result = match pending.kind {
            PendingRequestKind::Permission => {
                let outcome = match decision {
                    "acceptForSession" => pending
                        .accept_for_session_option_id
                        .or(pending.accept_option_id)
                        .map(|option_id| json!({ "outcome": "selected", "optionId": option_id }))
                        .unwrap_or_else(|| json!({ "outcome": "cancelled" })),
                    "accept" => pending
                        .accept_option_id
                        .map(|option_id| json!({ "outcome": "selected", "optionId": option_id }))
                        .unwrap_or_else(|| json!({ "outcome": "cancelled" })),
                    "decline" => pending
                        .reject_option_id
                        .map(|option_id| json!({ "outcome": "selected", "optionId": option_id }))
                        .unwrap_or_else(|| json!({ "outcome": "cancelled" })),
                    _ => json!({ "outcome": "cancelled" }),
                };
                json!({ "outcome": outcome })
            }
            PendingRequestKind::UserInput | PendingRequestKind::CursorQuestion => {
                json!({ "outcome": "cancelled" })
            }
        };
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .respond(pending.wire_id, result)
            .await?;
        self.emit(
            "request.resolved",
            pending.turn_id.clone(),
            Some(request_id.to_owned()),
            json!({
                "requestType": "exec_command_approval",
                "decision": decision,
            }),
        )
        .await;
        Ok(())
    }

    pub async fn respond_to_user_input(
        &self,
        request_id: &str,
        answers: Value,
    ) -> Result<(), CursorRuntimeError> {
        let pending = self
            .inner
            .pending_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| CursorRuntimeError::PendingRequestNotFound {
                request_id: request_id.to_owned(),
            })?;
        let response = if pending.kind == PendingRequestKind::CursorQuestion {
            json!({ "answers": answers })
        } else {
            let mut normalized = serde_json::Map::new();
            let answer_map = answers.as_object().cloned().unwrap_or_default();
            for (key, value) in answer_map {
                let values = match value {
                    Value::String(string) => vec![Value::String(string)],
                    Value::Array(array) => array,
                    _ => Vec::new(),
                };
                normalized.insert(key, Value::Array(values));
            }
            json!({
                "outcome": "accepted",
                "answers": normalized,
            })
        };
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .respond(pending.wire_id, response)
            .await?;
        self.emit(
            "user-input.resolved",
            pending.turn_id,
            Some(request_id.to_owned()),
            json!({ "answers": answers }),
        )
        .await;
        Ok(())
    }

    pub async fn next_event(&self) -> Option<CursorRuntimeEvent> {
        self.inner.events_rx.lock().await.recv().await
    }

    pub async fn collect_events(&self, expected: usize) -> Vec<CursorRuntimeEventStableView> {
        let mut events = Vec::with_capacity(expected);
        while events.len() < expected {
            let Some(event) = self.next_event().await else {
                break;
            };
            events.push(event.stable_view());
        }
        events
    }

    fn attach_incoming(
        &self,
        connection: AcpJsonRpcConnection,
        mut incoming: mpsc::UnboundedReceiver<IncomingEvent>,
    ) {
        let runtime = self.clone();
        let request_scope = RequestScope::new();
        let task = tokio::spawn(async move {
            while let Some(event) = incoming.recv().await {
                runtime
                    .handle_incoming(connection.clone(), request_scope, event)
                    .await;
            }
        });
        tokio::spawn({
            let inner = self.inner.clone();
            async move {
                if let Some(previous) = inner.task.lock().await.replace(task) {
                    previous.abort();
                }
            }
        });
    }

    async fn handle_incoming(
        &self,
        connection: AcpJsonRpcConnection,
        request_scope: RequestScope,
        event: IncomingEvent,
    ) {
        // The one gate for a stopped turn's late messages, before any handler runs: none is
        // projected, none opens an approval or question, none is approved. Held across the
        // handler, so a stop cannot land between this check and a request being recorded.
        let ignored = self.inner.ignore_turn_output.lock().await;
        // A retired process's messages are late too: it is being stopped.
        let late = self.is_retired()
            || match ignored.as_deref() {
                Some(ignored) => {
                    let active = self.inner.active_turn_id.lock().await;
                    active.is_none() || active.as_deref() == Some(ignored)
                }
                None => false,
            };
        match event {
            IncomingEvent::Notification { .. } if late => {
                tracing::debug!(
                    provider = PROVIDER,
                    "dropped a stopped turn's late notification"
                );
            }
            IncomingEvent::Request {
                wire_id, method, ..
            } if late => {
                if let Err(error) = refuse_late_request(&connection, wire_id, &method).await {
                    tracing::warn!(provider = PROVIDER, %error, "could not refuse a late request");
                }
            }
            IncomingEvent::Notification { method, params } => {
                self.note_activity().await;
                self.handle_notification(method, params).await;
            }
            IncomingEvent::Request {
                correlation_id,
                wire_id,
                method,
                params,
            } => {
                self.note_activity().await;
                if let Err(error) = self
                    .handle_request(
                        connection,
                        request_scope,
                        correlation_id,
                        wire_id,
                        method,
                        params,
                    )
                    .await
                {
                    self.emit(
                        "runtime.error",
                        None,
                        None,
                        json!({ "message": error.to_string() }),
                    )
                    .await;
                }
            }
            IncomingEvent::Stderr { message } => {
                self.emit("runtime.warning", None, None, json!({ "message": message }))
                    .await;
            }
            IncomingEvent::Closed { reason } => {
                self.emit("session.exited", None, None, json!({ "reason": reason }))
                    .await;
            }
            IncomingEvent::Barrier(reached) => {
                let _ = reached.send(());
            }
        }
    }

    async fn handle_notification(&self, method: String, params: Value) {
        if method == "cursor/update_todos" {
            let entries = params
                .get("todos")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|todo| {
                    let step = todo
                        .get("content")
                        .or_else(|| todo.get("title"))
                        .and_then(Value::as_str)?
                        .trim();
                    if step.is_empty() {
                        return None;
                    }
                    let status = match todo.get("status").and_then(Value::as_str) {
                        Some("completed") => "completed",
                        Some("in_progress" | "inProgress") => "inProgress",
                        _ => "pending",
                    };
                    Some(json!({ "step": step, "status": status }))
                })
                .collect::<Vec<_>>();
            self.emit(
                "turn.plan.updated",
                self.inner.active_turn_id.lock().await.clone(),
                None,
                json!({ "entries": entries }),
            )
            .await;
            return;
        }
        if method != "session/update" {
            tracing::debug!(
                provider = PROVIDER,
                %method,
                "dropped an unhandled ACP notification"
            );
            return;
        }
        let turn_id = self.inner.active_turn_id.lock().await.clone();
        match params
            .get("update")
            .and_then(|value| value.get("sessionUpdate"))
            .and_then(Value::as_str)
        {
            Some("tool_call") | Some("tool_call_update") => {
                let update = params.get("update").cloned().unwrap_or(Value::Null);
                let tool_call_id = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("tool-call");
                let detail = update
                    .get("rawInput")
                    .and_then(|value| value.get("command"))
                    .and_then(Value::as_array)
                    .map(|command| {
                        command
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .filter(|detail| !detail.is_empty())
                    .or_else(|| {
                        update
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_default();
                let status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                // Only a call Cursor reports running pauses the silence clock; a pending,
                // finished or unknown status does not. An update without a status leaves it.
                let reported = update.get("status").and_then(Value::as_str).or_else(|| {
                    (update.get("sessionUpdate").and_then(Value::as_str) == Some("tool_call"))
                        .then_some("pending")
                });
                {
                    let mut open = lock(&self.inner.open_tool_calls);
                    match reported {
                        Some("in_progress") => {
                            open.insert(tool_call_id.to_owned());
                        }
                        Some(_) => {
                            open.remove(tool_call_id);
                        }
                        None => {}
                    }
                }
                let event_type = if status == "completed" {
                    "item.completed"
                } else {
                    "item.updated"
                };
                self.emit(
                    event_type,
                    turn_id.clone(),
                    None,
                    json!({
                        "itemType": "command_execution",
                        "itemId": tool_call_id,
                        "status": if status == "completed" { "completed" } else { "inProgress" },
                        "detail": detail,
                    }),
                )
                .await;
            }
            Some("agent_message_chunk") => {
                let delta = params
                    .get("update")
                    .and_then(|value| value.get("content"))
                    .and_then(|value| value.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.emit(
                    "content.delta",
                    turn_id,
                    None,
                    json!({
                        "streamKind": "assistant_text",
                        "delta": delta,
                    }),
                )
                .await;
            }
            Some("plan") => {
                self.emit(
                    "turn.plan.updated",
                    turn_id,
                    None,
                    json!({
                        "entries": params.get("update").and_then(|value| value.get("entries")).cloned().unwrap_or(Value::Array(Vec::new())),
                    }),
                )
                .await;
            }
            unhandled => {
                // The last silent drop in the ACP path: unhandled
                // `sessionUpdate` variants. Variant name only — the update body
                // carries conversation content.
                tracing::debug!(
                    provider = PROVIDER,
                    session_update = unhandled.unwrap_or("<absent>"),
                    "dropped an unhandled ACP session update"
                );
            }
        }
    }

    async fn handle_request(
        &self,
        connection: AcpJsonRpcConnection,
        request_scope: RequestScope,
        correlation_id: String,
        wire_id: Value,
        method: String,
        params: Value,
    ) -> Result<(), CursorRuntimeError> {
        match method.as_str() {
            "cursor/ask_question" => {
                let request_id = request_scope.user_input_id(&correlation_id);
                let turn_id = self.inner.active_turn_id.lock().await.clone();
                let questions = params
                    .get("questions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|question| {
                        let options = question
                            .get("options")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default()
                            .into_iter()
                            .map(|option| {
                                let label = option
                                    .get("label")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default();
                                json!({ "label": label, "description": label })
                            })
                            .collect::<Vec<_>>();
                        json!({
                            "id": question.get("id").cloned().unwrap_or(Value::String(String::new())),
                            "header": "Question",
                            "question": question.get("prompt").cloned().unwrap_or(Value::String(String::new())),
                            "multiSelect": question.get("allowMultiple").and_then(Value::as_bool).unwrap_or(false),
                            "options": if options.is_empty() {
                                vec![json!({ "label": "OK", "description": "Continue" })]
                            } else {
                                options
                            },
                        })
                    })
                    .collect::<Vec<_>>();
                self.inner.pending_requests.lock().await.insert(
                    request_id.clone(),
                    PendingRequest {
                        wire_id,
                        turn_id: turn_id.clone(),
                        accept_option_id: None,
                        accept_for_session_option_id: None,
                        reject_option_id: None,
                        kind: PendingRequestKind::CursorQuestion,
                    },
                );
                self.emit(
                    "user-input.requested",
                    turn_id,
                    Some(request_id),
                    json!({ "questions": questions }),
                )
                .await;
                Ok(())
            }
            "cursor/create_plan" => {
                let turn_id = self.inner.active_turn_id.lock().await.clone();
                let plan = params
                    .get("plan")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("# Plan\n\n(Cursor did not supply plan text.)");
                self.emit(
                    "turn.proposed.completed",
                    turn_id,
                    None,
                    json!({ "planMarkdown": plan }),
                )
                .await;
                connection
                    .respond(wire_id, json!({ "accepted": true }))
                    .await?;
                Ok(())
            }
            "session/request_permission" => {
                let request_id = request_scope.approval_id(&correlation_id);
                let turn_id = self.inner.active_turn_id.lock().await.clone();
                let options = params
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if self.inner.runtime_mode.lock().await.as_str() == "full-access"
                    && let Some(option_id) =
                        crate::provider::acp_mode::auto_approved_option_id(&options)
                {
                    connection
                        .respond(
                            wire_id,
                            json!({
                                "outcome": {
                                    "outcome": "selected",
                                    "optionId": option_id,
                                }
                            }),
                        )
                        .await?;
                    return Ok(());
                }
                self.inner.pending_requests.lock().await.insert(
                    request_id.clone(),
                    PendingRequest {
                        wire_id,
                        turn_id: turn_id.clone(),
                        accept_option_id: find_option_id(&options, "allow_once"),
                        accept_for_session_option_id: find_option_id(&options, "allow_always"),
                        reject_option_id: find_option_id(&options, "reject_once"),
                        kind: PendingRequestKind::Permission,
                    },
                );
                let detail = params
                    .get("toolCall")
                    .and_then(|value| value.get("title"))
                    .and_then(Value::as_str)
                    .map(|value| value.trim_matches('`').to_owned())
                    .unwrap_or_default();
                self.emit(
                    "request.opened",
                    turn_id,
                    Some(request_id),
                    json!({
                        "requestType": "exec_command_approval",
                        "detail": detail,
                    }),
                )
                .await;
                Ok(())
            }
            "_x.ai/ask_user_question" | "x.ai/ask_user_question" => {
                let request_id = request_scope.user_input_id(&correlation_id);
                let turn_id = self.inner.active_turn_id.lock().await.clone();
                let questions = params
                    .get("params")
                    .and_then(|value| value.get("questions"))
                    .or_else(|| params.get("questions"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.inner.pending_requests.lock().await.insert(
                    request_id.clone(),
                    PendingRequest {
                        wire_id,
                        turn_id: turn_id.clone(),
                        accept_option_id: None,
                        accept_for_session_option_id: None,
                        reject_option_id: None,
                        kind: PendingRequestKind::UserInput,
                    },
                );
                self.emit(
                    "user-input.requested",
                    turn_id,
                    Some(request_id),
                    json!({
                        "questions": questions.into_iter().map(|question| {
                            json!({
                                "id": question.get("id").cloned().unwrap_or_else(|| question.get("question").cloned().unwrap_or(Value::String(String::new()))),
                                "header": question.get("question").cloned().unwrap_or(Value::String(String::new())),
                                "question": question.get("question").cloned().unwrap_or(Value::String(String::new())),
                                "options": question.get("options").cloned().unwrap_or(Value::Array(Vec::new())),
                            })
                        }).collect::<Vec<_>>(),
                    }),
                )
                .await;
                Ok(())
            }
            _ => {
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
                Ok(())
            }
        }
    }

    async fn emit(
        &self,
        event_type: &str,
        turn_id: Option<String>,
        request_id: Option<String>,
        payload: Value,
    ) {
        let mut counter = self.inner.event_counter.lock().await;
        *counter += 1;
        let _ = self.inner.events_tx.send(CursorRuntimeEvent {
            event_id: format!("evt-{}", *counter),
            provider: PROVIDER.to_owned(),
            created_at: FIXED_EVENT_TIME.to_owned(),
            event_type: event_type.to_owned(),
            thread_id: self.inner.options.thread_id.clone(),
            turn_id,
            item_id: None,
            request_id,
            payload,
        });
    }

    async fn provider_session_id(&self) -> Result<String, CursorRuntimeError> {
        self.inner
            .provider_session_id
            .lock()
            .await
            .clone()
            .ok_or(CursorRuntimeError::MissingProviderSessionId)
    }
}

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The notice a running Cursor turn shows after the silence timeout without an update.
fn silence_message(timeout: Duration) -> String {
    let quiet = match timeout.as_secs() {
        seconds if seconds >= 120 => format!("{} minutes", seconds / 60),
        seconds => format!("{seconds} seconds"),
    };
    format!(
        "Cursor has sent nothing for {quiet}. It may be waiting for you to sign in to Cursor in \
         your browser; otherwise stop the turn if it seems stuck."
    )
}

/// A stopped turn's late request gets the refusal a cancel gives, never an approval: a
/// permission or question is `cancelled` and a plan is not accepted.
async fn refuse_late_request(
    connection: &AcpJsonRpcConnection,
    wire_id: Value,
    method: &str,
) -> Result<(), AcpProtocolError> {
    let refusal = match method {
        "session/request_permission" => json!({ "outcome": { "outcome": "cancelled" } }),
        "cursor/ask_question" | "_x.ai/ask_user_question" | "x.ai/ask_user_question" => {
            json!({ "outcome": "cancelled" })
        }
        "cursor/create_plan" => json!({ "accepted": false }),
        _ => {
            return connection
                .respond_error(
                    wire_id,
                    JsonRpcErrorShape {
                        code: -32601,
                        message: format!("Method not found: {method}"),
                        data: None,
                    },
                )
                .await;
        }
    };
    connection.respond(wire_id, refusal).await
}

fn find_option_id(options: &[Value], kind: &str) -> Option<String> {
    options.iter().find_map(|option| {
        (option.get("kind").and_then(Value::as_str) == Some(kind))
            .then(|| {
                option
                    .get("optionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::cursor::{AcpConnectionConfig, AcpJsonRpcConnection};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, duplex};
    use tokio::time::{Duration, timeout};

    fn delivery_runtime(
        provider_session_id: Option<&str>,
    ) -> (
        CursorSessionRuntime,
        Lines<BufReader<DuplexStream>>,
        DuplexStream,
    ) {
        let (stdout, stdout_peer) = duplex(4096);
        let (stdin_peer, stdin) = duplex(4096);
        let (stderr, _stderr_peer) = duplex(4096);
        let (connection, incoming) =
            AcpJsonRpcConnection::spawn(stdout, stdin, stderr, AcpConnectionConfig::default());
        let runtime = CursorSessionRuntime::new(
            CursorSessionOptions {
                thread_id: "cursor-delivery-thread".to_owned(),
                cwd: "/workspace".to_owned(),
                runtime_mode: "full-access".to_owned(),
                interaction_mode: "default".to_owned(),
                model: "default".to_owned(),
                resume_session_id: None,
                mcp_servers: Vec::new(),
            },
            connection,
            incoming,
        );
        if let Some(provider_session_id) = provider_session_id {
            runtime
                .inner
                .provider_session_id
                .try_lock()
                .expect("fresh provider session lock")
                .replace(provider_session_id.to_owned());
        }
        (runtime, BufReader::new(stdin_peer).lines(), stdout_peer)
    }

    #[tokio::test]
    async fn delivery_without_a_provider_session_fails_before_writing_a_request() {
        let (runtime, mut requests, _responses) = delivery_runtime(None);

        let error = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect_err("a missing session must fail before request creation");

        assert!(matches!(
            error,
            CursorRuntimeError::MissingProviderSessionId
        ));
        assert!(
            timeout(Duration::from_millis(100), requests.next_line())
                .await
                .is_err(),
            "a definite pre-write failure must emit no provider bytes"
        );
    }

    #[tokio::test]
    async fn delivery_receipt_accepts_only_after_the_session_prompt_response() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        let request: Value = serde_json::from_str(
            &requests
                .next_line()
                .await
                .expect("request read")
                .expect("session prompt request"),
        )
        .expect("valid JSON-RPC request");
        assert_eq!(request["method"], "session/prompt");
        let mut completion = Box::pin(receipt.completion());
        assert!(
            timeout(Duration::from_millis(100), completion.as_mut())
                .await
                .is_err(),
            "request write alone must not accept delivery"
        );
        responses
            .write_all(
                format!(
                    "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{{\"stopReason\":\"end_turn\"}}}}\n",
                    request["id"]
                )
                .as_bytes(),
            )
            .await
            .expect("prompt response write");
        assert!(
            timeout(Duration::from_secs(2), completion)
                .await
                .expect("prompt response should resolve receipt")
                .is_ok()
        );
    }

    #[tokio::test]
    async fn delivery_receipt_reports_disconnect_after_request_write() {
        let (runtime, mut requests, responses) = delivery_runtime(Some("cursor-session"));
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        let request = requests
            .next_line()
            .await
            .expect("request read")
            .expect("session prompt request");
        assert!(request.contains("\"method\":\"session/prompt\""));

        drop(responses);

        assert!(
            timeout(Duration::from_secs(2), receipt.completion())
                .await
                .expect("connection loss should resolve receipt")
                .is_err()
        );
    }

    #[tokio::test]
    async fn chunks_read_before_the_prompt_response_belong_to_the_turn_and_precede_its_completion()
    {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        let request: Value = serde_json::from_str(
            &requests
                .next_line()
                .await
                .expect("request read")
                .expect("session prompt request"),
        )
        .expect("valid JSON-RPC request");
        // Holding the event counter parks the incoming handler on the first chunk, so the
        // prompt response is routed while the second chunk still waits in the queue.
        let held = runtime.inner.event_counter.lock().await;
        let chunk = |text: &str| {
            format!(
                "{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{{\"sessionId\":\"cursor-session\",\"update\":{{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{{\"type\":\"text\",\"text\":\"{text}\"}}}}}}}}\n"
            )
        };
        responses
            .write_all(
                format!(
                    "{}{}{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{{\"stopReason\":\"end_turn\"}}}}\n",
                    chunk("first"),
                    chunk("second"),
                    request["id"]
                )
                .as_bytes(),
            )
            .await
            .expect("provider output write");
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(held);
        let events = timeout(Duration::from_secs(2), runtime.collect_events(4))
            .await
            .expect("four events");
        let seen: Vec<(&str, Option<&str>, Option<&str>)> = events
            .iter()
            .map(|event| {
                (
                    event.event_type.as_str(),
                    event.turn_id.as_deref(),
                    event.payload["delta"].as_str(),
                )
            })
            .collect();
        let turn = Some(receipt.turn_id.as_str());
        assert_eq!(
            seen,
            [
                ("turn.started", turn, None),
                ("content.delta", turn, Some("first")),
                ("content.delta", turn, Some("second")),
                ("turn.completed", turn, None),
            ]
        );
    }

    async fn read_request(requests: &mut Lines<BufReader<DuplexStream>>) -> Value {
        let line = timeout(Duration::from_secs(5), requests.next_line())
            .await
            .expect("request in time")
            .expect("request read")
            .expect("request line");
        serde_json::from_str(&line).expect("valid JSON-RPC message")
    }

    async fn write_frame(responses: &mut DuplexStream, frame: Value) {
        responses
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .expect("provider output write");
    }

    fn session_update(kind: &str) -> Value {
        json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": { "sessionId": "cursor-session", "update": { "sessionUpdate": kind } }
        })
    }

    fn tool_update(kind: &str, status: &str) -> Value {
        json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": { "sessionId": "cursor-session", "update": {
                "sessionUpdate": kind, "toolCallId": "tool-1", "status": status
            } }
        })
    }

    async fn next_of(runtime: &CursorSessionRuntime, wanted: &str) -> CursorRuntimeEvent {
        timeout(Duration::from_secs(5), async {
            loop {
                let event = runtime.next_event().await.expect("event");
                if event.event_type == wanted {
                    return event;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no {wanted} event"))
    }

    /// The measured stall: one `session_info_update`, then nothing. The turn shows a notice and
    /// keeps running, nothing is cancelled, and the next update clears the notice.
    #[tokio::test]
    async fn a_silent_turn_shows_a_notice_keeps_running_and_clears_it_on_the_next_update() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_silence_timeout(Duration::from_millis(300));
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        let prompt = read_request(&mut requests).await;
        write_frame(&mut responses, session_update("session_info_update")).await;

        let events = timeout(Duration::from_secs(5), runtime.collect_events(2))
            .await
            .expect("two events");
        assert_eq!(events[0].event_type, "turn.started");
        assert_eq!(events[1].event_type, "turn.notice");
        assert_eq!(events[1].turn_id.as_deref(), Some(receipt.turn_id.as_str()));
        assert_eq!(
            events[1].payload["message"],
            "Cursor has sent nothing for 0 seconds. It may be waiting for you to sign in to Cursor in your browser; otherwise stop the turn if it seems stuck."
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            timeout(Duration::from_millis(50), requests.next_line())
                .await
                .is_err(),
            "nothing, a cancel included, is sent"
        );
        write_frame(&mut responses, session_update("agent_message_chunk")).await;
        let events = timeout(Duration::from_secs(2), runtime.collect_events(2))
            .await
            .expect("cleared, then the update");
        assert_eq!(events[0].event_type, "turn.notice");
        assert!(events[0].payload["message"].is_null());
        assert_eq!(events[1].event_type, "content.delta");
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": { "stopReason": "end_turn" } }),
        )
        .await;
        timeout(Duration::from_secs(2), receipt.completion())
            .await
            .expect("answered")
            .expect("accepted");
        let completed = next_of(&runtime, "turn.completed").await;
        assert_eq!(completed.payload["state"], "completed");
    }

    /// A tool call that is only pending, or that ended in any status, leaves the clock running;
    /// only one Cursor reports `in_progress` pauses it.
    #[tokio::test]
    async fn only_a_running_tool_call_pauses_the_silence_clock() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_silence_timeout(Duration::from_millis(300));
        let _receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        read_request(&mut requests).await;
        write_frame(&mut responses, tool_update("tool_call", "pending")).await;
        assert!(
            next_of(&runtime, "turn.notice").await.payload["message"].is_string(),
            "a pending call does not pause the clock"
        );
        write_frame(
            &mut responses,
            tool_update("tool_call_update", "in_progress"),
        )
        .await;
        assert!(next_of(&runtime, "turn.notice").await.payload["message"].is_null());
        next_of(&runtime, "item.updated").await;
        assert!(
            timeout(Duration::from_millis(800), next_of(&runtime, "turn.notice"))
                .await
                .is_err(),
            "a running call pauses the clock"
        );
        write_frame(&mut responses, tool_update("tool_call_update", "cancelled")).await;
        assert!(
            next_of(&runtime, "turn.notice").await.payload["message"].is_string(),
            "an ended call, in any status, no longer pauses the clock"
        );
    }

    /// After Stop, every late message of the turn stops at one gate: no update is projected, no
    /// approval or question opens, nothing is approved, and a plan is not accepted.
    #[tokio::test]
    async fn a_stopped_turns_late_messages_are_dropped_or_refused() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        let prompt = read_request(&mut requests).await;
        assert_eq!(
            next_of(&runtime, "turn.started").await.turn_id.as_deref(),
            Some(receipt.turn_id.as_str())
        );
        runtime.interrupt_turn().await.expect("stop");
        assert_eq!(
            read_request(&mut requests).await["method"],
            "session/cancel"
        );

        async fn late(responses: &mut DuplexStream) {
            let frames = [
                session_update("agent_message_chunk"),
                json!({ "jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": "cursor-session",
                    "update": { "sessionUpdate": "plan", "entries": [{ "content": "x" }] } } }),
                json!({ "jsonrpc": "2.0", "method": "cursor/update_todos", "params": {
                    "todos": [{ "content": "late", "status": "pending" }] } }),
                tool_update("tool_call", "in_progress"),
                json!({ "jsonrpc": "2.0", "id": 81, "method": "session/request_permission",
                    "params": { "options": [{ "optionId": "yes", "kind": "allow_once" }] } }),
                json!({ "jsonrpc": "2.0", "id": 82, "method": "cursor/ask_question",
                    "params": { "questions": [{ "id": "q", "prompt": "Which?" }] } }),
                json!({ "jsonrpc": "2.0", "id": 83, "method": "cursor/create_plan",
                    "params": { "plan": "# Late" } }),
            ];
            let text = frames
                .iter()
                .map(|frame| format!("{frame}\n"))
                .collect::<String>();
            responses
                .write_all(text.as_bytes())
                .await
                .expect("late write");
        }
        late(&mut responses).await;
        let mut answers = Vec::new();
        for _ in 0..3 {
            let answer = read_request(&mut requests).await;
            answers.push((answer["id"].clone(), answer["result"].clone()));
        }
        assert_eq!(
            answers,
            [
                (json!(81), json!({ "outcome": { "outcome": "cancelled" } })),
                (json!(82), json!({ "outcome": "cancelled" })),
                (json!(83), json!({ "accepted": false })),
            ]
        );
        // The prompt's own answer still ends the turn once, as cancelled.
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": { "stopReason": "cancelled" } }),
        )
        .await;
        let completed = timeout(Duration::from_secs(2), runtime.next_event())
            .await
            .expect("an event")
            .expect("event");
        assert_eq!(completed.event_type, "turn.completed", "{completed:?}");
        assert_eq!(completed.payload["state"], "cancelled");
        // After its end, the stopped turn's messages are still dropped or refused.
        late(&mut responses).await;
        for _ in 0..3 {
            read_request(&mut requests).await;
        }
        assert!(
            timeout(Duration::from_millis(300), runtime.next_event())
                .await
                .is_err(),
            "nothing of the stopped turn was projected"
        );
    }

    /// A stop whose cancel the CLI ignores: after the grace the turn ends once, as cancelled, the
    /// runtime is retired so the driver stops the process, and it takes no further prompt.
    #[tokio::test]
    async fn an_unanswered_stop_retires_the_runtime_before_any_next_prompt() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_stop_deadlines(Duration::from_millis(300), PROMPT_WRITE_TIMEOUT);
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        assert_eq!(
            read_request(&mut requests).await["method"],
            "session/prompt"
        );
        runtime.interrupt_turn().await.expect("stop");
        assert_eq!(
            read_request(&mut requests).await["method"],
            "session/cancel"
        );
        timeout(Duration::from_secs(5), runtime.abandoned())
            .await
            .expect("the unanswered cancel retires the runtime");
        assert!(runtime.is_retired());
        let events = timeout(Duration::from_secs(2), runtime.collect_events(2))
            .await
            .expect("the turn's events");
        assert_eq!(events[1].event_type, "turn.completed");
        assert_eq!(events[1].payload["state"], "cancelled");

        write_frame(&mut responses, session_update("agent_message_chunk")).await;
        let refused = runtime
            .send_turn_with_receipt(Some("again"), Vec::new())
            .await
            .expect_err("a retired runtime takes no prompt");
        assert!(
            matches!(refused, CursorRuntimeError::Protocol(_)),
            "{refused}"
        );
        assert!(
            timeout(Duration::from_millis(200), requests.next_line())
                .await
                .is_err(),
            "nothing was written after the retirement"
        );
        // The stopped process closes the connection: the prompt's failed answer ends nothing twice.
        drop(responses);
        timeout(Duration::from_secs(2), receipt.completion())
            .await
            .expect("resolved")
            .expect("the written prompt stays accepted");
        let rest = timeout(Duration::from_secs(1), runtime.collect_events(1)).await;
        assert!(
            rest.as_ref().is_ok_and(|rest| rest
                .iter()
                .all(|event| event.event_type == "session.exited")),
            "{rest:?}"
        );
    }

    /// A CLI that stops reading its input: the prompt write is bounded, the process is retired,
    /// and a prompt it may have partly read is reported as possibly delivered, not unsent.
    #[tokio::test]
    async fn a_blocked_prompt_write_retires_the_runtime_and_keeps_a_partial_write_ambiguous() {
        let (runtime, requests, _responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_stop_deadlines(STOP_CANCEL_GRACE, Duration::from_millis(200));
        let send = tokio::spawn({
            let runtime = runtime.clone();
            async move {
                runtime
                    .send_turn_with_receipt(Some(&"x".repeat(64 * 1024)), Vec::new())
                    .await
            }
        });
        timeout(Duration::from_secs(5), runtime.abandoned())
            .await
            .expect("the blocked write retires the runtime");
        // The driver stops the process, which closes its input.
        drop(requests);
        let receipt = timeout(Duration::from_secs(5), send)
            .await
            .expect("the send ends")
            .unwrap()
            .expect("part of the prompt was written");
        let outcome = timeout(Duration::from_secs(2), receipt.completion())
            .await
            .expect("resolved");
        // The writer's own count of the partial write, not the closed connection's answer.
        assert!(
            matches!(
                outcome,
                Err(CursorRuntimeError::Protocol(
                    AcpProtocolError::WriteFailure { .. }
                ))
            ),
            "{outcome:?}"
        );
        let completed = next_of(&runtime, "turn.completed").await;
        assert_eq!(completed.payload["state"], "failed");
    }

    /// Fills the CLI's 4096-byte input exactly, so the next write takes no byte until it closes.
    async fn fill_cli_input(runtime: &CursorSessionRuntime) {
        let frame =
            serde_json::to_vec(&json!({ "jsonrpc": "2.0", "method": "fill", "params": "" }))
                .expect("frame")
                .len()
                + 1;
        runtime
            .inner
            .connection
            .lock()
            .await
            .clone()
            .notify("fill", json!("x".repeat(4096 - frame)))
            .await
            .expect("filler queued");
    }

    /// Fails when another `turn.completed` arrives soon.
    async fn assert_no_second_completion(runtime: &CursorSessionRuntime) {
        let more = timeout(Duration::from_millis(300), async {
            loop {
                let event = runtime.next_event().await;
                if event
                    .as_ref()
                    .is_none_or(|event| event.event_type == "turn.completed")
                {
                    return event;
                }
            }
        })
        .await;
        assert!(more.is_err(), "the turn ended twice: {more:?}");
    }

    /// A blocked write that took no byte before the stopped process closed the CLI's input was
    /// never sent, so it may be sent again.
    #[tokio::test]
    async fn a_prompt_write_blocked_before_its_first_byte_is_definitely_not_sent() {
        let (runtime, requests, _responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_stop_deadlines(STOP_CANCEL_GRACE, Duration::from_millis(200));
        fill_cli_input(&runtime).await;
        let send = tokio::spawn({
            let runtime = runtime.clone();
            async move {
                runtime
                    .send_turn_with_receipt(Some("hello"), Vec::new())
                    .await
            }
        });
        timeout(Duration::from_secs(5), runtime.abandoned())
            .await
            .expect("the blocked write retires the runtime");
        drop(requests);
        let error = timeout(Duration::from_secs(5), send)
            .await
            .expect("the send ends")
            .unwrap()
            .expect_err("nothing of the prompt was written");
        assert!(
            matches!(
                error,
                CursorRuntimeError::Protocol(AcpProtocolError::WriteFailure { .. })
            ),
            "{error:?}"
        );
        let completed = next_of(&runtime, "turn.completed").await;
        assert_eq!(completed.payload["state"], "failed");
        assert_no_second_completion(&runtime).await;
    }

    /// A stopped process that does not fail the blocked write within the settle leaves it
    /// unconfirmed: possibly delivered, never sent again on its own.
    #[tokio::test]
    async fn a_blocked_prompt_write_that_never_settles_is_unconfirmed() {
        let (runtime, _requests, _responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_stop_deadlines(STOP_CANCEL_GRACE, Duration::from_millis(200));
        *lock(&runtime.inner.retired_write_settle) = Duration::from_millis(200);
        let receipt = timeout(
            Duration::from_secs(5),
            runtime.send_turn_with_receipt(Some(&"x".repeat(64 * 1024)), Vec::new()),
        )
        .await
        .expect("the settle bounds the send")
        .expect("part of the prompt may have been read");
        assert!(runtime.is_retired());
        let outcome = timeout(Duration::from_secs(2), receipt.completion())
            .await
            .expect("resolved");
        assert!(
            matches!(
                &outcome,
                Err(CursorRuntimeError::Protocol(AcpProtocolError::WriteFailure { message }))
                    if message.contains("did not take the prompt")
            ),
            "{outcome:?}"
        );
        let completed = next_of(&runtime, "turn.completed").await;
        assert_eq!(completed.payload["state"], "failed");
    }

    async fn stop_a_blocked_prompt(
        cancel_grace: Duration,
        prompt_write: Duration,
    ) -> (CursorSessionRuntime, Result<(), CursorRuntimeError>) {
        let (runtime, requests, _responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_stop_deadlines(cancel_grace, prompt_write);
        fill_cli_input(&runtime).await;
        let send = tokio::spawn({
            let runtime = runtime.clone();
            async move {
                runtime
                    .send_turn_with_receipt(Some("hello"), Vec::new())
                    .await
            }
        });
        next_of(&runtime, "turn.started").await;
        runtime.interrupt_turn().await.expect("stop");
        timeout(Duration::from_secs(5), runtime.abandoned())
            .await
            .expect("the runtime is retired");
        // The driver stops the process: the blocked write fails with nothing sent.
        drop(requests);
        let receipt = timeout(Duration::from_secs(5), send)
            .await
            .expect("the send ends")
            .unwrap()
            .expect("a stopped prompt settles; it is not reported unsent");
        let outcome = timeout(Duration::from_secs(2), receipt.completion())
            .await
            .expect("resolved");
        (runtime, outcome)
    }

    /// Stop while the prompt write blocks: the unanswered stop ends the turn once, as cancelled,
    /// and the prompt the user stopped settles as delivered, so it is never sent again.
    #[tokio::test]
    async fn a_stop_during_a_blocked_prompt_write_ends_the_turn_once_and_never_resends() {
        let (runtime, outcome) =
            stop_a_blocked_prompt(Duration::from_millis(200), PROMPT_WRITE_TIMEOUT).await;
        outcome.expect("settled, so the stopped prompt is not sent again");
        let completed = next_of(&runtime, "turn.completed").await;
        assert_eq!(completed.payload["state"], "cancelled");
        assert_no_second_completion(&runtime).await;
    }

    /// The same when the write deadline retires the process before the stop's grace ends.
    #[tokio::test]
    async fn a_stopped_prompt_whose_write_fails_before_the_grace_ends_settles_as_cancelled() {
        let (runtime, outcome) =
            stop_a_blocked_prompt(STOP_CANCEL_GRACE, Duration::from_millis(500)).await;
        outcome.expect("settled, so the stopped prompt is not sent again");
        let completed = next_of(&runtime, "turn.completed").await;
        assert_eq!(completed.payload["state"], "cancelled");
        assert_no_second_completion(&runtime).await;
    }

    /// The prompt's answer waits on the barrier while the stop's grace expires: the turn still
    /// ends once.
    #[tokio::test]
    async fn a_prompt_answer_and_an_expired_stop_end_the_turn_once() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_stop_deadlines(Duration::from_millis(300), PROMPT_WRITE_TIMEOUT);
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        let prompt = read_request(&mut requests).await;
        runtime.interrupt_turn().await.expect("stop");
        assert_eq!(
            read_request(&mut requests).await["method"],
            "session/cancel"
        );
        // Every incoming event takes this lock first, so the answer's barrier waits on it.
        let held = runtime.inner.ignore_turn_output.lock().await;
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": { "stopReason": "cancelled" } }),
        )
        .await;
        timeout(Duration::from_secs(5), runtime.abandoned())
            .await
            .expect("the stop's grace expired");
        drop(held);
        timeout(Duration::from_secs(2), receipt.completion())
            .await
            .expect("resolved")
            .expect("the written prompt stays accepted");
        let completed = next_of(&runtime, "turn.completed").await;
        assert_eq!(completed.payload["state"], "cancelled");
        assert_no_second_completion(&runtime).await;
    }

    /// A retired runtime takes no setting either: the next message launches Cursor again.
    #[tokio::test]
    async fn a_retired_runtime_refuses_every_setting() {
        let (runtime, mut requests, _responses) = delivery_runtime(Some("cursor-session"));
        runtime.retire();
        let refusals = [
            runtime.set_model("m").await,
            runtime.set_options(Vec::new()).await,
            runtime.set_runtime_mode("approval-required").await,
            runtime.set_interaction_mode("plan").await,
        ];
        for refused in refusals {
            assert!(
                matches!(
                    refused,
                    Err(CursorRuntimeError::Protocol(
                        AcpProtocolError::Closed { .. }
                    ))
                ),
                "{refused:?}"
            );
        }
        assert_eq!(*runtime.inner.runtime_mode.lock().await, "full-access");
        assert!(
            timeout(Duration::from_millis(100), requests.next_line())
                .await
                .is_err(),
            "nothing was written"
        );
    }

    /// A turn that keeps sending updates, or waits on the user or a running tool, is never cut
    /// off, however long it runs.
    #[tokio::test]
    async fn a_turn_that_keeps_reporting_or_waits_on_the_user_is_not_cut_off() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_silence_timeout(Duration::from_millis(300));
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        let prompt = read_request(&mut requests).await;
        for _ in 0..6 {
            write_frame(&mut responses, session_update("agent_thought_chunk")).await;
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        // A tool call in progress, then a question to the user, each silent past the deadline.
        write_frame(
            &mut responses,
            json!({
                "jsonrpc": "2.0", "method": "session/update",
                "params": { "sessionId": "cursor-session", "update": {
                    "sessionUpdate": "tool_call", "toolCallId": "tool-1", "status": "in_progress"
                } }
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(700)).await;
        write_frame(
            &mut responses,
            json!({
                "jsonrpc": "2.0", "method": "session/update",
                "params": { "sessionId": "cursor-session", "update": {
                    "sessionUpdate": "tool_call_update", "toolCallId": "tool-1", "status": "completed"
                } }
            }),
        )
        .await;
        write_frame(
            &mut responses,
            json!({
                "jsonrpc": "2.0", "id": 77, "method": "cursor/ask_question",
                "params": { "questions": [{ "id": "q1", "prompt": "Which file?" }] }
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(
            timeout(Duration::from_millis(50), requests.next_line())
                .await
                .is_err(),
            "nothing, a cancel included, was sent while the turn reported or waited"
        );
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": { "stopReason": "end_turn" } }),
        )
        .await;
        timeout(Duration::from_secs(2), receipt.completion())
            .await
            .expect("answered")
            .expect("accepted");
        let completed = timeout(Duration::from_secs(2), async {
            loop {
                let event = runtime.next_event().await.expect("event");
                assert_ne!(
                    event.event_type, "turn.notice",
                    "no notice while reporting or waiting"
                );
                if event.event_type == "turn.completed" {
                    return event;
                }
            }
        })
        .await
        .expect("the turn completed");
        assert_eq!(completed.payload["state"], "completed");
    }

    fn bracketed_options(current: &str) -> Vec<Value> {
        vec![json!({
            "id": "model", "category": "model", "type": "select", "currentValue": current,
            "options": [
                { "value": "m[reasoning=medium,fast=false]" },
                { "value": "m[reasoning=high,fast=false]" },
                { "value": "m[reasoning=high,fast=true]" }
            ]
        })]
    }

    async fn bracketed_runtime() -> (
        CursorSessionRuntime,
        Lines<BufReader<DuplexStream>>,
        DuplexStream,
    ) {
        let (runtime, requests, responses) = delivery_runtime(Some("cursor-session"));
        let baseline = bracketed_options("m[reasoning=medium,fast=false]");
        *runtime.inner.config_options.lock().await = baseline.clone();
        *runtime.inner.baseline_config_options.lock().await = baseline;
        (runtime, requests, responses)
    }

    /// Clearing a bracketed session's options goes back to the model's baseline value, as a
    /// session with separate options does.
    #[tokio::test]
    async fn cleared_bracketed_options_return_to_the_models_baseline() {
        let (runtime, mut requests, mut responses) = bracketed_runtime().await;
        let set = tokio::spawn({
            let runtime = runtime.clone();
            async move {
                runtime
                    .set_options(vec![json!({ "id": "reasoning", "value": "high" })])
                    .await
            }
        });
        let write = read_request(&mut requests).await;
        assert_eq!(write["params"]["value"], "m[reasoning=high,fast=false]");
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": write["id"], "result": {
                "configOptions": bracketed_options("m[reasoning=high,fast=false]")
            } }),
        )
        .await;
        set.await.unwrap().expect("high applied");

        let clear = tokio::spawn({
            let runtime = runtime.clone();
            async move { runtime.set_options(Vec::new()).await }
        });
        let write = read_request(&mut requests).await;
        assert_eq!(write["params"]["value"], "m[reasoning=medium,fast=false]");
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": write["id"], "result": {
                "configOptions": bracketed_options("m[reasoning=medium,fast=false]")
            } }),
        )
        .await;
        clear.await.unwrap().expect("baseline restored");
    }

    /// An option switch answered without its options may have applied: it is written back, so
    /// the runtime's view and the CLI agree before the error reaches the supervisor.
    #[tokio::test]
    async fn a_bracketed_switch_answered_without_options_is_rolled_back() {
        let (runtime, mut requests, mut responses) = bracketed_runtime().await;
        let set = tokio::spawn({
            let runtime = runtime.clone();
            async move {
                runtime
                    .set_options(vec![json!({ "id": "reasoning", "value": "high" })])
                    .await
            }
        });
        let write = read_request(&mut requests).await;
        assert_eq!(write["params"]["value"], "m[reasoning=high,fast=false]");
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": write["id"], "result": {} }),
        )
        .await;
        let rollback = read_request(&mut requests).await;
        assert_eq!(
            rollback["params"]["value"],
            "m[reasoning=medium,fast=false]"
        );
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": rollback["id"], "result": {
                "configOptions": bracketed_options("m[reasoning=medium,fast=false]")
            } }),
        )
        .await;
        let error = set.await.unwrap().expect_err("the switch failed");
        assert!(
            matches!(error, CursorRuntimeError::ConfigUpdateRolledBack { .. }),
            "{error:?}"
        );
    }

    #[test]
    fn only_a_missing_session_load_error_abandons_the_saved_session() {
        assert!(session_load_is_permanently_gone("Session not found"));
        assert!(session_load_is_permanently_gone(
            "The conversation does not exist"
        ));
        assert!(!session_load_is_permanently_gone("Internal error"));
        assert!(!session_load_is_permanently_gone("rate limit exceeded"));
        assert!(!session_load_is_permanently_gone(
            "Unknown error while loading session"
        ));
        assert!(!session_load_is_permanently_gone("model not found"));
    }
}
