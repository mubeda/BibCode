pub mod cli;
pub mod client;
pub mod connections;
pub mod crash;
pub mod event;
pub mod exits;
pub mod findings;
pub mod git_actions;
pub mod latency;
pub mod leak;
pub mod mcp;
pub mod os_records;
pub mod panic_hook;
pub mod provider_turns;
pub mod reader;
pub mod redact;
pub mod runtime;
pub mod sampler;
pub mod sentinel;
pub mod stop_steps;
pub mod store;
pub mod symbolicate;
pub mod worktree_audit;

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, PoisonError, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

use serde_json::{Map, Value};

pub fn profiler_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("profiler")
}

/// The `enableProfiler` setting of a settings document: off unless it is `true`.
pub(crate) fn enabled_setting(settings: &Value) -> bool {
    settings
        .get("enableProfiler")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The persisted `enableProfiler` in the settings file of `state_dir`, read without a server.
pub(crate) fn persisted_enabled(state_dir: &Path) -> bool {
    std::fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|settings| enabled_setting(&settings))
}

/// The live profiler state that hot paths reach through [`global`].
pub struct ProfilerHandle {
    /// The profiler directory this runtime owns, with its session sentinel.
    dir: PathBuf,
    pub(crate) enabled: AtomicBool,
    pub(crate) sender: store::EventSender,
    pub(crate) findings: Mutex<findings::FindingsBook>,
    pub(crate) recording_since: Mutex<Option<String>>,
    /// Where the panic hook hands panics over, to be raised as findings off its thread.
    panics: tokio::sync::mpsc::Sender<panic_hook::PanicRecord>,
    /// The crash dumps a finding cites already, by id.
    linked_dumps: Mutex<std::collections::HashSet<String>>,
}

/// Replaceable rather than a `OnceLock`: the desktop host restarts the server in-process,
/// and the new runtime must take over from the one that shut down.
static HANDLE: RwLock<Option<Arc<ProfilerHandle>>> = RwLock::new(None);

/// Installs `handle` unless one is installed already, and returns the installed handle.
pub(crate) fn install(handle: Arc<ProfilerHandle>) -> Arc<ProfilerHandle> {
    HANDLE
        .write()
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert(handle)
        .clone()
}

/// Clears the global handle if it is `handle`.
pub(crate) fn uninstall(handle: &Arc<ProfilerHandle>) {
    let mut slot = HANDLE.write().unwrap_or_else(PoisonError::into_inner);
    if slot
        .as_ref()
        .is_some_and(|installed| Arc::ptr_eq(installed, handle))
    {
        *slot = None;
    }
}

