use std::time::Duration;

use bibcode_server::{
    DESKTOP_MAINTENANCE_TOKEN_HEADER, DESKTOP_SHUTDOWN_PATH, MAINTENANCE_UPDATE_CANCEL_PATH,
    MAINTENANCE_UPDATE_PREPARE_PATH, MAINTENANCE_UPDATE_STATUS_PATH, ROUTE_INVENTORY,
    RpcAdmissionGate, RpcMutability, ServerConfig, ServerRuntime, http_mutability,
    persistence::{BackupTrigger, StatePaths, StorageInstanceId, inventory_verified_backups},
    rpc_mutability,
};
use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn desktop_config(root: &std::path::Path, token: &str) -> ServerConfig {
    ServerConfig::new(root)
        .with_bind("127.0.0.1", 0)
        .with_desktop(token)
        .expect("desktop config")
}

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

#[tokio::test]
async fn admission_gate_drains_existing_mutations_and_rejects_new_ones() {
    let gate = RpcAdmissionGate::new();
    let permit = gate
        .admit(RpcMutability::Mutation)
        .expect("open gate admits mutation");

    let closing_gate = gate.clone();
    let drain = tokio::spawn(async move {
        closing_gate
            .close_and_drain(Instant::now() + Duration::from_secs(1))
            .await
    });
    tokio::task::yield_now().await;

    assert!(gate.admit(RpcMutability::Read).is_ok());
    assert!(gate.admit(RpcMutability::Mutation).is_err());
    assert!(
        !drain.is_finished(),
        "the admitted mutation still owns its permit"
    );

    let retained_by_protected_task = permit.clone();
    drop(permit);
    tokio::task::yield_now().await;
    assert!(
        !drain.is_finished(),
        "a protected task's cloned permit must keep maintenance draining"
    );
    drop(retained_by_protected_task);
    assert_eq!(drain.await.expect("drain task").expect("drained"), 1);
}

#[tokio::test]
async fn admission_timeout_reports_named_blockers_without_request_payloads() {
    let gate = RpcAdmissionGate::new();
    let untrusted_operation = format!("server.updateSettings\n{}", "x".repeat(256));
    let permit = gate
        .admit_named(RpcMutability::Mutation, untrusted_operation)
        .expect("open gate admits named mutation");

    let snapshot = gate.snapshot();
    assert_eq!(snapshot.in_flight, 1);
    assert_eq!(snapshot.blockers.len(), 1);
    assert!(
        snapshot.blockers[0]
            .operation
            .starts_with("server.updateSettings ")
    );
    assert!(!snapshot.blockers[0].operation.contains('\n'));
    assert!(snapshot.blockers[0].operation.chars().count() <= 160);

    let error = gate
        .close_and_drain(Instant::now() + Duration::from_millis(10))
        .await
        .expect_err("retained named permit must time out");
    assert!(error.to_string().contains("server.updateSettings "));

    drop(permit);
    assert_eq!(gate.snapshot().in_flight, 0);
}

#[test]
fn every_public_mutation_boundary_is_classified_centrally() {
    assert_eq!(rpc_mutability("server.getConfig"), RpcMutability::Read);
    assert_eq!(
        rpc_mutability("server.updateSettings"),
        RpcMutability::Mutation
    );
    assert_eq!(
        rpc_mutability("orchestration.dispatchCommand"),
        RpcMutability::Mutation
    );
    assert_eq!(
        rpc_mutability("projects.writeFile"),
        RpcMutability::Mutation
    );
    assert_eq!(rpc_mutability("terminal.write"), RpcMutability::Mutation);
    assert_eq!(
        rpc_mutability("activity.cancelSubtree"),
        RpcMutability::Mutation
    );
    assert_eq!(
        rpc_mutability("activity.retrySubtreeCancellation"),
        RpcMutability::Mutation
    );
    assert_eq!(
        rpc_mutability("orchestration.subscribeShell"),
        RpcMutability::Read
    );
    assert_eq!(
        rpc_mutability("subscribeVcsStatusSummary"),
        RpcMutability::Read
    );
    assert_eq!(
        rpc_mutability("subscribeWorktreeCatalog"),
        RpcMutability::Read,
        "a passive worktree catalog subscription must not hold update protection open"
    );

    assert_eq!(
        http_mutability("GET", "/api/orchestration/snapshot"),
        RpcMutability::Read
    );
    assert_eq!(
        http_mutability("POST", "/api/orchestration/dispatch"),
        RpcMutability::Mutation
    );
    assert_eq!(
        http_mutability("POST", "/api/auth/clients/revoke"),
        RpcMutability::Mutation
    );
    assert_eq!(http_mutability("DELETE", "/mcp"), RpcMutability::Mutation);
    assert_eq!(
        http_mutability("POST", MAINTENANCE_UPDATE_PREPARE_PATH),
        RpcMutability::Read
    );
}

