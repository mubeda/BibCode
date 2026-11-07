//! The one system-configuration policy for every Git command BiBCode runs (#282, #283).
//!
//! `GIT_CONFIG_NOSYSTEM=1` also dropped what makes BiBCode's Git produce the same files as
//! the person's Git, such as Git for Windows' system `core.autocrlf=true` and its LFS filter,
//! and what lets a fetch authenticate as theirs does. Once per process, [`install_once`]
//! reads a fixed set of keys from the system configuration: line endings, `core.symlinks`,
//! `core.fscache`, `core.longpaths`, a recognized git-lfs filter group, well-known
//! credential-helper names, `http.sslBackend` and `http.sslCAInfo`. It writes their canonical
//! values to a file under the server's state directory, and Git runs with
//! `GIT_CONFIG_SYSTEM=<that file>`, so repository and global values still win. Hooks,
//! includes, other filters, drivers and URL rules never get in.
//!
//! With no kept key, Git runs with `GIT_CONFIG_NOSYSTEM=1`. When the system configuration
//! could not be read, or holds an LFS group BiBCode does not recognize, the policy is
//! [`Policy::Unread`]: [`super::git_environment`] still drops the system file, and
//! checkpoints inherit it ([`super::git_environment_inheriting_unread`]), as they always did.

use std::{
    ffi::{OsStr, OsString},
    io::Write as _,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, PoisonError},
    time::{Duration, Instant},
};

use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;

use super::{
    GitVersion, OutputPolicy, ProcessError, ProcessRequest, ProcessRunner,
    repository::{git_boolean, prompt_guard_environment},
};

/// The whole probe, both Git commands included.
const PROBE_BUDGET: Duration = Duration::from_secs(2);
/// Older Git ignores `GIT_CONFIG_SYSTEM` and would read the whole system file.
const MINIMUM_GIT: GitVersion = GitVersion {
    major: 2,
    minor: 32,
    patch: 0,
};
const KEYS_PATTERN: &str = r"^(core\.(autocrlf|eol|safecrlf|symlinks|fscache|longpaths)|filter\.lfs\.(clean|smudge|process|required)|credential\.helper|http\.(sslbackend|sslcainfo))$";
/// In the order the generated file writes them.
const CORE_KEYS: [&str; 6] = [
    "core.autocrlf",
    "core.eol",
    "core.safecrlf",
    "core.symlinks",
    "core.fscache",
    "core.longpaths",
];
/// The values `git lfs install` writes, with and without `--skip`, and the legacy ones.
const LFS_CLEAN: [&str; 2] = ["git-lfs clean -- %f", "git-lfs clean %f"];
const LFS_SMUDGE: [&str; 3] = [
    "git-lfs smudge -- %f",
    "git-lfs smudge --skip -- %f",
    "git-lfs smudge %f",
];
const LFS_PROCESS: [&str; 2] = ["git-lfs filter-process", "git-lfs filter-process --skip"];
/// Names Git resolves to its own `git-credential-<name>` executables.
const CREDENTIAL_HELPERS: [&str; 6] = [
    "manager",
    "manager-core",
    "osxkeychain",
    "wincred",
    "cache",
    "store",
];
const SSL_BACKENDS: [&str; 4] = ["openssl", "schannel", "gnutls", "secure-transport"];
const UNRECOGNIZED_LFS: &str =
    "an unrecognized system LFS filter kept the system configuration unread";

/// Which system configuration BiBCode's Git reads.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Policy {
    /// `GIT_CONFIG_NOSYSTEM=1`: the system configuration holds nothing to keep.
    NoSystem,
    /// `GIT_CONFIG_SYSTEM=<file>`: the generated file holding only the kept keys.
    KeysOnly(PathBuf),
    /// Not installed, or the system configuration could not be read or holds an LFS filter
    /// BiBCode does not recognize: `GIT_CONFIG_NOSYSTEM=1`, and checkpoints inherit it.
    Unread,
}

