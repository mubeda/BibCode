#[path = "support/hermetic_providers.rs"]
mod hermetic_providers;

use std::time::Duration;

use bibcode_server::{
    DESKTOP_MAINTENANCE_TOKEN_HEADER, DESKTOP_SHUTDOWN_PATH, MAINTENANCE_UPDATE_CANCEL_PATH,
    MAINTENANCE_UPDATE_PREPARE_PATH, MAINTENANCE_UPDATE_STATUS_PATH, ROUTE_INVENTORY,
    RpcAdmissionGate, RpcMutability, ServerConfig, ServerRuntime, http_mutability,
    persistence::{BackupTrigger, StatePaths, StorageInstanceId, inventory_verified_backups},
    rpc_mutability,
};
use futures_util::SinkExt;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[path = "support/websocket_frames.rs"]
mod websocket_frames;
use websocket_frames::next_frame_past_heartbeat;

fn desktop_config(root: &std::path::Path, token: &str) -> ServerConfig {
    ServerConfig::new(root)
        .with_bind("127.0.0.1", 0)
        .with_desktop(token)
        .expect("desktop config")
}

fn disable_provider_processes(root: &std::path::Path) {
    // Maintenance fixtures keep providers disabled as well as pinning their executables.
    let providers = hermetic_providers::BUILTIN_PROVIDER_DRIVERS
        .iter()
        .map(|driver| ((*driver).to_owned(), json!({"enabled": false})))
        .collect::<serde_json::Map<String, Value>>();
    hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root).state_dir(),
        json!({"providers": providers}),
    );
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
    let rejected = timeout(
        Duration::from_secs(2),
        next_frame_past_heartbeat(&mut socket),
    )
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
        let rejected = timeout(
            Duration::from_secs(2),
            next_frame_past_heartbeat(&mut socket),
        )
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
    let readable = timeout(
        Duration::from_secs(2),
        next_frame_past_heartbeat(&mut socket),
    )
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
    hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(web_root.path()).state_dir(),
        json!({}),
    );
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
    hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(exposed_root.path()).state_dir(),
        json!({}),
    );
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

/// Exchanges the desktop bootstrap token and opens an authenticated RPC socket.
async fn authenticated_socket(
    server: &bibcode_server::ServerHandle,
    bootstrap: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
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
    connect_async(format!("ws://{}/ws?wsTicket={ticket}", server.local_addr()))
        .await
        .expect("authenticated socket")
        .0
}

