use bibcode_server::process::configure_background_command;
use serde::Serialize;
use std::{
    ffi::OsString,
    future::Future,
    io,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

pub const WSL_DISCOVERY_CHANGED_EVENT: &str = "desktop:wsl-discovery-changed";

const WSL_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const WSL_DISCOVERY_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const WSL_RECONCILE_MINIMUM_INTERVAL: Duration = Duration::from_secs(60);
const WSL_RECONCILE_STABLE_INTERVAL: Duration = Duration::from_secs(5 * 60);
const WSL_RECONCILE_FAILURE_INTERVAL: Duration = Duration::from_secs(15 * 60);
const MAX_DISCOVERY_DETAIL_CHARS: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WslDistroState {
    Running,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    pub is_default: bool,
    pub state: WslDistroState,
    pub version: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WslDiscoveryHealth {
    Available,
    Disabled,
    Missing,
    TimedOut,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDiscoverySnapshot {
    pub generation: u64,
    pub observed_at: String,
    pub health: WslDiscoveryHealth,
    pub detail: Option<String>,
    pub distros: Vec<WslDistro>,
}

#[derive(Clone, Copy, Debug)]
struct WslCommandLimits {
    timeout: Duration,
    max_output_bytes: usize,
}

impl Default for WslCommandLimits {
    fn default() -> Self {
        Self {
            timeout: WSL_DISCOVERY_TIMEOUT,
            max_output_bytes: WSL_DISCOVERY_MAX_OUTPUT_BYTES,
        }
    }
}

#[derive(Clone, Debug)]
struct WslCommandSpec {
    program: PathBuf,
    args: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
}

impl WslCommandSpec {
    fn system() -> Self {
        Self {
            program: PathBuf::from("wsl.exe"),
            args: vec![OsString::from("--list"), OsString::from("--verbose")],
            environment: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RawWslCommandOutput {
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum WslCommandError {
    Missing,
    TimedOut,
    OutputLimitExceeded,
    Cancelled,
    Failed(String),
}

type WslRunnerFuture<'a> =
    Pin<Box<dyn Future<Output = Result<RawWslCommandOutput, WslCommandError>> + Send + 'a>>;

trait WslDiscoveryRunner: Send + Sync {
    fn run<'a>(&'a self, cancellation: &'a CancellationToken) -> WslRunnerFuture<'a>;
}

struct ProcessWslDiscoveryRunner {
    spec: WslCommandSpec,
    limits: WslCommandLimits,
}

impl ProcessWslDiscoveryRunner {
    fn system() -> Self {
        Self::new(WslCommandSpec::system(), WslCommandLimits::default())
    }

    fn new(spec: WslCommandSpec, limits: WslCommandLimits) -> Self {
        Self { spec, limits }
    }
}

impl WslDiscoveryRunner for ProcessWslDiscoveryRunner {
    fn run<'a>(&'a self, cancellation: &'a CancellationToken) -> WslRunnerFuture<'a> {
        Box::pin(run_bounded_command(&self.spec, self.limits, cancellation))
    }
}

async fn read_bounded<R>(
    mut reader: R,
    total: Arc<AtomicUsize>,
    max_output_bytes: usize,
    overflow: CancellationToken,
) -> io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(output);
        }
        let previous = total.fetch_add(read, Ordering::AcqRel);
        if previous.saturating_add(read) > max_output_bytes {
            overflow.cancel();
            return Err(io::Error::other("WSL discovery output limit exceeded"));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

async fn terminate_and_reap(child: &mut Child) {
    if let Err(error) = child.kill().await
        && error.kind() != io::ErrorKind::InvalidInput
    {
        tracing::debug!("failed to terminate WSL discovery child: {error}");
    }
}

async fn read_task_output(
    task: tokio::task::JoinHandle<io::Result<Vec<u8>>>,
    overflow: &CancellationToken,
) -> Result<Vec<u8>, WslCommandError> {
    match task.await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) if overflow.is_cancelled() => {
            let _ = error;
            Err(WslCommandError::OutputLimitExceeded)
        }
        Ok(Err(error)) => Err(WslCommandError::Failed(format!(
            "Could not read WSL discovery output: {error}"
        ))),
        Err(error) => Err(WslCommandError::Failed(format!(
            "WSL discovery output task failed: {error}"
        ))),
    }
}

async fn abort_read_tasks(
    stdout_task: tokio::task::JoinHandle<io::Result<Vec<u8>>>,
    stderr_task: tokio::task::JoinHandle<io::Result<Vec<u8>>>,
) {
    stdout_task.abort();
    stderr_task.abort();
    let _ = tokio::join!(stdout_task, stderr_task);
}

async fn run_bounded_command(
    spec: &WslCommandSpec,
    limits: WslCommandLimits,
    cancellation: &CancellationToken,
) -> Result<RawWslCommandOutput, WslCommandError> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .envs(spec.environment.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_background_command(&mut command);

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            WslCommandError::Missing
        } else {
            WslCommandError::Failed(format!("Could not start WSL discovery: {error}"))
        }
    })?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        terminate_and_reap(&mut child).await;
        return Err(WslCommandError::Failed(
            "WSL discovery output was not captured.".to_string(),
        ));
    };

    let total = Arc::new(AtomicUsize::new(0));
    let overflow = CancellationToken::new();
    let stdout_task = tokio::spawn(read_bounded(
        stdout,
        total.clone(),
        limits.max_output_bytes,
        overflow.clone(),
    ));
    let stderr_task = tokio::spawn(read_bounded(
        stderr,
        total,
        limits.max_output_bytes,
        overflow.clone(),
    ));

    enum WaitOutcome {
        Exited(io::Result<std::process::ExitStatus>),
        Cancelled,
        OutputLimitExceeded,
        TimedOut,
    }
    let wait_outcome = tokio::select! {
        result = child.wait() => WaitOutcome::Exited(result),
        () = cancellation.cancelled() => WaitOutcome::Cancelled,
        () = overflow.cancelled() => WaitOutcome::OutputLimitExceeded,
        () = tokio::time::sleep(limits.timeout) => WaitOutcome::TimedOut,
    };
    let status = match wait_outcome {
        WaitOutcome::Exited(Ok(status)) => status,
        WaitOutcome::Exited(Err(error)) => {
            terminate_and_reap(&mut child).await;
            abort_read_tasks(stdout_task, stderr_task).await;
            return Err(WslCommandError::Failed(format!(
                "Could not wait for WSL discovery: {error}"
            )));
        }
        WaitOutcome::Cancelled => {
            terminate_and_reap(&mut child).await;
            abort_read_tasks(stdout_task, stderr_task).await;
            return Err(WslCommandError::Cancelled);
        }
        WaitOutcome::OutputLimitExceeded => {
            terminate_and_reap(&mut child).await;
            abort_read_tasks(stdout_task, stderr_task).await;
            return Err(WslCommandError::OutputLimitExceeded);
        }
        WaitOutcome::TimedOut => {
            terminate_and_reap(&mut child).await;
            abort_read_tasks(stdout_task, stderr_task).await;
            return Err(WslCommandError::TimedOut);
        }
    };

    let (stdout, stderr) = tokio::join!(
        read_task_output(stdout_task, &overflow),
        read_task_output(stderr_task, &overflow),
    );
    Ok(RawWslCommandOutput {
        exit_code: status.code(),
        stdout: stdout?,
        stderr: stderr?,
    })
}

fn decode_wsl_output(bytes: &[u8]) -> String {
    let has_utf16_bom = bytes.starts_with(&[0xff, 0xfe]);
    let body = if has_utf16_bom { &bytes[2..] } else { bytes };
    let (pairs, _) = body.as_chunks::<2>();
    let pair_count = pairs.len();
    let odd_zero_count = pairs.iter().filter(|pair| pair[1] == 0).count();
    let likely_utf16_le =
        has_utf16_bom || (pair_count >= 2 && odd_zero_count.saturating_mul(2) >= pair_count);

    if likely_utf16_le {
        let code_units = pairs
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&code_units)
            .trim_start_matches('\u{feff}')
            .to_string()
    } else {
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string()
    }
}

