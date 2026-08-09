use std::{io, process::ExitStatus, time::Duration};

use process_wrap::tokio::{ChildWrapper, CommandWrap};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

use super::{ProcessCleanupReport, configure_supervised_background_command_wrap};

const PROCESS_CLEANUP_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const PROCESS_OUTPUT_READ_BUFFER_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SupervisedOverflow {
    Error,
    Truncate,
}

#[derive(Debug)]
pub(crate) struct SupervisedRunRequest {
    pub(crate) command: Command,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) timeout: Duration,
    pub(crate) cleanup_timeout: Duration,
    pub(crate) max_output_bytes: usize,
    pub(crate) overflow: SupervisedOverflow,
}

#[derive(Debug)]
pub(crate) struct SupervisedStreamOutput {
    pub(crate) bytes: Vec<u8>,
    pub(crate) observed_bytes: usize,
}

impl SupervisedStreamOutput {
    pub(crate) fn truncated(&self) -> bool {
        self.observed_bytes > self.bytes.len()
    }
}

#[derive(Debug)]
pub(crate) struct SupervisedRunOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: SupervisedStreamOutput,
    pub(crate) stderr: SupervisedStreamOutput,
}

#[derive(Debug)]
pub(crate) enum SupervisedRunError {
    Spawn(io::Error),
    Pipe {
        stream: &'static str,
    },
    Stdin(io::Error),
    Read {
        stream: &'static str,
        source: io::Error,
    },
    OutputLimit {
        stream: &'static str,
        max_bytes: usize,
        observed_bytes: usize,
    },
    Timeout,
    Cancelled,
    Wait(io::Error),
}

pub(crate) async fn run_supervised(
    request: SupervisedRunRequest,
    cancellation: &CancellationToken,
) -> Result<SupervisedRunOutput, SupervisedRunError> {
    if cancellation.is_cancelled() {
        return Err(SupervisedRunError::Cancelled);
    }
    let SupervisedRunRequest {
        command,
        stdin,
        timeout,
        cleanup_timeout,
        max_output_bytes,
        overflow,
    } = request;
    let execution = SupervisedExecution {
        stdin,
        timeout,
        max_output_bytes,
        overflow,
    };
    let mut command = CommandWrap::from(command);
    configure_supervised_background_command_wrap(&mut command);
    let mut child = spawn_wrapped(&mut command).map_err(SupervisedRunError::Spawn)?;

    let outcome = execute_child(&mut *child, &execution, cancellation).await;
    if outcome.is_err() {
        terminate_and_wait_owned(child, cleanup_timeout, "supervised process").await;
    }
    outcome
}

struct SupervisedExecution {
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    max_output_bytes: usize,
    overflow: SupervisedOverflow,
}

async fn execute_child(
    child: &mut dyn ChildWrapper,
    request: &SupervisedExecution,
    cancellation: &CancellationToken,
) -> Result<SupervisedRunOutput, SupervisedRunError> {
    let stdout = child
        .stdout()
        .take()
        .ok_or(SupervisedRunError::Pipe { stream: "stdout" })?;
    let stderr = child
        .stderr()
        .take()
        .ok_or(SupervisedRunError::Pipe { stream: "stderr" })?;
    let stdin = match request.stdin.as_ref() {
        Some(_) => Some(
            child
                .stdin()
                .take()
                .ok_or(SupervisedRunError::Pipe { stream: "stdin" })?,
        ),
        None => {
            drop(child.stdin().take());
            None
        }
    };

    enum Outcome {
        Completed(Result<SupervisedRunOutput, SupervisedRunError>),
        TimedOut,
        Cancelled,
    }

    let outcome = {
        let execution = async {
            let stdin = write_stdin(stdin, request.stdin.as_deref());
            let stdout =
                collect_output(stdout, "stdout", request.max_output_bytes, request.overflow);
            let stderr =
                collect_output(stderr, "stderr", request.max_output_bytes, request.overflow);
            let wait = async { child.wait().await.map_err(SupervisedRunError::Wait) };
            let ((), stdout, stderr, status) = tokio::try_join!(stdin, stdout, stderr, wait)?;
            Ok(SupervisedRunOutput {
                status,
                stdout,
                stderr,
            })
        };
        tokio::pin!(execution);
        tokio::select! {
            biased;
            () = cancellation.cancelled() => Outcome::Cancelled,
            () = tokio::time::sleep(request.timeout) => Outcome::TimedOut,
            result = &mut execution => Outcome::Completed(result),
        }
    };

    match outcome {
        Outcome::Completed(result) => result,
        Outcome::TimedOut => Err(SupervisedRunError::Timeout),
        Outcome::Cancelled => Err(SupervisedRunError::Cancelled),
    }
}

