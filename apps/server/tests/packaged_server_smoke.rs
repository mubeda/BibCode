use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{io::AsyncReadExt, process::Child, time::timeout};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

#[path = "support/dpop.rs"]
mod dpop;

struct DenyProxy {
    address: SocketAddr,
    attempts: Arc<Mutex<Vec<String>>>,
    running: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
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
                        stream
                            .set_read_timeout(Some(Duration::from_millis(250)))
                            .expect("deny proxy read timeout");
                        let mut bytes = [0_u8; 512];
                        let length = stream.read(&mut bytes).unwrap_or_default();
                        let request = String::from_utf8_lossy(&bytes[..length])
                            .lines()
                            .next()
                            .unwrap_or("non-http connection")
                            .chars()
                            .take(160)
                            .collect::<String>();
                        worker_attempts
                            .lock()
                            .expect("deny attempts")
                            .push(format!("{peer}: {request}"));
                        let _ = stream.write_all(
                            b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                        );
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

    fn configure(&self, command: &mut tokio::process::Command) {
        let proxy = format!("http://{}", self.address);
        for name in [
            "ALL_PROXY",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "all_proxy",
            "https_proxy",
            "http_proxy",
        ] {
            command.env(name, &proxy);
        }
        command
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost");
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

struct OwnedServer(Option<Child>);

impl OwnedServer {
    fn child_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("packaged server remains owned")
    }

    async fn stop_and_reap(&mut self) {
        let mut child = self.0.take().expect("packaged server remains owned");
        child.kill().await.expect("stop packaged server");
        child.wait().await.expect("reap packaged server");
    }
}

impl Drop for OwnedServer {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.start_kill();
        }
    }
}

fn packaged_binary() -> (PathBuf, bool) {
    match std::env::var_os("BIBCODE_PACKAGED_SERVER_BINARY") {
        Some(value) => {
            let path = PathBuf::from(value);
            assert!(path.is_absolute(), "packaged binary path must be absolute");
            let metadata = std::fs::symlink_metadata(&path).expect("inspect packaged binary");
            assert!(metadata.is_file(), "packaged binary must be a plain file");
            assert!(!metadata.file_type().is_symlink());
            (path, true)
        }
        None => {
            assert_ne!(
                std::env::var("BIBCODE_REQUIRE_PACKAGED_SERVER_BINARY")
                    .ok()
                    .as_deref(),
                Some("1"),
                "native CI requires BIBCODE_PACKAGED_SERVER_BINARY"
            );
            (PathBuf::from(env!("CARGO_BIN_EXE_bibcode")), false)
        }
    }
}

fn work_root() -> (PathBuf, Option<TempDir>) {
    if let Some(value) = std::env::var_os("BIBCODE_PACKAGED_SERVER_WORK_ROOT") {
        let root = PathBuf::from(value);
        assert!(root.is_absolute(), "packaged smoke work root is absolute");
        std::fs::create_dir_all(&root).expect("create packaged smoke work root");
        return (root, None);
    }
    let owner = if Path::new("/tmp").is_dir() {
        tempfile::Builder::new()
            .prefix("bibcode-packaged-")
            .tempdir_in("/tmp")
            .expect("short temporary packaged smoke root")
    } else {
        tempfile::Builder::new()
            .prefix("bibcode-packaged-")
            .tempdir()
            .expect("temporary packaged smoke root")
    };
    (owner.path().to_path_buf(), Some(owner))
}

fn reserve_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .expect("reserve packaged server port")
        .local_addr()
        .expect("packaged server port")
        .port()
}

fn write_disabled_provider_settings(data_root: &Path) {
    let settings = data_root.join("userdata/settings.json");
    std::fs::create_dir_all(settings.parent().expect("settings parent"))
        .expect("create settings parent");
    std::fs::write(
        settings,
        serde_json::to_vec(&json!({
            "providers": {
                "codex": { "enabled": false },
                "claudeAgent": { "enabled": false },
                "cursor": { "enabled": false },
                "grok": { "enabled": false },
                "opencode": { "enabled": false }
            }
        }))
        .expect("settings JSON"),
    )
    .expect("write provider settings");
}

