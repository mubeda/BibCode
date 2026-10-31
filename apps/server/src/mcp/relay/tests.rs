//! The relay against a real BiBCode server on this data root, and against listeners that are
//! not BiBCode.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream},
    net::TcpListener,
    sync::Mutex,
};

use super::*;
use crate::{
    ServerConfig, ServerHandle, ServerRuntime, mcp::endpoint::hex, persistence::Repositories,
};

fn options(root: &Path) -> RelayOptions {
    RelayOptions {
        root: crate::data_root::resolve_data_root(crate::data_root::DataRootRequest::explicit(
            crate::data_root::DataRootSource::Cli,
            root.to_path_buf(),
            root.to_path_buf(),
        ))
        .expect("data root"),
        dev_url: None,
        url: None,
        access: None,
    }
}

async fn start_server(root: &Path) -> ServerHandle {
    let providers = crate::test_support::hermetic_providers::BUILTIN_PROVIDER_DRIVERS
        .iter()
        .map(|driver| ((*driver).to_owned(), json!({ "enabled": false })))
        .collect::<serde_json::Map<String, Value>>();
    crate::test_support::hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root).state_dir(),
        json!({ "providers": providers }),
    );
    ServerRuntime::start(ServerConfig::new(root).with_bind("127.0.0.1", 0))
        .await
        .expect("server starts")
}

async fn repositories(root: &Path) -> (Repositories, crate::persistence::Database) {
    let database =
        crate::persistence::Database::open_existing(ServerConfig::new(root).database_path())
            .await
            .expect("database");
    (Repositories::new(database.clone()), database)
}

/// One relay on in-memory pipes: write lines to `input`, read lines from `output`.
struct Running {
    input: DuplexStream,
    output: tokio::io::Lines<BufReader<DuplexStream>>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}

impl Running {
    fn start(options: RelayOptions) -> Self {
        let (input, relay_input) = tokio::io::duplex(1 << 20);
        let (relay_output, output) = tokio::io::duplex(1 << 20);
        let task = tokio::spawn(run(
            options,
            BufReader::new(relay_input),
            relay_output,
            std::future::pending(),
        ));
        Self {
            input,
            output: BufReader::new(output).lines(),
            task,
        }
    }

    async fn send(&mut self, message: Value) {
        self.input
            .write_all(format!("{message}\n").as_bytes())
            .await
            .expect("relay input");
    }

    async fn line(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(20), self.output.next_line())
            .await
            .expect("a line in time")
            .expect("relay output")
            .expect("a line before EOF");
        serde_json::from_str(&line).expect("one JSON-RPC message per line")
    }

    /// Ends stdin and waits for the relay, which revokes its credential on the way out.
    async fn close(self) -> Result<(), String> {
        drop(self.input);
        self.task.await.expect("relay task")
    }
}

/// A standard credential, for setting up data with ordinary HTTP routes.
async fn admin_token(root: &Path, base: &str) -> String {
    let (repositories, database) = repositories(root).await;
    let link = crate::auth::issue_administrative_pairing_link(&repositories, None)
        .await
        .expect("link");
    database.close().await;
    let response: Value = reqwest::Client::new()
        .post(format!("{base}/oauth/token"))
        .form(&[
            ("grant_type", crate::auth::TOKEN_GRANT_TYPE),
            ("subject_token", link.credential.as_str()),
            ("subject_token_type", crate::auth::BOOTSTRAP_TOKEN_TYPE),
            ("requested_token_type", crate::auth::ACCESS_TOKEN_TYPE),
        ])
        .send()
        .await
        .expect("token")
        .json()
        .await
        .expect("token body");
    response["access_token"].as_str().expect("token").to_owned()
}

async fn dispatch(base: &str, token: &str, command: Value) {
    let response = reqwest::Client::new()
        .post(format!("{base}/api/orchestration/dispatch"))
        .bearer_auth(token)
        .json(&command)
        .send()
        .await
        .expect("dispatch");
    assert!(
        response.status().is_success(),
        "{}",
        response.text().await.unwrap_or_default()
    );
}

