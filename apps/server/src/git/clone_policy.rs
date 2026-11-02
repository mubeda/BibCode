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
//! - **HTTPS, or SSH for an agent that may act as the server's user**, written plainly, so no
//!   host spelling can differ between this check and curl or ssh. An HTTPS URL carries no user
//!   information, so a credential never sits in tool arguments. `ssh://[user@]host[:port]/path`
//!   is admitted only for an agent that passes the Terminals gate (#217, option A1): it uses the
//!   person's SSH agent, which such an agent can already reach from a shell; every other agent
//!   gets `clone_ssh_not_allowed` naming the `https://` equivalent. The scp-like `host:path`,
//!   `git://`, `file://`, `ext::` and every other transport are refused.
//! - **Git's own rewrites first.** `git ls-remote --get-url` expands `url.<base>.insteadOf`
//!   without contacting the remote, reading the repository around the clone folder too. `git
//!   clone` reads no such repository, and the isolated environment removes every other rewrite
//!   source, so Git clones the URL as written: an HTTPS expansion must pass the same checks, and
//!   an SSH URL whose expansion differs from it is refused.
//! - **Resolved, checked, pinned.** Every address of each host must be public. For HTTPS,
//!   `http.curloptResolve` pins curl to the first of them; for SSH, `GIT_SSH_COMMAND` runs ssh
//!   with `HostName=<that address>` and `HostKeyAlias=<host>`, so the host key is still checked
//!   for the name, against the person's known_hosts, which BiBCode never writes. DNS cannot move
//!   the host after the check. Redirects are not followed, and `protocol.allow` admits the one
//!   transport, also through `GIT_ALLOW_PROTOCOL`, which a rewrite to `file:` or `ext::` meets
//!   too.
//! - **SSH isolated.** `-F none` reads no ssh configuration, only keys in the person's agent are
//!   offered (`IdentityFile=none`), forwarding, multiplexing and proxies are off, and
//!   `ConnectTimeout` with `ServerAlive*` end a silent server; the server's own
//!   `GIT_SSH_COMMAND`, `GIT_SSH` and `core.sshCommand` never apply.
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
    path::{Path, PathBuf},
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
/// An SSH clone from an agent that may not act as the server's user (#217, option A1).
pub(crate) const SSH_NOT_ALLOWED: &str = "clone_ssh_not_allowed";
/// An SSH clone this server cannot run for an agent: no SSH agent, a home folder ssh cannot
/// read, or an ssh without an option the clone needs.
pub(crate) const SSH_UNAVAILABLE: &str = "clone_ssh_unavailable";
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

const NOT_HTTPS: &str = "BiBCode clones for an agent from https:// URLs, such as https://github.com/owner/repo, and from ssh:// URLs when the agent may use terminals. git://, file://, local paths and other transports are refused; clone it in BiBCode yourself to use them.";
const NOT_PLAIN_SSH: &str = "Write the SSH URL plainly, as ssh://git@host/owner/repo or ssh://git@host:port/owner/repo: a user of letters, digits, '.', '_' or '-', no password, spaces, encoded characters or unusual spelling of the host.";
const SSH_PASSWORD: &str =
    "Remove the password from the URL. An agent's SSH clone uses the keys in your SSH agent.";
const REWRITTEN: &str = "A url.insteadOf rule in the repository around the clone folder rewrites this URL, and BiBCode clones the URL as written for an agent. Clone the rewritten URL instead.";
const HOME_UNREADABLE: &str = "Your home folder's path contains `${` or a control character, which ssh cannot read literally. Clone over https://.";
#[cfg(not(windows))]
const NO_AGENT: &str = "BiBCode found no SSH agent for this server (SSH_AUTH_SOCK is not set, or names no socket). Start ssh-agent and add your key with ssh-add, or clone over https://. A server started over SSH or in WSL sees an agent only when its own environment has one.";
#[cfg(windows)]
const NO_AGENT_ON_WINDOWS: &str = "BiBCode found no SSH agent for this server. Start the OpenSSH Authentication Agent service and add your key with ssh-add, or clone over https://.";
/// The forges whose `ssh://` URL has the same path over `https://`.
const FORGES: &[&str] = &["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];
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
    ssh: Option<SshHints>,
}

impl ClonePlan {
    pub(crate) fn arguments(&self) -> &[String] {
        &self.arguments
    }

    pub(crate) fn environment(&self) -> &[(OsString, OsString)] {
        &self.environment
    }

    /// What to do about a failed SSH clone whose Git error reads `detail`, matched on ssh's
    /// stable messages; `None` for an HTTPS plan or another failure.
    pub(crate) fn explain_failure(&self, detail: &str) -> Option<String> {
        self.ssh.as_ref()?.explain(detail)
    }

    /// The `reason` a failed clone's error carries: an ssh without an option the clone needs
    /// is `clone_ssh_unavailable`.
    pub(crate) fn failure_reason(&self, detail: &str) -> Option<&'static str> {
        (self.ssh.is_some() && detail.contains(BAD_OPTION)).then_some(SSH_UNAVAILABLE)
    }
}

const BAD_OPTION: &str = "Bad configuration option";

/// What an SSH clone's failure messages name: the plan's own values, so the printed command
/// checks and stores exactly the known_hosts entry the clone reads.
#[derive(Clone, Debug, Eq, PartialEq)]
struct SshHints {
    host: String,
    alias: String,
    port: u16,
    /// `user@host`, or `host` for a URL without a user.
    destination: String,
    /// The first known_hosts file the clone reads, with `/` on Windows.
    known_hosts: String,
}

impl SshHints {
    /// The command a person runs to trust the host's key, built from the plan's alias and
    /// port. `-F none` ignores their `Port`, `HostName`, `HostKeyAlias` and
    /// `UserKnownHostsFile`; the alias is quoted when it has brackets so zsh does not glob it.
    fn trust_command(&self) -> String {
        let alias = if self.alias.contains('[') {
            format!("'HostKeyAlias={}'", self.alias)
        } else {
            format!("HostKeyAlias={}", self.alias)
        };
        format!(
            "ssh -F none -p {} -o {alias} -T {}",
            self.port, self.destination
        )
    }

    fn unknown_key(&self) -> String {
        format!(
            "BiBCode checks the key of {} in {} (or known_hosts2) and never adds one for an agent. To trust it, run `{}` yourself, compare the fingerprint with the one {} publishes, answer yes, then retry.",
            self.alias,
            self.known_hosts,
            self.trust_command(),
            self.host
        )
    }

