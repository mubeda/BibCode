use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::activity::{
    ActivityCapabilities, ActivityHistoryRecovery, ActivityObservationState, ActivitySection,
    ActivitySectionHealth, ProviderActivityMutation,
};

use super::{
    activity::{BackgroundSnapshotAuthority, CodexActivityTracker},
    model::{
        BuildTurnStartInput, CodexProviderSnapshot, CodexRuntimeMode, CodexThreadSnapshot,
        ThreadBackgroundTerminalsListParams, ThreadListParams, ThreadReadParams,
        build_initialize_params, build_turn_start_params,
        decode_background_terminals_list_response, decode_thread_list_response,
        decode_thread_read_response, is_recoverable_thread_resume_error,
        parse_model_list_response, parse_skills_list_response, parse_thread_snapshot,
    },
    protocol::{IncomingEvent, JsonRpcConnection, ProtocolError},
};

const PROVIDER: &str = "codex";
const FIXED_EVENT_TIME: &str = "2026-07-10T00:00:00.000Z";
const FATAL_STDERR_SNIPPETS: &[&str] = &["failed to connect to websocket"];
const RECONCILIATION_HINT_CAPACITY: usize = 1;
const RECONCILIATION_DESCENDANT_LIMIT: u16 = 50;
const RECONCILIATION_DESCENDANT_PAGE_LIMIT: usize = 8;
const RECONCILIATION_BACKGROUND_LIMIT: u16 = 128;
const RECONCILIATION_BACKGROUND_PAGE_LIMIT: usize = 8;
const RECONCILIATION_MUTATION_LIMIT: usize = 256;