async fn mcp_sessions(
    root: &Path,
) -> Vec<(String, Option<String>, Option<String>, Option<String>)> {
    let (repositories, database) = repositories(root).await;
    let rows = repositories
        .database()
        .call(|connection| {
            let mut statement = connection.prepare(
                "SELECT session_id, client_label, mcp_access, revoked_at FROM auth_sessions WHERE subject = 'mcp-client' ORDER BY issued_at",
            )?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
        .expect("sessions");
    database.close().await;
    rows
}

async fn mcp_links(root: &Path) -> i64 {
    let (repositories, database) = repositories(root).await;
    let count = repositories
        .database()
        .call(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM auth_pairing_links WHERE subject = 'mcp-client'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .expect("links");
    database.close().await;
    count
}

#[tokio::test]
async fn the_relay_serves_a_legacy_agent_concurrently_and_revokes_on_eof() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let base = format!("http://{}", server.local_addr());
    let admin = admin_token(root.path(), &base).await;
    dispatch(
        &base,
        &admin,
        json!({
            "type": "project.create", "commandId": "project", "projectId": "p1", "title": "P",
            "workspaceRoot": root.path(), "createdAt": "2026-10-30T00:00:00.000Z",
        }),
    )
    .await;
    dispatch(
        &base,
        &admin,
        json!({
            "type": "thread.create", "commandId": "thread", "threadId": "t1", "projectId": "p1",
            "title": "T", "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
            "worktreePath": null, "createdAt": "2026-10-30T00:00:00.000Z",
        }),
    )
    .await;

    // An orphan: a credential whose relay process is gone.
    let (repositories, database) = repositories(root.path()).await;
    let link = crate::auth::issue_mcp_pairing_link(
        &repositories,
        "MCP · crashed".into(),
        "read-only",
        &[],
    )
    .await
    .unwrap();
    database.close().await;
    let orphan: Value = reqwest::Client::new()
        .post(format!("{base}/oauth/token"))
        .form(&[
            ("grant_type", crate::auth::TOKEN_GRANT_TYPE),
            ("subject_token", link.credential.as_str()),
            ("subject_token_type", crate::auth::BOOTSTRAP_TOKEN_TYPE),
            ("requested_token_type", crate::auth::ACCESS_TOKEN_TYPE),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let orphan_sid = session_id_of(orphan["access_token"].as_str().unwrap()).unwrap();
    let state_dir = ServerConfig::new(root.path()).state_dir();
    std::fs::create_dir_all(state_dir.join(CLIENT_RECORDS_DIR)).unwrap();
    std::fs::write(
        client_record_path(&state_dir, &orphan_sid),
        json!({ "pid": u32::MAX - 1, "processStartedAt": 1 }).to_string(),
    )
    .unwrap();

    let mut relay = Running::start(options(root.path()));
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "Test Agent", "version": "1" },
        }}))
        .await;
    let initialized = relay.line().await;
    assert_eq!(
        initialized["result"]["protocolVersion"], "2025-11-25",
        "{initialized}"
    );
    relay
        .send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .await;

    // A wait with progress, and a list sent after it that answers first.
    relay
        .send(
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
                "name": "wait_for_thread",
                "arguments": { "threadId": "t1", "messageId": "not-yet", "timeoutMs": 1_500 },
                "_meta": { "progressToken": "wait-2" },
            }}),
        )
        .await;
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }))
        .await;
    let mut order = Vec::new();
    let mut progress_before_result = false;
    for _ in 0..3 {
        let line = relay.line().await;
        if line["method"] == "notifications/progress" {
            assert_eq!(line["params"]["progressToken"], "wait-2");
            progress_before_result = !order.contains(&json!(2));
            order.push(json!("progress"));
        } else {
            order.push(line["id"].clone());
            if line["id"] == 3 {
                assert!(
                    line["result"]["tools"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|tool| tool["name"] == "start_thread"),
                    "{line}"
                );
            }
            if line["id"] == 2 {
                assert_eq!(
                    line["result"]["structuredContent"]["timedOut"], true,
                    "{line}"
                );
            }
        }
    }
    assert!(progress_before_result, "{order:?}");
    let list_at = order.iter().position(|item| item == &json!(3)).unwrap();
    let wait_at = order.iter().position(|item| item == &json!(2)).unwrap();
    assert!(list_at < wait_at, "a wait never blocks a list: {order:?}");

    // A cancelled call gets no answer, and the relay keeps serving.
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "wait_for_thread", "arguments": { "threadId": "t1", "messageId": "not-yet", "timeoutMs": 20_000 },
        }}))
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    relay
        .send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 4 } }))
        .await;
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 5, "method": "ping" }))
        .await;
    assert_eq!(relay.line().await["id"], 5);

    let sessions = mcp_sessions(root.path()).await;
    let orphaned = sessions
        .iter()
        .find(|session| session.0 == orphan_sid)
        .unwrap();
    assert!(
        orphaned.3.is_some(),
        "the orphan sweep revoked a dead relay's credential"
    );
    assert!(!client_record_path(&state_dir, &orphan_sid).exists());
    let ours = sessions
        .iter()
        .find(|session| session.1.as_deref() == Some("MCP · Test Agent"))
        .expect("this relay's credential, labelled with the agent's name")
        .clone();
    assert_eq!(ours.2.as_deref(), Some("approval-required"));
    assert!(ours.3.is_none());
    assert!(client_record_path(&state_dir, &ours.0).exists());

    relay.close().await.expect("relay ends cleanly");
    let revoked = mcp_sessions(root.path())
        .await
        .into_iter()
        .find(|session| session.0 == ours.0)
        .unwrap();
    assert!(revoked.3.is_some(), "EOF revokes the credential");
    assert!(!client_record_path(&state_dir, &ours.0).exists());
    server.shutdown();
    server.join().await.expect("server joins");
}

