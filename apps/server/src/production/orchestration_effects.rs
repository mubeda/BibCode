use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    sync::{Semaphore, broadcast, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

use crate::{
    git::{
        CreateWorktreeInput, GitRepository, OutputPolicy, ProcessError, ProcessRequest,
        ProcessRunner,
    },
    orchestration::engine::{
        ActivityInput, BootstrapSetupInput, BootstrapSetupResult, BootstrapWorktree,
        BoxBootstrapFuture, BoxProjectCommandFuture, OrchestrationCommand, OrchestrationEngine,
        ProjectCommandEffects, ThreadTurnBootstrapEffects, ThreadTurnReservation,
        ThreadTurnStartBootstrapPrepareWorktree,
    },
    persistence::{OrchestrationEvent, PersistenceError},
};

pub use super::host_paths::process_compatible_path;
use super::host_paths::{
    HostPathError, normalize_host_path_lexically, resolve_host_directory,
    resolve_host_directory_identity,
};
use super::repository_identity::{backfill_repository_identities, reconcile_repository_identity};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

pub type BoxEffectFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetupScriptLaunch {
    pub thread_id: String,
    pub terminal_id: String,
    pub script_id: String,
    pub script_name: String,
    pub command: String,
    pub cwd: PathBuf,
    pub worktree_path: PathBuf,
    pub env: BTreeMap<String, String>,
}

/// What the provider did when a checkpoint revert asked it to drop the newest turns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderRewind {
    /// The provider dropped the turns from its conversation.
    Rewound,
    /// The provider cannot rewind its conversation, so the revert restores only the files.
    FilesOnly { provider_label: String },
}

pub trait OrchestrationEffectCallbacks: Send + Sync {
    fn workspace_for_thread<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<PathBuf>>;

    /// `rewind_key` identifies the revert by the transcript it starts from, so a retried rewind
    /// is applied once.
    fn rollback_provider<'a>(
        &'a self,
        thread_id: &'a str,
        turns: i64,
        rewind_key: &'a str,
    ) -> BoxEffectFuture<'a, ProviderRewind>;

    /// Gets the provider ready for `rollback_provider`, such as reopening a session suspended
    /// while idle. It runs off the effects worker, so a slow start holds up only its own thread.
    fn prepare_provider_rewind<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn stop_provider<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()>;

    /// Drives a requested conversation compaction to its settlement (see
    /// `provider_runtime::drive_thread_compaction`). Runs with the thread's turns reserved;
    /// `cancellation` abandons it at shutdown, and the next startup settles its row.
    fn compact_provider<'a>(
        &'a self,
        _compaction_id: &'a str,
        _cancellation: &'a CancellationToken,
    ) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Err("provider compaction is unavailable".to_owned()) })
    }

    fn close_terminals<'a>(&'a self, thread_id: &'a str) -> BoxEffectFuture<'a, ()>;

    fn refresh_workspace<'a>(&'a self, cwd: &'a Path) -> BoxEffectFuture<'a, ()>;

    /// Closes the thread's preview tabs and gateway targets.
    fn close_previews<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    /// Starts stopping the device previews the thread started, without waiting for them, and
    /// refuses the thread as a device owner from now on.
    fn close_devices<'a>(&'a self, _thread_id: &'a str) -> BoxEffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn setup_script_is_running<'a>(
        &'a self,
        _thread_id: &'a str,
        _terminal_id: &'a str,
    ) -> BoxEffectFuture<'a, bool> {
        Box::pin(async { Ok(false) })
    }

    fn launch_setup_script<'a>(&'a self, _input: SetupScriptLaunch) -> BoxEffectFuture<'a, ()> {
        Box::pin(async {
            Err(
                "the production terminal callback is unavailable for setup script launch"
                    .to_owned(),
            )
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct EffectsOptions {
    pub queue_capacity: usize,
    /// How long an ended turn holds its thread's turn deliveries for its checkpoint. A capture
    /// still pending then is given up as stale, so a hung Git never holds a thread for good.
    pub checkpoint_hold_limit: Duration,
}

impl Default for EffectsOptions {
    fn default() -> Self {
        Self {
            queue_capacity: 64,
            checkpoint_hold_limit: CHECKPOINT_HOLD_LIMIT,
        }
    }
}

/// Longer than a capture's Git calls take in a large checkout, short enough that a worker that
/// never answers does not hold a thread's turns for long.
const CHECKPOINT_HOLD_LIMIT: Duration = Duration::from_secs(120);

#[derive(Debug, Error)]
pub enum OrchestrationEffectsError {
    #[error("workspace root does not exist: {0}")]
    WorkspaceMissing(PathBuf),
    #[error("workspace root is not a directory: {0}")]
    WorkspaceNotDirectory(PathBuf),
    #[error("failed to access workspace root {path}: {source}")]
    WorkspaceIo {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("native git operation failed: {0}")]
    Git(#[from] ProcessError),
    #[error("orchestration persistence failed: {0}")]
    Persistence(#[from] PersistenceError),
    #[error("orchestration effect failed: {0}")]
    Effect(String),
}

pub async fn normalize_project_workspace_root(
    workspace_root: &Path,
    create_if_missing: bool,
) -> Result<PathBuf, OrchestrationEffectsError> {
    resolve_host_directory(workspace_root, create_if_missing)
        .await
        .map_err(map_host_path_error)
}

async fn canonicalize_project_workspace_root(
    workspace_root: &Path,
    allow_missing: bool,
) -> Result<PathBuf, OrchestrationEffectsError> {
    resolve_host_directory_identity(workspace_root, allow_missing)
        .await
        .map_err(map_host_path_error)
}

fn map_host_path_error(error: HostPathError) -> OrchestrationEffectsError {
    match error {
        HostPathError::Missing(path) => OrchestrationEffectsError::WorkspaceMissing(path),
        HostPathError::NotDirectory(path) => OrchestrationEffectsError::WorkspaceNotDirectory(path),
        HostPathError::HomeDirectoryUnavailable(path) => OrchestrationEffectsError::WorkspaceIo {
            path,
            source: std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "home directory is unavailable",
            ),
        },
        HostPathError::Io { path, source } => {
            OrchestrationEffectsError::WorkspaceIo { path, source }
        }
    }
}

#[derive(Default)]
struct ProductionProjectCommandEffects;

impl ProjectCommandEffects for ProductionProjectCommandEffects {
    fn normalize_workspace_root_lexically(&self, workspace_root: &str) -> String {
        normalize_host_path_lexically(Path::new(workspace_root))
            .to_string_lossy()
            .into_owned()
    }

    fn canonicalize_workspace_root<'a>(
        &'a self,
        workspace_root: &'a str,
        allow_missing: bool,
    ) -> BoxProjectCommandFuture<'a, String> {
        Box::pin(async move {
            canonicalize_project_workspace_root(Path::new(workspace_root), allow_missing)
                .await
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| error.to_string())
        })
    }

    fn prepare_project_create<'a>(
        &'a self,
        workspace_root: &'a str,
        create_if_missing: bool,
        initialize_git: bool,
    ) -> BoxProjectCommandFuture<'a, ()> {
        Box::pin(async move {
            let normalized =
                normalize_project_workspace_root(Path::new(workspace_root), create_if_missing)
                    .await
                    .map_err(|error| error.to_string())?;
            let normalized_display = normalized.to_string_lossy();
            if normalized_display != workspace_root {
                return Err(format!(
                    "workspace root changed while preparing project creation: expected {workspace_root}, resolved {normalized_display}"
                ));
            }
            if initialize_git {
                GitRepository::default()
                    .init(&normalized, &CancellationToken::new())
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }
}

pub fn install_project_command_effects(engine: &OrchestrationEngine) {
    engine.set_project_command_effects(Arc::new(ProductionProjectCommandEffects));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSetupScript {
    id: String,
    name: String,
    command: String,
    run_on_worktree_create: bool,
}

struct ProductionBootstrapEffects {
    repositories: crate::persistence::Repositories,
    repository: Arc<GitRepository>,
    callbacks: Arc<dyn OrchestrationEffectCallbacks>,
}

impl ThreadTurnBootstrapEffects for ProductionBootstrapEffects {
    fn prepare_worktree<'a>(
        &'a self,
        input: ThreadTurnStartBootstrapPrepareWorktree,
        cancellation: &'a CancellationToken,
    ) -> BoxBootstrapFuture<'a, BootstrapWorktree> {
        Box::pin(async move {
            let cwd = PathBuf::from(&input.project_cwd);
            let remove_branch = input.branch.is_some();
            let ref_name = if input.start_from_origin == Some(true) {
                fetch_origin_base(&cwd, &input.base_branch, cancellation).await?
            } else {
                input.base_branch.clone()
            };
            let result = self
                .repository
                .ensure_worktree(
                    CreateWorktreeInput {
                        cwd,
                        ref_name,
                        new_ref_name: input.branch,
                        base_ref_name: None,
                        path: None,
                    },
                    cancellation,
                )
                .await
                .map_err(|error| error.to_string())?;
            let path = PathBuf::from(&result.worktree.path);
            let worktree = BootstrapWorktree {
                repository_root: input.project_cwd,
                branch: result.worktree.ref_name,
                path: result.worktree.path,
                remove_branch,
            };
            if let Err(error) = self.callbacks.refresh_workspace(&path).await {
                return Err(format!("worktree workspace refresh failed: {error}"));
            }
            Ok(worktree)
        })
    }

    fn run_setup_script<'a>(
        &'a self,
        input: BootstrapSetupInput,
    ) -> BoxBootstrapFuture<'a, BootstrapSetupResult> {
        Box::pin(async move {
            let project = if let Some(project_id) = input.project_id {
                self.repositories
                    .get_project(project_id)
                    .await
                    .map_err(|error| error.to_string())?
            } else if let Some(project_cwd) = input.project_cwd {
                self.repositories
                    .list_projects()
                    .await
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .find(|project| project.workspace_root == project_cwd)
            } else {
                None
            }
            .ok_or_else(|| "project was not found for setup script execution".to_owned())?;
            let scripts: Vec<ProjectSetupScript> = serde_json::from_value(project.scripts)
                .map_err(|error| format!("project setup scripts are invalid: {error}"))?;
            let Some(script) = scripts
                .into_iter()
                .find(|script| script.run_on_worktree_create)
            else {
                return Ok(BootstrapSetupResult::NoScript);
            };
            let terminal_id = format!("setup-{}", script.id);
            if self
                .callbacks
                .setup_script_is_running(&input.thread_id, &terminal_id)
                .await?
            {
                return Ok(BootstrapSetupResult::Started {
                    script_id: script.id,
                    script_name: script.name,
                    terminal_id,
                });
            }
            let worktree_path = PathBuf::from(&input.worktree_path);
            let env = BTreeMap::from([
                ("BIBCODE_PROJECT_ROOT".to_owned(), project.workspace_root),
                (
                    "BIBCODE_WORKTREE_PATH".to_owned(),
                    input.worktree_path.clone(),
                ),
            ]);
            self.callbacks
                .launch_setup_script(SetupScriptLaunch {
                    thread_id: input.thread_id,
                    terminal_id: terminal_id.clone(),
                    script_id: script.id.clone(),
                    script_name: script.name.clone(),
                    command: script.command,
                    cwd: worktree_path.clone(),
                    worktree_path,
                    env,
                })
                .await?;
            Ok(BootstrapSetupResult::Started {
                script_id: script.id,
                script_name: script.name,
                terminal_id,
            })
        })
    }
}

async fn fetch_origin_base(
    cwd: &Path,
    base_branch: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    run_bootstrap_git(cwd, ["fetch", "origin"], cancellation).await?;
    let branch = base_branch.strip_prefix("origin/").unwrap_or(base_branch);
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let output =
        run_bootstrap_git(cwd, ["rev-parse", "--verify", &remote_ref], cancellation).await?;
    let commit = output.trim();
    if commit.is_empty() {
        return Err(format!(
            "origin branch '{base_branch}' resolved to an empty commit"
        ));
    }
    Ok(commit.to_owned())
}

async fn run_bootstrap_git<const N: usize>(
    cwd: &Path,
    args: [&str; N],
    cancellation: &CancellationToken,
) -> Result<String, String> {
    ProcessRunner
        .run(
            ProcessRequest {
                operation: format!("bootstrap.git.{}", args[0]),
                command: PathBuf::from("git"),
                args: args.into_iter().map(OsString::from).collect(),
                cwd: cwd.to_path_buf(),
                env: Vec::new(),
                stdin: None,
                timeout: GIT_TIMEOUT,
                max_output_bytes: GIT_OUTPUT_LIMIT,
                output_policy: OutputPolicy::Error,
                append_truncation_marker: false,
                allow_non_zero_exit: false,
            },
            cancellation,
        )
        .await
        .map(|output| output.stdout)
        .map_err(bootstrap_process_error)
}

fn bootstrap_process_error(error: ProcessError) -> String {
    let detail = match &error {
        ProcessError::NonZeroExit { stderr, stdout, .. } => [stderr.as_ref(), stdout.as_ref()]
            .into_iter()
            .map(str::trim)
            .find(|value| !value.is_empty()),
        _ => None,
    };
    let summary = detail.map_or_else(|| error.to_string(), |detail| format!("{error}: {detail}"));
    crate::diagnostics::redact_sensitive_text(&summary)
}

