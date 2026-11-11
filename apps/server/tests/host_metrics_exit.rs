//! R84: a disk read that never returns does not keep the server process from exiting. The child
//! is shaped like `main.rs`: a multi-thread runtime dropped after `block_on`.

use std::{
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use bibcode_server::diagnostics::{
    SamplingError,
    host_metrics::{
        CpuMemoryReading, HostFacts, HostMetricsCollector, HostMetricsIdentity, HostMetricsRates,
        HostMetricsSource, VolumeDescriptor, VolumeSpace,
    },
};

const CHILD_ENV: &str = "BIBCODE_TEST_HOST_METRICS_EXIT_CHILD";
const TEST_NAME: &str = "a_held_disk_read_does_not_block_exit";
const EXIT_DEADLINE: Duration = Duration::from_secs(5);

/// Lists one volume and blocks its space read forever.
#[derive(Debug, Default)]
struct ForeverSource {
    read_started: AtomicBool,
}

impl HostMetricsSource for ForeverSource {
    fn host_facts(&self) -> HostFacts {
        HostFacts {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            cpu_count: 1,
            memory_total_bytes: 1,
        }
    }

    fn read_cpu_memory(&self) -> Result<CpuMemoryReading, SamplingError> {
        Ok(CpuMemoryReading {
            cpu_percent: 1.0,
            memory_total_bytes: 1,
            memory_used_bytes: 0,
        })
    }

    fn list_volumes(&self) -> Vec<VolumeDescriptor> {
        vec![VolumeDescriptor {
            mount_point: "/mnt/held".into(),
            name: String::new(),
            file_system: "ext4".to_owned(),
            removable: false,
            read_only: false,
            is_file: false,
        }]
    }

    fn read_volume_space(&self, _mount_point: &Path) -> Result<VolumeSpace, String> {
        self.read_started.store(true, Ordering::Release);
        loop {
            std::thread::park();
        }
    }
}

fn run_child() {
    let source = Arc::new(ForeverSource::default());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on({
        let source = source.clone();
        async move {
            let collector = HostMetricsCollector::new(
                source.clone(),
                HostMetricsRates {
                    background: Duration::from_millis(100),
                    live: Duration::from_millis(100),
                    volumes_every: 1,
                    ..HostMetricsRates::default()
                },
                HostMetricsIdentity {
                    boot_id: None,
                    started_at_ms: 0,
                },
            );
            collector.start_background();
            let started = Instant::now();
            while !source.read_started.load(Ordering::Acquire) {
                assert!(
                    started.elapsed() < EXIT_DEADLINE,
                    "the space read never started"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            collector.shutdown().await;
        }
    });
    drop(runtime);
}

#[test]
fn a_held_disk_read_does_not_block_exit() {
    if std::env::var_os(CHILD_ENV).is_some() {
        run_child();
        return;
    }
    let mut child = Command::new(std::env::current_exe().expect("current test binary"))
        .args(["--exact", TEST_NAME, "--nocapture", "--test-threads=1"])
        .env(CHILD_ENV, "1")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start the child");
    let deadline = Instant::now() + EXIT_DEADLINE;
    let status = loop {
        if let Some(status) = child.try_wait().expect("poll the child") {
            break Some(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let status = status.expect("the child exits within 5 s while a disk read is held");
    assert!(status.success(), "the child failed: {status}");
}
