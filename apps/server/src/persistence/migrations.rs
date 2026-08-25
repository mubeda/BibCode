use std::{
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use rusqlite::{
    Connection, ErrorCode, OpenFlags, OptionalExtension, Result, Transaction,
    backup::{Backup, StepResult},
    params_from_iter,
    types::Value,
};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

const VALIDATION_BACKUP_PAGES_PER_STEP: i32 = 128;
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(5);
const VALIDATION_BACKUP_RETRY_DELAY: Duration = Duration::from_millis(2);
const VALIDATION_INSPECTION_PROGRESS_OPS: i32 = 1_000;

const MIGRATIONS_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS effect_sql_migrations (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)
"#;

const CORE_TABLES: &[(u32, &str)] = &[
    (1, "orchestration_events"),
    (2, "orchestration_command_receipts"),
    (3, "checkpoint_diff_blobs"),
    (4, "provider_session_runtime"),
    (5, "projection_projects"),
    (5, "projection_threads"),
    (5, "projection_thread_messages"),
    (5, "projection_thread_activities"),
    (5, "projection_thread_sessions"),
    (5, "projection_turns"),
    (5, "projection_pending_approvals"),
    (5, "projection_state"),
    (13, "projection_thread_proposed_plans"),
    (20, "auth_pairing_links"),
    (20, "auth_sessions"),
    (48, "auth_pairing_exchange_receipts"),
    (34, "activity_scopes"),
    (34, "activity_records"),
    (34, "activity_entries"),
    (34, "activity_journal"),
    (36, "activity_event_idempotency"),
    (37, "activity_entry_owners"),
    (38, "activity_record_retention_counts"),
    (39, "provider_turn_outbox"),
    (39, "orchestration_attachment_refs"),
    (43, "worktree_removal_receipts"),
    (46, "project_repository_claims"),
];

#[derive(Debug, Error)]
pub(crate) enum ExistingStoreValidationError {
    #[error("SQLite integrity validation failed for {path}: {detail}")]
    Corrupt { path: PathBuf, detail: String },
    #[error("SQLite store at {path} is not a recognized BiBCode store: {detail}")]
    Unrecognized { path: PathBuf, detail: String },
    #[error("SQLite store at {path} cannot be inspected without side effects: {detail}")]
    Unsafe { path: PathBuf, detail: String },
}

pub(crate) fn validate_existing_bibcode_store(
    path: &Path,
    cancellation: &CancellationToken,
) -> std::result::Result<(), ExistingStoreValidationError> {
    validate_existing_bibcode_store_inner(
        path,
        cancellation,
        VALIDATION_TIMEOUT,
        || Ok(()),
        |_, _| Ok(()),
        VALIDATION_INSPECTION_PROGRESS_OPS,
        || {},
    )
}

pub(crate) fn validate_existing_bibcode_store_immutable(
    path: &Path,
    cancellation: &CancellationToken,
) -> std::result::Result<(), ExistingStoreValidationError> {
    let deadline = Instant::now()
        .checked_add(VALIDATION_TIMEOUT)
        .ok_or_else(|| ExistingStoreValidationError::Unsafe {
            path: path.to_path_buf(),
            detail: "SQLite store validation deadline exceeds the monotonic clock range".to_owned(),
        })?;
    ensure_validation_active(path, cancellation, deadline)?;
    let mut uri =
        url::Url::from_file_path(path).map_err(|()| ExistingStoreValidationError::Unsafe {
            path: path.to_path_buf(),
            detail: "SQLite store path cannot be represented as an immutable file URI".to_owned(),
        })?;
    uri.query_pairs_mut().append_pair("immutable", "1");
    let connection = Connection::open_with_flags(
        uri.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|source| ExistingStoreValidationError::Unsafe {
        path: path.to_path_buf(),
        detail: format!("failed to open immutable SQLite store: {source}"),
    })?;
    let inspection_cancellation = cancellation.clone();
    connection
        .progress_handler(
            VALIDATION_INSPECTION_PROGRESS_OPS,
            Some(move || validation_stop_reason(&inspection_cancellation, deadline).is_some()),
        )
        .map_err(|source| ExistingStoreValidationError::Unsafe {
            path: path.to_path_buf(),
            detail: format!("failed to install SQLite validation progress handler: {source}"),
        })?;
    let integrity = connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|source| map_corrupt_inspection_error(path, cancellation, deadline, source))?;
    ensure_validation_active(path, cancellation, deadline)?;
    if integrity != "ok" {
        return Err(ExistingStoreValidationError::Corrupt {
            path: path.to_path_buf(),
            detail: integrity,
        });
    }
    if !table_exists(&connection, "effect_sql_migrations")
        .map_err(|source| map_unrecognized_inspection_error(path, cancellation, deadline, source))?
    {
        return Err(ExistingStoreValidationError::Unrecognized {
            path: path.to_path_buf(),
            detail: "migration ledger is missing".to_owned(),
        });
    }
    let mut statement = connection
        .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC")
        .map_err(|source| {
            map_unrecognized_inspection_error(path, cancellation, deadline, source)
        })?;
    let recorded = statement
        .query_map([], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(|source| {
            map_unrecognized_inspection_error(path, cancellation, deadline, source)
        })?;
    ensure_validation_active(path, cancellation, deadline)?;
    if recorded.is_empty()
        || recorded.len() > MIGRATIONS.len()
        || recorded
            .iter()
            .zip(MIGRATIONS)
            .any(|((id, name), expected)| *id != expected.id || name != expected.name)
    {
        return Err(ExistingStoreValidationError::Unrecognized {
            path: path.to_path_buf(),
            detail: "migration ledger is not an exact prefix of this binary".to_owned(),
        });
    }
    let latest_migration_id = recorded.last().expect("non-empty ledger").0;
    for (_, table) in CORE_TABLES
        .iter()
        .filter(|(migration_id, _)| *migration_id <= latest_migration_id)
    {
        ensure_validation_active(path, cancellation, deadline)?;
        if !table_exists(&connection, table).map_err(|source| {
            map_unrecognized_inspection_error(path, cancellation, deadline, source)
        })? {
            return Err(ExistingStoreValidationError::Unrecognized {
                path: path.to_path_buf(),
                detail: format!("required table {table} is missing"),
            });
        }
    }
    ensure_validation_active(path, cancellation, deadline)
}

#[cfg(test)]
fn validate_existing_bibcode_store_with_barrier<F>(
    path: &Path,
    cancellation: &CancellationToken,
    barrier: F,
) -> std::result::Result<(), ExistingStoreValidationError>
where
    F: FnOnce() -> std::result::Result<(), ExistingStoreValidationError>,
{
    validate_existing_bibcode_store_inner(
        path,
        cancellation,
        VALIDATION_TIMEOUT,
        barrier,
        |_, _| Ok(()),
        VALIDATION_INSPECTION_PROGRESS_OPS,
        || {},
    )
}

#[cfg(test)]
pub(super) fn validate_existing_bibcode_store_with_control<F, G>(
    path: &Path,
    cancellation: &CancellationToken,
    timeout: Duration,
    barrier: F,
    after_step: G,
) -> std::result::Result<(), ExistingStoreValidationError>
where
    F: FnOnce() -> std::result::Result<(), ExistingStoreValidationError>,
    G: FnMut(
        StepResult,
        rusqlite::backup::Progress,
    ) -> std::result::Result<(), ExistingStoreValidationError>,
{
    validate_existing_bibcode_store_inner(
        path,
        cancellation,
        timeout,
        barrier,
        after_step,
        VALIDATION_INSPECTION_PROGRESS_OPS,
        || {},
    )
}

#[cfg(test)]
pub(super) fn validate_existing_bibcode_store_with_inspection_control<F, G, H>(
    path: &Path,
    cancellation: &CancellationToken,
    timeout: Duration,
    barrier: F,
    after_step: G,
    inspection_progress: H,
) -> std::result::Result<(), ExistingStoreValidationError>
where
    F: FnOnce() -> std::result::Result<(), ExistingStoreValidationError>,
    G: FnMut(
        StepResult,
        rusqlite::backup::Progress,
    ) -> std::result::Result<(), ExistingStoreValidationError>,
    H: FnMut() + Send + 'static,
{
    validate_existing_bibcode_store_inner(
        path,
        cancellation,
        timeout,
        barrier,
        after_step,
        1,
        inspection_progress,
    )
}

fn validate_existing_bibcode_store_inner<F, G, H>(
    path: &Path,
    cancellation: &CancellationToken,
    timeout: Duration,
    barrier: F,
    after_step: G,
    inspection_progress_ops: i32,
    mut inspection_progress: H,
) -> std::result::Result<(), ExistingStoreValidationError>
where
    F: FnOnce() -> std::result::Result<(), ExistingStoreValidationError>,
    G: FnMut(
        StepResult,
        rusqlite::backup::Progress,
    ) -> std::result::Result<(), ExistingStoreValidationError>,
    H: FnMut() + Send + 'static,
{
    let started = Instant::now();
    let deadline =
        started
            .checked_add(timeout)
            .ok_or_else(|| ExistingStoreValidationError::Unsafe {
                path: path.to_path_buf(),
                detail: "SQLite store validation deadline exceeds the monotonic clock range"
                    .to_owned(),
            })?;
    let connection =
        coherent_validation_snapshot(path, cancellation, deadline, barrier, after_step)?;
    ensure_validation_active(path, cancellation, deadline)?;
    let inspection_cancellation = cancellation.clone();
    connection
        .progress_handler(
            inspection_progress_ops,
            Some(move || {
                inspection_progress();
                validation_stop_reason(&inspection_cancellation, deadline).is_some()
            }),
        )
        .map_err(|source| ExistingStoreValidationError::Unsafe {
            path: path.to_path_buf(),
            detail: format!("failed to install SQLite validation progress handler: {source}"),
        })?;

    ensure_validation_active(path, cancellation, deadline)?;
    let integrity = connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|source| map_corrupt_inspection_error(path, cancellation, deadline, source))?;
    ensure_validation_active(path, cancellation, deadline)?;
    if integrity != "ok" {
        return Err(ExistingStoreValidationError::Corrupt {
            path: path.to_path_buf(),
            detail: integrity,
        });
    }

    ensure_validation_active(path, cancellation, deadline)?;
    if !table_exists(&connection, "effect_sql_migrations")
        .map_err(|source| map_unrecognized_inspection_error(path, cancellation, deadline, source))?
    {
        return Err(ExistingStoreValidationError::Unrecognized {
            path: path.to_path_buf(),
            detail: "migration ledger is missing".to_owned(),
        });
    }

    ensure_validation_active(path, cancellation, deadline)?;
    let mut statement = connection
        .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC")
        .map_err(|source| {
            map_unrecognized_inspection_error(path, cancellation, deadline, source)
        })?;
    let recorded = statement
        .query_map([], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(|source| {
            map_unrecognized_inspection_error(path, cancellation, deadline, source)
        })?;
    ensure_validation_active(path, cancellation, deadline)?;
    if recorded.is_empty() {
        return Err(ExistingStoreValidationError::Unrecognized {
            path: path.to_path_buf(),
            detail: "migration ledger is empty".to_owned(),
        });
    }
    if recorded.len() > MIGRATIONS.len()
        || recorded
            .iter()
            .zip(MIGRATIONS)
            .any(|((id, name), expected)| *id != expected.id || name != expected.name)
    {
        return Err(ExistingStoreValidationError::Unrecognized {
            path: path.to_path_buf(),
            detail: "migration ledger is not an exact prefix of this binary".to_owned(),
        });
    }

    let latest_migration_id = recorded.last().expect("non-empty ledger").0;
    for (_, table) in CORE_TABLES
        .iter()
        .filter(|(migration_id, _)| *migration_id <= latest_migration_id)
    {
        ensure_validation_active(path, cancellation, deadline)?;
        if !table_exists(&connection, table).map_err(|source| {
            map_unrecognized_inspection_error(path, cancellation, deadline, source)
        })? {
            return Err(ExistingStoreValidationError::Unrecognized {
                path: path.to_path_buf(),
                detail: format!("required table {table} is missing"),
            });
        }
    }
    ensure_validation_active(path, cancellation, deadline)?;
    Ok(())
}

fn coherent_validation_snapshot<F, G>(
    source_database: &Path,
    cancellation: &CancellationToken,
    deadline: Instant,
    barrier: F,
    mut after_step: G,
) -> std::result::Result<Connection, ExistingStoreValidationError>
where
    F: FnOnce() -> std::result::Result<(), ExistingStoreValidationError>,
    G: FnMut(
        StepResult,
        rusqlite::backup::Progress,
    ) -> std::result::Result<(), ExistingStoreValidationError>,
{
    ensure_validation_active(source_database, cancellation, deadline)?;
    let source = Connection::open_with_flags(
        source_database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|source| ExistingStoreValidationError::Unsafe {
        path: source_database.to_path_buf(),
        detail: format!("failed to open source for coherent SQLite backup: {source}"),
    })?;
    source
        .busy_timeout(Duration::ZERO)
        .map_err(|source| ExistingStoreValidationError::Unsafe {
            path: source_database.to_path_buf(),
            detail: format!("failed to disable SQLite's internal validation busy wait: {source}"),
        })?;
    ensure_validation_active(source_database, cancellation, deadline)?;
    barrier()?;
    ensure_validation_active(source_database, cancellation, deadline)?;

    loop {
        ensure_validation_active(source_database, cancellation, deadline)?;
        let mut snapshot = Connection::open_in_memory().map_err(|source| {
            ExistingStoreValidationError::Unsafe {
                path: source_database.to_path_buf(),
                detail: format!("failed to create in-memory validation snapshot: {source}"),
            }
        })?;
        snapshot.busy_timeout(Duration::ZERO).map_err(|source| {
            ExistingStoreValidationError::Unsafe {
                path: source_database.to_path_buf(),
                detail: format!("failed to disable SQLite's internal snapshot busy wait: {source}"),
            }
        })?;
        ensure_validation_active(source_database, cancellation, deadline)?;
        let backup = match Backup::new(&source, &mut snapshot) {
            Ok(backup) => backup,
            Err(source) if is_transient_backup_error(&source) => {
                thread::sleep(VALIDATION_BACKUP_RETRY_DELAY);
                continue;
            }
            Err(source) => {
                return Err(ExistingStoreValidationError::Corrupt {
                    path: source_database.to_path_buf(),
                    detail: format!("failed to initialize coherent SQLite backup: {source}"),
                });
            }
        };
        let completed = loop {
            ensure_validation_active(source_database, cancellation, deadline)?;
            let (state, restart_attempt) = match backup.step(VALIDATION_BACKUP_PAGES_PER_STEP) {
                Ok(state) => (state, false),
                Err(source) if source.sqlite_error_code() == Some(ErrorCode::DatabaseBusy) => {
                    (StepResult::Busy, true)
                }
                Err(source) if source.sqlite_error_code() == Some(ErrorCode::DatabaseLocked) => {
                    (StepResult::Locked, true)
                }
                Err(source) => {
                    return Err(ExistingStoreValidationError::Corrupt {
                        path: source_database.to_path_buf(),
                        detail: format!("failed to read coherent SQLite backup: {source}"),
                    });
                }
            };
            let progress = backup.progress();
            if progress.remaining < 0
                || progress.pagecount < 0
                || progress.remaining > progress.pagecount
            {
                return Err(ExistingStoreValidationError::Unsafe {
                    path: source_database.to_path_buf(),
                    detail: format!(
                        "coherent SQLite backup reported invalid progress: {} of {} pages remain",
                        progress.remaining, progress.pagecount
                    ),
                });
            }
            after_step(state, progress)?;
            ensure_validation_active(source_database, cancellation, deadline)?;
            if restart_attempt {
                break false;
            }
            match state {
                StepResult::Done => break true,
                StepResult::More => thread::yield_now(),
                StepResult::Busy | StepResult::Locked => {
                    thread::sleep(VALIDATION_BACKUP_RETRY_DELAY);
                }
                _ => {
                    return Err(ExistingStoreValidationError::Unsafe {
                        path: source_database.to_path_buf(),
                        detail: "coherent SQLite backup returned an unsupported state".to_owned(),
                    });
                }
            }
        };
        drop(backup);
        if completed {
            return Ok(snapshot);
        }
        thread::sleep(VALIDATION_BACKUP_RETRY_DELAY);
    }
}

fn is_transient_backup_error(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn ensure_validation_active(
    source_database: &Path,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> std::result::Result<(), ExistingStoreValidationError> {
    if let Some(reason) = validation_stop_reason(cancellation, deadline) {
        return Err(validation_stopped_error(source_database, reason, None));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ValidationStopReason {
    Cancelled,
    DeadlineElapsed,
}

fn validation_stop_reason(
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Option<ValidationStopReason> {
    if cancellation.is_cancelled() {
        Some(ValidationStopReason::Cancelled)
    } else if Instant::now() >= deadline {
        Some(ValidationStopReason::DeadlineElapsed)
    } else {
        None
    }
}

fn validation_stopped_error(
    source_database: &Path,
    reason: ValidationStopReason,
    phase: Option<&str>,
) -> ExistingStoreValidationError {
    let reason = match reason {
        ValidationStopReason::Cancelled => "was cancelled",
        ValidationStopReason::DeadlineElapsed => "deadline elapsed",
    };
    let phase = phase.map_or_else(String::new, |phase| format!(" during {phase}"));
    ExistingStoreValidationError::Unsafe {
        path: source_database.to_path_buf(),
        detail: format!("SQLite store validation {reason}{phase}"),
    }
}

fn interrupted_inspection_error(
    source_database: &Path,
    cancellation: &CancellationToken,
    deadline: Instant,
    source: &rusqlite::Error,
) -> Option<ExistingStoreValidationError> {
    if source.sqlite_error_code() != Some(ErrorCode::OperationInterrupted) {
        return None;
    }
    Some(match validation_stop_reason(cancellation, deadline) {
        Some(reason) => validation_stopped_error(
            source_database,
            reason,
            Some("post-backup SQLite inspection"),
        ),
        None => ExistingStoreValidationError::Unsafe {
            path: source_database.to_path_buf(),
            detail: "post-backup SQLite inspection was interrupted unexpectedly".to_owned(),
        },
    })
}

fn map_corrupt_inspection_error(
    source_database: &Path,
    cancellation: &CancellationToken,
    deadline: Instant,
    source: rusqlite::Error,
) -> ExistingStoreValidationError {
    interrupted_inspection_error(source_database, cancellation, deadline, &source).unwrap_or_else(
        || ExistingStoreValidationError::Corrupt {
            path: source_database.to_path_buf(),
            detail: source.to_string(),
        },
    )
}

fn map_unrecognized_inspection_error(
    source_database: &Path,
    cancellation: &CancellationToken,
    deadline: Instant,
    source: rusqlite::Error,
) -> ExistingStoreValidationError {
    interrupted_inspection_error(source_database, cancellation, deadline, &source).unwrap_or_else(
        || ExistingStoreValidationError::Unrecognized {
            path: source_database.to_path_buf(),
            detail: source.to_string(),
        },
    )
}

#[cfg(test)]
fn sqlite_sidecar(database: &Path, suffix: &str) -> PathBuf {
    let mut path = database.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)",
        [table],
        |row| row.get(0),
    )
}

type MigrationFn = for<'connection> fn(&Transaction<'connection>) -> Result<()>;

#[derive(Clone, Copy, Debug)]
pub struct Migration {
    pub id: u32,
    pub name: &'static str,
    apply: MigrationFn,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration::new(1, "OrchestrationEvents", migration_001),
    Migration::new(2, "OrchestrationCommandReceipts", migration_002),
    Migration::new(3, "CheckpointDiffBlobs", migration_003),
    Migration::new(4, "ProviderSessionRuntime", migration_004),
    Migration::new(5, "Projections", migration_005),
    Migration::new(
        6,
        "ProjectionThreadSessionRuntimeModeColumns",
        migration_006,
    ),
    Migration::new(7, "ProjectionThreadMessageAttachments", migration_007),
    Migration::new(8, "ProjectionThreadActivitySequence", migration_008),
    Migration::new(9, "ProviderSessionRuntimeMode", migration_009),
    Migration::new(10, "ProjectionThreadsRuntimeMode", migration_010),
    Migration::new(11, "OrchestrationThreadCreatedRuntimeMode", migration_011),
    Migration::new(12, "ProjectionThreadsInteractionMode", migration_012),
    Migration::new(13, "ProjectionThreadProposedPlans", migration_013),
    Migration::new(
        14,
        "ProjectionThreadProposedPlanImplementation",
        migration_014,
    ),
    Migration::new(15, "ProjectionTurnsSourceProposedPlan", migration_015),
    Migration::new(16, "CanonicalizeModelSelections", migration_016),
    Migration::new(17, "ProjectionThreadsArchivedAt", migration_017),
    Migration::new(18, "ProjectionThreadsArchivedAtIndex", migration_018),
    Migration::new(19, "ProjectionSnapshotLookupIndexes", migration_019),
    Migration::new(20, "AuthAccessManagement", migration_020),
    Migration::new(21, "AuthSessionClientMetadata", migration_021),
    Migration::new(22, "AuthSessionLastConnectedAt", migration_022),
    Migration::new(23, "ProjectionThreadShellSummary", migration_023),
    Migration::new(24, "BackfillProjectionThreadShellSummary", migration_024),
    Migration::new(
        25,
        "CleanupInvalidProjectionPendingApprovals",
        migration_025,
    ),
    Migration::new(26, "CanonicalizeModelSelectionOptions", migration_026),
    Migration::new(27, "ProviderSessionRuntimeInstanceId", migration_027),
    Migration::new(28, "ProjectionThreadSessionInstanceId", migration_028),
    Migration::new(29, "ProjectionThreadDetailOrderingIndexes", migration_029),
    Migration::new(30, "ProjectionThreadShellArchiveIndexes", migration_030),
    Migration::new(31, "AuthAuthorizationScopes", migration_031),
    Migration::new(32, "AuthPairingProofKeyThumbprint", migration_032),
    Migration::new(33, "ProjectionThreadsKind", migration_033),
    Migration::new(34, "ActivityProjection", migration_034),
    Migration::new(35, "ActivityJournalEventKeyNamespace", migration_035),
    Migration::new(36, "ActivityEventIdempotencyLedger", migration_036),
    Migration::new(37, "ActivityEntryRetentionOwners", migration_037),
    Migration::new(38, "ActivityRecordRetentionCounts", migration_038),
    Migration::new(39, "DurableProviderTurnDelivery", migration_039),
    Migration::new(40, "ProjectionProjectWorktreeDiscovery", migration_040),
    Migration::new(41, "ProjectionProjectWorktreeRepositoryKey", migration_041),
    Migration::new(42, "ProjectWorktreeRepositoryPins", migration_042),
    Migration::new(43, "DurableWorktreeRemovalReceipts", migration_043),
    Migration::new(44, "ProjectionThreadSessionErrorClass", migration_044),
    Migration::new(45, "ProjectionThreadUnresolvedDelivery", migration_045),
    Migration::new(46, "ProjectRepositoryClaims", migration_046),
    Migration::new(47, "OneActiveMainThread", migration_047),
    Migration::new(48, "HashedPairingCredentials", migration_048),
];

impl Migration {
    const fn new(id: u32, name: &'static str, apply: MigrationFn) -> Self {
        Self { id, name, apply }
    }
}

/// Inspects all migrations that have not been recorded by this database.
///
/// This function is deliberately read-only. In particular, a database without an Effect
/// migration ledger is reported as needing every migration without creating that ledger.
pub fn pending_migrations(connection: &Connection) -> Result<Vec<Migration>> {
    pending_migrations_through(connection, None)
}

fn pending_migrations_through(
    connection: &Connection,
    through_id: Option<u32>,
) -> Result<Vec<Migration>> {
    let ledger_exists = table_exists(connection, "effect_sql_migrations")?;
    let latest_id = if ledger_exists {
        connection
            .query_row(
                "SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
    } else {
        0
    };
    Ok(MIGRATIONS
        .iter()
        .copied()
        .filter(|migration| {
            i64::from(migration.id) > latest_id
                && through_id.is_none_or(|through_id| migration.id <= through_id)
        })
        .collect())
}

/// Applies an already inspected migration suffix transactionally.
///
/// Ledger rows and migration bodies share one transaction, so a failed body leaves neither
/// schema nor ledger changes behind. The suffix is rechecked against the live ledger to retain
/// the former concurrent-run behavior for direct callers that do not own the store-operation
/// lock.
pub fn apply_migrations(
    connection: &mut Connection,
    pending: &[Migration],
) -> Result<Vec<Migration>> {
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    connection.execute_batch(MIGRATIONS_TABLE_SQL)?;

    let transaction = connection.transaction()?;
    let latest_id = transaction
        .query_row(
            "SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    let required = pending
        .iter()
        .copied()
        .filter(|migration| i64::from(migration.id) > latest_id)
        .collect::<Vec<_>>();

    if required.is_empty() {
        transaction.commit()?;
        return Ok(required);
    }

    if let Err(error) = insert_ledger_rows(&transaction, &required) {
        if error.sqlite_error_code() == Some(ErrorCode::ConstraintViolation) {
            transaction.rollback()?;
            return Ok(Vec::new());
        }
        return Err(error);
    }

    for migration in &required {
        (migration.apply)(&transaction)?;
    }

    transaction.commit()?;
    Ok(required)
}

/// Runs pending migrations through `through_id`, or all migrations when it is `None`.
pub fn run_migrations(
    connection: &mut Connection,
    through_id: Option<u32>,
) -> Result<Vec<Migration>> {
    let pending = pending_migrations_through(connection, through_id)?;
    apply_migrations(connection, &pending)
}

fn insert_ledger_rows(transaction: &Transaction<'_>, migrations: &[Migration]) -> Result<()> {
    let placeholders = std::iter::repeat_n("(?, ?)", migrations.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql =
        format!("INSERT INTO effect_sql_migrations (migration_id, name) VALUES {placeholders}");
    let values = migrations
        .iter()
        .flat_map(|migration| {
            [
                Value::Integer(i64::from(migration.id)),
                Value::Text(migration.name.to_owned()),
            ]
        })
        .collect::<Vec<_>>();
    transaction.execute(&sql, params_from_iter(values))?;
    Ok(())
}

fn table_has_column(transaction: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        if row.get::<_, String>(1)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn migration_001(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS orchestration_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          aggregate_kind TEXT NOT NULL,
          stream_id TEXT NOT NULL,
          stream_version INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          command_id TEXT,
          causation_event_id TEXT,
          correlation_id TEXT,
          actor_kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_events_stream_version
        ON orchestration_events(aggregate_kind, stream_id, stream_version);

        CREATE INDEX IF NOT EXISTS idx_orch_events_stream_sequence
        ON orchestration_events(aggregate_kind, stream_id, sequence);

        CREATE INDEX IF NOT EXISTS idx_orch_events_command_id
        ON orchestration_events(command_id);

        CREATE INDEX IF NOT EXISTS idx_orch_events_correlation_id
        ON orchestration_events(correlation_id);
        "#,
    )
}

fn migration_002(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS orchestration_command_receipts (
          command_id TEXT PRIMARY KEY,
          aggregate_kind TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          result_sequence INTEGER NOT NULL,
          status TEXT NOT NULL,
          error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_orch_command_receipts_aggregate
        ON orchestration_command_receipts(aggregate_kind, aggregate_id);

        CREATE INDEX IF NOT EXISTS idx_orch_command_receipts_sequence
        ON orchestration_command_receipts(result_sequence);
        "#,
    )
}

fn migration_003(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS checkpoint_diff_blobs (
          thread_id TEXT NOT NULL,
          from_turn_count INTEGER NOT NULL,
          to_turn_count INTEGER NOT NULL,
          diff TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (thread_id, from_turn_count, to_turn_count)
        );

        CREATE INDEX IF NOT EXISTS idx_checkpoint_diff_blobs_thread_to_turn
        ON checkpoint_diff_blobs(thread_id, to_turn_count);
        "#,
    )
}

fn migration_004(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS provider_session_runtime (
          thread_id TEXT PRIMARY KEY,
          provider_name TEXT NOT NULL,
          adapter_key TEXT NOT NULL,
          runtime_mode TEXT NOT NULL DEFAULT 'full-access',
          status TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          resume_cursor_json TEXT,
          runtime_payload_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_status
        ON provider_session_runtime(status);

        CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_provider
        ON provider_session_runtime(provider_name);
        "#,
    )
}

fn migration_005(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projection_projects (
          project_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          default_model TEXT,
          scripts_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );

        CREATE TABLE IF NOT EXISTS projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          model TEXT NOT NULL,
          branch TEXT,
          worktree_path TEXT,
          latest_turn_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );

        CREATE TABLE IF NOT EXISTS projection_thread_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          is_streaming INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projection_thread_activities (
          activity_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          tone TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          provider_name TEXT,
          provider_session_id TEXT,
          provider_thread_id TEXT,
          active_turn_id TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projection_turns (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          pending_message_id TEXT,
          assistant_message_id TEXT,
          state TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          checkpoint_turn_count INTEGER,
          checkpoint_ref TEXT,
          checkpoint_status TEXT,
          checkpoint_files_json TEXT NOT NULL,
          UNIQUE (thread_id, turn_id),
          UNIQUE (thread_id, checkpoint_turn_count)
        );

        CREATE TABLE IF NOT EXISTS projection_pending_approvals (
          request_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          status TEXT NOT NULL,
          decision TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS projection_state (
          projector TEXT PRIMARY KEY,
          last_applied_sequence INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_projection_projects_updated_at
        ON projection_projects(updated_at);

        CREATE INDEX IF NOT EXISTS idx_projection_threads_project_id
        ON projection_threads(project_id);

        CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created
        ON projection_thread_messages(thread_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_created
        ON projection_thread_activities(thread_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_provider_session
        ON projection_thread_sessions(provider_session_id);

        CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_requested
        ON projection_turns(thread_id, requested_at);

        CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_checkpoint_completed
        ON projection_turns(thread_id, checkpoint_turn_count, completed_at);

        CREATE INDEX IF NOT EXISTS idx_projection_pending_approvals_thread_status
        ON projection_pending_approvals(thread_id, status);
        "#,
    )
}

fn migration_006(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_thread_sessions
        ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access';

        UPDATE projection_thread_sessions
        SET runtime_mode = 'full-access'
        WHERE runtime_mode IS NULL;
        "#,
    )
}

fn migration_007(transaction: &Transaction<'_>) -> Result<()> {
    transaction
        .execute_batch("ALTER TABLE projection_thread_messages ADD COLUMN attachments_json TEXT")
}

fn migration_008(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_thread_activities ADD COLUMN sequence INTEGER;

        CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence
        ON projection_thread_activities(thread_id, sequence);
        "#,
    )
}

fn migration_009(_transaction: &Transaction<'_>) -> Result<()> {
    Ok(())
}

fn migration_010(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_threads
        ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'full-access';

        UPDATE projection_threads
        SET runtime_mode = 'full-access'
        WHERE runtime_mode IS NULL;
        "#,
    )
}

fn migration_011(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.runtimeMode', 'full-access')
        WHERE event_type = 'thread.created'
          AND json_type(payload_json, '$.runtimeMode') IS NULL;
        "#,
    )
}

fn migration_012(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_threads
        ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'default';
        "#,
    )
}

fn migration_013(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projection_thread_proposed_plans (
          plan_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          plan_markdown TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_created
        ON projection_thread_proposed_plans(thread_id, created_at);
        "#,
    )
}

fn migration_014(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_thread_proposed_plans ADD COLUMN implemented_at TEXT;
        ALTER TABLE projection_thread_proposed_plans ADD COLUMN implementation_thread_id TEXT;
        "#,
    )
}

fn migration_015(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_turns ADD COLUMN source_proposed_plan_thread_id TEXT;
        ALTER TABLE projection_turns ADD COLUMN source_proposed_plan_id TEXT;
        "#,
    )
}

fn migration_016(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_projects
        ADD COLUMN default_model_selection_json TEXT;

        UPDATE projection_projects
        SET default_model_selection_json = CASE
          WHEN default_model IS NULL THEN NULL
          ELSE json_object(
            'provider',
            CASE
              WHEN lower(default_model) LIKE '%claude%' THEN 'claudeAgent'
              ELSE 'codex'
            END,
            'model',
            default_model
          )
        END
        WHERE default_model_selection_json IS NULL;

        ALTER TABLE projection_threads
        ADD COLUMN model_selection_json TEXT;

        UPDATE projection_threads
        SET model_selection_json = json_object(
          'provider',
          COALESCE(
            (
              SELECT provider_name
              FROM projection_thread_sessions
              WHERE projection_thread_sessions.thread_id = projection_threads.thread_id
            ),
            CASE
              WHEN lower(model) LIKE '%claude%' THEN 'claudeAgent'
              ELSE 'codex'
            END,
            'codex'
          ),
          'model',
          model
        )
        WHERE model_selection_json IS NULL;

        ALTER TABLE projection_projects
        DROP COLUMN default_model;

        ALTER TABLE projection_threads
        DROP COLUMN model;

        UPDATE orchestration_events
        SET payload_json = CASE
          WHEN json_type(payload_json, '$.defaultModel') = 'null' THEN json_remove(
            json_set(payload_json, '$.defaultModelSelection', json('null')),
            '$.defaultProvider',
            '$.defaultModel',
            '$.defaultModelOptions'
          )
          ELSE json_remove(
            json_set(
              payload_json,
              '$.defaultModelSelection',
              json_patch(
                json_object(
                  'provider',
                  CASE
                    WHEN json_extract(payload_json, '$.defaultProvider') IS NOT NULL
                    THEN json_extract(payload_json, '$.defaultProvider')
                    WHEN lower(json_extract(payload_json, '$.defaultModel')) LIKE '%claude%'
                    THEN 'claudeAgent'
                    ELSE 'codex'
                  END,
                  'model',
                  json_extract(payload_json, '$.defaultModel')
                ),
                CASE
                  WHEN json_type(payload_json, '$.defaultModelOptions') IS NULL THEN '{}'
                  WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                    OR json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
                  THEN CASE
                    WHEN (
                      CASE
                        WHEN json_extract(payload_json, '$.defaultProvider') IS NOT NULL
                        THEN json_extract(payload_json, '$.defaultProvider')
                        WHEN lower(json_extract(payload_json, '$.defaultModel')) LIKE '%claude%'
                        THEN 'claudeAgent'
                        ELSE 'codex'
                      END
                    ) = 'claudeAgent'
                    THEN CASE
                      WHEN json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
                      THEN json_object(
                        'options',
                        json(json_extract(payload_json, '$.defaultModelOptions.claudeAgent'))
                      )
                      WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                      THEN json_object(
                        'options',
                        json(json_extract(payload_json, '$.defaultModelOptions.codex'))
                      )
                      ELSE '{}'
                    END
                    ELSE CASE
                      WHEN json_type(payload_json, '$.defaultModelOptions.codex') IS NOT NULL
                      THEN json_object(
                        'options',
                        json(json_extract(payload_json, '$.defaultModelOptions.codex'))
                      )
                      WHEN json_type(payload_json, '$.defaultModelOptions.claudeAgent') IS NOT NULL
                      THEN json_object(
                        'options',
                        json(json_extract(payload_json, '$.defaultModelOptions.claudeAgent'))
                      )
                      ELSE '{}'
                    END
                  END
                  ELSE json_object(
                    'options',
                    json(json_extract(payload_json, '$.defaultModelOptions'))
                  )
                END
              )
            ),
            '$.defaultProvider',
            '$.defaultModel',
            '$.defaultModelOptions'
          )
        END
        WHERE event_type IN ('project.created', 'project.meta-updated')
          AND json_type(payload_json, '$.defaultModelSelection') IS NULL
          AND json_type(payload_json, '$.defaultModel') IS NOT NULL;

        UPDATE orchestration_events
        SET payload_json = json_remove(
          json_set(
            payload_json,
            '$.modelSelection',
            json_patch(
              json_object(
                'provider',
                CASE
                  WHEN json_extract(payload_json, '$.provider') IS NOT NULL
                  THEN json_extract(payload_json, '$.provider')
                  WHEN lower(json_extract(payload_json, '$.model')) LIKE '%claude%'
                  THEN 'claudeAgent'
                  ELSE 'codex'
                END,
                'model',
                json_extract(payload_json, '$.model')
              ),
              CASE
                WHEN json_type(payload_json, '$.modelOptions') IS NULL THEN '{}'
                WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
                  OR json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
                THEN CASE
                  WHEN (
                    CASE
                      WHEN json_extract(payload_json, '$.provider') IS NOT NULL
                      THEN json_extract(payload_json, '$.provider')
                      WHEN lower(json_extract(payload_json, '$.model')) LIKE '%claude%'
                      THEN 'claudeAgent'
                      ELSE 'codex'
                    END
                  ) = 'claudeAgent'
                  THEN CASE
                    WHEN json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.modelOptions.claudeAgent'))
                    )
                    WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.modelOptions.codex'))
                    )
                    ELSE '{}'
                  END
                  ELSE CASE
                    WHEN json_type(payload_json, '$.modelOptions.codex') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.modelOptions.codex'))
                    )
                    WHEN json_type(payload_json, '$.modelOptions.claudeAgent') IS NOT NULL
                    THEN json_object(
                      'options',
                      json(json_extract(payload_json, '$.modelOptions.claudeAgent'))
                    )
                    ELSE '{}'
                  END
                END
                ELSE json_object('options', json(json_extract(payload_json, '$.modelOptions')))
              END
            )
          ),
          '$.provider',
          '$.model',
          '$.modelOptions'
        )
        WHERE event_type IN ('thread.created', 'thread.meta-updated', 'thread.turn-start-requested')
          AND json_type(payload_json, '$.modelSelection') IS NULL
          AND json_type(payload_json, '$.model') IS NOT NULL;

        UPDATE orchestration_events
        SET payload_json = json_set(
          payload_json,
          '$.modelSelection',
          json(json_object('provider', 'codex', 'model', 'gpt-5.4'))
        )
        WHERE event_type = 'thread.created'
          AND json_type(payload_json, '$.modelSelection') IS NULL
          AND json_type(payload_json, '$.model') IS NULL;
        "#,
    )
}

