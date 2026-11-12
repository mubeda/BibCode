# Host metrics dashboard

Status: Approved 2026-11-11 by review (Codex, two rounds, and the advisor), on the user's instruction to add #292; decisions marked agent's call await the user's confirmation before the push.

Issue #292, amendment A10 of [the batch spec](./2026-11-09-issue-batch-340-345-290/spec.md):
requirements R66 to R83, decisions D22 to D30. Plan phase:
[Phase 11](./2026-11-09-issue-batch-340-345-290/phases/PHASE-11-host-dashboard.md). Verified
against commit `3cd0fbab8` and the `sysinfo` 0.39.6 crate source. Line references are to those
sources. Points marked "unverified" could not be run while planning (no cargo build); the task
named next to each one proves or refutes it before code depends on it.

## Problem

BiBCode measures only its own processes. Nothing reads the whole host: no call to
`global_cpu_usage`, `used_memory` or `Disks` exists in `apps/server/src` or
`apps/desktop/src-tauri/src` (`rg`, 2026-11-11). To see whether a remote server is short of CPU,
memory or disk, a person opens a terminal on it and runs `top` and `df`.

The issue asks for a **Host dashboard** per environment: total CPU, memory used of total, used
and free space per volume, updated live, plus statistics since the server process started
(current, minimum, average, p95, maximum) with small charts, on Linux, macOS and Windows hosts,
for remote servers and for the local environment.

## What the branch has today

- `sysinfo = "0.39.6"` in the workspace `Cargo.toml` (line 86) with default features, used by
  `apps/server` through `sysinfo.workspace = true` (`apps/server/Cargo.toml:65`). The default
  features are `component`, `disk`, `network`, `system` and `user`, so `Disks`, CPU and memory
  need no new feature for P0. Only the P1.2 task adds `linux-netdevs` and `linux-tmpfs`, which
  change nothing but which mounts the Linux disk list includes; `Cargo.lock` records no
  features, so it does not change, and that task runs `vp run check:dependency-ledger` anyway.
- `DiagnosticsMonitor` (`apps/server/src/diagnostics/monitor.rs`) samples BiBCode's own process
  tree every 2 s (`apps/server/src/production/runtime.rs:616-619`) and stops after three
  intervals without a reader (`monitor.rs:24-26`: "a server nobody reads samples nothing").
  Runtime quiesce stops it early, at the `process-monitor` step (`runtime.rs:1000-1002`), long
  before the profiler's teardown (`runtime.rs:1120`, `:1128`).
- Stream RPCs are registered with `RpcRegistry::register_stream` (`apps/server/src/rpc/session.rs:756`)
  and timed to their first item (`FIRST_ITEM`, `diagnostics/profiler/latency.rs:36`), which is
  log-only: no `rpc.slow` finding and no hang check (`latency.rs:470`).
  `send_discovered_local_servers` (`production/server_terminal.rs:587-616`) is the model loop: it
  stops on cancellation or `sender.closed()`.
- `ServerTerminalServices` (`production/server_terminal.rs:92`) has seven construction sites and
  takes optional parts through builders such as `with_profiler` (`:175`).
  `RpcRegistry::validate_complete` (`rpc/session.rs:931`) requires every active method to be
  registered, so the new method is registered unconditionally.
- Capability flags decode to `false` when missing (`packages/contracts/src/environment.ts`) and
  both descriptors set them: `connect_environment_descriptor` (`apps/server/src/lifecycle.rs:52`)
  and `environment_descriptor` (`apps/server/src/production/control.rs:2796`). An older server
  fails the whole connection on a method it does not know
  (`apps/web/src/diagnostics/diagnosticLogsSupport.ts:5-7`), so the client must check the flag.
- The client subscribes through `createEnvironmentRpcSubscriptionAtomFamily`
  (`packages/client-runtime/src/state/server.ts:209`), the stream tag joins
  `EnvironmentSubscriptionRpcTag` (`packages/client-runtime/src/rpc/client.ts:53`) and
  `PRE_VERIFICATION_SUBSCRIPTIONS` (`packages/client-runtime/src/rpc/session.ts:335`).
  `useDocumentVisible` (`apps/web/src/components/pullRequests/useDocumentVisible.ts`) already
  drops subscriptions while the document is hidden.

## Where the issue is wrong or stale on this branch

1. **Memory "used = total minus available" is wrong on macOS.** `sysinfo`'s Apple
   `available_memory` is active + inactive + free pages (`src/unix/apple/system.rs:195-199`).
   On the maintainer's host on 2026-11-11 that gave about 8 GB used of 96 GiB while `top`
   reported 65 GB used. `used_memory()` is wired + compressed + internal minus purgeable pages
   (`:200-204`), which is what Activity Monitor calls Memory Used. On Linux and Windows
   `used_memory()` is already total minus available (`src/unix/linux/system.rs:332-334`,
   `src/windows/system.rs:343-345`). The collector therefore reads `used_memory()` on every
   platform and reports available as total minus used (D24).
2. **Skipping `overlay` hides the only disk inside a container.** In a Docker container `/` is an
   overlay mount, and the Linux lab of P1.3 is a container. Overlay is skipped only when it is not
   mounted at `/` (D25).
3. **`squashfs` is already skipped by `sysinfo` on Linux** (`src/unix/linux/disk.rs:411`). So
   are network file systems (`:419-420`). FUSE network mounts are not, so the time limit still
   matters.
4. **macOS de-duplication is needed, as the issue guessed.** The crate itself says the writable
   Data volume counts as browsable (`src/unix/apple/disk.rs:310-313`), and `df -k` on the
   maintainer's host lists `/` and `/System/Volumes/Data` with the same total and available
   blocks. Task 11.3's `volume_probe` on the macOS development host (2026-11-11): `Disks` with
   `DiskRefreshKind::nothing()` returned two volumes, `/` and `/System/Volumes/Data`, both
   `apfs` with the same total and available capacity; the filter kept `/` and hid
   `/System/Volumes/Data` as same storage as `/`. Recovery, VM, Preboot, simulator runtime images
   and other system volumes did not appear (the crate drops non-browsable volumes), and no
   external disk was attached during the run. `/` reports read-only (the sealed system volume),
   so the merged entry carries the Read-only badge although the Data volume it stands for is
   writable; see "Open points from the build".