fn runtime_path_without_node(data_root: &Path) -> String {
    let isolated = data_root
        .parent()
        .expect("packaged data root parent")
        .join("empty-runtime-path");
    std::fs::create_dir_all(&isolated).expect("create empty packaged runtime PATH");
    assert_eq!(
        std::fs::read_dir(&isolated)
            .expect("inspect empty packaged runtime PATH")
            .count(),
        0
    );
    isolated
        .to_str()
        .expect("UTF-8 packaged runtime PATH")
        .to_owned()
}

fn spawn_server(
    binary: &Path,
    data_root: &Path,
    port: u16,
    packaged: bool,
    proxy: &DenyProxy,
) -> OwnedServer {
    let mut command = tokio::process::Command::new(binary);
    command.args([
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--base-dir",
        data_root.to_str().expect("UTF-8 packaged data root"),
        "--no-browser",
        "--no-startup-pairing",
    ]);
    if !packaged {
        command.arg("--without-web-ui");
    }
    proxy.configure(&mut command);
    command
        .env("PATH", runtime_path_without_node(data_root))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    OwnedServer(Some(command.spawn().expect("spawn packaged server")))
}

async fn wait_for_descriptor(child: &mut Child, client: &Client, base_url: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait().expect("packaged child status") {
            let mut stdout = String::new();
            let mut stderr = String::new();
            if let Some(mut stream) = child.stdout.take() {
                let _ = stream.read_to_string(&mut stdout).await;
            }
            if let Some(mut stream) = child.stderr.take() {
                let _ = stream.read_to_string(&mut stderr).await;
            }
            panic!("packaged server exited before readiness: {status}: {stdout}\n{stderr}");
        }
        match client
            .get(format!("{base_url}/.well-known/bibcode/environment"))
            .send()
            .await
        {
            Ok(response) if response.status() == StatusCode::OK => {
                return response.json().await.expect("packaged descriptor JSON");
            }
            _ if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            result => panic!("packaged server readiness deadline expired: {result:?}"),
        }
    }
}

