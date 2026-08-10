use bibcode_server::{
    ServerConfig, ServerRuntime,
    persistence::{
        PreparedStore, StatePaths, StoreClassification, StoreStartupError, prepare_store,
        run_migrations,
    },
    production::jwt::PersistentJwtCodec,
    resolve_data_root,
};
use reqwest::{Client, StatusCode};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::symlink;

const CRASH_STORE_CHILD_ROOT: &str = "BIBCODE_CRASH_STORE_CHILD_ROOT";
const CRASH_STORE_CHILD_READY: &str = "BIBCODE_CRASH_STORE_CHILD_READY";

struct StoreFixture {
    _root: TempDir,
    config: ServerConfig,
    paths: StatePaths,
}

impl StoreFixture {
    fn new() -> Self {
        let root = TempDir::new().expect("temporary absolute data root");
        let mut config = ServerConfig::new(root.path());
        let resolved = resolve_data_root(config.data_root_request.clone()).expect("resolve root");
        config.base_dir = resolved.effective.clone();
        config.resolved_data_root = Some(resolved);
        let paths = StatePaths::from_config(&config);
        std::fs::create_dir_all(&paths.state_dir).expect("state directory");
        Self {
            _root: root,
            config,
            paths,
        }
    }

    async fn with_project(title: &str) -> Self {
        let fixture = Self::new();
        let mut connection = Connection::open(&fixture.paths.database).expect("fixture database");
        run_migrations(&mut connection, None).expect("fixture migrations");
        connection
            .execute(
                "INSERT INTO projection_projects (
                   project_id, title, workspace_root, default_model_selection_json,
                   scripts_json, created_at, updated_at, deleted_at
                 ) VALUES (?1, ?2, '/tmp/protected-project', NULL, '{}',
                           '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z', NULL)",
                ["protected-project", title],
            )
            .expect("fixture project");
        drop(connection);
        fixture
    }

    fn write_marker(&self, storage_instance_id: Uuid) {
        std::fs::write(
            &self.paths.environment_id,
            format!("{storage_instance_id}\n"),
        )
        .expect("marker fixture");
    }

    fn write_marker_bytes(&self, bytes: &[u8]) {
        std::fs::write(&self.paths.environment_id, bytes).expect("marker fixture");
    }

    async fn prepare(&self) -> Result<PreparedStore, StoreStartupError> {
        prepare_store(&self.config).await
    }
}

fn server_endpoint(handle: &bibcode_server::ServerHandle, path: &str) -> String {
    format!("http://{}{path}", handle.local_addr())
}

