#[path = "support/hermetic_providers.rs"]
mod hermetic_providers;

use bibcode_server::{
    ServerConfig, ServerRuntime,
    persistence::{
        AutoVacuumMode, BackupTrigger, CompactOptions, CompactReport, CompactTestHook,
        DatabaseStatsUnavailable, PreparedStore, RecoveryError, StatePaths, StorageInstanceId,
        StoreClassification, StoreInspectionStatus, StoreStartupError,
        compact_store_for_integration_test, create_verified_backup, inspect_store,
        inspect_store_for_integration_test, inventory_verified_backups, prepare_store,
        preserve_and_start_empty, restore_backup, run_migrations,
    },
    production::jwt::PersistentJwtCodec,
    resolve_data_root,
};
use reqwest::{Client, StatusCode};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
const CRASH_STORE_CHILD_ROWS: &str = "BIBCODE_CRASH_STORE_CHILD_ROWS";

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

// Use only after backup work has settled and the fixture will never use this database again.
// Dropping the handle only releases its sender; acknowledge actual file closure before
// offline marker changes or snapshots. The detached worker retains only an inert memory DB.
async fn close_prepared_store_for_offline_fixture(prepared: PreparedStore) {
    prepared
        .database
        .call(|connection| {
            let replacement = Connection::open_in_memory()?;
            let file_connection = std::mem::replace(connection, replacement);
            file_connection.close().map_err(|(_, error)| error)?;
            Ok(())
        })
        .await
        .expect("close prepared fixture file connection");
    drop(prepared);
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
    hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root.path()).state_dir(),
        json!({}),
    );
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
    let (_root, config, paths) = crashed_store_fixture(0);
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
    let (_root, config, paths) = crashed_store_fixture(0);
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
    let extra_rows = std::env::var(CRASH_STORE_CHILD_ROWS)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let prepared = prepare_store(&config).await.expect("child store starts");
    prepared
        .database
        .call(move |connection| {
            connection.pragma_update(None, "wal_autocheckpoint", 0)?;
            connection.execute(
                "INSERT INTO projection_projects (
                   project_id, title, workspace_root, default_model_selection_json,
                   scripts_json, created_at, updated_at, deleted_at
                 ) VALUES ('crash-project', 'Crash project', '/tmp/crash-project', NULL, '{}',
                           '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', NULL)",
                [],
            )?;
            // Pages that exist only in the WAL, beyond the physical end of the main file.
            connection.execute(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
                 INSERT INTO projection_projects (
                   project_id, title, workspace_root, default_model_selection_json,
                   scripts_json, created_at, updated_at, deleted_at
                 ) SELECT 'wal-only-' || i, hex(randomblob(500)), '/tmp/wal-only', NULL, '{}',
                          '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', NULL
                   FROM n WHERE ?1 > 0",
                [extra_rows],
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

#[tokio::test]
async fn offline_fixture_teardown_waits_for_owned_work_and_closes_the_file_connection() {
    let fixture = StoreFixture::with_project("Before queued work").await;
    fixture.write_marker(Uuid::new_v4());
    let prepared = fixture.prepare().await.expect("prepare teardown fixture");
    let database = prepared.database.clone();
    let (entered_sender, entered_receiver) = tokio::sync::oneshot::channel();
    let (release_sender, release_receiver) = std::sync::mpsc::channel();
    let held_work = tokio::spawn(async move {
        database
            .call(move |connection| {
                connection.execute(
                    "UPDATE projection_projects SET title = 'After queued work' WHERE project_id = 'protected-project'",
                    [],
                )?;
                entered_sender.send(()).expect("worker entered held work");
                release_receiver
                    .recv()
                    .map_err(|_| bibcode_server::persistence::PersistenceError::WorkerUnavailable)?;
                Ok(())
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), entered_receiver)
        .await
        .expect("worker admission deadline")
        .expect("worker entered held work");
    assert!(sqlite_sidecar(&fixture.paths.database, "-wal").is_file());

    tokio::time::pause();
    let teardown = close_prepared_store_for_offline_fixture(prepared);
    tokio::pin!(teardown);
    assert!(futures_util::poll!(teardown.as_mut()).is_pending());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(
        futures_util::poll!(teardown.as_mut()).is_pending(),
        "offline teardown must await the held file connection instead of a delay"
    );
    tokio::time::resume();

    release_sender
        .send(())
        .expect("release owned database work");
    tokio::time::timeout(Duration::from_secs(5), held_work)
        .await
        .expect("owned work completion deadline")
        .expect("owned database task joins")
        .expect("owned database work completes");
    tokio::time::timeout(Duration::from_secs(5), teardown)
        .await
        .expect("file connection close deadline");
    assert!(!sqlite_sidecar(&fixture.paths.database, "-wal").exists());
    assert!(!sqlite_sidecar(&fixture.paths.database, "-shm").exists());
    let connection = Connection::open(&fixture.paths.database).expect("closed fixture database");
    let title: String = connection
        .query_row(
            "SELECT title FROM projection_projects WHERE project_id = 'protected-project'",
            [],
            |row| row.get(0),
        )
        .expect("owned work persisted before offline teardown");
    assert_eq!(title, "After queued work");
}

#[tokio::test]
async fn recovery_restore_preserves_the_live_store_before_installing_a_verified_backup() {
    let fixture = StoreFixture::with_project("Before restore").await;
    let storage_instance_id = Uuid::new_v4();
    fixture.write_marker(storage_instance_id);
    let prepared = fixture.prepare().await.expect("prepare recovery fixture");
    let backup = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("create verified recovery generation");
    prepared
        .database
        .call(|connection| {
            connection.execute(
                "UPDATE projection_projects SET title = 'After backup' WHERE project_id = 'protected-project'",
                [],
            )?;
            Ok(())
        })
        .await
        .expect("mutate live project after backup");
    close_prepared_store_for_offline_fixture(prepared).await;

    let result = restore_backup(
        fixture
            .config
            .resolved_data_root
            .as_ref()
            .expect("resolved recovery root"),
        backup.manifest.backup_id,
    )
    .await
    .expect("restore verified generation");

    let restored = Connection::open(&fixture.paths.database).expect("restored database");
    let restored_title: String = restored
        .query_row(
            "SELECT title FROM projection_projects WHERE project_id = 'protected-project'",
            [],
            |row| row.get(0),
        )
        .expect("restored project title");
    assert_eq!(restored_title, "Before restore");
    assert_eq!(
        std::fs::read_to_string(&fixture.paths.environment_id)
            .expect("restored marker")
            .trim(),
        storage_instance_id.to_string()
    );

    let preserved_database = result.preserved_directory.join("state.sqlite");
    let preserved = Connection::open(preserved_database).expect("preserved live database");
    let preserved_title: String = preserved
        .query_row(
            "SELECT title FROM projection_projects WHERE project_id = 'protected-project'",
            [],
            |row| row.get(0),
        )
        .expect("preserved live project title");
    assert_eq!(preserved_title, "After backup");
}

#[tokio::test]
async fn recovery_restore_rejects_a_backup_from_a_different_known_storage_identity() {
    let fixture = StoreFixture::with_project("Original project").await;
    fixture.write_marker(Uuid::new_v4());
    let prepared = fixture.prepare().await.expect("prepare recovery fixture");
    let backup = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("create verified recovery generation");
    close_prepared_store_for_offline_fixture(prepared).await;
    fixture.write_marker(Uuid::new_v4());
    let database_before = std::fs::read(&fixture.paths.database).expect("live database bytes");
    let marker_before = std::fs::read(&fixture.paths.environment_id).expect("live marker bytes");
    let entries_before = directory_entry_names(&fixture.paths.state_dir);

    let error = restore_backup(
        fixture
            .config
            .resolved_data_root
            .as_ref()
            .expect("resolved recovery root"),
        backup.manifest.backup_id,
    )
    .await
    .expect_err("different known storage identity must block restore");

    assert!(matches!(error, RecoveryError::StorageIdentityMismatch));
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("live database remains"),
        database_before
    );
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("live marker remains"),
        marker_before
    );
    assert_eq!(
        directory_entry_names(&fixture.paths.state_dir),
        entries_before
    );
    assert!(!fixture.paths.recovery_journal().exists());
}

#[tokio::test]
async fn recovery_restore_rejects_a_tampered_manifest_without_mutating_the_live_store() {
    let fixture = StoreFixture::with_project("Original project").await;
    fixture.write_marker(Uuid::new_v4());
    let prepared = fixture.prepare().await.expect("prepare recovery fixture");
    let backup = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("create verified recovery generation");
    close_prepared_store_for_offline_fixture(prepared).await;
    let mut manifest: Value = serde_json::from_slice(
        &std::fs::read(&backup.manifest_path).expect("backup manifest bytes"),
    )
    .expect("backup manifest JSON");
    manifest["sha256"] = Value::String("0".repeat(64));
    std::fs::write(
        &backup.manifest_path,
        serde_json::to_vec_pretty(&manifest).expect("tampered manifest JSON"),
    )
    .expect("tamper backup manifest");
    let database_before = std::fs::read(&fixture.paths.database).expect("live database bytes");
    let marker_before = std::fs::read(&fixture.paths.environment_id).expect("live marker bytes");
    let entries_before = directory_entry_names(&fixture.paths.state_dir);

    let error = restore_backup(
        fixture
            .config
            .resolved_data_root
            .as_ref()
            .expect("resolved recovery root"),
        backup.manifest.backup_id,
    )
    .await
    .expect_err("tampered backup must block restore");

    assert!(matches!(
        error,
        RecoveryError::Backup(bibcode_server::persistence::BackupError::Verification(_))
    ));
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("live database remains"),
        database_before
    );
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("live marker remains"),
        marker_before
    );
    assert_eq!(
        directory_entry_names(&fixture.paths.state_dir),
        entries_before
    );
    assert!(!fixture.paths.recovery_journal().exists());
}

