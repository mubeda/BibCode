use std::{
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use futures_util::{FutureExt, StreamExt, stream, stream::FuturesUnordered};
use serde_json::json;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    sync::{Semaphore, mpsc},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::{
    crypto::sha256_hex,
    git::{host_path_platform, normalize_worktree_path_key},
    orchestration::{OrchestrationCommand, OrchestrationEngine, engine::ActivityInput},
    persistence::Repositories,
    production::{
        provider_runtime::{ProviderRuntimeError, ProviderRuntimeSupervisor},
        server_terminal::ServerTerminalServices,
    },
    worktree_catalog::{
        AdoptedWorktreeAvailability, CatalogFuture, CatalogWorkspaceLossObserver,
        WorkspaceAvailabilityRegistry, WorkspaceCleanupOwnership, WorkspaceLossTransition,
    },
};

const PRODUCTION_REAPER_CAPACITY: usize = 64;
const PRODUCTION_MAX_PARALLEL_QUIESCES: usize = 16;
const PRODUCTION_GRACEFUL_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) type WorktreeRuntimeFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

pub(crate) trait WorktreeRuntimeActions: Send + Sync + 'static {
    fn affected_thread_ids(
        &self,
        transition: WorkspaceLossTransition,
    ) -> WorktreeRuntimeFuture<Result<Vec<String>, String>> {
        Box::pin(async move { Ok(vec![transition.thread_id]) })
    }
    fn stop_provider(
        &self,
        thread_id: String,
        transition: WorkspaceLossTransition,
    ) -> WorktreeRuntimeFuture<Result<(), String>>;
    fn close_terminals(&self, thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>>;
    fn append_warning(
        &self,
        transition: WorkspaceLossTransition,
    ) -> WorktreeRuntimeFuture<Result<(), String>>;
}

#[derive(Clone, Copy)]
pub(crate) struct WorktreeRuntimeOptions {
    graceful_timeout: Duration,
    reaper_capacity: usize,
    max_parallel_quiesces: usize,
}

impl Default for WorktreeRuntimeOptions {
    fn default() -> Self {
        Self {
            graceful_timeout: PRODUCTION_GRACEFUL_TIMEOUT,
            reaper_capacity: PRODUCTION_REAPER_CAPACITY,
            max_parallel_quiesces: PRODUCTION_MAX_PARALLEL_QUIESCES,
        }
    }
}

#[derive(Clone)]
pub(crate) struct WorktreeRuntime {
    inner: Arc<Inner>,
}

struct Inner {
    actions: Arc<dyn WorktreeRuntimeActions>,
    registry: WorkspaceAvailabilityRegistry,
    options: WorktreeRuntimeOptions,
    reaper_sender: mpsc::Sender<ReaperJob>,
    quiesce_permits: Arc<Semaphore>,
    active_reaper_jobs: Arc<AtomicUsize>,
    shutdown: CancellationToken,
    reaper: Mutex<Option<JoinHandle<()>>>,
}

struct ReaperJob {
    transition: WorkspaceLossTransition,
    actions: Arc<dyn WorktreeRuntimeActions>,
    max_parallel: usize,
    ownership: WorkspaceCleanupOwnership,
}

type CleanupFuture = WorktreeRuntimeFuture<Result<CleanupResult, String>>;

struct CleanupResult {
    provider: Result<(), String>,
    terminals: Result<(), String>,
}

impl WorktreeRuntime {
    pub(crate) fn start(
        orchestration: OrchestrationEngine,
        provider: Arc<ProviderRuntimeSupervisor>,
        terminals: ServerTerminalServices,
        registry: WorkspaceAvailabilityRegistry,
    ) -> Self {
        Self::start_inner(
            Arc::new(ProductionWorktreeRuntimeActions {
                orchestration,
                provider,
                terminals,
                registry: registry.clone(),
            }),
            registry,
            WorktreeRuntimeOptions::default(),
        )
    }

    #[cfg(test)]
    fn start_for_test(
        actions: Arc<dyn WorktreeRuntimeActions>,
        registry: WorkspaceAvailabilityRegistry,
        options: WorktreeRuntimeOptions,
    ) -> Self {
        Self::start_inner(actions, registry, options)
    }

    fn start_inner(
        actions: Arc<dyn WorktreeRuntimeActions>,
        registry: WorkspaceAvailabilityRegistry,
        options: WorktreeRuntimeOptions,
    ) -> Self {
        let (reaper_sender, reaper_receiver) = mpsc::channel(options.reaper_capacity.max(1));
        let shutdown = CancellationToken::new();
        let reaper_shutdown = shutdown.clone();
        let reaper_registry = registry.clone();
        let quiesce_permits = Arc::new(Semaphore::new(options.max_parallel_quiesces.max(1)));
        let reaper_permits = quiesce_permits.clone();
        let active_reaper_jobs = Arc::new(AtomicUsize::new(0));
        let reaper_active_jobs = active_reaper_jobs.clone();
        let reaper = tokio::spawn(async move {
            run_reaper(
                reaper_receiver,
                reaper_registry,
                reaper_shutdown,
                reaper_permits,
                reaper_active_jobs,
                options.reaper_capacity.max(1),
                options.graceful_timeout,
            )
            .await;
        });
        Self {
            inner: Arc::new(Inner {
                actions,
                registry,
                options,
                reaper_sender,
                quiesce_permits,
                active_reaper_jobs,
                shutdown,
                reaper: Mutex::new(Some(reaper)),
            }),
        }
    }

    pub(crate) async fn observe(&self, transitions: Vec<WorkspaceLossTransition>) {
        stream::iter(transitions)
            .for_each_concurrent(
                self.inner.options.max_parallel_quiesces.max(1),
                |transition| async move {
                    let Ok(_permit) = self.inner.quiesce_permits.acquire().await else {
                        return;
                    };
                    self.quiesce(transition).await;
                },
            )
            .await;
    }

