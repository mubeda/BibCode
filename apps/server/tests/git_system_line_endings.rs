//! BiBCode's Git honours the system line-ending settings and nothing else from the system
//! configuration (#282). A fixture file passed as `GIT_CONFIG_SYSTEM` stands in for Git for
//! Windows' system configuration, so every case runs on every OS and the host's
//! configuration is never read or changed.
//!
//! The policy is process-global and installed once, so each case that installs it runs in
//! a process of its own (`reexec`). The probe-only cases call `probe`, which installs nothing.

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant, SystemTime},
};

use bibcode_server::git::{
    CreateWorktreeInput, GitRepository,
    system_line_endings::{Policy, install_once, probe},
};
use tokio_util::sync::CancellationToken;

#[path = "support/executable_fixture.rs"]
mod executable_fixture;
#[path = "support/reexec.rs"]
mod reexec;

const PHASE: &str = "own-process";
const ROOT: &str = "BIBCODE_TEST_LINE_ENDINGS_ROOT";
const AUTOCRLF: &str = "[core]\n\tautocrlf = true\n";
const GLOBAL: &str = "[user]\n\tname = Line Endings Test\n\temail = line-endings@example.test\n\
                      [commit]\n\tgpgSign = false\n";
const LF: &[u8] = b"one\ntwo\nthree\n";
const CRLF: &[u8] = b"one\r\ntwo\r\nthree\r\n";

/// Runs test `name` again in its own process, with `system` (built from the fixture root) as
/// the system configuration, an isolated global one, and no inherited Git variable. In that
/// process, returns the phase to complete and the fixture root.
fn in_own_process(
    name: &str,
    system: impl FnOnce(&str) -> String,
) -> Option<(reexec::ChildPhase, PathBuf)> {
    if let Some(phase) = reexec::enter(name, PHASE) {
        return Some((phase, PathBuf::from(std::env::var_os(ROOT).expect(ROOT))));
    }
    let root = tempfile::tempdir().expect("fixture root");
    fs::write(
        root.path().join("system.gitconfig"),
        system(&slashes(root.path())),
    )
    .expect("fixture system configuration");
    fs::write(root.path().join("global.gitconfig"), GLOBAL).expect("fixture global configuration");
    reexec::run(name, PHASE, None, |command| {
        for (variable, _) in std::env::vars_os() {
            if variable
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(variable);
            }
        }
        command
            .env("GIT_CONFIG_SYSTEM", root.path().join("system.gitconfig"))
            .env("GIT_CONFIG_GLOBAL", root.path().join("global.gitconfig"))
            .env("PATH", search_path(&[]))
            .env(ROOT, root.path());
    });
    None
}

/// Probe-only cases: `probe` adds this environment to the inherited one.
fn probe_environment(system: &Path, search_path: OsString) -> Vec<(OsString, OsString)> {
    vec![
        ("GIT_CONFIG_SYSTEM".into(), system.into()),
        ("PATH".into(), search_path),
    ]
}

/// `first`, then the inherited `PATH` without its relative entries, which keep the policy
/// at `NoSystem` on Unix (a shell can leave one, such as a `C` split off `C:\...`).
fn search_path(first: &[PathBuf]) -> OsString {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let inherited = std::env::split_paths(&inherited).filter(|entry| entry.is_absolute());
    std::env::join_paths(first.iter().cloned().chain(inherited)).expect("fixture PATH")
}

fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The person's own Git, which reads the fixture system configuration.
fn git(cwd: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("fixture Git starts");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

/// An LF origin, and a clone the person's Git checked out with CRLF under the system
/// `core.autocrlf=true`, with a changed modification time so status rereads the file.
fn crlf_clone(root: &Path) -> PathBuf {
    let origin = root.join("origin");
    fs::create_dir(&origin).expect("origin directory");
    git(&origin, &["init", "-q", "-b", "main"]);
    fs::write(origin.join("file.txt"), LF).expect("origin file");
    git(&origin, &["-c", "core.autocrlf=false", "add", "file.txt"]);
    git(
        &origin,
        &["-c", "core.autocrlf=false", "commit", "-q", "-m", "base"],
    );
    git(root, &["clone", "-q", "origin", "clone"]);
    let clone = root.join("clone");
    let file = clone.join("file.txt");
    assert_eq!(
        fs::read(&file).unwrap(),
        CRLF,
        "the person's Git checks out CRLF"
    );
    fs::File::options()
        .write(true)
        .open(&file)
        .and_then(|file| file.set_modified(SystemTime::now() + Duration::from_secs(5)))
        .expect("touch the checkout");
    clone
}

fn blob(clone: &Path) -> Vec<u8> {
    git(clone, &["cat-file", "-p", "HEAD:file.txt"])
}

async fn commit_file(clone: &Path, contents: &[u8]) {
    fs::write(clone.join("file.txt"), contents).expect("change the checkout");
    let repository = GitRepository::default();
    let cancellation = CancellationToken::new();
    repository
        .stage_files(clone, &["file.txt".to_owned()], &cancellation)
        .await
        .expect("BiBCode stages");
    let outcome = repository
        .commit_with_options(
            clone,
            &["commit", "-F", "-"].map(str::to_owned),
            b"via BiBCode\n",
            false,
            &cancellation,
        )
        .await
        .expect("BiBCode commits");
    assert!(outcome.sha.is_some(), "a commit was made");
}

async fn assert_clean(clone: &Path) {
    let status = GitRepository::default()
        .status(clone, &CancellationToken::new())
        .await
        .expect("BiBCode status");
    // A configuration Git cannot read makes every command fail, which reads as no changes.
    assert!(
        status.local.is_repo && status.local.repository_unavailable_reason.is_none(),
        "BiBCode's Git could not read the repository: {:?}",
        status.local.repository_unavailable_reason
    );
    assert!(
        !status.local.has_working_tree_changes && status.local.working_tree.files.is_empty(),
        "BiBCode's status and diff see the CRLF checkout as changed: {:?}",
        status.local.working_tree
    );
}

async fn install_keys_only(root: &Path) -> PathBuf {
    match install_once(&root.join("state")).await {
        Policy::KeysOnly(path) => path.clone(),
        Policy::NoSystem => panic!("the system core.autocrlf was not installed"),
    }
}

#[tokio::test]
async fn a_crlf_checkout_under_a_system_autocrlf_is_clean_in_status_and_diff() {
    let Some((phase, root)) = in_own_process(
        "a_crlf_checkout_under_a_system_autocrlf_is_clean_in_status_and_diff",
        |_| AUTOCRLF.to_owned(),
    ) else {
        return;
    };
    let clone = crlf_clone(&root);
    install_once(&root.join("state")).await;
    assert_clean(&clone).await;
    phase.complete();
}

#[tokio::test]
async fn a_commit_through_the_git_manager_stores_lf_under_a_system_autocrlf() {
    let Some((phase, root)) = in_own_process(
        "a_commit_through_the_git_manager_stores_lf_under_a_system_autocrlf",
        |_| AUTOCRLF.to_owned(),
    ) else {
        return;
    };
    let clone = crlf_clone(&root);
    install_once(&root.join("state")).await;
    commit_file(&clone, b"one\r\ntwo\r\nthree\r\nfour\r\n").await;
    assert_eq!(
        String::from_utf8_lossy(&blob(&clone)),
        "one\ntwo\nthree\nfour\n",
        "BiBCode's commit stored CRLF"
    );
    phase.complete();
}

#[tokio::test]
async fn a_worktree_created_under_a_system_autocrlf_checks_out_crlf() {
    let Some((phase, root)) = in_own_process(
        "a_worktree_created_under_a_system_autocrlf_checks_out_crlf",
        |_| AUTOCRLF.to_owned(),
    ) else {
        return;
    };
    let clone = crlf_clone(&root);
    install_once(&root.join("state")).await;
    GitRepository::default()
        .create_worktree(
            CreateWorktreeInput {
                cwd: clone,
                ref_name: "main".to_owned(),
                new_ref_name: Some("side".to_owned()),
                base_ref_name: None,
                path: Some(root.join("worktree")),
            },
            &CancellationToken::new(),
        )
        .await
        .expect("BiBCode creates the worktree");
    assert_eq!(
        String::from_utf8_lossy(&fs::read(root.join("worktree/file.txt")).unwrap()),
        String::from_utf8_lossy(CRLF),
        "BiBCode's worktree is checked out with LF"
    );
    phase.complete();
}

#[tokio::test]
async fn a_system_autocrlf_reached_only_through_include_path_applies() {
    let Some((phase, root)) = in_own_process(
        "a_system_autocrlf_reached_only_through_include_path_applies",
        |root| format!("[include]\n\tpath = {root}/included.gitconfig\n"),
    ) else {
        return;
    };
    fs::write(root.join("included.gitconfig"), AUTOCRLF).expect("included configuration");
    let clone = crlf_clone(&root);
    install_once(&root.join("state")).await;
    assert_clean(&clone).await;
    phase.complete();
}

#[tokio::test]
async fn a_repository_autocrlf_false_beats_the_system_value() {
    let Some((phase, root)) =
        in_own_process("a_repository_autocrlf_false_beats_the_system_value", |_| {
            AUTOCRLF.to_owned()
        })
    else {
        return;
    };
    let clone = crlf_clone(&root);
    git(&clone, &["config", "core.autocrlf", "false"]);
    install_keys_only(&root).await;
    commit_file(&clone, b"one\r\ntwo\r\n").await;
    assert_eq!(
        String::from_utf8_lossy(&blob(&clone)),
        "one\r\ntwo\r\n",
        "the system value beat the repository's core.autocrlf=false"
    );
    phase.complete();
}

/// Fixture system configuration with a hook directory, a credential helper and a clean filter.
fn hostile_system(root: &str) -> String {
    format!(
        "{AUTOCRLF}\thooksPath = {root}/hooks\n[credential]\n\thelper = \"!echo ran > '{root}/credential-ran'\"\n\
         [filter \"x\"]\n\tclean = \"echo ran > '{root}/filter-ran'; cat\"\n"
    )
}

/// The hook and filter of [`hostile_system`], armed after the fixture's own commits.
fn arm_hostile_system(root: &Path, clone: &Path) {
    fs::create_dir(root.join("hooks")).expect("hook directory");
    executable_fixture::write_executable(
        &root.join("hooks/pre-commit"),
        format!("#!/bin/sh\necho ran > '{}/hook-ran'\n", slashes(root)),
    );
    fs::write(clone.join(".git/info/attributes"), "file.txt filter=x\n").expect("attributes");
}

fn assert_nothing_ran(root: &Path) {
    for marker in ["hook-ran", "filter-ran", "credential-ran"] {
        assert!(
            !root.join(marker).exists(),
            "production Git ran the system {marker}"
        );
    }
}

#[tokio::test]
async fn a_system_credential_helper_hook_or_filter_never_reaches_production_git() {
    let Some((phase, root)) = in_own_process(
        "a_system_credential_helper_hook_or_filter_never_reaches_production_git",
        hostile_system,
    ) else {
        return;
    };
    let clone = crlf_clone(&root);
    arm_hostile_system(&root, &clone);
    let generated = install_keys_only(&root).await;
    assert_eq!(fs::read_to_string(generated).unwrap(), AUTOCRLF);
    commit_file(&clone, b"one\r\ntwo\r\n").await;
    assert_nothing_ran(&root);
    assert_eq!(String::from_utf8_lossy(&blob(&clone)), "one\ntwo\n");
    phase.complete();
}

#[tokio::test]
async fn a_missing_generated_file_behaves_as_today() {
    let Some((phase, root)) = in_own_process("a_missing_generated_file_behaves_as_today", |_| {
        AUTOCRLF.to_owned()
    }) else {
        return;
    };
    let clone = crlf_clone(&root);
    fs::remove_file(install_keys_only(&root).await).expect("remove the generated file");
    let status = GitRepository::default()
        .status(&clone, &CancellationToken::new())
        .await
        .expect("BiBCode status without the generated file");
    assert!(
        status.local.has_working_tree_changes,
        "Git fell back to a system configuration instead of none"
    );
    phase.complete();
}

#[tokio::test]
async fn a_planted_or_foreign_generated_file_is_refused() {
    let Some((phase, root)) = in_own_process(
        "a_planted_or_foreign_generated_file_is_refused",
        hostile_system,
    ) else {
        return;
    };
    let Policy::KeysOnly(reference) = probe(&root.join("reference"), &[]).await else {
        panic!("the fixture system configuration was not probed");
    };
    let name = reference.file_name().unwrap().to_owned();
    let planted = "[core]\n\thooksPath = planted\n";

    // The final name is a directory: install refuses it, and a commit runs no system hook.
    let directory_state = root.join("directory");
    fs::create_dir_all(directory_state.join("git").join(&name)).unwrap();
    assert_eq!(*install_once(&directory_state).await, Policy::NoSystem);
    let clone = crlf_clone(&root);
    arm_hostile_system(&root, &clone);
    commit_file(&clone, b"one\r\ntwo\r\n").await;
    assert_nothing_ran(&root);

    // `<state>/git` is a symlink.
    let target = root.join("symlink-target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join(&name), planted).unwrap();
    let symlink_state = root.join("symlink");
    fs::create_dir(&symlink_state).unwrap();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&target, symlink_state.join("git"));
    // Without the symlink privilege, a junction: `symlink_metadata` reports both as links.
    #[cfg(windows)]
    let linked =
        std::os::windows::fs::symlink_dir(&target, symlink_state.join("git")).or_else(|error| {
            Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(symlink_state.join("git"))
                .arg(&target)
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(drop)
                .ok_or(error)
        });
    match linked {
        Ok(()) => {
            assert_eq!(probe(&symlink_state, &[]).await, Policy::NoSystem);
            assert_eq!(fs::read_to_string(target.join(&name)).unwrap(), planted);
        }
        Err(error) => eprintln!("skipped the symlink case: {error}"),
    }

    // A file owned by another user under the final name (needs root to plant).
    // SAFETY: `geteuid` has no preconditions.
    #[cfg(unix)]
    if unsafe { libc::geteuid() } == 0 {
        let foreign_state = root.join("foreign");
        fs::create_dir_all(foreign_state.join("git")).unwrap();
        let foreign = foreign_state.join("git").join(&name);
        fs::write(&foreign, AUTOCRLF).unwrap();
        std::os::unix::fs::chown(&foreign, Some(65_534), None).unwrap();
        assert_eq!(probe(&foreign_state, &[]).await, Policy::NoSystem);
    }

    // A planted temporary name is never used.
    let temporary_state = root.join("temporary");
    fs::create_dir_all(temporary_state.join("git")).unwrap();
    let mut temporary_name = name.clone();
    temporary_name.push(format!(".tmp-{}-planted", std::process::id()));
    let temporary = temporary_state.join("git").join(temporary_name);
    fs::write(&temporary, planted).unwrap();
    let Policy::KeysOnly(generated) = probe(&temporary_state, &[]).await else {
        panic!("a planted temporary file stopped the write");
    };
    assert_eq!(generated, temporary_state.join("git").join(&name));
    assert_eq!(fs::read_to_string(&generated).unwrap(), AUTOCRLF);
    assert_eq!(fs::read_to_string(&temporary).unwrap(), planted);
    phase.complete();
}

#[tokio::test]
async fn the_generated_file_is_under_the_state_dir_with_private_modes() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(&system, "[core]\n\tautocrlf = input\n\tsafecrlf = warn\n").unwrap();
    let state = root.path().join("state");
    let Policy::KeysOnly(generated) =
        probe(&state, &probe_environment(&system, search_path(&[]))).await
    else {
        panic!("the fixture system configuration was not probed");
    };
    assert_eq!(generated.parent(), Some(state.join("git").as_path()));
    let name = generated
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let hash = name
        .strip_prefix("system-line-endings-")
        .and_then(|rest| rest.strip_suffix(".gitconfig"))
        .expect("generated file name");
    assert!(hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(
        fs::read_to_string(&generated).unwrap(),
        "[core]\n\tautocrlf = input\n\tsafecrlf = warn\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&state.join("git")), 0o700);
        assert_eq!(mode(&generated), 0o600);
    }
}

#[tokio::test]
async fn no_line_ending_keys_keeps_nosystem() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(
        &system,
        "[credential]\n\thelper = manager\n[core]\n\tfscache = true\n",
    )
    .unwrap();
    let state = root.path().join("state");
    assert_eq!(
        probe(&state, &probe_environment(&system, search_path(&[]))).await,
        Policy::NoSystem
    );
    assert!(
        !state.exists(),
        "nothing is written without a line-ending key"
    );
}

