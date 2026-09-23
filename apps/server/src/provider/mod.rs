pub(crate) mod acp_mode;
pub(crate) mod attachments;
pub mod claude;
pub mod codex;
pub mod cursor;
pub(crate) mod environment;
pub mod grok;
pub mod opencode;

/// Driver-owned capability used by both inventory and durable steer admission.
pub(crate) fn supports_turn_steer(provider: &str) -> bool {
    matches!(provider, "codex" | "claudeAgent")
}
