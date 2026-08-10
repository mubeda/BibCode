use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{Database, PersistenceError, PreparedStore, StateKind, StatePaths, StorageInstanceId};

const BACKUP_FILE_NAME: &str = "state.sqlite";
const MANIFEST_FILE_NAME: &str = "manifest.json";
const RETAINED_GENERATIONS: usize = 3;
const BACKUP_TIMEOUT: Duration = Duration::from_secs(30);
const LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(5);
const SQLITE_PROGRESS_OPS: i32 = 1_000;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupTrigger {
    PreMigration,
    PreUpdate,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    #[serde(with = "uuid_string")]
    pub backup_id: Uuid,
    pub storage_instance_id: StorageInstanceId,
    pub created_at: String,
    pub state_kind: StateKind,
    pub trigger: BackupTrigger,
    pub app_version: String,
    pub schema_version: i64,
    pub database_size_bytes: u64,
    pub sha256: String,
}

mod uuid_string {
    use serde::{Deserialize, Deserializer, Serializer, de};
    use uuid::Uuid;

    pub fn serialize<S>(value: &Uuid, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Uuid, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Uuid::parse_str(&value).map_err(|_| de::Error::custom("backup ID must be a UUID"))
    }
}

#[derive(Clone, Debug)]
pub struct VerifiedBackup {
    pub directory: PathBuf,
    pub database: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: BackupManifest,
}

impl VerifiedBackup {
    pub async fn manifest_matches_file(&self) -> Result<bool, BackupError> {
        let backup = self.clone();
        let cancellation = CancellationToken::new();
        let _cancel_on_drop = CancelOnDrop(cancellation.clone());
        let deadline = Instant::now()
            .checked_add(BACKUP_TIMEOUT)
            .ok_or(BackupError::DeadlineElapsed)?;
        tokio::task::spawn_blocking(move || {
            backup.manifest_matches_file_blocking(Some(&cancellation), Some(deadline))
        })
        .await
        .map_err(BackupError::Worker)?
    }

    pub async fn quick_check(&self) -> Result<String, BackupError> {
        let database = self.database.clone();
        let cancellation = CancellationToken::new();
        let _cancel_on_drop = CancelOnDrop(cancellation.clone());
        let deadline = Instant::now()
            .checked_add(BACKUP_TIMEOUT)
            .ok_or(BackupError::DeadlineElapsed)?;
        tokio::task::spawn_blocking(move || {
            quick_check_database(&database, Some(&cancellation), Some(deadline))
        })
        .await
        .map_err(BackupError::Worker)?
    }

