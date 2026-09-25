//! Server-owned clone operations for `vcs.clone` and `sourceControl.cloneRepository`.
//!
//! A clone is keyed by its destination: the canonical parent folder plus the derived leaf.
//! One live clone per destination. A request for the same URL joins it and shares its
//! outcome; another URL gets `busy` at once. The clone owns a root cancellation token, so a
//! caller that detached can leave (socket close, Interrupt) without stopping Git. Git runs in
//! its own task, and the outcome is published only after the folder the clone created is gone
//! (or its removal failed, which the outcome then names). Failed and cancelled outcomes are
//! retained for five minutes, per URL, so a re-attach learns the real reason; a success needs
//! no record, because the folder on disk is the record.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    sync::{Notify, watch},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

use crate::{
    git::{
        CloneLeaf, CloneReservation, GitCommandError, GitRepository, host_path_platform,
        normalize_worktree_path_key,
    },
    maintenance::RpcPermit,
};

/// Live clones one server runs at once. Admission never waits: a full runtime answers
/// `capacity` at once, like the catalog-operation runtime.
pub(crate) const CLONE_OPERATION_CAPACITY: usize = 16;
/// How long a failed or cancelled outcome answers a re-attach for the same URL.
pub(crate) const CLONE_OUTCOME_RETENTION: Duration = Duration::from_secs(5 * 60);
/// Live clones plus retained outcomes kept at once. At this bound a new clone is refused with
/// `capacity`: no outcome is ever dropped before its retention ends (spec: failed and
/// cancelled outcomes "stay in memory 5 minutes"), and memory stays bounded.
pub(crate) const CLONE_RETAINED_OUTCOME_CAPACITY: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CloneOperationReason {
    Busy,
    Capacity,
    ShuttingDown,
    NotInProgress,
    Cancelled,
}

impl CloneOperationReason {
    fn wire(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Capacity => "capacity",
            Self::ShuttingDown => "shutting-down",
            Self::NotInProgress => "not-in-progress",
            Self::Cancelled => "cancelled",
        }
    }

    fn message(self, destination: &str) -> String {
        match self {
            Self::Busy => format!("Another clone into {destination} is in progress."),
            Self::Capacity => "Too many clones are running on this server.".to_owned(),
            Self::ShuttingDown => "The server is shutting down.".to_owned(),
            Self::NotInProgress => format!("No clone is in progress for {destination}."),
            Self::Cancelled => format!("The clone into {destination} was cancelled."),
        }
    }
}

/// `GitCloneOperationError`. It never names another clone's URL, which may embed credentials.
fn clone_operation_error(reason: CloneOperationReason, destination: &Path) -> Value {
    let destination = destination.to_string_lossy().into_owned();
    json!({
        "_tag": "GitCloneOperationError",
        "reason": reason.wire(),
        "message": reason.message(&destination),
        "destination": destination,
    })
}

#[derive(Clone, Debug)]
pub(crate) struct CloneRequest {
    pub(crate) url: String,
    /// Canonical parent folder; the handler resolves it (ruling 10).
    pub(crate) parent_dir: PathBuf,
    /// `clone_destination_leaf(url, directoryName)`: one validated folder name.
    pub(crate) leaf: CloneLeaf,
    /// Join-only: never starts a clone.
    pub(crate) attach: bool,
    /// The caller leaving does not cancel a clone it started.
    pub(crate) detach: bool,
}

impl CloneRequest {
    fn destination(&self) -> PathBuf {
        self.parent_dir.join(self.leaf.as_str())
    }
}

fn destination_key(destination: &Path) -> String {
    normalize_worktree_path_key(destination, host_path_platform())
}

#[derive(Clone, Debug)]
enum CloneOutcome {
    Succeeded(PathBuf),
    Failed(Value),
    Cancelled,
}

#[derive(Clone, Debug)]
enum ClonePhase {
    Running,
    Finished(CloneOutcome),
}

struct CloneEntry {
    id: u64,
    url: String,
    root: CancellationToken,
    phase: watch::Sender<ClonePhase>,
    /// When a retained outcome expires; `None` while the clone is live.
    expires_at: Option<Instant>,
}

impl CloneEntry {
    fn is_live(&self) -> bool {
        self.expires_at.is_none()
    }
}

#[derive(Default)]
struct CloneRuntimeState {
    closed: bool,
    /// Counts starts; an attach compares it before and after reading the disk.
    next_id: u64,
    live: usize,
    entries: HashMap<String, CloneEntry>,
}

impl CloneRuntimeState {
    /// Drops expired retained outcomes. Runs on every access, so no outcome outlives its
    /// retention waiting for a later admission.
    fn sweep(&mut self, now: Instant) {
        self.entries
            .retain(|_, entry| entry.expires_at.is_none_or(|expires_at| expires_at > now));
    }
}

struct CloneRuntimeInner {
    repository: Arc<GitRepository>,
    capacity: usize,
    retention: Duration,
    retained_capacity: usize,
    state: Mutex<CloneRuntimeState>,
    drained: Notify,
    #[cfg(test)]
    pauses: test_pauses::TestPauses,
}

#[derive(Clone)]
pub(crate) struct CloneRuntime {
    inner: Arc<CloneRuntimeInner>,
}

enum Admission {
    Join(watch::Receiver<ClonePhase>),
    WaitForCleanup(watch::Receiver<ClonePhase>),
    Started {
        receiver: watch::Receiver<ClonePhase>,
        root: CancellationToken,
    },
    Retained(CloneOutcome),
    Inspect {
        generation: u64,
    },
    Refused(CloneOperationReason),
}

impl CloneRuntime {
    pub(crate) fn new(repository: Arc<GitRepository>) -> Self {
        Self {
            inner: Arc::new(CloneRuntimeInner {
                repository,
                capacity: CLONE_OPERATION_CAPACITY,
                retention: CLONE_OUTCOME_RETENTION,
                retained_capacity: CLONE_RETAINED_OUTCOME_CAPACITY,
                state: Mutex::default(),
                drained: Notify::new(),
                #[cfg(test)]
                pauses: test_pauses::TestPauses::default(),
            }),
        }
    }

