use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard},
};

#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;

#[cfg(any(target_os = "macos", windows))]
use crate::git::{HostPathPlatform, normalize_worktree_path_key};

#[cfg(not(test))]
use std::{io::IsTerminal, sync::OnceLock};

use thiserror::Error;
use tracing_subscriber::EnvFilter;
#[cfg(not(test))]
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

pub(crate) const SERVER_LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const SERVER_LOG_BACKUPS: usize = 3;
const TRUNCATION_MARKER: &[u8] = b"\n[truncated]\n";
#[cfg(not(test))]
static INITIALIZE_LOCK: Mutex<()> = Mutex::new(());
#[cfg(not(test))]
static LOG_SINK_REGISTRY: OnceLock<Arc<LogSinkRegistry>> = OnceLock::new();
#[cfg(not(test))]
static PROCESS_LOG_SINK: OnceLock<LogSinkLease> = OnceLock::new();

#[derive(Clone)]
struct LogWriter(Arc<Mutex<RotatingFile>>);

impl LogWriter {
    fn new(file: RotatingFile) -> Self {
        Self(Arc::new(Mutex::new(file)))
    }

    fn write_record(&self, buffer: &[u8]) -> std::io::Result<()> {
        let mut writer = self.make_writer_guard();
        writer.write_all(buffer)?;
        writer.flush()
    }

    fn flush_record(&self) -> std::io::Result<()> {
        self.make_writer_guard().flush()
    }

    fn make_writer_guard(&self) -> LogWriterGuard<'_> {
        LogWriterGuard(
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    fn set_rotation_path(&self, path: PathBuf) {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .path = path;
    }

    fn physical_identity(&self) -> std::io::Result<LogFileIdentity> {
        let writer = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        log_file_identity(
            writer
                .file
                .as_ref()
                .ok_or_else(|| std::io::Error::other("rotating log file is unavailable"))?,
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LogFileIdentity {
    volume: u64,
    file: u64,
}

#[cfg(unix)]
fn log_file_identity(file: &File) -> std::io::Result<LogFileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(LogFileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn log_file_identity(file: &File) -> std::io::Result<LogFileIdentity> {
    log_windows_metadata_identity(&file.metadata()?)
}

#[cfg(windows)]
fn log_windows_metadata_identity(metadata: &std::fs::Metadata) -> std::io::Result<LogFileIdentity> {
    use std::os::windows::fs::MetadataExt;

    Ok(LogFileIdentity {
        volume: u64::from(
            metadata.volume_serial_number().ok_or_else(|| {
                std::io::Error::other("native log volume identity is unavailable")
            })?,
        ),
        file: metadata
            .file_index()
            .ok_or_else(|| std::io::Error::other("native log file identity is unavailable"))?,
    })
}

#[cfg(unix)]
fn log_path_identity(path: &Path) -> std::io::Result<LogFileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::metadata(path)?;
    Ok(LogFileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn log_path_identity(path: &Path) -> std::io::Result<LogFileIdentity> {
    log_windows_metadata_identity(&std::fs::metadata(path)?)
}

struct LogWriterGuard<'a>(MutexGuard<'a, RotatingFile>);

struct RotatingFile {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
    max_bytes: u64,
    backups: usize,
}

impl RotatingFile {
    fn open(path: PathBuf, max_bytes: u64, backups: usize) -> std::io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            path,
            file: Some(file),
            bytes,
            max_bytes: max_bytes.max(1),
            backups,
        })
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file.take();
        if self.backups > 0 {
            let oldest = backup_path(&self.path, self.backups);
            remove_if_exists(&oldest)?;
            for index in (2..=self.backups).rev() {
                let source = backup_path(&self.path, index - 1);
                if source.exists() {
                    std::fs::rename(source, backup_path(&self.path, index))?;
                }
            }
            if self.path.exists() {
                std::fs::rename(&self.path, backup_path(&self.path, 1))?;
            }
        } else {
            remove_if_exists(&self.path)?;
        }
        self.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?,
        );
        self.bytes = 0;
        Ok(())
    }
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(format!(".{index}"));
    PathBuf::from(value)
}

pub(crate) fn retained_server_log_paths(path: &Path) -> Vec<PathBuf> {
    (1..=SERVER_LOG_BACKUPS)
        .rev()
        .map(|index| backup_path(path, index))
        .chain(std::iter::once(path.to_path_buf()))
        .collect()
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogWriter {
    type Writer = LogWriterGuard<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        self.make_writer_guard()
    }
}

impl Write for LogWriterGuard<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let original_len = buffer.len();
        let max_bytes = usize::try_from(self.0.max_bytes).unwrap_or(usize::MAX);
        let bounded;
        let buffer = if buffer.len() > max_bytes {
            let marker_len = TRUNCATION_MARKER.len().min(max_bytes);
            let content_len = max_bytes.saturating_sub(marker_len);
            bounded = [&buffer[..content_len], &TRUNCATION_MARKER[..marker_len]].concat();
            bounded.as_slice()
        } else {
            buffer
        };
        if self.0.bytes > 0 && self.0.bytes.saturating_add(buffer.len() as u64) > self.0.max_bytes {
            self.0.rotate()?;
        }
        if self.0.file.is_none() {
            return Err(std::io::Error::other(format!(
                "rotating log file {} is unavailable",
                self.0.path.display()
            )));
        }
        self.0
            .file
            .as_mut()
            .expect("rotating log file availability was checked")
            .write_all(buffer)?;
        self.0.bytes = self.0.bytes.saturating_add(buffer.len() as u64);
        Ok(original_len)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.0.file.is_none() {
            return Err(std::io::Error::other(format!(
                "rotating log file {} is unavailable",
                self.0.path.display()
            )));
        }
        self.0
            .file
            .as_mut()
            .expect("rotating log file availability was checked")
            .flush()
    }
}

