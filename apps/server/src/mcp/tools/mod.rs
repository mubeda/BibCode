//! The outside-agent tool families (#139, C1). Each family exports `FAMILY`: its specs, the
//! description and input schema of each client tool, and its dispatch. `control::FAMILIES`
//! registers it.

pub(crate) mod previews;
pub(crate) mod threads;
