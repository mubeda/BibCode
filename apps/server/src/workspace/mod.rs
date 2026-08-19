mod entries;
mod error;
pub(crate) mod paths;
mod rpc;
mod search;
mod service;
mod watcher;

#[allow(unused_imports)]
pub use entries::{BrowseEntry, BrowseResult};
pub use error::WorkspaceError;
pub use rpc::{
    AssetContextResolver, EntryChangeSubscription, TASK_SIX_RPC_METHODS, WorkspaceMutationFuture,
    WorkspaceMutationObserver, WorkspaceRpc, WorkspaceRpcDependencies,
};
#[allow(unused_imports)]
pub use search::{EntryKind, SearchLimits, SearchResult, WorkspaceEntry, WorkspaceSearchIndex};
#[allow(unused_imports)]
pub use service::{ReadFileResult, WorkspaceService};
#[allow(unused_imports)]
pub use watcher::{
    WatchEvent, WatchScope, WatchScopeFuture, WatchSubscription, WorkspaceWatcher, directory_stamps,
};