#[tokio::test]
async fn a_revoked_relay_is_told_so_and_never_mints_again() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let mut relay = Running::start(RelayOptions {
        access: Some(McpAccess::ReadOnly),
        ..options(root.path())
    });
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .await;
    let listed = relay.line().await;
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(
        !names.contains(&"start_thread"),
        "a read-only credential: {names:?}"
    );
    let sessions = mcp_sessions(root.path()).await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].2.as_deref(), Some("read-only"));
    let links = mcp_links(root.path()).await;

    // Revoked in Authorized clients (here, through the data root).
    let (repositories, database) = repositories(root.path()).await;
    repositories
        .revoke_auth_session(
            sessions[0].0.clone(),
            crate::auth::format_iso(crate::auth::now_ms()),
        )
        .await
        .unwrap();
    database.close().await;
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "read_thread", "arguments": { "threadId": "t" } } }))
        .await;
    let refused = relay.line().await;
    assert_eq!(refused["result"]["isError"], true, "{refused}");
    assert_eq!(refused["result"]["content"][0]["text"], REVOKED_MESSAGE);
    assert_eq!(
        refused["result"]["structuredContent"]["error"]["_tag"], "McpCredentialRefusedError",
        "a refused credential is a typed tool result (slice X3)"
    );
    assert_eq!(mcp_links(root.path()).await, links, "401 never mints again");
    relay.close().await.expect("relay ends");
    server.shutdown();
    server.join().await.expect("server joins");
}

#[tokio::test]
async fn a_server_that_stopped_is_a_typed_tool_result_and_other_requests_an_error() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let mut relay = Running::start(options(root.path()));
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .await;
    assert!(relay.line().await["result"]["tools"].is_array());
    server.shutdown();
    server.join().await.expect("server joins");
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "read_thread", "arguments": { "threadId": "t" } } }))
        .await;
    let unreachable = relay.line().await;
    assert_eq!(unreachable["id"], 2);
    assert_eq!(unreachable["result"]["isError"], true, "{unreachable}");
    assert_eq!(
        unreachable["result"]["structuredContent"]["error"]["_tag"], "McpServerUnreachableError",
        "{unreachable}"
    );
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }))
        .await;
    let listed = relay.line().await;
    assert_eq!(listed["id"], 3);
    assert!(listed["error"]["message"].is_string(), "{listed}");
    relay.close().await.expect("relay ends");
}

#[tokio::test]
async fn after_a_restart_on_another_port_the_next_call_works_without_reinitializing() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let first_port = server.local_addr().port();
    let mut relay = Running::start(options(root.path()));
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "a", "version": "1" } } }))
        .await;
    assert_eq!(
        relay.line().await["result"]["protocolVersion"],
        "2025-06-18"
    );
    server.shutdown();
    server.join().await.expect("server joins");
    let server = start_server(root.path()).await;
    assert_ne!(server.local_addr().port(), first_port);
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
        .await;
    let listed = relay.line().await;
    assert!(listed["result"]["tools"].is_array(), "{listed}");
    relay.close().await.expect("relay ends");
    server.shutdown();
    server.join().await.expect("server joins");
}

fn write_record(state_dir: &Path, pid: u32, dial_host: Option<&str>, port: u16, key: &[u8; 32]) {
    std::fs::create_dir_all(state_dir).unwrap();
    std::fs::write(
        state_dir.join(crate::mcp::endpoint::ENDPOINT_RECORD_FILE),
        json!({
            "version": RECORD_VERSION, "pid": pid, "dialHost": dial_host, "port": port,
            "bootId": "boot", "startedAt": "2026-10-30T00:00:00Z", "proofKey": hex(key),
        })
        .to_string(),
    )
    .unwrap();
}

