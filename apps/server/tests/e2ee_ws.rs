use std::{net::SocketAddr, path::Path, time::Duration};

use bibcode_server::{ServerConfig, ServerHandle, ServerRuntime};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use snow::TransportState;
use tempfile::TempDir;
use tokio::{net::TcpStream, sync::Semaphore, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
    },
};

const NOISE_NK_PARAMS: &str = "Noise_NK_25519_ChaChaPoly_SHA256";
const MAX_CIPHERTEXT_BYTES: usize = 65_535;
const MAX_CHUNK_BYTES: usize = 65_518;
const RECORD_FINAL: u8 = 0;
const RECORD_CONTINUATION: u8 = 1;
const E2EE_MAX_PREAUTH_CONNECTIONS: usize = 32;
const TOKEN_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const BOOTSTRAP_TOKEN_TYPE: &str = "urn:bibcode:params:oauth:token-type:environment-bootstrap";

static TEST_PERMIT: Semaphore = Semaphore::const_new(1);

type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start_server(temp: &TempDir) -> ServerHandle {
    ServerRuntime::start(ServerConfig::new(temp.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("server starts")
}

fn ws_url(address: SocketAddr, path: &str) -> String {
    format!("ws://{address}{path}")
}

fn http_url(handle: &ServerHandle, path: &str) -> String {
    format!("http://{}{}", handle.local_addr(), path)
}

fn read_host_public_key(root: &Path) -> Vec<u8> {
    let record = std::fs::read(
        root.join("userdata")
            .join("secrets")
            .join("host-identity-x25519.bin"),
    )
    .expect("persisted host identity");
    assert_eq!(record.len(), 64);
    record[32..].to_vec()
}

async fn open_socket(address: SocketAddr) -> TestSocket {
    connect_async(ws_url(address, "/ws-e2ee"))
        .await
        .expect("open /ws-e2ee")
        .0
}

fn initiator(host_key: &[u8]) -> snow::HandshakeState {
    snow::Builder::new(NOISE_NK_PARAMS.parse().expect("Noise parameters"))
        .remote_public_key(host_key)
        .expect("host key")
        .build_initiator()
        .expect("Noise initiator")
}

async fn noise_connect(address: SocketAddr, host_key: &[u8]) -> (TestSocket, TransportState) {
    let mut socket = open_socket(address).await;
    let mut initiator = initiator(host_key);
    let mut message_a = vec![0_u8; MAX_CIPHERTEXT_BYTES];
    let len = initiator
        .write_message(&[], &mut message_a)
        .expect("write message A");
    message_a.truncate(len);
    socket
        .send(Message::Binary(message_a.into()))
        .await
        .expect("send message A");
    let frame = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("message B timeout")
        .expect("socket remains open")
        .expect("message B frame");
    let Message::Binary(message_b) = frame else {
        panic!("expected binary message B, got {frame:?}");
    };
    let mut payload = vec![0_u8; MAX_CIPHERTEXT_BYTES];
    assert_eq!(
        initiator
            .read_message(&message_b, &mut payload)
            .expect("read message B"),
        0
    );
    (
        socket,
        initiator
            .into_transport_mode()
            .expect("Noise transport mode"),
    )
}

fn encrypt_record(transport: &mut TransportState, flag: u8, chunk: &[u8]) -> Vec<u8> {
    let mut record = Vec::with_capacity(chunk.len() + 1);
    record.push(flag);
    record.extend_from_slice(chunk);
    let mut frame = vec![0_u8; record.len() + 16];
    let len = transport
        .write_message(&record, &mut frame)
        .expect("encrypt record");
    frame.truncate(len);
    frame
}

async fn send_encrypted(socket: &mut TestSocket, transport: &mut TransportState, plaintext: &[u8]) {
    let mut chunks = plaintext.chunks(MAX_CHUNK_BYTES).peekable();
    if chunks.peek().is_none() {
        let frame = encrypt_record(transport, RECORD_FINAL, &[]);
        socket
            .send(Message::Binary(frame.into()))
            .await
            .expect("send empty encrypted message");
        return;
    }
    while let Some(chunk) = chunks.next() {
        let flag = if chunks.peek().is_some() {
            RECORD_CONTINUATION
        } else {
            RECORD_FINAL
        };
        let frame = encrypt_record(transport, flag, chunk);
        socket
            .send(Message::Binary(frame.into()))
            .await
            .expect("send encrypted record");
    }
}

async fn recv_encrypted(socket: &mut TestSocket, transport: &mut TransportState) -> Vec<u8> {
    let mut assembled = Vec::new();
    loop {
        let frame = timeout(Duration::from_secs(3), socket.next())
            .await
            .expect("encrypted message timeout")
            .expect("socket remains open")
            .expect("encrypted frame");
        match frame {
            Message::Binary(frame) => {
                let mut record = vec![0_u8; MAX_CIPHERTEXT_BYTES];
                let len = transport
                    .read_message(&frame, &mut record)
                    .expect("decrypt record");
                assert!(len > 0, "record contains a flag byte");
                assembled.extend_from_slice(&record[1..len]);
                match record[0] {
                    RECORD_FINAL => return assembled,
                    RECORD_CONTINUATION => {}
                    flag => panic!("unknown record flag {flag}"),
                }
            }
            Message::Ping(_) | Message::Pong(_) => {}
            other => panic!("expected encrypted binary frame, got {other:?}"),
        }
    }
}

async fn recv_encrypted_json(socket: &mut TestSocket, transport: &mut TransportState) -> Value {
    serde_json::from_slice(&recv_encrypted(socket, transport).await)
        .expect("encrypted JSON message")
}

async fn pair_inside_channel(
    handle: &ServerHandle,
    root: &Path,
    pairing: &str,
) -> (TestSocket, TransportState, Value) {
    let host_key = read_host_public_key(root);
    let (mut socket, mut transport) = noise_connect(handle.local_addr(), &host_key).await;
    send_encrypted(
        &mut socket,
        &mut transport,
        json!({ "type": "e2ee_auth", "pairing": pairing })
            .to_string()
            .as_bytes(),
    )
    .await;
    let reply = recv_encrypted_json(&mut socket, &mut transport).await;
    (socket, transport, reply)
}

async fn assert_get_config(socket: &mut TestSocket, transport: &mut TransportState) {
    send_encrypted(
        socket,
        transport,
        json!({
            "_tag": "Request",
            "id": "1",
            "tag": "server.getConfig",
            "payload": {},
            "headers": []
        })
        .to_string()
        .as_bytes(),
    )
    .await;
    let response = recv_encrypted_json(socket, transport).await;
    assert_eq!(response["_tag"], "Exit");
    assert_eq!(response["requestId"], "1");
    assert_eq!(response["exit"]["_tag"], "Success");
}

async fn next_close_code(socket: &mut TestSocket) -> Option<u16> {
    loop {
        let frame = timeout(Duration::from_secs(3), socket.next())
            .await
            .expect("close timeout");
        match frame {
            Some(Ok(Message::Close(close))) => {
                return close.map(|frame| u16::from(frame.code));
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_))) => {}
            Some(Ok(Message::Text(_))) => {}
            Some(Err(_)) | None => return None,
            Some(Ok(Message::Frame(_))) => {}
        }
    }
}