async fn write_stdin(
    stdin: Option<tokio::process::ChildStdin>,
    input: Option<&[u8]>,
) -> Result<(), SupervisedRunError> {
    let (Some(mut stdin), Some(input)) = (stdin, input) else {
        return Ok(());
    };
    stdin
        .write_all(input)
        .await
        .map_err(SupervisedRunError::Stdin)?;
    stdin.shutdown().await.map_err(SupervisedRunError::Stdin)
}

async fn collect_output(
    mut reader: impl AsyncRead + Unpin,
    stream: &'static str,
    max_bytes: usize,
    overflow: SupervisedOverflow,
) -> Result<SupervisedStreamOutput, SupervisedRunError> {
    let mut bytes = Vec::with_capacity(max_bytes.min(64 * 1024));
    let mut observed_bytes = 0usize;
    let mut buffer = vec![0u8; PROCESS_OUTPUT_READ_BUFFER_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|source| SupervisedRunError::Read { stream, source })?;
        if read == 0 {
            break;
        }
        observed_bytes = observed_bytes.saturating_add(read);
        let remaining = max_bytes.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        if observed_bytes > max_bytes && overflow == SupervisedOverflow::Error {
            return Err(SupervisedRunError::OutputLimit {
                stream,
                max_bytes,
                observed_bytes,
            });
        }
    }
    Ok(SupervisedStreamOutput {
        bytes,
        observed_bytes,
    })
}

pub(crate) async fn terminate_and_wait(child: &mut dyn ChildWrapper) -> ProcessCleanupReport {
    terminate_and_wait_with_timeout(child, PROCESS_CLEANUP_WAIT_TIMEOUT).await
}

async fn terminate_and_wait_with_timeout(
    child: &mut dyn ChildWrapper,
    wait_timeout: Duration,
) -> ProcessCleanupReport {
    let mut report = ProcessCleanupReport::default();
    request_termination(child, &mut report);
    match tokio::time::timeout(wait_timeout, child.wait()).await {
        Ok(Ok(_)) => report.record_success(),
        Ok(Err(error)) => report.record_failure(format!("wait: {error}")),
        Err(_) => report.record_failure(format!(
            "wait timed out after {} ms",
            wait_timeout.as_millis()
        )),
    }
    report
}

async fn terminate_and_wait_owned(
    mut child: Box<dyn ChildWrapper>,
    wait_timeout: Duration,
    operation: &'static str,
) {
    let mut report = ProcessCleanupReport::default();
    request_termination(&mut *child, &mut report);
    match tokio::time::timeout(wait_timeout, child.wait()).await {
        Ok(Ok(_)) => report.record_success(),
        Ok(Err(error)) => report.record_failure(format!("wait: {error}")),
        Err(_) => {
            report.record_failure(format!(
                "wait timed out after {} ms",
                wait_timeout.as_millis()
            ));
            log_cleanup_failures(operation, &report);
            tokio::spawn(async move {
                let mut final_report = ProcessCleanupReport::default();
                match child.wait().await {
                    Ok(_) => final_report.record_success(),
                    Err(error) => final_report.record_failure(format!("wait: {error}")),
                }
                if final_report.failure_count > 0 {
                    log_cleanup_failures(operation, &final_report);
                } else {
                    tracing::debug!(
                        operation,
                        attempted = final_report.attempted,
                        succeeded = final_report.succeeded,
                        "background supervised process reap completed"
                    );
                }
            });
            return;
        }
    }
    log_cleanup_failures(operation, &report);
}

fn request_termination(child: &mut dyn ChildWrapper, report: &mut ProcessCleanupReport) {
    if let Err(error) = child.start_kill() {
        report.record_failure(format!("kill ownership unit: {error}"));
        match child.inner_mut().start_kill() {
            Ok(()) => report.record_success(),
            Err(error) => report.record_failure(format!("kill root child: {error}")),
        }
    } else {
        report.record_success();
    }
}

