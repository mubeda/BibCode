use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

use rusqlite::{Connection, MAIN_DB, OpenFlags};
use thiserror::Error;
use tokio::sync::{Notify, mpsc, oneshot};

const DATABASE_QUEUE_CAPACITY: usize = 64;
const PREPARED_STATEMENT_CACHE_CAPACITY: usize = 64;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const WAL_AUTOCHECKPOINT_PAGES: u32 = 1_000;
const JOURNAL_SIZE_LIMIT_BYTES: i64 = 64 * 1024 * 1024;

type DatabaseJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Clone)]
pub(crate) struct CommitFence {
    acquire: Arc<dyn Fn() -> std::result::Result<Box<dyn Send + 'static>, ()> + Send + Sync>,
}

pub(crate) struct CommitPermit {
    _resource: Box<dyn Send + 'static>,
}

impl CommitFence {
    pub(crate) fn new(
        acquire: impl Fn() -> std::result::Result<Box<dyn Send + 'static>, ()> + Send + Sync + 'static,
    ) -> Self {
        Self {
            acquire: Arc::new(acquire),
        }
    }

    pub(crate) fn acquire(&self) -> Result<CommitPermit> {
        (self.acquire)()
            .map(|resource| CommitPermit {
                _resource: resource,
            })
            .map_err(|()| PersistenceError::CommitRejected)
    }
}

/// Snapshot of the SQLite sender state for black-box queue-bound integration tests.
///
/// This stays dormant unless explicitly enabled through [`Database`]'s doc-hidden test
/// diagnostic, so normal calls pay only one relaxed atomic read.
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DatabaseQueueSnapshotForIntegrationTest {
    pub observation_enabled: bool,
    pub queue_capacity: usize,
    pub reserved_or_queued_jobs: usize,
    pub waiting_for_permit: usize,
    pub max_reserved_or_queued_jobs: usize,
    observer_generation: usize,
}

#[derive(Debug, Default)]
struct DatabaseQueueObservationState {
    observer_generation: usize,
    reserved_or_queued_jobs: usize,
    waiting_for_permit: usize,
    max_reserved_or_queued_jobs: usize,
}

#[derive(Debug)]
struct DatabaseQueueDiagnostics {
    active_observer_generation: AtomicUsize,
    state: Mutex<DatabaseQueueObservationState>,
    changed: Notify,
}

impl DatabaseQueueDiagnostics {
    fn new() -> Self {
        Self {
            active_observer_generation: AtomicUsize::new(0),
            state: Mutex::new(DatabaseQueueObservationState::default()),
            changed: Notify::new(),
        }
    }

