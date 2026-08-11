use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    ffi::{OsStr, OsString},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime},
};

use crate::{
    activity::{
        ACTIVITY_ID_MAX_LENGTH, ActivityCancellationDispatcher, ActivityCancellationService,
        ActivityCapabilities, ActivityDispatchError, ActivityHistoryRecovery,
        ActivityObservationState, ActivityProjection, ActivityRepositoryError,
        ActivityRuntimeGeneration, ActivityScopeRef, ActivityScopeSeed, ActivitySection,
        ActivitySectionHealth, ActivitySummaryCounts, ActivityTargetDispatchDisposition,
        AgentActivityController, ProviderActivityMutation, ProviderActivityNativeTarget,
    },
    diagnostics::{
        AttributionKind, AttributionScope, NativeProcessSampler, ProcessAttributionRegistry,
        ProcessRegistration, ProcessRegistrationMetadata, RegistrationSource,
    },
    orchestration::{
        ProviderTurnDelivery, TurnDeliveryState, canonical_command_digest,
        engine::{
            ActivityInput, OrchestrationCommand, OrchestrationEngine, ProposedPlanInput,
            SessionInput,
        },
        load_snapshot,
    },
    persistence::{ProviderSessionRuntime, Repositories},
    process::{
        Platform, PreparedLaunch, configure_supervised_background_command_wrap,
        launch_executable_extensions, locate_executable,
        supervised::{
            SupervisedOverflow, SupervisedRunRequest, log_cleanup_failures, run_supervised,
            terminate_and_wait,
        },
        wrap_launch_program,
    },
    production::{
        connect_mcp::ConnectMcpService, operational_logs::ProviderOperationalLog,
        orchestration_effects::process_compatible_path,
    },
    provider::{
        attachments::{
            AttachmentMaterializer, MaterializedAttachment, append_file_references,
            split_native_images_and_file_references,
        },
        claude::{
            CanonicalEvent as ClaudeCanonicalEvent, ClaudeControlRequest,
            ClaudeControlResponseFrame, ClaudeProviderRuntime, Decision,
            RuntimeMode as ClaudeRuntimeMode,
            hook_sink::{
                CLAUDE_HOOK_TOKEN_ENV, ClaudeHookSinkHandle, claude_hook_settings,
                start_claude_hook_sink,
            },
            transcript::{
                ClaudeRecoveredTranscript, ClaudeTranscriptRecoveryRequest, recover_transcript,
            },
        },
        codex::{
            CodexHomeLayout, CodexRuntimeMode, CodexSessionOptions, CodexSessionRuntime,
            ConnectionConfig, JsonRpcConnection, materialize_codex_shadow_home,
            resolve_codex_home_layout,
        },
        cursor::{
            AcpConnectionConfig as CursorConnectionConfig,
            AcpJsonRpcConnection as CursorConnection, CursorSessionOptions, CursorSessionRuntime,
            runtime::CursorRuntimeError,
        },
        grok::{
            AcpConnectionConfig as GrokConnectionConfig, AcpJsonRpcConnection as GrokConnection,
            GrokSessionOptions, GrokSessionRuntime,
        },
        opencode::OpenCodeSessionRuntime,
    },
    server_settings::{ProviderBinarySettingsState, ProviderSettingsStore},
};
use process_wrap::tokio::{ChildWrapper, CommandWrap};
use serde_json::{Value, json};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{Mutex, RwLock, mpsc, oneshot},
    task::JoinHandle,
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type BoxRuntimeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const DEFAULT_QUEUE_CAPACITY: usize = 32;
const DEFAULT_EVENT_QUEUE_CAPACITY: usize = 128;
const DEFAULT_SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const ACTIVITY_ONLY_PROVIDER_EVENT_TYPE: &str = "activity.native";
const DELIVERY_ROUTE_FINGERPRINT_FIELD: &str = "_bibcodeProviderRouteFingerprint";
const DELIVERY_ROUTE_CWD_PENDING_FIELD: &str = "_bibcodeProviderRouteCwdPending";
const DELIVERY_ROUTE_FINGERPRINT_VERSION: &str = "provider-route-v4";
const DELIVERY_ROUTE_CWD_FINGERPRINT_VERSION: &str = "provider-route-cwd-v1";

/// Prevent host diagnostics settings from turning provider stderr into a high-volume event stream.
pub(crate) fn sanitize_provider_subprocess_environment(command: &mut tokio::process::Command) {
    command.env_remove("RUST_LOG");
}

#[derive(Clone, Debug)]
pub struct ProviderLaunchRequest {
    pub thread_id: String,
    pub activity_causal_revision: u64,
    pub provider: String,
    pub provider_label: String,
    pub provider_instance_id: Option<String>,
    pub binary_path: String,
    pub cwd: PathBuf,
    pub runtime_mode: String,
    pub interaction_mode: String,
    pub model: Option<String>,
    pub options: Vec<Value>,
    pub service_tier: Option<String>,
    pub effort: Option<String>,
    pub agent: Option<String>,
    pub resume_cursor: Option<Value>,
    pub environment: BTreeMap<String, String>,
    pub endpoint: Option<String>,
    pub server_password: Option<String>,
    pub mcp: Option<ProviderMcpConfig>,
    pub codex_home: Option<CodexHomeLayout>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderMcpConfig {
    pub endpoint: String,
    pub authorization_header: String,
    pub provider_session_id: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StartedSession {
    pub resume_cursor: Option<Value>,
    pub runtime_payload: Option<Value>,
    pub activity_capabilities: ActivityCapabilities,
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProviderNativeEventId(String);

impl ProviderNativeEventId {
    pub fn new(value: String) -> Result<Self, ProviderNativeEventIdError> {
        if value.trim().is_empty() {
            return Err(ProviderNativeEventIdError::Empty);
        }
        if value.chars().count() > ACTIVITY_ID_MAX_LENGTH {
            return Err(ProviderNativeEventIdError::TooLong);
        }
        if value.chars().any(char::is_control) {
            return Err(ProviderNativeEventIdError::ControlCharacter);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for ProviderNativeEventId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("ProviderNativeEventId")
            .field(&self.0)
            .finish()
    }
}

impl TryFrom<String> for ProviderNativeEventId {
    type Error = ProviderNativeEventIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ProviderNativeEventIdError {
    #[error("provider native event id must not be empty")]
    Empty,
    #[error("provider native event id exceeds its bound")]
    TooLong,
    #[error("provider native event id contains a control character")]
    ControlCharacter,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderEvent {
    pub native_event_id: Option<ProviderNativeEventId>,
    pub event_type: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub request_id: Option<String>,
    pub payload: Value,
    pub activity: Vec<ProviderActivityMutation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderDeliveryOutcome {
    Accepted { turn_id: Option<String> },
    DefinitelyNotSent { detail: String },
    Ambiguous { detail: String },
    Rejected { detail: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderReconciliationOutcome {
    Found,
    Absent,
    Unavailable { detail: String },
}

pub struct ProviderDeliveryHandle {
    completion: oneshot::Receiver<ProviderDeliveryOutcome>,
}

impl ProviderDeliveryHandle {
    pub async fn completion(self) -> ProviderDeliveryOutcome {
        self.completion
            .await
            .unwrap_or_else(|_| ProviderDeliveryOutcome::Ambiguous {
                detail: "provider delivery task ended without an outcome".to_owned(),
            })
    }
}

pub trait ProviderDriver: Send + Sync {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>>;
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        interaction_mode: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>>;
    fn deliver(
        &self,
        text: String,
        attachments: Vec<Value>,
        interaction_mode: String,
        _delivery_key: String,
    ) -> BoxRuntimeFuture<'_, ProviderDeliveryOutcome> {
        Box::pin(async move {
            match self.send(text, attachments, interaction_mode).await {
                Ok(turn_id) => ProviderDeliveryOutcome::Accepted { turn_id },
                Err(error) => ProviderDeliveryOutcome::Ambiguous {
                    detail: error.to_string(),
                },
            }
        })
    }
    fn reconcile(
        &self,
        _delivery_key: String,
    ) -> BoxRuntimeFuture<'_, ProviderReconciliationOutcome> {
        Box::pin(async {
            ProviderReconciliationOutcome::Unavailable {
                detail: "provider does not support exact delivery reconciliation".to_owned(),
            }
        })
    }
    fn interrupt(
        &self,
        turn_id: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn set_interaction_mode(
        &self,
        _mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async { Ok(()) })
    }
    fn set_agent_activity_enabled(
        &self,
        _enabled: bool,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async { Ok(()) })
    }
    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn reapply_options_on_model_change(&self) -> bool {
        false
    }
    fn set_options(
        &self,
        options: Vec<Value>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn rollback(&self, turn_count: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>>;
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>>;
}

pub trait ProviderDriverFactory: Send + Sync {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>>;
}

#[derive(Clone, Debug)]
pub struct SupervisorOptions {
    pub queue_capacity: usize,
    pub session_idle_timeout: Duration,
}

impl Default for SupervisorOptions {
    fn default() -> Self {
        Self {
            queue_capacity: DEFAULT_QUEUE_CAPACITY,
            session_idle_timeout: DEFAULT_SESSION_IDLE_TIMEOUT,
        }
    }
}

#[derive(Debug, Error)]
pub enum ProviderRuntimeError {
    #[error("provider runtime supervisor is shut down")]
    Shutdown,
    #[error("provider runtime command queue is closed")]
    QueueClosed,
    #[error("provider runtime response was dropped")]
    ResponseDropped,
    #[error("thread {thread_id} has no active provider runtime")]
    SessionNotFound { thread_id: String },
    #[error(
        "cannot perform {action} for thread {thread_id}: the provider session is stale or was lost after restart; start a new turn to relaunch the provider runtime"
    )]
    StaleSession { thread_id: String, action: String },
    #[error("thread {thread_id} already has an active provider runtime")]
    SessionAlreadyExists { thread_id: String },
    #[error("provider {provider} is not supported")]
    UnsupportedProvider { provider: String },
    #[error("provider {provider} does not support {capability} while a session is running")]
    UnsupportedCapability {
        provider: String,
        capability: &'static str,
    },
    #[error("failed to spawn {provider} provider process: {detail}")]
    Spawn { provider: String, detail: String },
    #[error("{provider} provider operation failed: {detail}")]
    Provider { provider: String, detail: String },
    #[error("provider runtime persistence failed: {0}")]
    Persistence(String),
    #[error("provider event projection failed: {0}")]
    Orchestration(String),
}

#[derive(Clone)]
pub struct ProviderRuntimeSupervisor {
    sender: mpsc::Sender<SupervisorMessage>,
    stopped: CancellationToken,
    worker: Arc<Mutex<Option<JoinHandle<()>>>>,
    connect_mcp: Arc<RwLock<Option<Arc<ConnectMcpService>>>>,
    activity_cancellation: Arc<RwLock<Option<ActivityCancellationService>>>,
}

enum SupervisorMessage {
    Launch {
        request: Box<ProviderLaunchRequest>,
        response: oneshot::Sender<Result<(), ProviderRuntimeError>>,
    },
    Handle {
        command: Box<OrchestrationCommand>,
        response: oneshot::Sender<Result<(), ProviderRuntimeError>>,
    },
    Deliver {
        command: Box<OrchestrationCommand>,
        delivery_key: String,
        frozen_delivery: Option<Box<ProviderTurnDelivery>>,
        response: oneshot::Sender<Result<ProviderDeliveryHandle, ProviderRuntimeError>>,
    },
    Reconcile {
        row: Box<ProviderTurnDelivery>,
        response: oneshot::Sender<Result<ProviderReconciliationOutcome, ProviderRuntimeError>>,
    },
    SetAgentActivityEnabled {
        enabled: bool,
        response: oneshot::Sender<Result<usize, ProviderRuntimeError>>,
    },
    Shutdown {
        response: oneshot::Sender<Result<(), ProviderRuntimeError>>,
    },
    DeliveryComplete {
        thread_id: String,
        generation: u64,
        abnormal: bool,
    },
    DrainDeferred {
        thread_id: String,
        generation: u64,
    },
    SuspendIdle {
        thread_id: String,
        idle_generation: Arc<AtomicU64>,
        generation: u64,
    },
}

struct SessionEntry {
    launch: ProviderLaunchRequest,
    driver: Arc<dyn ProviderDriver>,
    configuration_healthy: bool,
    resume_cursor: Option<Value>,
    runtime_payload: Option<Value>,
    activity_capable: bool,
    activity_lifecycle: SharedActivityLifecycle,
    activity_compensation_key: String,
    event_task: JoinHandle<()>,
    event_cancellation: CancellationToken,
    idle_generation: Arc<AtomicU64>,
    terminal_sender: mpsc::UnboundedSender<SupervisorMessage>,
    idle_timeout: Duration,
}

struct DetachedSession {
    launch: ProviderLaunchRequest,
    driver: Arc<dyn ProviderDriver>,
    resume_cursor: Option<Value>,
    runtime_payload: Option<Value>,
}

#[derive(Default)]
struct ThreadDeliverySequence {
    active_generation: Option<u64>,
    completed_generation: u64,
}

struct DeliveryTerminalGuard {
    sender: mpsc::UnboundedSender<SupervisorMessage>,
    thread_id: String,
    generation: u64,
    completed: bool,
}

impl DeliveryTerminalGuard {
    fn complete(mut self) {
        self.completed = true;
        let _ = self.sender.send(SupervisorMessage::DeliveryComplete {
            thread_id: self.thread_id.clone(),
            generation: self.generation,
            abnormal: false,
        });
    }
}

impl Drop for DeliveryTerminalGuard {
    fn drop(&mut self) {
        if !self.completed {
            let _ = self.sender.send(SupervisorMessage::DeliveryComplete {
                thread_id: self.thread_id.clone(),
                generation: self.generation,
                abnormal: true,
            });
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct RetainedActivitySections {
    actors: bool,
    background_work: bool,
}

#[derive(Clone, Debug)]
struct ProviderActivityLifecycleState {
    capabilities: ActivityCapabilities,
    retained: RetainedActivitySections,
    runtime_observed_capabilities: bool,
}

type SharedActivityLifecycle = Arc<StdMutex<ProviderActivityLifecycleState>>;

impl RetainedActivitySections {
    fn from_counts(counts: &ActivitySummaryCounts) -> Self {
        Self {
            actors: counts.subagents.active > 0 || counts.subagents.done > 0,
            background_work: counts.background_tasks.active > 0 || counts.background_tasks.done > 0,
        }
    }

    fn retain(&mut self, other: Self) {
        self.actors |= other.actors;
        self.background_work |= other.background_work;
    }
}

impl ProviderActivityLifecycleState {
    fn new(capabilities: ActivityCapabilities) -> Self {
        Self {
            capabilities,
            retained: RetainedActivitySections::default(),
            runtime_observed_capabilities: false,
        }
    }

    fn apply_startup_capabilities(
        &mut self,
        startup_capabilities: ActivityCapabilities,
    ) -> ActivityCapabilities {
        if !self.runtime_observed_capabilities
            || startup_capabilities != ActivityCapabilities::none()
        {
            self.capabilities = startup_capabilities;
            self.runtime_observed_capabilities = false;
        }
        self.capabilities.clone()
    }

    fn observe_projected_batch(&mut self, mutations: &[ProviderActivityMutation]) {
        for mutation in mutations {
            match mutation {
                ProviderActivityMutation::SetScope { capabilities, .. } => {
                    self.capabilities = capabilities.clone();
                    self.runtime_observed_capabilities = true;
                }
                ProviderActivityMutation::UpsertActor(_) => self.retained.actors = true,
                ProviderActivityMutation::UpsertWorkItem(_) => {
                    self.retained.background_work = true;
                }
                _ => {}
            }
        }
    }

    fn synchronize_projected_snapshot(
        &mut self,
        capabilities: ActivityCapabilities,
        counts: &ActivitySummaryCounts,
    ) {
        self.retained
            .retain(RetainedActivitySections::from_counts(counts));
        if self.capabilities != capabilities {
            self.capabilities = capabilities;
            self.runtime_observed_capabilities = true;
        }
    }
}

impl ProviderRuntimeSupervisor {
    #[must_use]
    pub fn start(
        engine: OrchestrationEngine,
        factory: Arc<dyn ProviderDriverFactory>,
        activity: ActivityProjection,
        options: SupervisorOptions,
    ) -> Self {
        Self::start_inner(engine, factory, activity, options, None)
    }

    #[must_use]
    pub(crate) fn start_with_operational_log(
        engine: OrchestrationEngine,
        factory: Arc<dyn ProviderDriverFactory>,
        activity: ActivityProjection,
        options: SupervisorOptions,
        operational_log: ProviderOperationalLog,
    ) -> Self {
        Self::start_inner(engine, factory, activity, options, Some(operational_log))
    }

    fn start_inner(
        engine: OrchestrationEngine,
        factory: Arc<dyn ProviderDriverFactory>,
        activity: ActivityProjection,
        options: SupervisorOptions,
        operational_log: Option<ProviderOperationalLog>,
    ) -> Self {
        let queue_capacity = options.queue_capacity.max(1);
        let session_idle_timeout = options.session_idle_timeout;
        let (sender, receiver) = mpsc::channel(queue_capacity);
        let (terminal_sender, terminal_receiver) = mpsc::unbounded_channel();
        let stopped = CancellationToken::new();
        let worker_stopped = stopped.clone();
        let worker_sender = sender.clone();
        let worker = tokio::spawn(async move {
            run_supervisor(
                engine,
                factory,
                activity,
                receiver,
                worker_sender,
                terminal_sender,
                terminal_receiver,
                queue_capacity,
                session_idle_timeout,
                worker_stopped,
                operational_log,
            )
            .await;
        });
        Self {
            sender,
            stopped,
            worker: Arc::new(Mutex::new(Some(worker))),
            connect_mcp: Arc::new(RwLock::new(None)),
            activity_cancellation: Arc::new(RwLock::new(None)),
        }
    }

    pub(crate) async fn attach_activity_cancellation(&self, service: ActivityCancellationService) {
        *self.activity_cancellation.write().await = Some(service);
    }

    pub async fn attach_connect_mcp(&self, service: Arc<ConnectMcpService>) {
        *self.connect_mcp.write().await = Some(service);
    }

    pub async fn launch(
        &self,
        mut request: ProviderLaunchRequest,
    ) -> Result<(), ProviderRuntimeError> {
        if request.mcp.is_none()
            && let Some(connect) = self.connect_mcp.read().await.clone()
        {
            let provider_instance_id = request
                .provider_instance_id
                .clone()
                .unwrap_or_else(|| request.provider.clone());
            let issued = connect
                .issue_mcp_credential(request.thread_id.clone(), provider_instance_id)
                .await
                .map_err(|error| ProviderRuntimeError::Provider {
                    provider: request.provider.clone(),
                    detail: format!("could not issue BiBCode MCP credential: {error:?}"),
                })?;
            request.mcp = Some(ProviderMcpConfig {
                endpoint: issued.endpoint,
                authorization_header: issued.authorization_header,
                provider_session_id: issued.provider_session_id,
            });
        }
        self.request(|response| SupervisorMessage::Launch {
            request: Box::new(request),
            response,
        })
        .await
    }

    pub async fn handle_orchestration(
        &self,
        command: OrchestrationCommand,
    ) -> Result<(), ProviderRuntimeError> {
        self.request(|response| SupervisorMessage::Handle {
            command: Box::new(command),
            response,
        })
        .await
    }

    pub async fn deliver_turn(
        &self,
        command: OrchestrationCommand,
        delivery_key: String,
    ) -> Result<ProviderDeliveryHandle, ProviderRuntimeError> {
        if self.stopped.is_cancelled() {
            return Err(ProviderRuntimeError::Shutdown);
        }
        let (response_tx, response_rx) = oneshot::channel();
        self.sender
            .send(SupervisorMessage::Deliver {
                command: Box::new(command),
                delivery_key,
                frozen_delivery: None,
                response: response_tx,
            })
            .await
            .map_err(|_| ProviderRuntimeError::QueueClosed)?;
        response_rx
            .await
            .map_err(|_| ProviderRuntimeError::ResponseDropped)?
    }

    async fn deliver_frozen_turn(
        &self,
        command: OrchestrationCommand,
        row: ProviderTurnDelivery,
    ) -> Result<ProviderDeliveryHandle, ProviderRuntimeError> {
        if self.stopped.is_cancelled() {
            return Err(ProviderRuntimeError::Shutdown);
        }
        let (response_tx, response_rx) = oneshot::channel();
        self.sender
            .send(SupervisorMessage::Deliver {
                command: Box::new(command),
                delivery_key: row.delivery_key.clone(),
                frozen_delivery: Some(Box::new(row)),
                response: response_tx,
            })
            .await
            .map_err(|_| ProviderRuntimeError::QueueClosed)?;
        response_rx
            .await
            .map_err(|_| ProviderRuntimeError::ResponseDropped)?
    }

    pub async fn reconcile_turn(
        &self,
        row: ProviderTurnDelivery,
    ) -> Result<ProviderReconciliationOutcome, ProviderRuntimeError> {
        if self.stopped.is_cancelled() {
            return Err(ProviderRuntimeError::Shutdown);
        }
        let (response_tx, response_rx) = oneshot::channel();
        self.sender
            .send(SupervisorMessage::Reconcile {
                row: Box::new(row),
                response: response_tx,
            })
            .await
            .map_err(|_| ProviderRuntimeError::QueueClosed)?;
        response_rx
            .await
            .map_err(|_| ProviderRuntimeError::ResponseDropped)?
    }

    pub async fn set_agent_activity_enabled(
        &self,
        enabled: bool,
    ) -> Result<usize, ProviderRuntimeError> {
        if self.stopped.is_cancelled() {
            return Err(ProviderRuntimeError::Shutdown);
        }
        let (response_tx, response_rx) = oneshot::channel();
        self.sender
            .send(SupervisorMessage::SetAgentActivityEnabled {
                enabled,
                response: response_tx,
            })
            .await
            .map_err(|_| ProviderRuntimeError::QueueClosed)?;
        response_rx
            .await
            .map_err(|_| ProviderRuntimeError::ResponseDropped)?
    }

    pub async fn shutdown(&self) -> Result<(), ProviderRuntimeError> {
        if self.stopped.is_cancelled() {
            return Ok(());
        }
        let result = self
            .request(|response| SupervisorMessage::Shutdown { response })
            .await;
        if let Some(worker) = self.worker.lock().await.take() {
            let _ = worker.await;
        }
        self.activity_cancellation.write().await.take();
        result
    }

    async fn request(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<(), ProviderRuntimeError>>) -> SupervisorMessage,
    ) -> Result<(), ProviderRuntimeError> {
        if self.stopped.is_cancelled() {
            return Err(ProviderRuntimeError::Shutdown);
        }
        let (response_tx, response_rx) = oneshot::channel();
        self.sender
            .send(build(response_tx))
            .await
            .map_err(|_| ProviderRuntimeError::QueueClosed)?;
        response_rx
            .await
            .map_err(|_| ProviderRuntimeError::ResponseDropped)?
    }
}

impl ActivityCancellationDispatcher for ProviderRuntimeSupervisor {
    fn cancel_target(
        &self,
        _scope: ActivityScopeRef,
        _generation: ActivityRuntimeGeneration,
        _target: ProviderActivityNativeTarget,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<ActivityTargetDispatchDisposition, ActivityDispatchError>,
    > {
        Box::pin(async { Err(ActivityDispatchError::TargetUnavailable) })
    }
}

pub async fn route_orchestration_command(
    supervisor: &ProviderRuntimeSupervisor,
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    command: OrchestrationCommand,
) -> Result<(), ProviderRuntimeError> {
    if let OrchestrationCommand::ThreadDelete {
        command_id,
        thread_id,
    } = &command
    {
        let stop = OrchestrationCommand::ThreadSessionStop {
            command_id: format!("{command_id}:provider-stop"),
            thread_id: thread_id.clone(),
            created_at: now(),
        };
        return match supervisor.handle_orchestration(stop).await {
            Err(ProviderRuntimeError::SessionNotFound { .. }) => Ok(()),
            result => result,
        };
    }

    let provider_command = matches!(
        command,
        OrchestrationCommand::ThreadTurnStart { .. }
            | OrchestrationCommand::ThreadTurnInterrupt { .. }
            | OrchestrationCommand::ThreadApprovalRespond { .. }
            | OrchestrationCommand::ThreadUserInputRespond { .. }
            | OrchestrationCommand::ThreadRuntimeModeSet { .. }
            | OrchestrationCommand::ThreadInteractionModeSet { .. }
            | OrchestrationCommand::ThreadSessionStop { .. }
            | OrchestrationCommand::ThreadMetaUpdate {
                model_selection: Some(_),
                ..
            }
    );
    if !provider_command {
        return Ok(());
    }

    let action = command.command_type().to_owned();
    match supervisor.handle_orchestration(command.clone()).await {
        Ok(()) => Ok(()),
        Err(ProviderRuntimeError::SessionNotFound { .. })
            if matches!(command, OrchestrationCommand::ThreadTurnStart { .. }) =>
        {
            let request = launch_request_for_command(engine, settings_root, &command, None).await?;
            supervisor.launch(request).await?;
            supervisor.handle_orchestration(command).await
        }
        Err(ProviderRuntimeError::SessionNotFound { .. })
            if matches!(
                command,
                OrchestrationCommand::ThreadRuntimeModeSet { .. }
                    | OrchestrationCommand::ThreadInteractionModeSet { .. }
                    | OrchestrationCommand::ThreadMetaUpdate {
                        model_selection: Some(_),
                        ..
                    }
            ) =>
        {
            Ok(())
        }
        Err(ProviderRuntimeError::SessionNotFound { thread_id }) => {
            Err(ProviderRuntimeError::StaleSession { thread_id, action })
        }
        Err(error) => Err(error),
    }
}

pub async fn deliver_orchestration_turn(
    supervisor: &ProviderRuntimeSupervisor,
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    command: OrchestrationCommand,
    delivery_key: String,
) -> ProviderDeliveryOutcome {
    deliver_orchestration_turn_with_identity(
        supervisor,
        engine,
        settings_root,
        command,
        delivery_key,
        None,
    )
    .await
}

pub async fn deliver_durable_orchestration_turn(
    supervisor: &ProviderRuntimeSupervisor,
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    command: OrchestrationCommand,
    delivery_key: String,
) -> ProviderDeliveryOutcome {
    let command_id = match &command {
        OrchestrationCommand::ThreadTurnStart { command_id, .. } => command_id.clone(),
        _ => {
            return ProviderDeliveryOutcome::Rejected {
                detail: "only a turn start can use durable provider delivery".to_owned(),
            };
        }
    };
    let row = match engine
        .repositories()
        .get_provider_turn_delivery(command_id)
        .await
    {
        Ok(Some(row)) if row.delivery_key == delivery_key => row,
        Ok(Some(_)) => {
            return ProviderDeliveryOutcome::Rejected {
                detail: "durable provider delivery key does not match its persisted row".to_owned(),
            };
        }
        Ok(None) => {
            return ProviderDeliveryOutcome::Rejected {
                detail: "durable provider delivery row was not found".to_owned(),
            };
        }
        Err(error) => {
            return ProviderDeliveryOutcome::Rejected {
                detail: error.to_string(),
            };
        }
    };
    deliver_orchestration_turn_with_identity(
        supervisor,
        engine,
        settings_root,
        command,
        delivery_key,
        Some(row),
    )
    .await
}

pub(crate) fn finalize_delivery_route_cwd(
    payload: &mut Value,
    cwd: Option<&Path>,
) -> Result<bool, ProviderRuntimeError> {
    if payload
        .get(DELIVERY_ROUTE_CWD_PENDING_FIELD)
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok(false);
    }
    let cwd = cwd.ok_or_else(|| ProviderRuntimeError::Provider {
        provider: "orchestration".to_owned(),
        detail: "durable provider route worktree cwd is still unavailable after bootstrap"
            .to_owned(),
    })?;
    let partial = payload
        .get(DELIVERY_ROUTE_FINGERPRINT_FIELD)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail:
                "durable provider route fingerprint is missing while finalizing its worktree cwd"
                    .to_owned(),
        })?;
    let fingerprint =
        delivery_route_fingerprint_with_cwd(partial, &process_compatible_path(cwd.to_path_buf()))?;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: "durable turn payload must be a JSON object before its provider route can be finalized"
                .to_owned(),
        })?;
    object.insert(
        DELIVERY_ROUTE_FINGERPRINT_FIELD.to_owned(),
        Value::String(fingerprint),
    );
    object.remove(DELIVERY_ROUTE_CWD_PENDING_FIELD);
    Ok(true)
}

/// Freezes the identity of the provider launch used by a durable turn.
///
/// Secret values participate in the in-memory digest input, but only the digest is persisted.
/// Resume cursors, provider session IDs, and issued MCP credentials are volatile continuation
/// state rather than provider process destinations. A local-draft worktree path is finalized after
/// bootstrap because it does not exist at admission time.
pub async fn freeze_delivery_route(
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    command: &OrchestrationCommand,
    payload: &mut Value,
) -> Result<(), ProviderRuntimeError> {
    let OrchestrationCommand::ThreadTurnStart {
        thread_id,
        model_selection,
        bootstrap,
        ..
    } = command
    else {
        return Err(ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: "only a turn start can freeze a durable provider route".to_owned(),
        });
    };
    let thread = engine
        .repositories()
        .get_thread(thread_id.clone())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    let bootstrap_selection = bootstrap
        .as_deref()
        .and_then(|bootstrap| bootstrap.create_thread.as_ref())
        .map(|create| &create.model_selection);
    let selection = model_selection
        .as_ref()
        .or(bootstrap_selection)
        .or_else(|| thread.as_ref().map(|thread| &thread.model_selection))
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: format!("turn for thread {thread_id} has no provider identity"),
        })?;
    let instance_id = selection
        .get("instanceId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("codex");
    let route = resolve_provider_route_settings(settings_root, instance_id, None).await?;
    let (cwd, cwd_pending) = if let Some(thread) = thread.as_ref() {
        let project = engine
            .repositories()
            .get_project(thread.project_id.clone())
            .await
            .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
            .ok_or_else(|| ProviderRuntimeError::Provider {
                provider: route.provider.clone(),
                detail: format!("project {} was not found", thread.project_id),
            })?;
        (
            Some(process_compatible_path(
                thread
                    .worktree_path
                    .clone()
                    .map_or_else(|| PathBuf::from(project.workspace_root), PathBuf::from),
            )),
            false,
        )
    } else {
        let bootstrap =
            bootstrap
                .as_deref()
                .ok_or_else(|| ProviderRuntimeError::SessionNotFound {
                    thread_id: thread_id.clone(),
                })?;
        let create = bootstrap.create_thread.as_ref().ok_or_else(|| {
            ProviderRuntimeError::SessionNotFound {
                thread_id: thread_id.clone(),
            }
        })?;
        if let Some(worktree_path) = create.worktree_path.as_ref() {
            (
                Some(process_compatible_path(PathBuf::from(worktree_path))),
                false,
            )
        } else if bootstrap.prepare_worktree.is_some() {
            (None, true)
        } else {
            let project = engine
                .repositories()
                .get_project(create.project_id.clone())
                .await
                .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
                .ok_or_else(|| ProviderRuntimeError::Provider {
                    provider: route.provider.clone(),
                    detail: format!("project {} was not found", create.project_id),
                })?;
            (
                Some(process_compatible_path(PathBuf::from(
                    project.workspace_root,
                ))),
                false,
            )
        }
    };
    let fingerprint = route.fingerprint(selection, cwd.as_deref())?;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: route.provider,
            detail:
                "durable turn payload must be a JSON object before its provider route can be frozen"
                    .to_owned(),
        })?;
    object.insert(
        DELIVERY_ROUTE_FINGERPRINT_FIELD.to_owned(),
        Value::String(fingerprint),
    );
    if cwd_pending {
        object.insert(
            DELIVERY_ROUTE_CWD_PENDING_FIELD.to_owned(),
            Value::Bool(true),
        );
    }
    Ok(())
}

async fn deliver_orchestration_turn_with_identity(
    supervisor: &ProviderRuntimeSupervisor,
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    command: OrchestrationCommand,
    delivery_key: String,
    frozen_delivery: Option<ProviderTurnDelivery>,
) -> ProviderDeliveryOutcome {
    let is_frozen = frozen_delivery.is_some();
    let first = match frozen_delivery.clone() {
        Some(row) => supervisor.deliver_frozen_turn(command.clone(), row).await,
        None => {
            supervisor
                .deliver_turn(command.clone(), delivery_key.clone())
                .await
        }
    };
    let handle = match first {
        Ok(handle) => handle,
        Err(ProviderRuntimeError::SessionNotFound { .. }) => {
            let request = match launch_request_for_command(
                engine,
                settings_root,
                &command,
                frozen_delivery.as_ref(),
            )
            .await
            {
                Ok(request) => request,
                Err(error) => {
                    return ProviderDeliveryOutcome::Rejected {
                        detail: error.to_string(),
                    };
                }
            };
            if let Some(row) = frozen_delivery.as_ref()
                && let Err(error) = validate_frozen_delivery_route(row, &request)
            {
                return ProviderDeliveryOutcome::Rejected {
                    detail: error.to_string(),
                };
            }
            if let Err(error) = supervisor.launch(request).await {
                return ProviderDeliveryOutcome::DefinitelyNotSent {
                    detail: error.to_string(),
                };
            }
            if let Some(row) = frozen_delivery.as_ref() {
                match engine
                    .repositories()
                    .get_provider_turn_delivery(row.command_id.clone())
                    .await
                {
                    Ok(Some(current)) if current.state == TurnDeliveryState::Dismissed => {
                        return ProviderDeliveryOutcome::Rejected {
                            detail: "message delivery was cancelled before the provider started"
                                .to_owned(),
                        };
                    }
                    Ok(_) => {}
                    Err(error) => {
                        return ProviderDeliveryOutcome::DefinitelyNotSent {
                            detail: error.to_string(),
                        };
                    }
                }
            }
            let retry = match frozen_delivery {
                Some(row) => supervisor.deliver_frozen_turn(command, row).await,
                None => supervisor.deliver_turn(command, delivery_key).await,
            };
            match retry {
                Ok(handle) => handle,
                Err(error) if is_frozen => {
                    return ProviderDeliveryOutcome::Rejected {
                        detail: error.to_string(),
                    };
                }
                Err(error) => return delivery_enqueue_failure(error),
            }
        }
        Err(error) if is_frozen => {
            return ProviderDeliveryOutcome::Rejected {
                detail: error.to_string(),
            };
        }
        Err(error) => return delivery_enqueue_failure(error),
    };
    handle.completion().await
}

fn delivery_enqueue_failure(error: ProviderRuntimeError) -> ProviderDeliveryOutcome {
    match error {
        ProviderRuntimeError::ResponseDropped => ProviderDeliveryOutcome::Ambiguous {
            detail: error.to_string(),
        },
        _ => ProviderDeliveryOutcome::DefinitelyNotSent {
            detail: error.to_string(),
        },
    }
}

pub async fn reconcile_orchestration_turn(
    supervisor: &ProviderRuntimeSupervisor,
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    row: ProviderTurnDelivery,
) -> ProviderReconciliationOutcome {
    match supervisor.reconcile_turn(row.clone()).await {
        Ok(outcome) => outcome,
        Err(ProviderRuntimeError::SessionNotFound { .. }) => {
            let command = match serde_json::from_value::<OrchestrationCommand>(row.payload.clone())
            {
                Ok(command) => command,
                Err(error) => {
                    return ProviderReconciliationOutcome::Unavailable {
                        detail: format!("durable turn payload is invalid: {error}"),
                    };
                }
            };
            let request =
                match launch_request_for_command(engine, settings_root, &command, Some(&row)).await
                {
                    Ok(request) => request,
                    Err(error) => {
                        return ProviderReconciliationOutcome::Unavailable {
                            detail: error.to_string(),
                        };
                    }
                };
            if let Err(error) = validate_frozen_delivery_route(&row, &request) {
                return ProviderReconciliationOutcome::Unavailable {
                    detail: error.to_string(),
                };
            }
            if let Err(error) = supervisor.launch(request).await {
                return ProviderReconciliationOutcome::Unavailable {
                    detail: error.to_string(),
                };
            }
            supervisor
                .reconcile_turn(row)
                .await
                .unwrap_or_else(|error| ProviderReconciliationOutcome::Unavailable {
                    detail: error.to_string(),
                })
        }
        Err(error) => ProviderReconciliationOutcome::Unavailable {
            detail: error.to_string(),
        },
    }
}

pub async fn reconcile_abandoned_provider_sessions(
    engine: &OrchestrationEngine,
) -> Result<(), ProviderRuntimeError> {
    const RESTART_ERROR: &str =
        "Provider session ended when BiBCode stopped. Review delivery status before continuing.";
    let repositories = engine.repositories();
    let runtimes = repositories
        .list_provider_session_runtimes()
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    for runtime in runtimes
        .into_iter()
        .filter(|runtime| matches!(runtime.status.as_str(), "connecting" | "ready" | "running"))
    {
        let thread_id = runtime.thread_id.clone();
        if let Err(error) =
            reconcile_abandoned_provider_session(engine, &repositories, runtime, RESTART_ERROR)
                .await
        {
            tracing::warn!(
                thread_id,
                %error,
                "abandoned provider session remains eligible for startup reconciliation retry"
            );
        }
    }
    Ok(())
}

async fn reconcile_abandoned_provider_session(
    engine: &OrchestrationEngine,
    repositories: &Repositories,
    mut runtime: ProviderSessionRuntime,
    restart_error: &str,
) -> Result<(), ProviderRuntimeError> {
    let projected_at = runtime.last_seen_at.clone();
    let projection_is_complete = repositories
        .get_thread_session(runtime.thread_id.clone())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
        .is_some_and(|session| {
            session.status == "error"
                && session.provider_name.as_deref() == Some(runtime.provider_name.as_str())
                && session.provider_instance_id == runtime.provider_instance_id
                && session.runtime_mode == runtime.runtime_mode
                && session.active_turn_id.is_none()
                && session.last_error.as_deref() == Some(restart_error)
                && session.updated_at == projected_at
        });
    if !projection_is_complete {
        engine
            .dispatch(OrchestrationCommand::ThreadSessionSet {
                command_id: format!("provider-restart-reconcile:{}", Uuid::new_v4()),
                thread_id: runtime.thread_id.clone(),
                session: SessionInput {
                    thread_id: runtime.thread_id.clone(),
                    status: "error".to_owned(),
                    provider_name: Some(runtime.provider_name.clone()),
                    provider_instance_id: runtime.provider_instance_id.clone(),
                    runtime_mode: runtime.runtime_mode.clone(),
                    active_turn_id: None,
                    last_error: Some(restart_error.to_owned()),
                    updated_at: projected_at.clone(),
                },
                created_at: projected_at,
            })
            .await
            .map_err(|error| ProviderRuntimeError::Orchestration(error.to_string()))?;
    }

    runtime.status = "error".to_owned();
    runtime.last_seen_at = now();
    repositories
        .upsert_provider_session_runtime(runtime)
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))
}

async fn launch_request_for_command(
    engine: &OrchestrationEngine,
    settings_root: &PathBuf,
    command: &OrchestrationCommand,
    frozen_delivery: Option<&ProviderTurnDelivery>,
) -> Result<ProviderLaunchRequest, ProviderRuntimeError> {
    let OrchestrationCommand::ThreadTurnStart {
        thread_id,
        model_selection,
        runtime_mode,
        interaction_mode,
        bootstrap,
        ..
    } = command
    else {
        return Err(ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: "only a turn start can launch a provider runtime".to_owned(),
        });
    };
    let repositories = engine.repositories();
    let thread = repositories
        .get_thread(thread_id.clone())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
        .ok_or_else(|| ProviderRuntimeError::SessionNotFound {
            thread_id: thread_id.clone(),
        })?;
    let project = repositories
        .get_project(thread.project_id.clone())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: format!("project {} was not found", thread.project_id),
        })?;
    let bootstrap_selection = bootstrap
        .as_deref()
        .and_then(|bootstrap| bootstrap.create_thread.as_ref())
        .map(|create| &create.model_selection);
    let selection = model_selection
        .as_ref()
        .or(bootstrap_selection)
        .unwrap_or(&thread.model_selection);
    let instance_id = frozen_delivery.map_or_else(
        || {
            selection
                .get("instanceId")
                .and_then(Value::as_str)
                .unwrap_or("codex")
                .to_owned()
        },
        |row| row.provider_instance_id.clone(),
    );
    let route =
        resolve_provider_route_settings(settings_root, &instance_id, frozen_delivery).await?;
    let provider = route.provider.as_str();
    let persisted = repositories
        .get_provider_session_runtime(thread_id.clone())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
        .filter(|runtime| {
            runtime.provider_name == provider
                && runtime.provider_instance_id.as_deref() == Some(instance_id.as_str())
        });
    let requires_resume = frozen_delivery.is_some_and(|row| row.provider_session_id.is_some());
    if requires_resume && persisted.is_none() {
        return Err(ProviderRuntimeError::Provider {
            provider: provider.to_owned(),
            detail: format!(
                "durable turn requires resumable runtime state for provider instance {instance_id}"
            ),
        });
    }
    let resume_cursor = persisted.and_then(|runtime| runtime.resume_cursor);
    if let Some(row) = frozen_delivery
        && row.provider_session_id.is_some()
    {
        let resume_cursor =
            resume_cursor
                .as_ref()
                .ok_or_else(|| ProviderRuntimeError::Provider {
                    provider: provider.to_owned(),
                    detail: format!(
                        "durable turn requires a resume cursor for provider instance {instance_id}"
                    ),
                })?;
        validate_frozen_session_identity(row, resume_cursor)?;
    }
    let options = selection_options(selection);
    let session_options = provider_session_options(&route.provider, &options);
    Ok(ProviderLaunchRequest {
        thread_id: thread_id.clone(),
        activity_causal_revision: 0,
        provider: provider.to_owned(),
        provider_label: route.provider_label,
        provider_instance_id: Some(instance_id),
        binary_path: route.binary.binary_path.clone(),
        cwd: process_compatible_path(
            thread
                .worktree_path
                .map_or_else(|| PathBuf::from(project.workspace_root), PathBuf::from),
        ),
        runtime_mode: runtime_mode.clone(),
        interaction_mode: interaction_mode.clone(),
        model: model_from_selection(selection),
        service_tier: selection_string_option_from(&options, "serviceTier"),
        effort: selection_effort(&options),
        agent: selection_string_option_from(&options, "agent"),
        options: session_options,
        resume_cursor,
        environment: route.environment,
        endpoint: (!route.binary.server_url.trim().is_empty())
            .then(|| route.binary.server_url.clone()),
        server_password: (!route.binary.server_password.is_empty())
            .then(|| route.binary.server_password.clone()),
        mcp: None,
        codex_home: route.codex_home,
    })
}

struct ResolvedProviderRouteSettings {
    provider: String,
    provider_instance_id: String,
    provider_label: String,
    binary: ProviderBinarySettingsState,
    environment: BTreeMap<String, String>,
    codex_home: Option<CodexHomeLayout>,
}

impl ResolvedProviderRouteSettings {
    fn fingerprint(
        &self,
        selection: &Value,
        cwd: Option<&Path>,
    ) -> Result<String, ProviderRuntimeError> {
        let model = model_from_selection(selection);
        let options = selection_options(selection);
        let session_options = provider_session_options(&self.provider, &options);
        let service_tier = selection_string_option_from(&options, "serviceTier");
        let effort = selection_effort(&options);
        let agent = selection_string_option_from(&options, "agent");
        let partial = delivery_route_fingerprint_values(
            &self.provider,
            Some(&self.provider_instance_id),
            &self.binary.binary_path,
            &self.environment,
            (!self.binary.server_url.trim().is_empty()).then_some(self.binary.server_url.as_str()),
            (!self.binary.server_password.is_empty())
                .then_some(self.binary.server_password.as_str()),
            self.codex_home.as_ref(),
            model.as_deref(),
            &session_options,
            service_tier.as_deref(),
            effort.as_deref(),
            agent.as_deref(),
        )?;
        cwd.map_or(Ok(partial.clone()), |cwd| {
            delivery_route_fingerprint_with_cwd(&partial, cwd)
        })
    }
}

async fn resolve_provider_route_settings(
    settings_root: &PathBuf,
    instance_id: &str,
    frozen_delivery: Option<&ProviderTurnDelivery>,
) -> Result<ResolvedProviderRouteSettings, ProviderRuntimeError> {
    let settings = ProviderSettingsStore::new(settings_root)
        .get()
        .await
        .map_err(|error| ProviderRuntimeError::Provider {
            provider: instance_id.to_owned(),
            detail: error.to_string(),
        })?;
    let instance = settings.provider_instances.get(instance_id);
    if let Some(row) = frozen_delivery
        && instance.is_none()
        && instance_id != row.provider_kind
    {
        return Err(ProviderRuntimeError::Provider {
            provider: row.provider_kind.clone(),
            detail: format!(
                "durable turn requires provider instance {}, but that exact instance is unavailable",
                row.provider_instance_id
            ),
        });
    }
    let driver = instance
        .map(|value| value.driver.as_str())
        .unwrap_or(instance_id);
    let provider = canonical_provider_kind(driver)?;
    if let Some(row) = frozen_delivery
        && provider != row.provider_kind
    {
        return Err(ProviderRuntimeError::Provider {
            provider: row.provider_kind.clone(),
            detail: format!(
                "durable turn provider identity mismatch: instance {} now uses {}, expected {}",
                row.provider_instance_id, provider, row.provider_kind
            ),
        });
    }
    let binary = provider_binary_settings(&settings.providers, provider, instance);
    if !binary.enabled || binary.binary_path.trim().is_empty() {
        return Err(ProviderRuntimeError::UnsupportedProvider {
            provider: provider.to_owned(),
        });
    }
    let environment = instance
        .into_iter()
        .flat_map(|value| value.environment.iter())
        .filter(|entry| !entry.name.trim().is_empty() && !entry.value_redacted)
        .map(|entry| (OsStr::new(entry.name.trim()), OsStr::new(&entry.value)));
    let environment = normalize_provider_environment(environment)
        .into_iter()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let codex_home = (provider == "codex").then(|| {
        let config = instance.map(|value| &value.config);
        resolve_codex_home_layout(
            config
                .and_then(|value| value.get("homePath"))
                .and_then(Value::as_str),
            config
                .and_then(|value| value.get("shadowHomePath"))
                .and_then(Value::as_str),
            dirs::home_dir()
                .as_deref()
                .unwrap_or_else(|| Path::new(".")),
        )
    });
    Ok(ResolvedProviderRouteSettings {
        provider: provider.to_owned(),
        provider_instance_id: instance_id.to_owned(),
        provider_label: instance
            .and_then(|value| value.display_name.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(provider)
            .to_owned(),
        binary,
        environment,
        codex_home,
    })
}

fn validate_frozen_session_identity(
    row: &ProviderTurnDelivery,
    resume_cursor: &Value,
) -> Result<(), ProviderRuntimeError> {
    let Some(expected_session_id) = row.provider_session_id.as_deref() else {
        return Ok(());
    };
    let cursor_field = match row.provider_kind.as_str() {
        "codex" => "threadId",
        "claudeAgent" | "cursor" | "opencode" => "sessionId",
        _ => {
            return Err(ProviderRuntimeError::Provider {
                provider: row.provider_kind.clone(),
                detail: "provider does not support exact durable turn reconciliation".to_owned(),
            });
        }
    };
    let actual_session_id = resume_cursor.get(cursor_field).and_then(Value::as_str);
    if actual_session_id == Some(expected_session_id) {
        return Ok(());
    }
    Err(ProviderRuntimeError::Provider {
        provider: row.provider_kind.clone(),
        detail: format!(
            "durable turn provider session mismatch: expected {expected_session_id}, found {}",
            actual_session_id.unwrap_or("no resumable session")
        ),
    })
}

fn delivery_route_fingerprint(
    request: &ProviderLaunchRequest,
) -> Result<String, ProviderRuntimeError> {
    let partial = delivery_route_fingerprint_values(
        &request.provider,
        request.provider_instance_id.as_deref(),
        &request.binary_path,
        &request.environment,
        request.endpoint.as_deref(),
        request.server_password.as_deref(),
        request.codex_home.as_ref(),
        request.model.as_deref(),
        &request.options,
        request.service_tier.as_deref(),
        request.effort.as_deref(),
        request.agent.as_deref(),
    )?;
    delivery_route_fingerprint_with_cwd(&partial, &request.cwd)
}

#[allow(clippy::too_many_arguments)]
fn delivery_route_fingerprint_values(
    provider: &str,
    provider_instance_id: Option<&str>,
    binary_path: &str,
    environment: &BTreeMap<String, String>,
    endpoint: Option<&str>,
    server_password: Option<&str>,
    codex_home: Option<&CodexHomeLayout>,
    model: Option<&str>,
    options: &[Value],
    service_tier: Option<&str>,
    effort: Option<&str>,
    agent: Option<&str>,
) -> Result<String, ProviderRuntimeError> {
    let codex_home = codex_home.map(|layout| {
        json!({
            "sharedHomePath": layout.shared_home_path,
            "effectiveHomePath": layout.effective_home_path,
            "overlay": layout.is_overlay(),
        })
    });
    canonical_command_digest(&json!({
        "version": DELIVERY_ROUTE_FINGERPRINT_VERSION,
        "provider": provider,
        "providerInstanceId": provider_instance_id,
        "binaryPath": binary_path,
        "environment": environment,
        "endpoint": endpoint,
        "serverPassword": server_password,
        "codexHome": codex_home,
        "model": model,
        "options": options,
        "serviceTier": service_tier,
        "effort": effort,
        "agent": agent,
    }))
    .map_err(|detail| ProviderRuntimeError::Provider {
        provider: provider.to_owned(),
        detail: format!("failed to fingerprint durable provider route: {detail}"),
    })
}

fn delivery_route_fingerprint_with_cwd(
    partial: &str,
    cwd: &Path,
) -> Result<String, ProviderRuntimeError> {
    canonical_command_digest(&json!({
        "version": DELIVERY_ROUTE_CWD_FINGERPRINT_VERSION,
        "route": partial,
        "cwd": cwd,
    }))
    .map_err(|detail| ProviderRuntimeError::Provider {
        provider: "orchestration".to_owned(),
        detail: format!("failed to fingerprint durable provider cwd: {detail}"),
    })
}

fn frozen_delivery_route_fingerprint(
    row: &ProviderTurnDelivery,
) -> Result<&str, ProviderRuntimeError> {
    row.payload
        .get(DELIVERY_ROUTE_FINGERPRINT_FIELD)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: row.provider_kind.clone(),
            detail: "durable provider route fingerprint is missing; delivery is blocked because the original provider destination cannot be verified"
                .to_owned(),
        })
}

fn validate_frozen_delivery_route(
    row: &ProviderTurnDelivery,
    request: &ProviderLaunchRequest,
) -> Result<(), ProviderRuntimeError> {
    if row
        .payload
        .get(DELIVERY_ROUTE_CWD_PENDING_FIELD)
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(ProviderRuntimeError::Provider {
            provider: row.provider_kind.clone(),
            detail: "durable provider route has an unresolved worktree cwd; delivery is blocked before contacting the provider"
                .to_owned(),
        });
    }
    let expected = frozen_delivery_route_fingerprint(row)?;
    let actual = delivery_route_fingerprint(request)?;
    if expected == actual {
        return Ok(());
    }
    Err(ProviderRuntimeError::Provider {
        provider: row.provider_kind.clone(),
        detail: "durable provider route changed after admission; delivery is blocked before contacting the provider"
            .to_owned(),
    })
}

pub(crate) fn canonical_provider_kind(driver: &str) -> Result<&'static str, ProviderRuntimeError> {
    match driver {
        "claudeAgent" | "claude" => Ok("claudeAgent"),
        "codex" => Ok("codex"),
        "cursor" => Ok("cursor"),
        "grok" => Ok("grok"),
        "opencode" => Ok("opencode"),
        other => Err(ProviderRuntimeError::UnsupportedProvider {
            provider: other.to_owned(),
        }),
    }
}

fn provider_binary_settings(
    providers: &crate::server_settings::ProvidersState,
    provider: &str,
    instance: Option<&crate::server_settings::ProviderInstanceState>,
) -> ProviderBinarySettingsState {
    let mut settings = match provider {
        "claudeAgent" => providers.claude_agent.clone(),
        "cursor" => providers.cursor.clone(),
        "grok" => providers.grok.clone(),
        "opencode" => providers.opencode.clone(),
        _ => providers.codex.clone(),
    };
    if let Some(instance) = instance {
        settings.enabled = instance.enabled;
        let config_string = |name: &str| {
            instance
                .config
                .get(name)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        };
        if let Some(binary_path) = config_string("binaryPath") {
            settings.binary_path = binary_path;
        }
        if let Some(server_url) =
            config_string("serverUrl").or_else(|| config_string("apiEndpoint"))
        {
            settings.server_url = server_url;
        }
        if let Some(server_password) = config_string("serverPassword") {
            settings.server_password = server_password;
        }
    }
    settings.enabled &= provider != "grok";
    settings
}

#[allow(clippy::too_many_arguments)]
async fn run_supervisor(
    engine: OrchestrationEngine,
    factory: Arc<dyn ProviderDriverFactory>,
    activity: ActivityProjection,
    mut receiver: mpsc::Receiver<SupervisorMessage>,
    sender: mpsc::Sender<SupervisorMessage>,
    terminal_sender: mpsc::UnboundedSender<SupervisorMessage>,
    mut terminal_receiver: mpsc::UnboundedReceiver<SupervisorMessage>,
    deferred_capacity: usize,
    session_idle_timeout: Duration,
    stopped: CancellationToken,
    operational_log: Option<ProviderOperationalLog>,
) {
    let mut sessions = HashMap::<String, SessionEntry>::new();
    let mut delivery_sequences = HashMap::<String, ThreadDeliverySequence>::new();
    let mut next_delivery_generation = 0_u64;
    let mut deferred_configuration = DeferredConfigurations::new();
    loop {
        let message = tokio::select! {
            message = receiver.recv() => {
                let Some(message) = message else { break };
                message
            }
            message = terminal_receiver.recv() => {
                let Some(message) = message else { continue };
                message
            }
        };
        match message {
            SupervisorMessage::Launch { request, response } => {
                let result = launch_session(
                    &engine,
                    &factory,
                    &activity,
                    &mut sessions,
                    *request,
                    operational_log.as_ref(),
                    None,
                    terminal_sender.clone(),
                    session_idle_timeout,
                )
                .await;
                let _ = response.send(result);
            }
            SupervisorMessage::Handle { command, response } => {
                if let Some(thread_id) = delivery_ordered_command_thread(command.as_ref())
                    && let Some(generation) = delivery_sequences
                        .get(thread_id)
                        .and_then(|sequence| sequence.active_generation)
                {
                    let queued = deferred_configuration
                        .entry(thread_id.to_owned())
                        .or_default();
                    if queued.len() >= deferred_capacity {
                        let _ = response.send(Err(ProviderRuntimeError::Provider {
                            provider: "orchestration".to_owned(),
                            detail: format!(
                                "thread {thread_id} deferred provider configuration queue is full"
                            ),
                        }));
                    } else {
                        queued.push_back((generation, command, response));
                    }
                    continue;
                }
                let result = handle_command(
                    &engine,
                    &factory,
                    &activity,
                    &mut sessions,
                    *command,
                    operational_log.as_ref(),
                )
                .await;
                let _ = response.send(result);
            }
            SupervisorMessage::Deliver {
                command,
                delivery_key,
                frozen_delivery,
                response,
            } => {
                let result = async {
                    let thread_id = command_thread_id(command.as_ref())
                        .ok_or_else(|| ProviderRuntimeError::Provider {
                            provider: "orchestration".to_owned(),
                            detail: "durable delivery command has no thread identity".to_owned(),
                        })?
                        .to_owned();
                    let sequence = delivery_sequences.entry(thread_id.clone()).or_default();
                    if sequence.active_generation.is_some()
                        || deferred_configuration
                            .get(&thread_id)
                            .is_some_and(|queued| !queued.is_empty())
                    {
                        return Err(ProviderRuntimeError::Provider {
                            provider: "orchestration".to_owned(),
                            detail: format!(
                                "thread {thread_id} already has provider work awaiting ordered completion"
                            ),
                        });
                    }
                    if let OrchestrationCommand::ThreadTurnStart {
                        thread_id,
                        model_selection: Some(selection),
                        ..
                    } = command.as_ref()
                    {
                        reconcile_model_selection(
                            &engine,
                            &factory,
                            &activity,
                            &mut sessions,
                            thread_id,
                            selection,
                            operational_log.as_ref(),
                        )
                        .await?;
                    }
                    next_delivery_generation = next_delivery_generation.checked_add(1).ok_or_else(
                        || ProviderRuntimeError::Provider {
                            provider: "orchestration".to_owned(),
                            detail: "provider delivery generation exhausted".to_owned(),
                        },
                    )?;
                    let generation = next_delivery_generation;
                    let result = spawn_delivery(
                        &engine,
                        &mut sessions,
                        *command,
                        delivery_key,
                        frozen_delivery.as_deref(),
                        terminal_sender.clone(),
                        generation,
                    )
                    .await;
                    if result.is_ok() {
                        delivery_sequences
                            .entry(thread_id)
                            .or_default()
                            .active_generation = Some(generation);
                    }
                    result
                }
                .await;
                let _ = response.send(result);
            }
            SupervisorMessage::Reconcile { row, response } => {
                let result = sessions
                    .get(&row.thread_id)
                    .map(|entry| {
                        validate_active_delivery_identity(entry, &row)?;
                        Ok(entry.driver.clone())
                    })
                    .transpose()
                    .and_then(|driver| {
                        driver.ok_or_else(|| ProviderRuntimeError::SessionNotFound {
                            thread_id: row.thread_id.clone(),
                        })
                    });
                match result {
                    Ok(driver) => {
                        tokio::spawn(async move {
                            let outcome = driver.reconcile(row.delivery_key).await;
                            let _ = response.send(Ok(outcome));
                        });
                    }
                    Err(error) => {
                        let _ = response.send(Err(error));
                    }
                }
            }
            SupervisorMessage::SetAgentActivityEnabled { enabled, response } => {
                let result = set_live_agent_activity_enabled(&activity, &sessions, enabled).await;
                let _ = response.send(result);
            }
            SupervisorMessage::DeliveryComplete {
                thread_id,
                generation,
                abnormal,
            } => {
                let sequence = delivery_sequences.entry(thread_id.clone()).or_default();
                if sequence.active_generation != Some(generation) {
                    reject_deferred_generation(
                        &mut deferred_configuration,
                        &thread_id,
                        generation,
                        "stale provider delivery completion",
                    );
                    continue;
                }
                sequence.active_generation = None;
                sequence.completed_generation = generation;
                if abnormal {
                    reject_deferred_generation(
                        &mut deferred_configuration,
                        &thread_id,
                        generation,
                        "provider delivery attempt ended abnormally",
                    );
                } else if deferred_configuration
                    .get(&thread_id)
                    .is_some_and(|queued| !queued.is_empty())
                {
                    schedule_deferred_drain(sender.clone(), thread_id, generation);
                }
            }
            SupervisorMessage::DrainDeferred {
                thread_id,
                generation,
            } => {
                let ready = delivery_sequences.get(&thread_id).is_some_and(|sequence| {
                    sequence.active_generation.is_none()
                        && sequence.completed_generation == generation
                });
                if !ready {
                    reject_deferred_generation(
                        &mut deferred_configuration,
                        &thread_id,
                        generation,
                        "stale deferred provider configuration drain",
                    );
                    continue;
                }
                let queued = deferred_configuration.get_mut(&thread_id);
                let next = queued.and_then(VecDeque::pop_front);
                if let Some((queued_generation, command, response)) = next {
                    if queued_generation != generation {
                        let _ = response.send(Err(ProviderRuntimeError::Provider {
                            provider: "orchestration".to_owned(),
                            detail: "deferred provider configuration generation changed".to_owned(),
                        }));
                    } else {
                        let result = handle_command(
                            &engine,
                            &factory,
                            &activity,
                            &mut sessions,
                            *command,
                            operational_log.as_ref(),
                        )
                        .await;
                        let _ = response.send(result);
                    }
                }
                if deferred_configuration
                    .get(&thread_id)
                    .is_some_and(|queued| !queued.is_empty())
                {
                    schedule_deferred_drain(sender.clone(), thread_id, generation);
                } else {
                    deferred_configuration.remove(&thread_id);
                }
            }
            SupervisorMessage::SuspendIdle {
                thread_id,
                idle_generation,
                generation,
            } => {
                let is_current = sessions.get(&thread_id).is_some_and(|entry| {
                    Arc::ptr_eq(&entry.idle_generation, &idle_generation)
                        && entry.idle_generation.load(Ordering::Relaxed) == generation
                });
                if is_current
                    && let Err(error) = suspend_idle_session(
                        &engine.repositories(),
                        &activity,
                        &mut sessions,
                        &thread_id,
                    )
                    .await
                {
                    tracing::warn!(%error, %thread_id, "failed to suspend idle provider session");
                }
            }
            SupervisorMessage::Shutdown { response } => {
                reject_all_deferred(&mut deferred_configuration, ProviderRuntimeError::Shutdown);
                let result =
                    shutdown_sessions(&engine.repositories(), &activity, &mut sessions).await;
                stopped.cancel();
                let _ = response.send(result);
                return;
            }
        }
    }
    reject_all_deferred(&mut deferred_configuration, ProviderRuntimeError::Shutdown);
    let _ = shutdown_sessions(&engine.repositories(), &activity, &mut sessions).await;
    stopped.cancel();
}

fn delivery_ordered_command_thread(command: &OrchestrationCommand) -> Option<&str> {
    match command {
        OrchestrationCommand::ThreadTurnStart { thread_id, .. }
        | OrchestrationCommand::ThreadRuntimeModeSet { thread_id, .. }
        | OrchestrationCommand::ThreadInteractionModeSet { thread_id, .. }
        | OrchestrationCommand::ThreadSessionStop { thread_id, .. }
        | OrchestrationCommand::ThreadMetaUpdate {
            thread_id,
            model_selection: Some(_),
            ..
        } => Some(thread_id),
        _ => None,
    }
}

fn schedule_deferred_drain(
    sender: mpsc::Sender<SupervisorMessage>,
    thread_id: String,
    generation: u64,
) {
    tokio::spawn(async move {
        let _ = sender
            .send(SupervisorMessage::DrainDeferred {
                thread_id,
                generation,
            })
            .await;
    });
}

type DeferredConfiguration = (
    u64,
    Box<OrchestrationCommand>,
    oneshot::Sender<Result<(), ProviderRuntimeError>>,
);
type DeferredConfigurations = HashMap<String, VecDeque<DeferredConfiguration>>;

fn reject_deferred_generation(
    deferred: &mut DeferredConfigurations,
    thread_id: &str,
    generation: u64,
    detail: &str,
) {
    let Some(mut queued) = deferred.remove(thread_id) else {
        return;
    };
    let mut retained = VecDeque::new();
    while let Some((queued_generation, command, response)) = queued.pop_front() {
        if queued_generation == generation {
            let _ = response.send(Err(ProviderRuntimeError::Provider {
                provider: "orchestration".to_owned(),
                detail: detail.to_owned(),
            }));
        } else {
            retained.push_back((queued_generation, command, response));
        }
    }
    if !retained.is_empty() {
        deferred.insert(thread_id.to_owned(), retained);
    }
}

fn reject_all_deferred(deferred: &mut DeferredConfigurations, error: ProviderRuntimeError) {
    for (_, mut queued) in deferred.drain() {
        while let Some((_, _, response)) = queued.pop_front() {
            let _ = response.send(Err(match &error {
                ProviderRuntimeError::Shutdown => ProviderRuntimeError::Shutdown,
                _ => ProviderRuntimeError::Provider {
                    provider: "orchestration".to_owned(),
                    detail: error.to_string(),
                },
            }));
        }
    }
}

fn validate_active_delivery_identity(
    entry: &SessionEntry,
    row: &ProviderTurnDelivery,
) -> Result<(), ProviderRuntimeError> {
    let active_instance_id = entry
        .launch
        .provider_instance_id
        .as_deref()
        .unwrap_or(entry.launch.provider.as_str());
    if entry.launch.provider != row.provider_kind || active_instance_id != row.provider_instance_id
    {
        return Err(ProviderRuntimeError::Provider {
            provider: row.provider_kind.clone(),
            detail: format!(
                "active provider identity mismatch for durable turn: expected {}/{}, found {}/{}",
                row.provider_kind,
                row.provider_instance_id,
                entry.launch.provider,
                active_instance_id
            ),
        });
    }
    validate_frozen_delivery_route(row, &entry.launch)?;
    if row.provider_session_id.is_none() {
        return Ok(());
    }
    let resume_cursor =
        entry
            .resume_cursor
            .as_ref()
            .ok_or_else(|| ProviderRuntimeError::Provider {
                provider: row.provider_kind.clone(),
                detail: "active provider runtime has no resumable session identity".to_owned(),
            })?;
    validate_frozen_session_identity(row, resume_cursor)
}

fn active_provider_session_id(
    entry: &SessionEntry,
    row: &ProviderTurnDelivery,
) -> Result<String, ProviderRuntimeError> {
    let resume_cursor =
        entry
            .resume_cursor
            .as_ref()
            .ok_or_else(|| ProviderRuntimeError::Provider {
                provider: row.provider_kind.clone(),
                detail: "active provider runtime has no resumable session identity".to_owned(),
            })?;
    let cursor_field = if row.provider_kind == "codex" {
        "threadId"
    } else {
        "sessionId"
    };
    let session_id = resume_cursor
        .get(cursor_field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: row.provider_kind.clone(),
            detail: "active provider runtime has no native session identity".to_owned(),
        })?;
    Ok(session_id.to_owned())
}

async fn spawn_delivery(
    engine: &OrchestrationEngine,
    sessions: &mut HashMap<String, SessionEntry>,
    command: OrchestrationCommand,
    delivery_key: String,
    frozen_delivery: Option<&ProviderTurnDelivery>,
    terminal_sender: mpsc::UnboundedSender<SupervisorMessage>,
    generation: u64,
) -> Result<ProviderDeliveryHandle, ProviderRuntimeError> {
    let OrchestrationCommand::ThreadTurnStart {
        thread_id,
        message,
        interaction_mode,
        ..
    } = command
    else {
        return Err(ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: "only a turn start can use durable provider delivery".to_owned(),
        });
    };
    let entry = sessions
        .get(&thread_id)
        .ok_or_else(|| ProviderRuntimeError::SessionNotFound {
            thread_id: thread_id.clone(),
        })?;
    if !entry.configuration_healthy {
        return Err(ProviderRuntimeError::Provider {
            provider: entry.launch.provider.clone(),
            detail: "provider configuration is unavailable after failed restoration".to_owned(),
        });
    }
    let frozen_session = frozen_delivery
        .map(|row| {
            validate_active_delivery_identity(entry, row)?;
            Ok((row.clone(), active_provider_session_id(entry, row)?))
        })
        .transpose()?;
    entry.idle_generation.fetch_add(1, Ordering::Relaxed);
    let driver = entry.driver.clone();
    let launch = entry.launch.clone();
    let resume_cursor = entry.resume_cursor.clone();
    let runtime_payload = entry.runtime_payload.clone();
    let repositories = engine.repositories();
    let engine = engine.clone();
    let (completion_tx, completion) = oneshot::channel();
    let terminal = DeliveryTerminalGuard {
        sender: terminal_sender,
        thread_id,
        generation,
        completed: false,
    };
    tokio::spawn(async move {
        let freeze_failure = if let Some((row, provider_session_id)) = frozen_session {
            match repositories
                .freeze_provider_turn_session(
                    row.command_id.clone(),
                    row.attempts,
                    row.provider_instance_id.clone(),
                    row.provider_kind.clone(),
                    provider_session_id,
                    now(),
                )
                .await
            {
                Ok(Some(_)) => None,
                Ok(None) => Some(ProviderDeliveryOutcome::DefinitelyNotSent {
                    detail: format!(
                        "durable provider session freeze conflicted for {} at attempt {}",
                        row.command_id, row.attempts
                    ),
                }),
                Err(error) => Some(ProviderDeliveryOutcome::DefinitelyNotSent {
                    detail: format!(
                        "durable provider session freeze failed for {}: {error}",
                        row.command_id
                    ),
                }),
            }
        } else {
            None
        };
        let outcome = if let Some(outcome) = freeze_failure {
            outcome
        } else {
            driver
                .deliver(
                    message.text,
                    message.attachments,
                    interaction_mode,
                    delivery_key,
                )
                .await
        };
        if let ProviderDeliveryOutcome::Accepted { turn_id } = &outcome {
            if let Err(error) = persist_runtime(
                &repositories,
                &launch,
                "running",
                resume_cursor,
                runtime_payload,
            )
            .await
            {
                tracing::warn!(%error, "accepted provider delivery runtime state was not persisted");
            }
            if let Err(error) =
                dispatch_session_state(&engine, &launch, "running", turn_id.clone(), None).await
            {
                tracing::warn!(%error, "accepted provider delivery session state was not projected");
            }
        }
        terminal.complete();
        let _ = completion_tx.send(outcome);
    });
    Ok(ProviderDeliveryHandle { completion })
}

fn provider_supports_agent_activity(provider: &str) -> bool {
    matches!(provider, "codex" | "claude" | "claudeAgent" | "opencode")
}

async fn ensure_live_activity_scope(
    activity: &ActivityProjection,
    request: &ProviderLaunchRequest,
    activity_lifecycle: &SharedActivityLifecycle,
    capabilities: &ActivityCapabilities,
    event_key: String,
) -> Result<(), ProviderRuntimeError> {
    let activity_scope = ActivityScopeSeed::thread(
        format!("thread:{}", request.thread_id),
        request.thread_id.clone(),
        request.provider.clone(),
        request.provider_instance_id.as_deref(),
        capabilities.clone(),
    )
    .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    activity
        .ensure_scope(activity_scope)
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    let snapshot = activity
        .snapshot(&ActivityScopeRef::Thread {
            thread_id: request.thread_id.clone(),
        })
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    let retained = {
        let mut lifecycle = activity_lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        lifecycle
            .retained
            .retain(RetainedActivitySections::from_counts(&snapshot.counts));
        lifecycle.retained
    };
    activity
        .apply(
            &format!("thread:{}", request.thread_id),
            event_key,
            activity_scope_mutations(capabilities, ActivityObservationState::Live, retained),
            now(),
        )
        .await
        .map(|_| ())
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))
}

async fn set_live_agent_activity_enabled(
    activity: &ActivityProjection,
    sessions: &HashMap<String, SessionEntry>,
    enabled: bool,
) -> Result<usize, ProviderRuntimeError> {
    let mut successful_sessions = 0;
    let mut first_error = None;
    let controller_state = activity.agent_activity_controller().snapshot();
    let mut thread_ids = sessions.keys().collect::<Vec<_>>();
    thread_ids.sort();
    for thread_id in thread_ids {
        let entry = &sessions[thread_id];
        match entry.driver.set_agent_activity_enabled(enabled).await {
            Ok(()) => {
                successful_sessions += 1;
                if enabled && entry.activity_capable && controller_state.enabled {
                    let capabilities = entry
                        .activity_lifecycle
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .capabilities
                        .clone();
                    if let Err(error) = ensure_live_activity_scope(
                        activity,
                        &entry.launch,
                        &entry.activity_lifecycle,
                        &capabilities,
                        format!(
                            "supervisor:toggle-live:{}:{}",
                            controller_state.generation, entry.launch.thread_id
                        ),
                    )
                    .await
                        && first_error.is_none()
                    {
                        first_error = Some(error);
                    }
                }
            }
            Err(error) if first_error.is_none() => {
                first_error = Some(normalize_agent_activity_transition_error(error));
            }
            Err(_) => {}
        }
    }
    first_error.map_or(Ok(successful_sessions), Err)
}

fn normalize_agent_activity_transition_error(error: ProviderRuntimeError) -> ProviderRuntimeError {
    let category = match error {
        ProviderRuntimeError::Shutdown => "supervisor shutdown",
        ProviderRuntimeError::QueueClosed => "command queue closed",
        ProviderRuntimeError::ResponseDropped => "response dropped",
        ProviderRuntimeError::SessionNotFound { .. } => "session missing",
        ProviderRuntimeError::StaleSession { .. } => "session stale",
        ProviderRuntimeError::SessionAlreadyExists { .. } => "session conflict",
        ProviderRuntimeError::UnsupportedProvider { .. } => "unsupported provider",
        ProviderRuntimeError::UnsupportedCapability { .. } => "unsupported capability",
        ProviderRuntimeError::Spawn { .. } => "provider spawn failure",
        ProviderRuntimeError::Provider { .. } => "provider operation failure",
        ProviderRuntimeError::Persistence(_) => "persistence failure",
        ProviderRuntimeError::Orchestration(_) => "projection failure",
    };
    ProviderRuntimeError::Provider {
        provider: "agent-activity".to_owned(),
        detail: category.to_owned(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn launch_session(
    engine: &OrchestrationEngine,
    factory: &Arc<dyn ProviderDriverFactory>,
    activity: &ActivityProjection,
    sessions: &mut HashMap<String, SessionEntry>,
    mut request: ProviderLaunchRequest,
    operational_log: Option<&ProviderOperationalLog>,
    inherited_activity_lifecycle: Option<SharedActivityLifecycle>,
    terminal_sender: mpsc::UnboundedSender<SupervisorMessage>,
    idle_timeout: Duration,
) -> Result<(), ProviderRuntimeError> {
    let option_application_method = if inherited_activity_lifecycle.is_some() {
        "restart"
    } else {
        "live"
    };
    if request.provider == "grok" {
        return Err(ProviderRuntimeError::UnsupportedProvider {
            provider: "grok".to_owned(),
        });
    }
    if sessions.contains_key(&request.thread_id) {
        return Err(ProviderRuntimeError::SessionAlreadyExists {
            thread_id: request.thread_id,
        });
    }
    let activity_controller = activity.agent_activity_controller();
    if activity_controller.snapshot().enabled {
        request.activity_causal_revision = match activity
            .snapshot(&ActivityScopeRef::Thread {
                thread_id: request.thread_id.clone(),
            })
            .await
        {
            Ok(snapshot) => snapshot.revision,
            Err(ActivityRepositoryError::NotFound) => 0,
            Err(error) => {
                return Err(ProviderRuntimeError::Persistence(format!(
                    "activity causal revision snapshot failed: {error}"
                )));
            }
        };
    }
    let driver = factory.create(request.clone()).await?;
    persist_runtime(
        &engine.repositories(),
        &request,
        "connecting",
        request.resume_cursor.clone(),
        None,
    )
    .await?;
    driver
        .set_agent_activity_enabled(activity_controller.snapshot().enabled)
        .await?;
    let started = match driver.start().await {
        Ok(started) => started,
        Err(error) => {
            let _ = driver.shutdown().await;
            persist_runtime(
                &engine.repositories(),
                &request,
                "error",
                request.resume_cursor.clone(),
                Some(json!({ "error": error.to_string() })),
            )
            .await?;
            return Err(error);
        }
    };
    let options_result = driver.set_options(request.options.clone()).await;
    record_option_reconciliation(
        operational_log,
        &request,
        &request.options,
        option_application_method,
        match &options_result {
            Ok(()) => "applied",
            Err(ProviderRuntimeError::UnsupportedCapability { .. }) => "restart-required",
            Err(_) => "failed",
        },
    );
    if let Err(error) = options_result {
        let _ = driver.shutdown().await;
        persist_runtime(
            &engine.repositories(),
            &request,
            "error",
            started.resume_cursor.clone(),
            Some(json!({ "error": error.to_string() })),
        )
        .await?;
        return Err(error);
    }
    let activity_lifecycle_id = Uuid::new_v4();
    let activity_lifecycle = inherited_activity_lifecycle.unwrap_or_else(|| {
        Arc::new(StdMutex::new(ProviderActivityLifecycleState::new(
            started.activity_capabilities.clone(),
        )))
    });
    let activity_capable = provider_supports_agent_activity(&request.provider);
    if activity_capable && activity_controller.snapshot().enabled {
        let effective_activity_capabilities = activity_lifecycle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .apply_startup_capabilities(started.activity_capabilities.clone());
        if let Err(error) = ensure_live_activity_scope(
            activity,
            &request,
            &activity_lifecycle,
            &effective_activity_capabilities,
            format!("supervisor:launch-live:{activity_lifecycle_id}"),
        )
        .await
        {
            tracing::warn!(%error, "activity scope unavailable; continuing provider session");
        }
    }
    persist_runtime(
        &engine.repositories(),
        &request,
        "ready",
        started.resume_cursor.clone(),
        started.runtime_payload.clone(),
    )
    .await?;
    dispatch_session_state(engine, &request, "ready", None, None).await?;

    let cancellation = CancellationToken::new();
    let idle_generation = Arc::new(AtomicU64::new(0));
    let event_task = spawn_event_pump(
        engine.clone(),
        driver.clone(),
        request.clone(),
        started.resume_cursor.clone(),
        started.runtime_payload.clone(),
        activity.clone(),
        activity_lifecycle.clone(),
        activity_capable,
        format!("supervisor:stream-ended:{activity_lifecycle_id}"),
        cancellation.clone(),
        operational_log.cloned(),
        idle_generation.clone(),
        terminal_sender.clone(),
        idle_timeout,
    );
    sessions.insert(
        request.thread_id.clone(),
        SessionEntry {
            launch: request,
            driver,
            configuration_healthy: true,
            resume_cursor: started.resume_cursor,
            runtime_payload: started.runtime_payload,
            activity_capable,
            activity_lifecycle,
            activity_compensation_key: format!("supervisor:cancelled-live:{activity_lifecycle_id}"),
            event_task,
            event_cancellation: cancellation,
            idle_generation,
            terminal_sender,
            idle_timeout,
        },
    );
    Ok(())
}

async fn handle_command(
    engine: &OrchestrationEngine,
    factory: &Arc<dyn ProviderDriverFactory>,
    activity: &ActivityProjection,
    sessions: &mut HashMap<String, SessionEntry>,
    command: OrchestrationCommand,
    operational_log: Option<&ProviderOperationalLog>,
) -> Result<(), ProviderRuntimeError> {
    let thread_id = command_thread_id(&command)
        .map(str::to_owned)
        .ok_or_else(|| ProviderRuntimeError::Provider {
            provider: "orchestration".to_owned(),
            detail: format!(
                "{} is not a provider runtime command",
                command.command_type()
            ),
        })?;
    if matches!(command, OrchestrationCommand::ThreadSessionStop { .. }) {
        return stop_session(&engine.repositories(), activity, sessions, &thread_id).await;
    }
    match &command {
        OrchestrationCommand::ThreadTurnStart {
            model_selection: Some(selection),
            ..
        }
        | OrchestrationCommand::ThreadMetaUpdate {
            model_selection: Some(selection),
            ..
        } => {
            reconcile_model_selection(
                engine,
                factory,
                activity,
                sessions,
                &thread_id,
                selection,
                operational_log,
            )
            .await?;
        }
        _ => {}
    }
    let entry =
        sessions
            .get_mut(&thread_id)
            .ok_or_else(|| ProviderRuntimeError::SessionNotFound {
                thread_id: thread_id.clone(),
            })?;

    match command {
        OrchestrationCommand::ThreadTurnStart {
            message,
            interaction_mode,
            ..
        } => {
            entry.idle_generation.fetch_add(1, Ordering::Relaxed);
            let turn_id = entry
                .driver
                .send(message.text, message.attachments, interaction_mode)
                .await?;
            persist_entry(&engine.repositories(), entry, "running").await?;
            dispatch_session_state(engine, &entry.launch, "running", turn_id, None).await
        }
        OrchestrationCommand::ThreadTurnInterrupt { turn_id, .. } => {
            entry.driver.interrupt(turn_id).await?;
            persist_entry(&engine.repositories(), entry, "ready").await
        }
        OrchestrationCommand::ThreadApprovalRespond {
            request_id,
            decision,
            ..
        } => entry.driver.approve(request_id, decision).await,
        OrchestrationCommand::ThreadUserInputRespond {
            request_id,
            answers,
            ..
        } => entry.driver.answer(request_id, answers).await,
        OrchestrationCommand::ThreadRuntimeModeSet { runtime_mode, .. } => {
            match entry.driver.set_mode(runtime_mode.clone()).await {
                Ok(()) => {
                    entry.launch.runtime_mode = runtime_mode;
                    persist_entry(&engine.repositories(), entry, "ready").await
                }
                Err(ProviderRuntimeError::UnsupportedCapability { .. }) => {
                    let mut launch = entry.launch.clone();
                    launch.runtime_mode = runtime_mode;
                    restart_session(
                        engine,
                        factory,
                        activity,
                        sessions,
                        &thread_id,
                        launch,
                        operational_log,
                    )
                    .await
                }
                Err(error) => Err(error),
            }
        }
        OrchestrationCommand::ThreadInteractionModeSet {
            interaction_mode, ..
        } => {
            match entry
                .driver
                .set_interaction_mode(interaction_mode.clone())
                .await
            {
                Ok(()) => {
                    entry.launch.interaction_mode = interaction_mode;
                    persist_entry(&engine.repositories(), entry, "ready").await
                }
                Err(ProviderRuntimeError::UnsupportedCapability { .. }) => {
                    let mut launch = entry.launch.clone();
                    launch.interaction_mode = interaction_mode;
                    restart_session(
                        engine,
                        factory,
                        activity,
                        sessions,
                        &thread_id,
                        launch,
                        operational_log,
                    )
                    .await
                }
                Err(error) => Err(error),
            }
        }
        OrchestrationCommand::ThreadMetaUpdate {
            model_selection: Some(_),
            ..
        } => Ok(()),
        OrchestrationCommand::ThreadCheckpointRevert { turn_count, .. } => {
            entry.driver.rollback(turn_count).await
        }
        _ => Ok(()),
    }
}

async fn reconcile_model_selection(
    engine: &OrchestrationEngine,
    factory: &Arc<dyn ProviderDriverFactory>,
    activity: &ActivityProjection,
    sessions: &mut HashMap<String, SessionEntry>,
    thread_id: &str,
    selection: &Value,
    operational_log: Option<&ProviderOperationalLog>,
) -> Result<(), ProviderRuntimeError> {
    let target_model = model_from_selection(selection);
    let selection_options = selection_options(selection);
    let mut target_restart = None;
    let mut restore_restart = None;
    let mut rejected_update = None;
    {
        let entry =
            sessions
                .get_mut(thread_id)
                .ok_or_else(|| ProviderRuntimeError::SessionNotFound {
                    thread_id: thread_id.to_owned(),
                })?;
        if !entry.configuration_healthy {
            return Err(ProviderRuntimeError::Provider {
                provider: entry.launch.provider.clone(),
                detail: "provider configuration is unavailable after failed restoration".to_owned(),
            });
        }
        let target_options = provider_session_options(&entry.launch.provider, &selection_options);
        let target_service_tier = selection_string_option_from(&selection_options, "serviceTier");
        let target_effort = selection_effort(&selection_options);
        let target_agent = selection_string_option_from(&selection_options, "agent");
        let launch_only_changed = match entry.launch.provider.as_str() {
            "claude" | "claudeAgent" => {
                entry.launch.effort != target_effort || entry.launch.agent != target_agent
            }
            "opencode" => entry.launch.agent != target_agent,
            _ => false,
        };
        let model_changed = target_model
            .as_ref()
            .is_some_and(|model| entry.launch.model.as_ref() != Some(model));
        let options_changed = entry.launch.options != target_options;
        if !model_changed && !options_changed && !launch_only_changed {
            return Ok(());
        }
        if launch_only_changed {
            let mut launch = entry.launch.clone();
            if model_changed {
                launch.model.clone_from(&target_model);
            }
            launch.options = target_options;
            launch.service_tier = target_service_tier;
            launch.effort = target_effort;
            launch.agent = target_agent;
            target_restart = Some(launch);
            record_option_reconciliation(
                operational_log,
                &entry.launch,
                &selection_options,
                "restart",
                "restart-required",
            );
            // Agent and Claude effort are process arguments, not live session options.
            // Restart below rather than asking the driver to apply an invalid option.
        } else {
            let previous_model = entry.launch.model.clone();
            let previous_options = entry.launch.options.clone();
            let mut model_attempted = false;
            let options_require_target_model =
                model_changed && entry.driver.reapply_options_on_model_change();
            let update = async {
                if options_require_target_model {
                    model_attempted = true;
                    entry
                        .driver
                        .set_model(target_model.clone().expect("changed model is present"))
                        .await?;
                }
                if options_changed || options_require_target_model {
                    entry.driver.set_options(target_options.clone()).await?;
                }
                if model_changed
                    && !model_attempted
                    && let Some(model) = target_model.clone()
                {
                    model_attempted = true;
                    entry.driver.set_model(model).await?;
                }
                Ok::<(), ProviderRuntimeError>(())
            }
            .await;
            if options_changed {
                let mut log_launch = entry.launch.clone();
                if model_changed {
                    log_launch.model.clone_from(&target_model);
                }
                record_option_reconciliation(
                    operational_log,
                    &log_launch,
                    &target_options,
                    "live",
                    match &update {
                        Ok(()) => "applied",
                        Err(ProviderRuntimeError::UnsupportedCapability { .. }) => {
                            "restart-required"
                        }
                        Err(_) => "failed",
                    },
                );
            }
            match update {
                Ok(()) => {
                    let previous_launch = entry.launch.clone();
                    if model_changed {
                        entry.launch.model = target_model;
                    }
                    entry.launch.options = target_options;
                    entry.launch.service_tier = target_service_tier;
                    entry.launch.effort = target_effort;
                    entry.launch.agent = target_agent;
                    if let Err(error) = persist_entry(&engine.repositories(), entry, "ready").await
                    {
                        entry.launch = previous_launch.clone();
                        if !restore_driver_configuration(
                            entry,
                            model_changed,
                            previous_launch.model.clone(),
                            options_changed || options_require_target_model,
                            previous_launch.options.clone(),
                        )
                        .await
                        {
                            entry.configuration_healthy = false;
                            restore_restart = Some(previous_launch);
                        }
                        rejected_update = Some(error);
                    }
                }
                Err(ProviderRuntimeError::UnsupportedCapability { .. }) => {
                    let mut launch = entry.launch.clone();
                    if model_changed {
                        launch.model = target_model;
                    }
                    launch.options = target_options;
                    launch.service_tier = target_service_tier;
                    launch.effort = target_effort;
                    launch.agent = target_agent;
                    target_restart = Some(launch);
                }
                Err(error) => {
                    if !restore_driver_configuration(
                        entry,
                        model_attempted,
                        previous_model,
                        options_changed || options_require_target_model,
                        previous_options,
                    )
                    .await
                    {
                        entry.configuration_healthy = false;
                        restore_restart = Some(entry.launch.clone());
                    }
                    rejected_update = Some(error);
                }
            }
        }
    }
    if let Some(launch) = target_restart {
        restart_session(
            engine,
            factory,
            activity,
            sessions,
            thread_id,
            launch,
            operational_log,
        )
        .await?;
    }
    if let Some(launch) = restore_restart {
        restart_session(
            engine,
            factory,
            activity,
            sessions,
            thread_id,
            launch,
            operational_log,
        )
        .await?;
    }
    if let Some(error) = rejected_update {
        return Err(error);
    }
    Ok(())
}

async fn restore_driver_configuration(
    entry: &SessionEntry,
    restore_model: bool,
    model: Option<String>,
    restore_options: bool,
    options: Vec<Value>,
) -> bool {
    let mut restored = true;
    if restore_model {
        restored = if let Some(model) = model {
            entry.driver.set_model(model).await.is_ok()
        } else {
            false
        };
    }
    if restore_options {
        restored &= entry.driver.set_options(options).await.is_ok();
    }
    restored
}

fn record_option_reconciliation(
    operational_log: Option<&ProviderOperationalLog>,
    launch: &ProviderLaunchRequest,
    options: &[Value],
    application_method: &str,
    result: &str,
) {
    let Some(log) = operational_log else {
        return;
    };
    let accepted = matches!(result, "applied" | "restart-required");
    let provider_instance_id = launch
        .provider_instance_id
        .as_deref()
        .unwrap_or(&launch.provider);
    for option in options {
        let Some(option_id) = option.get("id").and_then(Value::as_str) else {
            continue;
        };
        let requested_value = option.get("value").and_then(|value| match value {
            Value::Bool(_) => Some(value),
            Value::String(_) if accepted => Some(value),
            _ => None,
        });
        let _ = log.record_option_reconciliation(
            &launch.thread_id,
            provider_instance_id,
            launch.model.as_deref(),
            if accepted { option_id } else { "unknown" },
            requested_value,
            application_method,
            result,
        );
    }
}

async fn restart_session(
    engine: &OrchestrationEngine,
    factory: &Arc<dyn ProviderDriverFactory>,
    activity: &ActivityProjection,
    sessions: &mut HashMap<String, SessionEntry>,
    thread_id: &str,
    mut launch: ProviderLaunchRequest,
    operational_log: Option<&ProviderOperationalLog>,
) -> Result<(), ProviderRuntimeError> {
    let mut inherited_activity_lifecycle = None;
    let mut terminal_sender = None;
    let mut idle_timeout = None;
    if let Some(entry) = sessions.get(thread_id) {
        launch.resume_cursor = entry.resume_cursor.clone();
        inherited_activity_lifecycle = Some(entry.activity_lifecycle.clone());
        terminal_sender = Some(entry.terminal_sender.clone());
        idle_timeout = Some(entry.idle_timeout);
        entry.driver.shutdown().await?;
    }
    if let Some(entry) = sessions.remove(thread_id) {
        entry.event_cancellation.cancel();
        entry.event_task.abort();
        let _ = entry.event_task.await;
        synchronize_activity_lifecycle(
            activity,
            &entry.launch.thread_id,
            &entry.activity_lifecycle,
        )
        .await;
        compensate_cancelled_activity(
            activity,
            &entry.launch,
            entry.activity_capable,
            &entry.activity_lifecycle,
            entry.activity_compensation_key,
        )
        .await;
    }
    engine
        .repositories()
        .delete_provider_session_runtime(thread_id.to_owned())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    launch_session(
        engine,
        factory,
        activity,
        sessions,
        launch,
        operational_log,
        inherited_activity_lifecycle,
        terminal_sender.ok_or_else(|| ProviderRuntimeError::SessionNotFound {
            thread_id: thread_id.to_owned(),
        })?,
        idle_timeout.ok_or_else(|| ProviderRuntimeError::SessionNotFound {
            thread_id: thread_id.to_owned(),
        })?,
    )
    .await
}

fn command_thread_id(command: &OrchestrationCommand) -> Option<&str> {
    match command {
        OrchestrationCommand::ThreadCreate { thread_id, .. }
        | OrchestrationCommand::ThreadDelete { thread_id, .. }
        | OrchestrationCommand::ThreadArchive { thread_id, .. }
        | OrchestrationCommand::ThreadUnarchive { thread_id, .. }
        | OrchestrationCommand::ThreadMetaUpdate { thread_id, .. }
        | OrchestrationCommand::ThreadRuntimeModeSet { thread_id, .. }
        | OrchestrationCommand::ThreadInteractionModeSet { thread_id, .. }
        | OrchestrationCommand::ThreadTurnStart { thread_id, .. }
        | OrchestrationCommand::ThreadTurnInterrupt { thread_id, .. }
        | OrchestrationCommand::ThreadApprovalRespond { thread_id, .. }
        | OrchestrationCommand::ThreadUserInputRespond { thread_id, .. }
        | OrchestrationCommand::ThreadCheckpointRevert { thread_id, .. }
        | OrchestrationCommand::ThreadSessionStop { thread_id, .. }
        | OrchestrationCommand::ThreadSessionSet { thread_id, .. }
        | OrchestrationCommand::ThreadMessageAssistantDelta { thread_id, .. }
        | OrchestrationCommand::ThreadMessageAssistantComplete { thread_id, .. }
        | OrchestrationCommand::ThreadProposedPlanUpsert { thread_id, .. }
        | OrchestrationCommand::ThreadTurnDiffComplete { thread_id, .. }
        | OrchestrationCommand::ThreadActivityAppend { thread_id, .. }
        | OrchestrationCommand::ThreadRevertComplete { thread_id, .. } => Some(thread_id),
        _ => None,
    }
}

fn model_from_selection(selection: &Value) -> Option<String> {
    selection
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty() && !model.eq_ignore_ascii_case("auto"))
        .map(str::to_owned)
}

fn unsupported_option(provider: &str, option_id: &str) -> ProviderRuntimeError {
    ProviderRuntimeError::Provider {
        provider: provider.to_owned(),
        detail: format!("option {option_id} is not supported by the selected model/session"),
    }
}

fn selection_options(selection: &Value) -> Vec<Value> {
    let mut options = BTreeMap::<String, Value>::new();
    for option in selection
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = option.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        let Some(value) = option.get("value") else {
            continue;
        };
        if id.is_empty() || !(value.is_string() || value.is_boolean()) {
            continue;
        }
        options.insert(id.to_owned(), value.clone());
    }
    options
        .into_iter()
        .map(|(id, value)| json!({ "id": id, "value": value }))
        .collect()
}

fn provider_session_options(provider: &str, options: &[Value]) -> Vec<Value> {
    options
        .iter()
        .filter(|option| {
            let id = option.get("id").and_then(Value::as_str);
            match provider {
                "claude" | "claudeAgent" => !matches!(
                    id,
                    Some("agent" | "effort" | "reasoningEffort" | "reasoning")
                ),
                "opencode" => id != Some("agent"),
                _ => true,
            }
        })
        .cloned()
        .collect()
}

fn selection_string_option_from(options: &[Value], id: &str) -> Option<String> {
    options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|option| option.get("value"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn selection_effort(options: &[Value]) -> Option<String> {
    ["reasoningEffort", "effort", "reasoning"]
        .into_iter()
        .find_map(|id| selection_string_option_from(options, id))
}

fn parse_provider_command(text: &str) -> Option<(&str, &str)> {
    let command = text.strip_prefix('/')?;
    let split = command.find(char::is_whitespace).unwrap_or(command.len());
    let name = &command[..split];
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return None;
    }
    Some((name, command[split..].trim()))
}

#[allow(clippy::too_many_arguments)]
fn spawn_event_pump(
    engine: OrchestrationEngine,
    driver: Arc<dyn ProviderDriver>,
    launch: ProviderLaunchRequest,
    resume_cursor: Option<Value>,
    runtime_payload: Option<Value>,
    activity: ActivityProjection,
    activity_lifecycle: SharedActivityLifecycle,
    activity_capable: bool,
    stream_ended_event_key: String,
    cancellation: CancellationToken,
    operational_log: Option<ProviderOperationalLog>,
    idle_generation: Arc<AtomicU64>,
    terminal_sender: mpsc::UnboundedSender<SupervisorMessage>,
    idle_timeout: Duration,
) -> JoinHandle<()> {
    let activity_controller = activity.agent_activity_controller();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                () = cancellation.cancelled() => return,
                event = driver.next_event() => {
                    let Some(event) = event else {
                        if activity_capable && activity_controller.snapshot().enabled {
                            if cancellation.is_cancelled() {
                                return;
                            }
                            let lifecycle = activity_lifecycle
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .clone();
                            let activity_scope_id = format!("thread:{}", launch.thread_id);
                            let stale_apply = activity.apply(
                                &activity_scope_id,
                                stream_ended_event_key.clone(),
                                activity_scope_mutations(
                                    &lifecycle.capabilities,
                                    ActivityObservationState::Stale,
                                    lifecycle.retained,
                                ),
                                now(),
                            );
                            tokio::select! {
                                biased;
                                () = cancellation.cancelled() => return,
                                result = stale_apply => {
                                    if let Err(error) = result {
                                        tracing::warn!(
                                            %error,
                                            provider = %launch.provider,
                                            thread_id = %launch.thread_id,
                                            "failed to mark provider activity scope stale"
                                        );
                                    }
                                }
                            }
                        }
                        if let Err(error) = driver.shutdown().await {
                            tracing::debug!(
                                %error,
                                provider = %launch.provider,
                                thread_id = %launch.thread_id,
                                "failed to shut down provider after its event stream ended"
                            );
                        }
                        return;
                    };
                    let mut event = event;
                    if let Some(log) = &operational_log {
                        let _ = log.record(&event);
                    }
                    let activity_state = activity_controller.snapshot();
                    if activity_capable
                        && activity_state.enabled
                        && !event.activity.is_empty()
                    {
                        let activity_batch = std::mem::take(&mut event.activity);
                        let native_event_id = event.native_event_id.take();
                        let activity_mutation_count = activity_batch.len();
                        if event.thread_id != launch.thread_id {
                            tracing::warn!(
                                provider = %launch.provider,
                                activity_mutation_count,
                                "dropped provider activity batch for mismatched event thread"
                            );
                        } else if let Some(native_event_id) = native_event_id {
                            let lifecycle_mutations = activity_batch.clone();
                            let native_event_key = format!(
                                "activity:{}:{}",
                                activity_state.generation,
                                native_event_id.as_str(),
                            );
                            match activity.apply(
                                &format!("thread:{}", launch.thread_id),
                                native_event_key,
                                activity_batch,
                                now(),
                            ).await {
                                    Err(error) => tracing::warn!(
                                        %error,
                                        activity_mutation_count,
                                        "failed to project provider activity batch"
                                    ),
                                    Ok(deltas) if !deltas.is_empty() => {
                                        activity_lifecycle
                                            .lock()
                                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                                            .observe_projected_batch(&lifecycle_mutations);
                                    }
                                    Ok(_) => {}
                            }
                        } else {
                            tracing::warn!(
                                provider = %launch.provider,
                                thread_id = %launch.thread_id,
                                activity_mutation_count,
                                "dropped activity batch without a stable native event key"
                            );
                        }
                    }
                    event.activity.clear();
                    if event.event_type == ACTIVITY_ONLY_PROVIDER_EVENT_TYPE {
                        continue;
                    }
                    let completed = event.event_type == "turn.completed"
                        && event.payload.get("state").and_then(Value::as_str) != Some("failed");
                    if let Err(error) = project_provider_event(
                        &engine,
                        &launch,
                        resume_cursor.clone(),
                        runtime_payload.clone(),
                        event,
                    ).await {
                        if matches!(error, ProviderRuntimeError::Orchestration(_))
                            && provider_thread_was_deleted(&engine.repositories(), &launch.thread_id)
                                .await
                        {
                            return;
                        }
                        tracing::warn!(%error, "failed to project provider runtime event");
                    } else if completed {
                        schedule_idle_suspend(
                            terminal_sender.clone(),
                            launch.thread_id.clone(),
                            idle_generation.clone(),
                            idle_timeout,
                        );
                    }
                }
            }
        }
    })
}

fn schedule_idle_suspend(
    sender: mpsc::UnboundedSender<SupervisorMessage>,
    thread_id: String,
    idle_generation: Arc<AtomicU64>,
    idle_timeout: Duration,
) {
    let generation = idle_generation.fetch_add(1, Ordering::Relaxed) + 1;
    tokio::spawn(async move {
        tokio::time::sleep(idle_timeout).await;
        let _ = sender.send(SupervisorMessage::SuspendIdle {
            thread_id,
            idle_generation,
            generation,
        });
    });
}

async fn provider_thread_was_deleted(repositories: &Repositories, thread_id: &str) -> bool {
    repositories
        .get_thread(thread_id.to_owned())
        .await
        .ok()
        .flatten()
        .is_some_and(|thread| thread.deleted_at.is_some())
}

async fn project_provider_event(
    engine: &OrchestrationEngine,
    launch: &ProviderLaunchRequest,
    resume_cursor: Option<Value>,
    runtime_payload: Option<Value>,
    event: ProviderEvent,
) -> Result<(), ProviderRuntimeError> {
    let created_at = now();
    let command_id = format!("provider:{}", Uuid::new_v4());
    let assistant_message_id = assistant_message_id(&event);
    if event.event_type == "turn.completed" {
        let state = event
            .payload
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("completed");
        let failed = state == "failed";
        let last_error = failed.then(|| provider_completion_error(&event.payload));
        let status = if failed { "error" } else { "ready" };
        persist_runtime(
            &engine.repositories(),
            launch,
            status,
            resume_cursor,
            runtime_payload,
        )
        .await?;
        dispatch_session_state(engine, launch, status, None, last_error).await?;
        let has_assistant_content = if failed {
            load_snapshot(&engine.repositories())
                .await
                .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?
                .messages
                .iter()
                .any(|message| message.message_id == assistant_message_id)
        } else {
            true
        };
        if has_assistant_content {
            engine
                .dispatch(OrchestrationCommand::ThreadMessageAssistantComplete {
                    command_id: format!("{command_id}:assistant-complete"),
                    thread_id: event.thread_id.clone(),
                    message_id: assistant_message_id.clone(),
                    turn_id: event.turn_id.clone(),
                    created_at: created_at.clone(),
                })
                .await
                .map_err(|error| ProviderRuntimeError::Orchestration(error.to_string()))?;
        }
    }
    let command = match event.event_type.as_str() {
        "content.delta"
        | "message.assistant.delta"
        | "assistant.message.delta"
        | "item.agent_message.delta" => OrchestrationCommand::ThreadMessageAssistantDelta {
            command_id,
            thread_id: event.thread_id,
            message_id: assistant_message_id.clone(),
            delta: event
                .payload
                .get("delta")
                .or_else(|| event.payload.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            turn_id: event.turn_id,
            created_at,
        },
        "message.assistant.completed" | "assistant.message.completed" => {
            OrchestrationCommand::ThreadMessageAssistantComplete {
                command_id,
                thread_id: event.thread_id,
                message_id: event
                    .payload
                    .get("messageId")
                    .and_then(Value::as_str)
                    .unwrap_or("assistant")
                    .to_owned(),
                turn_id: event.turn_id,
                created_at,
            }
        }
        "turn.proposed.completed" => {
            let turn_id = event.turn_id;
            OrchestrationCommand::ThreadProposedPlanUpsert {
                command_id,
                thread_id: event.thread_id,
                proposed_plan: ProposedPlanInput {
                    id: format!("plan:{}", Uuid::new_v4()),
                    turn_id,
                    plan_markdown: event
                        .payload
                        .get("planMarkdown")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    implemented_at: None,
                    implementation_thread_id: None,
                    created_at: created_at.clone(),
                    updated_at: created_at.clone(),
                },
                created_at,
            }
        }
        "thread.token-usage.updated" => {
            let Some(payload) = context_window_activity_payload(&event.payload) else {
                return Ok(());
            };
            OrchestrationCommand::ThreadActivityAppend {
                command_id,
                thread_id: event.thread_id,
                activity: ActivityInput {
                    id: format!("activity:{}", Uuid::new_v4()),
                    tone: "info".to_owned(),
                    kind: "context-window.updated".to_owned(),
                    summary: "Context window updated".to_owned(),
                    payload,
                    turn_id: event.turn_id,
                    sequence: None,
                    created_at: created_at.clone(),
                },
                created_at,
            }
        }
        _ => {
            let (tone, kind) = if event.event_type == "turn.completed"
                && event.payload.get("state").and_then(Value::as_str) == Some("failed")
            {
                ("error", "provider.error")
            } else {
                event_activity_shape(&event.event_type)
            };
            let mut payload = event.payload;
            if let Some(request_id) = event.request_id {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("requestId".to_owned(), Value::String(request_id));
                } else {
                    payload = json!({ "requestId": request_id, "detail": payload });
                }
            }
            if event.event_type == "mcp.status.updated" {
                let provider_instance_id = launch
                    .provider_instance_id
                    .clone()
                    .unwrap_or_else(|| launch.provider.clone());
                if let Some(object) = payload.as_object_mut() {
                    object.insert(
                        "providerInstanceId".to_owned(),
                        Value::String(provider_instance_id),
                    );
                } else {
                    payload = json!({
                        "providerInstanceId": provider_instance_id,
                        "detail": payload,
                    });
                }
            }
            OrchestrationCommand::ThreadActivityAppend {
                command_id,
                thread_id: event.thread_id,
                activity: ActivityInput {
                    id: format!("activity:{}", Uuid::new_v4()),
                    tone: tone.to_owned(),
                    kind: kind.to_owned(),
                    summary: event.event_type,
                    payload,
                    turn_id: event.turn_id,
                    sequence: None,
                    created_at: created_at.clone(),
                },
                created_at,
            }
        }
    };
    engine
        .dispatch(command)
        .await
        .map(|_| ())
        .map_err(|error| ProviderRuntimeError::Orchestration(error.to_string()))
}

fn context_window_activity_payload(payload: &Value) -> Option<Value> {
    let usage = payload.get("usage")?.as_object()?;
    let used_tokens = usage.get("usedTokens")?.as_u64()?;
    let mut sanitized = json!({ "usedTokens": used_tokens });
    let sanitized_object = sanitized.as_object_mut()?;

    for field in [
        "totalProcessedTokens",
        "inputTokens",
        "cachedInputTokens",
        "outputTokens",
        "reasoningOutputTokens",
        "lastUsedTokens",
        "lastInputTokens",
        "lastCachedInputTokens",
        "lastOutputTokens",
        "lastReasoningOutputTokens",
        "toolUses",
        "durationMs",
    ] {
        if let Some(value) = usage.get(field).and_then(Value::as_u64) {
            sanitized_object.insert(field.to_owned(), Value::from(value));
        }
    }
    if let Some(max_tokens) = usage
        .get("maxTokens")
        .and_then(Value::as_u64)
        .filter(|max_tokens| *max_tokens > 0)
    {
        sanitized_object.insert("maxTokens".to_owned(), Value::from(max_tokens));
    }
    if let Some(compacts_automatically) =
        usage.get("compactsAutomatically").and_then(Value::as_bool)
    {
        sanitized_object.insert(
            "compactsAutomatically".to_owned(),
            Value::from(compacts_automatically),
        );
    }

    Some(sanitized)
}

fn assistant_message_id(event: &ProviderEvent) -> String {
    event
        .payload
        .get("messageId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            event
                .turn_id
                .as_ref()
                .map(|turn_id| format!("assistant:{turn_id}"))
        })
        .unwrap_or_else(|| format!("assistant:{}", event.thread_id))
}

fn provider_completion_error(payload: &Value) -> String {
    payload
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or("Provider turn failed.")
        .to_owned()
}

fn event_activity_shape(event_type: &str) -> (&'static str, &'static str) {
    match event_type {
        "request.opened" => ("approval", "approval.requested"),
        "request.resolved" => ("approval", "approval.resolved"),
        "user-input.requested" => ("approval", "user-input.requested"),
        "user-input.resolved" => ("approval", "user-input.resolved"),
        event if event.contains("error") || event.contains("failed") => ("error", "provider.error"),
        event if event.starts_with("turn.") => ("info", "provider.turn"),
        event if event.starts_with("session.") => ("info", "provider.session"),
        _ => ("tool", "provider.event"),
    }
}

async fn dispatch_session_state(
    engine: &OrchestrationEngine,
    request: &ProviderLaunchRequest,
    status: &str,
    active_turn_id: Option<String>,
    last_error: Option<String>,
) -> Result<(), ProviderRuntimeError> {
    let created_at = now();
    engine
        .dispatch(OrchestrationCommand::ThreadSessionSet {
            command_id: format!("provider-session:{}", Uuid::new_v4()),
            thread_id: request.thread_id.clone(),
            session: SessionInput {
                thread_id: request.thread_id.clone(),
                status: status.to_owned(),
                provider_name: Some(request.provider.clone()),
                provider_instance_id: request.provider_instance_id.clone(),
                runtime_mode: request.runtime_mode.clone(),
                active_turn_id,
                last_error,
                updated_at: created_at.clone(),
            },
            created_at,
        })
        .await
        .map(|_| ())
        .map_err(|error| ProviderRuntimeError::Orchestration(error.to_string()))
}

async fn persist_entry(
    repositories: &Repositories,
    entry: &SessionEntry,
    status: &str,
) -> Result<(), ProviderRuntimeError> {
    persist_runtime(
        repositories,
        &entry.launch,
        status,
        entry.resume_cursor.clone(),
        entry.runtime_payload.clone(),
    )
    .await
}

async fn persist_runtime(
    repositories: &Repositories,
    request: &ProviderLaunchRequest,
    status: &str,
    resume_cursor: Option<Value>,
    runtime_payload: Option<Value>,
) -> Result<(), ProviderRuntimeError> {
    repositories
        .upsert_provider_session_runtime(ProviderSessionRuntime {
            thread_id: request.thread_id.clone(),
            provider_name: request.provider.clone(),
            provider_instance_id: request.provider_instance_id.clone(),
            adapter_key: native_adapter_key(&request.provider).to_owned(),
            runtime_mode: request.runtime_mode.clone(),
            status: status.to_owned(),
            last_seen_at: now(),
            resume_cursor,
            runtime_payload,
        })
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))
}

fn native_adapter_key(provider: &str) -> &'static str {
    match provider {
        "codex" => "codex-app-server",
        "claude" | "claudeAgent" => "claude-stream-json",
        "cursor" => "cursor-acp",
        "grok" => "grok-acp",
        "opencode" => "opencode-http",
        _ => "native-provider",
    }
}

async fn stop_session(
    repositories: &Repositories,
    activity: &ActivityProjection,
    sessions: &mut HashMap<String, SessionEntry>,
    thread_id: &str,
) -> Result<(), ProviderRuntimeError> {
    let result = match detach_session(activity, sessions, thread_id).await {
        Ok(entry) => entry.driver.shutdown().await,
        Err(ProviderRuntimeError::SessionNotFound { .. }) => Ok(()),
        Err(error) => return Err(error),
    };
    repositories
        .delete_provider_session_runtime(thread_id.to_owned())
        .await
        .map_err(|error| ProviderRuntimeError::Persistence(error.to_string()))?;
    result
}

async fn suspend_idle_session(
    repositories: &Repositories,
    activity: &ActivityProjection,
    sessions: &mut HashMap<String, SessionEntry>,
    thread_id: &str,
) -> Result<(), ProviderRuntimeError> {
    let entry = detach_session(activity, sessions, thread_id).await?;
    let result = entry.driver.shutdown().await;
    persist_runtime(
        repositories,
        &entry.launch,
        "suspended",
        entry.resume_cursor,
        entry.runtime_payload,
    )
    .await?;
    result
}

async fn detach_session(
    activity: &ActivityProjection,
    sessions: &mut HashMap<String, SessionEntry>,
    thread_id: &str,
) -> Result<DetachedSession, ProviderRuntimeError> {
    let Some(entry) = sessions.remove(thread_id) else {
        return Err(ProviderRuntimeError::SessionNotFound {
            thread_id: thread_id.to_owned(),
        });
    };
    let detached = DetachedSession {
        launch: entry.launch.clone(),
        driver: entry.driver.clone(),
        resume_cursor: entry.resume_cursor.clone(),
        runtime_payload: entry.runtime_payload.clone(),
    };
    entry.event_cancellation.cancel();
    entry.event_task.abort();
    let _ = entry.event_task.await;
    synchronize_activity_lifecycle(activity, &entry.launch.thread_id, &entry.activity_lifecycle)
        .await;
    compensate_cancelled_activity(
        activity,
        &entry.launch,
        entry.activity_capable,
        &entry.activity_lifecycle,
        entry.activity_compensation_key.clone(),
    )
    .await;
    Ok(detached)
}

async fn synchronize_activity_lifecycle(
    activity: &ActivityProjection,
    thread_id: &str,
    activity_lifecycle: &SharedActivityLifecycle,
) {
    if !activity.agent_activity_controller().snapshot().enabled {
        return;
    }
    let Ok(snapshot) = activity
        .snapshot(&ActivityScopeRef::Thread {
            thread_id: thread_id.to_owned(),
        })
        .await
    else {
        return;
    };
    activity_lifecycle
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .synchronize_projected_snapshot(snapshot.capabilities, &snapshot.counts);
}

async fn shutdown_sessions(
    repositories: &Repositories,
    activity: &ActivityProjection,
    sessions: &mut HashMap<String, SessionEntry>,
) -> Result<(), ProviderRuntimeError> {
    let thread_ids = sessions.keys().cloned().collect::<Vec<_>>();
    let mut first_error = None;
    for thread_id in thread_ids {
        if let Err(error) = stop_session(repositories, activity, sessions, &thread_id).await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

async fn compensate_cancelled_activity(
    activity: &ActivityProjection,
    launch: &ProviderLaunchRequest,
    activity_capable: bool,
    activity_lifecycle: &SharedActivityLifecycle,
    activity_compensation_key: String,
) {
    if !activity_capable || !activity.agent_activity_controller().snapshot().enabled {
        return;
    }
    let lifecycle = activity_lifecycle
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if let Err(error) = activity
        .apply(
            &format!("thread:{}", launch.thread_id),
            activity_compensation_key,
            activity_scope_mutations(
                &lifecycle.capabilities,
                ActivityObservationState::Live,
                lifecycle.retained,
            ),
            now(),
        )
        .await
    {
        tracing::warn!(
            %error,
            provider = %launch.provider,
            thread_id = %launch.thread_id,
            "failed to restore provider activity scope after cancellation"
        );
    }
}

fn activity_scope_mutations(
    capabilities: &ActivityCapabilities,
    observation_state: ActivityObservationState,
    retained: RetainedActivitySections,
) -> Vec<ProviderActivityMutation> {
    vec![
        ProviderActivityMutation::SetScope {
            capabilities: capabilities.clone(),
            observation_state,
        },
        ProviderActivityMutation::SetSectionHealth {
            section: ActivitySection::Subagents,
            health: if capabilities.actors {
                ActivitySectionHealth::live()
            } else if retained.actors {
                retained_activity_health()
            } else {
                ActivitySectionHealth::unsupported()
            },
        },
        ProviderActivityMutation::SetSectionHealth {
            section: ActivitySection::BackgroundTasks,
            health: if capabilities.background_work {
                ActivitySectionHealth::live()
            } else if retained.background_work {
                retained_activity_health()
            } else {
                ActivitySectionHealth::unsupported()
            },
        },
    ]
}

fn retained_activity_health() -> ActivitySectionHealth {
    ActivitySectionHealth::try_stale("Provider no longer reports this retained activity", false)
        .expect("static retained activity health is valid")
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

#[derive(Clone, Debug)]
pub struct NativeProviderDriverFactory {
    attachments: AttachmentMaterializer,
    attribution: ProcessAttributionRegistry,
    activity_controller: AgentActivityController,
}

impl NativeProviderDriverFactory {
    #[must_use]
    pub fn new(attachments_dir: PathBuf) -> Self {
        Self::with_process_attribution(attachments_dir, ProcessAttributionRegistry::new())
    }

    #[must_use]
    pub fn with_process_attribution(
        attachments_dir: PathBuf,
        attribution: ProcessAttributionRegistry,
    ) -> Self {
        Self::with_process_attribution_and_agent_activity_controller(
            attachments_dir,
            attribution,
            AgentActivityController::new(true),
        )
    }

    #[must_use]
    pub fn with_process_attribution_and_agent_activity_controller(
        attachments_dir: PathBuf,
        attribution: ProcessAttributionRegistry,
        activity_controller: AgentActivityController,
    ) -> Self {
        Self {
            attachments: AttachmentMaterializer::new(attachments_dir),
            attribution,
            activity_controller,
        }
    }
}

impl ProviderDriverFactory for NativeProviderDriverFactory {
    fn create(
        &self,
        request: ProviderLaunchRequest,
    ) -> BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, ProviderRuntimeError>> {
        Box::pin(async move {
            let activity_enabled = self.activity_controller.snapshot().enabled;
            match request.provider.as_str() {
                "codex" => Ok(Arc::new(
                    CodexDriver::spawn(
                        request,
                        self.attachments.clone(),
                        self.attribution.clone(),
                        activity_enabled,
                    )
                    .await?,
                ) as Arc<dyn ProviderDriver>),
                "cursor" => Ok(Arc::new(
                    CursorDriver::spawn(
                        request,
                        self.attachments.clone(),
                        self.attribution.clone(),
                    )
                    .await?,
                ) as Arc<dyn ProviderDriver>),
                "grok" => Ok(Arc::new(
                    GrokDriver::spawn(request, self.attachments.clone(), self.attribution.clone())
                        .await?,
                ) as Arc<dyn ProviderDriver>),
                "opencode" => Ok(Arc::new(
                    OpenCodeDriver::spawn(
                        request,
                        self.attachments.clone(),
                        self.attribution.clone(),
                        activity_enabled,
                    )
                    .await?,
                ) as Arc<dyn ProviderDriver>),
                "claude" | "claudeAgent" => Ok(Arc::new(
                    ClaudeDriver::spawn(
                        request,
                        self.attachments.clone(),
                        self.attribution.clone(),
                        activity_enabled,
                    )
                    .await?,
                ) as Arc<dyn ProviderDriver>),
                provider => Err(ProviderRuntimeError::UnsupportedProvider {
                    provider: provider.to_owned(),
                }),
            }
        })
    }
}

type SharedChild = Arc<Mutex<Box<dyn ChildWrapper>>>;

#[derive(Debug)]
struct AttributedChild {
    inner: Box<dyn ChildWrapper>,
    registration: Option<ProcessRegistration>,
}

impl ChildWrapper for AttributedChild {
    fn inner(&self) -> &dyn ChildWrapper {
        self.inner.as_ref()
    }

    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        self.inner.as_mut()
    }

    fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
        let Self { inner, .. } = *self;
        inner
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = self.inner.try_wait()?;
        if status.is_some() {
            self.registration.take();
        }
        Ok(status)
    }

    fn wait(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<std::process::ExitStatus>> + Send + '_>> {
        Box::pin(async move {
            let status = self.inner.wait().await?;
            self.registration.take();
            Ok(status)
        })
    }
}

fn spawn_child(
    request: &ProviderLaunchRequest,
    args: &[String],
    pipe_output: bool,
    attribution: ProcessAttributionRegistry,
) -> Result<Box<dyn ChildWrapper>, ProviderRuntimeError> {
    let provider = request.provider.clone();
    let environment = normalize_provider_environment(
        request
            .environment
            .iter()
            .map(|(name, value)| (OsStr::new(name), OsStr::new(value))),
    );
    let executable = resolve_provider_executable_with_environment(
        &request.binary_path,
        environment
            .iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
    )
    .ok_or_else(|| ProviderRuntimeError::Spawn {
        provider: provider.clone(),
        detail: format!("provider executable was not found: {}", request.binary_path),
    })?;
    let launch = prepare_provider_launch(&executable, args).map_err(|detail| {
        ProviderRuntimeError::Spawn {
            provider: provider.clone(),
            detail,
        }
    })?;
    let program = launch.program;
    let launch_args = launch.args;
    let mut command = CommandWrap::with_new(program, |command| {
        command
            .args(launch_args)
            .current_dir(&request.cwd)
            .stdin(Stdio::piped())
            .stdout(if pipe_output {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(if pipe_output {
                Stdio::piped()
            } else {
                Stdio::null()
            });
        command.envs(environment.iter().cloned());
        sanitize_provider_subprocess_environment(command);
    });
    configure_supervised_background_command_wrap(&mut command);
    let mut inner = command
        .spawn()
        .map_err(|error| ProviderRuntimeError::Spawn {
            provider,
            detail: error.to_string(),
        })?;
    let registration = inner
        .id()
        .and_then(|pid| NativeProcessSampler::process_identity(pid).ok())
        .filter(|_| matches!(inner.try_wait(), Ok(None)))
        .and_then(|identity| {
            attribution.register_identity(
                identity,
                ProcessRegistrationMetadata {
                    scope: AttributionScope::External,
                    kind: AttributionKind::Provider,
                    label: request.provider_label.clone(),
                    source: RegistrationSource::Provider,
                },
            )
        });
    Ok(Box::new(AttributedChild {
        inner,
        registration,
    }))
}

pub(crate) fn resolve_provider_executable(input: &str) -> Option<PathBuf> {
    resolve_provider_executable_with_environment(input, std::iter::empty())
}

pub(crate) fn effective_provider_search_path<'a>(
    environment: impl IntoIterator<Item = (&'a OsStr, &'a OsStr)>,
) -> Option<OsString> {
    normalize_provider_environment(environment)
        .into_iter()
        .find(|(name, _)| name == "PATH")
        .map(|(_, value)| value)
        .or_else(|| std::env::var_os("PATH"))
}

pub(crate) fn normalize_provider_environment<'a>(
    environment: impl IntoIterator<Item = (&'a OsStr, &'a OsStr)>,
) -> Vec<(OsString, OsString)> {
    let mut normalized = Vec::new();
    let mut path_seen = false;
    for (name, value) in environment {
        if name.to_string_lossy().eq_ignore_ascii_case("path") {
            if path_seen {
                continue;
            }
            path_seen = true;
            normalized.push((OsString::from("PATH"), value.to_os_string()));
        } else {
            normalized.push((name.to_os_string(), value.to_os_string()));
        }
    }
    normalized
}

pub(crate) fn resolve_provider_executable_with_environment<'a>(
    input: &str,
    environment: impl IntoIterator<Item = (&'a OsStr, &'a OsStr)>,
) -> Option<PathBuf> {
    let search_path = effective_provider_search_path(environment);
    resolve_provider_executable_in_path(input, search_path.as_deref())
}

pub(crate) fn resolve_provider_executable_in_path(
    input: &str,
    search_path: Option<&OsStr>,
) -> Option<PathBuf> {
    let path = PathBuf::from(input);
    if path.is_file() {
        return Some(path);
    }
    let cwd = std::env::current_dir().ok();
    let extensions = launch_executable_extensions(Platform::current(), None);
    locate_executable(input, cwd.as_deref(), search_path, &extensions)
}

pub(crate) fn prepare_provider_launch<I, S>(
    executable: &Path,
    arguments: I,
) -> Result<PreparedLaunch, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Ok(wrap_launch_program(Platform::current(), executable)?.prepare(arguments))
}

async fn kill_child(child: &SharedChild) {
    let mut child = child.lock().await;
    let report = terminate_and_wait(&mut **child).await;
    log_cleanup_failures("provider process", &report);
}

fn runtime_mode(value: &str) -> CodexRuntimeMode {
    match value {
        "approval-required" => CodexRuntimeMode::ApprovalRequired,
        "auto-accept-edits" => CodexRuntimeMode::AutoAcceptEdits,
        _ => CodexRuntimeMode::FullAccess,
    }
}

struct CodexDriver {
    runtime: CodexSessionRuntime,
    child: SharedChild,
    attachments: AttachmentMaterializer,
}

impl CodexDriver {
    async fn spawn(
        mut request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
        attribution: ProcessAttributionRegistry,
        activity_enabled: bool,
    ) -> Result<Self, ProviderRuntimeError> {
        if let Some(layout) = request.codex_home.as_ref() {
            materialize_codex_shadow_home(layout)
                .await
                .map_err(provider_error("codex"))?;
            if let Some(effective_home) = layout.effective_home_path.as_ref() {
                request.environment.insert(
                    "CODEX_HOME".to_owned(),
                    effective_home.to_string_lossy().into_owned(),
                );
            }
        }
        let mut args = Vec::new();
        if let Some(mcp) = request.mcp.as_ref() {
            request.environment.insert(
                "BIBCODE_MCP_BEARER_TOKEN".to_owned(),
                mcp.authorization_header
                    .strip_prefix("Bearer ")
                    .unwrap_or(&mcp.authorization_header)
                    .to_owned(),
            );
            args.extend([
                "-c".to_owned(),
                format!("mcp_servers.bibcode.url={}", mcp.endpoint),
                "-c".to_owned(),
                "mcp_servers.bibcode.bearer_token_env_var=\"BIBCODE_MCP_BEARER_TOKEN\"".to_owned(),
            ]);
        }
        args.push("app-server".to_owned());
        let mut child = spawn_child(&request, &args, true, attribution)?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdout"))?;
        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdin"))?;
        let stderr = child
            .stderr()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stderr"))?;
        let (connection, incoming) =
            JsonRpcConnection::spawn(stdout, stdin, stderr, ConnectionConfig::default());
        let resume_cursor = request.resume_cursor.as_ref().and_then(resume_string);
        let runtime = CodexSessionRuntime::new_with_agent_activity_enabled(
            CodexSessionOptions {
                version: env!("CARGO_PKG_VERSION").to_owned(),
                thread_id: request.thread_id,
                cwd: request.cwd.to_string_lossy().into_owned(),
                runtime_mode: runtime_mode(&request.runtime_mode),
                model: request.model,
                service_tier: None,
                effort: None,
                resume_cursor,
            },
            connection,
            incoming,
            activity_enabled,
        );
        Ok(Self {
            runtime,
            child: Arc::new(Mutex::new(child)),
            attachments,
        })
    }

    async fn prepare_turn_input(
        &self,
        text: String,
        attachments: Vec<Value>,
    ) -> Result<(String, Vec<Value>), ProviderRuntimeError> {
        let text = if let Some(("goal", objective)) = parse_provider_command(&text)
            && !objective.is_empty()
        {
            self.runtime
                .set_goal(objective)
                .await
                .map_err(provider_error("codex"))?;
            objective.to_owned()
        } else {
            text
        };
        let materialized = self
            .attachments
            .materialize(attachments)
            .await
            .map_err(attachment_error("codex"))?;
        let (images, files) = split_native_images_and_file_references(materialized);
        let text = append_file_references(text, &files).map_err(attachment_error("codex"))?;
        Ok((
            text,
            images.into_iter().map(codex_image).collect::<Vec<_>>(),
        ))
    }
}

impl ProviderDriver for CodexDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let session = self
                .runtime
                .start()
                .await
                .map_err(provider_error("codex"))?;
            Ok(StartedSession {
                resume_cursor: session
                    .resume_cursor
                    .map(|value| json!({ "threadId": value })),
                runtime_payload: Some(json!({ "model": session.model, "cwd": session.cwd })),
                activity_capabilities: ActivityCapabilities {
                    actors: true,
                    attributed_activity: true,
                    background_work: false,
                    history_recovery: ActivityHistoryRecovery::None,
                    terminal_observation: false,
                    targeted_actor_cancellation: false,
                },
            })
        })
    }
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        interaction_mode: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let (text, attachments) = self.prepare_turn_input(text, attachments).await?;
            self.runtime
                .send_turn(Some(text), attachments, Some(interaction_mode), None)
                .await
                .map(|turn| Some(turn.turn_id))
                .map_err(provider_error("codex"))
        })
    }
    fn deliver(
        &self,
        text: String,
        attachments: Vec<Value>,
        interaction_mode: String,
        delivery_key: String,
    ) -> BoxRuntimeFuture<'_, ProviderDeliveryOutcome> {
        Box::pin(async move {
            let (text, attachments) = match self.prepare_turn_input(text, attachments).await {
                Ok(input) => input,
                Err(error) => {
                    return ProviderDeliveryOutcome::Rejected {
                        detail: error.to_string(),
                    };
                }
            };
            match self
                .runtime
                .send_turn(
                    Some(text),
                    attachments,
                    Some(interaction_mode),
                    Some(delivery_key),
                )
                .await
            {
                Ok(turn) => ProviderDeliveryOutcome::Accepted {
                    turn_id: Some(turn.turn_id),
                },
                Err(crate::provider::codex::runtime::RuntimeError::MissingProviderThreadId) => {
                    ProviderDeliveryOutcome::DefinitelyNotSent {
                        detail: "Codex session is missing a provider thread id".to_owned(),
                    }
                }
                Err(error) => ProviderDeliveryOutcome::Ambiguous {
                    detail: error.to_string(),
                },
            }
        })
    }
    fn reconcile(
        &self,
        delivery_key: String,
    ) -> BoxRuntimeFuture<'_, ProviderReconciliationOutcome> {
        Box::pin(async move {
            match self.runtime.delivery_exists(&delivery_key).await {
                Ok(true) => ProviderReconciliationOutcome::Found,
                Ok(false) => ProviderReconciliationOutcome::Absent,
                Err(error) => ProviderReconciliationOutcome::Unavailable {
                    detail: error.to_string(),
                },
            }
        })
    }
    fn interrupt(
        &self,
        turn_id: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .interrupt_turn(turn_id)
                .await
                .map_err(provider_error("codex"))
        })
    }
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_request(&request_id, &decision)
                .await
                .map_err(provider_error("codex"))
        })
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_user_input(&request_id, answers)
                .await
                .map_err(provider_error("codex"))
        })
    }
    fn set_mode(&self, _mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("codex", "post-start runtime mode changes")
    }
    fn set_agent_activity_enabled(
        &self,
        enabled: bool,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime.set_agent_activity_enabled(enabled).await;
            Ok(())
        })
    }
    fn set_model(&self, _model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("codex", "post-start model changes")
    }
    fn set_options(
        &self,
        options: Vec<Value>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let mut service_tier = None;
            let mut effort = None;
            for option in options {
                let id = option.get("id").and_then(Value::as_str).ok_or_else(|| {
                    ProviderRuntimeError::Provider {
                        provider: "codex".to_owned(),
                        detail: "option is missing an id".to_owned(),
                    }
                })?;
                let value = option
                    .get("value")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| ProviderRuntimeError::Provider {
                        provider: "codex".to_owned(),
                        detail: format!("option {id} must be a non-empty string"),
                    })?;
                match id {
                    "serviceTier" => service_tier = Some(value),
                    "reasoningEffort" => effort = Some(value),
                    _ => {
                        return Err(ProviderRuntimeError::Provider {
                            provider: "codex".to_owned(),
                            detail: format!(
                                "option {id} is not supported by the selected model/session"
                            ),
                        });
                    }
                }
            }
            self.runtime
                .validate_turn_options(service_tier.as_deref(), effort.as_deref())
                .await
                .map_err(provider_error("codex"))?;
            self.runtime.set_turn_options(service_tier, effort).await;
            Ok(())
        })
    }
    fn rollback(&self, turn_count: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let count = u64::try_from(turn_count).map_err(|_| ProviderRuntimeError::Provider {
                provider: "codex".to_owned(),
                detail: "turn count must be non-negative".to_owned(),
            })?;
            self.runtime
                .rollback_thread(count)
                .await
                .map(|_| ())
                .map_err(provider_error("codex"))
        })
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            self.runtime.next_event().await.map(|event| ProviderEvent {
                native_event_id: event
                    .native_event_id
                    .and_then(|value| ProviderNativeEventId::new(value).ok()),
                event_type: event.event_type,
                thread_id: event.thread_id,
                turn_id: event.turn_id,
                request_id: event.request_id,
                payload: event.payload,
                activity: event.activity,
            })
        })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let result = self
                .runtime
                .shutdown()
                .await
                .map_err(provider_error("codex"));
            kill_child(&self.child).await;
            result
        })
    }
}

struct CursorDriver {
    runtime: CursorSessionRuntime,
    child: SharedChild,
    attachments: AttachmentMaterializer,
}
impl CursorDriver {
    async fn spawn(
        request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
        attribution: ProcessAttributionRegistry,
    ) -> Result<Self, ProviderRuntimeError> {
        let mut args = Vec::new();
        if let Some(endpoint) = request.endpoint.as_ref() {
            args.extend(["-e".to_owned(), endpoint.clone()]);
        }
        args.push("acp".to_owned());
        let mut child = spawn_child(&request, &args, true, attribution)?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdout"))?;
        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdin"))?;
        let stderr = child
            .stderr()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stderr"))?;
        let (connection, incoming) =
            CursorConnection::spawn(stdout, stdin, stderr, CursorConnectionConfig::default());
        let runtime = CursorSessionRuntime::new(
            CursorSessionOptions {
                thread_id: request.thread_id,
                cwd: request.cwd.to_string_lossy().into_owned(),
                runtime_mode: request.runtime_mode,
                interaction_mode: request.interaction_mode,
                model: request.model.unwrap_or_default(),
                resume_session_id: request.resume_cursor.as_ref().and_then(resume_string),
                mcp_servers: acp_mcp_servers(request.mcp.as_ref()),
            },
            connection,
            incoming,
        );
        Ok(Self {
            runtime,
            child: Arc::new(Mutex::new(child)),
            attachments,
        })
    }

    async fn prepare_turn_input(
        &self,
        text: String,
        attachments: Vec<Value>,
    ) -> Result<(String, Vec<Value>), ProviderRuntimeError> {
        let materialized = self
            .attachments
            .materialize(attachments)
            .await
            .map_err(attachment_error("cursor"))?;
        let (images, files) = split_native_images_and_file_references(materialized);
        let text = append_file_references(text, &files).map_err(attachment_error("cursor"))?;
        Ok((text, images.into_iter().map(acp_image).collect()))
    }
}

impl ProviderDriver for CursorDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let session_id = self
                .runtime
                .start()
                .await
                .map_err(provider_error("cursor"))?;
            Ok(StartedSession {
                resume_cursor: Some(json!({
                    "schemaVersion": 1,
                    "sessionId": session_id,
                })),
                runtime_payload: None,
                activity_capabilities: ActivityCapabilities::none(),
            })
        })
    }
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let (text, attachments) = self.prepare_turn_input(text, attachments).await?;
            self.runtime
                .send_turn(Some(&text), attachments)
                .await
                .map(Some)
                .map_err(provider_error("cursor"))
        })
    }
    fn deliver(
        &self,
        text: String,
        attachments: Vec<Value>,
        _: String,
        _: String,
    ) -> BoxRuntimeFuture<'_, ProviderDeliveryOutcome> {
        Box::pin(async move {
            let (text, attachments) = match self.prepare_turn_input(text, attachments).await {
                Ok(input) => input,
                Err(error) => {
                    return ProviderDeliveryOutcome::Rejected {
                        detail: error.to_string(),
                    };
                }
            };
            let receipt = match self
                .runtime
                .send_turn_with_receipt(Some(&text), attachments)
                .await
            {
                Ok(receipt) => receipt,
                Err(error) => {
                    return ProviderDeliveryOutcome::DefinitelyNotSent {
                        detail: error.to_string(),
                    };
                }
            };
            let turn_id = receipt.turn_id.clone();
            match receipt.completion().await {
                Ok(()) => ProviderDeliveryOutcome::Accepted {
                    turn_id: Some(turn_id),
                },
                Err(
                    error @ CursorRuntimeError::Protocol(
                        crate::provider::cursor::acp::AcpProtocolError::RemoteRequest { .. },
                    ),
                ) => ProviderDeliveryOutcome::Rejected {
                    detail: error.to_string(),
                },
                Err(error) => ProviderDeliveryOutcome::Ambiguous {
                    detail: error.to_string(),
                },
            }
        })
    }
    fn interrupt(
        &self,
        _: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .interrupt_turn()
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_request(&request_id, &decision)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_user_input(&request_id, answers)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_runtime_mode(&mode)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn set_interaction_mode(
        &self,
        mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_interaction_mode(&mode)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_model(&model)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn reapply_options_on_model_change(&self) -> bool {
        true
    }
    fn set_options(
        &self,
        options: Vec<Value>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_options(options)
                .await
                .map_err(provider_error("cursor"))
        })
    }
    fn rollback(&self, _: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("cursor", "checkpoint rollback")
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            self.runtime.next_event().await.map(|event| ProviderEvent {
                native_event_id: None,
                event_type: event.event_type,
                thread_id: event.thread_id,
                turn_id: event.turn_id,
                request_id: event.request_id,
                payload: event.payload,
                activity: Vec::new(),
            })
        })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            kill_child(&self.child).await;
            Ok(())
        })
    }
}

struct GrokDriver {
    runtime: GrokSessionRuntime,
    child: SharedChild,
    requested_model: Option<String>,
    attachments: AttachmentMaterializer,
}
impl GrokDriver {
    async fn spawn(
        mut request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
        attribution: ProcessAttributionRegistry,
    ) -> Result<Self, ProviderRuntimeError> {
        request
            .environment
            .entry("GROK_OAUTH2_REFERRER".to_owned())
            .or_insert_with(|| "bibcode".to_owned());
        let auth_method_id = if request
            .environment
            .get("XAI_API_KEY")
            .is_some_and(|value| !value.trim().is_empty())
        {
            "xai.api_key"
        } else {
            "cached_token"
        }
        .to_owned();
        let args = vec!["agent".to_owned(), "stdio".to_owned()];
        let mut child = spawn_child(&request, &args, true, attribution)?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdout"))?;
        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdin"))?;
        let stderr = child
            .stderr()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stderr"))?;
        let (connection, incoming) =
            GrokConnection::spawn(stdout, stdin, stderr, GrokConnectionConfig::default());
        let resume_session_id = request.resume_cursor.as_ref().and_then(resume_string);
        let runtime = GrokSessionRuntime::new_with_auth_and_resume(
            GrokSessionOptions {
                thread_id: request.thread_id,
                cwd: request.cwd.to_string_lossy().into_owned(),
                mcp_servers: acp_mcp_servers(request.mcp.as_ref()),
                runtime_mode: request.runtime_mode,
                interaction_mode: request.interaction_mode,
            },
            connection,
            incoming,
            auth_method_id,
            resume_session_id,
        );
        Ok(Self {
            runtime,
            child: Arc::new(Mutex::new(child)),
            requested_model: request.model,
            attachments,
        })
    }
}

impl ProviderDriver for GrokDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let id = self.runtime.start().await.map_err(provider_error("grok"))?;
            if let Some(model) = self.requested_model.as_deref() {
                self.runtime
                    .set_model(model)
                    .await
                    .map_err(provider_error("grok"))?;
            }
            Ok(StartedSession {
                resume_cursor: Some(json!({"schemaVersion":1,"sessionId": id})),
                runtime_payload: None,
                activity_capabilities: ActivityCapabilities::none(),
            })
        })
    }
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let materialized = self
                .attachments
                .materialize(attachments)
                .await
                .map_err(attachment_error("grok"))?;
            let (images, files) = split_native_images_and_file_references(materialized);
            let text = append_file_references(text, &files).map_err(attachment_error("grok"))?;
            let attachments = images.into_iter().map(acp_image).collect();
            self.runtime
                .send_turn(Some(&text), attachments)
                .await
                .map(Some)
                .map_err(provider_error("grok"))
        })
    }
    fn interrupt(
        &self,
        turn_id: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let Some(turn_id) = turn_id else {
                return Ok(());
            };
            self.runtime
                .interrupt_turn(&turn_id)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_request(&request_id, &decision)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_user_input(&request_id, answers)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_runtime_mode(&mode)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn set_interaction_mode(
        &self,
        mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_interaction_mode(&mode)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_model(&model)
                .await
                .map_err(provider_error("grok"))
        })
    }
    fn set_options(
        &self,
        options: Vec<Value>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        reject_unsupported_options("grok", options)
    }
    fn rollback(&self, _: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("grok", "checkpoint rollback")
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            self.runtime.next_event().await.map(|event| ProviderEvent {
                native_event_id: None,
                event_type: event.event_type,
                thread_id: event.thread_id,
                turn_id: event.turn_id,
                request_id: event.request_id,
                payload: event.payload,
                activity: Vec::new(),
            })
        })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            kill_child(&self.child).await;
            Ok(())
        })
    }
}

struct OpenCodeDriver {
    runtime: OpenCodeSessionRuntime,
    child: Option<SharedChild>,
    resume_session_id: Option<String>,
    attachments: AttachmentMaterializer,
}
impl OpenCodeDriver {
    async fn spawn(
        mut request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
        attribution: ProcessAttributionRegistry,
        activity_enabled: bool,
    ) -> Result<Self, ProviderRuntimeError> {
        if let Some(endpoint) = request.endpoint.as_ref() {
            let runtime =
                OpenCodeSessionRuntime::new_with_options_reconciliation_revision_and_agent_activity(
                endpoint,
                &request.thread_id,
                &request.cwd.to_string_lossy(),
                request.model.as_deref(),
                request.server_password.as_deref(),
                request.agent.as_deref(),
                request.activity_causal_revision,
                activity_enabled,
            )
            .map_err(provider_error("opencode"))?;
            runtime.configure_runtime_mode(&request.runtime_mode).await;
            return Ok(Self {
                runtime,
                child: None,
                resume_session_id: request.resume_cursor.as_ref().and_then(resume_string),
                attachments,
            });
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(provider_error("opencode"))?;
        let port = listener
            .local_addr()
            .map_err(provider_error("opencode"))?
            .port();
        drop(listener);
        let endpoint = format!("http://127.0.0.1:{port}");
        let local_password = Uuid::new_v4().to_string();
        request.environment.insert(
            "OPENCODE_SERVER_PASSWORD".to_owned(),
            local_password.clone(),
        );
        let args = vec![
            "serve".to_owned(),
            "--hostname=127.0.0.1".to_owned(),
            format!("--port={port}"),
        ];
        let child = Arc::new(Mutex::new(spawn_child(
            &request,
            &args,
            false,
            attribution,
        )?));
        wait_for_endpoint(&endpoint, &child).await?;
        let runtime =
            OpenCodeSessionRuntime::new_with_options_reconciliation_revision_and_agent_activity(
                &endpoint,
                &request.thread_id,
                &request.cwd.to_string_lossy(),
                request.model.as_deref(),
                Some(&local_password),
                request.agent.as_deref(),
                request.activity_causal_revision,
                activity_enabled,
            )
            .map_err(provider_error("opencode"))?;
        runtime.configure_runtime_mode(&request.runtime_mode).await;
        if let Some(mcp) = request.mcp.as_ref() {
            runtime
                .add_mcp_server("bibcode", &mcp.endpoint, &mcp.authorization_header)
                .await
                .map_err(provider_error("opencode"))?;
        }
        Ok(Self {
            runtime,
            child: Some(child),
            resume_session_id: request.resume_cursor.as_ref().and_then(resume_string),
            attachments,
        })
    }

    async fn materialize_turn_attachments(
        &self,
        attachments: Vec<Value>,
    ) -> Result<Vec<Value>, ProviderRuntimeError> {
        Ok(self
            .attachments
            .materialize(attachments)
            .await
            .map_err(attachment_error("opencode"))?
            .into_iter()
            .map(opencode_file)
            .collect())
    }
}

impl ProviderDriver for OpenCodeDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let id = match &self.resume_session_id {
                Some(session_id) => self.runtime.resume(session_id).await,
                None => self.runtime.start().await,
            }
            .map_err(provider_error("opencode"))?;
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId":id})),
                runtime_payload: None,
                activity_capabilities: ActivityCapabilities::none(),
            })
        })
    }
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let attachments = self.materialize_turn_attachments(attachments).await?;
            let turn = if attachments.is_empty() {
                match parse_provider_command(&text) {
                    Some((command, arguments)) => {
                        self.runtime.send_command(command, arguments, None).await
                    }
                    None => self.runtime.send_turn(Some(&text), attachments, None).await,
                }
            } else {
                self.runtime.send_turn(Some(&text), attachments, None).await
            };
            turn.map(Some).map_err(provider_error("opencode"))
        })
    }
    fn deliver(
        &self,
        text: String,
        attachments: Vec<Value>,
        _: String,
        delivery_key: String,
    ) -> BoxRuntimeFuture<'_, ProviderDeliveryOutcome> {
        Box::pin(async move {
            let attachments = match self.materialize_turn_attachments(attachments).await {
                Ok(attachments) => attachments,
                Err(error) => {
                    return ProviderDeliveryOutcome::Rejected {
                        detail: error.to_string(),
                    };
                }
            };
            let result = if attachments.is_empty() {
                match parse_provider_command(&text) {
                    Some((command, arguments)) => {
                        self.runtime
                            .send_command(command, arguments, Some(&delivery_key))
                            .await
                    }
                    None => {
                        self.runtime
                            .send_turn(Some(&text), attachments, Some(&delivery_key))
                            .await
                    }
                }
            } else {
                self.runtime
                    .send_turn(Some(&text), attachments, Some(&delivery_key))
                    .await
            };
            match result {
                Ok(turn_id) => ProviderDeliveryOutcome::Accepted {
                    turn_id: Some(turn_id),
                },
                Err(error @ crate::provider::opencode::runtime::OpenCodeRuntimeError::MissingSession)
                | Err(error @ crate::provider::opencode::runtime::OpenCodeRuntimeError::InvalidResponse(_)) => {
                    ProviderDeliveryOutcome::DefinitelyNotSent {
                        detail: error.to_string(),
                    }
                }
                Err(error) => ProviderDeliveryOutcome::Ambiguous {
                    detail: error.to_string(),
                },
            }
        })
    }
    fn reconcile(
        &self,
        delivery_key: String,
    ) -> BoxRuntimeFuture<'_, ProviderReconciliationOutcome> {
        Box::pin(async move {
            match self.runtime.message_exists(&delivery_key).await {
                Ok(true) => ProviderReconciliationOutcome::Found,
                Ok(false) => ProviderReconciliationOutcome::Absent,
                Err(error) => ProviderReconciliationOutcome::Unavailable {
                    detail: error.to_string(),
                },
            }
        })
    }
    fn interrupt(
        &self,
        _: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .interrupt_turn()
                .await
                .map_err(provider_error("opencode"))
        })
    }
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_permission(&request_id, &decision)
                .await
                .map_err(provider_error("opencode"))
        })
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .respond_to_user_input(&request_id, answers)
                .await
                .map_err(provider_error("opencode"))
        })
    }
    fn set_mode(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("opencode", "post-start runtime mode changes")
    }
    fn set_agent_activity_enabled(
        &self,
        enabled: bool,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime.set_agent_activity_enabled(enabled).await;
            Ok(())
        })
    }
    fn set_model(&self, model: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_model(&model)
                .await
                .map_err(provider_error("opencode"))
        })
    }
    fn reapply_options_on_model_change(&self) -> bool {
        true
    }
    fn set_options(
        &self,
        options: Vec<Value>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .set_options(options)
                .await
                .map_err(provider_error("opencode"))
        })
    }
    fn rollback(&self, count: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let count = usize::try_from(count).map_err(|_| ProviderRuntimeError::Provider {
                provider: "opencode".to_owned(),
                detail: "turn count must be non-negative".to_owned(),
            })?;
            self.runtime
                .rollback_thread(count)
                .await
                .map(|_| ())
                .map_err(provider_error("opencode"))
        })
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            self.runtime.next_event().await.map(|event| ProviderEvent {
                native_event_id: event
                    .native_event_id
                    .and_then(|event_id| ProviderNativeEventId::new(event_id).ok()),
                event_type: event.event_type,
                thread_id: event.thread_id,
                turn_id: event.turn_id,
                request_id: event.request_id,
                payload: event.payload,
                activity: event.activity,
            })
        })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let result = self
                .runtime
                .stop()
                .await
                .map_err(provider_error("opencode"));
            if let Some(child) = &self.child {
                kill_child(child).await;
            }
            result
        })
    }
}

#[derive(Default)]
struct ClaudeAcknowledgementState {
    next_id: u64,
    pending: Option<(u64, oneshot::Sender<()>)>,
}

#[derive(Clone, Default)]
struct ClaudeAcknowledgementSlot {
    state: Arc<StdMutex<ClaudeAcknowledgementState>>,
}

impl ClaudeAcknowledgementSlot {
    fn register(&self, sender: oneshot::Sender<()>) -> Option<ClaudeAcknowledgementRegistration> {
        let mut state = self.state.lock().expect("Claude acknowledgement lock");
        if state.pending.is_some() {
            return None;
        }
        state.next_id = state.next_id.wrapping_add(1);
        let id = state.next_id;
        state.pending = Some((id, sender));
        Some(ClaudeAcknowledgementRegistration {
            id,
            state: self.state.clone(),
        })
    }

    fn acknowledge(&self) {
        if let Some((_, sender)) = self
            .state
            .lock()
            .expect("Claude acknowledgement lock")
            .pending
            .take()
        {
            let _ = sender.send(());
        }
    }
}

struct ClaudeAcknowledgementRegistration {
    id: u64,
    state: Arc<StdMutex<ClaudeAcknowledgementState>>,
}

impl Drop for ClaudeAcknowledgementRegistration {
    fn drop(&mut self) {
        let mut state = self.state.lock().expect("Claude acknowledgement lock");
        if state.pending.as_ref().map(|(id, _)| *id) == Some(self.id) {
            state.pending.take();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClaudeControlQueryError {
    Remote,
    Closed,
}

type ClaudeControlResponseWaiters =
    Arc<StdMutex<HashMap<String, oneshot::Sender<Result<Value, ClaudeControlQueryError>>>>>;

#[derive(Clone)]
struct ClaudeControlResponseRouter {
    pending: ClaudeControlResponseWaiters,
    closed: Arc<AtomicBool>,
}

impl Default for ClaudeControlResponseRouter {
    fn default() -> Self {
        Self {
            pending: Arc::new(StdMutex::new(HashMap::new())),
            closed: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl ClaudeControlResponseRouter {
    fn register(&self, request_id: String) -> Option<ClaudeControlResponseRegistration> {
        if self.closed.load(Ordering::Acquire) {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        let mut pending = self.pending.lock().expect("Claude control response lock");
        if self.closed.load(Ordering::Acquire) || pending.contains_key(&request_id) {
            return None;
        }
        pending.insert(request_id.clone(), sender);
        Some(ClaudeControlResponseRegistration {
            request_id,
            pending: self.pending.clone(),
            receiver: Some(receiver),
        })
    }

    fn route(&self, value: &Value) -> bool {
        if value.get("type").and_then(Value::as_str) != Some("control_response") {
            return false;
        }
        let Ok(frame) = serde_json::from_value::<ClaudeControlResponseFrame>(value.clone()) else {
            return false;
        };
        let response = frame.response;
        let result = if response.subtype == "success" && response.error.is_none() {
            Ok(response.response)
        } else {
            Err(ClaudeControlQueryError::Remote)
        };
        let mut pending = self.pending.lock().expect("Claude control response lock");
        if let Some(sender) = pending.remove(&response.request_id) {
            let _ = sender.send(result);
        }
        true
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let mut pending = self.pending.lock().expect("Claude control response lock");
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(ClaudeControlQueryError::Closed));
        }
    }

    #[cfg(test)]
    fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .expect("Claude control response lock")
            .len()
    }
}

struct ClaudeControlResponseRegistration {
    request_id: String,
    pending: ClaudeControlResponseWaiters,
    receiver: Option<oneshot::Receiver<Result<Value, ClaudeControlQueryError>>>,
}

impl ClaudeControlResponseRegistration {
    async fn receive(mut self) -> Result<Value, ClaudeControlQueryError> {
        let result = self
            .receiver
            .as_mut()
            .expect("Claude control response receiver")
            .await
            .unwrap_or(Err(ClaudeControlQueryError::Closed));
        self.receiver = None;
        result
    }
}

impl Drop for ClaudeControlResponseRegistration {
    fn drop(&mut self) {
        let Some(receiver) = self.receiver.as_mut() else {
            return;
        };
        let mut pending = self.pending.lock().expect("Claude control response lock");
        if matches!(
            receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ) {
            pending.remove(&self.request_id);
        }
    }
}

async fn query_claude_context_usage(
    provider: &str,
    writer: &Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    responses: &ClaudeControlResponseRouter,
    cancellation: &CancellationToken,
    sequence: u64,
    timeout: Duration,
) -> Option<Value> {
    query_claude_control(
        provider,
        writer,
        responses,
        cancellation,
        ClaudeControlRequest::get_context_usage(sequence),
        timeout,
    )
    .await
}

async fn query_claude_mcp_status(
    provider: &str,
    writer: &Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    responses: &ClaudeControlResponseRouter,
    cancellation: &CancellationToken,
    sequence: u64,
    timeout: Duration,
) -> Option<Value> {
    query_claude_control(
        provider,
        writer,
        responses,
        cancellation,
        ClaudeControlRequest::mcp_status(sequence),
        timeout,
    )
    .await
}

async fn query_claude_control(
    provider: &str,
    writer: &Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    responses: &ClaudeControlResponseRouter,
    cancellation: &CancellationToken,
    request: ClaudeControlRequest,
    timeout: Duration,
) -> Option<Value> {
    let query = async {
        let registration = responses.register(request.request_id().to_owned())?;
        let mut bytes = serde_json::to_vec(&request)
            .map_err(provider_error(provider))
            .ok()?;
        bytes.push(b'\n');
        {
            let mut writer = writer.lock().await;
            writer
                .write_all(&bytes)
                .await
                .map_err(provider_error(provider))
                .ok()?;
            writer
                .flush()
                .await
                .map_err(provider_error(provider))
                .ok()?;
        }
        registration.receive().await.ok()
    };

    tokio::select! {
        biased;
        () = cancellation.cancelled() => None,
        result = tokio::time::timeout(timeout, query) => result.ok().flatten(),
    }
}

fn claude_completion_query_turn_id(event: &ProviderEvent) -> Option<&str> {
    if event.event_type == "turn.completed"
        && event.payload.get("state").and_then(Value::as_str) == Some("completed")
    {
        event.turn_id.as_deref()
    } else {
        None
    }
}

#[cfg(test)]
mod claude_control_response_tests {
    use super::{ClaudeControlQueryError, ClaudeControlResponseRouter};
    use serde_json::json;

    #[tokio::test]
    async fn routes_only_the_matching_response_to_its_waiter() {
        let router = ClaudeControlResponseRouter::default();
        let registration = router
            .register("bibcode-20".to_owned())
            .expect("registration");

        assert!(router.route(&json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "other", "response": {} }
        })));
        assert_eq!(router.pending_count(), 1);
        assert!(router.route(&json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "bibcode-20",
                "response": {
                    "totalTokens": 31251,
                    "maxTokens": 200000,
                    "isAutoCompactEnabled": true
                }
            }
        })));

        assert_eq!(
            registration.receive().await.expect("response")["totalTokens"],
            31_251
        );
        assert_eq!(router.pending_count(), 0);
    }

    #[tokio::test]
    async fn error_response_settles_the_matching_waiter_as_remote() {
        let router = ClaudeControlResponseRouter::default();
        let registration = router
            .register("bibcode-21".to_owned())
            .expect("registration");

        assert!(router.route(&json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": "bibcode-21",
                "error": "get_context_usage is unsupported"
            }
        })));

        assert_eq!(
            registration.receive().await,
            Err(ClaudeControlQueryError::Remote)
        );
        assert_eq!(router.pending_count(), 0);
    }

    #[test]
    fn dropping_a_timed_out_registration_removes_only_its_waiter() {
        let router = ClaudeControlResponseRouter::default();
        let registration = router
            .register("bibcode-22".to_owned())
            .expect("registration");
        assert!(router.register("bibcode-22".to_owned()).is_none());
        assert_eq!(router.pending_count(), 1);

        drop(registration);

        assert_eq!(router.pending_count(), 0);
        assert!(router.register("bibcode-22".to_owned()).is_some());
    }

    #[tokio::test]
    async fn close_settles_and_removes_all_pending_waiters() {
        let router = ClaudeControlResponseRouter::default();
        let first = router
            .register("bibcode-23".to_owned())
            .expect("first registration");
        let second = router
            .register("bibcode-24".to_owned())
            .expect("second registration");
        assert_eq!(router.pending_count(), 2);

        router.close();

        assert_eq!(router.pending_count(), 0);
        assert_eq!(first.receive().await, Err(ClaudeControlQueryError::Closed));
        assert_eq!(second.receive().await, Err(ClaudeControlQueryError::Closed));
        assert!(router.register("bibcode-25".to_owned()).is_none());
    }
}

#[cfg(test)]
mod claude_context_query_tests {
    use super::{
        ClaudeControlResponseRouter, ProviderEvent, claude_completion_query_turn_id,
        claude_provider_event, query_claude_context_usage, query_claude_mcp_status,
    };
    use crate::provider::claude::{ClaudeProviderRuntime, TurnInput};
    use serde_json::{Value, json};
    use std::{sync::Arc, time::Duration};
    use tokio::{
        io::{AsyncBufReadExt, AsyncWrite, BufReader},
        sync::Mutex,
        time::timeout,
    };
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn writes_correlated_query_and_returns_matching_success_body() {
        let (writer_stream, reader_stream) = tokio::io::duplex(1_024);
        let writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>> = Mutex::new(Box::new(writer_stream));
        let responses = ClaudeControlResponseRouter::default();
        let cancellation = CancellationToken::new();
        let responder = async {
            let mut lines = BufReader::new(reader_stream).lines();
            let line = lines
                .next_line()
                .await
                .expect("query read")
                .expect("query line");
            assert_eq!(
                serde_json::from_str::<Value>(&line).expect("query json"),
                json!({
                    "type": "control_request",
                    "request_id": "bibcode-20",
                    "request": { "subtype": "get_context_usage" }
                })
            );
            assert!(responses.route(&json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": "bibcode-20",
                    "response": {
                        "totalTokens": 31251,
                        "maxTokens": 200000,
                        "isAutoCompactEnabled": true
                    }
                }
            })));
        };

        let (response, ()) = tokio::join!(
            query_claude_context_usage(
                "claude",
                &writer,
                &responses,
                &cancellation,
                20,
                Duration::from_secs(1),
            ),
            responder,
        );

        assert_eq!(response.expect("context response")["totalTokens"], 31_251);
        assert_eq!(responses.pending_count(), 0);
    }

    #[tokio::test]
    async fn writes_correlated_mcp_status_query_and_returns_matching_success_body() {
        let (writer_stream, reader_stream) = tokio::io::duplex(1_024);
        let writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>> = Mutex::new(Box::new(writer_stream));
        let responses = ClaudeControlResponseRouter::default();
        let cancellation = CancellationToken::new();
        let responder = async {
            let mut lines = BufReader::new(reader_stream).lines();
            let line = lines
                .next_line()
                .await
                .expect("query read")
                .expect("query line");
            assert_eq!(
                serde_json::from_str::<Value>(&line).expect("query json"),
                json!({
                    "type": "control_request",
                    "request_id": "bibcode-21",
                    "request": { "subtype": "mcp_status" }
                })
            );
            assert!(responses.route(&json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": "bibcode-21",
                    "response": {
                        "mcpServers": [{ "name": "context7", "status": "connected" }]
                    }
                }
            })));
        };

        let (response, ()) = tokio::join!(
            query_claude_mcp_status(
                "claude",
                &writer,
                &responses,
                &cancellation,
                21,
                Duration::from_secs(1),
            ),
            responder,
        );

        assert_eq!(
            response.expect("MCP response")["mcpServers"][0]["name"],
            "context7"
        );
        assert_eq!(responses.pending_count(), 0);
    }

    #[tokio::test]
    async fn late_context_response_cannot_mutate_a_new_turns_usage_state() {
        let (writer_stream, reader_stream) = tokio::io::duplex(1_024);
        let writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>> = Mutex::new(Box::new(writer_stream));
        let responses = ClaudeControlResponseRouter::default();
        let cancellation = CancellationToken::new();
        let runtime = Arc::new(Mutex::new(ClaudeProviderRuntime::new(
            "thread-1".to_owned(),
            "session-1".to_owned(),
        )));
        runtime.lock().await.start_turn(TurnInput {
            turn_id: "turn-1".to_owned(),
            input: "first turn".to_owned(),
        });

        let responder = async {
            let mut lines = BufReader::new(reader_stream).lines();
            lines
                .next_line()
                .await
                .expect("query read")
                .expect("query line");
            runtime.lock().await.start_turn(TurnInput {
                turn_id: "turn-2".to_owned(),
                input: "second turn".to_owned(),
            });
            assert!(responses.route(&json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": "bibcode-24",
                    "response": {
                        "totalTokens": 31251,
                        "maxTokens": 200000,
                        "isAutoCompactEnabled": true
                    }
                }
            })));
        };

        let (response, ()) = tokio::join!(
            query_claude_context_usage(
                "claude",
                &writer,
                &responses,
                &cancellation,
                24,
                Duration::from_secs(1),
            ),
            responder,
        );

        let mut runtime = runtime.lock().await;
        assert!(
            runtime
                .apply_context_usage_response("turn-1", &response.expect("late context response"))
                .is_none()
        );
        let current_turn = runtime.handle_raw_value(
            &json!({
                "type": "system",
                "subtype": "compact_boundary",
                "compact_metadata": { "pre_tokens": 31251, "post_tokens": 31251 }
            }),
            2_000,
        );
        assert_eq!(current_turn.events.len(), 1);
        assert_eq!(current_turn.events[0].turn_id.as_deref(), Some("turn-2"));
        assert_eq!(
            current_turn.events[0].event_type,
            "thread.token-usage.updated"
        );
    }

    #[tokio::test]
    async fn timeout_returns_none_and_removes_the_pending_waiter() {
        let (writer_stream, _reader_stream) = tokio::io::duplex(1_024);
        let writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>> = Mutex::new(Box::new(writer_stream));
        let responses = ClaudeControlResponseRouter::default();
        let cancellation = CancellationToken::new();

        let response = query_claude_context_usage(
            "claude",
            &writer,
            &responses,
            &cancellation,
            21,
            Duration::from_millis(10),
        )
        .await;

        assert!(response.is_none());
        assert_eq!(responses.pending_count(), 0);
    }

    #[tokio::test]
    async fn cancellation_returns_none_without_writing_or_retaining_a_waiter() {
        let (writer_stream, reader_stream) = tokio::io::duplex(1_024);
        let writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>> = Mutex::new(Box::new(writer_stream));
        let responses = ClaudeControlResponseRouter::default();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert!(
            query_claude_context_usage(
                "claude",
                &writer,
                &responses,
                &cancellation,
                22,
                Duration::from_secs(1),
            )
            .await
            .is_none()
        );
        assert_eq!(responses.pending_count(), 0);
        let mut lines = BufReader::new(reader_stream).lines();
        assert!(
            timeout(Duration::from_millis(10), lines.next_line())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn writer_failure_returns_none_and_removes_the_pending_waiter() {
        let (writer_stream, reader_stream) = tokio::io::duplex(1_024);
        drop(reader_stream);
        let writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>> = Mutex::new(Box::new(writer_stream));
        let responses = ClaudeControlResponseRouter::default();
        let cancellation = CancellationToken::new();

        assert!(
            query_claude_context_usage(
                "claude",
                &writer,
                &responses,
                &cancellation,
                23,
                Duration::from_secs(1),
            )
            .await
            .is_none()
        );
        assert_eq!(responses.pending_count(), 0);
    }

    #[test]
    fn only_successful_completion_enters_the_context_query_path() {
        fn completion(state: &str) -> ProviderEvent {
            ProviderEvent {
                native_event_id: None,
                event_type: "turn.completed".to_owned(),
                thread_id: "thread-1".to_owned(),
                turn_id: Some("turn-1".to_owned()),
                request_id: None,
                payload: json!({ "state": state }),
                activity: Vec::new(),
            }
        }

        assert_eq!(
            claude_completion_query_turn_id(&completion("completed")),
            Some("turn-1")
        );
        assert_eq!(claude_completion_query_turn_id(&completion("failed")), None);
        assert_eq!(
            claude_completion_query_turn_id(&completion("interrupted")),
            None
        );
        let mut non_completion = completion("completed");
        non_completion.event_type = "item.completed".to_owned();
        assert_eq!(claude_completion_query_turn_id(&non_completion), None);
    }

    #[test]
    fn actual_claude_error_result_is_non_success_before_query_policy() {
        let mut runtime = ClaudeProviderRuntime::new("thread-1".to_owned(), "session-1".to_owned());
        runtime.start_turn(TurnInput {
            turn_id: "turn-1".to_owned(),
            input: "exhaust the turn limit".to_owned(),
        });

        let output = runtime.handle_raw_value(
            &json!({
                "type": "result",
                "subtype": "error_max_turns",
                "is_error": true,
                "errors": ["Reached the maximum number of turns."],
                "stop_reason": null,
                "session_id": "session-1",
                "uuid": "result-error-1"
            }),
            1_000,
        );
        let completion = claude_provider_event(
            output.events.into_iter().next().expect("completion event"),
            None,
            Vec::new(),
        );

        assert_eq!(completion.event_type, "turn.completed");
        assert_eq!(completion.payload["state"], "failed");
        assert_eq!(completion.payload["stopReason"], "error");
        assert_eq!(
            completion.payload["errorMessage"],
            "Reached the maximum number of turns."
        );
        assert_eq!(claude_completion_query_turn_id(&completion), None);
    }
}

struct ClaudeDriver {
    provider: String,
    runtime: Arc<Mutex<ClaudeProviderRuntime>>,
    writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    events: Mutex<mpsc::Receiver<ProviderEvent>>,
    deferred_events: Mutex<VecDeque<ProviderEvent>>,
    control_responses: ClaudeControlResponseRouter,
    child: SharedChild,
    session_id: String,
    runtime_mode: Mutex<ClaudeRuntimeMode>,
    configured_runtime_mode: Mutex<String>,
    interaction_mode: Mutex<String>,
    options: Vec<Value>,
    supports_fast_mode: bool,
    sequence: Mutex<u64>,
    attachments: AttachmentMaterializer,
    pending_acknowledgement: ClaudeAcknowledgementSlot,
    hook_sink: Option<Arc<ClaudeHookSinkHandle>>,
    output: Arc<ClaudeOutputHandle>,
}

struct ClaudeOutputHandle {
    cancellation: CancellationToken,
    coordinator: Mutex<Option<JoinHandle<()>>>,
}

impl ClaudeOutputHandle {
    async fn shutdown(&self) {
        self.cancellation.cancel();
        if let Some(coordinator) = self.coordinator.lock().await.take() {
            let _ = coordinator.await;
        }
    }
}

const CLAUDE_ACTIVITY_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const CLAUDE_CONTEXT_QUERY_TIMEOUT: Duration = Duration::from_secs(2);
const CLAUDE_ACTIVITY_PROBE_OUTPUT_LIMIT: usize = 64 * 1024;
const CLAUDE_ACTIVITY_PROBE_CACHE_CAPACITY: usize = 64;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ClaudeActivitySupport {
    pub include_hook_events: bool,
    pub forward_subagent_text: bool,
    pub transcript_recovery: bool,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ClaudeProbeCacheKey {
    executable: PathBuf,
    modified: Option<SystemTime>,
    length: u64,
    file_identity: Option<(u64, u64)>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ClaudeVersionedProbeKey {
    executable: ClaudeProbeCacheKey,
    version: String,
}

#[derive(Clone, Debug)]
struct ClaudeCachedProbe {
    version: String,
    support: ClaudeActivitySupport,
}

#[derive(Clone, Debug)]
enum ClaudeProbeOutcome {
    Supported(ClaudeCachedProbe),
    Failed,
}

#[derive(Clone, Debug)]
struct ClaudeReadyProbe {
    probe: ClaudeCachedProbe,
    last_used: u64,
}

#[derive(Clone, Debug)]
struct ClaudeInFlightProbe {
    id: u64,
    receiver: tokio::sync::watch::Receiver<Option<ClaudeProbeOutcome>>,
}

#[derive(Debug, Default)]
struct ClaudeProbeCacheState {
    ready: HashMap<ClaudeVersionedProbeKey, ClaudeReadyProbe>,
    ready_versions: HashMap<ClaudeProbeCacheKey, String>,
    in_flight: HashMap<ClaudeProbeCacheKey, ClaudeInFlightProbe>,
    next_id: u64,
    tick: u64,
}

#[derive(Debug, Default)]
struct ClaudeProbeResult {
    version: String,
    support: ClaudeActivitySupport,
}

static CLAUDE_ACTIVITY_PROBE_CACHE: OnceLock<StdMutex<ClaudeProbeCacheState>> = OnceLock::new();

fn claude_probe_cache() -> &'static StdMutex<ClaudeProbeCacheState> {
    CLAUDE_ACTIVITY_PROBE_CACHE.get_or_init(|| StdMutex::new(ClaudeProbeCacheState::default()))
}

async fn probe_claude_activity_support(binary_path: &str) -> ClaudeActivitySupport {
    probe_claude_activity_support_with_environment(binary_path, std::iter::empty(), Duration::ZERO)
        .await
}

async fn probe_claude_activity_support_with_resolution_delay(
    binary_path: &str,
    resolution_delay: Duration,
) -> ClaudeActivitySupport {
    probe_claude_activity_support_with_environment(
        binary_path,
        std::iter::empty(),
        resolution_delay,
    )
    .await
}

async fn probe_claude_activity_support_with_environment<'a>(
    binary_path: &str,
    environment: impl IntoIterator<Item = (&'a OsStr, &'a OsStr)>,
    resolution_delay: Duration,
) -> ClaudeActivitySupport {
    let binary_path = binary_path.to_owned();
    let search_path = effective_provider_search_path(environment);
    tokio::spawn(async move {
        let deadline = Instant::now() + CLAUDE_ACTIVITY_PROBE_TIMEOUT;
        let resolution = tokio::time::timeout_at(
            deadline,
            tokio::task::spawn_blocking(move || {
                if !resolution_delay.is_zero() {
                    std::thread::sleep(resolution_delay);
                }
                let resolved =
                    resolve_provider_executable_in_path(&binary_path, search_path.as_deref())?;
                let executable = std::fs::canonicalize(&resolved).unwrap_or(resolved);
                let metadata = std::fs::metadata(&executable).ok()?;
                #[cfg(unix)]
                let file_identity = {
                    use std::os::unix::fs::MetadataExt;
                    Some((metadata.dev(), metadata.ino()))
                };
                #[cfg(not(unix))]
                let file_identity = None;
                Some((
                    ClaudeProbeCacheKey {
                        executable: executable.clone(),
                        modified: metadata.modified().ok(),
                        length: metadata.len(),
                        file_identity,
                    },
                    executable,
                ))
            }),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
        let Some((key, executable)) = resolution else {
            return ClaudeActivitySupport::default();
        };
        probe_resolved_claude_activity_support(key, executable, deadline).await
    })
    .await
    .unwrap_or_default()
}

async fn probe_resolved_claude_activity_support(
    key: ClaudeProbeCacheKey,
    executable: PathBuf,
    deadline: Instant,
) -> ClaudeActivitySupport {
    let mut receiver = {
        let mut cache = claude_probe_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.tick = cache.tick.saturating_add(1);
        let tick = cache.tick;
        if let Some(version) = cache.ready_versions.get(&key).cloned() {
            let versioned_key = ClaudeVersionedProbeKey {
                executable: key.clone(),
                version,
            };
            if let Some(ready) = cache.ready.get_mut(&versioned_key) {
                ready.last_used = tick;
                return ready.probe.support;
            }
            cache.ready_versions.remove(&key);
        }
        if let Some(in_flight) = cache.in_flight.get(&key) {
            in_flight.receiver.clone()
        } else {
            if cache.in_flight.len() >= CLAUDE_ACTIVITY_PROBE_CACHE_CAPACITY {
                return ClaudeActivitySupport::default();
            }
            cache.next_id = cache.next_id.saturating_add(1);
            let id = cache.next_id;
            let (sender, receiver) = tokio::sync::watch::channel(None);
            cache.in_flight.insert(
                key.clone(),
                ClaudeInFlightProbe {
                    id,
                    receiver: receiver.clone(),
                },
            );
            tokio::spawn(async move {
                let result = probe_claude_activity_support_uncached(&executable, deadline)
                    .await
                    .filter(|result| !result.version.is_empty())
                    .map(|result| ClaudeCachedProbe {
                        version: result.version,
                        support: result.support,
                    });
                let outcome = result
                    .clone()
                    .map_or(ClaudeProbeOutcome::Failed, ClaudeProbeOutcome::Supported);
                finish_claude_probe(key, id, result);
                sender.send_replace(Some(outcome));
            });
            receiver
        }
    };

    loop {
        match receiver.borrow().clone() {
            Some(ClaudeProbeOutcome::Supported(probe)) => {
                let _version = probe.version;
                return probe.support;
            }
            Some(ClaudeProbeOutcome::Failed) => return ClaudeActivitySupport::default(),
            None => {}
        }
        if !matches!(
            tokio::time::timeout_at(deadline, receiver.changed()).await,
            Ok(Ok(()))
        ) {
            return ClaudeActivitySupport::default();
        }
    }
}

fn finish_claude_probe(key: ClaudeProbeCacheKey, id: u64, result: Option<ClaudeCachedProbe>) {
    let mut cache = claude_probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !matches!(
        cache.in_flight.get(&key),
        Some(ClaudeInFlightProbe { id: current_id, .. }) if *current_id == id
    ) {
        return;
    }
    cache.in_flight.remove(&key);
    let Some(probe) = result else {
        return;
    };
    insert_claude_ready_probe(&mut cache, key, probe);
}

fn insert_claude_ready_probe(
    cache: &mut ClaudeProbeCacheState,
    key: ClaudeProbeCacheKey,
    probe: ClaudeCachedProbe,
) {
    cache.tick = cache.tick.saturating_add(1);
    let last_used = cache.tick;
    let versioned_key = ClaudeVersionedProbeKey {
        executable: key.clone(),
        version: probe.version.clone(),
    };
    cache.ready_versions.insert(key, probe.version.clone());
    cache
        .ready
        .insert(versioned_key, ClaudeReadyProbe { probe, last_used });
    while cache.ready.len() > CLAUDE_ACTIVITY_PROBE_CACHE_CAPACITY {
        let oldest = cache
            .ready
            .iter()
            .map(|(key, entry)| (key.clone(), entry.last_used))
            .min_by_key(|(_, last_used)| *last_used)
            .map(|(key, _)| key);
        let Some(oldest) = oldest else {
            break;
        };
        cache.ready.remove(&oldest);
        if cache
            .ready_versions
            .get(&oldest.executable)
            .is_some_and(|version| version == &oldest.version)
        {
            cache.ready_versions.remove(&oldest.executable);
        }
    }
}

async fn probe_claude_activity_support_uncached(
    executable: &Path,
    deadline: Instant,
) -> Option<ClaudeProbeResult> {
    let version = run_claude_probe_command(executable, "--version", deadline).await?;
    let Some(help) = run_claude_probe_command(executable, "--help", deadline).await else {
        return Some(ClaudeProbeResult {
            version,
            ..ClaudeProbeResult::default()
        });
    };
    let has_exact_flag =
        |expected: &str| help.split_ascii_whitespace().any(|token| token == expected);
    Some(ClaudeProbeResult {
        version,
        support: ClaudeActivitySupport {
            include_hook_events: has_exact_flag("--include-hook-events"),
            forward_subagent_text: has_exact_flag("--forward-subagent-text"),
            transcript_recovery: false,
        },
    })
}

async fn run_claude_probe_command(
    executable: &Path,
    argument: &str,
    deadline: Instant,
) -> Option<String> {
    const CLEANUP_RESERVE: Duration = Duration::from_millis(400);
    let launch = prepare_provider_launch(executable, [argument]).ok()?;
    let mut command = tokio::process::Command::new(launch.program);
    command
        .args(launch.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_provider_subprocess_environment(&mut command);
    let cancellation = CancellationToken::new();
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining <= CLEANUP_RESERVE {
        return None;
    }
    let operation_timeout = remaining.saturating_sub(CLEANUP_RESERVE);
    let request = SupervisedRunRequest {
        command,
        stdin: None,
        timeout: operation_timeout,
        cleanup_timeout: CLEANUP_RESERVE,
        max_output_bytes: CLAUDE_ACTIVITY_PROBE_OUTPUT_LIMIT,
        overflow: SupervisedOverflow::Truncate,
    };
    // The cache producer is detached from the deadline-bounded caller. Let the
    // supervised runner finish its reserved terminate-and-reap phase instead
    // of dropping that cleanup future at the caller's hard deadline.
    let output = run_supervised(request, &cancellation).await.ok()?;
    if !output.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&output.stdout.bytes).into_owned();
    if !output.stderr.bytes.is_empty() {
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&output.stderr.bytes));
    }
    let text = text.trim().to_owned();
    (!text.is_empty()).then_some(text)
}

fn build_claude_launch_arguments(
    request: &ProviderLaunchRequest,
    session_id: &str,
    support: ClaudeActivitySupport,
    hook_settings: Option<&Value>,
) -> Vec<String> {
    let mode = claude_mode(&request.runtime_mode, &request.interaction_mode);
    let mut args = vec![
        "--print".to_owned(),
        "--input-format".to_owned(),
        "stream-json".to_owned(),
        "--output-format".to_owned(),
        "stream-json".to_owned(),
        "--replay-user-messages".to_owned(),
        "--include-partial-messages".to_owned(),
    ];
    if support.include_hook_events {
        args.push("--include-hook-events".to_owned());
    }
    if support.forward_subagent_text {
        args.push("--forward-subagent-text".to_owned());
    }
    args.extend([
        "--verbose".to_owned(),
        "--setting-sources=user,project,local".to_owned(),
        "--permission-mode".to_owned(),
        claude_permission_arg(mode).to_owned(),
    ]);
    if request.resume_cursor.is_some() {
        args.extend(["--resume".to_owned(), session_id.to_owned()]);
    } else {
        args.extend(["--session-id".to_owned(), session_id.to_owned()]);
    }
    if let Some(model) = request.model.as_ref() {
        args.extend(["--model".to_owned(), model.clone()]);
    }
    if let Some(effort) = request.effort.as_ref() {
        args.extend(["--effort".to_owned(), effort.clone()]);
    }
    if let Some(agent) = request.agent.as_ref() {
        args.extend(["--agent".to_owned(), agent.clone()]);
    }
    if let Some(settings) = claude_session_settings(request, hook_settings) {
        args.extend(["--settings".to_owned(), settings.to_string()]);
    }
    if let Some(mcp) = request.mcp.as_ref() {
        let config = json!({
            "mcpServers": {
                "bibcode": {
                    "type": "http",
                    "url": mcp.endpoint,
                    "headers": { "Authorization": mcp.authorization_header },
                }
            }
        });
        args.extend(["--mcp-config".to_owned(), config.to_string()]);
    }
    args
}

fn claude_session_settings(
    request: &ProviderLaunchRequest,
    hook_settings: Option<&Value>,
) -> Option<Value> {
    let mut settings = hook_settings
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(fast_mode) = selection_boolean_option(&request.options, "fastMode") {
        settings.insert("fastMode".to_owned(), Value::Bool(fast_mode));
    }
    (!settings.is_empty()).then_some(Value::Object(settings))
}

fn selection_boolean_option(options: &[Value], id: &str) -> Option<bool> {
    options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|option| option.get("value"))
        .and_then(Value::as_bool)
}

fn claude_supports_fast_mode(model: Option<&str>) -> bool {
    let Some(model) = model else {
        return false;
    };
    crate::provider::claude::model::all_models(&[])
        .into_iter()
        .find(|candidate| candidate.get("slug").and_then(Value::as_str) == Some(model))
        .is_some_and(|candidate| {
            candidate["capabilities"]["optionDescriptors"]
                .as_array()
                .is_some_and(|descriptors| {
                    descriptors.iter().any(|descriptor| {
                        descriptor.get("id").and_then(Value::as_str) == Some("fastMode")
                            && descriptor.get("type").and_then(Value::as_str) == Some("boolean")
                    })
                })
        })
}

fn validate_claude_options(
    provider: &str,
    options: &[Value],
    supports_fast_mode: bool,
) -> Result<(), ProviderRuntimeError> {
    let mut seen = HashSet::new();
    for option in options {
        let Some(id) = option.get("id").and_then(Value::as_str) else {
            return Err(unsupported_option(provider, "unknown"));
        };
        if !seen.insert(id) || id != "fastMode" || !supports_fast_mode {
            return Err(unsupported_option(provider, id));
        }
        if option.get("value").and_then(Value::as_bool).is_none() {
            return Err(ProviderRuntimeError::Provider {
                provider: provider.to_owned(),
                detail: "option fastMode requires a boolean value".to_owned(),
            });
        }
    }
    Ok(())
}

#[doc(hidden)]
pub fn build_claude_launch_arguments_for_test(
    request: &ProviderLaunchRequest,
    session_id: &str,
    support: ClaudeActivitySupport,
) -> Vec<String> {
    build_claude_launch_arguments(request, session_id, support, None)
}

#[doc(hidden)]
pub fn build_claude_launch_arguments_with_settings_for_test(
    request: &ProviderLaunchRequest,
    session_id: &str,
    support: ClaudeActivitySupport,
    hook_settings: Option<Value>,
) -> Vec<String> {
    build_claude_launch_arguments(request, session_id, support, hook_settings.as_ref())
}

#[doc(hidden)]
pub async fn probe_claude_activity_support_for_test(binary_path: &str) -> ClaudeActivitySupport {
    probe_claude_activity_support(binary_path).await
}

#[doc(hidden)]
pub async fn probe_claude_activity_support_with_resolution_delay_for_test(
    binary_path: &str,
    resolution_delay: Duration,
) -> ClaudeActivitySupport {
    probe_claude_activity_support_with_resolution_delay(binary_path, resolution_delay).await
}

#[doc(hidden)]
pub async fn reset_claude_activity_probe_cache_for_test() {
    let mut cache = claude_probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cache = ClaudeProbeCacheState::default();
}

#[doc(hidden)]
pub async fn claude_activity_probe_cache_len_for_test() -> usize {
    claude_probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .ready
        .len()
}

#[doc(hidden)]
pub async fn seed_claude_activity_probe_cache_for_test(count: usize) {
    let mut cache = claude_probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for index in 0..count {
        let executable = PathBuf::from(format!("/bibcode-test/claude-cache-{index}"));
        let key = ClaudeProbeCacheKey {
            executable,
            modified: None,
            length: u64::try_from(index).unwrap_or(u64::MAX),
            file_identity: None,
        };
        insert_claude_ready_probe(
            &mut cache,
            key,
            ClaudeCachedProbe {
                version: format!("test-{index}"),
                support: ClaudeActivitySupport::default(),
            },
        );
    }
}

#[doc(hidden)]
pub async fn claude_activity_probe_cache_paths_for_test() -> Vec<String> {
    let cache = claude_probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut paths = cache
        .ready
        .keys()
        .map(|key| key.executable.executable.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

impl ClaudeDriver {
    async fn spawn(
        mut request: ProviderLaunchRequest,
        attachments: AttachmentMaterializer,
        attribution: ProcessAttributionRegistry,
        activity_enabled: bool,
    ) -> Result<Self, ProviderRuntimeError> {
        let supports_fast_mode = claude_supports_fast_mode(request.model.as_deref());
        validate_claude_options(&request.provider, &request.options, supports_fast_mode)?;
        let mode = claude_mode(&request.runtime_mode, &request.interaction_mode);
        let session_id = request
            .resume_cursor
            .as_ref()
            .and_then(resume_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        request
            .environment
            .entry("CLAUDE_CODE_ENTRYPOINT".to_owned())
            .or_insert_with(|| "sdk-rust".to_owned());
        let support = probe_claude_activity_support_with_environment(
            &request.binary_path,
            request
                .environment
                .iter()
                .map(|(name, value)| (OsStr::new(name), OsStr::new(value))),
            Duration::ZERO,
        )
        .await;
        let hook_sink = if support.include_hook_events && support.forward_subagent_text {
            start_claude_hook_sink().await.ok()
        } else {
            None
        };
        let hook_settings = hook_sink
            .as_ref()
            .map(|sink| claude_hook_settings(&sink.endpoint));
        if let Some(sink) = hook_sink.as_ref() {
            request
                .environment
                .insert(CLAUDE_HOOK_TOKEN_ENV.to_owned(), sink.token.clone());
        }
        let args =
            build_claude_launch_arguments(&request, &session_id, support, hook_settings.as_ref());
        let mut child = spawn_child(&request, &args, true, attribution)?;
        let stdout = child
            .stdout()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdout"))?;
        let stdin = child
            .stdin()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stdin"))?;
        let stderr = child
            .stderr()
            .take()
            .ok_or_else(|| pipe_error(&request.provider, "stderr"))?;
        let runtime = Arc::new(Mutex::new(
            ClaudeProviderRuntime::new_with_agent_activity_enabled(
                request.thread_id.clone(),
                session_id.clone(),
                activity_enabled,
            ),
        ));
        let (events_tx, events_rx) = mpsc::channel(DEFAULT_EVENT_QUEUE_CAPACITY);
        let (hook_receiver, hook_handle) = match hook_sink {
            Some(sink) => (Some(sink.receiver), Some(Arc::new(sink.handle))),
            None => (None, None),
        };
        let pending_acknowledgement = ClaudeAcknowledgementSlot::default();
        let control_responses = ClaudeControlResponseRouter::default();
        let output = spawn_claude_output(
            runtime.clone(),
            request.thread_id.clone(),
            stdout,
            stderr,
            hook_receiver,
            hook_handle.clone(),
            events_tx,
            pending_acknowledgement.clone(),
            control_responses.clone(),
        );
        Ok(Self {
            provider: request.provider,
            runtime,
            writer: Mutex::new(Box::new(stdin)),
            events: Mutex::new(events_rx),
            deferred_events: Mutex::new(VecDeque::new()),
            control_responses,
            child: Arc::new(Mutex::new(child)),
            session_id,
            runtime_mode: Mutex::new(mode),
            configured_runtime_mode: Mutex::new(request.runtime_mode),
            interaction_mode: Mutex::new(request.interaction_mode),
            options: request.options,
            supports_fast_mode,
            sequence: Mutex::new(0),
            attachments,
            pending_acknowledgement,
            hook_sink: hook_handle,
            output,
        })
    }

    fn encode_json_line(&self, value: Value) -> Result<Vec<u8>, ProviderRuntimeError> {
        let mut bytes = serde_json::to_vec(&value).map_err(provider_error(&self.provider))?;
        bytes.push(b'\n');
        Ok(bytes)
    }

    async fn write_bytes(&self, bytes: &[u8]) -> Result<(), ProviderRuntimeError> {
        let mut writer = self.writer.lock().await;
        writer
            .write_all(bytes)
            .await
            .map_err(provider_error(&self.provider))?;
        writer.flush().await.map_err(provider_error(&self.provider))
    }

    async fn write_json(&self, value: Value) -> Result<(), ProviderRuntimeError> {
        let bytes = self.encode_json_line(value)?;
        self.write_bytes(&bytes).await
    }

    async fn prepare_turn_input(
        &self,
        text: String,
        attachments: Vec<Value>,
    ) -> Result<(String, Vec<Value>), ProviderRuntimeError> {
        let materialized = self
            .attachments
            .materialize(attachments)
            .await
            .map_err(attachment_error("claude"))?;
        let (images, files) = split_native_images_and_file_references(materialized);
        let text = append_file_references(text, &files).map_err(attachment_error("claude"))?;
        Ok((text, images.into_iter().map(claude_image).collect()))
    }

    async fn next_sequence(&self) -> u64 {
        let mut value = self.sequence.lock().await;
        *value += 1;
        *value
    }

    async fn apply_mode(&self) -> Result<(), ProviderRuntimeError> {
        let runtime_mode = self.configured_runtime_mode.lock().await.clone();
        let interaction_mode = self.interaction_mode.lock().await.clone();
        let mode = claude_mode(&runtime_mode, &interaction_mode);
        *self.runtime_mode.lock().await = mode;
        let request = ClaudeControlRequest::set_permission_mode(
            self.next_sequence().await,
            mode.permission_mode(),
        );
        self.write_json(serde_json::to_value(request).map_err(provider_error(&self.provider))?)
            .await
    }
}

impl ProviderDriver for ClaudeDriver {
    fn start(&self) -> BoxRuntimeFuture<'_, Result<StartedSession, ProviderRuntimeError>> {
        Box::pin(async move {
            let mode = *self.runtime_mode.lock().await;
            let events = self.runtime.lock().await.start_session(mode, None);
            drop(events);
            Ok(StartedSession {
                resume_cursor: Some(json!({"sessionId":self.session_id})),
                runtime_payload: Some(json!({"transport":"stream-json"})),
                activity_capabilities: if self.hook_sink.is_some() {
                    ActivityCapabilities {
                        actors: true,
                        attributed_activity: true,
                        background_work: false,
                        history_recovery: ActivityHistoryRecovery::None,
                        terminal_observation: false,
                        targeted_actor_cancellation: false,
                    }
                } else {
                    ActivityCapabilities::none()
                },
            })
        })
    }
    fn send(
        &self,
        text: String,
        attachments: Vec<Value>,
        _: String,
    ) -> BoxRuntimeFuture<'_, Result<Option<String>, ProviderRuntimeError>> {
        Box::pin(async move {
            let turn_id = Uuid::new_v4().to_string();
            let (text, attachments) = self.prepare_turn_input(text, attachments).await?;
            let content = crate::provider::attachments::prompt_parts(Some(&text), attachments);
            self.runtime
                .lock()
                .await
                .start_turn(crate::provider::claude::TurnInput {
                    turn_id: turn_id.clone(),
                    input: text.clone(),
                });
            self.write_json(json!({"type":"user","session_id":self.session_id,"message":{"role":"user","content":content},"parent_tool_use_id":null})).await?;
            Ok(Some(turn_id))
        })
    }
    fn deliver(
        &self,
        text: String,
        attachments: Vec<Value>,
        _: String,
        _: String,
    ) -> BoxRuntimeFuture<'_, ProviderDeliveryOutcome> {
        Box::pin(async move {
            let (text, attachments) = match self.prepare_turn_input(text, attachments).await {
                Ok(input) => input,
                Err(error) => {
                    return ProviderDeliveryOutcome::Rejected {
                        detail: error.to_string(),
                    };
                }
            };
            let turn_id = Uuid::new_v4().to_string();
            let content = crate::provider::attachments::prompt_parts(Some(&text), attachments);
            let bytes = match self.encode_json_line(json!({
                "type":"user",
                "session_id":self.session_id,
                "message":{"role":"user","content":content},
                "parent_tool_use_id":null
            })) {
                Ok(bytes) => bytes,
                Err(error) => {
                    return ProviderDeliveryOutcome::Rejected {
                        detail: error.to_string(),
                    };
                }
            };
            if self.output.cancellation.is_cancelled() {
                return ProviderDeliveryOutcome::DefinitelyNotSent {
                    detail: "Claude output closed before delivery".to_owned(),
                };
            }
            let (acknowledgement_tx, acknowledgement_rx) = oneshot::channel();
            let acknowledgement_registration =
                match self.pending_acknowledgement.register(acknowledgement_tx) {
                    Some(registration) => registration,
                    None => {
                        return ProviderDeliveryOutcome::DefinitelyNotSent {
                            detail: "Claude already has a pending delivery acknowledgement"
                                .to_owned(),
                        };
                    }
                };
            if self.output.cancellation.is_cancelled() {
                return ProviderDeliveryOutcome::DefinitelyNotSent {
                    detail: "Claude output closed before delivery".to_owned(),
                };
            }
            self.runtime
                .lock()
                .await
                .start_turn(crate::provider::claude::TurnInput {
                    turn_id: turn_id.clone(),
                    input: text,
                });
            if let Err(error) = self.write_bytes(&bytes).await {
                return ProviderDeliveryOutcome::Ambiguous {
                    detail: error.to_string(),
                };
            }
            let outcome = tokio::select! {
                biased;
                result = acknowledgement_rx => match result {
                    Ok(()) => ProviderDeliveryOutcome::Accepted { turn_id: Some(turn_id) },
                    Err(_) => ProviderDeliveryOutcome::Ambiguous {
                        detail: "Claude acknowledgement waiter closed after delivery write".to_owned(),
                    },
                },
                () = self.output.cancellation.cancelled() => {
                    ProviderDeliveryOutcome::Ambiguous {
                        detail: "Claude output closed after delivery write before acknowledgement".to_owned(),
                    }
                }
            };
            drop(acknowledgement_registration);
            outcome
        })
    }
    fn interrupt(
        &self,
        _: Option<String>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let control = ClaudeControlRequest::interrupt(self.next_sequence().await);
            self.write_json(serde_json::to_value(control).map_err(provider_error(&self.provider))?)
                .await
        })
    }
    fn approve(
        &self,
        request_id: String,
        decision: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            let accepted = matches!(decision.as_str(), "accept" | "acceptForSession");
            self.runtime.lock().await.resolve_permission_request(
                &request_id,
                if accepted {
                    Decision::Accept
                } else {
                    Decision::Deny
                },
            );
            self.write_json(json!({"type":"control_response","response":{"request_id":request_id,"subtype":"success","response":{"behavior":if accepted {"allow"} else {"deny"}}}})).await
        })
    }
    fn answer(
        &self,
        request_id: String,
        answers: Value,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .lock()
                .await
                .resolve_user_input_request(&request_id, answers.clone());
            self.write_json(json!({"type":"control_response","response":{"request_id":request_id,"subtype":"success","response":answers}})).await
        })
    }
    fn set_mode(&self, mode: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            *self.configured_runtime_mode.lock().await = mode;
            self.apply_mode().await
        })
    }
    fn set_agent_activity_enabled(
        &self,
        enabled: bool,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.runtime
                .lock()
                .await
                .set_agent_activity_enabled(enabled);
            Ok(())
        })
    }
    fn set_interaction_mode(
        &self,
        mode: String,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            *self.interaction_mode.lock().await = mode;
            self.apply_mode().await
        })
    }
    fn set_model(&self, _: String) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("claude", "post-start model changes")
    }
    fn set_options(
        &self,
        options: Vec<Value>,
    ) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        if options == self.options {
            return Box::pin(async { Ok(()) });
        }
        let provider = self.provider.clone();
        let supports_fast_mode = self.supports_fast_mode;
        Box::pin(async move {
            validate_claude_options(&provider, &options, supports_fast_mode)?;
            Err(ProviderRuntimeError::UnsupportedCapability {
                provider,
                capability: "session-local options",
            })
        })
    }
    fn rollback(&self, _: i64) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        unsupported("claude", "checkpoint rollback")
    }
    fn next_event(&self) -> BoxRuntimeFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            let mut deferred_events = self.deferred_events.lock().await;
            if let Some(event) = deferred_events.pop_front() {
                return Some(event);
            }
            let completion = self.events.lock().await.recv().await?;
            let Some(turn_id) = claude_completion_query_turn_id(&completion).map(str::to_owned)
            else {
                return Some(completion);
            };
            let response = query_claude_context_usage(
                &self.provider,
                &self.writer,
                &self.control_responses,
                &self.output.cancellation,
                self.next_sequence().await,
                CLAUDE_CONTEXT_QUERY_TIMEOUT,
            );
            let mcp_status = query_claude_mcp_status(
                &self.provider,
                &self.writer,
                &self.control_responses,
                &self.output.cancellation,
                self.next_sequence().await,
                CLAUDE_CONTEXT_QUERY_TIMEOUT,
            );
            let (context_response, mcp_response) = tokio::join!(response, mcp_status);
            let mut runtime = self.runtime.lock().await;
            let mut updates = VecDeque::new();
            if let Some(response) = context_response
                && let Some(usage) = runtime.apply_context_usage_response(&turn_id, &response)
            {
                updates.push_back(claude_provider_event(usage, None, Vec::new()));
            }
            if let Some(response) = mcp_response
                && let Some(status) = runtime.apply_mcp_status_response(&response)
            {
                updates.push_back(claude_provider_event(status, None, Vec::new()));
            }
            drop(runtime);
            let Some(first) = updates.pop_front() else {
                return Some(completion);
            };
            deferred_events.extend(updates);
            deferred_events.push_back(completion);
            Some(first)
        })
    }
    fn shutdown(&self) -> BoxRuntimeFuture<'_, Result<(), ProviderRuntimeError>> {
        Box::pin(async move {
            self.control_responses.close();
            let _ = self.writer.lock().await.shutdown().await;
            kill_child(&self.child).await;
            if let Some(hook_sink) = self.hook_sink.as_ref() {
                hook_sink.shutdown().await;
            }
            self.output.shutdown().await;
            Ok(())
        })
    }
}

const MAX_CLAUDE_RECOVERY_TARGETS_PER_ROOT: usize = 50;

trait ClaudeTranscriptRecoverer: Send + Sync {
    fn recover(
        &self,
        request: ClaudeTranscriptRecoveryRequest,
        cancellation: CancellationToken,
    ) -> BoxRuntimeFuture<'static, Option<ClaudeRecoveredTranscript>>;
}

struct NativeClaudeTranscriptRecoverer;

impl ClaudeTranscriptRecoverer for NativeClaudeTranscriptRecoverer {
    fn recover(
        &self,
        request: ClaudeTranscriptRecoveryRequest,
        cancellation: CancellationToken,
    ) -> BoxRuntimeFuture<'static, Option<ClaudeRecoveredTranscript>> {
        Box::pin(recover_transcript(request, cancellation))
    }
}

fn spawn_claude_recovery_worker(
    runtime: Arc<Mutex<ClaudeProviderRuntime>>,
    thread_id: String,
    mut recovery_receiver: mpsc::Receiver<ClaudeTranscriptRecoveryRequest>,
    sender: mpsc::Sender<ProviderEvent>,
    cancellation: CancellationToken,
    recoverer: Arc<dyn ClaudeTranscriptRecoverer>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut accepted_targets = 0_usize;
        loop {
            let request = tokio::select! {
                biased;
                () = cancellation.cancelled() => return,
                request = recovery_receiver.recv() => request,
            };
            let Some(request) = request else {
                return;
            };
            if accepted_targets == MAX_CLAUDE_RECOVERY_TARGETS_PER_ROOT {
                continue;
            }
            accepted_targets += 1;
            let recovered = recoverer.recover(request, cancellation.clone()).await;
            let Some(recovered) = recovered else {
                continue;
            };
            let output = runtime.lock().await.handle_recovered_transcript(recovered);
            let native_event_id = output
                .native_event_id
                .and_then(|value| ProviderNativeEventId::new(value).ok());
            if output.activity.is_empty() {
                continue;
            }
            if !send_claude_output(
                &sender,
                &cancellation,
                ProviderEvent {
                    native_event_id,
                    event_type: ACTIVITY_ONLY_PROVIDER_EVENT_TYPE.to_owned(),
                    thread_id: thread_id.clone(),
                    turn_id: None,
                    request_id: None,
                    payload: json!({}),
                    activity: output.activity,
                },
            )
            .await
            {
                return;
            }
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_claude_output(
    runtime: Arc<Mutex<ClaudeProviderRuntime>>,
    thread_id: String,
    stdout: impl tokio::io::AsyncRead + Send + Unpin + 'static,
    stderr: impl tokio::io::AsyncRead + Send + Unpin + 'static,
    hook_receiver: Option<mpsc::Receiver<Value>>,
    hook_sink: Option<Arc<ClaudeHookSinkHandle>>,
    sender: mpsc::Sender<ProviderEvent>,
    pending_acknowledgement: ClaudeAcknowledgementSlot,
    control_responses: ClaudeControlResponseRouter,
) -> Arc<ClaudeOutputHandle> {
    let cancellation = CancellationToken::new();
    let (recovery_sender, recovery_receiver) =
        mpsc::channel::<ClaudeTranscriptRecoveryRequest>(MAX_CLAUDE_RECOVERY_TARGETS_PER_ROOT);
    let recovery_task = spawn_claude_recovery_worker(
        runtime.clone(),
        thread_id.clone(),
        recovery_receiver,
        sender.clone(),
        cancellation.clone(),
        Arc::new(NativeClaudeTranscriptRecoverer),
    );
    let stdout_sender = sender.clone();
    let stdout_thread_id = thread_id.clone();
    let stdout_runtime = runtime.clone();
    let stdout_recovery_sender = recovery_sender.clone();
    let stdout_cancellation = cancellation.clone();
    let stdout_pending_acknowledgement = pending_acknowledgement.clone();
    let stdout_control_responses = control_responses.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let line = tokio::select! {
                biased;
                () = stdout_cancellation.cancelled() => break,
                line = lines.next_line() => line,
            };
            let Ok(Some(line)) = line else {
                break;
            };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if stdout_control_responses.route(&value) {
                continue;
            }
            if !emit_claude_value(
                &stdout_runtime,
                &stdout_thread_id,
                value,
                &stdout_sender,
                false,
                &stdout_recovery_sender,
                &stdout_cancellation,
                &stdout_pending_acknowledgement,
            )
            .await
            {
                break;
            }
        }
        stdout_control_responses.close();
        stdout_cancellation.cancel();
    });
    let hook_task = hook_receiver.map(|mut hook_receiver| {
        let hook_runtime = runtime.clone();
        let hook_thread_id = thread_id.clone();
        let hook_sender = sender.clone();
        let hook_recovery_sender = recovery_sender.clone();
        let hook_cancellation = cancellation.clone();
        tokio::spawn(async move {
            loop {
                let value = tokio::select! {
                    biased;
                    () = hook_cancellation.cancelled() => return,
                    value = hook_receiver.recv() => value,
                };
                let Some(value) = value else {
                    return;
                };
                if !emit_claude_value(
                    &hook_runtime,
                    &hook_thread_id,
                    value,
                    &hook_sender,
                    true,
                    &hook_recovery_sender,
                    &hook_cancellation,
                    &pending_acknowledgement,
                )
                .await
                {
                    return;
                }
            }
        })
    });
    let stderr_cancellation = cancellation.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            let line = tokio::select! {
                biased;
                () = stderr_cancellation.cancelled() => return,
                line = lines.next_line() => line,
            };
            let Ok(Some(line)) = line else {
                return;
            };
            if !send_claude_output(
                &sender,
                &stderr_cancellation,
                ProviderEvent {
                    native_event_id: None,
                    event_type: "session.stderr".to_owned(),
                    thread_id: thread_id.clone(),
                    turn_id: None,
                    request_id: None,
                    payload: json!({"message":line}),
                    activity: Vec::new(),
                },
            )
            .await
            {
                return;
            }
        }
    });
    drop(recovery_sender);
    let coordinator = tokio::spawn(async move {
        let _ = tokio::join!(stdout_task, stderr_task);
        if let Some(hook_sink) = hook_sink {
            hook_sink.shutdown().await;
        }
        if let Some(hook_task) = hook_task {
            let _ = hook_task.await;
        }
        let _ = recovery_task.await;
    });
    Arc::new(ClaudeOutputHandle {
        cancellation,
        coordinator: Mutex::new(Some(coordinator)),
    })
}

async fn send_claude_output(
    sender: &mpsc::Sender<ProviderEvent>,
    cancellation: &CancellationToken,
    event: ProviderEvent,
) -> bool {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => false,
        result = sender.send(event) => result.is_ok(),
    }
}

#[doc(hidden)]
pub async fn claude_output_shutdown_with_open_stream_for_test() -> bool {
    let runtime = Arc::new(Mutex::new(ClaudeProviderRuntime::new(
        "fixture-thread".to_owned(),
        "fixture-session".to_owned(),
    )));
    let (stdout, stdout_writer) = tokio::io::duplex(64);
    let (stderr, stderr_writer) = tokio::io::duplex(64);
    let (sender, _receiver) = mpsc::channel(1);
    let output = spawn_claude_output(
        runtime,
        "fixture-thread".to_owned(),
        stdout,
        stderr,
        None,
        None,
        sender,
        ClaudeAcknowledgementSlot::default(),
        ClaudeControlResponseRouter::default(),
    );
    let completed = tokio::time::timeout(Duration::from_millis(150), output.shutdown())
        .await
        .is_ok();
    drop(stdout_writer);
    drop(stderr_writer);
    completed
}

#[cfg(test)]
mod claude_recovery_worker_tests {
    use super::*;
    use crate::provider::claude::{
        ClaudeTranscriptReaderFixture, transcript::ClaudeTranscriptRecoveryRequestMetadata,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::TempDir;
    use tokio::time::timeout;

    #[derive(Debug, Default)]
    struct ClaudeRecoveryWorkerJoinState {
        started: AtomicBool,
        cancelled: AtomicBool,
        released: AtomicBool,
        finished: AtomicBool,
    }

    struct BlockingClaudeTranscriptRecoverer {
        state: Arc<ClaudeRecoveryWorkerJoinState>,
    }

    struct PausedClaudeTranscriptRecoverer {
        started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Arc<tokio::sync::Notify>,
    }

    impl ClaudeTranscriptRecoverer for PausedClaudeTranscriptRecoverer {
        fn recover(
            &self,
            request: ClaudeTranscriptRecoveryRequest,
            _cancellation: CancellationToken,
        ) -> BoxRuntimeFuture<'static, Option<ClaudeRecoveredTranscript>> {
            let started = self
                .started
                .try_lock()
                .ok()
                .and_then(|mut sender| sender.take());
            let release = self.release.clone();
            Box::pin(async move {
                if let Some(started) = started {
                    let _ = started.send(());
                }
                release.notified().await;
                let metadata = ClaudeTranscriptRecoveryRequestMetadata::from(&request);
                Some(ClaudeRecoveredTranscript {
                    root_session_id: metadata.root_session_id,
                    agent_id: metadata.agent_id,
                    agent_type: metadata.agent_type,
                    records: Vec::new(),
                    native_event_id: "claude:recovery:stale-generation".to_owned(),
                    generation: metadata.generation,
                    not_before_unix_nanos: metadata.not_before_unix_nanos,
                })
            })
        }
    }

    impl ClaudeTranscriptRecoverer for BlockingClaudeTranscriptRecoverer {
        fn recover(
            &self,
            _request: ClaudeTranscriptRecoveryRequest,
            cancellation: CancellationToken,
        ) -> BoxRuntimeFuture<'static, Option<ClaudeRecoveredTranscript>> {
            let state = self.state.clone();
            Box::pin(async move {
                let _ = tokio::task::spawn_blocking(move || {
                    state.started.store(true, Ordering::Release);
                    while !cancellation.is_cancelled() {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    state.cancelled.store(true, Ordering::Release);
                    while !state.released.load(Ordering::Acquire) {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    state.finished.store(true, Ordering::Release);
                })
                .await;
                None
            })
        }
    }

    struct TestClaudeRecoveryWorkerJoinFixture {
        state: Arc<ClaudeRecoveryWorkerJoinState>,
        cancellation: CancellationToken,
        worker: Mutex<Option<JoinHandle<()>>>,
    }

    impl TestClaudeRecoveryWorkerJoinFixture {
        fn start() -> Arc<Self> {
            let state = Arc::new(ClaudeRecoveryWorkerJoinState::default());
            let cancellation = CancellationToken::new();
            let (recovery_sender, recovery_receiver) = mpsc::channel(1);
            let (event_sender, _event_receiver) = mpsc::channel(1);
            let fixture_path = if cfg!(windows) {
                r"C:\bibcode\isolated-transcript-fixture.jsonl"
            } else {
                "/bibcode/isolated-transcript-fixture.jsonl"
            };
            let request = ClaudeTranscriptRecoveryRequest::from_authenticated_hook(
                &json!({
                    "hook_event_name":"SubagentStop",
                    "session_id":"fixture-session",
                    "agent_id":"fixture-agent",
                    "agent_type":"Explore",
                    "agent_transcript_path":fixture_path,
                }),
                true,
            )
            .expect("static injected recovery fixture should be valid");
            recovery_sender
                .try_send(request)
                .expect("injected recovery request queue should be available");
            drop(recovery_sender);
            let worker = spawn_claude_recovery_worker(
                Arc::new(Mutex::new(ClaudeProviderRuntime::new(
                    "fixture-thread".to_owned(),
                    "fixture-session".to_owned(),
                ))),
                "fixture-thread".to_owned(),
                recovery_receiver,
                event_sender,
                cancellation.clone(),
                Arc::new(BlockingClaudeTranscriptRecoverer {
                    state: state.clone(),
                }),
            );
            Arc::new(Self {
                state,
                cancellation,
                worker: Mutex::new(Some(worker)),
            })
        }

        async fn wait_until_started(&self, duration: Duration) -> Result<(), &'static str> {
            wait_for_flag(&self.state.started, duration, "injected scan did not start").await
        }

        async fn wait_until_cancelled(&self, duration: Duration) -> Result<(), &'static str> {
            wait_for_flag(
                &self.state.cancelled,
                duration,
                "injected scan did not observe cancellation",
            )
            .await
        }

        async fn shutdown(&self) {
            self.cancellation.cancel();
            if let Some(worker) = self.worker.lock().await.take() {
                let _ = worker.await;
            }
        }

        fn release(&self) {
            self.state.released.store(true, Ordering::Release);
        }

        fn finished(&self) -> bool {
            self.state.finished.load(Ordering::Acquire)
        }
    }

    impl Drop for TestClaudeRecoveryWorkerJoinFixture {
        fn drop(&mut self) {
            self.cancellation.cancel();
            self.release();
        }
    }

    async fn wait_for_flag(
        flag: &AtomicBool,
        duration: Duration,
        error: &'static str,
    ) -> Result<(), &'static str> {
        tokio::time::timeout(duration, async {
            while !flag.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| error)
    }

    #[tokio::test]
    async fn cfg_test_recovery_worker_injection_joins_without_gating_production_reads() {
        let temp = TempDir::new().expect("transcript fixture directory");
        let transcript = temp.path().join("normal-production-read.jsonl");
        std::fs::write(&transcript, b"{\"record\":true}\n")
            .expect("normal transcript fixture should write");
        let recovery_worker = TestClaudeRecoveryWorkerJoinFixture::start();
        recovery_worker
            .wait_until_started(Duration::from_secs(2))
            .await
            .expect("the injected blocking scan starts");
        let normal_read = timeout(
            Duration::from_secs(2),
            ClaudeTranscriptReaderFixture::read(&transcript, false),
        )
        .await
        .expect("normal production transcript reads have no process-global fixture gate");
        assert!(normal_read.opened);

        let shutdown_worker = recovery_worker.clone();
        let mut shutdown = tokio::spawn(async move { shutdown_worker.shutdown().await });
        recovery_worker
            .wait_until_cancelled(Duration::from_secs(2))
            .await
            .expect("worker shutdown cancellation reaches the injected blocking scan");
        let early_shutdown = timeout(Duration::from_millis(150), &mut shutdown).await;
        let returned_early = early_shutdown.is_ok();
        recovery_worker.release();
        let shutdown_result = match early_shutdown {
            Ok(result) => result,
            Err(_) => timeout(Duration::from_secs(2), shutdown)
                .await
                .expect("worker shutdown completes after the blocking scan is released"),
        };
        shutdown_result.expect("worker shutdown task should succeed");
        assert!(
            recovery_worker.finished(),
            "worker shutdown must join the injected blocking scan before returning"
        );
        assert!(
            !returned_early,
            "worker shutdown must not detach an in-flight blocking scan"
        );
    }

    #[tokio::test]
    async fn stale_recovery_completion_is_suppressed_after_activity_is_reenabled() {
        let runtime = Arc::new(Mutex::new(ClaudeProviderRuntime::new(
            "fixture-thread".to_owned(),
            "fixture-session".to_owned(),
        )));
        let cancellation = CancellationToken::new();
        let (recovery_sender, recovery_receiver) = mpsc::channel(1);
        let (event_sender, mut event_receiver) = mpsc::channel(1);
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let release = Arc::new(tokio::sync::Notify::new());
        let fixture_path = if cfg!(windows) {
            r"C:\bibcode\stale-transcript-fixture.jsonl"
        } else {
            "/bibcode/stale-transcript-fixture.jsonl"
        };
        let request = ClaudeTranscriptRecoveryRequest::from_authenticated_hook(
            &json!({
                "hook_event_name":"SubagentStop",
                "session_id":"fixture-session",
                "agent_id":"fixture-agent",
                "agent_type":"Explore",
                "agent_transcript_path":fixture_path,
            }),
            true,
        )
        .expect("static recovery request");
        let worker = spawn_claude_recovery_worker(
            runtime.clone(),
            "fixture-thread".to_owned(),
            recovery_receiver,
            event_sender,
            cancellation.clone(),
            Arc::new(PausedClaudeTranscriptRecoverer {
                started: Mutex::new(Some(started_sender)),
                release: release.clone(),
            }),
        );
        recovery_sender
            .send(request)
            .await
            .expect("recovery request accepted");
        timeout(Duration::from_secs(2), started_receiver)
            .await
            .expect("recovery starts")
            .expect("start observation");

        {
            let mut runtime = runtime.lock().await;
            runtime.set_agent_activity_enabled(false);
            runtime.set_agent_activity_enabled(true);
        }
        release.notify_one();
        assert!(
            timeout(Duration::from_millis(150), event_receiver.recv())
                .await
                .is_err(),
            "the old recovery generation must not emit after re-enable"
        );

        cancellation.cancel();
        drop(recovery_sender);
        timeout(Duration::from_secs(2), worker)
            .await
            .expect("recovery worker joins")
            .expect("recovery worker succeeds");
    }
}

fn claude_provider_event(
    event: ClaudeCanonicalEvent,
    native_event_id: Option<ProviderNativeEventId>,
    activity: Vec<ProviderActivityMutation>,
) -> ProviderEvent {
    ProviderEvent {
        native_event_id,
        event_type: event.event_type,
        thread_id: event.thread_id,
        turn_id: event.turn_id,
        request_id: event.request_id,
        payload: event.payload,
        activity,
    }
}

#[allow(clippy::too_many_arguments)]
async fn emit_claude_value(
    runtime: &Arc<Mutex<ClaudeProviderRuntime>>,
    thread_id: &str,
    value: Value,
    sender: &mpsc::Sender<ProviderEvent>,
    authenticated_hook: bool,
    recovery_sender: &mpsc::Sender<ClaudeTranscriptRecoveryRequest>,
    cancellation: &CancellationToken,
    pending_acknowledgement: &ClaudeAcknowledgementSlot,
) -> bool {
    if !authenticated_hook && value.get("type").and_then(Value::as_str) == Some("user") {
        pending_acknowledgement.acknowledge();
    }
    let emitted_at_ms = u64::try_from(
        OffsetDateTime::now_utc()
            .unix_timestamp_nanos()
            .div_euclid(1_000_000),
    )
    .unwrap_or_default();
    let mut output = {
        let mut runtime = runtime.lock().await;
        if authenticated_hook {
            runtime.handle_authenticated_hook_value(&value, emitted_at_ms)
        } else {
            runtime.handle_raw_value(&value, emitted_at_ms)
        }
    };
    let recovery_request = output.recovery_request.take();
    let native_event_id = output
        .native_event_id
        .and_then(|value| ProviderNativeEventId::new(value).ok());
    if output.events.is_empty() && !output.activity.is_empty() {
        let sent = send_claude_output(
            sender,
            cancellation,
            ProviderEvent {
                native_event_id,
                event_type: ACTIVITY_ONLY_PROVIDER_EVENT_TYPE.to_owned(),
                thread_id: thread_id.to_owned(),
                turn_id: None,
                request_id: None,
                payload: json!({}),
                activity: output.activity,
            },
        )
        .await;
        if sent && let Some(request) = recovery_request {
            let _ = recovery_sender.try_send(request);
        }
        return sent;
    }
    let mut activity = Some(output.activity);
    let mut native_event_id = native_event_id;
    for event in output.events {
        if !send_claude_output(
            sender,
            cancellation,
            claude_provider_event(
                event,
                native_event_id.take(),
                activity.take().unwrap_or_default(),
            ),
        )
        .await
        {
            return false;
        }
    }
    if let Some(request) = recovery_request {
        let _ = recovery_sender.try_send(request);
    }
    true
}

fn claude_mode(runtime_mode: &str, interaction_mode: &str) -> ClaudeRuntimeMode {
    if interaction_mode == "plan" {
        return ClaudeRuntimeMode::Plan;
    }
    match runtime_mode {
        "approval-required" => ClaudeRuntimeMode::ApprovalRequired,
        "auto-accept-edits" => ClaudeRuntimeMode::AutoAcceptEdits,
        _ => ClaudeRuntimeMode::FullAccess,
    }
}

fn claude_permission_arg(mode: ClaudeRuntimeMode) -> &'static str {
    match mode {
        ClaudeRuntimeMode::FullAccess => "bypassPermissions",
        ClaudeRuntimeMode::ApprovalRequired => "default",
        ClaudeRuntimeMode::AutoAcceptEdits => "acceptEdits",
        ClaudeRuntimeMode::Plan => "plan",
    }
}

fn resume_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned).or_else(|| {
        value
            .get("threadId")
            .or_else(|| value.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

fn pipe_error(provider: &str, stream: &str) -> ProviderRuntimeError {
    ProviderRuntimeError::Spawn {
        provider: provider.to_owned(),
        detail: format!("child did not expose {stream}"),
    }
}

fn provider_error<E: std::fmt::Display>(
    provider: &str,
) -> impl FnOnce(E) -> ProviderRuntimeError + '_ {
    move |error| ProviderRuntimeError::Provider {
        provider: provider.to_owned(),
        detail: error.to_string(),
    }
}

fn attachment_error(
    provider: &str,
) -> impl FnOnce(crate::provider::attachments::AttachmentMaterializationError) -> ProviderRuntimeError + '_
{
    provider_error(provider)
}

fn codex_image(image: MaterializedAttachment) -> Value {
    json!({
        "type": "image",
        "url": format!("data:{};base64,{}", image.mime_type, image.base64_data),
    })
}

fn acp_image(image: MaterializedAttachment) -> Value {
    json!({
        "type": "image",
        "data": image.base64_data,
        "mimeType": image.mime_type,
    })
}

fn claude_image(image: MaterializedAttachment) -> Value {
    json!({
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": image.mime_type,
            "data": image.base64_data,
        },
    })
}

fn opencode_file(image: MaterializedAttachment) -> Value {
    json!({
        "type": "file",
        "mime": image.mime_type,
        "url": image.file_url,
        "filename": image.name,
    })
}

fn acp_mcp_servers(mcp: Option<&ProviderMcpConfig>) -> Vec<Value> {
    mcp.map_or_else(Vec::new, |mcp| {
        vec![json!({
            "type": "http",
            "name": "bibcode",
            "url": mcp.endpoint,
            "headers": [{
                "name": "Authorization",
                "value": mcp.authorization_header,
            }],
        })]
    })
}

#[cfg(test)]
mod attachment_adapter_tests {
    use super::*;

    fn image() -> MaterializedAttachment {
        MaterializedAttachment {
            attachment_type: "image".to_owned(),
            name: "screen.png".to_owned(),
            mime_type: "image/png".to_owned(),
            base64_data: "aW1hZ2U=".to_owned(),
            file_url: "file:///state/attachments/image-1".to_owned(),
            path: PathBuf::from("/state/attachments/image-1"),
        }
    }

    fn file() -> MaterializedAttachment {
        MaterializedAttachment {
            attachment_type: "file".to_owned(),
            name: "notes<&.txt".to_owned(),
            mime_type: "text/plain".to_owned(),
            base64_data: "bm90ZXM=".to_owned(),
            file_url: "file:///state/attachments/notes-1".to_owned(),
            path: PathBuf::from("/state/attachments/notes<&-1"),
        }
    }

    #[test]
    fn materialized_images_match_each_provider_wire_format() {
        assert_eq!(
            codex_image(image()),
            json!({ "type": "image", "url": "data:image/png;base64,aW1hZ2U=" })
        );
        assert_eq!(
            acp_image(image()),
            json!({ "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" })
        );
        assert_eq!(
            claude_image(image()),
            json!({
                "type": "image",
                "source": { "type": "base64", "media_type": "image/png", "data": "aW1hZ2U=" }
            })
        );
        assert_eq!(
            opencode_file(image()),
            json!({
                "type": "file",
                "mime": "image/png",
                "url": "file:///state/attachments/image-1",
                "filename": "screen.png"
            })
        );
    }

    #[test]
    fn images_stay_native_and_files_become_escaped_local_references() {
        let (images, files) = split_native_images_and_file_references(vec![image(), file()]);
        assert_eq!(images.len(), 1);
        assert_eq!(files.len(), 1);
        assert_eq!(
            codex_image(images[0].clone()),
            json!({ "type": "image", "url": "data:image/png;base64,aW1hZ2U=" })
        );
        assert_eq!(
            acp_image(images[0].clone()),
            json!({ "type": "image", "data": "aW1hZ2U=", "mimeType": "image/png" })
        );
        assert_eq!(
            claude_image(images[0].clone()),
            json!({
                "type": "image",
                "source": { "type": "base64", "media_type": "image/png", "data": "aW1hZ2U=" }
            })
        );
        assert_eq!(
            opencode_file(file()),
            json!({
                "type": "file",
                "mime": "text/plain",
                "url": "file:///state/attachments/notes-1",
                "filename": "notes<&.txt"
            })
        );
        assert_eq!(
            append_file_references("inspect".to_owned(), &files).expect("references append"),
            "inspect\n<attached_files>\n- notes&lt;&amp;.txt: /state/attachments/notes&lt;&amp;-1\n</attached_files>"
        );
    }
}

fn unsupported<T>(
    provider: &str,
    capability: &'static str,
) -> BoxRuntimeFuture<'static, Result<T, ProviderRuntimeError>>
where
    T: Send + 'static,
{
    let provider = provider.to_owned();
    Box::pin(async move {
        Err(ProviderRuntimeError::UnsupportedCapability {
            provider,
            capability,
        })
    })
}

fn reject_unsupported_options(
    provider: &'static str,
    options: Vec<Value>,
) -> BoxRuntimeFuture<'static, Result<(), ProviderRuntimeError>> {
    Box::pin(async move {
        let Some(option) = options.first() else {
            return Ok(());
        };
        Err(unsupported_option(
            provider,
            option
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
        ))
    })
}

async fn wait_for_endpoint(
    endpoint: &str,
    child: &SharedChild,
) -> Result<(), ProviderRuntimeError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if reqwest::get(endpoint).await.is_ok() {
            if child
                .lock()
                .await
                .try_wait()
                .map_err(provider_error("opencode"))?
                .is_some()
            {
                return Err(ProviderRuntimeError::Provider {
                    provider: "opencode".to_owned(),
                    detail: "server process exited before claiming its reserved port".to_owned(),
                });
            }
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            kill_child(child).await;
            return Err(ProviderRuntimeError::Provider {
                provider: "opencode".to_owned(),
                detail: "server did not become ready within 5 seconds".to_owned(),
            });
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{ProviderDriver, ProviderDriverFactory};
    use crate::{
        activity::{
            ActivityCancellationDispatcher, ActivityCancellationService, ActivityControlRegistry,
            ActivityDispatchError, ActivityRuntimeGeneration, ActivityScopeRef,
            ActivityTargetDispatchDisposition, ProviderActivityControlUpdate,
            ProviderActivityMutation, ProviderActivityNativeTarget,
        },
        diagnostics::{
            AttributionKind, AttributionScope, NativeProcessSampler, ProcessAttributionRegistry,
            ProcessSampler,
        },
        orchestration::engine::{EngineOptions, OrchestrationCommand, load_snapshot},
        persistence::{Database, ProviderSessionRuntime, run_migrations},
        server_settings::{
            ProviderEnvironmentVariableState, ProviderInstanceState, ProviderSettingsState,
            ProvidersState,
        },
    };
    use axum::{
        Json, Router,
        routing::{get, post},
    };
    use futures_util::future::BoxFuture;
    use serde_json::{Value, json};
    use std::{
        io,
        pin::Pin,
        sync::{Arc, Mutex as StdMutex},
        task::{Context, Poll},
        time::Instant,
    };
    use tempfile::TempDir;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, DuplexStream},
        net::TcpListener,
        sync::mpsc,
        time::timeout,
    };

    struct CurrentDirectoryGuard {
        original: std::path::PathBuf,
    }

    impl CurrentDirectoryGuard {
        fn enter(path: &std::path::Path) -> Self {
            let original = std::env::current_dir().expect("read original current directory");
            std::env::set_current_dir(path).expect("enter fixture current directory");
            Self { original }
        }
    }

    impl Drop for CurrentDirectoryGuard {
        fn drop(&mut self) {
            std::env::set_current_dir(&self.original).expect("restore original current directory");
        }
    }

    #[derive(Default)]
    struct SupervisorDriverState {
        launches: usize,
        starts: usize,
        sends: Vec<String>,
        interrupts: usize,
        approvals: usize,
        answers: usize,
        modes: Vec<String>,
        interaction_modes: Vec<String>,
        models: Vec<String>,
        rollbacks: Vec<i64>,
        shutdowns: usize,
        send_gate: Option<Arc<tokio::sync::Notify>>,
        reconcile_gate: Option<Arc<tokio::sync::Notify>>,
        reconcile_started: Option<Arc<tokio::sync::Notify>>,
    }

    #[derive(Clone, Default)]
    struct GenerationCapture(Arc<StdMutex<Option<ActivityRuntimeGeneration>>>);

    impl ActivityCancellationDispatcher for GenerationCapture {
        fn cancel_target(
            &self,
            _scope: ActivityScopeRef,
            generation: ActivityRuntimeGeneration,
            _target: ProviderActivityNativeTarget,
        ) -> BoxFuture<'static, Result<ActivityTargetDispatchDisposition, ActivityDispatchError>>
        {
            *self.0.lock().expect("generation capture") = Some(generation);
            Box::pin(async { Ok(ActivityTargetDispatchDisposition::Delivered) })
        }
    }

    struct SupervisorDriver {
        state: Arc<StdMutex<SupervisorDriverState>>,
        events: tokio::sync::Mutex<mpsc::Receiver<super::ProviderEvent>>,
    }

    impl ProviderDriver for SupervisorDriver {
        fn start(
            &self,
        ) -> super::BoxRuntimeFuture<'_, Result<super::StartedSession, super::ProviderRuntimeError>>
        {
            Box::pin(async move {
                self.state.lock().unwrap().starts += 1;
                Ok(super::StartedSession {
                    resume_cursor: Some(json!({"threadId":"unit-session"})),
                    runtime_payload: Some(json!({"transport":"unit"})),
                    activity_capabilities: super::ActivityCapabilities::none(),
                })
            })
        }

        fn send(
            &self,
            text: String,
            _: Vec<Value>,
            _: String,
        ) -> super::BoxRuntimeFuture<'_, Result<Option<String>, super::ProviderRuntimeError>>
        {
            Box::pin(async move {
                let gate = self.state.lock().unwrap().send_gate.clone();
                if let Some(gate) = gate {
                    gate.notified().await;
                }
                self.state.lock().unwrap().sends.push(text);
                Ok(Some("unit-turn".to_owned()))
            })
        }
        fn reconcile(
            &self,
            _delivery_key: String,
        ) -> super::BoxRuntimeFuture<'_, super::ProviderReconciliationOutcome> {
            Box::pin(async move {
                let gate = self.state.lock().unwrap().reconcile_gate.clone();
                if let Some(started) = self.state.lock().unwrap().reconcile_started.clone() {
                    started.notify_one();
                }
                if let Some(gate) = gate {
                    gate.notified().await;
                }
                super::ProviderReconciliationOutcome::Found
            })
        }

        fn interrupt(
            &self,
            _: Option<String>,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().interrupts += 1;
                Ok(())
            })
        }

        fn approve(
            &self,
            _: String,
            _: String,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().approvals += 1;
                Ok(())
            })
        }

        fn answer(
            &self,
            _: String,
            _: Value,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().answers += 1;
                Ok(())
            })
        }

        fn set_mode(
            &self,
            mode: String,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().modes.push(mode);
                Ok(())
            })
        }

        fn set_interaction_mode(
            &self,
            mode: String,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().interaction_modes.push(mode);
                Ok(())
            })
        }

        fn set_model(
            &self,
            model: String,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().models.push(model);
                Ok(())
            })
        }

        fn set_options(
            &self,
            _: Vec<Value>,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async { Ok(()) })
        }

        fn rollback(
            &self,
            turn_count: i64,
        ) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().rollbacks.push(turn_count);
                Ok(())
            })
        }

        fn next_event(&self) -> super::BoxRuntimeFuture<'_, Option<super::ProviderEvent>> {
            Box::pin(async move { self.events.lock().await.recv().await })
        }

        fn shutdown(&self) -> super::BoxRuntimeFuture<'_, Result<(), super::ProviderRuntimeError>> {
            Box::pin(async move {
                self.state.lock().unwrap().shutdowns += 1;
                Ok(())
            })
        }
    }

    struct SupervisorFactory {
        state: Arc<StdMutex<SupervisorDriverState>>,
        events: StdMutex<Option<mpsc::Receiver<super::ProviderEvent>>>,
    }

    impl ProviderDriverFactory for SupervisorFactory {
        fn create(
            &self,
            _: super::ProviderLaunchRequest,
        ) -> super::BoxRuntimeFuture<'_, Result<Arc<dyn ProviderDriver>, super::ProviderRuntimeError>>
        {
            Box::pin(async move {
                self.state.lock().unwrap().launches += 1;
                Ok(Arc::new(SupervisorDriver {
                    state: self.state.clone(),
                    events: tokio::sync::Mutex::new(
                        self.events.lock().unwrap().take().expect("event receiver"),
                    ),
                }) as Arc<dyn ProviderDriver>)
            })
        }
    }

    async fn supervisor_engine() -> super::OrchestrationEngine {
        let database = Database::open_in_memory().await.unwrap();
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .unwrap();
        let engine = super::OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .unwrap();
        for command in [
            json!({"type":"project.create","commandId":"project","projectId":"p1","title":"Project","workspaceRoot":"/tmp/project","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.create","commandId":"thread","threadId":"t1","projectId":"p1","title":"Thread","kind":"workspace","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-07-16T00:00:00Z"}),
        ] {
            engine
                .dispatch(serde_json::from_value(command).unwrap())
                .await
                .unwrap();
        }
        engine
    }

    fn native_launch(temp: &TempDir, provider: &str) -> super::ProviderLaunchRequest {
        super::ProviderLaunchRequest {
            thread_id: "native-test-thread".to_owned(),
            activity_causal_revision: 0,
            provider: provider.to_owned(),
            provider_label: provider.to_owned(),
            provider_instance_id: Some(provider.to_owned()),
            binary_path: format!("missing-{provider}"),
            cwd: temp.path().to_path_buf(),
            runtime_mode: "approval-required".to_owned(),
            interaction_mode: "default".to_owned(),
            model: Some("test-model".to_owned()),
            options: Vec::new(),
            service_tier: None,
            effort: None,
            agent: None,
            resume_cursor: None,
            environment: Default::default(),
            endpoint: None,
            server_password: None,
            mcp: None,
            codex_home: None,
        }
    }

    async fn launch_request_for_provider_with_options(
        provider: &str,
        model: &str,
        options: Vec<Value>,
    ) -> super::ProviderLaunchRequest {
        let engine = supervisor_engine().await;
        let settings = TempDir::new().expect("provider settings directory");
        let command = serde_json::from_value(json!({
            "type":"thread.turn.start",
            "commandId":"launch-options",
            "threadId":"t1",
            "message":{"messageId":"launch-message","role":"user","text":"launch","attachments":[]},
            "modelSelection":{
                "instanceId":provider,
                "model":model,
                "options":options
            },
            "runtimeMode":"full-access",
            "interactionMode":"default",
            "createdAt":"2026-07-16T00:00:00Z"
        }))
        .expect("turn command");

        let request = super::launch_request_for_command(
            &engine,
            &settings.path().to_path_buf(),
            &command,
            None,
        )
        .await
        .expect("launch request");
        engine.shutdown().await;
        request
    }

    async fn launch_request_with_options(options: Vec<Value>) -> super::ProviderLaunchRequest {
        launch_request_for_provider_with_options("codex", "gpt-5.6", options).await
    }

    #[tokio::test]
    async fn launch_request_preserves_canonical_options() {
        let request = launch_request_with_options(vec![
            json!({ "id":"fastMode", "value":true }),
            json!({ "id":"reasoningEffort", "value":"high" }),
        ])
        .await;

        assert_eq!(
            request.options,
            vec![
                json!({ "id":"fastMode", "value":true }),
                json!({ "id":"reasoningEffort", "value":"high" }),
            ]
        );
    }

    #[tokio::test]
    async fn claude_launch_keeps_agent_and_effort_out_of_session_options() {
        let request = launch_request_for_provider_with_options(
            "claudeAgent",
            "claude-opus-4-8",
            vec![
                json!({ "id":"agent", "value":"claude" }),
                json!({ "id":"effort", "value":"high" }),
                json!({ "id":"fastMode", "value":true }),
            ],
        )
        .await;

        assert_eq!(request.agent.as_deref(), Some("claude"));
        assert_eq!(request.effort.as_deref(), Some("high"));
        assert_eq!(
            request.options,
            vec![json!({ "id":"fastMode", "value":true })]
        );
    }

    #[tokio::test]
    async fn opencode_launch_keeps_agent_out_of_session_options() {
        let request = launch_request_for_provider_with_options(
            "opencode",
            "opencode/big-pickle",
            vec![
                json!({ "id":"agent", "value":"build" }),
                json!({ "id":"variant", "value":"high" }),
            ],
        )
        .await;

        assert_eq!(request.agent.as_deref(), Some("build"));
        assert_eq!(
            request.options,
            vec![json!({ "id":"variant", "value":"high" })]
        );
    }

    #[tokio::test]
    async fn launch_request_derives_effort_from_provider_aliases() {
        for option_id in ["reasoningEffort", "effort", "reasoning"] {
            let request = launch_request_with_options(vec![json!({
                "id":option_id,
                "value":"high"
            })])
            .await;
            assert_eq!(request.effort.as_deref(), Some("high"));
        }
        let request = launch_request_with_options(vec![
            json!({ "id":"reasoning", "value":"low" }),
            json!({ "id":"effort", "value":"medium" }),
            json!({ "id":"reasoningEffort", "value":"high" }),
        ])
        .await;
        assert_eq!(request.effort.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn launch_request_normalizes_options_deterministically() {
        let request = launch_request_with_options(vec![
            json!({ "id":"zeta", "value":"first" }),
            json!({ "id":" fastMode ", "value":false }),
            json!({ "id":"zeta", "value":"last" }),
            json!({ "id":"", "value":"ignored" }),
            json!({ "id":"count", "value":1 }),
            json!({ "id":"missing" }),
            json!({ "value":true }),
            json!({ "id":false, "value":"ignored" }),
        ])
        .await;

        assert_eq!(
            request.options,
            vec![
                json!({ "id":"fastMode", "value":false }),
                json!({ "id":"zeta", "value":"last" }),
            ]
        );
    }

    #[tokio::test]
    async fn rejected_option_logging_redacts_untrusted_ids_and_string_values() {
        use crate::production::operational_logs::{OperationalLogOptions, ProviderOperationalLog};

        let temp = TempDir::new().expect("provider option log directory");
        let path = temp.path().join("provider-options.log");
        let log = ProviderOperationalLog::start(
            path.clone(),
            OperationalLogOptions {
                max_file_bytes: 4096,
                retained_files: 1,
                queue_capacity: 4,
            },
        )
        .await
        .expect("provider option log starts");
        let request = native_launch(&temp, "codex");

        super::record_option_reconciliation(
            Some(&log),
            &request,
            &[json!({
                "id":"PRIVATE_OPTION_ID",
                "value":"PRIVATE_OPTION_VALUE"
            })],
            "live",
            "failed",
        );
        log.shutdown()
            .await
            .expect("provider option log shuts down");

        let contents = std::fs::read_to_string(path).expect("read provider option log");
        assert!(!contents.contains("PRIVATE_OPTION_ID"));
        assert!(!contents.contains("PRIVATE_OPTION_VALUE"));
        let record: Value = serde_json::from_str(contents.trim()).expect("provider option record");
        assert_eq!(record["optionId"], "unknown");
        assert!(record.get("requestedValue").is_none());
    }

    #[test]
    fn delivery_fingerprint_changes_when_options_change() {
        let temp = TempDir::new().expect("provider fixture directory");
        let mut standard = native_launch(&temp, "codex");
        standard.options = vec![json!({ "id":"fastMode", "value":false })];
        let mut fast = standard.clone();
        fast.options = vec![json!({ "id":"fastMode", "value":true })];

        assert_ne!(
            super::delivery_route_fingerprint(&standard).expect("standard route fingerprint"),
            super::delivery_route_fingerprint(&fast).expect("fast route fingerprint")
        );
    }

    #[test]
    fn claude_delivery_launch_requests_replayed_user_message_acknowledgements() {
        let temp = TempDir::new().expect("provider fixture directory");
        let request = native_launch(&temp, "claudeAgent");

        let arguments = super::build_claude_launch_arguments(
            &request,
            "claude-session",
            super::ClaudeActivitySupport::default(),
            None,
        );

        for required in [
            "--print",
            "--input-format",
            "--output-format",
            "--replay-user-messages",
            "--include-partial-messages",
            "--verbose",
        ] {
            assert!(
                arguments.iter().any(|argument| argument == required),
                "Claude launch is missing required argument {required}: {arguments:?}"
            );
        }
        let replay = arguments
            .iter()
            .position(|argument| argument == "--replay-user-messages")
            .expect("replay argument");
        let verbose = arguments
            .iter()
            .position(|argument| argument == "--verbose")
            .expect("verbose argument");
        assert!(
            replay < verbose,
            "Claude requires --replay-user-messages before --verbose: {arguments:?}"
        );
    }

    #[cfg(unix)]
    fn executable_fixture(temp: &TempDir, name: &str, contents: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let executable = temp.path().join(name);
        std::fs::write(&executable, contents).expect("provider fixture should write");
        let mut permissions = std::fs::metadata(&executable)
            .expect("provider fixture metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&executable, permissions)
            .expect("provider fixture should be executable");
        executable
    }

    #[cfg(windows)]
    fn executable_fixture(temp: &TempDir, name: &str, kind: &str) -> std::path::PathBuf {
        let script = temp.path().join(format!("{name}.js"));
        let executable = temp.path().join(format!("{name}.cmd"));
        let source = match kind {
            "claude" => {
                r#"const fs = require("node:fs");
const readline = require("node:readline");
process.stderr.write("fixture warning\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (process.env.BIBCODE_TEST_REQUEST_CAPTURE) {
    fs.appendFileSync(process.env.BIBCODE_TEST_REQUEST_CAPTURE, `${line}\n`);
  }
});
"#
            }
            "claude-replay" => {
                r#"const fs = require("node:fs");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  fs.appendFileSync(process.env.BIBCODE_TEST_REQUEST_CAPTURE, `${line}\n`);
  const timer = setInterval(() => {
    if (!fs.existsSync(process.env.BIBCODE_TEST_ACK_GATE)) return;
    clearInterval(timer);
    process.stdout.write(`${line}\n`);
  }, 10);
});
"#
            }
            "claude-disconnect" => {
                r#"const fs = require("node:fs");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  fs.appendFileSync(process.env.BIBCODE_TEST_REQUEST_CAPTURE, `${line}\n`);
  process.exit(0);
});
"#
            }
            "codex" => {
                r#"const fs = require("node:fs");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (process.env.BIBCODE_TEST_REQUEST_CAPTURE) {
    fs.appendFileSync(process.env.BIBCODE_TEST_REQUEST_CAPTURE, `${line}\n`);
  }
  const request = JSON.parse(line);
  let result;
  switch (request.method) {
    case "initialize":
      result = { userAgent: "fixture" };
      break;
    case "thread/start":
      result = { cwd: process.cwd(), model: "gpt-5", thread: { id: "native-codex-thread" } };
      break;
    case "mcpServerStatus/list":
      result = { data: [], nextCursor: null };
      break;
    case "thread/goal/set":
      result = { goal: { status: "active" } };
      break;
    case "turn/start":
      result = { turn: { id: "native-codex-turn" } };
      break;
    case "turn/interrupt":
      result = {};
      break;
    case "thread/rollback":
      result = { thread: { id: "native-codex-thread", turns: [] } };
      break;
    case "shutdown":
      result = null;
      break;
    default:
      return;
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
});
"#
            }
            "acp" => {
                r#"const fs = require("node:fs");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (process.env.BIBCODE_TEST_REQUEST_CAPTURE) {
    fs.appendFileSync(process.env.BIBCODE_TEST_REQUEST_CAPTURE, `${line}\n`);
  }
  const request = JSON.parse(line);
  let result;
  switch (request.method) {
    case "initialize":
    case "authenticate":
    case "session/set_mode":
    case "session/set_model":
      result = {};
      break;
    case "session/new":
      result = {
        sessionId: "cursor-session",
        configOptions: [{ id: "model", category: "model" }],
        modes: {
          currentModeId: "ask",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "code", name: "Agent" },
            { id: "architect", name: "Plan" },
          ],
        },
      };
      break;
    case "session/create":
      result = {
        sessionId: "grok-session",
        modes: {
          currentModeId: "code",
          availableModes: [
            { id: "code", name: "Agent" },
            { id: "ask", name: "Ask" },
          ],
        },
      };
      break;
    case "session/set_config_option":
      result = { configOptions: [] };
      break;
    case "session/prompt":
      if (process.env.BIBCODE_TEST_REJECT_PROMPT) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "prompt rejected" } })}\n`);
        return;
      }
      if (process.env.BIBCODE_TEST_DISCONNECT_AFTER_PROMPT) {
        process.exit(0);
        return;
      }
      if (process.env.BIBCODE_TEST_ACK_GATE) {
        const timer = setInterval(() => {
          if (!fs.existsSync(process.env.BIBCODE_TEST_ACK_GATE)) return;
          clearInterval(timer);
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } })}\n`);
        }, 10);
        return;
      }
      result = { stopReason: "end_turn" };
      break;
    default:
      return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
"#
            }
            _ => unreachable!("unknown provider fixture kind"),
        };
        std::fs::write(&script, source).expect("provider fixture script should write");
        std::fs::write(
            &executable,
            format!("@echo off\r\nnode \"%~dp0{name}.js\" %*\r\n"),
        )
        .expect("provider fixture wrapper should write");
        executable
    }

    #[cfg(unix)]
    const CLAUDE_FIXTURE: &str = r#"#!/bin/sh
printf '%s\n' 'fixture warning' >&2
while IFS= read -r line; do
  [ -z "$BIBCODE_TEST_REQUEST_CAPTURE" ] || printf '%s\n' "$line" >> "$BIBCODE_TEST_REQUEST_CAPTURE"
done
"#;
    #[cfg(windows)]
    const CLAUDE_FIXTURE: &str = "claude";

    #[cfg(unix)]
    const CLAUDE_REPLAY_FIXTURE: &str = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$BIBCODE_TEST_REQUEST_CAPTURE"
  while [ ! -f "$BIBCODE_TEST_ACK_GATE" ]; do sleep 0.01; done
  printf '%s\n' "$line"
done
"#;
    #[cfg(windows)]
    const CLAUDE_REPLAY_FIXTURE: &str = "claude-replay";

    #[cfg(unix)]
    const CLAUDE_DISCONNECT_FIXTURE: &str = r#"#!/bin/sh
IFS= read -r line
printf '%s\n' "$line" >> "$BIBCODE_TEST_REQUEST_CAPTURE"
"#;
    #[cfg(windows)]
    const CLAUDE_DISCONNECT_FIXTURE: &str = "claude-disconnect";

    #[cfg(unix)]
    const CLAUDE_CONTEXT_QUERY_FIXTURE: &str = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$BIBCODE_TEST_REQUEST_CAPTURE"
  case "$line" in
    *'"type":"user"'*)
      printf '%s\n' "$line"
      printf '%s\n' '{"type":"stream_event","session_id":"fixture-session","uuid":"usage-1","parent_tool_use_id":null,"event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1000,"cache_creation_input_tokens":200,"cache_read_input_tokens":300,"output_tokens":50}}}'
      printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"errors":[],"stop_reason":"end_turn","session_id":"fixture-session","uuid":"result-1"}'
      ;;
    *'"subtype":"get_context_usage"'*)
      request_id=$(printf '%s\n' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"totalTokens":31251,"maxTokens":200000,"isAutoCompactEnabled":true}}}\n' "$request_id"
      ;;
    *'"subtype":"mcp_status"'*)
      request_id=$(printf '%s\n' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[{"name":"context7","status":"connected"}]}}}\n' "$request_id"
      ;;
  esac
done
"#;

    async fn claude_delivery_fixture(
        temp: &TempDir,
        name: &str,
        fixture: &str,
        capture_path: &std::path::Path,
        acknowledgement_gate: Option<&std::path::Path>,
    ) -> Arc<super::ClaudeDriver> {
        let executable = executable_fixture(temp, name, fixture);
        let factory = super::NativeProviderDriverFactory::new(temp.path().join("attachments"));
        let mut request = native_launch(temp, "claudeAgent");
        request.binary_path = executable.to_string_lossy().into_owned();
        request.environment.insert(
            "BIBCODE_TEST_REQUEST_CAPTURE".to_owned(),
            capture_path.to_string_lossy().into_owned(),
        );
        if let Some(gate) = acknowledgement_gate {
            request.environment.insert(
                "BIBCODE_TEST_ACK_GATE".to_owned(),
                gate.to_string_lossy().into_owned(),
            );
        }
        Arc::new(
            super::ClaudeDriver::spawn(
                request,
                factory.attachments.clone(),
                factory.attribution.clone(),
                false,
            )
            .await
            .expect("Claude delivery fixture should start"),
        )
    }

    #[tokio::test]
    async fn claude_options_acknowledge_the_exact_launch_vector_and_restart_only_fast_changes() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let factory = super::NativeProviderDriverFactory::new(temp.path().join("attachments"));
        let fixture = executable_fixture(&temp, "claude-options", CLAUDE_FIXTURE);
        let mut request = native_launch(&temp, "claudeAgent");
        request.binary_path = fixture.to_string_lossy().into_owned();
        request.model = Some("claude-opus-4-8".to_owned());
        request.options = vec![json!({ "id": "fastMode", "value": true })];
        let driver = super::ClaudeDriver::spawn(
            request,
            factory.attachments.clone(),
            factory.attribution.clone(),
            false,
        )
        .await
        .expect("Claude driver should create");

        driver
            .set_options(vec![json!({ "id": "fastMode", "value": true })])
            .await
            .expect("exact launch vector is acknowledged");
        assert!(matches!(
            driver
                .set_options(vec![json!({ "id": "fastMode", "value": false })])
                .await,
            Err(super::ProviderRuntimeError::UnsupportedCapability { .. })
        ));
        assert!(matches!(
            driver
                .set_options(vec![json!({ "id": "unknown", "value": true })])
                .await,
            Err(super::ProviderRuntimeError::Provider { .. })
        ));
        driver
            .shutdown()
            .await
            .expect("Claude driver should shut down");
    }

    #[tokio::test]
    async fn claude_delivery_waits_for_the_replayed_user_message_before_accepting() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let capture_path = temp.path().join("claude-delivery.jsonl");
        let acknowledgement_gate = temp.path().join("release-acknowledgement");
        let driver = claude_delivery_fixture(
            &temp,
            "claude-delivery-replay",
            CLAUDE_REPLAY_FIXTURE,
            &capture_path,
            Some(&acknowledgement_gate),
        )
        .await;
        driver.start().await.expect("Claude fixture should start");
        let delivery_driver = driver.clone();
        let mut delivery = tokio::spawn(async move {
            delivery_driver
                .deliver(
                    "hello".to_owned(),
                    Vec::new(),
                    "default".to_owned(),
                    "unused-no-id-key".to_owned(),
                )
                .await
        });
        captured_request(&capture_path, |value| value["type"] == "user").await;

        let premature = timeout(std::time::Duration::from_millis(100), &mut delivery).await;
        let was_pending = premature.is_err();
        std::fs::write(&acknowledgement_gate, b"release").expect("release acknowledgement");
        let outcome = match premature {
            Ok(outcome) => outcome.expect("delivery task should join"),
            Err(_) => timeout(std::time::Duration::from_secs(2), delivery)
                .await
                .expect("replayed user message should acknowledge delivery")
                .expect("delivery task should join"),
        };
        driver.shutdown().await.expect("Claude fixture shutdown");

        assert!(
            was_pending,
            "writing stdin is not acceptance; delivery must wait for Claude's replay"
        );
        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::Accepted { turn_id: Some(_) }
        ));
    }

    #[tokio::test]
    async fn claude_delivery_disconnect_after_write_without_replay_is_ambiguous() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let capture_path = temp.path().join("claude-delivery.jsonl");
        let driver = claude_delivery_fixture(
            &temp,
            "claude-delivery-disconnect",
            CLAUDE_DISCONNECT_FIXTURE,
            &capture_path,
            None,
        )
        .await;
        driver.start().await.expect("Claude fixture should start");
        let delivery_driver = driver.clone();
        let delivery = tokio::spawn(async move {
            delivery_driver
                .deliver(
                    "hello".to_owned(),
                    Vec::new(),
                    "default".to_owned(),
                    "unused-no-id-key".to_owned(),
                )
                .await
        });
        captured_request(&capture_path, |value| value["type"] == "user").await;
        let outcome = timeout(std::time::Duration::from_secs(2), delivery)
            .await
            .expect("provider disconnect should resolve delivery")
            .expect("delivery task should join");
        driver.shutdown().await.expect("Claude fixture shutdown");

        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::Ambiguous { .. }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_completion_queries_order_stream_usage_mcp_status_then_completion() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let capture_path = temp.path().join("claude-context-query.jsonl");
        let driver = claude_delivery_fixture(
            &temp,
            "claude-context-query",
            CLAUDE_CONTEXT_QUERY_FIXTURE,
            &capture_path,
            None,
        )
        .await;
        driver.start().await.expect("Claude fixture should start");

        let outcome = timeout(
            std::time::Duration::from_secs(2),
            driver.deliver(
                "measure context".to_owned(),
                Vec::new(),
                "default".to_owned(),
                "unused-no-id-key".to_owned(),
            ),
        )
        .await
        .expect("delivery timeout");
        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::Accepted { .. }
        ));

        let stream_usage = timeout(std::time::Duration::from_secs(2), driver.next_event())
            .await
            .expect("stream usage timeout")
            .expect("stream usage event");
        let authoritative_usage = timeout(std::time::Duration::from_secs(2), driver.next_event())
            .await
            .expect("authoritative usage timeout")
            .expect("authoritative usage event");
        let mcp_status = timeout(std::time::Duration::from_secs(2), driver.next_event())
            .await
            .expect("MCP status timeout")
            .expect("MCP status event");
        let completion = timeout(std::time::Duration::from_secs(2), driver.next_event())
            .await
            .expect("completion timeout")
            .expect("completion event");

        assert_eq!(stream_usage.event_type, "thread.token-usage.updated");
        assert_eq!(stream_usage.payload["usage"]["usedTokens"], 1_550);
        assert_eq!(authoritative_usage.event_type, "thread.token-usage.updated");
        assert_eq!(authoritative_usage.payload["usage"]["usedTokens"], 31_251);
        assert_eq!(mcp_status.event_type, "mcp.status.updated");
        assert_eq!(mcp_status.payload["servers"][0]["name"], "context7");
        assert_eq!(mcp_status.payload["servers"][0]["state"], "connected");
        assert_eq!(completion.event_type, "turn.completed");
        assert_eq!(completion.payload["state"], "completed");

        let query = captured_request(&capture_path, |value| {
            value["request"]["subtype"] == "get_context_usage"
        })
        .await;
        assert_eq!(
            query,
            json!({
                "type": "control_request",
                "request_id": "bibcode-1",
                "request": { "subtype": "get_context_usage" }
            })
        );
        let mcp_query = captured_request(&capture_path, |value| {
            value["request"]["subtype"] == "mcp_status"
        })
        .await;
        assert_eq!(
            mcp_query,
            json!({
                "type": "control_request",
                "request_id": "bibcode-2",
                "request": { "subtype": "mcp_status" }
            })
        );

        driver.shutdown().await.expect("Claude fixture shutdown");
    }

    #[test]
    fn claude_delivery_cancellation_releases_the_pending_acknowledgement() {
        let slot = super::ClaudeAcknowledgementSlot::default();
        let (first_sender, _first_receiver) = tokio::sync::oneshot::channel();
        let first = slot
            .register(first_sender)
            .expect("first delivery registers");
        slot.acknowledge();
        let (retry_sender, _retry_receiver) = tokio::sync::oneshot::channel();
        let retry = slot
            .register(retry_sender)
            .expect("acknowledgement releases the first registration");

        drop(first);

        let (overlap_sender, _overlap_receiver) = tokio::sync::oneshot::channel();
        assert!(
            slot.register(overlap_sender).is_none(),
            "an older delivery guard must not clear a newer acknowledgement slot"
        );
        drop(retry);
        let (next_sender, _next_receiver) = tokio::sync::oneshot::channel();
        assert!(slot.register(next_sender).is_some());
    }

    #[tokio::test]
    async fn claude_delivery_non_user_stdout_does_not_acknowledge_the_pending_turn() {
        // Mutation caught: acknowledging every raw stdout value instead of only a user replay.
        let runtime = Arc::new(tokio::sync::Mutex::new(
            crate::provider::claude::ClaudeProviderRuntime::new(
                "claude-delivery-thread".to_owned(),
                "claude-session".to_owned(),
            ),
        ));
        let (event_sender, _event_receiver) = tokio::sync::mpsc::channel(4);
        let (recovery_sender, _recovery_receiver) = tokio::sync::mpsc::channel(1);
        let cancellation = tokio_util::sync::CancellationToken::new();
        let slot = super::ClaudeAcknowledgementSlot::default();
        let (acknowledgement_sender, mut acknowledgement_receiver) =
            tokio::sync::oneshot::channel();
        let _registration = slot
            .register(acknowledgement_sender)
            .expect("delivery acknowledgement registers");

        assert!(
            super::emit_claude_value(
                &runtime,
                "claude-delivery-thread",
                serde_json::json!({
                    "type": "assistant",
                    "message": { "role": "assistant", "content": [] }
                }),
                &event_sender,
                false,
                &recovery_sender,
                &cancellation,
                &slot,
            )
            .await
        );
        assert!(matches!(
            acknowledgement_receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
    }

    #[cfg(unix)]
    const CODEX_FIXTURE: &str = r#"#!/bin/sh
while IFS= read -r line; do
  [ -z "$BIBCODE_TEST_REQUEST_CAPTURE" ] || printf '%s\n' "$line" >> "$BIBCODE_TEST_REQUEST_CAPTURE"
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fixture"}}\n' "$id" ;;
    *'"method":"thread/start"'*) printf '{"id":%s,"result":{"cwd":"/tmp","model":"gpt-5","thread":{"id":"native-codex-thread"}}}\n' "$id" ;;
    *'"method":"mcpServerStatus/list"'*) printf '{"id":%s,"result":{"data":[],"nextCursor":null}}\n' "$id" ;;
    *'"method":"thread/goal/set"'*) printf '{"id":%s,"result":{"goal":{"status":"active"}}}\n' "$id" ;;
    *'"method":"turn/start"'*) printf '{"id":%s,"result":{"turn":{"id":"native-codex-turn"}}}\n' "$id" ;;
    *'"method":"turn/interrupt"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"thread/rollback"'*) printf '{"id":%s,"result":{"thread":{"id":"native-codex-thread","turns":[]}}}\n' "$id" ;;
    *'"method":"shutdown"'*) printf '{"id":%s,"result":null}\n' "$id" ;;
  esac
done
"#;
    #[cfg(windows)]
    const CODEX_FIXTURE: &str = "codex";

    #[cfg(unix)]
    const ACP_FIXTURE: &str = r#"#!/bin/sh
while IFS= read -r line; do
  [ -z "$BIBCODE_TEST_REQUEST_CAPTURE" ] || printf '%s\n' "$line" >> "$BIBCODE_TEST_REQUEST_CAPTURE"
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*|*'"method":"authenticate"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"session/new"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"cursor-session","configOptions":[{"id":"model","category":"model"}],"modes":{"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"code","name":"Agent"},{"id":"architect","name":"Plan"}]}}}\n' "$id" ;;
    *'"method":"session/create"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"grok-session","modes":{"currentModeId":"code","availableModes":[{"id":"code","name":"Agent"},{"id":"ask","name":"Ask"}]}}}\n' "$id" ;;
    *'"method":"session/set_config_option"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"configOptions":[]}}\n' "$id" ;;
    *'"method":"session/set_mode"'*|*'"method":"session/set_model"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"method":"session/prompt"'*)
      [ -z "$BIBCODE_TEST_REJECT_PROMPT" ] || { printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"prompt rejected"}}\n' "$id"; continue; }
      [ -z "$BIBCODE_TEST_DISCONNECT_AFTER_PROMPT" ] || exit 0
      while [ -n "$BIBCODE_TEST_ACK_GATE" ] && [ ! -f "$BIBCODE_TEST_ACK_GATE" ]; do sleep 0.01; done
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
      ;;
  esac
done
"#;
    #[cfg(windows)]
    const ACP_FIXTURE: &str = "acp";

    async fn cursor_delivery_fixture(
        temp: &TempDir,
        capture_path: &std::path::Path,
        acknowledgement_gate: Option<&std::path::Path>,
        disconnect_after_prompt: bool,
        reject_prompt: bool,
    ) -> Arc<super::CursorDriver> {
        let executable = executable_fixture(temp, "cursor-delivery", ACP_FIXTURE);
        let factory = super::NativeProviderDriverFactory::new(temp.path().join("attachments"));
        let mut request = native_launch(temp, "cursor");
        request.binary_path = executable.to_string_lossy().into_owned();
        request.environment.insert(
            "BIBCODE_TEST_REQUEST_CAPTURE".to_owned(),
            capture_path.to_string_lossy().into_owned(),
        );
        if let Some(gate) = acknowledgement_gate {
            request.environment.insert(
                "BIBCODE_TEST_ACK_GATE".to_owned(),
                gate.to_string_lossy().into_owned(),
            );
        }
        if disconnect_after_prompt {
            request.environment.insert(
                "BIBCODE_TEST_DISCONNECT_AFTER_PROMPT".to_owned(),
                "1".to_owned(),
            );
        }
        if reject_prompt {
            request
                .environment
                .insert("BIBCODE_TEST_REJECT_PROMPT".to_owned(), "1".to_owned());
        }
        Arc::new(
            super::CursorDriver::spawn(
                request,
                factory.attachments.clone(),
                factory.attribution.clone(),
            )
            .await
            .expect("Cursor delivery fixture should start"),
        )
    }

    #[tokio::test]
    async fn cursor_delivery_missing_session_is_definitely_not_sent() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let capture_path = temp.path().join("cursor-delivery.jsonl");
        let driver = cursor_delivery_fixture(&temp, &capture_path, None, false, false).await;

        let outcome = driver
            .deliver(
                "hello".to_owned(),
                Vec::new(),
                "default".to_owned(),
                "unused-no-id-key".to_owned(),
            )
            .await;
        driver.shutdown().await.expect("Cursor fixture shutdown");

        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::DefinitelyNotSent { .. }
        ));
        assert!(
            !std::fs::read_to_string(&capture_path)
                .unwrap_or_default()
                .contains("session/prompt"),
            "pre-write failure must not create a prompt request"
        );
    }

    #[tokio::test]
    async fn cursor_delivery_waits_for_the_session_prompt_response_before_accepting() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let capture_path = temp.path().join("cursor-delivery.jsonl");
        let acknowledgement_gate = temp.path().join("release-response");
        let driver = cursor_delivery_fixture(
            &temp,
            &capture_path,
            Some(&acknowledgement_gate),
            false,
            false,
        )
        .await;
        driver.start().await.expect("Cursor fixture should start");
        let delivery_driver = driver.clone();
        let mut delivery = tokio::spawn(async move {
            delivery_driver
                .deliver(
                    "hello".to_owned(),
                    Vec::new(),
                    "default".to_owned(),
                    "unused-no-id-key".to_owned(),
                )
                .await
        });
        captured_request(&capture_path, |value| value["method"] == "session/prompt").await;

        let premature = timeout(std::time::Duration::from_millis(100), &mut delivery).await;
        let was_pending = premature.is_err();
        std::fs::write(&acknowledgement_gate, b"release").expect("release response");
        let outcome = match premature {
            Ok(outcome) => outcome.expect("delivery task should join"),
            Err(_) => timeout(std::time::Duration::from_secs(2), delivery)
                .await
                .expect("prompt response should acknowledge delivery")
                .expect("delivery task should join"),
        };
        driver.shutdown().await.expect("Cursor fixture shutdown");

        assert!(
            was_pending,
            "writing the ACP request is not acceptance; delivery must wait for its response"
        );
        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::Accepted { turn_id: Some(_) }
        ));
    }

    #[tokio::test]
    async fn cursor_delivery_disconnect_after_write_before_response_is_ambiguous() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let capture_path = temp.path().join("cursor-delivery.jsonl");
        let driver = cursor_delivery_fixture(&temp, &capture_path, None, true, false).await;
        driver.start().await.expect("Cursor fixture should start");
        let outcome = timeout(
            std::time::Duration::from_secs(2),
            driver.deliver(
                "hello".to_owned(),
                Vec::new(),
                "default".to_owned(),
                "unused-no-id-key".to_owned(),
            ),
        )
        .await
        .expect("provider disconnect should resolve delivery");
        captured_request(&capture_path, |value| value["method"] == "session/prompt").await;
        driver.shutdown().await.expect("Cursor fixture shutdown");

        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::Ambiguous { .. }
        ));
    }

    #[tokio::test]
    async fn cursor_delivery_remote_prompt_rejection_is_rejected() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let capture_path = temp.path().join("cursor-delivery.jsonl");
        let driver = cursor_delivery_fixture(&temp, &capture_path, None, false, true).await;
        driver.start().await.expect("Cursor fixture should start");

        let outcome = driver
            .deliver(
                "hello".to_owned(),
                Vec::new(),
                "default".to_owned(),
                "unused-no-id-key".to_owned(),
            )
            .await;
        captured_request(&capture_path, |value| value["method"] == "session/prompt").await;
        driver.shutdown().await.expect("Cursor fixture shutdown");

        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::Rejected { detail }
                if detail.contains("prompt rejected")
        ));
    }

    #[tokio::test]
    async fn cursor_delivery_prompt_write_zero_bytes_is_definitely_not_sent() {
        // Mutation caught: treating a proven zero-byte failure as possibly submitted prevents a
        // safe retry.
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let (outcome, accepted_prompt_bytes, prompt_reached_peer, _) =
            cursor_delivery_with_prompt_write_failure(PromptWriteFailure::BeforeFirstByte).await;

        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::DefinitelyNotSent { .. }
        ));
        assert_eq!(accepted_prompt_bytes, 0);
        assert!(!prompt_reached_peer);
    }

    #[tokio::test]
    async fn cursor_delivery_prompt_write_partial_bytes_is_ambiguous() {
        // Mutation caught: write_all erases a successful prefix when a later write fails, making
        // a possibly submitted prompt look safe to retry.
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let (outcome, accepted_prompt_bytes, prompt_reached_peer, _) =
            cursor_delivery_with_prompt_write_failure(PromptWriteFailure::AfterPrefix).await;

        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::Ambiguous { .. }
        ));
        assert!(
            accepted_prompt_bytes > 0,
            "the writer accepted a prompt prefix"
        );
        assert!(
            !prompt_reached_peer,
            "the incomplete JSON line was not a prompt"
        );
    }

    #[tokio::test]
    async fn cursor_delivery_prompt_write_flush_failure_is_ambiguous() {
        // Mutation caught: a flush error occurs after write_all accepted the complete prompt frame,
        // so classifying it as definitely unsent can duplicate a provider-visible prompt.
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let (outcome, accepted_prompt_bytes, prompt_reached_peer, _) =
            cursor_delivery_with_prompt_write_failure(PromptWriteFailure::OnFlush).await;

        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::Ambiguous { .. }
        ));
        assert!(
            accepted_prompt_bytes > 0,
            "the writer accepted the prompt frame"
        );
        assert!(
            prompt_reached_peer,
            "the peer parsed the complete prompt frame"
        );
    }

    #[tokio::test]
    async fn cursor_delivery_prompt_write_confirmation_loss_is_ambiguous_without_a_pending_leak() {
        // Mutation caught: dropping the writer confirmation without removing its correlation
        // leaves a permanently pending response entry after the durable driver returns Ambiguous.
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let (outcome, accepted_prompt_bytes, prompt_reached_peer, pending_request_count) =
            cursor_delivery_with_prompt_write_failure(PromptWriteFailure::LoseConfirmation).await;

        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::Ambiguous { .. }
        ));
        assert_eq!(accepted_prompt_bytes, 0);
        assert!(!prompt_reached_peer);
        assert_eq!(
            pending_request_count, 0,
            "the lost receipt owns correlation cleanup"
        );
    }

    async fn cursor_delivery_with_prompt_write_failure(
        failure: PromptWriteFailure,
    ) -> (super::ProviderDeliveryOutcome, usize, bool, usize) {
        let temp = TempDir::new().expect("provider fixture directory");
        let dummy = cursor_delivery_fixture(
            &temp,
            &temp.path().join("cursor-child.jsonl"),
            None,
            false,
            false,
        )
        .await;
        let (stdout, mut stdout_peer) = tokio::io::duplex(4096);
        let (stdin_peer, stdin) = tokio::io::duplex(4096);
        let (stderr, _stderr_peer) = tokio::io::duplex(4096);
        let prompt_reached_peer = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let accepted_prompt_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (release_peer, hold_peer_open) = tokio::sync::oneshot::channel();
        let (connection, incoming) = super::CursorConnection::spawn(
            stdout,
            PromptFailingWriter {
                inner: stdin,
                failure,
                prompt_detected: false,
                fail_next_prompt_write: false,
                accepted_prompt_bytes: accepted_prompt_bytes.clone(),
            },
            stderr,
            super::CursorConnectionConfig::default(),
        );
        let pending_connection = connection.clone();
        let runtime = super::CursorSessionRuntime::new(
            super::CursorSessionOptions {
                thread_id: "cursor-writer-failure".to_owned(),
                cwd: temp.path().to_string_lossy().into_owned(),
                runtime_mode: "approval-required".to_owned(),
                interaction_mode: "default".to_owned(),
                model: "test-model".to_owned(),
                resume_session_id: None,
                mcp_servers: Vec::new(),
            },
            connection,
            incoming,
        );
        let peer_prompt = prompt_reached_peer.clone();
        let peer = tokio::spawn(async move {
            let mut requests = BufReader::new(stdin_peer).lines();
            while let Some(line) = requests.next_line().await.expect("ACP request read") {
                let Ok(request) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if request["method"] == "session/prompt" {
                    peer_prompt.store(true, std::sync::atomic::Ordering::SeqCst);
                    continue;
                }
                let result = match request["method"].as_str() {
                    Some("initialize" | "authenticate" | "session/set_mode") => json!({}),
                    Some("session/new") => json!({
                        "sessionId": "cursor-session",
                        "configOptions": [{ "id": "model", "category": "model" }],
                        "modes": {
                            "currentModeId": "ask",
                            "availableModes": [
                                { "id": "ask", "name": "Ask" },
                                { "id": "code", "name": "Agent" }
                            ]
                        }
                    }),
                    Some("session/set_config_option") => json!({ "configOptions": [] }),
                    Some(method) => panic!("unexpected ACP method {method}"),
                    None => panic!("ACP request missing method"),
                };
                stdout_peer
                    .write_all(
                        format!(
                            "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{result}}}\n",
                            request["id"]
                        )
                        .as_bytes(),
                    )
                    .await
                    .expect("ACP response write");
            }
            let _ = hold_peer_open.await;
        });
        let driver = super::CursorDriver {
            runtime,
            child: dummy.child.clone(),
            attachments: dummy.attachments.clone(),
        };
        driver.start().await.expect("Cursor fixture should start");

        let outcome = timeout(
            std::time::Duration::from_secs(2),
            driver.deliver(
                "hello".to_owned(),
                Vec::new(),
                "default".to_owned(),
                "unused-no-id-key".to_owned(),
            ),
        )
        .await
        .expect("writer failure should resolve delivery");
        let pending_request_count = pending_connection.pending_request_count().await;
        let _ = release_peer.send(());
        timeout(std::time::Duration::from_secs(2), driver.shutdown())
            .await
            .expect("Cursor fixture shutdown timeout")
            .expect("Cursor fixture shutdown");
        timeout(std::time::Duration::from_secs(2), peer)
            .await
            .expect("ACP peer shutdown timeout")
            .expect("ACP peer task");

        (
            outcome,
            accepted_prompt_bytes.load(std::sync::atomic::Ordering::SeqCst),
            prompt_reached_peer.load(std::sync::atomic::Ordering::SeqCst),
            pending_request_count,
        )
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum PromptWriteFailure {
        BeforeFirstByte,
        AfterPrefix,
        OnFlush,
        LoseConfirmation,
    }

    struct PromptFailingWriter {
        inner: DuplexStream,
        failure: PromptWriteFailure,
        prompt_detected: bool,
        fail_next_prompt_write: bool,
        accepted_prompt_bytes: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl AsyncWrite for PromptFailingWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            context: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            if self.fail_next_prompt_write {
                return Poll::Ready(Err(io::Error::other(
                    "intentional partial prompt writer failure",
                )));
            }
            let starts_prompt = !self.prompt_detected
                && bytes
                    .windows(b"\"method\":\"session/prompt\"".len())
                    .any(|window| window == b"\"method\":\"session/prompt\"");
            if starts_prompt && self.failure == PromptWriteFailure::BeforeFirstByte {
                return Poll::Ready(Err(io::Error::other(
                    "intentional zero-byte prompt writer failure",
                )));
            }
            if starts_prompt && self.failure == PromptWriteFailure::LoseConfirmation {
                panic!("intentional prompt writer confirmation loss");
            }
            if starts_prompt && self.failure == PromptWriteFailure::AfterPrefix {
                let prefix_length = bytes.len().min(16);
                let result = Pin::new(&mut self.inner).poll_write(context, &bytes[..prefix_length]);
                if let Poll::Ready(Ok(written)) = result {
                    self.prompt_detected = true;
                    self.fail_next_prompt_write = written > 0;
                    self.accepted_prompt_bytes
                        .fetch_add(written, std::sync::atomic::Ordering::SeqCst);
                }
                return result;
            }
            if starts_prompt {
                self.prompt_detected = true;
            }
            let result = Pin::new(&mut self.inner).poll_write(context, bytes);
            if self.prompt_detected
                && let Poll::Ready(Ok(written)) = result
            {
                self.accepted_prompt_bytes
                    .fetch_add(written, std::sync::atomic::Ordering::SeqCst);
            }
            result
        }

        fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
            if self.prompt_detected && self.failure == PromptWriteFailure::OnFlush {
                return Poll::Ready(Err(io::Error::other("intentional prompt flush failure")));
            }
            Pin::new(&mut self.inner).poll_flush(context)
        }

        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            context: &mut Context<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(context)
        }
    }

    async fn captured_request(path: &std::path::Path, predicate: impl Fn(&Value) -> bool) -> Value {
        timeout(std::time::Duration::from_secs(2), async {
            loop {
                let captured = std::fs::read_to_string(path).unwrap_or_default();
                if let Some(request) = captured
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .find(|request| predicate(request))
                {
                    return request;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("provider request capture timeout")
    }

    async fn prepared_attachment_pair(factory: &super::NativeProviderDriverFactory) -> Vec<Value> {
        let prepared = factory
            .attachments
            .prepare(vec![
                json!({
                    "type":"image", "id":"image-1", "name":"screen.png", "mimeType":"image/png",
                    "sizeBytes":5, "dataUrl":"data:image/png;base64,aW1hZ2U="
                }),
                json!({
                    "type":"file", "id":"notes-1", "name":"notes<&.txt", "mimeType":"text/plain",
                    "sizeBytes":5, "dataUrl":"data:text/plain;base64,bm90ZXM="
                }),
            ])
            .await
            .expect("attachment pair should prepare");
        let attachments = prepared.attachments().to_vec();
        prepared.commit();
        attachments
    }

    async fn live_claims(
        registry: &ProcessAttributionRegistry,
    ) -> Vec<crate::diagnostics::ProcessClaim> {
        let rows = NativeProcessSampler::default()
            .sample()
            .await
            .expect("native process sample");
        registry.bind_and_snapshot(&rows, Instant::now())
    }

    #[tokio::test]
    async fn activity_cancellation_dispatch_fails_closed_without_queueing_provider_io() {
        let controls = ActivityControlRegistry::new();
        let scope = ActivityScopeRef::Thread {
            thread_id: "thread-activity-cancel".to_owned(),
        };
        let scope_id = "thread:activity-cancel".to_owned();
        let registration = controls.register_runtime(scope.clone(), scope_id.clone(), None);
        controls
            .observe_provider_batch(
                &registration,
                &[ProviderActivityMutation::upsert_actor(
                    "actor:activity-cancel",
                    None,
                    "Activity cancel",
                    "running",
                )
                .expect("actor mutation")],
                &[ProviderActivityControlUpdate::ActorTarget {
                    actor_id: "actor:activity-cancel".to_owned(),
                    target: Some(ProviderActivityNativeTarget::ClaudeTask {
                        task_id: "native-task".to_owned(),
                    }),
                }],
            )
            .await;
        let capture = GenerationCapture::default();
        let cancellation = ActivityCancellationService::new(controls, Arc::new(capture.clone()));
        cancellation
            .cancel_subtree(scope.clone(), &scope_id, "actor:activity-cancel", 1)
            .await
            .expect("capture runtime generation");
        let generation = capture
            .0
            .lock()
            .expect("generation capture")
            .clone()
            .expect("captured runtime generation");

        let (sender, mut queued_messages) = mpsc::channel(4);
        let supervisor = super::ProviderRuntimeSupervisor {
            sender,
            stopped: tokio_util::sync::CancellationToken::new(),
            worker: Arc::new(tokio::sync::Mutex::new(None)),
            connect_mcp: Arc::new(tokio::sync::RwLock::new(None)),
            activity_cancellation: Arc::new(tokio::sync::RwLock::new(None)),
        };

        for target in [
            ProviderActivityNativeTarget::CodexTurn {
                thread_id: "native-thread".to_owned(),
                turn_id: "native-turn".to_owned(),
            },
            ProviderActivityNativeTarget::ClaudeTask {
                task_id: "native-task".to_owned(),
            },
        ] {
            let result = timeout(
                std::time::Duration::from_millis(20),
                supervisor.cancel_target(scope.clone(), generation.clone(), target),
            )
            .await;
            let queued = queued_messages.try_recv().is_ok();
            assert!(
                !queued,
                "polling and dropping native activity cancellation queued provider I/O"
            );
            assert_eq!(
                result,
                Ok(Err(ActivityDispatchError::TargetUnavailable)),
                "native activity cancellation must fail closed immediately"
            );
        }

        let dropped = supervisor.cancel_target(
            scope,
            generation,
            ProviderActivityNativeTarget::CodexTurn {
                thread_id: "native-thread-dropped".to_owned(),
                turn_id: "native-turn-dropped".to_owned(),
            },
        );
        drop(dropped);
        assert!(
            queued_messages.try_recv().is_err(),
            "dropping an unpolled cancellation future queued provider I/O"
        );
    }

    #[tokio::test]
    async fn native_factory_attributes_provider_until_child_exit() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let registry = ProcessAttributionRegistry::new();
        let factory = super::NativeProviderDriverFactory::with_process_attribution(
            temp.path().join("attachments"),
            registry.clone(),
        );
        let fixture = executable_fixture(&temp, "attributed-claude", CLAUDE_FIXTURE);
        let mut request = native_launch(&temp, "claudeAgent");
        request.provider_label = "Configured Claude".to_owned();
        request.binary_path = fixture.to_string_lossy().into_owned();

        let driver = factory
            .create(request)
            .await
            .expect("native provider should spawn");
        let claims = live_claims(&registry).await;
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].scope, AttributionScope::External);
        assert_eq!(claims[0].kind, AttributionKind::Provider);
        assert_eq!(claims[0].label, "Configured Claude");

        driver.shutdown().await.expect("provider should shut down");
        assert!(live_claims(&registry).await.is_empty());
    }

    #[tokio::test]
    async fn supervisor_launch_rejects_grok_before_creating_a_driver() {
        let engine = supervisor_engine().await;
        let state = Arc::new(StdMutex::new(SupervisorDriverState::default()));
        let (_, events) = mpsc::channel(1);
        let supervisor = super::ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(SupervisorFactory {
                state: state.clone(),
                events: StdMutex::new(Some(events)),
            }),
            super::ActivityProjection::new(crate::activity::ActivityRepository::new(
                engine.repositories().database().clone(),
            )),
            super::SupervisorOptions::default(),
        );
        let temp = TempDir::new().unwrap();

        assert!(matches!(
            supervisor.launch(native_launch(&temp, "grok")).await,
            Err(super::ProviderRuntimeError::UnsupportedProvider { provider }) if provider == "grok"
        ));
        assert_eq!(state.lock().unwrap().launches, 0);

        supervisor.shutdown().await.unwrap();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn delivery_send_does_not_block_supervisor_control_messages() {
        let engine = supervisor_engine().await;
        let gate = Arc::new(tokio::sync::Notify::new());
        let state = Arc::new(StdMutex::new(SupervisorDriverState {
            send_gate: Some(gate.clone()),
            ..SupervisorDriverState::default()
        }));
        let (_, events) = mpsc::channel(1);
        let supervisor = super::ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(SupervisorFactory {
                state: state.clone(),
                events: StdMutex::new(Some(events)),
            }),
            super::ActivityProjection::new(crate::activity::ActivityRepository::new(
                engine.repositories().database().clone(),
            )),
            super::SupervisorOptions::default(),
        );
        let temp = TempDir::new().unwrap();
        let mut request = native_launch(&temp, "codex");
        request.thread_id = "t1".to_owned();
        supervisor.launch(request).await.unwrap();
        let command: OrchestrationCommand = serde_json::from_value(json!({
            "type":"thread.turn.start", "commandId":"delivery", "threadId":"t1",
            "message":{"messageId":"message","role":"user","text":"hello","attachments":[]},
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "runtimeMode":"full-access", "interactionMode":"default",
            "createdAt":"2026-07-16T00:00:00Z"
        }))
        .unwrap();

        let handle = supervisor
            .deliver_turn(command, "delivery-1".to_owned())
            .await
            .unwrap();
        timeout(
            std::time::Duration::from_millis(100),
            supervisor.handle_orchestration(
                serde_json::from_value(json!({
                    "type":"thread.approval.respond", "commandId":"approval",
                    "threadId":"t1", "requestId":"request-1",
                    "decision":"accept", "createdAt":"2026-07-16T00:00:00Z"
                }))
                .unwrap(),
            ),
        )
        .await
        .expect("approval remains responsive")
        .unwrap();
        assert_eq!(state.lock().unwrap().approvals, 1);

        gate.notify_one();
        assert_eq!(
            handle.completion().await,
            super::ProviderDeliveryOutcome::Accepted {
                turn_id: Some("unit-turn".to_owned())
            }
        );
        supervisor.shutdown().await.unwrap();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn completed_idle_session_is_suspended_without_losing_resume_state() {
        let engine = supervisor_engine().await;
        let state = Arc::new(StdMutex::new(SupervisorDriverState::default()));
        let (events_tx, events_rx) = mpsc::channel(2);
        let supervisor = super::ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(SupervisorFactory {
                state: state.clone(),
                events: StdMutex::new(Some(events_rx)),
            }),
            super::ActivityProjection::new(crate::activity::ActivityRepository::new(
                engine.repositories().database().clone(),
            )),
            super::SupervisorOptions {
                queue_capacity: 2,
                session_idle_timeout: std::time::Duration::from_millis(100),
            },
        );
        let temp = TempDir::new().unwrap();
        let mut request = native_launch(&temp, "codex");
        request.thread_id = "t1".to_owned();
        supervisor.launch(request).await.unwrap();

        for (event_type, payload) in [
            (
                "content.delta",
                json!({"messageId":"assistant-idle","delta":"OK"}),
            ),
            (
                "turn.completed",
                json!({"messageId":"assistant-idle","state":"completed"}),
            ),
        ] {
            events_tx
                .send(super::ProviderEvent {
                    native_event_id: None,
                    event_type: event_type.to_owned(),
                    thread_id: "t1".to_owned(),
                    turn_id: Some("unit-turn".to_owned()),
                    request_id: None,
                    payload,
                    activity: Vec::new(),
                })
                .await
                .unwrap();
        }

        for _ in 0..100 {
            let projected = load_snapshot(&engine.repositories())
                .await
                .unwrap()
                .messages
                .iter()
                .any(|message| message.message_id == "assistant-idle" && !message.is_streaming);
            if projected {
                break;
            }
            tokio::task::yield_now().await;
        }
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        let follow_up: OrchestrationCommand = serde_json::from_value(json!({
            "type":"thread.turn.start", "commandId":"follow-up", "threadId":"t1",
            "message":{"messageId":"user-follow-up","role":"user","text":"next","attachments":[]},
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "runtimeMode":"full-access", "interactionMode":"default",
            "createdAt":"2026-07-16T00:00:01Z"
        }))
        .unwrap();
        supervisor.handle_orchestration(follow_up).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(state.lock().unwrap().shutdowns, 0);

        for (event_type, payload) in [
            (
                "content.delta",
                json!({"messageId":"assistant-follow-up","delta":"OK"}),
            ),
            (
                "turn.completed",
                json!({"messageId":"assistant-follow-up","state":"completed"}),
            ),
        ] {
            events_tx
                .send(super::ProviderEvent {
                    native_event_id: None,
                    event_type: event_type.to_owned(),
                    thread_id: "t1".to_owned(),
                    turn_id: Some("unit-turn-follow-up".to_owned()),
                    request_id: None,
                    payload,
                    activity: Vec::new(),
                })
                .await
                .unwrap();
        }
        for _ in 0..100 {
            let projected = load_snapshot(&engine.repositories())
                .await
                .unwrap()
                .messages
                .iter()
                .any(|message| {
                    message.message_id == "assistant-follow-up" && !message.is_streaming
                });
            if projected {
                break;
            }
            tokio::task::yield_now().await;
        }
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        timeout(std::time::Duration::from_secs(1), async {
            loop {
                if state.lock().unwrap().shutdowns == 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("idle provider is suspended");

        let runtime = engine
            .repositories()
            .get_provider_session_runtime("t1".to_owned())
            .await
            .unwrap()
            .expect("resume state is retained");
        assert_eq!(runtime.status, "suspended");
        assert_eq!(
            runtime.resume_cursor,
            Some(json!({"threadId":"unit-session"}))
        );

        let stop: OrchestrationCommand = serde_json::from_value(json!({
            "type":"thread.session.stop", "commandId":"stop-idle", "threadId":"t1",
            "createdAt":"2026-07-16T00:00:02Z"
        }))
        .unwrap();
        supervisor.handle_orchestration(stop).await.unwrap();
        assert!(
            engine
                .repositories()
                .get_provider_session_runtime("t1".to_owned())
                .await
                .unwrap()
                .is_none(),
            "stopping a suspended session removes its resume state"
        );
        assert_eq!(state.lock().unwrap().shutdowns, 1);

        supervisor.shutdown().await.unwrap();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn stale_delivery_completion_cannot_clear_the_active_attempt_generation() {
        let engine = supervisor_engine().await;
        let gate = Arc::new(tokio::sync::Notify::new());
        let state = Arc::new(StdMutex::new(SupervisorDriverState {
            send_gate: Some(gate.clone()),
            ..SupervisorDriverState::default()
        }));
        let (_, events) = mpsc::channel(1);
        let supervisor = super::ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(SupervisorFactory {
                state: state.clone(),
                events: StdMutex::new(Some(events)),
            }),
            super::ActivityProjection::new(crate::activity::ActivityRepository::new(
                engine.repositories().database().clone(),
            )),
            super::SupervisorOptions::default(),
        );
        let temp = TempDir::new().unwrap();
        let mut request = native_launch(&temp, "codex");
        request.thread_id = "t1".to_owned();
        request.model = Some("gpt-5".to_owned());
        supervisor.launch(request).await.unwrap();
        let delivery = supervisor
            .deliver_turn(
                serde_json::from_value(json!({
                    "type":"thread.turn.start", "commandId":"generation-delivery",
                    "threadId":"t1",
                    "message":{"messageId":"generation-message","role":"user","text":"hold","attachments":[]},
                    "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                    "runtimeMode":"full-access", "interactionMode":"default",
                    "createdAt":"2026-07-16T00:00:00Z"
                }))
                .unwrap(),
                "generation-key".to_owned(),
            )
            .await
            .unwrap();
        supervisor
            .sender
            .send(super::SupervisorMessage::DeliveryComplete {
                thread_id: "t1".to_owned(),
                generation: u64::MAX,
                abnormal: false,
            })
            .await
            .unwrap();
        let mut metadata = Box::pin(
            supervisor.handle_orchestration(
                serde_json::from_value(json!({
                    "type":"thread.meta.update", "commandId":"generation-metadata",
                    "threadId":"t1",
                    "modelSelection":{
                        "instanceId":"codex", "model":"gpt-5",
                        "options":[{"id":"fastMode","value":true}]
                    }
                }))
                .unwrap(),
            ),
        );
        assert!(matches!(
            futures_util::poll!(metadata.as_mut()),
            Poll::Pending
        ));
        supervisor
            .handle_orchestration(
                serde_json::from_value(json!({
                    "type":"thread.approval.respond", "commandId":"generation-barrier",
                    "threadId":"t1", "requestId":"generation-request",
                    "decision":"accept", "createdAt":"2026-07-16T00:00:00Z"
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        assert!(matches!(
            futures_util::poll!(metadata.as_mut()),
            Poll::Pending
        ));

        gate.notify_one();
        assert!(matches!(
            delivery.completion().await,
            super::ProviderDeliveryOutcome::Accepted { .. }
        ));
        metadata.await.unwrap();
        assert_eq!(state.lock().unwrap().models, Vec::<String>::new());
        supervisor.shutdown().await.unwrap();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn stale_owned_delivery_cas_conflict_never_calls_the_provider() {
        let engine = supervisor_engine().await;
        let state = Arc::new(StdMutex::new(SupervisorDriverState::default()));
        let (_, events) = mpsc::channel(1);
        let supervisor = super::ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(SupervisorFactory {
                state: state.clone(),
                events: StdMutex::new(Some(events)),
            }),
            super::ActivityProjection::new(crate::activity::ActivityRepository::new(
                engine.repositories().database().clone(),
            )),
            super::SupervisorOptions::default(),
        );
        let temp = TempDir::new().unwrap();
        let mut request = native_launch(&temp, "codex");
        request.thread_id = "t1".to_owned();
        request.model = Some("gpt-5".to_owned());
        let route_fingerprint = super::delivery_route_fingerprint(&request).unwrap();
        supervisor.launch(request).await.unwrap();
        let command: OrchestrationCommand = serde_json::from_value(json!({
            "type":"thread.turn.start", "commandId":"stale-cas", "threadId":"t1",
            "message":{"messageId":"stale-message","role":"user","text":"never send","attachments":[]},
            "modelSelection":{"instanceId":"codex","model":"gpt-5"},
            "runtimeMode":"full-access", "interactionMode":"default",
            "createdAt":"2026-07-16T00:00:00Z"
        }))
        .unwrap();
        let mut payload = serde_json::to_value(&command).unwrap();
        payload[super::DELIVERY_ROUTE_FINGERPRINT_FIELD] = Value::String(route_fingerprint);
        let payload = serde_json::to_string(&payload).unwrap();
        engine
            .repositories()
            .database()
            .call(move |connection| {
                connection.execute(
                    "INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status) VALUES ('stale-cas', 'thread', 't1', '2026-07-16T00:00:00Z', 0, 'accepted')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO provider_turn_outbox (command_id, thread_id, message_id, provider_instance_id, provider_kind, provider_session_id, delivery_key, payload_json, state, attempts, last_error, created_at, updated_at) VALUES ('stale-cas', 't1', 'stale-message', 'codex', 'codex', NULL, 'stale-key', ?, 'sending', 1, NULL, '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')",
                    [payload],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let stale_row = engine
            .repositories()
            .get_provider_turn_delivery("stale-cas".to_owned())
            .await
            .unwrap()
            .unwrap();
        engine
            .repositories()
            .freeze_provider_turn_session(
                "stale-cas".to_owned(),
                1,
                "codex".to_owned(),
                "codex".to_owned(),
                "different-session".to_owned(),
                "2026-07-16T00:00:01Z".to_owned(),
            )
            .await
            .unwrap()
            .expect("authoritative row drifts after the stale task snapshot");

        let outcome = supervisor
            .deliver_frozen_turn(command, stale_row)
            .await
            .unwrap()
            .completion()
            .await;
        assert!(matches!(
            outcome,
            super::ProviderDeliveryOutcome::DefinitelyNotSent { ref detail }
                if detail.contains("session freeze conflicted")
        ));
        assert!(
            state.lock().unwrap().sends.is_empty(),
            "the post-spawn CAS conflict must make zero provider calls"
        );

        supervisor.shutdown().await.unwrap();
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn delivery_reconciliation_does_not_block_supervisor_control_messages() {
        let engine = supervisor_engine().await;
        let gate = Arc::new(tokio::sync::Notify::new());
        let started = Arc::new(tokio::sync::Notify::new());
        let state = Arc::new(StdMutex::new(SupervisorDriverState {
            reconcile_gate: Some(gate.clone()),
            reconcile_started: Some(started.clone()),
            ..SupervisorDriverState::default()
        }));
        let (_, events) = mpsc::channel(1);
        let supervisor = Arc::new(super::ProviderRuntimeSupervisor::start(
            engine.clone(),
            Arc::new(SupervisorFactory {
                state: state.clone(),
                events: StdMutex::new(Some(events)),
            }),
            super::ActivityProjection::new(crate::activity::ActivityRepository::new(
                engine.repositories().database().clone(),
            )),
            super::SupervisorOptions::default(),
        ));
        let temp = TempDir::new().unwrap();
        let mut request = native_launch(&temp, "codex");
        request.thread_id = "t1".to_owned();
        let route_fingerprint = super::delivery_route_fingerprint(&request).unwrap();
        supervisor.launch(request).await.unwrap();
        let mut payload = json!({});
        payload[super::DELIVERY_ROUTE_FINGERPRINT_FIELD] = Value::String(route_fingerprint);
        let reconciliation = {
            let supervisor = supervisor.clone();
            tokio::spawn(async move {
                supervisor
                    .reconcile_turn(crate::orchestration::ProviderTurnDelivery {
                        command_id: "reconcile".to_owned(),
                        thread_id: "t1".to_owned(),
                        message_id: "message".to_owned(),
                        provider_instance_id: "codex".to_owned(),
                        provider_kind: "codex".to_owned(),
                        provider_session_id: None,
                        delivery_key: "delivery-1".to_owned(),
                        payload,
                        state: crate::orchestration::TurnDeliveryState::Sending,
                        attempts: 1,
                        last_error: None,
                        created_at: "2026-07-16T00:00:00Z".to_owned(),
                        updated_at: "2026-07-16T00:00:00Z".to_owned(),
                    })
                    .await
            })
        };
        timeout(std::time::Duration::from_secs(1), started.notified())
            .await
            .expect("reconciliation starts");
        timeout(
            std::time::Duration::from_millis(100),
            supervisor.handle_orchestration(
                serde_json::from_value(json!({
                    "type":"thread.approval.respond", "commandId":"approval-reconcile",
                    "threadId":"t1", "requestId":"request-1",
                    "decision":"accept", "createdAt":"2026-07-16T00:00:00Z"
                }))
                .unwrap(),
            ),
        )
        .await
        .expect("approval remains responsive")
        .unwrap();
        assert_eq!(state.lock().unwrap().approvals, 1);

        gate.notify_one();
        assert_eq!(
            reconciliation.await.unwrap().unwrap(),
            super::ProviderReconciliationOutcome::Found
        );
        supervisor.shutdown().await.unwrap();
        engine.shutdown().await;
    }

    #[test]
    fn provider_kind_resolver_normalizes_aliases_and_rejects_unknown_drivers() {
        assert_eq!(
            super::canonical_provider_kind("claude").expect("claude alias"),
            "claudeAgent"
        );
        assert_eq!(
            super::canonical_provider_kind("codex").expect("codex provider"),
            "codex"
        );
        assert!(matches!(
            super::canonical_provider_kind("unknown"),
            Err(super::ProviderRuntimeError::UnsupportedProvider { provider })
                if provider == "unknown"
        ));
    }

    #[tokio::test]
    async fn provider_route_normalizes_case_variant_path_before_map_collection() {
        let temp = TempDir::new().expect("settings root");
        let mut settings = ProviderSettingsState::default();
        settings.provider_instances.insert(
            "codex-work".to_owned(),
            ProviderInstanceState {
                driver: "codex".to_owned(),
                enabled: true,
                display_name: None,
                environment: vec![
                    ProviderEnvironmentVariableState {
                        name: "pAtH".to_owned(),
                        value: "/first".to_owned(),
                        sensitive: false,
                        value_redacted: false,
                    },
                    ProviderEnvironmentVariableState {
                        name: "PATH".to_owned(),
                        value: "/second".to_owned(),
                        sensitive: false,
                        value_redacted: false,
                    },
                ],
                config: json!({ "binaryPath": "codex" }),
            },
        );
        std::fs::write(
            temp.path().join("settings.json"),
            serde_json::to_vec(&settings).expect("settings JSON"),
        )
        .expect("write settings");

        let route =
            super::resolve_provider_route_settings(&temp.path().to_path_buf(), "codex-work", None)
                .await
                .expect("provider route");

        assert_eq!(
            route.environment,
            std::collections::BTreeMap::from([("PATH".to_owned(), "/first".to_owned())])
        );
    }

    #[test]
    fn dropped_delivery_response_is_ambiguous_but_closed_queue_is_not_sent() {
        assert!(matches!(
            super::delivery_enqueue_failure(super::ProviderRuntimeError::ResponseDropped),
            super::ProviderDeliveryOutcome::Ambiguous { .. }
        ));
        assert!(matches!(
            super::delivery_enqueue_failure(super::ProviderRuntimeError::QueueClosed),
            super::ProviderDeliveryOutcome::DefinitelyNotSent { .. }
        ));
    }

    #[tokio::test]
    async fn consuming_attributed_child_releases_provider_registration() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let registry = ProcessAttributionRegistry::new();
        let fixture = executable_fixture(&temp, "consumed-claude", CLAUDE_FIXTURE);
        let mut request = native_launch(&temp, "claudeAgent");
        request.binary_path = fixture.to_string_lossy().into_owned();
        let child = super::spawn_child(&request, &[], false, registry.clone())
            .expect("provider child should spawn");
        assert_eq!(live_claims(&registry).await.len(), 1);

        let mut inner = child.into_inner();
        assert!(live_claims(&registry).await.is_empty());
        let _ = inner.start_kill();
        let _ = inner.wait().await;
    }

    #[tokio::test]
    async fn unit_supervisor_covers_complete_command_routing_and_shutdown_lifecycle() {
        let engine = supervisor_engine().await;
        let state = Arc::new(StdMutex::new(SupervisorDriverState::default()));
        let (events_tx, events_rx) = mpsc::channel(4);
        let factory = Arc::new(SupervisorFactory {
            state: state.clone(),
            events: StdMutex::new(Some(events_rx)),
        });
        let supervisor = super::ProviderRuntimeSupervisor::start(
            engine.clone(),
            factory,
            super::ActivityProjection::new(crate::activity::ActivityRepository::new(
                engine.repositories().database().clone(),
            )),
            super::SupervisorOptions::default(),
        );
        let temp = TempDir::new().unwrap();
        let settings_root = temp.path().join("settings");
        std::fs::create_dir(&settings_root).unwrap();
        let mut settings = ProviderSettingsState::default();
        settings.provider_instances.insert(
            "codex-custom".to_owned(),
            ProviderInstanceState {
                driver: "codex".to_owned(),
                enabled: true,
                display_name: Some("Custom Codex".to_owned()),
                environment: vec![
                    ProviderEnvironmentVariableState {
                        name: "UNIT_ENV".to_owned(),
                        value: "enabled".to_owned(),
                        sensitive: false,
                        value_redacted: false,
                    },
                    ProviderEnvironmentVariableState {
                        name: String::new(),
                        value: "ignored".to_owned(),
                        sensitive: false,
                        value_redacted: false,
                    },
                ],
                config: json!({
                    "binaryPath": "/bin/sh",
                    "serverUrl": "http://127.0.0.1:4773",
                    "serverPassword": "fixture-password",
                    "homePath": temp.path().join("shared-home"),
                    "shadowHomePath": temp.path().join("shadow-home")
                }),
            },
        );
        std::fs::write(
            settings_root.join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        let launch_command = serde_json::from_value(json!({
            "type":"thread.turn.start",
            "commandId":"launch-options",
            "threadId":"t1",
            "message":{"messageId":"launch-message","role":"user","text":"launch","attachments":[]},
            "modelSelection":{
                "instanceId":"codex-custom",
                "model":"gpt-5.2",
                "options":[
                    {"id":"serviceTier","value":"fast"},
                    {"id":"reasoningEffort","value":"high"},
                    {"id":"agent","value":"reviewer"}
                ]
            },
            "runtimeMode":"full-access",
            "interactionMode":"plan",
            "createdAt":"2026-07-16T00:00:00Z"
        }))
        .unwrap();
        let missing_thread_command = serde_json::from_value(json!({
            "type":"thread.turn.start",
            "commandId":"missing-launch",
            "threadId":"missing",
            "message":{"messageId":"missing-message","role":"user","text":"launch","attachments":[]},
            "modelSelection":{"instanceId":"codex-custom","model":"gpt-5.2"},
            "runtimeMode":"full-access",
            "interactionMode":"plan",
            "createdAt":"2026-07-16T00:00:00Z"
        }))
        .unwrap();
        assert!(matches!(
            super::launch_request_for_command(
                &engine,
                &settings_root,
                &missing_thread_command,
                None
            )
            .await,
            Err(super::ProviderRuntimeError::SessionNotFound { .. })
        ));
        let blocked_settings_root = temp.path().join("blocked-settings");
        std::fs::write(&blocked_settings_root, "not a directory").unwrap();
        assert!(
            super::launch_request_for_command(
                &engine,
                &blocked_settings_root,
                &launch_command,
                None
            )
            .await
            .is_err()
        );
        engine
            .repositories()
            .upsert_provider_session_runtime(ProviderSessionRuntime {
                thread_id: "t1".to_owned(),
                provider_name: "claudeAgent".to_owned(),
                provider_instance_id: Some("other-instance".to_owned()),
                adapter_key: "unit".to_owned(),
                runtime_mode: "full-access".to_owned(),
                status: "running".to_owned(),
                last_seen_at: "2026-07-16T00:00:00Z".to_owned(),
                resume_cursor: Some(json!({"threadId":"ignored"})),
                runtime_payload: None,
            })
            .await
            .unwrap();
        let resolved_launch =
            super::launch_request_for_command(&engine, &settings_root, &launch_command, None)
                .await
                .unwrap();
        assert_eq!(
            resolved_launch.provider_instance_id.as_deref(),
            Some("codex-custom")
        );
        assert_eq!(resolved_launch.provider_label, "Custom Codex");
        assert_eq!(
            resolved_launch.environment.get("UNIT_ENV"),
            Some(&"enabled".to_owned())
        );
        assert_eq!(resolved_launch.service_tier.as_deref(), Some("fast"));
        assert_eq!(resolved_launch.effort.as_deref(), Some("high"));
        assert_eq!(resolved_launch.agent.as_deref(), Some("reviewer"));
        assert_eq!(
            resolved_launch.endpoint.as_deref(),
            Some("http://127.0.0.1:4773")
        );
        assert_eq!(
            resolved_launch.server_password.as_deref(),
            Some("fixture-password")
        );
        assert!(resolved_launch.codex_home.is_some());
        assert!(resolved_launch.resume_cursor.is_none());
        settings
            .provider_instances
            .get_mut("codex-custom")
            .unwrap()
            .display_name = Some("   ".to_owned());
        std::fs::write(
            settings_root.join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        assert_eq!(
            super::launch_request_for_command(&engine, &settings_root, &launch_command, None)
                .await
                .unwrap()
                .provider_label,
            "codex"
        );
        engine
            .repositories()
            .upsert_provider_session_runtime(ProviderSessionRuntime {
                thread_id: "t1".to_owned(),
                provider_name: "codex".to_owned(),
                provider_instance_id: Some("codex-custom".to_owned()),
                adapter_key: "unit".to_owned(),
                runtime_mode: "full-access".to_owned(),
                status: "running".to_owned(),
                last_seen_at: "2026-07-16T00:00:01Z".to_owned(),
                resume_cursor: Some(json!({"threadId":"resume-unit"})),
                runtime_payload: None,
            })
            .await
            .unwrap();
        assert_eq!(
            super::launch_request_for_command(&engine, &settings_root, &launch_command, None)
                .await
                .unwrap()
                .resume_cursor,
            Some(json!({"threadId":"resume-unit"}))
        );

        let mut launch = native_launch(&temp, "codex");
        launch.thread_id = "t1".to_owned();
        launch.cwd = temp.path().to_path_buf();
        supervisor.launch(launch.clone()).await.unwrap();
        assert!(matches!(
            supervisor.launch(launch).await,
            Err(super::ProviderRuntimeError::SessionAlreadyExists { .. })
        ));

        for command in [
            json!({"type":"thread.turn.start","commandId":"turn","threadId":"t1","message":{"messageId":"m1","role":"user","text":"hello","attachments":[]},"modelSelection":{"instanceId":"codex","model":"gpt-5.1"},"runtimeMode":"full-access","interactionMode":"default","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.turn.interrupt","commandId":"interrupt","threadId":"t1","turnId":"unit-turn","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.approval.respond","commandId":"approve","threadId":"t1","requestId":"r1","decision":"accept","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.user-input.respond","commandId":"answer","threadId":"t1","requestId":"r2","answers":{"q":"a"},"createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.runtime-mode.set","commandId":"mode","threadId":"t1","runtimeMode":"approval-required","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.interaction-mode.set","commandId":"interaction","threadId":"t1","interactionMode":"plan","createdAt":"2026-07-16T00:00:00Z"}),
            json!({"type":"thread.meta.update","commandId":"model","threadId":"t1","modelSelection":{"instanceId":"codex","model":"gpt-5.2"}}),
            json!({"type":"thread.checkpoint.revert","commandId":"revert","threadId":"t1","turnCount":2,"createdAt":"2026-07-16T00:00:00Z"}),
        ] {
            supervisor
                .handle_orchestration(serde_json::from_value(command).unwrap())
                .await
                .unwrap();
        }

        let project_command: OrchestrationCommand = serde_json::from_value(json!({
            "type":"project.create","commandId":"unsupported","projectId":"p2","title":"Project","workspaceRoot":"/tmp/p2","createdAt":"2026-07-16T00:00:00Z"
        }))
        .unwrap();
        assert!(
            supervisor
                .handle_orchestration(project_command)
                .await
                .is_err()
        );
        assert!(
            supervisor
                .handle_orchestration(
                    serde_json::from_value(json!({"type":"thread.turn.interrupt","commandId":"missing","threadId":"missing","turnId":null,"createdAt":"2026-07-16T00:00:00Z"})).unwrap(),
                )
                .await
                .is_err()
        );
        supervisor
            .handle_orchestration(
                serde_json::from_value(json!({"type":"thread.session.stop","commandId":"stop","threadId":"t1","createdAt":"2026-07-16T00:00:00Z"})).unwrap(),
            )
            .await
            .unwrap();
        drop(events_tx);
        supervisor.shutdown().await.unwrap();
        supervisor.shutdown().await.unwrap();
        assert!(matches!(
            supervisor
                .handle_orchestration(
                    serde_json::from_value(json!({"type":"thread.session.stop","commandId":"late","threadId":"t1","createdAt":"2026-07-16T00:00:00Z"})).unwrap(),
                )
                .await,
            Err(super::ProviderRuntimeError::Shutdown)
        ));

        {
            let state = state.lock().unwrap();
            assert_eq!(state.launches, 1);
            assert_eq!(state.starts, 1);
            assert_eq!(state.sends, ["hello"]);
            assert_eq!(state.interrupts, 1);
            assert_eq!(state.approvals, 1);
            assert_eq!(state.answers, 1);
            assert_eq!(state.modes, ["approval-required"]);
            assert_eq!(state.interaction_modes, ["plan"]);
            assert_eq!(state.models, ["gpt-5.1", "gpt-5.2"]);
            assert_eq!(state.rollbacks, [2]);
            assert_eq!(state.shutdowns, 1);
        }
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn native_process_adapters_cover_live_codex_claude_cursor_and_grok_commands() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = TempDir::new().expect("provider fixture directory");
        let attachment_root = temp.path().join("state&").join("attachments");
        let factory = super::NativeProviderDriverFactory::new(attachment_root.clone());
        let attachments = prepared_attachment_pair(&factory).await;
        let capture_path = temp.path().join("provider-requests.jsonl");
        let capture_value = capture_path.to_string_lossy().into_owned();
        let notes_path = std::fs::canonicalize(attachment_root.join("notes-1"))
            .expect("prepared file path should canonicalize");
        let escaped_notes_path = notes_path
            .to_str()
            .expect("test path should be Unicode")
            .replace('&', "&amp;");
        let expected_text = format!(
            "hello\n<attached_files>\n- notes&lt;&amp;.txt: {escaped_notes_path}\n</attached_files>"
        );

        let claude_fixture = executable_fixture(&temp, "claude-fixture", CLAUDE_FIXTURE);
        let mut claude_request = native_launch(&temp, "claudeAgent");
        claude_request.binary_path = claude_fixture.to_string_lossy().into_owned();
        claude_request.model = Some("claude-sonnet".to_owned());
        claude_request.agent = Some("reviewer".to_owned());
        claude_request.resume_cursor = Some(json!({"sessionId":"claude-session"}));
        claude_request.environment.insert(
            "BIBCODE_TEST_REQUEST_CAPTURE".to_owned(),
            capture_value.clone(),
        );
        let claude = super::ClaudeDriver::spawn(
            claude_request,
            factory.attachments.clone(),
            factory.attribution.clone(),
            true,
        )
        .await
        .expect("Claude driver should create");
        assert_eq!(
            claude
                .start()
                .await
                .expect("Claude should start")
                .resume_cursor,
            Some(json!({"sessionId":"claude-session"})),
        );
        assert!(
            claude
                .send(
                    "hello".to_owned(),
                    attachments.clone(),
                    "default".to_owned(),
                )
                .await
                .expect("Claude turn should send")
                .is_some()
        );
        let claude_user = captured_request(&capture_path, |request| {
            request["type"] == "user" && request["session_id"] == "claude-session"
        })
        .await;
        assert_eq!(
            claude_user["message"],
            json!({
                "role":"user",
                "content":[
                    {"type":"text", "text":expected_text},
                    {"type":"image", "source":{
                        "type":"base64", "media_type":"image/png", "data":"aW1hZ2U="
                    }}
                ]
            })
        );
        claude
            .interrupt(None)
            .await
            .expect("Claude should interrupt");
        claude
            .approve("approval-1".to_owned(), "acceptForSession".to_owned())
            .await
            .expect("Claude approval should resolve");
        claude
            .approve("approval-2".to_owned(), "deny".to_owned())
            .await
            .expect("Claude denial should resolve");
        claude.runtime.lock().await.open_user_input_request(
            crate::provider::claude::UserInputRequestInput {
                tool_name: "AskUserQuestion".to_owned(),
                input: json!({"questions":[{"question":"Continue?"}]}),
                tool_use_id: "tool-1".to_owned(),
            },
            "question-1",
        );
        claude
            .answer("question-1".to_owned(), json!({"answer":"yes"}))
            .await
            .expect("Claude user input should resolve");
        claude
            .set_mode("auto-accept-edits".to_owned())
            .await
            .expect("Claude mode should update");
        claude
            .set_interaction_mode("plan".to_owned())
            .await
            .expect("Claude interaction mode should update");
        assert!(claude.set_model("other".to_owned()).await.is_err());
        assert!(claude.rollback(1).await.is_err());
        assert_eq!(
            timeout(std::time::Duration::from_secs(2), claude.next_event())
                .await
                .expect("Claude event timeout")
                .expect("Claude stderr event")
                .event_type,
            "session.stderr",
        );
        claude.shutdown().await.expect("Claude should shut down");

        let mut fresh_claude_request = native_launch(&temp, "claudeAgent");
        fresh_claude_request.binary_path = claude_fixture.to_string_lossy().into_owned();
        let fresh_claude = super::ClaudeDriver::spawn(
            fresh_claude_request,
            factory.attachments.clone(),
            factory.attribution.clone(),
            true,
        )
        .await
        .expect("fresh Claude driver should create");
        fresh_claude
            .shutdown()
            .await
            .expect("fresh Claude should shut down");

        let codex_fixture = executable_fixture(&temp, "codex-fixture", CODEX_FIXTURE);
        let mut codex_request = native_launch(&temp, "codex");
        codex_request.binary_path = codex_fixture.to_string_lossy().into_owned();
        codex_request.environment.insert(
            "BIBCODE_TEST_REQUEST_CAPTURE".to_owned(),
            capture_value.clone(),
        );
        let codex = factory
            .create(codex_request)
            .await
            .expect("Codex driver should create");
        assert_eq!(
            timeout(std::time::Duration::from_secs(2), codex.start())
                .await
                .expect("Codex start timeout")
                .expect("Codex should start")
                .resume_cursor,
            Some(json!({"threadId":"native-codex-thread"})),
        );
        assert!(
            !timeout(std::time::Duration::from_secs(2), codex.next_event())
                .await
                .expect("Codex event timeout")
                .expect("Codex startup event")
                .event_type
                .is_empty()
        );
        codex
            .set_interaction_mode("plan".to_owned())
            .await
            .expect("Codex default interaction mode should be accepted");
        assert!(
            codex
                .send(
                    "hello".to_owned(),
                    attachments.clone(),
                    "default".to_owned(),
                )
                .await
                .expect("Codex turn should send")
                .is_some()
        );
        let codex_turn =
            captured_request(&capture_path, |request| request["method"] == "turn/start").await;
        assert_eq!(
            codex_turn["params"]["input"],
            json!([
                {"type":"text", "text":expected_text},
                {"type":"image", "url":"data:image/png;base64,aW1hZ2U="}
            ])
        );
        assert!(
            codex
                .send(
                    "/goal finish coverage".to_owned(),
                    Vec::new(),
                    "default".to_owned(),
                )
                .await
                .expect("Codex goal should send")
                .is_some()
        );
        codex.interrupt(None).await.expect("Codex should interrupt");
        codex.rollback(0).await.expect("Codex should roll back");
        assert!(codex.rollback(-1).await.is_err());
        assert!(
            codex
                .set_mode("approval-required".to_owned())
                .await
                .is_err()
        );
        assert!(codex.set_model("other".to_owned()).await.is_err());
        assert!(
            codex
                .approve("unknown".to_owned(), "accept".to_owned())
                .await
                .is_err()
        );
        assert!(codex.answer("unknown".to_owned(), json!({})).await.is_err());
        codex.shutdown().await.expect("Codex should shut down");

        let acp_fixture = executable_fixture(&temp, "acp-fixture", ACP_FIXTURE);
        for provider in ["cursor", "grok"] {
            let mut request = native_launch(&temp, provider);
            request.binary_path = acp_fixture.to_string_lossy().into_owned();
            request.environment.insert(
                "BIBCODE_TEST_REQUEST_CAPTURE".to_owned(),
                capture_value.clone(),
            );
            if provider == "grok" {
                request
                    .environment
                    .insert("XAI_API_KEY".to_owned(), "unit-key".to_owned());
            }
            let driver = factory
                .create(request)
                .await
                .expect("ACP driver should create");
            assert!(
                driver
                    .start()
                    .await
                    .expect("ACP driver should start")
                    .resume_cursor
                    .is_some()
            );
            assert!(
                !timeout(std::time::Duration::from_secs(2), driver.next_event())
                    .await
                    .expect("ACP event timeout")
                    .expect("ACP startup event")
                    .event_type
                    .is_empty()
            );
            let turn = driver
                .send(
                    "hello".to_owned(),
                    attachments.clone(),
                    "default".to_owned(),
                )
                .await
                .expect("ACP turn should send")
                .expect("ACP turn id");
            let session_id = if provider == "cursor" {
                "cursor-session"
            } else {
                "grok-session"
            };
            let prompt = captured_request(&capture_path, |request| {
                request["method"] == "session/prompt"
                    && request["params"]["sessionId"] == session_id
            })
            .await;
            assert_eq!(
                prompt["params"]["prompt"],
                json!([
                    {"type":"text", "text":expected_text},
                    {"type":"image", "data":"aW1hZ2U=", "mimeType":"image/png"}
                ]),
                "{provider} must retain the image and reference the ordinary file"
            );
            driver
                .interrupt(Some(turn))
                .await
                .expect("ACP turn should interrupt");
            driver
                .set_model("updated-model".to_owned())
                .await
                .expect("ACP model should update");
            driver
                .set_mode("full-access".to_owned())
                .await
                .expect("ACP mode should update");
            driver
                .set_interaction_mode("plan".to_owned())
                .await
                .expect("ACP interaction mode should update");
            assert!(driver.rollback(1).await.is_err());
            assert!(
                driver
                    .approve("unknown".to_owned(), "accept".to_owned())
                    .await
                    .is_err()
            );
            assert!(
                driver
                    .answer("unknown".to_owned(), json!({}))
                    .await
                    .is_err()
            );
            driver
                .shutdown()
                .await
                .expect("ACP driver should shut down");
        }
    }

    #[tokio::test]
    async fn native_opencode_adapter_covers_live_session_turn_and_control_commands() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let prompt_body = Arc::new(StdMutex::new(None::<Value>));
        let app = Router::new()
            .route(
                "/session",
                post(|| async { Json(json!({"id":"native-opencode-session"})) }),
            )
            .route("/event", get(|| async { "" }))
            .route(
                "/session/{session_id}/prompt_async",
                post({
                    let prompt_body = prompt_body.clone();
                    move |Json(body): Json<Value>| {
                        let prompt_body = prompt_body.clone();
                        async move {
                            *prompt_body.lock().unwrap() = Some(body);
                            Json(json!({}))
                        }
                    }
                }),
            )
            .route(
                "/session/{session_id}/command",
                post(|| async { Json(json!({})) }),
            )
            .route(
                "/session/{session_id}/abort",
                post(|| async { Json(json!({})) }),
            )
            .route(
                "/session/{session_id}/message",
                get(|| async { Json(json!({"data":[]})) }),
            )
            .route(
                "/session/{session_id}/revert",
                post(|| async { Json(json!({})) }),
            );
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("OpenCode fixture should bind");
        let address = listener.local_addr().expect("OpenCode fixture address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("OpenCode fixture should serve");
        });

        let temp = TempDir::new().expect("OpenCode fixture directory");
        #[cfg(windows)]
        let endpoint_child = tokio::process::Command::new("cmd.exe")
            .args(["/d", "/s", "/c", "ping -n 3 127.0.0.1 >NUL"])
            .spawn()
            .expect("endpoint child should spawn");
        #[cfg(not(windows))]
        let endpoint_child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 2"])
            .spawn()
            .expect("endpoint child should spawn");
        let endpoint_child: Box<dyn process_wrap::tokio::ChildWrapper> = Box::new(endpoint_child);
        let endpoint_child = Arc::new(tokio::sync::Mutex::new(endpoint_child));
        super::wait_for_endpoint(&format!("http://{address}"), &endpoint_child)
            .await
            .expect("live endpoint should become ready");
        super::kill_child(&endpoint_child).await;
        let attachment_root = temp.path().join("state&").join("attachments");
        let factory = super::NativeProviderDriverFactory::new(attachment_root.clone());
        let attachments = prepared_attachment_pair(&factory).await;
        let mut request = native_launch(&temp, "opencode");
        request.endpoint = Some(format!("http://{address}"));
        request.server_password = Some("secret".to_owned());
        request.agent = Some("reviewer".to_owned());
        request.model = Some("openai/gpt-5".to_owned());
        let driver = factory
            .create(request)
            .await
            .expect("OpenCode driver should create");
        assert_eq!(
            driver
                .start()
                .await
                .expect("OpenCode should start")
                .resume_cursor,
            Some(json!({"sessionId":"native-opencode-session"})),
        );
        driver
            .set_interaction_mode("plan".to_owned())
            .await
            .expect("OpenCode default interaction mode should be accepted");
        assert!(
            driver
                .send("hello".to_owned(), attachments, "default".to_owned())
                .await
                .expect("OpenCode turn should send")
                .is_some()
        );
        let image_url = url::Url::from_file_path(
            std::fs::canonicalize(attachment_root.join("image-1"))
                .expect("prepared image path should canonicalize"),
        )
        .expect("prepared image should have a file URL")
        .to_string();
        let notes_url = url::Url::from_file_path(
            std::fs::canonicalize(attachment_root.join("notes-1"))
                .expect("prepared file path should canonicalize"),
        )
        .expect("prepared file should have a file URL")
        .to_string();
        assert_eq!(
            prompt_body
                .lock()
                .unwrap()
                .clone()
                .expect("OpenCode prompt body should be captured"),
            json!({
                "sessionID":"native-opencode-session",
                "parts":[
                    {"type":"text", "text":"hello"},
                    {"type":"file", "mime":"image/png", "url":image_url, "filename":"screen.png"},
                    {"type":"file", "mime":"text/plain", "url":notes_url, "filename":"notes<&.txt"}
                ],
                "model":{"providerID":"openai", "modelID":"gpt-5"},
                "agent":"reviewer"
            })
        );
        assert!(
            driver
                .send(
                    "/review src/provider".to_owned(),
                    Vec::new(),
                    "default".to_owned(),
                )
                .await
                .expect("OpenCode command should send")
                .is_some()
        );
        driver
            .interrupt(None)
            .await
            .expect("OpenCode should interrupt");
        driver
            .set_model("openai/gpt-5.4".to_owned())
            .await
            .expect("OpenCode model should update");
        driver.rollback(0).await.expect("OpenCode should roll back");
        assert!(driver.rollback(-1).await.is_err());
        assert!(driver.set_mode("full-access".to_owned()).await.is_err());
        assert!(
            driver
                .approve("unknown".to_owned(), "accept".to_owned())
                .await
                .is_err()
        );
        assert!(
            driver
                .answer("unknown".to_owned(), json!({}))
                .await
                .is_err()
        );
        assert_eq!(
            timeout(std::time::Duration::from_secs(2), driver.next_event())
                .await
                .expect("OpenCode event timeout")
                .expect("OpenCode event")
                .event_type,
            "session.started",
        );
        driver.shutdown().await.expect("OpenCode should shut down");
        server.abort();
    }

    #[test]
    fn automatic_model_selection_uses_the_provider_default() {
        assert_eq!(super::model_from_selection(&json!({"model":"auto"})), None);
        assert_eq!(
            super::model_from_selection(&json!({"model":"gpt-5.4"})),
            Some("gpt-5.4".to_owned())
        );
    }

    #[test]
    fn provider_string_options_are_extracted_from_canonical_selections() {
        let selection = json!({
            "model": "gpt-5.4",
            "options": [
                { "id": "reasoningEffort", "value": "high" },
                { "id": "serviceTier", "value": "fast" }
            ]
        });
        let options = super::selection_options(&selection);
        let service_tier = |selection: Value| {
            super::selection_string_option_from(
                &super::selection_options(&selection),
                "serviceTier",
            )
        };

        assert_eq!(
            super::selection_string_option_from(&options, "reasoningEffort"),
            Some("high".to_owned())
        );
        assert_eq!(
            super::selection_string_option_from(&options, "serviceTier"),
            Some("fast".to_owned())
        );
        assert_eq!(
            service_tier(json!({"options":[{"id":"serviceTier","value":"  "}]})),
            None
        );
        assert_eq!(
            service_tier(json!({"options":[{"id":"serviceTier","value":42}]})),
            None
        );
        assert_eq!(service_tier(json!({"options":[]})), None);
        assert_eq!(service_tier(json!({"options":{}})), None);
    }

    #[test]
    fn provider_commands_are_parsed_without_stealing_plain_or_malformed_text() {
        assert_eq!(super::parse_provider_command("hello"), None);
        assert_eq!(super::parse_provider_command("/"), None);
        assert_eq!(super::parse_provider_command("/ bad"), None);
        assert_eq!(super::parse_provider_command("/bad! command"), None);
        assert_eq!(
            super::parse_provider_command("/goal  ship the feature  "),
            Some(("goal", "ship the feature"))
        );
        assert_eq!(
            super::parse_provider_command("/mcp:reload_now.v2"),
            Some(("mcp:reload_now.v2", ""))
        );
        assert_eq!(
            super::parse_provider_command("/review\t staged changes"),
            Some(("review", "staged changes"))
        );
    }

    #[test]
    fn provider_projection_helpers_preserve_contract_fallbacks() {
        let event = |payload, turn_id: Option<&str>| super::ProviderEvent {
            native_event_id: None,
            event_type: "provider.event".to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: turn_id.map(str::to_owned),
            request_id: None,
            payload,
            activity: Vec::new(),
        };
        assert_eq!(
            super::assistant_message_id(&event(json!({"messageId":"message-1"}), Some("turn-1"))),
            "message-1"
        );
        assert_eq!(
            super::assistant_message_id(&event(json!({}), Some("turn-1"))),
            "assistant:turn-1"
        );
        assert_eq!(
            super::assistant_message_id(&event(json!({}), None)),
            "assistant:thread-1"
        );

        assert_eq!(
            super::provider_completion_error(&json!({"error":{"message":"nested"}})),
            "nested"
        );
        assert_eq!(
            super::provider_completion_error(&json!({"error":"flat"})),
            "flat"
        );
        assert_eq!(
            super::provider_completion_error(&json!({"message":"top-level"})),
            "top-level"
        );
        assert_eq!(
            super::provider_completion_error(&json!({"error":{}})),
            "Provider turn failed."
        );

        for (event_type, expected) in [
            ("request.opened", ("approval", "approval.requested")),
            ("request.resolved", ("approval", "approval.resolved")),
            ("user-input.requested", ("approval", "user-input.requested")),
            ("user-input.resolved", ("approval", "user-input.resolved")),
            ("provider.failed", ("error", "provider.error")),
            ("provider.error", ("error", "provider.error")),
            ("turn.started", ("info", "provider.turn")),
            ("session.ready", ("info", "provider.session")),
            ("tool.started", ("tool", "provider.event")),
        ] {
            assert_eq!(super::event_activity_shape(event_type), expected);
        }
    }

    #[tokio::test]
    async fn provider_projection_maps_context_usage() {
        let engine = supervisor_engine().await;
        let temp = TempDir::new().expect("temporary launch directory");
        let mut launch = native_launch(&temp, "codex");
        launch.thread_id = "t1".to_owned();

        super::project_provider_event(
            &engine,
            &launch,
            None,
            None,
            super::ProviderEvent {
                native_event_id: None,
                event_type: "thread.token-usage.updated".to_owned(),
                thread_id: "t1".to_owned(),
                turn_id: Some("turn-1".to_owned()),
                request_id: None,
                payload: json!({
                    "usage": {
                        "usedTokens": 1_075,
                        "totalProcessedTokens": 10_200,
                        "maxTokens": 258_400,
                        "inputTokens": 1_000,
                        "cachedInputTokens": 500,
                        "outputTokens": 50,
                        "reasoningOutputTokens": 25,
                        "lastUsedTokens": 1_075,
                        "lastInputTokens": 1_000,
                        "lastCachedInputTokens": 500,
                        "lastOutputTokens": 50,
                        "lastReasoningOutputTokens": 25,
                        "toolUses": 4,
                        "durationMs": 900,
                        "nativeUsageDetail": "must be dropped",
                        "compactsAutomatically": true
                    }
                }),
                activity: Vec::new(),
            },
        )
        .await
        .expect("context usage projects");

        let snapshot = load_snapshot(&engine.repositories())
            .await
            .expect("load projection snapshot");
        let activity = snapshot.activities.last().expect("context window activity");
        assert_eq!(activity.tone, "info");
        assert_eq!(activity.kind, "context-window.updated");
        assert_eq!(activity.summary, "Context window updated");
        assert_eq!(activity.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            activity.payload,
            json!({
                "usedTokens": 1_075,
                "totalProcessedTokens": 10_200,
                "maxTokens": 258_400,
                "inputTokens": 1_000,
                "cachedInputTokens": 500,
                "outputTokens": 50,
                "reasoningOutputTokens": 25,
                "lastUsedTokens": 1_075,
                "lastInputTokens": 1_000,
                "lastCachedInputTokens": 500,
                "lastOutputTokens": 50,
                "lastReasoningOutputTokens": 25,
                "toolUses": 4,
                "durationMs": 900,
                "compactsAutomatically": true
            })
        );

        super::project_provider_event(
            &engine,
            &launch,
            None,
            None,
            super::ProviderEvent {
                native_event_id: None,
                event_type: "thread.token-usage.updated".to_owned(),
                thread_id: "t1".to_owned(),
                turn_id: Some("turn-1".to_owned()),
                request_id: None,
                payload: json!({ "usage": {} }),
                activity: Vec::new(),
            },
        )
        .await
        .expect("malformed context usage is ignored");

        let snapshot = load_snapshot(&engine.repositories())
            .await
            .expect("reload projection snapshot");
        assert_eq!(snapshot.activities.len(), 1);
        assert_eq!(snapshot.activities[0].kind, "context-window.updated");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn mcp_status_activity_is_attributed_to_the_launched_provider_instance() {
        let engine = supervisor_engine().await;
        let temp = TempDir::new().expect("temporary launch directory");
        let mut launch = native_launch(&temp, "codex");
        launch.thread_id = "t1".to_owned();
        launch.provider_instance_id = Some("codex-work".to_owned());

        super::project_provider_event(
            &engine,
            &launch,
            None,
            None,
            super::ProviderEvent {
                native_event_id: None,
                event_type: "mcp.status.updated".to_owned(),
                thread_id: "t1".to_owned(),
                turn_id: None,
                request_id: None,
                payload: json!({
                    "servers": [{ "name": "context7", "state": "connected" }]
                }),
                activity: Vec::new(),
            },
        )
        .await
        .expect("MCP status projects");

        let snapshot = load_snapshot(&engine.repositories())
            .await
            .expect("load projection snapshot");
        assert_eq!(
            snapshot
                .activities
                .last()
                .expect("MCP status activity")
                .payload,
            json!({
                "servers": [{ "name": "context7", "state": "connected" }],
                "providerInstanceId": "codex-work"
            })
        );
        engine.shutdown().await;
    }

    #[test]
    fn provider_runtime_metadata_maps_every_native_adapter_and_resume_shape() {
        for (provider, adapter) in [
            ("codex", "codex-app-server"),
            ("claude", "claude-stream-json"),
            ("claudeAgent", "claude-stream-json"),
            ("cursor", "cursor-acp"),
            ("grok", "grok-acp"),
            ("opencode", "opencode-http"),
            ("future-provider", "native-provider"),
        ] {
            assert_eq!(super::native_adapter_key(provider), adapter);
        }

        assert_eq!(
            super::resume_string(&json!("plain-session")),
            Some("plain-session".to_owned())
        );
        assert_eq!(
            super::resume_string(&json!({"threadId":"thread-session"})),
            Some("thread-session".to_owned())
        );
        assert_eq!(
            super::resume_string(&json!({"sessionId":"provider-session"})),
            Some("provider-session".to_owned())
        );
        assert_eq!(super::resume_string(&json!({"sessionId":7})), None);

        assert!(matches!(
            super::runtime_mode("approval-required"),
            crate::provider::codex::CodexRuntimeMode::ApprovalRequired
        ));
        assert!(matches!(
            super::runtime_mode("auto-accept-edits"),
            crate::provider::codex::CodexRuntimeMode::AutoAcceptEdits
        ));
        assert!(matches!(
            super::runtime_mode("full-access"),
            crate::provider::codex::CodexRuntimeMode::FullAccess
        ));

        for (runtime_mode, interaction_mode, permission) in [
            ("full-access", "default", "bypassPermissions"),
            ("approval-required", "default", "default"),
            ("auto-accept-edits", "default", "acceptEdits"),
            ("full-access", "plan", "plan"),
        ] {
            assert_eq!(
                super::claude_permission_arg(super::claude_mode(runtime_mode, interaction_mode)),
                permission
            );
        }
    }

    #[test]
    fn provider_commands_do_not_inherit_host_rust_logging() {
        let mut command = tokio::process::Command::new("provider-fixture");
        command.env("RUST_LOG", "info");

        super::sanitize_provider_subprocess_environment(&mut command);

        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(name, value)| { name == "RUST_LOG" && value.is_none() })
        );
    }

    #[test]
    fn provider_mcp_configuration_matches_the_acp_wire_contract() {
        assert!(super::acp_mcp_servers(None).is_empty());
        assert_eq!(
            super::acp_mcp_servers(Some(&super::ProviderMcpConfig {
                endpoint: "http://127.0.0.1:7777/mcp".to_owned(),
                authorization_header: "Bearer secret".to_owned(),
                provider_session_id: "session-1".to_owned(),
            })),
            [json!({
                "type":"http",
                "name":"bibcode",
                "url":"http://127.0.0.1:7777/mcp",
                "headers":[{"name":"Authorization","value":"Bearer secret"}],
            })]
        );
    }

    #[test]
    fn executable_resolution_accepts_an_explicit_file_and_rejects_a_missing_path() {
        let directory = tempfile::TempDir::new().unwrap();
        let executable = directory.path().join("provider-fixture.exe");
        std::fs::write(&executable, b"fixture").unwrap();
        assert_eq!(
            super::resolve_provider_executable(&executable.to_string_lossy()),
            Some(executable.clone())
        );
        assert_eq!(
            super::resolve_provider_executable(
                &directory.path().join("missing/provider").to_string_lossy()
            ),
            None
        );
        let launch =
            super::prepare_provider_launch(&executable, std::iter::empty::<&str>()).unwrap();
        assert_eq!(launch.program, executable);
        assert!(launch.args.is_empty());
    }

    #[test]
    fn executable_resolution_uses_supplied_search_path_without_global_environment() {
        let system = tempfile::TempDir::new().unwrap();
        let user = tempfile::TempDir::new().unwrap();
        let executable = user
            .path()
            .join(if cfg!(windows) { "codex.exe" } else { "codex" });
        std::fs::write(&executable, b"fixture").unwrap();
        let minimal = std::env::join_paths([system.path()]).unwrap();
        let hydrated = std::env::join_paths([user.path(), system.path()]).unwrap();

        assert_eq!(
            super::resolve_provider_executable_in_path("codex", Some(&minimal)),
            None
        );
        assert_eq!(
            super::resolve_provider_executable_in_path("codex", Some(&hydrated)),
            Some(executable)
        );
    }

    #[tokio::test]
    async fn executable_resolution_prefers_case_insensitive_instance_path_override() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let ambient = tempfile::TempDir::new().expect("ambient executable directory");
        let instance = tempfile::TempDir::new().expect("instance executable directory");
        let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let ambient_executable = ambient.path().join(executable_name);
        let instance_executable = instance.path().join(executable_name);
        std::fs::write(&ambient_executable, b"ambient").expect("write ambient executable");
        std::fs::write(&instance_executable, b"instance").expect("write instance executable");
        let original_path = std::env::var_os("PATH");
        // SAFETY: process-global environment mutation is serialized by the shared test lock.
        unsafe { std::env::set_var("PATH", ambient.path()) };

        let environment = [(
            std::ffi::OsString::from("pAtH"),
            std::ffi::OsString::from(instance.path()),
        )];
        let resolved = super::resolve_provider_executable_with_environment(
            "codex",
            environment
                .iter()
                .map(|(name, value)| (name.as_os_str(), value.as_os_str())),
        );

        match original_path {
            Some(path) => {
                // SAFETY: process-global environment mutation is serialized by the shared test lock.
                unsafe { std::env::set_var("PATH", path) };
            }
            None => {
                // SAFETY: process-global environment mutation is serialized by the shared test lock.
                unsafe { std::env::remove_var("PATH") };
            }
        }
        assert_eq!(resolved, Some(instance_executable));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_launch_executes_the_instance_path_binary_instead_of_ambient_path() {
        use std::os::unix::fs::PermissionsExt;

        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let temp = tempfile::TempDir::new().expect("runtime fixture root");
        let ambient = temp.path().join("ambient");
        let instance = temp.path().join("instance");
        std::fs::create_dir_all(&ambient).expect("ambient executable directory");
        std::fs::create_dir_all(&instance).expect("instance executable directory");
        for (directory, value) in [(&ambient, "ambient"), (&instance, "instance")] {
            let executable = directory.join("provider-fixture");
            std::fs::write(
                &executable,
                format!(
                    "#!/bin/sh\nprintf '%s' '{value}' > \"$MARKER\"\nprintf '%s' \"$PATH\" > \"$PATH_MARKER\"\n"
                ),
            )
            .expect("write runtime executable");
            let mut permissions = std::fs::metadata(&executable)
                .expect("runtime fixture metadata")
                .permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&executable, permissions)
                .expect("make runtime fixture executable");
        }
        let marker = temp.path().join("launched");
        let path_marker = temp.path().join("effective-path");
        let original_path = std::env::var_os("PATH");
        // SAFETY: process-global environment mutation is serialized by the shared test lock.
        unsafe { std::env::set_var("PATH", &ambient) };
        let mut request = native_launch(&temp, "fixture");
        request.binary_path = "provider-fixture".to_owned();
        request
            .environment
            .insert("pAtH".to_owned(), instance.to_string_lossy().into_owned());
        request
            .environment
            .insert("MARKER".to_owned(), marker.to_string_lossy().into_owned());
        request.environment.insert(
            "PATH_MARKER".to_owned(),
            path_marker.to_string_lossy().into_owned(),
        );

        let mut child = super::spawn_child(&request, &[], false, ProcessAttributionRegistry::new())
            .expect("spawn instance executable");
        child.wait().await.expect("wait for runtime fixture");

        match original_path {
            Some(path) => {
                // SAFETY: process-global environment mutation is serialized by the shared test lock.
                unsafe { std::env::set_var("PATH", path) };
            }
            None => {
                // SAFETY: process-global environment mutation is serialized by the shared test lock.
                unsafe { std::env::remove_var("PATH") };
            }
        }
        assert_eq!(
            std::fs::read_to_string(marker).expect("launch marker"),
            "instance"
        );
        assert_eq!(
            std::fs::read_to_string(path_marker).expect("effective PATH marker"),
            instance.to_string_lossy()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_executable_resolution_prefers_pathext_shim_over_extensionless_posix_shim() {
        let directory = tempfile::TempDir::new().expect("provider fixture directory");
        let posix_shim = directory.path().join("codex");
        let windows_shim = directory.path().join("codex.cmd");
        std::fs::write(&posix_shim, b"#!/bin/sh\n").expect("write POSIX provider shim");
        std::fs::write(&windows_shim, b"@echo off\r\n").expect("write Windows provider shim");

        assert_eq!(
            super::resolve_provider_executable_in_path("codex", Some(directory.path().as_os_str())),
            Some(windows_shim)
        );
    }

    #[test]
    fn executable_resolution_keeps_explicit_paths_independent_of_search_path() {
        let directory = tempfile::TempDir::new().unwrap();
        let executable = directory.path().join("provider-fixture");
        std::fs::write(&executable, b"fixture").unwrap();

        assert_eq!(
            super::resolve_provider_executable_in_path(
                &executable.to_string_lossy(),
                Some(std::ffi::OsStr::new(""))
            ),
            Some(executable)
        );
    }

    #[tokio::test]
    async fn provider_executable_resolution_keeps_one_component_file_in_process_cwd() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let directory = tempfile::TempDir::new().expect("provider fixture directory");
        let search_directory = tempfile::TempDir::new().expect("provider search directory");
        let executable_name = if cfg!(windows) {
            "provider-fixture.exe"
        } else {
            "provider-fixture"
        };
        std::fs::write(directory.path().join(executable_name), b"fixture")
            .expect("write provider fixture");
        let _current_directory = CurrentDirectoryGuard::enter(directory.path());

        assert_eq!(
            super::resolve_provider_executable_in_path(
                executable_name,
                Some(search_directory.path().as_os_str())
            ),
            Some(std::path::PathBuf::from(executable_name))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provider_executable_resolution_keeps_absolute_file_when_cwd_is_inaccessible() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let directory = tempfile::TempDir::new().expect("provider fixture directory");
        let executable = directory.path().join("provider-fixture");
        std::fs::write(&executable, b"fixture").expect("write provider fixture");
        let inaccessible_cwd = directory.path().join("removed-cwd");
        std::fs::create_dir(&inaccessible_cwd).expect("create temporary current directory");
        let _current_directory = CurrentDirectoryGuard::enter(&inaccessible_cwd);
        std::fs::remove_dir(&inaccessible_cwd).expect("remove current directory");
        assert!(
            std::env::current_dir().is_err(),
            "fixture must make the process cwd inaccessible"
        );

        assert_eq!(
            super::resolve_provider_executable_in_path(
                &executable.to_string_lossy(),
                Some(std::ffi::OsStr::new(""))
            ),
            Some(executable)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provider_executable_resolution_finds_bare_command_when_cwd_is_inaccessible() {
        let _process_guard = crate::process::EXTERNAL_PROCESS_TEST_LOCK.lock().await;
        let directory = tempfile::TempDir::new().expect("provider fixture directory");
        let executable = directory.path().join("provider-fixture");
        std::fs::write(&executable, b"fixture").expect("write provider fixture");
        let inaccessible_cwd = directory.path().join("removed-cwd");
        std::fs::create_dir(&inaccessible_cwd).expect("create temporary current directory");
        let _current_directory = CurrentDirectoryGuard::enter(&inaccessible_cwd);
        std::fs::remove_dir(&inaccessible_cwd).expect("remove current directory");
        assert!(
            std::env::current_dir().is_err(),
            "fixture must make the process cwd inaccessible"
        );

        assert_eq!(
            super::resolve_provider_executable_in_path(
                "provider-fixture",
                Some(directory.path().as_os_str())
            ),
            Some(executable)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_launch_program_wraps_shell_scripts_without_profiles() {
        let launch = super::prepare_provider_launch(
            std::path::Path::new("provider.ps1"),
            ["--flag", "&literal"],
        )
        .unwrap();
        assert_eq!(launch.program, std::path::PathBuf::from("powershell.exe"));
        assert_eq!(
            launch.args,
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                "provider.ps1",
                "--flag",
                "&literal",
            ]
            .map(std::ffi::OsString::from)
        );

        let launch = super::prepare_provider_launch(
            std::path::Path::new("provider.cmd"),
            ["--flag", "&literal"],
        )
        .unwrap();
        assert_eq!(launch.program, std::path::PathBuf::from("provider.cmd"));
        assert_eq!(
            launch.args,
            ["--flag", "&literal"].map(std::ffi::OsString::from)
        );
    }

    #[tokio::test]
    async fn unsupported_capabilities_and_provider_errors_keep_actionable_context() {
        let error = super::unsupported::<()>("cursor", "checkpoint rollback")
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            super::ProviderRuntimeError::UnsupportedCapability {
                provider,
                capability: "checkpoint rollback"
            } if provider == "cursor"
        ));
        assert_eq!(
            super::pipe_error("claude", "stderr").to_string(),
            "failed to spawn claude provider process: child did not expose stderr"
        );
        assert_eq!(
            super::provider_error("grok")("protocol closed").to_string(),
            "grok provider operation failed: protocol closed"
        );
    }

    #[test]
    fn session_and_turn_events_use_a_contract_activity_tone() {
        assert_eq!(
            super::event_activity_shape("session.ready"),
            ("info", "provider.session")
        );
        assert_eq!(
            super::event_activity_shape("turn.completed"),
            ("info", "provider.turn")
        );
    }

    #[test]
    fn explicit_instance_overrides_legacy_binary_settings() {
        let providers = ProvidersState::default();
        assert!(!providers.cursor.enabled);
        let instance = ProviderInstanceState {
            driver: "cursor".to_owned(),
            enabled: true,
            display_name: None,
            environment: Vec::new(),
            config: json!({
                "binaryPath": "cursor-agent",
                "apiEndpoint": "http://127.0.0.1:3210",
            }),
        };

        let resolved = super::provider_binary_settings(&providers, "cursor", Some(&instance));
        assert!(resolved.enabled);
        assert_eq!(resolved.binary_path, "cursor-agent");
        assert_eq!(resolved.server_url, "http://127.0.0.1:3210");
    }

    #[test]
    fn explicit_grok_instance_cannot_override_kill_switch() {
        let mut providers = ProvidersState::default();
        providers.grok.enabled = true;
        let instance = ProviderInstanceState {
            driver: "grok".to_owned(),
            enabled: true,
            display_name: None,
            environment: Vec::new(),
            config: json!({ "binaryPath": "grok-custom" }),
        };

        let resolved = super::provider_binary_settings(&providers, "grok", Some(&instance));

        assert!(!resolved.enabled);
        assert_eq!(resolved.binary_path, "grok-custom");
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_executable_resolution_uses_exact_name() {
        assert_eq!(
            crate::process::launch_executable_extensions(crate::process::Platform::current(), None),
            [""]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_executable_resolution_prefers_cmd_over_powershell_shims() {
        let extensions =
            crate::process::launch_executable_extensions(crate::process::Platform::Windows, None);
        let cmd_index = extensions
            .iter()
            .position(|extension| extension.eq_ignore_ascii_case(".cmd"))
            .expect("cmd extension");
        let powershell_index = extensions
            .iter()
            .position(|extension| extension.eq_ignore_ascii_case(".ps1"))
            .expect("PowerShell extension");

        assert!(cmd_index < powershell_index);
    }
}
