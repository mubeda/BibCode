use std::{
    process::{Command, Stdio},
    time::Duration,
};

use bibcode_server::{
    AuthCommand, Cli, CliAction, PairingOutputFormat, ServerConfig, ServerRuntime,
    ServiceCliCommand, ServiceOperation, ServiceOutputFormat, TransportCommand,
    local_control::protocol::{
        CONTROL_PROTOCOL_VERSION, ControlResponse, ControlResponseBody, read_request,
        write_response,
    },
    persistence::{
        BackupTrigger, EnvironmentId, StatePaths, create_verified_backup, prepare_store,
    },
    resolve_data_root,
    service::ServiceMode,
};
use clap::Parser;
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command as TokioCommand,
    time::timeout,
};

#[test]
fn headless_binary_exposes_the_compatible_serve_flags() {
    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["serve", "--help"])
        .output()
        .expect("run bibcode serve --help");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("UTF-8 help output");
    for expected in [
        "--host",
        "--port",
        "--base-dir",
        "--bootstrap-fd",
        "--no-browser",
    ] {
        assert!(stdout.contains(expected), "missing {expected} in {stdout}");
    }
}

#[test]
fn transport_stdio_forward_accepts_only_a_numeric_loopback_port() {
    let action = Cli::try_parse_from([
        "bibcode",
        "transport",
        "stdio-forward",
        "--loopback-port",
        "4773",
    ])
    .expect("transport arguments parse")
    .into_action()
    .expect("transport action resolves");
    assert!(matches!(
        action,
        CliAction::Transport(TransportCommand::StdioForward {
            loopback_port: 4_773
        })
    ));

    for forbidden in [
        vec!["--host", "192.0.2.10"],
        vec!["--base-dir", "/tmp/other-store"],
        vec!["--port", "4774"],
    ] {
        let mut arguments = vec![
            "bibcode",
            "transport",
            "stdio-forward",
            "--loopback-port",
            "4773",
        ];
        arguments.extend(forbidden);
        assert!(
            Cli::try_parse_from(arguments)
                .expect("global syntax parses")
                .into_action()
                .expect_err("transport must reject every server listener option")
                .to_string()
                .contains("accepts only --loopback-port")
        );
    }

    assert!(
        Cli::try_parse_from([
            "bibcode",
            "transport",
            "stdio-forward",
            "--loopback-port",
            "0",
        ])
        .expect("numeric syntax parses")
        .into_action()
        .expect_err("port zero is not a connectable loopback target")
        .to_string()
        .contains("non-zero")
    );
}

