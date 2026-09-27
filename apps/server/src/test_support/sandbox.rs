use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
#[cfg(unix)]
use std::{
    ffi::OsStr,
    io::{Read, Write},
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
            environment: std::env::vars_os().collect(),
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
            .unwrap_or_else(|| panic!("{name} executable was not found on captured PATH"))
    }

    #[cfg(unix)]
    pub(crate) fn run_isolated_case(
        &self,
        case: &str,
        test_name: &str,
        environment: &[(&str, &OsStr)],
    ) -> Output {
        let mut child = Command::new(std::env::current_exe().expect("current test binary"))
            .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
            .envs(environment.iter().map(|(name, value)| (*name, *value)))
            .env("BIBCODE_TEST_ISOLATED_CASE", case)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("run isolated fixture case");
        let mut stdout = child.stdout.take().expect("isolated child stdout");
        let mut stderr = child.stderr.take().expect("isolated child stderr");
        let stdout_reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout
                .read_to_end(&mut bytes)
                .expect("read isolated child stdout");
            bytes
        });
        let stderr_reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr
                .read_to_end(&mut bytes)
                .expect("read isolated child stderr");
            bytes
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        let (status, timed_out) = loop {
            if let Some(status) = child.try_wait().expect("poll isolated fixture case") {
                break (status, false);
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
        assert!(
            !timed_out,
            "isolated fixture case timed out:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        );
        Output {
            status,
            stdout,
            stderr,
        }
    }

    #[cfg(unix)]
    pub(crate) fn is_isolated_case(case: &str, test_name: &str) -> bool {
        let arguments = std::env::args_os().collect::<Vec<_>>();
        std::env::var_os("BIBCODE_TEST_ISOLATED_CASE").as_deref() == Some(OsStr::new(case))
            && arguments
                .windows(2)
                .any(|values| values == [OsStr::new("--exact"), OsStr::new(test_name)])
            && arguments
                .iter()
                .any(|value| value == OsStr::new("--test-threads=1"))
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

    /// Linux refuses to exec a file held open for writing by any process (`ETXTBSY`).
    /// A fork on another test thread inherits every open descriptor until exec, so
    /// writing here can leave a script busy when the test runs it. A short-lived
    /// child writes the file; this process only sets its mode. A temporary name
    /// followed by rename cannot help: inherited descriptors refer to the same inode.
    #[cfg(unix)]
    pub(crate) fn write_executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        let mut child = Command::new("/bin/sh")
            .args(["-c", "exec cat > \"$1\"", "sh"])
            .arg(path)
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|error| {
                panic!("spawn test fixture writer for {}: {error}", path.display())
            });
        let mut stdin = child.stdin.take().expect("test fixture writer stdin");
        let write_result = stdin.write_all(contents.as_bytes());
        drop(stdin);
        let output = child.wait_with_output().unwrap_or_else(|error| {
            panic!(
                "wait for test fixture writer for {}: {error}",
                path.display()
            )
        });
        assert!(
            output.status.success() && write_result.is_ok(),
            "write test fixture script {} failed: status {}; stdin: {write_result:?}; stderr:\n{}",
            path.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .expect("set test fixture script permissions");
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
        std::fs::write(&path, format!("{windows_body}\r\n")).expect("write test fixture script");
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
        process::Command,
        sync::{
            Barrier,
            atomic::{AtomicBool, Ordering},
        },
        thread,
    };

    use super::TestSandbox;

    #[test]
    fn executable_scripts_run_during_concurrent_forks() {
        const CASE: &str = "executable-scripts-concurrent-forks";
        const TEST_NAME: &str =
            "test_support::sandbox::tests::executable_scripts_run_during_concurrent_forks";

        let sandbox = TestSandbox::new("executable-scripts-concurrent-forks");
        if TestSandbox::is_isolated_case(CASE, TEST_NAME) {
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
                    for index in 0..1000 {
                        let script =
                            sandbox.executable_script(&format!("fixture-{index}"), "exit 0", "");
                        match Command::new(&script).status() {
                            Ok(status) => assert!(
                                status.success(),
                                "fixture {} failed: {status}",
                                script.display()
                            ),
                            Err(error) if error.kind() == ErrorKind::ExecutableFileBusy => {
                                panic!(
                                    "fixture {index} execution hit ETXTBSY: a concurrent fork inherited a writable script descriptor"
                                );
                            }
                            Err(error) => panic!("execute fixture {}: {error}", script.display()),
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

        let output = sandbox.run_isolated_case(CASE, TEST_NAME, &[]);
        assert!(
            output.status.success(),
            "isolated executable-script fork storm failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
