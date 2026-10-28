//! `bibcode diagnostics download` joined end to end (#201): the command on this host asks
//! its desktop server, a client holding the desktop app's own session approves it, fetches
//! a second (remote) server's bundle over `server.downloadDiagnosticLogs`, checks it names
//! that remote's store the way the app does, and relays it; the command saves it.

use std::{collections::VecDeque, net::SocketAddr, path::PathBuf, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use bibcode_server::{
    ServerConfig, ServerHandle, ServerRuntime,
    diagnostics::relay_cli::{Outcome, download},
};
use futures_util::SinkExt as _;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

#[path = "support/hermetic_providers.rs"]
mod hermetic_providers;
#[path = "support/websocket_frames.rs"]
mod websocket_frames;
use websocket_frames::next_frame_past_heartbeat;

const DESKTOP_BOOTSTRAP: &str = "relay-desktop-bootstrap";
const STEP: Duration = Duration::from_secs(20);

async fn start(config: ServerConfig) -> ServerHandle {
    hermetic_providers::write_hermetic_settings(&config.state_dir(), json!({}));
    ServerRuntime::start(config).await.expect("server starts")
}

async fn exchange(address: SocketAddr, credential: &str) -> String {
    let response = reqwest::Client::new()
        .post(format!("http://{address}/oauth/token"))
        .form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", credential),
            (
                "subject_token_type",
                "urn:bibcode:params:oauth:token-type:environment-bootstrap",
            ),
            (
                "requested_token_type",
                "urn:ietf:params:oauth:token-type:access_token",
            ),
        ])
        .send()
        .await
        .expect("token exchange");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.expect("token JSON");
    body["access_token"]
        .as_str()
        .expect("access token")
        .to_owned()
}

/// One RPC WebSocket, with the frames of other requests kept for later.
struct Rpc {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    held: VecDeque<Value>,
    next_id: u64,
}

impl Rpc {
    async fn connect(address: SocketAddr, token: &str) -> Self {
        let ticket: Value = reqwest::Client::new()
            .post(format!("http://{address}/api/auth/websocket-ticket"))
            .bearer_auth(token)
            .send()
            .await
            .expect("ticket")
            .json()
            .await
            .expect("ticket JSON");
        let ticket = ticket["ticket"].as_str().expect("ticket value");
        let (socket, _) = connect_async(format!("ws://{address}/ws?wsTicket={ticket}"))
            .await
            .expect("RPC socket");
        Self {
            socket,
            held: VecDeque::new(),
            next_id: 100,
        }
    }

    async fn send(&mut self, message: Value) {
        self.socket
            .send(Message::Text(message.to_string().into()))
            .await
            .expect("send");
    }

    async fn request(&mut self, tag: &str, payload: Value) -> String {
        self.next_id += 1;
        let id = self.next_id.to_string();
        self.send(
            json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": [] }),
        )
        .await;
        id
    }

    async fn next_for(&mut self, id: &str) -> Value {
        if let Some(index) = self.held.iter().position(|wire| wire["requestId"] == id) {
            return self.held.remove(index).expect("held frame");
        }
        loop {
            let frame = timeout(STEP, next_frame_past_heartbeat(&mut self.socket))
                .await
                .expect("frame in time")
                .expect("socket open")
                .expect("frame");
            let wire: Value = serde_json::from_str(frame.to_text().expect("text")).expect("JSON");
            if wire["requestId"] == id {
                return wire;
            }
            self.held.push_back(wire);
        }
    }

    async fn unary(&mut self, tag: &str, payload: Value) -> Result<Value, Value> {
        let id = self.request(tag, payload).await;
        let wire = self.next_for(&id).await;
        assert_eq!(wire["_tag"], "Exit", "{wire}");
        if wire["exit"]["_tag"] == "Success" {
            Ok(wire["exit"]["value"].clone())
        } else {
            Err(wire["exit"]["cause"][0]["error"].clone())
        }
    }

    /// The next item of a stream, acknowledged; `Err` with its exit when the stream ended.
    async fn stream_item(&mut self, id: &str) -> Result<Value, Value> {
        let wire = self.next_for(id).await;
        match wire["_tag"].as_str() {
            Some("Chunk") => {
                self.send(json!({ "_tag": "Ack", "requestId": id })).await;
                let values = wire["values"].as_array().expect("values");
                assert_eq!(values.len(), 1, "one relay event per chunk");
                Ok(values[0].clone())
            }
            _ => Err(wire),
        }
    }
}