#[tokio::test]
async fn transport_stdio_forward_preserves_http_upgrade_bytes_without_a_stream_timeout() {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("loopback fixture binds");
    let port = listener.local_addr().expect("fixture address").port();
    let port_argument = port.to_string();
    let mut child = TokioCommand::new(env!("CARGO_BIN_EXE_bibcode"))
        .args([
            "transport",
            "stdio-forward",
            "--loopback-port",
            port_argument.as_str(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("stdio forward child starts");
    // macOS debug binaries can spend several seconds in process startup before
    // the command's own bounded connect begins.
    let accepted = timeout(Duration::from_secs(15), listener.accept()).await;
    let (mut remote, peer) = match accepted {
        Ok(accepted) => accepted.expect("loopback fixture accepts"),
        Err(_) => {
            let _ = child.start_kill();
            let status = child.wait().await.expect("reap failed forward child");
            let mut stderr = child.stderr.take().expect("failed forward stderr");
            let mut stderr_bytes = Vec::new();
            stderr
                .read_to_end(&mut stderr_bytes)
                .await
                .expect("read failed forward stderr");
            panic!(
                "stdio forward {} did not connect before its setup deadline ({status}): {}",
                env!("CARGO_BIN_EXE_bibcode"),
                String::from_utf8_lossy(&stderr_bytes)
            );
        }
    };
    assert!(peer.ip().is_loopback());

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(child.try_wait().expect("inspect stalled forward"), None);

    let request = b"GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n\0\xff";
    let response = b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n\x81\x03raw";
    let mut child_stdin = child.stdin.take().expect("forward stdin");
    let mut child_stdout = child.stdout.take().expect("forward stdout");
    child_stdin
        .write_all(request)
        .await
        .expect("write request bytes");
    let mut received_request = vec![0; request.len()];
    remote
        .read_exact(&mut received_request)
        .await
        .expect("remote receives exact request");
    assert_eq!(received_request, request);

    remote
        .write_all(response)
        .await
        .expect("write response bytes");
    let mut received_response = vec![0; response.len()];
    child_stdout
        .read_exact(&mut received_response)
        .await
        .expect("stdout receives exact response");
    assert_eq!(received_response, response);

    drop(child_stdin);
    remote.shutdown().await.expect("close remote fixture");
    drop(remote);
    let status = timeout(Duration::from_secs(2), child.wait())
        .await
        .expect("stdio forward exits when the stream closes")
        .expect("stdio forward child is reaped");
    let mut stderr = child.stderr.take().expect("forward stderr");
    let mut stderr_bytes = Vec::new();
    stderr
        .read_to_end(&mut stderr_bytes)
        .await
        .expect("read forward stderr");
    assert!(
        status.success(),
        "stdio forward failed: {}",
        String::from_utf8_lossy(&stderr_bytes)
    );
}

#[test]
fn service_cli_has_typed_modes_actions_and_loopback_target() {
    let root = TempDir::new().expect("temporary service root");
    let action = Cli::try_parse_from([
        "bibcode",
        "service",
        "install",
        "--mode",
        "workstation",
        "--format",
        "json",
        "--update",
        "--host",
        "127.0.0.1",
        "--port",
        "4773",
        "--base-dir",
        root.path().to_string_lossy().as_ref(),
    ])
    .expect("service arguments parse")
    .into_action()
    .expect("service action resolves");

    let CliAction::Service(ServiceCliCommand {
        operation,
        mode,
        root: resolved,
        bind,
        format,
    }) = action
    else {
        panic!("unexpected CLI action: {action:?}");
    };
    assert_eq!(operation, ServiceOperation::Install { update: true });
    assert_eq!(mode, ServiceMode::Workstation);
    assert_eq!(resolved.effective, root.path().canonicalize().unwrap());
    assert_eq!(bind.to_string(), "127.0.0.1:4773");
    assert_eq!(format, ServiceOutputFormat::Json);
}

#[test]
fn service_cli_defaults_to_workstation_and_has_no_data_purge_flag() {
    let root = TempDir::new().expect("temporary service root");
    let action = Cli::try_parse_from([
        "bibcode",
        "service",
        "status",
        "--base-dir",
        root.path().to_string_lossy().as_ref(),
    ])
    .expect("default service arguments parse")
    .into_action()
    .expect("default service action resolves");
    let CliAction::Service(command) = action else {
        panic!("unexpected CLI action: {action:?}");
    };
    assert_eq!(command.mode, ServiceMode::Workstation);
    assert_eq!(command.operation, ServiceOperation::Status);
    assert_eq!(command.format, ServiceOutputFormat::Human);

    let rejected = Cli::try_parse_from([
        "bibcode",
        "service",
        "uninstall",
        "--purge",
        "--base-dir",
        root.path().to_string_lossy().as_ref(),
    ]);
    assert!(
        rejected.is_err(),
        "service uninstall must not expose data purge"
    );
}

#[test]
fn service_cli_rejects_non_loopback_bind_before_any_host_mutation() {
    let root = TempDir::new().expect("temporary service root");
    let error = Cli::try_parse_from([
        "bibcode",
        "service",
        "install",
        "--host",
        "0.0.0.0",
        "--base-dir",
        root.path().to_string_lossy().as_ref(),
    ])
    .expect("syntax parses")
    .into_action()
    .expect_err("managed service must remain loopback-only");

    assert!(error.to_string().contains("loopback"));
}

#[test]
fn pairing_create_cli_has_the_exact_nested_model_and_resolves_its_data_root() {
    let root = TempDir::new().expect("temporary pairing root");
    let action = Cli::try_parse_from([
        "bibcode",
        "auth",
        "pairing",
        "create",
        "--client-label",
        "Administrator laptop",
        "--format",
        "json",
        "--base-dir",
        root.path().to_string_lossy().as_ref(),
    ])
    .expect("pairing arguments parse")
    .into_action()
    .expect("pairing action resolves");

    let CliAction::Auth(AuthCommand::CreatePairing {
        root: resolved,
        client_label,
        format,
    }) = action
    else {
        panic!("unexpected CLI action: {action:?}");
    };
    assert_eq!(resolved.effective, root.path().canonicalize().unwrap());
    assert_eq!(client_label.as_deref(), Some("Administrator laptop"));
    assert_eq!(format, PairingOutputFormat::Json);
}

#[tokio::test]
async fn pairing_create_prints_one_secret_bearing_document_only_on_stdout() {
    let root = TempDir::new().expect("temporary pairing root");
    let handle = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("start pairing server");

    let json_output = pairing_cli_output(&root, "json", Some("Administrator laptop")).await;
    assert!(
        json_output.status.success(),
        "pairing CLI failed: {}",
        String::from_utf8_lossy(&json_output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&json_output.stdout)
            .trim()
            .lines()
            .count(),
        1,
        "JSON mode must emit one document"
    );
    let json: Value = serde_json::from_slice(&json_output.stdout).expect("pairing JSON");
    let credential = json["credential"].as_str().expect("pairing credential");
    let pairing_url = json["pairingUrl"].as_str().expect("pairing URL");
    assert_eq!(json["controlProtocolVersion"], CONTROL_PROTOCOL_VERSION);
    let expected_environment_id =
        std::fs::read_to_string(root.path().join("userdata").join("environment-id"))
            .expect("environment identity marker");
    assert_eq!(json["environmentId"], expected_environment_id.trim());
    assert!(json["expiresAt"].as_str().is_some());
    let parsed_url = url::Url::parse(pairing_url).expect("valid pairing URL");
    assert!(parsed_url.query().is_none());
    assert_eq!(
        parsed_url
            .fragment()
            .and_then(|fragment| url::form_urlencoded::parse(fragment.as_bytes())
                .find_map(|(key, value)| (key == "token").then(|| value.into_owned())))
            .as_deref(),
        Some(credential)
    );
    assert!(
        !String::from_utf8_lossy(&json_output.stderr).contains(credential),
        "the credential must never be duplicated to stderr"
    );

    let human_output = pairing_cli_output(&root, "human", None).await;
    assert!(human_output.status.success());
    let human = String::from_utf8(human_output.stdout).expect("human pairing output");
    assert!(human.starts_with("Pairing URL: "));
    assert!(human.contains("\nExpires at: "));
    assert!(human_output.stderr.is_empty());
    let human_url = human
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("Pairing URL: "))
        .expect("human pairing URL");
    let human_url = url::Url::parse(human_url).expect("valid human pairing URL");
    let human_credential = human_url
        .fragment()
        .and_then(|fragment| {
            url::form_urlencoded::parse(fragment.as_bytes())
                .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
        })
        .expect("human pairing credential fragment");
    assert_eq!(human.matches(&human_credential).count(), 1);

    handle.shutdown();
    handle.join().await.expect("join pairing server");
}

#[tokio::test]
async fn pairing_create_distinguishes_wrong_root_from_a_stopped_server() {
    let wrong_root = TempDir::new().expect("wrong pairing root");
    let wrong = pairing_cli_output(&wrong_root, "json", None).await;
    assert!(!wrong.status.success());
    assert!(wrong.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&wrong.stderr).contains("does not contain a BiBCode environment")
    );

    let stopped_root = TempDir::new().expect("stopped pairing root");
    let handle =
        ServerRuntime::start(ServerConfig::new(stopped_root.path()).with_bind("127.0.0.1", 0))
            .await
            .expect("seed stopped environment");
    handle.shutdown();
    handle.join().await.expect("stop seeded environment");
    let stopped = pairing_cli_output(&stopped_root, "human", None).await;
    assert!(!stopped.status.success());
    assert!(stopped.stdout.is_empty());
    assert!(String::from_utf8_lossy(&stopped.stderr).contains("server is not running"));
}

#[cfg(unix)]
#[tokio::test]
async fn pairing_create_rejects_inaccessible_and_expired_control_replies_without_secret_leakage() {
    use std::os::unix::fs::PermissionsExt;

    let inaccessible_root = TempDir::new().expect("inaccessible pairing root");
    let inaccessible_state = inaccessible_root.path().join("userdata");
    let inaccessible_run = inaccessible_state.join("run");
    std::fs::create_dir_all(&inaccessible_run).expect("create inaccessible state");
    std::fs::set_permissions(&inaccessible_run, std::fs::Permissions::from_mode(0o700))
        .expect("secure inaccessible run directory");
    std::fs::write(
        inaccessible_state.join("environment-id"),
        uuid::Uuid::new_v4().to_string(),
    )
    .expect("write inaccessible marker");
    std::fs::write(inaccessible_run.join("control.sock"), b"not a socket")
        .expect("write inaccessible endpoint fixture");
    let inaccessible = pairing_cli_output(&inaccessible_root, "json", None).await;
    assert!(!inaccessible.status.success());
    assert!(inaccessible.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&inaccessible.stderr)
            .contains("control endpoint cannot be reached")
    );

    let http_only_root = TempDir::new().expect("HTTP-only pairing root");
    let http_only_handle =
        ServerRuntime::start(ServerConfig::new(http_only_root.path()).with_bind("127.0.0.1", 0))
            .await
            .expect("start server before hiding local control");
    let control_socket = http_only_root
        .path()
        .join("userdata")
        .join("run")
        .join("control.sock");
    std::fs::rename(
        &control_socket,
        control_socket.with_file_name("hidden-control.sock"),
    )
    .expect("hide control endpoint while HTTP remains active");
    let http_only = pairing_cli_output(&http_only_root, "json", None).await;
    assert!(
        !http_only.status.success(),
        "pairing CLI must not fall back to the live HTTP server"
    );
    assert!(http_only.stdout.is_empty());
    assert!(
        reqwest::get(format!(
            "{}/.well-known/bibcode/environment",
            http_only_handle.advertised_base_url()
        ))
        .await
        .expect("HTTP server remains reachable")
        .status()
        .is_success()
    );
    http_only_handle.shutdown();
    http_only_handle
        .join()
        .await
        .expect("join HTTP-only server");

    let expired_root = TempDir::new().expect("expired pairing root");
    let expired_state = expired_root.path().join("userdata");
    let expired_run = expired_state.join("run");
    std::fs::create_dir_all(&expired_run).expect("create expired state");
    std::fs::set_permissions(&expired_run, std::fs::Permissions::from_mode(0o700))
        .expect("secure expired run directory");
    let environment_id = EnvironmentId::from_uuid(uuid::Uuid::new_v4());
    std::fs::write(
        expired_state.join("environment-id"),
        environment_id.to_string(),
    )
    .expect("write expired marker");
    let socket = expired_run.join("control.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind fake control endpoint");
    let secret = "PAIRINGSECRET".to_owned();
    let server_secret = secret.clone();
    let responder = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept pairing CLI");
        let request = read_request(&mut stream)
            .await
            .expect("read pairing request");
        write_response(
            &mut stream,
            &ControlResponse {
                version: CONTROL_PROTOCOL_VERSION,
                request_id: request.request_id,
                body: ControlResponseBody::PairingCreated {
                    environment_id,
                    credential: server_secret.clone(),
                    expires_at: "2000-01-01T00:00:00Z".to_owned(),
                    pairing_url: format!("https://environment.invalid/pair#token={server_secret}"),
                },
            },
        )
        .await
        .expect("write expired response");
    });
    let expired = pairing_cli_output(&expired_root, "json", None).await;
    responder.await.expect("fake control responder");
    assert!(!expired.status.success());
    assert!(expired.stdout.is_empty());
    let error = String::from_utf8(expired.stderr).expect("expired CLI error");
    assert!(error.contains("expired"), "{error}");
    assert!(!error.contains(&secret));
}

