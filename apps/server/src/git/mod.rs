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
pub use model::*;
#[allow(unused_imports)]
pub use parser::{
    PorcelainRecord, parse_numstat, parse_porcelain_v2_line, resolve_numstat_new_path,
};
pub use process::{OutputPolicy, ProcessError, ProcessOutput, ProcessRequest, ProcessRunner};
#[cfg(test)]
pub(crate) use repository::BoxGitProcessFuture;
pub(crate) use repository::GitProcessRunner;
pub use repository::{
    BoxWorktreeBaseDirectoryFuture, GitRepository, WorktreeBaseDirectoryProvider,
};
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