struct Hosts {
    _local_root: TempDir,
    _remote_root: TempDir,
    local: ServerHandle,
    remote: ServerHandle,
    local_state: PathBuf,
    desktop_token: String,
    remote_token: String,
    remote_storage_id: String,
}

async fn hosts() -> Hosts {
    let remote_root = TempDir::new().expect("remote root");
    let remote = start(ServerConfig::new(remote_root.path()).with_bind("127.0.0.1", 0)).await;
    let remote_token = exchange(
        remote.local_addr(),
        &remote.startup_access().expect("remote pairing").credential,
    )
    .await;
    let local_root = TempDir::new().expect("local root");
    let local_config = ServerConfig::new(local_root.path())
        .with_bind("127.0.0.1", 0)
        .with_desktop(DESKTOP_BOOTSTRAP)
        .expect("desktop configuration");
    let local_state = local_config.state_dir();
    let local = start(local_config).await;
    let desktop_token = exchange(local.local_addr(), DESKTOP_BOOTSTRAP).await;
    let mut probe = Rpc::connect(remote.local_addr(), &remote_token).await;
    let config = probe
        .unary("server.getConfig", json!({}))
        .await
        .expect("remote config");
    let remote_storage_id = config["environment"]["storageInstanceId"]
        .as_str()
        .expect("remote storage id")
        .to_owned();
    Hosts {
        _local_root: local_root,
        _remote_root: remote_root,
        local,
        remote,
        local_state,
        desktop_token,
        remote_token,
        remote_storage_id,
    }
}

/// The desktop app's subscription, waiting until the server counts it.
async fn subscribed_app(hosts: &Hosts) -> (Rpc, String) {
    let mut app = Rpc::connect(hosts.local.local_addr(), &hosts.desktop_token).await;
    let subscription = app
        .request("server.subscribeDiagnosticLogsRelay", json!({}))
        .await;
    // A claim of a request that does not exist answers only once the subscription before it
    // on this socket was dispatched.
    let claimed = app
        .unary(
            "server.claimDiagnosticLogsRelay",
            json!({ "requestId": "none" }),
        )
        .await
        .expect("claim answers");
    assert_eq!(claimed, json!({ "claimed": false }));
    (app, subscription)
}

fn spawn_command(
    hosts: &Hosts,
    environment: &str,
    output: &TempDir,
) -> tokio::task::JoinHandle<Outcome> {
    let state = hosts.local_state.clone();
    let output = output.path().to_owned();
    let environment = environment.to_owned();
    tokio::spawn(async move { download(&state, &environment, false, &output, &mut || {}).await })
}

async fn pending(app: &mut Rpc, subscription: &str) -> Value {
    let event = app.stream_item(subscription).await.expect("pending event");
    assert_eq!(event["_tag"], "Pending", "{event}");
    event["request"].clone()
}