    fn manifest_matches_file_blocking(
        &self,
        cancellation: Option<&CancellationToken>,
        deadline: Option<Instant>,
    ) -> Result<bool, BackupError> {
        ensure_optional_active(cancellation, deadline)?;
        let bytes = read_manifest_bytes(&self.manifest_path)?;
        let manifest = serde_json::from_slice::<BackupManifest>(&bytes).map_err(|source| {
            BackupError::ManifestDecode {
                path: self.manifest_path.clone(),
                source,
            }
        })?;
        if manifest != self.manifest {
            return Ok(false);
        }
        let (size, sha256) = database_size_and_hash(&self.database, cancellation, deadline)?;
        Ok(size == manifest.database_size_bytes && sha256 == manifest.sha256)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackupInventoryIssue {
    pub entry_name: String,
    pub message: String,
}

#[derive(Clone, Debug, Default)]
pub struct BackupInventory {
    pub verified: Vec<VerifiedBackup>,
    pub issues: Vec<BackupInventoryIssue>,
}

#[derive(Debug, Error)]
pub enum BackupError {
    #[error("failed to access backup path {path}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("SQLite backup failed")]
    Persistence(#[from] PersistenceError),
    #[error("backup worker failed")]
    Worker(#[source] tokio::task::JoinError),
    #[error("failed to encode backup manifest")]
    ManifestEncode(#[source] serde_json::Error),
    #[error("failed to decode backup manifest {path}")]
    ManifestDecode {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("backup at {path} failed SQLite quick_check: {detail}")]
    QuickCheck { path: PathBuf, detail: String },
    #[error("backup verification failed: {0}")]
    Verification(String),
    #[error("backup operation was cancelled")]
    Cancelled,
    #[error("backup operation deadline elapsed")]
    DeadlineElapsed,
    #[error("timed out waiting for the persistent-store operation lock {path}")]
    LockTimeout { path: PathBuf },
}

pub struct StoreOperationGuard {
    lock_file: File,
}

impl StoreOperationGuard {
    pub fn acquire(effective_root: &Path) -> Result<Self, BackupError> {
        let lock_path = effective_root.join(".bibcode-storage.lock");
        let lock_file = open_private_lock_file(&lock_path)?;
        lock_file.lock().map_err(|source| BackupError::Io {
            path: lock_path,
            source,
        })?;
        Ok(Self { lock_file })
    }

    pub(crate) async fn acquire_for_startup(paths: &StatePaths) -> Result<Self, BackupError> {
        let lock_path = paths.operation_lock.clone();
        let cancellation = CancellationToken::new();
        let _cancel_on_drop = CancelOnDrop(cancellation.clone());
        tokio::task::spawn_blocking(move || {
            let lock_file = open_private_lock_file(&lock_path)?;
            let deadline = Instant::now()
                .checked_add(LOCK_WAIT_TIMEOUT)
                .ok_or_else(|| BackupError::LockTimeout {
                    path: lock_path.clone(),
                })?;
            loop {
                if cancellation.is_cancelled() {
                    return Err(BackupError::Cancelled);
                }
                if Instant::now() >= deadline {
                    return Err(BackupError::LockTimeout { path: lock_path });
                }
                match lock_file.try_lock() {
                    Ok(()) => return Ok(Self { lock_file }),
                    Err(std::fs::TryLockError::WouldBlock) => {
                        thread::sleep(LOCK_RETRY_DELAY);
                    }
                    Err(std::fs::TryLockError::Error(source)) => {
                        return Err(BackupError::Io {
                            path: lock_path,
                            source,
                        });
                    }
                }
            }
        })
        .await
        .map_err(BackupError::Worker)?
    }
}

impl Drop for StoreOperationGuard {
    fn drop(&mut self) {
        let _ = self.lock_file.unlock();
    }
}

struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackupFault {
    None,
    BeforeQuickCheck,
    BeforeHash,
    BeforeDatabaseSync,
    BeforeManifestWrite,
    BeforeStagingSync,
    BeforePublish,
    BeforeParentSync,
    BeforeReloadVerification,
}

impl BackupFault {
    fn inject(self, phase: Self) -> Result<(), BackupError> {
        if self == phase {
            Err(BackupError::Verification(format!(
                "injected backup failure at {phase:?}"
            )))
        } else {
            Ok(())
        }
    }
}

pub async fn create_verified_backup(
    database: &Database,
    prepared: &PreparedStore,
    trigger: BackupTrigger,
    app_version: &str,
) -> Result<VerifiedBackup, BackupError> {
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = CancelOnDrop(cancellation.clone());
    let deadline = Instant::now()
        .checked_add(BACKUP_TIMEOUT)
        .ok_or(BackupError::DeadlineElapsed)?;
    let backup_id = Uuid::new_v4();
    let created_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| BackupError::Verification(format!("UTC timestamp failed: {error}")))?;
    let paths = prepared.paths.clone();
    let storage_instance_id = prepared.storage_instance_id;
    let app_version = app_version.to_owned();
    let staging = tokio::task::spawn_blocking({
        let paths = paths.clone();
        let cancellation = cancellation.clone();
        move || {
            prepare_staging_directory(
                &paths,
                storage_instance_id,
                backup_id,
                &cancellation,
                deadline,
            )
        }
    })
    .await
    .map_err(BackupError::Worker)??;

    let result = async {
        database
            .backup_to_cancellable(&staging.database, cancellation.clone(), deadline)
            .await?;
        let verified = tokio::task::spawn_blocking({
            let paths = paths.clone();
            let cancellation = cancellation.clone();
            move || {
                finish_and_publish_backup(
                    &paths,
                    storage_instance_id,
                    trigger,
                    &app_version,
                    backup_id,
                    &created_at,
                    staging,
                    &cancellation,
                    deadline,
                    BackupFault::None,
                )
            }
        })
        .await
        .map_err(BackupError::Worker)??;
        Ok(verified)
    }
    .await;

    if result.is_err() {
        let staging_directory = paths
            .backup_store_dir(storage_instance_id)
            .join(format!(".{backup_id}.staging"));
        let _ = tokio::task::spawn_blocking(move || fs::remove_dir_all(staging_directory)).await;
    }
    result
}

pub async fn inventory_verified_backups(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
) -> Result<BackupInventory, BackupError> {
    let paths = paths.clone();
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = CancelOnDrop(cancellation.clone());
    let deadline = Instant::now()
        .checked_add(BACKUP_TIMEOUT)
        .ok_or(BackupError::DeadlineElapsed)?;
    tokio::task::spawn_blocking(move || {
        inventory_blocking(
            &paths,
            storage_instance_id,
            Some(&cancellation),
            Some(deadline),
        )
    })
    .await
    .map_err(BackupError::Worker)?
}

struct StagedBackup {
    directory: PathBuf,
    database: PathBuf,
    database_reservation: File,
    manifest: PathBuf,
    final_directory: PathBuf,
}

fn prepare_staging_directory(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    backup_id: Uuid,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<StagedBackup, BackupError> {
    ensure_active(cancellation, Some(deadline))?;
    let store_directory = paths.backup_store_dir(storage_instance_id);
    let state_kind_directory = store_directory
        .parent()
        .expect("backup store directory has a state-kind parent");
    for directory in [&paths.backups_dir, state_kind_directory, &store_directory] {
        create_private_directories(directory)?;
    }
    let directory = store_directory.join(format!(".{backup_id}.staging"));
    create_private_directory(&directory)?;
    let database = directory.join(BACKUP_FILE_NAME);
    let database_reservation = private_create_new(&database)?;
    Ok(StagedBackup {
        database,
        database_reservation,
        manifest: directory.join(MANIFEST_FILE_NAME),
        final_directory: store_directory.join(backup_id.to_string()),
        directory,
    })
}

#[allow(clippy::too_many_arguments)]
fn finish_and_publish_backup(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    trigger: BackupTrigger,
    app_version: &str,
    backup_id: Uuid,
    created_at: &str,
    staging: StagedBackup,
    cancellation: &CancellationToken,
    deadline: Instant,
    fault: BackupFault,
) -> Result<VerifiedBackup, BackupError> {
    ensure_active(cancellation, Some(deadline))?;
    drop(staging.database_reservation);
    set_private_file_permissions(&staging.database)?;
    fault.inject(BackupFault::BeforeQuickCheck)?;
    let integrity = quick_check_database(&staging.database, Some(cancellation), Some(deadline))?;
    if integrity != "ok" {
        return Err(BackupError::QuickCheck {
            path: staging.database,
            detail: integrity,
        });
    }
    let schema_version = backup_schema_version(&staging.database, cancellation, deadline)?;
    fault.inject(BackupFault::BeforeHash)?;
    let (database_size_bytes, sha256) =
        database_size_and_hash(&staging.database, Some(cancellation), Some(deadline))?;
    fault.inject(BackupFault::BeforeDatabaseSync)?;
    sync_file(&staging.database)?;
    let manifest = BackupManifest {
        backup_id,
        storage_instance_id,
        created_at: created_at.to_owned(),
        state_kind: paths.state_kind,
        trigger,
        app_version: app_version.to_owned(),
        schema_version,
        database_size_bytes,
        sha256,
    };
    fault.inject(BackupFault::BeforeManifestWrite)?;
    write_manifest(&staging.manifest, &manifest)?;
    fault.inject(BackupFault::BeforeStagingSync)?;
    sync_directory(&staging.directory)?;
    ensure_active(cancellation, Some(deadline))?;
    fault.inject(BackupFault::BeforePublish)?;
    fs::rename(&staging.directory, &staging.final_directory).map_err(|source| BackupError::Io {
        path: staging.final_directory.clone(),
        source,
    })?;
    let store_directory = staging
        .final_directory
        .parent()
        .expect("backup generation has a parent");
    fault.inject(BackupFault::BeforeParentSync)?;
    sync_directory(store_directory)?;

    fault.inject(BackupFault::BeforeReloadVerification)?;
    let verified = verify_generation(
        &staging.final_directory,
        backup_id,
        paths.state_kind,
        storage_instance_id,
        Some(cancellation),
        Some(deadline),
    )?;
    apply_retention(
        paths,
        storage_instance_id,
        backup_id,
        cancellation,
        deadline,
    )?;
    Ok(verified)
}

fn inventory_blocking(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    cancellation: Option<&CancellationToken>,
    deadline: Option<Instant>,
) -> Result<BackupInventory, BackupError> {
    ensure_optional_active(cancellation, deadline)?;
    let store_directory = paths.backup_store_dir(storage_instance_id);
    let entries = match fs::read_dir(&store_directory) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BackupInventory::default());
        }
        Err(source) => {
            return Err(BackupError::Io {
                path: store_directory,
                source,
            });
        }
    };
    let mut inventory = BackupInventory::default();
    for entry in entries {
        ensure_optional_active(cancellation, deadline)?;
        let entry = entry.map_err(|source| BackupError::Io {
            path: store_directory.clone(),
            source,
        })?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name.ends_with(".staging") {
            continue;
        }
        let backup_id = match Uuid::parse_str(&name) {
            Ok(value) => value,
            Err(_) => {
                inventory.issues.push(BackupInventoryIssue {
                    entry_name: name,
                    message: "backup generation name is not a UUID".to_owned(),
                });
                continue;
            }
        };
        let file_type = entry.file_type().map_err(|source| BackupError::Io {
            path: entry.path(),
            source,
        })?;
        if !file_type.is_dir() || file_type.is_symlink() {
            inventory.issues.push(BackupInventoryIssue {
                entry_name: name,
                message: "backup generation is not a plain directory".to_owned(),
            });
            continue;
        }
        match verify_generation(
            &entry.path(),
            backup_id,
            paths.state_kind,
            storage_instance_id,
            cancellation,
            deadline,
        ) {
            Ok(backup) => inventory.verified.push(backup),
            Err(error) => inventory.issues.push(BackupInventoryIssue {
                entry_name: name,
                message: error.to_string(),
            }),
        }
    }
    inventory.verified.sort_by(|left, right| {
        let left_created_at = OffsetDateTime::parse(&left.manifest.created_at, &Rfc3339)
            .expect("verified backup has a parsed creation time");
        let right_created_at = OffsetDateTime::parse(&right.manifest.created_at, &Rfc3339)
            .expect("verified backup has a parsed creation time");
        left_created_at
            .cmp(&right_created_at)
            .then_with(|| left.manifest.backup_id.cmp(&right.manifest.backup_id))
    });
    Ok(inventory)
}

fn verify_generation(
    directory: &Path,
    expected_backup_id: Uuid,
    expected_state_kind: StateKind,
    expected_storage_instance_id: StorageInstanceId,
    cancellation: Option<&CancellationToken>,
    deadline: Option<Instant>,
) -> Result<VerifiedBackup, BackupError> {
    ensure_optional_active(cancellation, deadline)?;
    let metadata = fs::symlink_metadata(directory).map_err(|source| BackupError::Io {
        path: directory.to_path_buf(),
        source,
    })?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(BackupError::Verification(
            "generation is not a plain directory".to_owned(),
        ));
    }
    let manifest_path = directory.join(MANIFEST_FILE_NAME);
    let database = directory.join(BACKUP_FILE_NAME);
    ensure_plain_file(&manifest_path)?;
    ensure_plain_file(&database)?;
    let manifest = serde_json::from_slice::<BackupManifest>(&read_manifest_bytes(&manifest_path)?)
        .map_err(|source| BackupError::ManifestDecode {
            path: manifest_path.clone(),
            source,
        })?;
    if manifest.backup_id != expected_backup_id
        || manifest.storage_instance_id != expected_storage_instance_id
        || manifest.state_kind != expected_state_kind
    {
        return Err(BackupError::Verification(
            "manifest identity does not match its trusted inventory location".to_owned(),
        ));
    }
    let created_at = OffsetDateTime::parse(&manifest.created_at, &Rfc3339).map_err(|_| {
        BackupError::Verification("manifest creation time is not RFC 3339 UTC".to_owned())
    })?;
    if created_at.offset() != UtcOffset::UTC {
        return Err(BackupError::Verification(
            "manifest creation time is not RFC 3339 UTC".to_owned(),
        ));
    }
    if manifest.sha256.len() != 64
        || !manifest
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(BackupError::Verification(
            "manifest checksum is not lowercase SHA-256".to_owned(),
        ));
    }
    let (size, sha256) = database_size_and_hash(&database, cancellation, deadline)?;
    if size != manifest.database_size_bytes || sha256 != manifest.sha256 {
        return Err(BackupError::Verification(
            "manifest size or checksum does not match database".to_owned(),
        ));
    }
    let integrity = quick_check_database(&database, cancellation, deadline)?;
    if integrity != "ok" {
        return Err(BackupError::QuickCheck {
            path: database,
            detail: integrity,
        });
    }
    Ok(VerifiedBackup {
        directory: directory.to_path_buf(),
        database,
        manifest_path,
        manifest,
    })
}