/// A listener that is not BiBCode: it records every request and answers each with `answer`.
async fn impostor(answer: &'static str) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0_u8; 8192];
                let read = tokio::io::AsyncReadExt::read(&mut socket, &mut buffer)
                    .await
                    .unwrap_or(0);
                recorded
                    .lock()
                    .await
                    .push(String::from_utf8_lossy(&buffer[..read]).into_owned());
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                    answer.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (port, seen)
}

async fn refused(options: RelayOptions) -> String {
    let (_input, relay_input) = tokio::io::duplex(1024);
    let (relay_output, _output) = tokio::io::duplex(1024);
    run(
        options,
        BufReader::new(relay_input),
        relay_output,
        std::future::pending(),
    )
    .await
    .expect_err("the relay refuses to start")
}

#[tokio::test]
async fn the_relay_refuses_to_start_before_any_credential_exists() {
    let root = tempfile::tempdir().expect("root");
    let state_dir = ServerConfig::new(root.path()).state_dir();

    // No server.
    assert_eq!(refused(options(root.path())).await, NO_SERVER_MESSAGE);

    // Turned off: refused first, naming the setting.
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::write(
        state_dir.join("settings.json"),
        r#"{"enableMcpServer":false}"#,
    )
    .unwrap();
    assert_eq!(refused(options(root.path())).await, DISABLED_EXIT_MESSAGE);
    std::fs::write(
        state_dir.join("settings.json"),
        r#"{"mcpServerAccess":"approval-required"}"#,
    )
    .unwrap();

    // Asking for more than the setting allows.
    let error = refused(RelayOptions {
        access: Some(McpAccess::FullAccess),
        ..options(root.path())
    })
    .await;
    assert!(error.contains("--access full-access is above"), "{error}");

    // A non-loopback --url.
    let error = refused(RelayOptions {
        url: Some("http://192.168.1.4:3773/".parse().unwrap()),
        ..options(root.path())
    })
    .await;
    assert!(
        error.starts_with("--url must name this computer's loopback address"),
        "{error}"
    );

    let key = [5_u8; 32];
    // A stale record whose process is gone.
    write_record(&state_dir, u32::MAX - 1, Some("127.0.0.1"), 1, &key);
    assert_eq!(refused(options(root.path())).await, NO_SERVER_MESSAGE);
    // A server that listens on no loopback address.
    write_record(&state_dir, std::process::id(), None, 1, &key);
    assert_eq!(
        refused(options(root.path())).await,
        "This BiBCode server does not listen on this computer's loopback address."
    );
    // A replacement listener on the recorded port cannot answer the proof, and receives
    // neither a sign-in nor an Authorization header.
    let (port, seen) = impostor(r#"{"proof":"00"}"#).await;
    write_record(
        &state_dir,
        std::process::id(),
        Some("127.0.0.1"),
        port,
        &key,
    );
    let error = refused(options(root.path())).await;
    assert!(error.starts_with("The program listening on"), "{error}");
    let requests = seen.lock().await.clone();
    assert!(!requests.is_empty());
    for request in &requests {
        assert!(!request.contains("/oauth/token"), "{request}");
        assert!(
            !request.to_ascii_lowercase().contains("authorization:"),
            "{request}"
        );
    }
    // No credential was ever minted: there is not even a store.
    assert!(!ServerConfig::new(root.path()).database_path().exists());
}

#[tokio::test]
async fn a_listener_that_forwards_the_proof_to_the_real_server_fails_it() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let state_dir = ServerConfig::new(root.path()).state_dir();
    let record = EndpointRecord::read(&state_dir).unwrap().expect("record");
    let real = server.local_addr();
    // Forward everything to the real server, from another port.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let forward_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            tokio::spawn(async move {
                if let Ok(mut outbound) = tokio::net::TcpStream::connect(real).await {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            });
        }
    });
    write_record(
        &state_dir,
        std::process::id(),
        Some("127.0.0.1"),
        forward_port,
        &record.key().unwrap(),
    );
    let error = refused(options(root.path())).await;
    assert!(error.starts_with("The program listening on"), "{error}");
    server.shutdown();
    server.join().await.expect("server joins");
}

