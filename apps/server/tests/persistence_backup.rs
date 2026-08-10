use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use bibcode_server::{
    ServerConfig,
    persistence::{
        BackupTrigger, MIGRATIONS, StatePaths, StorageInstanceId, StoreClassification,
        StoreOperationGuard, VerifiedBackup, create_verified_backup, inventory_verified_backups,
        pending_migrations, prepare_store, run_migrations,
    },
    resolve_data_root,
};
use rusqlite::{Connection, OpenFlags};
use tempfile::TempDir;
use uuid::Uuid;

const LOCK_CHILD_ROOT: &str = "BIBCODE_BACKUP_LOCK_CHILD_ROOT";
const LOCK_CHILD_ACQUIRED: &str = "BIBCODE_BACKUP_LOCK_CHILD_ACQUIRED";

struct PersistedStoreFixture {
    _root: TempDir,
    config: ServerConfig,
    paths: StatePaths,
    storage_instance_id: StorageInstanceId,
}

impl PersistedStoreFixture {
    fn new() -> Self {
        let root = TempDir::new().expect("temporary absolute data root");
        let mut config = ServerConfig::new(root.path());
        let resolved = resolve_data_root(config.data_root_request.clone()).expect("resolve root");
        config.base_dir = resolved.effective.clone();
        config.resolved_data_root = Some(resolved);
        let paths = StatePaths::from_config(&config);
        fs::create_dir_all(&paths.state_dir).expect("state directory");
        Self {
            _root: root,
            config,
            paths,
            storage_instance_id: StorageInstanceId::from_uuid(Uuid::new_v4()),
        }
    }

    fn first_run() -> Self {
        Self::new()
    }

    fn older_schema_with_project(project_id: &str) -> Self {
        let fixture = Self::new();
        let mut connection = Connection::open(&fixture.paths.database).expect("fixture database");
        run_migrations(&mut connection, Some(38)).expect("older fixture migrations");
        insert_project(&connection, project_id);
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .expect("checkpoint older fixture");
        drop(connection);
        fixture.write_marker();
        fixture
    }

    fn older_wal_schema_with_project(project_id: &str) -> (Self, Connection) {
        let fixture = Self::new();
        let mut connection = Connection::open(&fixture.paths.database).expect("fixture database");
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .expect("WAL fixture");
        connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .expect("disable automatic checkpoint");
        run_migrations(&mut connection, Some(38)).expect("older fixture migrations");
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .expect("checkpoint schema");
        insert_project(&connection, project_id);
        assert!(sqlite_sidecar(&fixture.paths.database, "-wal").is_file());
        fixture.write_marker();
        (fixture, connection)
    }

    fn current_schema_with_project(project_id: &str) -> Self {
        let fixture = Self::new();
        let mut connection = Connection::open(&fixture.paths.database).expect("fixture database");
        run_migrations(&mut connection, None).expect("current fixture migrations");
        insert_project(&connection, project_id);
        drop(connection);
        fixture.write_marker();
        fixture
    }

    fn write_marker(&self) {
        fs::write(
            &self.paths.environment_id,
            format!("{}\n", self.storage_instance_id),
        )
        .expect("marker fixture");
    }

    async fn prepare(
        &self,
    ) -> Result<
        bibcode_server::persistence::PreparedStore,
        bibcode_server::persistence::StoreStartupError,
    > {
        prepare_store(&self.config).await
    }

    fn database_bytes(&self) -> Vec<u8> {
        fs::read(&self.paths.database).expect("database bytes")
    }

