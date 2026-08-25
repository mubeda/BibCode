use crate::remote_host::{
    linux::LinuxRemoteHostAdapter,
    macos::MacOsRemoteHostAdapter,
    model::{
        ArtifactFormat, CleanupStatus, MutationStatus, RemoteCommand, RemoteCommandOutput,
        RemoteCommandPurpose, RemoteHostAdapter, RemoteHostArchitecture, RemoteHostOs,
        RemoteHostProbe, RemoteInstallAuthority, RemoteInstallFailure, RemoteInstallStage,
        RemoteServiceMode, RemoteServiceState, RemoteStdin, StagedArtifact, VerifiedArtifact,
    },
    render_posix_remote_command,
    windows::WindowsRemoteHostAdapter,
};
use crate::remote_operation::{
    RemoteHostCloseGuard, RemoteOperationClass, RemoteOperationCoordinator, RemoteOperationFence,
    RemoteOperationLease, RemoteTunnelPermit,
};
use crate::server_artifacts::{
    ResolvedServerArtifact, ServerArtifactRecord, ServerArtifactRequest, ServerArtifactSource,
};
use bibcode_server::process::configure_background_command;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    env, fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, oneshot, watch};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const SSH_DIRECTORY_NAME: &str = ".ssh";
const SSH_CONFIG_FILE_NAME: &str = "config";
const KNOWN_HOSTS_FILE_NAME: &str = "known_hosts";
pub const SSH_PASSWORD_PROMPT_EVENT: &str = "desktop:ssh-password-prompt";
const DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT: Duration = Duration::from_secs(3 * 60);
const DEFAULT_REMOTE_PORT: u16 = 3773;
const SSH_READY_PATH: &str = "/.well-known/bibcode/environment";
const SSH_READY_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_READY_INTERVAL: Duration = Duration::from_millis(250);
const SSH_READY_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const SSH_CONFIG_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(10);
const SSH_TUNNEL_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1500);
const SSH_CHILD_REAPER_CAPACITY: usize = 32;
const SSH_PROVISIONING_CAPACITY: usize = 4;
const SSH_TUNNEL_CAPACITY: usize = 16;
const SSH_COMMAND_OUTPUT_LIMIT: usize = 256 * 1024;
const SSH_REMOTE_SCRIPT_COMMAND_MARKER: &str = "Sending command: sh -s --";
const SSH_EXPECTED_HOST_KEY_FINGERPRINT_ENV: &str = "BIBCODE_SSH_EXPECTED_HOST_KEY_FINGERPRINT";
const SSH_HOST_KEY_OBSERVATION_PATH_ENV: &str = "BIBCODE_SSH_HOST_KEY_OBSERVATION_PATH";
const SSH_HOST_KEY_PIN_MISMATCH_MARKER: &str = "BIBCODE_SSH_HOST_KEY_PIN_MISMATCH";
const SSH_HOST_KEY_PIN_HELPER_ENV: &str = "BIBCODE_SSH_HOST_KEY_PIN_HELPER";
const SSH_INTERNAL_ENVIRONMENT_VARIABLES: [&str; 6] = [
    "BIBCODE_SSH_AUTH_SECRET",
    SSH_EXPECTED_HOST_KEY_FINGERPRINT_ENV,
    SSH_HOST_KEY_OBSERVATION_PATH_ENV,
    SSH_HOST_KEY_PIN_HELPER_ENV,
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
];
const REMOTE_PORT_SCAN_WINDOW: u16 = 200;
const REMOTE_READY_TIMEOUT_MS: u64 = 15_000;
const REMOTE_REUSE_READY_TIMEOUT_MS: u64 = 2_000;
const SSH_TRUST_PROBE_MARKER: &str = "bibcode-ssh-trust-ok";
const SSH_SETUP_CONSENT_LIFETIME: Duration = Duration::from_secs(5 * 60);
const SSH_SETUP_REQUIRED_SPACE_MULTIPLIER: u64 = 3;
const SSH_SETUP_DESCRIPTOR_LIMIT: usize = 256 * 1024;
const ASKPASS_POSIX_SCRIPT: &str = r#"#!/bin/sh
if [ "${BIBCODE_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s\n" "$BIBCODE_SSH_AUTH_SECRET"
  exit 0
fi
printf 'BiBCode ssh-askpass invoked without BIBCODE_SSH_AUTH_SECRET.\n' >&2
exit 1
"#;
const ASKPASS_WINDOWS_LAUNCHER_SCRIPT: &str = "@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0ssh-askpass.ps1\" %*\r\n";
const ASKPASS_WINDOWS_SCRIPT: &str = r#"# Invoked by ssh via SSH_ASKPASS when BiBCode re-runs ssh with a cached password.
if ($null -ne $env:BIBCODE_SSH_AUTH_SECRET) {
  [Console]::Out.WriteLine($env:BIBCODE_SSH_AUTH_SECRET)
  exit 0
}
[Console]::Error.WriteLine("BiBCode ssh-askpass invoked without BIBCODE_SSH_AUTH_SECRET.")
exit 1
"#;
const HOST_KEY_PIN_POSIX_SCRIPT: &str = r#"#!/bin/sh
invocation="${1-}"
observed="${2-}"
if [ "$invocation" = "ORDER" ]; then
  exit 0
fi
if [ -n "${BIBCODE_SSH_HOST_KEY_OBSERVATION_PATH-}" ]; then
  umask 077
  if ! printf '%s\n' "$observed" > "$BIBCODE_SSH_HOST_KEY_OBSERVATION_PATH"; then
    printf 'BIBCODE_SSH_HOST_KEY_OBSERVATION_FAILED\n' >&2
    exit 1
  fi
fi
if [ "${BIBCODE_SSH_EXPECTED_HOST_KEY_FINGERPRINT+x}" = "x" ] &&
   [ "$BIBCODE_SSH_EXPECTED_HOST_KEY_FINGERPRINT" != "$observed" ]; then
  printf 'BIBCODE_SSH_HOST_KEY_PIN_MISMATCH\n' >&2
  exit 1
fi
if [ "${BIBCODE_SSH_EXPECTED_HOST_KEY_FINGERPRINT+x}" != "x" ] &&
   [ -z "${BIBCODE_SSH_HOST_KEY_OBSERVATION_PATH-}" ]; then
  printf 'BIBCODE_SSH_HOST_KEY_PIN_CONFIGURATION_MISSING\n' >&2
  exit 1
fi
exit 0
"#;
const HOST_KEY_PIN_WINDOWS_SCRIPT: &str = r#"$invocation = if ($args.Count -gt 0) { $args[0] } else { "" }
$observed = if ($args.Count -gt 1) { $args[1] } else { "" }
if ($invocation -eq "ORDER") {
  exit 0
}
$observationPath = $env:BIBCODE_SSH_HOST_KEY_OBSERVATION_PATH
if (-not [String]::IsNullOrEmpty($observationPath)) {
  try {
    [IO.File]::WriteAllText($observationPath, $observed + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  } catch {
    [Console]::Error.WriteLine("BIBCODE_SSH_HOST_KEY_OBSERVATION_FAILED")
    exit 1
  }
}
$expected = $env:BIBCODE_SSH_EXPECTED_HOST_KEY_FINGERPRINT
if ($null -ne $expected -and $expected -ne $observed) {
  [Console]::Error.WriteLine("BIBCODE_SSH_HOST_KEY_PIN_MISMATCH")
  exit 1
}
if ($null -eq $expected -and [String]::IsNullOrEmpty($observationPath)) {
  [Console]::Error.WriteLine("BIBCODE_SSH_HOST_KEY_PIN_CONFIGURATION_MISSING")
  exit 1
}
exit 0
"#;

const REMOTE_LAUNCH_SCRIPT: &str = r#"set -eu
umask 077
STATE_KEY="$1"
STATE_DIR="$HOME/.bibcode-ssh-launch/$STATE_KEY"
SERVER_HOME="$HOME/.bibcode"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-bibcode.sh"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
: > "$LOG_FILE"
chmod 600 "$LOG_FILE"
cat >"$RUNNER_FILE" <<'SH'
#!/bin/sh
if command -v bibcode >/dev/null 2>&1; then
  exec bibcode "$@"
fi
printf 'Remote host is missing the native BiBCode CLI. Install the Rust bibcode binary before connecting.\n' >&2
exit 1
SH
chmod 700 "$RUNNER_FILE"
wait_ready() {
  port="$1"
  attempts=$(($2 / 100))
  [ "$attempts" -gt 0 ] || attempts=1
  while [ "$attempts" -gt 0 ]; do
    if command -v curl >/dev/null 2>&1; then
      curl --fail --silent --show-error --max-time 1 \
        "http://127.0.0.1:$port/.well-known/bibcode/environment" >/dev/null 2>&1 && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget --quiet --timeout=1 --output-document=/dev/null \
        "http://127.0.0.1:$port/.well-known/bibcode/environment" >/dev/null 2>&1 && return 0
    else
      printf 'Remote host requires curl or wget for readiness checks.\n' >&2
      return 1
    fi
    attempts=$((attempts - 1))
    sleep 0.1
  done
  return 1
}
port_in_use() {
  port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss_output="$(ss -H -ltn "sport = :$port" 2>/dev/null)"; then
      if [ -n "$ss_output" ]; then
        return 0
      fi
      return 1
    fi
    printf 'Remote host ss could not perform the required listener probe safely.\n' >&2
    return 2
  fi
  if [ -r /proc/net/tcp ]; then
    socket_tables="/proc/net/tcp"
    if [ -r /proc/net/tcp6 ]; then
      socket_tables="$socket_tables /proc/net/tcp6"
    fi
    hex_port=$(printf '%04X' "$port")
    # shellcheck disable=SC2086 -- fixed, locally constructed procfs paths.
    awk -v suffix=":$hex_port" \
      '$2 ~ suffix "$" && $4 == "0A" { found = 1 } END { exit found ? 0 : 1 }' \
      $socket_tables 2>/dev/null
    return $?
  fi
  printf 'Remote host requires ss or readable Linux procfs for safe managed port selection.\n' >&2
  return 2
}
pick_port() {
  start=$(cat "$PORT_FILE" 2>/dev/null || true)
  case "$start" in
    ''|*[!0-9]*) start="@@DEFAULT_REMOTE_PORT@@" ;;
  esac
  end=$((start + @@REMOTE_PORT_SCAN_WINDOW@@))
  port="$start"
  while [ "$port" -lt "$end" ]; do
    if port_in_use "$port"; then
      port_status=0
    else
      port_status=$?
    fi
    case "$port_status" in
      0) ;;
      1)
        printf '%s' "$port"
        return 0
        ;;
      *) return "$port_status" ;;
    esac
    port=$((port + 1))
  done
  return 1
}
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
if [ "$REMOTE_MANAGED" = "managed" ] && [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null && wait_ready "$REMOTE_PORT" "@@REMOTE_REUSE_READY_TIMEOUT_MS@@"; then
  printf '{"remotePort":%s,"serverKind":"managed"}\n' "$REMOTE_PORT"
  exit 0
fi
REMOTE_PORT="$(pick_port)" || true
if [ -z "$REMOTE_PORT" ]; then
  printf 'Failed to find an available port on the remote host.\n' >&2
  exit 1
fi
nohup env BIBCODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$SERVER_HOME" --no-startup-pairing >>"$LOG_FILE" 2>&1 < /dev/null &
REMOTE_PID="$!"
printf '%s\n' "$REMOTE_PID" >"$PID_FILE"
printf '%s\n' "$REMOTE_PORT" >"$PORT_FILE"
printf 'managed\n' >"$MANAGED_FILE"
if ! wait_ready "$REMOTE_PORT" "@@REMOTE_READY_TIMEOUT_MS@@"; then
  printf 'Remote BiBCode server did not become ready on 127.0.0.1:%s.\n' "$REMOTE_PORT" >&2
  kill "$REMOTE_PID" 2>/dev/null || true
  rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
  exit 1
fi
printf '{"remotePort":%s,"serverKind":"managed"}\n' "$REMOTE_PORT"
"#;

const REMOTE_STOP_SCRIPT: &str = r#"set -eu
STATE_KEY="$1"
STATE_DIR="$HOME/.bibcode-ssh-launch/$STATE_KEY"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
MANAGED_FILE="$STATE_DIR/managed"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  kill "$REMOTE_PID" 2>/dev/null || true
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
printf '{"stopped":true}\n'
"#;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEnvironmentTarget {
    pub alias: String,
    pub hostname: String,
    pub username: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEnvironmentEnsureOptions {
    pub expected_host_key_fingerprint: Option<String>,
    pub operation_id: Option<String>,
    pub environment_generation: Option<u64>,
    pub binding_generation: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshServerProbeInput {
    pub target: SshEnvironmentTarget,
    pub expected_host_key_fingerprint: Option<String>,
    pub managed_binary_path: Option<String>,
    pub operation_id: Option<String>,
    pub environment_generation: Option<u64>,
    pub binding_generation: Option<u64>,
    #[serde(default)]
    pub service_mode: RemoteServiceMode,
    pub expected_environment_id: Option<String>,
    pub expected_storage_instance_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshSetupConsentDecision {
    pub request_id: String,
    pub probe_generation: u64,
    pub accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshOperationCancelInput {
    pub target: SshEnvironmentTarget,
    pub operation_id: String,
    pub environment_generation: u64,
    pub binding_generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SshSetupCompatibility {
    Compatible,
    SetupRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshSetupVerification {
    manifest_signature: &'static str,
    artifact_signature: &'static str,
    checksum: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshSetupConsent {
    pub request_id: String,
    pub probe_generation: u64,
    transport: &'static str,
    target_label: String,
    target_version: String,
    artifact_source: String,
    verification: SshSetupVerification,
    artifact: ServerArtifactRecord,
    install_destination: String,
    data_root: String,
    service_mode: RemoteServiceMode,
    required_commands: Vec<String>,
    expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshServerProbe {
    pub request_id: String,
    pub probe_generation: u64,
    pub target: SshEnvironmentTarget,
    pub host_key_fingerprint: String,
    pub compatibility: SshSetupCompatibility,
    pub probe: RemoteHostProbe,
    pub installed_binary_path: Option<String>,
    pub consent: Option<SshSetupConsent>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SshSetupStatus {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshSetupResult {
    pub request_id: String,
    pub generation: u64,
    pub target: SshEnvironmentTarget,
    pub status: SshSetupStatus,
    pub stage: RemoteInstallStage,
    pub mutation_status: MutationStatus,
    pub cleanup_status: CleanupStatus,
    pub installed_version: Option<String>,
    pub previous_version: Option<String>,
    pub managed_binary_path: Option<String>,
    pub data_root: String,
    pub host_key_fingerprint: String,
    pub descriptor: Option<Value>,
    pub bootstrap: Option<SshEnvironmentBootstrap>,
    pub recovery_command: Option<String>,
    pub message: Option<String>,
}

struct SshSetupOutcome {
    status: SshSetupStatus,
    stage: RemoteInstallStage,
    mutation_status: MutationStatus,
    cleanup_status: CleanupStatus,
    installed_version: Option<String>,
    descriptor: Option<Value>,
    bootstrap: Option<SshEnvironmentBootstrap>,
    message: Option<String>,
}

#[derive(Clone, Debug)]
struct SshInstallPaths {
    remote_artifact: String,
    install_root: String,
    installed_binary: String,
    data_root: String,
    remote_port: u16,
}

#[derive(Clone)]
struct PreparedSshSetup {
    request_id: String,
    probe_generation: u64,
    target: SshEnvironmentTarget,
    host_key_fingerprint: String,
    probe: RemoteHostProbe,
    target_version: String,
    service_mode: RemoteServiceMode,
    expected_environment_id: Option<String>,
    expected_storage_instance_id: Option<String>,
    resolved: ResolvedServerArtifact,
    format: ArtifactFormat,
    paths: SshInstallPaths,
    expires_at: OffsetDateTime,
    operation_fence: RemoteOperationFence,
}

#[derive(Default)]
struct SshSetupState {
    generation: u64,
    prepared: HashMap<String, PreparedSshSetup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEnvironmentDisconnectOptions {
    pub expected_host_key_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEnvironmentBootstrap {
    pub target: SshEnvironmentTarget,
    pub http_base_url: String,
    pub ws_base_url: String,
    pub host_key_fingerprint: String,
    pub remote_port: u16,
    pub remote_server_kind: &'static str,
}

impl SshEnvironmentBootstrap {
    pub fn new(
        target: SshEnvironmentTarget,
        remote_port: u16,
        http_base_url: String,
        ws_base_url: String,
        host_key_fingerprint: String,
        remote_server_kind: &'static str,
    ) -> Self {
        Self {
            target,
            http_base_url,
            ws_base_url,
            host_key_fingerprint,
            remote_port,
            remote_server_kind,
        }
    }

    pub fn external(
        target: SshEnvironmentTarget,
        remote_port: u16,
        http_base_url: String,
        ws_base_url: String,
        host_key_fingerprint: String,
    ) -> Self {
        Self::new(
            target,
            remote_port,
            http_base_url,
            ws_base_url,
            host_key_fingerprint,
            "external",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteLaunchResult {
    pub remote_port: u16,
    pub server_kind: String,
}

impl RemoteLaunchResult {
    fn server_kind_static(&self) -> &'static str {
        if self.server_kind == "external" {
            "external"
        } else {
            "managed"
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteLaunchResultDocument {
    remote_port: u64,
    server_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshAuthOptions {
    auth_secret: Option<String>,
    batch_mode: &'static str,
    interactive_auth: bool,
}

impl SshAuthOptions {
    pub fn batch() -> Self {
        Self {
            auth_secret: None,
            batch_mode: "yes",
            interactive_auth: false,
        }
    }

    pub fn with_secret(auth_secret: String) -> Self {
        Self {
            auth_secret: Some(auth_secret),
            batch_mode: "no",
            interactive_auth: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshHostKeyFailureKind {
    Changed,
    Unknown,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshHostProbe {
    pub target: SshEnvironmentTarget,
    pub host_key_fingerprint: String,
}

pub fn parse_ssh_host_key_fingerprint(output: &str) -> Result<String, String> {
    let mut last_fingerprint = None;
    for line in output.lines() {
        let normalized = line.to_ascii_lowercase();
        if !normalized.contains("server host key:")
            && !normalized.contains("server host certificate:")
        {
            continue;
        }
        if let Some(fingerprint) = line
            .split_whitespace()
            .find(|field| field.starts_with("SHA256:"))
            && is_valid_sha256_host_key_fingerprint(fingerprint)
        {
            last_fingerprint = Some(fingerprint.to_string());
        }
    }
    last_fingerprint.ok_or_else(|| {
        "OpenSSH did not report the verified server host-key fingerprint.".to_string()
    })
}

fn is_valid_sha256_host_key_fingerprint(fingerprint: &str) -> bool {
    let Some(digest) = fingerprint.strip_prefix("SHA256:") else {
        return false;
    };
    digest.len() == 43
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}

pub fn classify_ssh_host_key_failure(output: &str) -> SshHostKeyFailureKind {
    let normalized = output.to_ascii_lowercase();
    if normalized.contains("remote host identification has changed")
        || normalized.contains("possible dns spoofing detected")
        || normalized.contains("revoked host key")
        || normalized.contains("host key is marked as revoked")
        || normalized.contains("offending") && normalized.contains("host key")
    {
        SshHostKeyFailureKind::Changed
    } else if normalized.contains("host key verification failed")
        || normalized.contains("host key is known")
        || normalized.contains("authenticity of host")
    {
        SshHostKeyFailureKind::Unknown
    } else {
        SshHostKeyFailureKind::Other
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshEnvironmentLaunchPlan {
    pub key: String,
    pub program: String,
    pub args: Vec<String>,
    pub target: SshEnvironmentTarget,
    pub local_port: u16,
    pub remote_port: u16,
    pub remote_server_kind: &'static str,
    pub http_base_url: String,
    pub ws_base_url: String,
}

impl SshEnvironmentLaunchPlan {
    pub fn external(target: SshEnvironmentTarget, local_port: u16) -> Result<Self, String> {
        Self::forward(
            target,
            local_port,
            RemoteLaunchResult {
                remote_port: DEFAULT_REMOTE_PORT,
                server_kind: "external".to_string(),
            },
        )
    }

    pub fn forward(
        target: SshEnvironmentTarget,
        local_port: u16,
        remote: RemoteLaunchResult,
    ) -> Result<Self, String> {
        Self::forward_with_auth(target, local_port, remote, &SshAuthOptions::batch())
    }

    pub fn forward_with_auth(
        target: SshEnvironmentTarget,
        local_port: u16,
        remote: RemoteLaunchResult,
        auth: &SshAuthOptions,
    ) -> Result<Self, String> {
        let target = normalize_ssh_environment_target(target)?;
        let key = target_connection_key(&target);
        let remote_port = remote.remote_port;
        let http_base_url = format!("http://127.0.0.1:{local_port}/");
        let ws_base_url = format!("ws://127.0.0.1:{local_port}/");
        let mut args = Vec::new();
        args.extend(base_ssh_args_with_auth(&target, auth));
        args.extend([
            "-o".to_string(),
            "ExitOnForwardFailure=yes".to_string(),
            "-o".to_string(),
            "ServerAliveInterval=15".to_string(),
            "-o".to_string(),
            "ServerAliveCountMax=3".to_string(),
            "-n".to_string(),
            "-N".to_string(),
            "-L".to_string(),
            format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
            "-o".to_string(),
            "LogLevel=DEBUG".to_string(),
            "-o".to_string(),
            "FingerprintHash=sha256".to_string(),
        ]);
        args.push("--".to_string());
        args.push(build_ssh_host_spec(&target)?);

        Ok(Self {
            key,
            program: ssh_command().to_string(),
            args,
            target,
            local_port,
            remote_port,
            remote_server_kind: remote.server_kind_static(),
            http_base_url,
            ws_base_url,
        })
    }
}

struct ManagedSshTunnel {
    child: ManagedSshChild,
    bootstrap: SshEnvironmentBootstrap,
    _permit: RemoteTunnelPermit,
}

pub struct SshEnvironmentManager {
    tunnels: Mutex<HashMap<String, ManagedSshTunnel>>,
    auth_secrets: Mutex<HashMap<String, String>>,
    askpass_temporary_base: PathBuf,
    askpass_launcher: Mutex<Weak<SshAskpassLauncherInner>>,
    child_reaper: SshChildReaper,
    operations: Arc<RemoteOperationCoordinator>,
    setup_state: Mutex<SshSetupState>,
    artifact_source: Result<ServerArtifactSource, String>,
}

impl Default for SshEnvironmentManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SshEnvironmentManager {
    pub fn new() -> Self {
        Self::with_askpass_temp_base_internal(env::temp_dir())
    }

    fn with_askpass_temp_base_internal(askpass_temporary_base: PathBuf) -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
            auth_secrets: Mutex::new(HashMap::new()),
            askpass_temporary_base,
            askpass_launcher: Mutex::new(Weak::new()),
            child_reaper: SshChildReaper::new(),
            operations: Arc::new(RemoteOperationCoordinator::new(
                SSH_PROVISIONING_CAPACITY,
                SSH_TUNNEL_CAPACITY,
            )),
            setup_state: Mutex::new(SshSetupState::default()),
            artifact_source: ServerArtifactSource::production(),
        }
    }

    #[cfg(test)]
    fn with_askpass_temp_base(askpass_temporary_base: PathBuf) -> Self {
        Self::with_askpass_temp_base_internal(askpass_temporary_base)
    }

    fn askpass_launcher(&self) -> Result<SshAskpassLauncher, String> {
        if let Some(existing) = self
            .askpass_launcher
            .lock()
            .map_err(|error| format!("Could not access SSH askpass owner: {error}"))?
            .upgrade()
        {
            return Ok(SshAskpassLauncher {
                inner: existing,
                child_reaper: self.child_reaper.clone(),
            });
        }

        let created =
            SshAskpassLauncher::create_in(&self.askpass_temporary_base, self.child_reaper.clone())?;
        let mut cached = self
            .askpass_launcher
            .lock()
            .map_err(|error| format!("Could not access SSH askpass owner: {error}"))?;
        if let Some(existing) = cached.upgrade() {
            return Ok(SshAskpassLauncher {
                inner: existing,
                child_reaper: self.child_reaper.clone(),
            });
        }
        *cached = Arc::downgrade(&created.inner);
        Ok(created)
    }

    fn operation_fence(
        &self,
        host_key: &str,
        operation_id: Option<&str>,
        environment_generation: Option<u64>,
        binding_generation: Option<u64>,
    ) -> Result<RemoteOperationFence, String> {
        match (
            operation_id,
            environment_generation,
            binding_generation,
        ) {
            (Some(operation_id), Some(environment_generation), Some(binding_generation)) => {
                RemoteOperationFence::new(
                    operation_id,
                    environment_generation,
                    binding_generation,
                )
            }
            (None, None, None) => self
                .operations
                .current_fence(host_key, Uuid::new_v4().to_string()),
            _ => Err(
                "SSH operation ID, environment generation, and binding generation must be supplied together."
                    .to_string(),
            ),
        }
    }

    async fn begin_operation(
        &self,
        target: &SshEnvironmentTarget,
        fence: RemoteOperationFence,
        class: RemoteOperationClass,
    ) -> Result<RemoteOperationLease, String> {
        self.operations
            .begin(&target_connection_key(target), fence, class)
            .await
    }

    pub(crate) async fn cancel_operation(
        &self,
        input: SshOperationCancelInput,
    ) -> Result<bool, String> {
        let target = normalize_ssh_environment_target(input.target)?;
        let key = target_connection_key(&target);
        let fence = RemoteOperationFence::new(
            input.operation_id,
            input.environment_generation,
            input.binding_generation,
        )?;
        self.operations.cancel(&key, &fence).await
    }

    pub(crate) async fn shutdown(&self) {
        self.operations.shutdown().await;
        self.child_reaper.close();
        let tunnels = self
            .tunnels
            .lock()
            .map(|mut tunnels| tunnels.drain().map(|(_, tunnel)| tunnel).collect())
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "could not drain SSH tunnels during shutdown");
                Vec::new()
            });
        for mut tunnel in tunnels {
            tunnel.child.terminate_and_reap().await;
        }
        self.child_reaper.wait().await;
    }

    pub async fn ensure_environment<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        target: SshEnvironmentTarget,
        options: Option<SshEnvironmentEnsureOptions>,
    ) -> Result<SshEnvironmentBootstrap, String> {
        if !self.child_reaper.accepting() {
            return Err("SSH process owner is shutting down.".to_string());
        }
        let target = normalize_ssh_environment_target(target)?;
        let key = target_connection_key(&target);
        let fence = self.operation_fence(
            &key,
            options
                .as_ref()
                .and_then(|options| options.operation_id.as_deref()),
            options
                .as_ref()
                .and_then(|options| options.environment_generation),
            options
                .as_ref()
                .and_then(|options| options.binding_generation),
        )?;
        let owner = self
            .begin_operation(&target, fence, RemoteOperationClass::Session)
            .await?;
        if let Some(existing) = self.take_existing_bootstrap_if_running(&key)? {
            validate_expected_host_key_fingerprint(
                options
                    .as_ref()
                    .and_then(|options| options.expected_host_key_fingerprint.as_deref()),
                &existing.host_key_fingerprint,
            )?;
            return Ok(existing);
        }

        let expected_host_key_fingerprint = options
            .as_ref()
            .and_then(|options| options.expected_host_key_fingerprint.as_deref())
            .map(str::to_string);
        let probe = self
            .probe_with_expected(
                app,
                prompts,
                target,
                expected_host_key_fingerprint.as_deref(),
                &owner,
            )
            .await?;
        validate_expected_host_key_fingerprint(
            options
                .as_ref()
                .and_then(|options| options.expected_host_key_fingerprint.as_deref()),
            &probe.host_key_fingerprint,
        )?;
        self.ensure_tunnel_owned(app, prompts, probe, &owner).await
    }

    pub async fn probe<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        target: SshEnvironmentTarget,
    ) -> Result<SshHostProbe, String> {
        let target = normalize_ssh_environment_target(target)?;
        let key = target_connection_key(&target);
        let fence = self.operation_fence(&key, None, None, None)?;
        let owner = self
            .begin_operation(&target, fence, RemoteOperationClass::Session)
            .await?;
        self.probe_with_expected(app, prompts, target, None, &owner)
            .await
    }

    async fn probe_with_expected<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        target: SshEnvironmentTarget,
        expected_host_key_fingerprint: Option<&str>,
        owner: &RemoteOperationLease,
    ) -> Result<SshHostProbe, String> {
        if !self.child_reaper.accepting() {
            return Err("SSH process owner is shutting down.".to_string());
        }
        let target = normalize_ssh_environment_target(target)?;
        let key = target_connection_key(&target);
        let askpass_launcher = self.askpass_launcher()?;
        let expected_host_key_fingerprint = expected_host_key_fingerprint.map(str::to_string);
        let operation_cancellation = owner.cancellation().clone();
        let host_key_fingerprint = self
            .run_with_ssh_auth(app, prompts, &key, &target, owner.cancellation(), |auth| {
                let target = target.clone();
                let askpass_launcher = askpass_launcher.clone();
                let expected_host_key_fingerprint = expected_host_key_fingerprint.clone();
                let operation_cancellation = operation_cancellation.clone();
                async move {
                    probe_ssh_host_key(
                        &target,
                        &auth,
                        askpass_launcher,
                        expected_host_key_fingerprint.as_deref(),
                        &operation_cancellation,
                    )
                    .await
                }
            })
            .await?;
        Ok(SshHostProbe {
            target,
            host_key_fingerprint,
        })
    }

    pub async fn ensure_tunnel<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        probe: SshHostProbe,
    ) -> Result<SshEnvironmentBootstrap, String> {
        let target = normalize_ssh_environment_target(probe.target.clone())?;
        let key = target_connection_key(&target);
        let fence = self.operation_fence(&key, None, None, None)?;
        let owner = self
            .begin_operation(&target, fence, RemoteOperationClass::Session)
            .await?;
        self.ensure_tunnel_owned(app, prompts, probe, &owner).await
    }

    async fn ensure_tunnel_owned<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        probe: SshHostProbe,
        owner: &RemoteOperationLease,
    ) -> Result<SshEnvironmentBootstrap, String> {
        if !self.child_reaper.accepting() {
            return Err("SSH process owner is shutting down.".to_string());
        }
        let target = normalize_ssh_environment_target(probe.target)?;
        let key = target_connection_key(&target);
        if let Some(existing) = self.take_existing_bootstrap_if_running(&key)? {
            validate_expected_host_key_fingerprint(
                Some(&probe.host_key_fingerprint),
                &existing.host_key_fingerprint,
            )?;
            return Ok(existing);
        }

        let local_port = portpicker::pick_unused_port()
            .ok_or_else(|| "Could not find an available local SSH tunnel port.".to_string())?;
        let askpass_launcher = self.askpass_launcher()?;
        let expected_host_key_fingerprint = probe.host_key_fingerprint.clone();
        let operation_cancellation = owner.cancellation().clone();
        let remote_launch = self
            .run_with_ssh_auth(app, prompts, &key, &target, owner.cancellation(), |auth| {
                let target = target.clone();
                let askpass_launcher = askpass_launcher.clone();
                let expected_host_key_fingerprint = expected_host_key_fingerprint.clone();
                let operation_cancellation = operation_cancellation.clone();
                async move {
                    launch_or_reuse_remote_server(
                        &target,
                        &auth,
                        askpass_launcher,
                        &expected_host_key_fingerprint,
                        &operation_cancellation,
                    )
                    .await
                }
            })
            .await?;
        let tunnel_permit = self.operations.acquire_tunnel(owner).await?;
        let tunnel_cancellation = owner.cancellation().clone();
        let tunnel_result = self
            .run_with_ssh_auth(app, prompts, &key, &target, owner.cancellation(), |auth| {
                let target = target.clone();
                let askpass_launcher = askpass_launcher.clone();
                let remote_launch = remote_launch.clone();
                let expected_host_key_fingerprint = expected_host_key_fingerprint.clone();
                let tunnel_cancellation = tunnel_cancellation.clone();
                async move {
                    let plan = SshEnvironmentLaunchPlan::forward_with_auth(
                        target,
                        local_port,
                        remote_launch,
                        &auth,
                    )?;
                    let child = start_ssh_tunnel(
                        &plan,
                        &auth,
                        askpass_launcher,
                        &expected_host_key_fingerprint,
                        &tunnel_cancellation,
                    )
                    .await?;
                    Ok((plan, child))
                }
            })
            .await;
        let (plan, child) = match tunnel_result {
            Ok(result) => result,
            Err(error) => {
                let cleanup_auth = self
                    .cached_auth_secret(&key)
                    .map(SshAuthOptions::with_secret)
                    .unwrap_or_else(SshAuthOptions::batch);
                let _ = stop_remote_server_bounded(
                    &target,
                    &cleanup_auth,
                    askpass_launcher,
                    &expected_host_key_fingerprint,
                )
                .await;
                return Err(error);
            }
        };

        let bootstrap = SshEnvironmentBootstrap::new(
            target,
            plan.remote_port,
            plan.http_base_url,
            plan.ws_base_url,
            expected_host_key_fingerprint,
            plan.remote_server_kind,
        );
        if let Err((error, mut child)) =
            self.publish_tunnel(key, child, bootstrap.clone(), tunnel_permit, owner)
        {
            child.terminate_and_reap().await;
            return Err(error);
        }
        Ok(bootstrap)
    }

    async fn ensure_external_tunnel<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        probe: SshHostProbe,
        remote_port: u16,
        owner: &RemoteOperationLease,
    ) -> Result<SshEnvironmentBootstrap, String> {
        if remote_port == 0 {
            return Err("The SSH service reported an invalid loopback port.".to_string());
        }
        let target = normalize_ssh_environment_target(probe.target)?;
        let key = target_connection_key(&target);
        if let Some(existing) = self.take_existing_bootstrap_if_running(&key)? {
            validate_expected_host_key_fingerprint(
                Some(&probe.host_key_fingerprint),
                &existing.host_key_fingerprint,
            )?;
            if existing.remote_port != remote_port {
                return Err(
                    "An existing SSH tunnel targets a different remote port; disconnect it before installing the service."
                        .to_string(),
                );
            }
            return Ok(existing);
        }
        let local_port = portpicker::pick_unused_port()
            .ok_or_else(|| "Could not find an available local SSH tunnel port.".to_string())?;
        let askpass_launcher = self.askpass_launcher()?;
        let expected_host_key_fingerprint = probe.host_key_fingerprint.clone();
        let remote = RemoteLaunchResult {
            remote_port,
            server_kind: "external".to_string(),
        };
        let tunnel_permit = self.operations.acquire_tunnel(owner).await?;
        let tunnel_cancellation = owner.cancellation().clone();
        let tunnel_result = self
            .run_with_ssh_auth(app, prompts, &key, &target, owner.cancellation(), |auth| {
                let target = target.clone();
                let askpass_launcher = askpass_launcher.clone();
                let remote = remote.clone();
                let expected_host_key_fingerprint = expected_host_key_fingerprint.clone();
                let tunnel_cancellation = tunnel_cancellation.clone();
                async move {
                    let plan = SshEnvironmentLaunchPlan::forward_with_auth(
                        target, local_port, remote, &auth,
                    )?;
                    let child = start_ssh_tunnel(
                        &plan,
                        &auth,
                        askpass_launcher,
                        &expected_host_key_fingerprint,
                        &tunnel_cancellation,
                    )
                    .await?;
                    Ok((plan, child))
                }
            })
            .await;
        let (plan, child) = tunnel_result?;
        let bootstrap = SshEnvironmentBootstrap::new(
            target,
            plan.remote_port,
            plan.http_base_url,
            plan.ws_base_url,
            expected_host_key_fingerprint,
            "external",
        );
        if let Err((error, mut child)) =
            self.publish_tunnel(key, child, bootstrap.clone(), tunnel_permit, owner)
        {
            child.terminate_and_reap().await;
            return Err(error);
        }
        Ok(bootstrap)
    }

    pub(crate) async fn inspect_remote_host<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        probe: SshHostProbe,
        owner: &RemoteOperationLease,
    ) -> Result<RemoteHostProbe, String> {
        self.inspect_remote_host_at_binary(app, prompts, probe, None, owner)
            .await
    }

    async fn inspect_remote_host_at_binary<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        probe: SshHostProbe,
        managed_binary_path: Option<String>,
        owner: &RemoteOperationLease,
    ) -> Result<RemoteHostProbe, String> {
        let target = normalize_ssh_environment_target(probe.target)?;
        validate_expected_host_key_fingerprint(
            Some(&probe.host_key_fingerprint),
            &probe.host_key_fingerprint,
        )?;
        let key = target_connection_key(&target);
        let askpass_launcher = self.askpass_launcher()?;
        let expected_host_key_fingerprint = probe.host_key_fingerprint;
        let operation_cancellation = owner.cancellation().clone();
        self.run_with_ssh_auth(app, prompts, &key, &target, owner.cancellation(), |auth| {
            let target = target.clone();
            let askpass_launcher = askpass_launcher.clone();
            let expected_host_key_fingerprint = expected_host_key_fingerprint.clone();
            let managed_binary_path = managed_binary_path.clone();
            let operation_cancellation = operation_cancellation.clone();
            async move {
                probe_remote_host(
                    &target,
                    &auth,
                    askpass_launcher,
                    &expected_host_key_fingerprint,
                    managed_binary_path.as_deref(),
                    &operation_cancellation,
                )
                .await
            }
        })
        .await
    }

    pub(crate) async fn prepare_server<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        input: SshServerProbeInput,
        target_version: &str,
    ) -> Result<SshServerProbe, String> {
        validate_expected_setup_identity(
            input.expected_environment_id.as_deref(),
            input.expected_storage_instance_id.as_deref(),
        )?;
        let target = normalize_ssh_environment_target(input.target.clone())?;
        let key = target_connection_key(&target);
        let operation_fence = self.operation_fence(
            &key,
            input.operation_id.as_deref(),
            input.environment_generation,
            input.binding_generation,
        )?;
        let owner = self
            .begin_operation(
                &target,
                operation_fence.clone(),
                RemoteOperationClass::Session,
            )
            .await?;
        let trust = self
            .probe_with_expected(
                app,
                prompts,
                target.clone(),
                input.expected_host_key_fingerprint.as_deref(),
                &owner,
            )
            .await?;
        let mut host = self
            .inspect_remote_host(app, prompts, trust.clone(), &owner)
            .await?;
        if let Some(managed_binary_path) = input.managed_binary_path.as_deref() {
            validate_managed_binary_path(&host, managed_binary_path)?;
            host = self
                .inspect_remote_host_at_binary(
                    app,
                    prompts,
                    trust.clone(),
                    Some(managed_binary_path.to_string()),
                    &owner,
                )
                .await?;
        }
        let request_id = Uuid::new_v4().to_string();
        let probe_generation = self.next_setup_generation()?;
        let compatible_service = host.installed_version.as_deref() == Some(target_version)
            && host.service_mode == Some(input.service_mode)
            && host.service_state == RemoteServiceState::Running
            && host.control_available
            && host.bind_port.is_some();
        let compatible_transient = host.installed_version.as_deref() == Some(target_version)
            && input.service_mode == RemoteServiceMode::Workstation
            && input.managed_binary_path.is_none()
            && matches!(host.os, RemoteHostOs::Linux | RemoteHostOs::MacOs);
        if compatible_service || compatible_transient {
            return Ok(SshServerProbe {
                request_id,
                probe_generation,
                target,
                host_key_fingerprint: trust.host_key_fingerprint,
                compatibility: SshSetupCompatibility::Compatible,
                installed_binary_path: host.binary_path.clone(),
                probe: host,
                consent: None,
                detail: None,
            });
        }
        if input.service_mode == RemoteServiceMode::Headless
            && host.install_authority != RemoteInstallAuthority::NoninteractiveAdministrator
        {
            return Err(
                "The selected SSH session lacks noninteractive administrator authority required for headless installation."
                    .to_string(),
            );
        }
        let adapter = remote_host_adapter(host.os);
        let preferred_formats =
            ssh_setup_preferred_formats(adapter.as_ref(), &host, input.service_mode);
        let Some(format) = preferred_formats.first().copied() else {
            return Err(
                "The remote host lacks a supported verified package installer or portable extractor."
                    .to_string(),
            );
        };
        let source = self
            .artifact_source
            .as_ref()
            .map_err(|error| error.clone())?;
        let manifest_architecture =
            if host.os == RemoteHostOs::MacOs && format == ArtifactFormat::Pkg {
                "universal"
            } else {
                host.architecture.as_manifest_value()
            };
        let resolved = source
            .resolve(
                &ServerArtifactRequest {
                    version: target_version.to_string(),
                    os: host.os.as_manifest_value().to_string(),
                    architecture: manifest_architecture.to_string(),
                    preferred_formats: vec![format.as_str().to_string()],
                },
                owner.cancellation(),
            )
            .await?;
        if artifact_format(&resolved.record.format)? != format {
            return Err("The signed server artifact format changed after selection.".to_string());
        }
        let required_space = resolved
            .record
            .size
            .saturating_mul(SSH_SETUP_REQUIRED_SPACE_MULTIPLIER);
        if host.free_bytes < required_space {
            return Err(
                "The remote host does not have enough free space for verified staging and rollback."
                    .to_string(),
            );
        }
        let paths = ssh_install_paths(
            &host,
            &resolved.record,
            format,
            target_version,
            &request_id,
            input.service_mode,
        )?;
        let expires_at = OffsetDateTime::now_utc()
            + time::Duration::seconds(SSH_SETUP_CONSENT_LIFETIME.as_secs() as i64);
        let consent = SshSetupConsent {
            request_id: request_id.clone(),
            probe_generation,
            transport: "ssh",
            target_label: target.alias.clone(),
            target_version: target_version.to_string(),
            artifact_source: resolved.manifest_url.to_string(),
            verification: SshSetupVerification {
                manifest_signature: "verified",
                artifact_signature: "pending",
                checksum: "pending",
            },
            artifact: resolved.record.clone(),
            install_destination: paths.install_root.clone(),
            data_root: paths.data_root.clone(),
            service_mode: input.service_mode,
            required_commands: setup_command_summaries(host.os, format, input.service_mode),
            expires_at: expires_at
                .format(&Rfc3339)
                .map_err(|error| format!("Could not format SSH setup consent expiry: {error}"))?,
        };
        if !owner.can_publish() {
            return Err("SSH setup probe was superseded before consent publication.".to_string());
        }
        self.store_prepared_setup(PreparedSshSetup {
            request_id: request_id.clone(),
            probe_generation,
            target: target.clone(),
            host_key_fingerprint: trust.host_key_fingerprint.clone(),
            probe: host.clone(),
            target_version: target_version.to_string(),
            service_mode: input.service_mode,
            expected_environment_id: input.expected_environment_id,
            expected_storage_instance_id: input.expected_storage_instance_id,
            resolved,
            format,
            paths,
            expires_at,
            operation_fence,
        })?;
        Ok(SshServerProbe {
            request_id,
            probe_generation,
            target,
            host_key_fingerprint: trust.host_key_fingerprint,
            compatibility: SshSetupCompatibility::SetupRequired,
            installed_binary_path: host.binary_path.clone(),
            probe: host.clone(),
            consent: Some(consent),
            detail: Some(match host.installed_version {
                Some(version) => format!(
                    "BiBCode Server {version} is not compatible with required version {target_version} or the requested service mode is not running."
                ),
                None => "BiBCode Server is not installed on the SSH host.".to_string(),
            }),
        })
    }

    fn next_setup_generation(&self) -> Result<u64, String> {
        let mut state = self
            .setup_state
            .lock()
            .map_err(|error| format!("Could not access SSH setup state: {error}"))?;
        state.generation = state.generation.saturating_add(1);
        Ok(state.generation)
    }

    fn store_prepared_setup(&self, prepared: PreparedSshSetup) -> Result<(), String> {
        let mut state = self
            .setup_state
            .lock()
            .map_err(|error| format!("Could not access SSH setup state: {error}"))?;
        state.prepared.retain(|_, candidate| {
            candidate.expires_at >= OffsetDateTime::now_utc() && candidate.target != prepared.target
        });
        state.prepared.insert(prepared.request_id.clone(), prepared);
        Ok(())
    }

    fn take_prepared_setup(
        &self,
        decision: &SshSetupConsentDecision,
    ) -> Result<PreparedSshSetup, String> {
        let mut state = self
            .setup_state
            .lock()
            .map_err(|error| format!("Could not access SSH setup state: {error}"))?;
        let prepared = state.prepared.remove(&decision.request_id).ok_or_else(|| {
            "The SSH setup consent is missing, expired, or already used.".to_string()
        })?;
        if prepared.probe_generation != decision.probe_generation {
            return Err("The SSH setup consent generation does not match the probe.".to_string());
        }
        Ok(prepared)
    }

    fn revoke_prepared_setups(&self, target: &SshEnvironmentTarget) -> Result<usize, String> {
        let mut state = self
            .setup_state
            .lock()
            .map_err(|error| format!("Could not access SSH setup state: {error}"))?;
        let before = state.prepared.len();
        state
            .prepared
            .retain(|_, prepared| prepared.target != *target);
        Ok(before.saturating_sub(state.prepared.len()))
    }

    pub(crate) async fn install_server<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        decision: SshSetupConsentDecision,
        staging_root: &Path,
    ) -> Result<SshSetupResult, String> {
        let prepared = self.take_prepared_setup(&decision)?;
        if OffsetDateTime::now_utc() > prepared.expires_at {
            return Err(
                "The SSH setup consent expired; probe again before installing.".to_string(),
            );
        }
        if !decision.accepted {
            return Ok(ssh_setup_result(
                &prepared,
                SshSetupOutcome {
                    status: SshSetupStatus::Cancelled,
                    stage: RemoteInstallStage::Probe,
                    mutation_status: MutationStatus::None,
                    cleanup_status: CleanupStatus::NotRequired,
                    installed_version: None,
                    descriptor: None,
                    bootstrap: None,
                    message: Some(
                        "SSH server installation was declined before mutation.".to_string(),
                    ),
                },
            ));
        }
        let install_fence = prepared
            .operation_fence
            .with_operation_id(prepared.request_id.clone())?;
        let owner = self
            .begin_operation(
                &prepared.target,
                install_fence,
                RemoteOperationClass::Provisioning,
            )
            .await?;
        // Cleanup must remain possible after the operation owner is cancelled.
        // Every cleanup command is independently bounded by its command timeout,
        // and cleanup never opens a new password prompt.
        let cleanup_cancellation = CancellationToken::new();
        let source = self
            .artifact_source
            .as_ref()
            .map_err(|error| error.clone())?;
        let artifact = match source
            .download(
                prepared.resolved.clone(),
                staging_root,
                owner.cancellation(),
                Arc::new(|_, _| {}),
            )
            .await
        {
            Ok(artifact) => artifact,
            Err(error) => {
                return Ok(ssh_setup_result(
                    &prepared,
                    SshSetupOutcome {
                        status: ssh_setup_failure_status(owner.cancellation()),
                        stage: RemoteInstallStage::Download,
                        mutation_status: MutationStatus::None,
                        cleanup_status: CleanupStatus::NotRequired,
                        installed_version: None,
                        descriptor: None,
                        bootstrap: None,
                        message: Some(error),
                    },
                ));
            }
        };
        let verified = VerifiedArtifact {
            local_path: artifact.path.clone(),
            version: prepared.target_version.clone(),
            os: prepared.probe.os,
            architecture: prepared.probe.architecture,
            format: prepared.format,
            size: artifact.resolved.record.size,
            sha256: artifact.resolved.record.sha256.clone(),
            remote_path: prepared.paths.remote_artifact.clone(),
            install_root: prepared.paths.install_root.clone(),
            data_root: prepared.paths.data_root.clone(),
            service_mode: prepared.service_mode,
            remote_port: prepared.paths.remote_port,
        };
        let staged = StagedArtifact::from_verified(
            verified.clone(),
            prepared.paths.installed_binary.clone(),
            prepared.probe.install_authority,
        )
        .with_service_update(prepared.probe.service_mode.is_some());
        let adapter = remote_host_adapter(prepared.probe.os);
        let stage_commands = adapter.stage_commands(&verified)?;
        for command in stage_commands {
            let output = match self
                .execute_setup_command(app, prompts, &prepared, &command, &owner)
                .await
            {
                Ok(output) => output,
                Err(error) => {
                    let cleanup = self
                        .cleanup_setup(&prepared, &verified, false, &cleanup_cancellation)
                        .await;
                    return Ok(ssh_setup_failure(
                        &prepared,
                        owner.cancellation(),
                        RemoteInstallStage::Transfer,
                        MutationStatus::Partial,
                        cleanup,
                        error,
                    ));
                }
            };
            if !output.succeeded() {
                let cleanup = self
                    .cleanup_setup(&prepared, &verified, false, &cleanup_cancellation)
                    .await;
                return Ok(ssh_setup_failure(
                    &prepared,
                    owner.cancellation(),
                    RemoteInstallStage::Transfer,
                    MutationStatus::Partial,
                    cleanup,
                    format!("Remote staging command {:?} failed.", command.purpose),
                ));
            }
            if matches!(
                command.purpose,
                RemoteCommandPurpose::VerifyTransfer | RemoteCommandPurpose::VerifyTransferSize
            ) && let Err(error) =
                validate_remote_artifact_verification(prepared.probe.os, &output, &verified)
            {
                let cleanup = self
                    .cleanup_setup(&prepared, &verified, false, &cleanup_cancellation)
                    .await;
                return Ok(ssh_setup_failure(
                    &prepared,
                    owner.cancellation(),
                    RemoteInstallStage::Verify,
                    MutationStatus::Partial,
                    cleanup,
                    error,
                ));
            }
        }
        for command in adapter.install_commands(&staged)? {
            let promotion_outcome_is_unknown = matches!(prepared.format, ArtifactFormat::TarGz)
                && (command.program == "mv"
                    || command.program == "sudo"
                        && command
                            .arguments
                            .get(1)
                            .is_some_and(|program| program == "mv"))
                || matches!(prepared.format, ArtifactFormat::Zip);
            let output = match self
                .execute_setup_command(app, prompts, &prepared, &command, &owner)
                .await
            {
                Ok(output) if output.succeeded() => output,
                Ok(_) => {
                    let cleanup = self
                        .cleanup_setup(&prepared, &verified, false, &cleanup_cancellation)
                        .await;
                    return Ok(ssh_setup_failure(
                        &prepared,
                        owner.cancellation(),
                        RemoteInstallStage::Install,
                        MutationStatus::Partial,
                        cleanup,
                        "The fixed remote installer command failed.".to_string(),
                    ));
                }
                Err(error) => {
                    let cleanup = self
                        .cleanup_setup(
                            &prepared,
                            &verified,
                            promotion_outcome_is_unknown,
                            &cleanup_cancellation,
                        )
                        .await;
                    return Ok(ssh_setup_failure(
                        &prepared,
                        owner.cancellation(),
                        RemoteInstallStage::Install,
                        MutationStatus::Partial,
                        cleanup,
                        error,
                    ));
                }
            };
            if matches!(
                command.purpose,
                RemoteCommandPurpose::VerifyTransfer | RemoteCommandPurpose::VerifyTransferSize
            ) && let Err(error) =
                validate_remote_artifact_verification(prepared.probe.os, &output, &verified)
            {
                let cleanup = self
                    .cleanup_setup(&prepared, &verified, false, &cleanup_cancellation)
                    .await;
                return Ok(ssh_setup_failure(
                    &prepared,
                    owner.cancellation(),
                    RemoteInstallStage::Verify,
                    MutationStatus::Partial,
                    cleanup,
                    error,
                ));
            }
            drop(output);
        }
        for command in adapter.service_commands(&staged)? {
            match self
                .execute_setup_command(app, prompts, &prepared, &command, &owner)
                .await
            {
                Ok(output) if output.succeeded() => {}
                Ok(_) => {
                    let cleanup = self
                        .recover_setup_after_service_mutation(
                            &prepared,
                            &verified,
                            &cleanup_cancellation,
                        )
                        .await;
                    return Ok(ssh_setup_failure(
                        &prepared,
                        owner.cancellation(),
                        RemoteInstallStage::Start,
                        MutationStatus::Partial,
                        cleanup,
                        "The installed BiBCode service did not start successfully.".to_string(),
                    ));
                }
                Err(error) => {
                    let cleanup = self
                        .recover_setup_after_service_mutation(
                            &prepared,
                            &verified,
                            &cleanup_cancellation,
                        )
                        .await;
                    return Ok(ssh_setup_failure(
                        &prepared,
                        owner.cancellation(),
                        RemoteInstallStage::Start,
                        MutationStatus::Partial,
                        cleanup,
                        error,
                    ));
                }
            }
        }
        let installed_probe = match self
            .inspect_remote_host_at_binary(
                app,
                prompts,
                SshHostProbe {
                    target: prepared.target.clone(),
                    host_key_fingerprint: prepared.host_key_fingerprint.clone(),
                },
                Some(prepared.paths.installed_binary.clone()),
                &owner,
            )
            .await
        {
            Ok(probe) => probe,
            Err(error) => {
                let cleanup = self
                    .recover_setup_after_service_mutation(
                        &prepared,
                        &verified,
                        &cleanup_cancellation,
                    )
                    .await;
                return Ok(ssh_setup_failure(
                    &prepared,
                    owner.cancellation(),
                    RemoteInstallStage::Start,
                    MutationStatus::Partial,
                    cleanup,
                    error,
                ));
            }
        };
        let service_port = match validate_installed_service(&prepared, &installed_probe) {
            Ok(port) => port,
            Err(error) => {
                let cleanup = self
                    .recover_setup_after_service_mutation(
                        &prepared,
                        &verified,
                        &cleanup_cancellation,
                    )
                    .await;
                return Ok(ssh_setup_failure(
                    &prepared,
                    owner.cancellation(),
                    RemoteInstallStage::Start,
                    MutationStatus::Partial,
                    cleanup,
                    error,
                ));
            }
        };
        let bootstrap = match self
            .ensure_external_tunnel(
                app,
                prompts,
                SshHostProbe {
                    target: prepared.target.clone(),
                    host_key_fingerprint: prepared.host_key_fingerprint.clone(),
                },
                service_port,
                &owner,
            )
            .await
        {
            Ok(bootstrap) => bootstrap,
            Err(error) => {
                let cleanup = self
                    .recover_setup_after_service_mutation(
                        &prepared,
                        &verified,
                        &cleanup_cancellation,
                    )
                    .await;
                return Ok(ssh_setup_failure(
                    &prepared,
                    owner.cancellation(),
                    RemoteInstallStage::Start,
                    MutationStatus::Partial,
                    cleanup,
                    error,
                ));
            }
        };
        let descriptor = match tokio::select! {
            biased;
            () = owner.cancelled() => Err("SSH setup was cancelled during descriptor verification.".to_string()),
            result = fetch_ssh_setup_descriptor(&bootstrap.http_base_url) => result,
        } {
            Ok(descriptor) => descriptor,
            Err(error) => {
                let cleanup = self
                    .recover_setup_after_service_mutation(
                        &prepared,
                        &verified,
                        &cleanup_cancellation,
                    )
                    .await;
                return Ok(ssh_setup_failure(
                    &prepared,
                    owner.cancellation(),
                    RemoteInstallStage::VerifyIdentity,
                    MutationStatus::Partial,
                    cleanup,
                    error,
                ));
            }
        };
        let descriptor = match validate_ssh_setup_descriptor(&prepared, &descriptor) {
            Ok(descriptor) => descriptor,
            Err(error) => {
                let cleanup = self
                    .recover_setup_after_service_mutation(
                        &prepared,
                        &verified,
                        &cleanup_cancellation,
                    )
                    .await;
                return Ok(ssh_setup_failure(
                    &prepared,
                    owner.cancellation(),
                    RemoteInstallStage::VerifyIdentity,
                    MutationStatus::Partial,
                    cleanup,
                    error,
                ));
            }
        };
        if !owner.claim_completion() {
            let cleanup = self
                .recover_setup_after_service_mutation(&prepared, &verified, &cleanup_cancellation)
                .await;
            return Ok(ssh_setup_failure(
                &prepared,
                owner.cancellation(),
                RemoteInstallStage::VerifyIdentity,
                MutationStatus::Partial,
                cleanup,
                "SSH setup was cancelled or superseded before completion publication.".to_string(),
            ));
        }
        let cleanup_status = self
            .cleanup_setup(&prepared, &verified, false, &cleanup_cancellation)
            .await;
        Ok(ssh_setup_result(
            &prepared,
            SshSetupOutcome {
                status: SshSetupStatus::Completed,
                stage: RemoteInstallStage::VerifyIdentity,
                mutation_status: MutationStatus::Completed,
                cleanup_status,
                installed_version: Some(prepared.target_version.clone()),
                descriptor: Some(descriptor),
                bootstrap: Some(bootstrap),
                message: (cleanup_status == CleanupStatus::Failed).then_some(
                    "The server is verified, but the remote staging artifact could not be removed."
                        .to_string(),
                ),
            },
        ))
    }

    async fn execute_setup_command<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        prepared: &PreparedSshSetup,
        command: &RemoteCommand,
        owner: &RemoteOperationLease,
    ) -> Result<RemoteCommandOutput, String> {
        let key = target_connection_key(&prepared.target);
        let askpass_launcher = self.askpass_launcher()?;
        let operation_cancellation = owner.cancellation().clone();
        self.run_with_ssh_auth(
            app,
            prompts,
            &key,
            &prepared.target,
            owner.cancellation(),
            |auth| {
                let target = prepared.target.clone();
                let askpass_launcher = askpass_launcher.clone();
                let fingerprint = prepared.host_key_fingerprint.clone();
                let command = command.clone();
                let os = prepared.probe.os;
                let operation_cancellation = operation_cancellation.clone();
                async move {
                    run_remote_command(
                        &target,
                        os,
                        &command,
                        &auth,
                        askpass_launcher,
                        &fingerprint,
                        &operation_cancellation,
                    )
                    .await
                }
            },
        )
        .await
    }

    async fn execute_setup_cleanup_command(
        &self,
        prepared: &PreparedSshSetup,
        command: &RemoteCommand,
        cancellation: &CancellationToken,
    ) -> Result<RemoteCommandOutput, String> {
        let key = target_connection_key(&prepared.target);
        let auth = self
            .cached_auth_secret(&key)
            .map(SshAuthOptions::with_secret)
            .unwrap_or_else(SshAuthOptions::batch);
        run_remote_command(
            &prepared.target,
            prepared.probe.os,
            command,
            &auth,
            self.askpass_launcher()?,
            &prepared.host_key_fingerprint,
            cancellation,
        )
        .await
    }

    async fn cleanup_setup(
        &self,
        prepared: &PreparedSshSetup,
        verified: &VerifiedArtifact,
        remove_install_root: bool,
        cancellation: &CancellationToken,
    ) -> CleanupStatus {
        let adapter = remote_host_adapter(prepared.probe.os);
        let Ok(commands) = adapter.cleanup_commands(verified, remove_install_root) else {
            return CleanupStatus::Failed;
        };
        for command in commands {
            match self
                .execute_setup_cleanup_command(prepared, &command, cancellation)
                .await
            {
                Ok(output) if output.succeeded() => {}
                _ => return CleanupStatus::Failed,
            }
        }
        CleanupStatus::Completed
    }

    async fn recover_setup_after_service_mutation(
        &self,
        prepared: &PreparedSshSetup,
        verified: &VerifiedArtifact,
        cancellation: &CancellationToken,
    ) -> CleanupStatus {
        let tunnel_closed = self.close_setup_tunnel(&prepared.target).await;
        let restored = self
            .restore_previous_service(prepared, verified, cancellation)
            .await;
        let cleaned = self
            .cleanup_setup(prepared, verified, false, cancellation)
            .await;
        if tunnel_closed == CleanupStatus::Completed
            && restored == CleanupStatus::Completed
            && cleaned == CleanupStatus::Completed
        {
            CleanupStatus::Completed
        } else {
            CleanupStatus::Failed
        }
    }

    async fn close_setup_tunnel(&self, target: &SshEnvironmentTarget) -> CleanupStatus {
        let key = target_connection_key(target);
        let tunnel = match self.tunnels.lock() {
            Ok(mut tunnels) => tunnels.remove(&key),
            Err(_) => return CleanupStatus::Failed,
        };
        if let Some(mut tunnel) = tunnel {
            tunnel.child.terminate_and_reap().await;
        }
        CleanupStatus::Completed
    }

    async fn restore_previous_service(
        &self,
        prepared: &PreparedSshSetup,
        verified: &VerifiedArtifact,
        cancellation: &CancellationToken,
    ) -> CleanupStatus {
        let (
            Some(previous_version),
            Some(previous_mode),
            Some(previous_binary),
            Some(previous_data_root),
            Some(previous_port),
        ) = (
            prepared.probe.installed_version.clone(),
            prepared.probe.service_mode,
            prepared.probe.binary_path.clone(),
            prepared.probe.data_root.clone(),
            prepared.probe.bind_port,
        )
        else {
            return CleanupStatus::Failed;
        };
        if validate_managed_binary_path(&prepared.probe, &previous_binary).is_err() {
            return CleanupStatus::Failed;
        }
        let mut previous_artifact = verified.clone();
        previous_artifact.version = previous_version.clone();
        previous_artifact.data_root = previous_data_root.clone();
        previous_artifact.service_mode = previous_mode;
        previous_artifact.remote_port = previous_port;
        let previous = StagedArtifact::from_verified(
            previous_artifact,
            previous_binary.clone(),
            prepared.probe.install_authority,
        )
        .with_service_update(true);
        let adapter = remote_host_adapter(prepared.probe.os);
        let Ok(commands) = adapter.service_commands(&previous) else {
            return CleanupStatus::Failed;
        };
        for command in commands {
            match self
                .execute_setup_cleanup_command(prepared, &command, cancellation)
                .await
            {
                Ok(output) if output.succeeded() => {}
                _ => return CleanupStatus::Failed,
            }
        }
        let key = target_connection_key(&prepared.target);
        let auth = self
            .cached_auth_secret(&key)
            .map(SshAuthOptions::with_secret)
            .unwrap_or_else(SshAuthOptions::batch);
        let Ok(restored_probe) = probe_remote_host(
            &prepared.target,
            &auth,
            match self.askpass_launcher() {
                Ok(launcher) => launcher,
                Err(_) => return CleanupStatus::Failed,
            },
            &prepared.host_key_fingerprint,
            Some(&previous_binary),
            cancellation,
        )
        .await
        else {
            return CleanupStatus::Failed;
        };
        let mut expected = prepared.clone();
        expected.target_version = previous_version;
        expected.service_mode = previous_mode;
        expected.paths.installed_binary = previous_binary;
        expected.paths.data_root = previous_data_root;
        expected.paths.remote_port = previous_port;
        if validate_installed_service(&expected, &restored_probe).is_ok() {
            CleanupStatus::Completed
        } else {
            CleanupStatus::Failed
        }
    }

    pub fn active_bootstrap(
        &self,
        target: &SshEnvironmentTarget,
    ) -> Result<Option<SshEnvironmentBootstrap>, String> {
        let target = normalize_ssh_environment_target(target.clone())?;
        self.take_existing_bootstrap_if_running(&target_connection_key(&target))
    }

    pub async fn create_pairing<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        target: SshEnvironmentTarget,
    ) -> Result<String, String> {
        let target = normalize_ssh_environment_target(target)?;
        let key = target_connection_key(&target);
        let fence = self.operation_fence(&key, None, None, None)?;
        let owner = self
            .begin_operation(&target, fence, RemoteOperationClass::Session)
            .await?;
        let bootstrap = self
            .take_existing_bootstrap_if_running(&key)?
            .ok_or_else(|| {
                "SSH pairing requires an active, host-key-verified BiBCode tunnel.".to_string()
            })?;
        let expected_host_key_fingerprint = bootstrap.host_key_fingerprint;
        let askpass_launcher = self.askpass_launcher()?;
        let operation_cancellation = owner.cancellation().clone();
        self.run_with_ssh_auth(app, prompts, &key, &target, owner.cancellation(), |auth| {
            let target = target.clone();
            let askpass_launcher = askpass_launcher.clone();
            let expected_host_key_fingerprint = expected_host_key_fingerprint.clone();
            let operation_cancellation = operation_cancellation.clone();
            async move {
                issue_remote_pairing_token(
                    &target,
                    &auth,
                    askpass_launcher,
                    &expected_host_key_fingerprint,
                    &operation_cancellation,
                )
                .await
            }
        })
        .await
    }

    pub async fn disconnect_environment<R: Runtime>(
        &self,
        _app: &AppHandle<R>,
        _prompts: &SshPasswordPromptManager,
        target: SshEnvironmentTarget,
        options: SshEnvironmentDisconnectOptions,
    ) -> Result<(), String> {
        let target = normalize_ssh_environment_target(target)?;
        let key = target_connection_key(&target);
        let requested_host_key_fingerprint = options.expected_host_key_fingerprint;
        if !is_valid_sha256_host_key_fingerprint(&requested_host_key_fingerprint) {
            return Err("SSH disconnect requires a valid saved host-key fingerprint.".to_string());
        }
        let close_guard: RemoteHostCloseGuard = self.operations.close_host(&key).await?;
        let pin_result = match self.tunnels.lock() {
            Ok(tunnels) => {
                if let Some(active) = tunnels.get(&key) {
                    validate_expected_host_key_fingerprint(
                        Some(&requested_host_key_fingerprint),
                        &active.bootstrap.host_key_fingerprint,
                    )
                } else {
                    Ok(())
                }
            }
            Err(error) => Err(format!("Could not access SSH tunnels: {error}")),
        };
        if let Err(error) = pin_result {
            let _ = close_guard.abort();
            return Err(error);
        }
        if let Err(error) = self.revoke_prepared_setups(&target) {
            let _ = close_guard.abort();
            return Err(error);
        }
        let tunnel = match self.tunnels.lock() {
            Ok(mut tunnels) => tunnels.remove(&key),
            Err(error) => {
                let _ = close_guard.reopen();
                return Err(format!("Could not access SSH tunnels: {error}"));
            }
        };
        self.clear_auth_secret(&key);
        if let Some(mut tunnel) = tunnel {
            tunnel.child.terminate_and_reap().await;
        }
        if !close_guard.reopen() {
            return Err(
                "SSH environment admission could not reopen after local cleanup.".to_string(),
            );
        }
        Ok(())
    }

    fn cached_auth_secret(&self, key: &str) -> Option<String> {
        self.auth_secrets.lock().ok()?.get(key).cloned()
    }

    fn remember_auth_secret(&self, key: &str, secret: String) -> Result<(), String> {
        self.auth_secrets
            .lock()
            .map_err(|error| format!("Could not cache SSH authentication secret: {error}"))?
            .insert(key.to_string(), secret);
        Ok(())
    }

    fn clear_auth_secret(&self, key: &str) {
        if let Ok(mut secrets) = self.auth_secrets.lock() {
            secrets.remove(key);
        }
    }

    async fn prompt_for_password<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        target: &SshEnvironmentTarget,
        attempt: u8,
        cancellation: &CancellationToken,
    ) -> Result<String, String> {
        let destination = build_ssh_host_spec(target)?;
        let prompt = if attempt == 1 {
            format!("Enter the SSH password for {destination}.")
        } else {
            format!("SSH authentication failed. Enter the password for {destination} again.")
        };
        prompts
            .request_password_cancellable(
                app,
                SshPasswordRequest {
                    destination,
                    username: target.username.clone(),
                    prompt,
                },
                cancellation,
            )
            .await
            .map_err(|error| error.to_string())
    }

    async fn run_with_ssh_auth<R: Runtime, T, F, Fut>(
        &self,
        app: &AppHandle<R>,
        prompts: &SshPasswordPromptManager,
        key: &str,
        target: &SshEnvironmentTarget,
        cancellation: &CancellationToken,
        mut operation: F,
    ) -> Result<T, String>
    where
        F: FnMut(SshAuthOptions) -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let mut prompted_attempts = 0_u8;
        let mut auth = self
            .cached_auth_secret(key)
            .map(SshAuthOptions::with_secret)
            .unwrap_or_else(SshAuthOptions::batch);

        loop {
            let result = tokio::select! {
                biased;
                () = cancellation.cancelled() => {
                    return Err("SSH operation was cancelled.".to_string());
                }
                result = operation(auth.clone()) => result,
            };
            match result {
                Ok(result) => return Ok(result),
                Err(error) if is_ssh_auth_failure(&error) => {
                    if auth.auth_secret.is_some() {
                        self.clear_auth_secret(key);
                    }
                    if prompted_attempts >= 2 {
                        return Err(error);
                    }
                    prompted_attempts += 1;
                    tokio::select! {
                        biased;
                        () = cancellation.cancelled() => {
                            return Err("SSH operation was cancelled.".to_string());
                        }
                        result = validate_effective_ssh_security_policy(
                            target,
                            self.askpass_launcher()?,
                            true,
                            cancellation,
                        ) => result?,
                    }
                    let secret = self
                        .prompt_for_password(app, prompts, target, prompted_attempts, cancellation)
                        .await?;
                    self.remember_auth_secret(key, secret.clone())?;
                    auth = SshAuthOptions::with_secret(secret);
                }
                Err(error) => {
                    if auth.auth_secret.is_some()
                        && is_ssh_private_environment_policy_failure(&error)
                    {
                        self.clear_auth_secret(key);
                    }
                    return Err(error);
                }
            }
        }
    }

    fn take_existing_bootstrap_if_running(
        &self,
        key: &str,
    ) -> Result<Option<SshEnvironmentBootstrap>, String> {
        let mut tunnels = self
            .tunnels
            .lock()
            .map_err(|error| format!("Could not access SSH tunnels: {error}"))?;
        let Some(tunnel) = tunnels.get_mut(key) else {
            return Ok(None);
        };
        match tunnel
            .child
            .child_mut()
            .try_wait()
            .map_err(|error| format!("Could not inspect SSH tunnel process: {error}"))?
        {
            None => Ok(Some(tunnel.bootstrap.clone())),
            Some(_status) => {
                let stale = tunnels.remove(key);
                drop(tunnels);
                // Drop transfers the already-exited child together with its
                // retained stderr observer to the bounded reaper. The permit
                // remains active until both handles have been joined.
                drop(stale);
                Ok(None)
            }
        }
    }

    fn publish_tunnel(
        &self,
        key: String,
        child: ManagedSshChild,
        bootstrap: SshEnvironmentBootstrap,
        permit: RemoteTunnelPermit,
        owner: &RemoteOperationLease,
    ) -> Result<(), (String, Box<ManagedSshChild>)> {
        let mut tunnels = match self.tunnels.lock() {
            Ok(tunnels) => tunnels,
            Err(error) => {
                return Err((
                    format!("Could not record SSH tunnel: {error}"),
                    Box::new(child),
                ));
            }
        };
        if !self.child_reaper.accepting() || !owner.can_publish() {
            return Err((
                "SSH tunnel owner is shutting down, closing, or stale.".to_string(),
                Box::new(child),
            ));
        }
        tunnels.insert(
            key,
            ManagedSshTunnel {
                child,
                bootstrap,
                _permit: permit,
            },
        );
        Ok(())
    }
}

fn ssh_command() -> &'static str {
    if cfg!(windows) { "ssh.exe" } else { "ssh" }
}

fn normalize_ssh_environment_target(
    mut target: SshEnvironmentTarget,
) -> Result<SshEnvironmentTarget, String> {
    target.alias = target.alias.trim().to_string();
    target.hostname = target.hostname.trim().to_string();
    target.username = target
        .username
        .map(|username| username.trim().to_string())
        .filter(|username| !username.is_empty());
    if target.alias.is_empty() {
        target.alias = target.hostname.clone();
    }
    if target.hostname.is_empty() {
        target.hostname = target.alias.clone();
    }
    if target.alias.is_empty() || target.hostname.is_empty() {
        return Err("SSH target is missing its alias/hostname.".to_string());
    }
    Ok(target)
}

fn remote_host_adapter(os: RemoteHostOs) -> Box<dyn RemoteHostAdapter> {
    match os {
        RemoteHostOs::Linux => Box::new(LinuxRemoteHostAdapter),
        RemoteHostOs::MacOs => Box::new(MacOsRemoteHostAdapter),
        RemoteHostOs::Windows => Box::new(WindowsRemoteHostAdapter),
    }
}

fn ssh_setup_preferred_formats(
    adapter: &dyn RemoteHostAdapter,
    host: &RemoteHostProbe,
    service_mode: RemoteServiceMode,
) -> Vec<ArtifactFormat> {
    if service_mode != RemoteServiceMode::Headless {
        return adapter.preferred_formats(host);
    }
    if !host.capabilities.portable_extractor {
        return Vec::new();
    }
    vec![match host.os {
        RemoteHostOs::Linux | RemoteHostOs::MacOs => ArtifactFormat::TarGz,
        RemoteHostOs::Windows => ArtifactFormat::Zip,
    }]
}

fn artifact_format(value: &str) -> Result<ArtifactFormat, String> {
    match value {
        "zip" => Ok(ArtifactFormat::Zip),
        "tar.gz" => Ok(ArtifactFormat::TarGz),
        "msi" => Ok(ArtifactFormat::Msi),
        "pkg" => Ok(ArtifactFormat::Pkg),
        "deb" => Ok(ArtifactFormat::Deb),
        "rpm" => Ok(ArtifactFormat::Rpm),
        _ => Err("The signed server artifact format is unsupported by SSH setup.".to_string()),
    }
}

fn validate_expected_setup_identity(
    environment_id: Option<&str>,
    storage_instance_id: Option<&str>,
) -> Result<(), String> {
    match (environment_id, storage_instance_id) {
        (None, None) => Ok(()),
        (Some(environment_id), Some(storage_instance_id)) => {
            Uuid::parse_str(environment_id)
                .map_err(|_| "The expected SSH environment identity is invalid.".to_string())?;
            Uuid::parse_str(storage_instance_id)
                .map_err(|_| "The expected SSH storage identity is invalid.".to_string())?;
            Ok(())
        }
        _ => Err(
            "Expected SSH environment and storage identities must be supplied together."
                .to_string(),
        ),
    }
}

fn validate_managed_binary_path(host: &RemoteHostProbe, binary_path: &str) -> Result<(), String> {
    let valid = match host.os {
        RemoteHostOs::Linux | RemoteHostOs::MacOs => {
            crate::remote_host::model::validate_posix_path(binary_path, "managed binary")?;
            if binary_path
                .split('/')
                .any(|component| matches!(component, "." | ".."))
            {
                false
            } else {
                let native = match host.os {
                    RemoteHostOs::Linux => "/usr/bin/bibcode",
                    RemoteHostOs::MacOs => "/usr/local/bin/bibcode",
                    RemoteHostOs::Windows => unreachable!(),
                };
                let under_version_root = |base: &str| {
                    let prefix = format!("{}/versions/", base.trim_end_matches('/'));
                    binary_path.strip_prefix(&prefix).is_some_and(|relative| {
                        relative.split_once('/').is_some_and(|(version, suffix)| {
                            !version.is_empty() && suffix == "bibcode-server/bin/bibcode"
                        })
                    })
                };
                let portable = under_version_root(&host.install_base)
                    || under_version_root(&host.system_install_base);
                binary_path == native || portable
            }
        }
        RemoteHostOs::Windows => {
            crate::remote_host::model::validate_windows_path(binary_path, "managed binary")?;
            let normalized = binary_path.replace('/', "\\").to_ascii_lowercase();
            if normalized
                .split('\\')
                .any(|component| matches!(component, "." | ".."))
            {
                false
            } else {
                let base = host
                    .install_base
                    .trim_end_matches(['\\', '/'])
                    .replace('/', "\\")
                    .to_ascii_lowercase();
                let native = format!(r"{base}\programs\bibcode server\bin\bibcode.exe");
                let system_base = host
                    .system_install_base
                    .trim_end_matches(['\\', '/'])
                    .replace('/', "\\")
                    .to_ascii_lowercase();
                let under_version_root = |prefix: String| {
                    normalized.strip_prefix(&prefix).is_some_and(|relative| {
                        relative.split_once('\\').is_some_and(|(version, suffix)| {
                            !version.is_empty() && suffix == r"bibcode-server\bin\bibcode.exe"
                        })
                    })
                };
                let portable = under_version_root(format!(r"{base}\bibcode\server\versions\"))
                    || under_version_root(format!(r"{system_base}\versions\"));
                normalized == native || portable
            }
        }
    };
    if valid {
        Ok(())
    } else {
        Err(
            "The saved SSH managed binary path is outside BiBCode-owned installation roots."
                .to_string(),
        )
    }
}

fn ssh_install_paths(
    host: &RemoteHostProbe,
    record: &ServerArtifactRecord,
    format: ArtifactFormat,
    target_version: &str,
    request_id: &str,
    service_mode: RemoteServiceMode,
) -> Result<SshInstallPaths, String> {
    if Uuid::parse_str(request_id).is_err() {
        return Err("The SSH setup request identifier is invalid.".to_string());
    }
    let digest = Sha256::digest(target_version.as_bytes()).iter().fold(
        String::with_capacity(64),
        |mut encoded, byte| {
            use std::fmt::Write as _;
            let _ = write!(encoded, "{byte:02x}");
            encoded
        },
    );
    let suffix = match format {
        ArtifactFormat::Zip => "zip",
        ArtifactFormat::TarGz => "tar.gz",
        ArtifactFormat::Msi => "msi",
        ArtifactFormat::Pkg => "pkg",
        ArtifactFormat::Deb => "deb",
        ArtifactFormat::Rpm => "rpm",
    };
    let data_root = if service_mode == RemoteServiceMode::Headless {
        host.headless_data_root.clone()
    } else {
        host.data_root
            .clone()
            .ok_or_else(|| "The SSH workstation data root is unavailable.".to_string())?
    };
    let remote_port = host.bind_port.unwrap_or(DEFAULT_REMOTE_PORT);
    let (remote_artifact, install_root, installed_binary) = match host.os {
        RemoteHostOs::Linux => {
            let remote_artifact = format!(
                "{}/staging/{request_id}.{suffix}",
                host.install_base.trim_end_matches('/')
            );
            match format {
                ArtifactFormat::Deb | ArtifactFormat::Rpm => (
                    remote_artifact,
                    "/usr".to_string(),
                    "/usr/bin/bibcode".to_string(),
                ),
                ArtifactFormat::TarGz => {
                    let install_base = if service_mode == RemoteServiceMode::Headless {
                        &host.system_install_base
                    } else {
                        &host.install_base
                    };
                    let root = format!(
                        "{}/versions/version-{digest}-{request_id}",
                        install_base.trim_end_matches('/')
                    );
                    let binary = format!("{root}/bibcode-server/bin/bibcode");
                    (remote_artifact, root, binary)
                }
                _ => {
                    return Err(
                        "The selected artifact format is not valid for Linux SSH setup."
                            .to_string(),
                    );
                }
            }
        }
        RemoteHostOs::MacOs => {
            let remote_artifact = format!(
                "{}/staging/{request_id}.{suffix}",
                host.install_base.trim_end_matches('/')
            );
            match format {
                ArtifactFormat::Pkg => (
                    remote_artifact,
                    "/Applications/BiBCode Server".to_string(),
                    "/usr/local/bin/bibcode".to_string(),
                ),
                ArtifactFormat::TarGz => {
                    let install_base = if service_mode == RemoteServiceMode::Headless {
                        &host.system_install_base
                    } else {
                        &host.install_base
                    };
                    let root = format!(
                        "{}/versions/version-{digest}-{request_id}",
                        install_base.trim_end_matches('/')
                    );
                    let binary = format!("{root}/bibcode-server/bin/bibcode");
                    (remote_artifact, root, binary)
                }
                _ => {
                    return Err(
                        "The selected artifact format is not valid for macOS SSH setup."
                            .to_string(),
                    );
                }
            }
        }
        RemoteHostOs::Windows => {
            let base = host.install_base.trim_end_matches(['\\', '/']);
            let remote_artifact = format!(r"{base}\BiBCode\Server\staging\{request_id}.{suffix}");
            match format {
                ArtifactFormat::Msi => {
                    let root = format!(r"{base}\Programs\BiBCode Server");
                    let binary = format!(r"{root}\bin\bibcode.exe");
                    (remote_artifact, root, binary)
                }
                ArtifactFormat::Zip => {
                    let install_base = if service_mode == RemoteServiceMode::Headless {
                        host.system_install_base
                            .trim_end_matches(['\\', '/'])
                            .to_string()
                    } else {
                        format!(r"{base}\BiBCode\Server")
                    };
                    let root = format!(r"{install_base}\versions\version-{digest}-{request_id}");
                    let binary = format!(r"{root}\bibcode-server\bin\bibcode.exe");
                    (remote_artifact, root, binary)
                }
                _ => {
                    return Err(
                        "The selected artifact format is not valid for Windows SSH setup."
                            .to_string(),
                    );
                }
            }
        }
    };
    if record.size == 0 || record.sha256.len() != 64 {
        return Err("The selected signed server artifact metadata is invalid.".to_string());
    }
    Ok(SshInstallPaths {
        remote_artifact,
        install_root,
        installed_binary,
        data_root,
        remote_port,
    })
}

fn setup_command_summaries(
    os: RemoteHostOs,
    format: ArtifactFormat,
    service_mode: RemoteServiceMode,
) -> Vec<String> {
    vec![
        "Create one private BiBCode Server staging location on the selected host.".to_string(),
        "Transfer the exact desktop-verified release artifact over the pinned SSH session."
            .to_string(),
        "Verify the signed-manifest SHA-256 again on the remote host.".to_string(),
        format!(
            "Install the {} artifact through the fixed {} adapter.",
            format.as_str(),
            os.as_manifest_value()
        ),
        format!(
            "Install and start the loopback-only {} service definition, then verify identity.",
            service_mode.as_str()
        ),
    ]
}

fn validate_expected_host_key_fingerprint(
    expected: Option<&str>,
    observed: &str,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if !is_valid_sha256_host_key_fingerprint(expected) {
        return Err("The expected SSH host-key fingerprint is invalid.".to_string());
    }
    if expected != observed {
        return Err(
            "SSH host-key fingerprint changed. Connection is blocked until the saved route is explicitly re-enrolled."
                .to_string(),
        );
    }
    Ok(())
}

fn ssh_setup_result(prepared: &PreparedSshSetup, outcome: SshSetupOutcome) -> SshSetupResult {
    SshSetupResult {
        request_id: prepared.request_id.clone(),
        generation: prepared.probe_generation,
        target: prepared.target.clone(),
        status: outcome.status,
        stage: outcome.stage,
        mutation_status: outcome.mutation_status,
        cleanup_status: outcome.cleanup_status,
        installed_version: outcome.installed_version,
        previous_version: prepared.probe.installed_version.clone(),
        managed_binary_path: (outcome.mutation_status != MutationStatus::None)
            .then(|| prepared.paths.installed_binary.clone()),
        data_root: prepared.paths.data_root.clone(),
        host_key_fingerprint: prepared.host_key_fingerprint.clone(),
        descriptor: outcome.descriptor,
        bootstrap: outcome.bootstrap,
        recovery_command: None,
        message: outcome.message,
    }
}

fn ssh_setup_failure(
    prepared: &PreparedSshSetup,
    cancellation: &CancellationToken,
    stage: RemoteInstallStage,
    mutation_status: MutationStatus,
    cleanup_status: CleanupStatus,
    message: String,
) -> SshSetupResult {
    let recovery_command = ssh_setup_recovery_command(prepared);
    let failure = RemoteInstallFailure::new(
        stage,
        mutation_status,
        cleanup_status,
        prepared.probe.installed_version.clone(),
        message,
        recovery_command,
    );
    let mut result = ssh_setup_result(
        prepared,
        SshSetupOutcome {
            status: ssh_setup_failure_status(cancellation),
            stage: failure.stage,
            mutation_status: failure.mutation_status,
            cleanup_status: failure.cleanup_status,
            installed_version: None,
            descriptor: None,
            bootstrap: None,
            message: Some(failure.message),
        },
    );
    result.previous_version = failure.previous_version;
    result.recovery_command = Some(failure.recovery_command);
    result
}

fn ssh_setup_failure_status(cancellation: &CancellationToken) -> SshSetupStatus {
    if cancellation.is_cancelled() {
        SshSetupStatus::Cancelled
    } else {
        SshSetupStatus::Failed
    }
}

fn ssh_setup_recovery_command(prepared: &PreparedSshSetup) -> String {
    let previous = (
        prepared.probe.binary_path.as_deref(),
        prepared.probe.service_mode,
        prepared.probe.data_root.as_deref(),
        prepared.probe.bind_port,
    );
    let (binary_path, service_mode, data_root, port) = match previous {
        (Some(binary_path), Some(service_mode), Some(data_root), Some(port))
            if validate_managed_binary_path(&prepared.probe, binary_path).is_ok() =>
        {
            (binary_path, service_mode, data_root, port)
        }
        _ => (
            prepared.paths.installed_binary.as_str(),
            prepared.service_mode,
            prepared.paths.data_root.as_str(),
            prepared.paths.remote_port,
        ),
    };
    render_ssh_recovery_command(
        prepared.probe.os,
        binary_path,
        service_mode,
        data_root,
        port,
    )
    .unwrap_or_else(|_| {
        "BiBCode could not construct a safe remote service inspection command.".to_string()
    })
}

fn render_ssh_recovery_command(
    os: RemoteHostOs,
    binary_path: &str,
    service_mode: RemoteServiceMode,
    data_root: &str,
    port: u16,
) -> Result<String, String> {
    let arguments = [
        "service".to_string(),
        "status".to_string(),
        "--mode".to_string(),
        service_mode.as_str().to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--base-dir".to_string(),
        data_root.to_string(),
    ];
    match os {
        RemoteHostOs::Linux | RemoteHostOs::MacOs => {
            crate::remote_host::model::validate_posix_path(binary_path, "managed binary")?;
            crate::remote_host::model::validate_posix_path(data_root, "data root")?;
            let command = if service_mode == RemoteServiceMode::Headless {
                let mut elevated = vec!["-n".to_string(), binary_path.to_string()];
                elevated.extend(arguments);
                RemoteCommand::standard(RemoteCommandPurpose::Service, "sudo", elevated)?
            } else {
                RemoteCommand::standard(RemoteCommandPurpose::Service, binary_path, arguments)?
            };
            render_posix_remote_command(&command)
        }
        RemoteHostOs::Windows => {
            crate::remote_host::model::validate_windows_path(binary_path, "managed binary")?;
            crate::remote_host::model::validate_windows_path(data_root, "data root")?;
            let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
            Ok(format!(
                "& {} service status --mode {} --format json --host 127.0.0.1 --port {port} --base-dir {}",
                quote(binary_path),
                service_mode.as_str(),
                quote(data_root),
            ))
        }
    }
}

fn validate_remote_artifact_verification(
    os: RemoteHostOs,
    output: &RemoteCommandOutput,
    verified: &VerifiedArtifact,
) -> Result<(), String> {
    if !output.succeeded() {
        return Err("The remote artifact verification command failed.".to_string());
    }
    match (os, output.purpose) {
        (RemoteHostOs::Windows, RemoteCommandPurpose::VerifyTransfer) => {
            let document: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
                "Windows remote artifact verification returned invalid JSON.".to_string()
            })?;
            let observed_hash =
                document
                    .get("sha256")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        "Windows remote artifact verification omitted SHA-256.".to_string()
                    })?;
            let observed_size = document
                .get("size")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    "Windows remote artifact verification omitted the byte count.".to_string()
                })?;
            if !observed_hash.eq_ignore_ascii_case(&verified.sha256)
                || observed_size != verified.size
            {
                return Err(
                    "The transferred server artifact does not match its signed manifest record."
                        .to_string(),
                );
            }
            Ok(())
        }
        (RemoteHostOs::Linux | RemoteHostOs::MacOs, RemoteCommandPurpose::VerifyTransfer) => {
            let observed_hash = output
                .stdout_text()?
                .split_whitespace()
                .next()
                .ok_or_else(|| "The remote artifact verification omitted SHA-256.".to_string())?;
            if !observed_hash.eq_ignore_ascii_case(&verified.sha256) {
                return Err(
                    "The transferred server artifact SHA-256 does not match its signed manifest record."
                        .to_string(),
                );
            }
            Ok(())
        }
        (RemoteHostOs::Linux | RemoteHostOs::MacOs, RemoteCommandPurpose::VerifyTransferSize) => {
            let observed_size = output
                .stdout_text()?
                .split_whitespace()
                .next()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| {
                    "The remote artifact verification returned an invalid byte count.".to_string()
                })?;
            if observed_size != verified.size {
                return Err(
                    "The transferred server artifact byte count does not match its signed manifest record."
                        .to_string(),
                );
            }
            Ok(())
        }
        _ => Err(
            "The remote artifact verification result did not match the host adapter.".to_string(),
        ),
    }
}

fn validate_installed_service(
    prepared: &PreparedSshSetup,
    installed: &RemoteHostProbe,
) -> Result<u16, String> {
    if installed.os != prepared.probe.os || installed.architecture != prepared.probe.architecture {
        return Err("The installed BiBCode service host identity changed after setup.".to_string());
    }
    if installed.installed_version.as_deref() != Some(prepared.target_version.as_str()) {
        return Err(
            "The installed BiBCode service version does not match the consented artifact."
                .to_string(),
        );
    }
    if installed.service_mode != Some(prepared.service_mode)
        || installed.service_state != RemoteServiceState::Running
        || !installed.control_available
    {
        return Err(
            "The installed BiBCode service is not running in the consented service mode."
                .to_string(),
        );
    }
    if installed.data_root.as_deref() != Some(prepared.paths.data_root.as_str()) {
        return Err("The installed BiBCode service uses an unexpected data root.".to_string());
    }
    let observed_binary = installed.binary_path.as_deref().ok_or_else(|| {
        "The installed BiBCode service did not report its managed binary path.".to_string()
    })?;
    let expected_binary = prepared.paths.installed_binary.as_str();
    let binary_matches = match installed.os {
        RemoteHostOs::Windows => observed_binary
            .replace('/', "\\")
            .eq_ignore_ascii_case(&expected_binary.replace('/', "\\")),
        RemoteHostOs::Linux | RemoteHostOs::MacOs => observed_binary == expected_binary,
    };
    if !binary_matches {
        return Err("The installed BiBCode service uses an unexpected binary path.".to_string());
    }
    let port = installed.bind_port.ok_or_else(|| {
        "The installed BiBCode service did not report a loopback port.".to_string()
    })?;
    if port != prepared.paths.remote_port {
        return Err("The installed BiBCode service uses an unexpected loopback port.".to_string());
    }
    Ok(port)
}

async fn fetch_ssh_setup_descriptor(http_base_url: &str) -> Result<Value, String> {
    let mut url = url::Url::parse(http_base_url)
        .map_err(|error| format!("Could not parse the SSH setup tunnel URL: {error}"))?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(_)) | None => false,
    };
    if url.scheme() != "http"
        || !loopback
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(
            "SSH setup identity verification requires a credential-free loopback HTTP tunnel."
                .to_string(),
        );
    }
    url.set_path(SSH_READY_PATH);
    url.set_query(None);
    url.set_fragment(None);
    let response = build_ssh_readiness_client(reqwest::Client::builder())?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not reach the installed BiBCode service: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The installed BiBCode service identity endpoint returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > SSH_SETUP_DESCRIPTOR_LIMIT as u64)
    {
        return Err("The installed BiBCode service identity descriptor is too large.".to_string());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            format!("Could not read the installed BiBCode service identity: {error}")
        })?;
        if bytes.len().saturating_add(chunk.len()) > SSH_SETUP_DESCRIPTOR_LIMIT {
            return Err(
                "The installed BiBCode service identity descriptor is too large.".to_string(),
            );
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        format!("Could not decode the installed BiBCode service identity: {error}")
    })
}

