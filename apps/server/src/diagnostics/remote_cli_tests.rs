//! `pair` and `download` against a real server behind a verified TLS endpoint, and against a
//! fake remote that breaks the item bound. The rest of the command's behavior is tested
//! through the `bibcode` binary in `tests/diagnostics_remote_cli.rs`.

use std::net::SocketAddr;

use base64::engine::general_purpose::STANDARD;
use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::*;
use crate::{
    ServerConfig, ServerHandle, ServerRuntime,
    auth::pairing_code::encode_pairing_code,
    diagnostics::archive::MAX_ENCODED_ITEM_BYTES,
    test_support::{
        hermetic_providers,
        tls_fixture::{TestCertificates, tls_proxy},
    },
};

struct Remote {
    _root: tempfile::TempDir,
    handle: ServerHandle,
    admin: String,
}

async fn start_remote() -> Remote {
    let root = tempfile::tempdir().expect("remote root");
    let config = ServerConfig::new(root.path()).with_bind("127.0.0.1", 0);
    hermetic_providers::write_hermetic_settings(&config.state_dir(), json!({}));
    let handle = ServerRuntime::start(config).await.expect("server starts");
    let credential = handle
        .startup_access()
        .expect("startup access")
        .credential
        .clone();
    let response = reqwest::Client::new()
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
    let admin = response.json::<Value>().await.expect("token")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    Remote {
        _root: root,
        handle,
        admin,
    }
}

/// A diagnostics-only offer from the remote, pointed at `endpoint`.
async fn offer_for(remote: &Remote, endpoint: &str) -> String {
    let response = reqwest::Client::new()
        .post(format!(
            "http://{}/api/auth/pairing-offer",
            remote.handle.local_addr()
        ))
        .bearer_auth(&remote.admin)
        .json(&json!({
            "name": "Test Remote",
            "endpoint": "http://192.0.2.10:3773",
            "reach": "another-device",
            "scopes": ["diagnostics:read"],
        }))
        .send()
        .await
        .expect("pairing offer");
    assert!(response.status().is_success(), "{}", response.status());
    let code = response.json::<Value>().await.expect("offer")["code"]
        .as_str()
        .expect("code")
        .to_owned();
    let mut payload = decode_pairing_code(&code).expect("offer decodes");
    payload.endpoint = endpoint.to_owned();
    encode_pairing_code(&payload).expect("offer encodes")
}

fn reason(outcome: &Outcome) -> &str {
    match outcome {
        Outcome::Failed { reason, .. }
        | Outcome::Denied { reason, .. }
        | Outcome::Unavailable { reason, .. } => reason,
        Outcome::Saved { .. } => "saved",
    }
}

#[tokio::test]
async fn pairs_and_downloads_through_a_verified_wss_endpoint() {
    let remote = start_remote().await;
    let certificates = TestCertificates::generate();
    let proxy = tls_proxy(&certificates, remote.handle.local_addr()).await;
    let code = offer_for(&remote, &format!("https://localhost:{}", proxy.port())).await;
    let cli = tempfile::tempdir().expect("cli state");

    // The platform's roots do not include the test authority: nothing is sent, and the
    // one-time offer stays unused.
    let refused = pair(
        cli.path(),
        &code,
        Some("box".to_owned()),
        &ServerTrust::Platform,
    )
    .await
    .expect_err("an unverified certificate is refused");
    assert_eq!(reason(&refused), "tls", "{refused:?}");

    let trust = ServerTrust::PlatformAnd(vec![certificates.authority.clone()]);
    let paired = pair(cli.path(), &code, Some("box".to_owned()), &trust)
        .await
        .expect("pairs through the verified endpoint");
    assert_eq!(paired.remote.name, "box");
    assert!(paired.note.is_none());

    let output = tempfile::tempdir().expect("output");
    let outcome = download(cli.path(), "box", false, output.path(), &trust).await;
    let Outcome::Saved { path, manifest, .. } = &outcome else {
        panic!("download failed: {outcome:?}");
    };
    assert_eq!(
        manifest["storageInstanceId"],
        json!(paired.remote.storage_instance_id)
    );
    assert!(path.starts_with(std::fs::canonicalize(output.path()).expect("output")));

    // The saved credential reads the bundle and nothing else.
    let stored = RemoteStore::open(cli.path())
        .await
        .expect("store")
        .read("box")
        .await
        .expect("read")
        .expect("record");
    let mut client = authenticated_client(&stored, &trust)
        .await
        .expect("the credential authenticates");
    for method in ["server.getConfig", "projects.listEntries", "terminal.open"] {
        let refused = client
            .unary(method, json!({}), Duration::from_secs(10))
            .await;
        let Err(RpcCallError::Failed(error)) = refused else {
            panic!("{method} was not refused: {refused:?}");
        };
        assert_eq!(error["_tag"], "EnvironmentAuthorizationError", "{method}");
    }
    client.close().await;

    remote.handle.shutdown();
    remote.handle.join().await.expect("server joins");
}