    async fn quiesce(&self, transition: WorkspaceLossTransition) {
        let thread_id = transition.thread_id.clone();
        let deadline = tokio::time::Instant::now() + self.inner.options.graceful_timeout;
        let max_parallel = self.inner.options.max_parallel_quiesces.max(1);
        let canonical_cleanup = tokio::time::timeout_at(
            deadline,
            cleanup_attempt(
                self.inner.actions.clone(),
                vec![thread_id.clone()],
                max_parallel,
                transition.clone(),
            ),
        );
        let alias_cleanup = async {
            let mut affected_thread_ids = match tokio::time::timeout_at(
                deadline,
                self.inner.actions.affected_thread_ids(transition.clone()),
            )
            .await
            {
                Ok(Ok(thread_ids)) => thread_ids,
                Ok(Err(error)) => {
                    tracing::warn!(%thread_id, %error, "failed to resolve workspace thread aliases");
                    return (false, Ok(empty_cleanup_result()));
                }
                Err(_) => {
                    tracing::warn!(%thread_id, "workspace thread alias resolution timed out");
                    return (false, Ok(empty_cleanup_result()));
                }
            };
            affected_thread_ids.sort();
            affected_thread_ids.dedup();
            affected_thread_ids.retain(|affected_thread_id| affected_thread_id != &thread_id);
            if affected_thread_ids.is_empty() {
                return (true, Ok(empty_cleanup_result()));
            }
            let cleanup = cleanup_attempt(
                self.inner.actions.clone(),
                affected_thread_ids,
                max_parallel,
                transition.clone(),
            );
            match tokio::time::timeout_at(deadline, cleanup).await {
                Ok(result) => (true, result),
                Err(_) => (true, Err("workspace alias cleanup timed out".to_owned())),
            }
        };

        let (warning_result, canonical_cleanup_result, (aliases_resolved, alias_cleanup_result)) = tokio::join!(
            tokio::time::timeout_at(
                deadline,
                self.inner.actions.append_warning(transition.clone()),
            ),
            canonical_cleanup,
            alias_cleanup,
        );
        let canonical_cleanup_result = canonical_cleanup_result
            .unwrap_or_else(|_| Err("canonical workspace cleanup timed out".to_owned()));

        match warning_result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%thread_id, %error, "failed to append workspace-unavailable activity");
            }
            Err(_) => {
                tracing::warn!(%thread_id, "workspace-unavailable activity persistence timed out");
            }
        }
        log_cleanup_outcome(&thread_id, &canonical_cleanup_result);
        log_cleanup_outcome(&thread_id, &alias_cleanup_result);

        if aliases_resolved
            && cleanup_outcome_succeeded(&canonical_cleanup_result)
            && cleanup_outcome_succeeded(&alias_cleanup_result)
        {
            if self.inner.registry.has_transition_admissions(&transition)
                && tokio::time::timeout_at(
                    deadline,
                    self.inner
                        .registry
                        .wait_for_transition_admissions(&transition),
                )
                .await
                .is_err()
            {
                self.enqueue_cleanup_retry(transition, max_parallel).await;
            }
        } else {
            self.enqueue_cleanup_retry(transition, max_parallel).await;
        }
    }

    async fn enqueue_cleanup_retry(
        &self,
        transition: WorkspaceLossTransition,
        max_parallel: usize,
    ) {
        let thread_id = transition.thread_id.clone();
        let Some(ownership) = self.inner.registry.begin_orphan_cleanup(&transition) else {
            return;
        };
        let job = ReaperJob {
            transition,
            actions: self.inner.actions.clone(),
            max_parallel,
            ownership,
        };
        if let Err(error) = self.inner.reaper_sender.try_send(job) {
            tracing::warn!(
                %thread_id,
                error = %error,
                capacity = self.inner.options.reaper_capacity,
                "workspace cleanup reaper is saturated; queued cleanup cancelled"
            );
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.inner.shutdown.cancel();
        let reaper = self
            .inner
            .reaper
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(reaper) = reaper
            && let Err(error) = reaper.await
        {
            tracing::warn!(%error, "workspace cleanup reaper task failed during shutdown");
        }
        debug_assert_eq!(self.inner.active_reaper_jobs.load(Ordering::SeqCst), 0);
    }

    #[cfg(test)]
    fn active_reaper_jobs(&self) -> usize {
        self.inner.active_reaper_jobs.load(Ordering::SeqCst)
    }
}

impl CatalogWorkspaceLossObserver for WorktreeRuntime {
    fn observe(&self, transitions: Vec<WorkspaceLossTransition>) -> CatalogFuture<()> {
        let runtime = self.clone();
        Box::pin(async move {
            runtime.observe(transitions).await;
        })
    }
}

async fn run_reaper(
    mut receiver: mpsc::Receiver<ReaperJob>,
    registry: WorkspaceAvailabilityRegistry,
    shutdown: CancellationToken,
    permits: Arc<Semaphore>,
    active_jobs: Arc<AtomicUsize>,
    capacity: usize,
    attempt_timeout: Duration,
) {
    let mut running = FuturesUnordered::new();
    loop {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => {
                receiver.close();
                while receiver.try_recv().is_ok() {}
                drop(running);
                return;
            }
            _ = running.next(), if !running.is_empty() => {}
            job = receiver.recv(), if running.len() < capacity => match job {
                Some(job) => running.push(run_reaper_job(
                    job,
                    registry.clone(),
                    shutdown.clone(),
                    permits.clone(),
                    active_jobs.clone(),
                    attempt_timeout,
                )),
                None if running.is_empty() => return,
                None => {}
            },
        }
    }
}

fn run_reaper_job(
    job: ReaperJob,
    registry: WorkspaceAvailabilityRegistry,
    shutdown: CancellationToken,
    permits: Arc<Semaphore>,
    active_jobs: Arc<AtomicUsize>,
    attempt_timeout: Duration,
) -> WorktreeRuntimeFuture<()> {
    Box::pin(async move {
        let _active = ActiveReaperJob::new(active_jobs);
        if !registry.cleanup_is_current(&job.ownership) {
            return;
        }
        let _permit = tokio::select! {
            () = shutdown.cancelled() => return,
            () = job.ownership.cancelled() => return,
            permit = permits.clone().acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => return,
            },
        };
        let deadline = tokio::time::Instant::now() + attempt_timeout;
        let attempt = async {
            let mut affected_thread_ids = job
                .actions
                .affected_thread_ids(job.transition.clone())
                .await?;
            affected_thread_ids.sort();
            affected_thread_ids.dedup();
            cleanup_attempt(
                job.actions.clone(),
                affected_thread_ids,
                job.max_parallel,
                job.transition.clone(),
            )
            .await
        };
        let result = tokio::select! {
            () = shutdown.cancelled() => return,
            () = job.ownership.cancelled() => return,
            result = tokio::time::timeout_at(deadline, attempt) => result,
        };
        match result {
            Ok(Ok(cleanup))
                if cleanup_succeeded(&cleanup)
                    && !registry.has_transition_admissions(&job.transition)
                    && registry.cleanup_is_current(&job.ownership) =>
            {
                log_cleanup_result(&job.transition.thread_id, &cleanup);
                registry.complete_orphan_cleanup(&job.ownership);
            }
            Ok(Ok(cleanup)) => log_cleanup_result(&job.transition.thread_id, &cleanup),
            Ok(Err(error)) => tracing::warn!(
                thread_id = %job.transition.thread_id,
                %error,
                "reaped workspace cleanup task failed"
            ),
            Err(_) => tracing::warn!(
                thread_id = %job.transition.thread_id,
                timeout_ms = attempt_timeout.as_millis(),
                "reaped workspace cleanup attempt timed out"
            ),
        }
    })
}

