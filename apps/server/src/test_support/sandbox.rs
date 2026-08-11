use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
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

    #[cfg(unix)]
    pub(crate) fn executable_script(
        &self,
        name: &str,
        unix_body: &str,
        _windows_body: &str,
    ) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = self.path(format!("{name}.sh"));
        std::fs::write(&path, format!("#!/bin/sh\n{unix_body}\n"))
            .expect("write test fixture script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .expect("set test fixture script permissions");
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