#[tokio::test]
async fn recovery_restore_rejects_a_backup_from_the_other_state_kind_without_mutating_live_data() {
    let fixture = StoreFixture::with_project("Userdata project").await;
    let production_id = Uuid::new_v4();
    fixture.write_marker(production_id);
    let production = fixture.prepare().await.expect("prepare userdata store");
    drop(production);

    let dev_config = fixture
        .config
        .clone()
        .with_dev_url("http://127.0.0.1:5173".parse().expect("development URL"));
    let dev_paths = StatePaths::from_config(&dev_config);
    std::fs::create_dir_all(&dev_paths.state_dir).expect("development state directory");
    let mut dev_connection = Connection::open(&dev_paths.database).expect("development database");
    run_migrations(&mut dev_connection, None).expect("development migrations");
    drop(dev_connection);
    std::fs::write(&dev_paths.environment_id, format!("{}\n", Uuid::new_v4()))
        .expect("development marker");
    let dev = prepare_store(&dev_config)
        .await
        .expect("prepare development store");
    let dev_backup = create_verified_backup(
        &dev.database,
        &dev,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("create development backup");
    drop(dev);

    let database_before = std::fs::read(&fixture.paths.database).expect("userdata database bytes");
    let marker_before =
        std::fs::read(&fixture.paths.environment_id).expect("userdata marker bytes");

    let error = restore_backup(
        fixture
            .config
            .resolved_data_root
            .as_ref()
            .expect("resolved userdata root"),
        dev_backup.manifest.backup_id,
    )
    .await
    .expect_err("development backup must not restore into userdata");

    assert!(matches!(error, RecoveryError::BackupNotFound));
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("userdata database remains"),
        database_before
    );
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("userdata marker remains"),
        marker_before
    );
    assert!(!fixture.paths.recovery_journal().exists());
}

#[tokio::test]
async fn recovery_restore_rejects_a_checksum_valid_non_sqlite_backup_without_mutating_live_data() {
    let fixture = StoreFixture::with_project("Original project").await;
    fixture.write_marker(Uuid::new_v4());
    let prepared = fixture.prepare().await.expect("prepare recovery fixture");
    let backup = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("create verified recovery generation");
    drop(prepared);

    let invalid_database = b"not a SQLite database";
    std::fs::write(&backup.database, invalid_database).expect("replace backup database");
    let mut manifest: Value = serde_json::from_slice(
        &std::fs::read(&backup.manifest_path).expect("backup manifest bytes"),
    )
    .expect("backup manifest JSON");
    manifest["databaseSizeBytes"] = Value::from(invalid_database.len() as u64);
    manifest["sha256"] = Value::String(
        Sha256::digest(invalid_database)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    );
    std::fs::write(
        &backup.manifest_path,
        serde_json::to_vec_pretty(&manifest).expect("refingerprinted manifest JSON"),
    )
    .expect("rewrite backup manifest");
    let database_before = std::fs::read(&fixture.paths.database).expect("live database bytes");
    let marker_before = std::fs::read(&fixture.paths.environment_id).expect("live marker bytes");

    let error = restore_backup(
        fixture
            .config
            .resolved_data_root
            .as_ref()
            .expect("resolved recovery root"),
        backup.manifest.backup_id,
    )
    .await
    .expect_err("checksum-valid non-SQLite backup must block restore");

    assert!(matches!(
        error,
        RecoveryError::Backup(bibcode_server::persistence::BackupError::Verification(_))
    ));
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("live database remains"),
        database_before
    );
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("live marker remains"),
        marker_before
    );
    assert!(!fixture.paths.recovery_journal().exists());
}

#[tokio::test]
async fn recovery_restore_preserves_a_malformed_marker_and_installs_the_verified_identity() {
    let fixture = StoreFixture::with_project("Before restore").await;
    let storage_instance_id = Uuid::new_v4();
    fixture.write_marker(storage_instance_id);
    let prepared = fixture.prepare().await.expect("prepare recovery fixture");
    let backup = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("create verified recovery generation");
    close_prepared_store_for_offline_fixture(prepared).await;
    let malformed = b"not-a-storage-uuid\n";
    fixture.write_marker_bytes(malformed);

    let result = restore_backup(
        fixture
            .config
            .resolved_data_root
            .as_ref()
            .expect("resolved recovery root"),
        backup.manifest.backup_id,
    )
    .await
    .expect("explicit verified restore repairs malformed marker");

    assert_eq!(
        std::fs::read(result.preserved_directory.join("environment-id"))
            .expect("malformed marker was preserved"),
        malformed
    );
    assert_eq!(
        std::fs::read_to_string(&fixture.paths.environment_id)
            .expect("verified marker installed")
            .trim(),
        storage_instance_id.to_string()
    );
}

#[tokio::test]
async fn recovery_start_empty_preserves_crash_left_sqlite_files_before_new_identity_creation() {
    let (_root, config, paths) = crashed_store_fixture(0);
    let old_marker = std::fs::read_to_string(&paths.environment_id)
        .expect("crash-left marker")
        .trim()
        .to_owned();
    assert!(sqlite_sidecar(&paths.database, "-wal").is_file());
    assert!(sqlite_sidecar(&paths.database, "-shm").is_file());

    let result = preserve_and_start_empty(
        config
            .resolved_data_root
            .as_ref()
            .expect("resolved recovery root"),
    )
    .await
    .expect("preserve crash-left store before start-empty");

    assert!(!paths.database.exists());
    assert!(!sqlite_sidecar(&paths.database, "-wal").exists());
    assert!(!sqlite_sidecar(&paths.database, "-shm").exists());
    assert!(!paths.environment_id.exists());
    for name in [
        "state.sqlite",
        "state.sqlite-wal",
        "state.sqlite-shm",
        "environment-id",
    ] {
        assert!(result.preserved_directory.join(name).is_file(), "{name}");
    }
    let preserved = Connection::open(result.preserved_directory.join("state.sqlite"))
        .expect("open preserved crash-left store");
    let preserved_title: String = preserved
        .query_row(
            "SELECT title FROM projection_projects WHERE project_id = 'crash-project'",
            [],
            |row| row.get(0),
        )
        .expect("preserved WAL project");
    assert_eq!(preserved_title, "Crash project");
    drop(preserved);

    let prepared = prepare_store(&config)
        .await
        .expect("normal startup creates explicit empty store");
    assert_eq!(prepared.classification, StoreClassification::FirstRun);
    assert_ne!(prepared.storage_instance_id.to_string(), old_marker);
}

#[tokio::test]
async fn recovery_incomplete_journal_never_becomes_a_first_run_store() {
    let fixture = StoreFixture::new();
    let journal_bytes = br#"{"operationId":"interrupted"}"#;
    std::fs::write(fixture.paths.recovery_journal(), journal_bytes)
        .expect("interrupted recovery journal");

    let error = fixture
        .prepare()
        .await
        .expect_err("incomplete recovery must block first-run creation");

    assert!(matches!(
        error,
        StoreStartupError::RecoveryIncomplete { .. }
    ));
    assert!(!fixture.paths.database.exists());
    assert!(!fixture.paths.environment_id.exists());
    assert_eq!(
        std::fs::read(fixture.paths.recovery_journal()).expect("journal remains"),
        journal_bytes
    );
}

