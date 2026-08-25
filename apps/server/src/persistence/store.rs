use std::{fmt, path::PathBuf};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use thiserror::Error;
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::ServerConfig;

use super::{
    BackupError, BackupTrigger, Database, Migration, PersistenceError, StatePaths,
    StoreOperationGuard, create_verified_backup,
    migrations::{
        ExistingStoreValidationError, apply_migrations, pending_migrations, run_migrations,
        validate_existing_bibcode_store, validate_existing_bibcode_store_immutable,
    },
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct EnvironmentId(Uuid);

impl EnvironmentId {
    #[must_use]
    pub const fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    #[must_use]
    const fn as_uuid(self) -> Uuid {
        self.0
    }

    #[must_use]
    fn random() -> Self {
        Self(Uuid::new_v4())
    }
}

impl fmt::Display for EnvironmentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Serialize for EnvironmentId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for EnvironmentId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Uuid::parse_str(&value)
            .map(Self)
            .map_err(|_| de::Error::custom("environment ID must be a UUID"))
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct StorageInstanceId(Uuid);

impl StorageInstanceId {
    #[must_use]
    pub const fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    #[must_use]
    const fn as_uuid(self) -> Uuid {
        self.0
    }

    #[must_use]
    fn random() -> Self {
        Self(Uuid::new_v4())
    }
}

impl fmt::Display for StorageInstanceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Serialize for StorageInstanceId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for StorageInstanceId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Uuid::parse_str(&value)
            .map(Self)
            .map_err(|_| de::Error::custom("storage instance ID must be a UUID"))
    }
}

trait IdentityMarker: Copy + fmt::Display {
    fn from_uuid(value: Uuid) -> Self;
}

impl IdentityMarker for EnvironmentId {
    fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }
}