struct ActiveReaperJob {
    active_jobs: Arc<AtomicUsize>,
}

impl ActiveReaperJob {
    fn new(active_jobs: Arc<AtomicUsize>) -> Self {
        active_jobs.fetch_add(1, Ordering::SeqCst);
        Self { active_jobs }
    }
}

impl Drop for ActiveReaperJob {
    fn drop(&mut self) {
        self.active_jobs.fetch_sub(1, Ordering::SeqCst);
    }
}

fn cleanup_attempt(
    actions: Arc<dyn WorktreeRuntimeActions>,
    affected_thread_ids: Vec<String>,
    max_parallel: usize,
    transition: WorkspaceLossTransition,
) -> CleanupFuture {
    Box::pin(
        AssertUnwindSafe(async move {
            let results = stream::iter(affected_thread_ids)
                .map(|affected_thread_id| {
                    let actions = actions.clone();
                    let transition = transition.clone();
                    async move {
                        let (provider, terminals) = tokio::join!(
                            actions.stop_provider(affected_thread_id.clone(), transition),
                            actions.close_terminals(affected_thread_id.clone()),
                        );
                        (affected_thread_id, provider, terminals)
                    }
                })
                .buffer_unordered(max_parallel.max(1))
                .collect::<Vec<_>>()
                .await;
            let mut provider_errors = Vec::new();
            let mut terminal_errors = Vec::new();
            for (affected_thread_id, provider, terminals) in results {
                if let Err(error) = provider {
                    provider_errors.push(format!("{affected_thread_id}: {error}"));
                }
                if let Err(error) = terminals {
                    terminal_errors.push(format!("{affected_thread_id}: {error}"));
                }
            }
            CleanupResult {
                provider: aggregate_cleanup_errors(provider_errors),
                terminals: aggregate_cleanup_errors(terminal_errors),
            }
        })
        .catch_unwind()
        .map(|result| result.map_err(panic_message)),
    )
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("workspace cleanup panicked")
        .to_owned()
}

fn cleanup_succeeded(result: &CleanupResult) -> bool {
    result.provider.is_ok() && result.terminals.is_ok()
}

fn empty_cleanup_result() -> CleanupResult {
    CleanupResult {
        provider: Ok(()),
        terminals: Ok(()),
    }
}

fn cleanup_outcome_succeeded(result: &Result<CleanupResult, String>) -> bool {
    result.as_ref().is_ok_and(cleanup_succeeded)
}

fn log_cleanup_outcome(thread_id: &str, result: &Result<CleanupResult, String>) {
    match result {
        Ok(result) => log_cleanup_result(thread_id, result),
        Err(error) => {
            tracing::warn!(%thread_id, %error, "workspace cleanup task failed");
        }
    }
}

fn log_cleanup_result(thread_id: &str, result: &CleanupResult) {
    if let Err(error) = &result.provider {
        tracing::warn!(%thread_id, %error, "provider cleanup failed for unavailable workspace");
    }
    if let Err(error) = &result.terminals {
        tracing::warn!(%thread_id, %error, "terminal cleanup failed for unavailable workspace");
    }
}

fn aggregate_cleanup_errors(errors: Vec<String>) -> Result<(), String> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

struct ProductionWorktreeRuntimeActions {
    orchestration: OrchestrationEngine,
    provider: Arc<ProviderRuntimeSupervisor>,
    terminals: ServerTerminalServices,
    registry: WorkspaceAvailabilityRegistry,
}

impl WorktreeRuntimeActions for ProductionWorktreeRuntimeActions {
    fn affected_thread_ids(
        &self,
        transition: WorkspaceLossTransition,
    ) -> WorktreeRuntimeFuture<Result<Vec<String>, String>> {
        let repositories = self.orchestration.repositories();
        Box::pin(async move { workspace_thread_ids(repositories, &transition).await })
    }

    fn stop_provider(
        &self,
        thread_id: String,
        transition: WorkspaceLossTransition,
    ) -> WorktreeRuntimeFuture<Result<(), String>> {
        let provider = self.provider.clone();
        let registry = self.registry.clone();
        Box::pin(async move {
            if !registry.transition_is_current(&transition) {
                return Ok(());
            }
            let identity = match provider.capture_session_identity(&thread_id).await {
                Ok(identity) => identity,
                Err(ProviderRuntimeError::SessionNotFound { .. }) => None,
                Err(error) => return Err(error.to_string()),
            };
            if !registry.transition_is_current(&transition) {
                return Ok(());
            }
            let Some(identity) = identity else {
                return Ok(());
            };
            match provider.stop_session_if_current(identity).await {
                Ok(()) | Err(ProviderRuntimeError::SessionNotFound { .. }) => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        })
    }

    fn close_terminals(&self, thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
        let terminals = self.terminals.clone();
        Box::pin(async move {
            terminals
                .quiesce_thread_terminals_for_workspace_loss(&thread_id)
                .await
        })
    }

    fn append_warning(
        &self,
        transition: WorkspaceLossTransition,
    ) -> WorktreeRuntimeFuture<Result<(), String>> {
        let orchestration = self.orchestration.clone();
        Box::pin(async move { append_workspace_warning(&orchestration, transition).await })
    }
}

async fn append_workspace_warning(
    orchestration: &OrchestrationEngine,
    transition: WorkspaceLossTransition,
) -> Result<(), String> {
    let activity_id = workspace_warning_activity_id(&transition);
    let created_at = now_iso();
    orchestration
        .dispatch(OrchestrationCommand::ThreadActivityAppend {
            command_id: format!("server:{activity_id}"),
            thread_id: transition.thread_id.clone(),
            activity: ActivityInput {
                id: activity_id,
                tone: "warning".to_owned(),
                kind: "workspace-unavailable".to_owned(),
                summary: "Workspace unavailable; live provider and terminal sessions were stopped."
                    .to_owned(),
                payload: json!({
                    "availability": transition.availability,
                    "path": transition.path,
                }),
                turn_id: None,
                sequence: None,
                created_at: created_at.clone(),
            },
            created_at,
        })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn workspace_warning_activity_id(transition: &WorkspaceLossTransition) -> String {
    let availability = availability_token(transition.availability);
    let token = sha256_hex(
        format!(
            "{}\0{}\0{}\0{}",
            transition.thread_id, transition.repository_key, transition.generation, availability,
        )
        .as_bytes(),
    );
    format!("workspace-loss:{token}")
}

fn availability_token(availability: AdoptedWorktreeAvailability) -> &'static str {
    match availability {
        AdoptedWorktreeAvailability::Present => "present",
        AdoptedWorktreeAvailability::MissingRegistered => "missing-registered",
        AdoptedWorktreeAvailability::MissingUnregistered => "missing-unregistered",
        AdoptedWorktreeAvailability::VerificationUnavailable => "verification-unavailable",
        AdoptedWorktreeAvailability::Removing => "removing",
    }
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

async fn workspace_thread_ids(
    repositories: Repositories,
    transition: &WorkspaceLossTransition,
) -> Result<Vec<String>, String> {
    let Some(owner) = repositories
        .get_thread(transition.thread_id.clone())
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(vec![transition.thread_id.clone()]);
    };
    let project = repositories
        .get_project(owner.project_id.clone())
        .await
        .map_err(|error| error.to_string())?;
    if project
        .as_ref()
        .and_then(|project| project.worktree_repository_key.as_deref())
        .is_some_and(|repository_key| repository_key != transition.repository_key)
    {
        return Err(
            "workspace-loss repository identity no longer matches the persisted project".to_owned(),
        );
    }
    let project_root = project.map(|project| project.workspace_root);
    let transition_path = normalize_worktree_path_key(&transition.path, host_path_platform());
    let mut thread_ids = repositories
        .list_threads_by_project(owner.project_id)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|thread| thread.deleted_at.is_none())
        .filter_map(|thread| {
            let path = thread
                .worktree_path
                .as_deref()
                .or(project_root.as_deref())?;
            (normalize_worktree_path_key(std::path::Path::new(path), host_path_platform())
                == transition_path)
                .then_some(thread.thread_id)
        })
        .collect::<Vec<_>>();
    if !thread_ids.contains(&transition.thread_id) {
        thread_ids.push(transition.thread_id.clone());
    }
    thread_ids.sort();
    thread_ids.dedup();
    Ok(thread_ids)
}

