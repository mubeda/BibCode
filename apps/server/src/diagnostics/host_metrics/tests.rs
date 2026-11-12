//! Collector tests (Task 11.2): paused-clock tests with a fast fake, and real-clock tests with a
//! source that holds real threads on channels the test owns.

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

use super::*;

const GB: u64 = 1_000_000_000;

fn descriptor(mount_point: &str, file_system: &str) -> VolumeDescriptor {
    VolumeDescriptor {
        mount_point: PathBuf::from(mount_point),
        name: String::new(),
        file_system: file_system.to_owned(),
        removable: false,
        read_only: false,
        is_file: false,
    }
}

fn cpu(cpu_percent: f64) -> Result<CpuMemoryReading, String> {
    Ok(CpuMemoryReading {
        cpu_percent,
        memory_total_bytes: 32 * GB,
        memory_used_bytes: 8 * GB,
    })
}

type ListScript = Box<dyn Fn(usize) -> Vec<VolumeDescriptor> + Send + Sync>;

/// Returns scripted values at once and counts every call.
pub(super) struct FakeHostMetricsSource {
    cpu: Mutex<VecDeque<Result<CpuMemoryReading, String>>>,
    list: ListScript,
    space: Mutex<HashMap<PathBuf, VolumeSpace>>,
    cpu_reads: AtomicUsize,
    list_calls: AtomicUsize,
    space_reads: Mutex<HashMap<PathBuf, usize>>,
}

impl std::fmt::Debug for FakeHostMetricsSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("FakeHostMetricsSource")
    }
}

impl FakeHostMetricsSource {
    pub(super) fn new(volumes: Vec<VolumeDescriptor>) -> Self {
        Self::with_list(Box::new(move |_| volumes.clone()))
    }

    fn with_list(list: ListScript) -> Self {
        Self {
            cpu: Mutex::new(VecDeque::from([cpu(20.0)])),
            list,
            space: Mutex::new(HashMap::new()),
            cpu_reads: AtomicUsize::new(0),
            list_calls: AtomicUsize::new(0),
            space_reads: Mutex::new(HashMap::new()),
        }
    }

    fn script_cpu(
        self,
        readings: impl IntoIterator<Item = Result<CpuMemoryReading, String>>,
    ) -> Self {
        *self.cpu.lock().unwrap() = readings.into_iter().collect();
        self
    }

    fn space(self, mount_point: &str, total: u64, free: u64) -> Self {
        self.space.lock().unwrap().insert(
            PathBuf::from(mount_point),
            VolumeSpace {
                total_bytes: total,
                free_bytes: free,
            },
        );
        self
    }

    fn cpu_reads(&self) -> usize {
        self.cpu_reads.load(Ordering::Acquire)
    }

    fn list_calls(&self) -> usize {
        self.list_calls.load(Ordering::Acquire)
    }

    fn space_reads(&self, mount_point: &str) -> usize {
        self.space_reads
            .lock()
            .unwrap()
            .get(Path::new(mount_point))
            .copied()
            .unwrap_or(0)
    }

    fn all_space_reads(&self) -> usize {
        self.space_reads.lock().unwrap().values().sum()
    }
}

impl HostMetricsSource for FakeHostMetricsSource {
    fn host_facts(&self) -> HostFacts {
        HostFacts {
            os: "linux",
            arch: "x86_64",
            cpu_count: 12,
            memory_total_bytes: 32 * GB,
        }
    }

    fn read_cpu_memory(&self) -> Result<CpuMemoryReading, SamplingError> {
        self.cpu_reads.fetch_add(1, Ordering::AcqRel);
        let mut script = self.cpu.lock().unwrap();
        // The last scripted value repeats.
        let next = if script.len() > 1 {
            script.pop_front()
        } else {
            script.front().cloned()
        };
        next.expect("scripted CPU reading")
            .map_err(SamplingError::Failed)
    }

    fn list_volumes(&self) -> Vec<VolumeDescriptor> {
        let call = self.list_calls.fetch_add(1, Ordering::AcqRel);
        (self.list)(call)
    }

    fn read_volume_space(&self, mount_point: &Path) -> Result<VolumeSpace, String> {
        *self
            .space_reads
            .lock()
            .unwrap()
            .entry(mount_point.to_owned())
            .or_default() += 1;
        Ok(self
            .space
            .lock()
            .unwrap()
            .get(mount_point)
            .copied()
            .unwrap_or(VolumeSpace {
                total_bytes: 100 * GB,
                free_bytes: 40 * GB,
            }))
    }
}

/// Wraps the fake; chosen calls park the calling thread on a channel the test holds, until the
/// test sends the result or drops the sender.
#[derive(Debug)]
struct BlockingHostMetricsSource {
    inner: FakeHostMetricsSource,
    /// By list call number.
    list_gates: Mutex<HashMap<usize, mpsc::Receiver<Vec<VolumeDescriptor>>>>,
    /// By mount point and the number of that mount point's space read.
    space_gates: Mutex<HashMap<(PathBuf, usize), mpsc::Receiver<VolumeSpace>>>,
    cpu_gate: Mutex<Option<mpsc::Receiver<()>>>,
}

