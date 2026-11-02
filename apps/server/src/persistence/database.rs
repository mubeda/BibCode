use std::{
    ffi::OsString,
    fs::File as StdFile,
    fs::OpenOptions as StdOpenOptions,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use rusqlite::{
    Connection, ErrorCode, MAIN_DB, OpenFlags,
    backup::{Backup, StepResult},
    config::DbConfig,
};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const DATABASE_QUEUE_CAPACITY: usize = 64;
const PREPARED_STATEMENT_CACHE_CAPACITY: usize = 64;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const WAL_AUTOCHECKPOINT_PAGES: u32 = 1_000;
const JOURNAL_SIZE_LIMIT_BYTES: i64 = 64 * 1024 * 1024;
const VACUUM_PROGRESS_OPS: i32 = 1_000;

/// SQLite's `auto_vacuum` mode as `PRAGMA auto_vacuum` reports it.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutoVacuumMode {
    None,
    Full,
    Incremental,
}

/// Header-level space numbers of one database. Reading them does not grow with its size.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageStats {
    pub page_size: u64,
    pub page_count: u64,
    pub freelist_count: u64,
    pub auto_vacuum: AutoVacuumMode,
}

pub(crate) fn page_stats(connection: &Connection) -> rusqlite::Result<PageStats> {
    let read = |pragma: &str| {
        connection
            .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get::<_, i64>(0))
            .map(|value| u64::try_from(value).unwrap_or(0))
    };
    Ok(PageStats {
        page_size: read("page_size")?,
        page_count: read("page_count")?,
        freelist_count: read("freelist_count")?,
        auto_vacuum: match read("auto_vacuum")? {
            1 => AutoVacuumMode::Full,
            2 => AutoVacuumMode::Incremental,
            _ => AutoVacuumMode::None,
        },
    })
}

/// Opens `path` as `immutable=1`, which takes no SQLite locks and never creates sidecars.
/// Callers must know that no other process can change the file meanwhile.
pub(crate) fn open_immutable(path: &Path) -> rusqlite::Result<Connection> {
    let mut uri = url::Url::from_file_path(path)
        .map_err(|()| rusqlite::Error::InvalidPath(path.to_path_buf()))?;
    uri.query_pairs_mut().append_pair("immutable", "1");
    Connection::open_with_flags(
        uri.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )
}

pub(crate) fn read_page_stats_immutable(path: &Path) -> rusqlite::Result<PageStats> {
    page_stats(&open_immutable(path)?)
}

/// How a compaction's `VACUUM` ended.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum VacuumOutcome {
    Completed,
    Cancelled,
}

type DatabaseJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

enum DatabaseMessage {
    Execute(DatabaseJob),
    Shutdown,
}

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
    #[error("failed to reserve new SQLite database path {path}")]
    Reserve {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to publish new SQLite database at {path}")]
    Publish {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("new SQLite database path {path} no longer names the staged database")]
    OwnershipChanged { path: PathBuf },
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
    #[error("command receipt ownership changed before finalization ({0})")]
    CommandReceiptConflict(String),
    #[error("pairing offer principal capacity exceeded")]
    PairingOfferPrincipalCapacityExceeded,
    #[error("pairing offer idempotency capacity exceeded")]
    PairingOfferGlobalCapacityExceeded,
    #[error("SQLite online backup {0}")]
    BackupStopped(String),
    #[error("the SQLite worker is no longer available")]
    WorkerUnavailable,
    #[error("the SQLite worker dropped an operation response")]
    ResponseDropped,
}

pub type Result<T> = std::result::Result<T, PersistenceError>;

#[derive(Clone, Debug)]
pub struct Database {
    sender: mpsc::Sender<DatabaseMessage>,
    closing: Arc<AtomicBool>,
    queue_diagnostics: Arc<DatabaseQueueDiagnostics>,
    worker_closed: watch::Receiver<bool>,
}

impl Database {
    pub async fn open_existing(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_inner(Some(path.as_ref().to_path_buf())).await
    }

    pub(crate) async fn open_existing_read_only(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_inner_with_identity(Some(path.as_ref().to_path_buf()), None, true, false).await
    }

