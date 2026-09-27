use std::{sync::Arc, time::Duration};

use bibcode_server::remote_update::{
    HostUpdaterFuture, HostUpdaterStatus, RemoteUpdateDelegate, RemoteUpdateInstallMode,
    RemoteUpdateState, RemoteUpdateSupport, RemoteUpdateSupportReason,
};
use bibcode_server::{
    RemoteUpdateInstallKind, RpcExit, ServerConfig, ServerMessage, ServerRuntime,
};
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

#[test]
fn the_status_contract_shape_round_trips_through_the_rust_snapshot() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../../packages/contracts/fixtures/rpc-wire/contract-shapes/updater__status-success.json",
    );
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("contract-shape fixture"))
            .expect("fixture JSON");
    let wire = fixture["exit"]["value"].clone();
    let snapshot: bibcode_server::RemoteUpdateSnapshot =
        serde_json::from_value(wire.clone()).expect("the Rust mirror decodes the TS shape");
    assert_eq!(snapshot.download_percent, Some(42));
    assert_eq!(
        serde_json::to_value(&snapshot).expect("snapshot re-encodes"),
        wire,
        "the Rust mirror must stay byte-identical to the TypeScript contract"
    );
}

async fn call_unary(socket: &mut WsStream, id: &str, method: &str) -> ServerMessage {
    call_unary_with(socket, id, method, json!({})).await
}

async fn call_unary_with(
    socket: &mut WsStream,
    id: &str,
    method: &str,
    payload: Value,
) -> ServerMessage {
    let request = json!({
        "_tag": "Request",
        "id": id,
        "tag": method,
        "payload": payload,
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

async fn wait_for_active_work(socket: &mut WsStream, next_id: &mut u64, expected: &Value) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let id = next_id.to_string();
            *next_id += 1;
            let ServerMessage::Exit {
                exit: RpcExit::Success { value: Some(value) },
                ..
            } = call_unary(socket, &id, "updater.activeWork").await
            else {
                panic!("updater.activeWork must succeed for every client");
            };
            if value == *expected {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("active work reaches the expected counts within five seconds")
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
    assert_eq!(descriptor["capabilities"]["terminalOrderedInput"], true);
    assert_eq!(
        descriptor["remoteUpdateSupport"],
        json!({
            "installMode": "manual",
            "reason": "manual-update-required",
            "installKind": "unknown"
        })
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

struct FixtureHostUpdater;

impl RemoteUpdateDelegate for FixtureHostUpdater {
    fn status(&self) -> HostUpdaterFuture {
        Box::pin(async {
            HostUpdaterStatus {
                latest_version: Some("9.9.9".to_owned()),
                state: RemoteUpdateState::UpdateAvailable,
                error: None,
                ..HostUpdaterStatus::default()
            }
        })
    }

    fn check(&self) -> HostUpdaterFuture {
        self.status()
    }

    fn request_install(&self) -> HostUpdaterFuture {
        Box::pin(async {
            HostUpdaterStatus {
                latest_version: Some("9.9.9".to_owned()),
                state: RemoteUpdateState::Installing,
                error: None,
                ..HostUpdaterStatus::default()
            }
        })
    }
}

#[tokio::test]
async fn desktop_integrated_server_routes_install_through_the_delegate() {
    let temp = TempDir::new().expect("data root");
    disable_provider_processes(temp.path());
    let config = ServerConfig::new(temp.path())
        .with_bind("127.0.0.1", 0)
        .with_unsafe_no_auth()
        .with_remote_update_support(RemoteUpdateSupport {
            install_mode: RemoteUpdateInstallMode::Interactive,
            reason: RemoteUpdateSupportReason::Available,
            install_kind: RemoteUpdateInstallKind::Unknown,
        });
    let handle = ServerRuntime::start_with_desktop_integration(
        config,
        std::sync::Arc::new(bibcode_server::diagnostics::UnavailableDesktopUiProcessObserver),
        Arc::new(FixtureHostUpdater),
    )
    .await
    .expect("server starts");

    let (mut socket, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("WebSocket connects");

    let checked = call_unary(&mut socket, "1", "updater.check").await;
    assert!(matches!(
        checked,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(ref value) },
            ..
        } if value["latestVersion"] == "9.9.9" && value["state"] == "update-available"
    ));

    let install = call_unary(&mut socket, "2", "updater.install").await;
    assert!(matches!(
        install,
        ServerMessage::Exit {
            exit: RpcExit::Success { value: Some(ref value) },
            ..
        } if value["state"] == "installing"
    ));

    socket.close(None).await.expect("close socket");
    handle.shutdown();
    handle.join().await.expect("server joins");
}

#[tokio::test]
async fn active_work_counts_work_from_every_client() {
    let temp = TempDir::new().expect("data root");
    disable_provider_processes(temp.path());
    let handle = ServerRuntime::start(
        ServerConfig::new(temp.path())
            .with_bind("127.0.0.1", 0)
            .with_unsafe_no_auth(),
    )
    .await
    .expect("server starts");
    let (mut first, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("first client");
    let (mut second, _) = connect_async(format!("ws://{}/ws", handle.local_addr()))
        .await
        .expect("second client");

    let ServerMessage::Exit {
        exit: RpcExit::Success { value: Some(idle) },
        ..
    } = call_unary(&mut first, "1", "updater.activeWork").await
    else {
        panic!("updater.activeWork must succeed");
    };
    assert_eq!(
        idle,
        json!({ "runningTurns": 0, "liveTerminals": 0, "queuedMessages": 0 })
    );

    let ServerMessage::Exit {
        exit: RpcExit::Success {
            value: Some(from_second),
        },
        ..
    } = call_unary(&mut second, "2", "updater.activeWork").await
    else {
        panic!("updater.activeWork must succeed for every client");
    };
    assert_eq!(from_second, idle);

    let command = if cfg!(windows) {
        json!({
            "executable": "powershell.exe",
            "args": ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"]
        })
    } else {
        json!({"executable": "/bin/sh", "args": ["-c", "sleep 60"]})
    };
    let opened = call_unary_with(
        &mut first,
        "2",
        "terminal.open",
        json!({
            "threadId": "active-work",
            "terminalId": "term-1",
            "cwd": temp.path(),
            "command": command
        }),
    )
    .await;
    assert!(matches!(
        opened,
        ServerMessage::Exit {
            exit: RpcExit::Success { .. },
            ..
        }
    ));

    let active = json!({ "runningTurns": 0, "liveTerminals": 1, "queuedMessages": 0 });
    let mut second_request_id = 3;
    assert_eq!(
        wait_for_active_work(&mut second, &mut second_request_id, &active).await,
        active
    );

    let closed = call_unary_with(
        &mut first,
        "3",
        "terminal.close",
        json!({"threadId": "active-work", "terminalId": "term-1"}),
    )
    .await;
    assert!(matches!(
        closed,
        ServerMessage::Exit {
            exit: RpcExit::Success { .. },
            ..
        }
    ));
    assert_eq!(
        wait_for_active_work(&mut second, &mut second_request_id, &idle).await,
        idle
    );

    first.close(None).await.expect("close first");
    second.close(None).await.expect("close second");
    handle.shutdown();
    handle.join().await.expect("server joins");
}