async fn exchange_plain_token(client: &Client, handle: &ServerHandle, credential: &str) -> String {
    let response = client
        .post(http_url(handle, "/oauth/token"))
        .form(&[
            ("grant_type", TOKEN_GRANT_TYPE),
            ("subject_token", credential),
            ("subject_token_type", BOOTSTRAP_TOKEN_TYPE),
            ("requested_token_type", ACCESS_TOKEN_TYPE),
        ])
        .send()
        .await
        .expect("plain token exchange");
    assert_eq!(response.status(), StatusCode::OK);
    response.json::<Value>().await.expect("token JSON")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned()
}

async fn plain_ws_request(address: SocketAddr, bearer: &str) -> Result<TestSocket, StatusCode> {
    let mut request = ws_url(address, "/ws")
        .into_client_request()
        .expect("plain WebSocket request");
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {bearer}")).expect("bearer header"),
    );
    match connect_async(request).await {
        Ok((socket, _)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            Err(StatusCode::from_u16(response.status().as_u16()).expect("HTTP status"))
        }
        Err(error) => panic!("unexpected WebSocket error: {error}"),
    }
}

#[tokio::test]
async fn pairing_bootstrap_inside_the_channel_serves_get_config() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let startup = handle.startup_access().expect("startup pairing");
    let descriptor = Client::new()
        .get(http_url(&handle, "/.well-known/bibcode/environment"))
        .send()
        .await
        .expect("descriptor request")
        .json::<Value>()
        .await
        .expect("descriptor JSON");

    let (mut socket, mut transport, reply) =
        pair_inside_channel(&handle, temp.path(), &startup.credential).await;
    assert_eq!(reply["type"], "e2ee_authenticated");
    assert!(
        reply["credential"]
            .as_str()
            .is_some_and(|token| !token.is_empty())
    );
    assert_eq!(reply["environmentId"], descriptor["environmentId"]);
    assert_eq!(reply["storageInstanceId"], descriptor["storageInstanceId"]);
    assert_get_config(&mut socket, &mut transport).await;
}

