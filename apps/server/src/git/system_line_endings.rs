//! The host's system line-ending settings for BiBCode's Git, and nothing else from the
//! system configuration (#282).
//!
//! [`super::git_environment`] passed `GIT_CONFIG_NOSYSTEM=1`, which also dropped Git for
//! Windows' system `core.autocrlf=true`: BiBCode saw every CRLF checkout as modified and
//! committed CRLF blobs. Once per process, [`install_once`] reads `core.autocrlf`,
//! `core.eol` and `core.safecrlf` from the system configuration. When any is set, it writes
//! their canonical values to a file under the server's state directory, and Git runs with
//! `GIT_CONFIG_SYSTEM=<that file>` instead, so repository and global values still win.
//! With no key set, or on any failure, Git keeps `GIT_CONFIG_NOSYSTEM=1`.

use std::{
    ffi::{OsStr, OsString},
    io::Write as _,
    path::{Path, PathBuf},
    sync::OnceLock,
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
const KEYS: [&str; 3] = ["core.autocrlf", "core.eol", "core.safecrlf"];

/// Which system configuration BiBCode's Git reads.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Policy {
    /// `GIT_CONFIG_NOSYSTEM=1`: none.
    NoSystem,
    /// `GIT_CONFIG_SYSTEM=<file>`: the generated file holding only the line-ending keys.
    KeysOnly(PathBuf),
}

static POLICY: OnceLock<Policy> = OnceLock::new();

/// Probes the system configuration and fixes the policy for the rest of the process. Only
/// the two binaries call it, before the server starts. Later calls, an in-process desktop
/// backend restart among them, return the first result: the settings are read once per
/// process.
pub async fn install_once(state_dir: &Path) -> &'static Policy {
    if let Some(policy) = POLICY.get() {
        return policy;
    }
    let policy = probe(state_dir, &[]).await;
    POLICY.get_or_init(|| policy)
}

/// The variable [`super::git_environment`] passes; `GIT_CONFIG_NOSYSTEM=1` until installed.
pub(crate) fn system_config_variable() -> (OsString, OsString) {
    config_variable(POLICY.get())
}

fn config_variable(policy: Option<&Policy>) -> (OsString, OsString) {
    match policy {
        Some(Policy::KeysOnly(path)) => ("GIT_CONFIG_SYSTEM".into(), path.clone().into()),
        Some(Policy::NoSystem) | None => ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
    }
}

/// What [`install_once`] would install, without installing it. `environment` is added to
/// the inherited one, as production Git's is; the probe honours its `GIT_CONFIG_SYSTEM`.
pub async fn probe(state_dir: &Path, environment: &[(OsString, OsString)]) -> Policy {
    match probe_policy(state_dir, environment).await {
        Ok(policy) => policy,
        Err(reason) => {
            warn(reason);
            Policy::NoSystem
        }
    }
}

/// The module's one warning. Reasons are fixed text: no path, value or command output.
fn warn(reason: &'static str) {
    tracing::warn!(
        reason,
        "Git system line-ending settings: falling back to no system configuration"
    );
}

async fn probe_policy(
    state_dir: &Path,
    environment: &[(OsString, OsString)],
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
        return Ok(Policy::NoSystem);
    }
    let directory = ProbeDirectory::create()?;
    let version = run_git(&directory.0, &environment, &["--version"], deadline).await?;
    match GitVersion::parse(&version.stdout) {
        Some(version) if version >= MINIMUM_GIT => {}
        Some(_) => {
            tracing::debug!("Git is older than 2.32 and cannot take GIT_CONFIG_SYSTEM");
            return Ok(Policy::NoSystem);
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
            r"^core\.(autocrlf|eol|safecrlf)$",
        ],
        deadline,
    )
    .await?;
    let keys = match output.exit_code {
        0 => canonical_keys(&output.stdout),
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

/// Whether a bare `git` names the same executable from every working directory: no
/// relative `PATH` entry. Windows skips empty entries; on Unix they mean the directory.
fn resolves_one_git(search_path: Option<&OsStr>) -> bool {
    search_path.is_none_or(|search_path| {
        std::env::split_paths(search_path)
            .all(|entry| entry.is_absolute() || (cfg!(windows) && entry.as_os_str().is_empty()))
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
        operation: "GitSystemLineEndings.probe".to_owned(),
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

/// The last value of each key, canonicalized as Git reads it. An invalid last value drops
/// the key, as the person's own Git refuses it.
fn canonical_keys(output: &str) -> Vec<(&'static str, &'static str)> {
    let mut last: [Option<Option<&str>>; 3] = [None; 3];
    for record in output.split('\0').filter(|record| !record.is_empty()) {
        // `-z` prints `key\nvalue`, or a bare key for a valueless boolean.
        let (key, value) = match record.split_once('\n') {
            Some((key, value)) => (key, Some(value)),
            None => (record, None),
        };
        if let Some(index) = KEYS.iter().position(|name| key.eq_ignore_ascii_case(name)) {
            last[index] = Some(value);
        }
    }
    KEYS.into_iter()
        .zip(last)
        .filter_map(|(key, value)| {
            let canonical = canonical_value(key, value?);
            if canonical.is_none() {
                warn("an invalid system line-ending value was ignored");
            }
            Some((key, canonical?))
        })
        .collect()
}

fn canonical_value(key: &str, value: Option<&str>) -> Option<&'static str> {
    let word = |words: &[&'static str]| {
        value.and_then(|value| {
            words
                .iter()
                .copied()
                .find(|word| value.eq_ignore_ascii_case(word))
        })
    };
    let boolean = || {
        value
            .map_or(Some(true), git_boolean)
            .map(|value| if value { "true" } else { "false" })
    };
    match key {
        "core.autocrlf" => word(&["input"]).or_else(boolean),
        "core.safecrlf" => word(&["warn"]).or_else(boolean),
        _ => word(&["lf", "crlf", "native"]),
    }
}

/// Only canonical tokens, never text from the system file.
fn file_contents(keys: &[(&str, &str)]) -> String {
    let mut contents = String::from("[core]\n");
    for (key, value) in keys {
        let name = key.trim_start_matches("core.");
        contents.push_str(&format!("\t{name} = {value}\n"));
    }
    contents
}

/// Writes `<state>/git/system-line-endings-<hash>.gitconfig` atomically and returns it only
/// when it is a regular file the server owns holding exactly `contents`: another local user
/// must not plant or replace the configuration BiBCode's Git reads.
fn write_keys_file(state_dir: &Path, contents: &str) -> Result<PathBuf, &'static str> {
    let directory = state_dir.join("git");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(&directory)
        .map_err(|_| "could not create the Git state directory")?;
    if !std::fs::symlink_metadata(&directory)
        .is_ok_and(|metadata| metadata.is_dir() && owned(&metadata))
    {
        return Err("the Git state directory is not a directory the server owns");
    }
    let digest = Sha256::digest(contents.as_bytes());
    let hash: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let name = format!("system-line-endings-{hash}.gitconfig");
    let path = directory.join(&name);
    // A name taken by anything but the server's own regular file means tampering.
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if !(metadata.is_file() && owned(&metadata)) => {
            return Err("the generated Git configuration is not a file the server owns");
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
        Err("the generated Git configuration is not a file the server owns")
    }
}

fn holds(path: &Path, contents: &str) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file() && owned(&metadata))
        && std::fs::read(path).is_ok_and(|bytes| bytes == contents.as_bytes())
}

