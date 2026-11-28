//! Antigravity status-bar quota polling (`agy -p "/usage"`) has been removed (#429).
//!
//! Quota limits and reset times are surfaced in chat directly from the running `agy acp` session
//! (`provider::antigravity::runtime`). No `agy` CLI process is ever spawned for provider usage
//! refreshes, even when an older client explicitly requests `providers: ["antigravity"]`.

pub(super) const MESSAGE_UNAVAILABLE: &str =
    "Antigravity usage is reported in chat when a quota limit is reached.";
