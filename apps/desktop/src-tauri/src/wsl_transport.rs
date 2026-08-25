use bibcode_server::process::configure_supervised_background_command_wrap;
use process_wrap::tokio::{ChildWrapper, CommandWrap};
use std::{
    future::Future,
    io,
    net::{Ipv4Addr, SocketAddr},
    pin::Pin,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{Notify, Semaphore},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

const MAX_ACTIVE_WSL_FORWARDS: usize = 64;
const MAX_WSL_FORWARD_STDERR_BYTES: usize = 64 * 1024;
const WSL_FORWARD_CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WslTransportPlan {
    distro_name: String,
    server_binary_path: String,
    server_loopback_port: u16,
    requested_local_port: u16,
}

impl WslTransportPlan {
    pub(crate) fn new(
        distro_name: String,
        server_binary_path: String,
        server_loopback_port: u16,
        requested_local_port: u16,
    ) -> Result<Self, String> {
        if !is_valid_argument(&distro_name) {
            return Err("The WSL transport distro locator is invalid.".to_string());
        }
        // This is a Linux path even though the desktop process runs on Windows.
        // Host-native Path semantics would reject `/...` on Windows.
        if !is_valid_argument(&server_binary_path) || !server_binary_path.starts_with('/') {
            return Err("The WSL transport server binary path is invalid.".to_string());
        }
        if server_loopback_port == 0 {
            return Err("The WSL server loopback port must be non-zero.".to_string());
        }
        Ok(Self {
            distro_name,
            server_binary_path,
            server_loopback_port,
            requested_local_port,
        })
    }

    fn command_args(&self) -> Vec<String> {
        vec![
            "--distribution".to_string(),
            self.distro_name.clone(),
            "--exec".to_string(),
            self.server_binary_path.clone(),
            "transport".to_string(),
            "stdio-forward".to_string(),
            "--loopback-port".to_string(),
            self.server_loopback_port.to_string(),
        ]
    }
}

fn is_valid_argument(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && value.len() <= 4096
        && !value
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n'))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WslTransportEndpoint {
    pub(crate) generation: u64,
    pub(crate) local_addr: SocketAddr,
}

struct WslTransportState {
    cancellation: CancellationToken,
    completion: Notify,
    result: Mutex<Option<Result<(), String>>>,
}

#[derive(Clone)]
pub(crate) struct WslTransportHandle {
    endpoint: WslTransportEndpoint,
    state: Arc<WslTransportState>,
}

impl std::fmt::Debug for WslTransportHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WslTransportHandle")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl WslTransportHandle {
    pub(crate) async fn start(plan: WslTransportPlan, generation: u64) -> Result<Self, String> {
        Self::start_with_runner(plan, generation, Arc::new(ProcessWslForwardRunner)).await
    }

    async fn start_with_runner(
        plan: WslTransportPlan,
        generation: u64,
        runner: Arc<dyn WslForwardRunner>,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, plan.requested_local_port))
            .await
            .map_err(|error| {
                format!("Could not bind the Windows WSL loopback forwarder: {error}")
            })?;
        let local_addr = listener
            .local_addr()
            .map_err(|error| format!("Could not inspect the WSL loopback forwarder: {error}"))?;
        if !local_addr.ip().is_loopback() {
            return Err(
                "The WSL forwarder refused to publish a non-loopback listener.".to_string(),
            );
        }
        let state = Arc::new(WslTransportState {
            cancellation: CancellationToken::new(),
            completion: Notify::new(),
            result: Mutex::new(None),
        });
        let task_state = state.clone();
        tokio::spawn(async move {
            let result =
                run_listener(listener, plan, runner, task_state.cancellation.clone()).await;
            *task_state
                .result
                .lock()
                .expect("WSL transport result mutex poisoned") = Some(result);
            task_state.completion.notify_waiters();
        });
        Ok(Self {
            endpoint: WslTransportEndpoint {
                generation,
                local_addr,
            },
            state,
        })
    }

    pub(crate) fn endpoint(&self) -> WslTransportEndpoint {
        self.endpoint
    }

    pub(crate) fn cancel(&self) {
        self.state.cancellation.cancel();
    }

    pub(crate) fn completed_result(&self) -> Option<Result<(), String>> {
        self.state
            .result
            .lock()
            .expect("WSL transport result mutex poisoned")
            .clone()
    }

    pub(crate) async fn wait_for_completion(&self) -> Result<(), String> {
        loop {
            let notified = self.state.completion.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = self.completed_result() {
                return result;
            }
            notified.await;
        }
    }

    pub(crate) async fn stop(&self) -> Result<(), String> {
        self.cancel();
        self.wait_for_completion().await
    }
}

type WslForwardFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'static>>;

trait WslForwardRunner: Send + Sync {
    fn run(
        &self,
        socket: TcpStream,
        plan: WslTransportPlan,
        cancellation: CancellationToken,
    ) -> WslForwardFuture;
}

struct ProcessWslForwardRunner;

impl WslForwardRunner for ProcessWslForwardRunner {
    fn run(
        &self,
        socket: TcpStream,
        plan: WslTransportPlan,
        cancellation: CancellationToken,
    ) -> WslForwardFuture {
        Box::pin(run_wsl_forward_connection(socket, plan, cancellation))
    }
}

async fn run_listener(
    listener: TcpListener,
    plan: WslTransportPlan,
    runner: Arc<dyn WslForwardRunner>,
    cancellation: CancellationToken,
) -> Result<(), String> {
    let permits = Arc::new(Semaphore::new(MAX_ACTIVE_WSL_FORWARDS));
    let mut connections = JoinSet::new();
    let mut listener_error = None;

    loop {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => break,
            joined = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = joined {
                    tracing::debug!("WSL forward task could not join: {error}");
                }
            }
            accepted = listener.accept() => {
                let (socket, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        listener_error = Some(format!("WSL loopback forwarder accept failed: {error}"));
                        break;
                    }
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    tracing::warn!("WSL loopback forwarder reached its connection limit");
                    continue;
                };
                let connection_runner = runner.clone();
                let connection_plan = plan.clone();
                let connection_cancellation = cancellation.child_token();
                connections.spawn(async move {
                    let _permit = permit;
                    if let Err(error) = connection_runner
                        .run(socket, connection_plan, connection_cancellation)
                        .await
                    {
                        tracing::debug!("WSL connection forward failed: {error}");
                    }
                });
            }
        }
    }

    cancellation.cancel();
    while let Some(joined) = connections.join_next().await {
        if let Err(error) = joined {
            tracing::debug!("WSL forward task could not join during shutdown: {error}");
        }
    }
    listener_error.map_or(Ok(()), Err)
}

