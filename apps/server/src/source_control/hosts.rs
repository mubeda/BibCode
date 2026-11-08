//! Hosts that explicit provider probes identified, so status reads can classify a
//! self-hosted origin without spawning a provider CLI.

use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use super::{
    ProviderInfo, ProviderKind, SourceControlDiscoveryResult, host_serves_remote, provider,
    provider_from_remote, remote_web_host, serving_host,
};

const CAPACITY: usize = 64;

/// How a remote's provider was identified.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IdentifiedProvider {
    /// The host name alone identifies the provider (`github.com`, a `gitlab` host, …).
    Named(ProviderInfo),
    /// An explicit probe recorded this host.
    Recorded(ProviderInfo),
    /// Neither: only the provider CLIs' configured hosts can tell.
    Unknown,
}

impl IdentifiedProvider {
    #[must_use]
    pub fn kind(&self) -> ProviderKind {
        match self {
            Self::Named(info) | Self::Recorded(info) => info.kind,
            Self::Unknown => ProviderKind::Unknown,
        }
    }
}

/// Lower-cased host names mapped to the provider an explicit probe identified.
///
/// Only explicit probes write here: Pull Requests scope resolution records an
/// authenticated discovered host and forgets it on Rescan, `unknown_host` or
/// `not_authenticated`; an explicit Settings discovery replaces each provider's
/// hosts with the authenticated hosts its CLI listed. Status reads, summaries,
/// background discovery reads and timers only read. The map lives in memory for
/// the server's lifetime and keeps at most [`CAPACITY`] hosts, dropping the oldest.
#[derive(Debug, Default)]
pub struct ProviderHosts {
    hosts: RwLock<Vec<(String, ProviderKind)>>,
}

impl ProviderHosts {
    /// The provider recorded for `host`, if an explicit probe identified it.
    #[must_use]
    pub fn provider(&self, host: &str) -> Option<ProviderKind> {
        let host = host.trim().to_ascii_lowercase();
        self.read()
            .iter()
            .find(|(known, _)| *known == host)
            .map(|(_, provider)| *provider)
    }

    /// Records a GitHub or GitLab host; other kinds are classified by name alone.
    pub fn record(&self, host: &str, provider: ProviderKind) {
        record_into(&mut self.write(), host, provider);
    }

    pub fn forget(&self, host: &str) {
        let host = host.trim().to_ascii_lowercase();
        self.write().retain(|(known, _)| *known != host);
    }

    /// An explicit Settings discovery lists every host a CLI knows. For each provider
    /// whose probe answered with a host list, its recorded hosts become exactly the
    /// authenticated ones; a provider whose CLI was missing or not understood keeps its
    /// entries. One write lock covers the replacement, so readers never see a gap.
    pub fn replace_from_discovery(&self, result: &SourceControlDiscoveryResult) {
        let mut hosts = self.write();
        for item in &result.source_control_providers {
            if !matches!(item.kind, ProviderKind::Github | ProviderKind::Gitlab) {
                continue;
            }
            let Some(listed) = item.auth.hosts.as_ref() else {
                continue;
            };
            hosts.retain(|(_, provider)| *provider != item.kind);
            for host in listed.iter().filter(|host| host.authenticated) {
                record_into(&mut hosts, &host.host, item.kind);
            }
        }
    }

    /// Forgets every recorded host that serves this remote (see [`host_serves_remote`]).
    pub fn forget_remote(&self, remote: &str) {
        self.write()
            .retain(|(known, _)| !host_serves_remote(known, remote));
    }

    /// The recorded host serving this remote, in [`serving_host`]'s order, and its provider.
    fn recorded_host(&self, remote: &str) -> Option<(String, ProviderKind)> {
        let hosts = self.read();
        let host = serving_host(hosts.iter().map(|(host, _)| host.as_str()), remote)?;
        hosts
            .iter()
            .find(|(known, _)| known == host)
            .map(|(known, provider)| (known.clone(), *provider))
    }

    /// The one rule for a remote's provider: well-known host names first, then
    /// recorded hosts. A named host still takes a recorded spelling that serves it but
    /// differs from its own (see [`host_serves_remote`]): a web port its SSH or scp
    /// origin cannot name (`gitlab.example.test:8929`), or a written default port for an
    /// HTTP(S) origin (`gitlab.example.test:443`), which only a probe can know. A recorded host's base URL is its recorded spelling, port included;
    /// Pull Requests scopes take their host from it.
    #[must_use]
    pub fn identify(&self, remote: &str) -> IdentifiedProvider {
        let named = provider_from_remote(remote);
        match self.recorded_host(remote) {
            Some((host, kind))
                if named.kind == ProviderKind::Unknown
                    || (named.kind == kind && Some(&host) != remote_web_host(remote).as_ref()) =>
            {
                let name = if kind == ProviderKind::Github {
                    "GitHub"
                } else {
                    "GitLab"
                };
                IdentifiedProvider::Recorded(provider(kind, name, &format!("https://{host}")))
            }
            _ if named.kind != ProviderKind::Unknown => IdentifiedProvider::Named(named),
            _ => IdentifiedProvider::Unknown,
        }
    }

