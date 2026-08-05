use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, LazyLock, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

use thiserror::Error;
use tokio::{
    runtime::Handle,
    sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, watch},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    activity::{
        ActivityCapabilities, ActivityDelta, ActivityProjection, ActivityResult, ActivityScopeSeed,
        AgentActivityAdmission, ProviderActivityMutation,
    },
    terminal::ProviderTerminalActivityLaunch,
};

const TERMINAL_SCOPE_PREFIX: &str = "terminal:";
const MAX_OBSERVER_WORKERS_PER_GENERATION: usize = 16;
const MAX_GLOBAL_OBSERVER_WORKERS: usize = 16;
const MAX_BLOCKING_THREADS_PER_OBSERVER_WORKER: usize = 1;

static GLOBAL_OBSERVER_WORKER_SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(MAX_GLOBAL_OBSERVER_WORKERS)));
static GLOBAL_OBSERVER_WORKER_JOIN_REAPER: LazyLock<Option<TerminalObserverWorkerJoinReaper>> =
    LazyLock::new(TerminalObserverWorkerJoinReaper::start);

struct TerminalObserverWorkerRegistryState {
    accepting: bool,
    workers: Vec<TerminalObserverWorker>,
    cleanup: Option<watch::Sender<bool>>,
}

struct TerminalObserverWorker {
    abort: CancellationToken,
    completion: watch::Receiver<bool>,
}

struct TerminalObserverWorkerJoin {
    thread: std::thread::JoinHandle<()>,
    global_permit: OwnedSemaphorePermit,
    completion: watch::Sender<bool>,
    #[cfg(test)]
    thread_exit_hook: Option<Arc<WorkerThreadExitTestHook>>,
}

struct TerminalObserverWorkerJoinReaper {
    sender: mpsc::Sender<TerminalObserverWorkerJoinReaperMessage>,
}

enum TerminalObserverWorkerJoinReaperMessage {
    Register {
        id: Uuid,
        worker: TerminalObserverWorkerJoin,
    },
    Finished {
        id: Uuid,
    },
}

#[cfg(test)]
#[derive(Debug)]
struct WorkerThreadExitTestHook {
    before_completion_reached: Arc<tokio::sync::Semaphore>,
    completion_release: Arc<(StdMutex<bool>, std::sync::Condvar)>,
    before_exit_reached: Arc<tokio::sync::Semaphore>,
    exit_release: Arc<(StdMutex<bool>, std::sync::Condvar)>,
    before_join_reached: Arc<tokio::sync::Semaphore>,
    join_release: Arc<(StdMutex<bool>, std::sync::Condvar)>,
}

#[cfg(test)]
impl WorkerThreadExitTestHook {
    fn block(reached: &tokio::sync::Semaphore, release: &(StdMutex<bool>, std::sync::Condvar)) {
        reached.add_permits(1);
        let mut released = release
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !*released {
            released = release
                .1
                .wait(released)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn release(release: &(StdMutex<bool>, std::sync::Condvar)) {
        *release
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        release.1.notify_all();
    }

    fn block_before_completion(&self) {
        Self::block(&self.before_completion_reached, &self.completion_release);
    }

    fn release_completion(&self) {
        Self::release(&self.completion_release);
    }

    fn block_before_exit(&self) {
        Self::block(&self.before_exit_reached, &self.exit_release);
    }

    fn release_exit(&self) {
        Self::release(&self.exit_release);
    }

    fn block_before_join(&self) {
        Self::block(&self.before_join_reached, &self.join_release);
    }

    fn release_join(&self) {
        Self::release(&self.join_release);
    }
}

impl TerminalObserverWorker {
    fn is_complete(&self) -> bool {
        *self.completion.borrow()
    }

    async fn wait_until(&mut self, deadline: Instant) -> bool {
        if self.is_complete() {
            return true;
        }
        tokio::time::timeout_at(deadline, async {
            loop {
                if self.is_complete() {
                    break;
                }
                tokio::select! {
                    _ = self.completion.changed() => {}
                    () = tokio::time::sleep(Duration::from_millis(1)) => {}
                }
            }
        })
        .await
        .is_ok()
    }
}

impl TerminalObserverWorkerJoin {
    fn is_finished(&self) -> bool {
        self.thread.is_finished()
    }

    fn join(self) {
        #[cfg(test)]
        if let Some(thread_exit_hook) = self.thread_exit_hook {
            thread_exit_hook.block_before_join();
        }
        if self.thread.join().is_err() {
            tracing::warn!("provider terminal observer worker thread panicked");
        }
        drop(self.global_permit);
        self.completion.send_replace(true);
    }
}

impl TerminalObserverWorkerJoinReaper {
    fn start() -> Option<Self> {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("terminal-observer-join-reaper".to_owned())
            .spawn(move || Self::run(receiver))
            .ok()?;
        Some(Self { sender })
    }

    fn submit(
        &self,
        id: Uuid,
        worker: TerminalObserverWorkerJoin,
    ) -> Result<(), TerminalObserverWorkerJoin> {
        self.sender
            .send(TerminalObserverWorkerJoinReaperMessage::Register { id, worker })
            .map_err(|error| match error.0 {
                TerminalObserverWorkerJoinReaperMessage::Register { worker, .. } => worker,
                TerminalObserverWorkerJoinReaperMessage::Finished { .. } => {
                    unreachable!("submit only sends worker registration")
                }
            })?;
        Ok(())
    }

    fn run(receiver: mpsc::Receiver<TerminalObserverWorkerJoinReaperMessage>) {
        let mut pending = BTreeMap::new();
        let mut ready = BTreeMap::new();
        let mut finished = BTreeSet::new();
        loop {
            let completed = ready
                .iter()
                .filter_map(|(id, worker): (&Uuid, &TerminalObserverWorkerJoin)| {
                    worker.is_finished().then_some(*id)
                })
                .collect::<Vec<_>>();
            for id in completed {
                if let Some(worker) = ready.remove(&id) {
                    worker.join();
                }
            }
            let message = if ready.is_empty() {
                match receiver.recv() {
                    Ok(message) => message,
                    Err(_) => return,
                }
            } else {
                match receiver.recv_timeout(Duration::from_millis(1)) {
                    Ok(message) => message,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            };
            match message {
                TerminalObserverWorkerJoinReaperMessage::Register { id, worker } => {
                    if finished.remove(&id) {
                        ready.insert(id, worker);
                    } else {
                        pending.insert(id, worker);
                    }
                }
                TerminalObserverWorkerJoinReaperMessage::Finished { id } => {
                    if let Some(worker) = pending.remove(&id) {
                        ready.insert(id, worker);
                    } else {
                        finished.insert(id);
                    }
                }
            }
        }
    }
}

struct TerminalObserverWorkerRegistry {
    runtime: Option<Handle>,
    cancellation: CancellationToken,
    state: StdMutex<TerminalObserverWorkerRegistryState>,
    #[cfg(test)]
    thread_exit_hook: StdMutex<Option<Arc<WorkerThreadExitTestHook>>>,
}

impl fmt::Debug for TerminalObserverWorkerRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        formatter
            .debug_struct("TerminalObserverWorkerRegistry")
            .field("runtime_available", &self.runtime.is_some())
            .field("accepting", &state.accepting)
            .field("worker_count", &state.workers.len())
            .field("cleanup_started", &state.cleanup.is_some())
            .finish()
    }
}

impl TerminalObserverWorkerRegistry {
    fn new(runtime: Option<Handle>, cancellation: CancellationToken) -> Self {
        Self {
            runtime,
            cancellation,
            state: StdMutex::new(TerminalObserverWorkerRegistryState {
                accepting: true,
                workers: Vec::new(),
                cleanup: None,
            }),
            #[cfg(test)]
            thread_exit_hook: StdMutex::new(None),
        }
    }

    fn stop_accepting(&self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .accepting = false;
    }

