use std::{fmt, path::PathBuf};

use thiserror::Error;
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
};
use uuid::Uuid;

use crate::config::ServerConfig;

use super::{
    Database, PersistenceError, StatePaths,
    migrations::{ExistingStoreValidationError, run_migrations, validate_existing_bibcode_store},
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct StorageInstanceId(Uuid);

impl fmt::Display for StorageInstanceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
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
    #[error("failed to read storage instance marker {path}")]
    MarkerRead {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("storage instance marker {path} is malformed")]
    MarkerMalformed { path: PathBuf },
    #[error("database {database} is missing while storage marker {marker} remains")]
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
        source: PersistenceError,
    },
    #[error("failed to migrate persistent database {path}")]
    Migration {
        path: PathBuf,
        #[source]
        source: PersistenceError,
    },
    #[error("failed to publish storage instance marker {path}")]
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
    let database_exists = try_exists(&paths.database)?;
    let marker_exists = try_exists(&paths.environment_id)?;
    let marker = marker_exists
        .then(|| read_marker(&paths.environment_id))
        .transpose()?;

    match (database_exists, marker) {
        (false, None) => prepare_first_run(paths).await,
        (false, Some(_)) => Err(StoreStartupError::DatabaseMissing {
            database: paths.database,
            marker: paths.environment_id,
        }),
        (true, None) => prepare_existing_unmarked(paths).await,
        (true, Some(storage_instance_id)) => prepare_existing(paths, storage_instance_id).await,
    }
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

fn read_marker(path: &std::path::Path) -> Result<StorageInstanceId, StoreStartupError> {
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
    Ok(StorageInstanceId(value))
}

async fn prepare_first_run(paths: StatePaths) -> Result<PreparedStore, StoreStartupError> {
    let database = Database::create_new(&paths.database)
        .await
        .map_err(|source| StoreStartupError::DatabaseOpen {
            path: paths.database.clone(),
            source,
        })?;
    migrate(&database, &paths.database).await?;
    let storage_instance_id = publish_marker(&paths, StorageInstanceId(Uuid::new_v4())).await?;
    Ok(PreparedStore {
        database,
        storage_instance_id,
        classification: StoreClassification::FirstRun,
        paths,
    })
}

async fn prepare_existing_unmarked(paths: StatePaths) -> Result<PreparedStore, StoreStartupError> {
    validate(&paths.database)?;
    let database = Database::open_existing(&paths.database)
        .await
        .map_err(|source| StoreStartupError::DatabaseOpen {
            path: paths.database.clone(),
            source,
        })?;
    let storage_instance_id = publish_marker(&paths, StorageInstanceId(Uuid::new_v4())).await?;
    migrate(&database, &paths.database).await?;
    Ok(PreparedStore {
        database,
        storage_instance_id,
        classification: StoreClassification::ExistingUnmarked,
        paths,
    })
}

async fn prepare_existing(
    paths: StatePaths,
    storage_instance_id: StorageInstanceId,
) -> Result<PreparedStore, StoreStartupError> {
    validate(&paths.database)?;
    let database = Database::open_existing(&paths.database)
        .await
        .map_err(|source| StoreStartupError::DatabaseOpen {
            path: paths.database.clone(),
            source,
        })?;
    migrate(&database, &paths.database).await?;
    Ok(PreparedStore {
        database,
        storage_instance_id,
        classification: StoreClassification::Existing,
        paths,
    })
}

fn validate(path: &std::path::Path) -> Result<(), StoreStartupError> {
    validate_existing_bibcode_store(path).map_err(|error| match error {
        ExistingStoreValidationError::Corrupt { path, detail } => {
            StoreStartupError::CorruptDatabase { path, detail }
        }
        ExistingStoreValidationError::Unrecognized { path, detail } => {
            StoreStartupError::UnrecognizedStore { path, detail }
        }
        ExistingStoreValidationError::Unsafe { path, detail } => {
            StoreStartupError::UnsafeDatabaseState { path, detail }
        }
    })
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
            source,
        })
}

async fn publish_marker(
    paths: &StatePaths,
    proposed: StorageInstanceId,
) -> Result<StorageInstanceId, StoreStartupError> {
    let temporary_path = paths
        .state_dir
        .join(format!(".environment-id.{}.tmp", Uuid::new_v4()));
    let result = async {
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .await
            .map_err(|source| StoreStartupError::MarkerPublish {
                path: paths.environment_id.clone(),
                source,
            })?;
        temporary
            .write_all(format!("{proposed}\n").as_bytes())
            .await
            .map_err(|source| StoreStartupError::MarkerPublish {
                path: paths.environment_id.clone(),
                source,
            })?;
        temporary
            .sync_all()
            .await
            .map_err(|source| StoreStartupError::MarkerPublish {
                path: paths.environment_id.clone(),
                source,
            })?;
        drop(temporary);

        // A same-directory hard link is the portable atomic no-replace publish primitive:
        // it fails when any final entry exists, while the linked bytes are already flushed.
        // Cleanup below removes only the staging name and never the published final link.
        match fs::hard_link(&temporary_path, &paths.environment_id).await {
            Ok(()) => {
                sync_state_directory(&paths.state_dir).map_err(|source| {
                    StoreStartupError::MarkerPublish {
                        path: paths.environment_id.clone(),
                        source,
                    }
                })?;
                Ok(proposed)
            }
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                let published = read_marker(&paths.environment_id)?;
                sync_state_directory(&paths.state_dir).map_err(|source| {
                    StoreStartupError::MarkerPublish {
                        path: paths.environment_id.clone(),
                        source,
                    }
                })?;
                Ok(published)
            }
            Err(source) => Err(StoreStartupError::MarkerPublish {
                path: paths.environment_id.clone(),
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
    use tempfile::TempDir;

    use super::*;

    #[tokio::test]
    async fn no_replace_publication_converges_on_one_marker_and_cleans_staging_files() {
        let root = TempDir::new().expect("temporary marker root");
        let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
        paths
            .ensure_directories_without_database_side_effects()
            .await
            .expect("state directories");
        let first_proposal = StorageInstanceId(Uuid::new_v4());
        let second_proposal = StorageInstanceId(Uuid::new_v4());

        let (first, second) = tokio::join!(
            publish_marker(&paths, first_proposal),
            publish_marker(&paths, second_proposal)
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

    #[test]
    fn malformed_marker_bytes_are_never_replaced_during_decode() {
        let root = TempDir::new().expect("temporary marker root");
        let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
        std::fs::create_dir_all(&paths.state_dir).expect("state directory");
        let malformed = b"not-a-storage-uuid\n";
        std::fs::write(&paths.environment_id, malformed).expect("malformed marker");

        let error = read_marker(&paths.environment_id).expect_err("marker must fail");

        assert!(matches!(error, StoreStartupError::MarkerMalformed { .. }));
        assert_eq!(
            std::fs::read(&paths.environment_id).expect("marker remains"),
            malformed
        );
    }
}
