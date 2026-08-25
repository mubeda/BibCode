mod linux;
mod macos;
pub mod model;
mod windows;

use std::{future::Future, pin::Pin, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

pub use model::{
    CommandFailure, CommandOutput, CommandSpec, NativeUser, ServiceError, ServiceInstallResult,
    ServiceMode, ServicePlatform, ServiceState, ServiceStatus, ServiceTarget,
    ServiceUninstallResult,
};

use self::{
    linux::LinuxAdapter,
    macos::MacOsAdapter,
    model::{CommandStep, bounded_diagnostic},
    windows::WindowsAdapter,
};

const MAX_COMMAND_OUTPUT_BYTES: usize = 64 * 1024;
const SERVICE_STATE_DEADLINE: Duration = Duration::from_secs(20);
const SERVICE_STATE_POLL_INTERVAL: Duration = Duration::from_millis(100);

pub trait CommandRunner: Send + Sync {
    fn run(
        &self,
        command: CommandSpec,
    ) -> Pin<Box<dyn Future<Output = Result<CommandOutput, CommandFailure>> + Send + 'static>>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(
        &self,
        command: CommandSpec,
    ) -> Pin<Box<dyn Future<Output = Result<CommandOutput, CommandFailure>> + Send + 'static>> {
        Box::pin(async move {
            let mut process = Command::new(&command.program);
            process
                .args(&command.args)
                .kill_on_drop(true)
                .stdin(if command.stdin.is_some() {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = process
                .spawn()
                .map_err(|error| CommandFailure::Io(error.to_string()))?;
            if let Some(stdin) = command.stdin
                && let Some(mut child_stdin) = child.stdin.take()
            {
                child_stdin
                    .write_all(&stdin)
                    .await
                    .map_err(|error| CommandFailure::Io(error.to_string()))?;
                child_stdin
                    .shutdown()
                    .await
                    .map_err(|error| CommandFailure::Io(error.to_string()))?;
            }
            let stdout = child.stdout.take().ok_or_else(|| {
                CommandFailure::Io("the service command stdout pipe was unavailable".to_owned())
            })?;
            let stderr = child.stderr.take().ok_or_else(|| {
                CommandFailure::Io("the service command stderr pipe was unavailable".to_owned())
            })?;
            let execution = async {
                tokio::try_join!(
                    async {
                        child
                            .wait()
                            .await
                            .map_err(|error| CommandFailure::Io(error.to_string()))
                    },
                    read_bounded_output(stdout),
                    read_bounded_output(stderr),
                )
            };
            let (status, stdout, stderr) = match timeout(command.timeout, execution).await {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err(error);
                }
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err(CommandFailure::Timeout);
                }
            };
            Ok(CommandOutput {
                exit_code: status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            })
        })
    }
}

async fn read_bounded_output<R>(reader: R) -> Result<Vec<u8>, CommandFailure>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    reader
        .take(u64::try_from(MAX_COMMAND_OUTPUT_BYTES + 1).expect("bounded output size"))
        .read_to_end(&mut output)
        .await
        .map_err(|error| CommandFailure::Io(error.to_string()))?;
    if output.len() > MAX_COMMAND_OUTPUT_BYTES {
        return Err(CommandFailure::OutputTooLarge);
    }
    Ok(output)
}

#[derive(Clone, Debug)]
enum AdapterKind {
    Linux(LinuxAdapter),
    MacOs(MacOsAdapter),
    Windows(WindowsAdapter),
}

#[derive(Clone, Debug)]
pub struct ServiceAdapter {
    inner: AdapterKind,
}

impl ServiceAdapter {
    pub fn native(target: ServiceTarget) -> Result<Self, ServiceError> {
        #[cfg(target_os = "linux")]
        {
            return Self::linux(target);
        }
        #[cfg(target_os = "macos")]
        {
            return Self::macos(target);
        }
        #[cfg(target_os = "windows")]
        {
            return Self::windows(target);
        }
        #[allow(unreachable_code)]
        Err(ServiceError::UnsupportedPlatform)
    }

    pub fn linux(target: ServiceTarget) -> Result<Self, ServiceError> {
        LinuxAdapter::new(target).map(|adapter| Self {
            inner: AdapterKind::Linux(adapter),
        })
    }

    pub fn macos(target: ServiceTarget) -> Result<Self, ServiceError> {
        MacOsAdapter::new(target).map(|adapter| Self {
            inner: AdapterKind::MacOs(adapter),
        })
    }

