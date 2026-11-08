//! BiBCode's Git reads one curated subset of the system configuration (#282, #283). A
//! fixture file passed as `GIT_CONFIG_SYSTEM` stands in for Git for Windows' system
//! configuration, so every case runs on every OS and the host's configuration is never read
//! or changed. A compiled fake `git-lfs` stands in for Git LFS.
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

use bibcode_server::{
    git::{
        CreateWorktreeInput, GitRepository,
        system_config::{Policy, install_once, probe},
    },
    production::orchestration_effects::{
        capture_checkpoint, checkpoint_ref, delete_checkpoint_ref, fetch_origin_base,
        restore_checkpoint_ref,
    },
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
/// Git for Windows' system LFS group without `process`, so Git runs the fake's one-shot
/// commands. `autocrlf = false` keeps every other file's bytes as written.
const LFS_SYSTEM: &str = "[core]\n\tautocrlf = false\n[filter \"lfs\"]\n\
                          \tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\
                          \trequired = true\n";
const CONTENT: &[u8] = b"large binary content\n";

/// Runs test `name` again in its own process, with `system` (built from the fixture root) as
/// the system configuration, an isolated global one, and no inherited Git variable. In that
/// process, returns the phase to complete and the fixture root.
fn in_own_process(
    name: &str,
    system: impl FnOnce(&str) -> String,
) -> Option<(reexec::ChildPhase, PathBuf)> {
    in_processes(name, &[PHASE], system, |_| {}).map(|(_, phase, root)| (phase, root))
}

/// [`in_own_process`] with one process per phase, in order, sharing one fixture root, and
/// `prepare` writing fakes into `<root>/bin`, first on the child `PATH`. In a child, also
/// returns its phase's name.
fn in_processes(
    name: &str,
    phases: &[&'static str],
    system: impl FnOnce(&str) -> String,
    prepare: impl FnOnce(&Path),
) -> Option<(&'static str, reexec::ChildPhase, PathBuf)> {
    for phase in phases {
        if let Some(child) = reexec::enter(name, phase) {
            let root = PathBuf::from(std::env::var_os(ROOT).expect(ROOT));
            return Some((phase, child, root));
        }
    }
    let root = tempfile::tempdir().expect("fixture root");
    fs::write(
        root.path().join("system.gitconfig"),
        system(&slashes(root.path())),
    )
    .expect("fixture system configuration");
    fs::write(root.path().join("global.gitconfig"), GLOBAL).expect("fixture global configuration");
    let bin = root.path().join("bin");
    fs::create_dir(&bin).expect("fixture bin directory");
    prepare(&bin);
    for phase in phases {
        reexec::run(name, phase, None, |command| {
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
                .env("PATH", search_path(std::slice::from_ref(&bin)))
                .env(ROOT, root.path());
            // Git for Windows puts its exec path, then its own `bin` with a bundled git-lfs,
            // ahead of `PATH` for the commands it runs; an exec path of `bin` puts the fake
            // first. Every command these tests run is built in.
            if cfg!(windows) && bin.join(executable_name("git-lfs")).exists() {
                command.env("GIT_EXEC_PATH", &bin);
            }
        });
    }
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
        policy => panic!("the fixture system configuration was not installed: {policy:?}"),
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

/// Fixture system configuration with a hook directory, a credential helper, two filters and
/// a textconv.
fn hostile_system(root: &str) -> String {
    format!(
        "{AUTOCRLF}\thooksPath = {root}/hooks\n[credential]\n\thelper = \"!echo ran > '{root}/credential-ran'\"\n\
         [filter \"x\"]\n\tclean = \"echo ran > '{root}/filter-ran'; cat\"\n\
         \tsmudge = \"echo ran > '{root}/smudge-ran'; cat\"\n\
         [filter \"y\"]\n\tclean = \"echo ran > '{root}/second-filter-ran'; cat\"\n\
         \tsmudge = \"echo ran > '{root}/second-filter-ran'; cat\"\n\
         [diff \"x\"]\n\ttextconv = \"echo ran > '{root}/textconv-ran'; cat\"\n"
    )
}

/// The hooks, filters and textconv of [`hostile_system`], armed after the fixture's own
/// commits.
fn arm_hostile_system(root: &Path, clone: &Path) {
    fs::create_dir(root.join("hooks")).expect("hook directory");
    executable_fixture::write_executable(
        &root.join("hooks/pre-commit"),
        format!("#!/bin/sh\necho ran > '{}/hook-ran'\n", slashes(root)),
    );
    write_marker_hook(&root.join("hooks"), &root.join("hook-ran"));
    fs::write(
        clone.join(".git/info/attributes"),
        "file.txt filter=x diff=x\nother.txt filter=y\n",
    )
    .expect("attributes");
}

/// A `reference-transaction` hook in `directory` that appends to `marker`.
fn write_marker_hook(directory: &Path, marker: &Path) {
    executable_fixture::write_executable(
        &directory.join("reference-transaction"),
        format!(
            "#!/bin/sh\ncat > /dev/null\necho \"$1\" >> '{}'\n",
            slashes(marker)
        ),
    );
}

fn assert_nothing_ran(root: &Path) {
    for marker in [
        "hook-ran",
        "filter-ran",
        "smudge-ran",
        "second-filter-ran",
        "textconv-ran",
        "credential-ran",
    ] {
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
    assert_eq!(*install_once(&directory_state).await, Policy::Unread);
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
            assert_eq!(probe(&symlink_state, &[]).await, Policy::Unread);
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
        assert_eq!(probe(&foreign_state, &[]).await, Policy::Unread);
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
        .strip_prefix("system-config-")
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
async fn no_kept_keys_keeps_nosystem() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(
        &system,
        "[credential]\n\thelper = /usr/lib/git-core/git-credential-libsecret\n\
         [pull]\n\trebase = true\n[init]\n\tdefaultBranch = main\n",
    )
    .unwrap();
    let state = root.path().join("state");
    assert_eq!(
        probe(&state, &probe_environment(&system, search_path(&[]))).await,
        Policy::NoSystem
    );
    assert!(!state.exists(), "nothing is written without a kept key");
}

/// Compiles test fixture `source` (under `tests/fixtures`) to `executable`.
fn compile_fixture(source: &str, executable: &Path) {
    let output = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
        .arg("--edition=2024")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(source),
        )
        .arg("-o")
        .arg(executable)
        .output()
        .expect("compile the fixture");
    assert!(
        output.status.success(),
        "compile {source}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// A fake `git` in `directory`, running in `mode` (see `fake_git_fixture.rs`).
fn fake_git(directory: &Path, mode: &str) {
    fs::write(directory.join("mode"), mode).unwrap();
    compile_fixture(
        "fake_git_fixture.rs",
        &directory.join(executable_name("git")),
    );
}

/// A fake `git-lfs` in `directory` (see `fake_git_lfs_fixture.rs`).
fn fake_git_lfs(directory: &Path) {
    compile_fixture(
        "fake_git_lfs_fixture.rs",
        &directory.join(executable_name("git-lfs")),
    );
}

/// A fake `git` in its own directory, first on a `PATH` that still finds the real Git.
fn fake_git_first_on_path(root: &Path, mode: &str) -> (PathBuf, OsString) {
    let directory = root.join("fake-bin");
    fs::create_dir(&directory).unwrap();
    fake_git(&directory, mode);
    let search_path = search_path(std::slice::from_ref(&directory));
    (directory, search_path)
}

#[tokio::test]
async fn an_older_git_first_on_path_keeps_the_policy_unread() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(&system, AUTOCRLF).unwrap();
    let (_, search_path) = fake_git_first_on_path(root.path(), "old");
    let state = root.path().join("state");
    assert_eq!(
        probe(&state, &probe_environment(&system, search_path)).await,
        Policy::Unread
    );
}

/// Windows searches a relative entry from the server's directory, not each child's, so
/// every command still finds the same Git there.
#[tokio::test]
async fn a_relative_path_entry_keeps_the_policy_unread_on_unix() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(&system, AUTOCRLF).unwrap();
    let state = root.path().join("state");
    let relative_first = search_path(&[PathBuf::from("relative-bin")]);
    let policy = probe(&state, &probe_environment(&system, relative_first)).await;
    if cfg!(windows) {
        assert!(matches!(policy, Policy::KeysOnly(_)), "{policy:?}");
    } else {
        assert_eq!(policy, Policy::Unread);
    }
}

/// Git resolves a relative `GIT_CONFIG_SYSTEM` inside each repository.
#[tokio::test]
async fn a_relative_state_dir_keeps_the_policy_unread() {
    let root = tempfile::tempdir().unwrap();
    let system = root.path().join("system.gitconfig");
    fs::write(&system, AUTOCRLF).unwrap();
    // Relative to the package directory, inside the workspace's own `target`.
    let state = Path::new("../../target/git-system-config-relative-state");
    let policy = probe(state, &probe_environment(&system, search_path(&[]))).await;
    let _ = fs::remove_dir_all(state);
    assert_eq!(policy, Policy::Unread);
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
    assert_eq!(probe(&directory_state, &environment).await, Policy::Unread);

    let file_state = root.path().join("writable-file");
    fs::create_dir_all(file_state.join("git")).unwrap();
    let file = file_state.join("git").join(reference.file_name().unwrap());
    fs::copy(&reference, &file).unwrap();
    writable(&file).unwrap();
    assert_eq!(probe(&file_state, &environment).await, Policy::Unread);
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
    assert_eq!(policy, Policy::Unread);
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

// Checkpoints and the bootstrap fetch under the shared policy (#283).

const THREAD: &str = "thread";
const AUTOCRLF_FALSE: &str = "[core]\n\tautocrlf = false\n";

/// `<root>/repository` with `data.bin` holding [`CONTENT`], committed by the person's Git.
fn repository(root: &Path, attributes: Option<&str>) -> PathBuf {
    let repository = root.join("repository");
    fs::create_dir(&repository).expect("repository directory");
    git(&repository, &["init", "-q", "-b", "main"]);
    git(&repository, &["config", "core.autocrlf", "false"]);
    if let Some(attributes) = attributes {
        fs::write(repository.join(".gitattributes"), attributes).expect("attributes");
    }
    fs::write(repository.join("data.bin"), CONTENT).expect("data file");
    git(&repository, &["add", "-A"]);
    git(&repository, &["commit", "-q", "-m", "base"]);
    repository
}

/// [`repository`] with `data.bin` tracked by LFS, which the person's Git stored as a pointer.
fn lfs_repository(root: &Path) -> PathBuf {
    let repository = repository(root, Some("*.bin filter=lfs\n"));
    assert!(
        is_pointer(&git(&repository, &["cat-file", "-p", "HEAD:data.bin"])),
        "the person's Git stored no LFS pointer"
    );
    repository
}

fn is_pointer(bytes: &[u8]) -> bool {
    bytes.starts_with(b"version https://git-lfs.github.com/spec/v1\n")
}

/// The raw blob of `data.bin` in checkpoint `turn`.
fn checkpoint_blob(repository: &Path, turn: i64) -> Vec<u8> {
    let revision = format!("{}:data.bin", checkpoint_ref(THREAD, turn));
    git(repository, &["cat-file", "-p", &revision])
}

async fn capture(repository: &Path, turn: i64) {
    capture_checkpoint(repository, THREAD, turn)
        .await
        .expect("BiBCode captures a checkpoint");
}

async fn restore(repository: &Path, turn: i64) {
    assert!(
        restore_checkpoint_ref(repository, &checkpoint_ref(THREAD, turn))
            .await
            .expect("BiBCode restores a checkpoint"),
        "the checkpoint ref is missing"
    );
}

async fn delete(repository: &Path, turn: i64) {
    delete_checkpoint_ref(repository, &checkpoint_ref(THREAD, turn))
        .await
        .expect("BiBCode deletes a checkpoint ref");
}

/// Two captures, a restore of the first and the deletion of the second, as a turn and its
/// revert do.
async fn capture_restore_and_delete(repository: &Path) {
    capture(repository, 0).await;
    fs::write(repository.join("data.bin"), b"changed\n").expect("change the checkout");
    capture(repository, 1).await;
    restore(repository, 0).await;
    delete(repository, 1).await;
}

fn assert_hook_did_not_run(marker: &Path) {
    assert!(
        !marker.exists(),
        "a hook ran for {:?}",
        fs::read_to_string(marker).unwrap_or_default()
    );
}

/// The person's Git still runs the hook: the fixture is armed.
fn assert_hook_is_armed(repository: &Path, marker: &Path) {
    git(repository, &["update-ref", "refs/heads/hook-check", "HEAD"]);
    assert!(marker.exists(), "the fixture hook is not armed");
}

fn hooks_path_system(root: &str) -> String {
    format!("{AUTOCRLF_FALSE}\thooksPath = {root}/hooks\n")
}

fn arm_system_hook(root: &Path) -> PathBuf {
    fs::create_dir(root.join("hooks")).expect("hook directory");
    let marker = root.join("hook-ran");
    write_marker_hook(&root.join("hooks"), &marker);
    marker
}

/// An origin seeded from [`repository`], and a clone of it.
fn origin_and_clone(root: &Path) -> (PathBuf, PathBuf) {
    let seed = repository(root, None);
    git(root, &["clone", "-q", "--bare", "repository", "origin.git"]);
    git(root, &["clone", "-q", "origin.git", "clone"]);
    (seed, root.join("clone"))
}

#[tokio::test]
async fn an_old_pointer_checkpoint_restores_real_content_on_a_new_server() {
    let Some((phase_name, phase, root)) = in_processes(
        "an_old_pointer_checkpoint_restores_real_content_on_a_new_server",
        &["old-server", "new-server"],
        |_| LFS_SYSTEM.to_owned(),
        fake_git_lfs,
    ) else {
        return;
    };
    let repository = root.join("repository");
    if phase_name == "old-server" {
        // No policy is installed, so the capture reads the system file as an old server did.
        let repository = lfs_repository(&root);
        capture(&repository, 0).await;
        assert!(is_pointer(&checkpoint_blob(&repository, 0)));
    } else {
        install_keys_only(&root).await;
        // From here on only the generated file can bring the system LFS filter to restore.
        fs::write(root.join("system.gitconfig"), "").expect("empty the system file");
        fs::write(repository.join("data.bin"), b"changed\n").expect("change the checkout");
        restore(&repository, 0).await;
        assert_eq!(
            String::from_utf8_lossy(&fs::read(repository.join("data.bin")).unwrap()),
            String::from_utf8_lossy(CONTENT),
            "the old checkpoint restored pointer text"
        );
    }
    phase.complete();
}

#[tokio::test]
async fn a_system_hooks_path_runs_no_hook_during_capture_restore_or_ref_deletion() {
    let Some((phase, root)) = in_own_process(
        "a_system_hooks_path_runs_no_hook_during_capture_restore_or_ref_deletion",
        hooks_path_system,
    ) else {
        return;
    };
    let repository = repository(&root, None);
    install_keys_only(&root).await;
    let marker = arm_system_hook(&root);
    capture_restore_and_delete(&repository).await;
    assert_hook_did_not_run(&marker);
    assert_hook_is_armed(&repository, &marker);
    phase.complete();
}

/// `\dev\null\reference-transaction` on the checkout's drive, which a `/dev/null` hook path
/// would name on native Windows, and `nul\reference-transaction` in the checkout and in its
/// `.git`, which a `nul` hook path could name (made through `\\?\`, since Win32 reserves
/// `nul`). Removes what it created when dropped.
#[cfg(windows)]
struct PlantedNullHook(Vec<PathBuf>);

#[cfg(windows)]
impl PlantedNullHook {
    fn plant(checkout: &Path, marker: &Path) -> Option<Self> {
        let drive = checkout.ancestors().last()?;
        let null = drive.join("dev").join("null");
        if null.exists() {
            eprintln!("skipped the planted hook: {} exists", null.display());
            return None;
        }
        let verbatim = |path: PathBuf| {
            if path.to_string_lossy().starts_with(r"\\?\") {
                path
            } else {
                PathBuf::from(format!(r"\\?\{}", path.display()))
            }
        };
        let mut planted = Self(Vec::new());
        for directory in [
            drive.join("dev"),
            null.clone(),
            verbatim(checkout.join("nul")),
            verbatim(checkout.join(".git").join("nul")),
        ] {
            if directory.exists() {
                continue;
            }
            if let Err(error) = fs::create_dir(&directory) {
                eprintln!("skipped the planted hook: {error}");
                return None;
            }
            planted.0.push(directory);
        }
        for directory in [
            null,
            verbatim(checkout.join("nul")),
            verbatim(checkout.join(".git").join("nul")),
        ] {
            write_marker_hook(&directory, marker);
        }
        // Git for Windows cannot index a reserved name, so a capture's `add -A` would fail on it.
        let mut exclude = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(checkout.join(".git/info/exclude"))
            .ok()?;
        std::io::Write::write_all(&mut exclude, b"\n/nul/\n").ok()?;
        Some(planted)
    }
}

#[cfg(windows)]
impl Drop for PlantedNullHook {
    fn drop(&mut self) {
        for directory in self.0.iter().rev() {
            let _ = fs::remove_dir_all(directory);
        }
    }
}

#[tokio::test]
async fn a_repository_reference_transaction_hook_does_not_run_for_checkpoint_refs() {
    let Some((phase, root)) = in_own_process(
        "a_repository_reference_transaction_hook_does_not_run_for_checkpoint_refs",
        |_| AUTOCRLF_FALSE.to_owned(),
    ) else {
        return;
    };
    let repository = repository(&root, None);
    install_keys_only(&root).await;
    let marker = root.join("hook-ran");
    write_marker_hook(&repository.join(".git/hooks"), &marker);
    #[cfg(windows)]
    let planted_marker = root.join("planted-hook-ran");
    #[cfg(windows)]
    let planted = PlantedNullHook::plant(&repository, &planted_marker);
    capture(&repository, 0).await;
    fs::write(repository.join("data.bin"), b"changed\n").expect("change the checkout");
    capture(&repository, 1).await;
    delete(&repository, 1).await;
    #[cfg(windows)]
    if let Some(planted) = planted {
        drop(planted);
        assert_hook_did_not_run(&planted_marker);
    }
    assert_hook_did_not_run(&marker);
    commit_file(&repository, b"through the Git manager\n").await;
    assert!(
        marker.exists(),
        "the repository hook did not run for a Git manager branch update"
    );
    phase.complete();
}

#[tokio::test]
async fn the_bootstrap_fetch_carries_the_prompt_guards_and_the_policy() {
    let Some((_, phase, root)) = in_processes(
        "the_bootstrap_fetch_carries_the_prompt_guards_and_the_policy",
        &[PHASE],
        |_| AUTOCRLF_FALSE.to_owned(),
        |bin| fake_git(bin, "record"),
    ) else {
        return;
    };
    let (seed, clone) = origin_and_clone(&root);
    let generated = install_keys_only(&root).await;
    let commit = fetch_origin_base(&clone, "main", &CancellationToken::new())
        .await
        .expect("the bootstrap fetch");
    assert_eq!(
        commit,
        String::from_utf8_lossy(&git(&seed, &["rev-parse", "HEAD"])).trim()
    );
    let recorded = fs::read_to_string(root.join("bin/recorded")).expect("a recorded fetch");
    for expected in [
        "GCM_INTERACTIVE=never".to_owned(),
        "GIT_TERMINAL_PROMPT=0".to_owned(),
        format!("GIT_CONFIG_SYSTEM={}", generated.display()),
        "GIT_CONFIG_NOSYSTEM=<unset>".to_owned(),
    ] {
        assert!(
            recorded.lines().any(|line| line == expected),
            "{expected} missing from the fetch's environment:\n{recorded}"
        );
    }
    phase.complete();
}

#[tokio::test]
async fn a_system_textconv_or_other_filter_never_reaches_a_checkpoint() {
    let Some((phase, root)) = in_own_process(
        "a_system_textconv_or_other_filter_never_reaches_a_checkpoint",
        hostile_system,
    ) else {
        return;
    };
    let clone = crlf_clone(&root);
    arm_hostile_system(&root, &clone);
    install_keys_only(&root).await;
    fs::write(clone.join("other.txt"), b"other\n").expect("second filtered file");
    capture_checkpoint(&clone, THREAD, 0)
        .await
        .expect("capture");
    fs::write(clone.join("file.txt"), b"changed\n").expect("change the checkout");
    capture_checkpoint(&clone, THREAD, 1)
        .await
        .expect("capture");
    restore(&clone, 0).await;
    delete(&clone, 1).await;
    assert_nothing_ran(&root);
    assert_eq!(fs::read(clone.join("file.txt")).unwrap(), CRLF);
    phase.complete();
}

/// The system LFS group names the fake by its absolute path, a value BiBCode does not
/// recognize.
fn absolute_lfs_system(root: &str) -> String {
    let lfs = format!("'{root}/bin/{}'", executable_name("git-lfs"));
    format!(
        "[core]\n\thooksPath = {root}/hooks\n[filter \"lfs\"]\n\tclean = {lfs} clean -- %f\n\
         \tsmudge = {lfs} smudge -- %f\n\trequired = true\n"
    )
}

#[tokio::test]
async fn an_unrecognized_system_lfs_group_keeps_old_checkpoints_restoring() {
    let Some((_, phase, root)) = in_processes(
        "an_unrecognized_system_lfs_group_keeps_old_checkpoints_restoring",
        &[PHASE],
        absolute_lfs_system,
        fake_git_lfs,
    ) else {
        return;
    };
    let repository = lfs_repository(&root);
    capture(&repository, 0).await;
    assert!(is_pointer(&checkpoint_blob(&repository, 0)));
    assert_eq!(*install_once(&root.join("state")).await, Policy::Unread);
    let marker = arm_system_hook(&root);
    fs::write(repository.join("data.bin"), b"changed\n").expect("change the checkout");
    restore(&repository, 0).await;
    assert_eq!(fs::read(repository.join("data.bin")).unwrap(), CONTENT);
    fs::write(repository.join("data.bin"), b"new content\n").expect("change the checkout");
    capture(&repository, 1).await;
    assert!(is_pointer(&checkpoint_blob(&repository, 1)));
    delete(&repository, 1).await;
    assert_hook_did_not_run(&marker);
    assert_hook_is_armed(&repository, &marker);
    phase.complete();
}

#[tokio::test]
async fn a_failed_probe_runs_no_system_hook_during_the_bootstrap_fetch() {
    let Some((_, phase, root)) = in_processes(
        "a_failed_probe_runs_no_system_hook_during_the_bootstrap_fetch",
        &[PHASE],
        hooks_path_system,
        |bin| fake_git(bin, "old"),
    ) else {
        return;
    };
    let (seed, clone) = origin_and_clone(&root);
    fs::write(seed.join("data.bin"), b"next\n").expect("change the seed");
    git(&seed, &["commit", "-q", "-am", "next"]);
    git(&seed, &["push", "-q", "../origin.git", "main"]);
    assert_eq!(*install_once(&root.join("state")).await, Policy::Unread);
    let marker = arm_system_hook(&root);
    let commit = fetch_origin_base(&clone, "main", &CancellationToken::new())
        .await
        .expect("the bootstrap fetch");
    assert_eq!(
        commit,
        String::from_utf8_lossy(&git(&seed, &["rev-parse", "HEAD"])).trim(),
        "the fetch did not update refs/remotes/origin/main"
    );
    assert_hook_did_not_run(&marker);
    assert_hook_is_armed(&clone, &marker);
    phase.complete();
}

#[tokio::test]
async fn a_new_capture_stores_an_lfs_pointer() {
    let Some((_, phase, root)) = in_processes(
        "a_new_capture_stores_an_lfs_pointer",
        &[PHASE],
        |_| LFS_SYSTEM.to_owned(),
        fake_git_lfs,
    ) else {
        return;
    };
    let repository = lfs_repository(&root);
    install_keys_only(&root).await;
    fs::write(repository.join("data.bin"), b"new content\n").expect("change the checkout");
    capture(&repository, 0).await;
    assert!(
        is_pointer(&checkpoint_blob(&repository, 0)),
        "the capture stored the whole LFS file"
    );
    phase.complete();
}

#[tokio::test]
async fn a_full_content_blob_restores_unchanged_with_lfs_configured() {
    let Some((_, phase, root)) = in_processes(
        "a_full_content_blob_restores_unchanged_with_lfs_configured",
        &[PHASE],
        |_| LFS_SYSTEM.to_owned(),
        fake_git_lfs,
    ) else {
        return;
    };
    let repository = repository(&root, None);
    install_keys_only(&root).await;
    capture(&repository, 0).await;
    assert_eq!(checkpoint_blob(&repository, 0), CONTENT);
    fs::write(
        repository.join(".git/info/attributes"),
        "*.bin filter=lfs\n",
    )
    .expect("attributes");
    fs::write(repository.join("data.bin"), b"changed\n").expect("change the checkout");
    let calls = root.join("bin/calls");
    let _ = fs::remove_file(&calls);
    restore(&repository, 0).await;
    assert_eq!(fs::read(repository.join("data.bin")).unwrap(), CONTENT);
    assert!(
        fs::read_to_string(&calls)
            .unwrap_or_default()
            .lines()
            .any(|call| call == "smudge"),
        "the system LFS filter did not reach the restore"
    );
    phase.complete();
}

#[tokio::test]
async fn a_worktree_created_under_system_lfs_checks_out_real_content() {
    let Some((_, phase, root)) = in_processes(
        "a_worktree_created_under_system_lfs_checks_out_real_content",
        &[PHASE],
        |_| LFS_SYSTEM.to_owned(),
        fake_git_lfs,
    ) else {
        return;
    };
    let repository = lfs_repository(&root);
    install_keys_only(&root).await;
    GitRepository::default()
        .create_worktree(
            CreateWorktreeInput {
                cwd: repository,
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
        String::from_utf8_lossy(&fs::read(root.join("worktree/data.bin")).unwrap()),
        String::from_utf8_lossy(CONTENT),
        "BiBCode's worktree checked out LFS pointer text"
    );
    phase.complete();
}

#[tokio::test]
async fn an_unread_policy_keeps_checkpoints_on_the_inherited_system_file() {
    let Some((_, phase, root)) = in_processes(
        "an_unread_policy_keeps_checkpoints_on_the_inherited_system_file",
        &[PHASE],
        |_| LFS_SYSTEM.to_owned(),
        |bin| {
            fake_git_lfs(bin);
            fake_git(bin, "old");
        },
    ) else {
        return;
    };
    let repository = lfs_repository(&root);
    assert_eq!(*install_once(&root.join("state")).await, Policy::Unread);
    fs::write(repository.join("data.bin"), b"new content\n").expect("change the checkout");
    capture(&repository, 0).await;
    assert!(is_pointer(&checkpoint_blob(&repository, 0)));
    phase.complete();
}

#[tokio::test]
async fn a_failed_lfs_smudge_fails_the_restore_under_required() {
    let Some((_, phase, root)) = in_processes(
        "a_failed_lfs_smudge_fails_the_restore_under_required",
        &[PHASE],
        |_| LFS_SYSTEM.to_owned(),
        fake_git_lfs,
    ) else {
        return;
    };
    let repository = lfs_repository(&root);
    install_keys_only(&root).await;
    capture(&repository, 0).await;
    fs::write(repository.join("data.bin"), b"changed\n").expect("change the checkout");
    fs::write(root.join("bin/smudge-fails"), "").expect("make the smudge fail");
    assert!(
        restore_checkpoint_ref(&repository, &checkpoint_ref(THREAD, 0))
            .await
            .is_err(),
        "a failed required smudge did not fail the restore"
    );
    phase.complete();
}

#[tokio::test]
async fn the_system_tls_keys_reach_production_git() {
    let root = tempfile::tempdir().unwrap();
    let ca = root.path().join("ca.pem");
    fs::write(&ca, "fixture CA\n").unwrap();
    let ca = slashes(&ca);
    let system = root.path().join("system.gitconfig");
    let global = root.path().join("global.gitconfig");
    fs::write(&global, "").unwrap();
    let probe_system = |contents: String, state: &str| {
        fs::write(&system, contents).unwrap();
        let state = root.path().join(state);
        let environment = probe_environment(&system, search_path(&[]));
        async move {
            match probe(&state, &environment).await {
                Policy::KeysOnly(generated) => generated,
                policy => panic!("the fixture TLS keys were not kept: {policy:?}"),
            }
        }
    };
    // Git under the system variable `git_environment()` passes for a `KeysOnly` policy.
    let scoped = |generated: &Path, key: &str| {
        let output = Command::new("git")
            .args(["config", "--show-scope", "--get", key])
            .current_dir(root.path())
            .env_remove("GIT_CONFIG_NOSYSTEM")
            .env("GIT_CONFIG_SYSTEM", generated)
            .env("GIT_CONFIG_GLOBAL", &global)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    for (backend, canonical) in [("OpenSSL", "openssl"), ("schannel", "schannel")] {
        let generated = probe_system(
            format!("[http]\n\tsslBackend = {backend}\n\tsslCAInfo = {ca}\n"),
            canonical,
        )
        .await;
        assert_eq!(
            scoped(&generated, "http.sslcainfo"),
            format!("system\t{ca}\n")
        );
        assert_eq!(
            scoped(&generated, "http.sslbackend"),
            format!("system\t{canonical}\n")
        );
    }
    // A `\` in the path survives the quoted Git string (on Windows the separator itself).
    let backslash = root.path().join(if cfg!(windows) {
        "backslash.pem"
    } else {
        "back\\slash.pem"
    });
    fs::write(&backslash, "fixture CA\n").unwrap();
    let backslash = backslash.to_string_lossy().into_owned();
    let generated = probe_system(
        format!(
            "[http]\n\tsslCAInfo = \"{}\"\n",
            backslash.replace('\\', "\\\\")
        ),
        "backslash",
    )
    .await;
    assert_eq!(
        scoped(&generated, "http.sslcainfo"),
        format!("system\t{backslash}\n")
    );
    for unusable in [
        "ca.pem".to_owned(),
        format!("{ca}.missing"),
        format!("\"{ca}\\nsecond line\""),
    ] {
        let generated = probe_system(
            format!("[http]\n\tsslBackend = openssl\n\tsslCAInfo = {unusable}\n"),
            "unusable",
        )
        .await;
        assert_eq!(
            fs::read_to_string(&generated).unwrap(),
            "[http]\n\tsslBackend = openssl\n",
            "{unusable:?} was kept"
        );
    }
}