fn apply_retention(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    published_backup_id: Uuid,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<(), BackupError> {
    let inventory = inventory_blocking(
        paths,
        storage_instance_id,
        Some(cancellation),
        Some(deadline),
    )?;
    for issue in &inventory.issues {
        tracing::warn!(
            entry = %issue.entry_name,
            detail = %issue.message,
            "ignored untrusted backup inventory entry"
        );
    }
    let removal_count = inventory
        .verified
        .len()
        .saturating_sub(RETAINED_GENERATIONS);
    for backup in inventory.verified.iter().take(removal_count) {
        ensure_active(cancellation, Some(deadline))?;
        if backup.manifest.backup_id == published_backup_id {
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&backup.directory) {
            tracing::warn!(
                backup_id = %backup.manifest.backup_id,
                detail = %error,
                "failed to delete an expired verified backup"
            );
        }
    }
    Ok(())
}

fn backup_schema_version(
    database: &Path,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<i64, BackupError> {
    ensure_active(cancellation, Some(deadline))?;
    let connection = open_read_only_database(database)?;
    connection
        .query_row(
            "SELECT COALESCE(MAX(migration_id), 0) FROM effect_sql_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|source| BackupError::Persistence(PersistenceError::Sql(source)))
}

fn quick_check_database(
    database: &Path,
    cancellation: Option<&CancellationToken>,
    deadline: Option<Instant>,
) -> Result<String, BackupError> {
    if let Some(cancellation) = cancellation {
        ensure_active(cancellation, deadline)?;
    }
    let connection = open_read_only_database(database)?;
    if let (Some(cancellation), Some(deadline)) = (cancellation, deadline) {
        let cancellation = cancellation.clone();
        connection
            .progress_handler(
                SQLITE_PROGRESS_OPS,
                Some(move || cancellation.is_cancelled() || Instant::now() >= deadline),
            )
            .map_err(|source| BackupError::Persistence(PersistenceError::Sql(source)))?;
    }
    connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|source| {
            if source.sqlite_error_code() == Some(ErrorCode::OperationInterrupted) {
                cancellation.map_or_else(
                    || BackupError::QuickCheck {
                        path: database.to_path_buf(),
                        detail: source.to_string(),
                    },
                    |token| match ensure_active(token, deadline) {
                        Err(error) => error,
                        Ok(()) => BackupError::QuickCheck {
                            path: database.to_path_buf(),
                            detail: "SQLite quick_check was interrupted unexpectedly".to_owned(),
                        },
                    },
                )
            } else {
                BackupError::QuickCheck {
                    path: database.to_path_buf(),
                    detail: source.to_string(),
                }
            }
        })
}

fn open_read_only_database(database: &Path) -> Result<Connection, BackupError> {
    Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|source| {
        BackupError::Persistence(PersistenceError::Open {
            path: database.to_path_buf(),
            source,
        })
    })
}

fn database_size_and_hash(
    database: &Path,
    cancellation: Option<&CancellationToken>,
    deadline: Option<Instant>,
) -> Result<(u64, String), BackupError> {
    ensure_plain_file(database)?;
    let mut file = File::open(database).map_err(|source| BackupError::Io {
        path: database.to_path_buf(),
        source,
    })?;
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if let Some(cancellation) = cancellation {
            ensure_active(cancellation, deadline)?;
        }
        let read = file.read(&mut buffer).map_err(|source| BackupError::Io {
            path: database.to_path_buf(),
            source,
        })?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| BackupError::Verification("backup size overflowed u64".to_owned()))?;
        digest.update(&buffer[..read]);
    }
    let sha256 = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((size, sha256))
}

