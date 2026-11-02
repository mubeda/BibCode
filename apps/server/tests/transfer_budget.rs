//! The transfer budget (#225): how many bytes the server sends to open the app and a big thread.
//!
//! It builds the deterministic large-store fixture (`support/load_fixture.rs`), serves it over a
//! real `/ws` to a client that offers the compressed subprotocol, and records, for the shell
//! snapshot, the big thread's first `subscribeThread` item and the answer to a resume, the bytes
//! of the WebSocket payloads (what the browser's DevTools count: after the transport's deflate,
//! before TCP, TLS and WebSocket framing) and the bytes of the JSON they decode to. Each must stay
//! under `transfer_budget.json`. A budget is raised only by editing that file in the same change.
//! `BIBCODE_TRANSFER_REPORT=<path>` also writes the measurements as JSON, whether or not they
//! pass; the PR transfer report workflow uses it.

use std::{collections::BTreeMap, io::Read as _, path::Path, time::Duration};

use bibcode_server::{
    RpcRegistry, ServerConfig, ServerRuntime,
    orchestration::{EngineOptions, OrchestrationEngine},
    persistence::{Database, Repositories, run_migrations},
    production::orchestration_rpc::register_orchestration_rpc,
};
use futures_util::SinkExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};

#[path = "support/load_fixture.rs"]
mod load_fixture;
#[path = "support/websocket_frames.rs"]
mod websocket_frames;
use websocket_frames::next_frame_past_heartbeat;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const BUDGET: &str = include_str!("transfer_budget.json");
const RECORD_CONTINUATION: u8 = 0x01;
const RECORD_CONTROL: u8 = 0x02;
const RECORD_DEFLATE: u8 = 0x10;

/// The first message a request received, and what it cost.
struct Exchange {
    /// WebSocket payload bytes, as the browser counts them: records after deflate.
    wire_bytes: usize,
    /// Bytes of the JSON message those records decode to.
    decoded_bytes: usize,
    /// The first item of the stream chunk.
    item: Value,
}

async fn engine_with_fixture(workspaces: &Path) -> OrchestrationEngine {
    let database = Database::open_in_memory().await.expect("database");
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .expect("migrations");
    load_fixture::seed(&Repositories::new(database.clone()), workspaces).await;
    OrchestrationEngine::start(database, EngineOptions::default())
        .await
        .expect("engine starts")
}

async fn connect(address: std::net::SocketAddr) -> Socket {
    // What the app offers: compressed records first, plain records for an older server.
    let mut request = format!("ws://{address}/ws")
        .into_client_request()
        .expect("WebSocket request");
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static("bibcode.rpc.chunked-deflate.v1, bibcode.rpc.chunked.v1"),
    );
    let (socket, response) = connect_async(request).await.expect("WebSocket connects");
    assert_eq!(
        response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok()),
        Some("bibcode.rpc.chunked-deflate.v1"),
        "the server must prefer compression, or the budget measures the wrong path"
    );
    socket
}

