use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
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
        BoxBootstrapFuture, BoxProjectCommandFuture, CheckoutRestore, OrchestrationCommand,
        OrchestrationEngine,
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

    /// What a file restore asks about the other chats in its checkout (#279). `None` (the
    /// default) treats every other chat as having no live provider session.
    fn revert_probe(&self) -> Option<Box<dyn RevertProbe + '_>> {
        None
    }
}

/// Why another chat in a shared checkout keeps a file restore from running (#279).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WritingReason {
    /// Its session is running a turn.
    Turn,
    /// Its turn delivery or compaction is admitted and about to start a turn.
    StartingTurn,
    BackgroundWork,
    /// Its last turn's checkpoint is still being recorded.
    CheckpointPending,
    /// BiBCode can't see its work: Cursor, Grok, or Chat Activity off.
    Unobservable,
    /// It runs on an OpenCode server BiBCode doesn't manage.
    UnmanagedServer,
    StartingSession,
    /// Its folder's Git checkout could not be resolved.
    UnresolvableCheckout,
}

impl WritingReason {
    /// The refusal a file restore records, naming the other chat by `title`.
    pub fn detail(self, title: &str) -> String {
        match self {
            Self::Turn => format!(
                "Another chat in this checkout ({title}) is running a turn. Stop it or wait for it to finish, then revert, or rewind only the conversation."
            ),
            Self::StartingTurn => format!(
                "Another chat in this checkout ({title}) is starting a turn. Try the revert again in a moment, or rewind only the conversation."
            ),
            Self::BackgroundWork => format!(
                "Another chat in this checkout ({title}) is running background work. Stop it or wait for it to finish, then revert, or rewind only the conversation."
            ),
            Self::CheckpointPending => format!(
                "Another chat in this checkout ({title}) is still saving its checkpoint. Try the revert again in a moment, or rewind only the conversation."
            ),
            Self::Unobservable => format!(
                "BiBCode can't tell whether {title} is still working. Stop its session, then revert, or rewind only the conversation."
            ),
            Self::UnmanagedServer => format!(
                "{title} runs on an OpenCode server BiBCode doesn't manage, so BiBCode can't make sure it has stopped working in this checkout. Rewind only the conversation instead."
            ),
            Self::StartingSession => {
                "Another chat in this checkout is starting its session. Try the revert again in a moment.".to_owned()
            }
            Self::UnresolvableCheckout => format!(
                "BiBCode can't tell whether {title} works in this checkout. Try the revert again, or check that chat's folder."
            ),
        }
    }
}

/// Whether a thread's provider can rewind its conversation and leave the files alone.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConversationRewind {
    Available,
    /// The provider cannot rewind its conversation at all (Claude, Cursor, Grok).
    FilesOnlyProvider { provider_label: String },
    /// The provider's rewind also restores files (OpenCode 1).
    RewindRestoresFiles { provider_label: String },
}

impl ConversationRewind {
    fn wire(&self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::FilesOnlyProvider { .. } => "filesOnlyProvider",
            Self::RewindRestoresFiles { .. } => "rewindRestoresFiles",
        }
    }

    /// Why a conversation-only rewind is refused, if it is.
    fn refusal(&self) -> Option<String> {
        match self {
            Self::Available => None,
            Self::FilesOnlyProvider { provider_label } => Some(format!(
                "{provider_label} can't rewind its conversation, so only a file restore is possible."
            )),
            Self::RewindRestoresFiles { provider_label } => Some(format!(
                "{provider_label} can't rewind its conversation without restoring files. Revert files and conversation instead."
            )),
        }
    }
}

/// The provider side of the shared-checkout guard (#279), answered by the supervisor.
pub trait RevertProbe: Send + Sync {
    /// Whether the thread's live provider session writes in its checkout now; `None` when it
    /// does not, or has no live session.
    fn thread_writes_checkout<'a>(
        &'a self,
        thread_id: &'a str,
    ) -> BoxEffectFuture<'a, Option<WritingReason>>;

    /// Makes the thread quiet for a restore: suspends its live, idle session. `Some` names why
    /// it cannot be made quiet, and nothing is suspended then.
    fn quiet_sibling<'a>(&'a self, thread_id: &'a str)
    -> BoxEffectFuture<'a, Option<WritingReason>>;

    /// Whether the thread's provider can rewind its conversation and keep the files. Answered
    /// from the live session once `prepare_provider_rewind` reopened it.
    fn conversation_rewind<'a>(&'a self, thread_id: &'a str)
    -> BoxEffectFuture<'a, ConversationRewind>;
}

#[derive(Clone, Copy, Debug)]
pub struct EffectsOptions {
    pub queue_capacity: usize,
    /// How long an ended turn holds its thread's turn deliveries for its checkpoint. A capture
    /// still pending then is given up as stale, so a hung Git never holds a thread for good.
    pub checkpoint_hold_limit: Duration,
    /// How long a file restore waits for the turns admitted to its checkout to reach their
    /// providers before it gives up, with nothing changed (#279).
    pub checkout_restore_admission_wait: Duration,
}

impl Default for EffectsOptions {
    fn default() -> Self {
        Self {
            queue_capacity: 64,
            checkpoint_hold_limit: CHECKPOINT_HOLD_LIMIT,
            checkout_restore_admission_wait: CHECKOUT_RESTORE_ADMISSION_WAIT,
        }
    }
}

/// Mauro's cap (#279): long enough for a delivery in flight to reach its provider.
const CHECKOUT_RESTORE_ADMISSION_WAIT: Duration = Duration::from_secs(15);

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
    /// A file restore refused until the caller acknowledges what other chats changed in the
    /// checkout with this token (#279).
    #[error("orchestration effect failed: {detail}")]
    Refused {
        detail: String,
        sibling_changes_token: String,
    },
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
    #[cfg(test)]
    test_hooks: crate::orchestration::engine::TestHooks,
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

    fn capture_first_turn_baseline<'a>(
        &'a self,
        thread_id: &'a str,
        message_id: &'a str,
        limit: Duration,
        cancellation: &'a CancellationToken,
    ) -> BoxBootstrapFuture<'a, Option<String>> {
        Box::pin(async move {
            #[cfg(test)]
            let probe_gate = self.test_hooks.checkout_probe_gate();
            #[cfg(not(test))]
            let probe_gate = None;
            ensure_first_turn_baseline(
                &self.repositories,
                self.callbacks.as_ref(),
                thread_id,
                message_id,
                limit,
                cancellation,
                probe_gate,
            )
            .await
        })
    }
}