/// A fake remote: completes the pinned handshake with `static_key`, accepts any bearer, then
/// answers the download with `Started` and one `Data` item whose text is over the bound.
async fn oversized_item_remote(static_key: Vec<u8>, manifest: Value) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.expect("accept");
        let mut socket = tokio_tungstenite::accept_async(socket)
            .await
            .expect("upgrade");
        let mut responder = snow::Builder::new(crate::auth::NOISE_NK_PARAMS.parse().unwrap())
            .local_private_key(&static_key)
            .unwrap()
            .build_responder()
            .unwrap();
        let Some(Ok(Message::Binary(message_a))) = socket.next().await else {
            panic!("message A");
        };
        let mut scratch = vec![0_u8; 65_535];
        responder.read_message(&message_a, &mut scratch).unwrap();
        let length = responder.write_message(&[], &mut scratch).unwrap();
        socket
            .send(Message::Binary(scratch[..length].to_vec().into()))
            .await
            .unwrap();
        let mut transport = responder.into_transport_mode().unwrap();
        let receive =
            async |socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
                   transport: &mut snow::TransportState|
                   -> Value {
                let Some(Ok(Message::Binary(frame))) = socket.next().await else {
                    panic!("record");
                };
                let mut plain = vec![0_u8; 65_535];
                let length = transport.read_message(&frame, &mut plain).unwrap();
                assert_eq!(plain[0], 0, "one-record client messages");
                serde_json::from_slice(&plain[1..length]).unwrap()
            };
        let send =
            async |socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
                   transport: &mut snow::TransportState,
                   message: Value| {
                let bytes = message.to_string().into_bytes();
                let chunks: Vec<&[u8]> = bytes.chunks(65_518).collect();
                for (index, chunk) in chunks.iter().enumerate() {
                    let mut record = vec![u8::from(index + 1 != chunks.len())];
                    record.extend_from_slice(chunk);
                    let mut frame = vec![0_u8; record.len() + 16];
                    let length = transport.write_message(&record, &mut frame).unwrap();
                    frame.truncate(length);
                    socket.send(Message::Binary(frame.into())).await.unwrap();
                }
            };
        let auth = receive(&mut socket, &mut transport).await;
        assert!(auth["bearer"].is_string());
        send(
            &mut socket,
            &mut transport,
            json!({ "type": "e2ee_authenticated" }),
        )
        .await;
        let request = receive(&mut socket, &mut transport).await;
        assert_eq!(request["tag"], DOWNLOAD_METHOD);
        let id = request["id"].clone();
        send(
            &mut socket,
            &mut transport,
            json!({ "_tag": "Chunk", "requestId": id, "values": [{
                "_tag": "Started",
                "fileName": "bibcode-diagnostics-fake-20261028T000000Z.zip",
                "byteLength": 1024 * 1024,
                "manifest": manifest,
            }]}),
        )
        .await;
        let ack = receive(&mut socket, &mut transport).await;
        assert_eq!(ack["_tag"], "Ack");
        // Valid base64 characters, a multiple of four: only the length bound refuses it.
        send(
            &mut socket,
            &mut transport,
            json!({ "_tag": "Chunk", "requestId": id, "values": [{
                "_tag": "Data",
                "data": "A".repeat(MAX_ENCODED_ITEM_BYTES + 4),
            }]}),
        )
        .await;
        // The client refuses the item and closes without acknowledging it.
        while let Some(Ok(message)) = socket.next().await {
            assert!(!matches!(message, Message::Binary(_)), "no Ack follows");
        }
    });
    address
}