    /// Opens one writable connection that holds `path` exclusively for offline maintenance.
    ///
    /// Nothing is written before the caller writes: `busy_timeout` is zero and
    /// `locking_mode = EXCLUSIVE` is set before the first access, so SQLite keeps the WAL index
    /// in heap memory (no `-shm`), and the `BEGIN EXCLUSIVE; COMMIT` probe fails at once with
    /// `SQLITE_BUSY` while another connection has the database open. The journal mode is not
    /// changed. When a `-wal` already existed, closing never checkpoints or deletes it until
    /// the caller clears `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE`; a `-wal` this open creates is
    /// empty and SQLite's normal close deletes it.
    pub(crate) async fn open_for_maintenance(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        Self::spawn_worker(move || open_maintenance_connection(&path)).await
    }

    pub async fn create_new(path: impl AsRef<Path>) -> Result<Self> {
        Self::create_new_inner(path.as_ref(), |_| Ok(())).await
    }

    #[cfg(test)]
    async fn create_new_with_before_reopen<F>(
        path: impl AsRef<Path>,
        before_reopen: F,
    ) -> Result<Self>
    where
        F: FnOnce(&Path) -> std::io::Result<()>,
    {
        Self::create_new_inner(path.as_ref(), before_reopen).await
    }

    async fn create_new_inner<F>(path: &Path, before_reopen: F) -> Result<Self>
    where
        F: FnOnce(&Path) -> std::io::Result<()>,
    {
        let path = path.to_path_buf();
        let staging_path = new_database_staging_path(&path);
        let reservation = OwnedPathReservation::create(&staging_path).map_err(|source| {
            PersistenceError::Reserve {
                path: path.clone(),
                source,
            }
        })?;
        let staged_database = match Self::open_inner_with_identity(
            Some(staging_path.clone()),
            Some(reservation.identity),
            false,
            true,
        )
        .await
        {
            Ok(database) => database,
            Err(error) => {
                reservation.cleanup();
                return Err(error);
            }
        };
        staged_database.close().await;
        if !reservation.owns_path(&staging_path) {
            reservation.cleanup();
            return Err(PersistenceError::OwnershipChanged { path });
        }
        if sqlite_sidecar_exists(&staging_path) {
            reservation.cleanup();
            return Err(PersistenceError::Publish {
                path,
                source: std::io::Error::other(
                    "staged SQLite database retained a journal sidecar after close",
                ),
            });
        }

        if let Err(source) = std::fs::hard_link(&staging_path, &path) {
            reservation.cleanup();
            return Err(if source.kind() == std::io::ErrorKind::AlreadyExists {
                PersistenceError::Reserve { path, source }
            } else {
                PersistenceError::Publish { path, source }
            });
        }
        if !reservation.owns_path(&path) {
            reservation.cleanup();
            return Err(PersistenceError::OwnershipChanged { path });
        }
        if let Err(source) = before_reopen(&path) {
            remove_path_if_owned(&path, reservation.identity);
            reservation.cleanup();
            return Err(PersistenceError::Publish { path, source });
        }
        if !reservation.owns_path(&path) {
            reservation.cleanup();
            return Err(PersistenceError::OwnershipChanged { path });
        }

        match Self::open_inner_with_identity(
            Some(path.clone()),
            Some(reservation.identity),
            false,
            false,
        )
        .await
        {
            Ok(database) => {
                reservation.cleanup();
                Ok(database)
            }
            Err(error) => {
                remove_path_if_owned(&path, reservation.identity);
                reservation.cleanup();
                Err(error)
            }
        }
    }

    pub async fn open_in_memory() -> Result<Self> {
        Self::open_inner(None).await
    }

    async fn open_inner(path: Option<PathBuf>) -> Result<Self> {
        Self::open_inner_with_identity(path, None, false, false).await
    }

    async fn open_inner_with_identity(
        path: Option<PathBuf>,
        expected_identity: Option<FileIdentity>,
        read_only: bool,
        create_new: bool,
    ) -> Result<Self> {
        Self::spawn_worker(move || {
            open_connection(path.as_deref(), expected_identity, read_only, create_new)
        })
        .await
    }