fn assert_descriptor_is_path_redacted(
    descriptor: &Value,
    requested_root: &Path,
    effective_root: &Path,
) {
    const FORBIDDEN_KEYS: [&str; 5] = [
        "baseDir",
        "resolvedDataRoot",
        "requestedRoot",
        "effectiveRoot",
        "isFilesystemAlias",
    ];
    let requested = requested_root.to_string_lossy();
    let effective = effective_root.to_string_lossy();
    fn assert_value_has_no_path(value: &Value, requested: &str, effective: &str) {
        match value {
            Value::Array(values) => {
                for value in values {
                    assert_value_has_no_path(value, requested, effective);
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    assert!(
                        !FORBIDDEN_KEYS.contains(&key.as_str()),
                        "descriptor leaked local root diagnostic field {key}"
                    );
                    assert_value_has_no_path(value, requested, effective);
                }
            }
            Value::String(value) => {
                assert!(
                    !value.contains(requested),
                    "descriptor leaked requested root"
                );
                assert!(
                    !value.contains(effective),
                    "descriptor leaked effective root"
                );
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }
    assert_value_has_no_path(descriptor, &requested, &effective);
}

async fn fetch_axum_descriptor(client: &Client, handle: &bibcode_server::ServerHandle) -> Value {
    let response = client
        .get(server_endpoint(handle, "/.well-known/bibcode/environment"))
        .send()
        .await
        .expect("environment descriptor response");
    assert_eq!(response.status(), StatusCode::OK);
    response.json().await.expect("environment descriptor JSON")
}

async fn fetch_connect_descriptor(client: &Client, handle: &bibcode_server::ServerHandle) -> Value {
    let credential = handle
        .startup_access()
        .expect("web startup access")
        .credential
        .clone();
    let token_response = client
        .post(server_endpoint(handle, "/oauth/token"))
        .form(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:token-exchange",
            ),
            ("subject_token", credential.as_str()),
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
        .expect("startup credential exchange");
    assert_eq!(token_response.status(), StatusCode::OK);
    let access_token = token_response
        .json::<Value>()
        .await
        .expect("access token JSON")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    let cloud_keys = TempDir::new().expect("temporary Connect cloud key directory");
    let cloud_codec = PersistentJwtCodec::open(cloud_keys.path().join("cloud-keypair.json"))
        .await
        .expect("Connect cloud JWT codec");
    let (_, cloud_public_key) = cloud_codec
        .key_pair()
        .await
        .expect("Connect cloud key pair");
    let config_response = client
        .post(server_endpoint(handle, "/api/connect/relay-config"))
        .bearer_auth(&access_token)
        .json(&json!({
            "relayUrl": "https://relay.example",
            "relayIssuer": "https://relay.example",
            "cloudUserId": "project-data-safety-user",
            "environmentCredential": "project-data-safety-credential",
            "cloudMintPublicKey": cloud_public_key,
            "endpointRuntime": null
        }))
        .send()
        .await
        .expect("Connect relay configuration response");
    let config_status = config_response.status();
    let config_body = config_response
        .text()
        .await
        .expect("Connect relay configuration response body");
    assert_eq!(
        config_status,
        StatusCode::OK,
        "Connect relay configuration error: {config_body}"
    );
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let proof = cloud_codec
        .sign(
            "bibcode-cloud-health+jwt",
            json!({
                "iss": "https://relay.example",
                "aud": "bibcode-env:local",
                "sub": "project-data-safety-user",
                "jti": Uuid::new_v4().to_string(),
                "iat": now,
                "exp": now + 300,
                "environmentId": "local",
                "nonce": Uuid::new_v4().to_string(),
                "scope": ["environment:status"]
            }),
        )
        .await
        .expect("signed Connect health proof");
    let response = client
        .post(server_endpoint(handle, "/api/bibcode-connect/health"))
        .bearer_auth(access_token)
        .json(&json!({ "proof": proof }))
        .send()
        .await
        .expect("Connect health response");
    let status = response.status();
    let body = response.text().await.expect("Connect health response body");
    assert_eq!(status, StatusCode::OK, "Connect health error: {body}");
    serde_json::from_str::<Value>(&body).expect("Connect health JSON")["descriptor"].clone()
}

#[tokio::test]
async fn descriptor_surfaces_publish_one_stable_uuid_without_local_path_leakage() {
    let root = TempDir::new().expect("temporary absolute data root");
    let client = Client::builder()
        .no_proxy()
        .build()
        .expect("proxy-free HTTP client");

    let first = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("first server start");
    let requested_root = first.data_root().requested.clone();
    let effective_root = first.data_root().effective.clone();
    let first_axum = fetch_axum_descriptor(&client, &first).await;
    let first_connect = fetch_connect_descriptor(&client, &first).await;
    let first_storage_id = first_axum["storageInstanceId"]
        .as_str()
        .expect("new local server storage UUID");
    Uuid::parse_str(first_storage_id).expect("valid server storage UUID");
    assert_eq!(first_connect["storageInstanceId"], first_storage_id);
    assert_descriptor_is_path_redacted(&first_axum, &requested_root, &effective_root);
    assert_descriptor_is_path_redacted(&first_connect, &requested_root, &effective_root);
    first.shutdown();
    first.join().await.expect("first server shutdown");

    let second = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("second server start");
    let second_axum = fetch_axum_descriptor(&client, &second).await;
    let second_connect = fetch_connect_descriptor(&client, &second).await;
    assert_eq!(second_axum["storageInstanceId"], first_storage_id);
    assert_eq!(second_connect["storageInstanceId"], first_storage_id);
    assert_descriptor_is_path_redacted(&second_axum, &requested_root, &effective_root);
    assert_descriptor_is_path_redacted(&second_connect, &requested_root, &effective_root);
    second.shutdown();
    second.join().await.expect("second server shutdown");
}

#[tokio::test]
async fn marker_without_database_never_creates_replacement_sqlite() {
    let fixture = StoreFixture::new();
    fixture.write_marker(Uuid::new_v4());
    let marker_before = std::fs::read(&fixture.paths.environment_id).expect("marker fixture bytes");

    let error = match fixture.prepare().await {
        Ok(_) => panic!("missing database must block"),
        Err(error) => error,
    };

    assert!(matches!(error, StoreStartupError::DatabaseMissing { .. }));
    assert!(!fixture.paths.database.exists());
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("marker remains"),
        marker_before
    );
}

#[tokio::test]
async fn existing_unmarked_database_is_adopted_without_catalog_changes() {
    let fixture = StoreFixture::with_project("Protected project").await;
    assert!(!fixture.paths.environment_id.exists());

    let prepared = fixture.prepare().await.expect("adopt existing database");

    assert_eq!(
        prepared.classification,
        StoreClassification::ExistingUnmarked
    );
    let titles = prepared
        .database
        .call(|connection| {
            let mut statement =
                connection.prepare("SELECT title FROM projection_projects ORDER BY title")?;
            Ok(statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
        .expect("project titles");
    assert_eq!(titles, ["Protected project"]);
    assert!(fixture.paths.environment_id.is_file());
}

#[tokio::test]
async fn first_run_creates_the_database_and_one_valid_marker() {
    let fixture = StoreFixture::new();

    let prepared = fixture.prepare().await.expect("prepare first run");

    assert_eq!(prepared.classification, StoreClassification::FirstRun);
    assert!(fixture.paths.database.is_file());
    let marker = std::fs::read_to_string(&fixture.paths.environment_id).expect("marker");
    Uuid::parse_str(marker.trim()).expect("marker UUID");
}

#[tokio::test]
async fn existing_database_with_valid_marker_reuses_the_store() {
    let fixture = StoreFixture::with_project("Existing project").await;
    let marker = Uuid::new_v4();
    fixture.write_marker(marker);
    let original_marker = std::fs::read(&fixture.paths.environment_id).expect("marker bytes");

    let prepared = fixture.prepare().await.expect("prepare existing store");

    assert_eq!(prepared.classification, StoreClassification::Existing);
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("marker bytes"),
        original_marker
    );
}

#[tokio::test]
async fn invalid_sqlite_is_preserved_without_publishing_an_identity() {
    let fixture = StoreFixture::new();
    let original_database_bytes = b"not a sqlite database";
    std::fs::write(&fixture.paths.database, original_database_bytes).expect("invalid database");

    let error = match fixture.prepare().await {
        Ok(_) => panic!("invalid SQLite must block"),
        Err(error) => error,
    };

    assert!(matches!(error, StoreStartupError::CorruptDatabase { .. }));
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("invalid database remains"),
        original_database_bytes
    );
    assert!(!fixture.paths.environment_id.exists());
}

#[tokio::test]
async fn unrelated_valid_sqlite_is_preserved_without_publishing_an_identity() {
    let fixture = StoreFixture::new();
    let connection = Connection::open(&fixture.paths.database).expect("unrelated database");
    connection
        .execute_batch(
            "CREATE TABLE unrelated_data (value TEXT NOT NULL);\
             INSERT INTO unrelated_data (value) VALUES ('preserve me');",
        )
        .expect("unrelated schema");
    drop(connection);
    let original_database_bytes =
        std::fs::read(&fixture.paths.database).expect("unrelated database bytes");

    let error = match fixture.prepare().await {
        Ok(_) => panic!("unrelated SQLite must block"),
        Err(error) => error,
    };

    assert!(matches!(error, StoreStartupError::UnrecognizedStore { .. }));
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("unrelated database remains"),
        original_database_bytes
    );
    assert!(!fixture.paths.environment_id.exists());
}

#[tokio::test]
async fn empty_unknown_and_mismatched_ledgers_are_preserved_without_marker_publication() {
    for mutation in ["empty-ledger", "unknown-id", "renamed-row"] {
        let fixture = StoreFixture::with_project("Ledger project").await;
        let connection = Connection::open(&fixture.paths.database).expect("ledger database");
        match mutation {
            "empty-ledger" => {
                connection
                    .execute("DELETE FROM effect_sql_migrations", [])
                    .expect("empty ledger");
            }
            "unknown-id" => {
                connection
                    .execute(
                        "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'Unknown')",
                        [],
                    )
                    .expect("unknown ledger row");
            }
            "renamed-row" => {
                connection
                    .execute(
                        "UPDATE effect_sql_migrations SET name = 'Renamed' WHERE migration_id = 1",
                        [],
                    )
                    .expect("renamed ledger row");
            }
            _ => unreachable!(),
        }
        drop(connection);
        let original_database_bytes =
            std::fs::read(&fixture.paths.database).expect("ledger database bytes");

        let error = match fixture.prepare().await {
            Ok(_) => panic!("{mutation} must block"),
            Err(error) => error,
        };

        assert!(
            matches!(error, StoreStartupError::UnrecognizedStore { .. }),
            "unexpected error for {mutation}: {error}"
        );
        assert_eq!(
            std::fs::read(&fixture.paths.database).expect("ledger database remains"),
            original_database_bytes,
            "database changed for {mutation}"
        );
        assert!(!fixture.paths.environment_id.exists());
    }
}

#[tokio::test]
async fn missing_core_table_is_not_accepted_as_a_bibcode_store() {
    let fixture = StoreFixture::with_project("Incomplete project").await;
    let connection = Connection::open(&fixture.paths.database).expect("recognized database");
    connection
        .execute_batch("DROP TABLE projection_projects")
        .expect("remove required table");
    drop(connection);
    let original_database_bytes =
        std::fs::read(&fixture.paths.database).expect("incomplete database bytes");

    let error = match fixture.prepare().await {
        Ok(_) => panic!("missing core table must block"),
        Err(error) => error,
    };

    assert!(matches!(error, StoreStartupError::UnrecognizedStore { .. }));
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("incomplete database remains"),
        original_database_bytes
    );
    assert!(!fixture.paths.environment_id.exists());
}

