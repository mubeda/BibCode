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
//!   `http.curloptResolve` pins curl to the first of them, so DNS cannot move the host after
//!   the check. Redirects are not followed, and `protocol.allow` admits HTTPS alone, also through
//!   `GIT_ALLOW_PROTOCOL`, which a rewrite to `file:` or `ext::` meets too.
//! - **LFS smudge off.** A repository's `.lfsconfig` can point `lfs.url` at any host, and the
//!   smudge filter downloads from it outside Git's protocol and curl settings, so agent clones
//!   run with `GIT_LFS_SKIP_SMUDGE=1` and an empty, optional `lfs` filter: LFS files stay
//!   pointer files. Submodules are not cloned (`submodule.recurse=false`).
//!
//! A configured HTTP proxy resolves the name itself, so behind one the check covers the local
//! answer only (a stated residual risk).

use std::{
    ffi::OsString,
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
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
/// An agent asked for a clone that outlives its call.
pub(crate) const DETACH_REFUSED: &str = "clone_detach_refused";
pub(crate) const DETACHED: &str = "An agent's clone stops when its call ends, so detach is refused. Use the clone_repository tool to clone in the background.";
/// An agent asked to cancel a clone it did not start.
pub(crate) const NOT_OWNED: &str = "clone_not_owned";
pub(crate) const OTHERS_CLONE: &str = "An agent can cancel only a clone it started.";
pub(crate) const OUTSIDE_PROJECTS: &str = "An agent clones only next to a registered project: the parent folder must be the folder that holds one of BiBCode's projects.";

/// The first Git with `http.curloptResolve` (RelNotes 2.37.0). An older Git ignores the
/// unknown key and would skip the pin, so it is refused.
const CURLOPT_RESOLVE: GitVersion = GitVersion {
    major: 2,
    minor: 37,
    patch: 0,
};
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);
/// The only server variables an agent clone's Git commands inherit; everything else is cleared
/// (`env_clear`). A denylist kept missing variables (`GIT_DIR` and `GIT_WORK_TREE`, the TLS
/// trust overrides, `GIT_TEMPLATE_DIR`, `GIT_EXEC_PATH`, `GIT_TRACE*`), so the whole class is
/// closed. `LC_*` is a prefix. Git's own settings, the isolation and `HOME` are set after.
const INHERITED: &[&str] = &["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_*", "TZ"];
/// What Windows programs need beside them.
const INHERITED_ON_WINDOWS: &[&str] = &[
    "SystemRoot",
    "windir",
    "ComSpec",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
];

/// Whether an agent clone's Git commands inherit the server's variable `name`.
pub(crate) fn is_inherited(name: &str) -> bool {
    let same = |a: &str, b: &str| {
        if cfg!(windows) {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let windows: &[&str] = if cfg!(windows) {
        INHERITED_ON_WINDOWS
    } else {
        &[]
    };
    INHERITED
        .iter()
        .chain(windows)
        .any(|allowed| match allowed.strip_suffix('*') {
            Some(prefix) => name.len() >= prefix.len() && same(&name[..prefix.len()], prefix),
            None => same(name, allowed),
        })
}

/// The server's variables an agent clone's Git commands start from: the allowlist only.
pub(crate) fn inherited_environment() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(name, _)| name.to_str().is_some_and(is_inherited))
        .collect()
}
/// The null device, for an empty global configuration and an empty hooks folder.
const NULL_DEVICE: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };
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

/// The system resolver, bounded to 10 seconds; also the webhook dispatcher's (slice X8).
pub(crate) struct SystemResolver;

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

/// Whether an agent may reach `address`: a globally reachable unicast address. Every range the
/// IANA IPv4 and IPv6 special-purpose address registries mark not globally reachable is
/// refused (a few small anycast blocks inside them that are reachable are refused too), and so
/// are multicast, IPv6 outside `2000::/3`, IPv4-compatible and IPv4-translated forms, and
/// Teredo. A mapped, NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) address is judged by the
/// IPv4 address it embeds.
pub(crate) fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => is_public_v6(address),
    }
}

