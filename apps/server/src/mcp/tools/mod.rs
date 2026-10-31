//! The outside-agent tool families (#139, C1). Each family exports `FAMILY`: its specs, the
//! description and input schema of each client tool, and its dispatch. `control::FAMILIES`
//! registers it.

pub(crate) mod clone;
pub(crate) mod diagnostics;
pub(crate) mod feed;
pub(crate) mod files;
pub(crate) mod git;
pub(crate) mod panels;
pub(crate) mod previews;
pub(crate) mod pull_requests;
pub(crate) mod terminals;
pub(crate) mod threads;
pub(crate) mod worktrees;