pub(crate) fn parse_wsl_verbose(bytes: &[u8]) -> Vec<WslDistro> {
    decode_wsl_output(bytes)
        .lines()
        .filter_map(|line| {
            let raw = line.trim();
            if raw.is_empty() {
                return None;
            }
            let is_default = raw.starts_with('*');
            let cleaned = raw.trim_start_matches('*').trim();
            let fields = cleaned.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 3 {
                return None;
            }
            let version = match fields.last().copied() {
                Some("1") => 1,
                Some("2") => 2,
                _ => return None,
            };
            let state = match fields[fields.len() - 2].to_ascii_lowercase().as_str() {
                "running" => WslDistroState::Running,
                "stopped" => WslDistroState::Stopped,
                _ => return None,
            };
            let name = fields[..fields.len() - 2].join(" ");
            if name.is_empty() {
                return None;
            }
            Some(WslDistro {
                name,
                is_default,
                state,
                version,
            })
        })
        .collect()
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn bounded_detail(detail: impl AsRef<str>) -> Option<String> {
    let normalized = detail
        .as_ref()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(
            normalized
                .chars()
                .take(MAX_DISCOVERY_DETAIL_CHARS)
                .collect(),
        )
    }
}

fn disabled_feature_detail(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("wsl_e_wsl_optional_component_required")
        || detail.contains("windows subsystem for linux optional component is not enabled")
        || detail.contains("windows subsystem for linux has not been enabled")
}