/// Whether `bits` lies in `network/length` (`length` at least 1).
fn in_prefix<T>(bits: T, network: T, length: u32) -> bool
where
    T: std::ops::BitXor<Output = T> + std::ops::Shr<u32, Output = T> + PartialEq + From<u8>,
{
    let width = u32::try_from(std::mem::size_of::<T>() * 8).unwrap_or(128);
    (bits ^ network) >> (width - length) == T::from(0)
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    const NOT_GLOBAL: [([u8; 4], u32); 15] = [
        ([0, 0, 0, 0], 8),       // this network
        ([10, 0, 0, 0], 8),      // private
        ([100, 64, 0, 0], 10),   // shared address space (CGNAT)
        ([127, 0, 0, 0], 8),     // loopback
        ([169, 254, 0, 0], 16),  // link-local
        ([172, 16, 0, 0], 12),   // private
        ([192, 0, 0, 0], 24),    // IETF protocol assignments
        ([192, 0, 2, 0], 24),    // TEST-NET-1
        ([192, 88, 99, 0], 24),  // 6to4 relay anycast (deprecated)
        ([192, 168, 0, 0], 16),  // private
        ([198, 18, 0, 0], 15),   // benchmarking
        ([198, 51, 100, 0], 24), // TEST-NET-2
        ([203, 0, 113, 0], 24),  // TEST-NET-3
        ([224, 0, 0, 0], 4),     // multicast
        ([240, 0, 0, 0], 4),     // reserved, and the limited broadcast address
    ];
    let bits = u32::from(address);
    !NOT_GLOBAL
        .iter()
        .any(|&(network, length)| in_prefix(bits, u32::from_be_bytes(network), length))
}

fn is_public_v6(address: Ipv6Addr) -> bool {
    let bits = u128::from(address);
    let embedded = |shift: u32| Ipv4Addr::from(((bits >> shift) & 0xffff_ffff) as u32);
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_v4(mapped);
    }
    let net = |segments: [u16; 8]| u128::from(Ipv6Addr::from(segments));
    // NAT64's well-known prefix carries the IPv4 address in its last 32 bits, 6to4 in the 32
    // after its first 16.
    if in_prefix(bits, net([0x64, 0xff9b, 0, 0, 0, 0, 0, 0]), 96) {
        return is_public_v4(embedded(0));
    }
    if in_prefix(bits, net([0x2002, 0, 0, 0, 0, 0, 0, 0]), 16) {
        return is_public_v4(embedded(80));
    }
    let not_global = [
        (net([0x2001, 0, 0, 0, 0, 0, 0, 0]), 23), // IETF protocol assignments, Teredo
        (net([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]), 32), // documentation
        (net([0x3fff, 0, 0, 0, 0, 0, 0, 0]), 20), // documentation
        (net([0x5f00, 0, 0, 0, 0, 0, 0, 0]), 16), // segment routing SIDs
    ];
    // Only 2000::/3 is global unicast; everything else (`::/8` with loopback, unspecified,
    // IPv4-compatible and -translated forms, `64:ff9b:1::/48`, `100::/64`, `fc00::/7`,
    // `fe80::/10`, `fec0::/10`, `ff00::/8`) is not.
    in_prefix(bits, net([0x2000, 0, 0, 0, 0, 0, 0, 0]), 3)
        && !not_global
            .iter()
            .any(|&(network, length)| in_prefix(bits, network, length))
}

/// The agent clone policy of one server.
#[derive(Clone)]
pub(crate) struct ClonePolicy {
    resolver: Arc<dyn HostResolver>,
    #[cfg(test)]
    fixture: Option<Arc<FixtureAllowance>>,
}