    fn spawn(
        &self,
        worker: impl Future<Output = ()> + Send + 'static,
    ) -> Result<(), TerminalObserverWorkerSpawnError> {
        if self.runtime.is_none() {
            return Err(TerminalObserverWorkerSpawnError::RuntimeUnavailable);
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut index = 0;
        while index < state.workers.len() {
            if state.workers[index].is_complete() {
                state.workers.swap_remove(index);
            } else {
                index += 1;
            }
        }
        if !state.accepting || self.cancellation.is_cancelled() {
            return Err(TerminalObserverWorkerSpawnError::GenerationClosing);
        }
        if state.workers.len() >= MAX_OBSERVER_WORKERS_PER_GENERATION {
            return Err(TerminalObserverWorkerSpawnError::CapacityExceeded);
        }
        let Some(join_reaper) = GLOBAL_OBSERVER_WORKER_JOIN_REAPER.as_ref() else {
            return Err(TerminalObserverWorkerSpawnError::WorkerStartFailed);
        };
        let global_permit = GLOBAL_OBSERVER_WORKER_SLOTS
            .clone()
            .try_acquire_owned()
            .map_err(|_| TerminalObserverWorkerSpawnError::CapacityExceeded)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(MAX_BLOCKING_THREADS_PER_OBSERVER_WORKER)
            .build()
            .map_err(|_| TerminalObserverWorkerSpawnError::RuntimeUnavailable)?;
        let abort = CancellationToken::new();
        let worker_abort = abort.clone();
        let (completion_sender, completion_receiver) = watch::channel(false);
        let worker_id = Uuid::new_v4();
        let join_reaper_sender = join_reaper.sender.clone();
        #[cfg(test)]
        let thread_exit_hook = self
            .thread_exit_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        #[cfg(test)]
        let worker_thread_exit_hook = thread_exit_hook.clone();
        let thread = std::thread::Builder::new()
            .name("terminal-observer-worker".to_owned())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    runtime.block_on(async move {
                        tokio::select! {
                            biased;
                            _ = worker_abort.cancelled() => {}
                            _ = worker => {}
                        }
                    });
                }));
                drop(runtime);
                if result.is_err() {
                    tracing::warn!("provider terminal observer worker panicked");
                }
                #[cfg(test)]
                if let Some(thread_exit_hook) = &worker_thread_exit_hook {
                    thread_exit_hook.block_before_completion();
                }
                #[cfg(test)]
                if let Some(thread_exit_hook) = worker_thread_exit_hook {
                    thread_exit_hook.block_before_exit();
                }
                let _ = join_reaper_sender
                    .send(TerminalObserverWorkerJoinReaperMessage::Finished { id: worker_id });
            })
            .map_err(|_| TerminalObserverWorkerSpawnError::WorkerStartFailed)?;
        let join = TerminalObserverWorkerJoin {
            thread,
            global_permit,
            completion: completion_sender,
            #[cfg(test)]
            thread_exit_hook,
        };
        if let Err(join) = join_reaper.submit(worker_id, join) {
            abort.cancel();
            tracing::error!(
                "provider terminal observer join reaper stopped; retaining worker ownership"
            );
            std::mem::forget(join);
            return Err(TerminalObserverWorkerSpawnError::WorkerStartFailed);
        }
        state.workers.push(TerminalObserverWorker {
            abort,
            completion: completion_receiver,
        });
        Ok(())
    }

    async fn shutdown(self: &Arc<Self>, graceful_timeout: Duration, abort_timeout: Duration) {
        let (mut completion, reaper) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.accepting = false;
            if let Some(completion) = &state.cleanup {
                (completion.subscribe(), None)
            } else {
                let (completion, receiver) = watch::channel(false);
                let workers = std::mem::take(&mut state.workers);
                state.cleanup = Some(completion.clone());
                (receiver, Some((self.runtime.clone(), workers, completion)))
            }
        };
        if let Some((runtime, workers, completion)) = reaper {
            if workers.is_empty() {
                completion.send_replace(true);
            } else if let Some(runtime) = runtime {
                runtime.spawn(async move {
                    reap_observer_workers(workers, graceful_timeout, abort_timeout).await;
                    completion.send_replace(true);
                });
            } else {
                completion.send_replace(true);
            }
        }
        while !*completion.borrow() {
            if completion.changed().await.is_err() {
                break;
            }
        }
    }
}

async fn reap_observer_workers(
    workers: Vec<TerminalObserverWorker>,
    graceful_timeout: Duration,
    abort_timeout: Duration,
) {
    let graceful_deadline = Instant::now() + graceful_timeout;
    let mut pending = Vec::new();
    let mut workers = workers.into_iter();
    while let Some(mut worker) = workers.next() {
        if !worker.wait_until(graceful_deadline).await {
            pending.push(worker);
            pending.extend(workers);
            break;
        }
    }
    if pending.is_empty() {
        return;
    }
    for worker in &pending {
        worker.abort.cancel();
    }
    let abort_deadline = Instant::now() + abort_timeout;
    for mut worker in pending {
        if !worker.wait_until(abort_deadline).await {
            tracing::warn!(
                timeout_ms = abort_timeout.as_millis(),
                "provider terminal observer worker did not stop after abort"
            );
        }
    }
}

/// Manager-owned spawner for generation-scoped observer workers.
///
/// Each admitted worker runs on its own current-thread Tokio runtime, survives
/// the short-lived preparation callback runtime, and is drained or aborted when
/// the generation closes. Admission is capped at sixteen workers process-wide;
/// each worker runtime has at most one blocking-pool thread, for a strict bound
/// of thirty-two manager-created worker threads. The process permit remains
/// paired with the worker's join handle in one process-lifetime reaper until
/// joining confirms that the worker OS thread has exited, including after
/// teardown times out. One additional process-lifetime join-reaper thread owns
/// those pairs and restores capacity without relying on a later manager
/// operation. This is a lifecycle contract for trusted observer code, not a
/// sandbox: callback code can still create unmanaged raw OS threads outside
/// this registry.
#[derive(Clone)]
pub struct TerminalObserverWorkerContext {
    inner: Arc<TerminalObserverWorkerRegistry>,
}

impl fmt::Debug for TerminalObserverWorkerContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalObserverWorkerContext")
            .field("registry", &self.inner)
            .finish()
    }
}

impl TerminalObserverWorkerContext {
    /// Starts one durable, process-bounded worker on manager-owned isolation.
    pub fn spawn(
        &self,
        worker: impl Future<Output = ()> + Send + 'static,
    ) -> Result<(), TerminalObserverWorkerSpawnError> {
        self.inner.spawn(worker)
    }