    fn read(&self) -> RwLockReadGuard<'_, Vec<(String, ProviderKind)>> {
        self.hosts
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> RwLockWriteGuard<'_, Vec<(String, ProviderKind)>> {
        self.hosts
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn record_into(hosts: &mut Vec<(String, ProviderKind)>, host: &str, provider: ProviderKind) {
    if !matches!(provider, ProviderKind::Github | ProviderKind::Gitlab) {
        return;
    }
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return;
    }
    hosts.retain(|(known, _)| *known != host);
    hosts.push((host, provider));
    let excess = hosts.len().saturating_sub(CAPACITY);
    hosts.drain(..excess);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_control::{
        AuthStatus, DiscoveryStatus, SourceControlProviderAuth, SourceControlProviderDiscoveryItem,
        WireOption, discovery::SourceControlProviderAuthHost,
    };

    fn item(
        kind: ProviderKind,
        hosts: Option<&[(&str, bool)]>,
    ) -> SourceControlProviderDiscoveryItem {
        SourceControlProviderDiscoveryItem {
            kind,
            label: String::new(),
            executable: None,
            status: DiscoveryStatus::Available,
            version: WireOption(None),
            install_hint: String::new(),
            detail: WireOption(None),
            auth: SourceControlProviderAuth {
                status: AuthStatus::Authenticated,
                hosts: hosts.map(|hosts| {
                    hosts
                        .iter()
                        .map(|(host, authenticated)| SourceControlProviderAuthHost {
                            host: (*host).into(),
                            account: Some("someone".into()),
                            authenticated: *authenticated,
                        })
                        .collect()
                }),
                account: WireOption(None),
                host: WireOption(None),
                detail: WireOption(None),
            },
        }
    }

    fn discovery(items: Vec<SourceControlProviderDiscoveryItem>) -> SourceControlDiscoveryResult {
        SourceControlDiscoveryResult {
            version_control_systems: Vec::new(),
            source_control_providers: items,
        }
    }

    #[test]
    fn provider_hosts_classify_named_and_recorded_hosts_with_their_own_base_url() {
        let hosts = ProviderHosts::default();
        let self_hosted = "https://code.example.test/example-group/sample-project.git";
        assert_eq!(hosts.identify(self_hosted), IdentifiedProvider::Unknown);
        hosts.record("Code.Example.Test", ProviderKind::Gitlab);
        for remote in [
            self_hosted,
            "git@code.example.test:example-group/sample-project.git",
        ] {
            let IdentifiedProvider::Recorded(info) = hosts.identify(remote) else {
                panic!("expected recorded host: {remote}");
            };
            assert_eq!(info.kind, ProviderKind::Gitlab, "{remote}");
            assert_eq!(info.name, "GitLab");
            assert_eq!(info.base_url, "https://code.example.test");
        }
        hosts.record("github.company.example", ProviderKind::Github);
        let IdentifiedProvider::Recorded(enterprise) =
            hosts.identify("https://github.company.example/org/app.git")
        else {
            panic!("expected recorded Enterprise host");
        };
        assert_eq!(
            (enterprise.kind, enterprise.base_url.as_str()),
            (ProviderKind::Github, "https://github.company.example")
        );
        for (remote, kind, base_url) in [
            (
                "https://github.com/org/app.git",
                ProviderKind::Github,
                "https://github.com",
            ),
            (
                "git@gitlab.company.example:team/app.git",
                ProviderKind::Gitlab,
                "https://gitlab.company.example",
            ),
            (
                "https://dev.azure.com/org/project/_git/app",
                ProviderKind::AzureDevops,
                "https://dev.azure.com",
            ),
            (
                "git@bitbucket.org:team/app.git",
                ProviderKind::Bitbucket,
                "https://bitbucket.org",
            ),
            (
                "https://git.unknown.example/a/b.git",
                ProviderKind::Unknown,
                "",
            ),
        ] {
            let info = match hosts.identify(remote) {
                IdentifiedProvider::Named(info) | IdentifiedProvider::Recorded(info) => info,
                IdentifiedProvider::Unknown => {
                    assert_eq!(kind, ProviderKind::Unknown, "{remote}");
                    continue;
                }
            };
            assert_eq!(
                (info.kind, info.base_url.as_str()),
                (kind, base_url),
                "{remote}"
            );
        }
    }

    /// #332: a host recorded with its web port (`localhost:8929`) identifies the HTTP
    /// remote that names that port, and no other port of the same name.
    #[test]
    fn provider_hosts_identify_a_recorded_host_by_its_web_port() {
        let hosts = ProviderHosts::default();
        hosts.record("localhost:8929", ProviderKind::Gitlab);
        let IdentifiedProvider::Recorded(info) =
            hosts.identify("http://localhost:8929/group/project.git")
        else {
            panic!("expected the recorded host with its port");
        };
        assert_eq!(
            (info.kind, info.base_url.as_str()),
            (ProviderKind::Gitlab, "https://localhost:8929")
        );
        for remote in [
            "http://localhost:9999/group/project.git",
            "https://localhost/group/project.git",
        ] {
            assert_eq!(
                hosts.identify(remote),
                IdentifiedProvider::Unknown,
                "{remote}"
            );
        }
    }

