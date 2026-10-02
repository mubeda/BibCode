use std::{path::Path, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use bibcode_server::{
    ClientMessage, RequestId, RpcExit, RpcRegistry, ServerConfig, ServerMessage, ServerRuntime,
    mcp,
    preview::PreviewManager,
    workspace::{WorkspaceRpc, WorkspaceService},
};
use futures_util::SinkExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use bibcode_server::production::workspace_preview::{
    WorkspacePreviewRpcServices, register_workspace_preview_rpc,
};

#[path = "support/websocket_frames.rs"]
mod websocket_frames;
use websocket_frames::next_frame_past_heartbeat;

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn test_config(temp: &TempDir) -> ServerConfig {
    ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_unsafe_no_auth()
}

async fn send_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("send WebSocket message");
}

async fn next_server_message<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> ServerMessage
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = timeout(Duration::from_secs(2), next_frame_past_heartbeat(socket))
        .await
        .expect("WebSocket response timeout")
        .expect("WebSocket remains open")
        .expect("valid WebSocket frame");
    let Message::Text(text) = message else {
        panic!("expected text WebSocket message, got {message:?}");
    };
    serde_json::from_str(&text).expect("valid server RPC message")
}

async fn request<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    id: &str,
    tag: &str,
    payload: Value,
) -> ServerMessage
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json(
        socket,
        json!({
            "_tag": "Request",
            "id": id,
            "tag": tag,
            "payload": payload,
            "headers": []
        }),
    )
    .await;
    next_server_message(socket).await
}

async fn collect_download<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    id: &str,
    payload: Value,
) -> Vec<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut message = request(socket, id, "projects.readDownload", payload).await;
    let mut events = Vec::new();
    loop {
        match message {
            ServerMessage::Chunk { request_id, values } => {
                assert!(!values.is_empty());
                events.extend(values);
                send_json(socket, json!({"_tag":"Ack","requestId":request_id})).await;
            }
            ServerMessage::Exit {
                exit: RpcExit::Success { .. },
                ..
            } => break,
            other => panic!("download failed: {other:?}"),
        }
        message = next_server_message(socket).await;
    }
    events
}

#[tokio::test]
async fn download_streams_exact_files_resume_empty_and_archives_over_effect_rpc() {
    let temp = TempDir::new().unwrap();
    std::fs::write(temp.path().join("a"), b"abcdef").unwrap();
    std::fs::write(temp.path().join("empty"), b"").unwrap();
    std::fs::create_dir(temp.path().join("src")).unwrap();
    std::fs::write(temp.path().join("src/a"), b"zipped").unwrap();
    let mut registry = RpcRegistry::empty();
    register_workspace_preview_rpc(
        &mut registry,
        WorkspacePreviewRpcServices::new(
            WorkspaceRpc::new(WorkspaceService::default()),
            PreviewManager::new(),
            mcp::preview_automation::PreviewAutomationBroker::new(),
        ),
    );
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .unwrap();
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .unwrap();
    let values = collect_download(
        &mut socket,
        "1",
        json!({"cwd":temp.path(),"relativePath":"a"}),
    )
    .await;
    assert_eq!(values[0]["sizeBytes"], 6);
    assert_eq!(
        STANDARD
            .decode(values[1]["data"].as_str().unwrap())
            .unwrap(),
        b"abcdef"
    );
    let resumed = collect_download(
        &mut socket,
        "2",
        json!({"cwd":temp.path(),"relativePath":"a","offset":3,"expect":values[0]["version"]}),
    )
    .await;
    assert_eq!(resumed[1]["offset"], 3);
    assert_eq!(
        STANDARD
            .decode(resumed[1]["data"].as_str().unwrap())
            .unwrap(),
        b"def"
    );
    assert_eq!(resumed.last().unwrap()["totalBytes"], 6);
    let empty = collect_download(
        &mut socket,
        "3",
        json!({"cwd":temp.path(),"relativePath":"empty"}),
    )
    .await;
    assert_eq!(empty.len(), 2);
    assert_eq!(empty[1], json!({"_tag":"end","totalBytes":0}));
    let values = collect_download(
        &mut socket,
        "4",
        json!({"cwd":temp.path(),"relativePath":"src"}),
    )
    .await;
    assert_eq!(values[0]["kind"], "archive");
    assert!(values[0]["sizeBytes"].is_null());
    let bytes: Vec<u8> = values
        .iter()
        .filter(|value| value["_tag"] == "bytes")
        .flat_map(|value| STANDARD.decode(value["data"].as_str().unwrap()).unwrap())
        .collect();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut content = Vec::new();
    std::io::Read::read_to_end(&mut zip.by_name("a").unwrap(), &mut content).unwrap();
    assert_eq!(content, b"zipped");
    let denied = request(
        &mut socket,
        "5",
        "projects.readDownload",
        json!({"cwd":temp.path(),"relativePath":"a","offset":1}),
    )
    .await;
    assert!(
        matches!(denied,ServerMessage::Exit {exit:RpcExit::Failure {cause},..} if serde_json::to_value(&cause).unwrap()[0]["error"]["reason"]=="changed")
    );
    // Refused and empty streams leave the same connection available for ordinary calls.
    assert!(matches!(
        request(
            &mut socket,
            "6",
            "projects.readFile",
            json!({"cwd":temp.path(),"relativePath":"a"})
        )
        .await,
        ServerMessage::Exit {
            exit: RpcExit::Success { .. },
            ..
        }
    ));
    socket.close(None).await.unwrap();
    handle.shutdown();
    handle.join().await.unwrap();
}