static POLICY: OnceLock<Policy> = OnceLock::new();
/// Warnings from [`install_once`], which runs before the server installs logging; the
/// server logs them once logging starts ([`log_install_warnings`]).
static INSTALL_WARNINGS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

/// Probes the system configuration and fixes the policy for the rest of the process. Only
/// the two binaries call it, before the server starts. Later calls, an in-process desktop
/// backend restart among them, return the first result: the settings are read once per
/// process.
pub async fn install_once(state_dir: &Path) -> &'static Policy {
    if let Some(policy) = POLICY.get() {
        return policy;
    }
    let (policy, warnings) = probe_with_warnings(state_dir, &[]).await;
    INSTALL_WARNINGS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .extend(warnings);
    POLICY.get_or_init(|| policy)
}

/// Logs what [`install_once`] could not, once: the server calls it right after logging starts.
pub(crate) fn log_install_warnings() {
    let warnings = std::mem::take(
        &mut *INSTALL_WARNINGS
            .lock()
            .unwrap_or_else(PoisonError::into_inner),
    );
    warnings.into_iter().for_each(warn);
}

/// The variable [`super::git_environment`] passes; `GIT_CONFIG_NOSYSTEM=1` until installed.
pub(crate) fn system_config_variable() -> (OsString, OsString) {
    config_variable(POLICY.get(), false).unwrap_or_else(no_system)
}

/// The variable [`super::git_environment_inheriting_unread`] passes: none while `Unread`.
pub(crate) fn inheriting_system_config_variable() -> Option<(OsString, OsString)> {
    config_variable(POLICY.get(), true)
}

fn config_variable(policy: Option<&Policy>, inherit_unread: bool) -> Option<(OsString, OsString)> {
    match policy.unwrap_or(&Policy::Unread) {
        Policy::KeysOnly(path) => Some(("GIT_CONFIG_SYSTEM".into(), path.clone().into())),
        Policy::Unread if inherit_unread => None,
        Policy::NoSystem | Policy::Unread => Some(no_system()),
    }
}

fn no_system() -> (OsString, OsString) {
    ("GIT_CONFIG_NOSYSTEM".into(), "1".into())
}

/// What [`install_once`] would install, without installing it. `environment` is added to
/// the inherited one, as production Git's is; the probe honours its `GIT_CONFIG_SYSTEM`.
pub async fn probe(state_dir: &Path, environment: &[(OsString, OsString)]) -> Policy {
    let (policy, warnings) = probe_with_warnings(state_dir, environment).await;
    warnings.into_iter().for_each(warn);
    policy
}

/// The policy, and the warnings to log: a fallback reason or an ignored invalid value.
async fn probe_with_warnings(
    state_dir: &Path,
    environment: &[(OsString, OsString)],
) -> (Policy, Vec<&'static str>) {
    let mut warnings = Vec::new();
    let policy = match probe_policy(state_dir, environment, &mut warnings).await {
        Ok(policy) => policy,
        Err(reason) => {
            warnings.push(reason);
            Policy::Unread
        }
    };
    (policy, warnings)
}

/// The module's one warning. Reasons are fixed text: no path, value or command output.
fn warn(reason: &'static str) {
    tracing::warn!(reason, "Git system configuration not fully applied");
}