impl BlockingHostMetricsSource {
    fn new(inner: FakeHostMetricsSource) -> Self {
        Self {
            inner,
            list_gates: Mutex::new(HashMap::new()),
            space_gates: Mutex::new(HashMap::new()),
            cpu_gate: Mutex::new(None),
        }
    }

    fn hold_list(&self, call: usize) -> mpsc::Sender<Vec<VolumeDescriptor>> {
        let (sender, receiver) = mpsc::channel();
        self.list_gates.lock().unwrap().insert(call, receiver);
        sender
    }

    fn hold_space(&self, mount_point: &str, call: usize) -> mpsc::Sender<VolumeSpace> {
        let (sender, receiver) = mpsc::channel();
        self.space_gates
            .lock()
            .unwrap()
            .insert((PathBuf::from(mount_point), call), receiver);
        sender
    }

    fn hold_cpu(&self) -> mpsc::Sender<()> {
        let (sender, receiver) = mpsc::channel();
        *self.cpu_gate.lock().unwrap() = Some(receiver);
        sender
    }
}

impl HostMetricsSource for BlockingHostMetricsSource {
    fn host_facts(&self) -> HostFacts {
        self.inner.host_facts()
    }

    fn read_cpu_memory(&self) -> Result<CpuMemoryReading, SamplingError> {
        let gate = self.cpu_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            let _ = gate.recv();
        }
        self.inner.read_cpu_memory()
    }

    fn list_volumes(&self) -> Vec<VolumeDescriptor> {
        let call = self.inner.list_calls();
        let gate = self.list_gates.lock().unwrap().remove(&call);
        match gate {
            Some(gate) => {
                self.inner.list_calls.fetch_add(1, Ordering::AcqRel);
                gate.recv().unwrap_or_default()
            }
            None => self.inner.list_volumes(),
        }
    }

    fn read_volume_space(&self, mount_point: &Path) -> Result<VolumeSpace, String> {
        let call = self.inner.space_reads(&mount_point.to_string_lossy());
        let gate = self
            .space_gates
            .lock()
            .unwrap()
            .remove(&(mount_point.to_owned(), call));
        match gate {
            Some(gate) => {
                *self
                    .inner
                    .space_reads
                    .lock()
                    .unwrap()
                    .entry(mount_point.to_owned())
                    .or_default() += 1;
                gate.recv().map_err(|_| "released".to_owned())
            }
            None => self.inner.read_volume_space(mount_point),
        }
    }
}

fn identity() -> HostMetricsIdentity {
    HostMetricsIdentity {
        boot_id: Some("00000000-0000-0000-0000-000000000000".to_owned()),
        started_at_ms: 1_700_000_000_000,
    }
}

fn collector(source: Arc<dyn HostMetricsSource>) -> HostMetricsCollector {
    HostMetricsCollector::new(source, HostMetricsRates::default(), identity())
}

/// Waits until nothing the last tick started is still running: no CPU read on the blocking pool,
/// no disk job on a worker thread and no result the disk loop has not taken. The loops run only
/// while this task yields, and the paused clock does not move while it blocks, so a pass that
/// finds everything idle after yielding means the collector waits on its clock alone.
pub(super) async fn quiesce(collector: &HostMetricsCollector) {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let workers = lock(&collector.shared.workers).clone();
    let cpu_busy = || collector.shared.cpu_in_flight.load(Ordering::Acquire) > 0;
    loop {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        if !cpu_busy() && workers.as_ref().is_none_or(|workers| workers.idle()) {
            return;
        }
        while cpu_busy() || workers.as_ref().is_some_and(|workers| workers.busy()) {
            assert!(
                std::time::Instant::now() < deadline,
                "the collector did not settle"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

/// Runs the paused clock forward in steps, waiting for the collector to settle after each.
pub(super) async fn run_for(collector: &HostMetricsCollector, total: Duration, step: Duration) {
    let mut elapsed = Duration::ZERO;
    while elapsed < total {
        tokio::time::sleep(step).await;
        quiesce(collector).await;
        elapsed += step;
    }
}

async fn current(collector: &HostMetricsCollector) -> HostReading {
    collector
        .snapshot()
        .await
        .current
        .expect("a reading was taken")
}

/// Waits on the real clock for the next update with a reading newer than `after_ms`.
async fn next_update(
    subscription: &mut HostMetricsSubscription,
    after_ms: i128,
) -> Arc<HostMetricsUpdate> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            subscription
                .receiver()
                .changed()
                .await
                .expect("the collector is running");
            let update = subscription.receiver().borrow_and_update().clone();
            if let Some(update) = update
                && update.reading.sampled_at_ms > after_ms
            {
                return update;
            }
        }
    })
    .await
    .expect("an update arrives")
}