5. **macOS free space is not `df`'s.** `sysinfo` prefers "available capacity for important
   usage", which counts purgeable space such as the trash and system-managed caches
   (`src/unix/apple/disk.rs:380-391`). It can be larger than `df`'s Available and than
   `diskutil`'s container free space. P1.3 therefore compares it with the same property, read
   through the system's own JavaScript bridge (`osascript -l JavaScript`, `NSURL`
   `resourceValuesForKeys`), with the crate's fallback to plain available capacity, and checks
   only that it is at least `df`'s Available.
6. **Linux read-only volumes would read as writable.** `sysinfo` sets `is_read_only` only in a
   storage refresh on a disk's first listing (`src/unix/linux/disk.rs:141-148`, `first` is `true`
   only from `new_disk`, line 276-285); a later `Disk::refresh_specifics` passes `false`
   (line 110). Listing with `DiskRefreshKind::nothing()`, as planned, never sets it. The collector
   reads the flag from the mount options (`ro`) of `/proc/self/mounts` instead, on the disk
   worker while listing, which touches no file system (D33). macOS and Windows set the flag at
   listing from `getfsstat` flags and `FILE_READ_ONLY_VOLUME` (`src/unix/apple/disk.rs:512`,
   `src/windows/disk.rs:340`). As built, the parser decodes the kernel's `\ooo` escapes and lets
   the last line for a mount point win (a later mount covers an earlier one); it is compiled on
   Linux and in every test build, so its unit test runs on macOS and Windows too. The Linux lab
   run that proves it with a real read-only mount is pending (the lab was in use).
7. **Windows total and free do not match under a quota.** `get_drive_size` passes `None` for
   the caller-available value of `GetDiskFreeSpaceExW` and pairs `lpTotalNumberOfBytes`, which is
   relative to the calling user when quotas apply, with `lpTotalNumberOfFreeBytes`, which is
   volume-wide (`src/windows/disk.rs:279-295`). With a 100 GB quota on a volume with 800 GB free,
   free exceeds total and `used = total - free` goes negative. The collector does its own small
   Windows space read with the caller's pair (D31).
8. **A blocking-pool task that never returns blocks server exit.** `apps/server/src/main.rs:13-17`
   drops its Tokio runtime after `block_on`, and Tokio's runtime shutdown waits for every
   started blocking task. A hung `statvfs` on the blocking pool would therefore keep the server
   process alive. Disk reads run on dedicated threads that shutdown never joins (D32).
9. **The local environment has no Environment actions menu.** `buildEnvironmentContextCardView`
   returns `null` for the primary and desktop-local targets
   (`apps/web/src/components/sidebar/environmentContextCard.logic.ts:54-59`), so the card and its
   menu exist only for remote environments. The local entry point is the Resource Manager popover
   in the status bar (D27).
10. **The resource-history fixture is checked by a TypeScript test, not a Rust one.**
    `server__getProcessResourceHistory-success.json` is asserted in
    `packages/contracts/src/rpcRustParity.test.ts:212-250`. The Rust decode precedent is
    `updater__status-success.json` in `apps/server/tests/remote_update_rpc.rs:42-58`, which
    decodes into a Rust struct and re-encodes byte-identical. The new test follows that one.
11. **The MCP tool cannot drain a subscription.** `RpcRegistry::invoke_local` runs unary methods
    only (`rpc/session.rs:812`), and the stream drain waits for a terminal event a subscription
    never sends. P2.1 adds a unary `server.getHostMetrics` (Task 11.12).
12. **Line numbers moved:** the scope list is at `apps/server/src/auth/scope.rs:69-70` and its
    test at `:252`; the method list at `apps/server/src/rpc/methods.rs:172-173`; the diagnostics
    registrations at `production/server_terminal.rs:620-640`; the descriptor tests at
    `lifecycle.rs:1333` and `production/control.rs:7318`; the context card in `Sidebar.tsx` at
    `:378` and `:5593`.

## Approach

### Collector

`HostMetricsCollector` lives in `apps/server/src/diagnostics/host_metrics/`. It holds an
`Arc<dyn HostMetricsSource>`, not a generic parameter, so unit tests, the integration tests in
`apps/server/tests/` and production pass different sources to the same type. The trait is
synchronous, because every call is made on a thread that may block:

```rust
pub trait HostMetricsSource: std::fmt::Debug + Send + Sync + 'static {
    fn host_facts(&self) -> HostFacts;
    fn read_cpu_memory(&self) -> Result<CpuMemoryReading, SamplingError>;
    fn list_volumes(&self) -> Vec<VolumeDescriptor>;
    fn read_volume_space(&self, mount_point: &Path) -> Result<VolumeSpace, String>;
}
```

`NativeHostMetricsSource::new()` does no I/O: it creates one empty `System::new()` (never
`new_all()`) and an empty disk list. `read_cpu_memory` refreshes CPU usage and memory only,
never processes; it reads `/proc/stat` and `/proc/meminfo` or one Mach or Win32 call, and runs on
the Tokio blocking pool like other short reads. `list_volumes` refreshes the disk list with
`DiskRefreshKind::nothing()`, which calls no `statvfs` on Linux, on the first listing too
(`src/unix/linux/disk.rs:141-143`; `new_disk` passes the refresh kind through), adds the
`symlink_metadata` "is a file" check and, on Linux, the read-only flag from `/proc/self/mounts`.
On Windows `sysinfo` lists fixed and removable drives only (`src/windows/disk.rs:311-313`).
`read_volume_space` refreshes one disk with `Disk::refresh_specifics(DiskRefreshKind::nothing()
.with_storage())`; each disk is its own `Arc<Mutex<Disk>>` (`sysinfo` converts `Disks` into
`Vec<Disk>`, `src/common/disk.rs:211`).