    pub fn windows(target: ServiceTarget) -> Result<Self, ServiceError> {
        WindowsAdapter::new(target).map(|adapter| Self {
            inner: AdapterKind::Windows(adapter),
        })
    }

    #[must_use]
    pub fn platform(&self) -> ServicePlatform {
        match &self.inner {
            AdapterKind::Linux(_) => ServicePlatform::Linux,
            AdapterKind::MacOs(_) => ServicePlatform::MacOs,
            AdapterKind::Windows(_) => ServicePlatform::Windows,
        }
    }

    #[must_use]
    pub fn target(&self) -> &ServiceTarget {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.target(),
            AdapterKind::MacOs(adapter) => adapter.target(),
            AdapterKind::Windows(adapter) => adapter.target(),
        }
    }

    #[must_use]
    pub fn rendered_definition(&self) -> String {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.definition(),
            AdapterKind::MacOs(adapter) => adapter.definition(),
            AdapterKind::Windows(adapter) => adapter.definition(),
        }
        .to_owned()
    }

    #[must_use]
    pub fn definition_identity(&self) -> String {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.definition(),
            AdapterKind::MacOs(adapter) => adapter.definition(),
            AdapterKind::Windows(adapter) => adapter.definition_identity(),
        }
        .to_owned()
    }

    fn status_commands(&self) -> Vec<CommandSpec> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.status_commands(),
            AdapterKind::MacOs(adapter) => adapter.status_commands(),
            AdapterKind::Windows(adapter) => adapter.status_commands(),
        }
    }

    fn parse_status(&self, outputs: &[CommandOutput]) -> Result<ServiceStatus, ServiceError> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.parse_status(outputs),
            AdapterKind::MacOs(adapter) => adapter.parse_status(outputs),
            AdapterKind::Windows(adapter) => adapter.parse_status(outputs),
        }
    }

    fn authority_command(&self) -> Option<CommandSpec> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.authority_command(),
            AdapterKind::MacOs(adapter) => adapter.authority_command(),
            AdapterKind::Windows(adapter) => adapter.authority_command(),
        }
    }

    fn account_probe(&self) -> Option<CommandSpec> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.account_probe(),
            AdapterKind::MacOs(adapter) => adapter.account_probe(),
            AdapterKind::Windows(adapter) => adapter.account_probe(),
        }
    }

    fn account_create_step(&self) -> Option<CommandStep> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.account_create_step(),
            AdapterKind::MacOs(adapter) => adapter.account_create_step(),
            AdapterKind::Windows(adapter) => adapter.account_create_step(),
        }
    }

    fn install_steps(&self, update: bool) -> Vec<CommandStep> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.install_steps(update),
            AdapterKind::MacOs(adapter) => adapter.install_steps(update),
            AdapterKind::Windows(adapter) => adapter.install_steps(update),
        }
    }

    fn start_steps(&self) -> Vec<CommandStep> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.start_steps(),
            AdapterKind::MacOs(adapter) => adapter.start_steps(),
            AdapterKind::Windows(adapter) => adapter.start_steps(),
        }
    }

    fn finalize_install_steps(&self, update: bool) -> Vec<CommandStep> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.finalize_install_steps(update),
            AdapterKind::MacOs(adapter) => adapter.finalize_install_steps(update),
            AdapterKind::Windows(adapter) => adapter.finalize_install_steps(update),
        }
    }

    fn stop_steps(&self) -> Vec<CommandStep> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.stop_steps(),
            AdapterKind::MacOs(adapter) => adapter.stop_steps(),
            AdapterKind::Windows(adapter) => adapter.stop_steps(),
        }
    }

    fn uninstall_steps(&self) -> Vec<CommandStep> {
        match &self.inner {
            AdapterKind::Linux(adapter) => adapter.uninstall_steps(),
            AdapterKind::MacOs(adapter) => adapter.uninstall_steps(),
            AdapterKind::Windows(adapter) => adapter.uninstall_steps(),
        }
    }

    fn authority_output_is_elevated(&self, output: &CommandOutput) -> bool {
        output.exit_code == 0
            && match &self.inner {
                AdapterKind::Windows(_) => output.stdout.trim().eq_ignore_ascii_case("true"),
                AdapterKind::Linux(_) | AdapterKind::MacOs(_) => output.stdout.trim() == "0",
            }
    }

    fn registration_owns_account(&self) -> bool {
        matches!(&self.inner, AdapterKind::Windows(adapter) if adapter.target().mode == ServiceMode::Headless)
    }
}