#[derive(Default)]
struct LogSinkRegistryState {
    next_id: u64,
    sinks: BTreeMap<u64, RegisteredLogSink>,
    sink_ids_by_identity: BTreeMap<LogSinkIdentity, u64>,
}

enum RegisteredLogSink {
    Pending {
        waiters: usize,
    },
    Ready {
        identity: LogSinkIdentity,
        writer: LogWriter,
        lease_count: usize,
        snapshot_count: usize,
    },
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum LogSinkIdentity {
    #[cfg(not(windows))]
    CaseSensitive(PathBuf),
    #[cfg(any(target_os = "macos", windows))]
    CaseFolded(String),
}

#[derive(Clone)]
struct LogSinkTarget {
    path: PathBuf,
    identity: LogSinkIdentity,
}

#[derive(Default)]
struct LogSinkRegistry {
    state: Mutex<LogSinkRegistryState>,
    state_changed: Condvar,
}

impl LogSinkRegistry {
    fn register(self: &Arc<Self>, target: LogSinkTarget) -> Result<LogSinkLease, LoggingError> {
        self.register_with(target, open_log_writer)
    }

    fn register_with<F>(
        self: &Arc<Self>,
        target: LogSinkTarget,
        mut open: F,
    ) -> Result<LogSinkLease, LoggingError>
    where
        F: FnMut(&Path) -> Result<LogWriter, LoggingError>,
    {
        let mut target = target;
        loop {
            let identity = target.identity.clone();
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(id) = state.sink_ids_by_identity.get(&identity).copied() {
                let sink = state
                    .sinks
                    .get_mut(&id)
                    .expect("physical log sink index references a live sink");
                match sink {
                    RegisteredLogSink::Ready { lease_count, .. } => {
                        *lease_count = lease_count
                            .checked_add(1)
                            .expect("native log sink lease count exhausted");
                        return Ok(LogSinkLease {
                            registry: self.clone(),
                            id,
                        });
                    }
                    RegisteredLogSink::Pending { waiters, .. } => {
                        *waiters = waiters
                            .checked_add(1)
                            .expect("native log sink waiter count exhausted");
                        self.state_changed.notify_all();
                        state = self
                            .state_changed
                            .wait_while(state, |state| {
                                state
                                    .sink_ids_by_identity
                                    .get(&identity)
                                    .and_then(|id| state.sinks.get(id))
                                    .is_some_and(|sink| {
                                        matches!(sink, RegisteredLogSink::Pending { .. })
                                    })
                            })
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        drop(state);
                        continue;
                    }
                }
            }

            let id = state.next_id;
            state.next_id = state
                .next_id
                .checked_add(1)
                .expect("native log sink identity space exhausted");
            let replaced = state
                .sinks
                .insert(id, RegisteredLogSink::Pending { waiters: 0 });
            debug_assert!(replaced.is_none());
            let replaced = state.sink_ids_by_identity.insert(identity.clone(), id);
            debug_assert!(replaced.is_none());
            drop(state);

            let mut reservation = PendingReservation::new(self.clone(), id);
            let (writer, opened_target) = loop {
                let writer = open(&target.path)?;
                let opened_target = resolve_opened_log_sink_target(&target.path)?;
                writer.set_rotation_path(opened_target.path.clone());
                let opened_identity =
                    writer
                        .physical_identity()
                        .map_err(|source| LoggingError::OpenFile {
                            path: opened_target.path.clone(),
                            source,
                        })?;
                let current_identity =
                    log_path_identity(&opened_target.path).map_err(|source| {
                        LoggingError::OpenFile {
                            path: opened_target.path.clone(),
                            source,
                        }
                    })?;
                if opened_identity == current_identity {
                    break (writer, opened_target);
                }
                drop(writer);
                target.path = opened_target.path;
            };

            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(
                matches!(
                    state.sinks.get(&id),
                    Some(RegisteredLogSink::Pending { .. })
                ),
                "pending log sink remains reserved during file opening"
            );

            if let Some(existing_id) = state
                .sink_ids_by_identity
                .get(&opened_target.identity)
                .copied()
                .filter(|existing_id| *existing_id != id)
            {
                if let Some(RegisteredLogSink::Ready { lease_count, .. }) =
                    state.sinks.get_mut(&existing_id)
                {
                    *lease_count = lease_count
                        .checked_add(1)
                        .expect("native log sink lease count exhausted");
                    remove_pending_reservation(&mut state, id, &identity);
                    reservation.disarm();
                    drop(state);
                    self.state_changed.notify_all();
                    drop(writer);
                    return Ok(LogSinkLease {
                        registry: self.clone(),
                        id: existing_id,
                    });
                }

                assert!(
                    matches!(
                        state.sinks.get(&existing_id),
                        Some(RegisteredLogSink::Pending { .. })
                    ),
                    "physical log sink index references a live sink"
                );
                remove_pending_reservation(&mut state, id, &identity);
                reservation.disarm();
                drop(state);
                self.state_changed.notify_all();
                drop(writer);
                target = opened_target;
                continue;
            }

            if opened_target.identity != identity {
                let indexed_id = state.sink_ids_by_identity.remove(&identity);
                debug_assert_eq!(indexed_id, Some(id));
                let replaced = state
                    .sink_ids_by_identity
                    .insert(opened_target.identity.clone(), id);
                debug_assert!(replaced.is_none());
            }
            let sink = state
                .sinks
                .get_mut(&id)
                .expect("pending log sink remains reserved during finalization");
            *sink = RegisteredLogSink::Ready {
                identity: opened_target.identity,
                writer,
                lease_count: 1,
                snapshot_count: 0,
            };
            reservation.disarm();
            drop(state);
            self.state_changed.notify_all();
            return Ok(LogSinkLease {
                registry: self.clone(),
                id,
            });
        }
    }

