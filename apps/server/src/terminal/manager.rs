use std::{
    collections::HashMap,
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, LazyLock},
    time::Duration,
};

use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Mutex, RwLock, broadcast};
use tokio_util::sync::CancellationToken;

use super::model::{TerminalConsoleTheme, terminal_console_theme_from_env};
use super::{
    PortablePtyBackend, PtyBackend, PtyExit, PtyProcess, PtySpawnInput, TerminalAttachInput,
    TerminalEvent, TerminalMetadataEvent, TerminalOpenInput, TerminalRestartInput,
    TerminalSessionSnapshot, TerminalStatus, TerminalSummary, history::TerminalHistory,
};
use crate::{
    diagnostics::{
        AttributionKind, AttributionScope, NativeProcessSampler, ProcessAttributionRegistry,
        ProcessRegistration, ProcessRegistrationMetadata, ProcessSampler, RegistrationSource,
        build_descendant_entries,
    },
    process::{Platform, ProcessCleanupReport, ShellCandidate, resolve_shell_candidates},
    provider_terminal::{
        PreparedTerminalObserver, TerminalAgentActivityTransition, TerminalLaunchPreparation,
        TerminalLaunchPreparationInput, TerminalLaunchPreparer, TerminalObserverCancellationReason,
        TerminalObserverGeneration, TerminalObserverGenerationLease,
    },
};

const DEFAULT_SUBPROCESS_POLL_INTERVAL: Duration = Duration::from_secs(1);
const OBSERVER_CALLBACK_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_PREPARATION_EXECUTION_BUDGET: Duration = Duration::from_secs(1);
const MAX_ISOLATED_OBSERVER_CALLBACKS: usize = 8;
const MAX_GLOBAL_ISOLATED_OBSERVER_CALLBACKS: usize = 16;
const MAX_BLOCKING_THREADS_PER_ISOLATED_OBSERVER_CALLBACK: usize = 1;
const OBSERVER_WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);
const OBSERVER_WORKER_ABORT_TIMEOUT: Duration = Duration::from_millis(50);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_DRAINED_OUTPUT_CHUNKS: usize = 1_024;
const TERMINAL_CLOSE_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_TERMINAL_LABEL_LENGTH: usize = 128;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SubprocessInspection {
    pub has_running_subprocess: bool,
    pub child_command_label: Option<String>,
    pub process_ids: Vec<u32>,
}

pub trait TerminalSubprocessInspector: std::fmt::Debug + Send + Sync {
    fn inspect(
        &self,
        terminal_pid: u32,
    ) -> Pin<Box<dyn Future<Output = Result<SubprocessInspection, String>> + Send + '_>>;
}

#[derive(Debug, Default)]
struct NativeTerminalSubprocessInspector {
    sampler: NativeProcessSampler,
}

impl TerminalSubprocessInspector for NativeTerminalSubprocessInspector {
    fn inspect(
        &self,
        terminal_pid: u32,
    ) -> Pin<Box<dyn Future<Output = Result<SubprocessInspection, String>> + Send + '_>> {
        Box::pin(async move {
            if terminal_pid == 0 {
                return Ok(SubprocessInspection::default());
            }

            let rows = self
                .sampler
                .sample()
                .await
                .map_err(|error| error.to_string())?;
            let descendants = build_descendant_entries(&rows, terminal_pid);
            let Some(first_child) = descendants.iter().find(|entry| entry.depth == 0) else {
                return Ok(SubprocessInspection::default());
            };

            let mut process_ids = Vec::with_capacity(descendants.len() + 1);
            process_ids.push(terminal_pid);
            process_ids.extend(descendants.iter().map(|entry| entry.pid));

            Ok(SubprocessInspection {
                has_running_subprocess: true,
                child_command_label: normalize_child_command_name(&first_child.command)
                    .map(|label| truncate_terminal_label(&label)),
                process_ids,
            })
        })
    }
}

#[derive(Clone)]
pub struct TerminalManagerOptions {
    pub history_line_limit: usize,
    pub event_capacity: usize,
    pub preferred_shell: Option<String>,
    pub subprocess_poll_interval: Duration,
    pub subprocess_inspector: Option<Arc<dyn TerminalSubprocessInspector>>,
    pub launch_preparer: Option<Arc<dyn TerminalLaunchPreparer>>,
}

impl std::fmt::Debug for TerminalManagerOptions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TerminalManagerOptions")
            .field("history_line_limit", &self.history_line_limit)
            .field("event_capacity", &self.event_capacity)
            .field("preferred_shell", &self.preferred_shell)
            .field("subprocess_poll_interval", &self.subprocess_poll_interval)
            .field(
                "subprocess_inspector",
                &self.subprocess_inspector.as_ref().map(|_| "configured"),
            )
            .field(
                "launch_preparer",
                &self.launch_preparer.as_ref().map(|_| "configured"),
            )
            .finish()
    }
}

impl Default for TerminalManagerOptions {
    fn default() -> Self {
        Self {
            history_line_limit: 5_000,
            event_capacity: 512,
            preferred_shell: None,
            subprocess_poll_interval: DEFAULT_SUBPROCESS_POLL_INTERVAL,
            subprocess_inspector: None,
            launch_preparer: None,
        }
    }
}

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal manager is shut down")]
    Shutdown,
    #[error("terminal publication was cancelled")]
    PublicationCancelled,
    #[error("terminal cwd does not exist: {0}")]
    CwdNotFound(String),
    #[error("terminal cwd is not a directory: {0}")]
    CwdNotDirectory(String),
    #[error("unknown terminal thread: {thread_id}, terminal: {terminal_id}")]
    NotFound {
        thread_id: String,
        terminal_id: String,
    },
    #[error("terminal is not running for thread: {thread_id}, terminal: {terminal_id}")]
    NotRunning {
        thread_id: String,
        terminal_id: String,
    },
    #[error("failed to spawn terminal; attempted {attempted:?}: {message}")]
    Spawn {
        attempted: Vec<String>,
        message: String,
    },
    #[error("terminal I/O failed: {0}")]
    Io(String),
    #[error("terminal processes did not exit before cleanup timed out")]
    Close,
}

struct Session {
    generation: Arc<SessionGeneration>,
    thread_id: String,
    terminal_id: String,
    cwd: String,
    worktree_path: Option<String>,
    status: TerminalStatus,
    pid: Option<u32>,
    history: TerminalHistory,
    exit_code: Option<i32>,
    exit_signal: Option<i32>,
    console_theme: Option<TerminalConsoleTheme>,
    label: String,
    has_running_subprocess: bool,
    child_command_label: Option<String>,
    updated_at: String,
    sequence: u64,
    cols: u16,
    rows: u16,
    process: Option<Arc<dyn PtyProcess>>,
    attribution_registration: Option<ProcessRegistration>,
    observer: Option<PreparedObserverHandle>,
    private_output: StreamingSecretRedactor,
}

type SessionKey = (String, String);
type SharedSession = Arc<Mutex<Session>>;

#[derive(Clone)]
pub(crate) struct TerminalSessionIdentity {
    key: SessionKey,
    session: SharedSession,
    generation: Arc<SessionGeneration>,
    process: Arc<dyn PtyProcess>,
}

#[derive(Clone)]
struct StreamingSecretRedactor {
    secrets: Arc<Vec<String>>,
    pending: String,
    gap_redaction_bytes: usize,
}

impl StreamingSecretRedactor {
    fn new(mut secrets: Vec<String>) -> Self {
        secrets.retain(|secret| !secret.is_empty());
        secrets.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        secrets.dedup();
        Self {
            secrets: Arc::new(secrets),
            pending: String::new(),
            gap_redaction_bytes: 0,
        }
    }

    fn push(&mut self, chunk: &str) -> String {
        let mut boundary = 0;
        if self.gap_redaction_bytes > 0 {
            for (index, character) in chunk.char_indices() {
                if self.gap_redaction_bytes == 0 {
                    break;
                }
                boundary = index + character.len_utf8();
                self.gap_redaction_bytes = self
                    .gap_redaction_bytes
                    .saturating_sub(character.len_utf8());
            }
        }
        let mut output = if boundary > 0 {
            "[redacted]".to_owned()
        } else {
            String::new()
        };
        self.pending.push_str(&chunk[boundary..]);
        output.push_str(&self.process(false));
        output
    }

    fn note_gap(&mut self) -> String {
        let withheld_prefix = !self.pending.is_empty();
        self.pending.clear();
        self.gap_redaction_bytes = self
            .secrets
            .first()
            .map_or(0, |secret| secret.len().saturating_sub(1));
        if withheld_prefix {
            "[redacted]".to_owned()
        } else {
            String::new()
        }
    }

    fn finish(&mut self) -> String {
        self.gap_redaction_bytes = 0;
        self.process(true)
    }

    fn process(&mut self, end_of_stream: bool) -> String {
        let input = std::mem::take(&mut self.pending);
        let mut output = String::new();
        let mut index = 0;
        while index < input.len() {
            let remaining = &input[index..];
            if self
                .secrets
                .iter()
                .any(|secret| secret.len() > remaining.len() && secret.starts_with(remaining))
            {
                if end_of_stream {
                    output.push_str("[redacted]");
                } else {
                    self.pending.push_str(remaining);
                }
                break;
            }
            if let Some(secret) = self
                .secrets
                .iter()
                .find(|secret| remaining.starts_with(secret.as_str()))
            {
                output.push_str("[redacted]");
                index += secret.len();
                continue;
            }
            let character = remaining
                .chars()
                .next()
                .expect("non-empty redaction remainder");
            output.push(character);
            index += character.len_utf8();
        }
        output
    }
}

impl std::fmt::Debug for StreamingSecretRedactor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StreamingSecretRedactor")
            .field("secret_count", &self.secrets.len())
            .field("pending_bytes", &self.pending.len())
            .field("gap_redaction_bytes", &self.gap_redaction_bytes)
            .finish()
    }
}

impl std::fmt::Debug for Session {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Session")
            .field("thread_id", &self.thread_id)
            .field("terminal_id", &self.terminal_id)
            .field("status", &self.status)
            .field("pid", &self.pid)
            .field("sequence", &self.sequence)
            .field("observer", &self.observer)
            .field("private_output", &self.private_output)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
struct PreparedObserverHandle {
    inner: Arc<PreparedObserverState>,
}

struct PreparedObserverState {
    observer: Arc<dyn PreparedTerminalObserver>,
    generation: TerminalObserverGeneration,
    callback_isolation: ObserverCallbackIsolation,
}

impl PreparedObserverHandle {
    fn new(
        observer: Box<dyn PreparedTerminalObserver>,
        generation: TerminalObserverGeneration,
        callback_isolation: ObserverCallbackIsolation,
    ) -> Self {
        Self {
            inner: Arc::new(PreparedObserverState {
                observer: Arc::from(observer),
                generation,
                callback_isolation,
            }),
        }
    }

    async fn on_spawned(&self, pid: u32, generation: TerminalObserverGenerationLease) -> bool {
        if self.inner.generation.cancellation_reason().is_some() {
            return false;
        }
        let state = self.inner.clone();
        run_observer_setup(state.callback_isolation.clone(), "on_spawned", move || {
            if state.generation.cancellation_reason().is_some() {
                return false;
            }
            state
                .observer
                .on_spawned(pid, generation, state.generation.worker_context());
            true
        })
        .await
        .unwrap_or(false)
    }

    async fn is_ready_for_on_spawned(&self) -> bool {
        if self.inner.generation.cancellation_reason().is_some() {
            return false;
        }
        let state = self.inner.clone();
        run_observer_setup(
            state.callback_isolation.clone(),
            "is_ready_for_on_spawned",
            move || {
                state.generation.cancellation_reason().is_none()
                    && state.observer.is_ready_for_on_spawned()
            },
        )
        .await
        .unwrap_or(false)
    }

    async fn cancel(&self, reason: TerminalObserverCancellationReason) {
        self.inner.generation.request_cancellation(reason);
        self.inner
            .generation
            .shutdown_workers(
                OBSERVER_WORKER_SHUTDOWN_TIMEOUT,
                OBSERVER_WORKER_ABORT_TIMEOUT,
            )
            .await;
    }

    async fn set_agent_activity_enabled(&self, enabled: bool) -> TerminalAgentActivityTransition {
        if self.inner.generation.cancellation_reason().is_some() {
            return TerminalAgentActivityTransition::default();
        }
        let state = self.inner.clone();
        let callback_timeout = if enabled {
            state
                .observer
                .agent_activity_enable_ack_timeout()
                .map(|timeout| timeout.saturating_add(OBSERVER_CALLBACK_TIMEOUT))
                .unwrap_or(OBSERVER_CALLBACK_TIMEOUT)
        } else {
            OBSERVER_CALLBACK_TIMEOUT
        };
        run_observer_callback(
            state.callback_isolation.clone(),
            "set_agent_activity_enabled",
            callback_timeout,
            async move {
                state
                    .observer
                    .set_agent_activity_enabled(
                        enabled,
                        state.generation.observation(),
                        state.generation.worker_context(),
                    )
                    .await
            },
        )
        .await
        .unwrap_or(TerminalAgentActivityTransition {
            failed: 1,
            ..TerminalAgentActivityTransition::default()
        })
    }
}

#[derive(Clone, Debug)]
struct ObserverCallbackIsolation {
    slots: Arc<tokio::sync::Semaphore>,
    global_slots: Arc<tokio::sync::Semaphore>,
}

impl Default for ObserverCallbackIsolation {
    fn default() -> Self {
        Self {
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_ISOLATED_OBSERVER_CALLBACKS)),
            global_slots: GLOBAL_OBSERVER_CALLBACK_SLOTS.clone(),
        }
    }
}

#[cfg(test)]
impl ObserverCallbackIsolation {
    fn with_global_slots(global_slots: Arc<tokio::sync::Semaphore>) -> Self {
        Self {
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_ISOLATED_OBSERVER_CALLBACKS)),
            global_slots,
        }
    }
}

static GLOBAL_OBSERVER_CALLBACK_SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| {
        Arc::new(tokio::sync::Semaphore::new(
            MAX_GLOBAL_ISOLATED_OBSERVER_CALLBACKS,
        ))
    });

enum IsolatedCallbackResult<T> {
    Completed(T),
    Panicked,
    RuntimeFailed(String),
}

async fn run_observer_callback<T>(
    isolation: ObserverCallbackIsolation,
    callback: &'static str,
    execution_budget: Duration,
    future: impl Future<Output = T> + Send + 'static,
) -> Option<T>
where
    T: Send + 'static,
{
    run_isolated_observer_callback(isolation, callback, execution_budget, move || {
        // Every admitted asynchronous callback owns one isolation thread and
        // at most one Tokio blocking-pool thread. With the process-global
        // admission cap, callback isolation is therefore bounded to 32
        // manager-created threads. Trusted Rust callbacks can still create
        // unmanaged raw std::threads; this is not a sandbox.
        match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(MAX_BLOCKING_THREADS_PER_ISOLATED_OBSERVER_CALLBACK)
            .build()
        {
            Ok(runtime) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    runtime.block_on(future)
                })) {
                    Ok(value) => IsolatedCallbackResult::Completed(value),
                    Err(_) => IsolatedCallbackResult::Panicked,
                }
            }
            Err(error) => IsolatedCallbackResult::RuntimeFailed(error.to_string()),
        }
    })
    .await
}

async fn run_observer_setup<T>(
    isolation: ObserverCallbackIsolation,
    callback: &'static str,
    setup: impl FnOnce() -> T + Send + 'static,
) -> Option<T>
where
    T: Send + 'static,
{
    run_isolated_observer_callback(isolation, callback, OBSERVER_CALLBACK_TIMEOUT, move || {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(setup)) {
            Ok(value) => IsolatedCallbackResult::Completed(value),
            Err(_) => IsolatedCallbackResult::Panicked,
        }
    })
    .await
}