pub fn current_native_user() -> Result<NativeUser, ServiceError> {
    let home_dir = dirs::home_dir().ok_or_else(|| {
        ServiceError::NativeIdentity("the current home directory is unavailable".to_owned())
    })?;
    #[cfg(windows)]
    let name = std::env::var("USERNAME").map_err(|_| {
        ServiceError::NativeIdentity("the current Windows account name is unavailable".to_owned())
    })?;
    #[cfg(not(windows))]
    let name = std::env::var("USER").map_err(|_| {
        ServiceError::NativeIdentity("the current Unix account name is unavailable".to_owned())
    })?;
    #[cfg(unix)]
    let numeric_id = Some(unsafe { libc::geteuid() });
    #[cfg(not(unix))]
    let numeric_id = None;
    Ok(NativeUser {
        name,
        numeric_id,
        home_dir,
    })
}

#[cfg(windows)]
pub fn windows_service_host_requested() -> bool {
    windows::windows_service_host_requested()
}

#[cfg(windows)]
pub fn run_windows_service_host() -> Result<(), ServiceError> {
    windows::run_windows_service_host()
}

#[derive(Clone, Debug)]
pub struct ServiceManager<R> {
    runner: R,
}

impl<R> ServiceManager<R>
where
    R: CommandRunner,
{
    pub fn new(runner: R) -> Self {
        Self { runner }
    }

    pub async fn status(&self, adapter: &ServiceAdapter) -> Result<ServiceStatus, ServiceError> {
        let mut outputs = Vec::new();
        for command in adapter.status_commands() {
            outputs.push(self.runner.run(command).await?);
        }
        adapter.parse_status(&outputs)
    }

    pub async fn install(
        &self,
        adapter: &ServiceAdapter,
        update: bool,
    ) -> Result<ServiceStatus, ServiceError> {
        Ok(self.install_report(adapter, update).await?.status)
    }

    pub async fn install_report(
        &self,
        adapter: &ServiceAdapter,
        update: bool,
    ) -> Result<ServiceInstallResult, ServiceError> {
        let before = self.status(adapter).await?;
        if before.state != ServiceState::NotInstalled && before.definition_matches {
            return Ok(ServiceInstallResult {
                status: before,
                changed: false,
                account_created: false,
            });
        }
        if before.state != ServiceState::NotInstalled && !update {
            return Err(ServiceError::DefinitionMismatch);
        }
        self.ensure_authority(adapter).await?;
        let mut account_created = false;
        if let Some(probe) = adapter.account_probe() {
            let output = self.runner.run(probe).await?;
            if output.exit_code != 0
                && let Some(step) = adapter.account_create_step()
            {
                self.execute_steps(std::slice::from_ref(&step)).await?;
                account_created = true;
            }
        }
        let install_result = self.execute_steps(&adapter.install_steps(update)).await;
        if install_result.is_err()
            && account_created
            && let Some(step) = adapter.account_create_step()
            && let Some(rollback) = step.rollback.into_iter().next()
        {
            let _ = self.runner.run(rollback).await;
        }
        let applied = install_result?;
        let after = match self
            .wait_for_status(adapter, "install", |status| {
                status.state == ServiceState::Running && status.definition_matches
            })
            .await
        {
            Ok(status) => status,
            Err(error) => {
                self.rollback(&applied).await;
                if account_created
                    && let Some(step) = adapter.account_create_step()
                    && let Some(rollback) = step.rollback.into_iter().next()
                {
                    let _ = self.runner.run(rollback).await;
                }
                return Err(error);
            }
        };
        self.execute_steps(&adapter.finalize_install_steps(update))
            .await?;
        Ok(ServiceInstallResult {
            status: after,
            changed: true,
            account_created: account_created || adapter.registration_owns_account(),
        })
    }

    pub async fn start(&self, adapter: &ServiceAdapter) -> Result<ServiceStatus, ServiceError> {
        let before = self.status(adapter).await?;
        if before.state == ServiceState::NotInstalled {
            return Err(ServiceError::VerificationFailed(
                "start of a missing service",
            ));
        }
        if before.state == ServiceState::Running {
            return Ok(before);
        }
        self.ensure_authority(adapter).await?;
        self.execute_steps(&adapter.start_steps()).await?;
        let after = self
            .wait_for_status(adapter, "start", |status| {
                status.state == ServiceState::Running
            })
            .await?;
        Ok(after)
    }

    pub async fn stop_without_drain(
        &self,
        adapter: &ServiceAdapter,
    ) -> Result<ServiceStatus, ServiceError> {
        let before = self.status(adapter).await?;
        if matches!(
            before.state,
            ServiceState::NotInstalled | ServiceState::Stopped
        ) {
            return Ok(before);
        }
        self.ensure_authority(adapter).await?;
        self.execute_steps(&adapter.stop_steps()).await?;
        let after = self
            .wait_for_status(adapter, "stop", |status| {
                matches!(
                    status.state,
                    ServiceState::Stopped | ServiceState::NotInstalled
                )
            })
            .await?;
        Ok(after)
    }

    pub async fn restart_without_drain(
        &self,
        adapter: &ServiceAdapter,
    ) -> Result<ServiceStatus, ServiceError> {
        self.stop_without_drain(adapter).await?;
        self.start(adapter).await
    }

    pub async fn uninstall(&self, adapter: &ServiceAdapter) -> Result<ServiceStatus, ServiceError> {
        Ok(self.uninstall_report(adapter).await?.status)
    }

    pub async fn uninstall_report(
        &self,
        adapter: &ServiceAdapter,
    ) -> Result<ServiceUninstallResult, ServiceError> {
        let before = self.status(adapter).await?;
        if before.state == ServiceState::NotInstalled {
            return Ok(ServiceUninstallResult {
                status: before,
                changed: false,
                account_removed: false,
                data_root_preserved: true,
            });
        }
        self.ensure_authority(adapter).await?;
        self.execute_steps(&adapter.uninstall_steps()).await?;
        let after = self
            .wait_for_status(adapter, "uninstall", |status| {
                status.state == ServiceState::NotInstalled
            })
            .await?;
        Ok(ServiceUninstallResult {
            status: after,
            changed: true,
            account_removed: adapter.registration_owns_account(),
            data_root_preserved: true,
        })
    }

    async fn execute_steps(
        &self,
        steps: &[CommandStep],
    ) -> Result<Vec<Vec<CommandSpec>>, ServiceError> {
        let mut rollbacks = Vec::new();
        for step in steps {
            if !step.rollback.is_empty() {
                rollbacks.push(step.rollback.clone());
            }
            let output = match self.runner.run(step.command.clone()).await {
                Ok(output) => output,
                Err(error) => {
                    self.rollback(&rollbacks).await;
                    return Err(ServiceError::Command(error));
                }
            };
            if !step.accepted_exit_codes.contains(&output.exit_code) {
                let rollback_failures = self.rollback(&rollbacks).await;
                let message = if output.stderr.trim().is_empty() {
                    &output.stdout
                } else {
                    &output.stderr
                };
                return Err(ServiceError::CommandFailed {
                    program: step.command.program.clone(),
                    exit_code: output.exit_code,
                    message: bounded_diagnostic(message),
                    rollback_failures,
                });
            }
        }
        Ok(rollbacks)
    }

    async fn wait_for_status<F>(
        &self,
        adapter: &ServiceAdapter,
        operation: &'static str,
        ready: F,
    ) -> Result<ServiceStatus, ServiceError>
    where
        F: Fn(&ServiceStatus) -> bool,
    {
        let deadline = tokio::time::Instant::now() + SERVICE_STATE_DEADLINE;
        loop {
            let status = self.status(adapter).await?;
            if ready(&status) {
                return Ok(status);
            }
            if status.state == ServiceState::Failed || tokio::time::Instant::now() >= deadline {
                return Err(ServiceError::VerificationFailed(operation));
            }
            tokio::time::sleep(SERVICE_STATE_POLL_INTERVAL).await;
        }
    }

    async fn ensure_authority(&self, adapter: &ServiceAdapter) -> Result<(), ServiceError> {
        if let Some(authority) = adapter.authority_command() {
            let output = self.runner.run(authority).await?;
            if !adapter.authority_output_is_elevated(&output) {
                return Err(ServiceError::InsufficientAuthority);
            }
        }
        Ok(())
    }

    async fn rollback(&self, groups: &[Vec<CommandSpec>]) -> usize {
        let mut failures = 0;
        for group in groups.iter().rev() {
            for command in group {
                match self.runner.run(command.clone()).await {
                    Ok(output) if output.exit_code == 0 => {}
                    Ok(_) | Err(_) => failures += 1,
                }
            }
        }
        failures
    }
}
