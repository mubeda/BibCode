use bibcode_server::{
    ServerConfig,
    persistence::{
        PreparedStore, StatePaths, StoreClassification, StoreStartupError, prepare_store,
        run_migrations,
    },
    resolve_data_root,
};
use rusqlite::Connection;
use tempfile::TempDir;
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::symlink;

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
async fn wal_store_without_shm_is_rejected_without_creating_sidecars() {
    let fixture = StoreFixture::with_project("WAL project").await;
    let connection = Connection::open(&fixture.paths.database).expect("WAL database");
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .expect("enable WAL");
    connection
        .pragma_update(None, "wal_autocheckpoint", 0)
        .expect("disable automatic checkpoint");
    connection
        .execute(
            "UPDATE projection_projects SET title = 'Uncheckpointed project'",
            [],
        )
        .expect("write WAL frame");
    let wal_path = fixture.paths.database.with_extension("sqlite-wal");
    let shm_path = fixture.paths.database.with_extension("sqlite-shm");
    assert!(wal_path.is_file(), "WAL fixture");
    std::fs::remove_file(&shm_path).expect("remove SHM fixture");
    let entries_before = directory_snapshot(&fixture.paths.state_dir);

    fixture
        .prepare()
        .await
        .expect_err("WAL state cannot be inspected without side effects");

    assert_eq!(directory_snapshot(&fixture.paths.state_dir), entries_before);
    assert!(!shm_path.exists());
    drop(connection);
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

fn directory_snapshot(path: &std::path::Path) -> Vec<(std::ffi::OsString, Vec<u8>)> {
    let mut entries = std::fs::read_dir(path)
        .expect("state directory")
        .map(|entry| {
            let entry = entry.expect("state entry");
            let file_type = entry.file_type().expect("entry type");
            let bytes = if file_type.is_file() {
                std::fs::read(entry.path()).expect("entry bytes")
            } else {
                Vec::new()
            };
            (entry.file_name(), bytes)
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}