/// A listener on `bind` that forwards every connection to `to`, recording what it was sent.
async fn forwarder(
    bind: std::net::SocketAddr,
    to: std::net::SocketAddr,
) -> Option<Arc<Mutex<Vec<u8>>>> {
    let listener = TcpListener::bind(bind).await.ok()?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    tokio::spawn(async move {
        while let Ok((inbound, _)) = listener.accept().await {
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let Ok(outbound) = tokio::net::TcpStream::connect(to).await else {
                    return;
                };
                let (mut inbound_read, mut inbound_write) = inbound.into_split();
                let (mut outbound_read, mut outbound_write) = outbound.into_split();
                tokio::spawn(async move {
                    let _ = tokio::io::copy(&mut outbound_read, &mut inbound_write).await;
                });
                let mut buffer = vec![0_u8; 8192];
                while let Ok(read) =
                    tokio::io::AsyncReadExt::read(&mut inbound_read, &mut buffer).await
                {
                    if read == 0 {
                        break;
                    }
                    recorded.lock().await.extend_from_slice(&buffer[..read]);
                    if outbound_write.write_all(&buffer[..read]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    Some(seen)
}

/// The relay's start, bounded: a relay that passed every check serves forever.
async fn refused_in_time(options: RelayOptions) -> String {
    tokio::time::timeout(Duration::from_secs(20), refused(options))
        .await
        .expect("the relay refused to start in time")
}

/// Another local user may listen on `[::1]:P` while BiBCode listens on `127.0.0.1:P`, and
/// forward to it. The proof names the address as well as the port, and `--url` must name the
/// record's listener, so the forwarder never receives a pairing link.
#[tokio::test]
async fn the_other_loopback_family_on_the_same_port_is_another_listener() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let real = server.local_addr();
    let state_dir = ServerConfig::new(root.path()).state_dir();
    let record = EndpointRecord::read(&state_dir).unwrap().expect("record");
    assert_eq!(record.dial_host.as_deref(), Some("127.0.0.1"));
    if TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, 0))
        .await
        .is_err()
    {
        eprintln!("skipped: this host has no IPv6 loopback");
        server.shutdown();
        server.join().await.expect("server joins");
        return;
    }
    let split = std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, real.port()));
    let seen = forwarder(split, real)
        .await
        .unwrap_or_else(|| panic!("listen on {split} beside {real}"));
    // Named with --url, it is not the record's listener.
    let error = refused_in_time(RelayOptions {
        url: Some(format!("http://{split}/").parse().unwrap()),
        ..options(root.path())
    })
    .await;
    assert!(error.contains("--url"), "{error}");
    // Named by the record itself (a record only this user can write), the proof the real
    // server signs for 127.0.0.1 does not verify for [::1].
    write_record(
        &state_dir,
        std::process::id(),
        Some("::1"),
        real.port(),
        &record.key().unwrap(),
    );
    let error = refused_in_time(options(root.path())).await;
    assert!(error.starts_with("The program listening on"), "{error}");
    let forwarded = String::from_utf8_lossy(&seen.lock().await).into_owned();
    assert!(!forwarded.contains("/oauth/token"), "{forwarded}");
    assert!(
        !forwarded.to_ascii_lowercase().contains("authorization:"),
        "{forwarded}"
    );
    assert_eq!(
        mcp_links(root.path()).await,
        0,
        "no pairing link was minted"
    );
    server.shutdown();
    server.join().await.expect("server joins");
}

/// `--url` may name the record's own listener, by its address or as `localhost`; the relay
/// then dials the record's address, so `localhost` never resolves to another listener.
#[tokio::test]
async fn a_url_that_names_the_records_listener_is_served() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let port = server.local_addr().port();
    for url in [
        format!("http://127.0.0.1:{port}/"),
        format!("http://localhost:{port}"),
    ] {
        let mut relay = Running::start(RelayOptions {
            url: Some(url.parse().unwrap()),
            ..options(root.path())
        });
        relay
            .send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
            .await;
        let listed = relay.line().await;
        assert!(listed["result"]["tools"].is_array(), "{url}: {listed}");
        relay.close().await.expect("relay ends");
    }
    // Another port is refused before any request.
    let error = refused_in_time(RelayOptions {
        url: Some(
            format!("http://127.0.0.1:{}/", port.wrapping_add(1))
                .parse()
                .unwrap(),
        ),
        ..options(root.path())
    })
    .await;
    assert!(error.contains("--url"), "{error}");
    server.shutdown();
    server.join().await.expect("server joins");
}

