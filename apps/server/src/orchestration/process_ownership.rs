//! Whether work a provider session left open can still be running after BiBCode restarted
//! (#187, #206). One rule decides both what startup expires (open approvals and questions)
//! and what it closes (open subagents and background tasks), so a thread never shows its
//! subagents interrupted beside requests still waiting on the same, dead, process.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::engine::EXTERNALLY_RESUMABLE_PROVIDERS;

/// Who ran a session's provider server, in its persisted runtime payload.
pub(crate) const PROCESS_OWNER_PAYLOAD_KEY: &str = "processOwner";
pub(crate) const PROCESS_OWNER_BIBCODE: &str = "bibcode";
pub(crate) const PROCESS_OWNER_EXTERNAL: &str = "external";

/// One persisted runtime row, as a server start reads it.
pub type StartupRuntimeRow<'a> = (&'a str, Option<&'a str>, Option<&'a Value>);

#[derive(Clone, Debug, Default)]
struct RecordedRuntime {
    owner: Option<String>,
    provider_instance_id: Option<String>,
}

/// What a server start knows about who ran each thread's provider process: the persisted
/// runtime rows (thread, provider instance, payload), read before abandoned sessions are
/// settled, and which provider instances the settings point at a server the user runs.
#[derive(Clone, Debug, Default)]
pub struct StartupProcessOwnership {
    runtimes: HashMap<String, RecordedRuntime>,
    external_server_instances: HashSet<String>,
}

impl StartupProcessOwnership {
    #[must_use]
    pub fn new<'a>(
        runtimes: impl IntoIterator<Item = StartupRuntimeRow<'a>>,
        external_server_instances: impl IntoIterator<Item = String>,
    ) -> Self {
        let runtimes = runtimes
            .into_iter()
            .map(|(thread_id, provider_instance_id, payload)| {
                let owner = payload
                    .and_then(|payload| payload.get(PROCESS_OWNER_PAYLOAD_KEY))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                (
                    thread_id.to_owned(),
                    RecordedRuntime {
                        owner,
                        provider_instance_id: provider_instance_id.map(str::to_owned),
                    },
                )
            })
            .collect();
        Self {
            runtimes,
            external_server_instances: external_server_instances.into_iter().collect(),
        }
    }

    /// Whether the thread's provider may still be running its work. Only a provider that can
    /// attach to a server the user runs (OpenCode) can be. Its persisted owner decides. A row
    /// written before the owner was recorded, or no row at all, follows the current settings of
    /// the thread's own provider instance (from its row, else `provider_instance_id`): a server
    /// URL means the user's server ran it, none means BiBCode's own child did. With no known
    /// instance, any configured server URL keeps the work.
    #[must_use]
    pub fn work_may_outlive_bibcode(
        &self,
        thread_id: &str,
        provider: &str,
        provider_instance_id: Option<&str>,
    ) -> bool {
        if !EXTERNALLY_RESUMABLE_PROVIDERS.contains(&provider) {
            return false;
        }
        let recorded = self.runtimes.get(thread_id);
        match recorded.and_then(|runtime| runtime.owner.as_deref()) {
            Some(PROCESS_OWNER_BIBCODE) => false,
            Some(PROCESS_OWNER_EXTERNAL) => true,
            _ => recorded
                .and_then(|runtime| runtime.provider_instance_id.as_deref())
                .or(provider_instance_id)
                .map_or(!self.external_server_instances.is_empty(), |instance| {
                    self.external_server_instances.contains(instance)
                }),
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
            ("owned", Some("opencode"), Some(&owned)),
            ("external", Some("opencode"), Some(&external)),
            ("legacy", Some("opencode"), Some(&legacy)),
            ("no-payload", Some("opencode"), None),
        ];
        for configured in [false, true] {
            let instances = configured.then(|| "opencode".to_owned());
            let ownership = StartupProcessOwnership::new(rows, instances);
            assert!(!ownership.work_may_outlive_bibcode("owned", "opencode", None));
            assert!(ownership.work_may_outlive_bibcode("external", "opencode", None));
            assert_eq!(
                ownership.work_may_outlive_bibcode("legacy", "opencode", None),
                configured
            );
            assert_eq!(
                ownership.work_may_outlive_bibcode("no-payload", "opencode", None),
                configured
            );
            assert_eq!(
                ownership.work_may_outlive_bibcode("no-row", "opencode", Some("opencode")),
                configured
            );
            // Claude and Codex always run their own child.
            assert!(!ownership.work_may_outlive_bibcode("external", "claudeAgent", None));
            assert!(!ownership.work_may_outlive_bibcode("legacy", "codex", None));
        }
    }

    #[test]
    fn a_legacy_row_follows_its_own_instance_beside_a_remote_one() {
        let legacy = json!({ "transport": "http" });
        let ownership = StartupProcessOwnership::new(
            [
                ("local-thread", Some("local-opencode"), Some(&legacy)),
                ("remote-thread", Some("remote-opencode"), Some(&legacy)),
            ],
            ["remote-opencode".to_owned()],
        );
        assert!(!ownership.work_may_outlive_bibcode("local-thread", "opencode", None));
        assert!(ownership.work_may_outlive_bibcode("remote-thread", "opencode", None));
        // Without a row, the caller's instance decides; with no instance known, any remote one.
        assert!(!ownership.work_may_outlive_bibcode("rowless", "opencode", Some("local-opencode")));
        assert!(ownership.work_may_outlive_bibcode("rowless", "opencode", None));
    }
}
