//! Probes run by hand on a real host (`--ignored --exact`), never in CI. They print to the
//! terminal only; what they print names local volumes, so it never goes into a file or report.

use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use tokio_util::sync::CancellationToken;

use super::{
    ChartState, CpuMemoryReading, HostFacts, HostMetricsCollector, HostMetricsIdentity,
    HostMetricsRates, HostMetricsSource, HostMetricsUpdate, SamplingError, VolumeDescriptor,
    VolumeReading, VolumeSpace, VolumeState, lock, merge_shared, native::NativeHostMetricsSource,
    pre_filter, volume_reading, wire,
};

/// Lists every volume the native source returns and says whether the filter keeps or hides it.
#[test]
#[ignore = "probe: run by hand on a real host"]
fn volume_probe() {
    let source = Arc::new(NativeHostMetricsSource::new());
    let listed = source.list_volumes();
    let (kept, mut hidden) = pre_filter(listed.clone());
    let read = kept
        .into_iter()
        .map(
            |descriptor| match source.read_volume_space(&descriptor.mount_point) {
                Ok(space) => volume_reading(descriptor, space),
                Err(error) => {
                    println!(
                        "space read failed for {}: {error}",
                        descriptor.mount_point.display()
                    );
                    VolumeReading {
                        descriptor,
                        total_bytes: None,
                        free_bytes: None,
                        state: VolumeState::NotResponding,
                    }
                }
            },
        )
        .collect::<Vec<_>>();
    let readings = read.clone();
    let (shown, merged) = merge_shared(read);
    hidden.extend(merged);

    println!("{} volumes listed", listed.len());
    for descriptor in &listed {
        let reading = readings
            .iter()
            .find(|reading| reading.descriptor.mount_point == descriptor.mount_point);
        let verdict = if shown
            .iter()
            .any(|shown| shown.descriptor.mount_point == descriptor.mount_point)
        {
            "kept".to_owned()
        } else {
            hidden
                .iter()
                .find(|hidden| hidden.descriptor.mount_point == descriptor.mount_point)
                .map_or_else(
                    || "missing".to_owned(),
                    |hidden| format!("hidden: {:?}", hidden.reason),
                )
        };
        println!(
            "{} fs={} total={:?} free={:?} removable={} read_only={} file={} -> {verdict}",
            descriptor.mount_point.display(),
            descriptor.file_system,
            reading.and_then(|reading| reading.total_bytes),
            reading.and_then(|reading| reading.free_bytes),
            descriptor.removable,
            descriptor.read_only,
            descriptor.is_file,
        );
    }
}

/// This process's CPU time, user plus system.
#[cfg(unix)]
fn process_cpu_time() -> std::time::Duration {
    // SAFETY: `rusage` is plain data that `getrusage` fills.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: `usage` is a valid, writable `rusage`.
    let status = unsafe { libc::getrusage(libc::RUSAGE_SELF, &raw mut usage) };
    assert_eq!(status, 0, "getrusage failed");
    let time = |value: libc::timeval| {
        std::time::Duration::from_secs(u64::try_from(value.tv_sec).unwrap_or(0))
            + std::time::Duration::from_micros(u64::try_from(value.tv_usec).unwrap_or(0))
    };
    time(usage.ru_utime) + time(usage.ru_stime)
}

/// This process's CPU time, user plus kernel.
#[cfg(windows)]
fn process_cpu_time() -> std::time::Duration {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };

    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: every pointer refers to initialized FILETIME storage; the pseudo handle of the
    // current process needs no closing.
    let read = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &raw mut creation,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        )
    };
    assert_ne!(read, 0, "GetProcessTimes failed");
    let ticks =
        |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    // FILETIME counts 100 ns ticks.
    std::time::Duration::from_nanos((ticks(kernel) + ticks(user)) * 100)
}

/// Counts the native source's CPU and memory reads, so the probe knows how many readings it paid
/// for.
#[derive(Debug)]
struct CountingSource {
    inner: NativeHostMetricsSource,
    reads: AtomicUsize,
}

impl CountingSource {
    fn new() -> Self {
        Self {
            inner: NativeHostMetricsSource::new(),
            reads: AtomicUsize::new(0),
        }
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::Acquire)
    }
}

impl HostMetricsSource for CountingSource {
    fn host_facts(&self) -> HostFacts {
        self.inner.host_facts()
    }

    fn read_cpu_memory(&self) -> Result<CpuMemoryReading, SamplingError> {
        self.reads.fetch_add(1, Ordering::AcqRel);
        self.inner.read_cpu_memory()
    }

    fn list_volumes(&self) -> Vec<VolumeDescriptor> {
        self.inner.list_volumes()
    }