fn volume<'a>(reading: &'a HostReading, mount_point: &str) -> Option<&'a VolumeReading> {
    reading
        .volumes
        .iter()
        .find(|volume| volume.descriptor.mount_point == Path::new(mount_point))
}

/// On the real clock only liveness is checked, with room for a loaded machine: readings keep
/// coming in order and none is three intervals late. Exact cadence is tested on the paused clock.
fn assert_live(readings: &[Arc<HostMetricsUpdate>], interval_ms: i128) {
    for pair in readings.windows(2) {
        let gap = pair[1].reading.sampled_at_ms - pair[0].reading.sampled_at_ms;
        assert!(
            pair[1].reading.sequence > pair[0].reading.sequence && gap <= 3 * interval_ms,
            "readings {gap} ms apart: {:?}",
            readings
                .iter()
                .map(|update| update.reading.sampled_at_ms)
                .collect::<Vec<_>>()
        );
    }
}

async fn collect_updates(
    subscription: &mut HostMetricsSubscription,
    count: usize,
) -> Vec<Arc<HostMetricsUpdate>> {
    let mut updates: Vec<Arc<HostMetricsUpdate>> = Vec::new();
    while updates.len() < count {
        let after = updates
            .last()
            .map_or(i128::MIN, |update| update.reading.sampled_at_ms);
        updates.push(next_update(subscription, after).await);
    }
    updates
}

// Paused clock, fast fake.