    /// Waits for this terminal generation's one-shot cancellation signal.
    pub async fn cancelled(&self) {
        self.inner.cancellation.cancelled().await;
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum TerminalObserverWorkerSpawnError {
    #[error("the production Tokio runtime is unavailable")]
    RuntimeUnavailable,
    #[error("the terminal observer generation is closing")]
    GenerationClosing,
    #[error("the terminal observer generation worker capacity is exhausted")]
    CapacityExceeded,
    #[error("the manager-owned observer worker thread could not be started")]
    WorkerStartFailed,
}

#[derive(Debug)]
struct TerminalObserverGenerationInner {
    id: Uuid,
    scope_id: String,
    thread_id: String,
    terminal_id: String,
    current: AtomicBool,
    activity_publication: StdMutex<Option<Arc<AsyncMutex<()>>>>,
    cancellation_reason: StdMutex<Option<TerminalObserverCancellationReason>>,
    cancellation_requested_while_current: AtomicBool,
    cancellation: CancellationToken,
    workers: TerminalObserverWorkerContext,
}

/// Generation identity shared with a prepared observer.
///
/// Observer output is only publishable while this handle remains current.
#[derive(Clone, Debug)]
pub struct TerminalObserverGeneration {
    inner: Arc<TerminalObserverGenerationInner>,
}

impl TerminalObserverGeneration {
    pub fn new(thread_id: String, terminal_id: String) -> Self {
        Self::new_with_runtime(thread_id, terminal_id, Handle::try_current().ok())
    }

    pub(crate) fn new_with_runtime(
        thread_id: String,
        terminal_id: String,
        runtime: Option<Handle>,
    ) -> Self {
        let id = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        Self {
            inner: Arc::new(TerminalObserverGenerationInner {
                id,
                scope_id: format!("{TERMINAL_SCOPE_PREFIX}{id}"),
                thread_id,
                terminal_id,
                current: AtomicBool::new(true),
                activity_publication: StdMutex::new(None),
                cancellation_reason: StdMutex::new(None),
                cancellation_requested_while_current: AtomicBool::new(false),
                cancellation: cancellation.clone(),
                workers: TerminalObserverWorkerContext {
                    inner: Arc::new(TerminalObserverWorkerRegistry::new(runtime, cancellation)),
                },
            }),
        }
    }

    /// Fresh UUID assigned to this terminal process generation.
    pub fn id(&self) -> Uuid {
        self.inner.id
    }

    /// UUID text used as the activity projection generation ID.
    pub fn generation_id(&self) -> String {
        self.inner.id.to_string()
    }

    /// Bounded canonical provider activity scope for this generation.
    pub fn scope_id(&self) -> &str {
        &self.inner.scope_id
    }

    pub fn thread_id(&self) -> &str {
        &self.inner.thread_id
    }

    pub fn terminal_id(&self) -> &str {
        &self.inner.terminal_id
    }

    /// Provider-native identity made unique to this process generation.
    pub fn namespace_native_id(&self, native_id: &str) -> String {
        const MAX_ACTIVITY_ID_LENGTH: usize = 256;

        let prefix = format!("{}:", self.generation_id());
        if prefix.len().saturating_add(native_id.len()) <= MAX_ACTIVITY_ID_LENGTH {
            return format!("{prefix}{native_id}");
        }
        format!("{prefix}{}", crate::crypto::sha256_hex(native_id))
    }

    /// Whether output and capability publication still belongs to the current generation.
    pub fn is_current(&self) -> bool {
        self.inner.current.load(Ordering::Acquire)
    }

    /// Returns the first lifecycle reason that requested observer cancellation.
    #[must_use]
    pub fn cancellation_reason(&self) -> Option<TerminalObserverCancellationReason> {
        *self
            .inner
            .cancellation_reason
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Waits for the manager-owned, one-shot observer cancellation signal.
    pub async fn cancelled(&self) -> TerminalObserverCancellationReason {
        loop {
            let notified = self.inner.cancellation.cancelled();
            if let Some(reason) = self.cancellation_reason() {
                return reason;
            }
            notified.await;
        }
    }

    /// Whether the one-shot cancellation request preceded publication invalidation.
    #[must_use]
    pub fn cancellation_was_requested_while_current(&self) -> bool {
        self.inner
            .cancellation_requested_while_current
            .load(Ordering::Acquire)
    }

    /// Durable generation-scoped worker context for provider observers.
    #[must_use]
    pub fn worker_context(&self) -> TerminalObserverWorkerContext {
        self.inner.workers.clone()
    }

    pub(crate) fn request_cancellation(&self, reason: TerminalObserverCancellationReason) -> bool {
        let mut current = self
            .inner
            .cancellation_reason
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if current.is_some() {
            return false;
        }
        self.inner
            .cancellation_requested_while_current
            .store(self.is_current(), Ordering::Release);
        *current = Some(reason);
        self.inner.workers.inner.stop_accepting();
        self.inner.cancellation.cancel();
        true
    }

    pub(crate) async fn shutdown_workers(
        &self,
        graceful_timeout: Duration,
        abort_timeout: Duration,
    ) {
        self.inner
            .workers
            .inner
            .shutdown(graceful_timeout, abort_timeout)
            .await;
    }

    pub(crate) fn attach_activity_publication(
        &self,
        lock: Arc<AsyncMutex<()>>,
    ) -> Arc<AsyncMutex<()>> {
        let mut publication = self
            .inner
            .activity_publication
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        publication.get_or_insert(lock).clone()
    }

    pub(crate) async fn invalidate(&self) {
        let publication = self
            .inner
            .activity_publication
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let _publication_guard = match publication {
            Some(publication) => Some(publication.lock_owned().await),
            None => None,
        };
        self.inner.current.store(false, Ordering::Release);
    }
}

/// Generation-fenced activity publisher supplied to concrete provider observers.
///
/// A factory invokes `publish_correlated` only after its provider-native
/// handshake has identified the session and negotiated real capabilities.
#[derive(Clone)]
pub struct TerminalGenerationActivityPublisher {
    generation: TerminalObserverGeneration,
    projection: ActivityProjection,
    publication: Arc<AsyncMutex<()>>,
}

impl fmt::Debug for TerminalGenerationActivityPublisher {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalGenerationActivityPublisher")
            .field("scope_id", &self.generation.scope_id())
            .field("current", &self.generation.is_current())
            .finish_non_exhaustive()
    }
}

impl TerminalGenerationActivityPublisher {
    pub(crate) fn new(
        generation: TerminalObserverGeneration,
        projection: ActivityProjection,
        publication: Arc<AsyncMutex<()>>,
    ) -> Self {
        let publication = generation.attach_activity_publication(publication);
        Self {
            generation,
            projection,
            publication,
        }
    }

    /// Publishes the generation scope after provider-native correlation succeeds.
    pub async fn publish_correlated(
        &self,
        provider: &str,
        provider_instance_id: Option<&str>,
        capabilities: ActivityCapabilities,
    ) -> ActivityResult<bool> {
        let _publication_guard = self.publication.lock().await;
        if !self.generation.is_current() {
            return Ok(false);
        }
        let seed = ActivityScopeSeed::terminal(
            self.generation.scope_id(),
            self.generation.generation_id(),
            self.generation.thread_id(),
            self.generation.terminal_id(),
            provider,
            provider_instance_id,
            capabilities,
        )?;
        self.projection.ensure_scope(seed).await?;
        Ok(true)
    }

    /// Applies provider mutations only while this generation remains current.
    pub async fn apply(
        &self,
        native_event_key: &str,
        mutations: Vec<ProviderActivityMutation>,
        created_at: &str,
    ) -> ActivityResult<Vec<ActivityDelta>> {
        let _publication_guard = self.publication.lock().await;
        if !self.generation.is_current() {
            return Ok(Vec::new());
        }
        self.projection
            .apply(
                self.generation.scope_id(),
                self.generation.namespace_native_id(native_event_key),
                mutations,
                created_at.to_owned(),
            )
            .await
    }

    /// Applies mutations only while both the terminal generation and exact
    /// provider activity admission remain current.
    ///
    /// Lock order is generation publication followed by activity publication.
    /// The activity transition path acquires only activity publication before
    /// its synchronous state lock, and observation commits acquire only the
    /// state lock. Keeping both publication guards through projection apply
    /// makes publication and the exact activity transition serializable
    /// without introducing a lock cycle.
    pub(crate) async fn apply_admitted(
        &self,
        activity: &TerminalAgentActivityControl,
        admission: &TerminalAgentActivityAdmission,
        native_event_key: &str,
        mutations: Vec<ProviderActivityMutation>,
        created_at: &str,
    ) -> ActivityResult<Vec<ActivityDelta>> {
        let mut activity_changes = activity.subscribe();
        if self.generation.cancellation_reason().is_some()
            || !self.generation.is_current()
            || !activity.admission_is_current(admission)
        {
            return Ok(Vec::new());
        }
        let _publication_guard = tokio::select! {
            biased;
            _ = self.generation.cancelled() => return Ok(Vec::new()),
            _ = activity.wait_until_admission_invalidated(
                admission,
                &mut activity_changes,
            ) => return Ok(Vec::new()),
            guard = self.publication.lock() => guard,
        };
        let _activity_publication_guard = tokio::select! {
            biased;
            _ = self.generation.cancelled() => return Ok(Vec::new()),
            _ = activity.wait_until_admission_invalidated(
                admission,
                &mut activity_changes,
            ) => return Ok(Vec::new()),
            guard = activity.publication.lock() => guard,
        };
        if self.generation.cancellation_reason().is_some()
            || !self.generation.is_current()
            || !activity.admission_is_current(admission)
        {
            return Ok(Vec::new());
        }
        self.projection
            .apply(
                self.generation.scope_id(),
                self.generation.namespace_native_id(native_event_key),
                mutations,
                created_at.to_owned(),
            )
            .await
    }

    /// Namespaces a provider-native identity by the current process generation.
    #[must_use]
    pub fn namespace_native_id(&self, native_id: &str) -> String {
        self.generation.namespace_native_id(native_id)
    }

    #[must_use]
    pub fn scope_id(&self) -> &str {
        self.generation.scope_id()
    }
}

#[derive(Clone)]
pub struct TerminalLaunchPreparationInput {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub worktree_path: Option<PathBuf>,
    pub launch_env: BTreeMap<String, String>,
    pub activity: ProviderTerminalActivityLaunch,
    pub generation: TerminalObserverGeneration,
}

impl fmt::Debug for TerminalLaunchPreparationInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalLaunchPreparationInput")
            .field("executable", &self.executable)
            .field("arg_count", &self.args.len())
            .field("cwd", &self.cwd)
            .field("worktree_path", &self.worktree_path)
            .field(
                "launch_env_keys",
                &self.launch_env.keys().collect::<Vec<_>>(),
            )
            .field("activity", &self.activity)
            .field("generation", &self.generation)
            .finish()
    }
}