    fn schema_version(&self) -> i64 {
        Connection::open_with_flags(&self.paths.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("schema reader")
            .query_row(
                "SELECT COALESCE(MAX(migration_id), 0) FROM effect_sql_migrations",
                [],
                |row| row.get(0),
            )
            .expect("schema version")
    }

    fn block_backup_directory_with_file(&self) {
        fs::write(self.paths.base_dir.join("backups"), b"blocked").expect("backup blocker");
    }

    async fn create_backup_at(
        &self,
        prepared: &bibcode_server::persistence::PreparedStore,
        sequence: u8,
        app_version: &str,
    ) -> VerifiedBackup {
        let mut backup = create_verified_backup(
            &prepared.database,
            prepared,
            BackupTrigger::PreUpdate,
            app_version,
        )
        .await
        .expect("backup should verify");
        backup.manifest.created_at = format!("1970-01-01T00:00:{sequence:02}Z");
        let mut manifest = serde_json::to_vec_pretty(&backup.manifest).expect("manifest JSON");
        manifest.push(b'\n');
        fs::write(&backup.manifest_path, manifest).expect("deterministic manifest clock");
        backup
    }
}

fn insert_project(connection: &Connection, project_id: &str) {
    connection
        .execute(
            "INSERT INTO projection_projects (
               project_id, title, workspace_root, default_model_selection_json,
               scripts_json, created_at, updated_at, deleted_at
             ) VALUES (?1, ?1, '/tmp/backup-project', NULL, '{}',
                       '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z', NULL)",
            [project_id],
        )
        .expect("fixture project");
}

