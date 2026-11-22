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
        AcpJsonRpcConnection, AcpProtocolError, IncomingEvent, JsonRpcErrorShape, acp_error_class,
        acp_turn_state,
    },
    model::{
        acp_config_option_current_value, acp_model_descriptor, acp_model_values_are_bracketed,
        resolve_acp_config_updates_with_baseline, resolve_acp_default_model_config,
        resolve_advertised_model_value, resolve_bracketed_model_options,
    },
};

const PROVIDER: &str = "cursor";

/// How long a Cursor turn may go without any update before BiBCode ends it. A turn that streams
/// text, thoughts or tool progress is never cut off, nor one that waits on the user or a running
/// tool. Five minutes is far longer than Cursor takes to send its first update, so only a stalled
/// CLI reaches it, and short enough that the user is not left with a pending turn indefinitely.
pub const DEFAULT_SILENCE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// How long a silent turn's cancelled prompt may take to be answered before the turn ends anyway.
const SILENCE_CANCEL_GRACE: Duration = Duration::from_secs(10);
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
    events_tx: mpsc::UnboundedSender<CursorRuntimeEvent>,
    events_rx: Mutex<mpsc::UnboundedReceiver<CursorRuntimeEvent>>,
    event_counter: Mutex<u64>,
    pending_requests: Mutex<HashMap<String, PendingRequest>>,
    task: Mutex<Option<JoinHandle<()>>>,
    ignore_turn_output: Mutex<Option<String>>,
    /// When the CLI last sent anything; a turn silent past `silence_timeout` is ended.
    last_activity: std::sync::Mutex<tokio::time::Instant>,
    silence_timeout: std::sync::Mutex<Duration>,
    /// Tool calls of the active turn still running: a long command is silent, not stalled.
    open_tool_calls: std::sync::Mutex<HashSet<String>>,
    /// Set once a silent turn's cancel went unanswered: the CLI may still run that prompt, so
    /// this runtime takes no further prompt and the driver stops the process.
    abandoned: AtomicBool,
    abandon: Notify,
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
            events_tx,
            events_rx: Mutex::new(events_rx),
            event_counter: Mutex::new(0),
            pending_requests: Mutex::new(HashMap::new()),
            task: Mutex::new(None),
            ignore_turn_output: Mutex::new(None),
            last_activity: std::sync::Mutex::new(tokio::time::Instant::now()),
            silence_timeout: std::sync::Mutex::new(DEFAULT_SILENCE_TIMEOUT),
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

    /// Resolves once a silent turn's cancel went unanswered; the driver then stops the process.
    pub async fn abandoned(&self) {
        self.inner.abandon.notified().await;
    }

    fn note_activity(&self) {
        *lock(&self.inner.last_activity) = tokio::time::Instant::now();
    }

    /// Resolves once the active turn has gone the silence timeout without an update while
    /// waiting on neither the user nor a running tool.
    async fn silence(&self, turn_id: &str) {
        loop {
            let waiting = self
                .inner
                .pending_requests
                .lock()
                .await
                .values()
                .any(|pending| pending.turn_id.as_deref() == Some(turn_id))
                || !lock(&self.inner.open_tool_calls).is_empty();
            if waiting {
                self.note_activity();
            }
            let timeout = *lock(&self.inner.silence_timeout);
            let quiet = lock(&self.inner.last_activity).elapsed();
            if quiet >= timeout {
                return;
            }
            tokio::time::sleep((timeout - quiet).min(Duration::from_secs(1))).await;
        }
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
        if !self.inner.options.model.trim().is_empty()
            && !self
                .inner
                .options
                .model
                .trim()
                .eq_ignore_ascii_case("default")
        {
            self.set_model(&self.inner.options.model).await?;
        }
        self.apply_mode().await?;
        self.emit("thread.started", None, None, json!({})).await;
        Ok(session_id)
    }

    pub async fn set_model(&self, model: &str) -> Result<(), CursorRuntimeError> {
        self.ensure_configuration_certain().await?;
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
            // An option listing no values leaves nothing to check the model against.
            let value = resolve_advertised_model_value(descriptor, model)
                .map_err(CursorRuntimeError::UnsupportedOption)?
                .unwrap_or_else(|| json!(model));
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
        self.ensure_configuration_certain().await?;
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
        let Some(value) = resolve_bracketed_model_options(descriptor, &Value::Array(options))
            .map_err(CursorRuntimeError::UnsupportedOption)?
        else {
            return Ok(());
        };
        let config_id = descriptor
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("model")
            .to_owned();
        let next = self
            .set_config_option(&self.provider_session_id().await?, &config_id, value)
            .await?;
        *self.inner.config_options.lock().await = next;
        Ok(())
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
        self.ensure_configuration_certain().await?;
        *self.inner.runtime_mode.lock().await = mode.to_owned();
        self.apply_mode().await
    }

    pub async fn set_interaction_mode(&self, mode: &str) -> Result<(), CursorRuntimeError> {
        self.ensure_configuration_certain().await?;
        *self.inner.interaction_mode.lock().await = mode.to_owned();
        self.apply_mode().await
    }

    async fn apply_mode(&self) -> Result<(), CursorRuntimeError> {
        self.ensure_configuration_certain().await?;
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
            Err(error) => return Err(self.end_unsent_turn(turn_id, error).await),
        };
        let completion = match request.written().await {
            Ok(()) => self.track_prompt_response(connection, turn_id.clone(), request.response()),
            Err(failure) if failure.is_definitely_not_sent() => {
                return Err(self.end_unsent_turn(turn_id, failure.into_error()).await);
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

    /// A prompt that never reached the CLI: its announced turn is no longer active and ends once,
    /// as failed, so every `turn.started` has its `turn.completed`.
    async fn end_unsent_turn(
        &self,
        turn_id: String,
        error: AcpProtocolError,
    ) -> CursorRuntimeError {
        if self.inner.active_turn_id.lock().await.as_deref() == Some(turn_id.as_str()) {
            *self.inner.active_turn_id.lock().await = None;
        }
        self.emit(
            "turn.completed",
            Some(turn_id),
            None,
            json!({
                "state": "failed",
                "stopReason": "error",
                "errorMessage": error.to_string(),
                "errorClass": acp_error_class(&error),
            }),
        )
        .await;
        error.into()
    }

    async fn prepare_prompt(
        &self,
        input: Option<&str>,
        attachments: Vec<Value>,
    ) -> Result<(String, String, AcpJsonRpcConnection, Vec<Value>), CursorRuntimeError> {
        if self.inner.abandoned.load(Ordering::SeqCst) {
            return Err(AcpProtocolError::Closed {
                reason: "Cursor stopped responding and its process was stopped".to_owned(),
            }
            .into());
        }
        self.ensure_configuration_certain().await?;
        let session_id = self.provider_session_id().await?;
        let turn_id = format!("turn-{}", Uuid::new_v4());
        *self.inner.active_turn_id.lock().await = Some(turn_id.clone());
        *self.inner.ignore_turn_output.lock().await = None;
        lock(&self.inner.open_tool_calls).clear();
        self.note_activity();
        self.emit(
            "turn.started",
            Some(turn_id.clone()),
            None,
            json!({ "model": self.inner.options.model }),
        )
        .await;
        let connection = self.inner.connection.lock().await.clone();
        let prompt = crate::provider::attachments::prompt_parts(input, attachments);
        Ok((session_id, turn_id, connection, prompt))
    }

    async fn ensure_configuration_certain(&self) -> Result<(), CursorRuntimeError> {
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
            let mut response = std::pin::pin!(response);
            let result = tokio::select! {
                result = &mut response => Some(result),
                () = runtime.silence(&background_turn_id) => None,
            };
            let Some(result) = result else {
                runtime
                    .end_silent_turn(&connection, background_turn_id, response)
                    .await;
                let _ = completion_tx.send(Ok(()));
                return;
            };
            // The response resolves on the reader task, while the chunks the agent wrote before
            // it may still wait in the incoming queue. Handle them first, so they keep this turn
            // and come before its `turn.completed`.
            let _ = connection.barrier().await;
            if runtime.inner.active_turn_id.lock().await.as_deref()
                == Some(background_turn_id.as_str())
            {
                *runtime.inner.active_turn_id.lock().await = None;
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

    /// Ends a turn the CLI stopped answering: cancels its prompt as Stop does, gives the answer
    /// a short grace, and ends the turn once as failed with a message the user can act on. The
    /// prompt was written, so its delivery stays accepted; the session takes the next turn.
    async fn end_silent_turn<F>(
        &self,
        connection: &AcpJsonRpcConnection,
        turn_id: String,
        response: std::pin::Pin<&mut F>,
    ) where
        F: Future<Output = Result<Value, AcpProtocolError>>,
    {
        let timeout = *lock(&self.inner.silence_timeout);
        tracing::warn!(
            provider = PROVIDER,
            quiet_secs = timeout.as_secs(),
            "Cursor sent no update for the silence timeout; ending the turn"
        );
        if let Err(error) = self.interrupt_turn().await {
            tracing::warn!(provider = PROVIDER, %error, "could not cancel a silent Cursor turn");
        }
        let answered = tokio::time::timeout(SILENCE_CANCEL_GRACE.min(timeout), response)
            .await
            .is_ok();
        if !answered {
            // Latched before the turn ends, so no next prompt reaches a CLI still running this one.
            self.inner.abandoned.store(true, Ordering::SeqCst);
        }
        let _ = connection.barrier().await;
        if self.inner.active_turn_id.lock().await.as_deref() == Some(turn_id.as_str()) {
            *self.inner.active_turn_id.lock().await = None;
        }
        lock(&self.inner.open_tool_calls).clear();
        self.emit(
            "turn.completed",
            Some(turn_id),
            None,
            json!({
                "state": "failed",
                "stopReason": "error",
                "errorMessage": silence_message(timeout),
                "errorClass": "provider_error",
            }),
        )
        .await;
        if !answered {
            tracing::warn!(
                provider = PROVIDER,
                "Cursor did not answer the cancel of a silent turn; stopping its process"
            );
            self.inner.abandon.notify_one();
        }
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
        match event {
            IncomingEvent::Notification { method, params } => {
                self.note_activity();
                self.handle_notification(method, params).await;
            }
            IncomingEvent::Request {
                correlation_id,
                wire_id,
                method,
                params,
            } => {
                self.note_activity();
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
        // A cancelled turn's late output, before or after its end, joins no turn.
        if let Some(ignored_turn_id) = self.inner.ignore_turn_output.lock().await.clone()
            && (turn_id.is_none() || turn_id.as_deref() == Some(ignored_turn_id.as_str()))
        {
            return;
        }
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
                // An update without a status leaves the call as it was; a new call is pending.
                let reported = update.get("status").and_then(Value::as_str).or_else(|| {
                    (update.get("sessionUpdate").and_then(Value::as_str) == Some("tool_call"))
                        .then_some("pending")
                });
                {
                    let mut open = lock(&self.inner.open_tool_calls);
                    match reported {
                        Some("completed" | "failed") => {
                            open.remove(tool_call_id);
                        }
                        Some(_) => {
                            open.insert(tool_call_id.to_owned());
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

/// What the user sees when a Cursor turn ends for want of any update.
fn silence_message(timeout: Duration) -> String {
    let quiet = match timeout.as_secs() {
        seconds if seconds >= 120 => format!("{} minutes", seconds / 60),
        seconds => format!("{seconds} seconds"),
    };
    format!(
        "Cursor stopped responding: no update for {quiet}. Send the message again, or check \
         that the Cursor CLI is signed in and working."
    )
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

    /// The measured stall: one `session_info_update`, then nothing. The turn ends once with an
    /// actionable message, the prompt is cancelled on the CLI, and the next turn still works.
    #[tokio::test]
    async fn a_silent_turn_ends_with_a_message_and_leaves_the_session_usable() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_silence_timeout(Duration::from_millis(300));
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        let prompt = read_request(&mut requests).await;
        assert_eq!(prompt["method"], "session/prompt");
        write_frame(&mut responses, session_update("session_info_update")).await;

        let cancel = read_request(&mut requests).await;
        assert_eq!(cancel["method"], "session/cancel");
        assert_eq!(cancel["params"]["sessionId"], "cursor-session");
        // The CLI answers the cancel within the grace; output it sends meanwhile joins no turn.
        write_frame(&mut responses, session_update("agent_message_chunk")).await;
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": { "stopReason": "cancelled" } }),
        )
        .await;
        // The prompt was written, so the delivery is accepted, never retried.
        timeout(Duration::from_secs(5), receipt.completion())
            .await
            .expect("the deadline resolves the receipt")
            .expect("accepted");
        let events = timeout(Duration::from_secs(2), runtime.collect_events(2))
            .await
            .expect("two events");
        assert_eq!(events[0].event_type, "turn.started");
        assert_eq!(events[1].event_type, "turn.completed");
        assert_eq!(events[1].payload["state"], "failed");
        assert!(
            events[1].payload["errorMessage"]
                .as_str()
                .is_some_and(|message| message.starts_with("Cursor stopped responding")),
            "{:?}",
            events[1].payload
        );
        let next = runtime
            .send_turn_with_receipt(Some("again"), Vec::new())
            .await
            .expect("the session takes the next prompt");
        let prompt = read_request(&mut requests).await;
        assert_eq!(prompt["method"], "session/prompt");
        write_frame(
            &mut responses,
            json!({ "jsonrpc": "2.0", "id": prompt["id"], "result": { "stopReason": "end_turn" } }),
        )
        .await;
        timeout(Duration::from_secs(2), next.completion())
            .await
            .expect("answered")
            .expect("accepted");
        let events = timeout(Duration::from_secs(2), runtime.collect_events(2))
            .await
            .expect("the next turn's events");
        assert_eq!(
            events
                .iter()
                .map(|event| (event.event_type.as_str(), event.payload["state"].as_str()))
                .collect::<Vec<_>>(),
            [
                ("turn.started", None),
                ("turn.completed", Some("completed"))
            ]
        );
    }

    /// A CLI that ignores the cancel too: after the grace the turn still ends once, the runtime
    /// asks the driver to stop the process, and takes no further prompt, so nothing the old
    /// prompt still produces can reach a next turn.
    #[tokio::test]
    async fn an_unanswered_cancel_abandons_the_runtime_before_any_next_prompt() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_silence_timeout(Duration::from_millis(300));
        let receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        assert_eq!(
            read_request(&mut requests).await["method"],
            "session/prompt"
        );
        assert_eq!(
            read_request(&mut requests).await["method"],
            "session/cancel"
        );
        timeout(Duration::from_secs(5), runtime.abandoned())
            .await
            .expect("the unanswered cancel abandons the runtime");
        timeout(Duration::from_secs(2), receipt.completion())
            .await
            .expect("resolved")
            .expect("accepted");
        let events = timeout(Duration::from_secs(2), runtime.collect_events(2))
            .await
            .expect("the turn's events");
        assert_eq!(events[1].event_type, "turn.completed");
        assert_eq!(events[1].payload["state"], "failed");

        // Output the old prompt still sends joins no turn, and no next prompt is written.
        write_frame(&mut responses, session_update("agent_message_chunk")).await;
        let refused = runtime
            .send_turn_with_receipt(Some("again"), Vec::new())
            .await
            .expect_err("an abandoned runtime takes no prompt");
        assert!(
            matches!(refused, CursorRuntimeError::Protocol(_)),
            "{refused}"
        );
        assert!(
            timeout(Duration::from_millis(200), requests.next_line())
                .await
                .is_err(),
            "nothing was written after the abandon"
        );
        assert!(
            timeout(Duration::from_millis(200), runtime.next_event())
                .await
                .is_err(),
            "no turn.started and no output after the abandon"
        );
    }

    /// Stop during a running tool call keeps the silence deadline armed: a CLI that ignores the
    /// cancel still gets its turn ended.
    #[tokio::test]
    async fn stop_during_a_running_tool_call_keeps_the_deadline() {
        let (runtime, mut requests, mut responses) = delivery_runtime(Some("cursor-session"));
        runtime.set_silence_timeout(Duration::from_millis(300));
        let _receipt = runtime
            .send_turn_with_receipt(Some("hello"), Vec::new())
            .await
            .expect("session prompt should write");
        assert_eq!(
            read_request(&mut requests).await["method"],
            "session/prompt"
        );
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
        tokio::time::sleep(Duration::from_millis(100)).await;
        runtime.interrupt_turn().await.expect("stop");
        assert_eq!(
            read_request(&mut requests).await["method"],
            "session/cancel"
        );
        // The deadline's own cancel follows, though the tool call never reported closing.
        assert_eq!(
            read_request(&mut requests).await["method"],
            "session/cancel"
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
                if event.event_type == "turn.completed" {
                    return event;
                }
            }
        })
        .await
        .expect("the turn completed");
        assert_eq!(completed.payload["state"], "completed");
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