#[tokio::test]
async fn bearer_form_reconnect_works_with_the_in_channel_credential() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let startup = handle.startup_access().expect("startup pairing");
    let (mut first, _first_transport, reply) =
        pair_inside_channel(&handle, temp.path(), &startup.credential).await;
    let credential = reply["credential"].as_str().expect("minted credential");
    first.close(None).await.expect("close first connection");

    let host_key = read_host_public_key(temp.path());
    let (mut socket, mut transport) = noise_connect(handle.local_addr(), &host_key).await;
    send_encrypted(
        &mut socket,
        &mut transport,
        json!({ "type": "e2ee_auth", "bearer": credential })
            .to_string()
            .as_bytes(),
    )
    .await;
    assert_eq!(
        recv_encrypted_json(&mut socket, &mut transport).await,
        json!({ "type": "e2ee_authenticated" })
    );
    assert_get_config(&mut socket, &mut transport).await;
}

#[tokio::test]
async fn no_downgrade_e2ee_credential_is_rejected_on_plain_surfaces() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let client = Client::new();
    let startup = handle.startup_access().expect("startup pairing");
    let plain_credential = exchange_plain_token(&client, &handle, &startup.credential).await;
    let pairing_response = client
        .post(http_url(&handle, "/api/auth/pairing-token"))
        .bearer_auth(&plain_credential)
        .json(&json!({ "label": "e2ee test" }))
        .send()
        .await
        .expect("pairing request");
    assert_eq!(pairing_response.status(), StatusCode::OK);
    let pairing = pairing_response
        .json::<Value>()
        .await
        .expect("pairing JSON")["credential"]
        .as_str()
        .expect("pairing credential")
        .to_owned();
    let (_socket, _transport, reply) = pair_inside_channel(&handle, temp.path(), &pairing).await;
    let e2ee_credential = reply["credential"].as_str().expect("e2ee credential");

    let session = client
        .get(http_url(&handle, "/api/auth/session"))
        .bearer_auth(e2ee_credential)
        .send()
        .await
        .expect("e2ee session request");
    assert_eq!(session.status(), StatusCode::OK);
    assert_eq!(
        session.json::<Value>().await.expect("session JSON")["authenticated"],
        false
    );
    assert_eq!(
        client
            .post(http_url(&handle, "/api/auth/websocket-ticket"))
            .bearer_auth(e2ee_credential)
            .send()
            .await
            .expect("e2ee ticket request")
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        plain_ws_request(handle.local_addr(), e2ee_credential)
            .await
            .expect_err("e2ee credential cannot open plain WebSocket"),
        StatusCode::UNAUTHORIZED
    );

    let plain_session = client
        .get(http_url(&handle, "/api/auth/session"))
        .bearer_auth(&plain_credential)
        .send()
        .await
        .expect("plain session request");
    assert_eq!(plain_session.status(), StatusCode::OK);
    assert_eq!(
        plain_session
            .json::<Value>()
            .await
            .expect("plain session JSON")["authenticated"],
        true
    );
    assert_eq!(
        client
            .post(http_url(&handle, "/api/auth/websocket-ticket"))
            .bearer_auth(&plain_credential)
            .send()
            .await
            .expect("plain ticket request")
            .status(),
        StatusCode::OK
    );
    let mut plain_socket = plain_ws_request(handle.local_addr(), &plain_credential)
        .await
        .expect("plain credential opens plain WebSocket");
    plain_socket.close(None).await.expect("close plain socket");
}

#[tokio::test]
async fn bad_pairing_token_gets_e2ee_error_unauthorized_and_stays_unconsumed() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let startup_credential = handle
        .startup_access()
        .expect("startup pairing")
        .credential
        .clone();
    let host_key = read_host_public_key(temp.path());
    let (mut bad_socket, mut bad_transport) = noise_connect(handle.local_addr(), &host_key).await;
    send_encrypted(
        &mut bad_socket,
        &mut bad_transport,
        br#"{"type":"e2ee_auth","pairing":"nope"}"#,
    )
    .await;
    assert_eq!(
        recv_encrypted_json(&mut bad_socket, &mut bad_transport).await,
        json!({ "type": "e2ee_error", "code": "unauthorized" })
    );
    let _ = next_close_code(&mut bad_socket).await;

    let (dropped, _transport) = noise_connect(handle.local_addr(), &host_key).await;
    drop(dropped);
    let (_socket, _transport, reply) =
        pair_inside_channel(&handle, temp.path(), &startup_credential).await;
    assert_eq!(reply["type"], "e2ee_authenticated");
}