**Disk work is separate from CPU and memory (D32).** Two loops run:

- The **sampling loop** reads CPU and memory and publishes a reading every tick. It never awaits a
  disk call. It copies the latest cached disk state into each reading.
- The **disk loop** sends `list_volumes` and `read_volume_space` jobs to a pool of 4 dedicated
  OS threads (`std::thread`, named `host-disk-<n>`), never the Tokio blocking pool. A job for a
  mount point (or the list) that already has a job queued or running is not admitted again, so
  the queue holds at most one job per mount point plus one list. Admission and results are
  keyed by the mount point plus a **generation**: the number of the listing that first showed
  that volume. A job running for more than 2 s marks its volume as not responding (or, for the
  list, keeps the last list and sets `volumeListingNotResponding` until the list answers, apart
  from `volumesPaused`, since a hung list does not stop size reads); its late result is applied when it arrives if its key is still
  listed, so the volume recovers. When a listing no longer shows a volume, its state and queued
  jobs are retired and a later result of that generation is discarded; a new volume at the same
  mount point gets a new generation, so a hung read of the old one never blocks or overwrites
  it. A disk call that panics fails only its own job: the thread catches the unwind, frees the
  key, reports a fixed failure text and keeps serving; a failed list keeps the last list.
  Retained state is therefore bounded by the latest listing plus the reads still held. A hung call costs one thread
  slot. When all 4 slots are hung, the disk loop stops admitting jobs and the reading says
  `volumesPaused: true` ("Disk readings paused: volumes are not responding"); CPU and memory
  keep publishing from the sampling loop. Shutdown sets a stop flag and never joins the
  threads, and they are not Tokio threads, so a hung disk call never delays the runtime's drop
  or the process's exit.

One sample holds `sampledAt`, `cpuPercent` (0 to 100, all logical cores), `memoryTotalBytes`,
`memoryUsedBytes`, `memoryAvailableBytes` and `volumes`. Each volume has `mountPoint`, `name`,
`fileSystem`, `totalBytes` and `freeBytes`, both relative to the user the server runs as
(Linux: `statvfs` total blocks and the blocks available to unprivileged users, the Available and
1024-blocks columns of `df`; macOS: total capacity and available capacity for important usage,
read only after a `statvfs` call has succeeded, since `sysinfo` 0.39.6 reports success even when
its own query fails;
Windows: the caller's total and the caller's free bytes from one `GetDiskFreeSpaceExW`, D31),
`usedBytes` (total minus free, with free clamped to total so it is never negative), `removable`, `readOnly` and `state` (`ok` or `notResponding`). A not-responding
volume keeps its last known bytes, or `null` before its first answer. Host facts are OS, arch,
logical CPU count and total memory.

### Volume filter (pure function, unit-tested)

1. Keep what `sysinfo` already lists: it skips pseudo, `squashfs` and network file systems on
   Linux and non-browsable or non-local volumes on macOS.
   Then add the network volumes it left out, to be hidden as network ones and never read: on
   macOS the network file systems of the kernel's mount table (`getfsstat` with `MNT_NOWAIT`,
   automount maps skipped), on Windows each drive letter of `GetLogicalDrives` that
   `GetDriveTypeW` calls `DRIVE_REMOTE` (file system `remote`; both answer from the drive table,
   so no share is reached).
