//! Offline `bibcode storage compact`: a verified pre-compact backup, then `VACUUM` into
//! `auto_vacuum = INCREMENTAL`, under the store's exclusive locks.
//!
//! Every refusal before the backup leaves `state.sqlite`, `-wal` and `-shm` byte for byte as
//! they were. See `docs/plans/2026-11-01-storage-compaction-design.md`.

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use serde::Serialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    BackupError, BackupTrigger, Database, PersistenceError, PreparedStore, RecoveryError,
    StatePaths, StorageInstanceId, StoreClassification, StoreInspectionStatus, StoreOperationGuard,
    backup::{
        BACKUP_TIMEOUT, DatabaseStatsUnavailable, OfflineRecoveryGuard, RECOVERY_TIMEOUT,
        classify_store_files, create_verified_backup, database_file_sizes, directory_volume,
        is_reparse_point, path_entry_exists, sqlite_sidecars_present, state_kind_name,
    },
    database::{AutoVacuumMode, PageStats, VacuumOutcome, open_immutable, page_stats},
    migrations::validate_bibcode_schema,
};
use crate::{
    ServerConfig,
    data_root::{DataRootRequest, ResolvedDataRoot, resolve_data_root},
    diagnostics::profiler,
};

/// Room kept free beyond SQLite's own needs on each volume.
const SPACE_HEADROOM_BYTES: u64 = 64 * 1024 * 1024;
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

/// A phase of a real compaction, for progress lines.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompactProgress {
    BackingUp { bytes: u64 },
    Compacting,
    CheckingIntegrity,
}

#[derive(Clone, Default)]
pub struct CompactOptions {
    pub dry_run: bool,
    /// Cancelled on Ctrl-C. Honored between steps, before and during `VACUUM`, and after the
    /// backup returns.
    pub cancellation: CancellationToken,
    pub on_progress: Option<Arc<dyn Fn(CompactProgress) + Send + Sync>>,
}