/// The runtime guard is a shared lock, so a second server for the data root on another port
/// starts. The first, still running and answering its proof, keeps the record: the second's
/// start and stop leave it alone, and relays still reach the first.
#[tokio::test]
async fn a_second_server_on_another_port_leaves_the_running_servers_record() {
    let root = tempfile::tempdir().expect("root");
    let first = start_server(root.path()).await;
    let state_dir = ServerConfig::new(root.path()).state_dir();
    let record = || std::fs::read(state_dir.join(crate::mcp::endpoint::ENDPOINT_RECORD_FILE));
    let before = record().expect("record");
    let second = start_server(root.path()).await;
    assert_ne!(second.local_addr().port(), first.local_addr().port());
    assert_eq!(record().expect("record"), before, "the first keeps it");
    // The second still runs normally.
    let health = reqwest::Client::new()
        .get(format!(
            "http://{}{}",
            second.local_addr(),
            crate::http::ENVIRONMENT_DESCRIPTOR_PATH
        ))
        .send()
        .await
        .expect("the second answers");
    assert!(health.status().is_success(), "{}", health.status());
    second.shutdown();
    second.join().await.expect("second joins");
    assert_eq!(
        record().expect("record"),
        before,
        "the second's stop leaves it"
    );
    let mut relay = Running::start(options(root.path()));
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .await;
    assert!(relay.line().await["result"]["tools"].is_array());
    relay.close().await.expect("relay ends");
    first.shutdown();
    first.join().await.expect("first joins");
    assert!(record().is_err(), "the first removes its own record");
}

/// A second server for the data root on the running server's port fails to bind, which comes
/// before the record is written, so the running server's record stays.
#[tokio::test]
async fn a_second_server_that_cannot_start_leaves_the_record_alone() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let state_dir = ServerConfig::new(root.path()).state_dir();
    let record = || std::fs::read(state_dir.join(crate::mcp::endpoint::ENDPOINT_RECORD_FILE));
    let before = record().expect("record");
    let second = tokio::time::timeout(
        Duration::from_secs(30),
        ServerRuntime::start(
            ServerConfig::new(root.path()).with_bind("127.0.0.1", server.local_addr().port()),
        ),
    )
    .await
    .expect("the second start ends");
    assert!(second.is_err(), "the port is taken");
    assert_eq!(record().expect("record"), before);
    // The running server is still the one a relay reaches.
    let mut relay = Running::start(options(root.path()));
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .await;
    assert!(relay.line().await["result"]["tools"].is_array());
    relay.close().await.expect("relay ends");
    server.shutdown();
    server.join().await.expect("server joins");
}

/// A legacy client's negotiated version goes on every later request as `MCP-Protocol-Version`,
/// and the relay never sends an `Mcp-Session-Id`.
#[tokio::test]
async fn a_legacy_clients_version_is_sent_on_every_later_request() {
    let (port, seen) =
        impostor(r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}"#).await;
    let root = tempfile::tempdir().expect("root");
    let relay = Relay {
        connection: Connection {
            options: options(root.path()),
            state_dir: root.path().to_path_buf(),
            http: reqwest::Client::builder().no_proxy().build().unwrap(),
            access: McpAccess::ReadOnly,
            endpoint: Mutex::new(Endpoint {
                base: format!("http://127.0.0.1:{port}/").parse().unwrap(),
            }),
            credential: Mutex::new(Some(Credential {
                token: "test-bearer".into(),
                session_id: "test-session".into(),
            })),
        },
        legacy_version: std::sync::Mutex::new(None),
    };
    let (lines, _frames) = mpsc::channel(4);
    let initialized = relay
        .forward(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "a", "version": "1" },
            }}),
            &lines,
        )
        .await
        .expect("an answer");
    assert!(initialized.contains("2025-06-18"), "{initialized}");
    for id in [2, 3] {
        relay
            .forward(
                json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list" }),
                &lines,
            )
            .await
            .expect("an answer");
    }
    let requests: Vec<String> = seen
        .lock()
        .await
        .iter()
        .map(|request| request.to_ascii_lowercase())
        .collect();
    assert_eq!(requests.len(), 3, "{requests:?}");
    assert!(
        !requests[0].contains("mcp-protocol-version"),
        "{}",
        requests[0]
    );
    for request in &requests[1..] {
        assert!(
            request.contains("mcp-protocol-version: 2025-06-18"),
            "{request}"
        );
    }
    for request in &requests {
        assert!(!request.contains("mcp-session-id"), "{request}");
        assert!(
            request.contains("authorization: bearer test-bearer"),
            "{request}"
        );
    }
}

