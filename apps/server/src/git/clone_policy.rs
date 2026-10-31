//! Where an outside agent may clone from (#139 slice X6, Revision 4).
//!
//! A clone an `mcp-client` principal starts, through the `clone_repository` tool or `vcs.clone`
//! and `sourceControl.cloneRepository` directly, must not make the server reach a host the
//! agent itself could not: loopback, the private network, link-local or other non-public
//! addresses. A person's clone in the UI never comes here.
//!
//! [`ClonePolicy::plan`] checks the URL and returns the [`ClonePlan`] that
//! `ReservedClone::transfer` runs Git with:
//!
//! - **HTTPS only**, written plainly, with no user information, so a credential never sits in
//!   tool arguments and no host spelling can differ between this check and curl. SSH, the
//!   scp-like `host:path`, `git://`, `file://`, `ext::` and every other transport are refused:
//!   SSH resolves the host again after any check, so it cannot be pinned (Revision 4).
//! - **Git's own rewrites first.** `git ls-remote --get-url` expands `url.<base>.insteadOf`
//!   without contacting the remote; the expanded URL must pass the same checks.
//! - **Resolved, checked, pinned.** Every address of each host must be public, and
//!   `http.curloptResolve` pins curl to those addresses, so DNS cannot move the host after the
//!   check. Redirects are not followed, and `protocol.allow` admits HTTPS alone, also through
//!   `GIT_ALLOW_PROTOCOL`, which a rewrite to `file:` or `ext::` meets too.
//! - **LFS smudge off.** A repository's `.lfsconfig` can point `lfs.url` at any host, and the
//!   smudge filter downloads from it outside Git's protocol and curl settings, so agent clones
//!   run with `GIT_LFS_SKIP_SMUDGE=1` and an empty, optional `lfs` filter: LFS files stay
//!   pointer files.
//!
//! A configured HTTP proxy resolves the name itself, so behind one the check covers the local
//! answer only (a stated residual risk).

use std::{
    ffi::OsString,
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr},
    path::Path,
    pin::Pin,
    sync::Arc,
    time::Duration,
};

use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

use super::{CloneLeaf, GitCommandError, GitRepository, GitVersion};

/// The host resolves to an address an agent may not reach.
pub(crate) const HOST_REFUSED: &str = "clone_host_refused";
/// The host's name did not resolve.
pub(crate) const HOST_UNRESOLVED: &str = "clone_host_unresolved";
/// The URL or folder name is not one an agent may clone with.
pub(crate) const URL_REFUSED: &str = "clone_url_refused";
/// Git is too old to pin the address.
pub(crate) const GIT_TOO_OLD: &str = "clone_git_too_old";
/// The clone would not sit next to a registered project.
pub(crate) const DESTINATION_REFUSED: &str = "clone_destination_refused";
pub(crate) const OUTSIDE_PROJECTS: &str = "An agent clones only next to a registered project: the parent folder must be the folder that holds one of BiBCode's projects.";

/// The first Git with `http.curloptResolve` (RelNotes 2.37.0). An older Git ignores the
/// unknown key and would skip the pin, so it is refused.
const CURLOPT_RESOLVE: GitVersion = GitVersion {
    major: 2,
    minor: 37,
    patch: 0,
};
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);
const OPERATION: &str = "GitVcsDriver.clone";

const NOT_HTTPS: &str = "BiBCode clones for an agent over HTTPS only: give an https:// URL such as https://github.com/owner/repo. SSH, host:path, git://, file:// and other transports are refused; clone it in BiBCode yourself to use them.";
const CREDENTIALS: &str = "Remove the user name or token from the URL. Git uses the credentials it already has for the host.";
const NOT_PLAIN: &str = "Write the URL plainly, as https://host/owner/repo: no spaces, encoded characters, default port or unusual spelling of the host.";
const PRIVATE: &str = "BiBCode does not clone from local or private network addresses for an agent. Clone it in BiBCode yourself.";

pub(crate) type ResolveFuture<'a> =
    Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send + 'a>>;

/// Resolves a host name to its addresses. Production asks the system resolver; tests inject
/// a map, so no test reaches the network.
pub(crate) trait HostResolver: Send + Sync {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a>;
}

struct SystemResolver;

impl HostResolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a> {
        Box::pin(async move {
            let addresses =
                tokio::time::timeout(RESOLVE_TIMEOUT, tokio::net::lookup_host((host, port)))
                    .await
                    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timed out"))??;
            Ok(addresses.map(|address| address.ip()).collect())
        })
    }
}