    fn explain(&self, detail: &str) -> Option<String> {
        if detail.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
            return Some(format!(
                "The server at the checked address does not have the key you trust for {}, so BiBCode stopped. Check the host before trusting a new key.",
                self.host
            ));
        }
        if let Some((_, rest)) = detail.split_once(BAD_OPTION) {
            let option = rest
                .trim_start_matches(':')
                .split_whitespace()
                .next()
                .unwrap_or("an option BiBCode needs");
            return Some(format!(
                "This server's ssh does not support {option}. Update OpenSSH, or clone over https://."
            ));
        }
        // ssh then falls back to a plain key for the alias, finds none, and fails as below.
        if self.port != 22 && detail.contains("name is not a listed principal") {
            return Some(format!(
                "{}\n{} presents a host certificate, which BiBCode can check only on port 22. Run the command above to trust its plain key for {}, or clone over https://.",
                self.unknown_key(),
                self.host,
                self.alias
            ));
        }
        if detail.contains("Host key verification failed") || detail.contains("host key is known") {
            return Some(self.unknown_key());
        }
        if detail.contains("Permission denied (publickey") {
            return Some(format!(
                "No key in your SSH agent is accepted by {}. Add one with ssh-add, or clone a public repository over https://.",
                self.host
            ));
        }
        None
    }
}

/// One host a clone contacts.
#[derive(Clone, Debug, Eq, PartialEq)]
struct Target {
    host: Host<String>,
    port: u16,
    /// The user of an `ssh://` URL (empty without one); `None` for HTTPS.
    ssh: Option<String>,
}

/// How long ssh waits: for the TCP connect and banner, and for a silent server at any point
/// after the connect (`ServerAliveInterval` x `ServerAliveCountMax`), key exchange and
/// authentication included.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SshTimeouts {
    pub(crate) connect: u32,
    pub(crate) alive_interval: u32,
    pub(crate) alive_count: u32,
}

/// 30 s to connect, and 60 s of silence (the HTTP low-speed guard's window).
pub(crate) const SSH_TIMEOUTS: SshTimeouts = SshTimeouts {
    connect: 30,
    alive_interval: 15,
    alive_count: 4,
};

/// The ssh an agent's SSH clone runs, and the person's agent and known_hosts it uses.
#[derive(Clone, Debug)]
pub(crate) struct SshClient {
    /// The program Git's shell runs.
    pub(crate) program: String,
    /// `SSH_AUTH_SOCK` for ssh, or `None` to leave the client on its default agent (Windows'
    /// OpenSSH Authentication Agent pipe).
    pub(crate) agent: Option<OsString>,
    /// The home folder whose `.ssh/known_hosts` holds the hosts the person trusts.
    pub(crate) home: PathBuf,
    pub(crate) timeouts: SshTimeouts,
}

/// The server's ssh and SSH agent. Linux and macOS: `ssh` with the server's `SSH_AUTH_SOCK`
/// when it names a socket. Windows: Git's bundled `ssh` when `SSH_AUTH_SOCK` is set (MSYS
/// agents, `ssh-pageant`), else the Windows OpenSSH client on its agent service's pipe, which
/// the bundled client cannot reach.
fn system_ssh_client() -> Result<SshClient, CloneRefusal> {
    let home = dirs::home_dir().ok_or_else(|| {
        CloneRefusal::new(
            SSH_UNAVAILABLE,
            "BiBCode could not find this server's home folder, which holds ssh's known_hosts. Clone over https://.",
        )
    })?;
    let socket = std::env::var_os("SSH_AUTH_SOCK").filter(|socket| !socket.is_empty());
    let client = |program: String, agent| SshClient {
        program,
        agent,
        home: home.clone(),
        timeouts: SSH_TIMEOUTS,
    };
    #[cfg(windows)]
    {
        if let Some(socket) = socket {
            return Ok(client("ssh".to_owned(), Some(socket)));
        }
        let program = std::env::var_os("SystemRoot")
            .map(|root| Path::new(&root).join(r"System32\OpenSSH\ssh.exe"));
        // Listing the pipe namespace finds the agent without connecting to it.
        let pipe = std::fs::read_dir(r"\\.\pipe\").is_ok_and(|entries| {
            entries
                .flatten()
                .any(|entry| entry.file_name() == "openssh-ssh-agent")
        });
        match program {
            Some(program) if pipe && program.is_file() => {
                Ok(client(program.to_string_lossy().replace('\\', "/"), None))
            }
            _ => Err(CloneRefusal::new(SSH_UNAVAILABLE, NO_AGENT_ON_WINDOWS)),
        }
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::FileTypeExt;
        match socket {
            Some(socket)
                if std::fs::metadata(&socket).is_ok_and(|meta| meta.file_type().is_socket()) =>
            {
                Ok(client("ssh".to_owned(), Some(socket)))
            }
            _ => Err(CloneRefusal::new(SSH_UNAVAILABLE, NO_AGENT)),
        }
    }
}

