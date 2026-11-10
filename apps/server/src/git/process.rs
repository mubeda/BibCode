use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use thiserror::Error;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use tokio_util::task::{TaskTracker, task_tracker::TaskTrackerToken};

use crate::diagnostics::profiler::redact::redact_path;
use crate::process::supervised::{
    StopPolicy, SupervisedOverflow, SupervisedRunError, SupervisedRunOutput, SupervisedRunRequest,
    SupervisedStreamOutput, TerminationReport, TerminationReports, run_supervised_reporting,
};
use crate::process::{ChildCommand, EnvironmentInheritance, SpawnPlan};

const TRUNCATION_MARKER: &str = "\n\n[truncated]";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputPolicy {
    /// Keeps the head of an oversized stream.
    Truncate,
    Error,
    /// Keeps the last `max_output_bytes` of an oversized stream (job logs).
    Tail,
}

#[derive(Clone, Debug)]
pub struct ProcessRequest {
    pub operation: String,
    pub command: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: Vec<(OsString, OsString)>,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
    pub output_policy: OutputPolicy,
    pub append_truncation_marker: bool,
    pub allow_non_zero_exit: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessBytesOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    /// Bytes of stdout the output policy dropped (the head, under `Tail`).
    pub stdout_dropped_bytes: usize,
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("failed to spawn {command} for {operation}")]
    Spawn {
        operation: String,
        command: String,
        source: std::io::Error,
    },
    #[error("failed to access {stream} for {operation}")]
    Pipe {
        operation: String,
        stream: &'static str,
    },
    #[error("failed to read {stream} for {operation}")]
    Read {
        operation: String,
        stream: &'static str,
        source: std::io::Error,
    },
    #[error("failed to write process stdin for {operation}")]
    Stdin {
        operation: String,
        source: std::io::Error,
    },
    #[error("{operation} timed out after {timeout_ms}ms")]
    Timeout { operation: String, timeout_ms: u128 },
    #[error("{operation} was cancelled")]
    Cancelled { operation: String },
    #[error("{operation} output exceeded {max_bytes} bytes on {stream}")]
    OutputLimit {
        operation: String,
        stream: &'static str,
        max_bytes: usize,
        observed_bytes: usize,
    },
    #[error("{operation} exited with code {exit_code}")]
    NonZeroExit {
        operation: String,
        exit_code: i32,
        stdout_length: usize,
        stderr_length: usize,
        stdout: Box<str>,
        stderr: Box<str>,
    },
    #[error("{operation} completed without an exit code")]
    MissingExitCode { operation: String },
    #[error("failed to wait for {operation}")]
    Wait {
        operation: String,
        source: std::io::Error,
    },
}

/// Safe facts for user-facing errors; never contains command paths, arguments or output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProcessFailureFacts {
    kind: ProcessFailureKind,
    os_error: Option<i32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessFailureKind {
    LaunchNotFound,
    LaunchDenied,
    LaunchNotDirectory,
    LaunchInvalidInput,
    LaunchRejected,
    TimedOut(u128),
    Cancelled,
    OutputLimit,
    Exited(i32),
    Pipe,
    Read,
    Stdin,
    Wait,
    MissingExitCode,
}

impl ProcessFailureFacts {
    pub(crate) const fn timed_out(self) -> bool {
        matches!(self.kind, ProcessFailureKind::TimedOut(_))
    }

    pub(crate) fn exited(code: i32) -> Self {
        Self {
            kind: ProcessFailureKind::Exited(code),
            os_error: None,
        }
    }

    pub(crate) fn message(self, program: &'static str) -> String {
        let (reason, guidance) = match self.kind {
            ProcessFailureKind::LaunchNotFound => (
                "a required file or directory was not found",
                "Check that the executable is available to this environment and that the repository folder is accessible.",
            ),
            ProcessFailureKind::LaunchDenied => (
                "permission was denied",
                "Check executable permissions and access to the repository folder.",
            ),
            ProcessFailureKind::LaunchNotDirectory => (
                "a required path is not a directory",
                "Check that the repository folder and executable location are accessible directories.",
            ),
            ProcessFailureKind::LaunchInvalidInput => (
                "the launch input was invalid",
                "Check the executable configuration and the requested input.",
            ),
            ProcessFailureKind::LaunchRejected => (
                "the operating system rejected the launch",
                "Check the executable and access to the repository folder.",
            ),
            ProcessFailureKind::TimedOut(milliseconds) => {
                return format!(
                    "{program} timed out after {milliseconds} ms. Check the operation before retrying."
                );
            }
            ProcessFailureKind::Cancelled => return format!("{program} was cancelled."),
            ProcessFailureKind::OutputLimit => {
                return format!("{program} output exceeded its limit.");
            }
            ProcessFailureKind::Exited(code) => {
                return format!(
                    "{program} exited with status {code}. Check the repository and provider state before retrying."
                );
            }
            ProcessFailureKind::Pipe => {
                return format!("Could not access {program} process input or output.");
            }
            ProcessFailureKind::Read => {
                return format!("{program} process output could not be read.");
            }
            ProcessFailureKind::Stdin => return format!("Could not send input to {program}."),
            ProcessFailureKind::Wait => {
                return format!("Could not observe {program} process completion.");
            }
            ProcessFailureKind::MissingExitCode => {
                return format!("{program} completed without an exit status.");
            }
        };
        let os_error = self
            .os_error
            .map_or_else(String::new, |code| format!(" (OS error {code})"));
        format!("Could not start {program}: {reason}{os_error}. {guidance}")
    }
}

