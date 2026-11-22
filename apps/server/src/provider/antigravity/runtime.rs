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
    acp_turn_state,
};
use crate::provider::{
    OptionRefusal, RefusedOption, RequestScope, model_unavailable_refusal,
    option_needs_value_refusal, option_without_id_refusal, unsupported_option_refusal,
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

/// How long the handshake and session open may take. A live open answered in a few seconds.
pub const DEFAULT_START_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct AntigravitySessionOptions {
    pub thread_id: String,
    pub cwd: String,
    pub runtime_mode: String,
    pub interaction_mode: String,
    pub model: Option<String>,
    pub resume_session_id: Option<String>,
    pub cancel_grace: Duration,
    /// Bounds the whole start, so a silent or wedged CLI cannot hold the launch forever.
    pub start_timeout: Duration,
}

#[derive(Clone, Debug)]
pub struct AntigravityRuntimeEvent {
    pub event_type: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub request_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Error)]
pub enum AntigravityRuntimeError {
    #[error(transparent)]
    Protocol(#[from] AcpProtocolError),
    /// The CLI answered `-32000` "Authentication required". The user signs in; BiBCode never does.
    #[error(
        "Antigravity is not signed in. Open an Antigravity Terminal and run `agy`, or run `agy acp --login`, then send the message again."
    )]
    SignInRequired,
    /// The CLI is older than 1.5.4, speaks another ACP version, or has no working `agy acp`.
    #[error("{}", unsupported_version_message(.version.as_deref()))]
    UnsupportedVersion { version: Option<String> },
    /// The session did not acknowledge the mode the thread's permission setting needs.
    #[error(
        "Antigravity did not switch to its `{mode}` mode, so BiBCode stopped the chat to keep your permission setting. Run `agy update`, then try again."
    )]
    ModeUnavailable { mode: String },
    /// The CLI did not finish the handshake and session open in time. It may be transient.
    #[error(
        "Antigravity did not answer while the chat was starting. Send the message again; if it keeps happening, check that `agy acp` runs in a terminal."
    )]
    StartTimedOut,
    #[error("Antigravity runtime has not started a provider session")]
    MissingProviderSessionId,
    #[error("Unknown pending request id {request_id}")]
    PendingRequestNotFound { request_id: String },
    #[error("Antigravity option update is unsupported: {0}")]
    UnsupportedOption(RefusedOption),
    #[error("Antigravity config update acknowledgement omitted configOptions")]
    MalformedConfigAcknowledgement,
}

impl AntigravityRuntimeError {
    /// The class a log line may carry instead of the error's text.
    #[must_use]
    pub fn class(&self) -> &'static str {
        match self {
            Self::Protocol(error) => acp_error_class(error),
            Self::SignInRequired => "sign_in_required",
            Self::UnsupportedVersion { .. } => "unsupported_version",
            Self::ModeUnavailable { .. } => "mode_unavailable",
            Self::StartTimedOut => "start_timeout",
            Self::UnsupportedOption(_) => "unsupported_option",
            Self::MissingProviderSessionId
            | Self::PendingRequestNotFound { .. }
            | Self::MalformedConfigAcknowledgement => "runtime_error",
        }
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
    completion: oneshot::Receiver<Result<(), AntigravityRuntimeError>>,
}

impl AntigravityPromptReceipt {
    /// Resolves when the CLI answers the prompt, that is when the turn ends.
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
    /// `None` until the open call and every update queued before its answer are handled, so a
    /// replayed history is dropped.
    provider_session_id: Mutex<Option<String>>,
    config_options: Mutex<Vec<Value>>,
    legacy_models: AtomicBool,
    /// (runtime mode, interaction mode).
    modes: Mutex<(String, String)>,
    active_turn_id: Mutex<Option<String>>,
    ignored_turn_id: Mutex<Option<String>>,
    abandoned_turns: Mutex<HashSet<String>>,
    pending_requests: Mutex<HashMap<String, PendingRequest>>,
    events_tx: mpsc::UnboundedSender<AntigravityRuntimeEvent>,
    events_rx: Mutex<mpsc::UnboundedReceiver<AntigravityRuntimeEvent>>,
    abandon: Notify,
}

