mod availability;
mod model;
mod service;

pub use availability::*;
pub use model::*;
pub(crate) use service::{
    CatalogFuture, CatalogHealthySnapshotObserver, CatalogWorkspaceLossObserver,
};
pub use service::{CatalogSubscription, WorktreeCatalogService};

#[cfg(test)]
mod tests;
