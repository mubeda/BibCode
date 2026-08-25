use std::{fmt, net::SocketAddr, path::PathBuf, time::Duration};

use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
pub const SERVICE_STOP_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "camelCase")]
pub enum ServiceMode {
    #[default]
    Workstation,
    Headless,
}

impl fmt::Display for ServiceMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Workstation => formatter.write_str("workstation"),
            Self::Headless => formatter.write_str("headless"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    NotInstalled,
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServicePlatform {
    Windows,
    MacOs,
    Linux,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeUser {
    pub name: String,
    pub numeric_id: Option<u32>,
    pub home_dir: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceTarget {
    pub mode: ServiceMode,
    pub binary_path: PathBuf,
    pub data_root: PathBuf,
    pub bind: SocketAddr,
    pub current_user: NativeUser,
}

impl ServiceTarget {
    pub(crate) fn validate(&self, platform: ServicePlatform) -> Result<(), ServiceError> {
        if !path_is_absolute_for(&self.binary_path, platform) {
            return Err(ServiceError::InvalidTarget(
                "the service binary path must be absolute".to_owned(),
            ));
        }
        if !path_is_absolute_for(&self.data_root, platform) {
            return Err(ServiceError::InvalidTarget(
                "the service data root must be absolute".to_owned(),
            ));
        }
        for (label, path) in [
            ("binary path", &self.binary_path),
            ("data root", &self.data_root),
            ("home directory", &self.current_user.home_dir),
        ] {
            let Some(value) = path.to_str() else {
                return Err(ServiceError::InvalidTarget(format!(
                    "the service {label} must be valid Unicode"
                )));
            };
            if value.chars().any(char::is_control) {
                return Err(ServiceError::InvalidTarget(format!(
                    "the service {label} must not contain control characters"
                )));
            }
        }
        if !self.bind.ip().is_loopback() {
            return Err(ServiceError::InvalidTarget(
                "managed services must bind to a loopback address".to_owned(),
            ));
        }
        if self.current_user.name.trim().is_empty() {
            return Err(ServiceError::InvalidTarget(
                "the current service administrator account is unavailable".to_owned(),
            ));
        }
        if self.current_user.name.chars().any(char::is_control) {
            return Err(ServiceError::InvalidTarget(
                "the service administrator account must not contain control characters".to_owned(),
            ));
        }
        if matches!(platform, ServicePlatform::Linux | ServicePlatform::MacOs)
            && self.current_user.numeric_id.is_none()
        {
            return Err(ServiceError::InvalidTarget(
                "the numeric user identity is required on Unix hosts".to_owned(),
            ));
        }
        Ok(())
    }

    #[must_use]
    pub fn control_endpoint(&self, platform: ServicePlatform) -> String {
        match platform {
            ServicePlatform::Windows => "protected-named-pipe".to_owned(),
            ServicePlatform::MacOs | ServicePlatform::Linux => self
                .data_root
                .join("userdata")
                .join("run")
                .join("control.sock")
                .to_string_lossy()
                .into_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub mode: ServiceMode,
    pub state: ServiceState,
    pub startup_owner: String,
    pub account: String,
    pub binary_path: PathBuf,
    pub data_root: PathBuf,
    pub bind: SocketAddr,
    pub control_endpoint: String,
    pub enabled: bool,
    pub definition_matches: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linger_enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInstallResult {
    pub status: ServiceStatus,
    pub changed: bool,
    pub account_created: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceUninstallResult {
    pub status: ServiceStatus,
    pub changed: bool,
    pub account_removed: bool,
    pub data_root_preserved: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
}

impl CommandSpec {
    #[must_use]
    pub fn new<I, S>(program: impl Into<String>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            stdin: None,
            timeout: DEFAULT_COMMAND_TIMEOUT,
        }
    }

    #[must_use]
    pub fn with_stdin(mut self, stdin: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(stdin.into());
        self
    }

    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CommandFailure {
    #[error("the service command could not be started: {0}")]
    Io(String),
    #[error("the service command exceeded its bounded deadline")]
    Timeout,
    #[error("the service command produced more output than the safety limit")]
    OutputTooLarge,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ServiceError {
    #[error("invalid service target: {0}")]
    InvalidTarget(String),
    #[error("the service manager response was invalid: {0}")]
    InvalidManagerResponse(String),
    #[error("headless service administration requires elevated host authority")]
    InsufficientAuthority,
    #[error("the installed service definition differs; rerun install with explicit update")]
    DefinitionMismatch,
    #[error("service command {program} failed with exit code {exit_code}: {message}")]
    CommandFailed {
        program: String,
        exit_code: i32,
        message: String,
        rollback_failures: usize,
    },
    #[error(transparent)]
    Command(#[from] CommandFailure),
    #[error("the service did not reach the expected state after {0}")]
    VerificationFailed(&'static str),
    #[error("the service platform is unsupported on this host")]
    UnsupportedPlatform,
    #[error("the native service identity is unavailable: {0}")]
    NativeIdentity(String),
    #[error("the Windows service host failed: {0}")]
    WindowsServiceHost(String),
    #[error("the running service could not drain through local control: {0}")]
    Drain(String),
}

impl ServiceError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidTarget(_) => "invalid_target",
            Self::InvalidManagerResponse(_) => "invalid_manager_response",
            Self::InsufficientAuthority => "insufficient_authority",
            Self::DefinitionMismatch => "definition_mismatch",
            Self::CommandFailed { .. } => "command_failed",
            Self::Command(CommandFailure::Timeout) => "timeout",
            Self::Command(CommandFailure::Io(_)) => "command_unavailable",
            Self::Command(CommandFailure::OutputTooLarge) => "output_too_large",
            Self::VerificationFailed(_) => "verification_failed",
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::NativeIdentity(_) => "native_identity_unavailable",
            Self::WindowsServiceHost(_) => "windows_service_host_failed",
            Self::Drain(_) => "drain_failed",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CommandStep {
    pub command: CommandSpec,
    pub rollback: Vec<CommandSpec>,
    pub accepted_exit_codes: Vec<i32>,
}

impl CommandStep {
    pub(crate) fn checked(command: CommandSpec) -> Self {
        Self {
            command,
            rollback: Vec::new(),
            accepted_exit_codes: vec![0],
        }
    }

    pub(crate) fn with_rollback(mut self, rollback: CommandSpec) -> Self {
        self.rollback.push(rollback);
        self
    }

    pub(crate) fn with_rollbacks(
        mut self,
        rollbacks: impl IntoIterator<Item = CommandSpec>,
    ) -> Self {
        self.rollback.extend(rollbacks);
        self
    }

    pub(crate) fn accepting(mut self, exit_codes: impl IntoIterator<Item = i32>) -> Self {
        self.accepted_exit_codes = exit_codes.into_iter().collect();
        self
    }
}

pub(crate) fn bounded_diagnostic(value: &str) -> String {
    const LIMIT: usize = 2_048;
    let sanitized = value.replace(['\r', '\n'], " ");
    if sanitized.len() <= LIMIT {
        sanitized
    } else {
        let boundary = sanitized
            .char_indices()
            .map(|(index, _)| index)
            .take_while(|index| *index <= LIMIT)
            .last()
            .unwrap_or(0);
        format!("{}…", &sanitized[..boundary])
    }
}

fn path_is_absolute_for(path: &std::path::Path, platform: ServicePlatform) -> bool {
    match platform {
        ServicePlatform::Windows => {
            let value = path.to_string_lossy();
            let bytes = value.as_bytes();
            (bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/'))
                || value.starts_with(r"\\")
        }
        ServicePlatform::MacOs | ServicePlatform::Linux => path.is_absolute(),
    }
}
