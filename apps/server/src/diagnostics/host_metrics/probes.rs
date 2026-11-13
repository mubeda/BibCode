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
    pre_filter, volume_reading, volumes::current_appimage, wire,
};

/// Lists every volume the native source returns and says whether the filter keeps or hides it.
#[test]
#[ignore = "probe: run by hand on a real host"]
fn volume_probe() {
    let source = Arc::new(NativeHostMetricsSource::new());
    let listed = source.list_volumes();
    let (kept, mut hidden) = pre_filter(
        listed.clone(),
        std::env::current_exe().ok().as_deref(),
        current_appimage().as_deref(),
    );
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
                            statistics_since_ms: lock(&live.shared.statistics).since_ms,
                            cpu,
                            memory,
                            chart: Arc::new(ChartState {
                                revision: u64::try_from(items).unwrap_or(0),
                                uptime,
                                hidden_volumes: Vec::new(),
                            }),
                            volume_statistics: live.shared.volume_statistics(),
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

/// Runs a system tool and returns its standard output.
#[cfg(unix)]
fn tool_output(program: &str, args: &[&str]) -> String {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("{program} did not run: {error}"));
    assert!(output.status.success(), "{program} failed: {output:?}");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// The first number in `text` after `label`.
#[cfg(unix)]
fn number_after(text: &str, label: &str) -> f64 {
    let start = text
        .find(label)
        .unwrap_or_else(|| panic!("no {label:?} in the tool output"))
        + label.len();
    text[start..]
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|part| !part.is_empty())
        .and_then(|part| part.parse().ok())
        .unwrap_or_else(|| panic!("no number after {label:?}"))
}

/// Total and available bytes of `/` from `df -k -P /`: the 1024-blocks and Available columns,
/// the same `statvfs` fields the collector reads.
#[cfg(unix)]
fn df_root() -> (u64, u64) {
    let output = tool_output("df", &["-k", "-P", "/"]);
    let line = output.lines().nth(1).expect("df printed no volume line");
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .take(3)
        .map(|field| field.parse().expect("df column is a number"))
        .collect();
    (fields[0] * 1024, fields[2] * 1024)
}

/// Total and idle jiffies of `/proc/stat`'s "cpu" line (iowait counts as idle, as in `sysinfo`).
#[cfg(target_os = "linux")]
fn proc_stat_cpu() -> (u64, u64) {
    let stat = std::fs::read_to_string("/proc/stat").expect("read /proc/stat");
    let values: Vec<u64> = stat
        .lines()
        .next()
        .expect("cpu line")
        .split_whitespace()
        .skip(1)
        .map(|value| value.parse().expect("number"))
        .collect();
    // user nice system idle iowait irq softirq steal; guest time is already inside user.
    (values.iter().take(8).sum(), values[3] + values[4])
}

#[cfg(unix)]
fn within(name: &str, native: f64, tool: f64, tolerance: f64, unit: &str) {
    let difference = (native - tool).abs();
    println!(
        "{name}: native {native:.2}{unit}, tool {tool:.2}{unit}, difference {difference:.2}{unit} \
         (tolerance {tolerance:.2}{unit})"
    );
    assert!(difference <= tolerance, "{name} is outside its tolerance");
}

/// Task 11.10 (R80): compares the native source with the operating system's own tools over one
/// 5 s window, naming only `/`. Windows has no part here: it is covered by CI build and unit
/// tests only.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
#[ignore = "probe: run by hand on a real host"]
fn os_tools_probe() {
    let source = NativeHostMetricsSource::new();
    // Primes the CPU counters, so the next read covers the window below.
    source.read_cpu_memory().expect("first read");

    #[cfg(target_os = "linux")]
    let tool_cpu = {
        let (total_before, idle_before) = proc_stat_cpu();
        std::thread::sleep(Duration::from_secs(5));
        let (total_after, idle_after) = proc_stat_cpu();
        let total = (total_after - total_before) as f64;
        100.0 * (total - (idle_after - idle_before) as f64) / total
    };
    #[cfg(target_os = "macos")]
    let tool_cpu = {
        // The second sample covers the 5 s after the first.
        let top = tool_output("top", &["-l", "2", "-s", "5", "-n", "0"]);
        let second = top.rsplit("CPU usage:").next().expect("a CPU usage line");
        100.0 - number_after(second, "sys, ")
    };
    let reading = source.read_cpu_memory().expect("window read");
    within("CPU busy", reading.cpu_percent, tool_cpu, 10.0, " pp");

    let native_memory =
        100.0 * reading.memory_used_bytes as f64 / reading.memory_total_bytes as f64;
    #[cfg(target_os = "linux")]
    let tool_memory = {
        let meminfo = std::fs::read_to_string("/proc/meminfo").expect("read /proc/meminfo");
        let total = number_after(&meminfo, "MemTotal:");
        100.0 * (total - number_after(&meminfo, "MemAvailable:")) / total
    };
    #[cfg(target_os = "macos")]
    let tool_memory = {
        let vm_stat = tool_output("vm_stat", &[]);
        let pages = |label: &str| number_after(&vm_stat, label);
        let used = (pages("Anonymous pages:") - pages("Pages purgeable:")
            + pages("Pages wired down:")
            + pages("Pages occupied by compressor:"))
            * pages("page size of ");
        let total: f64 = tool_output("sysctl", &["-n", "hw.memsize"])
            .trim()
            .parse()
            .expect("hw.memsize");
        100.0 * used / total
    };
    within("memory used", native_memory, tool_memory, 3.0, " pp");

    source.list_volumes();
    let space = source
        .read_volume_space(Path::new("/"))
        .expect("space of /");
    let (df_total, df_available) = df_root();
    let percent_of_df_total = |bytes: u64| 100.0 * bytes as f64 / df_total as f64;
    within(
        "/ total, percent of df's total",
        percent_of_df_total(space.total_bytes),
        100.0,
        1.0,
        "%",
    );
    #[cfg(target_os = "linux")]
    let tool_free = df_available;
    #[cfg(target_os = "macos")]
    let tool_free = {
        // The property `sysinfo` reads, with its fallback (`src/unix/apple/disk.rs` 380-391).
        let script = "ObjC.import('Foundation'); \
            const url = $.NSURL.fileURLWithPath('/'); \
            const keys = ['NSURLVolumeAvailableCapacityForImportantUsageKey', \
            'NSURLVolumeAvailableCapacityKey']; \
            const values = url.resourceValuesForKeysError($(keys), null); \
            const important = Number(values.objectForKey(keys[0]).js); \
            important > 0 ? important : Number(values.objectForKey(keys[1]).js)";
        let important: f64 = tool_output("osascript", &["-l", "JavaScript", "-e", script])
            .trim()
            .parse()
            .expect("available capacity");
        println!(
            "/ df Available {:.2}% of df's total; free must be at least that",
            percent_of_df_total(df_available)
        );
        assert!(
            space.free_bytes >= df_available,
            "free is below df's Available"
        );
        important as u64
    };
    // Free within 1 percent of the tool's value.
    within(
        "/ free, percent of df's total",
        percent_of_df_total(space.free_bytes),
        percent_of_df_total(tool_free),
        percent_of_df_total(tool_free) / 100.0,
        "%",
    );
}
