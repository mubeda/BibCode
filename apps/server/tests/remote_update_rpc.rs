use bibcode_server::{RpcExit, ServerConfig, ServerMessage, ServerRuntime};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn disable_provider_processes(root: &std::path::Path) {
    let settings = root.join("userdata/settings.json");
    std::fs::create_dir_all(settings.parent().expect("settings parent"))
        .expect("settings directory");
    std::fs::write(
        settings,
        serde_json::to_vec(&json!({
            "providers": {
                "codex": {"enabled": false},
                "claudeAgent": {"enabled": false},
                "cursor": {"enabled": false},
                "grok": {"enabled": false},
                "opencode": {"enabled": false}
            }
        }))
        .expect("settings JSON"),
    )
    .expect("settings fixture");
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn call_unary(socket: &mut WsStream, id: &str, method: &str) -> ServerMessage {
    let request = json!({
        "_tag": "Request",
        "id": id,
        "tag": method,
        "payload": {},
        "headers": []
    });
    socket
        .send(Message::Text(request.to_string().into()))
        .await
        .expect("request sends");
    loop {
        let message = socket
            .next()
            .await
            .expect("socket yields")
            .expect("frame decodes");
        if let Message::Text(text) = message {
            let decoded: ServerMessage =
                serde_json::from_str(&text).expect("server message decodes");
            if matches!(decoded, ServerMessage::Exit { .. }) {
                return decoded;
            }
        }
    }
}

#[tokio::test]
async fn headless_server_answers_manual_update_surface() {
    let temp = TempDir::new().expect("data root");
    disable_provider_processes(temp.path());
    let config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_unsafe_no_auth();
    let handle = ServerRuntime::start(config).await.expect("server starts");

    // Descriptor advertises the surface before any RPC (covers apps/server/src/http.rs).
    let descriptor: Value = reqwest::get(format!(
        "http://{}/.well-known/bibcode/environment",
        handle.local_addr()
    ))
    .await
    .expect("descriptor fetch")
    .json()
    .await
    .expect("descriptor JSON");
    assert_eq!(descriptor["capabilities"]["remoteUpdateControl"], true);
    assert_eq!(
        descriptor["remoteUpdateSupport"],
        json!({ "installMode": "manual", "reason": "manual-update-required" })
    );

    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    let ServerMessage::Exit {
        exit: RpcExit::Success {
            value: Some(status),
        },
        ..
    } = call_unary(&mut socket, "1", "updater.status").await
    else {
        panic!("updater.status must succeed");
    };
    assert_eq!(status["state"], "idle");
    assert_eq!(status["latestVersion"], Value::Null);
    assert_eq!(status["support"]["installMode"], "manual");
    assert_eq!(status["serverVersion"], env!("CARGO_PKG_VERSION"));

    let checked = call_unary(&mut socket, "2", "updater.check").await;
    assert!(matches!(
        checked,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(ref value) },
            ..
        } if value["state"] == "idle" && value["latestVersion"] == Value::Null
    ));

    let install = call_unary(&mut socket, "3", "updater.install").await;
    let ServerMessage::Exit { exit, .. } = install else {
        panic!("expected exit");
    };
    let failure = serde_json::to_value(&exit).expect("exit serializes");
    let failure_text = failure.to_string();
    assert!(
        failure_text.contains("RemoteUpdateInstallError")
            && failure_text.contains("remote_update_manual_required"),
        "manual install must fail with the typed error, got {failure_text}"
    );

    socket.close(None).await.expect("close socket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}
