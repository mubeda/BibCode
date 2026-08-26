use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};

pub(crate) const DEFAULT_REMOTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const DEFAULT_REMOTE_OUTPUT_LIMIT: usize = 64 * 1024;
pub(crate) const REMOTE_TRANSFER_COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub(crate) const REMOTE_INSTALL_COMMAND_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub(crate) const REMOTE_SERVICE_COMMAND_TIMEOUT: Duration = Duration::from_secs(2 * 60);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum RemoteCommandPurpose {
    #[cfg(test)]
    Probe,
    Kernel,
    Architecture,
    Home,
    FreeSpace,
    SystemFreeSpace,
    InstalledVersion,
    WorkstationService,
    HeadlessService,
    AdministratorAuthority,
    DebInstaller,
    RpmInstaller,
    PackageInstaller,
    PortableExtractor,
    Sha256,
    WindowsProbe,
    CreateStaging,
    Transfer,
    VerifyTransfer,
    VerifyTransferSize,
    Install,
    Service,
    RemovalPlan,
    RemovalExecute,
    RemovalCleanup,
    Cleanup,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RemoteStdin {
    None,
    Json(Vec<u8>),
    Artifact {
        local_path: PathBuf,
        metadata: Vec<u8>,
        expected_size: u64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteCommand {
    pub purpose: RemoteCommandPurpose,
    pub program: String,
    pub arguments: Vec<String>,
    pub stdin: RemoteStdin,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}

impl RemoteCommand {
    pub(crate) fn new<I, S>(
        purpose: RemoteCommandPurpose,
        program: impl Into<String>,
        arguments: I,
        stdin: RemoteStdin,
        timeout: Duration,
        max_output_bytes: usize,
    ) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let program = program.into();
        let arguments = arguments.into_iter().map(Into::into).collect::<Vec<_>>();
        validate_remote_token(&program, "program")?;
        for argument in &arguments {
            validate_remote_token(argument, "argument")?;
        }
        if timeout.is_zero() {
            return Err("A remote command timeout must be non-zero.".to_string());
        }
        if max_output_bytes == 0 || max_output_bytes > 1024 * 1024 {
            return Err(
                "A remote command output limit must be between 1 byte and 1 MiB.".to_string(),
            );
        }
        match &stdin {
            RemoteStdin::Json(bytes) if bytes.len() > 64 * 1024 => {
                return Err("Remote command JSON input exceeds 64 KiB.".to_string());
            }
            RemoteStdin::Artifact { metadata, .. } if metadata.len() > 64 * 1024 => {
                return Err("Remote artifact metadata exceeds 64 KiB.".to_string());
            }
            _ => {}
        }
        Ok(Self {
            purpose,
            program,
            arguments,
            stdin,
            timeout,
            max_output_bytes,
        })
    }

    pub(crate) fn standard<I, S>(
        purpose: RemoteCommandPurpose,
        program: impl Into<String>,
        arguments: I,
    ) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::new(
            purpose,
            program,
            arguments,
            RemoteStdin::None,
            DEFAULT_REMOTE_COMMAND_TIMEOUT,
            DEFAULT_REMOTE_OUTPUT_LIMIT,
        )
    }

    pub(crate) fn render_for_windows_openssh(&self) -> Result<String, String> {
        let mut tokens = Vec::with_capacity(self.arguments.len() + 1);
        tokens.push(self.program.as_str());
        tokens.extend(self.arguments.iter().map(String::as_str));
        if tokens.iter().any(|token| {
            token.is_empty()
                || !token.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric()
                        || matches!(byte, b'.' | b'_' | b'-' | b'+' | b'/' | b'=' | b':' | b'\\')
                })
        }) {
            return Err(
                "Windows OpenSSH command tokens must be constant shell-neutral ASCII.".to_string(),
            );
        }
        Ok(tokens.join(" "))
    }

    pub(crate) fn with_timeout(mut self, timeout: Duration) -> Result<Self, String> {
        if timeout.is_zero() {
            return Err("A remote command timeout must be non-zero.".to_string());
        }
        self.timeout = timeout;
        Ok(self)
    }
}

