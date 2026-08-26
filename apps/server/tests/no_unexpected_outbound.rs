use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use reqwest::{Client, StatusCode};
use serde_json::Value;
use tempfile::TempDir;

#[path = "support/dpop.rs"]
mod dpop;

struct DenyProxy {
    address: SocketAddr,
    attempts: Arc<Mutex<Vec<String>>>,
    running: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self(Some(child))
    }

    fn child_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("server child remains owned")
    }

    fn crash_and_reap(&mut self) {
        let mut child = self.0.take().expect("server child remains owned");
        child.kill().expect("intentional crash kill");
        child.wait().expect("crashed child reaped");
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl DenyProxy {
    fn start() -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("deny proxy bind");
        listener
            .set_nonblocking(true)
            .expect("deny proxy nonblocking");
        let address = listener.local_addr().expect("deny proxy address");
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let running = Arc::new(AtomicBool::new(true));
        let worker_attempts = attempts.clone();
        let worker_running = running.clone();
        let worker = thread::spawn(move || {
            while worker_running.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, peer)) => {
                        record_denied_request(&mut stream, peer, &worker_attempts);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("deny proxy accept failed: {error}"),
                }
            }
        });
        Self {
            address,
            attempts,
            running,
            worker: Some(worker),
        }
    }

    fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    fn attempts(&self) -> Vec<String> {
        self.attempts.lock().expect("deny attempts").clone()
    }
}

impl Drop for DenyProxy {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().expect("deny proxy worker joins");
        }
    }
}

fn record_denied_request(
    stream: &mut TcpStream,
    peer: SocketAddr,
    attempts: &Arc<Mutex<Vec<String>>>,
) {
    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .expect("deny proxy read timeout");
    let mut bytes = [0_u8; 512];
    let length = stream.read(&mut bytes).unwrap_or_default();
    let request_line = String::from_utf8_lossy(&bytes[..length])
        .lines()
        .next()
        .unwrap_or("non-http connection")
        .chars()
        .take(160)
        .collect::<String>();
    attempts
        .lock()
        .expect("deny attempts")
        .push(format!("{peer}: {request_line}"));
    let _ = stream
        .write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

fn reserve_loopback_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .expect("reserve server port")
        .local_addr()
        .expect("reserved server address")
        .port()
}

fn isolated_data_root() -> TempDir {
    let preferred_parent = Path::new("/tmp");
    if preferred_parent.is_dir() {
        tempfile::Builder::new()
            .prefix("bibcode-outbound-")
            .tempdir_in(preferred_parent)
            .expect("short temporary data root")
    } else {
        tempfile::Builder::new()
            .prefix("bibcode-outbound-")
            .tempdir()
            .expect("temporary data root")
    }
}

fn configure_deny_proxy(command: &mut Command, proxy: &DenyProxy) {
    for name in [
        "ALL_PROXY",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "all_proxy",
        "https_proxy",
        "http_proxy",
    ] {
        command.env(name, proxy.url());
    }
    command
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env("no_proxy", "127.0.0.1,localhost");
}

fn spawn_server(root: &Path, port: u16, proxy: &DenyProxy) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bibcode"));
    command.args([
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--base-dir",
        root.to_str().expect("UTF-8 data root"),
        "--no-browser",
        "--no-startup-pairing",
    ]);
    configure_deny_proxy(&mut command, proxy);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("server subprocess starts")
}

async fn wait_until_ready(child: &mut Child, client: &Client, base_url: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().expect("server child status") {
            let stdout = child
                .stdout
                .take()
                .map(|mut stream| {
                    let mut output = String::new();
                    let _ = stream.read_to_string(&mut output);
                    output
                })
                .unwrap_or_default();
            let stderr = child
                .stderr
                .take()
                .map(|mut stream| {
                    let mut output = String::new();
                    let _ = stream.read_to_string(&mut output);
                    output
                })
                .unwrap_or_default();
            panic!("server exited before readiness ({status}): {stdout}\n{stderr}");
        }
        match client
            .get(format!("{base_url}/.well-known/bibcode/environment"))
            .send()
            .await
        {
            Ok(response) if response.status() == StatusCode::OK => return,
            _ if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(25)).await,
            result => panic!("server readiness deadline expired: {result:?}"),
        }
    }
}

fn create_pairing(root: &Path, proxy: &DenyProxy) -> String {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bibcode"));
    command.args([
        "auth",
        "pairing",
        "create",
        "--client-label",
        "Outbound policy test",
        "--format",
        "json",
        "--base-dir",
        root.to_str().expect("UTF-8 data root"),
    ]);
    configure_deny_proxy(&mut command, proxy);
    let output = command.output().expect("pairing subprocess starts");
    assert!(
        output.status.success(),
        "pairing CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice::<Value>(&output.stdout).expect("pairing JSON")["credential"]
        .as_str()
        .expect("pairing credential")
        .to_owned()
}

#[tokio::test]
async fn cold_start_local_use_pairing_diagnostics_and_crash_make_no_unexpected_request() {
    let root = isolated_data_root();
    let proxy = DenyProxy::start();
    let port = reserve_loopback_port();
    let base_url = format!("http://127.0.0.1:{port}");
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("local HTTP client");
    let mut child = ChildGuard::new(spawn_server(root.path(), port, &proxy));

    wait_until_ready(child.child_mut(), &client, &base_url).await;
    let session_response = client
        .get(format!("{base_url}/api/auth/session"))
        .send()
        .await
        .expect("ordinary local session request");
    assert_eq!(session_response.status(), StatusCode::OK);

    let credential = create_pairing(root.path(), &proxy);
    let token_url = format!("{base_url}/oauth/token");
    let session = dpop::exchange_pairing(&client, &token_url, &credential, 73).await;

    let diagnostic_url = format!("{base_url}/api/diagnostics/logs.zip");
    let diagnostic_response = session
        .authorize(
            client
                .post(&diagnostic_url)
                .json(&serde_json::json!({ "frontendLog": "outbound policy test" })),
            "POST",
            &diagnostic_url,
        )
        .send()
        .await
        .expect("local diagnostics export");
    assert_eq!(diagnostic_response.status(), StatusCode::OK);
    assert!(
        diagnostic_response
            .bytes()
            .await
            .expect("diagnostic archive")
            .starts_with(b"PK")
    );

    child.crash_and_reap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        proxy.attempts(),
        Vec::<String>::new(),
        "ordinary local scenarios must not reach the deny proxy"
    );
}