fn migration_017(transaction: &Transaction<'_>) -> Result<()> {
    if table_has_column(transaction, "projection_threads", "archived_at")? {
        return Ok(());
    }
    transaction.execute_batch("ALTER TABLE projection_threads ADD COLUMN archived_at TEXT")
}

fn migration_018(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_threads_project_archived_at
        ON projection_threads(project_id, archived_at);
        "#,
    )
}

fn migration_019(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_projects_workspace_root_deleted_at
        ON projection_projects(workspace_root, deleted_at);

        CREATE INDEX IF NOT EXISTS idx_projection_threads_project_deleted_created
        ON projection_threads(project_id, deleted_at, created_at);
        "#,
    )
}

fn migration_020(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS auth_pairing_links (
          id TEXT PRIMARY KEY,
          credential TEXT NOT NULL UNIQUE,
          method TEXT NOT NULL,
          role TEXT NOT NULL,
          subject TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_auth_pairing_links_active
        ON auth_pairing_links(revoked_at, consumed_at, expires_at);

        CREATE TABLE IF NOT EXISTS auth_sessions (
          session_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          role TEXT NOT NULL,
          method TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_auth_sessions_active
        ON auth_sessions(revoked_at, expires_at, issued_at);
        "#,
    )
}

fn migration_021(transaction: &Transaction<'_>) -> Result<()> {
    if !table_has_column(transaction, "auth_pairing_links", "label")? {
        transaction.execute_batch("ALTER TABLE auth_pairing_links ADD COLUMN label TEXT")?;
    }

    for (column, definition) in [
        ("client_label", "client_label TEXT"),
        ("client_ip_address", "client_ip_address TEXT"),
        ("client_user_agent", "client_user_agent TEXT"),
        (
            "client_device_type",
            "client_device_type TEXT NOT NULL DEFAULT 'unknown'",
        ),
        ("client_os", "client_os TEXT"),
        ("client_browser", "client_browser TEXT"),
    ] {
        if !table_has_column(transaction, "auth_sessions", column)? {
            transaction.execute_batch(&format!(
                "ALTER TABLE auth_sessions ADD COLUMN {definition}"
            ))?;
        }
    }

    Ok(())
}

fn migration_022(transaction: &Transaction<'_>) -> Result<()> {
    if table_has_column(transaction, "auth_sessions", "last_connected_at")? {
        return Ok(());
    }
    transaction.execute_batch("ALTER TABLE auth_sessions ADD COLUMN last_connected_at TEXT")
}

fn migration_023(transaction: &Transaction<'_>) -> Result<()> {
    let _ = transaction
        .execute_batch("ALTER TABLE projection_threads ADD COLUMN latest_user_message_at TEXT");
    let _ = transaction.execute_batch(
        "ALTER TABLE projection_threads \
         ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0",
    );
    let _ = transaction.execute_batch(
        "ALTER TABLE projection_threads \
         ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0",
    );
    let _ = transaction.execute_batch(
        "ALTER TABLE projection_threads \
         ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0",
    );
    Ok(())
}

fn migration_024(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        INSERT OR IGNORE INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        SELECT
          requested.request_id,
          requested.thread_id,
          requested.turn_id,
          'pending',
          NULL,
          requested.created_at,
          NULL
        FROM (
          SELECT
            json_extract(payload_json, '$.requestId') AS request_id,
            thread_id,
            turn_id,
            created_at,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(payload_json, '$.requestId')
              ORDER BY created_at ASC, activity_id ASC
            ) AS row_number
          FROM projection_thread_activities
          WHERE kind = 'approval.requested'
            AND json_extract(payload_json, '$.requestId') IS NOT NULL
        ) AS requested
        WHERE requested.row_number = 1;

        WITH latest_resolutions AS (
          SELECT
            resolved.request_id,
            resolved.resolved_at,
            resolved.decision
          FROM (
            SELECT
              json_extract(payload_json, '$.requestId') AS request_id,
              created_at AS resolved_at,
              CASE
                WHEN json_extract(payload_json, '$.decision') IN (
                  'accept',
                  'acceptForSession',
                  'decline',
                  'cancel'
                )
                THEN json_extract(payload_json, '$.decision')
                ELSE NULL
              END AS decision,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(payload_json, '$.requestId')
                ORDER BY created_at DESC, activity_id DESC
              ) AS row_number
            FROM projection_thread_activities
            WHERE kind = 'approval.resolved'
              AND json_extract(payload_json, '$.requestId') IS NOT NULL
          ) AS resolved
          WHERE resolved.row_number = 1
        )
        UPDATE projection_pending_approvals
        SET
          status = 'resolved',
          decision = (
            SELECT latest_resolutions.decision
            FROM latest_resolutions
            WHERE latest_resolutions.request_id = projection_pending_approvals.request_id
          ),
          resolved_at = (
            SELECT latest_resolutions.resolved_at
            FROM latest_resolutions
            WHERE latest_resolutions.request_id = projection_pending_approvals.request_id
          )
        WHERE EXISTS (
          SELECT 1
          FROM latest_resolutions
          WHERE latest_resolutions.request_id = projection_pending_approvals.request_id
        );

        WITH latest_response_events AS (
          SELECT
            response.request_id,
            response.resolved_at,
            response.decision
          FROM (
            SELECT
              json_extract(payload_json, '$.requestId') AS request_id,
              occurred_at AS resolved_at,
              CASE
                WHEN json_extract(payload_json, '$.decision') IN (
                  'accept',
                  'acceptForSession',
                  'decline',
                  'cancel'
                )
                THEN json_extract(payload_json, '$.decision')
                ELSE NULL
              END AS decision,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(payload_json, '$.requestId')
                ORDER BY occurred_at DESC, sequence DESC
              ) AS row_number
            FROM orchestration_events
            WHERE event_type = 'thread.approval-response-requested'
              AND json_extract(payload_json, '$.requestId') IS NOT NULL
          ) AS response
          WHERE response.row_number = 1
        )
        UPDATE projection_pending_approvals
        SET
          status = 'resolved',
          decision = (
            SELECT latest_response_events.decision
            FROM latest_response_events
            WHERE latest_response_events.request_id = projection_pending_approvals.request_id
          ),
          resolved_at = (
            SELECT latest_response_events.resolved_at
            FROM latest_response_events
            WHERE latest_response_events.request_id = projection_pending_approvals.request_id
          )
        WHERE EXISTS (
          SELECT 1
          FROM latest_response_events
          WHERE latest_response_events.request_id = projection_pending_approvals.request_id
        );

        WITH latest_stale_failures AS (
          SELECT
            failure.request_id,
            failure.resolved_at
          FROM (
            SELECT
              json_extract(payload_json, '$.requestId') AS request_id,
              created_at AS resolved_at,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(payload_json, '$.requestId')
                ORDER BY created_at DESC, activity_id DESC
              ) AS row_number
            FROM projection_thread_activities
            WHERE kind = 'provider.approval.respond.failed'
              AND json_extract(payload_json, '$.requestId') IS NOT NULL
              AND (
                lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                  LIKE '%stale pending approval request%'
                OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                  LIKE '%unknown pending approval request%'
                OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                  LIKE '%unknown pending permission request%'
              )
          ) AS failure
          WHERE failure.row_number = 1
        )
        UPDATE projection_pending_approvals
        SET
          status = 'resolved',
          decision = NULL,
          resolved_at = (
            SELECT latest_stale_failures.resolved_at
            FROM latest_stale_failures
            WHERE latest_stale_failures.request_id = projection_pending_approvals.request_id
          )
        WHERE status = 'pending'
          AND EXISTS (
            SELECT 1
            FROM latest_stale_failures
            WHERE latest_stale_failures.request_id = projection_pending_approvals.request_id
          );

        UPDATE projection_threads
        SET
          latest_user_message_at = (
            SELECT MAX(message.created_at)
            FROM projection_thread_messages AS message
            WHERE message.thread_id = projection_threads.thread_id
              AND message.role = 'user'
          ),
          pending_approval_count = COALESCE((
            SELECT COUNT(*)
            FROM projection_pending_approvals
            WHERE projection_pending_approvals.thread_id = projection_threads.thread_id
              AND projection_pending_approvals.status = 'pending'
          ), 0),
          pending_user_input_count = COALESCE((
            WITH latest_user_input_states AS (
              SELECT
                latest.request_id,
                latest.kind,
                latest.detail
              FROM (
                SELECT
                  json_extract(activity.payload_json, '$.requestId') AS request_id,
                  activity.kind,
                  lower(COALESCE(json_extract(activity.payload_json, '$.detail'), '')) AS detail,
                  ROW_NUMBER() OVER (
                    PARTITION BY json_extract(activity.payload_json, '$.requestId')
                    ORDER BY activity.created_at DESC, activity.activity_id DESC
                  ) AS row_number
                FROM projection_thread_activities AS activity
                WHERE activity.thread_id = projection_threads.thread_id
                  AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
                  AND activity.kind IN (
                    'user-input.requested',
                    'user-input.resolved',
                    'provider.user-input.respond.failed'
                  )
              ) AS latest
              WHERE latest.row_number = 1
            )
            SELECT COUNT(*)
            FROM latest_user_input_states
            WHERE latest_user_input_states.kind = 'user-input.requested'
              OR (
                latest_user_input_states.kind = 'provider.user-input.respond.failed'
                AND latest_user_input_states.detail NOT LIKE '%stale pending user-input request%'
                AND latest_user_input_states.detail NOT LIKE '%unknown pending user-input request%'
              )
          ), 0),
          has_actionable_proposed_plan = COALESCE((
            SELECT CASE
              WHEN projection_threads.latest_turn_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM projection_thread_proposed_plans AS latest_turn_plan_exists
                  WHERE latest_turn_plan_exists.thread_id = projection_threads.thread_id
                    AND latest_turn_plan_exists.turn_id = projection_threads.latest_turn_id
                )
                THEN CASE
                  WHEN (
                    SELECT latest_turn_plan.implemented_at
                    FROM projection_thread_proposed_plans AS latest_turn_plan
                    WHERE latest_turn_plan.thread_id = projection_threads.thread_id
                      AND latest_turn_plan.turn_id = projection_threads.latest_turn_id
                    ORDER BY latest_turn_plan.updated_at DESC, latest_turn_plan.plan_id DESC
                    LIMIT 1
                  ) IS NULL
                    THEN 1
                    ELSE 0
                  END
              WHEN EXISTS (
                SELECT 1
                FROM projection_thread_proposed_plans AS any_plan
                WHERE any_plan.thread_id = projection_threads.thread_id
              )
                THEN CASE
                  WHEN (
                    SELECT latest_plan.implemented_at
                    FROM projection_thread_proposed_plans AS latest_plan
                    WHERE latest_plan.thread_id = projection_threads.thread_id
                    ORDER BY latest_plan.updated_at DESC, latest_plan.plan_id DESC
                    LIMIT 1
                  ) IS NULL
                    THEN 1
                    ELSE 0
                  END
              ELSE 0
            END
          ), 0);
        "#,
    )
}