2. Skip zero-size volumes.
3. Skip `overlay` unless it is mounted at `/`.
4. Skip a mount point that is a file, not a folder (Docker's `/etc/hosts`, `/etc/hostname` and
   `/etc/resolv.conf` bind mounts). The check is one `symlink_metadata` call per mount point, made
   only when the volume list is refreshed.
   Also skip, as a system mount, two kinds of volume the `linux-tmpfs` listing adds (#292,
   Linux lab): a memory-backed file system (`tmpfs`, `devtmpfs`, `ramfs`) mounted at or under
   `/dev`, `/run` or `/sys` (`/dev`, `/dev/shm`, `/run/user/<id>`), and a read-only FUSE mount
   that holds the running executable (the AppImage's own image, which reports 0 B free), never
   `/`, which holds every executable.
   `APPDIR` is not used: it can be inherited from another AppImage. Both are decided from the
   listing and the executable's path, without reading the volume. A `tmpfs` mounted elsewhere
   (`/tmp`, `/mnt/...`) stays shown.
5. Merge volumes that share storage: same file system type, same total and same free bytes. Keep
   the entry mounted at `/` if there is one, otherwise the shortest mount point. On macOS this
   folds an APFS container's volumes (`/` and `/System/Volumes/Data`) into one entry. Two separate
   disks with identical total and free bytes are the accepted false merge; Task 11.3's probe
   checks the real lists on macOS and in the Docker lab before this rule is relied on.
6. Show removable volumes, marked removable; show read-only volumes, marked read-only.

### Sampling rates

- **Background:** every 60 s from server start. CPU and memory every sample; volumes every fifth
  sample (every 5 minutes).
- **Live:** every 1 s while at least one stream is open; volumes every fifth sample (every 5 s).
  When the first stream opens, the collector refreshes CPU once and takes the first live sample
  1 s later, so the first live value covers 1 s, not the minute since the last background
  sample. When the last stream closes it drops back to 60 s at once.
- The sampling loop runs at the current rate; subscribers hold a counted guard. Live readers
  share one sample per tick through a `tokio::sync::watch` channel, so ten open dashboards cost
  one read per second. Volume reads follow the same "every fifth tick" cadence but are only
  requested from the disk loop; their results arrive when they arrive.

### Statistics and chart history

Kept in memory for the life of the server process (D23), reset on restart:

- For CPU percent and memory used percent: current, minimum, maximum, a time-weighted average and
  a p95 from a fixed 101-bin histogram (1 percentage point per bin). Each sample weighs the
  nominal interval of the rate that took it (1 s live, 60 s background), so an hour nobody watched
  counts as an hour, not as one sample (D28). p95 is reported as the whole percent of the bin (its lower edge)
  where 95 percent of the weight is reached. The size is fixed however long the server runs.
- Chart history in three tiers: the last 15 minutes of raw samples, 1-minute buckets for the last
  24 hours, and 15-minute buckets beyond that. Each bucket keeps average and peak for CPU and
  memory, as `ProcessResourceHistory` buckets do. The oldest tier holds at most 20,000 buckets;
  when it is full, adjacent pairs merge and the bucket width doubles. Closed buckets are stored
  compactly (start offset and width in seconds as `u32`, the observed weight and four averages
  and peaks as `f32`: 28 bytes), so 20,000
  of them stay under 1 MiB; a test asserts the size. Only the open bucket of each tier keeps sums;
  a closed bucket keeps its observed weight apart from its width, and merges average by that
  weight, so a bucket that spans a suspend does not count the gap. The wire type is separate.
- On the wire the uptime chart is at most 240 bars, aggregated from the tiers on the server, and
  the recent chart at most 900 points.

### Stream RPC

`server.subscribeHostMetrics`, a `read_stream` with scope `SCOPE_ORCHESTRATION_READ`, registered
with `register_stream` (mpsc), not `register_latest_stream`, so the first snapshot is never
replaced before it is sent. The payload is `{}`. Items form a tagged union:

- `Snapshot`: host facts, `bootId`, `startedAt`, `statisticsSince`, the current sample (or `null`
  before the first one; the first read waits at most 1 s for it, like the process monitor),
  statistics, the recent chart and the uptime chart.
- `Sample`: one live sample, the updated statistics, and the uptime chart (and, from P1.2, the
  hidden-volume list) when the subscriber has not yet received their latest revision, `null`
  otherwise.

The collector keeps the uptime chart and the hidden-volume list as one `ChartState` with a
revision number that rises each time either changes (about once a minute). Each subscriber loop
gets the `mpsc::Sender` itself from `spawn_stream`, a channel of 64
(`production/server_terminal.rs:1450-1458`), and remembers the chart revision it last sent. For
each item it first waits for a free slot with `sender.reserve().await`, only then reads the latest
watch value and chart revision, encodes the item (with the chart when its revision is newer than
the one it last sent) and sends it through the reserved permit. It never calls
`sender.send(item).await`, which would hold an item built before the wait. A slow client blocks
only its own loop. Items already queued when it stops reading are older than a chart that changes
meanwhile, so the guarantee is about what the client holds once those queued items have drained:
the first item built after it resumes carries the latest complete chart state, so a minute
boundary is never lost. Intermediate samples are skipped
and nothing queues without bound; statistics are cumulative, so a skipped sample loses one recent
point only. The client keeps recent points newer than 15 minutes before its newest sample and at
most 900, pruning by timestamp first. A test bounds the encoded snapshot at 128 KiB (900 points and 240 buckets); a
larger item is still delivered, split by the existing E2EE chunking (`rpc/session.rs:2013-2049`).

`bootId` comes from `ServerConfig::boot_id` and is `null` when the server has none, as in the
descriptor (`lifecycle.rs:62`). `startedAt` is the collector's creation time, which the
production runtime sets while it starts. The client treats a change of a non-null `bootId` as a
restart, and falls back to a change of `startedAt` when either `bootId` is `null`.

Capability flag `hostMetrics` in `ExecutionEnvironmentCapabilities`, set to `true` in both
descriptors in the same task that registers the method.

### Web

- A `hostDashboardRequest` atom (keep-alive, like `remoteUpdateConfirmationRequest` in
  `apps/web/src/state/remoteUpdates.ts:31`) holds the environment whose sheet is open. One
  `HostDashboardSheet` is mounted in `apps/web/src/AppRoot.tsx`.
- Entry points, all labelled **Host dashboard** (D27): the Environment actions menu of the
  remote context card; a button in each connected `RemoteServerRow`; a button in the status bar's
  Resource Manager popover, which reads the selected environment, local or remote.
- The sheet (`apps/web/src/components/ui/sheet.tsx`) is titled with the environment name. It
  subscribes only while it is open, the document is visible, the environment is connected and
  `capabilities.hostMetrics` is true; otherwise it passes `null` to `useEnvironmentQuery`, which
  with `idleTtlMs: 0` ends the subscription. It keeps the last view in component state, so a
  disconnect dims the values instead of blanking them.
- A pure reducer in `hostDashboard.logic.ts` turns stream items into the view: it appends samples
  to the recent chart, replaces the uptime chart when one arrives, and compares `bootId` with the
  previous snapshot to detect a restart.
- States: loading (skeletons), live, stale (no item for 3 s: values dim, "Last updated <n> s
  ago"), disconnected ("Disconnected", last values dimmed), restarted ("Server restarted at
  <time>", statistics reset), unsupported (no request sent; "This server's version doesn't report
  host metrics. Update it to see this dashboard." with **Open Remote Servers**, where the
  existing update controls are), error (the message and **Retry**).
- Charts are a small `HostMetricBars` component using the same div bars and `Tooltip` as
  `ResourceHistoryChart` (`apps/web/src/components/settings/ResourceDiagnosticsSections.tsx:440`),
  which is private and Settings-specific. Values use `formatMemoryBytes` and `formatCpuPercent`
  (`apps/web/src/components/status-bar/statusBarFormat.ts:72`, `:86`) and the uptime uses
  `formatElapsedDurationLabel` (`apps/web/src/timestampFormat.ts:112`).

## Alternatives and decisions

### D22. When the collector samples

The statistics need samples while nobody watches. That reverses the rule
`DiagnosticsMonitor` follows ("a server nobody reads samples nothing").

| Option                                    | Statistics mean                         | Idle cost                                              | Risk                                                 |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| (a) Sample only while a dashboard is open | "while watched", gaps everywhere else   | zero                                                   | p95 and max miss every unwatched spike; label is odd |
| (b) Start at the first open, keep at 60 s | "since <first open>", full after that   | zero until opened, then as (c)                         | first open of a run shows almost no history          |
| (c) Always on at 60 s from server start   | "since server start", as the issue asks | one CPU, memory read a minute, volumes every 5 minutes | reverses the rule; must be measured                  |

Recommendation (agent's call): (c). Task 11.4 first **measures** and then **applies the
policy**, as two separate steps. The measurement drives the real collector (both loops, the
statistics, chart production and the encoding of every item one subscriber receives) and
reports CPU time per background reading and per live reading on the macOS development host and
in the Linux lab. The policy then picks exactly one outcome:

| Outcome                               | Chosen when                                                              | Accepted when                                   | Requirements and tests that change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (c) always on, live 1 s               | background ≤ 0.1% of one core at 60 s and live ≤ 1% at 1 s on both hosts | as chosen                                       | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| (b) start at the first open, live 1 s | background > 0.1% and live ≤ 1%                                          | the user approves it before any web task starts | R69 and R76 ("since the first dashboard opened"), R70 (no reading before the first stream), R71 (the background limit applies only after the first open, which a person caused), D22; tests `background_reads_every_60_s_and_volumes_every_fifth_reading`, `the_first_subscriber_starts_an_idle_collector`, Task 11.6's runtime test, the "Since" texts of Tasks 11.7 and 11.8                                                                                                                                                                                                                                                                                                                          |
| (c) or (b) with live 2 s              | live > 1% at 1 s and ≤ 1% at 2 s                                         | the user approves it before any web task starts | R68 (its readings come 2 s apart), R70 and R72 (2 s live rate), R77 (stale after 5 s instead of 3 s), D22; Task 11.4 itself edits the already written tests `the_first_live_reading_covers_one_second`, `streams_switch_to_the_live_rate_and_share_one_read`, `cpu_and_memory_keep_their_pace_while_disks_hang`, `every_worker_held_pauses_disk_reads`, `mount_churn_keeps_state_bounded` (Task 11.2), `host_metrics_stream_sends_a_snapshot_then_samples` and `a_slow_subscriber_holds_the_latest_chart_after_the_queue_drains` (Task 11.5), then reruns the Done when commands of Tasks 11.2, 11.3 and 11.5; the stale tests of Tasks 11.7 and 11.8 and Task 11.14's wait are written at the new rate |

If live is over 1% even at 2 s, the task stops and reports to the user: no outcome is accepted.
(a) is not an outcome: it cannot answer "since server start" at all.

**Measured (Task 11.4, 2026-11-11).** Method: the ignored `cost_probe` in
`diagnostics/host_metrics/probes.rs`, run alone (`--test-threads=1 --exact`), drives the real
collector over `NativeHostMetricsSource` in a multi-thread runtime at a 250 ms test rate (so
every CPU refresh does its work): 300 background-shaped readings with no subscriber (volumes
every fifth), then 300 live-shaped readings with one subscriber served by the real stream loop,
every item encoded as on the wire, plus the uptime chart rebuilt and encoded every fifth reading
to over-count chart cost. It takes this process's CPU time (`getrusage(RUSAGE_SELF)`, user plus
system) over each run and subtracts an idle runtime of the same length.

macOS development host (Apple silicon, 12 logical CPUs, macOS 27), three runs:

| Run | Background ms per reading | % of one core at 60 s | Live ms per reading | % at 1 s | % at 2 s |
| --- | ------------------------- | --------------------- | ------------------- | -------- | -------- |
| 1   | 7.424                     | 0.0124                | 6.628               | 0.663    | 0.331    |
| 2   | 7.239                     | 0.0121                | 6.140               | 0.614    | 0.307    |
| 3   | 6.655                     | 0.0111                | 6.149               | 0.615    | 0.307    |

The runs agree within 12 percent. Background costs about a tenth of the 0.1% limit and live
about two thirds of the 1% limit, so the macOS figures select **(c) always on, live 1 s**, which
needs no approval.

Linux lab (Ubuntu 22.04 arm64 container, 12 CPUs visible, run under `taskset -c 0,1`,
2026-11-12), one run on the tree of commit 12edddac9 with the probe file of commit 436561914
copied in (the probe file's sha256 matched on the Mac and in the container; no other Rust
source differed from 12edddac9, only end-to-end test files):

| Run | Background ms per reading | % of one core at 60 s | Live ms per reading | % at 1 s | % at 2 s |
| --- | ------------------------- | --------------------- | ------------------- | -------- | -------- |
| 1   | 3.959                     | 0.0066                | 2.466               | 0.247    | 0.123    |

Linux is cheaper than macOS on both counts, so the higher figures are the macOS ones and the
outcome stays **(c) always on, live 1 s**, now on both hosts.

What makes (c) cheap: no process table walk (#24, #232), one `System` with CPU and memory
refreshes only, `/proc/stat` and `/proc/meminfo` on Linux, one host statistics call on macOS,
and one space read per volume every 5 minutes.

### D23. Statistics cover this server process only

The issue's open question 1, option (a): in memory, reset on restart or update, no schema change
and no migration. The sheet says "Since <time> (up <duration>)". Persisting tiers to SQLite is a
follow-up if wanted. Agent's call, taking the issue's recommendation.

### D24. Memory used is the OS's own "used"

`used_memory()` on every platform; available is total minus used. Alternative: total minus
`available_memory()` everywhere, which on macOS reports about an eighth of Activity Monitor's
figure. Agent's call, from the crate source and the host reading above.

### D25. Which volumes count

Local fixed and removable volumes. Network mounts stay skipped by default on every platform,
because a hung mount can block a read. Overlay is kept only at `/`; file mount points are
skipped; system mounts (memory-backed storage under `/dev`, `/run` or `/sys`, and the running
AppImage's own image) are skipped; shared storage is merged by file system, total and free bytes. Alternative: merge by
device name, which folds Docker's bind mounts but not APFS volumes (each has its own name).
Agent's call, the issue's recommendation plus the container finding; Task 11.3's probe confirms
the rule on macOS and in Docker.

### D26. Scope and privacy

`SCOPE_ORCHESTRATION_READ`, the same as `server.getProcessDiagnostics`, which already returns
process command lines. Mount points can contain user names (`/media/<user>/<label>`, a mount
inside a home folder), so:

- the RPC returns them to an authenticated client of that server only, over the same encrypted
  socket as every other RPC (`docs/architecture/remote.md`);
- no log line, profiler record or fingerprint names a mount point or volume name: a failed or
  slow volume is logged with its file system type and its position in the list;
- the MCP projection (P2.1) keeps a mount point only when it is a file system root (`/` or a
  drive root such as `C:\`) and otherwise reports `null`, and never reports `name`.
  `relative_or_file_name` (`apps/server/src/mcp/tools/diagnostics.rs:1080`) is not used: it
  turns `/` and `C:\` into an empty string and `/media/<user>` into the user name.

Each server reports the host it runs on: a remote server its own machine, an SSH-launched server
the SSH host, the WSL backend the WSL virtual machine, the desktop app the local computer.
Nothing is persisted or exported. Agent's call, the issue's recommendation.

### D27. Entry points and label

**Host dashboard** everywhere, because a bare "Dashboard" in a server row does not say what it
shows. A sheet, so the sidebar keeps its place (the issue's open question 5). The local
environment's entry is the Resource Manager popover, which already describes "the selected
host". Alternatives: a context menu on the rail's Local button (it is a radio, and with WSL it is
already a menu), a Settings page (loses the user's place). Agent's call.

### D28. Time-weighted statistics, bounded wire charts

Each sample weighs its nominal interval. Alternative: feed statistics only from the 60 s cadence,
which drops the spikes a person watched live. Alternative: equal weight per sample, which lets
one watched minute (60 samples) outweigh an unwatched hour (60 samples). The wire carries at most
900 recent points and 240 uptime bars. Agent's call.

### D29. Hidden volumes are a disclosure, not a setting (P1.2)

The issue's P1.2 asks for a setting to show filtered volumes and one to hide removable ones.
`UI.md` warns against preferences that stand in for a decision. Instead the sheet lists the
volumes the filter hid under a closed **Hidden volumes (N)** disclosure, each with its reason
("Network volume", "System mount", "Same storage as /", "Empty"). A volume rejected before
sampling (network, overlay not at `/`, file mount, system mount) is never read; an empty or shared one is read once, which is how
the filter knows. No option hides
removable volumes; they carry a badge. Agent's call, for the user to confirm.

### D30. The stream stops when the document is hidden, not when the window loses focus

A visible dashboard on a second display is a real use, and #168's cost came from a hidden window.
The status bar's polling stops on blur too; the dashboard does not. Agent's call.

### D31. Free and total are both relative to the server's user, on every system

Linux reports `statvfs` total blocks and available blocks, macOS total capacity and available
capacity for important usage, and Windows a small space read of the collector's own:
`GetDiskFreeSpaceExW` through the existing `windows-sys` dependency (its `Win32_Storage_FileSystem`
feature is already enabled in `apps/server/Cargo.toml`, and `persistence/compaction.rs:860-884`
already calls it), taking `lpFreeBytesAvailableToCaller` with `lpTotalNumberOfBytes`. It runs on
the disk workers like every other space read. So "free" and "used" mean the same thing on all
three: what the server's user can still write, and the rest of what it can see. A pure step clamps
free to total, so used is never negative whatever a source reports; a fixture with free above
total proves it on every system. Alternatives: the crate's Windows read (caller total with
volume-wide free, which breaks under a quota); the volume-wide pair (not what the server's user
can write). The Windows read is proven only by Windows CI or the Windows lab and stays unproven
until one of them runs. Decided by the coordinator after the second review.

### D32. Disk calls run on four dedicated threads that shutdown never joins

Alternatives: the Tokio blocking pool (a hung `statvfs` keeps the runtime's drop, and so the
server's exit, waiting forever, and it shares the pool with every other blocking call); one
thread per call (no bound under mount churn). Four threads bound the cost of hung mounts; a
fifth hung mount waits, and all four hung pauses disk reads with a visible notice while CPU and
memory continue. Agent's call, after review.

### D33. Linux read-only comes from the mount options

`/proc/self/mounts` already lists `ro` for a read-only mount, and reading it touches no file
system. Alternative: listing with `DiskRefreshKind::nothing().with_storage()`, the only way the
crate sets the flag (on a disk's first listing); that listing runs `statvfs` on every volume
each time, which can hang and repeats the space reads the disk loop already makes. Agent's call, after review; the Linux lab proves it with a real read-only mount.

## As built (Tasks 11.1 to 11.6)

- **Disk loop.** The disk loop is a Tokio task that never blocks: it admits jobs to the four
  `host-disk-<n>` threads and folds their results in. It wakes on the sampling loop's volume tick
  (every fifth reading), on a worker's result, and every 250 ms while a job is queued or running,
  to mark reads past the 2 s limit. The limit is timed on the real clock inside the workers. A
  new volume is read as soon as a listing shows it, not at the next volume tick, so a first
  snapshot has sizes soon after start. A volume that has not answered yet is not shown until it
  answers or passes the limit (then as not responding with no sizes).
- **Generation.** A volume's generation is the number of the listing that first showed it. A
  listing that no longer shows a volume retires its key: queued jobs are dropped and a running
  job's result is discarded by the worker, so a late result of a retired volume never reaches
  the collector.
- **First live reading.** When the first subscription opens, the sampling loop makes one
  priming CPU read and takes the first live reading one second later; the priming read is not
  recorded, so the first live value covers one second.
- **Timestamps.** `sampledAt` is the wall clock, a label only. Readings are ordered by
  `sequence`, which rises by one per reading in a server run, and placed in the chart by a chart
  clock that follows the wall clock forward (a suspend shows as a gap, which the monotonic clock
  would hide on macOS and Linux) but advances at least as fast as the monotonic clock, so a wall
  clock moved back neither freezes the chart nor folds new readings into an older bucket. After
  such a step, chart times stay ahead of the wall clock by the step. `ageMs` is the reading's age
  on the monotonic clock when the item is encoded, and every `Sample` also carries
  `statisticsSince`. Unit tests on a paused clock use the collector's start time plus the Tokio
  clock and a test offset, which the wall clock does not follow.
- **Test-only cadence.** Unit tests can tick the disk loop on its own short cadence
  (`with_volume_cadence`), so the churn and replacement scenarios run many listings in seconds.
- **Third log line.** A volume whose space read returns an error (rather than hanging) is
  logged at `debug` as `host volume read failed` with its file system only, and shows as not
  responding; the two `warn` lines are unchanged.
- **Wire.** `server.subscribeHostMetrics` adds no typed failure fixture (stream methods export
  none), so the fixture counts rose by one method, one stream method and two stream shapes.
  Numbers use `Schema.Finite`. The stream's subscriber loop lives in
  `diagnostics/host_metrics/wire.rs`; `production/server_terminal.rs` only registers it.
- **Runtime.** D22 selected option (c) on the macOS figures, so the production runtime creates
  the collector with the config's boot ID and its own start time, starts it in the background,
  passes it to the terminal services with `with_host_metrics`, and stops it in
  `quiesce_for_update` right after `process-monitor`, as the `host-metrics` step. Services built
  without the builder (tests, embedded hosts) keep an idle collector over the native source,
  which reads nothing until a stream opens.
- **CI.** The `native_desktop` job runs the collector's unit tests, the exit test and the runtime
  test on Windows and macOS; each command fails its step when its filter matches no test. Linux
  runs them in the `test` job with every other server test.

- **Hidden volumes (Task 11.11).** `hiddenVolumes` entries carry `mountPoint`, `fileSystem`,
  `reason` and, for `sameStorage`, `sameStorageAs` (the shown volume they share, which is not
  always `/`, so the sheet says "Same storage as <mount point>"). `reason` is an open string, not
  a literal union, so a reason a later server adds cannot fail an older client's snapshot; the
  sheet shows an unknown one as "Hidden by the volume filter". A Sample carries the list only
  with `uptime`; a Snapshot from an older server decodes with an empty list. The `sysinfo`
  features `linux-netdevs` and `linux-tmpfs` add network and tmpfs mounts to the Linux listing,
  which makes no `statvfs` call, so the filter sees and discloses them. Linux lab, 2026-11-12:
  with a loopback `fuse.sshfs` mount at `/mnt/share`, `volume_probe` listed it as hidden
  (network) with no sizes, next to `/etc/hosts`, `/etc/hostname` and `/etc/resolv.conf` hidden
  as file mounts and `/usr/sbin/docker-init` as a container layer. With the mount's SFTP server
  stopped (a `stat` of the mount then hangs), the packaged app still listed it under Hidden
  volumes as "Network volume", showed no volume as not responding and logged no
  `host volume did not answer` line, so it is never read.

- **MCP snapshot (Task 11.12).** `server.getHostMetrics` answers one Snapshot from memory and
  never switches the collector to the live rate. The `host_metrics` tool keeps a mount point only
  for `/` or a drive root, reports how many it withheld (`mountPointsWithheld`) and counts the
  hidden volumes without listing them.
- **Per-volume statistics (Task 11.13).** A volume's used percent is recorded when a space read
  of a volume still tracked answers and the volume is shown after the merge, weighted by the
  nominal time between volume reads at the rate of that tick (five background or five live
  readings), as D28 weighs CPU and memory. At most 64 mount points get statistics; one that
  disappears keeps its entry until restart. Every Snapshot and Sample carries `volumeStatistics`.

## Checked against the OS tools (Task 11.10)

The ignored `os_tools_probe` in `diagnostics/host_metrics/probes.rs` primes the native source,
reads the system's own tools over one 5 s window and reads the source again, then compares
(R80 tolerances: CPU within 10 points, memory used within 3 points, the total and free space of
`/` within 1 percent). It names only `/`.

| Measure                   | macOS development host (2026-11-12)                                                   | Linux lab container (2026-11-12)                      |
| ------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Tools                     | `top -l 2 -s 5`, `vm_stat` with `hw.memsize`, `df -k -P /`, NSURL capacity (JXA)      | two `/proc/stat` reads, `/proc/meminfo`, `df -k -P /` |
| CPU busy, source and tool | 56.9% and 55.5% (1.5 points apart)                                                    | 0.2% and 0.2% (0.0 points)                            |
| Memory used               | 65.7% and 65.7% (0.0 points)                                                          | 6.0% and 6.0% (0.0 points)                            |
| `/` total                 | 100.0% of `df`'s total                                                                | 100.0% of `df`'s total                                |
| `/` free                  | 26.7% of `df`'s total, equal to the important-usage capacity; `df` Available is 25.2% | 92.7% of `df`'s total, equal to `df` Available        |

Both runs printed `running 1 test` and `1 passed`. In the container the totals are the kernel's
(the container's `memory.max` is `max`, so it has no cgroup memory limit, and the probe does not
read one), as `free` reports
them there. The Linux run used the same tree identity as the cost run above. The macOS CPU
window was not idle (other lanes were building), which the 10 point tolerance absorbs; the
Linux one was.

Unproven: the graphical tools (Activity Monitor, Disk Utility, Task Manager), Linux on bare
metal and on x64, Windows on x64, containers with cgroup limits, and Windows altogether: the
probe has no Windows part (Windows: CI build and unit tests only).

## Open points from the build

- On macOS the entry kept for the APFS container is `/`, the sealed read-only system volume.
  Decided after review: a merged entry is read-only only when every merged member is, so the
  container shows writable like the Data volume it stands for.

## Lifecycle and failure behaviour

- **Server start:** the production runtime creates the collector and starts the background loop
  (option c). Tests that build `ServerTerminalServices` without the builder get an idle collector
  over the native source, which samples nothing until a stream opens.
- **First sample:** CPU needs two refreshes at least 200 ms apart (`MINIMUM_CPU_UPDATE_INTERVAL`,
  `src/unix/apple/system.rs:74`). The source's first CPU call sleeps 200 ms between its two refreshes; it
  runs on the blocking pool, never on a Tokio worker thread.
- **Read failure:** a failed CPU and memory read keeps the last good sample and logs one
  `tracing::warn!` per distinct error, as `DiagnosticsMonitor::publish` does (`monitor.rs:252-275`).
- **Hung volume:** shown as not responding after 2 s; it holds one of the 4 disk threads until
  it returns; other volumes, CPU and memory continue. With all 4 held, disk reads pause and say
  so; CPU and memory continue.
- **Client closes the sheet or hides the document:** the atom is released, the stream is
  cancelled, the subscriber guard drops, and the collector returns to 60 s when no guard is left.
- **Client disconnects without closing:** `sender.closed()` ends the subscriber loop, as in
  `send_discovered_local_servers`.
- **Reconnect:** the client subscribes again and gets a new snapshot. A different `bootId` means
  the server restarted: the sheet resets and says when.
- **Duplicate delivery and stale results:** every item carries `sequence` (and `sampledAt`); the
  reducer ignores a sample whose sequence is not above the last one it applied, and falls back to
  `sampledAt` with an older server.
- **Shutdown:** `HostMetricsCollector::shutdown` cancels both loops, sets the disk threads' stop
  flag and does not join them; subscriber loops end when the watch sender is dropped. A test runs
  a child process shaped like `main.rs` (a multi-thread runtime dropped after `block_on`) with a
  volume read held forever and asserts that it exits. It follows `run_isolated_case` in
  `apps/server/tests/provider_usage_domain.rs`, which has no platform gate, and uses nothing
  Unix-only, so the native Windows and macOS CI steps run it too, with the runtime
  start-and-quiesce test, and fail when their filters match no test (R79). It runs in
  `quiesce_for_update` right after the `process-monitor` step, marked `host-metrics`, before the
  profiler's teardown.

## Performance

- Background: one CPU and memory refresh a minute and one space read per volume every 5 minutes.
  No process table. Four idle disk threads, which cost no CPU while they wait.
- Live: one read a second shared by all subscribers, and one JSON item a second per subscriber.
  At about 1 KB per item that is about 3.6 MB an hour while a dashboard is open and visible, and
  nothing while it is closed or hidden.
- Memory: fixed-size statistics, at most 900 raw samples and 1,440 minute buckets, and the
  oldest tier under 1 MiB.
- Measured in Task 11.4 before any web work, through the real collector with test rates no
  faster than 250 ms, because `sysinfo` skips a CPU refresh closer than 200 ms to the last one
  (`src/unix/apple/cpu.rs:33-35`, `src/unix/linux/cpu.rs:48`), and with one subscriber whose
  items are encoded as on the wire. The figure is this process's CPU time during the run minus
  an idle runtime of the same length. The method and numbers go in the pull request. On the
  macOS development host a reading costs 6 to 7.5 ms of CPU (D22's table): 0.012% of one core
  in the background and 0.66% at the live rate, and a live item without a chart is under 1 KB.

## Profiler, crash and trace coverage

- **Child processes:** none. The four disk threads are threads of the server process, named
  `host-disk-<n>`, so the profiler's process sampler already counts their CPU. `sysinfo` reads `/proc`, Mach host statistics, `getfsstat` and
  Core Foundation, and Win32 calls in process; its only `Command::new` calls are in its own tests
  and in `Process::kill` on Windows (`src/unix/apple/cpu.rs:472`, `src/windows/process.rs:371`),
  neither of which the collector calls.
- **RPC methods:** `server.subscribeHostMetrics` is registered through `register_stream`, so the
  session times it to its first item and counts its outbound bytes by method
  (`rpc/session.rs:1962`). It stays out of `is_long_running`: streams are log-only already, and
  its first item comes from memory. It stays out of `is_background`: a person waits for it. P2.1's
  unary `server.getHostMetrics` answers from memory too, so it stays out of both lists and a slow
  answer is a real `rpc.slow` finding.
- **Worktree removal, binaries and re-exec modes:** not touched.
- **Shutdown:** the collector stops in the quiesce sequence before the profiler's teardown
  (above).
- **Events, findings and logs:** no new profiler event or finding. Four `tracing::warn!` lines,
  documented in `docs/operations/observability.md`: `host metrics sample failed` (with the error,
  once per distinct error), `host volume did not answer` (with `file_system` and `position`,
  never the mount point), `host volume listing did not answer` (no field; its recovery is an
  `info` line) and `host disk call panicked` (only `call`, never the panic payload, which the
  profiler's panic hook records as a `panic` event with its own redaction). No record carries a mount point or volume name, so nothing reaches a
  fingerprint.
- **Documentation:** the Diagnostics paragraph of `docs/architecture/overview.md` (line 3361)
  gains the host collector and its always-on exception to "samples nothing"; the profiler
  references need no change because no event or finding is added.

## Out of scope

Per-process lists, per-core charts, network, GPU, swap, temperatures, battery; alerts and
thresholds; history across restarts; exporting metrics; cgroup limits of a container (a server in
a container reports the kernel's totals, as `free` does there); changes to the process
diagnostics, the status bar's own figures or the profiler.