fn validate_remote_token(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(format!(
            "Remote command {label} must be non-empty and contain no control characters."
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteCommandOutput {
    pub purpose: RemoteCommandPurpose,
    pub status: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl RemoteCommandOutput {
    pub(crate) fn new(
        purpose: RemoteCommandPurpose,
        status: i32,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
        truncated: bool,
        maximum_bytes: usize,
    ) -> Result<Self, String> {
        if truncated || stdout.len().saturating_add(stderr.len()) > maximum_bytes {
            return Err("Remote command output exceeded its configured bound.".to_string());
        }
        Ok(Self {
            purpose,
            status,
            stdout,
            stderr,
        })
    }

    #[cfg(test)]
    pub(crate) fn success(purpose: RemoteCommandPurpose, stdout: Vec<u8>) -> Self {
        Self::new(
            purpose,
            0,
            stdout,
            Vec::new(),
            false,
            DEFAULT_REMOTE_OUTPUT_LIMIT,
        )
        .expect("bounded test output")
    }

    #[cfg(test)]
    pub(crate) fn failure(purpose: RemoteCommandPurpose, status: i32, stderr: Vec<u8>) -> Self {
        Self::new(
            purpose,
            status,
            Vec::new(),
            stderr,
            false,
            DEFAULT_REMOTE_OUTPUT_LIMIT,
        )
        .expect("bounded test output")
    }

    pub(crate) fn succeeded(&self) -> bool {
        self.status == 0
    }

    pub(crate) fn stdout_text(&self) -> Result<&str, String> {
        std::str::from_utf8(&self.stdout)
            .map_err(|_| "Remote command output was not valid UTF-8.".to_string())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) enum RemoteHostOs {
    #[serde(rename = "linux")]
    Linux,
    #[serde(rename = "macos")]
    MacOs,
    #[serde(rename = "windows")]
    Windows,
}

impl RemoteHostOs {
    pub(crate) fn as_manifest_value(self) -> &'static str {
        match self {
            Self::Linux => "linux",
            Self::MacOs => "macos",
            Self::Windows => "windows",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RemoteHostArchitecture {
    X86_64,
    Aarch64,
}

impl RemoteHostArchitecture {
    pub(crate) fn as_manifest_value(self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteServiceMode {
    #[default]
    Workstation,
    Headless,
}

impl RemoteServiceMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Workstation => "workstation",
            Self::Headless => "headless",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteServiceState {
    NotInstalled,
    Stopped,
    Running,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteInstallAuthority {
    User,
    NoninteractiveAdministrator,
    AdministratorRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArtifactFormat {
    Zip,
    TarGz,
    Msi,
    Pkg,
    Deb,
    Rpm,
}

impl ArtifactFormat {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Zip => "zip",
            Self::TarGz => "tar.gz",
            Self::Msi => "msi",
            Self::Pkg => "pkg",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RemoteHostCapabilities {
    pub deb_installer: bool,
    pub rpm_installer: bool,
    pub package_installer: bool,
    pub msi_installer: bool,
    pub portable_extractor: bool,
    pub sha256: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHostProbe {
    pub os: RemoteHostOs,
    pub architecture: RemoteHostArchitecture,
    pub installed_version: Option<String>,
    pub service_mode: Option<RemoteServiceMode>,
    pub service_state: RemoteServiceState,
    pub data_root: Option<String>,
    pub control_available: bool,
    pub free_bytes: u64,
    pub install_authority: RemoteInstallAuthority,
    #[serde(skip_serializing)]
    pub home: String,
    #[serde(skip_serializing)]
    pub install_base: String,
    #[serde(skip_serializing)]
    pub system_install_base: String,
    #[serde(skip_serializing)]
    pub headless_data_root: String,
    #[serde(skip_serializing)]
    pub binary_path: Option<String>,
    #[serde(skip_serializing)]
    pub bind_port: Option<u16>,
    #[serde(skip_serializing)]
    pub capabilities: RemoteHostCapabilities,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedArtifact {
    pub local_path: PathBuf,
    pub version: String,
    pub os: RemoteHostOs,
    pub architecture: RemoteHostArchitecture,
    pub format: ArtifactFormat,
    pub size: u64,
    pub sha256: String,
    pub remote_path: String,
    pub install_root: String,
    pub data_root: String,
    pub service_mode: RemoteServiceMode,
    pub remote_port: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StagedArtifact {
    pub verified: VerifiedArtifact,
    pub installed_binary_path: String,
    pub authority: RemoteInstallAuthority,
    pub service_mode: RemoteServiceMode,
    pub update_existing_service: bool,
}

impl StagedArtifact {
    pub(crate) fn from_verified(
        verified: VerifiedArtifact,
        installed_binary_path: impl Into<String>,
        authority: RemoteInstallAuthority,
    ) -> Self {
        let service_mode = verified.service_mode;
        Self {
            verified,
            installed_binary_path: installed_binary_path.into(),
            authority,
            service_mode,
            update_existing_service: false,
        }
    }

    pub(crate) fn with_service_update(mut self, update_existing_service: bool) -> Self {
        self.update_existing_service = update_existing_service;
        self
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteInstallStage {
    Probe,
    Download,
    Verify,
    Transfer,
    Install,
    Start,
    VerifyIdentity,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MutationStatus {
    None,
    Partial,
    Completed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CleanupStatus {
    NotRequired,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteInstallFailure {
    pub stage: RemoteInstallStage,
    pub mutation_status: MutationStatus,
    pub cleanup_status: CleanupStatus,
    pub previous_version: Option<String>,
    pub message: String,
    pub recovery_command: String,
}

impl RemoteInstallFailure {
    pub(crate) fn new(
        stage: RemoteInstallStage,
        mutation_status: MutationStatus,
        cleanup_status: CleanupStatus,
        previous_version: Option<String>,
        message: String,
        recovery_command: String,
    ) -> Self {
        Self {
            stage,
            mutation_status,
            cleanup_status,
            previous_version,
            message,
            recovery_command,
        }
    }
}

pub(crate) trait RemoteHostAdapter: Send + Sync {
    fn os(&self) -> RemoteHostOs;
    fn probe_commands(&self) -> Vec<RemoteCommand>;
    fn parse_probe(&self, outputs: &[RemoteCommandOutput]) -> Result<RemoteHostProbe, String>;
    fn preferred_formats(&self, probe: &RemoteHostProbe) -> Vec<ArtifactFormat>;
    fn stage_commands(&self, input: &VerifiedArtifact) -> Result<Vec<RemoteCommand>, String>;
    fn install_commands(&self, input: &StagedArtifact) -> Result<Vec<RemoteCommand>, String>;
    fn service_commands(&self, input: &StagedArtifact) -> Result<Vec<RemoteCommand>, String>;
    fn cleanup_commands(
        &self,
        input: &VerifiedArtifact,
        remove_install_root: bool,
    ) -> Result<Vec<RemoteCommand>, String>;
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatusDocument {
    operation: String,
    status: ServiceStatusBody,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatusBody {
    mode: RemoteServiceMode,
    state: String,
    binary_path: String,
    data_root: String,
    bind: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedServiceStatus {
    pub mode: RemoteServiceMode,
    pub state: RemoteServiceState,
    pub binary_path: String,
    pub data_root: String,
    pub bind_port: u16,
}

pub(crate) fn parse_service_status(output: &RemoteCommandOutput) -> Option<ParsedServiceStatus> {
    if !output.succeeded() {
        return None;
    }
    let document = serde_json::from_slice::<ServiceStatusDocument>(&output.stdout).ok()?;
    if document.operation != "status" {
        return None;
    }
    let state = match document.status.state.as_str() {
        "notInstalled" => RemoteServiceState::NotInstalled,
        "stopped" | "stopping" => RemoteServiceState::Stopped,
        "running" | "starting" => RemoteServiceState::Running,
        "failed" => RemoteServiceState::Failed,
        _ => return None,
    };
    let bind = document.status.bind.parse::<std::net::SocketAddr>().ok()?;
    if !bind.ip().is_loopback() || bind.port() == 0 {
        return None;
    }
    Some(ParsedServiceStatus {
        mode: document.status.mode,
        state,
        binary_path: document.status.binary_path,
        data_root: document.status.data_root,
        bind_port: bind.port(),
    })
}

pub(crate) fn select_service_status(
    outputs: &[RemoteCommandOutput],
) -> Option<ParsedServiceStatus> {
    let mut statuses = outputs
        .iter()
        .filter(|output| {
            matches!(
                output.purpose,
                RemoteCommandPurpose::WorkstationService | RemoteCommandPurpose::HeadlessService
            )
        })
        .filter_map(parse_service_status)
        .collect::<Vec<_>>();
    statuses.sort_by_key(|status| {
        let running_rank = if status.state == RemoteServiceState::Running {
            0
        } else {
            1
        };
        let mode_rank = if status.mode == RemoteServiceMode::Workstation {
            0
        } else {
            1
        };
        (running_rank, mode_rank)
    });
    statuses.into_iter().next()
}

pub(crate) fn output_for(
    outputs: &[RemoteCommandOutput],
    purpose: RemoteCommandPurpose,
) -> Result<&RemoteCommandOutput, String> {
    outputs
        .iter()
        .find(|output| output.purpose == purpose)
        .ok_or_else(|| format!("Remote probe omitted {purpose:?} output."))
}

pub(crate) fn successful_output(
    outputs: &[RemoteCommandOutput],
    purpose: RemoteCommandPurpose,
) -> Result<&str, String> {
    let output = output_for(outputs, purpose)?;
    if !output.succeeded() {
        return Err(format!("Remote probe command {purpose:?} was unavailable."));
    }
    output.stdout_text()
}

pub(crate) fn command_succeeded(
    outputs: &[RemoteCommandOutput],
    purpose: RemoteCommandPurpose,
) -> bool {
    outputs
        .iter()
        .find(|output| output.purpose == purpose)
        .is_some_and(RemoteCommandOutput::succeeded)
}

pub(crate) fn normalize_architecture(value: &str) -> Result<RemoteHostArchitecture, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => Ok(RemoteHostArchitecture::X86_64),
        "aarch64" | "arm64" => Ok(RemoteHostArchitecture::Aarch64),
        _ => Err("The remote host architecture is unsupported.".to_string()),
    }
}

pub(crate) fn parse_bibcode_version(value: &str) -> Option<String> {
    let line = value.lines().map(str::trim).find(|line| !line.is_empty())?;
    let version = line.split_whitespace().find(|part| {
        part.chars()
            .next()
            .is_some_and(|byte| byte.is_ascii_digit())
    })?;
    if version.chars().any(char::is_control) || version.len() > 128 {
        return None;
    }
    Some(version.to_string())
}

pub(crate) fn parse_posix_free_bytes(value: &str) -> Result<u64, String> {
    let row = value
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .ok_or_else(|| "The remote free-space probe returned no rows.".to_string())?;
    let available_kib = row
        .split_whitespace()
        .nth(3)
        .and_then(|field| field.parse::<u64>().ok())
        .ok_or_else(|| "The remote free-space probe returned an invalid row.".to_string())?;
    available_kib
        .checked_mul(1024)
        .ok_or_else(|| "The remote free-space result overflowed.".to_string())
}

pub(crate) fn validate_posix_path(value: &str, label: &str) -> Result<(), String> {
    if !value.starts_with('/') || value.chars().any(char::is_control) {
        return Err(format!(
            "The remote {label} must be an absolute POSIX path."
        ));
    }
    Ok(())
}

pub(crate) fn validate_windows_path(value: &str, label: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "The remote {label} must be an absolute Windows path."
        ));
    }
    Ok(())
}

pub(crate) fn parent_path(value: &str, separator: char) -> Result<String, String> {
    let (parent, _) = value
        .rsplit_once(separator)
        .ok_or_else(|| "The remote staging path has no parent directory.".to_string())?;
    if parent.is_empty() {
        return Err("The remote staging parent directory is invalid.".to_string());
    }
    Ok(parent.to_string())
}

pub(crate) fn atomic_posix_tar_install_commands(
    input: &StagedArtifact,
    sha256_program: &str,
) -> Result<Vec<RemoteCommand>, String> {
    let remote_path = &input.verified.remote_path;
    let install_root = &input.verified.install_root;
    validate_posix_path(remote_path, "artifact staging path")?;
    validate_posix_path(install_root, "install root")?;
    let parent = parent_path(install_root, '/')?;
    let staging_root = format!("{install_root}.staging");
    validate_posix_path(&staging_root, "portable staging root")?;

    if input.service_mode != RemoteServiceMode::Headless {
        return Ok(vec![
            RemoteCommand::standard(
                RemoteCommandPurpose::Install,
                "test",
                ["!".to_string(), "-e".to_string(), install_root.clone()],
            )?,
            RemoteCommand::standard(
                RemoteCommandPurpose::Install,
                "mkdir",
                ["-p".to_string(), "--".to_string(), parent],
            )?,
            RemoteCommand::standard(
                RemoteCommandPurpose::Install,
                "mkdir",
                ["--".to_string(), staging_root.clone()],
            )?,
            RemoteCommand::standard(
                RemoteCommandPurpose::Install,
                "chmod",
                ["700".to_string(), "--".to_string(), staging_root.clone()],
            )?,
            RemoteCommand::standard(
                RemoteCommandPurpose::Install,
                "tar",
                [
                    "-xzf".to_string(),
                    remote_path.clone(),
                    "-C".to_string(),
                    staging_root.clone(),
                ],
            )?
            .with_timeout(REMOTE_INSTALL_COMMAND_TIMEOUT)?,
            RemoteCommand::standard(
                RemoteCommandPurpose::Install,
                "mv",
                ["--".to_string(), staging_root, install_root.clone()],
            )?,
        ]);
    }
    if input.authority != RemoteInstallAuthority::NoninteractiveAdministrator {
        return Err(
            "Headless portable installation requires noninteractive administrator authority."
                .to_string(),
        );
    }

    let extraction_root = format!("{staging_root}/root");
    let privileged_artifact = format!("{staging_root}/artifact.tar.gz");
    let elevated = |purpose: RemoteCommandPurpose,
                    program: &str,
                    arguments: Vec<String>|
     -> Result<RemoteCommand, String> {
        let mut elevated_arguments = vec!["-n".to_string(), program.to_string()];
        elevated_arguments.extend(arguments);
        RemoteCommand::standard(purpose, "sudo", elevated_arguments)
    };
    let sha256_arguments = if sha256_program == "shasum" {
        vec![
            "-a".to_string(),
            "256".to_string(),
            "--".to_string(),
            privileged_artifact.clone(),
        ]
    } else {
        vec!["--".to_string(), privileged_artifact.clone()]
    };

    Ok(vec![
        elevated(
            RemoteCommandPurpose::Install,
            "test",
            vec!["!".to_string(), "-e".to_string(), install_root.clone()],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "test",
            vec!["!".to_string(), "-e".to_string(), staging_root.clone()],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "mkdir",
            vec!["-p".to_string(), "--".to_string(), parent.clone()],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "chmod",
            vec!["755".to_string(), "--".to_string(), parent],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "mkdir",
            vec!["--".to_string(), staging_root.clone()],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "chmod",
            vec!["700".to_string(), "--".to_string(), staging_root.clone()],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "cp",
            vec![remote_path.clone(), privileged_artifact.clone()],
        )?
        .with_timeout(REMOTE_INSTALL_COMMAND_TIMEOUT)?,
        elevated(
            RemoteCommandPurpose::Install,
            "chmod",
            vec![
                "600".to_string(),
                "--".to_string(),
                privileged_artifact.clone(),
            ],
        )?,
        elevated(
            RemoteCommandPurpose::VerifyTransfer,
            sha256_program,
            sha256_arguments,
        )?,
        elevated(
            RemoteCommandPurpose::VerifyTransferSize,
            "wc",
            vec!["-c".to_string(), privileged_artifact.clone()],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "mkdir",
            vec!["--".to_string(), extraction_root.clone()],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "chmod",
            vec!["755".to_string(), "--".to_string(), extraction_root.clone()],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "tar",
            vec![
                "--no-same-owner".to_string(),
                "-xzf".to_string(),
                privileged_artifact.clone(),
                "-C".to_string(),
                extraction_root.clone(),
            ],
        )?
        .with_timeout(REMOTE_INSTALL_COMMAND_TIMEOUT)?,
        elevated(
            RemoteCommandPurpose::Install,
            "chmod",
            vec![
                "-R".to_string(),
                "a+rX,go-w".to_string(),
                "--".to_string(),
                extraction_root.clone(),
            ],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "rm",
            vec!["-f".to_string(), "--".to_string(), privileged_artifact],
        )?,
        elevated(
            RemoteCommandPurpose::Install,
            "mv",
            vec!["--".to_string(), extraction_root, install_root.clone()],
        )?,
    ])
}
