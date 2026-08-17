#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
#[cfg(windows)]
use process_wrap::tokio::{ChildWrapper, CommandWrapper};
use process_wrap::tokio::{CommandWrap, KillOnDrop};
#[cfg(windows)]
use std::{future::Future, pin::Pin, process::ExitStatus, sync::Arc, time::Duration};
use tokio::process::Command;

#[cfg(windows)]
use super::WindowsJob;

/// Configures a non-interactive Tokio child process so a GUI parent does not
/// flash a console window on Windows.
pub fn configure_background_command(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = command;
}

/// Configures a non-interactive standard-library child process so a GUI parent
/// does not flash a console window on Windows.
pub fn configure_background_std_command(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug)]
struct WindowsSupervisedJob;

#[cfg(windows)]
impl CommandWrapper for WindowsSupervisedJob {
    fn pre_spawn(&mut self, command: &mut Command, _core: &CommandWrap) -> std::io::Result<()> {
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        Ok(())
    }

    fn wrap_child(
        &mut self,
        inner: Box<dyn ChildWrapper>,
        _core: &CommandWrap,
    ) -> std::io::Result<Box<dyn ChildWrapper>> {
        let process_handle = inner
            .inner_child()
            .raw_handle()
            .ok_or_else(|| std::io::Error::other("supervised child has no process handle"))?;
        let job = Arc::new(WindowsJob::new()?);
        job.assign_process(process_handle)?;
        WindowsJob::resume_process_threads(process_handle)?;
        Ok(Box::new(WindowsSupervisedChild {
            inner,
            job,
            exit_status: None,
        }))
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsSupervisedChild {
    inner: Box<dyn ChildWrapper>,
    job: Arc<WindowsJob>,
    exit_status: Option<ExitStatus>,
}

#[cfg(windows)]
impl ChildWrapper for WindowsSupervisedChild {
    fn inner(&self) -> &dyn ChildWrapper {
        self.inner.as_ref()
    }

    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        self.inner.as_mut()
    }

    fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
        let Self { inner, .. } = *self;
        inner
    }

    fn start_kill(&mut self) -> std::io::Result<()> {
        self.job.terminate()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        if let Some(status) = self.exit_status {
            return Ok(Some(status));
        }
        let Some(status) = self.inner.try_wait()? else {
            return Ok(None);
        };
        self.job.terminate()?;
        if !self.job.wait_for_exit(Duration::ZERO)? {
            return Ok(None);
        }
        self.exit_status = Some(status);
        Ok(Some(status))
    }

    fn wait(&mut self) -> Pin<Box<dyn Future<Output = std::io::Result<ExitStatus>> + Send + '_>> {
        Box::pin(async move {
            if let Some(status) = self.exit_status {
                return Ok(status);
            }
            let status = self.inner.wait().await?;
            self.job.terminate()?;
            if !self.job.wait_for_exit(Duration::ZERO)? {
                let job = Arc::clone(&self.job);
                tokio::task::spawn_blocking(move || job.wait_for_exit_unbounded())
                    .await
                    .map_err(std::io::Error::other)??;
            }
            self.exit_status = Some(status);
            Ok(status)
        })
    }
}

/// Applies the platform process-tree supervision policy for a non-interactive
/// background command.
pub fn configure_supervised_background_command_wrap(command: &mut CommandWrap) {
    command.wrap(KillOnDrop);
    #[cfg(windows)]
    command.wrap(WindowsSupervisedJob);
    #[cfg(unix)]
    command.wrap(ProcessGroup::leader());
}

#[cfg(all(test, windows))]
mod tests {
    use std::process::Stdio;

    use process_wrap::tokio::CommandWrap;
    use tokio::io::AsyncReadExt;
    use windows_sys::Win32::System::Console::GetConsoleWindow;

    use super::{configure_background_command, configure_supervised_background_command_wrap};

    const CONSOLE_PROBE_ENV: &str = "BIBCODE_WINDOWS_CONSOLE_PROBE";
    const CONSOLE_PROBE_MARKER: &str = "BIBCODE_HAS_CONSOLE=";
    const WAIT_PROBE_ENV: &str = "BIBCODE_WINDOWS_JOB_WAIT_PROBE";

    #[test]
    fn windows_child_console_probe() {
        if std::env::var_os(CONSOLE_PROBE_ENV).is_some() {
            // SAFETY: GetConsoleWindow takes no arguments and only reads the
            // calling process's console association.
            let has_console = !unsafe { GetConsoleWindow() }.is_null();
            println!("{CONSOLE_PROBE_MARKER}{has_console}");
        }
    }