/// A fake `git` in its own directory, first on a `PATH` that still finds the real Git.
fn fake_git_first_on_path(root: &Path, mode: &str) -> (PathBuf, OsString) {
    let directory = root.join("fake-bin");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("mode"), mode).unwrap();
    let executable = directory.join(if cfg!(windows) { "git.exe" } else { "git" });
    let output = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
        .arg("--edition=2024")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_git_fixture.rs"))
        .arg("-o")
        .arg(&executable)
        .output()
        .expect("compile the fake Git");
    assert!(
        output.status.success(),
        "compile the fake Git: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let search_path = search_path(std::slice::from_ref(&directory));
    (directory, search_path)
}

#[tokio::test]
async fn an_older_git_first_on_path_keeps_nosystem() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(&system, AUTOCRLF).unwrap();
    let (_, search_path) = fake_git_first_on_path(root.path(), "old");
    let state = root.path().join("state");
    assert_eq!(
        probe(&state, &probe_environment(&system, search_path)).await,
        Policy::NoSystem
    );
}

/// Windows searches a relative entry from the server's directory, not each child's, so
/// every command still finds the same Git there.
#[tokio::test]
async fn a_relative_path_entry_keeps_nosystem_on_unix() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(&system, AUTOCRLF).unwrap();
    let state = root.path().join("state");
    let relative_first = search_path(&[PathBuf::from("relative-bin")]);
    let policy = probe(&state, &probe_environment(&system, relative_first)).await;
    assert_eq!(
        matches!(policy, Policy::KeysOnly(_)),
        cfg!(windows),
        "{policy:?}"
    );
}