/// Sends one request and reads until the first stream chunk for it is whole.
async fn first_chunk(socket: &mut Socket, id: &str, tag: &str, payload: Value) -> Exchange {
    socket
        .send(Message::Text(
            json!({ "_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": [] })
                .to_string()
                .into(),
        ))
        .await
        .expect("request is sent");
    let mut wire_bytes = 0;
    let mut record_body = Vec::new();
    loop {
        let frame = timeout(Duration::from_secs(30), next_frame_past_heartbeat(socket))
            .await
            .expect("the first chunk arrives")
            .expect("the socket stays open")
            .expect("a valid frame");
        let (decoded, complete): (Vec<u8>, bool) = match frame {
            Message::Text(text) => {
                wire_bytes += text.len();
                (text.as_bytes().to_vec(), true)
            }
            Message::Binary(record) => {
                wire_bytes += record.len();
                let flag = record[0];
                if flag == RECORD_CONTROL {
                    (record[1..].to_vec(), true)
                } else {
                    record_body.extend_from_slice(&record[1..]);
                    if flag & RECORD_CONTINUATION != 0 {
                        continue;
                    }
                    let body = std::mem::take(&mut record_body);
                    if flag & RECORD_DEFLATE == 0 {
                        (body, true)
                    } else {
                        let mut inflated = Vec::new();
                        flate2::read::DeflateDecoder::new(&body[4..])
                            .read_to_end(&mut inflated)
                            .expect("raw deflate after the length prefix");
                        (inflated, true)
                    }
                }
            }
            other => panic!("unexpected frame {other:?}"),
        };
        assert!(complete);
        let message: Value = serde_json::from_slice(&decoded).expect("a JSON message");
        if message["requestId"] == id {
            assert_eq!(message["_tag"], "Chunk", "{message}");
            return Exchange {
                wire_bytes,
                decoded_bytes: decoded.len(),
                item: message["values"][0].clone(),
            };
        }
        wire_bytes = 0;
    }
}

struct Measured {
    shell: Exchange,
    thread: Exchange,
    resume: Exchange,
    /// The big thread's first item for a client that opens a history window (#226), as the app
    /// does; `thread` is what an older client, which asks for the whole thread, receives.
    window: Exchange,
}

