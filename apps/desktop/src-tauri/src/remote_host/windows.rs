use super::model::{
    ArtifactFormat, DEFAULT_REMOTE_COMMAND_TIMEOUT, DEFAULT_REMOTE_OUTPUT_LIMIT,
    REMOTE_INSTALL_COMMAND_TIMEOUT, REMOTE_SERVICE_COMMAND_TIMEOUT,
    REMOTE_TRANSFER_COMMAND_TIMEOUT, RemoteCommand, RemoteCommandOutput, RemoteCommandPurpose,
    RemoteHostAdapter, RemoteHostCapabilities, RemoteHostOs, RemoteHostProbe,
    RemoteInstallAuthority, RemoteServiceMode, RemoteServiceState, RemoteStdin, StagedArtifact,
    VerifiedArtifact, normalize_architecture, parent_path, validate_windows_path,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::json;

const WINDOWS_PROBE_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$probeInputText = [Console]::In.ReadToEnd()
$probeInput = if ([String]::IsNullOrWhiteSpace($probeInputText)) { $null } else { $probeInputText | ConvertFrom-Json }
$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$home = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
$driveRoot = [IO.Path]::GetPathRoot($localAppData)
$driveName = $driveRoot.Substring(0, 1)
$localFreeBytes = [uint64](Get-PSDrive -Name $driveName -ErrorAction Stop).Free
$systemDriveRoot = [IO.Path]::GetPathRoot($programData)
$systemDriveName = $systemDriveRoot.Substring(0, 1)
$systemFreeBytes = [uint64](Get-PSDrive -Name $systemDriveName -ErrorAction Stop).Free
$freeBytes = [Math]::Min($localFreeBytes, $systemFreeBytes)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$binaryPath = $null
if ($null -ne $probeInput -and -not [String]::IsNullOrWhiteSpace([string]$probeInput.managedBinaryPath)) {
  $candidate = [string]$probeInput.managedBinaryPath
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { $binaryPath = $candidate }
} else {
  $binary = Get-Command bibcode.exe -ErrorAction SilentlyContinue
  if ($null -ne $binary) { $binaryPath = $binary.Source }
}
$installedVersion = $null
$serviceMode = $null
$serviceState = 'notInstalled'
$dataRoot = $null
$controlAvailable = $false
$bind = $null
if ($null -ne $binaryPath) {
  $versionLine = & $binaryPath --version 2>$null | Select-Object -First 1
  if ($versionLine -match '([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)') {
    $installedVersion = $Matches[1]
  }
  foreach ($mode in @('workstation', 'headless')) {
    try {
      $statusDocument = (& $binaryPath service status --mode $mode --format json 2>$null | ConvertFrom-Json)
      if ($null -ne $statusDocument.status -and
          ($statusDocument.status.state -eq 'running' -or $serviceMode -eq $null)) {
        $serviceMode = $statusDocument.status.mode
        $serviceState = $statusDocument.status.state
        $dataRoot = $statusDocument.status.dataRoot
        $binaryPath = $statusDocument.status.binaryPath
        $bind = $statusDocument.status.bind
        $controlAvailable = $statusDocument.status.state -eq 'running'
      }
    } catch {}
  }
}
[ordered]@{
  os = 'windows'
  architecture = $architecture
  home = $home
  localAppData = $localAppData
  programData = $programData
  freeBytes = $freeBytes
  isAdministrator = $isAdministrator
  msiAvailable = Test-Path -LiteralPath "$env:SystemRoot\System32\msiexec.exe"
  portableAvailable = $null -ne (Get-Command tar.exe -ErrorAction SilentlyContinue)
  sha256Available = $null -ne (Get-Command Get-FileHash -ErrorAction SilentlyContinue)
  installedVersion = $installedVersion
  serviceMode = $serviceMode
  serviceState = $serviceState
  dataRoot = $dataRoot
  controlAvailable = $controlAvailable
  binaryPath = $binaryPath
  bind = $bind
} | ConvertTo-Json -Compress"#;

const WINDOWS_CREATE_STAGING_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$document = [Console]::In.ReadToEnd() | ConvertFrom-Json
[IO.Directory]::CreateDirectory([string]$document.parent) | Out-Null
[ordered]@{ created = $true } | ConvertTo-Json -Compress"#;

const WINDOWS_TRANSFER_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$inputStream = [Console]::OpenStandardInput()
$lengthBytes = [byte[]]::new(4)
$read = 0
while ($read -lt 4) {
  $count = $inputStream.Read($lengthBytes, $read, 4 - $read)
  if ($count -eq 0) { throw 'Artifact metadata header ended early.' }
  $read += $count
}
if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($lengthBytes) }
$metadataLength = [BitConverter]::ToUInt32($lengthBytes, 0)
if ($metadataLength -eq 0 -or $metadataLength -gt 65536) { throw 'Artifact metadata length is invalid.' }
$metadataBytes = [byte[]]::new($metadataLength)
$read = 0
while ($read -lt $metadataLength) {
  $count = $inputStream.Read($metadataBytes, $read, $metadataLength - $read)
  if ($count -eq 0) { throw 'Artifact metadata ended early.' }
  $read += $count
}
$document = [Text.Encoding]::UTF8.GetString($metadataBytes) | ConvertFrom-Json
$file = [IO.FileStream]::new([string]$document.remotePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $inputStream.CopyTo($file); $file.Flush($true) } finally { $file.Dispose() }
[ordered]@{ transferred = $true } | ConvertTo-Json -Compress"#;