pub(crate) fn canonicalize_ssh_environment_descriptor(descriptor: &Value) -> Result<Value, String> {
    let descriptor = descriptor
        .as_object()
        .ok_or_else(|| "The verified SSH descriptor is not an object.".to_string())?;
    let environment_id = descriptor
        .get("environmentId")
        .and_then(Value::as_str)
        .ok_or_else(|| "The verified SSH descriptor has no environment identity.".to_string())?;
    let label = descriptor
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .ok_or_else(|| "The verified SSH descriptor has no valid label.".to_string())?;
    let platform = descriptor
        .get("platform")
        .and_then(Value::as_object)
        .ok_or_else(|| "The verified SSH descriptor has no valid platform.".to_string())?;
    let platform_os = platform
        .get("os")
        .and_then(Value::as_str)
        .filter(|os| matches!(*os, "darwin" | "linux" | "windows" | "unknown"))
        .ok_or_else(|| "The verified SSH descriptor has an invalid platform OS.".to_string())?;
    let platform_arch = platform
        .get("arch")
        .and_then(Value::as_str)
        .filter(|arch| matches!(*arch, "arm64" | "x64" | "other"))
        .ok_or_else(|| {
            "The verified SSH descriptor has an invalid platform architecture.".to_string()
        })?;
    let storage_id = descriptor
        .get("storageInstanceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "The verified SSH descriptor has no storage identity.".to_string())?;
    let environment_id = Uuid::parse_str(environment_id)
        .map_err(|_| "The verified SSH environment identity is invalid.".to_string())?;
    let storage_id = Uuid::parse_str(storage_id)
        .map_err(|_| "The verified SSH storage identity is invalid.".to_string())?;
    let server_version = descriptor
        .get("serverVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .ok_or_else(|| "The verified SSH server version is invalid.".to_string())?;
    let protocol = descriptor
        .get("protocol")
        .and_then(Value::as_object)
        .ok_or_else(|| "The verified SSH descriptor has no valid protocol range.".to_string())?;
    let minimum = protocol
        .get("minimum")
        .and_then(Value::as_u64)
        .ok_or_else(|| "The verified SSH protocol minimum is invalid.".to_string())?;
    let maximum = protocol
        .get("maximum")
        .and_then(Value::as_u64)
        .ok_or_else(|| "The verified SSH protocol maximum is invalid.".to_string())?;
    if minimum == 0 || maximum == 0 || minimum > maximum {
        return Err("The verified SSH protocol range is invalid.".to_string());
    }
    let supported = u64::from(bibcode_server::ENVIRONMENT_PROTOCOL_VERSION);
    if minimum > supported || maximum < supported {
        return Err(
            "The verified SSH server protocol is incompatible with this desktop.".to_string(),
        );
    }
    let capabilities = descriptor
        .get("capabilities")
        .and_then(Value::as_object)
        .ok_or_else(|| "The verified SSH descriptor has no valid capabilities.".to_string())?;
    let capability = |name: &str| -> Result<bool, String> {
        capabilities
            .get(name)
            .map(|value| {
                value.as_bool().ok_or_else(|| {
                    format!("The verified SSH descriptor has an invalid {name} capability.")
                })
            })
            .transpose()
            .map(Option::unwrap_or_default)
    };
    let repository_identity = capability("repositoryIdentity")?;
    let worktree_catalog = capability("worktreeCatalog")?;
    let worktree_catalog_refresh_reason = capability("worktreeCatalogRefreshReason")?;
    let vcs_status_summary = capability("vcsStatusSummary")?;
    let activity_protocol_version = match capabilities.get("activityProtocolVersion") {
        None | Some(Value::Null) => Value::Null,
        Some(value) if value.as_u64() == Some(2) => json!(2),
        Some(_) => {
            return Err(
                "The verified SSH descriptor has an invalid activity protocol capability."
                    .to_string(),
            );
        }
    };
    let transport = descriptor
        .get("transport")
        .and_then(Value::as_object)
        .and_then(|transport| transport.get("mode"))
        .and_then(Value::as_str)
        .ok_or_else(|| "The verified SSH descriptor has no transport identity.".to_string())?;
    if transport != "loopback-http" {
        return Err(
            "The verified SSH descriptor does not identify a loopback HTTP transport.".to_string(),
        );
    }
    Ok(json!({
        "environmentId": environment_id.to_string(),
        "label": label,
        "platform": {
            "os": platform_os,
            "arch": platform_arch,
        },
        "serverVersion": server_version,
        "storageInstanceId": storage_id.to_string(),
        "protocol": {
            "minimum": minimum,
            "maximum": maximum,
        },
        "capabilities": {
            "repositoryIdentity": repository_identity,
            "worktreeCatalog": worktree_catalog,
            "worktreeCatalogRefreshReason": worktree_catalog_refresh_reason,
            "vcsStatusSummary": vcs_status_summary,
            "activityProtocolVersion": activity_protocol_version,
        },
        "transport": {
            "mode": "loopback-http",
        },
    }))
}

fn validate_ssh_setup_descriptor(
    prepared: &PreparedSshSetup,
    descriptor: &Value,
) -> Result<Value, String> {
    let descriptor = canonicalize_ssh_environment_descriptor(descriptor)?;
    let environment_id = descriptor
        .get("environmentId")
        .and_then(Value::as_str)
        .ok_or_else(|| "The SSH environment descriptor has no environment identity.".to_string())?;
    let storage_instance_id = descriptor
        .get("storageInstanceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "The SSH environment descriptor has no storage identity.".to_string())?;
    Uuid::parse_str(environment_id)
        .map_err(|_| "The SSH environment descriptor identity is invalid.".to_string())?;
    Uuid::parse_str(storage_instance_id)
        .map_err(|_| "The SSH storage descriptor identity is invalid.".to_string())?;
    if prepared
        .expected_environment_id
        .as_deref()
        .is_some_and(|expected| expected != environment_id)
        || prepared
            .expected_storage_instance_id
            .as_deref()
            .is_some_and(|expected| expected != storage_instance_id)
    {
        return Err(
            "The installed BiBCode service identity changed during remote setup.".to_string(),
        );
    }
    if descriptor.get("serverVersion").and_then(Value::as_str)
        != Some(prepared.target_version.as_str())
    {
        return Err(
            "The SSH environment descriptor version does not match the consented artifact."
                .to_string(),
        );
    }
    let expected_os = match prepared.probe.os {
        RemoteHostOs::Linux => "linux",
        RemoteHostOs::MacOs => "darwin",
        RemoteHostOs::Windows => "windows",
    };
    let expected_arch = match prepared.probe.architecture {
        RemoteHostArchitecture::X86_64 => "x64",
        RemoteHostArchitecture::Aarch64 => "arm64",
    };
    if descriptor.pointer("/platform/os").and_then(Value::as_str) != Some(expected_os)
        || descriptor.pointer("/platform/arch").and_then(Value::as_str) != Some(expected_arch)
    {
        return Err(
            "The SSH environment descriptor platform does not match the probed host.".to_string(),
        );
    }
    let minimum = descriptor
        .pointer("/protocol/minimum")
        .and_then(Value::as_u64)
        .ok_or_else(|| "The SSH environment descriptor protocol minimum is invalid.".to_string())?;
    let maximum = descriptor
        .pointer("/protocol/maximum")
        .and_then(Value::as_u64)
        .ok_or_else(|| "The SSH environment descriptor protocol maximum is invalid.".to_string())?;
    let supported = u64::from(bibcode_server::ENVIRONMENT_PROTOCOL_VERSION);
    if minimum > supported || maximum < supported {
        return Err("The installed BiBCode service protocol is incompatible.".to_string());
    }
    if descriptor
        .pointer("/transport/mode")
        .and_then(Value::as_str)
        != Some("loopback-http")
    {
        return Err("The installed BiBCode service is not loopback-only.".to_string());
    }
    if descriptor
        .get("label")
        .and_then(Value::as_str)
        .is_none_or(|label| label.trim().is_empty())
        || descriptor
            .pointer("/capabilities/repositoryIdentity")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err("The SSH environment descriptor is missing required fields.".to_string());
    }
    Ok(descriptor)
}

#[cfg(test)]
fn validate_ssh_command_host_fingerprint(
    expected: &str,
    verbose_stderr: &str,
) -> Result<(), String> {
    let observed = parse_ssh_host_key_fingerprint(verbose_stderr)?;
    validate_expected_host_key_fingerprint(Some(expected), &observed)
}

fn target_connection_key(target: &SshEnvironmentTarget) -> String {
    let destination = effective_ssh_destination(target).to_ascii_lowercase();
    let port = target
        .port
        .map(|port| format!("explicit:{port}"))
        .unwrap_or_else(|| "ssh-config".to_string());
    format!(
        "{}\u{0}{}\u{0}{}",
        destination,
        target.username.as_deref().unwrap_or_default(),
        port
    )
}

fn remote_state_key(target: &SshEnvironmentTarget) -> String {
    // This names durable remote launch state created by older clients. Keep
    // its historical shape separate from the in-memory effective-route key so
    // upgrades can still find and stop an already managed server.
    let historical_identity = format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        target.alias,
        target.hostname,
        target.username.as_deref().unwrap_or_default(),
        target.port.map(|port| port.to_string()).unwrap_or_default()
    );
    let digest = Sha256::digest(historical_identity.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn effective_ssh_destination(target: &SshEnvironmentTarget) -> &str {
    if target.alias.trim().is_empty() {
        target.hostname.trim()
    } else {
        target.alias.trim()
    }
}

fn build_ssh_host_spec(target: &SshEnvironmentTarget) -> Result<String, String> {
    let destination = effective_ssh_destination(target);
    if destination.is_empty() {
        return Err("SSH target is missing its alias/hostname.".to_string());
    }
    Ok(match target.username.as_deref() {
        Some(username) => format!("{username}@{destination}"),
        None => destination.to_string(),
    })
}

fn base_ssh_args_with_auth(target: &SshEnvironmentTarget, auth: &SshAuthOptions) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        format!("BatchMode={}", auth.batch_mode),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        "ControlPath=none".to_string(),
    ];
    if let Some(port) = target.port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    args
}

fn build_ssh_config_resolution_args(target: &SshEnvironmentTarget) -> Result<Vec<String>, String> {
    let mut args = vec!["-G".to_string()];
    args.extend(base_ssh_args_with_auth(target, &SshAuthOptions::batch()));
    args.extend(["--".to_string(), build_ssh_host_spec(target)?]);
    Ok(args)
}

fn validate_effective_known_hosts_command(output: &str) -> Result<(), String> {
    let configured = output.lines().find_map(|line| {
        let line = line.trim();
        let split_at = line.find(char::is_whitespace)?;
        let (key, value) = line.split_at(split_at);
        key.eq_ignore_ascii_case("knownhostscommand")
            .then(|| value.trim())
    });
    match configured {
        Some(value) if value.eq_ignore_ascii_case("none") => Ok(()),
        Some(_) => Err(
            "This SSH target uses a custom KnownHostsCommand, which is not supported with BiBCode host-key pinning. Use a normal user/system known_hosts entry or remove the custom command for this target before retrying."
                .to_string(),
        ),
        None => Ok(()),
    }
}

fn validate_effective_send_env(output: &str) -> Result<(), String> {
    let exposes_private_environment = output.lines().any(|line| {
        let mut fields = line.split_whitespace();
        if !fields
            .next()
            .is_some_and(|key| key.eq_ignore_ascii_case("sendenv"))
        {
            return false;
        }
        fields.any(|pattern| {
            if pattern.starts_with('-') {
                return false;
            }
            let pattern = pattern.to_ascii_uppercase();
            !pattern.is_empty()
                && SSH_INTERNAL_ENVIRONMENT_VARIABLES
                    .iter()
                    .any(|name| wildcard_matches(&pattern, &name.to_ascii_uppercase()))
        })
    });
    if exposes_private_environment {
        return Err(
            "This SSH target's effective SendEnv policy can forward BiBCode's private SSH authentication or host-key control variables. Remove broad or matching SendEnv patterns for this target before retrying."
                .to_string(),
        );
    }
    Ok(())
}

fn validate_effective_proxy_password_policy(
    output: &str,
    password_authentication_requested: bool,
) -> Result<(), String> {
    if !password_authentication_requested {
        return Ok(());
    }
    let proxy_is_configured = output.lines().any(|line| {
        let line = line.trim();
        let split_at = line.find(char::is_whitespace);
        let Some(split_at) = split_at else {
            return false;
        };
        let (key, value) = line.split_at(split_at);
        matches!(
            key.to_ascii_lowercase().as_str(),
            "proxyjump" | "proxycommand"
        ) && !value.trim().is_empty()
            && !value.trim().eq_ignore_ascii_case("none")
    });
    if proxy_is_configured {
        return Err(
            "SSH password authentication through ProxyJump or ProxyCommand is not supported because it could expose the destination password to the proxy process. Configure key or agent authentication for the complete proxy chain before retrying."
                .to_string(),
        );
    }
    Ok(())
}

fn openssh_command_environment_path(argument: &Path) -> Result<String, String> {
    let argument = argument
        .to_str()
        .ok_or_else(|| "SSH helper path is not valid Unicode.".to_string())?;
    if argument.contains(['\0', '\r', '\n']) {
        return Err("SSH helper path contains an unsupported control character.".to_string());
    }
    // OpenSSH argv-splits the fixed command template before expanding this
    // environment value into its already-isolated argv element. Expansion is
    // non-recursive, so spaces, '%', '${}', shell metacharacters, and quotes in
    // the path remain literal without another quoting layer.
    Ok(argument.to_string())
}

fn insert_ssh_host_key_pin_args(args: &mut Vec<String>) {
    let verifier_command = if cfg!(windows) {
        format!(
            "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${{{SSH_HOST_KEY_PIN_HELPER_ENV}}} %I %f"
        )
    } else {
        format!("/bin/sh ${{{SSH_HOST_KEY_PIN_HELPER_ENV}}} %I %f")
    };
    let destination_guard = args
        .iter()
        .position(|argument| argument == "--")
        .unwrap_or(args.len());
    args.splice(
        destination_guard..destination_guard,
        [
            "-o".to_string(),
            "FingerprintHash=sha256".to_string(),
            "-o".to_string(),
            format!("KnownHostsCommand={verifier_command}"),
        ],
    );
}

fn build_ssh_child_environment(
    auth: &SshAuthOptions,
    askpass_launcher: &Path,
) -> HashMap<String, String> {
    if !auth.interactive_auth {
        return HashMap::new();
    }
    let mut environment = HashMap::new();
    environment.insert(
        "SSH_ASKPASS".to_string(),
        askpass_launcher.to_string_lossy().into_owned(),
    );
    environment.insert("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string());
    if let Some(secret) = &auth.auth_secret {
        environment.insert("BIBCODE_SSH_AUTH_SECRET".to_string(), secret.clone());
    }
    if !cfg!(windows) && env::var_os("DISPLAY").is_none() {
        environment.insert("DISPLAY".to_string(), "bibcode".to_string());
    }
    environment
}

fn build_verified_ssh_child_environment(
    auth: &SshAuthOptions,
    askpass_launcher: &Path,
    host_key_pin_verifier: &Path,
    expected_host_key_fingerprint: Option<&str>,
    observation_path: Option<&Path>,
) -> Result<HashMap<String, String>, String> {
    if expected_host_key_fingerprint.is_none() && observation_path.is_none() {
        return Err(
            "SSH host-key verification is missing its pin or observation owner.".to_string(),
        );
    }
    let mut environment = build_ssh_child_environment(auth, askpass_launcher);
    environment.insert(
        SSH_HOST_KEY_PIN_HELPER_ENV.to_string(),
        openssh_command_environment_path(host_key_pin_verifier)?,
    );
    if let Some(expected) = expected_host_key_fingerprint {
        if !is_valid_sha256_host_key_fingerprint(expected) {
            return Err("The expected SSH host-key fingerprint is invalid.".to_string());
        }
        environment.insert(
            SSH_EXPECTED_HOST_KEY_FINGERPRINT_ENV.to_string(),
            expected.to_string(),
        );
    }
    if let Some(path) = observation_path {
        environment.insert(
            SSH_HOST_KEY_OBSERVATION_PATH_ENV.to_string(),
            path.to_string_lossy().into_owned(),
        );
    }
    Ok(environment)
}

fn apply_verified_ssh_child_environment(
    command: &mut Command,
    environment: HashMap<String, String>,
) {
    for name in SSH_INTERNAL_ENVIRONMENT_VARIABLES {
        command.env_remove(name);
    }
    command.envs(environment);
}

fn is_ssh_host_key_pin_failure(message: &str) -> bool {
    message.contains(SSH_HOST_KEY_PIN_MISMATCH_MARKER)
}

fn is_ssh_auth_failure(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("authentication failed")
        || normalized.contains("too many authentication failures")
        || (normalized.contains("permission denied (")
            && (normalized.contains("password")
                || normalized.contains("keyboard-interactive")
                || normalized.contains("publickey")
                || normalized.contains("hostbased")
                || normalized.contains("gssapi-with-mic")))
}

fn is_ssh_private_environment_policy_failure(message: &str) -> bool {
    message.starts_with("This SSH target uses a custom KnownHostsCommand")
        || message.starts_with("This SSH target's effective SendEnv policy")
        || message.starts_with("SSH password authentication through ProxyJump or ProxyCommand")
}

#[derive(Clone)]
struct SshAskpassLauncher {
    inner: Arc<SshAskpassLauncherInner>,
    child_reaper: SshChildReaper,
}

struct SshAskpassLauncherInner {
    root: PathBuf,
    directory: PathBuf,
    files: Vec<PathBuf>,
    launcher: PathBuf,
    host_key_pin_verifier: PathBuf,
    cleanup_sender: watch::Sender<bool>,
}

struct SshHostKeyObservation {
    path: PathBuf,
}

impl SshHostKeyObservation {
    fn create(launcher: &SshAskpassLauncher) -> Result<Self, String> {
        let path = launcher.inner.directory.join(format!(
            "host-key-observation-{}.txt",
            Uuid::new_v4().simple()
        ));
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("Failed to create SSH host-key observation: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(error) = fs::set_permissions(&path, fs::Permissions::from_mode(0o600)) {
                let _ = fs::remove_file(&path);
                return Err(format!(
                    "Failed to protect SSH host-key observation: {error}"
                ));
            }
        }
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn read(&self) -> Result<String, String> {
        let fingerprint = fs::read_to_string(&self.path)
            .map_err(|error| format!("Failed to read SSH host-key observation: {error}"))?;
        let fingerprint = fingerprint.trim();
        if !is_valid_sha256_host_key_fingerprint(fingerprint) {
            return Err(
                "OpenSSH did not publish a valid destination host-key fingerprint.".to_string(),
            );
        }
        Ok(fingerprint.to_string())
    }
}

impl Drop for SshHostKeyObservation {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(%error, "failed to remove an exact SSH host-key observation");
        }
    }
}

