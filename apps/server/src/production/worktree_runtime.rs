use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{StreamExt, stream};
use serde_json::json;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::{
    crypto::sha256_hex,
    orchestration::{OrchestrationCommand, OrchestrationEngine, engine::ActivityInput},
    production::{
        provider_runtime::{ProviderRuntimeError, ProviderRuntimeSupervisor},
        server_terminal::ServerTerminalServices,
    },
    worktree_catalog::{
        AdoptedWorktreeAvailability, CatalogFuture, CatalogWorkspaceLossObserver,
        WorkspaceAvailabilityRegistry, WorkspaceLossTransition,
    },
};

const PRODUCTION_REAPER_CAPACITY: usize = 64;
const PRODUCTION_MAX_PARALLEL_QUIESCES: usize = 16;
const PRODUCTION_GRACEFUL_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) type WorktreeRuntimeFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

pub(crate) trait WorktreeRuntimeActions: Send + Sync + 'static {
    fn stop_provider(&self, thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>>;
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
    shutdown: CancellationToken,
    reaper: Mutex<Option<JoinHandle<()>>>,
}

struct ReaperJob {
    thread_id: String,
    cleanup: JoinHandle<CleanupResult>,
}

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
        let reaper = tokio::spawn(async move {
            run_reaper(reaper_receiver, reaper_registry, reaper_shutdown).await;
        });
        Self {
            inner: Arc::new(Inner {
                actions,
                registry,
                options,
                reaper_sender,
                shutdown,
                reaper: Mutex::new(Some(reaper)),
            }),
        }
    }

    pub(crate) async fn observe(&self, transitions: Vec<WorkspaceLossTransition>) {
        stream::iter(transitions)
            .for_each_concurrent(
                self.inner.options.max_parallel_quiesces.max(1),
                |transition| self.quiesce(transition),
            )
            .await;
    }

    async fn quiesce(&self, transition: WorkspaceLossTransition) {
        let thread_id = transition.thread_id.clone();
        let deadline = tokio::time::Instant::now() + self.inner.options.graceful_timeout;
        let actions = self.inner.actions.clone();
        let cleanup_thread_id = thread_id.clone();
        let mut cleanup = tokio::spawn(async move {
            let (provider, terminals) = tokio::join!(
                actions.stop_provider(cleanup_thread_id.clone()),
                actions.close_terminals(cleanup_thread_id),
            );
            CleanupResult {
                provider,
                terminals,
            }
        });

        match tokio::time::timeout_at(deadline, self.inner.actions.append_warning(transition)).await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%thread_id, %error, "failed to append workspace-unavailable activity");
            }
            Err(_) => {
                tracing::warn!(%thread_id, "workspace-unavailable activity persistence timed out");
            }
        }

        match tokio::time::timeout_at(deadline, &mut cleanup).await {
            Ok(Ok(result)) => log_cleanup_result(&thread_id, &result),
            Ok(Err(error)) => {
                tracing::warn!(%thread_id, %error, "workspace cleanup task failed");
            }
            Err(_) => {
                self.inner
                    .registry
                    .set_orphan_cleanup_pending(&thread_id, true)
                    .await;
                let job = ReaperJob {
                    thread_id: thread_id.clone(),
                    cleanup,
                };
                if let Err(error) = self.inner.reaper_sender.try_send(job) {
                    tracing::warn!(
                        %thread_id,
                        error = %error,
                        capacity = self.inner.options.reaper_capacity,
                        "workspace cleanup reaper is saturated; cleanup detached"
                    );
                }
            }
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
) {
    loop {
        let job = tokio::select! {
            () = shutdown.cancelled() => return,
            job = receiver.recv() => match job {
                Some(job) => job,
                None => return,
            },
        };
        let cleanup = tokio::select! {
            () = shutdown.cancelled() => return,
            cleanup = job.cleanup => cleanup,
        };
        match cleanup {
            Ok(result) => log_cleanup_result(&job.thread_id, &result),
            Err(error) => {
                tracing::warn!(thread_id = %job.thread_id, %error, "reaped workspace cleanup task failed");
            }
        }
        registry
            .set_orphan_cleanup_pending(&job.thread_id, false)
            .await;
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

struct ProductionWorktreeRuntimeActions {
    orchestration: OrchestrationEngine,
    provider: Arc<ProviderRuntimeSupervisor>,
    terminals: ServerTerminalServices,
}

impl WorktreeRuntimeActions for ProductionWorktreeRuntimeActions {
    fn stop_provider(&self, thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
        let provider = self.provider.clone();
        Box::pin(async move {
            match provider
                .handle_orchestration(OrchestrationCommand::ThreadSessionStop {
                    command_id: format!("workspace-loss:{thread_id}:provider-stop"),
                    thread_id: thread_id.clone(),
                    created_at: now_iso(),
                })
                .await
            {
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

#[cfg(test)]
mod tests {
    use std::{
        future::{pending, ready},
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use serde_json::json;

    use super::{
        WorktreeRuntime, WorktreeRuntimeActions, WorktreeRuntimeFuture, WorktreeRuntimeOptions,
        append_workspace_warning, workspace_warning_activity_id,
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
        fn stop_provider(&self, _thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.provider_calls.fetch_add(1, Ordering::SeqCst);
            if self.cleanup_never_finishes {
                Box::pin(pending())
            } else {
                Box::pin(ready(Ok(())))
            }
        }

        fn close_terminals(&self, _thread_id: String) -> WorktreeRuntimeFuture<Result<(), String>> {
            self.terminal_calls.fetch_add(1, Ordering::SeqCst);
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

        assert_eq!(actions.provider_calls.load(Ordering::SeqCst), 3);
        assert_eq!(actions.terminal_calls.load(Ordering::SeqCst), 3);
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
}