fn read_manifest_bytes(path: &Path) -> Result<Vec<u8>, BackupError> {
    ensure_plain_file(path)?;
    let metadata = fs::metadata(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(BackupError::Verification(
            "manifest exceeds the bounded inventory size".to_owned(),
        ));
    }
    fs::read(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn write_manifest(path: &Path, manifest: &BackupManifest) -> Result<(), BackupError> {
    let mut contents = serde_json::to_vec_pretty(manifest).map_err(BackupError::ManifestEncode)?;
    contents.push(b'\n');
    let mut file = private_create_new(path)?;
    file.write_all(&contents)
        .and_then(|()| file.sync_all())
        .map_err(|source| BackupError::Io {
            path: path.to_path_buf(),
            source,
        })
}

fn sync_file(path: &Path) -> Result<(), BackupError> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|source| BackupError::Io {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), BackupError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| BackupError::Io {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), BackupError> {
    Ok(())
}

fn ensure_plain_file(path: &Path) -> Result<(), BackupError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
        Ok(())
    } else {
        Err(BackupError::Verification(format!(
            "{} is not a plain file",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("backup entry")
        )))
    }
}

fn create_private_directories(path: &Path) -> Result<(), BackupError> {
    fs::create_dir_all(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| {
            BackupError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<(), BackupError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder.create(path).map_err(|source| BackupError::Io {
            path: path.to_path_buf(),
            source,
        })
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path).map_err(|source| BackupError::Io {
            path: path.to_path_buf(),
            source,
        })
    }
}