fn migration_025(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        DELETE FROM projection_pending_approvals
        WHERE NOT EXISTS (
          SELECT 1
          FROM projection_thread_activities AS activity
          WHERE activity.kind = 'approval.requested'
            AND json_extract(activity.payload_json, '$.requestId')
              = projection_pending_approvals.request_id
        );

        UPDATE projection_threads
        SET pending_approval_count = COALESCE((
          SELECT COUNT(*)
          FROM projection_pending_approvals
          WHERE projection_pending_approvals.thread_id = projection_threads.thread_id
            AND projection_pending_approvals.status = 'pending'
        ), 0);
        "#,
    )
}

fn migration_026(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        UPDATE projection_threads
        SET model_selection_json = json_set(
          model_selection_json,
          '$.options',
          (
            SELECT json_group_array(
              json_object(
                'id', key,
                'value',
                CASE type
                  WHEN 'true' THEN json('true')
                  WHEN 'false' THEN json('false')
                  ELSE atom
                END
              )
            )
            FROM json_each(json_extract(model_selection_json, '$.options'))
            WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
               OR type IN ('true', 'false')
          )
        )
        WHERE model_selection_json IS NOT NULL
          AND json_type(model_selection_json, '$.options') = 'object';

        UPDATE projection_projects
        SET default_model_selection_json = json_set(
          default_model_selection_json,
          '$.options',
          (
            SELECT json_group_array(
              json_object(
                'id', key,
                'value',
                CASE type
                  WHEN 'true' THEN json('true')
                  WHEN 'false' THEN json('false')
                  ELSE atom
                END
              )
            )
            FROM json_each(json_extract(default_model_selection_json, '$.options'))
            WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
               OR type IN ('true', 'false')
          )
        )
        WHERE default_model_selection_json IS NOT NULL
          AND json_type(default_model_selection_json, '$.options') = 'object';

        UPDATE orchestration_events
        SET payload_json = json_set(
          payload_json,
          '$.modelSelection.options',
          (
            SELECT json_group_array(
              json_object(
                'id', key,
                'value',
                CASE type
                  WHEN 'true' THEN json('true')
                  WHEN 'false' THEN json('false')
                  ELSE atom
                END
              )
            )
            FROM json_each(json_extract(payload_json, '$.modelSelection.options'))
            WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
               OR type IN ('true', 'false')
          )
        )
        WHERE event_type IN (
          'thread.created',
          'thread.meta-updated',
          'thread.turn-start-requested'
        )
          AND json_type(payload_json, '$.modelSelection.options') = 'object';

        UPDATE orchestration_events
        SET payload_json = json_set(
          payload_json,
          '$.defaultModelSelection.options',
          (
            SELECT json_group_array(
              json_object(
                'id', key,
                'value',
                CASE type
                  WHEN 'true' THEN json('true')
                  WHEN 'false' THEN json('false')
                  ELSE atom
                END
              )
            )
            FROM json_each(json_extract(payload_json, '$.defaultModelSelection.options'))
            WHERE (type = 'text' AND trim(coalesce(atom, '')) != '')
               OR type IN ('true', 'false')
          )
        )
        WHERE event_type IN ('project.created', 'project.meta-updated')
          AND json_type(payload_json, '$.defaultModelSelection.options') = 'object';
        "#,
    )
}

