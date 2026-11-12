//! The disk workers (D32): dedicated OS threads that make every volume list and space read, so a
//! hung mount holds one of them and never a Tokio thread. Shutdown never joins them.

use std::{
    collections::VecDeque,
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use tokio::sync::Notify;

use super::{HostMetricsSource, VolumeDescriptor, VolumeSpace};

/// Identifies a disk job: `mount_point` is `None` for the list job; `generation` is the number of
/// the listing that first showed the volume.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct DiskJobKey {
    pub mount_point: Option<PathBuf>,
    pub generation: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct DiskJob {
    pub key: DiskJobKey,
    /// What the read weighs in the statistics: the volume interval when it was admitted.
    pub weight: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    Admitted,
    /// That key already has a job queued or running.
    AlreadyPending,
    /// Every thread is held by a call that has run past the limit.
    Paused,
}

#[derive(Debug)]
pub(crate) enum DiskOutcome {
    /// `Err` only when the listing call panicked.
    Listed(Result<Vec<VolumeDescriptor>, String>),
    Space(Result<VolumeSpace, String>),
}

#[derive(Debug)]
pub(crate) struct DiskJobResult {
    pub key: DiskJobKey,
    pub weight: Duration,
    pub outcome: DiskOutcome,
}

#[derive(Debug)]
struct Running {
    id: u64,
    key: DiskJobKey,
    started: Instant,
    retired: bool,
}

#[derive(Debug, Default)]
struct WorkerState {
    queue: VecDeque<DiskJob>,
    running: Vec<Running>,
    results: Vec<DiskJobResult>,
    next_id: u64,
    stopped: bool,
}

#[derive(Debug)]
struct Inner {
    source: Arc<dyn HostMetricsSource>,
    threads: usize,
    hold_limit: Duration,
    state: Mutex<WorkerState>,
    work: Condvar,
    results_ready: Notify,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, WorkerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn run_worker(&self) {
        loop {
            let (id, job) = {
                let mut state = self.lock();
                loop {
                    if state.stopped {
                        return;
                    }
                    if let Some(job) = state.queue.pop_front() {
                        let id = state.next_id;
                        state.next_id += 1;
                        state.running.push(Running {
                            id,
                            key: job.key.clone(),
                            started: Instant::now(),
                            retired: false,
                        });
                        break (id, job);
                    }
                    state = self
                        .work
                        .wait(state)
                        .unwrap_or_else(PoisonError::into_inner);
                }
            };
            // A panicking call fails its own job only: its key is freed below and this thread
            // keeps serving. The profiler's panic hook has already recorded the panic.
            let outcome =
                std::panic::catch_unwind(AssertUnwindSafe(|| match &job.key.mount_point {
                    None => DiskOutcome::Listed(Ok(self.source.list_volumes())),
                    Some(mount_point) => {
                        DiskOutcome::Space(self.source.read_volume_space(mount_point))
                    }
                }))
                .unwrap_or_else(|_| {
                    // R74: the payload may name a path, so only the kind of call is logged.
                    let listing = job.key.mount_point.is_none();
                    tracing::warn!(
                        call = if listing { "list" } else { "space" },
                        "host disk call panicked"
                    );
                    if listing {
                        DiskOutcome::Listed(Err("the volume listing failed".to_owned()))
                    } else {
                        DiskOutcome::Space(Err("the volume read failed".to_owned()))
                    }
                });
            {
                let mut state = self.lock();
                let Some(index) = state.running.iter().position(|running| running.id == id) else {
                    continue;
                };
                let running = state.running.swap_remove(index);
                if state.stopped {
                    return;
                }
                if !running.retired {
                    state.results.push(DiskJobResult {
                        key: job.key,
                        weight: job.weight,
                        outcome,
                    });
                }
            }
            self.results_ready.notify_one();
        }
    }
}

/// A fixed pool of `host-disk-<n>` threads pulling jobs from one queue that holds at most one job
/// per key.
#[derive(Debug)]
pub(crate) struct DiskWorkers {
    inner: Arc<Inner>,
}

impl DiskWorkers {
    pub(crate) fn start(
        source: Arc<dyn HostMetricsSource>,
        threads: usize,
        hold_limit: Duration,
    ) -> Self {
        let inner = Arc::new(Inner {
            source,
            threads: threads.max(1),
            hold_limit,
            state: Mutex::new(WorkerState::default()),
            work: Condvar::new(),
            results_ready: Notify::new(),
        });
        for index in 0..inner.threads {
            let worker = inner.clone();
            if let Err(error) = std::thread::Builder::new()
                .name(format!("host-disk-{index}"))
                .spawn(move || worker.run_worker())
            {
                tracing::warn!(%error, "host disk worker did not start");
            }
        }
        Self { inner }
    }

    pub(crate) fn admit(&self, job: DiskJob) -> Admission {
        let mut state = self.inner.lock();
        let pending = state.queue.iter().any(|queued| queued.key == job.key)
            || state
                .running
                .iter()
                .any(|running| !running.retired && running.key == job.key);
        if pending {
            return Admission::AlreadyPending;
        }
        if state.stopped || self.all_held(&state) {
            return Admission::Paused;
        }
        state.queue.push_back(job);
        drop(state);
        self.inner.work.notify_one();
        Admission::Admitted
    }

    fn all_held(&self, state: &WorkerState) -> bool {
        state
            .running
            .iter()
            .filter(|running| running.started.elapsed() >= self.inner.hold_limit)
            .count()
            >= self.inner.threads
    }

    /// Whether every thread is held by a call that has run past the limit.
    pub(crate) fn paused(&self) -> bool {
        self.all_held(&self.inner.lock())
    }

    /// Drops queued jobs of these keys and discards the results of their running jobs.
    pub(crate) fn retire(&self, keys: &[DiskJobKey]) {
        if keys.is_empty() {
            return;
        }
        let mut state = self.inner.lock();
        state.queue.retain(|job| !keys.contains(&job.key));
        for running in &mut state.running {
            if keys.contains(&running.key) {
                running.retired = true;
            }
        }
        state.results.retain(|result| !keys.contains(&result.key));
    }

    pub(crate) fn running_longer_than(&self, limit: Duration) -> Vec<DiskJobKey> {
        self.inner
            .lock()
            .running
            .iter()
            .filter(|running| !running.retired && running.started.elapsed() >= limit)
            .map(|running| running.key.clone())
            .collect()
    }

    /// Whether a job is queued or running, so a read may pass the limit.
    pub(crate) fn has_work(&self) -> bool {
        let state = self.inner.lock();
        !state.running.is_empty() || !state.queue.is_empty()
    }

    pub(crate) fn take_results(&self) -> Vec<DiskJobResult> {
        std::mem::take(&mut self.inner.lock().results)
    }

    /// Wakes when a worker has stored a result.
    pub(crate) async fn results_ready(&self) {
        self.inner.results_ready.notified().await;
    }

    /// Whether no job is queued or running, retired ones included, and no result waits.
    #[cfg(test)]
    pub(crate) fn idle(&self) -> bool {
        let state = self.inner.lock();
        state.queue.is_empty() && state.running.is_empty() && state.results.is_empty()
    }

    /// Whether a job is queued or running on a thread, retired ones included.
    #[cfg(test)]
    pub(crate) fn busy(&self) -> bool {
        let state = self.inner.lock();
        !state.queue.is_empty() || !state.running.is_empty()
    }

    /// Queued jobs plus running ones, retired ones included.
    #[cfg(test)]
    pub(crate) fn held_and_queued(&self) -> usize {
        let state = self.inner.lock();
        state.queue.len() + state.running.len()
    }

    /// Sets the stop flag and wakes idle threads; never joins a thread held by a call.
    pub(crate) fn stop(&self) {
        let mut state = self.inner.lock();
        state.stopped = true;
        state.queue.clear();
        drop(state);
        self.inner.work.notify_all();
    }
}

impl Drop for DiskWorkers {
    fn drop(&mut self) {
        self.stop();
    }
}