/// What an agent clone is refused for: a `reason` an agent can branch on, and what to do.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct CloneRefusal {
    pub(crate) reason: &'static str,
    pub(crate) message: String,
}

impl CloneRefusal {
    pub(crate) fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }

    /// The refusal as the `GitCommandError` `vcs.clone` already declares, with `reason`.
    pub(crate) fn into_error(self, cwd: &Path) -> Value {
        let mut error = serialize(GitCommandError {
            tag: "GitCommandError",
            operation: OPERATION.into(),
            command: "git".into(),
            cwd: cwd.to_string_lossy().into(),
            diagnostics: None,
            detail: self.message.into(),
        });
        error["reason"] = self.reason.into();
        error
    }
}

fn serialize(error: GitCommandError) -> Value {
    serde_json::to_value(error).unwrap_or(Value::Null)
}

/// The configuration an agent clone runs Git with: `-c` pairs placed before `clone`, and
/// environment beside Git's own non-interactive environment.
#[derive(Clone, Debug)]
pub(crate) struct ClonePlan {
    arguments: Vec<String>,
    environment: Vec<(OsString, OsString)>,
}

impl ClonePlan {
    pub(crate) fn arguments(&self) -> &[String] {
        &self.arguments
    }

    pub(crate) fn environment(&self) -> &[(OsString, OsString)] {
        &self.environment
    }
}

/// One host a clone contacts.
#[derive(Clone, Debug, Eq, PartialEq)]
struct Target {
    host: Host<String>,
    port: u16,
}

/// A folder name Git could read as an option is refused, although Git gets it after `--`.
pub(crate) fn check_leaf(leaf: &CloneLeaf) -> Result<(), CloneRefusal> {
    if leaf.as_str().starts_with('-') {
        return Err(CloneRefusal::new(
            URL_REFUSED,
            "The folder name may not start with \"-\". Give directoryName another name.",
        ));
    }
    Ok(())
}

fn target(url: &str, allow_http: bool) -> Result<Target, CloneRefusal> {
    let refuse = |message: &str| Err(CloneRefusal::new(URL_REFUSED, message));
    if !(url.starts_with("https://") || (allow_http && url.starts_with("http://"))) {
        return refuse(NOT_HTTPS);
    }
    let Ok(parsed) = Url::parse(url) else {
        return refuse(NOT_PLAIN);
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return refuse(CREDENTIALS);
    }
    // The parser decodes and normalizes what curl may read differently (encoded or unicode
    // hosts, numeric IPv4 forms, whitespace). Only a URL it leaves as written is accepted, so
    // the host checked and pinned is the host curl connects to.
    let canonical = parsed.as_str();
    if !(canonical.eq_ignore_ascii_case(url) || canonical.eq_ignore_ascii_case(&format!("{url}/")))
    {
        return refuse(NOT_PLAIN);
    }
    let (Some(host), Some(port)) = (parsed.host(), parsed.port_or_known_default()) else {
        return refuse(NOT_PLAIN);
    };
    if let Host::Domain(name) = host
        && (name.is_empty() || name.ends_with('.'))
    {
        return refuse(NOT_PLAIN);
    }
    Ok(Target {
        host: host.to_owned(),
        port,
    })
}

/// Whether an agent may reach `address`: not loopback, private, link-local, CGNAT
/// (`100.64.0.0/10`), unique-local, multicast, unspecified, broadcast or reserved, IPv4-mapped
/// and IPv4-compatible forms included.
pub(crate) fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public_v4(mapped);
            }
            let segments = address.segments();
            // `::a.b.c.d` (deprecated IPv4-compatible), which also covers `::` and `::1`.
            if segments[..6] == [0; 6] {
                return is_public_v4(Ipv4Addr::from(
                    (u32::from(segments[6]) << 16) | u32::from(segments[7]),
                ));
            }
            !(address.is_multicast()
                // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local.
                || segments[0] & 0xfe00 == 0xfc00
                || segments[0] & 0xffc0 == 0xfe80
                || segments[0] & 0xffc0 == 0xfec0)
        }
    }
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    let [first, second, ..] = address.octets();
    !(address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || first == 0
        || (first == 100 && second & 0xc0 == 64)
        || first >= 240)
}

/// The agent clone policy of one server.
#[derive(Clone)]
pub(crate) struct ClonePolicy {
    resolver: Arc<dyn HostResolver>,
    #[cfg(test)]
    fixture: Option<Arc<FixtureAllowance>>,
}