    fn remove_exact(&self, id: u64) {
        let removed = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(RegisteredLogSink::Ready { lease_count, .. }) = state.sinks.get_mut(&id) {
                *lease_count = lease_count
                    .checked_sub(1)
                    .expect("native log sink lease count remains positive");
            }
            remove_ready_if_unowned(&mut state, id)
        };
        drop(removed);
    }

    fn snapshot(self: &Arc<Self>) -> MultiLogWriter {
        let (writers, ids) = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut writers = Vec::new();
            let mut ids = Vec::new();
            for (id, sink) in &mut state.sinks {
                let RegisteredLogSink::Ready {
                    writer,
                    lease_count,
                    snapshot_count,
                    ..
                } = sink
                else {
                    continue;
                };
                if *lease_count == 0 {
                    continue;
                }
                *snapshot_count = snapshot_count
                    .checked_add(1)
                    .expect("native log sink snapshot count exhausted");
                writers.push(writer.clone());
                ids.push(*id);
            }
            (writers, ids)
        };
        MultiLogWriter {
            writers,
            snapshot: Some(LogSinkSnapshot {
                registry: self.clone(),
                ids,
            }),
        }
    }

    fn rollback_pending(&self, id: u64) {
        let removed = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if matches!(
                state.sinks.get(&id),
                Some(RegisteredLogSink::Pending { .. })
            ) {
                state.sinks.remove(&id);
                state
                    .sink_ids_by_identity
                    .retain(|_, indexed_id| *indexed_id != id);
                true
            } else {
                false
            }
        };
        if removed {
            self.state_changed.notify_all();
        }
    }

    fn release_snapshots(&self, ids: &[u64]) {
        let removed = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for id in ids {
                let Some(RegisteredLogSink::Ready { snapshot_count, .. }) = state.sinks.get_mut(id)
                else {
                    continue;
                };
                *snapshot_count = snapshot_count
                    .checked_sub(1)
                    .expect("native log sink snapshot count remains positive");
            }
            ids.iter()
                .filter_map(|id| remove_ready_if_unowned(&mut state, *id))
                .collect::<Vec<_>>()
        };
        drop(removed);
    }
}

fn remove_pending_reservation(
    state: &mut LogSinkRegistryState,
    id: u64,
    identity: &LogSinkIdentity,
) {
    let removed = state.sinks.remove(&id);
    assert!(
        matches!(removed, Some(RegisteredLogSink::Pending { .. })),
        "pending log sink rollback removes its exact token"
    );
    let indexed_id = state.sink_ids_by_identity.remove(identity);
    debug_assert_eq!(indexed_id, Some(id));
}

fn remove_ready_if_unowned(state: &mut LogSinkRegistryState, id: u64) -> Option<LogWriter> {
    let remove = matches!(
        state.sinks.get(&id),
        Some(RegisteredLogSink::Ready {
            lease_count: 0,
            snapshot_count: 0,
            ..
        })
    );
    if !remove {
        return None;
    }
    let sink = state
        .sinks
        .remove(&id)
        .expect("unowned log sink remains registered until exact removal");
    let RegisteredLogSink::Ready {
        identity, writer, ..
    } = sink
    else {
        unreachable!("only a ready log sink can become unowned")
    };
    let indexed_id = state.sink_ids_by_identity.remove(&identity);
    debug_assert_eq!(indexed_id, Some(id));
    Some(writer)
}

struct PendingReservation {
    registry: Arc<LogSinkRegistry>,
    id: u64,
    armed: bool,
}