async fn probe_policy(
    state_dir: &Path,
    environment: &[(OsString, OsString)],
    warnings: &mut Vec<&'static str>,
) -> Result<Policy, &'static str> {
    let deadline = Instant::now() + PROBE_BUDGET;
    let mut environment_with_guards = prompt_guard_environment();
    // No repository is found above the empty probe directory, so `includeIf` stays out.
    environment_with_guards.push((
        "GIT_CEILING_DIRECTORIES".into(),
        std::env::temp_dir().into(),
    ));
    environment_with_guards.extend_from_slice(environment);
    let environment = environment_with_guards;
    if !resolves_one_git(child_search_path(&environment).as_deref()) {
        tracing::debug!("a relative PATH entry could resolve another Git per directory");
        return Ok(Policy::Unread);
    }
    let directory = ProbeDirectory::create()?;
    let version = run_git(&directory.0, &environment, &["--version"], deadline).await?;
    match GitVersion::parse(&version.stdout) {
        Some(version) if version >= MINIMUM_GIT => {}
        Some(_) => {
            tracing::debug!("Git is older than 2.32 and cannot take GIT_CONFIG_SYSTEM");
            return Ok(Policy::Unread);
        }
        None => return Err("unrecognized git --version output"),
    }
    let output = run_git(
        &directory.0,
        &environment,
        &[
            "config",
            "--system",
            "--includes",
            "-z",
            "--get-regexp",
            KEYS_PATTERN,
        ],
        deadline,
    )
    .await?;
    let keys = match output.exit_code {
        0 => match canonical_keys(&output.stdout, warnings) {
            Some(keys) => keys,
            None => {
                warnings.push(UNRECOGNIZED_LFS);
                return Ok(Policy::Unread);
            }
        },
        // No key matched.
        1 => Vec::new(),
        _ => return Err("git config --system failed"),
    };
    if keys.is_empty() {
        return Ok(Policy::NoSystem);
    }
    write_keys_file(state_dir, &file_contents(&keys)).map(Policy::KeysOnly)
}

/// The `PATH` a production Git child searches: the inherited one, with `environment` and
/// AppImage isolation applied.
fn child_search_path(environment: &[(OsString, OsString)]) -> Option<OsString> {
    let mut command = std::process::Command::new("git");
    command.envs(environment.iter().cloned());
    crate::process::isolate_appimage_environment(&mut command);
    let is_path = |name: &OsStr| {
        if cfg!(windows) {
            name.eq_ignore_ascii_case("PATH")
        } else {
            name == "PATH"
        }
    };
    match command.get_envs().find(|(name, _)| is_path(name)) {
        Some((_, value)) => value.map(OsStr::to_os_string),
        None => std::env::var_os("PATH"),
    }
}

/// Whether a bare `git` names the same executable from every working directory. On Unix a
/// relative `PATH` entry, the empty one included, is searched from the child's directory.
/// Windows process creation searches from the server's own directory before the child's
/// is applied, so every command finds the same Git there.
fn resolves_one_git(search_path: Option<&OsStr>) -> bool {
    cfg!(windows)
        || search_path.is_none_or(|search_path| {
            std::env::split_paths(search_path).all(|entry| entry.is_absolute())
        })
}

struct ProbeDirectory(PathBuf);

impl ProbeDirectory {
    fn create() -> Result<Self, &'static str> {
        let path = std::env::temp_dir().join(format!(
            "bibcode-git-probe-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&path).map_err(|_| "could not create the probe directory")?;
        Ok(Self(path))
    }
}

impl Drop for ProbeDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

async fn run_git(
    cwd: &Path,
    environment: &[(OsString, OsString)],
    args: &[&str],
    deadline: Instant,
) -> Result<super::ProcessOutput, &'static str> {
    const TIMED_OUT: &str = "the probe timed out";
    let timeout = deadline.saturating_duration_since(Instant::now());
    if timeout.is_zero() {
        return Err(TIMED_OUT);
    }
    let request = ProcessRequest {
        operation: "GitSystemConfig.probe".to_owned(),
        command: PathBuf::from("git"),
        args: args.iter().map(OsString::from).collect(),
        cwd: cwd.to_path_buf(),
        env: environment.to_vec(),
        stdin: None,
        timeout,
        max_output_bytes: 64 * 1024,
        output_policy: OutputPolicy::Error,
        append_truncation_marker: false,
        allow_non_zero_exit: true,
    };
    ProcessRunner
        .run(request, &CancellationToken::new())
        .await
        .map_err(|error| match error {
            ProcessError::Timeout { .. } => TIMED_OUT,
            _ => "git could not run",
        })
}