async fn pairing_cli_output(
    root: &TempDir,
    format: &str,
    client_label: Option<&str>,
) -> std::process::Output {
    let mut command = TokioCommand::new(env!("CARGO_BIN_EXE_bibcode"));
    command
        .args(["auth", "pairing", "create", "--base-dir"])
        .arg(root.path())
        .args(["--format", format]);
    if let Some(client_label) = client_label {
        command.args(["--client-label", client_label]);
    }
    command.output().await.expect("run pairing CLI")
}

#[tokio::test]
async fn storage_inspect_prints_one_json_document_for_an_offline_store() {
    let root = TempDir::new().expect("temporary storage root");
    let handle = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("seed inspectable store");
    handle.shutdown();
    handle.join().await.expect("stop inspectable store");

    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["storage", "inspect", "--base-dir"])
        .arg(root.path())
        .arg("--json")
        .output()
        .expect("run storage inspect");

    assert!(
        output.status.success(),
        "storage inspect failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("inspection JSON");
    assert_eq!(value["classification"], "existing");
    assert!(value["storageInstanceId"].as_str().is_some());
    assert_eq!(value["backups"], json!([]));
    assert_eq!(
        value["effectiveRoot"],
        root.path()
            .canonicalize()
            .expect("canonical storage root")
            .to_string_lossy()
            .as_ref()
    );
}