/// What the app does after the user approves: the remote's bundle over that remote's own
/// connection, refused unless its manifest names the store the connection verified.
async fn remote_bundle(hosts: &Hosts) -> (Value, Vec<u8>) {
    let mut remote = Rpc::connect(hosts.remote.local_addr(), &hosts.remote_token).await;
    let id = remote
        .request(
            "server.downloadDiagnosticLogs",
            json!({ "frontendLog": "app warning\n" }),
        )
        .await;
    let mut started = None;
    let mut archive = Vec::new();
    loop {
        let wire = remote.next_for(&id).await;
        match wire["_tag"].as_str() {
            Some("Chunk") => {
                for value in wire["values"].as_array().expect("values") {
                    if value["_tag"] == "Started" {
                        started = Some(value.clone());
                    } else {
                        archive.extend(
                            STANDARD
                                .decode(value["data"].as_str().expect("data"))
                                .expect("base64"),
                        );
                    }
                }
                remote.send(json!({ "_tag": "Ack", "requestId": id })).await;
            }
            Some("Exit") => {
                assert_eq!(wire["exit"]["_tag"], "Success", "{wire}");
                break;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    let started = started.expect("Started");
    assert_eq!(
        started["manifest"]["storageInstanceId"], hosts.remote_storage_id,
        "the app relays only the store its connection verified"
    );
    (started, archive)
}

async fn shutdown(hosts: Hosts) {
    for handle in [hosts.local, hosts.remote] {
        handle.shutdown();
        timeout(Duration::from_secs(10), handle.join())
            .await
            .expect("shutdown in time")
            .expect("server joins");
    }
}

#[tokio::test]
async fn an_approved_request_saves_the_remote_environments_bundle() {
    let hosts = hosts().await;
    assert!(
        hosts.local_state.join("diagnostics-relay.json").is_file(),
        "the running server names its relay endpoint"
    );
    let (mut app, subscription) = subscribed_app(&hosts).await;
    let output = TempDir::new().expect("output");
    let command = spawn_command(&hosts, "Omarchy", &output);

    let request = pending(&mut app, &subscription).await;
    assert_eq!(request["environment"], "Omarchy");
    assert_eq!(request["includeCrashDumps"], false);
    let request_id = request["requestId"]
        .as_str()
        .expect("request id")
        .to_owned();
    // The user allows it.
    let claimed = app
        .unary(
            "server.claimDiagnosticLogsRelay",
            json!({ "requestId": request_id }),
        )
        .await
        .expect("claim");
    assert_eq!(claimed, json!({ "claimed": true }));

    let (started, archive) = remote_bundle(&hosts).await;
    let send = |item: Value| json!({ "requestId": request_id, "item": item });
    app.unary(
        "server.sendDiagnosticLogsRelayItem",
        send(json!({
            "_tag": "Started",
            "fileName": started["fileName"],
            "byteLength": archive.len(),
            "manifest": started["manifest"],
        })),
    )
    .await
    .expect("started accepted");
    for chunk in archive.chunks(64 * 1024) {
        app.unary(
            "server.sendDiagnosticLogsRelayItem",
            send(json!({ "_tag": "Data", "data": STANDARD.encode(chunk) })),
        )
        .await
        .expect("data accepted");
    }
    app.unary(
        "server.sendDiagnosticLogsRelayItem",
        send(json!({ "_tag": "Finished" })),
    )
    .await
    .expect("finished accepted");

    let outcome = timeout(STEP, command)
        .await
        .expect("command ends")
        .expect("command");
    let Outcome::Saved { path, manifest, .. } = &outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(manifest["storageInstanceId"], hosts.remote_storage_id);
    assert!(path.starts_with(std::fs::canonicalize(output.path()).expect("output path")));
    let saved = std::fs::read(path).expect("saved archive");
    assert_eq!(saved, archive);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(saved)).expect("zip");
    let inner: Value = serde_json::from_reader(zip.by_name("manifest.json").expect("manifest"))
        .expect("manifest JSON");
    assert_eq!(
        inner["storageInstanceId"], hosts.remote_storage_id,
        "the remote's logs, not this host's"
    );
    assert_eq!(
        app.stream_item(&subscription).await.expect("closed")["_tag"],
        "Closed"
    );

    // An item after the answer is stale.
    let stale = app
        .unary(
            "server.sendDiagnosticLogsRelayItem",
            send(json!({ "_tag": "Finished" })),
        )
        .await
        .expect_err("stale");
    assert_eq!(stale["reason"], "stale");
    let state = hosts.local_state.clone();
    shutdown(hosts).await;
    assert!(
        !state.join("diagnostics-relay.json").exists(),
        "a stopped server leaves no endpoint behind"
    );
}

#[tokio::test]
async fn a_denied_request_saves_nothing() {
    let hosts = hosts().await;
    let (mut app, subscription) = subscribed_app(&hosts).await;
    let output = TempDir::new().expect("output");
    let command = spawn_command(&hosts, "Omarchy", &output);
    let request_id = pending(&mut app, &subscription).await["requestId"].clone();
    app.unary(
        "server.claimDiagnosticLogsRelay",
        json!({ "requestId": request_id }),
    )
    .await
    .expect("claim");
    app.unary(
        "server.sendDiagnosticLogsRelayItem",
        json!({ "requestId": request_id, "item": { "_tag": "Denied" } }),
    )
    .await
    .expect("denied");
    let outcome = timeout(STEP, command)
        .await
        .expect("command ends")
        .expect("command");
    assert!(matches!(outcome, Outcome::Denied { .. }), "{outcome:?}");
    assert_eq!(outcome.exit_code(), 2);
    assert_eq!(std::fs::read_dir(output.path()).expect("output").count(), 0);
    shutdown(hosts).await;
}

#[tokio::test]
async fn the_approving_window_closing_ends_the_command() {
    let hosts = hosts().await;
    let (mut app, subscription) = subscribed_app(&hosts).await;
    let output = TempDir::new().expect("output");
    let command = spawn_command(&hosts, "Omarchy", &output);
    let request_id = pending(&mut app, &subscription).await["requestId"].clone();
    app.unary(
        "server.claimDiagnosticLogsRelay",
        json!({ "requestId": request_id }),
    )
    .await
    .expect("claim");
    // A reload or quit: the window's connection goes away mid-download.
    app.socket.close(None).await.expect("close");
    drop(app);
    let outcome = timeout(STEP, command)
        .await
        .expect("command ends")
        .expect("command");
    assert!(
        matches!(&outcome, Outcome::Failed { reason, .. } if reason == "connection-lost"),
        "{outcome:?}"
    );
    assert_eq!(std::fs::read_dir(output.path()).expect("output").count(), 0);
    shutdown(hosts).await;
}

#[tokio::test]
async fn the_command_leaving_tells_the_app_to_stop() {
    let hosts = hosts().await;
    let (mut app, subscription) = subscribed_app(&hosts).await;
    let output = TempDir::new().expect("output");
    let command = spawn_command(&hosts, "Omarchy", &output);
    let request_id = pending(&mut app, &subscription).await["requestId"].clone();
    app.unary(
        "server.claimDiagnosticLogsRelay",
        json!({ "requestId": request_id }),
    )
    .await
    .expect("claim");
    // Ctrl-C: the command's connection closes.
    command.abort();
    let closed = app.stream_item(&subscription).await.expect("closed");
    assert_eq!(closed, json!({ "_tag": "Closed", "requestId": request_id }));
    let error = app
        .unary(
            "server.sendDiagnosticLogsRelayItem",
            json!({ "requestId": request_id, "item": { "_tag": "Denied" } }),
        )
        .await
        .expect_err("cancelled");
    assert_eq!(error["reason"], "cancelled");
    shutdown(hosts).await;
}

#[tokio::test]
async fn an_administrative_session_that_is_not_the_desktop_app_cannot_serve() {
    let hosts = hosts().await;
    // An administrative credential minted for another device has every scope, including
    // `access:write`, but is not the desktop app's own session.
    let pairing: Value = reqwest::Client::new()
        .post(format!(
            "http://{}/api/auth/pairing-token",
            hosts.local.local_addr()
        ))
        .bearer_auth(&hosts.desktop_token)
        .json(&json!({
            "label": "Another device",
            "scopes": ["orchestration:read", "access:read", "access:write"],
        }))
        .send()
        .await
        .expect("pairing token")
        .json()
        .await
        .expect("pairing JSON");
    let other_token = exchange(
        hosts.local.local_addr(),
        pairing["credential"].as_str().expect("credential"),
    )
    .await;
    let mut other = Rpc::connect(hosts.local.local_addr(), &other_token).await;
    let subscription = other
        .request("server.subscribeDiagnosticLogsRelay", json!({}))
        .await;
    let refused = other.next_for(&subscription).await;
    assert_eq!(
        refused["exit"]["cause"][0]["error"]["reason"], "not-desktop",
        "{refused}"
    );
    let claim = other
        .unary(
            "server.claimDiagnosticLogsRelay",
            json!({ "requestId": "relay_x" }),
        )
        .await
        .expect_err("refused");
    assert_eq!(claim["reason"], "not-desktop");

    // With no desktop window subscribed, the command learns it at once.
    let output = TempDir::new().expect("output");
    let outcome = download(
        &hosts.local_state,
        "Omarchy",
        false,
        output.path(),
        &mut || {},
    )
    .await;
    assert!(
        matches!(&outcome, Outcome::Unavailable { reason, .. } if reason == "no-app"),
        "{outcome:?}"
    );
    shutdown(hosts).await;
}

#[tokio::test]
async fn the_relay_route_needs_the_endpoint_token() {
    let hosts = hosts().await;
    let response = reqwest::Client::new()
        .post(format!(
            "http://{}/api/diagnostics/relay",
            hosts.local.local_addr()
        ))
        .bearer_auth(&hosts.desktop_token)
        .json(&json!({ "environment": "Omarchy" }))
        .send()
        .await
        .expect("relay request");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "a session token is not the command's token"
    );
    shutdown(hosts).await;
}
