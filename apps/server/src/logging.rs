use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

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
    sinks: BTreeMap<u64, LogWriter>,
}

#[derive(Default)]
struct LogSinkRegistry {
    state: Mutex<LogSinkRegistryState>,
}

impl LogSinkRegistry {
    fn register(self: &Arc<Self>, writer: LogWriter) -> LogSinkLease {
        let id = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let id = state.next_id;
            state.next_id = state
                .next_id
                .checked_add(1)
                .expect("native log sink identity space exhausted");
            let replaced = state.sinks.insert(id, writer);
            debug_assert!(replaced.is_none());
            id
        };
        LogSinkLease {
            registry: self.clone(),
            id,
        }
    }

    fn remove_exact(&self, id: u64) {
        let removed = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.sinks.remove(&id)
        };
        drop(removed);
    }

    fn snapshot(&self) -> Vec<LogWriter> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .sinks
            .values()
            .cloned()
            .collect()
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

struct MultiLogWriter {
    writers: Vec<LogWriter>,
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

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogSinkRegistry {
    type Writer = MultiLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        MultiLogWriter {
            writers: self.snapshot(),
        }
    }
}

#[cfg(not(test))]
struct SharedLogSinkRegistry(Arc<LogSinkRegistry>);

#[cfg(not(test))]
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedLogSinkRegistry {
    type Writer = MultiLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        MultiLogWriter {
            writers: self.0.snapshot(),
        }
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
        let writer = open_log_writer(log_path)?;
        let filter = log_filter();
        let stderr_ansi = std::io::stderr().is_terminal();
        let _guard = INITIALIZE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if PROCESS_LOG_SINK.get().is_some() {
            return Ok(Init::AlreadyInstalled);
        }
        let lease = initialize_owned_locked(writer, filter, stderr_ansi)?;
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
        let writer = open_log_writer(log_path)?;
        let filter = log_filter();
        let stderr_ansi = std::io::stderr().is_terminal();
        let _guard = INITIALIZE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        initialize_owned_locked(writer, filter, stderr_ansi)
    }
}

fn open_log_writer(log_path: &Path) -> Result<LogWriter, LoggingError> {
    let parent = log_path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|source| LoggingError::CreateDirectory {
        path: parent.to_path_buf(),
        source,
    })?;
    RotatingFile::open(
        log_path.to_path_buf(),
        SERVER_LOG_MAX_BYTES,
        SERVER_LOG_BACKUPS,
    )
    .map_err(|source| LoggingError::OpenFile {
        path: log_path.to_path_buf(),
        source,
    })
    .map(LogWriter::new)
}

#[cfg(test)]
fn initialize_test_sink(log_path: &Path) -> Result<LogSinkLease, LoggingError> {
    let registry = Arc::new(LogSinkRegistry::default());
    Ok(registry.register(open_log_writer(log_path)?))
}

fn register_and_install_subscriber<F>(
    registry: &Arc<LogSinkRegistry>,
    writer: LogWriter,
    install: F,
) -> Result<LogSinkLease, LoggingError>
where
    F: FnOnce(Arc<LogSinkRegistry>) -> Result<(), String>,
{
    let lease = registry.register(writer);
    install(registry.clone()).map_err(LoggingError::InstallSubscriber)?;
    Ok(lease)
}

#[cfg(not(test))]
fn initialize_owned_locked(
    writer: LogWriter,
    filter: EnvFilter,
    stderr_ansi: bool,
) -> Result<LogSinkLease, LoggingError> {
    if let Some(registry) = LOG_SINK_REGISTRY.get() {
        return Ok(registry.register(writer));
    }

    let registry = Arc::new(LogSinkRegistry::default());
    let lease = register_and_install_subscriber(&registry, writer, |registry| {
        install_subscriber(registry, filter, stderr_ansi)
    })?;
    assert!(
        LOG_SINK_REGISTRY.set(registry).is_ok(),
        "native log sink registry installation is serialized"
    );
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
        sync::{Arc, Barrier},
        thread,
    };

    use tempfile::TempDir;
    use tracing_subscriber::fmt::MakeWriter as _;

    use super::*;

    fn test_writer(path: PathBuf) -> LogWriter {
        std::fs::create_dir_all(path.parent().expect("test log parent"))
            .expect("create test log directory");
        LogWriter::new(RotatingFile::open(path, 1024, 1).expect("open test rotating log writer"))
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

    #[test]
    fn dropping_a_lease_removes_only_its_exact_sink() {
        let temp = TempDir::new().expect("temporary log directory");
        let left_path = temp.path().join("left/server.log");
        let right_path = temp.path().join("right/server.log");
        let registry = Arc::new(LogSinkRegistry::default());
        let left = registry.register(test_writer(left_path.clone()));
        let right = registry.register(test_writer(right_path.clone()));

        registry
            .make_writer()
            .write_all(b"before-drop\n")
            .expect("write both registered sinks");
        drop(left);
        registry
            .make_writer()
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
        let writer = test_writer(temp.path().join("server.log"));
        let registered = Arc::new(Barrier::new(WORKERS + 1));
        let release = Arc::new(Barrier::new(WORKERS + 1));

        thread::scope(|scope| {
            for _ in 0..WORKERS {
                let registry = registry.clone();
                let writer = writer.clone();
                let registered = registered.clone();
                let release = release.clone();
                scope.spawn(move || {
                    let lease = registry.register(writer);
                    registered.wait();
                    release.wait();
                    drop(lease);
                });
            }

            registered.wait();
            assert_eq!(active_sink_count(&registry), WORKERS);
            release.wait();
        });

        assert_eq!(active_sink_count(&registry), 0);
    }

    #[test]
    fn repeated_terminal_leases_leave_no_registry_entries() {
        let temp = TempDir::new().expect("temporary log directory");
        let registry = Arc::new(LogSinkRegistry::default());
        let writer = test_writer(temp.path().join("server.log"));

        for _ in 0..256 {
            let lease = registry.register(writer.clone());
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
            test_writer(temp.path().join("server.log")),
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