    fn enable(self: &Arc<Self>) -> Option<DatabaseQueueObserverForIntegrationTest> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.active_observer_generation.load(Ordering::Acquire) != 0 {
            return None;
        }
        state.observer_generation = state
            .observer_generation
            .checked_add(1)
            .expect("database queue observer generation exhausted");
        state.reserved_or_queued_jobs = 0;
        state.waiting_for_permit = 0;
        state.max_reserved_or_queued_jobs = 0;
        let observer_generation = state.observer_generation;
        self.active_observer_generation
            .store(observer_generation, Ordering::Release);
        drop(state);
        self.changed.notify_waiters();
        Some(DatabaseQueueObserverForIntegrationTest {
            diagnostics: Arc::clone(self),
            observer_generation,
        })
    }

    fn disable(&self, observer_generation: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.active_observer_generation.load(Ordering::Acquire) != observer_generation
            || state.observer_generation != observer_generation
        {
            return;
        }
        self.active_observer_generation.store(0, Ordering::Release);
        state.reserved_or_queued_jobs = 0;
        state.waiting_for_permit = 0;
        state.max_reserved_or_queued_jobs = 0;
        drop(state);
        self.changed.notify_waiters();
    }

    fn begin_reservation(self: &Arc<Self>) -> Option<QueueReservationObservation> {
        let observer_generation = self.active_observer_generation.load(Ordering::Relaxed);
        self.begin_reservation_for_generation(observer_generation)
    }

    fn begin_reservation_for_generation(
        self: &Arc<Self>,
        observer_generation: usize,
    ) -> Option<QueueReservationObservation> {
        if observer_generation == 0 {
            return None;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.active_observer_generation.load(Ordering::Acquire) != observer_generation
            || state.observer_generation != observer_generation
        {
            return None;
        }
        state.waiting_for_permit += 1;
        drop(state);
        self.changed.notify_waiters();
        Some(QueueReservationObservation {
            diagnostics: Arc::clone(self),
            observer_generation,
            waiting_for_permit: true,
        })
    }

    fn reservation_permit_acquired(&self, observer_generation: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.is_current_observer(&state, observer_generation) {
            return;
        }
        let Some(waiting_for_permit) = state.waiting_for_permit.checked_sub(1) else {
            return;
        };
        state.waiting_for_permit = waiting_for_permit;
        state.reserved_or_queued_jobs += 1;
        state.max_reserved_or_queued_jobs = state
            .max_reserved_or_queued_jobs
            .max(state.reserved_or_queued_jobs);
        drop(state);
        self.changed.notify_waiters();
    }

    fn reservation_abandoned(&self, observer_generation: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.is_current_observer(&state, observer_generation) {
            return;
        }
        let Some(waiting_for_permit) = state.waiting_for_permit.checked_sub(1) else {
            return;
        };
        state.waiting_for_permit = waiting_for_permit;
        drop(state);
        self.changed.notify_waiters();
    }

    fn job_started(&self, observer_generation: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.is_current_observer(&state, observer_generation) {
            return;
        }
        let Some(reserved_or_queued_jobs) = state.reserved_or_queued_jobs.checked_sub(1) else {
            return;
        };
        state.reserved_or_queued_jobs = reserved_or_queued_jobs;
        drop(state);
        self.changed.notify_waiters();
    }

    fn snapshot(&self) -> DatabaseQueueSnapshotForIntegrationTest {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let active_observer_generation = self.active_observer_generation.load(Ordering::Acquire);
        DatabaseQueueSnapshotForIntegrationTest {
            observation_enabled: active_observer_generation != 0,
            queue_capacity: DATABASE_QUEUE_CAPACITY,
            reserved_or_queued_jobs: state.reserved_or_queued_jobs,
            waiting_for_permit: state.waiting_for_permit,
            max_reserved_or_queued_jobs: state.max_reserved_or_queued_jobs,
            observer_generation: state.observer_generation,
        }
    }

    fn is_current_observer(
        &self,
        state: &DatabaseQueueObservationState,
        observer_generation: usize,
    ) -> bool {
        self.active_observer_generation.load(Ordering::Acquire) == observer_generation
            && state.observer_generation == observer_generation
    }
}

/// Owns one exclusive queue-backpressure observation scope for a [`Database`].
#[doc(hidden)]
#[derive(Debug)]
pub struct DatabaseQueueObserverForIntegrationTest {
    diagnostics: Arc<DatabaseQueueDiagnostics>,
    observer_generation: usize,
}

impl Drop for DatabaseQueueObserverForIntegrationTest {
    fn drop(&mut self) {
        self.diagnostics.disable(self.observer_generation);
    }
}

impl DatabaseQueueObserverForIntegrationTest {
    /// Waits until this observation generation reaches the requested bounded-backpressure state.
    #[doc(hidden)]
    pub fn wait_for_queue_backpressure_for_integration_test(
        &self,
        expected_jobs: usize,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Option<DatabaseQueueSnapshotForIntegrationTest>>
                + Send
                + 'static,
        >,
    > {
        assert!(
            expected_jobs > DATABASE_QUEUE_CAPACITY,
            "backpressure requires more jobs than the sender capacity"
        );
        let diagnostics = Arc::clone(&self.diagnostics);
        let observer_generation = self.observer_generation;
        Box::pin(async move {
            loop {
                let notified = diagnostics.changed.notified();
                let snapshot = diagnostics.snapshot();
                if !snapshot.observation_enabled
                    || snapshot.observer_generation != observer_generation
                {
                    return None;
                }
                if snapshot.reserved_or_queued_jobs == DATABASE_QUEUE_CAPACITY
                    && snapshot.waiting_for_permit == expected_jobs - DATABASE_QUEUE_CAPACITY
                {
                    return Some(snapshot);
                }
                notified.await;
            }
        })
    }
}

#[derive(Debug)]
struct QueueReservationObservation {
    diagnostics: Arc<DatabaseQueueDiagnostics>,
    observer_generation: usize,
    waiting_for_permit: bool,
}

impl QueueReservationObservation {
    fn permit_acquired(&mut self) {
        debug_assert!(self.waiting_for_permit);
        self.waiting_for_permit = false;
        self.diagnostics
            .reservation_permit_acquired(self.observer_generation);
    }