async fn run_isolated_observer_callback<T>(
    isolation: ObserverCallbackIsolation,
    callback: &'static str,
    execution_budget: Duration,
    invoke: impl FnOnce() -> IsolatedCallbackResult<T> + Send + 'static,
) -> Option<T>
where
    T: Send + 'static,
{
    let manager_permit = match tokio::time::timeout(
        OBSERVER_CALLBACK_TIMEOUT,
        isolation.slots.acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        Ok(Err(_)) => {
            tracing::warn!(callback, "provider terminal observer isolation is closed");
            return None;
        }
        Err(_) => {
            tracing::warn!(
                callback,
                timeout_ms = OBSERVER_CALLBACK_TIMEOUT.as_millis(),
                capacity = MAX_ISOLATED_OBSERVER_CALLBACKS,
                "provider terminal observer callback admission timed out"
            );
            return None;
        }
    };
    let global_permit = match tokio::time::timeout(
        OBSERVER_CALLBACK_TIMEOUT,
        isolation.global_slots.acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        Ok(Err(_)) => {
            tracing::warn!(
                callback,
                "global provider terminal observer isolation is closed"
            );
            return None;
        }
        Err(_) => {
            tracing::warn!(
                callback,
                timeout_ms = OBSERVER_CALLBACK_TIMEOUT.as_millis(),
                capacity = MAX_GLOBAL_ISOLATED_OBSERVER_CALLBACKS,
                "global provider terminal observer callback admission timed out"
            );
            return None;
        }
    };
    let (result_sender, result_receiver) = tokio::sync::oneshot::channel();
    let thread = std::thread::Builder::new()
        .name(format!("terminal-observer-{callback}"))
        .spawn(move || {
            let _manager_permit = manager_permit;
            let _global_permit = global_permit;
            let _ = result_sender.send(invoke());
        });
    if let Err(error) = thread {
        tracing::warn!(callback, %error, "failed to start provider terminal observer isolation");
        return None;
    }
    match tokio::time::timeout(execution_budget, result_receiver).await {
        Ok(Ok(IsolatedCallbackResult::Completed(value))) => Some(value),
        Ok(Ok(IsolatedCallbackResult::Panicked)) => {
            tracing::warn!(callback, "provider terminal observer callback panicked");
            None
        }
        Ok(Ok(IsolatedCallbackResult::RuntimeFailed(error))) => {
            tracing::warn!(callback, %error, "provider terminal observer runtime failed");
            None
        }
        Ok(Err(_)) => {
            tracing::warn!(
                callback,
                "provider terminal observer isolation ended without a result"
            );
            None
        }
        Err(_) => {
            tracing::warn!(
                callback,
                timeout_ms = execution_budget.as_millis(),
                "provider terminal observer callback timed out"
            );
            None
        }
    }
}

impl std::fmt::Debug for PreparedObserverHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("PreparedObserverHandle")
            .field(&self.inner.observer.diagnostic_label())
            .finish()
    }
}

#[derive(Debug)]
struct ClosedSessionNotification {
    thread_id: String,
    terminal_id: String,
    sequence: u64,
}

#[derive(Debug, Default)]
struct ClosedSessions {
    report: ProcessCleanupReport,
    notifications: Vec<ClosedSessionNotification>,
}

/// Owns a newly spawned PTY until a registered, supervised session takes responsibility for it.
struct UncommittedPtyProcess {
    process: Option<Arc<dyn PtyProcess>>,
}

impl UncommittedPtyProcess {
    fn new(process: Arc<dyn PtyProcess>) -> Self {
        Self {
            process: Some(process),
        }
    }

    fn process(&self) -> Arc<dyn PtyProcess> {
        self.process.as_ref().expect("uncommitted process").clone()
    }

    fn commit(mut self) {
        self.process = None;
    }
}

impl Drop for UncommittedPtyProcess {
    fn drop(&mut self) {
        let Some(process) = self.process.take() else {
            return;
        };
        if let Err(error) = process.kill() {
            tracing::debug!(
                %error,
                pid = process.pid(),
                "failed to kill uncommitted terminal process"
            );
        }
    }
}

#[derive(Debug)]
struct SessionGeneration {
    observation: TerminalObserverGeneration,
    observer: std::sync::Mutex<Option<PreparedObserverHandle>>,
    closing: std::sync::atomic::AtomicBool,
    invalidated: std::sync::atomic::AtomicBool,
    cancellation: CancellationToken,
    publication: Mutex<()>,
    startup: Arc<Mutex<()>>,
    output_started: std::sync::atomic::AtomicBool,
    output_stop: CancellationToken,
    output_completed: CancellationToken,
    #[cfg(test)]
    activity_completed: CancellationToken,
    #[cfg(test)]
    output_barrier: std::sync::Mutex<Option<Arc<PublisherBarrier>>>,
}

impl SessionGeneration {
    fn new(key: &SessionKey, observer_runtime: Option<tokio::runtime::Handle>) -> Self {
        Self {
            observation: TerminalObserverGeneration::new_with_runtime(
                key.0.clone(),
                key.1.clone(),
                observer_runtime,
            ),
            observer: std::sync::Mutex::new(None),
            closing: std::sync::atomic::AtomicBool::new(false),
            invalidated: std::sync::atomic::AtomicBool::new(false),
            cancellation: CancellationToken::new(),
            publication: Mutex::new(()),
            startup: Arc::new(Mutex::new(())),
            output_started: std::sync::atomic::AtomicBool::new(false),
            output_stop: CancellationToken::new(),
            output_completed: CancellationToken::new(),
            #[cfg(test)]
            activity_completed: CancellationToken::new(),
            #[cfg(test)]
            output_barrier: std::sync::Mutex::new(None),
        }
    }

    async fn invalidate(&self) {
        self.observation.invalidate().await;
        self.invalidated
            .store(true, std::sync::atomic::Ordering::Release);
        self.cancellation.cancel();
    }

    fn is_invalidated(&self) -> bool {
        self.invalidated.load(std::sync::atomic::Ordering::Acquire)
    }

    fn install_observer(
        &self,
        observer: PreparedObserverHandle,
    ) -> Result<(), PreparedObserverHandle> {
        let mut current = self.observer.lock().expect("terminal observer lock");
        if self.closing.load(std::sync::atomic::Ordering::Acquire)
            || self.is_invalidated()
            || current.is_some()
        {
            return Err(observer);
        }
        *current = Some(observer);
        Ok(())
    }

    fn observer(&self) -> Option<PreparedObserverHandle> {
        self.observer
            .lock()
            .expect("terminal observer lock")
            .clone()
    }

    async fn cancel_observer(&self, reason: TerminalObserverCancellationReason) {
        let observer = self.observer.lock().expect("terminal observer lock").take();
        if let Some(observer) = observer {
            observer.cancel(reason).await;
        } else {
            self.observation.request_cancellation(reason);
            self.observation
                .shutdown_workers(
                    OBSERVER_WORKER_SHUTDOWN_TIMEOUT,
                    OBSERVER_WORKER_ABORT_TIMEOUT,
                )
                .await;
        }
    }

    async fn stop_output(&self) {
        self.output_stop.cancel();
        if self
            .output_started
            .load(std::sync::atomic::Ordering::Acquire)
            && tokio::time::timeout(OUTPUT_DRAIN_TIMEOUT, self.output_completed.cancelled())
                .await
                .is_err()
        {
            tracing::warn!(
                timeout_ms = OUTPUT_DRAIN_TIMEOUT.as_millis(),
                "terminal output drain timed out"
            );
        }
    }

    async fn cancel_and_invalidate(&self, reason: TerminalObserverCancellationReason) {
        self.begin_closing();
        self.cancel_observer(reason).await;
        self.invalidate().await;
    }

    fn begin_closing(&self) {
        self.closing
            .store(true, std::sync::atomic::Ordering::Release);
    }

    fn prevent_new_work(&self) {
        self.invalidated
            .store(true, std::sync::atomic::Ordering::Release);
        self.cancellation.cancel();
    }
}

#[derive(Debug)]
struct SessionGenerationRegistry {
    observer_runtime: Option<tokio::runtime::Handle>,
    current: std::sync::Mutex<HashMap<SessionKey, std::sync::Weak<SessionGeneration>>>,
}

impl SessionGenerationRegistry {
    fn new(observer_runtime: Option<tokio::runtime::Handle>) -> Self {
        Self {
            observer_runtime,
            current: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn current(&self, key: &SessionKey) -> Arc<SessionGeneration> {
        let mut current = self.current.lock().expect("terminal generations lock");
        current.retain(|_, generation| generation.strong_count() > 0);
        if let Some(generation) = current.get(key).and_then(std::sync::Weak::upgrade)
            && !generation.is_invalidated()
        {
            return generation;
        }
        let generation = Arc::new(SessionGeneration::new(key, self.observer_runtime.clone()));
        current.insert(key.clone(), Arc::downgrade(&generation));
        generation
    }

    fn peek(&self, key: &SessionKey) -> Option<Arc<SessionGeneration>> {
        self.current
            .lock()
            .expect("terminal generations lock")
            .get(key)
            .and_then(std::sync::Weak::upgrade)
    }

    fn replace(
        &self,
        key: &SessionKey,
    ) -> (Option<Arc<SessionGeneration>>, Arc<SessionGeneration>) {
        let mut current = self.current.lock().expect("terminal generations lock");
        current.retain(|_, generation| generation.strong_count() > 0);
        let displaced = current.remove(key).and_then(|value| value.upgrade());
        let generation = Arc::new(SessionGeneration::new(key, self.observer_runtime.clone()));
        current.insert(key.clone(), Arc::downgrade(&generation));
        (displaced, generation)
    }

    fn remove_matching(
        &self,
        thread_id: &str,
        terminal_id: Option<&str>,
    ) -> Vec<Arc<SessionGeneration>> {
        let mut current = self.current.lock().expect("terminal generations lock");
        current.retain(|_, generation| generation.strong_count() > 0);
        let keys = current
            .keys()
            .filter(|(candidate_thread, candidate_terminal)| {
                candidate_thread == thread_id
                    && terminal_id.is_none_or(|value| candidate_terminal == value)
            })
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| current.remove(&key).and_then(|value| value.upgrade()))
            .collect()
    }

    fn remove_all(&self) -> Vec<Arc<SessionGeneration>> {
        let mut current = self.current.lock().expect("terminal generations lock");
        current
            .drain()
            .filter_map(|(_, generation)| generation.upgrade())
            .collect()
    }

    fn snapshot_live(&self) -> Vec<Arc<SessionGeneration>> {
        let mut current = self.current.lock().expect("terminal generations lock");
        current.retain(|_, generation| generation.strong_count() > 0);
        current
            .values()
            .filter_map(std::sync::Weak::upgrade)
            .filter(|generation| !generation.is_invalidated())
            .collect()
    }

    fn live_observer_count(&self) -> usize {
        let mut current = self.current.lock().expect("terminal generations lock");
        current.retain(|_, generation| generation.strong_count() > 0);
        current
            .values()
            .filter_map(std::sync::Weak::upgrade)
            .filter(|generation| !generation.is_invalidated() && generation.observer().is_some())
            .count()
    }
}

#[derive(Debug, Default)]
struct SessionOperationRegistry {
    operations: std::sync::Mutex<HashMap<SessionKey, std::sync::Weak<Mutex<()>>>>,
}

impl SessionOperationRegistry {
    fn for_key(&self, key: &SessionKey) -> Arc<Mutex<()>> {
        let mut operations = self
            .operations
            .lock()
            .expect("terminal operation registry lock");
        operations.retain(|_, operation| operation.strong_count() > 0);
        if let Some(operation) = operations.get(key).and_then(std::sync::Weak::upgrade) {
            return operation;
        }
        let operation = Arc::new(Mutex::new(()));
        operations.insert(key.clone(), Arc::downgrade(&operation));
        operation
    }
}

struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[cfg(test)]
#[derive(Debug)]
struct PublisherBarrier {
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl Session {
    fn snapshot(&self) -> TerminalSessionSnapshot {
        TerminalSessionSnapshot {
            thread_id: self.thread_id.clone(),
            terminal_id: self.terminal_id.clone(),
            cwd: self.cwd.clone(),
            worktree_path: self.worktree_path.clone(),
            status: self.status,
            pid: self.pid,
            history: self.history.snapshot(),
            exit_code: self.exit_code,
            exit_signal: self.exit_signal,
            console_theme: self.console_theme,
            label: self.display_label(),
            updated_at: self.updated_at.clone(),
            sequence: self.sequence,
        }
    }

    fn summary(&self) -> TerminalSummary {
        TerminalSummary {
            thread_id: self.thread_id.clone(),
            terminal_id: self.terminal_id.clone(),
            cwd: self.cwd.clone(),
            worktree_path: self.worktree_path.clone(),
            status: self.status,
            pid: self.pid,
            exit_code: self.exit_code,
            exit_signal: self.exit_signal,
            console_theme: self.console_theme,
            has_running_subprocess: self.has_running_subprocess,
            label: self.display_label(),
            updated_at: self.updated_at.clone(),
        }
    }

    fn display_label(&self) -> String {
        if self.has_running_subprocess
            && let Some(label) = self.child_command_label.as_deref()
        {
            let trimmed = label.trim();
            if !trimmed.is_empty() {
                return truncate_terminal_label(trimmed);
            }
        }
        truncate_terminal_label(&self.label)
    }

    fn advance(&mut self) -> u64 {
        self.sequence = self.sequence.saturating_add(1);
        self.updated_at = now_iso();
        self.sequence
    }

    fn flush_private_output(&mut self) -> Option<TerminalEvent> {
        let data = self.private_output.finish();
        self.record_private_output(data)
    }

    fn redact_private_output_gap(&mut self) -> Option<TerminalEvent> {
        let data = self.private_output.note_gap();
        self.record_private_output(data)
    }

    fn record_private_output(&mut self, data: String) -> Option<TerminalEvent> {
        if data.is_empty() {
            return None;
        }
        self.history.push(&data);
        let sequence = self.advance();
        Some(TerminalEvent::Output {
            thread_id: self.thread_id.clone(),
            terminal_id: self.terminal_id.clone(),
            sequence,
            data,
        })
    }
}

#[derive(Debug)]
struct Inner {
    backend: Arc<dyn PtyBackend>,
    attribution: ProcessAttributionRegistry,
    options: TerminalManagerOptions,
    inspector: Arc<dyn TerminalSubprocessInspector>,
    callback_isolation: ObserverCallbackIsolation,
    lifecycle: Mutex<()>,
    operations: SessionOperationRegistry,
    generations: SessionGenerationRegistry,
    sessions: RwLock<HashMap<SessionKey, SharedSession>>,
    events: broadcast::Sender<TerminalEvent>,
    metadata: broadcast::Sender<TerminalMetadataEvent>,
    cancellation: CancellationToken,
    #[cfg(test)]
    restart_after_exact_cleanup_barrier: std::sync::Mutex<Option<Arc<PublisherBarrier>>>,
}

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for TerminalManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TerminalManager")
            .field("options", &self.inner.options)
            .finish_non_exhaustive()
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new(
            Arc::new(PortablePtyBackend),
            TerminalManagerOptions::default(),
        )
    }
}

impl TerminalManager {
    pub fn new(backend: Arc<dyn PtyBackend>, options: TerminalManagerOptions) -> Self {
        Self::with_process_attribution(backend, options, ProcessAttributionRegistry::new())
    }

    pub fn with_process_attribution(
        backend: Arc<dyn PtyBackend>,
        options: TerminalManagerOptions,
        attribution: ProcessAttributionRegistry,
    ) -> Self {
        let (events, _) = broadcast::channel(options.event_capacity.max(16));
        let (metadata, _) = broadcast::channel(options.event_capacity.max(16));
        let inspector = options
            .subprocess_inspector
            .clone()
            .unwrap_or_else(|| Arc::new(NativeTerminalSubprocessInspector::default()));
        Self {
            inner: Arc::new(Inner {
                backend,
                attribution,
                options,
                inspector,
                callback_isolation: ObserverCallbackIsolation::default(),
                lifecycle: Mutex::new(()),
                operations: SessionOperationRegistry::default(),
                generations: SessionGenerationRegistry::new(
                    tokio::runtime::Handle::try_current().ok(),
                ),
                sessions: RwLock::new(HashMap::new()),
                events,
                metadata,
                cancellation: CancellationToken::new(),
                #[cfg(test)]
                restart_after_exact_cleanup_barrier: std::sync::Mutex::new(None),
            }),
        }
    }

    pub async fn set_agent_activity_enabled(
        &self,
        enabled: bool,
    ) -> TerminalAgentActivityTransition {
        let observers = {
            let _lifecycle = self.inner.lifecycle.lock().await;
            self.inner
                .generations
                .snapshot_live()
                .into_iter()
                .filter_map(|generation| generation.observer())
                .collect::<Vec<_>>()
        };
        let mut transition = TerminalAgentActivityTransition::default();
        for observer in observers {
            transition.merge(observer.set_agent_activity_enabled(enabled).await);
        }
        transition
    }

    /// Returns live prepared observers retained to resume activity after re-enable.
    #[doc(hidden)]
    #[must_use]
    pub fn agent_activity_restart_descriptor_count_for_integration_test(&self) -> usize {
        self.inner.generations.live_observer_count()
    }

    pub async fn open(
        &self,
        input: TerminalOpenInput,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        self.open_inner(input, None, CancellationToken::new()).await
    }

    pub(crate) async fn open_with_publication_cancellation(
        &self,
        input: TerminalOpenInput,
        publication_cancellation: CancellationToken,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        self.open_inner(input, None, publication_cancellation).await
    }

    pub(crate) async fn open_with_initial_input_and_publication_cancellation(
        &self,
        input: TerminalOpenInput,
        initial_input: String,
        publication_cancellation: CancellationToken,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        self.open_inner(input, Some(initial_input), publication_cancellation)
            .await
    }

