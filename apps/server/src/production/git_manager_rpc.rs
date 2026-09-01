//! Registers the Git Manager RPC contract surface.

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    git::{
        FileTrash, GitCommandError, GitManagerBlockedReason, GitRepository, NativeFileTrash,
        ProcessOutput, StatusBroadcaster, canonical_worktree_path_key,
        manager::{
            graph::{
                GitManagerGraphError, MAX_DIFF_BUFFER_SIZE, MAX_DIFF_LINE_CHARACTERS,
                MAX_REASONABLE_DIFF_SIZE, page,
            },
            guards::{GuardInput, evaluate_guards},
            operations::{
                CoAuthor, CommitRequest, DiscardError, DiscardRequest,
                GitManagerOperationError as DomainOperationError, GitManagerOperationRequest,
                commit_arguments, commit_message_body, discard_paths, parse_undo_commit_message,
                run_branch_or_sync_operation,
            },
            refs::{GitManagerRefsError, GitManagerRefsSnapshot, build_refs_snapshot},
        },
        validate_pathspecs,
    },
    persistence::Repositories,
    rpc::{RpcRegistry, RpcRequest, RpcResult, RpcStreamChunk},
    worktree_catalog::{
        CatalogRefreshTrigger, ProjectMutationAttempt, WorkspaceAdmissionLease,
        WorkspaceAvailabilityRegistry, WorktreeCatalogService,
    },
};

static NEXT_DIFF_GENERATION: AtomicU64 = AtomicU64::new(1);
const OPERATION_STREAM_CAPACITY: usize = 8;

pub const GIT_MANAGER_UNARY_METHODS: &[&str] = &[
    "gitManager.commit",
    "gitManager.discard",
    "gitManager.discardPartial",
    "gitManager.getCommits",
    "gitManager.getDiff",
    "gitManager.getRefs",
    "gitManager.getStashes",
    "gitManager.listPullRequests",
    "gitManager.previewMerge",
    "gitManager.stagePartial",
    "gitManager.undoCommit",
    "gitManager.unstagePartial",
];

pub const GIT_MANAGER_STREAM_METHODS: &[&str] =
    &["gitManager.runOperation", "subscribeGitManagerSignal"];

#[derive(Clone, Copy, Debug, Default)]
pub struct GitManagerRpcServices;

impl GitManagerRpcServices {
    #[cfg(test)]
    async fn handle_read_unary(
        self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> RpcResult {
        ConfiguredGitManagerRpcServices::default()
            .handle_read_unary(request, cancellation)
            .await
    }

    #[must_use]
    pub fn with_dependencies(
        repository: Arc<GitRepository>,
        broadcaster: StatusBroadcaster,
        catalog: WorktreeCatalogService,
        repositories: Repositories,
        availability: WorkspaceAvailabilityRegistry,
        trash: Arc<dyn FileTrash>,
    ) -> ConfiguredGitManagerRpcServices {
        ConfiguredGitManagerRpcServices {
            repository,
            broadcaster,
            catalog: Some(catalog),
            repositories: Some(repositories),
            availability: Some(availability),
            trash,
        }
    }
}

#[derive(Clone)]
pub struct ConfiguredGitManagerRpcServices {
    repository: Arc<GitRepository>,
    broadcaster: StatusBroadcaster,
    catalog: Option<WorktreeCatalogService>,
    repositories: Option<Repositories>,
    availability: Option<WorkspaceAvailabilityRegistry>,
    trash: Arc<dyn FileTrash>,
}

impl Default for ConfiguredGitManagerRpcServices {
    fn default() -> Self {
        let repository = Arc::new(GitRepository::default());
        Self {
            broadcaster: StatusBroadcaster::new(repository.clone(), Duration::from_secs(3_600), 8),
            repository,
            catalog: None,
            repositories: None,
            availability: None,
            trash: Arc::new(NativeFileTrash::default()),
        }
    }
}

impl From<GitManagerRpcServices> for ConfiguredGitManagerRpcServices {
    fn from(_services: GitManagerRpcServices) -> Self {
        Self::default()
    }
}

impl ConfiguredGitManagerRpcServices {
    async fn not_implemented_unary(&self, request: RpcRequest) -> RpcResult {
        Err(not_implemented_error(&request.tag))
    }

    fn not_implemented_stream(&self, request: RpcRequest) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(1);
        sender
            .try_send(Err(not_implemented_error(&request.tag)))
            .expect("new Git Manager stub stream accepts its terminal failure");
        receiver
    }

