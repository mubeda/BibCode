use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime},
};

use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    Database, MIGRATIONS, PersistenceError, PreparedStore, StateKind, StatePaths,
    StorageInstanceId, StoreStartupError,
    database::{AutoVacuumMode, read_page_stats_immutable},
    store::{InspectionOutcome, InspectionOwnership},
};
use crate::{
    ServerConfig,
    data_root::{DataRootRequest, ResolvedDataRoot, resolve_data_root},
};

const BACKUP_FILE_NAME: &str = "state.sqlite";
const MANIFEST_FILE_NAME: &str = "manifest.json";
const RETAINED_GENERATIONS: usize = 3;
pub(super) const BACKUP_TIMEOUT: Duration = Duration::from_secs(30);
const LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(5);
const SQLITE_PROGRESS_OPS: i32 = 1_000;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_PUBLICATION_TIME_SKEW: Duration = Duration::from_secs(60);
pub const RECOVERY_TIMEOUT: Duration = Duration::from_secs(30);
const JOURNAL_VERSION: u32 = 2;
const MAX_JOURNAL_BYTES: u64 = 64 * 1024;
/// The command every "interrupted recovery" refusal names.
pub const RESUME_COMMAND: &str = "bibcode storage restore --resume";

/// A deadline that grows with the bytes an operation reads: a guard against a stuck disk, not a
/// performance target.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StoreIoBudget {
    pub base: Duration,
    pub per_gib: Duration,
}

impl StoreIoBudget {
    /// 30 s, then 4 minutes per GiB: six passes (copy, `quick_check`, hash and their
    /// verification) at 25.6 MiB/s each.
    // shortcut: 240 s per GiB is unmeasured; raise it if #262's measurement shows a slower disk.
    pub const LARGE_STORE: Self = Self {
        base: Duration::from_secs(30),
        per_gib: Duration::from_secs(240),
    };
    /// The pre-update and pre-migration budget.
    pub const FIXED: Self = Self {
        base: BACKUP_TIMEOUT,
        per_gib: Duration::ZERO,
    };
    const CAP: Duration = Duration::from_secs(24 * 60 * 60);

    /// `base + bytes × per_gib / GiB`, rounded up to a millisecond and capped at 24 h.
    #[must_use]
    pub fn for_bytes(self, bytes: u64) -> Duration {
        const GIB: u128 = 1024 * 1024 * 1024;
        let per_gib_ms = self.per_gib.as_millis();
        let extra_ms = (u128::from(bytes) * per_gib_ms).div_ceil(GIB);
        let cap_ms = Self::CAP.as_millis();
        let total_ms = (self.base.as_millis() + extra_ms).min(cap_ms);
        Duration::from_millis(u64::try_from(total_ms).unwrap_or(u64::MAX))
    }
}

/// The deadline `budget` after `start`, clamped to what `Instant` can represent.
fn deadline_after(start: Instant, budget: Duration) -> Instant {
    start
        .checked_add(budget)
        .unwrap_or_else(|| start + StoreIoBudget::CAP)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupTrigger {
    PreMigration,
    PreUpdate,
    PreCompact,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct FileIdentity {
    volume: u64,
    file: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PlainPathSnapshot {
    identity: FileIdentity,
    links: u64,
    size: u64,
    modified: SystemTime,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct VerifiedGenerationIdentity {
    directory: FileIdentity,
    database: FileIdentity,
    manifest: FileIdentity,
    publication_time: SystemTime,
}

#[derive(Clone, Debug)]
struct BoundDirectory {
    path: PathBuf,
    canonical: PathBuf,
    identity: FileIdentity,
    volume: u64,
}

#[derive(Clone, Debug)]
struct BackupStoreBoundary {
    state_kind_value: StateKind,
    root: BoundDirectory,
    backups: BoundDirectory,
    state_kind: BoundDirectory,
    store: BoundDirectory,
}

#[derive(Clone, Debug)]
pub struct VerifiedBackup {
    pub directory: PathBuf,
    pub database: PathBuf,
    pub manifest_path: PathBuf,
    pub manifest: BackupManifest,
    identity: VerifiedGenerationIdentity,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoreInspectionStatus {
    FirstRun,
    ExistingUnmarked,
    Existing,
    DatabaseMissing,
    MarkerMalformed,
    CorruptDatabase,
    UnrecognizedStore,
    UnsafeDatabaseState,
    RecoveryIncomplete,
}

/// The `database` object of `bibcode storage inspect`. Sizes are always reported; page
/// statistics only when a non-mutating header read is possible.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSpace {
    pub file_bytes: u64,
    pub wal_bytes: u64,
    pub shm_bytes: u64,
    pub page_size: Option<u64>,
    pub page_count: Option<u64>,
    pub freelist_count: Option<u64>,
    pub reclaimable_bytes: Option<u64>,
    pub auto_vacuum: Option<AutoVacuumMode>,
    pub database_stats_unavailable: Option<DatabaseStatsUnavailable>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DatabaseStatsUnavailable {
    StoreRunning,
    UncheckpointedWal,
    Unreadable,
}

#[derive(Clone, Debug)]
pub struct StoreInspection {
    pub classification: StoreInspectionStatus,
    pub database: Option<DatabaseSpace>,
    pub storage_instance_id: Option<StorageInstanceId>,
    pub backups: Vec<VerifiedBackup>,
    pub backup_issues: Vec<BackupInventoryIssue>,
    pub requested_root: PathBuf,
    pub effective_root: PathBuf,
    pub is_filesystem_alias: bool,
    pub issue: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryAction {
    Restore,
    StartEmpty,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryResult {
    #[serde(with = "uuid_string")]
    pub operation_id: Uuid,
    pub action: RecoveryAction,
    pub preserved_directory: PathBuf,
    pub storage_instance_id: Option<StorageInstanceId>,
}

#[derive(Debug, Error)]
pub enum RecoveryError {
    #[error("the effective project-data root changed before recovery")]
    RootChanged,
    #[error("the selected verified backup does not exist")]
    BackupNotFound,
    #[error("the selected backup belongs to a different storage instance")]
    StorageIdentityMismatch,
    #[error("the project-data store is currently owned by a running server")]
    StoreRunning,
    #[error(
        "an interrupted project-data recovery remains at {path}; quit BiBCode, then run `{RESUME_COMMAND}` to finish it"
    )]
    RecoveryInProgress { path: PathBuf },
    #[error(
        "the interrupted recovery cannot be finished automatically: {detail}. Keep every file in the data root as it is and see the project-data recovery guide"
    )]
    ResumeRefused { detail: String },
    #[error("The restore was cancelled. The current database was not changed.")]
    RestoreCancelled,
    #[error(
        "The restore did not finish within {}, the limit for a {} backup, so the current database was not changed. Check that the disk is not busy or failing, then retry.",
        format_duration_words(*budget),
        format_bytes(*bytes)
    )]
    RestoreDeadline { budget: Duration, bytes: u64 },
    #[error("the storage instance marker at {path} is malformed")]
    MarkerMalformed { path: PathBuf },
    #[error("project-data recovery failed")]
    Backup(#[from] BackupError),
    #[error("project-data recovery worker failed")]
    Worker(#[source] tokio::task::JoinError),
    #[error("Another program has the database open. Close it, then retry.")]
    DatabaseLocked,
    #[error("{}", insufficient_space_message(volume, *available, *store_required, *temp_required))]
    InsufficientSpace {
        /// The volume that is short: `store` (the data root) or `temp` (SQLite's temporary
        /// files).
        volume: &'static str,
        required: u64,
        available: u64,
        /// Bytes needed on the data-root volume (both needs when it is also the temp volume).
        store_required: u64,
        /// Bytes needed on a separate temporary-files volume; `None` when it is the same one.
        temp_required: Option<u64>,
    },
    #[error("{detail}")]
    NotCompactable { detail: String },
    #[error("{}", cancelled_message(*backup_id))]
    Cancelled { backup_id: Option<Uuid> },
    #[error("{message}")]
    CompactFailed {
        phase: &'static str,
        backup_id: Option<Uuid>,
        message: String,
    },
}

fn cancelled_message(backup_id: Option<Uuid>) -> String {
    match backup_id {
        Some(backup_id) => format!(
            "Compaction was cancelled. The database was not changed. The pre-compact backup {backup_id} is kept."
        ),
        None => "Compaction was cancelled. The database was not changed.".to_owned(),
    }
}

fn insufficient_space_message(
    volume: &str,
    available: u64,
    store_required: u64,
    temp_required: Option<u64>,
) -> String {
    let needs = match temp_required {
        Some(temp) => format!(
            "{} free on the data-root volume and {} on the temporary-files volume",
            format_bytes(store_required),
            format_bytes(temp)
        ),
        None => format!(
            "{} free on the data-root volume",
            format_bytes(store_required)
        ),
    };
    let short = if volume == "temp" {
        "temporary-files"
    } else {
        "data-root"
    };
    let hint = if cfg!(unix) {
        "Free up space or set SQLITE_TMPDIR or TMPDIR to a larger volume, then retry."
    } else {
        "Free up space, then retry."
    };
    format!(
        "Compaction needs {needs}; {} is free on the {short} volume. {hint}",
        format_bytes(available)
    )
}

/// The issue every surface shows for an interrupted recovery.
pub fn interrupted_recovery_message() -> String {
    format!(
        "An interrupted project-data recovery must be finished before BiBCode can open this store. Quit BiBCode, then run `{RESUME_COMMAND}`."
    )
}

/// A limit as people read it, rounded up: `30 seconds`, `1 minute`, `29 minutes`.
pub fn format_duration_words(duration: Duration) -> String {
    let seconds = duration.as_secs() + u64::from(duration.subsec_nanos() > 0);
    if seconds < 60 {
        let unit = if seconds == 1 { "second" } else { "seconds" };
        return format!("{seconds} {unit}");
    }
    let minutes = seconds.div_ceil(60);
    let unit = if minutes == 1 { "minute" } else { "minutes" };
    format!("{minutes} {unit}")
}

/// Decimal units with one fraction digit, as people read disk sizes: `11.2 GB`.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1_000 {
        return format!("{bytes} B");
    }
    #[allow(clippy::cast_precision_loss)]
    let mut value = bytes as f64 / 1_000.0;
    let mut unit = 0;
    while value >= 1_000.0 && unit + 1 < UNITS.len() {
        value /= 1_000.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// Version 2 records the staged files' identities, so `restore --resume` can tell an
/// installed staged file from a live one that still has to be preserved.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryJournal {
    version: u32,
    #[serde(with = "uuid_string")]
    operation_id: Uuid,
    action: RecoveryAction,
    state_kind: StateKind,
    backup_id: Option<String>,
    phase: String,
    preserved_directory: String,
    staged_database: Option<FileIdentity>,
    staged_marker: Option<FileIdentity>,
}

/// The result of `bibcode storage restore --resume`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResult {
    /// The interrupted operation that was finished, if a journal existed.
    pub resumed: Option<RecoveryResult>,
    /// An operation abandoned before its journal was published was cleared.
    pub cleared_abandoned_staging: bool,
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

#[derive(Debug)]
pub struct StoreOperationGuard {
    lock_file: File,
}

#[derive(Debug)]
pub struct StoreRuntimeGuard {
    lock_file: File,
}

impl StoreRuntimeGuard {
    pub async fn acquire(effective_root: &Path) -> Result<Self, BackupError> {
        let lock_path = effective_root.join(".bibcode-runtime.lock");
        let cancellation = CancellationToken::new();
        let _cancel_on_drop = CancelOnDrop(cancellation.clone());
        let deadline = Instant::now()
            .checked_add(LOCK_WAIT_TIMEOUT)
            .ok_or_else(|| BackupError::LockTimeout {
                path: lock_path.clone(),
            })?;
        tokio::task::spawn_blocking(move || {
            let lock_file = open_private_lock_file(&lock_path)?;
            loop {
                ensure_lock_wait_active(
                    &lock_path,
                    &cancellation,
                    &CancellationToken::new(),
                    deadline,
                )?;
                match File::try_lock_shared(&lock_file) {
                    Ok(()) => return Ok(Self { lock_file }),
                    Err(std::fs::TryLockError::WouldBlock) => {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        thread::sleep(LOCK_RETRY_DELAY.min(remaining));
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

impl Drop for StoreRuntimeGuard {
    fn drop(&mut self) {
        let _ = self.lock_file.unlock();
    }
}

pub(super) struct OfflineRecoveryGuard {
    lock_file: File,
}

impl OfflineRecoveryGuard {
    /// Takes the runtime lock exclusively without creating its file. `Ok(None)` means the lock
    /// file does not exist, so no BiBCode process has ever owned the root; `StoreRunning`
    /// means a process holds it now.
    pub(super) fn try_acquire_existing(paths: &StatePaths) -> Result<Option<Self>, RecoveryError> {
        let path = paths.runtime_lock();
        let lock_file = match OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => file,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(BackupError::Io { path, source }.into()),
        };
        match lock_file.try_lock() {
            Ok(()) => Ok(Some(Self { lock_file })),
            Err(std::fs::TryLockError::WouldBlock) => Err(RecoveryError::StoreRunning),
            Err(std::fs::TryLockError::Error(source)) => {
                Err(BackupError::Io { path, source }.into())
            }
        }
    }

    pub(super) fn acquire(paths: &StatePaths) -> Result<Self, RecoveryError> {
        let path = paths.runtime_lock();
        let lock_file = open_private_lock_file(&path)?;
        match lock_file.try_lock() {
            Ok(()) => Ok(Self { lock_file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(RecoveryError::StoreRunning),
            Err(std::fs::TryLockError::Error(source)) => {
                Err(BackupError::Io { path, source }.into())
            }
        }
    }
}

impl Drop for OfflineRecoveryGuard {
    fn drop(&mut self) {
        let _ = self.lock_file.unlock();
    }
}

impl StoreOperationGuard {
    pub async fn acquire(
        effective_root: &Path,
        cancellation: CancellationToken,
        timeout: Duration,
    ) -> Result<Self, BackupError> {
        let lock_path = effective_root.join(".bibcode-storage.lock");
        let deadline =
            Instant::now()
                .checked_add(timeout)
                .ok_or_else(|| BackupError::LockTimeout {
                    path: lock_path.clone(),
                })?;
        let abort = CancellationToken::new();
        let _cancel_on_drop = CancelOnDrop(abort.clone());
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let result =
                acquire_operation_lock_blocking(lock_path, &cancellation, &abort, deadline);
            let _ = sender.send(result);
        });
        let result = receiver.await;
        worker.await.map_err(BackupError::Worker)?;
        result.map_err(|_| {
            BackupError::Verification("operation-lock worker returned no result".to_owned())
        })?
    }

    pub(crate) async fn acquire_for_startup(paths: &StatePaths) -> Result<Self, BackupError> {
        Self::acquire(&paths.base_dir, CancellationToken::new(), LOCK_WAIT_TIMEOUT).await
    }
}

fn acquire_operation_lock_blocking(
    lock_path: PathBuf,
    cancellation: &CancellationToken,
    abort: &CancellationToken,
    deadline: Instant,
) -> Result<StoreOperationGuard, BackupError> {
    let lock_file = open_private_lock_file(&lock_path)?;
    loop {
        ensure_lock_wait_active(&lock_path, cancellation, abort, deadline)?;
        match lock_file.try_lock() {
            Ok(()) => {
                if let Err(error) =
                    ensure_lock_wait_active(&lock_path, cancellation, abort, deadline)
                {
                    let _ = lock_file.unlock();
                    return Err(error);
                }
                return Ok(StoreOperationGuard { lock_file });
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                thread::sleep(LOCK_RETRY_DELAY.min(remaining));
            }
            Err(std::fs::TryLockError::Error(source)) => {
                return Err(BackupError::Io {
                    path: lock_path,
                    source,
                });
            }
        }
    }
}

fn ensure_lock_wait_active(
    lock_path: &Path,
    cancellation: &CancellationToken,
    abort: &CancellationToken,
    deadline: Instant,
) -> Result<(), BackupError> {
    if cancellation.is_cancelled() || abort.is_cancelled() {
        Err(BackupError::Cancelled)
    } else if Instant::now() >= deadline {
        Err(BackupError::LockTimeout {
            path: lock_path.to_path_buf(),
        })
    } else {
        Ok(())
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
    BeforeBackupsDirectorySync,
    BeforeBackupsParentSync,
    BeforeStateKindDirectorySync,
    BeforeStateKindParentSync,
    BeforeStoreDirectorySync,
    BeforeStoreParentSync,
    BeforeQuickCheck,
    BeforeHash,
    BeforeDatabaseSync,
    BeforeManifestWrite,
    BeforeStagingSync,
    BeforePublish,
    BeforeParentSync,
    BeforeReloadVerification,
}

/// Test seams for restore, start-empty and `--resume`. After the journal rename every fault
/// returns at once with no cleanup, which leaves the files as a kill at that step would.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryFault {
    None,
    /// Sleeps after the selected backup is found, before its copy.
    PauseAfterLookup(Duration),
    /// Cancels the restore's token after the selected backup is found.
    CancelAfterLookup,
    BeforeJournal,
    /// Writing the temporary journal fails with `StorageFull`.
    JournalWrite,
    /// Syncing the temporary journal fails with `StorageFull`.
    JournalSync,
    /// Syncing the data root right after the journal rename fails.
    JournalDirectorySync,
    AfterPreserveDatabase,
    AfterPreserveWal,
    AfterPreserveShm,
    AfterPreserveMarker,
    /// Syncing the preserved directory fails.
    PreservedSync,
    AfterPreservedSync,
    /// The historical seam: after every live file is preserved and synced.
    AfterPreserve,
    AfterMoveDatabase,
    AfterMoveMarker,
    AfterRemoveStaging,
}

impl RecoveryFault {
    fn inject(self, phase: Self) -> Result<(), RecoveryError> {
        if self == phase {
            Err(BackupError::Verification(format!("injected recovery failure at {phase:?}")).into())
        } else {
            Ok(())
        }
    }

    fn inject_io(self, phase: Self, path: &Path) -> Result<(), BackupError> {
        if self == phase {
            Err(BackupError::Io {
                path: path.to_path_buf(),
                source: std::io::Error::new(
                    std::io::ErrorKind::StorageFull,
                    format!("injected failure at {phase:?}"),
                ),
            })
        } else {
            Ok(())
        }
    }
}

fn preserve_fault(source: &Path, database: &Path) -> RecoveryFault {
    if source == database {
        RecoveryFault::AfterPreserveDatabase
    } else if source == sqlite_sidecar_path(database, "-wal") {
        RecoveryFault::AfterPreserveWal
    } else if source == sqlite_sidecar_path(database, "-shm") {
        RecoveryFault::AfterPreserveShm
    } else {
        RecoveryFault::AfterPreserveMarker
    }
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
    let deadline = deadline_after(Instant::now(), StoreIoBudget::FIXED.for_bytes(0));
    create_verified_backup_with(
        database,
        prepared,
        trigger,
        app_version,
        CancellationToken::new(),
        deadline,
    )
    .await
}

/// [`create_verified_backup`] with the caller's token and deadline, for a backup whose budget
/// grows with the store (`bibcode storage compact`).
pub async fn create_verified_backup_with(
    database: &Database,
    prepared: &PreparedStore,
    trigger: BackupTrigger,
    app_version: &str,
    cancellation: CancellationToken,
    deadline: Instant,
) -> Result<VerifiedBackup, BackupError> {
    create_backup_run(
        database,
        prepared,
        trigger,
        app_version,
        BackupRun {
            cancellation,
            deadline,
            pause_after_copy: None,
            after_step: None,
        },
    )
    .await
}

/// One backup creation's token, deadline and test seams.
pub(super) struct BackupRun {
    pub cancellation: CancellationToken,
    pub deadline: Instant,
    /// Test seam: sleeps after the online copy, before the staged copy is verified.
    pub pause_after_copy: Option<Duration>,
    /// Test seam: runs after every online-backup step.
    pub after_step: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
}

pub(super) async fn create_backup_run(
    database: &Database,
    prepared: &PreparedStore,
    trigger: BackupTrigger,
    app_version: &str,
    run: BackupRun,
) -> Result<VerifiedBackup, BackupError> {
    let BackupRun {
        cancellation,
        deadline,
        pause_after_copy,
        after_step,
    } = run;
    // Dropping this future stops the blocking workers too.
    let cancellation = cancellation.child_token();
    let _cancel_on_drop = CancelOnDrop(cancellation.clone());
    let backup_id = Uuid::new_v4();
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
                BackupFault::None,
            )
        }
    })
    .await
    .map_err(BackupError::Worker)??;

    let mut copied = database
        .backup_to_cancellable_with(
            &staging.database,
            cancellation.clone(),
            deadline,
            after_step,
        )
        .await
        .map_err(|error| match error {
            PersistenceError::BackupStopped(reason) if reason == "was cancelled" => {
                BackupError::Cancelled
            }
            PersistenceError::BackupStopped(reason) if reason == "deadline elapsed" => {
                BackupError::DeadlineElapsed
            }
            other => BackupError::from(other),
        });
    if copied.is_ok()
        && let Some(pause) = pause_after_copy
    {
        tokio::time::sleep(pause).await;
        copied = ensure_active(&cancellation, Some(deadline));
    }
    if let Err(error) = copied {
        let cleanup = staging.cleanup();
        drop(staging);
        let _ = tokio::task::spawn_blocking(move || cleanup.run()).await;
        return Err(error);
    }
    tokio::task::spawn_blocking({
        let cancellation = cancellation.clone();
        move || {
            finish_and_publish_backup(
                &paths,
                storage_instance_id,
                trigger,
                &app_version,
                backup_id,
                staging,
                &cancellation,
                deadline,
                BackupFault::None,
            )
        }
    })
    .await
    .map_err(BackupError::Worker)?
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

pub async fn inspect_store(root: &ResolvedDataRoot) -> Result<StoreInspection, RecoveryError> {
    inspect_store_inner(root, || {}).await
}

/// [`inspect_store`] with `before_inventory` called once the runtime lock has been released
/// and the backup inventory is about to start.
#[doc(hidden)]
pub async fn inspect_store_for_integration_test<F>(
    root: &ResolvedDataRoot,
    before_inventory: F,
) -> Result<StoreInspection, RecoveryError>
where
    F: FnOnce(),
{
    inspect_store_inner(root, before_inventory).await
}

/// The issue reported when inspection would have to create SQLite files to read the store.
pub(super) const UNOPENED_SIDECARS_ISSUE: &str = "The database has SQLite sidecar files \
    (state.sqlite-wal or -shm) that cannot be inspected without creating files. Start BiBCode \
    once and quit it, or run `bibcode storage compact`, which recovers them under its own lock.";

/// What the state directory shows before SQLite is opened.
pub(super) struct StoreFiles {
    /// `Existing` or `ExistingUnmarked` when the database exists and nothing else needs
    /// attention; the SQLite classifier may still refine it.
    pub(super) classification: StoreInspectionStatus,
    pub(super) storage_instance_id: Option<StorageInstanceId>,
    pub(super) issue: Option<String>,
}

pub(super) fn classify_store_files(paths: &StatePaths) -> Result<StoreFiles, BackupError> {
    if !path_entry_exists(&paths.base_dir)? {
        return Ok(StoreFiles {
            classification: StoreInspectionStatus::FirstRun,
            storage_instance_id: None,
            issue: None,
        });
    }
    let journal_exists = path_entry_exists(&paths.recovery_journal())?;
    let staging = find_recovery_staging_entry(paths)?;
    let database_exists = path_entry_exists(&paths.database)?;
    let marker_exists = path_entry_exists(&paths.environment_id)?;
    let marker = if marker_exists {
        let bytes = fs::read(&paths.environment_id).map_err(|source| BackupError::Io {
            path: paths.environment_id.clone(),
            source,
        })?;
        std::str::from_utf8(&bytes)
            .ok()
            .and_then(|value| Uuid::parse_str(value.trim()).ok())
            .map(StorageInstanceId::from_uuid)
    } else {
        None
    };
    let (classification, issue) = if journal_exists || staging.is_some() {
        (
            StoreInspectionStatus::RecoveryIncomplete,
            Some(interrupted_recovery_message()),
        )
    } else if marker_exists && marker.is_none() {
        (
            StoreInspectionStatus::MarkerMalformed,
            Some("The storage instance marker is malformed.".to_owned()),
        )
    } else {
        match (database_exists, marker) {
            (false, None) => (StoreInspectionStatus::FirstRun, None),
            (false, Some(_)) => (
                StoreInspectionStatus::DatabaseMissing,
                Some("The database is missing while its storage marker remains.".to_owned()),
            ),
            (true, Some(_)) => (StoreInspectionStatus::Existing, None),
            (true, None) => (StoreInspectionStatus::ExistingUnmarked, None),
        }
    };
    Ok(StoreFiles {
        classification,
        storage_instance_id: marker,
        issue,
    })
}

/// Sizes of `state.sqlite`, `-wal` and `-shm`; `None` when the database does not exist. An
/// absent sidecar is `0`.
pub(super) fn database_file_sizes(database: &Path) -> Result<Option<(u64, u64, u64)>, BackupError> {
    let size = |path: &Path| match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata.len())),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(BackupError::Io {
            path: path.to_path_buf(),
            source,
        }),
    };
    let Some(file_bytes) = size(database)? else {
        return Ok(None);
    };
    let wal_bytes = size(&sqlite_sidecar_path(database, "-wal"))?.unwrap_or(0);
    let shm_bytes = size(&sqlite_sidecar_path(database, "-shm"))?.unwrap_or(0);
    Ok(Some((file_bytes, wal_bytes, shm_bytes)))
}

/// Whether `-wal` and `-shm` exist beside `database`.
pub(super) fn sqlite_sidecars_present(database: &Path) -> Result<(bool, bool), BackupError> {
    Ok((
        path_entry_exists(&sqlite_sidecar_path(database, "-wal"))?,
        path_entry_exists(&sqlite_sidecar_path(database, "-shm"))?,
    ))
}

async fn inspect_store_inner<F>(
    root: &ResolvedDataRoot,
    before_inventory: F,
) -> Result<StoreInspection, RecoveryError>
where
    F: FnOnce(),
{
    let current = resolve_data_root(DataRootRequest {
        source: root.source,
        requested: Some(root.requested.clone()),
        home_dir: PathBuf::new(),
    })
    .map_err(|_| RecoveryError::RootChanged)?;
    if current.effective != root.effective {
        return Err(RecoveryError::RootChanged);
    }
    let mut config = ServerConfig::new(&current.effective);
    config.base_dir.clone_from(&current.effective);
    config.resolved_data_root = Some(current.clone());
    let paths = StatePaths::from_config(&config);
    if !path_entry_exists(&paths.base_dir)? {
        return Ok(StoreInspection {
            classification: StoreInspectionStatus::FirstRun,
            database: None,
            storage_instance_id: None,
            backups: Vec::new(),
            backup_issues: Vec::new(),
            requested_root: current.requested,
            effective_root: current.effective,
            is_filesystem_alias: current.is_filesystem_alias,
            issue: None,
        });
    }
    // Whether SQLite may be opened is decided from this lock, held through classification and
    // the stats read, never from an earlier file check.
    let (guard, ownership) = match OfflineRecoveryGuard::try_acquire_existing(&paths) {
        Ok(Some(guard)) => (Some(guard), InspectionOwnership::Offline),
        Ok(None) => (None, InspectionOwnership::NeverOwned),
        Err(RecoveryError::StoreRunning) => (None, InspectionOwnership::Owned),
        Err(error) => return Err(error),
    };
    let files = classify_store_files(&paths)?;
    let (classification, issue) = match files.classification {
        StoreInspectionStatus::Existing | StoreInspectionStatus::ExistingUnmarked => {
            match super::store::validate_existing_store_for_inspection(&paths.database, ownership)
                .await
            {
                Ok(InspectionOutcome::Classified) => (files.classification, None),
                Ok(InspectionOutcome::SidecarsNotOpened) => (
                    StoreInspectionStatus::UnsafeDatabaseState,
                    Some(UNOPENED_SIDECARS_ISSUE.to_owned()),
                ),
                Err(error) => {
                    let status = match &error {
                        StoreStartupError::CorruptDatabase { .. } => {
                            StoreInspectionStatus::CorruptDatabase
                        }
                        StoreStartupError::UnrecognizedStore { .. } => {
                            StoreInspectionStatus::UnrecognizedStore
                        }
                        _ => StoreInspectionStatus::UnsafeDatabaseState,
                    };
                    (status, Some(error.to_string()))
                }
            }
        }
        other => (other, files.issue),
    };
    let database = inspect_database_space(&paths.database, ownership).await?;
    // The inventory reads only `backups/`; its own budget must not stack on a starting
    // server's lock wait.
    drop(guard);
    before_inventory();
    let inventory = if let Some(storage_instance_id) = files.storage_instance_id {
        inventory_verified_backups(&paths, storage_instance_id).await?
    } else {
        inventory_all_verified_backups(&paths).await?
    };
    Ok(StoreInspection {
        classification,
        database,
        storage_instance_id: files.storage_instance_id,
        backups: inventory.verified,
        backup_issues: inventory.issues,
        requested_root: current.requested,
        effective_root: current.effective,
        is_filesystem_alias: current.is_filesystem_alias,
        issue,
    })
}

/// Sizes always; page statistics through an `immutable=1` read only when no BiBCode process
/// owns the root and no sidecar may hold newer pages.
async fn inspect_database_space(
    database: &Path,
    ownership: InspectionOwnership,
) -> Result<Option<DatabaseSpace>, BackupError> {
    let database = database.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let Some((file_bytes, wal_bytes, shm_bytes)) = database_file_sizes(&database)? else {
            return Ok(None);
        };
        let (wal, shm) = sqlite_sidecars_present(&database)?;
        let stats = if ownership == InspectionOwnership::Owned {
            Err(DatabaseStatsUnavailable::StoreRunning)
        } else if wal || shm {
            Err(DatabaseStatsUnavailable::UncheckpointedWal)
        } else {
            read_page_stats_immutable(&database).map_err(|_| DatabaseStatsUnavailable::Unreadable)
        };
        let space = match stats {
            Ok(stats) => DatabaseSpace {
                file_bytes,
                wal_bytes,
                shm_bytes,
                page_size: Some(stats.page_size),
                page_count: Some(stats.page_count),
                freelist_count: Some(stats.freelist_count),
                reclaimable_bytes: Some(stats.freelist_count.saturating_mul(stats.page_size)),
                auto_vacuum: Some(stats.auto_vacuum),
                database_stats_unavailable: None,
            },
            Err(reason) => DatabaseSpace {
                file_bytes,
                wal_bytes,
                shm_bytes,
                page_size: None,
                page_count: None,
                freelist_count: None,
                reclaimable_bytes: None,
                auto_vacuum: None,
                database_stats_unavailable: Some(reason),
            },
        };
        Ok(Some(space))
    })
    .await
    .map_err(BackupError::Worker)?
}