    #[cfg(test)]
    fn for_test(
        repository: Arc<GitRepository>,
        capacity: usize,
        retention: Duration,
        retained_capacity: usize,
        pauses: test_pauses::TestPauses,
    ) -> Self {
        Self {
            inner: Arc::new(CloneRuntimeInner {
                repository,
                capacity,
                retention,
                retained_capacity,
                state: Mutex::default(),
                drained: Notify::new(),
                pauses,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, CloneRuntimeState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Starts a clone, joins the running clone of the same URL, or (with `attach`) only reports
    /// on it. Leaving is dropping this future: the RPC layer does that on Interrupt, socket
    /// teardown, or a dropped handler, and answers with an `Interrupt` exit. Leaving ends this
    /// caller's wait, and stops the clone only when this caller started it without `detach`.
    /// `cancellation` bounds only the disk check an `attach` may run.
    pub(crate) async fn start_or_join(
        &self,
        request: CloneRequest,
        admission: Option<RpcPermit>,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, Value> {
        let destination = request.destination();
        let mut admission = admission;
        loop {
            match self.admit(&request, &mut admission) {
                Admission::Refused(reason) => {
                    return Err(clone_operation_error(reason, &destination));
                }
                Admission::WaitForCleanup(receiver) => {
                    wait_finished(receiver, &destination).await;
                }
                Admission::Join(receiver) => {
                    let outcome = wait_finished(receiver, &destination).await;
                    return outcome_result(outcome, &destination);
                }
                Admission::Retained(outcome) => return outcome_result(outcome, &destination),
                Admission::Inspect { generation } => {
                    #[cfg(test)]
                    self.inner
                        .pauses
                        .wait(test_pauses::PausePoint::BeforeInspect)
                        .await;
                    let inspected = self
                        .inner
                        .repository
                        .inspect_clone_destination(
                            &request.url,
                            &request.parent_dir,
                            &request.leaf,
                            cancellation,
                        )
                        .await;
                    // A clone admitted while the disk was being read may own what was seen:
                    // admit again (and join it) instead of reporting its half-written folder.
                    if self.lock().next_id != generation {
                        continue;
                    }
                    return match inspected {
                        Ok(Some(path)) => Ok(path),
                        Ok(None) => Err(clone_operation_error(
                            CloneOperationReason::NotInProgress,
                            &destination,
                        )),
                        Err(error) => Err(serialize(error)),
                    };
                }
                Admission::Started { receiver, root } => {
                    // Older clients keep today's Cancel: a starter without `detach` stops the
                    // clone when it leaves.
                    let cancel_on_leave = (!request.detach).then(|| root.drop_guard());
                    let outcome = wait_finished(receiver, &destination).await;
                    if let Some(guard) = cancel_on_leave {
                        let _ = guard.disarm();
                    }
                    return outcome_result(outcome, &destination);
                }
            }
        }
    }

    /// Cancels the live clone of `url` into this destination and waits until its outcome is
    /// published, which happens after Git has stopped and the folder it created is gone.
    /// `true` when that clone did not finish successfully: it ended cancelled, or as a failure
    /// naming a folder it could not remove. `false` when no clone of that URL was live, or Git
    /// had already succeeded; a finished clone is never touched. A caller that leaves drops
    /// this future, and the RPC layer reports that as an interrupt. The clone stays cancelled.
    pub(crate) async fn cancel(&self, url: &str, parent_dir: &Path, leaf: &CloneLeaf) -> bool {
        let destination = parent_dir.join(leaf.as_str());
        let receiver = {
            let mut state = self.lock();
            state.sweep(Instant::now());
            let Some(entry) = state
                .entries
                .get(&destination_key(&destination))
                .filter(|entry| entry.is_live() && entry.url == url)
            else {
                return false;
            };
            entry.root.cancel();
            entry.phase.subscribe()
        };
        !matches!(
            wait_finished(receiver, &destination).await,
            CloneOutcome::Succeeded(_)
        )
    }

    /// Shutdown: refuse new clones, cancel every live one, and wait until each has published
    /// its outcome, which happens after Git stopped and the folder it created was removed.
    pub(crate) async fn close_and_drain(&self) {
        {
            let mut state = self.lock();
            state.closed = true;
            for entry in state.entries.values().filter(|entry| entry.is_live()) {
                entry.root.cancel();
            }
        }
        loop {
            let notified = self.inner.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.lock().live == 0 {
                return;
            }
            notified.await;
        }
    }

    fn admit(&self, request: &CloneRequest, admission: &mut Option<RpcPermit>) -> Admission {
        let key = destination_key(&request.destination());
        let mut state = self.lock();
        state.sweep(Instant::now());
        if let Some(entry) = state.entries.get(&key) {
            if entry.is_live() {
                if entry.url != request.url {
                    return Admission::Refused(CloneOperationReason::Busy);
                }
                let receiver = entry.phase.subscribe();
                return if entry.root.is_cancelled() && !request.attach {
                    Admission::WaitForCleanup(receiver)
                } else {
                    Admission::Join(receiver)
                };
            }
            // A retained outcome answers only a re-attach for the same URL.
            if request.attach
                && entry.url == request.url
                && let ClonePhase::Finished(outcome) = &*entry.phase.borrow()
            {
                return Admission::Retained(outcome.clone());
            }
        }
        // Closed: a retained outcome above still answers (D9); nothing new starts or inspects.
        if state.closed {
            return Admission::Refused(CloneOperationReason::ShuttingDown);
        }
        if request.attach {
            return Admission::Inspect {
                generation: state.next_id,
            };
        }
        // The bound is enforced here, at admission, never by dropping an outcome early. A start
        // replaces this destination's own retained outcome (any entry left under `key` is not
        // live), so that outcome does not count.
        let occupied = state.entries.len() - usize::from(state.entries.contains_key(&key));
        if state.live >= self.inner.capacity || occupied >= self.inner.retained_capacity {
            return Admission::Refused(CloneOperationReason::Capacity);
        }
        state.entries.remove(&key);
        state.next_id = state.next_id.wrapping_add(1);
        let id = state.next_id;
        let root = CancellationToken::new();
        let (phase, receiver) = watch::channel(ClonePhase::Running);
        state.entries.insert(
            key.clone(),
            CloneEntry {
                id,
                url: request.url.clone(),
                root: root.clone(),
                phase,
                expires_at: None,
            },
        );
        state.live += 1;
        drop(state);
        self.spawn(key, id, request.clone(), root.clone(), admission.take());
        Admission::Started { receiver, root }
    }

    fn spawn(
        &self,
        key: String,
        id: u64,
        request: CloneRequest,
        root: CancellationToken,
        admission: Option<RpcPermit>,
    ) {
        let runtime = self.clone();
        tokio::spawn(async move {
            // Held until the outcome is published: locals drop in reverse order, so `finish`
            // below publishes first and the permit goes last. The update drain therefore names
            // this clone, even after its caller detached, until its cleanup has settled.
            let _admission = admission;
            // Publishes a failure if this task itself panics, so waiters never hang. Only
            // reservation, cleanup, and publishing run here; the transfer has its own task.
            let mut finish = FinishGuard {
                runtime: runtime.clone(),
                destination: request.destination(),
                key,
                id,
                outcome: None,
            };
            finish.outcome = Some(runtime.run_clone(&request, &root).await);
            #[cfg(test)]
            runtime
                .inner
                .pauses
                .wait(test_pauses::PausePoint::BeforePublish)
                .await;
        });
    }

    async fn run_clone(&self, request: &CloneRequest, root: &CancellationToken) -> CloneOutcome {
        #[cfg(test)]
        self.inner
            .pauses
            .wait(test_pauses::PausePoint::BeforeReserve)
            .await;
        // Cancelled before it reserved anything: nothing to remove.
        if root.is_cancelled() {
            return CloneOutcome::Cancelled;
        }
        let reserved = match self
            .inner
            .repository
            .reserve_clone_destination(&request.url, &request.parent_dir, &request.leaf, root)
            .await
        {
            Ok(CloneReservation::Existing(path)) => return CloneOutcome::Succeeded(path),
            Ok(CloneReservation::Reserved(reserved)) => Arc::new(reserved),
            // A failed reservation created no folder.
            Err(_) if root.is_cancelled() => return CloneOutcome::Cancelled,
            Err(error) => return CloneOutcome::Failed(serialize(error)),
        };
        // Git runs in its own task, so a panic there still leaves this task to remove the
        // folder before the outcome is published and the slot is freed.
        let transfer = {
            let reserved = Arc::clone(&reserved);
            let root = root.clone();
            tokio::spawn(async move { reserved.transfer(&root).await })
        };
        let transferred = transfer.await;
        #[cfg(test)]
        self.inner
            .pauses
            .wait(test_pauses::PausePoint::AfterTransfer)
            .await;
        let error = match transferred {
            Ok(Ok(path)) => return CloneOutcome::Succeeded(path),
            Ok(Err(error)) => error,
            Err(join_error) => {
                stopped_unexpectedly(&request.destination(), &join_error.to_string())
            }
        };
        match reserved.remove_destination().await {
            Ok(()) if root.is_cancelled() => CloneOutcome::Cancelled,
            Ok(()) => CloneOutcome::Failed(serialize(error)),
            // A cancelled clone whose folder could not be removed reports the leftover, not a
            // clean cancel.
            Err(cleanup_error) => CloneOutcome::Failed(serialize(
                reserved.with_cleanup_failure(error, &cleanup_error),
            )),
        }
    }

    /// Publishes the outcome and frees the slot in one step. Runs only after the transfer and
    /// its cleanup have settled.
    fn finish(&self, key: &str, id: u64, outcome: CloneOutcome) {
        let mut state = self.lock();
        if !state.entries.get(key).is_some_and(|entry| entry.id == id) {
            return;
        }
        if matches!(outcome, CloneOutcome::Succeeded(_)) {
            if let Some(entry) = state.entries.remove(key) {
                entry.phase.send_replace(ClonePhase::Finished(outcome));
            }
        } else if let Some(entry) = state.entries.get_mut(key) {
            entry.phase.send_replace(ClonePhase::Finished(outcome));
            entry.expires_at = Some(Instant::now() + self.inner.retention);
        }
        state.live = state.live.saturating_sub(1);
        state.sweep(Instant::now());
        let drained = state.live == 0;
        drop(state);
        if drained {
            self.inner.drained.notify_waiters();
        }
    }

    /// Callers waiting on the live clone of this destination.
    #[cfg(test)]
    fn waiters(&self, destination: &Path) -> usize {
        self.lock()
            .entries
            .get(&destination_key(destination))
            .filter(|entry| entry.is_live())
            .map_or(0, |entry| entry.phase.receiver_count())
    }

    #[cfg(test)]
    fn live(&self) -> usize {
        self.lock().live
    }

    #[cfg(test)]
    fn retained_len(&self) -> usize {
        self.lock()
            .entries
            .values()
            .filter(|entry| !entry.is_live())
            .count()
    }
}

/// Publishes the outcome when the clone's task ends, including by a panic outside the transfer,
/// so waiters never hang.
struct FinishGuard {
    runtime: CloneRuntime,
    destination: PathBuf,
    key: String,
    id: u64,
    outcome: Option<CloneOutcome>,
}

impl Drop for FinishGuard {
    fn drop(&mut self) {
        let outcome = self.outcome.take().unwrap_or_else(|| {
            CloneOutcome::Failed(serialize(stopped_unexpectedly(
                &self.destination,
                "the clone task stopped",
            )))
        });
        self.runtime.finish(&self.key, self.id, outcome);
    }
}

async fn wait_finished(
    mut receiver: watch::Receiver<ClonePhase>,
    destination: &Path,
) -> CloneOutcome {
    let _ = receiver
        .wait_for(|phase| matches!(phase, ClonePhase::Finished(_)))
        .await;
    // A succeeded entry is removed right after its final send, so read the last value whether
    // or not the sender is still alive.
    match &*receiver.borrow() {
        ClonePhase::Finished(outcome) => outcome.clone(),
        ClonePhase::Running => CloneOutcome::Failed(serialize(stopped_unexpectedly(
            destination,
            "the clone ended without an outcome",
        ))),
    }
}

fn outcome_result(outcome: CloneOutcome, destination: &Path) -> Result<PathBuf, Value> {
    match outcome {
        CloneOutcome::Succeeded(path) => Ok(path),
        CloneOutcome::Failed(error) => Err(error),
        CloneOutcome::Cancelled => Err(clone_operation_error(
            CloneOperationReason::Cancelled,
            destination,
        )),
    }
}

fn stopped_unexpectedly(destination: &Path, reason: &str) -> GitCommandError {
    GitCommandError {
        tag: "GitCommandError",
        operation: "GitVcsDriver.clone".into(),
        command: "git".into(),
        cwd: destination.to_string_lossy().into(),
        diagnostics: None,
        detail: format!("The clone stopped unexpectedly ({reason}). Try again.").into(),
    }
}

fn serialize(error: GitCommandError) -> Value {
    serde_json::to_value(error).unwrap_or_else(
        |error| json!({ "_tag": "RpcSerializationError", "message": error.to_string() }),
    )
}

/// Deterministic interleavings for the tests: a pause stops the runtime at one point, once,
/// until the test releases it. Nothing here compiles into the server.
#[cfg(test)]
mod test_pauses {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use tokio::sync::{Notify, Semaphore};

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(super) enum PausePoint {
        /// In the clone's task, after the transfer returned and before its result decides
        /// between success and cleanup.
        AfterTransfer,
        /// In an `attach` caller, before it reads the disk.
        BeforeInspect,
        /// In the clone's task, before it reserves the destination.
        BeforeReserve,
        /// In the clone's task, after the clone and its cleanup returned and before the outcome
        /// is published.
        BeforePublish,
    }

    pub(super) struct Pause {
        point: PausePoint,
        fired: AtomicBool,
        arrival: Notify,
        release: Semaphore,
    }

    impl Pause {
        pub(super) async fn arrived(&self) {
            self.arrival.notified().await;
        }

        pub(super) fn release(&self) {
            self.release.add_permits(1);
        }
    }

    #[derive(Clone, Default)]
    pub(super) struct TestPauses(Option<Arc<Pause>>);

    impl TestPauses {
        pub(super) fn at(point: PausePoint) -> (Self, Arc<Pause>) {
            let pause = Arc::new(Pause {
                point,
                fired: AtomicBool::new(false),
                arrival: Notify::new(),
                release: Semaphore::new(0),
            });
            (Self(Some(Arc::clone(&pause))), pause)
        }

        pub(super) async fn wait(&self, point: PausePoint) {
            let Some(pause) = &self.0 else {
                return;
            };
            if pause.point != point || pause.fired.swap(true, Ordering::SeqCst) {
                return;
            }
            pause.arrival.notify_one();
            pause
                .release
                .acquire()
                .await
                .expect("the pause semaphore stays open")
                .forget();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        process::Command,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use serde_json::Value;
    use tokio::{
        sync::{Notify, Semaphore},
        time::{Instant, timeout},
    };
    use tokio_util::sync::CancellationToken;

    use super::{
        CloneRequest, CloneRuntime,
        test_pauses::{PausePoint, TestPauses},
    };
    use crate::{
        git::{
            BoxGitProcessFuture, CloneLeaf, GitProcessRunner, GitRepository, ProcessError,
            ProcessRequest, ProcessRunner, clone_destination_leaf,
        },
        maintenance::{RpcAdmissionGate, RpcMutability},
    };

    const DEADLINE: Duration = Duration::from_secs(20);

    /// Stands in for `git clone` around the real command. The transfer waits until the test
    /// releases it or the clone is cancelled. Flags inject a held cancellation, a replaced
    /// folder, or a panic. Every other Git command runs unchanged.
    struct HeldCloneRunner {
        started: Notify,
        release: Semaphore,
        clones: AtomicUsize,
        /// On cancellation, report it only after `release_cancelled`: Git has exited, and its
        /// folder is still there.
        hold_after_cancel: AtomicBool,
        cancel_held: Notify,
        release_cancelled: Semaphore,
        /// On cancellation, put a different folder at the destination, so the identity-checked
        /// cleanup must refuse to remove it.
        replace_on_cancel: AtomicBool,
        /// Panic inside the transfer.
        panic_on_clone: AtomicBool,
    }

    impl HeldCloneRunner {
        fn new() -> Self {
            Self {
                started: Notify::new(),
                release: Semaphore::new(0),
                clones: AtomicUsize::new(0),
                hold_after_cancel: AtomicBool::new(false),
                cancel_held: Notify::new(),
                release_cancelled: Semaphore::new(0),
                replace_on_cancel: AtomicBool::new(false),
                panic_on_clone: AtomicBool::new(false),
            }
        }
    }

    impl GitProcessRunner for HeldCloneRunner {
        fn run<'a>(
            &'a self,
            request: ProcessRequest,
            cancellation: &'a CancellationToken,
        ) -> BoxGitProcessFuture<'a> {
            Box::pin(async move {
                if !request.args.iter().any(|argument| argument == "clone") {
                    return ProcessRunner.run(request, cancellation).await;
                }
                self.clones.fetch_add(1, Ordering::SeqCst);
                assert!(
                    !self.panic_on_clone.load(Ordering::SeqCst),
                    "injected transfer panic"
                );
                self.started.notify_one();
                tokio::select! {
                    () = cancellation.cancelled() => {
                        let destination = request
                            .cwd
                            .join(request.args.last().expect("the clone's destination argument"));
                        if self.replace_on_cancel.load(Ordering::SeqCst) {
                            std::fs::rename(&destination, destination.with_extension("moved"))
                                .expect("move the clone's folder away");
                            std::fs::create_dir(&destination)
                                .expect("put a different folder in its place");
                        }
                        if self.hold_after_cancel.load(Ordering::SeqCst) {
                            self.cancel_held.notify_one();
                            self.release_cancelled
                                .acquire()
                                .await
                                .expect("the release semaphore stays open")
                                .forget();
                        }
                        return Err(ProcessError::Cancelled { operation: request.operation });
                    }
                    permit = self.release.acquire() => {
                        permit.expect("the release semaphore stays open").forget();
                    }
                }
                ProcessRunner.run(request, cancellation).await
            })
        }
    }

    struct Limits {
        capacity: usize,
        retention: Duration,
        retained: usize,
        pauses: TestPauses,
    }

    impl Default for Limits {
        fn default() -> Self {
            Self {
                capacity: super::CLONE_OPERATION_CAPACITY,
                retention: super::CLONE_OUTCOME_RETENTION,
                retained: super::CLONE_RETAINED_OUTCOME_CAPACITY,
                pauses: TestPauses::default(),
            }
        }
    }

    struct Harness {
        _root: tempfile::TempDir,
        base: PathBuf,
        parent: PathBuf,
        url: String,
        other_url: String,
        runner: Arc<HeldCloneRunner>,
        runtime: CloneRuntime,
    }

    impl Harness {
        /// A `file://` URL with no repository behind it: Git fails at once when released.
        fn missing_url(&self) -> String {
            file_url(&self.base.join("missing.git"))
        }
    }

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Clone Runtime Test")
            .env("GIT_AUTHOR_EMAIL", "clone-runtime@example.test")
            .env("GIT_COMMITTER_NAME", "Clone Runtime Test")
            .env("GIT_COMMITTER_EMAIL", "clone-runtime@example.test")
            .status()
            .expect("git starts");
        assert!(status.success(), "git {args:?} failed");
    }

    fn file_url(path: &Path) -> String {
        let normalized = path.to_string_lossy().replace('\\', "/");
        format!("file:///{}", normalized.trim_start_matches('/'))
    }

    fn source_repository(root: &Path, name: &str) -> String {
        let source = root.join(name);
        std::fs::create_dir(&source).expect("source repository");
        git(&source, &["init", "-q", "-b", "main"]);
        std::fs::write(source.join("tracked.txt"), "tracked\n").expect("tracked file");
        git(&source, &["add", "tracked.txt"]);
        git(
            &source,
            &[
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-q",
                "-m",
                "initial",
            ],
        );
        file_url(&source)
    }

    fn harness(limits: Limits) -> Harness {
        let root = tempfile::tempdir().expect("temporary root");
        let base = std::fs::canonicalize(root.path()).expect("canonical root");
        let parent = base.join("clones");
        std::fs::create_dir(&parent).expect("clone parent");
        let url = source_repository(&base, "source");
        let other_url = source_repository(&base, "other-source");
        let runner = Arc::new(HeldCloneRunner::new());
        let repository = Arc::new(GitRepository::with_runner_for_test(runner.clone()));
        Harness {
            _root: root,
            base,
            parent,
            url,
            other_url,
            runner,
            runtime: CloneRuntime::for_test(
                repository,
                limits.capacity,
                limits.retention,
                limits.retained,
                limits.pauses,
            ),
        }
    }

    fn standard() -> Harness {
        harness(Limits::default())
    }

    /// A validated folder name, as the handlers make one.
    fn leaf(name: &str) -> CloneLeaf {
        clone_destination_leaf("https://example.test/unused.git", Some(name))
            .expect("a single folder name")
    }

    fn request(harness: &Harness, url: &str, name: &str) -> CloneRequest {
        CloneRequest {
            url: url.to_owned(),
            parent_dir: harness.parent.clone(),
            leaf: leaf(name),
            attach: false,
            detach: true,
        }
    }

    fn attach(mut request: CloneRequest) -> CloneRequest {
        request.attach = true;
        request
    }

    fn undetached(mut request: CloneRequest) -> CloneRequest {
        request.detach = false;
        request
    }

    fn spawn_clone(
        harness: &Harness,
        request: CloneRequest,
    ) -> tokio::task::JoinHandle<Result<PathBuf, Value>> {
        let runtime = harness.runtime.clone();
        tokio::spawn(async move {
            runtime
                .start_or_join(request, None, &CancellationToken::new())
                .await
        })
    }

    /// What an RPC interrupt does to a handler: drop its future. Awaiting the aborted task
    /// waits until the future, and any drop guard in it, is gone.
    async fn leave(handle: tokio::task::JoinHandle<Result<PathBuf, Value>>) {
        handle.abort();
        let _ = handle.await;
    }

    async fn transfer_started(harness: &Harness) {
        timeout(DEADLINE, harness.runner.started.notified())
            .await
            .expect("the clone reached its transfer");
    }

    async fn finished(
        handle: tokio::task::JoinHandle<Result<PathBuf, Value>>,
    ) -> Result<PathBuf, Value> {
        timeout(DEADLINE, handle)
            .await
            .expect("the clone call finished")
            .expect("the clone call did not panic")
    }

    async fn call(harness: &Harness, request: CloneRequest) -> Result<PathBuf, Value> {
        timeout(
            DEADLINE,
            harness
                .runtime
                .start_or_join(request, None, &CancellationToken::new()),
        )
        .await
        .expect("the call answered")
    }

    fn reason(error: &Value) -> &str {
        assert_eq!(
            error["_tag"], "GitCloneOperationError",
            "unexpected error {error}"
        );
        error["reason"].as_str().expect("reason")
    }

    async fn wait_until(mut condition: impl FnMut() -> bool, context: &str) {
        let deadline = Instant::now() + DEADLINE;
        while !condition() {
            assert!(Instant::now() < deadline, "timed out: {context}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_detached_starter_leaves_the_clone_running_and_an_attach_joins_it() {
        let harness = standard();
        let destination = harness.parent.join("detached");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "detached"));
        transfer_started(&harness).await;
        leave(starter).await;
        assert!(
            destination.is_dir(),
            "the detached clone keeps running and keeps its folder"
        );
        assert_eq!(
            harness.runtime.waiters(&destination),
            0,
            "nobody waits once the starter left"
        );

        let joiner = spawn_clone(
            &harness,
            attach(request(&harness, &harness.url, "detached")),
        );
        // Prove the join before the transfer may finish: the attach waits on the live clone.
        wait_until(
            || harness.runtime.waiters(&destination) == 1,
            "the attach joined",
        )
        .await;
        harness.runner.release.add_permits(1);
        assert_eq!(
            finished(joiner)
                .await
                .expect("the joiner shares the outcome"),
            destination
        );
        assert_eq!(
            harness.runner.clones.load(Ordering::SeqCst),
            1,
            "one transfer only"
        );
        assert_eq!(harness.runtime.live(), 0);
        assert_eq!(
            harness.runtime.retained_len(),
            0,
            "a success leaves no entry behind"
        );
    }

    #[tokio::test]
    async fn a_starter_without_detach_cancels_on_leaving_and_a_retry_waits_for_its_cleanup() {
        let harness = standard();
        harness
            .runner
            .hold_after_cancel
            .store(true, Ordering::SeqCst);
        let destination = harness.parent.join("retried");
        let first = spawn_clone(
            &harness,
            undetached(request(&harness, &harness.url, "retried")),
        );
        transfer_started(&harness).await;
        leave(first).await;
        timeout(DEADLINE, harness.runner.cancel_held.notified())
            .await
            .expect("leaving stopped Git");
        assert!(
            destination.is_dir(),
            "the cancelled clone's folder is still there"
        );
        std::fs::write(destination.join("cancelled-clone-leftover"), "leftover\n")
            .expect("leftover marker");

        let retry = spawn_clone(
            &harness,
            undetached(request(&harness, &harness.url, "retried")),
        );
        // A second retry that gives up while waiting disturbs nobody.
        let impatient = spawn_clone(
            &harness,
            undetached(request(&harness, &harness.url, "retried")),
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !retry.is_finished(),
            "the retry waits for the cancelled clone's cleanup"
        );
        assert_eq!(harness.runner.clones.load(Ordering::SeqCst), 1);
        leave(impatient).await;

        harness.runner.release_cancelled.add_permits(1);
        transfer_started(&harness).await;
        assert_eq!(
            harness.runner.clones.load(Ordering::SeqCst),
            2,
            "the retry ran its own transfer"
        );
        assert!(destination.is_dir(), "the retry reserved the folder again");
        assert!(
            !destination.join("cancelled-clone-leftover").exists(),
            "the retry reserved only after the cleanup removed the old folder"
        );
        harness.runner.release.add_permits(1);
        assert_eq!(
            finished(retry).await.expect("the retry succeeds"),
            destination
        );
    }

    #[tokio::test]
    async fn joiners_never_cancel_by_leaving() {
        let harness = standard();
        let destination = harness.parent.join("joined");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "joined"));
        transfer_started(&harness).await;
        let joiner = spawn_clone(
            &harness,
            undetached(request(&harness, &harness.url, "joined")),
        );
        wait_until(
            || harness.runtime.waiters(&destination) == 2,
            "the joiner joined",
        )
        .await;
        leave(joiner).await;
        harness.runner.release.add_permits(1);
        assert_eq!(
            finished(starter)
                .await
                .expect("a leaving joiner never cancels the clone"),
            destination
        );
    }

    #[tokio::test]
    async fn another_url_is_busy_at_once_and_the_error_never_names_the_running_url() {
        let harness = standard();
        let destination = harness.parent.join("busy");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "busy"));
        transfer_started(&harness).await;
        for other in [
            request(&harness, &harness.other_url, "busy"),
            attach(request(&harness, &harness.other_url, "busy")),
        ] {
            let error = timeout(
                Duration::from_secs(1),
                harness
                    .runtime
                    .start_or_join(other, None, &CancellationToken::new()),
            )
            .await
            .expect("busy is answered at once")
            .expect_err("another URL is refused");
            assert_eq!(reason(&error), "busy");
            assert_eq!(
                error["destination"],
                destination.to_string_lossy().into_owned()
            );
            assert!(
                !error.to_string().contains(&harness.url),
                "busy never names the running clone's URL, which may embed credentials"
            );
        }
        harness.runner.release.add_permits(1);
        assert_eq!(
            finished(starter)
                .await
                .expect("the running clone is untouched"),
            destination
        );
    }

