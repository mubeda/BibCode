# Amendment A10: host metrics dashboard (#292)

A10 (proposed 2026-11-11, awaiting the user's approval in chat). Issue #292 joins this pull
request: a **Host dashboard** for each environment that shows the CPU, memory and volume space of
the host its server runs on, live and since the server process started. Scope: all of the issue's
P0, its P1.1 charts inside P0, then P1.2, P1.3 and P1.4, and P2.1 and P2.2 as separate tasks
that can be cut. The issue was verified at an older commit; its corrections on this branch are in
[the design note](../../2026-11-11-host-metrics-dashboard-design.md#where-the-issue-is-wrong-or-stale-on-this-branch).
Requirements R66 to R85, decisions D22 to D33. Plan phase: Phase 11.

Names used in these requirements:

- **Host collector**: the server part that reads the host's CPU, memory and volumes.
- **Background rate**: one reading every 60 seconds. **Live rate**: one reading every second.
- **Host stream**: the subscription a client opens to receive host readings.
- **Host dashboard**: the sheet that shows one environment's host readings.

## Requirements

### R66. The host collector reads CPU, memory and volume space without a process scan [Must] (amendment A10)

The host collector SHALL report CPU use as a percentage of all logical cores between 0 and 100, memory total, used and available bytes where used is the operating system's own used figure and available is total minus used, and for each volume its mount point, name, file system, total, free (free space on the volume as the operating system reports it; per-user quotas are not applied) and used (total minus free) bytes, and whether it is removable or read-only (on Linux from the mount options), and it SHALL NOT enumerate processes to do so.

#### Scenario: memory figures

- GIVEN a source that reports 32,000,000,000 bytes total and 11,200,000,000 bytes used
- WHEN the collector takes a reading
- THEN the reading has `memoryTotalBytes` 32,000,000,000, `memoryUsedBytes` 11,200,000,000 and `memoryAvailableBytes` 20,800,000,000

#### Scenario: CPU outside its range

- GIVEN a source that reports CPU use of 104.5 and then of -0.2
- WHEN the collector takes two readings
- THEN their `cpuPercent` values are 100 and 0

#### Scenario: read-only mount on Linux

- GIVEN a Linux host with an ext4 image mounted read-only at `/mnt/ro-test`
- WHEN the native source lists and reads its volumes
- THEN `/mnt/ro-test` has `readOnly` true and `/` has `readOnly` false

#### Scenario: no process table

- GIVEN the native source
- WHEN it takes 10 readings
- THEN no process list was refreshed (the source exposes no process refresh and its process count stays 0)

### R67. The volume list shows each local volume once [Must] (amendment A10)

The host collector SHALL skip zero-size volumes, `overlay` volumes not mounted at `/`, mount points that are files, and network volumes, SHALL merge volumes that share storage (same file system, total and free bytes) into one entry mounted at `/` when there is one and otherwise at the shortest mount point, and SHALL keep removable and read-only volumes with their markers.

#### Scenario: container and APFS lists

- GIVEN a source listing `/` (overlay, 100 GB total, 40 GB free), `/etc/hosts` (a file, ext4, 100 GB, 40 GB), `/var/lib/docker/overlay2/x/merged` (overlay, 100 GB, 40 GB), `/System/Volumes/Data` and `/` (both apfs, 2,000 GB total, 600 GB free, on another host), `/snap/core/1` (squashfs, 0 bytes) and `/media/usb` (exfat, 64 GB, 10 GB, removable)
- WHEN the container list and the APFS list are filtered
- THEN the container list is `/` and `/media/usb` (removable), and the APFS list is `/` only

#### Scenario: two volumes that only look alike

- GIVEN `/` (ext4, 500 GB, 200 GB free) and `/data` (ext4, 500 GB, 199 GB free)
- WHEN the list is filtered
- THEN both are kept

#### Scenario: network volume

- GIVEN a volume of file system `nfs4` mounted at `/mnt/share`
- WHEN the list is filtered
- THEN it is not in the list and no space read was attempted for it

### R68. A volume that does not answer does not hold back the rest [Must] (amendment A10)

The host collector SHALL make every volume list and space read on a fixed pool of 4 disk worker threads and never in the CPU and memory sampling; WHILE a volume's read has run longer than 2 seconds, it SHALL report that volume as not responding with its last known sizes, or none before its first answer, SHALL NOT admit another read of that volume, and SHALL apply the late result when it arrives; IF the volume list takes longer than 2 seconds, THEN it SHALL keep the last list; and WHILE all 4 workers are held by calls that have not returned, it SHALL stop admitting disk reads, mark each reading with disk reads paused, and keep publishing CPU and memory at the current rate.

#### Scenario: CPU and memory keep their pace

- GIVEN a source whose volume list call and whose space read of `/mnt/slow` each block a real thread on a channel the test holds, at the live rate of 1 second
- WHEN 4 seconds pass
- THEN 4 readings arrive with `sampledAt` values 1 second apart (within 200 ms), each with CPU and memory, `/` from the last list as `ok` and `/mnt/slow` as `notResponding`, and the source received exactly one space read for `/mnt/slow`

#### Scenario: the volume answers late

- GIVEN the held read of `/mnt/slow` from the scenario above
- WHEN the test releases it with 100 GB total and 30 GB free after 12 seconds
- THEN the next reading shows `/mnt/slow` as `ok` with those sizes, and the next volume tick admits a new space read for `/mnt/slow`

#### Scenario: every worker is held

- GIVEN a source whose space reads of `/a`, `/b`, `/c` and `/d` all block
- WHEN 10 seconds pass at the live rate
- THEN every reading after the fourth call blocked has `volumesPaused` true, no fifth disk call was made, and the readings still arrive once a second

### R69. Statistics since server start keep a fixed size [Must] (amendment A10)

The host collector SHALL keep, for CPU percent and memory used percent since the server process started, the current value, the minimum, the maximum, an average weighted by each reading's interval and a p95 from 1-percentage-point bins (the whole percent at which 95 percent of the weight is reached), in a size that does not grow with uptime, and SHALL keep chart history of the last 15 minutes of readings, 1-minute buckets for the last 24 hours and 15-minute buckets beyond, each bucket with average and peak, with the oldest tier held under 1 MiB.

#### Scenario: known values

- GIVEN background readings of CPU 10, 20, 30, 40 and 90 percent
- WHEN the statistics are read
- THEN current is 90, minimum 10, maximum 90, average 38 and p95 is 90

#### Scenario: a watched minute does not outweigh an unwatched hour

- GIVEN 60 background readings of CPU 10 percent (one hour) and then 60 live readings of CPU 90 percent (one minute)
- WHEN the statistics are read
- THEN the average is between 11.3 and 11.4 and the p95 is 10

#### Scenario: a week of uptime

- GIVEN one week of simulated background readings on a paused clock
- WHEN the history is read
- THEN the raw tier holds at most 900 readings, the minute tier at most 1,440 buckets, and the statistics start at the first reading's time

#### Scenario: the oldest tier compacts

- GIVEN chart history whose oldest tier holds at most 8 buckets, fed 64 closed 15-minute buckets of CPU 10 percent, then 64 of CPU 30 percent of which one contains a reading of 95 percent
- WHEN the history is read after the compactions this forces
- THEN the oldest tier holds at most 8 buckets, its first bucket starts at the first reading, the weighted average across its buckets is within 0.1 of 20 percent, and the highest bucket peak is 95

### R70. The collector samples in the background and faster while watched [Must] (amendment A10)

WHILE no host stream is open, the host collector SHALL read CPU and memory at the background rate from server start and volumes every fifth reading; WHILE at least one host stream is open, it SHALL read at the live rate, with volumes every fifth reading; and WHEN the last host stream closes, it SHALL return to the background rate.

#### Scenario: reads per subscriber count

- GIVEN a collector with a fake source on a paused clock
- WHEN 120 seconds pass with no stream, then 10 seconds with one stream, then 10 seconds with two, then 120 seconds after both closed
- THEN the source received 2 or 3 CPU and memory reads in the first period, 9 to 11 in each live period (not 18 or more with two streams), and 2 or 3 in the last, and volume reads only on every fifth reading

### R71. The collector's cost is measured, and the sampling policy follows the measurement [Must] (amendment A10)

The host collector's CPU cost SHALL be measured through the real collector path (both loops, statistics, chart production and the encoding of every item one subscriber receives) as CPU time per background reading and per live reading on a macOS host and in a Linux container, and the sampling policy SHALL be the outcome of D22 that the measurement selects: always on with a 1-second live rate when background costs at most 0.1 percent of one core at 60 seconds and live at most 1 percent at 1 second; IF background costs more, THEN collection SHALL start at the first host stream; IF live costs more than 1 percent at 1 second, THEN the live rate SHALL be 2 seconds; and a fallback outcome SHALL take effect only after the user approves it.

#### Scenario: measured cost

- GIVEN the real collector with the native source on this repository's macOS development host and in the Linux lab container, at test rates no faster than 250 ms so that every CPU refresh does its work
- WHEN the cost probe runs 300 background-shaped and 300 live-shaped readings with one subscriber whose items are encoded
- THEN the probe reports CPU time per reading of each kind and the derived percent of one core at 60 s and at 1 s, and the design note records the figures, the method and the selected outcome

### R72. The host stream sends a snapshot first, then readings, to an authorized client only [Must] (amendment A10)

WHEN a client with the `orchestration:read` scope opens the host stream, the server SHALL send first a snapshot with the host's operating system, architecture, logical CPU count and total memory, the server's start time and boot ID, the current reading, the statistics and both charts, then one reading with the updated statistics each live tick, and SHALL end the stream when the client closes it or disconnects; IF the client lacks that scope, THEN the server SHALL refuse the stream with an authorization error and send no reading.

#### Scenario: snapshot then sample

- GIVEN a server whose collector has a fake source
- WHEN a client opens the host stream and waits 2 seconds
- THEN the first item is a `Snapshot` with `bootId`, `startedAt`, `host.cpuCount` and statistics, and the next items are `Sample` items one second apart

#### Scenario: under-scoped session

- GIVEN a session whose token has only the `orchestration:operate` scope
- WHEN it opens the host stream
- THEN it receives `EnvironmentAuthorizationError` with `requiredScope` `orchestration:read` and no chunk

#### Scenario: client leaves

- GIVEN an open host stream
- WHEN the client closes it
- THEN the stream's task ends and the collector is back at the background rate within one second

### R73. Servers advertise host metrics, and the client never asks one that does not [Must] (amendment A10)

The server SHALL advertise `hostMetrics: true` in both of its environment descriptors, a descriptor without the flag SHALL decode as `false`, and WHILE an environment's `hostMetrics` is false, the client SHALL NOT send the host stream request and the host dashboard SHALL say "This server's version doesn't report host metrics. Update it to see this dashboard." with an **Open Remote Servers** button.

#### Scenario: older server

- GIVEN a remote environment whose descriptor has no `hostMetrics` field
- WHEN its host dashboard is opened
- THEN the sheet shows the unsupported message and the button, and no `server.subscribeHostMetrics` request was sent

### R74. Mount points stay out of logs, profiler records and fingerprints [Must] (amendment A10)

The host collector SHALL name a volume in log lines only by its file system type and position in the list, and no profiler event, finding or fingerprint SHALL contain a mount point or volume name.

#### Scenario: hung volume log

- GIVEN a volume mounted at `/media/test-user/backup` that does not answer
- WHEN the collector logs it
- THEN the log line is `host volume did not answer` with `file_system` and `position` fields and contains neither `test-user` nor `backup`

### R75. Every environment has a Host dashboard entry [Must] (amendment A10)

The web client SHALL offer **Host dashboard** in a remote environment's Environment actions menu, in each connected saved server row in Settings, Remote Servers, and in the status bar's Resource Manager popover for the selected environment, local or remote, and each SHALL open the host dashboard of that environment.

#### Scenario: three entry points

- GIVEN a connected remote environment `example-server` and the local environment
- WHEN Host dashboard is chosen from the environment menu, from the `example-server` row, and from the Resource Manager popover with the local environment selected
- THEN the sheet opens titled `example-server`, `example-server` and the local environment's name

#### Scenario: disconnected row

- GIVEN a saved server that is not connected
- WHEN its row is shown
- THEN it has no Host dashboard button

### R76. The host dashboard shows CPU, memory, volumes and statistics since start [Must] (amendment A10)

The host dashboard SHALL show the CPU percentage with the logical core count and a chart of the last 15 minutes, memory as used of total with its percentage and a chart, one row per volume with a usage bar, used of total, free, and Removable, Read-only or Not responding badges, and a "Since <time> (up <duration>)" section with current, minimum, average, p95 and maximum for CPU and memory and a chart of the whole uptime with average and peak per bar, and its text SHALL contain no em dash.

#### Scenario: populated dashboard

- GIVEN a snapshot with CPU 23.5 percent on 12 cores, memory 12,025,908,428 of 34,359,738,368 bytes, volume `/` with 2,147,483,648,000 bytes total and 671,088,640,000 bytes free, and a start time 3 hours 5 minutes ago, in the `en-US` locale
- WHEN the dashboard renders
- THEN it shows "23.5%", "12 cores", "11.2 GB of 32.0 GB, 35%", a row for `/` with "625.0 GB free", and "Since" followed by the start time and "(up 3h)"

### R77. The host dashboard shows loading, live, stale, disconnected, restarted, unsupported and error states [Must] (amendment A10)

The host dashboard SHALL show skeletons until the first snapshot; WHEN no item has arrived for 3 seconds while subscribed, it SHALL dim the values and show "Last updated <n> s ago"; WHILE the environment is not connected, it SHALL keep the last values dimmed with "Disconnected" and SHALL subscribe again after reconnect; WHEN a snapshot after reconnect has a different boot ID, it SHALL reset the statistics and show "Server restarted at <time>"; and IF the stream fails, THEN it SHALL show the failure message and a **Retry** button that subscribes again.

#### Scenario: one test per state

- GIVEN a fake host stream
- WHEN it sends nothing; a snapshot; nothing for 3 seconds; a disconnect; a reconnect with a new boot ID; a failure; and Retry is pressed
- THEN the sheet shows skeletons; values; "Last updated 3 s ago"; "Disconnected" with the last values; "Server restarted at" and reset statistics; the failure message with Retry; and a new subscription

### R78. The host stream runs only while the dashboard can be seen [Must] (amendment A10)

WHEN the host dashboard closes or the document becomes hidden, the web client SHALL close the host stream, and WHEN the document becomes visible again with the dashboard open, it SHALL open the stream again.

#### Scenario: hidden document

- GIVEN an open host dashboard with an active stream
- WHEN the document's visibility becomes `hidden`, then `visible`
- THEN the subscription ends, and a new one starts with a new snapshot

#### Scenario: unfocused but visible

- GIVEN an open host dashboard
- WHEN the window loses focus but stays visible
- THEN the stream stays open

### R79. The collector builds and passes its tests on Linux, macOS and Windows [Must] (amendment A10)

The host collector and its tests SHALL compile and pass on the Linux, macOS and Windows CI runners.

#### Scenario: CI

- GIVEN the pull request's CI run
- WHEN the server test jobs finish on Linux, macOS and Windows
- THEN the host collector's tests pass on all three

### R80. The readings match the operating system's own tools [Should] (amendment A10)

The host collector's readings SHALL agree with the operating system's command-line tools: memory used within 3 percentage points, each volume's total within 1 percent, free space within 1 percent of the same figure as the operating system reports it (on macOS, the volume's available capacity for important usage, falling back to its available capacity as the collector does, read through the system's JavaScript bridge, and at least `df`'s Available), and CPU within 10 percentage points over the same 5-second window.

#### Scenario: macOS host and Linux container

- GIVEN this repository's macOS development host and the Linux lab container
- WHEN the comparison probe runs against `vm_stat`, `df -k`, `osascript -l JavaScript` (`NSURL` volume resource values) and `top` on macOS, and `/proc/meminfo` (`MemTotal` minus `MemAvailable`), `df -k -P` and `/proc/stat` on Linux
- THEN every comparison is inside its tolerance and the probe prints the figures it compared

### R81. Hidden volumes can be listed [Should] (amendment A10)

The host dashboard SHALL list the volumes the filter hid under a closed **Hidden volumes (N)** disclosure, each with its mount point and the reason it was hidden, and SHALL NOT read the space of a volume rejected before sampling (network, overlay not at `/`, file mount); volumes hidden as empty or as sharing storage are hidden after their space read.

#### Scenario: one network volume hidden

- GIVEN a host with `/` and an `nfs4` volume at `/mnt/share`
- WHEN the disclosure is opened
- THEN it shows `/mnt/share` with "Network volume" and no sizes, and the source received no space read for it

### R82. Agents can read a host snapshot without paths [Could] (amendment A10)

WHERE the MCP diagnostics tools are enabled, the server SHALL offer a read-only `host_metrics` tool that returns the host facts, current reading and statistics, with each mount point kept only when it is a file system root and reported as `null` otherwise, and without volume names.

#### Scenario: user name in a mount point

- GIVEN volumes `/`, `C:\` and `/media/test-user/usb`
- WHEN an agent calls `host_metrics`
- THEN the volumes' `mountPoint` values are `/`, `C:\` and `null`, and the result contains neither `test-user` nor `usb`

### R83. Each volume has statistics since start [Could] (amendment A10)

The host collector SHALL keep, for each volume's used percent, the same five statistics as R69, and the host dashboard SHALL show them in its "Since" section.

#### Scenario: a volume that filled up

- GIVEN volume `/` read at 40, 50 and 60 percent used over three background readings with volumes
- WHEN the statistics are read
- THEN `/` has current 60, minimum 40, maximum 60 and average 50

### R84. A hung volume never delays server exit [Must] (amendment A10)

WHEN the server shuts down while a disk call has not returned, the host collector SHALL stop without waiting for that call, and the server process SHALL exit.

#### Scenario: exit with a read held

- GIVEN a child process that runs the collector in a multi-thread Tokio runtime dropped after `block_on`, as the server's `main` does, with a space read blocked forever
- WHEN the child shuts the collector down and returns from `block_on`
- THEN the child exits with status 0 within 5 seconds

### R85. A slow client still receives the latest charts [Must] (amendment A10)

WHEN a subscriber falls behind while the uptime chart or the hidden-volume list changes, the server SHALL include the latest complete chart state in the next item it sends that subscriber, and the client SHALL keep only recent points less than 15 minutes older than its newest one, at most 900 of them.

#### Scenario: blocked across a minute boundary

- GIVEN a subscriber that does not read its stream from 50 seconds into a minute until 70 seconds, on a paused clock
- WHEN it reads again
- THEN the first item it receives carries the uptime chart that includes the bucket closed at 60 seconds

#### Scenario: skipped samples

- GIVEN a client view whose newest point is at 20:00:00 and which holds points back to 19:40:00
- WHEN a sample at 20:00:01 arrives
- THEN no point older than 19:45:01 remains

## Decisions

D22. The collector samples from server start at 60 seconds, faster while watched, subject to measured cost (R71). Task 11.4 measures first and then applies the policy. Outcomes: always on with live 1 s (background at most 0.1 percent of one core and live at most 1 percent); start at the first host stream (background over 0.1 percent; R69, R70, R71 and R76 then say "since the first dashboard opened"); live 2 seconds (live over 1 percent at 1 s and at most 1 percent at 2 s; R70, R72 and R77's stale threshold, 5 s instead of 3 s, change). A fallback takes effect only after the user approves it, before any web task; if live is over 1 percent even at 2 s, no outcome is accepted and the user decides. Alternatives considered: sampling only while a dashboard is open (cannot answer "since server start"); starting at the first open (the first look of each run has no history). This reverses the process monitor's rule that a server nobody reads samples nothing, for the host collector only. Decided by: agent's call. Source: #292 open question 2 and P1.4.

D23. Statistics cover the current server process only, in memory, reset on restart or update. Alternatives considered: persisting 15-minute buckets for 90 days (a schema change and a migration for a follow-up nobody has asked for yet). Decided by: agent's call, the issue's recommendation. Source: #292 open question 1.

D24. Memory used is the operating system's own used figure on every platform, and available is total minus used. Alternatives considered: total minus the crate's available figure everywhere, which on macOS counts active pages as available and reported about 8 GB used where `top` showed 65 GB on the development host. Decided by: agent's call. Source: `sysinfo` 0.39.6 source and a reading on 2026-11-11.

D25. The dashboard shows local fixed and removable volumes; network volumes stay hidden by default; `overlay` is kept only at `/`; mount points that are files are skipped; volumes with the same file system, total and free bytes are one entry. Alternatives considered: skipping `overlay` everywhere (hides the only disk in a container); merging by device name (does not fold APFS volumes). Decided by: agent's call, the issue's recommendation plus the container finding; confirmed by the probe of Task 11.3. Source: #292 open question 3.

D26. The host stream needs `orchestration:read`, the scope of the process diagnostics that already return command lines. Mount points go only to authorized clients of that server; logs and profiler records never name them; the MCP tool keeps only root mount points. Alternatives considered: a new scope (one more grant for the same trust level); reducing mount points to file names as the other diagnostics tools do (turns `/media/<user>` into the user name and `/` into an empty string). Decided by: agent's call, the issue's recommendation. Source: #292 open question 4.

D27. The dashboard is a sheet, labelled **Host dashboard** at every entry; the local environment's entry is the Resource Manager popover, because the environment context card and its menu exist only for remote environments. Alternatives considered: "Dashboard" alone (says nothing in a server row); a menu on the rail's Local button (a radio, and already a menu with WSL); a Settings page (loses the sidebar's place). Decided by: agent's call. Source: #292 open question 5 and the context card's code.

D28. Each reading counts for its own interval in the average and the p95, and the wire carries at most 900 recent points and 240 uptime bars. Alternatives considered: equal weight per reading (one watched minute outweighs an unwatched hour); statistics from the background rate only (drops the spikes a person watched). Decided by: agent's call. Source: #292 P0.2 and the rate design.

D29. Hidden volumes are a disclosure in the sheet, not a setting, and there is no option to hide removable volumes. Alternatives considered: the issue's two settings (`UI.md`: options should not stand in for a design decision). Decided by: agent's call, for the user to confirm. Source: #292 P1.2 and `UI.md`.

D30. The host stream closes when the document is hidden, not when the window loses focus. Alternatives considered: also closing on blur like the status bar (a dashboard on a second display would freeze). Decided by: agent's call. Source: #292 Web 3 and #168.

D31. Free space is the volume's free space as the operating system reports it, and per-user quotas are not applied; on Windows the crate reports total free bytes, not the caller-available figure. The UI says "free", never "available to you". Alternatives considered: a Windows adapter using the caller-available value (more platform code, and no quota lab to test it). Decided by: agent's call, after review. Source: `sysinfo` 0.39.6 `src/windows/disk.rs`.

D32. Disk calls run on a fixed pool of 4 dedicated OS threads that shutdown never joins, never on the Tokio blocking pool and never inside CPU and memory sampling; all 4 held pauses disk reads with a visible notice. Alternatives considered: the Tokio blocking pool (runtime shutdown waits for every started blocking task, so a hung `statvfs` would keep the server from exiting); a thread per call (no bound). Decided by: the coordinator, after review. Source: the server's `main` drops its runtime after `block_on`.

D33. On Linux the read-only flag comes from the mount options in `/proc/self/mounts`, read while listing on a disk worker. Alternatives considered: listing with a storage refresh, the only way the crate sets the flag (a `statvfs` of every volume on every listing, which can hang). Decided by: agent's call, after review. Source: `sysinfo` 0.39.6 `src/unix/linux/disk.rs`.

## Verification

- **R66 to R70, R74, R83, R85:** Rust unit tests of the host collector with a fake source and a paused clock; a log-capture test for R74.
- **R84:** a child-process test shaped like the server's `main`.
- **R71, R80:** ignored probe tests run on the macOS development host and in the Linux lab container, their output recorded in the pull request; Windows only through CI build and tests (R79) and, if reachable, the Windows lab of `docs/testing/windows-desktop.md`. Unproven by this plan: the graphical tools (Activity Monitor, Disk Utility, Task Manager), Linux on bare metal and on x64, Windows on x64, and containers with cgroup limits.
- **R72, R73:** server RPC tests over the real registrar, the scope test over a restricted socket, both descriptor tests, the contract fixture decoded and re-encoded by a Rust test, and the capability default test.
- **R75 to R78, R81:** web component and logic tests with a fake stream; one packaged desktop end-to-end test that opens the local host dashboard and sees CPU, memory and at least one volume.
- **R82:** an MCP tool test for the projection.
- **Every change:** `vp check`, `vp run typecheck`, `vp run check:contracts`, `cargo fmt --all --check`, Clippy with warnings denied, the affected tests, and the React best-practices and `UI.md` reviews for the new components.