    async fn open_inner(
        &self,
        input: TerminalOpenInput,
        initial_input: Option<String>,
        publication_cancellation: CancellationToken,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        let key = (input.thread_id.clone(), input.terminal_id.clone());
        let generation = {
            let _lifecycle = self.inner.lifecycle.lock().await;
            if self.inner.cancellation.is_cancelled() {
                return Err(TerminalError::Shutdown);
            }
            self.inner.generations.current(&key)
        };
        self.start(
            input,
            false,
            generation,
            initial_input,
            publication_cancellation,
        )
        .await
    }

    pub async fn restart(
        &self,
        input: TerminalRestartInput,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        self.restart_with_publication_cancellation(input, CancellationToken::new())
            .await
    }

    pub(crate) async fn restart_with_publication_cancellation(
        &self,
        input: TerminalRestartInput,
        publication_cancellation: CancellationToken,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        let key = (input.thread_id.clone(), input.terminal_id.clone());
        if let Some(generation) = self.inner.generations.peek(&key) {
            generation.begin_closing();
            generation
                .observation
                .request_cancellation(TerminalObserverCancellationReason::Restarted);
            generation.prevent_new_work();
        }
        let operation = self.inner.operations.for_key(&key);
        let _operation = operation.lock_owned().await;
        let (displaced, generation, _startup) = {
            let _lifecycle = self.inner.lifecycle.lock().await;
            if self.inner.cancellation.is_cancelled() {
                return Err(TerminalError::Shutdown);
            }
            let (displaced, generation) = self.inner.generations.replace(&key);
            if let Some(previous) = &displaced {
                previous.begin_closing();
            }
            let startup = generation
                .startup
                .clone()
                .try_lock_owned()
                .expect("fresh terminal generation startup lock");
            (displaced, generation, startup)
        };
        if let Some(previous) = displaced {
            previous.stop_output().await;
            previous
                .cancel_and_invalidate(TerminalObserverCancellationReason::Restarted)
                .await;
        }
        #[cfg(test)]
        let restart_barrier = {
            self.inner
                .restart_after_exact_cleanup_barrier
                .lock()
                .expect("restart barrier lock")
                .take()
        };
        #[cfg(test)]
        if let Some(barrier) = restart_barrier {
            barrier.started.notify_one();
            barrier.release.notified().await;
        }
        let closed = self
            .close_sessions(
                &input.thread_id,
                Some(&input.terminal_id),
                TerminalObserverCancellationReason::Restarted,
            )
            .await;
        log_terminal_cleanup("restart", &closed.report);
        match self
            .start_inner(input, true, generation, None, publication_cancellation)
            .await
        {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                self.publish_closed_sessions(&closed.notifications);
                Err(error)
            }
        }
    }

    async fn start(
        &self,
        input: TerminalOpenInput,
        restarted: bool,
        generation: Arc<SessionGeneration>,
        initial_input: Option<String>,
        publication_cancellation: CancellationToken,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        let key = (input.thread_id.clone(), input.terminal_id.clone());
        let operation = self.inner.operations.for_key(&key);
        let _operation = operation.lock_owned().await;
        let startup = generation.startup.clone();
        let _startup = startup.lock().await;
        self.start_inner(
            input,
            restarted,
            generation,
            initial_input,
            publication_cancellation,
        )
        .await
    }

    async fn start_inner(
        &self,
        input: TerminalOpenInput,
        restarted: bool,
        generation: Arc<SessionGeneration>,
        initial_input: Option<String>,
        publication_cancellation: CancellationToken,
    ) -> Result<TerminalSessionSnapshot, TerminalError> {
        if generation.is_invalidated() {
            return Err(invalidated_creation_error(&input));
        }
        validate_cwd(&input.cwd).await?;
        validate_dimensions(input.cols, input.rows)?;
        if generation.is_invalidated() {
            return Err(invalidated_creation_error(&input));
        }
        let key = (input.thread_id.clone(), input.terminal_id.clone());
        let console_theme = terminal_console_theme_from_env(&input.env);
        if let Some(existing) = self.inner.sessions.read().await.get(&key).cloned() {
            let (process, snapshot, needs_resize) = {
                let session = existing.lock().await;
                (
                    session.process.clone(),
                    session.snapshot(),
                    session.cols != input.cols || session.rows != input.rows,
                )
            };
            if let Some(process) = process {
                if needs_resize {
                    process
                        .resize(input.cols, input.rows)
                        .map_err(TerminalError::Io)?;
                    let mut session = existing.lock().await;
                    session.cols = input.cols;
                    session.rows = input.rows;
                    session.updated_at = now_iso();
                }
                return Ok(snapshot);
            }
        }

        let mut private_values = Vec::new();
        let original_command_candidate = input.command.as_ref().map(|command| {
            (
                command.executable.clone(),
                command.args.clone(),
                input.env.clone(),
            )
        });
        let mut command_candidate = original_command_candidate.clone();
        let mut command_was_prepared = false;
        let mut activity_admission = None;
        if let (Some(preparer), Some(command)) = (
            self.inner.options.launch_preparer.as_ref(),
            input.command.as_ref(),
        ) && let Some(activity) = command.activity.clone()
        {
            let preparation = TerminalLaunchPreparationInput {
                executable: command.executable.clone(),
                args: command.args.clone(),
                cwd: input.cwd.clone(),
                worktree_path: input.worktree_path.clone(),
                launch_env: input.env.clone(),
                activity,
                generation: generation.observation.clone(),
            };
            let preparer = preparer.clone();
            let budget_preparer = preparer.clone();
            let budget_input = preparation.clone();
            let execution_budget = run_observer_callback(
                self.inner.callback_isolation.clone(),
                "preparation_execution_budget",
                OBSERVER_CALLBACK_TIMEOUT,
                async move {
                    budget_preparer
                        .preparation_execution_budget(&budget_input)
                        .await
                },
            )
            .await
            .unwrap_or(OBSERVER_CALLBACK_TIMEOUT)
            .min(MAX_PREPARATION_EXECUTION_BUDGET);
            let prepared = match run_observer_callback(
                self.inner.callback_isolation.clone(),
                "prepare",
                execution_budget,
                async move { preparer.prepare(preparation).await },
            )
            .await
            {
                None | Some(TerminalLaunchPreparation::PassThrough) => None,
                Some(TerminalLaunchPreparation::Prepared(prepared)) => Some((prepared, None)),
                Some(TerminalLaunchPreparation::Admitted(prepared, admission)) => {
                    if admission.is_current() {
                        Some((prepared, Some(admission)))
                    } else {
                        drop(prepared);
                        drop(admission);
                        None
                    }
                }
            };
            if let Some((prepared, admission)) = prepared {
                activity_admission = admission;
                let observer = PreparedObserverHandle::new(
                    prepared.observer,
                    generation.observation.clone(),
                    self.inner.callback_isolation.clone(),
                );
                if generation.is_invalidated() {
                    observer
                        .cancel(TerminalObserverCancellationReason::GenerationInvalidated)
                        .await;
                    return Err(invalidated_creation_error(&input));
                }
                if let Some(reserved_key) = prepared.private_env.keys().find(|private_key| {
                    input.env.keys().any(|client_key| {
                        environment_keys_equal(Platform::current(), client_key, private_key)
                    })
                }) {
                    observer
                        .cancel(TerminalObserverCancellationReason::PreparationRejected)
                        .await;
                    return Err(TerminalError::Io(format!(
                        "terminal environment contains a reserved observer key: {reserved_key}"
                    )));
                }
                private_values.extend(
                    prepared
                        .private_env
                        .values()
                        .filter(|value| !value.is_empty())
                        .cloned(),
                );
                private_values.sort_by(|left, right| {
                    right.len().cmp(&left.len()).then_with(|| left.cmp(right))
                });
                private_values.dedup();
                let mut env = input.env.clone();
                env.extend(prepared.private_env);
                command_candidate = Some((prepared.executable, prepared.args, env));
                if let Err(observer) = generation.install_observer(observer) {
                    observer
                        .cancel(TerminalObserverCancellationReason::GenerationInvalidated)
                        .await;
                    return Err(invalidated_creation_error(&input));
                }
                command_was_prepared = true;
            } else {
                generation
                    .observation
                    .request_cancellation(TerminalObserverCancellationReason::PreparationRejected);
                generation
                    .observation
                    .shutdown_workers(
                        OBSERVER_WORKER_SHUTDOWN_TIMEOUT,
                        OBSERVER_WORKER_ABORT_TIMEOUT,
                    )
                    .await;
            }
        }

        let spawn_candidates = if let Some((executable, args, env)) = command_candidate {
            let attempted_label =
                redact_private_values(format!("{executable} {args:?}"), &private_values);
            vec![(
                PtySpawnInput {
                    executable,
                    args,
                    cwd: input.cwd.clone(),
                    cols: input.cols,
                    rows: input.rows,
                    env,
                },
                attempted_label,
            )]
        } else {
            resolve_shell_candidates(
                Platform::current(),
                self.inner.options.preferred_shell.as_deref(),
                &input.env,
            )
            .into_iter()
            .map(|candidate| {
                let attempted = format_shell_candidate(&candidate);
                (
                    PtySpawnInput {
                        executable: candidate.command,
                        args: candidate.args,
                        cwd: input.cwd.clone(),
                        cols: input.cols,
                        rows: input.rows,
                        env: input.env.clone(),
                    },
                    attempted,
                )
            })
            .collect::<Vec<_>>()
        };

        let mut attempted = Vec::new();
        let mut last_error = "no terminal launch candidates were available".to_owned();
        let mut spawned = None;
        for (spawn, attempted_label) in spawn_candidates {
            attempted.push(attempted_label);
            match self.inner.backend.spawn(&spawn) {
                Ok(process) => {
                    spawned = Some(process);
                    break;
                }
                Err(error) => last_error = redact_private_values(error, &private_values),
            }
        }
        let Some(process) = spawned else {
            generation
                .cancel_observer(TerminalObserverCancellationReason::SpawnFailed)
                .await;
            return Err(TerminalError::Spawn {
                attempted,
                message: last_error,
            });
        };
        let mut uncommitted_process = UncommittedPtyProcess::new(process);
        if publication_cancellation.is_cancelled() {
            generation
                .cancel_observer(TerminalObserverCancellationReason::GenerationInvalidated)
                .await;
            return Err(TerminalError::PublicationCancelled);
        }
        if generation.is_invalidated() {
            generation
                .cancel_observer(TerminalObserverCancellationReason::GenerationInvalidated)
                .await;
            return Err(invalidated_creation_error(&input));
        }
        if command_was_prepared
            && let Some(observer) = generation.observer()
            && !observer.is_ready_for_on_spawned().await
        {
            drop(uncommitted_process);
            generation
                .cancel_observer(TerminalObserverCancellationReason::PreparationRejected)
                .await;
            private_values.clear();
            let Some((executable, args, env)) = original_command_candidate else {
                return Err(TerminalError::Io(
                    "prepared terminal launch has no original command".to_owned(),
                ));
            };
            let attempted_label = format!("{executable} {args:?}");
            attempted.push(attempted_label);
            let process = self
                .inner
                .backend
                .spawn(&PtySpawnInput {
                    executable,
                    args,
                    cwd: input.cwd.clone(),
                    cols: input.cols,
                    rows: input.rows,
                    env,
                })
                .map_err(|error| TerminalError::Spawn {
                    attempted,
                    message: error,
                })?;
            uncommitted_process = UncommittedPtyProcess::new(process);
        }
        let process = uncommitted_process.process();
        if let Some(observer) = generation.observer() {
            let completed = observer
                .on_spawned(process.pid(), generation.observation.observation())
                .await;
            if !completed {
                generation
                    .cancel_observer(TerminalObserverCancellationReason::PreparationRejected)
                    .await;
                generation.observation.invalidate().await;
            }
        }
        if generation.is_invalidated() {
            generation
                .cancel_observer(TerminalObserverCancellationReason::GenerationInvalidated)
                .await;
            return Err(invalidated_creation_error(&input));
        }
        if let Some(initial_input) = initial_input {
            process.write(&initial_input).map_err(TerminalError::Io)?;
        }
        let label = input
            .command
            .as_ref()
            .and_then(|command| command.label.clone())
            .unwrap_or_else(|| terminal_label(&input.terminal_id));
        let exit = process.subscribe_exit();
        let process_has_exited = exit.borrow().is_some();
        let attribution_registration = (!process_has_exited)
            .then(|| process.process_identity())
            .flatten()
            .and_then(|identity| {
                self.inner.attribution.register_identity(
                    identity,
                    ProcessRegistrationMetadata {
                        scope: AttributionScope::External,
                        kind: AttributionKind::Terminal,
                        label: label.clone(),
                        source: RegistrationSource::Terminal,
                    },
                )
            });
        let history = TerminalHistory::new(self.inner.options.history_line_limit);
        debug_assert_eq!(
            history.line_limit(),
            self.inner.options.history_line_limit,
            "session history must retain the manager's configured line limit"
        );
        let session = Arc::new(Mutex::new(Session {
            generation: generation.clone(),
            thread_id: input.thread_id.clone(),
            terminal_id: input.terminal_id.clone(),
            cwd: input.cwd.to_string_lossy().into_owned(),
            worktree_path: input
                .worktree_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            status: TerminalStatus::Running,
            pid: Some(process.pid()),
            history,
            exit_code: None,
            exit_signal: None,
            console_theme,
            label,
            has_running_subprocess: false,
            child_command_label: None,
            updated_at: now_iso(),
            sequence: 1,
            cols: input.cols,
            rows: input.rows,
            process: Some(process.clone()),
            attribution_registration,
            observer: generation.observer(),
            private_output: StreamingSecretRedactor::new(private_values),
        }));
        let _lifecycle = self.inner.lifecycle.lock().await;
        let _publication = generation.publication.lock().await;
        if publication_cancellation.is_cancelled() {
            generation
                .cancel_observer(TerminalObserverCancellationReason::GenerationInvalidated)
                .await;
            return Err(TerminalError::PublicationCancelled);
        }
        if self.inner.cancellation.is_cancelled() {
            generation
                .cancel_observer(TerminalObserverCancellationReason::Shutdown)
                .await;
            return Err(TerminalError::Shutdown);
        }
        if generation.is_invalidated() {
            generation
                .cancel_observer(TerminalObserverCancellationReason::GenerationInvalidated)
                .await;
            return Err(invalidated_creation_error(&input));
        }
        if let Some(existing) = self.inner.sessions.read().await.get(&key).cloned()
            && existing.lock().await.process.is_some()
        {
            generation
                .cancel_observer(TerminalObserverCancellationReason::PreparationRejected)
                .await;
            return Ok(existing.lock().await.snapshot());
        }
        self.inner
            .sessions
            .write()
            .await
            .insert(key, session.clone());
        self.supervise(session.clone(), process, exit, generation.clone());
        uncommitted_process.commit();
        // The installed observer is now visible to the lifecycle snapshot used by disable.
        drop(activity_admission);
        let snapshot = session.lock().await.snapshot();
        let event = if restarted {
            TerminalEvent::Restarted {
                thread_id: input.thread_id,
                terminal_id: input.terminal_id,
                sequence: snapshot.sequence,
                snapshot: snapshot.clone(),
            }
        } else {
            TerminalEvent::Started {
                thread_id: input.thread_id,
                terminal_id: input.terminal_id,
                sequence: snapshot.sequence,
                snapshot: snapshot.clone(),
            }
        };
        let _ = self.inner.events.send(event);
        let _ = self.inner.metadata.send(TerminalMetadataEvent::Upsert {
            terminal: session.lock().await.summary(),
        });
        Ok(snapshot)
    }

    fn supervise(
        &self,
        session: Arc<Mutex<Session>>,
        process: Arc<dyn PtyProcess>,
        mut exit: tokio::sync::watch::Receiver<Option<PtyExit>>,
        generation: Arc<SessionGeneration>,
    ) {
        let inner = self.inner.clone();
        let mut output = process.subscribe_output();
        let output_session = session.clone();
        let output_cancel = inner.cancellation.child_token();
        let output_inner = inner.clone();
        let output_generation = generation.clone();
        output_generation
            .output_started
            .store(true, std::sync::atomic::Ordering::Release);
        tokio::spawn(async move {
            let _completion = CancelOnDrop(output_generation.output_completed.clone());
            loop {
                let data = tokio::select! {
                    biased;
                    () = output_generation.output_stop.cancelled() => break,
                    () = output_cancel.cancelled() => break,
                    () = output_generation.cancellation.cancelled() => break,
                    result = output.recv() => match result {
                        Ok(data) => data,
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            if !Self::publish_output_gap(
                                &output_inner,
                                &output_session,
                                &output_generation,
                            )
                            .await
                            {
                                return;
                            }
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                };
                #[cfg(test)]
                let barrier = output_generation
                    .output_barrier
                    .lock()
                    .expect("output barrier lock")
                    .clone();
                #[cfg(test)]
                if let Some(barrier) = barrier {
                    barrier.started.notify_one();
                    barrier.release.notified().await;
                }
                if !Self::publish_output_chunk(
                    &output_inner,
                    &output_session,
                    &output_generation,
                    data,
                )
                .await
                {
                    return;
                }
            }
            for _ in 0..MAX_DRAINED_OUTPUT_CHUNKS {
                let data = match output.try_recv() {
                    Ok(data) => data,
                    Err(broadcast::error::TryRecvError::Lagged(_)) => {
                        if !Self::publish_output_gap(
                            &output_inner,
                            &output_session,
                            &output_generation,
                        )
                        .await
                        {
                            return;
                        }
                        continue;
                    }
                    Err(
                        broadcast::error::TryRecvError::Empty
                        | broadcast::error::TryRecvError::Closed,
                    ) => break,
                };
                if !Self::publish_output_chunk(
                    &output_inner,
                    &output_session,
                    &output_generation,
                    data,
                )
                .await
                {
                    return;
                }
            }
            Self::flush_output_tail(&output_inner, &output_session, &output_generation).await;
        });

        let exit_cancel = inner.cancellation.child_token();
        let exit_inner = inner.clone();
        let exit_session = session.clone();
        let exit_generation = generation.clone();
        tokio::spawn(async move {
            loop {
                let observed_exit = exit.borrow().clone();
                let Some(exit) = observed_exit else {
                    tokio::select! {
                        () = exit_cancel.cancelled() => return,
                        () = exit_generation.cancellation.cancelled() => return,
                        result = exit.changed() => {
                            if result.is_err() {
                                return;
                            }
                        }
                    }
                    continue;
                };
                Self::finalize_process_exit(&exit_inner, &exit_session, &exit_generation, exit)
                    .await;
                return;
            }
        });

        let activity_cancel = inner.cancellation.child_token();
        let activity_session = session;
        let activity_inner = inner.clone();
        let activity_pid = process.pid();
        let activity_generation = generation;
        tokio::spawn(async move {
            #[cfg(test)]
            let _completion = CancelOnDrop(activity_generation.activity_completed.clone());
            if activity_inner.options.subprocess_poll_interval.is_zero() {
                return;
            }
            loop {
                tokio::select! {
                    () = activity_cancel.cancelled() => return,
                    () = activity_generation.cancellation.cancelled() => return,
                    () = tokio::time::sleep(activity_inner.options.subprocess_poll_interval) => {}
                }

                let inspection = match activity_inner.inspector.inspect(activity_pid).await {
                    Ok(inspection) => inspection,
                    Err(error) => {
                        tracing::debug!(%error, pid = activity_pid, "failed to inspect terminal subprocess state");
                        continue;
                    }
                };

                let _publication = activity_generation.publication.lock().await;
                if activity_generation.is_invalidated() {
                    return;
                }
                let activity = {
                    let mut session = activity_session.lock().await;
                    if session.status != TerminalStatus::Running
                        || session.pid != Some(activity_pid)
                    {
                        return;
                    }
                    if session.has_running_subprocess == inspection.has_running_subprocess
                        && session.child_command_label == inspection.child_command_label
                    {
                        None
                    } else {
                        session.has_running_subprocess = inspection.has_running_subprocess;
                        session.child_command_label = inspection.child_command_label.clone();
                        let sequence = session.advance();
                        Some((
                            TerminalEvent::Activity {
                                thread_id: session.thread_id.clone(),
                                terminal_id: session.terminal_id.clone(),
                                sequence,
                                has_running_subprocess: session.has_running_subprocess,
                                label: session.display_label(),
                            },
                            session.summary(),
                        ))
                    }
                };

                if let Some((event, summary)) = activity {
                    let _ = activity_inner.events.send(event);
                    let _ = activity_inner
                        .metadata
                        .send(TerminalMetadataEvent::Upsert { terminal: summary });
                }
            }
        });
    }

    async fn finalize_process_exit(
        inner: &Arc<Inner>,
        session: &SharedSession,
        generation: &Arc<SessionGeneration>,
        exit: PtyExit,
    ) {
        generation.stop_output().await;
        let _publication = generation.publication.lock().await;
        if generation.is_invalidated() {
            return;
        }
        let registered = {
            let sessions = inner.sessions.read().await;
            let locked_session = session.lock().await;
            sessions
                .get(&(
                    locked_session.thread_id.clone(),
                    locked_session.terminal_id.clone(),
                ))
                .is_some_and(|current| Arc::ptr_eq(current, session))
        };
        if !registered {
            return;
        }
        generation
            .cancel_and_invalidate(TerminalObserverCancellationReason::ProcessExited)
            .await;
        let (event, summary) = {
            let mut session = session.lock().await;
            session.status = TerminalStatus::Exited;
            session.attribution_registration.take();
            session.observer.take();
            session.pid = None;
            session.process = None;
            session.exit_code = exit.exit_code;
            session.exit_signal = exit.signal;
            session.has_running_subprocess = false;
            session.child_command_label = None;
            let sequence = session.advance();
            (
                TerminalEvent::Exited {
                    thread_id: session.thread_id.clone(),
                    terminal_id: session.terminal_id.clone(),
                    sequence,
                    exit_code: exit.exit_code,
                    exit_signal: exit.signal,
                },
                session.summary(),
            )
        };
        let _ = inner.events.send(event);
        let _ = inner
            .metadata
            .send(TerminalMetadataEvent::Upsert { terminal: summary });
    }

    async fn publish_output_chunk(
        inner: &Inner,
        session: &SharedSession,
        generation: &SessionGeneration,
        data: String,
    ) -> bool {
        let _publication = generation.publication.lock().await;
        if generation.is_invalidated() {
            return false;
        }
        let event = {
            let mut session = session.lock().await;
            let data = session.private_output.push(&data);
            if data.is_empty() {
                None
            } else {
                session.history.push(&data);
                let sequence = session.advance();
                Some(TerminalEvent::Output {
                    thread_id: session.thread_id.clone(),
                    terminal_id: session.terminal_id.clone(),
                    sequence,
                    data,
                })
            }
        };
        if let Some(event) = event {
            let _ = inner.events.send(event);
        }
        true
    }

    async fn flush_output_tail(
        inner: &Inner,
        session: &SharedSession,
        generation: &SessionGeneration,
    ) {
        let _publication = generation.publication.lock().await;
        if generation.is_invalidated() {
            return;
        }
        let event = session.lock().await.flush_private_output();
        if let Some(event) = event {
            let _ = inner.events.send(event);
        }
    }

    async fn publish_output_gap(
        inner: &Inner,
        session: &SharedSession,
        generation: &SessionGeneration,
    ) -> bool {
        let _publication = generation.publication.lock().await;
        if generation.is_invalidated() {
            return false;
        }
        let event = session.lock().await.redact_private_output_gap();
        if let Some(event) = event {
            let _ = inner.events.send(event);
        }
        true
    }

    pub async fn attach(
        &self,
        input: TerminalAttachInput,
    ) -> Result<TerminalAttachment, TerminalError> {
        self.attach_with_publication_cancellation(input, CancellationToken::new())
            .await
    }

    pub(crate) async fn attach_with_publication_cancellation(
        &self,
        input: TerminalAttachInput,
        publication_cancellation: CancellationToken,
    ) -> Result<TerminalAttachment, TerminalError> {
        let events = self.inner.events.subscribe();
        let key = (input.thread_id.clone(), input.terminal_id.clone());
        let request_generation = {
            let _lifecycle = self.inner.lifecycle.lock().await;
            if self.inner.cancellation.is_cancelled() {
                return Err(TerminalError::Shutdown);
            }
            self.inner.generations.current(&key)
        };
        let existing = {
            let sessions = self.inner.sessions.read().await;
            sessions.get(&key).cloned()
        };
        let mut session = match existing {
            Some(session) => session,
            None => {
                let cwd = input.cwd.clone().ok_or_else(|| TerminalError::NotFound {
                    thread_id: input.thread_id.clone(),
                    terminal_id: input.terminal_id.clone(),
                })?;
                self.start(
                    TerminalOpenInput {
                        thread_id: input.thread_id.clone(),
                        terminal_id: input.terminal_id.clone(),
                        cwd,
                        worktree_path: input.worktree_path.clone(),
                        cols: input.cols.unwrap_or(120),
                        rows: input.rows.unwrap_or(30),
                        env: input.env.clone(),
                        command: input.command.clone(),
                    },
                    false,
                    request_generation.clone(),
                    None,
                    publication_cancellation,
                )
                .await?;
                self.inner
                    .sessions
                    .read()
                    .await
                    .get(&key)
                    .cloned()
                    .ok_or_else(|| TerminalError::NotFound {
                        thread_id: input.thread_id.clone(),
                        terminal_id: input.terminal_id.clone(),
                    })?
            }
        };
        tokio::task::yield_now().await;
        let (session_generation, process, status, current_cols, current_rows) = {
            let session = session.lock().await;
            (
                session.generation.clone(),
                session.process.clone(),
                session.status,
                session.cols,
                session.rows,
            )
        };
        if status == TerminalStatus::Running
            && (!Arc::ptr_eq(&request_generation, &session_generation)
                || session_generation.is_invalidated())
        {
            return Err(TerminalError::NotFound {
                thread_id: input.thread_id,
                terminal_id: input.terminal_id,
            });
        }
        if status != TerminalStatus::Running && input.restart_if_not_running {
            let cwd = input.cwd.ok_or_else(|| TerminalError::NotRunning {
                thread_id: input.thread_id.clone(),
                terminal_id: input.terminal_id.clone(),
            })?;
            self.restart(TerminalOpenInput {
                thread_id: input.thread_id.clone(),
                terminal_id: input.terminal_id.clone(),
                cwd,
                worktree_path: input.worktree_path,
                cols: input.cols.unwrap_or(current_cols),
                rows: input.rows.unwrap_or(current_rows),
                env: input.env,
                command: input.command,
            })
            .await?;
            session = self
                .require_session(&input.thread_id, &input.terminal_id)
                .await?;
        } else if let (Some(process), Some(cols), Some(rows)) = (process, input.cols, input.rows)
            && (cols != current_cols || rows != current_rows)
        {
            process.resize(cols, rows).map_err(TerminalError::Io)?;
            let mut session = session.lock().await;
            session.cols = cols;
            session.rows = rows;
            session.updated_at = now_iso();
        }
        let session_generation = session.lock().await.generation.clone();
        let _publication = session_generation.publication.lock().await;
        let initial = session.lock().await.snapshot();
        if initial.status == TerminalStatus::Running && session_generation.is_invalidated() {
            return Err(TerminalError::NotFound {
                thread_id: input.thread_id,
                terminal_id: input.terminal_id,
            });
        }
        Ok(TerminalAttachment {
            thread_id: input.thread_id,
            terminal_id: input.terminal_id,
            next_sequence: initial.sequence,
            initial,
            events,
        })
    }

    pub async fn write(
        &self,
        thread_id: &str,
        terminal_id: &str,
        data: &str,
    ) -> Result<(), TerminalError> {
        let session = self.require_session(thread_id, terminal_id).await?;
        let generation = session.lock().await.generation.clone();
        let _publication = generation.publication.lock().await;
        if generation.is_invalidated() {
            return Err(TerminalError::NotFound {
                thread_id: thread_id.to_owned(),
                terminal_id: terminal_id.to_owned(),
            });
        }
        let (process, status) = {
            let session = session.lock().await;
            (session.process.clone(), session.status)
        };
        if status == TerminalStatus::Exited {
            return Ok(());
        }
        let process = process.ok_or_else(|| TerminalError::NotRunning {
            thread_id: thread_id.to_string(),
            terminal_id: terminal_id.to_string(),
        })?;
        process.write(data).map_err(TerminalError::Io)
    }

    pub async fn resize(
        &self,
        thread_id: &str,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        validate_dimensions(cols, rows)?;
        let Some(session) = self
            .inner
            .sessions
            .read()
            .await
            .get(&(thread_id.to_string(), terminal_id.to_string()))
            .cloned()
        else {
            return Ok(());
        };
        let generation = session.lock().await.generation.clone();
        let _publication = generation.publication.lock().await;
        if generation.is_invalidated() {
            return Ok(());
        }
        let process = session.lock().await.process.clone();
        let Some(process) = process else {
            return Ok(());
        };
        process.resize(cols, rows).map_err(TerminalError::Io)?;
        let mut session = session.lock().await;
        session.cols = cols;
        session.rows = rows;
        session.updated_at = now_iso();
        Ok(())
    }

    pub async fn clear(&self, thread_id: &str, terminal_id: &str) -> Result<(), TerminalError> {
        let session = self.require_session(thread_id, terminal_id).await?;
        let generation = session.lock().await.generation.clone();
        let _publication = generation.publication.lock().await;
        if generation.is_invalidated() {
            return Err(TerminalError::NotFound {
                thread_id: thread_id.to_owned(),
                terminal_id: terminal_id.to_owned(),
            });
        }
        let event = {
            let mut session = session.lock().await;
            session.history.clear();
            let sequence = session.advance();
            TerminalEvent::Cleared {
                thread_id: thread_id.to_string(),
                terminal_id: terminal_id.to_string(),
                sequence,
            }
        };
        let _ = self.inner.events.send(event);
        Ok(())
    }

    pub async fn close(
        &self,
        thread_id: &str,
        terminal_id: Option<&str>,
    ) -> Result<(), TerminalError> {
        if let Some(terminal_id) = terminal_id
            && let Some(generation) = self
                .inner
                .generations
                .peek(&(thread_id.to_owned(), terminal_id.to_owned()))
        {
            generation.begin_closing();
            generation
                .observation
                .request_cancellation(TerminalObserverCancellationReason::Closed);
            generation.prevent_new_work();
        }
        let operation = terminal_id.map(|terminal_id| {
            self.inner
                .operations
                .for_key(&(thread_id.to_owned(), terminal_id.to_owned()))
        });
        let _operation = match operation {
            Some(operation) => Some(operation.lock_owned().await),
            None => None,
        };
        let generations = self
            .inner
            .generations
            .remove_matching(thread_id, terminal_id);
        for generation in &generations {
            generation.stop_output().await;
            generation
                .cancel_and_invalidate(TerminalObserverCancellationReason::Closed)
                .await;
        }
        let _lifecycle = self.inner.lifecycle.lock().await;
        let closed = self
            .close_sessions(
                thread_id,
                terminal_id,
                TerminalObserverCancellationReason::Closed,
            )
            .await;
        self.publish_closed_sessions(&closed.notifications);
        log_terminal_cleanup("close", &closed.report);
        if closed.report.failure_count > 0 {
            return Err(TerminalError::Close);
        }
        Ok(())
    }

    /// Stops every live terminal process for a thread while retaining the
    /// exited session snapshots and their bounded transcript history.
    pub async fn quiesce_thread_preserving_history(
        &self,
        thread_id: &str,
    ) -> Result<(), TerminalError> {
        let identities = self.capture_thread_session_identities(thread_id).await;
        self.quiesce_sessions_preserving_history_if_current(identities)
            .await
    }

    pub(crate) async fn capture_thread_session_identities(
        &self,
        thread_id: &str,
    ) -> Vec<TerminalSessionIdentity> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let sessions = {
            let sessions = self.inner.sessions.read().await;
            sessions
                .iter()
                .filter(|((candidate_thread, _), _)| candidate_thread == thread_id)
                .map(|(key, session)| (key.clone(), session.clone()))
                .collect::<Vec<_>>()
        };
        let mut identities = Vec::with_capacity(sessions.len());
        for (key, session) in sessions {
            let (generation, process) = {
                let session = session.lock().await;
                (session.generation.clone(), session.process.clone())
            };
            if let Some(process) = process {
                identities.push(TerminalSessionIdentity {
                    key,
                    session,
                    generation,
                    process,
                });
            }
        }
        identities
    }

    pub(crate) async fn quiesce_sessions_preserving_history_if_current(
        &self,
        identities: Vec<TerminalSessionIdentity>,
    ) -> Result<(), TerminalError> {
        let (targets, mut failed) = {
            let _lifecycle = self.inner.lifecycle.lock().await;
            let mut targets = Vec::with_capacity(identities.len());
            let mut failed = false;
            for identity in identities {
                let registered = {
                    let sessions = self.inner.sessions.read().await;
                    sessions
                        .get(&identity.key)
                        .is_some_and(|current| Arc::ptr_eq(current, &identity.session))
                };
                let generation_is_current = self
                    .inner
                    .generations
                    .peek(&identity.key)
                    .is_some_and(|current| Arc::ptr_eq(&current, &identity.generation));
                let process_is_current = if registered && generation_is_current {
                    let session = identity.session.lock().await;
                    Arc::ptr_eq(&session.generation, &identity.generation)
                        && session
                            .process
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &identity.process))
                } else {
                    false
                };
                if !process_is_current {
                    continue;
                }
                let exit = identity.process.subscribe_exit();
                match identity.process.kill() {
                    Ok(()) => targets.push((
                        identity.key,
                        identity.session,
                        identity.generation,
                        identity.process,
                        exit,
                    )),
                    Err(error) => {
                        failed = true;
                        tracing::warn!(
                            thread_id = %identity.key.0,
                            terminal_id = %identity.key.1,
                            pid = identity.process.pid(),
                            %error,
                            "failed to stop terminal for unavailable workspace"
                        );
                    }
                }
            }
            (targets, failed)
        };
        for (key, session, generation, process, exit) in targets {
            let observed = exit.clone();
            match wait_for_terminal_process_tree_exit(process, exit).await {
                Ok(()) => {
                    let observed_exit = observed.borrow().clone();
                    if let Some(exit) = observed_exit {
                        Self::finalize_process_exit(&self.inner, &session, &generation, exit).await;
                    }
                }
                Err(error) => {
                    failed = true;
                    tracing::warn!(
                        thread_id = %key.0,
                        terminal_id = %key.1,
                        %error,
                        "terminal quiesce did not finish cleanly"
                    );
                }
            }
        }
        if failed {
            Err(TerminalError::Close)
        } else {
            Ok(())
        }
    }

    async fn close_sessions(
        &self,
        thread_id: &str,
        terminal_id: Option<&str>,
        cancellation_reason: TerminalObserverCancellationReason,
    ) -> ClosedSessions {
        let mut closed = ClosedSessions::default();
        let keys = {
            let sessions = self.inner.sessions.read().await;
            sessions
                .keys()
                .filter(|(candidate_thread, candidate_terminal)| {
                    candidate_thread == thread_id
                        && terminal_id.is_none_or(|value| candidate_terminal == value)
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        for key in keys {
            let Some(session) = self.inner.sessions.read().await.get(&key).cloned() else {
                continue;
            };
            let generation = session.lock().await.generation.clone();
            generation.stop_output().await;
            let _publication = generation.publication.lock().await;
            generation.cancel_and_invalidate(cancellation_reason).await;
            let removed = {
                let mut sessions = self.inner.sessions.write().await;
                if sessions
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(current, &session))
                {
                    sessions.remove(&key)
                } else {
                    None
                }
            };
            let Some(session) = removed else {
                continue;
            };
            let (process, sequence) = {
                let mut session = session.lock().await;
                session.attribution_registration.take();
                session.observer.take();
                let process = session.process.take();
                session.status = TerminalStatus::Exited;
                session.pid = None;
                session.has_running_subprocess = false;
                session.child_command_label = None;
                (process, session.advance())
            };
            if let Some(process) = process {
                let exit = process.subscribe_exit();
                match process.kill() {
                    Ok(()) => match wait_for_terminal_process_tree_exit(Arc::clone(&process), exit)
                        .await
                    {
                        Ok(()) => closed.report.record_success(),
                        Err(error) => closed.report.record_failure(format!(
                            "terminal {}/{} process {}: {error}",
                            key.0,
                            key.1,
                            process.pid()
                        )),
                    },
                    Err(error) => closed.report.record_failure(format!(
                        "terminal {}/{} process {}: {error}",
                        key.0,
                        key.1,
                        process.pid()
                    )),
                }
            }
            closed.notifications.push(ClosedSessionNotification {
                thread_id: key.0,
                terminal_id: key.1,
                sequence,
            });
        }
        closed
    }

    fn publish_closed_sessions(&self, notifications: &[ClosedSessionNotification]) {
        for notification in notifications {
            let _ = self.inner.events.send(TerminalEvent::Closed {
                thread_id: notification.thread_id.clone(),
                terminal_id: notification.terminal_id.clone(),
                sequence: notification.sequence,
            });
            let _ = self.inner.metadata.send(TerminalMetadataEvent::Remove {
                thread_id: notification.thread_id.clone(),
                terminal_id: notification.terminal_id.clone(),
            });
        }
    }

    pub async fn subscribe_metadata(&self) -> TerminalMetadataAttachment {
        let events = self.inner.metadata.subscribe();
        let sessions = self.inner.sessions.read().await;
        let mut initial = Vec::with_capacity(sessions.len());
        for session in sessions.values() {
            initial.push(session.lock().await.summary());
        }
        initial.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.thread_id.cmp(&right.thread_id))
                .then_with(|| left.terminal_id.cmp(&right.terminal_id))
        });
        TerminalMetadataAttachment { initial, events }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<TerminalEvent> {
        self.inner.events.subscribe()
    }

    pub async fn shutdown(&self) {
        let report = self.shutdown_with_report().await;
        log_terminal_cleanup("shutdown", &report);
    }

    async fn shutdown_with_report(&self) -> ProcessCleanupReport {
        self.inner.cancellation.cancel();
        for generation in self.inner.generations.remove_all() {
            generation.stop_output().await;
            generation
                .cancel_and_invalidate(TerminalObserverCancellationReason::Shutdown)
                .await;
        }
        let _lifecycle = self.inner.lifecycle.lock().await;
        let keys = self
            .inner
            .sessions
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut report = ProcessCleanupReport::default();
        for (thread_id, terminal_id) in keys {
            let closed = self
                .close_sessions(
                    &thread_id,
                    Some(&terminal_id),
                    TerminalObserverCancellationReason::Shutdown,
                )
                .await;
            self.publish_closed_sessions(&closed.notifications);
            report.merge(closed.report);
        }
        if let Some(preparer) = self.inner.options.launch_preparer.as_ref() {
            preparer.shutdown().await;
        }
        report
    }

    async fn require_session(
        &self,
        thread_id: &str,
        terminal_id: &str,
    ) -> Result<SharedSession, TerminalError> {
        self.inner
            .sessions
            .read()
            .await
            .get(&(thread_id.to_string(), terminal_id.to_string()))
            .cloned()
            .ok_or_else(|| TerminalError::NotFound {
                thread_id: thread_id.to_string(),
                terminal_id: terminal_id.to_string(),
            })
    }
}

