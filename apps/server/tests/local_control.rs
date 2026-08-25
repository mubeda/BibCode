use std::time::Duration;

use bibcode_server::{
    RpcRegistry, ServerConfig, ServerError, ServerRuntime,
    local_control::protocol::{
        CONTROL_PROTOCOL_VERSION, ControlRequest, ControlRequestBody, ControlResponse,
        ControlResponseBody, MAX_CONTROL_FRAME_BYTES, read_request, read_response, write_request,
    },
    persistence::EnvironmentId,
};
use serde_json::json;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

fn test_config(root: &TempDir) -> ServerConfig {
    ServerConfig::new(root.path()).with_bind("127.0.0.1", 0)
}

fn request(body: ControlRequestBody) -> ControlRequest {
    ControlRequest {
        version: CONTROL_PROTOCOL_VERSION,
        request_id: Uuid::new_v4(),
        body,
    }
}

#[cfg(unix)]
async fn connect(root: &TempDir) -> tokio::net::UnixStream {
    tokio::net::UnixStream::connect(
        root.path()
            .join("userdata")
            .join("run")
            .join("control.sock"),
    )
    .await
    .expect("connect to local control socket")
}

async fn start(root: &TempDir) -> bibcode_server::ServerHandle {
    ServerRuntime::start_with_registry(test_config(root), RpcRegistry::empty())
        .await
        .expect("start server with local control")
}

