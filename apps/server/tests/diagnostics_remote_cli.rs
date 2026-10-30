//! `bibcode diagnostics pair` and `download --remote` (#202) through the real binary, against a
//! real server: the diagnostics-only credential, the same redaction and checks as the app's
//! download, revocation and expiry, and the faults a pairing or download can meet (a store that
//! cannot be written, a connection lost before or after confirmation, an interrupted download).

use std::{
    io::Write as _,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bibcode_server::{
    ServerConfig, ServerHandle, ServerRuntime,
    auth_pairing_code::{decode_pairing_code, encode_pairing_code},
};
use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::Client;
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{
    net::TcpListener,
    sync::{Semaphore, mpsc},
    time::timeout,
};
use tokio_tungstenite::tungstenite::Message;

#[path = "support/hermetic_providers.rs"]
mod hermetic_providers;
#[path = "support/tls_fixture.rs"]
mod tls_fixture;

/// E2EE admission is process-wide; these tests share one server process each, one at a time.
static TEST_PERMIT: Semaphore = Semaphore::const_new(1);

const BIBCODE: &str = env!("CARGO_BIN_EXE_bibcode");

async fn start_server(root: &Path) -> ServerHandle {
    let config = ServerConfig::new(root).with_bind("127.0.0.1", 0);
    hermetic_providers::write_hermetic_settings(&config.state_dir(), json!({}));
    ServerRuntime::start(config).await.expect("server starts")
}

async fn stop(handle: ServerHandle) {
    handle.shutdown();
    timeout(Duration::from_secs(10), handle.join())
        .await
        .expect("server shutdown")
        .expect("server joins");
}

fn database(root: &Path) -> Connection {
    Connection::open(root.join("userdata/state.sqlite")).expect("open server database")
}

/// The scopes and revocation of the sessions minted for diagnostics offers.
fn diagnostics_sessions(root: &Path) -> Vec<(String, String, bool)> {
    let connection = database(root);
    let mut statement = connection
        .prepare(
            "SELECT session_id, scopes, revoked_at IS NOT NULL FROM auth_sessions \
             WHERE client_label LIKE '%(diagnostics)' OR client_label = 'full-access' \
             ORDER BY issued_at",
        )
        .expect("query");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("rows")
        .map(Result::unwrap)
        .collect()
}

/// Waits until every session minted for an offer is revoked (closing an unconfirmed pairing
/// revokes its session in the background).
async fn wait_until_revoked(root: &Path) {
    timeout(Duration::from_secs(10), async {
        loop {
            let sessions = diagnostics_sessions(root);
            if !sessions.is_empty() && sessions.iter().all(|(_, _, revoked)| *revoked) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the unused credential is revoked");
}

/// An offer minted on the remote by `bibcode pairing offer`, pointed at `endpoint`.
fn offer(root: &Path, access: &str, endpoint: &str) -> String {
    let mut command = Command::new(BIBCODE);
    command
        .args(["pairing", "offer", "--base-dir"])
        .arg(root)
        .args([
            "--endpoint",
            "http://192.0.2.10:3773",
            "--name",
            "Test Remote",
            "--access",
            access,
            "--json",
        ]);
    if access == "full" {
        command.args(["--label", "full-access"]);
    }
    let output = command.output().expect("run pairing offer");
    assert!(
        output.status.success(),
        "pairing offer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let minted: Value = serde_json::from_slice(&output.stdout).expect("offer JSON");
    let mut payload = decode_pairing_code(minted["code"].as_str().expect("code")).expect("decodes");
    payload.endpoint = endpoint.to_owned();
    format!(
        "bibcode://pair?code={}",
        encode_pairing_code(&payload).expect("encodes")
    )
}

fn cli(cli_root: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(BIBCODE);
    command
        .arg("diagnostics")
        .args(args)
        .arg("--base-dir")
        .arg(cli_root)
        .arg("--json")
        .env_remove("BIBCODE_HOME")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// `bibcode diagnostics pair` with the offer on standard input, as an agent would pass it.
fn pair(cli_root: &Path, offer: &str) -> (i32, Value, Output) {
    let mut child = cli(cli_root, &["pair", "--name", "box"])
        .stdin(Stdio::piped())
        .spawn()
        .expect("run pair");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(format!("{offer}\n").as_bytes())
        .expect("offer on stdin");
    let output = child.wait_with_output().expect("pair output");
    let report = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
    (output.status.code().unwrap_or(-1), report, output)
}

fn download(cli_root: &Path, output_dir: &Path, extra: &[&str]) -> (i32, Value) {
    let mut args = vec!["download", "--remote", "box", "--output"];
    let output_text = output_dir.to_str().expect("utf-8 path").to_owned();
    args.push(&output_text);
    args.extend_from_slice(extra);
    let output = cli(cli_root, &args).output().expect("run download");
    (
        output.status.code().unwrap_or(-1),
        serde_json::from_slice(&output.stdout).unwrap_or(Value::Null),
    )
}

fn record_path(cli_root: &Path) -> PathBuf {
    cli_root.join("userdata/diagnostics-remotes/box.bin")
}

fn record(cli_root: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(record_path(cli_root)).expect("record")).expect("JSON")
}

fn entries(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .expect("directory")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

fn zip_text(path: &Path, entry: &str) -> String {
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(path).expect("archive")).expect("zip");
    let mut text = String::new();
    std::io::Read::read_to_string(&mut archive.by_name(entry).expect("entry"), &mut text)
        .expect("text");
    text
}

async fn admin_token(handle: &ServerHandle) -> String {
    let credential = handle
        .startup_access()
        .expect("startup access")
        .credential
        .clone();
    let response = Client::new()
        .post(format!("http://{}/oauth/token", handle.local_addr()))
        .form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", credential.as_str()),
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
    response.json::<Value>().await.expect("token")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned()
}

fn endpoint(address: SocketAddr) -> String {
    format!("http://{address}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_pairs_for_diagnostics_only_and_downloads_the_redacted_bundle() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    // A secret in the remote's own log, which the bundle must not carry.
    let logs = remote.path().join("userdata/logs");
    std::fs::create_dir_all(&logs).unwrap();
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("server.log"))
        .unwrap();
    writeln!(
        log,
        "upstream answered: Authorization: Bearer SEEDED-SECRET-202"
    )
    .unwrap();
    drop(log);

    let cli_root = TempDir::new().unwrap();
    let offer = offer(remote.path(), "diagnostics", &endpoint(handle.local_addr()));
    let (code, report, output) = pair(cli_root.path(), &offer);
    assert_eq!(
        code,
        0,
        "{report} {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(report["status"], "paired");
    assert_eq!(report["name"], "box");
    let credential = record(cli_root.path())["credential"]
        .as_str()
        .expect("credential")
        .to_owned();
    for text in [&output.stdout, &output.stderr] {
        assert!(
            !String::from_utf8_lossy(text).contains(&credential),
            "credential printed"
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(record_path(cli_root.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the record is private to the user");
    }
    // The remote minted exactly `diagnostics:read`, labelled as such.
    let sessions = diagnostics_sessions(remote.path());
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&sessions[0].1).unwrap(),
        json!(["diagnostics:read"])
    );

    let listed = cli(cli_root.path(), &["remotes"]).output().unwrap();
    let listed: Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(listed["remotes"][0]["name"], "box");
    assert!(!listed.to_string().contains(&credential));

    let output_dir = TempDir::new().unwrap();
    let (code, report) = download(cli_root.path(), output_dir.path(), &[]);
    assert_eq!(code, 0, "{report}");
    assert_eq!(report["status"], "saved");
    let path = PathBuf::from(report["path"].as_str().unwrap());
    let manifest = &report["manifest"];
    assert_eq!(
        manifest["storageInstanceId"],
        record(cli_root.path())["storageInstanceId"]
    );
    assert_eq!(manifest["crashDumps"]["included"], 0);
    let server_log = zip_text(&path, "server.log");
    assert!(!server_log.contains("SEEDED-SECRET-202"), "{server_log}");
    assert!(
        server_log.contains("Authorization: [REDACTED]"),
        "{server_log}"
    );
    assert_eq!(
        zip_text(&path, "frontend.log"),
        "No frontend warnings or errors were captured.\n"
    );

    // Crash dumps need more than this credential grants, as in the app.
    let (code, report) = download(
        cli_root.path(),
        output_dir.path(),
        &["--include-crash-dumps"],
    );
    assert_eq!(
        (code, report["reason"].as_str()),
        (2, Some("crash-dumps-refused")),
        "{report}"
    );

    // Restart: the confirmed credential still works.
    stop(handle).await;
    let handle = start_server(remote.path()).await;
    let mut payload_endpoint = record(cli_root.path());
    // The restarted server listens on another port; point the record at it.
    payload_endpoint["endpoint"] = json!(endpoint(handle.local_addr()));
    std::fs::write(record_path(cli_root.path()), payload_endpoint.to_string()).unwrap();
    let again = TempDir::new().unwrap();
    let (code, report) = download(cli_root.path(), again.path(), &[]);
    assert_eq!(code, 0, "{report}");

    // Revoked on the remote: refused, and the command says to pair again.
    let admin = admin_token(&handle).await;
    let revoked = Client::new()
        .post(format!(
            "http://{}/api/auth/clients/revoke",
            handle.local_addr()
        ))
        .bearer_auth(&admin)
        .json(&json!({ "sessionId": sessions[0].0 }))
        .send()
        .await
        .unwrap();
    assert!(revoked.status().is_success(), "{}", revoked.status());
    let (code, report) = download(cli_root.path(), TempDir::new().unwrap().path(), &[]);
    assert_eq!(
        (code, report["reason"].as_str()),
        (2, Some("unauthorized")),
        "{report}"
    );
    assert!(report["message"].as_str().unwrap().contains("Pair again"));

    // `forget` deletes the local record only.
    let forgot = cli(cli_root.path(), &["forget", "box"]).output().unwrap();
    assert_eq!(forgot.status.code(), Some(0));
    assert!(!record_path(cli_root.path()).exists());
    stop(handle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_command_refuses_a_full_access_offer_and_saves_nothing() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    let cli_root = TempDir::new().unwrap();

    let offer = offer(remote.path(), "full", &endpoint(handle.local_addr()));
    let (code, report, _) = pair(cli_root.path(), &offer);

    assert_eq!(
        (code, report["reason"].as_str()),
        (1, Some("not-diagnostics-only")),
        "{report}"
    );
    assert!(
        report["message"]
            .as_str()
            .unwrap()
            .contains("--access diagnostics")
    );
    assert!(!record_path(cli_root.path()).exists());
    // The full-access credential was never confirmed, so the remote revokes it.
    wait_until_revoked(remote.path()).await;
    stop(handle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_credential_that_expired_is_refused_after_a_restart() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    let cli_root = TempDir::new().unwrap();
    let (code, report, _) = pair(
        cli_root.path(),
        &offer(remote.path(), "diagnostics", &endpoint(handle.local_addr())),
    );
    assert_eq!(code, 0, "{report}");
    stop(handle).await;
    database(remote.path())
        .execute(
            "UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z' \
             WHERE client_label LIKE '%(diagnostics)'",
            [],
        )
        .unwrap();

    let handle = start_server(remote.path()).await;
    let mut stored = record(cli_root.path());
    stored["endpoint"] = json!(endpoint(handle.local_addr()));
    std::fs::write(record_path(cli_root.path()), stored.to_string()).unwrap();
    let (code, report) = download(cli_root.path(), TempDir::new().unwrap().path(), &[]);

    assert_eq!(
        (code, report["reason"].as_str()),
        (2, Some("unauthorized")),
        "{report}"
    );
    assert!(
        report["message"].as_str().unwrap().contains("30"),
        "{report}"
    );
    stop(handle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_changed_host_key_or_store_saves_nothing() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    let cli_root = TempDir::new().unwrap();
    let (code, report, _) = pair(
        cli_root.path(),
        &offer(remote.path(), "diagnostics", &endpoint(handle.local_addr())),
    );
    assert_eq!(code, 0, "{report}");
    let original = record(cli_root.path());

    let mut other_key = original.clone();
    other_key["hostKey"] = json!(URL_SAFE_NO_PAD.encode([7_u8; 32]));
    std::fs::write(record_path(cli_root.path()), other_key.to_string()).unwrap();
    let output_dir = TempDir::new().unwrap();
    let (code, report) = download(cli_root.path(), output_dir.path(), &[]);
    assert_eq!(
        (code, report["reason"].as_str()),
        (1, Some("host-identity-mismatch")),
        "{report}"
    );

    let mut other_store = original.clone();
    other_store["storageInstanceId"] = json!("another-store");
    std::fs::write(record_path(cli_root.path()), other_store.to_string()).unwrap();
    let (code, report) = download(cli_root.path(), output_dir.path(), &[]);
    assert_eq!(
        (code, report["reason"].as_str()),
        (1, Some("wrong-environment")),
        "{report}"
    );
    assert!(entries(output_dir.path()).is_empty(), "nothing was saved");
    stop(handle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_that_cannot_be_written_leaves_no_credential_on_either_side() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    let cli_root = TempDir::new().unwrap();
    // A directory where the record goes: the name looks free, but the write fails.
    std::fs::create_dir_all(record_path(cli_root.path())).unwrap();

    let (code, report, _) = pair(
        cli_root.path(),
        &offer(remote.path(), "diagnostics", &endpoint(handle.local_addr())),
    );

    assert_eq!(
        (code, report["reason"].as_str()),
        (1, Some("store-failed")),
        "{report}"
    );
    assert!(record_path(cli_root.path()).is_dir(), "nothing replaced it");
    wait_until_revoked(remote.path()).await;
    stop(handle).await;
}

/// What the WebSocket proxy does to one connection.
#[derive(Clone, Copy, Debug)]
enum Fault {
    Forward,
    /// Ends the connection when the client's `n`th binary message arrives, without sending it.
    DropClientMessage(usize),
    /// Ends the connection when the server's `n`th binary message arrives, without sending it.
    DropServerMessage(usize),
    /// Sends the server's `n`th binary message, reports it, then holds everything the client
    /// sends until the client goes away.
    HoldAfterServerMessage(usize),
}

/// A WebSocket proxy in front of `upstream`'s `/ws-e2ee`. Connections take `faults` in order,
/// then `Forward`. It sees only ciphertext: messages are counted, never read.
async fn fault_proxy(
    upstream: SocketAddr,
    faults: Vec<Fault>,
) -> (SocketAddr, mpsc::UnboundedReceiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (held, held_events) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut faults = faults.into_iter();
        while let Ok((socket, _)) = listener.accept().await {
            let fault = faults.next().unwrap_or(Fault::Forward);
            let held = held.clone();
            tokio::spawn(async move {
                let Ok(mut client) = tokio_tungstenite::accept_async(socket).await else {
                    return;
                };
                let Ok((mut server, _)) =
                    tokio_tungstenite::connect_async(format!("ws://{upstream}/ws-e2ee")).await
                else {
                    return;
                };
                let (mut from_client, mut from_server, mut holding) = (0, 0, false);
                loop {
                    tokio::select! {
                        message = client.next() => {
                            let Some(Ok(message)) = message else { break };
                            if let Message::Binary(_) = message {
                                from_client += 1;
                                if matches!(fault, Fault::DropClientMessage(n) if n == from_client) {
                                    break;
                                }
                                if holding {
                                    continue;
                                }
                            }
                            if matches!(message, Message::Ping(_) | Message::Pong(_)) {
                                continue;
                            }
                            if server.send(message).await.is_err() { break; }
                        }
                        message = server.next() => {
                            let Some(Ok(message)) = message else { break };
                            if let Message::Binary(_) = message {
                                from_server += 1;
                                if matches!(fault, Fault::DropServerMessage(n) if n == from_server) {
                                    break;
                                }
                            }
                            if matches!(message, Message::Ping(_) | Message::Pong(_)) {
                                continue;
                            }
                            if client.send(message).await.is_err() { break; }
                            if matches!(fault, Fault::HoldAfterServerMessage(n) if n == from_server) {
                                holding = true;
                                let _ = held.send(());
                            }
                        }
                    }
                }
                // Both sides go at once, without a closing handshake: a lost connection.
                drop(client);
                drop(server);
            });
        }
    });
    (address, held_events)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_lost_before_confirmation_revokes_the_pending_credential() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    // Client messages: Noise A, e2ee_auth, then auth.confirmPairing, which never arrives.
    let (proxy, _) = fault_proxy(handle.local_addr(), vec![Fault::DropClientMessage(3)]).await;
    let cli_root = TempDir::new().unwrap();

    let (code, report, _) = pair(
        cli_root.path(),
        &offer(remote.path(), "diagnostics", &endpoint(proxy)),
    );

    assert_eq!(
        (code, report["reason"].as_str()),
        (1, Some("pairing-rejected")),
        "{report}"
    );
    assert!(
        !record_path(cli_root.path()).exists(),
        "the unconfirmed record is deleted"
    );
    wait_until_revoked(remote.path()).await;
    stop(handle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_lost_after_confirmation_keeps_the_confirmed_credential() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    // Server messages: Noise B, e2ee_authenticated, then the confirmation's answer, lost.
    let (proxy, _) = fault_proxy(handle.local_addr(), vec![Fault::DropServerMessage(3)]).await;
    let cli_root = TempDir::new().unwrap();

    let (code, report, _) = pair(
        cli_root.path(),
        &offer(remote.path(), "diagnostics", &endpoint(proxy)),
    );

    assert_eq!(code, 0, "{report}");
    assert_eq!(report["status"], "paired");
    assert!(
        report.get("note").is_none(),
        "the reconnect settled it: {report}"
    );
    let (code, report) = download(cli_root.path(), TempDir::new().unwrap().path(), &[]);
    assert_eq!(code, 0, "{report}");
    let sessions = diagnostics_sessions(remote.path());
    assert!(sessions.iter().all(|(_, _, revoked)| !revoked));
    stop(handle).await;
}

/// The command dies between writing its record and confirming it: the record stays readable
/// under its name, and the dead process's lock on the name does not block `forget`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pairing_killed_before_confirmation_leaves_a_readable_record_and_a_free_name() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    // Server messages: Noise B, then e2ee_authenticated; the confirmation is held.
    let (proxy, mut held) =
        fault_proxy(handle.local_addr(), vec![Fault::HoldAfterServerMessage(2)]).await;
    let cli_root = TempDir::new().unwrap();
    let mut child = cli(cli_root.path(), &["pair", "--name", "box"])
        .stdin(Stdio::piped())
        .spawn()
        .expect("run pair");
    let offer = offer(remote.path(), "diagnostics", &endpoint(proxy));
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{offer}\n").as_bytes())
        .unwrap();
    timeout(Duration::from_secs(30), held.recv())
        .await
        .expect("the pairing reply went out")
        .expect("proxy event");
    timeout(Duration::from_secs(10), async {
        while !record_path(cli_root.path()).is_file() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the record is written before the confirmation");
    child.kill().expect("the command dies");
    let _ = child.wait();

    assert!(
        record(cli_root.path())["credential"].is_string(),
        "readable by name"
    );
    let started = std::time::Instant::now();
    let forgot = cli(cli_root.path(), &["forget", "box"]).output().unwrap();
    assert_eq!(
        forgot.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&forgot.stdout)
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the dead holder's lock was free"
    );
    assert!(!record_path(cli_root.path()).exists());
    // The unconfirmed credential dies with the channel.
    wait_until_revoked(remote.path()).await;
    stop(handle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_interrupted_download_releases_its_archive_slot_and_leaves_no_file() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    let cli_root = TempDir::new().unwrap();
    let (code, report, _) = pair(
        cli_root.path(),
        &offer(remote.path(), "diagnostics", &endpoint(handle.local_addr())),
    );
    assert_eq!(code, 0, "{report}");
    // Server messages on a download: Noise B, e2ee_authenticated, then `Started`, after which
    // the archive holds one of the server's two slots until the request ends.
    let (proxy, mut held) = fault_proxy(
        handle.local_addr(),
        vec![
            Fault::HoldAfterServerMessage(3),
            Fault::HoldAfterServerMessage(3),
        ],
    )
    .await;
    let mut stored = record(cli_root.path());
    stored["endpoint"] = json!(endpoint(proxy));
    std::fs::write(record_path(cli_root.path()), stored.to_string()).unwrap();
    let output_dir = TempDir::new().unwrap();
    let output_text = output_dir.path().to_str().unwrap().to_owned();

    for _ in 0..2 {
        let mut child = cli(
            cli_root.path(),
            &["download", "--remote", "box", "--output", &output_text],
        )
        .spawn()
        .expect("run download");
        timeout(Duration::from_secs(30), held.recv())
            .await
            .expect("the archive started")
            .expect("proxy event");
        child.kill().expect("interrupt the command");
        let _ = child.wait();
    }
    assert!(entries(output_dir.path()).is_empty(), "no partial archive");

    // Both slots came back when the commands went away; held, this would wait for the
    // server's 60-second acknowledgement deadline.
    let started = std::time::Instant::now();
    let (code, report) = download(cli_root.path(), output_dir.path(), &[]);
    assert_eq!(code, 0, "{report}");
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "{:?}",
        started.elapsed()
    );
    stop(handle).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_https_remote_with_an_unverifiable_certificate_is_refused() {
    let _permit = TEST_PERMIT.acquire().await.unwrap();
    let remote = TempDir::new().unwrap();
    let handle = start_server(remote.path()).await;
    let certificates = tls_fixture::TestCertificates::generate();
    let proxy = tls_fixture::tls_proxy(&certificates, handle.local_addr()).await;
    let cli_root = TempDir::new().unwrap();

    let offer = offer(
        remote.path(),
        "diagnostics",
        &format!("https://localhost:{}", proxy.port()),
    );
    let (code, report, _) = pair(cli_root.path(), &offer);

    // The binary verifies against the platform's roots, which lack the test authority.
    assert_eq!(
        (code, report["reason"].as_str()),
        (3, Some("tls")),
        "{report}"
    );
    assert!(!record_path(cli_root.path()).exists());
    // Nothing reached the server, so the offer is still unused.
    assert!(diagnostics_sessions(remote.path()).is_empty());
    stop(handle).await;
}