#[tokio::test]
async fn storage_restore_prints_json_and_restores_the_selected_verified_generation() {
    let root = TempDir::new().expect("temporary storage root");
    let mut config = ServerConfig::new(root.path());
    let resolved = resolve_data_root(config.data_root_request.clone()).expect("resolve root");
    config.base_dir.clone_from(&resolved.effective);
    config.resolved_data_root = Some(resolved);
    let paths = StatePaths::from_config(&config);
    std::fs::create_dir_all(&paths.state_dir).expect("state directory");
    let prepared = prepare_store(&config)
        .await
        .expect("prepare CLI recovery store");
    prepared
        .database
        .call(|connection| {
            connection.execute(
                "INSERT INTO projection_projects (
                   project_id, title, workspace_root, default_model_selection_json,
                   scripts_json, created_at, updated_at, deleted_at
                 ) VALUES ('cli-project', 'Before restore', '/tmp/cli-project', NULL, '{}',
                           '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', NULL)",
                [],
            )?;
            Ok(())
        })
        .await
        .expect("seed CLI project");
    let backup = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("create CLI restore generation");
    prepared
        .database
        .call(|connection| {
            connection.execute(
                "UPDATE projection_projects SET title = 'After backup' WHERE project_id = 'cli-project'",
                [],
            )?;
            Ok(())
        })
        .await
        .expect("mutate CLI project");
    drop(prepared);
    tokio::time::sleep(Duration::from_millis(25)).await;

    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["storage", "restore", "--base-dir"])
        .arg(root.path())
        .args([
            "--backup-id",
            &backup.manifest.backup_id.to_string(),
            "--json",
        ])
        .output()
        .expect("run storage restore");

    assert!(
        output.status.success(),
        "storage restore failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("restore JSON");
    assert_eq!(value["action"], "restore");
    assert!(value["preservedDirectory"].as_str().is_some());
    let restored = Connection::open(&paths.database).expect("restored database");
    let title: String = restored
        .query_row(
            "SELECT title FROM projection_projects WHERE project_id = 'cli-project'",
            [],
            |row| row.get(0),
        )
        .expect("restored CLI project");
    assert_eq!(title, "Before restore");
}