#[tokio::test]
async fn recovery_restore_with_an_existing_journal_performs_no_additional_filesystem_writes() {
    let fixture = StoreFixture::with_project("Journal-protected project").await;
    fixture.write_marker(Uuid::new_v4());
    let prepared = fixture.prepare().await.expect("prepare recovery fixture");
    let backup = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("create verified recovery generation");
    drop(prepared);
    std::fs::write(fixture.paths.runtime_lock(), b"").expect("existing runtime lock");
    std::fs::write(fixture.paths.recovery_journal(), b"existing recovery\n")
        .expect("existing recovery journal");
    let entries_before = directory_entry_names(&fixture.paths.base_dir);
    let database_before = std::fs::read(&fixture.paths.database).expect("live database bytes");
    let marker_before = std::fs::read(&fixture.paths.environment_id).expect("live marker bytes");

    let error = restore_backup(
        fixture
            .config
            .resolved_data_root
            .as_ref()
            .expect("resolved recovery root"),
        backup.manifest.backup_id,
    )
    .await
    .expect_err("existing journal must block a second recovery");

    assert!(matches!(error, RecoveryError::RecoveryInProgress { .. }));
    assert_eq!(
        directory_entry_names(&fixture.paths.base_dir),
        entries_before
    );
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("live database remains"),
        database_before
    );
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("live marker remains"),
        marker_before
    );
}

#[tokio::test]
async fn recovery_incomplete_staging_never_becomes_a_first_run_store() {
    let fixture = StoreFixture::new();
    let staging = fixture.paths.recovery_staging_dir(Uuid::new_v4());
    std::fs::create_dir(&staging).expect("interrupted recovery staging directory");
    std::fs::write(staging.join("state.sqlite"), b"partial")
        .expect("interrupted recovery staging file");

    let error = fixture
        .prepare()
        .await
        .expect_err("incomplete recovery staging must block first-run creation");

    assert!(matches!(
        error,
        StoreStartupError::RecoveryIncomplete { path } if path == staging
    ));
    assert!(!fixture.paths.database.exists());
    assert!(!fixture.paths.environment_id.exists());
    assert_eq!(
        std::fs::read(staging.join("state.sqlite")).expect("staging remains"),
        b"partial"
    );
}

#[tokio::test]
async fn recovery_refuses_to_mutate_a_store_owned_by_a_running_server() {
    let root = TempDir::new().expect("temporary active-store root");
    hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root.path()).state_dir(),
        json!({}),
    );
    let handle = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("start active store owner");
    let resolved = handle.data_root().clone();
    let paths = {
        let mut config = ServerConfig::new(&resolved.effective);
        config.base_dir.clone_from(&resolved.effective);
        config.resolved_data_root = Some(resolved.clone());
        StatePaths::from_config(&config)
    };
    let database_before = std::fs::read(&paths.database).expect("active database bytes");
    let marker_before = std::fs::read(&paths.environment_id).expect("active marker bytes");

    let error = preserve_and_start_empty(&resolved)
        .await
        .expect_err("running store must block offline recovery");

    assert!(matches!(error, RecoveryError::StoreRunning));
    assert_eq!(
        std::fs::read(&paths.database).expect("active database remains"),
        database_before
    );
    assert_eq!(
        std::fs::read(&paths.environment_id).expect("active marker remains"),
        marker_before
    );
    assert!(!paths.recovery_journal().exists());
    handle.shutdown();
    handle.join().await.expect("active store owner stops");
}

#[tokio::test]
async fn recovery_inspection_reports_verified_store_state_without_mutating_it() {
    let fixture = StoreFixture::with_project("Inspectable project").await;
    let connection = Connection::open(&fixture.paths.database).expect("fixture database");
    connection
        .execute_batch(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
             INSERT INTO projection_projects (
               project_id, title, workspace_root, default_model_selection_json,
               scripts_json, created_at, updated_at, deleted_at
             ) SELECT 'deleted-' || i, hex(randomblob(400)), '/tmp/deleted', NULL, '{}',
                      '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z', NULL FROM n;
             DELETE FROM projection_projects WHERE project_id LIKE 'deleted-%';",
        )
        .expect("rows that leave free pages");
    drop(connection);
    let storage_instance_id = Uuid::new_v4();
    fixture.write_marker(storage_instance_id);
    let prepared = fixture.prepare().await.expect("prepare inspection fixture");
    let backup = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("create verified inspection generation");
    close_prepared_store_for_offline_fixture(prepared).await;
    let database_before = std::fs::read(&fixture.paths.database).expect("database bytes");
    let marker_before = std::fs::read(&fixture.paths.environment_id).expect("marker bytes");
    let entries_before = directory_entry_names(&fixture.paths.state_dir);
    let listing_before = base_listing(&fixture.paths.base_dir);
    assert!(!fixture.paths.runtime_lock().exists());
    let (page_size, page_count, freelist_count, auto_vacuum) =
        immutable_stats(&fixture.paths.database);
    assert!(freelist_count > 0, "the fixture has free pages");

    let inspection = inspect_store(
        fixture
            .config
            .resolved_data_root
            .as_ref()
            .expect("resolved inspection root"),
    )
    .await
    .expect("inspect store");

    assert_eq!(inspection.classification, StoreInspectionStatus::Existing);
    let database = inspection.database.as_ref().expect("database space");
    assert_eq!(database.file_bytes, database_before.len() as u64);
    assert_eq!(database.wal_bytes, 0);
    assert_eq!(database.shm_bytes, 0);
    assert_eq!(database.page_size, Some(page_size));
    assert_eq!(database.page_count, Some(page_count));
    assert_eq!(database.freelist_count, Some(freelist_count));
    assert_eq!(database.reclaimable_bytes, Some(freelist_count * page_size));
    assert_eq!(auto_vacuum, 0);
    assert_eq!(database.auto_vacuum, Some(AutoVacuumMode::None));
    assert_eq!(database.database_stats_unavailable, None);
    assert_eq!(
        inspection
            .storage_instance_id
            .map(|value| value.to_string()),
        Some(storage_instance_id.to_string())
    );
    assert_eq!(inspection.backups.len(), 1);
    assert_eq!(
        inspection.backups[0].manifest.backup_id,
        backup.manifest.backup_id
    );
    assert_eq!(
        inspection.requested_root,
        fixture
            .config
            .resolved_data_root
            .as_ref()
            .expect("resolved root")
            .requested
    );
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("database remains"),
        database_before
    );
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("marker remains"),
        marker_before
    );
    assert_eq!(
        directory_entry_names(&fixture.paths.state_dir),
        entries_before
    );
    assert_eq!(base_listing(&fixture.paths.base_dir), listing_before);
    assert!(!fixture.paths.runtime_lock().exists());
}

