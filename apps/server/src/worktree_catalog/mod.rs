mod model;
mod service;

pub use model::*;
pub(crate) use service::{CatalogFuture, CatalogHealthySnapshotObserver};
pub use service::{CatalogSubscription, WorktreeCatalogService};

#[cfg(test)]
mod tests;