/// The bootstrap's `fetch origin`, then the commit of `base_branch` on `origin`. Public only
/// for `tests/git_system_config.rs`.
#[doc(hidden)]
pub async fn fetch_origin_base(
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
                // No credential window or prompt: the fetch uses a stored credential or fails.
                env: crate::git::git_environment(),
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
            #[cfg(test)]
            test_hooks: engine.test_hooks(),
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
            options.checkout_restore_admission_wait,
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

    /// Captures a thread's first-turn baseline (ref 0) as turn delivery does before it first
    /// claims that turn, for a caller that hands the turn to its provider itself.
    pub async fn capture_first_turn_baseline(&self, thread_id: &str, message_id: &str) {
        let _ = crate::production::turn_delivery::capture_first_turn_baseline(
            &self.engine,
            thread_id,
            message_id,
            &self.cancellation,
        )
        .await;
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
            // A compaction can reopen a suspended session, which could start a turn of its own,
            // so it is admitted to the checkout like a delivery (#279).
            let admission = tokio::select! {
                admission = admit_thread_turn(&engine, &thread_id) => admission,
                () = cancellation.cancelled() => return,
            };
            let result = match admission {
                Some(_) => {
                    callbacks
                        .compact_provider(&compaction_id, &cancellation)
                        .await
                }
                None => Err(crate::orchestration::engine::RESTORING_FILES_DETAIL.to_owned()),
            };
            drop(admission);
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

    /// Rewinds and restores a planned revert, then releases its thread and its checkout, and
    /// wakes delivery.
    async fn revert(
        &self,
        event: &OrchestrationEvent,
        (reservation, restore, plan): PreparedRevert,
    ) {
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
        drop(restore);
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
            let token = match &error {
                OrchestrationEffectsError::Refused {
                    sibling_changes_token,
                    ..
                } => Some(sibling_changes_token.as_str()),
                _ => None,
            };
            append_failure_activity(&self.engine, event, &error.to_string(), token).await;
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

/// A revert whose thread is reserved for it, with its checks done and its provider ready. A
/// file restore also holds its checkout (#279).
type PreparedRevert = (
    ThreadTurnReservation,
    Option<CheckoutRestore>,
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
    /// Per checkout key, the `done` of its latest file restore, which the next one waits for.
    tails: HashMap<String, oneshot::Receiver<()>>,
    /// How long a file restore waits for its checkout's admitted turns.
    restore_wait: Duration,
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

    /// Places a file restore after the earlier restores of its checkout, by its physical key.
    /// A revert whose checkout cannot be resolved here waits for nobody; its preparation
    /// resolves the checkout again. A conversation-only rewind writes no file and takes no place.
    async fn order(
        &mut self,
        context: &EffectContext,
        event: &OrchestrationEvent,
    ) -> Option<OrderedRevert> {
        if event.event.event_type != "thread.checkpoint-revert-requested" {
            return None;
        }
        let thread_id = event_thread_id(event)?.to_owned();
        let checkout = if is_revert_conversation_only(event) {
            None
        } else {
            revert_gate_key(
                &context.engine,
                context.callbacks.as_ref(),
                &thread_id,
                &context.cancellation,
            )
            .await
        };
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
        let (engine, callbacks, cancellation, preparations, ready, restore_wait) = (
            context.engine.clone(),
            context.callbacks.clone(),
            context.cancellation.clone(),
            self.preparations.clone(),
            self.ready.clone(),
            self.restore_wait,
        );
        self.waiters.spawn(async move {
            let prepared = tokio::select! {
                prepared = async {
                    // Taken first, so a turn sent after the revert does not start ahead of it.
                    let reservation = engine.reserve_thread_turns(&thread_id).await;
                    // The checkout's previous restore finishes before this one takes the
                    // checkout, which that one releases before its `done`.
                    if let Some(previous) = previous {
                        let _ = previous.await;
                    }
                    // A file restore holds its checkout from its planning until it is recorded,
                    // so no turn of another chat there starts meanwhile (#279).
                    let mut restore = None;
                    let mut refused = None;
                    if !is_revert_conversation_only(&event)
                        && let Some(key) =
                            revert_gate_key(&engine, callbacks.as_ref(), &thread_id, &cancellation)
                                .await
                    {
                        match tokio::time::timeout(
                            restore_wait,
                            engine.hold_checkout_for_restore(&key),
                        )
                        .await
                        {
                            Ok(held) => restore = Some(held),
                            Err(_) => {
                                tracing::warn!(
                                    %thread_id,
                                    "a file restore gave up waiting for the turns admitted to its checkout"
                                );
                                refused = Some(OrchestrationEffectsError::Effect(
                                    CHECKOUT_RESTORE_WAIT_DETAIL.to_owned(),
                                ));
                            }
                        }
                    }
                    let plan = match refused {
                        Some(error) => Err(error),
                        None => {
                            // The semaphore is never closed.
                            let _permit = preparations.acquire().await.ok();
                            plan_revert(
                                &engine,
                                callbacks.as_ref(),
                                &event,
                                restore.as_mut(),
                                &cancellation,
                            )
                            .await
                        }
                    };
                    (reservation, restore, plan)
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
    restore_wait: Duration,
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
        restore_wait,
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
    resolve_thread_workspace(&engine.repositories(), callbacks, thread_id).await
}

async fn resolve_thread_workspace(
    repositories: &crate::persistence::Repositories,
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
    Ok(stored_thread_checkout(repositories, thread_id).await?)
}

/// The directory a thread's Git commands run in, as stored: its worktree, or its project's root.
pub(crate) async fn stored_thread_checkout(
    repositories: &crate::persistence::Repositories,
    thread_id: &str,
) -> Result<Option<PathBuf>, PersistenceError> {
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

/// Captures `thread_id`'s ref 0 before its first turn, the one `message_id` starts, is first
/// claimed (#261). Turn delivery calls it and claims the turn only after it returns, so ref 0
/// is the checkout before that turn: delivery is the only writer of ref 0, and every Git
/// command whose output ref 0 holds has finished before the claim. Only `update-ref` can
/// outlive a timeout (a stalled Windows spawn), and it publishes a commit fixed before the
/// claim.
///
/// Every await is bounded by `limit`, then given up: `Ok(Some(reason))` for a failure or a
/// timeout, which the caller reports; `Ok(None)` when it is captured or not needed; `Err` only
/// when `cancellation` fires, leaving the turn to try again.
pub(crate) async fn ensure_first_turn_baseline(
    repositories: &crate::persistence::Repositories,
    callbacks: &dyn OrchestrationEffectCallbacks,
    thread_id: &str,
    message_id: &str,
    limit: Duration,
    cancellation: &CancellationToken,
    probe_gate: Option<Arc<tokio::sync::Notify>>,
) -> Result<Option<String>, String> {
    let started = std::time::Instant::now();
    let bounded = cancellation.child_token();
    let steps = first_turn_baseline_steps(
        repositories,
        callbacks,
        thread_id,
        message_id,
        &bounded,
        probe_gate,
    );
    tokio::pin!(steps);
    let mut timed_out = false;
    let result = tokio::select! {
        result = &mut steps => result,
        () = tokio::time::sleep(limit) => {
            timed_out = true;
            bounded.cancel();
            // Cancelled steps stop their Git children and wait for them, and their cleanup is
            // bounded too; past this grace they are dropped, which still kills the children.
            match tokio::time::timeout(CANCELLED_BASELINE_GRACE, steps).await {
                Ok(result) => result,
                Err(_) => {
                    tracing::warn!(
                        thread_id,
                        "a first turn's cancelled checkpoint baseline did not stop in time; it is dropped"
                    );
                    Err(OrchestrationEffectsError::Effect("timed out".to_owned()))
                }
            }
        }
    };
    if cancellation.is_cancelled() {
        return Err("the first turn's checkpoint baseline was cancelled".to_owned());
    }
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match result {
        Ok(captured) => {
            if captured {
                tracing::debug!(
                    thread_id,
                    elapsed_ms,
                    "first turn checkpoint baseline captured"
                );
            }
            Ok(None)
        }
        Err(error) => {
            let reason = if timed_out {
                format!("timed out after {}", describe_limit(limit))
            } else {
                crate::diagnostics::redact_sensitive_text(&error.to_string())
            };
            tracing::warn!(
                thread_id,
                elapsed_ms,
                error = %reason,
                "a first turn's checkpoint baseline was not captured; the turn goes on without one"
            );
            Ok(Some(reason))
        }
    }
}

/// How long cancelled baseline steps may take to stop their Git children and clean up.
const CANCELLED_BASELINE_GRACE: Duration = Duration::from_secs(10);
/// How long a capture waits to remove its temporary index; past this, the removal is left to
/// finish on its own (a stalled network filesystem) and logged, so no capture waits on it.
const TEMPORARY_INDEX_REMOVAL_LIMIT: Duration = Duration::from_secs(5);

/// Removes a capture's temporary index within `TEMPORARY_INDEX_REMOVAL_LIMIT`.
async fn remove_temporary_index(path: PathBuf) {
    #[cfg(test)]
    let gate = temporary_index_removal_gate(&path);
    let removal = async move {
        #[cfg(test)]
        if let Some(gate) = gate {
            gate.notified().await;
        }
        tokio::fs::remove_file(path).await
    };
    if tokio::time::timeout(TEMPORARY_INDEX_REMOVAL_LIMIT, removal)
        .await
        .is_err()
    {
        tracing::warn!(
            "a checkpoint's temporary index was not removed in time; it is left to finish on its own"
        );
    }
}

/// Test gates that hold the removal of temporary indexes under a Git directory.
#[cfg(test)]
static TEMPORARY_INDEX_REMOVAL_GATES: std::sync::Mutex<Vec<(PathBuf, Arc<tokio::sync::Notify>)>> =
    std::sync::Mutex::new(Vec::new());

/// Holds the removal of every temporary index under `git_dir` until the gate is notified.
#[cfg(test)]
pub(crate) fn hold_temporary_index_removal(git_dir: &Path) -> Arc<tokio::sync::Notify> {
    let gate = Arc::new(tokio::sync::Notify::new());
    TEMPORARY_INDEX_REMOVAL_GATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push((git_dir.to_path_buf(), gate.clone()));
    gate
}

#[cfg(test)]
fn temporary_index_removal_gate(path: &Path) -> Option<Arc<tokio::sync::Notify>> {
    let canonical =
        |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = path.parent().map(canonical)?;
    TEMPORARY_INDEX_REMOVAL_GATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .find(|(git_dir, _)| canonical(git_dir) == parent)
        .map(|(_, gate)| gate.clone())
}

fn describe_limit(limit: Duration) -> String {
    if limit >= Duration::from_secs(1) {
        format!("{} seconds", limit.as_secs())
    } else {
        format!("{} ms", limit.as_millis())
    }
}

/// Whether a turn of the thread other than the one `message_id` starts has a checkpoint number:
/// the thread then has its checkpoints, and its first turn's baseline is long settled.
pub(crate) fn an_earlier_turn_is_numbered(
    turns: &[crate::persistence::ProjectionTurn],
    message_id: &str,
) -> bool {
    turns.iter().any(|turn| {
        turn.pending_message_id.as_deref() != Some(message_id)
            && turn.checkpoint_turn_count.is_some_and(|count| count >= 1)
    })
}

/// Resolves the token's cancellation as an effect error, for awaits that do not watch it.
async fn until_cancelled<T>(
    cancellation: &CancellationToken,
    future: impl Future<Output = T>,
) -> Result<T, OrchestrationEffectsError> {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => Err(OrchestrationEffectsError::Effect(
            "the first turn's checkpoint baseline was given up".to_owned(),
        )),
        value = future => Ok(value),
    }
}

/// Returns whether ref 0 was captured.
async fn first_turn_baseline_steps(
    repositories: &crate::persistence::Repositories,
    callbacks: &dyn OrchestrationEffectCallbacks,
    thread_id: &str,
    message_id: &str,
    cancellation: &CancellationToken,
    probe_gate: Option<Arc<tokio::sync::Notify>>,
) -> Result<bool, OrchestrationEffectsError> {
    let turns = until_cancelled(
        cancellation,
        repositories.list_turns_by_thread(thread_id.to_owned()),
    )
    .await??;
    // A baseline writes ref 0 only. Ref `n >= 1` is turn `n`'s end state, written only by that
    // turn's own capture while its hold keeps later turns out.
    if an_earlier_turn_is_numbered(&turns, message_id)
        || is_side_chat(repositories, thread_id, cancellation).await?
    {
        return Ok(false);
    }
    let Some(cwd) = until_cancelled(
        cancellation,
        resolve_thread_workspace(repositories, callbacks, thread_id),
    )
    .await??
    else {
        return Ok(false);
    };
    // The walk cannot be interrupted, but it only reads: a cancelled one is left to finish.
    let probe = async {
        if let Some(gate) = probe_gate {
            gate.notified().await;
        }
        in_git_checkout(Some(&cwd)).await
    };
    if !until_cancelled(cancellation, probe).await? {
        return Ok(false);
    }
    if !is_git_repository(&cwd, Path::new("git"), cancellation).await? {
        return Ok(false);
    }
    let reference = checkpoint_ref(thread_id, 0);
    if had_turns_before_checkpoints(&turns, Some(message_id))
        || !has_ref(&cwd, Path::new("git"), &reference, cancellation).await?
    {
        capture_checkpoint_with_cancellation(&cwd, Path::new("git"), thread_id, 0, cancellation)
            .await?;
        return Ok(true);
    }
    Ok(false)
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

/// Releases a turn's checkpoint hold when dropped, unless the hold expired: the expiry's task
/// then releases it after its own record, so no record of the turn lands after the release.
struct CheckpointHoldRelease<'a> {
    engine: &'a OrchestrationEngine,
    thread_id: &'a str,
    turn_id: &'a str,
}

impl Drop for CheckpointHoldRelease<'_> {
    fn drop(&mut self) {
        self.engine
            .release_checkpoint_hold_unless_stale(self.thread_id, self.turn_id);
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
    // A side chat shares its host's checkout and keeps no checkpoints, so it can never
    // restore over the host's work (#265).
    if repositories
        .get_thread(thread_id.to_owned())
        .await?
        .is_some_and(|thread| thread.side_chat)
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
    let recorded = dispatch_turn_checkpoint(engine, &checkpoint, "missing", Vec::new(), true).await;
    match (&recorded, hold) {
        (Err(_), Some(_)) => engine.release_checkpoint_hold(thread_id, turn_id),
        (Ok(()), Some(id)) => expire_stale_hold(engine, &checkpoint, id),
        _ => {}
    }
    recorded
}

/// Whether `thread_id` is a side chat, which captures no checkpoints (#265).
async fn is_side_chat(
    repositories: &crate::persistence::Repositories,
    thread_id: &str,
    cancellation: &CancellationToken,
) -> Result<bool, OrchestrationEffectsError> {
    Ok(
        until_cancelled(cancellation, repositories.get_thread(thread_id.to_owned()))
            .await??
            .is_some_and(|thread| thread.side_chat),
    )
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
/// the turn's checkpoint is marked stale (never recorded `ready`), one attempt records it
/// `error`, the stale record is logged and shown, and the thread's turns go. A hung Git therefore
/// never holds a thread for good, and a failing database does not either: a turn left `missing`
/// is neither a revert target nor a diff baseline, and no baseline writes its ref.
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
        // Recorded `error` (which no capture overwrites) before the thread's turns go, so the
        // record lands before any revert. Once: if it fails, the row stays `missing`, which is
        // just as safe, and the activity below still shows the stale capture.
        let checkpoint = TurnCheckpoint {
            thread_id: &thread_id,
            turn_id: &turn_id,
            turn_count,
            assistant_message_id: None,
            completed_at: &completed_at,
        };
        if let Err(error) =
            dispatch_turn_checkpoint(&engine, &checkpoint, "error", Vec::new(), true).await
        {
            tracing::warn!(%thread_id, turn_count, %error, "a stale turn checkpoint could not be recorded; it stays missing");
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
/// files changed since the turn before it, or without a diff when that turn's checkpoint is not
/// a trusted baseline.
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
    // this turn's end state. The hold keeps every later turn behind this capture. A capture that
    // fails tries to take such a leftover away; one left behind is harmless, because a `missing`
    // row's ref is never a baseline and no baseline writes a numbered ref.
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

    // `ready` means the turn's end state is captured, so it can be reverted to. Its diff also
    // needs a trusted baseline: ref 0, or the ref of a `ready` turn before it, which only that
    // turn's own capture wrote while its hold kept every later turn out. The ref of a `missing`
    // or `error` turn (absent, a leftover, or written from a later checkout) never is one, and
    // neither is a ref that is gone: the turn is then recorded without a diff.
    let from_ref = checkpoint_ref(thread_id, turn_count.saturating_sub(1));
    let previous_ready = turn_count <= 1
        || engine
            .repositories()
            .get_checkpoint(thread_id.to_owned(), turn_count - 1)
            .await?
            .is_some_and(|previous| previous.status == "ready");
    let diff_available =
        previous_ready && has_ref(cwd, Path::new("git"), &from_ref, cancellation).await?;
    let files = if diff_available {
        diff_file_summaries(cwd, Path::new("git"), &from_ref, &target_ref, cancellation).await?
    } else {
        Vec::new()
    };
    dispatch_turn_checkpoint(engine, checkpoint, "ready", files, diff_available).await?;
    let (tone, payload) = if diff_available {
        ("info", json!({"turnCount":turn_count,"status":"ready"}))
    } else {
        (
            "warning",
            json!({
                "turnCount": turn_count,
                "status": "ready",
                "diffAvailable": false,
                "detail": format!("The checkpoint before turn {turn_count} is missing, so this turn's changes cannot be shown. You can still revert to it."),
            }),
        )
    };
    engine
        .dispatch(OrchestrationCommand::ThreadActivityAppend {
            command_id: server_id("checkpoint-captured-activity"),
            thread_id: thread_id.to_owned(),
            activity: ActivityInput {
                id: Uuid::new_v4().to_string(),
                tone: tone.to_owned(),
                kind: "checkpoint.captured".to_owned(),
                summary: "Checkpoint captured".to_owned(),
                payload,
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
    diff_available: bool,
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
            diff_available,
            assistant_message_id: checkpoint.assistant_message_id.clone(),
            completed_at: checkpoint.completed_at.to_owned(),
            created_at: checkpoint.completed_at.to_owned(),
        })
        .await
        .map(|_| ())
        .map_err(|error| OrchestrationEffectsError::Effect(error.to_string()))
}

/// A checkout's key (#279): its Git worktree's top level, canonicalized the way the workspace
/// availability registry keys paths, with that top level.
#[derive(Clone, Debug)]
pub(crate) struct CheckoutKey {
    pub(crate) key: String,
    top_key: String,
}

/// Resolves the checkout key of `directory` fresh: a project at `/repo` and one at
/// `/repo/subdir` share one, symlinked spellings share one, linked worktrees keep their own.
/// Never cached, because a nested repository removed later changes the answer while no stored
/// path changes. Fails when the directory is gone or Git cannot name its top level.
pub(crate) async fn checkout_key(
    directory: &Path,
    cancellation: &CancellationToken,
) -> Result<CheckoutKey, String> {
    let directory = tokio::fs::canonicalize(directory)
        .await
        .map_err(|error| error.to_string())?;
    let output = run_git(
        &directory,
        Path::new("git"),
        &["rev-parse", "--show-toplevel"],
        &[],
        true,
        cancellation,
    )
    .await
    .map_err(|error| error.to_string())?;
    if output.exit_code != 0 {
        return Err(format!(
            "Git could not name the checkout (exit {}).",
            output.exit_code
        ));
    }
    let top = process_compatible_path(PathBuf::from(output.stdout.trim()));
    let key = crate::git::canonical_worktree_path_key(&top)
        .await
        .map_err(|error| error.to_string())?;
    Ok(CheckoutKey {
        top_key: key.clone(),
        key,
    })
}

/// The key a turn delivery or compaction takes admission under: the checkout key, or for a
/// directory outside Git (or one Git cannot read), the directory's own key. A restore never
/// relies on this alone: it also refuses while any thread it holds has a turn admitted.
async fn admission_key(directory: &Path) -> String {
    if let Ok(key) = checkout_key(directory, &CancellationToken::new()).await {
        return key.key;
    }
    crate::git::canonical_worktree_path_key(directory)
        .await
        .unwrap_or_else(|_| {
            normalize_host_path_lexically(directory)
                .to_string_lossy()
                .into_owned()
        })
}

/// Admits a turn delivery or compaction of `thread_id` to its checkout (#279), after its own
/// thread reservation. Waits while a file restore holds the checkout; `None` when a restore of
/// another chat in the checkout holds this thread.
pub(crate) async fn admit_thread_turn(
    engine: &OrchestrationEngine,
    thread_id: &str,
) -> Option<crate::orchestration::engine::CheckoutTurnAdmission> {
    let key = match stored_thread_checkout(&engine.repositories(), thread_id)
        .await
        .ok()
        .flatten()
    {
        Some(directory) => admission_key(&directory).await,
        None => format!("thread:{thread_id}"),
    };
    engine.admit_checkout_turn(thread_id, &key).await
}

/// The key a full revert of `thread_id` holds its checkout under, if it resolves.
async fn revert_gate_key(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    thread_id: &str,
    cancellation: &CancellationToken,
) -> Option<String> {
    let cwd = resolve_workspace(engine, callbacks, thread_id)
        .await
        .ok()
        .flatten()?;
    checkout_key(&cwd, cancellation)
        .await
        .ok()
        .map(|key| key.key)
}

fn is_revert_conversation_only(event: &OrchestrationEvent) -> bool {
    event.event.payload.get("mode").and_then(Value::as_str) == Some("conversationOnly")
}

/// Why a restore gave up waiting for the turns admitted to its checkout.
const CHECKOUT_RESTORE_WAIT_DETAIL: &str =
    "Another chat in this checkout is starting a turn. Try the revert again in a moment.";

/// Another thread whose checkout has the restoring thread's key.
#[derive(Clone, Debug)]
struct Sibling {
    thread_id: String,
    title: String,
}

/// The other threads of a checkout, in every project.
#[derive(Default)]
struct SiblingScan {
    siblings: Vec<Sibling>,
    /// Threads inside the checkout's folder whose own checkout could not be resolved; a restore
    /// treats them as sharing it and refuses.
    unresolvable: Vec<Sibling>,
    /// Deleted threads that shared the checkout, whose turns still count as outside changes.
    deleted: Vec<String>,
}

/// Lists the other threads of `own`'s checkout. Only a thread whose stored folder lies inside
/// the checkout's top level can resolve to it, so threads elsewhere cost one path lookup and
/// no Git call.
async fn checkout_siblings(
    engine: &OrchestrationEngine,
    thread_id: &str,
    own: &CheckoutKey,
    cancellation: &CancellationToken,
) -> Result<SiblingScan, OrchestrationEffectsError> {
    let mut scan = SiblingScan::default();
    for thread in engine.repositories().list_thread_checkouts(true).await? {
        if thread.thread_id == thread_id {
            continue;
        }
        let directory = process_compatible_path(PathBuf::from(&thread.directory));
        let Ok(folder) = crate::git::canonical_worktree_path_key(&directory).await else {
            if !thread.deleted {
                scan.unresolvable.push(Sibling {
                    thread_id: thread.thread_id,
                    title: thread.title,
                });
            }
            continue;
        };
        let inside = folder == own.top_key
            || folder.starts_with(&format!("{}/", own.top_key))
            || folder.starts_with(&format!("{}\\", own.top_key));
        if !inside {
            continue;
        }
        match checkout_key(&directory, cancellation).await {
            Ok(key) if key.key == own.key => {
                if thread.deleted {
                    scan.deleted.push(thread.thread_id);
                } else {
                    scan.siblings.push(Sibling {
                        thread_id: thread.thread_id,
                        title: thread.title,
                    });
                }
            }
            Ok(_) => {}
            Err(_) if thread.deleted => {}
            Err(_) => scan.unresolvable.push(Sibling {
                thread_id: thread.thread_id,
                title: thread.title,
            }),
        }
    }
    Ok(scan)
}

/// Whether the sibling writes in the checkout now. With `quiet`, a live idle session of its is
/// suspended, so only a message (which delivery holds) can start it again.
async fn sibling_writing(
    engine: &OrchestrationEngine,
    probe: Option<&dyn RevertProbe>,
    thread_id: &str,
    quiet: bool,
) -> Result<Option<WritingReason>, OrchestrationEffectsError> {
    if engine.thread_session_launching(thread_id) {
        return Ok(Some(WritingReason::StartingSession));
    }
    if engine.thread_turn_admitted(thread_id) {
        return Ok(Some(WritingReason::StartingTurn));
    }
    if engine.turns_held_for_checkpoint(thread_id) {
        return Ok(Some(WritingReason::CheckpointPending));
    }
    if engine
        .repositories()
        .get_thread_session(thread_id.to_owned())
        .await?
        .is_some_and(|session| super::provider_runtime::session_holds_a_turn(&session))
    {
        return Ok(Some(WritingReason::Turn));
    }
    let Some(probe) = probe else {
        return Ok(None);
    };
    Ok(if quiet {
        probe.quiet_sibling(thread_id).await
    } else {
        probe.thread_writes_checkout(thread_id).await
    }
    .map_err(OrchestrationEffectsError::Effect)?)
}

/// Refuses the restore while a sibling writes; with `quiet`, makes every sibling quiet.
async fn refuse_writing_siblings(
    engine: &OrchestrationEngine,
    probe: Option<&dyn RevertProbe>,
    thread_id: &str,
    siblings: &[Sibling],
    quiet: bool,
) -> Result<(), OrchestrationEffectsError> {
    for sibling in siblings {
        if let Some(reason) = sibling_writing(engine, probe, &sibling.thread_id, quiet).await? {
            tracing::warn!(
                thread_id,
                sibling_thread_id = %sibling.thread_id,
                ?reason,
                "a file restore was refused: another chat in its checkout is writing"
            );
            return Err(OrchestrationEffectsError::Effect(
                reason.detail(&sibling.title),
            ));
        }
    }
    Ok(())
}

/// What a file restore of a shared checkout changes, and what other chats changed (#279).
struct SiblingChanges {
    /// Every path the restore rewrites or deletes.
    restored_paths: Vec<String>,
    /// Paths changed since this thread's last checkpoint, so by someone else.
    changed_since_last_turn: Vec<String>,
    /// Sibling turns between the target and this thread's last checkpoint, from the event log.
    turns: Vec<Value>,
    event_ids: Vec<String>,
    target_commit: String,
    /// The tree of every tracked and untracked, non-ignored file now.
    current_tree: String,
    /// Where the current tree's temporary index starts from.
    tree_start: Option<String>,
}

impl SiblingChanges {
    fn token(&self) -> String {
        sibling_changes_token(&self.target_commit, &self.current_tree, &self.event_ids)
    }

    fn outside_changes(&self) -> bool {
        !self.changed_since_last_turn.is_empty() || !self.turns.is_empty()
    }
}

/// The hex SHA-256 of the target commit, the current tree and the sorted sibling event ids, so
/// any byte changed in the checkout, or any sibling turn, gives a new token.
fn sibling_changes_token(target_commit: &str, current_tree: &str, event_ids: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(target_commit.as_bytes());
    hasher.update(b"\n");
    hasher.update(current_tree.as_bytes());
    for id in event_ids {
        hasher.update(b"\n");
        hasher.update(id.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Reads the restore's changes from Git and the append-only event log, which no sibling
/// rewind or deletion removes.
#[allow(clippy::too_many_arguments)]
async fn sibling_changes(
    engine: &OrchestrationEngine,
    cwd: &Path,
    thread_id: &str,
    turn_count: i64,
    target_revision: &str,
    checkpoints: &[crate::persistence::ProjectionCheckpoint],
    scan: &SiblingScan,
    cancellation: &CancellationToken,
) -> Result<SiblingChanges, OrchestrationEffectsError> {
    let git = Path::new("git");
    let newest = checkpoints
        .iter()
        .filter(|checkpoint| checkpoint.status == "ready")
        .max_by_key(|checkpoint| checkpoint.checkpoint_turn_count);
    let mut tree_start = None;
    if let Some(newest) = newest
        && has_ref(cwd, git, &newest.checkpoint_ref, cancellation).await?
    {
        tree_start = Some(newest.checkpoint_ref.clone());
    }
    let current_tree = current_tree(cwd, git, tree_start.as_deref(), cancellation).await?;
    let target_commit = run_git(
        cwd,
        git,
        &[
            "rev-parse",
            "--verify",
            &format!("{target_revision}^{{commit}}"),
        ],
        &[],
        false,
        cancellation,
    )
    .await?
    .stdout
    .trim()
    .to_owned();
    let restored_paths = changed_paths(cwd, git, &target_commit, &current_tree, cancellation).await?;
    let changed_since_last_turn = match &tree_start {
        Some(start) => changed_paths(cwd, git, start, &current_tree, cancellation).await?,
        None => Vec::new(),
    };
    // The target's time: its checkpoint's, or for turn 0 when turn 1 was asked for.
    let since = if turn_count == 0 {
        engine
            .repositories()
            .list_turns_by_thread(thread_id.to_owned())
            .await?
            .into_iter()
            .find(|turn| turn.checkpoint_turn_count == Some(1))
            .map(|turn| turn.started_at.unwrap_or(turn.requested_at))
            .unwrap_or_default()
    } else {
        checkpoints
            .iter()
            .find(|checkpoint| checkpoint.checkpoint_turn_count == turn_count)
            .map(|checkpoint| checkpoint.completed_at.clone())
            .unwrap_or_default()
    };
    let until = newest.map_or_else(now_iso, |checkpoint| checkpoint.completed_at.clone());
    let titles = scan
        .siblings
        .iter()
        .map(|sibling| (sibling.thread_id.clone(), sibling.title.clone()))
        .collect::<HashMap<_, _>>();
    let thread_ids = scan
        .siblings
        .iter()
        .map(|sibling| sibling.thread_id.clone())
        .chain(scan.deleted.iter().cloned())
        .collect::<Vec<_>>();
    let events = engine
        .repositories()
        .list_turn_events_between(thread_ids, since, until)
        .await?;
    let mut event_ids = events
        .iter()
        .map(|event| event.event_id.clone())
        .collect::<Vec<_>>();
    event_ids.sort();
    // Per thread: its turns, and the files they changed when any turn reported them.
    let mut by_thread = BTreeMap::<String, (BTreeSet<String>, Option<BTreeSet<String>>)>::new();
    for event in &events {
        let (turns, files) = by_thread.entry(event.thread_id.clone()).or_default();
        if event.event_type == "thread.turn-diff-completed" {
            if let Some(turn) = event.payload.get("turnId").and_then(Value::as_str) {
                turns.insert(turn.to_owned());
            }
            let files = files.get_or_insert_with(BTreeSet::new);
            for file in event
                .payload
                .get("files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(path) = file.get("path").and_then(Value::as_str) {
                    files.insert(path.to_owned());
                }
            }
        } else if let Some(turn) = event
            .payload
            .pointer("/session/activeTurnId")
            .and_then(Value::as_str)
        {
            turns.insert(turn.to_owned());
        }
    }
    let turns = by_thread
        .into_iter()
        .filter(|(_, (turns, _))| !turns.is_empty())
        .map(|(sibling, (turns, files))| {
            json!({
                "threadId": sibling,
                "title": titles.get(&sibling).cloned().unwrap_or_else(|| "A deleted chat".to_owned()),
                "turns": turns.len(),
                "files": files.map(|files| files.into_iter().collect::<Vec<_>>()),
            })
        })
        .collect();
    Ok(SiblingChanges {
        restored_paths,
        changed_since_last_turn,
        turns,
        event_ids,
        target_commit,
        current_tree,
        tree_start,
    })
}

/// The tree of the checkout's tracked and untracked, non-ignored files now, written through a
/// temporary index as a capture does, starting from `start` so unchanged files are not hashed.
async fn current_tree(
    cwd: &Path,
    git_command: &Path,
    start: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<String, OrchestrationEffectsError> {
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
    let env = checkpoint_environment(&temporary_index);
    let result = async {
        if let Some(start) = start {
            run_git(
                cwd,
                git_command,
                &["read-tree", start],
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
        Ok(
            run_git(cwd, git_command, &["write-tree"], &env, false, cancellation)
                .await?
                .stdout
                .trim()
                .to_owned(),
        )
    }
    .await;
    remove_temporary_index(temporary_index).await;
    result
}

/// The paths that differ between two trees.
async fn changed_paths(
    cwd: &Path,
    git_command: &Path,
    from: &str,
    to: &str,
    cancellation: &CancellationToken,
) -> Result<Vec<String>, OrchestrationEffectsError> {
    let output = run_git(
        cwd,
        git_command,
        &["diff", "--name-only", "--no-renames", "-z", from, to],
        &[],
        false,
        cancellation,
    )
    .await?;
    Ok(output
        .stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect())
}

/// A shared checkout's state a planned file restore checks again before its rewind.
struct SharedRestore {
    siblings: Vec<Sibling>,
    target_commit: String,
    current_tree: String,
    tree_start: Option<String>,
    event_ids: Vec<String>,
}

/// Step 5 of the guard, under the checkout gate: the siblings, their quiet, the `HEAD`
/// fallback and the sibling-change token. Returns the revision to restore and, for a shared
/// checkout, what step 7 checks again.
#[allow(clippy::too_many_arguments)]
async fn plan_shared_restore(
    engine: &OrchestrationEngine,
    probe: Option<&dyn RevertProbe>,
    restore: &mut CheckoutRestore,
    thread_id: &str,
    turn_count: i64,
    cwd: &Path,
    target_ref: &str,
    checkpoints: &[crate::persistence::ProjectionCheckpoint],
    token: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<(bool, Option<SharedRestore>), OrchestrationEffectsError> {
    let own = checkout_key(cwd, cancellation).await.map_err(|error| {
        OrchestrationEffectsError::Effect(format!(
            "BiBCode can't tell which checkout this chat works in, so nothing was restored. {error}"
        ))
    })?;
    let scan = checkout_siblings(engine, thread_id, &own, cancellation).await?;
    if let Some(sibling) = scan.unresolvable.first() {
        tracing::warn!(thread_id, sibling_thread_id = %sibling.thread_id, "a file restore was refused: another chat's checkout could not be resolved");
        return Err(OrchestrationEffectsError::Effect(
            WritingReason::UnresolvableCheckout.detail(&sibling.title),
        ));
    }
    let fallback_to_head = turn_count == 0 && scan.siblings.is_empty();
    let revision = checkpoint_revision(cwd, Path::new("git"), target_ref, fallback_to_head, cancellation).await?;
    if scan.siblings.is_empty() {
        return match revision {
            Some(_) => Ok((fallback_to_head, None)),
            None => Err(missing_checkpoint(turn_count)),
        };
    }
    let Some(revision) = revision else {
        if turn_count == 0 {
            return Err(OrchestrationEffectsError::Effect(
                HEAD_FALLBACK_REFUSED_DETAIL.to_owned(),
            ));
        }
        return Err(missing_checkpoint(turn_count));
    };
    let sibling_ids = scan
        .siblings
        .iter()
        .map(|sibling| sibling.thread_id.clone())
        .collect::<Vec<_>>();
    if let Err(conflict) = restore.hold_threads(&sibling_ids) {
        let (thread, reason) = match conflict {
            crate::orchestration::engine::RestoreHoldConflict::Launching(thread) => {
                (thread, WritingReason::StartingSession)
            }
            crate::orchestration::engine::RestoreHoldConflict::Admitted(thread) => {
                (thread, WritingReason::StartingTurn)
            }
        };
        let title = scan
            .siblings
            .iter()
            .find(|sibling| sibling.thread_id == thread)
            .map_or("another chat", |sibling| sibling.title.as_str());
        tracing::warn!(thread_id, sibling_thread_id = %thread, ?reason, "a file restore was refused: another chat in its checkout is starting");
        return Err(OrchestrationEffectsError::Effect(reason.detail(title)));
    }
    refuse_writing_siblings(engine, probe, thread_id, &scan.siblings, true).await?;
    let changes = sibling_changes(
        engine,
        cwd,
        thread_id,
        turn_count,
        &revision,
        checkpoints,
        &scan,
        cancellation,
    )
    .await?;
    let expected = changes.token();
    let acknowledged = match token {
        Some(token) => token == expected,
        // An older client sends no token; it may restore only what this thread changed.
        None => !changes.outside_changes(),
    };
    if !acknowledged {
        tracing::warn!(thread_id, "a file restore was refused: files changed outside the chat that the request did not acknowledge");
        return Err(OrchestrationEffectsError::Refused {
            detail: format!(
                "Files in this checkout changed since turn {turn_count}, outside this chat. Review them and revert again."
            ),
            sibling_changes_token: expected,
        });
    }
    Ok((
        false,
        Some(SharedRestore {
            siblings: scan.siblings,
            target_commit: changes.target_commit,
            current_tree: changes.current_tree,
            tree_start: changes.tree_start,
            event_ids: changes.event_ids,
        }),
    ))
}

/// Why turn 0's `HEAD` fallback is refused on a shared checkout (Mauro, decision D).
const HEAD_FALLBACK_REFUSED_DETAIL: &str = "This thread has no starting checkpoint, and other chats share this checkout, so restoring files would discard their work. Rewind only the conversation, or revert to a later turn.";

/// Step 7 of the guard, on the worker right before the irreversible rewind: every sibling is
/// still quiet, and no file changed since the plan.
async fn recheck_shared_restore(
    engine: &OrchestrationEngine,
    probe: Option<&dyn RevertProbe>,
    thread_id: &str,
    cwd: &Path,
    shared: &SharedRestore,
    cancellation: &CancellationToken,
) -> Result<(), OrchestrationEffectsError> {
    refuse_writing_siblings(engine, probe, thread_id, &shared.siblings, true).await?;
    let tree = current_tree(cwd, Path::new("git"), shared.tree_start.as_deref(), cancellation).await?;
    if tree != shared.current_tree {
        tracing::warn!(thread_id, "a file restore was refused: files changed after it was confirmed");
        return Err(OrchestrationEffectsError::Refused {
            detail: "Files in this checkout changed after you confirmed. Review them and revert again.".to_owned(),
            sibling_changes_token: sibling_changes_token(
                &shared.target_commit,
                &tree,
                &shared.event_ids,
            ),
        });
    }
    Ok(())
}

/// The checks and target of a revert to `turn_count`, shared by the plan and the preview.
fn revert_target(
    thread_id: &str,
    turn_count: i64,
    checkpoints: &[crate::persistence::ProjectionCheckpoint],
) -> Result<(i64, String), OrchestrationEffectsError> {
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
    if turn_count == 0 {
        return Ok((current_turn_count, checkpoint_ref(thread_id, 0)));
    }
    let target = checkpoints
        .iter()
        .find(|checkpoint| checkpoint.checkpoint_turn_count == turn_count)
        .ok_or_else(|| {
            OrchestrationEffectsError::Effect(format!(
                "Checkpoint ref for turn {turn_count} is unavailable in read model."
            ))
        })?;
    // Only a captured checkpoint is the turn's end state, with or without a diff. A ref of a
    // turn not captured (`missing`) or given up (`error`) may hold a later checkout, so it is
    // never restored.
    if target.status != "ready" {
        return Err(uncaptured_checkpoint(turn_count));
    }
    Ok((current_turn_count, target.checkpoint_ref.clone()))
}

/// What a revert of `thread_id` to `turn_count` would do (`orchestration.previewCheckpointRevert`,
/// #279): the other chats writing in its checkout, every file a restore changes, what other
/// chats changed and the token that acknowledges it, and whether the conversation alone can be
/// rewound. Advisory: the worker repeats every check under the checkout gate.
pub(crate) async fn preview_checkpoint_revert(
    engine: &OrchestrationEngine,
    probe: Option<&dyn RevertProbe>,
    thread_id: &str,
    turn_count: i64,
    cancellation: &CancellationToken,
) -> Result<Value, OrchestrationEffectsError> {
    let cwd = stored_thread_checkout(&engine.repositories(), thread_id)
        .await?
        .ok_or_else(|| OrchestrationEffectsError::Effect("Thread was not found.".to_owned()))?;
    if !is_git_repository(&cwd, Path::new("git"), cancellation).await? {
        return Err(OrchestrationEffectsError::Effect(
            "Checkpoints are unavailable because this project is not a git repository.".to_owned(),
        ));
    }
    let checkpoints = engine
        .repositories()
        .list_checkpoints_by_thread(thread_id.to_owned())
        .await?;
    let (_, target_ref) = revert_target(thread_id, turn_count, &checkpoints)?;
    let own = checkout_key(&cwd, cancellation)
        .await
        .map_err(OrchestrationEffectsError::Effect)?;
    let scan = checkout_siblings(engine, thread_id, &own, cancellation).await?;
    let mut writing = Vec::new();
    for sibling in &scan.unresolvable {
        writing.push(json!({"threadId": sibling.thread_id, "title": sibling.title, "reason": WritingReason::UnresolvableCheckout}));
    }
    for sibling in &scan.siblings {
        if let Some(reason) = sibling_writing(engine, probe, &sibling.thread_id, false).await? {
            writing.push(json!({"threadId": sibling.thread_id, "title": sibling.title, "reason": reason}));
        }
    }
    let shared = !scan.siblings.is_empty() || !scan.unresolvable.is_empty();
    let revision = checkpoint_revision(
        &cwd,
        Path::new("git"),
        &target_ref,
        turn_count == 0 && !shared,
        cancellation,
    )
    .await?;
    let head_fallback_refused = shared && turn_count == 0 && revision.is_none();
    let changes = match (&revision, shared) {
        (Some(revision), true) => Some(
            sibling_changes(
                engine,
                &cwd,
                thread_id,
                turn_count,
                revision,
                &checkpoints,
                &scan,
                cancellation,
            )
            .await?,
        ),
        _ => None,
    };
    let conversation_rewind = match probe {
        Some(probe) => probe
            .conversation_rewind(thread_id)
            .await
            .map_err(OrchestrationEffectsError::Effect)?,
        None => ConversationRewind::Available,
    };
    Ok(json!({
        "writingSiblings": writing,
        "restoredPaths": changes.as_ref().map(|changes| changes.restored_paths.clone()).unwrap_or_default(),
        "siblingChanges": {
            "paths": changes.as_ref().map(|changes| changes.changed_since_last_turn.clone()).unwrap_or_default(),
            "turns": changes.as_ref().map(|changes| changes.turns.clone()).unwrap_or_default(),
        },
        "siblingChangesToken": changes.as_ref().map(SiblingChanges::token),
        "conversationRewind": conversation_rewind.wire(),
        "headFallbackRefused": head_fallback_refused,
    }))
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
    /// Rewinds the conversation and leaves every file as it is.
    conversation_only: bool,
    /// Turn 0 may restore from `HEAD` when ref 0 is gone: only with no other chat in the checkout.
    fallback_to_head: bool,
    /// What step 7 checks again in a checkout other chats share.
    shared: Option<SharedRestore>,
}

/// Checks the revert under its thread's reservation, then lets the provider prepare its rewind
/// (reopening a session suspended while idle). Only reads the checkout, so it can run off the
/// worker. The rewind then finds a live session.
async fn plan_revert(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    event: &OrchestrationEvent,
    restore: Option<&mut CheckoutRestore>,
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
    // Every record of a turn lands before its hold is released, so a record still on its way
    // (a stale turn's expiry writing it) cannot bring back a row this revert deletes.
    if engine.turns_held_for_checkpoint(thread_id) {
        return Err(OrchestrationEffectsError::Effect(
            checkpoint_record_pending_detail(),
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
    let (current_turn_count, target_ref) = revert_target(thread_id, turn_count, &checkpoints)?;
    let conversation_only = is_revert_conversation_only(event);
    // The provider rewind cannot be undone, so it runs before any file is touched and only once
    // the checkpoint is known to resolve. A refused rewind then changes nothing. A
    // conversation-only rewind restores no file, so it needs no checkpoint and no guard.
    let (fallback_to_head, shared) = if conversation_only {
        (false, None)
    } else {
        let restore = restore.ok_or_else(|| {
            OrchestrationEffectsError::Effect(
                "BiBCode can't tell which checkout this chat works in, so nothing was restored. Try the revert again.".to_owned(),
            )
        })?;
        let probe = callbacks.revert_probe();
        plan_shared_restore(
            engine,
            probe.as_deref(),
            restore,
            thread_id,
            turn_count,
            &cwd,
            &target_ref,
            &checkpoints,
            payload.get("siblingChangesToken").and_then(Value::as_str),
            cancellation,
        )
        .await?
    };
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
    // Asked of the live session, which the preparation reopened, so the API version is known.
    if conversation_only
        && let Some(probe) = callbacks.revert_probe()
        && let Some(refusal) = probe
            .conversation_rewind(thread_id)
            .await
            .map_err(OrchestrationEffectsError::Effect)?
            .refusal()
    {
        return Err(OrchestrationEffectsError::Effect(refusal));
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
        conversation_only,
        fallback_to_head,
        shared,
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

/// Why a turn captured without a trusted baseline has no one-turn diff. It is still a revert
/// target. Shared by the app's turn patch and MCP `get_turn_diff`.
pub(crate) fn no_baseline_diff_detail(turn_count: i64) -> String {
    format!(
        "Turn {turn_count} has no diff: the checkpoint before it is missing. You can still revert to it."
    )
}

/// Why a revert waits while a turn's checkpoint record is still being written.
pub(crate) fn checkpoint_record_pending_detail() -> String {
    "The last turn's checkpoint is still being recorded. Try the revert again in a moment."
        .to_owned()
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
        conversation_only,
        fallback_to_head,
        shared,
    } = plan;
    let thread_id = thread_id.as_str();
    let missing_checkpoint = || missing_checkpoint(turn_count);
    if conversation_only {
        return finish_conversation_rewind(
            engine,
            callbacks,
            thread_id,
            turn_count,
            &cwd,
            &checkpoints,
            rolled_back_turns,
            &rewind_key,
            request.as_deref(),
        )
        .await;
    }
    if let Some(shared) = &shared {
        let probe = callbacks.revert_probe();
        recheck_shared_restore(
            engine,
            probe.as_deref(),
            thread_id,
            &cwd,
            shared,
            cancellation,
        )
        .await?;
    }
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
            fallback_to_head,
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
        fallback_to_head,
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

/// Rewinds only the conversation (#279): the provider drops the newer turns, the thread drops
/// its newer messages, turns and checkpoint refs, and the working tree stays byte for byte as it
/// is. It never runs `restore`, `clean` or `reset`.
#[allow(clippy::too_many_arguments)]
async fn finish_conversation_rewind(
    engine: &OrchestrationEngine,
    callbacks: &dyn OrchestrationEffectCallbacks,
    thread_id: &str,
    turn_count: i64,
    cwd: &Path,
    checkpoints: &[crate::persistence::ProjectionCheckpoint],
    rolled_back_turns: i64,
    rewind_key: &str,
    request: Option<&str>,
) -> Result<(), OrchestrationEffectsError> {
    if rolled_back_turns > 0
        && let ProviderRewind::FilesOnly { provider_label } = callbacks
            .rollback_provider(thread_id, rolled_back_turns, rewind_key)
            .await
            .map_err(OrchestrationEffectsError::Effect)?
    {
        return Err(OrchestrationEffectsError::Effect(
            ConversationRewind::FilesOnlyProvider { provider_label }
                .refusal()
                .unwrap_or_default(),
        ));
    }
    // The provider has rewound, so the revert is recorded whatever happens next.
    let uninterruptible = CancellationToken::new();
    for checkpoint in checkpoints
        .iter()
        .filter(|checkpoint| checkpoint.checkpoint_turn_count > turn_count)
    {
        if delete_ref(
            cwd,
            Path::new("git"),
            &checkpoint.checkpoint_ref,
            &uninterruptible,
        )
        .await
        .is_err()
        {
            tracing::warn!(
                thread_id,
                turn_count = checkpoint.checkpoint_turn_count,
                "a rewound turn's checkpoint ref could not be deleted"
            );
        }
    }
    let created_at = now_iso();
    engine
        .dispatch(OrchestrationCommand::ThreadRevertComplete {
            command_id: outcome_id("checkpoint-revert-complete", request),
            thread_id: thread_id.to_owned(),
            turn_count,
            created_at: created_at.clone(),
        })
        .await
        .map_err(|error| OrchestrationEffectsError::Effect(error.to_string()))?;
    if let Err(error) = engine
        .dispatch(OrchestrationCommand::ThreadActivityAppend {
            command_id: outcome_id("checkpoint-revert-conversation-only", request),
            thread_id: thread_id.to_owned(),
            activity: ActivityInput {
                id: Uuid::new_v4().to_string(),
                tone: "info".to_owned(),
                kind: "checkpoint.revert.conversation-only".to_owned(),
                summary: "Conversation rewound, files kept".to_owned(),
                payload: json!({
                    "turnCount": turn_count,
                    "detail": "The newer messages were removed. Files in the checkout were not changed.",
                }),
                turn_id: None,
                sequence: None,
                created_at: created_at.clone(),
            },
            created_at,
        })
        .await
    {
        tracing::warn!(thread_id, %error, "a conversation-only rewind's work-log entry could not be recorded");
    }
    Ok(())
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
    sibling_changes_token: Option<&str>,
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
                {
                    let mut payload = json!({"turnCount":event.event.payload.get("turnCount"),"detail":detail});
                    if let Some(token) = sibling_changes_token {
                        payload["siblingChangesToken"] = json!(token);
                    }
                    payload
                },
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

/// Restores the checkout at `cwd` to checkpoint `reference`, as a revert does. `false` when
/// the ref is missing.
///
/// A test seam for `tests/git_system_config.rs` only: it skips the revert path, so it runs
/// without the shared-checkout restore guard (#279). Production restores must go through that
/// guard; wrap this seam in it once the guard lands rather than calling it elsewhere.
#[doc(hidden)]
pub async fn restore_checkpoint_ref(
    cwd: &Path,
    reference: &str,
) -> Result<bool, OrchestrationEffectsError> {
    restore_checkpoint(
        cwd,
        Path::new("git"),
        reference,
        false,
        &CancellationToken::new(),
    )
    .await
}

/// Deletes checkpoint `reference`, as a revert does for the turns it drops. A test seam for
/// `tests/git_system_config.rs`, outside the #279 restore guard like
/// [`restore_checkpoint_ref`].
#[doc(hidden)]
pub async fn delete_checkpoint_ref(
    cwd: &Path,
    reference: &str,
) -> Result<(), OrchestrationEffectsError> {
    delete_ref(cwd, Path::new("git"), reference, &CancellationToken::new()).await
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
    remove_temporary_index(temporary_index).await;
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
    let mut environment = crate::git::git_environment_inheriting_unread();
    environment.extend_from_slice(env);
    // No hook runs for BiBCode's own refs, and no fsmonitor starts for a temporary index. On
    // native Windows `/dev/null` is an ordinary path on the current drive.
    let hooks = format!("core.hooksPath={}", crate::git::clone_policy::NULL_DEVICE);
    let overrides = ["-c", hooks.as_str(), "-c", "core.fsmonitor=false"];
    ProcessRunner
        .run(
            ProcessRequest {
                operation: "OrchestrationEffects.git".to_owned(),
                command: git_command.to_path_buf(),
                args: overrides.iter().chain(args).map(OsString::from).collect(),
                cwd: cwd.to_path_buf(),
                env: environment,
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

    /// A side chat shares its host's checkout: it is never numbered and writes no baseline,
    /// so it has nothing to revert to and never restores over the host's work.
    #[tokio::test]
    async fn side_chat_turns_capture_no_checkpoints() {
        const AT: &str = "2026-11-02T00:00:00Z";
        let engine = empty_event_log().await;
        for value in [
            json!({"type":"project.create","commandId":"project","projectId":"p","title":"P","workspaceRoot":"C:/repo","createdAt":AT}),
            json!({"type":"thread.create","commandId":"host","threadId":"host","projectId":"p","title":"Host","modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"full-access","createdAt":AT}),
            json!({"type":"thread.create","commandId":"side","threadId":"side","projectId":"p","title":"Panel: Side chat · Codex","kind":"panel","hostThreadId":"host","sideChat":true,"modelSelection":{"instanceId":"codex","model":"gpt-5"},"runtimeMode":"approval-required","createdAt":AT}),
        ] {
            engine
                .dispatch(serde_json::from_value(value).unwrap())
                .await
                .unwrap();
        }
        let checkout = tempfile::tempdir().unwrap();
        std::fs::create_dir(checkout.path().join(".git")).unwrap();
        let repositories = engine.repositories();
        let numbered = |thread_id: &'static str| {
            let repositories = repositories.clone();
            async move {
                repositories
                    .list_checkpoints_by_thread(thread_id.to_owned())
                    .await
                    .unwrap()
                    .len()
            }
        };
        record_turn_end(
            &engine,
            "side",
            "turn-1",
            AT,
            TurnEnd::Live,
            Some(checkout.path()),
        )
        .await
        .unwrap();
        assert_eq!(numbered("side").await, 0);
        assert!(!engine.turns_held_for_checkpoint("side"));
        // The same checkout numbers the host's turn.
        record_turn_end(
            &engine,
            "host",
            "turn-1",
            AT,
            TurnEnd::Live,
            Some(checkout.path()),
        )
        .await
        .unwrap();
        assert_eq!(numbered("host").await, 1);

        struct NoWorkspace(AtomicUsize);
        impl OrchestrationEffectCallbacks for NoWorkspace {
            fn workspace_for_thread<'a>(
                &'a self,
                _: &'a str,
            ) -> BoxEffectFuture<'a, Option<PathBuf>> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(None) })
            }
            fn rollback_provider<'a>(
                &'a self,
                _: &'a str,
                _: i64,
                _: &'a str,
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
        }
        let callbacks = NoWorkspace(AtomicUsize::new(0));
        let cancellation = CancellationToken::new();
        // The baseline never looks for a side chat's checkout, so it never writes its ref 0.
        assert!(
            !first_turn_baseline_steps(&repositories, &callbacks, "side", "m", &cancellation, None)
                .await
                .unwrap()
        );
        assert_eq!(callbacks.0.load(Ordering::SeqCst), 0);
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
            test_hooks: crate::orchestration::engine::TestHooks::default(),
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
            test_hooks: crate::orchestration::engine::TestHooks::default(),
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
