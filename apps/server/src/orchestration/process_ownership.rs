//! Whether work a provider session left open can still be running after BiBCode restarted
//! (#187, #206). One rule decides both what startup expires (open approvals and questions)
//! and what it closes (open subagents and background tasks), so a thread never shows its
//! subagents interrupted beside requests still waiting on the same, dead, process.

use std::collections::HashMap;

use serde_json::Value;

use super::engine::EXTERNALLY_RESUMABLE_PROVIDERS;

/// Who ran a session's provider server, in its persisted runtime payload.
pub(crate) const PROCESS_OWNER_PAYLOAD_KEY: &str = "processOwner";
pub(crate) const PROCESS_OWNER_BIBCODE: &str = "bibcode";
pub(crate) const PROCESS_OWNER_EXTERNAL: &str = "external";

/// What a server start knows about who ran each thread's provider process: the persisted
/// runtime rows, read before abandoned sessions are settled, and whether the settings point
/// OpenCode at a server the user runs.
#[derive(Clone, Debug, Default)]
pub struct StartupProcessOwnership {
    owners: HashMap<String, Option<String>>,
    external_server_configured: bool,
}

impl StartupProcessOwnership {
    #[must_use]
    pub fn new<'a>(
        runtimes: impl IntoIterator<Item = (&'a str, Option<&'a Value>)>,
        external_server_configured: bool,
    ) -> Self {
        let owners = runtimes
            .into_iter()
            .map(|(thread_id, payload)| {
                let owner = payload
                    .and_then(|payload| payload.get(PROCESS_OWNER_PAYLOAD_KEY))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                (thread_id.to_owned(), owner)
            })
            .collect();
        Self {
            owners,
            external_server_configured,
        }
    }

    /// Whether the thread's provider may still be running its work. Only a provider that can
    /// attach to a server the user runs (OpenCode) can be. Its persisted owner decides; a row
    /// written before the owner was recorded, or no row at all, follows the current settings: a
    /// configured server URL means the user's server ran it, none means BiBCode's own child did.
    #[must_use]
    pub fn work_may_outlive_bibcode(&self, thread_id: &str, provider: &str) -> bool {
        if !EXTERNALLY_RESUMABLE_PROVIDERS.contains(&provider) {
            return false;
        }
        match self.owners.get(thread_id).and_then(Option::as_deref) {
            Some(PROCESS_OWNER_BIBCODE) => false,
            Some(PROCESS_OWNER_EXTERNAL) => true,
            _ => self.external_server_configured,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_persisted_owner_decides_and_a_legacy_row_follows_the_settings() {
        let owned = json!({ "processOwner": "bibcode" });
        let external = json!({ "processOwner": "external" });
        let legacy = json!({ "transport": "http" });
        let rows = [
            ("owned", Some(&owned)),
            ("external", Some(&external)),
            ("legacy", Some(&legacy)),
            ("no-payload", None),
        ];
        for configured in [false, true] {
            let ownership = StartupProcessOwnership::new(rows, configured);
            assert!(!ownership.work_may_outlive_bibcode("owned", "opencode"));
            assert!(ownership.work_may_outlive_bibcode("external", "opencode"));
            assert_eq!(
                ownership.work_may_outlive_bibcode("legacy", "opencode"),
                configured
            );
            assert_eq!(
                ownership.work_may_outlive_bibcode("no-payload", "opencode"),
                configured
            );
            assert_eq!(
                ownership.work_may_outlive_bibcode("no-row", "opencode"),
                configured
            );
            // Claude and Codex always run their own child.
            assert!(!ownership.work_may_outlive_bibcode("external", "claudeAgent"));
            assert!(!ownership.work_may_outlive_bibcode("legacy", "codex"));
        }
    }
}
