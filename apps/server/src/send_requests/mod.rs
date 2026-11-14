pub(crate) mod rpc;
pub(crate) mod service;
#[allow(dead_code)]
// The follower (1.3) and the cancel, dismiss and subscribe methods (1.6) use the rest.
pub(crate) mod store;

#[cfg(test)]
mod tests;