pub trait TerminalLaunchPreparer: Send + Sync {
    fn preparation_execution_budget(
        &self,
        _input: &TerminalLaunchPreparationInput,
    ) -> Pin<Box<dyn Future<Output = Duration> + Send + '_>> {
        Box::pin(async { Duration::from_millis(500) })
    }

    fn prepare(
        &self,
        input: TerminalLaunchPreparationInput,
    ) -> Pin<Box<dyn Future<Output = TerminalLaunchPreparation> + Send + '_>>;
}

pub enum TerminalLaunchPreparation {
    PassThrough,
    Prepared(PreparedTerminalLaunch),
    Admitted(PreparedTerminalLaunch, AgentActivityAdmission),
}

impl fmt::Debug for TerminalLaunchPreparation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PassThrough => formatter.write_str("PassThrough"),
            Self::Prepared(prepared) => formatter.debug_tuple("Prepared").field(prepared).finish(),
            Self::Admitted(prepared, _) => {
                formatter.debug_tuple("Admitted").field(prepared).finish()
            }
        }
    }
}

pub struct PreparedTerminalLaunch {
    pub executable: String,
    pub args: Vec<String>,
    pub private_env: BTreeMap<String, String>,
    pub observer: Box<dyn PreparedTerminalObserver>,
}