async fn wait_for_terminal_process_tree_exit(
    process: Arc<dyn PtyProcess>,
    mut root_exit: tokio::sync::watch::Receiver<Option<PtyExit>>,
) -> Result<(), String> {
    let tree_process = Arc::clone(&process);
    let tree_exit = tokio::task::spawn_blocking(move || {
        tree_process.wait_for_process_tree_exit(TERMINAL_CLOSE_WAIT_TIMEOUT)
    })
    .await
    .map_err(|error| format!("process-tree wait task failed: {error}"))??;

    match tree_exit {
        Some(true) => Ok(()),
        Some(false) => Err(format!(
            "process tree did not exit within {} ms",
            TERMINAL_CLOSE_WAIT_TIMEOUT.as_millis()
        )),
        None => {
            let already_exited = root_exit.borrow().is_some();
            let exited = already_exited
                || tokio::time::timeout(TERMINAL_CLOSE_WAIT_TIMEOUT, async {
                    while root_exit.borrow().is_none() {
                        root_exit.changed().await.map_err(|_| ())?;
                    }
                    Ok::<(), ()>(())
                })
                .await
                .ok()
                .and_then(Result::ok)
                .is_some();
            if exited {
                Ok(())
            } else {
                Err(format!(
                    "process did not exit within {} ms",
                    TERMINAL_CLOSE_WAIT_TIMEOUT.as_millis()
                ))
            }
        }
    }
}