#[tokio::test]
async fn bad_bearer_gets_e2ee_error_unauthorized() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let host_key = read_host_public_key(temp.path());
    let (mut socket, mut transport) = noise_connect(handle.local_addr(), &host_key).await;
    send_encrypted(
        &mut socket,
        &mut transport,
        br#"{"type":"e2ee_auth","bearer":"garbage"}"#,
    )
    .await;
    assert_eq!(
        recv_encrypted_json(&mut socket, &mut transport).await,
        json!({ "type": "e2ee_error", "code": "unauthorized" })
    );
    let _ = next_close_code(&mut socket).await;
}

#[tokio::test]
async fn wrong_host_key_closes_with_4403() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let wrong_keypair = snow::Builder::new(NOISE_NK_PARAMS.parse().expect("Noise parameters"))
        .generate_keypair()
        .expect("wrong keypair");
    let mut initiator = initiator(&wrong_keypair.public);
    let mut socket = open_socket(handle.local_addr()).await;
    let mut message_a = vec![0_u8; MAX_CIPHERTEXT_BYTES];
    let len = initiator
        .write_message(&[], &mut message_a)
        .expect("wrong-key message A");
    message_a.truncate(len);
    socket
        .send(Message::Binary(message_a.into()))
        .await
        .expect("send wrong-key message A");
    assert_eq!(next_close_code(&mut socket).await, Some(4403));
}

#[tokio::test]
async fn non_empty_handshake_payload_is_rejected() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let host_key = read_host_public_key(temp.path());
    let mut initiator = initiator(&host_key);
    let mut socket = open_socket(handle.local_addr()).await;
    let mut message_a = vec![0_u8; MAX_CIPHERTEXT_BYTES];
    let len = initiator
        .write_message(b"x", &mut message_a)
        .expect("non-empty message A");
    message_a.truncate(len);
    socket
        .send(Message::Binary(message_a.into()))
        .await
        .expect("send non-empty message A");
    assert_eq!(next_close_code(&mut socket).await, None);
}

#[tokio::test]
async fn oversized_binary_frame_closes_the_connection() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let startup = handle.startup_access().expect("startup pairing");
    let (mut socket, _transport, reply) =
        pair_inside_channel(&handle, temp.path(), &startup.credential).await;
    assert_eq!(reply["type"], "e2ee_authenticated");
    socket
        .send(Message::Binary(vec![0_u8; MAX_CIPHERTEXT_BYTES + 1].into()))
        .await
        .expect("send oversized frame");
    let _ = next_close_code(&mut socket).await;
}

#[tokio::test]
async fn preauth_message_cap_is_64kib() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let host_key = read_host_public_key(temp.path());
    let (mut socket, mut transport) = noise_connect(handle.local_addr(), &host_key).await;
    for (flag, length) in [
        (RECORD_CONTINUATION, 40 * 1024),
        (RECORD_CONTINUATION, 40 * 1024),
        (RECORD_FINAL, 0),
    ] {
        let frame = encrypt_record(&mut transport, flag, &vec![b'a'; length]);
        socket
            .send(Message::Binary(frame.into()))
            .await
            .expect("send pre-auth record");
    }
    let _ = next_close_code(&mut socket).await;
}

#[tokio::test]
async fn handshake_timeout_closes_the_socket() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let mut socket = open_socket(handle.local_addr()).await;
    let frame = timeout(Duration::from_secs(12), socket.next())
        .await
        .expect("server enforces the ten-second combined deadline");
    assert!(matches!(
        frame,
        None | Some(Ok(Message::Close(_))) | Some(Err(_))
    ));
}

#[tokio::test]
async fn preauth_connection_cap_rejects_the_overflow_connection() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let host_key = read_host_public_key(temp.path());
    let mut stalled = Vec::with_capacity(E2EE_MAX_PREAUTH_CONNECTIONS);
    for _ in 0..E2EE_MAX_PREAUTH_CONNECTIONS {
        stalled.push(noise_connect(handle.local_addr(), &host_key).await);
    }
    let mut overflow = open_socket(handle.local_addr()).await;
    assert_eq!(next_close_code(&mut overflow).await, Some(1013));

    let (released, _) = stalled.pop().expect("one stalled connection");
    drop(released);
    tokio::task::yield_now().await;
    let (mut admitted, _) = noise_connect(handle.local_addr(), &host_key).await;
    admitted
        .close(None)
        .await
        .expect("close admitted connection");
}

#[tokio::test]
async fn text_frames_before_handshake_are_rejected() {
    let _permit = TEST_PERMIT.acquire().await.expect("test permit");
    let temp = TempDir::new().expect("temporary base directory");
    let handle = start_server(&temp).await;
    let mut socket = open_socket(handle.local_addr()).await;
    socket
        .send(Message::Text("plaintext".into()))
        .await
        .expect("send plaintext frame");
    assert_eq!(next_close_code(&mut socket).await, None);
}