#[test]
fn registered_http_route_inventory_has_no_unclassified_mutation_gap() {
    for route in ROUTE_INVENTORY {
        let classified = http_mutability(route.method, route.path);
        let control_exemption = matches!(
            route.path,
            MAINTENANCE_UPDATE_PREPARE_PATH
                | bibcode_server::MAINTENANCE_UPDATE_COMMIT_PATH
                | MAINTENANCE_UPDATE_CANCEL_PATH
                | DESKTOP_SHUTDOWN_PATH
        );
        match route.method {
            "GET" => assert_eq!(classified, RpcMutability::Read, "GET {}", route.path),
            "POST" | "DELETE" if control_exemption => {
                assert_eq!(classified, RpcMutability::Read, "control {}", route.path)
            }
            "POST" | "DELETE" => {
                assert_eq!(
                    classified,
                    RpcMutability::Mutation,
                    "mutation {}",
                    route.path
                )
            }
            method => panic!("route inventory introduced an unaudited method {method}"),
        }
    }
}

#[tokio::test]
async fn desktop_prepare_is_authenticated_single_flight_and_cancel_is_identity_bound() {
    let root = tempfile::tempdir().expect("data root");
    disable_provider_processes(root.path());
    let bootstrap = "maintenance-bootstrap";
    let server = ServerRuntime::start(desktop_config(root.path(), bootstrap))
        .await
        .expect("desktop runtime");
    let base = format!("http://{}", server.local_addr());
    let client = reqwest::Client::new();

    let token = client
        .post(format!("{base}/oauth/token"))
        .form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", bootstrap),
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
        .expect("bootstrap exchange")
        .json::<Value>()
        .await
        .expect("bootstrap exchange JSON")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    let ticket = client
        .post(format!("{base}/api/auth/websocket-ticket"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("ticket response")
        .json::<Value>()
        .await
        .expect("ticket JSON")["ticket"]
        .as_str()
        .expect("ticket")
        .to_owned();
    let (mut socket, _) =
        connect_async(format!("ws://{}/ws?wsTicket={ticket}", server.local_addr()))
            .await
            .expect("authenticated socket");

    let unauthenticated = client
        .post(format!("{base}{MAINTENANCE_UPDATE_PREPARE_PATH}"))
        .send()
        .await
        .expect("unauthenticated response");
    assert_eq!(unauthenticated.status(), StatusCode::FORBIDDEN);

    let first = client
        .post(format!("{base}{MAINTENANCE_UPDATE_PREPARE_PATH}"))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .send()
        .await
        .expect("prepare response");
    assert_eq!(first.status(), StatusCode::OK);
    let first = first.json::<Value>().await.expect("prepare JSON");
    assert_eq!(first["storageInstanceId"].as_str().map(str::len), Some(36));
    assert_eq!(first["backupId"].as_str().map(str::len), Some(36));

    let repeated = client
        .post(format!("{base}{MAINTENANCE_UPDATE_PREPARE_PATH}"))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .send()
        .await
        .expect("repeated prepare response")
        .json::<Value>()
        .await
        .expect("repeated prepare JSON");
    assert_eq!(repeated, first, "prepare is single-flight and idempotent");

    socket
        .send(Message::Text(
            json!({
                "_tag":"Request","id":"1","tag":"server.updateSettings",
                "payload":{},"headers":[]
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("mutating RPC request");
    let rejected = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("mutating response timeout")
        .expect("socket remains open")
        .expect("mutating response frame");
    let rejected: Value =
        serde_json::from_str(rejected.to_text().expect("response text")).expect("response JSON");
    assert_eq!(rejected["exit"]["_tag"], "Failure");
    assert_eq!(
        rejected.pointer("/exit/cause/0/error/_tag"),
        Some(&json!("UpdateMaintenanceActiveError"))
    );

    for (id, tag) in [
        ("11", "activity.cancelSubtree"),
        ("12", "activity.retrySubtreeCancellation"),
    ] {
        socket
            .send(Message::Text(
                json!({
                    "_tag": "Request",
                    "id": id,
                    "tag": tag,
                    "payload": {},
                    "headers": []
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("activity mutation RPC request");
        let rejected = timeout(Duration::from_secs(2), socket.next())
            .await
            .expect("activity mutation response timeout")
            .expect("socket remains open")
            .expect("activity mutation response frame");
        let rejected: Value =
            serde_json::from_str(rejected.to_text().expect("activity mutation response text"))
                .expect("activity mutation response JSON");
        assert_eq!(rejected["requestId"], id);
        assert_eq!(
            rejected.pointer("/exit/cause/0/error/_tag"),
            Some(&json!("UpdateMaintenanceActiveError")),
            "maintenance admitted {tag}"
        );
    }

    socket
        .send(Message::Text(
            json!({
                "_tag":"Request","id":"2","tag":"server.getConfig",
                "payload":{},"headers":[]
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("read RPC request");
    let readable = timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("read response timeout")
        .expect("socket remains open")
        .expect("read response frame");
    let readable: Value =
        serde_json::from_str(readable.to_text().expect("response text")).expect("response JSON");
    assert_eq!(readable["exit"]["_tag"], "Success");

    let status = client
        .get(format!("{base}{MAINTENANCE_UPDATE_STATUS_PATH}"))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .send()
        .await
        .expect("status response")
        .json::<Value>()
        .await
        .expect("status JSON");
    assert_eq!(status["phase"], "prepared");
    assert_eq!(status["result"], first);

    let storage_instance_id: StorageInstanceId =
        serde_json::from_value(first["storageInstanceId"].clone()).expect("storage UUID");
    let paths = StatePaths::from_config(&desktop_config(root.path(), bootstrap));
    let inventory = inventory_verified_backups(&paths, storage_instance_id)
        .await
        .expect("verified backup inventory");
    assert_eq!(inventory.verified.len(), 1);
    assert_eq!(
        inventory.verified[0].manifest.trigger,
        BackupTrigger::PreUpdate
    );
    assert_eq!(
        inventory.verified[0].manifest.backup_id.to_string(),
        first["backupId"]
    );
    let wal = paths.database.with_extension("sqlite-wal");
    assert!(
        !wal.exists() || std::fs::metadata(&wal).expect("WAL metadata").len() == 0,
        "committed WAL is truncated before backup publication"
    );

    let mismatch = client
        .post(format!("{base}{MAINTENANCE_UPDATE_CANCEL_PATH}"))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .json(&json!({"operationId":"00000000-0000-4000-8000-000000000000"}))
        .send()
        .await
        .expect("mismatched cancel response");
    assert_eq!(mismatch.status(), StatusCode::CONFLICT);
    assert!(
        timeout(Duration::from_millis(50), server.wait_for_shutdown())
            .await
            .is_err(),
        "a mismatched operation must not alter maintenance state"
    );

    let cancelled = client
        .post(format!("{base}{MAINTENANCE_UPDATE_CANCEL_PATH}"))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .json(&json!({"operationId":first["operationId"]}))
        .send()
        .await
        .expect("cancel response");
    assert_eq!(cancelled.status(), StatusCode::OK);
    assert_eq!(
        cancelled.json::<Value>().await.expect("cancel JSON")["cancelled"],
        true
    );
    timeout(Duration::from_secs(2), server.wait_for_shutdown())
        .await
        .expect("cancel shuts quiesced backend down");
    server.join().await.expect("server join");
}

#[tokio::test]
async fn maintenance_routes_are_hidden_outside_local_desktop_mode() {
    let web_root = tempfile::tempdir().expect("web data root");
    let web = ServerRuntime::start(ServerConfig::new(web_root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("web runtime");
    let web_response = reqwest::Client::new()
        .post(format!(
            "http://{}{}",
            web.local_addr(),
            MAINTENANCE_UPDATE_PREPARE_PATH
        ))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, "irrelevant")
        .send()
        .await
        .expect("web response");
    assert_eq!(web_response.status(), StatusCode::NOT_FOUND);
    web.shutdown();
    web.join().await.expect("web join");

    let exposed_root = tempfile::tempdir().expect("exposed data root");
    let exposed = ServerRuntime::start(
        ServerConfig::new(exposed_root.path())
            .with_bind("0.0.0.0", 0)
            .with_desktop("exposed-bootstrap")
            .expect("desktop config"),
    )
    .await
    .expect("exposed runtime");
    let exposed_response = reqwest::Client::new()
        .post(format!(
            "http://127.0.0.1:{}{}",
            exposed.local_addr().port(),
            MAINTENANCE_UPDATE_PREPARE_PATH
        ))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, "exposed-bootstrap")
        .send()
        .await
        .expect("exposed response");
    assert_eq!(exposed_response.status(), StatusCode::NOT_FOUND);
    exposed.shutdown();
    exposed.join().await.expect("exposed join");

    let wsl_root = tempfile::tempdir().expect("WSL data root");
    disable_provider_processes(wsl_root.path());
    let mut wsl_config = ServerConfig::new(wsl_root.path())
        .with_bind("0.0.0.0", 0)
        .with_desktop("wsl-bootstrap")
        .expect("WSL desktop config");
    wsl_config.desktop_wsl_transport = true;
    let wsl = ServerRuntime::start(wsl_config).await.expect("WSL runtime");
    let wsl_response = reqwest::Client::new()
        .post(format!(
            "http://127.0.0.1:{}{}",
            wsl.local_addr().port(),
            MAINTENANCE_UPDATE_PREPARE_PATH
        ))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, "wsl-bootstrap")
        .send()
        .await
        .expect("WSL response");
    assert_eq!(wsl_response.status(), StatusCode::OK);
    wsl.shutdown();
    wsl.join().await.expect("WSL join");
}

#[tokio::test]
async fn commit_response_is_delivered_before_clean_backend_exit() {
    let root = tempfile::tempdir().expect("data root");
    disable_provider_processes(root.path());
    let bootstrap = "commit-bootstrap";
    let server = ServerRuntime::start(desktop_config(root.path(), bootstrap))
        .await
        .expect("desktop runtime");
    let base = format!("http://{}", server.local_addr());
    let client = reqwest::Client::new();
    let prepared = client
        .post(format!("{base}{MAINTENANCE_UPDATE_PREPARE_PATH}"))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .send()
        .await
        .expect("prepare response")
        .json::<Value>()
        .await
        .expect("prepare JSON");

    let committed = client
        .post(format!(
            "{base}{}",
            bibcode_server::MAINTENANCE_UPDATE_COMMIT_PATH
        ))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .json(&json!({"operationId":prepared["operationId"]}))
        .send()
        .await
        .expect("commit response");
    assert_eq!(committed.status(), StatusCode::OK);
    assert_eq!(
        committed.json::<Value>().await.expect("commit JSON")["committed"],
        true
    );
    timeout(Duration::from_secs(2), server.wait_for_shutdown())
        .await
        .expect("commit shuts down after its response");
    server.join().await.expect("server joins cleanly");
}

#[tokio::test]
async fn preparation_failure_exits_instead_of_leaving_a_quiesced_backend() {
    let root = tempfile::tempdir().expect("data root");
    disable_provider_processes(root.path());
    let bootstrap = "failure-bootstrap";
    let server = ServerRuntime::start(desktop_config(root.path(), bootstrap))
        .await
        .expect("desktop runtime");
    std::fs::write(root.path().join("backups"), b"blocks backup directory")
        .expect("backup failure fixture");

    let response = reqwest::Client::new()
        .post(format!(
            "http://{}{}",
            server.local_addr(),
            MAINTENANCE_UPDATE_PREPARE_PATH
        ))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .send()
        .await
        .expect("prepare failure response");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    timeout(Duration::from_secs(2), server.wait_for_shutdown())
        .await
        .expect("failed preparation shuts down quiesced backend");
    server.join().await.expect("failed server joins cleanly");
}

#[tokio::test]
async fn abandoned_preparation_lease_expires_and_exits() {
    let root = tempfile::tempdir().expect("data root");
    disable_provider_processes(root.path());
    let bootstrap = "lease-bootstrap";
    let server = ServerRuntime::start(
        desktop_config(root.path(), bootstrap).with_update_maintenance_timing_for_integration_test(
            Duration::from_secs(30),
            Duration::from_millis(50),
        ),
    )
    .await
    .expect("desktop runtime");
    let response = reqwest::Client::new()
        .post(format!(
            "http://{}{}",
            server.local_addr(),
            MAINTENANCE_UPDATE_PREPARE_PATH
        ))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .send()
        .await
        .expect("prepare response");
    assert_eq!(response.status(), StatusCode::OK);

    timeout(Duration::from_secs(2), server.wait_for_shutdown())
        .await
        .expect("lease expiry shuts the quiesced backend down");
    server.join().await.expect("expired server joins cleanly");
}