pub struct OrchestrationEffects {
    engine: OrchestrationEngine,
    cancellation: CancellationToken,
    /// Identity reconciles run off the sequential worker so a slow `git` read never delays turn
    /// baselines; shutdown cancels and drains them.
    identity_tasks: TaskTracker,
    /// Conversation compactions, which can run for minutes, also run off the worker; shutdown
    /// abandons them and the next startup settles their rows.
    compaction_tasks: TaskTracker,
    producer: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    worker: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

impl OrchestrationEffects {
    pub async fn start(
        engine: OrchestrationEngine,
        repository: Arc<GitRepository>,
        callbacks: Arc<dyn OrchestrationEffectCallbacks>,
        options: EffectsOptions,
    ) -> Result<Self, OrchestrationEffectsError> {
        // Read the log head before subscribing: every later commit then reaches the subscription
        // or lies after this floor, where the producer reads it from the log, while history at or
        // below the floor is never replayed.
        let floor = engine.repositories().max_event_sequence().await?;
        let subscription = engine.subscribe_events();
        let cancellation = CancellationToken::new();
        let (sender, receiver) = mpsc::channel(options.queue_capacity.max(1));

        install_project_command_effects(&engine);
        // The worker below records turn checkpoints, so a turn's end may hold its thread's turns.
        engine.set_checkpoint_hold_limit(Some(options.checkpoint_hold_limit));
        engine.set_bootstrap_effects(Arc::new(ProductionBootstrapEffects {
            repositories: engine.repositories(),
            repository: repository.clone(),
            callbacks: callbacks.clone(),
        }));

        let identity_tasks = TaskTracker::new();
        identity_tasks.spawn(backfill_repository_identities(
            engine.clone(),
            repository.clone(),
            cancellation.child_token(),
        ));
        let compaction_tasks = TaskTracker::new();
        let worker = tokio::spawn(run_worker(
            engine.clone(),
            repository,
            identity_tasks.clone(),
            compaction_tasks.clone(),
            callbacks,
            receiver,
            cancellation.clone(),
        ));
        let producer = tokio::spawn(run_producer(
            engine.clone(),
            sender,
            cancellation.clone(),
            subscription,
            floor,
        ));

        Ok(Self {
            engine,
            cancellation,
            identity_tasks,
            compaction_tasks,
            producer: tokio::sync::Mutex::new(Some(producer)),
            worker: tokio::sync::Mutex::new(Some(worker)),
        })
    }