#[tokio::test]
async fn recovery_inspection_reports_an_absent_root_as_first_run_without_creating_it() {
    let parent = TempDir::new().expect("temporary parent");
    let missing_root = parent.path().join("missing-bibcode-root");
    let config = ServerConfig::new(&missing_root);
    let root = resolve_data_root(config.data_root_request.clone()).expect("resolve missing root");

    let inspection = inspect_store(&root)
        .await
        .expect("inspect absent project-data root");

    assert_eq!(inspection.classification, StoreInspectionStatus::FirstRun);
    assert!(inspection.storage_instance_id.is_none());
    assert!(inspection.backups.is_empty());
    assert!(inspection.backup_issues.is_empty());
    assert!(
        !missing_root.exists(),
        "inspection must not create the root"
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

fn crashed_store_fixture(extra_rows: u32) -> (TempDir, ServerConfig, StatePaths) {
    let root = TempDir::new().expect("temporary crash-store root");
    let ready = root.path().join("crash-store-ready");
    let mut child = Command::new(std::env::current_exe().expect("current test executable"))
        .arg("--exact")
        .arg("crash_store_fixture_child")
        .arg("--nocapture")
        .env(CRASH_STORE_CHILD_ROOT, root.path())
        .env(CRASH_STORE_CHILD_READY, &ready)
        .env(CRASH_STORE_CHILD_ROWS, extra_rows.to_string())
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

// ---- Storage space reporting and compaction (issue 230) ----

const TS: &str = "2026-11-01T00:00:00Z";

fn root_of(config: &ServerConfig) -> &bibcode_server::ResolvedDataRoot {
    config
        .resolved_data_root
        .as_ref()
        .expect("resolved data root")
}

async fn compact(
    config: &ServerConfig,
    dry_run: bool,
    hook: CompactTestHook,
) -> Result<CompactReport, RecoveryError> {
    compact_store_for_integration_test(
        root_of(config),
        CompactOptions {
            dry_run,
            ..CompactOptions::default()
        },
        hook,
    )
    .await
}

/// Enough free space for every fixture, on split volumes.
const PLENTY: CompactTestHook = CompactTestHook::FreeSpace {
    store: u64::MAX / 4,
    temp: u64::MAX / 4,
    same_volume: false,
};

/// A marked WAL-mode store with a project, a thread, messages, and deleted rows that left
/// free pages; offline and without sidecars or lock files.
fn offline_store_with_free_pages() -> StoreFixture {
    let fixture = StoreFixture::new();
    let mut connection = Connection::open(&fixture.paths.database).expect("fixture database");
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .expect("fixture WAL mode");
    run_migrations(&mut connection, None).expect("fixture migrations");
    connection
        .execute_batch(&format!(
            "INSERT INTO projection_projects (
               project_id, title, workspace_root, default_model_selection_json,
               scripts_json, created_at, updated_at, deleted_at
             ) VALUES ('protected-project', 'Compacted project', '/tmp/protected-project',
                       NULL, '{{}}', '{TS}', '{TS}', NULL);
             INSERT INTO projection_threads (
               thread_id, project_id, title, model_selection_json, runtime_mode,
               interaction_mode, created_at, updated_at
             ) VALUES ('thread-1', 'protected-project', 'Kept thread', '{{}}', 'full-access',
                       'default', '{TS}', '{TS}');
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
             INSERT INTO projection_thread_messages (
               message_id, thread_id, role, text, is_streaming, created_at, updated_at
             ) SELECT 'message-' || i, 'thread-1', 'user', 'Message ' || i, 0, '{TS}', '{TS}'
               FROM n;
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
             INSERT INTO projection_projects (
               project_id, title, workspace_root, default_model_selection_json,
               scripts_json, created_at, updated_at, deleted_at
             ) SELECT 'bulk-' || i, hex(randomblob(400)), '/tmp/bulk', NULL, '{{}}',
                      '{TS}', '{TS}', NULL FROM n;
             DELETE FROM projection_projects WHERE project_id LIKE 'bulk-%';"
        ))
        .expect("fixture rows");
    connection.close().expect("close fixture database");
    assert!(!sqlite_sidecar(&fixture.paths.database, "-wal").exists());
    assert!(!sqlite_sidecar(&fixture.paths.database, "-shm").exists());
    fixture.write_marker(Uuid::new_v4());
    fixture
}

/// A store just restored from a verified backup: `journal_mode = DELETE`, no sidecars.
async fn restored_store_fixture() -> StoreFixture {
    let fixture = StoreFixture::with_project("Restored project").await;
    fixture.write_marker(Uuid::new_v4());
    let prepared = fixture.prepare().await.expect("prepare restore fixture");
    let backup = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("restore fixture backup");
    close_prepared_store_for_offline_fixture(prepared).await;
    restore_backup(root_of(&fixture.config), backup.manifest.backup_id)
        .await
        .expect("restore fixture");
    assert_eq!(journal_header_versions(&fixture.paths.database), (1, 1));
    assert!(!sqlite_sidecar(&fixture.paths.database, "-wal").exists());
    fixture
}

/// `state.sqlite`, `-wal`, `-shm` and `-journal` bytes; `None` for an absent file.
fn sqlite_bytes(database: &Path) -> Vec<Option<Vec<u8>>> {
    ["", "-wal", "-shm", "-journal"]
        .into_iter()
        .map(|suffix| std::fs::read(sqlite_sidecar(database, suffix)).ok())
        .collect()
}

/// Header bytes 18 and 19: 1 for rollback-journal mode, 2 for WAL.
fn journal_header_versions(database: &Path) -> (u8, u8) {
    let header = std::fs::read(database).expect("database header");
    (header[18], header[19])
}

/// Every entry under `base`, relative and sorted: the state directory, `backups/` and both
/// lock files.
fn base_listing(base: &Path) -> Vec<PathBuf> {
    fn walk(root: &Path, directory: &Path, entries: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(directory).expect("listing directory") {
            let entry = entry.expect("listing entry");
            let path = entry.path();
            entries.push(
                path.strip_prefix(root)
                    .expect("relative entry")
                    .to_path_buf(),
            );
            if entry.file_type().expect("entry type").is_dir() {
                walk(root, &path, entries);
            }
        }
    }
    let mut entries = Vec::new();
    walk(base, base, &mut entries);
    entries.sort();
    entries
}

fn backup_entries(paths: &StatePaths) -> Vec<PathBuf> {
    if paths.backups_dir.exists() {
        base_listing(&paths.backups_dir)
    } else {
        Vec::new()
    }
}

/// `(page_size, page_count, freelist_count, auto_vacuum)` through an `immutable=1` read.
fn immutable_stats(database: &Path) -> (u64, u64, u64, i64) {
    let mut uri = url::Url::from_file_path(database).expect("database URI");
    uri.query_pairs_mut().append_pair("immutable", "1");
    let connection = Connection::open_with_flags(
        uri.as_str(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .expect("immutable database");
    let read = |pragma: &str| {
        connection
            .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get::<_, i64>(0))
            .expect("pragma")
    };
    (
        u64::try_from(read("page_size")).expect("page size"),
        u64::try_from(read("page_count")).expect("page count"),
        u64::try_from(read("freelist_count")).expect("freelist"),
        read("auto_vacuum"),
    )
}

type Rows = Vec<Vec<rusqlite::types::Value>>;

/// Every project, thread and message row.
fn projection_snapshot(connection: &Connection) -> Vec<Rows> {
    [
        "projection_projects",
        "projection_threads",
        "projection_thread_messages",
    ]
    .into_iter()
    .map(|table| {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .expect("snapshot statement");
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns)
                    .map(|index| row.get::<_, rusqlite::types::Value>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .expect("snapshot rows")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("snapshot values")
    })
    .collect()
}

fn snapshot_file(database: &Path) -> Vec<Rows> {
    projection_snapshot(&Connection::open(database).expect("snapshot database"))
}

fn crash_project_present(database: &Path) -> bool {
    Connection::open(database)
        .expect("database with crash rows")
        .query_row(
            "SELECT COUNT(*) FROM projection_projects WHERE project_id = 'crash-project'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .expect("crash project count")
        == 1
}

fn storage_id(paths: &StatePaths) -> StorageInstanceId {
    StorageInstanceId::from_uuid(
        Uuid::parse_str(
            marker_text(&std::fs::read(&paths.environment_id).expect("marker")).as_str(),
        )
        .expect("marker UUID"),
    )
}

fn hold_runtime_lock_shared(paths: &StatePaths) -> std::fs::File {
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(paths.runtime_lock())
        .expect("runtime lock file");
    lock.try_lock_shared().expect("shared runtime lock");
    lock
}

async fn start_server_on(config: &ServerConfig) -> bibcode_server::ServerHandle {
    hermetic_providers::write_hermetic_settings(&config.state_dir(), json!({}));
    ServerRuntime::start(ServerConfig::new(&root_of(config).effective).with_bind("127.0.0.1", 0))
        .await
        .expect("start store owner")
}

#[tokio::test]
async fn inspection_while_a_server_owns_the_store_reports_sizes_and_store_running() {
    let root = TempDir::new().expect("temporary active-store root");
    hermetic_providers::write_hermetic_settings(
        &ServerConfig::new(root.path()).state_dir(),
        json!({}),
    );
    let handle = ServerRuntime::start(ServerConfig::new(root.path()).with_bind("127.0.0.1", 0))
        .await
        .expect("start active store owner");
    let resolved = handle.data_root().clone();
    let mut config = ServerConfig::new(&resolved.effective);
    config.base_dir.clone_from(&resolved.effective);
    config.resolved_data_root = Some(resolved.clone());
    let paths = StatePaths::from_config(&config);
    let database_before = std::fs::read(&paths.database).expect("active database bytes");
    let marker_before = std::fs::read(&paths.environment_id).expect("active marker bytes");
    let listing_before = base_listing(&paths.base_dir);

    let inspection = inspect_store(&resolved).await.expect("inspect owned store");

    let database = inspection.database.expect("database sizes");
    assert_eq!(inspection.classification, StoreInspectionStatus::Existing);
    assert!(database.file_bytes > 0);
    assert_eq!(database.page_count, None);
    assert_eq!(database.freelist_count, None);
    assert_eq!(database.auto_vacuum, None);
    assert_eq!(
        database.database_stats_unavailable,
        Some(DatabaseStatsUnavailable::StoreRunning)
    );
    assert_eq!(
        std::fs::read(&paths.database).expect("database"),
        database_before
    );
    assert_eq!(
        std::fs::read(&paths.environment_id).expect("marker"),
        marker_before
    );
    assert_eq!(base_listing(&paths.base_dir), listing_before);
    handle.shutdown();
    handle.join().await.expect("active store owner stops");
}

#[tokio::test]
async fn inspection_of_an_owned_store_never_opens_sqlite() {
    let (_root, config, paths) = crashed_store_fixture(0);
    std::fs::remove_file(sqlite_sidecar(&paths.database, "-shm")).expect("remove SHM");
    let _owner = hold_runtime_lock_shared(&paths);
    let listing_before = base_listing(&paths.base_dir);
    let bytes_before = sqlite_bytes(&paths.database);

    let inspection = inspect_store(root_of(&config))
        .await
        .expect("inspect owned store");

    assert_eq!(inspection.classification, StoreInspectionStatus::Existing);
    assert_eq!(
        inspection
            .database
            .expect("database sizes")
            .database_stats_unavailable,
        Some(DatabaseStatsUnavailable::StoreRunning)
    );
    assert!(!sqlite_sidecar(&paths.database, "-shm").exists());
    assert_eq!(sqlite_bytes(&paths.database), bytes_before);
    assert_eq!(base_listing(&paths.base_dir), listing_before);
}

#[tokio::test]
async fn inspection_of_an_offline_store_with_one_sidecar_creates_nothing() {
    for with_lock_file in [true, false] {
        let (_root, config, paths) = crashed_store_fixture(0);
        std::fs::remove_file(sqlite_sidecar(&paths.database, "-shm")).expect("remove SHM");
        if with_lock_file {
            std::fs::write(paths.runtime_lock(), b"").expect("existing runtime lock");
        }
        let listing_before = base_listing(&paths.base_dir);
        let bytes_before = sqlite_bytes(&paths.database);

        let inspection = inspect_store(root_of(&config))
            .await
            .expect("inspect store");

        assert_eq!(
            inspection.classification,
            StoreInspectionStatus::UnsafeDatabaseState,
            "lock file {with_lock_file}"
        );
        assert!(
            inspection
                .issue
                .as_deref()
                .is_some_and(|issue| issue.contains("bibcode storage compact")),
            "{:?}",
            inspection.issue
        );
        assert_eq!(
            inspection
                .database
                .expect("database sizes")
                .database_stats_unavailable,
            Some(DatabaseStatsUnavailable::UncheckpointedWal)
        );
        assert_eq!(sqlite_bytes(&paths.database), bytes_before);
        assert_eq!(base_listing(&paths.base_dir), listing_before);
    }
}

#[tokio::test]
async fn inspection_releases_the_runtime_lock_before_the_backup_inventory() {
    let fixture = StoreFixture::with_project("Inventoried project").await;
    fixture.write_marker(Uuid::new_v4());
    let prepared = fixture.prepare().await.expect("prepare inventory fixture");
    create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("inventory fixture backup");
    close_prepared_store_for_offline_fixture(prepared).await;
    std::fs::write(fixture.paths.runtime_lock(), b"").expect("existing runtime lock");
    hermetic_providers::write_hermetic_settings(&fixture.config.state_dir(), json!({}));
    let lock_path = fixture.paths.runtime_lock();
    let server_root = root_of(&fixture.config).effective.clone();
    let mut server = None;

    let inspection = inspect_store_for_integration_test(root_of(&fixture.config), || {
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("runtime lock file");
        lock.try_lock_shared()
            .expect("a starting server takes the shared lock while the inventory runs");
        lock.unlock().expect("release probe lock");
        server = Some(tokio::spawn(ServerRuntime::start(
            ServerConfig::new(&server_root).with_bind("127.0.0.1", 0),
        )));
    })
    .await
    .expect("inspect store");

    assert_eq!(inspection.classification, StoreInspectionStatus::Existing);
    assert_eq!(inspection.backups.len(), 1);
    let handle = tokio::time::timeout(
        Duration::from_secs(60),
        server.expect("server start spawned"),
    )
    .await
    .expect("server start deadline")
    .expect("server task joins")
    .expect("server starts beside the inventory");
    handle.shutdown();
    handle.join().await.expect("server stops");
}

#[tokio::test]
async fn first_run_store_reports_incremental_auto_vacuum_and_a_fixture_keeps_none() {
    let first_run = StoreFixture::new();
    let prepared = first_run.prepare().await.expect("first run");
    assert_eq!(prepared.classification, StoreClassification::FirstRun);
    close_prepared_store_for_offline_fixture(prepared).await;
    let inspection = inspect_store(root_of(&first_run.config))
        .await
        .expect("inspect first-run store");
    assert_eq!(
        inspection.database.expect("database").auto_vacuum,
        Some(AutoVacuumMode::Incremental)
    );

    let fixture = offline_store_with_free_pages();
    let inspection = inspect_store(root_of(&fixture.config))
        .await
        .expect("inspect fixture store");
    assert_eq!(
        inspection.database.expect("database").auto_vacuum,
        Some(AutoVacuumMode::None)
    );
    let prepared = fixture.prepare().await.expect("restart keeps the mode");
    close_prepared_store_for_offline_fixture(prepared).await;
    let inspection = inspect_store(root_of(&fixture.config))
        .await
        .expect("inspect restarted fixture store");
    assert_eq!(
        inspection.database.expect("database").auto_vacuum,
        Some(AutoVacuumMode::None),
        "an existing store keeps NONE until it is compacted"
    );

    compact(&fixture.config, false, PLENTY)
        .await
        .expect("compact fixture store");
    let inspection = inspect_store(root_of(&fixture.config))
        .await
        .expect("inspect compacted store");
    assert_eq!(
        inspection.database.expect("database").auto_vacuum,
        Some(AutoVacuumMode::Incremental)
    );
}

#[tokio::test]
async fn compact_dry_run_reports_reclaim_and_changes_nothing() {
    let fixture = offline_store_with_free_pages();
    assert!(!fixture.paths.runtime_lock().exists());
    let (page_size, _, freelist_count, _) = immutable_stats(&fixture.paths.database);
    assert!(freelist_count > 0);
    let bytes_before = sqlite_bytes(&fixture.paths.database);
    let marker_before = std::fs::read(&fixture.paths.environment_id).expect("marker");
    let listing_before = base_listing(&fixture.paths.base_dir);

    let report = compact(&fixture.config, true, PLENTY)
        .await
        .expect("dry run");

    assert!(report.dry_run);
    assert_eq!(report.plan.sqlite_lock, "not-checked");
    assert_eq!(report.backup_id, None);
    let expected = freelist_count * page_size;
    let estimate = report
        .plan
        .estimated_reclaim_bytes
        .expect("reclaim estimate");
    assert!(
        estimate.abs_diff(expected) * 100 <= expected,
        "estimate {estimate} vs {expected}"
    );
    assert_eq!(report.before.freelist_count, Some(freelist_count));
    assert_eq!(sqlite_bytes(&fixture.paths.database), bytes_before);
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("marker"),
        marker_before
    );
    assert_eq!(base_listing(&fixture.paths.base_dir), listing_before);
    assert!(!fixture.paths.runtime_lock().exists());
}

#[tokio::test]
async fn compact_dry_run_on_a_crash_left_wal_reports_upper_bounds_and_changes_nothing() {
    let (_root, config, paths) = crashed_store_fixture(0);
    let bytes_before = sqlite_bytes(&paths.database);
    let listing_before = base_listing(&paths.base_dir);
    let file_bytes = bytes_before[0].as_ref().expect("database").len() as u64;
    let wal_bytes = bytes_before[1].as_ref().expect("WAL").len() as u64;
    assert!(bytes_before[2].is_some(), "fixture has -shm");

    let report = compact(&config, true, PLENTY).await.expect("dry run");

    assert_eq!(report.before.page_count, None);
    assert_eq!(report.before.freelist_count, None);
    assert_eq!(
        report.before.database_stats_unavailable,
        Some(DatabaseStatsUnavailable::UncheckpointedWal)
    );
    assert_eq!(report.plan.estimated_reclaim_bytes, None);
    assert_eq!(report.plan.backup_bytes, file_bytes + wal_bytes);
    assert_eq!(sqlite_bytes(&paths.database), bytes_before);
    assert_eq!(base_listing(&paths.base_dir), listing_before);
}

#[tokio::test]
async fn compact_reclaims_space_behind_exactly_one_verified_pre_compact_backup() {
    let fixture = offline_store_with_free_pages();
    let file_before = std::fs::metadata(&fixture.paths.database)
        .expect("database")
        .len();
    let rows_before = snapshot_file(&fixture.paths.database);
    let inventory_before = inventory_verified_backups(&fixture.paths, storage_id(&fixture.paths))
        .await
        .expect("inventory before");
    assert!(inventory_before.verified.is_empty());

    let report = compact(&fixture.config, false, PLENTY)
        .await
        .expect("compact store");

    let inventory = inventory_verified_backups(&fixture.paths, storage_id(&fixture.paths))
        .await
        .expect("inventory after");
    assert_eq!(inventory.verified.len(), 1);
    assert!(inventory.issues.is_empty(), "{:?}", inventory.issues);
    let backup = &inventory.verified[0];
    assert_eq!(backup.manifest.trigger, BackupTrigger::PreCompact);
    assert_eq!(
        report.backup_id.as_deref(),
        Some(backup.manifest.backup_id.to_string().as_str())
    );
    assert_eq!(snapshot_file(&backup.database), rows_before);
    assert_eq!(report.plan.sqlite_lock, "locked");
    assert_eq!(report.checkpoint, Some("complete"));

    let file_after = std::fs::metadata(&fixture.paths.database)
        .expect("database")
        .len();
    assert!(file_after < file_before, "{file_after} < {file_before}");
    assert!(!sqlite_sidecar(&fixture.paths.database, "-wal").exists());
    assert!(!sqlite_sidecar(&fixture.paths.database, "-shm").exists());
    let (_, _, freelist_count, auto_vacuum) = immutable_stats(&fixture.paths.database);
    assert_eq!(freelist_count, 0);
    assert_eq!(auto_vacuum, 2, "auto_vacuum = INCREMENTAL");
    let after = report.after.expect("after stats");
    assert_eq!(after.file_bytes, file_after);
    assert_eq!(after.freelist_count, Some(0));
    assert_eq!(after.auto_vacuum, Some(AutoVacuumMode::Incremental));
    assert_eq!(snapshot_file(&fixture.paths.database), rows_before);
    assert_eq!(journal_header_versions(&fixture.paths.database), (2, 2));
}

#[tokio::test]
async fn compact_recovers_a_crash_left_wal_under_its_lock() {
    for keep_shm in [true, false] {
        let (_root, config, paths) = crashed_store_fixture(0);
        if !keep_shm {
            std::fs::remove_file(sqlite_sidecar(&paths.database, "-shm")).expect("remove SHM");
        }

        let report = compact(&config, false, PLENTY)
            .await
            .expect("compact crash-left store");

        let inventory = inventory_verified_backups(&paths, storage_id(&paths))
            .await
            .expect("inventory");
        let backup = inventory
            .verified
            .iter()
            .find(|backup| backup.manifest.trigger == BackupTrigger::PreCompact)
            .expect("pre-compact backup");
        assert_eq!(
            report.backup_id.as_deref(),
            Some(backup.manifest.backup_id.to_string().as_str())
        );
        assert!(
            crash_project_present(&backup.database),
            "backup has WAL rows"
        );
        assert!(
            !sqlite_sidecar(&paths.database, "-wal").exists(),
            "shm {keep_shm}"
        );
        assert!(
            !sqlite_sidecar(&paths.database, "-shm").exists(),
            "shm {keep_shm}"
        );
        let inspection = inspect_store(root_of(&config)).await.expect("inspect");
        assert_eq!(inspection.classification, StoreInspectionStatus::Existing);
        assert!(crash_project_present(&paths.database), "store has WAL rows");
    }
}

#[tokio::test]
async fn compact_refuses_while_a_server_owns_the_store() {
    let fixture = offline_store_with_free_pages();
    let handle = start_server_on(&fixture.config).await;
    let database_before = std::fs::read(&fixture.paths.database).expect("database bytes");
    let marker_before = std::fs::read(&fixture.paths.environment_id).expect("marker bytes");

    let error = compact(&fixture.config, false, PLENTY)
        .await
        .expect_err("running store blocks compaction");

    assert!(matches!(error, RecoveryError::StoreRunning), "{error:?}");
    assert!(backup_entries(&fixture.paths).is_empty());
    assert_eq!(
        std::fs::read(&fixture.paths.database).expect("database remains"),
        database_before
    );
    assert_eq!(
        std::fs::read(&fixture.paths.environment_id).expect("marker remains"),
        marker_before
    );
    let error = compact(&fixture.config, true, PLENTY)
        .await
        .expect_err("running store blocks the dry run too");
    assert!(matches!(error, RecoveryError::StoreRunning), "{error:?}");
    handle.shutdown();
    handle.join().await.expect("store owner stops");
}

#[tokio::test]
async fn compact_refuses_an_empty_or_headerless_database_before_any_write() {
    enum Case {
        Empty,
        Foreign,
        Journal,
    }
    for case in [Case::Empty, Case::Foreign, Case::Journal] {
        let fixture = offline_store_with_free_pages();
        match case {
            Case::Empty => std::fs::write(&fixture.paths.database, b"").expect("empty"),
            Case::Foreign => {
                std::fs::write(&fixture.paths.database, vec![0x5a_u8; 4096]).expect("foreign");
            }
            Case::Journal => std::fs::write(
                sqlite_sidecar(&fixture.paths.database, "-journal"),
                b"interrupted rollback journal",
            )
            .expect("journal"),
        }
        let bytes_before = sqlite_bytes(&fixture.paths.database);

        let error = compact(&fixture.config, false, PLENTY)
            .await
            .expect_err("compaction refuses");

        assert!(
            matches!(error, RecoveryError::NotCompactable { .. }),
            "{error:?}"
        );
        assert!(backup_entries(&fixture.paths).is_empty());
        assert_eq!(sqlite_bytes(&fixture.paths.database), bytes_before);
    }
}

#[tokio::test]
async fn compact_refuses_a_locked_database_without_waiting() {
    // A WAL store whose other connection holds BEGIN EXCLUSIVE with a pending write.
    let fixture = offline_store_with_free_pages();
    let bytes_before = sqlite_bytes(&fixture.paths.database);
    let other = Connection::open(&fixture.paths.database).expect("other connection");
    other
        .execute_batch(
            "BEGIN EXCLUSIVE;
             UPDATE projection_projects SET title = 'pending' WHERE project_id = 'protected-project';",
        )
        .expect("hold the lock with a pending write");
    let started = Instant::now();
    let error = compact(&fixture.config, false, PLENTY)
        .await
        .expect_err("locked database refuses");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert!(matches!(error, RecoveryError::DatabaseLocked), "{error:?}");
    assert!(backup_entries(&fixture.paths).is_empty());
    other.execute_batch("ROLLBACK").expect("roll back");
    drop(other);
    assert_eq!(sqlite_bytes(&fixture.paths.database), bytes_before);

    // A just-restored DELETE-mode store whose other connection holds BEGIN EXCLUSIVE.
    let fixture = restored_store_fixture().await;
    let bytes_before = sqlite_bytes(&fixture.paths.database);
    let backups_before = backup_entries(&fixture.paths);
    let other = Connection::open(&fixture.paths.database).expect("other connection");
    other
        .execute_batch("BEGIN EXCLUSIVE;")
        .expect("hold the lock");
    let started = Instant::now();
    let error = compact(&fixture.config, false, PLENTY)
        .await
        .expect_err("locked restored database refuses");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert!(matches!(error, RecoveryError::DatabaseLocked), "{error:?}");
    let report = compact(&fixture.config, true, PLENTY)
        .await
        .expect("the dry run does not check SQLite locks");
    assert_eq!(report.plan.sqlite_lock, "not-checked");
    assert_eq!(backup_entries(&fixture.paths), backups_before);

    // With a pending write SQLite has already created `-journal`, which the file checks refuse
    // before any SQLite open.
    other
        .execute_batch(
            "UPDATE projection_projects SET title = 'pending' WHERE project_id = 'protected-project';",
        )
        .expect("pending write");
    assert!(sqlite_sidecar(&fixture.paths.database, "-journal").exists());
    let started = Instant::now();
    let error = compact(&fixture.config, false, PLENTY)
        .await
        .expect_err("pending rollback-mode write refuses");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert!(
        matches!(error, RecoveryError::NotCompactable { .. }),
        "{error:?}"
    );
    other.execute_batch("ROLLBACK").expect("roll back");
    drop(other);
    assert_eq!(backup_entries(&fixture.paths), backups_before);
    assert_eq!(sqlite_bytes(&fixture.paths.database), bytes_before);
    assert_eq!(journal_header_versions(&fixture.paths.database), (1, 1));
}

#[tokio::test]
async fn compact_refuses_insufficient_disk_space_before_the_backup() {
    let clean = offline_store_with_free_pages();
    let (crashed_root, crashed_config, crashed_paths) = crashed_store_fixture(0);
    let restored = restored_store_fixture().await;
    let stores = [
        (&clean.config, &clean.paths),
        (&crashed_config, &crashed_paths),
        (&restored.config, &restored.paths),
    ];
    for (config, paths) in stores {
        let bytes_before = sqlite_bytes(&paths.database);
        let backups_before = backup_entries(paths);
        let header_before = journal_header_versions(&paths.database);

        let error = compact(
            config,
            false,
            CompactTestHook::FreeSpace {
                store: 1024,
                temp: u64::MAX / 4,
                same_volume: false,
            },
        )
        .await
        .expect_err("insufficient space refuses");

        match error {
            RecoveryError::InsufficientSpace {
                volume,
                required,
                available,
                ..
            } => {
                assert_eq!(volume, "store");
                assert_eq!(available, 1024);
                assert!(required > available);
            }
            other => panic!("unexpected error {other:?}"),
        }
        assert_eq!(backup_entries(paths), backups_before);
        assert_eq!(sqlite_bytes(&paths.database), bytes_before);
        assert_eq!(journal_header_versions(&paths.database), header_before);
    }
    let error = compact(
        &clean.config,
        false,
        CompactTestHook::FreeSpace {
            store: u64::MAX / 4,
            temp: 1024,
            same_volume: false,
        },
    )
    .await
    .expect_err("insufficient temp space refuses");
    assert!(
        matches!(
            error,
            RecoveryError::InsufficientSpace { volume: "temp", .. }
        ),
        "{error:?}"
    );
    let inspection = inspect_store(root_of(&clean.config))
        .await
        .expect("inspect");
    assert_eq!(inspection.classification, StoreInspectionStatus::Existing);
    drop(crashed_root);
}

#[tokio::test]
async fn compact_counts_main_file_growth_held_in_a_crash_left_wal() {
    let (_root, config, paths) = crashed_store_fixture(3_000);
    let bytes_before = sqlite_bytes(&paths.database);
    let file_before = bytes_before[0].as_ref().expect("database").len() as u64;
    let probe = |store| CompactTestHook::FreeSpace {
        store,
        temp: u64::MAX / 4,
        same_volume: false,
    };

    let RecoveryError::InsufficientSpace {
        required,
        temp_required,
        ..
    } = compact(&config, false, probe(0))
        .await
        .expect_err("probe the requirement")
    else {
        panic!("expected insufficient space");
    };
    let compacted = temp_required.expect("split volumes") - 64 * 1024 * 1024;
    assert!(
        compacted > file_before,
        "the WAL holds pages beyond the main file: {compacted} > {file_before}"
    );

    let error = compact(&config, false, probe(required - 1))
        .await
        .expect_err("one byte short refuses");
    assert!(
        matches!(
            error,
            RecoveryError::InsufficientSpace {
                volume: "store",
                ..
            }
        ),
        "{error:?}"
    );
    assert!(backup_entries(&paths).is_empty());
    assert_eq!(sqlite_bytes(&paths.database), bytes_before);

    let report = compact(&config, false, probe(required))
        .await
        .expect("exactly enough space compacts");
    let inventory = inventory_verified_backups(&paths, storage_id(&paths))
        .await
        .expect("inventory");
    let backup = inventory
        .verified
        .iter()
        .find(|backup| backup.manifest.trigger == BackupTrigger::PreCompact)
        .expect("pre-compact backup");
    // The revision-3 formula left out the growth the final checkpoint adds to the main file.
    let growth = compacted - file_before;
    assert_eq!(
        required,
        backup.manifest.database_size_bytes + compacted + growth + 64 * 1024 * 1024
    );
    assert_eq!(report.plan.required_free_bytes.store, required);
    assert!(!sqlite_sidecar(&paths.database, "-wal").exists());
}

#[tokio::test]
async fn compact_cancelled_after_the_backup_leaves_the_store_unchanged() {
    let clean = offline_store_with_free_pages();
    let (_crashed_root, crashed_config, crashed_paths) = crashed_store_fixture(0);
    for (config, paths) in [
        (&clean.config, &clean.paths),
        (&crashed_config, &crashed_paths),
    ] {
        let bytes_before = sqlite_bytes(&paths.database);

        let error = compact(config, false, CompactTestHook::CancelAfterBackup)
            .await
            .expect_err("cancelled after the backup");

        let RecoveryError::Cancelled {
            backup_id: Some(backup_id),
        } = error
        else {
            panic!("unexpected error {error:?}");
        };
        let inventory = inventory_verified_backups(paths, storage_id(paths))
            .await
            .expect("inventory");
        assert!(
            inventory
                .verified
                .iter()
                .any(|backup| backup.manifest.backup_id == backup_id
                    && backup.manifest.trigger == BackupTrigger::PreCompact)
        );
        assert_eq!(sqlite_bytes(&paths.database), bytes_before);
    }
}

#[tokio::test]
async fn compact_cancelled_during_vacuum_rolls_back_and_restarts_cleanly() {
    let fixture = offline_store_with_free_pages();
    let rows_before = snapshot_file(&fixture.paths.database);
    let (_, _, freelist_before, auto_vacuum_before) = immutable_stats(&fixture.paths.database);

    let error = compact(&fixture.config, false, CompactTestHook::CancelDuringVacuum)
        .await
        .expect_err("cancelled during VACUUM");

    let RecoveryError::Cancelled {
        backup_id: Some(backup_id),
    } = error
    else {
        panic!("unexpected error {error:?}");
    };
    let prepared = fixture.prepare().await.expect("normal restart");
    let (rows, freelist, auto_vacuum) = prepared
        .database
        .call(|connection| {
            Ok((
                projection_snapshot(connection),
                connection.query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))?,
                connection.query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))?,
            ))
        })
        .await
        .expect("read restarted store");
    close_prepared_store_for_offline_fixture(prepared).await;
    assert_eq!(rows, rows_before);
    assert_eq!(u64::try_from(freelist).expect("freelist"), freelist_before);
    assert_eq!(auto_vacuum, auto_vacuum_before);
    assert_eq!(auto_vacuum, 0, "auto_vacuum stays NONE");
    let inventory = inventory_verified_backups(&fixture.paths, storage_id(&fixture.paths))
        .await
        .expect("inventory");
    assert!(
        inventory
            .verified
            .iter()
            .any(|backup| backup.manifest.backup_id == backup_id)
    );
}