fn sqlite_sidecar(database: &Path, suffix: &str) -> PathBuf {
    let mut path = database.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn project_ids(database: &Path) -> Vec<String> {
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("backup reader");
    let mut statement = connection
        .prepare("SELECT project_id FROM projection_projects ORDER BY project_id")
        .expect("project query");
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("project rows")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("project ids")
}

#[tokio::test]
async fn creates_verified_pre_migration_backup_before_first_pending_migration() {
    let fixture = PersistedStoreFixture::older_schema_with_project("project-a");

    let prepared = fixture.prepare().await.expect("migration should succeed");
    assert_eq!(prepared.classification, StoreClassification::Existing);
    let inventory = inventory_verified_backups(&prepared.paths, prepared.storage_instance_id)
        .await
        .expect("backup inventory");
    assert!(inventory.issues.is_empty());
    let [backup]: [VerifiedBackup; 1] = inventory
        .verified
        .try_into()
        .expect("one pre-migration backup");

    assert_eq!(backup.manifest.trigger, BackupTrigger::PreMigration);
    assert_eq!(
        backup.manifest.storage_instance_id,
        prepared.storage_instance_id
    );
    assert_eq!(backup.manifest.state_kind, prepared.paths.state_kind);
    assert!(backup.manifest.created_at.ends_with('Z'));
    assert_eq!(backup.manifest.sha256.len(), 64);
    assert_eq!(
        backup.manifest.database_size_bytes,
        fs::metadata(&backup.database)
            .expect("backup metadata")
            .len()
    );
    assert_eq!(project_ids(&backup.database), ["project-a"]);
    assert!(
        backup
            .manifest_matches_file()
            .await
            .expect("manifest check")
    );
    assert_eq!(backup.quick_check().await.expect("quick check"), "ok");
    assert_eq!(backup.manifest.schema_version, 38);
    assert!(fixture.schema_version() > backup.manifest.schema_version);
    let entries = fs::read_dir(&backup.directory)
        .expect("backup generation entries")
        .map(|entry| entry.expect("backup entry").file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 2, "published backup has no SQLite sidecars");
    assert!(entries.contains(&"state.sqlite".into()));
    assert!(entries.contains(&"manifest.json".into()));
}

#[tokio::test]
async fn refuses_migration_when_backup_publication_cannot_begin() {
    let fixture = PersistedStoreFixture::older_schema_with_project("project-a");
    fixture.block_backup_directory_with_file();
    let before = fixture.database_bytes();
    let schema_before = fixture.schema_version();
    let marker_before = fs::read(&fixture.paths.environment_id).expect("marker bytes");

    let error = fixture.prepare().await.expect_err("backup must fail");

    assert!(matches!(
        error,
        bibcode_server::persistence::StoreStartupError::Backup(_)
    ));
    assert_eq!(fixture.database_bytes(), before);
    assert_eq!(fixture.schema_version(), schema_before);
    assert_eq!(
        fs::read(&fixture.paths.environment_id).expect("marker remains"),
        marker_before
    );
}

#[tokio::test]
async fn new_empty_store_with_no_existing_schema_creates_no_backup() {
    let fixture = PersistedStoreFixture::first_run();

    let prepared = fixture.prepare().await.expect("first run succeeds");

    assert_eq!(prepared.classification, StoreClassification::FirstRun);
    assert!(!fixture.paths.base_dir.join("backups").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn active_wal_rows_are_captured_by_a_coherent_online_backup() {
    let (fixture, writer) = PersistedStoreFixture::older_wal_schema_with_project("wal-project");

    let prepared = fixture.prepare().await.expect("WAL migration succeeds");
    let inventory = inventory_verified_backups(&prepared.paths, prepared.storage_instance_id)
        .await
        .expect("backup inventory");
    let backup = inventory.verified.first().expect("WAL backup");

    assert_eq!(project_ids(&backup.database), ["wal-project"]);
    assert_eq!(backup.quick_check().await.expect("quick check"), "ok");
    drop(writer);
}

#[tokio::test]
async fn retains_the_three_newest_verified_backups_per_store_and_kind() {
    let fixture = PersistedStoreFixture::current_schema_with_project("project-a");
    let prepared = fixture.prepare().await.expect("current store opens");
    let mut created = Vec::new();
    for sequence in 1..=4 {
        created.push(
            fixture
                .create_backup_at(&prepared, sequence, "retention-test")
                .await
                .manifest
                .backup_id,
        );
    }

    let inventory = inventory_verified_backups(&prepared.paths, prepared.storage_instance_id)
        .await
        .expect("backup inventory");
    let retained = inventory
        .verified
        .iter()
        .map(|backup| backup.manifest.backup_id)
        .collect::<Vec<_>>();

    assert_eq!(retained, created[1..]);
}

#[tokio::test]
async fn malformed_and_staging_entries_are_reported_but_never_selected_or_deleted() {
    let fixture = PersistedStoreFixture::current_schema_with_project("project-a");
    let prepared = fixture.prepare().await.expect("current store opens");
    let generation_root = prepared
        .paths
        .backup_store_dir(prepared.storage_instance_id);
    fs::create_dir_all(&generation_root).expect("generation root");
    let malformed = generation_root.join(Uuid::new_v4().to_string());
    fs::create_dir(&malformed).expect("malformed generation");
    fs::write(malformed.join("manifest.json"), b"not json").expect("malformed manifest");
    let staging = generation_root.join(format!(".{}.staging", Uuid::new_v4()));
    fs::create_dir(&staging).expect("staging generation");

    let first = fixture
        .create_backup_at(&prepared, 1, "inventory-test")
        .await;
    let mismatched = generation_root.join(Uuid::new_v4().to_string());
    fs::create_dir(&mismatched).expect("mismatched generation");
    fs::copy(&first.database, mismatched.join("state.sqlite")).expect("mismatched database copy");
    fs::copy(&first.manifest_path, mismatched.join("manifest.json"))
        .expect("mismatched manifest copy");
    let non_utc_id = Uuid::new_v4();
    let non_utc = generation_root.join(non_utc_id.to_string());
    fs::create_dir(&non_utc).expect("non-UTC generation");
    fs::copy(&first.database, non_utc.join("state.sqlite")).expect("non-UTC database copy");
    let mut non_utc_manifest = first.manifest.clone();
    non_utc_manifest.backup_id = non_utc_id;
    non_utc_manifest.created_at = "1970-01-01T01:00:00+01:00".to_owned();
    fs::write(
        non_utc.join("manifest.json"),
        serde_json::to_vec_pretty(&non_utc_manifest).expect("non-UTC manifest JSON"),
    )
    .expect("non-UTC manifest");
    #[cfg(unix)]
    let symlinked = {
        use std::os::unix::fs::symlink;
        let path = generation_root.join(Uuid::new_v4().to_string());
        symlink(&first.directory, &path).expect("symlinked generation");
        path
    };

    for sequence in 2..=4 {
        fixture
            .create_backup_at(&prepared, sequence, "inventory-test")
            .await;
    }
    let inventory = inventory_verified_backups(&prepared.paths, prepared.storage_instance_id)
        .await
        .expect("defensive inventory");

    assert_eq!(inventory.verified.len(), 3);
    assert!(!inventory.issues.is_empty());
    assert!(malformed.is_dir(), "untrusted generation must remain");
    assert!(mismatched.is_dir(), "location mismatch must remain");
    assert!(non_utc.is_dir(), "non-UTC generation must remain");
    assert!(staging.is_dir(), "incomplete staging must remain ignored");
    #[cfg(unix)]
    assert!(symlinked.is_symlink(), "symlinked generation must remain");
}

#[test]
fn pending_migration_inspection_does_not_create_a_ledger_or_change_database_bytes() {
    let root = TempDir::new().expect("inspection root");
    let database = root.path().join("state.sqlite");
    let connection = Connection::open(&database).expect("empty database");
    connection
        .execute_batch("CREATE TABLE user_fixture (value TEXT NOT NULL)")
        .expect("user schema");
    drop(connection);
    let before = fs::read(&database).expect("database bytes");
    let connection = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("read-only database");
    let schema_before = connection
        .query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .expect("schema version");
    let user_before = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .expect("user version");

    let pending = pending_migrations(&connection).expect("inspect pending migrations");

    assert_eq!(pending.len(), MIGRATIONS.len());
    assert_eq!(
        connection
            .query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
            .expect("schema version after"),
        schema_before
    );
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .expect("user version after"),
        user_before
    );
    drop(connection);
    assert_eq!(fs::read(&database).expect("database remains"), before);
    let reader = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("ledger reader");
    assert_eq!(
        reader
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("ledger existence"),
        0
    );
}

#[test]
fn store_operation_lock_child_process() {
    let Some(root) = std::env::var_os(LOCK_CHILD_ROOT) else {
        return;
    };
    let acquired = std::env::var_os(LOCK_CHILD_ACQUIRED).expect("child acquired path");
    let _guard = StoreOperationGuard::acquire(Path::new(&root)).expect("child operation lock");
    fs::write(acquired, b"acquired").expect("child acquired signal");
}

#[test]
fn same_root_operation_lock_serializes_a_second_process() {
    let root = TempDir::new().expect("operation lock root");
    let acquired = root.path().join("child-acquired");
    let guard = StoreOperationGuard::acquire(root.path()).expect("parent operation lock");
    let mut child = Command::new(std::env::current_exe().expect("test binary"))
        .arg("--exact")
        .arg("store_operation_lock_child_process")
        .arg("--nocapture")
        .env(LOCK_CHILD_ROOT, root.path())
        .env(LOCK_CHILD_ACQUIRED, &acquired)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn lock child");

    std::thread::sleep(Duration::from_millis(150));
    assert!(!acquired.exists(), "child must wait for the root lock");
    drop(guard);
    for _ in 0..100 {
        if acquired.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(acquired.is_file(), "child acquires after parent release");
    assert!(child.wait().expect("lock child exit").success());
}

#[test]
fn backup_manifest_never_serializes_the_effective_or_requested_root() {
    let fixture = PersistedStoreFixture::first_run();
    let manifest = bibcode_server::persistence::BackupManifest {
        backup_id: Uuid::new_v4(),
        storage_instance_id: fixture.storage_instance_id,
        created_at: "2026-08-09T00:00:00Z".to_owned(),
        state_kind: fixture.paths.state_kind,
        trigger: BackupTrigger::PreMigration,
        app_version: "test".to_owned(),
        schema_version: 38,
        database_size_bytes: 1,
        sha256: "0".repeat(64),
    };
    let json = serde_json::to_string(&manifest).expect("manifest JSON");

    assert!(!json.contains(fixture.paths.base_dir.to_string_lossy().as_ref()));
    assert!(!json.contains("requested"));
    assert!(!json.contains("effective"));
}
