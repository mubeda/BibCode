mod broadcaster;
mod fetch_owner;
pub mod manager;
mod model;
mod parser;
mod process;
mod repository;
mod status_owner;
mod summary;
mod watcher;
mod worktree;

#[allow(unused_imports)]
pub use broadcaster::{StatusBroadcaster, StatusSubscription};
pub use manager::graph::{
    COMMIT_PAGE_SIZE, GitManagerCommitEntry, GitManagerCommitPage, GitManagerGraphError,
    MAX_DIFF_BUFFER_SIZE, MAX_DIFF_LINE_CHARACTERS, MAX_PINNED_TIPS, MAX_REASONABLE_DIFF_SIZE,
};
pub use manager::operations::{
    CoAuthor, CommitRequest, DiscardError, DiscardOutcome, DiscardRequest, FileTrash,
    FileTrashFuture, NativeFileTrash, TrashUnavailable, UndoCommitDraft,
};
pub use manager::refs::{
    GitManagerBlockedReason, GitManagerInProgressKind, GitManagerInProgressOperation,
    GitManagerRefEntry, GitManagerRefsError, GitManagerRefsSnapshot, GitManagerWorktreeEntry,
};
pub use model::*;
#[allow(unused_imports)]
pub use parser::{
    PorcelainRecord, parse_numstat, parse_porcelain_v2_line, resolve_numstat_new_path,
};
pub use process::{OutputPolicy, ProcessError, ProcessOutput, ProcessRequest, ProcessRunner};
#[cfg(test)]
pub(crate) use repository::BoxGitProcessFuture;
pub(crate) use repository::GitProcessRunner;
pub(crate) use repository::git_environment;
pub use repository::{
    BoxWorktreeBaseDirectoryFuture, GitManagerCommitOutcome, GitManagerHeadCommit, GitRepository,
    WorktreeBaseDirectoryProvider,
};
pub(crate) use repository::{NETWORK_TRANSFER_STALLED, reports_stalled_transfer};
#[allow(unused_imports)]
pub(crate) use repository::{StatusObservation, validate_pathspecs};
pub use status_owner::StatusMutationGuard;
pub(crate) use status_owner::{STATUS_SAFETY_INTERVAL, StatusReadFence};
pub use summary::GitStatusSummaryService;
#[cfg(test)]
pub(crate) use watcher::acquire_native_watcher_test_permit;
#[allow(unused_imports)]
pub(crate) use watcher::{
    GitWatchError, GitWatchEvent, GitWatchRequest, GitWatchService, GitWatchSubscription,
    GitWatcherHealth,
};
pub(crate) use worktree::uses_foreign_posix_identity;
pub use worktree::{
    HostPathPlatform, WorktreeIdentityError, WorktreeKey, WorktreeParseError,
    WorktreeRepositoryKey, canonical_worktree_path_key, git_worktree_prune_impact_digest,
    host_path_platform, normalize_worktree_path_key, parse_worktree_porcelain,
    resolved_worktree_keys, worktree_key, worktree_repository_key,
};

/// Safety bound for server-owned checkout writes, independent of RPC/read deadlines.
/// A started write must retain its lock and owner throughout this window.
pub(crate) const CHECKOUT_WRITE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);

/// Safety bound for network transfers the user can cancel: clone and the Git Manager's
/// fetch, pull, push, remote-branch delete and tag push. A slow transfer that keeps moving
/// may take hours; Git's HTTP low-speed guard stops a stalled one, and Cancel stops any of
/// them. This bound only ends a runaway process.
pub(crate) const NETWORK_TRANSFER_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);

/// Bound for network transfers no user can cancel: the background automatic fetch and the
/// pull, stacked-action push and publish push, which have no Cancel. SSH has no stall
/// detection, so a dead link must not hold them for hours; a timed-out automatic fetch backs
/// off and retries on a later interval.
pub(crate) const BOUNDED_TRANSFER_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(10 * 60);