#[cfg(unix)]
fn owned(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    // SAFETY: `geteuid` has no preconditions.
    metadata.uid() == unsafe { libc::geteuid() }
}

/// Windows has no owner check: the per-user data root's ACL keeps other users out.
#[cfg(not(unix))]
fn owned(_metadata: &std::fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsStr, path::PathBuf};

    use super::{Policy, canonical_keys, config_variable, file_contents, resolves_one_git};

    fn keys(output: &str) -> Vec<(&'static str, &'static str)> {
        canonical_keys(output)
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
            assert_eq!(keys(output), [("core.autocrlf", expected)], "{output:?}");
        }
        assert_eq!(keys("core.eol\nLF\0"), [("core.eol", "lf")]);
        assert_eq!(keys("core.safecrlf\nWarn\0"), [("core.safecrlf", "warn")]);
        assert_eq!(keys("core.safecrlf\0"), [("core.safecrlf", "true")]);
    }

    #[test]
    fn the_last_value_wins_and_an_invalid_last_value_drops_the_key() {
        assert_eq!(
            keys("core.autocrlf\ntrue\0core.autocrlf\noff\0"),
            [("core.autocrlf", "false")]
        );
        assert_eq!(keys("core.autocrlf\ntrue\0core.autocrlf\nmaybe\0"), []);
        assert_eq!(keys("core.eol\nmac\0"), []);
        assert_eq!(keys("core.eol\0"), []);
        assert_eq!(keys("core.autocrlf\ntrue\n[credential]\0"), []);
        assert_eq!(
            keys("core.safecrlf\nfalse\0core.eol\ncrlf\0core.autocrlf\ntrue\0"),
            [
                ("core.autocrlf", "true"),
                ("core.eol", "crlf"),
                ("core.safecrlf", "false")
            ]
        );
    }

    #[test]
    fn the_generated_file_holds_only_canonical_core_keys() {
        assert_eq!(
            file_contents(&[("core.autocrlf", "true"), ("core.eol", "lf")]),
            "[core]\n\tautocrlf = true\n\teol = lf\n"
        );
    }

    #[test]
    fn only_a_keys_only_policy_replaces_nosystem() {
        let variable = |policy| {
            let (name, value) = config_variable(policy);
            (name.into_string().unwrap(), value.into_string().unwrap())
        };
        let nosystem = ("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned());
        assert_eq!(variable(None), nosystem);
        assert_eq!(variable(Some(&Policy::NoSystem)), nosystem);
        let file = PathBuf::from("keys.gitconfig");
        assert_eq!(
            variable(Some(&Policy::KeysOnly(file))),
            ("GIT_CONFIG_SYSTEM".to_owned(), "keys.gitconfig".to_owned())
        );
    }

    #[test]
    fn a_relative_path_entry_means_more_than_one_git() {
        let absolute = std::env::temp_dir();
        let joined = |entries: &[PathBuf]| std::env::join_paths(entries).unwrap();
        assert!(resolves_one_git(None));
        assert!(resolves_one_git(Some(&joined(std::slice::from_ref(
            &absolute
        )))));
        assert!(!resolves_one_git(Some(&joined(&[
            absolute.clone(),
            PathBuf::from("bin")
        ]))));
        assert_eq!(
            resolves_one_git(Some(&joined(&[absolute, PathBuf::new()]))),
            cfg!(windows)
        );
        assert_eq!(resolves_one_git(Some(OsStr::new(""))), cfg!(windows));
    }
}