/// Waits up to 5 s for the server's event stream to have `expected` receivers.
async fn receivers_reach(server: &ServerHandle, expected: usize) -> usize {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let count = server.event_subscriber_count_for_test().expect("runtime");
        if count == expected || tokio::time::Instant::now() > deadline {
            return count;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A stdio `notifications/cancelled` ends the server's wait too: the receiver it held on the
/// engine's event stream is released, long before the wait's own timeout.
#[tokio::test]
async fn a_cancelled_wait_releases_the_servers_receiver() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let base = format!("http://{}", server.local_addr());
    let admin = admin_token(root.path(), &base).await;
    dispatch(
        &base,
        &admin,
        json!({
            "type": "project.create", "commandId": "project", "projectId": "p1", "title": "P",
            "workspaceRoot": root.path(), "createdAt": "2026-10-30T00:00:00.000Z",
        }),
    )
    .await;
    dispatch(
        &base,
        &admin,
        json!({
            "type": "thread.create", "commandId": "thread", "threadId": "t1", "projectId": "p1",
            "title": "T", "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
            "worktreePath": null, "createdAt": "2026-10-30T00:00:00.000Z",
        }),
    )
    .await;
    let mut relay = Running::start(options(root.path()));
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "a", "version": "1" },
        }}))
        .await;
    relay.line().await;
    let baseline = server.event_subscriber_count_for_test().expect("runtime");
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "wait_for_thread", "arguments": { "threadId": "t1", "messageId": "not-yet", "timeoutMs": 40_000 },
        }}))
        .await;
    assert_eq!(receivers_reach(&server, baseline + 1).await, baseline + 1);
    relay
        .send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 2 } }))
        .await;
    assert_eq!(
        receivers_reach(&server, baseline).await,
        baseline,
        "the server still holds the cancelled wait's receiver"
    );
    relay
        .send(json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }))
        .await;
    assert_eq!(
        relay.line().await["id"],
        3,
        "no answer for the cancelled call"
    );
    relay.close().await.expect("relay ends");
    server.shutdown();
    server.join().await.expect("server joins");
}

/// One tool call through the relay; its `structuredContent`, or the whole answer on an error.
async fn call_tool(relay: &mut Running, id: i64, name: &str, arguments: Value) -> Value {
    relay
        .send(json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": arguments } }))
        .await;
    let answer = relay.line().await;
    assert_eq!(answer["id"], id, "{answer}");
    if answer["result"]["isError"] == true {
        answer
    } else {
        answer["result"]["structuredContent"].clone()
    }
}

/// The real server end to end, through the relay, with every provider turned off so no
/// provider runs: the provider list, the Default Agent's model for a start that names none,
/// and a thread's Git status.
#[tokio::test]
async fn the_tools_read_the_servers_providers_defaults_and_git() {
    let root = tempfile::tempdir().expect("root");
    let mut providers = crate::test_support::hermetic_providers::BUILTIN_PROVIDER_DRIVERS
        .iter()
        .map(|driver| ((*driver).to_owned(), json!({ "enabled": false })))
        .collect::<serde_json::Map<String, Value>>();
    providers.insert(
        "codex".into(),
        json!({ "enabled": true, "binaryPath": root.path().join("no-such-codex") }),
    );
    crate::test_support::hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root.path()).state_dir(),
        json!({
            "providers": providers,
            "defaultAgent": { "kind": "chat", "instanceId": "codex" },
            "providerSessionDefaults": { "codex": { "model": "gpt-5.1-codex" } },
        }),
    );
    let server = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("server starts");
    let base = format!("http://{}", server.local_addr());
    let admin = admin_token(root.path(), &base).await;
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let git = crate::test_support::isolated_git_config::IsolatedGitConfig::new();
    let mut init = std::process::Command::new("git");
    git.apply_to_command(&mut init);
    let status = init
        .args(["init", "--quiet", "--initial-branch=main"])
        .current_dir(&workspace)
        .status()
        .expect("git init");
    assert!(status.success());
    std::fs::write(workspace.join("notes.txt"), "draft\n").unwrap();
    dispatch(
        &base,
        &admin,
        json!({
            "type": "project.create", "commandId": "project", "projectId": "p1", "title": "P",
            "workspaceRoot": workspace, "defaultModelSelection": null,
            "createdAt": "2026-10-30T00:00:00.000Z",
        }),
    )
    .await;
    dispatch(
        &base,
        &admin,
        json!({
            "type": "thread.create", "commandId": "thread", "threadId": "t1", "projectId": "p1",
            "title": "T", "modelSelection": { "instanceId": "codex", "model": "gpt-5" },
            "runtimeMode": "approval-required", "interactionMode": "default", "branch": null,
            "worktreePath": null, "createdAt": "2026-10-30T00:00:00.000Z",
        }),
    )
    .await;
    let mut relay = Running::start(options(root.path()));

    let listed = call_tool(&mut relay, 1, "list_providers_and_models", json!({})).await;
    let providers = listed["providers"]
        .as_array()
        .unwrap_or_else(|| panic!("providers: {listed}"));
    assert!(!providers.is_empty(), "{listed}");
    let codex = providers
        .iter()
        .find(|provider| provider["providerInstanceId"] == "codex")
        .unwrap_or_else(|| panic!("codex is listed: {listed}"));
    assert_eq!(codex["defaultAgent"], true, "{codex}");
    for model in codex["models"].as_array().expect("models") {
        assert!(
            model["model"].is_string() && model["default"].is_boolean(),
            "{model}"
        );
    }

    let started = call_tool(
        &mut relay,
        2,
        "start_thread",
        json!({ "projectId": "p1", "prompt": "Say hello" }),
    )
    .await;
    assert_eq!(
        started["modelSelection"],
        json!({ "instanceId": "codex", "model": "gpt-5.1-codex" }),
        "{started}"
    );
    assert_eq!(started["runtimeMode"], "approval-required");

    let status = call_tool(&mut relay, 3, "git_status", json!({ "threadId": "t1" })).await;
    assert_eq!(status["isRepo"], true, "{status}");
    assert_eq!(status["hasWorkingTreeChanges"], true, "{status}");
    assert!(
        status["files"]
            .as_array()
            .expect("files")
            .iter()
            .any(|file| file.to_string().contains("notes.txt")),
        "{status}"
    );
    relay.close().await.expect("relay ends");
    server.shutdown();
    server.join().await.expect("server joins");
}