impl PendingReservation {
    fn new(registry: Arc<LogSinkRegistry>, id: u64) -> Self {
        Self {
            registry,
            id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingReservation {
    fn drop(&mut self) {
        if self.armed {
            self.registry.rollback_pending(self.id);
        }
    }
}

pub(crate) struct LogSinkLease {
    registry: Arc<LogSinkRegistry>,
    id: u64,
}

impl Drop for LogSinkLease {
    fn drop(&mut self) {
        self.registry.remove_exact(self.id);
    }
}

struct LogSinkSnapshot {
    registry: Arc<LogSinkRegistry>,
    ids: Vec<u64>,
}

impl Drop for LogSinkSnapshot {
    fn drop(&mut self) {
        self.registry.release_snapshots(&self.ids);
    }
}

struct MultiLogWriter {
    writers: Vec<LogWriter>,
    snapshot: Option<LogSinkSnapshot>,
}

impl Drop for MultiLogWriter {
    fn drop(&mut self) {
        self.writers.clear();
        drop(self.snapshot.take());
    }
}

impl Write for MultiLogWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let mut accepted = false;
        let mut last_error = None;
        for writer in &self.writers {
            match writer.write_record(buffer) {
                Ok(()) => accepted = true,
                Err(error) => last_error = Some(error),
            }
        }
        if accepted || self.writers.is_empty() {
            Ok(buffer.len())
        } else {
            Err(last_error.expect("every non-empty sink write failed"))
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let mut accepted = false;
        let mut last_error = None;
        for writer in &self.writers {
            match writer.flush_record() {
                Ok(()) => accepted = true,
                Err(error) => last_error = Some(error),
            }
        }
        if accepted || self.writers.is_empty() {
            Ok(())
        } else {
            Err(last_error.expect("every non-empty sink flush failed"))
        }
    }
}

#[cfg(not(test))]
struct SharedLogSinkRegistry(Arc<LogSinkRegistry>);

#[cfg(not(test))]
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedLogSinkRegistry {
    type Writer = MultiLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        self.0.snapshot()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Init {
    Installed,
    AlreadyInstalled,
}

#[derive(Debug, Error)]
pub enum LoggingError {
    #[error("failed to create native log directory {path}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open native log file {path}")]
    OpenFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to install native tracing subscriber: {0}")]
    InstallSubscriber(String),
}

pub fn initialize(log_path: &Path) -> Result<Init, LoggingError> {
    #[cfg(test)]
    {
        drop(initialize_test_sink(log_path)?);
        Ok(Init::Installed)
    }

    #[cfg(not(test))]
    {
        if PROCESS_LOG_SINK.get().is_some() {
            return Ok(Init::AlreadyInstalled);
        }
        let lease = initialize_owned(log_path)?;
        let _guard = INITIALIZE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if PROCESS_LOG_SINK.get().is_some() {
            drop(_guard);
            drop(lease);
            return Ok(Init::AlreadyInstalled);
        }
        PROCESS_LOG_SINK.set(lease).map_err(|_| {
            LoggingError::InstallSubscriber(
                "process log sink was installed concurrently".to_owned(),
            )
        })?;
        Ok(Init::Installed)
    }
}

#[cfg(not(test))]
fn log_filter() -> EnvFilter {
    crate::environment_identity::bibcode_env_string("BIBCODE_LOG")
        .and_then(|value| EnvFilter::try_new(value).ok())
        .or_else(|| EnvFilter::try_from_default_env().ok())
        .unwrap_or_else(|| EnvFilter::new("info"))
}

pub(crate) fn initialize_owned(log_path: &Path) -> Result<LogSinkLease, LoggingError> {
    #[cfg(test)]
    {
        initialize_test_sink(log_path)
    }

    #[cfg(not(test))]
    {
        let target = resolve_log_sink_target(log_path)?;
        if let Some(registry) = LOG_SINK_REGISTRY.get() {
            return registry.register(target);
        }

        let candidate_registry = Arc::new(LogSinkRegistry::default());
        let candidate_lease = candidate_registry.register(target.clone())?;
        let filter = log_filter();
        let stderr_ansi = std::io::stderr().is_terminal();
        let guard = INITIALIZE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(registry) = LOG_SINK_REGISTRY.get() {
            let registry = registry.clone();
            drop(guard);
            drop(candidate_lease);
            drop(candidate_registry);
            return registry.register(target);
        }

        install_subscriber(candidate_registry.clone(), filter, stderr_ansi)
            .map_err(LoggingError::InstallSubscriber)?;
        assert!(
            LOG_SINK_REGISTRY.set(candidate_registry).is_ok(),
            "native log sink registry installation is serialized"
        );
        Ok(candidate_lease)
    }
}

fn resolve_log_sink_target(log_path: &Path) -> Result<LogSinkTarget, LoggingError> {
    let parent = log_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|source| LoggingError::CreateDirectory {
        path: parent.to_path_buf(),
        source,
    })?;
    let canonical_parent =
        std::fs::canonicalize(parent).map_err(|source| LoggingError::CreateDirectory {
            path: parent.to_path_buf(),
            source,
        })?;
    let file_name = log_path.file_name().ok_or_else(|| LoggingError::OpenFile {
        path: log_path.to_path_buf(),
        source: std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "native log path must name a file",
        ),
    })?;
    let unresolved_path = canonical_parent.join(file_name);
    match std::fs::canonicalize(&unresolved_path) {
        Ok(path) => Ok(LogSinkTarget {
            identity: log_sink_identity(&path),
            path,
        }),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(LogSinkTarget {
            identity: log_sink_identity(&unresolved_path),
            path: unresolved_path,
        }),
        Err(source) => Err(LoggingError::OpenFile {
            path: unresolved_path,
            source,
        }),
    }
}

fn resolve_opened_log_sink_target(log_path: &Path) -> Result<LogSinkTarget, LoggingError> {
    let path = std::fs::canonicalize(log_path).map_err(|source| LoggingError::OpenFile {
        path: log_path.to_path_buf(),
        source,
    })?;
    Ok(LogSinkTarget {
        identity: log_sink_identity(&path),
        path,
    })
}

/// Returns a reservation key for a fully normalized path or a not-yet-created leaf.
///
/// Existing leaves are canonicalized before this helper is called. Missing Windows leaves use
/// the repository's invariant ordinal path fold. On macOS, the containing volume reports whether
/// final components are case-sensitive; case-insensitive volumes use that same established fold.
/// Other POSIX filesystems retain byte-sensitive `PathBuf` identity. Every opened sink is
/// canonicalized again before its pending token can become ready.
fn log_sink_identity(path: &Path) -> LogSinkIdentity {
    #[cfg(windows)]
    {
        return LogSinkIdentity::CaseFolded(normalize_worktree_path_key(
            path,
            HostPathPlatform::Windows,
        ));
    }

    #[cfg(target_os = "macos")]
    {
        if !macos_volume_is_case_sensitive(path) {
            return LogSinkIdentity::CaseFolded(normalize_worktree_path_key(
                path,
                HostPathPlatform::Windows,
            ));
        }
    }

    #[cfg(not(windows))]
    {
        LogSinkIdentity::CaseSensitive(path.to_path_buf())
    }
}

#[cfg(target_os = "macos")]
fn macos_volume_is_case_sensitive(path: &Path) -> bool {
    let directory = path
        .parent()
        .and_then(|parent| File::open(parent).ok())
        .or_else(|| File::open(path).ok());
    let Some(directory) = directory else {
        return true;
    };
    // SAFETY: `directory` owns a live descriptor for the duration of this call. macOS defines
    // `_PC_CASE_SENSITIVE` as a boolean path capability; errors conservatively retain exact case.
    let result = unsafe { libc::fpathconf(directory.as_raw_fd(), libc::_PC_CASE_SENSITIVE) };
    result != 0
}

fn open_log_writer(log_path: &Path) -> Result<LogWriter, LoggingError> {
    let file = RotatingFile::open(
        log_path.to_path_buf(),
        SERVER_LOG_MAX_BYTES,
        SERVER_LOG_BACKUPS,
    )
    .map_err(|source| LoggingError::OpenFile {
        path: log_path.to_path_buf(),
        source,
    })?;
    Ok(LogWriter::new(file))
}

#[cfg(test)]
fn initialize_test_sink(log_path: &Path) -> Result<LogSinkLease, LoggingError> {
    let registry = Arc::new(LogSinkRegistry::default());
    registry.register(resolve_log_sink_target(log_path)?)
}

#[cfg(test)]
fn register_and_install_subscriber<F>(
    registry: &Arc<LogSinkRegistry>,
    target: LogSinkTarget,
    install: F,
) -> Result<LogSinkLease, LoggingError>
where
    F: FnOnce(Arc<LogSinkRegistry>) -> Result<(), String>,
{
    let lease = registry.register(target)?;
    install(registry.clone()).map_err(LoggingError::InstallSubscriber)?;
    Ok(lease)
}

#[cfg(not(test))]
fn install_subscriber(
    registry: Arc<LogSinkRegistry>,
    filter: EnvFilter,
    stderr_ansi: bool,
) -> Result<(), String> {
    let stderr = tracing_subscriber::fmt::layer()
        .with_ansi(stderr_ansi)
        .with_writer(std::io::stderr);
    let file = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(SharedLogSinkRegistry(registry));

    tracing_subscriber::registry()
        .with(filter)
        .with(stderr)
        .with(file)
        .try_init()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::{
        io::Write as _,
        panic::{AssertUnwindSafe, catch_unwind},
        sync::{
            Arc, Barrier,
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread,
        time::Duration,
    };

    use tempfile::TempDir;
    use tracing_subscriber::fmt::MakeWriter as _;

    use super::*;

    fn test_target(path: PathBuf) -> LogSinkTarget {
        resolve_log_sink_target(&path).expect("resolve test log target")
    }

    fn test_writer(path: PathBuf) -> LogWriter {
        let target = test_target(path);
        open_log_writer(&target.path).expect("open test log writer")
    }

    fn unavailable_writer(path: PathBuf) -> LogWriter {
        LogWriter::new(RotatingFile {
            path,
            file: None,
            bytes: 0,
            max_bytes: 1024,
            backups: 1,
        })
    }

    fn active_sink_count(registry: &LogSinkRegistry) -> usize {
        registry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .sinks
            .len()
    }

    fn active_lease_count(registry: &LogSinkRegistry) -> usize {
        registry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .sinks
            .values()
            .filter_map(|sink| match sink {
                RegisteredLogSink::Ready { lease_count, .. } => Some(*lease_count),
                RegisteredLogSink::Pending { .. } => None,
            })
            .sum()
    }

    #[test]
    fn same_physical_path_shares_one_writer_until_the_last_lease_drops() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("logs/server.log");
        let equivalent_path = temp.path().join("logs/../logs/server.log");
        let registry = Arc::new(LogSinkRegistry::default());
        let first = registry
            .register(test_target(log_path.clone()))
            .expect("first log writer");
        let second = registry
            .register(test_target(equivalent_path))
            .expect("second log writer");

        registry
            .snapshot()
            .write_all(b"same-physical-path\n")
            .expect("write shared physical sink");
        let contents = std::fs::read_to_string(&log_path).expect("shared physical log");
        assert_eq!(contents.matches("same-physical-path").count(), 1);
        assert_eq!(active_sink_count(&registry), 1);
        assert_eq!(active_lease_count(&registry), 2);

        drop(first);
        assert_eq!(active_sink_count(&registry), 1);
        assert_eq!(active_lease_count(&registry), 1);
        drop(second);
        assert_eq!(active_sink_count(&registry), 0);
        assert_eq!(active_lease_count(&registry), 0);
    }

    #[test]
    fn prepared_registration_cannot_publish_a_writer_displaced_by_rotation() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("logs/server.log");
        let registry = Arc::new(LogSinkRegistry::default());
        let original = registry
            .register(resolve_log_sink_target(&log_path).expect("original log target"))
            .expect("register original log writer");
        let staged = resolve_log_sink_target(&log_path).expect("staged replacement target");
        let staged_writer =
            open_log_writer(&staged.path).expect("open replacement before original rotation");
        let original_writer = {
            let state = registry
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match state
                .sinks
                .values()
                .next()
                .expect("original registered sink")
            {
                RegisteredLogSink::Ready { writer, .. } => writer.clone(),
                RegisteredLogSink::Pending { .. } => panic!("original sink must be ready"),
            }
        };

        original_writer
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .rotate()
            .expect("rotate original writer after replacement preparation");
        drop(original_writer);
        drop(original);
        let replacement = registry
            .register(staged)
            .expect("register replacement writer");

        registry
            .snapshot()
            .write_all(b"post-rotation-marker\n")
            .expect("write through replacement registration");
        assert_eq!(
            std::fs::read_to_string(&log_path).expect("current server log"),
            "post-rotation-marker\n",
            "replacement registration must own the current logical log target"
        );
        drop(replacement);
        drop(staged_writer);
    }