/// One `key\nvalue` record of `git config -z`; `None` for a valueless key.
type Record<'a> = (&'a str, Option<&'a str>);

/// The kept keys in file order, each with the value to write, canonicalized as Git reads it.
/// An invalid value drops its key, as the person's own Git refuses it. `None` when the
/// system holds an LFS filter group BiBCode does not recognize.
fn canonical_keys(
    output: &str,
    warnings: &mut Vec<&'static str>,
) -> Option<Vec<(&'static str, String)>> {
    let records: Vec<Record> = output
        .split('\0')
        .filter(|record| !record.is_empty())
        .map(|record| match record.split_once('\n') {
            Some((key, value)) => (key, Some(value)),
            None => (record, None),
        })
        .collect();
    let mut keys = Vec::new();
    for key in CORE_KEYS {
        let Some(value) = last(&records, key) else {
            continue;
        };
        match core_value(key, value) {
            Some(value) => keys.push((key, value.to_owned())),
            None => warnings.push("an invalid system core value was ignored"),
        }
    }
    keys.extend(lfs_group(&records)?);
    match credential_helpers(&records) {
        Some(helpers) => keys.extend(
            helpers
                .into_iter()
                .map(|helper| ("credential.helper", helper.to_owned())),
        ),
        None => {
            warnings.push("a system credential helper that is not a well-known name was ignored")
        }
    }
    if let Some(value) = last(&records, "http.sslBackend") {
        match value.and_then(|value| word(value, &SSL_BACKENDS)) {
            Some(backend) => keys.push(("http.sslBackend", backend.to_owned())),
            None => warnings.push("an invalid system http.sslBackend was ignored"),
        }
    }
    if let Some(value) = last(&records, "http.sslCAInfo") {
        match value.filter(|path| usable_ca_file(path)) {
            // Git for Windows reads `/` too, and a quoted Git string would read `\` as an escape.
            Some(path) => keys.push(("http.sslCAInfo", format!("\"{}\"", path.replace('\\', "/")))),
            None => warnings.push("an unusable system http.sslCAInfo was ignored"),
        }
    }
    Some(keys)
}

/// The last value of `name`, as Git reads a single-valued key.
fn last<'a>(records: &[Record<'a>], name: &str) -> Option<Option<&'a str>> {
    records
        .iter()
        .rev()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| *value)
}

fn word(value: &str, words: &[&'static str]) -> Option<&'static str> {
    words
        .iter()
        .copied()
        .find(|word| value.eq_ignore_ascii_case(word))
}

fn boolean(value: Option<&str>) -> Option<&'static str> {
    value
        .map_or(Some(true), git_boolean)
        .map(|value| if value { "true" } else { "false" })
}

fn core_value(key: &str, value: Option<&str>) -> Option<&'static str> {
    let word = |words: &[&'static str]| value.and_then(|value| word(value, words));
    match key {
        "core.autocrlf" => word(&["input"]).or_else(|| boolean(value)),
        "core.safecrlf" => word(&["warn"]).or_else(|| boolean(value)),
        "core.eol" => word(&["lf", "crlf", "native"]),
        _ => boolean(value),
    }
}

/// All or nothing: a half-kept group would convert one way and not the other. `None` when a
/// value is not one `git lfs install` writes.
fn lfs_group(records: &[Record]) -> Option<Vec<(&'static str, String)>> {
    let [clean, smudge, process, required] = [
        "filter.lfs.clean",
        "filter.lfs.smudge",
        "filter.lfs.process",
        "filter.lfs.required",
    ]
    .map(|key| last(records, key));
    if [clean, smudge, process, required]
        .iter()
        .all(Option::is_none)
    {
        return Some(Vec::new());
    }
    let known = |value: Option<Option<&str>>, values: &[&'static str]| {
        values
            .iter()
            .copied()
            .find(|known| value == Some(Some(*known)))
            .map(str::to_owned)
    };
    let mut group = vec![
        ("filter.lfs.clean", known(clean, &LFS_CLEAN)?),
        ("filter.lfs.smudge", known(smudge, &LFS_SMUDGE)?),
    ];
    if process.is_some() {
        group.push(("filter.lfs.process", known(process, &LFS_PROCESS)?));
    }
    if let Some(required) = required {
        group.push(("filter.lfs.required", boolean(required)?.to_owned()));
    }
    Some(group)
}

/// The helper list in order, an empty value resetting it as Git does. `None` unless every
/// remaining entry is a well-known name: a path, arguments or a `!` command never pass.
fn credential_helpers(records: &[Record]) -> Option<Vec<&'static str>> {
    let mut helpers = Vec::new();
    for (key, value) in records {
        if key.eq_ignore_ascii_case("credential.helper") {
            match value {
                Some("") => helpers.clear(),
                value => helpers.push(*value),
            }
        }
    }
    helpers
        .into_iter()
        .map(|helper| {
            CREDENTIAL_HELPERS
                .iter()
                .copied()
                .find(|name| helper == Some(*name))
        })
        .collect()
}