#[tokio::test]
async fn shutdown_stops_a_detached_clone_and_removes_its_folder() {
    use tokio::io::AsyncReadExt;

    let root = tempfile::tempdir().expect("data root");
    disable_provider_processes(root.path());
    let clones = tempfile::tempdir().expect("clone parent");
    let destination = clones.path().join("detached");
    // `git://` has no HTTP proxy, so a host proxy setting cannot divert Git away from this
    // listener. The listener accepts and never answers, so the clone runs until stopped.
    let remote = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stalled remote");
    let url = format!(
        "git://{}/stalled.git",
        remote.local_addr().expect("address")
    );
    let bootstrap = "clone-shutdown-bootstrap";
    let server = ServerRuntime::start(desktop_config(root.path(), bootstrap))
        .await
        .expect("desktop runtime");
    let mut socket = authenticated_socket(&server, bootstrap).await;

    socket
        .send(Message::Text(
            json!({
                "_tag": "Request", "id": "1", "tag": "vcs.clone", "headers": [],
                "payload": { "url": url, "parentDir": clones.path(), "directoryName": "detached", "detach": true }
            })
            .to_string()
            .into(),
        ))
        .await
        .expect("clone request");
    let (mut connection, _) = timeout(Duration::from_secs(30), remote.accept())
        .await
        .expect("Git connects")
        .expect("accept Git");
    assert!(destination.is_dir(), "the clone created its destination");
    // The client leaves; the detached clone keeps running until shutdown.
    let _ = socket.close(None).await;

    server.shutdown();
    timeout(Duration::from_secs(60), server.join())
        .await
        .expect("shutdown finishes")
        .expect("server joins");
    assert!(
        !destination.exists(),
        "shutdown removed the partial folder before finishing"
    );
    let mut buffer = [0_u8; 1024];
    let closed = timeout(Duration::from_secs(5), async {
        loop {
            match connection.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "Git was stopped");
}

#[tokio::test]
async fn a_wide_bound_desktop_runtime_protects_in_process_while_http_maintenance_stays_hidden() {
    let root = tempfile::tempdir().expect("wide data root");
    disable_provider_processes(root.path());
    let bootstrap = "wide-bootstrap";
    let server = ServerRuntime::start(
        ServerConfig::new(root.path())
            .with_bind("0.0.0.0", 0)
            .with_desktop(bootstrap)
            .expect("desktop config"),
    )
    .await
    .expect("wide desktop runtime");
    let base = format!("http://127.0.0.1:{}", server.local_addr().port());
    let client = reqwest::Client::new();

    // The loopback-or-WSL HTTP invariant is unchanged.
    let hidden = client
        .post(format!("{base}{MAINTENANCE_UPDATE_PREPARE_PATH}"))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .send()
        .await
        .expect("wide prepare response");
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);

    let maintenance = server
        .update_maintenance()
        .expect("a desktop runtime owns update maintenance whatever its bind");
    let prepared = timeout(Duration::from_secs(45), maintenance.prepare())
        .await
        .expect("in-process prepare stays within the 45 s bound")
        .expect("in-process prepare succeeds");
    assert_eq!(maintenance.status().await["phase"], "prepared");

    let paths = StatePaths::from_config(&desktop_config(root.path(), bootstrap));
    let inventory = inventory_verified_backups(&paths, prepared.storage_instance_id)
        .await
        .expect("verified backup inventory");
    assert_eq!(inventory.verified.len(), 1);
    assert_eq!(
        inventory.verified[0].manifest.trigger,
        BackupTrigger::PreUpdate
    );
    assert_eq!(
        inventory.verified[0].manifest.backup_id.to_string(),
        prepared.backup_id
    );

    let operation_id =
        uuid::Uuid::parse_str(&prepared.operation_id).expect("operation id is a UUID");
    maintenance
        .commit(operation_id)
        .await
        .expect("in-process commit succeeds");
    maintenance.shutdown_after_response();
    timeout(Duration::from_secs(2), server.wait_for_shutdown())
        .await
        .expect("commit exits the quiesced runtime");
    server.join().await.expect("wide runtime joins");
}

#[tokio::test]
async fn in_process_cancel_exits_and_a_mismatched_operation_changes_nothing() {
    let root = tempfile::tempdir().expect("cancel data root");
    disable_provider_processes(root.path());
    let server = ServerRuntime::start(
        ServerConfig::new(root.path())
            .with_bind("0.0.0.0", 0)
            .with_desktop("cancel-bootstrap")
            .expect("desktop config"),
    )
    .await
    .expect("wide desktop runtime");
    let maintenance = server.update_maintenance().expect("maintenance owner");
    let prepared = maintenance.prepare().await.expect("prepare");

    let mismatch = maintenance
        .cancel(uuid::Uuid::nil())
        .await
        .expect_err("a foreign operation id is refused");
    assert!(
        matches!(
            mismatch,
            bibcode_server::MaintenanceError::OperationMismatch
        ),
        "{mismatch:?}"
    );
    let status = maintenance.status().await;
    assert_eq!(status["phase"], "prepared");
    assert_eq!(
        status["result"]["operationId"],
        prepared.operation_id.as_str()
    );
    assert!(
        timeout(Duration::from_millis(50), server.wait_for_shutdown())
            .await
            .is_err(),
        "a mismatched operation must not alter maintenance state"
    );

    maintenance
        .cancel(uuid::Uuid::parse_str(&prepared.operation_id).expect("uuid"))
        .await
        .expect("cancel succeeds");
    maintenance.shutdown_after_response();
    timeout(Duration::from_secs(2), server.wait_for_shutdown())
        .await
        .expect("cancel exits instead of resuming");
    server.join().await.expect("join");
}

#[tokio::test]
async fn only_desktop_runtimes_with_a_bootstrap_token_own_update_maintenance() {
    let web_root = tempfile::tempdir().expect("web data root");
    disable_provider_processes(web_root.path());
    let web = ServerRuntime::start(ServerConfig::new(web_root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("web runtime");
    assert!(web.update_maintenance().is_none());
    web.shutdown();
    web.join().await.expect("web join");

    let desktop_root = tempfile::tempdir().expect("desktop data root");
    disable_provider_processes(desktop_root.path());
    let desktop = ServerRuntime::start(desktop_config(desktop_root.path(), "loopback-bootstrap"))
        .await
        .expect("loopback desktop runtime");
    assert!(desktop.update_maintenance().is_some());
    desktop.shutdown();
    desktop.join().await.expect("desktop join");
}

#[tokio::test]
async fn a_loopback_desktop_runtime_shares_one_maintenance_owner_between_http_and_in_process() {
    let root = tempfile::tempdir().expect("shared owner data root");
    disable_provider_processes(root.path());
    let bootstrap = "shared-owner-bootstrap";
    let server = ServerRuntime::start(desktop_config(root.path(), bootstrap))
        .await
        .expect("loopback desktop runtime");
    let base = format!("http://{}", server.local_addr());
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{base}{MAINTENANCE_UPDATE_PREPARE_PATH}"))
        .header(DESKTOP_MAINTENANCE_TOKEN_HEADER, bootstrap)
        .send()
        .await
        .expect("HTTP prepare response");
    assert_eq!(response.status(), StatusCode::OK);
    let response = response.json::<Value>().await.expect("HTTP prepare JSON");
    let operation_id = response["operationId"].as_str().expect("HTTP operation id");

    let maintenance = server
        .update_maintenance()
        .expect("loopback desktop runtime owns update maintenance");
    let status = maintenance.status().await;
    assert_eq!(status["phase"], "prepared");
    assert_eq!(status["result"]["operationId"], operation_id);
    let prepared = timeout(Duration::from_secs(45), maintenance.prepare())
        .await
        .expect("in-process prepare stays within the 45 s bound")
        .expect("in-process prepare succeeds");
    assert_eq!(prepared.operation_id, operation_id);

    maintenance
        .cancel(uuid::Uuid::parse_str(operation_id).expect("operation id is a UUID"))
        .await
        .expect("in-process cancel succeeds");
    maintenance.shutdown_after_response();
    timeout(Duration::from_secs(2), server.wait_for_shutdown())
        .await
        .expect("cancel exits the quiesced runtime");
    server.join().await.expect("loopback runtime joins");
}