async fn run_wsl_forward_connection(
    socket: TcpStream,
    plan: WslTransportPlan,
    cancellation: CancellationToken,
) -> Result<(), String> {
    let mut command = Command::new("wsl.exe");
    command
        .args(plan.command_args())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut command = CommandWrap::from(command);
    configure_supervised_background_command_wrap(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the WSL loopback forward child: {error}"))?;
    let child_stdin = match child.stdin().take() {
        Some(stdin) => stdin,
        None => {
            let _ = terminate_and_reap(&mut *child).await;
            return Err("The WSL forward child did not expose stdin.".to_string());
        }
    };
    let child_stdout = match child.stdout().take() {
        Some(stdout) => stdout,
        None => {
            let _ = terminate_and_reap(&mut *child).await;
            return Err("The WSL forward child did not expose stdout.".to_string());
        }
    };
    let child_stderr = match child.stderr().take() {
        Some(stderr) => stderr,
        None => {
            let _ = terminate_and_reap(&mut *child).await;
            return Err("The WSL forward child did not expose stderr.".to_string());
        }
    };

    let stderr_overflow = CancellationToken::new();
    let stderr_task = tokio::spawn(drain_bounded_stderr(child_stderr, stderr_overflow.clone()));
    let mut child_stdio = tokio::io::join(child_stdout, child_stdin);
    let copy_result = tokio::select! {
        () = cancellation.cancelled() => Ok(CopyOutcome::Cancelled),
        () = stderr_overflow.cancelled() => Ok(CopyOutcome::StderrOverflow),
        copied = proxy_byte_streams(socket, &mut child_stdio) => copied,
    };
    drop(child_stdio);

    let outcome = match copy_result {
        Ok(outcome) => outcome,
        Err(error) => {
            let cleanup = terminate_and_reap(&mut *child).await;
            let _ = stderr_task.await;
            cleanup?;
            return Err(format!("WSL byte forwarding failed: {error}"));
        }
    };

    let status = match outcome {
        CopyOutcome::Cancelled | CopyOutcome::StderrOverflow => {
            terminate_and_reap(&mut *child).await?
        }
        CopyOutcome::Closed => wait_then_terminate(&mut *child).await?,
    };
    let _ = stderr_task.await;

    if outcome == CopyOutcome::Cancelled {
        return Ok(());
    }
    if outcome == CopyOutcome::StderrOverflow {
        return Err("WSL forward child stderr exceeded its safety limit.".to_string());
    }
    if !status.success() {
        return Err(format!(
            "WSL forward child exited unsuccessfully with status {status}."
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CopyOutcome {
    Closed,
    Cancelled,
    StderrOverflow,
}

async fn proxy_byte_streams<Peer>(
    mut socket: TcpStream,
    child: &mut Peer,
) -> io::Result<CopyOutcome>
where
    Peer: AsyncRead + AsyncWrite + Unpin,
{
    tokio::io::copy_bidirectional(&mut socket, child).await?;
    Ok(CopyOutcome::Closed)
}

#[cfg(test)]
async fn proxy_test_streams<Left, Right>(
    mut left: Left,
    mut right: Right,
    cancellation: CancellationToken,
) -> io::Result<CopyOutcome>
where
    Left: AsyncRead + AsyncWrite + Unpin,
    Right: AsyncRead + AsyncWrite + Unpin,
{
    tokio::select! {
        () = cancellation.cancelled() => Ok(CopyOutcome::Cancelled),
        result = tokio::io::copy_bidirectional(&mut left, &mut right) => {
            result?;
            Ok(CopyOutcome::Closed)
        }
    }
}

async fn drain_bounded_stderr(
    mut stderr: impl AsyncRead + Unpin,
    overflow: CancellationToken,
) -> io::Result<()> {
    let mut total = 0_usize;
    let mut buffer = [0_u8; 4096];
    loop {
        let count = stderr.read(&mut buffer).await?;
        if count == 0 {
            return Ok(());
        }
        total = total.saturating_add(count);
        if total > MAX_WSL_FORWARD_STDERR_BYTES {
            overflow.cancel();
            return Ok(());
        }
    }
}

async fn wait_then_terminate(
    child: &mut dyn ChildWrapper,
) -> Result<std::process::ExitStatus, String> {
    match tokio::time::timeout(WSL_FORWARD_CHILD_EXIT_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(error)) => Err(format!("Could not reap the WSL forward child: {error}")),
        Err(_) => terminate_and_reap(child).await,
    }
}

async fn terminate_and_reap(
    child: &mut dyn ChildWrapper,
) -> Result<std::process::ExitStatus, String> {
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("Could not inspect the WSL forward child: {error}"))?
    {
        return Ok(status);
    }
    Box::into_pin(child.kill())
        .await
        .map_err(|error| format!("Could not terminate and reap the WSL forward child: {error}"))?;
    child
        .try_wait()
        .map_err(|error| format!("Could not inspect the reaped WSL forward child: {error}"))?
        .ok_or_else(|| "The WSL forward child was not reaped after termination.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn builds_a_constant_argument_only_wsl_forward_command() {
        let plan = WslTransportPlan::new(
            "Ubuntu 24.04".to_string(),
            "/opt/BiBCode Server/bibcode".to_string(),
            4_201,
            0,
        )
        .expect("valid transport plan");

        assert_eq!(
            plan.command_args(),
            vec![
                "--distribution",
                "Ubuntu 24.04",
                "--exec",
                "/opt/BiBCode Server/bibcode",
                "transport",
                "stdio-forward",
                "--loopback-port",
                "4201",
            ]
        );
        assert!(
            WslTransportPlan::new("bad\nname".to_string(), "/bibcode".to_string(), 1, 0).is_err()
        );
        assert!(WslTransportPlan::new("Ubuntu".to_string(), "relative".to_string(), 1, 0).is_err());
        assert!(WslTransportPlan::new("Ubuntu".to_string(), "/bibcode".to_string(), 0, 0).is_err());
    }

    #[tokio::test]
    async fn byte_proxy_preserves_http_upgrade_frames_and_has_no_stream_deadline() {
        let (proxy_client, mut client) = tokio::io::duplex(4096);
        let (proxy_server, mut server) = tokio::io::duplex(4096);
        let cancellation = CancellationToken::new();
        let proxy_cancellation = cancellation.clone();
        let proxy = tokio::spawn(async move {
            proxy_test_streams(proxy_client, proxy_server, proxy_cancellation).await
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !proxy.is_finished(),
            "an established idle stream has no timeout"
        );

        let request = b"GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n\0\xff";
        let response = b"HTTP/1.1 101 Switching Protocols\r\n\r\n\x82\x04data";
        client.write_all(request).await.expect("client request");
        let mut received_request = vec![0; request.len()];
        server
            .read_exact(&mut received_request)
            .await
            .expect("server request");
        assert_eq!(received_request, request);
        server.write_all(response).await.expect("server response");
        let mut received_response = vec![0; response.len()];
        client
            .read_exact(&mut received_response)
            .await
            .expect("client response");
        assert_eq!(received_response, response);

        cancellation.cancel();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), proxy)
                .await
                .expect("cancelled proxy joins")
                .expect("proxy task joins")
                .expect("proxy copy succeeds"),
            CopyOutcome::Cancelled
        );
    }

    struct BlockingRunner {
        active: Arc<AtomicUsize>,
        started: Arc<Notify>,
    }

    impl WslForwardRunner for BlockingRunner {
        fn run(
            &self,
            _socket: TcpStream,
            _plan: WslTransportPlan,
            cancellation: CancellationToken,
        ) -> WslForwardFuture {
            let active = self.active.clone();
            let started = self.started.clone();
            Box::pin(async move {
                active.fetch_add(1, Ordering::SeqCst);
                started.notify_waiters();
                cancellation.cancelled().await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn listener_is_loopback_generation_fenced_and_joins_active_forwards() {
        let active = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let handle = WslTransportHandle::start_with_runner(
            WslTransportPlan::new("Ubuntu".to_string(), "/opt/bibcode".to_string(), 4_202, 0)
                .expect("test plan"),
            17,
            Arc::new(BlockingRunner {
                active: active.clone(),
                started: started.clone(),
            }),
        )
        .await
        .expect("loopback listener starts");
        assert!(handle.endpoint().local_addr.ip().is_loopback());
        assert_eq!(handle.endpoint().generation, 17);

        let _connection = TcpStream::connect(handle.endpoint().local_addr)
            .await
            .expect("test client connects");
        tokio::time::timeout(Duration::from_secs(1), async {
            while active.load(Ordering::SeqCst) == 0 {
                let notified = started.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if active.load(Ordering::SeqCst) == 0 {
                    notified.await;
                }
            }
        })
        .await
        .expect("forward starts");

        handle.stop().await.expect("listener and forwards stop");
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(handle.completed_result(), Some(Ok(())));
    }

    #[tokio::test]
    async fn forced_forward_child_termination_always_reaps() {
        let mut command = CommandWrap::with_new(
            std::env::current_exe().expect("test executable"),
            |command| {
                command
                    .args([
                        "--exact",
                        "wsl_transport::tests::forward_child_wait_fixture",
                        "--nocapture",
                    ])
                    .env("BIBCODE_WSL_FORWARD_WAIT_FIXTURE", "1")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
            },
        );
        configure_supervised_background_command_wrap(&mut command);
        let mut child = command.spawn().expect("fixture child starts");
        tokio::time::sleep(Duration::from_millis(50)).await;

        terminate_and_reap(&mut *child)
            .await
            .expect("fixture child is terminated and reaped");
        assert!(child.try_wait().expect("inspect fixture child").is_some());
    }

    #[test]
    fn forward_child_wait_fixture() {
        if std::env::var_os("BIBCODE_WSL_FORWARD_WAIT_FIXTURE").is_some() {
            std::thread::sleep(Duration::from_secs(60));
        }
    }
}