/// Git resolves a relative `GIT_CONFIG_SYSTEM` inside each repository.
#[tokio::test]
async fn a_relative_state_dir_keeps_nosystem() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(&system, AUTOCRLF).unwrap();
    // Relative to the package directory, inside the workspace's own `target`.
    let state = Path::new("../../target/git-system-line-endings-relative-state");
    let policy = probe(state, &probe_environment(&system, search_path(&[]))).await;
    let _ = fs::remove_dir_all(state);
    assert_eq!(policy, Policy::NoSystem);
}

/// The desktop's data root is canonicalized, a `\\?\` path on Windows, which Git ignores in
/// `GIT_CONFIG_SYSTEM`.
#[tokio::test]
async fn a_canonical_state_dir_still_applies_the_system_autocrlf() {
    let Some((phase, root)) = in_own_process(
        "a_canonical_state_dir_still_applies_the_system_autocrlf",
        |_| AUTOCRLF.to_owned(),
    ) else {
        return;
    };
    let clone = crlf_clone(&root);
    let state = fs::canonicalize(&root).unwrap().join("state");
    install_once(&state).await;
    assert_clean(&clone).await;
    phase.complete();
}

/// The state directory is the trust boundary: neither it nor the reused file may be
/// writable by another user.
#[cfg(unix)]
#[tokio::test]
async fn a_group_or_other_writable_state_is_refused() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(&system, AUTOCRLF).unwrap();
    let environment = probe_environment(&system, search_path(&[]));
    let Policy::KeysOnly(reference) = probe(&root.path().join("reference"), &environment).await
    else {
        panic!("the fixture system configuration was not probed");
    };
    let writable = |path: &Path| fs::set_permissions(path, fs::Permissions::from_mode(0o777));

    let directory_state = root.path().join("writable-directory");
    fs::create_dir_all(directory_state.join("git")).unwrap();
    writable(&directory_state.join("git")).unwrap();
    assert_eq!(
        probe(&directory_state, &environment).await,
        Policy::NoSystem
    );

    let file_state = root.path().join("writable-file");
    fs::create_dir_all(file_state.join("git")).unwrap();
    let file = file_state.join("git").join(reference.file_name().unwrap());
    fs::copy(&reference, &file).unwrap();
    writable(&file).unwrap();
    assert_eq!(probe(&file_state, &environment).await, Policy::NoSystem);
}

#[tokio::test]
async fn a_stalled_probe_falls_back_within_the_deadline() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(&system, AUTOCRLF).unwrap();
    let (directory, search_path) = fake_git_first_on_path(root.path(), "stall");
    let state = root.path().join("state");
    let started = Instant::now();
    let policy = probe(&state, &probe_environment(&system, search_path)).await;
    let elapsed = started.elapsed();
    assert_eq!(policy, Policy::NoSystem);
    assert!(
        elapsed < Duration::from_millis(3_500),
        "the probe took {elapsed:?}"
    );
    assert!(directory.join("ticks").exists(), "the fake Git ran");
    let ticks = || fs::metadata(directory.join("ticks")).unwrap().len();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let after_return = ticks();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(ticks(), after_return, "the stalled Git was not killed");
}