fn open_private_lock_file(path: &Path) -> Result<File, BackupError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .map_err(|source| BackupError::Io {
                path: path.to_path_buf(),
                source,
            })
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|source| BackupError::Io {
                path: path.to_path_buf(),
                source,
            })
    }
}

fn private_create_new(path: &Path) -> Result<File, BackupError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|source| BackupError::Io {
                path: path.to_path_buf(),
                source,
            })
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|source| BackupError::Io {
                path: path.to_path_buf(),
                source,
            })
    }
}

fn set_private_file_permissions(path: &Path) -> Result<(), BackupError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|source| {
            BackupError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

fn ensure_active(
    cancellation: &CancellationToken,
    deadline: Option<Instant>,
) -> Result<(), BackupError> {
    if cancellation.is_cancelled() {
        Err(BackupError::Cancelled)
    } else if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        Err(BackupError::DeadlineElapsed)
    } else {
        Ok(())
    }
}

fn ensure_optional_active(
    cancellation: Option<&CancellationToken>,
    deadline: Option<Instant>,
) -> Result<(), BackupError> {
    if let Some(cancellation) = cancellation {
        ensure_active(cancellation, deadline)
    } else if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        Err(BackupError::DeadlineElapsed)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ServerConfig, persistence::run_migrations};
    use tempfile::TempDir;

    fn schema_version(database: &Path) -> i64 {
        Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("schema reader")
            .query_row(
                "SELECT MAX(migration_id) FROM effect_sql_migrations",
                [],
                |row| row.get(0),
            )
            .expect("schema version")
    }

    #[tokio::test]
    async fn every_post_backup_failure_seam_preserves_source_bytes_and_schema() {
        let root = TempDir::new().expect("backup seam root");
        let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
        fs::create_dir_all(&paths.state_dir).expect("state directory");
        let mut setup = Connection::open(&paths.database).expect("source database");
        run_migrations(&mut setup, Some(38)).expect("source schema");
        setup
            .execute_batch(
                "INSERT INTO projection_projects (
                   project_id, title, workspace_root, default_model_selection_json,
                   scripts_json, created_at, updated_at, deleted_at
                 ) VALUES ('protected', 'Protected', '/tmp/protected', NULL, '{}',
                           '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z', NULL)",
            )
            .expect("source row");
        drop(setup);
        let source_bytes = fs::read(&paths.database).expect("source bytes");
        let source_schema = schema_version(&paths.database);
        let database = Database::open_existing_read_only(&paths.database)
            .await
            .expect("read-only source");
        let storage_instance_id = StorageInstanceId::from_uuid(Uuid::new_v4());
        let cancellation = CancellationToken::new();

        for fault in [
            BackupFault::BeforeQuickCheck,
            BackupFault::BeforeHash,
            BackupFault::BeforeDatabaseSync,
            BackupFault::BeforeManifestWrite,
            BackupFault::BeforeStagingSync,
            BackupFault::BeforePublish,
            BackupFault::BeforeParentSync,
            BackupFault::BeforeReloadVerification,
        ] {
            let backup_id = Uuid::new_v4();
            let deadline = Instant::now() + Duration::from_secs(5);
            let staging = prepare_staging_directory(
                &paths,
                storage_instance_id,
                backup_id,
                &cancellation,
                deadline,
            )
            .expect("staging directory");
            database
                .backup_to_cancellable(&staging.database, cancellation.clone(), deadline)
                .await
                .expect("online backup completes before injected seam");
            let error = finish_and_publish_backup(
                &paths,
                storage_instance_id,
                BackupTrigger::PreMigration,
                "seam-test",
                backup_id,
                "2026-08-09T00:00:00Z",
                staging,
                &cancellation,
                deadline,
                fault,
            )
            .expect_err("seam must fail");
            assert!(
                matches!(error, BackupError::Verification(_)),
                "typed seam failure: {error}"
            );
            assert_eq!(
                fs::read(&paths.database).expect("source remains"),
                source_bytes,
                "source bytes changed at {fault:?}"
            );
            assert_eq!(
                schema_version(&paths.database),
                source_schema,
                "source schema changed at {fault:?}"
            );
            let store = paths.backup_store_dir(storage_instance_id);
            let _ = fs::remove_dir_all(store.join(format!(".{backup_id}.staging")));
            let _ = fs::remove_dir_all(store.join(backup_id.to_string()));
        }
        database.close().await;
    }

    #[tokio::test]
    async fn cancellation_before_the_online_backup_worker_runs_creates_no_destination() {
        let root = TempDir::new().expect("cancelled backup root");
        let source = root.path().join("source.sqlite");
        let mut setup = Connection::open(&source).expect("source database");
        run_migrations(&mut setup, Some(38)).expect("source schema");
        drop(setup);
        let before = fs::read(&source).expect("source bytes");
        let database = Database::open_existing_read_only(&source)
            .await
            .expect("read-only source");
        let destination = root.path().join("cancelled.sqlite");
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let error = database
            .backup_to_cancellable(
                &destination,
                cancellation,
                Instant::now() + Duration::from_secs(1),
            )
            .await
            .expect_err("cancelled backup");

        assert!(matches!(error, PersistenceError::BackupStopped(_)));
        assert!(!destination.exists());
        assert_eq!(fs::read(&source).expect("source remains"), before);
        database.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn published_backup_files_and_directories_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = TempDir::new().expect("permission backup root");
        let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
        fs::create_dir_all(&paths.state_dir).expect("state directory");
        let mut setup = Connection::open(&paths.database).expect("source database");
        run_migrations(&mut setup, None).expect("source schema");
        drop(setup);
        let database = Database::open_existing_read_only(&paths.database)
            .await
            .expect("read-only source");
        let storage_instance_id = StorageInstanceId::from_uuid(Uuid::new_v4());
        let prepared = PreparedStore {
            database: database.clone(),
            storage_instance_id,
            classification: crate::persistence::StoreClassification::Existing,
            paths: paths.clone(),
        };

        let backup = create_verified_backup(
            &database,
            &prepared,
            BackupTrigger::PreUpdate,
            "permission-test",
        )
        .await
        .expect("verified backup");

        for directory in [
            paths.backup_store_dir(storage_instance_id),
            backup.directory,
        ] {
            let mode = fs::metadata(directory)
                .expect("directory metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
        }
        for file in [backup.database, backup.manifest_path] {
            let mode = fs::metadata(file)
                .expect("file metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        drop(prepared);
        database.close().await;
    }
}