pub(crate) fn log_cleanup_failures(operation: &'static str, report: &ProcessCleanupReport) {
    if report.failure_count > 0 {
        tracing::warn!(
            operation,
            attempted = report.attempted,
            succeeded = report.succeeded,
            failure_count = report.failure_count,
            failures = ?report.failures,
            "supervised process cleanup was incomplete"
        );
    }
}

#[cfg(not(windows))]
fn spawn_wrapped(command: &mut CommandWrap) -> io::Result<Box<dyn ChildWrapper>> {
    command.spawn()
}

#[cfg(windows)]
fn spawn_wrapped(command: &mut CommandWrap) -> io::Result<Box<dyn ChildWrapper>> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE},
        System::Threading::GetCurrentProcess,
    };

    let mut duplicated: HANDLE = std::ptr::null_mut();
    let result = command.spawn_with(|command| {
        let child = command.spawn()?;
        let raw_handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("spawned process handle is unavailable"))?;
        let process = raw_handle.cast();
        // SAFETY: the source process handle belongs to the newly spawned child,
        // both process pseudo-handles refer to the current process, and
        // `duplicated` is valid writable storage for the new owned handle.
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                process,
                GetCurrentProcess(),
                &mut duplicated,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            cleanup_failed_windows_spawn_handle(process, "duplicate process handle");
            return Err(error);
        }
        Ok(child)
    });

    if result.is_err() && !duplicated.is_null() {
        cleanup_failed_windows_spawn_handle(duplicated, "process-wrap hook");
    }
    if !duplicated.is_null() {
        // SAFETY: this closes the duplicate created above exactly once. The
        // wrapped child retains its original process handle on success.
        unsafe { CloseHandle(duplicated) };
    }
    result
}