#[tokio::test]
async fn an_item_over_the_bound_is_refused_through_the_client_and_nothing_is_saved() {
    let keypair = snow::Builder::new(crate::auth::NOISE_NK_PARAMS.parse().unwrap())
        .generate_keypair()
        .unwrap();
    let manifest = json!({ "environmentId": "local", "storageInstanceId": "store-fake" });
    let address = oversized_item_remote(keypair.private.clone(), manifest).await;
    let cli = tempfile::tempdir().expect("cli state");
    RemoteStore::open(cli.path())
        .await
        .expect("store")
        .create(&StoredRemote {
            v: RECORD_VERSION,
            name: "fake".to_owned(),
            endpoint: format!("http://{address}"),
            host_key: URL_SAFE_NO_PAD.encode(&keypair.public),
            environment_id: "local".to_owned(),
            storage_instance_id: "store-fake".to_owned(),
            remote_name: "Fake".to_owned(),
            paired_at: now_rfc3339(),
            pairing_id: "attempt".to_owned(),
            credential: "credential".to_owned(),
        })
        .await
        .expect("record");
    let output = tempfile::tempdir().expect("output");

    let outcome = download(
        cli.path(),
        "fake",
        false,
        output.path(),
        &ServerTrust::Platform,
    )
    .await;

    assert_eq!(reason(&outcome), "incomplete", "{outcome:?}");
    assert_eq!(
        std::fs::read_dir(output.path()).expect("output").count(),
        0,
        "nothing was written"
    );
    // The bound is the base64 length of one item, not of the archive.
    assert_eq!(
        MAX_ENCODED_ITEM_BYTES,
        STANDARD
            .encode(vec![0_u8; crate::production::diagnostic_logs_rpc::DIAGNOSTIC_LOGS_CHUNK_BYTES])
            .len()
    );
}

type FakeSocket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// The responder side of the pinned handshake, for fake remotes.
async fn fake_handshake(socket: &mut FakeSocket, static_key: &[u8]) -> snow::TransportState {
    let mut responder = snow::Builder::new(crate::auth::NOISE_NK_PARAMS.parse().unwrap())
        .local_private_key(static_key)
        .unwrap()
        .build_responder()
        .unwrap();
    let Some(Ok(Message::Binary(message_a))) = socket.next().await else {
        panic!("message A");
    };
    let mut scratch = vec![0_u8; 65_535];
    responder.read_message(&message_a, &mut scratch).unwrap();
    let length = responder.write_message(&[], &mut scratch).unwrap();
    socket
        .send(Message::Binary(scratch[..length].to_vec().into()))
        .await
        .unwrap();
    responder.into_transport_mode().unwrap()
}

async fn fake_receive(socket: &mut FakeSocket, transport: &mut snow::TransportState) -> Value {
    let Some(Ok(Message::Binary(frame))) = socket.next().await else {
        panic!("record");
    };
    let mut plain = vec![0_u8; 65_535];
    let length = transport.read_message(&frame, &mut plain).unwrap();
    serde_json::from_slice(&plain[1..length]).unwrap()
}

async fn fake_send(socket: &mut FakeSocket, transport: &mut snow::TransportState, message: Value) {
    let mut record = vec![0_u8];
    record.extend_from_slice(message.to_string().as_bytes());
    let mut frame = vec![0_u8; record.len() + 16];
    let length = transport.write_message(&record, &mut frame).unwrap();
    frame.truncate(length);
    socket.send(Message::Binary(frame.into())).await.unwrap();
}

/// A record written by another pairing attempt under the same name.
fn record_named(name: &str, pairing_id: &str) -> StoredRemote {
    StoredRemote {
        v: RECORD_VERSION,
        name: name.to_owned(),
        endpoint: "http://127.0.0.1:9".to_owned(),
        host_key: URL_SAFE_NO_PAD.encode([1_u8; 32]),
        environment_id: "local".to_owned(),
        storage_instance_id: "store-other".to_owned(),
        remote_name: "Other".to_owned(),
        paired_at: now_rfc3339(),
        pairing_id: pairing_id.to_owned(),
        credential: "credential-b".to_owned(),
    }
}

