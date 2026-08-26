use crate::{
    remote_host::{
        model::{
            DEFAULT_REMOTE_OUTPUT_LIMIT, RemoteCommand, RemoteCommandPurpose, RemoteHostOs,
            RemoteHostProbe, RemoteInstallAuthority, RemoteServiceMode, RemoteStdin,
        },
        windows::powershell_command,
    },
    ssh::SshEnvironmentTarget,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Component, Path},
    sync::Mutex,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const MAX_ENVIRONMENT_NAME_CHARS: usize = 256;
const MAX_ISSUED_REMOVAL_PLANS: usize = 64;
const NATIVE_PACKAGE_UNINSTALL_REASON: &str =
    "This server was installed by the host package manager; use its native uninstaller.";
const WINDOWS_MANAGED_BINARY_COMMAND: &str = r#"$ErrorActionPreference = 'Stop'
$document = [Console]::In.ReadToEnd() | ConvertFrom-Json
$binaryPath = [string]$document.binaryPath
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) { throw 'The managed BiBCode binary is missing.' }
$arguments = @($document.arguments | ForEach-Object { [string]$_ })
$output = & $binaryPath @arguments
if ($LASTEXITCODE -ne 0) { throw "The managed BiBCode command failed with exit code $LASTEXITCODE." }
[Console]::Out.Write(($output -join "`n"))
"#;
const WINDOWS_REMOVE_MANAGED_INSTALL: &str = r#"$ErrorActionPreference = 'Stop'
$document = [Console]::In.ReadToEnd() | ConvertFrom-Json
$installRoot = [string]$document.installRoot
$dataRoot = [string]$document.dataRoot
$preserveData = [bool]$document.preserveData
if ($preserveData -and -not (Test-Path -LiteralPath $dataRoot -PathType Container)) { throw 'The preserved BiBCode data root is missing.' }
if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
if (Test-Path -LiteralPath $installRoot) { throw 'The managed BiBCode installation root remains.' }
if ($preserveData -and -not (Test-Path -LiteralPath $dataRoot -PathType Container)) { throw 'The BiBCode data root was not preserved.' }
"#;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "transport",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum EnvironmentRemovalTarget {
    Wsl {
        distro: String,
        discovery_generation: u64,
    },
    Ssh {
        target: SshEnvironmentTarget,
        expected_host_key_fingerprint: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnvironmentRemovalPlanInput {
    pub target: EnvironmentRemovalTarget,
    pub expected_environment_id: String,
    pub expected_storage_id: String,
    pub environment_name: String,
}

impl EnvironmentRemovalPlanInput {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_environment_name(&self.environment_name)?;
        Uuid::parse_str(&self.expected_environment_id)
            .map_err(|_| "The expected environment identity is invalid.".to_string())?;
        Uuid::parse_str(&self.expected_storage_id)
            .map_err(|_| "The expected storage identity is invalid.".to_string())?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnvironmentRemovalPlan {
    pub schema_version: u16,
    pub plan_id: String,
    pub target: EnvironmentRemovalTarget,
    pub environment_id: String,
    pub storage_id: String,
    pub environment_name: String,
    pub data_root: String,
    pub project_count: u64,
    pub worktree_count: u64,
    pub process_count: u64,
    pub other_paired_client_count: u64,
    pub created_at: String,
    pub expires_at: String,
    pub uninstall_supported: bool,
    pub uninstall_unavailable_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EnvironmentRemovalAction {
    Uninstall,
    Purge,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum EnvironmentRemovalExecuteInput {
    Uninstall {
        target: EnvironmentRemovalTarget,
        plan: EnvironmentRemovalPlan,
    },
    Purge {
        target: EnvironmentRemovalTarget,
        plan: EnvironmentRemovalPlan,
        confirm_environment_name: String,
    },
}

impl EnvironmentRemovalExecuteInput {
    pub(crate) fn action(&self) -> EnvironmentRemovalAction {
        match self {
            Self::Uninstall { .. } => EnvironmentRemovalAction::Uninstall,
            Self::Purge { .. } => EnvironmentRemovalAction::Purge,
        }
    }

    pub(crate) fn target(&self) -> &EnvironmentRemovalTarget {
        match self {
            Self::Uninstall { target, .. } | Self::Purge { target, .. } => target,
        }
    }

    pub(crate) fn plan(&self) -> &EnvironmentRemovalPlan {
        match self {
            Self::Uninstall { plan, .. } | Self::Purge { plan, .. } => plan,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        self.plan().validate_fresh(OffsetDateTime::now_utc())?;
        if self.target() != &self.plan().target {
            return Err(
                "The environment removal target no longer matches its approved plan.".to_string(),
            );
        }
        if !self.plan().uninstall_supported {
            return Err(self
                .plan()
                .uninstall_unavailable_reason
                .clone()
                .unwrap_or_else(|| NATIVE_PACKAGE_UNINSTALL_REASON.to_string()));
        }
        if let Self::Purge {
            plan,
            confirm_environment_name,
            ..
        } = self
            && confirm_environment_name != &plan.environment_name
        {
            return Err("Purge confirmation does not match the planned environment name.".into());
        }
        Ok(())
    }
}

impl EnvironmentRemovalPlan {
    pub(crate) fn validate_fresh(&self, now: OffsetDateTime) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("The environment removal plan schema is unsupported.".to_string());
        }
        Uuid::parse_str(&self.plan_id)
            .map_err(|_| "The environment removal plan identifier is invalid.".to_string())?;
        Uuid::parse_str(&self.environment_id)
            .map_err(|_| "The planned environment identity is invalid.".to_string())?;
        Uuid::parse_str(&self.storage_id)
            .map_err(|_| "The planned storage identity is invalid.".to_string())?;
        validate_environment_name(&self.environment_name)?;
        validate_absolute_data_root(&self.data_root)?;
        let created_at = OffsetDateTime::parse(&self.created_at, &Rfc3339)
            .map_err(|_| "The environment removal plan creation time is invalid.".to_string())?;
        let expires_at = OffsetDateTime::parse(&self.expires_at, &Rfc3339)
            .map_err(|_| "The environment removal plan expiry is invalid.".to_string())?;
        if expires_at <= created_at || expires_at <= now {
            return Err("The environment removal plan is stale; fetch a fresh plan.".to_string());
        }
        if self.uninstall_supported != self.uninstall_unavailable_reason.is_none() {
            return Err("The environment removal support result is inconsistent.".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnvironmentRemovalResult {
    pub action: EnvironmentRemovalAction,
    pub environment_id: String,
    pub storage_id: String,
    pub service_removed: bool,
    pub binary_removed: bool,
    pub data_removed: bool,
    pub data_root_preserved: bool,
    pub verified: bool,
}

#[derive(Default)]
pub(crate) struct EnvironmentRemovalPlanStore {
    plans: Mutex<HashMap<String, EnvironmentRemovalPlan>>,
}

impl EnvironmentRemovalPlanStore {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn issue(&self, plan: &EnvironmentRemovalPlan) -> Result<(), String> {
        plan.validate_fresh(OffsetDateTime::now_utc())?;
        let mut plans = self
            .plans
            .lock()
            .map_err(|error| format!("Environment removal plan store mutex poisoned: {error}"))?;
        let now = OffsetDateTime::now_utc();
        plans.retain(|_, candidate| candidate.validate_fresh(now).is_ok());
        if let Some(existing) = plans.get(&plan.plan_id) {
            return if existing == plan {
                Ok(())
            } else {
                Err(
                    "The environment removal plan identifier was already issued differently."
                        .to_string(),
                )
            };
        }
        if plans.len() >= MAX_ISSUED_REMOVAL_PLANS {
            return Err(
                "Too many environment removal plans are active; wait for one to expire."
                    .to_string(),
            );
        }
        plans.insert(plan.plan_id.clone(), plan.clone());
        Ok(())
    }

    pub(crate) fn consume(&self, input: &EnvironmentRemovalExecuteInput) -> Result<(), String> {
        input.validate()?;
        let mut plans = self
            .plans
            .lock()
            .map_err(|error| format!("Environment removal plan store mutex poisoned: {error}"))?;
        let Some(issued) = plans.get(&input.plan().plan_id) else {
            return Err(
                "The environment removal plan was not issued by this desktop session.".to_string(),
            );
        };
        if issued != input.plan() {
            return Err(
                "The environment removal plan does not match the native issued plan.".to_string(),
            );
        }
        plans.remove(&input.plan().plan_id);
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerPurgePlan {
    schema_version: u16,
    plan_id: String,
    environment_id: String,
    storage_instance_id: String,
    environment_name: String,
    data_root: String,
    project_count: u64,
    worktree_count: u64,
    process_count: u64,
    other_paired_client_count: u64,
    created_at: String,
    expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerPurgeResult {
    pub environment_id: String,
    pub storage_instance_id: String,
    pub data_root: String,
    pub removed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceUninstallOutput {
    operation: String,
    status: ServiceUninstallStatus,
    data_root_preserved: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceUninstallStatus {
    state: String,
    data_root: String,
}

pub(crate) fn parse_server_plan(
    bytes: &[u8],
    expected: &EnvironmentRemovalPlanInput,
    expected_data_root: &str,
    uninstall_root: Option<&str>,
) -> Result<EnvironmentRemovalPlan, String> {
    expected.validate()?;
    let plan = serde_json::from_slice::<ServerPurgePlan>(bytes)
        .map_err(|_| "The remote server returned an invalid removal plan.".to_string())?;
    if plan.schema_version != 1
        || plan.environment_id != expected.expected_environment_id
        || plan.storage_instance_id != expected.expected_storage_id
        || plan.environment_name != expected.environment_name
        || plan.data_root != expected_data_root
    {
        return Err(
            "The remote removal plan does not match the selected environment identity.".to_string(),
        );
    }
    let uninstall_supported = uninstall_root.is_some();
    let result = EnvironmentRemovalPlan {
        schema_version: plan.schema_version,
        plan_id: plan.plan_id,
        target: expected.target.clone(),
        environment_id: plan.environment_id,
        storage_id: plan.storage_instance_id,
        environment_name: plan.environment_name,
        data_root: plan.data_root,
        project_count: plan.project_count,
        worktree_count: plan.worktree_count,
        process_count: plan.process_count,
        other_paired_client_count: plan.other_paired_client_count,
        created_at: plan.created_at,
        expires_at: plan.expires_at,
        uninstall_supported,
        uninstall_unavailable_reason: (!uninstall_supported)
            .then(|| NATIVE_PACKAGE_UNINSTALL_REASON.to_string()),
    };
    result.validate_fresh(OffsetDateTime::now_utc())?;
    Ok(result)
}

pub(crate) fn parse_server_purge_result(
    bytes: &[u8],
    plan: &EnvironmentRemovalPlan,
) -> Result<(), String> {
    let result = serde_json::from_slice::<ServerPurgeResult>(bytes)
        .map_err(|_| "The remote server returned an invalid purge result.".to_string())?;
    if !result.removed
        || result.environment_id != plan.environment_id
        || result.storage_instance_id != plan.storage_id
        || result.data_root != plan.data_root
    {
        return Err("The remote purge result does not match the approved plan.".to_string());
    }
    Ok(())
}

pub(crate) fn parse_service_uninstall_result(
    bytes: &[u8],
    expected_data_root: &str,
) -> Result<(), String> {
    let result = serde_json::from_slice::<ServiceUninstallOutput>(bytes)
        .map_err(|_| "The remote server returned an invalid uninstall result.".to_string())?;
    if result.operation != "uninstall"
        || result.status.state != "notInstalled"
        || result.status.data_root != expected_data_root
        || !result.data_root_preserved
    {
        return Err("The remote service uninstall could not be verified.".to_string());
    }
    Ok(())
}

pub(crate) fn plan_arguments(data_root: &str, environment_name: &str) -> Vec<String> {
    vec![
        "--base-dir".into(),
        data_root.into(),
        "storage".into(),
        "purge".into(),
        "plan".into(),
        "--environment-name".into(),
        environment_name.into(),
        "--json".into(),
    ]
}

pub(crate) fn purge_arguments(plan: &EnvironmentRemovalPlan) -> Vec<String> {
    vec![
        "--base-dir".into(),
        plan.data_root.clone(),
        "storage".into(),
        "purge".into(),
        "execute".into(),
        "--plan-id".into(),
        plan.plan_id.clone(),
        "--confirm-environment-name".into(),
        plan.environment_name.clone(),
        "--json".into(),
    ]
}

pub(crate) fn service_uninstall_arguments(
    data_root: &str,
    mode: RemoteServiceMode,
    port: u16,
) -> Vec<String> {
    vec![
        "--base-dir".into(),
        data_root.into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "service".into(),
        "uninstall".into(),
        "--mode".into(),
        mode.as_str().into(),
        "--format".into(),
        "json".into(),
    ]
}

pub(crate) fn managed_install_root(host: &RemoteHostProbe, binary_path: &str) -> Option<String> {
    match host.os {
        RemoteHostOs::Linux | RemoteHostOs::MacOs => {
            let path = normalized_posix_path(binary_path)?;
            for base in [&host.install_base, &host.system_install_base] {
                let base = base.trim_end_matches('/');
                let prefix = format!("{base}/versions/");
                if path.strip_prefix(&prefix).is_some_and(|relative| {
                    relative.split_once('/').is_some_and(|(version, suffix)| {
                        !version.is_empty() && suffix == "bibcode-server/bin/bibcode"
                    })
                }) {
                    return Some(base.to_string());
                }
            }
            None
        }
        RemoteHostOs::Windows => {
            let normalized = normalized_windows_path(binary_path)?;
            let local_server = format!(
                r"{}\bibcode\server",
                host.install_base
                    .trim_end_matches(['\\', '/'])
                    .replace('/', "\\")
                    .to_ascii_lowercase()
            );
            let system_server = host
                .system_install_base
                .trim_end_matches(['\\', '/'])
                .replace('/', "\\")
                .to_ascii_lowercase();
            for base in [local_server, system_server] {
                let prefix = format!(r"{base}\versions\");
                if normalized.strip_prefix(&prefix).is_some_and(|relative| {
                    relative.split_once('\\').is_some_and(|(version, suffix)| {
                        !version.is_empty() && suffix == r"bibcode-server\bin\bibcode.exe"
                    })
                }) {
                    return Some(base);
                }
            }
            None
        }
    }
}

pub(crate) fn remote_binary_command(
    host: &RemoteHostProbe,
    binary_path: &str,
    arguments: &[String],
    purpose: RemoteCommandPurpose,
    timeout: std::time::Duration,
) -> Result<RemoteCommand, String> {
    match host.os {
        RemoteHostOs::Linux | RemoteHostOs::MacOs => {
            let (program, arguments) = if host.service_mode == Some(RemoteServiceMode::Headless) {
                if host.install_authority != RemoteInstallAuthority::NoninteractiveAdministrator {
                    return Err(
                        "Headless environment removal requires noninteractive administrator authority."
                            .to_string(),
                    );
                }
                let mut elevated = vec!["-n".to_string(), binary_path.to_string()];
                elevated.extend_from_slice(arguments);
                ("sudo".to_string(), elevated)
            } else {
                (binary_path.to_string(), arguments.to_vec())
            };
            RemoteCommand::new(
                purpose,
                program,
                arguments,
                RemoteStdin::None,
                timeout,
                DEFAULT_REMOTE_OUTPUT_LIMIT,
            )
        }
        RemoteHostOs::Windows => {
            let input = serde_json::to_vec(&serde_json::json!({
                "binaryPath": binary_path,
                "arguments": arguments,
            }))
            .map_err(|error| format!("Could not encode the Windows removal command: {error}"))?;
            powershell_command(
                purpose,
                WINDOWS_MANAGED_BINARY_COMMAND,
                RemoteStdin::Json(input),
            )?
            .with_timeout(timeout)
        }
    }
}

pub(crate) fn remote_remove_install_command(
    host: &RemoteHostProbe,
    install_root: &str,
    data_root: &str,
    preserve_data: bool,
    timeout: std::time::Duration,
) -> Result<RemoteCommand, String> {
    validate_install_root_disjoint(install_root, data_root, host.os)?;
    match host.os {
        RemoteHostOs::Linux | RemoteHostOs::MacOs => {
            let mut arguments = vec![
                "-rf".to_string(),
                "--".to_string(),
                install_root.to_string(),
            ];
            let program = if host.service_mode == Some(RemoteServiceMode::Headless) {
                if host.install_authority != RemoteInstallAuthority::NoninteractiveAdministrator {
                    return Err(
                        "Headless environment removal requires noninteractive administrator authority."
                            .to_string(),
                    );
                }
                arguments.insert(0, "rm".to_string());
                arguments.insert(0, "-n".to_string());
                "sudo"
            } else {
                "rm"
            };
            RemoteCommand::new(
                RemoteCommandPurpose::RemovalCleanup,
                program,
                arguments,
                RemoteStdin::None,
                timeout,
                DEFAULT_REMOTE_OUTPUT_LIMIT,
            )
        }
        RemoteHostOs::Windows => {
            let input = serde_json::to_vec(&serde_json::json!({
                "installRoot": install_root,
                "dataRoot": data_root,
                "preserveData": preserve_data,
            }))
            .map_err(|error| format!("Could not encode the Windows removal cleanup: {error}"))?;
            powershell_command(
                RemoteCommandPurpose::RemovalCleanup,
                WINDOWS_REMOVE_MANAGED_INSTALL,
                RemoteStdin::Json(input),
            )?
            .with_timeout(timeout)
        }
    }
}

pub(crate) fn remote_test_path_command(
    host: &RemoteHostProbe,
    path: &str,
    expect_directory: Option<bool>,
    timeout: std::time::Duration,
) -> Result<Option<RemoteCommand>, String> {
    if host.os == RemoteHostOs::Windows {
        return Ok(None);
    }
    normalized_posix_path(path)
        .ok_or_else(|| "The remote verification path is invalid.".to_string())?;
    let mut arguments = match expect_directory {
        Some(true) => vec!["-d".to_string(), path.to_string()],
        Some(false) => vec!["!".to_string(), "-d".to_string(), path.to_string()],
        None => vec!["!".to_string(), "-e".to_string(), path.to_string()],
    };
    let program = if host.service_mode == Some(RemoteServiceMode::Headless) {
        if host.install_authority != RemoteInstallAuthority::NoninteractiveAdministrator {
            return Err(
                "Headless environment removal requires noninteractive administrator authority."
                    .to_string(),
            );
        }
        arguments.insert(0, "test".to_string());
        arguments.insert(0, "-n".to_string());
        "sudo"
    } else {
        "test"
    };
    RemoteCommand::new(
        RemoteCommandPurpose::RemovalCleanup,
        program,
        arguments,
        RemoteStdin::None,
        timeout,
        DEFAULT_REMOTE_OUTPUT_LIMIT,
    )
    .map(Some)
}

pub(crate) fn validate_install_root_disjoint(
    install_root: &str,
    data_root: &str,
    os: RemoteHostOs,
) -> Result<(), String> {
    let (install, data, separator) = match os {
        RemoteHostOs::Linux | RemoteHostOs::MacOs => (
            normalized_posix_path(install_root)
                .ok_or_else(|| "The managed installation root is invalid.".to_string())?
                .to_string(),
            normalized_posix_path(data_root)
                .ok_or_else(|| "The remote data root is invalid.".to_string())?
                .to_string(),
            '/',
        ),
        RemoteHostOs::Windows => (
            normalized_windows_path(install_root)
                .ok_or_else(|| "The managed installation root is invalid.".to_string())?,
            normalized_windows_path(data_root)
                .ok_or_else(|| "The remote data root is invalid.".to_string())?,
            '\\',
        ),
    };
    let install_prefix = format!("{install}{separator}");
    let data_prefix = format!("{data}{separator}");
    if install == data || install.starts_with(&data_prefix) || data.starts_with(&install_prefix) {
        return Err("The managed installation root overlaps the preserved data root.".to_string());
    }
    Ok(())
}

fn validate_environment_name(value: &str) -> Result<(), String> {
    if value.trim() != value
        || value.is_empty()
        || value.chars().count() > MAX_ENVIRONMENT_NAME_CHARS
        || value.chars().any(char::is_control)
    {
        return Err("The environment name is invalid for a removal plan.".to_string());
    }
    Ok(())
}

fn validate_absolute_data_root(value: &str) -> Result<(), String> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err("The planned data root is invalid.".to_string());
    }
    let posix_absolute = value.starts_with('/')
        && Path::new(value)
            .components()
            .all(|component| !matches!(component, Component::ParentDir | Component::CurDir));
    let windows_absolute = value.len() >= 3
        && value.as_bytes()[1] == b':'
        && matches!(value.as_bytes()[2], b'\\' | b'/')
        && !value
            .split(['\\', '/'])
            .any(|component| matches!(component, "." | ".."));
    if !posix_absolute && !windows_absolute {
        return Err("The planned data root is not an absolute normalized path.".to_string());
    }
    Ok(())
}

fn normalized_posix_path(value: &str) -> Option<&str> {
    let relative = value.strip_prefix('/')?;
    (!relative.is_empty()
        && !relative
            .split('/')
            .any(|component| matches!(component, "." | "..") || component.is_empty()))
    .then_some(value)
}

fn normalized_windows_path(value: &str) -> Option<String> {
    let value = value.replace('/', "\\").to_ascii_lowercase();
    (value.len() >= 3
        && value.as_bytes()[1] == b':'
        && value.as_bytes()[2] == b'\\'
        && !value
            .split('\\')
            .any(|component| matches!(component, "." | "..") || component.is_empty()))
    .then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_host::model::{
        RemoteHostArchitecture, RemoteHostCapabilities, RemoteInstallAuthority, RemoteServiceState,
    };

    const ENVIRONMENT_ID: &str = "76aa78e8-67aa-477e-bd25-68f491885224";
    const STORAGE_ID: &str = "3039b232-95d0-4b2f-a35e-c297b4c895af";

    fn fresh_plan_json(uninstall_supported: bool) -> serde_json::Value {
        let created_at = (OffsetDateTime::now_utc() - time::Duration::minutes(1))
            .format(&Rfc3339)
            .expect("created at");
        let expires_at = (OffsetDateTime::now_utc() + time::Duration::minutes(5))
            .format(&Rfc3339)
            .expect("expires at");
        serde_json::json!({
            "schemaVersion": 1,
            "planId": "6eef32c8-3c6d-4c0d-ad5c-2e9f6dd54074",
            "target": {
                "transport": "wsl",
                "distro": "Ubuntu",
                "discoveryGeneration": 7,
            },
            "environmentId": ENVIRONMENT_ID,
            "storageId": STORAGE_ID,
            "environmentName": "Build host",
            "dataRoot": "/home/dev/.bibcode",
            "projectCount": 0,
            "worktreeCount": 0,
            "processCount": 0,
            "otherPairedClientCount": 1,
            "createdAt": created_at,
            "expiresAt": expires_at,
            "uninstallSupported": uninstall_supported,
            "uninstallUnavailableReason": if uninstall_supported {
                serde_json::Value::Null
            } else {
                serde_json::Value::String(NATIVE_PACKAGE_UNINSTALL_REASON.to_string())
            },
        })
    }

    fn host(os: RemoteHostOs, binary_path: &str) -> RemoteHostProbe {
        RemoteHostProbe {
            os,
            architecture: RemoteHostArchitecture::X86_64,
            installed_version: Some("0.4.1".into()),
            service_mode: Some(RemoteServiceMode::Workstation),
            service_state: RemoteServiceState::Running,
            data_root: Some("/home/dev/.bibcode".into()),
            control_available: true,
            free_bytes: 1,
            install_authority: RemoteInstallAuthority::User,
            home: "/home/dev".into(),
            install_base: "/home/dev/.local/share/bibcode/server".into(),
            system_install_base: "/opt/bibcode/server".into(),
            headless_data_root: "/var/lib/bibcode".into(),
            binary_path: Some(binary_path.into()),
            bind_port: Some(3773),
            capabilities: RemoteHostCapabilities::default(),
        }
    }

    #[test]
    fn managed_roots_accept_only_versioned_bibcode_owned_layouts() {
        let portable = host(
            RemoteHostOs::Linux,
            "/home/dev/.local/share/bibcode/server/versions/v1/bibcode-server/bin/bibcode",
        );
        assert_eq!(
            managed_install_root(&portable, portable.binary_path.as_deref().unwrap()),
            Some("/home/dev/.local/share/bibcode/server".to_string())
        );
        let native = host(RemoteHostOs::Linux, "/usr/bin/bibcode");
        assert_eq!(
            managed_install_root(&native, native.binary_path.as_deref().unwrap()),
            None
        );
        let traversal = host(
            RemoteHostOs::Linux,
            "/home/dev/.local/share/bibcode/server/versions/../bibcode-server/bin/bibcode",
        );
        assert_eq!(
            managed_install_root(&traversal, traversal.binary_path.as_deref().unwrap()),
            None
        );
    }

    #[test]
    fn purge_input_accepts_only_the_camel_case_exact_confirmation() {
        let input = serde_json::json!({
            "action": "purge",
            "target": {
                "transport": "wsl",
                "distro": "Ubuntu",
                "discoveryGeneration": 7,
            },
            "plan": fresh_plan_json(true),
            "confirmEnvironmentName": "Build host",
        });
        let decoded = serde_json::from_value::<EnvironmentRemovalExecuteInput>(input)
            .expect("camel-case purge payload");
        assert_eq!(decoded.action(), EnvironmentRemovalAction::Purge);
        decoded.validate().expect("fresh exact purge confirmation");

        let wrong = serde_json::json!({
            "action": "purge",
            "target": {
                "transport": "wsl",
                "distro": "Ubuntu",
                "discoveryGeneration": 7,
            },
            "plan": fresh_plan_json(true),
            "confirmEnvironmentName": "build host",
        });
        assert!(
            serde_json::from_value::<EnvironmentRemovalExecuteInput>(wrong)
                .expect("well-shaped purge payload")
                .validate()
                .expect_err("case-changing confirmation must fail")
                .contains("does not match")
        );

        let wrong_target = serde_json::json!({
            "action": "uninstall",
            "target": {
                "transport": "wsl",
                "distro": "Debian",
                "discoveryGeneration": 7,
            },
            "plan": fresh_plan_json(true),
        });
        assert!(
            serde_json::from_value::<EnvironmentRemovalExecuteInput>(wrong_target)
                .expect("well-shaped uninstall payload")
                .validate()
                .expect_err("cross-target plan replay must fail")
                .contains("target no longer matches")
        );
    }

    #[test]
    fn server_plan_is_identity_bound_and_exposes_native_package_limitations() {
        let expected = EnvironmentRemovalPlanInput {
            target: EnvironmentRemovalTarget::Wsl {
                distro: "Ubuntu".into(),
                discovery_generation: 7,
            },
            expected_environment_id: ENVIRONMENT_ID.into(),
            expected_storage_id: STORAGE_ID.into(),
            environment_name: "Build host".into(),
        };
        let mut server_plan = fresh_plan_json(true);
        let object = server_plan.as_object_mut().expect("plan object");
        object.insert("storageInstanceId".into(), serde_json::json!(STORAGE_ID));
        object.remove("storageId");
        object.remove("target");
        object.remove("uninstallSupported");
        object.remove("uninstallUnavailableReason");

        let native = parse_server_plan(
            &serde_json::to_vec(&server_plan).expect("server plan"),
            &expected,
            "/home/dev/.bibcode",
            None,
        )
        .expect("identity-bound plan");
        assert!(!native.uninstall_supported);
        assert_eq!(
            native.uninstall_unavailable_reason.as_deref(),
            Some(NATIVE_PACKAGE_UNINSTALL_REASON)
        );

        server_plan["environmentId"] = serde_json::json!(Uuid::new_v4().to_string());
        assert!(
            parse_server_plan(
                &serde_json::to_vec(&server_plan).expect("mismatched plan"),
                &expected,
                "/home/dev/.bibcode",
                Some("/home/dev/.local/share/bibcode/server"),
            )
            .expect_err("identity mismatch must fail")
            .contains("does not match")
        );
    }

    #[test]
    fn removal_roots_must_be_disjoint_and_windows_values_cross_only_json_stdin() {
        assert!(
            validate_install_root_disjoint(
                "/home/dev/.bibcode/server",
                "/home/dev/.bibcode",
                RemoteHostOs::Linux,
            )
            .expect_err("nested roots must fail")
            .contains("overlaps")
        );

        let mut windows = host(
            RemoteHostOs::Windows,
            r"C:\Users\dev\BiBCode Server\bibcode.exe",
        );
        windows.data_root = Some(r"C:\Users\dev\BiBCode Data".into());
        let dynamic_path = r"C:\Users\dev\BiBCode Server\bibcode.exe;Remove-Item C:\private";
        let command = remote_binary_command(
            &windows,
            dynamic_path,
            &["--version".into()],
            RemoteCommandPurpose::RemovalPlan,
            std::time::Duration::from_secs(5),
        )
        .expect("structured Windows command");
        assert!(!command.program.contains(dynamic_path));
        assert!(
            command
                .arguments
                .iter()
                .all(|argument| !argument.contains(dynamic_path))
        );
        let RemoteStdin::Json(stdin) = command.stdin else {
            panic!("dynamic Windows values must cross JSON stdin");
        };
        let document = serde_json::from_slice::<serde_json::Value>(&stdin).expect("JSON stdin");
        assert_eq!(document["binaryPath"], dynamic_path);
    }

    #[test]
    fn issued_plan_store_consumes_exact_plans_and_rejects_modified_renderer_echoes() {
        let store = EnvironmentRemovalPlanStore::new();
        let plan = serde_json::from_value::<EnvironmentRemovalPlan>(fresh_plan_json(true))
            .expect("fresh plan");
        let input = EnvironmentRemovalExecuteInput::Uninstall {
            target: plan.target.clone(),
            plan: plan.clone(),
        };
        assert!(
            store
                .consume(&input)
                .expect_err("unknown plan must fail")
                .contains("not issued")
        );
        store.issue(&plan).expect("issue native plan");
        let mut changed = plan.clone();
        changed.data_root = "/home/dev/other".into();
        let changed_input = EnvironmentRemovalExecuteInput::Uninstall {
            target: changed.target.clone(),
            plan: changed,
        };
        assert!(
            store
                .consume(&changed_input)
                .expect_err("modified plan must fail")
                .contains("does not match")
        );
        store.consume(&input).expect("exact issued plan");
        assert!(
            store
                .consume(&input)
                .expect_err("consumed plan must fail")
                .contains("not issued")
        );
    }
}