impl fmt::Debug for PreparedTerminalLaunch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedTerminalLaunch")
            .field("executable", &self.executable)
            .field("arg_count", &self.args.len())
            .field("private_env_keys", &self.private_env.keys())
            .field("observer", &self.observer.diagnostic_label())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalObserverCancellationReason {
    PreparationRejected,
    SpawnFailed,
    GenerationInvalidated,
    ProcessExited,
    Closed,
    Restarted,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TerminalAgentActivityTransition {
    pub stopped: usize,
    pub dormant: usize,
    pub resumed: usize,
    pub failed: usize,
    pub unavailable: usize,
    pub epochs: TerminalAgentActivityProviderEpochs,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TerminalAgentActivityProviderEpochs {
    pub claude: u64,
    pub codex: u64,
    pub opencode: u64,
}

impl TerminalAgentActivityTransition {
    pub(crate) fn merge(&mut self, other: Self) {
        self.stopped = self.stopped.saturating_add(other.stopped);
        self.dormant = self.dormant.saturating_add(other.dormant);
        self.resumed = self.resumed.saturating_add(other.resumed);
        self.failed = self.failed.saturating_add(other.failed);
        self.unavailable = self.unavailable.saturating_add(other.unavailable);
        self.epochs.claude = self.epochs.claude.max(other.epochs.claude);
        self.epochs.codex = self.epochs.codex.max(other.epochs.codex);
        self.epochs.opencode = self.epochs.opencode.max(other.epochs.opencode);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TerminalAgentActivityState {
    pub(crate) enabled: bool,
    pub(crate) generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TerminalAgentActivityObservationKind {
    Live,
    Dormant,
    #[allow(dead_code)]
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TerminalAgentActivityObservation {
    pub(crate) state: TerminalAgentActivityState,
    pub(crate) epoch: u64,
    pub(crate) kind: TerminalAgentActivityObservationKind,
}

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub(crate) struct TerminalAgentActivityAdmission {
    state: TerminalAgentActivityState,
}

#[cfg(test)]
#[derive(Debug)]
struct TerminalAgentActivityPublicationTestHook {
    transition_armed: AtomicBool,
    transition_reached: Arc<tokio::sync::Semaphore>,
    transition_release: Arc<(StdMutex<bool>, std::sync::Condvar)>,
    observation_armed: AtomicBool,
    observation_reached: Arc<tokio::sync::Semaphore>,
    observation_release: Arc<(StdMutex<bool>, std::sync::Condvar)>,
    acknowledgement_armed: AtomicBool,
    acknowledgement_reached: Arc<tokio::sync::Semaphore>,
    acknowledgement_release: Arc<(StdMutex<bool>, std::sync::Condvar)>,
}

#[cfg(test)]
impl TerminalAgentActivityPublicationTestHook {
    fn new() -> Self {
        Self {
            transition_armed: AtomicBool::new(false),
            transition_reached: Arc::new(tokio::sync::Semaphore::new(0)),
            transition_release: Arc::new((StdMutex::new(false), std::sync::Condvar::new())),
            observation_armed: AtomicBool::new(false),
            observation_reached: Arc::new(tokio::sync::Semaphore::new(0)),
            observation_release: Arc::new((StdMutex::new(false), std::sync::Condvar::new())),
            acknowledgement_armed: AtomicBool::new(false),
            acknowledgement_reached: Arc::new(tokio::sync::Semaphore::new(0)),
            acknowledgement_release: Arc::new((StdMutex::new(false), std::sync::Condvar::new())),
        }
    }

    fn arm_transition(&self) {
        self.transition_armed.store(true, Ordering::Release);
    }

    fn release_transition(&self) {
        Self::release(&self.transition_release);
    }

    async fn wait_for_transition(&self) {
        self.transition_reached
            .acquire()
            .await
            .expect("transition publication barrier")
            .forget();
    }

    fn arm_observation(&self) {
        self.observation_armed.store(true, Ordering::Release);
    }

    fn release_observation(&self) {
        Self::release(&self.observation_release);
    }

    async fn wait_for_observation(&self) {
        self.observation_reached
            .acquire()
            .await
            .expect("observation publication barrier")
            .forget();
    }

    fn arm_acknowledgement(&self) {
        self.acknowledgement_armed.store(true, Ordering::Release);
    }

    fn release_acknowledgement(&self) {
        Self::release(&self.acknowledgement_release);
    }

    async fn wait_for_acknowledgement(&self) {
        self.acknowledgement_reached
            .acquire()
            .await
            .expect("transition acknowledgement barrier")
            .forget();
    }

    fn block(
        armed: &AtomicBool,
        reached: &tokio::sync::Semaphore,
        release: &(StdMutex<bool>, std::sync::Condvar),
    ) {
        if !armed.swap(false, Ordering::AcqRel) {
            return;
        }
        reached.add_permits(1);
        let mut released = release
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !*released {
            released = release
                .1
                .wait(released)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn release(release: &(StdMutex<bool>, std::sync::Condvar)) {
        *release
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        release.1.notify_all();
    }

    fn block_transition(&self) {
        Self::block(
            &self.transition_armed,
            &self.transition_reached,
            &self.transition_release,
        );
    }

    fn block_observation(&self) {
        Self::block(
            &self.observation_armed,
            &self.observation_reached,
            &self.observation_release,
        );
    }

    fn block_acknowledgement(&self) {
        Self::block(
            &self.acknowledgement_armed,
            &self.acknowledgement_reached,
            &self.acknowledgement_release,
        );
    }
}

#[derive(Debug)]
pub(crate) struct TerminalAgentActivityControl {
    state_lock: StdMutex<()>,
    state: AtomicU64,
    changes: watch::Sender<TerminalAgentActivityState>,
    observed: watch::Sender<Option<TerminalAgentActivityObservation>>,
    publication: AsyncMutex<()>,
    #[cfg(test)]
    publication_hook: StdMutex<Option<Arc<TerminalAgentActivityPublicationTestHook>>>,
}

const TERMINAL_AGENT_ACTIVITY_DISABLE_ACK_TIMEOUT: Duration = Duration::from_millis(250);
const TERMINAL_ACTIVITY_ENABLED_BIT: u64 = 1;

fn pack_terminal_activity_state(state: TerminalAgentActivityState) -> u64 {
    (state.generation << 1) | u64::from(state.enabled)
}

fn unpack_terminal_activity_state(value: u64) -> TerminalAgentActivityState {
    TerminalAgentActivityState {
        enabled: value & TERMINAL_ACTIVITY_ENABLED_BIT != 0,
        generation: value >> 1,
    }
}

fn next_terminal_activity_generation(generation: u64) -> u64 {
    generation.wrapping_add(1) & (u64::MAX >> 1)
}

impl TerminalAgentActivityControl {
    pub(crate) fn enabled() -> Self {
        let initial_state = TerminalAgentActivityState {
            enabled: true,
            generation: 0,
        };
        let (changes, _) = watch::channel(initial_state);
        let (observed, _) = watch::channel(None);
        Self {
            state_lock: StdMutex::new(()),
            state: AtomicU64::new(pack_terminal_activity_state(initial_state)),
            changes,
            observed,
            publication: AsyncMutex::new(()),
            #[cfg(test)]
            publication_hook: StdMutex::new(None),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn is_enabled(&self) -> bool {
        self.snapshot().enabled
    }

    pub(crate) fn snapshot(&self) -> TerminalAgentActivityState {
        unpack_terminal_activity_state(self.state.load(Ordering::Acquire))
    }

    #[allow(dead_code)]
    pub(crate) fn admit(&self) -> Option<TerminalAgentActivityAdmission> {
        let state = self.snapshot();
        if !state.enabled {
            return None;
        }
        let admission = TerminalAgentActivityAdmission { state };
        self.admission_is_current(&admission).then_some(admission)
    }

    #[allow(dead_code)]
    pub(crate) fn admission_is_current(&self, admission: &TerminalAgentActivityAdmission) -> bool {
        admission.state.enabled && self.snapshot() == admission.state
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<TerminalAgentActivityState> {
        self.changes.subscribe()
    }

    async fn wait_until_admission_invalidated(
        &self,
        admission: &TerminalAgentActivityAdmission,
        changes: &mut watch::Receiver<TerminalAgentActivityState>,
    ) {
        while self.admission_is_current(admission) {
            if changes.changed().await.is_err() {
                return;
            }
        }
    }

    pub(crate) fn mark_observed(&self, observation: TerminalAgentActivityObservation) -> bool {
        self.commit_observed(observation, || {})
    }

    pub(crate) fn commit_observed(
        &self,
        observation: TerminalAgentActivityObservation,
        commit: impl FnOnce(),
    ) -> bool {
        let _state_lock = self
            .state_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if observation.state != self.snapshot() {
            return false;
        }
        commit();
        #[cfg(test)]
        self.publication_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .inspect(|hook| hook.block_observation());
        self.observed.send_replace(Some(observation));
        true
    }

    #[cfg(all(test, unix))]
    pub(crate) fn latest_observation(&self) -> Option<TerminalAgentActivityObservation> {
        *self.observed.borrow()
    }

    async fn wait_until_observed(
        observed: &mut watch::Receiver<Option<TerminalAgentActivityObservation>>,
        state: TerminalAgentActivityState,
        timeout: Duration,
    ) -> Option<TerminalAgentActivityObservation> {
        tokio::time::timeout(timeout, async move {
            loop {
                if observed.changed().await.is_err() {
                    return None;
                }
                if let Some(observation) = *observed.borrow()
                    && observation.state == state
                {
                    return Some(observation);
                }
            }
        })
        .await
        .unwrap_or(None)
    }

    pub(crate) fn transition_state(
        &self,
        enabled: bool,
    ) -> (TerminalAgentActivityState, TerminalAgentActivityTransition) {
        let _state_lock = self
            .state_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.transition_state_locked(enabled)
    }

    fn transition_state_locked(
        &self,
        enabled: bool,
    ) -> (TerminalAgentActivityState, TerminalAgentActivityTransition) {
        let mut previous = self.state.load(Ordering::Acquire);
        loop {
            let previous_state = unpack_terminal_activity_state(previous);
            let state = TerminalAgentActivityState {
                enabled,
                generation: if previous_state.enabled == enabled {
                    previous_state.generation
                } else {
                    next_terminal_activity_generation(previous_state.generation)
                },
            };
            let packed_state = pack_terminal_activity_state(state);
            match self.state.compare_exchange_weak(
                previous,
                packed_state,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    #[cfg(test)]
                    self.publication_hook
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .as_ref()
                        .inspect(|hook| hook.block_transition());
                    self.changes.send_replace(state);
                    let transition = match (previous_state.enabled, enabled) {
                        (true, false) => TerminalAgentActivityTransition {
                            stopped: 1,
                            dormant: 1,
                            ..TerminalAgentActivityTransition::default()
                        },
                        (false, false) => TerminalAgentActivityTransition {
                            dormant: 1,
                            ..TerminalAgentActivityTransition::default()
                        },
                        (false, true) => TerminalAgentActivityTransition {
                            resumed: 1,
                            ..TerminalAgentActivityTransition::default()
                        },
                        (true, true) => TerminalAgentActivityTransition::default(),
                    };
                    return (state, transition);
                }
                Err(current) => previous = current,
            }
        }
    }

    pub(crate) async fn transition_observed(
        &self,
        enabled: bool,
        enable_ack_timeout: Duration,
    ) -> TerminalAgentActivityTransition {
        self.transition_observed_with_epoch(enabled, enable_ack_timeout)
            .await
            .0
    }

    pub(crate) async fn transition_observed_with_epoch(
        &self,
        enabled: bool,
        enable_ack_timeout: Duration,
    ) -> (TerminalAgentActivityTransition, Option<u64>) {
        let (state, mut transition, mut observed) = {
            // Publication takes generation publication before this activity
            // mutex. Transitions never acquire generation publication, and
            // observation commits take only state_lock, so no reverse edge
            // exists in the lock graph.
            let _activity_publication_guard = self.publication.lock().await;
            let _state_lock = self
                .state_lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let observed = self.observed.subscribe();
            let (state, transition) = self.transition_state_locked(enabled);
            (state, transition, observed)
        };
        let acknowledgement_timeout = if enabled {
            enable_ack_timeout
        } else {
            TERMINAL_AGENT_ACTIVITY_DISABLE_ACK_TIMEOUT
        };
        let observation =
            Self::wait_until_observed(&mut observed, state, acknowledgement_timeout).await;
        #[cfg(test)]
        if observation.is_some() {
            let hook = self
                .publication_hook
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .cloned();
            if let Some(hook) = hook {
                hook.block_acknowledgement();
            }
        }
        match observation.map(|observation| observation.kind) {
            Some(TerminalAgentActivityObservationKind::Live)
            | Some(TerminalAgentActivityObservationKind::Dormant) => {
                if enabled {
                    transition.resumed = transition.resumed.max(1);
                }
            }
            Some(TerminalAgentActivityObservationKind::Unavailable) => {
                if enabled {
                    transition.resumed = 0;
                }
                transition.failed = transition.failed.saturating_add(1);
                transition.unavailable = transition.unavailable.saturating_add(1);
            }
            None => {
                if enabled {
                    transition.resumed = 0;
                }
                transition.failed = transition.failed.saturating_add(1);
            }
        }
        (transition, observation.map(|observation| observation.epoch))
    }

    #[allow(dead_code)]
    pub(crate) fn transition(&self, enabled: bool) -> TerminalAgentActivityTransition {
        self.transition_state(enabled).1
    }
}

pub trait PreparedTerminalObserver: Send + Sync {
    /// Returns whether provider-side resources are still live immediately
    /// before the manager transfers the spawned PTY to `on_spawned`.
    ///
    /// Providers without a separate helper process remain ready by default.
    fn is_ready_for_on_spawned(&self) -> bool {
        true
    }

    /// Performs bounded synchronous setup after the terminal process starts.
    ///
    /// The manager invokes this on an isolated thread without an ambient Tokio
    /// runtime. Register every durable asynchronous activity through `workers`;
    /// ambient `tokio::spawn` is intentionally unavailable at this boundary.
    fn on_spawned(
        &self,
        pid: u32,
        generation: TerminalObserverGeneration,
        workers: TerminalObserverWorkerContext,
    );

    /// Returns the provider-specific acknowledgement budget for enabling
    /// activity observation. The manager adds its callback-isolation budget so
    /// the provider can report a bounded timeout and complete dormant rollback.
    fn agent_activity_enable_ack_timeout(&self) -> Option<Duration> {
        None
    }

    fn set_agent_activity_enabled(
        &self,
        _enabled: bool,
        _generation: TerminalObserverGeneration,
        _workers: TerminalObserverWorkerContext,
    ) -> Pin<Box<dyn Future<Output = TerminalAgentActivityTransition> + Send + '_>> {
        Box::pin(async { TerminalAgentActivityTransition::default() })
    }

    /// A bounded, non-secret label suitable for operational diagnostics.
    fn diagnostic_label(&self) -> &str;
}

#[cfg(test)]
mod tests {
    use std::{
        future::poll_fn,
        sync::{
            Arc, LazyLock,
            atomic::{AtomicUsize, Ordering},
        },
        task::Poll,
        time::Duration,
    };

    use crate::{
        activity::{
            ActivityCapabilities, ActivityProjection, ActivityRepository, ActivityScopeRef,
            ProviderActivityMutation,
        },
        persistence::{Database, run_migrations},
    };

    use super::{
        MAX_GLOBAL_OBSERVER_WORKERS, TerminalAgentActivityAdmission, TerminalAgentActivityControl,
        TerminalAgentActivityObservation, TerminalAgentActivityObservationKind,
        TerminalAgentActivityPublicationTestHook, TerminalAgentActivityTransition,
        TerminalGenerationActivityPublisher, TerminalObserverCancellationReason,
        TerminalObserverGeneration, TerminalObserverWorkerSpawnError, WorkerThreadExitTestHook,
    };

    static GLOBAL_OBSERVER_WORKER_TEST_LOCK: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));

    #[derive(Debug)]
    struct DropCount(Arc<AtomicUsize>);

    impl Drop for DropCount {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::AcqRel);
        }
    }

    async fn terminal_activity_admitted_publisher_fixture() -> (
        TerminalGenerationActivityPublisher,
        ActivityProjection,
        TerminalObserverGeneration,
        Arc<TerminalAgentActivityControl>,
        TerminalAgentActivityAdmission,
        ActivityScopeRef,
    ) {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let projection = ActivityProjection::new(ActivityRepository::new(database));
        let generation = TerminalObserverGeneration::new(
            "thread-admitted-publication".to_owned(),
            "terminal-admitted-publication".to_owned(),
        );
        let publisher = TerminalGenerationActivityPublisher::new(
            generation.clone(),
            projection.clone(),
            Arc::new(tokio::sync::Mutex::new(())),
        );
        assert!(
            publisher
                .publish_correlated(
                    "opencode",
                    Some("opencode"),
                    ActivityCapabilities::structured_full(false),
                )
                .await
                .expect("correlated terminal scope")
        );
        let activity = Arc::new(TerminalAgentActivityControl::enabled());
        let admission = activity.admit().expect("live activity admission");
        let scope = ActivityScopeRef::Terminal {
            thread_id: "thread-admitted-publication".to_owned(),
            terminal_id: "terminal-admitted-publication".to_owned(),
        };
        (
            publisher, projection, generation, activity, admission, scope,
        )
    }

    fn admitted_actor_mutation(actor_id: &str) -> Vec<ProviderActivityMutation> {
        vec![
            ProviderActivityMutation::upsert_actor(actor_id, None, "Blocked actor", "running")
                .expect("actor mutation"),
        ]
    }

    #[tokio::test]
    async fn terminal_activity_admitted_publication_does_not_wait_past_disable() {
        let (publisher, projection, _generation, activity, admission, scope) =
            terminal_activity_admitted_publisher_fixture().await;
        let publication_guard = publisher.publication.lock().await;
        let mut apply = Box::pin(publisher.apply_admitted(
            &activity,
            &admission,
            "event:disable",
            admitted_actor_mutation("actor:disable"),
            "2026-07-31T12:00:00Z",
        ));
        assert!(
            poll_fn(|context| Poll::Ready(apply.as_mut().poll(context)))
                .await
                .is_pending(),
            "admitted publication waits at the held generation publication lock"
        );

        let mut changes = activity.subscribe();
        let disabling = tokio::spawn({
            let activity = activity.clone();
            async move {
                activity
                    .transition_observed(false, Duration::from_secs(1))
                    .await
            }
        });
        let dormant = *tokio::time::timeout(
            Duration::from_secs(1),
            changes.wait_for(|state| !state.enabled),
        )
        .await
        .expect("generation-lock waiter must not block the activity transition")
        .expect("dormant activity state");
        let deltas = tokio::time::timeout(Duration::from_millis(100), &mut apply)
            .await
            .expect("disabled publication exits before the held lock is released")
            .expect("disabled publication result");
        assert!(deltas.is_empty());
        assert!(activity.mark_observed(TerminalAgentActivityObservation {
            state: dormant,
            epoch: 0,
            kind: TerminalAgentActivityObservationKind::Dormant,
        }));
        assert_eq!(disabling.await.expect("disable transition").failed, 0);
        drop(publication_guard);

        assert!(
            projection
                .snapshot(&scope)
                .await
                .expect("terminal activity snapshot")
                .actors
                .is_empty(),
            "a publication invalidated while waiting must not mutate the projection"
        );
    }

    #[tokio::test]
    async fn terminal_activity_admitted_publication_does_not_wait_past_cancellation() {
        let (publisher, projection, generation, activity, admission, scope) =
            terminal_activity_admitted_publisher_fixture().await;
        let publication_guard = publisher.publication.lock().await;
        let mut apply = Box::pin(publisher.apply_admitted(
            &activity,
            &admission,
            "event:cancel",
            admitted_actor_mutation("actor:cancel"),
            "2026-07-31T12:00:00Z",
        ));
        assert!(
            poll_fn(|context| Poll::Ready(apply.as_mut().poll(context)))
                .await
                .is_pending(),
            "admitted publication waits at the held generation publication lock"
        );

        assert!(generation.request_cancellation(TerminalObserverCancellationReason::Closed));
        let deltas = tokio::time::timeout(Duration::from_millis(100), &mut apply)
            .await
            .expect("cancelled publication exits before the held lock is released")
            .expect("cancelled publication result");
        assert!(deltas.is_empty());
        drop(publication_guard);

        assert!(
            projection
                .snapshot(&scope)
                .await
                .expect("terminal activity snapshot")
                .actors
                .is_empty(),
            "a cancelled publication must not mutate the projection"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hardening_worker_shutdown_is_single_flight_and_cancellation_safe() {
        let _test_guard = GLOBAL_OBSERVER_WORKER_TEST_LOCK.lock().await;
        let generation =
            TerminalObserverGeneration::new("thread".to_owned(), "terminal".to_owned());
        let workers = generation.worker_context();
        let started = Arc::new(tokio::sync::Semaphore::new(0));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        workers
            .spawn({
                let started = started.clone();
                let release = release.clone();
                let dropped = dropped.clone();
                async move {
                    let _drop = DropCount(dropped);
                    started.add_permits(1);
                    release
                        .acquire()
                        .await
                        .expect("worker release semaphore")
                        .forget();
                }
            })
            .expect("worker admission");
        started
            .acquire()
            .await
            .expect("worker start semaphore")
            .forget();

        let first = tokio::spawn({
            let generation = generation.clone();
            async move {
                generation
                    .shutdown_workers(Duration::from_secs(5), Duration::from_millis(100))
                    .await;
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match workers.spawn(async {}) {
                    Err(TerminalObserverWorkerSpawnError::GenerationClosing) => break,
                    Ok(()) | Err(TerminalObserverWorkerSpawnError::CapacityExceeded) => {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                    Err(error) => panic!("unexpected worker admission result: {error}"),
                }
            }
        })
        .await
        .expect("first shutdown caller began cleanup");
        first.abort();
        assert!(
            first
                .await
                .expect_err("cancel first shutdown caller")
                .is_cancelled()
        );

        let mut second = tokio::spawn({
            let generation = generation.clone();
            async move {
                generation
                    .shutdown_workers(Duration::from_secs(5), Duration::from_millis(100))
                    .await;
            }
        });
        let mut third = tokio::spawn({
            let generation = generation.clone();
            async move {
                generation
                    .shutdown_workers(Duration::from_secs(5), Duration::from_millis(100))
                    .await;
            }
        });
        let second_returned_early = tokio::time::timeout(Duration::from_millis(50), &mut second)
            .await
            .is_ok();
        let third_returned_early = tokio::time::timeout(Duration::from_millis(50), &mut third)
            .await
            .is_ok();

        release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(1), async {
            while dropped.load(Ordering::Acquire) != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("manager-owned worker reaper");
        if !second.is_finished() {
            second.await.expect("second shutdown caller");
        }
        if !third.is_finished() {
            third.await.expect("third shutdown caller");
        }

        assert!(
            !second_returned_early,
            "a concurrent shutdown caller returned before shared worker cleanup completed"
        );
        assert!(
            !third_returned_early,
            "every shutdown caller must wait for the same cleanup completion"
        );
        assert_eq!(
            dropped.load(Ordering::Acquire),
            1,
            "registered worker was not reaped exactly once"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn hardening_worker_slot_is_retained_until_the_os_thread_exits() {
        let _test_guard = GLOBAL_OBSERVER_WORKER_TEST_LOCK.lock().await;
        let generation =
            TerminalObserverGeneration::new("thread".to_owned(), "terminal".to_owned());
        let hook = Arc::new(WorkerThreadExitTestHook {
            before_completion_reached: Arc::new(tokio::sync::Semaphore::new(0)),
            completion_release: Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new())),
            before_exit_reached: Arc::new(tokio::sync::Semaphore::new(0)),
            exit_release: Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new())),
            before_join_reached: Arc::new(tokio::sync::Semaphore::new(0)),
            join_release: Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new())),
        });
        *generation
            .inner
            .workers
            .inner
            .thread_exit_hook
            .lock()
            .expect("thread exit hook lock") = Some(hook.clone());
        let workers = generation.worker_context();
        for _ in 0..MAX_GLOBAL_OBSERVER_WORKERS {
            workers.spawn(async {}).expect("worker admission");
        }
        for _ in 0..MAX_GLOBAL_OBSERVER_WORKERS {
            hook.before_completion_reached
                .acquire()
                .await
                .expect("worker reached pre-completion barrier")
                .forget();
        }
        hook.release_completion();
        for _ in 0..MAX_GLOBAL_OBSERVER_WORKERS {
            hook.before_exit_reached
                .acquire()
                .await
                .expect("worker reached pre-exit barrier")
                .forget();
        }
        hook.release_exit();
        tokio::time::timeout(Duration::from_secs(1), hook.before_join_reached.acquire())
            .await
            .expect("completed worker was submitted to the persistent join owner")
            .expect("join-owner barrier")
            .forget();

        let challenger =
            TerminalObserverGeneration::new("thread-2".to_owned(), "terminal-2".to_owned());
        let challenger_admission = challenger.worker_context().spawn(async {});
        let mut shutdown = tokio::spawn({
            let generation = generation.clone();
            async move {
                generation
                    .shutdown_workers(Duration::ZERO, Duration::from_millis(20))
                    .await;
            }
        });
        let shutdown_returned_within_bound =
            tokio::time::timeout(Duration::from_millis(100), &mut shutdown)
                .await
                .is_ok();

        hook.release_join();
        if !shutdown.is_finished() {
            tokio::time::timeout(Duration::from_secs(1), &mut shutdown)
                .await
                .expect("shutdown completed after thread exit")
                .expect("shutdown task");
        }
        challenger
            .shutdown_workers(Duration::from_millis(100), Duration::from_millis(20))
            .await;

        let capacity_reused = Arc::new(tokio::sync::Semaphore::new(0));
        let follow_up =
            TerminalObserverGeneration::new("thread-3".to_owned(), "terminal-3".to_owned());
        let follow_up_workers = follow_up.worker_context();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let admission = follow_up_workers.spawn({
                    let capacity_reused = capacity_reused.clone();
                    async move {
                        capacity_reused.add_permits(1);
                    }
                });
                match admission {
                    Ok(()) => break,
                    Err(TerminalObserverWorkerSpawnError::CapacityExceeded) => {
                        tokio::task::yield_now().await;
                    }
                    Err(error) => panic!("unexpected follow-up admission failure: {error}"),
                }
            }
        })
        .await
        .expect("capacity reusable after actual thread exit");
        capacity_reused
            .acquire()
            .await
            .expect("follow-up worker")
            .forget();
        follow_up
            .shutdown_workers(Duration::from_millis(100), Duration::from_millis(20))
            .await;

        assert_eq!(
            challenger_admission,
            Err(TerminalObserverWorkerSpawnError::CapacityExceeded),
            "a global worker slot became reusable while the old OS thread was still alive"
        );
        assert!(
            shutdown_returned_within_bound,
            "the reaper treated future completion as thread completion and blocked in join"
        );
    }

    #[tokio::test]
    async fn terminal_activity_control_rejects_stale_admission_and_observation() {
        let control = TerminalAgentActivityControl::enabled();
        let admission = control.admit().expect("initial live admission");
        let (dormant, _) = control.transition_state(false);

        assert!(!control.admission_is_current(&admission));
        assert!(control.mark_observed(TerminalAgentActivityObservation {
            state: dormant,
            epoch: 7,
            kind: TerminalAgentActivityObservationKind::Dormant,
        }));

        let (live, _) = control.transition_state(true);
        assert_ne!(live.generation, dormant.generation);
        assert!(!control.mark_observed(TerminalAgentActivityObservation {
            state: dormant,
            epoch: 8,
            kind: TerminalAgentActivityObservationKind::Live,
        }));
        assert!(control.mark_observed(TerminalAgentActivityObservation {
            state: live,
            epoch: 9,
            kind: TerminalAgentActivityObservationKind::Live,
        }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_activity_control_does_not_commit_a_superseded_promotion() {
        let control = Arc::new(TerminalAgentActivityControl::enabled());
        let expected = control.snapshot();
        let hook = Arc::new(TerminalAgentActivityPublicationTestHook::new());
        hook.arm_transition();
        *control
            .publication_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hook.clone());
        let transition = tokio::task::spawn_blocking({
            let control = control.clone();
            move || control.transition_state(false).0
        });
        hook.wait_for_transition().await;

        let stream_owner = Arc::new(AtomicUsize::new(1));
        let epoch = Arc::new(AtomicUsize::new(0));
        let promotion = tokio::task::spawn_blocking({
            let control = control.clone();
            let stream_owner = stream_owner.clone();
            let epoch = epoch.clone();
            move || {
                control.commit_observed(
                    TerminalAgentActivityObservation {
                        state: expected,
                        epoch: 1,
                        kind: TerminalAgentActivityObservationKind::Live,
                    },
                    || {
                        stream_owner.store(2, Ordering::Release);
                        epoch.store(1, Ordering::Release);
                    },
                )
            }
        });
        tokio::task::yield_now().await;

        hook.release_transition();
        let dormant = transition.await.expect("superseding transition");
        let promoted = promotion.await.expect("fenced promotion");

        assert!(!promoted);
        assert!(!dormant.enabled);
        assert_eq!(
            stream_owner.load(Ordering::Acquire),
            1,
            "a superseded replacement cannot take stream ownership"
        );
        assert_eq!(
            epoch.load(Ordering::Acquire),
            0,
            "a superseded replacement cannot advance the transport epoch"
        );
    }

    #[tokio::test]
    async fn unavailable_acknowledgement_fails_the_exact_enable_generation() {
        let control = Arc::new(TerminalAgentActivityControl::enabled());
        let mut changes = control.subscribe();
        let disabled = control.clone();
        let disable = tokio::spawn(async move {
            disabled
                .transition_observed(false, Duration::from_millis(100))
                .await
        });
        let dormant = *changes
            .wait_for(|state| !state.enabled)
            .await
            .expect("dormant state");
        control.mark_observed(TerminalAgentActivityObservation {
            state: dormant,
            epoch: 3,
            kind: TerminalAgentActivityObservationKind::Dormant,
        });
        assert_eq!(disable.await.expect("disable").failed, 0);

        let enabled = control.clone();
        let enable = tokio::spawn(async move {
            enabled
                .transition_observed(true, Duration::from_millis(100))
                .await
        });
        let live = *changes
            .wait_for(|state| state.enabled)
            .await
            .expect("live state");
        control.mark_observed(TerminalAgentActivityObservation {
            state: live,
            epoch: 4,
            kind: TerminalAgentActivityObservationKind::Unavailable,
        });
        let report = enable.await.expect("enable");
        assert_eq!(
            (report.resumed, report.failed, report.unavailable),
            (0, 1, 1)
        );
        assert_eq!(control.snapshot(), live, "failed enable remains requested");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_activity_transition_returns_the_epoch_of_its_exact_acknowledgement() {
        let control = Arc::new(TerminalAgentActivityControl::enabled());
        let mut changes = control.subscribe();
        let hook = Arc::new(TerminalAgentActivityPublicationTestHook::new());
        hook.arm_acknowledgement();
        *control
            .publication_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hook.clone());

        let transition = tokio::spawn({
            let control = control.clone();
            async move {
                control
                    .transition_observed_with_epoch(false, Duration::from_secs(1))
                    .await
            }
        });
        let dormant = *changes
            .wait_for(|state| !state.enabled)
            .await
            .expect("dormant state");
        assert!(control.mark_observed(TerminalAgentActivityObservation {
            state: dormant,
            epoch: 7,
            kind: TerminalAgentActivityObservationKind::Dormant,
        }));
        hook.wait_for_acknowledgement().await;
        assert!(control.mark_observed(TerminalAgentActivityObservation {
            state: dormant,
            epoch: 9,
            kind: TerminalAgentActivityObservationKind::Dormant,
        }));
        hook.release_acknowledgement();

        let (report, epoch) = transition.await.expect("disable transition");
        assert_eq!((report.stopped, report.dormant, report.failed), (1, 1, 0));
        assert_eq!(
            epoch,
            Some(7),
            "the transition epoch must come from the observation that acknowledged it"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_activity_control_publishes_concurrent_transitions_in_generation_order() {
        let control = Arc::new(TerminalAgentActivityControl::enabled());
        let changes = control.subscribe();
        let hook = Arc::new(TerminalAgentActivityPublicationTestHook::new());
        hook.arm_transition();
        *control
            .publication_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hook.clone());

        let first = tokio::task::spawn_blocking({
            let control = control.clone();
            move || control.transition_state(false).0
        });
        hook.wait_for_transition().await;
        let second = tokio::task::spawn_blocking({
            let control = control.clone();
            move || control.transition_state(true).0
        });

        hook.release_transition();
        let first = first.await.expect("first transition");
        let second = second.await.expect("second transition");
        assert_ne!(first, second);
        assert_eq!(*changes.borrow(), control.snapshot());
        assert_eq!(*changes.borrow(), second);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_activity_control_cannot_publish_stale_observation_after_state_change() {
        let control = Arc::new(TerminalAgentActivityControl::enabled());
        let hook = Arc::new(TerminalAgentActivityPublicationTestHook::new());
        hook.arm_observation();
        *control
            .publication_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hook.clone());
        let stale = TerminalAgentActivityObservation {
            state: control.snapshot(),
            epoch: 1,
            kind: TerminalAgentActivityObservationKind::Live,
        };

        let stale_publish = tokio::task::spawn_blocking({
            let control = control.clone();
            move || control.mark_observed(stale)
        });
        hook.wait_for_observation().await;
        let mut disable = tokio::task::spawn_blocking({
            let control = control.clone();
            move || control.transition_state(false).0
        });
        let transition_finished_while_observation_was_checked =
            tokio::time::timeout(Duration::from_millis(50), &mut disable).await;
        let transition_blocked_by_observation =
            transition_finished_while_observation_was_checked.is_err();
        let current = match transition_finished_while_observation_was_checked {
            Ok(disable) => {
                let current = TerminalAgentActivityObservation {
                    state: disable.expect("disable transition"),
                    epoch: 2,
                    kind: TerminalAgentActivityObservationKind::Dormant,
                };
                assert!(control.mark_observed(current));
                hook.release_observation();
                current
            }
            Err(_) => {
                hook.release_observation();
                let current = TerminalAgentActivityObservation {
                    state: disable
                        .await
                        .expect("disable transition after observation release"),
                    epoch: 2,
                    kind: TerminalAgentActivityObservationKind::Dormant,
                };
                assert!(control.mark_observed(current));
                current
            }
        };
        let _ = stale_publish.await.expect("stale publish");
        assert!(
            transition_blocked_by_observation,
            "a state transition raced past an observation after its state check"
        );
        assert_eq!(*control.observed.borrow(), Some(current));
    }

    #[tokio::test]
    async fn terminal_activity_control_retries_unavailable_and_timeout_with_fresh_resume_acknowledgements()
     {
        let control = Arc::new(TerminalAgentActivityControl::enabled());
        let mut changes = control.subscribe();
        let first = tokio::spawn({
            let control = control.clone();
            async move {
                control
                    .transition_observed(true, Duration::from_millis(100))
                    .await
            }
        });
        changes.changed().await.expect("first enable request");
        let live = *changes.borrow();
        assert!(control.mark_observed(TerminalAgentActivityObservation {
            state: live,
            epoch: 1,
            kind: TerminalAgentActivityObservationKind::Unavailable,
        }));
        assert_eq!(
            (
                first.await.expect("first enable").resumed,
                control.snapshot()
            ),
            (0, live)
        );

        let retry = tokio::spawn({
            let control = control.clone();
            async move {
                control
                    .transition_observed(true, Duration::from_millis(100))
                    .await
            }
        });
        changes.changed().await.expect("retry enable request");
        assert!(control.mark_observed(TerminalAgentActivityObservation {
            state: *changes.borrow(),
            epoch: 2,
            kind: TerminalAgentActivityObservationKind::Live,
        }));
        let retry = retry.await.expect("retry enable");
        assert_eq!((retry.resumed, retry.failed, retry.unavailable), (1, 0, 0));

        let timed_out = control
            .transition_observed(true, Duration::from_millis(10))
            .await;
        assert_eq!((timed_out.resumed, timed_out.failed), (0, 1));
        changes.changed().await.expect("timed-out enable request");

        let after_timeout = tokio::spawn({
            let control = control.clone();
            async move {
                control
                    .transition_observed(true, Duration::from_millis(100))
                    .await
            }
        });
        changes
            .changed()
            .await
            .expect("post-timeout enable request");
        assert!(control.mark_observed(TerminalAgentActivityObservation {
            state: *changes.borrow(),
            epoch: 3,
            kind: TerminalAgentActivityObservationKind::Live,
        }));
        let after_timeout = after_timeout.await.expect("post-timeout enable");
        assert_eq!(
            (
                after_timeout.resumed,
                after_timeout.failed,
                after_timeout.unavailable,
            ),
            (1, 0, 0)
        );
    }

    #[test]
    fn terminal_activity_transition_merge_saturates_counts_and_maximizes_epochs() {
        let mut transition = TerminalAgentActivityTransition {
            stopped: usize::MAX,
            dormant: usize::MAX - 1,
            resumed: usize::MAX - 2,
            failed: usize::MAX - 3,
            unavailable: usize::MAX - 4,
            epochs: super::TerminalAgentActivityProviderEpochs {
                claude: 3,
                codex: 5,
                opencode: 7,
            },
        };
        transition.merge(TerminalAgentActivityTransition {
            stopped: 1,
            dormant: 2,
            resumed: 3,
            failed: 4,
            unavailable: 5,
            epochs: super::TerminalAgentActivityProviderEpochs {
                claude: 9,
                codex: 2,
                opencode: 7,
            },
        });

        assert_eq!(
            (
                transition.stopped,
                transition.dormant,
                transition.resumed,
                transition.failed,
                transition.unavailable,
            ),
            (usize::MAX, usize::MAX, usize::MAX, usize::MAX, usize::MAX)
        );
        assert_eq!(
            transition.epochs,
            super::TerminalAgentActivityProviderEpochs {
                claude: 9,
                codex: 5,
                opencode: 7,
            }
        );
    }
}