fn lock_read<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn lock_write<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Clone)]
pub(crate) struct WslDiscoveryService {
    generation: Arc<AtomicU64>,
    refresh_gate: Arc<Mutex<()>>,
    last_good: Arc<RwLock<Option<WslDiscoverySnapshot>>>,
    current: Arc<RwLock<Option<WslDiscoverySnapshot>>>,
    cancellation: CancellationToken,
    runner: Arc<dyn WslDiscoveryRunner>,
}

impl Default for WslDiscoveryService {
    fn default() -> Self {
        Self::new()
    }
}

impl WslDiscoveryService {
    pub(crate) fn new() -> Self {
        Self::with_runner(Arc::new(ProcessWslDiscoveryRunner::system()))
    }

    fn with_runner(runner: Arc<dyn WslDiscoveryRunner>) -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
            refresh_gate: Arc::new(Mutex::new(())),
            last_good: Arc::new(RwLock::new(None)),
            current: Arc::new(RwLock::new(None)),
            cancellation: CancellationToken::new(),
            runner,
        }
    }

    pub(crate) fn shutdown(&self) {
        self.cancellation.cancel();
    }

    fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub(crate) fn snapshot(&self) -> WslDiscoverySnapshot {
        lock_read(&self.current)
            .clone()
            .unwrap_or_else(|| WslDiscoverySnapshot {
                generation: self.generation.load(Ordering::Acquire),
                observed_at: now_rfc3339(),
                health: WslDiscoveryHealth::Missing,
                detail: Some("WSL discovery has not completed.".to_string()),
                distros: lock_read(&self.last_good)
                    .as_ref()
                    .map(|snapshot| snapshot.distros.clone())
                    .unwrap_or_default(),
            })
    }

    pub(crate) fn last_good_distros(&self) -> Vec<WslDistro> {
        lock_read(&self.last_good)
            .as_ref()
            .map(|snapshot| snapshot.distros.clone())
            .unwrap_or_default()
    }

    fn snapshot_from_result(
        &self,
        generation: u64,
        result: Result<RawWslCommandOutput, WslCommandError>,
    ) -> WslDiscoverySnapshot {
        let last_good_distros = self.last_good_distros();
        let (health, detail, distros) = match result {
            Ok(output) if output.exit_code == Some(0) => (
                WslDiscoveryHealth::Available,
                None,
                parse_wsl_verbose(&output.stdout),
            ),
            Ok(output) => {
                let stderr = decode_wsl_output(&output.stderr);
                let stdout = decode_wsl_output(&output.stdout);
                let command_detail = if stderr.trim().is_empty() {
                    stdout
                } else {
                    stderr
                };
                if disabled_feature_detail(&command_detail) {
                    (
                        WslDiscoveryHealth::Disabled,
                        bounded_detail(command_detail),
                        last_good_distros,
                    )
                } else {
                    let status = output.exit_code.map_or_else(
                        || "without an exit code".to_string(),
                        |code| code.to_string(),
                    );
                    (
                        WslDiscoveryHealth::Failed,
                        bounded_detail(format!(
                            "wsl.exe --list --verbose exited with status {status}: {command_detail}"
                        )),
                        last_good_distros,
                    )
                }
            }
            Err(WslCommandError::Missing) => (
                WslDiscoveryHealth::Missing,
                Some("wsl.exe was not found on this computer.".to_string()),
                last_good_distros,
            ),
            Err(WslCommandError::TimedOut) => (
                WslDiscoveryHealth::TimedOut,
                Some("WSL discovery exceeded its 10-second deadline.".to_string()),
                last_good_distros,
            ),
            Err(WslCommandError::OutputLimitExceeded) => (
                WslDiscoveryHealth::Failed,
                Some("WSL discovery exceeded its combined output limit.".to_string()),
                last_good_distros,
            ),
            Err(WslCommandError::Failed(detail)) => (
                WslDiscoveryHealth::Failed,
                bounded_detail(detail),
                last_good_distros,
            ),
            Err(WslCommandError::Cancelled) => unreachable!("cancellation is handled by refresh"),
        };
        WslDiscoverySnapshot {
            generation,
            observed_at: now_rfc3339(),
            health,
            detail,
            distros,
        }
    }

    async fn refresh(&self) -> Option<WslDiscoverySnapshot> {
        if self.cancellation.is_cancelled() {
            return None;
        }
        let requested_generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let _guard = tokio::select! {
            () = self.cancellation.cancelled() => return None,
            guard = self.refresh_gate.lock() => guard,
        };
        if requested_generation != self.generation.load(Ordering::Acquire) {
            return None;
        }

        let result = self.runner.run(&self.cancellation).await;
        if matches!(result, Err(WslCommandError::Cancelled))
            || requested_generation != self.generation.load(Ordering::Acquire)
        {
            return None;
        }
        let snapshot = self.snapshot_from_result(requested_generation, result);
        if snapshot.health == WslDiscoveryHealth::Available {
            *lock_write(&self.last_good) = Some(snapshot.clone());
        }
        *lock_write(&self.current) = Some(snapshot.clone());
        Some(snapshot)
    }

    pub(crate) async fn refresh_and_emit<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        reason: &'static str,
    ) -> Option<WslDiscoverySnapshot> {
        let snapshot = self.refresh().await?;
        if let Err(error) = app.emit(WSL_DISCOVERY_CHANGED_EVENT, snapshot.clone()) {
            tracing::debug!("failed to emit WSL discovery after {reason}: {error}");
        }
        Some(snapshot)
    }

    #[cfg(test)]
    fn snapshot_for_test(
        &self,
        generation: u64,
        health: WslDiscoveryHealth,
        distros: Vec<WslDistro>,
    ) -> WslDiscoverySnapshot {
        WslDiscoverySnapshot {
            generation,
            observed_at: "2026-08-25T00:00:00Z".to_string(),
            health,
            detail: None,
            distros,
        }
    }
}

