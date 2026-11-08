use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use std::{
    ffi::OsStr,
    io::Read,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

use tempfile::TempDir;

use crate::process::ProcessRunInput;

#[derive(Debug)]
pub(crate) struct TestSandbox {
    root: TempDir,
    environment: BTreeMap<OsString, OsString>,
    active: Arc<AtomicUsize>,
    maximum: Arc<AtomicUsize>,
}

#[derive(Debug)]
pub(crate) struct FixtureLease {
    active: Arc<AtomicUsize>,
}

impl TestSandbox {
    pub(crate) fn new(name: &str) -> Self {
        let root = tempfile::Builder::new()
            .prefix(&format!("bibcode-server-{name}-"))
            .tempdir()
            .expect("test sandbox temporary root");
        Self {
            root,
            environment: std::env::vars_os()
                .filter(|(name, _)| !super::isolated_git_config::is_git_environment_variable(name))
                .collect(),
            active: Arc::new(AtomicUsize::new(0)),
            maximum: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub(crate) fn root(&self) -> &Path {
        self.root.path()
    }

    pub(crate) fn path(&self, path: impl AsRef<Path>) -> PathBuf {
        self.root().join(path)
    }

    pub(crate) fn environment<I, K, V>(&self, overrides: I) -> BTreeMap<String, String>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let mut environment = self
            .environment
            .iter()
            .filter_map(|(key, value)| {
                Some((
                    key.clone().into_string().ok()?,
                    value.clone().into_string().ok()?,
                ))
            })
            .collect::<BTreeMap<_, _>>();
        environment.extend(
            overrides
                .into_iter()
                .map(|(key, value)| (key.into(), value.into())),
        );
        environment
    }

    pub(crate) fn executable_on_path(&self, name: &str) -> PathBuf {
        let path = self
            .environment
            .iter()
            .find(|(key, _)| {
                key.to_str()
                    .is_some_and(|key| key.eq_ignore_ascii_case("PATH"))
            })
            .map(|(_, value)| value.as_os_str())
            .expect("test sandbox captured PATH");
        let executable_names = if cfg!(windows) {
            vec![
                name.to_owned(),
                format!("{name}.exe"),
                format!("{name}.cmd"),
                format!("{name}.bat"),
            ]
        } else {
            vec![name.to_owned()]
        };
        std::env::split_paths(path)
            .flat_map(|directory| {
                executable_names
                    .iter()
                    .map(move |name| directory.join(name))
            })
            .find(|candidate| candidate.is_file())
            .and_then(|candidate| std::fs::canonicalize(candidate).ok())
            // Fixture scripts run it through `cmd`, which cannot start a `\\?\` path.
            .map(crate::production::host_paths::process_compatible_path)
            .unwrap_or_else(|| panic!("{name} executable was not found on captured PATH"))
    }

    pub(crate) fn run_isolated_case(
        &self,
        case: &str,
        test_name: &str,
        environment: &[(&str, &OsStr)],
    ) -> Output {
        self.run_isolated_case_without_environment(case, test_name, environment, &[])
    }

    pub(crate) fn run_isolated_case_without_environment(
        &self,
        case: &str,
        test_name: &str,
        environment: &[(&str, &OsStr)],
        removed: &[&str],
    ) -> Output {
        let mut command = Command::new(std::env::current_exe().expect("current test binary"));
        command
            .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
            .envs(environment.iter().map(|(name, value)| (*name, *value)))
            .env("BIBCODE_TEST_ISOLATED_CASE", case);
        for name in removed {
            command.env_remove(name);
        }
        let (output, timed_out) =
            run_until_deadline(command, ISOLATED_CASE_START_BOUND, ISOLATED_CASE_RUN_BOUND);
        assert!(
            !timed_out,
            "isolated fixture case timed out:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    pub(crate) fn is_isolated_case(case: &str, test_name: &str) -> bool {
        let arguments = std::env::args_os().collect::<Vec<_>>();
        let selected =
            std::env::var_os("BIBCODE_TEST_ISOLATED_CASE").as_deref() == Some(OsStr::new(case));
        let valid_arguments = arguments
            .windows(2)
            .any(|values| values == [OsStr::new("--exact"), OsStr::new(test_name)])
            && arguments
                .iter()
                .any(|value| value == OsStr::new("--test-threads=1"));
        assert!(
            !selected || valid_arguments,
            "isolated fixture {case} requires --exact {test_name} and --test-threads=1; refusing recursive relaunch"
        );
        selected
    }

    pub(crate) fn process_input(
        &self,
        executable: impl AsRef<Path>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> ProcessRunInput {
        let mut input =
            ProcessRunInput::new(executable.as_ref().to_string_lossy().into_owned(), args);
        input.spawn_cwd = Some(self.root().to_path_buf());
        input.env = Some(self.environment(std::iter::empty::<(String, String)>()));
        input
    }

    #[cfg(unix)]
    pub(crate) fn write_executable(path: &Path, contents: &str) {
        super::executable_fixture::write_executable(path, contents);
    }

    #[cfg(unix)]
    pub(crate) fn executable_script(
        &self,
        name: &str,
        unix_body: &str,
        _windows_body: &str,
    ) -> PathBuf {
        let path = self.path(format!("{name}.sh"));
        let contents = format!("#!/bin/sh\n{unix_body}\n");
        Self::write_executable(&path, &contents);
        path
    }

    #[cfg(windows)]
    pub(crate) fn executable_script(
        &self,
        name: &str,
        _unix_body: &str,
        windows_body: &str,
    ) -> PathBuf {
        let path = self.path(format!("{name}.cmd"));
        super::executable_fixture::write_executable(&path, format!("{windows_body}\r\n"));
        path
    }

    pub(crate) fn acquire_fixture(&self) -> FixtureLease {
        let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
        self.maximum.fetch_max(active, Ordering::AcqRel);
        FixtureLease {
            active: self.active.clone(),
        }
    }

    pub(crate) fn active_fixtures(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }

    pub(crate) fn maximum_active_fixtures(&self) -> usize {
        self.maximum.load(Ordering::Acquire)
    }
}

const ISOLATED_CASE_START_BOUND: Duration = Duration::from_secs(60);
const ISOLATED_CASE_RUN_BOUND: Duration = Duration::from_secs(10);

/// Runs `command` with piped output. It gets `run_bound` from its first stdout byte (libtest
/// prints its header before any test runs) and is killed at that point, or at `start_bound`
/// if it never writes. A loaded macOS host can hold a child back for tens of seconds before
/// it runs at all (#335), so the run bound does not count that wait. `true` when killed.
fn run_until_deadline(
    mut command: Command,
    start_bound: Duration,
    run_bound: Duration,
) -> (Output, bool) {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run isolated fixture case");
    let mut stdout = child.stdout.take().expect("isolated child stdout");
    let mut stderr = child.stderr.take().expect("isolated child stderr");
    let (started_sender, started) = std::sync::mpsc::channel();
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            let read = stdout.read(&mut chunk).expect("read isolated child stdout");
            if read == 0 {
                break bytes;
            }
            if bytes.is_empty() {
                let _ = started_sender.send(Instant::now());
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .read_to_end(&mut bytes)
            .expect("read isolated child stderr");
        bytes
    });
    let mut deadline = Instant::now() + start_bound;
    let mut waiting_for_start = true;
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().expect("poll isolated fixture case") {
            break (status, false);
        }
        if waiting_for_start && let Ok(started_at) = started.try_recv() {
            waiting_for_start = false;
            deadline = started_at + run_bound;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            break (
                child.wait().expect("reap timed-out isolated fixture case"),
                true,
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let stdout = stdout_reader.join().expect("join isolated stdout reader");
    let stderr = stderr_reader.join().expect("join isolated stderr reader");
    (
        Output {
            status,
            stdout,
            stderr,
        },
        timed_out,
    )
}

#[cfg(all(test, unix))]
mod deadline_tests {
    use std::{process::Command, time::Duration};

    use super::run_until_deadline;

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn a_case_that_starts_late_gets_its_whole_run_bound() {
        // A loaded host can hold a child back before it runs at all (#335).
        let (output, timed_out) = run_until_deadline(
            shell("sleep 1; echo started; sleep 0.1; echo done"),
            Duration::from_secs(30),
            Duration::from_millis(500),
        );
        assert!(!timed_out, "a late start is not a hang: {output:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "started\ndone\n");
    }

    #[test]
    fn a_case_that_hangs_after_starting_is_killed_at_its_run_bound() {
        let (output, timed_out) = run_until_deadline(
            shell("echo started; exec sleep 30"),
            Duration::from_secs(30),
            Duration::from_millis(500),
        );
        assert!(timed_out);
        assert_eq!(String::from_utf8_lossy(&output.stdout), "started\n");
    }

    #[test]
    fn a_case_that_never_starts_is_killed_at_its_start_bound() {
        let (output, timed_out) = run_until_deadline(
            shell("exec sleep 30"),
            Duration::from_millis(500),
            Duration::from_secs(30),
        );
        assert!(timed_out);
        assert!(output.stdout.is_empty());
    }
}

impl Drop for FixtureLease {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::{
        io::ErrorKind,
        os::unix::process::CommandExt,
        panic::RefUnwindSafe,
        path::{Path, PathBuf},
        process::Command,
        sync::{
            Barrier,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::{Duration, Instant},
    };

    use super::TestSandbox;

    fn assert_fixtures_run_during_fork_storm(
        case: &str,
        test_name: &str,
        label: &str,
        make_fixture: impl Fn(&TestSandbox, usize) -> PathBuf + RefUnwindSafe,
    ) {
        let sandbox = TestSandbox::new(case);
        if TestSandbox::is_isolated_case(case, test_name) {
            let stop = AtomicBool::new(false);
            let start = Barrier::new(5);
            thread::scope(|scope| {
                let workers = (0..4)
                    .map(|_| {
                        scope.spawn(|| {
                            start.wait();
                            while !stop.load(Ordering::Relaxed) {
                                let mut command = Command::new("/bin/true");
                                // SAFETY: The hook only calls async-signal-safe poll
                                // after fork; it neither allocates nor acquires locks.
                                unsafe {
                                    command.pre_exec(|| {
                                        libc::poll(std::ptr::null_mut(), 0, 2);
                                        Ok(())
                                    });
                                }
                                let status = command.status().expect("spawn fork-storm child");
                                assert!(status.success(), "fork-storm child failed: {status}");
                            }
                        })
                    })
                    .collect::<Vec<_>>();
                start.wait();

                let result = std::panic::catch_unwind(|| {
                    // Leave room for cleanup before the isolated-case deadline under load.
                    let deadline = Instant::now() + Duration::from_secs(2);
                    for index in 0..1000 {
                        if Instant::now() >= deadline {
                            break;
                        }
                        let fixture = make_fixture(&sandbox, index);
                        match Command::new(&fixture).status() {
                            Ok(status) => assert!(
                                status.success(),
                                "fixture {} failed: {status}",
                                fixture.display()
                            ),
                            Err(error) if error.kind() == ErrorKind::ExecutableFileBusy => {
                                panic!(
                                    "fixture {index} execution hit ETXTBSY after {index} fixtures executed: a concurrent fork inherited a writable {label} descriptor"
                                );
                            }
                            Err(error) => panic!("execute fixture {}: {error}", fixture.display()),
                        }
                    }
                });
                stop.store(true, Ordering::Relaxed);
                for worker in workers {
                    worker.join().expect("join fork-storm worker");
                }
                result.unwrap_or_else(|payload| std::panic::resume_unwind(payload))
            });
            return;
        }

        let output = sandbox.run_isolated_case(case, test_name, &[]);
        assert!(
            output.status.success(),
            "isolated {label} fork storm failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn executable_scripts_run_during_concurrent_forks() {
        assert_fixtures_run_during_fork_storm(
            "executable-scripts-concurrent-forks",
            "test_support::sandbox::tests::executable_scripts_run_during_concurrent_forks",
            "script",
            |sandbox, index| sandbox.executable_script(&format!("fixture-{index}"), "exit 0", ""),
        );
    }

    #[test]
    fn copied_executables_run_during_concurrent_forks() {
        assert_fixtures_run_during_fork_storm(
            "copied-executables-concurrent-forks",
            "test_support::sandbox::tests::copied_executables_run_during_concurrent_forks",
            "copied executable",
            |sandbox, index| {
                let fixture = sandbox.path(format!("fixture-{index}"));
                crate::test_support::executable_fixture::copy_executable(
                    Path::new("/bin/true"),
                    &fixture,
                );
                fixture
            },
        );
    }
}