/// One word for Git's `sh -c`, which removes this layer.
fn shell_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// `path` as one OpenSSH option value: refused when ssh cannot read it literally (`${` has no
/// escape), `%` doubled for ssh's token expansion, then quoted for its `argv_split` (`\`, `"`
/// and `'` backslash-escaped inside `"`). Windows paths use `/`.
fn ssh_path(path: &Path) -> Result<String, CloneRefusal> {
    let unreadable = || CloneRefusal::new(SSH_UNAVAILABLE, HOME_UNREADABLE);
    let text = path.to_str().ok_or_else(unreadable)?;
    let text = if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.to_owned()
    };
    if text.contains("${") || text.chars().any(char::is_control) {
        return Err(unreadable());
    }
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        match character {
            '%' => quoted.push_str("%%"),
            '\\' | '"' | '\'' => {
                quoted.push('\\');
                quoted.push(character);
            }
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

/// The `HostKeyAlias` ssh looks the key up under: the host, or `[host]:port` off port 22,
/// as known_hosts files it.
fn host_key_alias(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

/// The `GIT_SSH_COMMAND` of an agent's SSH clone: ssh connects to `address` (so it resolves
/// nothing; Git's destination supplies only the user, and Git's `-p` the checked port) and
/// checks the key `alias` has in the person's known_hosts, never adding or rewriting one.
fn ssh_command(client: &SshClient, address: IpAddr, alias: &str) -> Result<String, CloneRefusal> {
    let ssh_folder = client.home.join(".ssh");
    let known_hosts = format!(
        "UserKnownHostsFile={} {}",
        ssh_path(&ssh_folder.join("known_hosts"))?,
        ssh_path(&ssh_folder.join("known_hosts2"))?
    );
    let timeouts = client.timeouts;
    let options = [
        format!("HostName={address}"),
        format!("HostKeyAlias={alias}"),
        "StrictHostKeyChecking=yes".to_owned(),
        "BatchMode=yes".to_owned(),
        "UpdateHostKeys=no".to_owned(),
        "CheckHostIP=no".to_owned(),
        known_hosts,
        "IdentityFile=none".to_owned(),
        // The variable the plan sets, so the socket's path never needs quoting.
        "IdentityAgent=SSH_AUTH_SOCK".to_owned(),
        "ProxyCommand=none".to_owned(),
        "ControlMaster=no".to_owned(),
        "ControlPath=none".to_owned(),
        "ForwardAgent=no".to_owned(),
        "ClearAllForwardings=yes".to_owned(),
        format!("ConnectTimeout={}", timeouts.connect),
        format!("ServerAliveInterval={}", timeouts.alive_interval),
        format!("ServerAliveCountMax={}", timeouts.alive_count),
    ];
    let mut words = vec![
        shell_quote(&client.program),
        shell_quote("-F"),
        shell_quote("none"),
    ];
    for option in &options {
        words.push(shell_quote("-o"));
        words.push(shell_quote(option));
    }
    Ok(words.join(" "))
}

/// The `ssh://` spelling of a scp-like `[user@]host:path` or a `git+ssh://` / `ssh+git://`
/// URL, when it has that simple form.
fn ssh_spelling(url: &str) -> Option<String> {
    for prefix in ["git+ssh://", "ssh+git://"] {
        if let Some(rest) = url.strip_prefix(prefix) {
            return Some(format!("ssh://{rest}"));
        }
    }
    if url.contains("://") {
        return None;
    }
    let (left, path) = url.split_once(':')?;
    let (user, host) = left
        .split_once('@')
        .map_or((None, left), |(user, host)| (Some(user), host));
    let plain = |text: &str, extra: &[char]| {
        !text.is_empty()
            && !text.starts_with('-')
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || extra.contains(&c))
    };
    // A one-letter host is a Windows drive; `ext::` and `<transport>::` start the path with `:`.
    let simple = host.len() > 1
        && plain(host, &[])
        && user.is_none_or(|user| plain(user, &['_']))
        && !path.is_empty()
        && !path.starts_with(':')
        && !path.chars().any(|c| c.is_whitespace() || c.is_control());
    simple.then(|| format!("ssh://{left}/{}", path.trim_start_matches('/')))
}

/// An `ssh://[user@]host[:port]/path` URL written plainly: what the URL parser writes for it
/// (case ignored), a plain user, no password, and a host that is an address or a DNS name
/// whose last label does not start with a digit (so no numeric IPv4 spelling).
fn ssh_target(url: &str) -> Result<Target, CloneRefusal> {
    let refuse = |message: &str| Err(CloneRefusal::new(URL_REFUSED, message));
    let Ok(parsed) = Url::parse(url) else {
        return refuse(NOT_PLAIN_SSH);
    };
    if parsed.password().is_some() {
        return refuse(SSH_PASSWORD);
    }
    let canonical = parsed.as_str();
    if !(canonical.eq_ignore_ascii_case(url) || canonical.eq_ignore_ascii_case(&format!("{url}/")))
    {
        return refuse(NOT_PLAIN_SSH);
    }
    let user = parsed.username();
    let plain_user = user.is_empty()
        || (!user.starts_with('-')
            && user
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')));
    let host = match parsed.host() {
        Some(Host::Ipv6(address)) => Host::Ipv6(address),
        Some(Host::Ipv4(address)) => Host::Ipv4(address),
        Some(Host::Domain(name)) => match name.parse::<Ipv4Addr>() {
            Ok(address) => Host::Ipv4(address),
            Err(_) if is_plain_name(name) => Host::Domain(name.to_ascii_lowercase()),
            Err(_) => return refuse(NOT_PLAIN_SSH),
        },
        None => return refuse(NOT_PLAIN_SSH),
    };
    let port = parsed.port().unwrap_or(22);
    if !plain_user || port == 0 {
        return refuse(NOT_PLAIN_SSH);
    }
    Ok(Target {
        host,
        port,
        ssh: Some(user.to_owned()),
    })
}

/// A DNS name of letters, digits, `-` and `.`, with no empty label, no leading `-`, and a last
/// label that does not start with a digit.
fn is_plain_name(name: &str) -> bool {
    !name.starts_with('-')
        && name.split('.').all(|label| {
            !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        && name
            .rsplit('.')
            .next()
            .is_some_and(|last| !last.starts_with(|c: char| c.is_ascii_digit()))
}

/// The refusal of an SSH clone from an agent that fails the Terminals gate, naming the
/// `https://` URL of the same repository on a known forge.
fn ssh_not_allowed(url: &str, target: &Target) -> CloneRefusal {
    let https = match &target.host {
        Host::Domain(name) if target.port == 22 && FORGES.contains(&name.as_str()) => {
            Url::parse(url)
                .ok()
                .map(|parsed| format!("https://{name}{}", parsed.path()))
        }
        _ => None,
    };
    let instead = https.unwrap_or_else(|| "the repository's https:// URL".to_owned());
    CloneRefusal::new(
        SSH_NOT_ALLOWED,
        format!(
            "Agent clones over SSH use your SSH keys, so BiBCode allows them only when Terminals is on, Agents may is at Full access and the agent was connected with terminals. Clone {instead} instead, or clone it in BiBCode yourself."
        ),
    )
}

/// The `-c` pairs of every agent clone: only `protocol` (and a fixture's) admitted, and no
/// redirect, LFS smudge, submodule, proxy, hook or fsmonitor. The `http.*` settings stay on an
/// SSH clone, where they are harmless.
fn isolated_arguments(protocol: &str, fixture_protocol: Option<&str>) -> Vec<String> {
    let hooks = format!("core.hooksPath={NULL_DEVICE}");
    ["protocol.allow=never", protocol]
        .into_iter()
        .chain(fixture_protocol)
        .chain([
            "http.followRedirects=false",
            "filter.lfs.smudge=",
            "filter.lfs.process=",
            "filter.lfs.required=false",
            // Never into submodules, whose hosts this policy has not checked.
            "submodule.recurse=false",
            // Above the isolated configuration, for a repository's own: no proxy (an empty
            // value also turns off the environment's), hook or fsmonitor.
            "http.proxy=",
            "core.fsmonitor=false",
            &hooks,
        ])
        .flat_map(|setting| ["-c".to_owned(), setting.to_owned()])
        .collect()
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
    if url.starts_with("ssh://") {
        return ssh_target(url);
    }
    if let Some(spelling) = ssh_spelling(url) {
        return refuse(&format!("Write the SSH URL as {spelling}."));
    }
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
        ssh: None,
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
/// which the isolation then overrides, with `admit_local`, a local fixture's `http://` and
/// loopback addresses, and with `ssh`, the ssh and agent an SSH clone uses in place of the
/// server's (a fake ssh, or a real one with short timeouts).
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FixtureAllowance {
    pub(crate) environment: Vec<(OsString, OsString)>,
    pub(crate) admit_local: bool,
    pub(crate) ssh: Option<SshClient>,
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

    fn ssh_client(&self) -> Result<SshClient, CloneRefusal> {
        #[cfg(test)]
        if let Some(client) = self
            .fixture
            .as_ref()
            .and_then(|fixture| fixture.ssh.clone())
        {
            return Ok(client);
        }
        system_ssh_client()
    }

    /// The isolated environment, admitting `protocols` (`GIT_ALLOW_PROTOCOL`).
    fn environment(&self, protocols: &str) -> Vec<(OsString, OsString)> {
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
    /// shape. `cwd` is the folder the clone runs in, whose repository's `url.insteadOf` rules
    /// `git ls-remote --get-url` reads (and `git clone` does not). `ssh_allowed` is whether
    /// the agent passes the Terminals gate, which an `ssh://` URL needs (#217, option A1).
    pub(crate) async fn plan(
        &self,
        repository: &GitRepository,
        url: &str,
        leaf: &CloneLeaf,
        cwd: &Path,
        ssh_allowed: bool,
        cancellation: &CancellationToken,
    ) -> Result<ClonePlan, Value> {
        let refused = |refusal: CloneRefusal| refusal.into_error(cwd);
        check_leaf(leaf).map_err(refused)?;
        let allow_http = self.admits_fixture();
        let original = target(url, allow_http).map_err(refused)?;
        if original.ssh.is_some() {
            if !ssh_allowed {
                return Err(refused(ssh_not_allowed(url, &original)));
            }
            return self
                .ssh_plan(repository, url, original, cwd, cancellation)
                .await;
        }
        let environment = self.environment(if allow_http { "https:http" } else { "https" });
        self.check_git_version(repository, cwd, &environment, cancellation)
            .await?;
        let expanded = repository
            .clone_remote_url(cwd, url, &environment, cancellation)
            .await
            .map_err(serialize)?;
        let expanded = target(&expanded, allow_http).map_err(refused)?;
        // `git clone` would not apply the rewrite anyway; an SSH one stays refused.
        if expanded.ssh.is_some() {
            return Err(refused(CloneRefusal::new(URL_REFUSED, REWRITTEN)));
        }

        let fixture_protocol = allow_http.then_some("protocol.http.allow=always");
        let mut arguments = isolated_arguments("protocol.https.allow=always", fixture_protocol);
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
            ssh: None,
        })
    }

    /// The plan of an `ssh://` clone from an agent that passes the gate: the written URL is
    /// the one `git clone` uses, so its host is checked and pinned, and an expansion that
    /// differs from it is refused rather than checked.
    async fn ssh_plan(
        &self,
        repository: &GitRepository,
        url: &str,
        target: Target,
        cwd: &Path,
        cancellation: &CancellationToken,
    ) -> Result<ClonePlan, Value> {
        let refused = |refusal: CloneRefusal| refusal.into_error(cwd);
        let mut environment = self.environment("ssh");
        self.check_git_version(repository, cwd, &environment, cancellation)
            .await?;
        let expanded = repository
            .clone_remote_url(cwd, url, &environment, cancellation)
            .await
            .map_err(serialize)?;
        if expanded != url {
            return Err(refused(CloneRefusal::new(URL_REFUSED, REWRITTEN)));
        }
        let addresses = self
            .addresses(&target, cancellation)
            .await
            .map_err(refused)?;
        let client = self.ssh_client().map_err(refused)?;
        let host = match &target.host {
            Host::Domain(name) => name.clone(),
            Host::Ipv4(address) => address.to_string(),
            Host::Ipv6(address) => address.to_string(),
        };
        let alias = host_key_alias(&host, target.port);
        let command = ssh_command(&client, addresses[0], &alias).map_err(refused)?;
        let user = target.ssh.unwrap_or_default();
        let known_hosts = client.home.join(".ssh").join("known_hosts");
        let known_hosts = known_hosts.to_string_lossy();
        let hints = SshHints {
            destination: if user.is_empty() {
                host.clone()
            } else {
                format!("{user}@{host}")
            },
            known_hosts: if cfg!(windows) {
                known_hosts.replace('\\', "/")
            } else {
                known_hosts.into_owned()
            },
            host,
            alias,
            port: target.port,
        };
        // The highest-precedence source, above a repository's `core.sshCommand`.
        environment.push(("GIT_SSH_COMMAND".into(), command.into()));
        environment.push(("GIT_SSH_VARIANT".into(), "ssh".into()));
        if let Some(agent) = client.agent {
            environment.push(("SSH_AUTH_SOCK".into(), agent));
        }
        Ok(ClonePlan {
            arguments: isolated_arguments("protocol.ssh.allow=always", None),
            environment,
            ssh: Some(hints),
        })
    }

    /// Refuses a Git older than `http.curloptResolve`, the floor of every agent clone.
    async fn check_git_version(
        &self,
        repository: &GitRepository,
        cwd: &Path,
        environment: &[(OsString, OsString)],
        cancellation: &CancellationToken,
    ) -> Result<(), Value> {
        let version = repository
            .clone_git_version(cwd, environment, cancellation)
            .await
            .map_err(serialize)?;
        if version.is_none_or(|version| version < CURLOPT_RESOLVE) {
            let found = version.map_or_else(|| "an unknown version".to_owned(), |v| v.to_string());
            return Err(CloneRefusal::new(
                GIT_TOO_OLD,
                format!(
                    "Cloning for an agent needs Git {CURLOPT_RESOLVE} or later, and this server has {found}. Update Git, or clone it in BiBCode yourself."
                ),
            )
            .into_error(cwd));
        }
        Ok(())
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
        plan_as(policy, url, false).await
    }

    /// [`plan`] for an agent that passes the Terminals gate when `ssh_allowed`.
    async fn plan_as(
        policy: &ClonePolicy,
        url: &str,
        ssh_allowed: bool,
    ) -> Result<ClonePlan, Value> {
        let cwd = tempfile::tempdir().expect("cwd");
        policy
            .plan(
                &GitRepository::default(),
                url,
                &leaf("repo"),
                cwd.path(),
                ssh_allowed,
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
        // Every transport but HTTPS and SSH refused for being one: written without a user, so
        // no other rule refuses them first.
        for url in [
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

    /// An SSH plan's policy: `entries` resolve, and the ssh is `ssh` with an agent socket and
    /// `home`, in place of the server's.
    fn ssh_policy(entries: &[(&str, &str)], home: &Path) -> ClonePolicy {
        ClonePolicy::admitting_fixture(
            resolver(entries),
            FixtureAllowance {
                ssh: Some(SshClient {
                    program: "ssh".to_owned(),
                    agent: Some("/run/agent.sock".into()),
                    home: home.to_path_buf(),
                    timeouts: SSH_TIMEOUTS,
                }),
                ..FixtureAllowance::default()
            },
        )
    }

    fn env_value(plan: &ClonePlan, name: &str) -> Option<String> {
        plan.environment()
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.to_string_lossy().into_owned())
    }

    fn settings(plan: &ClonePlan) -> Vec<&str> {
        plan.arguments()
            .chunks(2)
            .map(|pair| {
                assert_eq!(pair[0], "-c");
                pair[1].as_str()
            })
            .collect()
    }

    /// A home folder with a space, `'` and `%` (and, where a file name may hold them, `"` and
    /// `\`) under a folder with spaces.
    fn awkward_home(root: &Path) -> PathBuf {
        let name = if cfg!(windows) {
            "Pat O'Neil 100%"
        } else {
            "Pat O'Neil 100% \"q\" \\b"
        };
        root.join("folder with spaces").join(name)
    }

    /// `home`'s known_hosts file `name` as ssh prints it: `/` on Windows.
    fn printed(home: &Path, name: &str) -> String {
        let path = home.join(".ssh").join(name).to_string_lossy().into_owned();
        if cfg!(windows) {
            path.replace('\\', "/")
        } else {
            path
        }
    }

    #[test]
    fn ssh_urls_are_admitted_written_plainly_and_other_ssh_spellings_name_the_ssh_form() {
        for (url, host, port, user) in [
            (
                "ssh://git@github.com/owner/repo.git",
                "github.com",
                22,
                "git",
            ),
            ("ssh://github.com/owner/repo.git", "github.com", 22, ""),
            (
                "ssh://git@GitHub.com/owner/repo.git",
                "github.com",
                22,
                "git",
            ),
            (
                "ssh://git@git.example.com:2222/owner/repo.git",
                "git.example.com",
                2222,
                "git",
            ),
            (
                "ssh://deploy.bot_1@git.example.com/r.git",
                "git.example.com",
                22,
                "deploy.bot_1",
            ),
        ] {
            let target = target(url, false).expect(url);
            assert_eq!(target.host, Host::Domain(host.to_owned()), "{url}");
            assert_eq!(target.port, port, "{url}");
            assert_eq!(target.ssh.as_deref(), Some(user), "{url}");
        }
        let v6 = target("ssh://git@[2606:4700::1111]/owner/repo", false).expect("IPv6");
        assert_eq!(
            v6.host,
            Host::<String>::Ipv6("2606:4700::1111".parse().unwrap())
        );
        let v4 = target("ssh://git@140.82.112.3/owner/repo", false).expect("IPv4");
        assert_eq!(
            v4.host,
            Host::<String>::Ipv4("140.82.112.3".parse().unwrap())
        );
        for url in [
            "ssh://-oProxyCommand=x@github.com/owner/repo",
            "ssh://git@-github.com/owner/repo",
            "ssh://git@2130706433/owner/repo",
            "ssh://git@0x7f.1/owner/repo",
            "ssh://git@git%68ub.com/owner/repo",
            "ssh://git@gïthub.com/owner/repo",
            "ssh://git@github.com./owner/repo",
            "ssh://git@github..com/owner/repo",
            "ssh://git@github.com:0/owner/repo",
            "ssh://git@github.com/owner/re po",
            "ssh://g%69t@github.com/owner/repo",
            "ssh://git@/owner/repo",
        ] {
            let refusal = target(url, false).expect_err(url);
            assert_eq!(refusal.reason, URL_REFUSED, "{url}");
            assert_eq!(refusal.message, NOT_PLAIN_SSH, "{url}");
        }
        let password = target("ssh://git:secret@github.com/owner/repo", false).expect_err("pw");
        assert_eq!(password.message, SSH_PASSWORD);
        for (url, spelling) in [
            (
                "git@github.com:owner/repo.git",
                "ssh://git@github.com/owner/repo.git",
            ),
            ("github.com:owner/repo", "ssh://github.com/owner/repo"),
            (
                "git@git.example.com:/srv/r.git",
                "ssh://git@git.example.com/srv/r.git",
            ),
            (
                "git+ssh://git@github.com/owner/repo.git",
                "ssh://git@github.com/owner/repo.git",
            ),
            (
                "ssh+git://git@github.com/owner/repo.git",
                "ssh://git@github.com/owner/repo.git",
            ),
        ] {
            let refusal = target(url, false).expect_err(url);
            assert_eq!(refusal.reason, URL_REFUSED, "{url}");
            assert_eq!(
                refusal.message,
                format!("Write the SSH URL as {spelling}."),
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn an_ssh_clone_from_an_agent_without_the_terminals_gate_names_the_https_url() {
        // Refused before anything resolves: the resolver knows no name.
        let policy = ClonePolicy::new(resolver(&[]));
        for (url, instead) in [
            (
                "ssh://git@github.com/owner/repo.git",
                "https://github.com/owner/repo.git",
            ),
            (
                "ssh://git@gitlab.com/group/repo",
                "https://gitlab.com/group/repo",
            ),
            (
                "ssh://git@bitbucket.org/team/repo.git",
                "https://bitbucket.org/team/repo.git",
            ),
            (
                "ssh://git@codeberg.org/owner/repo.git",
                "https://codeberg.org/owner/repo.git",
            ),
            // Another port or host has no known https:// form.
            (
                "ssh://git@github.com:2222/owner/repo.git",
                "the repository's https:// URL",
            ),
            (
                "ssh://git@git.example.com/owner/repo.git",
                "the repository's https:// URL",
            ),
        ] {
            let error = plan(&policy, url).await.expect_err(url);
            assert_eq!(reason(&error), SSH_NOT_ALLOWED, "{url}");
            assert_eq!(
                error["detail"],
                format!(
                    "Agent clones over SSH use your SSH keys, so BiBCode allows them only when Terminals is on, Agents may is at Full access and the agent was connected with terminals. Clone {instead} instead, or clone it in BiBCode yourself."
                ),
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn an_ssh_clone_is_pinned_to_its_first_checked_address_under_the_hosts_alias() {
        let home = tempfile::tempdir().unwrap();
        let policy = ssh_policy(
            &[
                ("github.com", "140.82.112.3"),
                ("github.com", "140.82.112.4"),
                ("git.example.com", "140.82.112.5"),
                ("v6.example.com", "2606:4700::1111"),
                ("mixed.example.com", "140.82.112.3"),
                ("mixed.example.com", "10.0.0.7"),
            ],
            home.path(),
        );
        let plan = plan_as(&policy, "ssh://git@github.com/owner/repo.git", true)
            .await
            .expect("a public host");
        let command = env_value(&plan, "GIT_SSH_COMMAND").expect("GIT_SSH_COMMAND");
        let known_hosts = ssh_path(&home.path().join(".ssh").join("known_hosts")).unwrap();
        let known_hosts2 = ssh_path(&home.path().join(".ssh").join("known_hosts2")).unwrap();
        let expected = [
            "ssh",
            "-F",
            "none",
            "-o",
            "HostName=140.82.112.3",
            "-o",
            "HostKeyAlias=github.com",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "UpdateHostKeys=no",
            "-o",
            "CheckHostIP=no",
            "-o",
            &format!("UserKnownHostsFile={known_hosts} {known_hosts2}"),
            "-o",
            "IdentityFile=none",
            "-o",
            "IdentityAgent=SSH_AUTH_SOCK",
            "-o",
            "ProxyCommand=none",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ConnectTimeout=30",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=4",
        ]
        .map(shell_quote)
        .join(" ");
        assert_eq!(command, expected);
        assert_eq!(env_value(&plan, "GIT_SSH_VARIANT").as_deref(), Some("ssh"));
        assert_eq!(
            env_value(&plan, "GIT_ALLOW_PROTOCOL").as_deref(),
            Some("ssh")
        );
        assert_eq!(
            env_value(&plan, "SSH_AUTH_SOCK").as_deref(),
            Some("/run/agent.sock")
        );
        assert_eq!(env_value(&plan, "HOME").as_deref(), Some(NULL_DEVICE));
        let settings = settings(&plan);
        for expected in [
            "protocol.allow=never",
            "protocol.ssh.allow=always",
            "submodule.recurse=false",
            "filter.lfs.smudge=",
            "core.fsmonitor=false",
            &format!("core.hooksPath={NULL_DEVICE}"),
        ] {
            assert!(settings.contains(&expected), "{expected} in {settings:?}");
        }
        assert!(!settings.contains(&"protocol.https.allow=always"));
        assert!(
            !settings
                .iter()
                .any(|setting| setting.contains("curloptResolve"))
        );

        let port = plan_as(
            &policy,
            "ssh://git@git.example.com:2222/owner/repo.git",
            true,
        )
        .await
        .expect("another port");
        let command = env_value(&port, "GIT_SSH_COMMAND").unwrap();
        assert!(command.contains("'HostName=140.82.112.5'"), "{command}");
        assert!(
            command.contains("'HostKeyAlias=[git.example.com]:2222'"),
            "{command}"
        );
        // Git's `-p` carries the checked port: the command sets none.
        assert!(!command.contains("Port="), "{command}");

        let v6 = plan_as(&policy, "ssh://git@v6.example.com/owner/repo.git", true)
            .await
            .expect("IPv6");
        let command = env_value(&v6, "GIT_SSH_COMMAND").unwrap();
        assert!(command.contains("'HostName=2606:4700::1111'"), "{command}");

        for url in [
            "ssh://git@mixed.example.com/owner/repo.git",
            "ssh://git@127.0.0.1/owner/repo.git",
            "ssh://git@[::1]/owner/repo.git",
        ] {
            let error = plan_as(&policy, url, true).await.expect_err(url);
            assert_eq!(reason(&error), HOST_REFUSED, "{url}");
        }
        let error = plan_as(&policy, "ssh://git@unknown.example.com/r.git", true)
            .await
            .expect_err("unresolved");
        assert_eq!(reason(&error), HOST_UNRESOLVED);
    }

    #[test]
    fn production_ssh_timeouts_bound_the_connect_and_a_minute_of_silence() {
        assert_eq!(
            SSH_TIMEOUTS,
            SshTimeouts {
                connect: 30,
                alive_interval: 15,
                alive_count: 4,
            }
        );
    }

    #[tokio::test]
    async fn without_an_agent_socket_ssh_keeps_its_default_agent() {
        let home = tempfile::tempdir().unwrap();
        let policy = ClonePolicy::admitting_fixture(
            resolver(&[("github.com", "140.82.112.3")]),
            FixtureAllowance {
                ssh: Some(SshClient {
                    program: "C:/Windows/System32/OpenSSH/ssh.exe".to_owned(),
                    agent: None,
                    home: home.path().to_path_buf(),
                    timeouts: SSH_TIMEOUTS,
                }),
                ..FixtureAllowance::default()
            },
        );
        let plan = plan_as(&policy, "ssh://git@github.com/owner/repo.git", true)
            .await
            .expect("a plan");
        assert_eq!(env_value(&plan, "SSH_AUTH_SOCK"), None);
        let command = env_value(&plan, "GIT_SSH_COMMAND").unwrap();
        assert!(
            command.starts_with("'C:/Windows/System32/OpenSSH/ssh.exe' '-F' 'none'"),
            "{command}"
        );
    }

    #[test]
    fn known_hosts_paths_are_escaped_for_ssh_then_for_the_shell() {
        let home = awkward_home(Path::new(if cfg!(windows) { r"C:\Users" } else { "/home" }));
        let quoted = ssh_path(&home.join(".ssh").join("known_hosts")).unwrap();
        let expected = if cfg!(windows) {
            r#""C:/Users/folder with spaces/Pat O\'Neil 100%%/.ssh/known_hosts""#
        } else {
            r#""/home/folder with spaces/Pat O\'Neil 100%% \"q\" \\b/.ssh/known_hosts""#
        };
        assert_eq!(quoted, expected);
        assert_eq!(shell_quote("a'b c"), r"'a'\''b c'");
        for unreadable in ["/home/${USER}", "/home/pat\nx", "/home/pat\u{7f}"] {
            let refusal = ssh_path(Path::new(unreadable)).expect_err(unreadable);
            assert_eq!(refusal.reason, SSH_UNAVAILABLE, "{unreadable:?}");
            assert_eq!(refusal.message, HOME_UNREADABLE);
        }
    }

    #[tokio::test]
    async fn a_home_ssh_cannot_read_literally_is_refused_before_ssh_runs() {
        let root = tempfile::tempdir().unwrap();
        let policy = ssh_policy(
            &[("github.com", "140.82.112.3")],
            &root.path().join("${HOME}"),
        );
        let error = plan_as(&policy, "ssh://git@github.com/owner/repo.git", true)
            .await
            .expect_err("unreadable home");
        assert_eq!(reason(&error), SSH_UNAVAILABLE);
        assert_eq!(error["detail"], HOME_UNREADABLE);
    }

    #[tokio::test]
    async fn ssh_failures_name_the_plans_alias_port_and_known_hosts_file() {
        let root = tempfile::tempdir().unwrap();
        let home = awkward_home(root.path());
        let policy = ssh_policy(&[("git.example.com", "140.82.112.5")], &home);
        let known_hosts = printed(&home, "known_hosts");
        let on_22 = plan_as(&policy, "ssh://git@git.example.com/owner/repo.git", true)
            .await
            .expect("port 22");
        let unknown = on_22
            .explain_failure("No ED25519 host key is known for git.example.com and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.")
            .expect("advice");
        assert_eq!(
            unknown,
            format!(
                "BiBCode checks the key of git.example.com in {known_hosts} (or known_hosts2) and never adds one for an agent. To trust it, run `ssh -F none -p 22 -o HostKeyAlias=git.example.com -T git@git.example.com` yourself, compare the fingerprint with the one git.example.com publishes, answer yes, then retry."
            )
        );
        // A certificate is checked under the hostname on port 22: no certificate advice.
        let certificate =
            "Certificate invalid: name is not a listed principal\nHost key verification failed.";
        assert_eq!(
            on_22.explain_failure(certificate).as_deref(),
            Some(unknown.as_str())
        );

        let on_2222 = plan_as(
            &policy,
            "ssh://git@git.example.com:2222/owner/repo.git",
            true,
        )
        .await
        .expect("port 2222");
        let unknown = on_2222
            .explain_failure("Host key verification failed.")
            .expect("advice");
        assert_eq!(
            unknown,
            format!(
                "BiBCode checks the key of [git.example.com]:2222 in {known_hosts} (or known_hosts2) and never adds one for an agent. To trust it, run `ssh -F none -p 2222 -o 'HostKeyAlias=[git.example.com]:2222' -T git@git.example.com` yourself, compare the fingerprint with the one git.example.com publishes, answer yes, then retry."
            )
        );
        assert_eq!(
            on_2222.explain_failure(certificate),
            Some(format!(
                "{unknown}\ngit.example.com presents a host certificate, which BiBCode can check only on port 22. Run the command above to trust its plain key for [git.example.com]:2222, or clone over https://."
            ))
        );
        assert_eq!(
            on_22.explain_failure("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.").as_deref(),
            Some("The server at the checked address does not have the key you trust for git.example.com, so BiBCode stopped. Check the host before trusting a new key.")
        );
        assert_eq!(
            on_22
                .explain_failure("git@140.82.112.5: Permission denied (publickey).")
                .as_deref(),
            Some(
                "No key in your SSH agent is accepted by git.example.com. Add one with ssh-add, or clone a public repository over https://."
            )
        );
        let old = "command-line: line 0: Bad configuration option: updatehostkeys";
        assert_eq!(
            on_22.explain_failure(old).as_deref(),
            Some(
                "This server's ssh does not support updatehostkeys. Update OpenSSH, or clone over https://."
            )
        );
        assert_eq!(on_22.failure_reason(old), Some(SSH_UNAVAILABLE));
        assert_eq!(on_22.failure_reason("Host key verification failed."), None);
        assert_eq!(on_22.explain_failure("fatal: repository not found"), None);

        // A URL without a user, and an HTTPS plan, which explains nothing.
        let anonymous = plan_as(&policy, "ssh://git.example.com/owner/repo.git", true)
            .await
            .expect("no user");
        assert!(
            anonymous
                .explain_failure("Host key verification failed.")
                .unwrap()
                .contains("-T git.example.com` yourself")
        );
        let https = ClonePolicy::new(resolver(&[("github.com", "140.82.112.3")]));
        let https = plan(&https, "https://github.com/owner/repo.git")
            .await
            .unwrap();
        assert_eq!(https.explain_failure("Host key verification failed."), None);
        assert_eq!(https.failure_reason(old), None);
    }

    /// Runs `command` through the shell Git runs `GIT_SSH_COMMAND` with: a `!` alias, which
    /// Git runs as `sh -c '<command> "$@"'` with its own `sh` and `PATH` (on Windows, the
    /// bundled `/usr/bin` first, so a plain `ssh` is the client Git uses). `HOME` is `home`.
    pub(crate) fn through_git_shell(command: &str, home: &Path) -> std::process::Output {
        let cwd = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .arg("-c")
            .arg(format!("alias.bibcodesshtest=!{command}"))
            .arg("bibcodesshtest")
            .current_dir(cwd.path())
            .env("HOME", home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
            .output()
            .expect("git starts")
    }

    /// The ssh clients an agent's SSH clone may run here: Git's `ssh`, and on Windows the
    /// system OpenSSH client. Empty, with a note, where neither runs.
    pub(crate) fn real_ssh_clients() -> Vec<String> {
        let home = tempfile::tempdir().unwrap();
        let mut clients = Vec::new();
        if through_git_shell("ssh -V", home.path()).status.success() {
            clients.push("ssh".to_owned());
        }
        if cfg!(windows)
            && let Some(root) = std::env::var_os("SystemRoot")
        {
            let windows = Path::new(&root).join(r"System32\OpenSSH\ssh.exe");
            if windows.is_file() {
                clients.push(windows.to_string_lossy().replace('\\', "/"));
            }
        }
        if clients.is_empty() {
            eprintln!("no ssh client runs here; skipping the real-client checks");
        }
        clients
    }

    /// What `ssh -G` prints for `command` with `-G` and `arguments` appended, run as Git
    /// runs it.
    fn ssh_config(command: &str, arguments: &str, home: &Path) -> (bool, String) {
        let full = if arguments.is_empty() {
            command.to_owned()
        } else {
            format!("{command} -G {arguments}")
        };
        let output = through_git_shell(&full, home);
        let printed = String::from_utf8_lossy(&output.stdout).into_owned()
            + &String::from_utf8_lossy(&output.stderr);
        (output.status.success(), printed)
    }

    #[test]
    fn real_ssh_reads_the_generated_command_as_bibcode_means_it() {
        let root = tempfile::tempdir().unwrap();
        let home = awkward_home(root.path());
        // A person's configuration that `-F none` must keep out, under `HOME` (what MSYS ssh
        // reads) and as an explicit file (what the swapped `-F` reads).
        let config_folder = root.path().join("config");
        std::fs::create_dir_all(&config_folder).unwrap();
        let extra = config_folder.join("extra");
        std::fs::write(&extra, "Compression yes\n").unwrap();
        let config = config_folder.join("config");
        let forward = |path: &Path| path.to_string_lossy().replace('\\', "/");
        let config_text = format!(
            "PermitLocalCommand yes\nLocalCommand touch /tmp/bibcode-local-command\nProxyCommand /bin/false\nInclude {}\n",
            forward(&extra)
        );
        std::fs::write(&config, &config_text).unwrap();
        let ssh_home = root.path().join("ssh-home");
        std::fs::create_dir_all(ssh_home.join(".ssh")).unwrap();
        std::fs::write(ssh_home.join(".ssh/config"), &config_text).unwrap();

        for program in real_ssh_clients() {
            let client = SshClient {
                program: program.clone(),
                agent: None,
                home: home.clone(),
                timeouts: SSH_TIMEOUTS,
            };
            let address: IpAddr = "140.82.112.3".parse().unwrap();
            let alias = host_key_alias("git.example", 2222);
            let command = ssh_command(&client, address, &alias).unwrap();
            let (ok, output) = ssh_config(&command, "-p 2222 git@git.example", &ssh_home);
            assert!(ok, "{program}: {output}");
            let lines = output.lines().collect::<Vec<_>>();
            for expected in [
                "hostname 140.82.112.3",
                "hostkeyalias [git.example]:2222",
                "port 2222",
                "user git",
                "stricthostkeychecking true",
                "batchmode yes",
                "identityagent SSH_AUTH_SOCK",
                "permitlocalcommand no",
                "compression no",
                &format!(
                    "userknownhostsfile {} {}",
                    printed(&home, "known_hosts"),
                    printed(&home, "known_hosts2")
                ),
            ] {
                assert!(
                    lines.contains(&expected),
                    "{program}: {expected} in {output}"
                );
            }
            for absent in ["proxycommand", "controlpath", "localcommand"] {
                assert!(
                    !lines.iter().any(|line| line.starts_with(absent)),
                    "{program}: {absent} in {output}"
                );
            }
            // The same command reading a configuration file shows what `-F none` keeps out.
            let swapped = command.replacen("'none'", &shell_quote(&forward(&config)), 1);
            let (ok, output) = ssh_config(&swapped, "-p 2222 git@git.example", &ssh_home);
            assert!(ok, "{program}: {output}");
            assert!(
                output.lines().any(|line| line == "permitlocalcommand yes"),
                "{program}: {output}"
            );
            if cfg!(unix) {
                assert!(
                    output.lines().any(|line| line == "compression yes"),
                    "{program}: the Include was read: {output}"
                );
            }

            // Without either escaping layer, ssh does not read the paths literally.
            let files = |quote: &dyn Fn(&Path) -> String| {
                format!(
                    "UserKnownHostsFile={} {}",
                    quote(&home.join(".ssh").join("known_hosts")),
                    quote(&home.join(".ssh").join("known_hosts2"))
                )
            };
            let literal = format!(
                "userknownhostsfile {} {}",
                printed(&home, "known_hosts"),
                printed(&home, "known_hosts2")
            );
            let without_ssh_layer = format!(
                "{} {}",
                shell_quote(&program),
                shell_quote(&format!("-o{}", files(&forward)))
            );
            let without_shell_layer = format!(
                "{} -o{}",
                shell_quote(&program),
                files(&|path| ssh_path(path).unwrap())
            );
            for broken in [without_ssh_layer, without_shell_layer] {
                let (ok, output) = ssh_config(&broken, "-p 2222 git@git.example", &ssh_home);
                assert!(
                    !ok || !output.lines().any(|line| line == literal),
                    "{program}: {broken} still read the paths: {output}"
                );
            }
        }
    }

    #[tokio::test]
    async fn the_printed_trust_command_checks_the_plans_alias_and_port() {
        let root = tempfile::tempdir().unwrap();
        let home = awkward_home(root.path());
        let policy = ssh_policy(&[("git.example.com", "140.82.112.5")], &home);
        for (url, alias, port) in [
            (
                "ssh://git@git.example.com/owner/repo.git",
                "git.example.com",
                "22",
            ),
            (
                "ssh://git@git.example.com:2222/owner/repo.git",
                "[git.example.com]:2222",
                "2222",
            ),
        ] {
            let plan = plan_as(&policy, url, true).await.expect(url);
            let trust = plan.ssh.as_ref().expect("hints").trust_command();
            assert!(trust.starts_with("ssh -F none "), "{trust}");
            if !real_ssh_clients().iter().any(|client| client == "ssh") {
                return;
            }
            // `-G` before the destination, after which ssh reads a remote command.
            let check = trust.replacen("ssh -F", "ssh -G -F", 1);
            let (ok, printed) = ssh_config(&check, "", root.path());
            assert!(ok, "{trust}: {printed}");
            let lines = printed.lines().collect::<Vec<_>>();
            assert!(
                lines.contains(&format!("hostkeyalias {alias}").as_str()),
                "{printed}"
            );
            assert!(
                lines.contains(&format!("port {port}").as_str()),
                "{printed}"
            );
        }
    }
}