    #[tokio::test]
    async fn admission_is_bounded_without_waiting() {
        let harness = harness(Limits {
            capacity: 1,
            ..Limits::default()
        });
        let first = spawn_clone(&harness, request(&harness, &harness.url, "one"));
        transfer_started(&harness).await;
        let refused = timeout(
            Duration::from_secs(1),
            harness.runtime.start_or_join(
                request(&harness, &harness.url, "two"),
                None,
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("capacity is answered at once")
        .expect_err("a full runtime refuses");
        assert_eq!(reason(&refused), "capacity");
        assert!(
            !harness.parent.join("two").exists(),
            "a refused clone reserves nothing"
        );

        harness.runner.release.add_permits(1);
        finished(first).await.expect("the first clone finishes");
        let second = spawn_clone(&harness, request(&harness, &harness.url, "two"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        finished(second)
            .await
            .expect("a freed slot admits the next clone");
    }

    #[tokio::test]
    async fn attach_reports_nothing_a_finished_clone_or_the_same_url_s_retained_failure() {
        let harness = standard();
        let nothing = call(&harness, attach(request(&harness, &harness.url, "nothing")))
            .await
            .expect_err("nothing is in progress");
        assert_eq!(reason(&nothing), "not-in-progress");
        assert!(
            !harness.parent.join("nothing").exists(),
            "attach never reserves"
        );

        // An ordinary failure is retained for its URL.
        let missing = harness.missing_url();
        let failing = spawn_clone(&harness, request(&harness, &missing, "failed"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        let failure = finished(failing).await.expect_err("a missing remote fails");
        assert_eq!(failure["_tag"], "GitCommandError");
        assert!(
            !harness.parent.join("failed").exists(),
            "published after its cleanup"
        );
        let retained = call(&harness, attach(request(&harness, &missing, "failed")))
            .await
            .expect_err("the same URL learns the real reason");
        assert_eq!(retained, failure);
        // Another URL never receives it.
        let other = call(&harness, attach(request(&harness, &harness.url, "failed")))
            .await
            .expect_err("another URL sees no clone");
        assert_eq!(reason(&other), "not-in-progress");

        // A finished clone is found on disk.
        let done = spawn_clone(&harness, request(&harness, &harness.url, "done"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        let path = finished(done).await.expect("the clone succeeds");
        assert_eq!(
            call(&harness, attach(request(&harness, &harness.url, "done")))
                .await
                .expect("a finished clone is found on disk"),
            path
        );
    }

    #[tokio::test]
    async fn outcomes_are_never_dropped_early_and_a_full_runtime_refuses_until_they_expire() {
        assert_eq!(
            super::CLONE_OUTCOME_RETENTION,
            Duration::from_secs(5 * 60),
            "each outcome keeps five minutes in production"
        );
        let harness = harness(Limits {
            retention: Duration::from_secs(3),
            retained: 2,
            ..Limits::default()
        });
        let missing = harness.missing_url();
        for leaf in ["first", "second"] {
            let failing = spawn_clone(&harness, request(&harness, &missing, leaf));
            transfer_started(&harness).await;
            harness.runner.release.add_permits(1);
            finished(failing).await.expect_err("a missing remote fails");
        }

        // At the bound, a clone into another folder is refused at once, and nothing is dropped.
        let refused = call(&harness, request(&harness, &harness.url, "third"))
            .await
            .expect_err("the runtime is full");
        assert_eq!(reason(&refused), "capacity");
        assert!(
            !harness.parent.join("third").exists(),
            "a refused clone reserves nothing"
        );
        for leaf in ["first", "second"] {
            let kept = call(&harness, attach(request(&harness, &missing, leaf)))
                .await
                .expect_err("kept");
            assert_eq!(
                kept["_tag"], "GitCommandError",
                "an outcome keeps its full retention"
            );
        }

        // A start into a folder whose own outcome is retained replaces that outcome, so it is
        // admitted; failing again keeps the runtime at its bound.
        let replacing = spawn_clone(&harness, request(&harness, &missing, "first"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        finished(replacing)
            .await
            .expect_err("the replacement fails again");
        let still_full = call(&harness, request(&harness, &harness.url, "third"))
            .await
            .expect_err("still full");
        assert_eq!(reason(&still_full), "capacity");

        // Once the outcomes have expired, the next access sweeps them and a clone is admitted.
        tokio::time::sleep(Duration::from_millis(3500)).await;
        let admitted = spawn_clone(&harness, request(&harness, &harness.url, "third"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        finished(admitted)
            .await
            .expect("admitted again after the outcomes expired");
        assert_eq!(
            harness.runtime.retained_len(),
            0,
            "the admission swept every expired outcome"
        );
    }

    #[tokio::test]
    async fn a_new_start_replays_no_retained_outcome() {
        let harness = standard();
        let destination = harness.parent.join("restarted");
        let first = spawn_clone(
            &harness,
            undetached(request(&harness, &harness.url, "restarted")),
        );
        transfer_started(&harness).await;
        leave(first).await;
        wait_until(
            || harness.runtime.retained_len() == 1,
            "the cancelled outcome is retained",
        )
        .await;

        let restart = spawn_clone(&harness, request(&harness, &harness.url, "restarted"));
        transfer_started(&harness).await;
        assert_eq!(
            harness.runner.clones.load(Ordering::SeqCst),
            2,
            "the new start ran its own transfer"
        );
        harness.runner.release.add_permits(1);
        assert_eq!(
            finished(restart).await.expect("the restart succeeds"),
            destination
        );
    }

    #[tokio::test]
    async fn a_cancelled_clone_whose_folder_cannot_be_removed_reports_the_leftover() {
        let harness = standard();
        harness
            .runner
            .replace_on_cancel
            .store(true, Ordering::SeqCst);
        let destination = harness.parent.join("leftover");
        let starter = spawn_clone(
            &harness,
            undetached(request(&harness, &harness.url, "leftover")),
        );
        transfer_started(&harness).await;
        let joiner = spawn_clone(
            &harness,
            attach(request(&harness, &harness.url, "leftover")),
        );
        wait_until(
            || harness.runtime.waiters(&destination) == 2,
            "the attach joined",
        )
        .await;
        leave(starter).await;

        let failure = finished(joiner).await.expect_err("the cleanup failed");
        assert_eq!(
            failure["_tag"], "GitCommandError",
            "not a clean cancel: {failure}"
        );
        let detail = failure["detail"].as_str().expect("detail");
        assert!(detail.contains("could not be removed"), "{detail}");
        assert!(detail.contains(&*destination.to_string_lossy()), "{detail}");
        assert!(
            destination.is_dir(),
            "a folder the clone did not create is never removed"
        );
        let retained = call(
            &harness,
            attach(request(&harness, &harness.url, "leftover")),
        )
        .await
        .expect_err("retained");
        assert_eq!(retained, failure);
    }

    #[tokio::test]
    async fn a_panicking_transfer_still_removes_its_folder_before_its_slot_is_freed() {
        let harness = harness(Limits {
            capacity: 1,
            ..Limits::default()
        });
        harness.runner.panic_on_clone.store(true, Ordering::SeqCst);
        let destination = harness.parent.join("panicked");
        let failure = call(&harness, request(&harness, &harness.url, "panicked"))
            .await
            .expect_err("a panicking transfer fails");
        assert_eq!(failure["_tag"], "GitCommandError");
        assert!(
            failure["detail"]
                .as_str()
                .expect("detail")
                .contains("stopped unexpectedly"),
            "{failure}"
        );
        assert!(
            !destination.exists(),
            "the folder was removed before the outcome was published"
        );

        harness.runner.panic_on_clone.store(false, Ordering::SeqCst);
        let next = spawn_clone(&harness, request(&harness, &harness.url, "next"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        finished(next)
            .await
            .expect("the freed slot admits the next clone");
    }

    #[tokio::test]
    async fn an_attach_that_raced_a_new_clone_joins_it_instead_of_reading_its_folder() {
        let (pauses, inspect) = TestPauses::at(PausePoint::BeforeInspect);
        let harness = harness(Limits {
            pauses,
            ..Limits::default()
        });
        let destination = harness.parent.join("raced");
        let attaching = spawn_clone(&harness, attach(request(&harness, &harness.url, "raced")));
        timeout(DEADLINE, inspect.arrived())
            .await
            .expect("the attach reached its disk check");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "raced"));
        transfer_started(&harness).await;
        assert!(
            destination.is_dir(),
            "the new clone reserved the folder the attach will read"
        );

        inspect.release();
        wait_until(
            || harness.runtime.waiters(&destination) == 2,
            "the attach joined",
        )
        .await;
        harness.runner.release.add_permits(1);
        assert_eq!(
            finished(attaching)
                .await
                .expect("the attach joined the clone"),
            destination
        );
        assert_eq!(
            finished(starter).await.expect("the clone succeeds"),
            destination
        );
    }

    #[tokio::test]
    async fn a_clone_that_finished_before_its_starter_left_is_kept() {
        let (pauses, transferred) = TestPauses::at(PausePoint::AfterTransfer);
        let harness = harness(Limits {
            pauses,
            ..Limits::default()
        });
        let destination = harness.parent.join("finished-first");
        let starter = spawn_clone(
            &harness,
            undetached(request(&harness, &harness.url, "finished-first")),
        );
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        timeout(DEADLINE, transferred.arrived())
            .await
            .expect("Git finished the transfer");
        // The starter leaves after Git succeeded, before the clone's task looks at the result:
        // the root is cancelled when the success-or-cleanup branch runs.
        leave(starter).await;
        transferred.release();
        wait_until(|| harness.runtime.live() == 0, "the outcome was published").await;

        assert!(
            destination.join(".git").is_dir(),
            "a finished clone is never removed"
        );
        assert_eq!(
            call(
                &harness,
                attach(request(&harness, &harness.url, "finished-first"))
            )
            .await
            .expect("the finished clone is found"),
            destination
        );
    }

    #[tokio::test]
    async fn a_detached_clone_keeps_its_admission_permit_so_the_drain_names_it() {
        let harness = standard();
        let gate = RpcAdmissionGate::new();
        let permit = gate
            .admit_named(RpcMutability::Mutation, "vcs.clone")
            .expect("open gate");
        let runtime = harness.runtime.clone();
        let clone_request = request(&harness, &harness.url, "permit");
        let starter = tokio::spawn(async move {
            runtime
                .start_or_join(clone_request, Some(permit), &CancellationToken::new())
                .await
        });
        transfer_started(&harness).await;
        leave(starter).await;

        let drain = gate
            .close_and_drain(Instant::now() + Duration::from_millis(100))
            .await
            .expect_err("the detached clone still holds its permit");
        assert!(
            drain.to_string().contains("vcs.clone"),
            "the drain names the clone: {drain}"
        );

        harness.runner.release.add_permits(1);
        wait_until(
            || gate.snapshot().in_flight == 0,
            "the finished clone released its permit",
        )
        .await;
    }

    async fn cancel(harness: &Harness, url: &str, name: &str) -> bool {
        timeout(
            DEADLINE,
            harness.runtime.cancel(url, &harness.parent, &leaf(name)),
        )
        .await
        .expect("the cancel answered")
    }

    fn spawn_cancel(harness: &Harness, name: &'static str) -> tokio::task::JoinHandle<bool> {
        let runtime = harness.runtime.clone();
        let (url, parent) = (harness.url.clone(), harness.parent.clone());
        tokio::spawn(async move { runtime.cancel(&url, &parent, &leaf(name)).await })
    }

    #[tokio::test]
    async fn cancel_stops_git_waits_for_the_cleanup_and_answers_true() {
        let harness = standard();
        harness
            .runner
            .hold_after_cancel
            .store(true, Ordering::SeqCst);
        let destination = harness.parent.join("cancelled");
        assert!(
            !cancel(&harness, &harness.url, "cancelled").await,
            "nothing to cancel yet"
        );

        let starter = spawn_clone(&harness, request(&harness, &harness.url, "cancelled"));
        transfer_started(&harness).await;
        assert!(
            !cancel(&harness, &harness.other_url, "cancelled").await,
            "another URL's cancel is ignored"
        );
        assert!(destination.is_dir(), "and leaves the clone alone");

        let cancelling = spawn_cancel(&harness, "cancelled");
        timeout(DEADLINE, harness.runner.cancel_held.notified())
            .await
            .expect("the cancel stopped Git");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !cancelling.is_finished(),
            "the cancel waits for the cleanup"
        );
        assert!(destination.is_dir());
        harness.runner.release_cancelled.add_permits(1);
        assert!(
            timeout(DEADLINE, cancelling)
                .await
                .expect("answered")
                .expect("no panic"),
            "the clone was cancelled"
        );
        assert!(!destination.exists(), "the answer came after the cleanup");
        assert!(
            harness.parent.is_dir(),
            "only the created folder was removed"
        );
        assert_eq!(
            reason(&finished(starter).await.expect_err("cancelled")),
            "cancelled"
        );
        assert!(
            !cancel(&harness, &harness.url, "cancelled").await,
            "idempotent: nothing is live any more"
        );
    }

    #[tokio::test]
    async fn a_cancel_after_git_succeeded_keeps_the_clone_and_answers_false() {
        let (pauses, transferred) = TestPauses::at(PausePoint::AfterTransfer);
        let harness = harness(Limits {
            pauses,
            ..Limits::default()
        });
        let destination = harness.parent.join("won");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "won"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        timeout(DEADLINE, transferred.arrived())
            .await
            .expect("Git finished the transfer");
        // The cancel lands after Git succeeded, before the clone's task looks at the result.
        let cancelling = spawn_cancel(&harness, "won");
        wait_until(
            || harness.runtime.waiters(&destination) == 2,
            "the cancel waits on the clone",
        )
        .await;
        transferred.release();
        assert!(
            !timeout(DEADLINE, cancelling)
                .await
                .expect("answered")
                .expect("no panic"),
            "Git had already succeeded"
        );
        assert_eq!(
            finished(starter).await.expect("the clone succeeded"),
            destination
        );
        assert!(
            destination.join(".git").is_dir(),
            "a finished clone is never touched"
        );
    }

    #[tokio::test]
    async fn a_dropped_cancel_still_cancels_and_its_outcome_is_retained() {
        let harness = standard();
        harness
            .runner
            .hold_after_cancel
            .store(true, Ordering::SeqCst);
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "dropped"));
        transfer_started(&harness).await;
        leave(starter).await;
        let cancelling = spawn_cancel(&harness, "dropped");
        timeout(DEADLINE, harness.runner.cancel_held.notified())
            .await
            .expect("the cancel stopped Git");
        // The RPC interruption path drops the handler: only its wait ends.
        cancelling.abort();
        let _ = cancelling.await;
        harness.runner.release_cancelled.add_permits(1);
        wait_until(|| harness.runtime.live() == 0, "the clone finished").await;
        let retained = call(&harness, attach(request(&harness, &harness.url, "dropped")))
            .await
            .expect_err("retained");
        assert_eq!(reason(&retained), "cancelled");
    }

    #[tokio::test]
    async fn cancel_sweeps_expired_outcomes() {
        let harness = harness(Limits {
            retention: Duration::from_millis(500),
            ..Limits::default()
        });
        let first = spawn_clone(
            &harness,
            undetached(request(&harness, &harness.url, "expiring")),
        );
        transfer_started(&harness).await;
        leave(first).await;
        wait_until(|| harness.runtime.retained_len() == 1, "retained").await;
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(!cancel(&harness, &harness.url, "elsewhere").await);
        assert_eq!(
            harness.runtime.retained_len(),
            0,
            "the cancel swept the expired outcome"
        );
    }

    #[tokio::test]
    async fn shutdown_stops_live_clones_removes_their_folders_and_refuses_new_ones() {
        let harness = standard();
        // A failure retained before shutdown still answers a re-attach afterwards (D9).
        let missing = harness.missing_url();
        let failing = spawn_clone(&harness, request(&harness, &missing, "failed-before"));
        transfer_started(&harness).await;
        harness.runner.release.add_permits(1);
        let failure = finished(failing).await.expect_err("a missing remote fails");

        let destination = harness.parent.join("shutdown");
        let running = spawn_clone(&harness, request(&harness, &harness.url, "shutdown"));
        transfer_started(&harness).await;
        timeout(DEADLINE, harness.runtime.close_and_drain())
            .await
            .expect("the drain finished");
        assert!(
            !destination.exists(),
            "Git stopped and the partial folder is gone first"
        );
        assert_eq!(
            reason(&finished(running).await.expect_err("cancelled")),
            "cancelled"
        );
        for refused in [
            request(&harness, &harness.url, "late"),
            attach(request(&harness, &harness.url, "late")),
        ] {
            assert_eq!(
                reason(&call(&harness, refused).await.expect_err("closed")),
                "shutting-down"
            );
        }
        assert!(!harness.parent.join("late").exists());
        assert_eq!(
            call(
                &harness,
                attach(request(&harness, &missing, "failed-before"))
            )
            .await
            .expect_err("retained"),
            failure
        );
    }

    #[tokio::test]
    async fn shutdown_waits_for_a_clone_admitted_just_before_it_and_that_clone_creates_no_folder() {
        let (pauses, reserve) = TestPauses::at(PausePoint::BeforeReserve);
        let harness = harness(Limits {
            pauses,
            ..Limits::default()
        });
        let raced = spawn_clone(&harness, request(&harness, &harness.url, "raced"));
        timeout(DEADLINE, reserve.arrived())
            .await
            .expect("the clone was admitted");
        let runtime = harness.runtime.clone();
        let drain = tokio::spawn(async move { runtime.close_and_drain().await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !drain.is_finished(),
            "the drain waits for the admitted clone"
        );
        reserve.release();
        timeout(DEADLINE, drain)
            .await
            .expect("the drain finished")
            .expect("no panic");
        assert!(
            !harness.parent.join("raced").exists(),
            "a clone cancelled before reserving creates no folder"
        );
        assert_eq!(
            reason(&finished(raced).await.expect_err("cancelled")),
            "cancelled"
        );
        assert_eq!(
            harness.runner.clones.load(Ordering::SeqCst),
            0,
            "Git never ran"
        );
    }

    #[tokio::test]
    async fn cancel_answers_only_after_the_folder_is_removed() {
        let (pauses, publish) = TestPauses::at(PausePoint::BeforePublish);
        let harness = harness(Limits {
            pauses,
            ..Limits::default()
        });
        let destination = harness.parent.join("removed-first");
        let starter = spawn_clone(&harness, request(&harness, &harness.url, "removed-first"));
        transfer_started(&harness).await;
        let cancelling = spawn_cancel(&harness, "removed-first");
        // Git stops for the cancel and the clone's task removes the folder, then pauses before it
        // publishes the outcome. Publishing frees the slot under the lock, so `live` tells.
        timeout(DEADLINE, publish.arrived())
            .await
            .expect("the clone reached its publish step");
        assert!(
            !destination.exists(),
            "the cleanup finished before the outcome is published"
        );
        assert_eq!(
            harness.runtime.live(),
            1,
            "the outcome is not published yet"
        );
        assert!(
            !cancelling.is_finished(),
            "the cancel answers only after the outcome is published"
        );
        publish.release();
        assert!(
            timeout(DEADLINE, cancelling)
                .await
                .expect("answered")
                .expect("no panic"),
            "the clone was cancelled"
        );
        assert_eq!(
            reason(&finished(starter).await.expect_err("cancelled")),
            "cancelled"
        );
    }
}