/// Test seams, following the crate's fault-enum convention.
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompactTestHook {
    None,
    /// Replaces the free-space probe and the same-volume check.
    FreeSpace {
        store: u64,
        temp: u64,
        same_volume: bool,
    },
    /// Cancels the token when the backup returns.
    CancelAfterBackup,
    /// The `VACUUM` progress handler cancels the token on its first call.
    CancelDuringVacuum,
    /// Removing the stale `-shm` after a verified compaction fails.
    FailCleanup,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactStats {
    pub file_bytes: u64,
    pub wal_bytes: u64,
    pub page_size: Option<u64>,
    pub page_count: Option<u64>,
    pub freelist_count: Option<u64>,
    pub auto_vacuum: Option<AutoVacuumMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database_stats_unavailable: Option<DatabaseStatsUnavailable>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredFreeBytes {
    pub store: u64,
    pub temp: u64,
    pub same_volume: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableFreeBytes {
    pub store: u64,
    pub temp: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactPlan {
    pub backup_bytes: u64,
    pub estimated_compacted_bytes: u64,
    pub estimated_reclaim_bytes: Option<u64>,
    pub auto_vacuum_after: AutoVacuumMode,
    pub required_free_bytes: RequiredFreeBytes,
    pub available_free_bytes: AvailableFreeBytes,
    pub backup_budget_seconds: u64,
    /// `locked` for a real run; `not-checked` for a dry run, which never opens a writable
    /// connection.
    pub sqlite_lock: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactReport {
    pub dry_run: bool,
    pub before: CompactStats,
    pub plan: CompactPlan,
    pub backup_id: Option<String>,
    pub after: Option<CompactStats>,
    pub reclaimed_bytes: Option<u64>,
    /// `complete`, or `deferred` when the explicit checkpoint was busy and the close finished
    /// it.
    pub checkpoint: Option<&'static str>,
}

pub async fn compact_store(
    root: &ResolvedDataRoot,
    options: CompactOptions,
) -> Result<CompactReport, RecoveryError> {
    compact_store_inner(root, options, CompactTestHook::None).await
}

#[doc(hidden)]
pub async fn compact_store_for_integration_test(
    root: &ResolvedDataRoot,
    options: CompactOptions,
    hook: CompactTestHook,
) -> Result<CompactReport, RecoveryError> {
    compact_store_inner(root, options, hook).await
}

async fn compact_store_inner(
    root: &ResolvedDataRoot,
    options: CompactOptions,
    hook: CompactTestHook,
) -> Result<CompactReport, RecoveryError> {
    let paths = resolve_paths(root)?;
    if options.dry_run {
        return dry_run(paths, hook).await;
    }
    if !path_entry_exists(&paths.base_dir)? {
        return Err(not_compactable(StoreInspectionStatus::FirstRun, None));
    }
    let _offline = OfflineRecoveryGuard::acquire(&paths)?;
    // Started only under the exclusive runtime lock, so never beside a live server's writer.
    let recorder = Recorder::start(&paths);
    let mut trace = Trace::default();
    let result = async {
        trace.step = "lock";
        let _operation = StoreOperationGuard::acquire(
            &paths.base_dir,
            options.cancellation.clone(),
            RECOVERY_TIMEOUT,
        )
        .await
        .map_err(|error| match error {
            BackupError::Cancelled => RecoveryError::Cancelled { backup_id: None },
            other => other.into(),
        })?;
        compact_locked(&paths, &options, hook, &mut trace).await
    }
    .await;
    recorder.finish(&trace, &result);
    result
}

fn resolve_paths(root: &ResolvedDataRoot) -> Result<StatePaths, RecoveryError> {
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
    config.resolved_data_root = Some(current);
    Ok(StatePaths::from_config(&config))
}

async fn compact_locked(
    paths: &StatePaths,
    options: &CompactOptions,
    hook: CompactTestHook,
    trace: &mut Trace,
) -> Result<CompactReport, RecoveryError> {
    trace.step = "classify";
    ensure_not_cancelled(&options.cancellation, None)?;
    let storage_instance_id = check_compactable_files(paths)?;
    let (file_bytes, wal_bytes, _) = database_file_sizes(&paths.database)?
        .ok_or_else(|| not_compactable(StoreInspectionStatus::DatabaseMissing, None))?;
    trace.before_file_bytes = Some(file_bytes);

    trace.step = "open";
    let database = Database::open_for_maintenance(&paths.database)
        .await
        .map_err(|error| {
            if error.is_busy() {
                RecoveryError::DatabaseLocked
            } else {
                failed_before_backup("open", "Could not open the database for compaction", &error)
            }
        })?;
    let locked = compact_with_connection(
        &database,
        paths,
        storage_instance_id,
        (file_bytes, wal_bytes),
        options,
        hook,
        trace,
    )
    .await;
    let verified = locked.is_ok();
    if verified && let Err(error) = database.allow_checkpoint_on_close().await {
        tracing::warn!(detail = %error_chain(&error), "compaction could not re-enable the close checkpoint");
    }
    // Closing without the flag checkpoints and deletes the WAL; with it, a crash-left WAL stays
    // for the next open to replay.
    database.close().await;
    let mut report = locked?;

    trace.step = "cleanup";
    // Every error from here on names the published backup.
    let backup_id = report
        .backup_id
        .as_deref()
        .and_then(|id| Uuid::parse_str(id).ok());
    let backup_label = report.backup_id.clone().unwrap_or_default();
    let cleanup_failed = |detail: String| RecoveryError::CompactFailed {
        phase: "cleanup",
        backup_id,
        message: format!(
            "The database was compacted, but its cleanup failed: {detail}. The pre-compact \
             backup {backup_label} is kept. Run `bibcode storage compact` again to finish."
        ),
    };
    // In exclusive locking mode SQLite never opens `-shm`, so its close leaves a crash-left one
    // beside no WAL. Nothing else can have it open while the runtime lock is held.
    let (wal, shm) = sqlite_sidecars_present(&paths.database)
        .map_err(|error| cleanup_failed(error_chain(&error)))?;
    if !wal && shm {
        let removed = if hook == CompactTestHook::FailCleanup {
            Err(std::io::Error::other("injected cleanup failure"))
        } else {
            std::fs::remove_file(sidecar(&paths.database, "-shm"))
        };
        removed.map_err(|source| {
            cleanup_failed(format!("state.sqlite-shm could not be removed: {source}"))
        })?;
    }
    let (after_file, after_wal, _) = database_file_sizes(&paths.database)
        .map_err(|error| cleanup_failed(error_chain(&error)))?
        .unwrap_or_default();
    if let Some(after) = &mut report.after {
        after.file_bytes = after_file;
        after.wal_bytes = after_wal;
    }
    report.reclaimed_bytes = Some((file_bytes + wal_bytes).saturating_sub(after_file + after_wal));
    trace.after_file_bytes = Some(after_file);
    Ok(report)
}

async fn compact_with_connection(
    database: &Database,
    paths: &StatePaths,
    storage_instance_id: StorageInstanceId,
    (file_bytes, wal_bytes): (u64, u64),
    options: &CompactOptions,
    hook: CompactTestHook,
    trace: &mut Trace,
) -> Result<CompactReport, RecoveryError> {
    let token = &options.cancellation;
    let progress = |phase| {
        if let Some(on_progress) = &options.on_progress {
            on_progress(phase);
        }
    };
    trace.step = "schema";
    ensure_not_cancelled(token, None)?;
    let path = paths.database.clone();
    let schema_token = token.clone();
    let deadline = Instant::now() + RECOVERY_TIMEOUT;
    let schema = database
        .call(move |connection| {
            Ok(
                validate_bibcode_schema(connection, &path, &schema_token, deadline)
                    .map_err(|error| error.to_string()),
            )
        })
        .await
        .map_err(|error| failed_before_backup("schema", "Could not read the schema", &error))?;
    ensure_not_cancelled(token, None)?;
    schema.map_err(|detail| RecoveryError::NotCompactable { detail })?;

    trace.step = "measure";
    let before = database.page_stats().await.map_err(|error| {
        failed_before_backup("measure", "Could not measure the database", &error)
    })?;
    trace.page_size = Some(before.page_size);
    trace.before = Some(before);

    trace.step = "space";
    ensure_not_cancelled(token, None)?;
    let logical_bytes = before.page_count.saturating_mul(before.page_size);
    let live_bytes = before
        .page_count
        .saturating_sub(before.freelist_count)
        .saturating_mul(before.page_size);
    let space = check_free_space(paths, logical_bytes, live_bytes, file_bytes, hook)?;

    trace.step = "backup";
    progress(CompactProgress::BackingUp {
        bytes: logical_bytes,
    });
    let started = Instant::now();
    let prepared = PreparedStore {
        database: database.clone(),
        storage_instance_id,
        classification: StoreClassification::Existing,
        paths: paths.clone(),
    };
    let backup = create_verified_backup(
        database,
        &prepared,
        BackupTrigger::PreCompact,
        env!("CARGO_PKG_VERSION"),
    )
    .await;
    drop(prepared);
    trace.backup_ms = Some(elapsed_ms(started));
    let backup_id = backup.map_err(map_backup_error)?.manifest.backup_id;
    tracing::info!(%backup_id, "published the pre-compact backup");
    if hook == CompactTestHook::CancelAfterBackup {
        token.cancel();
    }

    trace.step = "vacuum";
    ensure_not_cancelled(token, Some(backup_id))?;
    progress(CompactProgress::Compacting);
    let started = Instant::now();
    let cancel_in_handler = (hook == CompactTestHook::CancelDuringVacuum).then(|| token.clone());
    let outcome = database
        .vacuum_incremental(token.clone(), move || {
            if let Some(token) = &cancel_in_handler {
                token.cancel();
            }
        })
        .await
        .map_err(|error| RecoveryError::CompactFailed {
            phase: "vacuum",
            backup_id: Some(backup_id),
            message: format!(
                "Compaction failed: {}. The database was not changed. The pre-compact backup \
                 {backup_id} is kept.",
                error_chain(&error)
            ),
        })?;
    trace.vacuum_ms = Some(elapsed_ms(started));
    if outcome == VacuumOutcome::Cancelled {
        return Err(RecoveryError::Cancelled {
            backup_id: Some(backup_id),
        });
    }

    // Committed from here: the remaining steps only finish it and are not cancellable.
    trace.step = "checkpoint";
    let checkpoint = match database.checkpoint_truncate().await {
        Ok(true) => "complete",
        Ok(false) => "deferred",
        Err(error) => {
            tracing::warn!(detail = %error_chain(&error), "compaction checkpoint failed; the close finishes it");
            "deferred"
        }
    };

    trace.step = "verify";
    progress(CompactProgress::CheckingIntegrity);
    let verify_failed = |detail: String| RecoveryError::CompactFailed {
        phase: "verify",
        backup_id: Some(backup_id),
        message: format!(
            "The database was compacted, but its verification failed: {detail}. Restore the \
             pre-compact backup with `bibcode storage restore --backup-id {backup_id}`."
        ),
    };
    database
        .quick_check()
        .await
        .map_err(|error| verify_failed(error_chain(&error)))?;
    let after = database
        .page_stats()
        .await
        .map_err(|error| verify_failed(error_chain(&error)))?;
    trace.after = Some(after);
    if after.freelist_count != 0 || after.auto_vacuum != AutoVacuumMode::Incremental {
        return Err(verify_failed(format!(
            "{} free pages and auto_vacuum {:?} remain",
            after.freelist_count, after.auto_vacuum
        )));
    }

    Ok(CompactReport {
        dry_run: false,
        before: stats_report(file_bytes, wal_bytes, Ok(before)),
        plan: plan(logical_bytes, live_bytes, Some(before), space, "locked"),
        backup_id: Some(backup_id.to_string()),
        after: Some(stats_report(0, 0, Ok(after))),
        reclaimed_bytes: None,
        checkpoint: Some(checkpoint),
    })
}

async fn dry_run(paths: StatePaths, hook: CompactTestHook) -> Result<CompactReport, RecoveryError> {
    tokio::task::spawn_blocking(move || {
        // Non-creating, and no storage-operation lock: the dry run writes nothing.
        let _guard = if path_entry_exists(&paths.base_dir)? {
            OfflineRecoveryGuard::try_acquire_existing(&paths)?
        } else {
            None
        };
        check_compactable_files(&paths)?;
        let (file_bytes, wal_bytes, _) = database_file_sizes(&paths.database)?
            .ok_or_else(|| not_compactable(StoreInspectionStatus::DatabaseMissing, None))?;
        let (wal, shm) = sqlite_sidecars_present(&paths.database)?;
        let stats = if wal || shm {
            // Opening SQLite would create or remove sidecars; size from the files instead.
            None
        } else {
            let connection =
                open_immutable(&paths.database).map_err(|error| RecoveryError::NotCompactable {
                    detail: format!("state.sqlite could not be read: {error}"),
                })?;
            let deadline = Instant::now() + RECOVERY_TIMEOUT;
            validate_bibcode_schema(
                &connection,
                &paths.database,
                &CancellationToken::new(),
                deadline,
            )
            .map_err(|error| RecoveryError::NotCompactable {
                detail: error.to_string(),
            })?;
            Some(
                page_stats(&connection).map_err(|error| RecoveryError::NotCompactable {
                    detail: format!("state.sqlite could not be measured: {error}"),
                })?,
            )
        };
        let (logical_bytes, live_bytes) = match stats {
            Some(stats) => (
                stats.page_count.saturating_mul(stats.page_size),
                stats
                    .page_count
                    .saturating_sub(stats.freelist_count)
                    .saturating_mul(stats.page_size),
            ),
            // An upper bound: every byte of the database and its WAL.
            None => (file_bytes + wal_bytes, file_bytes + wal_bytes),
        };
        let space = check_free_space(&paths, logical_bytes, live_bytes, file_bytes, hook)?;
        Ok(CompactReport {
            dry_run: true,
            before: stats_report(
                file_bytes,
                wal_bytes,
                stats.ok_or(DatabaseStatsUnavailable::UncheckpointedWal),
            ),
            plan: plan(logical_bytes, live_bytes, stats, space, "not-checked"),
            backup_id: None,
            after: None,
            reclaimed_bytes: None,
            checkpoint: None,
        })
    })
    .await
    .map_err(RecoveryError::Worker)?
}

/// File-level checks, before any SQLite open: the store state, the database header, and no
/// rollback journal. Returns the storage identity backups are keyed by.
fn check_compactable_files(paths: &StatePaths) -> Result<StorageInstanceId, RecoveryError> {
    let files = classify_store_files(paths)?;
    let storage_instance_id = match (files.classification, files.storage_instance_id) {
        (StoreInspectionStatus::Existing, Some(storage_instance_id)) => storage_instance_id,
        (classification, _) => return Err(not_compactable(classification, files.issue)),
    };
    // SQLite resolves links and keeps its sidecars beside the target, where none of the checks
    // below would look.
    for (path, name) in [
        (&paths.state_dir, "The state directory"),
        (&paths.database, "state.sqlite"),
    ] {
        let metadata = std::fs::symlink_metadata(path).map_err(|source| BackupError::Io {
            path: path.clone(),
            source,
        })?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(RecoveryError::NotCompactable {
                detail: format!(
                    "{name} is a symbolic link or junction, so it cannot be compacted safely: \
                     SQLite keeps its recovery files beside the link target. Point BiBCode at \
                     the real location, then retry."
                ),
            });
        }
    }
    // A zero-length file would be initialized by the first write transaction.
    check_database_header(&paths.database)?;
    // The first access would roll a hot journal back into the file.
    if path_entry_exists(&sidecar(&paths.database, "-journal"))? {
        return Err(RecoveryError::NotCompactable {
            detail: "state.sqlite-journal exists: another program left an interrupted write \
                     or is writing to the database now. Close every program that has the \
                     database open, then retry."
                .to_owned(),
        });
    }
    Ok(storage_instance_id)
}

fn check_database_header(database: &Path) -> Result<(), RecoveryError> {
    let not_sqlite = || RecoveryError::NotCompactable {
        detail: "state.sqlite is empty or is not a SQLite database, so it cannot be compacted. \
                 Run `bibcode storage inspect` to see the store's state."
            .to_owned(),
    };
    let io_error = |source| BackupError::Io {
        path: database.to_path_buf(),
        source,
    };
    let mut file = File::open(database).map_err(io_error)?;
    let length = file.metadata().map_err(io_error)?.len();
    if length < 100 {
        return Err(not_sqlite());
    }
    let mut header = [0_u8; 100];
    file.read_exact(&mut header).map_err(io_error)?;
    if &header[..16] != SQLITE_HEADER {
        return Err(not_sqlite());
    }
    let page_size = match u16::from_be_bytes([header[16], header[17]]) {
        1 => 65_536,
        raw => u64::from(raw),
    };
    if !(512..=65_536).contains(&page_size) || !page_size.is_power_of_two() || length < page_size {
        return Err(not_sqlite());
    }
    Ok(())
}

fn not_compactable(classification: StoreInspectionStatus, issue: Option<String>) -> RecoveryError {
    let detail = match classification {
        StoreInspectionStatus::FirstRun => {
            "There is no project-data store at this data root yet, so there is nothing to compact."
                .to_owned()
        }
        StoreInspectionStatus::ExistingUnmarked => {
            "This store has no storage marker yet. Start BiBCode once so it can adopt this store, \
             then retry."
                .to_owned()
        }
        _ => issue.unwrap_or_else(|| {
            "The project-data store is not in a state that can be compacted. Run `bibcode \
             storage inspect` to see why."
                .to_owned()
        }),
    };
    RecoveryError::NotCompactable { detail }
}

fn failed_before_backup(
    phase: &'static str,
    what: &str,
    error: &PersistenceError,
) -> RecoveryError {
    RecoveryError::CompactFailed {
        phase,
        backup_id: None,
        message: format!(
            "{what}: {}. The database was not changed.",
            error_chain(error)
        ),
    }
}

fn map_backup_error(error: BackupError) -> RecoveryError {
    let message = match &error {
        BackupError::QuickCheck { .. } => {
            "The store failed its integrity check, so it was not compacted and the database was \
             not changed. Run `bibcode storage inspect` to see its state."
                .to_owned()
        }
        BackupError::DeadlineElapsed => backup_budget_message(),
        BackupError::Persistence(PersistenceError::BackupStopped(reason))
            if reason == "deadline elapsed" =>
        {
            backup_budget_message()
        }
        other => format!(
            "Could not take the pre-compact backup: {}; the database was not changed.",
            error_chain(other)
        ),
    };
    RecoveryError::CompactFailed {
        phase: "backup",
        backup_id: None,
        message,
    }
}

fn backup_budget_message() -> String {
    format!(
        "The pre-compact backup did not finish within {} seconds, so the database was not \
         changed. Compacting stores this large is not supported yet.",
        BACKUP_TIMEOUT.as_secs()
    )
}

fn ensure_not_cancelled(
    token: &CancellationToken,
    backup_id: Option<Uuid>,
) -> Result<(), RecoveryError> {
    if token.is_cancelled() {
        Err(RecoveryError::Cancelled { backup_id })
    } else {
        Ok(())
    }
}

/// Peak extra space: the backup, the new WAL frames and any growth of the main file the final
/// checkpoint adds, on the store volume; the compacted copy on SQLite's temp volume; their sum
/// when both are one volume. `logical_bytes` is `pageCount × pageSize`, which includes pages a
/// crash-left WAL holds beyond the physical end of `state.sqlite`.
pub(crate) fn required_free_bytes(
    logical_bytes: u64,
    live_bytes: u64,
    file_bytes: u64,
    same_volume: bool,
) -> (RequiredFreeBytes, u64) {
    // shortcut: +1 % for pointer-map pages is an estimate; refine once #225 measures stores.
    let compacted = live_bytes.saturating_add(live_bytes.div_ceil(100));
    let main_growth = compacted.saturating_sub(file_bytes);
    let temp = compacted.saturating_add(SPACE_HEADROOM_BYTES);
    let mut store = logical_bytes
        .saturating_add(compacted)
        .saturating_add(main_growth)
        .saturating_add(SPACE_HEADROOM_BYTES);
    if same_volume {
        store = store.saturating_add(temp);
    }
    (
        RequiredFreeBytes {
            store,
            temp,
            same_volume,
        },
        compacted,
    )
}

struct SpaceCheck {
    required: RequiredFreeBytes,
    available: AvailableFreeBytes,
    compacted: u64,
}

fn check_free_space(
    paths: &StatePaths,
    logical_bytes: u64,
    live_bytes: u64,
    file_bytes: u64,
    hook: CompactTestHook,
) -> Result<SpaceCheck, RecoveryError> {
    let (available, same_volume) = match hook {
        CompactTestHook::FreeSpace {
            store,
            temp,
            same_volume,
        } => (AvailableFreeBytes { store, temp }, same_volume),
        _ => {
            let temp_dir = sqlite_temp_dir();
            let same_volume = directory_volume(&paths.state_dir)? == directory_volume(&temp_dir)?;
            let free = |path: &Path| {
                free_space(path).map_err(|source| BackupError::Io {
                    path: path.to_path_buf(),
                    source,
                })
            };
            (
                AvailableFreeBytes {
                    store: free(&paths.state_dir)?,
                    temp: free(&temp_dir)?,
                },
                same_volume,
            )
        }
    };
    let (required, compacted) =
        required_free_bytes(logical_bytes, live_bytes, file_bytes, same_volume);
    let temp_required = (!same_volume).then_some(required.temp);
    if available.store < required.store {
        return Err(RecoveryError::InsufficientSpace {
            volume: "store",
            required: required.store,
            available: available.store,
            store_required: required.store,
            temp_required,
        });
    }
    if !same_volume && available.temp < required.temp {
        return Err(RecoveryError::InsufficientSpace {
            volume: "temp",
            required: required.temp,
            available: available.temp,
            store_required: required.store,
            temp_required,
        });
    }
    Ok(SpaceCheck {
        required,
        available,
        compacted,
    })
}

/// Where SQLite writes `VACUUM`'s temporary database, in SQLite's own order.
fn sqlite_temp_dir() -> PathBuf {
    #[cfg(unix)]
    {
        let from_environment = ["SQLITE_TMPDIR", "TMPDIR"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from);
        first_usable_temp_dir(
            from_environment.chain(["/var/tmp", "/usr/tmp", "/tmp", "."].map(PathBuf::from)),
        )
    }
    #[cfg(not(unix))]
    {
        std::env::temp_dir()
    }
}

/// The first candidate that is a directory the process may write and search, as SQLite's
/// `unixTempFileDir` requires.
#[cfg(unix)]
fn first_usable_temp_dir(candidates: impl IntoIterator<Item = PathBuf>) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;

    candidates
        .into_iter()
        .find(|directory| {
            directory.is_dir()
                && std::ffi::CString::new(directory.as_os_str().as_bytes()).is_ok_and(|path| {
                    // SAFETY: `path` is NUL-terminated and outlives the call.
                    unsafe { libc::access(path.as_ptr(), libc::W_OK | libc::X_OK) == 0 }
                })
        })
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(windows)]
fn free_space(path: &Path) -> std::io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0_u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the other outputs may be null.
    let succeeded = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &raw mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(available)
}

#[cfg(unix)]
fn free_space(path: &Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // SAFETY: an all-zero `statvfs` is a valid output buffer for the call below.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is NUL-terminated and `stat` is a valid, writable buffer.
    if unsafe { libc::statvfs(path.as_ptr(), &raw mut stat) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    #[allow(clippy::useless_conversion)]
    Ok(u64::from(stat.f_bavail).saturating_mul(u64::from(stat.f_frsize)))
}

#[cfg(not(any(unix, windows)))]
fn free_space(_path: &Path) -> std::io::Result<u64> {
    Ok(u64::MAX)
}

fn plan(
    logical_bytes: u64,
    live_bytes: u64,
    stats: Option<PageStats>,
    space: SpaceCheck,
    sqlite_lock: &'static str,
) -> CompactPlan {
    debug_assert!(live_bytes <= logical_bytes);
    CompactPlan {
        backup_bytes: logical_bytes,
        estimated_compacted_bytes: space.compacted,
        estimated_reclaim_bytes: stats
            .map(|stats| stats.freelist_count.saturating_mul(stats.page_size)),
        auto_vacuum_after: AutoVacuumMode::Incremental,
        required_free_bytes: space.required,
        available_free_bytes: space.available,
        backup_budget_seconds: BACKUP_TIMEOUT.as_secs(),
        sqlite_lock,
    }
}

fn stats_report(
    file_bytes: u64,
    wal_bytes: u64,
    stats: Result<PageStats, DatabaseStatsUnavailable>,
) -> CompactStats {
    match stats {
        Ok(stats) => CompactStats {
            file_bytes,
            wal_bytes,
            page_size: Some(stats.page_size),
            page_count: Some(stats.page_count),
            freelist_count: Some(stats.freelist_count),
            auto_vacuum: Some(stats.auto_vacuum),
            database_stats_unavailable: None,
        },
        Err(reason) => CompactStats {
            file_bytes,
            wal_bytes,
            page_size: None,
            page_count: None,
            freelist_count: None,
            auto_vacuum: None,
            database_stats_unavailable: Some(reason),
        },
    }
}

fn sidecar(database: &Path, suffix: &str) -> PathBuf {
    let mut path = database.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// What the profiler's end event reports. It holds no paths, IDs or error text.
struct Trace {
    step: &'static str,
    page_size: Option<u64>,
    before_file_bytes: Option<u64>,
    after_file_bytes: Option<u64>,
    before: Option<PageStats>,
    after: Option<PageStats>,
    backup_ms: Option<u64>,
    vacuum_ms: Option<u64>,
}

impl Default for Trace {
    fn default() -> Self {
        Self {
            step: "lock",
            page_size: None,
            before_file_bytes: None,
            after_file_bytes: None,
            before: None,
            after: None,
            backup_ms: None,
            vacuum_ms: None,
        }
    }
}

/// `storage.compact` start and end events, written through the offline profiler writer when
/// the store's persisted `enableProfiler` is on, plus the matching trace records.
struct Recorder {
    writer: Option<profiler::OfflineWriter>,
    state_kind: &'static str,
    started: Instant,
}

impl Recorder {
    fn start(paths: &StatePaths) -> Self {
        let recorder = Self {
            writer: profiler::offline_writer(&paths.state_dir),
            state_kind: state_kind_name(paths.state_kind),
            started: Instant::now(),
        };
        tracing::info!(
            state_kind = recorder.state_kind,
            "storage compaction started"
        );
        if let Some(writer) = &recorder.writer {
            writer.emit(
                "storage.compact",
                json!({ "phase": "start", "stateKind": recorder.state_kind }),
            );
        }
        recorder
    }

    fn finish(self, trace: &Trace, result: &Result<CompactReport, RecoveryError>) {
        let (outcome, failed_step) = match result {
            Ok(_) => ("compacted", None),
            Err(
                RecoveryError::NotCompactable { .. }
                | RecoveryError::DatabaseLocked
                | RecoveryError::InsufficientSpace { .. },
            ) => ("refused", Some(trace.step)),
            Err(RecoveryError::Cancelled { .. }) => ("cancelled", Some(trace.step)),
            Err(_) => ("failed", Some(trace.step)),
        };
        let duration_ms = elapsed_ms(self.started);
        match result {
            Ok(_) => tracing::info!(duration_ms, "storage compaction finished"),
            Err(error) => tracing::warn!(
                outcome,
                step = trace.step,
                detail = %error,
                "storage compaction did not finish"
            ),
        }
        let Some(writer) = &self.writer else {
            return;
        };
        let side = |file_bytes: Option<u64>, stats: Option<PageStats>| -> Value {
            if file_bytes.is_none() && stats.is_none() {
                return Value::Null;
            }
            json!({
                "fileBytes": file_bytes,
                "freelistCount": stats.map(|stats| stats.freelist_count),
                "autoVacuum": stats.map(|stats| stats.auto_vacuum),
            })
        };
        writer.emit(
            "storage.compact",
            json!({
                "phase": "end",
                "outcome": outcome,
                "failedStep": failed_step,
                "stateKind": self.state_kind,
                "pageSize": trace.page_size,
                "before": side(trace.before_file_bytes, trace.before),
                "after": side(trace.after_file_bytes, trace.after),
                "backupMs": trace.backup_ms,
                "vacuumMs": trace.vacuum_ms,
                "durationMs": duration_ms,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn same_volume_needs_the_sum_of_store_and_temp_space() {
        let (required, compacted) = required_free_bytes(100 * MIB, 40 * MIB, 100 * MIB, true);
        let expected_compacted = 40 * MIB + (40 * MIB).div_ceil(100);
        assert_eq!(compacted, expected_compacted);
        let temp = expected_compacted + SPACE_HEADROOM_BYTES;
        assert_eq!(required.temp, temp);
        // No growth: the compacted file is smaller than the main file.
        assert_eq!(
            required.store,
            100 * MIB + expected_compacted + SPACE_HEADROOM_BYTES + temp
        );
        assert!(required.same_volume);
    }

    #[test]
    fn split_volumes_need_each_part_on_its_own_volume() {
        let (required, compacted) = required_free_bytes(100 * MIB, 40 * MIB, 100 * MIB, false);
        assert_eq!(required.temp, compacted + SPACE_HEADROOM_BYTES);
        assert_eq!(required.store, 100 * MIB + compacted + SPACE_HEADROOM_BYTES);
        assert!(!required.same_volume);
    }

    #[test]
    fn wal_pages_beyond_the_main_file_count_as_growth_on_the_store_volume_only() {
        // A crash-left WAL holds pages beyond the 10 MiB main file: 60 MiB logical, 50 live.
        let (required, compacted) = required_free_bytes(60 * MIB, 50 * MIB, 10 * MIB, false);
        let growth = compacted - 10 * MIB;
        assert!(growth > 0);
        assert_eq!(
            required.store,
            60 * MIB + compacted + growth + SPACE_HEADROOM_BYTES
        );
        assert_eq!(required.temp, compacted + SPACE_HEADROOM_BYTES);

        let (same, _) = required_free_bytes(60 * MIB, 50 * MIB, 10 * MIB, true);
        assert_eq!(same.store, required.store + required.temp);
        assert_eq!(same.temp, required.temp);
    }

    #[cfg(unix)]
    #[test]
    fn temp_dir_selection_skips_a_directory_sqlite_cannot_write() {
        use std::os::unix::fs::PermissionsExt;

        // SAFETY: `geteuid` has no preconditions.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipped: root may write to any directory");
            return;
        }
        let root = tempfile::TempDir::new().expect("temp-dir fixture root");
        let unwritable = root.path().join("unwritable");
        let writable = root.path().join("writable");
        std::fs::create_dir(&unwritable).expect("unwritable directory");
        std::fs::create_dir(&writable).expect("writable directory");
        std::fs::set_permissions(&unwritable, std::fs::Permissions::from_mode(0o500))
            .expect("make the directory read-only");

        let chosen = first_usable_temp_dir([
            root.path().join("missing"),
            unwritable.clone(),
            writable.clone(),
        ]);

        std::fs::set_permissions(&unwritable, std::fs::Permissions::from_mode(0o700))
            .expect("restore permissions");
        assert_eq!(chosen, writable);
    }

    #[test]
    fn database_header_check_rejects_empty_and_foreign_files() {
        let root = tempfile::TempDir::new().expect("header fixture root");
        let path = root.path().join("state.sqlite");
        std::fs::write(&path, b"").expect("empty file");
        assert!(matches!(
            check_database_header(&path),
            Err(RecoveryError::NotCompactable { .. })
        ));
        std::fs::write(&path, vec![7_u8; 4096]).expect("foreign file");
        assert!(matches!(
            check_database_header(&path),
            Err(RecoveryError::NotCompactable { .. })
        ));
        std::fs::remove_file(&path).expect("remove foreign file");
        let connection = rusqlite::Connection::open(&path).expect("sqlite file");
        connection
            .execute_batch("CREATE TABLE t(x)")
            .expect("sqlite table");
        drop(connection);
        check_database_header(&path).expect("a SQLite database passes");
    }
}