/// A fake remote that accepts a diagnostics pairing, then holds the confirmation until the
/// test lets it answer, and refuses it. Returns the offer, a signal for "the confirmation
/// arrived" (A's record is written by then), and the switch that lets it answer.
async fn refusing_remote() -> (
    String,
    tokio::sync::oneshot::Receiver<()>,
    tokio::sync::oneshot::Sender<()>,
) {
    let keypair = snow::Builder::new(crate::auth::NOISE_NK_PARAMS.parse().unwrap())
        .generate_keypair()
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("address");
    let (reached, reached_confirmation) = tokio::sync::oneshot::channel::<()>();
    let (proceed, may_answer) = tokio::sync::oneshot::channel::<()>();
    let private_key = keypair.private.clone();
    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.expect("accept");
        let mut socket = tokio_tungstenite::accept_async(socket)
            .await
            .expect("upgrade");
        let mut transport = fake_handshake(&mut socket, &private_key).await;
        let auth = fake_receive(&mut socket, &mut transport).await;
        assert_eq!(auth["pairing"], "one-time");
        fake_send(
            &mut socket,
            &mut transport,
            json!({
                "type": "e2ee_authenticated",
                "credential": "credential-a",
                "environmentId": "local",
                "storageInstanceId": "store-fake",
                "scopes": ["diagnostics:read"],
                "pairingConfirmationRequired": true,
            }),
        )
        .await;
        let confirm = fake_receive(&mut socket, &mut transport).await;
        assert_eq!(confirm["tag"], "auth.confirmPairing");
        let _ = reached.send(());
        if may_answer.await.is_err() {
            return;
        }
        fake_send(
            &mut socket,
            &mut transport,
            json!({ "_tag": "Exit", "requestId": confirm["id"], "exit": {
                "_tag": "Failure",
                "cause": [{ "_tag": "Fail", "error": { "_tag": "AuthError", "message": "no" } }],
            }}),
        )
        .await;
        while socket.next().await.is_some() {}
    });
    let code = encode_pairing_code(&crate::auth::pairing_code::RemotePairingCodePayload {
        v: crate::auth::pairing_code::REMOTE_PAIRING_CODE_VERSION,
        endpoint: format!("http://{address}"),
        name: "Fake".to_owned(),
        token: "one-time".to_owned(),
        host_key: URL_SAFE_NO_PAD.encode(&keypair.public),
        reach: crate::auth::pairing_code::RemotePairingReach::AnotherDevice,
        storage_instance_id: "store-fake".to_owned(),
    })
    .expect("offer");
    (code, reached_confirmation, proceed)
}

/// While attempt A waits for its confirmation, the user runs `forget box` and pairs it again
/// (attempt B). B waits for A's lock instead of interleaving; A's refused confirmation removes
/// only A's record; B's record then stands.
#[tokio::test]
async fn a_concurrent_forget_and_re_pair_waits_for_the_pairing_and_keeps_the_newer_record() {
    let (code, reached_confirmation, proceed) = refusing_remote().await;
    let cli = tempfile::tempdir().expect("cli state");
    let store = RemoteStore::open(cli.path()).await.expect("store");

    let attempt_a = pair(
        cli.path(),
        &code,
        Some("box".to_owned()),
        &ServerTrust::Platform,
    );
    let meanwhile = async {
        reached_confirmation
            .await
            .expect("A waits for its confirmation");
        let written_by_a = store.read("box").await.unwrap().expect("A's record");
        assert_eq!(written_by_a.credential, "credential-a");
        let busy = store
            .lock("box", Duration::ZERO)
            .await
            .err()
            .expect("A holds the name");
        assert_eq!(reason(&busy), "busy");
        let forget_and_re_pair = async {
            let lock = store.lock("box", LOCK_WAIT).await.expect("A lets go");
            let forgot = store.remove("box").await.unwrap();
            store
                .create(&record_named("box", "attempt-b"))
                .await
                .expect("B's record");
            drop(lock);
            forgot
        };
        let let_a_finish = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            proceed.send(()).unwrap();
        };
        let (forgot, ()) = tokio::join!(forget_and_re_pair, let_a_finish);
        assert!(!forgot, "A had already removed its own record");
    };
    let (outcome, ()) = tokio::join!(attempt_a, meanwhile);

    assert_eq!(
        reason(&outcome.expect_err("A was refused")),
        "pairing-rejected"
    );
    let kept = store
        .read("box")
        .await
        .unwrap()
        .expect("B's record survives");
    assert_eq!(kept.pairing_id, "attempt-b");
    assert_eq!(kept.credential, "credential-b");
}