#[tokio::test]
async fn malformed_marker_and_database_are_preserved_byte_for_byte() {
    let fixture = StoreFixture::with_project("Marker project").await;
    let malformed_marker_bytes = b"definitely-not-one-uuid\n";
    fixture.write_marker_bytes(malformed_marker_bytes);
    let original_database_bytes = std::fs::read(&fixture.paths.database).expect("database bytes");

    let error = match fixture.prepare().await {
        Ok(_) => panic!("malformed marker must block"),
        Err(error) => error,
    };

    assert!(matches!(error, StoreStartupError::MarkerMalformed { .. }));
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("database remains"),
        original_database_bytes
    );
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("marker remains"),
        malformed_marker_bytes
    );
}

#[tokio::test]
async fn malformed_marker_without_database_never_creates_sqlite() {
    let fixture = StoreFixture::new();
    let malformed_marker_bytes = b"broken identity";
    fixture.write_marker_bytes(malformed_marker_bytes);

    let error = match fixture.prepare().await {
        Ok(_) => panic!("malformed marker must block"),
        Err(error) => error,
    };

    assert!(matches!(error, StoreStartupError::MarkerMalformed { .. }));
    assert!(!fixture.paths.database.exists());
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("marker remains"),
        malformed_marker_bytes
    );
}