async fn inventory_all_verified_backups(
    paths: &StatePaths,
) -> Result<BackupInventory, BackupError> {
    let paths = paths.clone();
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = CancelOnDrop(cancellation.clone());
    let deadline = Instant::now()
        .checked_add(BACKUP_TIMEOUT)
        .ok_or(BackupError::DeadlineElapsed)?;
    tokio::task::spawn_blocking(move || {
        let state_kind_directory = paths.backups_dir.join(state_kind_name(paths.state_kind));
        let entries = match fs::read_dir(&state_kind_directory) {
            Ok(entries) => entries,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BackupInventory::default());
            }
            Err(source) => {
                return Err(BackupError::Io {
                    path: state_kind_directory,
                    source,
                });
            }
        };
        let mut combined = BackupInventory::default();
        for entry in entries {
            ensure_active(&cancellation, Some(deadline))?;
            let entry = entry.map_err(|source| BackupError::Io {
                path: state_kind_directory.clone(),
                source,
            })?;
            let Some(storage_instance_id) = entry
                .file_name()
                .to_str()
                .and_then(|name| Uuid::parse_str(name).ok())
                .map(StorageInstanceId::from_uuid)
            else {
                combined.issues.push(BackupInventoryIssue {
                    entry_name: entry.file_name().to_string_lossy().into_owned(),
                    message: "backup store directory name is not a storage UUID".to_owned(),
                });
                continue;
            };
            match inventory_blocking(
                &paths,
                storage_instance_id,
                Some(&cancellation),
                Some(deadline),
            ) {
                Ok(mut inventory) => {
                    combined.verified.append(&mut inventory.verified);
                    combined.issues.append(&mut inventory.issues);
                }
                Err(error) => combined.issues.push(BackupInventoryIssue {
                    entry_name: entry.file_name().to_string_lossy().into_owned(),
                    message: error.to_string(),
                }),
            }
        }
        combined
            .verified
            .sort_by_key(|backup| backup.identity.publication_time);
        Ok(combined)
    })
    .await
    .map_err(BackupError::Worker)?
}