    pub async fn shutdown(&self) {
        self.cancellation.cancel();
        if let Some(producer) = self.producer.lock().await.take() {
            let _ = producer.await;
        }
        if let Some(worker) = self.worker.lock().await.take() {
            let _ = worker.await;
        }
        // Nothing records checkpoints any more: no turn waits for one.
        self.engine.set_checkpoint_hold_limit(None);
        self.identity_tasks.close();
        self.identity_tasks.wait().await;
        self.compaction_tasks.close();
        self.compaction_tasks.wait().await;
    }
}

async fn run_producer(
    engine: OrchestrationEngine,
    sender: mpsc::Sender<OrchestrationEvent>,
    cancellation: CancellationToken,
    subscription: broadcast::Receiver<OrchestrationEvent>,
    floor: i64,
) {
    // The highest log position already handled. Anything at or below it is history or was
    // already forwarded from the log, so it is skipped rather than re-running its side effect.
    let mut handled_through = floor;
    // Commits between reading the floor and subscribing never reach the subscription.
    if !forward_logged_events(&engine, &sender, &mut handled_through, LogRead::Startup).await {
        return;
    }
    forward_subscription(
        &engine,
        &sender,
        &cancellation,
        subscription,
        handled_through,
    )
    .await;
}

/// Forwards what the subscription delivers after `handled_through`, and reads the log to fill the
/// gap whenever the subscription lags.
async fn forward_subscription(
    engine: &OrchestrationEngine,
    sender: &mpsc::Sender<OrchestrationEvent>,
    cancellation: &CancellationToken,
    mut subscription: broadcast::Receiver<OrchestrationEvent>,
    mut handled_through: i64,
) {
    loop {
        tokio::select! {
            () = cancellation.cancelled() => return,
            received = subscription.recv() => match received {
                Ok(event) => {
                    if event.sequence <= handled_through {
                        continue;
                    }
                    handled_through = event.sequence;
                    if is_reactor_event(&event)
                        && sender.send(event).await.is_err()
                    {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if !forward_logged_events(engine, sender, &mut handled_through, LogRead::LagRecovery)
                        .await
                    {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

/// Why the producer reads the event log instead of the subscription.
#[derive(Clone, Copy, Debug)]
enum LogRead {
    /// Once at startup, for commits made before the subscription existed.
    Startup,
    /// After the subscription lagged and dropped events.
    LagRecovery,
}

/// Forwards the reactor events logged after `handled_through`, one bounded page at a time.
/// Returns `false` once the worker has stopped.
async fn forward_logged_events(
    engine: &OrchestrationEngine,
    sender: &mpsc::Sender<OrchestrationEvent>,
    handled_through: &mut i64,
    read: LogRead,
) -> bool {
    let repositories = engine.repositories();
    let mut pages = repositories.event_pages(*handled_through);
    loop {
        let page = match pages.next_page().await {
            Ok(Some(page)) => page,
            Ok(None) => return true,
            Err(error) => {
                match read {
                    LogRead::Startup => tracing::warn!(
                        %error,
                        "failed to read orchestration effect events committed before the effects subscription"
                    ),
                    LogRead::LagRecovery => tracing::warn!(
                        %error,
                        "failed to recover orchestration effect events after receiver lag"
                    ),
                }
                return true;
            }
        };
        for event in page {
            *handled_through = event.sequence;
            if is_reactor_event(&event) && sender.send(event).await.is_err() {
                return false;
            }
        }
    }
}

fn is_reactor_event(event: &OrchestrationEvent) -> bool {
    matches!(
        event.event.event_type.as_str(),
        "thread.turn-start-requested"
            | "thread.message-sent"
            | "thread.turn-diff-completed"
            | "thread.checkpoint-revert-requested"
            | "thread.compact-requested"
            | "thread.deleted"
            | "project.created"
            | "project.meta-updated"
    )
}

/// What the worker needs to run an event's side effect.
struct EffectContext {
    engine: OrchestrationEngine,
    repository: Arc<GitRepository>,
    identity_tasks: TaskTracker,
    compaction_tasks: TaskTracker,
    callbacks: Arc<dyn OrchestrationEffectCallbacks>,
    cancellation: CancellationToken,
}

impl EffectContext {
    /// Runs a requested compaction off the worker, with the thread's turns reserved so delivery
    /// and revert wait for it, then releases the thread and wakes delivery.
    fn compact(&self, event: &OrchestrationEvent) {
        let (Some(thread_id), Some(compaction_id)) = (
            event_thread_id(event).map(str::to_owned),
            event
                .event
                .payload
                .get("compactionId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        ) else {
            return;
        };
        let (engine, callbacks, cancellation) = (
            self.engine.clone(),
            self.callbacks.clone(),
            self.cancellation.clone(),
        );
        self.compaction_tasks.spawn(async move {
            let reservation = tokio::select! {
                reservation = engine.reserve_thread_turns(&thread_id) => reservation,
                () = cancellation.cancelled() => return,
            };
            let result = callbacks
                .compact_provider(&compaction_id, &cancellation)
                .await;
            drop(reservation);
            engine.wake_turn_delivery();
            if let Err(detail) = result {
                tracing::warn!(%thread_id, %detail, "conversation compaction could not run");
                settle_unrun_compaction(&engine, &thread_id, &compaction_id, &detail).await;
            }
        });
    }

    async fn handle(&self, event: &OrchestrationEvent) {
        let result = process_event(
            &self.engine,
            &self.repository,
            &self.identity_tasks,
            self.callbacks.as_ref(),
            event,
            &self.cancellation,
        )
        .await;
        self.report(event, result).await;
    }

    /// Rewinds and restores a planned revert, then releases its thread and wakes delivery.
    async fn revert(&self, event: &OrchestrationEvent, (reservation, plan): PreparedRevert) {
        let result = match plan {
            Ok(plan) => {
                finish_revert(
                    &self.engine,
                    self.callbacks.as_ref(),
                    plan,
                    &self.cancellation,
                )
                .await
            }
            Err(error) => Err(error),
        };
        drop(reservation);
        self.engine.wake_turn_delivery();
        self.report(event, result).await;
    }

    async fn report(
        &self,
        event: &OrchestrationEvent,
        result: Result<(), OrchestrationEffectsError>,
    ) {
        if let Err(error) = result {
            tracing::warn!(event_type = %event.event.event_type, sequence = event.sequence, %error, "orchestration side effect failed");
            append_failure_activity(&self.engine, event, &error.to_string()).await;
        }
    }
}

/// A compaction the callbacks could not run settles `failed`, so its thread is not held.
async fn settle_unrun_compaction(
    engine: &OrchestrationEngine,
    thread_id: &str,
    compaction_id: &str,
    detail: &str,
) {
    let Some(row) = engine
        .thread_compaction(compaction_id)
        .await
        .ok()
        .flatten()
        .filter(crate::orchestration::engine::ThreadCompactionRow::is_unsettled)
    else {
        return;
    };
    let started = std::time::Instant::now();
    let settled = engine
        .dispatch(OrchestrationCommand::ThreadCompactionSettle {
            command_id: format!("server:compaction-settle:{compaction_id}"),
            thread_id: thread_id.to_owned(),
            compaction_id: compaction_id.to_owned(),
            outcome: "failed".to_owned(),
            detail: Some(crate::diagnostics::redact_sensitive_text(detail)),
            restarted: false,
            created_at: now_iso(),
        })
        .await;
    match settled {
        Ok(_) => {
            super::provider_runtime::record_settled_compaction(
                engine,
                &row,
                Some("not_started"),
                started,
            )
            .await;
        }
        Err(error) => {
            tracing::warn!(thread_id, %error, "an unrun conversation compaction could not be settled");
        }
    }
    engine.wake_turn_delivery();
}

fn event_thread_id(event: &OrchestrationEvent) -> Option<&str> {
    event.event.payload.get("threadId").and_then(Value::as_str)
}

/// A revert whose thread is reserved for it, with its checks done and its provider ready.
type PreparedRevert = (
    ThreadTurnReservation,
    Result<RevertPlan, OrchestrationEffectsError>,
);

/// How many events a parked thread holds before the worker waits for its revert itself. Each
/// thread parks for one revert at a time, so this bounds what a reverting thread holds.
const PARKED_THREAD_EVENT_LIMIT: usize = 64;

/// How many reverts are prepared off the worker at once, each possibly starting a provider. A
/// revert past that waits its turn already holding its thread, so no turn starts ahead of it.
const REVERT_PREPARATION_LIMIT: usize = 4;

/// A revert's thread and its place among the reverts of its checkout, fixed when the worker
/// receives it, which is the order the reverts were requested in.
struct OrderedRevert {
    thread_id: String,
    /// Closes once the checkout's revert requested just before this one has restored.
    previous: Option<oneshot::Receiver<()>>,
    /// Dropped once this revert has restored, which lets the checkout's next revert restore.
    done: oneshot::Sender<()>,
}

/// What a revert's waiter hands back to the worker: the event, its preparation (none at
/// shutdown), and the `done` of its [`OrderedRevert`].
type ReadyRevert = (
    OrchestrationEvent,
    Option<PreparedRevert>,
    oneshot::Sender<()>,
);

/// An event waiting behind its thread's revert. A revert keeps the place it was given on arrival.
type ParkedEvent = (OrchestrationEvent, Option<OrderedRevert>);

/// Threads whose checkpoint revert is being prepared off the worker, which serves every thread:
/// waiting for the thread's delivery in flight, the revert's checks, and reopening a provider
/// suspended while idle. The thread's later events wait behind the revert in order. The rewind,
/// the restore and every other side effect still run on the worker one at a time, so checkpoint
/// work on a checkout that sibling threads share never overlaps. Reverts of one checkout also
/// restore in the order they were requested: each is handed back only once the one requested
/// before it has restored, so a slow preparation is not overtaken by a later, faster one.
struct ParkedThreads {
    queues: HashMap<String, VecDeque<ParkedEvent>>,
    /// Per checkout, the `done` of its latest revert, which the next one waits for.
    tails: HashMap<PathBuf, oneshot::Receiver<()>>,
    /// [`REVERT_PREPARATION_LIMIT`] permits, one per revert being prepared.
    preparations: Arc<Semaphore>,
    ready: mpsc::UnboundedSender<ReadyRevert>,
    waiters: TaskTracker,
}

impl ParkedThreads {
    /// Takes the worker's next event, in the order it was committed: queues it behind its
    /// thread's revert, parks its thread for a revert, or runs it now. Returns the length of the
    /// queue it joined, if it joined one.
    async fn receive(
        &mut self,
        context: &EffectContext,
        event: OrchestrationEvent,
    ) -> Option<usize> {
        // A revert's place is fixed here, even behind its own thread's earlier revert: its
        // predecessor is then always a revert the worker has already received.
        let order = self.order(context, &event).await;
        if let Some(queue) = self.queue_of(&event) {
            queue.push_back((event, order));
            return Some(queue.len());
        }
        self.run(context, event, order).await;
        None
    }

    /// Places a revert after the earlier reverts of its checkout. A revert whose checkout cannot
    /// be resolved here waits for nobody; its preparation resolves the checkout again.
    async fn order(
        &mut self,
        context: &EffectContext,
        event: &OrchestrationEvent,
    ) -> Option<OrderedRevert> {
        if event.event.event_type != "thread.checkpoint-revert-requested" {
            return None;
        }
        let thread_id = event_thread_id(event)?.to_owned();
        let checkout = resolve_workspace(&context.engine, context.callbacks.as_ref(), &thread_id)
            .await
            .ok()
            .flatten()
            .map(|cwd| normalize_host_path_lexically(&cwd));
        // Forget checkouts whose latest revert has restored.
        self.tails.retain(|_, tail| {
            !matches!(tail.try_recv(), Err(oneshot::error::TryRecvError::Closed))
        });
        let (done, tail) = oneshot::channel();
        let previous = checkout.and_then(|checkout| self.tails.insert(checkout, tail));
        Some(OrderedRevert {
            thread_id,
            previous,
            done,
        })
    }

    /// Runs the event now, or parks its thread while its revert is prepared.
    async fn run(
        &mut self,
        context: &EffectContext,
        event: OrchestrationEvent,
        order: Option<OrderedRevert>,
    ) {
        let Some(OrderedRevert {
            thread_id,
            previous,
            done,
        }) = order
        else {
            if event.event.event_type == "thread.compact-requested" {
                return context.compact(&event);
            }
            return context.handle(&event).await;
        };
        self.queues.insert(thread_id.clone(), VecDeque::new());
        let (engine, callbacks, cancellation, preparations, ready) = (
            context.engine.clone(),
            context.callbacks.clone(),
            context.cancellation.clone(),
            self.preparations.clone(),
            self.ready.clone(),
        );
        self.waiters.spawn(async move {
            let prepared = tokio::select! {
                prepared = async {
                    // Taken before waiting for a preparation slot, so a turn sent after the
                    // revert does not start ahead of it.
                    let reservation = engine.reserve_thread_turns(&thread_id).await;
                    let plan = {
                        // The semaphore is never closed.
                        let _permit = preparations.acquire().await.ok();
                        plan_revert(&engine, callbacks.as_ref(), &event, &cancellation).await
                    };
                    if let Some(previous) = previous {
                        let _ = previous.await;
                    }
                    (reservation, plan)
                } => Some(prepared),
                () = cancellation.cancelled() => None,
            };
            let _ = ready.send((event, prepared, done));
        });
    }

    /// The parked queue of the event's thread, if that thread is parked.
    fn queue_of(&mut self, event: &OrchestrationEvent) -> Option<&mut VecDeque<ParkedEvent>> {
        event_thread_id(event).and_then(|thread_id| self.queues.get_mut(thread_id))
    }

    /// Runs a prepared revert's rewind and restore, then the events that waited behind it. At
    /// shutdown the waiter brings nothing, and the parked events are left like any other
    /// unhandled event.
    async fn resume(&mut self, context: &EffectContext, (event, prepared, done): ReadyRevert) {
        let Some(thread_id) = event_thread_id(&event).map(str::to_owned) else {
            return;
        };
        let queued = self.queues.remove(&thread_id).unwrap_or_default();
        let Some(prepared) = prepared else {
            return;
        };
        context.revert(&event, prepared).await;
        // The checkout's next revert may restore now.
        drop(done);
        for (event, order) in queued {
            // A later revert of the thread parks it again, in the place it was given on arrival.
            match self.queue_of(&event) {
                Some(queue) => queue.push_back((event, order)),
                None => self.run(context, event, order).await,
            }
        }
    }
}

async fn run_worker(
    engine: OrchestrationEngine,
    repository: Arc<GitRepository>,
    identity_tasks: TaskTracker,
    compaction_tasks: TaskTracker,
    callbacks: Arc<dyn OrchestrationEffectCallbacks>,
    mut receiver: mpsc::Receiver<OrchestrationEvent>,
    cancellation: CancellationToken,
) {
    let context = EffectContext {
        engine,
        repository,
        identity_tasks,
        compaction_tasks,
        callbacks,
        cancellation,
    };
    let (ready, mut waited) = mpsc::unbounded_channel();
    let mut parked = ParkedThreads {
        queues: HashMap::new(),
        tails: HashMap::new(),
        preparations: Arc::new(Semaphore::new(REVERT_PREPARATION_LIMIT)),
        ready,
        waiters: TaskTracker::new(),
    };
    loop {
        tokio::select! {
            () = context.cancellation.cancelled() => break,
            Some(resumed) = waited.recv() => parked.resume(&context, resumed).await,
            event = receiver.recv() => {
                let Some(event) = event else { break };
                let thread_id = event_thread_id(&event).map(str::to_owned);
                let queued = parked.receive(&context, event).await;
                if queued.is_some_and(|length| length >= PARKED_THREAD_EVENT_LIMIT) {
                    // Keep the backlog bounded: wait for this thread, as before parking.
                    while thread_id.as_ref().is_some_and(|id| parked.queues.contains_key(id)) {
                        let Some(resumed) = waited.recv().await else { break };
                        parked.resume(&context, resumed).await;
                    }
                }
            }
        }
    }
    // Nothing restores a parked revert any more. Dropping the reverts handed back or queued
    // releases the waiters ordered behind them, which the producer closing its channel without a
    // cancellation would otherwise leave waiting.
    drop(waited);
    parked.queues.clear();
    parked.waiters.close();
    parked.waiters.wait().await;
}

async fn process_event(
    engine: &OrchestrationEngine,
    repository: &Arc<GitRepository>,
    identity_tasks: &TaskTracker,
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    match event.event.event_type.as_str() {
        "thread.turn-start-requested" => {
            ensure_baseline(engine, callbacks, event, Baseline::TurnStart, cancellation).await
        }
        "thread.message-sent" if needs_turn_baseline(event) => {
            ensure_baseline(engine, callbacks, event, Baseline::Message, cancellation).await
        }
        "thread.turn-diff-completed"
            if event.event.payload.get("status").and_then(Value::as_str) == Some("missing") =>
        {
            // However it ends, this turn no longer holds the thread's queued messages.
            let payload = &event.event.payload;
            let _release = event_thread_id(event)
                .zip(payload.get("turnId").and_then(Value::as_str))
                .map(|(thread_id, turn_id)| CheckpointHoldRelease {
                    engine,
                    thread_id,
                    turn_id,
                });
            capture_missing_checkpoint(engine, callbacks, event, cancellation).await
        }
        // Reached only without a thread id: the worker runs a revert with its thread reserved.
        "thread.checkpoint-revert-requested" => {
            required_str(&event.event.payload, "threadId")?;
            Err(OrchestrationEffectsError::Effect(
                "a checkpoint revert runs only with its thread reserved".to_owned(),
            ))
        }
        "thread.deleted" => {
            if let Some(thread_id) = event_thread_id(event) {
                engine.release_thread_checkpoint_holds(thread_id);
            }
            cleanup_deleted_thread(callbacks, event).await;
            Ok(())
        }
        "project.created" => {
            reconcile_event_project(engine, repository, identity_tasks, event, cancellation);
            Ok(())
        }
        // Only a moved workspace changes the checkout; the identity update itself carries no
        // workspaceRoot, so this cannot loop.
        "project.meta-updated" if event.event.payload.get("workspaceRoot").is_some() => {
            reconcile_event_project(engine, repository, identity_tasks, event, cancellation);
            Ok(())
        }
        _ => Ok(()),
    }
}

fn reconcile_event_project(
    engine: &OrchestrationEngine,
    repository: &Arc<GitRepository>,
    identity_tasks: &TaskTracker,
    event: &OrchestrationEvent,
    cancellation: &CancellationToken,
) {
    let Some(project_id) = event.event.payload.get("projectId").and_then(Value::as_str) else {
        return;
    };
    let (engine, repository, project_id, cancellation) = (
        engine.clone(),
        repository.clone(),
        project_id.to_owned(),
        cancellation.child_token(),
    );
    identity_tasks.spawn(async move {
        reconcile_repository_identity(&engine, &repository, &project_id, &cancellation).await;
    });
}

async fn resolve_workspace(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    thread_id: &str,
) -> Result<Option<PathBuf>, OrchestrationEffectsError> {
    if let Some(cwd) = callbacks
        .workspace_for_thread(thread_id)
        .await
        .map_err(OrchestrationEffectsError::Effect)?
    {
        return Ok(Some(cwd));
    }
    let repositories = engine.repositories();
    let Some(thread) = repositories.get_thread(thread_id.to_owned()).await? else {
        return Ok(None);
    };
    if let Some(worktree_path) = thread.worktree_path {
        return Ok(Some(process_compatible_path(worktree_path.into())));
    }
    Ok(repositories
        .get_project(thread.project_id)
        .await?
        .map(|project| process_compatible_path(PathBuf::from(project.workspace_root))))
}

/// A user message that starts a turn needs the turn's checkpoint baseline. Imported CLI history
/// starts no turn, so it must not capture one (or spawn Git once per historical prompt).
fn needs_turn_baseline(event: &OrchestrationEvent) -> bool {
    let payload = &event.event.payload;
    payload.get("role").and_then(Value::as_str) == Some("user")
        && payload.get("streaming").and_then(Value::as_bool) == Some(false)
        && payload.get("turnId").is_none_or(Value::is_null)
        && event
            .event
            .metadata
            .get("historyImport")
            .and_then(Value::as_bool)
            != Some(true)
}

/// What asked for a turn's baseline.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Baseline {
    /// The turn starts now.
    TurnStart,
    /// A user message was sent. A queued one is sent while another turn may still run.
    Message,
}

async fn ensure_baseline(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
    baseline: Baseline,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let Some(thread_id) = event.event.payload.get("threadId").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(cwd) = resolve_workspace(engine, callbacks, thread_id).await? else {
        return Ok(());
    };
    if !is_git_repository(&cwd, Path::new("git"), cancellation).await? {
        return Ok(());
    }
    // One read of the thread's turns, so the number and the history it is judged by agree even
    // when a turn's end is recorded meanwhile.
    let turns = engine
        .repositories()
        .list_turns_by_thread(thread_id.to_owned())
        .await?;
    let starting_message = event.event.payload.get("messageId").and_then(Value::as_str);
    // The baseline is the checkpoint of the turns before the starting one. That turn may already
    // have ended and been numbered (it was fast, or the worker is behind); its number is not this
    // baseline's.
    let turn_count = turns
        .iter()
        .filter(|turn| {
            starting_message.is_none() || turn.pending_message_id.as_deref() != starting_message
        })
        .filter_map(|turn| turn.checkpoint_turn_count)
        .max()
        .unwrap_or(0);
    let stale_first_baseline =
        baseline == Baseline::TurnStart && had_turns_before_checkpoints(&turns, starting_message);
    // A latest turn whose capture went stale has no end state: the checkout now may hold the next
    // turn's edits, so it does not stand in for that turn's checkpoint.
    // Recorded `error` durably; in memory first, while that record is being written.
    let latest_went_stale = turns
        .iter()
        .filter(|turn| turn.checkpoint_turn_count == Some(turn_count))
        .any(|turn| {
            turn.checkpoint_status.as_deref() == Some("error")
                || turn
                    .turn_id
                    .as_deref()
                    .is_some_and(|turn_id| engine.checkpoint_is_stale(thread_id, turn_id))
        });
    if latest_went_stale {
        return Ok(());
    }
    let reference = checkpoint_ref(thread_id, turn_count);
    if stale_first_baseline || !has_ref(&cwd, Path::new("git"), &reference, cancellation).await? {
        capture_checkpoint_with_cancellation(
            &cwd,
            Path::new("git"),
            thread_id,
            turn_count,
            cancellation,
        )
        .await?;
    }
    Ok(())
}

/// Whether a thread with no recorded checkpoint already ran turns before the one
/// `starting_message` starts, and no other turn runs now. Its ref 0 was captured before the
/// first of those turns (they predate turn checkpoints), so the checkout as it is now is the
/// baseline of the turn that starts. If that turn is already running, or already ended (the
/// worker is behind), the checkout is captured as a first turn's baseline would be: the same
/// window, never an old ref 0. Once an earlier turn has a number, the thread has checkpoints and
/// its ref 0 stands.
fn had_turns_before_checkpoints(
    turns: &[crate::persistence::ProjectionTurn],
    starting_message: Option<&str>,
) -> bool {
    let earlier = |turn: &&crate::persistence::ProjectionTurn| {
        turn.turn_id.is_some() && turn.pending_message_id.as_deref() != starting_message
    };
    turns
        .iter()
        .filter(earlier)
        .all(|turn| turn.checkpoint_turn_count.is_none())
        && !turns
            .iter()
            .filter(earlier)
            .any(|turn| turn.state == "running")
        && turns
            .iter()
            .filter(earlier)
            .any(|turn| turn.state != "running")
}

/// A turn's checkpoint, as the read model records it.
struct TurnCheckpoint<'a> {
    thread_id: &'a str,
    turn_id: &'a str,
    turn_count: i64,
    /// The turn's own answer, if it has one.
    assistant_message_id: Option<String>,
    completed_at: &'a str,
}

/// Releases a turn's checkpoint hold when dropped.
struct CheckpointHoldRelease<'a> {
    engine: &'a OrchestrationEngine,
    thread_id: &'a str,
    turn_id: &'a str,
}

impl Drop for CheckpointHoldRelease<'_> {
    fn drop(&mut self) {
        self.engine
            .release_checkpoint_hold(self.thread_id, self.turn_id);
    }
}

/// How a turn ended, for its checkpoint.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnEnd {
    /// The provider ended it: the checkout is as it left it.
    Live,
    /// A server restart cut it off: the checkout is no longer as it left it.
    CutOff,
}

/// Records that turn `turn_id` of `thread_id` ended, before its session settles: its checkpoint
/// number, `missing` until the effects worker captures the checkout (the `missing` event it
/// handles next). The number is the next after the thread's recorded turns, so the numbers stay
/// dense and the provider rewind a revert derives from them stays aligned with the turns, even
/// when the capture never happens. A turn that already has a number is left alone: a repeated
/// end never asks for a second capture, which could store a later checkout as this turn's. A
/// live end holds the thread's queued messages until the capture, so a follow-up cannot edit the
/// checkout first. Only a thread with a recorded checkpoint, or (live) one whose turn start the
/// worker found in a Git checkout, is numbered: a project outside Git gets none, as before. A
/// cut-off turn before any recorded one is not numbered: the next turn's baseline starts the
/// thread's checkpoints after it. A compaction's own turn is not a turn of the thread; callers
/// never pass one. An error leaves the turn unnumbered and is the caller's, so a turn's end is
/// never settled without its number.
pub(crate) async fn record_turn_end(
    engine: &OrchestrationEngine,
    thread_id: &str,
    turn_id: &str,
    completed_at: &str,
    end: TurnEnd,
    checkout: Option<&Path>,
) -> Result<(), OrchestrationEffectsError> {
    let repositories = engine.repositories();
    if repositories
        .get_turn_by_id(thread_id.to_owned(), turn_id.to_owned())
        .await?
        .is_some_and(|turn| turn.checkpoint_turn_count.is_some())
    {
        return Ok(());
    }
    let latest = repositories
        .list_checkpoints_by_thread(thread_id.to_owned())
        .await?
        .into_iter()
        .map(|checkpoint| checkpoint.checkpoint_turn_count)
        .max();
    // Only a thread with checkpoints, or (live) a turn that ran in a Git checkout, is numbered:
    // a turn outside Git has nothing to diff or revert to. Read from the checkout itself, so the
    // number never waits for the effects worker.
    let checkpointed =
        latest.is_some() || (end == TurnEnd::Live && in_git_checkout(checkout).await);
    if !checkpointed {
        return Ok(());
    }
    let turn_count = latest.unwrap_or(0) + 1;
    let hold = match end {
        TurnEnd::Live => engine.hold_turns_for_checkpoint(thread_id, turn_id),
        TurnEnd::CutOff => None,
    };
    let checkpoint = TurnCheckpoint {
        thread_id,
        turn_id,
        turn_count,
        assistant_message_id: None,
        completed_at,
    };
    let recorded = dispatch_turn_checkpoint(engine, &checkpoint, "missing", Vec::new()).await;
    match (&recorded, hold) {
        (Err(_), Some(_)) => engine.release_checkpoint_hold(thread_id, turn_id),
        (Ok(()), Some(id)) => expire_stale_hold(engine, &checkpoint, id),
        _ => {}
    }
    recorded
}

/// Whether `checkout` lies in a Git work tree: it or a directory above it has a `.git`.
async fn in_git_checkout(checkout: Option<&Path>) -> bool {
    let Some(checkout) = checkout.map(Path::to_path_buf) else {
        return false;
    };
    tokio::task::spawn_blocking(move || {
        checkout
            .ancestors()
            .any(|directory| directory.join(".git").exists())
    })
    .await
    .unwrap_or(false)
}

/// Gives up hold `id` of an ended turn once the hold limit passes with its capture still pending:
/// the turn's checkpoint is marked stale (never recorded `ready`, and the next turn's baseline
/// does not stand in for it), the stale record is logged and shown, and the thread's turns go.
/// A hung Git therefore never holds a thread for good.
fn expire_stale_hold(engine: &OrchestrationEngine, ended: &TurnCheckpoint<'_>, id: u64) {
    let Some(limit) = engine.checkpoint_hold_limit() else {
        return;
    };
    let (engine, thread_id, turn_id, turn_count, completed_at) = (
        engine.clone(),
        ended.thread_id.to_owned(),
        ended.turn_id.to_owned(),
        ended.turn_count,
        ended.completed_at.to_owned(),
    );
    let shutdown = engine.shutdown_signal();
    tokio::spawn(async move {
        tokio::select! {
            () = tokio::time::sleep(limit) => {}
            () = shutdown.cancelled() => return,
        }
        if !engine.expire_checkpoint_hold(&thread_id, &turn_id, id) {
            return;
        }
        tracing::warn!(
            %thread_id,
            turn_count,
            "a turn's checkpoint was not captured in time; it is recorded stale and the thread's turns go on"
        );
        // Recorded durably (`error`, which no capture overwrites) before the thread's turns go,
        // so a restart cannot forget it and let a later checkout stand in for this turn.
        let checkpoint = TurnCheckpoint {
            thread_id: &thread_id,
            turn_id: &turn_id,
            turn_count,
            assistant_message_id: None,
            completed_at: &completed_at,
        };
        if let Err(error) =
            dispatch_turn_checkpoint(&engine, &checkpoint, "error", Vec::new()).await
        {
            tracing::warn!(%thread_id, turn_count, %error, "a stale turn checkpoint could not be recorded");
        }
        engine.release_checkpoint_hold(&thread_id, &turn_id);
        let created_at = now_iso();
        let _ = engine
            .dispatch(OrchestrationCommand::ThreadActivityAppend {
                command_id: server_id("checkpoint-capture-stale"),
                thread_id: thread_id.clone(),
                activity: ActivityInput {
                    id: Uuid::new_v4().to_string(),
                    tone: "error".to_owned(),
                    kind: "checkpoint.capture.failed".to_owned(),
                    summary: "Checkpoint capture failed".to_owned(),
                    payload: json!({
                        "turnCount": turn_count,
                        "detail": "The checkpoint was not captured in time, so this turn's changes cannot be shown or reverted to."
                    }),
                    turn_id: Some(turn_id),
                    sequence: None,
                    created_at: created_at.clone(),
                },
                created_at,
            })
            .await;
    });
}

/// Captures the checkpoint of a turn recorded `missing` and records it `ready`. A turn already
/// `ready`, or given up (`error`), is left alone: its ref is never written again.
async fn capture_missing_checkpoint(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let payload = &event.event.payload;
    let Some(thread_id) = payload.get("threadId").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(turn_id) = payload.get("turnId").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(turn_count) = payload.get("checkpointTurnCount").and_then(Value::as_i64) else {
        return Ok(());
    };
    let Some(cwd) = resolve_workspace(engine, callbacks, thread_id).await? else {
        return Ok(());
    };
    if !is_git_repository(&cwd, Path::new("git"), cancellation).await? {
        return Ok(());
    }

    let existing = engine
        .repositories()
        .get_turn_by_id(thread_id.to_owned(), turn_id.to_owned())
        .await?;
    if existing
        .as_ref()
        .and_then(|turn| turn.checkpoint_status.as_deref())
        .is_some_and(|status| status != "missing")
    {
        return Ok(());
    }
    let checkpoint = TurnCheckpoint {
        thread_id,
        turn_id,
        turn_count,
        assistant_message_id: payload
            .get("assistantMessageId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| existing.and_then(|turn| turn.assistant_message_id)),
        completed_at: payload
            .get("completedAt")
            .and_then(Value::as_str)
            .unwrap_or(&event.event.occurred_at),
    };
    record_checkpoint(engine, callbacks, &cwd, &checkpoint, cancellation).await
}

/// Captures the checkout as `checkpoint`'s ref, then records the checkpoint `ready` with the
/// files changed since the turn before it.
async fn record_checkpoint(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    cwd: &Path,
    checkpoint: &TurnCheckpoint<'_>,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let TurnCheckpoint {
        thread_id,
        turn_id,
        turn_count,
        completed_at,
        ..
    } = *checkpoint;
    let target_ref = checkpoint_ref(thread_id, turn_count);
    let stale = || {
        OrchestrationEffectsError::Effect(format!(
            "The checkpoint of turn {turn_count} was not captured in time, so its changes cannot be shown or reverted to."
        ))
    };
    if engine.checkpoint_is_stale(thread_id, turn_id) {
        return Err(stale());
    }
    // Always written, replacing whatever ref has this number: only a `missing` row gets here, and
    // a ref already there is a leftover (a reverted turn's ref that Git could not delete), never
    // this turn's end state. The hold keeps every later turn, and its baseline, behind this
    // capture. A capture that fails takes such a leftover away, so the next turn's baseline
    // writes the ref afresh instead of keeping it.
    if let Err(error) = capture_checkpoint_with_cancellation(
        cwd,
        Path::new("git"),
        thread_id,
        turn_count,
        cancellation,
    )
    .await
    {
        if delete_ref(cwd, Path::new("git"), &target_ref, cancellation)
            .await
            .is_err()
        {
            tracing::warn!(
                thread_id,
                turn_count,
                "an uncaptured turn's checkpoint ref could not be deleted"
            );
        }
        return Err(error);
    }
    // One decision against the hold's expiry: claimed, this capture is recorded and the expiry
    // can no longer fire; lost, the hold expired while Git ran, the thread's next turn may have
    // edited the checkout, and this capture is not the turn's end state.
    if !engine.claim_checkpoint_completion(thread_id, turn_id) {
        if delete_ref(cwd, Path::new("git"), &target_ref, cancellation)
            .await
            .is_err()
        {
            tracing::warn!(
                thread_id,
                turn_count,
                "a stale turn's checkpoint ref could not be deleted"
            );
        }
        return Err(stale());
    }
    // Only the displayed status reads it; the checkpoint itself is captured.
    if callbacks.refresh_workspace(cwd).await.is_err() {
        tracing::warn!(
            thread_id,
            turn_count,
            "the workspace status was not refreshed after a checkpoint"
        );
    }

    // `ready` means the turn's diff can be read. Without the turn before's checkpoint (its
    // baseline capture failed) it cannot, so the turn stays `missing`; its own ref, kept, is the
    // next turn's baseline. Nor can it from the ref of a turn given up (`error`): that ref, if
    // one was left behind, is no turn's end state, and no baseline replaced it.
    let from_ref = checkpoint_ref(thread_id, turn_count.saturating_sub(1));
    let previous_given_up = turn_count > 1
        && engine
            .repositories()
            .get_checkpoint(thread_id.to_owned(), turn_count - 1)
            .await?
            .is_some_and(|previous| previous.status == "error");
    if previous_given_up || !has_ref(cwd, Path::new("git"), &from_ref, cancellation).await? {
        return Err(OrchestrationEffectsError::Effect(format!(
            "The checkpoint before turn {turn_count} is missing, so this turn's changes cannot be shown."
        )));
    }
    let files =
        diff_file_summaries(cwd, Path::new("git"), &from_ref, &target_ref, cancellation).await?;
    dispatch_turn_checkpoint(engine, checkpoint, "ready", files).await?;
    engine
        .dispatch(OrchestrationCommand::ThreadActivityAppend {
            command_id: server_id("checkpoint-captured-activity"),
            thread_id: thread_id.to_owned(),
            activity: ActivityInput {
                id: Uuid::new_v4().to_string(),
                tone: "info".to_owned(),
                kind: "checkpoint.captured".to_owned(),
                summary: "Checkpoint captured".to_owned(),
                payload: json!({"turnCount":turn_count,"status":"ready"}),
                turn_id: Some(turn_id.to_owned()),
                sequence: None,
                created_at: completed_at.to_owned(),
            },
            created_at: completed_at.to_owned(),
        })
        .await
        .map_err(|error| OrchestrationEffectsError::Effect(error.to_string()))?;
    Ok(())
}

async fn dispatch_turn_checkpoint(
    engine: &OrchestrationEngine,
    checkpoint: &TurnCheckpoint<'_>,
    status: &str,
    files: Vec<Value>,
) -> Result<(), OrchestrationEffectsError> {
    engine
        .dispatch(OrchestrationCommand::ThreadTurnDiffComplete {
            command_id: server_id("checkpoint-turn-diff-complete"),
            thread_id: checkpoint.thread_id.to_owned(),
            turn_id: checkpoint.turn_id.to_owned(),
            checkpoint_turn_count: checkpoint.turn_count,
            checkpoint_ref: checkpoint_ref(checkpoint.thread_id, checkpoint.turn_count),
            status: status.to_owned(),
            files: Value::Array(files),
            assistant_message_id: checkpoint.assistant_message_id.clone(),
            completed_at: checkpoint.completed_at.to_owned(),
            created_at: checkpoint.completed_at.to_owned(),
        })
        .await
        .map(|_| ())
        .map_err(|error| OrchestrationEffectsError::Effect(error.to_string()))
}

/// A revert that passed its checks, with what its rewind and restore need. Planned while the
/// thread is reserved, off the worker; nothing in it writes the checkout.
struct RevertPlan {
    thread_id: String,
    turn_count: i64,
    cwd: PathBuf,
    checkpoints: Vec<crate::persistence::ProjectionCheckpoint>,
    target_ref: String,
    rolled_back_turns: i64,
    /// The provider rewind's idempotency key, fixed when the revert is planned.
    rewind_key: String,
    /// The request's command id, which the outcome's command id names.
    request: Option<String>,
}

/// Checks the revert under its thread's reservation, then lets the provider prepare its rewind
/// (reopening a session suspended while idle). Only reads the checkout, so it can run off the
/// worker. The rewind then finds a live session.
async fn plan_revert(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
    cancellation: &CancellationToken,
) -> Result<RevertPlan, OrchestrationEffectsError> {
    let payload = &event.event.payload;
    let thread_id = required_str(payload, "threadId")?;
    let turn_count = payload
        .get("turnCount")
        .and_then(Value::as_i64)
        .ok_or_else(|| OrchestrationEffectsError::Effect("missing turnCount".to_owned()))?;
    // A running turn would write over the restored files or be cut off by the rewind, and the
    // client's own guard does not cover another client. Busy is what idle suspension calls busy.
    if engine
        .repositories()
        .get_thread_session(thread_id.to_owned())
        .await?
        .is_some_and(|session| super::provider_runtime::session_holds_a_turn(&session))
    {
        return Err(OrchestrationEffectsError::Effect(
            "Interrupt the current turn before reverting checkpoints.".to_owned(),
        ));
    }
    let cwd = resolve_workspace(engine, callbacks, thread_id)
        .await?
        .ok_or_else(|| {
            OrchestrationEffectsError::Effect(
                "No active provider session with workspace cwd is bound to this thread.".to_owned(),
            )
        })?;
    if !is_git_repository(&cwd, Path::new("git"), cancellation).await? {
        return Err(OrchestrationEffectsError::Effect(
            "Checkpoints are unavailable because this project is not a git repository.".to_owned(),
        ));
    }

    let checkpoints = engine
        .repositories()
        .list_checkpoints_by_thread(thread_id.to_owned())
        .await?;
    let current_turn_count = checkpoints
        .iter()
        .map(|checkpoint| checkpoint.checkpoint_turn_count)
        .max()
        .unwrap_or(0);
    if turn_count > current_turn_count {
        return Err(OrchestrationEffectsError::Effect(format!(
            "Checkpoint turn count {turn_count} exceeds current turn count {current_turn_count}."
        )));
    }
    let target_ref = if turn_count == 0 {
        checkpoint_ref(thread_id, 0)
    } else {
        let target = checkpoints
            .iter()
            .find(|checkpoint| checkpoint.checkpoint_turn_count == turn_count)
            .ok_or_else(|| {
                OrchestrationEffectsError::Effect(format!(
                    "Checkpoint ref for turn {turn_count} is unavailable in read model."
                ))
            })?;
        // Only a captured checkpoint is the turn's end state. A ref of a turn not captured
        // (`missing`) or given up (`error`) may hold a later checkout, so it is never restored.
        if target.status != "ready" {
            return Err(uncaptured_checkpoint(turn_count));
        }
        target.checkpoint_ref.clone()
    };
    // The provider rewind cannot be undone, so it runs before any file is touched and only once
    // the checkpoint is known to resolve. A refused rewind then changes nothing.
    if checkpoint_revision(
        &cwd,
        Path::new("git"),
        &target_ref,
        turn_count == 0,
        cancellation,
    )
    .await?
    .is_none()
    {
        return Err(missing_checkpoint(turn_count));
    }
    let rolled_back_turns = current_turn_count.saturating_sub(turn_count);
    // The rewind's idempotency key: the transcript it counts from, named by its newest turn. A
    // retry from the same transcript (its earlier completion was not recorded) reuses it; once
    // the revert is recorded the newest turn changes, and so does the key.
    let rewind_key = checkpoints
        .iter()
        .max_by_key(|checkpoint| checkpoint.checkpoint_turn_count)
        .map(|checkpoint| format!("{thread_id}/{}", checkpoint.turn_id))
        .unwrap_or_else(|| format!("{thread_id}/{current_turn_count}"));
    if rolled_back_turns > 0 {
        callbacks
            .prepare_provider_rewind(thread_id)
            .await
            .map_err(OrchestrationEffectsError::Effect)?;
    }
    Ok(RevertPlan {
        thread_id: thread_id.to_owned(),
        turn_count,
        cwd,
        checkpoints,
        target_ref,
        rolled_back_turns,
        rewind_key,
        request: event.event.command_id.clone(),
    })
}

/// The revert refusal for a turn whose checkpoint was never captured.
fn uncaptured_checkpoint(turn_count: i64) -> OrchestrationEffectsError {
    OrchestrationEffectsError::Effect(uncaptured_checkpoint_detail(turn_count))
}

/// Why a turn whose checkpoint was never captured (its capture failed or timed out) cannot be
/// reverted to. Shared with MCP's check before the revert is requested.
pub(crate) fn uncaptured_checkpoint_detail(turn_count: i64) -> String {
    format!(
        "Turn {turn_count} has no captured checkpoint (its capture failed or timed out), so the thread cannot be reverted to it. Revert to an earlier turn."
    )
}

/// Why a turn whose checkpoint was never captured has no diff to read. The diff reads (the
/// app's turn and full-thread patches, MCP `get_turn_diff`) refuse it as revert does.
pub(crate) fn uncaptured_diff_detail(turn_count: i64) -> String {
    format!(
        "Turn {turn_count} has no captured checkpoint (its capture failed or timed out), so its changes cannot be shown."
    )
}

fn missing_checkpoint(turn_count: i64) -> OrchestrationEffectsError {
    OrchestrationEffectsError::Effect(format!(
        "Filesystem checkpoint is unavailable for turn {turn_count}."
    ))
}

/// Rewinds the provider and restores the files, on the worker: checkpoint work on a checkout
/// that sibling threads share must not overlap.
async fn finish_revert(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    plan: RevertPlan,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let RevertPlan {
        thread_id,
        turn_count,
        cwd,
        checkpoints,
        target_ref,
        rolled_back_turns,
        rewind_key,
        request,
    } = plan;
    let thread_id = thread_id.as_str();
    let missing_checkpoint = || missing_checkpoint(turn_count);
    if rolled_back_turns > 0
        && let ProviderRewind::FilesOnly { provider_label } = callbacks
            .rollback_provider(thread_id, rolled_back_turns, &rewind_key)
            .await
            .map_err(OrchestrationEffectsError::Effect)?
    {
        // The provider keeps its conversation, so the thread keeps its messages, checkpoints and
        // turn count too. Only the files go back, and the work log says so.
        if !restore_checkpoint(
            &cwd,
            Path::new("git"),
            &target_ref,
            turn_count == 0,
            cancellation,
        )
        .await?
        {
            return Err(missing_checkpoint());
        }
        callbacks
            .refresh_workspace(&cwd)
            .await
            .map_err(OrchestrationEffectsError::Effect)?;
        let created_at = now_iso();
        return engine
            .dispatch(OrchestrationCommand::ThreadActivityAppend {
                command_id: outcome_id("checkpoint-revert-files-only", request.as_deref()),
                thread_id: thread_id.to_owned(),
                activity: ActivityInput {
                    id: Uuid::new_v4().to_string(),
                    tone: "info".to_owned(),
                    kind: "checkpoint.revert.files-only".to_owned(),
                    summary: "Files restored, conversation not rewound".to_owned(),
                    payload: json!({
                        "turnCount": turn_count,
                        "detail": format!(
                            "{provider_label} can't rewind its conversation, so it still has the later messages."
                        ),
                    }),
                    turn_id: None,
                    sequence: None,
                    created_at: created_at.clone(),
                },
                created_at,
            })
            .await
            .map(|_| ())
            .map_err(|error| OrchestrationEffectsError::Effect(error.to_string()));
    }
    // Once the provider has rewound, the revert must be recorded, or a retry would rewind the
    // provider a second time. Shutdown therefore waits for the restore instead of interrupting
    // it, and a restore that fails is still recorded.
    let uninterruptible = CancellationToken::new();
    let cancellation = if rolled_back_turns > 0 {
        &uninterruptible
    } else {
        cancellation
    };
    let restored = match restore_checkpoint(
        &cwd,
        Path::new("git"),
        &target_ref,
        turn_count == 0,
        cancellation,
    )
    .await
    {
        Ok(true) => Ok(()),
        Ok(false) => Err(missing_checkpoint()),
        Err(error) => Err(error),
    };
    if restored.is_ok() {
        callbacks
            .refresh_workspace(&cwd)
            .await
            .map_err(OrchestrationEffectsError::Effect)?;
    } else if rolled_back_turns == 0 {
        // Nothing was rewound, so the revert stays undone and can simply be retried.
        return restored;
    }
    for checkpoint in checkpoints
        .iter()
        .filter(|checkpoint| checkpoint.checkpoint_turn_count > turn_count)
    {
        // The rewind and the restore happened, so the revert is still recorded; the turns'
        // rows go with it, and a diff or revert reads a checkpoint only from a `ready` row.
        if delete_ref(
            &cwd,
            Path::new("git"),
            &checkpoint.checkpoint_ref,
            cancellation,
        )
        .await
        .is_err()
        {
            tracing::warn!(
                thread_id,
                turn_count = checkpoint.checkpoint_turn_count,
                "a reverted turn's checkpoint ref could not be deleted"
            );
        }
    }
    let created_at = now_iso();
    // A revert whose files were not restored records its completion under a tag of its own, so
    // a client waiting on it knows a failure follows instead of reading success.
    let tag = if restored.is_ok() {
        "checkpoint-revert-complete"
    } else {
        UNRESTORED_REVERT_TAG
    };
    engine
        .dispatch(OrchestrationCommand::ThreadRevertComplete {
            command_id: outcome_id(tag, request.as_deref()),
            thread_id: thread_id.to_owned(),
            turn_count,
            created_at,
        })
        .await
        .map_err(|error| OrchestrationEffectsError::Effect(error.to_string()))?;
    restored.map_err(|error| {
        OrchestrationEffectsError::Effect(format!(
            "The conversation was rewound, but the files could not be restored: {error}"
        ))
    })
}

async fn cleanup_deleted_thread(
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
) {
    let Some(thread_id) = event.event.payload.get("threadId").and_then(Value::as_str) else {
        return;
    };
    if let Err(error) = callbacks.stop_provider(thread_id).await {
        tracing::debug!(thread_id, %error, "thread deletion cleanup skipped provider session stop");
    }
    if let Err(error) = callbacks.close_terminals(thread_id).await {
        tracing::debug!(thread_id, %error, "thread deletion cleanup skipped terminal close");
    }
    if let Err(error) = callbacks.close_previews(thread_id).await {
        tracing::debug!(thread_id, %error, "thread deletion cleanup skipped preview close");
    }
    if let Err(error) = callbacks.close_devices(thread_id).await {
        tracing::debug!(thread_id, %error, "thread deletion cleanup skipped device close");
    }
}

async fn append_failure_activity(
    engine: &OrchestrationEngine,
    event: &OrchestrationEvent,
    detail: &str,
) {
    let Some(thread_id) = event.event.payload.get("threadId").and_then(Value::as_str) else {
        return;
    };
    let (kind, summary, turn_id, payload) =
        if event.event.event_type == "thread.checkpoint-revert-requested" {
            (
                "checkpoint.revert.failed",
                "Checkpoint revert failed",
                None,
                json!({"turnCount":event.event.payload.get("turnCount"),"detail":detail}),
            )
        } else {
            (
                "checkpoint.capture.failed",
                "Checkpoint capture failed",
                event
                    .event
                    .payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                json!({"detail":detail}),
            )
        };
    let created_at = now_iso();
    let _ = engine
        .dispatch(OrchestrationCommand::ThreadActivityAppend {
            command_id: outcome_id(
                "checkpoint-effect-failure",
                event.event.command_id.as_deref(),
            ),
            thread_id: thread_id.to_owned(),
            activity: ActivityInput {
                id: Uuid::new_v4().to_string(),
                tone: "error".to_owned(),
                kind: kind.to_owned(),
                summary: summary.to_owned(),
                payload,
                turn_id,
                sequence: None,
                created_at: created_at.clone(),
            },
            created_at,
        })
        .await;
}

pub fn checkpoint_ref(thread_id: &str, turn_count: i64) -> String {
    format!(
        "refs/bibcode/checkpoints/{}/turn/{turn_count}",
        URL_SAFE_NO_PAD.encode(thread_id)
    )
}

pub async fn capture_checkpoint(
    cwd: &Path,
    thread_id: &str,
    turn_count: i64,
) -> Result<(), OrchestrationEffectsError> {
    capture_checkpoint_with_cancellation(
        cwd,
        Path::new("git"),
        thread_id,
        turn_count,
        &CancellationToken::new(),
    )
    .await
}

async fn capture_checkpoint_with_cancellation(
    cwd: &Path,
    git_command: &Path,
    thread_id: &str,
    turn_count: i64,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let common_dir = run_git(
        cwd,
        git_command,
        &["rev-parse", "--git-common-dir"],
        &[],
        false,
        cancellation,
    )
    .await?
    .stdout;
    let common_dir = PathBuf::from(common_dir.trim());
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        cwd.join(common_dir)
    };
    let temporary_index = common_dir.join(format!("bibcode-checkpoint-index-{}", Uuid::new_v4()));
    let reference = checkpoint_ref(thread_id, turn_count);
    let env = checkpoint_environment(&temporary_index);

    let result = async {
        let head = run_git(
            cwd,
            git_command,
            &["rev-parse", "--verify", "HEAD^{commit}"],
            &env,
            true,
            cancellation,
        )
        .await?;
        if head.exit_code == 0 {
            run_git(
                cwd,
                git_command,
                &["read-tree", "HEAD"],
                &env,
                false,
                cancellation,
            )
            .await?;
        }
        run_git(
            cwd,
            git_command,
            &["add", "-A", "--", "."],
            &env,
            false,
            cancellation,
        )
        .await?;
        let tree = run_git(cwd, git_command, &["write-tree"], &env, false, cancellation)
            .await?
            .stdout;
        let message = format!("bibcode checkpoint ref={reference}");
        let commit = run_git(
            cwd,
            git_command,
            &["commit-tree", tree.trim(), "-m", &message],
            &env,
            false,
            cancellation,
        )
        .await?
        .stdout;
        run_git(
            cwd,
            git_command,
            &["update-ref", &reference, commit.trim()],
            &[],
            false,
            cancellation,
        )
        .await?;
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_file(temporary_index).await;
    result
}

async fn is_git_repository(
    cwd: &Path,
    git_command: &Path,
    cancellation: &CancellationToken,
) -> Result<bool, OrchestrationEffectsError> {
    let output = run_git(
        cwd,
        git_command,
        &["rev-parse", "--is-inside-work-tree"],
        &[],
        true,
        cancellation,
    )
    .await?;
    Ok(output.exit_code == 0 && output.stdout.trim() == "true")
}

async fn has_ref(
    cwd: &Path,
    git_command: &Path,
    reference: &str,
    cancellation: &CancellationToken,
) -> Result<bool, OrchestrationEffectsError> {
    Ok(run_git(
        cwd,
        git_command,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{reference}^{{commit}}"),
        ],
        &[],
        true,
        cancellation,
    )
    .await?
    .exit_code
        == 0)
}

/// Whether `reference` names any object in the repository at `cwd`. Unlike [`has_ref`] it does
/// not peel the object, so a ref that points at something other than a commit still counts as
/// present and the caller's `^{commit}` reports the mismatch.
pub(crate) async fn ref_exists(
    cwd: &Path,
    reference: &str,
    cancellation: &CancellationToken,
) -> Result<bool, OrchestrationEffectsError> {
    Ok(run_git(
        cwd,
        Path::new("git"),
        &["rev-parse", "--verify", "--quiet", reference],
        &[],
        true,
        cancellation,
    )
    .await?
    .exit_code
        == 0)
}

/// The revision a checkpoint restores from: its ref, or `HEAD` when allowed and the ref is gone.
async fn checkpoint_revision(
    cwd: &Path,
    git_command: &Path,
    reference: &str,
    fallback_to_head: bool,
    cancellation: &CancellationToken,
) -> Result<Option<String>, OrchestrationEffectsError> {
    if has_ref(cwd, git_command, reference, cancellation).await? {
        return Ok(Some(reference.to_owned()));
    }
    let head_exists = fallback_to_head
        && run_git(
            cwd,
            git_command,
            &["rev-parse", "--verify", "HEAD^{commit}"],
            &[],
            true,
            cancellation,
        )
        .await?
        .exit_code
            == 0;
    Ok(head_exists.then(|| "HEAD".to_owned()))
}

async fn restore_checkpoint(
    cwd: &Path,
    git_command: &Path,
    reference: &str,
    fallback_to_head: bool,
    cancellation: &CancellationToken,
) -> Result<bool, OrchestrationEffectsError> {
    let Some(revision) =
        checkpoint_revision(cwd, git_command, reference, fallback_to_head, cancellation).await?
    else {
        return Ok(false);
    };
    run_git(
        cwd,
        git_command,
        &[
            "restore",
            "--source",
            &revision,
            "--worktree",
            "--staged",
            "--",
            ".",
        ],
        &[],
        false,
        cancellation,
    )
    .await?;
    run_git(
        cwd,
        git_command,
        &["clean", "-fd", "--", "."],
        &[],
        false,
        cancellation,
    )
    .await?;
    if run_git(
        cwd,
        git_command,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        &[],
        true,
        cancellation,
    )
    .await?
    .exit_code
        == 0
    {
        run_git(
            cwd,
            git_command,
            &["reset", "--quiet", "--", "."],
            &[],
            false,
            cancellation,
        )
        .await?;
    }
    Ok(true)
}

async fn delete_ref(
    cwd: &Path,
    git_command: &Path,
    reference: &str,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    let output = run_git(
        cwd,
        git_command,
        &["update-ref", "-d", reference],
        &[],
        true,
        cancellation,
    )
    .await?;
    // A ref Git kept would still be read as that turn's checkpoint.
    if output.exit_code != 0 {
        return Err(OrchestrationEffectsError::Effect(format!(
            "Git could not delete a checkpoint ref (exit {}).",
            output.exit_code
        )));
    }
    Ok(())
}

async fn diff_file_summaries(
    cwd: &Path,
    git_command: &Path,
    from_ref: &str,
    to_ref: &str,
    cancellation: &CancellationToken,
) -> Result<Vec<Value>, OrchestrationEffectsError> {
    let output = run_git(
        cwd,
        git_command,
        &[
            "diff",
            "--numstat",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            &format!("{from_ref}^{{commit}}"),
            &format!("{to_ref}^{{commit}}"),
        ],
        &[],
        false,
        cancellation,
    )
    .await?;
    let mut files = output
        .stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let additions = fields.next()?;
            let deletions = fields.next()?;
            let path = fields.next()?;
            Some(json!({
                "path": path,
                "kind": "modified",
                "additions": additions.parse::<i64>().unwrap_or(0),
                "deletions": deletions.parse::<i64>().unwrap_or(0),
            }))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    Ok(files)
}

async fn run_git(
    cwd: &Path,
    git_command: &Path,
    args: &[&str],
    env: &[(OsString, OsString)],
    allow_non_zero_exit: bool,
    cancellation: &CancellationToken,
) -> Result<crate::git::ProcessOutput, OrchestrationEffectsError> {
    ProcessRunner
        .run(
            ProcessRequest {
                operation: "OrchestrationEffects.git".to_owned(),
                command: git_command.to_path_buf(),
                args: args.iter().map(OsString::from).collect(),
                cwd: cwd.to_path_buf(),
                env: env.to_vec(),
                stdin: None,
                timeout: GIT_TIMEOUT,
                max_output_bytes: GIT_OUTPUT_LIMIT,
                output_policy: OutputPolicy::Error,
                append_truncation_marker: false,
                allow_non_zero_exit,
            },
            cancellation,
        )
        .await
        .map_err(Into::into)
}

fn checkpoint_environment(index: &Path) -> Vec<(OsString, OsString)> {
    // Git cannot create its lock beside a `\\?\` index path on Windows.
    let index = crate::production::host_paths::process_compatible_path(index.to_path_buf());
    [
        ("GIT_INDEX_FILE", index.to_string_lossy().as_ref()),
        ("GIT_AUTHOR_NAME", "BiBCode"),
        ("GIT_AUTHOR_EMAIL", "bibcode@users.noreply.github.com"),
        ("GIT_COMMITTER_NAME", "BiBCode"),
        ("GIT_COMMITTER_EMAIL", "bibcode@users.noreply.github.com"),
    ]
    .into_iter()
    .map(|(key, value)| (OsString::from(key), OsString::from(value)))
    .collect()
}

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, OrchestrationEffectsError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| OrchestrationEffectsError::Effect(format!("missing {field}")))
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

fn server_id(tag: &str) -> String {
    format!("server:{tag}:{}", Uuid::new_v4())
}

/// The tag of a `thread.reverted` whose provider rewound but whose files were not restored; a
/// `checkpoint.revert.failed` activity follows it.
pub(crate) const UNRESTORED_REVERT_TAG: &str = "checkpoint-revert-unrestored";

/// The command id of an outcome the worker records for request `request`: it contains
/// `:{request}:`, so a client waiting on one revert is not answered by another revert of the
/// same thread.
fn outcome_id(tag: &str, request: Option<&str>) -> String {
    match request {
        Some(request) => format!("server:{tag}:{request}:{}", Uuid::new_v4()),
        None => server_id(tag),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::orchestration::EngineOptions;
    use crate::persistence::{
        Database, NewOrchestrationEvent, ProjectionProject, Repositories, run_migrations,
    };
    use crate::test_support::TestSandbox;

    use super::*;

    /// An engine over an empty in-memory event log.
    async fn empty_event_log() -> OrchestrationEngine {
        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        OrchestrationEngine::start(database, EngineOptions::default())
            .await
            .expect("engine")
    }

    #[tokio::test]
    async fn a_compaction_that_could_not_run_is_settled_and_recorded() {
        const AT: &str = "2026-10-24T00:00:00Z";
        let engine = empty_event_log().await;
        for value in [
            json!({"type":"project.create","commandId":"project","projectId":"p","title":"P","workspaceRoot":"C:/repo","createdAt":AT}),
            json!({"type":"thread.create","commandId":"thread","threadId":"t","projectId":"p","title":"T","modelSelection":{"instanceId":"claudeAgent","model":"claude-opus"},"runtimeMode":"full-access","createdAt":AT}),
        ] {
            engine
                .dispatch(serde_json::from_value(value).unwrap())
                .await
                .unwrap();
        }
        engine
            .repositories()
            .database()
            .call(|connection| {
                connection.execute("INSERT INTO thread_compactions (compaction_id, thread_id, trigger, state, provider_instance_id, provider_kind, created_at, updated_at) VALUES ('c', 't', 'manual', 'requested', 'claudeAgent', 'claudeAgent', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')", [])?;
                Ok(())
            })
            .await
            .unwrap();
        crate::diagnostics::profiler::provider_turns::take_recorded();
        settle_unrun_compaction(&engine, "t", "c", "The workspace is unavailable.").await;
        let row = engine.thread_compaction("c").await.unwrap().unwrap();
        assert_eq!(row.state, "failed");
        let recorded = crate::diagnostics::profiler::provider_turns::take_recorded();
        assert_eq!(recorded.len(), 1, "{recorded:?}");
        assert_eq!(recorded[0].0, "provider.compaction");
        assert_eq!(recorded[0].1["outcome"], "failed");
        assert_eq!(recorded[0].1["reason"], "not_started");
        assert_eq!(recorded[0].1["provider"], "claude");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn imported_history_captures_no_turn_baseline() {
        const AT: &str = "2026-10-08T00:00:00Z";
        let engine = empty_event_log().await;
        for value in [
            json!({"type":"project.create","commandId":"project","projectId":"p","title":"P","workspaceRoot":"C:/repo","createdAt":AT}),
            json!({"type":"thread.create","commandId":"thread","threadId":"t","projectId":"p","title":"T","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","createdAt":AT}),
            json!({"type":"thread.history.import","commandId":"history","threadId":"t","messages":[
                {"messageId":"h-0","role":"user","text":"old prompt","createdAt":AT},
                {"messageId":"h-1","role":"assistant","text":"old answer","createdAt":AT}
            ]}),
            json!({"type":"thread.turn.start","commandId":"turn","threadId":"t","message":{"messageId":"live","role":"user","text":"continue","attachments":[]},"createdAt":AT}),
        ] {
            engine
                .dispatch(serde_json::from_value(value).unwrap())
                .await
                .expect("command");
        }
        let baselines = engine
            .read_events(0)
            .await
            .expect("events")
            .into_iter()
            .filter(|event| event.event.event_type == "thread.message-sent")
            .map(|event| {
                (
                    event.event.payload["messageId"].clone(),
                    needs_turn_baseline(&event),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            baselines,
            [
                (json!("h-0"), false),
                (json!("h-1"), false),
                (json!("live"), true),
            ]
        );
        engine.shutdown().await;
    }

    /// Ref 0 is captured again only for a thread whose earlier turns predate checkpoints: never
    /// once an earlier turn has a number, never for a new thread's own first turn (it can end and
    /// be numbered before the worker handles its start), and never while another turn runs.
    #[test]
    fn only_turns_before_checkpoints_refresh_ref_zero() {
        let turn = |turn_id: &str, message: &str, state: &str, number: Option<i64>| {
            crate::persistence::ProjectionTurn {
                thread_id: "t".to_owned(),
                turn_id: Some(turn_id.to_owned()),
                pending_message_id: Some(message.to_owned()),
                source_proposed_plan_thread_id: None,
                source_proposed_plan_id: None,
                assistant_message_id: None,
                state: state.to_owned(),
                requested_at: String::new(),
                started_at: None,
                completed_at: None,
                checkpoint_turn_count: number,
                checkpoint_ref: None,
                checkpoint_status: number.map(|_| "missing".to_owned()),
                checkpoint_files: json!([]),
            }
        };
        let old = turn("old", "m-old", "completed", None);
        let starting = Some("m-new");
        // A thread's first turn, running or already ended and numbered.
        assert!(!had_turns_before_checkpoints(&[], starting));
        assert!(!had_turns_before_checkpoints(
            &[turn("new", "m-new", "running", None)],
            starting
        ));
        assert!(!had_turns_before_checkpoints(
            &[turn("new", "m-new", "completed", Some(1))],
            starting
        ));
        // A thread with turns before checkpoints, the new turn not started or already running.
        assert!(had_turns_before_checkpoints(
            std::slice::from_ref(&old),
            starting
        ));
        assert!(had_turns_before_checkpoints(
            &[old.clone(), turn("new", "m-new", "running", None)],
            starting
        ));
        // ... and when the new turn already ended and was numbered (the worker is behind).
        assert!(had_turns_before_checkpoints(
            &[old.clone(), turn("new", "m-new", "completed", Some(1))],
            starting
        ));
        // ... but not once an earlier turn has a number, nor while another turn runs.
        assert!(!had_turns_before_checkpoints(
            &[old.clone(), turn("prior", "m-prior", "completed", Some(1))],
            starting
        ));
        assert!(!had_turns_before_checkpoints(
            &[old, turn("other", "m-other", "running", None)],
            starting
        ));
    }

    /// A turn a restart cut off keeps its place among the recorded turns, `missing`, so a revert
    /// across it rewinds the provider by every turn. Before any recorded turn it is not numbered:
    /// the next turn's baseline starts the thread's checkpoints after it.
    #[tokio::test]
    async fn a_cut_off_turn_is_numbered_only_after_a_recorded_turn() {
        const AT: &str = "2026-10-31T00:00:00Z";
        let engine = empty_event_log().await;
        for value in [
            json!({"type":"project.create","commandId":"project","projectId":"p","title":"P","workspaceRoot":"C:/repo","createdAt":AT}),
            json!({"type":"thread.create","commandId":"thread","threadId":"t","projectId":"p","title":"T","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","createdAt":AT}),
        ] {
            engine
                .dispatch(serde_json::from_value(value).unwrap())
                .await
                .unwrap();
        }
        let repositories = engine.repositories();
        let numbers = || async {
            repositories
                .list_checkpoints_by_thread("t".to_owned())
                .await
                .unwrap()
                .into_iter()
                .map(|checkpoint| {
                    (
                        checkpoint.turn_id,
                        checkpoint.checkpoint_turn_count,
                        checkpoint.status,
                    )
                })
                .collect::<Vec<_>>()
        };

        record_turn_end(&engine, "t", "turn-0", AT, TurnEnd::CutOff, None)
            .await
            .unwrap();
        assert_eq!(numbers().await, []);
        // Nor is a live turn outside a Git checkout.
        record_turn_end(&engine, "t", "turn-0", AT, TurnEnd::Live, None)
            .await
            .unwrap();
        assert_eq!(numbers().await, []);

        engine
            .dispatch(serde_json::from_value(json!({
                "type":"thread.turn.diff.complete","commandId":"diff-1","threadId":"t","turnId":"turn-1",
                "checkpointTurnCount":1,"checkpointRef":checkpoint_ref("t", 1),"status":"ready",
                "files":[],"assistantMessageId":null,"completedAt":AT,"createdAt":AT
            })).unwrap())
            .await
            .unwrap();
        for _ in 0..2 {
            record_turn_end(&engine, "t", "turn-2", AT, TurnEnd::CutOff, None)
                .await
                .unwrap();
        }
        // Recording a turn already recorded `ready` changes nothing.
        record_turn_end(&engine, "t", "turn-1", AT, TurnEnd::CutOff, None)
            .await
            .unwrap();
        assert_eq!(
            numbers().await,
            [
                ("turn-1".to_owned(), 1, "ready".to_owned()),
                ("turn-2".to_owned(), 2, "missing".to_owned()),
            ]
        );
        // No effects worker records checkpoints here, so a live end holds no queue.
        record_turn_end(&engine, "t", "turn-3", AT, TurnEnd::Live, None)
            .await
            .unwrap();
        assert!(!engine.turns_held_for_checkpoint("t"));
        assert_eq!(numbers().await.len(), 3);
        engine.shutdown().await;
    }

    async fn append_reactor_event(
        repositories: &Repositories,
        event_type: &'static str,
        index: usize,
    ) -> OrchestrationEvent {
        repositories
            .append_event(NewOrchestrationEvent {
                event_id: format!("effects-lag-{index}"),
                event_type: event_type.to_owned(),
                aggregate_kind: "thread".to_owned(),
                aggregate_id: format!("thread-{index}"),
                occurred_at: "2026-08-01T00:00:00Z".to_owned(),
                command_id: None,
                causation_event_id: None,
                correlation_id: None,
                payload: json!({ "threadId": format!("thread-{index}") }),
                metadata: json!({}),
            })
            .await
            .expect("event")
    }

    /// Runs the producer from `floor` over a subscription of `capacity` that received `broadcast`
    /// before its first receive and then closed. Returns the sequence of every forwarded event.
    async fn forwarded_sequences(
        engine: &OrchestrationEngine,
        floor: i64,
        broadcast: Vec<OrchestrationEvent>,
        capacity: usize,
    ) -> Vec<i64> {
        let (events, subscription) = broadcast::channel(capacity);
        for event in broadcast {
            let _ = events.send(event);
        }
        drop(events);
        let (sender, mut receiver) = mpsc::channel(1024);
        tokio::time::timeout(
            Duration::from_secs(10),
            run_producer(
                engine.clone(),
                sender,
                CancellationToken::new(),
                subscription,
                floor,
            ),
        )
        .await
        .expect("the producer stops when its subscription closes");
        let mut forwarded = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            forwarded.push(event.sequence);
        }
        forwarded
    }

    /// Events committed after the startup read, but dropped before the producer's first receive,
    /// are recovered from the log once each. The events the subscription still holds after that
    /// read are skipped instead of re-running side effects such as a checkpoint revert or a thread
    /// deletion, and history at or below the floor is never replayed.
    #[tokio::test]
    async fn lag_recovery_forwards_events_committed_after_the_startup_read_exactly_once() {
        let engine = empty_event_log().await;
        let repositories = engine.repositories();
        for index in 0..3 {
            append_reactor_event(&repositories, "thread.checkpoint-revert-requested", index).await;
        }
        let floor = repositories.max_event_sequence().await.expect("floor");
        let (sender, mut receiver) = mpsc::channel(1024);
        let mut handled_through = floor;
        assert!(
            forward_logged_events(&engine, &sender, &mut handled_through, LogRead::Startup).await,
            "the startup read finds nothing after the floor"
        );
        // More than one page commits before the first receive, so the subscription has lagged.
        let (events, subscription) = broadcast::channel(4);
        let mut expected = Vec::new();
        for index in 3..3 + crate::persistence::EVENT_PAGE_SIZE + 5 {
            let event = append_reactor_event(&repositories, "thread.deleted", index).await;
            expected.push(event.sequence);
            let _ = events.send(event);
        }
        drop(events);

        tokio::time::timeout(
            Duration::from_secs(10),
            forward_subscription(
                &engine,
                &sender,
                &CancellationToken::new(),
                subscription,
                handled_through,
            ),
        )
        .await
        .expect("the producer stops when its subscription closes");

        let mut forwarded = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            forwarded.push(event.sequence);
        }
        assert_eq!(forwarded, expected);
        engine.shutdown().await;
    }

    /// Events committed after the floor was read but before the subscription existed never reach
    /// the subscription, so the producer reads them from the log before its first receive.
    #[tokio::test]
    async fn events_between_the_floor_and_the_subscription_are_forwarded_without_a_lag() {
        let engine = empty_event_log().await;
        let repositories = engine.repositories();
        for index in 0..3 {
            append_reactor_event(&repositories, "thread.checkpoint-revert-requested", index).await;
        }
        let floor = repositories.max_event_sequence().await.expect("floor");
        let mut expected = Vec::new();
        for index in 3..5 {
            expected.push(
                append_reactor_event(&repositories, "thread.deleted", index)
                    .await
                    .sequence,
            );
        }
        let mut broadcast = Vec::new();
        for index in 5..8 {
            let event = append_reactor_event(&repositories, "thread.deleted", index).await;
            expected.push(event.sequence);
            broadcast.push(event);
        }

        assert_eq!(
            forwarded_sequences(&engine, floor, broadcast, 64).await,
            expected
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn unit_build_covers_workspace_normalization_and_checkpoint_git_lifecycle() {
        let parent = tempfile::tempdir().expect("workspace parent");
        let missing = parent.path().join("nested/project");
        assert!(matches!(
            normalize_project_workspace_root(&missing, false).await,
            Err(OrchestrationEffectsError::WorkspaceMissing(_))
        ));
        let normalized = normalize_project_workspace_root(&missing, true)
            .await
            .expect("workspace creates");
        assert!(normalized.is_absolute());
        assert_eq!(process_compatible_path(normalized.clone()), normalized);
        let file = parent.path().join("file");
        tokio::fs::write(&file, "not a directory")
            .await
            .expect("file fixture");
        assert!(matches!(
            normalize_project_workspace_root(&file, false).await,
            Err(OrchestrationEffectsError::WorkspaceNotDirectory(_))
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let read_only = parent.path().join("read-only");
            tokio::fs::create_dir(&read_only).await.unwrap();
            tokio::fs::set_permissions(&read_only, std::fs::Permissions::from_mode(0o500))
                .await
                .unwrap();
            assert!(matches!(
                normalize_project_workspace_root(&read_only.join("child"), true).await,
                Err(OrchestrationEffectsError::WorkspaceIo { .. })
            ));
            tokio::fs::set_permissions(&read_only, std::fs::Permissions::from_mode(0o700))
                .await
                .unwrap();
        }

        let command_root = parent.path().join("command-project");
        let project_effects = ProductionProjectCommandEffects;
        let canonical_command_root = project_effects
            .canonicalize_workspace_root(command_root.to_string_lossy().as_ref(), true)
            .await
            .expect("project command canonicalizes without creating");
        assert!(Path::new(&canonical_command_root).is_absolute());
        assert!(!command_root.exists());
        project_effects
            .prepare_project_create(&canonical_command_root, true, false)
            .await
            .expect("project command prepares");
        assert!(command_root.is_dir());

        let repository = TestSandbox::new("orchestration-checkpoint");
        let git_command = repository.executable_on_path("git");
        let cancellation = CancellationToken::new();
        assert!(
            !is_git_repository(repository.root(), &git_command, &cancellation)
                .await
                .expect("non-repository probe")
        );
        run_git(
            repository.root(),
            &git_command,
            &["init"],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("git init");
        run_git(
            repository.root(),
            &git_command,
            &["config", "core.autocrlf", "false"],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("disable fixture line-ending conversion");
        run_git(
            repository.root(),
            &git_command,
            &["config", "user.name", "BiBCode Test"],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("git user name");
        run_git(
            repository.root(),
            &git_command,
            &["config", "user.email", "bibcode@example.test"],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("git user email");
        tokio::fs::write(repository.root().join("tracked.txt"), "baseline\n")
            .await
            .expect("baseline file");
        run_git(
            repository.root(),
            &git_command,
            &["add", "."],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("git add");
        run_git(
            repository.root(),
            &git_command,
            &["commit", "-m", "baseline"],
            &[],
            false,
            &cancellation,
        )
        .await
        .expect("git commit");
        assert!(
            is_git_repository(repository.root(), &git_command, &cancellation)
                .await
                .expect("repository probe")
        );

        capture_checkpoint_with_cancellation(
            repository.root(),
            &git_command,
            "thread/one",
            0,
            &cancellation,
        )
        .await
        .expect("baseline checkpoint");
        let baseline_ref = checkpoint_ref("thread/one", 0);
        assert!(
            has_ref(
                repository.root(),
                &git_command,
                &baseline_ref,
                &cancellation,
            )
            .await
            .expect("baseline ref")
        );
        tokio::fs::write(repository.root().join("tracked.txt"), "changed\n")
            .await
            .expect("changed file");
        tokio::fs::write(repository.root().join("new.txt"), "new\n")
            .await
            .expect("new file");
        capture_checkpoint_with_cancellation(
            repository.root(),
            &git_command,
            "thread/one",
            1,
            &cancellation,
        )
        .await
        .expect("changed checkpoint");
        let changed_ref = checkpoint_ref("thread/one", 1);
        let files = diff_file_summaries(
            repository.root(),
            &git_command,
            &baseline_ref,
            &changed_ref,
            &cancellation,
        )
        .await
        .expect("checkpoint diff");
        assert_eq!(files.len(), 2);
        assert!(
            restore_checkpoint(
                repository.root(),
                &git_command,
                &baseline_ref,
                false,
                &cancellation,
            )
            .await
            .expect("checkpoint restore")
        );
        assert_eq!(
            tokio::fs::read_to_string(repository.root().join("tracked.txt"))
                .await
                .expect("restored file"),
            "baseline\n"
        );
        assert!(!repository.root().join("new.txt").exists());
        assert!(
            restore_checkpoint(
                repository.root(),
                &git_command,
                "refs/bibcode/checkpoints/missing",
                true,
                &cancellation,
            )
            .await
            .expect("head fallback")
        );
        assert!(
            !restore_checkpoint(
                repository.root(),
                &git_command,
                "refs/bibcode/checkpoints/missing",
                false,
                &cancellation,
            )
            .await
            .expect("missing checkpoint")
        );
        delete_ref(repository.root(), &git_command, &changed_ref, &cancellation)
            .await
            .expect("checkpoint ref deletes");
        assert!(
            !has_ref(repository.root(), &git_command, &changed_ref, &cancellation,)
                .await
                .expect("deleted ref")
        );
        // A ref Git cannot delete (its lock is held) is an error, not a deletion.
        let baseline_lock = repository
            .root()
            .join(".git")
            .join(format!("{baseline_ref}.lock"));
        tokio::fs::write(&baseline_lock, "")
            .await
            .expect("ref lock");
        assert!(
            delete_ref(
                repository.root(),
                &git_command,
                &baseline_ref,
                &cancellation
            )
            .await
            .is_err()
        );
        assert!(
            has_ref(
                repository.root(),
                &git_command,
                &baseline_ref,
                &cancellation
            )
            .await
            .expect("kept ref")
        );
        tokio::fs::remove_file(&baseline_lock)
            .await
            .expect("ref lock removed");

        assert_eq!(checkpoint_environment(Path::new("index")).len(), 5);
        assert_eq!(
            required_str(&json!({"field":"value"}), "field").unwrap(),
            "value"
        );
        assert!(required_str(&json!({}), "field").is_err());
        assert!(!now_iso().is_empty());
        assert!(server_id("unit").starts_with("server:unit:"));
        assert!(checkpoint_ref("thread/one", 2).contains("dGhyZWFkL29uZQ"));

        struct CleanupCallbacks(AtomicUsize);

        impl OrchestrationEffectCallbacks for CleanupCallbacks {
            fn workspace_for_thread<'a>(
                &'a self,
                _: &'a str,
            ) -> BoxEffectFuture<'a, Option<PathBuf>> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Ok(None) })
            }

            fn rollback_provider<'a>(
                &'a self,
                _: &'a str,
                _: i64,
                _rewind_key: &'a str,
            ) -> BoxEffectFuture<'a, ProviderRewind> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Ok(ProviderRewind::Rewound) })
            }

            fn stop_provider<'a>(&'a self, _: &'a str) -> BoxEffectFuture<'a, ()> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Err("provider".to_owned()) })
            }

            fn close_terminals<'a>(&'a self, _: &'a str) -> BoxEffectFuture<'a, ()> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Err("terminals".to_owned()) })
            }

            fn refresh_workspace<'a>(&'a self, _: &'a Path) -> BoxEffectFuture<'a, ()> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Ok(()) })
            }
        }

        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let callbacks = Arc::new(CleanupCallbacks(AtomicUsize::new(0)));
        callbacks
            .workspace_for_thread("thread")
            .await
            .expect("workspace callback");
        callbacks
            .rollback_provider("thread", 1, "rewind-key")
            .await
            .expect("rollback callback");
        callbacks
            .refresh_workspace(parent.path())
            .await
            .expect("refresh callback");
        let repositories = Repositories::new(database.clone());
        repositories
            .upsert_project(ProjectionProject {
                project_id: "malformed".to_owned(),
                title: "Malformed".to_owned(),
                workspace_root: parent
                    .path()
                    .join("malformed")
                    .to_string_lossy()
                    .into_owned(),
                default_model_selection: None,
                scripts: json!({"not":"an array"}),
                worktree_discovery: json!({"visibility":"hidden","initialPromptDismissedAt":null,"baselinePaths":[]}),
                worktree_repository_key: None,
                created_at: "2026-07-16T00:00:00Z".to_owned(),
                updated_at: "2026-07-16T00:00:00Z".to_owned(),
                deleted_at: None,
                repository_identity: None,
            })
            .await
            .expect("malformed project fixture");
        repositories
            .upsert_project(ProjectionProject {
                project_id: "empty".to_owned(),
                title: "Empty".to_owned(),
                workspace_root: parent.path().join("empty").to_string_lossy().into_owned(),
                default_model_selection: None,
                scripts: json!([]),
                worktree_discovery: json!({"visibility":"hidden","initialPromptDismissedAt":null,"baselinePaths":[]}),
                worktree_repository_key: None,
                created_at: "2026-07-16T00:00:01Z".to_owned(),
                updated_at: "2026-07-16T00:00:01Z".to_owned(),
                deleted_at: None,
                repository_identity: None,
            })
            .await
            .expect("empty project fixture");
        repositories
            .upsert_project(ProjectionProject {
                project_id: "setup".to_owned(),
                title: "Setup".to_owned(),
                workspace_root: parent.path().join("setup").to_string_lossy().into_owned(),
                default_model_selection: None,
                scripts: json!([{
                    "id":"install",
                    "name":"Install",
                    "command":"vp install",
                    "runOnWorktreeCreate":true
                }]),
                worktree_discovery: json!({"visibility":"hidden","initialPromptDismissedAt":null,"baselinePaths":[]}),
                worktree_repository_key: None,
                created_at: "2026-07-16T00:00:02Z".to_owned(),
                updated_at: "2026-07-16T00:00:02Z".to_owned(),
                deleted_at: None,
                repository_identity: None,
            })
            .await
            .expect("setup project fixture");
        let bootstrap = ProductionBootstrapEffects {
            repositories,
            repository: Arc::new(GitRepository::default()),
            callbacks: callbacks.clone(),
        };
        let bootstrap_cancellation = CancellationToken::new();
        assert!(
            bootstrap
                .prepare_worktree(
                    ThreadTurnStartBootstrapPrepareWorktree {
                        project_cwd: file.to_string_lossy().into_owned(),
                        base_branch: "main".to_owned(),
                        branch: Some("unit-invalid".to_owned()),
                        start_from_origin: None,
                    },
                    &bootstrap_cancellation
                )
                .await
                .is_err()
        );
        assert!(
            bootstrap_process_error(ProcessError::Spawn {
                operation: "unit".to_owned(),
                command: "missing".to_owned(),
                source: std::io::Error::new(std::io::ErrorKind::NotFound, "missing"),
            })
            .contains("failed to spawn")
        );
        assert!(
            bootstrap_process_error(ProcessError::NonZeroExit {
                operation: "unit".to_owned(),
                exit_code: 1,
                stdout_length: 6,
                stderr_length: 0,
                stdout: "detail".into(),
                stderr: "".into(),
            })
            .contains("detail")
        );
        assert!(
            bootstrap
                .run_setup_script(BootstrapSetupInput {
                    thread_id: "thread".to_owned(),
                    project_id: None,
                    project_cwd: None,
                    worktree_path: parent.path().to_string_lossy().into_owned(),
                })
                .await
                .is_err()
        );
        assert!(
            bootstrap
                .run_setup_script(BootstrapSetupInput {
                    thread_id: "thread".to_owned(),
                    project_id: Some("malformed".to_owned()),
                    project_cwd: None,
                    worktree_path: parent.path().to_string_lossy().into_owned(),
                })
                .await
                .is_err()
        );
        assert_eq!(
            bootstrap
                .run_setup_script(BootstrapSetupInput {
                    thread_id: "thread".to_owned(),
                    project_id: None,
                    project_cwd: Some(parent.path().join("empty").to_string_lossy().into_owned()),
                    worktree_path: parent.path().to_string_lossy().into_owned(),
                })
                .await
                .expect("empty scripts should be a no-op"),
            BootstrapSetupResult::NoScript
        );
        assert!(
            bootstrap
                .run_setup_script(BootstrapSetupInput {
                    thread_id: "thread".to_owned(),
                    project_id: Some("setup".to_owned()),
                    project_cwd: None,
                    worktree_path: parent.path().to_string_lossy().into_owned(),
                })
                .await
                .expect_err("unavailable setup terminal fails")
                .contains("unavailable")
        );
        database
            .call(|connection| {
                connection.execute("DROP TABLE projection_projects", [])?;
                Ok(())
            })
            .await
            .expect("drop project projection");
        for input in [
            BootstrapSetupInput {
                thread_id: "thread".to_owned(),
                project_id: Some("missing".to_owned()),
                project_cwd: None,
                worktree_path: parent.path().to_string_lossy().into_owned(),
            },
            BootstrapSetupInput {
                thread_id: "thread".to_owned(),
                project_id: None,
                project_cwd: Some("missing".to_owned()),
                worktree_path: parent.path().to_string_lossy().into_owned(),
            },
        ] {
            assert!(bootstrap.run_setup_script(input).await.is_err());
        }
        assert_eq!(callbacks.0.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn setup_script_restart_reuses_the_deterministic_terminal() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        struct SetupCallbacks {
            running: AtomicBool,
            launches: AtomicUsize,
        }

        impl OrchestrationEffectCallbacks for SetupCallbacks {
            fn workspace_for_thread<'a>(
                &'a self,
                _: &'a str,
            ) -> BoxEffectFuture<'a, Option<PathBuf>> {
                Box::pin(async { Ok(None) })
            }