/// A CA bundle is data, not a program: an absolute path to an existing regular file that a
/// quoted Git string can hold.
fn usable_ca_file(path: &str) -> bool {
    !path.chars().any(|c| c.is_control() || c == '"')
        && Path::new(path).is_absolute()
        && std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}

/// Only canonical tokens, never text from the system file, in sections of a fixed order.
fn file_contents(keys: &[(&str, String)]) -> String {
    let mut contents = String::new();
    let mut current = None;
    for (key, value) in keys {
        let (section, name) = key.rsplit_once('.').expect("a kept key has a section");
        if current != Some(section) {
            current = Some(section);
            match section.split_once('.') {
                Some((section, subsection)) => {
                    contents.push_str(&format!("[{section} \"{subsection}\"]\n"));
                }
                None => contents.push_str(&format!("[{section}]\n")),
            }
        }
        contents.push_str(&format!("\t{name} = {value}\n"));
    }
    contents
}

/// Writes `<state>/git/system-config-<hash>.gitconfig` atomically and returns it only
/// when it is a private regular file of the server holding exactly `contents`: another user
/// must not plant or replace the configuration BiBCode's Git reads.
fn write_keys_file(state_dir: &Path, contents: &str) -> Result<PathBuf, &'static str> {
    // Git ignores a `\\?\` verbatim path in `GIT_CONFIG_SYSTEM`, and resolves a relative one
    // inside each repository, where whoever can write there could plant a configuration.
    let state_dir = crate::production::host_paths::process_compatible_path(state_dir.into());
    if !state_dir.is_absolute() {
        return Err("the state directory is not an absolute path");
    }
    let directory = state_dir.join("git");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(&directory)
        .map_err(|_| "could not create the Git state directory")?;
    if !std::fs::symlink_metadata(&directory)
        .is_ok_and(|metadata| metadata.is_dir() && private(&metadata))
    {
        return Err("the Git state directory is not a private directory of the server");
    }
    let digest = Sha256::digest(contents.as_bytes());
    let hash: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let name = format!("system-config-{hash}.gitconfig");
    let path = directory.join(&name);
    // A name taken by anything but the server's own regular file means tampering.
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if !(metadata.is_file() && private(&metadata)) => {
            return Err("the generated Git configuration is not a private file of the server");
        }
        Ok(_) if holds(&path, contents) => return Ok(path),
        _ => {}
    }
    let temporary = directory.join(format!(
        "{name}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let written = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err("could not write the generated Git configuration");
    }
    if holds(&path, contents) {
        Ok(path)
    } else {
        Err("the generated Git configuration is not a private file of the server")
    }
}