#[tokio::test]
async fn asset_stream_packs_exact_fallback_over_effect_rpc_without_minting() {
    let temp = TempDir::new().unwrap();
    let mut registry = RpcRegistry::empty();
    let workspace = WorkspaceRpc::with_dependencies(
        WorkspaceService::default(),
        bibcode_server::workspace::WorkspaceRpcDependencies {
            asset_access: Some(bibcode_server::assets::AssetAccess::new(
                vec![4; 32],
                temp.path().join("attachments"),
            )),
            ..Default::default()
        },
    );
    register_workspace_preview_rpc(
        &mut registry,
        WorkspacePreviewRpcServices::new(
            workspace,
            PreviewManager::new(),
            mcp::preview_automation::PreviewAutomationBroker::new(),
        ),
    );
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .unwrap();
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .unwrap();
    match request(
        &mut socket,
        "1",
        "assets.read",
        json!({"resource":{"_tag":"project-favicon","cwd":temp.path()}}),
    )
    .await
    {
        ServerMessage::Chunk { values, request_id } => {
            assert_eq!(values.len(), 3);
            assert_eq!(values[0]["mimeType"], "image/svg+xml");
            assert_eq!(
                STANDARD
                    .decode(values[1]["data"].as_str().unwrap())
                    .unwrap(),
                bibcode_server::assets::FALLBACK_FAVICON.as_bytes()
            );
            assert_eq!(values[2]["_tag"], "end");
            send_json(&mut socket, json!({"_tag":"Ack","requestId":request_id})).await;
        }
        other => panic!("expected exact asset: {other:?}"),
    }
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit {
            exit: RpcExit::Success { .. },
            ..
        }
    ));
    socket.close(None).await.unwrap();
    handle.shutdown();
    handle.join().await.unwrap();
}