/// Test-only settings: extra environment (a test `GIT_CONFIG_GLOBAL`) for every Git command
/// the policy runs, and, with `admit_local`, a local fixture's `http://` and loopback addresses.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FixtureAllowance {
    pub(crate) environment: Vec<(OsString, OsString)>,
    pub(crate) admit_local: bool,
}

impl Default for ClonePolicy {
    fn default() -> Self {
        Self::new(Arc::new(SystemResolver))
    }
}

impl ClonePolicy {
    pub(crate) fn new(resolver: Arc<dyn HostResolver>) -> Self {
        Self {
            resolver,
            #[cfg(test)]
            fixture: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn admitting_fixture(
        resolver: Arc<dyn HostResolver>,
        allowance: FixtureAllowance,
    ) -> Self {
        Self {
            resolver,
            fixture: Some(Arc::new(allowance)),
        }
    }

    fn admits_fixture(&self) -> bool {
        #[cfg(test)]
        return self
            .fixture
            .as_ref()
            .is_some_and(|fixture| fixture.admit_local);
        #[cfg(not(test))]
        false
    }

    fn admits(&self, address: IpAddr) -> bool {
        is_public(address) || (self.admits_fixture() && address.to_canonical().is_loopback())
    }

    fn environment(&self) -> Vec<(OsString, OsString)> {
        let protocols = if self.admits_fixture() {
            "https:http"
        } else {
            "https"
        };
        #[allow(unused_mut)]
        let mut environment = vec![
            ("GIT_LFS_SKIP_SMUDGE".into(), "1".into()),
            ("GIT_ALLOW_PROTOCOL".into(), protocols.into()),
        ];
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            environment.extend(fixture.environment.iter().cloned());
        }
        environment
    }

    /// Checks `url` for a clone into `leaf` an agent starts, and returns what Git runs with.
    /// Every refusal is a `GitCommandError` with a `reason`; Git's own failures keep their
    /// shape. `cwd` is the folder the clone runs in, so Git reads the same configuration.
    pub(crate) async fn plan(
        &self,
        repository: &GitRepository,
        url: &str,
        leaf: &CloneLeaf,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<ClonePlan, Value> {
        let refused = |refusal: CloneRefusal| refusal.into_error(cwd);
        check_leaf(leaf).map_err(refused)?;
        let allow_http = self.admits_fixture();
        let original = target(url, allow_http).map_err(refused)?;
        let version = repository
            .git_manager_git_version(cwd, cancellation)
            .await
            .map_err(serialize)?;
        if version.is_none_or(|version| version < CURLOPT_RESOLVE) {
            let found = version.map_or_else(|| "an unknown version".to_owned(), |v| v.to_string());
            return Err(refused(CloneRefusal::new(
                GIT_TOO_OLD,
                format!(
                    "Cloning for an agent needs Git {CURLOPT_RESOLVE} or later, and this server has {found}. Update Git, or clone it in BiBCode yourself."
                ),
            )));
        }
        let environment = self.environment();
        let expanded = repository
            .clone_remote_url(cwd, url, environment.clone(), cancellation)
            .await
            .map_err(serialize)?;
        let expanded = target(&expanded, allow_http).map_err(refused)?;

        let fixture_protocol = allow_http.then_some("protocol.http.allow=always");
        let mut arguments: Vec<String> = ["protocol.allow=never", "protocol.https.allow=always"]
            .into_iter()
            .chain(fixture_protocol)
            .chain([
                "http.followRedirects=false",
                "filter.lfs.smudge=",
                "filter.lfs.process=",
                "filter.lfs.required=false",
            ])
            .flat_map(|setting| ["-c".to_owned(), setting.to_owned()])
            .collect();
        let mut targets = vec![original];
        if !targets.contains(&expanded) {
            targets.push(expanded);
        }
        for target in targets {
            let addresses = self
                .addresses(&target, cancellation)
                .await
                .map_err(refused)?;
            if let Host::Domain(name) = &target.host {
                let pinned = addresses
                    .iter()
                    .map(|address| match address {
                        IpAddr::V4(address) => address.to_string(),
                        IpAddr::V6(address) => format!("[{address}]"),
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                arguments.push("-c".to_owned());
                arguments.push(format!(
                    "http.curloptResolve={name}:{}:{pinned}",
                    target.port
                ));
            }
        }
        Ok(ClonePlan {
            arguments,
            environment,
        })
    }

    /// Every address of `target`, each of them one an agent may reach.
    async fn addresses(
        &self,
        target: &Target,
        cancellation: &CancellationToken,
    ) -> Result<Vec<IpAddr>, CloneRefusal> {
        let addresses = match &target.host {
            Host::Ipv4(address) => vec![IpAddr::V4(*address)],
            Host::Ipv6(address) => vec![IpAddr::V6(*address)],
            Host::Domain(name) => {
                let resolved = tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        return Err(CloneRefusal::new(HOST_UNRESOLVED, "The clone was cancelled."));
                    }
                    resolved = self.resolver.resolve(name, target.port) => resolved,
                };
                resolved.map_err(|error| {
                    CloneRefusal::new(
                        HOST_UNRESOLVED,
                        format!("BiBCode could not resolve {name} ({error}). Check the URL."),
                    )
                })?
            }
        };
        if addresses.is_empty() {
            return Err(CloneRefusal::new(
                HOST_UNRESOLVED,
                "BiBCode could not resolve the host. Check the URL.",
            ));
        }
        if !addresses.iter().all(|address| self.admits(*address)) {
            return Err(CloneRefusal::new(HOST_REFUSED, PRIVATE));
        }
        Ok(addresses)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::{collections::HashMap, net::Ipv6Addr};

    use super::*;

    /// A resolver over a fixed map; any other name fails, so nothing reaches the network.
    pub(crate) struct MapResolver(pub(crate) HashMap<String, Vec<IpAddr>>);

    impl HostResolver for MapResolver {
        fn resolve<'a>(&'a self, host: &'a str, _port: u16) -> ResolveFuture<'a> {
            Box::pin(async move {
                self.0.get(host).cloned().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "unknown name in the test map")
                })
            })
        }
    }