    async fn spawn_worker<O>(open: O) -> Result<Self>
    where
        O: FnOnce() -> Result<Connection> + Send + 'static,
    {
        let (sender, mut receiver) = mpsc::channel::<DatabaseMessage>(DATABASE_QUEUE_CAPACITY);
        let closing = Arc::new(AtomicBool::new(false));
        let queue_diagnostics = Arc::new(DatabaseQueueDiagnostics::new());
        let (ready_sender, ready_receiver) = oneshot::channel();
        let (worker_closed_sender, worker_closed) = watch::channel(false);
        thread::Builder::new()
            .name("bibcode-sqlite".to_owned())
            .spawn(move || {
                match open() {
                    Ok(mut connection) => {
                        if ready_sender.send(Ok(())).is_ok() {
                            while let Some(message) = receiver.blocking_recv() {
                                match message {
                                    DatabaseMessage::Execute(job) => job(&mut connection),
                                    DatabaseMessage::Shutdown => break,
                                }
                            }
                        }
                    }
                    Err(error) => {
                        let _ = ready_sender.send(Err(error));
                    }
                }
                let _ = worker_closed_sender.send(true);
            })
            .map_err(PersistenceError::SpawnWorker)?;

        ready_receiver
            .await
            .map_err(|_| PersistenceError::WorkerUnavailable)??;
        Ok(Self {
            sender,
            closing,
            queue_diagnostics,
            worker_closed,
        })
    }

    pub(crate) async fn close(self) {
        let Self {
            sender,
            closing,
            queue_diagnostics: _,
            mut worker_closed,
        } = self;
        if !closing.swap(true, Ordering::AcqRel) {
            let _ = sender.send(DatabaseMessage::Shutdown).await;
        }
        drop(sender);
        let already_closed = *worker_closed.borrow();
        if !already_closed {
            let _ = worker_closed.changed().await;
        }
    }

    pub async fn call<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        if self.closing.load(Ordering::Acquire) {
            return Err(PersistenceError::WorkerUnavailable);
        }
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
        if self.closing.load(Ordering::Acquire) {
            drop(permit);
            return Err(PersistenceError::WorkerUnavailable);
        }
        let queue_diagnostics = queue_reservation
            .as_ref()
            .map(QueueReservationObservation::diagnostics);
        permit.send(DatabaseMessage::Execute(Box::new(move |connection| {
            if let Some((queue_diagnostics, observer_generation)) = queue_diagnostics {
                queue_diagnostics.job_started(observer_generation);
            }
            let _ = response_sender.send(operation(connection));
        })));
        match response_receiver.await {
            Ok(result) => result,
            Err(_) if self.closing.load(Ordering::Acquire) => {
                Err(PersistenceError::WorkerUnavailable)
            }
            Err(_) => Err(PersistenceError::ResponseDropped),
        }
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

    /// Drains all previously queued SQLite work and checkpoints committed WAL pages.
    pub async fn checkpoint_wal(&self) -> Result<()> {
        self.call(|connection| {
            let (busy, log_pages, checkpointed_pages): (i64, i64, i64) =
                connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
            if busy != 0 || checkpointed_pages < log_pages {
                return Err(PersistenceError::BackupStopped(format!(
                    "WAL checkpoint remained busy ({checkpointed_pages}/{log_pages} pages)"
                )));
            }
            Ok(())
        })
        .await
    }

    #[cfg(test)]
    pub(crate) async fn backup_to_cancellable(
        &self,
        destination: impl AsRef<Path>,
        cancellation: CancellationToken,
        deadline: Instant,
    ) -> Result<()> {
        self.backup_to_cancellable_with(destination, cancellation, deadline, None)
            .await
    }