fn migration_027(transaction: &Transaction<'_>) -> Result<()> {
    if !table_has_column(
        transaction,
        "provider_session_runtime",
        "provider_instance_id",
    )? {
        transaction.execute_batch(
            "ALTER TABLE provider_session_runtime ADD COLUMN provider_instance_id TEXT",
        )?;
    }

    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_instance
        ON provider_session_runtime(provider_instance_id);
        "#,
    )
}

fn migration_028(transaction: &Transaction<'_>) -> Result<()> {
    if !table_has_column(
        transaction,
        "projection_thread_sessions",
        "provider_instance_id",
    )? {
        transaction.execute_batch(
            "ALTER TABLE projection_thread_sessions ADD COLUMN provider_instance_id TEXT",
        )?;
    }

    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_instance
        ON projection_thread_sessions(provider_instance_id);
        "#,
    )
}

fn migration_029(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence_created_id
        ON projection_thread_activities(thread_id, sequence, created_at, activity_id);

        CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created_id
        ON projection_thread_messages(thread_id, created_at, message_id);
        "#,
    )
}

fn migration_030(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_active
        ON projection_threads(deleted_at, archived_at, project_id, created_at, thread_id);

        CREATE INDEX IF NOT EXISTS idx_projection_threads_shell_archived
        ON projection_threads(deleted_at, archived_at, project_id, thread_id);
        "#,
    )
}

fn migration_031(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        DROP TABLE IF EXISTS auth_pairing_links;
        DROP TABLE IF EXISTS auth_sessions;

        CREATE TABLE auth_pairing_links (
          id TEXT PRIMARY KEY,
          credential TEXT NOT NULL UNIQUE,
          method TEXT NOT NULL,
          scopes TEXT NOT NULL,
          subject TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        );

        CREATE INDEX idx_auth_pairing_links_active
        ON auth_pairing_links(revoked_at, consumed_at, expires_at);

        CREATE TABLE auth_sessions (
          session_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          scopes TEXT NOT NULL,
          method TEXT NOT NULL,
          client_label TEXT,
          client_ip_address TEXT,
          client_user_agent TEXT,
          client_device_type TEXT NOT NULL DEFAULT 'unknown',
          client_os TEXT,
          client_browser TEXT,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_connected_at TEXT,
          revoked_at TEXT
        );

        CREATE INDEX idx_auth_sessions_active
        ON auth_sessions(revoked_at, expires_at, issued_at);
        "#,
    )
}

fn migration_032(transaction: &Transaction<'_>) -> Result<()> {
    if table_has_column(transaction, "auth_pairing_links", "proof_key_thumbprint")? {
        return Ok(());
    }
    transaction.execute_batch("ALTER TABLE auth_pairing_links ADD COLUMN proof_key_thumbprint TEXT")
}

fn migration_033(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_threads
        ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace';

        UPDATE projection_threads
        SET kind = 'workspace'
        WHERE kind IS NULL;
        "#,
    )
}

fn migration_034(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE activity_scopes (
          scope_id TEXT PRIMARY KEY NOT NULL,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('thread', 'terminal')),
          thread_id TEXT NOT NULL,
          terminal_id TEXT,
          generation_id TEXT NOT NULL,
          is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0, 1)),
          provider_name TEXT NOT NULL,
          provider_instance_id TEXT,
          capabilities_json TEXT NOT NULL,
          observation_state TEXT NOT NULL,
          section_health_json TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_activity_scopes_one_current
          ON activity_scopes(thread_id, source_kind, COALESCE(terminal_id, ''))
          WHERE is_current = 1;
        CREATE INDEX idx_activity_scopes_lookup
          ON activity_scopes(thread_id, source_kind, terminal_id, is_current, updated_at DESC);
        CREATE INDEX idx_activity_scopes_current_terminal_owner
          ON activity_scopes(terminal_id, thread_id)
          WHERE source_kind = 'terminal' AND is_current = 1;

        CREATE TABLE activity_records (
          scope_id TEXT NOT NULL REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          record_kind TEXT NOT NULL CHECK(record_kind IN ('actor', 'workItem')),
          record_id TEXT NOT NULL,
          parent_actor_id TEXT,
          owner_actor_id TEXT,
          status TEXT NOT NULL,
          native_sort_key TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          terminal_at TEXT,
          PRIMARY KEY(scope_id, record_kind, record_id)
        );
        CREATE INDEX idx_activity_records_roster
          ON activity_records(scope_id, record_kind, status, updated_at DESC, record_id DESC);

        CREATE TABLE activity_entries (
          scope_id TEXT NOT NULL REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL,
          owner_kind TEXT NOT NULL CHECK(owner_kind IN ('actor', 'workItem')),
          owner_id TEXT NOT NULL,
          native_sort_key TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(scope_id, entry_id)
        );
        CREATE INDEX idx_activity_entries_detail
          ON activity_entries(scope_id, owner_kind, owner_id, created_at DESC, entry_id DESC);

        CREATE TABLE activity_journal (
          scope_id TEXT NOT NULL REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          native_event_key TEXT NOT NULL,
          delta_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(scope_id, revision),
          UNIQUE(scope_id, native_event_key)
        );
        "#,
    )
}