fn holds(path: &Path, contents: &str) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && private(&metadata))
        && std::fs::read(path).is_ok_and(|bytes| bytes == contents.as_bytes())
}

/// Owned by the server and writable by no one else. The state directory is the trust
/// boundary, as it already holds the database, so its ancestors are not checked.
#[cfg(unix)]
fn private(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    // SAFETY: `geteuid` has no preconditions.
    metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o022 == 0
}

/// Windows has no owner or mode check: the per-user data root's ACL keeps other users out.
#[cfg(not(unix))]
fn private(_metadata: &std::fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsStr, path::PathBuf};

    use super::{Policy, canonical_keys, config_variable, file_contents, resolves_one_git};

    fn keys(output: &str) -> Option<Vec<(&'static str, String)>> {
        canonical_keys(output, &mut Vec::new())
    }

    fn kept(pairs: &[(&'static str, &str)]) -> Option<Vec<(&'static str, String)>> {
        Some(
            pairs
                .iter()
                .map(|(key, value)| (*key, (*value).to_owned()))
                .collect(),
        )
    }

    #[test]
    fn booleans_words_and_bare_keys_canonicalize_as_git_reads_them() {
        for (output, expected) in [
            ("core.autocrlf\nYES\0", "true"),
            ("core.autocrlf\non\0", "true"),
            ("core.autocrlf\n1\0", "true"),
            ("core.autocrlf\0", "true"),
            ("core.autocrlf\nInput\0", "input"),
            ("core.autocrlf\n\0", "false"),
            ("core.autocrlf\nOFF\0", "false"),
        ] {
            assert_eq!(
                keys(output),
                kept(&[("core.autocrlf", expected)]),
                "{output:?}"
            );
        }
        assert_eq!(keys("core.eol\nLF\0"), kept(&[("core.eol", "lf")]));
        assert_eq!(
            keys("core.safecrlf\nWarn\0"),
            kept(&[("core.safecrlf", "warn")])
        );
        assert_eq!(keys("core.safecrlf\0"), kept(&[("core.safecrlf", "true")]));
    }

    #[test]
    fn symlinks_fscache_and_longpaths_canonicalize_as_booleans() {
        for key in ["core.symlinks", "core.fscache", "core.longpaths"] {
            for (value, expected) in [("\nYes", "true"), ("", "true"), ("\n0", "false")] {
                assert_eq!(
                    keys(&format!("{key}{value}\0")),
                    kept(&[(key, expected)]),
                    "{key}{value:?}"
                );
            }
            assert_eq!(keys(&format!("{key}\ninput\0")), kept(&[]), "{key}");
        }
    }

    #[test]
    fn the_last_value_wins_and_an_invalid_last_value_drops_the_key() {
        assert_eq!(
            keys("core.autocrlf\ntrue\0core.autocrlf\noff\0"),
            kept(&[("core.autocrlf", "false")])
        );
        assert_eq!(
            keys("core.autocrlf\ntrue\0core.autocrlf\nmaybe\0"),
            kept(&[])
        );
        assert_eq!(keys("core.eol\nmac\0"), kept(&[]));
        assert_eq!(keys("core.eol\0"), kept(&[]));
        assert_eq!(keys("core.autocrlf\ntrue\n[credential]\0"), kept(&[]));
        assert_eq!(
            keys("core.safecrlf\nfalse\0core.eol\ncrlf\0core.autocrlf\ntrue\0"),
            kept(&[
                ("core.autocrlf", "true"),
                ("core.eol", "crlf"),
                ("core.safecrlf", "false")
            ])
        );
    }

    const CLEAN: &str = "filter.lfs.clean";
    const SMUDGE: &str = "filter.lfs.smudge";
    const PROCESS: &str = "filter.lfs.process";
    const REQUIRED: &str = "filter.lfs.required";

    fn records(pairs: &[(&str, &str)]) -> String {
        pairs
            .iter()
            .map(|(key, value)| format!("{key}\n{value}\0"))
            .collect()
    }

    #[test]
    fn the_recognized_lfs_groups_are_kept() {
        let today = [
            (CLEAN, "git-lfs clean -- %f"),
            (SMUDGE, "git-lfs smudge -- %f"),
            (PROCESS, "git-lfs filter-process"),
            (REQUIRED, "true"),
        ];
        let skip = [
            (CLEAN, "git-lfs clean -- %f"),
            (SMUDGE, "git-lfs smudge --skip -- %f"),
            (PROCESS, "git-lfs filter-process --skip"),
            (REQUIRED, "true"),
        ];
        let legacy = [(CLEAN, "git-lfs clean %f"), (SMUDGE, "git-lfs smudge %f")];
        for group in [&today[..], &today[..2], &skip[..], &legacy[..]] {
            assert_eq!(keys(&records(group)), kept(group), "{group:?}");
        }
        assert_eq!(
            keys(&records(&[
                (REQUIRED, "Yes"),
                (SMUDGE, "git-lfs smudge -- %f"),
                (CLEAN, "git-lfs clean -- %f")
            ])),
            kept(&[
                (CLEAN, "git-lfs clean -- %f"),
                (SMUDGE, "git-lfs smudge -- %f"),
                (REQUIRED, "true")
            ])
        );
    }

    #[test]
    fn an_unrecognized_lfs_group_leaves_the_policy_unread() {
        let smudge = (SMUDGE, "git-lfs smudge -- %f");
        let clean = (CLEAN, "git-lfs clean -- %f");
        for group in [
            &[(CLEAN, "/opt/bin/git-lfs clean -- %f"), smudge][..],
            &[smudge, (REQUIRED, "true")][..],
            &[clean][..],
            &[clean, smudge, (REQUIRED, "maybe")][..],
            &[clean, smudge, (PROCESS, "git-lfs filter-process --verbose")][..],
        ] {
            assert_eq!(keys(&records(group)), None, "{group:?}");
        }
        assert_eq!(
            keys("filter.lfs.clean\0filter.lfs.smudge\ngit-lfs smudge -- %f\0"),
            None
        );
    }

    #[test]
    fn only_well_known_credential_helper_names_are_kept() {
        let helpers = |values: &[&str]| {
            keys(&records(
                &values
                    .iter()
                    .map(|value| ("credential.helper", *value))
                    .collect::<Vec<_>>(),
            ))
        };
        const HELPER: &str = "credential.helper";
        assert_eq!(helpers(&["manager"]), kept(&[(HELPER, "manager")]));
        assert_eq!(
            helpers(&["", "osxkeychain"]),
            kept(&[(HELPER, "osxkeychain")])
        );
        assert_eq!(
            helpers(&["cache", "store"]),
            kept(&[(HELPER, "cache"), (HELPER, "store")])
        );
        assert_eq!(
            helpers(&["!evil", "", "wincred"]),
            kept(&[(HELPER, "wincred")])
        );
        assert_eq!(helpers(&["manager", "!evil"]), kept(&[]));
        assert_eq!(
            helpers(&["/usr/lib/git-core/git-credential-libsecret"]),
            kept(&[])
        );
        assert_eq!(helpers(&["cache --timeout=60"]), kept(&[]));
        assert_eq!(helpers(&["Manager"]), kept(&[]));
        assert_eq!(keys("credential.helper\0"), kept(&[]));
    }

    #[test]
    fn the_ssl_backend_takes_only_its_four_names() {
        for (value, expected) in [
            ("OpenSSL", "openssl"),
            ("schannel", "schannel"),
            ("gnutls", "gnutls"),
            ("Secure-Transport", "secure-transport"),
        ] {
            assert_eq!(
                keys(&format!("http.sslbackend\n{value}\0")),
                kept(&[("http.sslBackend", expected)])
            );
        }
        assert_eq!(keys("http.sslbackend\nnss\0"), kept(&[]));
        assert_eq!(keys("http.sslbackend\0"), kept(&[]));
    }

    #[test]
    fn only_an_absolute_existing_ca_file_is_kept_and_quoted() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("ca.pem");
        std::fs::write(&file, "fixture CA\n").unwrap();
        let path = file.to_string_lossy().into_owned();
        assert_eq!(
            keys(&format!("http.sslcainfo\n{path}\0")),
            kept(&[(
                "http.sslCAInfo",
                &format!("\"{}\"", path.replace('\\', "/"))
            )])
        );
        for unusable in [
            "ca.pem".to_owned(),
            format!("{path}.missing"),
            directory.path().to_string_lossy().into_owned(),
            format!("{path}\nsecond"),
            format!("{path}\""),
        ] {
            assert_eq!(
                keys(&format!("http.sslcainfo\n{unusable}\0")),
                kept(&[]),
                "{unusable:?}"
            );
        }
    }

    #[test]
    fn the_generated_file_holds_only_canonical_keys_in_fixed_sections() {
        assert_eq!(
            file_contents(&[
                ("core.autocrlf", "true".to_owned()),
                ("core.eol", "lf".to_owned())
            ]),
            "[core]\n\tautocrlf = true\n\teol = lf\n"
        );
        let output = records(&[
            ("http.sslbackend", "schannel"),
            ("credential.helper", "manager"),
            (REQUIRED, "true"),
            (SMUDGE, "git-lfs smudge -- %f"),
            (CLEAN, "git-lfs clean -- %f"),
            ("core.longpaths", "true"),
            ("core.autocrlf", "true"),
            ("include.path", "/elsewhere"),
            ("core.hookspath", "/hooks"),
        ]);
        assert_eq!(
            file_contents(&keys(&output).unwrap()),
            "[core]\n\tautocrlf = true\n\tlongpaths = true\n\
             [filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\
             \trequired = true\n[credential]\n\thelper = manager\n[http]\n\tsslBackend = schannel\n"
        );
    }

    #[test]
    fn only_a_keys_only_policy_replaces_nosystem() {
        fn variable(policy: Option<&Policy>, inherit_unread: bool) -> Option<(String, String)> {
            config_variable(policy, inherit_unread)
                .map(|(name, value)| (name.into_string().unwrap(), value.into_string().unwrap()))
        }
        let nosystem = Some(("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned()));
        for inherit_unread in [false, true] {
            assert_eq!(variable(Some(&Policy::NoSystem), inherit_unread), nosystem);
            let file = PathBuf::from("keys.gitconfig");
            assert_eq!(
                variable(Some(&Policy::KeysOnly(file)), inherit_unread),
                Some(("GIT_CONFIG_SYSTEM".to_owned(), "keys.gitconfig".to_owned()))
            );
        }
        // `git_environment()` drops an unread system file; checkpoints inherit it.
        assert_eq!(variable(None, false), nosystem);
        assert_eq!(variable(Some(&Policy::Unread), false), nosystem);
        assert_eq!(variable(None, true), None);
        assert_eq!(variable(Some(&Policy::Unread), true), None);
    }

    #[test]
    fn a_relative_path_entry_means_more_than_one_git_only_on_unix() {
        let absolute = std::env::temp_dir();
        let joined = |entries: &[PathBuf]| std::env::join_paths(entries).unwrap();
        assert!(resolves_one_git(None));
        assert!(resolves_one_git(Some(&joined(std::slice::from_ref(
            &absolute
        )))));
        assert_eq!(
            resolves_one_git(Some(&joined(&[absolute.clone(), PathBuf::from("bin")]))),
            cfg!(windows)
        );
        assert_eq!(
            resolves_one_git(Some(&joined(&[absolute, PathBuf::new()]))),
            cfg!(windows)
        );
        assert_eq!(resolves_one_git(Some(OsStr::new(""))), cfg!(windows));
    }
}