    pub(crate) fn resolver(entries: &[(&str, &str)]) -> Arc<dyn HostResolver> {
        let mut map: HashMap<String, Vec<IpAddr>> = HashMap::new();
        for (name, address) in entries {
            map.entry((*name).to_owned())
                .or_default()
                .push(address.parse().expect("an address"));
        }
        Arc::new(MapResolver(map))
    }

    fn leaf(name: &str) -> CloneLeaf {
        crate::git::clone_destination_leaf("https://example.com/repo.git", Some(name))
            .expect("a folder name")
    }

    async fn plan(policy: &ClonePolicy, url: &str) -> Result<ClonePlan, Value> {
        let cwd = tempfile::tempdir().expect("cwd");
        policy
            .plan(
                &GitRepository::default(),
                url,
                &leaf("repo"),
                cwd.path(),
                &CancellationToken::new(),
            )
            .await
    }

    fn reason(error: &Value) -> &str {
        error["reason"].as_str().unwrap_or_default()
    }

    #[test]
    fn only_a_plain_https_url_without_credentials_is_accepted() {
        for url in [
            "https://github.com/owner/repo",
            "https://github.com/owner/repo.git",
            "https://GitHub.com/owner/repo",
            "https://git.example.com:8443/owner/repo.git",
            "https://[2606:4700::1111]/owner/repo",
        ] {
            assert!(target(url, false).is_ok(), "{url}");
        }
        // Every transport but HTTPS, SSH included (Revision 4), refused for being one: written
        // without a user, so no other rule refuses them first.
        for url in [
            "ssh://github.com/owner/repo.git",
            "ssh://github.com:22/owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "git+ssh://github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "github.com:owner/repo",
            "git://github.com/owner/repo.git",
            "file:///srv/repo.git",
            "/srv/repo.git",
            "ext::sh -c touch% /tmp/pwned",
            "https::https://github.com/owner/repo",
            "http://github.com/owner/repo",
        ] {
            let refusal = target(url, false).expect_err(url);
            assert_eq!(refusal.reason, URL_REFUSED, "{url}");
            assert_eq!(refusal.message, NOT_HTTPS, "{url}");
        }
        for url in [
            // Option injection.
            "-c",
            "--upload-pack=touch /tmp/pwned",
            "-uhttps://github.com/owner/repo",
            "https://github.com/owner/repo -c core.sshCommand=x",
            // Credentials in the arguments.
            "https://user:token@github.com/owner/repo",
            "https://token@github.com/owner/repo",
            "https://:token@github.com/owner/repo",
            // Spellings curl may read differently from the check.
            "https://github.com:443/owner/repo",
            "https://2130706433/owner/repo",
            "https://0x7f.1/owner/repo",
            "https://git%68ub.com/owner/repo",
            "https://gïthub.com/owner/repo",
            "https://github.com./owner/repo",
            "https://github.com/owner/re po",
            "https://github.com/owner/repo\n",
        ] {
            let refusal = target(url, false).expect_err(url);
            assert_eq!(refusal.reason, URL_REFUSED, "{url}");
        }
    }

