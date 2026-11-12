//! The host collector: CPU, memory and volume space of the machine the server runs on (#292).

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex as SyncMutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use time::OffsetDateTime;
use tokio::{
    sync::{Notify, watch},
    task::JoinHandle,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

mod disk_workers;
mod native;
#[cfg(test)]
mod probes;
mod stats;
mod volumes;
mod wire;

pub use crate::diagnostics::SamplingError;
pub use native::NativeHostMetricsSource;
pub use stats::{ChartBucket, ChartPoint, MeasureStatistics};
pub(crate) use wire::send_host_metrics;

use disk_workers::{Admission, DiskJob, DiskJobKey, DiskJobResult, DiskOutcome, DiskWorkers};
use stats::{ChartHistory, RunningStatistic, clamp_percent};
use volumes::{merge_shared, pre_filter};

/// One volume as the source lists it, before any space read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeDescriptor {
    pub mount_point: PathBuf,
    pub name: String,
    pub file_system: String,
    pub removable: bool,
    pub read_only: bool,
    /// The mount point is a file, as Docker's `/etc/hosts` bind mount is.
    pub is_file: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VolumeState {
    Ok,
    NotResponding,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeReading {
    pub descriptor: VolumeDescriptor,
    /// `None` until the volume first answers.
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    pub state: VolumeState,
}

impl VolumeReading {
    pub fn used_bytes(&self) -> Option<u64> {
        Some(self.total_bytes?.saturating_sub(self.free_bytes?))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HiddenReason {
    Network,
    Overlay,
    FileMount,
    Empty,
    SameStorage { as_mount: PathBuf },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HiddenVolume {
    pub descriptor: VolumeDescriptor,
    pub reason: HiddenReason,
}

/// Facts about the host that do not change while the server runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostFacts {
    pub os: &'static str,
    pub arch: &'static str,
    pub cpu_count: usize,
    pub memory_total_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CpuMemoryReading {
    pub cpu_percent: f64,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VolumeSpace {
    pub total_bytes: u64,
    pub free_bytes: u64,
}

/// What the collector reads. Every call may block: CPU and memory are read on the blocking
/// pool and must be short; volume calls are made only on a disk worker.
pub trait HostMetricsSource: std::fmt::Debug + Send + Sync + 'static {
    fn host_facts(&self) -> HostFacts;
    fn read_cpu_memory(&self) -> Result<CpuMemoryReading, SamplingError>;
    fn list_volumes(&self) -> Vec<VolumeDescriptor>;
    fn read_volume_space(&self, mount_point: &Path) -> Result<VolumeSpace, String>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct HostReading {
    pub sampled_at_ms: i128,
    pub cpu_percent: f64,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
    pub memory_available_bytes: u64,
    pub volumes: Vec<VolumeReading>,
    pub volumes_paused: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostMetricsRates {
    pub background: Duration,
    pub live: Duration,
    /// Volumes are read on every `volumes_every`-th reading.
    pub volumes_every: u32,
    /// A volume whose read runs longer than this is shown as not responding.
    pub volume_timeout: Duration,
    pub disk_threads: usize,
}

impl Default for HostMetricsRates {
    fn default() -> Self {
        Self {
            background: Duration::from_secs(60),
            live: Duration::from_secs(1),
            volumes_every: 5,
            volume_timeout: Duration::from_secs(2),
            disk_threads: 4,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostMetricsIdentity {
    pub boot_id: Option<String>,
    pub started_at_ms: i128,
}

/// The uptime chart and the hidden volumes, with a revision that rises when either changes.
#[derive(Clone, Debug, PartialEq)]
pub struct ChartState {
    pub revision: u64,
    pub uptime: Vec<ChartBucket>,
    pub hidden_volumes: Vec<HiddenVolume>,
}

#[derive(Clone, Debug)]
pub struct HostMetricsSnapshot {
    pub identity: HostMetricsIdentity,
    pub facts: HostFacts,
    pub statistics_since_ms: Option<i128>,
    pub current: Option<HostReading>,
    pub cpu: Option<MeasureStatistics>,
    pub memory: Option<MeasureStatistics>,
    pub recent: Vec<ChartPoint>,
    pub chart: Arc<ChartState>,
}

/// One live reading; `chart` always points at the latest complete chart state.
#[derive(Clone, Debug)]
pub struct HostMetricsUpdate {
    pub reading: HostReading,
    pub cpu: MeasureStatistics,
    pub memory: MeasureStatistics,
    pub chart: Arc<ChartState>,
}

/// Turns a volume's space into a reading; free is clamped to total, so used is never negative.
pub fn volume_reading(descriptor: VolumeDescriptor, space: VolumeSpace) -> VolumeReading {
    VolumeReading {
        descriptor,
        total_bytes: Some(space.total_bytes),
        free_bytes: Some(space.free_bytes.min(space.total_bytes)),
        state: VolumeState::Ok,
    }
}

const UPTIME_BARS: usize = 240;
const FIRST_READING_WAIT: Duration = Duration::from_secs(1);
/// How often the disk loop looks for reads past the limit while any is running.
const HELD_CHECK: Duration = Duration::from_millis(250);

type UpdateSender = watch::Sender<Option<Arc<HostMetricsUpdate>>>;

#[derive(Debug)]
struct Statistics {
    cpu: RunningStatistic,
    memory: RunningStatistic,
    chart: ChartHistory,
    since_ms: Option<i128>,
    current: Option<HostReading>,
    last_error: Option<String>,
}

/// A volume the disk loop tracks: the listing that first showed it and its latest reading.
#[derive(Debug)]
struct TrackedVolume {
    generation: u64,
    reading: VolumeReading,
    reported_hung: bool,
}

#[derive(Debug, Default)]
struct DiskView {
    shown: Vec<VolumeReading>,
    paused: bool,
    /// Volumes the disk loop tracks: the latest listing's.
    #[cfg(test)]
    tracked: usize,
}

#[derive(Debug)]
struct Shared {
    source: Arc<dyn HostMetricsSource>,
    rates: HostMetricsRates,
    identity: HostMetricsIdentity,
    clock_origin: Instant,
    statistics: SyncMutex<Statistics>,
    chart: SyncMutex<(u64, Arc<ChartState>)>,
    disk_view: SyncMutex<DiskView>,
    updates: SyncMutex<Option<UpdateSender>>,
    subscribers: watch::Sender<usize>,
    volume_tick: Notify,
    started: AtomicBool,
    tasks: SyncMutex<Vec<JoinHandle<()>>>,
    workers: SyncMutex<Option<Arc<DiskWorkers>>>,
    shutdown: CancellationToken,
    #[cfg(test)]
    volume_cadence: Option<Duration>,
}

/// Reads the host's CPU, memory and volumes: in the background from `start_background`, and once
/// a second, shared by every subscriber, while any subscription lives.
#[derive(Debug)]
pub struct HostMetricsCollector {
    shared: Arc<Shared>,
}

/// Keeps the collector at the live rate while it lives.
#[derive(Debug)]
pub struct HostMetricsSubscription {
    receiver: watch::Receiver<Option<Arc<HostMetricsUpdate>>>,
    shared: Arc<Shared>,
}

impl HostMetricsSubscription {
    pub fn receiver(&mut self) -> &mut watch::Receiver<Option<Arc<HostMetricsUpdate>>> {
        &mut self.receiver
    }
}

impl Drop for HostMetricsSubscription {
    fn drop(&mut self) {
        self.shared
            .subscribers
            .send_modify(|count| *count = count.saturating_sub(1));
    }
}

fn lock<T>(mutex: &SyncMutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl HostMetricsCollector {
    /// Builds an idle collector: it reads nothing and starts no thread.
    pub fn new(
        source: Arc<dyn HostMetricsSource>,
        rates: HostMetricsRates,
        identity: HostMetricsIdentity,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                source,
                rates,
                identity,
                clock_origin: Instant::now(),
                statistics: SyncMutex::new(Statistics {
                    cpu: RunningStatistic::default(),
                    memory: RunningStatistic::default(),
                    chart: ChartHistory::new(),
                    since_ms: None,
                    current: None,
                    last_error: None,
                }),
                chart: SyncMutex::new((
                    0,
                    Arc::new(ChartState {
                        revision: 0,
                        uptime: Vec::new(),
                        hidden_volumes: Vec::new(),
                    }),
                )),
                disk_view: SyncMutex::new(DiskView::default()),
                updates: SyncMutex::new(Some(watch::Sender::new(None))),
                subscribers: watch::Sender::new(0),
                volume_tick: Notify::new(),
                started: AtomicBool::new(false),
                tasks: SyncMutex::new(Vec::new()),
                workers: SyncMutex::new(None),
                shutdown: CancellationToken::new(),
                #[cfg(test)]
                volume_cadence: None,
            }),
        }
    }

    /// Ticks the disk loop on its own cadence too, so a test can run many listings quickly.
    #[cfg(test)]
    fn with_volume_cadence(mut self, cadence: Duration) -> Self {
        Arc::get_mut(&mut self.shared)
            .expect("unshared collector")
            .volume_cadence = Some(cadence);
        self
    }

    /// Starts sampling at the background rate.
    pub fn start_background(&self) {
        self.shared.start();
    }

    /// Switches to the live rate while the subscription lives, starting an idle collector.
    pub fn subscribe(&self) -> HostMetricsSubscription {
        self.shared.subscribers.send_modify(|count| *count += 1);
        let receiver = match lock(&self.shared.updates).as_ref() {
            Some(sender) => sender.subscribe(),
            // After shutdown: a closed channel, so the subscriber ends at once.
            None => watch::Sender::new(None).subscribe(),
        };
        self.shared.start();
        HostMetricsSubscription {
            receiver,
            shared: self.shared.clone(),
        }
    }

    pub fn live_subscribers(&self) -> usize {
        *self.shared.subscribers.borrow()
    }

    /// The current state; waits at most 1 s for a first reading.
    pub async fn snapshot(&self) -> HostMetricsSnapshot {
        let receiver = lock(&self.shared.updates)
            .as_ref()
            .map(watch::Sender::subscribe);
        if let Some(mut receiver) = receiver {
            tokio::select! {
                _ = receiver.wait_for(Option::is_some) => {}
                () = self.shared.shutdown.cancelled() => {}
                () = tokio::time::sleep(FIRST_READING_WAIT) => {}
            }
        }
        let source = self.shared.source.clone();
        let facts = tokio::task::spawn_blocking(move || source.host_facts())
            .await
            .unwrap_or_else(|_| HostFacts {
                os: std::env::consts::OS,
                arch: std::env::consts::ARCH,
                cpu_count: 0,
                memory_total_bytes: 0,
            });
        let chart = lock(&self.shared.chart).1.clone();
        let statistics = lock(&self.shared.statistics);
        HostMetricsSnapshot {
            identity: self.shared.identity.clone(),
            facts,
            statistics_since_ms: statistics.since_ms,
            current: statistics.current.clone(),
            cpu: statistics.cpu.summary(),
            memory: statistics.memory.summary(),
            recent: statistics.chart.recent(),
            chart,
        }
    }

    /// Stops both loops and the disk workers without waiting for a disk call; subscribers end
    /// when the update channel closes.
    pub async fn shutdown(&self) {
        self.shared.shutdown.cancel();
        let tasks = std::mem::take(&mut *lock(&self.shared.tasks));
        for task in tasks {
            if let Err(error) = task.await
                && error.is_panic()
            {
                tracing::warn!("the host metrics collector panicked before shutdown");
            }
        }
        if let Some(workers) = lock(&self.shared.workers).take() {
            workers.stop();
        }
        lock(&self.shared.updates).take();
    }
}

impl Shared {
    fn now_ms(&self) -> i128 {
        // Tests run on a paused clock, which the wall clock does not follow.
        if cfg!(test) {
            self.identity.started_at_ms + self.clock_origin.elapsed().as_millis() as i128
        } else {
            OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
        }
    }

    fn start(self: &Arc<Self>) {
        if self.shutdown.is_cancelled() || self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let workers = Arc::new(DiskWorkers::start(
            self.source.clone(),
            self.rates.disk_threads,
            self.rates.volume_timeout,
        ));
        *lock(&self.workers) = Some(workers.clone());
        let mut tasks = lock(&self.tasks);
        tasks.push(tokio::spawn(self.clone().sampling_loop()));
        tasks.push(tokio::spawn(self.clone().disk_loop(workers)));
    }

    fn rate(&self, live: bool) -> Duration {
        if live {
            self.rates.live
        } else {
            self.rates.background
        }
    }

    /// Reads CPU and memory every tick at the current rate; never awaits a disk call.
    async fn sampling_loop(self: Arc<Self>) {
        let mut subscribers = self.subscribers.subscribe();
        let mut live = *subscribers.borrow_and_update() > 0;
        let mut readings: u64 = 0;
        if live {
            self.prime_cpu().await;
            if self.sleep_or_stop(self.rates.live).await {
                return;
            }
        }
        loop {
            if readings.is_multiple_of(u64::from(self.rates.volumes_every.max(1))) {
                self.volume_tick.notify_one();
            }
            readings += 1;
            let rate = self.rate(live);
            let Some(sampled) = self.read_cpu_memory().await else {
                return;
            };
            self.publish(sampled, rate);
            let mut next = Instant::now() + rate;
            loop {
                tokio::select! {
                    () = self.shutdown.cancelled() => return,
                    () = tokio::time::sleep_until(next) => break,
                    changed = subscribers.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        let now_live = *subscribers.borrow_and_update() > 0;
                        if now_live == live {
                            continue;
                        }
                        live = now_live;
                        if live {
                            // The first live reading covers one second, not the time since
                            // the last background one.
                            self.prime_cpu().await;
                            next = Instant::now() + self.rates.live;
                        } else {
                            next = Instant::now() + self.rates.background;
                        }
                    }
                }
            }
        }
    }

    async fn sleep_or_stop(&self, duration: Duration) -> bool {
        tokio::select! {
            () = self.shutdown.cancelled() => true,
            () = tokio::time::sleep(duration) => false,
        }
    }

    async fn prime_cpu(&self) {
        let _ = self.read_cpu_memory().await;
    }

    /// `None` once shutdown began.
    async fn read_cpu_memory(&self) -> Option<Result<CpuMemoryReading, SamplingError>> {
        let source = self.source.clone();
        tokio::select! {
            () = self.shutdown.cancelled() => None,
            read = tokio::task::spawn_blocking(move || source.read_cpu_memory()) => Some(
                read.unwrap_or_else(|error| {
                    Err(SamplingError::Failed(format!("host metrics read stopped: {error}")))
                }),
            ),
        }
    }

    fn publish(&self, sampled: Result<CpuMemoryReading, SamplingError>, weight: Duration) {
        let sampled = match sampled {
            Ok(sampled) => sampled,
            Err(error) => {
                let error = error.to_string();
                let mut statistics = lock(&self.statistics);
                if statistics.last_error.as_ref() != Some(&error) {
                    tracing::warn!(%error, "host metrics sample failed");
                }
                statistics.last_error = Some(error);
                return;
            }
        };
        let (volumes, volumes_paused) = {
            let view = lock(&self.disk_view);
            (view.shown.clone(), view.paused)
        };
        let memory_total_bytes = sampled.memory_total_bytes;
        let memory_used_bytes = sampled.memory_used_bytes.min(memory_total_bytes);
        let reading = HostReading {
            sampled_at_ms: self.now_ms(),
            cpu_percent: clamp_percent(sampled.cpu_percent),
            memory_total_bytes,
            memory_used_bytes,
            memory_available_bytes: memory_total_bytes - memory_used_bytes,
            volumes,
            volumes_paused,
        };
        let memory_percent = if memory_total_bytes == 0 {
            0.0
        } else {
            memory_used_bytes as f64 * 100.0 / memory_total_bytes as f64
        };
        let (update, chart_revision) = {
            let mut statistics = lock(&self.statistics);
            statistics.last_error = None;
            statistics.cpu.record(reading.cpu_percent, weight);
            statistics.memory.record(memory_percent, weight);
            statistics.chart.record(
                ChartPoint {
                    sampled_at_ms: reading.sampled_at_ms,
                    cpu_percent: reading.cpu_percent,
                    memory_percent,
                },
                weight,
            );
            statistics.since_ms.get_or_insert(reading.sampled_at_ms);
            statistics.current = Some(reading.clone());
            let cpu = statistics.cpu.summary();
            let memory = statistics.memory.summary();
            (
                cpu.zip(memory).map(|(cpu, memory)| (reading, cpu, memory)),
                statistics.chart.revision(),
            )
        };
        let chart = self.refresh_chart(Some(chart_revision), None);
        if let Some((reading, cpu, memory)) = update
            && let Some(sender) = lock(&self.updates).as_ref()
        {
            sender.send_replace(Some(Arc::new(HostMetricsUpdate {
                reading,
                cpu,
                memory,
                chart,
            })));
        }
    }

    /// Rebuilds the chart state when the uptime chart or the hidden volumes changed.
    fn refresh_chart(
        &self,
        history_revision: Option<u64>,
        hidden: Option<Vec<HiddenVolume>>,
    ) -> Arc<ChartState> {
        let mut chart = lock(&self.chart);
        let (last_history_revision, state) = &mut *chart;
        let history_changed =
            history_revision.is_some_and(|revision| revision != *last_history_revision);
        let hidden_changed = hidden
            .as_ref()
            .is_some_and(|hidden| *hidden != state.hidden_volumes);
        if !history_changed && !hidden_changed {
            return state.clone();
        }
        if let Some(revision) = history_revision {
            *last_history_revision = revision;
        }
        let uptime = if history_changed {
            lock(&self.statistics).chart.uptime(UPTIME_BARS)
        } else {
            state.uptime.clone()
        };
        *state = Arc::new(ChartState {
            revision: state.revision + 1,
            uptime,
            hidden_volumes: hidden.unwrap_or_else(|| state.hidden_volumes.clone()),
        });
        state.clone()
    }

    /// Sends volume jobs to the disk workers and folds their results into the disk view.
    async fn disk_loop(self: Arc<Self>, workers: Arc<DiskWorkers>) {
        let mut disks = DiskTracker::default();
        #[cfg(test)]
        let cadence = self.volume_cadence;
        #[cfg(not(test))]
        let cadence: Option<Duration> = None;
        let mut cadence = cadence.map(tokio::time::interval);
        loop {
            let held = workers.has_work();
            tokio::select! {
                () = self.shutdown.cancelled() => return,
                () = self.volume_tick.notified() => disks.admit_all(&workers),
                () = async {
                    match cadence.as_mut() {
                        Some(cadence) => { cadence.tick().await; }
                        None => std::future::pending().await,
                    }
                } => disks.admit_all(&workers),
                () = workers.results_ready() => {}
                () = tokio::time::sleep(HELD_CHECK), if held => {}
            }
            for result in workers.take_results() {
                disks.apply(result, &workers);
            }
            disks.mark_hung(&workers, self.rates.volume_timeout);
            let (shown, merged) = merge_shared(disks.readings());
            let mut hidden = disks.pre_hidden.clone();
            hidden.extend(merged);
            {
                let mut view = lock(&self.disk_view);
                view.shown = shown;
                view.paused = workers.paused();
                #[cfg(test)]
                {
                    view.tracked = disks.volumes.len();
                }
            }
            self.refresh_chart(None, Some(hidden));
        }
    }
}

/// The disk loop's state: the volumes of the latest listing, keyed by mount point and generation.
#[derive(Debug, Default)]
struct DiskTracker {
    listings: u64,
    volumes: Vec<TrackedVolume>,
    pre_hidden: Vec<HiddenVolume>,
}

impl DiskTracker {
    fn key(volume: &TrackedVolume) -> DiskJobKey {
        DiskJobKey {
            mount_point: Some(volume.reading.descriptor.mount_point.clone()),
            generation: volume.generation,
        }
    }

    fn admit_all(&mut self, workers: &DiskWorkers) {
        let list = DiskJobKey {
            mount_point: None,
            generation: 0,
        };
        if workers.admit(DiskJob { key: list }) == Admission::Paused {
            return;
        }
        for volume in &self.volumes {
            if workers.admit(DiskJob {
                key: Self::key(volume),
            }) == Admission::Paused
            {
                return;
            }
        }
    }

    fn apply(&mut self, result: DiskJobResult, workers: &DiskWorkers) {
        match result.outcome {
            DiskOutcome::Listed(listed) => self.apply_listing(listed, workers),
            DiskOutcome::Space(space) => {
                let Some(volume) = self
                    .volumes
                    .iter_mut()
                    .find(|volume| Self::key(volume) == result.key)
                else {
                    return;
                };
                volume.reported_hung = false;
                match space {
                    Ok(space) => {
                        volume.reading = volume_reading(volume.reading.descriptor.clone(), space);
                    }
                    Err(error) => {
                        tracing::debug!(
                            %error,
                            file_system = %volume.reading.descriptor.file_system,
                            "host volume read failed"
                        );
                        volume.reading.state = VolumeState::NotResponding;
                    }
                }
            }
        }
    }

    fn apply_listing(&mut self, listed: Vec<VolumeDescriptor>, workers: &DiskWorkers) {
        self.listings += 1;
        let (kept, hidden) = pre_filter(listed);
        self.pre_hidden = hidden;
        let mut previous = std::mem::take(&mut self.volumes);
        for descriptor in kept {
            match previous
                .iter()
                .position(|volume| volume.reading.descriptor == descriptor)
            {
                Some(index) => self.volumes.push(previous.swap_remove(index)),
                None => {
                    let volume = TrackedVolume {
                        generation: self.listings,
                        reading: VolumeReading {
                            descriptor,
                            total_bytes: None,
                            free_bytes: None,
                            state: VolumeState::Ok,
                        },
                        reported_hung: false,
                    };
                    // A new volume is read at once, not at the next volume tick.
                    workers.admit(DiskJob {
                        key: Self::key(&volume),
                    });
                    self.volumes.push(volume);
                }
            }
        }
        let retired = previous.iter().map(Self::key).collect::<Vec<_>>();
        workers.retire(&retired);
    }

    fn mark_hung(&mut self, workers: &DiskWorkers, limit: Duration) {
        let hung = workers.running_longer_than(limit);
        for (position, volume) in self.volumes.iter_mut().enumerate() {
            if !hung.contains(&Self::key(volume)) {
                continue;
            }
            volume.reading.state = VolumeState::NotResponding;
            if !volume.reported_hung {
                volume.reported_hung = true;
                // R74: never the mount point or the volume name.
                tracing::warn!(
                    file_system = %volume.reading.descriptor.file_system,
                    position,
                    "host volume did not answer"
                );
            }
        }
    }

    /// Readings of volumes that have answered at least once, or are known not to respond.
    fn readings(&self) -> Vec<VolumeReading> {
        self.volumes
            .iter()
            .filter(|volume| {
                volume.reading.total_bytes.is_some()
                    || volume.reading.state == VolumeState::NotResponding
            })
            .map(|volume| volume.reading.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests;