    fn diagnostics(&self) -> (Arc<DatabaseQueueDiagnostics>, usize) {
        (Arc::clone(&self.diagnostics), self.observer_generation)
    }
}

impl Drop for QueueReservationObservation {
    fn drop(&mut self) {
        if self.waiting_for_permit {
            self.diagnostics
                .reservation_abandoned(self.observer_generation);
        }
    }
}

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("failed to spawn the SQLite worker thread")]
    SpawnWorker(#[source] std::io::Error),
    #[error("failed to create SQLite database directory {path}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open SQLite database {path}")]
    Open {
        path: PathBuf,
        #[source]
        source: rusqlite::Error,
    },
    #[error("failed to configure SQLite database")]
    Configure(#[source] rusqlite::Error),
    #[error("SQLite operation failed")]
    Sql(#[from] rusqlite::Error),
    #[error("SQLite integrity check failed: {0}")]
    Corrupt(String),
    #[error("transaction commit was rejected by its finalization fence")]
    CommitRejected,
    #[error("the SQLite worker is no longer available")]
    WorkerUnavailable,
    #[error("the SQLite worker dropped an operation response")]
    ResponseDropped,
}

pub type Result<T> = std::result::Result<T, PersistenceError>;

#[derive(Clone, Debug)]
pub struct Database {
    sender: mpsc::Sender<DatabaseJob>,
    queue_diagnostics: Arc<DatabaseQueueDiagnostics>,
}

impl Database {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_inner(Some(path.as_ref().to_path_buf())).await
    }

    pub async fn open_in_memory() -> Result<Self> {
        Self::open_inner(None).await
    }

    async fn open_inner(path: Option<PathBuf>) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel::<DatabaseJob>(DATABASE_QUEUE_CAPACITY);
        let queue_diagnostics = Arc::new(DatabaseQueueDiagnostics::new());
        let (ready_sender, ready_receiver) = oneshot::channel();
        thread::Builder::new()
            .name("bibcode-sqlite".to_owned())
            .spawn(move || {
                let connection = open_connection(path.as_deref());
                match connection {
                    Ok(mut connection) => {
                        if ready_sender.send(Ok(())).is_err() {
                            return;
                        }
                        while let Some(job) = receiver.blocking_recv() {
                            job(&mut connection);
                        }
                    }
                    Err(error) => {
                        let _ = ready_sender.send(Err(error));
                    }
                }
            })
            .map_err(PersistenceError::SpawnWorker)?;

        ready_receiver
            .await
            .map_err(|_| PersistenceError::WorkerUnavailable)??;
        Ok(Self {
            sender,
            queue_diagnostics,
        })
    }

    pub async fn call<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let (response_sender, response_receiver) = oneshot::channel();
        let mut queue_reservation = self.queue_diagnostics.begin_reservation();
        let permit = match self.sender.reserve().await {
            Ok(permit) => {
                if let Some(observation) = &mut queue_reservation {
                    observation.permit_acquired();
                }
                permit
            }
            Err(_) => return Err(PersistenceError::WorkerUnavailable),
        };
        let queue_diagnostics = queue_reservation
            .as_ref()
            .map(QueueReservationObservation::diagnostics);
        permit.send(Box::new(move |connection| {
            if let Some((queue_diagnostics, observer_generation)) = queue_diagnostics {
                queue_diagnostics.job_started(observer_generation);
            }
            let _ = response_sender.send(operation(connection));
        }));
        response_receiver
            .await
            .map_err(|_| PersistenceError::ResponseDropped)?
    }

    /// Enables a dormant sender-boundary diagnostic for black-box integration tests.
    ///
    /// Normal database calls do not update the counters. Once enabled, a call is measured from
    /// `Sender::reserve()` through the point the SQLite worker starts its queued job.
    #[doc(hidden)]
    pub fn enable_queue_backpressure_observation_for_integration_test(
        &self,
    ) -> Option<DatabaseQueueObserverForIntegrationTest> {
        self.queue_diagnostics.enable()
    }

    /// Returns the current queue diagnostic state, including disabled/reset state after guard drop.
    #[doc(hidden)]
    pub fn queue_backpressure_snapshot_for_integration_test(
        &self,
    ) -> DatabaseQueueSnapshotForIntegrationTest {
        self.queue_diagnostics.snapshot()
    }

    pub async fn backup_to(&self, destination: impl AsRef<Path>) -> Result<()> {
        let destination = destination.as_ref().to_path_buf();
        self.call(move |connection| {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|source| {
                    PersistenceError::CreateDirectory {
                        path: parent.to_path_buf(),
                        source,
                    }
                })?;
            }
            connection.backup(MAIN_DB, destination, None)?;
            Ok(())
        })
        .await
    }

    pub async fn quick_check(&self) -> Result<()> {
        self.call(|connection| {
            let result =
                connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))?;
            if result == "ok" {
                Ok(())
            } else {
                Err(PersistenceError::Corrupt(result))
            }
        })
        .await
    }
}