    #[test]
    fn a_folder_name_that_reads_as_an_option_is_refused() {
        assert_eq!(check_leaf(&leaf("repo")), Ok(()));
        assert_eq!(
            check_leaf(&leaf("--upload-pack=x"))
                .expect_err("option")
                .reason,
            URL_REFUSED
        );
        assert_eq!(
            check_leaf(&leaf("-c")).expect_err("option").reason,
            URL_REFUSED
        );
    }

    #[test]
    fn local_private_and_special_addresses_are_not_public() {
        for address in [
            "127.0.0.1",
            "127.1.2.3",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "0.1.2.3",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::127.0.0.1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
        ] {
            let parsed: IpAddr = address.parse().expect(address);
            assert!(!is_public(parsed), "{address}");
        }
        for address in [
            "140.82.112.3",
            "100.128.0.1",
            "172.32.0.1",
            "8.8.8.8",
            "::ffff:140.82.112.3",
            "2606:4700::1111",
        ] {
            let parsed: IpAddr = address.parse().expect(address);
            assert!(is_public(parsed), "{address}");
        }
        assert!(!is_public(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    #[tokio::test]
    async fn a_public_host_is_pinned_to_its_checked_addresses_with_lfs_and_redirects_off() {
        let policy = ClonePolicy::new(resolver(&[
            ("github.com", "140.82.112.3"),
            ("github.com", "2606:4700::1111"),
        ]));
        let plan = plan(&policy, "https://github.com/owner/repo.git")
            .await
            .expect("a public host");
        let settings = plan
            .arguments()
            .chunks(2)
            .map(|pair| {
                assert_eq!(pair[0], "-c");
                pair[1].as_str()
            })
            .collect::<Vec<_>>();
        for expected in [
            "protocol.allow=never",
            "protocol.https.allow=always",
            "http.followRedirects=false",
            "filter.lfs.smudge=",
            "filter.lfs.process=",
            "filter.lfs.required=false",
            "http.curloptResolve=github.com:443:140.82.112.3,[2606:4700::1111]",
        ] {
            assert!(settings.contains(&expected), "{expected} in {settings:?}");
        }
        assert!(!settings.iter().any(|setting| setting.contains("ssh")));
        let environment = plan
            .environment()
            .iter()
            .map(|(key, value)| (key.to_str().unwrap(), value.to_str().unwrap()))
            .collect::<Vec<_>>();
        assert!(environment.contains(&("GIT_LFS_SKIP_SMUDGE", "1")));
        assert!(environment.contains(&("GIT_ALLOW_PROTOCOL", "https")));
    }

    #[tokio::test]
    async fn loopback_private_and_unresolvable_hosts_are_refused() {
        let policy = ClonePolicy::new(resolver(&[
            ("loopback.example.com", "::1"),
            ("mixed.example.com", "140.82.112.3"),
            ("mixed.example.com", "10.0.0.7"),
        ]));
        for url in [
            "https://127.0.0.1/owner/repo",
            "https://10.0.0.1/owner/repo",
            "https://[::1]/owner/repo",
            "https://[::ffff:7f00:1]/owner/repo",
            "https://loopback.example.com/owner/repo",
            "https://mixed.example.com/owner/repo",
        ] {
            let error = plan(&policy, url).await.expect_err(url);
            assert_eq!(reason(&error), HOST_REFUSED, "{url}: {error}");
            assert_eq!(error["_tag"], "GitCommandError");
            assert_eq!(error["detail"], PRIVATE);
        }
        let error = plan(&policy, "https://unknown.example.com/owner/repo")
            .await
            .expect_err("unresolved");
        assert_eq!(reason(&error), HOST_UNRESOLVED);
    }

    #[tokio::test]
    async fn the_fixture_allowance_admits_http_and_loopback_only() {
        let policy = ClonePolicy::admitting_fixture(
            resolver(&[("fixture.invalid", "127.0.0.1")]),
            FixtureAllowance {
                admit_local: true,
                ..FixtureAllowance::default()
            },
        );
        let plan = plan(&policy, "http://fixture.invalid:8080/repo.git")
            .await
            .expect("the fixture");
        assert!(
            plan.arguments()
                .contains(&"http.curloptResolve=fixture.invalid:8080:127.0.0.1".to_owned())
        );
        let error = plan_error(&policy, "http://10.0.0.1/repo.git").await;
        assert_eq!(reason(&error), HOST_REFUSED);
    }

    async fn plan_error(policy: &ClonePolicy, url: &str) -> Value {
        plan(policy, url).await.expect_err(url)
    }
}
