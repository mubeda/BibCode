mod availability;
pub(crate) mod fingerprint;
mod model;
mod service;

pub use availability::*;
pub use model::*;
#[cfg(test)]
pub(crate) use service::CatalogServiceOptions;
pub(crate) use service::{
    CatalogFuture, CatalogHealthySnapshotObserver, CatalogWorkspaceLossObserver,
    ProjectMutationAttempt,
};
pub use service::{CatalogSubscription, WorktreeCatalogService};

#[cfg(test)]
mod tests;