    /// #332: an SSH or scp remote does not name the web port, so a recorded `host:port`
    /// of the same name identifies it, the lowest port first, named hosts included;
    /// an HTTP(S) remote keeps its own port and a named one its name.
    #[test]
    fn provider_hosts_identify_ssh_remotes_by_a_recorded_host_of_the_same_name() {
        let base_url = |hosts: &ProviderHosts, remote: &str| match hosts.identify(remote) {
            IdentifiedProvider::Recorded(info) => format!("recorded {}", info.base_url),
            IdentifiedProvider::Named(info) => format!("named {}", info.base_url),
            IdentifiedProvider::Unknown => "unknown".into(),
        };
        let hosts = ProviderHosts::default();
        hosts.record("localhost:9000", ProviderKind::Gitlab);
        hosts.record("localhost:8929", ProviderKind::Gitlab);
        hosts.record("gitlab.example.test:8929", ProviderKind::Gitlab);
        hosts.record("gitlab.tls.test:443", ProviderKind::Gitlab);
        for (remote, expected) in [
            (
                "https://gitlab.tls.test/g/p.git",
                "recorded https://gitlab.tls.test:443",
            ),
            (
                "git@localhost:group/project.git",
                "recorded https://localhost:8929",
            ),
            (
                "ssh://git@localhost:2224/group/project.git",
                "recorded https://localhost:8929",
            ),
            (
                "http://localhost:9000/group/project.git",
                "recorded https://localhost:9000",
            ),
            (
                "git@gitlab.example.test:g/p.git",
                "recorded https://gitlab.example.test:8929",
            ),
            (
                "https://gitlab.example.test/g/p.git",
                "named https://gitlab.example.test",
            ),
            ("git@other.example.test:g/p.git", "unknown"),
        ] {
            assert_eq!(base_url(&hosts, remote), expected, "{remote}");
        }
        hosts.forget_remote("git@localhost:group/project.git");
        assert_eq!(hosts.provider("localhost:8929"), None);
        assert_eq!(hosts.provider("localhost:9000"), None);
        assert_eq!(
            hosts.provider("gitlab.example.test:8929"),
            Some(ProviderKind::Gitlab)
        );
    }

    #[test]
    fn provider_hosts_record_forget_and_bound_the_map() {
        let hosts = ProviderHosts::default();
        hosts.record("git.acme.example", ProviderKind::AzureDevops);
        hosts.record(" ", ProviderKind::Gitlab);
        assert_eq!(hosts.provider("git.acme.example"), None);
        hosts.record("git.acme.example", ProviderKind::Gitlab);
        hosts.record("git.acme.example", ProviderKind::Github);
        assert_eq!(
            hosts.provider("GIT.ACME.EXAMPLE"),
            Some(ProviderKind::Github)
        );
        hosts.forget("Git.Acme.Example");
        assert_eq!(hosts.provider("git.acme.example"), None);
        for index in 0..=CAPACITY {
            hosts.record(&format!("host-{index}.example"), ProviderKind::Gitlab);
        }
        assert_eq!(
            hosts.provider("host-0.example"),
            None,
            "oldest entry dropped"
        );
        assert_eq!(
            hosts.provider(&format!("host-{CAPACITY}.example")),
            Some(ProviderKind::Gitlab)
        );
    }

    #[test]
    fn provider_hosts_discovery_replaces_only_answered_providers_with_authenticated_hosts() {
        let hosts = ProviderHosts::default();
        hosts.record("old-gitlab.example", ProviderKind::Gitlab);
        hosts.record("github.company.example", ProviderKind::Github);
        hosts.replace_from_discovery(&discovery(vec![
            item(ProviderKind::Github, None),
            item(
                ProviderKind::Gitlab,
                Some(&[("code.example.test", true), ("gitlab.com", false)]),
            ),
        ]));
        assert_eq!(hosts.provider("old-gitlab.example"), None);
        assert_eq!(
            hosts.provider("code.example.test"),
            Some(ProviderKind::Gitlab)
        );
        assert_eq!(
            hosts.provider("gitlab.com"),
            None,
            "unauthenticated hosts are not recorded"
        );
        assert_eq!(
            hosts.provider("github.company.example"),
            Some(ProviderKind::Github),
            "a provider without a host list keeps its entries"
        );
        hosts.replace_from_discovery(&discovery(vec![item(ProviderKind::Github, Some(&[]))]));
        assert_eq!(hosts.provider("github.company.example"), None);
        assert_eq!(
            hosts.provider("code.example.test"),
            Some(ProviderKind::Gitlab)
        );
        // An unrecognized GitLab answer has no host list, so its hosts stay recorded.
        hosts.replace_from_discovery(&discovery(vec![item(ProviderKind::Gitlab, None)]));
        assert_eq!(
            hosts.provider("code.example.test"),
            Some(ProviderKind::Gitlab)
        );
    }
}