const WINDOWS_VERIFY_TRANSFER_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$document = [Console]::In.ReadToEnd() | ConvertFrom-Json
$hash = (Get-FileHash -LiteralPath ([string]$document.remotePath) -Algorithm SHA256).Hash.ToLowerInvariant()
[ordered]@{ sha256 = $hash; size = (Get-Item -LiteralPath ([string]$document.remotePath)).Length } | ConvertTo-Json -Compress"#;

const WINDOWS_MSI_INSTALL_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$document = [Console]::In.ReadToEnd() | ConvertFrom-Json
$arguments = @('/i', [string]$document.remotePath, '/qn', '/norestart')
$process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { exit $process.ExitCode }
[ordered]@{ installed = $true; restartRequired = $process.ExitCode -eq 3010 } | ConvertTo-Json -Compress"#;

const WINDOWS_PORTABLE_INSTALL_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$document = [Console]::In.ReadToEnd() | ConvertFrom-Json
$staging = ([string]$document.installRoot) + '.staging'
$extraction = Join-Path $staging 'root'
$privilegedArtifact = Join-Path $staging 'artifact.zip'
if (Test-Path -LiteralPath ([string]$document.installRoot)) { throw 'The versioned install root already exists.' }
if (Test-Path -LiteralPath $staging) { throw 'The private extraction root already exists.' }
[IO.Directory]::CreateDirectory($staging) | Out-Null
try {
  if ($document.headless -eq $true) {
    & "$env:SystemRoot\System32\icacls.exe" $staging '/setowner' '*S-1-5-32-544' '/T' '/C' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not assign the private extraction owner.' }
    & "$env:SystemRoot\System32\icacls.exe" $staging '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the private extraction root.' }
  }
  [IO.File]::Copy([string]$document.remotePath, $privilegedArtifact, $false)
  $copiedHash = (Get-FileHash -LiteralPath $privilegedArtifact -Algorithm SHA256).Hash.ToLowerInvariant()
  $copiedSize = [uint64](Get-Item -LiteralPath $privilegedArtifact).Length
  if ($copiedHash -ne ([string]$document.expectedSha256).ToLowerInvariant() -or
      $copiedSize -ne [uint64]$document.expectedSize) {
    throw 'The privileged artifact copy does not match the signed manifest.'
  }
  [IO.Directory]::CreateDirectory($extraction) | Out-Null
  tar.exe -xf $privilegedArtifact -C $extraction
  if ($LASTEXITCODE -ne 0) { throw 'Portable archive extraction failed.' }
  Remove-Item -LiteralPath $privilegedArtifact -Force
  if ($document.headless -eq $true) {
    & "$env:SystemRoot\System32\icacls.exe" $extraction '/setowner' '*S-1-5-32-544' '/T' '/C' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not assign the installed server owner.' }
    & "$env:SystemRoot\System32\icacls.exe" $extraction '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' '*S-1-5-11:(OI)(CI)(RX)' '/T' '/C' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the installed server files.' }
  }
  [IO.Directory]::Move($extraction, [string]$document.installRoot)
  [IO.Directory]::Delete($staging)
} catch {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  throw
}
[ordered]@{ installed = $true } | ConvertTo-Json -Compress"#;