    pub fn operation_stream(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> mpsc::Receiver<RpcStreamChunk> {
        let (sender, receiver) = mpsc::channel(OPERATION_STREAM_CAPACITY);
        let services = self.clone();
        tokio::spawn(async move {
            let input = match decode::<GitManagerOperationRequest>(request.payload, &request.tag) {
                Ok(input) => input,
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    return;
                }
            };
            let operation = input.operation();
            let cwd = input.cwd().to_path_buf();
            let project_id = input.project_id().to_owned();
            let (Some(catalog), Some(repositories), Some(availability)) = (
                services.catalog.clone(),
                services.repositories.clone(),
                services.availability.clone(),
            ) else {
                send_terminal_operation_error(
                    &sender,
                    DomainOperationError {
                        operation: operation.to_owned(),
                        code: "service-unavailable".to_owned(),
                        message: "Git Manager operations are unavailable in this server runtime."
                            .to_owned(),
                        blocked: None,
                        outputs: Vec::new(),
                    },
                )
                .await;
                return;
            };
            let resolved_project_id = match resolve_project_id(&repositories, &cwd).await {
                Ok(resolved_project_id) if resolved_project_id == project_id => resolved_project_id,
                Ok(_) => {
                    send_terminal_operation_error(
                        &sender,
                        DomainOperationError {
                            operation: operation.to_owned(),
                            code: "project-mismatch".to_owned(),
                            message:
                                "The selected checkout does not belong to the requested project."
                                    .to_owned(),
                            blocked: None,
                            outputs: Vec::new(),
                        },
                    )
                    .await;
                    return;
                }
                Err(code) => {
                    send_terminal_operation_error(
                        &sender,
                        DomainOperationError {
                            operation: operation.to_owned(),
                            code: code.to_owned(),
                            message:
                                "The selected checkout is not owned by exactly one BiBCode project."
                                    .to_owned(),
                            blocked: None,
                            outputs: Vec::new(),
                        },
                    )
                    .await;
                    return;
                }
            };
            let admission = match availability.acquire_path_admission([cwd.as_path()]).await {
                Ok(admission) => admission,
                Err(_) => {
                    send_terminal_operation_error(
                        &sender,
                        DomainOperationError {
                            operation: operation.to_owned(),
                            code: "workspace-unavailable".to_owned(),
                            message: "The selected checkout is unavailable.".to_owned(),
                            blocked: None,
                            outputs: Vec::new(),
                        },
                    )
                    .await;
                    return;
                }
            };
            if sender
                .send(Ok(vec![json!({
                    "_tag": "started",
                    "operation": operation,
                })]))
                .await
                .is_err()
            {
                return;
            }

            debug_assert_eq!(resolved_project_id, project_id);
            let operation_cancellation = cancellation.child_token();
            let loss = admission.loss_cancellation();
            let operation_future = run_branch_or_sync_operation(
                services.repository.clone(),
                services.broadcaster.clone(),
                catalog,
                input,
                operation_cancellation.clone(),
            );
            tokio::pin!(operation_future);
            let result = tokio::select! {
                biased;
                () = loss.cancelled() => {
                    operation_cancellation.cancel();
                    let _ = operation_future.await;
                    Err(DomainOperationError {
                        operation: operation.to_owned(),
                        code: "workspace-unavailable".to_owned(),
                        message: "The selected checkout became unavailable during the operation."
                            .to_owned(),
                        blocked: None,
                        outputs: Vec::new(),
                    })
                }
                result = &mut operation_future => result,
            };
            match result {
                Ok(outcome) => {
                    if send_operation_outputs(&sender, &outcome.operation, &outcome.outputs)
                        .await
                        .is_err()
                    {
                        return;
                    }
                    let _ = sender
                        .send(Ok(vec![json!({
                            "_tag": "finished",
                            "operation": outcome.operation,
                            "message": outcome.message,
                        })]))
                        .await;
                }
                Err(error) => send_terminal_operation_error(&sender, error).await,
            }
        });
        receiver
    }