#[tokio::test]
async fn storage_start_empty_exits_nonzero_without_mutating_a_running_store() {
    let root = TempDir::new().expect("temporary active storage root");
    let handle = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("start active storage owner");
    let mut config = ServerConfig::new(root.path());
    let resolved = handle.data_root().clone();
    config.base_dir.clone_from(&resolved.effective);
    config.resolved_data_root = Some(resolved);
    let paths = StatePaths::from_config(&config);
    let database_before = std::fs::read(&paths.database).expect("active database bytes");
    let marker_before = std::fs::read(&paths.environment_id).expect("active marker bytes");

    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["storage", "start-empty", "--base-dir"])
        .arg(root.path())
        .arg("--json")
        .output()
        .expect("run unsafe start-empty");

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("project-data store is currently owned by a running server")
    );
    assert_eq!(
        std::fs::read(&paths.database).expect("active database remains"),
        database_before
    );
    assert_eq!(
        std::fs::read(&paths.environment_id).expect("active marker remains"),
        marker_before
    );
    handle.shutdown();
    handle.join().await.expect("stop active storage owner");
}

#[test]
#[cfg(windows)]
fn headless_binary_reports_invalid_bootstrap_descriptors_without_panicking() {
    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["serve", "--bootstrap-fd", "4"])
        .output()
        .expect("run bibcode with unsupported bootstrap fd");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("UTF-8 error output");
    assert!(stderr.contains("bootstrap file descriptor 4 is unsupported on this platform"));
    assert!(!stderr.to_ascii_lowercase().contains("panicked"));
}