impl SshAskpassLauncher {
    fn create_in(temporary_base: &Path, child_reaper: SshChildReaper) -> Result<Self, String> {
        let root = temporary_base.join(format!(
            "bibcode-ssh-runtime-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir(&root)
            .map_err(|error| format!("Failed to create SSH askpass root: {error}"))?;
        let directory = root.join("bibcode-ssh-askpass");
        let launcher = if cfg!(windows) {
            directory.join("ssh-askpass.cmd")
        } else {
            directory.join("ssh-askpass.sh")
        };
        let host_key_pin_verifier = if cfg!(windows) {
            directory.join("ssh-host-key-pin.ps1")
        } else {
            directory.join("ssh-host-key-pin.sh")
        };
        let mut files = vec![launcher.clone()];
        if cfg!(windows) {
            files.push(directory.join("ssh-askpass.ps1"));
        }
        files.push(host_key_pin_verifier.clone());
        let (cleanup_sender, _) = watch::channel(false);
        let inner = SshAskpassLauncherInner {
            root,
            directory,
            files,
            launcher,
            host_key_pin_verifier,
            cleanup_sender,
        };

        set_ssh_askpass_directory_permissions(&inner.root)?;
        fs::create_dir(&inner.directory)
            .map_err(|error| format!("Failed to create SSH askpass directory: {error}"))?;
        set_ssh_askpass_directory_permissions(&inner.directory)?;
        if cfg!(windows) {
            write_askpass_file(&inner.launcher, ASKPASS_WINDOWS_LAUNCHER_SCRIPT, None)?;
            write_askpass_file(
                &inner.directory.join("ssh-askpass.ps1"),
                ASKPASS_WINDOWS_SCRIPT,
                None,
            )?;
            write_askpass_file(
                &inner.host_key_pin_verifier,
                HOST_KEY_PIN_WINDOWS_SCRIPT,
                None,
            )?;
        } else {
            write_askpass_file(&inner.launcher, ASKPASS_POSIX_SCRIPT, Some(0o700))?;
            write_askpass_file(
                &inner.host_key_pin_verifier,
                HOST_KEY_PIN_POSIX_SCRIPT,
                Some(0o700),
            )?;
        }
        Ok(Self {
            inner: Arc::new(inner),
            child_reaper,
        })
    }

    fn path(&self) -> &Path {
        &self.inner.launcher
    }

    fn host_key_pin_verifier_path(&self) -> &Path {
        &self.inner.host_key_pin_verifier
    }

    #[cfg(test)]
    fn root(&self) -> &Path {
        &self.inner.root
    }

    #[cfg(test)]
    fn cleanup_observer(&self) -> watch::Receiver<bool> {
        self.inner.cleanup_sender.subscribe()
    }

    fn reserve_child(&self) -> Result<SshChildReaperPermit, String> {
        self.child_reaper.reserve()
    }
}

impl Drop for SshAskpassLauncherInner {
    fn drop(&mut self) {
        for file in &self.files {
            if let Err(error) = fs::remove_file(file)
                && error.kind() != io::ErrorKind::NotFound
            {
                tracing::warn!(%error, "failed to remove an exact SSH askpass file");
            }
        }
        for directory in [&self.directory, &self.root] {
            if let Err(error) = fs::remove_dir(directory)
                && error.kind() != io::ErrorKind::NotFound
            {
                tracing::warn!(%error, "failed to remove an exact SSH askpass directory");
            }
        }
        let _ = self.cleanup_sender.send(true);
    }
}

#[derive(Clone)]
struct SshChildReaper {
    inner: Arc<SshChildReaperInner>,
}

struct SshChildReaperInner {
    accepting: AtomicBool,
    active: AtomicUsize,
    capacity: Arc<Semaphore>,
    idle: Notify,
    #[cfg(test)]
    admitted: Notify,
    shutdown_sender: watch::Sender<bool>,
}

struct SshChildReaperPermit {
    inner: Arc<SshChildReaperInner>,
    capacity: Option<OwnedSemaphorePermit>,
    runtime: tokio::runtime::Handle,
    shutdown_receiver: watch::Receiver<bool>,
}

impl SshChildReaper {
    fn new() -> Self {
        let (shutdown_sender, _) = watch::channel(false);
        Self {
            inner: Arc::new(SshChildReaperInner {
                accepting: AtomicBool::new(true),
                active: AtomicUsize::new(0),
                capacity: Arc::new(Semaphore::new(SSH_CHILD_REAPER_CAPACITY)),
                idle: Notify::new(),
                #[cfg(test)]
                admitted: Notify::new(),
                shutdown_sender,
            }),
        }
    }

    fn reserve(&self) -> Result<SshChildReaperPermit, String> {
        if !self.inner.accepting.load(Ordering::Acquire) {
            return Err("SSH process owner is shutting down.".to_string());
        }
        let capacity = self
            .inner
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| "SSH process owner capacity was exceeded.".to_string())?;
        self.inner.active.fetch_add(1, Ordering::AcqRel);
        #[cfg(test)]
        self.inner.admitted.notify_waiters();
        let permit = SshChildReaperPermit {
            inner: self.inner.clone(),
            capacity: Some(capacity),
            runtime: tokio::runtime::Handle::current(),
            shutdown_receiver: self.inner.shutdown_sender.subscribe(),
        };
        if !self.inner.accepting.load(Ordering::Acquire) {
            drop(permit);
            return Err("SSH process owner is shutting down.".to_string());
        }
        Ok(permit)
    }

    fn close(&self) {
        self.inner.accepting.store(false, Ordering::Release);
        self.inner.capacity.close();
        let _ = self.inner.shutdown_sender.send(true);
    }

    fn accepting(&self) -> bool {
        self.inner.accepting.load(Ordering::Acquire)
    }

    async fn wait(&self) {
        loop {
            let idle = self.inner.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            if self.inner.active.load(Ordering::Acquire) == 0 {
                return;
            }
            idle.await;
        }
    }

    #[cfg(test)]
    fn active(&self) -> usize {
        self.inner.active.load(Ordering::Acquire)
    }

    #[cfg(test)]
    async fn wait_until_active(&self) {
        loop {
            let admitted = self.inner.admitted.notified();
            tokio::pin!(admitted);
            admitted.as_mut().enable();
            if self.active() > 0 {
                return;
            }
            admitted.await;
        }
    }
}

impl SshChildReaperPermit {
    fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.shutdown_receiver.clone()
    }