fn migration_035(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        ALTER TABLE activity_journal RENAME TO activity_journal_v34;

        CREATE TABLE activity_journal (
          scope_id TEXT NOT NULL REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          event_key_namespace TEXT NOT NULL
            CHECK(event_key_namespace IN ('legacy', 'canonical')),
          native_event_key TEXT NOT NULL,
          delta_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(scope_id, revision),
          UNIQUE(scope_id, event_key_namespace, native_event_key)
        );

        INSERT INTO activity_journal (
          scope_id,
          revision,
          event_key_namespace,
          native_event_key,
          delta_json,
          created_at
        )
        SELECT
          scope_id,
          revision,
          'legacy',
          native_event_key,
          delta_json,
          created_at
        FROM activity_journal_v34;

        DROP TABLE activity_journal_v34;
        "#,
    )
}

fn migration_036(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE activity_event_idempotency (
          scope_id TEXT NOT NULL REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          native_event_key TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(scope_id, native_event_key)
        );
        CREATE INDEX idx_activity_event_idempotency_retention
          ON activity_event_idempotency(scope_id, revision ASC);

        INSERT OR IGNORE INTO activity_event_idempotency (
          scope_id, native_event_key, revision, created_at
        )
        SELECT scope_id, native_event_key, revision, created_at
        FROM activity_journal
        WHERE event_key_namespace = 'canonical';
        "#,
    )
}

fn migration_037(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE activity_entry_owners (
          scope_id TEXT NOT NULL REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          owner_kind TEXT NOT NULL CHECK(owner_kind IN ('actor', 'workItem')),
          owner_id TEXT NOT NULL,
          entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
          PRIMARY KEY(scope_id, owner_kind, owner_id)
        );
        CREATE INDEX idx_activity_entry_owners_retention
          ON activity_entry_owners(scope_id, entry_count DESC, owner_kind, owner_id);

        INSERT INTO activity_entry_owners (scope_id, owner_kind, owner_id, entry_count)
        SELECT scope_id, owner_kind, owner_id, COUNT(*)
        FROM activity_entries
        GROUP BY scope_id, owner_kind, owner_id;
        "#,
    )
}

fn migration_038(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE activity_record_retention_counts (
          scope_id TEXT PRIMARY KEY REFERENCES activity_scopes(scope_id) ON DELETE CASCADE,
          record_count INTEGER NOT NULL CHECK(record_count >= 0)
        );
        CREATE INDEX idx_activity_records_retention_candidates
          ON activity_records(scope_id, terminal_at ASC, updated_at ASC, record_kind, record_id)
          WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted');

        INSERT INTO activity_record_retention_counts (scope_id, record_count)
        SELECT scope_id, COUNT(*)
        FROM activity_records
        GROUP BY scope_id;
        "#,
    )
}

fn migration_039(transaction: &Transaction<'_>) -> Result<()> {
    if !table_has_column(transaction, "orchestration_command_receipts", "command_id")? {
        return Ok(());
    }

    transaction.execute_batch(
        r#"
        ALTER TABLE orchestration_command_receipts ADD COLUMN payload_digest TEXT;

        CREATE TABLE provider_turn_outbox (
          command_id TEXT PRIMARY KEY
            REFERENCES orchestration_command_receipts(command_id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          provider_instance_id TEXT NOT NULL,
          provider_kind TEXT NOT NULL,
          provider_session_id TEXT,
          delivery_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'delivered', 'uncertain', 'dismissed', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_provider_turn_outbox_thread_state
          ON provider_turn_outbox(thread_id, state, created_at, command_id);
        CREATE UNIQUE INDEX idx_provider_turn_outbox_message
          ON provider_turn_outbox(message_id);

        CREATE TABLE orchestration_attachment_refs (
          command_id TEXT NOT NULL
            REFERENCES orchestration_command_receipts(command_id) ON DELETE CASCADE,
          attachment_id TEXT NOT NULL,
          content_digest TEXT,
          size_bytes INTEGER NOT NULL,
          PRIMARY KEY (command_id, attachment_id)
        );
        CREATE INDEX idx_orchestration_attachment_refs_attachment
          ON orchestration_attachment_refs(attachment_id);

        ALTER TABLE projection_thread_messages ADD COLUMN delivery_state TEXT;
        ALTER TABLE projection_thread_messages ADD COLUMN delivery_provider TEXT;
        ALTER TABLE projection_thread_messages ADD COLUMN delivery_detail TEXT;
        "#,
    )?;

    let legacy_refs: Vec<(String, String, i64)> = {
        let mut statement = transaction.prepare(
            "SELECT command_id, payload_json FROM orchestration_events
             WHERE event_type = 'thread.message-sent' AND command_id IS NOT NULL
               AND json_extract(payload_json, '$.role') = 'user'",
        )?;
        let mut rows = statement.query([])?;
        let mut refs = Vec::new();
        while let Some(row) = rows.next()? {
            let command_id: String = row.get(0)?;
            let payload_json: String = row.get(1)?;
            let payload: serde_json::Value =
                serde_json::from_str(&payload_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            let Some(attachments) = payload.get("attachments") else {
                continue;
            };
            if attachments.is_null() {
                continue;
            }
            let attachments = attachments.as_array().ok_or_else(|| {
                rusqlite::Error::InvalidParameterName(
                    "legacy thread.message-sent attachments must be an array".to_owned(),
                )
            })?;
            for attachment in attachments {
                let attachment_id = attachment
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        rusqlite::Error::InvalidParameterName(
                            "legacy attachment is missing string id".to_owned(),
                        )
                    })?;
                let size_bytes = attachment
                    .get("sizeBytes")
                    .and_then(serde_json::Value::as_i64)
                    .filter(|size| *size >= 0)
                    .ok_or_else(|| {
                        rusqlite::Error::InvalidParameterName(
                            "legacy attachment is missing non-negative integer sizeBytes"
                                .to_owned(),
                        )
                    })?;
                refs.push((command_id.clone(), attachment_id.to_owned(), size_bytes));
            }
        }
        refs
    };

    for (command_id, attachment_id, size_bytes) in legacy_refs {
        transaction.execute(
            "INSERT OR IGNORE INTO orchestration_attachment_refs \
             (command_id, attachment_id, content_digest, size_bytes) VALUES (?, ?, NULL, ?)",
            rusqlite::params![command_id, attachment_id, size_bytes],
        )?;
    }
    Ok(())
}

fn migration_040(transaction: &Transaction<'_>) -> Result<()> {
    if !table_has_column(transaction, "projection_projects", "project_id")?
        || table_has_column(
            transaction,
            "projection_projects",
            "worktree_discovery_json",
        )?
    {
        return Ok(());
    }
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_projects
        ADD COLUMN worktree_discovery_json TEXT NOT NULL
        DEFAULT '{"visibility":"hidden","initialPromptDismissedAt":null,"baselinePaths":[]}';
        "#,
    )
}

fn migration_041(transaction: &Transaction<'_>) -> Result<()> {
    if !table_has_column(transaction, "projection_projects", "project_id")?
        || table_has_column(
            transaction,
            "projection_projects",
            "worktree_repository_key",
        )?
    {
        return Ok(());
    }
    transaction.execute_batch(
        r#"
        ALTER TABLE projection_projects
        ADD COLUMN worktree_repository_key TEXT;
        "#,
    )
}

fn migration_042(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS project_worktree_repository_pins (
          project_id TEXT PRIMARY KEY NOT NULL,
          repository_key TEXT NOT NULL
        );
        "#,
    )?;
    if table_has_column(
        transaction,
        "projection_projects",
        "worktree_repository_key",
    )? {
        transaction.execute_batch(
            r#"
            INSERT OR IGNORE INTO project_worktree_repository_pins (project_id, repository_key)
            SELECT project_id, worktree_repository_key
            FROM projection_projects
            WHERE worktree_repository_key IS NOT NULL;
            "#,
        )?;
    }
    Ok(())
}

fn migration_043(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        r#"
        CREATE TABLE worktree_removal_receipts (
          owner_thread_id TEXT PRIMARY KEY,
          project_cwd TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          identity_nonce TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared', 'removed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_worktree_removal_receipts_path
          ON worktree_removal_receipts(project_cwd, worktree_path, state);
        "#,
    )
}

fn migration_044(transaction: &Transaction<'_>) -> Result<()> {
    // `last_error` alone cannot say who reported the failure: it carries both a
    // provider's own message and BiBCode's restart notice. The class travels
    // beside it so the UI can attribute the error instead of guessing.
    // Guarded the same way as migration 028: a database restored from a
    // trusted-ledger path may not carry this rebuildable projection table, and
    // an unconditional ALTER would fail the whole migration.
    if table_exists(transaction, "projection_thread_sessions")?
        && !table_has_column(
            transaction,
            "projection_thread_sessions",
            "last_error_class",
        )?
    {
        transaction.execute_batch(
            "ALTER TABLE projection_thread_sessions ADD COLUMN last_error_class TEXT",
        )?;
    }
    Ok(())
}

fn migration_045(transaction: &Transaction<'_>) -> Result<()> {
    // A delivery the provider refused, or one whose fate is unknown, was only
    // visible inside the open chat. Deriving it onto the thread shell lets the
    // sidebar show it, and because it is recomputed from the outbox on every
    // delivery transition it clears itself on retry, dismissal or success.
    // Guarded like 044: a trusted-ledger restore may not carry this rebuildable
    // projection table.
    if table_exists(transaction, "projection_threads")? {
        if !table_has_column(
            transaction,
            "projection_threads",
            "unresolved_delivery_state",
        )? {
            transaction.execute_batch(
                "ALTER TABLE projection_threads ADD COLUMN unresolved_delivery_state TEXT",
            )?;
        }
        if !table_has_column(
            transaction,
            "projection_threads",
            "unresolved_delivery_detail",
        )? {
            transaction.execute_batch(
                "ALTER TABLE projection_threads ADD COLUMN unresolved_delivery_detail TEXT",
            )?;
        }
    }
    Ok(())
}

fn migration_046(transaction: &Transaction<'_>) -> Result<()> {
    if table_exists(transaction, "projection_projects")?
        && table_exists(transaction, "project_worktree_repository_pins")?
    {
        let conflict = transaction
            .query_row(
                "SELECT pins.repository_key, GROUP_CONCAT(projects.project_id, ',') \
                 FROM projection_projects AS projects \
                 JOIN project_worktree_repository_pins AS pins USING (project_id) \
                 WHERE projects.deleted_at IS NULL \
                 GROUP BY pins.repository_key \
                 HAVING COUNT(*) > 1 \
                 ORDER BY pins.repository_key ASC \
                 LIMIT 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((repository_key, project_ids)) = conflict {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "cannot establish project repository claims: repository key '{repository_key}' is pinned by multiple active projects [{project_ids}]"
            )));
        }
    }

    transaction.execute_batch(
        r#"
        CREATE TABLE project_repository_claims (
          project_id TEXT PRIMARY KEY NOT NULL,
          repository_key TEXT NOT NULL UNIQUE,
          claimed_at TEXT NOT NULL
        );
        "#,
    )?;

    if table_exists(transaction, "projection_projects")?
        && table_exists(transaction, "project_worktree_repository_pins")?
    {
        transaction.execute_batch(
            r#"
            INSERT INTO project_repository_claims(project_id, repository_key, claimed_at)
            SELECT projects.project_id, pins.repository_key, projects.created_at
            FROM projection_projects AS projects
            JOIN project_worktree_repository_pins AS pins USING(project_id)
            WHERE projects.deleted_at IS NULL;
            "#,
        )?;
    }
    Ok(())
}