    async fn handle_read_unary(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> RpcResult {
        match request.tag.as_str() {
            "gitManager.getRefs" => {
                let input: GitManagerCwdInput = decode(request.payload, &request.tag)?;
                encode_result(
                    build_refs_snapshot(&self.repository, &input.cwd, &cancellation)
                        .await
                        .map_err(|error| refs_error(&request.tag, error)),
                )
            }
            "gitManager.getCommits" => {
                let input: GitManagerGetCommitsInput = decode(request.payload, &request.tag)?;
                encode_result(
                    page(
                        &self.repository,
                        &input.cwd,
                        input.pinned_tips.as_deref(),
                        input.offset.unwrap_or(0),
                        input.limit.unwrap_or(100),
                        &cancellation,
                    )
                    .await
                    .map_err(|error| graph_error(&request.tag, error)),
                )
            }
            "gitManager.getDiff" => {
                let input: GitManagerGetDiffInput = decode(request.payload, &request.tag)?;
                get_diff(&self.repository, input, &cancellation).await
            }
            _ => self.not_implemented_unary(request).await,
        }
    }

    async fn handle_mutation_unary(
        &self,
        request: RpcRequest,
        cancellation: CancellationToken,
    ) -> RpcResult {
        match request.tag.as_str() {
            "gitManager.commit" => {
                let input: GitManagerCommitInput = decode(request.payload, &request.tag)?;
                validate_commit_input(&input)?;
                let commit = CommitRequest {
                    summary: input.summary,
                    description: Some(input.description),
                    amend: input.amend,
                    no_verify: input.no_verify,
                    signoff: input.signoff,
                    allow_empty: input.allow_empty,
                    co_authors: input.co_authors,
                };
                let args = commit_arguments(&commit);
                let message = commit_message_body(&commit).into_bytes();
                let allow_empty = commit.allow_empty;
                self.run_mutation(
                    "gitManager.commit",
                    input.cwd,
                    cancellation,
                    move |services, cwd, token| async move {
                        let snapshot = services
                            .refs_snapshot("gitManager.commit", &cwd, &token)
                            .await?;
                        if let Some(reason) = operation_blocked(&snapshot, "commit") {
                            return Err(blocked_error("gitManager.commit", reason));
                        }
                        let outcome = services
                            .repository
                            .commit_with_options(&cwd, &args, &message, allow_empty, &token)
                            .await
                            .map_err(|error| mutation_git_error("gitManager.commit", error))?;
                        Ok(json!({ "sha": outcome.sha, "empty": outcome.empty }))
                    },
                )
                .await
            }
            "gitManager.undoCommit" => {
                let input: GitManagerCwdInput = decode(request.payload, &request.tag)?;
                self.run_mutation(
                    "gitManager.undoCommit",
                    input.cwd,
                    cancellation,
                    move |services, cwd, token| async move {
                        let snapshot = services
                            .refs_snapshot("gitManager.undoCommit", &cwd, &token)
                            .await?;
                        if let Some(reason) = operation_blocked(&snapshot, "undo-commit") {
                            return Err(blocked_error("gitManager.undoCommit", reason));
                        }
                        let current = snapshot
                            .local_branches
                            .iter()
                            .find(|reference| reference.current)
                            .ok_or_else(|| {
                                operation_error(
                                    "gitManager.undoCommit",
                                    "commit-not-local",
                                    "Undo is blocked: HEAD is not a local branch commit.",
                                )
                            })?;
                        if current.upstream.is_some() && current.ahead == 0 {
                            return Err(operation_error(
                                "gitManager.undoCommit",
                                "commit-not-local",
                                "Undo is blocked: the HEAD commit is not local.",
                            ));
                        }
                        if !services
                            .repository
                            .git_manager_head_tags(&cwd, &token)
                            .await
                            .map_err(|error| mutation_git_error("gitManager.undoCommit", error))?
                            .is_empty()
                        {
                            return Err(operation_error(
                                "gitManager.undoCommit",
                                "tagged-commit",
                                "Undo is blocked: the HEAD commit has a tag.",
                            ));
                        }
                        let undone = services
                            .repository
                            .undo_head_commit(&cwd, &token)
                            .await
                            .map_err(|error| mutation_git_error("gitManager.undoCommit", error))?;
                        let mut draft = parse_undo_commit_message(&undone.message);
                        if draft.summary.trim().is_empty() {
                            draft.summary = "(no commit message)".to_owned();
                        }
                        Ok(json!({
                            "summary": draft.summary,
                            "description": draft.description,
                            "coAuthors": draft.co_authors,
                        }))
                    },
                )
                .await
            }
            "gitManager.discard" => {
                let input: GitManagerDiscardInput = decode(request.payload, &request.tag)?;
                if input.paths.is_empty() {
                    return Err(operation_error(
                        "gitManager.discard",
                        "invalid-request",
                        "At least one discard path is required.",
                    ));
                }
                validate_pathspecs("GitManager.discard", &input.cwd, &input.paths).map_err(
                    |_| {
                        operation_error(
                            "gitManager.discard",
                            "invalid-path",
                            "A requested discard path is invalid.",
                        )
                    },
                )?;
                let trash = self.trash.clone();
                self.run_mutation(
                    "gitManager.discard",
                    input.cwd.clone(),
                    cancellation,
                    move |services, cwd, token| async move {
                        let snapshot = services
                            .refs_snapshot("gitManager.discard", &cwd, &token)
                            .await?;
                        if let Some(reason) = operation_blocked(&snapshot, "discard") {
                            return Err(blocked_error("gitManager.discard", reason));
                        }
                        let outcome = discard_paths(
                            &services.repository,
                            trash,
                            DiscardRequest {
                                cwd,
                                paths: input.paths,
                                permit_permanent: input.permit_permanent,
                            },
                            &token,
                        )
                        .await
                        .map_err(|error| discard_error("gitManager.discard", error))?;
                        Ok(json!({
                            "trashed": outcome.trashed,
                            "permanentlyDiscarded": outcome.permanently_discarded,
                            "trashUnavailable": outcome.trash_unavailable,
                        }))
                    },
                )
                .await
            }
            _ => self.not_implemented_unary(request).await,
        }
    }

    async fn refs_snapshot(
        &self,
        operation: &str,
        cwd: &std::path::Path,
        cancellation: &CancellationToken,
    ) -> Result<GitManagerRefsSnapshot, Value> {
        build_refs_snapshot(&self.repository, cwd, cancellation)
            .await
            .map_err(|error| refs_error(operation, error))
    }

    async fn run_mutation<F, Fut>(
        &self,
        operation: &'static str,
        cwd: PathBuf,
        cancellation: CancellationToken,
        action: F,
    ) -> RpcResult
    where
        F: FnOnce(Self, PathBuf, CancellationToken) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = RpcResult> + Send + 'static,
    {
        let services = self.clone();
        await_server_owned_mutation(async move {
            let (Some(catalog), Some(repositories), Some(availability)) = (
                services.catalog.clone(),
                services.repositories.clone(),
                services.availability.clone(),
            ) else {
                return Err(operation_error(
                    operation,
                    "service-unavailable",
                    "Git Manager commit operations are unavailable in this server runtime.",
                ));
            };
            let project_id = resolve_project_id(&repositories, &cwd)
                .await
                .map_err(|code| {
                    operation_error(
                        operation,
                        code,
                        "The selected checkout is not owned by exactly one BiBCode project.",
                    )
                })?;
            catalog
                .refresh(&project_id, CatalogRefreshTrigger::Explicit)
                .await
                .map_err(|_| {
                    operation_error(
                        operation,
                        "repository-unavailable",
                        "The selected repository could not be revalidated.",
                    )
                })?;
            let admission = availability
                .acquire_path_admission([cwd.as_path()])
                .await
                .map_err(|_| {
                    operation_error(
                        operation,
                        "workspace-unavailable",
                        "The selected checkout is unavailable.",
                    )
                })?;
            let lock_cancellation = cancellation.child_token();
            let operation_cancellation = lock_cancellation.clone();
            let locked_services = services.clone();
            let locked_cwd = cwd.clone();
            match catalog
                .try_with_project_mutation_lock_cancellation(
                    &project_id,
                    &lock_cancellation,
                    || async move {
                        locked_services
                            .run_fenced_mutation(
                                operation,
                                locked_cwd,
                                admission,
                                operation_cancellation,
                                action,
                            )
                            .await
                    },
                )
                .await
            {
                ProjectMutationAttempt::Acquired(result) => result,
                ProjectMutationAttempt::InFlight => Err(blocked_error(
                    operation,
                    GitManagerBlockedReason {
                        operation: operation_guard_name(operation).to_owned(),
                        code: "operation-in-flight".to_owned(),
                        message: "Blocked: another Git Manager operation is already running."
                            .to_owned(),
                    },
                )),
                ProjectMutationAttempt::Cancelled => Err(operation_error(
                    operation,
                    "cancelled",
                    "The Git Manager operation was cancelled before admission.",
                )),
            }
        })
        .await
    }

    async fn run_fenced_mutation<F, Fut>(
        self,
        operation: &'static str,
        cwd: PathBuf,
        admission: WorkspaceAdmissionLease,
        cancellation: CancellationToken,
        action: F,
    ) -> RpcResult
    where
        F: FnOnce(Self, PathBuf, CancellationToken) -> Fut,
        Fut: std::future::Future<Output = RpcResult>,
    {
        let loss = admission.loss_cancellation();
        let mutation = tokio::select! {
            biased;
            () = loss.cancelled() => {
                cancellation.cancel();
                return Err(operation_error(
                    operation,
                    "workspace-unavailable",
                    "The selected checkout became unavailable before mutation.",
                ));
            }
            () = cancellation.cancelled() => {
                return Err(operation_error(
                    operation,
                    "cancelled",
                    "The Git Manager operation was cancelled before mutation.",
                ));
            }
            mutation = self.broadcaster.begin_mutation(&cwd) => mutation,
        };
        let operation_future = action(self, cwd, cancellation.clone());
        tokio::pin!(operation_future);
        let result = tokio::select! {
            biased;
            () = loss.cancelled() => {
                cancellation.cancel();
                let _ = operation_future.await;
                Err(operation_error(
                    operation,
                    "workspace-unavailable",
                    "The selected checkout became unavailable during mutation.",
                ))
            }
            result = &mut operation_future => result,
        };
        mutation.finish().await;
        result
    }
}

pub fn register_git_manager_rpc(
    registry: &mut RpcRegistry,
    services: impl Into<ConfiguredGitManagerRpcServices>,
) {
    let services = services.into();
    for method in GIT_MANAGER_UNARY_METHODS.iter().filter(|method| {
        !matches!(
            **method,
            "gitManager.getRefs"
                | "gitManager.getCommits"
                | "gitManager.getDiff"
                | "gitManager.commit"
                | "gitManager.undoCommit"
                | "gitManager.discard"
        )
    }) {
        let services = services.clone();
        registry.register_unary(*method, move |request, _cancellation| {
            let services = services.clone();
            async move { services.not_implemented_unary(request).await }
        });
    }
    for method in [
        "gitManager.getRefs",
        "gitManager.getCommits",
        "gitManager.getDiff",
    ] {
        let services = services.clone();
        registry.register_unary(method, move |request, cancellation| {
            let services = services.clone();
            async move { services.handle_read_unary(request, cancellation).await }
        });
    }
    for method in [
        "gitManager.commit",
        "gitManager.undoCommit",
        "gitManager.discard",
    ] {
        let services = services.clone();
        registry.register_unary(method, move |request, cancellation| {
            let services = services.clone();
            async move { services.handle_mutation_unary(request, cancellation).await }
        });
    }

    for method in GIT_MANAGER_STREAM_METHODS
        .iter()
        .filter(|method| **method != "gitManager.runOperation")
    {
        let services = services.clone();
        registry.register_stream(*method, move |request, _cancellation| {
            let services = services.clone();
            services.not_implemented_stream(request)
        });
    }
    let operation_services = services.clone();
    registry.register_stream("gitManager.runOperation", move |request, cancellation| {
        operation_services.operation_stream(request, cancellation)
    });
}

async fn send_operation_outputs(
    sender: &mpsc::Sender<RpcStreamChunk>,
    operation: &str,
    outputs: &[ProcessOutput],
) -> Result<(), ()> {
    for output in outputs {
        for (stream, text) in [("stdout", &output.stdout), ("stderr", &output.stderr)] {
            if text.is_empty() {
                continue;
            }
            sender
                .send(Ok(vec![json!({
                    "_tag": "output",
                    "operation": operation,
                    "stream": stream,
                    "text": text,
                })]))
                .await
                .map_err(|_| ())?;
        }
    }
    Ok(())
}

async fn send_terminal_operation_error(
    sender: &mpsc::Sender<RpcStreamChunk>,
    error: DomainOperationError,
) {
    if send_operation_outputs(sender, &error.operation, &error.outputs)
        .await
        .is_err()
    {
        return;
    }
    let _ = sender
        .send(Ok(vec![json!({
            "_tag": "failed",
            "operation": error.operation,
            "code": error.code,
            "message": error.message,
            "blocked": error.blocked,
        })]))
        .await;
}

#[derive(Deserialize)]
struct GitManagerCwdInput {
    cwd: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitManagerCommitInput {
    cwd: PathBuf,
    summary: String,
    description: String,
    amend: bool,
    no_verify: bool,
    signoff: bool,
    allow_empty: bool,
    co_authors: Vec<CoAuthor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitManagerDiscardInput {
    cwd: PathBuf,
    paths: Vec<String>,
    permit_permanent: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitManagerGetCommitsInput {
    cwd: PathBuf,
    pinned_tips: Option<Vec<String>>,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "_tag", rename_all = "kebab-case")]
enum GitManagerDiffSource {
    WorkingTree { path: String, staged: bool },
    Commit { sha: String, path: String },
    Stash { sha: String, path: String },
}

impl GitManagerDiffSource {
    fn path(&self) -> &str {
        match self {
            Self::WorkingTree { path, .. }
            | Self::Commit { path, .. }
            | Self::Stash { path, .. } => path,
        }
    }
}

#[derive(Deserialize)]
struct GitManagerGetDiffInput {
    cwd: PathBuf,
    source: GitManagerDiffSource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DiffSizeClass {
    Patch,
    LargeText,
    Unrenderable,
}

fn validate_commit_input(input: &GitManagerCommitInput) -> Result<(), Value> {
    if input.summary.trim().is_empty() || input.summary.trim() != input.summary {
        return Err(operation_error(
            "gitManager.commit",
            "invalid-request",
            "The commit summary must be trimmed and non-empty.",
        ));
    }
    if input.co_authors.iter().any(|author| {
        author.name.trim().is_empty()
            || author.name.trim() != author.name
            || author.email.trim().is_empty()
            || author.email.trim() != author.email
    }) {
        return Err(operation_error(
            "gitManager.commit",
            "invalid-request",
            "Every co-author must have a trimmed non-empty name and email.",
        ));
    }
    Ok(())
}

async fn resolve_project_id(
    repositories: &Repositories,
    cwd: &std::path::Path,
) -> Result<String, &'static str> {
    let requested_key = canonical_worktree_path_key(cwd)
        .await
        .map_err(|_| "project-resolution-failed")?;
    let projects = repositories
        .list_projects()
        .await
        .map_err(|_| "project-resolution-failed")?;
    let mut matched = None;
    for project in projects
        .into_iter()
        .filter(|project| project.deleted_at.is_none())
    {
        let root_matches =
            canonical_worktree_path_key(std::path::Path::new(&project.workspace_root))
                .await
                .is_ok_and(|key| key == requested_key);
        let mut thread_matches = false;
        if !root_matches {
            for path in repositories
                .list_threads_by_project(project.project_id.clone())
                .await
                .map_err(|_| "project-resolution-failed")?
                .into_iter()
                .filter(|thread| thread.deleted_at.is_none())
                .filter_map(|thread| thread.worktree_path)
            {
                if canonical_worktree_path_key(std::path::Path::new(&path))
                    .await
                    .is_ok_and(|key| key == requested_key)
                {
                    thread_matches = true;
                    break;
                }
            }
        }
        if root_matches || thread_matches {
            if matched.is_some() {
                return Err("project-ambiguous");
            }
            matched = Some(project.project_id);
        }
    }
    matched.ok_or("project-not-found")
}

fn operation_blocked(
    snapshot: &GitManagerRefsSnapshot,
    operation: &str,
) -> Option<GitManagerBlockedReason> {
    evaluate_guards(&GuardInput::from_snapshot(snapshot, false))
        .into_values()
        .flatten()
        .find(|reason| reason.operation == operation)
}

fn operation_guard_name(operation: &str) -> &'static str {
    match operation {
        "gitManager.commit" => "commit",
        "gitManager.undoCommit" => "undo-commit",
        "gitManager.discard" => "discard",
        _ => "git-manager-mutation",
    }
}

fn blocked_error(operation: &str, reason: GitManagerBlockedReason) -> Value {
    json!({
        "_tag": "GitManagerOperationError",
        "operation": operation,
        "code": reason.code,
        "message": reason.message,
        "blocked": reason,
    })
}

fn mutation_git_error(operation: &str, _error: GitCommandError) -> Value {
    operation_error(
        operation,
        "git-command-failed",
        "Git could not complete the requested mutation.",
    )
}

fn discard_error(operation: &str, error: DiscardError) -> Value {
    match error {
        DiscardError::Git(error) => mutation_git_error(operation, error),
    }
}

async fn await_server_owned_mutation(
    operation: impl std::future::Future<Output = RpcResult> + Send + 'static,
) -> RpcResult {
    match tokio::spawn(operation).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(_) => Err(operation_error(
            "gitManager.mutation",
            "operation-ended",
            "The server-owned Git Manager operation ended without a result.",
        )),
    }
}

async fn get_diff(
    repository: &GitRepository,
    input: GitManagerGetDiffInput,
    cancellation: &CancellationToken,
) -> RpcResult {
    let operation = "gitManager.getDiff";
    validate_pathspecs(
        "GitManager.getDiff",
        &input.cwd,
        &[input.source.path().to_owned()],
    )
    .map_err(|_| {
        operation_error(
            operation,
            "invalid-path",
            "The requested diff path is invalid.",
        )
    })?;
    let output = match &input.source {
        GitManagerDiffSource::WorkingTree { path, staged } => {
            let mut output = repository
                .git_manager_working_tree_diff(&input.cwd, path, *staged, cancellation)
                .await
                .map_err(|error| git_error(operation, error))?;
            if output.stdout.is_empty() && !*staged {
                let untracked = repository
                    .git_manager_untracked_paths(&input.cwd, path, cancellation)
                    .await
                    .map_err(|error| git_error(operation, error))?;
                if !untracked.stdout.is_empty() {
                    output = repository
                        .git_manager_untracked_diff(&input.cwd, path, cancellation)
                        .await
                        .map_err(|error| git_error(operation, error))?;
                    if !matches!(output.exit_code, 0 | 1) {
                        return Err(operation_error(
                            operation,
                            "git-command-failed",
                            "Git could not read the untracked file diff.",
                        ));
                    }
                }
            }
            output
        }
        GitManagerDiffSource::Commit { sha, path } => {
            if !valid_object_id(sha) {
                return Err(operation_error(
                    operation,
                    "invalid-commit",
                    "The requested commit identifier is invalid.",
                ));
            }
            repository
                .git_manager_commit_diff(&input.cwd, sha, path, cancellation)
                .await
                .map_err(|error| git_error(operation, error))?
        }
        GitManagerDiffSource::Stash { .. } => {
            return Err(operation_error(
                operation,
                "not-implemented-yet",
                "Stash diffs are not implemented until Git Manager PHASE-09.",
            ));
        }
    };
    Ok(render_diff(input.source, output))
}

fn render_diff(source: GitManagerDiffSource, output: ProcessOutput) -> Value {
    let truncated = output.stdout_truncated;
    let byte_length = if truncated {
        MAX_DIFF_BUFFER_SIZE + 1
    } else {
        output.stdout.len()
    };
    let longest_line_length = if byte_length <= MAX_REASONABLE_DIFF_SIZE {
        output
            .stdout
            .lines()
            .map(|line| line.chars().count())
            .max()
            .unwrap_or(0)
    } else {
        0
    };
    let metadata = json!({
        "generation": NEXT_DIFF_GENERATION.fetch_add(1, Ordering::Relaxed),
        "source": source,
        "byteLength": byte_length,
        "longestLineLength": longest_line_length,
    });
    let mut value = match classify_diff_size(byte_length, longest_line_length, truncated) {
        DiffSizeClass::Patch => json!({
            "_tag": "patch",
            "patch": output.stdout,
        }),
        DiffSizeClass::LargeText => json!({ "_tag": "large-text" }),
        DiffSizeClass::Unrenderable => json!({ "_tag": "unrenderable" }),
    };
    if let (Some(value), Some(metadata)) = (value.as_object_mut(), metadata.as_object()) {
        value.extend(metadata.clone());
    }
    value
}

fn classify_diff_size(
    byte_length: usize,
    longest_line_length: usize,
    truncated: bool,
) -> DiffSizeClass {
    if truncated || byte_length > MAX_DIFF_BUFFER_SIZE {
        DiffSizeClass::Unrenderable
    } else if byte_length > MAX_REASONABLE_DIFF_SIZE
        || longest_line_length > MAX_DIFF_LINE_CHARACTERS
    {
        DiffSizeClass::LargeText
    } else {
        DiffSizeClass::Patch
    }
}

fn valid_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn decode<T: for<'de> Deserialize<'de>>(payload: Value, operation: &str) -> Result<T, Value> {
    serde_json::from_value(payload).map_err(|_| {
        operation_error(
            operation,
            "invalid-request",
            "The Git Manager request is invalid.",
        )
    })
}

fn encode_result<T: Serialize>(result: Result<T, Value>) -> RpcResult {
    result.and_then(|value| {
        serde_json::to_value(value).map_err(|_| {
            operation_error(
                "gitManager.read",
                "serialization-failed",
                "The Git Manager result could not be encoded.",
            )
        })
    })
}

fn refs_error(operation: &str, error: GitManagerRefsError) -> Value {
    match error {
        GitManagerRefsError::Git(error) => git_error(operation, error),
        GitManagerRefsError::MalformedRefs | GitManagerRefsError::Worktrees(_) => operation_error(
            operation,
            "malformed-git-output",
            "Git returned malformed repository ref state.",
        ),
        GitManagerRefsError::RepositoryState(_) => operation_error(
            operation,
            "repository-state-unavailable",
            "Git repository operation state could not be inspected.",
        ),
    }
}

fn graph_error(operation: &str, error: GitManagerGraphError) -> Value {
    match error {
        GitManagerGraphError::TipsUnresolvable => operation_error(
            operation,
            "history-tips-unresolvable",
            "The pinned history snapshot is no longer available; refresh the history.",
        ),
        GitManagerGraphError::MalformedHistory => operation_error(
            operation,
            "malformed-git-output",
            "Git returned malformed commit history.",
        ),
        GitManagerGraphError::Git(error) => git_error(operation, error),
    }
}

fn git_error(operation: &str, _error: GitCommandError) -> Value {
    operation_error(
        operation,
        "git-command-failed",
        "Git could not complete the requested read.",
    )
}

fn operation_error(operation: &str, code: &str, message: &str) -> Value {
    json!({
        "_tag": "GitManagerOperationError",
        "operation": operation,
        "code": code,
        "message": message,
        "blocked": null,
    })
}

fn not_implemented_error(operation: &str) -> Value {
    json!({
        "_tag": "GitManagerOperationError",
        "operation": operation,
        "code": "not-implemented",
        "message": "This Git Manager operation is not implemented yet.",
        "blocked": null,
    })
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, process::Command, sync::Arc, time::Duration};