    fn spawn_reap(
        self,
        mut child: Child,
        askpass_launcher: SshAskpassLauncher,
        stderr_drain: Option<tokio::task::JoinHandle<()>>,
    ) {
        let runtime = self.runtime.clone();
        runtime.spawn(async move {
            let _ = child.start_kill();
            let _ = child.wait().await;
            if let Some(stderr_drain) = stderr_drain {
                stderr_drain.abort();
                let _ = stderr_drain.await;
            }
            drop(askpass_launcher);
            drop(self);
        });
    }
}

impl Drop for SshChildReaperPermit {
    fn drop(&mut self) {
        self.capacity.take();
        if self.inner.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.inner.idle.notify_waiters();
        }
    }
}

struct ManagedSshChild {
    child: Option<Child>,
    askpass_launcher: Option<SshAskpassLauncher>,
    reaper_permit: Option<SshChildReaperPermit>,
    stderr_drain: Option<tokio::task::JoinHandle<()>>,
}

async fn finish_ssh_background_task(mut task: tokio::task::JoinHandle<()>) {
    if tokio::time::timeout(SSH_TUNNEL_SHUTDOWN_TIMEOUT, &mut task)
        .await
        .is_err()
    {
        task.abort();
        let _ = task.await;
    }
}

async fn read_bounded_ssh_output<R>(reader: R, limit: usize) -> io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(8 * 1024));
    reader
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "SSH command output exceeded its size limit",
        ));
    }
    Ok(bytes)
}

async fn drain_ssh_command_stderr<R>(
    mut reader: R,
    command_marker: String,
    verification_sender: oneshot::Sender<Result<(), String>>,
    output_sender: oneshot::Sender<io::Result<Vec<u8>>>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut verification_sender = Some(verification_sender);
    let mut output = Vec::with_capacity(8 * 1024);
    let result = async {
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            let read = reader.read(&mut buffer).await?;
            if read == 0 {
                return Ok(output);
            }
            if output.len().saturating_add(read) > SSH_COMMAND_OUTPUT_LIMIT {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "SSH command output exceeded its size limit",
                ));
            }
            output.extend_from_slice(&buffer[..read]);
            let diagnostics = String::from_utf8_lossy(&output);
            if verification_sender.is_some() && is_ssh_host_key_pin_failure(&diagnostics) {
                let sender = verification_sender
                    .take()
                    .expect("verification sender remains present");
                let _ = sender.send(Err(
                    "SSH host-key fingerprint changed. Connection is blocked until the saved route is explicitly re-enrolled."
                        .to_string(),
                ));
            } else if verification_sender.is_some() && diagnostics.contains(&command_marker) {
                let sender = verification_sender
                    .take()
                    .expect("verification sender remains present");
                let _ = sender.send(Ok(()));
            }
        }
    }
    .await;
    if let Some(sender) = verification_sender {
        let message = match &result {
            Ok(_) => "SSH command ended before confirming its pinned destination host key.",
            Err(_) => "Could not read bounded SSH command verification diagnostics.",
        };
        let _ = sender.send(Err(message.to_string()));
    }
    let _ = output_sender.send(result);
}

async fn drain_ssh_tunnel_stderr<R>(
    mut reader: R,
    verification_sender: oneshot::Sender<Result<(), String>>,
    auth_failure_observed: Arc<AtomicBool>,
    local_port: u16,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut verification_sender = Some(verification_sender);
    let main_tunnel_barrier = format!("Local forwarding listening on 127.0.0.1 port {local_port}.");
    let mut observed = Vec::with_capacity(8 * 1024);
    let mut observed_before_verification = 0_usize;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => {
                if is_ssh_auth_failure(&String::from_utf8_lossy(&observed)) {
                    auth_failure_observed.store(true, Ordering::Release);
                }
                if let Some(sender) = verification_sender.take() {
                    let message = if auth_failure_observed.load(Ordering::Acquire) {
                        "SSH authentication failed during tunnel handshake.".to_string()
                    } else {
                        "SSH tunnel ended before confirming its destination host-key fingerprint."
                            .to_string()
                    };
                    let _ = sender.send(Err(message));
                }
                return;
            }
            Ok(read) => {
                if verification_sender.is_some() {
                    observed_before_verification =
                        observed_before_verification.saturating_add(read);
                    if observed_before_verification > SSH_COMMAND_OUTPUT_LIMIT {
                        let sender = verification_sender
                            .take()
                            .expect("verification sender remains present");
                        let _ = sender.send(Err(
                            "SSH tunnel host-key diagnostics exceeded the size limit.".to_string(),
                        ));
                    }
                }
                observed.extend_from_slice(&buffer[..read]);
                while let Some(line_end) = observed.iter().position(|byte| *byte == b'\n') {
                    let line = observed.drain(..=line_end).collect::<Vec<_>>();
                    let line = String::from_utf8_lossy(&line);
                    if is_ssh_auth_failure(&line) {
                        auth_failure_observed.store(true, Ordering::Release);
                    }
                    if is_ssh_host_key_pin_failure(&line) && verification_sender.is_some() {
                        let sender = verification_sender
                            .take()
                            .expect("verification sender remains present");
                        let _ = sender.send(Err(
                            "SSH host-key fingerprint changed. Connection is blocked until the saved route is explicitly re-enrolled."
                                .to_string(),
                        ));
                    } else if line.contains(&main_tunnel_barrier) && verification_sender.is_some() {
                        // OpenSSH creates local forwarding listeners from ssh_session2,
                        // after destination authentication. An implicit ProxyJump child
                        // uses stdio forwarding (-W), so it cannot emit this exact marker.
                        let sender = verification_sender
                            .take()
                            .expect("verification sender remains present");
                        let _ = sender.send(Ok(()));
                    }
                }
                if observed.len() > 16 * 1024 {
                    if is_ssh_auth_failure(&String::from_utf8_lossy(&observed)) {
                        auth_failure_observed.store(true, Ordering::Release);
                    }
                    let keep_from = observed.len().saturating_sub(512);
                    observed.drain(..keep_from);
                }
            }
            Err(_) => {
                if let Some(sender) = verification_sender.take() {
                    let _ = sender.send(Err(
                        "Could not read SSH tunnel host-key diagnostics.".to_string()
                    ));
                }
                return;
            }
        }
    }
}

impl ManagedSshChild {
    fn new(
        child: Child,
        askpass_launcher: SshAskpassLauncher,
        reaper_permit: SshChildReaperPermit,
    ) -> Self {
        Self {
            child: Some(child),
            askpass_launcher: Some(askpass_launcher),
            reaper_permit: Some(reaper_permit),
            stderr_drain: None,
        }
    }

    fn child_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("managed SSH child is live")
    }

    fn release_reaped(&mut self) {
        debug_assert!(self.stderr_drain.is_none());
        self.child.take();
        self.askpass_launcher.take();
        self.reaper_permit.take();
    }

    async fn terminate_and_reap(&mut self) {
        let _ = self.child_mut().start_kill();
        let waited =
            tokio::time::timeout(SSH_TUNNEL_SHUTDOWN_TIMEOUT, self.child_mut().wait()).await;
        if matches!(waited, Ok(Ok(_))) {
            self.finish_stderr_drain().await;
            self.release_reaped();
            return;
        }
        self.transfer_to_reaper();
    }

    async fn wait_with_output(&mut self) -> io::Result<std::process::Output> {
        let stdout = self.child_mut().stdout.take();
        let stderr = self.child_mut().stderr.take();
        let stdout_task = async move {
            match stdout {
                Some(stdout) => read_bounded_ssh_output(stdout, SSH_COMMAND_OUTPUT_LIMIT).await,
                None => Ok(Vec::new()),
            }
        };
        let stderr_task = async move {
            match stderr {
                Some(stderr) => read_bounded_ssh_output(stderr, SSH_COMMAND_OUTPUT_LIMIT).await,
                None => Ok(Vec::new()),
            }
        };
        let mut shutdown = self
            .reaper_permit
            .as_ref()
            .expect("managed SSH child retains bounded cleanup ownership")
            .shutdown_receiver();
        let status_task = async {
            tokio::select! {
                status = self.child_mut().wait() => status.map(|status| (status, false)),
                _ = wait_for_ssh_shutdown(&mut shutdown) => {
                    let _ = self.child_mut().start_kill();
                    self.child_mut().wait().await.map(|status| (status, true))
                }
            }
        };
        let ((status, interrupted), stdout, stderr) =
            tokio::try_join!(status_task, stdout_task, stderr_task,)?;
        self.release_reaped();
        if interrupted {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "SSH process owner is shutting down",
            ));
        }
        Ok(std::process::Output {
            status,
            stdout,
            stderr,
        })
    }

    async fn wait_with_streamed_stderr_output(
        &mut self,
        stdout: Option<tokio::process::ChildStdout>,
        stderr_receiver: oneshot::Receiver<io::Result<Vec<u8>>>,
    ) -> io::Result<std::process::Output> {
        self.wait_with_streamed_stderr_output_limit(
            stdout,
            stderr_receiver,
            SSH_COMMAND_OUTPUT_LIMIT,
        )
        .await
    }

    async fn wait_with_streamed_stderr_output_limit(
        &mut self,
        stdout: Option<tokio::process::ChildStdout>,
        stderr_receiver: oneshot::Receiver<io::Result<Vec<u8>>>,
        stdout_limit: usize,
    ) -> io::Result<std::process::Output> {
        let stdout_task = async move {
            match stdout {
                Some(stdout) => read_bounded_ssh_output(stdout, stdout_limit).await,
                None => Ok(Vec::new()),
            }
        };
        let stderr_task = async move {
            stderr_receiver.await.map_err(|_| {
                io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "SSH stderr observer ended without output",
                )
            })?
        };
        let mut shutdown = self
            .reaper_permit
            .as_ref()
            .expect("managed SSH child retains bounded cleanup ownership")
            .shutdown_receiver();
        let joined = {
            let status_task = async {
                tokio::select! {
                    status = self.child_mut().wait() => status.map(|status| (status, false)),
                    _ = wait_for_ssh_shutdown(&mut shutdown) => {
                        let _ = self.child_mut().start_kill();
                        self.child_mut().wait().await.map(|status| (status, true))
                    }
                }
            };
            tokio::try_join!(status_task, stdout_task, stderr_task)
        };
        let ((status, interrupted), stdout, stderr) = match joined {
            Ok(output) => output,
            Err(error) => {
                self.terminate_and_reap().await;
                return Err(error);
            }
        };
        self.finish_stderr_drain().await;
        self.release_reaped();
        if interrupted {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "SSH process owner is shutting down",
            ));
        }
        Ok(std::process::Output {
            status,
            stdout,
            stderr,
        })
    }

    fn transfer_to_reaper(&mut self) {
        let stderr_drain = self.stderr_drain.take();
        let Some(mut child) = self.child.take() else {
            debug_assert!(stderr_drain.is_none());
            return;
        };
        let askpass_launcher = self
            .askpass_launcher
            .take()
            .expect("live managed SSH child retains askpass ownership");
        let reaper_permit = self
            .reaper_permit
            .take()
            .expect("live managed SSH child retains reaper ownership");
        let _ = child.start_kill();
        reaper_permit.spawn_reap(child, askpass_launcher, stderr_drain);
    }

    fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.reaper_permit
            .as_ref()
            .expect("managed SSH child retains bounded cleanup ownership")
            .shutdown_receiver()
    }

    fn retain_stderr_drain(&mut self, task: tokio::task::JoinHandle<()>) {
        assert!(
            self.stderr_drain.is_none(),
            "managed SSH child may own only one stderr drain"
        );
        self.stderr_drain = Some(task);
    }

    async fn finish_stderr_drain(&mut self) {
        let Some(stderr_drain) = self.stderr_drain.take() else {
            return;
        };
        finish_ssh_background_task(stderr_drain).await;
    }
}

impl Drop for ManagedSshChild {
    fn drop(&mut self) {
        self.transfer_to_reaper();
    }
}

async fn wait_for_ssh_shutdown(shutdown: &mut watch::Receiver<bool>) {
    loop {
        let closed = *shutdown.borrow_and_update();
        if closed {
            return;
        }
        if shutdown.changed().await.is_err() {
            return;
        }
    }
}

fn spawn_managed_ssh_child(
    mut command: Command,
    askpass_launcher: SshAskpassLauncher,
    operation: &str,
) -> Result<ManagedSshChild, String> {
    let reaper_permit = askpass_launcher.reserve_child()?;
    let child = command
        .spawn()
        .map_err(|error| format!("Failed to {operation}: {error}"))?;
    Ok(ManagedSshChild::new(child, askpass_launcher, reaper_permit))
}

async fn validate_effective_ssh_security_policy(
    target: &SshEnvironmentTarget,
    askpass_launcher: SshAskpassLauncher,
    password_authentication_requested: bool,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let mut command = Command::new(ssh_command());
    configure_background_command(&mut command);
    apply_verified_ssh_child_environment(&mut command, HashMap::new());
    command
        .args(build_ssh_config_resolution_args(target)?)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = spawn_managed_ssh_child(
        command,
        askpass_launcher,
        "resolve effective SSH configuration",
    )?;
    let wait = tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            child.terminate_and_reap().await;
            return Err("SSH configuration resolution was cancelled.".to_string());
        }
        result = tokio::time::timeout(SSH_CONFIG_RESOLUTION_TIMEOUT, child.wait_with_output()) => result,
    };
    let output = match wait {
        Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {
            return Err("SSH process owner is shutting down.".to_string());
        }
        Ok(result) => result
            .map_err(|error| format!("Failed to resolve effective SSH configuration: {error}"))?,
        Err(_) => {
            child.terminate_and_reap().await;
            return Err("Effective SSH configuration resolution timed out.".to_string());
        }
    };
    if !output.status.success() {
        return Err(format!(
            "Could not resolve effective SSH configuration with status {}: {}",
            output.status,
            bounded_ssh_error_detail(&String::from_utf8_lossy(&output.stderr))
        ));
    }
    let effective_config = String::from_utf8_lossy(&output.stdout);
    validate_effective_known_hosts_command(&effective_config)?;
    validate_effective_send_env(&effective_config)?;
    validate_effective_proxy_password_policy(&effective_config, password_authentication_requested)
}

fn set_ssh_askpass_directory_permissions(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Failed to chmod SSH askpass directory: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn write_askpass_file(path: &Path, contents: &str, mode: Option<u32>) -> Result<(), String> {
    let existing = fs::read_to_string(path).ok();
    if existing.as_deref() != Some(contents) {
        fs::write(path, contents)
            .map_err(|error| format!("Failed to write SSH askpass helper: {error}"))?;
    }
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|error| format!("Failed to chmod SSH askpass helper: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

fn build_remote_launch_script() -> String {
    REMOTE_LAUNCH_SCRIPT
        .replace("@@DEFAULT_REMOTE_PORT@@", &DEFAULT_REMOTE_PORT.to_string())
        .replace(
            "@@REMOTE_PORT_SCAN_WINDOW@@",
            &REMOTE_PORT_SCAN_WINDOW.to_string(),
        )
        .replace(
            "@@REMOTE_REUSE_READY_TIMEOUT_MS@@",
            &REMOTE_REUSE_READY_TIMEOUT_MS.to_string(),
        )
        .replace(
            "@@REMOTE_READY_TIMEOUT_MS@@",
            &REMOTE_READY_TIMEOUT_MS.to_string(),
        )
}

async fn release_remote_script_after_host_key<W>(
    mut stdin: W,
    script: &[u8],
    verification_receiver: oneshot::Receiver<Result<(), String>>,
    mut shutdown: watch::Receiver<bool>,
    operation: &str,
    cancellation: &CancellationToken,
) -> Result<(), String>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    tokio::select! {
        result = tokio::time::timeout(SSH_READY_TIMEOUT, verification_receiver) => result
            .map_err(|_| format!("SSH {operation} command timed out before confirming its pinned destination host key."))?
            .map_err(|_| format!("SSH {operation} command verification diagnostics ended unexpectedly."))??,
        _ = wait_for_ssh_shutdown(&mut shutdown) => {
            return Err("SSH process owner is shutting down.".to_string());
        }
        () = cancellation.cancelled() => {
            return Err(format!("SSH {operation} command was cancelled."));
        }
    };
    tokio::select! {
        result = stdin.write_all(script) => result
            .map_err(|error| format!("Failed to write SSH {operation} script: {error}"))?,
        _ = wait_for_ssh_shutdown(&mut shutdown) => {
            return Err("SSH process owner is shutting down.".to_string());
        }
        () = cancellation.cancelled() => {
            return Err(format!("SSH {operation} command was cancelled."));
        }
    }
    stdin
        .shutdown()
        .await
        .map_err(|error| format!("Failed to close SSH {operation} script input: {error}"))
}

struct RemoteSshScriptInvocation<'a> {
    script: &'a str,
    arguments: &'a [String],
    operation: &'a str,
}

async fn run_remote_ssh_script(
    target: &SshEnvironmentTarget,
    invocation: RemoteSshScriptInvocation<'_>,
    auth: &SshAuthOptions,
    askpass_launcher: SshAskpassLauncher,
    expected_host_key_fingerprint: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    validate_effective_ssh_security_policy(
        target,
        askpass_launcher.clone(),
        auth.interactive_auth,
        cancellation,
    )
    .await?;
    let mut args = build_remote_script_ssh_args(target, auth, invocation.arguments)?;
    insert_ssh_host_key_pin_args(&mut args);
    let environment = build_verified_ssh_child_environment(
        auth,
        askpass_launcher.path(),
        askpass_launcher.host_key_pin_verifier_path(),
        Some(expected_host_key_fingerprint),
        None,
    )?;

    let mut command = Command::new(ssh_command());
    configure_background_command(&mut command);
    apply_verified_ssh_child_environment(&mut command, environment);
    command
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = spawn_managed_ssh_child(
        command,
        askpass_launcher,
        &format!("run SSH {} command", invocation.operation),
    )?;
    let stdin = child
        .child_mut()
        .stdin
        .take()
        .ok_or_else(|| format!("SSH {} command did not expose stdin.", invocation.operation))?;
    let stdout = child.child_mut().stdout.take();
    let stderr = child.child_mut().stderr.take().ok_or_else(|| {
        format!(
            "SSH {} command did not expose host-key diagnostics.",
            invocation.operation
        )
    })?;
    let (verification_sender, verification_receiver) = oneshot::channel();
    let (stderr_sender, stderr_receiver) = oneshot::channel();
    let stderr_drain = tokio::spawn(drain_ssh_command_stderr(
        stderr,
        SSH_REMOTE_SCRIPT_COMMAND_MARKER.to_string(),
        verification_sender,
        stderr_sender,
    ));
    child.retain_stderr_drain(stderr_drain);
    let write_result = release_remote_script_after_host_key(
        stdin,
        invocation.script.as_bytes(),
        verification_receiver,
        child.shutdown_receiver(),
        invocation.operation,
        cancellation,
    )
    .await;
    if let Err(error) = write_result {
        child.terminate_and_reap().await;
        return Err(error);
    }

    let output = tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            child.terminate_and_reap().await;
            return Err(format!("SSH {} command was cancelled.", invocation.operation));
        }
        result = child.wait_with_streamed_stderr_output(stdout, stderr_receiver) => result
            .map_err(|error| format!("Failed to wait for SSH {} command: {error}", invocation.operation))?,
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ssh_remote_script_failure_message(
            invocation.operation,
            &output.status.to_string(),
            &stderr,
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn build_remote_script_ssh_args(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    script_args: &[String],
) -> Result<Vec<String>, String> {
    let host_spec = build_ssh_host_spec(target)?;
    let mut args = base_ssh_args_with_auth(target, auth);
    args.extend([
        "-o".to_string(),
        "LogLevel=DEBUG".to_string(),
        "-o".to_string(),
        "FingerprintHash=sha256".to_string(),
    ]);
    args.extend(["--".to_string(), host_spec]);
    args.extend(["sh".to_string(), "-s".to_string(), "--".to_string()]);
    args.extend(script_args.iter().cloned());
    Ok(args)
}

fn build_remote_command_ssh_args(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    remote_os: RemoteHostOs,
    command: &RemoteCommand,
) -> Result<(Vec<String>, String), String> {
    let host_spec = build_ssh_host_spec(target)?;
    let rendered = match remote_os {
        RemoteHostOs::Linux | RemoteHostOs::MacOs => render_posix_remote_command(command)?,
        RemoteHostOs::Windows => command.render_for_windows_openssh()?,
    };
    let mut args = base_ssh_args_with_auth(target, auth);
    args.extend([
        "-o".to_string(),
        "LogLevel=DEBUG".to_string(),
        "-o".to_string(),
        "FingerprintHash=sha256".to_string(),
        "--".to_string(),
        host_spec,
        rendered.clone(),
    ]);
    Ok((args, format!("Sending command: {rendered}")))
}

async fn await_remote_command_verification(
    verification_receiver: oneshot::Receiver<Result<(), String>>,
    shutdown: &mut watch::Receiver<bool>,
    operation: &str,
) -> Result<(), String> {
    tokio::select! {
        result = tokio::time::timeout(SSH_READY_TIMEOUT, verification_receiver) => result
            .map_err(|_| format!("SSH {operation} command timed out before confirming its pinned destination host key."))?
            .map_err(|_| format!("SSH {operation} command verification diagnostics ended unexpectedly."))??,
        _ = wait_for_ssh_shutdown(shutdown) => {
            return Err("SSH process owner is shutting down.".to_string());
        }
    }
    Ok(())
}

async fn write_remote_command_input_after_host_key<W>(
    mut stdin: W,
    input: &RemoteStdin,
    remote_os: RemoteHostOs,
    verification_receiver: oneshot::Receiver<Result<(), String>>,
    mut shutdown: watch::Receiver<bool>,
    operation: &str,
) -> Result<(), String>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    await_remote_command_verification(verification_receiver, &mut shutdown, operation).await?;
    match input {
        RemoteStdin::None => {}
        RemoteStdin::Json(bytes) => {
            tokio::select! {
                result = stdin.write_all(bytes) => result
                    .map_err(|error| format!("Failed to write SSH {operation} JSON input: {error}"))?,
                _ = wait_for_ssh_shutdown(&mut shutdown) => {
                    return Err("SSH process owner is shutting down.".to_string());
                }
            }
        }
        RemoteStdin::Artifact {
            local_path,
            metadata,
            expected_size,
        } => {
            let actual_size = tokio::fs::metadata(local_path)
                .await
                .map_err(|error| format!("Could not inspect the verified SSH artifact: {error}"))?
                .len();
            if actual_size != *expected_size {
                return Err(
                    "The verified SSH artifact size changed before remote transfer.".to_string(),
                );
            }
            if remote_os == RemoteHostOs::Windows {
                let metadata_size = u32::try_from(metadata.len())
                    .map_err(|_| "The Windows artifact metadata is too large.".to_string())?;
                let header = metadata_size.to_le_bytes();
                tokio::select! {
                    result = async {
                        stdin.write_all(&header).await?;
                        stdin.write_all(metadata).await
                    } => result.map_err(|error| format!("Failed to write SSH {operation} artifact metadata: {error}"))?,
                    _ = wait_for_ssh_shutdown(&mut shutdown) => {
                        return Err("SSH process owner is shutting down.".to_string());
                    }
                }
            }
            let mut artifact = tokio::fs::File::open(local_path)
                .await
                .map_err(|error| format!("Could not open the verified SSH artifact: {error}"))?;
            let copied = tokio::select! {
                result = tokio::io::copy(&mut artifact, &mut stdin) => result
                    .map_err(|error| format!("Failed to transfer the verified SSH artifact: {error}"))?,
                _ = wait_for_ssh_shutdown(&mut shutdown) => {
                    return Err("SSH process owner is shutting down.".to_string());
                }
            };
            if copied != *expected_size {
                return Err(
                    "The verified SSH artifact transfer ended at an unexpected size.".to_string(),
                );
            }
        }
    }
    tokio::select! {
        result = stdin.shutdown() => result
            .map_err(|error| format!("Failed to close SSH {operation} command input: {error}"))?,
        _ = wait_for_ssh_shutdown(&mut shutdown) => {
            return Err("SSH process owner is shutting down.".to_string());
        }
    }
    Ok(())
}

async fn within_remote_command_deadline<T, F>(
    timeout: Duration,
    operation: &str,
    future: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| format!("SSH {operation} command timed out."))?
}