fn open_connection(path: Option<&Path>) -> Result<Connection> {
    let connection = match path {
        Some(path) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|source| {
                    PersistenceError::CreateDirectory {
                        path: parent.to_path_buf(),
                        source,
                    }
                })?;
            }
            Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|source| PersistenceError::Open {
                path: path.to_path_buf(),
                source,
            })?
        }
        None => Connection::open_in_memory().map_err(|source| PersistenceError::Open {
            path: PathBuf::from(":memory:"),
            source,
        })?,
    };

    connection.set_prepared_statement_cache_capacity(PREPARED_STATEMENT_CACHE_CAPACITY);
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(PersistenceError::Configure)?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(PersistenceError::Configure)?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(PersistenceError::Configure)?;
    if path.is_some() {
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(PersistenceError::Configure)?;
        connection
            .pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES)
            .map_err(PersistenceError::Configure)?;
        connection
            .pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT_BYTES)
            .map_err(PersistenceError::Configure)?;
    }
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn queue_backpressure_observation_is_exclusive_and_scoped_to_its_guard() {
        let database = Database::open_in_memory().await.expect("database opens");
        let initial = database.queue_backpressure_snapshot_for_integration_test();
        assert!(!initial.observation_enabled);
        assert_eq!(initial.reserved_or_queued_jobs, 0);
        assert_eq!(initial.waiting_for_permit, 0);
        assert_eq!(initial.max_reserved_or_queued_jobs, 0);

        let observer = database
            .enable_queue_backpressure_observation_for_integration_test()
            .expect("first observer");
        assert!(
            database
                .enable_queue_backpressure_observation_for_integration_test()
                .is_none(),
            "overlapping observers must be rejected"
        );
        assert!(
            database
                .queue_backpressure_snapshot_for_integration_test()
                .observation_enabled
        );
        let stale_gate_generation = database
            .queue_backpressure_snapshot_for_integration_test()
            .observer_generation;

        let mut stale_reservation = database
            .queue_diagnostics
            .begin_reservation()
            .expect("reservation observed by the first generation");
        let notified_waiter = tokio::spawn(
            observer.wait_for_queue_backpressure_for_integration_test(DATABASE_QUEUE_CAPACITY + 1),
        );
        tokio::task::yield_now().await;
        assert!(!notified_waiter.is_finished());
        let stale_waiter =
            observer.wait_for_queue_backpressure_for_integration_test(DATABASE_QUEUE_CAPACITY + 1);
        drop(observer);
        let replacement_observer = database
            .enable_queue_backpressure_observation_for_integration_test()
            .expect("replacement observer");
        let mut replacement_reservation = database
            .queue_diagnostics
            .begin_reservation()
            .expect("reservation observed by the replacement generation");
        assert!(
            database
                .queue_diagnostics
                .begin_reservation_for_generation(stale_gate_generation)
                .is_none(),
            "a call admitted by the old generation must not attach to its replacement"
        );
        stale_reservation.permit_acquired();
        let replacement_waiting = database.queue_backpressure_snapshot_for_integration_test();
        assert_eq!(replacement_waiting.waiting_for_permit, 1);
        assert_eq!(replacement_waiting.reserved_or_queued_jobs, 0);
        replacement_reservation.permit_acquired();
        let (stale_diagnostics, stale_generation) = stale_reservation.diagnostics();
        stale_diagnostics.job_started(stale_generation);
        let replacement_reserved = database.queue_backpressure_snapshot_for_integration_test();
        assert_eq!(replacement_reserved.waiting_for_permit, 0);
        assert_eq!(replacement_reserved.reserved_or_queued_jobs, 1);
        let (replacement_diagnostics, replacement_generation) =
            replacement_reservation.diagnostics();
        replacement_diagnostics.job_started(replacement_generation);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), stale_waiter)
                .await
                .expect("observer waiter must drain")
                .is_none(),
            "closing the observer must release diagnostic waiters without attaching them to a replacement observer"
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(1), notified_waiter)
                .await
                .expect("notified observer waiter must drain")
                .expect("notified observer waiter task")
                .is_none(),
            "closing the observer must notify waiters that were already pending"
        );
        drop(replacement_observer);
        let drained = database.queue_backpressure_snapshot_for_integration_test();
        assert!(!drained.observation_enabled);
        assert_eq!(drained.reserved_or_queued_jobs, 0);
        assert_eq!(drained.waiting_for_permit, 0);
        assert_eq!(drained.max_reserved_or_queued_jobs, 0);
        assert!(
            database
                .enable_queue_backpressure_observation_for_integration_test()
                .is_some(),
            "a new observer may start after the prior guard is dropped"
        );
    }

    #[tokio::test]
    async fn serializes_concurrent_writers_and_enables_durable_pragmas() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("state.sqlite");
        let database = Database::open(&database_path)
            .await
            .expect("database opens");
        database
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);\
                     INSERT INTO counters (id, value) VALUES (1, 0);",
                )?;
                Ok(())
            })
            .await
            .expect("fixture schema");

        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..32 {
            let database = database.clone();
            tasks.spawn(async move {
                database
                    .call(|connection| {
                        connection
                            .execute("UPDATE counters SET value = value + 1 WHERE id = 1", [])?;
                        Ok(())
                    })
                    .await
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.expect("writer task").expect("writer succeeds");
        }

        let (value, foreign_keys, journal_mode, synchronous) = database
            .call(|connection| {
                Ok((
                    connection.query_row("SELECT value FROM counters WHERE id = 1", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    connection.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))?,
                    connection
                        .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))?,
                    connection.query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))?,
                ))
            })
            .await
            .expect("database snapshot");
        assert_eq!(value, 32);
        assert_eq!(foreign_keys, 1);
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(synchronous, 2, "SQLite durability must remain FULL");
    }

    #[tokio::test]
    async fn rejects_corrupt_database_files_without_replacing_them() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("state.sqlite");
        std::fs::write(&database_path, b"not a sqlite database").expect("corrupt fixture");

        let error = Database::open(&database_path)
            .await
            .expect_err("corrupt database must fail");

        assert!(matches!(
            error,
            PersistenceError::Configure(_) | PersistenceError::Open { .. }
        ));
        assert_eq!(
            std::fs::read(&database_path).expect("corrupt fixture remains"),
            b"not a sqlite database"
        );
    }

    #[tokio::test]
    async fn backup_and_reopen_preserve_committed_data() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("state.sqlite");
        let backup_path = temp.path().join("backups/state.sqlite");
        let database = Database::open(&database_path)
            .await
            .expect("database opens");
        database
            .call(|connection| {
                connection.execute_batch(
                    "CREATE TABLE durable (id TEXT PRIMARY KEY, value TEXT NOT NULL);\
                     INSERT INTO durable (id, value) VALUES ('fixture', 'preserved');",
                )?;
                Ok(())
            })
            .await
            .expect("durable fixture");
        database.quick_check().await.expect("source is healthy");
        database
            .backup_to(&backup_path)
            .await
            .expect("online backup");
        drop(database);

        let reopened = Database::open(&backup_path).await.expect("backup reopens");
        let value = reopened
            .call(|connection| {
                Ok(connection.query_row(
                    "SELECT value FROM durable WHERE id = 'fixture'",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .await
            .expect("backup query");
        assert_eq!(value, "preserved");
    }
}