#[cfg(windows)]
fn cleanup_failed_windows_spawn_handle(
    process: windows_sys::Win32::Foundation::HANDLE,
    stage: &'static str,
) {
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{TerminateProcess, WaitForSingleObject},
    };

    const SPAWN_FAILURE_WAIT_MS: u32 = 5_000;

    // SAFETY: the handle names the newly spawned process and remains valid
    // through this bounded termination and wait sequence.
    let terminated = unsafe { TerminateProcess(process, 1) };
    // SAFETY: the same live process handle may be synchronously waited.
    let waited = unsafe { WaitForSingleObject(process, SPAWN_FAILURE_WAIT_MS) };
    if terminated == 0 || waited != WAIT_OBJECT_0 {
        let error = io::Error::last_os_error();
        tracing::warn!(
            stage,
            error = %super::cleanup::bound_process_cleanup_failure(error),
            "failed to fully clean up process-wrap spawn failure"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        pin::Pin,
        process::{ExitStatus, Stdio},
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use tokio::{process::Child, sync::watch};

    use super::*;

    #[derive(Debug)]
    struct TrackingChild {
        child: Child,
        kill_calls: Arc<AtomicUsize>,
        wait_calls: Arc<AtomicUsize>,
        fail_kill: bool,
    }

    impl ChildWrapper for TrackingChild {
        fn inner(&self) -> &dyn ChildWrapper {
            &self.child
        }

        fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
            &mut self.child
        }

        fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
            Box::new(self.child)
        }

        fn start_kill(&mut self) -> io::Result<()> {
            self.kill_calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_kill {
                Err(io::Error::other("injected kill failure"))
            } else {
                self.child.start_kill()
            }
        }

        fn wait(&mut self) -> Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send + '_>> {
            self.wait_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(self.child.wait())
        }
    }

    #[derive(Debug)]
    struct PendingChild {
        kill_calls: Arc<AtomicUsize>,
        wait_calls: Arc<AtomicUsize>,
    }

    impl ChildWrapper for PendingChild {
        fn inner(&self) -> &dyn ChildWrapper {
            self
        }

        fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
            self
        }

        fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
            self
        }

        fn start_kill(&mut self) -> io::Result<()> {
            self.kill_calls.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::other("injected pending-child kill failure"))
        }

        fn wait(&mut self) -> Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send + '_>> {
            self.wait_calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(std::future::pending())
        }
    }

    #[derive(Debug)]
    struct DelayedReapChild {
        release: watch::Receiver<bool>,
        wait_calls: Arc<AtomicUsize>,
        drop_calls: Arc<AtomicUsize>,
    }

    impl Drop for DelayedReapChild {
        fn drop(&mut self) {
            self.drop_calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl ChildWrapper for DelayedReapChild {
        fn inner(&self) -> &dyn ChildWrapper {
            self
        }

        fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
            self
        }

        fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
            self
        }

        fn start_kill(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn wait(&mut self) -> Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send + '_>> {
            self.wait_calls.fetch_add(1, Ordering::SeqCst);
            let mut release = self.release.clone();
            Box::pin(async move {
                while !*release.borrow() {
                    release
                        .changed()
                        .await
                        .map_err(|_| io::Error::other("reap release sender dropped"))?;
                }
                Ok(successful_exit_status())
            })
        }
    }

    #[cfg(unix)]
    fn successful_exit_status() -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;

        ExitStatus::from_raw(0)
    }

    #[cfg(windows)]
    fn successful_exit_status() -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;

        ExitStatus::from_raw(0)
    }

    fn pending_child() -> (Box<PendingChild>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let kill_calls = Arc::new(AtomicUsize::new(0));
        let wait_calls = Arc::new(AtomicUsize::new(0));
        (
            Box::new(PendingChild {
                kill_calls: Arc::clone(&kill_calls),
                wait_calls: Arc::clone(&wait_calls),
            }),
            kill_calls,
            wait_calls,
        )
    }

    fn completed_command() -> Command {
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/s", "/c", "exit /b 0"]);
            command
        }
        #[cfg(not(windows))]
        {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        }
    }

    fn tracking_child(fail_kill: bool) -> (Box<TrackingChild>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let child = completed_command()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("tracking child should spawn");
        let kill_calls = Arc::new(AtomicUsize::new(0));
        let wait_calls = Arc::new(AtomicUsize::new(0));
        (
            Box::new(TrackingChild {
                child,
                kill_calls: Arc::clone(&kill_calls),
                wait_calls: Arc::clone(&wait_calls),
                fail_kill,
            }),
            kill_calls,
            wait_calls,
        )
    }

    fn execution() -> SupervisedExecution {
        SupervisedExecution {
            stdin: None,
            timeout: Duration::from_secs(5),
            max_output_bytes: 1024,
            overflow: SupervisedOverflow::Error,
        }
    }

    #[tokio::test]
    async fn pre_cancelled_run_rejects_before_spawning_the_command() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let error = run_supervised(
            SupervisedRunRequest {
                command: Command::new("bibcode-command-that-must-not-exist"),
                stdin: None,
                timeout: Duration::from_secs(5),
                cleanup_timeout: PROCESS_CLEANUP_WAIT_TIMEOUT,
                max_output_bytes: 1024,
                overflow: SupervisedOverflow::Error,
            },
            &cancellation,
        )
        .await
        .expect_err("pre-cancelled execution must not attempt to spawn");

        assert!(matches!(error, SupervisedRunError::Cancelled));
    }

    #[tokio::test]
    async fn missing_required_stream_still_kills_and_waits() {
        let (mut child, kill_calls, wait_calls) = tracking_child(false);
        let error = execute_child(&mut *child, &execution(), &CancellationToken::new())
            .await
            .expect_err("missing stdout should fail");
        assert!(matches!(
            error,
            SupervisedRunError::Pipe { stream: "stdout" }
        ));

        let report = terminate_and_wait(&mut *child).await;
        assert_eq!(kill_calls.load(Ordering::SeqCst), 1);
        assert_eq!(wait_calls.load(Ordering::SeqCst), 1);
        assert_eq!(report.attempted, 2);
    }

    #[tokio::test]
    async fn failed_kill_still_waits_and_bounds_cleanup_failures() {
        let (mut child, kill_calls, wait_calls) = tracking_child(true);
        let report = terminate_and_wait(&mut *child).await;
        assert_eq!(kill_calls.load(Ordering::SeqCst), 1);
        assert_eq!(wait_calls.load(Ordering::SeqCst), 1);
        assert_eq!(report.attempted, 3);
        assert_eq!(report.failure_count, 1);
        assert!(report.failures[0].chars().count() <= 160);

        let mut bounded = ProcessCleanupReport::default();
        for index in 0..32 {
            bounded.record_failure(format!("{index}:{}", "x".repeat(1_000)));
        }
        assert_eq!(bounded.failure_count, 32);
        assert_eq!(bounded.failures.len(), 8);
        assert!(
            bounded
                .failures
                .iter()
                .all(|failure| failure.chars().count() <= 160)
        );
    }

    #[tokio::test]
    async fn pending_child_with_failed_owner_and_root_kills_returns_bounded_report() {
        let (mut child, kill_calls, wait_calls) = pending_child();
        let cleanup =
            tokio::time::timeout(Duration::from_secs(3), terminate_and_wait(&mut *child)).await;
        let report = cleanup.expect("cleanup must return within its bounded wait deadline");

        assert_eq!(kill_calls.load(Ordering::SeqCst), 2);
        assert_eq!(wait_calls.load(Ordering::SeqCst), 1);
        assert_eq!(report.attempted, 3);
        assert_eq!(report.failure_count, 3);
        assert!(
            report
                .failures
                .iter()
                .all(|failure| failure.chars().count() <= 160)
        );
    }

    #[tokio::test]
    async fn owned_cleanup_retains_reaper_after_initial_wait_timeout() {
        let (release, release_receiver) = watch::channel(false);
        let wait_calls = Arc::new(AtomicUsize::new(0));
        let drop_calls = Arc::new(AtomicUsize::new(0));
        let child: Box<dyn ChildWrapper> = Box::new(DelayedReapChild {
            release: release_receiver,
            wait_calls: Arc::clone(&wait_calls),
            drop_calls: Arc::clone(&drop_calls),
        });

        terminate_and_wait_owned(
            child,
            Duration::from_millis(10),
            "delayed-reap test process",
        )
        .await;

        tokio::time::timeout(Duration::from_secs(1), async {
            while wait_calls.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("background reaper must take ownership after the initial wait expires");
        assert_eq!(
            drop_calls.load(Ordering::SeqCst),
            0,
            "child owner must remain live while the background wait is pending"
        );

        release.send_replace(true);
        tokio::time::timeout(Duration::from_secs(1), async {
            while drop_calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("background reaper must release its owner after wait completes");
        assert_eq!(wait_calls.load(Ordering::SeqCst), 2);
        assert_eq!(drop_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn output_collection_enforces_or_records_overflow() {
        let error = collect_output(&b"abcdef"[..], "stdout", 3, SupervisedOverflow::Error)
            .await
            .expect_err("strict output should fail");
        assert!(matches!(
            error,
            SupervisedRunError::OutputLimit {
                stream: "stdout",
                max_bytes: 3,
                observed_bytes: 6,
            }
        ));

        let truncated = collect_output(&b"abcdef"[..], "stderr", 4, SupervisedOverflow::Truncate)
            .await
            .expect("truncate output should complete");
        assert_eq!(truncated.bytes, b"abcd");
        assert_eq!(truncated.observed_bytes, 6);
        assert!(truncated.truncated());
    }

    #[test]
    fn output_collection_future_keeps_read_buffer_off_stack() {
        let future = collect_output(&b""[..], "stdout", 1, SupervisedOverflow::Error);
        let future_size = std::mem::size_of_val(&future);

        assert!(
            future_size < PROCESS_OUTPUT_READ_BUFFER_BYTES,
            "output collection future retained an inline 8 KiB read buffer ({future_size} bytes)"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdin_failure_cleans_up_before_returning() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "exec 0<&-; sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let cancellation = CancellationToken::new();
        let error = run_supervised(
            SupervisedRunRequest {
                command,
                stdin: Some(vec![b'x'; 1024 * 1024]),
                timeout: Duration::from_secs(5),
                cleanup_timeout: PROCESS_CLEANUP_WAIT_TIMEOUT,
                max_output_bytes: 1024,
                overflow: SupervisedOverflow::Error,
            },
            &cancellation,
        )
        .await
        .expect_err("closed stdin should fail");
        assert!(matches!(error, SupervisedRunError::Stdin(_)));
    }
}
