//! Serialized Git Manager mutation operations.

use std::{
    collections::BTreeSet,
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::git::{
    GitCommandError, GitManagerBlockedReason, GitManagerInProgressKind, GitManagerRefsSnapshot,
    GitRepository, NETWORK_TRANSFER_STALLED, OutputPolicy, ProcessOutput, ProcessRequest,
    ProcessRunner, StatusBroadcaster, reports_stalled_transfer, validate_pathspecs,
};
use crate::worktree_catalog::{ProjectMutationAttempt, WorktreeCatalogService};

use super::{
    conflicts::ConflictSide,
    guards::{GuardInput, evaluate_guards},
    in_progress::detect_in_progress_operation,
    merge,
    patch::{diff_generation, format_selection_patch, parse_working_tree_diff},
    refs::build_refs_snapshot,
    rewrite::{build_reorder_todo, build_squash_todo, resolve_last_retained_commit_ref},
    stash,
    tags::{self, GitManagerTagError},
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CoAuthor {
    pub name: String,
    pub email: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRequest {
    pub summary: String,
    pub description: Option<String>,
    pub amend: bool,
    pub no_verify: bool,
    pub signoff: bool,
    pub allow_empty: bool,
    pub co_authors: Vec<CoAuthor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UndoCommitDraft {
    pub summary: String,
    pub description: String,
    pub co_authors: Vec<CoAuthor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscardRequest {
    pub cwd: PathBuf,
    pub paths: Vec<String>,
    pub permit_permanent: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DiscardOutcome {
    pub trashed: Vec<String>,
    pub permanently_discarded: Vec<String>,
    pub trash_unavailable: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PartialSelectionRequest {
    pub cwd: PathBuf,
    pub path: String,
    pub selected_lines: Vec<usize>,
    pub base_generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PartialSelectionOutcome {
    pub generation: u64,
    pub patch_byte_length: usize,
    pub fallback_reason: Option<&'static str>,
}

#[derive(Debug, Error)]
pub enum PartialSelectionError {
    #[error(transparent)]
    Git(#[from] GitCommandError),
    #[error("the selected diff generation is stale")]
    Stale,
    #[error("the selected diff is too large to stage safely")]
    DiffTooLarge,
}

const RENAME_WHOLE_FILE_FALLBACK: &str =
    "Partial staging is unavailable for renamed paths; the whole file was staged.";

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("the operating-system trash is unavailable")]
pub struct TrashUnavailable;

pub type FileTrashFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), TrashUnavailable>> + Send + 'a>>;

pub trait FileTrash: Send + Sync {
    fn trash<'a>(
        &'a self,
        path: PathBuf,
        cancellation: &'a CancellationToken,
    ) -> FileTrashFuture<'a>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NativeFileTrash {
    runner: ProcessRunner,
}

impl FileTrash for NativeFileTrash {
    fn trash<'a>(
        &'a self,
        path: PathBuf,
        cancellation: &'a CancellationToken,
    ) -> FileTrashFuture<'a> {
        Box::pin(async move {
            let request = native_trash_request(&path).await?;
            self.runner
                .run(request, cancellation)
                .await
                .map(|_| ())
                .map_err(|_| TrashUnavailable)
        })
    }
}

#[derive(Debug, Error)]
pub enum DiscardError {
    #[error(transparent)]
    Git(#[from] GitCommandError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitManagerFailureCode {
    Completed,
    AlreadyUpToDate,
    Authentication,
    NonFastForward,
    StaleInfo,
    LocalChangesOverwritten,
    Conflicts,
    ConflictsEncountered,
    OutstandingFilesNotStaged,
    NothingToStash,
    StashUntrackedCollision,
    NoUpstream,
    Cancelled,
    TimedOut,
    NetworkStalled,
    Unknown,
}

impl GitManagerFailureCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::AlreadyUpToDate => "already-up-to-date",
            Self::Authentication => "authentication",
            Self::NonFastForward => "non-fast-forward",
            Self::StaleInfo => "stale-info",
            Self::LocalChangesOverwritten => "local-changes-overwritten",
            Self::Conflicts => "conflicts",
            Self::ConflictsEncountered => "conflicts-encountered",
            Self::OutstandingFilesNotStaged => "outstanding-files-not-staged",
            Self::NothingToStash => "nothing-to-stash",
            Self::StashUntrackedCollision => "stash-untracked-collision",
            Self::NoUpstream => "no-upstream",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed-out",
            Self::NetworkStalled => "network-stalled",
            Self::Unknown => "unknown",
        }
    }
}

#[must_use]
pub fn classify_operation_failure(exit_code: i32, stderr: &str) -> GitManagerFailureCode {
    let output = stderr;
    let stderr = output.to_ascii_lowercase();
    if exit_code == 0 && stderr.contains("is up to date") {
        GitManagerFailureCode::AlreadyUpToDate
    } else if exit_code == 0 {
        GitManagerFailureCode::Completed
    } else if stderr.contains("was interrupted") || stderr.contains("cancelled") {
        GitManagerFailureCode::Cancelled
    } else if reports_stalled_transfer(output) {
        GitManagerFailureCode::NetworkStalled
    } else if stderr.contains("timed out") {
        GitManagerFailureCode::TimedOut
    } else if [
        "authentication failed",
        "could not read username",
        "could not read password",
        "permission denied (publickey)",
    ]
    .iter()
    .any(|needle| stderr.contains(needle))
    {
        GitManagerFailureCode::Authentication
    } else if stderr.contains("non-fast-forward") || stderr.contains("updates were rejected") {
        GitManagerFailureCode::NonFastForward
    } else if stderr.contains("stale info") {
        GitManagerFailureCode::StaleInfo
    } else if stderr.contains("your local changes to the following files would be overwritten") {
        GitManagerFailureCode::LocalChangesOverwritten
    } else if stderr.contains("needs merge") || stderr.contains("you must edit all merge conflicts")
    {
        GitManagerFailureCode::OutstandingFilesNotStaged
    } else if stderr.contains("could not restore untracked files from stash") {
        GitManagerFailureCode::StashUntrackedCollision
    } else if stderr.contains("could not apply") {
        GitManagerFailureCode::ConflictsEncountered
    } else if stderr.contains("conflict (") || stderr.contains("automatic merge failed") {
        GitManagerFailureCode::Conflicts
    } else if stderr.contains("there is no tracking information") {
        GitManagerFailureCode::NoUpstream
    } else {
        GitManagerFailureCode::Unknown
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum GitManagerCheckoutStrategy {
    Stash,
    Bring,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GitManagerResetMode {
    Hard,
    Soft,
    Mixed,
}

impl GitManagerResetMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Hard => "hard",
            Self::Soft => "soft",
            Self::Mixed => "mixed",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum GitManagerPendingOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl GitManagerPendingOperation {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Rebase => "rebase",
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(
    tag = "_tag",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GitManagerOperationRequest {
    BranchCreate {
        cwd: PathBuf,
        project_id: String,
        name: String,
        start_point: Option<String>,
        checkout: bool,
    },
    BranchCheckout {
        cwd: PathBuf,
        project_id: String,
        name: String,
        strategy: Option<GitManagerCheckoutStrategy>,
    },
    BranchRename {
        cwd: PathBuf,
        project_id: String,
        name: String,
        new_name: String,
    },
    BranchDelete {
        cwd: PathBuf,
        project_id: String,
        name: String,
        force: bool,
        delete_remote: bool,
    },
    /// Deletes `branch` on `remote` only, leaving any local branch alone.
    RemoteBranchDelete {
        cwd: PathBuf,
        project_id: String,
        remote: String,
        branch: String,
    },
    Fetch {
        cwd: PathBuf,
        project_id: String,
        remote: String,
    },
    Pull {
        cwd: PathBuf,
        project_id: String,
        remote: String,
    },
    Push {
        cwd: PathBuf,
        project_id: String,
        remote: String,
        local_branch: String,
        remote_branch: Option<String>,
        #[serde(default)]
        push_tags: bool,
    },
    PublishBranch {
        cwd: PathBuf,
        project_id: String,
        remote: String,
        local_branch: String,
        remote_branch: Option<String>,
        #[serde(default)]
        push_tags: bool,
    },
    ForcePush {
        cwd: PathBuf,
        project_id: String,
        remote: String,
        local_branch: String,
        remote_branch: Option<String>,
        #[serde(default)]
        push_tags: bool,
    },
    StashPush {
        cwd: PathBuf,
        project_id: String,
        message: String,
        paths: Vec<String>,
        #[serde(default)]
        include_untracked: bool,
    },
    StashApply {
        cwd: PathBuf,
        project_id: String,
        index: u64,
    },
    StashPop {
        cwd: PathBuf,
        project_id: String,
        index: u64,
    },
    StashDrop {
        cwd: PathBuf,
        project_id: String,
        index: u64,
    },
    Merge {
        cwd: PathBuf,
        project_id: String,
        source: String,
        no_verify: bool,
    },
    SquashMerge {
        cwd: PathBuf,
        project_id: String,
        source: String,
        no_verify: bool,
    },
    MergeInto {
        cwd: PathBuf,
        project_id: String,
        source: String,
        target: String,
    },
    Rebase {
        cwd: PathBuf,
        project_id: String,
        base: String,
        target: String,
    },
    CherryPick {
        cwd: PathBuf,
        project_id: String,
        shas: Vec<String>,
    },
    Squash {
        cwd: PathBuf,
        project_id: String,
        shas: Vec<String>,
        message: String,
    },
    Reorder {
        cwd: PathBuf,
        project_id: String,
        shas: Vec<String>,
        insert_before_sha: Option<String>,
    },
    Revert {
        cwd: PathBuf,
        project_id: String,
        sha: String,
    },
    Reset {
        cwd: PathBuf,
        project_id: String,
        sha: String,
        mode: GitManagerResetMode,
    },
    Continue {
        cwd: PathBuf,
        project_id: String,
        operation: GitManagerPendingOperation,
    },
    Abort {
        cwd: PathBuf,
        project_id: String,
        operation: GitManagerPendingOperation,
    },
    ResolveConflict {
        cwd: PathBuf,
        project_id: String,
        path: String,
        side: ConflictSide,
    },
    TagCreate {
        cwd: PathBuf,
        project_id: String,
        name: String,
        sha: String,
        #[serde(default)]
        push_remote: Option<String>,
    },
    TagDelete {
        cwd: PathBuf,
        project_id: String,
        name: String,
    },
    TagPush {
        cwd: PathBuf,
        project_id: String,
        name: String,
        remote: String,
    },
}

impl GitManagerOperationRequest {
    #[must_use]
    pub const fn operation(&self) -> &'static str {
        match self {
            Self::BranchCreate { .. } => "branch-create",
            Self::BranchCheckout { .. } => "branch-checkout",
            Self::BranchRename { .. } => "branch-rename",
            Self::BranchDelete { .. } => "branch-delete",
            Self::RemoteBranchDelete { .. } => "remote-branch-delete",
            Self::Fetch { .. } => "fetch",
            Self::Pull { .. } => "pull",
            Self::Push { .. } => "push",
            Self::PublishBranch { .. } => "publish-branch",
            Self::ForcePush { .. } => "force-push",
            Self::StashPush { .. } => "stash-push",
            Self::StashApply { .. } => "stash-apply",
            Self::StashPop { .. } => "stash-pop",
            Self::StashDrop { .. } => "stash-drop",
            Self::Merge { .. } => "merge",
            Self::SquashMerge { .. } => "squash-merge",
            Self::MergeInto { .. } => "merge-into",
            Self::Rebase { .. } => "rebase",
            Self::CherryPick { .. } => "cherry-pick",
            Self::Squash { .. } => "squash",
            Self::Reorder { .. } => "reorder",
            Self::Revert { .. } => "revert",
            Self::Reset { .. } => "reset",
            Self::Continue { .. } => "continue",
            Self::Abort { .. } => "abort",
            Self::ResolveConflict { .. } => "resolve-conflict",
            Self::TagCreate { .. } => "tag-create",
            Self::TagDelete { .. } => "tag-delete",
            Self::TagPush { .. } => "tag-push",
        }
    }

    #[must_use]
    pub fn cwd(&self) -> &Path {
        match self {
            Self::BranchCreate { cwd, .. }
            | Self::BranchCheckout { cwd, .. }
            | Self::BranchRename { cwd, .. }
            | Self::BranchDelete { cwd, .. }
            | Self::RemoteBranchDelete { cwd, .. }
            | Self::Fetch { cwd, .. }
            | Self::Pull { cwd, .. }
            | Self::Push { cwd, .. }
            | Self::PublishBranch { cwd, .. }
            | Self::ForcePush { cwd, .. }
            | Self::StashPush { cwd, .. }
            | Self::StashApply { cwd, .. }
            | Self::StashPop { cwd, .. }
            | Self::StashDrop { cwd, .. }
            | Self::Merge { cwd, .. }
            | Self::SquashMerge { cwd, .. }
            | Self::MergeInto { cwd, .. }
            | Self::Rebase { cwd, .. }
            | Self::CherryPick { cwd, .. }
            | Self::Squash { cwd, .. }
            | Self::Reorder { cwd, .. }
            | Self::Revert { cwd, .. }
            | Self::Reset { cwd, .. }
            | Self::Continue { cwd, .. }
            | Self::Abort { cwd, .. }
            | Self::ResolveConflict { cwd, .. }
            | Self::TagCreate { cwd, .. }
            | Self::TagDelete { cwd, .. }
            | Self::TagPush { cwd, .. } => cwd,
        }
    }

    #[must_use]
    /// Operations that can move a worktree's HEAD or change the branch set.
    /// The worktree catalog must rescan after them instead of waiting for its
    /// poller; fetch, push, remote branch deletion and stash operations leave every
    /// HEAD in place.
    fn changes_worktree_heads(&self) -> bool {
        !matches!(
            self,
            Self::RemoteBranchDelete { .. }
                | Self::Fetch { .. }
                | Self::Push { .. }
                | Self::PublishBranch { .. }
                | Self::ForcePush { .. }
                | Self::StashPush { .. }
                | Self::StashApply { .. }
                | Self::StashPop { .. }
                | Self::StashDrop { .. }
        )
    }

    pub fn project_id(&self) -> &str {
        match self {
            Self::BranchCreate { project_id, .. }
            | Self::BranchCheckout { project_id, .. }
            | Self::BranchRename { project_id, .. }
            | Self::BranchDelete { project_id, .. }
            | Self::RemoteBranchDelete { project_id, .. }
            | Self::Fetch { project_id, .. }
            | Self::Pull { project_id, .. }
            | Self::Push { project_id, .. }
            | Self::PublishBranch { project_id, .. }
            | Self::ForcePush { project_id, .. }
            | Self::StashPush { project_id, .. }
            | Self::StashApply { project_id, .. }
            | Self::StashPop { project_id, .. }
            | Self::StashDrop { project_id, .. }
            | Self::Merge { project_id, .. }
            | Self::SquashMerge { project_id, .. }
            | Self::MergeInto { project_id, .. }
            | Self::Rebase { project_id, .. }
            | Self::CherryPick { project_id, .. }
            | Self::Squash { project_id, .. }
            | Self::Reorder { project_id, .. }
            | Self::Revert { project_id, .. }
            | Self::Reset { project_id, .. }
            | Self::Continue { project_id, .. }
            | Self::Abort { project_id, .. }
            | Self::ResolveConflict { project_id, .. }
            | Self::TagCreate { project_id, .. }
            | Self::TagDelete { project_id, .. }
            | Self::TagPush { project_id, .. } => project_id,
        }
    }

    #[must_use]
    pub const fn is_implemented_through_phase_16(&self) -> bool {
        matches!(
            self,
            Self::BranchCreate { .. }
                | Self::BranchCheckout {
                    strategy: None | Some(GitManagerCheckoutStrategy::Bring),
                    ..
                }
                | Self::BranchRename { .. }
                | Self::BranchDelete { .. }
                | Self::RemoteBranchDelete { .. }
                | Self::Fetch { .. }
                | Self::Pull { .. }
                | Self::Push { .. }
                | Self::PublishBranch { .. }
                | Self::ForcePush { .. }
                | Self::StashPush { .. }
                | Self::StashApply { .. }
                | Self::StashPop { .. }
                | Self::StashDrop { .. }
                | Self::Merge { .. }
                | Self::SquashMerge { .. }
                | Self::MergeInto { .. }
                | Self::Rebase { .. }
                | Self::CherryPick { .. }
                | Self::Squash { .. }
                | Self::Reorder { .. }
                | Self::Revert { .. }
                | Self::Reset { .. }
                | Self::Continue { .. }
                | Self::Abort { .. }
                | Self::ResolveConflict { .. }
                | Self::TagCreate { .. }
                | Self::TagDelete { .. }
                | Self::TagPush { .. }
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitManagerOperationOutcome {
    pub operation: String,
    pub outputs: Vec<ProcessOutput>,
    pub message: String,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{message}")]
pub struct GitManagerOperationError {
    pub operation: String,
    pub code: String,
    pub message: String,
    pub blocked: Option<Box<GitManagerBlockedReason>>,
    pub outputs: Vec<ProcessOutput>,
}

pub async fn stage_partial(
    repository: &GitRepository,
    request: &PartialSelectionRequest,
    cancellation: &CancellationToken,
) -> Result<PartialSelectionOutcome, PartialSelectionError> {
    let fresh = read_partial_diff(repository, request, false, cancellation).await?;
    let mut parsed = parse_working_tree_diff(&fresh.patch);
    reject_stale(&parsed, request)?;

    if diff_records_rename(&fresh.patch) {
        repository
            .stage_files(
                &request.cwd,
                std::slice::from_ref(&request.path),
                cancellation,
            )
            .await?;
        tracing::debug!(
            operation = "gitManager.stagePartial",
            code = "rename-whole-file-fallback",
            selected_line_count = request.selected_lines.len(),
            "Git Manager partial staging used a whole-file fallback"
        );
        let generation = refreshed_generation(repository, request, false, cancellation).await?;
        return Ok(PartialSelectionOutcome {
            generation,
            patch_byte_length: 0,
            fallback_reason: Some(RENAME_WHOLE_FILE_FALLBACK),
        });
    }

    let Some(mut patch) = format_selection_patch(&parsed, &request.selected_lines) else {
        return Ok(noop_partial_outcome(diff_generation(&parsed)));
    };
    if fresh.untracked {
        repository
            .git_manager_intent_to_add(&request.cwd, &request.path, cancellation)
            .await?;
        let reread = repository
            .git_manager_working_tree_diff(&request.cwd, &request.path, false, cancellation)
            .await?;
        if reread.stdout_truncated {
            clear_intent(repository, request).await?;
            return Err(PartialSelectionError::DiffTooLarge);
        }
        parsed = parse_working_tree_diff(&reread.stdout);
        if diff_generation(&parsed) != request.base_generation {
            clear_intent(repository, request).await?;
            return Err(PartialSelectionError::Stale);
        }
        let Some(reread_patch) = format_selection_patch(&parsed, &request.selected_lines) else {
            clear_intent(repository, request).await?;
            return Ok(noop_partial_outcome(diff_generation(&parsed)));
        };
        patch = reread_patch;
    }

    let patch_byte_length = patch.len();
    log_partial_apply("gitManager.stagePartial", request, patch_byte_length);
    let result = repository
        .git_manager_apply_partial_patch(
            "GitManager.stagePartial.apply",
            &request.cwd,
            patch.into_bytes(),
            true,
            false,
            cancellation,
        )
        .await;
    if fresh.untracked && result.is_err() {
        let _ = clear_intent(repository, request).await;
    }
    result?;
    let generation = refreshed_generation(repository, request, false, cancellation).await?;
    Ok(PartialSelectionOutcome {
        generation,
        patch_byte_length,
        fallback_reason: None,
    })
}

pub async fn unstage_partial(
    repository: &GitRepository,
    request: &PartialSelectionRequest,
    cancellation: &CancellationToken,
) -> Result<PartialSelectionOutcome, PartialSelectionError> {
    apply_staged_reverse_patch(repository, request, cancellation).await
}

pub async fn discard_partial(
    repository: &GitRepository,
    request: &PartialSelectionRequest,
    cancellation: &CancellationToken,
) -> Result<PartialSelectionOutcome, PartialSelectionError> {
    let fresh = read_partial_diff(repository, request, false, cancellation).await?;
    let mut parsed = parse_working_tree_diff(&fresh.patch);
    reject_stale(&parsed, request)?;
    let Some(mut patch) = format_selection_patch(&parsed, &request.selected_lines) else {
        return Ok(noop_partial_outcome(diff_generation(&parsed)));
    };

    if fresh.untracked {
        repository
            .git_manager_intent_to_add(&request.cwd, &request.path, cancellation)
            .await?;
        let reread = repository
            .git_manager_working_tree_diff(&request.cwd, &request.path, false, cancellation)
            .await?;
        if reread.stdout_truncated {
            clear_intent(repository, request).await?;
            return Err(PartialSelectionError::DiffTooLarge);
        }
        parsed = parse_working_tree_diff(&reread.stdout);
        if diff_generation(&parsed) != request.base_generation {
            clear_intent(repository, request).await?;
            return Err(PartialSelectionError::Stale);
        }
        let Some(reread_patch) = format_selection_patch(&parsed, &request.selected_lines) else {
            clear_intent(repository, request).await?;
            return Ok(noop_partial_outcome(diff_generation(&parsed)));
        };
        patch = reread_patch;
    }

    let patch_byte_length = patch.len();
    log_partial_apply("gitManager.discardPartial", request, patch_byte_length);
    let result = repository
        .git_manager_apply_partial_patch(
            "GitManager.discardPartial.apply",
            &request.cwd,
            patch.into_bytes(),
            false,
            true,
            cancellation,
        )
        .await;
    if let Err(error) = result {
        if fresh.untracked {
            let _ = clear_intent(repository, request).await;
        }
        return Err(error.into());
    }
    if fresh.untracked {
        clear_intent(repository, request).await?;
    }
    let generation = refreshed_generation(repository, request, false, cancellation).await?;
    Ok(PartialSelectionOutcome {
        generation,
        patch_byte_length,
        fallback_reason: None,
    })
}

#[derive(Debug)]
struct FreshPartialDiff {
    patch: String,
    untracked: bool,
}

async fn apply_staged_reverse_patch(
    repository: &GitRepository,
    request: &PartialSelectionRequest,
    cancellation: &CancellationToken,
) -> Result<PartialSelectionOutcome, PartialSelectionError> {
    let fresh = read_partial_diff(repository, request, true, cancellation).await?;
    let parsed = parse_working_tree_diff(&fresh.patch);
    reject_stale(&parsed, request)?;
    let Some(patch) = format_selection_patch(&parsed, &request.selected_lines) else {
        return Ok(noop_partial_outcome(diff_generation(&parsed)));
    };
    let patch_byte_length = patch.len();
    log_partial_apply("gitManager.unstagePartial", request, patch_byte_length);
    repository
        .git_manager_apply_partial_patch(
            "GitManager.unstagePartial.apply",
            &request.cwd,
            patch.into_bytes(),
            true,
            true,
            cancellation,
        )
        .await?;
    let generation = refreshed_generation(repository, request, true, cancellation).await?;
    Ok(PartialSelectionOutcome {
        generation,
        patch_byte_length,
        fallback_reason: None,
    })
}

async fn read_partial_diff(
    repository: &GitRepository,
    request: &PartialSelectionRequest,
    staged: bool,
    cancellation: &CancellationToken,
) -> Result<FreshPartialDiff, PartialSelectionError> {
    let output = repository
        .git_manager_working_tree_diff(&request.cwd, &request.path, staged, cancellation)
        .await?;
    if output.stdout_truncated {
        return Err(PartialSelectionError::DiffTooLarge);
    }
    if staged || !output.stdout.is_empty() {
        return Ok(FreshPartialDiff {
            patch: output.stdout,
            untracked: false,
        });
    }

    let untracked = repository
        .git_manager_untracked_paths(&request.cwd, &request.path, cancellation)
        .await?;
    if untracked.stdout.is_empty() {
        return Ok(FreshPartialDiff {
            patch: output.stdout,
            untracked: false,
        });
    }
    let output = repository
        .git_manager_untracked_diff(&request.cwd, &request.path, cancellation)
        .await?;
    if output.stdout_truncated {
        return Err(PartialSelectionError::DiffTooLarge);
    }
    Ok(FreshPartialDiff {
        patch: output.stdout,
        untracked: true,
    })
}

fn reject_stale(
    parsed: &super::patch::ParsedFileDiff,
    request: &PartialSelectionRequest,
) -> Result<(), PartialSelectionError> {
    let generation = diff_generation(parsed);
    if generation == request.base_generation {
        return Ok(());
    }
    tracing::debug!(
        operation = "gitManager.partial",
        code = "stale-selection",
        selected_line_count = request.selected_lines.len(),
        "Git Manager rejected a stale partial selection"
    );
    Err(PartialSelectionError::Stale)
}

async fn refreshed_generation(
    repository: &GitRepository,
    request: &PartialSelectionRequest,
    staged: bool,
    cancellation: &CancellationToken,
) -> Result<u64, PartialSelectionError> {
    let fresh = read_partial_diff(repository, request, staged, cancellation).await?;
    Ok(diff_generation(&parse_working_tree_diff(&fresh.patch)))
}

async fn clear_intent(
    repository: &GitRepository,
    request: &PartialSelectionRequest,
) -> Result<(), PartialSelectionError> {
    repository
        .git_manager_clear_intent_to_add(&request.cwd, &request.path, &CancellationToken::new())
        .await?;
    Ok(())
}

fn noop_partial_outcome(generation: u64) -> PartialSelectionOutcome {
    PartialSelectionOutcome {
        generation,
        patch_byte_length: 0,
        fallback_reason: None,
    }
}

fn log_partial_apply(
    operation: &'static str,
    request: &PartialSelectionRequest,
    patch_byte_length: usize,
) {
    tracing::debug!(
        operation,
        code = "partial-patch-apply",
        selected_line_count = request.selected_lines.len(),
        patch_byte_length,
        "Git Manager is applying a partial selection"
    );
}

fn diff_records_rename(diff: &str) -> bool {
    diff.lines()
        .any(|line| line.starts_with("rename from ") || line.starts_with("rename to "))
        || diff
            .find("diff --git ")
            .map_or(diff, |patch_start| &diff[..patch_start])
            .split_ascii_whitespace()
            .any(|field| {
                field
                    .strip_prefix('R')
                    .is_some_and(|score| score.bytes().take_while(u8::is_ascii_digit).count() > 0)
            })
}

pub async fn run_branch_or_sync_operation(
    repository: Arc<GitRepository>,
    broadcaster: StatusBroadcaster,
    catalog: WorktreeCatalogService,
    request: GitManagerOperationRequest,
    cancellation: CancellationToken,
) -> Result<GitManagerOperationOutcome, GitManagerOperationError> {
    let operation = request.operation();
    if !request.is_implemented_through_phase_16() {
        return Err(operation_error(
            operation,
            "not-implemented",
            "This Git Manager operation is not implemented until a later phase.",
        ));
    }
    let project_id = request.project_id().to_owned();
    let locked_repository = Arc::clone(&repository);
    let locked_broadcaster = broadcaster.clone();
    let locked_request = request.clone();
    let operation_cancellation = cancellation.clone();
    let result = match catalog
        .try_with_project_mutation_lock_cancellation(&project_id, &cancellation, || async move {
            // vcs.* writes take this per-worktree guard but not the project lock, so it is
            // held from the snapshot onward: validation and execution see the same HEAD.
            let mutation = tokio::select! {
                biased;
                () = operation_cancellation.cancelled() => {
                    return Err(cancelled_error(operation));
                }
                mutation = locked_broadcaster.begin_mutation(locked_request.cwd()) => mutation,
            };
            let result = async {
                let mut snapshot = build_refs_snapshot(
                    &locked_repository,
                    locked_request.cwd(),
                    &operation_cancellation,
                )
                .await
                .map_err(|error| refs_snapshot_error(operation, error))?;
                snapshot.in_progress_operation = detect_in_progress_operation(
                    &locked_repository,
                    locked_request.cwd(),
                    &operation_cancellation,
                )
                .await
                .map_err(|_| {
                    operation_error(
                        operation,
                        "repository-state-unavailable",
                        "Git repository operation state could not be revalidated.",
                    )
                })?;
                if let Some(reason) = blocked_reason_for_operation(&snapshot, &locked_request) {
                    return Err(blocked_operation_error(operation, reason));
                }
                if operation_cancellation.is_cancelled() {
                    return Err(cancelled_error(operation));
                }
                execute_branch_or_sync_operation(
                    &locked_repository,
                    &snapshot,
                    &locked_request,
                    &operation_cancellation,
                )
                .await
            }
            .await;
            mutation.finish().await;
            result
        })
        .await
    {
        ProjectMutationAttempt::Acquired(result) => result,
        ProjectMutationAttempt::InFlight => Err(blocked_operation_error(
            operation,
            GitManagerBlockedReason {
                operation: operation.to_owned(),
                code: "operation-in-flight".to_owned(),
                message: "Blocked: another Git Manager operation is already running.".to_owned(),
            },
        )),
        ProjectMutationAttempt::Cancelled => Err(cancelled_error(operation)),
    };
    if result.is_ok() && request.changes_worktree_heads() {
        // Every project view sharing this repository shows worktree branches
        // and heads from the catalog; rescan now rather than on the next poll.
        catalog
            .invalidate_repository_after_mutation(&project_id)
            .await;
    }
    result
}

fn blocked_reason_for_operation(
    snapshot: &GitManagerRefsSnapshot,
    request: &GitManagerOperationRequest,
) -> Option<GitManagerBlockedReason> {
    let blocked = evaluate_guards(&GuardInput::from_snapshot(snapshot, false));
    let (branch, guard_operation) = match request {
        GitManagerOperationRequest::BranchCheckout { name, .. }
            if name.starts_with("refs/remotes/") =>
        {
            (None, "checkout")
        }
        GitManagerOperationRequest::BranchCheckout { name, .. } => (
            Some(name.strip_prefix("refs/heads/").unwrap_or(name)),
            "checkout",
        ),
        GitManagerOperationRequest::BranchRename { name, .. } => {
            (Some(name.as_str()), "rename-branch")
        }
        GitManagerOperationRequest::BranchDelete { name, .. } => {
            (Some(name.as_str()), "delete-branch")
        }
        GitManagerOperationRequest::Pull { .. } => (snapshot.head_ref.as_deref(), "pull"),
        GitManagerOperationRequest::Push { local_branch, .. } => {
            (Some(local_branch.as_str()), "push")
        }
        GitManagerOperationRequest::PublishBranch { local_branch, .. } => {
            (Some(local_branch.as_str()), "publish-branch")
        }
        GitManagerOperationRequest::ForcePush { local_branch, .. } => {
            (Some(local_branch.as_str()), "force-push")
        }
        GitManagerOperationRequest::Merge { source, .. }
        | GitManagerOperationRequest::SquashMerge { source, .. } => {
            (Some(source.as_str()), "merge")
        }
        GitManagerOperationRequest::MergeInto { target, .. } => {
            (Some(target.as_str()), "merge-into")
        }
        GitManagerOperationRequest::StashPush { .. } => {
            (snapshot.head_ref.as_deref(), "stash-push")
        }
        GitManagerOperationRequest::StashApply { .. } => {
            (snapshot.head_ref.as_deref(), "stash-apply")
        }
        GitManagerOperationRequest::StashPop { .. } => (snapshot.head_ref.as_deref(), "stash-pop"),
        GitManagerOperationRequest::StashDrop { .. } => {
            (snapshot.head_ref.as_deref(), "stash-drop")
        }
        GitManagerOperationRequest::Fetch { .. } => (snapshot.head_ref.as_deref(), "fetch"),
        GitManagerOperationRequest::BranchCreate { .. } => {
            (snapshot.head_ref.as_deref(), "branch-create")
        }
        GitManagerOperationRequest::Rebase { target, .. } => (Some(target.as_str()), "rebase"),
        GitManagerOperationRequest::CherryPick { .. } => {
            (snapshot.head_ref.as_deref(), "cherry-pick")
        }
        GitManagerOperationRequest::Squash { .. } => (snapshot.head_ref.as_deref(), "squash"),
        GitManagerOperationRequest::Reorder { .. } => (snapshot.head_ref.as_deref(), "reorder"),
        GitManagerOperationRequest::Revert { .. } => (snapshot.head_ref.as_deref(), "revert"),
        GitManagerOperationRequest::Reset { .. } => (snapshot.head_ref.as_deref(), "reset"),
        GitManagerOperationRequest::Continue { .. }
        | GitManagerOperationRequest::Abort { .. }
        | GitManagerOperationRequest::ResolveConflict { .. } => return None,
        _ => return None,
    };
    let branch_reasons = branch.and_then(|branch| blocked.get(branch));
    let bring_changes = matches!(
        request,
        GitManagerOperationRequest::BranchCheckout {
            strategy: Some(GitManagerCheckoutStrategy::Bring),
            ..
        }
    );
    let applies = |reason: &&GitManagerBlockedReason| {
        reason.operation == guard_operation
            && !(bring_changes && reason.code == "dirty-working-tree")
    };
    branch_reasons
        .and_then(|reasons| reasons.iter().find(applies))
        .or_else(|| {
            blocked.values().flatten().find(|reason| {
                applies(reason)
                    && matches!(
                        reason.code.as_str(),
                        "merge-in-progress" | "no-remote" | "dirty-working-tree"
                    )
            })
        })
        .cloned()
}

/// Refuses a remote or branch a sync command would read as an option: `git fetch`, `pull` and
/// `push` take them as operands with no `--` (`git pull` passes its remote on to `git fetch`
/// without one), and Git accepts a configured remote such as `--all` (#139 slice G).
fn refuse_option_like_operands(
    operation: &str,
    request: &GitManagerOperationRequest,
) -> Result<(), GitManagerOperationError> {
    let operands = match request {
        GitManagerOperationRequest::Fetch { remote, .. }
        | GitManagerOperationRequest::Pull { remote, .. }
        | GitManagerOperationRequest::RemoteBranchDelete { remote, .. } => vec![remote.as_str()],
        GitManagerOperationRequest::Push {
            remote,
            local_branch,
            remote_branch,
            ..
        }
        | GitManagerOperationRequest::PublishBranch {
            remote,
            local_branch,
            remote_branch,
            ..
        }
        | GitManagerOperationRequest::ForcePush {
            remote,
            local_branch,
            remote_branch,
            ..
        } => [Some(remote), Some(local_branch), remote_branch.as_ref()]
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect(),
        _ => Vec::new(),
    };
    if operands.iter().any(|operand| operand.starts_with('-')) {
        return Err(operation_error(
            operation,
            "invalid-request",
            "A remote or branch name may not start with '-'.",
        ));
    }
    Ok(())
}

async fn execute_branch_or_sync_operation(
    repository: &GitRepository,
    snapshot: &GitManagerRefsSnapshot,
    request: &GitManagerOperationRequest,
    cancellation: &CancellationToken,
) -> Result<GitManagerOperationOutcome, GitManagerOperationError> {
    let operation = request.operation();
    refuse_option_like_operands(operation, request)?;
    let outputs = match request {
        GitManagerOperationRequest::BranchCreate {
            cwd,
            name,
            start_point,
            checkout,
            ..
        } => one_output(
            operation,
            repository
                .git_manager_create_branch(
                    cwd,
                    name,
                    start_point.as_deref(),
                    *checkout,
                    cancellation,
                )
                .await,
        )?,
        GitManagerOperationRequest::BranchCheckout { cwd, name, .. } => {
            let explicitly_remote = name.starts_with("refs/remotes/");
            let local_name = name.strip_prefix("refs/heads/").unwrap_or(name);
            if !explicitly_remote
                && snapshot
                    .local_branches
                    .iter()
                    .any(|reference| reference.name == local_name)
            {
                one_output(
                    operation,
                    repository
                        .git_manager_checkout_local_branch(cwd, local_name, cancellation)
                        .await,
                )?
            } else if name.starts_with("refs/heads/") {
                return Err(operation_error(
                    operation,
                    "local-branch-not-found",
                    "The selected local branch no longer exists. Refresh and choose a branch again.",
                ));
            } else if let Some(remote_ref) = remote_tracking_ref(snapshot, name) {
                let local_name = remote_ref
                    .name
                    .split_once('/')
                    .map_or(remote_ref.name.as_str(), |(_, branch)| branch);
                if snapshot
                    .local_branches
                    .iter()
                    .any(|reference| reference.name == local_name)
                {
                    return Err(operation_error(
                        operation,
                        "branch-exists",
                        &format!(
                            "A local branch named '{local_name}' already exists. Select it in the local branches list, or rename it before checking out '{}'.",
                            remote_ref.name
                        ),
                    ));
                }
                one_output(
                    operation,
                    repository
                        .git_manager_checkout_remote_branch(
                            cwd,
                            local_name,
                            &format!("refs/remotes/{}", remote_ref.name),
                            cancellation,
                        )
                        .await,
                )?
            } else if explicitly_remote {
                return Err(operation_error(
                    operation,
                    "remote-branch-not-found",
                    "The selected remote branch no longer exists. Fetch and choose a branch again.",
                ));
            } else {
                one_output(
                    operation,
                    repository
                        .git_manager_checkout_local_branch(cwd, name, cancellation)
                        .await,
                )?
            }
        }
        GitManagerOperationRequest::BranchRename {
            cwd,
            name,
            new_name,
            ..
        } => {
            let outputs = repository
                .git_manager_rename_branch(cwd, name, new_name, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            require_last_success(operation, outputs)?
        }
        GitManagerOperationRequest::BranchDelete {
            cwd,
            name,
            force,
            delete_remote,
            ..
        } => {
            let remote_target = if *delete_remote {
                Some(remote_delete_target(snapshot, name).ok_or_else(|| {
                    operation_error(
                        operation,
                        "no-upstream",
                        "Remote deletion is blocked because this branch has no upstream.",
                    )
                })?)
            } else {
                None
            };
            let mut outputs = one_output(
                operation,
                repository
                    .git_manager_delete_branch(cwd, name, *force, cancellation)
                    .await,
            )?;
            if let Some((remote, remote_branch)) = remote_target {
                let remote_output = repository
                    .git_manager_delete_remote_branch(cwd, remote, remote_branch, cancellation)
                    .await
                    .map_err(|error| git_command_error(operation, error, outputs.clone()))?;
                outputs.push(remote_output);
                outputs = require_last_success(operation, outputs)?;
            }
            outputs
        }
        GitManagerOperationRequest::RemoteBranchDelete {
            cwd,
            remote,
            branch,
            ..
        } => {
            if !snapshot.remotes.iter().any(|known| known == remote) {
                return Err(operation_error(
                    operation,
                    "invalid-request",
                    "The remote is not one of this checkout's remotes.",
                ));
            }
            if !is_branch_name(branch) {
                return Err(operation_error(
                    operation,
                    "invalid-request",
                    "The remote branch name is not a valid branch name.",
                ));
            }
            one_output(
                operation,
                repository
                    .git_manager_delete_remote_branch(cwd, remote, branch, cancellation)
                    .await,
            )?
        }
        GitManagerOperationRequest::Fetch { cwd, remote, .. } => one_output(
            operation,
            repository
                .git_manager_fetch(cwd, remote, cancellation)
                .await,
        )?,
        GitManagerOperationRequest::Pull { cwd, remote, .. } => {
            let outputs = repository
                .git_manager_pull(cwd, remote, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            require_last_success(operation, outputs)?
        }
        GitManagerOperationRequest::Push {
            cwd,
            remote,
            local_branch,
            remote_branch,
            push_tags,
            ..
        }
        | GitManagerOperationRequest::PublishBranch {
            cwd,
            remote,
            local_branch,
            remote_branch,
            push_tags,
            ..
        }
        | GitManagerOperationRequest::ForcePush {
            cwd,
            remote,
            local_branch,
            remote_branch,
            push_tags,
            ..
        } => one_output(
            operation,
            repository
                .git_manager_push(
                    cwd,
                    remote,
                    local_branch,
                    remote_branch.as_deref(),
                    matches!(request, GitManagerOperationRequest::PublishBranch { .. }),
                    matches!(request, GitManagerOperationRequest::ForcePush { .. }),
                    *push_tags,
                    cancellation,
                )
                .await,
        )?,
        GitManagerOperationRequest::StashPush {
            cwd,
            message,
            paths,
            include_untracked,
            ..
        } => {
            if message.is_empty() || message.trim() != message {
                return Err(operation_error(
                    operation,
                    "invalid-request",
                    "The stash message must be trimmed and non-empty.",
                ));
            }
            validate_pathspecs("GitManager.stashPush", cwd, paths).map_err(|_| {
                operation_error(
                    operation,
                    "invalid-path",
                    "A requested stash path is invalid.",
                )
            })?;
            let outputs = stash::push(
                repository,
                cwd,
                message,
                paths,
                *include_untracked,
                cancellation,
            )
            .await
            .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            let outputs = require_last_success(operation, outputs)?;
            if *include_untracked {
                require_stash_entry(operation, outputs)?
            } else {
                outputs
            }
        }
        GitManagerOperationRequest::StashApply { cwd, index, .. } => one_output(
            operation,
            stash::apply(repository, cwd, *index, cancellation).await,
        )?,
        GitManagerOperationRequest::StashPop { cwd, index, .. } => one_output(
            operation,
            stash::pop(repository, cwd, *index, cancellation).await,
        )?,
        GitManagerOperationRequest::StashDrop { cwd, index, .. } => one_output(
            operation,
            stash::drop_stash(repository, cwd, *index, cancellation).await,
        )?,
        GitManagerOperationRequest::Merge {
            cwd,
            source,
            no_verify,
            ..
        } => {
            validate_merge_source(operation, source)?;
            let outputs = merge::merge(repository, cwd, source, *no_verify, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            require_last_success(operation, outputs)?
        }
        GitManagerOperationRequest::SquashMerge {
            cwd,
            source,
            no_verify,
            ..
        } => {
            validate_merge_source(operation, source)?;
            let outputs = merge::squash_merge(repository, cwd, source, *no_verify, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            require_last_success(operation, outputs)?
        }
        GitManagerOperationRequest::MergeInto {
            cwd,
            source,
            target,
            ..
        } => {
            validate_merge_source(operation, source)?;
            validate_revision(operation, target)?;
            if snapshot.head_ref.as_deref() == Some(target.as_str()) {
                return Err(operation_error(
                    operation,
                    "target-is-current",
                    "This branch is checked out here; use Merge into the current branch instead.",
                ));
            }
            if !snapshot
                .local_branches
                .iter()
                .any(|branch| branch.name == *target)
            {
                return Err(local_branch_not_found(operation));
            }
            let outcome = merge::merge_into(repository, cwd, source, target, cancellation)
                .await
                .map_err(|error| merge_into_error(operation, target, error))?;
            let label = source
                .strip_prefix("refs/heads/")
                .or_else(|| source.strip_prefix("refs/remotes/"))
                .unwrap_or(source);
            return Ok(GitManagerOperationOutcome {
                operation: operation.to_owned(),
                message: if outcome.up_to_date {
                    "Already up to date.".to_owned()
                } else {
                    format!("Merged {label} into {target}.")
                },
                outputs: outcome.outputs,
            });
        }
        GitManagerOperationRequest::Rebase {
            cwd, base, target, ..
        } => {
            validate_revision(operation, base)?;
            validate_revision(operation, target)?;
            one_output(
                operation,
                repository
                    .git_manager_rebase(cwd, base, target, cancellation)
                    .await,
            )?
        }
        GitManagerOperationRequest::CherryPick { cwd, shas, .. } => {
            validate_revisions(operation, shas, 1)?;
            one_output(
                operation,
                repository
                    .git_manager_cherry_pick(cwd, shas, cancellation)
                    .await,
            )?
        }
        GitManagerOperationRequest::Squash {
            cwd, shas, message, ..
        } => {
            validate_revisions(operation, shas, 2)?;
            if message.trim().is_empty() || message.trim() != message {
                return Err(operation_error(
                    operation,
                    "invalid-request",
                    "The squash message must be trimmed and non-empty.",
                ));
            }
            let log_order = repository
                .git_manager_rewrite_log_order(cwd, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            let (rewrite_order, oldest_touched) = rewrite_range(&log_order, shas, None, false)
                .map_err(|message| operation_error(operation, "invalid-request", message))?;
            let squashed = shas
                .iter()
                .filter(|sha| *sha != &oldest_touched)
                .cloned()
                .collect::<BTreeSet<_>>();
            let todo = build_squash_todo(&rewrite_order, &squashed, &oldest_touched);
            let parent = repository
                .git_manager_commit_parent(cwd, &oldest_touched, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            let retained = resolve_last_retained_commit_ref(&oldest_touched, parent.as_deref());
            one_output(
                operation,
                repository
                    .git_manager_interactive_rebase(
                        cwd,
                        &todo,
                        Some(message),
                        retained.as_deref(),
                        cancellation,
                    )
                    .await,
            )?
        }
        GitManagerOperationRequest::Reorder {
            cwd,
            shas,
            insert_before_sha,
            ..
        } => {
            validate_revisions(operation, shas, 1)?;
            if let Some(insert_before_sha) = insert_before_sha.as_deref() {
                validate_revision(operation, insert_before_sha)?;
                if shas.iter().any(|sha| sha == insert_before_sha) {
                    return Err(operation_error(
                        operation,
                        "invalid-request",
                        "The reorder insertion target cannot be one of the moved commits.",
                    ));
                }
            }
            let log_order = repository
                .git_manager_rewrite_log_order(cwd, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            let (rewrite_order, oldest_touched) = rewrite_range(
                &log_order,
                shas,
                insert_before_sha.as_deref(),
                insert_before_sha.is_none(),
            )
            .map_err(|message| operation_error(operation, "invalid-request", message))?;
            let todo = build_reorder_todo(&rewrite_order, shas, insert_before_sha.as_deref());
            let parent = repository
                .git_manager_commit_parent(cwd, &oldest_touched, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            let retained = resolve_last_retained_commit_ref(&oldest_touched, parent.as_deref());
            one_output(
                operation,
                repository
                    .git_manager_interactive_rebase(
                        cwd,
                        &todo,
                        None,
                        retained.as_deref(),
                        cancellation,
                    )
                    .await,
            )?
        }
        GitManagerOperationRequest::Revert { cwd, sha, .. } => {
            validate_revision(operation, sha)?;
            let merge_commit = repository
                .git_manager_is_merge_commit(cwd, sha, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            one_output(
                operation,
                repository
                    .git_manager_revert(cwd, sha, merge_commit, cancellation)
                    .await,
            )?
        }
        GitManagerOperationRequest::Reset { cwd, sha, mode, .. } => {
            validate_revision(operation, sha)?;
            one_output(
                operation,
                repository
                    .git_manager_reset(cwd, sha, mode.as_str(), cancellation)
                    .await,
            )?
        }
        GitManagerOperationRequest::Continue {
            cwd,
            operation: pending,
            ..
        } => {
            validate_recovery_operation(snapshot, *pending, operation)?;
            let skip_empty = *pending == GitManagerPendingOperation::Rebase
                && repository
                    .git_manager_index_is_empty(cwd, cancellation)
                    .await
                    .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            one_output(
                operation,
                repository
                    .git_manager_continue(cwd, pending.as_str(), skip_empty, cancellation)
                    .await,
            )?
        }
        GitManagerOperationRequest::Abort {
            cwd,
            operation: pending,
            ..
        } => {
            validate_recovery_operation(snapshot, *pending, operation)?;
            one_output(
                operation,
                repository
                    .git_manager_abort(cwd, pending.as_str(), cancellation)
                    .await,
            )?
        }
        GitManagerOperationRequest::ResolveConflict {
            cwd, path, side, ..
        } => {
            validate_pathspecs(
                "GitManager.resolveConflict",
                cwd,
                std::slice::from_ref(path),
            )
            .map_err(|_| {
                operation_error(
                    operation,
                    "invalid-path",
                    "The requested conflict path is invalid.",
                )
            })?;
            let selected_side_deleted = repository
                .git_manager_conflict_side_deleted(cwd, path, *side, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?
                .ok_or_else(|| {
                    operation_error(
                        operation,
                        "conflict-not-found",
                        "The requested path is no longer conflicted.",
                    )
                })?;
            let outputs = repository
                .git_manager_resolve_conflict(cwd, path, *side, selected_side_deleted, cancellation)
                .await
                .map_err(|error| git_command_error(operation, error, Vec::new()))?;
            require_last_success(operation, outputs)?
        }
        GitManagerOperationRequest::TagCreate {
            cwd,
            name,
            sha,
            push_remote,
            ..
        } => {
            let created = tags::create_tag(repository, cwd, name, sha, cancellation)
                .await
                .map_err(|error| tag_operation_error(operation, error))?;
            let mut outputs = require_last_success(operation, vec![created])?;
            if let Some(remote) = push_remote {
                // The tag exists locally from here on; a failed push must say so
                // instead of reading as "nothing happened".
                let failure =
                    match tags::push_tag(repository, cwd, remote, name, cancellation).await {
                        Ok(pushed) if pushed.exit_code == 0 => {
                            outputs.push(pushed);
                            None
                        }
                        Ok(pushed) => Some(
                            pushed
                                .stderr
                                .lines()
                                .map(str::trim)
                                .find(|line| !line.is_empty())
                                .unwrap_or("Git could not reach the remote.")
                                .to_owned(),
                        ),
                        Err(error) => Some(error.to_string()),
                    };
                if let Some(detail) = failure {
                    return Err(operation_error(
                        operation,
                        "tag-push-failed",
                        &format!(
                            "Created tag {name} locally, but pushing it to {remote} failed: {detail}"
                        ),
                    ));
                }
            }
            outputs
        }
        GitManagerOperationRequest::TagDelete { cwd, name, .. } => {
            let output = tags::delete_tag(repository, cwd, name, cancellation)
                .await
                .map_err(|error| tag_operation_error(operation, error))?;
            require_last_success(operation, vec![output])?
        }
        GitManagerOperationRequest::TagPush {
            cwd, name, remote, ..
        } => {
            let output = tags::push_tag(repository, cwd, remote, name, cancellation)
                .await
                .map_err(|error| tag_operation_error(operation, error))?;
            require_last_success(operation, vec![output])?
        }
    };
    Ok(GitManagerOperationOutcome {
        operation: operation.to_owned(),
        message: if outputs.iter().any(|output| {
            merge::is_already_up_to_date(output)
                || classify_operation_failure(output.exit_code, &output.stdout)
                    == GitManagerFailureCode::AlreadyUpToDate
                || classify_operation_failure(output.exit_code, &output.stderr)
                    == GitManagerFailureCode::AlreadyUpToDate
        }) {
            "Already up to date.".to_owned()
        } else {
            "Git operation completed.".to_owned()
        },
        outputs,
    })
}

fn validate_merge_source(operation: &str, source: &str) -> Result<(), GitManagerOperationError> {
    if source.is_empty() || source.trim() != source || source.starts_with('-') {
        return Err(operation_error(
            operation,
            "invalid-request",
            "The merge source must be a trimmed non-option revision.",
        ));
    }
    Ok(())
}

fn validate_revision(operation: &str, revision: &str) -> Result<(), GitManagerOperationError> {
    if revision.is_empty() || revision.trim() != revision || revision.starts_with('-') {
        return Err(operation_error(
            operation,
            "invalid-request",
            "A Git revision must be trimmed, non-empty, and cannot start with an option prefix.",
        ));
    }
    Ok(())
}

/// Whether `name` is a branch name `git check-ref-format --branch` would accept, kept strict so
/// a name can never be read as an option or a refspec: no leading `-` or `+`, no `:`, no whitespace,
/// control or wildcard characters, no `..`, `@{`, `//`, and no part that starts with `.` or
/// ends with `.lock`.
#[must_use]
pub(crate) fn is_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "@"
        && !name.starts_with(['-', '+', '/'])
        && !name.ends_with(['/', '.'])
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && !name.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(character, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
        && name
            .split('/')
            .all(|part| !part.starts_with('.') && !part.ends_with(".lock"))
}

fn validate_revisions(
    operation: &str,
    revisions: &[String],
    minimum: usize,
) -> Result<(), GitManagerOperationError> {
    if revisions.len() < minimum {
        return Err(operation_error(
            operation,
            "invalid-request",
            "The operation does not include enough commits.",
        ));
    }
    let mut unique = BTreeSet::new();
    for revision in revisions {
        validate_revision(operation, revision)?;
        if !unique.insert(revision) {
            return Err(operation_error(
                operation,
                "invalid-request",
                "The operation includes the same commit more than once.",
            ));
        }
    }
    Ok(())
}

fn rewrite_range(
    log_order: &[String],
    moved_shas: &[String],
    insert_before_sha: Option<&str>,
    through_root: bool,
) -> Result<(Vec<String>, String), &'static str> {
    if log_order.is_empty() {
        return Err("The current branch has no commits to rewrite.");
    }
    let mut oldest_index = 0;
    for sha in moved_shas {
        let index = log_order
            .iter()
            .position(|candidate| candidate == sha)
            .ok_or("A selected commit is no longer on the current first-parent history.")?;
        oldest_index = oldest_index.max(index);
    }
    if let Some(insert_before_sha) = insert_before_sha {
        let index = log_order
            .iter()
            .position(|candidate| candidate == insert_before_sha)
            .ok_or("The reorder insertion target is no longer on the current history.")?;
        oldest_index = oldest_index.max(index);
    } else if through_root {
        oldest_index = log_order.len() - 1;
    }
    let rewrite_order = log_order[..=oldest_index].to_vec();
    let oldest_touched = rewrite_order
        .last()
        .expect("a non-empty prefix was selected")
        .clone();
    Ok((rewrite_order, oldest_touched))
}

fn validate_recovery_operation(
    snapshot: &GitManagerRefsSnapshot,
    requested: GitManagerPendingOperation,
    operation: &str,
) -> Result<(), GitManagerOperationError> {
    let detected = snapshot
        .in_progress_operation
        .as_ref()
        .and_then(|pending| match pending.kind {
            GitManagerInProgressKind::Merge => Some(GitManagerPendingOperation::Merge),
            GitManagerInProgressKind::Rebase => Some(GitManagerPendingOperation::Rebase),
            GitManagerInProgressKind::CherryPick => Some(GitManagerPendingOperation::CherryPick),
            GitManagerInProgressKind::Revert => Some(GitManagerPendingOperation::Revert),
            GitManagerInProgressKind::Squash => None,
        });
    if detected == Some(requested) {
        return Ok(());
    }
    Err(operation_error(
        operation,
        "operation-not-in-progress",
        "The requested recovery operation does not match the repository state.",
    ))
}

fn remote_tracking_ref<'a>(
    snapshot: &'a GitManagerRefsSnapshot,
    requested: &str,
) -> Option<&'a crate::git::GitManagerRefEntry> {
    if let Some(name) = requested.strip_prefix("refs/remotes/") {
        return snapshot
            .remote_branches
            .iter()
            .find(|reference| reference.name == name);
    }
    snapshot
        .remote_branches
        .iter()
        .find(|reference| reference.name == requested)
        .or_else(|| {
            let mut matches = snapshot.remote_branches.iter().filter(|reference| {
                reference
                    .name
                    .split_once('/')
                    .is_some_and(|(_, branch)| branch == requested)
            });
            let first = matches.next()?;
            matches.next().is_none().then_some(first)
        })
}

fn remote_delete_target<'a>(
    snapshot: &'a GitManagerRefsSnapshot,
    branch: &str,
) -> Option<(&'a str, &'a str)> {
    snapshot
        .local_branches
        .iter()
        .find(|reference| reference.name == branch)?
        .upstream
        .as_deref()?
        .split_once('/')
}

fn one_output(
    operation: &str,
    output: Result<ProcessOutput, GitCommandError>,
) -> Result<Vec<ProcessOutput>, GitManagerOperationError> {
    let output = output.map_err(|error| git_command_error(operation, error, Vec::new()))?;
    require_last_success(operation, vec![output])
}

fn require_last_success(
    operation: &str,
    outputs: Vec<ProcessOutput>,
) -> Result<Vec<ProcessOutput>, GitManagerOperationError> {
    let Some(output) = outputs.last() else {
        return Ok(outputs);
    };
    if output.exit_code == 0 {
        return Ok(outputs);
    }
    let mut code = classify_operation_failure(output.exit_code, &output.stderr);
    if code == GitManagerFailureCode::Unknown {
        code = classify_operation_failure(output.exit_code, &output.stdout);
    }
    Err(GitManagerOperationError {
        operation: operation.to_owned(),
        code: code.as_str().to_owned(),
        message: failure_message(code).to_owned(),
        blocked: None,
        outputs,
    })
}

/// `git stash push` exits 0 with "No local changes to save" when it creates no
/// entry. A caller that relies on the entry (Leave my changes, before a branch
/// switch) must stop there rather than continue as if the work were saved.
fn require_stash_entry(
    operation: &str,
    outputs: Vec<ProcessOutput>,
) -> Result<Vec<ProcessOutput>, GitManagerOperationError> {
    let saved_nothing = outputs.last().is_some_and(|output| {
        output.stdout.contains("No local changes to save")
            || output.stderr.contains("No local changes to save")
    });
    if !saved_nothing {
        return Ok(outputs);
    }
    let code = GitManagerFailureCode::NothingToStash;
    Err(GitManagerOperationError {
        operation: operation.to_owned(),
        code: code.as_str().to_owned(),
        message: failure_message(code).to_owned(),
        blocked: None,
        outputs,
    })
}

fn git_command_error(
    operation: &str,
    error: GitCommandError,
    outputs: Vec<ProcessOutput>,
) -> GitManagerOperationError {
    let exit_code = error
        .diagnostics
        .as_deref()
        .and_then(|diagnostics| diagnostics.exit_code)
        .unwrap_or(-1);
    let code = classify_operation_failure(exit_code, &error.detail);
    GitManagerOperationError {
        operation: operation.to_owned(),
        code: code.as_str().to_owned(),
        message: failure_message(code).to_owned(),
        blocked: None,
        outputs,
    }
}

fn tag_operation_error(operation: &str, error: GitManagerTagError) -> GitManagerOperationError {
    match error {
        GitManagerTagError::InvalidName => operation_error(
            operation,
            "invalid-tag-name",
            "The tag name or target is invalid.",
        ),
        GitManagerTagError::NotFound => operation_error(
            operation,
            "tag-not-found",
            "The requested tag no longer exists; refresh the repository refs.",
        ),
        GitManagerTagError::Malformed | GitManagerTagError::CommandFailed => operation_error(
            operation,
            "git-command-failed",
            "Git could not complete the requested tag operation.",
        ),
        GitManagerTagError::Git(error) => git_command_error(operation, error, Vec::new()),
    }
}

fn refs_snapshot_error(
    operation: &str,
    error: super::refs::GitManagerRefsError,
) -> GitManagerOperationError {
    match error {
        super::refs::GitManagerRefsError::Git(error) => {
            git_command_error(operation, error, Vec::new())
        }
        super::refs::GitManagerRefsError::MalformedRefs
        | super::refs::GitManagerRefsError::RepositoryState(_)
        | super::refs::GitManagerRefsError::Worktrees(_)
        | super::refs::GitManagerRefsError::Tags(_) => operation_error(
            operation,
            "repository-state-unavailable",
            "Git repository state could not be revalidated.",
        ),
    }
}

const fn failure_message(code: GitManagerFailureCode) -> &'static str {
    match code {
        GitManagerFailureCode::Completed => "Git operation completed.",
        GitManagerFailureCode::AlreadyUpToDate => "Already up to date.",
        GitManagerFailureCode::Authentication => {
            "Authentication failed. Check the configured credentials and try again."
        }
        GitManagerFailureCode::NonFastForward => {
            "The remote rejected this update because it is not a fast-forward."
        }
        GitManagerFailureCode::StaleInfo => {
            "The remote branch changed; fetch its latest state before retrying."
        }
        GitManagerFailureCode::LocalChangesOverwritten => {
            "Git stopped because local changes would be overwritten."
        }
        GitManagerFailureCode::Conflicts => "Git stopped because the operation produced conflicts.",
        GitManagerFailureCode::ConflictsEncountered => {
            "Git stopped because the history rewrite produced conflicts."
        }
        GitManagerFailureCode::OutstandingFilesNotStaged => {
            "Git cannot continue until every conflict is resolved and staged."
        }
        GitManagerFailureCode::NothingToStash => {
            "Git found no changes it can stash, so nothing was saved. Changes inside a submodule \
             can't be stashed; commit them in the submodule first."
        }
        GitManagerFailureCode::StashUntrackedCollision => {
            "The stash was kept: a new file in it already exists here, so Git did not restore \
             it. Move that file aside, then apply the stash again."
        }
        GitManagerFailureCode::NoUpstream => "The current branch has no configured upstream.",
        GitManagerFailureCode::Cancelled => "The Git Manager operation was cancelled.",
        GitManagerFailureCode::TimedOut => "The Git Manager operation timed out.",
        GitManagerFailureCode::NetworkStalled => NETWORK_TRANSFER_STALLED,
        GitManagerFailureCode::Unknown => "Git could not complete the requested operation.",
    }
}

fn blocked_operation_error(
    operation: &str,
    reason: GitManagerBlockedReason,
) -> GitManagerOperationError {
    GitManagerOperationError {
        operation: operation.to_owned(),
        code: reason.code.clone(),
        message: reason.message.clone(),
        blocked: Some(Box::new(reason)),
        outputs: Vec::new(),
    }
}

fn cancelled_error(operation: &str) -> GitManagerOperationError {
    operation_error(
        operation,
        GitManagerFailureCode::Cancelled.as_str(),
        failure_message(GitManagerFailureCode::Cancelled),
    )
}

fn local_branch_not_found(operation: &str) -> GitManagerOperationError {
    operation_error(
        operation,
        "local-branch-not-found",
        "The target branch no longer exists; refresh the repository refs.",
    )
}

/// Git's first stderr line, or the exit code when it printed none (`--quiet`).
fn failure_detail(output: &ProcessOutput) -> String {
    merge::first_stderr_line(&output.stderr).map_or_else(
        || format!("Git exited with {}.", output.exit_code),
        str::to_owned,
    )
}

fn merge_into_error(
    operation: &str,
    target: &str,
    error: merge::MergeIntoError,
) -> GitManagerOperationError {
    use merge::{GitManagerMergeError, MergeIntoError};
    match error {
        MergeIntoError::Merge(GitManagerMergeError::GitTooOld { found }) => operation_error(
            operation,
            "git-too-old",
            &format!(
                "Merging into another branch needs Git 2.38 or later on this environment (found {found})."
            ),
        ),
        MergeIntoError::Merge(GitManagerMergeError::Git(error)) => {
            git_command_error(operation, error, Vec::new())
        }
        MergeIntoError::Merge(GitManagerMergeError::InvalidSource) => operation_error(
            operation,
            "invalid-merge-source",
            "The requested merge source could not be resolved.",
        ),
        // The preview reports an invalid target the same way.
        MergeIntoError::Merge(GitManagerMergeError::InvalidTarget)
        | MergeIntoError::TargetMissing => local_branch_not_found(operation),
        MergeIntoError::Merge(GitManagerMergeError::MergeTreeFailed { detail }) => {
            operation_error(
                operation,
                "unknown",
                &format!("Git could not compute the merge: {detail}"),
            )
        }
        MergeIntoError::Merge(_) => {
            operation_error(operation, "unknown", "Git could not compute the merge.")
        }
        MergeIntoError::TargetIsSymbolic { destination } => operation_error(
            operation,
            "invalid-request",
            &format!(
                "{target} is an alias for {}. Merge into that branch instead.",
                destination.strip_prefix("refs/heads/").unwrap_or(&destination)
            ),
        ),
        MergeIntoError::Conflicts { file_count } => operation_error(
            operation,
            "conflicts",
            &format!(
                "{file_count} files would conflict. Check out {target} and merge there to resolve them."
            ),
        ),
        MergeIntoError::UnrelatedHistories => operation_error(
            operation,
            "unrelated-histories",
            "These branches have unrelated histories and cannot be merged.",
        ),
        MergeIntoError::TargetMoved => operation_error(
            operation,
            "non-fast-forward",
            &format!("{target} changed while merging. Review the preview and try again."),
        ),
        MergeIntoError::InUse { path } => blocked_operation_error(
            operation,
            GitManagerBlockedReason {
                operation: operation.to_owned(),
                code: "worktree-checked-out".to_owned(),
                message: path.map_or_else(
                    || {
                        "Cannot update this branch: Git reports it is in use by another worktree."
                            .to_owned()
                    },
                    |path| {
                        format!(
                            "Cannot update this branch: it is checked out in the worktree at {path}."
                        )
                    },
                ),
            },
        ),
        MergeIntoError::CommitFailed(output) => GitManagerOperationError {
            operation: operation.to_owned(),
            code: "unknown".to_owned(),
            message: format!(
                "Git could not create the merge commit: {}",
                failure_detail(&output)
            ),
            blocked: None,
            outputs: vec![output],
        },
        MergeIntoError::PublishFailed(output) => GitManagerOperationError {
            operation: operation.to_owned(),
            code: "unknown".to_owned(),
            message: format!(
                "Git could not update {target}: {}",
                failure_detail(&output)
            ),
            blocked: None,
            outputs: vec![output],
        },
    }
}

fn operation_error(operation: &str, code: &str, message: &str) -> GitManagerOperationError {
    GitManagerOperationError {
        operation: operation.to_owned(),
        code: code.to_owned(),
        message: message.to_owned(),
        blocked: None,
        outputs: Vec::new(),
    }
}

#[must_use]
pub fn commit_arguments(request: &CommitRequest) -> Vec<String> {
    let mut args = vec!["commit".to_owned()];
    if request.amend {
        args.push("--amend".to_owned());
    }
    if request.no_verify {
        args.push("--no-verify".to_owned());
    }
    if request.signoff {
        args.push("--signoff".to_owned());
    }
    if request.allow_empty {
        args.push("--allow-empty".to_owned());
    }
    args.extend(["-F".to_owned(), "-".to_owned()]);
    args
}

#[must_use]
pub fn commit_message_body(request: &CommitRequest) -> String {
    let mut message = request.summary.clone();
    if let Some(description) = request
        .description
        .as_deref()
        .filter(|description| !description.is_empty())
    {
        message.push_str("\n\n");
        message.push_str(description);
    }
    for (index, co_author) in request.co_authors.iter().enumerate() {
        if index == 0 {
            message.push_str("\n\n");
        } else {
            message.push('\n');
        }
        message.push_str("Co-Authored-By: ");
        message.push_str(&co_author.name);
        message.push_str(" <");
        message.push_str(&co_author.email);
        message.push('>');
    }
    message.push('\n');
    message
}

#[must_use]
pub fn parse_undo_commit_message(message: &str) -> UndoCommitDraft {
    let mut lines = message
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let trailer_start = lines
        .iter()
        .rposition(|line| line.trim().is_empty())
        .map_or(lines.len(), |index| index + 1);
    let trailer_block = &lines[trailer_start..];
    let has_coauthor_trailers = !trailer_block.is_empty()
        && trailer_block.iter().all(|line| is_trailer_line(line))
        && trailer_block
            .iter()
            .any(|line| parse_coauthor_trailer(line).is_some());
    let mut retained = Vec::new();
    let mut co_authors = Vec::new();
    for (index, line) in lines.into_iter().enumerate() {
        if has_coauthor_trailers
            && index >= trailer_start
            && let Some(co_author) = parse_coauthor_trailer(line)
        {
            co_authors.push(co_author);
        } else {
            retained.push(line);
        }
    }

    let summary = retained.first().copied().unwrap_or_default().to_owned();
    let mut description = retained.get(1..).unwrap_or_default();
    while description
        .first()
        .is_some_and(|line| line.trim().is_empty())
    {
        description = &description[1..];
    }
    while description
        .last()
        .is_some_and(|line| line.trim().is_empty())
    {
        description = &description[..description.len() - 1];
    }
    UndoCommitDraft {
        summary,
        description: description.join("\n"),
        co_authors,
    }
}

fn is_trailer_line(line: &str) -> bool {
    line.split_once(':').is_some_and(|(key, value)| {
        !value.trim().is_empty()
            && !key.is_empty()
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn parse_coauthor_trailer(line: &str) -> Option<CoAuthor> {
    let (key, value) = line.split_once(':')?;
    if !key.eq_ignore_ascii_case("Co-Authored-By") {
        return None;
    }
    let value = value.trim();
    let email_end = value.strip_suffix('>')?;
    let email_start = email_end.rfind('<')?;
    let name = email_end[..email_start].trim();
    let email = email_end[email_start + 1..].trim();
    (!name.is_empty() && !email.is_empty()).then(|| CoAuthor {
        name: name.to_owned(),
        email: email.to_owned(),
    })
}

pub async fn discard_paths(
    repository: &GitRepository,
    trash: Arc<dyn FileTrash>,
    request: DiscardRequest,
    cancellation: &CancellationToken,
) -> Result<DiscardOutcome, DiscardError> {
    validate_pathspecs("GitManager.discard", &request.cwd, &request.paths)?;
    // Git's metadata is never discarded, also through a path that resolves into it; on unix,
    // entries are staged in the Git directory on their way to the trash (see `move_to_trash`).
    let roots = repository
        .resolve_watch_roots(&request.cwd, cancellation)
        .await?;
    let root = contain_discard_paths(
        &request.cwd,
        &request.paths,
        &[&roots.git_dir, &roots.common_dir],
    )
    .await?;
    let tracked = repository
        .git_manager_tracked_paths(&request.cwd, &request.paths, cancellation)
        .await?;
    #[cfg(unix)]
    let (git_dir, worktree_root) = (roots.git_dir, roots.worktree_root);
    #[cfg(unix)]
    {
        let (staging_dir, recovery_root) = (git_dir.clone(), worktree_root.clone());
        let _ = tokio::task::spawn_blocking(move || {
            discard_staging::recover(&staging_dir, &recovery_root);
        })
        .await;
    }
    let mut outcome = DiscardOutcome::default();
    let mut restore_only = Vec::new();
    for path in &request.paths {
        let absolute_path = request.cwd.join(path);
        let tracked_path = tracked
            .iter()
            .any(|candidate| path_matches(path, candidate));
        if tracked_path
            && matches!(
                tokio::fs::symlink_metadata(&absolute_path).await,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound
            )
        {
            restore_only.push(path.clone());
            continue;
        }
        #[cfg(unix)]
        let moved = move_to_trash(
            trash.as_ref(),
            &root,
            (&git_dir, &worktree_root),
            path,
            cancellation,
        )
        .await;
        #[cfg(not(unix))]
        let moved = move_to_trash(trash.as_ref(), &root, &request.cwd, path, cancellation).await;
        match moved {
            Moved::Trashed => outcome.trashed.push(path.clone()),
            Moved::NotTaken if request.permit_permanent => {
                outcome.permanently_discarded.push(path.clone());
            }
            Moved::NotTaken | Moved::Kept => outcome.trash_unavailable.push(path.clone()),
        }
    }

    let mut discarded_paths = outcome.trashed.clone();
    discarded_paths.extend(outcome.permanently_discarded.iter().cloned());
    discarded_paths.extend(restore_only);
    if discarded_paths.is_empty() {
        return Ok(outcome);
    }
    let tracked_to_unstage = tracked
        .iter()
        .filter(|tracked_path| {
            discarded_paths
                .iter()
                .any(|path| path_matches(path, tracked_path))
        })
        .cloned()
        .collect::<Vec<_>>();
    repository
        .unstage_files(&request.cwd, &tracked_to_unstage, cancellation)
        .await?;
    let tracked_to_restore = repository
        .git_manager_tracked_paths(&request.cwd, &discarded_paths, cancellation)
        .await?;
    repository
        .git_manager_restore_tracked_paths(&request.cwd, &tracked_to_restore, cancellation)
        .await?;
    if !outcome.permanently_discarded.is_empty() {
        repository
            .discard_files(&request.cwd, &outcome.permanently_discarded, cancellation)
            .await?;
        // `git clean` (without `-x`) leaves ignored files. An untracked path still there was
        // kept, so it is reported so; a tracked one is there again because it was restored.
        let mut kept = Vec::new();
        for path in &outcome.permanently_discarded {
            if !tracked
                .iter()
                .any(|candidate| path_matches(path, candidate))
                && tokio::fs::symlink_metadata(request.cwd.join(path))
                    .await
                    .is_ok()
            {
                kept.push(path.clone());
            }
        }
        outcome
            .permanently_discarded
            .retain(|path| !kept.contains(path));
        outcome.trash_unavailable.extend(kept);
    }
    Ok(outcome)
}

/// Refuses every path whose folder resolves outside the checkout, before anything is trashed or
/// restored (#139 slice G, C5): a symlinked folder inside the checkout that points elsewhere
/// cannot route a discard outside it. A path that resolves into, or holds, one of
/// `metadata` (the Git directory and common directory) is refused too (review round 4).
/// Returns the checkout's canonical path.
async fn contain_discard_paths(
    cwd: &Path,
    paths: &[String],
    metadata: &[&Path],
) -> Result<PathBuf, DiscardError> {
    let refused = |detail: &str| {
        DiscardError::Git(GitCommandError {
            tag: "GitCommandError",
            operation: "GitManager.discard".into(),
            command: "git".into(),
            cwd: cwd.to_string_lossy().into(),
            diagnostics: None,
            detail: detail.into(),
        })
    };
    const ESCAPES: &str = "A discard path leaves the checkout through a symlinked folder.";
    let root = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|_| refused(ESCAPES))?;
    let metadata = metadata
        .iter()
        .map(|folder| without_verbatim_prefix(folder.to_path_buf()))
        .collect::<Vec<_>>();
    for path in paths {
        let Some(resolved) = contained_path(&root, cwd, path).await else {
            return Err(refused(ESCAPES));
        };
        if metadata
            .iter()
            .any(|folder| resolved.starts_with(folder) || folder.starts_with(&resolved))
        {
            return Err(refused("A discard path names Git's own metadata."));
        }
    }
    Ok(root)
}

/// `path` (relative to `cwd`) below the canonical form of its deepest existing folder, or `None`
/// when that folder resolves outside `root`, the canonical checkout. The deepest folder that
/// exists is the one resolved, so a deleted tracked file in a deleted folder still passes. A
/// path that is itself a symlink is allowed: the link is what is discarded.
async fn contained_path(root: &Path, cwd: &Path, path: &str) -> Option<PathBuf> {
    let absolute = cwd.join(path);
    let mut folder = absolute.parent()?.to_path_buf();
    while tokio::fs::metadata(&folder).await.is_err() {
        match folder.parent() {
            Some(up) if up.starts_with(cwd) && up != folder => folder = up.to_path_buf(),
            _ => return None,
        }
    }
    let resolved = tokio::fs::canonicalize(&folder).await.ok()?;
    if !resolved.starts_with(root) {
        return None;
    }
    Some(without_verbatim_prefix(
        resolved.join(absolute.strip_prefix(&folder).ok()?),
    ))
}

/// What became of one entry a discard sent to the trash.
enum Moved {
    Trashed,
    /// The trash could not take it, and it is where it was: a permanent discard may remove it.
    NotTaken,
    /// It is kept whatever the request permits: its folder is, or became, a link (or not a
    /// folder), or it could not be put back from BiBCode's staging folder.
    Kept,
}

/// Moves the entry at `path` (relative to `root`, the canonical checkout) to the trash, closing
/// the window between checking its folder and the trash resolving a path (#139 slice G).
///
/// The entry's folder is opened from `root` one component at a time without following a link
/// (`O_NOFOLLOW`), so a folder that is, or becomes, a symlink is never entered. The entry is
/// then renamed by that handle into a new folder of BiBCode's own under
/// `<git_dir>/bibcode-discard/`, on the same file system as the repository, and only that
/// staged path, which nothing the checkout holds can redirect, goes to the trash. The trash
/// resolves that path by string, so first each folder on it, from the Git directory down, and
/// the entry must be the very ones BiBCode holds by handle; and after a trash that answered
/// success, the entry must be gone from the folder BiBCode holds. Either check failing puts the
/// entry back, kept. When the trash refuses it, it is renamed back, never over something created
/// there meanwhile. A
/// folder that is a link is `Kept`; a rename that fails (another file system, a missing entry)
/// is `NotTaken`, so a permanent discard still removes it through Git.
#[cfg(unix)]
async fn move_to_trash(
    trash: &dyn FileTrash,
    root: &Path,
    (git_dir, worktree_root): (&Path, &Path),
    path: &str,
    cancellation: &CancellationToken,
) -> Moved {
    let (root, git_dir, relative) = (root.to_path_buf(), git_dir.to_path_buf(), path.to_owned());
    let worktree_root = worktree_root.to_path_buf();
    let staged = match tokio::task::spawn_blocking(move || {
        discard_staging::stage(&root, (&git_dir, &worktree_root), &relative)
    })
    .await
    {
        Ok(Ok(staged)) => staged,
        Ok(Err(discard_staging::Unstaged::Failed)) => return Moved::NotTaken,
        Ok(Err(discard_staging::Unstaged::Escapes)) | Err(_) => return Moved::Kept,
    };
    let trashed = trash
        .trash(staged.path().to_path_buf(), cancellation)
        .await
        .is_ok();
    tokio::task::spawn_blocking(move || {
        if trashed {
            if staged.finish() {
                Moved::Trashed
            } else {
                tracing::warn!("the trash answered success but left BiBCode's staged entry");
                Moved::Kept
            }
        } else if staged.put_back() {
            Moved::NotTaken
        } else {
            tracing::warn!(
                "a discarded entry the trash refused stayed in BiBCode's staging folder"
            );
            Moved::Kept
        }
    })
    .await
    .unwrap_or(Moved::Kept)
}

/// Moves the entry at `path` to the trash by the checked folder's canonical path. The trash
/// resolves that path later, so a folder that turns into a link in between could still route
/// it; a folder that is a reparse point (a symlink or junction) when the move starts is refused,
/// which leaves only that short window (#139 slice G).
#[cfg(not(unix))]
async fn move_to_trash(
    trash: &dyn FileTrash,
    root: &Path,
    cwd: &Path,
    path: &str,
    cancellation: &CancellationToken,
) -> Moved {
    let Some(checked_path) = contained_path(root, cwd, path).await else {
        return Moved::Kept;
    };
    #[cfg(windows)]
    if crosses_reparse_point(root, path).await {
        return Moved::Kept;
    }
    match trash.trash(checked_path, cancellation).await {
        Ok(()) => Moved::Trashed,
        Err(_) => Moved::NotTaken,
    }
}

/// Whether a folder between `root` and the entry at `path` is a reparse point.
#[cfg(windows)]
async fn crosses_reparse_point(root: &Path, path: &str) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    let mut folder = root.to_path_buf();
    let Some(parents) = Path::new(path).parent() else {
        return false;
    };
    for component in parents.components() {
        folder.push(component);
        match tokio::fs::symlink_metadata(&folder).await {
            Ok(metadata) if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
                return true;
            }
            Ok(_) => {}
            // A missing folder holds nothing to trash.
            Err(_) => return false,
        }
    }
    false
}

/// Staging a discarded entry into BiBCode's own folder by directory handles (see
/// `move_to_trash`).
#[cfg(unix)]
mod discard_staging {
    use std::{
        ffi::{CStr, CString, OsStr},
        io::{self, Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
        path::{Component, Path, PathBuf},
    };

    /// The folder in the Git directory that holds entries on their way to the trash.
    const FOLDER: &CStr = c"bibcode-discard";
    /// Ends the name of a holder's origin record, `<uuid>.origin`, beside the holder.
    const RECORD: &str = ".origin";

    /// Takes the exclusive advisory lock on open holder folder `holder` without waiting. A
    /// discard holds it from just after creating the holder (before its origin record exists)
    /// until it is done with the holder, so recovery, which needs the same lock, never touches
    /// a holder a live discard owns, in this process (a lock belongs to each open file) or
    /// another. The operating system releases it when a process dies, so an abandoned holder
    /// becomes recoverable.
    fn lock(holder: &OwnedFd) -> bool {
        // SAFETY: `holder` is an open descriptor.
        unsafe { libc::flock(holder.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
    }

    /// Why an entry was not staged.
    pub(super) enum Unstaged {
        /// A folder on its way is a link or not a folder: the entry is never moved.
        Escapes,
        /// Staging failed otherwise (another file system, a missing entry); nothing moved.
        Failed,
    }

    /// An entry renamed into `<git_dir>/bibcode-discard/<uuid>/`, with the handles that move
    /// it back.
    pub(super) struct Staged {
        parent: OwnedFd,
        staging: OwnedFd,
        holder: OwnedFd,
        holder_name: CString,
        record_name: CString,
        name: CString,
        path: PathBuf,
    }

    impl Staged {
        /// The staged entry's path: the one the trash takes.
        pub(super) fn path(&self) -> &Path {
            &self.path
        }

        /// After the trash answered success: removes the holder folder when the entry is gone
        /// from it, and returns whether it is. If the entry is still there, the trash took
        /// another path, or nothing, so the entry goes back (see [`Staged::put_back`]).
        pub(super) fn finish(self) -> bool {
            if identity_at(&self.holder, &self.name).is_some() {
                if !self.put_back() {
                    tracing::warn!("a discarded entry stayed in BiBCode's staging folder");
                }
                return false;
            }
            self.release();
            true
        }

        /// Renames the entry back into the folder it came from, never over an entry created
        /// there since. Returns whether it went back; if not, it stays staged with its origin
        /// record, for a later discard's [`recover`] to try again.
        pub(super) fn put_back(self) -> bool {
            let back =
                rename_no_replace(&self.holder, &self.name, &self.parent, &self.name).is_ok();
            if back {
                self.release();
            }
            back
        }

        /// Removes the emptied holder and its origin record.
        fn release(&self) {
            remove_folder(&self.staging, &self.holder_name);
            remove_file(&self.staging, &self.record_name);
        }
    }

    /// Whether a staging folder with owner `uid` and `mode` is private to the user `ours`: owned
    /// by it and writable by no group or other user, so nobody else can rename a holder in it.
    pub(super) fn is_private(uid: u32, mode: u32, ours: u32) -> bool {
        uid == ours && mode & 0o022 == 0
    }

    /// Whether open folder `folder` is private to this process's user (see [`is_private`]).
    fn private(folder: &OwnedFd) -> bool {
        let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: `folder` is an open descriptor and `status` is writable.
        if unsafe { libc::fstat(folder.as_raw_fd(), status.as_mut_ptr()) } != 0 {
            return false;
        }
        // SAFETY: `fstat` succeeded and filled `status`.
        let status = unsafe { status.assume_init() };
        // SAFETY: `geteuid` has no preconditions.
        let ours = unsafe { libc::geteuid() };
        #[allow(
            clippy::unnecessary_cast,
            reason = "the field types differ between platforms"
        )]
        is_private(status.st_uid as u32, status.st_mode as u32, ours as u32)
    }

    /// Opens the folder that holds `relative` (below `root`) from `root` one part at a time,
    /// never following a link, and returns it with the entry's name.
    fn open_parent<'a>(root: &Path, relative: &'a Path) -> Result<(OwnedFd, &'a OsStr), Unstaged> {
        let name = relative.file_name().ok_or(Unstaged::Escapes)?;
        let mut parent = open_folder(root).map_err(|_| Unstaged::Failed)?;
        for component in relative.parent().into_iter().flat_map(Path::components) {
            match component {
                Component::CurDir => {}
                Component::Normal(folder) => {
                    parent = open_child(&parent, &c_name(folder)?).map_err(|error| match error
                        .raw_os_error()
                    {
                        Some(libc::ELOOP | libc::ENOTDIR) => Unstaged::Escapes,
                        _ => Unstaged::Failed,
                    })?;
                }
                _ => return Err(Unstaged::Escapes),
            }
        }
        Ok((parent, name))
    }

    /// Opens `<git_dir>/bibcode-discard`, creating it, when it is private to this user.
    fn open_staging(git: &OwnedFd) -> Result<OwnedFd, Unstaged> {
        match make_folder(git, FOLDER) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(Unstaged::Failed),
        }
        let staging = open_child(git, FOLDER).map_err(|_| Unstaged::Failed)?;
        if !private(&staging) {
            tracing::warn!(
                "BiBCode's discard staging folder is not private to this user; not used"
            );
            return Err(Unstaged::Failed);
        }
        Ok(staging)
    }

    /// Moves back entries a crash left in `<git_dir>/bibcode-discard` (staged, with an origin
    /// record, and a holder whose lock no live discard in any process holds), each into the
    /// folder it came from
    /// below `worktree_root` (the checkout this Git directory belongs to) when that place is
    /// free; otherwise it stays, and is logged. Holders whose entry is gone (the trash took it
    /// before the record was removed) are removed with their record. A record is not trusted:
    /// one naming anything but a plain path below the checkout, outside Git's metadata, is
    /// ignored, and the path is opened without following a link.
    pub(super) fn recover(git_dir: &Path, worktree_root: &Path) {
        let Ok(git) = open_folder(git_dir) else {
            return;
        };
        let Ok(staging) = open_child(&git, FOLDER) else {
            return;
        };
        if !private(&staging) {
            return;
        }
        let Ok(entries) = std::fs::read_dir(git_dir.join(OsStr::from_bytes(FOLDER.to_bytes())))
        else {
            return;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(holder) = file_name
                .to_str()
                .and_then(|name| name.strip_suffix(RECORD))
            else {
                continue;
            };
            if !restore(&staging, holder, worktree_root) {
                tracing::warn!("a discarded entry stayed in BiBCode's staging folder");
            }
        }
    }

    /// Restores the entry of `holder` from its origin record; returns false when it stays.
    fn restore(staging: &OwnedFd, holder: &str, worktree_root: &Path) -> bool {
        let (Ok(holder_name), Ok(record_name)) = (
            CString::new(holder),
            CString::new(format!("{holder}{RECORD}")),
        ) else {
            return false;
        };
        let Some(relative) = read_record(staging, &record_name) else {
            return false;
        };
        let holder_fd = match open_child(staging, &holder_name) {
            Ok(holder) => holder,
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
                remove_file(staging, &record_name);
                return true;
            }
            Err(_) => return false,
        };
        // A live discard, here or in another server process, still owns it.
        if !lock(&holder_fd) {
            return true;
        }
        let Some(name) = relative.file_name().and_then(|name| c_name(name).ok()) else {
            return false;
        };
        if identity_at(&holder_fd, &name).is_none() {
            remove_folder(staging, &holder_name);
            remove_file(staging, &record_name);
            return true;
        }
        let Ok((parent, _)) = open_parent(worktree_root, &relative) else {
            return false;
        };
        if rename_no_replace(&holder_fd, &name, &parent, &name).is_err() {
            return false;
        }
        remove_folder(staging, &holder_name);
        remove_file(staging, &record_name);
        true
    }

    /// Writes `<uuid>.origin`: the entry's path below the checkout's root, the folder Git
    /// reports for this Git directory, so the root is never read from the record.
    fn write_record(staging: &OwnedFd, record_name: &CStr, relative: &Path) -> io::Result<()> {
        // SAFETY: `staging` is an open descriptor and `record_name` is NUL-terminated; the
        // file is new (`O_EXCL`) and never a link.
        let descriptor = unsafe {
            libc::openat(
                staging.as_raw_fd(),
                record_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600 as libc::c_uint,
            )
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `openat` returned a new descriptor that nothing else owns.
        let mut file = unsafe { std::fs::File::from_raw_fd(descriptor) };
        file.write_all(relative.as_os_str().as_bytes())?;
        file.sync_all()
    }

    /// The entry path a record names, when it is one BiBCode could have written (see
    /// [`is_record_path`]).
    fn read_record(staging: &OwnedFd, record_name: &CStr) -> Option<PathBuf> {
        // SAFETY: `staging` is an open descriptor and `record_name` is NUL-terminated.
        let descriptor = unsafe {
            libc::openat(
                staging.as_raw_fd(),
                record_name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return None;
        }
        // SAFETY: `openat` returned a new descriptor that nothing else owns.
        let file = unsafe { std::fs::File::from_raw_fd(descriptor) };
        let mut record = Vec::new();
        file.take(64 * 1024).read_to_end(&mut record).ok()?;
        let relative = PathBuf::from(OsStr::from_bytes(&record));
        is_record_path(&record, &relative).then_some(relative)
    }

    /// Whether `relative` (`bytes`) is a plain path below a checkout: no NUL, only plain parts
    /// (no root, `.` or `..`), and not under `.git` in any case, as `validate_pathspecs`
    /// requires of every discard path.
    fn is_record_path(bytes: &[u8], relative: &Path) -> bool {
        !bytes.is_empty()
            && !bytes.contains(&0)
            && relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            && relative
                .components()
                .next()
                .is_some_and(|first| !first.as_os_str().eq_ignore_ascii_case(".git"))
    }

    /// Stages the entry at `relative` below `root` into a new holder folder under `git_dir`.
    pub(super) fn stage(
        root: &Path,
        (git_dir, worktree_root): (&Path, &Path),
        relative: &str,
    ) -> Result<Staged, Unstaged> {
        let relative = Path::new(relative);
        let (parent, name) = open_parent(root, relative)?;
        let name_c = c_name(name)?;
        let git = open_folder(git_dir).map_err(|_| Unstaged::Failed)?;
        let staging = open_staging(&git)?;
        let holder_text = uuid::Uuid::new_v4().to_string();
        let holder_name = CString::new(holder_text.clone()).map_err(|_| Unstaged::Failed)?;
        let record_name =
            CString::new(format!("{holder_text}{RECORD}")).map_err(|_| Unstaged::Failed)?;
        make_folder(&staging, &holder_name).map_err(|_| Unstaged::Failed)?;
        let holder = match open_child(&staging, &holder_name) {
            Ok(holder) if lock(&holder) => holder,
            _ => {
                remove_folder(&staging, &holder_name);
                return Err(Unstaged::Failed);
            }
        };
        // Where the entry came from, written before it moves, so a crash before the trash
        // takes it leaves a record a later discard restores it from.
        let Ok(below_root) = root.strip_prefix(worktree_root) else {
            remove_folder(&staging, &holder_name);
            return Err(Unstaged::Failed);
        };
        if write_record(&staging, &record_name, &below_root.join(relative)).is_err() {
            remove_file(&staging, &record_name);
            remove_folder(&staging, &holder_name);
            return Err(Unstaged::Failed);
        }
        #[cfg(test)]
        super::discard_hooks::run(
            super::discard_hooks::Point::BeforeMove,
            &root.join(relative),
        );
        // SAFETY: both descriptors are open folders and both names are NUL-terminated; the
        // rename acts on the entries those handles hold and follows no link.
        let renamed = unsafe {
            libc::renameat(
                parent.as_raw_fd(),
                name_c.as_ptr(),
                holder.as_raw_fd(),
                name_c.as_ptr(),
            )
        };
        if renamed != 0 {
            remove_file(&staging, &record_name);
            remove_folder(&staging, &holder_name);
            return Err(Unstaged::Failed);
        }
        #[cfg(test)]
        super::discard_hooks::run(super::discard_hooks::Point::Staged, &root.join(relative));
        let staged = Staged {
            parent,
            staging,
            holder,
            holder_name,
            record_name,
            name: name_c,
            path: git_dir
                .join(OsStr::from_bytes(FOLDER.to_bytes()))
                .join(holder_text)
                .join(name),
        };
        // The trash takes a path and resolves it itself, so the path must name exactly what
        // BiBCode holds: each folder from the Git directory down, and the entry. One swapped
        // since it was opened sends the entry back, kept.
        let folders = [
            (git_dir.to_path_buf(), identity(&git)),
            (
                git_dir.join(OsStr::from_bytes(FOLDER.to_bytes())),
                identity(&staged.staging),
            ),
            (
                staged
                    .path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_default(),
                identity(&staged.holder),
            ),
            (
                staged.path.clone(),
                identity_at(&staged.holder, &staged.name),
            ),
        ];
        if !folders
            .iter()
            .all(|(path, held)| held.is_some() && path_identity(path) == *held)
        {
            if !staged.put_back() {
                tracing::warn!("a discarded entry stayed in BiBCode's staging folder");
            }
            return Err(Unstaged::Escapes);
        }
        Ok(staged)
    }

    /// The device and inode of an open folder.
    fn identity(folder: &OwnedFd) -> Option<(u64, u64)> {
        let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: `folder` is an open descriptor and `status` is writable.
        if unsafe { libc::fstat(folder.as_raw_fd(), status.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: `fstat` succeeded and filled `status`.
        let status = unsafe { status.assume_init() };
        #[allow(
            clippy::unnecessary_cast,
            reason = "the field types differ between platforms"
        )]
        Some((status.st_dev as u64, status.st_ino as u64))
    }

    /// The device and inode of entry `name` in `folder`, not following a link.
    fn identity_at(folder: &OwnedFd, name: &CStr) -> Option<(u64, u64)> {
        let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: `folder` is an open descriptor, `name` is NUL-terminated and `status` is
        // writable.
        if unsafe {
            libc::fstatat(
                folder.as_raw_fd(),
                name.as_ptr(),
                status.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return None;
        }
        // SAFETY: `fstatat` succeeded and filled `status`.
        let status = unsafe { status.assume_init() };
        #[allow(
            clippy::unnecessary_cast,
            reason = "the field types differ between platforms"
        )]
        Some((status.st_dev as u64, status.st_ino as u64))
    }

    /// The device and inode `path` names, resolved by string as the trash will, without
    /// following a link at its end.
    fn path_identity(path: &Path) -> Option<(u64, u64)> {
        use std::os::unix::fs::MetadataExt;
        std::fs::symlink_metadata(path)
            .ok()
            .map(|metadata| (metadata.dev(), metadata.ino()))
    }

    fn c_name(name: &OsStr) -> Result<CString, Unstaged> {
        CString::new(name.as_bytes()).map_err(|_| Unstaged::Escapes)
    }

    fn open_folder(path: &Path) -> io::Result<OwnedFd> {
        Ok(std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?
            .into())
    }

    fn open_child(folder: &OwnedFd, name: &CStr) -> io::Result<OwnedFd> {
        // SAFETY: `folder` is an open descriptor and `name` is NUL-terminated; `O_NOFOLLOW`
        // refuses a link in place of the folder.
        let descriptor = unsafe {
            libc::openat(
                folder.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `openat` returned a new descriptor that nothing else owns.
        Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
    }

    fn make_folder(folder: &OwnedFd, name: &CStr) -> io::Result<()> {
        // SAFETY: `folder` is an open descriptor and `name` is NUL-terminated.
        if unsafe { libc::mkdirat(folder.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Removes file `name` in `folder`, if it is there.
    fn remove_file(folder: &OwnedFd, name: &CStr) {
        // SAFETY: `folder` is an open descriptor and `name` is NUL-terminated.
        unsafe { libc::unlinkat(folder.as_raw_fd(), name.as_ptr(), 0) };
    }

    /// Removes empty folder `name` in `folder`; a folder that is not empty stays.
    fn remove_folder(folder: &OwnedFd, name: &CStr) {
        // SAFETY: `folder` is an open descriptor and `name` is NUL-terminated.
        unsafe { libc::unlinkat(folder.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) };
    }

    #[cfg(target_os = "linux")]
    fn rename_no_replace(
        from: &OwnedFd,
        from_name: &CStr,
        to: &OwnedFd,
        to_name: &CStr,
    ) -> io::Result<()> {
        // SAFETY: both descriptors are open folders and both names are NUL-terminated.
        let renamed = unsafe {
            libc::renameat2(
                from.as_raw_fd(),
                from_name.as_ptr(),
                to.as_raw_fd(),
                to_name.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if renamed != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(target_vendor = "apple")]
    fn rename_no_replace(
        from: &OwnedFd,
        from_name: &CStr,
        to: &OwnedFd,
        to_name: &CStr,
    ) -> io::Result<()> {
        // SAFETY: both descriptors are open folders and both names are NUL-terminated.
        let renamed = unsafe {
            libc::renameatx_np(
                from.as_raw_fd(),
                from_name.as_ptr(),
                to.as_raw_fd(),
                to_name.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if renamed != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Without an atomic no-replace rename, checks first; another unix has no native trash, so
    /// every staged entry comes back here.
    #[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
    fn rename_no_replace(
        from: &OwnedFd,
        from_name: &CStr,
        to: &OwnedFd,
        to_name: &CStr,
    ) -> io::Result<()> {
        let mut status = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: `to` is an open descriptor, `to_name` is NUL-terminated and `status` is
        // writable.
        if unsafe {
            libc::fstatat(
                to.as_raw_fd(),
                to_name.as_ptr(),
                status.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0
        {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        // SAFETY: both descriptors are open folders and both names are NUL-terminated.
        if unsafe {
            libc::renameat(
                from.as_raw_fd(),
                from_name.as_ptr(),
                to.as_raw_fd(),
                to_name.as_ptr(),
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// A canonical Windows path without its `\\?\` prefix, which the Recycle Bin refuses.
#[cfg(windows)]
fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    let stripped = {
        let text = path.to_string_lossy();
        match text.strip_prefix(r"\\?\UNC\") {
            Some(share) => Some(format!(r"\\{share}")),
            None => text.strip_prefix(r"\\?\").map(str::to_owned),
        }
    };
    stripped.map_or(path, PathBuf::from)
}

#[cfg(not(windows))]
fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

/// Test hooks that run inside a discard's move window, so a test can change the file system
/// between the containment check and the move. Unix only: only the unix move has a window a
/// test can enter (between opening the folder and the rename).
#[cfg(all(test, unix))]
pub(crate) mod discard_hooks {
    use std::{
        path::{Path, PathBuf},
        sync::Mutex,
    };

    type Hook = Box<dyn FnOnce() + Send>;

    /// Where in the move a hook runs.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum Point {
        /// After the entry's folder is open, before the rename into the staging folder.
        BeforeMove,
        /// After the rename, before the staged path is checked and handed to the trash.
        Staged,
    }

    static HOOKS: Mutex<Vec<(PathBuf, Point, Hook)>> = Mutex::new(Vec::new());

    /// Runs `hook` once at `point` of the discard of `entry` (the canonical checkout joined with
    /// the discarded path). Keyed by path, so tests running at once never share one.
    pub(crate) fn on(point: Point, entry: PathBuf, hook: impl FnOnce() + Send + 'static) {
        HOOKS
            .lock()
            .expect("discard hooks")
            .push((entry, point, Box::new(hook)));
    }

    pub(super) fn run(point: Point, entry: &Path) {
        let hook = {
            let mut hooks = HOOKS.lock().expect("discard hooks");
            hooks
                .iter()
                .position(|(key, at, _)| key == entry && *at == point)
                .map(|index| hooks.remove(index).2)
        };
        if let Some(hook) = hook {
            hook();
        }
    }
}

fn path_matches(requested: &str, candidate: &str) -> bool {
    candidate == requested
        || candidate
            .strip_prefix(requested)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

async fn native_trash_request(path: &Path) -> Result<ProcessRequest, TrashUnavailable> {
    let cwd = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or(TrashUnavailable)?
        .to_path_buf();
    let (command, args) = native_trash_command(path).await?;
    Ok(ProcessRequest {
        operation: "GitManager.discard.trash".to_owned(),
        command,
        args,
        cwd,
        env: Vec::new(),
        stdin: None,
        timeout: Duration::from_secs(30),
        max_output_bytes: 64 * 1024,
        output_policy: OutputPolicy::Truncate,
        append_truncation_marker: false,
        allow_non_zero_exit: false,
    })
}

#[cfg(target_os = "linux")]
async fn native_trash_command(path: &Path) -> Result<(PathBuf, Vec<OsString>), TrashUnavailable> {
    Ok((
        PathBuf::from("gio"),
        vec![OsString::from("trash"), OsString::from("--"), path.into()],
    ))
}

#[cfg(target_os = "macos")]
async fn native_trash_command(path: &Path) -> Result<(PathBuf, Vec<OsString>), TrashUnavailable> {
    Ok((
        PathBuf::from("/usr/bin/osascript"),
        vec![
            OsString::from("-e"),
            OsString::from("on run argv"),
            OsString::from("-e"),
            OsString::from("tell application \"Finder\" to delete POSIX file (item 1 of argv)"),
            OsString::from("-e"),
            OsString::from("end run"),
            OsString::from("--"),
            path.into(),
        ],
    ))
}

#[cfg(windows)]
async fn native_trash_command(path: &Path) -> Result<(PathBuf, Vec<OsString>), TrashUnavailable> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| TrashUnavailable)?;
    let method = if metadata.is_dir() {
        "DeleteDirectory"
    } else {
        "DeleteFile"
    };
    let script = format!(
        "Add-Type -AssemblyName Microsoft.VisualBasic; \
         [Microsoft.VisualBasic.FileIO.FileSystem]::{method}($args[0], \
         [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, \
         [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)"
    );
    Ok((
        PathBuf::from("powershell.exe"),
        vec![
            OsString::from("-NoProfile"),
            OsString::from("-NonInteractive"),
            OsString::from("-Command"),
            OsString::from(script),
            path.into(),
        ],
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
async fn native_trash_command(_path: &Path) -> Result<(PathBuf, Vec<OsString>), TrashUnavailable> {
    Err(TrashUnavailable)
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        process::Command,
        sync::{Arc, Mutex},
    };

    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::git::GitRepository;

    fn git_output(cwd: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Git Manager Test")
            .env("GIT_AUTHOR_EMAIL", "git-manager@example.test")
            .env("GIT_COMMITTER_NAME", "Git Manager Test")
            .env("GIT_COMMITTER_EMAIL", "git-manager@example.test")
            .output()
            .expect("git fixture starts")
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = git_output(cwd, args);
        assert!(
            output.status.success(),
            "git fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn operation_snapshot(cwd: &Path) -> GitManagerRefsSnapshot {
        GitManagerRefsSnapshot {
            generation: 1,
            head_ref: Some("main".into()),
            detached_sha: None,
            is_dirty: false,
            default_branch: Some("main".into()),
            remotes: Vec::new(),
            local_branches: vec![crate::git::GitManagerRefEntry {
                name: "main".into(),
                tip_sha: git(cwd, &["rev-parse", "HEAD"]),
                upstream: None,
                ahead: 0,
                behind: 0,
                current: true,
                is_default: true,
                worktree_path: Some(cwd.to_string_lossy().into_owned()),
                blocked: Vec::new(),
            }],
            remote_branches: Vec::new(),
            tags: Vec::new(),
            worktrees: Vec::new(),
            in_progress_operation: None,
            conflicted_paths: Vec::new(),
        }
    }

    struct RecordingTrash {
        destination: PathBuf,
        trashed: Mutex<Vec<PathBuf>>,
    }

    struct UnavailableTrash;

    impl FileTrash for UnavailableTrash {
        fn trash<'a>(
            &'a self,
            _path: PathBuf,
            _cancellation: &'a CancellationToken,
        ) -> FileTrashFuture<'a> {
            Box::pin(async { Err(TrashUnavailable) })
        }
    }

    impl FileTrash for RecordingTrash {
        fn trash<'a>(
            &'a self,
            path: PathBuf,
            _cancellation: &'a CancellationToken,
        ) -> FileTrashFuture<'a> {
            Box::pin(async move {
                let destination = self.destination.join(
                    path.file_name()
                        .expect("discard fixture path has a file name"),
                );
                tokio::fs::rename(&path, destination)
                    .await
                    .map_err(|_| TrashUnavailable)?;
                self.trashed
                    .lock()
                    .expect("recording trash mutex")
                    .push(path);
                Ok(())
            })
        }
    }

    fn assert_failure_code(stderr: &str, expected: GitManagerFailureCode) {
        assert_eq!(classify_operation_failure(1, stderr), expected);
    }

    #[test]
    fn classifies_authentication_failures() {
        for stderr in [
            "fatal: Authentication failed",
            "fatal: could not read Username for 'https://example.test'",
            "fatal: could not read Password for 'https://example.test'",
            "remote: Permission denied (publickey)",
        ] {
            assert_failure_code(stderr, GitManagerFailureCode::Authentication);
        }
    }

    #[test]
    fn classifies_non_fast_forward_failures() {
        for stderr in [
            "! [rejected] main -> main (non-fast-forward)",
            "rejected because the remote contains work; updates were rejected",
        ] {
            assert_failure_code(stderr, GitManagerFailureCode::NonFastForward);
        }
    }

    #[test]
    fn classifies_stale_info_failures() {
        assert_failure_code("rejected: stale info", GitManagerFailureCode::StaleInfo);
    }

    #[test]
    fn classifies_stalled_network_transfers_with_an_actionable_message() {
        for stderr in [
            "error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds\nfatal: expected flush after ref listing",
            "fatal: unable to access 'https://example.test/repository.git/': Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds",
            crate::git::NETWORK_TRANSFER_STALLED,
        ] {
            assert_failure_code(stderr, GitManagerFailureCode::NetworkStalled);
        }
        let error = require_last_success(
            "fetch",
            vec![ProcessOutput {
                exit_code: 128,
                stdout: String::new(),
                stderr: "error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds".to_owned(),
                stdout_truncated: false,
                stderr_truncated: false,
            }],
        )
        .expect_err("a stalled fetch fails");
        assert_eq!(error.code, "network-stalled");
        assert_eq!(error.message, crate::git::NETWORK_TRANSFER_STALLED);
    }

    #[test]
    fn classifies_local_changes_overwritten_failures() {
        assert_failure_code(
            "Your local changes to the following files would be overwritten by checkout",
            GitManagerFailureCode::LocalChangesOverwritten,
        );
    }

    #[test]
    fn classifies_conflict_failures() {
        for stderr in [
            "CONFLICT (content): Merge conflict in tracked.txt",
            "Automatic merge failed; fix conflicts and then commit the result.",
        ] {
            assert_failure_code(stderr, GitManagerFailureCode::Conflicts);
        }
    }

    #[test]
    fn classifies_rebase_outcomes_without_a_second_stderr_matcher() {
        assert_eq!(
            classify_operation_failure(0, "Current branch topic is up to date."),
            GitManagerFailureCode::AlreadyUpToDate
        );
        assert_eq!(
            classify_operation_failure(0, ""),
            GitManagerFailureCode::Completed
        );
        assert_eq!(
            classify_operation_failure(1, "error: could not apply abcdef1... topic"),
            GitManagerFailureCode::ConflictsEncountered
        );
        assert_eq!(
            classify_operation_failure(
                1,
                "file.txt: needs merge\nYou must edit all merge conflicts and then mark them as resolved using git add"
            ),
            GitManagerFailureCode::OutstandingFilesNotStaged
        );
    }

    #[test]
    fn conflicting_pop_stdout_is_reported_as_a_conflict() {
        let error = require_last_success(
            "stash-pop",
            vec![ProcessOutput {
                exit_code: 1,
                stdout: "CONFLICT (content): Merge conflict in tracked.txt\n".into(),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
            }],
        )
        .expect_err("conflicting pop fails");

        assert_eq!(error.code, "conflicts");
    }

    #[test]
    fn stash_outcomes_that_save_or_restore_nothing_are_reported() {
        let output = |exit_code: i32, stdout: &str, stderr: &str| ProcessOutput {
            exit_code,
            stdout: stdout.into(),
            stderr: stderr.into(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let collision = require_last_success(
            "stash-pop",
            vec![output(
                1,
                "docs/notes.md already exists, no checkout\n",
                "error: could not restore untracked files from stash\n",
            )],
        )
        .expect_err("colliding untracked restore fails");
        assert_eq!(collision.code, "stash-untracked-collision");

        let nothing = require_stash_entry(
            "stash-push",
            vec![output(0, "No local changes to save\n", "")],
        )
        .expect_err("an empty stash push is not a saved stash");
        assert_eq!(nothing.code, "nothing-to-stash");
        assert_eq!(nothing.outputs.len(), 1);

        let saved = vec![output(
            0,
            "Saved working directory and index state On main: WIP\n",
            "",
        )];
        assert_eq!(
            require_stash_entry("stash-push", saved.clone()).expect("saved stash"),
            saved
        );
    }

    #[test]
    fn phase_09_operation_requests_decode_the_contract_fields() {
        let stash: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "stash-push",
            "cwd": "/repo",
            "projectId": "project-1",
            "message": "save all work",
            "paths": ["untracked.txt"]
        }))
        .expect("stash request");
        assert!(matches!(
            stash,
            GitManagerOperationRequest::StashPush { message, paths, include_untracked, .. }
                if message == "save all work" && paths == ["untracked.txt"] && !include_untracked
        ));
        let leave_changes: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "stash-push",
            "cwd": "/repo",
            "projectId": "project-1",
            "message": "WIP before switching to develop",
            "paths": [],
            "includeUntracked": true
        }))
        .expect("stash request with untracked files");
        assert!(matches!(
            leave_changes,
            GitManagerOperationRequest::StashPush { paths, include_untracked, .. }
                if paths.is_empty() && include_untracked
        ));

        let merge: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "merge",
            "cwd": "/repo",
            "projectId": "project-1",
            "source": "feature",
            "noVerify": true
        }))
        .expect("merge request");
        assert!(matches!(
            merge,
            GitManagerOperationRequest::Merge { source, no_verify, .. }
                if source == "feature" && no_verify
        ));
    }

    #[test]
    fn phase_09_operations_are_admitted_by_the_executor() {
        for request in [
            GitManagerOperationRequest::StashApply {
                cwd: PathBuf::from("/repo"),
                project_id: "project-1".into(),
                index: 0,
            },
            GitManagerOperationRequest::Merge {
                cwd: PathBuf::from("/repo"),
                project_id: "project-1".into(),
                source: "feature".into(),
                no_verify: false,
            },
        ] {
            assert!(request.is_implemented_through_phase_16());
        }
    }

    #[test]
    fn phase_13_operation_requests_decode_all_contract_fields() {
        let rebase: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "rebase",
            "cwd": "/repo",
            "projectId": "project-1",
            "base": "main",
            "target": "topic"
        }))
        .expect("rebase request");
        assert!(matches!(
            rebase,
            GitManagerOperationRequest::Rebase { base, target, .. }
                if base == "main" && target == "topic"
        ));

        let squash: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "squash",
            "cwd": "/repo",
            "projectId": "project-1",
            "shas": ["bbbbbbb", "aaaaaaa"],
            "message": "combined"
        }))
        .expect("squash request");
        assert!(matches!(
            squash,
            GitManagerOperationRequest::Squash { shas, message, .. }
                if shas == ["bbbbbbb", "aaaaaaa"] && message == "combined"
        ));

        let recovery: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "resolve-conflict",
            "cwd": "/repo",
            "projectId": "project-1",
            "path": "nested/file.txt",
            "side": "theirs"
        }))
        .expect("resolution request");
        assert!(matches!(
            recovery,
            GitManagerOperationRequest::ResolveConflict {
                path,
                side: super::ConflictSide::Theirs,
                ..
            } if path == "nested/file.txt"
        ));
    }

    #[test]
    fn phase_16_tag_requests_retain_every_contract_operand() {
        let create: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "tag-create",
            "cwd": "/repo",
            "projectId": "project-1",
            "name": "release/v1",
            "sha": "0123456789abcdef0123456789abcdef01234567"
        }))
        .expect("tag-create request");
        let delete: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "tag-delete",
            "cwd": "/repo",
            "projectId": "project-1",
            "name": "release/v1"
        }))
        .expect("tag-delete request");
        let push: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "tag-push",
            "cwd": "/repo",
            "projectId": "project-1",
            "name": "release/v1",
            "remote": "origin"
        }))
        .expect("tag-push request");

        assert!(matches!(
            create,
            GitManagerOperationRequest::TagCreate { name, sha, .. }
                if name == "release/v1"
                    && sha == "0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(matches!(
            delete,
            GitManagerOperationRequest::TagDelete { name, .. } if name == "release/v1"
        ));
        assert!(matches!(
            push,
            GitManagerOperationRequest::TagPush { name, remote, .. }
                if name == "release/v1" && remote == "origin"
        ));
    }

    #[tokio::test]
    async fn cherry_pick_operation_arm_applies_the_requested_commit() {
        let repository = tempfile::tempdir().expect("temporary repository");
        git(repository.path(), &["init", "-q", "-b", "main"]);
        git(repository.path(), &["config", "core.autocrlf", "false"]);
        git(
            repository.path(),
            &["config", "user.email", "git-manager@example.test"],
        );
        git(
            repository.path(),
            &["config", "user.name", "Git Manager Test"],
        );
        std::fs::write(repository.path().join("base.txt"), "base\n").expect("base file");
        git(repository.path(), &["add", "base.txt"]);
        git(repository.path(), &["commit", "-q", "-m", "base"]);
        git(repository.path(), &["checkout", "-q", "-b", "source"]);
        std::fs::write(repository.path().join("picked.txt"), "picked\n").expect("picked file");
        git(repository.path(), &["add", "picked.txt"]);
        git(repository.path(), &["commit", "-q", "-m", "picked"]);
        let picked_sha = git(repository.path(), &["rev-parse", "HEAD"]);
        git(repository.path(), &["checkout", "-q", "main"]);
        let snapshot = operation_snapshot(repository.path());
        let request = GitManagerOperationRequest::CherryPick {
            cwd: repository.path().to_path_buf(),
            project_id: "project-1".into(),
            shas: vec![picked_sha],
        };

        let outcome = execute_branch_or_sync_operation(
            &GitRepository::default(),
            &snapshot,
            &request,
            &CancellationToken::new(),
        )
        .await
        .expect("cherry-pick operation");

        assert_eq!(outcome.operation, "cherry-pick");
        assert_eq!(outcome.outputs.len(), 1);
        assert_eq!(
            std::fs::read_to_string(repository.path().join("picked.txt"))
                .expect("picked file exists"),
            "picked\n"
        );
    }

    #[test]
    fn classifies_no_upstream_failures() {
        assert_failure_code(
            "There is no tracking information for the current branch.",
            GitManagerFailureCode::NoUpstream,
        );
    }

    #[test]
    fn classifies_cancelled_failures() {
        assert_failure_code(
            "Git command was interrupted.",
            GitManagerFailureCode::Cancelled,
        );
    }

    #[test]
    fn classifies_timed_out_failures() {
        assert_failure_code("Git command timed out.", GitManagerFailureCode::TimedOut);
    }

    #[test]
    fn unknown_failures_use_the_fallback_code() {
        assert_failure_code(
            "fatal: an unfamiliar failure",
            GitManagerFailureCode::Unknown,
        );
    }

    #[test]
    fn delete_guard_revalidation_returns_the_prune_first_structured_reason() {
        let worktree_path = "/repo/missing-topic";
        let snapshot = crate::git::GitManagerRefsSnapshot {
            generation: 1,
            head_ref: Some("main".into()),
            detached_sha: None,
            is_dirty: false,
            default_branch: Some("main".into()),
            remotes: vec!["origin".into()],
            local_branches: vec![crate::git::GitManagerRefEntry {
                name: "topic".into(),
                tip_sha: "0123456789012345678901234567890123456789".into(),
                upstream: Some("origin/topic".into()),
                ahead: 0,
                behind: 0,
                current: false,
                is_default: false,
                worktree_path: Some(worktree_path.into()),
                blocked: Vec::new(),
            }],
            remote_branches: Vec::new(),
            tags: Vec::new(),
            worktrees: vec![crate::git::GitManagerWorktreeEntry {
                path: worktree_path.into(),
                head_sha: "0123456789012345678901234567890123456789".into(),
                branch: Some("topic".into()),
                is_primary: false,
                is_bare: false,
                is_detached: false,
                locked: false,
                lock_reason: None,
                prunable: true,
            }],
            in_progress_operation: None,
            conflicted_paths: Vec::new(),
        };
        let request = GitManagerOperationRequest::BranchDelete {
            cwd: PathBuf::from("/repo"),
            project_id: "project-1".into(),
            name: "topic".into(),
            force: true,
            delete_remote: false,
        };

        let reason = blocked_reason_for_operation(&snapshot, &request)
            .expect("missing registered worktree blocks branch deletion");

        assert_eq!(reason.operation, "delete-branch");
        assert_eq!(reason.code, "worktree-checked-out");
        assert!(
            reason
                .message
                .contains("remove or prune the worktree first")
        );
    }

    #[test]
    fn rebase_guard_revalidation_blocks_a_target_held_by_another_worktree() {
        let worktree_path = "/repo/topic-worktree";
        let snapshot = crate::git::GitManagerRefsSnapshot {
            generation: 1,
            head_ref: Some("main".into()),
            detached_sha: None,
            is_dirty: false,
            default_branch: Some("main".into()),
            remotes: Vec::new(),
            local_branches: vec![crate::git::GitManagerRefEntry {
                name: "topic".into(),
                tip_sha: "0123456789012345678901234567890123456789".into(),
                upstream: None,
                ahead: 0,
                behind: 0,
                current: false,
                is_default: false,
                worktree_path: Some(worktree_path.into()),
                blocked: Vec::new(),
            }],
            remote_branches: Vec::new(),
            tags: Vec::new(),
            worktrees: Vec::new(),
            in_progress_operation: None,
            conflicted_paths: Vec::new(),
        };
        let request = GitManagerOperationRequest::Rebase {
            cwd: PathBuf::from("/repo"),
            project_id: "project-1".into(),
            base: "main".into(),
            target: "topic".into(),
        };

        let reason = blocked_reason_for_operation(&snapshot, &request)
            .expect("occupied rebase target is blocked before Git");

        assert_eq!(reason.operation, "rebase");
        assert_eq!(reason.code, "worktree-checked-out");
        assert!(reason.message.contains(worktree_path));
    }

    fn merge_into_snapshot(
        worktree_path: Option<&str>,
        dirty: bool,
    ) -> crate::git::GitManagerRefsSnapshot {
        crate::git::GitManagerRefsSnapshot {
            generation: 1,
            head_ref: Some("main".into()),
            detached_sha: None,
            is_dirty: dirty,
            default_branch: Some("main".into()),
            remotes: Vec::new(),
            local_branches: vec![crate::git::GitManagerRefEntry {
                name: "release".into(),
                tip_sha: "0123456789012345678901234567890123456789".into(),
                upstream: None,
                ahead: 0,
                behind: 0,
                current: false,
                is_default: false,
                worktree_path: worktree_path.map(Into::into),
                blocked: Vec::new(),
            }],
            remote_branches: Vec::new(),
            tags: Vec::new(),
            worktrees: Vec::new(),
            in_progress_operation: None,
            conflicted_paths: Vec::new(),
        }
    }

    fn merge_into_request() -> GitManagerOperationRequest {
        GitManagerOperationRequest::MergeInto {
            cwd: PathBuf::from("/repo"),
            project_id: "project-1".into(),
            source: "refs/heads/feature".into(),
            target: "release".into(),
        }
    }

    #[test]
    fn merge_into_blocks_a_target_held_by_another_worktree() {
        let reason = blocked_reason_for_operation(
            &merge_into_snapshot(Some("/repo/release-worktree"), false),
            &merge_into_request(),
        )
        .expect("occupied merge-into target is blocked");

        assert_eq!(reason.operation, "merge-into");
        assert_eq!(reason.code, "worktree-checked-out");
        assert!(reason.message.contains("/repo/release-worktree"));
    }

    #[test]
    fn merge_into_ignores_a_dirty_selected_worktree() {
        assert_eq!(
            blocked_reason_for_operation(&merge_into_snapshot(None, true), &merge_into_request()),
            None
        );
    }

    #[test]
    fn merge_into_failures_map_to_the_wire_codes() {
        use merge::{GitManagerMergeError, MergeIntoError};

        let too_old = merge_into_error(
            "merge-into",
            "release",
            MergeIntoError::Merge(GitManagerMergeError::GitTooOld {
                found: crate::git::GitVersion {
                    major: 2,
                    minor: 34,
                    patch: 1,
                },
            }),
        );
        assert_eq!(too_old.code, "git-too-old");
        assert_eq!(
            too_old.message,
            "Merging into another branch needs Git 2.38 or later on this environment (found 2.34.1)."
        );

        let invalid_target = merge_into_error(
            "merge-into",
            "release~1",
            MergeIntoError::Merge(GitManagerMergeError::InvalidTarget),
        );
        assert_eq!(invalid_target.code, "local-branch-not-found");

        let in_use = merge_into_error(
            "merge-into",
            "release",
            MergeIntoError::InUse {
                path: Some("/w/release".into()),
            },
        );
        assert_eq!(in_use.code, "worktree-checked-out");
        assert!(in_use.blocked.is_some());
        assert!(in_use.message.contains("/w/release"));
    }

    #[test]
    fn merge_into_failure_messages_never_end_in_an_empty_detail() {
        use merge::MergeIntoError;

        let silent = ProcessOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: " \n".into(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let publish = merge_into_error(
            "merge-into",
            "release",
            MergeIntoError::PublishFailed(silent.clone()),
        );
        assert_eq!(
            publish.message,
            "Git could not update release: Git exited with 1."
        );
        let commit = merge_into_error(
            "merge-into",
            "release",
            MergeIntoError::CommitFailed(silent),
        );
        assert_eq!(
            commit.message,
            "Git could not create the merge commit: Git exited with 1."
        );
    }

    #[test]
    fn builds_commit_arguments_from_the_request_options() {
        let request = CommitRequest {
            summary: "Fix the parser".into(),
            description: Some("Handles NUL records.".into()),
            amend: true,
            no_verify: true,
            signoff: true,
            allow_empty: false,
            co_authors: vec![CoAuthor {
                name: "Ann Author".into(),
                email: "ann@example.test".into(),
            }],
        };
        let args = commit_arguments(&request);
        assert_eq!(args[0], "commit");
        assert!(args.contains(&"--amend".to_owned()));
        assert!(args.contains(&"--no-verify".to_owned()));
        assert!(args.contains(&"--signoff".to_owned()));
        assert!(!args.contains(&"--allow-empty".to_owned()));
        assert!(args.contains(&"-F".to_owned()) && args.contains(&"-".to_owned()));
        assert_eq!(
            commit_message_body(&request),
            "Fix the parser\n\nHandles NUL records.\n\nCo-Authored-By: Ann Author <ann@example.test>\n"
        );
    }

    #[test]
    fn builds_several_coauthors_as_one_trailing_block() {
        let request = CommitRequest {
            summary: "Fix the parser".into(),
            description: Some("Handles trailer blocks.".into()),
            amend: false,
            no_verify: false,
            signoff: false,
            allow_empty: false,
            co_authors: vec![
                CoAuthor {
                    name: "Ann Author".into(),
                    email: "ann@example.test".into(),
                },
                CoAuthor {
                    name: "Bob Builder".into(),
                    email: "bob@example.test".into(),
                },
            ],
        };

        assert_eq!(
            commit_message_body(&request),
            "Fix the parser\n\nHandles trailer blocks.\n\n\
             Co-Authored-By: Ann Author <ann@example.test>\n\
             Co-Authored-By: Bob Builder <bob@example.test>\n"
        );
    }

    #[test]
    fn splits_a_message_without_trailers_unchanged() {
        assert_eq!(
            parse_undo_commit_message("Fix the parser\n\nHandles NUL records.\n"),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Handles NUL records.".into(),
                co_authors: Vec::new(),
            }
        );
    }

    #[test]
    fn splits_one_trailing_coauthor_from_the_description() {
        assert_eq!(
            parse_undo_commit_message(
                "Fix the parser\n\nHandles NUL records.\n\n\
                 Co-Authored-By: Ann Author <ann@example.test>\n",
            ),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Handles NUL records.".into(),
                co_authors: vec![CoAuthor {
                    name: "Ann Author".into(),
                    email: "ann@example.test".into(),
                }],
            }
        );
    }

    #[test]
    fn splits_several_coauthors_from_one_trailing_block() {
        assert_eq!(
            parse_undo_commit_message(
                "Fix the parser\n\nHandles NUL records.\n\n\
                 Co-Authored-By: Ann Author <ann@example.test>\n\
                 Co-Authored-By: Bob Builder <bob@example.test>\n",
            ),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Handles NUL records.".into(),
                co_authors: vec![
                    CoAuthor {
                        name: "Ann Author".into(),
                        email: "ann@example.test".into(),
                    },
                    CoAuthor {
                        name: "Bob Builder".into(),
                        email: "bob@example.test".into(),
                    },
                ],
            }
        );
    }

    #[test]
    fn preserves_a_coauthor_shaped_line_in_the_middle_of_the_body() {
        assert_eq!(
            parse_undo_commit_message(
                "Fix the parser\n\nBefore the example.\n\
                 Co-Authored-By: Documentation Example <docs@example.test>\n\
                 After the example.\n",
            ),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Before the example.\n\
                              Co-Authored-By: Documentation Example <docs@example.test>\n\
                              After the example."
                    .into(),
                co_authors: Vec::new(),
            }
        );
    }

    #[test]
    fn ignores_trailing_whitespace_around_the_trailer_block() {
        assert_eq!(
            parse_undo_commit_message(
                "Fix the parser\r\n\r\nHandles NUL records.\r\n \t\r\n\
                 Co-Authored-By: Ann Author <ann@example.test>   \r\n \t\r\n",
            ),
            UndoCommitDraft {
                summary: "Fix the parser".into(),
                description: "Handles NUL records.".into(),
                co_authors: vec![CoAuthor {
                    name: "Ann Author".into(),
                    email: "ann@example.test".into(),
                }],
            }
        );
    }

    #[test]
    fn restores_the_commit_draft_without_coauthor_trailers() {
        let draft = parse_undo_commit_message(
            "Fix the parser\n\nHandles NUL records.\n\
             Co-Authored-By: Documentation Example <docs@example.test>\n\
             explains the trailer syntax above.\n\n\
             Co-Authored-By: Ann Author <ann@example.test>\n\
             Signed-off-by: Dev User <dev@example.test>\n\
             Co-Authored-By: Bob Builder <bob@example.test>\n",
        );

        assert_eq!(draft.summary, "Fix the parser");
        assert_eq!(
            draft.description,
            "Handles NUL records.\nCo-Authored-By: Documentation Example <docs@example.test>\n\
             explains the trailer syntax above.\n\nSigned-off-by: Dev User <dev@example.test>"
        );
        assert_eq!(
            draft.co_authors,
            [
                CoAuthor {
                    name: "Ann Author".into(),
                    email: "ann@example.test".into(),
                },
                CoAuthor {
                    name: "Bob Builder".into(),
                    email: "bob@example.test".into(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn discard_trashes_files_then_restores_tracked_content() {
        fn git(cwd: &Path, args: &[&str]) {
            let output = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_NAME", "Git Manager Test")
                .env("GIT_AUTHOR_EMAIL", "git-manager@example.test")
                .env("GIT_COMMITTER_NAME", "Git Manager Test")
                .env("GIT_COMMITTER_EMAIL", "git-manager@example.test")
                .output()
                .expect("git fixture starts");
            assert!(
                output.status.success(),
                "git fixture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let fixture = tempfile::tempdir().expect("temporary repository");
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        git(fixture.path(), &["config", "core.autocrlf", "false"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        std::fs::write(fixture.path().join("tracked.txt"), "changed\n")
            .expect("changed tracked file");
        std::fs::write(fixture.path().join("untracked.txt"), "untracked\n")
            .expect("untracked file");
        let trash = Arc::new(RecordingTrash {
            destination: trash_directory.path().to_path_buf(),
            trashed: Mutex::new(Vec::new()),
        });

        let result = discard_paths(
            &GitRepository::default(),
            trash,
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["tracked.txt".into(), "untracked.txt".into()],
                permit_permanent: false,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("discard succeeds");

        assert_eq!(result.trashed, ["tracked.txt", "untracked.txt"]);
        assert!(result.permanently_discarded.is_empty());
        assert!(result.trash_unavailable.is_empty());
        assert_eq!(
            std::fs::read_to_string(fixture.path().join("tracked.txt"))
                .expect("tracked file restored"),
            "base\n"
        );
        assert!(!fixture.path().join("untracked.txt").exists());
    }

    #[tokio::test]
    async fn discard_requires_permission_before_permanently_removing_an_untracked_file() {
        fn git(cwd: &Path, args: &[&str]) {
            let output = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git fixture starts");
            assert!(
                output.status.success(),
                "git fixture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let fixture = tempfile::tempdir().expect("temporary repository");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        git(fixture.path(), &["config", "core.autocrlf", "false"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(
            fixture.path(),
            &[
                "-c",
                "user.name=Git Manager Test",
                "-c",
                "user.email=git-manager@example.test",
                "commit",
                "-q",
                "-m",
                "base",
            ],
        );
        std::fs::write(fixture.path().join("untracked.txt"), "untracked\n")
            .expect("untracked file");
        let repository = GitRepository::default();

        let unavailable = discard_paths(
            &repository,
            Arc::new(UnavailableTrash),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["untracked.txt".into()],
                permit_permanent: false,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("trash unavailability is an outcome");
        assert_eq!(unavailable.trash_unavailable, ["untracked.txt"]);
        assert!(fixture.path().join("untracked.txt").exists());

        let permanent = discard_paths(
            &repository,
            Arc::new(UnavailableTrash),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["untracked.txt".into()],
                permit_permanent: true,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("confirmed permanent discard succeeds");
        assert_eq!(permanent.permanently_discarded, ["untracked.txt"]);
        assert!(!fixture.path().join("untracked.txt").exists());
    }

    /// The permanent fallback (`git clean` without `-x`) leaves an ignored file in place, so it
    /// is reported as kept, never as permanently discarded.
    #[tokio::test]
    async fn a_permanent_discard_never_reports_an_ignored_file_it_left_in_place() {
        let fixture = tempfile::tempdir().expect("temporary repository");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        git(fixture.path(), &["config", "core.autocrlf", "false"]);
        std::fs::write(fixture.path().join(".gitignore"), "*.log\n").expect("ignore file");
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", ".gitignore", "tracked.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        std::fs::write(fixture.path().join("tracked.txt"), "changed\n").expect("change");
        std::fs::write(fixture.path().join("untracked.txt"), "untracked\n").expect("untracked");
        std::fs::write(fixture.path().join("ignored.log"), "ignored\n").expect("ignored");
        std::fs::create_dir(fixture.path().join("logs")).expect("ignored folder");
        std::fs::write(fixture.path().join("logs/only.log"), "ignored\n").expect("ignored");

        let outcome = discard_paths(
            &GitRepository::default(),
            Arc::new(UnavailableTrash),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec![
                    "ignored.log".into(),
                    "untracked.txt".into(),
                    "tracked.txt".into(),
                    "logs".into(),
                ],
                permit_permanent: true,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");

        assert_eq!(
            outcome.permanently_discarded,
            ["untracked.txt", "tracked.txt"]
        );
        assert_eq!(outcome.trash_unavailable, ["ignored.log", "logs"]);
        assert!(fixture.path().join("ignored.log").exists());
        assert!(fixture.path().join("logs/only.log").exists());
        assert!(!fixture.path().join("untracked.txt").exists());
        assert_eq!(
            std::fs::read_to_string(fixture.path().join("tracked.txt")).unwrap(),
            "base\n"
        );
    }

    #[tokio::test]
    async fn discard_restores_an_absent_tracked_file_without_trash_confirmation() {
        fn git(cwd: &Path, args: &[&str]) {
            let output = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git fixture starts");
            assert!(
                output.status.success(),
                "git fixture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let fixture = tempfile::tempdir().expect("temporary repository");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        git(fixture.path(), &["config", "core.autocrlf", "false"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(
            fixture.path(),
            &[
                "-c",
                "user.name=Git Manager Test",
                "-c",
                "user.email=git-manager@example.test",
                "commit",
                "-q",
                "-m",
                "base",
            ],
        );
        let repository = GitRepository::default();

        for permit_permanent in [false, true] {
            std::fs::remove_file(fixture.path().join("tracked.txt")).expect("delete tracked file");
            let outcome = discard_paths(
                &repository,
                Arc::new(UnavailableTrash),
                DiscardRequest {
                    cwd: fixture.path().to_path_buf(),
                    paths: vec!["tracked.txt".into()],
                    permit_permanent,
                },
                &CancellationToken::new(),
            )
            .await
            .expect("deleted tracked file is restored");

            assert!(outcome.trash_unavailable.is_empty());
            assert!(outcome.permanently_discarded.is_empty());
            assert_eq!(
                std::fs::read_to_string(fixture.path().join("tracked.txt"))
                    .expect("tracked file restored"),
                "base\n"
            );
        }
    }

    /// Moves each file into `destination`; while trashing the first, it swaps folder `swap.0`
    /// for a symlink to `swap.1`, as another process could between the check and the move.
    #[cfg(unix)]
    struct SwappingTrash {
        destination: PathBuf,
        swap: (PathBuf, PathBuf),
        trashed: Mutex<Vec<PathBuf>>,
    }

    #[cfg(unix)]
    impl FileTrash for SwappingTrash {
        fn trash<'a>(
            &'a self,
            path: PathBuf,
            _cancellation: &'a CancellationToken,
        ) -> FileTrashFuture<'a> {
            Box::pin(async move {
                let mut trashed = self.trashed.lock().expect("swapping trash mutex");
                if trashed.is_empty() {
                    let (folder, outside) = &self.swap;
                    std::fs::rename(folder, self.destination.join("swapped-away"))
                        .expect("folder moves away");
                    std::os::unix::fs::symlink(outside, folder).expect("symlink replaces it");
                }
                let destination = self.destination.join(trashed.len().to_string());
                std::fs::rename(&path, destination).map_err(|_| TrashUnavailable)?;
                trashed.push(path);
                Ok(())
            })
        }
    }

    /// The containment check is repeated right before each move, and the move is given the
    /// checked folder's canonical path: a folder swapped for a symlink to somewhere outside
    /// after the first check cannot route the trash there (#139 slice G).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_folder_swapped_for_an_outside_symlink_mid_discard_is_never_followed() {
        let fixture = tempfile::tempdir().expect("temporary repository");
        let outside = tempfile::tempdir().expect("outside folder");
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        std::fs::write(fixture.path().join("a.txt"), "a\n").expect("first file");
        std::fs::create_dir(fixture.path().join("dir")).expect("folder");
        std::fs::write(fixture.path().join("dir/victim.txt"), "inside\n").expect("inside file");
        std::fs::write(outside.path().join("victim.txt"), "keep\n").expect("outside file");
        let trash = Arc::new(SwappingTrash {
            destination: trash_directory.path().to_path_buf(),
            swap: (fixture.path().join("dir"), outside.path().to_path_buf()),
            trashed: Mutex::new(Vec::new()),
        });

        let outcome = discard_paths(
            &GitRepository::default(),
            trash.clone(),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["a.txt".into(), "dir/victim.txt".into()],
                permit_permanent: true,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");

        assert_eq!(outcome.trashed, ["a.txt"]);
        assert!(outcome.permanently_discarded.is_empty());
        assert_eq!(outcome.trash_unavailable, ["dir/victim.txt"]);
        assert_eq!(trash.trashed.lock().unwrap().len(), 1);
        assert_eq!(
            std::fs::read_to_string(outside.path().join("victim.txt")).unwrap(),
            "keep\n"
        );
    }

    /// Answers that it took every path, and takes none.
    #[cfg(unix)]
    struct LyingTrash;

    #[cfg(unix)]
    impl FileTrash for LyingTrash {
        fn trash<'a>(
            &'a self,
            _path: PathBuf,
            _cancellation: &'a CancellationToken,
        ) -> FileTrashFuture<'a> {
            Box::pin(async { Ok(()) })
        }
    }

    /// A repository with `dir/victim.txt` untracked, and its canonical path.
    #[cfg(unix)]
    fn staging_fixture() -> (tempfile::TempDir, PathBuf) {
        let fixture = tempfile::tempdir().expect("temporary repository");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        std::fs::create_dir(fixture.path().join("dir")).expect("folder");
        std::fs::write(fixture.path().join("dir/victim.txt"), "inside\n").expect("inside file");
        let root = fixture.path().canonicalize().expect("canonical checkout");
        (fixture, root)
    }

    /// The trash resolves the staged path by string. A staging folder swapped, after the rename,
    /// for a link to a place holding an entry of the same staged name is caught before the
    /// trash is called: the staged path must resolve to the very folders and entry BiBCode holds
    /// by handle. The entry goes back and is kept, even under `permanent`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_staging_folder_swapped_before_the_trash_resolves_it_is_never_followed() {
        let (fixture, root) = staging_fixture();
        let outside = tempfile::tempdir().expect("outside folder");
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        let (git_dir, target) = (root.join(".git"), outside.path().to_path_buf());
        discard_hooks::on(
            discard_hooks::Point::Staged,
            root.join("dir/victim.txt"),
            move || {
                let staging = git_dir.join("bibcode-discard");
                let holder = std::fs::read_dir(&staging)
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .file_name();
                std::fs::create_dir(target.join(&holder)).unwrap();
                std::fs::write(target.join(&holder).join("victim.txt"), "keep\n").unwrap();
                std::fs::rename(&staging, git_dir.join("staging-away")).unwrap();
                std::os::unix::fs::symlink(&target, &staging).unwrap();
            },
        );
        let trash = Arc::new(RecordingTrash {
            destination: trash_directory.path().to_path_buf(),
            trashed: Mutex::new(Vec::new()),
        });

        let outcome = discard_paths(
            &GitRepository::default(),
            trash.clone(),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["dir/victim.txt".into()],
                permit_permanent: true,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");

        assert!(
            trash.trashed.lock().unwrap().is_empty(),
            "the trash was never called"
        );
        assert_eq!(outcome.trash_unavailable, ["dir/victim.txt"]);
        assert!(outcome.trashed.is_empty() && outcome.permanently_discarded.is_empty());
        assert_eq!(
            std::fs::read_to_string(root.join("dir/victim.txt")).unwrap(),
            "inside\n",
            "the entry went back"
        );
        let planted = std::fs::read_dir(outside.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(planted.path().join("victim.txt")).unwrap(),
            "keep\n"
        );
    }

    /// A trash that answers success but leaves BiBCode's staged entry where it was took
    /// something else, or nothing: the entry goes back and is kept, never reported trashed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_trash_that_did_not_take_the_staged_entry_is_never_reported_as_trashed() {
        let (fixture, root) = staging_fixture();

        let outcome = discard_paths(
            &GitRepository::default(),
            Arc::new(LyingTrash),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["dir/victim.txt".into()],
                permit_permanent: true,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");

        assert!(outcome.trashed.is_empty(), "{outcome:?}");
        assert_eq!(outcome.trash_unavailable, ["dir/victim.txt"]);
        assert_eq!(
            std::fs::read_to_string(root.join("dir/victim.txt")).unwrap(),
            "inside\n"
        );
        let staging = std::fs::read_dir(root.join(".git/bibcode-discard")).unwrap();
        assert_eq!(staging.count(), 0, "the staging folder is emptied");
    }

    /// Writes a new file where the staged entry came from, then refuses it.
    #[cfg(unix)]
    struct RefusingTrash {
        recreate: PathBuf,
    }

    #[cfg(unix)]
    impl FileTrash for RefusingTrash {
        fn trash<'a>(
            &'a self,
            _path: PathBuf,
            _cancellation: &'a CancellationToken,
        ) -> FileTrashFuture<'a> {
            Box::pin(async move {
                std::fs::write(&self.recreate, "new\n").expect("a new file appears");
                Err(TrashUnavailable)
            })
        }
    }

    /// Git's own metadata is never a discard target, for any caller: `.git` as the first part of
    /// a path (in any case), and any path that resolves into the Git directory, are refused
    /// before anything moves. Staging shares the validator and refuses them too (review
    /// round 4).
    #[tokio::test]
    async fn git_metadata_is_never_a_discard_target() {
        let (fixture, root) = metadata_fixture();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join(".git"), root.join("meta")).expect("link");
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        let trash = Arc::new(RecordingTrash {
            destination: trash_directory.path().to_path_buf(),
            trashed: Mutex::new(Vec::new()),
        });
        let mut refused_paths = vec![
            ".git/objects",
            ".git",
            "./.git/HEAD",
            ".GIT/config",
            ".git/",
        ];
        if cfg!(unix) {
            refused_paths.push("meta/objects");
        }
        for path in refused_paths {
            let refused = discard_paths(
                &GitRepository::default(),
                trash.clone(),
                DiscardRequest {
                    cwd: fixture.path().to_path_buf(),
                    paths: vec!["untracked.txt".into(), path.into()],
                    permit_permanent: true,
                },
                &CancellationToken::new(),
            )
            .await;
            assert!(refused.is_err(), "{path} was accepted");
        }
        assert!(trash.trashed.lock().unwrap().is_empty());
        assert!(root.join(".git/objects").is_dir() && root.join(".git/HEAD").is_file());
        assert!(
            root.join("untracked.txt").exists(),
            "a refused call moves nothing"
        );
        let staged = GitRepository::default()
            .stage_files(
                fixture.path(),
                &[".git/config".to_owned()],
                &CancellationToken::new(),
            )
            .await;
        assert!(staged.is_err(), "staging takes the same validator");

        // A linked worktree's `.git` is a file that points at its Git directory.
        let linked = root.parent().unwrap().join(format!(
            "{}-linked",
            root.file_name().unwrap().to_string_lossy()
        ));
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "--detach",
                linked.to_str().unwrap(),
            ],
        );
        let refused = discard_paths(
            &GitRepository::default(),
            trash.clone(),
            DiscardRequest {
                cwd: linked.clone(),
                paths: vec![".git".into()],
                permit_permanent: true,
            },
            &CancellationToken::new(),
        )
        .await;
        assert!(
            refused.is_err(),
            "a linked worktree's .git file was accepted"
        );
        assert!(linked.join(".git").is_file());
        std::fs::remove_dir_all(&linked).ok();
    }

    /// A repository with one commit and `untracked.txt`, and its canonical path.
    fn metadata_fixture() -> (tempfile::TempDir, PathBuf) {
        let fixture = tempfile::tempdir().expect("temporary repository");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        std::fs::write(fixture.path().join("untracked.txt"), "untracked\n").expect("untracked");
        let root = fixture.path().canonicalize().expect("canonical checkout");
        (fixture, root)
    }

    /// A staging folder BiBCode does not keep private (another owner, or writable by group or
    /// others) is never used: such a user could rename the holder after the identity check. The
    /// entry stays where it was, the trash is never called, and `permanent` still works
    /// through Git.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_staging_folder_others_can_write_is_never_used() {
        use std::os::unix::fs::PermissionsExt;

        let (fixture, root) = staging_fixture();
        let staging = root.join(".git/bibcode-discard");
        std::fs::create_dir(&staging).unwrap();
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o777)).unwrap();
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        let trash = Arc::new(RecordingTrash {
            destination: trash_directory.path().to_path_buf(),
            trashed: Mutex::new(Vec::new()),
        });

        let outcome = discard_paths(
            &GitRepository::default(),
            trash.clone(),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["dir/victim.txt".into()],
                permit_permanent: false,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");

        assert_eq!(outcome.trash_unavailable, ["dir/victim.txt"]);
        assert!(trash.trashed.lock().unwrap().is_empty());
        assert!(root.join("dir/victim.txt").exists());
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
    }

    /// The ownership rule itself, for an owner a test cannot create.
    #[cfg(unix)]
    #[test]
    fn only_a_staging_folder_of_ours_without_group_or_other_write_is_private() {
        assert!(discard_staging::is_private(501, 0o40700, 501));
        assert!(discard_staging::is_private(501, 0o40755, 501));
        assert!(
            !discard_staging::is_private(0, 0o40700, 501),
            "another owner"
        );
        assert!(
            !discard_staging::is_private(501, 0o40770, 501),
            "group write"
        );
        assert!(
            !discard_staging::is_private(501, 0o40702, 501),
            "other write"
        );
    }

    /// Never answers.
    #[cfg(unix)]
    struct StuckTrash {
        called: Arc<std::sync::atomic::AtomicBool>,
    }

    #[cfg(unix)]
    impl FileTrash for StuckTrash {
        fn trash<'a>(
            &'a self,
            _path: PathBuf,
            _cancellation: &'a CancellationToken,
        ) -> FileTrashFuture<'a> {
            self.called.store(true, std::sync::atomic::Ordering::SeqCst);
            Box::pin(std::future::pending())
        }
    }

    /// Stops a discard while its entry waits for the trash, as a crash would, and returns once
    /// the entry is staged.
    #[cfg(unix)]
    async fn strand(fixture: &tempfile::TempDir, path: &str) {
        let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let trash = Arc::new(StuckTrash {
            called: called.clone(),
        });
        let (cwd, path) = (fixture.path().to_path_buf(), path.to_owned());
        let discard = tokio::spawn(async move {
            discard_paths(
                &GitRepository::default(),
                trash,
                DiscardRequest {
                    cwd,
                    paths: vec![path],
                    permit_permanent: false,
                },
                &CancellationToken::new(),
            )
            .await
        });
        while !called.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        discard.abort();
        assert!(discard.await.is_err(), "the discard was stopped");
    }

    /// A holder another server process is still using (it holds the holder folder's lock while
    /// its entry waits for the trash) is never recovered; once that lock is released, as it is
    /// when the process dies, the entry is restored. Another open of the folder stands in for
    /// the other process: `flock` locks belong to each open file, not to the process.
    #[cfg(unix)]
    #[tokio::test]
    async fn recovery_leaves_a_holder_another_process_still_holds() {
        use std::os::fd::AsRawFd;

        let (fixture, root) = staging_fixture();
        strand(&fixture, "dir/victim.txt").await;
        let staging = root.join(".git/bibcode-discard");
        let holder = std::fs::read_dir(&staging)
            .unwrap()
            .flatten()
            .find(|entry| entry.path().is_dir())
            .expect("a holder")
            .path();
        let other_process = std::fs::File::open(&holder).unwrap();
        // SAFETY: the descriptor is open for the duration of the call.
        let locked =
            unsafe { libc::flock(other_process.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_eq!(locked, 0, "the other process takes the holder's lock");
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        let discard_other = || async {
            std::fs::write(root.join("other.txt"), "other\n").unwrap();
            discard_paths(
                &GitRepository::default(),
                Arc::new(RecordingTrash {
                    destination: trash_directory.path().to_path_buf(),
                    trashed: Mutex::new(Vec::new()),
                }),
                DiscardRequest {
                    cwd: fixture.path().to_path_buf(),
                    paths: vec!["other.txt".into()],
                    permit_permanent: false,
                },
                &CancellationToken::new(),
            )
            .await
            .expect("the discard runs");
        };

        discard_other().await;
        assert!(
            !root.join("dir/victim.txt").exists(),
            "a held holder is left alone"
        );
        assert!(holder.join("victim.txt").exists());

        drop(other_process);
        discard_other().await;
        assert_eq!(
            std::fs::read_to_string(root.join("dir/victim.txt")).unwrap(),
            "inside\n",
            "an abandoned holder is restored"
        );
    }

    /// A record BiBCode did not write cannot move a staged entry anywhere but its place in this
    /// checkout: a record naming another root, a `..`, an absolute path, Git's metadata, or a
    /// path through a symlinked folder is ignored, and its entry stays staged.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_forged_origin_record_never_moves_an_entry() {
        use std::os::unix::fs::PermissionsExt;

        let (fixture, root) = staging_fixture();
        let outside = tempfile::tempdir().expect("outside folder");
        let outside_path = outside.path().canonicalize().unwrap();
        std::os::unix::fs::symlink(&outside_path, root.join("link")).expect("link");
        let staging = root.join(".git/bibcode-discard");
        std::fs::create_dir(&staging).unwrap();
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut root_elsewhere = outside_path.as_os_str().as_encoded_bytes().to_vec();
        root_elsewhere.extend_from_slice(b"\0x.txt");
        let records: Vec<Vec<u8>> = vec![
            root_elsewhere,
            b"../outside/x.txt".to_vec(),
            format!("{}/x.txt", outside_path.display()).into_bytes(),
            b"link/x.txt".to_vec(),
            b".git/x.txt".to_vec(),
            b"./x.txt".to_vec(),
        ];
        let mut holders = Vec::new();
        for (index, record) in records.iter().enumerate() {
            let holder = format!("forged-{index}");
            std::fs::create_dir(staging.join(&holder)).unwrap();
            std::fs::write(staging.join(&holder).join("x.txt"), "staged\n").unwrap();
            std::fs::write(staging.join(format!("{holder}.origin")), record).unwrap();
            holders.push(holder);
        }
        std::fs::write(root.join("other.txt"), "other\n").unwrap();
        let trash_directory = tempfile::tempdir().expect("temporary trash");

        discard_paths(
            &GitRepository::default(),
            Arc::new(RecordingTrash {
                destination: trash_directory.path().to_path_buf(),
                trashed: Mutex::new(Vec::new()),
            }),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["other.txt".into()],
                permit_permanent: false,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");

        for holder in &holders {
            assert!(
                staging.join(holder).join("x.txt").exists(),
                "{holder}'s entry was moved"
            );
        }
        assert_eq!(std::fs::read_dir(&outside_path).unwrap().count(), 0);
        assert!(!root.join("x.txt").exists() && !root.join(".git/x.txt").exists());
    }

    /// An entry a crash left in the staging folder is moved back to where it came from by the
    /// next discard in that repository; one whose place is taken again stays staged.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_discard_restores_entries_a_crash_left_in_staging() {
        let (fixture, root) = staging_fixture();
        strand(&fixture, "dir/victim.txt").await;
        assert!(
            !root.join("dir/victim.txt").exists(),
            "the entry is stranded"
        );
        std::fs::write(root.join("other.txt"), "other\n").unwrap();
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        let trash = Arc::new(RecordingTrash {
            destination: trash_directory.path().to_path_buf(),
            trashed: Mutex::new(Vec::new()),
        });
        let discard = |path: &str| DiscardRequest {
            cwd: fixture.path().to_path_buf(),
            paths: vec![path.into()],
            permit_permanent: false,
        };

        let outcome = discard_paths(
            &GitRepository::default(),
            trash.clone(),
            discard("other.txt"),
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");

        assert_eq!(outcome.trashed, ["other.txt"]);
        assert_eq!(
            std::fs::read_to_string(root.join("dir/victim.txt")).unwrap(),
            "inside\n",
            "the stranded entry went back"
        );
        assert_eq!(
            std::fs::read_dir(root.join(".git/bibcode-discard"))
                .unwrap()
                .count(),
            0,
            "its holder and record are gone"
        );

        // Stranded again, and its place taken meanwhile: it stays staged.
        strand(&fixture, "dir/victim.txt").await;
        std::fs::write(root.join("dir/victim.txt"), "new\n").unwrap();
        std::fs::write(root.join("other.txt"), "other\n").unwrap();
        discard_paths(
            &GitRepository::default(),
            trash,
            discard("other.txt"),
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");
        assert_eq!(
            std::fs::read_to_string(root.join("dir/victim.txt")).unwrap(),
            "new\n"
        );
        assert_ne!(
            std::fs::read_dir(root.join(".git/bibcode-discard"))
                .unwrap()
                .count(),
            0,
            "the stranded entry is kept, not dropped"
        );
    }

    /// An entry the trash refuses goes back where it was, but never over a file created there
    /// while it was staged: that file is kept and the entry stays staged, reported as kept, not
    /// as permanently discarded.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_entry_never_goes_back_over_a_file_created_meanwhile() {
        let fixture = tempfile::tempdir().expect("temporary repository");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        std::fs::write(fixture.path().join("untracked.txt"), "old\n").expect("untracked file");

        let outcome = discard_paths(
            &GitRepository::default(),
            Arc::new(RefusingTrash {
                recreate: fixture.path().join("untracked.txt"),
            }),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["untracked.txt".into()],
                permit_permanent: true,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");

        assert_eq!(outcome.trash_unavailable, ["untracked.txt"]);
        assert!(outcome.permanently_discarded.is_empty());
        assert_eq!(
            std::fs::read_to_string(fixture.path().join("untracked.txt")).unwrap(),
            "new\n"
        );
    }

    /// A folder swapped for a symlink to somewhere outside inside the move window itself, after
    /// every check, is never followed: the entry is moved from the folder that was checked, by
    /// handle, into BiBCode's own staging folder in the Git directory, and only that staged path
    /// reaches the trash (#139 slice G, review round 3).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_folder_swapped_for_an_outside_symlink_inside_the_move_window_is_never_followed() {
        let fixture = tempfile::tempdir().expect("temporary repository");
        let outside = tempfile::tempdir().expect("outside folder");
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        std::fs::create_dir(fixture.path().join("dir")).expect("folder");
        std::fs::write(fixture.path().join("dir/victim.txt"), "inside\n").expect("inside file");
        std::fs::write(outside.path().join("victim.txt"), "keep\n").expect("outside file");
        let root = fixture.path().canonicalize().expect("canonical checkout");
        let (folder, away, target) = (
            root.join("dir"),
            root.join("dir-away"),
            outside.path().to_path_buf(),
        );
        discard_hooks::on(
            discard_hooks::Point::BeforeMove,
            root.join("dir/victim.txt"),
            move || {
                std::fs::rename(&folder, away).expect("folder moves away");
                std::os::unix::fs::symlink(target, &folder).expect("symlink replaces it");
            },
        );
        let trash = Arc::new(RecordingTrash {
            destination: trash_directory.path().to_path_buf(),
            trashed: Mutex::new(Vec::new()),
        });

        let outcome = discard_paths(
            &GitRepository::default(),
            trash.clone(),
            DiscardRequest {
                cwd: fixture.path().to_path_buf(),
                paths: vec!["dir/victim.txt".into()],
                permit_permanent: true,
            },
            &CancellationToken::new(),
        )
        .await
        .expect("the discard runs");

        assert_eq!(
            std::fs::read_to_string(outside.path().join("victim.txt")).unwrap(),
            "keep\n",
            "the outside file was never touched"
        );
        assert_eq!(outcome.trashed, ["dir/victim.txt"]);
        assert_eq!(
            std::fs::read_to_string(trash_directory.path().join("victim.txt")).unwrap(),
            "inside\n",
            "the trash took the file from the folder that was checked"
        );
        let trashed = trash.trashed.lock().unwrap();
        assert!(
            trashed[0].starts_with(root.join(".git/bibcode-discard")),
            "the trash got BiBCode's staged path, not one that resolves through the checkout: {trashed:?}"
        );
        let staging = std::fs::read_dir(root.join(".git/bibcode-discard")).unwrap();
        assert_eq!(staging.count(), 0, "the staging folder is emptied");
    }

    /// A symlinked folder inside the checkout that points elsewhere cannot route a discard
    /// outside it (#139 slice G, C5): nothing is trashed or restored, for any path.
    #[cfg(unix)]
    #[tokio::test]
    async fn discard_refuses_a_path_whose_folder_leaves_the_checkout() {
        let fixture = tempfile::tempdir().expect("temporary repository");
        let outside = tempfile::tempdir().expect("outside folder");
        let trash_directory = tempfile::tempdir().expect("temporary trash");
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(fixture.path().join("tracked.txt"), "base\n").expect("base file");
        git(fixture.path(), &["add", "tracked.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        std::fs::write(fixture.path().join("tracked.txt"), "changed\n").expect("change");
        std::fs::write(outside.path().join("victim.txt"), "keep\n").expect("outside file");
        std::os::unix::fs::symlink(outside.path(), fixture.path().join("link")).expect("link");
        let trash = Arc::new(RecordingTrash {
            destination: trash_directory.path().to_path_buf(),
            trashed: Mutex::new(Vec::new()),
        });
        for paths in [
            vec!["link/victim.txt".to_owned()],
            vec!["tracked.txt".to_owned(), "link/victim.txt".to_owned()],
            vec!["link/missing/deeper.txt".to_owned()],
        ] {
            let refused = discard_paths(
                &GitRepository::default(),
                trash.clone(),
                DiscardRequest {
                    cwd: fixture.path().to_path_buf(),
                    paths: paths.clone(),
                    permit_permanent: true,
                },
                &CancellationToken::new(),
            )
            .await;
            assert!(refused.is_err(), "{paths:?} was discarded");
        }
        assert!(trash.trashed.lock().unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(outside.path().join("victim.txt")).unwrap(),
            "keep\n"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.path().join("tracked.txt")).unwrap(),
            "changed\n",
            "a refused call restores nothing"
        );
    }

    #[test]
    fn branch_names_can_never_be_options_or_refspecs() {
        for name in [
            "feature",
            "feature/x-1",
            "refs/heads/main",
            "release/v1.2",
            "a@b",
        ] {
            assert!(is_branch_name(name), "{name}");
        }
        for name in [
            "",
            "-x",
            "--receive-pack=evil",
            "a:b",
            "+main",
            "a b",
            "a\tb",
            "a..b",
            "a@{1}",
            "@",
            "/a",
            "a/",
            "a.",
            "a//b",
            "a/.b",
            "a.lock",
            "a/b.lock/c",
            "a~1",
            "a^",
            "a?",
            "a*",
            "a[",
            "a\\b",
            "a\u{7f}",
        ] {
            assert!(!is_branch_name(name), "{name:?}");
        }
    }

    /// `remote-branch-delete` deletes only the remote branch (#139 slice G), and refuses a
    /// remote the checkout does not have or a branch name that is not one.
    #[tokio::test]
    async fn remote_branch_delete_removes_only_the_remote_branch() {
        let remote = tempfile::tempdir().expect("bare remote");
        let fixture = tempfile::tempdir().expect("clone");
        git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        git(fixture.path(), &["init", "-q", "-b", "main"]);
        git(
            fixture.path(),
            &["remote", "add", "origin", &remote.path().to_string_lossy()],
        );
        std::fs::write(fixture.path().join("a.txt"), "a\n").expect("file");
        git(fixture.path(), &["add", "a.txt"]);
        git(fixture.path(), &["commit", "-q", "-m", "base"]);
        git(fixture.path(), &["branch", "feature"]);
        git(fixture.path(), &["push", "-q", "origin", "main", "feature"]);
        let request: GitManagerOperationRequest = serde_json::from_value(serde_json::json!({
            "_tag": "remote-branch-delete", "cwd": fixture.path(), "projectId": "p",
            "remote": "origin", "branch": "feature",
        }))
        .expect("the request decodes");
        assert_eq!(request.operation(), "remote-branch-delete");
        assert!(request.is_implemented_through_phase_16());
        let mut snapshot = operation_snapshot(fixture.path());
        snapshot.remotes = vec!["origin".into()];
        let repository = GitRepository::default();
        let token = CancellationToken::new();
        for (remote_name, branch) in [("upstream", "feature"), ("origin", "-x"), ("origin", "a:b")]
        {
            let refused = execute_branch_or_sync_operation(
                &repository,
                &snapshot,
                &GitManagerOperationRequest::RemoteBranchDelete {
                    cwd: fixture.path().to_path_buf(),
                    project_id: "p".into(),
                    remote: remote_name.into(),
                    branch: branch.into(),
                },
                &token,
            )
            .await
            .expect_err("refused");
            assert_eq!(refused.code, "invalid-request", "{remote_name} {branch}");
        }
        execute_branch_or_sync_operation(&repository, &snapshot, &request, &token)
            .await
            .expect("the remote branch is deleted");
        assert_eq!(
            git(remote.path(), &["branch", "--format=%(refname:short)"]),
            "main"
        );
        assert_eq!(
            git(fixture.path(), &["branch", "--format=%(refname:short)"]),
            "feature\nmain",
            "the local branch stays"
        );
    }
}