    #[test]
    fn opened_writer_revalidation_retries_a_descriptor_displaced_before_finalize() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("logs/server.log");
        let target = resolve_log_sink_target(&log_path).expect("shared log target");
        let registry = Arc::new(LogSinkRegistry::default());
        let open_count = AtomicUsize::new(0);

        let lease = registry
            .register_with(target, |path| {
                let writer = open_log_writer(path)?;
                if open_count.fetch_add(1, Ordering::SeqCst) == 0 {
                    let competing = open_log_writer(path)?;
                    competing
                        .0
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .rotate()
                        .expect("displace first opened descriptor");
                }
                Ok(writer)
            })
            .expect("retry displaced open and register current writer");
        registry
            .snapshot()
            .write_all(b"revalidated-writer\n")
            .expect("write through revalidated registration");

        assert_eq!(open_count.load(Ordering::SeqCst), 2);
        assert_eq!(
            std::fs::read_to_string(&log_path).expect("current server log"),
            "revalidated-writer\n"
        );
        drop(lease);
        assert_eq!(active_sink_count(&registry), 0);
    }

    #[test]
    fn an_in_flight_snapshot_keeps_the_registered_writer_discoverable() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("logs/server.log");
        let target = resolve_log_sink_target(&log_path).expect("shared log target");
        let registry = Arc::new(LogSinkRegistry::default());
        let original = registry
            .register_with(target.clone(), |path| {
                RotatingFile::open(path.to_path_buf(), 64, 2)
                    .map(LogWriter::new)
                    .map_err(|source| LoggingError::OpenFile {
                        path: path.to_path_buf(),
                        source,
                    })
            })
            .expect("register bounded original writer");
        let mut stale_snapshot = registry.snapshot();
        stale_snapshot
            .write_all(&[b's'; 60])
            .expect("seed original writer below its rotation limit");

        drop(original);
        let replacement = registry
            .register_with(target, |path| {
                RotatingFile::open(path.to_path_buf(), 1024, 2)
                    .map(LogWriter::new)
                    .map_err(|source| LoggingError::OpenFile {
                        path: path.to_path_buf(),
                        source,
                    })
            })
            .expect("register while the old snapshot is in flight");

        stale_snapshot
            .write_all(b"snapshot-rotation\n")
            .expect("in-flight snapshot rotates and writes");
        let mut current_snapshot = registry.snapshot();
        current_snapshot
            .write_all(b"current-writer\n")
            .expect("current registration writes after snapshot rotation");
        current_snapshot.flush().expect("flush current writer");

        assert_eq!(
            std::fs::read_to_string(&log_path).expect("current server log"),
            "snapshot-rotation\ncurrent-writer\n",
            "replacement registration must reuse the writer retained by the snapshot"
        );
        drop(current_snapshot);
        drop(replacement);
        drop(stale_snapshot);
        assert_eq!(active_sink_count(&registry), 0);
    }

    #[test]
    fn a_panicking_pending_opener_rolls_back_before_same_target_registration() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("logs/server.log");
        let target = resolve_log_sink_target(&log_path).expect("shared log target");
        let registry = Arc::new(LogSinkRegistry::default());
        let opener_entered = Arc::new(Barrier::new(2));
        let release_opener = Arc::new(Barrier::new(2));
        let (registered_tx, registered_rx) = mpsc::sync_channel(1);

        let panicking = {
            let registry = registry.clone();
            let target = target.clone();
            let opener_entered = opener_entered.clone();
            let release_opener = release_opener.clone();
            thread::spawn(move || {
                catch_unwind(AssertUnwindSafe(move || {
                    let _ = registry.register_with(
                        target,
                        |_path| -> Result<LogWriter, LoggingError> {
                            opener_entered.wait();
                            release_opener.wait();
                            panic!("injected opener panic")
                        },
                    );
                }))
            })
        };
        opener_entered.wait();
        let waiter = {
            let registry = registry.clone();
            thread::spawn(move || {
                let lease = registry
                    .register(target)
                    .expect("same target registration proceeds after opener unwind");
                registered_tx
                    .send(lease)
                    .expect("publish registration after unwind");
            })
        };
        let state = registry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = registry
            .state_changed
            .wait_while(state, |state| {
                state.sinks.values().all(|sink| {
                    !matches!(sink, RegisteredLogSink::Pending { waiters, .. } if *waiters > 0)
                })
            })
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        drop(state);
        release_opener.wait();

        assert!(panicking.join().expect("panicking opener thread").is_err());
        let lease = registered_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("pending waiter is notified after opener unwind");
        waiter.join().expect("same-target waiter thread");
        assert_eq!(active_sink_count(&registry), 1);
        drop(lease);
        assert_eq!(active_sink_count(&registry), 0);
    }

    #[cfg(unix)]
    #[test]
    fn final_component_symlink_aliases_share_one_registered_writer() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().expect("temporary log directory");
        let physical_path = temp.path().join("logs/physical.log");
        let alias_path = temp.path().join("logs/server.log");
        std::fs::create_dir_all(physical_path.parent().expect("log parent"))
            .expect("log directory");
        symlink(&physical_path, &alias_path).expect("final-component symlink");
        let alias_target = resolve_log_sink_target(&alias_path).expect("dangling alias target");
        let registry = Arc::new(LogSinkRegistry::default());

        let physical = registry
            .register(resolve_log_sink_target(&physical_path).expect("physical log target"))
            .expect("register physical target");
        let alias = registry
            .register(alias_target)
            .expect("merge alias after opened-target revalidation");
        registry
            .snapshot()
            .write_all(b"one-physical-writer\n")
            .expect("write aliased sink");

        let contents = std::fs::read_to_string(&physical_path).expect("physical log");
        assert_eq!(contents.matches("one-physical-writer").count(), 1);
        assert_eq!(active_sink_count(&registry), 1);
        assert_eq!(active_lease_count(&registry), 2);
        drop(alias);
        drop(physical);
        assert_eq!(active_sink_count(&registry), 0);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn case_aliases_on_a_case_insensitive_volume_share_one_registered_writer() {
        let temp = TempDir::new().expect("temporary log directory");
        let primary_path = temp.path().join("logs/Server.Log");
        let alias_path = temp.path().join("logs/server.log");
        std::fs::create_dir_all(primary_path.parent().expect("log parent")).expect("log directory");
        #[cfg(target_os = "macos")]
        if macos_volume_is_case_sensitive(&primary_path) {
            return;
        }
        let primary_target = resolve_log_sink_target(&primary_path).expect("primary log target");
        let alias_target = resolve_log_sink_target(&alias_path).expect("case-alias log target");
        let registry = Arc::new(LogSinkRegistry::default());
        let primary = registry
            .register(primary_target)
            .expect("register primary spelling");
        let alias = registry
            .register(alias_target)
            .expect("register case alias");
        registry
            .snapshot()
            .write_all(b"one-case-insensitive-writer\n")
            .expect("write case-aliased sink");

        let contents = std::fs::read_to_string(&primary_path).expect("primary log");
        assert_eq!(contents.matches("one-case-insensitive-writer").count(), 1);
        assert_eq!(active_sink_count(&registry), 1);
        assert_eq!(active_lease_count(&registry), 2);
        drop(primary);
        drop(alias);
        assert_eq!(active_sink_count(&registry), 0);
    }

    #[test]
    fn concurrent_pending_registrants_share_one_open_writer_and_two_exact_leases() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("logs/server.log");
        let target = resolve_log_sink_target(&log_path).expect("shared log target");
        let registry = Arc::new(LogSinkRegistry::default());
        let open_count = Arc::new(AtomicUsize::new(0));
        let opener_entered = Arc::new(Barrier::new(2));
        let release_opener = Arc::new(Barrier::new(2));

        thread::scope(|scope| {
            let first = {
                let registry = registry.clone();
                let target = target.clone();
                let open_count = open_count.clone();
                let opener_entered = opener_entered.clone();
                let release_opener = release_opener.clone();
                scope.spawn(move || {
                    registry.register_with(target, |path| {
                        open_count.fetch_add(1, Ordering::SeqCst);
                        opener_entered.wait();
                        release_opener.wait();
                        open_log_writer(path)
                    })
                })
            };

            opener_entered.wait();
            let second = {
                let registry = registry.clone();
                let target = target.clone();
                let open_count = open_count.clone();
                scope.spawn(move || {
                    registry.register_with(target, |path| {
                        open_count.fetch_add(1, Ordering::SeqCst);
                        open_log_writer(path)
                    })
                })
            };

            let state = registry
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let state = registry
                .state_changed
                .wait_while(state, |state| {
                    state.sinks.values().all(|sink| {
                        !matches!(sink, RegisteredLogSink::Pending { waiters, .. } if *waiters > 0)
                    })
                })
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            drop(state);
            release_opener.wait();

            let first = first
                .join()
                .expect("first registration thread")
                .expect("first lease");
            let second = second
                .join()
                .expect("second registration thread")
                .expect("second lease");
            assert_eq!(open_count.load(Ordering::SeqCst), 1);
            assert_eq!(active_sink_count(&registry), 1);
            assert_eq!(active_lease_count(&registry), 2);
            drop(first);
            assert_eq!(active_sink_count(&registry), 1);
            drop(second);
        });

        assert_eq!(active_sink_count(&registry), 0);
        assert_eq!(active_lease_count(&registry), 0);
    }

    #[test]
    fn failed_pending_open_rolls_back_before_a_later_registration() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("logs/server.log");
        let target = resolve_log_sink_target(&log_path).expect("shared log target");
        let registry = Arc::new(LogSinkRegistry::default());

        let error = match registry.register_with(target.clone(), |path| {
            Err(LoggingError::OpenFile {
                path: path.to_path_buf(),
                source: std::io::Error::other("injected open failure"),
            })
        }) {
            Ok(_) => panic!("injected open must fail"),
            Err(error) => error,
        };
        assert!(matches!(error, LoggingError::OpenFile { .. }));
        assert_eq!(active_sink_count(&registry), 0);

        let lease = registry
            .register(target)
            .expect("later registration can reserve and open the same target");
        assert_eq!(active_sink_count(&registry), 1);
        assert_eq!(active_lease_count(&registry), 1);
        drop(lease);
        assert_eq!(active_sink_count(&registry), 0);
    }

    #[test]
    fn dropping_a_lease_removes_only_its_exact_sink() {
        let temp = TempDir::new().expect("temporary log directory");
        let left_path = temp.path().join("left/server.log");
        let right_path = temp.path().join("right/server.log");
        let registry = Arc::new(LogSinkRegistry::default());
        let left = registry
            .register(test_target(left_path.clone()))
            .expect("register left sink");
        let right = registry
            .register(test_target(right_path.clone()))
            .expect("register right sink");

        registry
            .snapshot()
            .write_all(b"before-drop\n")
            .expect("write both registered sinks");
        drop(left);
        registry
            .snapshot()
            .write_all(b"after-drop\n")
            .expect("write remaining registered sink");

        assert_eq!(active_sink_count(&registry), 1);
        assert_eq!(
            std::fs::read_to_string(left_path).expect("left log"),
            "before-drop\n"
        );
        assert_eq!(
            std::fs::read_to_string(right_path).expect("right log"),
            "before-drop\nafter-drop\n"
        );
        drop(right);
        assert_eq!(active_sink_count(&registry), 0);
    }

    #[test]
    fn concurrent_registration_and_drop_preserve_every_exact_lease() {
        const WORKERS: usize = 16;

        let temp = TempDir::new().expect("temporary log directory");
        let registry = Arc::new(LogSinkRegistry::default());
        let target = test_target(temp.path().join("server.log"));
        let registered = Arc::new(Barrier::new(WORKERS + 1));
        let release = Arc::new(Barrier::new(WORKERS + 1));

        thread::scope(|scope| {
            for _ in 0..WORKERS {
                let registry = registry.clone();
                let target = target.clone();
                let registered = registered.clone();
                let release = release.clone();
                scope.spawn(move || {
                    let lease = registry.register(target).expect("register shared sink");
                    registered.wait();
                    release.wait();
                    drop(lease);
                });
            }

            registered.wait();
            assert_eq!(active_sink_count(&registry), 1);
            assert_eq!(active_lease_count(&registry), WORKERS);
            release.wait();
        });

        assert_eq!(active_sink_count(&registry), 0);
        assert_eq!(active_lease_count(&registry), 0);
    }

    #[test]
    fn repeated_terminal_leases_leave_no_registry_entries() {
        let temp = TempDir::new().expect("temporary log directory");
        let registry = Arc::new(LogSinkRegistry::default());
        let target = test_target(temp.path().join("server.log"));

        for _ in 0..256 {
            let lease = registry
                .register(target.clone())
                .expect("register terminal sink");
            assert_eq!(active_sink_count(&registry), 1);
            drop(lease);
            assert_eq!(active_sink_count(&registry), 0);
        }

        let state = registry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert_eq!(state.next_id, 256);
        assert!(state.sinks.is_empty());
        assert!(state.sink_ids_by_identity.is_empty());
    }

    #[test]
    fn a_failing_sink_does_not_starve_healthy_writes_or_flushes() {
        let temp = TempDir::new().expect("temporary log directory");
        let healthy_path = temp.path().join("healthy/server.log");
        let mut writer = MultiLogWriter {
            writers: vec![
                unavailable_writer(temp.path().join("missing/server.log")),
                test_writer(healthy_path.clone()),
            ],
            snapshot: None,
        };

        writer
            .write_all(b"healthy-after-failure\n")
            .expect("one healthy sink accepts the record");
        writer.flush().expect("one healthy sink accepts the flush");

        assert_eq!(
            std::fs::read_to_string(healthy_path).expect("healthy log"),
            "healthy-after-failure\n"
        );
    }

    #[test]
    fn a_composite_reports_the_last_error_when_every_sink_fails() {
        let temp = TempDir::new().expect("temporary log directory");
        let last_path = temp.path().join("last/server.log");
        let mut writer = MultiLogWriter {
            writers: vec![
                unavailable_writer(temp.path().join("first/server.log")),
                unavailable_writer(last_path.clone()),
            ],
            snapshot: None,
        };

        let write_error = writer
            .write_all(b"unwritten\n")
            .expect_err("every sink write fails");
        assert!(
            write_error
                .to_string()
                .contains(&last_path.display().to_string())
        );
        let flush_error = writer.flush().expect_err("every sink flush fails");
        assert!(
            flush_error
                .to_string()
                .contains(&last_path.display().to_string())
        );
    }

    #[test]
    fn failed_first_subscriber_install_rolls_back_its_provisional_lease() {
        let temp = TempDir::new().expect("temporary log directory");
        let registry = Arc::new(LogSinkRegistry::default());

        let result = register_and_install_subscriber(
            &registry,
            test_target(temp.path().join("server.log")),
            |_registry| Err("injected subscriber conflict".to_owned()),
        );

        assert!(matches!(result, Err(LoggingError::InstallSubscriber(_))));
        assert_eq!(active_sink_count(&registry), 0);
    }

    #[test]
    fn native_log_files_rotate_with_a_bounded_backup_count() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("server.log");
        let writer = LogWriter(Arc::new(Mutex::new(
            RotatingFile::open(log_path.clone(), 12, 2).expect("open rotating log"),
        )));

        for line in [
            b"first-line\n".as_slice(),
            b"second-line\n".as_slice(),
            b"third-line\n".as_slice(),
        ] {
            let mut guard = writer.make_writer();
            guard.write_all(line).expect("write rotating log");
            guard.flush().expect("flush rotating log");
        }

        assert_eq!(
            std::fs::read_to_string(&log_path).expect("current log"),
            "third-line\n"
        );
        assert_eq!(
            std::fs::read_to_string(backup_path(&log_path, 1)).expect("first backup"),
            "second-line\n"
        );
        assert_eq!(
            std::fs::read_to_string(backup_path(&log_path, 2)).expect("second backup"),
            "first-line\n"
        );
        assert!(!backup_path(&log_path, 3).exists());
    }

    #[test]
    fn a_single_oversized_log_record_is_truncated_to_the_file_limit() {
        let temp = TempDir::new().expect("temporary log directory");
        let log_path = temp.path().join("server.log");
        let writer = LogWriter(Arc::new(Mutex::new(
            RotatingFile::open(log_path.clone(), 32, 2).expect("open rotating log"),
        )));

        let mut guard = writer.make_writer();
        guard
            .write_all(&vec![b'x'; 4 * 1024])
            .expect("write oversized log record");
        guard.flush().expect("flush oversized log record");
        drop(guard);

        assert!(std::fs::metadata(log_path).expect("log metadata").len() <= 32);
    }

    #[test]
    fn native_events_are_written_to_independent_sandbox_writers() {
        let temp = TempDir::new().expect("temporary log directory");
        let left_path = temp.path().join("left/server.log");
        let right_path = temp.path().join("right/server.log");
        std::fs::create_dir_all(left_path.parent().expect("left log parent"))
            .expect("left log directory");
        std::fs::create_dir_all(right_path.parent().expect("right log parent"))
            .expect("right log directory");
        let left = LogWriter(Arc::new(Mutex::new(
            RotatingFile::open(left_path.clone(), 1024, 1).expect("left sandbox writer"),
        )));
        let right = LogWriter(Arc::new(Mutex::new(
            RotatingFile::open(right_path.clone(), 1024, 1).expect("right sandbox writer"),
        )));
        let left_subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_env_filter(EnvFilter::new("info"))
            .with_writer(left)
            .finish();
        let right_subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_env_filter(EnvFilter::new("info"))
            .with_writer(right)
            .finish();

        tracing::subscriber::with_default(left_subscriber, || {
            tracing::info!(target: "bibcode_server_logging_test", "left sandbox event");
        });
        tracing::subscriber::with_default(right_subscriber, || {
            tracing::info!(target: "bibcode_server_logging_test", "right sandbox event");
        });

        let left = std::fs::read_to_string(left_path).expect("left log is readable");
        let right = std::fs::read_to_string(right_path).expect("right log is readable");
        assert!(left.contains("left sandbox event"));
        assert!(!left.contains("right sandbox event"));
        assert!(right.contains("right sandbox event"));
        assert!(!right.contains("left sandbox event"));
    }
}