    /// [`Self::backup_to_cancellable`] with `after_step` run after every copied batch, a test
    /// seam for cancelling mid-copy.
    pub(crate) async fn backup_to_cancellable_with(
        &self,
        destination: impl AsRef<Path>,
        cancellation: CancellationToken,
        deadline: Instant,
        after_step: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
    ) -> Result<()> {
        const PAGES_PER_STEP: i32 = 128;
        const RETRY_DELAY: Duration = Duration::from_millis(2);

        let destination = destination.as_ref().to_path_buf();
        self.call(move |source| {
            ensure_backup_active(&cancellation, deadline)?;
            let mut target = Connection::open_with_flags(
                &destination,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|source| PersistenceError::Open {
                path: destination.clone(),
                source,
            })?;
            target
                .busy_timeout(Duration::ZERO)
                .map_err(PersistenceError::Configure)?;
            let backup = Backup::new(source, &mut target)?;
            loop {
                ensure_backup_active(&cancellation, deadline)?;
                let state = match backup.step(PAGES_PER_STEP) {
                    Ok(state) => state,
                    Err(error)
                        if matches!(
                            error.sqlite_error_code(),
                            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
                        ) =>
                    {
                        thread::sleep(RETRY_DELAY);
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                if let Some(after_step) = &after_step {
                    after_step();
                }
                ensure_backup_active(&cancellation, deadline)?;
                match state {
                    StepResult::Done => break,
                    StepResult::More => thread::yield_now(),
                    StepResult::Busy | StepResult::Locked => thread::sleep(RETRY_DELAY),
                    _ => {
                        return Err(PersistenceError::BackupStopped(
                            "reported an unsupported state".to_owned(),
                        ));
                    }
                }
            }
            drop(backup);
            target
                .execute_batch("PRAGMA journal_mode = DELETE")
                .map_err(PersistenceError::Sql)?;
            target
                .close()
                .map_err(|(_, source)| PersistenceError::Sql(source))?;
            Ok(())
        })
        .await
    }

    /// Converts the store to WAL and runs `PRAGMA auto_vacuum = INCREMENTAL; VACUUM` in one
    /// worker job. A cancelled token stops it before the statement starts or, through the
    /// progress handler, while VACUUM copies rows; SQLite then rolls the VACUUM back.
    /// `on_progress` runs on each progress callback before the token is read.
    pub(crate) async fn vacuum_incremental<P>(
        &self,
        cancellation: CancellationToken,
        mut on_progress: P,
    ) -> Result<VacuumOutcome>
    where
        P: FnMut() + Send + 'static,
    {
        self.call(move |connection| {
            // `sqlite3_interrupt` with no running statement is lost, so check first.
            if cancellation.is_cancelled() {
                return Ok(VacuumOutcome::Cancelled);
            }
            let original_mode: i64 =
                connection.query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
            connection.pragma_update(None, "journal_mode", "WAL")?;
            let handler_token = cancellation.clone();
            connection.progress_handler(
                VACUUM_PROGRESS_OPS,
                Some(move || {
                    on_progress();
                    handler_token.is_cancelled()
                }),
            )?;
            let result = connection.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;");
            connection.progress_handler(0, None::<fn() -> bool>)?;
            // Switching FULL to INCREMENTAL commits at once, outside VACUUM's transaction, so
            // a VACUUM that does not finish must switch it back. From NONE the pragma takes
            // effect only through VACUUM itself.
            if result.is_err() && original_mode == 1 {
                connection.pragma_update(None, "auto_vacuum", "FULL")?;
            }
            match result {
                Ok(()) => Ok(VacuumOutcome::Completed),
                Err(error)
                    if error.sqlite_error_code() == Some(ErrorCode::OperationInterrupted)
                        && cancellation.is_cancelled() =>
                {
                    Ok(VacuumOutcome::Cancelled)
                }
                Err(error) => Err(error.into()),
            }
        })
        .await
    }

    /// `PRAGMA wal_checkpoint(TRUNCATE)`; returns whether every WAL frame was checkpointed.
    pub(crate) async fn checkpoint_truncate(&self) -> Result<bool> {
        self.call(|connection| {
            let (busy, log_pages, checkpointed_pages): (i64, i64, i64) =
                connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
            Ok(busy == 0 && checkpointed_pages >= log_pages)
        })
        .await
    }

    pub(crate) async fn page_stats(&self) -> Result<PageStats> {
        self.call(|connection| Ok(page_stats(connection)?)).await
    }

    /// Lets the close checkpoint and delete the WAL again, as a normal shutdown does.
    pub(crate) async fn allow_checkpoint_on_close(&self) -> Result<()> {
        self.call(|connection| {
            connection.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, false)?;
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

fn ensure_backup_active(cancellation: &CancellationToken, deadline: Instant) -> Result<()> {
    if cancellation.is_cancelled() {
        Err(PersistenceError::BackupStopped("was cancelled".to_owned()))
    } else if Instant::now() >= deadline {
        Err(PersistenceError::BackupStopped(
            "deadline elapsed".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn open_maintenance_connection(path: &Path) -> Result<Connection> {
    // The caller holds the exclusive runtime lock, so no BiBCode process can change this.
    let wal_existed = std::fs::symlink_metadata(sqlite_sidecar_path(path, "-wal")).is_ok();
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|source| PersistenceError::Open {
        path: path.to_path_buf(),
        source,
    })?;
    if wal_existed {
        connection
            .set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .map_err(PersistenceError::Configure)?;
    }
    connection
        .busy_timeout(Duration::ZERO)
        .map_err(PersistenceError::Configure)?;
    connection
        .pragma_update(None, "locking_mode", "EXCLUSIVE")
        .map_err(PersistenceError::Configure)?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(PersistenceError::Configure)?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(PersistenceError::Configure)?;
    connection
        .pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES)
        .map_err(PersistenceError::Configure)?;
    connection
        .pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT_BYTES)
        .map_err(PersistenceError::Configure)?;
    // In exclusive locking mode the lock outlives the commit until the connection closes.
    connection.execute_batch("BEGIN EXCLUSIVE; COMMIT;")?;
    Ok(connection)
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut sidecar = path.as_os_str().to_os_string();
    sidecar.push(suffix);
    PathBuf::from(sidecar)
}

impl PersistenceError {
    /// Whether SQLite refused because another connection holds a lock.
    pub(crate) fn is_busy(&self) -> bool {
        let source = match self {
            Self::Open { source, .. } | Self::Configure(source) | Self::Sql(source) => source,
            _ => return false,
        };
        matches!(
            source.sqlite_error_code(),
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
        )
    }
}

fn open_connection(
    path: Option<&Path>,
    expected_identity: Option<FileIdentity>,
    read_only: bool,
    create_new: bool,
) -> Result<Connection> {
    if let (Some(path), Some(expected_identity)) = (path, expected_identity) {
        ensure_path_identity(path, expected_identity)?;
    }
    let connection = match path {
        Some(path) => Connection::open_with_flags(path, {
            let access = if read_only {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            } else {
                OpenFlags::SQLITE_OPEN_READ_WRITE
            };
            access | OpenFlags::SQLITE_OPEN_NO_MUTEX
        })
        .map_err(|source| PersistenceError::Open {
            path: path.to_path_buf(),
            source,
        })?,
        None => Connection::open_in_memory().map_err(|source| PersistenceError::Open {
            path: PathBuf::from(":memory:"),
            source,
        })?,
    };
    if let (Some(path), Some(expected_identity)) = (path, expected_identity) {
        ensure_path_identity(path, expected_identity)?;
    }

    connection.set_prepared_statement_cache_capacity(PREPARED_STATEMENT_CACHE_CAPACITY);
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(PersistenceError::Configure)?;
    if read_only {
        return Ok(connection);
    }
    if create_new {
        // Takes effect only before the first table exists and before WAL is enabled.
        connection
            .pragma_update(None, "auto_vacuum", "INCREMENTAL")
            .map_err(PersistenceError::Configure)?;
    }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    file: u64,
}

struct OwnedPathReservation {
    path: PathBuf,
    file: StdFile,
    identity: FileIdentity,
}

impl OwnedPathReservation {
    fn create(path: &Path) -> std::io::Result<Self> {
        let file = StdOpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)?;
        let identity = file_identity(&file)?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
            identity,
        })
    }

    fn owns_path(&self, path: &Path) -> bool {
        path_identity(path).is_ok_and(|identity| identity == self.identity)
    }

    fn cleanup(self) {
        let Self {
            path,
            file,
            identity,
        } = self;
        drop(file);
        remove_path_if_owned(&path, identity);
    }
}

fn new_database_staging_path(path: &Path) -> PathBuf {
    let mut name = OsString::from(".");
    name.push(path.file_name().unwrap_or_default());
    name.push(format!(".{}.tmp", Uuid::new_v4().as_simple()));
    path.with_file_name(name)
}

fn sqlite_sidecar_exists(path: &Path) -> bool {
    ["-journal", "-wal", "-shm"]
        .into_iter()
        .map(|suffix| {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(suffix);
            PathBuf::from(sidecar)
        })
        .any(|sidecar| std::fs::symlink_metadata(sidecar).is_ok())
}

fn ensure_path_identity(path: &Path, expected: FileIdentity) -> Result<()> {
    if path_identity(path).is_ok_and(|actual| actual == expected) {
        Ok(())
    } else {
        Err(PersistenceError::OwnershipChanged {
            path: path.to_path_buf(),
        })
    }
}

#[cfg(unix)]
fn remove_path_if_owned(path: &Path, expected: FileIdentity) {
    if path_identity(path).is_ok_and(|actual| actual == expected) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(windows)]
fn remove_path_if_owned(path: &Path, expected: FileIdentity) {
    use std::os::windows::io::AsRawHandle;
    use std::{mem::size_of, os::windows::fs::OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
        FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX, FILE_GENERIC_READ, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FileDispositionInfo, FileDispositionInfoEx,
        SetFileInformationByHandle,
    };

    let file = match StdOpenOptions::new()
        .access_mode(FILE_GENERIC_READ | DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
    {
        Ok(file) => file,
        Err(_) => return,
    };
    if !file_identity(&file).is_ok_and(|actual| actual == expected) {
        return;
    }
    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    let deleted = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfoEx,
            std::ptr::from_ref(&disposition).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if deleted == 0 {
        let fallback = FILE_DISPOSITION_INFO { DeleteFile: true };
        let _ = unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfo,
                std::ptr::from_ref(&fallback).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
    }
}

#[cfg(not(any(unix, windows)))]
fn remove_path_if_owned(_path: &Path, _expected: FileIdentity) {}

fn path_identity(path: &Path) -> std::io::Result<FileIdentity> {
    file_identity(&StdFile::open(path)?)
}

#[cfg(unix)]
fn file_identity(file: &StdFile) -> std::io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(FileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn file_identity(file: &StdFile) -> std::io::Result<FileIdentity> {
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
    Ok(FileIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn explicit_close_stops_the_worker_while_cloned_handles_remain() {
        let database = Database::open_in_memory().await.expect("database opens");
        let retained_handle = database.clone();

        tokio::time::timeout(Duration::from_secs(1), database.close())
            .await
            .expect("explicit close must not wait for every cloned sender to drop");
        assert!(matches!(
            retained_handle.call(|_| Ok(())).await,
            Err(PersistenceError::WorkerUnavailable)
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn explicit_close_drains_a_job_admitted_before_shutdown() {
        let database = Database::open_in_memory().await.expect("database opens");
        let caller = database.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let call = tokio::spawn(async move {
            caller
                .call(move |_| {
                    entered_tx.send(()).expect("test still observes entry");
                    release_rx.recv().expect("test releases the database job");
                    Ok(42)
                })
                .await
        });
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("database job should start");

        let close = tokio::spawn(database.close());
        release_tx.send(()).expect("database job still running");
        assert_eq!(
            call.await
                .expect("database call task should join")
                .expect("admitted database job should complete"),
            42
        );
        tokio::time::timeout(Duration::from_secs(1), close)
            .await
            .expect("explicit close should finish after the admitted job")
            .expect("database close task should join");
    }

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
        let database = Database::create_new(&database_path)
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
    async fn open_for_maintenance_fails_at_once_on_a_locked_database() {
        for wal in [true, false] {
            let directory = tempfile::tempdir().expect("temporary directory");
            let path = directory.path().join("state.sqlite");
            let setup = Connection::open(&path).expect("fixture database");
            if wal {
                setup
                    .pragma_update(None, "journal_mode", "WAL")
                    .expect("WAL mode");
            }
            setup
                .execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);")
                .expect("fixture rows");
            drop(setup);
            let other = Connection::open(&path).expect("other connection");
            other
                .execute_batch("BEGIN EXCLUSIVE;")
                .expect("hold an exclusive lock");

            let started = Instant::now();
            let error = Database::open_for_maintenance(&path)
                .await
                .expect_err("a locked database refuses the maintenance open");

            assert!(error.is_busy(), "WAL {wal}: {error:?}");
            assert!(
                started.elapsed() < Duration::from_secs(1),
                "WAL {wal}: refused after {:?}",
                started.elapsed()
            );
            other.execute_batch("ROLLBACK").expect("release the lock");
            drop(other);
            let database = Database::open_for_maintenance(&path)
                .await
                .expect("an unlocked database opens");
            database.close().await;
        }
    }

    #[tokio::test]
    async fn rejects_corrupt_database_files_without_replacing_them() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("state.sqlite");
        std::fs::write(&database_path, b"not a sqlite database").expect("corrupt fixture");

        let error = Database::open_existing(&database_path)
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
        let database = Database::create_new(&database_path)
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

        let reopened = Database::open_existing(&backup_path)
            .await
            .expect("backup reopens");
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

    #[tokio::test]
    async fn open_existing_never_creates_a_missing_database_or_parent() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("missing/state.sqlite");

        Database::open_existing(&database_path)
            .await
            .expect_err("missing database must fail");

        assert!(!database_path.exists());
        assert!(!database_path.parent().expect("database parent").exists());
    }

    #[tokio::test]
    async fn create_new_refuses_to_replace_an_existing_path() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("state.sqlite");
        let original = b"preserve existing bytes";
        std::fs::write(&database_path, original).expect("existing fixture");

        Database::create_new(&database_path)
            .await
            .expect_err("existing path must block creation");

        assert_eq!(
            std::fs::read(&database_path).expect("existing bytes"),
            original
        );
    }

    #[tokio::test]
    async fn create_new_never_configures_or_removes_a_final_path_replacement() {
        let temp = TempDir::new().expect("temporary database directory");
        let database_path = temp.path().join("state.sqlite");
        let foreign_path = temp.path().join("foreign.sqlite");
        let foreign = Connection::open(&foreign_path).expect("foreign SQLite fixture");
        foreign
            .execute("CREATE TABLE foreign_catalog (value TEXT)", [])
            .expect("foreign schema");
        drop(foreign);
        let replacement = std::fs::read(&foreign_path).expect("foreign SQLite bytes");
        std::fs::remove_file(&foreign_path).expect("remove foreign staging path");

        Database::create_new_with_before_reopen(&database_path, |final_path| {
            std::fs::remove_file(final_path)?;
            std::fs::write(final_path, &replacement)
        })
        .await
        .expect_err("foreign final path must win without being opened");

        assert_eq!(
            std::fs::read(&database_path).expect("replacement path remains"),
            replacement
        );
        assert_eq!(
            std::fs::read_dir(temp.path())
                .expect("database directory")
                .count(),
            1,
            "failed creation cleans only its randomized staging entry"
        );
    }

    #[test]
    fn owned_path_cleanup_removes_only_the_reserved_filesystem_object() {
        let temp = TempDir::new().expect("temporary database directory");
        let owned_path = temp.path().join("owned.sqlite");
        let owned = OwnedPathReservation::create(&owned_path).expect("owned reservation");
        owned.cleanup();
        assert!(!owned_path.exists(), "owned reservation is removed");

        let replaced_path = temp.path().join("replaced.sqlite");
        let replaced = OwnedPathReservation::create(&replaced_path).expect("owned reservation");
        std::fs::remove_file(&replaced_path).expect("unlink owned reservation");
        let replacement = b"foreign replacement";
        std::fs::write(&replaced_path, replacement).expect("replacement path");

        replaced.cleanup();

        assert_eq!(
            std::fs::read(&replaced_path).expect("replacement remains"),
            replacement
        );
    }
}