#[tokio::test]
async fn valid_marker_never_allows_corrupt_or_unrelated_database_adoption() {
    for database_kind in ["corrupt", "unrelated"] {
        let fixture = StoreFixture::new();
        match database_kind {
            "corrupt" => {
                std::fs::write(&fixture.paths.database, b"not a sqlite database")
                    .expect("corrupt database");
            }
            "unrelated" => {
                let connection =
                    Connection::open(&fixture.paths.database).expect("unrelated database");
                connection
                    .execute("CREATE TABLE foreign_catalog (value TEXT)", [])
                    .expect("unrelated schema");
            }
            _ => unreachable!(),
        }
        fixture.write_marker(Uuid::new_v4());
        let database_before =
            std::fs::read(&fixture.paths.database).expect("database fixture bytes");
        let marker_before =
            std::fs::read(&fixture.paths.environment_id).expect("marker fixture bytes");

        let error = fixture
            .prepare()
            .await
            .expect_err("unrecognized database must block despite a valid marker");

        assert!(
            matches!(
                error,
                StoreStartupError::CorruptDatabase { .. }
                    | StoreStartupError::UnrecognizedStore { .. }
            ),
            "unexpected error for {database_kind}: {error}"
        );
        assert_eq!(
            std::fs::read(&fixture.paths.database).expect("database remains"),
            database_before
        );
        assert_eq!(
            std::fs::read(&fixture.paths.environment_id).expect("marker remains"),
            marker_before
        );
    }
}