fn migration_047(transaction: &Transaction<'_>) -> Result<()> {
    if !table_exists(transaction, "projection_projects")?
        || !table_exists(transaction, "projection_threads")?
    {
        return Ok(());
    }

    let project_ids = {
        let mut statement = transaction.prepare(
            "SELECT project_id FROM projection_projects WHERE deleted_at IS NULL \
             UNION \
             SELECT project_id FROM projection_threads WHERE deleted_at IS NULL \
             ORDER BY project_id",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let format_ids = |ids: &[String]| {
        if ids.is_empty() {
            "<none>".to_owned()
        } else {
            ids.join(",")
        }
    };

    for project_id in project_ids {
        let active_threads = {
            let mut statement = transaction.prepare(
                "SELECT thread_id, kind FROM projection_threads \
                 WHERE project_id = ? AND deleted_at IS NULL ORDER BY thread_id",
            )?;
            statement
                .query_map([project_id.as_str()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let active_thread_ids = active_threads
            .iter()
            .map(|(thread_id, _)| thread_id.clone())
            .collect::<Vec<_>>();
        let current_default_ids = active_threads
            .iter()
            .filter(|(_, kind)| kind == "default")
            .map(|(thread_id, _)| thread_id.clone())
            .collect::<Vec<_>>();
        let mut inferred_kinds = Vec::with_capacity(active_threads.len());
        let mut unresolved_ids = Vec::new();

        for (thread_id, _) in &active_threads {
            let classifications = {
                let mut statement = transaction.prepare(
                    r#"
                    SELECT DISTINCT CASE
                      WHEN json_type(thread_event.payload_json, '$.kind') = 'text'
                        THEN json_extract(thread_event.payload_json, '$.kind')
                      WHEN json_type(thread_event.payload_json, '$.kind') IS NULL
                        AND EXISTS (
                          SELECT 1
                          FROM orchestration_events AS project_event
                          WHERE project_event.event_type = 'project.created'
                            AND project_event.command_id = thread_event.command_id
                            AND json_extract(project_event.payload_json, '$.projectId') = ?1
                        )
                        THEN 'default'
                      WHEN json_type(thread_event.payload_json, '$.kind') IS NULL
                        THEN 'workspace'
                      ELSE NULL
                    END AS inferred_kind
                    FROM orchestration_events AS thread_event
                    WHERE thread_event.event_type = 'thread.created'
                      AND json_extract(thread_event.payload_json, '$.projectId') = ?1
                      AND json_extract(thread_event.payload_json, '$.threadId') = ?2
                    ORDER BY inferred_kind
                    "#,
                )?;
                statement
                    .query_map(rusqlite::params![project_id, thread_id], |row| {
                        row.get::<_, Option<String>>(0)
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            let inferred_kind = match classifications.as_slice() {
                [Some(kind)] if matches!(kind.as_str(), "default" | "workspace" | "panel") => {
                    Some(kind.clone())
                }
                _ => None,
            };
            if let Some(kind) = inferred_kind {
                inferred_kinds.push((thread_id.clone(), kind));
            } else {
                unresolved_ids.push(thread_id.clone());
            }
        }

        let canonical_main_ids = inferred_kinds
            .iter()
            .filter(|(_, kind)| kind == "default")
            .map(|(thread_id, _)| thread_id.clone())
            .collect::<Vec<_>>();
        if !unresolved_ids.is_empty() || canonical_main_ids.len() != 1 {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "cannot establish permanent Main for project '{project_id}': active threads [{}], current default threads [{}], canonical Main candidates [{}], unresolved canonical kinds [{}]",
                format_ids(&active_thread_ids),
                format_ids(&current_default_ids),
                format_ids(&canonical_main_ids),
                format_ids(&unresolved_ids),
            )));
        }

        for (thread_id, kind) in inferred_kinds {
            transaction.execute(
                "UPDATE projection_threads SET kind = ? \
                 WHERE thread_id = ? AND project_id = ? AND deleted_at IS NULL",
                rusqlite::params![kind, thread_id, project_id],
            )?;
        }
    }

    transaction.execute_batch(
        r#"
        CREATE UNIQUE INDEX idx_projection_threads_one_active_default
        ON projection_threads(project_id)
        WHERE kind = 'default' AND deleted_at IS NULL;
        "#,
    )
}

fn migration_048(transaction: &Transaction<'_>) -> Result<()> {
    if !table_exists(transaction, "auth_pairing_links")? {
        return Ok(());
    }
    transaction.pragma_update(None, "secure_delete", "ON")?;

    let legacy_rows = {
        let mut statement = transaction.prepare(
            "SELECT id, credential, method, scopes, subject, label, proof_key_thumbprint, \
                    created_at, expires_at, consumed_at, revoked_at \
             FROM auth_pairing_links",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    transaction.execute_batch(
        r#"
        CREATE TABLE auth_pairing_links_v48 (
          id TEXT PRIMARY KEY,
          credential_hash BLOB NOT NULL UNIQUE CHECK(length(credential_hash) = 32),
          credential_fingerprint TEXT NOT NULL,
          method TEXT NOT NULL,
          scopes TEXT NOT NULL,
          subject TEXT NOT NULL,
          label TEXT,
          proof_key_thumbprint TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        );
        "#,
    )?;
    for (
        id,
        credential,
        method,
        scopes,
        subject,
        label,
        proof_key_thumbprint,
        created_at,
        expires_at,
        consumed_at,
        revoked_at,
    ) in legacy_rows
    {
        let hash = Sha256::digest(credential.as_bytes()).to_vec();
        let fingerprint = super::repositories::pairing_credential_fingerprint(&hash);
        transaction.execute(
            "INSERT INTO auth_pairing_links_v48 (id, credential_hash, credential_fingerprint, \
             method, scopes, subject, label, proof_key_thumbprint, created_at, expires_at, \
             consumed_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                id,
                hash,
                fingerprint,
                method,
                scopes,
                subject,
                label,
                proof_key_thumbprint,
                created_at,
                expires_at,
                consumed_at,
                revoked_at,
            ],
        )?;
    }
    transaction.execute_batch(
        r#"
        DROP TABLE auth_pairing_links;
        ALTER TABLE auth_pairing_links_v48 RENAME TO auth_pairing_links;

        CREATE INDEX idx_auth_pairing_links_active
        ON auth_pairing_links(revoked_at, consumed_at, expires_at);

        CREATE TABLE auth_pairing_exchange_receipts (
          pairing_id TEXT NOT NULL,
          proof_thumbprint TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (pairing_id, proof_thumbprint),
          FOREIGN KEY (pairing_id) REFERENCES auth_pairing_links(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES auth_sessions(session_id) ON DELETE CASCADE
        );

        CREATE INDEX idx_auth_pairing_exchange_receipts_expiry
        ON auth_pairing_exchange_receipts(expires_at, created_at);
        "#,
    )?;
    if !table_has_column(transaction, "auth_sessions", "proof_key_thumbprint")? {
        transaction
            .execute_batch("ALTER TABLE auth_sessions ADD COLUMN proof_key_thumbprint TEXT")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        MIGRATIONS, Migration, migration_001, run_migrations, sqlite_sidecar, table_exists,
        validate_existing_bibcode_store, validate_existing_bibcode_store_with_barrier,
        validate_existing_bibcode_store_with_control,
        validate_existing_bibcode_store_with_inspection_control,
    };
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    type DeliveryColumn = (String, String, i64, Option<String>, i64);

    #[test]
    fn validation_of_a_wal_store_preserves_persistent_source_entries_and_bytes() {
        let root = TempDir::new().expect("temporary validation root");
        let database = root.path().join("state.sqlite");
        let mut connection = rusqlite::Connection::open(&database).expect("fixture database");
        run_migrations(&mut connection, None).expect("fixture migrations");
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .expect("WAL fixture");
        connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .expect("disable fixture checkpoint");
        connection
            .execute(
                "INSERT INTO projection_projects (
                   project_id, title, workspace_root, default_model_selection_json,
                   scripts_json, created_at, updated_at, deleted_at
                 ) VALUES ('validation-project', 'Validation project', '/tmp/validation', NULL,
                           '{}', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', NULL)",
                [],
            )
            .expect("uncheckpointed fixture write");
        let before = persistent_directory_snapshot(root.path());

        validate_existing_bibcode_store(&database, &CancellationToken::new())
            .expect("valid WAL store");

        assert_eq!(persistent_directory_snapshot(root.path()), before);

        let crash_root = TempDir::new().expect("temporary crash-left validation root");
        let crash_database = crash_root.path().join("state.sqlite");
        std::fs::copy(&database, &crash_database).expect("copy stable main database fixture");
        std::fs::copy(
            sqlite_sidecar(&database, "-wal"),
            sqlite_sidecar(&crash_database, "-wal"),
        )
        .expect("copy stable WAL fixture");
        let without_shared_memory = persistent_directory_snapshot(crash_root.path());

        validate_existing_bibcode_store(&crash_database, &CancellationToken::new())
            .expect("valid crash-left WAL store without source SHM");

        assert_eq!(
            persistent_directory_snapshot(crash_root.path()),
            without_shared_memory
        );
        let entries = directory_entry_names(crash_root.path());
        assert!(entries.contains(&std::ffi::OsString::from("state.sqlite")));
        assert!(entries.contains(&std::ffi::OsString::from("state.sqlite-wal")));
        assert!(
            entries.iter().all(|entry| {
                entry == "state.sqlite"
                    || entry == "state.sqlite-wal"
                    || entry == "state.sqlite-shm"
            }),
            "validation may create only SQLite's volatile SHM coordination entry: {entries:?}"
        );
    }

    #[test]
    fn validation_remains_coherent_when_wal_is_checkpointed_after_source_open() {
        let root = TempDir::new().expect("temporary validation root");
        let database = root.path().join("state.sqlite");
        let mut writer = rusqlite::Connection::open(&database).expect("fixture database");
        writer
            .pragma_update(None, "journal_mode", "WAL")
            .expect("WAL fixture");
        writer
            .pragma_update(None, "wal_autocheckpoint", 0)
            .expect("disable fixture checkpoint");
        run_migrations(&mut writer, None).expect("fixture migrations remain in WAL");
        assert!(
            sqlite_sidecar(&database, "-wal")
                .metadata()
                .expect("fixture WAL")
                .len()
                > 0
        );

        validate_existing_bibcode_store_with_barrier(&database, &CancellationToken::new(), || {
            let checkpoint = writer
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .expect("checkpoint fixture WAL");
            assert_eq!(checkpoint.0, 0, "checkpoint was not blocked");
            Ok(())
        })
        .expect("valid store must remain recognizable across checkpoint reset");
    }

    #[test]
    fn validation_yields_between_positive_page_batches_for_a_live_checkpoint() {
        let root = TempDir::new().expect("temporary validation root");
        let database = root.path().join("state.sqlite");
        let mut writer = rusqlite::Connection::open(&database).expect("fixture database");
        writer
            .pragma_update(None, "page_size", 512)
            .expect("small fixture page size");
        writer
            .pragma_update(None, "journal_mode", "WAL")
            .expect("WAL fixture");
        writer
            .pragma_update(None, "wal_autocheckpoint", 0)
            .expect("disable fixture checkpoint");
        run_migrations(&mut writer, None).expect("fixture migrations");
        writer
            .execute_batch(
                "CREATE TABLE validation_backup_padding (payload BLOB NOT NULL);
                 INSERT INTO validation_backup_padding (payload) VALUES (zeroblob(262144));
                 PRAGMA wal_checkpoint(TRUNCATE);",
            )
            .expect("multi-batch fixture");

        let mut steps = Vec::new();
        let mut checkpoint_between_batches = false;
        validate_existing_bibcode_store_with_control(
            &database,
            &CancellationToken::new(),
            std::time::Duration::from_secs(1),
            || Ok(()),
            |state, progress| {
                steps.push((state, progress.remaining, progress.pagecount));
                if steps.len() == 1 {
                    assert_eq!(state, rusqlite::backup::StepResult::More);
                    assert!(progress.remaining > 0);
                    writer
                        .execute(
                            "UPDATE validation_backup_padding SET payload = zeroblob(262144)",
                            [],
                        )
                        .expect("commit between backup batches");
                    let busy = writer
                        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .expect("checkpoint between backup batches");
                    assert_eq!(busy, 0, "backup batch retained the source lock");
                    checkpoint_between_batches = true;
                }
                Ok(())
            },
        )
        .expect("valid store remains coherent across batched backup");

        assert!(checkpoint_between_batches);
        assert!(
            steps.len() > 1,
            "validation must use multiple bounded steps"
        );
        assert_eq!(
            steps.last().map(|step| step.0),
            Some(rusqlite::backup::StepResult::Done)
        );
    }

    #[test]
    fn validation_busy_exhaustion_is_bounded_and_preserves_the_store() {
        let root = TempDir::new().expect("temporary validation root");
        let database = root.path().join("state.sqlite");
        let mut writer = rusqlite::Connection::open(&database).expect("fixture database");
        run_migrations(&mut writer, None).expect("fixture migrations");
        writer
            .execute_batch("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;")
            .expect("hold exclusive source lock");
        let before = persistent_directory_snapshot(root.path());
        let marker = root.path().join("environment-id");

        let started = std::time::Instant::now();
        let error = validate_existing_bibcode_store_with_control(
            &database,
            &CancellationToken::new(),
            std::time::Duration::from_millis(15),
            || Ok(()),
            |_, _| Ok(()),
        )
        .expect_err("exclusive source lock must exhaust the validation bound");

        assert!(matches!(
            error,
            super::ExistingStoreValidationError::Unsafe { .. }
        ));
        assert!(
            error.to_string().contains("deadline"),
            "deadline exhaustion must remain typed and diagnostic: {error}"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_millis(250),
            "test-configured validation bound must not fall back to five seconds"
        );
        assert_eq!(persistent_directory_snapshot(root.path()), before);
        assert!(!marker.exists(), "validation never publishes a marker");
        writer
            .execute_batch("ROLLBACK")
            .expect("release fixture lock");
    }

    #[test]
    fn validation_deadline_interrupts_post_backup_inspection_without_mutation() {
        let root = TempDir::new().expect("temporary validation root");
        let database = root.path().join("state.sqlite");
        let marker = root.path().join("environment-id");
        let marker_bytes = b"b6b9080d-0544-4d79-9904-e265c6c1a8fd\n";
        std::fs::write(&marker, marker_bytes).expect("fixture marker");
        let mut connection = rusqlite::Connection::open(&database).expect("fixture database");
        run_migrations(&mut connection, None).expect("fixture migrations");
        drop(connection);
        let before = persistent_directory_snapshot(root.path());
        let entered_inspection = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let progress_entered = entered_inspection.clone();

        let started = std::time::Instant::now();
        let error = validate_existing_bibcode_store_with_inspection_control(
            &database,
            &CancellationToken::new(),
            std::time::Duration::from_millis(250),
            || Ok(()),
            |_, _| Ok(()),
            move || {
                progress_entered.store(true, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(300));
            },
        )
        .expect_err("post-backup inspection must observe the absolute deadline");

        assert!(entered_inspection.load(std::sync::atomic::Ordering::SeqCst));
        assert!(matches!(
            error,
            super::ExistingStoreValidationError::Unsafe { .. }
        ));
        let error_text = error.to_string();
        assert!(
            error_text.contains("deadline") && error_text.contains("post-backup SQLite inspection"),
            "deadline interruption remains typed and diagnostic: {error}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(persistent_directory_snapshot(root.path()), before);
        assert_eq!(std::fs::read(marker).expect("marker remains"), marker_bytes);
    }

    #[test]
    fn validation_never_materializes_store_bytes_in_global_temp() {
        let root = TempDir::new().expect("temporary validation root");
        let database = root.path().join("state.sqlite");
        let mut connection = rusqlite::Connection::open(&database).expect("fixture database");
        run_migrations(&mut connection, None).expect("fixture migrations");
        drop(connection);
        let artifacts_before = validation_artifacts();

        let error = validate_existing_bibcode_store_with_barrier(
            &database,
            &CancellationToken::new(),
            || {
                if validation_artifacts() != artifacts_before {
                    return Err(super::ExistingStoreValidationError::Unsafe {
                        path: database.clone(),
                        detail: "validation materialized store bytes in global temp".to_owned(),
                    });
                }
                Err(super::ExistingStoreValidationError::Unsafe {
                    path: database.clone(),
                    detail: "forced validation cancellation".to_owned(),
                })
            },
        )
        .expect_err("forced validation cancellation");

        assert!(
            error.to_string().contains("forced validation cancellation"),
            "validation must reach the forced in-memory cancellation seam: {error}"
        );
        assert_eq!(validation_artifacts(), artifacts_before);
    }

    fn persistent_directory_snapshot(path: &std::path::Path) -> Vec<(std::ffi::OsString, Vec<u8>)> {
        let mut entries = std::fs::read_dir(path)
            .expect("snapshot directory")
            .filter_map(|entry| {
                let entry = entry.expect("snapshot entry");
                if entry.file_name().to_string_lossy().ends_with("-shm") {
                    return None;
                }
                let file_type = entry.file_type().expect("snapshot entry type");
                let bytes = if file_type.is_file() {
                    std::fs::read(entry.path()).expect("snapshot entry bytes")
                } else {
                    Vec::new()
                };
                Some((entry.file_name(), bytes))
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        entries
    }

    fn directory_entry_names(path: &std::path::Path) -> Vec<std::ffi::OsString> {
        let mut entries = std::fs::read_dir(path)
            .expect("snapshot directory")
            .map(|entry| entry.expect("snapshot entry").file_name())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    fn validation_artifacts() -> Vec<std::ffi::OsString> {
        let mut entries = std::fs::read_dir(std::env::temp_dir())
            .expect("global temporary directory")
            .filter_map(|entry| {
                let name = entry.ok()?.file_name();
                name.to_string_lossy()
                    .starts_with("bibcode-store-validation-")
                    .then_some(name)
            })
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    fn assert_delivery_schema(connection: &rusqlite::Connection) -> rusqlite::Result<()> {
        let columns = |table: &str| -> rusqlite::Result<Vec<DeliveryColumn>> {
            connection
                .prepare(&format!("PRAGMA table_info({table})"))?
                .query_map([], |row| {
                    Ok((
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })?
                .collect()
        };
        assert_eq!(
            columns("orchestration_command_receipts")?
                .into_iter()
                .find(|column| column.0 == "payload_digest"),
            Some(("payload_digest".to_owned(), "TEXT".to_owned(), 0, None, 0))
        );
        for name in ["delivery_state", "delivery_provider", "delivery_detail"] {
            assert_eq!(
                columns("projection_thread_messages")?
                    .into_iter()
                    .find(|column| column.0 == name),
                Some((name.to_owned(), "TEXT".to_owned(), 0, None, 0))
            );
        }
        assert_eq!(
            columns("provider_turn_outbox")?,
            vec![
                ("command_id".to_owned(), "TEXT".to_owned(), 0, None, 1),
                ("thread_id".to_owned(), "TEXT".to_owned(), 1, None, 0),
                ("message_id".to_owned(), "TEXT".to_owned(), 1, None, 0),
                (
                    "provider_instance_id".to_owned(),
                    "TEXT".to_owned(),
                    1,
                    None,
                    0
                ),
                ("provider_kind".to_owned(), "TEXT".to_owned(), 1, None, 0),
                (
                    "provider_session_id".to_owned(),
                    "TEXT".to_owned(),
                    0,
                    None,
                    0
                ),
                ("delivery_key".to_owned(), "TEXT".to_owned(), 1, None, 0),
                ("payload_json".to_owned(), "TEXT".to_owned(), 1, None, 0),
                ("state".to_owned(), "TEXT".to_owned(), 1, None, 0),
                (
                    "attempts".to_owned(),
                    "INTEGER".to_owned(),
                    1,
                    Some("0".to_owned()),
                    0
                ),
                ("last_error".to_owned(), "TEXT".to_owned(), 0, None, 0),
                ("created_at".to_owned(), "TEXT".to_owned(), 1, None, 0),
                ("updated_at".to_owned(), "TEXT".to_owned(), 1, None, 0),
            ]
        );
        assert_eq!(
            columns("orchestration_attachment_refs")?,
            vec![
                ("command_id".to_owned(), "TEXT".to_owned(), 1, None, 1),
                ("attachment_id".to_owned(), "TEXT".to_owned(), 1, None, 2),
                ("content_digest".to_owned(), "TEXT".to_owned(), 0, None, 0),
                ("size_bytes".to_owned(), "INTEGER".to_owned(), 1, None, 0)
            ]
        );
        for (table, expected_columns) in [
            (
                "provider_turn_outbox",
                vec![
                    "command_id",
                    "thread_id",
                    "message_id",
                    "provider_instance_id",
                    "provider_kind",
                    "provider_session_id",
                    "delivery_key",
                    "payload_json",
                    "state",
                    "attempts",
                    "last_error",
                    "created_at",
                    "updated_at",
                ],
            ),
            (
                "orchestration_attachment_refs",
                vec![
                    "command_id",
                    "attachment_id",
                    "content_digest",
                    "size_bytes",
                ],
            ),
        ] {
            let columns = connection
                .prepare(&format!("PRAGMA table_info({table})"))?
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(columns, expected_columns);
        }
        for table in ["provider_turn_outbox", "orchestration_attachment_refs"] {
            let foreign_keys = connection
                .prepare(&format!("PRAGMA foreign_key_list({table})"))?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                foreign_keys,
                vec![(
                    "orchestration_command_receipts".to_owned(),
                    "command_id".to_owned(),
                    "command_id".to_owned(),
                    "CASCADE".to_owned()
                )]
            );
        }
        for (index, columns, unique) in [
            (
                "idx_provider_turn_outbox_thread_state",
                vec!["thread_id", "state", "created_at", "command_id"],
                0_i64,
            ),
            (
                "idx_provider_turn_outbox_message",
                vec!["message_id"],
                1_i64,
            ),
            (
                "idx_orchestration_attachment_refs_attachment",
                vec!["attachment_id"],
                0_i64,
            ),
        ] {
            let index_meta = connection.query_row(
                &format!(
                    "SELECT name, [unique] FROM pragma_index_list('{}') WHERE name = ?",
                    if index.starts_with("idx_orchestration") {
                        "orchestration_attachment_refs"
                    } else {
                        "provider_turn_outbox"
                    }
                ),
                [index],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?;
            assert_eq!(index_meta, (index.to_owned(), unique));
            let actual = connection
                .prepare(&format!("PRAGMA index_info({index})"))?
                .query_map([], |row| row.get::<_, String>(2))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(actual, columns);
        }
        connection.execute(
            "INSERT OR IGNORE INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status) VALUES ('schema-invalid-command', 'thread', 'thread-1', '2026-08-01T00:00:00Z', 0, 'accepted')",
            [],
        )?;
        assert!(connection.execute(
            "INSERT INTO provider_turn_outbox (command_id, thread_id, message_id, provider_instance_id, provider_kind, delivery_key, payload_json, state, created_at, updated_at) VALUES ('schema-invalid-command', 'thread-1', 'schema-invalid-message', 'codex', 'codex', 'key', '{}', 'not-a-state', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
            [],
        ).is_err());
        Ok(())
    }

    #[test]
    fn exposes_all_ordered_migration_metadata() {
        let ids = MIGRATIONS
            .iter()
            .map(|migration| migration.id)
            .collect::<Vec<_>>();

        assert_eq!(ids, (1..=48).collect::<Vec<_>>());
        assert_eq!(MIGRATIONS[0].name, "OrchestrationEvents");
        assert_eq!(MIGRATIONS[33].name, "ActivityProjection");
        assert_eq!(MIGRATIONS[34].name, "ActivityJournalEventKeyNamespace");
        assert_eq!(MIGRATIONS[35].name, "ActivityEventIdempotencyLedger");
        assert_eq!(MIGRATIONS[36].name, "ActivityEntryRetentionOwners");
        assert_eq!(MIGRATIONS[37].name, "ActivityRecordRetentionCounts");
        assert_eq!(MIGRATIONS[38].name, "DurableProviderTurnDelivery");
        assert_eq!(MIGRATIONS[39].name, "ProjectionProjectWorktreeDiscovery");
        assert_eq!(
            MIGRATIONS[40].name,
            "ProjectionProjectWorktreeRepositoryKey"
        );
        assert_eq!(MIGRATIONS[41].name, "ProjectWorktreeRepositoryPins");
        assert_eq!(MIGRATIONS[42].name, "DurableWorktreeRemovalReceipts");
        assert_eq!(MIGRATIONS[43].name, "ProjectionThreadSessionErrorClass");
        assert_eq!(MIGRATIONS[44].name, "ProjectionThreadUnresolvedDelivery");
        assert_eq!(MIGRATIONS[45].name, "ProjectRepositoryClaims");
        assert_eq!(MIGRATIONS[46].name, "OneActiveMainThread");
        assert_eq!(MIGRATIONS[47].name, "HashedPairingCredentials");

        let migration = Migration::new(99, "RuntimeFixture", migration_001);
        assert_eq!(migration.id, 99);
        assert_eq!(migration.name, "RuntimeFixture");
    }

    #[test]
    fn pairing_hash_migration_preserves_active_grants_without_plaintext() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(47))?;
        let raw_credential = "LEGACYPAIRING";
        connection.execute(
            "INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, label, \
             proof_key_thumbprint, created_at, expires_at, consumed_at, revoked_at) \
             VALUES ('legacy-pairing', ?, 'one-time-token', '[\"access:read\"]', \
             'environment-administrator', 'Legacy laptop', NULL, \
             '2026-08-25T12:00:00Z', '2026-08-25T12:05:00Z', NULL, NULL)",
            [raw_credential],
        )?;

        let applied = run_migrations(&mut connection, None)?;
        assert_eq!(
            applied
                .iter()
                .map(|migration| migration.id)
                .collect::<Vec<_>>(),
            [48]
        );
        let columns = connection
            .prepare("PRAGMA table_info(auth_pairing_links)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(!columns.iter().any(|column| column == "credential"));
        assert!(columns.iter().any(|column| column == "credential_hash"));
        let (hash, fingerprint) = connection.query_row(
            "SELECT credential_hash, credential_fingerprint \
             FROM auth_pairing_links WHERE id = 'legacy-pairing'",
            [],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, String>(1)?)),
        )?;
        assert_eq!(hash, Sha256::digest(raw_credential.as_bytes()).to_vec());
        assert_eq!(
            fingerprint,
            crate::persistence::repositories::pairing_credential_fingerprint(&hash)
        );
        assert!(table_exists(&connection, "auth_pairing_exchange_receipts")?);
        let session_columns = connection
            .prepare("PRAGMA table_info(auth_sessions)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(
            session_columns
                .iter()
                .any(|column| column == "proof_key_thumbprint")
        );
        Ok(())
    }

    #[test]
    fn activity_journal_key_namespace_migration_preserves_legacy_identity_domain()
    -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(34))?;
        connection.execute(
            "INSERT INTO activity_scopes (
               scope_id, source_kind, thread_id, generation_id, provider_name,
               capabilities_json, observation_state, section_health_json, created_at, updated_at
             ) VALUES (
               'scope:legacy', 'thread', 'legacy', 'legacy', 'codex',
               '{}', 'live', '{}', '2026-07-22T12:00:00Z', '2026-07-22T12:00:00Z'
             )",
            [],
        )?;
        connection.execute(
            "INSERT INTO activity_journal (
               scope_id, revision, native_event_key, delta_json, created_at
             ) VALUES ('scope:legacy', 1, 'activity:v2:alias', '{}', '2026-07-22T12:00:00Z')",
            [],
        )?;

        run_migrations(&mut connection, None)?;

        let namespace = connection.query_row(
            "SELECT event_key_namespace FROM activity_journal
             WHERE scope_id = 'scope:legacy' AND revision = 1",
            [],
            |row| row.get::<_, String>(0),
        )?;
        assert_eq!(namespace, "legacy");
        connection.execute(
            "INSERT INTO activity_journal (
               scope_id, revision, event_key_namespace, native_event_key, delta_json, created_at
             ) VALUES (
               'scope:legacy', 2, 'canonical', 'activity:v2:alias', '{}',
               '2026-07-22T12:00:01Z'
             )",
            [],
        )?;
        assert_eq!(
            connection.query_row(
                "SELECT COUNT(*) FROM activity_journal WHERE scope_id = 'scope:legacy'",
                [],
                |row| row.get::<_, i64>(0),
            )?,
            2
        );
        Ok(())
    }

    #[test]
    fn terminal_ownership_lookup_uses_terminal_first_index() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, None)?;

        let plan = connection.query_row(
            "EXPLAIN QUERY PLAN
             SELECT 1 FROM activity_scopes
             WHERE source_kind = 'terminal' AND terminal_id = ?
               AND thread_id <> ? AND is_current = 1
             LIMIT 1",
            rusqlite::params!["terminal:shared", "thread:current"],
            |row| row.get::<_, String>(3),
        )?;

        assert!(
            plan.contains("idx_activity_scopes_current_terminal_owner"),
            "unexpected query plan: {plan}"
        );
        Ok(())
    }

    #[test]
    fn migrates_fresh_database_and_resumes_from_a_cutoff() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;

        let first = run_migrations(&mut connection, Some(16))?;
        assert_eq!(first.len(), 16);
        assert_eq!(first[0].id, 1);
        assert_eq!(first[15].id, 16);

        let second = run_migrations(&mut connection, None)?;
        assert_eq!(second.len(), 32);
        assert_eq!(second[0].id, 17);
        assert_eq!(second[31].id, 48);

        let third = run_migrations(&mut connection, None)?;
        assert!(third.is_empty());

        let application_table_count = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'table' \
               AND name NOT IN ('effect_sql_migrations', 'sqlite_sequence')",
            [],
            |row| row.get::<_, u32>(0),
        )?;
        assert_eq!(application_table_count, 28);
        assert_delivery_schema(&connection)?;

        Ok(())
    }

    #[test]
    fn migration_39_adds_delivery_storage_and_backfills_attachment_references()
    -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(38))?;
        connection.execute(
            "INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status) VALUES ('command-1', 'thread', 'thread-1', '2026-08-01T00:00:00Z', 1, 'accepted')",
            [],
        )?;
        connection.execute(
            "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                "event-1",
                "thread",
                "thread-1",
                1,
                "thread.message-sent",
                "2026-08-01T00:00:00Z",
                "command-1",
                Option::<String>::None,
                "command-1",
                "client",
                r#"{"threadId":"thread-1","messageId":"message-1","role":"user","text":"ship it","attachments":[{"id":"attachment-1","sizeBytes":3}]}"#,
                "{}",
            ],
        )?;

        run_migrations(&mut connection, None)?;

        let table_exists = |table: &str| -> rusqlite::Result<bool> {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
                [table],
                |row| row.get(0),
            )
        };
        let column_exists = |table: &str, column: &str| -> rusqlite::Result<bool> {
            let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(columns.iter().any(|candidate| candidate == column))
        };

        for table in ["provider_turn_outbox", "orchestration_attachment_refs"] {
            assert!(table_exists(table)?);
        }
        assert_delivery_schema(&connection)?;
        assert!(column_exists(
            "orchestration_command_receipts",
            "payload_digest"
        )?);
        for column in ["delivery_state", "delivery_provider", "delivery_detail"] {
            assert!(column_exists("projection_thread_messages", column)?);
        }
        assert!(connection.execute(
            "INSERT INTO provider_turn_outbox (command_id, thread_id, message_id, provider_instance_id, provider_kind, delivery_key, payload_json, state, created_at, updated_at) VALUES ('command-1', 'thread-1', 'invalid-state-message', 'codex', 'codex', 'key', '{}', 'invalid', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
            [],
        ).is_err());
        let reference = connection.query_row(
            "SELECT command_id, attachment_id, content_digest, size_bytes FROM orchestration_attachment_refs",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?)),
        )?;
        assert_eq!(
            reference,
            ("command-1".to_owned(), "attachment-1".to_owned(), None, 3)
        );

        Ok(())
    }

    #[test]
    fn migration_40_adds_the_default_worktree_discovery_policy_to_existing_projects()
    -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(39))?;
        connection.execute(
            "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at) VALUES ('project-1', 'Project', 'C:/repo', NULL, '[]', '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', NULL)",
            [],
        )?;

        let applied = run_migrations(&mut connection, Some(46))?;

        assert_eq!(
            applied
                .iter()
                .map(|migration| migration.id)
                .collect::<Vec<_>>(),
            [40, 41, 42, 43, 44, 45, 46]
        );
        let policy = connection.query_row(
            "SELECT worktree_discovery_json FROM projection_projects WHERE project_id = 'project-1'",
            [],
            |row| row.get::<_, String>(0),
        )?;
        assert_eq!(
            policy,
            r#"{"visibility":"hidden","initialPromptDismissedAt":null,"baselinePaths":[]}"#
        );
        let pin = connection.query_row(
            "SELECT worktree_repository_key FROM projection_projects WHERE project_id = 'project-1'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )?;
        assert_eq!(pin, None);

        Ok(())
    }

    #[test]
    fn migration_41_adds_a_nullable_worktree_repository_identity_pin() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(40))?;
        connection.execute(
            "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, worktree_discovery_json, created_at, updated_at, deleted_at) VALUES ('project-legacy', 'Legacy', '/repo', NULL, '[]', '{}', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z', NULL)",
            [],
        )?;

        let applied = run_migrations(&mut connection, Some(46))?;

        assert_eq!(
            applied
                .iter()
                .map(|migration| migration.id)
                .collect::<Vec<_>>(),
            [41, 42, 43, 44, 45, 46]
        );
        let pin = connection.query_row(
            "SELECT worktree_repository_key FROM projection_projects WHERE project_id = 'project-legacy'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )?;
        assert_eq!(pin, None);
        Ok(())
    }

    #[test]
    fn migration_42_moves_existing_repository_identity_pins_outside_rebuildable_projections()
    -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(41))?;
        connection.execute(
            "INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, worktree_discovery_json, worktree_repository_key, created_at, updated_at, deleted_at) VALUES ('project-pinned', 'Pinned', '/repo', NULL, '[]', '{}', 'repository-key-a', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z', NULL)",
            [],
        )?;

        let applied = run_migrations(&mut connection, Some(46))?;

        assert_eq!(
            applied
                .iter()
                .map(|migration| migration.id)
                .collect::<Vec<_>>(),
            [42, 43, 44, 45, 46]
        );
        let pin = connection.query_row(
            "SELECT repository_key FROM project_worktree_repository_pins WHERE project_id = 'project-pinned'",
            [],
            |row| row.get::<_, String>(0),
        )?;
        assert_eq!(pin, "repository-key-a");
        Ok(())
    }

    #[test]
    fn migration_39_rejects_malformed_legacy_attachment_references() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(38))?;
        connection.execute(
            "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params!["event-bad", "thread", "thread-1", 1, "thread.message-sent", "2026-08-01T00:00:00Z", "command-bad", Option::<String>::None, "command-bad", "client", r#"{"role":"user","attachments":[{"id":"attachment-bad"}]}"#, "{}"],
        )?;

        assert!(run_migrations(&mut connection, None).is_err());
        assert_eq!(
            connection.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'provider_turn_outbox'",
                [],
                |row| row.get::<_, i64>(0),
            )?,
            0
        );
        Ok(())
    }

    #[test]
    fn migration_43_adds_durable_worktree_removal_receipts() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(42))?;
        assert!(!table_exists(&connection, "worktree_removal_receipts")?);

        run_migrations(&mut connection, None)?;

        assert!(table_exists(&connection, "worktree_removal_receipts")?);
        assert!(
            connection
                .execute(
                    "INSERT INTO worktree_removal_receipts (owner_thread_id, project_cwd, worktree_path, identity_nonce, state, created_at, updated_at) \
                     VALUES ('thread-1', 'C:/repo', 'C:/worktree', 'nonce', 'invalid', '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z')",
                    [],
                )
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn migration_47_repairs_a_legacy_main_only_when_canonical_events_prove_it()
    -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(46))?;
        connection.execute_batch(
            r#"
            INSERT INTO projection_projects (
              project_id, title, workspace_root, default_model_selection_json,
              scripts_json, worktree_discovery_json, created_at, updated_at, deleted_at
            ) VALUES (
              'legacy-project', 'Legacy', '/repo', NULL,
              '[]', '{}', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', NULL
            );
            INSERT INTO projection_threads (
              thread_id, project_id, title, created_at, updated_at, kind
            ) VALUES
              ('legacy-main', 'legacy-project', 'Legacy', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', 'default'),
              ('legacy-workspace', 'legacy-project', 'Workspace', '2026-08-24T00:00:01Z', '2026-08-24T00:00:01Z', 'default');
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, actor_kind, payload_json, metadata_json
            ) VALUES
              ('legacy-project-created', 'project', 'legacy-project', 1, 'project.created',
               '2026-08-24T00:00:00Z', 'legacy-create', 'client',
               '{"projectId":"legacy-project"}', '{}'),
              ('legacy-main-created', 'thread', 'legacy-main', 1, 'thread.created',
               '2026-08-24T00:00:00Z', 'legacy-create', 'client',
               '{"threadId":"legacy-main","projectId":"legacy-project"}', '{}'),
              ('legacy-workspace-created', 'thread', 'legacy-workspace', 1, 'thread.created',
               '2026-08-24T00:00:01Z', 'workspace-create', 'client',
               '{"threadId":"legacy-workspace","projectId":"legacy-project"}', '{}');
            "#,
        )?;

        let applied = run_migrations(&mut connection, Some(47))?;

        assert_eq!(
            applied
                .iter()
                .map(|migration| migration.id)
                .collect::<Vec<_>>(),
            [47]
        );
        let kinds = connection
            .prepare(
                "SELECT thread_id, kind FROM projection_threads \
                 WHERE project_id = 'legacy-project' ORDER BY thread_id",
            )?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            kinds,
            [
                ("legacy-main".to_owned(), "default".to_owned()),
                ("legacy-workspace".to_owned(), "workspace".to_owned()),
            ]
        );
        assert!(
            connection
                .execute(
                    "INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, kind) \
                     VALUES ('second-main', 'legacy-project', 'Second', '2026-08-24T00:00:02Z', '2026-08-24T00:00:02Z', 'default')",
                    [],
                )
                .is_err(),
            "the partial index must reject a second active Main"
        );
        Ok(())
    }

    #[test]
    fn migration_47_rejects_ambiguous_main_candidates_with_actionable_ids() -> rusqlite::Result<()>
    {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(46))?;
        connection.execute_batch(
            r#"
            INSERT INTO projection_projects (
              project_id, title, workspace_root, default_model_selection_json,
              scripts_json, worktree_discovery_json, created_at, updated_at, deleted_at
            ) VALUES (
              'ambiguous-project', 'Ambiguous', '/repo', NULL,
              '[]', '{}', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', NULL
            );
            INSERT INTO projection_threads (
              thread_id, project_id, title, created_at, updated_at, kind
            ) VALUES
              ('main-a', 'ambiguous-project', 'A', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', 'default'),
              ('main-b', 'ambiguous-project', 'B', '2026-08-24T00:00:01Z', '2026-08-24T00:00:01Z', 'default');
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, command_id, actor_kind, payload_json, metadata_json
            ) VALUES
              ('main-a-created', 'thread', 'main-a', 1, 'thread.created',
               '2026-08-24T00:00:00Z', 'create-a', 'client',
               '{"threadId":"main-a","projectId":"ambiguous-project","kind":"default"}', '{}'),
              ('main-b-created', 'thread', 'main-b', 1, 'thread.created',
               '2026-08-24T00:00:01Z', 'create-b', 'client',
               '{"threadId":"main-b","projectId":"ambiguous-project","kind":"default"}', '{}');
            "#,
        )?;

        let error = run_migrations(&mut connection, None)
            .expect_err("ambiguous canonical Main candidates must stop migration");
        let detail = error.to_string();
        assert!(detail.contains("ambiguous-project"), "{detail}");
        assert!(detail.contains("main-a"), "{detail}");
        assert!(detail.contains("main-b"), "{detail}");
        assert_eq!(
            connection.query_row(
                "SELECT MAX(migration_id) FROM effect_sql_migrations",
                [],
                |row| row.get::<_, u32>(0),
            )?,
            46,
            "the migration body and ledger entry must roll back together"
        );
        Ok(())
    }

    #[test]
    fn trusts_an_existing_current_effect_ledger_without_rebuilding_data() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        connection.execute_batch(
            "CREATE TABLE effect_sql_migrations (\
               migration_id integer PRIMARY KEY NOT NULL,\
               created_at datetime NOT NULL DEFAULT current_timestamp,\
               name VARCHAR(255) NOT NULL\
             );\
             INSERT INTO effect_sql_migrations (migration_id, name)\
             VALUES (33, 'ProjectionThreadsKind');\
             CREATE TABLE legacy_user_data (value TEXT NOT NULL);\
             INSERT INTO legacy_user_data (value) VALUES ('keep-me');",
        )?;

        let applied = run_migrations(&mut connection, None)?;
        assert_eq!(
            applied
                .iter()
                .map(|migration| migration.id)
                .collect::<Vec<_>>(),
            (34..=48).collect::<Vec<_>>()
        );
        let value = connection.query_row("SELECT value FROM legacy_user_data", [], |row| {
            row.get::<_, String>(0)
        })?;
        assert_eq!(value, "keep-me");

        Ok(())
    }

    #[test]
    fn rolls_back_ledger_and_schema_when_a_migration_fails() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(4))?;
        connection.execute_batch("CREATE TABLE projection_projects (dummy TEXT)")?;

        assert!(run_migrations(&mut connection, Some(5)).is_err());

        let latest = connection.query_row(
            "SELECT MAX(migration_id) FROM effect_sql_migrations",
            [],
            |row| row.get::<_, u32>(0),
        )?;
        assert_eq!(latest, 4);

        let created_during_failed_migration = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'table' AND name = 'projection_threads'",
            [],
            |row| row.get::<_, u32>(0),
        )?;
        assert_eq!(created_during_failed_migration, 0);

        Ok(())
    }

    #[test]
    fn canonicalizes_legacy_model_options_in_text_json() -> rusqlite::Result<()> {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(25))?;
        connection.execute(
            "INSERT INTO projection_threads (\
               thread_id, project_id, title, branch, worktree_path, latest_turn_id,\
               created_at, updated_at, deleted_at, runtime_mode, interaction_mode,\
               archived_at, model_selection_json\
             ) VALUES (\
               'thread-1', 'project-1', 'Thread', NULL, NULL, NULL,\
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,\
               'full-access', 'default', NULL,\
               '{\"provider\":\"codex\",\"model\":\"gpt-5.4\",\"options\":{\"effort\":\"max\",\"fastMode\":false,\"empty\":\"  \",\"count\":2}}'\
             )",
            [],
        )?;

        run_migrations(&mut connection, Some(26))?;

        let selection = connection.query_row(
            "SELECT model_selection_json FROM projection_threads WHERE thread_id = 'thread-1'",
            [],
            |row| row.get::<_, String>(0),
        )?;
        let selection: serde_json::Value = serde_json::from_str(&selection).unwrap();
        assert_eq!(
            selection["options"],
            serde_json::json!([
                { "id": "effort", "value": "max" },
                { "id": "fastMode", "value": false }
            ])
        );

        Ok(())
    }

    #[test]
    fn migration_31_invalidates_role_credentials_and_installs_scope_columns() -> rusqlite::Result<()>
    {
        let mut connection = rusqlite::Connection::open_in_memory()?;
        run_migrations(&mut connection, Some(30))?;
        connection.execute(
            "INSERT INTO auth_sessions (\
               session_id, subject, role, method, issued_at, expires_at\
             ) VALUES ('session-1', 'subject-1', 'admin', 'pairing',\
               '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
            [],
        )?;

        run_migrations(&mut connection, Some(31))?;

        let session_count =
            connection.query_row("SELECT COUNT(*) FROM auth_sessions", [], |row| {
                row.get::<_, u32>(0)
            })?;
        assert_eq!(session_count, 0);

        let columns = connection
            .prepare("PRAGMA table_info(auth_sessions)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(columns.iter().any(|column| column == "scopes"));
        assert!(!columns.iter().any(|column| column == "role"));

        Ok(())
    }
}
