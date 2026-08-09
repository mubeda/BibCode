mod model;
mod service;

pub use model::*;
pub use service::{CatalogSubscription, WorktreeCatalogService};

#[cfg(test)]
mod tests;