/// Test-only settings: environment the server's Git commands inherit (a test `HOME`, a proxy),
/// which the isolation then overrides, and, with `admit_local`, a local fixture's `http://` and
/// loopback addresses.
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
        let mut environment: Vec<(OsString, OsString)> = Vec::new();
        // What a test's server inherited comes first, so the isolation below wins.
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            environment.extend(fixture.environment.iter().cloned());
        }
        // An isolated configuration: no global or system file (and so no rewrite, proxy,
        // URL-specific setting, hook, fsmonitor or filter driver of the person's), no
        // inherited `-c` parameters, and no proxy from the environment.
        environment.extend(
            [
                // Nothing under a home folder: curl's `.netrc` included.
                ("HOME", NULL_DEVICE),
                ("GIT_CONFIG_GLOBAL", NULL_DEVICE),
                ("GIT_CONFIG_NOSYSTEM", "1"),
                ("GIT_CONFIG_PARAMETERS", ""),
                ("GIT_CONFIG_COUNT", "0"),
                ("GIT_LFS_SKIP_SMUDGE", "1"),
                ("GIT_ALLOW_PROTOCOL", protocols),
                ("https_proxy", ""),
                ("HTTPS_PROXY", ""),
                ("http_proxy", ""),
                ("HTTP_PROXY", ""),
                ("all_proxy", ""),
                ("ALL_PROXY", ""),
                ("NO_PROXY", "*"),
                ("no_proxy", "*"),
            ]
            .map(|(key, value)| (key.into(), value.into())),
        );
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
        let environment = self.environment();
        let version = repository
            .clone_git_version(cwd, &environment, cancellation)
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
        let expanded = repository
            .clone_remote_url(cwd, url, &environment, cancellation)
            .await
            .map_err(serialize)?;
        let expanded = target(&expanded, allow_http).map_err(refused)?;

        let fixture_protocol = allow_http.then_some("protocol.http.allow=always");
        let hooks = format!("core.hooksPath={NULL_DEVICE}");
        let mut arguments: Vec<String> = ["protocol.allow=never", "protocol.https.allow=always"]
            .into_iter()
            .chain(fixture_protocol)
            .chain([
                "http.followRedirects=false",
                "filter.lfs.smudge=",
                "filter.lfs.process=",
                "filter.lfs.required=false",
                // Never into submodules, whose hosts this policy has not checked.
                "submodule.recurse=false",
                // Above the isolated configuration, for a repository's own: no proxy (an
                // empty value also turns off the environment's), hook or fsmonitor.
                "http.proxy=",
                "core.fsmonitor=false",
                &hooks,
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
            // One address: curl before 7.59 skips a comma list it cannot parse, and would then
            // resolve the name again.
            if let (Host::Domain(name), Some(address)) = (&target.host, addresses.first()) {
                let pinned = match address {
                    IpAddr::V4(address) => address.to_string(),
                    IpAddr::V6(address) => format!("[{address}]"),
                };
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
    fn only_globally_reachable_addresses_are_public() {
        // One address per non-global range of the IANA IPv4 and IPv6 special-purpose address
        // registries (and multicast, and addresses outside 2000::/3), with the range named.
        for (address, range) in [
            ("0.0.0.0", "0.0.0.0/8 this network"),
            ("0.1.2.3", "0.0.0.0/8 this network"),
            ("10.0.0.1", "10.0.0.0/8 private"),
            ("100.64.0.1", "100.64.0.0/10 shared address space"),
            ("100.127.255.254", "100.64.0.0/10 shared address space"),
            ("127.0.0.1", "127.0.0.0/8 loopback"),
            ("127.1.2.3", "127.0.0.0/8 loopback"),
            ("169.254.169.254", "169.254.0.0/16 link-local"),
            ("172.16.0.1", "172.16.0.0/12 private"),
            ("172.31.255.254", "172.16.0.0/12 private"),
            ("192.0.0.1", "192.0.0.0/24 IETF protocol assignments"),
            ("192.0.0.170", "192.0.0.0/24 IETF protocol assignments"),
            ("192.0.2.1", "192.0.2.0/24 TEST-NET-1"),
            ("192.88.99.1", "192.88.99.0/24 6to4 relay anycast"),
            ("192.168.1.1", "192.168.0.0/16 private"),
            ("198.18.0.1", "198.18.0.0/15 benchmarking"),
            ("198.19.255.254", "198.18.0.0/15 benchmarking"),
            ("198.51.100.1", "198.51.100.0/24 TEST-NET-2"),
            ("203.0.113.1", "203.0.113.0/24 TEST-NET-3"),
            ("224.0.0.1", "224.0.0.0/4 multicast"),
            ("239.255.255.255", "224.0.0.0/4 multicast"),
            ("240.0.0.1", "240.0.0.0/4 reserved"),
            ("255.255.255.255", "255.255.255.255/32 broadcast"),
            ("::", "::/128 unspecified"),
            ("::1", "::1/128 loopback"),
            ("::127.0.0.1", "::/96 IPv4-compatible (deprecated)"),
            ("::8.8.8.8", "::/96 IPv4-compatible (deprecated)"),
            ("::ffff:127.0.0.1", "::ffff:0:0/96 mapped loopback"),
            ("::ffff:10.0.0.1", "::ffff:0:0/96 mapped private"),
            ("::ffff:198.18.0.1", "::ffff:0:0/96 mapped benchmarking"),
            ("::ffff:0:8.8.8.8", "::ffff:0:0:0/96 IPv4-translated"),
            ("64:ff9b::a00:1", "64:ff9b::/96 NAT64 of 10.0.0.1"),
            ("64:ff9b::7f00:1", "64:ff9b::/96 NAT64 of 127.0.0.1"),
            ("64:ff9b:1::1", "64:ff9b:1::/48 local-use NAT64"),
            ("100::1", "100::/64 discard-only"),
            ("100:0:0:1::1", "100:0:0:1::/64 dummy prefix"),
            ("2001::1", "2001::/32 Teredo"),
            ("2001:0:4136:e378:8000:63bf:f5ff:fffe", "2001::/32 Teredo"),
            ("2001:2::1", "2001:2::/48 benchmarking"),
            ("2001:10::1", "2001:10::/28 ORCHID"),
            ("2001:db8::1", "2001:db8::/32 documentation"),
            ("2002:a00:1::1", "2002::/16 6to4 of 10.0.0.1"),
            ("2002:7f00:1::1", "2002::/16 6to4 of 127.0.0.1"),
            ("2002:c612:1::1", "2002::/16 6to4 of 198.18.0.1"),
            ("3fff::1", "3fff::/20 documentation"),
            ("5f00::1", "5f00::/16 segment routing SIDs"),
            ("fc00::1", "fc00::/7 unique-local"),
            ("fd12:3456::1", "fc00::/7 unique-local"),
            ("fe80::1", "fe80::/10 link-local"),
            ("fec0::1", "fec0::/10 site-local (deprecated)"),
            ("ff02::1", "ff00::/8 multicast"),
            ("4000::1", "outside 2000::/3 global unicast"),
        ] {
            let parsed: IpAddr = address.parse().expect(address);
            assert!(!is_public(parsed), "{address} is in {range}");
        }
        for address in [
            "1.1.1.1",
            "8.8.8.8",
            "140.82.112.3",
            "100.128.0.1",
            "172.32.0.1",
            "192.0.3.1",
            "198.20.0.1",
            "198.51.101.1",
            "203.0.114.1",
            "223.255.255.254",
            "::ffff:140.82.112.3",
            "64:ff9b::808:808",
            "2002:808:808::1",
            "2606:4700::1111",
            "2a00:1450:4001::1",
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
            "submodule.recurse=false",
            "http.curloptResolve=github.com:443:140.82.112.3",
            "http.proxy=",
            "core.fsmonitor=false",
            &format!("core.hooksPath={NULL_DEVICE}"),
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
        // An isolated configuration: no global or system file, no inherited parameters, no
        // proxy from the environment.
        for expected in [
            ("GIT_CONFIG_GLOBAL", NULL_DEVICE),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_PARAMETERS", ""),
            ("GIT_CONFIG_COUNT", "0"),
            ("https_proxy", ""),
            ("HTTPS_PROXY", ""),
            ("http_proxy", ""),
            ("all_proxy", ""),
            ("ALL_PROXY", ""),
            ("NO_PROXY", "*"),
            ("no_proxy", "*"),
        ] {
            assert!(
                environment.contains(&expected),
                "{expected:?} in {environment:?}"
            );
        }

        let policy = ClonePolicy::new(resolver(&[("v6.example.com", "2606:4700::1111")]));
        let v6 = super::tests::plan(&policy, "https://v6.example.com/owner/repo.git")
            .await
            .expect("a public host");
        assert!(
            v6.arguments()
                .contains(&"http.curloptResolve=v6.example.com:443:[2606:4700::1111]".to_owned())
        );
    }

    #[tokio::test]
    async fn an_agent_clone_inherits_only_an_allowlist() {
        for name in [
            "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
        ] {
            assert!(is_inherited(name), "{name}");
        }
        let refused = [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_COMMON_DIR",
            "GIT_NAMESPACE",
            "GIT_CEILING_DIRECTORIES",
            "GIT_DISCOVERY_ACROSS_FILESYSTEM",
            "GIT_SSL_NO_VERIFY",
            "GIT_SSL_CAINFO",
            "GIT_SSL_CAPATH",
            "GIT_SSL_CERT",
            "GIT_SSL_KEY",
            "GIT_SSL_CIPHER_LIST",
            "GIT_SSL_VERSION",
            "CURL_CA_BUNDLE",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "GIT_TEMPLATE_DIR",
            "GIT_EXEC_PATH",
            "GIT_TRACE",
            "GIT_TRACE2",
            "GIT_TRACE2_EVENT",
            "GIT_TRACE_PACKET",
            "GIT_TRACE_PACKFILE",
            "GIT_CURL_VERBOSE",
            "HOME",
            "XDG_CONFIG_HOME",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "PATHS",
        ];
        for name in refused {
            assert!(!is_inherited(name), "{name}");
        }
        let policy = ClonePolicy::new(resolver(&[("github.com", "140.82.112.3")]));
        let plan = plan(&policy, "https://github.com/owner/repo.git")
            .await
            .expect("a public host");
        for name in refused.iter().filter(|name| **name != "HOME") {
            // Never put back either: an exported empty GIT_SSL_NO_VERIFY still skips TLS checks.
            assert!(
                !plan.environment().iter().any(|(key, _)| key == *name),
                "{name} is set"
            );
        }
        assert!(
            plan.environment()
                .contains(&("HOME".into(), NULL_DEVICE.into()))
        );
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
