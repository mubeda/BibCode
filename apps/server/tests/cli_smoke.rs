use std::{
    process::{Command, Stdio},
    time::Duration,
};

use bibcode_server::{
    Cli, ServerConfig, ServerRuntime,
    persistence::{BackupTrigger, StatePaths, create_verified_backup, prepare_store},
    resolve_data_root,
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

#[tokio::test]
async fn pairing_issue_prints_a_credential_the_running_server_exchanges() {
    let root = TempDir::new().expect("temporary storage root");
    let handle = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("start pairing storage owner");
    let http_base_url = format!("http://{}", handle.local_addr());

    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["pairing", "issue", "--base-dir"])
        .arg(root.path())
        .args(["--label", "SSH bootstrap", "--json"])
        .output()
        .expect("run pairing issue");
    assert!(
        output.status.success(),
        "pairing issue failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("UTF-8 pairing output");
    let line = stdout
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .expect("pairing JSON line");
    let value: Value = serde_json::from_str(line).expect("pairing JSON document");
    let credential = value["credential"].as_str().expect("credential string");
    assert!(!credential.trim().is_empty());
    assert_eq!(value["label"], "SSH bootstrap");
    assert!(value["expiresAt"].as_str().is_some());

    let exchange = reqwest::Client::new()
        .post(format!("{http_base_url}/oauth/token"))
        .form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", credential),
            (
                "subject_token_type",
                "urn:bibcode:params:oauth:token-type:environment-bootstrap",
            ),
            (
                "requested_token_type",
                "urn:ietf:params:oauth:token-type:access_token",
            ),
            ("client_label", "CLI pairing smoke"),
            ("client_device_type", "desktop"),
        ])
        .send()
        .await
        .expect("token exchange request");
    assert_eq!(exchange.status(), reqwest::StatusCode::OK);
    let token: Value = exchange.json().await.expect("token exchange JSON");
    assert!(
        token["access_token"]
            .as_str()
            .is_some_and(|token| !token.is_empty())
    );
    assert_eq!(token["token_type"], "Bearer");
    assert!(
        token["scope"]
            .as_str()
            .is_some_and(|scope| scope.contains("access:write"))
    );

    handle.shutdown();
    handle.join().await.expect("stop pairing storage owner");
}

#[test]
fn pairing_issue_fails_closed_without_a_data_store() {
    let root = TempDir::new().expect("temporary empty root");

    let output = Command::new(env!("CARGO_BIN_EXE_bibcode"))
        .args(["pairing", "issue", "--base-dir"])
        .arg(root.path())
        .arg("--json")
        .output()
        .expect("run pairing issue without a store");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("no BiBCode data store"), "{stderr}");
    assert!(
        output.stdout.is_empty(),
        "no credential may be printed on failure"
    );
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