#[tokio::test]
async fn inventory_keeps_other_backups_beside_a_manifest_with_an_unknown_trigger() {
    let fixture = StoreFixture::with_project("Older reader").await;
    fixture.write_marker(Uuid::new_v4());
    let prepared = fixture.prepare().await.expect("prepare fixture");
    let mut created = Vec::new();
    for _ in 0..2 {
        created.push(
            create_verified_backup(
                &prepared.database,
                &prepared,
                BackupTrigger::PreUpdate,
                env!("CARGO_PKG_VERSION"),
            )
            .await
            .expect("backup"),
        );
    }
    // A trigger this build does not know, as `pre-compact` is to an older build.
    let unknown = &created[0];
    let manifest = std::fs::read_to_string(&unknown.manifest_path).expect("manifest");
    std::fs::write(
        &unknown.manifest_path,
        manifest.replace("\"pre-update\"", "\"from-a-future-build\""),
    )
    .expect("rewrite manifest trigger");

    let inventory = inventory_verified_backups(&fixture.paths, prepared.storage_instance_id)
        .await
        .expect("inventory");
    assert_eq!(inventory.verified.len(), 1);
    assert_eq!(
        inventory.verified[0].manifest.backup_id,
        created[1].manifest.backup_id
    );
    assert_eq!(inventory.issues.len(), 1);
    assert_eq!(
        inventory.issues[0].entry_name,
        unknown.manifest.backup_id.to_string()
    );

    for _ in 0..3 {
        create_verified_backup(
            &prepared.database,
            &prepared,
            BackupTrigger::PreUpdate,
            env!("CARGO_PKG_VERSION"),
        )
        .await
        .expect("later backup");
    }
    let inventory = inventory_verified_backups(&fixture.paths, prepared.storage_instance_id)
        .await
        .expect("inventory after retention");
    assert_eq!(inventory.verified.len(), 3);
    assert!(
        unknown.manifest_path.is_file(),
        "retention never deletes it"
    );
    assert!(unknown.database.is_file());
    close_prepared_store_for_offline_fixture(prepared).await;
}