fn log_terminal_cleanup(operation: &'static str, report: &ProcessCleanupReport) {
    if report.failure_count > 0 {
        tracing::warn!(
            operation,
            attempted = report.attempted,
            succeeded = report.succeeded,
            failed = report.failure_count,
            failures = ?report.failures,
            "terminal process-owner cleanup completed with failures"
        );
    }
}

pub struct TerminalAttachment {
    pub initial: TerminalSessionSnapshot,
    thread_id: String,
    terminal_id: String,
    next_sequence: u64,
    events: broadcast::Receiver<TerminalEvent>,
}

impl TerminalAttachment {
    pub async fn recv(&mut self) -> Option<TerminalEvent> {
        loop {
            match self.events.recv().await {
                Ok(event) if event.belongs_to(&self.thread_id, &self.terminal_id) => {
                    let sequence = event.sequence();
                    // A restarted session owns a fresh sequence space. Its
                    // authoritative reset must reach existing attachments even
                    // when the prior process had already advanced past it.
                    if matches!(event, TerminalEvent::Restarted { .. }) {
                        self.next_sequence = sequence;
                        return Some(event);
                    }
                    if sequence > self.next_sequence {
                        self.next_sequence = sequence;
                        return Some(event);
                    }
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

pub struct TerminalMetadataAttachment {
    pub initial: Vec<TerminalSummary>,
    events: broadcast::Receiver<TerminalMetadataEvent>,
}

impl TerminalMetadataAttachment {
    pub async fn recv(&mut self) -> Option<TerminalMetadataEvent> {
        loop {
            match self.events.recv().await {
                Ok(event) => return Some(event),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

fn invalidated_creation_error(input: &TerminalOpenInput) -> TerminalError {
    TerminalError::NotFound {
        thread_id: input.thread_id.clone(),
        terminal_id: input.terminal_id.clone(),
    }
}

async fn validate_cwd(cwd: &Path) -> Result<(), TerminalError> {
    match tokio::fs::metadata(cwd).await {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(TerminalError::CwdNotDirectory(
            cwd.to_string_lossy().into_owned(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(
            TerminalError::CwdNotFound(cwd.to_string_lossy().into_owned()),
        ),
        Err(error) => Err(TerminalError::Io(error.to_string())),
    }
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), TerminalError> {
    if !(1..=1_000).contains(&cols) || !(1..=500).contains(&rows) {
        return Err(TerminalError::Io(format!(
            "invalid terminal size {cols}x{rows}"
        )));
    }
    Ok(())
}

fn terminal_label(terminal_id: &str) -> String {
    terminal_id
        .strip_prefix("term-")
        .filter(|suffix| !suffix.is_empty())
        .map_or_else(
            || terminal_id.to_string(),
            |suffix| format!("Terminal {suffix}"),
        )
}

fn format_shell_candidate(candidate: &ShellCandidate) -> String {
    if candidate.args.is_empty() {
        candidate.command.clone()
    } else {
        format!("{} {}", candidate.command, candidate.args.join(" "))
    }
}

fn truncate_terminal_label(value: &str) -> String {
    let truncated = value
        .chars()
        .take(MAX_TERMINAL_LABEL_LENGTH)
        .collect::<String>();
    if truncated.is_empty() {
        value.to_string()
    } else {
        truncated
    }
}

fn normalize_child_command_name(raw: &str) -> Option<String> {
    let mut trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('(') && trimmed.ends_with(')'))
    {
        trimmed = trimmed[1..trimmed.len() - 1].trim();
    }
    let first_token = trimmed.split_whitespace().next()?.trim();
    if first_token.is_empty() {
        return None;
    }
    let base = first_token
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(first_token);
    let without_exe = if base.to_ascii_lowercase().ends_with(".exe") {
        &base[..base.len().saturating_sub(4)]
    } else {
        base
    };
    (!without_exe.is_empty()).then(|| without_exe.to_string())
}

fn redact_private_values(mut value: String, private_values: &[String]) -> String {
    for private_value in private_values {
        if !private_value.is_empty() {
            value = value.replace(private_value, "[redacted]");
        }
    }
    value
}

fn environment_keys_equal(platform: Platform, left: &str, right: &str) -> bool {
    match platform {
        Platform::Windows => left.eq_ignore_ascii_case(right),
        Platform::Unix => left == right,
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::{
        AttributionKind, AttributionScope, ProcessAttributionRegistry, ProcessRow,
    };
    use crate::{
        activity::{
            ActivityCapabilities, ActivityProjection, ActivityRepository, ProviderActivityMutation,
        },
        persistence::{Database, run_migrations},
        provider_terminal::{TerminalGenerationActivityPublisher, TerminalObserverWorkerContext},
    };
    use std::time::Instant;

    #[derive(Debug, Default)]
    struct ShutdownRecordingPreparer {
        calls: std::sync::atomic::AtomicUsize,
    }

    impl TerminalLaunchPreparer for ShutdownRecordingPreparer {
        fn prepare(
            &self,
            _input: TerminalLaunchPreparationInput,
        ) -> Pin<Box<dyn Future<Output = TerminalLaunchPreparation> + Send + '_>> {
            Box::pin(std::future::ready(TerminalLaunchPreparation::PassThrough))
        }

        fn shutdown(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(std::future::ready(()))
        }
    }

    #[derive(Debug)]
    struct RegistryObserver;

    impl PreparedTerminalObserver for RegistryObserver {
        fn on_spawned(
            &self,
            _pid: u32,
            _generation: TerminalObserverGenerationLease,
            _workers: TerminalObserverWorkerContext,
        ) {
        }

        fn diagnostic_label(&self) -> &str {
            "registry-observer"
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn observer_callback_slot_is_reusable_after_aborted_owner() {
        let global_slots = Arc::new(tokio::sync::Semaphore::new(1));
        let isolation = ObserverCallbackIsolation::with_global_slots(global_slots.clone());
        let started = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let owner = tokio::spawn({
            let isolation = isolation.clone();
            let started = started.clone();
            let release = release.clone();
            async move {
                run_observer_callback(
                    isolation,
                    "aborted_owner",
                    Duration::from_secs(5),
                    async move {
                        started.add_permits(1);
                        release
                            .acquire()
                            .await
                            .expect("callback release event")
                            .forget();
                    },
                )
                .await
            }
        });
        started
            .acquire()
            .await
            .expect("callback start event")
            .forget();

        owner.abort();
        assert!(
            owner
                .await
                .expect_err("aborted callback owner")
                .is_cancelled()
        );
        release.add_permits(1);
        let returned =
            tokio::time::timeout(Duration::from_secs(1), global_slots.clone().acquire_owned())
                .await
                .expect("aborted callback owner released its process slot after thread exit")
                .expect("callback capacity remains open");
        drop(returned);

        assert_eq!(
            run_observer_callback(
                isolation,
                "replacement_after_abort",
                Duration::from_secs(1),
                async { "replacement" },
            )
            .await,
            Some("replacement")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn observer_callback_slot_is_reusable_after_callback_panic() {
        let global_slots = Arc::new(tokio::sync::Semaphore::new(1));
        let isolation = ObserverCallbackIsolation::with_global_slots(global_slots.clone());
        assert_eq!(
            run_observer_callback(
                isolation.clone(),
                "panicked_callback",
                Duration::from_secs(1),
                async {
                    panic!("injected observer callback panic");
                },
            )
            .await,
            None
        );
        let returned =
            tokio::time::timeout(Duration::from_secs(1), global_slots.clone().acquire_owned())
                .await
                .expect("panicked callback released its process slot")
                .expect("callback capacity remains open");
        drop(returned);

        assert_eq!(
            run_observer_callback(
                isolation,
                "replacement_after_panic",
                Duration::from_secs(1),
                async { 7_u8 },
            )
            .await,
            Some(7)
        );
    }

    #[tokio::test]
    async fn hardening_restart_replacement_cancels_exact_displaced_generation_before_invalidation()
    {
        let registry = SessionGenerationRegistry::new(tokio::runtime::Handle::try_current().ok());
        let key = ("thread-race".to_owned(), "terminal-race".to_owned());
        let first = registry.current(&key);
        first.invalidate().await;
        let displaced = registry.current(&key);
        displaced
            .install_observer(PreparedObserverHandle::new(
                Box::new(RegistryObserver),
                displaced.observation.clone(),
                ObserverCallbackIsolation::default(),
            ))
            .expect("observer installation");

        let (exact_displaced, replacement) = registry.replace(&key);
        exact_displaced
            .expect("displaced generation")
            .cancel_and_invalidate(TerminalObserverCancellationReason::Restarted)
            .await;

        assert_eq!(
            displaced.observation.cancellation_reason(),
            Some(TerminalObserverCancellationReason::Restarted),
            "the exact generation displaced by replacement must receive cancellation"
        );
        assert!(!displaced.observation.is_current());
        assert!(replacement.observation.is_current());
    }

    #[tokio::test]
    async fn shutdown_drains_the_owned_launch_preparer_after_terminal_generations() {
        let preparer = Arc::new(ShutdownRecordingPreparer::default());
        let manager = TerminalManager::new(
            Arc::new(HistoryTestBackend::default()),
            TerminalManagerOptions {
                launch_preparer: Some(preparer.clone()),
                ..TerminalManagerOptions::default()
            },
        );

        manager.shutdown().await;
        manager.shutdown().await;

        assert_eq!(preparer.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn hardening_keyed_operation_registry_prunes_dead_entries() {
        let registry = SessionOperationRegistry::default();
        for terminal in 0..128 {
            drop(registry.for_key(&(
                "thread-operation-pruning".to_owned(),
                format!("terminal-{terminal}"),
            )));
        }
        let survivor = registry.for_key(&(
            "thread-operation-pruning".to_owned(),
            "terminal-survivor".to_owned(),
        ));
        assert_eq!(
            registry
                .operations
                .lock()
                .expect("operation registry lock")
                .len(),
            1,
            "dead logical-key locks accumulated in the operation registry"
        );
        drop(survivor);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hardening_publication_lifecycle_blocked_activity_does_not_block_another_key() {
        let root = tempfile::tempdir().expect("temp dir");
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::new(ActivityRepository::new(database));
        let manager = TerminalManager::new(
            Arc::new(HistoryTestBackend::default()),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let key = (
            "thread-publication".to_owned(),
            "terminal-blocked".to_owned(),
        );
        let generation = manager.inner.generations.current(&key);
        let publisher = TerminalGenerationActivityPublisher::new(
            generation.observation.clone(),
            projection.clone(),
            Arc::new(Mutex::new(())),
        );
        assert!(
            publisher
                .publish_correlated(
                    "codex",
                    Some("codex"),
                    ActivityCapabilities::structured_full(false),
                )
                .await
                .expect("scope publication")
        );
        let (entered, release) = projection.pause_before_publish_for_test(1);
        let entered_wait = entered.notified();
        tokio::pin!(entered_wait);
        let publish = tokio::spawn(async move {
            publisher
                .apply(
                    "event:block",
                    vec![
                        ProviderActivityMutation::upsert_actor(
                            "actor:block",
                            None,
                            "Blocked actor",
                            "running",
                        )
                        .expect("actor mutation"),
                    ],
                    "2026-07-25T12:00:00Z",
                )
                .await
        });
        entered_wait.await;

        let restart_manager = manager.clone();
        let restart_root = root.path().to_path_buf();
        let restart = tokio::spawn(async move {
            restart_manager
                .restart(TerminalOpenInput::new(
                    "thread-publication",
                    "terminal-blocked",
                    restart_root,
                    80,
                    24,
                ))
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !generation
                .closing
                .load(std::sync::atomic::Ordering::Acquire)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("restart reached invalidation");

        let unrelated = tokio::time::timeout(Duration::from_secs(1), async {
            manager
                .open(TerminalOpenInput::new(
                    "thread-publication",
                    "terminal-unrelated",
                    root.path().to_path_buf(),
                    80,
                    24,
                ))
                .await?;
            manager
                .attach(TerminalAttachInput::existing(
                    "thread-publication",
                    "terminal-unrelated",
                ))
                .await
        })
        .await;
        release.notify_one();
        publish
            .await
            .expect("publication task")
            .expect("activity publication");
        restart
            .await
            .expect("restart task")
            .expect("restart result");
        manager.shutdown().await;

        assert!(
            matches!(unrelated, Ok(Ok(_))),
            "activity publication held the global terminal lifecycle lock"
        );
    }

    #[derive(Debug)]
    struct HistoryTestPty {
        pid: u32,
        process_identity: Option<crate::diagnostics::ProcessIdentity>,
        exit_on_identity_read: std::sync::Mutex<Option<PtyExit>>,
        output: broadcast::Sender<String>,
        exit: tokio::sync::watch::Sender<Option<PtyExit>>,
        killed: std::sync::atomic::AtomicBool,
        exit_on_kill: std::sync::atomic::AtomicBool,
        tree_exit_supported: std::sync::atomic::AtomicBool,
        tree_exited: std::sync::atomic::AtomicBool,
        kill_error: std::sync::Mutex<Option<String>>,
        writes: std::sync::Mutex<Vec<String>>,
    }

    impl HistoryTestPty {
        fn new(pid: u32) -> Self {
            let (output, _) = broadcast::channel(16);
            let (exit, _) = tokio::sync::watch::channel(None);
            Self {
                pid,
                process_identity: None,
                exit_on_identity_read: std::sync::Mutex::new(None),
                output,
                exit,
                killed: std::sync::atomic::AtomicBool::new(false),
                exit_on_kill: std::sync::atomic::AtomicBool::new(true),
                tree_exit_supported: std::sync::atomic::AtomicBool::new(false),
                tree_exited: std::sync::atomic::AtomicBool::new(true),
                kill_error: std::sync::Mutex::new(None),
                writes: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn with_identity(pid: u32) -> Self {
            let mut process = Self::new(pid);
            process.process_identity =
                Some(crate::diagnostics::ProcessIdentity { pid, started_at: 0 });
            process
        }

        fn emit(&self, data: &str) {
            self.output.send(data.to_owned()).expect("output receiver");
        }

        fn is_killed(&self) -> bool {
            self.killed.load(std::sync::atomic::Ordering::Acquire)
        }

        fn writes(&self) -> Vec<String> {
            self.writes.lock().expect("writes lock").clone()
        }

        fn exit(&self, exit_code: i32) {
            self.exit
                .send(Some(PtyExit {
                    exit_code: Some(exit_code),
                    signal: None,
                }))
                .expect("exit receiver");
        }

        fn delay_exit_on_kill(&self) {
            self.exit_on_kill
                .store(false, std::sync::atomic::Ordering::Release);
        }

        fn keep_process_tree_running(&self) {
            self.tree_exit_supported
                .store(true, std::sync::atomic::Ordering::Release);
            self.tree_exited
                .store(false, std::sync::atomic::Ordering::Release);
        }

        fn fail_kill(&self, error: impl Into<String>) {
            *self.kill_error.lock().expect("kill error") = Some(error.into());
        }
    }

    impl PtyProcess for HistoryTestPty {
        fn pid(&self) -> u32 {
            self.pid
        }

        fn process_identity(&self) -> Option<crate::diagnostics::ProcessIdentity> {
            if let Some(exit) = self
                .exit_on_identity_read
                .lock()
                .expect("exit-on-identity-read lock")
                .take()
            {
                self.exit.send_replace(Some(exit));
            }
            self.process_identity
        }

        fn write(&self, data: &str) -> Result<(), String> {
            self.writes
                .lock()
                .expect("writes lock")
                .push(data.to_owned());
            Ok(())
        }

        fn resize(&self, _cols: u16, _rows: u16) -> Result<(), String> {
            Ok(())
        }

        fn kill(&self) -> Result<(), String> {
            self.killed
                .store(true, std::sync::atomic::Ordering::Release);
            let result = self
                .kill_error
                .lock()
                .expect("kill error")
                .clone()
                .map_or(Ok(()), Err);
            if result.is_ok() && self.exit_on_kill.load(std::sync::atomic::Ordering::Acquire) {
                self.exit.send_replace(Some(PtyExit {
                    exit_code: None,
                    signal: None,
                }));
            }
            result
        }

        fn wait_for_process_tree_exit(&self, _timeout: Duration) -> Result<Option<bool>, String> {
            if self
                .tree_exit_supported
                .load(std::sync::atomic::Ordering::Acquire)
            {
                Ok(Some(
                    self.tree_exited.load(std::sync::atomic::Ordering::Acquire),
                ))
            } else {
                Ok(None)
            }
        }

        fn subscribe_output(&self) -> broadcast::Receiver<String> {
            self.output.subscribe()
        }

        fn subscribe_exit(&self) -> tokio::sync::watch::Receiver<Option<PtyExit>> {
            self.exit.subscribe()
        }
    }

    #[derive(Debug, Default)]
    struct HistoryTestBackend {
        processes: std::sync::Mutex<Vec<Arc<HistoryTestPty>>>,
        spawns: std::sync::Mutex<Vec<PtySpawnInput>>,
        fail_spawns: bool,
        expose_process_identity: bool,
        exit_on_identity_read: Option<PtyExit>,
    }

    impl HistoryTestBackend {
        fn latest(&self) -> Arc<HistoryTestPty> {
            self.processes
                .lock()
                .expect("processes lock")
                .last()
                .cloned()
                .expect("spawned process")
        }

        fn spawns(&self) -> Vec<PtySpawnInput> {
            self.spawns.lock().expect("spawns lock").clone()
        }
    }

    impl PtyBackend for HistoryTestBackend {
        fn spawn(&self, input: &PtySpawnInput) -> Result<Arc<dyn PtyProcess>, String> {
            self.spawns.lock().expect("spawns lock").push(input.clone());
            if self.fail_spawns {
                return Err("provider spawn failed".to_owned());
            }
            let mut processes = self.processes.lock().expect("processes lock");
            let process = if self.expose_process_identity {
                HistoryTestPty::with_identity(processes.len() as u32 + 1)
            } else {
                HistoryTestPty::new(processes.len() as u32 + 1)
            };
            *process
                .exit_on_identity_read
                .lock()
                .expect("exit-on-identity-read lock") = self.exit_on_identity_read.clone();
            let process = Arc::new(process);
            processes.push(process.clone());
            Ok(process)
        }
    }

    #[tokio::test]
    async fn open_with_initial_input_submits_setup_before_publishing_the_terminal() {
        let root = tempfile::tempdir().expect("terminal root");
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(backend.clone(), TerminalManagerOptions::default());

        manager
            .open_with_initial_input_and_publication_cancellation(
                TerminalOpenInput::new(
                    "thread",
                    "setup-install",
                    root.path().to_path_buf(),
                    120,
                    30,
                ),
                "vp install\r".to_owned(),
                CancellationToken::new(),
            )
            .await
            .expect("terminal opens only after setup input is submitted");

        assert_eq!(backend.latest().writes(), ["vp install\r"]);
        assert_eq!(manager.subscribe_metadata().await.initial.len(), 1);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn setup_publication_cancellation_kills_the_uncommitted_process() {
        let root = tempfile::tempdir().expect("terminal root");
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(backend.clone(), TerminalManagerOptions::default());
        let generation = manager
            .inner
            .generations
            .current(&("thread".to_owned(), "setup-cancelled".to_owned()));
        let publication = generation.publication.lock().await;
        let cancellation = CancellationToken::new();
        let open_manager = manager.clone();
        let open_cancellation = cancellation.clone();
        let cwd = root.path().to_path_buf();
        let open = tokio::spawn(async move {
            open_manager
                .open_with_initial_input_and_publication_cancellation(
                    TerminalOpenInput::new("thread", "setup-cancelled", cwd, 120, 30),
                    "vp install\r".to_owned(),
                    open_cancellation,
                )
                .await
        });
        while backend.processes.lock().expect("processes").is_empty() {
            tokio::task::yield_now().await;
        }

        cancellation.cancel();
        drop(publication);
        assert!(matches!(
            open.await.expect("open task"),
            Err(TerminalError::PublicationCancelled)
        ));
        let process = backend
            .processes
            .lock()
            .expect("processes")
            .first()
            .cloned()
            .expect("spawned process");
        assert!(process.is_killed());
        assert!(
            manager
                .require_session("thread", "setup-cancelled")
                .await
                .is_err()
        );
    }

    #[derive(Debug)]
    struct BlockingSpawnBackend {
        process: Arc<HistoryTestPty>,
        started: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl PtyBackend for BlockingSpawnBackend {
        fn spawn(&self, _input: &PtySpawnInput) -> Result<Arc<dyn PtyProcess>, String> {
            if let Some(started) = self.started.lock().expect("started lock").take() {
                started.send(()).expect("spawn-started receiver");
            }
            self.release
                .lock()
                .expect("release lock")
                .recv_timeout(Duration::from_secs(2))
                .expect("spawn release");
            Ok(self.process.clone())
        }
    }

    #[derive(Debug)]
    struct FirstSpawnBlockingBackend {
        processes: std::sync::Mutex<Vec<Arc<HistoryTestPty>>>,
        spawn_count: std::sync::atomic::AtomicUsize,
        first_started: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
        first_release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        second_spawned: tokio::sync::Semaphore,
    }

    impl PtyBackend for FirstSpawnBlockingBackend {
        fn spawn(&self, _input: &PtySpawnInput) -> Result<Arc<dyn PtyProcess>, String> {
            let spawn_index = self
                .spawn_count
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            if spawn_index == 0 {
                if let Some(started) = self.first_started.lock().expect("started lock").take() {
                    started.send(()).expect("first-spawn receiver");
                }
                self.first_release
                    .lock()
                    .expect("release lock")
                    .recv_timeout(Duration::from_secs(2))
                    .expect("first-spawn release");
            } else {
                self.second_spawned.add_permits(1);
            }
            let process = Arc::new(HistoryTestPty::new(spawn_index as u32 + 1));
            self.processes
                .lock()
                .expect("processes lock")
                .push(process.clone());
            Ok(process)
        }
    }

    #[derive(Debug)]
    struct ReturningSpawnBackend {
        process: Arc<HistoryTestPty>,
        spawned: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    }

    impl PtyBackend for ReturningSpawnBackend {
        fn spawn(&self, _input: &PtySpawnInput) -> Result<Arc<dyn PtyProcess>, String> {
            if let Some(spawned) = self.spawned.lock().expect("spawned lock").take() {
                spawned.send(()).expect("spawned receiver");
            }
            Ok(self.process.clone())
        }
    }

    #[derive(Debug)]
    struct ControllableSubprocessInspector {
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
        inspection: SubprocessInspection,
    }

    impl TerminalSubprocessInspector for ControllableSubprocessInspector {
        fn inspect(
            &self,
            _terminal_pid: u32,
        ) -> Pin<Box<dyn Future<Output = Result<SubprocessInspection, String>> + Send + '_>>
        {
            Box::pin(async move {
                self.started.notify_one();
                self.release.notified().await;
                Ok(self.inspection.clone())
            })
        }
    }

    #[tokio::test]
    async fn close_waits_for_the_terminal_process_to_exit() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(backend.clone(), TerminalManagerOptions::default());

        manager
            .open(TerminalOpenInput::new(
                "thread-close",
                "term-close",
                root.path().to_path_buf(),
                80,
                24,
            ))
            .await
            .unwrap();
        let process = backend.latest();
        process.delay_exit_on_kill();
        let close_manager = manager.clone();
        let close = tokio::spawn(async move {
            close_manager
                .close("thread-close", Some("term-close"))
                .await
                .unwrap();
        });

        while !process.is_killed() {
            tokio::task::yield_now().await;
        }
        assert!(
            !close.is_finished(),
            "close returned before the killed process released its resources"
        );

        process.exit(0);
        tokio::time::timeout(Duration::from_secs(2), close)
            .await
            .expect("terminal close timed out")
            .expect("terminal close task");
    }

    #[tokio::test]
    async fn close_fails_while_the_terminal_process_tree_is_still_running() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(backend.clone(), TerminalManagerOptions::default());

        manager
            .open(TerminalOpenInput::new(
                "thread-tree-close",
                "term-tree-close",
                root.path().to_path_buf(),
                80,
                24,
            ))
            .await
            .unwrap();
        backend.latest().keep_process_tree_running();

        assert!(matches!(
            manager
                .close("thread-tree-close", Some("term-tree-close"))
                .await,
            Err(TerminalError::Close)
        ));
    }

    #[tokio::test]
    async fn close_during_in_flight_subprocess_inspection_does_not_resurrect_metadata() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let inspector = Arc::new(ControllableSubprocessInspector {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            inspection: SubprocessInspection {
                has_running_subprocess: true,
                child_command_label: Some("codex".to_owned()),
                process_ids: vec![1, 2],
            },
        });
        let manager = TerminalManager::new(
            backend,
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::from_millis(1),
                subprocess_inspector: Some(inspector.clone()),
                ..TerminalManagerOptions::default()
            },
        );
        let mut events = manager.subscribe_events();
        let mut metadata = manager.subscribe_metadata().await;

        manager
            .open(TerminalOpenInput::new(
                "thread-race",
                "term-race",
                root.path().to_path_buf(),
                80,
                24,
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), inspector.started.notified())
            .await
            .expect("subprocess inspection did not start");
        let activity_completed = manager
            .require_session("thread-race", "term-race")
            .await
            .unwrap()
            .lock()
            .await
            .generation
            .activity_completed
            .clone();

        manager
            .close("thread-race", Some("term-race"))
            .await
            .unwrap();

        loop {
            let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .expect("closed event timeout")
                .expect("terminal event sender");
            if matches!(
                event,
                TerminalEvent::Closed {
                    ref thread_id,
                    ref terminal_id,
                    ..
                } if thread_id == "thread-race" && terminal_id == "term-race"
            ) {
                break;
            }
        }
        loop {
            let event = tokio::time::timeout(Duration::from_secs(2), metadata.recv())
                .await
                .expect("metadata remove timeout")
                .expect("metadata event sender");
            if matches!(
                event,
                TerminalMetadataEvent::Remove {
                    ref thread_id,
                    ref terminal_id,
                } if thread_id == "thread-race" && terminal_id == "term-race"
            ) {
                break;
            }
        }

        inspector.release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), activity_completed.cancelled())
            .await
            .expect("activity supervisor did not complete after inspection release");
        let event_after_close = events.try_recv();
        let metadata_after_close = metadata.events.try_recv();
        assert!(
            matches!(
                event_after_close,
                Err(broadcast::error::TryRecvError::Empty)
            ),
            "terminal event emitted after close: {event_after_close:?}"
        );
        assert!(
            matches!(
                metadata_after_close,
                Err(broadcast::error::TryRecvError::Empty)
            ),
            "terminal metadata emitted after close: {metadata_after_close:?}"
        );
    }

    #[tokio::test]
    async fn structured_command_spawns_once_with_exact_program_args_cwd_and_env() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let mut input = TerminalOpenInput::new(
            "thread-provider",
            "term-provider",
            root.path().to_path_buf(),
            120,
            30,
        );
        input.env.insert("BIBCODE_TEST".to_owned(), "1".to_owned());
        input.command = Some(crate::terminal::TerminalLaunchCommand {
            executable: "/opt/Provider CLI/codex".to_owned(),
            args: vec!["--dangerously-bypass-approvals-and-sandbox".to_owned()],
            label: Some("Codex Terminal".to_owned()),
            activity: None,
        });

        let first = manager.open(input.clone()).await.unwrap();
        let second = manager.open(input).await.unwrap();

        assert_eq!(first.pid, second.pid);
        assert_eq!(first.label, "Codex Terminal");
        let spawns = backend.spawns();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].executable, "/opt/Provider CLI/codex");
        assert_eq!(
            spawns[0].args,
            vec!["--dangerously-bypass-approvals-and-sandbox"]
        );
        assert_eq!(spawns[0].cwd, root.path());
        assert_eq!(
            spawns[0].env.get("BIBCODE_TEST").map(String::as_str),
            Some("1")
        );
    }

    #[tokio::test]
    async fn attach_creates_a_missing_structured_command_without_shell_fallback() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let attachment = manager
            .attach(TerminalAttachInput {
                thread_id: "thread-provider".to_owned(),
                terminal_id: "term-provider".to_owned(),
                cwd: Some(root.path().to_path_buf()),
                worktree_path: Some(root.path().to_path_buf()),
                cols: Some(90),
                rows: Some(28),
                env: std::collections::BTreeMap::new(),
                restart_if_not_running: false,
                command: Some(crate::terminal::TerminalLaunchCommand {
                    executable: "claude".to_owned(),
                    args: vec!["--dangerously-skip-permissions".to_owned()],
                    label: Some("Claude Terminal".to_owned()),
                    activity: None,
                }),
            })
            .await
            .unwrap();

        assert_eq!(attachment.initial.label, "Claude Terminal");
        assert_eq!(backend.spawns().len(), 1);
        assert_eq!(backend.spawns()[0].executable, "claude");
    }

    #[tokio::test]
    async fn close_invalidates_an_older_missing_session_attach_before_creation() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let mut metadata = manager.subscribe_metadata().await;
        let sessions_guard = manager.inner.sessions.write().await;

        let attach_started = Arc::new(tokio::sync::Notify::new());
        let attach_manager = manager.clone();
        let attach_root = root.path().to_path_buf();
        let attach_started_task = attach_started.clone();
        let attach_task = tokio::spawn(async move {
            attach_started_task.notify_one();
            attach_manager
                .attach(TerminalAttachInput {
                    thread_id: "thread-attach-close".to_owned(),
                    terminal_id: "term-attach-close".to_owned(),
                    cwd: Some(attach_root.clone()),
                    worktree_path: Some(attach_root),
                    cols: Some(80),
                    rows: Some(24),
                    env: std::collections::BTreeMap::new(),
                    restart_if_not_running: false,
                    command: Some(crate::terminal::TerminalLaunchCommand {
                        executable: "codex".to_owned(),
                        args: vec!["--dangerously-bypass-approvals-and-sandbox".to_owned()],
                        label: Some("Codex Terminal".to_owned()),
                        activity: None,
                    }),
                })
                .await
        });
        attach_started.notified().await;

        let close_started = Arc::new(tokio::sync::Notify::new());
        let close_manager = manager.clone();
        let close_started_task = close_started.clone();
        let close_task = tokio::spawn(async move {
            close_started_task.notify_one();
            close_manager
                .close("thread-attach-close", Some("term-attach-close"))
                .await
                .unwrap();
        });
        close_started.notified().await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if manager.inner.lifecycle.try_lock().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("close did not acquire the lifecycle lock");

        drop(sessions_guard);
        close_task.await.expect("close task");
        let attach_result = attach_task.await.expect("attach task");

        assert!(
            matches!(attach_result, Err(TerminalError::NotFound { .. })),
            "older attach unexpectedly created a session"
        );
        assert!(backend.spawns().is_empty(), "invalidated attach spawned");
        assert!(
            manager
                .require_session("thread-attach-close", "term-attach-close")
                .await
                .is_err(),
            "invalidated attach registered a session"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), metadata.recv())
                .await
                .is_err(),
            "invalidated attach published terminal metadata"
        );

        let launched = manager
            .open(TerminalOpenInput::new(
                "thread-attach-close",
                "term-attach-close",
                root.path().to_path_buf(),
                80,
                24,
            ))
            .await
            .expect("a deliberate later launch must remain valid");
        assert_eq!(launched.status, TerminalStatus::Running);
        assert_eq!(backend.spawns().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_during_spawn_kills_the_invalidated_process_without_registering_it() {
        let root = tempfile::tempdir().unwrap();
        let process = Arc::new(HistoryTestPty::new(41));
        let (spawn_started, spawn_started_rx) = std::sync::mpsc::channel();
        let (spawn_release, spawn_release_rx) = std::sync::mpsc::channel();
        let manager = TerminalManager::new(
            Arc::new(BlockingSpawnBackend {
                process: process.clone(),
                started: std::sync::Mutex::new(Some(spawn_started)),
                release: std::sync::Mutex::new(spawn_release_rx),
            }),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let mut metadata = manager.subscribe_metadata().await;
        let generation = manager.inner.generations.current(&(
            "thread-spawn-close".to_owned(),
            "term-spawn-close".to_owned(),
        ));
        let attach_manager = manager.clone();
        let attach_root = root.path().to_path_buf();
        let attach_task = tokio::spawn(async move {
            attach_manager
                .attach(TerminalAttachInput {
                    thread_id: "thread-spawn-close".to_owned(),
                    terminal_id: "term-spawn-close".to_owned(),
                    cwd: Some(attach_root),
                    worktree_path: None,
                    cols: Some(80),
                    rows: Some(24),
                    env: std::collections::BTreeMap::new(),
                    restart_if_not_running: false,
                    command: None,
                })
                .await
        });
        tokio::task::spawn_blocking(move || {
            spawn_started_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("spawn did not start");
        })
        .await
        .expect("spawn-start wait");

        let close_manager = manager.clone();
        let close_task = tokio::spawn(async move {
            close_manager
                .close("thread-spawn-close", Some("term-spawn-close"))
                .await
                .unwrap();
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !generation.is_invalidated() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("close did not invalidate the in-flight generation");
        spawn_release.send(()).expect("release spawn");

        let attach_result = attach_task.await.expect("attach task");
        close_task.await.expect("close task");
        assert!(
            matches!(attach_result, Err(TerminalError::NotFound { .. })),
            "invalidated in-flight spawn unexpectedly attached"
        );
        assert!(process.is_killed(), "invalidated process was not killed");
        assert!(
            manager
                .require_session("thread-spawn-close", "term-spawn-close")
                .await
                .is_err(),
            "invalidated process was registered"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), metadata.recv())
                .await
                .is_err(),
            "invalidated process published terminal metadata"
        );
    }

    #[tokio::test]
    async fn aborting_open_after_spawn_before_registration_kills_the_unowned_process() {
        let root = tempfile::tempdir().unwrap();
        let process = Arc::new(HistoryTestPty::new(42));
        let (spawned, spawned_rx) = tokio::sync::oneshot::channel();
        let manager = TerminalManager::new(
            Arc::new(ReturningSpawnBackend {
                process: process.clone(),
                spawned: std::sync::Mutex::new(Some(spawned)),
            }),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let mut metadata = manager.subscribe_metadata().await;
        let generation = manager.inner.generations.current(&(
            "thread-aborted-open".to_owned(),
            "term-aborted-open".to_owned(),
        ));
        let publication = generation.publication.lock().await;

        let open_manager = manager.clone();
        let open_task = tokio::spawn(async move {
            open_manager
                .open(TerminalOpenInput::new(
                    "thread-aborted-open",
                    "term-aborted-open",
                    root.path().to_path_buf(),
                    80,
                    24,
                ))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), spawned_rx)
            .await
            .expect("spawn did not succeed")
            .expect("spawned sender");

        open_task.abort();
        let join_error = open_task
            .await
            .expect_err("aborted open unexpectedly completed");
        assert!(join_error.is_cancelled(), "open task was not cancelled");
        drop(publication);

        assert!(process.is_killed(), "abandoned process was not killed");
        assert!(
            manager
                .require_session("thread-aborted-open", "term-aborted-open")
                .await
                .is_err(),
            "aborted open registered a session"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), metadata.recv())
                .await
                .is_err(),
            "aborted open published terminal metadata"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn hardening_same_key_concurrent_open_spawns_exactly_one_process() {
        let root = tempfile::tempdir().expect("temp dir");
        let (first_started, first_started_rx) = std::sync::mpsc::channel();
        let (first_release, first_release_rx) = std::sync::mpsc::channel();
        let backend = Arc::new(FirstSpawnBlockingBackend {
            processes: std::sync::Mutex::new(Vec::new()),
            spawn_count: std::sync::atomic::AtomicUsize::new(0),
            first_started: std::sync::Mutex::new(Some(first_started)),
            first_release: std::sync::Mutex::new(first_release_rx),
            second_spawned: tokio::sync::Semaphore::new(0),
        });
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let input = TerminalOpenInput::new(
            "thread-concurrent-open",
            "terminal-concurrent-open",
            root.path().to_path_buf(),
            80,
            24,
        );
        let first_manager = manager.clone();
        let first_input = input.clone();
        let first = tokio::spawn(async move { first_manager.open(first_input).await });
        tokio::task::spawn_blocking(move || {
            first_started_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("first spawn did not start");
        })
        .await
        .expect("first-spawn wait");

        let second_manager = manager.clone();
        let second = tokio::spawn(async move { second_manager.open(input).await });
        let spawned_twice =
            tokio::time::timeout(Duration::from_millis(250), backend.second_spawned.acquire())
                .await
                .is_ok();
        first_release.send(()).expect("release first spawn");
        first
            .await
            .expect("first open task")
            .expect("first open result");
        second
            .await
            .expect("second open task")
            .expect("second open result");
        manager.shutdown().await;

        assert!(!spawned_twice, "same-key concurrent open spawned twice");
        assert_eq!(
            backend
                .spawn_count
                .load(std::sync::atomic::Ordering::Acquire),
            1
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn hardening_same_key_restart_serializes_exact_cleanup_through_replacement_start() {
        let root = tempfile::tempdir().expect("temp dir");
        let (first_started, first_started_rx) = std::sync::mpsc::channel();
        let (first_release, first_release_rx) = std::sync::mpsc::channel();
        let backend = Arc::new(FirstSpawnBlockingBackend {
            processes: std::sync::Mutex::new(Vec::new()),
            spawn_count: std::sync::atomic::AtomicUsize::new(0),
            first_started: std::sync::Mutex::new(Some(first_started)),
            first_release: std::sync::Mutex::new(first_release_rx),
            second_spawned: tokio::sync::Semaphore::new(0),
        });
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let input = TerminalOpenInput::new(
            "thread-concurrent-restart",
            "terminal-concurrent-restart",
            root.path().to_path_buf(),
            80,
            24,
        );
        let initial_manager = manager.clone();
        let initial_input = input.clone();
        let initial = tokio::spawn(async move { initial_manager.open(initial_input).await });
        tokio::task::spawn_blocking(move || {
            first_started_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("initial spawn did not start");
        })
        .await
        .expect("initial-spawn wait");
        first_release.send(()).expect("release initial spawn");
        initial
            .await
            .expect("initial open task")
            .expect("initial open");

        let barrier = Arc::new(PublisherBarrier {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        *manager
            .inner
            .restart_after_exact_cleanup_barrier
            .lock()
            .expect("restart barrier lock") = Some(barrier.clone());
        let first_restart_manager = manager.clone();
        let first_restart_input = input.clone();
        let first_restart =
            tokio::spawn(async move { first_restart_manager.restart(first_restart_input).await });
        tokio::time::timeout(Duration::from_secs(2), barrier.started.notified())
            .await
            .expect("first restart did not reach exact-cleanup barrier");

        let second_restart_manager = manager.clone();
        let second_restart =
            tokio::spawn(async move { second_restart_manager.restart(input).await });
        let spawned_during_stale_cleanup =
            tokio::time::timeout(Duration::from_millis(250), backend.second_spawned.acquire())
                .await
                .is_ok();
        barrier.release.notify_one();
        let first_result = first_restart.await.expect("first restart task");
        let second_result = second_restart.await.expect("second restart task");
        let latest_process = backend
            .processes
            .lock()
            .expect("processes lock")
            .last()
            .cloned()
            .expect("latest process");

        assert!(
            !spawned_during_stale_cleanup,
            "same-key replacement spawned while the prior operation still owned exact cleanup"
        );
        assert!(
            matches!(first_result, Err(TerminalError::NotFound { .. })),
            "the newer same-key restart must supersede the queued replacement"
        );
        second_result.expect("second restart");
        assert!(
            !latest_process.is_killed(),
            "stale same-key cleanup killed the replacement process"
        );
        assert_eq!(
            backend
                .spawn_count
                .load(std::sync::atomic::Ordering::Acquire),
            2
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn stale_output_after_close_and_same_key_reopen_cannot_hide_replacement_output() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let input = TerminalOpenInput::new(
            "thread-output-generation",
            "term-output-generation",
            root.path().to_path_buf(),
            80,
            24,
        );
        manager.open(input.clone()).await.unwrap();
        let old_session = manager
            .require_session("thread-output-generation", "term-output-generation")
            .await
            .unwrap();
        let old_process = backend.latest();
        old_process.emit("old-before-close");
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if old_session
                    .lock()
                    .await
                    .history
                    .snapshot()
                    .contains("old-before-close")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("old output was not published");
        let old_generation = old_session.lock().await.generation.clone();
        let output_completed = old_generation.output_completed.clone();
        let output_barrier = Arc::new(PublisherBarrier {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        *old_generation
            .output_barrier
            .lock()
            .expect("output barrier lock") = Some(output_barrier.clone());
        old_process.emit("stale-after-reopen");
        tokio::time::timeout(Duration::from_secs(2), output_barrier.started.notified())
            .await
            .expect("stale output publisher did not reach the barrier");

        manager
            .close("thread-output-generation", Some("term-output-generation"))
            .await
            .unwrap();
        manager.open(input).await.unwrap();
        let mut replacement = manager
            .attach(TerminalAttachInput::existing(
                "thread-output-generation",
                "term-output-generation",
            ))
            .await
            .unwrap();
        let replacement_process = backend.latest();

        output_barrier.release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), output_completed.cancelled())
            .await
            .expect("stale output publisher did not complete");
        replacement_process.emit("replacement-output");

        let received = tokio::time::timeout(Duration::from_secs(2), replacement.recv())
            .await
            .expect("replacement output timeout")
            .expect("terminal event sender");
        assert!(
            matches!(
                received,
                TerminalEvent::Output { ref data, .. } if data == "replacement-output"
            ),
            "replacement attachment accepted stale output: {received:?}"
        );
    }

    #[tokio::test]
    async fn hardening_redaction_lag_conservatively_redacts_a_buffered_secret_prefix() {
        let root = tempfile::tempdir().expect("temp dir");
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        manager
            .open(TerminalOpenInput::new(
                "thread-redaction-lag",
                "terminal-redaction-lag",
                root.path().to_path_buf(),
                80,
                24,
            ))
            .await
            .expect("terminal");
        let session = manager
            .require_session("thread-redaction-lag", "terminal-redaction-lag")
            .await
            .expect("session");
        session.lock().await.private_output =
            StreamingSecretRedactor::new(vec!["private-middle-suffix".to_owned()]);
        let process = backend.latest();
        process.emit("private-");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if session.lock().await.private_output.pending == "private-" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("prefix buffered");

        let generation = session.lock().await.generation.clone();
        let barrier = Arc::new(PublisherBarrier {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        *generation
            .output_barrier
            .lock()
            .expect("output barrier lock") = Some(barrier.clone());
        let started = barrier.started.notified();
        tokio::pin!(started);
        process.emit("");
        started.await;
        process.emit("middle-");
        for _ in 0..32 {
            process.emit("");
        }
        process.emit("suffix");
        *generation
            .output_barrier
            .lock()
            .expect("output barrier lock") = None;
        barrier.release.notify_one();

        let history = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let history = session.lock().await.history.snapshot();
                if !history.is_empty() {
                    break history;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("lag output");
        manager.shutdown().await;

        assert!(!history.contains("private-"), "{history}");
        assert!(!history.contains("middle-"), "{history}");
        assert!(!history.contains("suffix"), "{history}");
        assert!(history.contains("[redacted]"), "{history}");
    }

    #[tokio::test]
    async fn structured_command_failure_does_not_fall_back_to_a_shell_candidate() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend {
            fail_spawns: true,
            ..HistoryTestBackend::default()
        });
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                preferred_shell: Some("/bin/sh".to_owned()),
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let mut input = TerminalOpenInput::new(
            "thread-provider",
            "term-provider",
            root.path().to_path_buf(),
            120,
            30,
        );
        input.command = Some(crate::terminal::TerminalLaunchCommand {
            executable: "missing-provider".to_owned(),
            args: vec!["--direct".to_owned()],
            label: Some("Provider Terminal".to_owned()),
            activity: None,
        });

        let error = manager.open(input).await.unwrap_err();

        assert!(matches!(
            error,
            TerminalError::Spawn {
                ref attempted,
                ref message,
            } if attempted == &["missing-provider [\"--direct\"]"]
                && message == "provider spawn failed"
        ));
        let spawns = backend.spawns();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].executable, "missing-provider");
        assert_eq!(spawns[0].args, ["--direct"]);
    }

    #[tokio::test]
    async fn structured_command_restart_if_not_running_preserves_the_direct_launch() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let command = crate::terminal::TerminalLaunchCommand {
            executable: "claude".to_owned(),
            args: vec!["--dangerously-skip-permissions".to_owned()],
            label: Some("Claude Terminal".to_owned()),
            activity: None,
        };
        let mut input = TerminalOpenInput::new(
            "thread-provider",
            "term-provider",
            root.path().to_path_buf(),
            90,
            28,
        );
        input.command = Some(command.clone());
        manager.open(input).await.unwrap();

        let mut events = manager.subscribe_events();
        backend
            .latest()
            .exit
            .send(Some(PtyExit {
                exit_code: Some(0),
                signal: None,
            }))
            .unwrap();
        let exited = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(exited, TerminalEvent::Exited { .. }));

        let attachment = manager
            .attach(TerminalAttachInput {
                thread_id: "thread-provider".to_owned(),
                terminal_id: "term-provider".to_owned(),
                cwd: Some(root.path().to_path_buf()),
                worktree_path: Some(root.path().to_path_buf()),
                cols: Some(90),
                rows: Some(28),
                env: std::collections::BTreeMap::new(),
                restart_if_not_running: true,
                command: Some(command),
            })
            .await
            .unwrap();

        assert_eq!(attachment.initial.label, "Claude Terminal");
        let spawns = backend.spawns();
        assert_eq!(spawns.len(), 2);
        assert_eq!(spawns[1].executable, "claude");
        assert_eq!(spawns[1].args, ["--dangerously-skip-permissions"]);
    }

    #[tokio::test]
    async fn configured_history_survives_output_and_clear_but_restart_starts_fresh() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                history_line_limit: 2,
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let input = TerminalOpenInput::new(
            "thread-history",
            "term-history",
            root.path().to_path_buf(),
            80,
            24,
        );

        manager.open(input.clone()).await.unwrap();
        let original_session = manager
            .require_session("thread-history", "term-history")
            .await
            .unwrap();
        assert_eq!(original_session.lock().await.history.line_limit(), 2);

        let mut events = manager.subscribe_events();
        let process = backend.latest();
        for chunk in ["one\n", "two\n", "three\n"] {
            process.emit(chunk);
            let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .expect("output timeout")
                .expect("output event");
            assert!(matches!(event, TerminalEvent::Output { data, .. } if data == chunk));
        }

        let attachment = manager
            .attach(TerminalAttachInput::existing(
                "thread-history",
                "term-history",
            ))
            .await
            .unwrap();
        assert_eq!(attachment.initial.history, "two\nthree\n");

        manager
            .clear("thread-history", "term-history")
            .await
            .unwrap();
        let cleared = manager
            .attach(TerminalAttachInput::existing(
                "thread-history",
                "term-history",
            ))
            .await
            .unwrap();
        assert!(cleared.initial.history.is_empty());
        assert_eq!(original_session.lock().await.history.line_limit(), 2);

        let restarted = manager.restart(input).await.unwrap();
        assert!(restarted.history.is_empty());
        let restarted_session = manager
            .require_session("thread-history", "term-history")
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&original_session, &restarted_session));
        assert_eq!(restarted_session.lock().await.history.line_limit(), 2);
        assert_eq!(backend.processes.lock().expect("processes lock").len(), 2);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn workspace_quiesce_stops_every_process_and_retains_session_history() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        for terminal_id in ["term-one", "term-two"] {
            manager
                .open(TerminalOpenInput::new(
                    "thread-quiesce",
                    terminal_id,
                    root.path().to_path_buf(),
                    80,
                    24,
                ))
                .await
                .unwrap();
        }
        let mut events = manager.subscribe_events();
        for (process, transcript) in backend
            .processes
            .lock()
            .expect("processes")
            .iter()
            .zip(["retained-one\n", "retained-two\n"])
        {
            process.emit(transcript);
        }
        for _ in 0..2 {
            let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
                .await
                .expect("output timeout")
                .expect("output event");
            assert!(matches!(event, TerminalEvent::Output { .. }));
        }

        manager
            .quiesce_thread_preserving_history("thread-quiesce")
            .await
            .expect("quiesce");

        for (terminal_id, transcript) in [
            ("term-one", "retained-one\n"),
            ("term-two", "retained-two\n"),
        ] {
            let attachment = manager
                .attach(TerminalAttachInput::existing("thread-quiesce", terminal_id))
                .await
                .expect("retained terminal attaches");
            assert_eq!(attachment.initial.status, TerminalStatus::Exited);
            assert_eq!(attachment.initial.history, transcript);
        }
        assert!(
            backend
                .processes
                .lock()
                .expect("processes")
                .iter()
                .all(|process| process.is_killed())
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn exact_workspace_quiesce_skips_a_replacement_and_stops_other_captured_sessions() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        for terminal_id in ["term-replaced", "term-retained"] {
            manager
                .open(TerminalOpenInput::new(
                    "thread-exact-quiesce",
                    terminal_id,
                    root.path().to_path_buf(),
                    80,
                    24,
                ))
                .await
                .unwrap();
        }
        let captured = manager
            .capture_thread_session_identities("thread-exact-quiesce")
            .await;
        assert_eq!(captured.len(), 2, "cleanup captures every live session");

        manager
            .restart(TerminalRestartInput {
                thread_id: "thread-exact-quiesce".to_owned(),
                terminal_id: "term-replaced".to_owned(),
                cwd: root.path().to_path_buf(),
                worktree_path: None,
                cols: 80,
                rows: 24,
                env: std::collections::BTreeMap::new(),
                command: None,
            })
            .await
            .expect("recovered replacement starts");
        let processes = backend.processes.lock().expect("processes").clone();
        let replacement = processes.last().expect("replacement process").clone();
        let mut events = manager.subscribe_events();
        replacement.emit("replacement-history\n");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if matches!(events.recv().await, Ok(TerminalEvent::Output { data, .. }) if data == "replacement-history\n") {
                    break;
                }
            }
        })
        .await
        .expect("replacement output published");

        manager
            .quiesce_sessions_preserving_history_if_current(captured)
            .await
            .expect("stale exact cleanup");

        assert!(
            !replacement.is_killed(),
            "stale cleanup must not kill the recovered replacement"
        );
        manager
            .write("thread-exact-quiesce", "term-replaced", "still-usable")
            .await
            .expect("replacement remains writable");
        let replacement_attachment = manager
            .attach(TerminalAttachInput::existing(
                "thread-exact-quiesce",
                "term-replaced",
            ))
            .await
            .expect("replacement remains attachable");
        assert_eq!(
            replacement_attachment.initial.status,
            TerminalStatus::Running
        );
        assert_eq!(
            replacement_attachment.initial.history,
            "replacement-history\n"
        );
        let retained_attachment = manager
            .attach(TerminalAttachInput::existing(
                "thread-exact-quiesce",
                "term-retained",
            ))
            .await
            .expect("captured session history remains attachable");
        assert_eq!(retained_attachment.initial.status, TerminalStatus::Exited);
        assert!(processes[1].is_killed());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn workspace_quiesce_attempts_every_process_when_kills_fail() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        for terminal_id in ["term-one", "term-two"] {
            manager
                .open(TerminalOpenInput::new(
                    "thread-quiesce-errors",
                    terminal_id,
                    root.path().to_path_buf(),
                    80,
                    24,
                ))
                .await
                .unwrap();
        }
        let processes = backend.processes.lock().expect("processes").clone();
        for process in &processes {
            process.fail_kill("expected kill failure");
        }

        assert!(matches!(
            manager
                .quiesce_thread_preserving_history("thread-quiesce-errors")
                .await,
            Err(TerminalError::Close)
        ));
        assert!(
            processes.iter().all(|process| process.is_killed()),
            "one failed kill must not prevent later terminals from being signaled"
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn console_theme_survives_attach_and_updates_on_restart() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend,
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        let mut input = TerminalOpenInput::new(
            "thread-theme",
            "term-theme",
            root.path().to_path_buf(),
            80,
            24,
        );
        input.env.insert(
            "BIBCODE_WINDOWS_CONSOLE_THEME".to_owned(),
            "light".to_owned(),
        );

        let opened = manager.open(input.clone()).await.unwrap();
        assert_eq!(opened.console_theme, Some(TerminalConsoleTheme::Light));
        let attached = manager
            .attach(TerminalAttachInput::existing("thread-theme", "term-theme"))
            .await
            .unwrap();
        assert_eq!(
            attached.initial.console_theme,
            Some(TerminalConsoleTheme::Light)
        );
        let metadata = manager.subscribe_metadata().await;
        assert_eq!(metadata.initial.len(), 1);
        assert_eq!(
            metadata.initial[0].console_theme,
            Some(TerminalConsoleTheme::Light)
        );
        let mut events = manager.subscribe_events();
        let mut metadata_events = metadata.events;

        input.env.insert(
            "BIBCODE_WINDOWS_CONSOLE_THEME".to_owned(),
            "dark".to_owned(),
        );
        let restarted = manager.restart(input).await.unwrap();
        assert_eq!(restarted.console_theme, Some(TerminalConsoleTheme::Dark));
        assert!(matches!(
            events.recv().await.unwrap(),
            TerminalEvent::Restarted { snapshot, .. }
                if snapshot.console_theme == Some(TerminalConsoleTheme::Dark)
        ));
        assert!(matches!(
            metadata_events.recv().await.unwrap(),
            TerminalMetadataEvent::Upsert { terminal }
                if terminal.console_theme == Some(TerminalConsoleTheme::Dark)
        ));

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_covers_live_lifecycle_attachments_and_metadata() {
        let root = tempfile::tempdir().unwrap();
        let manager = TerminalManager::new(
            Arc::new(PortablePtyBackend),
            TerminalManagerOptions {
                history_line_limit: 2,
                preferred_shell: Some("/bin/sh".to_owned()),
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );

        let mut metadata = manager.subscribe_metadata().await;
        assert!(metadata.initial.is_empty());
        assert!(manager.resize("missing", "missing", 80, 24).await.is_ok());
        assert!(matches!(
            manager
                .attach(TerminalAttachInput::existing("missing", "missing"))
                .await,
            Err(TerminalError::NotFound { .. })
        ));

        let input = TerminalOpenInput::new(
            "thread-unit",
            "term-unit",
            root.path().to_path_buf(),
            80,
            24,
        );
        let opened = manager.open(input.clone()).await.unwrap();
        assert_eq!(opened.label, "Terminal unit");
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), metadata.recv())
                .await
                .unwrap(),
            Some(TerminalMetadataEvent::Upsert { .. })
        ));

        let mut attach_input = TerminalAttachInput::existing("thread-unit", "term-unit");
        attach_input.cols = Some(100);
        attach_input.rows = Some(30);
        let mut attachment = manager.attach(attach_input).await.unwrap();
        manager.write("thread-unit", "term-unit", "").await.unwrap();
        manager
            .resize("thread-unit", "term-unit", 120, 40)
            .await
            .unwrap();
        manager.clear("thread-unit", "term-unit").await.unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), attachment.recv())
                .await
                .unwrap(),
            Some(TerminalEvent::Cleared { .. })
        ));

        let restarted = manager.restart(input).await.unwrap();
        assert_eq!(restarted.status, TerminalStatus::Running);
        manager
            .close("thread-unit", Some("term-unit"))
            .await
            .unwrap();
        manager.shutdown().await;
    }

    fn terminal_claims(
        registry: &ProcessAttributionRegistry,
        pids: &[u32],
    ) -> Vec<crate::diagnostics::ProcessClaim> {
        let rows = pids
            .iter()
            .map(|pid| ProcessRow::fixture(*pid, 0, "shell"))
            .collect::<Vec<_>>();
        registry.bind_and_snapshot(&rows, Instant::now())
    }

    fn attributed_manager(
        backend: Arc<HistoryTestBackend>,
        registry: ProcessAttributionRegistry,
    ) -> TerminalManager {
        TerminalManager::with_process_attribution(
            backend,
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
            registry,
        )
    }

    #[tokio::test]
    async fn terminal_registration_tracks_start_and_exit() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend {
            expose_process_identity: true,
            ..HistoryTestBackend::default()
        });
        let registry = ProcessAttributionRegistry::new();
        let manager = attributed_manager(backend.clone(), registry.clone());
        let opened = manager
            .open(TerminalOpenInput::new(
                "thread-attributed",
                "term-attributed",
                root.path().to_path_buf(),
                80,
                24,
            ))
            .await
            .unwrap();
        let pid = opened.pid.expect("running terminal pid");
        let claims = terminal_claims(&registry, &[pid]);
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].scope, AttributionScope::External);
        assert_eq!(claims[0].kind, AttributionKind::Terminal);
        assert_eq!(claims[0].label, opened.label);

        let mut events = manager.subscribe_events();
        backend.latest().exit(0);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if matches!(
                    events.recv().await,
                    Ok(TerminalEvent::Exited {
                        thread_id,
                        terminal_id,
                        ..
                    }) if thread_id == "thread-attributed" && terminal_id == "term-attributed"
                ) {
                    break;
                }
            }
        })
        .await
        .expect("terminal exit event");
        assert!(terminal_claims(&registry, &[pid]).is_empty());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn exit_during_identity_registration_is_observed_and_releases_the_claim() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend {
            expose_process_identity: true,
            exit_on_identity_read: Some(PtyExit {
                exit_code: Some(17),
                signal: None,
            }),
            ..HistoryTestBackend::default()
        });
        let registry = ProcessAttributionRegistry::new();
        let manager = attributed_manager(backend, registry.clone());
        let mut events = manager.subscribe_events();
        let opened = manager
            .open(TerminalOpenInput::new(
                "thread-exited-during-start",
                "term-exited-during-start",
                root.path().to_path_buf(),
                80,
                24,
            ))
            .await
            .unwrap();
        let pid = opened.pid.expect("spawned terminal pid");

        let exit_event = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(event @ TerminalEvent::Exited { .. }) = events.recv().await {
                    break event;
                }
            }
        })
        .await
        .expect("already-observed terminal exit must be supervised");
        assert!(matches!(
            exit_event,
            TerminalEvent::Exited {
                exit_code: Some(17),
                ..
            }
        ));
        assert!(terminal_claims(&registry, &[pid]).is_empty());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_attempts_every_terminal_owner_and_bounds_failures() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(HistoryTestBackend::default());
        let manager = TerminalManager::new(
            backend.clone(),
            TerminalManagerOptions {
                subprocess_poll_interval: Duration::ZERO,
                ..TerminalManagerOptions::default()
            },
        );
        for index in 0..12 {
            manager
                .open(TerminalOpenInput::new(
                    "thread-cleanup",
                    format!("term-{index}"),
                    root.path().to_path_buf(),
                    80,
                    24,
                ))
                .await
                .expect("terminal opens");
        }
        for (index, process) in backend
            .processes
            .lock()
            .expect("processes lock")
            .iter()
            .enumerate()
        {
            if index != 1 {
                process.fail_kill("界".repeat(500));
            }
        }

        let report = manager.shutdown_with_report().await;

        assert_eq!(report.attempted, 12);
        assert_eq!(report.succeeded, 1);
        assert_eq!(report.failure_count, 11);
        assert!(report.failures.len() < report.failure_count);
        assert!(
            report
                .failures
                .iter()
                .all(|failure| failure.chars().count() <= 160)
        );
    }

    #[test]
    fn presentation_helpers_cover_history_and_process_labels() {
        let mut history = TerminalHistory::new(2);
        history.push("one\ntwo\nthree\n");
        history.push("four\n");
        assert_eq!(history.snapshot(), "three\nfour\n");
        let mut cleared = TerminalHistory::new(0);
        cleared.push("ignored");
        assert!(cleared.snapshot().is_empty());

        assert_eq!(
            normalize_child_command_name("[/usr/bin/node.exe --flag]"),
            Some("node".into())
        );
        assert_eq!(
            normalize_child_command_name("( cargo test )"),
            Some("cargo".into())
        );
        assert_eq!(normalize_child_command_name("[]"), None);
        assert_eq!(terminal_label("custom"), "custom");
        assert_eq!(terminal_label("term-"), "term-");
    }
}