async fn run_remote_command(
    target: &SshEnvironmentTarget,
    remote_os: RemoteHostOs,
    command_spec: &RemoteCommand,
    auth: &SshAuthOptions,
    askpass_launcher: SshAskpassLauncher,
    expected_host_key_fingerprint: &str,
    cancellation: &CancellationToken,
) -> Result<RemoteCommandOutput, String> {
    validate_effective_ssh_security_policy(
        target,
        askpass_launcher.clone(),
        auth.interactive_auth,
        cancellation,
    )
    .await?;
    let (mut args, command_marker) =
        build_remote_command_ssh_args(target, auth, remote_os, command_spec)?;
    insert_ssh_host_key_pin_args(&mut args);
    let environment = build_verified_ssh_child_environment(
        auth,
        askpass_launcher.path(),
        askpass_launcher.host_key_pin_verifier_path(),
        Some(expected_host_key_fingerprint),
        None,
    )?;
    let mut command = Command::new(ssh_command());
    configure_background_command(&mut command);
    apply_verified_ssh_child_environment(&mut command, environment);
    command
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let operation = format!("remote {:?}", command_spec.purpose);
    let mut child = spawn_managed_ssh_child(
        command,
        askpass_launcher,
        &format!("run SSH {operation} command"),
    )?;
    let stdin = child
        .child_mut()
        .stdin
        .take()
        .ok_or_else(|| format!("SSH {operation} command did not expose stdin."))?;
    let stdout = child.child_mut().stdout.take();
    let stderr =
        child.child_mut().stderr.take().ok_or_else(|| {
            format!("SSH {operation} command did not expose host-key diagnostics.")
        })?;
    let (verification_sender, verification_receiver) = oneshot::channel();
    let (stderr_sender, stderr_receiver) = oneshot::channel();
    let stderr_drain = tokio::spawn(drain_ssh_command_stderr(
        stderr,
        command_marker,
        verification_sender,
        stderr_sender,
    ));
    child.retain_stderr_drain(stderr_drain);
    let command_result = tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            Err(format!("SSH {operation} command was cancelled."))
        }
        result = within_remote_command_deadline(command_spec.timeout, &operation, async {
            write_remote_command_input_after_host_key(
                stdin,
                &command_spec.stdin,
                remote_os,
                verification_receiver,
                child.shutdown_receiver(),
                &operation,
            )
            .await?;
            child
                .wait_with_streamed_stderr_output_limit(
                    stdout,
                    stderr_receiver,
                    command_spec.max_output_bytes,
                )
                .await
                .map_err(|error| format!("Failed to wait for SSH {operation} command: {error}"))
        }) => result,
    };
    let output = match command_result {
        Ok(output) => output,
        Err(error) => {
            child.terminate_and_reap().await;
            return Err(error);
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    if is_ssh_host_key_pin_failure(&stderr) {
        return Err(
            "SSH host-key fingerprint changed. Connection is blocked until the saved route is explicitly re-enrolled."
                .to_string(),
        );
    }
    if is_ssh_auth_failure(&stderr) {
        return Err(format!("SSH authentication failed during {operation}."));
    }
    if output.status.code() == Some(255) {
        return Err(format!("SSH {operation} transport failed."));
    }
    RemoteCommandOutput::new(
        command_spec.purpose,
        output.status.code().unwrap_or(-1),
        output.stdout,
        output.stderr,
        false,
        command_spec.max_output_bytes,
    )
}

async fn probe_remote_host(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    askpass_launcher: SshAskpassLauncher,
    expected_host_key_fingerprint: &str,
    managed_binary_path: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<RemoteHostProbe, String> {
    let kernel_command = RemoteCommand::standard(RemoteCommandPurpose::Kernel, "uname", ["-s"])?;
    let kernel = run_remote_command(
        target,
        RemoteHostOs::Linux,
        &kernel_command,
        auth,
        askpass_launcher.clone(),
        expected_host_key_fingerprint,
        cancellation,
    )
    .await?;
    let kernel_name = kernel.stdout_text().unwrap_or_default().trim();
    let adapter: Box<dyn RemoteHostAdapter> = match kernel_name {
        "Linux" => Box::new(LinuxRemoteHostAdapter),
        "Darwin" => Box::new(MacOsRemoteHostAdapter),
        _ => Box::new(WindowsRemoteHostAdapter),
    };
    let mut commands = adapter.probe_commands();
    if let Some(managed_binary_path) = managed_binary_path {
        configure_managed_binary_probe(adapter.os(), &mut commands, managed_binary_path)?;
    }
    let mut outputs = Vec::new();
    for command in commands {
        if command.purpose == RemoteCommandPurpose::Kernel && adapter.os() != RemoteHostOs::Windows
        {
            outputs.push(kernel.clone());
            continue;
        }
        outputs.push(
            run_remote_command(
                target,
                adapter.os(),
                &command,
                auth,
                askpass_launcher.clone(),
                expected_host_key_fingerprint,
                cancellation,
            )
            .await?,
        );
    }
    adapter.parse_probe(&outputs)
}

fn configure_managed_binary_probe(
    os: RemoteHostOs,
    commands: &mut [RemoteCommand],
    managed_binary_path: &str,
) -> Result<(), String> {
    for command in commands {
        match os {
            RemoteHostOs::Windows if command.purpose == RemoteCommandPurpose::WindowsProbe => {
                command.stdin = RemoteStdin::Json(
                    serde_json::to_vec(&json!({
                        "managedBinaryPath": managed_binary_path,
                    }))
                    .map_err(|error| {
                        format!("Could not encode the managed SSH binary probe: {error}")
                    })?,
                );
            }
            RemoteHostOs::Linux | RemoteHostOs::MacOs
                if matches!(
                    command.purpose,
                    RemoteCommandPurpose::InstalledVersion
                        | RemoteCommandPurpose::WorkstationService
                        | RemoteCommandPurpose::HeadlessService
                ) =>
            {
                command.program = managed_binary_path.to_string();
            }
            _ => {}
        }
    }
    Ok(())
}

fn ssh_remote_script_failure_message(operation: &str, status: &str, stderr: &str) -> String {
    if is_ssh_host_key_pin_failure(stderr) {
        return "SSH host-key fingerprint changed. Connection is blocked until the saved route is explicitly re-enrolled."
            .to_string();
    }
    if is_ssh_auth_failure(stderr) {
        return format!("SSH authentication failed during {operation}.");
    }
    format!("SSH {operation} command failed with status {status}.")
}

fn last_non_empty_line(output: &str) -> Option<&str> {
    output.lines().map(str::trim).rfind(|line| !line.is_empty())
}

pub fn parse_remote_pairing_credential(output: &str) -> Result<String, String> {
    let line = last_non_empty_line(output)
        .ok_or_else(|| "SSH pairing did not return a credential.".to_string())?;
    let value: Value = serde_json::from_str(line)
        .map_err(|error| format!("SSH pairing returned unparseable output: {error}"))?;
    let credential = value
        .get("credential")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if credential.is_empty() {
        return Err("SSH pairing command returned an invalid credential.".to_string());
    }
    Ok(credential)
}

pub fn parse_remote_launch_result(output: &str) -> Result<RemoteLaunchResult, String> {
    let line = last_non_empty_line(output)
        .ok_or_else(|| "SSH launch did not return a remote port.".to_string())?;
    let value: RemoteLaunchResultDocument = serde_json::from_str(line)
        .map_err(|error| format!("SSH launch returned unparseable output: {error}"))?;
    let remote_port = u16::try_from(value.remote_port)
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| {
            format!(
                "SSH launch returned an invalid remote port: {}.",
                value.remote_port
            )
        })?;
    let server_kind = value.server_kind.unwrap_or_else(|| "managed".to_string());
    if !matches!(server_kind.as_str(), "external" | "managed") {
        return Err(format!(
            "SSH launch returned an invalid remote server kind: {server_kind}."
        ));
    }
    Ok(RemoteLaunchResult {
        remote_port,
        server_kind,
    })
}

fn bounded_ssh_error_detail(output: &str) -> String {
    let detail = output
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("OpenSSH did not provide an error detail.");
    detail.chars().take(512).collect()
}

async fn probe_ssh_host_key(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    askpass_launcher: SshAskpassLauncher,
    expected_host_key_fingerprint: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    validate_effective_ssh_security_policy(
        target,
        askpass_launcher.clone(),
        auth.interactive_auth,
        cancellation,
    )
    .await?;
    let observation = if expected_host_key_fingerprint.is_none() {
        Some(SshHostKeyObservation::create(&askpass_launcher)?)
    } else {
        None
    };
    let mut args = build_ssh_trust_probe_args(target, auth)?;
    insert_ssh_host_key_pin_args(&mut args);
    let environment = build_verified_ssh_child_environment(
        auth,
        askpass_launcher.path(),
        askpass_launcher.host_key_pin_verifier_path(),
        expected_host_key_fingerprint,
        observation.as_ref().map(SshHostKeyObservation::path),
    )?;
    let mut command = Command::new(ssh_command());
    configure_background_command(&mut command);
    apply_verified_ssh_child_environment(&mut command, environment);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = spawn_managed_ssh_child(command, askpass_launcher, "probe SSH host-key trust")?;
    let output = tokio::select! {
        biased;
        () = cancellation.cancelled() => {
            child.terminate_and_reap().await;
            return Err("SSH host-key trust probe was cancelled.".to_string());
        }
        result = child.wait_with_output() => result
            .map_err(|error| format!("Failed to run SSH host-key trust probe: {error}"))?,
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        if is_ssh_host_key_pin_failure(&stderr) {
            return Err(
                "SSH host-key fingerprint changed. Connection is blocked until the saved route is explicitly re-enrolled."
                    .to_string(),
            );
        }
        return Err(match classify_ssh_host_key_failure(&stderr) {
            SshHostKeyFailureKind::Changed => {
                "SSH host key changed. Connection is blocked; verify the host out of band and update known_hosts explicitly before retrying.".to_string()
            }
            SshHostKeyFailureKind::Unknown => {
                "SSH host key is unknown or not accepted. Verify the fingerprint out of band and add it through OpenSSH before retrying.".to_string()
            }
            SshHostKeyFailureKind::Other if is_ssh_auth_failure(&stderr) => format!(
                "SSH authentication failed during host-key trust probe: {}",
                bounded_ssh_error_detail(&stderr)
            ),
            SshHostKeyFailureKind::Other => format!(
                "SSH host-key trust probe failed with status {}: {}",
                output.status,
                bounded_ssh_error_detail(&stderr)
            ),
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout
        .lines()
        .map(str::trim)
        .any(|line| line == SSH_TRUST_PROBE_MARKER)
    {
        return Err("SSH host-key trust probe did not return the expected marker.".to_string());
    }
    match expected_host_key_fingerprint {
        Some(expected) => Ok(expected.to_string()),
        None => observation
            .as_ref()
            .expect("unenrolled trust probe owns an observation")
            .read(),
    }
}

fn build_ssh_trust_probe_args(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
) -> Result<Vec<String>, String> {
    let host_spec = build_ssh_host_spec(target)?;
    let mut args = base_ssh_args_with_auth(target, auth);
    args.extend([
        "-o".to_string(),
        "LogLevel=DEBUG".to_string(),
        "-o".to_string(),
        "FingerprintHash=sha256".to_string(),
        "--".to_string(),
        host_spec,
        "echo".to_string(),
        SSH_TRUST_PROBE_MARKER.to_string(),
    ]);
    Ok(args)
}

async fn launch_or_reuse_remote_server(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    askpass_launcher: SshAskpassLauncher,
    expected_host_key_fingerprint: &str,
    cancellation: &CancellationToken,
) -> Result<RemoteLaunchResult, String> {
    let state_key = remote_state_key(target);
    let script = build_remote_launch_script();
    let arguments = [state_key];
    let output = run_remote_ssh_script(
        target,
        RemoteSshScriptInvocation {
            script: &script,
            arguments: &arguments,
            operation: "launch",
        },
        auth,
        askpass_launcher,
        expected_host_key_fingerprint,
        cancellation,
    )
    .await?;
    parse_remote_launch_result(&output)
}

async fn stop_remote_server(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    askpass_launcher: SshAskpassLauncher,
    expected_host_key_fingerprint: &str,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let state_key = remote_state_key(target);
    let arguments = [state_key];
    run_remote_ssh_script(
        target,
        RemoteSshScriptInvocation {
            script: REMOTE_STOP_SCRIPT,
            arguments: &arguments,
            operation: "stop",
        },
        auth,
        askpass_launcher,
        expected_host_key_fingerprint,
        cancellation,
    )
    .await
    .map(|_| ())
}

async fn stop_remote_server_bounded(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    askpass_launcher: SshAskpassLauncher,
    expected_host_key_fingerprint: &str,
) -> Result<(), String> {
    let cancellation = CancellationToken::new();
    let stop = stop_remote_server(
        target,
        auth,
        askpass_launcher,
        expected_host_key_fingerprint,
        &cancellation,
    );
    tokio::pin!(stop);
    tokio::select! {
        biased;
        result = &mut stop => result,
        () = tokio::time::sleep(SSH_READY_TIMEOUT) => {
            cancellation.cancel();
            stop.await
        }
    }
}

fn remote_pairing_command() -> &'static str {
    "bibcode auth pairing create --base-dir \"$HOME/.bibcode\" --format json"
}

async fn issue_remote_pairing_token(
    target: &SshEnvironmentTarget,
    auth: &SshAuthOptions,
    askpass_launcher: SshAskpassLauncher,
    expected_host_key_fingerprint: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let script = format!("{}\n", remote_pairing_command());
    let output = run_remote_ssh_script(
        target,
        RemoteSshScriptInvocation {
            script: &script,
            arguments: &[],
            operation: "pairing",
        },
        auth,
        askpass_launcher,
        expected_host_key_fingerprint,
        cancellation,
    )
    .await?;
    parse_remote_pairing_credential(&output)
}

async fn start_ssh_tunnel(
    plan: &SshEnvironmentLaunchPlan,
    auth: &SshAuthOptions,
    askpass_launcher: SshAskpassLauncher,
    expected_host_key_fingerprint: &str,
    cancellation: &CancellationToken,
) -> Result<ManagedSshChild, String> {
    validate_effective_ssh_security_policy(
        &plan.target,
        askpass_launcher.clone(),
        auth.interactive_auth,
        cancellation,
    )
    .await?;
    let mut args = plan.args.clone();
    insert_ssh_host_key_pin_args(&mut args);
    let environment = build_verified_ssh_child_environment(
        auth,
        askpass_launcher.path(),
        askpass_launcher.host_key_pin_verifier_path(),
        Some(expected_host_key_fingerprint),
        None,
    )?;
    let mut command = Command::new(&plan.program);
    configure_background_command(&mut command);
    apply_verified_ssh_child_environment(&mut command, environment);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = spawn_managed_ssh_child(command, askpass_launcher, "start SSH tunnel")?;

    let stderr = child
        .child_mut()
        .stderr
        .take()
        .ok_or_else(|| "SSH tunnel did not expose host-key diagnostics.".to_string())?;
    let (verification_sender, verification_receiver) = oneshot::channel();
    let auth_failure_observed = Arc::new(AtomicBool::new(false));
    let stderr_drain = tokio::spawn(drain_ssh_tunnel_stderr(
        stderr,
        verification_sender,
        auth_failure_observed.clone(),
        plan.local_port,
    ));
    child.retain_stderr_drain(stderr_drain);
    let mut shutdown = child.shutdown_receiver();
    let verification_result = tokio::select! {
        result = tokio::time::timeout(SSH_READY_TIMEOUT, verification_receiver) => match result {
            Err(_) => Err(
                "SSH tunnel timed out before confirming its pinned destination host key."
                    .to_string(),
            ),
            Ok(Err(_)) => {
                Err("SSH tunnel verification diagnostics ended unexpectedly.".to_string())
            }
            Ok(Ok(result)) => result,
        },
        _ = wait_for_ssh_shutdown(&mut shutdown) => {
            Err("SSH process owner is shutting down.".to_string())
        }
        () = cancellation.cancelled() => {
            Err("SSH tunnel readiness was cancelled.".to_string())
        }
    };
    if let Err(error) = verification_result {
        child.terminate_and_reap().await;
        return Err(error);
    }

    let ready_result = tokio::select! {
        result = wait_for_ssh_tunnel_ready(
            &mut child,
            &plan.http_base_url,
            auth_failure_observed.as_ref(),
        ) => result,
        _ = wait_for_ssh_shutdown(&mut shutdown) => {
            Err("SSH process owner is shutting down.".to_string())
        }
        () = cancellation.cancelled() => {
            Err("SSH tunnel readiness was cancelled.".to_string())
        }
    };
    if let Err(error) = ready_result {
        child.terminate_and_reap().await;
        return Err(error);
    }

    Ok(child)
}

async fn wait_for_ssh_tunnel_ready(
    child: &mut ManagedSshChild,
    http_base_url: &str,
    auth_failure_observed: &AtomicBool,
) -> Result<(), String> {
    let mut url = url::Url::parse(http_base_url)
        .map_err(|error| format!("Could not parse SSH tunnel URL: {error}"))?;
    url.set_path(SSH_READY_PATH);
    url.set_query(None);
    url.set_fragment(None);
    let client = build_ssh_readiness_client(reqwest::Client::builder())?;
    let start = std::time::Instant::now();
    let mut last_error = String::new();
    while start.elapsed() <= SSH_READY_TIMEOUT {
        if let Some(status) = child
            .child_mut()
            .try_wait()
            .map_err(|error| format!("Could not inspect SSH tunnel process: {error}"))?
        {
            child.finish_stderr_drain().await;
            if auth_failure_observed.load(Ordering::Acquire) {
                return Err("SSH authentication failed during tunnel handshake.".to_string());
            }
            return Err(ssh_tunnel_early_exit_message(
                &status.to_string(),
                Option::<tokio::io::Empty>::None,
            )
            .await);
        }
        match client.get(url.clone()).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                last_error = format!("HTTP {}", response.status().as_u16());
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
        tokio::time::sleep(SSH_READY_INTERVAL).await;
    }
    Err(format!(
        "SSH tunnel did not become ready at {http_base_url}: {last_error}"
    ))
}

fn build_ssh_readiness_client(builder: reqwest::ClientBuilder) -> Result<reqwest::Client, String> {
    builder
        .timeout(SSH_READY_REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| format!("Could not create SSH readiness client: {error}"))
}

async fn ssh_tunnel_early_exit_message<R>(status: &str, stderr: Option<R>) -> String
where
    R: tokio::io::AsyncRead + Unpin,
{
    if let Some(stderr) = stderr {
        let _ = tokio::time::timeout(
            SSH_TUNNEL_SHUTDOWN_TIMEOUT,
            read_bounded_ssh_output(stderr, SSH_COMMAND_OUTPUT_LIMIT),
        )
        .await;
    }
    format!("SSH tunnel exited before becoming ready with status {status}.")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshPasswordRequest {
    pub destination: String,
    pub username: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPasswordPromptPayload {
    pub request_id: String,
    pub destination: String,
    pub username: Option<String>,
    pub prompt: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshPasswordPromptResolution {
    pub request_id: String,
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshPasswordPromptRequestError {
    Presentation {
        request_id: String,
        destination: String,
        operation: &'static str,
        message: String,
    },
    TimedOut {
        request_id: String,
        destination: String,
    },
    Cancelled {
        request_id: String,
        destination: String,
    },
    ServiceStopped {
        request_id: String,
        destination: String,
    },
}

impl std::fmt::Display for SshPasswordPromptRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Presentation {
                destination,
                operation,
                message,
                ..
            } => write!(
                formatter,
                "Failed to present SSH password prompt for {destination} during {operation}: {message}"
            ),
            Self::TimedOut { destination, .. } => {
                write!(formatter, "SSH authentication timed out for {destination}.")
            }
            Self::Cancelled { destination, .. } => {
                write!(formatter, "SSH authentication cancelled for {destination}.")
            }
            Self::ServiceStopped { .. } => {
                formatter.write_str("SSH password prompt service stopped.")
            }
        }
    }
}

impl std::error::Error for SshPasswordPromptRequestError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshPasswordPromptResolveError {
    InvalidRequestId,
    Expired { request_id: String },
}

impl std::fmt::Display for SshPasswordPromptResolveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequestId => formatter.write_str("Invalid SSH password prompt id."),
            Self::Expired { .. } => {
                formatter.write_str("SSH password prompt expired. Try connecting again.")
            }
        }
    }
}

impl std::error::Error for SshPasswordPromptResolveError {}

type PendingPromptResult = Result<String, SshPasswordPromptRequestError>;

struct PendingSshPasswordPrompt {
    destination: String,
    sender: oneshot::Sender<PendingPromptResult>,
}

#[derive(Clone)]
pub struct SshPasswordPromptManager {
    pending: Arc<Mutex<HashMap<String, PendingSshPasswordPrompt>>>,
    timeout: Duration,
}

impl Default for SshPasswordPromptManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SshPasswordPromptManager {
    pub fn new() -> Self {
        Self::with_timeout(DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT)
    }

    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            timeout,
        }
    }

    pub async fn request_password<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: SshPasswordRequest,
    ) -> PendingPromptResult {
        let cancellation = CancellationToken::new();
        self.request_password_cancellable(app, request, &cancellation)
            .await
    }

    pub async fn request_password_cancellable<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: SshPasswordRequest,
        cancellation: &CancellationToken,
    ) -> PendingPromptResult {
        let request_id = Uuid::new_v4().simple().to_string();
        self.request_password_with_cancellation(
            request_id,
            request,
            SystemTime::now(),
            cancellation,
            |payload| {
                app.emit(SSH_PASSWORD_PROMPT_EVENT, payload)
                    .map_err(|error| error.to_string())
            },
        )
        .await
    }

    #[cfg(test)]
    pub(crate) async fn request_password_with(
        &self,
        request_id: String,
        request: SshPasswordRequest,
        requested_at: SystemTime,
        emit: impl FnOnce(SshPasswordPromptPayload) -> Result<(), String>,
    ) -> PendingPromptResult {
        let cancellation = CancellationToken::new();
        self.request_password_with_cancellation(
            request_id,
            request,
            requested_at,
            &cancellation,
            emit,
        )
        .await
    }

    pub(crate) async fn request_password_with_cancellation(
        &self,
        request_id: String,
        request: SshPasswordRequest,
        requested_at: SystemTime,
        cancellation: &CancellationToken,
        emit: impl FnOnce(SshPasswordPromptPayload) -> Result<(), String>,
    ) -> PendingPromptResult {
        let expires_at = format_system_time(
            requested_at
                .checked_add(self.timeout)
                .unwrap_or(requested_at),
        );
        let payload = SshPasswordPromptPayload {
            request_id: request_id.clone(),
            destination: request.destination.clone(),
            username: request.username.clone(),
            prompt: request.prompt,
            expires_at,
        };
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|error| {
                SshPasswordPromptRequestError::Presentation {
                    request_id: request_id.clone(),
                    destination: request.destination.clone(),
                    operation: "lock-pending-prompts",
                    message: error.to_string(),
                }
            })?;
            pending.insert(
                request_id.clone(),
                PendingSshPasswordPrompt {
                    destination: request.destination.clone(),
                    sender,
                },
            );
        }

        if let Err(message) = emit(payload) {
            self.remove_pending(&request_id);
            return Err(SshPasswordPromptRequestError::Presentation {
                request_id,
                destination: request.destination,
                operation: "send-prompt-request",
                message,
            });
        }

        let result = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                self.remove_pending(&request_id);
                return Err(SshPasswordPromptRequestError::Cancelled {
                    request_id,
                    destination: request.destination,
                });
            }
            result = tokio::time::timeout(self.timeout, receiver) => result,
        };
        match result {
            Ok(Ok(result)) => result,
            Ok(Err(_closed)) => Err(SshPasswordPromptRequestError::ServiceStopped {
                request_id,
                destination: request.destination,
            }),
            Err(_elapsed) => {
                self.remove_pending(&request_id);
                Err(SshPasswordPromptRequestError::TimedOut {
                    request_id,
                    destination: request.destination,
                })
            }
        }
    }

    pub fn resolve(
        &self,
        input: SshPasswordPromptResolution,
    ) -> Result<(), SshPasswordPromptResolveError> {
        let request_id = input.request_id.trim().to_string();
        if request_id.is_empty() {
            return Err(SshPasswordPromptResolveError::InvalidRequestId);
        }
        let Some(pending) = self.remove_pending(&request_id) else {
            return Err(SshPasswordPromptResolveError::Expired { request_id });
        };
        let result = match input.password {
            Some(password) => Ok(password),
            None => Err(SshPasswordPromptRequestError::Cancelled {
                request_id: request_id.clone(),
                destination: pending.destination.clone(),
            }),
        };
        let _ = pending.sender.send(result);
        Ok(())
    }

    fn remove_pending(&self, request_id: &str) -> Option<PendingSshPasswordPrompt> {
        self.pending.lock().ok()?.remove(request_id)
    }
}

