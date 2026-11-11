# Host metrics dashboard

Status: Draft (counts as approved once Codex and the advisor have reviewed it and their findings
are resolved, as D3 of the batch spec allows)

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
   blocks. What `Disks` returns there is unverified until the probe in Task 11.3 runs.
5. **macOS free space is not `df`'s.** `sysinfo` prefers "available capacity for important
   usage", which counts purgeable space (`src/unix/apple/disk.rs:380-391`). It can be larger than
   `df`'s Available. P1.3 compares it with `diskutil info`'s container free space and requires
   it to be at least `df`'s value.
6. **The local environment has no Environment actions menu.** `buildEnvironmentContextCardView`
   returns `null` for the primary and desktop-local targets
   (`apps/web/src/components/sidebar/environmentContextCard.logic.ts:54-59`), so the card and its
   menu exist only for remote environments. The local entry point is the Resource Manager popover
   in the status bar (D27).
7. **The resource-history fixture is checked by a TypeScript test, not a Rust one.**
   `server__getProcessResourceHistory-success.json` is asserted in
   `packages/contracts/src/rpcRustParity.test.ts:212-250`. The Rust decode precedent is
   `updater__status-success.json` in `apps/server/tests/remote_update_rpc.rs:42-58`, which
   decodes into a Rust struct and re-encodes byte-identical. The new test follows that one.
8. **The MCP tool cannot drain a subscription.** `RpcRegistry::invoke_local` runs unary methods
   only (`rpc/session.rs:812`), and the stream drain waits for a terminal event a subscription
   never sends. P2.1 adds a unary `server.getHostMetrics` (Task 11.12).
9. **Line numbers moved:** the scope list is at `apps/server/src/auth/scope.rs:69-70` and its
   test at `:252`; the method list at `apps/server/src/rpc/methods.rs:172-173`; the diagnostics
   registrations at `production/server_terminal.rs:620-640`; the descriptor tests at
   `lifecycle.rs:1333` and `production/control.rs:7318`; the context card in `Sidebar.tsx` at
   `:378` and `:5593`.

## Approach

### Collector

`HostMetricsCollector` lives in `apps/server/src/diagnostics/host_metrics/`. It holds an
`Arc<dyn HostMetricsSource>`, not a generic parameter, so unit tests, the integration tests in
`apps/server/tests/` and production pass different sources to the same type. The trait's
methods return boxed futures, like `ProcessSampler`, so tests drive it with a fake and a paused
clock:

```rust
pub trait HostMetricsSource: std::fmt::Debug + Send + Sync + 'static {
    fn host_facts(&self) -> HostFacts;
    fn read_cpu_memory(&self) -> BoxFuture<'_, Result<CpuMemoryReading, SamplingError>>;
    fn list_volumes(&self) -> BoxFuture<'_, Vec<VolumeDescriptor>>;
    fn read_volume_space(&self, mount_point: &Path) -> BoxFuture<'_, Result<VolumeSpace, String>>;
}
```

The native source holds one `System::new()` (never `new_all()`) and the disk list. It refreshes
CPU usage and memory only, never processes, on the blocking pool. Each volume is its own
`Arc<Mutex<Disk>>` (`sysinfo` converts `Disks` into `Vec<Disk>`, `src/common/disk.rs:211`), and a
space read is `Disk::refresh_specifics(DiskRefreshKind::nothing().with_storage())` on the blocking
pool.

