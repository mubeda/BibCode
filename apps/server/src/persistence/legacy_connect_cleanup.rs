use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{Database, PersistenceError, StateFileError, StatePaths, write_json_atomically};

const CLEANUP_VERSION: u32 = 1;
const RECEIPT_FILE: &str = "legacy-connect-cleanup.json";

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LegacyConnectCleanupFailpointForIntegrationTest {
    None,
    BeforeVacuum,
    AfterSqlite,
    AfterOwnedPaths,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyConnectCleanupReceipt {
    pub version: u32,
    pub sqlite_compacted: bool,
    pub owned_paths_removed: bool,
    pub completed_at: String,
}

impl LegacyConnectCleanupReceipt {
    fn is_complete(&self) -> bool {
        self.version == CLEANUP_VERSION && self.sqlite_compacted && self.owned_paths_removed
    }
}

#[derive(Debug, Error)]
pub enum LegacyConnectCleanupError {
    #[error("legacy SQLite privacy cleanup failed")]
    Sqlite(#[source] PersistenceError),
    #[error("legacy privacy cleanup could not inspect owned path {path}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("legacy privacy cleanup found unsafe owned path {path}: {reason}")]
    UnsafeOwnedPath { path: PathBuf, reason: &'static str },
    #[error("legacy privacy cleanup could not remove owned path {path}")]
    RemoveOwnedPath {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("legacy privacy cleanup receipt {path} is malformed")]
    MalformedReceipt {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("legacy privacy cleanup could not persist its completion receipt")]
    PersistReceipt(#[source] StateFileError),
    #[error("legacy privacy cleanup worker failed")]
    Worker(#[source] tokio::task::JoinError),
    #[error("legacy privacy cleanup could not format its completion time")]
    Timestamp(#[source] time::error::Format),
    #[error("legacy privacy cleanup stopped at an injected test failpoint: {0}")]
    InjectedFailure(&'static str),
}

pub async fn complete_legacy_connect_cleanup(
    paths: &StatePaths,
    database: &Database,
) -> Result<LegacyConnectCleanupReceipt, LegacyConnectCleanupError> {
    complete_legacy_connect_cleanup_inner(
        paths,
        database,
        LegacyConnectCleanupFailpointForIntegrationTest::None,
    )
    .await
}

#[doc(hidden)]
pub async fn complete_legacy_connect_cleanup_for_integration_test(
    paths: &StatePaths,
    database: &Database,
    failpoint: LegacyConnectCleanupFailpointForIntegrationTest,
) -> Result<LegacyConnectCleanupReceipt, LegacyConnectCleanupError> {
    complete_legacy_connect_cleanup_inner(paths, database, failpoint).await
}

async fn complete_legacy_connect_cleanup_inner(
    paths: &StatePaths,
    database: &Database,
    failpoint: LegacyConnectCleanupFailpointForIntegrationTest,
) -> Result<LegacyConnectCleanupReceipt, LegacyConnectCleanupError> {
    let receipt_path = paths.state_dir.join(RECEIPT_FILE);
    if let Some(receipt) = read_receipt(&paths.base_dir, &receipt_path)?
        && receipt.is_complete()
    {
        return Ok(receipt);
    }

    compact_sqlite(database, failpoint).await?;
    if failpoint == LegacyConnectCleanupFailpointForIntegrationTest::AfterSqlite {
        return Err(LegacyConnectCleanupError::InjectedFailure("after-sqlite"));
    }

    let owned_paths = paths.clone();
    tokio::task::spawn_blocking(move || remove_verified_owned_paths(&owned_paths))
        .await
        .map_err(LegacyConnectCleanupError::Worker)??;
    if failpoint == LegacyConnectCleanupFailpointForIntegrationTest::AfterOwnedPaths {
        return Err(LegacyConnectCleanupError::InjectedFailure(
            "after-owned-paths",
        ));
    }

    ensure_safe_receipt_target(&paths.base_dir, &receipt_path)?;
    let receipt = LegacyConnectCleanupReceipt {
        version: CLEANUP_VERSION,
        sqlite_compacted: true,
        owned_paths_removed: true,
        completed_at: OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(LegacyConnectCleanupError::Timestamp)?,
    };
    write_json_atomically(&receipt_path, &receipt)
        .await
        .map_err(LegacyConnectCleanupError::PersistReceipt)?;
    Ok(receipt)
}

async fn compact_sqlite(
    database: &Database,
    failpoint: LegacyConnectCleanupFailpointForIntegrationTest,
) -> Result<(), LegacyConnectCleanupError> {
    database
        .call(move |connection| {
            let migration_applied = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM effect_sql_migrations WHERE migration_id = 49)",
                [],
                |row| row.get::<_, bool>(0),
            )?;
            if !migration_applied {
                return Err(PersistenceError::Corrupt(
                    "legacy privacy cleanup migration is not applied".to_owned(),
                ));
            }
            connection.pragma_update(None, "secure_delete", "ON")?;
            let secure_delete =
                connection.query_row("PRAGMA secure_delete", [], |row| row.get::<_, i64>(0))?;
            if secure_delete != 1 {
                return Err(PersistenceError::Corrupt(
                    "SQLite secure_delete is unavailable for legacy privacy cleanup".to_owned(),
                ));
            }
            checkpoint_truncate(connection)?;
            if failpoint == LegacyConnectCleanupFailpointForIntegrationTest::BeforeVacuum {
                return Err(PersistenceError::BackupStopped(
                    "injected legacy privacy cleanup failure before VACUUM".to_owned(),
                ));
            }
            connection.execute_batch("VACUUM")?;
            checkpoint_truncate(connection)?;
            connection.pragma_update(None, "secure_delete", "OFF")?;
            Ok(())
        })
        .await
        .map_err(LegacyConnectCleanupError::Sqlite)
}

fn checkpoint_truncate(connection: &rusqlite::Connection) -> Result<(), PersistenceError> {
    let (busy, log_pages, checkpointed_pages): (i64, i64, i64) =
        connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    if busy != 0 || checkpointed_pages < log_pages {
        return Err(PersistenceError::BackupStopped(format!(
            "legacy privacy cleanup WAL checkpoint remained busy ({checkpointed_pages}/{log_pages} pages)"
        )));
    }
    Ok(())
}

fn read_receipt(
    root: &std::path::Path,
    receipt_path: &std::path::Path,
) -> Result<Option<LegacyConnectCleanupReceipt>, LegacyConnectCleanupError> {
    verify_existing_directory(root, root)?;
    verify_relative_ancestors(root, receipt_path)?;
    let metadata = match fs::symlink_metadata(receipt_path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(LegacyConnectCleanupError::Inspect {
                path: receipt_path.to_path_buf(),
                source,
            });
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LegacyConnectCleanupError::UnsafeOwnedPath {
            path: receipt_path.to_path_buf(),
            reason: "receipt must be a regular file",
        });
    }
    let bytes = fs::read(receipt_path).map_err(|source| LegacyConnectCleanupError::Inspect {
        path: receipt_path.to_path_buf(),
        source,
    })?;
    serde_json::from_slice(&bytes).map(Some).map_err(|source| {
        LegacyConnectCleanupError::MalformedReceipt {
            path: receipt_path.to_path_buf(),
            source,
        }
    })
}

fn ensure_safe_receipt_target(
    root: &std::path::Path,
    receipt_path: &std::path::Path,
) -> Result<(), LegacyConnectCleanupError> {
    verify_relative_ancestors(root, receipt_path)?;
    match fs::symlink_metadata(receipt_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(LegacyConnectCleanupError::UnsafeOwnedPath {
                path: receipt_path.to_path_buf(),
                reason: "receipt must be a regular file",
            })
        }
        Ok(_) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(LegacyConnectCleanupError::Inspect {
            path: receipt_path.to_path_buf(),
            source,
        }),
    }
}

fn remove_verified_owned_paths(paths: &StatePaths) -> Result<(), LegacyConnectCleanupError> {
    let root = &paths.base_dir;
    verify_existing_directory(root, root)?;
    remove_owned_file(root, &paths.state_dir.join("environment-jwt.json"))?;
    let mut retired_tool_name = std::ffi::OsString::from("cloud");
    retired_tool_name.push("flared");
    let tool_directory = root.join("tools").join(retired_tool_name);
    remove_owned_directory(root, &tool_directory)?;
    Ok(())
}

fn remove_owned_file(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<(), LegacyConnectCleanupError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(LegacyConnectCleanupError::Inspect {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    verify_relative_ancestors(root, path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LegacyConnectCleanupError::UnsafeOwnedPath {
            path: path.to_path_buf(),
            reason: "expected a regular file without indirection",
        });
    }
    fs::remove_file(path).map_err(|source| LegacyConnectCleanupError::RemoveOwnedPath {
        path: path.to_path_buf(),
        source,
    })
}

fn remove_owned_directory(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<(), LegacyConnectCleanupError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(LegacyConnectCleanupError::Inspect {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    verify_relative_ancestors(root, path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(LegacyConnectCleanupError::UnsafeOwnedPath {
            path: path.to_path_buf(),
            reason: "expected an owned directory without indirection",
        });
    }
    verify_directory_tree(root, path)?;
    fs::remove_dir_all(path).map_err(|source| LegacyConnectCleanupError::RemoveOwnedPath {
        path: path.to_path_buf(),
        source,
    })
}

fn verify_directory_tree(
    root: &std::path::Path,
    directory: &std::path::Path,
) -> Result<(), LegacyConnectCleanupError> {
    verify_existing_directory(root, directory)?;
    for entry in fs::read_dir(directory).map_err(|source| LegacyConnectCleanupError::Inspect {
        path: directory.to_path_buf(),
        source,
    })? {
        let entry = entry.map_err(|source| LegacyConnectCleanupError::Inspect {
            path: directory.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        let metadata =
            fs::symlink_metadata(&path).map_err(|source| LegacyConnectCleanupError::Inspect {
                path: path.clone(),
                source,
            })?;
        if metadata.file_type().is_symlink() {
            return Err(LegacyConnectCleanupError::UnsafeOwnedPath {
                path,
                reason: "owned directory tree contains indirection",
            });
        }
        if metadata.is_dir() {
            verify_directory_tree(root, &path)?;
        } else if !metadata.is_file() {
            return Err(LegacyConnectCleanupError::UnsafeOwnedPath {
                path,
                reason: "owned directory tree contains an unsupported entry type",
            });
        }
    }
    Ok(())
}

fn verify_relative_ancestors(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<(), LegacyConnectCleanupError> {
    let relative =
        path.strip_prefix(root)
            .map_err(|_| LegacyConnectCleanupError::UnsafeOwnedPath {
                path: path.to_path_buf(),
                reason: "path is outside the resolved data root",
            })?;
    let mut current = root.to_path_buf();
    let components = relative.components().collect::<Vec<_>>();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        current.push(component.as_os_str());
        verify_existing_directory(root, &current)?;
    }
    Ok(())
}

fn verify_existing_directory(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<(), LegacyConnectCleanupError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|source| LegacyConnectCleanupError::Inspect {
            path: path.to_path_buf(),
            source,
        })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(LegacyConnectCleanupError::UnsafeOwnedPath {
            path: path.to_path_buf(),
            reason: "ancestor must be a directory without indirection",
        });
    }
    let canonical =
        fs::canonicalize(path).map_err(|source| LegacyConnectCleanupError::Inspect {
            path: path.to_path_buf(),
            source,
        })?;
    if canonical != path && !canonical.starts_with(root) {
        return Err(LegacyConnectCleanupError::UnsafeOwnedPath {
            path: path.to_path_buf(),
            reason: "ancestor resolves outside the data root",
        });
    }
    Ok(())
}