#[tokio::test(start_paused = true)]
async fn memory_available_is_total_minus_used() {
    let source = Arc::new(
        FakeHostMetricsSource::new(vec![]).script_cpu([Ok(CpuMemoryReading {
            cpu_percent: 10.0,
            memory_total_bytes: 32_000_000_000,
            memory_used_bytes: 11_200_000_000,
        })]),
    );
    let collector = collector(source);
    collector.start_background();

    let reading = current(&collector).await;

    assert_eq!(reading.memory_total_bytes, 32_000_000_000);
    assert_eq!(reading.memory_used_bytes, 11_200_000_000);
    assert_eq!(reading.memory_available_bytes, 20_800_000_000);
    collector.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn cpu_is_clamped_to_0_and_100() {
    let source = Arc::new(FakeHostMetricsSource::new(vec![]).script_cpu([cpu(104.5), cpu(-0.2)]));
    let collector = collector(source);
    collector.start_background();

    let first = current(&collector).await;
    run_for(&collector, Duration::from_secs(60), Duration::from_secs(60)).await;
    let second = current(&collector).await;

    assert_eq!(first.cpu_percent, 100.0);
    assert_eq!(second.cpu_percent, 0.0);
    collector.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn construction_reads_nothing_and_starts_no_thread() {
    let source = Arc::new(FakeHostMetricsSource::new(vec![descriptor("/", "ext4")]));
    let collector = collector(source.clone());

    run_for(
        &collector,
        Duration::from_secs(600),
        Duration::from_secs(60),
    )
    .await;

    assert_eq!(source.cpu_reads(), 0);
    assert_eq!(source.list_calls(), 0);
    assert!(lock(&collector.shared.workers).is_none());
    assert!(lock(&collector.shared.tasks).is_empty());
}

#[tokio::test(start_paused = true)]
async fn background_reads_every_60_s_and_volumes_every_fifth_reading() {
    let source = Arc::new(FakeHostMetricsSource::new(vec![descriptor("/", "ext4")]));
    let collector = collector(source.clone());
    collector.start_background();
    quiesce(&collector).await;

    run_for(
        &collector,
        Duration::from_secs(600),
        Duration::from_secs(10),
    )
    .await;

    // Readings at 0, 60, ..., 600 s; volumes at the 1st, 6th and 11th.
    let readings = source.cpu_reads();
    assert!((10..=11).contains(&readings), "{readings} reads");
    assert_eq!(source.list_calls(), readings.div_ceil(5));
    assert_eq!(source.space_reads("/"), source.list_calls());
    collector.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn streams_switch_to_the_live_rate_and_share_one_read() {
    let source = Arc::new(FakeHostMetricsSource::new(vec![descriptor("/", "ext4")]));
    let collector = collector(source.clone());
    collector.start_background();
    quiesce(&collector).await;

    run_for(&collector, Duration::from_secs(120), Duration::from_secs(1)).await;
    let background = source.cpu_reads();
    let first = collector.subscribe();
    run_for(
        &collector,
        Duration::from_secs(10),
        Duration::from_millis(100),
    )
    .await;
    let one_stream = source.cpu_reads() - background;
    let second = collector.subscribe();
    assert_eq!(collector.live_subscribers(), 2);
    run_for(
        &collector,
        Duration::from_secs(10),
        Duration::from_millis(100),
    )
    .await;
    let two_streams = source.cpu_reads() - background - one_stream;
    drop(first);
    drop(second);
    assert_eq!(collector.live_subscribers(), 0);
    let before_idle = source.cpu_reads();
    run_for(&collector, Duration::from_secs(120), Duration::from_secs(1)).await;
    let after = source.cpu_reads() - before_idle;

    assert!(
        (2..=3).contains(&background),
        "{background} background reads"
    );
    assert!(
        (9..=11).contains(&one_stream),
        "{one_stream} reads with one stream"
    );
    assert!(
        (9..=11).contains(&two_streams),
        "{two_streams} reads with two streams"
    );
    assert!((2..=3).contains(&after), "{after} reads after both closed");
    // One read primes the live rate; every other read is a reading, and every fifth reading
    // lists the volumes.
    let readings = source.cpu_reads() - 1;
    assert_eq!(source.list_calls(), readings.div_ceil(5));
    collector.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn the_first_live_reading_covers_one_second() {
    let source =
        Arc::new(FakeHostMetricsSource::new(vec![]).script_cpu([cpu(10.0), cpu(50.0), cpu(90.0)]));
    let collector = collector(source.clone());
    collector.start_background();
    run_for(&collector, Duration::from_secs(30), Duration::from_secs(1)).await;
    assert_eq!(source.cpu_reads(), 1);
    let background = current(&collector).await;

    let mut subscription = collector.subscribe();
    run_for(
        &collector,
        Duration::from_millis(100),
        Duration::from_millis(100),
    )
    .await;
    assert_eq!(
        source.cpu_reads(),
        2,
        "the live rate refreshes CPU once first"
    );
    let subscribed_at = collector.shared.now_ms();
    run_for(
        &collector,
        Duration::from_millis(1_000),
        Duration::from_millis(100),
    )
    .await;
    let update = subscription
        .receiver()
        .borrow_and_update()
        .clone()
        .expect("a live reading");

    assert_eq!(update.reading.cpu_percent, 90.0);
    let covered = update.reading.sampled_at_ms - subscribed_at;
    assert!((900..=1_000).contains(&covered), "{covered} ms");
    assert!(update.reading.sampled_at_ms > background.sampled_at_ms);
    // 10 percent for a minute, 90 for a second; the priming read counts for nothing.
    let expected = (10.0 * 60.0 + 90.0) / 61.0;
    assert!(
        (update.cpu.average - expected).abs() < 1e-9,
        "{:?}",
        update.cpu
    );
    collector.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_cpu_read_keeps_the_last_reading_and_warns_once() {
    let log = CapturedLog::default();
    let _logging = capture(&log);
    let source = Arc::new(FakeHostMetricsSource::new(vec![]).script_cpu([
        cpu(30.0),
        Err("host statistics unavailable".to_owned()),
        Err("host statistics unavailable".to_owned()),
        Err("host statistics unavailable".to_owned()),
    ]));
    let collector = collector(source.clone());
    collector.start_background();
    let first = current(&collector).await;

    run_for(
        &collector,
        Duration::from_secs(180),
        Duration::from_secs(60),
    )
    .await;

    assert_eq!(source.cpu_reads(), 4);
    assert_eq!(current(&collector).await, first);
    assert_eq!(
        log.text().matches("host metrics sample failed").count(),
        1,
        "{}",
        log.text()
    );
    collector.shutdown().await;
}

#[test]
fn free_above_total_is_clamped() {
    let reading = volume_reading(
        descriptor("/", "ext4"),
        VolumeSpace {
            total_bytes: 100 * GB,
            free_bytes: 800 * GB,
        },
    );

    assert_eq!(reading.total_bytes, Some(100 * GB));
    assert_eq!(reading.free_bytes, Some(100 * GB));
    assert_eq!(reading.used_bytes(), Some(0));
    assert_eq!(reading.state, VolumeState::Ok);
}

#[tokio::test]
async fn snapshot_waits_at_most_one_second_for_the_first_reading() {
    let source = Arc::new(BlockingHostMetricsSource::new(FakeHostMetricsSource::new(
        vec![],
    )));
    let release = source.hold_cpu();
    let collector = collector(source.clone());
    collector.start_background();

    let started = std::time::Instant::now();
    let snapshot = collector.snapshot().await;
    let waited = started.elapsed();

    assert!(snapshot.current.is_none());
    assert!(
        (Duration::from_millis(900)..Duration::from_millis(1_500)).contains(&waited),
        "{waited:?}"
    );
    assert_eq!(snapshot.facts.cpu_count, 12);
    drop(release);
    collector.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn the_first_subscriber_starts_an_idle_collector() {
    let source = Arc::new(FakeHostMetricsSource::new(vec![]));
    let collector = collector(source.clone());
    run_for(
        &collector,
        Duration::from_secs(120),
        Duration::from_secs(10),
    )
    .await;
    assert_eq!(source.cpu_reads(), 0);

    let mut subscription = collector.subscribe();
    run_for(
        &collector,
        Duration::from_secs(2),
        Duration::from_millis(100),
    )
    .await;

    assert!(source.cpu_reads() >= 2);
    assert!(subscription.receiver().borrow_and_update().is_some());
    assert_eq!(collector.live_subscribers(), 1);
    collector.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn the_chart_revision_rises_when_a_minute_bucket_closes() {
    let source = Arc::new(FakeHostMetricsSource::new(vec![]));
    let collector = collector(source);
    collector.start_background();
    let first = collector.snapshot().await.chart;
    assert!(first.uptime.is_empty());

    run_for(&collector, Duration::from_secs(60), Duration::from_secs(60)).await;
    let later = collector.snapshot().await.chart;

    assert!(later.revision > first.revision);
    assert_eq!(later.uptime.len(), 1);
    collector.shutdown().await;
}

/// #292 review: a wall clock moved back an hour neither freezes the chart nor folds new
/// readings into an older bucket; readings keep their wall time as a label.
#[tokio::test(start_paused = true)]
async fn a_wall_clock_moved_back_keeps_the_chart_moving() {
    let source = Arc::new(FakeHostMetricsSource::new(vec![]));
    let collector = collector(source);
    collector.start_background();
    run_for(
        &collector,
        Duration::from_secs(180),
        Duration::from_secs(60),
    )
    .await;
    let before = collector.snapshot().await;

    collector
        .shared
        .wall_offset_ms
        .store(-3_600_000, Ordering::Release);
    run_for(
        &collector,
        Duration::from_secs(180),
        Duration::from_secs(60),
    )
    .await;
    let after = collector.snapshot().await;

    assert!(
        after.chart.uptime.len() >= before.chart.uptime.len() + 3,
        "{} bars before, {} after",
        before.chart.uptime.len(),
        after.chart.uptime.len()
    );
    let newest = after.recent.last().expect("recent points");
    let previous = before.recent.last().expect("recent points");
    assert!(
        newest.sampled_at_ms > previous.sampled_at_ms,
        "{:?}",
        after.recent
    );
    let (before, after) = (
        before.current.expect("a reading"),
        after.current.expect("a reading"),
    );
    assert!(after.sequence > before.sequence);
    assert!(
        after.sampled_at_ms < before.sampled_at_ms,
        "the label is the wall time"
    );
    collector.shutdown().await;
}

/// #292 review: a listing that hangs is reported apart from any volume, and its recovery too.
#[tokio::test(flavor = "current_thread")]
async fn a_hung_listing_is_reported_and_recovers() {
    let log = CapturedLog::default();
    let _logging = capture(&log);
    let source = blocking(vec![descriptor("/", "ext4")]);
    let list = source.hold_list(1);
    let rates = HostMetricsRates {
        volumes_every: 1_000,
        ..HostMetricsRates::default()
    };
    let collector = HostMetricsCollector::new(source.clone(), rates, identity())
        .with_volume_cadence(Duration::from_millis(200));
    let mut subscription = collector.subscribe();

    wait_until("the hung listing is logged", || {
        log.text().contains("host volume listing did not answer")
    })
    .await;
    let mut last = i128::MIN;
    let reading = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let update = next_update(&mut subscription, last).await;
            last = update.reading.sampled_at_ms;
            if update.reading.volume_listing_not_responding {
                return update.reading.clone();
            }
        }
    })
    .await
    .expect("a reading says the listing is not responding");
    assert!(!reading.volumes_paused, "volume reads go on");
    assert_eq!(
        volume(&reading, "/").map(|volume| volume.state),
        Some(VolumeState::Ok),
        "a hung listing marks no volume"
    );
    list.send(vec![descriptor("/", "ext4")])
        .expect("the listing is held");
    wait_until("the listing's recovery is logged", || {
        log.text().contains("host volume listing answered again")
    })
    .await;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let update = next_update(&mut subscription, last).await;
            last = update.reading.sampled_at_ms;
            if !update.reading.volume_listing_not_responding {
                return;
            }
        }
    })
    .await
    .expect("a reading says the listing answers again");
    collector.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn after_shutdown_a_subscription_gets_no_reading() {
    let source = Arc::new(FakeHostMetricsSource::new(vec![]));
    let collector = collector(source.clone());
    collector.start_background();
    let _ = current(&collector).await;

    collector.shutdown().await;
    let reads = source.cpu_reads();
    let mut subscription = collector.subscribe();
    run_for(&collector, Duration::from_secs(10), Duration::from_secs(1)).await;

    assert_eq!(source.cpu_reads(), reads);
    assert!(subscription.receiver().changed().await.is_err());
}

// Real clock, held threads.

fn blocking(volumes: Vec<VolumeDescriptor>) -> Arc<BlockingHostMetricsSource> {
    Arc::new(BlockingHostMetricsSource::new(FakeHostMetricsSource::new(
        volumes,
    )))
}

async fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting: {what}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cpu_and_memory_keep_their_pace_while_disks_hang() {
    let source = blocking(vec![
        descriptor("/", "ext4"),
        descriptor("/mnt/slow", "ext4"),
    ]);
    let slow = source.hold_space("/mnt/slow", 0);
    let list = source.hold_list(1);
    let collector = collector(source.clone());
    let mut subscription = collector.subscribe();

    let updates = collect_updates(&mut subscription, 8).await;

    assert_live(&updates, 1_000);
    let last_four = &updates[4..];
    for update in last_four {
        assert_eq!(
            volume(&update.reading, "/").map(|volume| volume.state),
            Some(VolumeState::Ok)
        );
        let slow_volume = volume(&update.reading, "/mnt/slow").expect("/mnt/slow is listed");
        assert_eq!(slow_volume.state, VolumeState::NotResponding);
        assert_eq!(slow_volume.total_bytes, None);
    }
    assert_eq!(source.inner.list_calls(), 2, "the second list is held");
    assert_eq!(source.inner.space_reads("/mnt/slow"), 1);
    drop((slow, list));
    collector.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_volume_that_answers_late_recovers() {
    let source = blocking(vec![
        descriptor("/", "ext4"),
        descriptor("/mnt/slow", "ext4"),
    ]);
    let slow = source.hold_space("/mnt/slow", 0);
    let collector = collector(source.clone());
    let mut subscription = collector.subscribe();
    let mut last = 0;
    loop {
        let update = next_update(&mut subscription, last).await;
        last = update.reading.sampled_at_ms;
        if volume(&update.reading, "/mnt/slow")
            .is_some_and(|volume| volume.state == VolumeState::NotResponding)
        {
            break;
        }
    }

    slow.send(VolumeSpace {
        total_bytes: 100 * GB,
        free_bytes: 30 * GB,
    })
    .expect("the held read is waiting");
    let recovered = loop {
        let update = next_update(&mut subscription, last).await;
        last = update.reading.sampled_at_ms;
        let slow_volume = volume(&update.reading, "/mnt/slow").cloned();
        if slow_volume
            .as_ref()
            .is_some_and(|volume| volume.state == VolumeState::Ok)
        {
            break slow_volume.expect("checked");
        }
    };

    assert_eq!(recovered.total_bytes, Some(100 * GB));
    assert_eq!(recovered.free_bytes, Some(30 * GB));
    wait_until("the next volume tick reads /mnt/slow again", || {
        source.inner.space_reads("/mnt/slow") == 2
    })
    .await;
    collector.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_worker_held_pauses_disk_reads() {
    let mounts = ["/a", "/b", "/c", "/d"];
    let source = blocking(
        mounts
            .iter()
            .map(|mount| descriptor(mount, "ext4"))
            .collect(),
    );
    let holds = mounts
        .iter()
        .map(|mount| source.hold_space(mount, 0))
        .collect::<Vec<_>>();
    let collector = collector(source.clone());
    let mut subscription = collector.subscribe();

    let updates = collect_updates(&mut subscription, 10).await;

    assert_live(&updates, 1_000);
    // Held from about one second in; the limit passes two seconds later.
    for update in &updates[4..] {
        assert!(update.reading.volumes_paused, "{:?}", update.reading);
    }
    assert!(!updates[0].reading.volumes_paused);
    assert_eq!(
        source.inner.list_calls() + source.inner.all_space_reads(),
        5,
        "one list and four held reads, and no fifth disk call"
    );
    drop(holds);
    collector.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_volume_replaced_at_the_same_mount_point_gets_fresh_state() {
    let inner = FakeHostMetricsSource::with_list(Box::new(|call| match call {
        1 => vec![descriptor("/", "ext4")],
        _ => vec![descriptor("/", "ext4"), descriptor("/mnt/usb", "exfat")],
    }))
    .space("/mnt/usb", 64 * GB, 10 * GB);
    let source = Arc::new(BlockingHostMetricsSource::new(inner));
    let first_generation = source.hold_space("/mnt/usb", 0);
    // Holds the generation 2 volume's next read, so no later read hides a late result.
    let later_read = source.hold_space("/mnt/usb", 2);
    let rates = HostMetricsRates {
        volumes_every: 1_000,
        ..HostMetricsRates::default()
    };
    let collector = HostMetricsCollector::new(source.clone(), rates, identity())
        .with_volume_cadence(Duration::from_millis(300));
    let mut subscription = collector.subscribe();

    wait_until("a later listing shows /mnt/usb again and reads it", || {
        source.inner.list_calls() >= 3 && source.inner.space_reads("/mnt/usb") >= 2
    })
    .await;
    // The generation 1 read is still held while the generation 2 read was admitted.
    first_generation
        .send(VolumeSpace {
            total_bytes: 32 * GB,
            free_bytes: 30 * GB,
        })
        .expect("the first generation read is still held");
    let mut last = 0;
    let mut shown = None;
    for _ in 0..3 {
        let update = next_update(&mut subscription, last).await;
        last = update.reading.sampled_at_ms;
        shown = volume(&update.reading, "/mnt/usb").cloned();
    }

    let shown = shown.expect("/mnt/usb is listed");
    assert_eq!(shown.total_bytes, Some(64 * GB));
    assert_eq!(shown.free_bytes, Some(10 * GB));
    drop(later_read);
    collector.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mount_churn_keeps_state_bounded() {
    let inner = FakeHostMetricsSource::with_list(Box::new(|call| {
        vec![
            descriptor("/", "ext4"),
            descriptor(&format!("/mnt/churn-{call}"), "ext4"),
        ]
    }));
    let source = Arc::new(BlockingHostMetricsSource::new(inner));
    let rates = HostMetricsRates {
        volumes_every: 1_000,
        ..HostMetricsRates::default()
    };
    let collector = HostMetricsCollector::new(source.clone(), rates, identity())
        .with_volume_cadence(Duration::from_millis(50));
    let mut subscription = collector.subscribe();

    let mut updates: Vec<Arc<HostMetricsUpdate>> = Vec::new();
    while source.inner.list_calls() < 200 {
        let after = updates
            .last()
            .map_or(i128::MIN, |update| update.reading.sampled_at_ms);
        updates.push(next_update(&mut subscription, after).await);
    }
    quiesce(&collector).await;

    assert_live(&updates, 1_000);
    let tracked = lock(&collector.shared.disk_view).tracked;
    assert!(tracked <= 2, "{tracked} volumes tracked");
    let workers = lock(&collector.shared.workers)
        .clone()
        .expect("the workers run");
    let held = workers.held_and_queued();
    // The latest listing's volumes and one list job; no read is held in this test.
    assert!(held <= 3, "{held} jobs queued or running");
    collector.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_returns_while_a_disk_call_is_held() {
    let source = blocking(vec![descriptor("/", "ext4")]);
    let held = source.hold_space("/", 0);
    let collector = collector(source.clone());
    collector.start_background();
    wait_until("the space read started", || {
        source.inner.space_reads("/") == 1
    })
    .await;

    tokio::time::timeout(Duration::from_millis(500), collector.shutdown())
        .await
        .expect("shutdown does not wait for the held read");
    drop(held);
}

#[tokio::test(flavor = "current_thread")]
async fn a_hung_volume_log_names_no_mount_point() {
    let log = CapturedLog::default();
    let _logging = capture(&log);
    let source = blocking(vec![
        descriptor("/", "ext4"),
        descriptor("/media/test-user/backup", "exfat"),
    ]);
    let held = source.hold_space("/media/test-user/backup", 0);
    let collector = collector(source.clone());
    collector.start_background();

    wait_until("the hung volume is logged", || {
        log.text().contains("host volume did not answer")
    })
    .await;

    let text = log.text();
    let line = text
        .lines()
        .find(|line| line.contains("host volume did not answer"))
        .expect("logged");
    assert!(line.contains("file_system=exfat"), "{line}");
    assert!(line.contains("position=1"), "{line}");
    assert!(!text.contains("test-user"), "{text}");
    assert!(!text.contains("backup"), "{text}");
    drop(held);
    collector.shutdown().await;
}

#[derive(Clone, Default)]
struct CapturedLog(Arc<Mutex<Vec<u8>>>);

impl CapturedLog {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl std::io::Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Captures this thread's log; the tests that use it run their tasks on this thread.
fn capture(log: &CapturedLog) -> tracing::subscriber::DefaultGuard {
    let log = log.clone();
    tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || log.clone())
            .finish(),
    )
}

/// Panics on the first listing and on the first space read, then answers.
#[derive(Debug, Default)]
struct PanickingOnceSource {
    lists: AtomicUsize,
    reads: AtomicUsize,
}

impl HostMetricsSource for PanickingOnceSource {
    fn host_facts(&self) -> HostFacts {
        FakeHostMetricsSource::new(vec![]).host_facts()
    }

    fn read_cpu_memory(&self) -> Result<CpuMemoryReading, SamplingError> {
        cpu(10.0).map_err(SamplingError::Failed)
    }

    fn list_volumes(&self) -> Vec<VolumeDescriptor> {
        assert!(
            self.lists.fetch_add(1, Ordering::AcqRel) > 0,
            "listing failed at /media/test-user/backup"
        );
        vec![descriptor("/", "ext4")]
    }

    fn read_volume_space(&self, _mount_point: &Path) -> Result<VolumeSpace, String> {
        assert!(
            self.reads.fetch_add(1, Ordering::AcqRel) > 0,
            "read failed at /media/test-user/backup"
        );
        Ok(VolumeSpace {
            total_bytes: 100 * GB,
            free_bytes: 40 * GB,
        })
    }
}

/// Waits on the real clock until the workers hold a result, then takes them as debug text.
async fn next_results(workers: &disk_workers::DiskWorkers) -> String {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let results = workers.take_results();
            if !results.is_empty() {
                return format!("{results:?}");
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("a disk result arrives")
}

/// #292 review P1: a disk call that panics frees its key, reports a failure that names no
/// path, and leaves the only worker able to run the next job.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_panicking_disk_call_fails_its_job_and_keeps_the_worker() {
    let workers = disk_workers::DiskWorkers::start(
        Arc::new(PanickingOnceSource::default()),
        1,
        Duration::from_secs(60),
    );
    let admit = |mount_point: Option<&str>| {
        workers.admit(DiskJob {
            key: DiskJobKey {
                mount_point: mount_point.map(PathBuf::from),
                generation: 0,
            },
        })
    };

    assert_eq!(admit(None), Admission::Admitted);
    let failed_list = next_results(&workers).await;
    assert!(failed_list.contains("Listed(Err("), "{failed_list}");
    assert_eq!(admit(Some("/")), Admission::Admitted);
    let failed_read = next_results(&workers).await;
    assert!(failed_read.contains("Space(Err("), "{failed_read}");
    assert_eq!(admit(None), Admission::Admitted, "the listing key is free");
    let listed = next_results(&workers).await;
    assert!(
        listed.contains("Listed(Ok("),
        "the worker runs on: {listed}"
    );
    assert!(!failed_list.contains("test-user"), "{failed_list}");
    assert!(!failed_read.contains("test-user"), "{failed_read}");
    workers.stop();
}

/// R81: a network volume is hidden with its reason before any space read.
#[tokio::test(start_paused = true)]
async fn a_network_volume_is_hidden_with_its_reason_and_never_read() {
    let source = Arc::new(
        FakeHostMetricsSource::new(vec![
            descriptor("/", "ext4"),
            descriptor("/mnt/share", "nfs4"),
        ])
        .space("/", 100 * GB, 40 * GB)
        .space("/mnt/share", 100 * GB, 10 * GB),
    );
    let collector = collector(source.clone());
    collector.start_background();
    run_for(&collector, Duration::from_secs(5), Duration::from_secs(1)).await;

    let snapshot = collector.snapshot().await;
    let hidden = &snapshot.chart.hidden_volumes;
    assert_eq!(hidden.len(), 1, "{hidden:?}");
    assert_eq!(hidden[0].descriptor.mount_point, Path::new("/mnt/share"));
    assert_eq!(hidden[0].reason, HiddenReason::Network);
    assert_eq!(source.space_reads("/mnt/share"), 0);
    assert_eq!(source.space_reads("/"), 1);
    let wire = wire::encode_snapshot(&snapshot);
    assert_eq!(
        wire["hiddenVolumes"],
        serde_json::json!([{ "mountPoint": "/mnt/share", "fileSystem": "nfs4", "reason": "network" }])
    );
    collector.shutdown().await;
}

/// R81: an empty volume and a second mount of `/`'s storage are read, then hidden.
#[tokio::test(start_paused = true)]
async fn an_empty_or_shared_volume_is_hidden_after_its_read() {
    let source = Arc::new(
        FakeHostMetricsSource::new(vec![
            descriptor("/", "ext4"),
            descriptor("/mnt/empty", "tmpfs"),
            descriptor("/srv/same", "ext4"),
        ])
        .space("/", 100 * GB, 40 * GB)
        .space("/mnt/empty", 0, 0)
        .space("/srv/same", 100 * GB, 40 * GB),
    );
    let collector = collector(source.clone());
    collector.start_background();
    // The second background reading, at 60 s, is the first to carry the volumes read at 0 s.
    run_for(&collector, Duration::from_secs(65), Duration::from_secs(5)).await;

    let snapshot = collector.snapshot().await;
    let reasons = snapshot
        .chart
        .hidden_volumes
        .iter()
        .map(|hidden| (hidden.descriptor.mount_point.clone(), hidden.reason.clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        reasons,
        [
            (PathBuf::from("/mnt/empty"), HiddenReason::Empty),
            (
                PathBuf::from("/srv/same"),
                HiddenReason::SameStorage {
                    as_mount: PathBuf::from("/")
                }
            ),
        ]
    );
    assert_eq!(source.space_reads("/mnt/empty"), 1);
    assert_eq!(source.space_reads("/srv/same"), 1);
    assert_eq!(
        snapshot.current.as_ref().expect("a reading").volumes.len(),
        1
    );
    let wire = wire::encode_snapshot(&snapshot);
    assert_eq!(wire["hiddenVolumes"][1]["reason"], "sameStorage");
    assert_eq!(wire["hiddenVolumes"][1]["sameStorageAs"], "/");
    collector.shutdown().await;
}
