# Phase 11: Host dashboard

- Goal: Every environment opens a Host dashboard that shows its host's CPU, memory and volumes live and since the server started, from an always-on collector whose cost is measured before any web work, with a reviewed design note, contract fixtures, tests on three operating systems, a packaged end-to-end test and user documentation (amendment A10; R66 to R83).
- Round: 4 (after Phase 10, which owns `apps/web/src/components/sidebar/**`; before Phase 8 closes)
- Depends on: 10
- Owns: `apps/server/src/diagnostics/host_metrics/**`, `apps/server/src/diagnostics/mod.rs`, `apps/server/src/production/server_terminal.rs` (the host metrics registration and builder only), `apps/server/src/production/runtime.rs` (collector creation and its quiesce step only), `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs`, `apps/server/src/lifecycle.rs` and `apps/server/src/production/control.rs` (the `hostMetrics` flag and its descriptor test lines only), `apps/server/src/mcp/tools/diagnostics.rs` (Task 11.12), `apps/server/tests/production_server_terminal_rpc.rs`, `apps/server/tests/auth_http.rs` (one scope case), `apps/server/tests/rpc_wire.rs` (counts), `packages/client-runtime/src/state/hostMetrics.ts`, `packages/client-runtime/src/state/server.ts`, `packages/client-runtime/src/rpc/client.ts`, `packages/client-runtime/src/rpc/session.ts`, `apps/web/src/components/hostDashboard/**`, `apps/web/src/state/hostDashboard.ts`, `apps/web/src/AppRoot.tsx`, `apps/web/src/components/sidebar/EnvironmentContextCard.tsx` and its test, `apps/web/src/components/settings/remote-servers/ConnectTab.tsx` and its test, `apps/web/src/components/status-bar/ResourceUsageSegment.tsx` and its test, `apps/desktop/e2e/specs/host-dashboard.e2e.ts`, `.github/workflows/ci.yml` (two host metrics test steps), `docs/plans/2026-11-11-host-metrics-dashboard-design.md`, `docs/architecture/overview.md` (the Diagnostics paragraph), `docs/operations/observability.md` (host metrics log lines), `docs/reference/mcp.md` and `docs/architecture/rpc-and-orchestration.md` (the MCP tool row, Task 11.12)
- Shared files (the coordinator sequences them; another phase drafted in parallel also changes contracts, the changelog, the user guide and the wdio list): `packages/contracts/src/server.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/environment.ts` and their tests, `packages/contracts/scripts/export-rust-rpc-fixtures.ts` and its test, the generated `packages/contracts/fixtures/rpc-wire/**`, `CHANGELOG.md`, `docs/user/workspace-ui.md`, `apps/desktop/e2e/wdio.conf.ts`, `docs/testing/cross-platform-validation.md`, `Cargo.toml` (Task 11.11 only: two `sysinfo` features). Fixture counts are written as increments over whatever the base is when the task starts.
- Must not touch: `apps/server/src/persistence/migrations.rs` (no migration: statistics live in memory, D23; the next free number on this branch is 73), `apps/server/src/diagnostics/monitor.rs` and `history.rs` (the process diagnostics keep their rule), `apps/server/src/git/**`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/files/**`, `docs/plans/2026-11-09-issue-batch-340-345-290/{spec,plan,progress}.md` and other phases' files
- Skills: test-driven-development (every behavior starts from a failing test); vercel-react-best-practices (AGENTS.md requires it for the new sheet and hooks); better-accessibility (the sheet's focus, the disclosure and the chart labels)
- Read first: the spec fragment `amendments/A10-host-dashboard.md` (R66 to R83, D22 to D30); [the design note](../../2026-11-11-host-metrics-dashboard-design.md); `AGENTS.md` (Profiler, Crash, and Trace Coverage; Sensitive Data; Testing Runbook Maintenance); `UI.md`; `docs/architecture/overview.md` lines 3361-3380 (the process monitor's rule this phase makes an exception to)
- Checkpoint: `cargo test -p bibcode-server --lib -j 2 host_metrics`, `cargo test -p bibcode-server --test production_server_terminal_rpc -j 2 host_metrics`, `vp run check:contracts` and, from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/hostDashboard src/components/sidebar/EnvironmentContextCard.test.tsx src/components/settings/remote-servers/ConnectTab.test.tsx src/components/status-bar/ResourceUsageSegment.test.tsx` exit 0. In the app, the status bar's Resource Manager opens Host dashboard for the local computer and it shows CPU, memory and its volumes updating every second.

Order: 11.1 to 11.6 (server: collector, native source, the cost gate, the protocol, the runtime), then 11.7 to 11.9 (web), then the P1 and P2 tasks 11.10 to 11.13, each of which can be cut, then 11.14 and 11.15. Task 11.4 decides between the always-on collector and starting at the first stream (D22, R71); no task after 11.5 starts before it is Closed, and if it picks the fallback, no web task starts before the user approves the change to R70. Run at most one lane that compiles Rust at a time, and check `df -h .` for at least 60 GB free before a Rust task builds. Tests use fake sources, an isolated home and `example-server`; no fixture, log, design note or report names a real host, user, volume name or non-system mount point of the development machine.

The probes of Tasks 11.3, 11.4 and 11.10 are `#[ignore]` unit tests in `apps/server/src/diagnostics/host_metrics/probes.rs`, so they can use crate-private types and never run in CI. Their Unix and Windows parts sit behind `cfg` gates, so the Windows `cargo check -p bibcode-server --all-targets` step still passes. The Linux container used by those probes is an Ubuntu 22.04 image with Rust 1.98.1 (the `rust-toolchain.toml` pin), run with `docker run --rm --init`, the source copied in with `git archive HEAD | docker run -i ... tar -x -C /work` rather than bind-mounted, `CARGO_BUILD_JOBS=4`, and removed with its volumes afterwards.

## Tasks

### Task 11.1: Statistics, chart tiers and the volume filter

- Satisfies: R67 (container and APFS lists; two volumes that only look alike; network volume), R69 (known values; a watched minute does not outweigh an unwatched hour; a week of uptime)
- Depends on: none
- Files: create `apps/server/src/diagnostics/host_metrics/mod.rs` (module and shared types only), `apps/server/src/diagnostics/host_metrics/stats.rs`, `apps/server/src/diagnostics/host_metrics/volumes.rs`; modify `apps/server/src/diagnostics/mod.rs`; modify the design note
- Interfaces: produces in `host_metrics/mod.rs` `pub struct VolumeDescriptor { pub mount_point: PathBuf, pub name: String, pub file_system: String, pub removable: bool, pub read_only: bool, pub is_file: bool }`, `pub enum VolumeState { Ok, NotResponding }`, `pub struct VolumeReading { pub descriptor: VolumeDescriptor, pub total_bytes: Option<u64>, pub free_bytes: Option<u64>, pub state: VolumeState }` with `fn used_bytes(&self) -> Option<u64>`, `pub enum HiddenReason { Network, Overlay, FileMount, Empty, SameStorage { as_mount: PathBuf } }` and `pub struct HiddenVolume { pub descriptor: VolumeDescriptor, pub reason: HiddenReason }`; in `volumes.rs` `pub(crate) fn pre_filter(listed: Vec<VolumeDescriptor>) -> (Vec<VolumeDescriptor>, Vec<HiddenVolume>)` (network types `nfs`, `nfs4`, `cifs`, `smbfs`, `autofs`, `fuse.sshfs`; `overlay` not at `/`; `is_file`) and `pub(crate) fn merge_shared(read: Vec<VolumeReading>) -> (Vec<VolumeReading>, Vec<HiddenVolume>)` (zero total; same file system, total and free bytes, keeping `/` or the shortest mount point); in `stats.rs` `pub struct MeasureStatistics { pub current: f64, pub minimum: f64, pub maximum: f64, pub average: f64, pub p95: f64 }`, `pub(crate) struct RunningStatistic` with `fn record(&mut self, percent: f64, weight: Duration)` and `fn summary(&self) -> Option<MeasureStatistics>` (101 bins; bin `i` holds `[i, i + 1)` and bin 100 holds 100; p95 is the `i` where 95 percent of the weight is reached), `pub struct ChartPoint { pub sampled_at_ms: i128, pub cpu_percent: f64, pub memory_percent: f64 }`, `pub struct ChartBucket { pub started_at_ms: i128, pub duration_ms: u64, pub cpu_average: f64, pub cpu_peak: f64, pub memory_average: f64, pub memory_peak: f64 }` (the output type), a private `StoredBucket` of 24 bytes (start offset and width in seconds as `u32`, four `f32`), and `pub(crate) struct ChartHistory` with `fn record(&mut self, point: ChartPoint, weight: Duration)`, `fn recent(&self) -> Vec<ChartPoint>` (at most 900, last 15 minutes) and `fn uptime(&self, max_bars: usize) -> Vec<ChartBucket>`, with constants `RECENT_WINDOW = 15 min`, `MINUTE_TIER_BUCKETS = 1_440`, `OLDEST_TIER_MAX_BUCKETS = 20_000`. Tasks 11.2 and 11.13 consume them.
- Skills: none
- Read first: `apps/server/src/diagnostics/history.rs` lines 1-40 and its bucket type (`ProcessResourceBucket`, average and peak per bucket); the `sysinfo` 0.39.6 Linux filter (`src/unix/linux/disk.rs` lines 401-428)
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 host_metrics::` exits 0 with the new tests passing

Steps

1. [ ] In `stats.rs` tests write `known_values_give_exact_statistics` (10, 20, 30, 40, 90 with 60 s weight each: current 90, minimum 10, maximum 90, average 38, p95 90), `a_watched_minute_does_not_outweigh_an_unwatched_hour` (60 readings of 10 at 60 s, then 60 of 90 at 1 s: average in 11.3..11.4, p95 10), `values_outside_0_to_100_are_clamped_into_the_end_bins`, `a_week_of_background_readings_stays_bounded` (10,080 readings at 60 s: `recent().len() <= 900`, minute tier at most 1,440, oldest tier at most 20,000, the first bucket starts at the first reading, `uptime(240).len() <= 240`, each bucket's peak at least its average) and `the_oldest_tier_fits_in_one_mebibyte` (`size_of::<StoredBucket>() * OLDEST_TIER_MAX_BUCKETS < 1_048_576`).
2. [ ] In `volumes.rs` tests write the three R67 scenarios with the spec's exact lists, plus `removable_and_read_only_markers_survive_the_filter` and `a_hidden_volume_carries_its_reason`.
3. [ ] Run `cargo test -p bibcode-server --lib -j 2 host_metrics::`. Expected: FAIL to compile, the module does not exist.
4. [ ] Implement the types, `RunningStatistic`, `ChartHistory` (merging adjacent oldest-tier pairs and doubling their width when full; only each tier's open bucket keeps sums and weights) and the two filter functions. Run the command. Expected: PASS.
5. [ ] Prove a test can fail: weight every reading equally in `RunningStatistic::record`, run the command. Expected: FAIL in `a_watched_minute_does_not_outweigh_an_unwatched_hour`. Restore and run again. Expected: PASS.
6. [ ] Add to the design note anything the implementation changed. Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 11.2: The collector loop, its rates, the volume time limit and shutdown

- Satisfies: R66 (memory figures; CPU outside its range), R68 (one volume hangs; the volume answers late; the volume list hangs), R70 (reads per subscriber count), R74 (hung volume log), R79 (no platform-specific code outside the native source)
- Depends on: 11.1
- Files: modify `apps/server/src/diagnostics/host_metrics/mod.rs`; modify `apps/server/src/diagnostics/mod.rs`; modify `docs/operations/observability.md`
- Interfaces: consumes Task 11.1's types; produces `pub trait HostMetricsSource: std::fmt::Debug + Send + Sync + 'static` with `fn host_facts(&self) -> HostFacts`, `fn read_cpu_memory(&self) -> Pin<Box<dyn Future<Output = Result<CpuMemoryReading, SamplingError>> + Send + '_>>`, `fn list_volumes(&self) -> Pin<Box<dyn Future<Output = Vec<VolumeDescriptor>> + Send + '_>>` and `fn read_volume_space(&self, mount_point: &Path) -> Pin<Box<dyn Future<Output = Result<VolumeSpace, String>> + Send + '_>>`; `pub struct VolumeSpace { pub total_bytes: u64, pub free_bytes: u64 }`; `pub struct HostFacts { pub os: &'static str, pub arch: &'static str, pub cpu_count: usize, pub memory_total_bytes: u64 }`; `pub struct CpuMemoryReading { pub cpu_percent: f64, pub memory_total_bytes: u64, pub memory_used_bytes: u64 }`; `pub struct HostReading { pub sampled_at_ms: i128, pub cpu_percent: f64, pub memory_total_bytes: u64, pub memory_used_bytes: u64, pub memory_available_bytes: u64, pub volumes: Vec<VolumeReading>, pub hidden_volumes: Vec<HiddenVolume> }`; `pub struct HostMetricsRates { pub background: Duration, pub live: Duration, pub volumes_every: u32, pub volume_timeout: Duration }` with `Default` = 60 s, 1 s, 5, 2 s; `pub struct HostMetricsIdentity { pub boot_id: Option<String>, pub started_at_ms: i128 }`; `pub struct HostMetricsCollector` (not generic: it holds `Arc<dyn HostMetricsSource>`) with `pub fn new(source: Arc<dyn HostMetricsSource>, rates: HostMetricsRates, identity: HostMetricsIdentity) -> Self` (idle, reads nothing), `pub fn start_background(&self)`, `pub fn subscribe(&self) -> HostMetricsSubscription` (a guard holding `watch::Receiver<Option<Arc<HostMetricsUpdate>>>`; while any guard lives the loop runs at the live rate, and the first guard starts the loop if `start_background` was never called), `pub fn live_subscribers(&self) -> usize`, `pub async fn snapshot(&self) -> HostMetricsSnapshot` (waits at most 1 s for a first reading) and `pub async fn shutdown(&self)`; `pub struct HostMetricsSnapshot { pub identity: HostMetricsIdentity, pub facts: HostFacts, pub statistics_since_ms: Option<i128>, pub current: Option<HostReading>, pub cpu: Option<MeasureStatistics>, pub memory: Option<MeasureStatistics>, pub recent: Vec<ChartPoint>, pub uptime: Vec<ChartBucket> }` and `pub struct HostMetricsUpdate { pub reading: HostReading, pub cpu: MeasureStatistics, pub memory: MeasureStatistics, pub uptime: Option<Vec<ChartBucket>> }` (uptime once a minute). Re-exported from `diagnostics/mod.rs`. Tasks 11.3 to 11.6 consume them.
- Skills: none
- Read first: `apps/server/src/diagnostics/monitor.rs` lines 100-290 (the loop, `keep_sampling`, `publish`'s once-per-distinct-error warning, `shutdown`) and its paused-clock tests at lines 437-670
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 host_metrics::` exits 0 with the new tests passing

Steps

1. [ ] Write a `FakeHostMetricsSource` in the module's tests that counts CPU and memory reads, list calls and volume reads per mount point, returns scripted values, and can hold one mount point's space read, or the list, until the test releases it. Write `memory_available_is_total_minus_used` (32,000,000,000 and 11,200,000,000 give 20,800,000,000), `cpu_is_clamped_to_0_and_100` (104.5 and -0.2 give 100 and 0), `construction_reads_nothing`, `background_reads_every_60_s_and_volumes_every_fifth_reading`, `streams_switch_to_the_live_rate_and_share_one_read` (zero, one and two subscribers, then both dropped, with the spec's R70 ranges), `the_first_live_reading_covers_one_second` (one CPU refresh on the switch, the first live reading 1 s later), `a_hung_volume_is_not_responding_and_read_only_once` (R68 with a paused clock: two readings 5 s apart), `a_volume_that_answers_late_recovers` (release the held read at 12 s: the next volume tick shows it `ok` with 100 GB and 30 GB, the tick after starts a new read), `a_hung_volume_list_reuses_the_last_list` (the reading arrives within 3 s with `/` from the first list), `a_failed_cpu_read_keeps_the_last_reading_and_warns_once`, `snapshot_waits_at_most_one_second_for_the_first_reading`, `the_first_subscriber_starts_an_idle_collector` and `shutdown_stops_the_loop_without_awaiting_a_hung_volume`.
2. [ ] Write `a_hung_volume_log_names_no_mount_point` with a `tracing` capture subscriber: a volume at `/media/test-user/backup` times out; the captured line is `host volume did not answer` with `file_system` and `position` fields and contains neither `test-user` nor `backup`.
3. [ ] Run `cargo test -p bibcode-server --lib -j 2 host_metrics::`. Expected: FAIL to compile, `HostMetricsCollector` is not defined.
4. [ ] Implement the collector: one loop task; a `watch::Sender` for updates; a counter of live guards; the volume list and each volume read run as their own Tokio tasks whose `JoinHandle`s the collector keeps per mount point (and one for the list); each volume tick waits up to `volume_timeout` for the new ones, starts no read for a mount point whose handle is unfinished, and takes a late result when its handle finishes; `pre_filter` before reads and `merge_shared` after them; statistics weighted by the nominal interval of the rate that took the reading; the two warning lines. Run the command. Expected: PASS.
5. [ ] Prove a test can fail: start a new read even when the mount point's handle is unfinished, run `cargo test -p bibcode-server --lib -j 2 a_hung_volume_is_not_responding_and_read_only_once`. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Add the two log lines to `docs/operations/observability.md` next to `slow process diagnostics sample`, with their fields and the rule that no mount point is logged.
7. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 11.3: The native source, and the volume probe on macOS and Linux

- Satisfies: R66 (no process table), R67 (container and APFS lists, on real hosts), R79
- Depends on: 11.2
- Files: create `apps/server/src/diagnostics/host_metrics/native.rs`; create `apps/server/src/diagnostics/host_metrics/probes.rs`; modify `apps/server/src/diagnostics/host_metrics/mod.rs`; modify the design note (section "Where the issue is wrong", item 4, and "Volume filter")
- Interfaces: consumes `HostMetricsSource`; produces `pub struct NativeHostMetricsSource` with `pub fn new() -> Self` (one `System::new()`, never `new_all()`; disks listed with `DiskRefreshKind::nothing()` and held each as its own `Arc<Mutex<Disk>>`; `is_file` from one `std::fs::symlink_metadata` per mount point when the list is refreshed), reading `cpus().len()`, `global_cpu_usage()`, `total_memory()` and `used_memory()`; `read_volume_space` runs `Disk::refresh_specifics(DiskRefreshKind::nothing().with_storage())` on the blocking pool; the first CPU reading waits `sysinfo::MINIMUM_CPU_UPDATE_INTERVAL` with `tokio::time::sleep`. In `probes.rs`, `#[ignore]` test `volume_probe` prints each listed volume as file system, total, free, removable, read-only and kept or hidden with the reason, to the terminal only.
- Skills: none
- Read first: the design note sections "Collector" and "Volume filter"; `sysinfo` 0.39.6 `src/unix/apple/disk.rs` lines 243-340 and `src/common/disk.rs` lines 149-220
- Tier: standard
- TDD: red-green (the no-process test); the probe is evidence for the filter rule, not a behavior test
- Done when: `cargo test -p bibcode-server --lib -j 2 host_metrics::native` exits 0, and `cargo test -p bibcode-server --lib -j 2 host_metrics::probes::volume_probe -- --ignored --nocapture` shows, on the macOS development host, one kept entry for the boot container at `/` and `/System/Volumes/Data` hidden as same storage, and in the Linux container one kept entry for `/` with the `/etc/hosts`, `/etc/hostname` and `/etc/resolv.conf` mounts hidden as file mounts

Steps

1. [ ] Write `native_source_reads_without_refreshing_processes` in `native.rs` tests: after 10 readings the source's `System` holds 0 processes, `cpu_percent` is within 0..=100, `memory_used_bytes <= memory_total_bytes` and `host_facts().cpu_count >= 1`. Run `cargo test -p bibcode-server --lib -j 2 host_metrics::native`. Expected: FAIL to compile.
2. [ ] Implement `NativeHostMetricsSource`. Run the command. Expected: PASS.
3. [ ] Run the probe on the macOS development host. Record in the design note, naming only system mount points (`/`, `/System/Volumes/*`) and no volume names: which kinds of volume `Disks` returns (Recovery, VM, Preboot, simulator runtime images, external disks), which the filter keeps, and whether `/` and `/System/Volumes/Data` merge. Expected: they merge. If they do not, add the failing case to Task 11.1's tests first, change `merge_shared` from the evidence, and report the change to D25 for the coordinator.
4. [ ] Run the probe in the Linux container described above the task list, and compare with `df -T` inside it. Expected: one kept entry for `/` (overlay at `/`); the `/etc/*` file mounts hidden. Any mount the run itself adds (a cache volume) is reported as merged into `/` or as its own volume; record which. Remove the container and its volumes.
5. [ ] Prove the no-process test can fail: replace `System::new()` with `System::new_all()`, run the unit command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 11.4: Measure the collector's cost and decide when it samples

- Satisfies: R71 (measured cost); decides D22 before Task 11.6 and any web task
- Depends on: 11.3
- Files: modify `apps/server/src/diagnostics/host_metrics/probes.rs`; modify the design note (sections "D22" and "Performance")
- Interfaces: consumes `NativeHostMetricsSource`, `RunningStatistic` and `ChartHistory`; produces `#[ignore]` test `cost_probe`, which takes 300 background-shaped readings (CPU and memory each time, volumes every fifth, each recorded into statistics and chart history) and 300 live-shaped readings, 250 ms apart because `sysinfo` skips a CPU refresh closer than 200 ms to the last one, measures this process's CPU time around the work only (`libc::getrusage(RUSAGE_SELF)` on Unix, `GetProcessTimes` on Windows as `diagnostics/native.rs` line 607 does), prints milliseconds of CPU per reading and the derived percent of one core at 60 s and at 1 s, and asserts under 60 ms per background reading and under 10 ms per live reading. Task 11.6 consumes the decision.
- Skills: none
- Read first: the design note's D22 table and decision rule
- Tier: standard
- TDD: exempt (a measurement; its assertions are the R71 limits, and the result is a recorded decision)
- Done when: `cargo test -p bibcode-server --lib -j 2 host_metrics::probes::cost_probe -- --ignored --nocapture --test-threads=1` exits 0 on the macOS development host and in the Linux container, and the design note's D22 section records both figures, the method and which option stands

Steps

1. [ ] Write `cost_probe`. Run it on the macOS development host three times. Expected: exit 0, and figures within 20 percent of each other; if not, close other heavy work and rerun.
2. [ ] Run it in the Linux container under `taskset 0,1`. Expected: exit 0.
3. [ ] Apply D22's rule. Background under the limit on both: option (c) stands. Background over the limit: record option (b), and tell the coordinator that R70 changes (collection starts at the first stream; `statisticsSince` is that time) and that the user must approve before Task 11.6 starts. Live over the limit: set the live rate to 2 s and rerun.
4. [ ] Record the method (single-threaded test, this process's CPU time, 300 readings of each kind 250 ms apart, host and container described without names) and the figures in the design note, and in a short block for the pull request body.
5. [ ] Run `cargo fmt --all --check` and the Windows-relevant check that the `cfg` gates compile: `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 11.5: The host stream protocol and the capability flag

- Satisfies: R72 (snapshot then sample; under-scoped session; client leaves), R73 (older server, server side: both descriptors and the decode default), R74 (no profiler record names a volume)
- Depends on: 11.2 (it can run while Task 11.4 is pending, because it uses the default idle collector and fakes)
- Files: create `apps/server/src/diagnostics/host_metrics/wire.rs`; modify `apps/server/src/rpc/methods.rs`; modify `apps/server/src/auth/scope.rs`; modify `apps/server/src/production/server_terminal.rs`; modify `apps/server/src/lifecycle.rs`; modify `apps/server/src/production/control.rs`; modify `apps/server/tests/production_server_terminal_rpc.rs`; modify `apps/server/tests/auth_http.rs`; modify `apps/server/tests/rpc_wire.rs`; modify `packages/contracts/src/server.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/environment.ts`, `packages/contracts/src/environment.test.ts`, `packages/contracts/src/server.test.ts`; modify `packages/contracts/scripts/export-rust-rpc-fixtures.ts` and `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts`; regenerate `packages/contracts/fixtures/rpc-wire/**`
- Interfaces: consumes `HostMetricsCollector`, `HostMetricsSnapshot`, `HostMetricsUpdate`, `HostMetricsSource` and `NativeHostMetricsSource`; produces the contract schemas `ServerHostFacts`, `ServerHostMetricsVolume` (`mountPoint`, `name`, `fileSystem`, `totalBytes`, `freeBytes`, `usedBytes` as `NullOr(NonNegativeInt)`, `removable`, `readOnly`, `state: "ok" | "notResponding"`), `ServerHostMetricsSample` (`sampledAt`, `cpuPercent`, `memoryTotalBytes`, `memoryUsedBytes`, `memoryAvailableBytes`, `volumes`), `ServerHostMetricsStatistic` (`current`, `minimum`, `average`, `p95`, `maximum`), `ServerHostMetricsChartPoint`, `ServerHostMetricsChartBucket` and `ServerHostMetricsEvent` = union of `TaggedStruct("Snapshot", { host, bootId: NullOr(String), startedAt, statisticsSince: NullOr(IsoDateTime), sample: NullOr(sample), cpu: NullOr(statistic), memory: NullOr(statistic), recent, uptime })` and `TaggedStruct("Sample", { sample, cpu, memory, uptime: NullOr(Array(bucket)) })` in `server.ts`; `WS_METHODS.serverSubscribeHostMetrics = "server.subscribeHostMetrics"` and `WsServerSubscribeHostMetricsRpc` (`payload: Schema.Struct({})`, `success: ServerHostMetricsEvent`, `error: EnvironmentRpcError`, `stream: true`) in the `WsRpcGroup` of `rpc.ts`; `hostMetrics: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))` in `ExecutionEnvironmentCapabilities`; in Rust, `read_stream("server.subscribeHostMetrics")` in `ACTIVE_RPC_METHODS`, the method in the `SCOPE_ORCHESTRATION_READ` arm of `scope.rs`, serde wire types in `wire.rs` that encode `_tag` and camelCase exactly like the schemas, a `host_metrics: Arc<HostMetricsCollector>` field on `ServerTerminalServices` (default: an idle collector over `NativeHostMetricsSource` with `HostMetricsIdentity { boot_id: None, started_at_ms: <now> }`) and `pub fn with_host_metrics(self, collector: Arc<HostMetricsCollector>) -> Self`, the stream registered with `register_stream` inside `register_diagnostics_rpcs`, and `"hostMetrics": true` in `connect_environment_descriptor` and `environment_descriptor`. Tasks 11.6 to 11.9 consume these names.
- Skills: none
- Read first: `apps/server/src/production/server_terminal.rs` lines 540-640 (`send_discovered_local_servers` and `register_diagnostics_rpcs`) and 1450-1458 (`spawn_stream`); `packages/contracts/scripts/export-rust-rpc-fixtures.ts` lines 398-420 (`manualStreamSamples`) and 1028-1045 (the count checks); `apps/server/tests/remote_update_rpc.rs` lines 41-58 (the Rust decode and byte-identical re-encode precedent); `apps/server/tests/auth_http.rs` lines 1385-1435 (a socket whose token has only `orchestration:operate` is refused `orchestration:read` methods)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server --test production_server_terminal_rpc -j 2 host_metrics`, `cargo test -p bibcode-server --test auth_http -j 2 pairing_links_and_client_sessions_can_be_listed_and_revoked`, `cargo test -p bibcode-server --lib -j 2 host_metrics` and `vp run check:contracts` exit 0, the last with the regenerated fixtures committed

Steps

1. [ ] Write the contracts and their tests: in `environment.test.ts`, a descriptor without `hostMetrics` decodes to `false`; in `server.test.ts`, each event member round-trips, `bootId: null` decodes, and an unknown `_tag` is rejected. Add `manualStreamSamples` entries `server.subscribeHostMetrics:0` (a Snapshot with `bootId` `00000000-0000-0000-0000-000000000000`, 12 CPUs, volume `/` and a not-responding `/mnt/slow` with `null` sizes) and `server.subscribeHostMetrics:1` (a Sample with `uptime: null`). Raise the counts in the export script, its test, `rpc_wire.rs` and the manifest by exactly: one method, one stream method, two stream shapes, and the typed failures the new method's error union adds (read the number from the script's own failure message).
2. [ ] Write the Rust tests: `host_metrics_stream_fixtures_round_trip` in `wire.rs` reads `packages/contracts/fixtures/rpc-wire/stream-shapes/server__subscribeHostMetrics-00.json` and `-01.json`, decodes each `values[0]` into the wire type and re-encodes it byte-identical; `encoded_snapshot_stays_under_128_kib` with 900 recent points, 240 buckets and 20 volumes; in `tests/production_server_terminal_rpc.rs`, with a fake source defined in that file and passed through `with_host_metrics`, `host_metrics_stream_sends_a_snapshot_then_samples` (first item `_tag` `Snapshot` with `bootId`, `startedAt` and `host.cpuCount` 12; the next two are `Sample` one second apart) and `host_metrics_stream_ends_when_the_client_leaves` (after the client closes, `live_subscribers()` is 0 within 1 s); add `server.subscribeHostMetrics` to `registrar_source_contains_every_owned_rpc_name`; in `tests/auth_http.rs`, the `orchestration:operate`-only socket of `pairing_links_and_client_sessions_can_be_listed_and_revoked` gets `EnvironmentAuthorizationError` with `requiredScope` `orchestration:read` and no chunk for `server.subscribeHostMetrics`; next to `lifecycle.rs` line 1359 and `control.rs` line 7340, assert `descriptor["capabilities"]["hostMetrics"] == true`.
3. [ ] Run `vp run check:contracts` and `cargo test -p bibcode-server --lib -j 2 host_metrics`. Expected: FAIL, the method, wire types and flag do not exist yet.
4. [ ] Implement the wire types, the field and builder, the registration (a subscriber loop that takes a guard, sends the snapshot, then waits on the watch receiver and sends each update with `sender.send().await` on `spawn_stream`'s 64-item channel, ending on cancellation, `sender.closed()` or a closed watch), the scope entry and both flags. Do not add the method to `is_long_running` or `is_background`: streams are timed to their first item and are log-only (`diagnostics/profiler/latency.rs` lines 33-36 and 470). Run the Done when commands. Expected: PASS.
5. [ ] Prove a test can fail: send the first update before the snapshot, run `cargo test -p bibcode-server --test production_server_terminal_rpc -j 2 host_metrics_stream_sends_a_snapshot_then_samples`. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `vp check` and `vp run typecheck`. Expected: no errors.

### Task 11.6: Start the collector with the server, stop it in quiesce, and test it on three systems

- Satisfies: R70 (from server start, in production), R72 (the production registrar serves the runtime's collector), R79 (CI on Linux, macOS and Windows)
- Depends on: 11.4, 11.5
- Files: modify `apps/server/src/production/runtime.rs`; modify `.github/workflows/ci.yml`; modify `docs/architecture/overview.md`; modify the design note
- Interfaces: consumes `HostMetricsCollector`, `NativeHostMetricsSource`, `with_host_metrics` and Task 11.4's decision; produces a `host_metrics: Arc<HostMetricsCollector>` field on the production runtime, created with `HostMetricsIdentity { boot_id: config.boot_id.map(|id| id.to_string()), started_at_ms: <now> }`, passed with `.with_host_metrics(...)` where `ServerTerminalServices::new_with_process_tree_cleanup` is called (`runtime.rs` line 634), started with `start_background()` under option (c) or left idle under option (b), and shut down with `self.host_metrics.shutdown().await` followed by `steps.mark("host-metrics")` right after the `process-monitor` step (line 1002)
- Skills: none
- Read first: `apps/server/src/production/runtime.rs` lines 616-640 and 974-1010; `.github/workflows/ci.yml` lines 405-425 (the `native_desktop` job runs only filtered server tests on Windows and macOS); `docs/architecture/overview.md` lines 3361-3380
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 production::runtime::tests::host_metrics` exits 0 with the new tests passing

Steps

1. [ ] Write `host_metrics_start_with_the_runtime_and_stop_in_quiesce` in the runtime tests: after a test runtime starts, its collector has taken a first reading within 2 s (option c) or none (option b); after `quiesce_for_update` returns, the collector's loop has ended and a new subscription gets no reading. The order (after `process-monitor`, before the profiler's teardown) is not observable from a test, because `StopSteps` (`diagnostics/profiler/stop_steps.rs`) records only slow steps; the review checks it in `quiesce_for_update`. Run the Done when command. Expected: FAIL, the runtime has no collector.
2. [ ] Implement the field, the creation, the builder call, the start and the quiesce step. Run the command. Expected: PASS.
3. [ ] Prove the test can fail: remove the shutdown call, run the command. Expected: FAIL. Restore and run again. Expected: PASS.
4. [ ] In `.github/workflows/ci.yml`, add steps `Run host metrics tests (Windows)` (`node scripts/run-msvc.mjs cargo test -p bibcode-server --lib -j 2 -- host_metrics::`) and `Run host metrics tests (macOS)` (`cargo test -p bibcode-server --lib -j 2 -- host_metrics::`) after the two `Run background Git index lock tests` steps of the `native_desktop` job. Linux already runs every server test in the `test` job (`vp run -r test` runs `cargo test -p bibcode-server -j 2`).
5. [ ] Update the Diagnostics paragraph of `docs/architecture/overview.md` (line 3361 on): the host collector, its rates, that it is the one diagnostics reader that samples while nobody watches (or, under option b, from the first stream), the 2 s volume limit, the stream and its scope, and its place in the quiesce order. Reconcile the design note with what was built.
6. [ ] Run `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors.

### Task 11.7: The client subscription and the dashboard's state logic

- Satisfies: R73 (older server: no request sent), R77 (one test per state, logic), R78 (hidden document; unfocused but visible, logic)
- Depends on: 11.6
- Files: create `packages/client-runtime/src/state/hostMetrics.ts` and `packages/client-runtime/src/state/hostMetrics.test.ts`; modify `packages/client-runtime/src/state/server.ts` and `packages/client-runtime/src/state/server.test.ts`; modify `packages/client-runtime/src/rpc/client.ts`; modify `packages/client-runtime/src/rpc/session.ts`; create `apps/web/src/components/hostDashboard/hostDashboard.logic.ts` and `apps/web/src/components/hostDashboard/hostDashboard.logic.test.ts`
- Interfaces: consumes `ServerHostMetricsEvent` and `WS_METHODS.serverSubscribeHostMetrics`; produces `export interface HostMetricsView { readonly bootId: string | null; readonly startedAt: string; readonly statisticsSince: string | null; readonly host: ServerHostFacts; readonly sample: ServerHostMetricsSample | null; readonly cpu: ServerHostMetricsStatistic | null; readonly memory: ServerHostMetricsStatistic | null; readonly recent: ReadonlyArray<ServerHostMetricsChartPoint>; readonly uptime: ReadonlyArray<ServerHostMetricsChartBucket> }` and `export function accumulateHostMetrics(previous: Option.Option<HostMetricsView>, event: ServerHostMetricsEvent): readonly [Option.Option<HostMetricsView>, ReadonlyArray<HostMetricsView>]` (the same shape as `projectServerWelcome`, `server.ts` line 97: it emits the new view, appends samples to `recent`, ignores a sample older than the last applied, keeps 900 points, and replaces `uptime` when one arrives); `hostMetrics: createEnvironmentRpcSubscriptionAtomFamily(runtime, { label: "environment-data:server:host-metrics", tag: WS_METHODS.serverSubscribeHostMetrics, idleTtlMs: 0, transform: (stream) => stream.pipe(Stream.mapAccum(Option.none<HostMetricsView>, accumulateHostMetrics)) })` in `createServerEnvironmentAtoms`; the tag in `EnvironmentSubscriptionRpcTag` and `PRE_VERIFICATION_SUBSCRIPTIONS`; in the web logic `export type HostDashboardState = "loading" | "live" | "stale" | "disconnected" | "restarted" | "unsupported" | "error"`, `export function shouldSubscribeToHostMetrics(input: { open: boolean; visible: boolean; connected: boolean; supported: boolean }): boolean`, `export function isServerRestart(previous: HostMetricsView, next: HostMetricsView): boolean` (different non-null `bootId`; when either is `null`, different `startedAt`), and `export function presentHostDashboard(input: { view: HostMetricsView | null; shownView: HostMetricsView | null; connected: boolean; supported: boolean; failure: string | null; lastItemAtMs: number | null; nowMs: number }): HostDashboardPresentation` with the state, the dimmed flag, the notice text ("Last updated 3 s ago", "Disconnected", "Server restarted at <time>", the unsupported text of R73) and values formatted with `formatMemoryBytes`, `formatCpuPercent` and `formatElapsedDurationLabel` (`apps/web/src/timestampFormat.ts` line 112). Task 11.8 consumes them.
- Skills: none
- Read first: `packages/client-runtime/src/state/server.ts` lines 97-113 and 209-216 (`projectServerWelcome` and its `Stream.mapAccum` transform); `packages/client-runtime/src/state/pipelines.ts` lines 100-110 (`idleTtlMs: 0`); `apps/web/src/components/pullRequests/useDocumentVisible.ts`
- Tier: standard
- TDD: red-green
- Done when: `node scripts/run-local-vp.mjs test run packages/client-runtime/src/state/hostMetrics.test.ts packages/client-runtime/src/state/server.test.ts` exits 0, and from `apps/web` `node ../../scripts/run-local-vp.mjs test run --project unit src/components/hostDashboard/hostDashboard.logic.test.ts` exits 0, with the new tests passing

Steps

1. [ ] Write `hostMetrics.test.ts`: a snapshot then two samples gives `recent` of the snapshot's points plus two; a sample older than the last is ignored; a sample with `uptime` replaces the uptime chart; 1,000 samples keep 900 points. Write in `server.test.ts` that the new tag is a pre-verification subscription.
2. [ ] Write `hostDashboard.logic.test.ts`: `shouldSubscribeToHostMetrics` is false when closed, hidden, disconnected or unsupported and true otherwise (focus is not an input); `isServerRestart` for different boot IDs, equal boot IDs with different `startedAt` (false), and a `null` boot ID with a different `startedAt` (true); `presentHostDashboard` gives `loading` with no view, `live` with a view and an item 1 s ago, `stale` with "Last updated 3 s ago" at 3 s, `disconnected` with the last view dimmed, `restarted` with "Server restarted at", `unsupported` with the exact R73 text, and `error` with the failure message; the R76 values give "23.5%", "12 cores", "11.2 GB of 32.0 GB, 35%", "625.0 GB free" and "(up 3h)" in `en-US`; no string contains an em dash.
3. [ ] Run both Done when commands. Expected: FAIL, the modules do not exist.
4. [ ] Implement them. Run both commands. Expected: PASS.
5. [ ] Prove a test can fail: make `isServerRestart` compare only `startedAt`, run the web command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 11.8: The Host dashboard sheet and its charts

- Satisfies: R76 (populated dashboard), R77 (one test per state), R78 (hidden document; unfocused but visible), R73 (older server: no request sent)
- Depends on: 11.7
- Files: create `apps/web/src/components/hostDashboard/HostDashboardSheet.tsx`, `apps/web/src/components/hostDashboard/HostDashboardSheet.test.tsx`, `apps/web/src/components/hostDashboard/HostMetricBars.tsx`; create `apps/web/src/state/hostDashboard.ts`; modify `apps/web/src/AppRoot.tsx`
- Interfaces: consumes `serverEnvironment.hostMetrics`, `shouldSubscribeToHostMetrics`, `isServerRestart`, `presentHostDashboard`, `useDocumentVisible`, `useEnvironment`, `useEnvironmentQuery` (its `refresh` for Retry) and `Sheet`, `SheetPopup`, `SheetHeader`, `SheetTitle`, `SheetPanel` from `components/ui/sheet.tsx`; produces `export const hostDashboardRequest: Atom.Writable<{ environmentId: EnvironmentId } | null>` (keep-alive, labelled `web-host-dashboard:request`), `export function useOpenHostDashboard(): (environmentId: EnvironmentId) => void`, `export function HostDashboardCoordinator(): JSX.Element | null` mounted once in `AppRoot.tsx` next to `RemoteUpdateConfirmationCoordinator`, the test ids `host-dashboard` (sheet), `host-dashboard-cpu` (the CPU figure, with `data-sampled-at` set to the reading's time), `host-dashboard-memory`, `host-dashboard-volume` (one per row) and `host-dashboard-since`, and `HostMetricBars({ bars, label }: { bars: ReadonlyArray<{ key: string; average: number; peak: number; tooltip: string }>; label: string })`, div bars with `Tooltip` like `ResourceHistoryChart`. Task 11.9 calls `useOpenHostDashboard`.
- Skills: vercel-react-best-practices (subscription gating, no effect for derived state, one 1 s interval only while open); better-accessibility (sheet focus and title, chart `aria-label`s, badges read as text)
- Read first: `apps/web/src/components/settings/UpdateServerDialog.tsx` (the request-atom coordinator pattern); `apps/web/src/components/settings/ResourceDiagnosticsSections.tsx` lines 436-500 (the bar chart look); `apps/web/src/components/RightPanelSheet.tsx` (a sheet in use); `UI.md`
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/hostDashboard` exits 0 with the new tests passing

Steps

1. [ ] Write `HostDashboardSheet.test.tsx` with a fake environment and a fake subscription atom: one test per R77 state with the spec's texts; the R76 populated values, volume badges (Removable, Read-only, Not responding) and the "Since" section with five figures for CPU and memory and an uptime chart; R73: an environment without `hostMetrics` shows the message and **Open Remote Servers** and the fake records no subscription; R78: setting `document.visibilityState` to `hidden` and firing `visibilitychange` ends the subscription and `visible` starts a new one, and a window `blur` does not; closing the sheet ends it.
2. [ ] Run the Done when command. Expected: FAIL, the component does not exist.
3. [ ] Implement the request atom, the coordinator, the sheet and `HostMetricBars`. Keep the last shown view in component state keyed by environment, so a disconnect keeps values and a reconnect can detect a restart. Run the command. Expected: PASS.
4. [ ] Prove a test can fail: subscribe regardless of visibility, run the command. Expected: FAIL in the hidden-document test. Restore and run again. Expected: PASS.
5. [ ] Review the new components against `vercel-react-best-practices` and `UI.md` (sizes from `text-xs` up, no em dash, an actionable error with Retry, disabled and unsupported states that explain themselves) and record the findings and fixes in the task's report.
6. [ ] Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 11.9: Host dashboard entry points

- Satisfies: R75 (three entry points; disconnected row)
- Depends on: 11.8
- Files: modify `apps/web/src/components/sidebar/EnvironmentContextCard.tsx` and `apps/web/src/components/sidebar/EnvironmentContextCard.test.tsx`; modify `apps/web/src/components/settings/remote-servers/ConnectTab.tsx` and `apps/web/src/components/settings/remote-servers/ConnectTab.test.tsx`; modify `apps/web/src/components/status-bar/ResourceUsageSegment.tsx` and `apps/web/src/components/status-bar/ResourceUsageSegment.test.tsx`
- Interfaces: consumes `useOpenHostDashboard`; produces a **Host dashboard** `MenuItem` in the Environment actions menu before Disconnect, a **Host dashboard** button in a connected `RemoteServerRow` next to Disconnect (absent when not connected), and a **Host dashboard** button in the Resource Manager popover for the selected environment
- Skills: vercel-react-best-practices (no new subscriptions in the sidebar card or the rows)
- Read first: `apps/web/src/components/sidebar/EnvironmentContextCard.tsx` lines 134-166; `apps/web/src/components/settings/remote-servers/ConnectTab.tsx` lines 171-200 and 420-490; `apps/web/src/components/status-bar/ResourceUsageSegment.tsx` lines 108-140
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/sidebar/EnvironmentContextCard.test.tsx src/components/settings/remote-servers/ConnectTab.test.tsx src/components/status-bar/ResourceUsageSegment.test.tsx` exits 0 with the new tests passing

Steps

1. [ ] Write one test per entry point: choosing Host dashboard sets `hostDashboardRequest` to that environment (`example-server` from the menu and the row, the local environment from the popover); a row in the `available` or `offline` state has no Host dashboard button.
2. [ ] Run the Done when command. Expected: FAIL, no Host dashboard control exists.
3. [ ] Add the three controls. Run the command. Expected: PASS.
4. [ ] Prove a test can fail: show the row button when disconnected, run the command. Expected: FAIL. Restore and run again. Expected: PASS.
5. [ ] Review the three changes against `UI.md` (one label everywhere, the row button looks like its neighbours). Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 11.10: Readings match the operating system's tools (P1.3, can be cut)

- Satisfies: R80 (macOS host and Linux container); reports what stays unproven
- Depends on: 11.3
- Files: modify `apps/server/src/diagnostics/host_metrics/probes.rs`; modify the design note (a "Checked against the OS tools" section)
- Interfaces: consumes `NativeHostMetricsSource`; produces `#[ignore]` test `os_tools_probe`, which over one 5 s window compares the native source with: on macOS `vm_stat` (used = (anonymous − purgeable + wired + compressor-occupied pages) × page size), `sysctl -n hw.memsize`, `df -k <mount>`, `diskutil info -plist <mount>` (container free space) and `top -l 2 -s 5 -n 0` (the second sample's idle); on Linux `/proc/meminfo` (`MemTotal` minus `MemAvailable`), `df -k -P <mount>` and two reads of `/proc/stat` 5 s apart; on Windows PowerShell `Get-CimInstance Win32_OperatingSystem`, `Get-Volume` and `Get-Counter '\Processor(_Total)\% Processor Time'`; it asserts the R80 tolerances and prints each pair compared, naming only `/` and drive letters
- Skills: none
- Read first: the design note section "Where the issue is wrong", items 1 and 5; `docs/testing/windows-desktop.md` lines 50-70 (the Parallels guest preflight)
- Tier: standard
- TDD: exempt (a comparison against external tools on a real host; the tolerances are its assertions)
- Done when: `cargo test -p bibcode-server --lib -j 2 host_metrics::probes::os_tools_probe -- --ignored --nocapture --test-threads=1` exits 0 on the macOS development host and in the Linux container, and the design note records the compared figures as percentages and the list of what is unproven

Steps

1. [ ] Write the probe. Run it on the macOS development host while it is otherwise idle. Expected: exit 0.
2. [ ] Run it in the Linux container. Expected: exit 0. A container reports the kernel's totals, not a cgroup limit; record that.
3. [ ] If the Windows lab of `docs/testing/windows-desktop.md` is reachable from the agent, run it there through the documented Parallels route. Expected: exit 0. If not, record "Windows: CI build and unit tests only".
4. [ ] Record what stays unproven: the graphical tools themselves, Linux on bare metal and on x64, Windows on x64, containers with cgroup limits, and Windows if step 3 did not run.
5. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-server --all-targets -- -D warnings`. Expected: no errors.

### Task 11.11: Hidden volumes disclosure (P1.2, can be cut)

- Satisfies: R81 (one network volume hidden)
- Depends on: 11.9
- Files: modify `Cargo.toml` (`sysinfo` features `linux-netdevs` and `linux-tmpfs`, so the Linux list includes network and tmpfs mounts for the collector to filter itself); modify `apps/server/src/diagnostics/host_metrics/native.rs`, `volumes.rs` and `wire.rs`; modify `packages/contracts/src/server.ts` and regenerate fixtures; modify `packages/client-runtime/src/state/hostMetrics.ts`; modify `apps/web/src/components/hostDashboard/HostDashboardSheet.tsx`, its test and `hostDashboard.logic.ts`; modify the design note
- Interfaces: consumes `HiddenVolume` and `HiddenReason`; produces `hiddenVolumes: Schema.Array(Schema.Struct({ mountPoint, fileSystem, reason: Schema.Literals(["network", "overlay", "fileMount", "empty", "sameStorage"]) }))` on the Snapshot and on a Sample that carries `uptime`, with `withDecodingDefault` to `[]`; a closed **Hidden volumes (N)** disclosure with the reasons "Network volume", "Container layer", "File mount", "Empty" and "Same storage as /". `tmpfs` is hidden as `empty` when its total is 0 and otherwise shown, as the issue's filter does not list it. On macOS `sysinfo` drops non-local volumes before the filter, so only the filter's own reasons appear there.
- Skills: better-accessibility (the disclosure is a button with `aria-expanded`)
- Read first: D29; `sysinfo` 0.39.6 `src/unix/linux/disk.rs` lines 401-428 (what the two features change)
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 host_metrics::`, `vp run check:contracts`, `vp run check:dependency-ledger` and, from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/hostDashboard` exit 0

Steps

1. [ ] Write `a_network_volume_is_hidden_with_its_reason_and_never_read` (Rust, fake source: `nfs4` at `/mnt/share` is in `hidden_volumes` with `Network` and received no space read) and the web test (the disclosure is closed, opening it shows `/mnt/share` and "Network volume" and no sizes). Run the Done when commands. Expected: FAIL.
2. [ ] Implement. With the Task 11.3 probe in the Linux container, confirm that a test NFS export mounted inside the container reaches the filter and is hidden without a space read. Run the Done when commands. Expected: PASS.
3. [ ] Prove a test can fail: read the space of hidden volumes, run the Rust command. Expected: FAIL. Restore and run again. Expected: PASS.
4. [ ] Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `vp check` and `vp run typecheck`. Expected: no errors.

### Task 11.12: MCP host snapshot tool (P2.1, can be cut)

- Satisfies: R82 (user name in a mount point)
- Depends on: 11.6
- Files: modify `apps/server/src/mcp/tools/diagnostics.rs` and its tests; modify `apps/server/src/rpc/methods.rs`, `apps/server/src/auth/scope.rs`, `apps/server/src/production/server_terminal.rs`; modify `packages/contracts/src/rpc.ts` and regenerate fixtures, with the count increments of one unary method and its typed failures; modify `docs/reference/mcp.md` and `docs/architecture/rpc-and-orchestration.md` (the tool table at line 4305); regenerate the MCP tool fixtures through `vp run check:contracts`
- Interfaces: consumes `HostMetricsCollector::snapshot`; produces unary `server.getHostMetrics` (scope `SCOPE_ORCHESTRATION_READ`, payload `{}`, success the Snapshot shape), and `ToolSpec::client("host_metrics", READ, &["server.getHostMetrics"]).reads().in_set(DIAGNOSTICS)` whose projection keeps host facts, current CPU and memory, statistics and per-volume sizes and state, sets `mountPoint` to the value only for `/` or a drive root (`[A-Z]:\`) and to `null` otherwise, and drops `name`. Not added to `is_long_running` or `is_background`: it answers from memory, so a slow answer is a real `rpc.slow` finding.
- Skills: bibcode-mcp (the tool set and its documentation conventions)
- Read first: `apps/server/src/mcp/tools/diagnostics.rs` lines 1-120, 224-268 (`process_diagnostics`) and 1076-1086 (`relative_or_file_name`, which this tool does not use)
- Tier: standard
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 host_metrics_tool` and `vp run check:contracts` exit 0

Steps

1. [ ] Write `host_metrics_tool_keeps_only_root_mount_points` with volumes `/`, `C:\` and `/media/test-user/usb`: `mountPoint` values `/`, `C:\` and `null`, and the serialized result contains neither `test-user` nor `usb`. Run `cargo test -p bibcode-server --lib -j 2 host_metrics_tool`. Expected: FAIL.
2. [ ] Implement the unary method and the tool. Run it. Expected: PASS.
3. [ ] Prove the test can fail: project mount points with `relative_or_file_name`, run it. Expected: FAIL. Restore and run again. Expected: PASS.
4. [ ] Document the tool in both reference documents. Run `vp run check:contracts`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `vp run check:markdown-links`. Expected: no errors.

### Task 11.13: Per-volume statistics (P2.2, can be cut)

- Satisfies: R83 (a volume that filled up)
- Depends on: 11.9
- Files: modify `apps/server/src/diagnostics/host_metrics/mod.rs`, `stats.rs` and `wire.rs`; modify `packages/contracts/src/server.ts` and regenerate fixtures; modify `packages/client-runtime/src/state/hostMetrics.ts`; modify `apps/web/src/components/hostDashboard/HostDashboardSheet.tsx`, its test and `hostDashboard.logic.ts`
- Interfaces: consumes `RunningStatistic`; produces `volumeStatistics: Schema.Array(Schema.Struct({ mountPoint, statistic: ServerHostMetricsStatistic }))` on Snapshot and Sample with `withDecodingDefault` to `[]`, one `RunningStatistic` per kept mount point (at most 64; a volume that disappears keeps its statistics until restart), shown as a row per volume in the "Since" section
- Skills: none
- Read first: R69 and R83
- Tier: cheap
- TDD: red-green
- Done when: `cargo test -p bibcode-server --lib -j 2 host_metrics::`, `vp run check:contracts` and, from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/hostDashboard` exit 0

Steps

1. [ ] Write `volume_statistics_follow_each_mount_point` (`/` at 40, 50 and 60 percent: current 60, minimum 40, maximum 60, average 50) and the web test for the rows. Run the Done when commands. Expected: FAIL.
2. [ ] Implement. Run the commands. Expected: PASS.
3. [ ] Prove the test can fail: record the CPU value into the volume statistic, run the Rust command. Expected: FAIL. Restore and run again. Expected: PASS.
4. [ ] Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `vp check` and `vp run typecheck`. Expected: no errors.

### Task 11.14: Packaged desktop end-to-end test of the local Host dashboard

- Satisfies: R75 (the local entry point, in the packaged app), R76 (populated dashboard, shapes only), R78 (the stream ends when the sheet closes)
- Depends on: 11.9, and 11.11 and 11.13 if they were not cut
- Files: create `apps/desktop/e2e/specs/host-dashboard.e2e.ts`; modify `apps/desktop/e2e/wdio.conf.ts` (shared with Phase 8: one line in `desktopUiSpecFiles`, before `closingSpec`); modify `docs/testing/cross-platform-validation.md`
- Interfaces: consumes the Resource Manager trigger, the Host dashboard button and the test ids of Tasks 11.8 and 11.9
- Skills: none
- Read first: `apps/desktop/e2e/specs/appearance-themes.e2e.ts` (a recent spec in the shared session); `docs/testing/cross-platform-validation.md` lines 637-700 (how specs are listed and isolated); `docs/testing/macos-desktop.md` (a locked console hides the webview, so run where the document is visible: the Linux lab under xvfb or CI)
- Tier: standard
- TDD: red-green (the spec fails before the build contains the feature)
- Done when: after `vp run test:ui:desktop:build`, `BIBCODE_E2E_SPEC=./specs/host-dashboard.e2e.ts vp run test:ui:desktop` exits 0

Steps

1. [ ] Write the spec: open the Resource Manager popover, choose Host dashboard, and assert the sheet title is the local environment's name, `host-dashboard-cpu` matches `/^\d+(\.\d)?%$/`, `host-dashboard-memory` matches `/ of .*, \d+%$/`, at least one `host-dashboard-volume`, and `host-dashboard-since` starts with "Since"; wait 3 s and assert `host-dashboard-cpu`'s `data-sampled-at` changed; close the sheet and assert `host-dashboard` is gone. No value of the test machine is asserted.
2. [ ] Build and run it alone. Expected: PASS. If the macOS console is locked, run it in the Linux lab under xvfb instead.
3. [ ] Add it to `desktopUiSpecFiles` and describe it in `docs/testing/cross-platform-validation.md` with its isolation command. Run `vp run check:markdown-links`. Expected: no errors.

### Task 11.15: Changelog, user guide, runbook review and final gates for this phase

- Satisfies: R73 to R78 (documentation of the behavior); support for Phase 8's final report
- Depends on: 11.14 and every task of this phase that was not cut
- Files: modify `CHANGELOG.md` (Unreleased, a `### Diagnostics` group); modify `docs/user/workspace-ui.md` (a "Host dashboard" section after the status bar paragraph at lines 7-15); review `docs/testing/**` and `docs/operations/ci.md`
- Interfaces: none
- Skills: none
- Read first: `AGENTS.md` (Testing Runbook Maintenance; Task Completion Requirements 7 and 9)
- Tier: cheap
- TDD: exempt (documentation and gates)
- Done when: `vp run check:markdown-links`, `vp check`, `vp run typecheck`, `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` exit 0, and `git diff` adds no real host, user name, volume name, non-system mount point of the development machine or local machine path

Steps

1. [ ] Add the changelog line: "Each environment has a Host dashboard (environment menu, Settings > Remote Servers, and the status bar's Resource Manager) with its host's CPU, memory and volumes, live and since the server started. (#292)" Describe only what shipped; a cut task gets no line.
2. [ ] Write the user guide section: where the three entry points are, what each section shows, what "Since" covers (this server process, reset on restart), that the dashboard stops while hidden, the states and what to do in each (update an older server, Retry), and that network volumes are not read.
3. [ ] Review `docs/testing/**` and `docs/operations/ci.md` for the CI steps of Task 11.6 and the spec of Task 11.14; update them, or state in the report that they were reviewed and remain accurate.
4. [ ] Write the phase's profiler coverage line for the final report: child processes none; RPC methods registered through the session wrappers, the stream timed to its first item and kept out of `is_long_running` and `is_background`, `server.getHostMetrics` likewise; the collector stopped in quiesce before the profiler's teardown; no event or finding added; no mount point in logs or records.
5. [ ] Run the Done when commands and `git status --short`. Expected: no errors, and only this phase's files changed.