#[derive(Clone, Debug)]
pub struct CodexSessionOptions {
    pub version: String,
    pub thread_id: String,
    pub cwd: String,
    pub runtime_mode: CodexRuntimeMode,
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub effort: Option<String>,
    pub resume_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PendingRequestKind {
    CommandApproval,
    FileChangeApproval,
    UserInput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSession {
    pub provider: String,
    pub status: String,
    pub runtime_mode: CodexRuntimeMode,
    pub thread_id: String,
    pub cwd: String,
    pub model: Option<String>,
    pub resume_cursor: Option<String>,
    pub active_turn_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResult {
    pub thread_id: String,
    pub turn_id: String,
    pub resume_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub event_id: String,
    pub provider: String,
    pub created_at: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_event_id: Option<String>,
    #[serde(skip)]
    pub activity: Vec<crate::activity::ProviderActivityMutation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventStableView {
    #[serde(rename = "type")]
    pub event_type: String,
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub payload: Value,
}

impl RuntimeEvent {
    #[must_use]
    pub fn stable_view(&self) -> RuntimeEventStableView {
        RuntimeEventStableView {
            event_type: self.event_type.clone(),
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            request_id: self.request_id.clone(),
            payload: self.payload.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("Codex session is missing a provider thread id")]
    MissingProviderThreadId,
    #[error("Unknown pending request id {request_id}")]
    PendingRequestNotFound { request_id: String },
    #[error("Invalid Codex payload: {message}")]
    InvalidPayload { message: String },
}

#[derive(Clone)]
pub struct CodexSessionRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    options: CodexSessionOptions,
    connection: Mutex<JsonRpcConnection>,
    session: Mutex<ProviderSession>,
    events_tx: mpsc::UnboundedSender<RuntimeEvent>,
    events_rx: Mutex<mpsc::UnboundedReceiver<RuntimeEvent>>,
    event_counter: Mutex<u64>,
    pending_requests: Mutex<HashMap<String, PendingRequest>>,
    task: StdMutex<Option<JoinHandle<()>>>,
    reconciliation_hint_tx: mpsc::Sender<()>,
    reconciliation_pending_hint: StdMutex<Option<ReconciliationHint>>,
    reconciliation_task: StdMutex<Option<JoinHandle<()>>>,
    reconciliation_cancellation: CancellationToken,
    explicit_close: Mutex<bool>,
    activity: Mutex<RuntimeActivityState>,
}

struct RuntimeActivityState {
    agent_activity_enabled: bool,
    tracker: CodexActivityTracker,
    next_receive_sequence: u128,
    next_reconciliation_sequence: u64,
    reconciled_root_thread_id: Option<String>,
    thread_list_support: ReconciliationMethodSupport,
    thread_read_support: ReconciliationMethodSupport,
    background_list_support: ReconciliationMethodSupport,
    warned_incompatible_methods: HashSet<&'static str>,
    capabilities: ActivityCapabilities,
    reconciliation_epoch: u64,
    reconciliation_pass_cancellation: CancellationToken,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReconciliationMethodSupport {
    Unknown,
    Supported,
    Unsupported,
}

#[derive(Clone, Copy, Debug)]
struct ReconciliationHint {
    immediate: bool,
    epoch: u64,
}

#[derive(Clone, Debug)]
struct ReconciliationPass {
    epoch: u64,
    root_thread_id: String,
    cancellation: CancellationToken,
}

enum ReconciliationEmission {
    Successful {
        capabilities: ActivityCapabilities,
        mutations: Vec<ProviderActivityMutation>,
    },
    Stale,
    Warning(&'static str),
}

#[derive(Clone)]
struct PendingRequest {
    kind: PendingRequestKind,
    wire_id: Value,
    turn_id: Option<String>,
}

pub async fn probe_provider(
    connection: &JsonRpcConnection,
    version: &str,
    cwd: &str,
    custom_models: &[String],
) -> Result<CodexProviderSnapshot, RuntimeError> {
    connection
        .request("initialize", build_initialize_params(version))
        .await?;
    connection.notify_without_params("initialized").await?;
    let account = connection.request("account/read", json!({})).await?;

    let mut raw_models = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let request_payload = cursor
            .as_ref()
            .map_or_else(|| json!({}), |value| json!({ "cursor": value }));
        let response = connection.request("model/list", request_payload).await?;
        raw_models.extend(
            response
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| RuntimeError::InvalidPayload {
                    message: "model/list response missing data array".to_owned(),
                })?,
        );
        cursor = response
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    let models = parse_model_list_response(&json!({ "data": raw_models }), custom_models)
        .map_err(|message| RuntimeError::InvalidPayload { message })?;

    let skills_response = connection
        .request("skills/list", json!({ "cwds": [cwd] }))
        .await?;
    let skills = parse_skills_list_response(&skills_response, cwd)
        .map_err(|message| RuntimeError::InvalidPayload { message })?;

    Ok(CodexProviderSnapshot {
        account,
        version: Some(version.to_owned()),
        models,
        skills,
    })
}

impl CodexSessionRuntime {
    pub fn new(
        options: CodexSessionOptions,
        connection: JsonRpcConnection,
        incoming: mpsc::UnboundedReceiver<IncomingEvent>,
    ) -> Self {
        Self::new_with_agent_activity_enabled(options, connection, incoming, true)
    }

    pub(crate) fn new_with_agent_activity_enabled(
        options: CodexSessionOptions,
        connection: JsonRpcConnection,
        incoming: mpsc::UnboundedReceiver<IncomingEvent>,
        agent_activity_enabled: bool,
    ) -> Self {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (reconciliation_hint_tx, reconciliation_hint_rx) =
            mpsc::channel(RECONCILIATION_HINT_CAPACITY);
        let reconciliation_cancellation = CancellationToken::new();
        let session = ProviderSession {
            provider: PROVIDER.to_owned(),
            status: "connecting".to_owned(),
            runtime_mode: options.runtime_mode,
            thread_id: options.thread_id.clone(),
            cwd: options.cwd.clone(),
            model: options.model.clone(),
            resume_cursor: options.resume_cursor.clone(),
            active_turn_id: None,
        };
        let inner = Arc::new(RuntimeInner {
            options,
            connection: Mutex::new(connection.clone()),
            session: Mutex::new(session),
            events_tx,
            events_rx: Mutex::new(events_rx),
            event_counter: Mutex::new(0),
            pending_requests: Mutex::new(HashMap::new()),
            task: StdMutex::new(None),
            reconciliation_hint_tx,
            reconciliation_pending_hint: StdMutex::new(None),
            reconciliation_task: StdMutex::new(None),
            reconciliation_cancellation: reconciliation_cancellation.clone(),
            explicit_close: Mutex::new(false),
            activity: Mutex::new(RuntimeActivityState {
                agent_activity_enabled,
                tracker: CodexActivityTracker::new(None),
                next_receive_sequence: 0,
                next_reconciliation_sequence: 0,
                reconciled_root_thread_id: None,
                thread_list_support: ReconciliationMethodSupport::Unknown,
                thread_read_support: ReconciliationMethodSupport::Unknown,
                background_list_support: ReconciliationMethodSupport::Unknown,
                warned_incompatible_methods: HashSet::new(),
                capabilities: ActivityCapabilities {
                    actors: true,
                    attributed_activity: true,
                    background_work: false,
                    history_recovery: ActivityHistoryRecovery::None,
                    terminal_observation: false,
                },
                reconciliation_epoch: 0,
                reconciliation_pass_cancellation: CancellationToken::new(),
            }),
        });
        let runtime = Self { inner };
        runtime.start_reconciliation_worker(reconciliation_hint_rx);
        let previous = runtime.attach_incoming(connection, incoming);
        debug_assert!(previous.is_none());
        runtime
    }

    pub async fn set_agent_activity_enabled(&self, enabled: bool) {
        let root_thread_id = self.inner.session.lock().await.resume_cursor.clone();
        let should_reconcile = {
            let mut activity = self.inner.activity.lock().await;
            if activity.agent_activity_enabled == enabled {
                return;
            }
            activity.agent_activity_enabled = enabled;
            activity.reconciliation_epoch = activity.reconciliation_epoch.wrapping_add(1);
            activity.reconciliation_pass_cancellation.cancel();
            activity.reconciliation_pass_cancellation = CancellationToken::new();
            activity.tracker = CodexActivityTracker::new(root_thread_id.as_deref());
            if enabled {
                activity.tracker.begin_detail_baseline();
            }
            activity.reconciled_root_thread_id = None;
            self.inner
                .reconciliation_pending_hint
                .lock()
                .expect("Codex reconciliation pending-hint mutex poisoned")
                .take();
            enabled && root_thread_id.is_some()
        };
        if should_reconcile {
            self.request_reconciliation(true).await;
        }
    }

    pub async fn start(&self) -> Result<ProviderSession, RuntimeError> {
        self.emit("session.connecting", None, None, json!({})).await;
        let connection = self.inner.connection.lock().await.clone();
        connection
            .request(
                "initialize",
                build_initialize_params(&self.inner.options.version),
            )
            .await?;
        connection.notify_without_params("initialized").await?;

        let open_payload = json!({
            "cwd": self.inner.options.cwd,
            "approvalPolicy": match self.inner.options.runtime_mode {
                CodexRuntimeMode::ApprovalRequired => "untrusted",
                CodexRuntimeMode::AutoAcceptEdits => "on-request",
                CodexRuntimeMode::FullAccess => "never",
            },
            "sandbox": match self.inner.options.runtime_mode {
                CodexRuntimeMode::ApprovalRequired => "read-only",
                CodexRuntimeMode::AutoAcceptEdits => "workspace-write",
                CodexRuntimeMode::FullAccess => "danger-full-access",
            },
            "model": self.inner.options.model,
            "serviceTier": self.inner.options.service_tier,
        });

        let resume_thread_id = self
            .inner
            .session
            .lock()
            .await
            .resume_cursor
            .clone()
            .or_else(|| self.inner.options.resume_cursor.clone());

        let opened = if let Some(resume_thread_id) = resume_thread_id {
            match connection
                .request(
                    "thread/resume",
                    json!({
                        "threadId": resume_thread_id,
                        "cwd": self.inner.options.cwd,
                        "approvalPolicy": match self.inner.options.runtime_mode {
                            CodexRuntimeMode::ApprovalRequired => "untrusted",
                            CodexRuntimeMode::AutoAcceptEdits => "on-request",
                            CodexRuntimeMode::FullAccess => "never",
                        },
                        "sandbox": match self.inner.options.runtime_mode {
                            CodexRuntimeMode::ApprovalRequired => "read-only",
                            CodexRuntimeMode::AutoAcceptEdits => "workspace-write",
                            CodexRuntimeMode::FullAccess => "danger-full-access",
                        },
                        "model": self.inner.options.model,
                        "serviceTier": self.inner.options.service_tier,
                    }),
                )
                .await
            {
                Ok(response) => response,
                Err(ProtocolError::RemoteRequest { message, .. })
                    if is_recoverable_thread_resume_error(&message) =>
                {
                    connection.request("thread/start", open_payload).await?
                }
                Err(error) => return Err(error.into()),
            }
        } else {
            connection.request("thread/start", open_payload).await?
        };

        let provider_thread_id = opened
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::InvalidPayload {
                message: "thread/start response missing thread.id".to_owned(),
            })?
            .to_owned();

        let mut session = self.inner.session.lock().await;
        session.status = "ready".to_owned();
        session.cwd = opened
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or(&self.inner.options.cwd)
            .to_owned();
        session.model = opened
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| self.inner.options.model.clone());
        session.resume_cursor = Some(provider_thread_id.clone());
        drop(session);
        let mut activity = self.inner.activity.lock().await;
        if activity.agent_activity_enabled {
            activity.tracker.set_root_thread_id(&provider_thread_id);
        }
        drop(activity);

        self.emit("session.ready", None, None, json!({})).await;
        Ok(self.inner.session.lock().await.clone())
    }

    pub async fn reconnect(
        &self,
        connection: JsonRpcConnection,
        incoming: mpsc::UnboundedReceiver<IncomingEvent>,
    ) -> Result<ProviderSession, RuntimeError> {
        *self.inner.explicit_close.lock().await = false;
        {
            let mut activity = self.inner.activity.lock().await;
            activity.reconciliation_epoch = activity.reconciliation_epoch.wrapping_add(1);
            activity.reconciliation_pass_cancellation.cancel();
            activity.reconciliation_pass_cancellation = CancellationToken::new();
        }
        if let Some(previous) = self.attach_incoming(connection.clone(), incoming) {
            let _ = previous.await;
        }
        *self.inner.connection.lock().await = connection;
        let resume_cursor = self.inner.session.lock().await.resume_cursor.clone();
        self.inner.options_resume_cursor_set(resume_cursor).await;
        let session = self.start().await?;
        self.request_reconciliation_immediate().await;
        Ok(session)
    }

    pub async fn send_turn(
        &self,
        input: Option<String>,
        attachments: Vec<Value>,
        interaction_mode: Option<String>,
    ) -> Result<TurnStartResult, RuntimeError> {
        let provider_thread_id = self.provider_thread_id().await?;
        let session = self.inner.session.lock().await.clone();
        let payload = build_turn_start_params(&BuildTurnStartInput {
            thread_id: provider_thread_id.clone(),
            runtime_mode: self.inner.options.runtime_mode,
            prompt: input,
            attachments,
            model: session.model.clone(),
            service_tier: self.inner.options.service_tier.clone(),
            effort: self.inner.options.effort.clone(),
            interaction_mode,
        });
        let response = self
            .inner
            .connection
            .lock()
            .await
            .clone()
            .request("turn/start", payload)
            .await?;
        let turn_id = response
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::InvalidPayload {
                message: "turn/start response missing turn.id".to_owned(),
            })?
            .to_owned();
        let mut session = self.inner.session.lock().await;
        session.status = "running".to_owned();
        session.active_turn_id = Some(turn_id.clone());
        Ok(TurnStartResult {
            thread_id: session.thread_id.clone(),
            turn_id,
            resume_cursor: session.resume_cursor.clone(),
        })
    }

    pub async fn set_goal(&self, objective: &str) -> Result<(), RuntimeError> {
        let objective = objective.trim();
        if objective.is_empty() || objective.chars().count() > 4_000 {
            return Err(RuntimeError::InvalidPayload {
                message: "goal objective must contain between 1 and 4000 characters".to_owned(),
            });
        }
        let provider_thread_id = self.provider_thread_id().await?;
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .request(
                "thread/goal/set",
                json!({
                    "threadId": provider_thread_id,
                    "objective": objective,
                    "status": "active",
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn interrupt_turn(&self, turn_id: Option<String>) -> Result<(), RuntimeError> {
        let provider_thread_id = self.provider_thread_id().await?;
        let active_turn_id = if let Some(turn_id) = turn_id {
            Some(turn_id)
        } else {
            self.inner.session.lock().await.active_turn_id.clone()
        };
        let Some(active_turn_id) = active_turn_id else {
            return Ok(());
        };
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .request(
                "turn/interrupt",
                json!({
                    "threadId": provider_thread_id,
                    "turnId": active_turn_id,
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn rollback_thread(
        &self,
        num_turns: u64,
    ) -> Result<CodexThreadSnapshot, RuntimeError> {
        let provider_thread_id = self.provider_thread_id().await?;
        let response = self
            .inner
            .connection
            .lock()
            .await
            .clone()
            .request(
                "thread/rollback",
                json!({
                    "threadId": provider_thread_id,
                    "numTurns": num_turns,
                }),
            )
            .await?;
        let snapshot = parse_thread_snapshot(&response)
            .map_err(|message| RuntimeError::InvalidPayload { message })?;
        let mut session = self.inner.session.lock().await;
        session.status = "ready".to_owned();
        session.active_turn_id = None;
        Ok(snapshot)
    }

    pub async fn shutdown(&self) -> Result<(), RuntimeError> {
        *self.inner.explicit_close.lock().await = true;
        let task = self
            .inner
            .task
            .lock()
            .expect("Codex incoming task mutex poisoned")
            .take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        self.inner.reconciliation_cancellation.cancel();
        self.inner
            .activity
            .lock()
            .await
            .reconciliation_pass_cancellation
            .cancel();
        let reconciliation_task = self
            .inner
            .reconciliation_task
            .lock()
            .expect("Codex reconciliation task mutex poisoned")
            .take();
        if let Some(task) = reconciliation_task {
            let _ = task.await;
        }
        let connection = self.inner.connection.lock().await.clone();
        let _ = connection.request("shutdown", Value::Null).await;
        connection.close().await;
        Ok(())
    }

    pub async fn respond_to_request(
        &self,
        request_id: &str,
        decision: &str,
    ) -> Result<(), RuntimeError> {
        let pending = self
            .inner
            .pending_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| RuntimeError::PendingRequestNotFound {
                request_id: request_id.to_owned(),
            })?;
        self.emit(
            "request.resolved",
            pending.turn_id.clone(),
            Some(request_id.to_owned()),
            json!({
                "requestType": request_type(pending.kind),
                "decision": decision,
            }),
        )
        .await;
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .respond(
                pending.wire_id,
                json!({
                    "decision": decision,
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn respond_to_user_input(
        &self,
        request_id: &str,
        answers: Value,
    ) -> Result<(), RuntimeError> {
        let pending = self
            .inner
            .pending_requests
            .lock()
            .await
            .remove(request_id)
            .ok_or_else(|| RuntimeError::PendingRequestNotFound {
                request_id: request_id.to_owned(),
            })?;
        let wire_answers = answers
            .as_object()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|(question_id, value)| {
                let answers = match value {
                    Value::String(answer) => vec![Value::String(answer)],
                    Value::Array(array) => array,
                    _ => Vec::new(),
                };
                (
                    question_id,
                    json!({
                        "answers": answers,
                    }),
                )
            })
            .collect::<serde_json::Map<String, Value>>();
        self.inner
            .connection
            .lock()
            .await
            .clone()
            .respond(
                pending.wire_id,
                json!({
                    "answers": Value::Object(wire_answers.clone()),
                }),
            )
            .await?;
        self.emit(
            "user-input.resolved",
            pending.turn_id,
            Some(request_id.to_owned()),
            json!({
                "answers": normalize_user_input_answers(Value::Object(wire_answers)),
            }),
        )
        .await;
        Ok(())
    }

    pub async fn next_event(&self) -> Option<RuntimeEvent> {
        self.inner.events_rx.lock().await.recv().await
    }

    pub async fn collect_events(&self, expected: usize) -> Vec<RuntimeEventStableView> {
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
        connection: JsonRpcConnection,
        mut incoming: mpsc::UnboundedReceiver<IncomingEvent>,
    ) -> Option<JoinHandle<()>> {
        let mut task_slot = self
            .inner
            .task
            .lock()
            .expect("Codex incoming task mutex poisoned");
        let previous = task_slot.take();
        if let Some(previous) = previous.as_ref() {
            previous.abort();
        }
        let runtime = self.clone();
        let task = tokio::spawn(async move {
            while let Some(event) = incoming.recv().await {
                runtime.handle_incoming(connection.clone(), event).await;
            }
        });
        *task_slot = Some(task);
        previous
    }

    fn start_reconciliation_worker(&self, mut hints: mpsc::Receiver<()>) {
        let runtime = self.clone();
        let cancellation = self.inner.reconciliation_cancellation.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = cancellation.cancelled() => return,
                    hint = hints.recv() => if hint.is_none() {
                        return;
                    },
                }
                let Some(mut hint) = runtime.take_reconciliation_hint() else {
                    continue;
                };
                if hint.epoch != runtime.reconciliation_epoch().await {
                    continue;
                }
                if !hint.immediate {
                    let deadline = tokio::time::Instant::now() + Duration::from_millis(250);
                    loop {
                        tokio::select! {
                            biased;
                            () = cancellation.cancelled() => return,
                            wake = hints.recv() => {
                                if wake.is_none() {
                                    return;
                                }
                                if let Some(next) = runtime.take_reconciliation_hint() {
                                    hint = merge_reconciliation_hints(hint, next);
                                    if hint.immediate {
                                        break;
                                    }
                                }
                            }
                            () = tokio::time::sleep_until(deadline) => break,
                        }
                    }
                }
                if hint.epoch != runtime.reconciliation_epoch().await {
                    continue;
                }
                runtime.reconcile_once().await;
            }
        });
        let previous = self
            .inner
            .reconciliation_task
            .lock()
            .expect("Codex reconciliation task mutex poisoned")
            .replace(task);
        debug_assert!(previous.is_none());
    }

    async fn request_reconciliation(&self, immediate: bool) {
        let epoch = {
            let activity = self.inner.activity.lock().await;
            if !activity.agent_activity_enabled {
                return;
            }
            activity.reconciliation_epoch
        };
        let next = ReconciliationHint { immediate, epoch };
        let mut pending = self
            .inner
            .reconciliation_pending_hint
            .lock()
            .expect("Codex reconciliation pending-hint mutex poisoned");
        *pending = Some(
            pending
                .take()
                .map_or(next, |current| merge_reconciliation_hints(current, next)),
        );
        drop(pending);
        let _ = self.inner.reconciliation_hint_tx.try_send(());
    }

    async fn request_reconciliation_immediate(&self) {
        self.request_reconciliation(true).await;
    }

    fn take_reconciliation_hint(&self) -> Option<ReconciliationHint> {
        self
            .inner
            .reconciliation_pending_hint
            .lock()
            .expect("Codex reconciliation pending-hint mutex poisoned")
            .take()
    }

    async fn reconcile_once(&self) {
        let root_thread_id = match self.provider_thread_id().await {
            Ok(root_thread_id) => root_thread_id,
            Err(_) => return,
        };
        let (epoch, cancellation) = {
            let activity = self.inner.activity.lock().await;
            if !activity.agent_activity_enabled || !activity.tracker.is_root_thread(&root_thread_id)
            {
                return;
            }
            (
                activity.reconciliation_epoch,
                activity.reconciliation_pass_cancellation.clone(),
            )
        };
        let pass = ReconciliationPass {
            epoch,
            root_thread_id: root_thread_id.clone(),
            cancellation,
        };
        let connection = self.inner.connection.lock().await.clone();
        let mut listed_threads = Vec::new();
        let list_enabled = self.inner.activity.lock().await.thread_list_support
            != ReconciliationMethodSupport::Unsupported;
        let mut list_succeeded = false;
        let mut list_incompatible = false;
        if list_enabled {
            let mut cursor = None;
            let mut seen_cursors = HashSet::new();
            let mut page_count = 0;
            while page_count < RECONCILIATION_DESCENDANT_PAGE_LIMIT {
                page_count += 1;
                let params = serde_json::to_value(ThreadListParams {
                    ancestor_thread_id: &root_thread_id,
                    limit: RECONCILIATION_DESCENDANT_LIMIT,
                    cursor: cursor.as_deref(),
                })
                .expect("Codex thread/list params serialize");
                let response = match connection
                    .request_cancellable("thread/list", params, &pass.cancellation)
                    .await
                {
                    Ok(response) => response,
                    Err(error) if method_is_incompatible(&error) => {
                        list_incompatible = true;
                        break;
                    }
                    Err(ProtocolError::Cancelled { .. }) => return,
                    Err(_) => {
                        self.emit_reconciliation(&pass, ReconciliationEmission::Stale)
                            .await;
                        return;
                    }
                };
                let response = match decode_thread_list_response(response) {
                    Ok(response) => response,
                    Err(_) => {
                        list_incompatible = true;
                        break;
                    }
                };
                list_succeeded = true;
                listed_threads.extend(
                    response
                        .data
                        .into_iter()
                        .take(usize::from(RECONCILIATION_DESCENDANT_LIMIT)),
                );
                let Some(next_cursor) = response.next_cursor else {
                    break;
                };
                if !seen_cursors.insert(next_cursor.clone()) {
                    break;
                }
                cursor = Some(next_cursor);
            }
        }
        let (list_support, emit_list_warning) = {
            let mut activity = self.inner.activity.lock().await;
            if !self.reconciliation_is_current_locked(&pass, &activity) {
                return;
            }
            if list_incompatible {
                activity.thread_list_support = ReconciliationMethodSupport::Unsupported;
            } else if list_succeeded {
                activity.thread_list_support = ReconciliationMethodSupport::Supported;
            }
            let emit_warning =
                list_incompatible && activity.warned_incompatible_methods.insert("thread/list");
            (activity.thread_list_support, emit_warning)
        };
        if emit_list_warning {
            self.emit_reconciliation(
                &pass,
                ReconciliationEmission::Warning("Codex activity method thread/list is unsupported"),
            )
            .await;
        }

        let descendants = {
            let mut activity = self.inner.activity.lock().await;
            if !self.reconciliation_is_current_locked(&pass, &activity) {
                return;
            }
            activity.tracker.reconcile_descendants(&listed_threads)
        };
        let mut record_mutations = descendants.output.mutations;
        let read_enabled = list_support != ReconciliationMethodSupport::Unsupported
            && self.inner.activity.lock().await.thread_read_support
                != ReconciliationMethodSupport::Unsupported;
        let mut read_succeeded = false;
        let mut read_incompatible = false;
        if read_enabled {
            for thread_id in descendants.threads_to_read {
                let params = serde_json::to_value(ThreadReadParams {
                    thread_id: &thread_id,
                    include_turns: true,
                })
                .expect("Codex thread/read params serialize");
                let response = match connection
                    .request_cancellable("thread/read", params, &pass.cancellation)
                    .await
                {
                    Ok(response) => response,
                    Err(error) if method_is_incompatible(&error) => {
                        read_incompatible = true;
                        break;
                    }
                    Err(ProtocolError::Cancelled { .. }) => return,
                    Err(_) => {
                        self.emit_reconciliation(&pass, ReconciliationEmission::Stale)
                            .await;
                        return;
                    }
                };
                let response = match decode_thread_read_response(response) {
                    Ok(response) => response,
                    Err(_) => {
                        read_incompatible = true;
                        break;
                    }
                };
                if response.thread.id.as_deref() != Some(thread_id.as_str()) {
                    continue;
                }
                read_succeeded = true;
                let mut activity = self.inner.activity.lock().await;
                if !self.reconciliation_is_current_locked(&pass, &activity) {
                    return;
                }
                record_mutations.extend(
                    activity
                        .tracker
                        .reconcile_thread_history(&response.thread)
                        .mutations,
                );
            }
        }
        let (read_support, emit_read_warning) = {
            let mut activity = self.inner.activity.lock().await;
            if !self.reconciliation_is_current_locked(&pass, &activity) {
                return;
            }
            if read_incompatible {
                activity.thread_read_support = ReconciliationMethodSupport::Unsupported;
            } else if read_succeeded {
                activity.thread_read_support = ReconciliationMethodSupport::Supported;
            }
            let emit_warning =
                read_incompatible && activity.warned_incompatible_methods.insert("thread/read");
            (activity.thread_read_support, emit_warning)
        };
        if emit_read_warning {
            self.emit_reconciliation(
                &pass,
                ReconciliationEmission::Warning("Codex activity method thread/read is unsupported"),
            )
            .await;
        }

        let background_enabled = self.inner.activity.lock().await.background_list_support
            != ReconciliationMethodSupport::Unsupported;
        let mut background_terminals = Vec::new();
        let mut background_page_decoded = false;
        let mut background_authority = BackgroundSnapshotAuthority::Partial;
        let mut background_incompatible = false;
        if background_enabled {
            let mut background_cursor = None;
            let mut seen_background_cursors = HashSet::new();
            let mut page_count = 0;
            loop {
                if page_count == RECONCILIATION_BACKGROUND_PAGE_LIMIT {
                    break;
                }
                page_count += 1;
                let params = serde_json::to_value(ThreadBackgroundTerminalsListParams {
                    thread_id: &root_thread_id,
                    limit: RECONCILIATION_BACKGROUND_LIMIT,
                    cursor: background_cursor.as_deref(),
                })
                .expect("Codex background-terminal list params serialize");
                let response = match connection
                    .request_cancellable(
                        "thread/backgroundTerminals/list",
                        params,
                        &pass.cancellation,
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) if method_is_incompatible(&error) => {
                        background_incompatible = true;
                        break;
                    }
                    Err(ProtocolError::Cancelled { .. }) => return,
                    Err(_) => {
                        self.emit_reconciliation(&pass, ReconciliationEmission::Stale)
                            .await;
                        return;
                    }
                };
                let response = match decode_background_terminals_list_response(response) {
                    Ok(response) => response,
                    Err(_) => {
                        background_incompatible = true;
                        break;
                    }
                };
                background_page_decoded = true;
                background_terminals.extend(
                    response
                        .data
                        .into_iter()
                        .take(usize::from(RECONCILIATION_BACKGROUND_LIMIT)),
                );
                let Some(next_cursor) = response.next_cursor else {
                    background_authority = BackgroundSnapshotAuthority::Complete;
                    break;
                };
                if !seen_background_cursors.insert(next_cursor.clone()) {
                    break;
                }
                background_cursor = Some(next_cursor);
            }
        }
        if background_page_decoded {
            let mut activity = self.inner.activity.lock().await;
            if !self.reconciliation_is_current_locked(&pass, &activity) {
                return;
            }
            record_mutations.extend(
                activity
                    .tracker
                    .reconcile_background_terminals(
                        &background_terminals,
                        FIXED_EVENT_TIME,
                        background_authority,
                    )
                    .mutations,
            );
        }
        let (background_support, emit_background_warning) = {
            let mut activity = self.inner.activity.lock().await;
            if !self.reconciliation_is_current_locked(&pass, &activity) {
                return;
            }
            if background_incompatible {
                activity.background_list_support = ReconciliationMethodSupport::Unsupported;
            } else if background_page_decoded {
                activity.background_list_support = ReconciliationMethodSupport::Supported;
            }
            let emit_warning = background_incompatible
                && activity
                    .warned_incompatible_methods
                    .insert("thread/backgroundTerminals/list");
            (activity.background_list_support, emit_warning)
        };
        if emit_background_warning {
            self.emit_reconciliation(
                &pass,
                ReconciliationEmission::Warning(
                    "Codex activity method thread/backgroundTerminals/list is unsupported",
                ),
            )
            .await;
        }

        {
            let mut activity = self.inner.activity.lock().await;
            if !self.reconciliation_is_current_locked(&pass, &activity) {
                return;
            }
            activity.tracker.finish_detail_baseline();
        }

        let capabilities = ActivityCapabilities {
            actors: true,
            attributed_activity: true,
            background_work: background_support == ReconciliationMethodSupport::Supported,
            history_recovery: match (list_support, read_support) {
                (ReconciliationMethodSupport::Unsupported, _) => ActivityHistoryRecovery::None,
                (
                    ReconciliationMethodSupport::Supported,
                    ReconciliationMethodSupport::Supported,
                ) => ActivityHistoryRecovery::Full,
                _ => ActivityHistoryRecovery::Bounded,
            },
            terminal_observation: false,
        };
        let background_health = match background_support {
            ReconciliationMethodSupport::Supported => ActivitySectionHealth::live(),
            ReconciliationMethodSupport::Unsupported => ActivitySectionHealth::try_error(
                "Codex background tasks are unavailable for this runtime",
                false,
            )
            .expect("bounded background activity health"),
            ReconciliationMethodSupport::Unknown => ActivitySectionHealth::unsupported(),
        };
        let scope_mutations = vec![
            ProviderActivityMutation::SetScope {
                capabilities: capabilities.clone(),
                observation_state: ActivityObservationState::Live,
            },
            ProviderActivityMutation::SetSectionHealth {
                section: ActivitySection::BackgroundTasks,
                health: background_health,
            },
        ];
        let mutations = bounded_reconciliation_mutations(scope_mutations, record_mutations);
        self.emit_reconciliation(
            &pass,
            ReconciliationEmission::Successful {
                capabilities,
                mutations,
            },
        )
        .await;
    }

    async fn handle_incoming(&self, connection: JsonRpcConnection, event: IncomingEvent) {
        if *self.inner.explicit_close.lock().await {
            return;
        }
        match event {
            IncomingEvent::Notification {
                method,
                params,
                emitted_at_ms,
            } => {
                self.handle_notification(method, params, emitted_at_ms).await;
            }
            IncomingEvent::Request {
                correlation_id,
                wire_id,
                method,
                params,
            } => {
                if let Err(error) = self
                    .handle_request(connection, correlation_id, wire_id, method, params)
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
                let event_type = if FATAL_STDERR_SNIPPETS
                    .iter()
                    .any(|snippet| message.to_ascii_lowercase().contains(snippet))
                {
                    "runtime.error"
                } else {
                    "runtime.warning"
                };
                let payload = if event_type == "runtime.error" {
                    json!({
                        "message": message,
                        "class": "provider_error",
                    })
                } else {
                    json!({
                        "message": message,
                    })
                };
                self.emit(event_type, None, None, payload).await;
            }
            IncomingEvent::Closed { reason } => {
                if *self.inner.explicit_close.lock().await {
                    return;
                }
                let mut session = self.inner.session.lock().await;
                session.status = "closed".to_owned();
                session.active_turn_id = None;
                drop(session);
                self.emit("session.exited", None, None, json!({ "reason": reason }))
                    .await;
            }
        }
    }

    async fn handle_notification(&self, method: String, params: Value, emitted_at_ms: u64) {
        let notification_thread_id = params.get("threadId").and_then(Value::as_str);
        let session_root_thread_id = self.inner.session.lock().await.resume_cursor.clone();
        let (
            receive_sequence,
            activity_epoch,
            activity,
            request_reconciliation,
            is_root,
            is_verified_child,
        ) = {
            let mut state = self.inner.activity.lock().await;
            if !state.agent_activity_enabled {
                let is_root = notification_thread_id
                    .is_none_or(|thread_id| session_root_thread_id.as_deref() == Some(thread_id));
                (
                    0,
                    state.reconciliation_epoch,
                    Vec::new(),
                    false,
                    is_root,
                    false,
                )
            } else {
                let receive_sequence = state.next_receive_sequence;
                let Some(next_receive_sequence) = state.next_receive_sequence.checked_add(1) else {
                    return;
                };
                state.next_receive_sequence = next_receive_sequence;
                let output = state.tracker.handle_notification(
                    &method,
                    &params,
                    emitted_at_ms,
                    receive_sequence,
                );
                let is_root = notification_thread_id
                    .is_some_and(|thread_id| state.tracker.is_root_thread(thread_id));
                let is_verified_child = notification_thread_id
                    .is_some_and(|thread_id| state.tracker.is_verified_child(thread_id));
                (
                    receive_sequence,
                    state.reconciliation_epoch,
                    output.mutations,
                    output.request_reconciliation,
                    is_root,
                    is_verified_child,
                )
            }
        };
        if !activity.is_empty() {
            self.emit_activity(receive_sequence, activity_epoch, activity)
                .await;
        }
        if request_reconciliation {
            self.request_reconciliation(false).await;
        }
        if is_verified_child {
            return;
        }
        if notification_thread_id.is_some() && !is_root {
            return;
        }
        match method.as_str() {
            "thread/started" => {
                if let Some(thread_id) = params
                    .get("thread")
                    .and_then(|thread| thread.get("id"))
                    .and_then(Value::as_str)
                {
                    self.inner.session.lock().await.resume_cursor = Some(thread_id.to_owned());
                    let request_reconciliation = {
                        let mut activity = self.inner.activity.lock().await;
                        if !activity.agent_activity_enabled {
                            false
                        } else {
                            activity.tracker.set_root_thread_id(thread_id);
                            if activity.reconciled_root_thread_id.as_deref() == Some(thread_id) {
                                false
                            } else {
                                activity.reconciled_root_thread_id = Some(thread_id.to_owned());
                                true
                            }
                        }
                    };
                    if request_reconciliation {
                        self.request_reconciliation(true).await;
                    }
                }
            }
            "turn/started" => {
                let turn_id = params
                    .get("turn")
                    .and_then(|turn| turn.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(turn_id) = turn_id.clone() {
                    let mut session = self.inner.session.lock().await;
                    session.status = "running".to_owned();
                    session.active_turn_id = Some(turn_id.clone());
                    drop(session);
                    self.emit("turn.started", Some(turn_id), None, json!({}))
                        .await;
                }
            }
            "turn/completed" => {
                let turn_id = params
                    .get("turn")
                    .and_then(|turn| turn.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let state = params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let error = params
                    .get("turn")
                    .and_then(|turn| turn.get("error"))
                    .cloned();
                let mut session = self.inner.session.lock().await;
                session.status = if state == "failed" { "error" } else { "ready" }.to_owned();
                session.active_turn_id = None;
                drop(session);
                let mut payload = json!({ "state": state });
                if let Some(error) = error {
                    payload["error"] = error;
                }
                self.emit("turn.completed", turn_id, None, payload).await;
            }
            "item/agentMessage/delta" => {
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let delta = params
                    .get("delta")
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
            "item/started" => {
                if let Some((turn_id, payload)) = command_item_event_payload(&params, false) {
                    self.emit("item.started", Some(turn_id), None, payload)
                        .await;
                }
            }
            "item/completed" => {
                if let Some((turn_id, payload)) = command_item_event_payload(&params, true) {
                    self.emit("item.completed", Some(turn_id), None, payload)
                        .await;
                }
            }
            _ => {}
        }
    }

    async fn handle_request(
        &self,
        connection: JsonRpcConnection,
        correlation_id: String,
        wire_id: Value,
        method: String,
        params: Value,
    ) -> Result<(), RuntimeError> {
        match method.as_str() {
            "item/commandExecution/requestApproval" => {
                let request_id = format!("approval:{correlation_id}");
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.inner.pending_requests.lock().await.insert(
                    request_id.clone(),
                    PendingRequest {
                        kind: PendingRequestKind::CommandApproval,
                        wire_id,
                        turn_id: turn_id.clone(),
                    },
                );
                let detail = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .or_else(|| params.get("command").and_then(Value::as_str))
                    .unwrap_or_default();
                self.emit(
                    "request.opened",
                    turn_id,
                    Some(request_id),
                    json!({
                        "requestType": request_type(PendingRequestKind::CommandApproval),
                        "detail": detail,
                    }),
                )
                .await;
                Ok(())
            }
            "item/fileChange/requestApproval" => {
                let request_id = format!("approval:{correlation_id}");
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.inner.pending_requests.lock().await.insert(
                    request_id.clone(),
                    PendingRequest {
                        kind: PendingRequestKind::FileChangeApproval,
                        wire_id,
                        turn_id: turn_id.clone(),
                    },
                );
                let detail = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.emit(
                    "request.opened",
                    turn_id,
                    Some(request_id),
                    json!({
                        "requestType": request_type(PendingRequestKind::FileChangeApproval),
                        "detail": detail,
                    }),
                )
                .await;
                Ok(())
            }
            "item/tool/requestUserInput" => {
                let request_id = format!("user-input:{correlation_id}");
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.inner.pending_requests.lock().await.insert(
                    request_id.clone(),
                    PendingRequest {
                        kind: PendingRequestKind::UserInput,
                        wire_id,
                        turn_id: turn_id.clone(),
                    },
                );
                self.emit(
                    "user-input.requested",
                    turn_id,
                    Some(request_id),
                    json!({
                        "questions": normalize_questions(params.get("questions").cloned().unwrap_or(Value::Null)),
                    }),
                )
                .await;
                Ok(())
            }
            _ => {
                connection
                    .respond_error(
                        wire_id,
                        super::protocol::JsonRpcErrorShape {
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
        let event = RuntimeEvent {
            event_id: format!("evt-{}", *counter),
            provider: PROVIDER.to_owned(),
            created_at: FIXED_EVENT_TIME.to_owned(),
            event_type: event_type.to_owned(),
            thread_id: self.inner.options.thread_id.clone(),
            turn_id,
            request_id,
            payload,
            native_event_id: None,
            activity: Vec::new(),
        };
        let _ = self.inner.events_tx.send(event);
    }

    async fn emit_activity(
        &self,
        receive_sequence: u128,
        activity_epoch: u64,
        activity: Vec<crate::activity::ProviderActivityMutation>,
    ) {
        let mut counter = self.inner.event_counter.lock().await;
        let state = self.inner.activity.lock().await;
        if !state.agent_activity_enabled || state.reconciliation_epoch != activity_epoch {
            return;
        }
        *counter += 1;
        let event = RuntimeEvent {
            event_id: format!("evt-{}", *counter),
            provider: PROVIDER.to_owned(),
            created_at: FIXED_EVENT_TIME.to_owned(),
            event_type: "activity.native".to_owned(),
            thread_id: self.inner.options.thread_id.clone(),
            turn_id: None,
            request_id: None,
            payload: json!({}),
            native_event_id: Some(format!("codex:activity:{receive_sequence}")),
            activity,
        };
        let _ = self.inner.events_tx.send(event);
    }

    fn reconciliation_is_current_locked(
        &self,
        pass: &ReconciliationPass,
        activity: &RuntimeActivityState,
    ) -> bool {
        !pass.cancellation.is_cancelled()
            && activity.agent_activity_enabled
            && activity.reconciliation_epoch == pass.epoch
            && activity.tracker.is_root_thread(&pass.root_thread_id)
    }

    async fn reconciliation_epoch(&self) -> u64 {
        self.inner.activity.lock().await.reconciliation_epoch
    }

    async fn emit_reconciliation(
        &self,
        pass: &ReconciliationPass,
        emission: ReconciliationEmission,
    ) {
        let mut counter = self.inner.event_counter.lock().await;
        let mut activity_state = self.inner.activity.lock().await;
        if !self.reconciliation_is_current_locked(pass, &activity_state) {
            return;
        }
        let (event_type, payload, native_event_id, activity) = match emission {
            ReconciliationEmission::Successful {
                capabilities,
                mutations,
            } => {
                let sequence = activity_state.next_reconciliation_sequence;
                let Some(next) = sequence.checked_add(1) else {
                    return;
                };
                activity_state.capabilities = capabilities;
                activity_state.next_reconciliation_sequence = next;
                (
                    "activity.native",
                    json!({}),
                    Some(format!("codex:reconciliation:{sequence}")),
                    mutations,
                )
            }
            ReconciliationEmission::Stale => {
                let sequence = activity_state.next_reconciliation_sequence;
                let Some(next) = sequence.checked_add(1) else {
                    return;
                };
                activity_state.next_reconciliation_sequence = next;
                (
                    "activity.native",
                    json!({}),
                    Some(format!("codex:reconciliation:{sequence}")),
                    vec![ProviderActivityMutation::SetScope {
                        capabilities: activity_state.capabilities.clone(),
                        observation_state: ActivityObservationState::Stale,
                    }],
                )
            }
            ReconciliationEmission::Warning(message) => (
                "runtime.warning",
                json!({"message": message}),
                None,
                Vec::new(),
            ),
        };
        *counter += 1;
        let event = RuntimeEvent {
            event_id: format!("evt-{}", *counter),
            provider: PROVIDER.to_owned(),
            created_at: FIXED_EVENT_TIME.to_owned(),
            event_type: event_type.to_owned(),
            thread_id: self.inner.options.thread_id.clone(),
            turn_id: None,
            request_id: None,
            payload,
            native_event_id,
            activity,
        };
        let _ = self.inner.events_tx.send(event);
    }

    async fn provider_thread_id(&self) -> Result<String, RuntimeError> {
        self.inner
            .session
            .lock()
            .await
            .resume_cursor
            .clone()
            .ok_or(RuntimeError::MissingProviderThreadId)
    }
}

impl RuntimeInner {
    async fn options_resume_cursor_set(&self, resume_cursor: Option<String>) {
        let mut session = self.session.lock().await;
        session.resume_cursor = resume_cursor;
    }
}

fn merge_reconciliation_hints(
    current: ReconciliationHint,
    next: ReconciliationHint,
) -> ReconciliationHint {
    match next.epoch.cmp(&current.epoch) {
        std::cmp::Ordering::Greater => next,
        std::cmp::Ordering::Equal => ReconciliationHint {
            immediate: current.immediate || next.immediate,
            epoch: current.epoch,
        },
        std::cmp::Ordering::Less => current,
    }
}

fn bounded_reconciliation_mutations(
    mut scope_mutations: Vec<ProviderActivityMutation>,
    record_mutations: Vec<ProviderActivityMutation>,
) -> Vec<ProviderActivityMutation> {
    let mut structural_mutations = Vec::new();
    let mut history_entries = Vec::new();
    for (index, mutation) in record_mutations.into_iter().enumerate() {
        match mutation {
            ProviderActivityMutation::AppendEntry(entry) => {
                history_entries.push((index, entry));
            }
            mutation => structural_mutations.push(mutation),
        }
    }

    // Reconciliation admits at most 50 descendants and 128 background items.
    // Keeping both the discovery and terminal actor upserts therefore leaves
    // room for every structural mutation before history is considered.
    let structural_count = scope_mutations.len() + structural_mutations.len();
    assert!(
        structural_count <= RECONCILIATION_MUTATION_LIMIT,
        "bounded Codex reconciliation structural mutations"
    );
    let history_capacity = RECONCILIATION_MUTATION_LIMIT - structural_count;
    history_entries.sort_by(|(left_index, left), (right_index, right)| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left_index.cmp(right_index))
    });
    let drop_count = history_entries.len().saturating_sub(history_capacity);

    scope_mutations.extend(structural_mutations);
    scope_mutations.extend(
        history_entries
            .into_iter()
            .skip(drop_count)
            .map(|(_, entry)| ProviderActivityMutation::AppendEntry(entry)),
    );
    scope_mutations
}

fn method_is_incompatible(error: &ProtocolError) -> bool {
    matches!(
        error,
        ProtocolError::RemoteRequest { code: -32601, .. }
    )
}

fn request_type(kind: PendingRequestKind) -> &'static str {
    match kind {
        PendingRequestKind::CommandApproval => "command_execution_approval",
        PendingRequestKind::FileChangeApproval => "file_change_approval",
        PendingRequestKind::UserInput => "tool_user_input",
    }
}

fn command_item_event_payload(params: &Value, completed: bool) -> Option<(String, Value)> {
    let turn_id = params.get("turnId").and_then(Value::as_str)?.to_owned();
    let item = params.get("item")?;
    if item.get("type").and_then(Value::as_str) != Some("commandExecution") {
        return None;
    }
    let detail = item
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = if completed {
        json!({
            "itemType": "command_execution",
            "status": "completed",
            "title": "Ran command",
            "detail": detail,
        })
    } else {
        json!({
            "itemType": "command_execution",
            "title": "Ran command",
            "detail": detail,
        })
    };
    Some((turn_id, payload))
}

fn normalize_questions(value: Value) -> Value {
    let questions = value.as_array().cloned().unwrap_or_default();
    Value::Array(
        questions
            .into_iter()
            .filter_map(|question| {
                let id = question.get("id").and_then(Value::as_str)?;
                let header = question.get("header").and_then(Value::as_str)?;
                let prompt = question.get("question").and_then(Value::as_str)?;
                let options = question
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                Some(json!({
                    "id": id,
                    "header": header,
                    "question": prompt,
                    "options": options,
                    "multiSelect": false,
                }))
            })
            .collect(),
    )
}

fn normalize_user_input_answers(value: Value) -> Value {
    let answers = value.as_object().cloned().unwrap_or_default();
    let mut normalized = serde_json::Map::new();
    for (question_id, answer_value) in answers {
        let answer_array = answer_value
            .get("answers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if answer_array.len() == 1 {
            normalized.insert(question_id, answer_array[0].clone());
        } else {
            normalized.insert(question_id, Value::Array(answer_array));
        }
    }
    Value::Object(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::codex::protocol::ConnectionConfig;
    use tokio::{
        io::{
            AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, DuplexStream,
            duplex,
        },
        sync::oneshot,
        time::timeout,
    };

    fn runtime_test_connection() -> (
        JsonRpcConnection,
        mpsc::UnboundedReceiver<IncomingEvent>,
        DuplexStream,
        DuplexStream,
        DuplexStream,
    ) {
        let (runtime_stdout, peer_stdout) = duplex(16 * 1024);
        let (peer_stdin, runtime_stdin) = duplex(16 * 1024);
        let (peer_stderr, runtime_stderr) = duplex(16 * 1024);
        let (connection, incoming) = JsonRpcConnection::spawn(
            runtime_stdout,
            runtime_stdin,
            runtime_stderr,
            ConnectionConfig::default(),
        );
        (connection, incoming, peer_stdout, peer_stdin, peer_stderr)
    }

    async fn read_runtime_test_json(reader: &mut (impl AsyncBufRead + Unpin)) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("JSON-RPC line");
        serde_json::from_str(&line).expect("JSON-RPC message")
    }

    async fn write_runtime_test_json(writer: &mut (impl AsyncWrite + Unpin), message: Value) {
        writer
            .write_all(
                format!(
                    "{}\n",
                    serde_json::to_string(&message).expect("JSON-RPC serialization")
                )
                .as_bytes(),
            )
            .await
            .expect("JSON-RPC write");
        writer.flush().await.expect("JSON-RPC flush");
    }

    fn reconciliation_test_options() -> CodexSessionOptions {
        CodexSessionOptions {
            version: "0.1.1".to_owned(),
            thread_id: "fixture-thread".to_owned(),
            cwd: "/tmp/project".to_owned(),
            runtime_mode: CodexRuntimeMode::FullAccess,
            model: Some("gpt-5.3-codex".to_owned()),
            service_tier: None,
            effort: None,
            resume_cursor: None,
        }
    }

    #[derive(Debug, Eq, PartialEq)]
    struct ReconciliationStateSnapshot {
        tracker: String,
        thread_list_support: ReconciliationMethodSupport,
        thread_read_support: ReconciliationMethodSupport,
        background_list_support: ReconciliationMethodSupport,
        warned_incompatible_methods: Vec<&'static str>,
        capabilities: ActivityCapabilities,
        next_reconciliation_sequence: u64,
    }

    fn reconciliation_state_snapshot(state: &RuntimeActivityState) -> ReconciliationStateSnapshot {
        let mut warned_incompatible_methods = state
            .warned_incompatible_methods
            .iter()
            .copied()
            .collect::<Vec<_>>();
        warned_incompatible_methods.sort_unstable();
        ReconciliationStateSnapshot {
            tracker: format!("{:?}", state.tracker),
            thread_list_support: state.thread_list_support,
            thread_read_support: state.thread_read_support,
            background_list_support: state.background_list_support,
            warned_incompatible_methods,
            capabilities: state.capabilities.clone(),
            next_reconciliation_sequence: state.next_reconciliation_sequence,
        }
    }

    async fn drain_runtime_events(runtime: &CodexSessionRuntime) -> Vec<RuntimeEvent> {
        let mut receiver = runtime.inner.events_rx.lock().await;
        let mut events = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            events.push(event);
        }
        events
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelled_old_epoch_cannot_mutate_or_emit_after_response_wins() {
        let (connection_a, incoming_a, peer_stdout_a, peer_stdin_a, _peer_stderr_a) =
            runtime_test_connection();
        let runtime =
            CodexSessionRuntime::new(reconciliation_test_options(), connection_a, incoming_a);
        let (send_root_tx, send_root_rx) = oneshot::channel();
        let (background_seen_tx, background_seen_rx) = oneshot::channel();
        let (release_background_tx, release_background_rx) = oneshot::channel();
        let (background_replied_tx, background_replied_rx) = oneshot::channel();
        let old_peer = tokio::spawn(async move {
            let mut reader = BufReader::new(peer_stdin_a);
            let mut writer = peer_stdout_a;
            let initialize = read_runtime_test_json(&mut reader).await;
            write_runtime_test_json(
                &mut writer,
                json!({"id": initialize["id"].clone(), "result": {}}),
            )
            .await;
            assert_eq!(
                read_runtime_test_json(&mut reader).await["method"],
                "initialized"
            );
            let start = read_runtime_test_json(&mut reader).await;
            write_runtime_test_json(
                &mut writer,
                json!({
                    "id": start["id"].clone(),
                    "result": {
                        "thread": {"id": "old-root"},
                        "cwd": "/tmp/project",
                        "model": "gpt-5.3-codex"
                    }
                }),
            )
            .await;
            send_root_rx.await.expect("release old root notification");
            write_runtime_test_json(
                &mut writer,
                json!({
                    "method": "thread/started",
                    "params": {"thread": {"id": "old-root"}},
                    "emittedAtMs": 1_000
                }),
            )
            .await;
            let list = read_runtime_test_json(&mut reader).await;
            assert_eq!(list["method"], "thread/list");
            write_runtime_test_json(
                &mut writer,
                json!({
                    "id": list["id"].clone(),
                    "result": {
                        "data": [{
                            "id": "old-child",
                            "parentThreadId": "old-root",
                            "createdAt": 1,
                            "updatedAt": 2,
                            "status": {"type": "idle"}
                        }],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            )
            .await;
            let read = read_runtime_test_json(&mut reader).await;
            assert_eq!(read["method"], "thread/read");
            write_runtime_test_json(
                &mut writer,
                json!({
                    "id": read["id"].clone(),
                    "result": {
                        "thread": {
                            "id": "old-child",
                            "parentThreadId": "old-root",
                            "createdAt": 1,
                            "updatedAt": 2,
                            "status": {"type": "idle"},
                            "turns": []
                        }
                    }
                }),
            )
            .await;
            let background = read_runtime_test_json(&mut reader).await;
            assert_eq!(background["method"], "thread/backgroundTerminals/list");
            let _ = background_seen_tx.send(());
            release_background_rx
                .await
                .expect("release old background response");
            write_runtime_test_json(
                &mut writer,
                json!({
                    "id": background["id"].clone(),
                    "result": {
                        "data": [{
                            "itemId": "old-background",
                            "processId": "old-process",
                            "command": "old command"
                        }],
                        "nextCursor": null
                    }
                }),
            )
            .await;
            let _ = background_replied_tx.send(());
        });

        runtime.start().await.expect("old runtime starts");
        runtime.collect_events(2).await;
        send_root_tx.send(()).expect("send old root notification");
        background_seen_rx
            .await
            .expect("old pass reaches final request");
        let activity_guard = runtime.inner.activity.lock().await;
        let old_pass_cancellation = activity_guard.reconciliation_pass_cancellation.clone();

        let (connection_b, incoming_b, peer_stdout_b, peer_stdin_b, _peer_stderr_b) =
            runtime_test_connection();
        let (initialize_seen_tx, initialize_seen_rx) = oneshot::channel();
        let (release_initialize_tx, release_initialize_rx) = oneshot::channel();
        let new_peer = tokio::spawn(async move {
            let mut reader = BufReader::new(peer_stdin_b);
            let mut writer = peer_stdout_b;
            let initialize = read_runtime_test_json(&mut reader).await;
            initialize_seen_tx
                .send(())
                .expect("record replacement initialize");
            release_initialize_rx
                .await
                .expect("release replacement initialize");
            write_runtime_test_json(
                &mut writer,
                json!({"id": initialize["id"].clone(), "result": {}}),
            )
            .await;
            assert_eq!(
                read_runtime_test_json(&mut reader).await["method"],
                "initialized"
            );
            let resume = read_runtime_test_json(&mut reader).await;
            assert_eq!(resume["method"], "thread/resume");
            assert_eq!(resume["params"]["threadId"], "old-root");
            write_runtime_test_json(
                &mut writer,
                json!({
                    "id": resume["id"].clone(),
                    "result": {
                        "thread": {"id": "new-root"},
                        "cwd": "/tmp/project",
                        "model": "gpt-5.3-codex"
                    }
                }),
            )
            .await;
            let list = read_runtime_test_json(&mut reader).await;
            assert_eq!(list["method"], "thread/list");
            assert_eq!(list["params"]["ancestorThreadId"], "new-root");
            write_runtime_test_json(
                &mut writer,
                json!({
                    "id": list["id"].clone(),
                    "result": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            )
            .await;
            let background = read_runtime_test_json(&mut reader).await;
            assert_eq!(background["method"], "thread/backgroundTerminals/list");
            assert_eq!(background["params"]["threadId"], "new-root");
            write_runtime_test_json(
                &mut writer,
                json!({
                    "id": background["id"].clone(),
                    "result": {"data": [], "nextCursor": null}
                }),
            )
            .await;
            let shutdown = read_runtime_test_json(&mut reader).await;
            assert_eq!(shutdown["method"], "shutdown");
            write_runtime_test_json(
                &mut writer,
                json!({"id": shutdown["id"].clone(), "result": null}),
            )
            .await;
        });
        let reconnect_runtime = runtime.clone();
        let reconnect =
            tokio::spawn(
                async move { reconnect_runtime.reconnect(connection_b, incoming_b).await },
            );
        assert!(
            timeout(
                Duration::from_millis(100),
                old_pass_cancellation.cancelled()
            )
            .await
            .is_err(),
            "the replacement transition must serialize behind the activity state boundary"
        );
        release_background_tx
            .send(())
            .expect("release old background response");
        background_replied_rx
            .await
            .expect("old response is on the transport");
        tokio::task::yield_now().await;
        let state_before_transition = reconciliation_state_snapshot(&activity_guard);
        let _ = drain_runtime_events(&runtime).await;
        drop(activity_guard);
        initialize_seen_rx
            .await
            .expect("replacement transition reaches initialize");
        let state_after_transition = {
            let activity = runtime.inner.activity.lock().await;
            reconciliation_state_snapshot(&activity)
        };
        assert_eq!(
            state_after_transition, state_before_transition,
            "the old pass must not mutate reconciliation state after the replacement transition"
        );
        let leaked_events = drain_runtime_events(&runtime)
            .await
            .into_iter()
            .filter(|event| {
                event
                    .native_event_id
                    .as_deref()
                    .is_some_and(|native_id| native_id.starts_with("codex:reconciliation:"))
                    || (event.event_type == "runtime.warning"
                        && event.payload["message"]
                            .as_str()
                            .is_some_and(|message| message.contains("Codex activity method")))
            })
            .collect::<Vec<_>>();
        assert!(
            leaked_events.is_empty(),
            "the old pass must not publish reconciliation events after the replacement transition"
        );
        release_initialize_tx
            .send(())
            .expect("release replacement initialize");
        reconnect
            .await
            .expect("reconnect task")
            .expect("runtime reconnects");

        let reconciliation = timeout(Duration::from_secs(1), async {
            loop {
                let event = runtime.next_event().await.expect("runtime event");
                if event.native_event_id.as_deref() == Some("codex:reconciliation:0") {
                    break event;
                }
            }
        })
        .await
        .expect("new-root reconciliation");
        assert!(
            reconciliation.activity.iter().all(|mutation| match mutation {
                ProviderActivityMutation::UpsertActor(actor) => {
                    actor.id != "codex:thread:old-child"
                }
                ProviderActivityMutation::UpsertWorkItem(work_item) => {
                    work_item.id != "codex:item:old-background"
                }
                _ => true,
            }),
            "the cancelled old epoch must not emit records into the replacement scope"
        );
        assert_eq!(
            runtime.inner.activity.lock().await.tracker.state_counts(),
            crate::provider::codex::activity::CodexActivityStateCounts {
                actors: 0,
                work_items: 0,
                seen_events: 0,
                pending_deltas: 0,
            }
        );

        runtime.shutdown().await.expect("runtime shuts down");
        old_peer.await.expect("old peer");
        new_peer.await.expect("new peer");
    }

    #[tokio::test]
    async fn immediate_hint_supersedes_a_queued_deferred_hint() {
        let (connection, incoming, peer_stdout, peer_stdin, _peer_stderr) =
            runtime_test_connection();
        let runtime = CodexSessionRuntime::new(reconciliation_test_options(), connection, incoming);
        runtime.inner.session.lock().await.resume_cursor = Some("provider-root".to_owned());
        runtime
            .inner
            .activity
            .lock()
            .await
            .tracker
            .set_root_thread_id("provider-root");

        let (list_seen_tx, list_seen_rx) = oneshot::channel();
        let peer = tokio::spawn(async move {
            let mut reader = BufReader::new(peer_stdin);
            let mut writer = peer_stdout;
            let mut list_seen_tx = Some(list_seen_tx);
            loop {
                let request = read_runtime_test_json(&mut reader).await;
                match request["method"].as_str().expect("request method") {
                    "thread/list" => {
                        if let Some(list_seen_tx) = list_seen_tx.take() {
                            let _ = list_seen_tx.send(());
                        }
                        write_runtime_test_json(
                            &mut writer,
                            json!({
                                "id": request["id"].clone(),
                                "result": {
                                    "data": [],
                                    "nextCursor": null,
                                    "backwardsCursor": null
                                }
                            }),
                        )
                        .await;
                    }
                    "thread/backgroundTerminals/list" => {
                        write_runtime_test_json(
                            &mut writer,
                            json!({
                                "id": request["id"].clone(),
                                "result": {"data": [], "nextCursor": null}
                            }),
                        )
                        .await;
                    }
                    "shutdown" => {
                        write_runtime_test_json(
                            &mut writer,
                            json!({"id": request["id"].clone(), "result": null}),
                        )
                        .await;
                        break;
                    }
                    other => panic!("unexpected immediate-hint request: {other}"),
                }
            }
        });

        runtime.request_reconciliation(false).await;
        runtime.request_reconciliation(true).await;
        let immediate = timeout(Duration::from_millis(100), list_seen_rx).await;

        runtime.shutdown().await.expect("runtime shuts down");
        peer.await.expect("peer");
        assert!(
            immediate.is_ok(),
            "an immediate hint must replace a queued deferred hint without waiting 250ms"
        );
    }

    #[test]
    fn user_input_normalization_filters_questions_and_flattens_single_answers() {
        assert_eq!(
            normalize_questions(json!([
                {
                    "id":"choice",
                    "header":"Choice",
                    "question":"Pick one",
                    "options":[{"label":"A","description":"First"}]
                },
                {"id":"missing-fields"}
            ])),
            json!([{
                "id":"choice",
                "header":"Choice",
                "question":"Pick one",
                "options":[{"label":"A","description":"First"}],
                "multiSelect":false
            }])
        );
        assert_eq!(normalize_questions(Value::Null), json!([]));
        assert_eq!(
            normalize_user_input_answers(json!({
                "choice":{"answers":["A"]},
                "multiple":{"answers":["A","B"]},
                "missing":{}
            })),
            json!({"choice":"A","multiple":["A","B"],"missing":[]})
        );
        assert_eq!(normalize_user_input_answers(Value::Null), json!({}));
    }
}
