mod broadcaster;
mod model;
mod parser;
mod process;
mod repository;
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
pub(crate) use repository::{BoxGitProcessFuture, GitProcessRunner};
pub use repository::{
    BoxWorktreeBaseDirectoryFuture, GitRepository, WorktreeBaseDirectoryProvider,
};
pub(crate) use worktree::uses_foreign_posix_identity;
pub use worktree::{
    HostPathPlatform, WorktreeIdentityError, WorktreeKey, WorktreeParseError,
    WorktreeRepositoryKey, canonical_worktree_path_key, git_worktree_prune_impact_digest,
    host_path_platform, normalize_worktree_path_key, parse_worktree_porcelain,
    resolved_worktree_keys, worktree_key, worktree_repository_key,
};