const WINDOWS_SERVICE_INSTALL_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$document = [Console]::In.ReadToEnd() | ConvertFrom-Json
$arguments = @('service', 'install')
if ($document.updateExistingService -eq $true) { $arguments += '--update' }
$arguments += @('--mode', [string]$document.serviceMode, '--format', 'json', '--host', '127.0.0.1', '--port', [string]$document.remotePort, '--base-dir', [string]$document.dataRoot)
$output = & ([string]$document.binaryPath) @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$output"#;

const WINDOWS_CLEANUP_SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
$document = [Console]::In.ReadToEnd() | ConvertFrom-Json
if (Test-Path -LiteralPath ([string]$document.remotePath)) {
  Remove-Item -LiteralPath ([string]$document.remotePath) -Force
}
$staging = ([string]$document.installRoot) + '.staging'
if (Test-Path -LiteralPath $staging) {
  Remove-Item -LiteralPath $staging -Recurse -Force
}
if ($document.removeInstallRoot -eq $true -and Test-Path -LiteralPath ([string]$document.installRoot)) {
  Remove-Item -LiteralPath ([string]$document.installRoot) -Recurse -Force
}
[ordered]@{ cleaned = $true } | ConvertTo-Json -Compress"#;

fn encode_powershell_command(script: &str) -> String {
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for code_unit in script.encode_utf16() {
        bytes.extend_from_slice(&code_unit.to_le_bytes());
    }
    STANDARD.encode(bytes)
}

fn powershell_command(
    purpose: RemoteCommandPurpose,
    script: &'static str,
    stdin: RemoteStdin,
) -> Result<RemoteCommand, String> {
    RemoteCommand::new(
        purpose,
        "powershell.exe",
        [
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-EncodedCommand".to_string(),
            encode_powershell_command(script),
        ],
        stdin,
        DEFAULT_REMOTE_COMMAND_TIMEOUT,
        DEFAULT_REMOTE_OUTPUT_LIMIT,
    )
}