#[derive(Default)]
struct ReconciliationSchedule {
    previous_available_distros: Option<Vec<WslDistro>>,
    consecutive_failures: u8,
}

impl ReconciliationSchedule {
    fn observe(&mut self, snapshot: &WslDiscoverySnapshot) -> Duration {
        if snapshot.health == WslDiscoveryHealth::Available {
            let stable = self
                .previous_available_distros
                .as_ref()
                .is_some_and(|previous| previous == &snapshot.distros);
            self.previous_available_distros = Some(snapshot.distros.clone());
            self.consecutive_failures = 0;
            if stable {
                WSL_RECONCILE_STABLE_INTERVAL
            } else {
                WSL_RECONCILE_MINIMUM_INTERVAL
            }
        } else {
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            if self.consecutive_failures >= 2 {
                WSL_RECONCILE_FAILURE_INTERVAL
            } else {
                WSL_RECONCILE_MINIMUM_INTERVAL
            }
        }
    }
}

pub(crate) fn request_refresh<R: Runtime>(app: AppHandle<R>, reason: &'static str) {
    let service = app.state::<WslDiscoveryService>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let _ = service.refresh_and_emit(&app, reason).await;
    });
}

pub(crate) fn start_reconciliation<R: Runtime>(app: AppHandle<R>) {
    let service = app.state::<WslDiscoveryService>().inner().clone();
    let cancellation = service.cancellation();
    tauri::async_runtime::spawn(async move {
        let mut delay = WSL_RECONCILE_MINIMUM_INTERVAL;
        let mut schedule = ReconciliationSchedule::default();
        loop {
            tokio::select! {
                () = cancellation.cancelled() => return,
                () = tokio::time::sleep(delay) => {}
            }
            if let Some(snapshot) = service.refresh_and_emit(&app, "reconciliation").await {
                delay = schedule.observe(&snapshot);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        ffi::OsString,
        io::Write,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use tokio_util::sync::CancellationToken;

    use super::{
        RawWslCommandOutput, ReconciliationSchedule, WslCommandError, WslCommandLimits,
        WslCommandSpec, WslDiscoveryHealth, WslDiscoveryRunner, WslDiscoveryService, WslDistro,
        WslDistroState, WslRunnerFuture, parse_wsl_verbose,
    };

    fn distro(name: &str, is_default: bool, state: WslDistroState, version: u8) -> WslDistro {
        WslDistro {
            name: name.to_string(),
            is_default,
            state,
            version,
        }
    }

    fn utf16_le(text: &str, with_bom: bool) -> Vec<u8> {
        let mut bytes = if with_bom {
            vec![0xff, 0xfe]
        } else {
            Vec::new()
        };
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        bytes
    }

    #[test]
    fn parses_state_aware_utf8_rows_with_names_containing_spaces() {
        let output = b"  NAME                   STATE           VERSION\r\n* Ubuntu-24.04           Running         2\r\n  Debian Test            Stopped         1\r\n";

        assert_eq!(
            parse_wsl_verbose(output),
            vec![
                distro("Ubuntu-24.04", true, WslDistroState::Running, 2),
                distro("Debian Test", false, WslDistroState::Stopped, 1),
            ]
        );
    }

    #[test]
    fn parses_utf16_le_with_or_without_a_bom_and_unicode_whitespace() {
        let text = "NAME STATE VERSION\r\n* Ubuntu\u{2003}Running\u{2003}2\r\n  Fedora Silverblue\tStopped\t2\r\n";
        let expected = vec![
            distro("Ubuntu", true, WslDistroState::Running, 2),
            distro("Fedora Silverblue", false, WslDistroState::Stopped, 2),
        ];

        assert_eq!(parse_wsl_verbose(&utf16_le(text, true)), expected);
        assert_eq!(parse_wsl_verbose(&utf16_le(text, false)), expected);
    }

    #[test]
    fn isolates_malformed_rows_and_accepts_empty_output() {
        let output = b"NAME STATE VERSION\n\nUbuntu Running 3\nMissingFields 2\nBad Pending 2\nValid_Name Stopped 1\n";

        assert_eq!(
            parse_wsl_verbose(output),
            vec![distro("Valid_Name", false, WslDistroState::Stopped, 1)]
        );
        assert!(parse_wsl_verbose(b"").is_empty());
        assert!(parse_wsl_verbose(b"NAME STATE VERSION\r\n").is_empty());
    }

    #[derive(Clone)]
    struct ScriptedOutcome {
        delay: Duration,
        result: Result<RawWslCommandOutput, WslCommandError>,
    }

    struct ScriptedRunner {
        calls: AtomicUsize,
        outcomes: Mutex<VecDeque<ScriptedOutcome>>,
    }

    impl ScriptedRunner {
        fn new(outcomes: impl IntoIterator<Item = ScriptedOutcome>) -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                outcomes: Mutex::new(outcomes.into_iter().collect()),
            })
        }
    }

    impl WslDiscoveryRunner for ScriptedRunner {
        fn run<'a>(&'a self, cancellation: &'a CancellationToken) -> WslRunnerFuture<'a> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let outcome = self
                .outcomes
                .lock()
                .expect("scripted WSL outcomes mutex poisoned")
                .pop_front()
                .expect("a scripted WSL outcome should be available");
            Box::pin(async move {
                tokio::select! {
                    () = cancellation.cancelled() => Err(WslCommandError::Cancelled),
                    () = tokio::time::sleep(outcome.delay) => outcome.result,
                }
            })
        }
    }

    fn successful_output(stdout: &str) -> RawWslCommandOutput {
        RawWslCommandOutput {
            exit_code: Some(0),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    fn scripted_success(delay: Duration, stdout: &str) -> ScriptedOutcome {
        ScriptedOutcome {
            delay,
            result: Ok(successful_output(stdout)),
        }
    }

    fn scripted_failure(delay: Duration, error: WslCommandError) -> ScriptedOutcome {
        ScriptedOutcome {
            delay,
            result: Err(error),
        }
    }

    #[tokio::test]
    async fn transient_failures_retain_the_last_good_distribution_rows() {
        let runner = ScriptedRunner::new([
            scripted_success(
                Duration::ZERO,
                "NAME STATE VERSION\n* Ubuntu Running 2\nDebian Stopped 2\n",
            ),
            scripted_failure(
                Duration::ZERO,
                WslCommandError::Failed("temporary command failure".to_string()),
            ),
        ]);
        let service = WslDiscoveryService::with_runner(runner);

        let good = service
            .refresh()
            .await
            .expect("initial discovery should publish");
        let failed = service
            .refresh()
            .await
            .expect("failed discovery health should publish");

        assert_eq!(good.health, WslDiscoveryHealth::Available);
        assert_eq!(failed.health, WslDiscoveryHealth::Failed);
        assert_eq!(failed.distros, good.distros);
        assert_eq!(failed.generation, good.generation + 1);
    }

    #[tokio::test]
    async fn newer_generations_supersede_late_results_and_coalesce_waiters() {
        let runner = ScriptedRunner::new([
            scripted_success(
                Duration::from_millis(50),
                "NAME STATE VERSION\nOld Running 2\n",
            ),
            scripted_success(Duration::ZERO, "NAME STATE VERSION\nNewest Running 2\n"),
        ]);
        let service = Arc::new(WslDiscoveryService::with_runner(runner.clone()));

        let first_service = service.clone();
        let first = tokio::spawn(async move { first_service.refresh().await });
        tokio::time::sleep(Duration::from_millis(5)).await;

        let second_service = service.clone();
        let second = tokio::spawn(async move { second_service.refresh().await });
        let third_service = service.clone();
        let third = tokio::spawn(async move { third_service.refresh().await });

        assert!(
            first
                .await
                .expect("first refresh task should join")
                .is_none()
        );
        let second = second.await.expect("second refresh task should join");
        let third = third.await.expect("third refresh task should join");
        let published = [second, third].into_iter().flatten().collect::<Vec<_>>();

        assert_eq!(published.len(), 1);
        let newest = &published[0];
        assert_eq!(newest.generation, 3);
        assert_eq!(newest.distros[0].name, "Newest");
        assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
    }

    fn fixture_command(mode: &str, limits: WslCommandLimits) -> Arc<dyn WslDiscoveryRunner> {
        let spec = WslCommandSpec {
            program: std::env::current_exe().expect("current test executable should resolve"),
            args: vec![
                OsString::from("--exact"),
                OsString::from("wsl::tests::wsl_subprocess_fixture"),
                OsString::from("--nocapture"),
            ],
            environment: vec![(
                OsString::from("BIBCODE_WSL_TEST_FIXTURE"),
                OsString::from(mode),
            )],
        };
        Arc::new(super::ProcessWslDiscoveryRunner::new(spec, limits))
    }

    fn test_limits() -> WslCommandLimits {
        WslCommandLimits {
            timeout: Duration::from_secs(2),
            max_output_bytes: 64 * 1024,
        }
    }

    #[tokio::test]
    async fn command_failures_distinguish_missing_disabled_and_nonzero_exit() {
        let missing_spec = WslCommandSpec {
            program: std::env::temp_dir().join("bibcode-definitely-missing-wsl.exe"),
            args: Vec::new(),
            environment: Vec::new(),
        };
        let missing = WslDiscoveryService::with_runner(Arc::new(
            super::ProcessWslDiscoveryRunner::new(missing_spec, test_limits()),
        ));
        assert_eq!(
            missing
                .refresh()
                .await
                .expect("missing health should publish")
                .health,
            WslDiscoveryHealth::Missing
        );

        let disabled = WslDiscoveryService::with_runner(fixture_command("disabled", test_limits()));
        assert_eq!(
            disabled
                .refresh()
                .await
                .expect("disabled health should publish")
                .health,
            WslDiscoveryHealth::Disabled
        );

        let failed = WslDiscoveryService::with_runner(fixture_command("nonzero", test_limits()));
        assert_eq!(
            failed
                .refresh()
                .await
                .expect("failure health should publish")
                .health,
            WslDiscoveryHealth::Failed
        );
    }

    #[tokio::test]
    async fn command_execution_enforces_combined_output_cap_timeout_and_cancellation() {
        let capped_limits = WslCommandLimits {
            max_output_bytes: 1024,
            ..test_limits()
        };
        let capped = WslDiscoveryService::with_runner(fixture_command("oversized", capped_limits));
        let capped_snapshot = capped
            .refresh()
            .await
            .expect("output-limit health should publish");
        assert_eq!(capped_snapshot.health, WslDiscoveryHealth::Failed);
        assert!(
            capped_snapshot
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("output limit"))
        );

        let timeout_limits = WslCommandLimits {
            timeout: Duration::from_millis(25),
            ..test_limits()
        };
        let timed_out = WslDiscoveryService::with_runner(fixture_command("sleep", timeout_limits));
        assert_eq!(
            timed_out
                .refresh()
                .await
                .expect("timeout health should publish")
                .health,
            WslDiscoveryHealth::TimedOut
        );

        let cancelled = Arc::new(WslDiscoveryService::with_runner(fixture_command(
            "sleep",
            test_limits(),
        )));
        let refreshing = {
            let service = cancelled.clone();
            tokio::spawn(async move { service.refresh().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancelled.shutdown();
        assert!(
            refreshing
                .await
                .expect("cancelled refresh task should join")
                .is_none()
        );
    }

    #[test]
    fn reconciliation_uses_one_five_and_fifteen_minute_intervals() {
        let runner = ScriptedRunner::new([]);
        let service = WslDiscoveryService::with_runner(runner);
        let available = service.snapshot_for_test(
            1,
            WslDiscoveryHealth::Available,
            vec![distro("Ubuntu", true, WslDistroState::Running, 2)],
        );
        let changed = service.snapshot_for_test(
            2,
            WslDiscoveryHealth::Available,
            vec![distro("Debian", true, WslDistroState::Running, 2)],
        );
        let failed =
            service.snapshot_for_test(3, WslDiscoveryHealth::Failed, available.distros.clone());
        let mut schedule = ReconciliationSchedule::default();

        assert_eq!(schedule.observe(&available), Duration::from_secs(60));
        assert_eq!(schedule.observe(&available), Duration::from_secs(5 * 60));
        assert_eq!(schedule.observe(&changed), Duration::from_secs(60));
        assert_eq!(schedule.observe(&failed), Duration::from_secs(60));
        assert_eq!(schedule.observe(&failed), Duration::from_secs(15 * 60));
        assert_eq!(schedule.observe(&available), Duration::from_secs(60));
    }

    #[test]
    fn wsl_subprocess_fixture() {
        let Ok(mode) = std::env::var("BIBCODE_WSL_TEST_FIXTURE") else {
            return;
        };
        match mode.as_str() {
            "disabled" => {
                std::io::stderr()
                    .write_all(
                        b"WslRegisterDistribution failed: WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED\n",
                    )
                    .expect("disabled fixture stderr should write");
                std::process::exit(23);
            }
            "nonzero" => {
                std::io::stderr()
                    .write_all(b"fixture command failed\n")
                    .expect("failure fixture stderr should write");
                std::process::exit(24);
            }
            "oversized" => {
                std::io::stdout()
                    .write_all(&vec![b'x'; 128 * 1024])
                    .expect("oversized fixture stdout should write");
            }
            "sleep" => std::thread::sleep(Duration::from_secs(5)),
            other => panic!("unknown WSL subprocess fixture mode: {other}"),
        }
    }
}