impl IdentityMarker for StorageInstanceId {
    fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreClassification {
    FirstRun,
    ExistingUnmarked,
    Existing,
}

#[derive(Debug)]
pub struct PreparedStore {
    pub database: Database,
    pub environment_id: EnvironmentId,
    pub storage_instance_id: StorageInstanceId,
    pub classification: StoreClassification,
    pub paths: StatePaths,
}

#[derive(Debug, Error)]
pub enum StoreStartupError {
    #[error("the server data root must be resolved before preparing persistent storage")]
    DataRootUnresolved,
    #[error("failed to inspect persistent state path {path}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("an incomplete project-data recovery operation remains at {path}")]
    RecoveryIncomplete { path: PathBuf },
    #[error("failed to read identity marker {path}")]
    MarkerRead {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("identity marker {path} is malformed")]
    MarkerMalformed { path: PathBuf },
    #[error("database {database} is missing while identity marker {marker} remains")]
    DatabaseMissing { database: PathBuf, marker: PathBuf },
    #[error("database {path} is corrupt: {detail}")]
    CorruptDatabase { path: PathBuf, detail: String },
    #[error("database {path} is not a recognized BiBCode store: {detail}")]
    UnrecognizedStore { path: PathBuf, detail: String },
    #[error("database {path} cannot be inspected without side effects: {detail}")]
    UnsafeDatabaseState { path: PathBuf, detail: String },
    #[error("failed to open persistent database {path}")]
    DatabaseOpen {
        path: PathBuf,
        #[source]
        source: Box<PersistenceError>,
    },
    #[error("failed to migrate persistent database {path}")]
    Migration {
        path: PathBuf,
        #[source]
        source: Box<PersistenceError>,
    },
    #[error("failed to protect persistent storage before mutation")]
    Backup(#[source] BackupError),
    #[error("failed to publish identity marker {path}")]
    MarkerPublish {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub async fn prepare_store(config: &ServerConfig) -> Result<PreparedStore, StoreStartupError> {
    let resolved_data_root = config
        .resolved_data_root
        .as_ref()
        .ok_or(StoreStartupError::DataRootUnresolved)?;
    let mut resolved_config = config.clone();
    resolved_config
        .base_dir
        .clone_from(&resolved_data_root.effective);
    let paths = StatePaths::from_config(&resolved_config);
    let _operation_guard = StoreOperationGuard::acquire_for_startup(&paths)
        .await
        .map_err(StoreStartupError::Backup)?;
    if try_exists(&paths.recovery_journal())? {
        return Err(StoreStartupError::RecoveryIncomplete {
            path: paths.recovery_journal(),
        });
    }
    if let Some(path) = recovery_staging_entry(&paths)? {
        return Err(StoreStartupError::RecoveryIncomplete { path });
    }
    let database_exists = try_exists(&paths.database)?;
    let environment_marker = try_exists(&paths.environment_id)?
        .then(|| read_marker::<EnvironmentId>(&paths.environment_id))
        .transpose()?;
    let storage_marker = try_exists(&paths.storage_instance_id)?
        .then(|| read_marker::<StorageInstanceId>(&paths.storage_instance_id))
        .transpose()?;

    match (database_exists, environment_marker, storage_marker) {
        (false, None, None) => prepare_first_run(paths).await,
        (false, environment_marker, storage_marker) => Err(StoreStartupError::DatabaseMissing {
            database: paths.database,
            marker: if storage_marker.is_some() {
                paths.storage_instance_id
            } else {
                debug_assert!(environment_marker.is_some());
                paths.environment_id
            },
        }),
        (true, None, None) => {
            prepare_existing_unmarked(paths, &resolved_config.server_version).await
        }
        (true, Some(legacy), None) => {
            prepare_existing_legacy(
                paths,
                StorageInstanceId::from_uuid(legacy.as_uuid()),
                &resolved_config.server_version,
            )
            .await
        }
        (true, None, Some(storage_instance_id)) => {
            prepare_existing_after_storage(
                paths,
                storage_instance_id,
                &resolved_config.server_version,
            )
            .await
        }
        (true, Some(environment_id), Some(storage_instance_id))
            if environment_id.as_uuid() == storage_instance_id.as_uuid() =>
        {
            finish_interrupted_legacy_migration(
                paths,
                storage_instance_id,
                &resolved_config.server_version,
            )
            .await
        }
        (true, Some(environment_id), Some(storage_instance_id)) => {
            prepare_existing(
                paths,
                environment_id,
                storage_instance_id,
                &resolved_config.server_version,
            )
            .await
        }
    }
}

fn recovery_staging_entry(paths: &StatePaths) -> Result<Option<PathBuf>, StoreStartupError> {
    let entries =
        std::fs::read_dir(&paths.base_dir).map_err(|source| StoreStartupError::Inspect {
            path: paths.base_dir.clone(),
            source,
        })?;
    for entry in entries {
        let entry = entry.map_err(|source| StoreStartupError::Inspect {
            path: paths.base_dir.clone(),
            source,
        })?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(operation_id) = name
            .strip_prefix('.')
            .and_then(|name| name.strip_suffix(".recovery-staging"))
        else {
            continue;
        };
        if Uuid::parse_str(operation_id).is_ok() {
            return Ok(Some(entry.path()));
        }
    }
    Ok(None)
}

fn try_exists(path: &std::path::Path) -> Result<bool, StoreStartupError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(StoreStartupError::Inspect {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn read_marker<T>(path: &std::path::Path) -> Result<T, StoreStartupError>
where
    T: IdentityMarker,
{
    let bytes = std::fs::read(path).map_err(|source| StoreStartupError::MarkerRead {
        path: path.to_path_buf(),
        source,
    })?;
    let value = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| StoreStartupError::MarkerMalformed {
            path: path.to_path_buf(),
        })?;
    Ok(T::from_uuid(value))
}

async fn prepare_first_run(paths: StatePaths) -> Result<PreparedStore, StoreStartupError> {
    let database = Database::create_new(&paths.database)
        .await
        .map_err(|source| StoreStartupError::DatabaseOpen {
            path: paths.database.clone(),
            source: Box::new(source),
        })?;
    migrate(&database, &paths.database).await?;
    let storage_instance_id = publish_marker(
        &paths.state_dir,
        &paths.storage_instance_id,
        StorageInstanceId::random(),
    )
    .await?;
    let environment_id = publish_marker(
        &paths.state_dir,
        &paths.environment_id,
        EnvironmentId::random(),
    )
    .await?;
    Ok(PreparedStore {
        database,
        environment_id,
        storage_instance_id,
        classification: StoreClassification::FirstRun,
        paths,
    })
}

async fn prepare_existing_unmarked(
    paths: StatePaths,
    app_version: &str,
) -> Result<PreparedStore, StoreStartupError> {
    validate_existing_store(&paths.database).await?;
    let storage_instance_id = publish_marker(
        &paths.state_dir,
        &paths.storage_instance_id,
        StorageInstanceId::random(),
    )
    .await?;
    let environment_id = publish_marker(
        &paths.state_dir,
        &paths.environment_id,
        EnvironmentId::random(),
    )
    .await?;
    prepare_existing_database(
        paths,
        environment_id,
        storage_instance_id,
        StoreClassification::ExistingUnmarked,
        app_version,
    )
    .await
}

async fn prepare_existing_legacy(
    paths: StatePaths,
    storage_instance_id: StorageInstanceId,
    app_version: &str,
) -> Result<PreparedStore, StoreStartupError> {
    validate_existing_store(&paths.database).await?;
    migrate_legacy_storage_marker(&paths, storage_instance_id).await?;
    let environment_id = publish_marker(
        &paths.state_dir,
        &paths.environment_id,
        EnvironmentId::random(),
    )
    .await?;
    prepare_existing_database(
        paths,
        environment_id,
        storage_instance_id,
        StoreClassification::Existing,
        app_version,
    )
    .await
}

async fn prepare_existing_after_storage(
    paths: StatePaths,
    storage_instance_id: StorageInstanceId,
    app_version: &str,
) -> Result<PreparedStore, StoreStartupError> {
    validate_existing_store(&paths.database).await?;
    let environment_id = publish_marker(
        &paths.state_dir,
        &paths.environment_id,
        EnvironmentId::random(),
    )
    .await?;
    prepare_existing_database(
        paths,
        environment_id,
        storage_instance_id,
        StoreClassification::Existing,
        app_version,
    )
    .await
}

async fn finish_interrupted_legacy_migration(
    paths: StatePaths,
    storage_instance_id: StorageInstanceId,
    app_version: &str,
) -> Result<PreparedStore, StoreStartupError> {
    validate_existing_store(&paths.database).await?;
    remove_marker(&paths.state_dir, &paths.environment_id).await?;
    let environment_id = publish_marker(
        &paths.state_dir,
        &paths.environment_id,
        EnvironmentId::random(),
    )
    .await?;
    prepare_existing_database(
        paths,
        environment_id,
        storage_instance_id,
        StoreClassification::Existing,
        app_version,
    )
    .await
}

async fn prepare_existing(
    paths: StatePaths,
    environment_id: EnvironmentId,
    storage_instance_id: StorageInstanceId,
    app_version: &str,
) -> Result<PreparedStore, StoreStartupError> {
    validate_existing_store(&paths.database).await?;
    prepare_existing_database(
        paths,
        environment_id,
        storage_instance_id,
        StoreClassification::Existing,
        app_version,
    )
    .await
}

async fn prepare_existing_database(
    paths: StatePaths,
    environment_id: EnvironmentId,
    storage_instance_id: StorageInstanceId,
    classification: StoreClassification,
    app_version: &str,
) -> Result<PreparedStore, StoreStartupError> {
    let inspection_database = Database::open_existing_read_only(&paths.database)
        .await
        .map_err(|source| StoreStartupError::DatabaseOpen {
            path: paths.database.clone(),
            source: Box::new(source),
        })?;
    let pending = match inspect_pending_migrations(&inspection_database, &paths.database).await {
        Ok(pending) => pending,
        Err(error) => {
            inspection_database.close().await;
            return Err(error);
        }
    };
    let backup_result = if pending.is_empty() {
        Ok(())
    } else {
        let backup_context = PreparedStore {
            database: inspection_database.clone(),
            environment_id,
            storage_instance_id,
            classification,
            paths: paths.clone(),
        };
        let result = create_verified_backup(
            &inspection_database,
            &backup_context,
            BackupTrigger::PreMigration,
            app_version,
        )
        .await
        .map(|_| ())
        .map_err(StoreStartupError::Backup);
        drop(backup_context);
        result
    };
    inspection_database.close().await;
    backup_result?;

    let database = Database::open_existing(&paths.database)
        .await
        .map_err(|source| StoreStartupError::DatabaseOpen {
            path: paths.database.clone(),
            source: Box::new(source),
        })?;
    apply_pending_migrations(&database, &paths.database, pending).await?;
    Ok(PreparedStore {
        database,
        environment_id,
        storage_instance_id,
        classification,
        paths,
    })
}

pub(crate) async fn validate_existing_store(
    path: &std::path::Path,
) -> Result<(), StoreStartupError> {
    validate_with_operation(path.to_path_buf(), |path, cancellation| {
        validate_existing_bibcode_store(&path, &cancellation)
    })
    .await
}

pub(crate) async fn validate_existing_store_for_inspection(
    path: &std::path::Path,
) -> Result<(), StoreStartupError> {
    let wal = sqlite_sidecar(path, "-wal");
    let shm = sqlite_sidecar(path, "-shm");
    let has_sidecars = try_exists(&wal)? || try_exists(&shm)?;
    validate_with_operation(path.to_path_buf(), move |path, cancellation| {
        if has_sidecars {
            validate_existing_bibcode_store(&path, &cancellation)
        } else {
            validate_existing_bibcode_store_immutable(&path, &cancellation)
        }
    })
    .await
}

fn sqlite_sidecar(path: &std::path::Path, suffix: &str) -> PathBuf {
    let mut sidecar = path.as_os_str().to_os_string();
    sidecar.push(suffix);
    PathBuf::from(sidecar)
}

async fn validate_with_operation<F>(path: PathBuf, operation: F) -> Result<(), StoreStartupError>
where
    F: FnOnce(PathBuf, CancellationToken) -> std::result::Result<(), ExistingStoreValidationError>
        + Send
        + 'static,
{
    validate_with_operation_inner(path, operation, || {}).await
}

#[cfg(test)]
async fn validate_with_operation_and_spawn_observer<F, O>(
    path: PathBuf,
    operation: F,
    worker_submitted: O,
) -> Result<(), StoreStartupError>
where
    F: FnOnce(PathBuf, CancellationToken) -> std::result::Result<(), ExistingStoreValidationError>
        + Send
        + 'static,
    O: FnOnce(),
{
    validate_with_operation_inner(path, operation, worker_submitted).await
}

async fn validate_with_operation_inner<F, O>(
    path: PathBuf,
    operation: F,
    worker_submitted: O,
) -> Result<(), StoreStartupError>
where
    F: FnOnce(PathBuf, CancellationToken) -> std::result::Result<(), ExistingStoreValidationError>
        + Send
        + 'static,
    O: FnOnce(),
{
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = CancelValidationOnDrop(cancellation.clone());
    let error_path = path.clone();
    let worker = tokio::task::spawn_blocking(move || operation(path, cancellation));
    worker_submitted();
    let result = worker
        .await
        .map_err(|source| StoreStartupError::UnsafeDatabaseState {
            path: error_path,
            detail: format!("validation blocking task failed: {source}"),
        })?;
    result.map_err(|error| map_validation_error(&error))
}

struct CancelValidationOnDrop(CancellationToken);

impl Drop for CancelValidationOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

fn map_validation_error(error: &ExistingStoreValidationError) -> StoreStartupError {
    match error {
        ExistingStoreValidationError::Corrupt { path, detail } => {
            StoreStartupError::CorruptDatabase {
                path: path.clone(),
                detail: detail.clone(),
            }
        }
        ExistingStoreValidationError::Unrecognized { path, detail } => {
            StoreStartupError::UnrecognizedStore {
                path: path.clone(),
                detail: detail.clone(),
            }
        }
        ExistingStoreValidationError::Unsafe { path, detail } => {
            StoreStartupError::UnsafeDatabaseState {
                path: path.clone(),
                detail: detail.clone(),
            }
        }
    }
}

async fn migrate(database: &Database, path: &std::path::Path) -> Result<(), StoreStartupError> {
    database
        .call(|connection| {
            run_migrations(connection, None)?;
            Ok(())
        })
        .await
        .map_err(|source| StoreStartupError::Migration {
            path: path.to_path_buf(),
            source: Box::new(source),
        })
}

async fn inspect_pending_migrations(
    database: &Database,
    path: &std::path::Path,
) -> Result<Vec<Migration>, StoreStartupError> {
    database
        .call(|connection| Ok(pending_migrations(connection)?))
        .await
        .map_err(|source| StoreStartupError::Migration {
            path: path.to_path_buf(),
            source: Box::new(source),
        })
}

async fn apply_pending_migrations(
    database: &Database,
    path: &std::path::Path,
    pending: Vec<Migration>,
) -> Result<(), StoreStartupError> {
    database
        .call(move |connection| {
            apply_migrations(connection, &pending)?;
            Ok(())
        })
        .await
        .map_err(|source| StoreStartupError::Migration {
            path: path.to_path_buf(),
            source: Box::new(source),
        })
}

async fn migrate_legacy_storage_marker(
    paths: &StatePaths,
    expected: StorageInstanceId,
) -> Result<(), StoreStartupError> {
    let observed = read_marker::<StorageInstanceId>(&paths.environment_id)?;
    if observed != expected {
        return Err(StoreStartupError::MarkerMalformed {
            path: paths.environment_id.clone(),
        });
    }
    match fs::hard_link(&paths.environment_id, &paths.storage_instance_id).await {
        Ok(()) => {}
        Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
            let published = read_marker::<StorageInstanceId>(&paths.storage_instance_id)?;
            if published != expected {
                return Err(StoreStartupError::MarkerMalformed {
                    path: paths.storage_instance_id.clone(),
                });
            }
        }
        Err(source) => {
            return Err(StoreStartupError::MarkerPublish {
                path: paths.storage_instance_id.clone(),
                source,
            });
        }
    }
    sync_state_directory(&paths.state_dir).map_err(|source| StoreStartupError::MarkerPublish {
        path: paths.storage_instance_id.clone(),
        source,
    })?;
    remove_marker(&paths.state_dir, &paths.environment_id).await
}

async fn remove_marker(
    state_dir: &std::path::Path,
    marker_path: &std::path::Path,
) -> Result<(), StoreStartupError> {
    fs::remove_file(marker_path)
        .await
        .map_err(|source| StoreStartupError::MarkerPublish {
            path: marker_path.to_path_buf(),
            source,
        })?;
    sync_state_directory(state_dir).map_err(|source| StoreStartupError::MarkerPublish {
        path: marker_path.to_path_buf(),
        source,
    })
}

async fn publish_marker<T>(
    state_dir: &std::path::Path,
    marker_path: &std::path::Path,
    proposed: T,
) -> Result<T, StoreStartupError>
where
    T: IdentityMarker,
{
    let marker_name = marker_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("identity");
    let temporary_path = state_dir.join(format!(".{marker_name}.{}.tmp", Uuid::new_v4()));
    let result = async {
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .await
            .map_err(|source| StoreStartupError::MarkerPublish {
                path: marker_path.to_path_buf(),
                source,
            })?;
        temporary
            .write_all(format!("{proposed}\n").as_bytes())
            .await
            .map_err(|source| StoreStartupError::MarkerPublish {
                path: marker_path.to_path_buf(),
                source,
            })?;
        temporary
            .sync_all()
            .await
            .map_err(|source| StoreStartupError::MarkerPublish {
                path: marker_path.to_path_buf(),
                source,
            })?;
        drop(temporary);

        // A same-directory hard link is the portable atomic no-replace publish primitive:
        // it fails when any final entry exists, while the linked bytes are already flushed.
        // Cleanup below removes only the staging name and never the published final link.
        match fs::hard_link(&temporary_path, marker_path).await {
            Ok(()) => {
                sync_state_directory(state_dir).map_err(|source| {
                    StoreStartupError::MarkerPublish {
                        path: marker_path.to_path_buf(),
                        source,
                    }
                })?;
                Ok(proposed)
            }
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                let published = read_marker::<T>(marker_path)?;
                sync_state_directory(state_dir).map_err(|source| {
                    StoreStartupError::MarkerPublish {
                        path: marker_path.to_path_buf(),
                        source,
                    }
                })?;
                Ok(published)
            }
            Err(source) => Err(StoreStartupError::MarkerPublish {
                path: marker_path.to_path_buf(),
                source,
            }),
        }
    }
    .await;
    let _ = fs::remove_file(&temporary_path).await;
    result
}

#[cfg(unix)]
fn sync_state_directory(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_state_directory(_path: &std::path::Path) -> std::io::Result<()> {
    // Rust's standard library cannot open Windows directories for flushing. The linked marker
    // itself was flushed before publication, and the no-replace hard-link operation still applies.
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tempfile::TempDir;

    use super::*;

    fn prepared_test_config(root: &std::path::Path) -> ServerConfig {
        let mut config = ServerConfig::new(root);
        let resolved = crate::resolve_data_root(config.data_root_request.clone())
            .expect("resolve test data root");
        config.base_dir.clone_from(&resolved.effective);
        config.resolved_data_root = Some(resolved);
        config
    }

    fn marker_text(path: &std::path::Path) -> String {
        std::fs::read_to_string(path)
            .expect("read identity marker")
            .trim()
            .to_owned()
    }

    async fn create_test_state(paths: &StatePaths) {
        paths
            .ensure_directories_without_database_side_effects()
            .await
            .expect("state directories");
    }

    fn create_current_test_database(paths: &StatePaths) {
        let mut connection = rusqlite::Connection::open(&paths.database).expect("fixture database");
        run_migrations(&mut connection, None).expect("fixture migrations");
    }

    fn write_test_marker(path: &std::path::Path, value: Uuid) {
        std::fs::write(path, format!("{value}\n")).expect("identity marker fixture");
    }

    #[tokio::test]
    async fn first_run_publishes_distinct_environment_and_storage_ids() {
        let root = TempDir::new().expect("temporary store root");
        let config = prepared_test_config(root.path());
        let paths = StatePaths::from_config(&config);
        create_test_state(&paths).await;
        let prepared = prepare_store(&config)
            .await
            .expect("prepare first-run store");

        assert_ne!(
            prepared.environment_id.to_string(),
            prepared.storage_instance_id.to_string()
        );
        assert_eq!(
            marker_text(&prepared.paths.environment_id),
            prepared.environment_id.to_string()
        );
        assert_eq!(
            marker_text(&prepared.paths.storage_instance_id),
            prepared.storage_instance_id.to_string()
        );
    }

    #[tokio::test]
    async fn legacy_marker_becomes_storage_id_and_retry_keeps_both_ids() {
        let root = TempDir::new().expect("temporary store root");
        let config = prepared_test_config(root.path());
        let paths = StatePaths::from_config(&config);
        create_test_state(&paths).await;
        create_current_test_database(&paths);
        let legacy_storage_id = Uuid::new_v4();
        write_test_marker(&paths.environment_id, legacy_storage_id);

        let first = prepare_store(&config).await.expect("migrate legacy marker");
        let first_environment_id = first.environment_id;
        assert_eq!(
            first.storage_instance_id.to_string(),
            legacy_storage_id.to_string()
        );
        first.database.close().await;
        let second = prepare_store(&config).await.expect("retry migrated store");

        assert_eq!(second.environment_id, first_environment_id);
        assert_eq!(
            second.storage_instance_id.to_string(),
            legacy_storage_id.to_string()
        );
        assert_eq!(
            marker_text(&second.paths.environment_id),
            second.environment_id.to_string()
        );
        assert_eq!(
            marker_text(&second.paths.storage_instance_id),
            legacy_storage_id.to_string()
        );
    }

    #[tokio::test]
    async fn storage_only_interruption_publishes_environment_and_preserves_storage() {
        let root = TempDir::new().expect("temporary store root");
        let config = prepared_test_config(root.path());
        let paths = StatePaths::from_config(&config);
        create_test_state(&paths).await;
        create_current_test_database(&paths);
        let storage_id = Uuid::new_v4();
        write_test_marker(&paths.storage_instance_id, storage_id);

        let prepared = prepare_store(&config)
            .await
            .expect("finish interrupted marker publication");

        assert_eq!(prepared.classification, StoreClassification::Existing);
        assert_eq!(
            prepared.storage_instance_id,
            StorageInstanceId::from_uuid(storage_id)
        );
        assert_ne!(
            prepared.environment_id.as_uuid(),
            prepared.storage_instance_id.as_uuid()
        );
        assert_eq!(
            marker_text(&paths.storage_instance_id),
            storage_id.to_string()
        );
        assert_eq!(
            marker_text(&paths.environment_id),
            prepared.environment_id.to_string()
        );
    }

    #[tokio::test]
    async fn both_distinct_markers_are_reused_without_republication() {
        let root = TempDir::new().expect("temporary store root");
        let config = prepared_test_config(root.path());
        let paths = StatePaths::from_config(&config);
        create_test_state(&paths).await;
        create_current_test_database(&paths);
        let environment_id = Uuid::new_v4();
        let storage_id = Uuid::new_v4();
        write_test_marker(&paths.environment_id, environment_id);
        write_test_marker(&paths.storage_instance_id, storage_id);
        let environment_bytes = std::fs::read(&paths.environment_id).expect("environment marker");
        let storage_bytes = std::fs::read(&paths.storage_instance_id).expect("storage marker");

        let prepared = prepare_store(&config)
            .await
            .expect("reuse identity markers");

        assert_eq!(
            prepared.environment_id,
            EnvironmentId::from_uuid(environment_id)
        );
        assert_eq!(
            prepared.storage_instance_id,
            StorageInstanceId::from_uuid(storage_id)
        );
        assert_eq!(
            std::fs::read(&paths.environment_id).expect("environment marker after prepare"),
            environment_bytes
        );
        assert_eq!(
            std::fs::read(&paths.storage_instance_id).expect("storage marker after prepare"),
            storage_bytes
        );
    }

    #[tokio::test]
    async fn equal_hard_link_markers_finish_interrupted_legacy_migration() {
        let root = TempDir::new().expect("temporary store root");
        let config = prepared_test_config(root.path());
        let paths = StatePaths::from_config(&config);
        create_test_state(&paths).await;
        create_current_test_database(&paths);
        let legacy_id = Uuid::new_v4();
        write_test_marker(&paths.environment_id, legacy_id);
        std::fs::hard_link(&paths.environment_id, &paths.storage_instance_id)
            .expect("interrupted hard-link migration fixture");

        let prepared = prepare_store(&config)
            .await
            .expect("finish interrupted legacy migration");

        assert_eq!(
            prepared.storage_instance_id,
            StorageInstanceId::from_uuid(legacy_id)
        );
        assert_ne!(prepared.environment_id.as_uuid(), legacy_id);
        assert_eq!(
            marker_text(&paths.storage_instance_id),
            legacy_id.to_string()
        );
        assert_eq!(
            marker_text(&paths.environment_id),
            prepared.environment_id.to_string()
        );
    }

    #[tokio::test]
    async fn racing_first_run_prepares_converge_on_both_identities() {
        let root = TempDir::new().expect("temporary store root");
        let config = prepared_test_config(root.path());
        let paths = StatePaths::from_config(&config);
        create_test_state(&paths).await;

        let (first, second) = tokio::join!(prepare_store(&config), prepare_store(&config));
        let first = first.expect("first racing prepare");
        let second = second.expect("second racing prepare");

        assert_eq!(first.environment_id, second.environment_id);
        assert_eq!(first.storage_instance_id, second.storage_instance_id);
        assert_ne!(
            first.environment_id.as_uuid(),
            first.storage_instance_id.as_uuid()
        );
        assert_eq!(
            [first.classification, second.classification]
                .into_iter()
                .filter(|classification| *classification == StoreClassification::FirstRun)
                .count(),
            1
        );
        first.database.close().await;
        second.database.close().await;
    }

    #[tokio::test]
    async fn database_without_markers_adopts_once_and_publishes_both_identities() {
        let root = TempDir::new().expect("temporary store root");
        let config = prepared_test_config(root.path());
        let paths = StatePaths::from_config(&config);
        create_test_state(&paths).await;
        create_current_test_database(&paths);

        let first = prepare_store(&config)
            .await
            .expect("adopt unmarked database");
        let environment_id = first.environment_id;
        let storage_id = first.storage_instance_id;
        assert_eq!(first.classification, StoreClassification::ExistingUnmarked);
        first.database.close().await;
        let second = prepare_store(&config)
            .await
            .expect("reuse adopted database");

        assert_eq!(second.environment_id, environment_id);
        assert_eq!(second.storage_instance_id, storage_id);
        assert_eq!(second.classification, StoreClassification::Existing);
    }

    #[tokio::test]
    async fn either_marker_without_database_blocks_first_run_without_mutation() {
        for marker_name in ["environment", "storage"] {
            let root = TempDir::new().expect("temporary store root");
            let config = prepared_test_config(root.path());
            let paths = StatePaths::from_config(&config);
            create_test_state(&paths).await;
            let marker_path = if marker_name == "environment" {
                &paths.environment_id
            } else {
                &paths.storage_instance_id
            };
            let marker_bytes = format!("{}\n", Uuid::new_v4()).into_bytes();
            std::fs::write(marker_path, &marker_bytes).expect("orphaned marker fixture");

            let error = prepare_store(&config)
                .await
                .expect_err("orphaned marker must block first run");

            assert!(matches!(error, StoreStartupError::DatabaseMissing { .. }));
            assert!(!paths.database.exists());
            assert_eq!(
                std::fs::read(marker_path).expect("orphaned marker remains"),
                marker_bytes
            );
        }
    }

    #[tokio::test]
    async fn malformed_either_marker_blocks_without_rewriting_identity_files() {
        for marker_name in ["environment", "storage"] {
            let root = TempDir::new().expect("temporary store root");
            let config = prepared_test_config(root.path());
            let paths = StatePaths::from_config(&config);
            create_test_state(&paths).await;
            create_current_test_database(&paths);
            let marker_path = if marker_name == "environment" {
                &paths.environment_id
            } else {
                &paths.storage_instance_id
            };
            let malformed = format!("malformed-{marker_name}\n").into_bytes();
            std::fs::write(marker_path, &malformed).expect("malformed marker fixture");

            let error = prepare_store(&config)
                .await
                .expect_err("malformed marker must block startup");

            assert!(matches!(error, StoreStartupError::MarkerMalformed { .. }));
            assert_eq!(
                std::fs::read(marker_path).expect("malformed marker remains"),
                malformed
            );
        }
    }

    #[tokio::test]
    async fn no_replace_publication_converges_on_one_marker_and_cleans_staging_files() {
        let root = TempDir::new().expect("temporary marker root");
        let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
        paths
            .ensure_directories_without_database_side_effects()
            .await
            .expect("state directories");
        let first_proposal = EnvironmentId::random();
        let second_proposal = EnvironmentId::random();

        let (first, second) = tokio::join!(
            publish_marker(&paths.state_dir, &paths.environment_id, first_proposal),
            publish_marker(&paths.state_dir, &paths.environment_id, second_proposal)
        );
        let first = first.expect("first publication");
        let second = second.expect("second publication");

        assert_eq!(first, second);
        assert!(first == first_proposal || first == second_proposal);
        let entries = std::fs::read_dir(&paths.state_dir)
            .expect("state entries")
            .map(|entry| entry.expect("state entry").file_name())
            .collect::<Vec<_>>();
        assert!(entries.contains(&"environment-id".into()));
        assert!(
            entries
                .iter()
                .all(|name| !name.to_string_lossy().ends_with(".tmp"))
        );
    }

    #[tokio::test]
    async fn dropping_startup_validation_cancels_the_multibatch_worker_and_releases_writers() {
        let root = TempDir::new().expect("temporary validation root");
        let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
        paths
            .ensure_directories_without_database_side_effects()
            .await
            .expect("state directories");
        let marker_bytes = b"9ad2cc5c-0478-4dc7-850b-d6088ebba5a1\n";
        std::fs::write(&paths.environment_id, marker_bytes).expect("fixture marker");
        let mut setup = rusqlite::Connection::open(&paths.database).expect("fixture database");
        setup
            .pragma_update(None, "page_size", 512)
            .expect("small fixture page size");
        setup
            .pragma_update(None, "journal_mode", "WAL")
            .expect("WAL fixture");
        setup
            .pragma_update(None, "wal_autocheckpoint", 0)
            .expect("disable fixture checkpoint");
        run_migrations(&mut setup, None).expect("fixture migrations");
        setup
            .execute_batch(
                "CREATE TABLE validation_cancellation_fixture (
                   singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                   revision INTEGER NOT NULL,
                   payload BLOB NOT NULL
                 );
                 INSERT INTO validation_cancellation_fixture
                   (singleton, revision, payload) VALUES (1, 0, zeroblob(262144));
                 PRAGMA wal_checkpoint(TRUNCATE);",
            )
            .expect("multi-batch cancellation fixture");
        drop(setup);
        let ledger_rows = rusqlite::Connection::open(&paths.database)
            .expect("ledger reader")
            .query_row("SELECT COUNT(*) FROM effect_sql_migrations", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("fixture ledger count");

        let (step_tx, mut step_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
        let validation_path = paths.database.clone();
        let validation = tokio::spawn(validate_with_operation(
            validation_path,
            move |path, cancellation| {
                let mut first_step = Some((step_tx, release_rx));
                let result =
                    crate::persistence::migrations::validate_existing_bibcode_store_with_control(
                        &path,
                        &cancellation,
                        Duration::from_secs(1),
                        || Ok(()),
                        |state, progress| {
                            if let Some((step_tx, release_rx)) = first_step.take() {
                                step_tx
                                    .send((state, progress.remaining, progress.pagecount))
                                    .expect("observe first backup batch");
                                release_rx
                                    .recv_timeout(Duration::from_secs(2))
                                    .expect("release first backup batch");
                            }
                            Ok(())
                        },
                    );
                let observed = match &result {
                    Ok(()) => Ok(()),
                    Err(error) => Err(error.to_string()),
                };
                finished_tx.send(observed).expect("signal validation exit");
                result
            },
        ));
        let (state, remaining, pagecount) =
            tokio::time::timeout(Duration::from_secs(2), step_rx.recv())
                .await
                .expect("observe in-progress backup promptly")
                .expect("backup progress channel");
        assert_eq!(state, rusqlite::backup::StepResult::More);
        assert!(remaining > 0);
        assert!(pagecount > remaining);

        validation.abort();
        assert!(
            validation
                .await
                .expect_err("startup validation task must abort")
                .is_cancelled()
        );
        let writer = rusqlite::Connection::open(&paths.database).expect("live writer");
        writer
            .execute(
                "UPDATE validation_cancellation_fixture SET revision = 1 WHERE singleton = 1",
                [],
            )
            .expect("writer commits while backup is between batches");
        let busy = writer
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("writer checkpoints while backup is between batches");
        assert_eq!(
            busy, 0,
            "backup must release the source lock between batches"
        );
        release_tx.send(()).expect("release validation worker");
        let worker_result =
            tokio::task::spawn_blocking(move || finished_rx.recv_timeout(Duration::from_secs(1)))
                .await
                .expect("join worker-exit observer")
                .expect("blocking validation worker exits promptly");
        let error = worker_result.expect_err("blocking validation observes cancellation");
        assert!(
            error.contains("cancelled"),
            "typed cancellation detail: {error}"
        );

        assert_eq!(
            std::fs::read(&paths.environment_id).expect("marker remains"),
            marker_bytes
        );
        let (revision, ledger_rows_after) = writer
            .query_row(
                "SELECT
                   (SELECT revision FROM validation_cancellation_fixture WHERE singleton = 1),
                   (SELECT COUNT(*) FROM effect_sql_migrations)",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("post-cancellation database content");
        assert_eq!(revision, 1, "only the explicit writer mutation is present");
        assert_eq!(ledger_rows_after, ledger_rows);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn aborting_during_quick_check_cancels_the_worker_without_mutating_the_store() {
        let root = TempDir::new().expect("temporary validation root");
        let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
        paths
            .ensure_directories_without_database_side_effects()
            .await
            .expect("state directories");
        let marker_bytes = b"58e916d8-3e97-4f9e-bf11-3202b30b0c82\n";
        std::fs::write(&paths.environment_id, marker_bytes).expect("fixture marker");
        let mut setup = rusqlite::Connection::open(&paths.database).expect("fixture database");
        run_migrations(&mut setup, None).expect("fixture migrations");
        drop(setup);
        let before = directory_snapshot(&paths.state_dir);

        let (inspection_tx, mut inspection_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
        let validation_path = paths.database.clone();
        let validation = tokio::spawn(validate_with_operation(
            validation_path,
            move |path, cancellation| {
                let mut first_progress = Some((inspection_tx, release_rx));
                let result = crate::persistence::migrations::validate_existing_bibcode_store_with_inspection_control(
                    &path,
                    &cancellation,
                    Duration::from_secs(1),
                    || Ok(()),
                    |_, _| Ok(()),
                    move || {
                        if let Some((inspection_tx, release_rx)) = first_progress.take() {
                            inspection_tx
                                .send(())
                                .expect("observe quick_check progress");
                            release_rx
                                .recv_timeout(Duration::from_secs(2))
                                .expect("release quick_check progress");
                        }
                    },
                );
                let observation = result.as_ref().map_or_else(
                    |error| {
                        (
                            matches!(
                                error,
                                ExistingStoreValidationError::Unsafe { detail, .. }
                                    if detail.contains("cancelled")
                                        && detail.contains("post-backup SQLite inspection")
                            ),
                            matches!(
                                map_validation_error(error),
                                StoreStartupError::UnsafeDatabaseState { ref detail, .. }
                                    if detail.contains("cancelled")
                                        && detail.contains("post-backup SQLite inspection")
                            ),
                        )
                    },
                    |()| (false, false),
                );
                finished_tx
                    .send(observation)
                    .expect("signal validation worker exit");
                result
            },
        ));
        tokio::time::timeout(Duration::from_secs(2), inspection_rx.recv())
            .await
            .expect("enter quick_check promptly")
            .expect("quick_check progress channel");

        validation.abort();
        assert!(
            validation
                .await
                .expect_err("startup validation task must abort")
                .is_cancelled()
        );
        let worker_exit_started = std::time::Instant::now();
        release_tx.send(()).expect("release quick_check worker");
        let observation =
            tokio::task::spawn_blocking(move || finished_rx.recv_timeout(Duration::from_secs(1)))
                .await
                .expect("join worker-exit observer")
                .expect("blocking validation worker exits within one second");

        assert!(observation.0, "inner validation reports typed cancellation");
        assert!(
            observation.1,
            "store boundary maps cancellation to UnsafeDatabaseState"
        );
        assert!(worker_exit_started.elapsed() <= Duration::from_secs(1));
        assert_eq!(directory_snapshot(&paths.state_dir), before);
        assert_eq!(
            std::fs::read(&paths.environment_id).expect("marker remains"),
            marker_bytes
        );
    }

    #[test]
    fn queued_blocking_validation_observes_cancellation_before_source_open() {
        let root = TempDir::new().expect("temporary validation root");
        let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
        std::fs::create_dir_all(&paths.state_dir).expect("state directory");
        let marker_bytes = b"14dd7d93-ff95-448b-8f54-a19492d92e4d\n";
        std::fs::write(&paths.environment_id, marker_bytes).expect("fixture marker");

        let source_database = root.path().join("source.sqlite");
        let mut source = rusqlite::Connection::open(&source_database).expect("source database");
        source
            .pragma_update(None, "journal_mode", "WAL")
            .expect("WAL source fixture");
        source
            .pragma_update(None, "wal_autocheckpoint", 0)
            .expect("disable source checkpoint");
        run_migrations(&mut source, None).expect("fixture migrations");
        std::fs::copy(&source_database, &paths.database).expect("copy stable main database");
        std::fs::copy(
            sqlite_sidecar(&source_database, "-wal"),
            sqlite_sidecar(&paths.database, "-wal"),
        )
        .expect("copy stable WAL fixture");
        drop(source);
        assert!(!sqlite_sidecar(&paths.database, "-shm").exists());
        let before = directory_snapshot(&paths.state_dir);

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .expect("single-slot blocking runtime");
        runtime.block_on(async {
            let (blocker_started_tx, blocker_started_rx) = std::sync::mpsc::sync_channel(1);
            let (release_blocker_tx, release_blocker_rx) = std::sync::mpsc::sync_channel(0);
            let blocker = tokio::task::spawn_blocking(move || {
                blocker_started_tx.send(()).expect("signal blocker start");
                release_blocker_rx
                    .recv_timeout(Duration::from_secs(2))
                    .expect("release blocking-pool slot");
            });
            blocker_started_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("blocking-pool slot is saturated");

            let (operation_started_tx, operation_started_rx) = std::sync::mpsc::sync_channel(1);
            let (worker_submitted_tx, worker_submitted_rx) = std::sync::mpsc::sync_channel(1);
            let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
            let validation = tokio::spawn(validate_with_operation_and_spawn_observer(
                paths.database.clone(),
                move |path, cancellation| {
                    operation_started_tx
                        .send(())
                        .expect("signal queued operation start");
                    let result = validate_existing_bibcode_store(&path, &cancellation);
                    let observation = result.as_ref().map_or_else(
                        |error| {
                            (
                                matches!(error, ExistingStoreValidationError::Unsafe { detail, .. } if detail.contains("cancelled")),
                                matches!(
                                    map_validation_error(error),
                                    StoreStartupError::UnsafeDatabaseState { ref detail, .. }
                                        if detail.contains("cancelled")
                                ),
                            )
                        },
                        |()| (false, false),
                    );
                    finished_tx
                        .send(observation)
                        .expect("signal queued validation exit");
                    result
                },
                move || {
                    worker_submitted_tx
                        .send(())
                        .expect("signal blocking worker submission");
                },
            ));
            worker_submitted_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("validation job is queued in the blocking pool");
            assert!(
                matches!(
                    operation_started_rx.try_recv(),
                    Err(std::sync::mpsc::TryRecvError::Empty)
                ),
                "validation worker must remain queued behind the saturated slot"
            );

            validation.abort();
            assert!(
                validation
                    .await
                    .expect_err("queued startup validation task must abort")
                    .is_cancelled()
            );
            release_blocker_tx
                .send(())
                .expect("release blocking-pool slot");
            blocker.await.expect("blocking-pool blocker exits");
            operation_started_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("queued validation worker runs after cancellation");
            let observation = finished_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("queued validation worker exits promptly");
            assert!(observation.0, "inner validation reports typed cancellation");
            assert!(
                observation.1,
                "store boundary maps cancellation to UnsafeDatabaseState"
            );
        });

        assert_eq!(directory_snapshot(&paths.state_dir), before);
        assert!(
            !sqlite_sidecar(&paths.database, "-shm").exists(),
            "cancelled queued validation must not open the WAL source"
        );
        assert_eq!(
            std::fs::read(&paths.environment_id).expect("marker remains"),
            marker_bytes
        );
    }

    #[test]
    fn malformed_marker_bytes_are_never_replaced_during_decode() {
        let root = TempDir::new().expect("temporary marker root");
        let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
        std::fs::create_dir_all(&paths.state_dir).expect("state directory");
        let malformed = b"not-a-storage-uuid\n";
        std::fs::write(&paths.environment_id, malformed).expect("malformed marker");

        let error =
            read_marker::<EnvironmentId>(&paths.environment_id).expect_err("marker must fail");

        assert!(matches!(error, StoreStartupError::MarkerMalformed { .. }));
        assert_eq!(
            std::fs::read(&paths.environment_id).expect("marker remains"),
            malformed
        );
    }

    fn directory_snapshot(path: &std::path::Path) -> Vec<(std::ffi::OsString, Vec<u8>)> {
        let mut entries = std::fs::read_dir(path)
            .expect("snapshot directory")
            .map(|entry| {
                let entry = entry.expect("snapshot entry");
                let bytes = if entry.file_type().expect("snapshot entry type").is_file() {
                    std::fs::read(entry.path()).expect("snapshot entry bytes")
                } else {
                    Vec::new()
                };
                (entry.file_name(), bytes)
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        entries
    }

    fn sqlite_sidecar(database: &std::path::Path, suffix: &str) -> PathBuf {
        let mut path = database.as_os_str().to_os_string();
        path.push(suffix);
        PathBuf::from(path)
    }
}