#[cfg(test)]
pub(crate) fn decode_powershell_command(command: &RemoteCommand) -> Result<String, String> {
    if command.program != "powershell.exe" {
        return Err("The remote command is not an owned PowerShell command.".to_string());
    }
    let position = command
        .arguments
        .iter()
        .position(|argument| argument == "-EncodedCommand")
        .ok_or_else(|| "The PowerShell command has no encoded payload.".to_string())?;
    let encoded = command
        .arguments
        .get(position + 1)
        .ok_or_else(|| "The PowerShell command has no encoded payload value.".to_string())?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "The PowerShell command payload is not valid Base64.".to_string())?;
    if bytes.len() % 2 != 0 {
        return Err("The PowerShell command payload is not UTF-16LE.".to_string());
    }
    let units = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&units)
        .map_err(|_| "The PowerShell command payload is not UTF-16LE.".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsProbeDocument {
    os: String,
    architecture: String,
    home: String,
    local_app_data: String,
    #[serde(default)]
    program_data: Option<String>,
    free_bytes: u64,
    is_administrator: bool,
    msi_available: bool,
    portable_available: bool,
    sha256_available: bool,
    installed_version: Option<String>,
    service_mode: Option<RemoteServiceMode>,
    service_state: RemoteServiceState,
    data_root: Option<String>,
    control_available: bool,
    binary_path: Option<String>,
    bind: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct WindowsRemoteHostAdapter;

impl RemoteHostAdapter for WindowsRemoteHostAdapter {
    fn os(&self) -> RemoteHostOs {
        RemoteHostOs::Windows
    }

    fn probe_commands(&self) -> Vec<RemoteCommand> {
        vec![
            powershell_command(
                RemoteCommandPurpose::WindowsProbe,
                WINDOWS_PROBE_SCRIPT,
                RemoteStdin::None,
            )
            .expect("Windows probe is a repository-owned constant"),
        ]
    }

    fn parse_probe(&self, outputs: &[RemoteCommandOutput]) -> Result<RemoteHostProbe, String> {
        let output = outputs
            .iter()
            .find(|output| output.purpose == RemoteCommandPurpose::WindowsProbe)
            .ok_or_else(|| "The Windows probe returned no result.".to_string())?;
        if !output.succeeded() {
            return Err("The Windows PowerShell probe failed.".to_string());
        }
        let document = serde_json::from_slice::<WindowsProbeDocument>(&output.stdout)
            .map_err(|_| "The Windows probe returned an invalid document.".to_string())?;
        if document.os != "windows" {
            return Err("The selected SSH host is not Windows.".to_string());
        }
        validate_windows_path(&document.home, "home directory")?;
        validate_windows_path(&document.local_app_data, "local application data root")?;
        if !document.sha256_available {
            return Err(
                "Windows remote provisioning requires Get-FileHash for post-transfer verification."
                    .to_string(),
            );
        }
        if let Some(data_root) = &document.data_root {
            validate_windows_path(data_root, "data root")?;
        }
        if let Some(binary_path) = &document.binary_path {
            validate_windows_path(binary_path, "installed binary")?;
        }
        let bind_port = document
            .bind
            .as_deref()
            .and_then(|bind| bind.parse::<std::net::SocketAddr>().ok())
            .filter(|bind| bind.ip().is_loopback() && bind.port() != 0)
            .map(|bind| bind.port());
        let capabilities = RemoteHostCapabilities {
            deb_installer: false,
            rpm_installer: false,
            package_installer: false,
            msi_installer: document.msi_available,
            portable_extractor: document.portable_available,
            sha256: true,
        };
        let program_data = document
            .program_data
            .unwrap_or_else(|| r"C:\ProgramData".to_string());
        validate_windows_path(&program_data, "program data root")?;
        Ok(RemoteHostProbe {
            os: RemoteHostOs::Windows,
            architecture: normalize_architecture(&document.architecture)?,
            installed_version: document.installed_version,
            service_mode: document.service_mode,
            service_state: document.service_state,
            data_root: document.data_root.or_else(|| {
                Some(format!(
                    "{}\\.bibcode",
                    document.home.trim_end_matches('\\')
                ))
            }),
            control_available: document.control_available
                && document.service_state == RemoteServiceState::Running,
            free_bytes: document.free_bytes,
            install_authority: if document.is_administrator {
                RemoteInstallAuthority::NoninteractiveAdministrator
            } else {
                RemoteInstallAuthority::User
            },
            home: document.home,
            install_base: document.local_app_data,
            system_install_base: format!(r"{program_data}\BiBCode\Server"),
            headless_data_root: format!(r"{program_data}\BiBCode"),
            binary_path: document.binary_path,
            bind_port,
            capabilities,
        })
    }

    fn preferred_formats(&self, probe: &RemoteHostProbe) -> Vec<ArtifactFormat> {
        if probe.installed_version.is_some() {
            if probe.capabilities.portable_extractor {
                vec![ArtifactFormat::Zip]
            } else {
                Vec::new()
            }
        } else if probe.capabilities.msi_installer {
            vec![ArtifactFormat::Msi]
        } else if probe.capabilities.portable_extractor {
            vec![ArtifactFormat::Zip]
        } else {
            Vec::new()
        }
    }

    fn stage_commands(&self, input: &VerifiedArtifact) -> Result<Vec<RemoteCommand>, String> {
        if input.os != RemoteHostOs::Windows {
            return Err("The Windows adapter cannot stage a non-Windows artifact.".to_string());
        }
        validate_windows_path(&input.remote_path, "artifact staging path")?;
        let parent = parent_path(&input.remote_path, '\\')?;
        let create_input = serde_json::to_vec(&json!({ "parent": parent }))
            .map_err(|error| format!("Could not encode Windows staging input: {error}"))?;
        let transfer_metadata = serde_json::to_vec(&json!({
            "remotePath": input.remote_path,
            "size": input.size,
            "sha256": input.sha256,
        }))
        .map_err(|error| format!("Could not encode Windows transfer metadata: {error}"))?;
        let verify_input = serde_json::to_vec(&json!({ "remotePath": input.remote_path }))
            .map_err(|error| format!("Could not encode Windows verification input: {error}"))?;
        Ok(vec![
            powershell_command(
                RemoteCommandPurpose::CreateStaging,
                WINDOWS_CREATE_STAGING_SCRIPT,
                RemoteStdin::Json(create_input),
            )?,
            powershell_command(
                RemoteCommandPurpose::Transfer,
                WINDOWS_TRANSFER_SCRIPT,
                RemoteStdin::Artifact {
                    local_path: input.local_path.clone(),
                    metadata: transfer_metadata,
                    expected_size: input.size,
                },
            )?
            .with_timeout(REMOTE_TRANSFER_COMMAND_TIMEOUT)?,
            powershell_command(
                RemoteCommandPurpose::VerifyTransfer,
                WINDOWS_VERIFY_TRANSFER_SCRIPT,
                RemoteStdin::Json(verify_input),
            )?,
        ])
    }

    fn install_commands(&self, input: &StagedArtifact) -> Result<Vec<RemoteCommand>, String> {
        validate_windows_path(&input.verified.remote_path, "artifact staging path")?;
        validate_windows_path(&input.verified.install_root, "install root")?;
        if input.service_mode == RemoteServiceMode::Headless
            && input.authority != RemoteInstallAuthority::NoninteractiveAdministrator
        {
            return Err(
                "Windows headless installation requires an administrator SSH session.".to_string(),
            );
        }
        if input.service_mode == RemoteServiceMode::Headless
            && input.verified.format != ArtifactFormat::Zip
        {
            return Err("Windows headless setup requires a portable server artifact.".to_string());
        }
        let document = serde_json::to_vec(&json!({
            "remotePath": input.verified.remote_path,
            "installRoot": input.verified.install_root,
            "expectedSha256": input.verified.sha256,
            "expectedSize": input.verified.size,
            "headless": input.service_mode == RemoteServiceMode::Headless,
        }))
        .map_err(|error| format!("Could not encode Windows install input: {error}"))?;
        match input.verified.format {
            ArtifactFormat::Msi => Ok(vec![
                powershell_command(
                    RemoteCommandPurpose::Install,
                    WINDOWS_MSI_INSTALL_SCRIPT,
                    RemoteStdin::Json(document),
                )?
                .with_timeout(REMOTE_INSTALL_COMMAND_TIMEOUT)?,
            ]),
            ArtifactFormat::Zip => Ok(vec![
                powershell_command(
                    RemoteCommandPurpose::Install,
                    WINDOWS_PORTABLE_INSTALL_SCRIPT,
                    RemoteStdin::Json(document),
                )?
                .with_timeout(REMOTE_INSTALL_COMMAND_TIMEOUT)?,
            ]),
            _ => Err("The Windows adapter received an unsupported artifact format.".to_string()),
        }
    }

    fn service_commands(&self, input: &StagedArtifact) -> Result<Vec<RemoteCommand>, String> {
        validate_windows_path(&input.installed_binary_path, "installed binary")?;
        validate_windows_path(&input.verified.data_root, "data root")?;
        if input.service_mode == RemoteServiceMode::Headless
            && input.authority != RemoteInstallAuthority::NoninteractiveAdministrator
        {
            return Err(
                "Windows headless service installation requires an administrator SSH session."
                    .to_string(),
            );
        }
        let document = serde_json::to_vec(&json!({
            "binaryPath": input.installed_binary_path,
            "serviceMode": input.service_mode.as_str(),
            "remotePort": input.verified.remote_port,
            "dataRoot": input.verified.data_root,
            "updateExistingService": input.update_existing_service,
        }))
        .map_err(|error| format!("Could not encode Windows service input: {error}"))?;
        Ok(vec![
            powershell_command(
                RemoteCommandPurpose::Service,
                WINDOWS_SERVICE_INSTALL_SCRIPT,
                RemoteStdin::Json(document),
            )?
            .with_timeout(REMOTE_SERVICE_COMMAND_TIMEOUT)?,
        ])
    }

    fn cleanup_commands(
        &self,
        input: &VerifiedArtifact,
        remove_install_root: bool,
    ) -> Result<Vec<RemoteCommand>, String> {
        validate_windows_path(&input.remote_path, "artifact staging path")?;
        validate_windows_path(&input.install_root, "install root")?;
        let document = serde_json::to_vec(&json!({
            "remotePath": input.remote_path,
            "installRoot": input.install_root,
            "removeInstallRoot": remove_install_root && input.format == ArtifactFormat::Zip,
        }))
        .map_err(|error| format!("Could not encode Windows cleanup input: {error}"))?;
        Ok(vec![powershell_command(
            RemoteCommandPurpose::Cleanup,
            WINDOWS_CLEANUP_SCRIPT,
            RemoteStdin::Json(document),
        )?])
    }
}