pub(super) fn path_entry_exists(path: &Path) -> Result<bool, BackupError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(BackupError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn find_recovery_staging_entry(paths: &StatePaths) -> Result<Option<PathBuf>, BackupError> {
    for entry in fs::read_dir(&paths.base_dir).map_err(|source| BackupError::Io {
        path: paths.base_dir.clone(),
        source,
    })? {
        let entry = entry.map_err(|source| BackupError::Io {
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

pub async fn restore_backup(
    root: &ResolvedDataRoot,
    backup_id: Uuid,
    cancellation: CancellationToken,
) -> Result<RecoveryResult, RecoveryError> {
    restore_backup_inner(
        root,
        backup_id,
        cancellation,
        StoreIoBudget::LARGE_STORE,
        RecoveryFault::None,
    )
    .await
}

#[cfg(test)]
async fn restore_backup_with_fault(
    root: &ResolvedDataRoot,
    backup_id: Uuid,
    fault: RecoveryFault,
) -> Result<RecoveryResult, RecoveryError> {
    restore_backup_inner(
        root,
        backup_id,
        CancellationToken::new(),
        StoreIoBudget::LARGE_STORE,
        fault,
    )
    .await
}

#[cfg(test)]
async fn restore_backup_with_budget(
    root: &ResolvedDataRoot,
    backup_id: Uuid,
    budget: StoreIoBudget,
    fault: RecoveryFault,
) -> Result<RecoveryResult, RecoveryError> {
    restore_backup_inner(root, backup_id, CancellationToken::new(), budget, fault).await
}

fn recovery_paths(
    root: &ResolvedDataRoot,
) -> Result<(StatePaths, ResolvedDataRoot), RecoveryError> {
    let current = resolve_data_root(DataRootRequest {
        source: root.source,
        requested: Some(root.requested.clone()),
        home_dir: PathBuf::new(),
    })
    .map_err(|_| RecoveryError::RootChanged)?;
    if current.effective != root.effective {
        return Err(RecoveryError::RootChanged);
    }
    let mut config = ServerConfig::new(&current.effective);
    config.base_dir.clone_from(&current.effective);
    config.resolved_data_root = Some(current.clone());
    Ok((StatePaths::from_config(&config), current))
}

fn ensure_root_unchanged(
    paths: &StatePaths,
    expected_root: &ResolvedDataRoot,
) -> Result<(), RecoveryError> {
    let current = resolve_data_root(DataRootRequest {
        source: expected_root.source,
        requested: Some(expected_root.requested.clone()),
        home_dir: PathBuf::new(),
    })
    .map_err(|_| RecoveryError::RootChanged)?;
    if current.effective != expected_root.effective || current.effective != paths.base_dir {
        return Err(RecoveryError::RootChanged);
    }
    Ok(())
}

async fn restore_backup_inner(
    root: &ResolvedDataRoot,
    backup_id: Uuid,
    cancellation: CancellationToken,
    budget: StoreIoBudget,
    fault: RecoveryFault,
) -> Result<RecoveryResult, RecoveryError> {
    let (paths, current) = recovery_paths(root)?;
    let _offline = OfflineRecoveryGuard::acquire(&paths)?;
    let cancellation = cancellation.child_token();
    let _cancel_on_drop = CancelOnDrop(cancellation.clone());
    let _guard =
        StoreOperationGuard::acquire(&paths.base_dir, cancellation.clone(), RECOVERY_TIMEOUT)
            .await
            .map_err(|error| match error {
                BackupError::Cancelled => RecoveryError::RestoreCancelled,
                other => other.into(),
            })?;
    let started = Instant::now();
    let deadline = deadline_after(started, budget.for_bytes(0));
    tokio::task::spawn_blocking(move || {
        restore_backup_blocking(
            &paths,
            &current,
            backup_id,
            &cancellation,
            RestoreClock {
                started,
                deadline,
                budget,
            },
            fault,
        )
    })
    .await
    .map_err(RecoveryError::Worker)?
}

#[derive(Clone, Copy)]
struct RestoreClock {
    started: Instant,
    deadline: Instant,
    budget: StoreIoBudget,
}

/// What a restore or start-empty created before its journal was published, removed again
/// when it fails before that point.
#[derive(Default)]
struct PreCommitArtifacts {
    preserved_directory: Option<PathBuf>,
    staging: Option<(BoundDirectory, PathBuf, FileIdentity)>,
    temporary_journal: Option<(PathBuf, FileIdentity)>,
}

impl PreCommitArtifacts {
    fn remove(&self) {
        if let Err(error) = self.try_remove() {
            tracing::warn!(
                detail = %error,
                "an unfinished project-data recovery left files that the next restore clears"
            );
        }
    }

    fn try_remove(&self) -> Result<(), BackupError> {
        if let Some((path, identity)) = &self.temporary_journal {
            remove_file_with_identity(path, *identity)?;
        }
        if let Some((root, directory, identity)) = &self.staging {
            match inspect_child_directory(root, directory) {
                Ok(current) if current.identity == *identity => {
                    remove_owned_files(directory, &[BACKUP_FILE_NAME, MARKER_FILE_NAME])?;
                    remove_directory(directory)?;
                }
                Ok(_) => {
                    return Err(BackupError::Verification(
                        "recovery staging directory changed before cleanup".to_owned(),
                    ));
                }
                Err(BackupError::Io { source, .. })
                    if source.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(directory) = &self.preserved_directory {
            remove_directory(directory)?;
        }
        Ok(())
    }
}

const MARKER_FILE_NAME: &str = "environment-id";

fn restore_backup_blocking(
    paths: &StatePaths,
    expected_root: &ResolvedDataRoot,
    backup_id: Uuid,
    cancellation: &CancellationToken,
    clock: RestoreClock,
    fault: RecoveryFault,
) -> Result<RecoveryResult, RecoveryError> {
    let mut limit = (clock.budget.for_bytes(0), 0_u64);
    let mut artifacts = PreCommitArtifacts::default();
    let staged = stage_restore(
        paths,
        expected_root,
        backup_id,
        cancellation,
        clock,
        fault,
        &mut limit,
        &mut artifacts,
    );
    let journal = match staged {
        Ok(journal) => journal,
        Err(error) => {
            artifacts.remove();
            return Err(match error {
                RecoveryError::Backup(BackupError::DeadlineElapsed) => {
                    RecoveryError::RestoreDeadline {
                        budget: limit.0,
                        bytes: limit.1,
                    }
                }
                RecoveryError::Backup(BackupError::Cancelled) => RecoveryError::RestoreCancelled,
                other => other,
            });
        }
    };
    // The journal rename was the commit point: from here a failure keeps every file for
    // `restore --resume`.
    debug_pause_at("journal-published");
    let preserved_directory = paths.recovery_dir().join(&journal.preserved_directory);
    roll_forward(paths, &journal, fault)?;
    Ok(RecoveryResult {
        operation_id: journal.operation_id,
        action: RecoveryAction::Restore,
        preserved_directory,
        storage_instance_id: read_marker_id(paths)?,
    })
}

#[allow(clippy::too_many_arguments)]
fn stage_restore(
    paths: &StatePaths,
    expected_root: &ResolvedDataRoot,
    backup_id: Uuid,
    cancellation: &CancellationToken,
    clock: RestoreClock,
    fault: RecoveryFault,
    limit: &mut (Duration, u64),
    artifacts: &mut PreCommitArtifacts,
) -> Result<RecoveryJournal, RecoveryError> {
    ensure_active(cancellation, Some(clock.deadline))?;
    ensure_root_unchanged(paths, expected_root)?;
    clear_abandoned_recovery(paths)?;
    let marker_exists = path_entry_exists(&paths.environment_id)?;
    let marker_id = if marker_exists {
        read_marker_id(paths)?
    } else {
        None
    };
    let (selected, deadline) = find_verified_backup_for_recovery(
        paths,
        backup_id,
        cancellation,
        clock.deadline,
        clock.budget,
        clock.started,
    )?
    .ok_or(RecoveryError::BackupNotFound)?;
    *limit = (
        clock
            .budget
            .for_bytes(selected.manifest.database_size_bytes),
        selected.manifest.database_size_bytes,
    );
    if marker_id.is_some_and(|marker_id| selected.manifest.storage_instance_id != marker_id) {
        return Err(RecoveryError::StorageIdentityMismatch);
    }
    match fault {
        RecoveryFault::PauseAfterLookup(pause) => thread::sleep(pause),
        RecoveryFault::CancelAfterLookup => cancellation.cancel(),
        _ => {}
    }
    ensure_active(cancellation, Some(deadline))?;
    let restored_storage_id = selected.manifest.storage_instance_id;

    let root_boundary = inspect_root_directory(&paths.base_dir)?;
    inspect_child_directory(&root_boundary, &paths.state_dir)?;
    let recovery_kind_boundary = ensure_recovery_directories(paths, &root_boundary)?;
    let operation_id = Uuid::new_v4();
    let preserved_name = format!(
        "{}-{operation_id}",
        OffsetDateTime::now_utc().unix_timestamp()
    );
    let preserved_directory = paths.recovery_dir().join(&preserved_name);
    create_private_directory(&preserved_directory)?;
    artifacts.preserved_directory = Some(preserved_directory.clone());
    sync_directory(&preserved_directory)?;
    sync_directory(&paths.recovery_dir())?;
    inspect_child_directory(&recovery_kind_boundary, &preserved_directory)?;

    let staging_directory = paths.recovery_staging_dir(operation_id);
    create_private_directory(&staging_directory)?;
    let staging_boundary = inspect_child_directory(&root_boundary, &staging_directory)?;
    artifacts.staging = Some((
        root_boundary.clone(),
        staging_directory.clone(),
        staging_boundary.identity,
    ));
    let staged_database = staging_directory.join(BACKUP_FILE_NAME);
    copy_verified_database(&selected, &staged_database, cancellation, deadline)?;
    let staged_marker = staging_directory.join(MARKER_FILE_NAME);
    let mut marker = private_create_new(&staged_marker)?;
    marker
        .write_all(format!("{restored_storage_id}\n").as_bytes())
        .and_then(|()| marker.sync_all())
        .map_err(|source| BackupError::Io {
            path: staged_marker.clone(),
            source,
        })?;
    drop(marker);
    sync_directory(&staging_directory)?;
    ensure_active(cancellation, Some(deadline))?;
    fault.inject(RecoveryFault::BeforeJournal)?;

    let journal = RecoveryJournal {
        version: JOURNAL_VERSION,
        operation_id,
        action: RecoveryAction::Restore,
        state_kind: paths.state_kind,
        backup_id: Some(backup_id.to_string()),
        phase: "preserving-live-store".to_owned(),
        preserved_directory: preserved_name,
        staged_database: Some(
            inspect_plain_child_file(&staging_boundary, &staged_database)?.identity,
        ),
        staged_marker: Some(inspect_plain_child_file(&staging_boundary, &staged_marker)?.identity),
    };
    publish_journal(paths, &journal, fault, artifacts)?;
    Ok(journal)
}

/// Writes the journal to a temporary file, syncs it and renames it into place. Errors before
/// the rename returns are pre-commit; the data-root sync after it is the first commit step.
fn publish_journal(
    paths: &StatePaths,
    journal: &RecoveryJournal,
    fault: RecoveryFault,
    artifacts: &mut PreCommitArtifacts,
) -> Result<(), RecoveryError> {
    let mut bytes = serde_json::to_vec_pretty(journal).map_err(BackupError::ManifestEncode)?;
    bytes.push(b'\n');
    let journal_path = paths.recovery_journal();
    let temporary = temporary_journal_path(paths, journal.operation_id);
    let mut file = private_create_new(&temporary)?;
    let identity = plain_path_snapshot(&temporary, PlainPathKind::File)?.identity;
    artifacts.temporary_journal = Some((temporary.clone(), identity));
    fault.inject_io(RecoveryFault::JournalWrite, &temporary)?;
    file.write_all(&bytes).map_err(|source| BackupError::Io {
        path: temporary.clone(),
        source,
    })?;
    fault.inject_io(RecoveryFault::JournalSync, &temporary)?;
    file.sync_all().map_err(|source| BackupError::Io {
        path: temporary.clone(),
        source,
    })?;
    drop(file);
    if path_entry_exists(&journal_path)? {
        return Err(RecoveryError::RecoveryInProgress { path: journal_path });
    }
    fs::rename(&temporary, &journal_path).map_err(|source| BackupError::Io {
        path: journal_path.clone(),
        source,
    })?;
    *artifacts = PreCommitArtifacts::default();
    // Committed: errors from here leave the journal for `restore --resume`.
    fault.inject_io(RecoveryFault::JournalDirectorySync, &paths.base_dir)?;
    sync_directory(&paths.base_dir)?;
    Ok(())
}

fn temporary_journal_path(paths: &StatePaths, operation_id: Uuid) -> PathBuf {
    let journal = paths.recovery_journal();
    let name = journal
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    journal.with_file_name(format!("{name}.{operation_id}.tmp"))
}

fn ensure_recovery_directories(
    paths: &StatePaths,
    root_boundary: &BoundDirectory,
) -> Result<BoundDirectory, BackupError> {
    let recovery_root = paths.base_dir.join("recovery");
    let recovery_root_boundary = ensure_backup_component(
        root_boundary,
        &recovery_root,
        true,
        BackupFault::None,
        BackupFault::BeforeBackupsDirectorySync,
        BackupFault::BeforeBackupsParentSync,
    )?
    .expect("recovery root was created");
    Ok(ensure_backup_component(
        &recovery_root_boundary,
        &paths.recovery_dir(),
        true,
        BackupFault::None,
        BackupFault::BeforeStateKindDirectorySync,
        BackupFault::BeforeStateKindParentSync,
    )?
    .expect("recovery state-kind directory was created"))
}

fn read_marker_id(paths: &StatePaths) -> Result<Option<StorageInstanceId>, BackupError> {
    if !path_entry_exists(&paths.environment_id)? {
        return Ok(None);
    }
    let marker_bytes = fs::read(&paths.environment_id).map_err(|source| BackupError::Io {
        path: paths.environment_id.clone(),
        source,
    })?;
    Ok(std::str::from_utf8(&marker_bytes)
        .ok()
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .map(StorageInstanceId::from_uuid))
}

/// Finishes a published journal: preserves every live file that is not a staged one, syncs the
/// preserved directory, installs the staged files, then removes staging and the journal. Each
/// step is decided from the files, so an interrupted run is finished by the next one.
fn roll_forward(
    paths: &StatePaths,
    journal: &RecoveryJournal,
    fault: RecoveryFault,
) -> Result<(), RecoveryError> {
    let refused = |detail: &str| RecoveryError::ResumeRefused {
        detail: detail.to_owned(),
    };
    if journal.version != JOURNAL_VERSION {
        return Err(refused(
            "the recovery journal was written by another BiBCode version",
        ));
    }
    if journal.state_kind != paths.state_kind {
        return Err(refused("the recovery journal names another state kind"));
    }
    let preserved_name = Path::new(&journal.preserved_directory);
    if preserved_name.components().count() != 1
        || !journal
            .preserved_directory
            .ends_with(&format!("-{}", journal.operation_id))
    {
        return Err(refused(
            "the recovery journal names an unexpected preserved directory",
        ));
    }
    let is_restore = journal.action == RecoveryAction::Restore;
    if is_restore != (journal.staged_database.is_some() && journal.staged_marker.is_some()) {
        return Err(refused(
            "the recovery journal does not record its staged files",
        ));
    }
    let root_boundary = inspect_root_directory(&paths.base_dir)?;
    let state_boundary = inspect_child_directory(&root_boundary, &paths.state_dir)?;
    let recovery_root_boundary =
        inspect_child_directory(&root_boundary, &paths.base_dir.join("recovery"))?;
    let recovery_kind_boundary =
        inspect_child_directory(&recovery_root_boundary, &paths.recovery_dir())?;
    let preserved_directory = paths.recovery_dir().join(preserved_name);
    let preserved_boundary =
        inspect_child_directory(&recovery_kind_boundary, &preserved_directory)?;

    let staging_directory = paths.recovery_staging_dir(journal.operation_id);
    let staging_boundary = if path_entry_exists(&staging_directory)? {
        if !is_restore {
            return Err(refused("a start-empty operation has a staging directory"));
        }
        let boundary = inspect_child_directory(&root_boundary, &staging_directory)?;
        for entry in fs::read_dir(&staging_directory).map_err(|source| BackupError::Io {
            path: staging_directory.clone(),
            source,
        })? {
            let entry = entry.map_err(|source| BackupError::Io {
                path: staging_directory.clone(),
                source,
            })?;
            let expected = if entry.file_name() == OsStr::new(BACKUP_FILE_NAME) {
                journal.staged_database
            } else if entry.file_name() == OsStr::new(MARKER_FILE_NAME) {
                journal.staged_marker
            } else {
                return Err(refused("the staging directory holds an unexpected entry"));
            };
            let snapshot = inspect_plain_child_file(&boundary, &entry.path())?;
            if Some(snapshot.identity) != expected || snapshot.links != 1 {
                return Err(refused("a staged file is not the one the journal recorded"));
            }
        }
        Some(boundary)
    } else {
        None
    };

    let staged = [journal.staged_database, journal.staged_marker];
    for source in [
        paths.database.clone(),
        sqlite_sidecar_path(&paths.database, "-wal"),
        sqlite_sidecar_path(&paths.database, "-shm"),
        paths.environment_id.clone(),
    ] {
        if !path_entry_exists(&source)? {
            continue;
        }
        let identity = plain_path_snapshot(&source, PlainPathKind::File)?.identity;
        if staged.contains(&Some(identity)) {
            continue;
        }
        preserve_live_file(&state_boundary, &source, &preserved_boundary)?;
        fault.inject(preserve_fault(&source, &paths.database))?;
    }
    fault.inject_io(RecoveryFault::PreservedSync, &preserved_directory)?;
    sync_directory(&preserved_directory)?;
    fault.inject(RecoveryFault::AfterPreservedSync)?;
    sync_directory(&paths.state_dir)?;
    fault.inject(RecoveryFault::AfterPreserve)?;

    if let Some(staging_boundary) = staging_boundary {
        for (name, destination, after) in [
            (
                BACKUP_FILE_NAME,
                &paths.database,
                RecoveryFault::AfterMoveDatabase,
            ),
            (
                MARKER_FILE_NAME,
                &paths.environment_id,
                RecoveryFault::AfterMoveMarker,
            ),
        ] {
            let source = staging_directory.join(name);
            if path_entry_exists(&source)? {
                move_staged_file(&staging_boundary, &source, destination)?;
            }
            fault.inject(after)?;
            if name == BACKUP_FILE_NAME {
                debug_pause_at("database-moved");
            }
        }
        sync_directory(&paths.state_dir)?;
        remove_directory(&staging_directory)?;
        fault.inject(RecoveryFault::AfterRemoveStaging)?;
    } else if is_restore {
        // A restore whose staging is gone has already installed both files.
        for (path, identity) in [
            (&paths.database, journal.staged_database),
            (&paths.environment_id, journal.staged_marker),
        ] {
            if !path_entry_exists(path)?
                || Some(plain_path_snapshot(path, PlainPathKind::File)?.identity) != identity
            {
                return Err(refused(
                    "a staged file is missing from both staging and the store",
                ));
            }
        }
    }
    let journal_path = paths.recovery_journal();
    fs::remove_file(&journal_path).map_err(|source| BackupError::Io {
        path: journal_path,
        source,
    })?;
    sync_directory(&paths.base_dir)?;
    Ok(())
}

pub async fn preserve_and_start_empty(
    root: &ResolvedDataRoot,
) -> Result<RecoveryResult, RecoveryError> {
    preserve_and_start_empty_inner(root, RecoveryFault::None).await
}

#[cfg(test)]
async fn preserve_and_start_empty_with_fault(
    root: &ResolvedDataRoot,
    fault: RecoveryFault,
) -> Result<RecoveryResult, RecoveryError> {
    preserve_and_start_empty_inner(root, fault).await
}

async fn preserve_and_start_empty_inner(
    root: &ResolvedDataRoot,
    fault: RecoveryFault,
) -> Result<RecoveryResult, RecoveryError> {
    let (paths, current) = recovery_paths(root)?;
    let _offline = OfflineRecoveryGuard::acquire(&paths)?;
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = CancelOnDrop(cancellation.clone());
    let _guard =
        StoreOperationGuard::acquire(&paths.base_dir, cancellation.clone(), RECOVERY_TIMEOUT)
            .await?;
    let deadline = deadline_after(Instant::now(), RECOVERY_TIMEOUT);
    tokio::task::spawn_blocking(move || {
        preserve_and_start_empty_blocking(&paths, &current, &cancellation, deadline, fault)
    })
    .await
    .map_err(RecoveryError::Worker)?
}

fn preserve_and_start_empty_blocking(
    paths: &StatePaths,
    expected_root: &ResolvedDataRoot,
    cancellation: &CancellationToken,
    deadline: Instant,
    fault: RecoveryFault,
) -> Result<RecoveryResult, RecoveryError> {
    let mut artifacts = PreCommitArtifacts::default();
    let staged = (|| {
        ensure_active(cancellation, Some(deadline))?;
        ensure_root_unchanged(paths, expected_root)?;
        clear_abandoned_recovery(paths)?;
        let root_boundary = inspect_root_directory(&paths.base_dir)?;
        inspect_child_directory(&root_boundary, &paths.state_dir)?;
        let recovery_kind_boundary = ensure_recovery_directories(paths, &root_boundary)?;
        let operation_id = Uuid::new_v4();
        let preserved_name = format!(
            "{}-{operation_id}",
            OffsetDateTime::now_utc().unix_timestamp()
        );
        let preserved_directory = paths.recovery_dir().join(&preserved_name);
        create_private_directory(&preserved_directory)?;
        artifacts.preserved_directory = Some(preserved_directory.clone());
        sync_directory(&preserved_directory)?;
        sync_directory(&paths.recovery_dir())?;
        inspect_child_directory(&recovery_kind_boundary, &preserved_directory)?;
        fault.inject(RecoveryFault::BeforeJournal)?;
        let journal = RecoveryJournal {
            version: JOURNAL_VERSION,
            operation_id,
            action: RecoveryAction::StartEmpty,
            state_kind: paths.state_kind,
            backup_id: None,
            phase: "preserving-live-store".to_owned(),
            preserved_directory: preserved_name,
            staged_database: None,
            staged_marker: None,
        };
        publish_journal(paths, &journal, fault, &mut artifacts)?;
        Ok::<_, RecoveryError>(journal)
    })();
    let journal = match staged {
        Ok(journal) => journal,
        Err(error) => {
            artifacts.remove();
            return Err(error);
        }
    };
    roll_forward(paths, &journal, fault)?;
    Ok(RecoveryResult {
        operation_id: journal.operation_id,
        action: RecoveryAction::StartEmpty,
        preserved_directory: paths.recovery_dir().join(&journal.preserved_directory),
        storage_instance_id: None,
    })
}

/// `bibcode storage restore --resume`: finishes a restore or start-empty whose journal was
/// published, or clears one abandoned before that.
pub async fn resume_recovery(root: &ResolvedDataRoot) -> Result<ResumeResult, RecoveryError> {
    resume_recovery_inner(root, RecoveryFault::None).await
}

#[cfg(test)]
async fn resume_recovery_with_fault(
    root: &ResolvedDataRoot,
    fault: RecoveryFault,
) -> Result<ResumeResult, RecoveryError> {
    resume_recovery_inner(root, fault).await
}

async fn resume_recovery_inner(
    root: &ResolvedDataRoot,
    fault: RecoveryFault,
) -> Result<ResumeResult, RecoveryError> {
    let (paths, current) = recovery_paths(root)?;
    let _offline = OfflineRecoveryGuard::acquire(&paths)?;
    let _guard =
        StoreOperationGuard::acquire(&paths.base_dir, CancellationToken::new(), RECOVERY_TIMEOUT)
            .await?;
    tokio::task::spawn_blocking(move || {
        ensure_root_unchanged(&paths, &current)?;
        let journal_path = paths.recovery_journal();
        if !path_entry_exists(&journal_path)? {
            let cleared = clear_abandoned_recovery(&paths)?;
            return Ok(ResumeResult {
                resumed: None,
                cleared_abandoned_staging: cleared,
            });
        }
        let journal = read_journal(&journal_path)?;
        let result = roll_forward(&paths, &journal, fault);
        if let Err(error) = &result {
            tracing::warn!(
                operation_id = %journal.operation_id,
                detail = %error,
                "an interrupted project-data recovery could not be finished"
            );
        }
        result?;
        tracing::info!(
            operation_id = %journal.operation_id,
            "finished an interrupted project-data recovery"
        );
        Ok(ResumeResult {
            resumed: Some(RecoveryResult {
                operation_id: journal.operation_id,
                action: journal.action,
                preserved_directory: paths.recovery_dir().join(&journal.preserved_directory),
                storage_instance_id: read_marker_id(&paths)?,
            }),
            cleared_abandoned_staging: false,
        })
    })
    .await
    .map_err(RecoveryError::Worker)?
}

fn read_journal(path: &Path) -> Result<RecoveryJournal, RecoveryError> {
    ensure_plain_file(path)?;
    let metadata = fs::metadata(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.len() > MAX_JOURNAL_BYTES {
        return Err(RecoveryError::ResumeRefused {
            detail: "the recovery journal is too large".to_owned(),
        });
    }
    let bytes = fs::read(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|_| RecoveryError::ResumeRefused {
        detail: "the recovery journal was written by another BiBCode version or is damaged"
            .to_owned(),
    })
}

/// Refuses while a journal exists. Otherwise clears operations abandoned before their journal
/// was published: a recovery-staging directory holding only a staged database and marker,
/// its temporary journal, and its empty preserved directory. Returns whether it cleared any.
fn clear_abandoned_recovery(paths: &StatePaths) -> Result<bool, RecoveryError> {
    // Either state kind's journal may name a staging directory, which share the data root.
    for kind in [StateKind::Userdata, StateKind::Dev] {
        let journal = with_state_kind(paths, kind).recovery_journal();
        if path_entry_exists(&journal)? {
            return Err(RecoveryError::RecoveryInProgress { path: journal });
        }
    }
    let root_boundary = inspect_root_directory(&paths.base_dir)?;
    let mut cleared = false;
    let entries = fs::read_dir(&paths.base_dir).map_err(|source| BackupError::Io {
        path: paths.base_dir.clone(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| BackupError::Io {
            path: paths.base_dir.clone(),
            source,
        })?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(operation_id) = name
            .strip_prefix('.')
            .and_then(|name| name.strip_suffix(".recovery-staging"))
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            continue;
        };
        let staging = entry.path();
        let refuse = || RecoveryError::RecoveryInProgress {
            path: staging.clone(),
        };
        let boundary = inspect_child_directory(&root_boundary, &staging).map_err(|_| refuse())?;
        for child in fs::read_dir(&staging).map_err(|source| BackupError::Io {
            path: staging.clone(),
            source,
        })? {
            let child = child.map_err(|source| BackupError::Io {
                path: staging.clone(),
                source,
            })?;
            let expected = child.file_name() == OsStr::new(BACKUP_FILE_NAME)
                || child.file_name() == OsStr::new(MARKER_FILE_NAME);
            if !expected || inspect_plain_child_file(&boundary, &child.path()).is_err() {
                return Err(refuse());
            }
        }
        remove_owned_files(&staging, &[BACKUP_FILE_NAME, MARKER_FILE_NAME])?;
        remove_directory(&staging)?;
        for kind in [StateKind::Userdata, StateKind::Dev] {
            let kind_paths = with_state_kind(paths, kind);
            let temporary = temporary_journal_path(&kind_paths, operation_id);
            if path_entry_exists(&temporary)? {
                let identity = plain_path_snapshot(&temporary, PlainPathKind::File)?.identity;
                remove_file_with_identity(&temporary, identity)?;
            }
            remove_empty_preserved_directory(&kind_paths, operation_id)?;
        }
        tracing::info!(%operation_id, "cleared a project-data recovery abandoned before it changed the store");
        cleared = true;
    }
    if cleared {
        sync_directory(&paths.base_dir)?;
    }
    Ok(cleared)
}

fn remove_empty_preserved_directory(
    paths: &StatePaths,
    operation_id: Uuid,
) -> Result<(), BackupError> {
    let directory = paths.recovery_dir();
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(BackupError::Io {
                path: directory,
                source,
            });
        }
    };
    let suffix = format!("-{operation_id}");
    for entry in entries {
        let entry = entry.map_err(|source| BackupError::Io {
            path: directory.clone(),
            source,
        })?;
        if entry.file_name().to_string_lossy().ends_with(&suffix) {
            // `remove_dir` only removes an empty directory, so preserved files stay.
            let _ = fs::remove_dir(entry.path());
        }
    }
    Ok(())
}

/// Removes the named plain files of a directory BiBCode created; refuses any other kind.
fn remove_owned_files(directory: &Path, names: &[&str]) -> Result<(), BackupError> {
    for name in names {
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                fs::remove_file(&path).map_err(|source| BackupError::Io { path, source })?;
            }
            Ok(_) => {
                return Err(BackupError::Verification(format!(
                    "{name} in an unfinished operation is not a plain file"
                )));
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(BackupError::Io { path, source }),
        }
    }
    Ok(())
}

fn remove_file_with_identity(path: &Path, identity: FileIdentity) -> Result<(), BackupError> {
    match plain_path_snapshot(path, PlainPathKind::File) {
        Ok(snapshot) if snapshot.identity == identity => {
            fs::remove_file(path).map_err(|source| BackupError::Io {
                path: path.to_path_buf(),
                source,
            })
        }
        Ok(_) => Err(BackupError::Verification(format!(
            "{} changed before cleanup",
            path.display()
        ))),
        Err(BackupError::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn remove_directory(directory: &Path) -> Result<(), BackupError> {
    match fs::remove_dir(directory) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(BackupError::Io {
            path: directory.to_path_buf(),
            source,
        }),
    }
}

fn find_verified_backup_for_recovery(
    paths: &StatePaths,
    backup_id: Uuid,
    cancellation: &CancellationToken,
    deadline: Instant,
    budget: StoreIoBudget,
    started: Instant,
) -> Result<Option<(VerifiedBackup, Instant)>, BackupError> {
    ensure_active(cancellation, Some(deadline))?;
    let state_kind_directory = paths.backups_dir.join(state_kind_name(paths.state_kind));
    let entries = match fs::read_dir(&state_kind_directory) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(BackupError::Io {
                path: state_kind_directory,
                source,
            });
        }
    };
    let mut selected_entry_failed_verification = false;
    for entry in entries {
        ensure_active(cancellation, Some(deadline))?;
        let entry = entry.map_err(|source| BackupError::Io {
            path: state_kind_directory.clone(),
            source,
        })?;
        let Some(storage_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| Uuid::parse_str(name).ok())
            .map(StorageInstanceId::from_uuid)
        else {
            continue;
        };
        let selected_path = paths
            .backup_store_dir(storage_id)
            .join(backup_id.to_string());
        let selected_entry_exists = match fs::symlink_metadata(&selected_path) {
            Ok(_) => true,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => false,
            Err(source) => {
                return Err(BackupError::Io {
                    path: selected_path,
                    source,
                });
            }
        };
        if !selected_entry_exists {
            continue;
        }
        // The deadline grows with the selected generation's length, read before its content.
        let length = fs::symlink_metadata(selected_path.join(BACKUP_FILE_NAME))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let deadline = deadline.max(deadline_after(started, budget.for_bytes(length)));
        // Verify only the selected generation: unrelated backups must not spend restore's
        // budget.
        let verified = BackupStoreBoundary::open_existing(paths, storage_id).and_then(|boundary| {
            let boundary = boundary
                .ok_or_else(|| BackupError::Verification("backup store disappeared".to_owned()))?;
            verify_generation(
                &boundary,
                &selected_path,
                backup_id,
                storage_id,
                Some(cancellation),
                Some(deadline),
                VerifyLevel::Content,
            )
        });
        match verified {
            Ok(backup) => return Ok(Some((backup, deadline))),
            Err(error @ (BackupError::DeadlineElapsed | BackupError::Cancelled)) => {
                return Err(error);
            }
            Err(_) => selected_entry_failed_verification = true,
        }
    }
    if selected_entry_failed_verification {
        return Err(BackupError::Verification(
            "the selected backup exists but failed verification".to_owned(),
        ));
    }
    Ok(None)
}

/// The real-kill test's seam, compiled only with `debug_assertions`: blocks forever at the
/// commit step named by `BIBCODE_TEST_PAUSE_RECOVERY`, after writing the file named by
/// `BIBCODE_TEST_PAUSE_RECOVERY_MARKER`.
fn debug_pause_at(step: &str) {
    #[cfg(debug_assertions)]
    if std::env::var("BIBCODE_TEST_PAUSE_RECOVERY").is_ok_and(|value| value == step) {
        if let Ok(marker) = std::env::var("BIBCODE_TEST_PAUSE_RECOVERY_MARKER") {
            let _ = fs::write(marker, step);
        }
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = step;
}

/// Only `recovery_journal` and `recovery_dir` of the copy are meaningful for another kind.
fn with_state_kind(paths: &StatePaths, kind: StateKind) -> StatePaths {
    let mut other = paths.clone();
    other.state_kind = kind;
    other
}

fn copy_verified_database(
    selected: &VerifiedBackup,
    destination: &Path,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<(), BackupError> {
    let source_snapshot = plain_path_snapshot(&selected.database, PlainPathKind::File)?;
    if source_snapshot.identity != selected.identity.database {
        return Err(BackupError::Verification(
            "selected backup changed before restore staging".to_owned(),
        ));
    }
    let mut source =
        open_path_without_following(&selected.database, PlainPathKind::File).map_err(|source| {
            BackupError::Io {
                path: selected.database.clone(),
                source,
            }
        })?;
    let opened = source.metadata().map_err(|source| BackupError::Io {
        path: selected.database.clone(),
        source,
    })?;
    let opened_snapshot = file_snapshot(&source, &opened).map_err(|source| BackupError::Io {
        path: selected.database.clone(),
        source,
    })?;
    if opened_snapshot.identity != selected.identity.database {
        return Err(BackupError::Verification(
            "selected backup changed while opening restore source".to_owned(),
        ));
    }
    let mut target = private_create_new(destination)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        ensure_active(cancellation, Some(deadline))?;
        let count = source.read(&mut buffer).map_err(|source| BackupError::Io {
            path: selected.database.clone(),
            source,
        })?;
        if count == 0 {
            break;
        }
        target
            .write_all(&buffer[..count])
            .map_err(|source| BackupError::Io {
                path: destination.to_path_buf(),
                source,
            })?;
    }
    target.sync_all().map_err(|source| BackupError::Io {
        path: destination.to_path_buf(),
        source,
    })?;
    drop(target);
    let (size, sha256) = database_size_and_hash(destination, Some(cancellation), Some(deadline))?;
    if size != selected.manifest.database_size_bytes || sha256 != selected.manifest.sha256 {
        return Err(BackupError::Verification(
            "staged restore database does not match its verified manifest".to_owned(),
        ));
    }
    let integrity = quick_check_database(destination, Some(cancellation), Some(deadline))?;
    if integrity != "ok" {
        return Err(BackupError::QuickCheck {
            path: destination.to_path_buf(),
            detail: integrity,
        });
    }
    Ok(())
}

fn preserve_live_file(
    state: &BoundDirectory,
    source: &Path,
    preserved: &BoundDirectory,
) -> Result<(), BackupError> {
    let snapshot = inspect_plain_child_file(state, source)?;
    let destination = preserved.path.join(
        source
            .file_name()
            .ok_or_else(|| BackupError::Verification("live store file has no name".to_owned()))?,
    );
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(BackupError::Verification(
            "recovery preservation destination already exists".to_owned(),
        ));
    }
    fs::rename(source, &destination).map_err(|source_error| BackupError::Io {
        path: source.to_path_buf(),
        source: source_error,
    })?;
    let preserved_snapshot = inspect_plain_child_file(preserved, &destination)?;
    if preserved_snapshot.identity != snapshot.identity {
        return Err(BackupError::Verification(
            "preserved live store file identity changed".to_owned(),
        ));
    }
    Ok(())
}

fn move_staged_file(
    staging: &BoundDirectory,
    source: &Path,
    destination: &Path,
) -> Result<(), BackupError> {
    let snapshot = inspect_plain_child_file(staging, source)?;
    if fs::symlink_metadata(destination).is_ok() {
        return Err(BackupError::Verification(
            "live restore destination unexpectedly exists".to_owned(),
        ));
    }
    fs::rename(source, destination).map_err(|source_error| BackupError::Io {
        path: destination.to_path_buf(),
        source: source_error,
    })?;
    let confirmed = plain_path_snapshot(destination, PlainPathKind::File)?;
    if confirmed.identity != snapshot.identity {
        return Err(BackupError::Verification(
            "restored live file identity changed during publication".to_owned(),
        ));
    }
    Ok(())
}

fn sqlite_sidecar_path(database: &Path, suffix: &str) -> PathBuf {
    let mut path = database.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

impl BackupStoreBoundary {
    fn open_or_create(
        paths: &StatePaths,
        storage_instance_id: StorageInstanceId,
        fault: BackupFault,
    ) -> Result<Self, BackupError> {
        let root = inspect_root_directory(&paths.base_dir)?;
        let backups = ensure_backup_component(
            &root,
            &paths.backups_dir,
            true,
            fault,
            BackupFault::BeforeBackupsDirectorySync,
            BackupFault::BeforeBackupsParentSync,
        )?
        .expect("creating the backups directory returns a boundary");
        let state_kind_path = paths.backups_dir.join(state_kind_name(paths.state_kind));
        let state_kind = ensure_backup_component(
            &backups,
            &state_kind_path,
            true,
            fault,
            BackupFault::BeforeStateKindDirectorySync,
            BackupFault::BeforeStateKindParentSync,
        )?
        .expect("creating the state-kind directory returns a boundary");
        let store_path = paths.backup_store_dir(storage_instance_id);
        let store = ensure_backup_component(
            &state_kind,
            &store_path,
            true,
            fault,
            BackupFault::BeforeStoreDirectorySync,
            BackupFault::BeforeStoreParentSync,
        )?
        .expect("creating the backup-store directory returns a boundary");
        let boundary = Self {
            state_kind_value: paths.state_kind,
            root,
            backups,
            state_kind,
            store,
        };
        boundary.revalidate()?;
        Ok(boundary)
    }

    fn open_existing(
        paths: &StatePaths,
        storage_instance_id: StorageInstanceId,
    ) -> Result<Option<Self>, BackupError> {
        let root = inspect_root_directory(&paths.base_dir)?;
        let Some(backups) = ensure_backup_component(
            &root,
            &paths.backups_dir,
            false,
            BackupFault::None,
            BackupFault::None,
            BackupFault::None,
        )?
        else {
            return Ok(None);
        };
        let state_kind_path = paths.backups_dir.join(state_kind_name(paths.state_kind));
        let Some(state_kind) = ensure_backup_component(
            &backups,
            &state_kind_path,
            false,
            BackupFault::None,
            BackupFault::None,
            BackupFault::None,
        )?
        else {
            return Ok(None);
        };
        let store_path = paths.backup_store_dir(storage_instance_id);
        let Some(store) = ensure_backup_component(
            &state_kind,
            &store_path,
            false,
            BackupFault::None,
            BackupFault::None,
            BackupFault::None,
        )?
        else {
            return Ok(None);
        };
        let boundary = Self {
            state_kind_value: paths.state_kind,
            root,
            backups,
            state_kind,
            store,
        };
        boundary.revalidate()?;
        Ok(Some(boundary))
    }

    fn revalidate(&self) -> Result<(), BackupError> {
        self.root.revalidate(None)?;
        self.backups.revalidate(Some(&self.root))?;
        self.state_kind.revalidate(Some(&self.backups))?;
        self.store.revalidate(Some(&self.state_kind))
    }
}

impl BoundDirectory {
    fn revalidate(&self, parent: Option<&Self>) -> Result<(), BackupError> {
        let current = match parent {
            Some(parent) => inspect_child_directory(parent, &self.path)?,
            None => inspect_root_directory(&self.path)?,
        };
        if current.identity != self.identity
            || current.canonical != self.canonical
            || current.volume != self.volume
        {
            return Err(BackupError::Verification(format!(
                "backup directory identity changed: {}",
                self.path.display()
            )));
        }
        Ok(())
    }
}

pub(super) fn state_kind_name(state_kind: StateKind) -> &'static str {
    match state_kind {
        StateKind::Userdata => "userdata",
        StateKind::Dev => "dev",
    }
}

fn ensure_backup_component(
    parent: &BoundDirectory,
    path: &Path,
    create: bool,
    fault: BackupFault,
    before_directory_sync: BackupFault,
    before_parent_sync: BackupFault,
) -> Result<Option<BoundDirectory>, BackupError> {
    parent.revalidate(None)?;
    let created = match fs::symlink_metadata(path) {
        Ok(_) => false,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound && create => {
            create_private_directory(path)?;
            true
        }
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(BackupError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    let mut directory = inspect_child_directory(parent, path)?;
    if create {
        set_private_directory_permissions(path)?;
        directory = inspect_child_directory(parent, path)?;
    }
    if created {
        fault.inject(before_directory_sync)?;
        sync_directory(path)?;
        fault.inject(before_parent_sync)?;
        parent.revalidate(None)?;
        sync_directory(&parent.path)?;
        directory = inspect_child_directory(parent, path)?;
    }
    Ok(Some(directory))
}

fn path_parent(path: &Path) -> Result<&Path, BackupError> {
    path.parent().ok_or_else(|| {
        BackupError::Verification("backup component has no parent directory".to_owned())
    })
}

fn inspect_root_directory(path: &Path) -> Result<BoundDirectory, BackupError> {
    let snapshot = plain_path_snapshot(path, PlainPathKind::Directory)?;
    let canonical = fs::canonicalize(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let confirmed = plain_path_snapshot(path, PlainPathKind::Directory)?;
    if confirmed.identity != snapshot.identity {
        return Err(BackupError::Verification(
            "backup directory identity changed during inspection".to_owned(),
        ));
    }
    Ok(BoundDirectory {
        path: path.to_path_buf(),
        canonical,
        identity: snapshot.identity,
        volume: snapshot.identity.volume,
    })
}

fn inspect_child_directory(
    parent: &BoundDirectory,
    path: &Path,
) -> Result<BoundDirectory, BackupError> {
    let named_parent = path_parent(path)?;
    if named_parent != parent.path {
        return Err(BackupError::Verification(
            "backup directory is not the expected direct child".to_owned(),
        ));
    }
    let snapshot = plain_path_snapshot(path, PlainPathKind::Directory)?;
    if snapshot.identity.volume != parent.volume {
        return Err(BackupError::Verification(
            "backup directory crossed a filesystem boundary".to_owned(),
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let expected = parent.canonical.join(
        path.file_name()
            .ok_or_else(|| BackupError::Verification("backup child has no name".to_owned()))?,
    );
    if canonical != expected || !canonical.starts_with(&parent.canonical) {
        return Err(BackupError::Verification(
            "backup directory escapes its trusted parent".to_owned(),
        ));
    }
    let confirmed = plain_path_snapshot(path, PlainPathKind::Directory)?;
    if confirmed.identity != snapshot.identity {
        return Err(BackupError::Verification(
            "backup directory identity changed during inspection".to_owned(),
        ));
    }
    Ok(BoundDirectory {
        path: path.to_path_buf(),
        canonical,
        identity: snapshot.identity,
        volume: parent.volume,
    })
}

/// The hard-link count of the plain file at `path`, read without following links.
pub(super) fn file_link_count(path: &Path) -> Result<u64, BackupError> {
    let file = open_path_without_following(path, PlainPathKind::File).map_err(|source| {
        BackupError::Io {
            path: path.to_path_buf(),
            source,
        }
    })?;
    let metadata = file.metadata().map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(file_snapshot(&file, &metadata)
        .map_err(|source| BackupError::Io {
            path: path.to_path_buf(),
            source,
        })?
        .links)
}

/// The volume identity of a directory, after resolving symlinks in its path.
pub(super) fn directory_volume(path: &Path) -> Result<u64, BackupError> {
    let canonical = fs::canonicalize(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(plain_path_snapshot(&canonical, PlainPathKind::Directory)?
        .identity
        .volume)
}

#[derive(Clone, Copy)]
enum PlainPathKind {
    Directory,
    File,
}

fn plain_path_snapshot(path: &Path, kind: PlainPathKind) -> Result<PlainPathSnapshot, BackupError> {
    let named = fs::symlink_metadata(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let correct_named_type = match kind {
        PlainPathKind::Directory => named.is_dir(),
        PlainPathKind::File => named.is_file(),
    };
    if named.file_type().is_symlink() || is_reparse_point(&named) || !correct_named_type {
        return Err(BackupError::Verification(format!(
            "{} is not a plain {}",
            path.display(),
            match kind {
                PlainPathKind::Directory => "directory",
                PlainPathKind::File => "file",
            }
        )));
    }
    let file = open_path_without_following(path, kind).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let metadata = file.metadata().map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let correct_opened_type = match kind {
        PlainPathKind::Directory => metadata.is_dir(),
        PlainPathKind::File => metadata.is_file(),
    };
    if is_reparse_point(&metadata) || !correct_opened_type {
        return Err(BackupError::Verification(
            "backup path changed type while it was opened".to_owned(),
        ));
    }
    let snapshot = file_snapshot(&file, &metadata).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if matches!(kind, PlainPathKind::File) && snapshot.links != 1 {
        return Err(BackupError::Verification(
            "backup file has an untrusted hard-link count".to_owned(),
        ));
    }
    Ok(snapshot)
}

#[cfg(unix)]
fn open_path_without_following(path: &Path, kind: PlainPathKind) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    let directory_flag = if matches!(kind, PlainPathKind::Directory) {
        libc::O_DIRECTORY
    } else {
        0
    };
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | directory_flag)
        .open(path)
}

#[cfg(windows)]
fn open_path_without_following(path: &Path, kind: PlainPathKind) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let (access_mode, directory_flag) = if matches!(kind, PlainPathKind::Directory) {
        (FILE_READ_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS)
    } else {
        (FILE_GENERIC_READ, 0)
    };
    OpenOptions::new()
        .access_mode(access_mode)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | directory_flag)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_path_without_following(path: &Path, _kind: PlainPathKind) -> std::io::Result<File> {
    File::open(path)
}

#[cfg(unix)]
fn file_snapshot(_file: &File, metadata: &fs::Metadata) -> std::io::Result<PlainPathSnapshot> {
    use std::os::unix::fs::MetadataExt;

    Ok(PlainPathSnapshot {
        identity: FileIdentity {
            volume: metadata.dev(),
            file: metadata.ino(),
        },
        links: metadata.nlink(),
        size: metadata.len(),
        modified: metadata.modified()?,
    })
}

#[cfg(windows)]
fn file_snapshot(file: &File, metadata: &fs::Metadata) -> std::io::Result<PlainPathSnapshot> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let information = unsafe { information.assume_init() };
    Ok(PlainPathSnapshot {
        identity: FileIdentity {
            volume: u64::from(information.dwVolumeSerialNumber),
            file: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
        },
        links: u64::from(information.nNumberOfLinks),
        size: metadata.len(),
        modified: metadata.modified()?,
    })
}

#[cfg(not(any(unix, windows)))]
fn file_snapshot(_file: &File, metadata: &fs::Metadata) -> std::io::Result<PlainPathSnapshot> {
    Ok(PlainPathSnapshot {
        identity: FileIdentity { volume: 0, file: 0 },
        links: 1,
        size: metadata.len(),
        modified: metadata.modified()?,
    })
}

#[cfg(windows)]
pub(super) fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
pub(super) fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[derive(Debug)]
struct StagedBackup {
    boundary: BackupStoreBoundary,
    directory: PathBuf,
    directory_identity: FileIdentity,
    database: PathBuf,
    database_identity: FileIdentity,
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
    fault: BackupFault,
) -> Result<StagedBackup, BackupError> {
    ensure_active(cancellation, Some(deadline))?;
    let boundary = BackupStoreBoundary::open_or_create(paths, storage_instance_id, fault)?;
    boundary.revalidate()?;
    let directory = boundary.store.path.join(format!(".{backup_id}.staging"));
    create_private_directory(&directory)?;
    let staged_directory = inspect_child_directory(&boundary.store, &directory)?;
    sync_directory(&directory)?;
    sync_directory(&boundary.store.path)?;
    let database = directory.join(BACKUP_FILE_NAME);
    let database_reservation = private_create_new(&database)?;
    let database_identity = plain_path_snapshot(&database, PlainPathKind::File)?.identity;
    Ok(StagedBackup {
        boundary,
        database,
        database_identity,
        database_reservation,
        manifest: directory.join(MANIFEST_FILE_NAME),
        final_directory: staged_directory
            .path
            .parent()
            .expect("staging directory has a store parent")
            .join(backup_id.to_string()),
        directory_identity: staged_directory.identity,
        directory,
    })
}

impl StagedBackup {
    fn cleanup(&self) -> StagingCleanup {
        StagingCleanup {
            store: self.boundary.store.clone(),
            directory: self.directory.clone(),
            identity: self.directory_identity,
        }
    }
}

/// Removes an unpublished `.<id>.staging` directory: only the files a backup writes there, then
/// the directory itself, never recursively.
struct StagingCleanup {
    store: BoundDirectory,
    directory: PathBuf,
    identity: FileIdentity,
}

impl StagingCleanup {
    fn run(&self) {
        if let Err(error) = self.try_run() {
            tracing::warn!(
                entry = %self.directory.file_name().unwrap_or_default().to_string_lossy(),
                detail = %error,
                "left an unfinished backup staging directory in place"
            );
        }
    }

    fn try_run(&self) -> Result<(), BackupError> {
        let current = inspect_child_directory(&self.store, &self.directory)?;
        if current.identity != self.identity {
            return Err(BackupError::Verification(
                "backup staging directory changed before cleanup".to_owned(),
            ));
        }
        remove_owned_files(
            &self.directory,
            &[
                BACKUP_FILE_NAME,
                MANIFEST_FILE_NAME,
                "state.sqlite-journal",
                "state.sqlite-wal",
                "state.sqlite-shm",
            ],
        )?;
        remove_directory(&self.directory)
    }
}

#[allow(clippy::too_many_arguments)]
fn finish_and_publish_backup(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    trigger: BackupTrigger,
    app_version: &str,
    backup_id: Uuid,
    staging: StagedBackup,
    cancellation: &CancellationToken,
    deadline: Instant,
    fault: BackupFault,
) -> Result<VerifiedBackup, BackupError> {
    let cleanup = staging.cleanup();
    let (boundary, final_directory, directory_identity) = match stage_and_publish(
        paths,
        storage_instance_id,
        trigger,
        app_version,
        backup_id,
        staging,
        cancellation,
        deadline,
        fault,
    ) {
        Ok(published) => published,
        Err(error) => {
            cleanup.run();
            return Err(error);
        }
    };
    // Published: from here a failure keeps the generation.
    boundary.revalidate()?;
    let published_directory = inspect_child_directory(&boundary.store, &final_directory)?;
    if published_directory.identity != directory_identity {
        return Err(BackupError::Verification(
            "published backup directory identity differs from its stage".to_owned(),
        ));
    }
    fault.inject(BackupFault::BeforeParentSync)?;
    sync_directory(&boundary.store.path)?;

    fault.inject(BackupFault::BeforeReloadVerification)?;
    let verified = verify_generation(
        &boundary,
        &final_directory,
        backup_id,
        storage_instance_id,
        Some(cancellation),
        Some(deadline),
        VerifyLevel::Content,
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

/// Verifies the staged copy, writes its manifest and renames it into place. Every error
/// returned here leaves the staging directory unpublished.
#[allow(clippy::too_many_arguments)]
fn stage_and_publish(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    trigger: BackupTrigger,
    app_version: &str,
    backup_id: Uuid,
    staging: StagedBackup,
    cancellation: &CancellationToken,
    deadline: Instant,
    fault: BackupFault,
) -> Result<(BackupStoreBoundary, PathBuf, FileIdentity), BackupError> {
    ensure_active(cancellation, Some(deadline))?;
    let named_database = plain_path_snapshot(&staging.database, PlainPathKind::File)?;
    if named_database.identity != staging.database_identity {
        return Err(BackupError::Verification(
            "staged database identity changed during online backup".to_owned(),
        ));
    }
    set_private_open_file_permissions(&staging.database_reservation, &staging.database)?;
    drop(staging.database_reservation);
    fault.inject(BackupFault::BeforeQuickCheck)?;
    let integrity = quick_check_database(&staging.database, Some(cancellation), Some(deadline))?;
    if integrity != "ok" {
        return Err(BackupError::QuickCheck {
            path: staging.database,
            detail: integrity,
        });
    }
    let schema_version =
        backup_schema_version(&staging.database, Some(cancellation), Some(deadline))?;
    fault.inject(BackupFault::BeforeHash)?;
    let (database_size_bytes, sha256) =
        database_size_and_hash(&staging.database, Some(cancellation), Some(deadline))?;
    fault.inject(BackupFault::BeforeDatabaseSync)?;
    sync_file(&staging.database)?;
    // Taken at publication, so the 60 s skew against the directory's mtime holds however long
    // the copy and its checks took.
    let created_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| BackupError::Verification(format!("UTC timestamp failed: {error}")))?;
    let manifest = BackupManifest {
        backup_id,
        storage_instance_id,
        created_at,
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
    staging.boundary.revalidate()?;
    let staged_directory = inspect_child_directory(&staging.boundary.store, &staging.directory)?;
    if staged_directory.identity != staging.directory_identity {
        return Err(BackupError::Verification(
            "backup staging directory identity changed before publication".to_owned(),
        ));
    }
    match fs::symlink_metadata(&staging.final_directory) {
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(BackupError::Verification(
                "backup generation destination already exists".to_owned(),
            ));
        }
        Err(source) => {
            return Err(BackupError::Io {
                path: staging.final_directory.clone(),
                source,
            });
        }
    }
    fault.inject(BackupFault::BeforePublish)?;
    fs::rename(&staging.directory, &staging.final_directory).map_err(|source| BackupError::Io {
        path: staging.final_directory.clone(),
        source,
    })?;
    Ok((
        staging.boundary,
        staging.final_directory,
        staging.directory_identity,
    ))
}

fn inventory_blocking(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    cancellation: Option<&CancellationToken>,
    deadline: Option<Instant>,
) -> Result<BackupInventory, BackupError> {
    ensure_optional_active(cancellation, deadline)?;
    let Some(boundary) = BackupStoreBoundary::open_existing(paths, storage_instance_id)? else {
        return Ok(BackupInventory::default());
    };
    boundary.revalidate()?;
    let store_directory = boundary.store.path.clone();
    let entries = fs::read_dir(&store_directory).map_err(|source| BackupError::Io {
        path: store_directory.clone(),
        source,
    })?;
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
            &boundary,
            &entry.path(),
            backup_id,
            storage_instance_id,
            cancellation,
            deadline,
            VerifyLevel::Structural,
        ) {
            Ok(backup) => inventory.verified.push(backup),
            Err(error) => inventory.issues.push(BackupInventoryIssue {
                entry_name: name,
                message: error.to_string(),
            }),
        }
    }
    boundary.revalidate()?;
    inventory.verified.sort_by(|left, right| {
        left.identity
            .publication_time
            .cmp(&right.identity.publication_time)
            .then_with(|| left.manifest.backup_id.cmp(&right.manifest.backup_id))
    });
    Ok(inventory)
}

/// How much of a generation a check reads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VerifyLevel {
    /// Everything that does not grow with the file: identity, entries, manifest, timestamps,
    /// the size from metadata and the ledger version. Listing and deletion use it.
    Structural,
    /// `Structural` plus the SHA-256 and `quick_check`: publication, retention's
    /// replacements and restore.
    Content,
}

fn verify_generation(
    boundary: &BackupStoreBoundary,
    directory: &Path,
    expected_backup_id: Uuid,
    expected_storage_instance_id: StorageInstanceId,
    cancellation: Option<&CancellationToken>,
    deadline: Option<Instant>,
    level: VerifyLevel,
) -> Result<VerifiedBackup, BackupError> {
    ensure_optional_active(cancellation, deadline)?;
    boundary.revalidate()?;
    let generation = inspect_child_directory(&boundary.store, directory)?;
    let directory_snapshot = plain_path_snapshot(directory, PlainPathKind::Directory)?;
    ensure_exact_generation_entries(directory)?;
    let manifest_path = directory.join(MANIFEST_FILE_NAME);
    let database = directory.join(BACKUP_FILE_NAME);
    let manifest_snapshot = inspect_plain_child_file(&generation, &manifest_path)?;
    let database_snapshot = inspect_plain_child_file(&generation, &database)?;
    let manifest = serde_json::from_slice::<BackupManifest>(&read_manifest_bytes(&manifest_path)?)
        .map_err(|source| BackupError::ManifestDecode {
            path: manifest_path.clone(),
            source,
        })?;
    if manifest.backup_id != expected_backup_id
        || manifest.storage_instance_id != expected_storage_instance_id
        || manifest.state_kind != boundary.state_kind_value
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
    let canonical_created_at = created_at.format(&Rfc3339).map_err(|error| {
        BackupError::Verification(format!(
            "manifest UTC time could not be canonicalized: {error}"
        ))
    })?;
    if canonical_created_at != manifest.created_at {
        return Err(BackupError::Verification(
            "manifest creation time is not canonical RFC 3339 UTC".to_owned(),
        ));
    }
    let publication_time = OffsetDateTime::from(directory_snapshot.modified);
    let time_skew = created_at
        .unix_timestamp_nanos()
        .abs_diff(publication_time.unix_timestamp_nanos());
    if time_skew > MAX_PUBLICATION_TIME_SKEW.as_nanos() {
        return Err(BackupError::Verification(
            "manifest creation time does not match trusted publication time".to_owned(),
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
    if database_snapshot.size != manifest.database_size_bytes {
        return Err(BackupError::Verification(
            "manifest size or checksum does not match database".to_owned(),
        ));
    }
    if level == VerifyLevel::Content {
        let (size, sha256) = database_size_and_hash(&database, cancellation, deadline)?;
        if size != manifest.database_size_bytes || sha256 != manifest.sha256 {
            return Err(BackupError::Verification(
                "manifest size or checksum does not match database".to_owned(),
            ));
        }
    }
    let schema_version = backup_schema_version(&database, cancellation, deadline)?;
    if schema_version != manifest.schema_version {
        return Err(BackupError::Verification(
            "manifest schema version does not match the backup ledger".to_owned(),
        ));
    }
    if level == VerifyLevel::Content {
        let integrity = quick_check_database(&database, cancellation, deadline)?;
        if integrity != "ok" {
            return Err(BackupError::QuickCheck {
                path: database,
                detail: integrity,
            });
        }
    }
    boundary.revalidate()?;
    ensure_exact_generation_entries(directory)?;
    let confirmed_generation = inspect_child_directory(&boundary.store, directory)?;
    let confirmed_directory = plain_path_snapshot(directory, PlainPathKind::Directory)?;
    let confirmed_manifest = inspect_plain_child_file(&confirmed_generation, &manifest_path)?;
    let confirmed_database = inspect_plain_child_file(&confirmed_generation, &database)?;
    if confirmed_generation.identity != generation.identity
        || confirmed_directory != directory_snapshot
        || confirmed_manifest != manifest_snapshot
        || confirmed_database != database_snapshot
    {
        return Err(BackupError::Verification(
            "backup generation changed during verification".to_owned(),
        ));
    }
    Ok(VerifiedBackup {
        directory: directory.to_path_buf(),
        database,
        manifest_path,
        manifest,
        identity: VerifiedGenerationIdentity {
            directory: generation.identity,
            database: database_snapshot.identity,
            manifest: manifest_snapshot.identity,
            publication_time: directory_snapshot.modified,
        },
    })
}

fn ensure_exact_generation_entries(directory: &Path) -> Result<(), BackupError> {
    let mut database = false;
    let mut manifest = false;
    let mut count = 0_usize;
    for entry in fs::read_dir(directory).map_err(|source| BackupError::Io {
        path: directory.to_path_buf(),
        source,
    })? {
        let entry = entry.map_err(|source| BackupError::Io {
            path: directory.to_path_buf(),
            source,
        })?;
        count += 1;
        if entry.file_name() == OsStr::new(BACKUP_FILE_NAME) {
            database = true;
        } else if entry.file_name() == OsStr::new(MANIFEST_FILE_NAME) {
            manifest = true;
        } else {
            return Err(BackupError::Verification(
                "backup generation contains an unexpected entry".to_owned(),
            ));
        }
    }
    if count != 2 || !database || !manifest {
        return Err(BackupError::Verification(
            "backup generation must contain exactly state.sqlite and manifest.json".to_owned(),
        ));
    }
    Ok(())
}

fn inspect_plain_child_file(
    parent: &BoundDirectory,
    path: &Path,
) -> Result<PlainPathSnapshot, BackupError> {
    if path_parent(path)? != parent.path {
        return Err(BackupError::Verification(
            "backup file is not the expected direct child".to_owned(),
        ));
    }
    let snapshot = plain_path_snapshot(path, PlainPathKind::File)?;
    if snapshot.identity.volume != parent.volume {
        return Err(BackupError::Verification(
            "backup file crossed a filesystem boundary".to_owned(),
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let expected = parent.canonical.join(
        path.file_name()
            .ok_or_else(|| BackupError::Verification("backup file has no name".to_owned()))?,
    );
    if canonical != expected {
        return Err(BackupError::Verification(
            "backup file escapes its generation directory".to_owned(),
        ));
    }
    let confirmed = plain_path_snapshot(path, PlainPathKind::File)?;
    if confirmed != snapshot {
        return Err(BackupError::Verification(
            "backup file identity changed during inspection".to_owned(),
        ));
    }
    Ok(snapshot)
}

/// Keeps the newest `RETAINED_GENERATIONS`, deleting an older generation only behind that many
/// newer ones that pass `Content` verification now. A generation that fails is kept and never
/// counts. Running out of time or being cancelled deletes nothing in this call; the new
/// generation is already published.
fn apply_retention(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    published_backup_id: Uuid,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<(), BackupError> {
    match apply_retention_inner(
        paths,
        storage_instance_id,
        published_backup_id,
        cancellation,
        deadline,
    ) {
        Err(BackupError::DeadlineElapsed | BackupError::Cancelled) => {
            tracing::warn!(
                %published_backup_id,
                "backup retention stopped before it could verify the newer generations; older ones are kept until a later backup"
            );
            Ok(())
        }
        other => other,
    }
}

fn apply_retention_inner(
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
    // A new pre-compact generation, verified at its publication, replaces the older ones, so
    // repeated compaction displaces at most one other generation from the newest three.
    let published_is_pre_compact = inventory.verified.iter().any(|backup| {
        backup.manifest.backup_id == published_backup_id
            && backup.manifest.trigger == BackupTrigger::PreCompact
    });
    let (mut removals, candidates): (Vec<&VerifiedBackup>, Vec<&VerifiedBackup>) =
        inventory.verified.iter().partition(|backup| {
            published_is_pre_compact
                && backup.manifest.trigger == BackupTrigger::PreCompact
                && backup.manifest.backup_id != published_backup_id
        });
    if candidates.len() > RETAINED_GENERATIONS {
        let boundary = BackupStoreBoundary::open_existing(paths, storage_instance_id)?
            .ok_or_else(|| BackupError::Verification("backup store disappeared".to_owned()))?;
        let mut replacements = 0_usize;
        // Newest first; the inventory is sorted by publication time.
        for backup in candidates.iter().rev() {
            if replacements == RETAINED_GENERATIONS {
                removals.push(backup);
                continue;
            }
            if backup.manifest.backup_id == published_backup_id {
                // Content-verified by this call's reload verification.
                replacements += 1;
                continue;
            }
            match verify_generation(
                &boundary,
                &backup.directory,
                backup.manifest.backup_id,
                storage_instance_id,
                Some(cancellation),
                Some(deadline),
                VerifyLevel::Content,
            ) {
                Ok(current) if current.identity == backup.identity => replacements += 1,
                Ok(_) => tracing::warn!(
                    backup_id = %backup.manifest.backup_id,
                    "kept a backup generation that changed during retention"
                ),
                Err(error @ (BackupError::DeadlineElapsed | BackupError::Cancelled)) => {
                    return Err(error);
                }
                Err(error) => tracing::warn!(
                    backup_id = %backup.manifest.backup_id,
                    detail = %error,
                    "kept a backup generation that failed verification; it does not count toward retention"
                ),
            }
        }
    }
    for backup in removals {
        ensure_active(cancellation, Some(deadline))?;
        if backup.manifest.backup_id == published_backup_id {
            continue;
        }
        if let Err(error) = delete_verified_generation_inner(
            paths,
            storage_instance_id,
            backup,
            Some(cancellation),
            Some(deadline),
            || {},
        ) {
            tracing::warn!(
                backup_id = %backup.manifest.backup_id,
                detail = %error,
                "failed to delete an expired verified backup"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
fn delete_verified_generation_with_hook<F>(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    expected: &VerifiedBackup,
    hook: F,
) -> Result<(), BackupError>
where
    F: FnOnce(),
{
    delete_verified_generation_inner(paths, storage_instance_id, expected, None, None, hook)
}

fn delete_verified_generation_inner<F>(
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    expected: &VerifiedBackup,
    cancellation: Option<&CancellationToken>,
    deadline: Option<Instant>,
    hook: F,
) -> Result<(), BackupError>
where
    F: FnOnce(),
{
    ensure_optional_active(cancellation, deadline)?;
    let boundary = BackupStoreBoundary::open_existing(paths, storage_instance_id)?
        .ok_or_else(|| BackupError::Verification("backup store disappeared".to_owned()))?;
    boundary.revalidate()?;
    let current = verify_generation(
        &boundary,
        &expected.directory,
        expected.manifest.backup_id,
        storage_instance_id,
        cancellation,
        deadline,
        VerifyLevel::Structural,
    )?;
    ensure_same_generation_identity(expected, &current)?;
    hook();
    ensure_optional_active(cancellation, deadline)?;
    boundary.revalidate()?;
    let current = verify_generation(
        &boundary,
        &expected.directory,
        expected.manifest.backup_id,
        storage_instance_id,
        cancellation,
        deadline,
        VerifyLevel::Structural,
    )?;
    ensure_same_generation_identity(expected, &current)?;

    remove_verified_file(&current.manifest_path, current.identity.manifest)?;
    boundary.revalidate()?;
    remove_verified_file(&current.database, current.identity.database)?;
    boundary.revalidate()?;
    let directory = inspect_child_directory(&boundary.store, &current.directory)?;
    if directory.identity != current.identity.directory {
        return Err(BackupError::Verification(
            "backup generation directory changed before deletion".to_owned(),
        ));
    }
    fs::remove_dir(&current.directory).map_err(|source| BackupError::Io {
        path: current.directory.clone(),
        source,
    })?;
    sync_directory(&boundary.store.path)
}

fn ensure_same_generation_identity(
    expected: &VerifiedBackup,
    current: &VerifiedBackup,
) -> Result<(), BackupError> {
    if expected.identity != current.identity {
        return Err(BackupError::Verification(
            "backup generation identity changed before retention".to_owned(),
        ));
    }
    Ok(())
}

fn remove_verified_file(path: &Path, expected: FileIdentity) -> Result<(), BackupError> {
    let snapshot = plain_path_snapshot(path, PlainPathKind::File)?;
    if snapshot.identity != expected {
        return Err(BackupError::Verification(
            "backup file identity changed before deletion".to_owned(),
        ));
    }
    let confirmed = plain_path_snapshot(path, PlainPathKind::File)?;
    if confirmed.identity != expected {
        return Err(BackupError::Verification(
            "backup file identity changed during deletion".to_owned(),
        ));
    }
    fs::remove_file(path).map_err(|source| BackupError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn backup_schema_version(
    database: &Path,
    cancellation: Option<&CancellationToken>,
    deadline: Option<Instant>,
) -> Result<i64, BackupError> {
    ensure_optional_active(cancellation, deadline)?;
    let connection = open_read_only_database(database)?;
    if cancellation.is_some() || deadline.is_some() {
        let cancellation = cancellation.cloned();
        connection
            .progress_handler(
                SQLITE_PROGRESS_OPS,
                Some(move || {
                    cancellation
                        .as_ref()
                        .is_some_and(CancellationToken::is_cancelled)
                        || deadline.is_some_and(|deadline| Instant::now() >= deadline)
                }),
            )
            .map_err(|source| BackupError::Persistence(PersistenceError::Sql(source)))?;
    }
    let mut statement = connection
        .prepare(
            "SELECT migration_id, name \
             FROM effect_sql_migrations \
             ORDER BY migration_id ASC \
             LIMIT ?1",
        )
        .map_err(|source| BackupError::Persistence(PersistenceError::Sql(source)))?;
    let row_limit = i64::try_from(MIGRATIONS.len() + 1)
        .map_err(|_| BackupError::Verification("migration count overflowed i64".to_owned()))?;
    let recorded = statement
        .query_map([row_limit], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(|source| {
            if source.sqlite_error_code() == Some(ErrorCode::OperationInterrupted) {
                ensure_optional_active(cancellation, deadline)
                    .err()
                    .unwrap_or_else(|| BackupError::Persistence(PersistenceError::Sql(source)))
            } else {
                BackupError::Persistence(PersistenceError::Sql(source))
            }
        })?;
    ensure_optional_active(cancellation, deadline)?;
    if recorded.is_empty()
        || recorded.len() > MIGRATIONS.len()
        || recorded
            .iter()
            .zip(MIGRATIONS)
            .any(|((id, name), expected)| *id != expected.id || name != expected.name)
    {
        return Err(BackupError::Verification(
            "backup migration ledger is not an exact prefix of this binary".to_owned(),
        ));
    }
    Ok(i64::from(
        recorded
            .last()
            .expect("non-empty recognized migration ledger")
            .0,
    ))
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
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
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
    plain_path_snapshot(path, PlainPathKind::File).map(|_| ())
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), BackupError> {
    use std::os::unix::fs::PermissionsExt;
    let directory =
        open_path_without_following(path, PlainPathKind::Directory).map_err(|source| {
            BackupError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?;
    directory
        .set_permissions(fs::Permissions::from_mode(0o700))
        .map_err(|source| BackupError::Io {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), BackupError> {
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

#[cfg(unix)]
fn set_private_open_file_permissions(file: &File, path: &Path) -> Result<(), BackupError> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|source| BackupError::Io {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(not(unix))]
fn set_private_open_file_permissions(_file: &File, _path: &Path) -> Result<(), BackupError> {
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

    struct BackupFixture {
        _root: TempDir,
        paths: StatePaths,
        database: Database,
        prepared: PreparedStore,
    }

    async fn backup_fixture() -> BackupFixture {
        let root = TempDir::new().expect("backup fixture root");
        let mut config = ServerConfig::new(root.path());
        let resolved = resolve_data_root(config.data_root_request.clone()).expect("resolve root");
        config.base_dir.clone_from(&resolved.effective);
        config.resolved_data_root = Some(resolved);
        let paths = StatePaths::from_config(&config);
        fs::create_dir_all(&paths.state_dir).expect("state directory");
        let mut setup = Connection::open(&paths.database).expect("source database");
        run_migrations(&mut setup, None).expect("source schema");
        drop(setup);
        let storage_instance_id = StorageInstanceId::from_uuid(Uuid::new_v4());
        fs::write(&paths.environment_id, format!("{storage_instance_id}\n"))
            .expect("source marker");
        let database = Database::open_existing(&paths.database)
            .await
            .expect("source worker");
        let prepared = PreparedStore {
            database: database.clone(),
            storage_instance_id,
            classification: crate::persistence::StoreClassification::Existing,
            paths: paths.clone(),
        };
        BackupFixture {
            _root: root,
            paths,
            database,
            prepared,
        }
    }

    #[tokio::test]
    async fn pre_compact_retention_keeps_one_pre_compact_and_two_older_generations() {
        let fixture = backup_fixture().await;
        let mut published = Vec::new();
        for trigger in [
            BackupTrigger::PreUpdate,
            BackupTrigger::PreMigration,
            BackupTrigger::PreCompact,
            BackupTrigger::PreCompact,
        ] {
            published.push(
                create_verified_backup(&fixture.database, &fixture.prepared, trigger, "test")
                    .await
                    .expect("verified backup")
                    .manifest
                    .backup_id,
            );
        }

        let inventory =
            inventory_verified_backups(&fixture.paths, fixture.prepared.storage_instance_id)
                .await
                .expect("inventory");
        let kept = inventory
            .verified
            .iter()
            .map(|backup| (backup.manifest.backup_id, backup.manifest.trigger))
            .collect::<Vec<_>>();
        // The second compaction expired the first pre-compact generation, not a pre-update or
        // pre-migration one.
        assert_eq!(
            kept,
            vec![
                (published[0], BackupTrigger::PreUpdate),
                (published[1], BackupTrigger::PreMigration),
                (published[3], BackupTrigger::PreCompact),
            ]
        );

        // Other triggers keep the newest three, whatever their kind.
        let next = create_verified_backup(
            &fixture.database,
            &fixture.prepared,
            BackupTrigger::PreUpdate,
            "test",
        )
        .await
        .expect("verified backup")
        .manifest
        .backup_id;
        let inventory =
            inventory_verified_backups(&fixture.paths, fixture.prepared.storage_instance_id)
                .await
                .expect("inventory");
        let kept = inventory
            .verified
            .iter()
            .map(|backup| backup.manifest.backup_id)
            .collect::<Vec<_>>();
        assert_eq!(kept, vec![published[1], published[3], next]);
        fixture.database.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn recovery_lookup_verifies_only_the_selected_generation() {
        const LARGE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
        let fixture = backup_fixture().await;
        // Two older generations become sparse 8 GiB files with matching manifests, so a lookup
        // that verifies them cannot finish inside its deadline, whatever the directory order.
        let mut large = Vec::new();
        for _ in 0..2 {
            large.push(
                create_verified_backup(
                    &fixture.database,
                    &fixture.prepared,
                    BackupTrigger::PreUpdate,
                    "test",
                )
                .await
                .expect("older backup"),
            );
        }
        let selected = create_verified_backup(
            &fixture.database,
            &fixture.prepared,
            BackupTrigger::PreCompact,
            "test",
        )
        .await
        .expect("selected backup");
        fixture.database.close().await;
        for backup in &large {
            OpenOptions::new()
                .write(true)
                .open(&backup.database)
                .expect("older backup database")
                .set_len(LARGE_BYTES)
                .expect("sparse 8 GiB backup");
            let mut manifest = backup.manifest.clone();
            manifest.database_size_bytes = LARGE_BYTES;
            let mut contents = serde_json::to_vec_pretty(&manifest).expect("manifest JSON");
            contents.push(b'\n');
            fs::write(&backup.manifest_path, contents).expect("rewrite manifest size");
        }

        let started = Instant::now();
        let deadline = started + Duration::from_secs(2);
        let (found, _) = find_verified_backup_for_recovery(
            &fixture.paths,
            selected.manifest.backup_id,
            &CancellationToken::new(),
            deadline,
            StoreIoBudget {
                base: Duration::ZERO,
                per_gib: Duration::ZERO,
            },
            started,
        )
        .expect("lookup verifies only the selected generation")
        .expect("selected backup found");
        assert_eq!(found.manifest.backup_id, selected.manifest.backup_id);
    }

    #[test]
    fn staged_database_sync_reopens_the_file_with_write_access() {
        let root = TempDir::new().expect("sync fixture root");
        let path = root.path().join(BACKUP_FILE_NAME);
        let mut file = private_create_new(&path).expect("sync fixture should create");
        file.write_all(b"durable backup fixture")
            .expect("sync fixture should write");
        drop(file);

        sync_file(&path).expect("staged database should flush on every supported platform");
    }

    #[tokio::test]
    async fn restore_failure_after_preservation_keeps_the_journal_and_recoverable_live_files() {
        let root = TempDir::new().expect("recovery seam root");
        let mut config = ServerConfig::new(root.path());
        let resolved = resolve_data_root(config.data_root_request.clone()).expect("resolve root");
        config.base_dir.clone_from(&resolved.effective);
        config.resolved_data_root = Some(resolved.clone());
        let paths = StatePaths::from_config(&config);
        fs::create_dir_all(&paths.state_dir).expect("state directory");
        let mut setup = Connection::open(&paths.database).expect("source database");
        run_migrations(&mut setup, None).expect("source schema");
        setup
            .execute_batch(
                "INSERT INTO projection_projects (
                   project_id, title, workspace_root, default_model_selection_json,
                   scripts_json, created_at, updated_at, deleted_at
                 ) VALUES ('recovery-seam', 'Preserved', '/tmp/recovery-seam', NULL, '{}',
                           '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', NULL)",
            )
            .expect("source row");
        drop(setup);
        let storage_instance_id = StorageInstanceId::from_uuid(Uuid::new_v4());
        fs::write(&paths.environment_id, format!("{storage_instance_id}\n"))
            .expect("source marker");
        let database = Database::open_existing(&paths.database)
            .await
            .expect("source worker");
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
            "recovery-seam-test",
        )
        .await
        .expect("verified backup");
        drop(prepared);
        database.close().await;

        let error = restore_backup_with_fault(
            &resolved,
            backup.manifest.backup_id,
            RecoveryFault::AfterPreserve,
        )
        .await
        .expect_err("injected post-preservation failure");

        assert!(
            matches!(&error, RecoveryError::Backup(BackupError::Verification(_))),
            "unexpected recovery error: {error:?}"
        );
        assert!(paths.recovery_journal().is_file());
        assert!(!paths.database.exists());
        assert!(!paths.environment_id.exists());
        let recovery_entries = fs::read_dir(paths.recovery_dir())
            .expect("recovery directory")
            .map(|entry| entry.expect("recovery entry").path())
            .collect::<Vec<_>>();
        assert_eq!(recovery_entries.len(), 1);
        assert!(recovery_entries[0].join("state.sqlite").is_file());
        assert!(recovery_entries[0].join("environment-id").is_file());
        let startup = crate::persistence::prepare_store(&config)
            .await
            .expect_err("journal must block startup after interrupted restore");
        assert!(matches!(
            startup,
            crate::persistence::StoreStartupError::RecoveryIncomplete { .. }
        ));
        assert!(
            startup.to_string().contains(RESUME_COMMAND),
            "the refusal names the command that finishes it: {startup}"
        );

        let resumed = resume_recovery(&resolved)
            .await
            .expect("resume finishes it");
        assert_eq!(
            resumed.resumed.map(|result| result.operation_id),
            Some(operation_id_of(&recovery_entries[0]))
        );
        assert!(!paths.recovery_journal().exists());
        assert!(paths.database.is_file());
        let prepared = crate::persistence::prepare_store(&config)
            .await
            .expect("the finished restore opens");
        prepared.database.close().await;
    }

    /// The operation ID a preserved directory's `<timestamp>-<operation-id>` name carries.
    fn operation_id_of(preserved: &Path) -> Uuid {
        let name = preserved.file_name().expect("name").to_string_lossy();
        Uuid::parse_str(name.split_once('-').expect("timestamp prefix").1).expect("operation ID")
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
                BackupFault::None,
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
            let published = matches!(
                fault,
                BackupFault::BeforeParentSync | BackupFault::BeforeReloadVerification
            );
            assert!(
                !store.join(format!(".{backup_id}.staging")).exists(),
                "an unpublished staging directory is removed at {fault:?}"
            );
            assert_eq!(
                store.join(backup_id.to_string()).is_dir(),
                published,
                "only a published generation is kept at {fault:?}"
            );
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

    #[tokio::test]
    async fn every_new_backup_ancestor_sync_failure_preserves_source_bytes_and_schema() {
        for fault in [
            BackupFault::BeforeBackupsDirectorySync,
            BackupFault::BeforeBackupsParentSync,
            BackupFault::BeforeStateKindDirectorySync,
            BackupFault::BeforeStateKindParentSync,
            BackupFault::BeforeStoreDirectorySync,
            BackupFault::BeforeStoreParentSync,
        ] {
            let root = TempDir::new().expect("ancestor sync root");
            let paths = StatePaths::from_config(&ServerConfig::new(root.path()));
            fs::create_dir_all(&paths.state_dir).expect("state directory");
            let mut setup = Connection::open(&paths.database).expect("source database");
            run_migrations(&mut setup, Some(38)).expect("source schema");
            drop(setup);
            let source_bytes = fs::read(&paths.database).expect("source bytes");
            let source_schema = schema_version(&paths.database);
            let storage_instance_id = StorageInstanceId::from_uuid(Uuid::new_v4());
            let cancellation = CancellationToken::new();

            let error = prepare_staging_directory(
                &paths,
                storage_instance_id,
                Uuid::new_v4(),
                &cancellation,
                Instant::now() + Duration::from_secs(5),
                fault,
            )
            .expect_err("ancestor durability seam must fail");

            assert!(matches!(error, BackupError::Verification(_)));
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
        }
    }

    #[tokio::test]
    async fn retention_race_never_deletes_a_foreign_replacement_or_extra() {
        let root = TempDir::new().expect("retention race root");
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
            "retention-race-test",
        )
        .await
        .expect("verified backup");
        let foreign_manifest = b"foreign replacement";
        let foreign_extra = backup.directory.join("foreign-extra");

        let error =
            delete_verified_generation_with_hook(&paths, storage_instance_id, &backup, || {
                fs::remove_file(&backup.manifest_path).expect("remove owned manifest");
                fs::write(&backup.manifest_path, foreign_manifest).expect("foreign manifest");
                fs::write(&foreign_extra, b"foreign extra").expect("foreign extra");
            })
            .expect_err("identity replacement must stop deletion");

        assert!(matches!(error, BackupError::Verification(_)));
        assert_eq!(
            fs::read(&backup.manifest_path).expect("foreign manifest remains"),
            foreign_manifest
        );
        assert_eq!(
            fs::read(&foreign_extra).expect("foreign extra remains"),
            b"foreign extra"
        );
        assert!(backup.database.is_file(), "owned database is not deleted");
        drop(prepared);
        database.close().await;
    }

    // --- Issue 262: large-store compaction, retention and recovery -------------------------

    const BACKED_UP_TITLE: &str = "Backed-up project";
    const LIVE_TITLE: &str = "Live-only project";

    fn insert_project(database: &Path, project_id: &str, title: &str) {
        Connection::open(database)
            .expect("project database")
            .execute(
                "INSERT INTO projection_projects (
                   project_id, title, workspace_root, default_model_selection_json,
                   scripts_json, created_at, updated_at, deleted_at
                 ) VALUES (?1, ?2, '/tmp/262', NULL, '{}',
                           '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z', NULL)",
                (project_id, title),
            )
            .expect("insert project");
    }

    fn project_titles(database: &Path) -> Vec<String> {
        let connection = Connection::open(database).expect("titles database");
        let mut statement = connection
            .prepare("SELECT title FROM projection_projects ORDER BY title")
            .expect("titles");
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("title rows")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("titles")
    }

    fn sha256_hex(path: &Path) -> String {
        Sha256::digest(fs::read(path).expect("hashed file"))
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn entries(directory: &Path) -> Vec<String> {
        let mut names = match fs::read_dir(directory) {
            Ok(entries) => entries
                .map(|entry| {
                    entry
                        .expect("entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        names.sort();
        names
    }

    fn staging_entries(paths: &StatePaths) -> Vec<String> {
        entries(&paths.base_dir)
            .into_iter()
            .filter(|name| name.ends_with(".recovery-staging") || name.ends_with(".tmp"))
            .collect()
    }

    /// A marked store with one project, a verified backup of it, then a second live-only
    /// project and crash-left `-wal` and `-shm` files, all offline.
    struct RestoreFixture {
        _root: TempDir,
        resolved: ResolvedDataRoot,
        config: ServerConfig,
        paths: StatePaths,
        backup: VerifiedBackup,
        /// `state.sqlite`, `-wal`, `-shm`, `environment-id` before the restore.
        live: Vec<(String, Vec<u8>)>,
    }

    async fn restore_fixture() -> RestoreFixture {
        let root = TempDir::new().expect("restore fixture root");
        let mut config = ServerConfig::new(root.path());
        let resolved = resolve_data_root(config.data_root_request.clone()).expect("resolve root");
        config.base_dir.clone_from(&resolved.effective);
        config.resolved_data_root = Some(resolved.clone());
        let paths = StatePaths::from_config(&config);
        fs::create_dir_all(&paths.state_dir).expect("state directory");
        let mut setup = Connection::open(&paths.database).expect("source database");
        run_migrations(&mut setup, None).expect("source schema");
        drop(setup);
        insert_project(&paths.database, "backed-up", BACKED_UP_TITLE);
        let storage_instance_id = StorageInstanceId::from_uuid(Uuid::new_v4());
        fs::write(&paths.environment_id, format!("{storage_instance_id}\n")).expect("marker");
        let database = Database::open_existing(&paths.database)
            .await
            .expect("source worker");
        let prepared = PreparedStore {
            database: database.clone(),
            storage_instance_id,
            classification: crate::persistence::StoreClassification::Existing,
            paths: paths.clone(),
        };
        let backup = create_verified_backup(&database, &prepared, BackupTrigger::PreUpdate, "262")
            .await
            .expect("verified backup");
        drop(prepared);
        database.close().await;
        insert_project(&paths.database, "live-only", LIVE_TITLE);
        fs::write(sqlite_sidecar_path(&paths.database, "-wal"), b"old wal").expect("old wal");
        fs::write(sqlite_sidecar_path(&paths.database, "-shm"), b"old shm").expect("old shm");
        let live = [
            BACKUP_FILE_NAME,
            "state.sqlite-wal",
            "state.sqlite-shm",
            MARKER_FILE_NAME,
        ]
        .into_iter()
        .map(|name| {
            (
                name.to_owned(),
                fs::read(paths.state_dir.join(name)).expect("live file"),
            )
        })
        .collect();
        RestoreFixture {
            _root: root,
            resolved,
            config,
            paths,
            backup,
            live,
        }
    }

    impl RestoreFixture {
        fn assert_live_unchanged(&self) {
            for (name, bytes) in &self.live {
                assert_eq!(
                    &fs::read(self.paths.state_dir.join(name)).expect("live file remains"),
                    bytes,
                    "{name} changed"
                );
            }
        }

        fn assert_nothing_left_behind(&self) {
            assert!(!self.paths.recovery_journal().exists(), "no journal");
            assert_eq!(staging_entries(&self.paths), Vec::<String>::new());
            assert_eq!(entries(&self.paths.recovery_dir()), Vec::<String>::new());
        }

        async fn assert_startable_with(&self, titles: &[&str]) {
            let prepared = crate::persistence::prepare_store(&self.config)
                .await
                .expect("the store opens");
            prepared.database.close().await;
            assert_eq!(project_titles(&self.paths.database), titles);
        }

        async fn assert_startup_names_resume(&self) {
            let error = crate::persistence::prepare_store(&self.config)
                .await
                .expect_err("startup refuses an interrupted recovery");
            assert!(
                matches!(
                    error,
                    crate::persistence::StoreStartupError::RecoveryIncomplete { .. }
                ),
                "{error:?}"
            );
            assert!(error.to_string().contains(RESUME_COMMAND), "{error}");
        }

        /// The restore finished: the backup's bytes and identity are live, and every old live
        /// file sits byte-identical in the preserved directory.
        fn assert_restored(&self) {
            assert_eq!(
                sha256_hex(&self.paths.database),
                self.backup.manifest.sha256
            );
            assert_eq!(
                read_marker_id(&self.paths).expect("marker"),
                Some(self.backup.manifest.storage_instance_id)
            );
            assert!(!sqlite_sidecar_path(&self.paths.database, "-wal").exists());
            assert!(!sqlite_sidecar_path(&self.paths.database, "-shm").exists());
            let preserved = entries(&self.paths.recovery_dir());
            assert_eq!(preserved.len(), 1, "{preserved:?}");
            let preserved = self.paths.recovery_dir().join(&preserved[0]);
            for (name, bytes) in &self.live {
                assert_eq!(
                    &fs::read(preserved.join(name)).expect("preserved file"),
                    bytes,
                    "{name} preserved"
                );
            }
            assert!(!self.paths.recovery_journal().exists());
            assert_eq!(staging_entries(&self.paths), Vec::<String>::new());
        }
    }

    #[test]
    fn store_io_budget_scales_with_bytes_and_saturates() {
        const GIB: u64 = 1024 * 1024 * 1024;
        let large = StoreIoBudget::LARGE_STORE;
        assert_eq!(large.for_bytes(0), Duration::from_secs(30));
        assert_eq!(large.for_bytes(1), Duration::from_millis(30_001));
        assert_eq!(large.for_bytes(GIB), Duration::from_secs(270));
        assert_eq!(large.for_bytes(7 * GIB), Duration::from_secs(1_710));
        assert_eq!(large.for_bytes(u64::MAX), Duration::from_secs(24 * 60 * 60));
        assert_eq!(StoreIoBudget::FIXED.for_bytes(0), Duration::from_secs(30));
        assert_eq!(
            StoreIoBudget::FIXED.for_bytes(u64::MAX),
            Duration::from_secs(30)
        );
        assert_eq!(format_duration_words(Duration::from_secs(30)), "30 seconds");
        assert_eq!(format_duration_words(Duration::from_secs(60)), "1 minute");
        assert_eq!(
            format_duration_words(Duration::from_secs(1_710)),
            "29 minutes"
        );
    }

    fn run(deadline: Instant, pause: Option<Duration>) -> BackupRun {
        BackupRun {
            cancellation: CancellationToken::new(),
            deadline,
            pause_after_copy: pause,
            after_step: None,
        }
    }

    #[tokio::test]
    async fn created_at_is_taken_when_the_manifest_is_written() {
        let fixture = backup_fixture().await;
        let started = OffsetDateTime::now_utc();
        let backup = create_backup_run(
            &fixture.database,
            &fixture.prepared,
            BackupTrigger::PreCompact,
            "262",
            run(
                Instant::now() + Duration::from_secs(10),
                Some(Duration::from_millis(1_500)),
            ),
        )
        .await
        .expect("backup outlasting the pause");
        let created_at =
            OffsetDateTime::parse(&backup.manifest.created_at, &Rfc3339).expect("created_at");
        assert!(
            created_at >= started + time::Duration::milliseconds(1_500),
            "created_at {created_at} is not after the copy that started at {started}"
        );
        let inventory =
            inventory_verified_backups(&fixture.paths, fixture.prepared.storage_instance_id)
                .await
                .expect("inventory");
        assert!(
            inventory
                .verified
                .iter()
                .any(|listed| listed.manifest.backup_id == backup.manifest.backup_id)
        );
        fixture.database.close().await;
    }

    #[tokio::test]
    async fn a_backup_past_the_fixed_budget_publishes_under_its_deadline() {
        let fixture = backup_fixture().await;
        let store = fixture
            .paths
            .backup_store_dir(fixture.prepared.storage_instance_id);
        create_backup_run(
            &fixture.database,
            &fixture.prepared,
            BackupTrigger::PreCompact,
            "262",
            run(
                Instant::now() + Duration::from_secs(3),
                Some(Duration::from_millis(1_500)),
            ),
        )
        .await
        .expect("a 3 s deadline covers the pause");
        let before = entries(&store);

        let error = create_backup_run(
            &fixture.database,
            &fixture.prepared,
            BackupTrigger::PreCompact,
            "262",
            run(
                Instant::now() + Duration::from_secs(1),
                Some(Duration::from_millis(1_500)),
            ),
        )
        .await
        .expect_err("a 1 s deadline does not");

        assert!(matches!(error, BackupError::DeadlineElapsed), "{error:?}");
        assert_eq!(
            entries(&store),
            before,
            "no staging entry and no new generation"
        );
        fixture.database.close().await;
    }

    #[tokio::test]
    async fn cancelling_a_backup_mid_copy_removes_its_staging() {
        let fixture = backup_fixture().await;
        fixture
            .database
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TABLE filler(x BLOB); INSERT INTO filler VALUES (zeroblob(2000000));",
                )?;
                Ok(())
            })
            .await
            .expect("multi-step fixture");
        let cancellation = CancellationToken::new();
        let after_step = {
            let cancellation = cancellation.clone();
            std::sync::Arc::new(move || cancellation.cancel())
                as std::sync::Arc<dyn Fn() + Send + Sync>
        };

        let error = create_backup_run(
            &fixture.database,
            &fixture.prepared,
            BackupTrigger::PreCompact,
            "262",
            BackupRun {
                cancellation,
                deadline: Instant::now() + Duration::from_secs(10),
                pause_after_copy: None,
                after_step: Some(after_step),
            },
        )
        .await
        .expect_err("cancelled after the first step");

        assert!(matches!(error, BackupError::Cancelled), "{error:?}");
        let store = fixture
            .paths
            .backup_store_dir(fixture.prepared.storage_instance_id);
        assert_eq!(entries(&store), Vec::<String>::new());
        fixture.database.close().await;
    }

    /// Makes `backup` a sparse 256 GiB file whose manifest size matches and whose hash is stale.
    #[cfg(unix)]
    fn make_sparse_large(backup: &VerifiedBackup) {
        const LARGE_BYTES: u64 = 256 * 1024 * 1024 * 1024;
        OpenOptions::new()
            .write(true)
            .open(&backup.database)
            .expect("backup database")
            .set_len(LARGE_BYTES)
            .expect("sparse large backup");
        let mut manifest = backup.manifest.clone();
        manifest.database_size_bytes = LARGE_BYTES;
        let mut contents = serde_json::to_vec_pretty(&manifest).expect("manifest JSON");
        contents.push(b'\n');
        fs::write(&backup.manifest_path, contents).expect("rewrite manifest size");
    }

    #[cfg(unix)]
    async fn small_backup(fixture: &BackupFixture, deadline: Duration) -> VerifiedBackup {
        create_backup_run(
            &fixture.database,
            &fixture.prepared,
            BackupTrigger::PreUpdate,
            "262",
            run(Instant::now() + deadline, None),
        )
        .await
        .expect("small backup")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listing_and_retention_read_only_metadata_of_a_large_generation() {
        let fixture = backup_fixture().await;
        let large = small_backup(&fixture, Duration::from_secs(30)).await;
        make_sparse_large(&large);

        let inventory = inventory_blocking(
            &fixture.paths,
            fixture.prepared.storage_instance_id,
            Some(&CancellationToken::new()),
            Some(Instant::now() + Duration::from_secs(2)),
        )
        .expect("listing reads only metadata");
        assert!(
            inventory
                .verified
                .iter()
                .any(|listed| listed.manifest.backup_id == large.manifest.backup_id)
        );

        for _ in 0..3 {
            small_backup(&fixture, Duration::from_secs(5)).await;
        }
        assert!(!large.directory.exists(), "retention deleted it unread");
        fixture.database.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retention_defers_instead_of_failing_beside_a_large_replacement() {
        let fixture = backup_fixture().await;
        let older = [
            small_backup(&fixture, Duration::from_secs(30)).await,
            small_backup(&fixture, Duration::from_secs(30)).await,
        ];
        let large = create_verified_backup(
            &fixture.database,
            &fixture.prepared,
            BackupTrigger::PreCompact,
            "262",
        )
        .await
        .expect("pre-compact backup");
        make_sparse_large(&large);

        // The large generation is one of the newest three, so retention must verify it.
        let deferred = [
            small_backup(&fixture, Duration::from_secs(3)).await,
            small_backup(&fixture, Duration::from_secs(3)).await,
        ];
        for backup in older.iter().chain([&large]).chain(&deferred) {
            assert!(backup.directory.is_dir(), "nothing deleted while deferred");
        }

        let newest = small_backup(&fixture, Duration::from_secs(3)).await;
        for backup in older.iter().chain([&large]) {
            assert!(
                !backup.directory.exists(),
                "deleted behind three replacements"
            );
        }
        for backup in deferred.iter().chain([&newest]) {
            assert!(backup.directory.is_dir());
        }
        fixture.database.close().await;
    }

    #[tokio::test]
    async fn restore_deadline_is_scaled_by_the_selected_backup() {
        let fixture = restore_fixture().await;
        let pause = RecoveryFault::PauseAfterLookup(Duration::from_millis(1_500));
        let error = restore_backup_with_budget(
            &fixture.resolved,
            fixture.backup.manifest.backup_id,
            StoreIoBudget {
                base: Duration::from_secs(1),
                per_gib: Duration::ZERO,
            },
            pause,
        )
        .await
        .expect_err("without the size term the pause outlasts the deadline");
        assert!(
            matches!(error, RecoveryError::RestoreDeadline { .. }),
            "{error:?}"
        );
        fixture.assert_live_unchanged();
        fixture.assert_nothing_left_behind();

        restore_backup_with_budget(
            &fixture.resolved,
            fixture.backup.manifest.backup_id,
            StoreIoBudget {
                base: Duration::from_secs(1),
                per_gib: Duration::from_secs(48 * 60 * 60),
            },
            pause,
        )
        .await
        .expect("the size term covers the pause");
        fixture.assert_restored();
        fixture.assert_startable_with(&[BACKED_UP_TITLE]).await;
    }

    #[tokio::test]
    async fn restore_failure_before_the_journal_removes_its_staging_and_stays_startable() {
        let fixture = restore_fixture().await;
        let error = restore_backup_with_fault(
            &fixture.resolved,
            fixture.backup.manifest.backup_id,
            RecoveryFault::BeforeJournal,
        )
        .await
        .expect_err("injected failure before the journal");
        assert!(matches!(error, RecoveryError::Backup(_)), "{error:?}");
        fixture.assert_live_unchanged();
        fixture.assert_nothing_left_behind();
        fs::remove_file(sqlite_sidecar_path(&fixture.paths.database, "-wal")).expect("fixture wal");
        fs::remove_file(sqlite_sidecar_path(&fixture.paths.database, "-shm")).expect("fixture shm");
        fixture
            .assert_startable_with(&[BACKED_UP_TITLE, LIVE_TITLE])
            .await;
    }

    #[tokio::test]
    async fn restore_cancelled_before_the_journal_changes_nothing() {
        let fixture = restore_fixture().await;
        let error = restore_backup_with_fault(
            &fixture.resolved,
            fixture.backup.manifest.backup_id,
            RecoveryFault::CancelAfterLookup,
        )
        .await
        .expect_err("cancelled");
        assert!(
            matches!(error, RecoveryError::RestoreCancelled),
            "{error:?}"
        );
        fixture.assert_live_unchanged();
        fixture.assert_nothing_left_behind();
    }

    #[tokio::test]
    async fn a_journal_write_or_sync_failure_leaves_no_journal_and_a_startable_store() {
        use std::error::Error as _;
        for fault in [RecoveryFault::JournalWrite, RecoveryFault::JournalSync] {
            let fixture = restore_fixture().await;
            let error = restore_backup_with_fault(
                &fixture.resolved,
                fixture.backup.manifest.backup_id,
                fault,
            )
            .await
            .expect_err("disk full while writing the journal");
            assert!(
                error.source().is_some_and(|source| source
                    .source()
                    .and_then(|io| io.downcast_ref::<std::io::Error>())
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::StorageFull)),
                "{fault:?}: {error:?}"
            );
            fixture.assert_live_unchanged();
            fixture.assert_nothing_left_behind();

            let error = preserve_and_start_empty_with_fault(&fixture.resolved, fault)
                .await
                .expect_err("disk full while writing the start-empty journal");
            assert!(matches!(error, RecoveryError::Backup(_)), "{error:?}");
            fixture.assert_live_unchanged();
            fixture.assert_nothing_left_behind();
            fs::remove_file(sqlite_sidecar_path(&fixture.paths.database, "-wal")).expect("wal");
            fs::remove_file(sqlite_sidecar_path(&fixture.paths.database, "-shm")).expect("shm");
            fixture
                .assert_startable_with(&[BACKED_UP_TITLE, LIVE_TITLE])
                .await;
        }
    }

    #[tokio::test]
    async fn restore_clears_an_abandoned_staging_entry_without_a_journal() {
        for case in ["staging", "staging-and-temporary-journal", "extra-file"] {
            let fixture = restore_fixture().await;
            let operation_id = Uuid::new_v4();
            let staging = fixture.paths.recovery_staging_dir(operation_id);
            fs::create_dir(&staging).expect("abandoned staging");
            fs::write(staging.join(BACKUP_FILE_NAME), b"partial copy").expect("staged db");
            fs::write(staging.join(MARKER_FILE_NAME), b"marker").expect("staged marker");
            if case == "staging-and-temporary-journal" {
                fs::write(
                    temporary_journal_path(&fixture.paths, operation_id),
                    b"{\"partial\":",
                )
                .expect("temporary journal");
            }
            if case == "extra-file" {
                fs::write(staging.join("foreign.txt"), b"foreign").expect("extra file");
            }

            let result = restore_backup_with_fault(
                &fixture.resolved,
                fixture.backup.manifest.backup_id,
                RecoveryFault::None,
            )
            .await;

            if case == "extra-file" {
                assert!(
                    matches!(result, Err(RecoveryError::RecoveryInProgress { .. })),
                    "{result:?}"
                );
                assert_eq!(
                    fs::read(staging.join("foreign.txt")).expect("kept"),
                    b"foreign"
                );
                assert_eq!(
                    fs::read(staging.join(BACKUP_FILE_NAME)).expect("kept"),
                    b"partial copy"
                );
                fixture.assert_live_unchanged();
            } else {
                result.expect("restore clears the abandoned operation");
                assert!(!staging.exists());
                assert!(!temporary_journal_path(&fixture.paths, operation_id).exists());
                fixture.assert_restored();
            }
        }
    }

    /// Every commit step a kill can interrupt, in order.
    const COMMIT_STEPS: [RecoveryFault; 10] = [
        RecoveryFault::JournalDirectorySync,
        RecoveryFault::AfterPreserveDatabase,
        RecoveryFault::AfterPreserveWal,
        RecoveryFault::AfterPreserveShm,
        RecoveryFault::AfterPreserveMarker,
        RecoveryFault::PreservedSync,
        RecoveryFault::AfterPreservedSync,
        RecoveryFault::AfterMoveDatabase,
        RecoveryFault::AfterMoveMarker,
        RecoveryFault::AfterRemoveStaging,
    ];

    #[tokio::test]
    async fn resume_finishes_a_restore_interrupted_at_every_commit_step() {
        for step in COMMIT_STEPS {
            let fixture = restore_fixture().await;
            restore_backup_with_fault(&fixture.resolved, fixture.backup.manifest.backup_id, step)
                .await
                .expect_err("interrupted commit");
            assert!(fixture.paths.recovery_journal().is_file(), "{step:?}");
            let listing = entries(&fixture.paths.state_dir);
            fixture.assert_startup_names_resume().await;
            assert_eq!(
                entries(&fixture.paths.state_dir),
                listing,
                "startup moved nothing"
            );

            if step == RecoveryFault::AfterPreserveDatabase {
                // An interrupted `--resume` is finished by the next one.
                resume_recovery_with_fault(&fixture.resolved, RecoveryFault::AfterPreserveWal)
                    .await
                    .expect_err("interrupted resume");
                assert!(fixture.paths.recovery_journal().is_file());
            }
            let resumed = resume_recovery(&fixture.resolved)
                .await
                .unwrap_or_else(|error| panic!("{step:?}: {error}"));
            assert_eq!(
                resumed.resumed.map(|result| result.action),
                Some(RecoveryAction::Restore)
            );
            fixture.assert_restored();
            fixture.assert_startable_with(&[BACKED_UP_TITLE]).await;
        }
    }

    #[tokio::test]
    async fn a_preserved_directory_sync_failure_keeps_the_journal_for_resume() {
        let fixture = restore_fixture().await;
        restore_backup_with_fault(
            &fixture.resolved,
            fixture.backup.manifest.backup_id,
            RecoveryFault::PreservedSync,
        )
        .await
        .expect_err("preserved directory sync fails");
        assert!(fixture.paths.recovery_journal().is_file());
        assert!(!fixture.paths.database.exists(), "no staged file moved yet");
        let staging = staging_entries(&fixture.paths);
        assert_eq!(staging.len(), 1);
        assert_eq!(
            entries(&fixture.paths.base_dir.join(&staging[0])),
            vec![MARKER_FILE_NAME.to_owned(), BACKUP_FILE_NAME.to_owned()]
        );
        resume_recovery(&fixture.resolved).await.expect("resume");
        fixture.assert_restored();

        let fixture = restore_fixture().await;
        preserve_and_start_empty_with_fault(&fixture.resolved, RecoveryFault::PreservedSync)
            .await
            .expect_err("preserved directory sync fails");
        assert!(fixture.paths.recovery_journal().is_file());
        fixture.assert_startup_names_resume().await;
        resume_recovery(&fixture.resolved).await.expect("resume");
        assert!(!fixture.paths.database.exists());
        assert!(!fixture.paths.recovery_journal().exists());
    }

    #[tokio::test]
    async fn a_failure_after_the_journal_rename_keeps_the_operation_for_resume() {
        let fixture = restore_fixture().await;
        restore_backup_with_fault(
            &fixture.resolved,
            fixture.backup.manifest.backup_id,
            RecoveryFault::JournalDirectorySync,
        )
        .await
        .expect_err("data-root sync fails after the rename");
        assert!(
            fixture.paths.recovery_journal().is_file(),
            "no stranded journal"
        );
        let staging = staging_entries(&fixture.paths);
        assert_eq!(staging.len(), 1, "staging kept: {staging:?}");
        assert_eq!(
            entries(&fixture.paths.base_dir.join(&staging[0])),
            vec![MARKER_FILE_NAME.to_owned(), BACKUP_FILE_NAME.to_owned()]
        );
        fixture.assert_live_unchanged();
        fixture.assert_startup_names_resume().await;
        resume_recovery(&fixture.resolved).await.expect("resume");
        fixture.assert_restored();
    }

    #[tokio::test]
    async fn resume_refuses_a_journal_it_cannot_finish() {
        // Nothing to resume.
        let fixture = restore_fixture().await;
        let resumed = resume_recovery(&fixture.resolved)
            .await
            .expect("nothing to do");
        assert_eq!(
            resumed,
            ResumeResult {
                resumed: None,
                cleared_abandoned_staging: false
            }
        );
        fixture.assert_live_unchanged();

        for case in [
            "version-1",
            "other-state-kind",
            "extra-staging-entry",
            "staged-identity",
        ] {
            let fixture = restore_fixture().await;
            restore_backup_with_fault(
                &fixture.resolved,
                fixture.backup.manifest.backup_id,
                RecoveryFault::AfterPreserveDatabase,
            )
            .await
            .expect_err("interrupted commit");
            let journal_path = fixture.paths.recovery_journal();
            let journal: RecoveryJournal =
                serde_json::from_slice(&fs::read(&journal_path).expect("journal")).expect("v2");
            let staging = fixture.paths.recovery_staging_dir(journal.operation_id);
            match case {
                "version-1" => fs::write(
                    &journal_path,
                    format!(
                        "{{\"operationId\":\"{}\",\"action\":\"restore\",\"stateKind\":\"userdata\",\"backupId\":null,\"phase\":\"preserving-live-store\"}}\n",
                        journal.operation_id
                    ),
                )
                .expect("version-1 journal"),
                "other-state-kind" => {
                    let mut other = journal.clone();
                    other.state_kind = StateKind::Dev;
                    fs::write(&journal_path, serde_json::to_vec(&other).expect("json"))
                        .expect("other-kind journal");
                }
                "extra-staging-entry" => {
                    fs::write(staging.join("foreign.txt"), b"foreign").expect("extra entry");
                }
                _ => {
                    let staged = staging.join(BACKUP_FILE_NAME);
                    let bytes = fs::read(&staged).expect("staged bytes");
                    fs::remove_file(&staged).expect("remove staged");
                    fs::write(&staged, bytes).expect("same bytes, new identity");
                }
            }
            let state_before = entries(&fixture.paths.state_dir);
            let staging_before = entries(&staging);
            let journal_before = fs::read(&journal_path).expect("journal bytes");

            let error = resume_recovery(&fixture.resolved)
                .await
                .expect_err("resume refuses");

            assert!(
                matches!(error, RecoveryError::ResumeRefused { .. }),
                "{case}: {error:?}"
            );
            assert_eq!(entries(&fixture.paths.state_dir), state_before, "{case}");
            assert_eq!(entries(&staging), staging_before, "{case}");
            assert_eq!(fs::read(&journal_path).expect("journal"), journal_before);
        }
    }

    #[tokio::test]
    async fn resume_finishes_an_interrupted_start_empty() {
        let fixture = restore_fixture().await;
        preserve_and_start_empty_with_fault(
            &fixture.resolved,
            RecoveryFault::AfterPreserveDatabase,
        )
        .await
        .expect_err("interrupted start-empty");
        fixture.assert_startup_names_resume().await;

        let resumed = resume_recovery(&fixture.resolved).await.expect("resume");

        assert_eq!(
            resumed.resumed.map(|result| result.action),
            Some(RecoveryAction::StartEmpty)
        );
        for name in [
            BACKUP_FILE_NAME,
            "state.sqlite-wal",
            "state.sqlite-shm",
            MARKER_FILE_NAME,
        ] {
            assert!(
                !fixture.paths.state_dir.join(name).exists(),
                "{name} preserved"
            );
        }
        assert!(!fixture.paths.recovery_journal().exists());
        let prepared = crate::persistence::prepare_store(&fixture.config)
            .await
            .expect("first run");
        assert_eq!(
            prepared.classification,
            crate::persistence::StoreClassification::FirstRun
        );
        prepared.database.close().await;
    }
}