    fn read_volume_space(&self, mount_point: &Path) -> Result<VolumeSpace, String> {
        self.inner.read_volume_space(mount_point)
    }
}

const PROBE_READINGS: usize = 300;
const PROBE_RATE: Duration = Duration::from_millis(250);

/// CPU time spent while `run` lasts, minus an idle runtime of the same length.
fn cpu_cost(
    runtime: &tokio::runtime::Runtime,
    run: impl std::future::Future<Output = ()>,
) -> Duration {
    let wall = std::time::Instant::now();
    let before = process_cpu_time();
    runtime.block_on(run);
    let busy = process_cpu_time().saturating_sub(before);
    let length = wall.elapsed();
    let before = process_cpu_time();
    runtime.block_on(async move { tokio::time::sleep(length).await });
    let idle = process_cpu_time().saturating_sub(before);
    println!(
        "  run {:.1} s: {:.1} ms CPU, idle {:.1} ms CPU",
        length.as_secs_f64(),
        busy.as_secs_f64() * 1_000.0,
        idle.as_secs_f64() * 1_000.0
    );
    busy.saturating_sub(idle)
}

fn report(kind: &str, cost: Duration, readings: usize) {
    let per_reading_ms = cost.as_secs_f64() * 1_000.0 / readings.max(1) as f64;
    println!(
        "{kind}: {readings} readings, {:.1} ms CPU above idle, {per_reading_ms:.3} ms per reading; \
         percent of one core at 60 s {:.4}, at 1 s {:.3}, at 2 s {:.3}",
        cost.as_secs_f64() * 1_000.0,
        per_reading_ms / 60_000.0 * 100.0,
        per_reading_ms / 1_000.0 * 100.0,
        per_reading_ms / 2_000.0 * 100.0,
    );
}

/// Task 11.4: measures the real collector over the native source. Background-shaped readings
/// with no subscriber, then live-shaped readings with one subscriber whose items are encoded as on
/// the wire, with the uptime chart rebuilt and sent every fifth reading to over-count chart cost.
/// It asserts nothing about limits: the policy is applied from what it prints.
#[test]
#[ignore = "probe: run by hand on a real host"]
fn cost_probe() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let rates = HostMetricsRates {
        background: PROBE_RATE,
        live: PROBE_RATE,
        ..HostMetricsRates::default()
    };
    let identity = HostMetricsIdentity {
        boot_id: None,
        started_at_ms: 0,
    };

    let source = Arc::new(CountingSource::new());
    let background = HostMetricsCollector::new(source.clone(), rates, identity.clone());
    let cost = cpu_cost(&runtime, async {
        background.start_background();
        while source.reads() < PROBE_READINGS {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        background.shutdown().await;
    });
    report("background", cost, source.reads());

    let source = Arc::new(CountingSource::new());
    let live = Arc::new(HostMetricsCollector::new(source.clone(), rates, identity));
    let cost = cpu_cost(&runtime, {
        let live = live.clone();
        let source = source.clone();
        async move {
            let (sender, mut receiver) = tokio::sync::mpsc::channel(64);
            let cancellation = CancellationToken::new();
            let stream = tokio::spawn(wire::send_host_metrics(
                live.clone(),
                sender,
                cancellation.clone(),
            ));
            let mut items = 0_usize;
            let mut bytes = 0_usize;
            while source.reads() < PROBE_READINGS {
                let Some(Ok(values)) = receiver.recv().await else {
                    break;
                };
                items += 1;
                bytes += serde_json::to_vec(&values).map_or(0, |encoded| encoded.len());
                if items.is_multiple_of(5) {
                    // A chart revision every fifth reading: rebuild the uptime chart and send it.
                    let uptime = lock(&live.shared.statistics).chart.uptime(240);
                    let latest = lock(&live.shared.statistics).current.clone();
                    let summary = {
                        let statistics = lock(&live.shared.statistics);
                        statistics.cpu.summary().zip(statistics.memory.summary())
                    };
                    if let (Some(reading), Some((cpu, memory))) = (latest, summary) {
                        let update = HostMetricsUpdate {
                            reading,
                            cpu,
                            memory,
                            chart: Arc::new(ChartState {
                                revision: u64::try_from(items).unwrap_or(0),
                                uptime,
                                hidden_volumes: Vec::new(),
                            }),
                        };
                        bytes += serde_json::to_vec(&wire::encode_update(&update, true))
                            .map_or(0, |encoded| encoded.len());
                    }
                }
            }
            cancellation.cancel();
            let _ = stream.await;
            live.shutdown().await;
            println!("live: {items} items, {bytes} bytes encoded");
        }
    });
    report("live", cost, source.reads());
}