struct PendingRequest {
    wire_id: Value,
    turn_id: Option<String>,
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
        let modes = (
            options.runtime_mode.clone(),
            options.interaction_mode.clone(),
        );
        let runtime = Self {
            inner: Arc::new(RuntimeInner {
                options,
                connection,
                provider_session_id: Mutex::new(None),
                config_options: Mutex::new(Vec::new()),
                legacy_models: AtomicBool::new(false),
                modes: Mutex::new(modes),
                active_turn_id: Mutex::new(None),
                ignored_turn_id: Mutex::new(None),
                abandoned_turns: Mutex::new(HashSet::new()),
                pending_requests: Mutex::new(HashMap::new()),
                events_tx,
                events_rx: Mutex::new(events_rx),
                abandon: Notify::new(),
            }),
        };
        let reader = runtime.clone();
        let scope = RequestScope::new();
        tokio::spawn(async move {
            while let Some(event) = incoming.recv().await {
                reader.handle_incoming(scope, event).await;
            }
        });
        runtime
    }

    /// Initializes, checks the CLI, opens the session (resume, else load, else new), then
    /// writes the model and the mode. Returns the ACP session id.
    pub async fn start(&self) -> Result<String, AntigravityRuntimeError> {
        tokio::time::timeout(self.inner.options.start_timeout, self.start_session())
            .await
            .unwrap_or_else(|_| {
                tracing::warn!(
                    provider = PROVIDER,
                    "the provider did not finish starting in time"
                );
                Err(AntigravityRuntimeError::StartTimedOut)
            })
    }

    async fn start_session(&self) -> Result<String, AntigravityRuntimeError> {
        let initialized = match self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                    "clientInfo": { "name": "bibcode-rust", "version": "0.1.1" },
                }),
            )
            .await
        {
            Ok(initialized) => initialized,
            // No working `agy acp`: the command is unknown, or the child exited before answering.
            Err(AntigravityRuntimeError::Protocol(
                AcpProtocolError::RemoteRequest { code: -32601, .. }
                | AcpProtocolError::Closed { .. }
                | AcpProtocolError::WriteFailure { .. }
                | AcpProtocolError::ReadFailure { .. },
            )) => return Err(AntigravityRuntimeError::UnsupportedVersion { version: None }),
            Err(error) => return Err(error),
        };
        if initialized.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
            return Err(AntigravityRuntimeError::UnsupportedVersion { version: None });
        }
        let version = initialized
            .pointer("/agentInfo/version")
            .and_then(Value::as_str);
        if version
            .and_then(parse_version)
            .is_some_and(|parsed| parsed < MINIMUM_VERSION)
        {
            return Err(AntigravityRuntimeError::UnsupportedVersion {
                version: version.map(str::to_owned),
            });
        }
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
        // model and the mode again; the supervisor's `set_options` writes the thinking level.
        self.apply_model(self.inner.options.model.as_deref())
            .await?;
        let (runtime_mode, interaction_mode) = self.inner.modes.lock().await.clone();
        self.apply_mode(&runtime_mode, &interaction_mode).await?;
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
        let session_id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or(requested)
            .ok_or(AntigravityRuntimeError::MissingProviderSessionId)?;
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
        *self.inner.provider_session_id.lock().await = Some(session_id.clone());
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
            // Only the combined model-and-effort ids exist: they go out unchanged.
            self.request(
                "session/set_model",
                json!({ "sessionId": session_id, "modelId": model }),
            )
            .await?;
        }
        Ok(())
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
            let session_id = self.provider_session_id().await?;
            self.write_config(&session_id, option_id(descriptor), json!(value))
                .await?;
        }
        Ok(())
    }

    async fn write_config(
        &self,
        session_id: &str,
        config_id: &str,
        value: Value,
    ) -> Result<Vec<Value>, AntigravityRuntimeError> {
        let response = self
            .request(
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": value }),
            )
            .await?;
        let options = response
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
            .ok_or(AntigravityRuntimeError::MalformedConfigAcknowledgement)?;
        *self.inner.config_options.lock().await = options.clone();
        Ok(options)
    }

    /// Switches the runtime mode. A switch away from full access takes effect locally before the
    /// CLI acknowledges it, so BiBCode stops answering approvals at once even if the write fails;
    /// a switch to full access takes effect only once acknowledged.
    pub async fn set_runtime_mode(&self, mode: &str) -> Result<(), AntigravityRuntimeError> {
        let interaction_mode = self.inner.modes.lock().await.1.clone();
        let loosens = mode == "full-access";
        if !loosens {
            self.inner.modes.lock().await.0 = mode.to_owned();
        }
        self.apply_mode(mode, &interaction_mode).await?;
        if loosens {
            self.inner.modes.lock().await.0 = mode.to_owned();
        }
        Ok(())
    }

    pub async fn set_interaction_mode(&self, mode: &str) -> Result<(), AntigravityRuntimeError> {
        let runtime_mode = {
            let mut modes = self.inner.modes.lock().await;
            modes.1 = mode.to_owned();
            modes.0.clone()
        };
        self.apply_mode(&runtime_mode, mode).await
    }

    /// Writes the advertised `mode` option and requires the answer to show it. No fallback to
    /// another mode or to `session/set_mode`: a missing or refused mode refuses (D-A5).
    async fn apply_mode(
        &self,
        runtime_mode: &str,
        interaction_mode: &str,
    ) -> Result<(), AntigravityRuntimeError> {
        let target = mode_for(runtime_mode, interaction_mode);
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
            Err(AntigravityRuntimeError::Protocol(AcpProtocolError::RemoteRequest { .. })) => {
                return Err(unavailable());
            }
            Err(error) => return Err(error),
        };
        if option_by_category(&acknowledged, "mode")
            .and_then(|descriptor| descriptor.get("currentValue"))
            .and_then(Value::as_str)
            != Some(target)
        {
            return Err(unavailable());
        }
        Ok(())
    }

    pub async fn send_turn_with_receipt(
        &self,
        input: Option<&str>,
        attachments: Vec<Value>,
    ) -> Result<AntigravityPromptReceipt, AntigravityRuntimeError> {
        let session_id = self.provider_session_id().await?;
        let turn_id = format!("turn-{}", Uuid::new_v4());
        *self.inner.active_turn_id.lock().await = Some(turn_id.clone());
        *self.inner.ignored_turn_id.lock().await = None;
        self.emit("turn.started", Some(turn_id.clone()), None, json!({}));
        let connection = self.inner.connection.clone();
        let prompt = crate::provider::attachments::prompt_parts(input, attachments);
        let mut request = connection
            .start_request(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": prompt }),
            )
            .await?;
        let completion = match request.written().await {
            Ok(()) => self.track_prompt_response(turn_id.clone(), request.response()),
            Err(failure) if failure.is_definitely_not_sent() => {
                return Err(failure.into_error().into());
            }
            Err(failure) => self.track_prompt_response(
                turn_id.clone(),
                std::future::ready(Err(failure.into_error())),
            ),
        };
        Ok(AntigravityPromptReceipt {
            turn_id,
            completion,
        })
    }

    fn track_prompt_response<F>(
        &self,
        turn_id: String,
        response: F,
    ) -> oneshot::Receiver<Result<(), AntigravityRuntimeError>>
    where
        F: Future<Output = Result<Value, AcpProtocolError>> + Send + 'static,
    {
        let runtime = self.clone();
        let (completion_tx, completion) = oneshot::channel();
        tokio::spawn(async move {
            let result = response.await;
            // Chunks the agent wrote before its answer may still wait in the incoming queue.
            let _ = runtime.inner.connection.barrier().await;
            {
                let mut active = runtime.inner.active_turn_id.lock().await;
                if active.as_deref() == Some(turn_id.as_str()) {
                    *active = None;
                }
            }
            // An abandoned turn already completed as cancelled.
            let abandoned = runtime.inner.abandoned_turns.lock().await.remove(&turn_id);
            let outcome = match result {
                Ok(response) => {
                    let stop_reason = response
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("end_turn");
                    let (state, failure_message) = acp_turn_state(stop_reason);
                    let mut payload = json!({ "state": state, "stopReason": stop_reason });
                    if let Some(message) = failure_message {
                        payload["errorMessage"] = json!(message);
                    }
                    if !abandoned {
                        runtime.emit("turn.completed", Some(turn_id), None, payload);
                    }
                    Ok(())
                }
                Err(error) => {
                    let error = classify(error);
                    if !abandoned {
                        runtime.emit(
                            "turn.completed",
                            Some(turn_id),
                            None,
                            json!({
                                "state": "failed",
                                "stopReason": "error",
                                "errorMessage": error.to_string(),
                                "errorClass": error.class(),
                            }),
                        );
                    }
                    Err(error)
                }
            };
            let _ = completion_tx.send(outcome);
        });
        completion
    }

    /// Cancels the active turn: answers its pending approvals with `cancelled` (the ACP rule),
    /// sends `session/cancel`, and, if the CLI does not end the prompt within the grace period,
    /// completes the turn as cancelled and signals [`Self::abandoned`] so the driver stops the
    /// process (D-A10).
    pub async fn interrupt_turn(&self) -> Result<(), AntigravityRuntimeError> {
        let Some(turn_id) = self.inner.active_turn_id.lock().await.clone() else {
            return Ok(());
        };
        *self.inner.ignored_turn_id.lock().await = Some(turn_id.clone());
        let pending = {
            let mut requests = self.inner.pending_requests.lock().await;
            let ids = requests
                .iter()
                .filter(|(_, pending)| pending.turn_id.as_deref() == Some(turn_id.as_str()))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| requests.remove(&id).map(|pending| (id, pending)))
                .collect::<Vec<_>>()
        };
        for (request_id, pending) in pending {
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
                pending.turn_id,
                Some(request_id),
                json!({ "requestType": "exec_command_approval", "decision": "cancel" }),
            );
        }
        let session_id = self.provider_session_id().await?;
        self.inner
            .connection
            .notify("session/cancel", json!({ "sessionId": session_id }))
            .await
            .map_err(classify)?;
        let runtime = self.clone();
        let grace = self.inner.options.cancel_grace;
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            {
                let mut active = runtime.inner.active_turn_id.lock().await;
                if active.as_deref() != Some(turn_id.as_str()) {
                    return;
                }
                *active = None;
                runtime
                    .inner
                    .abandoned_turns
                    .lock()
                    .await
                    .insert(turn_id.clone());
            }
            tracing::warn!(
                provider = PROVIDER,
                "the provider did not end a cancelled turn; stopping its process"
            );
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
        let pending = self
            .inner
            .pending_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| AntigravityRuntimeError::PendingRequestNotFound {
                request_id: request_id.to_owned(),
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
        self.emit(
            "request.resolved",
            pending.turn_id,
            Some(request_id.to_owned()),
            json!({ "requestType": "exec_command_approval", "decision": decision }),
        );
        Ok(())
    }

    pub async fn next_event(&self) -> Option<AntigravityRuntimeEvent> {
        self.inner.events_rx.lock().await.recv().await
    }

    #[cfg(test)]
    async fn pending_request_ids(&self) -> Vec<String> {
        self.inner
            .pending_requests
            .lock()
            .await
            .keys()
            .cloned()
            .collect()
    }

    async fn handle_incoming(&self, scope: RequestScope, event: IncomingEvent) {
        match event {
            IncomingEvent::Notification { method, params } => {
                self.handle_notification(&method, params).await;
            }
            IncomingEvent::Request {
                correlation_id,
                wire_id,
                method,
                params,
            } => {
                if let Err(error) = self
                    .handle_request(scope, correlation_id, wire_id, &method, params)
                    .await
                {
                    tracing::warn!(
                        provider = PROVIDER,
                        method = %method,
                        class = error.class(),
                        "failed to answer an ACP request"
                    );
                }
            }
            IncomingEvent::Stderr { message } => {
                // Provider stderr can hold anything; only its size is logged.
                tracing::debug!(
                    provider = PROVIDER,
                    bytes = message.len(),
                    "dropped a provider stderr line"
                );
            }
            IncomingEvent::Closed { reason } => {
                self.emit("session.exited", None, None, json!({ "reason": reason }));
            }
            IncomingEvent::Barrier(reached) => {
                let _ = reached.send(());
            }
        }
    }

    async fn handle_notification(&self, method: &str, params: Value) {
        if method != "session/update" {
            tracing::debug!(provider = PROVIDER, method = %method, "dropped an unhandled ACP notification");
            return;
        }
        let session_id = self.inner.provider_session_id.lock().await.clone();
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
        let turn_id = self.inner.active_turn_id.lock().await.clone();
        if turn_id.is_some() && *self.inner.ignored_turn_id.lock().await == turn_id {
            return;
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
            other => {
                tracing::debug!(
                    provider = PROVIDER,
                    session_update = other.unwrap_or("<absent>"),
                    "dropped an unhandled ACP session update"
                );
            }
        }
    }

    async fn handle_request(
        &self,
        scope: RequestScope,
        correlation_id: String,
        wire_id: Value,
        method: &str,
        params: Value,
    ) -> Result<(), AntigravityRuntimeError> {
        let connection = &self.inner.connection;
        if method != "session/request_permission" {
            // No elicitation or other client method is offered (D-A7).
            tracing::debug!(provider = PROVIDER, method = %method, "answered an unknown ACP request");
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
        let turn_id = self.inner.active_turn_id.lock().await.clone();
        if turn_id.is_some() && *self.inner.ignored_turn_id.lock().await == turn_id {
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
        // Full access answers each request with `allow_once`, never `allow_always`, so a later
        // switch to approval-required applies to the next request. Nothing else is answered here.
        let full_access = self.inner.modes.lock().await.0 == "full-access";
        if full_access && let Some(option_id) = allow_once.clone() {
            connection
                .respond(
                    wire_id,
                    json!({ "outcome": { "outcome": "selected", "optionId": option_id } }),
                )
                .await?;
            return Ok(());
        }
        let request_id = scope.approval_id(&correlation_id);
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
        self.inner.pending_requests.lock().await.insert(
            request_id.clone(),
            PendingRequest {
                wire_id,
                turn_id: turn_id.clone(),
                allow_once,
                allow_always: find_option_id(&options, "allow_always"),
                reject_once: find_option_id(&options, "reject_once"),
            },
        );
        self.emit(
            "request.opened",
            turn_id,
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
            .provider_session_id
            .lock()
            .await
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

/// One classifier for every request: `-32000` "Authentication required" is the sign-in error;
/// any other `-32000` is a generic server error and passes through.
fn classify(error: AcpProtocolError) -> AntigravityRuntimeError {
    match &error {
        AcpProtocolError::RemoteRequest {
            code: -32000,
            message,
            ..
        } if message
            .to_ascii_lowercase()
            .contains("authentication required") =>
        {
            AntigravityRuntimeError::SignInRequired
        }
        _ => AntigravityRuntimeError::Protocol(error),
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

fn option_by_category<'a>(options: &'a [Value], category: &str) -> Option<&'a Value> {
    options
        .iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some(category))
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
    text.split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .find_map(|token| {
            let mut parts = token.split('.');
            Some((
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
            ))
        })
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