#[tokio::test]
async fn concurrent_adoption_of_a_recognized_store_converges_on_one_identity() {
    let fixture = StoreFixture::with_project("Concurrent project").await;

    let (first, second) = tokio::join!(fixture.prepare(), fixture.prepare());
    let first = first.expect("first adoption");
    let second = second.expect("second adoption");

    assert_eq!(first.storage_instance_id, second.storage_instance_id);
    assert!(fixture.paths.environment_id.is_file());
}

#[tokio::test]
async fn crash_left_sidecars_restart_with_the_same_store_identity_and_project() {
    let (_root, config, paths) = crashed_store_fixture();
    let marker_before = std::fs::read(&paths.environment_id).expect("crash-store marker");
    assert!(sqlite_sidecar(&paths.database, "-wal").is_file());
    assert!(sqlite_sidecar(&paths.database, "-shm").is_file());

    let prepared = prepare_store(&config)
        .await
        .expect("valid marked crash-store restarts");
    let title = prepared
        .database
        .call(|connection| {
            Ok(connection.query_row(
                "SELECT title FROM projection_projects WHERE project_id = 'crash-project'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })
        .await
        .expect("crash-store project");

    assert_eq!(prepared.classification, StoreClassification::Existing);
    assert_eq!(
        prepared.storage_instance_id.to_string(),
        marker_text(&marker_before)
    );
    assert_eq!(title, "Crash project");
    assert_eq!(
        std::fs::read(&paths.environment_id).expect("marker remains"),
        marker_before
    );
}

#[tokio::test]
async fn crash_left_wal_without_shm_restarts_with_only_sqlite_coordination_recreated() {
    let (_root, config, paths) = crashed_store_fixture();
    let marker_before = std::fs::read(&paths.environment_id).expect("crash-store marker");
    let shared_memory = sqlite_sidecar(&paths.database, "-shm");
    std::fs::remove_file(&shared_memory).expect("remove crash-left SHM fixture");
    let mut expected_entries = directory_entry_names(&paths.state_dir);
    expected_entries.push(std::ffi::OsString::from("state.sqlite-shm"));
    expected_entries.sort();

    let prepared = prepare_store(&config)
        .await
        .expect("valid marked crash-store without SHM restarts");
    let (title, integrity) = prepared
        .database
        .call(|connection| {
            Ok((
                connection.query_row(
                    "SELECT title FROM projection_projects WHERE project_id = 'crash-project'",
                    [],
                    |row| row.get::<_, String>(0),
                )?,
                connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))?,
            ))
        })
        .await
        .expect("crash-store project and integrity");

    assert_eq!(prepared.classification, StoreClassification::Existing);
    assert_eq!(
        prepared.storage_instance_id.to_string(),
        marker_text(&marker_before)
    );
    assert_eq!(title, "Crash project");
    assert_eq!(integrity, "ok");
    assert_eq!(directory_entry_names(&paths.state_dir), expected_entries);
    assert!(
        shared_memory
            .metadata()
            .expect("recreated SQLite SHM")
            .len()
            >= 32 * 1024,
        "SQLite recreates its valid volatile WAL-index coordination file"
    );
    assert_eq!(
        std::fs::read(&paths.environment_id).expect("marker remains"),
        marker_before
    );
}

#[tokio::test]
async fn crash_store_fixture_child() {
    let Some(root) = std::env::var_os(CRASH_STORE_CHILD_ROOT).map(PathBuf::from) else {
        return;
    };
    let ready = PathBuf::from(
        std::env::var_os(CRASH_STORE_CHILD_READY).expect("crash-store child ready path"),
    );
    let mut config = ServerConfig::new(&root);
    let resolved = resolve_data_root(config.data_root_request.clone()).expect("resolve child root");
    config.base_dir = resolved.effective.clone();
    config.resolved_data_root = Some(resolved);
    let paths = StatePaths::from_config(&config);
    std::fs::create_dir_all(&paths.state_dir).expect("child state directory");
    let prepared = prepare_store(&config).await.expect("child store starts");
    prepared
        .database
        .call(|connection| {
            connection.pragma_update(None, "wal_autocheckpoint", 0)?;
            connection.execute(
                "INSERT INTO projection_projects (
                   project_id, title, workspace_root, default_model_selection_json,
                   scripts_json, created_at, updated_at, deleted_at
                 ) VALUES ('crash-project', 'Crash project', '/tmp/crash-project', NULL, '{}',
                           '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', NULL)",
                [],
            )?;
            Ok(())
        })
        .await
        .expect("child project write");
    assert!(sqlite_sidecar(&paths.database, "-wal").is_file());
    assert!(sqlite_sidecar(&paths.database, "-shm").is_file());
    std::fs::write(&ready, b"ready").expect("publish child readiness");
    std::future::pending::<()>().await;
}

#[cfg(unix)]
#[tokio::test]
async fn dangling_marker_entry_with_missing_database_is_not_first_run() {
    let fixture = StoreFixture::new();
    symlink(
        fixture.paths.state_dir.join("missing-marker-target"),
        &fixture.paths.environment_id,
    )
    .expect("dangling marker fixture");
    let marker_before = std::fs::symlink_metadata(&fixture.paths.environment_id)
        .expect("marker entry")
        .file_type();

    fixture
        .prepare()
        .await
        .expect_err("dangling marker must block first run");

    assert!(!fixture.paths.database.exists());
    assert!(marker_before.is_symlink());
    assert!(
        std::fs::symlink_metadata(&fixture.paths.environment_id)
            .expect("marker entry remains")
            .file_type()
            .is_symlink()
    );
}

fn sqlite_sidecar(database: &Path, suffix: &str) -> PathBuf {
    let mut path = database.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn marker_text(bytes: &[u8]) -> String {
    std::str::from_utf8(bytes)
        .expect("UTF-8 marker")
        .trim()
        .to_owned()
}

fn crashed_store_fixture() -> (TempDir, ServerConfig, StatePaths) {
    let root = TempDir::new().expect("temporary crash-store root");
    let ready = root.path().join("crash-store-ready");
    let mut child = Command::new(std::env::current_exe().expect("current test executable"))
        .arg("--exact")
        .arg("crash_store_fixture_child")
        .arg("--nocapture")
        .env(CRASH_STORE_CHILD_ROOT, root.path())
        .env(CRASH_STORE_CHILD_READY, &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn crash-store fixture child");
    wait_for_path(&ready, &mut child);
    child.kill().expect("kill crash-store fixture child");
    child.wait().expect("reap crash-store fixture child");

    let mut config = ServerConfig::new(root.path());
    let resolved = resolve_data_root(config.data_root_request.clone()).expect("resolve root");
    config.base_dir = resolved.effective.clone();
    config.resolved_data_root = Some(resolved);
    let paths = StatePaths::from_config(&config);
    (root, config, paths)
}

fn directory_entry_names(path: &Path) -> Vec<std::ffi::OsString> {
    let mut entries = std::fs::read_dir(path)
        .expect("state directory")
        .map(|entry| entry.expect("state entry").file_name())
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

fn wait_for_path(path: &Path, child: &mut std::process::Child) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        if let Some(status) = child.try_wait().expect("inspect fixture child") {
            panic!("crash-store fixture child exited before ready: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for crash-store fixture child"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