#[test]
fn serve_flags_have_the_same_value_before_or_after_the_subcommand() {
    let temp = TempDir::new().expect("temporary base directory");
    let base_dir = temp.path().to_string_lossy();
    let before = Cli::try_parse_from([
        "bibcode",
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--base-dir",
        base_dir.as_ref(),
        "serve",
    ])
    .expect("flags before serve")
    .into_server_config()
    .expect("configuration before serve");
    let after = Cli::try_parse_from([
        "bibcode",
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--base-dir",
        base_dir.as_ref(),
    ])
    .expect("flags after serve")
    .into_server_config()
    .expect("configuration after serve");

    assert_eq!(before.host, after.host);
    assert_eq!(before.port, after.port);
    assert_eq!(before.base_dir, after.base_dir);
    assert!(before.no_browser);
    assert!(after.no_browser);
}

#[test]
fn tls_listener_files_are_an_atomic_cli_pair() {
    let temp = TempDir::new().expect("temporary base directory");
    let base_dir = temp.path().to_string_lossy();
    let config = Cli::try_parse_from([
        "bibcode",
        "serve",
        "--base-dir",
        base_dir.as_ref(),
        "--tls-certificate-chain",
        "certificate.pem",
        "--tls-private-key",
        "private-key.pem",
    ])
    .expect("paired TLS arguments parse")
    .into_server_config()
    .expect("paired TLS configuration builds");
    let tls = config.tls.expect("TLS files");
    assert_eq!(
        tls.certificate_chain,
        std::path::PathBuf::from("certificate.pem")
    );
    assert_eq!(tls.private_key, std::path::PathBuf::from("private-key.pem"));

    for incomplete in [
        ["--tls-certificate-chain", "certificate.pem"],
        ["--tls-private-key", "private-key.pem"],
    ] {
        assert!(
            Cli::try_parse_from(["bibcode", "serve", incomplete[0], incomplete[1]]).is_err(),
            "incomplete TLS file pair must fail: {incomplete:?}"
        );
    }
}

#[test]
fn start_opens_a_browser_unless_disabled_while_serve_is_always_headless() {
    let start = Cli::try_parse_from(["bibcode", "start"])
        .expect("start arguments")
        .into_server_config()
        .expect("start configuration");
    let disabled = Cli::try_parse_from(["bibcode", "start", "--no-browser"])
        .expect("disabled browser arguments")
        .into_server_config()
        .expect("disabled browser configuration");
    let serve = Cli::try_parse_from(["bibcode", "serve"])
        .expect("serve arguments")
        .into_server_config()
        .expect("serve configuration");

    assert!(!start.no_browser);
    assert!(disabled.no_browser);
    assert!(serve.no_browser);
}