            fn rollback_provider<'a>(
                &'a self,
                _: &'a str,
                _: i64,
                _rewind_key: &'a str,
            ) -> BoxEffectFuture<'a, ProviderRewind> {
                Box::pin(async { Ok(ProviderRewind::Rewound) })
            }

            fn stop_provider<'a>(&'a self, _: &'a str) -> BoxEffectFuture<'a, ()> {
                Box::pin(async { Ok(()) })
            }

            fn close_terminals<'a>(&'a self, _: &'a str) -> BoxEffectFuture<'a, ()> {
                Box::pin(async { Ok(()) })
            }

            fn refresh_workspace<'a>(&'a self, _: &'a Path) -> BoxEffectFuture<'a, ()> {
                Box::pin(async { Ok(()) })
            }

            fn setup_script_is_running<'a>(
                &'a self,
                _thread_id: &'a str,
                terminal_id: &'a str,
            ) -> BoxEffectFuture<'a, bool> {
                assert_eq!(terminal_id, "setup-install");
                Box::pin(async move { Ok(self.running.load(Ordering::SeqCst)) })
            }

            fn launch_setup_script<'a>(
                &'a self,
                input: SetupScriptLaunch,
            ) -> BoxEffectFuture<'a, ()> {
                assert_eq!(input.terminal_id, "setup-install");
                Box::pin(async move {
                    self.launches.fetch_add(1, Ordering::SeqCst);
                    self.running.store(true, Ordering::SeqCst);
                    Ok(())
                })
            }
        }

        let database = Database::open_in_memory().await.expect("database");
        database
            .call(|connection| {
                run_migrations(connection, None)?;
                Ok(())
            })
            .await
            .expect("migrations");
        let repositories = Repositories::new(database);
        repositories
            .upsert_project(ProjectionProject {
                project_id: "setup-project".to_owned(),
                title: "Setup".to_owned(),
                workspace_root: "C:/repo".to_owned(),
                default_model_selection: None,
                scripts: json!([{
                    "id":"install",
                    "name":"Install",
                    "command":"vp install",
                    "runOnWorktreeCreate":true
                }]),
                worktree_discovery: json!({"visibility":"hidden","initialPromptDismissedAt":null,"baselinePaths":[]}),
                worktree_repository_key: None,
                created_at: "2026-08-01T00:00:00Z".to_owned(),
                updated_at: "2026-08-01T00:00:00Z".to_owned(),
                deleted_at: None,
                repository_identity: None,
            })
            .await
            .expect("project");
        let callbacks = Arc::new(SetupCallbacks {
            running: AtomicBool::new(false),
            launches: AtomicUsize::new(0),
        });
        let bootstrap = ProductionBootstrapEffects {
            repositories,
            repository: Arc::new(GitRepository::default()),
            callbacks: callbacks.clone(),
        };
        let input = BootstrapSetupInput {
            thread_id: "thread".to_owned(),
            project_id: Some("setup-project".to_owned()),
            project_cwd: None,
            worktree_path: "C:/repo/.worktrees/setup".to_owned(),
        };

        let first = bootstrap
            .run_setup_script(input.clone())
            .await
            .expect("first launch");
        let restarted = bootstrap
            .run_setup_script(input)
            .await
            .expect("restart lookup");

        assert_eq!(first, restarted);
        assert_eq!(callbacks.launches.load(Ordering::SeqCst), 1);
    }
}