#[tokio::test]
async fn concrete_workspace_and_preview_handlers_run_through_effect_transport() {
    let temp = TempDir::new().expect("temporary base directory");
    tokio::fs::write(temp.path().join("existing.txt"), "hello")
        .await
        .expect("fixture");
    let mut registry = RpcRegistry::empty();
    register_workspace_preview_rpc(
        &mut registry,
        WorkspacePreviewRpcServices::new(
            WorkspaceRpc::new(WorkspaceService::default()),
            PreviewManager::new(),
            mcp::preview_automation::PreviewAutomationBroker::new(),
        ),
    );
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");
    let cwd = path_string(temp.path());

    let created = request(
        &mut socket,
        "1",
        "projects.createEntry",
        json!({"cwd": cwd, "relativePath": "created.txt", "kind": "file"}),
    )
    .await;
    assert!(matches!(
        created,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } if value == json!({"relativePath": "created.txt"})
    ));

    let opened = request(
        &mut socket,
        "2",
        "preview.open",
        json!({"threadId": "thread-1", "url": "localhost:4173"}),
    )
    .await;
    let tab_id = match opened {
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } => {
            assert_eq!(value["threadId"], "thread-1");
            assert_eq!(value["navStatus"]["_tag"], "Loading");
            value["tabId"].as_str().expect("tab id").to_owned()
        }
        message => panic!("unexpected preview.open response: {message:?}"),
    };

    let resized = request(
        &mut socket,
        "4",
        "preview.resize",
        json!({
            "threadId": "thread-1",
            "tabId": tab_id.clone(),
            "viewport": {
                "_tag": "preset",
                "presetId": "iphone-se",
                "width": 375,
                "height": 667
            }
        }),
    )
    .await;
    assert!(matches!(
        resized,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } if value["viewport"]["presetId"] == "iphone-se"
            && value["viewport"].get("preset_id").is_none()
    ));

    let listed = request(
        &mut socket,
        "3",
        "preview.list",
        json!({"threadId": "thread-1"}),
    )
    .await;
    assert!(matches!(
        listed,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(value) },
            ..
        } if value["sessions"][0]["tabId"] == tab_id
    ));

    let assigned_unary_methods = [
        "assets.createUrl",
        "filesystem.browse",
        "projects.createEntry",
        "projects.deleteEntry",
        "projects.duplicateEntry",
        "projects.listEntries",
        "projects.readFile",
        "projects.renameEntry",
        "projects.searchEntries",
        "projects.writeFile",
        "review.getDiffPreview",
        "preview.close",
        "preview.list",
        "preview.navigate",
        "preview.open",
        "preview.refresh",
        "preview.reportStatus",
        "preview.resize",
        "previewAutomation.focusHost",
        "previewAutomation.respond",
    ];
    for (index, method) in assigned_unary_methods.into_iter().enumerate() {
        let response = request(&mut socket, &(100 + index).to_string(), method, json!({})).await;
        match response {
            ServerMessage::Exit {
                exit: RpcExit::Failure { cause },
                ..
            } => assert!(
                !cause.is_empty(),
                "{method} returned an empty failure cause"
            ),
            ServerMessage::Exit {
                exit: RpcExit::Success { .. },
                ..
            } => {}
            message => panic!("unexpected response for {method}: {message:?}"),
        }
    }

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn project_entries_stream_starts_with_a_resync_signal() {
    let temp = TempDir::new().expect("temporary base directory");
    tokio::fs::write(temp.path().join("existing.txt"), "hello")
        .await
        .expect("fixture");
    let mut registry = RpcRegistry::empty();
    register_workspace_preview_rpc(
        &mut registry,
        WorkspacePreviewRpcServices::new(
            WorkspaceRpc::new(WorkspaceService::default()),
            PreviewManager::new(),
            mcp::preview_automation::PreviewAutomationBroker::new(),
        ),
    );
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");
    let cwd = path_string(temp.path());

    send_json(
        &mut socket,
        json!({
            "_tag": "Request",
            "id": "11",
            "tag": "subscribeProjectEntries",
            "payload": { "cwd": cwd },
            "headers": []
        }),
    )
    .await;
    match next_server_message(&mut socket).await {
        ServerMessage::Chunk { values, .. } => {
            assert_eq!(values, vec![json!({ "cwd": cwd })]);
        }
        message => panic!("expected initial project-entry resync chunk, got {message:?}"),
    }

    send_json(
        &mut socket,
        serde_json::to_value(ClientMessage::Ack {
            request_id: RequestId::try_from("11").expect("request id"),
        })
        .expect("ack"),
    )
    .await;
    send_json(
        &mut socket,
        serde_json::to_value(ClientMessage::Interrupt {
            request_id: RequestId::try_from("11").expect("request id"),
        })
        .expect("interrupt"),
    )
    .await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit { .. }
    ));

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn preview_automation_connect_stream_is_bounded_and_cancellable() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut registry = RpcRegistry::empty();
    register_workspace_preview_rpc(
        &mut registry,
        WorkspacePreviewRpcServices::new(
            WorkspaceRpc::new(WorkspaceService::default()),
            PreviewManager::new(),
            mcp::preview_automation::PreviewAutomationBroker::new(),
        ),
    );
    let handle = ServerRuntime::start_with_registry(test_config(&temp), registry)
        .await
        .expect("server starts");
    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    send_json(
        &mut socket,
        json!({
            "_tag": "Request",
            "id": "9",
            "tag": "previewAutomation.connect",
            "payload": {
                "clientId": "desktop-1",
                "environmentId": "local",
                "supportedOperations": ["open", "snapshot"]
            },
            "headers": []
        }),
    )
    .await;
    let connected = next_server_message(&mut socket).await;
    let connection_id = match connected {
        ServerMessage::Chunk { values, .. }
            if values.len() == 1 && values[0]["type"] == "connected" =>
        {
            values[0]["connectionId"]
                .as_str()
                .expect("connection id")
                .to_owned()
        }
        message => panic!("unexpected connect response: {message:?}"),
    };

    send_json(
        &mut socket,
        serde_json::to_value(ClientMessage::Ack {
            request_id: RequestId::try_from("9").expect("request id"),
        })
        .expect("ack"),
    )
    .await;
    let focused = request(
        &mut socket,
        "10",
        "previewAutomation.focusHost",
        json!({
            "clientId": "desktop-1",
            "environmentId": "local",
            "connectionId": connection_id,
            "focused": true
        }),
    )
    .await;
    assert!(matches!(
        focused,
        ServerMessage::Exit {
            exit: RpcExit::Success { .. },
            ..
        }
    ));
    send_json(
        &mut socket,
        serde_json::to_value(ClientMessage::Interrupt {
            request_id: RequestId::try_from("9").expect("request id"),
        })
        .expect("interrupt"),
    )
    .await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        ServerMessage::Exit {
            exit: RpcExit::Failure { .. },
            ..
        }
    ));

    socket.close(None).await.expect("close WebSocket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}