pub fn global() -> Option<Arc<ProfilerHandle>> {
    HANDLE
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

fn enabled_handle() -> Option<Arc<ProfilerHandle>> {
    global().filter(|handle| handle.enabled.load(Ordering::Relaxed))
}

/// Every RPC checks this, so it borrows the handle rather than cloning the `Arc`.
pub fn is_enabled() -> bool {
    HANDLE
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .is_some_and(|handle| handle.enabled.load(Ordering::Relaxed))
}

/// Records how this process is ending in the session sentinel, so the next start can say why
/// the run ended when no crash record does: `display-lost`, `quit` or `signal`, with an
/// optional detail. Works with the profiler off, like the sentinel. Synchronous file I/O:
/// call it on the way out, never on an async worker's hot path.
pub fn note_exit(cause: &str, detail: Option<&str>) {
    if let Some(handle) = global() {
        sentinel::note_exit(&handle.dir, cause, detail);
    }
}

/// Records the events of one offline CLI command, with source `cli`, when no server runs.
///
/// It writes no session sentinel, so crash and clean-shutdown detection are untouched. It holds
/// `profiler/.lock` for its whole life, like a server runtime, so it is never a second writer
/// beside one that is still tearing down. Dropping it waits at most 2 s for the writer to
/// finish; a stuck disk leaves the writer, and its lock, to finish on its own.
pub struct OfflineWriter {
    store: Option<(store::ProfilerStore, std::fs::File)>,
}

/// How long dropping an [`OfflineWriter`] may wait for its writer thread.
const OFFLINE_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

impl OfflineWriter {
    pub fn emit(&self, kind: &'static str, payload: Value) {
        if let Some((store, _lock)) = &self.store {
            store.sender().send(event::ProfilerEvent {
                kind,
                source: "cli".into(),
                payload,
            });
        }
    }
}

impl Drop for OfflineWriter {
    fn drop(&mut self) {
        if let Some((store, lock)) = self.store.take() {
            // The lock is released only once the writer has finished.
            run_within(OFFLINE_SHUTDOWN_TIMEOUT, move || {
                store.shutdown();
                drop(lock);
            });
        }
    }
}

/// Runs `work` on its own thread and waits at most `timeout` for it. Returns whether it
/// finished in time; work that did not keeps running detached.
fn run_within<F>(timeout: std::time::Duration, work: F) -> bool
where
    F: FnOnce() + Send + 'static,
{
    let (done, finished) = std::sync::mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new()
        .name("bibcode-profiler-offline-shutdown".into())
        .spawn(move || {
            work();
            let _ = done.send(());
        });
    spawned.is_ok() && finished.recv_timeout(timeout).is_ok()
}

/// An [`OfflineWriter`] for `state_dir` when its persisted `enableProfiler` setting is on and
/// no other process holds `profiler/.lock`.
pub fn offline_writer(state_dir: &Path) -> Option<OfflineWriter> {
    if !persisted_enabled(state_dir) {
        return None;
    }
    let dir = profiler_dir(state_dir);
    let lock = match runtime::lock_dir(&dir) {
        Ok(lock) => lock,
        Err(error) => {
            tracing::warn!(%error, "the profiler directory is busy; offline events are not recorded");
            return None;
        }
    };
    Some(OfflineWriter {
        store: Some((
            store::ProfilerStore::start(store::StoreConfig::new(dir)),
            lock,
        )),
    })
}

/// Queues one server event and returns its `eventId`, which a finding the event explains
/// cites in `evidence.eventIds`. Does nothing while the profiler is off; never blocks.
pub fn emit(kind: &'static str, payload: Value) -> Option<store::EventId> {
    emit_from("server".into(), kind, payload)
}

/// [`emit`] for an event from `source`, such as `client:<clientId>`.
pub fn emit_from(source: String, kind: &'static str, payload: Value) -> Option<store::EventId> {
    enabled_handle()?.sender.send(event::ProfilerEvent {
        kind,
        source,
        payload,
    })
}

/// `evidence` with `eventIds` naming the event that explains it, when that event was queued.
pub(crate) fn cite(mut evidence: Value, event_id: Option<store::EventId>) -> Value {
    if let (Value::Object(fields), Some(id)) = (&mut evidence, event_id) {
        fields.insert("eventIds".into(), Value::from(vec![id.to_string()]));
    }
    evidence
}

/// Records one finding occurrence and returns it. Does nothing while the profiler is off.
pub fn record_finding(input: findings::FindingInput) -> Option<findings::Occurrence> {
    let handle = enabled_handle()?;
    let finding = handle
        .findings
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .record(input, time::OffsetDateTime::now_utc(), &handle.sender);
    Some(findings::Occurrence {
        id: finding.id,
        count: finding.count,
    })
}

/// Adds what a later lookup found, such as an OS crash record, to the evidence of a recorded
/// occurrence. Does nothing while the profiler is off.
pub fn amend_finding(occurrence: &findings::Occurrence, extra: Map<String, Value>) {
    if let Some(handle) = enabled_handle() {
        handle
            .findings
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .amend(
                occurrence,
                extra,
                time::OffsetDateTime::now_utc(),
                &handle.sender,
            );
    }
}

#[cfg(test)]
mod offline_writer_tests {
    use std::time::{Duration, Instant};

    use super::*;

    fn enable_profiler(state_dir: &Path) {
        std::fs::write(
            state_dir.join("settings.json"),
            br#"{"enableProfiler": true}"#,
        )
        .expect("profiler settings");
    }

    #[test]
    fn offline_writer_records_nothing_while_another_writer_holds_the_profiler_lock() {
        let state_dir = tempfile::tempdir().expect("state directory");
        enable_profiler(state_dir.path());
        let runtime_lock = runtime::lock_dir(&profiler_dir(state_dir.path()))
            .expect("a runtime writer still holds the lock");

        assert!(offline_writer(state_dir.path()).is_none());

        drop(runtime_lock);
        let writer = offline_writer(state_dir.path()).expect("free lock gives a writer");
        assert!(
            runtime::lock_dir(&profiler_dir(state_dir.path())).is_err(),
            "the offline writer holds the lock for its life"
        );
        writer.emit("storage.compact", serde_json::json!({ "phase": "start" }));
        drop(writer);
        let lock = runtime::lock_dir(&profiler_dir(state_dir.path()))
            .expect("dropping the writer releases the lock");
        drop(lock);
        let events = std::fs::read_dir(profiler_dir(state_dir.path()))
            .expect("profiler directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("events-"))
            .map(|entry| std::fs::read_to_string(entry.path()).expect("events file"))
            .collect::<String>();
        assert!(events.contains("\"source\":\"cli\""), "{events}");
    }

    #[test]
    fn offline_shutdown_is_bounded_even_when_the_writer_never_finishes() {
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let started = Instant::now();

        let finished = run_within(Duration::from_millis(200), move || {
            let _ = blocked.recv();
        });

        assert!(!finished);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        drop(release);
        assert!(run_within(Duration::from_secs(5), || {}));
    }
}