    use tempfile::TempDir;
    use tokio::sync::{Semaphore, oneshot};

    use super::*;
    use crate::{
        persistence::{Database, ProjectionProject, Repositories, run_migrations},
        rpc::{ACTIVE_RPC_METHODS, MethodMode, RequestId},
        worktree_catalog::{WorkspaceAvailabilityRegistry, WorktreeCatalogService},
    };

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git test fixture starts");
        assert!(
            output.status.success(),
            "git fixture command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository_with_change() -> TempDir {
        let repository = TempDir::new().expect("temporary repository");
        git(repository.path(), &["init", "-q", "-b", "main"]);
        git(
            repository.path(),
            &["config", "user.name", "Git Manager Test"],
        );
        git(
            repository.path(),
            &["config", "user.email", "git-manager@example.test"],
        );
        fs::write(repository.path().join("tracked.txt"), "base\n").expect("base file");
        git(repository.path(), &["add", "tracked.txt"]);
        git(repository.path(), &["commit", "-q", "-m", "base"]);
        fs::write(repository.path().join("tracked.txt"), "changed\n").expect("changed file");
        repository
    }

    fn request(tag: &str, payload: Value) -> RpcRequest {
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

    fn registry_with_non_git_manager_methods() -> RpcRegistry {
        let mut registry = RpcRegistry::empty();
        for method in ACTIVE_RPC_METHODS
            .iter()
            .filter(|method| !method.name.starts_with("gitManager."))
            .filter(|method| method.name != "subscribeGitManagerSignal")
        {
            match method.mode {
                MethodMode::Unary => registry
                    .register_unary(method.name, |_request, _cancellation| async {
                        Ok(json!({}))
                    }),
                MethodMode::Stream => {
                    registry.register_stream(method.name, |_request, _cancellation| {
                        let (_sender, receiver) = mpsc::channel(1);
                        receiver
                    });
                }
            }
        }
        registry
    }

    #[test]
    fn registers_every_git_manager_method_needed_by_production_startup() {
        let mut registry = registry_with_non_git_manager_methods();
        register_git_manager_rpc(&mut registry, GitManagerRpcServices);
        registry
            .validate_complete()
            .expect("the production Git Manager registry is complete");
    }

    #[test]
    fn registry_validation_fails_when_git_manager_registration_is_omitted() {
        let registry = registry_with_non_git_manager_methods();
        let error = registry
            .validate_complete()
            .expect_err("Git Manager methods are required at startup");
        assert!(error.contains("gitManager.commit"));
        assert!(error.contains("subscribeGitManagerSignal"));
    }

    #[test]
    fn diff_size_ladder_uses_the_server_side_contract_boundaries() {
        assert_eq!(
            classify_diff_size(MAX_REASONABLE_DIFF_SIZE, 5_000, false),
            DiffSizeClass::Patch
        );
        assert_eq!(
            classify_diff_size(MAX_REASONABLE_DIFF_SIZE + 1, 0, false),
            DiffSizeClass::LargeText
        );
        assert_eq!(
            classify_diff_size(128, 5_001, false),
            DiffSizeClass::LargeText
        );
        assert_eq!(
            classify_diff_size(MAX_DIFF_BUFFER_SIZE + 1, 0, true),
            DiffSizeClass::Unrenderable
        );
    }

    #[test]
    fn all_three_read_handlers_require_only_the_read_scope() {
        for method in [
            "gitManager.getRefs",
            "gitManager.getCommits",
            "gitManager.getDiff",
        ] {
            assert_eq!(
                crate::auth::required_scope(method),
                Some("orchestration:read")
            );
        }
    }

    #[tokio::test]
    async fn read_handler_returns_working_tree_and_commit_patches() {
        let repository = repository_with_change();
        let cwd = repository.path().to_string_lossy().into_owned();
        let working = GitManagerRpcServices
            .handle_read_unary(
                request(
                    "gitManager.getDiff",
                    json!({
                        "cwd": cwd,
                        "source": {
                            "_tag": "working-tree",
                            "path": "tracked.txt",
                            "staged": false
                        }
                    }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect("working-tree diff");
        assert_eq!(working["_tag"], "patch");
        assert!(
            working["patch"]
                .as_str()
                .is_some_and(|patch| patch.contains("changed"))
        );

        let sha = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repository.path())
            .output()
            .expect("read commit sha");
        let sha = String::from_utf8(sha.stdout)
            .expect("UTF-8 sha")
            .trim()
            .to_owned();
        let commit = GitManagerRpcServices
            .handle_read_unary(
                request(
                    "gitManager.getDiff",
                    json!({
                        "cwd": cwd,
                        "source": { "_tag": "commit", "sha": sha, "path": "tracked.txt" }
                    }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect("commit diff");
        assert_eq!(commit["_tag"], "patch");
        assert!(
            commit["patch"]
                .as_str()
                .is_some_and(|patch| patch.contains("base"))
        );
    }

    #[tokio::test]
    async fn stash_diff_is_a_clear_later_phase_error() {
        let repository = repository_with_change();
        let error = GitManagerRpcServices
            .handle_read_unary(
                request(
                    "gitManager.getDiff",
                    json!({
                        "cwd": repository.path(),
                        "source": {
                            "_tag": "stash",
                            "sha": "0123456789012345678901234567890123456789",
                            "path": "tracked.txt"
                        }
                    }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect_err("stash diff remains deferred");
        assert_eq!(error["_tag"], "GitManagerOperationError");
        assert_eq!(error["code"], "not-implemented-yet");
    }

    #[tokio::test]
    async fn configured_commit_handler_commits_the_visible_index_without_a_socket() {
        let repository_fixture = repository_with_change();
        git(repository_fixture.path(), &["add", "tracked.txt"]);
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
                project_id: "project-commit".to_owned(),
                title: "Commit".to_owned(),
                workspace_root: repository_fixture.path().to_string_lossy().into_owned(),
                default_model_selection: None,
                scripts: json!([]),
                worktree_discovery: json!({}),
                worktree_repository_key: None,
                created_at: "2026-08-31T00:00:00Z".to_owned(),
                updated_at: "2026-08-31T00:00:00Z".to_owned(),
                deleted_at: None,
            })
            .await
            .expect("project projection");
        let repository = Arc::new(GitRepository::default());
        let broadcaster = StatusBroadcaster::new(repository.clone(), Duration::from_secs(3_600), 8);
        let availability = WorkspaceAvailabilityRegistry::new();
        let catalog = WorktreeCatalogService::new_with_availability_registry(
            Arc::new(repositories.clone()),
            repository.clone(),
            availability.clone(),
        );
        let services = GitManagerRpcServices::with_dependencies(
            repository,
            broadcaster,
            catalog.clone(),
            repositories,
            availability,
            Arc::new(NativeFileTrash::default()),
        );

        let result = services
            .handle_mutation_unary(
                request(
                    "gitManager.commit",
                    json!({
                        "cwd": repository_fixture.path(),
                        "summary": "Visible index commit",
                        "description": "through stdin",
                        "amend": false,
                        "noVerify": false,
                        "signoff": false,
                        "allowEmpty": false,
                        "coAuthors": []
                    }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect("configured commit succeeds");

        assert_eq!(result["empty"], false);
        assert!(result["sha"].as_str().is_some_and(|sha| !sha.is_empty()));
        let message = Command::new("git")
            .args(["log", "-1", "--format=%B"])
            .current_dir(repository_fixture.path())
            .output()
            .expect("read committed message");
        assert_eq!(
            String::from_utf8(message.stdout).expect("UTF-8 commit message"),
            "Visible index commit\n\nthrough stdin\n\n"
        );

        let empty_discard = services
            .handle_mutation_unary(
                request(
                    "gitManager.discard",
                    json!({
                        "cwd": repository_fixture.path(),
                        "paths": [],
                        "permitPermanent": false
                    }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect_err("discard paths are non-empty on the wire");
        assert_eq!(empty_discard["code"], "invalid-request");

        git(
            repository_fixture.path(),
            &["tag", "-a", "protected", "-m", "protected"],
        );
        let tagged_head = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repository_fixture.path())
            .output()
            .expect("read tagged head");
        let tagged_head = String::from_utf8(tagged_head.stdout)
            .expect("UTF-8 tagged head")
            .trim()
            .to_owned();
        let tagged = services
            .handle_mutation_unary(
                request(
                    "gitManager.undoCommit",
                    json!({ "cwd": repository_fixture.path() }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect_err("annotated tags block undo");
        assert_eq!(tagged["code"], "tagged-commit");
        let current_head = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repository_fixture.path())
            .output()
            .expect("read current head");
        assert_eq!(
            String::from_utf8(current_head.stdout)
                .expect("UTF-8 current head")
                .trim(),
            tagged_head
        );
        git(repository_fixture.path(), &["tag", "-d", "protected"]);

        let (entered, entered_rx) = oneshot::channel();
        let release = Arc::new(Semaphore::new(0));
        let held_catalog = catalog.clone();
        let held_release = release.clone();
        let held = tokio::spawn(async move {
            held_catalog
                .with_project_mutation_lock("project-commit", || async move {
                    let _ = entered.send(());
                    held_release
                        .acquire()
                        .await
                        .expect("lock release remains open")
                        .forget();
                })
                .await;
        });
        entered_rx.await.expect("catalog mutation lock acquired");
        let rejected = services
            .handle_mutation_unary(
                request(
                    "gitManager.commit",
                    json!({
                        "cwd": repository_fixture.path(),
                        "summary": "Concurrent commit",
                        "description": "",
                        "amend": false,
                        "noVerify": false,
                        "signoff": false,
                        "allowEmpty": false,
                        "coAuthors": []
                    }),
                ),
                CancellationToken::new(),
            )
            .await
            .expect_err("a held catalog lock rejects the second mutation");
        assert_eq!(rejected["code"], "operation-in-flight");
        assert_eq!(rejected["blocked"]["code"], "operation-in-flight");
        release.add_permits(1);
        held.await.expect("held catalog mutation joins");
    }
}