async fn create_pairing(binary: &Path, data_root: &Path, proxy: &DenyProxy) -> Value {
    let mut command = tokio::process::Command::new(binary);
    command
        .args([
            "auth",
            "pairing",
            "create",
            "--client-label",
            "Packaged smoke client",
            "--format",
            "json",
            "--base-dir",
        ])
        .arg(data_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    proxy.configure(&mut command);
    let output = timeout(Duration::from_secs(15), command.output())
        .await
        .expect("pairing CLI timeout")
        .expect("pairing CLI output");
    assert!(
        output.status.success(),
        "packaged pairing CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("packaged pairing JSON")
}

async fn assert_authenticated_websocket(
    client: &Client,
    base_url: &str,
    access: &dpop::DpopSession,
) {
    let ticket_url = format!("{base_url}/api/auth/websocket-ticket");
    let response = access
        .authorize(client.post(&ticket_url), "POST", &ticket_url)
        .send()
        .await
        .expect("packaged WebSocket ticket response");
    assert_eq!(response.status(), StatusCode::OK);
    let ticket = response.json::<Value>().await.expect("ticket JSON")["ticket"]
        .as_str()
        .expect("ticket")
        .to_owned();
    let socket_url = format!(
        "{}/ws?wsTicket={ticket}",
        base_url.replacen("http://", "ws://", 1)
    );
    let (mut socket, _) = connect_async(socket_url)
        .await
        .expect("packaged WebSocket admission");
    socket
        .send(Message::Text(
            json!({
                "_tag": "Request",
                "id": "1",
                "tag": "server.getConfig",
                "payload": {},
                "headers": []
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("send packaged RPC request");
    let wire = timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("packaged RPC timeout")
        .expect("packaged RPC frame")
        .expect("packaged RPC wire");
    let value: Value = serde_json::from_str(wire.to_text().expect("packaged RPC text"))
        .expect("packaged RPC JSON");
    assert_eq!(
        value["_tag"], "Exit",
        "unexpected packaged RPC wire: {value}"
    );
    assert_eq!(value["exit"]["_tag"], "Success");
    socket.close(None).await.expect("close packaged WebSocket");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn packaged_binary_pairs_serves_rpc_and_ui_restarts_without_outbound_or_node() {
    let (binary, packaged) = packaged_binary();
    let (work_root, _owner) = work_root();
    let data_root = work_root.join("runtime-data");
    assert!(
        !data_root.exists(),
        "packaged smoke data root must be fresh"
    );
    write_disabled_provider_settings(&data_root);
    let proxy = DenyProxy::start();
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("packaged smoke HTTP client");
    let port = reserve_port();
    let base_url = format!("http://127.0.0.1:{port}");
    let mut server = spawn_server(&binary, &data_root, port, packaged, &proxy);
    let first = wait_for_descriptor(server.child_mut(), &client, &base_url).await;
    let environment_id = first["environmentId"]
        .as_str()
        .expect("packaged environment ID")
        .to_owned();
    let storage_instance_id = first["storageInstanceId"]
        .as_str()
        .expect("packaged storage ID")
        .to_owned();
    Uuid::parse_str(&environment_id).expect("packaged environment UUID");
    Uuid::parse_str(&storage_instance_id).expect("packaged storage UUID");
    assert_ne!(environment_id, storage_instance_id);
    assert_eq!(first["transport"]["mode"], "loopback-http");

    if packaged {
        let ui = client
            .get(format!("{base_url}/"))
            .send()
            .await
            .expect("packaged UI response");
        assert_eq!(ui.status(), StatusCode::OK);
        assert!(
            ui.headers()["content-type"]
                .to_str()
                .expect("UI content type")
                .starts_with("text/html")
        );
    }

    let pairing = create_pairing(&binary, &data_root, &proxy).await;
    let credential = pairing["credential"]
        .as_str()
        .expect("packaged pairing credential")
        .to_owned();
    let expires_at = time::OffsetDateTime::parse(
        pairing["expiresAt"].as_str().expect("pairing expiry"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("pairing RFC3339 expiry");
    let remaining = expires_at - time::OffsetDateTime::now_utc();
    assert!(remaining > time::Duration::ZERO && remaining <= time::Duration::minutes(5));
    let access =
        dpop::exchange_pairing(&client, &format!("{base_url}/oauth/token"), &credential, 91).await;
    let replay =
        dpop::send_pairing_exchange(&client, &format!("{base_url}/oauth/token"), &credential, 92)
            .await;
    assert_eq!(
        replay.status(),
        StatusCode::UNAUTHORIZED,
        "a consumed pairing must remain bound to the first DPoP key"
    );
    assert!(
        !replay
            .text()
            .await
            .expect("pairing replay body")
            .contains(&credential),
        "a rejected pairing replay must not echo the credential"
    );
    assert_authenticated_websocket(&client, &base_url, &access).await;

    server.stop_and_reap().await;
    let mut restarted = spawn_server(&binary, &data_root, port, packaged, &proxy);
    let second = wait_for_descriptor(restarted.child_mut(), &client, &base_url).await;
    assert_eq!(second["environmentId"], environment_id);
    assert_eq!(second["storageInstanceId"], storage_instance_id);
    restarted.stop_and_reap().await;

    let logs = std::fs::read_to_string(data_root.join("userdata/logs/server.log"))
        .expect("packaged server log");
    assert!(
        !logs.contains(&credential),
        "pairing credential must not enter logs"
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        proxy.attempts(),
        Vec::<String>::new(),
        "packaged local lifecycle must make no outbound request"
    );
}