/// Audience binding: an `mcp-client` credential authenticates `/mcp` only. On every other route
/// a request bearing it is answered exactly as one bearing nothing.
#[tokio::test]
async fn an_mcp_credential_is_no_credential_on_every_other_route() {
    let root = tempfile::tempdir().expect("root");
    let server = start_server(root.path()).await;
    let base = format!("http://{}", server.local_addr());
    let (repositories, database) = repositories(root.path()).await;
    let link = crate::auth::issue_mcp_pairing_link(
        &repositories,
        "MCP · audience".into(),
        "full-access",
        &[],
    )
    .await
    .unwrap();
    database.close().await;
    let exchanged: Value = reqwest::Client::new()
        .post(format!("{base}/oauth/token"))
        .form(&[
            ("grant_type", crate::auth::TOKEN_GRANT_TYPE),
            ("subject_token", link.credential.as_str()),
            ("subject_token_type", crate::auth::BOOTSTRAP_TOKEN_TYPE),
            ("requested_token_type", crate::auth::ACCESS_TOKEN_TYPE),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = exchanged["access_token"].as_str().unwrap().to_owned();
    let http = reqwest::Client::new();
    let send = |method: &str, path: &str, bearer: Option<&str>| {
        let mut request = http
            .request(method.parse().unwrap(), format!("{base}{path}"))
            .header("content-type", "application/json")
            .body("{}");
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        request.send()
    };
    let mut checked = 0;
    for route in crate::ROUTE_INVENTORY {
        if route.path == "*" || route.path == "/mcp" {
            continue;
        }
        let path = route.path.replace('*', "x");
        let with = send(route.method, &path, Some(&token)).await.unwrap();
        let without = send(route.method, &path, None).await.unwrap();
        if route.path == crate::mcp::endpoint::PROOF_PATH {
            // The one unauthenticated MCP route: it reads no bearer at all.
            assert_eq!(with.status(), without.status(), "{}", route.path);
            continue;
        }
        assert_eq!(
            with.status(),
            without.status(),
            "{} {} treated the MCP credential as a credential",
            route.method,
            route.path
        );
        if with.status().is_success() {
            let (with, without) = (with.text().await.unwrap(), without.text().await.unwrap());
            assert_eq!(
                with, without,
                "{} {} answered the MCP credential differently",
                route.method, route.path
            );
        }
        checked += 1;
    }
    assert!(checked > 30, "{checked}");
    // And `/mcp` does accept it.
    let listed: Value = http
        .post(format!("{base}/mcp"))
        .bearer_auth(&token)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(listed["result"]["tools"].is_array(), "{listed}");
    server.shutdown();
    server.join().await.expect("server joins");
}

#[test]
fn a_credential_carries_the_terminal_scope_only_with_terminals_on_at_full_access() {
    let mut settings = McpServerSettings {
        access: McpAccess::FullAccess,
        ..McpServerSettings::default()
    };
    assert!(extra_scopes(settings, McpAccess::FullAccess).is_empty());
    settings.capabilities.terminals = true;
    assert_eq!(
        extra_scopes(settings, McpAccess::FullAccess),
        [crate::auth::SCOPE_TERMINAL_OPERATE]
    );
    assert!(extra_scopes(settings, McpAccess::AutoAcceptEdits).is_empty());
    settings.access = McpAccess::AutoAcceptEdits;
    assert!(extra_scopes(settings, McpAccess::FullAccess).is_empty());
}