#[tokio::test]
async fn desktop_bootstrap_rejects_an_empty_shutdown_token() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut child = TokioCommand::new(env!("CARGO_BIN_EXE_bibcode"))
        .args([
            "serve",
            "--mode",
            "desktop",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--base-dir",
        ])
        .arg(temp.path())
        .args(["--bootstrap-fd", "0"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn bibcode server");
    let bootstrap = json!({
        "mode": "desktop",
        "noBrowser": true,
        "port": 0,
        "host": "127.0.0.1",
        "desktopBootstrapToken": "",
        "tailscaleServeEnabled": false,
        "tailscaleServePort": 443
    });
    let mut stdin = child.stdin.take().expect("child stdin");
    stdin
        .write_all(format!("{bootstrap}\n").as_bytes())
        .await
        .expect("write empty-token bootstrap");
    drop(stdin);

    let mut stderr = child.stderr.take().expect("child stderr");
    let status = match timeout(Duration::from_secs(10), child.wait()).await {
        Ok(status) => status.expect("server exit status"),
        Err(_) => {
            child.kill().await.expect("kill server after timeout");
            panic!("server accepted an empty desktop bootstrap token");
        }
    };
    let mut error = String::new();
    stderr
        .read_to_string(&mut error)
        .await
        .expect("read server error");
    assert!(!status.success());
    assert!(
        error.contains("desktop bootstrap token must not be empty"),
        "{error}"
    );
}

#[test]
#[cfg(unix)]
fn headless_configuration_reads_an_inherited_nonzero_bootstrap_fd() {
    use std::{
        io::Write,
        os::{fd::IntoRawFd, unix::net::UnixStream},
    };

    let (mut writer, reader) = UnixStream::pair().expect("bootstrap socket pair");
    let bootstrap = json!({
        "mode": "desktop",
        "noBrowser": true,
        "port": 4567,
        "host": "127.0.0.1",
        "desktopBootstrapToken": "inherited-fd-secret",
        "tailscaleServeEnabled": false,
        "tailscaleServePort": 443
    });
    writeln!(writer, "{bootstrap}").expect("write inherited bootstrap");
    let fd = reader.into_raw_fd().to_string();

    let config = Cli::try_parse_from(["bibcode", "serve", "--bootstrap-fd", fd.as_str()])
        .expect("inherited bootstrap arguments")
        .into_server_config()
        .expect("inherited bootstrap configuration");
    assert_eq!(config.port, 4567);
    assert_eq!(
        config.desktop_bootstrap_token.as_deref(),
        Some("inherited-fd-secret")
    );
}

#[tokio::test]
async fn headless_binary_reads_desktop_bootstrap_and_shuts_down_over_http() {
    let temp = TempDir::new().expect("temporary base directory");
    let mut child = TokioCommand::new(env!("CARGO_BIN_EXE_bibcode"))
        .args([
            "serve",
            "--mode",
            "desktop",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--base-dir",
        ])
        .arg(temp.path())
        .args(["--no-browser", "--bootstrap-fd", "0"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn bibcode server");

    let bootstrap = json!({
        "mode": "desktop",
        "noBrowser": true,
        "port": 0,
        "bibcodeHome": temp.path(),
        "host": "127.0.0.1",
        "desktopBootstrapToken": "process-smoke-secret",
        "tailscaleServeEnabled": false,
        "tailscaleServePort": 443
    });
    let mut stdin = child.stdin.take().expect("child stdin");
    stdin
        .write_all(format!("{bootstrap}\n").as_bytes())
        .await
        .expect("write desktop bootstrap");
    drop(stdin);

    let stdout = child.stdout.take().expect("child stdout");
    let mut lines = BufReader::new(stdout).lines();
    let ready_line = match timeout(Duration::from_secs(30), lines.next_line()).await {
        Ok(result) => result
            .expect("read readiness line")
            .expect("server readiness line"),
        Err(error) => {
            child.kill().await.expect("terminate unready server");
            panic!("server readiness timeout: {error}");
        }
    };
    let ready: Value = serde_json::from_str(&ready_line).expect("readiness JSON");
    let http_base_url = ready["httpBaseUrl"].as_str().expect("HTTP base URL");

    let shutdown = reqwest::Client::new()
        .post(format!(
            "{http_base_url}/.well-known/bibcode/desktop/shutdown"
        ))
        .header("x-bibcode-desktop-bootstrap-token", "process-smoke-secret")
        .send()
        .await
        .expect("desktop shutdown request");
    assert_eq!(shutdown.status(), reqwest::StatusCode::ACCEPTED);

    let status = timeout(Duration::from_secs(10), child.wait())
        .await
        .expect("server exit timeout")
        .expect("server exit status");
    assert!(status.success(), "server exited with {status}");
}