async fn measure() -> Measured {
    let temp = TempDir::new().expect("temporary base directory");
    let engine = engine_with_fixture(temp.path()).await;
    let mut registry = RpcRegistry::empty();
    register_orchestration_rpc(&mut registry, engine.clone());
    let handle = ServerRuntime::start_with_registry(
        ServerConfig::new(temp.path())
            .with_bind("127.0.0.1", 0)
            .with_unsafe_no_auth(),
        registry,
    )
    .await
    .expect("server starts");
    let mut socket = connect(handle.local_addr()).await;
    let shell = first_chunk(&mut socket, "1", "orchestration.subscribeShell", json!({})).await;
    let thread = first_chunk(
        &mut socket,
        "2",
        "orchestration.subscribeThread",
        json!({ "threadId": load_fixture::BIG_THREAD_ID, "patches": true }),
    )
    .await;
    let window = first_chunk(
        &mut socket,
        "3",
        "orchestration.subscribeThread",
        json!({ "threadId": load_fixture::BIG_THREAD_ID, "patches": true, "history": {} }),
    )
    .await;
    drop(socket);
    // A reconnect: a new socket asks for the thread it already holds.
    let mut socket = connect(handle.local_addr()).await;
    let resume = first_chunk(
        &mut socket,
        "1",
        "orchestration.subscribeThread",
        json!({
            "threadId": load_fixture::BIG_THREAD_ID,
            "patches": true,
            "resume": {
                "revision": thread.item["revision"],
                "snapshotSequence": thread.item["snapshot"]["snapshotSequence"],
            },
        }),
    )
    .await;
    drop(socket);
    handle.shutdown();
    handle.join().await.expect("server joins");
    engine.shutdown().await;
    Measured {
        shell,
        thread,
        resume,
        window,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn payloads_stay_within_the_transfer_budget() {
    let measured = measure().await;
    let rows = [
        ("shell", &measured.shell),
        ("thread", &measured.thread),
        ("resume", &measured.resume),
        ("window", &measured.window),
    ];
    let budget: BTreeMap<String, BTreeMap<String, usize>> =
        serde_json::from_str(BUDGET).expect("transfer_budget.json is valid");
    if let Some(path) = std::env::var_os("BIBCODE_TRANSFER_REPORT") {
        let report = rows
            .iter()
            .map(|(name, exchange)| {
                (
                    (*name).to_owned(),
                    json!({
                        "wireBytes": exchange.wire_bytes,
                        "decodedBytes": exchange.decoded_bytes,
                    }),
                )
            })
            .collect::<BTreeMap<_, _>>();
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n")
            .expect("report is written");
    }
    let mut table = String::from("payload | metric | bytes | budget\n");
    let mut exceeded = false;
    for (name, exchange) in rows {
        for (metric, bytes) in [
            ("wireBytes", exchange.wire_bytes),
            ("decodedBytes", exchange.decoded_bytes),
        ] {
            let limit = budget[name][metric];
            exceeded |= bytes > limit;
            table.push_str(&format!(
                "{name} | {metric} | {bytes} | {limit}{}\n",
                if bytes > limit { "  <- OVER" } else { "" }
            ));
        }
    }
    assert!(
        !exceeded,
        "a payload grew past apps/server/tests/transfer_budget.json; raise its budget there only if the growth is intended:\n{table}"
    );
}

/// The fixture matches what the issue asks for, so the budget measures a big thread.
#[tokio::test(flavor = "multi_thread")]
async fn the_fixture_is_a_big_thread_in_a_big_shell() {
    let measured = measure().await;
    let thread = &measured.thread.item["snapshot"]["thread"];
    assert_eq!(thread["title"], load_fixture::BIG_THREAD_TITLE);
    assert_eq!(thread["messages"].as_array().unwrap().len(), 400);
    assert!(thread["activities"].as_array().unwrap().len() >= 1_600);
    assert!(!thread["proposedPlans"].as_array().unwrap().is_empty());
    let widest = thread["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|checkpoint| {
            // The stream sends 200 files of a checkpoint and their total (#227).
            assert!(checkpoint["files"].as_array().unwrap().len() <= 200);
            checkpoint["filesTotal"].as_u64().unwrap()
        })
        .max()
        .unwrap();
    assert!(widest >= 2_000, "{widest}");
    let largest_detail = thread["activities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|activity| activity["payload"]["detail"].as_str().unwrap().len())
        .max()
        .unwrap();
    assert!(
        (12_000..=16_384).contains(&largest_detail),
        "{largest_detail}"
    );
    let shell = &measured.shell.item["snapshot"];
    let threads = shell["threads"].as_array().unwrap();
    assert_eq!(threads.len(), load_fixture::NON_ARCHIVED_THREADS);
    assert_eq!(
        shell["projects"].as_array().unwrap().len(),
        load_fixture::PROJECT_COUNT
    );
    assert!(threads.iter().any(|thread| thread["kind"] == "panel"));
    assert_eq!(measured.resume.item["kind"], "unchanged");
    // The window holds recent history and says how much more the server has (#226).
    let window = &measured.window.item["snapshot"]["thread"];
    assert_eq!(window["history"]["hasOlder"], true);
    assert!(window["history"]["olderRows"].as_u64().unwrap() > 0);
    assert!(window["messages"].as_array().unwrap().len() < 400);
}

/// Two builds give byte-identical payloads, so a budget change is always a code change.
#[tokio::test(flavor = "multi_thread")]
async fn two_builds_give_identical_payloads() {
    // What a build legitimately varies in: the clock, and the temporary directory the workspaces are in.
    let strip_environment = |mut shell: Value| {
        shell["snapshot"]
            .as_object_mut()
            .unwrap()
            .remove("updatedAt");
        for project in shell["snapshot"]["projects"].as_array_mut().unwrap() {
            project.as_object_mut().unwrap().remove("workspaceRoot");
        }
        for thread in shell["snapshot"]["threads"].as_array_mut().unwrap() {
            thread.as_object_mut().unwrap().remove("lastActivityAgeMs");
        }
        serde_json::to_vec(&shell).unwrap()
    };
    let (first, second) = (measure().await, measure().await);
    assert_eq!(
        serde_json::to_vec(&first.thread.item["snapshot"]).unwrap(),
        serde_json::to_vec(&second.thread.item["snapshot"]).unwrap()
    );
    assert_eq!(
        strip_environment(first.shell.item),
        strip_environment(second.shell.item)
    );
}
