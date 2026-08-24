use std::{
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

#[cfg(not(windows))]
use std::process::Stdio;

use serde::Deserialize;
use serde_json::{Value, json};
#[cfg(not(windows))]
use tokio::process::Command;
use tokio::sync::{Notify, mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::{
    git::{
        ChangeRequest, CreateWorktreeInput, GitCommandError, GitProcessRunner, GitRepository,
        GitStatusSummaryService, OutputPolicy, ProcessRequest, ProcessRunner,
        STATUS_SAFETY_INTERVAL, StatusBroadcaster, StatusReadFence, VcsStatusLocalResult,
        VcsStatusRemoteResult, VcsStatusStreamEvent, validate_pathspecs,
    },
    maintenance::RpcPermit,
    persistence::{Repositories, WorktreeRemovalReceipt},
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcSessionContext, RpcStreamChunk},
    source_control::{
        ChangeRequestState, CreatePullRequestInput, ProviderKind, PullRequestService,
        ResolvePullRequestInput, ResolvedPullRequest, SourceControlDiscovery,
    },
    terminal::TerminalManager,
    workspace::{WorkspaceMutationFuture, WorkspaceMutationObserver},
    worktree_catalog::{WorkspaceAdmissionLease, WorkspaceAvailabilityRegistry},
};

use super::host_paths::resolve_host_directory;

const STREAM_CAPACITY: usize = 8;

#[derive(Clone, Default)]
pub(crate) struct WorktreeRemovalTaskTracker {
    inner: Arc<WorktreeRemovalTaskTrackerInner>,
}

#[derive(Default)]
struct WorktreeRemovalTaskTrackerInner {
    state: Mutex<WorktreeRemovalTaskState>,
    drained: Notify,
}

#[derive(Default)]
struct WorktreeRemovalTaskState {
    closed: bool,
    active: usize,
}

struct WorktreeRemovalTaskGuard {
    tracker: WorktreeRemovalTaskTracker,
}

impl Drop for WorktreeRemovalTaskGuard {
    fn drop(&mut self) {
        let notify = {
            let mut state = self
                .tracker
                .inner
                .state
                .lock()
                .expect("worktree removal task mutex poisoned");
            debug_assert!(state.active > 0);
            state.active = state.active.saturating_sub(1);
            state.active == 0
        };
        if notify {
            self.tracker.inner.drained.notify_waiters();
        }
    }
}

impl WorktreeRemovalTaskTracker {
    fn spawn<F, T>(&self, operation: F) -> Result<tokio::task::JoinHandle<T>, String>
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let guard = {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("worktree removal task mutex poisoned");
            if state.closed {
                return Err("the server is shutting down".to_owned());
            }
            state.active = state.active.saturating_add(1);
            WorktreeRemovalTaskGuard {
                tracker: self.clone(),
            }
        };
        Ok(tokio::spawn(async move {
            let _guard = guard;
            operation.await
        }))
    }

    pub(crate) async fn close_and_drain(&self) {
        {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("worktree removal task mutex poisoned");
            state.closed = true;
        }
        loop {
            let notified = self.inner.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .inner
                .state
                .lock()
                .expect("worktree removal task mutex poisoned")
                .active
                == 0
            {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod worktree_removal_task_tracker_tests {
    use super::WorktreeRemovalTaskTracker;

    #[tokio::test]
    async fn runtime_drain_waits_for_protected_removal_and_rejects_late_tasks() {
        let tracker = WorktreeRemovalTaskTracker::default();
        let (release, released) = tokio::sync::oneshot::channel();
        let operation = tracker
            .spawn(async move {
                let _ = released.await;
            })
            .expect("protected task admitted");
        let draining_tracker = tracker.clone();
        let drain = tokio::spawn(async move {
            draining_tracker.close_and_drain().await;
        });
        tokio::task::yield_now().await;
        assert!(
            !drain.is_finished(),
            "drain returned before removal finished"
        );

        release.send(()).expect("release protected task");
        operation.await.expect("protected task completed");
        drain.await.expect("runtime drain completed");
        assert!(
            tracker.spawn(async {}).is_err(),
            "shutdown admitted a late removal task"
        );
    }
}

pub const GIT_VCS_UNARY_METHODS: &[&str] = &[
    "shell.openInEditor",
    "vcs.pull",
    "vcs.refreshStatus",
    "vcs.listRefs",
    "vcs.listCommits",
    "vcs.clone",
    "vcs.createRef",
    "vcs.switchRef",
    "vcs.init",
    "vcs.stageFiles",
    "vcs.unstageFiles",
    "vcs.discardFiles",
    "vcs.generateCommitMessage",
    "git.resolvePullRequest",
    "git.preparePullRequestThread",
    "server.discoverSourceControl",
    "sourceControl.lookupRepository",
    "sourceControl.cloneRepository",
    "sourceControl.publishRepository",
];

pub const GIT_VCS_STREAM_METHODS: &[&str] = &[
    "subscribeVcsStatus",
    "subscribeVcsStatusSummary",
    "git.runStackedAction",
];

#[derive(Clone)]
pub struct GitVcsRpcServices {
    repository: Arc<GitRepository>,
    broadcaster: StatusBroadcaster,
    summary: GitStatusSummaryService,
    discovery: SourceControlDiscovery,
    pull_requests: PullRequestService,
    github_command: PathBuf,
    github_runner: Arc<dyn GitProcessRunner>,
    availability_registry: Option<WorkspaceAvailabilityRegistry>,
    terminal: Option<TerminalManager>,
    repositories: Option<Repositories>,
    worktree_removal_tasks: WorktreeRemovalTaskTracker,
    #[cfg(test)]
    status_stream_enrichment_test_hook: Option<Arc<StatusStreamEnrichmentTestHook>>,
}

#[cfg(test)]
struct StatusStreamEnrichmentTestHook {
    started: Notify,
    release: tokio::sync::Semaphore,
}

#[cfg(test)]
impl Default for StatusStreamEnrichmentTestHook {
    fn default() -> Self {
        Self {
            started: Notify::new(),
            release: tokio::sync::Semaphore::new(0),
        }
    }
}

#[cfg(test)]
impl StatusStreamEnrichmentTestHook {
    async fn block(&self, cancellation: &CancellationToken) {
        self.started.notify_one();
        tokio::select! {
            biased;
            () = cancellation.cancelled() => {}
            permit = self.release.acquire() => {
                if let Ok(permit) = permit {
                    permit.forget();
                }
            }
        }
    }
}

impl Default for GitVcsRpcServices {
    fn default() -> Self {
        Self::with_repository(Arc::new(GitRepository::default()))
    }
}

impl GitVcsRpcServices {
    pub fn with_repository(repository: Arc<GitRepository>) -> Self {
        let (automatic_remote_refresh_interval, _) = watch::channel(STATUS_SAFETY_INTERVAL);
        Self::with_repository_and_automatic_fetch_interval(
            repository,
            automatic_remote_refresh_interval,
        )
    }

    pub fn with_repository_and_automatic_fetch_interval(
        repository: Arc<GitRepository>,
        automatic_remote_refresh_interval: watch::Sender<Duration>,
    ) -> Self {
        Self::with_repository_dependencies(
            repository,
            automatic_remote_refresh_interval,
            None,
            None,
        )
    }

    pub fn with_repository_and_terminal(
        repository: Arc<GitRepository>,
        terminal: TerminalManager,
    ) -> Self {
        let (automatic_remote_refresh_interval, _) = watch::channel(STATUS_SAFETY_INTERVAL);
        Self::with_repository_dependencies(
            repository,
            automatic_remote_refresh_interval,
            Some(terminal),
            None,
        )
    }

    pub fn with_repository_terminal_and_automatic_fetch_interval(
        repository: Arc<GitRepository>,
        terminal: TerminalManager,
        automatic_remote_refresh_interval: watch::Sender<Duration>,
    ) -> Self {
        Self::with_repository_dependencies(
            repository,
            automatic_remote_refresh_interval,
            Some(terminal),
            None,
        )
    }

    pub fn with_production_dependencies(
        repository: Arc<GitRepository>,
        terminal: TerminalManager,
        repositories: Repositories,
        automatic_remote_refresh_interval: watch::Sender<Duration>,
    ) -> Self {
        Self::with_repository_dependencies(
            repository,
            automatic_remote_refresh_interval,
            Some(terminal),
            Some(repositories),
        )
    }

    fn with_repository_dependencies(
        repository: Arc<GitRepository>,
        automatic_remote_refresh_interval: watch::Sender<Duration>,
        terminal: Option<TerminalManager>,
        repositories: Option<Repositories>,
    ) -> Self {
        let pull_requests = PullRequestService::default();
        Self {
            broadcaster: StatusBroadcaster::with_automatic_remote_refresh_interval(
                Arc::clone(&repository),
                STATUS_SAFETY_INTERVAL,
                automatic_remote_refresh_interval,
                STREAM_CAPACITY,
            ),
            summary: GitStatusSummaryService::new(Arc::clone(&repository), pull_requests.clone()),
            repository,
            discovery: SourceControlDiscovery::default(),
            pull_requests,
            github_command: PathBuf::from("gh"),
            github_runner: Arc::new(ProcessRunner),
            availability_registry: None,
            terminal,
            repositories,
            worktree_removal_tasks: WorktreeRemovalTaskTracker::default(),
            #[cfg(test)]
            status_stream_enrichment_test_hook: None,
        }
    }

    #[cfg(all(test, unix))]
    fn with_repository_and_github_command(
        repository: Arc<GitRepository>,
        github_command: PathBuf,
    ) -> Self {
        let mut services = Self::with_repository(repository);
        services.github_command = github_command;
        services
    }

    #[cfg(test)]
    fn with_repository_and_github_runner_for_test(
        repository: Arc<GitRepository>,
        github_runner: Arc<dyn GitProcessRunner>,
    ) -> Self {
        let mut services = Self::with_repository(repository);
        services.github_runner = github_runner;
        services
    }

    #[cfg(test)]
    fn with_status_stream_enrichment_test_hook(
        mut self,
        hook: Arc<StatusStreamEnrichmentTestHook>,
    ) -> Self {
        self.status_stream_enrichment_test_hook = Some(hook);
        self
    }

    #[must_use]
    pub fn with_availability_registry(
        mut self,
        availability_registry: WorkspaceAvailabilityRegistry,
    ) -> Self {
        self.availability_registry = Some(availability_registry);
        self
    }

    pub(crate) fn worktree_removal_tasks(&self) -> WorktreeRemovalTaskTracker {
        self.worktree_removal_tasks.clone()
    }

    pub(crate) fn status_broadcaster(&self) -> StatusBroadcaster {
        self.broadcaster.clone()
    }
}

impl WorkspaceMutationObserver for GitVcsRpcServices {
    fn begin_workspace_mutation<'a>(&'a self, cwd: &'a Path) -> WorkspaceMutationFuture<'a> {
        Box::pin(async move { Some(self.broadcaster.begin_mutation(cwd).await) })
    }
}

pub fn register_git_vcs_rpc(registry: &mut RpcRegistry, services: GitVcsRpcServices) {
    for method in GIT_VCS_UNARY_METHODS {
        let services = services.clone();
        registry.register_unary_with_context(*method, move |request, context, cancellation| {
            let services = services.clone();
            async move {
                services
                    .handle_unary_with_context(request, context, cancellation)
                    .await
            }
        });
    }

    let stream_services = services.clone();
    registry.register_stream(GIT_VCS_STREAM_METHODS[0], move |request, cancellation| {
        stream_services.status_stream(request, cancellation)
    });
    let summary_services = services.clone();
    registry.register_latest_stream(GIT_VCS_STREAM_METHODS[1], move |request, cancellation| {
        summary_services.summary_stream(request, cancellation)
    });
    registry.register_stream(GIT_VCS_STREAM_METHODS[2], move |request, cancellation| {
        services.stacked_action_stream(request, cancellation)
    });
}

async fn await_server_owned_rpc(
    method: &'static str,
    operation: impl Future<Output = RpcResult> + Send + 'static,
) -> RpcResult {
    match tokio::spawn(operation).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => Err(request_error(method, &error.to_string())),
    }
}

impl GitVcsRpcServices {
    async fn handle_unary_with_context(
        &self,
        request: RpcRequest,
        context: RpcSessionContext,
        cancellation: CancellationToken,
    ) -> RpcResult {
        let workspace_admission = self.guard_payload_cwd(&request.payload).await?;
        let operation_cancellation = cancellation.child_token();
        match request.tag.as_str() {
            "vcs.pull" => {
                let input: CwdInput = decode(request.payload, "vcs.pull")?;
                let repository = Arc::clone(&self.repository);
                let token = operation_cancellation.clone();
                self.run_owned_git_mutation(
                    "vcs.pull",
                    input.cwd.clone(),
                    workspace_admission,
                    operation_cancellation,
                    async move {
                        encode_result(repository.pull_current_branch(&input.cwd, &token).await)
                    },
                )
                .await
            }
            "vcs.createRef" => {
                let input: CreateRefInput = decode(request.payload, "vcs.createRef")?;
                let repository = Arc::clone(&self.repository);
                let token = operation_cancellation.clone();
                self.run_owned_git_mutation(
                    "vcs.createRef",
                    input.cwd.clone(),
                    workspace_admission,
                    operation_cancellation,
                    async move {
                        encode_result(
                            repository
                                .create_ref(
                                    &input.cwd,
                                    &input.ref_name,
                                    input.switch_ref.unwrap_or(false),
                                    &token,
                                )
                                .await
                                .map(|ref_name| json!({ "refName": ref_name })),
                        )
                    },
                )
                .await
            }
            "vcs.switchRef" => {
                let input: SwitchRefInput = decode(request.payload, "vcs.switchRef")?;
                let repository = Arc::clone(&self.repository);
                let token = operation_cancellation.clone();
                self.run_owned_git_mutation(
                    "vcs.switchRef",
                    input.cwd.clone(),
                    workspace_admission,
                    operation_cancellation,
                    async move {
                        encode_result(
                            repository
                                .switch_ref(&input.cwd, &input.ref_name, &token)
                                .await
                                .map(|ref_name| json!({ "refName": ref_name })),
                        )
                    },
                )
                .await
            }
            "vcs.init" => {
                let input: InitInput = decode(request.payload, "vcs.init")?;
                if input.kind.as_deref().is_some_and(|kind| kind != "git") {
                    return Err(vcs_error(
                        "vcs.init",
                        &input.cwd,
                        "Only the git VCS driver can initialize repositories.",
                    ));
                }
                let repository = Arc::clone(&self.repository);
                let token = operation_cancellation.clone();
                self.run_owned_git_mutation(
                    "vcs.init",
                    input.cwd.clone(),
                    workspace_admission,
                    operation_cancellation,
                    async move { encode_null(repository.init(&input.cwd, &token).await) },
                )
                .await
            }
            "vcs.stageFiles" | "vcs.unstageFiles" | "vcs.discardFiles" => {
                let tag = request.tag;
                let input: FilePathsInput = decode(request.payload, &tag)?;
                if input.file_paths.is_empty() {
                    return Ok(Value::Null);
                }
                let operation = match tag.as_str() {
                    "vcs.stageFiles" => "GitVcsDriver.stageFiles",
                    "vcs.unstageFiles" => "GitVcsDriver.unstageFiles",
                    _ => "GitVcsDriver.discardFiles",
                };
                validate_pathspecs(operation, &input.cwd, &input.file_paths)
                    .map_err(serialize_error)?;
                let repository = Arc::clone(&self.repository);
                let token = operation_cancellation.clone();
                let method = match tag.as_str() {
                    "vcs.stageFiles" => "vcs.stageFiles",
                    "vcs.unstageFiles" => "vcs.unstageFiles",
                    _ => "vcs.discardFiles",
                };
                self.run_owned_git_mutation(
                    method,
                    input.cwd.clone(),
                    workspace_admission,
                    operation_cancellation,
                    async move {
                        let result = match tag.as_str() {
                            "vcs.stageFiles" => {
                                repository
                                    .stage_files(&input.cwd, &input.file_paths, &token)
                                    .await
                            }
                            "vcs.unstageFiles" => {
                                repository
                                    .unstage_files(&input.cwd, &input.file_paths, &token)
                                    .await
                            }
                            _ => {
                                repository
                                    .discard_files(&input.cwd, &input.file_paths, &token)
                                    .await
                            }
                        };
                        encode_null(result)
                    },
                )
                .await
            }
            "git.preparePullRequestThread" => {
                let input: PreparePullRequestInput =
                    decode(request.payload, "git.preparePullRequestThread")?;
                let (pull_request, branch) = await_git_rpc_operation(
                    workspace_admission.as_ref(),
                    operation_cancellation.clone(),
                    self.resolve_pull_request_preparation(&input, &operation_cancellation),
                )
                .await?;
                let repository = Arc::clone(&self.repository);
                let token = operation_cancellation.clone();
                self.run_owned_git_mutation(
                    "git.preparePullRequestThread",
                    input.cwd.clone(),
                    workspace_admission,
                    operation_cancellation,
                    async move {
                        repository
                            .switch_ref(&input.cwd, &branch, &token)
                            .await
                            .map_err(serialize_error)?;
                        Ok(json!({ "pullRequest": pull_request, "branch": branch }))
                    },
                )
                .await
            }
            "sourceControl.publishRepository" => {
                let input: PublishRepositoryInput =
                    decode(request.payload, "sourceControl.publishRepository")?;
                let (remote_name, visibility) = preflight_publish_repository(&input)?;
                let services = self.clone();
                let token = operation_cancellation.clone();
                self.run_owned_git_mutation(
                    "sourceControl.publishRepository",
                    input.cwd.clone(),
                    workspace_admission,
                    operation_cancellation,
                    async move {
                        services
                            .publish_repository(input, remote_name, visibility, &token)
                            .await
                    },
                )
                .await
            }
            _ => {
                await_git_rpc_operation(
                    workspace_admission.as_ref(),
                    operation_cancellation.clone(),
                    self.handle_admitted_unary(request, context, operation_cancellation),
                )
                .await
            }
        }
    }

    async fn run_owned_git_mutation(
        &self,
        method: &'static str,
        cwd: PathBuf,
        workspace_admission: Option<WorkspaceAdmissionLease>,
        cancellation: CancellationToken,
        operation: impl Future<Output = RpcResult> + Send + 'static,
    ) -> RpcResult {
        let broadcaster = self.broadcaster.clone();
        await_server_owned_rpc(method, async move {
            let loss = workspace_admission
                .as_ref()
                .map(WorkspaceAdmissionLease::loss_cancellation);
            let mutation = match loss {
                Some(loss) => {
                    tokio::select! {
                        biased;
                        () = loss.cancelled() => {
                            cancellation.cancel();
                            return Err(serialize_error(
                                loss.unavailable().expect("workspace loss retains its error"),
                            ));
                        }
                        () = cancellation.cancelled() => {
                            return Err(request_error(method, "The Git mutation was cancelled before admission."));
                        }
                        mutation = broadcaster.begin_mutation(&cwd) => mutation,
                    }
                }
                None => {
                    tokio::select! {
                        biased;
                        () = cancellation.cancelled() => {
                            return Err(request_error(method, "The Git mutation was cancelled before admission."));
                        }
                        mutation = broadcaster.begin_mutation(&cwd) => mutation,
                    }
                }
            };
            let result = await_git_mutation_terminal(
                workspace_admission.as_ref(),
                cancellation,
                operation,
            )
            .await;
            mutation.finish().await;
            result
        })
        .await
    }

    async fn handle_admitted_unary(
        &self,
        request: RpcRequest,
        context: RpcSessionContext,
        cancellation: CancellationToken,
    ) -> RpcResult {
        match request.tag.as_str() {
            "shell.openInEditor" => self.open_in_editor(request.payload).await,
            "vcs.refreshStatus" => {
                let input: CwdInput = decode(request.payload, "vcs.refreshStatus")?;
                let publication = self
                    .broadcaster
                    .refresh_status(&input.cwd, &cancellation)
                    .await
                    .map_err(serialize_error)?;
                let fence = publication.fence;
                let mut status = publication.value;
                let status = finish_fenced_enrichment(&self.broadcaster, fence, async {
                    enrich_remote_pull_request(
                        &self.pull_requests,
                        &input.cwd,
                        &status.local,
                        &mut status.remote,
                        &cancellation,
                    )
                    .await;
                    status
                })
                .await
                .map_err(serialize_error)?;
                serde_json::to_value(status)
                    .map_err(|error| request_error("vcs.refreshStatus", &error.to_string()))
            }
            "vcs.listRefs" => {
                let input: ListRefsInput = decode(request.payload, "vcs.listRefs")?;
                encode_result(
                    self.repository
                        .list_refs(
                            &input.cwd,
                            input.query.as_deref(),
                            input.cursor.unwrap_or(0),
                            input.limit.unwrap_or(50).clamp(1, 200),
                            input.include_matching_remote_refs.unwrap_or(false),
                            input.ref_kind.as_deref(),
                            &cancellation,
                        )
                        .await,
                )
            }
            "vcs.listCommits" => {
                let input: ListCommitsInput = decode(request.payload, "vcs.listCommits")?;
                encode_result(
                    self.repository
                        .list_commits(
                            &input.cwd,
                            input.limit.unwrap_or(50).clamp(1, 200),
                            input.cursor.unwrap_or(0),
                            &cancellation,
                        )
                        .await,
                )
            }
            "vcs.createWorktree" => {
                let input: CreateWorktree = decode(request.payload, "vcs.createWorktree")?;
                encode_result(
                    self.repository
                        .create_worktree(
                            CreateWorktreeInput {
                                cwd: input.cwd,
                                ref_name: input.ref_name,
                                new_ref_name: input.new_ref_name,
                                base_ref_name: input.base_ref_name,
                                path: input.path,
                            },
                            &cancellation,
                        )
                        .await,
                )
            }
            "vcs.removeWorktree" => {
                let input: RemoveWorktree = decode(request.payload, "vcs.removeWorktree")?;
                if let Some(repositories) = &self.repositories {
                    return self
                        .remove_worktree_with_durable_admission(
                            input,
                            repositories.clone(),
                            context.admission_permit(),
                            cancellation,
                        )
                        .await;
                }
                let _terminal_removal = match &self.terminal {
                    Some(_) if input.thread_ids.is_empty() => {
                        return Err(vcs_error(
                            "vcs.removeWorktree",
                            &input.cwd,
                            "Worktree removal requires the owning terminal thread IDs.",
                        ));
                    }
                    Some(terminal) => Some(
                        terminal
                            .begin_worktree_removal(&input.thread_ids, &input.path)
                            .await
                            .map_err(|error| {
                                vcs_error(
                                    "vcs.removeWorktree",
                                    &input.cwd,
                                    &format!(
                                        "Could not fence worktree terminal activity before removal: {error}"
                                    ),
                                )
                            })?,
                    ),
                    None => None,
                };
                encode_null(
                    self.repository
                        .remove_worktree(
                            &input.cwd,
                            &input.path,
                            input.force.unwrap_or(false),
                            &cancellation,
                        )
                        .await,
                )
            }
            "vcs.clone" => {
                let input: CloneInput = decode(request.payload, "vcs.clone")?;
                let parent_dir = resolve_host_directory(&input.parent_dir, false)
                    .await
                    .map_err(|error| {
                        vcs_error("vcs.clone", &input.parent_dir, &error.to_string())
                    })?;
                let result = self
                    .repository
                    .clone_repository(
                        &input.url,
                        &parent_dir,
                        input.directory_name.as_deref(),
                        &cancellation,
                    )
                    .await;
                encode_result(result.map(|path| json!({ "path": display_path(path) })))
            }
            "vcs.generateCommitMessage" => {
                let input: CommitMessageInput =
                    decode(request.payload, "vcs.generateCommitMessage")?;
                let context = self
                    .repository
                    .commit_context(&input.cwd, &cancellation)
                    .await
                    .map_err(serialize_error)?;
                let message = summarize_commit_context(&context, input.file_paths.as_deref());
                Ok(json!({ "message": message }))
            }
            "git.resolvePullRequest" => {
                let input: PullRequestInput = decode(request.payload, "git.resolvePullRequest")?;
                let pull_request = self.resolve_pull_request(&input, &cancellation).await?;
                Ok(json!({ "pullRequest": pull_request }))
            }
            "server.discoverSourceControl" => {
                let _: EmptyInput = decode(request.payload, "server.discoverSourceControl")?;
                Ok(encode_value(
                    self.discovery
                        .discover(PathBuf::from("."), &cancellation)
                        .await,
                ))
            }
            "sourceControl.lookupRepository" => {
                let input: LookupRepositoryInput =
                    decode(request.payload, "sourceControl.lookupRepository")?;
                self.lookup_repository(input, cancellation).await
            }
            "sourceControl.cloneRepository" => {
                let input: CloneRepositoryInput =
                    decode(request.payload, "sourceControl.cloneRepository")?;
                self.clone_source_repository(input, &cancellation).await
            }
            _ => Err(request_error(
                &request.tag,
                "RPC method is not registered here.",
            )),
        }
    }

    async fn remove_worktree_with_durable_admission(
        &self,
        input: RemoveWorktree,
        repositories: Repositories,
        admission: Option<RpcPermit>,
        cancellation: CancellationToken,
    ) -> RpcResult {
        let Some(owner_thread_id) = input.owner_thread_id.clone() else {
            return Err(vcs_error(
                "vcs.removeWorktree",
                &input.cwd,
                "Worktree removal requires its owning workspace thread ID.",
            ));
        };
        if !input
            .thread_ids
            .iter()
            .any(|thread_id| thread_id == &owner_thread_id)
        {
            return Err(vcs_error(
                "vcs.removeWorktree",
                &input.cwd,
                "The terminal fence must include the owning workspace thread ID.",
            ));
        }
        let existing_receipt = repositories
            .get_worktree_removal_receipt(owner_thread_id.clone())
            .await
            .map_err(|error| {
                vcs_error(
                    "vcs.removeWorktree",
                    &input.cwd,
                    &format!("Could not read the durable worktree removal receipt: {error}"),
                )
            })?;
        if let Some(receipt) = &existing_receipt {
            ensure_receipt_matches_request(receipt, &input)?;
            if receipt.state == "removed" {
                return Ok(Value::Null);
            }
        }

        let owner = repositories
            .get_thread(owner_thread_id.clone())
            .await
            .map_err(|error| {
                vcs_error(
                    "vcs.removeWorktree",
                    &input.cwd,
                    &format!("Could not verify the owning workspace thread: {error}"),
                )
            })?
            .ok_or_else(|| {
                vcs_error(
                    "vcs.removeWorktree",
                    &input.cwd,
                    "The owning workspace thread no longer exists.",
                )
            })?;
        if owner.kind == "panel"
            || owner.deleted_at.is_some()
            || owner
                .worktree_path
                .as_deref()
                .is_none_or(|path| !same_removal_path(Path::new(path), &input.path))
        {
            return Err(vcs_error(
                "vcs.removeWorktree",
                &input.cwd,
                "The supplied workspace thread does not own this worktree path.",
            ));
        }
        let project = repositories
            .get_project(owner.project_id.clone())
            .await
            .map_err(|error| {
                vcs_error(
                    "vcs.removeWorktree",
                    &input.cwd,
                    &format!("Could not verify the worktree project: {error}"),
                )
            })?
            .ok_or_else(|| {
                vcs_error(
                    "vcs.removeWorktree",
                    &input.cwd,
                    "The worktree project no longer exists.",
                )
            })?;
        if project.deleted_at.is_some()
            || !same_removal_path(Path::new(&project.workspace_root), &input.cwd)
        {
            return Err(vcs_error(
                "vcs.removeWorktree",
                &input.cwd,
                "The supplied repository path does not own this workspace thread.",
            ));
        }
        let project_threads = repositories
            .list_threads_by_project(owner.project_id)
            .await
            .map_err(|error| {
                vcs_error(
                    "vcs.removeWorktree",
                    &input.cwd,
                    &format!("Could not verify worktree path ownership: {error}"),
                )
            })?;
        for thread in project_threads.iter().filter(|thread| {
            thread.thread_id != owner_thread_id
                && thread.kind != "panel"
                && thread.deleted_at.is_none()
                && thread
                    .worktree_path
                    .as_deref()
                    .is_some_and(|path| same_removal_path(Path::new(path), &input.path))
        }) {
            let superseded = repositories
                .get_worktree_removal_receipt(thread.thread_id.clone())
                .await
                .map_err(|error| {
                    vcs_error(
                        "vcs.removeWorktree",
                        &input.cwd,
                        &format!("Could not verify competing worktree ownership: {error}"),
                    )
                })?
                .is_some_and(|receipt| receipt.state == "removed");
            if !superseded {
                return Err(vcs_error(
                    "vcs.removeWorktree",
                    &input.cwd,
                    "Another workspace thread now owns this path, so the stale removal was rejected.",
                ));
            }
        }

        if cancellation.is_cancelled() {
            return Err(vcs_error(
                "vcs.removeWorktree",
                &input.cwd,
                "Worktree removal was interrupted before safety admission.",
            ));
        }
        let terminal = self.terminal.as_ref().ok_or_else(|| {
            vcs_error(
                "vcs.removeWorktree",
                &input.cwd,
                "The production terminal safety coordinator is unavailable.",
            )
        })?;
        let terminal_removal = terminal
            .begin_worktree_removal(&input.thread_ids, &input.path)
            .await
            .map_err(|error| {
                vcs_error(
                    "vcs.removeWorktree",
                    &input.cwd,
                    &format!("Could not fence worktree terminal activity before removal: {error}"),
                )
            })?;

        let receipt = match existing_receipt {
            Some(receipt) => receipt,
            None => {
                let nonce = self
                    .repository
                    .prepare_worktree_removal_identity(&input.cwd, &input.path, &cancellation)
                    .await
                    .map_err(serialize_error)?;
                let receipt = repositories
                    .prepare_worktree_removal_receipt(WorktreeRemovalReceipt {
                        owner_thread_id: owner_thread_id.clone(),
                        project_cwd: display_path(&input.cwd),
                        worktree_path: display_path(&input.path),
                        identity_nonce: nonce.clone(),
                        state: "prepared".to_owned(),
                        created_at: String::new(),
                        updated_at: String::new(),
                    })
                    .await
                    .map_err(|error| {
                        vcs_error(
                            "vcs.removeWorktree",
                            &input.cwd,
                            &format!("Could not persist the worktree removal receipt: {error}"),
                        )
                    })?;
                ensure_receipt_matches_request(&receipt, &input)?;
                if receipt.identity_nonce != nonce || receipt.state != "prepared" {
                    return Err(vcs_error(
                        "vcs.removeWorktree",
                        &input.cwd,
                        "A conflicting durable worktree removal receipt already exists.",
                    ));
                }
                receipt
            }
        };

        let repository = Arc::clone(&self.repository);
        let cwd = input.cwd;
        let error_cwd = cwd.clone();
        let path = input.path;
        let force = input.force.unwrap_or(false);
        let operation = self
            .worktree_removal_tasks
            .spawn(async move {
                let _admission = admission;
                let _terminal_removal = terminal_removal;
                let safety_token = CancellationToken::new();
                repository
                    .remove_worktree_with_identity(
                        &cwd,
                        &path,
                        force,
                        &receipt.identity_nonce,
                        &safety_token,
                    )
                    .await
                    .map_err(serialize_error)?;
                repositories
                    .complete_worktree_removal_receipt(
                        receipt.owner_thread_id,
                        receipt.identity_nonce,
                    )
                    .await
                    .map_err(|error| {
                        vcs_error(
                            "vcs.removeWorktree",
                            &cwd,
                            &format!(
                                "Git removed the worktree, but its durable receipt failed: {error}"
                            ),
                        )
                    })?;
                Ok::<(), Value>(())
            })
            .map_err(|error| {
                vcs_error(
                    "vcs.removeWorktree",
                    &error_cwd,
                    &format!("The protected worktree removal task was not admitted: {error}"),
                )
            })?;
        operation.await.map_err(|error| {
            vcs_error(
                "vcs.removeWorktree",
                &error_cwd,
                &format!("The protected worktree removal task failed: {error}"),
            )
        })??;
        Ok(Value::Null)
    }

    fn status_stream(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
        let broadcaster = self.broadcaster.clone();
        let pull_requests = self.pull_requests.clone();
        let availability = self.availability_registry.clone();
        #[cfg(test)]
        let enrichment_test_hook = self.status_stream_enrichment_test_hook.clone();
        tokio::spawn(async move {
            let input = match decode::<CwdInput>(request.payload, "subscribeVcsStatus") {
                Ok(input) => input,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let workspace_admission = match guard_git_path(availability.as_ref(), &input.cwd).await
            {
                Ok(admission) => admission,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let operation_cancellation = cancellation.child_token();
            let loss = workspace_admission
                .as_ref()
                .map(WorkspaceAdmissionLease::loss_cancellation);
            let loss_token = loss
                .as_ref()
                .map(|loss| loss.cancellation_token())
                .unwrap_or_default();
            let mut subscription = match await_git_rpc_operation(
                workspace_admission.as_ref(),
                operation_cancellation.clone(),
                async {
                    broadcaster
                        .subscribe(input.cwd.clone(), operation_cancellation.clone())
                        .await
                        .map_err(serialize_error)
                },
            )
            .await
            {
                Ok(subscription) => subscription,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let mut enrichment: Option<(CancellationToken, tokio::task::JoinHandle<()>)> = None;
            loop {
                tokio::select! {
                    biased;
                    () = loss_token.cancelled() => {
                        operation_cancellation.cancel();
                        if let Some(error) = loss.as_ref().and_then(|loss| loss.unavailable()) {
                            let _ = sender.send(Err(serialize_error(error))).await;
                        }
                        break;
                    }
                    _ = cancellation.cancelled() => break,
                    publication = subscription.recv_publication() => {
                        let Some(publication) = publication else { break };
                        stop_status_stream_enrichment(&mut enrichment).await;
                        let enrichment_remote = match &publication.value {
                            VcsStatusStreamEvent::Snapshot { remote, .. }
                            | VcsStatusStreamEvent::RemoteUpdated { remote } => remote.clone(),
                            VcsStatusStreamEvent::LocalUpdated { .. } => None,
                        };
                        if !send_status_stream_event(
                            &sender,
                            &broadcaster,
                            &publication.fence,
                            publication.value,
                        )
                        .await
                        {
                            break;
                        }
                        if let Some(remote) = enrichment_remote {
                            let task_cancellation = operation_cancellation.child_token();
                            let task_token = task_cancellation.clone();
                            let task_sender = sender.clone();
                            let task_broadcaster = broadcaster.clone();
                            let task_pull_requests = pull_requests.clone();
                            let task_cwd = input.cwd.clone();
                            let task_local = publication.local;
                            let task_fence = publication.fence;
                            #[cfg(test)]
                            let task_test_hook = enrichment_test_hook.clone();
                            let task = tokio::spawn(async move {
                                #[cfg(test)]
                                if let Some(hook) = &task_test_hook {
                                    hook.block(&task_token).await;
                                }
                                if task_token.is_cancelled() {
                                    return;
                                }
                                let mut enriched = remote.clone();
                                enrich_remote_pull_request(
                                    &task_pull_requests,
                                    &task_cwd,
                                    &task_local,
                                    &mut enriched,
                                    &task_token,
                                )
                                .await;
                                if task_token.is_cancelled() || enriched == remote {
                                    return;
                                }
                                let _ = send_status_stream_event(
                                    &task_sender,
                                    &task_broadcaster,
                                    &task_fence,
                                    VcsStatusStreamEvent::RemoteUpdated {
                                        remote: Some(enriched),
                                    },
                                )
                                .await;
                            });
                            enrichment = Some((task_cancellation, task));
                        }
                    }
                }
            }
            operation_cancellation.cancel();
            stop_status_stream_enrichment(&mut enrichment).await;
        });
        receiver
    }

    fn summary_stream(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> watch::Receiver<Option<RpcStreamChunk>> {
        let (sender, receiver) = watch::channel(None);
        let summary = self.summary.clone();
        let availability = self.availability_registry.clone();
        tokio::spawn(async move {
            let input = match decode::<CwdInput>(request.payload, "subscribeVcsStatusSummary") {
                Ok(input) => input,
                Err(error) => {
                    sender.send_replace(Some(Err(error)));
                    return;
                }
            };
            let workspace_admission = match guard_git_path(availability.as_ref(), &input.cwd).await
            {
                Ok(admission) => admission,
                Err(error) => {
                    sender.send_replace(Some(Err(error)));
                    return;
                }
            };
            let loss = workspace_admission
                .as_ref()
                .map(WorkspaceAdmissionLease::loss_cancellation);
            let loss_token = loss
                .as_ref()
                .map(|loss| loss.cancellation_token())
                .unwrap_or_default();
            let subscription = tokio::select! {
                biased;
                () = cancellation.cancelled() => return,
                result = summary.subscribe(input.cwd.clone()) => result,
            };
            let mut subscription = match subscription {
                Ok(subscription) => subscription,
                Err(error) => {
                    sender.send_replace(Some(Err(serialize_error(error))));
                    return;
                }
            };
            loop {
                let item = tokio::select! {
                    biased;
                    () = sender.closed() => return,
                    () = loss_token.cancelled() => {
                        if let Some(error) = loss.as_ref().and_then(|loss| loss.unavailable()) {
                            sender.send_replace(Some(Err(serialize_error(error))));
                        }
                        return;
                    }
                    () = cancellation.cancelled() => return,
                    changed = subscription.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        subscription.borrow_and_update().clone()
                    }
                };
                let Some(item) = item else {
                    continue;
                };
                let chunk = match item {
                    Ok(summary) => serde_json::to_value(summary)
                        .map(|summary| vec![summary])
                        .map_err(|error| {
                            request_error("subscribeVcsStatusSummary", &error.to_string())
                        }),
                    Err(error) => Err(serialize_error(error)),
                };
                sender.send_replace(Some(chunk));
            }
        });
        receiver
    }

    fn stacked_action_stream(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(STREAM_CAPACITY);
        let repository = Arc::clone(&self.repository);
        let broadcaster = self.broadcaster.clone();
        let pull_requests = self.pull_requests.clone();
        let availability = self.availability_registry.clone();
        tokio::spawn(async move {
            let input = match decode::<StackedActionInput>(request.payload, "git.runStackedAction")
            {
                Ok(input) => input,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let workspace_admission = match guard_git_path(availability.as_ref(), &input.cwd).await
            {
                Ok(admission) => admission,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let operation_cancellation = cancellation.child_token();
            let phases = action_phases(&input.action, input.feature_branch.unwrap_or(false));
            let action_started = await_git_rpc_operation(
                workspace_admission.as_ref(),
                operation_cancellation.clone(),
                async {
                    send_event(
                        &sender,
                        json!({
                            "actionId": input.action_id, "cwd": input.cwd, "action": input.action,
                            "kind": "action_started", "phases": phases,
                        }),
                    )
                    .await
                    .map_err(|()| request_error("git.runStackedAction", "stream receiver closed"))
                },
            )
            .await;
            if let Err(error) = action_started {
                if is_workspace_unavailable(&error) {
                    let _ = sender.send(Err(error)).await;
                }
                return;
            }
            let result = match validate_stacked_action_input(&input) {
                Err(error) => Err(error),
                Ok(()) => {
                    await_git_rpc_operation(
                        workspace_admission.as_ref(),
                        operation_cancellation.clone(),
                        async {
                            let mutation = broadcaster.begin_mutation(&input.cwd).await;
                            let result = run_stacked_action(
                                &repository,
                                &pull_requests,
                                &input,
                                &operation_cancellation,
                            )
                            .await;
                            mutation.finish().await;
                            result
                        },
                    )
                    .await
                }
            };
            if let Err(error) = &result
                && is_workspace_unavailable(error)
            {
                let _ = sender.send(Err(error.clone())).await;
                return;
            }
            let event = match result {
                Ok(result) => json!({
                    "actionId": input.action_id, "cwd": input.cwd, "action": input.action,
                    "kind": "action_finished", "result": result,
                }),
                Err(error) => json!({
                    "actionId": input.action_id, "cwd": input.cwd, "action": input.action,
                    "kind": "action_failed", "phase": Value::Null,
                    "message": error.get("detail").and_then(Value::as_str).unwrap_or("Git action failed."),
                }),
            };
            if let Err(error) = await_git_rpc_operation(
                workspace_admission.as_ref(),
                operation_cancellation,
                async {
                    send_event(&sender, event).await.map_err(|()| {
                        request_error("git.runStackedAction", "stream receiver closed")
                    })
                },
            )
            .await
                && is_workspace_unavailable(&error)
            {
                let _ = sender.send(Err(error)).await;
            }
        });
        receiver
    }

    async fn resolve_pull_request(
        &self,
        input: &PullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<Value, Value> {
        let local = self
            .repository
            .local_status(&input.cwd, cancellation)
            .await
            .map_err(serialize_error)?;
        let provider = local
            .source_control_provider
            .as_ref()
            .map(|provider| match provider.kind {
                crate::git::ProviderKind::Github => ProviderKind::Github,
                crate::git::ProviderKind::Gitlab => ProviderKind::Gitlab,
                crate::git::ProviderKind::AzureDevops => ProviderKind::AzureDevops,
                crate::git::ProviderKind::Bitbucket => ProviderKind::Bitbucket,
                crate::git::ProviderKind::Unknown => ProviderKind::Unknown,
            })
            .unwrap_or(ProviderKind::Unknown);
        let pull_request = self
            .pull_requests
            .resolve(
                ResolvePullRequestInput {
                    cwd: input.cwd.clone(),
                    provider,
                    reference: input.reference.clone(),
                },
                cancellation,
            )
            .await
            .map_err(serialize_error)?;
        serde_json::to_value(pull_request)
            .map_err(|error| request_error("git.resolvePullRequest", &error.to_string()))
    }

    async fn resolve_pull_request_preparation(
        &self,
        input: &PreparePullRequestInput,
        cancellation: &CancellationToken,
    ) -> Result<(Value, String), Value> {
        let PreparePullRequestMode::Local = &input.mode;
        let pull_request = self
            .resolve_pull_request(
                &PullRequestInput {
                    cwd: input.cwd.clone(),
                    reference: input.reference.clone(),
                },
                cancellation,
            )
            .await?;
        let branch = pull_request["headBranch"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if branch.is_empty() {
            return Err(request_error(
                "git.preparePullRequestThread",
                "Pull request has no head branch.",
            ));
        }
        Ok((pull_request, branch))
    }

    async fn lookup_repository(
        &self,
        input: LookupRepositoryInput,
        cancellation: CancellationToken,
    ) -> RpcResult {
        let (command, args) = match input.provider.as_str() {
            "github" => (
                self.github_command.as_path(),
                vec![
                    "repo",
                    "view",
                    &input.repository,
                    "--json",
                    "nameWithOwner,url,sshUrl",
                ],
            ),
            "gitlab" => (
                Path::new("glab"),
                vec!["repo", "view", &input.repository, "--output", "json"],
            ),
            provider => {
                return Err(source_control_error(
                    provider,
                    "lookupRepository",
                    "Provider repository lookup is unavailable.",
                ));
            }
        };
        run_provider_json(
            command,
            &args,
            input.cwd.as_deref(),
            cancellation,
            &input.provider,
            "lookupRepository",
        )
        .await
    }

    async fn clone_source_repository(
        &self,
        input: CloneRepositoryInput,
        cancellation: &CancellationToken,
    ) -> RpcResult {
        let remote_url = input
            .remote_url
            .or_else(|| input.repository.clone())
            .ok_or_else(|| {
                source_control_error(
                    input.provider.as_deref().unwrap_or("unknown"),
                    "cloneRepository",
                    "Enter a repository path or clone URL before cloning.",
                )
            })?;
        let destination = input.destination_path;
        let parent = destination.parent().ok_or_else(|| {
            request_error(
                "sourceControl.cloneRepository",
                "Destination has no parent directory.",
            )
        })?;
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            source_control_error(
                input.provider.as_deref().unwrap_or("unknown"),
                "cloneRepository",
                &error.to_string(),
            )
        })?;
        let directory_name = destination.file_name().and_then(|value| value.to_str());
        let cwd = self
            .repository
            .clone_repository(&remote_url, parent, directory_name, cancellation)
            .await
            .map_err(serialize_error)?;
        Ok(json!({ "cwd": display_path(cwd), "remoteUrl": remote_url, "repository": Value::Null }))
    }

    async fn publish_repository(
        &self,
        input: PublishRepositoryInput,
        remote_name: String,
        visibility: &'static str,
        cancellation: &CancellationToken,
    ) -> RpcResult {
        let output = self
            .github_runner
            .run(
                ProcessRequest {
                    operation: "source-control.publishRepository.create".into(),
                    command: self.github_command.clone(),
                    args: vec![
                        "repo".into(),
                        "create".into(),
                        input.repository.clone().into(),
                        visibility.into(),
                        "--source".into(),
                        ".".into(),
                        format!("--remote={remote_name}").into(),
                    ],
                    cwd: input.cwd.clone(),
                    env: vec![],
                    stdin: None,
                    timeout: Duration::from_secs(60),
                    max_output_bytes: 128_000,
                    output_policy: OutputPolicy::Error,
                    append_truncation_marker: false,
                    allow_non_zero_exit: true,
                },
                cancellation,
            )
            .await
            .map_err(|error| {
                source_control_error(&input.provider, "publishRepository", &error.to_string())
            })?;
        if output.exit_code != 0 {
            return Err(source_control_error(
                &input.provider,
                "publishRepository",
                "GitHub CLI could not create the repository.",
            ));
        }
        let branch = self
            .repository
            .push_current_branch_to_remote(&input.cwd, &remote_name, cancellation)
            .await
            .map_err(serialize_error)?;
        let repository_url = format!("https://github.com/{}", input.repository);
        let remote_url = if input.protocol.as_deref() == Some("ssh") {
            format!("git@github.com:{}.git", input.repository)
        } else {
            format!("{repository_url}.git")
        };
        let ssh_url = format!("git@github.com:{}.git", input.repository);
        let upstream_branch = format!("{remote_name}/{branch}");
        Ok(json!({
            "repository": {
                "provider": "github",
                "nameWithOwner": input.repository,
                "url": repository_url,
                "sshUrl": ssh_url,
            },
            "remoteName": remote_name,
            "remoteUrl": remote_url,
            "branch": branch,
            "upstreamBranch": upstream_branch,
            "status": "pushed",
        }))
    }

    async fn open_in_editor(&self, payload: Value) -> RpcResult {
        open_in_editor_with(payload, launch_editor)
    }

    async fn guard_payload_cwd(
        &self,
        payload: &Value,
    ) -> Result<Option<WorkspaceAdmissionLease>, Value> {
        let Some(cwd) = payload.get("cwd").and_then(Value::as_str) else {
            return Ok(None);
        };
        guard_git_path(self.availability_registry.as_ref(), Path::new(cwd)).await
    }
}

async fn guard_git_path(
    registry: Option<&WorkspaceAvailabilityRegistry>,
    cwd: &Path,
) -> Result<Option<WorkspaceAdmissionLease>, Value> {
    let Some(registry) = registry else {
        return Ok(None);
    };
    registry
        .acquire_path_admission([cwd])
        .await
        .map(Some)
        .map_err(|error| {
            serde_json::to_value(error).expect("workspace unavailable error serializes")
        })
}

async fn await_git_rpc_operation<T>(
    admission: Option<&WorkspaceAdmissionLease>,
    operation_cancellation: CancellationToken,
    operation: impl Future<Output = Result<T, Value>>,
) -> Result<T, Value> {
    let Some(admission) = admission else {
        return operation.await;
    };
    let loss = admission.loss_cancellation();
    tokio::select! {
        biased;
        () = loss.cancelled() => {
            operation_cancellation.cancel();
            Err(serialize_error(
                loss.unavailable()
                    .expect("workspace loss cancellation retains its exact error"),
            ))
        }
        result = operation => result,
    }
}

async fn await_git_mutation_terminal(
    admission: Option<&WorkspaceAdmissionLease>,
    cancellation: CancellationToken,
    operation: impl Future<Output = RpcResult>,
) -> RpcResult {
    let Some(admission) = admission else {
        return operation.await;
    };
    let loss = admission.loss_cancellation();
    tokio::pin!(operation);
    tokio::select! {
        biased;
        () = loss.cancelled() => {
            cancellation.cancel();
            let _ = operation.await;
            Err(serialize_error(
                loss.unavailable()
                    .expect("workspace loss cancellation retains its exact error"),
            ))
        }
        result = &mut operation => result,
    }
}

fn is_workspace_unavailable(error: &Value) -> bool {
    error.get("_tag").and_then(Value::as_str) == Some("WorkspaceUnavailableError")
}

fn open_in_editor_with(
    payload: Value,
    launch: impl FnOnce(&EditorLaunchStrategy) -> std::io::Result<()>,
) -> RpcResult {
    let input: LaunchEditorInput = decode(payload, "shell.openInEditor")?;
    let (command, args): (&str, Vec<String>) = match input.editor.as_str() {
            "file-manager" => return open::that_detached(&input.cwd).map(|()| Value::Null).map_err(|error| json!({
                "_tag": "ExternalLauncherEditorSpawnError", "editor": input.editor,
                "target": display_path(&input.cwd), "command": "open", "args": [], "cause": error.to_string(),
            })),
            "cursor" => ("cursor", vec!["--goto".into(), display_path(&input.cwd)]),
            "trae" => ("trae", vec!["--goto".into(), display_path(&input.cwd)]),
            "kiro" => ("kiro", vec!["ide".into(), "--goto".into(), display_path(&input.cwd)]),
            "vscode" => ("code", vec!["--goto".into(), display_path(&input.cwd)]),
            "vscode-insiders" => ("code-insiders", vec!["--goto".into(), display_path(&input.cwd)]),
            "vscodium" => ("codium", vec!["--goto".into(), display_path(&input.cwd)]),
            "zed" => ("zed", vec![display_path(&input.cwd)]),
            "antigravity" => ("agy", vec!["--goto".into(), display_path(&input.cwd)]),
            editor if JETBRAINS_EDITORS.contains(&editor) => (editor, vec![display_path(&input.cwd)]),
            editor => return Err(json!({ "_tag": "ExternalLauncherUnknownEditorError", "editor": editor })),
        };
    let target = display_path(&input.cwd);
    let strategy = editor_launch_strategy(command, args.clone(), target.clone());
    launch(&strategy).map(|()| Value::Null).map_err(|error| {
        json!({
            "_tag": "ExternalLauncherEditorSpawnError", "editor": input.editor,
            "target": target, "command": command, "args": args, "cause": error.to_string()
        })
    })
}

fn launch_editor(strategy: &EditorLaunchStrategy) -> std::io::Result<()> {
    match strategy {
        #[cfg(windows)]
        EditorLaunchStrategy::ShellAssociation {
            application,
            target,
        } => open::with_detached(target, application.clone()),
        #[cfg(not(windows))]
        EditorLaunchStrategy::Process { command, args } => Command::new(command)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .spawn()
            .map(|_| ()),
    }
}

#[derive(Debug, Eq, PartialEq)]
enum EditorLaunchStrategy {
    #[cfg(windows)]
    ShellAssociation { application: String, target: String },
    #[cfg(not(windows))]
    Process { command: String, args: Vec<String> },
}

fn editor_launch_strategy(
    command: &str,
    args: Vec<String>,
    target: String,
) -> EditorLaunchStrategy {
    #[cfg(windows)]
    {
        let _ = args;
        EditorLaunchStrategy::ShellAssociation {
            application: command.to_owned(),
            target,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        EditorLaunchStrategy::Process {
            command: command.to_owned(),
            args,
        }
    }
}

const JETBRAINS_EDITORS: &[&str] = &[
    "idea",
    "aqua",
    "clion",
    "datagrip",
    "dataspell",
    "goland",
    "phpstorm",
    "pycharm",
    "rider",
    "rubymine",
    "rustrover",
    "webstorm",
];

#[derive(Deserialize)]
struct EmptyInput {}
#[derive(Deserialize)]
struct CwdInput {
    cwd: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRefsInput {
    cwd: PathBuf,
    query: Option<String>,
    cursor: Option<usize>,
    limit: Option<usize>,
    include_matching_remote_refs: Option<bool>,
    ref_kind: Option<String>,
}
#[derive(Deserialize)]
struct ListCommitsInput {
    cwd: PathBuf,
    limit: Option<usize>,
    cursor: Option<usize>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorktree {
    cwd: PathBuf,
    ref_name: String,
    new_ref_name: Option<String>,
    base_ref_name: Option<String>,
    path: Option<PathBuf>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveWorktree {
    cwd: PathBuf,
    path: PathBuf,
    force: Option<bool>,
    #[serde(default)]
    owner_thread_id: Option<String>,
    #[serde(default)]
    thread_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloneInput {
    url: String,
    parent_dir: PathBuf,
    directory_name: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRefInput {
    cwd: PathBuf,
    ref_name: String,
    switch_ref: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchRefInput {
    cwd: PathBuf,
    ref_name: String,
}
#[derive(Deserialize)]
struct InitInput {
    cwd: PathBuf,
    kind: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePathsInput {
    cwd: PathBuf,
    file_paths: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitMessageInput {
    cwd: PathBuf,
    file_paths: Option<Vec<String>>,
}
#[derive(Deserialize)]
struct PullRequestInput {
    cwd: PathBuf,
    reference: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PreparePullRequestInput {
    cwd: PathBuf,
    reference: String,
    mode: PreparePullRequestMode,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum PreparePullRequestMode {
    Local,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StackedActionInput {
    action_id: String,
    cwd: PathBuf,
    action: String,
    commit_message: Option<String>,
    file_paths: Option<Vec<String>>,
    feature_branch: Option<bool>,
    commit_staged_index_as_is: Option<bool>,
}
#[derive(Deserialize)]
struct LookupRepositoryInput {
    provider: String,
    repository: String,
    cwd: Option<PathBuf>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloneRepositoryInput {
    provider: Option<String>,
    repository: Option<String>,
    remote_url: Option<String>,
    destination_path: PathBuf,
    #[allow(dead_code)]
    protocol: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishRepositoryInput {
    cwd: PathBuf,
    provider: String,
    repository: String,
    visibility: String,
    remote_name: Option<String>,
    protocol: Option<String>,
}
#[derive(Deserialize)]
struct LaunchEditorInput {
    cwd: PathBuf,
    editor: String,
}

fn validate_stacked_action_input(input: &StackedActionInput) -> Result<(), Value> {
    if !matches!(
        input.action.as_str(),
        "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr"
    ) {
        return Err(request_error(
            "git.runStackedAction",
            &format!("Unsupported Git action '{}'.", input.action),
        ));
    }
    if input.feature_branch.unwrap_or(false)
        && !matches!(
            input.action.as_str(),
            "commit" | "commit_push" | "commit_push_pr"
        )
    {
        return Err(request_error(
            "git.runStackedAction",
            "Feature-branch checkout is only supported for commit actions.",
        ));
    }
    Ok(())
}

async fn run_stacked_action(
    repository: &GitRepository,
    pull_requests: &PullRequestService,
    input: &StackedActionInput,
    cancellation: &CancellationToken,
) -> Result<Value, Value> {
    validate_stacked_action_input(input)?;
    let wants_commit = matches!(
        input.action.as_str(),
        "commit" | "commit_push" | "commit_push_pr"
    );
    let wants_pr = matches!(input.action.as_str(), "create_pr" | "commit_push_pr");
    let feature_branch = input.feature_branch.unwrap_or(false);
    let commit_staged_index_as_is = input.commit_staged_index_as_is.unwrap_or(false);
    let initial_local = repository
        .local_status(&input.cwd, cancellation)
        .await
        .map_err(serialize_error)?;
    if feature_branch && !initial_local.has_working_tree_changes {
        return Err(request_error(
            "git.runStackedAction",
            "Cannot create a feature branch because there are no changes to commit.",
        ));
    }
    if input.action == "create_pr" && initial_local.has_working_tree_changes {
        return Err(request_error(
            "git.runStackedAction",
            "Commit local changes before creating a PR.",
        ));
    }
    if !feature_branch && (wants_pr || input.action == "push") && initial_local.ref_name.is_none() {
        let detail = if wants_pr {
            "Cannot create a pull request from detached HEAD."
        } else {
            "Cannot push from detached HEAD."
        };
        return Err(request_error("git.runStackedAction", detail));
    }
    let wants_push = if input.action == "create_pr" {
        let remote = repository
            .remote_status(&input.cwd, cancellation)
            .await
            .map_err(serialize_error)?;
        remote.is_none_or(|status| !status.has_upstream || status.ahead_count > 0)
    } else {
        matches!(
            input.action.as_str(),
            "push" | "commit_push" | "commit_push_pr"
        )
    };
    let resolved_message = if wants_commit {
        Some(match input.commit_message.as_deref().map(str::trim) {
            Some(message) if !message.is_empty() => message.to_owned(),
            _ => {
                let context = repository
                    .commit_context(&input.cwd, cancellation)
                    .await
                    .map_err(serialize_error)?;
                let message = summarize_commit_context(&context, input.file_paths.as_deref());
                if message.is_empty() {
                    "Update working tree".to_owned()
                } else {
                    message
                }
            }
        })
    } else {
        None
    };
    let branch = if feature_branch {
        let subject = resolved_message
            .as_deref()
            .and_then(|message| message.lines().next())
            .unwrap_or("update");
        let preferred = sanitize_feature_branch_name(subject);
        let existing = local_branch_names(repository, &input.cwd, cancellation).await?;
        let name = resolve_feature_branch_name(&existing, &preferred);
        repository
            .create_ref(&input.cwd, &name, true, cancellation)
            .await
            .map_err(serialize_error)?;
        json!({ "status": "created", "name": name })
    } else {
        json!({ "status": "skipped_not_requested" })
    };
    let commit = if wants_commit {
        let message = resolved_message.as_deref().unwrap_or("Update working tree");
        let sha = repository
            .commit(
                &input.cwd,
                message,
                input.file_paths.as_deref(),
                commit_staged_index_as_is,
                cancellation,
            )
            .await
            .map_err(serialize_error)?;
        sha.map_or_else(
            || json!({ "status": "skipped_no_changes" }),
            |sha| json!({ "status": "created", "commitSha": sha, "subject": message.lines().next().unwrap_or(message) }),
        )
    } else {
        json!({ "status": "skipped_not_requested" })
    };
    let push = if wants_push {
        let branch = repository
            .push_current_branch(&input.cwd, cancellation)
            .await
            .map_err(serialize_error)?;
        json!({ "status": "pushed", "branch": branch })
    } else {
        json!({ "status": "skipped_not_requested" })
    };
    let pull_request = if wants_pr {
        let current_local = repository
            .local_status(&input.cwd, cancellation)
            .await
            .map_err(serialize_error)?;
        let provider = local_provider_kind(&current_local);
        let head_branch = current_local.ref_name.as_deref().ok_or_else(|| {
            request_error(
                "git.runStackedAction",
                "Cannot create a pull request from detached HEAD.",
            )
        })?;
        if let Some(existing) = resolve_open_pull_request(
            pull_requests,
            &input.cwd,
            provider,
            head_branch,
            cancellation,
        )
        .await
        {
            resolved_pull_request_step("opened_existing", &existing)
        } else {
            let title = match resolved_message
                .as_deref()
                .and_then(|message| message.lines().next())
                .map(str::trim)
                .filter(|title| !title.is_empty())
            {
                Some(title) => title.to_owned(),
                None => repository
                    .list_commits(&input.cwd, 1, 0, cancellation)
                    .await
                    .map_err(serialize_error)?
                    .commits
                    .into_iter()
                    .next()
                    .map_or_else(|| format!("Update {head_branch}"), |commit| commit.subject),
            };
            let base_branch = current_local
                .default_ref_name
                .clone()
                .unwrap_or_else(|| "main".to_owned());
            let created = pull_requests
                .create(
                    CreatePullRequestInput {
                        cwd: input.cwd.clone(),
                        provider,
                        base_branch,
                        head_branch: head_branch.to_owned(),
                        title,
                        body: String::new(),
                    },
                    cancellation,
                )
                .await
                .map_err(serialize_error)?;
            resolved_pull_request_step("created", &created)
        }
    } else {
        json!({ "status": "skipped_not_requested" })
    };
    Ok(json!({
        "action": input.action,
        "branch": branch,
        "commit": commit,
        "push": push,
        "pr": pull_request,
        "toast": { "title": "Git action completed", "cta": { "kind": "none" } }
    }))
}

fn local_provider_kind(local: &VcsStatusLocalResult) -> ProviderKind {
    local
        .source_control_provider
        .as_ref()
        .map_or(ProviderKind::Unknown, |provider| match provider.kind {
            crate::git::ProviderKind::Github => ProviderKind::Github,
            crate::git::ProviderKind::Gitlab => ProviderKind::Gitlab,
            crate::git::ProviderKind::AzureDevops => ProviderKind::AzureDevops,
            crate::git::ProviderKind::Bitbucket => ProviderKind::Bitbucket,
            crate::git::ProviderKind::Unknown => ProviderKind::Unknown,
        })
}

async fn resolve_open_pull_request(
    pull_requests: &PullRequestService,
    cwd: &std::path::Path,
    provider: ProviderKind,
    reference: &str,
    cancellation: &CancellationToken,
) -> Option<ResolvedPullRequest> {
    if provider == ProviderKind::Unknown {
        return None;
    }
    pull_requests
        .resolve_current(
            ResolvePullRequestInput {
                cwd: cwd.to_path_buf(),
                provider,
                reference: reference.to_owned(),
            },
            cancellation,
        )
        .await
        .ok()
        .filter(|pull_request| pull_request.state == ChangeRequestState::Open)
}

fn resolved_pull_request_step(status: &str, pull_request: &ResolvedPullRequest) -> Value {
    json!({
        "status": status,
        "url": pull_request.url,
        "number": pull_request.number,
        "baseBranch": pull_request.base_branch,
        "headBranch": pull_request.head_branch,
        "title": pull_request.title,
    })
}

async fn finish_fenced_enrichment<T>(
    broadcaster: &StatusBroadcaster,
    fence: StatusReadFence,
    enrichment: impl Future<Output = T>,
) -> Result<T, GitCommandError> {
    let value = enrichment.await;
    broadcaster.publish_if_fence_current(&fence, || value)
}

async fn send_status_stream_event(
    sender: &mpsc::Sender<RpcStreamChunk>,
    broadcaster: &StatusBroadcaster,
    fence: &StatusReadFence,
    event: VcsStatusStreamEvent,
) -> bool {
    let chunk = serde_json::to_value(event)
        .map(|event| vec![event])
        .map_err(|error| request_error("subscribeVcsStatus", &error.to_string()));
    let permit = match sender.reserve().await {
        Ok(permit) => permit,
        Err(_) => return false,
    };
    let _ = broadcaster.publish_if_fence_current(fence, || permit.send(chunk));
    true
}

async fn stop_status_stream_enrichment(
    enrichment: &mut Option<(CancellationToken, tokio::task::JoinHandle<()>)>,
) {
    if let Some((cancellation, task)) = enrichment.take() {
        cancellation.cancel();
        task.abort();
        let _ = task.await;
    }
}

async fn enrich_remote_pull_request(
    pull_requests: &PullRequestService,
    cwd: &std::path::Path,
    local: &VcsStatusLocalResult,
    remote: &mut VcsStatusRemoteResult,
    cancellation: &CancellationToken,
) {
    let Some(reference) = local.ref_name.as_deref() else {
        return;
    };
    let Some(pull_request) = resolve_open_pull_request(
        pull_requests,
        cwd,
        local_provider_kind(local),
        reference,
        cancellation,
    )
    .await
    else {
        return;
    };
    remote.pr = Some(ChangeRequest {
        number: pull_request.number,
        title: pull_request.title,
        url: pull_request.url,
        base_ref: pull_request.base_branch,
        head_ref: pull_request.head_branch,
        state: "open".to_owned(),
    });
}

async fn local_branch_names(
    repository: &GitRepository,
    cwd: &std::path::Path,
    cancellation: &CancellationToken,
) -> Result<Vec<String>, Value> {
    repository
        .local_branch_names(cwd, cancellation)
        .await
        .map_err(serialize_error)
}

fn sanitize_branch_fragment(raw: &str) -> String {
    let mut fragment = String::with_capacity(raw.len().min(64));
    for character in raw.trim().to_lowercase().chars() {
        if matches!(character, '\'' | '"' | '`') {
            continue;
        }
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            if character != '-' || !fragment.ends_with('-') {
                fragment.push(character);
            }
        } else if character == '/' {
            if !fragment.ends_with('/') {
                fragment.push('/');
            }
        } else if !fragment.ends_with('-') {
            fragment.push('-');
        }
        if fragment.len() >= 64 {
            fragment.truncate(64);
            break;
        }
    }
    let fragment = fragment
        .trim_matches(|character| matches!(character, '.' | '/' | '_' | '-'))
        .to_owned();
    if fragment.is_empty() {
        "update".to_owned()
    } else {
        fragment
    }
}

fn sanitize_feature_branch_name(raw: &str) -> String {
    let fragment = sanitize_branch_fragment(raw);
    if fragment.starts_with("feature/") {
        fragment
    } else {
        format!("feature/{fragment}")
    }
}

fn resolve_feature_branch_name(existing: &[String], preferred: &str) -> String {
    if !existing
        .iter()
        .any(|name| name.eq_ignore_ascii_case(preferred))
    {
        return preferred.to_owned();
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{preferred}-{suffix}");
        if !existing
            .iter()
            .any(|name| name.eq_ignore_ascii_case(&candidate))
        {
            return candidate;
        }
        suffix += 1;
    }
}

fn action_phases(action: &str, feature_branch: bool) -> Vec<&'static str> {
    let mut phases = if feature_branch {
        vec!["branch"]
    } else {
        vec![]
    };
    phases.extend(match action {
        "commit" => vec!["commit"],
        "push" => vec!["push"],
        "create_pr" => vec!["push", "pr"],
        "commit_push" => vec!["commit", "push"],
        "commit_push_pr" => vec!["commit", "push", "pr"],
        _ => vec![],
    });
    phases
}

async fn send_event(sender: &mpsc::Sender<RpcStreamChunk>, event: Value) -> Result<(), ()> {
    sender.send(Ok(vec![event])).await.map_err(|_| ())
}

async fn run_provider_json(
    command: &Path,
    args: &[&str],
    cwd: Option<&std::path::Path>,
    cancellation: CancellationToken,
    provider: &str,
    operation: &str,
) -> RpcResult {
    let output = ProcessRunner
        .run(
            ProcessRequest {
                operation: format!("source-control.{operation}"),
                command: command.to_path_buf(),
                args: args.iter().map(OsString::from).collect(),
                cwd: cwd
                    .unwrap_or_else(|| std::path::Path::new("."))
                    .to_path_buf(),
                env: vec![],
                stdin: None,
                timeout: Duration::from_secs(30),
                max_output_bytes: 256_000,
                output_policy: OutputPolicy::Error,
                append_truncation_marker: false,
                allow_non_zero_exit: true,
            },
            &cancellation,
        )
        .await
        .map_err(|error| source_control_error(provider, operation, &error.to_string()))?;
    if output.exit_code != 0 {
        return Err(source_control_error(
            provider,
            operation,
            "Provider command failed.",
        ));
    }
    serde_json::from_str(&output.stdout)
        .map_err(|error| source_control_error(provider, operation, &error.to_string()))
}

fn decode<T: for<'de> Deserialize<'de>>(payload: Value, method: &str) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(|error| request_error(method, &error.to_string()))
}
fn encode_result<T: serde::Serialize, E: serde::Serialize>(result: Result<T, E>) -> RpcResult {
    result.map(encode_value).map_err(serialize_error)
}
fn encode_null<E: serde::Serialize>(result: Result<(), E>) -> RpcResult {
    result.map(|()| Value::Null).map_err(serialize_error)
}
fn encode_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or_else(
        |error| json!({ "_tag": "RpcSerializationError", "message": error.to_string() }),
    )
}
fn serialize_error<E: serde::Serialize>(error: E) -> Value {
    encode_value(error)
}
fn request_error(method: &str, detail: &str) -> Value {
    json!({ "_tag": "RpcRequestInvalid", "method": method, "detail": detail })
}
fn vcs_error(operation: &str, cwd: &std::path::Path, detail: &str) -> Value {
    json!({ "_tag": "GitCommandError", "operation": operation, "command": "git", "cwd": display_path(cwd), "detail": detail })
}
fn ensure_receipt_matches_request(
    receipt: &WorktreeRemovalReceipt,
    input: &RemoveWorktree,
) -> Result<(), Value> {
    if !same_removal_path(Path::new(&receipt.project_cwd), &input.cwd)
        || !same_removal_path(Path::new(&receipt.worktree_path), &input.path)
    {
        return Err(vcs_error(
            "vcs.removeWorktree",
            &input.cwd,
            "The removal request does not match the durable receipt for this workspace thread.",
        ));
    }
    Ok(())
}

fn same_removal_path(left: &Path, right: &Path) -> bool {
    fn key(path: &Path) -> String {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        };
        let mut value = absolute.to_string_lossy().replace('\\', "/");
        while value.len() > 1 && value.ends_with('/') {
            value.pop();
        }
        #[cfg(windows)]
        value.make_ascii_lowercase();
        value
    }
    key(left) == key(right)
}
fn source_control_error(provider: &str, operation: &str, detail: &str) -> Value {
    json!({ "_tag": "SourceControlRepositoryError", "provider": provider, "operation": operation, "detail": detail })
}
fn display_path(path: impl AsRef<std::path::Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

fn preflight_publish_repository(
    input: &PublishRepositoryInput,
) -> Result<(String, &'static str), Value> {
    let reject = |detail| source_control_error(&input.provider, "publishRepository", detail);
    if input.provider != "github" {
        return Err(reject(
            "Native repository publishing is unavailable for this provider.",
        ));
    }
    if input.repository.trim().is_empty()
        || input.repository.trim() != input.repository
        || input.repository.starts_with('-')
    {
        return Err(reject(
            "Repository name must be a trimmed non-empty non-option string.",
        ));
    }
    let remote_name = input.remote_name.as_deref().unwrap_or("origin");
    if remote_name.trim().is_empty()
        || remote_name.trim() != remote_name
        || remote_name.starts_with('-')
    {
        return Err(reject(
            "Remote name must be a trimmed non-empty non-option string.",
        ));
    }
    if input
        .protocol
        .as_deref()
        .is_some_and(|protocol| !matches!(protocol, "auto" | "ssh" | "https"))
    {
        return Err(reject("Repository protocol must be auto, ssh, or https."));
    }
    let visibility = match input.visibility.as_str() {
        "private" => "--private",
        "public" => "--public",
        _ => return Err(reject("Repository visibility must be private or public.")),
    };
    Ok((remote_name.to_owned(), visibility))
}

fn summarize_commit_context(context: &str, paths: Option<&[String]>) -> String {
    if let Some(paths) = paths
        && !paths.is_empty()
    {
        return format!("Update {}", paths.join(", "));
    }
    if context.trim().is_empty() {
        return String::new();
    }
    context
        .lines()
        .find(|line| line.starts_with("diff --git "))
        .and_then(|line| line.split(" b/").nth(1))
        .map_or_else(
            || "Update working tree".into(),
            |path| format!("Update {path}"),
        )
}

#[cfg(test)]
mod mutation_ownership_tests {
    use std::{
        panic::AssertUnwindSafe,
        sync::{Arc, Mutex, atomic::Ordering},
        time::Duration,
    };

    use futures_util::FutureExt;
    use serde_json::json;
    use tokio::sync::{Notify, Semaphore};
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::{
        RequestId,
        git::{
            BoxGitProcessFuture, GitProcessRunner, ProcessError, ProcessOutput, ProcessRequest,
            VcsStatusStreamEvent,
        },
    };

    struct ControlledMutationRunner {
        local_status_started: Notify,
        working_tree_dirty: std::sync::atomic::AtomicBool,
        blocked_operation: Option<&'static str>,
        mutation_started: Notify,
        release_mutation: Semaphore,
    }

    struct SuccessfulGithubRunner;

    impl GitProcessRunner for SuccessfulGithubRunner {
        fn run<'a>(
            &'a self,
            _request: ProcessRequest,
            _cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            Box::pin(async {
                Ok(ProcessOutput {
                    exit_code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                })
            })
        }
    }

    #[derive(Default)]
    struct RecordingGithubRunner {
        requests: Mutex<Vec<ProcessRequest>>,
    }

    impl GitProcessRunner for RecordingGithubRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            _cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            self.requests
                .lock()
                .expect("GitHub requests lock")
                .push(request);
            Box::pin(async {
                Ok(ProcessOutput {
                    exit_code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                })
            })
        }
    }

    struct PublishGitRunner {
        requests: Mutex<Vec<ProcessRequest>>,
        fail_push: bool,
    }

    impl PublishGitRunner {
        fn new(fail_push: bool) -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                fail_push,
            }
        }
    }

    impl GitProcessRunner for PublishGitRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            _cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            let operation = request.operation.clone();
            self.requests
                .lock()
                .expect("Git requests lock")
                .push(request);
            Box::pin(async move {
                match operation.as_str() {
                    "GitVcsDriver.currentRef" => Ok(ProcessOutput {
                        exit_code: 0,
                        stdout: "main\n".to_owned(),
                        stderr: String::new(),
                        stdout_truncated: false,
                        stderr_truncated: false,
                    }),
                    "GitVcsDriver.pushCurrentBranchToRemote" if self.fail_push => {
                        Err(ProcessError::NonZeroExit {
                            operation,
                            exit_code: 1,
                            stdout_length: 0,
                            stderr_length: 4,
                            stdout: String::new().into_boxed_str(),
                            stderr: "fail".into(),
                        })
                    }
                    "GitVcsDriver.pushCurrentBranchToRemote" => Ok(ProcessOutput {
                        exit_code: 0,
                        stdout: String::new(),
                        stderr: String::new(),
                        stdout_truncated: false,
                        stderr_truncated: false,
                    }),
                    operation => panic!("unexpected publish Git operation {operation}"),
                }
            })
        }
    }

    impl ControlledMutationRunner {
        fn new() -> Self {
            Self {
                local_status_started: Notify::new(),
                working_tree_dirty: std::sync::atomic::AtomicBool::new(false),
                blocked_operation: None,
                mutation_started: Notify::new(),
                release_mutation: Semaphore::new(0),
            }
        }

        fn blocking(operation: &'static str) -> Self {
            Self {
                blocked_operation: Some(operation),
                ..Self::new()
            }
        }

        async fn wait_for_mutation_start(&self) {
            self.mutation_started.notified().await;
        }
    }

    impl GitProcessRunner for ControlledMutationRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            let reads_local_status = request.operation == "GitVcsDriver.statusDetailsLocal.status";
            if reads_local_status {
                self.local_status_started.notify_waiters();
            }
            let marks_working_tree_dirty = matches!(
                request.operation.as_str(),
                "GitVcsDriver.initRepo"
                    | "GitVcsDriver.pushCurrentBranch"
                    | "GitVcsDriver.pushCurrentBranchToRemote"
            );
            Box::pin(async move {
                if self.blocked_operation == Some(request.operation.as_str()) {
                    self.mutation_started.notify_one();
                    self.release_mutation
                        .acquire()
                        .await
                        .expect("mutation release remains open")
                        .forget();
                    if cancellation.is_cancelled() {
                        return Err(ProcessError::Cancelled {
                            operation: request.operation,
                        });
                    }
                }
                if marks_working_tree_dirty {
                    self.working_tree_dirty.store(true, Ordering::SeqCst);
                }
                let (exit_code, stdout) = match request.operation.as_str() {
                    "GitVcsDriver.statusDetailsLocal.status" => {
                        let dirty =
                            reads_local_status && self.working_tree_dirty.load(Ordering::SeqCst);
                        let record = dirty.then_some(
                            "1 .M N... 100644 100644 100644 deadbeef deadbeef tracked.txt\n",
                        );
                        (
                            0,
                            format!("# branch.head main\n{}", record.unwrap_or_default()),
                        )
                    }
                    "GitVcsDriver.statusDetailsRemote.status" => {
                        (0, "# branch.head main\n".to_owned())
                    }
                    "GitVcsDriver.statusDetailsLocal.unstagedNumstat" => {
                        (0, "1\t1\ttracked.txt\n".to_owned())
                    }
                    "GitVcsDriver.defaultRef.originHead" | "GitVcsDriver.remoteProvider" => {
                        (1, String::new())
                    }
                    "GitVcsDriver.currentRef" => (0, "main\n".to_owned()),
                    "GitVcsDriver.defaultRef.candidate" => {
                        let is_main = request
                            .args
                            .last()
                            .is_some_and(|value| value == "refs/heads/main");
                        (i32::from(!is_main), String::new())
                    }
                    _ => (0, String::new()),
                };
                Ok(ProcessOutput {
                    exit_code,
                    stdout,
                    stderr: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                })
            })
        }
    }

    fn request(tag: &str, cwd: &Path) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from("1").expect("request id"),
            tag: tag.to_owned(),
            payload: json!({ "cwd": cwd }),
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }

    fn publish_request(id: &str, cwd: &Path) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from(id).expect("request id"),
            tag: "sourceControl.publishRepository".to_owned(),
            payload: json!({
                "cwd":cwd,"provider":"github","repository":"owner/name",
                "visibility":"private"
            }),
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }

    fn custom_publish_request(id: &str, cwd: &Path, repository: &str, remote: &str) -> RpcRequest {
        let mut request = publish_request(id, cwd);
        request.payload["repository"] = json!(repository);
        request.payload["remoteName"] = json!(remote);
        request
    }

    #[tokio::test]
    async fn blocked_pull_request_enrichment_cannot_delay_base_or_local_publications() {
        let root = tempfile::tempdir().expect("repository root");
        let runner = Arc::new(ControlledMutationRunner::new());
        let repository = Arc::new(GitRepository::with_runner_for_test(runner));
        let hook = Arc::new(StatusStreamEnrichmentTestHook::default());
        let services = GitVcsRpcServices::with_repository(repository)
            .with_status_stream_enrichment_test_hook(Arc::clone(&hook));
        let cancellation = CancellationToken::new();
        let mut stream = services.status_stream(
            request("subscribeVcsStatus", root.path()),
            cancellation.clone(),
        );
        let snapshot = tokio::time::timeout(Duration::from_secs(5), stream.recv())
            .await
            .expect("initial snapshot deadline")
            .expect("status stream remains open")
            .expect("initial snapshot succeeds");
        assert_eq!(snapshot[0]["_tag"], "snapshot");
        services
            .broadcaster
            .publish_status_event_for_test(
                root.path(),
                VcsStatusStreamEvent::RemoteUpdated {
                    remote: Some(VcsStatusRemoteResult {
                        has_upstream: true,
                        ahead_count: 1,
                        behind_count: 0,
                        ahead_of_default_count: Some(1),
                        pr: None,
                    }),
                },
            )
            .await;
        tokio::time::timeout(Duration::from_secs(5), hook.started.notified())
            .await
            .expect("enrichment start deadline");
        let remote = tokio::time::timeout(Duration::from_millis(200), stream.recv())
            .await
            .expect("base publication must not wait for PR enrichment")
            .expect("status stream remains open")
            .expect("base publication succeeds");
        assert_eq!(remote[0]["_tag"], "remoteUpdated");

        services
            .broadcaster
            .publish_status_event_for_test(
                root.path(),
                VcsStatusStreamEvent::LocalUpdated {
                    local: VcsStatusLocalResult {
                        is_repo: true,
                        source_control_provider: None,
                        has_primary_remote: false,
                        is_default_ref: false,
                        ref_name: Some("main".to_owned()),
                        default_ref_name: Some("main".to_owned()),
                        has_working_tree_changes: true,
                        working_tree: Default::default(),
                    },
                },
            )
            .await;
        let local = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let chunk = stream
                    .recv()
                    .await
                    .expect("status stream remains open")
                    .expect("local publication succeeds");
                if chunk[0]["_tag"] == "localUpdated" {
                    return chunk;
                }
            }
        })
        .await
        .expect("local publication must overtake blocked PR enrichment");
        assert_eq!(local[0]["_tag"], "localUpdated");

        cancellation.cancel();
        hook.release.add_permits(1);
    }

    #[tokio::test]
    async fn mutation_retires_one_shared_read_for_two_clients_and_publishes_one_trailing_refresh() {
        let root = tempfile::tempdir().expect("repository root");
        let runner = Arc::new(ControlledMutationRunner::new());
        let repository = Arc::new(GitRepository::with_runner_for_test(runner.clone()));
        let services = GitVcsRpcServices::with_repository(repository);
        let mut subscription = services
            .broadcaster
            .subscribe(root.path().to_path_buf(), CancellationToken::new())
            .await
            .expect("initial status subscription");
        assert!(matches!(
            subscription.recv().await,
            Some(VcsStatusStreamEvent::Snapshot { .. })
        ));
        let stale_read_gate = services
            .broadcaster
            .install_full_read_execution_gate_for_test();

        let first_services = services.clone();
        let first_cwd = root.path().to_path_buf();
        let mut first = tokio::spawn(async move {
            first_services
                .handle_unary_with_context(
                    request("vcs.refreshStatus", &first_cwd),
                    RpcSessionContext::unauthenticated(),
                    CancellationToken::new(),
                )
                .await
        });
        stale_read_gate.wait_until_entered().await;
        let second_services = services.clone();
        let second_cwd = root.path().to_path_buf();
        let mut second = tokio::spawn(async move {
            second_services
                .handle_unary_with_context(
                    request("vcs.refreshStatus", &second_cwd),
                    RpcSessionContext::unauthenticated(),
                    CancellationToken::new(),
                )
                .await
        });
        while services
            .broadcaster
            .full_read_lease_count_for_test(root.path())
            .await
            != 2
        {
            tokio::task::yield_now().await;
        }

        let mutation = services
            .handle_unary_with_context(
                request("vcs.init", root.path()),
                RpcSessionContext::unauthenticated(),
                CancellationToken::new(),
            )
            .await;
        let retired = tokio::time::timeout(Duration::from_millis(200), async {
            (
                (&mut first).await.expect("first client task"),
                (&mut second).await.expect("second client task"),
            )
        })
        .await;
        let retired_in_time = retired.is_ok();
        let (first, second) = match retired {
            Ok(results) => results,
            Err(_) => (
                first.await.expect("released first client task"),
                second.await.expect("released second client task"),
            ),
        };
        let trailing = tokio::time::timeout(Duration::from_millis(200), async {
            loop {
                let event = subscription.recv().await?;
                if matches!(
                    event,
                    VcsStatusStreamEvent::LocalUpdated { ref local }
                        if local.has_working_tree_changes
                ) {
                    break Some(event);
                }
            }
        })
        .await
        .ok()
        .flatten();

        assert!(mutation.is_ok());
        assert!(
            retired_in_time,
            "mutation must retire the shared pre-mutation read"
        );
        assert!(first.is_err() && second.is_err());
        assert!(matches!(
            trailing,
            Some(VcsStatusStreamEvent::LocalUpdated { local })
                if local.has_working_tree_changes
        ));
    }

    #[tokio::test]
    async fn stacked_push_runs_inside_the_shared_mutation_boundary() {
        let root = tempfile::tempdir().expect("repository root");
        let runner = Arc::new(ControlledMutationRunner::new());
        let repository = Arc::new(GitRepository::with_runner_for_test(runner.clone()));
        let services = GitVcsRpcServices::with_repository(repository);
        let mut subscription = services
            .broadcaster
            .subscribe(root.path().to_path_buf(), CancellationToken::new())
            .await
            .expect("initial status subscription");
        subscription.recv().await.expect("initial status snapshot");
        let stale_services = services.clone();
        let stale_cwd = root.path().to_path_buf();
        let stale_read_gate = services
            .broadcaster
            .install_full_read_execution_gate_for_test();
        let stale = tokio::spawn(async move {
            stale_services
                .handle_unary_with_context(
                    request("vcs.refreshStatus", &stale_cwd),
                    RpcSessionContext::unauthenticated(),
                    CancellationToken::new(),
                )
                .await
        });
        stale_read_gate.wait_until_entered().await;
        assert_eq!(
            services
                .broadcaster
                .full_read_lease_count_for_test(root.path())
                .await,
            1
        );
        let mut stream = services.stacked_action_stream(
            RpcRequest {
                id: RequestId::try_from("2").expect("request id"),
                tag: "git.runStackedAction".to_owned(),
                payload: json!({
                    "actionId":"push-action",
                    "cwd":root.path(),
                    "action":"push"
                }),
                headers: Vec::new(),
                trace_id: None,
                span_id: None,
                sampled: None,
            },
            CancellationToken::new(),
        );

        let started = stream
            .recv()
            .await
            .expect("stacked start chunk")
            .expect("stacked start succeeds");
        assert_eq!(started[0]["kind"], "action_started");
        let finished = stream
            .recv()
            .await
            .expect("stacked finish chunk")
            .expect("stacked push succeeds");
        assert_eq!(finished[0]["kind"], "action_finished");
        assert_eq!(finished[0]["result"]["push"]["status"], "pushed");
        assert!(stale.await.expect("stale read task").is_err());
        let trailing = tokio::time::timeout(Duration::from_millis(200), async {
            loop {
                let event = subscription.recv().await?;
                if matches!(
                    event,
                    VcsStatusStreamEvent::LocalUpdated { ref local }
                        if local.has_working_tree_changes
                ) {
                    break Some(event);
                }
            }
        })
        .await
        .ok()
        .flatten();
        assert!(trailing.is_some());
    }

    #[tokio::test]
    async fn publish_repository_retires_a_stale_read_and_publishes_a_trailing_refresh() {
        let root = tempfile::tempdir().expect("repository root");
        let runner = Arc::new(ControlledMutationRunner::new());
        let repository = Arc::new(GitRepository::with_runner_for_test(runner.clone()));
        let services = GitVcsRpcServices::with_repository_and_github_runner_for_test(
            repository,
            Arc::new(SuccessfulGithubRunner),
        );
        let mut subscription = services
            .broadcaster
            .subscribe(root.path().to_path_buf(), CancellationToken::new())
            .await
            .expect("initial status subscription");
        subscription.recv().await.expect("initial status snapshot");
        let stale_services = services.clone();
        let stale_cwd = root.path().to_path_buf();
        let stale_read_gate = services
            .broadcaster
            .install_full_read_execution_gate_for_test();
        let stale = tokio::spawn(async move {
            stale_services
                .handle_unary_with_context(
                    request("vcs.refreshStatus", &stale_cwd),
                    RpcSessionContext::unauthenticated(),
                    CancellationToken::new(),
                )
                .await
        });
        stale_read_gate.wait_until_entered().await;
        assert_eq!(
            services
                .broadcaster
                .full_read_lease_count_for_test(root.path())
                .await,
            1
        );

        let published = services
            .handle_unary_with_context(
                publish_request("5", root.path()),
                RpcSessionContext::unauthenticated(),
                CancellationToken::new(),
            )
            .await
            .expect("publish succeeds");

        assert_eq!(published["status"], "pushed");
        assert!(stale.await.expect("stale read task").is_err());
        loop {
            if matches!(
                subscription.recv().await,
                Some(VcsStatusStreamEvent::LocalUpdated { local })
                    if local.has_working_tree_changes
            ) {
                break;
            }
        }
    }

    #[tokio::test]
    async fn admitted_publish_repository_outlives_its_cancelled_response_waiter() {
        let root = tempfile::tempdir().expect("repository root");
        let runner = Arc::new(ControlledMutationRunner::blocking(
            "GitVcsDriver.pushCurrentBranchToRemote",
        ));
        let repository = Arc::new(GitRepository::with_runner_for_test(runner.clone()));
        let services = GitVcsRpcServices::with_repository_and_github_runner_for_test(
            repository,
            Arc::new(SuccessfulGithubRunner),
        );
        let cancellation = CancellationToken::new();
        let task_services = services.clone();
        let task_cancellation = cancellation.clone();
        let cwd = root.path().to_path_buf();
        let response_waiter = tokio::spawn(async move {
            task_services
                .handle_unary_with_context(
                    publish_request("6", &cwd),
                    RpcSessionContext::unauthenticated(),
                    task_cancellation,
                )
                .await
        });
        runner.wait_for_mutation_start().await;

        cancellation.cancel();
        response_waiter.abort();
        let _ = response_waiter.await;
        assert_eq!(
            services
                .broadcaster
                .local_refresh_generation_for_test(root.path())
                .await,
            0
        );
        runner.release_mutation.add_permits(1);
        loop {
            if services
                .broadcaster
                .local_refresh_generation_for_test(root.path())
                .await
                == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn publish_repository_partial_push_error_settles_once() {
        let root = tempfile::tempdir().expect("repository root");
        let runner = Arc::new(ControlledMutationRunner::blocking(
            "GitVcsDriver.pushCurrentBranchToRemote",
        ));
        let repository = Arc::new(GitRepository::with_runner_for_test(runner.clone()));
        let services = GitVcsRpcServices::with_repository_and_github_runner_for_test(
            repository,
            Arc::new(SuccessfulGithubRunner),
        );
        let cancellation = CancellationToken::new();
        let task_services = services.clone();
        let task_cancellation = cancellation.clone();
        let cwd = root.path().to_path_buf();
        let response = tokio::spawn(async move {
            task_services
                .handle_unary_with_context(
                    publish_request("7", &cwd),
                    RpcSessionContext::unauthenticated(),
                    task_cancellation,
                )
                .await
        });
        runner.wait_for_mutation_start().await;
        cancellation.cancel();
        runner.release_mutation.add_permits(1);

        assert!(response.await.expect("publish response joins").is_err());
        assert_eq!(
            services
                .broadcaster
                .local_refresh_generation_for_test(root.path())
                .await,
            1
        );
    }

    #[tokio::test]
    async fn publish_repository_pushes_the_selected_remote_with_exact_arguments() {
        let root = tempfile::tempdir().expect("repository root");
        let git = Arc::new(PublishGitRunner::new(false));
        let github = Arc::new(RecordingGithubRunner::default());
        let services = GitVcsRpcServices::with_repository_and_github_runner_for_test(
            Arc::new(GitRepository::with_runner_for_test(git.clone())),
            github.clone(),
        );

        let result = services
            .handle_unary_with_context(
                custom_publish_request("8", root.path(), "owner/name", "upstream"),
                RpcSessionContext::unauthenticated(),
                CancellationToken::new(),
            )
            .await
            .expect("custom remote publish succeeds");

        assert_eq!(result["remoteName"], "upstream");
        assert_eq!(result["upstreamBranch"], "upstream/main");
        let github_requests = github.requests.lock().expect("GitHub requests lock");
        assert_eq!(github_requests.len(), 1);
        assert_eq!(
            github_requests[0].args,
            [
                "repo",
                "create",
                "owner/name",
                "--private",
                "--source",
                ".",
                "--remote=upstream"
            ]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
        );
        let git_requests = git.requests.lock().expect("Git requests lock");
        assert_eq!(git_requests.len(), 2);
        assert_eq!(
            git_requests[1].args,
            ["push", "--set-upstream", "--", "upstream", "main"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn custom_publish_push_failure_settles_once_after_github_success() {
        let root = tempfile::tempdir().expect("repository root");
        let git = Arc::new(PublishGitRunner::new(true));
        let github = Arc::new(RecordingGithubRunner::default());
        let services = GitVcsRpcServices::with_repository_and_github_runner_for_test(
            Arc::new(GitRepository::with_runner_for_test(git)),
            github.clone(),
        );

        let result = services
            .handle_unary_with_context(
                custom_publish_request("9", root.path(), "owner/name", "upstream"),
                RpcSessionContext::unauthenticated(),
                CancellationToken::new(),
            )
            .await;

        assert!(result.is_err());
        assert_eq!(
            github.requests.lock().expect("GitHub requests lock").len(),
            1
        );
        assert_eq!(
            services
                .broadcaster
                .local_refresh_generation_for_test(root.path())
                .await,
            1
        );
    }

    #[tokio::test]
    async fn option_shaped_publish_inputs_start_no_process_or_mutation() {
        let root = tempfile::tempdir().expect("repository root");
        let git = Arc::new(PublishGitRunner::new(false));
        let github = Arc::new(RecordingGithubRunner::default());
        let services = GitVcsRpcServices::with_repository_and_github_runner_for_test(
            Arc::new(GitRepository::with_runner_for_test(git.clone())),
            github.clone(),
        );

        for request in [
            custom_publish_request("10", root.path(), "--public", "upstream"),
            custom_publish_request("11", root.path(), "owner/name", "--all"),
        ] {
            assert!(
                services
                    .handle_unary_with_context(
                        request,
                        RpcSessionContext::unauthenticated(),
                        CancellationToken::new(),
                    )
                    .await
                    .is_err()
            );
        }
        assert!(git.requests.lock().expect("Git requests lock").is_empty());
        assert!(
            github
                .requests
                .lock()
                .expect("GitHub requests lock")
                .is_empty()
        );
        assert_eq!(
            services
                .broadcaster
                .local_refresh_generation_for_test(root.path())
                .await,
            0
        );
    }

    #[tokio::test]
    async fn admitted_unary_mutation_outlives_its_cancelled_response_waiter() {
        let root = tempfile::tempdir().expect("repository root");
        let runner = Arc::new(ControlledMutationRunner::blocking("GitVcsDriver.initRepo"));
        let repository = Arc::new(GitRepository::with_runner_for_test(runner.clone()));
        let services = GitVcsRpcServices::with_repository(repository);
        let cancellation = CancellationToken::new();
        let task_services = services.clone();
        let task_cancellation = cancellation.clone();
        let cwd = root.path().to_path_buf();
        let response_waiter = tokio::spawn(async move {
            task_services
                .handle_unary_with_context(
                    request("vcs.init", &cwd),
                    RpcSessionContext::unauthenticated(),
                    task_cancellation,
                )
                .await
        });
        runner.wait_for_mutation_start().await;

        cancellation.cancel();
        response_waiter.abort();
        let _ = response_waiter.await;
        tokio::task::yield_now().await;
        let before_release = services
            .broadcaster
            .local_refresh_generation_for_test(root.path())
            .await;
        runner.release_mutation.add_permits(1);
        tokio::time::timeout(Duration::from_millis(200), async {
            loop {
                if services
                    .broadcaster
                    .local_refresh_generation_for_test(root.path())
                    .await
                    == 1
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("owned mutation reaches terminal settlement");

        assert_eq!(before_release, 0);
        assert_eq!(
            services
                .broadcaster
                .local_refresh_generation_for_test(root.path())
                .await,
            1
        );
    }

    #[tokio::test]
    async fn rejected_and_empty_unary_requests_do_not_fence_status_reads() {
        let root = tempfile::tempdir().expect("repository root");
        let repository = Arc::new(GitRepository::with_runner_for_test(Arc::new(
            ControlledMutationRunner::new(),
        )));
        let services = GitVcsRpcServices::with_repository(repository);
        for (tag, payload, succeeds) in [
            (
                "vcs.init",
                json!({"cwd":root.path(),"kind":"mercurial"}),
                false,
            ),
            (
                "vcs.stageFiles",
                json!({"cwd":root.path(),"filePaths":[]}),
                true,
            ),
            (
                "vcs.unstageFiles",
                json!({"cwd":root.path(),"filePaths":[]}),
                true,
            ),
            (
                "vcs.discardFiles",
                json!({"cwd":root.path(),"filePaths":[]}),
                true,
            ),
            (
                "vcs.stageFiles",
                json!({"cwd":root.path(),"filePaths":["../escape"]}),
                false,
            ),
            (
                "git.preparePullRequestThread",
                json!({"cwd":root.path(),"reference":"current","mode":"unsupported"}),
                false,
            ),
            (
                "sourceControl.publishRepository",
                json!({
                    "cwd":root.path(),"provider":"github","repository":" owner/name",
                    "visibility":"private"
                }),
                false,
            ),
            (
                "sourceControl.publishRepository",
                json!({
                    "cwd":root.path(),"provider":"github","repository":"owner/name",
                    "visibility":"private","protocol":"ftp"
                }),
                false,
            ),
        ] {
            let result = services
                .handle_unary_with_context(
                    RpcRequest {
                        id: RequestId::try_from("3").expect("request id"),
                        tag: tag.to_owned(),
                        payload,
                        headers: Vec::new(),
                        trace_id: None,
                        span_id: None,
                        sampled: None,
                    },
                    RpcSessionContext::unauthenticated(),
                    CancellationToken::new(),
                )
                .await;
            assert_eq!(result.is_ok(), succeeds, "{tag}");
        }

        assert_eq!(
            services
                .broadcaster
                .local_refresh_generation_for_test(root.path())
                .await,
            0
        );
    }

    #[tokio::test]
    async fn unsupported_stacked_action_keeps_action_started_order_without_a_mutation_fence() {
        let root = tempfile::tempdir().expect("repository root");
        let services = GitVcsRpcServices::with_repository(Arc::new(
            GitRepository::with_runner_for_test(Arc::new(ControlledMutationRunner::new())),
        ));
        let mut stream = services.stacked_action_stream(
            RpcRequest {
                id: RequestId::try_from("4").expect("request id"),
                tag: "git.runStackedAction".to_owned(),
                payload: json!({
                    "actionId":"unsupported-action",
                    "cwd":root.path(),
                    "action":"unsupported"
                }),
                headers: Vec::new(),
                trace_id: None,
                span_id: None,
                sampled: None,
            },
            CancellationToken::new(),
        );

        assert_eq!(
            stream.recv().await.expect("start chunk").expect("start")[0]["kind"],
            "action_started"
        );
        assert_eq!(
            stream
                .recv()
                .await
                .expect("failure chunk")
                .expect("failure")[0]["kind"],
            "action_failed"
        );
        assert_eq!(
            services
                .broadcaster
                .local_refresh_generation_for_test(root.path())
                .await,
            0
        );
    }

    #[tokio::test]
    async fn blocked_old_pull_request_enrichment_is_rejected_after_switch_epoch() {
        let root = tempfile::tempdir().expect("repository root");
        let broadcaster = StatusBroadcaster::new(
            Arc::new(GitRepository::default()),
            Duration::from_secs(3_600),
            4,
        );
        let cancellation = CancellationToken::new();
        let old_fence = broadcaster
            .acquire_read_fence(root.path(), &cancellation)
            .await
            .expect("old status fence");
        let enrichment_started = Arc::new(Notify::new());
        let release_enrichment = Arc::new(Semaphore::new(0));
        let old_enrichment = {
            let broadcaster = broadcaster.clone();
            let enrichment_started = Arc::clone(&enrichment_started);
            let release_enrichment = Arc::clone(&release_enrichment);
            tokio::spawn(async move {
                finish_fenced_enrichment(&broadcaster, old_fence, async move {
                    enrichment_started.notify_one();
                    release_enrichment
                        .acquire()
                        .await
                        .expect("enrichment release remains open")
                        .forget();
                    "old-pr"
                })
                .await
            })
        };
        enrichment_started.notified().await;

        let mutation = broadcaster.begin_mutation(root.path()).await;
        mutation.finish().await;
        let new_fence = broadcaster
            .acquire_read_fence(root.path(), &cancellation)
            .await
            .expect("new status fence");
        assert_eq!(
            finish_fenced_enrichment(&broadcaster, new_fence, async { "new-pr" })
                .await
                .expect("new snapshot enrichment is current"),
            "new-pr"
        );

        release_enrichment.add_permits(1);
        assert!(
            old_enrichment
                .await
                .expect("old enrichment task joins")
                .is_err(),
            "old enriched result must not be delivered"
        );
    }

    #[tokio::test]
    async fn owned_git_task_panic_settles_the_guard_and_reaches_the_outer_unwind_boundary() {
        let root = tempfile::tempdir().expect("repository root");
        let broadcaster = StatusBroadcaster::new(
            Arc::new(GitRepository::default()),
            Duration::from_secs(3_600),
            4,
        );
        let owned_broadcaster = broadcaster.clone();
        let cwd = root.path().to_path_buf();

        let panic = AssertUnwindSafe(await_server_owned_rpc("vcs.init", async move {
            let _mutation = owned_broadcaster.begin_mutation(&cwd).await;
            panic!("owned Git mutation panic");
        }))
        .catch_unwind()
        .await;

        assert!(panic.is_err());
        assert_eq!(
            broadcaster
                .local_refresh_generation_for_test(root.path())
                .await,
            1
        );
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::{EditorLaunchStrategy, editor_launch_strategy, open_in_editor_with};
    use serde_json::json;

    #[test]
    fn windows_editor_launch_uses_the_shell_resolved_application() {
        let strategy = editor_launch_strategy(
            "cursor",
            vec!["--goto".to_owned(), "C:\\repo\\keybindings.json".to_owned()],
            "C:\\repo\\keybindings.json".to_owned(),
        );

        assert_eq!(
            strategy,
            EditorLaunchStrategy::ShellAssociation {
                application: "cursor".to_owned(),
                target: "C:\\repo\\keybindings.json".to_owned(),
            }
        );
    }

    #[test]
    fn editor_spawn_errors_are_typed_without_launching_an_external_application() {
        let error = open_in_editor_with(
            json!({
                "cwd": "C:\\repo",
                "editor": "rustrover",
            }),
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "missing fixture editor",
                ))
            },
        )
        .expect_err("injected launcher failure");

        assert_eq!(error["_tag"], "ExternalLauncherEditorSpawnError");
        assert_eq!(error["editor"], "rustrover");
        assert_eq!(error["target"], "C:\\repo");
        assert_eq!(error["command"], "rustrover");
        assert_eq!(error["args"], json!(["C:\\repo"]));
        assert_eq!(error["cause"], "missing fixture editor");
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use crate::RequestId;
    use std::{collections::VecDeque, sync::Mutex};

    fn rpc_request(tag: &str, payload: Value) -> RpcRequest {
        RpcRequest {
            id: RequestId::try_from("1").expect("request id"),
            tag: tag.to_owned(),
            payload,
            headers: Vec::new(),
            trace_id: None,
            span_id: None,
            sampled: None,
        }
    }

    async fn git(sandbox: &crate::test_support::TestSandbox, cwd: &Path, args: &[&str]) {
        ProcessRunner
            .run(
                ProcessRequest {
                    operation: "test.gitVcs.git".to_owned(),
                    command: sandbox.executable_on_path("git"),
                    args: args.iter().map(OsString::from).collect(),
                    cwd: cwd.to_path_buf(),
                    env: sandbox
                        .environment([("GIT_CONFIG_NOSYSTEM", "1")])
                        .into_iter()
                        .map(|(key, value)| (key.into(), value.into()))
                        .collect(),
                    stdin: None,
                    timeout: Duration::from_secs(30),
                    max_output_bytes: 128_000,
                    output_policy: OutputPolicy::Error,
                    append_truncation_marker: false,
                    allow_non_zero_exit: false,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("git {args:?} failed: {error}"));
    }

    struct CapturedGitRunner {
        command: PathBuf,
        environment: Vec<(OsString, OsString)>,
    }

    impl CapturedGitRunner {
        fn new(sandbox: &crate::test_support::TestSandbox) -> Self {
            Self {
                command: sandbox.executable_on_path("git"),
                environment: sandbox
                    .environment([("GIT_CONFIG_NOSYSTEM", "1")])
                    .into_iter()
                    .map(|(key, value)| (key.into(), value.into()))
                    .collect(),
            }
        }
    }

    impl crate::git::GitProcessRunner for CapturedGitRunner {
        fn run<'a>(
            &'a self,
            mut request: ProcessRequest,
            cancellation: &'a CancellationToken,
        ) -> crate::git::BoxGitProcessFuture<'a> {
            request.command.clone_from(&self.command);
            let mut environment = self.environment.clone();
            environment.extend(request.env);
            request.env = environment;
            Box::pin(async move { ProcessRunner.run(request, cancellation).await })
        }
    }

    struct FixtureGitRunner {
        outputs: Mutex<VecDeque<crate::git::ProcessOutput>>,
    }

    impl FixtureGitRunner {
        fn main_branch_push() -> Self {
            Self {
                outputs: Mutex::new(
                    [
                        crate::git::ProcessOutput {
                            exit_code: 0,
                            stdout: "main\n".to_owned(),
                            stderr: String::new(),
                            stdout_truncated: false,
                            stderr_truncated: false,
                        },
                        crate::git::ProcessOutput {
                            exit_code: 1,
                            stdout: String::new(),
                            stderr: String::new(),
                            stdout_truncated: false,
                            stderr_truncated: false,
                        },
                        crate::git::ProcessOutput {
                            exit_code: 0,
                            stdout: String::new(),
                            stderr: String::new(),
                            stdout_truncated: false,
                            stderr_truncated: false,
                        },
                    ]
                    .into(),
                ),
            }
        }
    }

    impl crate::git::GitProcessRunner for FixtureGitRunner {
        fn run<'a>(
            &'a self,
            _request: ProcessRequest,
            _cancellation: &'a CancellationToken,
        ) -> crate::git::BoxGitProcessFuture<'a> {
            let output = self
                .outputs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop_front()
                .expect("fixture Git output");
            Box::pin(async move { Ok(output) })
        }
    }

    async fn unary(services: &GitVcsRpcServices, tag: &str, payload: Value) -> RpcResult {
        services
            .handle_unary_with_context(
                rpc_request(tag, payload),
                RpcSessionContext::unauthenticated(),
                CancellationToken::new(),
            )
            .await
    }

    #[tokio::test]
    async fn workspace_loss_cancels_an_admitted_git_operation_with_the_exact_error() {
        let registry = WorkspaceAvailabilityRegistry::new();
        let path = PathBuf::from("/repo/worktrees/git-guard");
        let admission = registry
            .acquire_path_admission([path.as_path()])
            .await
            .expect("Git operation should be admitted before loss");
        let operation_cancellation = CancellationToken::new();
        let operation_cancellation_probe = operation_cancellation.clone();
        let task = tokio::spawn(async move {
            await_git_rpc_operation(
                Some(&admission),
                operation_cancellation,
                std::future::pending::<RpcResult>(),
            )
            .await
        });

        assert!(
            registry
                .mark_unavailable(crate::worktree_catalog::WorkspaceLossTransition {
                    thread_id: "thread-git".to_owned(),
                    repository_key: "repository-git".to_owned(),
                    generation: 1,
                    path: path.clone(),
                    availability:
                        crate::worktree_catalog::AdoptedWorktreeAvailability::MissingRegistered,
                })
                .await
                .expect("physical identity resolves")
        );

        let error = task
            .await
            .expect("Git admission task should join")
            .expect_err("workspace loss must win over the admitted Git operation");
        assert_eq!(error["_tag"], "WorkspaceUnavailableError");
        assert_eq!(error["threadId"], "thread-git");
        assert!(operation_cancellation_probe.is_cancelled());
    }

    #[tokio::test]
    async fn workspace_loss_ends_an_admitted_status_stream_with_the_exact_error() {
        let sandbox = crate::test_support::TestSandbox::new("workspace-loss-status");
        git(&sandbox, sandbox.root(), &["init", "-b", "main"]).await;
        let registry = WorkspaceAvailabilityRegistry::new();
        let repository = Arc::new(GitRepository::with_runner_for_test(Arc::new(
            CapturedGitRunner::new(&sandbox),
        )));
        let services = GitVcsRpcServices::with_repository(repository)
            .with_availability_registry(registry.clone());
        let mut stream = services.status_stream(
            rpc_request("subscribeVcsStatus", json!({"cwd": sandbox.root()})),
            CancellationToken::new(),
        );
        stream
            .recv()
            .await
            .expect("initial status chunk")
            .expect("initial status snapshot");

        assert!(
            registry
                .mark_unavailable(crate::worktree_catalog::WorkspaceLossTransition {
                    thread_id: "thread-status".to_owned(),
                    repository_key: "repository-status".to_owned(),
                    generation: 1,
                    path: sandbox.root().to_path_buf(),
                    availability:
                        crate::worktree_catalog::AdoptedWorktreeAvailability::MissingRegistered,
                })
                .await
                .expect("physical identity resolves")
        );

        let error = stream
            .recv()
            .await
            .expect("workspace loss error chunk")
            .expect_err("workspace loss must end the admitted status stream");
        assert_eq!(error["_tag"], "WorkspaceUnavailableError");
        assert_eq!(error["threadId"], "thread-status");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn github_cli_and_git_runner_fixtures_are_instance_owned_in_parallel() {
        async fn publish(label: &str) -> (Value, Value) {
            let sandbox = crate::test_support::TestSandbox::new(label);
            let github_command = sandbox.executable_script(
                "gh",
                &format!(
                    "case \"$1:$2\" in\n  repo:view) printf '%s\\n' '{{\"nameWithOwner\":\"owner/{label}\",\"url\":\"https://github.test/owner/{label}\",\"sshUrl\":\"git@github.test:owner/{label}.git\"}}' ;;\n  repo:create) exit 0 ;;\n  *) exit 64 ;;\nesac"
                ),
                "",
            );
            let repository = Arc::new(GitRepository::with_runner_for_test(Arc::new(
                FixtureGitRunner::main_branch_push(),
            )));
            let services =
                GitVcsRpcServices::with_repository_and_github_command(repository, github_command);
            let cwd = sandbox.root().to_path_buf();
            let lookup = unary(
                &services,
                "sourceControl.lookupRepository",
                json!({
                    "provider":"github",
                    "repository":format!("owner/{label}"),
                    "cwd":cwd,
                }),
            )
            .await
            .expect("GitHub lookup fixture should resolve");
            let published = unary(
                &services,
                "sourceControl.publishRepository",
                json!({
                    "cwd":sandbox.root(),
                    "provider":"github",
                    "repository":format!("owner/{label}"),
                    "visibility":"private",
                    "protocol":"ssh",
                    "remoteName":"origin"
                }),
            )
            .await
            .expect("GitHub publish fixture should use its owned Git runner");
            (lookup, published)
        }

        let ((left_lookup, left_published), (right_lookup, right_published)) =
            tokio::join!(publish("left"), publish("right"));
        assert_eq!(left_lookup["nameWithOwner"], "owner/left");
        assert_eq!(right_lookup["nameWithOwner"], "owner/right");
        assert_eq!(left_published["branch"], "main");
        assert_eq!(right_published["branch"], "main");
    }

    #[tokio::test]
    async fn native_git_vcs_service_covers_repository_lifecycle_and_validation_paths() {
        let sandbox = crate::test_support::TestSandbox::new("native-git-vcs");
        let repository = sandbox.root().join("repository");
        tokio::fs::create_dir_all(&repository)
            .await
            .expect("repository directory should create");
        let cwd = repository.to_string_lossy().into_owned();
        let git_repository = Arc::new(GitRepository::with_runner_for_test(Arc::new(
            CapturedGitRunner::new(&sandbox),
        )));
        let mut services = GitVcsRpcServices::with_repository(git_repository);

        assert!(
            unary(&services, "vcs.init", json!({"cwd":cwd,"kind":"mercurial"}),)
                .await
                .is_err()
        );
        assert_eq!(
            unary(&services, "vcs.init", json!({"cwd":cwd,"kind":"git"}))
                .await
                .expect("repository should initialize"),
            Value::Null,
        );
        git(
            &sandbox,
            &repository,
            &["config", "user.name", "BiBCode Test"],
        )
        .await;
        git(
            &sandbox,
            &repository,
            &["config", "user.email", "bibcode@example.test"],
        )
        .await;

        tokio::fs::write(repository.join("tracked.txt"), "first\n")
            .await
            .expect("tracked file should write");
        let status = unary(&services, "vcs.refreshStatus", json!({"cwd":cwd}))
            .await
            .expect("status should refresh");
        assert!(
            status["workingTree"]["files"]
                .as_array()
                .is_some_and(|files| !files.is_empty())
        );
        assert_eq!(
            unary(
                &services,
                "vcs.generateCommitMessage",
                json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
            )
            .await
            .expect("commit message should generate")["message"],
            "Update tracked.txt",
        );
        assert_eq!(
            unary(
                &services,
                "vcs.stageFiles",
                json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
            )
            .await
            .expect("file should stage"),
            Value::Null,
        );
        git(
            &sandbox,
            &repository,
            &["commit", "--quiet", "-m", "initial"],
        )
        .await;
        git(&sandbox, &repository, &["branch", "-M", "main"]).await;

        let refs = unary(
            &services,
            "vcs.listRefs",
            json!({
                "cwd":cwd,
                "query":"",
                "cursor":0,
                "limit":500,
                "includeMatchingRemoteRefs":true,
                "refKind":"branch",
            }),
        )
        .await
        .expect("refs should list");
        assert!(
            refs["refs"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        );
        let commits = unary(
            &services,
            "vcs.listCommits",
            json!({"cwd":cwd,"cursor":0,"limit":500}),
        )
        .await
        .expect("commits should list");
        assert!(
            commits["commits"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        );

        assert_eq!(
            unary(
                &services,
                "vcs.createRef",
                json!({"cwd":cwd,"refName":"feature","switchRef":true}),
            )
            .await
            .expect("feature ref should create")["refName"],
            "feature",
        );
        assert_eq!(
            unary(
                &services,
                "vcs.switchRef",
                json!({"cwd":cwd,"refName":"main"}),
            )
            .await
            .expect("base ref should switch")["refName"],
            "main",
        );

        tokio::fs::write(repository.join("tracked.txt"), "second\n")
            .await
            .expect("tracked file should change");
        unary(
            &services,
            "vcs.stageFiles",
            json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
        )
        .await
        .expect("changed file should stage");
        unary(
            &services,
            "vcs.unstageFiles",
            json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
        )
        .await
        .expect("changed file should unstage");
        unary(
            &services,
            "vcs.discardFiles",
            json!({"cwd":cwd,"filePaths":["tracked.txt"]}),
        )
        .await
        .expect("changed file should discard");

        let clone_parent = sandbox.root().join("clones");
        tokio::fs::create_dir_all(&clone_parent)
            .await
            .expect("clone parent should create");
        let cloned = unary(
            &services,
            "vcs.clone",
            json!({
                "url":repository,
                "parentDir":clone_parent,
                "directoryName":"copy",
            }),
        )
        .await
        .expect("repository should clone");
        assert!(
            cloned["path"]
                .as_str()
                .is_some_and(|path| path.ends_with("copy"))
        );

        assert!(
            unary(&services, "vcs.pull", json!({"cwd":cwd}))
                .await
                .is_err()
        );
        assert!(
            unary(
                &services,
                "git.resolvePullRequest",
                json!({"cwd":cwd,"reference":"current"}),
            )
            .await
            .is_err()
        );
        assert!(
            unary(
                &services,
                "sourceControl.lookupRepository",
                json!({"provider":"unknown","repository":"owner/name","cwd":cwd}),
            )
            .await
            .is_err()
        );
        let source_clone = sandbox.root().join("source-clone");
        assert!(
            unary(
                &services,
                "sourceControl.cloneRepository",
                json!({
                    "remoteUrl":format!("file://{}", repository.display()),
                    "destinationPath":source_clone,
                }),
            )
            .await
            .expect("source repository should clone")["cwd"]
                .is_string()
        );
        assert!(
            unary(
                &services,
                "sourceControl.publishRepository",
                json!({
                    "cwd":cwd,
                    "provider":"github",
                    "repository":"owner/name",
                    "visibility":"friends-only",
                }),
            )
            .await
            .is_err()
        );
        assert!(
            unary(
                &services,
                "git.preparePullRequestThread",
                json!({
                    "cwd":cwd,
                    "reference":"current",
                    "mode":"unsupported",
                    "threadId":"thread-1",
                }),
            )
            .await
            .is_err()
        );
        assert!(
            unary(
                &services,
                "shell.openInEditor",
                json!({"cwd":cwd,"editor":"missing-editor"}),
            )
            .await
            .is_err()
        );
        assert!(unary(&services, "unknown.method", json!({})).await.is_err());
        assert!(
            unary(&services, "vcs.listRefs", json!({"cwd":42}))
                .await
                .is_err()
        );

        let mut invalid_status = services.status_stream(
            rpc_request("subscribeVcsStatus", json!({"cwd":42})),
            CancellationToken::new(),
        );
        assert!(invalid_status.recv().await.expect("status error").is_err());
        let mut invalid_action = services.stacked_action_stream(
            rpc_request("git.runStackedAction", json!({"actionId":"invalid"})),
            CancellationToken::new(),
        );
        assert!(invalid_action.recv().await.expect("action error").is_err());

        let mut unsupported_action = services.stacked_action_stream(
            rpc_request(
                "git.runStackedAction",
                json!({
                    "actionId":"unsupported-action",
                    "cwd":cwd,
                    "action":"unsupported"
                }),
            ),
            CancellationToken::new(),
        );
        let started = unsupported_action
            .recv()
            .await
            .expect("action start chunk")
            .expect("action start event");
        assert_eq!(started[0]["kind"], "action_started");
        let failed = unsupported_action
            .recv()
            .await
            .expect("action failure chunk")
            .expect("action failure event");
        assert_eq!(failed[0]["kind"], "action_failed");
        assert!(
            failed[0]["message"]
                .as_str()
                .is_some_and(|message| message.contains("Unsupported Git action"))
        );

        let mut unavailable_status = services.status_stream(
            rpc_request("subscribeVcsStatus", json!({"cwd":"\u{0}"})),
            CancellationToken::new(),
        );
        assert!(
            unavailable_status
                .recv()
                .await
                .expect("unavailable status chunk")
                .is_err()
        );

        let branches =
            local_branch_names(&services.repository, &repository, &CancellationToken::new())
                .await
                .expect("local branches should list");
        assert!(branches.iter().any(|branch| branch == "main"));
        assert_eq!(
            sanitize_branch_fragment(" Feature: It's Ready! "),
            "feature-its-ready"
        );
        assert_eq!(sanitize_branch_fragment("..."), "update");
        assert_eq!(
            sanitize_feature_branch_name("Ready Now"),
            "feature/ready-now"
        );
        assert_eq!(
            sanitize_feature_branch_name("feature/already"),
            "feature/already",
        );
        assert_eq!(
            resolve_feature_branch_name(
                &["feature/update".to_owned(), "FEATURE/UPDATE-2".to_owned()],
                "feature/update",
            ),
            "feature/update-3",
        );
        assert_eq!(
            action_phases("commit_push_pr", true),
            vec!["branch", "commit", "push", "pr"]
        );
        assert_eq!(action_phases("unknown", false), Vec::<&str>::new());

        let (event_sender, mut event_receiver) = mpsc::channel(1);
        send_event(&event_sender, json!({"kind":"test"}))
            .await
            .expect("stream event should send");
        assert_eq!(
            event_receiver
                .recv()
                .await
                .expect("stream event")
                .expect("successful stream event"),
            vec![json!({"kind":"test"})],
        );
        drop(event_receiver);
        assert!(send_event(&event_sender, json!({})).await.is_err());

        assert_eq!(
            run_provider_json(
                Path::new("/bin/sh"),
                &["-c", "printf '{\"ok\":true}'"],
                Some(&repository),
                CancellationToken::new(),
                "fixture",
                "success",
            )
            .await
            .expect("provider JSON should decode"),
            json!({"ok":true}),
        );
        assert!(
            run_provider_json(
                Path::new("/bin/sh"),
                &["-c", "exit 1"],
                None,
                CancellationToken::new(),
                "fixture",
                "failure",
            )
            .await
            .is_err()
        );
        assert!(
            run_provider_json(
                Path::new("/bin/sh"),
                &["-c", "printf invalid"],
                None,
                CancellationToken::new(),
                "fixture",
                "invalid-json",
            )
            .await
            .is_err()
        );

        #[cfg(unix)]
        {
            let bare_remote = sandbox.root().join("published.git");
            tokio::fs::create_dir(&bare_remote)
                .await
                .expect("bare remote directory");
            git(&sandbox, &bare_remote, &["init", "--bare"]).await;
            let bare_remote_text = bare_remote.to_string_lossy().into_owned();
            git(
                &sandbox,
                &repository,
                &["remote", "add", "origin", bare_remote_text.as_str()],
            )
            .await;

            let gh = sandbox.executable_script(
                "gh",
                r#"case "$1:$2" in
  repo:view)
    printf '%s\n' '{"nameWithOwner":"owner/name","url":"https://github.test/owner/name","sshUrl":"git@github.test:owner/name.git"}'
    ;;
  repo:create)
    exit 0
    ;;
  *)
    exit 64
    ;;
esac
"#,
                "",
            );

            services.github_command = gh;

            let lookup = unary(
                &services,
                "sourceControl.lookupRepository",
                json!({
                    "provider":"github",
                    "repository":"owner/name",
                    "cwd":cwd
                }),
            )
            .await
            .expect("GitHub repository lookup should use the fixture CLI");
            assert_eq!(lookup["nameWithOwner"], "owner/name");

            let published = unary(
                &services,
                "sourceControl.publishRepository",
                json!({
                    "cwd":cwd,
                    "provider":"github",
                    "repository":"owner/name",
                    "visibility":"private",
                    "protocol":"ssh",
                    "remoteName":"origin"
                }),
            )
            .await
            .expect("GitHub repository publish should use the fixture CLI");
            assert_eq!(published["status"], "pushed");
            assert_eq!(published["branch"], "main");
            assert_eq!(published["remoteUrl"], "git@github.com:owner/name.git");
            assert_eq!(published["upstreamBranch"], "origin/main");
        }

        let invalid_action = StackedActionInput {
            action_id: "action-1".to_owned(),
            cwd: repository.clone(),
            action: "unsupported".to_owned(),
            commit_message: None,
            file_paths: None,
            feature_branch: None,
            commit_staged_index_as_is: None,
        };
        assert!(
            run_stacked_action(
                &services.repository,
                &services.pull_requests,
                &invalid_action,
                &CancellationToken::new(),
            )
            .await
            .is_err()
        );
        assert!(matches!(
            editor_launch_strategy(
                "missing-editor",
                vec!["--goto".to_owned(), repository.display().to_string()],
                repository.display().to_string(),
            ),
            EditorLaunchStrategy::Process { .. }
        ));

        assert_eq!(summarize_commit_context("", None), "");
        assert_eq!(
            summarize_commit_context("diff --git a/a.txt b/a.txt\n", None),
            "Update a.txt",
        );
        assert_eq!(
            summarize_commit_context("plain context", None),
            "Update working tree",
        );
        assert!(request_error("method", "detail").is_object());
        assert!(vcs_error("operation", &repository, "detail").is_object());
        assert!(source_control_error("unknown", "lookup", "detail").is_object());
    }

    #[tokio::test]
    async fn every_unary_method_rejects_malformed_payloads_through_its_typed_decoder() {
        let services = GitVcsRpcServices::default();
        for method in GIT_VCS_UNARY_METHODS {
            let result = services
                .handle_unary_with_context(
                    rpc_request(method, json!("not-an-object")),
                    RpcSessionContext::unauthenticated(),
                    CancellationToken::new(),
                )
                .await;
            assert!(
                result.is_err(),
                "{method} unexpectedly accepted a string payload"
            );
        }
    }
}