The collector, not the source, owns the time limit and the "one read at a time" rule, so the
fake can prove both. It runs each volume read as its own Tokio task and keeps the task's handle
per mount point. On a volume tick it waits up to 2 s for the new reads. A read still running
after that leaves its handle in place and the volume shows as not responding; on later ticks the
collector starts no new read for that mount point while its handle is unfinished, and takes the
result as soon as the handle finishes, so a volume that answers late recovers on the next volume
tick. Listing the volumes (`list_volumes`, which includes the `symlink_metadata` check and, on
macOS, Core Foundation property reads) runs under the same guard: if it does not finish in 2 s,
the reading reuses the last list. A hung mount therefore costs at most one stuck blocking thread
per mount point, and CPU and memory never wait on disks. On Linux, listing with
`DiskRefreshKind::nothing()` reads `/proc/mounts` and calls no `statvfs`, on the first listing
too (`src/unix/linux/disk.rs:141-143`, and `new_disk` passes the refresh kind through). On
Windows `sysinfo` lists fixed and removable drives only (`src/windows/disk.rs:311-313`).

One sample holds `sampledAt`, `cpuPercent` (0 to 100, all logical cores), `memoryTotalBytes`,
`memoryUsedBytes`, `memoryAvailableBytes` and `volumes`. Each volume has `mountPoint`, `name`,
`fileSystem`, `totalBytes`, `freeBytes` (available to the server's user), `usedBytes` (total
minus free), `removable`, `readOnly` and `state` (`ok` or `notResponding`). A not-responding
volume keeps its last known bytes, or `null` before its first answer. Host facts are OS, arch,
logical CPU count and total memory.

### Volume filter (pure function, unit-tested)

1. Keep what `sysinfo` already lists: it skips pseudo, `squashfs` and network file systems on
   Linux and non-browsable or non-local volumes on macOS.
2. Skip zero-size volumes.
3. Skip `overlay` unless it is mounted at `/`.
4. Skip a mount point that is a file, not a folder (Docker's `/etc/hosts`, `/etc/hostname` and
   `/etc/resolv.conf` bind mounts). The check is one `symlink_metadata` call per mount point, made
   only when the volume list is refreshed.
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
- One task runs the loop; subscribers hold a counted guard. Live readers share one sample per
  tick through a `tokio::sync::watch` channel, so ten open dashboards cost one read per second.

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
  compactly (start offset and width in seconds as `u32`, four `f32` values: 24 bytes), so 20,000
  of them stay under 1 MiB; a test asserts the size. Only the open bucket of each tier keeps sums
  and weights. The wire type is separate.
- On the wire the uptime chart is at most 240 bars, aggregated from the tiers on the server, and
  the recent chart at most 900 points.

### Stream RPC

`server.subscribeHostMetrics`, a `read_stream` with scope `SCOPE_ORCHESTRATION_READ`, registered
with `register_stream` (mpsc), not `register_latest_stream`, so the first snapshot is never
replaced before it is sent. The payload is `{}`. Items form a tagged union:

- `Snapshot`: host facts, `bootId`, `startedAt`, `statisticsSince`, the current sample (or `null`
  before the first one; the first read waits at most 1 s for it, like the process monitor),
  statistics, the recent chart and the uptime chart.
- `Sample`: one live sample, the updated statistics, and the uptime chart once a minute (`null`
  otherwise).

Each subscriber loop waits on the watch channel and sends with `sender.send().await` on the
64-item channel of `spawn_stream` (`production/server_terminal.rs:1450-1458`). A slow client
blocks only its own loop; when it catches up it reads the latest sample, so intermediate samples
are skipped and nothing queues without bound. Statistics are cumulative, so a skipped sample
loses one chart point only. A test bounds the encoded snapshot at 128 KiB (900 points and 240 buckets); a
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