#[cfg(windows)]
async fn connect(root: &TempDir) -> tokio::net::windows::named_pipe::NamedPipeClient {
    use bibcode_server::{local_control::windows::pipe_name, persistence::EnvironmentId};
    use tokio::net::windows::named_pipe::ClientOptions;

    let marker = tokio::fs::read_to_string(root.path().join("userdata").join("environment-id"))
        .await
        .expect("read environment identity marker");
    let environment_id = EnvironmentId::from_uuid(
        Uuid::parse_str(marker.trim()).expect("environment identity marker UUID"),
    );
    let name = pipe_name(environment_id);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        match ClientOptions::new().open(&name) {
            Ok(client) => return client,
            Err(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => panic!("connect to local control pipe {name}: {error}"),
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn same_user_can_read_status_without_network_authentication() {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};

    let root = tempfile::tempdir().expect("temporary data root");
    let handle = start(&root).await;
    let socket = root
        .path()
        .join("userdata")
        .join("run")
        .join("control.sock");
    let metadata = std::fs::symlink_metadata(&socket).expect("control socket metadata");
    assert!(metadata.file_type().is_socket());
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    assert_eq!(
        std::fs::metadata(socket.parent().expect("socket parent"))
            .expect("control directory metadata")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );

    let mut stream = connect(&root).await;
    let sent = request(ControlRequestBody::Status);
    write_request(&mut stream, &sent)
        .await
        .expect("write status request");
    let response = read_response(&mut stream)
        .await
        .expect("read status response");
    assert_eq!(response.version, CONTROL_PROTOCOL_VERSION);
    assert_eq!(response.request_id, sent.request_id);
    assert!(matches!(response.body, ControlResponseBody::Status { .. }));
    let mut trailing = [0_u8; 1];
    assert_eq!(
        stream
            .read(&mut trailing)
            .await
            .expect("server closes after response"),
        0
    );

    handle.shutdown();
    handle.join().await.expect("join server");
    assert!(!socket.exists(), "the owning process removes its socket");
}

#[cfg(windows)]
#[tokio::test]
async fn same_service_user_can_read_status_over_the_environment_named_pipe() {
    let root = tempfile::tempdir().expect("temporary data root");
    let handle = start(&root).await;
    let mut stream = connect(&root).await;
    let sent = request(ControlRequestBody::Status);
    write_request(&mut stream, &sent)
        .await
        .expect("write status request");
    let response = read_response(&mut stream)
        .await
        .expect("read status response");
    assert_eq!(response.request_id, sent.request_id);
    assert!(matches!(response.body, ControlResponseBody::Status { .. }));

    handle.shutdown();
    handle.join().await.expect("join server");
}

#[cfg(unix)]
#[test]
fn unix_peer_policy_rejects_other_users_and_limits_root_override() {
    use bibcode_server::local_control::unix::peer_is_authorized;

    assert!(peer_is_authorized(501, 501, false));
    assert!(!peer_is_authorized(501, 502, false));
    assert!(!peer_is_authorized(501, 0, false));
    assert!(peer_is_authorized(501, 0, true));
}

#[cfg(unix)]
#[tokio::test]
async fn world_readable_control_parent_is_rejected_without_silent_repair() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().expect("temporary data root");
    let run = root.path().join("userdata").join("run");
    std::fs::create_dir_all(&run).expect("create insecure run directory");
    std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o755))
        .expect("make run directory world-readable");

    let error =
        match ServerRuntime::start_with_registry(test_config(&root), RpcRegistry::empty()).await {
            Ok(_) => panic!("insecure control parent must fail startup"),
            Err(error) => error,
        };
    assert!(matches!(error, ServerError::LocalControlInitialize(_)));
    assert_eq!(
        std::fs::metadata(&run)
            .expect("run directory remains")
            .permissions()
            .mode()
            & 0o777,
        0o755,
        "startup must not conceal an insecure pre-existing directory"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn stale_owned_socket_is_replaced_but_live_socket_is_not() {
    let stale_root = tempfile::tempdir().expect("stale data root");
    let stale_run = stale_root.path().join("userdata").join("run");
    std::fs::create_dir_all(&stale_run).expect("create stale run directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stale_run, std::fs::Permissions::from_mode(0o700))
            .expect("secure stale run directory");
    }
    let stale_path = stale_run.join("control.sock");
    let stale_listener =
        std::os::unix::net::UnixListener::bind(&stale_path).expect("bind stale socket fixture");
    drop(stale_listener);

    let stale_handle = start(&stale_root).await;
    let mut stream = connect(&stale_root).await;
    let sent = request(ControlRequestBody::Status);
    write_request(&mut stream, &sent)
        .await
        .expect("write request");
    assert!(read_response(&mut stream).await.is_ok());
    stale_handle.shutdown();
    stale_handle.join().await.expect("join stale replacement");

    let live_root = tempfile::tempdir().expect("live data root");
    let live_run = live_root.path().join("userdata").join("run");
    std::fs::create_dir_all(&live_run).expect("create live run directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&live_run, std::fs::Permissions::from_mode(0o700))
            .expect("secure live run directory");
    }
    let live_path = live_run.join("control.sock");
    let _live_listener =
        std::os::unix::net::UnixListener::bind(&live_path).expect("bind live socket fixture");
    let error =
        match ServerRuntime::start_with_registry(test_config(&live_root), RpcRegistry::empty())
            .await
        {
            Ok(_) => panic!("a live endpoint must not be replaced"),
            Err(error) => error,
        };
    assert!(matches!(error, ServerError::LocalControlInitialize(_)));
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_never_unlinks_a_replacement_socket_at_the_owned_path() {
    let root = tempfile::tempdir().expect("temporary data root");
    let handle = start(&root).await;
    let socket = root
        .path()
        .join("userdata")
        .join("run")
        .join("control.sock");
    let displaced = socket.with_file_name("displaced-control.sock");
    std::fs::rename(&socket, &displaced).expect("displace the owned socket path");
    let replacement =
        std::os::unix::net::UnixListener::bind(&socket).expect("bind a foreign replacement socket");

    handle.shutdown();
    handle.join().await.expect("join server");
    assert!(
        socket.exists(),
        "identity mismatch must preserve the replacement"
    );
    drop(replacement);
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn oversize_partial_unknown_and_unsupported_frames_fail_safely() {
    let root = tempfile::tempdir().expect("temporary data root");
    let handle = start(&root).await;

    let mut oversized = connect(&root).await;
    oversized
        .write_u32(u32::try_from(MAX_CONTROL_FRAME_BYTES + 1).expect("bounded test size"))
        .await
        .expect("write oversized length");
    let oversized_response = read_response(&mut oversized)
        .await
        .expect("oversized frame response");
    assert!(matches!(
        oversized_response.body,
        ControlResponseBody::Error { ref code, .. } if code == "frame_too_large"
    ));

    let mut partial = connect(&root).await;
    partial.write_u32(128).await.expect("write partial length");
    partial.write_all(b"{").await.expect("write partial body");
    partial.shutdown().await.expect("close request write half");
    let partial_response = read_response(&mut partial)
        .await
        .expect("partial frame response");
    assert!(matches!(
        partial_response.body,
        ControlResponseBody::Error { ref code, .. } if code == "incomplete_frame"
    ));

    let unsupported_id = Uuid::new_v4();
    let unsupported = json!({
        "version": CONTROL_PROTOCOL_VERSION + 1,
        "requestId": unsupported_id.to_string(),
        "body": { "type": "status" }
    });
    let unsupported_response = send_raw_json(&root, unsupported).await;
    assert_eq!(unsupported_response.request_id, unsupported_id);
    assert!(matches!(
        unsupported_response.body,
        ControlResponseBody::Error { ref code, .. } if code == "unsupported_protocol"
    ));

    let unknown_id = Uuid::new_v4();
    let unknown = json!({
        "version": CONTROL_PROTOCOL_VERSION,
        "requestId": unknown_id.to_string(),
        "body": { "type": "runShell", "command": "never" }
    });
    let unknown_response = send_raw_json(&root, unknown).await;
    assert_eq!(unknown_response.request_id, unknown_id);
    assert!(matches!(
        unknown_response.body,
        ControlResponseBody::Error { ref code, .. } if code == "unknown_command"
    ));

    handle.shutdown();
    handle.join().await.expect("join server");
}

#[cfg(any(unix, windows))]
async fn send_raw_json(root: &TempDir, value: serde_json::Value) -> ControlResponse {
    let bytes = serde_json::to_vec(&value).expect("encode raw control request");
    let mut stream = connect(root).await;
    stream
        .write_u32(u32::try_from(bytes.len()).expect("bounded raw request"))
        .await
        .expect("write raw frame length");
    stream.write_all(&bytes).await.expect("write raw frame");
    read_response(&mut stream)
        .await
        .expect("read raw request response")
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_closes_partial_clients_drains_dispatch_and_unlinks_owned_endpoint() {
    let root = tempfile::tempdir().expect("temporary data root");
    let handle = start(&root).await;
    let socket = root
        .path()
        .join("userdata")
        .join("run")
        .join("control.sock");
    let mut partial = connect(&root).await;
    partial.write_u32(64).await.expect("write partial request");

    handle.shutdown();
    tokio::time::timeout(Duration::from_secs(2), handle.join())
        .await
        .expect("local control shutdown must be bounded")
        .expect("join server");
    assert!(!socket.exists());
    let mut trailing = [0_u8; 1];
    assert_eq!(
        partial
            .read(&mut trailing)
            .await
            .expect("partial client observes close"),
        0
    );
}

#[tokio::test(start_paused = true)]
async fn incomplete_frame_read_has_a_bounded_deadline() {
    let (mut client, mut server) = tokio::io::duplex(128);
    client
        .write_u32(64)
        .await
        .expect("write declared frame length");
    let pending = tokio::spawn(async move { read_request(&mut server).await });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(6)).await;

    let error = pending
        .await
        .expect("protocol read task")
        .expect_err("partial frame must time out");
    assert_eq!(error.code(), "timeout");
    assert!(!error.to_string().contains('{'));
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn administrative_inventory_is_closed_and_stop_replies_before_shutdown() {
    let root = tempfile::tempdir().expect("temporary data root");
    let handle = start(&root).await;

    for body in [
        ControlRequestBody::CreatePairing {
            client_label: Some("Administrator laptop".to_owned()),
        },
        ControlRequestBody::ServicePrepareUpdate,
    ] {
        let mut stream = connect(&root).await;
        let sent = request(body);
        write_request(&mut stream, &sent)
            .await
            .expect("write known administrative request");
        let response = read_response(&mut stream)
            .await
            .expect("read known administrative response");
        assert_eq!(response.request_id, sent.request_id);
        assert!(matches!(
            response.body,
            ControlResponseBody::Error { ref code, .. } if code == "command_unavailable"
        ));
    }

    let mut stream = connect(&root).await;
    let sent = request(ControlRequestBody::ServiceStop);
    write_request(&mut stream, &sent)
        .await
        .expect("write service stop request");
    let response = read_response(&mut stream)
        .await
        .expect("stop acknowledgement precedes shutdown");
    assert_eq!(response.request_id, sent.request_id);
    assert!(matches!(response.body, ControlResponseBody::StopAccepted));
    tokio::time::timeout(Duration::from_secs(2), handle.wait_for_shutdown())
        .await
        .expect("service stop cancels the server");
    handle.join().await.expect("join stopped server");
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn desktop_local_control_prepares_update_through_the_existing_maintenance_owner() {
    let root = tempfile::tempdir().expect("temporary data root");
    let config = test_config(&root)
        .with_desktop("desktop-maintenance-test-token")
        .expect("desktop server configuration")
        .with_update_maintenance_timing_for_integration_test(
            Duration::from_secs(2),
            Duration::from_secs(2),
        );
    let handle = ServerRuntime::start(config)
        .await
        .expect("start desktop server with local control");
    let mut stream = connect(&root).await;
    let sent = request(ControlRequestBody::ServicePrepareUpdate);
    write_request(&mut stream, &sent)
        .await
        .expect("write update preparation request");
    let response = read_response(&mut stream)
        .await
        .expect("read update preparation response");
    assert_eq!(response.request_id, sent.request_id);
    assert!(matches!(
        response.body,
        ControlResponseBody::UpdatePrepared {
            ref operation_id,
            ref backup_id,
            ..
        } if !operation_id.is_empty() && !backup_id.is_empty()
    ));

    handle.shutdown();
    handle.join().await.expect("join prepared desktop server");
}

#[test]
fn secret_bearing_responses_are_redacted_from_debug_output() {
    let secret = "pair_very-secret-credential";
    let response = ControlResponse {
        version: CONTROL_PROTOCOL_VERSION,
        request_id: Uuid::new_v4(),
        body: ControlResponseBody::PairingCreated {
            environment_id: EnvironmentId::from_uuid(Uuid::new_v4()),
            credential: secret.to_owned(),
            expires_at: "2030-01-01T00:00:00Z".to_owned(),
            pairing_url: format!("https://example.test/pair#token={secret}"),
        },
    };

    let debug = format!("{response:?}");
    assert!(!debug.contains(secret));
    assert!(debug.contains("[redacted]"));
}

#[cfg(windows)]
#[test]
fn windows_policy_rejects_remote_and_unprivileged_clients() {
    use bibcode_server::local_control::windows::client_is_authorized;

    assert!(client_is_authorized(true, false, false));
    assert!(client_is_authorized(false, true, false));
    assert!(!client_is_authorized(false, false, false));
    assert!(!client_is_authorized(true, true, true));
}

#[cfg(windows)]
#[tokio::test]
async fn windows_named_pipe_rejects_a_remote_namespace_client() {
    use bibcode_server::{local_control::windows::pipe_name, persistence::EnvironmentId};
    use tokio::net::windows::named_pipe::ClientOptions;

    let root = tempfile::tempdir().expect("temporary data root");
    let handle = start(&root).await;
    let marker = tokio::fs::read_to_string(root.path().join("userdata").join("environment-id"))
        .await
        .expect("read environment identity marker");
    let environment_id = EnvironmentId::from_uuid(
        Uuid::parse_str(marker.trim()).expect("environment identity marker UUID"),
    );
    let local_name = pipe_name(environment_id);
    let remote_name = local_name.replacen(r"\\.\pipe\", r"\\localhost\pipe\", 1);
    assert!(
        ClientOptions::new().open(remote_name).is_err(),
        "PIPE_REJECT_REMOTE_CLIENTS must reject even the local host's remote namespace"
    );

    handle.shutdown();
    handle.join().await.expect("join server");
}