#[cfg(test)]
mod tests {
    use std::{
        future::{Future, pending, ready},
        path::PathBuf,
        pin::Pin,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        task::{Context, Poll},
        time::Duration,
    };

    use serde_json::json;
    use tokio::sync::Semaphore;

    use super::{
        WorktreeRuntime, WorktreeRuntimeActions, WorktreeRuntimeFuture, WorktreeRuntimeOptions,
        append_workspace_warning, workspace_thread_ids, workspace_warning_activity_id,
    };
    use crate::worktree_catalog::{
        AdoptedWorktreeAvailability, WorkspaceAvailabilityRegistry, WorkspaceLossTransition,
    };
    use crate::{
        orchestration::{EngineOptions, OrchestrationCommand, OrchestrationEngine, load_snapshot},
        persistence::{Database, run_migrations},
    };

    #[derive(Default)]
    struct FakeActions {
        provider_calls: AtomicUsize,
        terminal_calls: AtomicUsize,
        warnings: Mutex<Vec<WorkspaceLossTransition>>,
        affected_threads: Mutex<Option<Vec<String>>>,
        provider_threads: Mutex<Vec<String>>,
        terminal_threads: Mutex<Vec<String>>,
        cleanup_never_finishes: bool,
        warning_fails: bool,
        warning_never_finishes: bool,
    }

    impl FakeActions {
        fn pending() -> Self {
            Self {
                cleanup_never_finishes: true,
                ..Self::default()
            }
        }

        fn failing_warning() -> Self {
            Self {
                warning_fails: true,
                ..Self::default()
            }
        }

        fn pending_warning() -> Self {
            Self {
                warning_never_finishes: true,
                ..Self::default()
            }
        }
    }

    impl WorktreeRuntimeActions for FakeActions {
        fn affected_thread_ids(
            &self,
            transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<Vec<String>, String>> {
            let threads = self
                .affected_threads
                .lock()
                .expect("affected thread lock")
                .clone()
                .unwrap_or_else(|| vec![transition.thread_id]);
            Box::pin(ready(Ok(threads)))
        }

        fn stop_provider(
            &self,
            thread_id: String,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.provider_calls.fetch_add(1, Ordering::SeqCst);
            self.provider_threads
                .lock()
                .expect("provider thread lock")
                .push(thread_id);
            if self.cleanup_never_finishes {
                Box::pin(pending())
            } else {
                Box::pin(ready(Ok(())))
            }
        }

        fn close_terminals(&self, thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.terminal_calls.fetch_add(1, Ordering::SeqCst);
            self.terminal_threads
                .lock()
                .expect("terminal thread lock")
                .push(thread_id);
            if self.cleanup_never_finishes {
                Box::pin(pending())
            } else {
                Box::pin(ready(Ok(())))
            }
        }

        fn append_warning(
            &self,
            transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.warnings.lock().expect("warning lock").push(transition);
            if self.warning_never_finishes {
                Box::pin(pending())
            } else if self.warning_fails {
                Box::pin(ready(Err("warning persistence failed".to_owned())))
            } else {
                Box::pin(ready(Ok(())))
            }
        }
    }

    struct ConcurrencyActions {
        calls: AtomicUsize,
        active: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        started: Arc<Semaphore>,
        release: Arc<Semaphore>,
    }

    impl WorktreeRuntimeActions for ConcurrencyActions {
        fn stop_provider(
            &self,
            _thread_id: String,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(active, Ordering::SeqCst);
            self.started.add_permits(1);
            let release = self.release.clone();
            let active_count = self.active.clone();
            Box::pin(async move {
                let permit = release.acquire().await.expect("release semaphore");
                permit.forget();
                active_count.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })
        }

        fn close_terminals(&self, _thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }

        fn append_warning(
            &self,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }
    }

    struct RetryActions {
        provider_calls: AtomicUsize,
        retry_started: Arc<Semaphore>,
        retry_release: Arc<Semaphore>,
        panic_first: bool,
    }

    struct ResolverRetryActions {
        resolver_calls: AtomicUsize,
        provider_calls: AtomicUsize,
        provider_threads: Mutex<Vec<String>>,
        retry_started: Arc<Semaphore>,
        retry_release: Arc<Semaphore>,
    }

    struct RecoveryRaceActions {
        resolver_calls: AtomicUsize,
        provider_calls: AtomicUsize,
        retry_resolver_started: Arc<Semaphore>,
        retry_resolver_release: Arc<Semaphore>,
    }

    #[derive(Default)]
    struct HangingAliasActions {
        provider_calls: AtomicUsize,
        terminal_calls: AtomicUsize,
    }