Recommendation (agent's call): (c), decided by Task 11.4's measurement. The rule is written in
the spec (R71): background sampling must cost under 0.1 percent of one core and a live stream
under 1 percent, measured on the macOS development host and in the Linux lab. If background cost meets the
limit, (c) stands. If background misses it but live meets its limit, (b) replaces (c): the
collector starts at the first subscription, the snapshot's `statisticsSince` says when, and the
coordinator asks the user to approve the change to R70 before web work starts. If live misses
its limit, live sampling moves to 2 s and the measurement is repeated. (a) is not taken: it
cannot answer "since server start" at all.

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
skipped; shared storage is merged by file system, total and free bytes. Alternative: merge by
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
("Network volume", "Same storage as /", "Empty"), without reading their space. No option hides
removable volumes; they carry a badge. Agent's call, for the user to confirm.

### D30. The stream stops when the document is hidden, not when the window loses focus

A visible dashboard on a second display is a real use, and #168's cost came from a hidden window.
The status bar's polling stops on blur too; the dashboard does not. Agent's call.

## Lifecycle and failure behaviour

- **Server start:** the production runtime creates the collector and starts the background loop
  (option c). Tests that build `ServerTerminalServices` without the builder get an idle collector
  over the native source, which samples nothing until a stream opens.
- **First sample:** CPU needs two refreshes at least 200 ms apart (`MINIMUM_CPU_UPDATE_INTERVAL`,
  `src/unix/apple/system.rs:74`). The first sample waits 200 ms with a Tokio sleep, never a
  blocking sleep.
- **Read failure:** a failed CPU and memory read keeps the last good sample and logs one
  `tracing::warn!` per distinct error, as `DiagnosticsMonitor::publish` does (`monitor.rs:252-275`).
- **Hung volume:** shown as not responding after 2 s; at most one blocking thread per hung volume;
  other volumes, CPU and memory continue.
- **Client closes the sheet or hides the document:** the atom is released, the stream is
  cancelled, the subscriber guard drops, and the collector returns to 60 s when no guard is left.
- **Client disconnects without closing:** `sender.closed()` ends the subscriber loop, as in
  `send_discovered_local_servers`.
- **Reconnect:** the client subscribes again and gets a new snapshot. A different `bootId` means
  the server restarted: the sheet resets and says when.
- **Duplicate delivery and stale results:** every item carries `sampledAt`; the reducer ignores a
  sample older than the last one it applied.
- **Shutdown:** `HostMetricsCollector::shutdown` cancels the loop and does not await blocking
  volume reads; subscriber loops end when the watch sender is dropped. It runs in
  `quiesce_for_update` right after the `process-monitor` step, marked `host-metrics`, before the
  profiler's teardown.

## Performance

- Background: one CPU and memory refresh a minute and one space read per volume every 5 minutes.
  No process table, no new thread except the blocking-pool calls.
- Live: one read a second shared by all subscribers, and one JSON item a second per subscriber.
  At about 1 KB per item that is about 3.6 MB an hour while a dashboard is open and visible, and
  nothing while it is closed or hidden.
- Memory: fixed-size statistics, at most 900 raw samples and 1,440 minute buckets, and the
  oldest tier under 1 MiB.
- Measured in Task 11.4 before any web work, with readings 250 ms apart because `sysinfo` skips a
  CPU refresh closer than 200 ms to the last one (`src/unix/apple/cpu.rs:33-35`,
  `src/unix/linux/cpu.rs:48`); the method and numbers go in the pull request. JSON encoding of one
  live item (about 1 KB) is checked again by Task 11.5's size test.

## Profiler, crash and trace coverage

- **Child processes:** none. `sysinfo` reads `/proc`, Mach host statistics, `getfsstat` and
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
- **Events, findings and logs:** no new profiler event or finding. Two `tracing::warn!` lines,
  documented in `docs/operations/observability.md`: `host metrics sample failed` (with the error,
  once per distinct error) and `host volume did not answer` (with `file_system` and `position`,
  never the mount point). No record carries a mount point or volume name, so nothing reaches a
  fingerprint.
- **Documentation:** the Diagnostics paragraph of `docs/architecture/overview.md` (line 3361)
  gains the host collector and its always-on exception to "samples nothing"; the profiler
  references need no change because no event or finding is added.

## Out of scope

Per-process lists, per-core charts, network, GPU, swap, temperatures, battery; alerts and
thresholds; history across restarts; exporting metrics; cgroup limits of a container (a server in
a container reports the kernel's totals, as `free` does there); changes to the process
diagnostics, the status bar's own figures or the profiler.