/// A pairing that stops between writing its record and its confirmation (here its future is
/// dropped, as a crash ends it; the OS releases the lock of a dead process the same way)
/// leaves the record readable under its own name and the name free.
#[tokio::test]
async fn a_pairing_stopped_after_writing_leaves_the_record_readable_and_the_name_free() {
    let (code, reached_confirmation, _proceed) = refusing_remote().await;
    let cli = tempfile::tempdir().expect("cli state");
    let store = RemoteStore::open(cli.path()).await.expect("store");

    tokio::select! {
        _ = pair(cli.path(), &code, Some("box".to_owned()), &ServerTrust::Platform) => {
            panic!("the pairing waits for its confirmation");
        }
        reached = reached_confirmation => reached.expect("A waits for its confirmation"),
    }

    let record = store.read("box").await.unwrap().expect("readable by name");
    assert_eq!(record.credential, "credential-a");
    assert_eq!(store.names().await.unwrap(), ["box"]);
    store
        .lock("box", Duration::ZERO)
        .await
        .expect("the stopped pairing's lock is released");
}

/// A refused pairing whose record cannot be removed says so, names `forget`, and fails.
#[cfg(unix)]
#[tokio::test]
async fn a_rollback_that_cannot_remove_the_record_says_how_to_remove_it() {
    use std::os::unix::fs::PermissionsExt as _;

    // Root ignores directory permissions (CAP_DAC_OVERRIDE), so removal cannot be made to fail.
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let (code, reached_confirmation, proceed) = refusing_remote().await;
    let cli = tempfile::tempdir().expect("cli state");
    let directory = cli.path().join(REMOTES_DIRECTORY);

    let attempt = pair(
        cli.path(),
        &code,
        Some("box".to_owned()),
        &ServerTrust::Platform,
    );
    let meanwhile = async {
        reached_confirmation
            .await
            .expect("A waits for its confirmation");
        // A record in a directory that refuses removal.
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o500)).unwrap();
        proceed.send(()).unwrap();
    };
    let (outcome, ()) = tokio::join!(attempt, meanwhile);
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();

    let outcome = outcome.expect_err("the pairing failed");
    assert_eq!(reason(&outcome), "rollback-failed", "{outcome:?}");
    assert_eq!(outcome.exit_code(), 1);
    let Outcome::Failed { message, .. } = &outcome else {
        panic!("{outcome:?}");
    };
    assert!(
        message.contains("bibcode diagnostics forget box"),
        "{message}"
    );
    assert!(
        RemoteStore::open(cli.path())
            .await
            .unwrap()
            .read("box")
            .await
            .unwrap()
            .is_some(),
        "the record remains, as the message says"
    );
}

#[tokio::test]
async fn a_record_stored_with_a_stray_temporary_file_counts_as_stored() {
    let cli = tempfile::tempdir().expect("cli state");
    let root = cli.path().join(REMOTES_DIRECTORY);
    let store = RemoteStore {
        store: SecretStore::new(&root)
            .await
            .expect("store")
            .fail_published_cleanup_for_test(),
        root,
    };
    let note = store
        .create(&record_named("box", "attempt"))
        .await
        .expect("stored despite the stray temporary file");
    assert!(note.is_some_and(|note| note.contains("was saved")));
    assert_eq!(
        store.read("box").await.unwrap().expect("record").pairing_id,
        "attempt"
    );
}