    #[test]
    fn windows_child_job_wait_probe() {
        if std::env::var_os(WAIT_PROBE_ENV).is_some() {
            std::thread::park();
        }
    }

    #[tokio::test]
    async fn supervised_background_wait_survives_post_kill_status_probes() {
        let executable = std::env::current_exe().expect("current test executable should resolve");
        let mut command = CommandWrap::with_new(executable, |command| {
            command
                .args([
                    "--exact",
                    "process::background::tests::windows_child_job_wait_probe",
                    "--nocapture",
                ])
                .env(WAIT_PROBE_ENV, "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        });
        configure_supervised_background_command_wrap(&mut command);

        let mut child = command.spawn().expect("wrapped wait probe should start");
        child
            .start_kill()
            .expect("wrapped wait probe job should terminate");
        // SAFETY: this test deliberately reaps only the raw root while retaining
        // the wrapper so repeated non-consuming tree-status probes can be verified.
        unsafe { child.inner_child_mut() }
            .wait()
            .await
            .expect("wrapped wait probe root should exit");
        for _ in 0..16 {
            assert!(
                child
                    .try_wait()
                    .expect("wrapped wait probe status should be readable")
                    .is_some()
            );
        }

        tokio::time::timeout(std::time::Duration::from_secs(1), child.wait())
            .await
            .expect("wrapped job wait must not lose its terminal notification")
            .expect("wrapped job should finish reaping");
    }

    #[tokio::test]
    async fn background_tokio_command_has_no_console() {
        let mut command = tokio::process::Command::new(
            std::env::current_exe().expect("current test executable should resolve"),
        );
        command
            .args([
                "--exact",
                "process::background::tests::windows_child_console_probe",
                "--nocapture",
            ])
            .env(CONSOLE_PROBE_ENV, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_background_command(&mut command);

        let output = command
            .output()
            .await
            .expect("background console probe should run");
        assert!(output.status.success(), "console probe failed: {output:?}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains(&format!("{CONSOLE_PROBE_MARKER}false")),
            "background process unexpectedly inherited a console: {stdout}"
        );
    }

    #[tokio::test]
    async fn supervised_background_command_has_no_console() {
        let executable = std::env::current_exe().expect("current test executable should resolve");
        let mut command = CommandWrap::with_new(executable, |command| {
            command
                .args([
                    "--exact",
                    "process::background::tests::windows_child_console_probe",
                    "--nocapture",
                ])
                .env(CONSOLE_PROBE_ENV, "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        });
        configure_supervised_background_command_wrap(&mut command);

        let mut child = command
            .spawn()
            .expect("wrapped background console probe should run");
        let mut stdout = child
            .stdout()
            .take()
            .expect("wrapped console probe should expose stdout");
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .await
            .expect("wrapped console probe stdout should be readable");
        let status = child
            .wait()
            .await
            .expect("wrapped console probe should complete");
        assert!(status.success(), "wrapped console probe failed: {status}");
        let stdout = String::from_utf8_lossy(&bytes);
        assert!(
            stdout.contains(&format!("{CONSOLE_PROBE_MARKER}false")),
            "wrapped background process unexpectedly inherited a console: {stdout}"
        );
    }

    #[tokio::test]
    async fn supervised_background_cmd_shim_has_no_console() {
        let executable = std::env::current_exe().expect("current test executable should resolve");
        let mut command = CommandWrap::with_new("cmd.exe", |command| {
            command
                .args(["/d", "/s", "/c"])
                .arg(executable)
                .args([
                    "--exact",
                    "process::background::tests::windows_child_console_probe",
                    "--nocapture",
                ])
                .env(CONSOLE_PROBE_ENV, "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        });
        configure_supervised_background_command_wrap(&mut command);

        let mut child = command
            .spawn()
            .expect("wrapped cmd console probe should run");
        let mut stdout = child
            .stdout()
            .take()
            .expect("wrapped cmd console probe should expose stdout");
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .await
            .expect("wrapped cmd console probe stdout should be readable");
        let status = child
            .wait()
            .await
            .expect("wrapped cmd console probe should complete");
        assert!(status.success(), "wrapped cmd probe failed: {status}");
        let stdout = String::from_utf8_lossy(&bytes);
        assert!(
            stdout.contains(&format!("{CONSOLE_PROBE_MARKER}false")),
            "wrapped cmd process unexpectedly inherited a console: {stdout}"
        );
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::{configure_background_command, configure_background_std_command};

    #[test]
    fn background_configuration_is_a_noop_on_unix_commands() {
        let mut tokio_command = tokio::process::Command::new("true");
        configure_background_command(&mut tokio_command);

        let mut std_command = std::process::Command::new("true");
        configure_background_std_command(&mut std_command);
    }
}