#[tokio::test]
async fn pre_compact_backup_restores_with_restore_backup_id() {
    let fixture = offline_store_with_free_pages();
    let storage_instance_id = storage_id(&fixture.paths);
    let prepared = fixture.prepare().await.expect("prepare fixture");
    let older = create_verified_backup(
        &prepared.database,
        &prepared,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("older pre-update backup");
    let other_identity = PreparedStore {
        database: prepared.database.clone(),
        storage_instance_id: StorageInstanceId::from_uuid(Uuid::new_v4()),
        classification: StoreClassification::Existing,
        paths: prepared.paths.clone(),
    };
    create_verified_backup(
        &prepared.database,
        &other_identity,
        BackupTrigger::PreUpdate,
        env!("CARGO_PKG_VERSION"),
    )
    .await
    .expect("generation of another identity");
    drop(other_identity);
    close_prepared_store_for_offline_fixture(prepared).await;
    let rows_before = snapshot_file(&fixture.paths.database);

    let report = compact(&fixture.config, false, PLENTY)
        .await
        .expect("compact");
    let backup_id =
        Uuid::parse_str(report.backup_id.as_deref().expect("backup id")).expect("backup UUID");
    Connection::open(&fixture.paths.database)
        .expect("compacted store")
        .execute(
            "UPDATE projection_projects SET title = 'After compaction' WHERE project_id = 'protected-project'",
            [],
        )
        .expect("change after compaction");

    restore_backup(root_of(&fixture.config), backup_id)
        .await
        .expect("restore the pre-compact backup");

    assert_eq!(snapshot_file(&fixture.paths.database), rows_before);
    assert_eq!(storage_id(&fixture.paths), storage_instance_id);
    let inventory = inventory_verified_backups(&fixture.paths, storage_instance_id)
        .await
        .expect("inventory");
    assert!(
        inventory
            .verified
            .iter()
            .any(|backup| backup.manifest.backup_id == older.manifest.backup_id)
    );
}

/// Links `link` to the file `target`; `false` when this platform or account cannot.
fn link_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        symlink(target, link).expect("file symlink");
        true
    }
    #[cfg(windows)]
    {
        // Windows file symlinks need Developer Mode or an elevated account.
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }
}