fn format_system_time(system_time: SystemTime) -> String {
    let duration = system_time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = i64::try_from(duration.as_secs()).unwrap_or(i64::MAX);
    OffsetDateTime::from_unix_timestamp(seconds)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSshHost {
    pub alias: String,
    pub hostname: String,
    pub username: Option<String>,
    pub port: Option<u16>,
    pub source: &'static str,
}

impl DiscoveredSshHost {
    pub fn to_value(&self) -> Value {
        json!({
            "alias": &self.alias,
            "hostname": &self.hostname,
            "username": &self.username,
            "port": self.port,
            "source": self.source,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SshConfigLineParseError {
    InvalidQuotes,
}

fn split_directive_args(value: &str) -> Result<Vec<String>, SshConfigLineParseError> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut characters = value.chars().peekable();

    while let Some(character) = characters.next() {
        if let Some(delimiter) = quote {
            match character {
                '\\' if characters.peek().is_some_and(|next| *next == delimiter) => {
                    current.push(delimiter);
                    characters.next();
                }
                value if value == delimiter => quote = None,
                value => current.push(value),
            }
            continue;
        }

        match character {
            '\\' if characters
                .peek()
                .is_some_and(|next| next.is_whitespace() || *next == '#') =>
            {
                current.push(
                    characters
                        .next()
                        .expect("peeked escaped value should exist"),
                );
            }
            '\'' | '"' => quote = Some(character),
            '#' if current.is_empty() => break,
            '#' => current.push(character),
            '=' if args.is_empty() && !current.is_empty() => {
                args.push(std::mem::take(&mut current));
            }
            '=' if args.len() == 1 && current.is_empty() => {}
            value if value.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            value => current.push(value),
        }
    }

    if quote.is_some() {
        return Err(SshConfigLineParseError::InvalidQuotes);
    }
    if !current.is_empty() {
        args.push(current);
    }
    Ok(args)
}

fn has_ssh_pattern(value: &str) -> bool {
    value.contains('*') || value.contains('?') || value.starts_with('!')
}

fn expand_home_path(input: &str, home_dir: &Path) -> PathBuf {
    if input == "~" {
        return home_dir.to_path_buf();
    }
    if let Some(rest) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
    {
        return home_dir.join(rest);
    }
    PathBuf::from(input)
}

fn resolve_ssh_config_include_pattern(include_pattern: &str, home_dir: &Path) -> PathBuf {
    let expanded_pattern = expand_home_path(include_pattern, home_dir);
    if expanded_pattern.is_absolute() {
        expanded_pattern
    } else {
        home_dir.join(SSH_DIRECTORY_NAME).join(expanded_pattern)
    }
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    fn matches_inner(pattern: &[char], value: &[char]) -> bool {
        match pattern.split_first() {
            None => value.is_empty(),
            Some(('*', rest)) => {
                matches_inner(rest, value)
                    || (!value.is_empty() && matches_inner(pattern, &value[1..]))
            }
            Some(('?', rest)) => !value.is_empty() && matches_inner(rest, &value[1..]),
            Some((expected, rest)) => value
                .split_first()
                .is_some_and(|(actual, tail)| actual == expected && matches_inner(rest, tail)),
        }
    }

    matches_inner(
        &pattern.chars().collect::<Vec<_>>(),
        &value.chars().collect::<Vec<_>>(),
    )
}

fn expand_glob(pattern: &Path) -> io::Result<Vec<PathBuf>> {
    let pattern_text = pattern.to_string_lossy();
    if !pattern_text.contains('*') && !pattern_text.contains('?') {
        return Ok(if pattern.exists() {
            vec![pattern.to_path_buf()]
        } else {
            Vec::new()
        });
    }

    let directory = pattern.parent().unwrap_or_else(|| Path::new("."));
    let Some(file_pattern) = pattern.file_name().and_then(|value| value.to_str()) else {
        return Ok(Vec::new());
    };
    if !directory.exists() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if wildcard_matches(file_pattern, file_name) {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}

fn collect_ssh_config_aliases_from_file(
    file_path: &Path,
    home_dir: &Path,
    visited: &mut BTreeSet<PathBuf>,
) -> io::Result<BTreeSet<String>> {
    let resolved_path = file_path.to_path_buf();
    if visited.contains(&resolved_path) || !resolved_path.exists() {
        return Ok(BTreeSet::new());
    }
    visited.insert(resolved_path.clone());

    let mut aliases = BTreeSet::new();
    let raw = fs::read_to_string(&resolved_path)?;
    for line in raw.lines() {
        let Ok(parsed_args) = split_directive_args(line) else {
            continue;
        };
        let mut args = parsed_args.into_iter();
        let directive = args.next().unwrap_or_default().to_ascii_lowercase();
        if directive == "include" {
            for include_pattern in args {
                let resolved_pattern =
                    resolve_ssh_config_include_pattern(&include_pattern, home_dir);
                for included_path in expand_glob(&resolved_pattern)? {
                    aliases.extend(collect_ssh_config_aliases_from_file(
                        &included_path,
                        home_dir,
                        visited,
                    )?);
                }
            }
            continue;
        }

        if directive != "host" {
            continue;
        }

        for alias in args {
            if alias.is_empty() || has_ssh_pattern(&alias) {
                continue;
            }
            aliases.insert(alias);
        }
    }

    Ok(aliases)
}

fn normalize_known_hosts_hostname(raw_host: &str) -> String {
    if let Some(rest) = raw_host.strip_prefix('[')
        && let Some((host, _port)) = rest.split_once("]:")
    {
        return host.to_string();
    }

    if !raw_host.contains(':') {
        return raw_host.to_string();
    }

    let first_colon_index = raw_host.find(':');
    let last_colon_index = raw_host.rfind(':');
    if first_colon_index == last_colon_index {
        raw_host
            .split_once(':')
            .map_or_else(|| raw_host.to_string(), |(host, _port)| host.to_string())
    } else {
        raw_host.to_string()
    }
}

pub fn parse_known_hosts_hostnames(raw: &str) -> BTreeSet<String> {
    let mut hostnames = BTreeSet::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let without_marker = if trimmed.starts_with('@') {
            trimmed
                .split_whitespace()
                .skip(1)
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            trimmed.to_string()
        };
        let host_field = without_marker.split_whitespace().next().unwrap_or_default();
        if host_field.is_empty() || host_field.starts_with('|') {
            continue;
        }

        for raw_host in host_field.split(',') {
            let host = normalize_known_hosts_hostname(raw_host).trim().to_string();
            if host.is_empty() || has_ssh_pattern(&host) {
                continue;
            }
            hostnames.insert(host);
        }
    }

    hostnames
}

fn read_known_hosts_hostnames(file_path: &Path) -> io::Result<BTreeSet<String>> {
    match fs::read_to_string(file_path) {
        Ok(raw) => Ok(parse_known_hosts_hostnames(&raw)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(error) => Err(error),
    }
}

pub fn default_home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

pub fn discover_ssh_hosts(home_dir: Option<PathBuf>) -> Result<Vec<DiscoveredSshHost>, String> {
    let Some(home_dir) = home_dir else {
        return Ok(Vec::new());
    };
    if home_dir.as_os_str().is_empty() {
        return Ok(Vec::new());
    }

    let ssh_directory = home_dir.join(SSH_DIRECTORY_NAME);
    let config_aliases = collect_ssh_config_aliases_from_file(
        &ssh_directory.join(SSH_CONFIG_FILE_NAME),
        &home_dir,
        &mut BTreeSet::new(),
    )
    .map_err(|error| format!("Failed to read SSH config hosts: {error}"))?;
    let known_hosts = read_known_hosts_hostnames(&ssh_directory.join(KNOWN_HOSTS_FILE_NAME))
        .map_err(|error| format!("Failed to read known SSH hosts: {error}"))?;
    let mut discovered = BTreeMap::new();

    for alias in config_aliases {
        discovered.insert(
            alias.clone(),
            DiscoveredSshHost {
                alias: alias.clone(),
                hostname: alias,
                username: None,
                port: None,
                source: "ssh-config",
            },
        );
    }

    for hostname in known_hosts {
        discovered
            .entry(hostname.clone())
            .or_insert_with(|| DiscoveredSshHost {
                alias: hostname.clone(),
                hostname,
                username: None,
                port: None,
                source: "known-hosts",
            });
    }

    Ok(discovered.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn setup_failure_status_preserves_explicit_cancellation() {
        let active = CancellationToken::new();
        assert_eq!(ssh_setup_failure_status(&active), SshSetupStatus::Failed);

        active.cancel();
        assert_eq!(ssh_setup_failure_status(&active), SshSetupStatus::Cancelled);
    }

    fn provision_verified_artifact(os: RemoteHostOs) -> VerifiedArtifact {
        VerifiedArtifact {
            local_path: PathBuf::from("fixture-server-artifact"),
            version: "0.4.2".to_string(),
            os,
            architecture: RemoteHostArchitecture::X86_64,
            format: match os {
                RemoteHostOs::Linux => ArtifactFormat::TarGz,
                RemoteHostOs::MacOs => ArtifactFormat::TarGz,
                RemoteHostOs::Windows => ArtifactFormat::Zip,
            },
            size: 4096,
            sha256: "a".repeat(64),
            remote_path: match os {
                RemoteHostOs::Windows => r"C:\Users\dev\server.zip".to_string(),
                RemoteHostOs::Linux | RemoteHostOs::MacOs => "/home/dev/server.tar.gz".to_string(),
            },
            install_root: match os {
                RemoteHostOs::Windows => r"C:\Users\dev\BiBCode\Server".to_string(),
                RemoteHostOs::Linux | RemoteHostOs::MacOs => {
                    "/home/dev/.local/share/bibcode/server".to_string()
                }
            },
            data_root: match os {
                RemoteHostOs::Windows => r"C:\Users\dev\.bibcode".to_string(),
                RemoteHostOs::Linux | RemoteHostOs::MacOs => "/home/dev/.bibcode".to_string(),
            },
            service_mode: RemoteServiceMode::Workstation,
            remote_port: 3773,
        }
    }

    fn provision_managed_path_probe(os: RemoteHostOs, install_base: &str) -> RemoteHostProbe {
        RemoteHostProbe {
            os,
            architecture: RemoteHostArchitecture::X86_64,
            installed_version: Some("0.4.2".to_string()),
            service_mode: Some(RemoteServiceMode::Workstation),
            service_state: RemoteServiceState::Running,
            data_root: Some(match os {
                RemoteHostOs::Windows => r"C:\Users\dev\.bibcode".to_string(),
                RemoteHostOs::Linux | RemoteHostOs::MacOs => "/home/dev/.bibcode".to_string(),
            }),
            control_available: true,
            free_bytes: 1_000_000,
            install_authority: RemoteInstallAuthority::User,
            home: match os {
                RemoteHostOs::Windows => r"C:\Users\dev".to_string(),
                RemoteHostOs::Linux | RemoteHostOs::MacOs => "/home/dev".to_string(),
            },
            install_base: install_base.to_string(),
            system_install_base: match os {
                RemoteHostOs::Linux => "/opt/bibcode/server".to_string(),
                RemoteHostOs::MacOs => "/Library/Application Support/BiBCode Server".to_string(),
                RemoteHostOs::Windows => r"C:\ProgramData\BiBCode\Server".to_string(),
            },
            headless_data_root: match os {
                RemoteHostOs::Windows => r"C:\ProgramData\BiBCode".to_string(),
                RemoteHostOs::Linux => "/var/lib/bibcode".to_string(),
                RemoteHostOs::MacOs => "/Library/Application Support/BiBCode".to_string(),
            },
            binary_path: None,
            bind_port: Some(3773),
            capabilities: crate::remote_host::model::RemoteHostCapabilities::default(),
        }
    }

    #[test]
    fn provision_managed_binary_paths_are_confined_to_owned_roots() {
        let linux = provision_managed_path_probe(
            RemoteHostOs::Linux,
            "/home/dev/.local/share/bibcode/server",
        );
        assert!(validate_managed_binary_path(&linux, "/usr/bin/bibcode").is_ok());
        assert!(
            validate_managed_binary_path(
                &linux,
                "/home/dev/.local/share/bibcode/server/versions/version-1/bibcode-server/bin/bibcode",
            )
            .is_ok()
        );
        assert!(
            validate_managed_binary_path(
                &linux,
                "/opt/bibcode/server/versions/version-1/bibcode-server/bin/bibcode",
            )
            .is_ok()
        );
        assert!(validate_managed_binary_path(&linux, "/tmp/bibcode").is_err());
        assert!(
            validate_managed_binary_path(
                &linux,
                "/home/dev/.local/share/bibcode/server/versions/../bibcode-server/bin/bibcode",
            )
            .is_err()
        );

        let macos = provision_managed_path_probe(
            RemoteHostOs::MacOs,
            "/Users/dev/Library/Application Support/BiBCode Server",
        );
        assert!(validate_managed_binary_path(&macos, "/usr/local/bin/bibcode").is_ok());
        assert!(
            validate_managed_binary_path(
                &macos,
                "/Users/dev/Library/Application Support/BiBCode Server/versions/version-1/bibcode-server/bin/bibcode",
            )
            .is_ok()
        );
        assert!(
            validate_managed_binary_path(
                &macos,
                "/Library/Application Support/BiBCode Server/versions/version-1/bibcode-server/bin/bibcode",
            )
            .is_ok()
        );

        let windows =
            provision_managed_path_probe(RemoteHostOs::Windows, r"C:\Users\dev\AppData\Local");
        assert!(
            validate_managed_binary_path(
                &windows,
                r"C:\Users\dev\AppData\Local\Programs\BiBCode Server\bin\bibcode.exe",
            )
            .is_ok()
        );
        assert!(
            validate_managed_binary_path(
                &windows,
                r"C:\Users\dev\AppData\Local\BiBCode\Server\versions\version-1\bibcode-server\bin\bibcode.exe",
            )
            .is_ok()
        );
        assert!(
            validate_managed_binary_path(
                &windows,
                r"C:\ProgramData\BiBCode\Server\versions\version-1\bibcode-server\bin\bibcode.exe",
            )
            .is_ok()
        );
        assert!(validate_managed_binary_path(&windows, r"C:\Temp\bibcode.exe").is_err());
    }

    #[test]
    fn provision_managed_binary_probe_keeps_dynamic_paths_out_of_shell_program_text() {
        let posix_path = "/home/dev/.local/share/bibcode/server/versions/version ' ; $(touch nope)/bibcode-server/bin/bibcode";
        let linux = provision_managed_path_probe(
            RemoteHostOs::Linux,
            "/home/dev/.local/share/bibcode/server",
        );
        validate_managed_binary_path(&linux, posix_path).expect("owned POSIX managed path");
        let mut linux_commands = LinuxRemoteHostAdapter.probe_commands();
        configure_managed_binary_probe(RemoteHostOs::Linux, &mut linux_commands, posix_path)
            .expect("configure POSIX managed probe");
        let version = linux_commands
            .iter()
            .find(|command| command.purpose == RemoteCommandPurpose::InstalledVersion)
            .expect("managed version probe");
        assert_eq!(version.program, posix_path);
        assert_eq!(
            render_posix_remote_command(version).expect("render managed version probe"),
            format!("'{}' '--version'", posix_path.replace('\'', "'\"'\"'"))
        );

        let windows_path = r"C:\Users\dev\AppData\Local\BiBCode\Server\versions\version & calc\bibcode-server\bin\bibcode.exe";
        let windows =
            provision_managed_path_probe(RemoteHostOs::Windows, r"C:\Users\dev\AppData\Local");
        validate_managed_binary_path(&windows, windows_path).expect("owned Windows managed path");
        let mut windows_commands = WindowsRemoteHostAdapter.probe_commands();
        configure_managed_binary_probe(RemoteHostOs::Windows, &mut windows_commands, windows_path)
            .expect("configure Windows managed probe");
        let probe = windows_commands
            .iter()
            .find(|command| command.purpose == RemoteCommandPurpose::WindowsProbe)
            .expect("Windows managed probe");
        assert!(
            !probe.program.contains(windows_path)
                && probe
                    .arguments
                    .iter()
                    .all(|argument| !argument.contains(windows_path))
        );
        assert!(
            !crate::remote_host::windows::decode_powershell_command(probe)
                .expect("decode fixed Windows probe")
                .contains(windows_path)
        );
        let RemoteStdin::Json(bytes) = &probe.stdin else {
            panic!("Windows managed path must cross only typed JSON stdin");
        };
        let document: Value = serde_json::from_slice(bytes).expect("managed probe JSON");
        assert_eq!(
            document.get("managedBinaryPath").and_then(Value::as_str),
            Some(windows_path)
        );
    }

    #[test]
    fn provision_headless_setup_selects_portable_artifacts_without_package_side_effects() {
        for (os, adapter, expected) in [
            (
                RemoteHostOs::Linux,
                Box::new(LinuxRemoteHostAdapter) as Box<dyn RemoteHostAdapter>,
                ArtifactFormat::TarGz,
            ),
            (
                RemoteHostOs::MacOs,
                Box::new(MacOsRemoteHostAdapter) as Box<dyn RemoteHostAdapter>,
                ArtifactFormat::TarGz,
            ),
            (
                RemoteHostOs::Windows,
                Box::new(WindowsRemoteHostAdapter) as Box<dyn RemoteHostAdapter>,
                ArtifactFormat::Zip,
            ),
        ] {
            let install_base = match os {
                RemoteHostOs::Windows => r"C:\Users\dev\AppData\Local",
                RemoteHostOs::Linux => "/home/dev/.local/share/bibcode/server",
                RemoteHostOs::MacOs => "/Users/dev/Library/Application Support/BiBCode Server",
            };
            let mut probe = provision_managed_path_probe(os, install_base);
            probe.installed_version = None;
            probe.install_authority = RemoteInstallAuthority::NoninteractiveAdministrator;
            probe.capabilities.portable_extractor = true;
            probe.capabilities.deb_installer = os == RemoteHostOs::Linux;
            probe.capabilities.package_installer = os == RemoteHostOs::MacOs;
            probe.capabilities.msi_installer = os == RemoteHostOs::Windows;

            assert_eq!(
                ssh_setup_preferred_formats(adapter.as_ref(), &probe, RemoteServiceMode::Headless,),
                vec![expected]
            );
        }
    }

    #[test]
    fn provision_recovery_command_binds_exact_binary_mode_and_data_root() {
        let posix = render_ssh_recovery_command(
            RemoteHostOs::Linux,
            "/home/dev/version ' one/bibcode",
            RemoteServiceMode::Headless,
            "/var/lib/bibcode data",
            4773,
        )
        .expect("POSIX recovery command");
        assert_eq!(
            posix,
            "'sudo' '-n' '/home/dev/version '\"'\"' one/bibcode' 'service' 'status' '--mode' 'headless' '--format' 'json' '--host' '127.0.0.1' '--port' '4773' '--base-dir' '/var/lib/bibcode data'"
        );

        let windows = render_ssh_recovery_command(
            RemoteHostOs::Windows,
            r"C:\Users\dev\BiBCode's Server\bibcode.exe",
            RemoteServiceMode::Workstation,
            r"C:\Users\dev\BiBCode's Data",
            3773,
        )
        .expect("Windows recovery command");
        assert_eq!(
            windows,
            "& 'C:\\Users\\dev\\BiBCode''s Server\\bibcode.exe' service status --mode workstation --format json --host 127.0.0.1 --port 3773 --base-dir 'C:\\Users\\dev\\BiBCode''s Data'"
        );
    }

    #[test]
    fn provision_descriptor_canonicalization_strips_unexpected_secret_fields() {
        let protocol = u64::from(bibcode_server::ENVIRONMENT_PROTOCOL_VERSION);
        let descriptor = json!({
            "environmentId": "123e4567-e89b-12d3-a456-426614174000",
            "label": "Remote host",
            "platform": { "os": "linux", "arch": "x64", "secret": "drop-me" },
            "serverVersion": "0.4.2",
            "storageInstanceId": "123e4567-e89b-12d3-a456-426614174001",
            "protocol": { "minimum": protocol, "maximum": protocol },
            "capabilities": {
                "repositoryIdentity": true,
                "secret": "drop-me",
            },
            "transport": { "mode": "loopback-http", "credential": "drop-me" },
            "credential": "must-never-cross-the-desktop-bridge",
        });
        let canonical = canonicalize_ssh_environment_descriptor(&descriptor)
            .expect("canonical public descriptor");

        assert!(canonical.get("credential").is_none());
        assert!(canonical.pointer("/platform/secret").is_none());
        assert!(canonical.pointer("/capabilities/secret").is_none());
        assert!(canonical.pointer("/transport/credential").is_none());
        assert_eq!(
            canonical.pointer("/capabilities/repositoryIdentity"),
            Some(&Value::Bool(true))
        );
    }

    #[test]
    fn provision_verifies_posix_hash_and_size_as_separate_bounded_results() {
        let verified = provision_verified_artifact(RemoteHostOs::Linux);
        let hash = RemoteCommandOutput::success(
            RemoteCommandPurpose::VerifyTransfer,
            format!("{}  {}\n", verified.sha256, verified.remote_path).into_bytes(),
        );
        let size = RemoteCommandOutput::success(
            RemoteCommandPurpose::VerifyTransferSize,
            format!("{} {}\n", verified.size, verified.remote_path).into_bytes(),
        );
        validate_remote_artifact_verification(RemoteHostOs::Linux, &hash, &verified)
            .expect("matching hash");
        validate_remote_artifact_verification(RemoteHostOs::Linux, &size, &verified)
            .expect("matching byte count");

        let wrong_size = RemoteCommandOutput::success(
            RemoteCommandPurpose::VerifyTransferSize,
            b"4095 /home/dev/server.tar.gz\n".to_vec(),
        );
        assert!(
            validate_remote_artifact_verification(RemoteHostOs::Linux, &wrong_size, &verified,)
                .is_err()
        );
    }

    #[test]
    fn provision_rejects_a_mismatched_privileged_headless_artifact_copy() {
        let mut verified = provision_verified_artifact(RemoteHostOs::Linux);
        verified.service_mode = RemoteServiceMode::Headless;
        verified.install_root = "/opt/bibcode/server/versions/version-1".to_string();
        let wrong_hash = RemoteCommandOutput::success(
            RemoteCommandPurpose::VerifyTransfer,
            format!(
                "{}  {}/artifact.tar.gz\n",
                "b".repeat(64),
                verified.install_root
            )
            .into_bytes(),
        );

        assert!(
            validate_remote_artifact_verification(RemoteHostOs::Linux, &wrong_hash, &verified)
                .is_err()
        );
    }

    #[test]
    fn provision_verifies_windows_hash_and_size_in_one_owned_json_result() {
        let verified = provision_verified_artifact(RemoteHostOs::Windows);
        let output = RemoteCommandOutput::success(
            RemoteCommandPurpose::VerifyTransfer,
            serde_json::to_vec(&json!({
                "sha256": verified.sha256,
                "size": verified.size,
            }))
            .expect("verification fixture"),
        );
        validate_remote_artifact_verification(RemoteHostOs::Windows, &output, &verified)
            .expect("matching Windows verification");
    }

    #[tokio::test]
    async fn provision_descriptor_fetch_rejects_non_loopback_and_credentialed_urls() {
        assert!(
            fetch_ssh_setup_descriptor("http://192.0.2.10:3773/")
                .await
                .is_err()
        );
        assert!(
            fetch_ssh_setup_descriptor("http://user:password@127.0.0.1:3773/")
                .await
                .is_err()
        );
        assert!(
            fetch_ssh_setup_descriptor("https://127.0.0.1:3773/")
                .await
                .is_err()
        );
    }

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    fn unique_temp_home() -> PathBuf {
        std::env::temp_dir().join(format!(
            "bibcode-tauri-ssh-test-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ))
    }

    fn process_is_alive(pid: u32) -> bool {
        #[cfg(unix)]
        {
            // SAFETY: signal zero does not modify the target process.
            unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
        }
        #[cfg(windows)]
        {
            std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"),
                ])
                .status()
                .is_ok_and(|status| status.success())
        }
    }

    #[test]
    fn askpass_launcher_last_lease_removes_exact_root_without_persisting_secret() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let root = launcher.root().to_path_buf();
        let retained = launcher.clone();

        assert!(launcher.path().is_file());
        assert!(root.starts_with(temporary_base.path()));
        assert!(
            !fs::read_to_string(launcher.path())
                .expect("askpass launcher should read")
                .contains("fixture-password"),
            "askpass files must not persist authentication secrets"
        );

        drop(launcher);
        assert!(root.exists(), "a retained lease must keep its helper root");
        drop(retained);
        assert!(!root.exists(), "the final lease must remove its exact root");
        assert_eq!(
            fs::read_dir(temporary_base.path())
                .expect("temporary base should remain readable")
                .count(),
            0
        );
    }

    #[test]
    fn askpass_launcher_cleanup_preserves_unexpected_foreign_entries() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let root = launcher.root().to_path_buf();
        let directory = launcher
            .path()
            .parent()
            .expect("askpass directory")
            .to_path_buf();
        let foreign = directory.join("foreign-owner.txt");
        fs::write(&foreign, "foreign-owner-data").expect("foreign fixture should write");

        drop(launcher);

        assert_eq!(
            fs::read_to_string(&foreign).expect("foreign entry must remain"),
            "foreign-owner-data"
        );
        assert!(root.exists(), "a nonempty foreign-owned root must remain");
        assert!(
            !directory.join("ssh-askpass.sh").exists()
                && !directory.join("ssh-askpass.cmd").exists()
                && !directory.join("ssh-askpass.ps1").exists()
                && !directory.join("ssh-host-key-pin.sh").exists()
                && !directory.join("ssh-host-key-pin.ps1").exists(),
            "only the exact created helper files should be removed"
        );
    }

    #[test]
    fn concurrent_askpass_requests_share_one_live_unique_lease() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager = Arc::new(SshEnvironmentManager::with_askpass_temp_base(
            temporary_base.path().to_path_buf(),
        ));
        let barrier = Arc::new(std::sync::Barrier::new(9));
        let owners = (0..8)
            .map(|_| {
                let manager = manager.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    manager
                        .askpass_launcher()
                        .expect("parallel askpass launcher")
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let owners = owners
            .into_iter()
            .map(|owner| owner.join().expect("parallel askpass owner"))
            .collect::<Vec<_>>();
        let expected_root = owners[0].root();

        assert!(owners.iter().all(|owner| owner.root() == expected_root));
        assert_eq!(
            fs::read_dir(temporary_base.path())
                .expect("temporary base should remain readable")
                .count(),
            1,
            "concurrent requests must converge on one live helper root"
        );
        drop(owners);
        assert_eq!(
            fs::read_dir(temporary_base.path())
                .expect("temporary base should remain readable")
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn cancelled_askpass_owner_removes_root_after_join() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let root = launcher.root().to_path_buf();
        let (entered_sender, entered_receiver) = oneshot::channel();
        let owner = tokio::spawn(async move {
            let _launcher = launcher;
            let _ = entered_sender.send(());
            std::future::pending::<()>().await;
        });
        entered_receiver
            .await
            .expect("cancelled owner should publish readiness");

        owner.abort();
        assert!(
            owner
                .await
                .expect_err("owner should be cancelled")
                .is_cancelled()
        );
        assert!(
            !root.exists(),
            "joining cancellation must release the helper root"
        );
        assert_eq!(
            fs::read_dir(temporary_base.path())
                .expect("temporary base should remain readable")
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn cancelled_active_ssh_child_reaps_before_releasing_askpass_root() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let root = launcher.root().to_path_buf();
        let mut cleaned = launcher.cleanup_observer();
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('ready!'); Start-Sleep -Seconds 60",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "printf 'ready!'; exec sleep 60"]);
            command
        };
        command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let reaper_permit = launcher
            .reserve_child()
            .expect("active SSH child should reserve cleanup ownership");
        let child = command.spawn().expect("active SSH child fixture");
        let pid = child.id().expect("active SSH child PID");
        let mut child = ManagedSshChild::new(child, launcher, reaper_permit);
        let mut stdout = child
            .child_mut()
            .stdout
            .take()
            .expect("active SSH child stdout");
        let mut readiness = [0_u8; 6];
        stdout
            .read_exact(&mut readiness)
            .await
            .expect("active SSH child readiness");
        assert_eq!(&readiness, b"ready!");

        let owner = tokio::spawn(async move {
            let _child = child;
            std::future::pending::<()>().await;
        });
        owner.abort();
        assert!(
            owner
                .await
                .expect_err("active owner should be cancelled")
                .is_cancelled()
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(manager.shutdown(), manager.shutdown());
        })
        .await
        .expect("concurrent manager shutdown should drain active SSH cleanup");
        cleaned
            .changed()
            .await
            .expect("cleanup observer should remain live");

        assert!(
            *cleaned.borrow(),
            "cleanup must publish only after child reap"
        );
        assert!(
            !root.exists(),
            "reap completion must release the helper root"
        );
        assert!(
            !process_is_alive(pid),
            "cleanup event must follow exact child exit"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropped_tunnel_joins_its_stderr_task_before_reaper_shutdown_returns() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exec sleep 60"]);
            command
        };
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let reaper_permit = launcher
            .reserve_child()
            .expect("active SSH child should reserve cleanup ownership");
        let child = command.spawn().expect("active SSH child fixture");
        let mut child = ManagedSshChild::new(child, launcher, reaper_permit);
        let dropped = Arc::new(AtomicBool::new(false));
        let task_dropped = dropped.clone();
        let (entered_sender, entered_receiver) = oneshot::channel();
        child.retain_stderr_drain(tokio::spawn(async move {
            let _drop_flag = DropFlag(task_dropped);
            let _ = entered_sender.send(());
            std::thread::sleep(Duration::from_millis(250));
            std::future::pending::<()>().await;
        }));
        entered_receiver
            .await
            .expect("stderr task should enter its active poll");

        drop(child);
        tokio::time::timeout(Duration::from_secs(3), manager.shutdown())
            .await
            .expect("shutdown should join the transferred stderr task");

        assert!(
            dropped.load(Ordering::Acquire),
            "reaper shutdown must not return before the stderr task is dropped and joined"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn naturally_exited_published_tunnel_transfers_its_stderr_task_to_the_reaper() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        };
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let reaper_permit = launcher
            .reserve_child()
            .expect("published SSH child should reserve cleanup ownership");
        let child = command
            .spawn()
            .expect("naturally exiting SSH child fixture");
        let mut child = ManagedSshChild::new(child, launcher, reaper_permit);
        let dropped = Arc::new(AtomicBool::new(false));
        let task_dropped = dropped.clone();
        let (entered_sender, entered_receiver) = oneshot::channel();
        child.retain_stderr_drain(tokio::spawn(async move {
            let _drop_flag = DropFlag(task_dropped);
            let _ = entered_sender.send(());
            std::thread::sleep(Duration::from_millis(250));
            std::future::pending::<()>().await;
        }));
        entered_receiver
            .await
            .expect("stderr task should enter its active poll");
        let target = SshEnvironmentTarget {
            alias: "natural-exit".to_string(),
            hostname: "natural-exit.invalid".to_string(),
            username: None,
            port: None,
        };
        let key = target_connection_key(&target);
        let owner = manager
            .begin_operation(
                &target,
                manager
                    .operation_fence(&key, None, None, None)
                    .expect("fixture tunnel fence"),
                RemoteOperationClass::Session,
            )
            .await
            .expect("fixture tunnel owner");
        let tunnel_permit = manager
            .operations
            .acquire_tunnel(&owner)
            .await
            .expect("fixture tunnel permit");
        let published = manager.publish_tunnel(
            key.clone(),
            child,
            SshEnvironmentBootstrap::external(
                target,
                3773,
                "http://127.0.0.1:41000/".to_string(),
                "ws://127.0.0.1:41000/".to_string(),
                "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
            ),
            tunnel_permit,
            &owner,
        );
        assert!(published.is_ok(), "fixture tunnel should publish");
        drop(owner);

        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if manager
                    .take_existing_bootstrap_if_running(&key)
                    .expect("stale tunnel inspection should succeed")
                    .is_none()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("naturally exited tunnel should become stale");
        manager.shutdown().await;

        assert!(
            dropped.load(Ordering::Acquire),
            "stale removal must join the retained stderr task before shutdown returns"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rejected_disconnect_keeps_the_published_tunnel_alive() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exec sleep 60"]);
            command
        };
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let reaper_permit = launcher
            .reserve_child()
            .expect("published SSH child should reserve cleanup ownership");
        let child = command.spawn().expect("active SSH child fixture");
        let child = ManagedSshChild::new(child, launcher, reaper_permit);
        let target = SshEnvironmentTarget {
            alias: "retained-tunnel".to_string(),
            hostname: "retained-tunnel.invalid".to_string(),
            username: None,
            port: None,
        };
        let pinned = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let key = target_connection_key(&target);
        let owner = manager
            .begin_operation(
                &target,
                manager
                    .operation_fence(&key, None, None, None)
                    .expect("fixture tunnel fence"),
                RemoteOperationClass::Session,
            )
            .await
            .expect("fixture tunnel owner");
        let tunnel_permit = manager
            .operations
            .acquire_tunnel(&owner)
            .await
            .expect("fixture tunnel permit");
        manager
            .publish_tunnel(
                key,
                child,
                SshEnvironmentBootstrap::external(
                    target.clone(),
                    3773,
                    "http://127.0.0.1:41000/".to_string(),
                    "ws://127.0.0.1:41000/".to_string(),
                    pinned.to_string(),
                ),
                tunnel_permit,
                &owner,
            )
            .map_err(|(error, _child)| error)
            .expect("fixture tunnel should publish");
        drop(owner);
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("mock Tauri app");
        let prompts = SshPasswordPromptManager::with_timeout(Duration::ZERO);

        let invalid = manager
            .disconnect_environment(
                app.handle(),
                &prompts,
                target.clone(),
                SshEnvironmentDisconnectOptions {
                    expected_host_key_fingerprint: "invalid".to_string(),
                },
            )
            .await
            .expect_err("an invalid saved pin must reject disconnect");
        assert!(
            invalid.contains("valid saved host-key fingerprint"),
            "{invalid}"
        );
        assert_eq!(
            manager
                .active_bootstrap(&target)
                .expect("active tunnel should remain inspectable")
                .expect("invalid disconnect must retain the tunnel")
                .host_key_fingerprint,
            pinned
        );

        let changed = manager
            .disconnect_environment(
                app.handle(),
                &prompts,
                target.clone(),
                SshEnvironmentDisconnectOptions {
                    expected_host_key_fingerprint:
                        "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_string(),
                },
            )
            .await
            .expect_err("a changed saved pin must reject disconnect");
        assert!(changed.contains("fingerprint changed"), "{changed}");
        assert_eq!(
            manager
                .active_bootstrap(&target)
                .expect("active tunnel should remain inspectable")
                .expect("changed-pin disconnect must retain the tunnel")
                .host_key_fingerprint,
            pinned
        );
        let retry_fence = manager
            .operation_fence(&target_connection_key(&target), None, None, None)
            .expect("changed-pin retry fence");
        let retry = manager
            .begin_operation(&target, retry_fence, RemoteOperationClass::Session)
            .await
            .expect("a rejected disconnect must preserve same-generation admission");
        drop(retry);

        manager.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn manager_shutdown_terminates_child_owned_by_retained_waiter() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let root = launcher.root().to_path_buf();
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('ready!'); Start-Sleep -Seconds 60",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "printf 'ready!'; exec sleep 60"]);
            command
        };
        command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let reaper_permit = launcher
            .reserve_child()
            .expect("active SSH child should reserve cleanup ownership");
        let child = command.spawn().expect("active SSH child fixture");
        let pid = child.id().expect("active SSH child PID");
        let mut child = ManagedSshChild::new(child, launcher, reaper_permit);
        let mut stdout = child
            .child_mut()
            .stdout
            .take()
            .expect("active SSH child stdout");
        let mut readiness = [0_u8; 6];
        stdout
            .read_exact(&mut readiness)
            .await
            .expect("active SSH child readiness");
        assert_eq!(&readiness, b"ready!");
        let owner = tokio::spawn(async move { child.wait_with_output().await });

        if tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(manager.shutdown(), manager.shutdown());
        })
        .await
        .is_err()
        {
            owner.abort();
            let _ = owner.await;
            let _ = tokio::time::timeout(Duration::from_secs(3), manager.shutdown()).await;
            panic!("manager shutdown must interrupt a retained active SSH waiter");
        }
        let wait_error = owner
            .await
            .expect("retained SSH waiter should join")
            .expect_err("manager shutdown should interrupt the SSH wait");

        assert_eq!(wait_error.kind(), io::ErrorKind::Interrupted);
        assert!(!root.exists(), "shutdown must release the askpass root");
        assert!(!process_is_alive(pid), "shutdown must reap the exact child");
        tokio::time::timeout(Duration::from_secs(1), manager.shutdown())
            .await
            .expect("completed manager shutdown must remain idempotent");
    }

    #[tokio::test]
    async fn manager_shutdown_interrupts_unpublished_tunnel_readiness() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager = Arc::new(SshEnvironmentManager::with_askpass_temp_base(
            temporary_base.path().to_path_buf(),
        ));
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let root = launcher.root().to_path_buf();
        let (program, args) = if cfg!(windows) {
            (
                "powershell.exe".to_string(),
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    "Start-Sleep -Seconds 60".to_string(),
                ],
            )
        } else {
            (
                "sh".to_string(),
                vec!["-c".to_string(), "exec sleep 60".to_string()],
            )
        };
        let target = SshEnvironmentTarget {
            alias: "fixture".to_string(),
            hostname: "fixture.invalid".to_string(),
            username: Some("fixture-user".to_string()),
            port: None,
        };
        let plan = SshEnvironmentLaunchPlan {
            key: "shutdown-readiness".to_string(),
            program,
            args,
            target,
            local_port: 9,
            remote_port: 9,
            remote_server_kind: "fixture",
            http_base_url: "http://127.0.0.1:9/".to_string(),
            ws_base_url: "ws://127.0.0.1:9/".to_string(),
        };
        let operation_cancellation = CancellationToken::new();
        let owner = tokio::spawn(async move {
            start_ssh_tunnel(
                &plan,
                &SshAuthOptions::batch(),
                launcher,
                "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                &operation_cancellation,
            )
            .await
        });
        tokio::time::timeout(
            Duration::from_secs(3),
            manager.child_reaper.wait_until_active(),
        )
        .await
        .expect("unpublished tunnel should reserve ownership before readiness");

        tokio::time::timeout(Duration::from_secs(3), manager.shutdown())
            .await
            .expect("shutdown should interrupt unpublished tunnel readiness");
        let error = match owner.await.expect("unpublished tunnel owner should join") {
            Ok(mut child) => {
                child.terminate_and_reap().await;
                panic!("shutdown must reject unpublished tunnel readiness");
            }
            Err(error) => error,
        };

        assert_eq!(error, "SSH process owner is shutting down.");
        assert_eq!(manager.child_reaper.active(), 0);
        assert!(!root.exists(), "shutdown must release the askpass root");
    }

    #[tokio::test]
    async fn operation_cancellation_interrupts_and_reaps_unpublished_tunnel_readiness() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager = Arc::new(SshEnvironmentManager::with_askpass_temp_base(
            temporary_base.path().to_path_buf(),
        ));
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let (program, args) = if cfg!(windows) {
            (
                "powershell.exe".to_string(),
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    "Start-Sleep -Seconds 60".to_string(),
                ],
            )
        } else {
            (
                "sh".to_string(),
                vec!["-c".to_string(), "exec sleep 60".to_string()],
            )
        };
        let plan = SshEnvironmentLaunchPlan {
            key: "operation-cancel-readiness".to_string(),
            program,
            args,
            target: SshEnvironmentTarget {
                alias: "fixture".to_string(),
                hostname: "fixture.invalid".to_string(),
                username: Some("fixture-user".to_string()),
                port: None,
            },
            local_port: 9,
            remote_port: 9,
            remote_server_kind: "fixture",
            http_base_url: "http://127.0.0.1:9/".to_string(),
            ws_base_url: "ws://127.0.0.1:9/".to_string(),
        };
        let cancellation = CancellationToken::new();
        let owner_cancellation = cancellation.clone();
        let owner = tokio::spawn(async move {
            start_ssh_tunnel(
                &plan,
                &SshAuthOptions::batch(),
                launcher,
                "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                &owner_cancellation,
            )
            .await
        });
        tokio::time::timeout(
            Duration::from_secs(3),
            manager.child_reaper.wait_until_active(),
        )
        .await
        .expect("unpublished tunnel should reserve ownership before readiness");

        cancellation.cancel();
        let error = match owner.await.expect("unpublished tunnel owner should join") {
            Err(error) => error,
            Ok(mut child) => {
                child.terminate_and_reap().await;
                panic!("operation cancellation must reject tunnel publication");
            }
        };
        assert!(error.contains("cancelled"), "{error}");
        assert_eq!(manager.child_reaper.active(), 0);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn local_port_race_fails_before_publication_and_reaps_the_child() {
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 0))
            .expect("local port race fixture should bind");
        let local_port = occupied
            .local_addr()
            .expect("local port race fixture address")
            .port();
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let root = launcher.root().to_path_buf();
        let (program, args) = if cfg!(windows) {
            (
                "powershell.exe".to_string(),
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    format!(
                        "[Console]::Error.WriteLine('bind 127.0.0.1:{local_port}: Address already in use'); exit 255"
                    ),
                ],
            )
        } else {
            (
                "sh".to_string(),
                vec![
                    "-c".to_string(),
                    format!(
                        "printf 'bind 127.0.0.1:{local_port}: Address already in use\\n' >&2; exit 255"
                    ),
                ],
            )
        };
        let plan = SshEnvironmentLaunchPlan {
            key: "occupied-local-port".to_string(),
            program,
            args,
            target: SshEnvironmentTarget {
                alias: "fixture".to_string(),
                hostname: "fixture.invalid".to_string(),
                username: Some("fixture-user".to_string()),
                port: None,
            },
            local_port,
            remote_port: 3773,
            remote_server_kind: "fixture",
            http_base_url: format!("http://127.0.0.1:{local_port}/"),
            ws_base_url: format!("ws://127.0.0.1:{local_port}/"),
        };

        let error = match start_ssh_tunnel(
            &plan,
            &SshAuthOptions::batch(),
            launcher,
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            &CancellationToken::new(),
        )
        .await
        {
            Err(error) => error,
            Ok(mut child) => {
                child.terminate_and_reap().await;
                panic!("an occupied local port must prevent tunnel publication");
            }
        };

        assert!(error.contains("ended before confirming"), "{error}");
        assert_eq!(
            manager.child_reaper.active(),
            0,
            "the failed child must be reaped before failure is acknowledged"
        );
        assert!(!root.exists(), "reaping must release the askpass root");
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn ssh_child_reaper_capacity_refuses_spawn_admission_and_recovers() {
        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("askpass launcher should create");
        let permits = (0..SSH_CHILD_REAPER_CAPACITY)
            .map(|_| launcher.reserve_child().expect("bounded child ownership"))
            .collect::<Vec<_>>();
        let marker = temporary_base.path().join("spawned.txt");
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[IO.File]::WriteAllText($env:TASK9I_MARKER, 'spawned')",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "printf spawned > \"$TASK9I_MARKER\""]);
            command
        };
        command.env("TASK9I_MARKER", &marker).kill_on_drop(true);

        assert_eq!(manager.child_reaper.active(), SSH_CHILD_REAPER_CAPACITY);
        assert_eq!(
            launcher
                .reserve_child()
                .err()
                .expect("capacity must reject before process spawn"),
            "SSH process owner capacity was exceeded."
        );
        assert_eq!(
            spawn_managed_ssh_child(command, launcher.clone(), "start capacity fixture")
                .err()
                .expect("capacity must fail before spawning"),
            "SSH process owner capacity was exceeded."
        );
        assert!(!marker.exists(), "a refused child must never be spawned");

        drop(permits);
        assert_eq!(manager.child_reaper.active(), 0);
        assert!(launcher.reserve_child().is_ok());
        manager.shutdown().await;
        assert_eq!(
            launcher
                .reserve_child()
                .err()
                .expect("shutdown must close child admission"),
            "SSH process owner is shutting down."
        );
    }

    #[test]
    fn environment_manager_caches_clears_and_misses_auth_and_tunnels() {
        let manager = SshEnvironmentManager::default();
        assert_eq!(manager.cached_auth_secret("target"), None);
        manager
            .remember_auth_secret("target", "secret".to_string())
            .expect("authentication secret should cache");
        assert_eq!(
            manager.cached_auth_secret("target").as_deref(),
            Some("secret")
        );
        manager.clear_auth_secret("target");
        assert_eq!(manager.cached_auth_secret("target"), None);
        assert_eq!(
            manager
                .take_existing_bootstrap_if_running("missing-target")
                .expect("missing tunnel should be inspectable"),
            None,
        );
    }

    #[tokio::test]
    async fn environment_manager_reports_unreachable_ssh_targets() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let askpass_temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("mock Tauri app");
        let manager = SshEnvironmentManager::with_askpass_temp_base(
            askpass_temporary_base.path().to_path_buf(),
        );
        let prompts = SshPasswordPromptManager::with_timeout(Duration::ZERO);
        let target = SshEnvironmentTarget {
            alias: "unreachable-localhost".to_string(),
            hostname: "127.0.0.1".to_string(),
            username: None,
            port: Some(1),
        };

        let ensure_error = manager
            .ensure_environment(app.handle(), &prompts, target.clone(), None)
            .await
            .expect_err("an unreachable SSH target should not launch");
        assert!(ensure_error.contains("SSH host-key trust probe failed"));
        assert_eq!(
            fs::read_dir(askpass_temporary_base.path())
                .expect("askpass temporary base should remain readable")
                .count(),
            0,
            "failed ensure must release its askpass root"
        );

        manager
            .disconnect_environment(
                app.handle(),
                &prompts,
                target,
                SshEnvironmentDisconnectOptions {
                    expected_host_key_fingerprint:
                        "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
                },
            )
            .await
            .expect("local disconnect must not contact the unreachable SSH target");
        assert_eq!(
            fs::read_dir(askpass_temporary_base.path())
                .expect("askpass temporary base should remain readable")
                .count(),
            0,
            "local disconnect must not create or retain an askpass root"
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn disconnect_revokes_prepared_consent_and_requires_a_newer_generation() {
        use crate::server_artifacts::resolved_server_artifact_fixture;
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let temporary_base = tempfile::tempdir().expect("askpass temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let target = SshEnvironmentTarget {
            alias: "prepared-host".to_string(),
            hostname: "prepared-host.invalid".to_string(),
            username: Some("dev".to_string()),
            port: Some(22),
        };
        let fingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let original_fence =
            RemoteOperationFence::new("00000000-0000-4000-8000-000000000071", 7, 3)
                .expect("probe fence");
        let owner = manager
            .begin_operation(
                &target,
                original_fence.clone(),
                RemoteOperationClass::Session,
            )
            .await
            .expect("probe generation should become current");
        drop(owner);
        let record = ServerArtifactRecord {
            product: "bibcode-server".to_string(),
            version: "0.4.2".to_string(),
            os: "linux".to_string(),
            architecture: "x86_64".to_string(),
            format: "tar.gz".to_string(),
            download_name: "bibcode-server.tar.gz".to_string(),
            size: 1024,
            sha256: "a".repeat(64),
            signature_name: "bibcode-server.tar.gz.minisig".to_string(),
        };
        manager
            .store_prepared_setup(PreparedSshSetup {
                request_id: "prepared-request".to_string(),
                probe_generation: 7,
                target: target.clone(),
                host_key_fingerprint: fingerprint.to_string(),
                probe: provision_managed_path_probe(
                    RemoteHostOs::Linux,
                    "/home/dev/.local/share/bibcode/server",
                ),
                target_version: "0.4.2".to_string(),
                service_mode: RemoteServiceMode::Workstation,
                expected_environment_id: None,
                expected_storage_instance_id: None,
                resolved: resolved_server_artifact_fixture(record),
                format: ArtifactFormat::TarGz,
                paths: SshInstallPaths {
                    remote_artifact: "/home/dev/server.tar.gz".to_string(),
                    install_root: "/home/dev/.local/share/bibcode/server".to_string(),
                    installed_binary: "/home/dev/.local/share/bibcode/server/current/bin/bibcode"
                        .to_string(),
                    data_root: "/home/dev/.bibcode".to_string(),
                    remote_port: 3773,
                },
                expires_at: OffsetDateTime::now_utc() + time::Duration::minutes(5),
                operation_fence: original_fence.clone(),
            })
            .expect("prepared consent should be stored");
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("mock Tauri app");
        let prompts = SshPasswordPromptManager::with_timeout(Duration::ZERO);

        manager
            .disconnect_environment(
                app.handle(),
                &prompts,
                target.clone(),
                SshEnvironmentDisconnectOptions {
                    expected_host_key_fingerprint: fingerprint.to_string(),
                },
            )
            .await
            .expect("disconnect should perform local cleanup only");

        let missing = manager
            .take_prepared_setup(&SshSetupConsentDecision {
                request_id: "prepared-request".to_string(),
                probe_generation: 7,
                accepted: true,
            })
            .err()
            .expect("disconnect must revoke target-specific consent");
        assert!(
            missing.contains("missing, expired, or already used"),
            "{missing}"
        );
        let stale = manager
            .begin_operation(
                &target,
                original_fence
                    .with_operation_id("00000000-0000-4000-8000-000000000072")
                    .expect("stale retry fence"),
                RemoteOperationClass::Session,
            )
            .await
            .expect_err("disconnect must not reopen the prior generation");
        assert!(stale.contains("generation is stale"), "{stale}");
        let newer = manager
            .begin_operation(
                &target,
                RemoteOperationFence::new("00000000-0000-4000-8000-000000000073", 8, 3)
                    .expect("newer retry fence"),
                RemoteOperationClass::Session,
            )
            .await
            .expect("a newer generation should be admitted");
        drop(newer);
        manager.shutdown().await;
    }

    #[test]
    fn discovers_ssh_config_hosts_across_included_files() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        fs::create_dir_all(ssh_dir.join("config.d")).expect("ssh config dir should create");
        fs::write(
            ssh_dir.join("config"),
            [
                "Host devbox",
                "  HostName devbox.example.com",
                "Host=equalsbox",
                "Include=config.d/*.conf",
                "",
            ]
            .join("\n"),
        )
        .expect("ssh config should write");
        fs::write(
            ssh_dir.join("config.d").join("team.conf"),
            [
                "Host staging",
                "  HostName staging.example.com",
                "Host *",
                "  ServerAliveInterval 30",
                "",
            ]
            .join("\n"),
        )
        .expect("included ssh config should write");
        fs::write(
            ssh_dir.join("known_hosts"),
            [
                "known.example.com ssh-ed25519 AAAA",
                "|1|hashed|entry ssh-ed25519 AAAA",
                "[bastion.example.com]:2222 ssh-ed25519 AAAA",
                "",
            ]
            .join("\n"),
        )
        .expect("known hosts should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![
                DiscoveredSshHost {
                    alias: "bastion.example.com".to_string(),
                    hostname: "bastion.example.com".to_string(),
                    username: None,
                    port: None,
                    source: "known-hosts",
                },
                DiscoveredSshHost {
                    alias: "devbox".to_string(),
                    hostname: "devbox".to_string(),
                    username: None,
                    port: None,
                    source: "ssh-config",
                },
                DiscoveredSshHost {
                    alias: "equalsbox".to_string(),
                    hostname: "equalsbox".to_string(),
                    username: None,
                    port: None,
                    source: "ssh-config",
                },
                DiscoveredSshHost {
                    alias: "known.example.com".to_string(),
                    hostname: "known.example.com".to_string(),
                    username: None,
                    port: None,
                    source: "known-hosts",
                },
                DiscoveredSshHost {
                    alias: "staging".to_string(),
                    hostname: "staging".to_string(),
                    username: None,
                    port: None,
                    source: "ssh-config",
                },
            ]
        );

        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn discovers_ssh_config_hosts_from_quoted_include_paths() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config dir");
        fs::create_dir_all(&include_dir).expect("quoted include dir should create");
        fs::write(ssh_dir.join("config"), "Include \"config dir/team.conf\"\n")
            .expect("ssh config should write");
        fs::write(include_dir.join("team.conf"), "Host quoted-include\n")
            .expect("included ssh config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "quoted-include".to_string(),
                hostname: "quoted-include".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );

        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn preserves_hashes_inside_quoted_ssh_include_paths() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config #archive");
        fs::create_dir_all(&include_dir).expect("quoted include dir should create");
        fs::write(
            ssh_dir.join("config"),
            "Include \"config #archive/team.conf\" # trailing comment\n",
        )
        .expect("ssh config should write");
        fs::write(include_dir.join("team.conf"), "Host hash-include\n")
            .expect("included ssh config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "hash-include".to_string(),
                hostname: "hash-include".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );

        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn preserves_windows_backslashes_in_quoted_include_paths() {
        assert_eq!(
            split_directive_args(
                r#"Include "C:\Users\mauro\.ssh\config dir\team.conf" # trailing comment"#,
            ),
            Ok(vec![
                "Include".to_string(),
                r"C:\Users\mauro\.ssh\config dir\team.conf".to_string(),
            ])
        );
    }

    #[test]
    fn unquoted_backslash_escaped_whitespace_stays_in_one_include_token() {
        assert_eq!(
            split_directive_args(r"Include config\ dir/*.conf"),
            Ok(vec!["Include".to_string(), "config dir/*.conf".to_string(),])
        );
    }

    #[test]
    fn escaped_hash_stays_inside_an_unquoted_include_path() {
        assert_eq!(
            split_directive_args(r"Include config\#archive\team.conf"),
            Ok(vec![
                "Include".to_string(),
                r"config#archive\team.conf".to_string(),
            ])
        );
    }

    #[test]
    fn hash_starts_comments_only_at_token_boundaries() {
        assert_eq!(split_directive_args("# full-line comment"), Ok(Vec::new()));
        assert_eq!(
            split_directive_args("Include # token-leading comment"),
            Ok(vec!["Include".to_string()])
        );
        assert_eq!(
            split_directive_args("Include config#archive.conf # trailing comment"),
            Ok(vec![
                "Include".to_string(),
                "config#archive.conf".to_string(),
            ])
        );
        assert_eq!(
            split_directive_args(r"Include \#literal.conf # trailing comment"),
            Ok(vec!["Include".to_string(), "#literal.conf".to_string()])
        );
    }

    #[cfg(windows)]
    #[test]
    fn discovers_unquoted_escaped_windows_include_globs_before_trailing_comments() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config dir");
        fs::create_dir_all(&include_dir).expect("include directory should create");
        fs::write(
            ssh_dir.join("config"),
            r"  Include config\ dir\config\#*.conf # trailing comment",
        )
        .expect("ssh config should write");
        fs::write(
            include_dir.join("config#team.conf"),
            "Host escaped-windows-glob\n",
        )
        .expect("included config should write");
        fs::write(include_dir.join("config-team.conf"), "Host ignored\n")
            .expect("non-matching config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "escaped-windows-glob".to_string(),
                hostname: "escaped-windows-glob".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );
        let _ = fs::remove_dir_all(home_dir);
    }

    #[cfg(windows)]
    #[test]
    fn discovers_windows_style_include_globs_with_whitespace_and_comments() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config dir");
        fs::create_dir_all(&include_dir).expect("include directory should create");
        fs::write(
            ssh_dir.join("config"),
            "  Include   \"config dir\\*.conf\"   # trailing comment\n",
        )
        .expect("ssh config should write");
        fs::write(include_dir.join("alpha.conf"), "Host windows-alpha\n")
            .expect("alpha config should write");
        fs::write(include_dir.join("beta.txt"), "Host ignored\n")
            .expect("non-matching config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "windows-alpha".to_string(),
                hostname: "windows-alpha".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );
        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn preserves_equals_inside_include_filenames() {
        assert_eq!(
            split_directive_args("  Include   config=name.conf   # comment"),
            Ok(vec!["Include".to_string(), "config=name.conf".to_string(),])
        );
        assert_eq!(
            split_directive_args("Include=config=name.conf # comment"),
            Ok(vec!["Include".to_string(), "config=name.conf".to_string(),])
        );
    }

    #[test]
    fn discovers_include_globs_with_equals_in_filenames() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        fs::create_dir_all(&ssh_dir).expect("ssh directory should create");
        fs::write(
            ssh_dir.join("config"),
            "  Include   config=*.conf   # trailing comment\n",
        )
        .expect("ssh config should write");
        fs::write(ssh_dir.join("config=team.conf"), "Host equals-glob\n")
            .expect("included config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "equals-glob".to_string(),
                hostname: "equals-glob".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );
        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn rejects_unterminated_ssh_config_quotes() {
        assert_eq!(
            split_directive_args(r#"Include "config dir/*.conf"#),
            Err(SshConfigLineParseError::InvalidQuotes)
        );
        assert_eq!(
            split_directive_args("Host 'unterminated"),
            Err(SshConfigLineParseError::InvalidQuotes)
        );
    }

    #[test]
    fn ignores_entire_include_line_when_any_quote_is_unterminated() {
        let home_dir = unique_temp_home();
        let ssh_dir = home_dir.join(".ssh");
        let include_dir = ssh_dir.join("config.d");
        fs::create_dir_all(&include_dir).expect("include directory should create");
        fs::write(
            ssh_dir.join("config"),
            [
                "# keep comments independent from malformed directives",
                "  Include config.d/*.conf \"unterminated#still-quoted",
                "Host direct-host",
                "",
            ]
            .join("\n"),
        )
        .expect("ssh config should write");
        fs::write(include_dir.join("leaked.conf"), "Host must-not-leak\n")
            .expect("included config should write");

        let hosts = discover_ssh_hosts(Some(home_dir.clone())).expect("hosts should discover");

        assert_eq!(
            hosts,
            vec![DiscoveredSshHost {
                alias: "direct-host".to_string(),
                hostname: "direct-host".to_string(),
                username: None,
                port: None,
                source: "ssh-config",
            }]
        );
        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn parses_known_hosts_entries_without_hashed_hosts() {
        assert_eq!(
            parse_known_hosts_hostnames(
                [
                    "github.com ssh-ed25519 AAAA",
                    "gitlab.com,gitlab-alias ssh-ed25519 BBBB",
                    "|1|hashed|entry ssh-ed25519 CCCC",
                    "@cert-authority *.example.com ssh-ed25519 DDDD",
                    "[ssh.example.com]:2200 ssh-ed25519 EEEE",
                    "port.example.com:22 ssh-ed25519 HHHH",
                    "::1 ssh-ed25519 FFFF",
                    "2001:db8::1 ssh-ed25519 GGGG",
                    "",
                ]
                .join("\n")
                .as_str(),
            ),
            BTreeSet::from([
                "::1".to_string(),
                "2001:db8::1".to_string(),
                "github.com".to_string(),
                "gitlab-alias".to_string(),
                "gitlab.com".to_string(),
                "port.example.com".to_string(),
                "ssh.example.com".to_string(),
            ])
        );
    }

    #[tokio::test]
    async fn password_prompt_request_emits_payload_and_resolves_with_password() {
        let manager = SshPasswordPromptManager::with_timeout(std::time::Duration::from_secs(30));
        let resolver = manager.clone();
        let emitted = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let emitted_for_request = emitted.clone();
        let request = SshPasswordRequest {
            destination: "example.com".to_string(),
            username: Some("alice".to_string()),
            prompt: "alice@example.com's password:".to_string(),
        };

        let task = tokio::spawn(async move {
            manager
                .request_password_with(
                    "req-1".to_string(),
                    request,
                    std::time::SystemTime::UNIX_EPOCH,
                    move |payload| {
                        emitted_for_request
                            .lock()
                            .expect("emitted mutex")
                            .push(payload);
                        Ok(())
                    },
                )
                .await
        });
        tokio::task::yield_now().await;

        assert_eq!(emitted.lock().expect("emitted mutex").len(), 1);
        assert_eq!(
            emitted.lock().expect("emitted mutex")[0],
            SshPasswordPromptPayload {
                request_id: "req-1".to_string(),
                destination: "example.com".to_string(),
                username: Some("alice".to_string()),
                prompt: "alice@example.com's password:".to_string(),
                expires_at: "1970-01-01T00:00:30Z".to_string(),
            }
        );

        assert_eq!(
            resolver.resolve(SshPasswordPromptResolution {
                request_id: "req-1".to_string(),
                password: Some("hunter2".to_string()),
            }),
            Ok(())
        );
        assert_eq!(task.await.expect("prompt task"), Ok("hunter2".to_string()));
    }

    #[tokio::test]
    async fn password_prompt_resolution_rejects_blank_or_expired_ids() {
        let manager = SshPasswordPromptManager::default();

        assert_eq!(
            manager.resolve(SshPasswordPromptResolution {
                request_id: "   ".to_string(),
                password: Some("ignored".to_string()),
            }),
            Err(SshPasswordPromptResolveError::InvalidRequestId)
        );
        assert_eq!(
            manager.resolve(SshPasswordPromptResolution {
                request_id: "missing".to_string(),
                password: None,
            }),
            Err(SshPasswordPromptResolveError::Expired {
                request_id: "missing".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn operation_cancellation_removes_the_exact_pending_password_prompt() {
        let manager = SshPasswordPromptManager::with_timeout(Duration::from_secs(30));
        let cancellation = CancellationToken::new();
        let task_manager = manager.clone();
        let task_cancellation = cancellation.clone();
        let request = tokio::spawn(async move {
            task_manager
                .request_password_with_cancellation(
                    "cancelled-operation-prompt".to_string(),
                    SshPasswordRequest {
                        destination: "dev@example.test".to_string(),
                        username: Some("dev".to_string()),
                        prompt: "Password".to_string(),
                    },
                    SystemTime::now(),
                    &task_cancellation,
                    |_| Ok(()),
                )
                .await
        });
        while manager
            .pending
            .lock()
            .expect("pending prompts")
            .get("cancelled-operation-prompt")
            .is_none()
        {
            tokio::task::yield_now().await;
        }

        cancellation.cancel();
        let error = request
            .await
            .expect("password prompt owner joins")
            .expect_err("operation cancellation cancels the prompt");
        assert!(matches!(
            error,
            SshPasswordPromptRequestError::Cancelled { .. }
        ));
        assert!(
            manager.pending.lock().expect("pending prompts").is_empty(),
            "cancelled prompt must not remain resolvable or visible",
        );
    }

    #[test]
    fn builds_external_ssh_tunnel_launch_plan_with_exact_arguments() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: Some("alice".to_string()),
            port: Some(2222),
        };

        let plan = SshEnvironmentLaunchPlan::external(target.clone(), 45123)
            .expect("launch plan should build");

        assert_eq!(plan.key, "devbox\u{0}alice\u{0}explicit:2222");
        assert_eq!(plan.program, ssh_command());
        assert_eq!(
            plan.args,
            vec![
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "-p",
                "2222",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-n",
                "-N",
                "-L",
                "127.0.0.1:45123:127.0.0.1:3773",
                "-o",
                "LogLevel=DEBUG",
                "-o",
                "FingerprintHash=sha256",
                "--",
                "alice@devbox",
            ]
        );
        assert_eq!(plan.target, target);
        assert_eq!(plan.remote_port, 3773);
        assert_eq!(plan.http_base_url, "http://127.0.0.1:45123/");
        assert_eq!(plan.ws_base_url, "ws://127.0.0.1:45123/");
    }

    #[test]
    fn detects_ssh_password_auth_failures() {
        assert!(is_ssh_auth_failure(
            "Permission denied (publickey,password,keyboard-interactive)."
        ));
        assert!(is_ssh_auth_failure("Authentication failed."));
        assert!(is_ssh_auth_failure("Too many authentication failures"));
        assert!(!is_ssh_auth_failure("Connection timed out."));
    }

    #[test]
    fn host_key_pin_comparison_fails_closed_without_weakening_openssh_policy() {
        assert!(
            validate_expected_host_key_fingerprint(
                Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
                "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            .is_ok()
        );
        assert!(
            validate_expected_host_key_fingerprint(
                Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
                "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            )
            .expect_err("changed fingerprint must fail")
            .contains("changed")
        );
        assert!(validate_expected_host_key_fingerprint(Some(" "), "SHA256:observed").is_err());
        assert!(parse_ssh_host_key_fingerprint("debug1: no fingerprint here").is_err());
    }

    #[test]
    fn command_handshake_rejects_policy_trusted_host_key_drift() {
        let expected = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let observed = "debug1: Server host key: ssh-ed25519 SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n";

        let error = validate_ssh_command_host_fingerprint(expected, observed)
            .expect_err("a fresh SSH command must not switch to another policy-trusted key");

        assert!(error.contains("changed"), "{error}");
        validate_ssh_command_host_fingerprint(
            expected,
            "debug1: Server host key: ssh-ed25519 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
        )
            .expect("the probed key should remain valid");
    }

    #[test]
    fn host_key_parser_selects_the_final_proxy_jump_destination() {
        let output = concat!(
            "debug1: Server host key: ssh-ed25519 ",
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
            "debug1: Server host key: ssh-ed25519 ",
            "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n",
        );

        assert_eq!(
            parse_ssh_host_key_fingerprint(output).expect("destination key should parse"),
            "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        );
    }

    #[test]
    fn effective_config_rejects_a_custom_known_hosts_command_before_remote_auth() {
        assert!(
            validate_effective_known_hosts_command(
                "host devbox\nknownhostscommand none\nhostname devbox.internal\n"
            )
            .is_ok()
        );
        let error = validate_effective_known_hosts_command(
            "host devbox\nknownhostscommand /usr/local/bin/lookup %H %f\n",
        )
        .expect_err("custom KnownHostsCommand composition must fail closed");
        assert!(error.contains("KnownHostsCommand"), "{error}");
        assert!(error.contains("not supported"), "{error}");
        validate_effective_known_hosts_command("host devbox\n")
            .expect("OpenSSH omits the unset default command from -G output");
    }

    #[test]
    fn effective_config_rejects_send_env_patterns_that_can_forward_private_ssh_state() {
        validate_effective_send_env("sendenv LANG\nsendenv LC_*\n")
            .expect("ordinary locale forwarding must remain supported");
        validate_effective_send_env("sendenv -BIBCODE_*\n")
            .expect("an explicit removal pattern does not forward private state");

        for unsafe_config in [
            "sendenv *\n",
            "sendenv BIBCODE_*\n",
            "sendenv BIBCODE_SSH_AUTH_* LANG\n",
            "sendenv bibcode_ssh_host_key_pin_helper\n",
        ] {
            let error = validate_effective_send_env(unsafe_config)
                .expect_err("matching SendEnv must fail before password-capable SSH");
            assert!(error.contains("SendEnv"), "{error}");
            assert!(error.contains("private SSH"), "{error}");
        }
    }

    #[test]
    fn effective_proxy_chains_allow_keys_but_reject_password_fallback() {
        for effective_config in [
            "proxyjump jump-host\n",
            "proxycommand ssh -W %h:%p jump-host\n",
        ] {
            validate_effective_proxy_password_policy(effective_config, false)
                .expect("key and agent authentication may use a configured proxy chain");
            let error = validate_effective_proxy_password_policy(effective_config, true)
                .expect_err("password-bearing SSH must not expose its secret to a proxy process");
            assert!(error.contains("ProxyJump or ProxyCommand"), "{error}");
            assert!(error.contains("key or agent authentication"), "{error}");
        }
        validate_effective_proxy_password_policy("proxyjump none\n", true)
            .expect("an explicitly disabled proxy does not inherit the password helper");
        validate_effective_proxy_password_policy("host devbox\n", true)
            .expect("direct SSH password authentication remains supported");
    }

    #[test]
    fn owned_ssh_environment_clears_ambient_private_values_before_readding_exact_state() {
        let helper = Path::new("owned-host-key-helper");
        let observation = Path::new("owned-host-key-observation");
        let environment = build_verified_ssh_child_environment(
            &SshAuthOptions::batch(),
            Path::new("owned-askpass"),
            helper,
            None,
            Some(observation),
        )
        .expect("owned environment should build");
        let mut command = Command::new("ssh-fixture");
        for name in SSH_INTERNAL_ENVIRONMENT_VARIABLES {
            command.env(name, "ambient-attacker-controlled-value");
        }

        apply_verified_ssh_child_environment(&mut command, environment);

        let command = command.as_std();
        for removed in [
            "BIBCODE_SSH_AUTH_SECRET",
            SSH_EXPECTED_HOST_KEY_FINGERPRINT_ENV,
            "SSH_ASKPASS",
            "SSH_ASKPASS_REQUIRE",
        ] {
            assert!(
                command
                    .get_envs()
                    .any(|(name, value)| name == removed && value.is_none()),
                "{removed} must be explicitly removed instead of inherited"
            );
        }
        assert!(command.get_envs().any(|(name, value)| {
            name == SSH_HOST_KEY_OBSERVATION_PATH_ENV && value == Some(observation.as_os_str())
        }));
        assert!(command.get_envs().any(|(name, value)| {
            name == SSH_HOST_KEY_PIN_HELPER_ENV && value == Some(helper.as_os_str())
        }));
    }

    #[test]
    fn host_key_pin_option_quotes_helper_paths_and_precedes_the_destination() {
        let helper = if cfg!(windows) {
            Path::new("C:\\SSH Helpers\\%TEMP% & ^ pin verifier.ps1")
        } else {
            Path::new("/tmp/SSH Helpers/%value/$()/`tick`/pin'verifier.sh")
        };
        let mut args = vec![
            "-o".to_string(),
            "BatchMode=no".to_string(),
            "--".to_string(),
            "devbox".to_string(),
        ];

        insert_ssh_host_key_pin_args(&mut args);
        let environment = build_verified_ssh_child_environment(
            &SshAuthOptions::batch(),
            Path::new("unused-askpass"),
            helper,
            Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            None,
        )
        .expect("pin helper environment should quote safely");

        let destination_guard = args
            .iter()
            .position(|argument| argument == "--")
            .expect("destination options should terminate");
        let pin_option = args[..destination_guard]
            .windows(2)
            .find(|pair| pair[0] == "-o" && pair[1].starts_with("KnownHostsCommand="))
            .expect("pin command must be an OpenSSH option before the destination");
        assert!(pin_option[1].ends_with(" %I %f"));
        assert!(pin_option[1].contains(SSH_HOST_KEY_PIN_HELPER_ENV));
        assert!(!pin_option[1].contains("SSH Helpers"));
        if !cfg!(windows) {
            assert!(pin_option[1].starts_with("KnownHostsCommand=/bin/sh "));
        }
        let isolated_helper = environment
            .get(SSH_HOST_KEY_PIN_HELPER_ENV)
            .expect("helper path must travel through a non-recursive environment expansion");
        assert_eq!(
            isolated_helper,
            helper.to_str().expect("fixture path is Unicode")
        );
        assert!(isolated_helper.contains("SSH Helpers"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pin_helper_matches_without_adding_trust_and_rejects_drift() {
        let temporary_base = tempfile::tempdir().expect("pin helper temporary base");
        let manager =
            SshEnvironmentManager::with_askpass_temp_base(temporary_base.path().to_path_buf());
        let launcher = manager
            .askpass_launcher()
            .expect("pin helper should create");
        let expected = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

        let matched = Command::new(launcher.host_key_pin_verifier_path())
            .arg("HOSTNAME")
            .arg(expected)
            .env("BIBCODE_SSH_EXPECTED_HOST_KEY_FINGERPRINT", expected)
            .output()
            .await
            .expect("matching helper should run");
        assert!(matched.status.success());
        assert!(
            matched.stdout.is_empty(),
            "matching must add no trusted host key"
        );

        let changed = Command::new(launcher.host_key_pin_verifier_path())
            .arg("HOSTNAME")
            .arg("SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
            .env("BIBCODE_SSH_EXPECTED_HOST_KEY_FINGERPRINT", expected)
            .output()
            .await
            .expect("changed helper should run");
        assert!(!changed.status.success());
        assert!(
            changed.stdout.is_empty(),
            "drift must add no trusted host key"
        );
        assert_eq!(
            String::from_utf8_lossy(&changed.stderr).trim(),
            "BIBCODE_SSH_HOST_KEY_PIN_MISMATCH"
        );

        let ordering = Command::new(launcher.host_key_pin_verifier_path())
            .arg("ORDER")
            .arg("NONE")
            .env("BIBCODE_SSH_EXPECTED_HOST_KEY_FINGERPRINT", expected)
            .output()
            .await
            .expect("host-key ordering helper should run");
        assert!(ordering.status.success());
        assert!(ordering.stdout.is_empty());

        let observation_path = launcher.root().join("unenrolled-host-key-observation.txt");
        let observed = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        let enrolled = Command::new(launcher.host_key_pin_verifier_path())
            .arg("HOSTNAME")
            .arg(observed)
            .env(SSH_HOST_KEY_OBSERVATION_PATH_ENV, &observation_path)
            .env_remove(SSH_EXPECTED_HOST_KEY_FINGERPRINT_ENV)
            .output()
            .await
            .expect("unenrolled observation helper should run");
        assert!(enrolled.status.success());
        assert!(
            enrolled.stdout.is_empty(),
            "observation must add no trusted key"
        );
        assert_eq!(
            fs::read_to_string(&observation_path)
                .expect("observation should be recorded privately")
                .trim(),
            observed
        );
    }

    #[tokio::test]
    async fn command_stderr_observer_waits_for_the_main_remote_command_marker() {
        let (mut writer, reader) = tokio::io::duplex(512);
        let (fingerprint_sender, mut fingerprint_receiver) = oneshot::channel();
        let (output_sender, output_receiver) = oneshot::channel();
        let drain = tokio::spawn(drain_ssh_command_stderr(
            reader,
            SSH_REMOTE_SCRIPT_COMMAND_MARKER.to_string(),
            fingerprint_sender,
            output_sender,
        ));
        writer
            .write_all(
                concat!(
                    "debug1: Server host key: ssh-ed25519 ",
                    "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
                    "debug1: Server host key: ssh-ed25519 ",
                    "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n",
                )
                .as_bytes(),
            )
            .await
            .expect("proxy-jump fixture should write");

        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut fingerprint_receiver)
                .await
                .is_err(),
            "a jump or destination key alone must not release command stdin"
        );
        writer
            .write_all(b"debug1: Sending command: sh -s -- state-key\n")
            .await
            .expect("main-command marker should write");
        fingerprint_receiver
            .await
            .expect("observer should report")
            .expect("main command should confirm the pre-authenticated pin");

        drop(writer);
        drain.await.expect("stderr drain should finish");
        output_receiver
            .await
            .expect("bounded output should be reported")
            .expect("stderr fixture should remain bounded");
    }

    #[tokio::test]
    async fn remote_script_gate_withholds_payload_until_pre_auth_pin_verification() {
        let script = b"touch must-not-run\n";
        let (stdin, mut remote_input) = tokio::io::duplex(128);
        let (fingerprint_sender, fingerprint_receiver) = oneshot::channel();
        let (_shutdown_sender, shutdown) = watch::channel(false);
        let gate = tokio::spawn(async move {
            let cancellation = CancellationToken::new();
            release_remote_script_after_host_key(
                stdin,
                script,
                fingerprint_receiver,
                shutdown,
                "launch",
                &cancellation,
            )
            .await
        });

        let mut byte = [0_u8; 1];
        assert!(
            tokio::time::timeout(Duration::from_millis(25), remote_input.read(&mut byte))
                .await
                .is_err(),
            "the remote script must remain withheld before host-key verification"
        );
        fingerprint_sender
            .send(Err(
                "SSH host-key fingerprint changed before authentication.".to_string(),
            ))
            .expect("fingerprint gate should remain live");
        let error = gate
            .await
            .expect("drifted gate should join")
            .expect_err("a drifted host must reject the script");
        assert!(error.contains("changed"), "{error}");
        let mut rejected = Vec::new();
        remote_input
            .read_to_end(&mut rejected)
            .await
            .expect("rejected stdin should close");
        assert!(
            rejected.is_empty(),
            "no script byte may reach a drifted host"
        );

        let (stdin, mut remote_input) = tokio::io::duplex(128);
        let (fingerprint_sender, fingerprint_receiver) = oneshot::channel();
        let (_shutdown_sender, shutdown) = watch::channel(false);
        let gate = tokio::spawn(async move {
            let cancellation = CancellationToken::new();
            release_remote_script_after_host_key(
                stdin,
                script,
                fingerprint_receiver,
                shutdown,
                "launch",
                &cancellation,
            )
            .await
        });
        fingerprint_sender
            .send(Ok(()))
            .expect("fingerprint gate should remain live");
        let mut accepted = Vec::new();
        remote_input
            .read_to_end(&mut accepted)
            .await
            .expect("accepted stdin should close");
        gate.await
            .expect("accepted gate should join")
            .expect("matching host key should release the script");
        assert_eq!(accepted, script);
    }

    #[tokio::test]
    async fn provision_remote_command_deadline_covers_a_stalled_artifact_writer() {
        let artifact = tempfile::NamedTempFile::new().expect("stalled artifact fixture");
        let bytes = vec![b'x'; 64 * 1024];
        fs::write(artifact.path(), &bytes).expect("write stalled artifact fixture");
        let (stdin, _stalled_remote_reader) = tokio::io::duplex(8);
        let (verification_sender, verification_receiver) = oneshot::channel();
        verification_sender
            .send(Ok(()))
            .expect("verification gate should remain live");
        let (_shutdown_sender, shutdown) = watch::channel(false);
        let input = RemoteStdin::Artifact {
            local_path: artifact.path().to_path_buf(),
            metadata: Vec::new(),
            expected_size: bytes.len() as u64,
        };

        let error = within_remote_command_deadline(
            Duration::from_millis(25),
            "remote Transfer",
            write_remote_command_input_after_host_key(
                stdin,
                &input,
                RemoteHostOs::Linux,
                verification_receiver,
                shutdown,
                "remote Transfer",
            ),
        )
        .await
        .expect_err("stalled artifact streaming must hit the command deadline");

        assert_eq!(error, "SSH remote Transfer command timed out.");
    }

    #[tokio::test]
    async fn tunnel_stderr_observer_reports_the_actual_handshake_then_drains() {
        let (mut writer, reader) = tokio::io::duplex(512);
        let (sender, mut receiver) = oneshot::channel();
        let auth_failure_observed = Arc::new(AtomicBool::new(false));
        let drain = tokio::spawn(drain_ssh_tunnel_stderr(
            reader,
            sender,
            auth_failure_observed,
            45123,
        ));
        writer
            .write_all(
                concat!(
                    "debug1: Server host key: ssh-ed25519 ",
                    "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
                    "debug1: Server host key: ssh-ed25519 ",
                    "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n",
                    "private-before-handshake-barrier\n",
                )
                .as_bytes(),
            )
            .await
            .expect("tunnel stderr fixture should write");

        assert!(
            tokio::time::timeout(Duration::from_millis(25), &mut receiver)
                .await
                .is_err(),
            "even buffered target-key diagnostics must wait for the main tunnel barrier"
        );
        writer
            .write_all(b"debug1: Local forwarding listening on 127.0.0.1 port 45123.\n")
            .await
            .expect("main tunnel barrier should write");

        receiver
            .await
            .expect("observer should report")
            .expect("main tunnel barrier should confirm the pre-authenticated pin");
        writer
            .write_all(b"private-after-handshake\n")
            .await
            .expect("post-handshake stderr should keep draining");
        drop(writer);
        drain.await.expect("stderr drain should finish");
    }

    #[test]
    fn remote_pairing_uses_the_current_cli_json_contract_without_http() {
        let command = remote_pairing_command();
        assert!(command.contains("--format json"));
        assert!(!command.contains("--json"));
        assert!(!command.contains("http"));
    }

    #[test]
    fn remote_pairing_preserves_one_constant_openssh_command_boundary() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.example.test".to_string(),
            username: Some("developer".to_string()),
            port: Some(2222),
        };
        let args = build_remote_script_ssh_args(&target, &SshAuthOptions::batch(), &[])
            .expect("pairing SSH arguments should build");

        assert_eq!(
            &args[args.len() - 5..],
            ["--", "developer@devbox", "sh", "-s", "--"]
        );
        assert!(!args.iter().any(|argument| argument == "-lc"));
        assert!(!remote_pairing_command().contains('\n'));
    }

    #[tokio::test]
    async fn ssh_command_output_is_bounded_before_it_reaches_memory() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let write = tokio::spawn(async move {
            let _ = writer.write_all(&[b'x'; 65]).await;
        });

        let error = read_bounded_ssh_output(reader, 64)
            .await
            .expect_err("oversize SSH output must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        write.await.expect("bounded output writer should join");
    }

    #[tokio::test]
    async fn early_tunnel_exit_bounds_and_redacts_remote_stderr() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let write = tokio::spawn(async move {
            let mut output = vec![b'x'; SSH_COMMAND_OUTPUT_LIMIT + 1];
            output[..25].copy_from_slice(b"credential=private-value\n");
            let _ = writer.write_all(&output).await;
        });

        let message = ssh_tunnel_early_exit_message("exit status: 1", Some(reader)).await;

        assert_eq!(
            message,
            "SSH tunnel exited before becoming ready with status exit status: 1."
        );
        assert!(!message.contains("private-value"));
        assert!(!message.contains("credential"));
        write
            .await
            .expect("oversize tunnel stderr writer should join");
    }

    #[tokio::test]
    async fn ssh_readiness_client_never_uses_an_http_proxy() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;
        use std::sync::mpsc;

        let target = TcpListener::bind(("127.0.0.1", 0)).expect("target fixture should bind");
        let target_address = target.local_addr().expect("target fixture address");
        let (target_sender, target_requests) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = target.accept().expect("target should accept");
            let mut request = [0_u8; 2048];
            let read = stream
                .read(&mut request)
                .expect("target request should read");
            target_sender
                .send(String::from_utf8_lossy(&request[..read]).to_string())
                .expect("target request should be observable");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .expect("target should respond");
        });

        let proxy = TcpListener::bind(("127.0.0.1", 0)).expect("proxy fixture should bind");
        let proxy_address = proxy.local_addr().expect("proxy fixture address");
        proxy
            .set_nonblocking(true)
            .expect("proxy fixture should be nonblocking");
        let (proxy_sender, proxy_requests) = mpsc::channel();
        std::thread::spawn(move || {
            for _ in 0..200 {
                match proxy.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0_u8; 2048];
                        let read = stream
                            .read(&mut request)
                            .expect("proxy request should read");
                        proxy_sender
                            .send(String::from_utf8_lossy(&request[..read]).to_string())
                            .expect("proxy request should be observable");
                        return;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("proxy fixture failed to accept: {error}"),
                }
            }
        });

        let client = build_ssh_readiness_client(
            reqwest::Client::builder().proxy(
                reqwest::Proxy::all(format!("http://{proxy_address}"))
                    .expect("explicit proxy should configure"),
            ),
        )
        .expect("SSH readiness client should build");
        client
            .get(format!("http://{target_address}{SSH_READY_PATH}"))
            .send()
            .await
            .expect("direct readiness request should succeed");

        assert!(
            target_requests
                .recv_timeout(Duration::from_secs(1))
                .expect("target should receive readiness request")
                .starts_with(&format!("GET {SSH_READY_PATH} HTTP/1.1"))
        );
        assert!(
            proxy_requests
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "SSH readiness must never use a proxy"
        );
    }

    #[test]
    fn ssh_pairing_failure_errors_never_echo_remote_stderr() {
        let message = ssh_remote_script_failure_message(
            "pairing",
            "exit status: 1",
            "credential=private-pairing-value",
        );
        assert!(message.contains("exit status: 1"));
        assert!(!message.contains("private-pairing-value"));
        assert!(!message.contains("credential"));
    }

    #[test]
    fn builds_batch_mode_args_from_auth_options() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: Some("alice".to_string()),
            port: Some(2222),
        };

        assert_eq!(
            base_ssh_args_with_auth(&target, &SshAuthOptions::batch()),
            vec![
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "-p",
                "2222",
            ]
        );
        assert_eq!(
            base_ssh_args_with_auth(&target, &SshAuthOptions::with_secret("hunter2".to_string()))
                [1],
            "BatchMode=no",
        );
    }

    #[test]
    fn trust_probe_forces_sha256_and_a_fresh_openssh_handshake() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: Some("alice".to_string()),
            port: Some(2222),
        };

        let args = build_ssh_trust_probe_args(&target, &SshAuthOptions::batch())
            .expect("trust probe arguments should build");

        assert!(
            args.windows(2)
                .any(|pair| pair == ["-o", "FingerprintHash=sha256"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-o", "ControlPath=none"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-o", "ControlMaster=no"])
        );
    }

    #[test]
    fn every_openssh_command_terminates_options_before_a_hostile_destination() {
        let target = SshEnvironmentTarget {
            alias: "-oProxyCommand=printf-pwned".to_string(),
            hostname: "host.internal".to_string(),
            username: None,
            port: Some(2222),
        };
        let expected = "-oProxyCommand=printf-pwned";
        let assert_guarded = |args: &[String]| {
            let index = args
                .iter()
                .position(|argument| argument == expected)
                .expect("hostile destination should remain a literal argument");
            assert_eq!(
                args.get(index.wrapping_sub(1)).map(String::as_str),
                Some("--")
            );
        };

        let tunnel = SshEnvironmentLaunchPlan::external(target.clone(), 45_123)
            .expect("hostile-looking destination must remain data");
        assert_guarded(&tunnel.args);
        assert_guarded(
            &build_ssh_trust_probe_args(&target, &SshAuthOptions::batch())
                .expect("trust arguments should build"),
        );
        assert_guarded(
            &build_remote_script_ssh_args(
                &target,
                &SshAuthOptions::batch(),
                &["state-key".to_string()],
            )
            .expect("launch and disconnect arguments should build"),
        );
    }

    #[test]
    fn builds_askpass_environment_for_cached_password() {
        let environment = build_ssh_child_environment(
            &SshAuthOptions::with_secret("hunter2".to_string()),
            Path::new("C:/tmp/bibcode-ssh/ssh-askpass.cmd"),
        );

        assert_eq!(
            environment
                .get("BIBCODE_SSH_AUTH_SECRET")
                .map(String::as_str),
            Some("hunter2")
        );
        assert_eq!(
            environment.get("SSH_ASKPASS_REQUIRE").map(String::as_str),
            Some("force")
        );
        assert_eq!(
            environment.get("SSH_ASKPASS").map(String::as_str),
            Some("C:/tmp/bibcode-ssh/ssh-askpass.cmd")
        );
    }

    #[test]
    fn remote_state_key_matches_typescript_manager() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: Some("alice".to_string()),
            port: Some(2222),
        };

        assert_eq!(remote_state_key(&target), "a39af6c8b8cc1930");
    }

    #[test]
    fn remote_launch_requires_the_native_bibcode_runtime() {
        for forbidden in [
            "node -",
            "command -v node",
            "command -v npm",
            "command -v npx",
            "bibcode@latest",
        ] {
            assert!(
                !REMOTE_LAUNCH_SCRIPT.contains(forbidden),
                "remote launch script must not contain {forbidden}"
            );
        }
        assert!(REMOTE_LAUNCH_SCRIPT.contains("command -v bibcode"));
        assert!(REMOTE_LAUNCH_SCRIPT.contains("native BiBCode CLI"));
        assert!(REMOTE_LAUNCH_SCRIPT.contains("--no-startup-pairing"));
        assert!(REMOTE_LAUNCH_SCRIPT.contains("umask 077"));
        assert!(REMOTE_LAUNCH_SCRIPT.contains(": > \"$LOG_FILE\""));
        assert!(REMOTE_LAUNCH_SCRIPT.contains("command -v ss"));
        assert!(REMOTE_LAUNCH_SCRIPT.contains("[ -r /proc/net/tcp ]"));
        assert!(
            REMOTE_LAUNCH_SCRIPT
                .contains("requires ss or readable Linux procfs for safe managed port selection")
        );
        assert!(!REMOTE_LAUNCH_SCRIPT.contains("tail -n"));
        assert!(
            REMOTE_LAUNCH_SCRIPT
                .find(": > \"$LOG_FILE\"")
                .expect("managed log should be scrubbed")
                < REMOTE_LAUNCH_SCRIPT
                    .find("if [ \"$REMOTE_MANAGED\" = \"managed\" ]")
                    .expect("managed reuse branch should exist"),
            "upgrades must scrub legacy pairing output before reusing a live managed server"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_port_selection_fails_closed_when_installed_ss_cannot_probe() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().expect("remote port probe fixture");
        let fake_ss = temporary.path().join("ss");
        fs::write(&fake_ss, "#!/bin/sh\nexit 64\n").expect("failing ss fixture should write");
        fs::set_permissions(&fake_ss, fs::Permissions::from_mode(0o700))
            .expect("failing ss fixture should be executable");
        let mut search_path = vec![temporary.path().to_path_buf()];
        search_path.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let search_path = std::env::join_paths(search_path).expect("fixture PATH should join");
        let launch_script = build_remote_launch_script();
        let selection_start = launch_script
            .find("port_in_use() {")
            .expect("port selection helper should exist");
        let selection_end = launch_script
            .find("REMOTE_PID=\"")
            .expect("port selection helper should end before launch state");
        let selection = &launch_script[selection_start..selection_end];
        let script = format!("PORT_FILE=\"$BIBCODE_TEST_PORT_FILE\"\n{selection}\npick_port\n");

        let output = Command::new("sh")
            .args(["-c", &script])
            .env("PATH", search_path)
            .env(
                "BIBCODE_TEST_PORT_FILE",
                temporary.path().join("missing-port-file"),
            )
            .output()
            .await
            .expect("port selection fixture should execute");

        assert!(!output.status.success());
        assert!(
            output.stdout.is_empty(),
            "a failed probe must choose no port"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("ss could not perform the required listener probe safely")
        );
    }

    #[test]
    fn remote_script_failures_never_echo_remote_stderr() {
        let message = ssh_remote_script_failure_message(
            "ensure-server",
            "exit status: 1",
            "pairingUrl=http://127.0.0.1/?pairing=private-value",
        );
        assert_eq!(
            message,
            "SSH ensure-server command failed with status exit status: 1."
        );
        assert!(!message.contains("private-value"));
        assert!(!message.contains("pairingUrl"));

        let auth = ssh_remote_script_failure_message(
            "ensure-server",
            "exit status: 255",
            "Permission denied (publickey,password). private-value",
        );
        assert!(is_ssh_auth_failure(&auth));
        assert!(!auth.contains("private-value"));

        let pairing = ssh_remote_script_failure_message(
            "pairing",
            "exit status: 255",
            "Permission denied (publickey,password). private-value",
        );
        assert!(is_ssh_auth_failure(&pairing));
        assert!(!pairing.contains("private-value"));
    }

    #[test]
    fn serializes_external_ssh_bootstrap_shape() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: None,
            port: None,
        };
        let bootstrap = SshEnvironmentBootstrap::external(
            target.clone(),
            3773,
            "http://127.0.0.1:45123/".to_string(),
            "ws://127.0.0.1:45123/".to_string(),
            "SHA256:external-host-key".to_string(),
        );

        assert_eq!(
            serde_json::to_value(&bootstrap).expect("bootstrap should serialize"),
            json!({
                "target": {
                    "alias": "devbox",
                    "hostname": "devbox.internal",
                    "username": null,
                    "port": null,
                },
                "httpBaseUrl": "http://127.0.0.1:45123/",
                "wsBaseUrl": "ws://127.0.0.1:45123/",
                "hostKeyFingerprint": "SHA256:external-host-key",
                "remotePort": 3773,
                "remoteServerKind": "external",
            })
        );
    }

    #[test]
    fn parses_remote_launch_json_from_last_non_empty_line() {
        assert_eq!(
            parse_remote_launch_result(
                "banner\n{\"remotePort\":4111,\"serverKind\":\"managed\"}\n"
            )
            .expect("launch result should parse"),
            RemoteLaunchResult {
                remote_port: 4111,
                server_kind: "managed".to_string(),
            }
        );
        assert!(parse_remote_launch_result("{\"remotePort\":0}\n").is_err());
        assert!(
            parse_remote_launch_result("{\"remotePort\":3773,\"serverKind\":\"bogus\"}\n").is_err()
        );
    }

    #[test]
    fn serializes_managed_ssh_bootstrap_shape() {
        let target = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "devbox.internal".to_string(),
            username: None,
            port: None,
        };
        let bootstrap = SshEnvironmentBootstrap::new(
            target.clone(),
            4111,
            "http://127.0.0.1:45123/".to_string(),
            "ws://127.0.0.1:45123/".to_string(),
            "SHA256:managed-host-key".to_string(),
            "managed",
        );

        assert_eq!(
            serde_json::to_value(&bootstrap).expect("bootstrap should serialize"),
            json!({
                "target": {
                    "alias": "devbox",
                    "hostname": "devbox.internal",
                    "username": null,
                    "port": null,
                },
                "httpBaseUrl": "http://127.0.0.1:45123/",
                "wsBaseUrl": "ws://127.0.0.1:45123/",
                "hostKeyFingerprint": "SHA256:managed-host-key",
                "remotePort": 4111,
                "remoteServerKind": "managed",
            })
        );
    }

    #[test]
    fn parses_remote_pairing_json_from_last_non_empty_line() {
        assert_eq!(
            parse_remote_pairing_credential(
                "warning: shell banner\n{\"credential\":\"pairing-token\"}\n"
            ),
            Ok("pairing-token".to_string())
        );
        assert!(parse_remote_pairing_credential("{\"credential\":\"\"}\n").is_err());
    }

    #[test]
    fn normalizes_targets_and_builds_managed_password_launch_plans() {
        let hostname_only = normalize_ssh_environment_target(SshEnvironmentTarget {
            alias: "  ".to_string(),
            hostname: " host.internal ".to_string(),
            username: Some("  ".to_string()),
            port: None,
        })
        .expect("hostname-only target should normalize");
        assert_eq!(hostname_only.alias, "host.internal");
        assert_eq!(hostname_only.hostname, "host.internal");
        assert_eq!(hostname_only.username, None);

        let alias_only = normalize_ssh_environment_target(SshEnvironmentTarget {
            alias: " alias ".to_string(),
            hostname: String::new(),
            username: Some(" alice ".to_string()),
            port: None,
        })
        .expect("alias-only target should normalize");
        assert_eq!(alias_only.hostname, "alias");
        assert_eq!(alias_only.username.as_deref(), Some("alice"));
        assert!(
            normalize_ssh_environment_target(SshEnvironmentTarget {
                alias: " ".to_string(),
                hostname: " ".to_string(),
                username: None,
                port: None,
            })
            .is_err()
        );

        let plan = SshEnvironmentLaunchPlan::forward_with_auth(
            alias_only,
            41000,
            RemoteLaunchResult {
                remote_port: 42000,
                server_kind: "unexpected".to_string(),
            },
            &SshAuthOptions::with_secret("secret".to_string()),
        )
        .expect("managed password plan should build");
        assert_eq!(plan.remote_server_kind, "managed");
        assert_eq!(plan.remote_port, 42000);
        assert_eq!(plan.args[1], "BatchMode=no");
        assert!(!plan.args.iter().any(|argument| argument == "-p"));
        assert_eq!(plan.args.last().map(String::as_str), Some("alice@alias"));
    }

    #[test]
    fn target_identity_matches_the_effective_open_ssh_destination_and_port_mode() {
        let configured_port = SshEnvironmentTarget {
            alias: "DevBox".to_string(),
            hostname: "ignored-one.internal".to_string(),
            username: Some("alice".to_string()),
            port: None,
        };
        let same_destination = SshEnvironmentTarget {
            alias: "devbox".to_string(),
            hostname: "ignored-two.internal".to_string(),
            username: Some("alice".to_string()),
            port: None,
        };
        let explicit_port = SshEnvironmentTarget {
            port: Some(22),
            ..same_destination.clone()
        };

        assert_eq!(
            target_connection_key(&configured_port),
            target_connection_key(&same_destination)
        );
        assert_ne!(
            target_connection_key(&configured_port),
            target_connection_key(&explicit_port)
        );
    }

    #[test]
    fn remote_output_parsers_cover_defaults_and_error_context() {
        assert_eq!(last_non_empty_line(" \n first \n\n"), Some("first"));
        assert_eq!(last_non_empty_line(" \n\t"), None);
        assert!(
            parse_remote_pairing_credential("")
                .unwrap_err()
                .contains("credential")
        );
        assert!(
            parse_remote_pairing_credential("not-json")
                .unwrap_err()
                .contains("unparseable")
        );
        assert!(
            parse_remote_pairing_credential("{\"credential\":42}")
                .unwrap_err()
                .contains("invalid credential")
        );
        assert_eq!(
            parse_remote_pairing_credential("{\"credential\":\" token \"}"),
            Ok("token".to_string())
        );

        assert!(
            parse_remote_launch_result("")
                .unwrap_err()
                .contains("remote port")
        );
        assert!(
            parse_remote_launch_result("not-json")
                .unwrap_err()
                .contains("unparseable")
        );
        assert!(
            parse_remote_launch_result("{\"remotePort\":65536}")
                .unwrap_err()
                .contains("65536")
        );
        assert_eq!(
            parse_remote_launch_result("{\"remotePort\":3773}")
                .expect("missing kind should default"),
            RemoteLaunchResult {
                remote_port: 3773,
                server_kind: "managed".to_string(),
            }
        );

        let script = build_remote_launch_script();
        assert!(!script.contains("@@"));
        assert!(script.contains(&DEFAULT_REMOTE_PORT.to_string()));
        assert!(script.contains(&REMOTE_PORT_SCAN_WINDOW.to_string()));
    }

    #[test]
    fn auth_helpers_cover_noninteractive_and_permission_denied_variants() {
        assert!(
            build_ssh_child_environment(&SshAuthOptions::batch(), Path::new("unused")).is_empty()
        );
        for mechanism in [
            "password",
            "keyboard-interactive",
            "publickey",
            "hostbased",
            "gssapi-with-mic",
        ] {
            assert!(is_ssh_auth_failure(&format!(
                "PERMISSION DENIED ({mechanism})"
            )));
        }
        assert!(!is_ssh_auth_failure("Permission denied (certificate)"));
        assert!(!is_ssh_auth_failure("Permission denied"));
    }

    #[test]
    fn askpass_file_writes_are_idempotent_and_report_invalid_parents() {
        let directory = unique_temp_home();
        fs::create_dir_all(&directory).expect("temp directory should create");
        let helper = directory.join("askpass.cmd");
        write_askpass_file(&helper, "first", None).expect("helper should write");
        write_askpass_file(&helper, "first", None).expect("matching helper should be reused");
        assert_eq!(
            fs::read_to_string(&helper).expect("helper should read"),
            "first"
        );
        write_askpass_file(&helper, "second", None).expect("changed helper should rewrite");
        assert_eq!(
            fs::read_to_string(&helper).expect("helper should read"),
            "second"
        );

        let blocking_parent = directory.join("not-a-directory");
        fs::write(&blocking_parent, "file").expect("blocking file should write");
        assert!(
            write_askpass_file(&blocking_parent.join("child"), "value", None)
                .unwrap_err()
                .contains("Failed to write SSH askpass helper")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn password_prompt_reports_presentation_cancellation_and_service_stop() {
        let request = || SshPasswordRequest {
            destination: "host".to_string(),
            username: None,
            prompt: "Password".to_string(),
        };

        let manager = SshPasswordPromptManager::with_timeout(Duration::from_secs(30));
        let presentation = manager
            .request_password_with(
                "emit-failure".to_string(),
                request(),
                UNIX_EPOCH,
                |_payload| Err("renderer unavailable".to_string()),
            )
            .await;
        assert!(matches!(
            presentation,
            Err(SshPasswordPromptRequestError::Presentation {
                operation: "send-prompt-request",
                ..
            })
        ));
        assert!(manager.remove_pending("emit-failure").is_none());

        let resolver = manager.clone();
        let cancellation = tokio::spawn(async move {
            manager
                .request_password_with("cancel".to_string(), request(), UNIX_EPOCH, |_| Ok(()))
                .await
        });
        tokio::task::yield_now().await;
        resolver
            .resolve(SshPasswordPromptResolution {
                request_id: " cancel ".to_string(),
                password: None,
            })
            .expect("prompt should cancel");
        assert!(matches!(
            cancellation.await.expect("cancellation task"),
            Err(SshPasswordPromptRequestError::Cancelled { request_id, .. }) if request_id == "cancel"
        ));

        let manager = SshPasswordPromptManager::with_timeout(Duration::from_secs(30));
        let dropper = manager.clone();
        let stopped = manager
            .request_password_with(
                "stopped".to_string(),
                request(),
                UNIX_EPOCH,
                move |payload| {
                    drop(dropper.remove_pending(&payload.request_id));
                    Ok(())
                },
            )
            .await;
        assert!(matches!(
            stopped,
            Err(SshPasswordPromptRequestError::ServiceStopped { request_id, .. }) if request_id == "stopped"
        ));
    }

    #[test]
    fn prompt_errors_and_time_formatting_keep_stable_messages() {
        let presentation = SshPasswordPromptRequestError::Presentation {
            request_id: "id".to_string(),
            destination: "host".to_string(),
            operation: "emit",
            message: "closed".to_string(),
        };
        assert_eq!(
            presentation.to_string(),
            "Failed to present SSH password prompt for host during emit: closed"
        );
        assert_eq!(
            SshPasswordPromptRequestError::TimedOut {
                request_id: "id".to_string(),
                destination: "host".to_string(),
            }
            .to_string(),
            "SSH authentication timed out for host."
        );
        assert_eq!(
            SshPasswordPromptRequestError::Cancelled {
                request_id: "id".to_string(),
                destination: "host".to_string(),
            }
            .to_string(),
            "SSH authentication cancelled for host."
        );
        assert_eq!(
            SshPasswordPromptRequestError::ServiceStopped {
                request_id: "id".to_string(),
                destination: "host".to_string(),
            }
            .to_string(),
            "SSH password prompt service stopped."
        );
        assert_eq!(
            SshPasswordPromptResolveError::InvalidRequestId.to_string(),
            "Invalid SSH password prompt id."
        );
        assert_eq!(
            SshPasswordPromptResolveError::Expired {
                request_id: "id".to_string(),
            }
            .to_string(),
            "SSH password prompt expired. Try connecting again."
        );
        assert_eq!(format_system_time(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            format_system_time(UNIX_EPOCH - Duration::from_secs(1)),
            "1970-01-01T00:00:00Z"
        );
    }

    #[test]
    fn ssh_config_helpers_cover_quotes_assignments_paths_and_wildcards() {
        assert_eq!(
            split_directive_args(" Host foo # comment "),
            Ok(vec!["Host".to_string(), "foo".to_string()])
        );
        assert_eq!(
            split_directive_args("Include \"config #archive/file\" # comment"),
            Ok(vec![
                "Include".to_string(),
                "config #archive/file".to_string(),
            ])
        );
        assert_eq!(
            split_directive_args("Include=\"dir with spaces/file=name\""),
            Ok(vec![
                "Include".to_string(),
                "dir with spaces/file=name".to_string(),
            ])
        );
        assert_eq!(
            split_directive_args("Host 'one' two\\ three"),
            Ok(vec![
                "Host".to_string(),
                "one".to_string(),
                "two three".to_string(),
            ])
        );
        assert_eq!(
            split_directive_args("Host trailing\\"),
            Ok(vec!["Host".to_string(), "trailing\\".to_string()])
        );
        assert_eq!(
            split_directive_args(r#"Host "quoted\"alias""#),
            Ok(vec!["Host".to_string(), "quoted\"alias".to_string()])
        );
        assert!(
            split_directive_args("  ")
                .expect("blank directive should parse")
                .is_empty()
        );

        assert!(has_ssh_pattern("*.example.com"));
        assert!(has_ssh_pattern("host?"));
        assert!(has_ssh_pattern("!blocked"));
        assert!(!has_ssh_pattern("host"));
        assert!(wildcard_matches("*.conf", "team.conf"));
        assert!(wildcard_matches("host?", "host1"));
        assert!(!wildcard_matches("host?", "host"));
        assert!(!wildcard_matches("*.conf", "team.txt"));

        let home = unique_temp_home();
        assert_eq!(expand_home_path("~", &home), home);
        assert_eq!(expand_home_path("~/config", &home), home.join("config"));
        assert_eq!(expand_home_path("~\\config", &home), home.join("config"));
        assert_eq!(expand_home_path("plain", &home), PathBuf::from("plain"));
        assert_eq!(
            resolve_ssh_config_include_pattern("relative.conf", &home),
            home.join(".ssh").join("relative.conf")
        );
        let absolute = home.join("absolute.conf");
        assert_eq!(
            resolve_ssh_config_include_pattern(absolute.to_str().expect("utf-8 path"), &home),
            absolute
        );
    }

    #[test]
    fn config_globs_and_include_cycles_are_deterministic() {
        let home = unique_temp_home();
        let ssh_dir = home.join(".ssh");
        let include_dir = ssh_dir.join("config.d");
        fs::create_dir_all(&include_dir).expect("include directory should create");
        let alpha = include_dir.join("a.conf");
        let beta = include_dir.join("b.conf");
        fs::write(&alpha, "Host alpha\nInclude ../config\n").expect("alpha should write");
        fs::write(&beta, "Host beta\n").expect("beta should write");
        fs::write(ssh_dir.join("config"), "Include config.d/*.conf\n")
            .expect("config should write");

        assert_eq!(
            expand_glob(&alpha).expect("exact glob should resolve"),
            vec![alpha.clone()]
        );
        assert!(
            expand_glob(&include_dir.join("missing.conf"))
                .expect("missing exact path should resolve")
                .is_empty()
        );
        assert!(
            expand_glob(&ssh_dir.join("missing").join("*.conf"))
                .expect("missing glob directory should resolve")
                .is_empty()
        );
        assert_eq!(
            expand_glob(&include_dir.join("*.conf")).expect("glob should resolve"),
            vec![alpha, beta]
        );
        assert_eq!(
            collect_ssh_config_aliases_from_file(
                &ssh_dir.join("config"),
                &home,
                &mut BTreeSet::new(),
            )
            .expect("cyclic config should terminate"),
            BTreeSet::from(["alpha".to_string(), "beta".to_string()])
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn discovery_handles_empty_inputs_precedence_values_and_io_errors() {
        if let Some(home) = default_home_dir() {
            assert!(!home.as_os_str().is_empty());
        }
        assert_eq!(discover_ssh_hosts(None), Ok(Vec::new()));
        assert_eq!(discover_ssh_hosts(Some(PathBuf::new())), Ok(Vec::new()));

        let home = unique_temp_home();
        assert_eq!(discover_ssh_hosts(Some(home.clone())), Ok(Vec::new()));
        let ssh_dir = home.join(".ssh");
        fs::create_dir_all(&ssh_dir).expect("ssh directory should create");
        fs::write(ssh_dir.join("config"), "Host duplicate\n").expect("config should write");
        fs::write(
            ssh_dir.join("known_hosts"),
            "duplicate ssh-ed25519 AAAA\nknown ssh-ed25519 BBBB\n",
        )
        .expect("known hosts should write");
        let hosts = discover_ssh_hosts(Some(home.clone())).expect("hosts should discover");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].alias, "duplicate");
        assert_eq!(hosts[0].source, "ssh-config");
        assert_eq!(
            hosts[0].to_value(),
            json!({
                "alias": "duplicate",
                "hostname": "duplicate",
                "username": null,
                "port": null,
                "source": "ssh-config",
            })
        );
        let _ = fs::remove_dir_all(&home);

        let config_error_home = unique_temp_home();
        fs::create_dir_all(config_error_home.join(".ssh").join("config"))
            .expect("config directory should create");
        assert!(
            discover_ssh_hosts(Some(config_error_home.clone()))
                .unwrap_err()
                .contains("Failed to read SSH config hosts")
        );
        let _ = fs::remove_dir_all(config_error_home);

        let known_hosts_error_home = unique_temp_home();
        let ssh_dir = known_hosts_error_home.join(".ssh");
        fs::create_dir_all(ssh_dir.join("known_hosts"))
            .expect("known hosts directory should create");
        assert!(
            discover_ssh_hosts(Some(known_hosts_error_home.clone()))
                .unwrap_err()
                .contains("Failed to read known SSH hosts")
        );
        let _ = fs::remove_dir_all(known_hosts_error_home);
    }

    #[test]
    fn known_hosts_parser_covers_markers_patterns_and_host_normalization() {
        assert_eq!(normalize_known_hosts_hostname("[host]:2222"), "host");
        assert_eq!(normalize_known_hosts_hostname("host:22"), "host");
        assert_eq!(normalize_known_hosts_hostname("2001:db8::1"), "2001:db8::1");
        assert_eq!(normalize_known_hosts_hostname("[incomplete"), "[incomplete");
        assert_eq!(
            parse_known_hosts_hostnames(
                "# comment\n@revoked revoked.example ssh-ed25519 AAAA\n*.wild ssh-ed25519 BBBB\n!blocked ssh-ed25519 CCCC\n@marker\n"
            ),
            BTreeSet::from(["revoked.example".to_string()])
        );
        let missing = unique_temp_home().join("known_hosts");
        assert_eq!(
            read_known_hosts_hostnames(&missing).expect("missing known hosts should be empty"),
            BTreeSet::new()
        );
    }
}