    impl WorktreeRuntimeActions for HangingAliasActions {
        fn affected_thread_ids(
            &self,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<Vec<String>, String>> {
            Box::pin(pending())
        }

        fn stop_provider(
            &self,
            _thread_id: String,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.provider_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(ready(Ok(())))
        }

        fn close_terminals(&self, _thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.terminal_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(ready(Ok(())))
        }

        fn append_warning(
            &self,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }
    }

    impl WorktreeRuntimeActions for RecoveryRaceActions {
        fn affected_thread_ids(
            &self,
            transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<Vec<String>, String>> {
            let attempt = self.resolver_calls.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                Box::pin(ready(Ok(vec![transition.thread_id])))
            } else {
                self.retry_resolver_started.add_permits(1);
                let release = self.retry_resolver_release.clone();
                Box::pin(async move {
                    release.acquire().await.expect("resolver release").forget();
                    Ok(vec![transition.thread_id])
                })
            }
        }

        fn stop_provider(
            &self,
            _thread_id: String,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            let attempt = self.provider_calls.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                Box::pin(ready(Err("initial cleanup failed".to_owned())))
            } else {
                Box::pin(ready(Ok(())))
            }
        }

        fn close_terminals(&self, _thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }

        fn append_warning(
            &self,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }
    }

    impl WorktreeRuntimeActions for ResolverRetryActions {
        fn affected_thread_ids(
            &self,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<Vec<String>, String>> {
            let attempt = self.resolver_calls.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                Box::pin(ready(Err("alias query failed".to_owned())))
            } else {
                Box::pin(ready(Ok(vec!["thread-1".to_owned(), "panel-1".to_owned()])))
            }
        }

        fn stop_provider(
            &self,
            thread_id: String,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.provider_threads
                .lock()
                .expect("provider thread lock")
                .push(thread_id);
            if self.provider_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Box::pin(ready(Ok(())))
            } else {
                self.retry_started.add_permits(1);
                let release = self.retry_release.clone();
                Box::pin(async move {
                    release.acquire().await.expect("retry release").forget();
                    Ok(())
                })
            }
        }

        fn close_terminals(&self, _thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }

        fn append_warning(
            &self,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }
    }

    impl WorktreeRuntimeActions for RetryActions {
        fn stop_provider(
            &self,
            _thread_id: String,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            let attempt = self.provider_calls.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                if self.panic_first {
                    return Box::pin(async { panic!("first provider cleanup panicked") });
                }
                return Box::pin(ready(Err("first provider cleanup failed".to_owned())));
            }
            self.retry_started.add_permits(1);
            let release = self.retry_release.clone();
            Box::pin(async move {
                let permit = release.acquire().await.expect("retry release");
                permit.forget();
                Ok(())
            })
        }

        fn close_terminals(&self, _thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }

        fn append_warning(
            &self,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }
    }

    struct PendingDrop {
        drops: Arc<AtomicUsize>,
    }

    impl Future for PendingDrop {
        type Output = Result<(), String>;

        fn poll(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Self::Output> {
            Poll::Pending
        }
    }

    impl Drop for PendingDrop {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct ShutdownActions {
        drops: Arc<AtomicUsize>,
    }

    impl WorktreeRuntimeActions for ShutdownActions {
        fn stop_provider(
            &self,
            _thread_id: String,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(PendingDrop {
                drops: self.drops.clone(),
            })
        }

        fn close_terminals(&self, _thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }

        fn append_warning(
            &self,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }
    }

    struct PersistedAliasActions {
        repositories: crate::persistence::Repositories,
        provider_threads: Arc<Mutex<Vec<String>>>,
        terminal_threads: Arc<Mutex<Vec<String>>>,
    }

    impl WorktreeRuntimeActions for PersistedAliasActions {
        fn affected_thread_ids(
            &self,
            transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<Vec<String>, String>> {
            let repositories = self.repositories.clone();
            Box::pin(async move { workspace_thread_ids(repositories, &transition).await })
        }

        fn stop_provider(
            &self,
            thread_id: String,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.provider_threads
                .lock()
                .expect("provider thread lock")
                .push(thread_id);
            Box::pin(ready(Ok(())))
        }

        fn close_terminals(&self, thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.terminal_threads
                .lock()
                .expect("terminal thread lock")
                .push(thread_id);
            Box::pin(ready(Ok(())))
        }

        fn append_warning(
            &self,
            _transition: WorkspaceLossTransition,
        ) -> WorktreeRuntimeFuture<Result<(), String>> {
            Box::pin(ready(Ok(())))
        }
    }

    fn transition(index: usize) -> WorkspaceLossTransition {
        WorkspaceLossTransition {
            thread_id: format!("thread-{index}"),
            repository_key: "repository-a".to_owned(),
            generation: 7,
            path: PathBuf::from(format!("/repo/worktrees/missing-{index}")),
            availability: AdoptedWorktreeAvailability::MissingRegistered,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn quiesce_runs_provider_and_all_terminal_cleanup_once() {
        let actions = Arc::new(FakeActions::default());
        let registry = WorkspaceAvailabilityRegistry::new();
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            registry.clone(),
            WorktreeRuntimeOptions::default(),
        );

        runtime.observe(vec![transition(1)]).await;

        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 1);
        assert_eq!(actions.terminal_calls.load(Ordering::SeqCst), 1);
        assert_eq!(actions.warnings.lock().expect("warning lock").len(), 1);
        assert!(!registry.orphan_cleanup_pending("thread-1"));
        runtime.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn loss_deadline_does_not_wait_for_an_unreleased_admission() {
        let actions = Arc::new(FakeActions::default());
        let registry = WorkspaceAvailabilityRegistry::new();
        let loss = transition(1);
        let lease = registry
            .acquire_admission(&loss.thread_id, [loss.path.as_path()])
            .await
            .expect("workspace admission");
        let cancellation = lease.loss_cancellation();
        assert!(registry.mark_unavailable(loss.clone()).await);
        assert!(cancellation.is_cancelled());
        assert!(
            registry
                .acquire_admission(&loss.thread_id, [loss.path.as_path()])
                .await
                .is_err(),
            "guard installation rejects later work immediately"
        );
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            registry.clone(),
            WorktreeRuntimeOptions {
                graceful_timeout: Duration::from_secs(5),
                reaper_capacity: 1,
                max_parallel_quiesces: 1,
            },
        );
        let observer = runtime.clone();
        let observe = tokio::spawn(async move {
            observer.observe(vec![loss]).await;
        });
        tokio::task::yield_now().await;

        assert_eq!(
            actions.provider_calls.load(Ordering::SeqCst),
            1,
            "visible provider cleanup starts without admission drain"
        );
        assert_eq!(actions.terminal_calls.load(Ordering::SeqCst), 1);
        assert_eq!(actions.warnings.lock().expect("warning lock").len(), 1);
        assert!(!observe.is_finished());

        tokio::time::advance(Duration::from_secs(5)).await;
        observe
            .await
            .expect("loss returns at its graceful deadline");
        assert!(
            registry.orphan_cleanup_pending(
                &lease.loss_cancellation().unavailable().unwrap().thread_id
            )
        );

        drop(lease);
        runtime.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn hung_alias_resolution_does_not_delay_known_canonical_cleanup() {
        let actions = Arc::new(HangingAliasActions::default());
        let registry = WorkspaceAvailabilityRegistry::new();
        let loss = transition(1);
        assert!(registry.mark_unavailable(loss.clone()).await);
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            registry.clone(),
            WorktreeRuntimeOptions {
                graceful_timeout: Duration::from_secs(5),
                reaper_capacity: 1,
                max_parallel_quiesces: 1,
            },
        );

        let observer = runtime.clone();
        let observe = tokio::spawn(async move { observer.observe(vec![loss]).await });
        tokio::task::yield_now().await;

        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 1);
        assert_eq!(actions.terminal_calls.load(Ordering::SeqCst), 1);
        assert!(!observe.is_finished());

        tokio::time::advance(Duration::from_secs(5)).await;
        observe.await.expect("loss finishes at the shared deadline");
        assert!(registry.orphan_cleanup_pending("thread-1"));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn runtime_loss_quiesces_persisted_panel_aliases_and_preserves_histories() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let engine = OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .expect("engine starts");
        engine
            .dispatch(
                serde_json::from_value(json!({
                    "type":"project.create","commandId":"create-project","projectId":"project-1",
                    "title":"Project","workspaceRoot":"/repo","defaultModelSelection":null,
                    "createdAt":"2026-08-10T00:00:00Z"
                }))
                .expect("project command"),
            )
            .await
            .expect("project created");
        for (thread_id, kind, path) in [
            ("workspace", "workspace", "/repo/worktrees/missing-1"),
            ("panel-a", "panel", "/repo/worktrees/missing-1/./alias/.."),
            ("panel-other", "panel", "/repo/worktrees/other"),
        ] {
            engine
                .dispatch(
                    serde_json::from_value(json!({
                        "type":"thread.create","commandId":format!("create-{thread_id}"),
                        "threadId":thread_id,"projectId":"project-1","title":thread_id,
                        "kind":kind,"modelSelection":{"instanceId":"codex","model":"gpt-5"},
                        "runtimeMode":"full-access","interactionMode":"default","branch":null,
                        "worktreePath":path,"createdAt":"2026-08-10T00:00:00Z"
                    }))
                    .expect("thread command"),
                )
                .await
                .expect("thread created");
        }
        for thread_id in ["workspace", "panel-a"] {
            engine
                .dispatch(
                    serde_json::from_value(json!({
                        "type":"thread.turn.start","commandId":format!("turn-{thread_id}"),
                        "threadId":thread_id,
                        "message":{"messageId":format!("message-{thread_id}"),"role":"user",
                            "text":format!("retained history for {thread_id}"),"attachments":[]},
                        "runtimeMode":"full-access","interactionMode":"default",
                        "createdAt":"2026-08-10T00:00:00Z"
                    }))
                    .expect("turn command"),
                )
                .await
                .expect("turn created");
        }

        let mut loss = transition(1);
        loss.thread_id = "workspace".to_owned();
        let provider_threads = Arc::new(Mutex::new(Vec::new()));
        let terminal_threads = Arc::new(Mutex::new(Vec::new()));
        let runtime = WorktreeRuntime::start_for_test(
            Arc::new(PersistedAliasActions {
                repositories: engine.repositories(),
                provider_threads: provider_threads.clone(),
                terminal_threads: terminal_threads.clone(),
            }),
            WorkspaceAvailabilityRegistry::new(),
            WorktreeRuntimeOptions::default(),
        );
        runtime.observe(vec![loss]).await;

        let mut stopped_providers = provider_threads
            .lock()
            .expect("provider thread lock")
            .clone();
        stopped_providers.sort();
        let mut stopped_terminals = terminal_threads
            .lock()
            .expect("terminal thread lock")
            .clone();
        stopped_terminals.sort();
        assert_eq!(stopped_providers, ["panel-a", "workspace"]);
        assert_eq!(stopped_terminals, ["panel-a", "workspace"]);
        let snapshot = load_snapshot(&engine.repositories())
            .await
            .expect("snapshot");
        for thread_id in ["workspace", "panel-a"] {
            assert!(
                snapshot
                    .threads
                    .iter()
                    .any(|thread| { thread.thread_id == thread_id && thread.deleted_at.is_none() })
            );
            assert!(snapshot.messages.iter().any(|message| {
                message.message_id == format!("message-{thread_id}")
                    && message.text == format!("retained history for {thread_id}")
            }));
        }
        runtime.shutdown().await;
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn quiesce_stops_every_deduplicated_persisted_workspace_alias() {
        let actions = Arc::new(FakeActions::default());
        *actions
            .affected_threads
            .lock()
            .expect("affected thread lock") = Some(vec![
            "workspace".to_owned(),
            "panel-a".to_owned(),
            "panel-a".to_owned(),
        ]);
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            WorkspaceAvailabilityRegistry::new(),
            WorktreeRuntimeOptions::default(),
        );

        runtime.observe(vec![transition(1)]).await;

        let mut providers = actions
            .provider_threads
            .lock()
            .expect("provider thread lock")
            .clone();
        providers.sort();
        let mut terminals = actions
            .terminal_threads
            .lock()
            .expect("terminal thread lock")
            .clone();
        terminals.sort();
        assert_eq!(providers, ["panel-a", "thread-1", "workspace"]);
        assert_eq!(terminals, ["panel-a", "thread-1", "workspace"]);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn warning_failure_does_not_prevent_provider_or_terminal_cleanup() {
        let actions = Arc::new(FakeActions::failing_warning());
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            WorkspaceAvailabilityRegistry::new(),
            WorktreeRuntimeOptions::default(),
        );

        runtime.observe(vec![transition(1)]).await;

        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 1);
        assert_eq!(actions.terminal_calls.load(Ordering::SeqCst), 1);
        runtime.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_warning_does_not_delay_cleanup_or_exceed_the_graceful_bound() {
        let actions = Arc::new(FakeActions::pending_warning());
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            WorkspaceAvailabilityRegistry::new(),
            WorktreeRuntimeOptions::default(),
        );
        let observer = runtime.clone();
        let task = tokio::spawn(async move {
            observer.observe(vec![transition(1)]).await;
        });
        tokio::task::yield_now().await;

        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 1);
        assert_eq!(actions.terminal_calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(5)).await;
        task.await.expect("bounded loss observer");
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn admitted_transition_persists_one_deterministic_warning_and_preserves_conversation() {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let engine = OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .expect("engine");
        for command in [
            json!({
                "type":"project.create","commandId":"create-project","projectId":"project-1",
                "title":"Project","workspaceRoot":"/repo","defaultModelSelection":null,
                "createdAt":"2026-08-10T00:00:00Z"
            }),
            json!({
                "type":"thread.create","commandId":"create-thread","threadId":"thread-1",
                "projectId":"project-1","title":"Thread","kind":"workspace",
                "modelSelection":{"instanceId":"codex","model":"gpt-5"},
                "runtimeMode":"full-access","interactionMode":"default","branch":"feature",
                "worktreePath":"/repo/worktrees/missing-1","createdAt":"2026-08-10T00:00:00Z"
            }),
            json!({
                "type":"thread.turn.start","commandId":"conversation-turn","threadId":"thread-1",
                "message":{"messageId":"message-1","role":"user","text":"retained conversation","attachments":[]},
                "runtimeMode":"full-access","interactionMode":"default",
                "createdAt":"2026-08-10T00:00:00Z"
            }),
        ] {
            engine
                .dispatch(serde_json::from_value::<OrchestrationCommand>(command).expect("command"))
                .await
                .expect("dispatch");
        }
        let registry = WorkspaceAvailabilityRegistry::new();
        let loss = transition(1);
        assert!(registry.mark_unavailable(loss.clone()).await);
        append_workspace_warning(&engine, loss.clone())
            .await
            .expect("warning");
        assert!(!registry.mark_unavailable(loss.clone()).await);

        let snapshot = load_snapshot(&engine.repositories())
            .await
            .expect("snapshot");
        assert!(
            snapshot
                .threads
                .iter()
                .any(|thread| thread.thread_id == "thread-1" && thread.deleted_at.is_none())
        );
        assert!(
            snapshot
                .messages
                .iter()
                .any(|message| message.message_id == "message-1"
                    && message.text == "retained conversation")
        );
        let warnings = snapshot
            .activities
            .iter()
            .filter(|activity| activity.kind == "workspace-unavailable")
            .collect::<Vec<_>>();
        assert_eq!(warnings.len(), 1);
        assert_eq!(
            warnings[0].activity_id,
            workspace_warning_activity_id(&loss)
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn overlapping_observers_share_one_global_quiesce_bound() {
        let started = Arc::new(Semaphore::new(0));
        let release = Arc::new(Semaphore::new(0));
        let actions = Arc::new(ConcurrencyActions {
            calls: AtomicUsize::new(0),
            active: Arc::new(AtomicUsize::new(0)),
            peak: Arc::new(AtomicUsize::new(0)),
            started: started.clone(),
            release: release.clone(),
        });
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            WorkspaceAvailabilityRegistry::new(),
            WorktreeRuntimeOptions {
                graceful_timeout: Duration::from_secs(60),
                reaper_capacity: 4,
                max_parallel_quiesces: 2,
            },
        );
        let observer_a = runtime.clone();
        let observer_b = runtime.clone();
        let task_a = tokio::spawn(async move {
            observer_a
                .observe(vec![transition(1), transition(2), transition(3)])
                .await;
        });
        let task_b = tokio::spawn(async move {
            observer_b
                .observe(vec![transition(4), transition(5), transition(6)])
                .await;
        });

        for expected in [2, 4, 6] {
            let permits = started
                .acquire_many(2)
                .await
                .expect("two cleanup attempts started");
            permits.forget();
            tokio::task::yield_now().await;
            assert_eq!(actions.calls.load(Ordering::SeqCst), expected);
            assert_eq!(actions.active.load(Ordering::SeqCst), 2);
            release.add_permits(2);
        }
        task_a.await.expect("first observer");
        task_b.await.expect("second observer");

        assert_eq!(actions.peak.load(Ordering::SeqCst), 2);
        assert_eq!(actions.active.load(Ordering::SeqCst), 0);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn cleanup_error_retains_orphan_marker_until_a_repeat_attempt_succeeds() {
        let retry_started = Arc::new(Semaphore::new(0));
        let retry_release = Arc::new(Semaphore::new(0));
        let actions = Arc::new(RetryActions {
            provider_calls: AtomicUsize::new(0),
            retry_started: retry_started.clone(),
            retry_release: retry_release.clone(),
            panic_first: false,
        });
        let registry = WorkspaceAvailabilityRegistry::new();
        assert!(registry.mark_unavailable(transition(1)).await);
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            registry.clone(),
            WorktreeRuntimeOptions::default(),
        );

        runtime.observe(vec![transition(1)]).await;
        let permit = retry_started.acquire().await.expect("retry started");
        permit.forget();
        assert!(registry.orphan_cleanup_pending("thread-1"));
        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 2);

        retry_release.add_permits(1);
        while registry.orphan_cleanup_pending("thread-1") {
            tokio::task::yield_now().await;
        }
        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 2);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn alias_resolution_failure_cleans_owner_then_retry_resolves_every_alias() {
        let retry_started = Arc::new(Semaphore::new(0));
        let retry_release = Arc::new(Semaphore::new(0));
        let actions = Arc::new(ResolverRetryActions {
            resolver_calls: AtomicUsize::new(0),
            provider_calls: AtomicUsize::new(0),
            provider_threads: Mutex::new(Vec::new()),
            retry_started: retry_started.clone(),
            retry_release: retry_release.clone(),
        });
        let registry = WorkspaceAvailabilityRegistry::new();
        assert!(registry.mark_unavailable(transition(1)).await);
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            registry.clone(),
            WorktreeRuntimeOptions::default(),
        );

        runtime.observe(vec![transition(1)]).await;
        assert!(
            registry.orphan_cleanup_pending("thread-1"),
            "resolver failure retains transition cleanup ownership"
        );
        retry_started
            .acquire_many(2)
            .await
            .expect("owner and panel retry start")
            .forget();
        assert_eq!(actions.resolver_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            actions
                .provider_threads
                .lock()
                .expect("provider threads")
                .as_slice(),
            ["thread-1", "panel-1", "thread-1"]
        );

        retry_release.add_permits(2);
        while registry.orphan_cleanup_pending("thread-1") {
            tokio::task::yield_now().await;
        }
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn exact_recovery_cancels_a_stale_active_retry_before_cleanup() {
        let resolver_started = Arc::new(Semaphore::new(0));
        let resolver_release = Arc::new(Semaphore::new(0));
        let actions = Arc::new(RecoveryRaceActions {
            resolver_calls: AtomicUsize::new(0),
            provider_calls: AtomicUsize::new(0),
            retry_resolver_started: resolver_started.clone(),
            retry_resolver_release: resolver_release.clone(),
        });
        let registry = WorkspaceAvailabilityRegistry::new();
        let loss = transition(1);
        assert!(registry.mark_unavailable(loss.clone()).await);
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            registry.clone(),
            WorktreeRuntimeOptions::default(),
        );

        runtime.observe(vec![loss.clone()]).await;
        resolver_started
            .acquire()
            .await
            .expect("retry resolver starts")
            .forget();
        assert!(registry.orphan_cleanup_pending(&loss.thread_id));

        registry
            .clear_recovered_in_repository(
                &loss.thread_id,
                loss.path.as_path(),
                &loss.repository_key,
            )
            .await;
        assert!(!registry.orphan_cleanup_pending(&loss.thread_id));
        let replacement = registry
            .acquire_admission(&loss.thread_id, [loss.path.as_path()])
            .await
            .expect("recovered workspace admits replacement work");
        resolver_release.add_permits(1);
        while runtime.active_reaper_jobs() != 0 {
            tokio::task::yield_now().await;
        }

        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 1);
        drop(replacement);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn cleanup_panic_retains_orphan_marker_until_a_repeat_attempt_succeeds() {
        let retry_started = Arc::new(Semaphore::new(0));
        let retry_release = Arc::new(Semaphore::new(0));
        let actions = Arc::new(RetryActions {
            provider_calls: AtomicUsize::new(0),
            retry_started: retry_started.clone(),
            retry_release: retry_release.clone(),
            panic_first: true,
        });
        let registry = WorkspaceAvailabilityRegistry::new();
        assert!(registry.mark_unavailable(transition(1)).await);
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            registry.clone(),
            WorktreeRuntimeOptions::default(),
        );

        runtime.observe(vec![transition(1)]).await;
        let permit = retry_started.acquire().await.expect("retry started");
        permit.forget();
        assert!(registry.orphan_cleanup_pending("thread-1"));
        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 2);

        retry_release.add_permits(1);
        while registry.orphan_cleanup_pending("thread-1") {
            tokio::task::yield_now().await;
        }
        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 2);
        runtime.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_cancels_and_joins_every_runtime_owned_reaper_cleanup() {
        let drops = Arc::new(AtomicUsize::new(0));
        let actions = Arc::new(ShutdownActions {
            drops: drops.clone(),
        });
        let registry = WorkspaceAvailabilityRegistry::new();
        assert!(registry.mark_unavailable(transition(1)).await);
        let runtime = WorktreeRuntime::start_for_test(
            actions,
            registry.clone(),
            WorktreeRuntimeOptions {
                graceful_timeout: Duration::from_secs(5),
                reaper_capacity: 1,
                max_parallel_quiesces: 1,
            },
        );
        let observer = runtime.clone();
        let task = tokio::spawn(async move {
            observer.observe(vec![transition(1)]).await;
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        task.await.expect("observer reaches reaper handoff");
        while runtime.active_reaper_jobs() == 0 {
            tokio::task::yield_now().await;
        }

        runtime.shutdown().await;

        assert_eq!(runtime.active_reaper_jobs(), 0);
        assert_eq!(
            drops.load(Ordering::SeqCst),
            2,
            "the timed-out observer future and active reaper future are both dropped"
        );
        assert!(registry.orphan_cleanup_pending("thread-1"));
    }

    #[tokio::test(start_paused = true)]
    async fn five_second_bound_reaps_late_cleanup_and_saturation_retains_guards() {
        let actions = Arc::new(FakeActions::pending());
        let registry = WorkspaceAvailabilityRegistry::new();
        for index in 1..=3 {
            assert!(registry.mark_unavailable(transition(index)).await);
        }
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            registry.clone(),
            WorktreeRuntimeOptions {
                graceful_timeout: Duration::from_secs(5),
                reaper_capacity: 1,
                max_parallel_quiesces: 3,
            },
        );
        let observer = runtime.clone();
        let task = tokio::spawn(async move {
            observer
                .observe(vec![transition(1), transition(2), transition(3)])
                .await;
        });
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_secs(5)).await;
        task.await.expect("loss observer task");

        while runtime.active_reaper_jobs() == 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 4);
        assert_eq!(actions.terminal_calls.load(Ordering::SeqCst), 4);
        assert_eq!(actions.warnings.lock().expect("warning lock").len(), 3);
        for index in 1..=3 {
            assert!(registry.orphan_cleanup_pending(&format!("thread-{index}")));
            assert!(
                registry
                    .guard_thread(&format!("thread-{index}"))
                    .await
                    .is_err()
            );
        }
        runtime.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn hung_reaper_attempts_release_global_permits_at_their_deadline() {
        let actions = Arc::new(FakeActions::pending());
        let registry = WorkspaceAvailabilityRegistry::new();
        for index in 1..=3 {
            assert!(registry.mark_unavailable(transition(index)).await);
        }
        let runtime = WorktreeRuntime::start_for_test(
            actions.clone(),
            registry.clone(),
            WorktreeRuntimeOptions {
                graceful_timeout: Duration::from_secs(5),
                reaper_capacity: 4,
                max_parallel_quiesces: 2,
            },
        );
        let initial_runtime = runtime.clone();
        let initial = tokio::spawn(async move {
            initial_runtime
                .observe(vec![transition(1), transition(2)])
                .await;
        });
        tokio::task::yield_now().await;
        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_secs(5)).await;
        initial.await.expect("initial losses reach reaper handoff");
        while actions.provider_calls.load(Ordering::SeqCst) < 4 {
            tokio::task::yield_now().await;
        }
        assert_eq!(runtime.active_reaper_jobs(), 2);

        let later_runtime = runtime.clone();
        let later = tokio::spawn(async move {
            later_runtime.observe(vec![transition(3)]).await;
        });
        tokio::task::yield_now().await;
        assert_eq!(
            actions.provider_calls.load(Ordering::SeqCst),
            4,
            "later cleanup waits while every global permit is owned"
        );

        tokio::time::advance(Duration::from_secs(5)).await;
        while actions.provider_calls.load(Ordering::SeqCst) < 5 {
            tokio::task::yield_now().await;
        }
        assert_eq!(runtime.active_reaper_jobs(), 0);
        assert!(!later.is_finished());
        tokio::time::advance(Duration::from_secs(5)).await;
        later.await.expect("later loss reaches its own deadline");
        for index in 1..=3 {
            assert!(registry.orphan_cleanup_pending(&format!("thread-{index}")));
        }
        runtime.shutdown().await;
    }
}