/// Links the directory `link` to `target`: a symlink on Unix, a junction on Windows (no
/// privilege needed).
fn link_directory(target: &Path, link: &Path) {
    #[cfg(unix)]
    symlink(target, link).expect("directory symlink");
    #[cfg(windows)]
    junction::create(target, link).expect("directory junction");
}

#[tokio::test]
async fn compact_refuses_a_linked_database_before_touching_the_target() {
    // The target is a crash-left WAL store; SQLite would recover and checkpoint the WAL beside
    // the link target, which the sidecar checks next to the link never see.
    let (_target_root, _target_config, target) = crashed_store_fixture(0);
    let target_bytes = sqlite_bytes(&target.database);
    let refuse = CompactTestHook::FreeSpace {
        store: 1024,
        temp: u64::MAX / 4,
        same_volume: false,
    };

    // The database file itself is a link.
    let linked = StoreFixture::new();
    if link_file(&target.database, &linked.paths.database) {
        std::fs::copy(&target.environment_id, &linked.paths.environment_id)
            .expect("linked store marker");
        let error = compact(&linked.config, false, refuse)
            .await
            .expect_err("a linked database refuses");
        assert!(
            matches!(error, RecoveryError::NotCompactable { .. }),
            "{error:?}"
        );
        let error = compact(&linked.config, true, PLENTY)
            .await
            .expect_err("the dry run refuses too");
        assert!(
            matches!(error, RecoveryError::NotCompactable { .. }),
            "{error:?}"
        );
        assert_eq!(sqlite_bytes(&target.database), target_bytes);
        assert!(backup_entries(&linked.paths).is_empty());
    } else {
        eprintln!("skipped the file-link case: this account cannot create file symlinks");
    }

    // The state directory is a link (a junction on Windows).
    let root = TempDir::new().expect("linked root");
    let mut config = ServerConfig::new(root.path());
    let resolved = resolve_data_root(config.data_root_request.clone()).expect("resolve root");
    config.base_dir = resolved.effective.clone();
    config.resolved_data_root = Some(resolved);
    let paths = StatePaths::from_config(&config);
    link_directory(&target.state_dir, &paths.state_dir);
    let error = compact(&config, false, refuse)
        .await
        .expect_err("a linked state directory refuses");
    assert!(
        matches!(error, RecoveryError::NotCompactable { .. }),
        "{error:?}"
    );
    assert_eq!(sqlite_bytes(&target.database), target_bytes);
    assert!(backup_entries(&paths).is_empty());
    assert!(backup_entries(&target).is_empty());
}