impl ProcessError {
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled { .. })
    }

    pub(crate) fn safe_facts(&self) -> ProcessFailureFacts {
        match self {
            Self::Spawn { source, .. } => ProcessFailureFacts {
                kind: match source.kind() {
                    std::io::ErrorKind::NotFound => ProcessFailureKind::LaunchNotFound,
                    std::io::ErrorKind::PermissionDenied => ProcessFailureKind::LaunchDenied,
                    std::io::ErrorKind::NotADirectory => ProcessFailureKind::LaunchNotDirectory,
                    std::io::ErrorKind::InvalidInput => ProcessFailureKind::LaunchInvalidInput,
                    _ => ProcessFailureKind::LaunchRejected,
                },
                os_error: source.raw_os_error(),
            },
            error => ProcessFailureFacts {
                kind: match error {
                    Self::Timeout { timeout_ms, .. } => ProcessFailureKind::TimedOut(*timeout_ms),
                    Self::Cancelled { .. } => ProcessFailureKind::Cancelled,
                    Self::OutputLimit { .. } => ProcessFailureKind::OutputLimit,
                    Self::NonZeroExit { exit_code, .. } => ProcessFailureKind::Exited(*exit_code),
                    Self::Pipe { .. } => ProcessFailureKind::Pipe,
                    Self::Read { .. } => ProcessFailureKind::Read,
                    Self::Stdin { .. } => ProcessFailureKind::Stdin,
                    Self::Wait { .. } => ProcessFailureKind::Wait,
                    Self::MissingExitCode { .. } => ProcessFailureKind::MissingExitCode,
                    Self::Spawn { .. } => unreachable!("spawn handled above"),
                },
                os_error: None,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessRunner;

impl ProcessRunner {
    pub async fn run(
        &self,
        request: ProcessRequest,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        self.run_with_environment(request, cancellation, EnvironmentInheritance::Inherit, None)
            .await
    }

    pub async fn run_bytes(
        &self,
        request: ProcessRequest,
        cancellation: &CancellationToken,
    ) -> Result<ProcessBytesOutput, ProcessError> {
        #[cfg(feature = "hermetic-test-guard")]
        let request = checked_guarded_request(request, EnvironmentInheritance::Inherit)?;
        let command_label = request.command.to_string_lossy().into_owned();
        let output = run_request(
            &request,
            EnvironmentInheritance::Inherit,
            cancellation,
            None,
        )
        .await
        .map_err(|error| map_supervised_error(error, &request, command_label))?;

        let exit_code = output
            .status
            .code()
            .ok_or_else(|| ProcessError::MissingExitCode {
                operation: request.operation.clone(),
            })?;
        let stdout_length = output.stdout.observed_bytes;
        let stderr_length = output.stderr.observed_bytes;
        let stdout_truncated = output.stdout.truncated();
        let stderr_truncated = output.stderr.truncated();
        let stdout_dropped_bytes = output.stdout.observed_bytes - output.stdout.bytes.len();
        let stdout = render_bytes(output.stdout, request.append_truncation_marker);
        let stderr = render_bytes(output.stderr, request.append_truncation_marker);
        if exit_code != 0 && !request.allow_non_zero_exit {
            return Err(ProcessError::NonZeroExit {
                operation: request.operation,
                exit_code,
                stdout_length,
                stderr_length,
                stdout: String::from_utf8_lossy(&stdout).into_owned().into(),
                stderr: String::from_utf8_lossy(&stderr).into_owned().into(),
            });
        }
        Ok(ProcessBytesOutput {
            exit_code,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            stdout_dropped_bytes,
        })
    }

    /// [`Self::run`] with nothing inherited (`env_clear`): the child gets `request.env` only.
    /// An outside agent's clone passes back an allowlist of the server's variables
    /// (`git::clone_policy`).
    pub(crate) async fn run_cleared(
        &self,
        request: ProcessRequest,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        self.run_with_environment(request, cancellation, EnvironmentInheritance::Cleared, None)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn run_with_clean_environment_for_test(
        &self,
        request: ProcessRequest,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        self.run_with_environment(request, cancellation, EnvironmentInheritance::Cleared, None)
            .await
    }

    async fn run_with_environment(
        &self,
        request: ProcessRequest,
        cancellation: &CancellationToken,
        inheritance: EnvironmentInheritance,
        reports: Option<TerminationReports>,
    ) -> Result<ProcessOutput, ProcessError> {
        #[cfg(feature = "hermetic-test-guard")]
        let request = checked_guarded_request(request, inheritance)?;
        let command_label = request.command.to_string_lossy().into_owned();
        let output = run_request(&request, inheritance, cancellation, reports)
            .await
            .map_err(|error| map_supervised_error(error, &request, command_label))?;

        let exit_code = match output.status.code() {
            Some(exit_code) => exit_code,
            None => {
                return Err(ProcessError::MissingExitCode {
                    operation: request.operation.clone(),
                });
            }
        };
        let stdout_length = output.stdout.observed_bytes;
        let stderr_length = output.stderr.observed_bytes;
        let stdout_truncated = output.stdout.truncated();
        let stderr_truncated = output.stderr.truncated();
        let stdout = render(output.stdout, request.append_truncation_marker);
        let stderr = render(output.stderr, request.append_truncation_marker);
        if exit_code != 0 && !request.allow_non_zero_exit {
            return Err(ProcessError::NonZeroExit {
                operation: request.operation,
                exit_code,
                stdout_length,
                stderr_length,
                stdout: stdout.into(),
                stderr: stderr.into(),
            });
        }
        Ok(ProcessOutput {
            exit_code,
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
        })
    }
}

#[cfg(feature = "hermetic-test-guard")]
fn checked_guarded_request(
    mut request: ProcessRequest,
    inheritance: EnvironmentInheritance,
) -> Result<ProcessRequest, ProcessError> {
    if !crate::hermetic_guard::is_guarded_program(&request.command) {
        return Ok(request);
    }
    let search_path = request
        .env
        .iter()
        .rev()
        .find(|(name, _)| {
            if cfg!(windows) {
                name.to_string_lossy().eq_ignore_ascii_case("PATH")
            } else {
                name == "PATH"
            }
        })
        .map(|(_, value)| value.clone())
        .or_else(|| {
            (inheritance == EnvironmentInheritance::Inherit)
                .then(|| std::env::var_os("PATH"))
                .flatten()
        });
    let path = crate::hermetic_guard::checked_launch_executable(
        &request.command,
        Some(&request.cwd),
        search_path.as_deref(),
    )
    .ok_or_else(|| ProcessError::Spawn {
        operation: request.operation.clone(),
        command: request.command.display().to_string(),
        source: std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "guarded executable was not found or was refused by the hermetic test guard",
        ),
    })?;
    request.command = path;
    Ok(request)
}

/// Runs the request with a bare `git` named by its path in the child's isolated `PATH`,
/// so it starts with `posix_spawn` instead of forking the whole server (#85). The run is
/// boxed: inline, the plan's two attempts make every Git caller's future large enough to
/// overflow a test thread's stack.
async fn run_request(
    request: &ProcessRequest,
    inheritance: EnvironmentInheritance,
    cancellation: &CancellationToken,
    reports: Option<TerminationReports>,
) -> Result<SupervisedRunOutput, SupervisedRunError> {
    SpawnPlan::new(&request.command, |program| {
        process_command(request, inheritance, program)
    })
    .start(
        |command| {
            Box::pin(run_supervised_reporting(
                supervised_request(request, command),
                cancellation,
                reports.clone(),
            ))
        },
        |error| match error {
            SupervisedRunError::Spawn(error) => Some(error),
            _ => None,
        },
    )
    .await
}

impl ProcessRunner {
    /// [`Self::run`] for a Git command that may write the index. `registry` admits it, its
    /// shutdown stops it, and a stop that had to be forced is followed by
    /// [`IndexLockWatch::after_forced_stop`] before the write is released (R16, R17). A write
    /// refused because shutdown closed admission fails as cancelled.
    pub(crate) async fn run_write(
        &self,
        request: ProcessRequest,
        registry: &GitWriteRegistry,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, ProcessError> {
        let Some(ticket) = registry.track() else {
            return Err(ProcessError::Cancelled {
                operation: request.operation,
            });
        };
        // shortcut: one `rev-parse` per write; cache the Git directory per worktree if writes
        // become a measured hot spot.
        let watch = if runs_git(&request.command) && takes_index_lock(&request.args) {
            self.resolve_git_dir(&request, cancellation)
                .await
                .map(|git_dir| IndexLockWatch::before_spawn(&git_dir))
        } else {
            None
        };
        let stop = ticket.cancellation.clone();
        let (reports, received) = tokio::sync::mpsc::unbounded_channel();
        // Owns the release: a dropped run still settles it in the background.
        let mut settlement = PendingSettlement(Some(WriteSettlement {
            _ticket: ticket,
            watch,
            received,
            operation: request.operation.clone(),
            cwd: request.cwd.clone(),
        }));
        let output = tokio::select! {
            output = self.run_with_environment(
                request,
                &stop,
                EnvironmentInheritance::Inherit,
                Some(reports),
            ) => output,
            () = async {
                cancellation.cancelled().await;
                stop.cancel();
                std::future::pending::<()>().await;
            } => unreachable!("the forwarding branch never completes"),
        };
        if let Some(settlement) = settlement.0.take() {
            settlement.settle_now_or_later().await;
        }
        output
    }

    /// The command's own Git directory, which for a linked worktree is
    /// `<common-dir>/worktrees/<name>`. `None` where there is none yet (`init`, `clone`).
    pub(crate) async fn resolve_git_dir(
        &self,
        request: &ProcessRequest,
        cancellation: &CancellationToken,
    ) -> Option<PathBuf> {
        let mut probe = request.clone();
        probe.operation = format!("{}.gitDir", request.operation);
        probe.args = ["rev-parse", "--absolute-git-dir"]
            .into_iter()
            .map(OsString::from)
            .collect();
        probe.stdin = None;
        probe.env.push(("GIT_OPTIONAL_LOCKS".into(), "0".into()));
        probe.allow_non_zero_exit = false;
        let output = self.run(probe, cancellation).await.ok()?;
        let git_dir = output.stdout.trim_end_matches(['\r', '\n']);
        (!git_dir.is_empty()).then(|| PathBuf::from(git_dir))
    }
}

/// What a write still owes after its process ends: the lock cleanup, then its release.
struct WriteSettlement {
    _ticket: GitWriteTicket,
    watch: Option<IndexLockWatch>,
    received: tokio::sync::mpsc::UnboundedReceiver<TerminationReport>,
    operation: String,
    cwd: PathBuf,
}

impl WriteSettlement {
    /// Awaited when the report is in; in the background while a reap is still running, so the
    /// caller gets its outcome as before. Either way a spawned task owns the cleanup and the
    /// ticket, so a caller dropped during the wait cannot release the write early.
    async fn settle_now_or_later(mut self) {
        match self.received.try_recv() {
            Ok(report) => {
                let _ = tokio::spawn(self.clean_up(report)).await;
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                tokio::spawn(self.settle());
            }
            // No process started, so there is nothing to clean up.
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {}
        }
    }

    async fn settle(mut self) {
        if let Some(report) = self.received.recv().await {
            self.clean_up(report).await;
        }
    }

    /// A stop Git honoured needs nothing: Git removed its own lock.
    async fn clean_up(self, report: TerminationReport) {
        let Some(watch) = self.watch else {
            return;
        };
        if !(report.requested && report.forced && report.exited) {
            return;
        }
        let worktree = redact_path(&self.cwd.to_string_lossy());
        let lock = watch.lock.clone();
        match watch.after_forced_stop().await {
            LockCleanup::Removed => tracing::warn!(
                operation = %self.operation,
                %worktree,
                "removed index.lock left by a Git process BiBCode had to force to stop"
            ),
            LockCleanup::RemoveFailed { kind, state } => {
                self._ticket.lock_left(lock, state, worktree.clone());
                tracing::warn!(
                    operation = %self.operation,
                    %worktree,
                    error = %kind,
                    "could not remove index.lock left by a Git process BiBCode had to force to stop"
                );
            }
            LockCleanup::NotOurs | LockCleanup::Changed => {}
        }
    }
}

/// Settles a write whose run future was dropped, on the current runtime.
struct PendingSettlement(Option<WriteSettlement>);

impl Drop for PendingSettlement {
    fn drop(&mut self) {
        if let Some(settlement) = self.0.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(settlement.settle());
        }
    }
}

/// How long a lock left by a forced stop must stay unchanged before BiBCode removes it
/// (R16, D13).
pub(crate) const LOCK_UNCHANGED_WAIT: Duration = Duration::from_secs(2);

/// What [`IndexLockWatch::after_forced_stop`] did with `index.lock`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LockCleanup {
    /// The lock existed before the process started, or there is none: not BiBCode's.
    NotOurs,
    /// The lock changed or went away during the wait: another Git process has it now.
    Changed,
    Removed,
    /// The lock stayed unchanged but deleting it failed, so it is still there. `state` is the
    /// one that passed the unchanged check.
    RemoveFailed {
        kind: std::io::ErrorKind,
        state: LockState,
    },
}

/// Whether a Git command's `index.lock` existed before the command started, so a lock its
/// forced stop leaves behind can be told apart from someone else's.
#[derive(Debug)]
pub(crate) struct IndexLockWatch {
    lock: PathBuf,
    existed: bool,
}

impl IndexLockWatch {
    /// `git_dir` is the command's own Git directory (see [`ProcessRunner::resolve_git_dir`]).
    pub(crate) fn before_spawn(git_dir: &Path) -> Self {
        let lock = git_dir.join("index.lock");
        Self {
            existed: lock.symlink_metadata().is_ok(),
            lock,
        }
    }

    /// Removes a lock that appeared during the command and stayed unchanged for
    /// [`LOCK_UNCHANGED_WAIT`]. A lock that existed before the command is never removed.
    pub(crate) async fn after_forced_stop(self) -> LockCleanup {
        if self.existed {
            return LockCleanup::NotOurs;
        }
        let Some(before) = lock_state(&self.lock) else {
            return LockCleanup::NotOurs;
        };
        tokio::time::sleep(LOCK_UNCHANGED_WAIT).await;
        if lock_state(&self.lock) != Some(before) {
            return LockCleanup::Changed;
        }
        match std::fs::remove_file(&self.lock) {
            Ok(()) => LockCleanup::Removed,
            // Gone between the check and the delete: another Git process took and released it.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => LockCleanup::Changed,
            Err(error) => LockCleanup::RemoveFailed {
                kind: error.kind(),
                state: before,
            },
        }
    }
}

/// A lock's length and modification time.
type LockState = (u64, Option<std::time::SystemTime>);

/// The lock's length and modification time, read without following a link.
fn lock_state(lock: &Path) -> Option<LockState> {
    let metadata = lock.symlink_metadata().ok()?;
    Some((metadata.len(), metadata.modified().ok()))
}

/// The Git commands that may write the index, one registry per server runtime, so shutdown
/// can stop each running write and wait until its lock cleanup is done (plan decisions P15
/// and P20).
#[derive(Clone, Debug, Default)]
pub(crate) struct GitWriteRegistry {
    state: Arc<GitWriteRegistryState>,
}

#[derive(Debug, Default)]
struct GitWriteRegistryState {
    closed: std::sync::Mutex<bool>,
    writes: TaskTracker,
    stop: CancellationToken,
    /// Leftover locks of forced writes that could not be deleted, checked again on every stop.
    locks_left: LeftLocks,
}

type LeftLocks = Arc<std::sync::Mutex<Vec<LeftLock>>>;

/// A lock BiBCode owns but could not delete: its path, its state when the delete failed, and
/// the redacted worktree a log names.
#[derive(Debug)]
struct LeftLock {
    lock: PathBuf,
    state: LockState,
    worktree: String,
}

impl LeftLock {
    /// Deletes the lock if it is still the one BiBCode left. `false` once it is gone or
    /// changed (another Git process has it now, so it is not BiBCode's to delete).
    fn still_left(&self) -> bool {
        lock_state(&self.lock) == Some(self.state)
            && std::fs::remove_file(&self.lock)
                .is_err_and(|error| error.kind() != std::io::ErrorKind::NotFound)
    }
}

/// One admitted write. Dropping it, after the write's outcome and lock cleanup, releases it.
#[derive(Debug)]
pub(crate) struct GitWriteTicket {
    _write: TaskTrackerToken,
    cancellation: CancellationToken,
    locks_left: LeftLocks,
}

impl GitWriteTicket {
    /// Records that this write's leftover `lock` in `worktree` (redacted) could not be removed.
    /// `state` is the one that passed the unchanged check: the file is not read again, because
    /// another Git process may have replaced it since.
    fn lock_left(&self, lock: PathBuf, state: LockState, worktree: String) {
        record_left_lock(
            &self.locks_left,
            LeftLock {
                lock,
                state,
                worktree,
            },
        );
    }
}

fn record_left_lock(locks: &LeftLocks, left: LeftLock) {
    locks
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(left);
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum QuiesceOutcome {
    Clean,
    /// This many writes had not finished their stop and cleanup within the limit.
    Pending(usize),
    /// Every write finished, but the leftover locks of these worktrees (redacted) are still
    /// there after one more delete.
    LocksLeft(Vec<String>),
}

impl GitWriteRegistry {
    /// Admits one write, or `None` once shutdown closed admission.
    pub(crate) fn track(&self) -> Option<GitWriteTicket> {
        let closed = self
            .state
            .closed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (!*closed).then(|| GitWriteTicket {
            _write: self.state.writes.token(),
            cancellation: self.state.stop.child_token(),
            locks_left: self.state.locks_left.clone(),
        })
    }

    pub(crate) fn close_admission(&self) {
        *self
            .state
            .closed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        self.state.writes.close();
    }

    /// Closes admission, cancels every admitted write and waits up to `limit` until each has
    /// exited and finished its lock cleanup, then checks every leftover lock again. Safe to
    /// call again: each call reports from the current files.
    pub(crate) async fn stop_all_and_wait(&self, limit: Duration) -> QuiesceOutcome {
        self.close_admission();
        self.state.stop.cancel();
        if tokio::time::timeout(limit, self.state.writes.wait())
            .await
            .is_err()
        {
            return QuiesceOutcome::Pending(self.state.writes.len());
        }
        let mut locks = self
            .state
            .locks_left
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks.retain(LeftLock::still_left);
        if locks.is_empty() {
            QuiesceOutcome::Clean
        } else {
            QuiesceOutcome::LocksLeft(locks.iter().map(|left| left.worktree.clone()).collect())
        }
    }
}

#[cfg(all(test, unix))]
impl GitWriteRegistry {
    pub(crate) fn record_left_lock_for_test(&self, lock: &Path, worktree: &Path) {
        record_left_lock(
            &self.state.locks_left,
            LeftLock {
                lock: lock.to_path_buf(),
                state: lock_state(lock).expect("the leftover lock exists"),
                worktree: redact_path(&worktree.to_string_lossy()),
            },
        );
    }
}

fn process_command(
    request: &ProcessRequest,
    inheritance: EnvironmentInheritance,
    program: &std::path::Path,
) -> Command {
    let mut command = Command::new(program);
    if inheritance == EnvironmentInheritance::Cleared {
        command.env_clear();
    }
    command
        .args(&request.args)
        .current_dir(&request.cwd)
        .envs(request.env.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::process::isolate_appimage_environment(ChildCommand::Process {
        command: command.as_std_mut(),
        inheritance,
    });
    command
}

fn supervised_request(request: &ProcessRequest, command: Command) -> SupervisedRunRequest {
    SupervisedRunRequest {
        command,
        stdin: request.stdin.clone(),
        timeout: request.timeout,
        cleanup_timeout: Duration::from_secs(2),
        max_output_bytes: request.max_output_bytes,
        overflow: match request.output_policy {
            OutputPolicy::Truncate => SupervisedOverflow::Truncate,
            OutputPolicy::Error => SupervisedOverflow::Error,
            OutputPolicy::Tail => SupervisedOverflow::Tail,
        },
        // Git removes its own `index.lock` when asked to stop (R15); other programs this
        // runner starts keep the immediate stop.
        stop_policy: if runs_git(&request.command) {
            StopPolicy::AskThenForce
        } else {
            StopPolicy::Force
        },
    }
}

fn runs_git(command: &std::path::Path) -> bool {
    command
        .file_stem()
        .is_some_and(|stem| stem.eq_ignore_ascii_case("git"))
}

/// Whether the Git command takes `index.lock` itself, so a lock its forced stop leaves can be
/// its own. A command not listed never has a lock removed, because a lock that appears while
/// it runs belongs to someone else: a leftover lock is a nuisance, a deleted foreign lock can
/// break a person's commit. `index_lock_cleanup_lists_only_commands_that_take_the_lock` checks
/// every entry against the lock events of a real Git.
fn takes_index_lock(args: &[OsString]) -> bool {
    let mut words = args.iter().map(|arg| arg.to_str().unwrap_or_default());
    let subcommand = loop {
        match words.next() {
            Some("-c" | "-C") => {
                words.next();
            }
            Some(option) if option.starts_with('-') => {}
            Some(subcommand) => break subcommand,
            None => return false,
        }
    };
    // Options end at `--`: what follows are paths, however they look.
    let rest = words.take_while(|word| *word != "--").collect::<Vec<_>>();
    let has = |flag: &str| rest.contains(&flag);
    match subcommand {
        "add" | "cherry-pick" | "commit" | "merge" | "rebase" | "restore" | "revert" | "rm" => true,
        "reset" => !has("--soft"),
        "checkout" | "switch" => checkout_takes_index_lock(&rest),
        "apply" => has("--cached"),
        "stash" => matches!(rest.first(), Some(&("push" | "apply" | "pop"))),
        // `pull` holds no lock while it fetches, which is where it waits.
        _ => false,
    }
}

/// Creating a branch with no start point leaves the index alone. Any other checkout, including
/// a new branch at a start point, merges a tree into the index under the lock.
fn checkout_takes_index_lock(options: &[&str]) -> bool {
    let (mut new_branch, mut start_point) = (false, false);
    let mut words = options.iter();
    while let Some(word) = words.next() {
        match *word {
            "-b" | "-B" | "-c" | "-C" | "--orphan" => {
                new_branch = true;
                words.next();
            }
            option if option.starts_with('-') => {}
            _ => start_point = true,
        }
    }
    !new_branch || start_point
}

/// Windows answers a missing working directory with `ERROR_DIRECTORY` ("not a directory"); it is
/// the same missing folder that Unix reports as not found.
fn missing_cwd_as_not_found(source: std::io::Error, cwd: &std::path::Path) -> std::io::Error {
    if source.kind() == std::io::ErrorKind::NotADirectory && !cwd.exists() {
        std::io::Error::new(std::io::ErrorKind::NotFound, source)
    } else {
        source
    }
}

fn map_supervised_error(
    error: SupervisedRunError,
    request: &ProcessRequest,
    command: String,
) -> ProcessError {
    let operation = request.operation.clone();
    match error {
        SupervisedRunError::Spawn(source) => ProcessError::Spawn {
            operation,
            command,
            source: missing_cwd_as_not_found(source, &request.cwd),
        },
        SupervisedRunError::Pipe { stream } => ProcessError::Pipe { operation, stream },
        SupervisedRunError::Stdin(source) => ProcessError::Stdin { operation, source },
        SupervisedRunError::Read { stream, source } => ProcessError::Read {
            operation,
            stream,
            source,
        },
        SupervisedRunError::OutputLimit {
            stream,
            max_bytes,
            observed_bytes,
        } => ProcessError::OutputLimit {
            operation,
            stream,
            max_bytes,
            observed_bytes,
        },
        SupervisedRunError::Timeout => ProcessError::Timeout {
            operation,
            timeout_ms: request.timeout.as_millis(),
        },
        SupervisedRunError::Cancelled => ProcessError::Cancelled { operation },
        SupervisedRunError::Wait(source) => ProcessError::Wait { operation, source },
    }
}

fn render(output: SupervisedStreamOutput, append_marker: bool) -> String {
    let truncated = output.truncated();
    let mut rendered = String::from_utf8_lossy(&output.bytes).into_owned();
    if truncated && append_marker {
        rendered.push_str(TRUNCATION_MARKER);
    }
    rendered
}

fn render_bytes(output: SupervisedStreamOutput, append_marker: bool) -> Vec<u8> {
    let truncated = output.truncated();
    let mut bytes = output.bytes;
    if truncated && append_marker {
        bytes.extend_from_slice(TRUNCATION_MARKER.as_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::supervised::GRACEFUL_STOP_WAIT;
    use crate::test_support::TestSandbox;
    use crate::test_support::isolated_git_config::IsolatedGitConfig;

    fn git_environment(config: &IsolatedGitConfig) -> Vec<(OsString, OsString)> {
        [
            ("GIT_CONFIG_GLOBAL", config.path().into_os_string()),
            ("GIT_CONFIG_NOSYSTEM", "1".into()),
            ("GIT_AUTHOR_NAME", "test-user".into()),
            ("GIT_AUTHOR_EMAIL", "user@example.test".into()),
            ("GIT_COMMITTER_NAME", "test-user".into()),
            ("GIT_COMMITTER_EMAIL", "user@example.test".into()),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value))
        .collect()
    }

    fn fixture_git(config: &IsolatedGitConfig, cwd: &Path, args: &[&str]) {
        let mut command = std::process::Command::new("git");
        config.apply_to_command(&mut command);
        let output = command
            .args(args)
            .current_dir(cwd)
            .envs(git_environment(config))
            .output()
            .expect("fixture Git starts");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_request(config: &IsolatedGitConfig, cwd: &Path, args: &[&str]) -> ProcessRequest {
        ProcessRequest {
            operation: "fixture-write".to_owned(),
            command: PathBuf::from("git"),
            args: args.iter().map(OsString::from).collect(),
            cwd: cwd.to_path_buf(),
            env: git_environment(config),
            stdin: None,
            timeout: Duration::from_secs(30),
            max_output_bytes: 64 * 1024,
            output_policy: OutputPolicy::Truncate,
            append_truncation_marker: false,
            allow_non_zero_exit: false,
        }
    }

    /// A `git add` that holds `index.lock` and never finishes: the clean filter of the added
    /// file marks that it started and then sleeps.
    struct HeldWrite {
        request: ProcessRequest,
        started: PathBuf,
        lock: PathBuf,
    }

    fn held_write(sandbox: &TestSandbox, config: &IsolatedGitConfig) -> HeldWrite {
        let repository = sandbox.path("repository");
        std::fs::create_dir_all(&repository).expect("repository folder");
        let started = sandbox.path("filter-started");
        fixture_git(config, &repository, &["init", "-q", "-b", "main"]);
        fixture_git(
            config,
            &repository,
            &[
                "config",
                "filter.slow.clean",
                &format!(
                    "touch '{}'; sleep 30; cat",
                    started.to_string_lossy().replace('\\', "/")
                ),
            ],
        );
        std::fs::write(repository.join(".gitattributes"), "held.txt filter=slow\n")
            .expect(".gitattributes");
        std::fs::write(repository.join("held.txt"), "held\n").expect("held.txt");
        HeldWrite {
            request: git_request(config, &repository, &["add", "--", "held.txt"]),
            started,
            lock: repository.join(".git").join("index.lock"),
        }
    }

    async fn wait_until_exists(path: &Path) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while !path.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "{} never appeared",
                path.display()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_removes_a_lock_our_forced_stop_left() {
        let git_dir = tempfile::tempdir().expect("Git directory");
        let lock = git_dir.path().join("index.lock");
        let watch = IndexLockWatch::before_spawn(git_dir.path());
        std::fs::write(&lock, "").expect("the stopped write's lock");

        assert_eq!(watch.after_forced_stop().await, LockCleanup::Removed);
        assert!(!lock.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_keeps_a_lock_that_existed_before_spawn() {
        let git_dir = tempfile::tempdir().expect("Git directory");
        let lock = git_dir.path().join("index.lock");
        std::fs::write(&lock, "").expect("someone else's lock");
        let watch = IndexLockWatch::before_spawn(git_dir.path());

        assert_eq!(watch.after_forced_stop().await, LockCleanup::NotOurs);
        assert!(lock.exists());
    }

    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_keeps_a_lock_that_changes_during_the_wait() {
        let git_dir = tempfile::tempdir().expect("Git directory");
        let lock = git_dir.path().join("index.lock");
        let watch = IndexLockWatch::before_spawn(git_dir.path());
        std::fs::write(&lock, "").expect("the stopped write's lock");

        let cleanup = tokio::spawn(watch.after_forced_stop());
        tokio::time::sleep(Duration::from_secs(1)).await;
        std::fs::write(&lock, "another Git process took it").expect("a new lock");

        assert_eq!(cleanup.await.expect("cleanup"), LockCleanup::Changed);
        assert!(lock.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn index_lock_cleanup_shutdown_stops_a_running_write_and_leaves_no_lock() {
        let sandbox = TestSandbox::new("index-lock-cleanup-shutdown");
        let config = IsolatedGitConfig::new();
        let held = held_write(&sandbox, &config);
        let registry = GitWriteRegistry::default();
        let write = tokio::spawn({
            let (registry, request) = (registry.clone(), held.request.clone());
            async move {
                ProcessRunner
                    .run_write(request, &registry, &CancellationToken::new())
                    .await
            }
        });
        wait_until_exists(&held.started).await;
        assert!(held.lock.exists(), "the write holds index.lock");

        let outcome = registry
            .stop_all_and_wait(GRACEFUL_STOP_WAIT + LOCK_UNCHANGED_WAIT + Duration::from_secs(1))
            .await;

        assert_eq!(outcome, QuiesceOutcome::Clean);
        assert!(!held.lock.exists(), "no index.lock remains");
        let result = tokio::time::timeout(Duration::from_secs(1), write)
            .await
            .expect("the write has returned")
            .expect("write task");
        assert!(
            matches!(result, Err(ProcessError::Cancelled { .. })),
            "{result:?}"
        );
    }

    /// A push never takes `index.lock`, so a lock that appears while it runs is someone else's,
    /// such as a person's `git commit` waiting for its editor. A forced stop of the push, as
    /// every stop is on Windows, must leave that lock alone.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn index_lock_cleanup_keeps_a_lock_taken_during_a_forced_push() {
        let sandbox = TestSandbox::new("index-lock-cleanup-forced-push");
        let config = IsolatedGitConfig::new();
        let repository = sandbox.path("repository");
        let remote = sandbox.path("remote.git");
        let hooks = sandbox.path("hooks");
        let started = sandbox.path("hook-started");
        let bin = sandbox.path("bin");
        for folder in [&repository, &hooks, &bin] {
            std::fs::create_dir_all(folder).expect("fixture folder");
        }
        fixture_git(
            &config,
            sandbox.root(),
            &["init", "-q", "--bare", &remote.to_string_lossy()],
        );
        fixture_git(&config, &repository, &["init", "-q", "-b", "main"]);
        fixture_git(
            &config,
            &repository,
            &["commit", "-q", "--allow-empty", "-m", "initial"],
        );
        fixture_git(
            &config,
            &repository,
            &["config", "core.hooksPath", &hooks.to_string_lossy()],
        );
        TestSandbox::write_executable(
            &hooks.join("pre-push"),
            &format!("#!/bin/sh\ntouch '{}'\nexec sleep 30\n", started.display()),
        );
        let real_git = std::process::Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .expect("locate Git");
        let real_git = String::from_utf8(real_git.stdout).expect("Git path");
        // The wrapper ignores the request to stop and outlives Git, so the stop is forced, as
        // every stop is on Windows.
        let git = bin.join("git");
        TestSandbox::write_executable(
            &git,
            &format!(
                "#!/bin/sh\ntrap '' TERM\n'{}' \"$@\"\nstatus=$?\n[ \"$1\" = push ] && exec sleep 30\nexit $status\n",
                real_git.trim()
            ),
        );
        let mut request = git_request(
            &config,
            &repository,
            &["push", "-q", &remote.to_string_lossy(), "main"],
        );
        request.command = git;
        let cancellation = CancellationToken::new();
        let registry = GitWriteRegistry::default();
        let push = tokio::spawn({
            let (cancellation, registry) = (cancellation.clone(), registry.clone());
            async move {
                ProcessRunner
                    .run_write(request, &registry, &cancellation)
                    .await
            }
        });
        wait_until_exists(&started).await;
        let lock = repository.join(".git").join("index.lock");
        std::fs::write(&lock, "").expect("a person's commit takes the lock");

        cancellation.cancel();
        let result = tokio::time::timeout(Duration::from_secs(20), push)
            .await
            .expect("the push has returned")
            .expect("push task");
        // Waits for the push's settlement, which may finish in the background.
        let settled = registry
            .stop_all_and_wait(GRACEFUL_STOP_WAIT + LOCK_UNCHANGED_WAIT + Duration::from_secs(5))
            .await;

        assert!(
            matches!(result, Err(ProcessError::Cancelled { .. })),
            "{result:?}"
        );
        assert_eq!(settled, QuiesceOutcome::Clean);
        assert!(lock.exists(), "the person's index.lock is kept");
    }

    /// Every command shape the server runs as a write, with whether a real Git took
    /// `index.lock` for it. [`takes_index_lock`] may list only commands a real Git took the
    /// lock for, and must list each `Locks` row, a shape it once misread.
    #[test]
    fn index_lock_cleanup_lists_only_commands_that_take_the_lock() {
        use notify::Watcher;
        enum Step {
            Write(&'static str, &'static str),
            Setup(&'static [&'static str]),
            /// A setup that may fail, such as a merge that stops on a conflict.
            Conflict(&'static [&'static str]),
            Watch(&'static [&'static str]),
            /// Takes the lock on every Git CI runs; listing it is checked too.
            Locks(&'static [&'static str]),
        }
        use Step::{Conflict, Locks, Setup, Watch, Write};
        let sandbox = TestSandbox::new("index-lock-cleanup-allowlist");
        let config = IsolatedGitConfig::new();
        let work = sandbox.path("work");
        let remote = sandbox.path("remote.git");
        std::fs::create_dir_all(&work).expect("work folder");
        fixture_git(
            &config,
            sandbox.root(),
            &["init", "-q", "--bare", &remote.to_string_lossy()],
        );
        fixture_git(&config, &work, &["init", "-q", "-b", "main"]);
        fixture_git(
            &config,
            &work,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        );
        let steps = [
            Write("a.txt", "1\n"),
            Setup(&["add", "a.txt"]),
            Setup(&["commit", "-q", "-m", "one"]),
            Setup(&["switch", "-q", "-c", "topic"]),
            Write("b.txt", "b\n"),
            Setup(&["add", "b.txt"]),
            Setup(&["commit", "-q", "-m", "topic"]),
            Setup(&["switch", "-q", "-c", "side", "main"]),
            Write("s.txt", "s\n"),
            Setup(&["add", "s.txt"]),
            Setup(&["commit", "-q", "-m", "side"]),
            Setup(&["switch", "-q", "main"]),
            Setup(&["push", "-q", "origin", "main", "topic"]),
            Write("a.txt", "2\n"),
            Watch(&["add", "--", "a.txt"]),
            Watch(&["--literal-pathspecs", "restore", "--staged", "--", "a.txt"]),
            Watch(&[
                "--literal-pathspecs",
                "restore",
                "--worktree",
                "--",
                "a.txt",
            ]),
            Write("a.txt", "2\n"),
            Setup(&["add", "a.txt"]),
            Watch(&["commit", "--no-edit", "-q", "-m", "two"]),
            Watch(&["reset", "--soft", "HEAD~1"]),
            Watch(&["reset", "--", "a.txt"]),
            Watch(&["stash", "push"]),
            Watch(&["stash", "list", "--format=%H"]),
            Watch(&["stash", "show", "--name-only", "stash@{0}"]),
            Watch(&["stash", "apply", "--quiet", "stash@{0}"]),
            Watch(&["--literal-pathspecs", "checkout", "HEAD", "--", "a.txt"]),
            Watch(&["stash", "pop", "--quiet"]),
            Setup(&["checkout", "HEAD", "--", "a.txt"]),
            Write("a.txt", "3\n"),
            Setup(&["stash", "push"]),
            Watch(&["stash", "drop", "stash@{0}"]),
            Watch(&["checkout", "-b", "fresh"]),
            Watch(&["switch", "main"]),
            Watch(&["switch", "-c", "fresh2"]),
            Setup(&["switch", "-q", "main"]),
            Watch(&["merge", "--no-edit", "topic"]),
            Watch(&["revert", "--no-edit", "HEAD"]),
            Watch(&["cherry-pick", "--empty=keep", "topic"]),
            Watch(&["rm", "--cached", "-r", "--ignore-unmatch", "--", "b.txt"]),
            Setup(&["reset", "-q", "--", "b.txt"]),
            Write(
                "../new.patch",
                "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n\
                 +++ b/new.txt\n@@ -0,0 +1 @@\n+new\n",
            ),
            Watch(&["apply", "--cached", "--whitespace=nowarn", "../new.patch"]),
            Setup(&["reset", "-q", "--", "new.txt"]),
            Watch(&["apply", "--whitespace=nowarn", "../new.patch"]),
            Watch(&["reset", "--mixed", "HEAD"]),
            Watch(&["-c", "rebase.backend=merge", "rebase", "main", "side"]),
            Setup(&["switch", "-q", "main"]),
            Watch(&["push", "-q", "origin", "main"]),
            Watch(&["fetch", "-q", "origin"]),
            Watch(&["pull", "--ff-only", "origin", "main"]),
            Watch(&["update-ref", "refs/heads/extra", "HEAD"]),
            Watch(&["tag", "probe-tag"]),
            Watch(&["config", "probe.key", "value"]),
            // A new branch at a start point other than HEAD, and at HEAD itself.
            Locks(&["switch", "-c", "from-topic", "topic", "--no-track"]),
            Setup(&["switch", "-q", "main"]),
            Locks(&["switch", "-c", "from-main", "main", "--no-track"]),
            Setup(&["switch", "-q", "main"]),
            Locks(&["switch", "-c", "tracked", "--track", "origin/topic"]),
            Setup(&["switch", "-q", "main"]),
            // Paths that look like options after `--`.
            Write("--soft", "soft\n"),
            Write("-b", "b\n"),
            Setup(&["add", "--", "--soft", "-b"]),
            Setup(&["commit", "-q", "-m", "dashes"]),
            Write("--soft", "soft 2\n"),
            Setup(&["add", "--", "--soft"]),
            Locks(&["reset", "--", "--soft"]),
            Write("-b", "b 2\n"),
            Locks(&["checkout", "HEAD", "--", "-b"]),
            Setup(&["checkout", "HEAD", "--", "--soft"]),
            // Conflicts to continue, skip and abort.
            Write("c.txt", "base\n"),
            Setup(&["add", "c.txt"]),
            Setup(&["commit", "-q", "-m", "base"]),
            Setup(&["tag", "base"]),
            Setup(&["switch", "-q", "-c", "theirs"]),
            Write("c.txt", "theirs\n"),
            Setup(&["commit", "-q", "-a", "-m", "theirs"]),
            Setup(&["switch", "-q", "-c", "theirs2", "base"]),
            Write("c.txt", "theirs 2\n"),
            Setup(&["commit", "-q", "-a", "-m", "theirs 2"]),
            Setup(&["switch", "-q", "-c", "replay", "base"]),
            Write("d.txt", "d\n"),
            Setup(&["add", "d.txt"]),
            Setup(&["commit", "-q", "-m", "replay"]),
            Setup(&["switch", "-q", "main"]),
            Write("c.txt", "ours\n"),
            Setup(&["commit", "-q", "-a", "-m", "ours"]),
            Setup(&["tag", "ours"]),
            Conflict(&["merge", "--no-edit", "theirs"]),
            Locks(&["merge", "--abort"]),
            Conflict(&["cherry-pick", "theirs"]),
            Locks(&["cherry-pick", "--abort"]),
            Conflict(&["cherry-pick", "theirs"]),
            Write("c.txt", "picked\n"),
            Setup(&["add", "c.txt"]),
            Locks(&["-c", "core.editor=:", "cherry-pick", "--continue"]),
            Conflict(&["revert", "--no-edit", "ours"]),
            Locks(&["revert", "--abort"]),
            Conflict(&["revert", "--no-edit", "ours"]),
            Write("c.txt", "reverted\n"),
            Setup(&["add", "c.txt"]),
            Locks(&["-c", "core.editor=:", "revert", "--continue"]),
            Setup(&["switch", "-q", "theirs"]),
            Conflict(&["-c", "rebase.backend=merge", "rebase", "main"]),
            Locks(&["-c", "rebase.backend=merge", "rebase", "--abort"]),
            Conflict(&["-c", "rebase.backend=merge", "rebase", "main"]),
            Locks(&["-c", "rebase.backend=merge", "rebase", "--skip"]),
            Setup(&["switch", "-q", "theirs2"]),
            Conflict(&["-c", "rebase.backend=merge", "rebase", "main"]),
            Write("c.txt", "rebased\n"),
            Setup(&["add", "c.txt"]),
            Locks(&[
                "-c",
                "core.editor=:",
                "-c",
                "rebase.backend=merge",
                "rebase",
                "--continue",
            ]),
            Setup(&["switch", "-q", "replay"]),
            Locks(&[
                "-c",
                "rebase.backend=merge",
                "-c",
                "sequence.editor=:",
                "rebase",
                "-i",
                "main",
            ]),
            Setup(&["switch", "-q", "main"]),
        ];
        let (events, received) = std::sync::mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    for path in event.paths {
                        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                            let _ = events.send(name.to_owned());
                        }
                    }
                }
            })
            .expect("Git directory watcher");
        watcher
            .watch(&work.join(".git"), notify::RecursiveMode::NonRecursive)
            .expect("watch the Git directory");

        let mut mismatches = Vec::new();
        for (row, step) in steps.iter().enumerate() {
            let watched = match step {
                Write(file, contents) => {
                    std::fs::write(work.join(file), contents).expect("fixture file");
                    None
                }
                Setup(args) => {
                    fixture_git(&config, &work, args);
                    None
                }
                Conflict(args) => {
                    let mut command = std::process::Command::new("git");
                    config.apply_to_command(&mut command);
                    command
                        .args(*args)
                        .current_dir(&work)
                        .envs(git_environment(&config))
                        .output()
                        .expect("fixture Git starts");
                    None
                }
                Watch(args) => {
                    fixture_git(&config, &work, args);
                    Some((args, false))
                }
                Locks(args) => {
                    fixture_git(&config, &work, args);
                    Some((args, true))
                }
            };
            // Events arrive in order, so the sentinel's event closes this step's events.
            let sentinel = format!("row-{row}-done");
            let sentinel_path = work.join(".git").join(&sentinel);
            std::fs::write(&sentinel_path, "").expect("sentinel file");
            let mut took_lock = false;
            loop {
                let name = received
                    .recv_timeout(Duration::from_secs(10))
                    .expect("the watcher reports the sentinel file");
                took_lock |= name == "index.lock";
                if name == sentinel {
                    break;
                }
            }
            std::fs::remove_file(&sentinel_path).expect("remove sentinel file");
            let Some((args, must_list)) = watched else {
                continue;
            };
            let listed = takes_index_lock(&args.iter().map(OsString::from).collect::<Vec<_>>());
            // Only a listed command that took no lock is unsafe; leaving one out is a nuisance.
            if listed && !took_lock {
                mismatches.push(format!(
                    "git {args:?} is listed, but Git took no index.lock"
                ));
            }
            if must_list && !(took_lock && listed) {
                mismatches.push(format!(
                    "git {args:?} took index.lock {took_lock}, listed {listed}"
                ));
            }
        }

        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }

    #[tokio::test]
    async fn index_lock_cleanup_resolves_the_lock_of_a_linked_worktree() {
        let sandbox = TestSandbox::new("index-lock-cleanup-linked");
        let config = IsolatedGitConfig::new();
        let main = sandbox.path("main");
        let linked = sandbox.path("linked");
        std::fs::create_dir_all(&main).expect("main worktree");
        fixture_git(&config, &main, &["init", "-q", "-b", "main"]);
        fixture_git(
            &config,
            &main,
            &["commit", "-q", "--allow-empty", "-m", "initial"],
        );
        fixture_git(
            &config,
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "linked",
                &linked.to_string_lossy(),
            ],
        );

        let git_dir = ProcessRunner
            .resolve_git_dir(
                &git_request(&config, &linked, &["add", "--", "file.txt"]),
                &CancellationToken::new(),
            )
            .await
            .expect("the linked worktree's Git directory");

        assert_eq!(
            std::fs::canonicalize(&git_dir).expect("resolved Git directory"),
            std::fs::canonicalize(main.join(".git").join("worktrees").join("linked"))
                .expect("linked worktree Git directory")
        );
        assert_eq!(
            IndexLockWatch::before_spawn(&git_dir).lock,
            git_dir.join("index.lock")
        );
    }

    #[tokio::test]
    async fn index_lock_cleanup_shutdown_with_nothing_running_returns_at_once() {
        let started = std::time::Instant::now();

        let outcome = GitWriteRegistry::default()
            .stop_all_and_wait(Duration::from_secs(10))
            .await;

        assert_eq!(outcome, QuiesceOutcome::Clean);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn index_lock_cleanup_two_runtimes_do_not_share_writes() {
        let stopping = GitWriteRegistry::default();
        let running = GitWriteRegistry::default();
        let write = running.track().expect("the other runtime admits a write");

        let outcome = stopping.stop_all_and_wait(Duration::from_secs(10)).await;

        assert_eq!(outcome, QuiesceOutcome::Clean);
        assert!(!write.cancellation.is_cancelled());
        assert!(running.track().is_some());
    }

    #[tokio::test]
    async fn index_lock_cleanup_refuses_a_write_after_admission_closed() {
        let sandbox = TestSandbox::new("index-lock-cleanup-refused");
        let config = IsolatedGitConfig::new();
        let registry = GitWriteRegistry::default();
        registry.close_admission();

        assert!(registry.track().is_none());
        let refused = ProcessRunner
            .run_write(
                git_request(&config, sandbox.root(), &["init", "-q"]),
                &registry,
                &CancellationToken::new(),
            )
            .await;
        assert!(
            matches!(refused, Err(ProcessError::Cancelled { .. })),
            "{refused:?}"
        );
        assert!(
            !sandbox.path(".git").exists(),
            "the refused write never ran"
        );
    }

    /// The write's settlement removes the lock only after a forced stop, and releases the write
    /// either way. On Linux and macOS a real Git write stops when asked, so only this test
    /// reaches the forced branch there.
    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_settles_only_a_forced_stop() {
        for (report, lock_remains) in [
            (
                TerminationReport {
                    requested: true,
                    forced: true,
                    exited: true,
                },
                false,
            ),
            (
                TerminationReport {
                    requested: true,
                    forced: false,
                    exited: true,
                },
                true,
            ),
        ] {
            let git_dir = tempfile::tempdir().expect("Git directory");
            let lock = git_dir.path().join("index.lock");
            let registry = GitWriteRegistry::default();
            let watch = IndexLockWatch::before_spawn(git_dir.path());
            std::fs::write(&lock, "").expect("the write's lock");
            let (reports, received) = tokio::sync::mpsc::unbounded_channel();
            reports.send(report).expect("the stop report");

            WriteSettlement {
                _ticket: registry.track().expect("an admitted write"),
                watch: Some(watch),
                received,
                operation: "fixture-write".to_owned(),
                cwd: git_dir.path().to_path_buf(),
            }
            .settle_now_or_later()
            .await;

            assert_eq!(lock.exists(), lock_remains, "{report:?}");
            assert_eq!(
                registry.stop_all_and_wait(Duration::from_secs(1)).await,
                QuiesceOutcome::Clean,
                "the settled write is released"
            );
        }
    }

    /// A caller dropped during the lock-unchanged wait must not release the write while its
    /// lock remains: the cleanup finishes on its own and shutdown waits for it.
    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_survives_a_caller_dropped_during_the_wait() {
        let git_dir = tempfile::tempdir().expect("Git directory");
        let lock = git_dir.path().join("index.lock");
        let registry = GitWriteRegistry::default();
        let watch = IndexLockWatch::before_spawn(git_dir.path());
        std::fs::write(&lock, "").expect("the forced write's lock");
        let (reports, received) = tokio::sync::mpsc::unbounded_channel();
        reports
            .send(TerminationReport {
                requested: true,
                forced: true,
                exited: true,
            })
            .expect("the stop report");
        let settlement = WriteSettlement {
            _ticket: registry.track().expect("an admitted write"),
            watch: Some(watch),
            received,
            operation: "fixture-write".to_owned(),
            cwd: git_dir.path().to_path_buf(),
        }
        .settle_now_or_later();

        let dropped = tokio::time::timeout(Duration::from_secs(1), settlement).await;

        assert!(dropped.is_err(), "the caller left during the wait");
        assert!(lock.exists(), "the lock is not yet two seconds old");
        assert_eq!(
            registry.stop_all_and_wait(Duration::from_millis(500)).await,
            QuiesceOutcome::Pending(1),
            "the write is held while its cleanup runs"
        );
        assert_eq!(
            registry.stop_all_and_wait(Duration::from_secs(5)).await,
            QuiesceOutcome::Clean
        );
        assert!(!lock.exists(), "the cleanup still removed the lock");
    }

    /// Leaves an unchanged lock that a forced write could not delete, because its Git
    /// directory is read-only. The directory stays read-only; `writable` undoes that.
    #[cfg(unix)]
    async fn leave_an_undeletable_lock(
        registry: &GitWriteRegistry,
    ) -> Option<(tempfile::TempDir, PathBuf)> {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipped: root deletes from a read-only folder");
            return None;
        }
        let git_dir = tempfile::tempdir().expect("Git directory");
        let lock = git_dir.path().join("index.lock");
        let watch = IndexLockWatch::before_spawn(git_dir.path());
        std::fs::write(&lock, "").expect("the forced write's lock");
        std::fs::set_permissions(git_dir.path(), std::fs::Permissions::from_mode(0o555))
            .expect("read-only Git directory");
        let (reports, received) = tokio::sync::mpsc::unbounded_channel();
        reports
            .send(TerminationReport {
                requested: true,
                forced: true,
                exited: true,
            })
            .expect("the stop report");
        WriteSettlement {
            _ticket: registry.track().expect("an admitted write"),
            watch: Some(watch),
            received,
            operation: "fixture-write".to_owned(),
            cwd: git_dir.path().to_path_buf(),
        }
        .settle_now_or_later()
        .await;
        Some((git_dir, lock))
    }

    #[cfg(unix)]
    fn writable(git_dir: &tempfile::TempDir) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(git_dir.path(), std::fs::Permissions::from_mode(0o755))
            .expect("writable Git directory");
    }

    /// A lock that stayed unchanged but could not be deleted is not someone else's: every stop
    /// reports it while it is still there.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_reports_a_lock_it_could_not_remove() {
        let registry = GitWriteRegistry::default();
        let Some((git_dir, lock)) = leave_an_undeletable_lock(&registry).await else {
            return;
        };

        let cleanup = IndexLockWatch {
            lock: lock.clone(),
            existed: false,
        }
        .after_forced_stop()
        .await;
        let first = registry.stop_all_and_wait(Duration::from_secs(1)).await;
        let second = registry.stop_all_and_wait(Duration::from_secs(1)).await;

        writable(&git_dir);
        assert!(
            matches!(
                cleanup,
                LockCleanup::RemoveFailed {
                    kind: std::io::ErrorKind::PermissionDenied,
                    ..
                }
            ),
            "{cleanup:?}"
        );
        assert!(lock.exists(), "the lock could not be removed");
        let reported =
            QuiesceOutcome::LocksLeft(vec![redact_path(&git_dir.path().to_string_lossy())]);
        assert_eq!(first, reported);
        assert_eq!(second, reported, "a later stop still reports the lock");
    }

    /// Codex review finding 3: a leftover lock someone else deleted is no longer reported.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_forgets_a_leftover_lock_someone_removed() {
        let registry = GitWriteRegistry::default();
        let Some((git_dir, lock)) = leave_an_undeletable_lock(&registry).await else {
            return;
        };
        writable(&git_dir);
        std::fs::remove_file(&lock).expect("someone deletes the lock");

        assert_eq!(
            registry.stop_all_and_wait(Duration::from_secs(1)).await,
            QuiesceOutcome::Clean
        );
    }

    /// Each stop tries once more to delete a leftover lock, so a lock left by a passing
    /// permission problem goes away.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_retries_a_leftover_lock_on_the_next_stop() {
        let registry = GitWriteRegistry::default();
        let Some((git_dir, lock)) = leave_an_undeletable_lock(&registry).await else {
            return;
        };
        writable(&git_dir);

        let outcome = registry.stop_all_and_wait(Duration::from_secs(1)).await;

        assert_eq!(outcome, QuiesceOutcome::Clean);
        assert!(!lock.exists(), "the retry deleted the leftover lock");
    }

    /// A leftover lock that changed since it was recorded belongs to another Git process now,
    /// so the retry forgets it and leaves it alone.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_keeps_a_leftover_lock_that_changed() {
        let registry = GitWriteRegistry::default();
        let Some((git_dir, lock)) = leave_an_undeletable_lock(&registry).await else {
            return;
        };
        writable(&git_dir);
        std::fs::write(&lock, "another Git process").expect("another Git takes the lock");

        let outcome = registry.stop_all_and_wait(Duration::from_secs(1)).await;

        assert_eq!(outcome, QuiesceOutcome::Clean);
        assert!(lock.exists(), "a lock that changed is never deleted");
    }

    /// Codex review: the record keeps the lock that passed the unchanged check, so a lock
    /// another Git process put there before the record was made is never deleted later.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_records_the_lock_that_passed_the_check() {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipped: root deletes from a read-only folder");
            return;
        }
        let registry = GitWriteRegistry::default();
        let git_dir = tempfile::tempdir().expect("Git directory");
        let lock = git_dir.path().join("index.lock");
        let watch = IndexLockWatch::before_spawn(git_dir.path());
        std::fs::write(&lock, "").expect("the forced write's lock");
        std::fs::set_permissions(git_dir.path(), std::fs::Permissions::from_mode(0o555))
            .expect("read-only Git directory");
        let cleanup = watch.after_forced_stop().await;
        let LockCleanup::RemoveFailed { state, .. } = cleanup else {
            panic!("the delete fails: {cleanup:?}");
        };
        std::fs::write(&lock, "another Git process").expect("another Git takes the lock");
        let ticket = registry.track().expect("an admitted write");

        ticket.lock_left(lock.clone(), state, "worktree".to_owned());
        drop(ticket);
        writable(&git_dir);
        let outcome = registry.stop_all_and_wait(Duration::from_secs(1)).await;

        assert_eq!(outcome, QuiesceOutcome::Clean);
        assert!(
            lock.exists(),
            "the other Git process's lock is never deleted"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn index_lock_cleanup_reports_pending_when_a_reap_outlasts_the_limit() {
        let registry = GitWriteRegistry::default();
        let write = registry.track().expect("an admitted write");

        assert_eq!(
            registry.stop_all_and_wait(Duration::from_secs(1)).await,
            QuiesceOutcome::Pending(1)
        );
        assert!(
            write.cancellation.is_cancelled(),
            "the write was told to stop"
        );
        drop(write);
        assert_eq!(
            registry.stop_all_and_wait(Duration::from_secs(1)).await,
            QuiesceOutcome::Clean
        );
    }

    #[test]
    fn safe_spawn_failure_preserves_category_without_private_launch_data() {
        for (kind, expected) in [
            (
                std::io::ErrorKind::NotFound,
                "required file or directory was not found",
            ),
            (
                std::io::ErrorKind::PermissionDenied,
                "permission was denied",
            ),
            (
                std::io::ErrorKind::NotADirectory,
                "a required path is not a directory",
            ),
            (
                std::io::ErrorKind::InvalidInput,
                "the launch input was invalid",
            ),
            (
                std::io::ErrorKind::Other,
                "the operating system rejected the launch",
            ),
        ] {
            let error = ProcessError::Spawn {
                operation: "private-operation-sentinel".to_owned(),
                command: "/private/executable-sentinel".to_owned(),
                source: std::io::Error::new(kind, "Bearer credential-sentinel stdout-sentinel"),
            };
            let message = error.safe_facts().message("glab");
            assert!(message.contains(expected), "{message}");
            assert!(message.contains("glab"));
            assert!(!message.contains("sentinel"));
            assert!(!message.contains("/private"));
            assert!(!message.contains("not installed"));
        }
        let error = ProcessError::Spawn {
            operation: "fixture".into(),
            command: "private".into(),
            source: std::io::Error::from_raw_os_error(2),
        };
        assert!(error.safe_facts().message("glab").contains("OS error 2"));
    }

    #[test]
    fn a_missing_working_folder_is_not_found_even_where_windows_says_not_a_directory() {
        let missing =
            std::env::temp_dir().join(format!("bibcode-missing-{}", uuid::Uuid::new_v4()));
        let windows = std::io::Error::new(std::io::ErrorKind::NotADirectory, "directory name");
        assert_eq!(
            super::missing_cwd_as_not_found(windows, &missing).kind(),
            std::io::ErrorKind::NotFound
        );
        let file_cwd = std::env::temp_dir();
        let not_dir = std::io::Error::new(std::io::ErrorKind::NotADirectory, "a file");
        assert_eq!(
            super::missing_cwd_as_not_found(not_dir, &file_cwd).kind(),
            std::io::ErrorKind::NotADirectory
        );
    }

    #[test]
    fn safe_process_failure_distinguishes_completion_without_forwarding_output() {
        for (error, expected) in [
            (
                ProcessError::NonZeroExit {
                    operation: "private-operation-sentinel".into(),
                    exit_code: 23,
                    stdout_length: 1,
                    stderr_length: 1,
                    stdout: "stdout-credential-sentinel".into(),
                    stderr: "stderr-credential-sentinel".into(),
                },
                "status 23",
            ),
            (
                ProcessError::Timeout {
                    operation: "private-operation-sentinel".into(),
                    timeout_ms: 60000,
                },
                "timed out after 60000 ms",
            ),
            (
                ProcessError::Cancelled {
                    operation: "private-operation-sentinel".into(),
                },
                "was cancelled",
            ),
            (
                ProcessError::OutputLimit {
                    operation: "private-operation-sentinel".into(),
                    stream: "stdout",
                    max_bytes: 10,
                    observed_bytes: 20,
                },
                "output exceeded its limit",
            ),
            (
                ProcessError::Read {
                    operation: "private-operation-sentinel".into(),
                    stream: "stdout",
                    source: std::io::Error::other("credential-sentinel"),
                },
                "output could not be read",
            ),
            (
                ProcessError::Wait {
                    operation: "private-operation-sentinel".into(),
                    source: std::io::Error::other("credential-sentinel"),
                },
                "process completion",
            ),
            (
                ProcessError::Pipe {
                    operation: "private-operation-sentinel".into(),
                    stream: "stdout",
                },
                "process input or output",
            ),
            (
                ProcessError::Stdin {
                    operation: "private-operation-sentinel".into(),
                    source: std::io::Error::other("credential-sentinel"),
                },
                "send input",
            ),
            (
                ProcessError::MissingExitCode {
                    operation: "private-operation-sentinel".into(),
                },
                "without an exit status",
            ),
        ] {
            let message = error.safe_facts().message("git");
            assert!(message.contains(expected), "{message}");
            assert!(!message.contains("sentinel"));
        }
    }

    fn fixture_request(sandbox: &TestSandbox, operation: &str, command: PathBuf) -> ProcessRequest {
        ProcessRequest {
            operation: operation.to_owned(),
            command,
            args: Vec::new(),
            cwd: sandbox.root().to_path_buf(),
            env: sandbox
                .environment(std::iter::empty::<(String, String)>())
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
            stdin: None,
            timeout: Duration::from_secs(30),
            max_output_bytes: 1024,
            output_policy: OutputPolicy::Truncate,
            append_truncation_marker: false,
            allow_non_zero_exit: false,
        }
    }

    #[test]
    fn git_stop_only_git_gets_the_ask_first_policy() {
        let sandbox = TestSandbox::new("git-stop-policy");
        let policy = |command: &str| {
            let request = fixture_request(&sandbox, "fixture-policy", PathBuf::from(command));
            supervised_request(&request, Command::new(command)).stop_policy
        };

        assert_eq!(policy("git"), StopPolicy::AskThenForce);
        assert_eq!(policy("/usr/bin/git"), StopPolicy::AskThenForce);
        #[cfg(windows)]
        assert_eq!(
            policy("C:\\Program Files\\Git\\cmd\\git.exe"),
            StopPolicy::AskThenForce
        );
        assert_eq!(policy("trash"), StopPolicy::Force);
        assert_eq!(policy("gitk"), StopPolicy::Force);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn runner_uses_command_local_environment_for_parallel_children() {
        async fn run(label: &str) -> ProcessOutput {
            let sandbox = TestSandbox::new(label);
            let script = sandbox.executable_script(
                "print-label",
                "printf '%s' \"$FIXTURE_LABEL\"",
                "@echo off\r\n<nul set /p =%FIXTURE_LABEL%\r\nexit /b 0",
            );
            let mut request = fixture_request(&sandbox, "fixture-label", script);
            request.env = sandbox
                .environment([("FIXTURE_LABEL", label)])
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect();
            ProcessRunner
                .run(request, &CancellationToken::new())
                .await
                .expect("parallel git fixture process")
        }

        let (left, right) = tokio::join!(run("left"), run("right"));
        assert_eq!(left.stdout, "left");
        assert_eq!(right.stdout, "right");
    }

    /// `Tail` keeps the end of an oversized stream and says how much of its
    /// head was dropped, instead of failing the read.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_tail_policy_keeps_the_last_bytes_and_reports_the_dropped_head() {
        let sandbox = TestSandbox::new("git-tail-policy");
        let script = sandbox.executable_script(
            "long-log",
            "i=0; while [ $i -lt 300 ]; do printf 'line %04d\\n' $i; i=$((i+1)); done",
            "",
        );
        let mut request = fixture_request(&sandbox, "fixture-tail", script);
        request.output_policy = OutputPolicy::Tail;
        request.max_output_bytes = 100;
        let output = ProcessRunner
            .run_bytes(request, &CancellationToken::new())
            .await
            .expect("an oversized tail read completes");
        // 300 lines of 10 bytes: the last 10 lines survive.
        assert_eq!(output.stdout.len(), 100);
        assert!(output.stdout.starts_with(b"line 0290\n"));
        assert!(output.stdout.ends_with(b"line 0299\n"));
        assert!(output.stdout_truncated);
        assert_eq!(output.stdout_dropped_bytes, 2_900);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_program_that_fails_to_start_still_falls_through_the_path_search() {
        let sandbox = TestSandbox::new("git-spawn-fallback");
        let broken = sandbox.path("broken");
        let working = sandbox.path("working");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::create_dir_all(&working).unwrap();
        // Executable, but its interpreter is missing: execve fails with ENOENT, and execvp
        // goes on to the next PATH entry, as a bare name always did.
        TestSandbox::write_executable(&broken.join("fixture-tool"), "#!/nonexistent/interpreter\n");
        TestSandbox::write_executable(&working.join("fixture-tool"), "#!/bin/sh\nprintf found\n");
        let mut request =
            fixture_request(&sandbox, "fixture-fallback", PathBuf::from("fixture-tool"));
        request.env.push((
            "PATH".into(),
            std::env::join_paths([&broken, &working]).unwrap(),
        ));

        for output in [
            ProcessRunner
                .run(request.clone(), &CancellationToken::new())
                .await
                .map(|output| output.stdout.into_bytes()),
            ProcessRunner
                .run_bytes(request, &CancellationToken::new())
                .await
                .map(|output| output.stdout),
        ] {
            assert_eq!(
                output.expect("the PATH search finds the working tool"),
                b"found"
            );
        }
    }
}