#[tokio::test]
async fn compact_cancelled_during_vacuum_keeps_a_full_auto_vacuum_mode() {
    let fixture = StoreFixture::new();
    let mut connection = Connection::open(&fixture.paths.database).expect("fixture database");
    connection
        .pragma_update(None, "auto_vacuum", "FULL")
        .expect("FULL before the first table");
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .expect("fixture WAL mode");
    run_migrations(&mut connection, None).expect("fixture migrations");
    connection
        .execute_batch(&format!(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
             INSERT INTO projection_projects (
               project_id, title, workspace_root, default_model_selection_json,
               scripts_json, created_at, updated_at, deleted_at
             ) SELECT 'kept-' || i, hex(randomblob(200)), '/tmp/kept', NULL, '{{}}',
                      '{TS}', '{TS}', NULL FROM n;"
        ))
        .expect("fixture rows");
    connection.close().expect("close fixture database");
    fixture.write_marker(Uuid::new_v4());
    assert_eq!(
        immutable_stats(&fixture.paths.database).3,
        1,
        "fixture is FULL"
    );
    let rows_before = snapshot_file(&fixture.paths.database);

    let error = compact(&fixture.config, false, CompactTestHook::CancelDuringVacuum)
        .await
        .expect_err("cancelled during VACUUM");

    assert!(
        matches!(error, RecoveryError::Cancelled { backup_id: Some(_) }),
        "{error:?}"
    );
    assert_eq!(
        immutable_stats(&fixture.paths.database).3,
        1,
        "a cancelled compaction leaves auto_vacuum FULL"
    );
    assert_eq!(snapshot_file(&fixture.paths.database), rows_before);
}

#[tokio::test]
async fn compact_cleanup_failure_names_the_pre_compact_backup() {
    let (_root, config, paths) = crashed_store_fixture(0);

    let error = compact(&config, false, CompactTestHook::FailCleanup)
        .await
        .expect_err("cleanup failure");

    let RecoveryError::CompactFailed {
        phase,
        backup_id: Some(backup_id),
        ..
    } = &error
    else {
        panic!("unexpected error {error:?}");
    };
    assert_eq!(*phase, "cleanup");
    assert!(
        error.to_string().contains(&backup_id.to_string()),
        "the displayed error names the backup: {error}"
    );
    let inventory = inventory_verified_backups(&paths, storage_id(&paths))
        .await
        .expect("inventory");
    assert!(
        inventory
            .verified
            .iter()
            .any(|backup| backup.manifest.backup_id == *backup_id)
    );
}
