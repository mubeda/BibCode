# SSH remote watchdog and Windows output drain

Status: **Approved by the user on 2026-09-26** — all three parts, with the defaults (pairing watchdog escalates to KILL 2 s after TERM; the stop script does not force KILL).

**Input.** Two residuals accepted with `b4125232`, both listed under "Current limitations" in
`docs/architecture/remote.md`:
- "An SSH script deadline terminates only the local `ssh` child. There is no remote watchdog…"
- "On Windows, Tokio reads child pipes on its blocking thread pool, so a starved pool can still
  delay output past the 2 s idle window…"

The SSH design record `2026-09-24-ssh-environment-connect-design.md` stays as written.
Evidence comes from reading the code at `d87f854f` and the tokio 1.53.1 and Rust 1.98 std
sources. Nothing was measured on a real SSH host or on Windows.

## Problem and evidence

### 1. Remote work outlives the local deadline

Each remote script has a deadline: pairing 30 s, launch 60 s, stop 30 s (`apps/desktop/src-tauri/src/ssh.rs:53-55`).
On expiry, the desktop terminates and reaps only the local `ssh` (`ssh.rs:1562-1572`). The
remote command has no PTY, so nothing signals it when the client goes away. It runs until it
exits or writes to the closed channel.

**Pairing.** `REMOTE_PAIRING_SCRIPT` ends with `exec bibcode pairing issue` (`ssh.rs:66-72`).
- The CLI's own waits are bounded but longer than the deadline. It waits up to 30 s for the
  runtime lock (`apps/server/src/persistence/backup.rs:31`, `306-341`), then up to 5 s per
  SQLite statement (`persistence/database.rs:25`, `784`).
- That wait starts on the host, after connecting, so the local 30 s fires first. The user still
  sees the approved `[ssh_timeout:pairing]` copy.
- Nothing bounds a harder hang, such as a stalled filesystem, or defect B of the SSH record,
  where the pairing command started a server that never exited.
- Each automatic retry that still needs a credential starts another command. That is up to
  about 78 an hour, from the 30 s deadline plus the 16 s backoff cap
  (`packages/client-runtime/src/connection/supervisor.ts:33`).
- A command that finishes late leaves an unused administrative pairing link for 5 minutes
  (`apps/server/src/auth/service.rs:48`, `2693`).

**Launch.** A ready `serve` that outlives the session is intended, because the next launch
reuses it (`ssh.rs:160-163`). An unready or hung one should not survive, but three gaps let it:
1. `wait_ready` counts attempts, not time (`$2 / 100`, `ssh.rs:110-129`). Against a port that
   accepts connections but never answers, each curl probe takes 1 s. The 15 s wait then
   becomes about 165 s, and the 2 s reuse check about 22 s. GNU wget's manual says it retries
   a timed-out read up to 20 times by default (not verified on a host).
2. The not-ready branch writes to stderr before `kill` and `rm` (`ssh.rs:174-179`). If the
   channel has closed, that write kills the script (SIGPIPE, or a failed write under `set -eu`).
   The server keeps running and stays recorded as managed.
3. A recorded server that is alive but silent for 2 s gets a second `serve` started next to it,
   and the pid and port files are overwritten (`ssh.rs:157-173`). The first server runs on,
   untracked, on the same data root; both hold the runtime lock shared
   (`apps/server/src/lifecycle.rs:221`). The stop script sends TERM only and deletes the files
   regardless (`ssh.rs:184-197`).

**Why the tests miss it.** `fake_ssh.py:218` `exec`s into the remote shell, so killing the
"ssh" child also kills the remote work; real sshd does not. The pairing-timeout test
(`tests/ssh_environment.rs:561-596`) checks only the local reap, and the harness `Drop` kills
the stand-in (`ssh_environment.rs:299-313`).

### 2. The Windows drain waits on a shared pool

- **How reads work.** On Windows, tokio wraps each child pipe in `Blocking<ArcFile>`
  (`process/windows.rs:189-248`), so every read and write is a `spawn_blocking` task
  (`io/blocking.rs:57-140`). Rust std opens child pipes for asynchronous I/O
  (`library/std/src/sys/process/windows/child_pipe.rs`). tokio's read calls `NtReadFile`, then
  waits in `WaitForSingleObject` until bytes or end of file arrive (`sys/pal/windows/handle.rs`,
  `synchronous_read`). A pending read therefore holds a pool thread, and dropping the future
  does not free it.
- **How output gets lost.** `drain_until_idle` (`ssh.rs:1839-1857`) treats 2 s without a
  completed read as idle. A read queued behind a busy pool looks like silence, so output is cut
  off. Pairing then fails with "SSH pairing did not return a credential" (`ssh.rs:1589-1604`)
  even though the host minted one. A queued stdin write delays the whole script until its
  deadline.
- **Who shares the pool.** It is Tauri's default pool: `apps/desktop` never calls
  `tauri::async_runtime::set`, and tokio's default is 512 blocking threads
  (`runtime/builder.rs:306`). The in-process server starts on the same runtime (`backend.rs:1809-1822`).
  It brings about 78 `spawn_blocking` sites outside test files, plus every provider and git pipe.
- **Likelihood.** Starvation needs all 512 threads busy or a long scheduling stall. It has not
  been observed.
- **Coverage.** No Windows test reaches the post-exit drain. The script and drain tests are
  `#[cfg(unix)]` (`ssh.rs:3702-4538`). The two cross-platform child tests (`ssh.rs:2735`, `2816`)
  cover only cancellation and shutdown. The Windows `native_desktop` jobs do run
  `cargo test -p bibcode-desktop` (`.github/workflows/ci.yml:166-171`, `235`).

## Goals and non-goals

**Goals:**
- A remote pairing command ends within a fixed bound, even if sshd never notices the client left.
- A launch script ends within its own wall-clock limits.
- A launch script stops any server it gave up on, even after the channel closes.
- A launch never leaves two managed servers on one data root.
- On Windows, SSH child I/O never waits for other subsystems' blocking work.
- A reader still parked after the drain gives up is cancelled, not leaked.
- None of these change the remote CLI, the web classification (`apps/web/src/connection/platform.ts:192-241`),
  the bridge contract, or user-facing copy. Any remote `bibcode` that works today keeps working
  on Linux or macOS with POSIX `sh`.

**Non-goals:** health checks of a ready server; research item 5; sshd or other system
configuration; processes stuck in uninterruptible I/O; two desktops sharing one launch state key.

## Alternatives

| Remote bound | For | Against |
| --- | --- | --- |
| A1 `timeout(1)` wrapper | Tiny; escalates TERM, then KILL | Not on stock macOS, which is a supported remote (`docs/testing/ssh-environments.md:52`); BusyBox syntax differs; a fallback would be a hidden second path |
| **A2 POSIX poller in the script** | Every CLI version is covered, because the desktop sends the script; today's fixtures can test it | Needs a shell matrix for reaping and a 0.2 s pid-reuse window; cannot interrupt a builtin stuck in I/O |
| A3 CLI self-exit in `pairing issue` | Exact and unit-testable | Covers new CLIs only. An unknown flag breaks old CLIs, which exit 1 for usage errors just like for other failures (`apps/server/src/main.rs:6-24`). An env var is ambient configuration |
| A4 `ssh -tt`, so the remote gets SIGHUP | No script change | Only works when sshd notices; echoes the script, merges stderr into stdout, adds CRLF |
| A5 stdout heartbeat (EPIPE) | Notices a closed channel quickly | A dead link never fills the buffers, so A2 is still needed |

| Windows drain | For | Against |
| --- | --- | --- |
| **B1 Private SSH I/O runtime with a bounded pool, plus `CancelIoEx` on give-up** | Covers reads, stdin writes and waits through public tokio APIs. Needs one routing change on all platforms plus one Windows-only cancel call. The server already isolates work on dedicated runtimes (`apps/server/src/terminal/manager.rs:793-795`, `provider_terminal/model.rs:403-405`) | One more runtime to own and shut down |
| B2 Thread per pipe plus `CancelIoEx`, fed through `tokio::io::simplex` | No pool at all | Also needs a stdin writer thread; Windows-only plumbing that Linux tests never run |
| B3 End-of-result line from each script | Cross-platform; the idle rule can no longer cut off a result | Treats the symptom: a starved pool still ends in a timeout |
| B4 Overlapped named pipes on tokio's IOCP driver | No threads | Named-pipe security (default DACL); unsafe plumbing |
| B5 Idle rule aware of `PeekNamedPipe` | Small | Still depends on the pool; cannot see bytes a finished but undelivered read holds |

`CancelSynchronousIo` would not help B1 or B2: the parked thread waits on a handle object and
has no synchronous I/O in flight. `CancelIoEx` on the pipe handle completes the pending read
with `STATUS_CANCELLED`. tokio exposes that handle through `AsRawHandle`, even while a read is
in flight (`process/mod.rs:1677-1707`).

## Recommendation

There are three parts, and each can be approved on its own.

**Part 1: pairing watchdog (A2).**
- The desktop runs `sh -s -- <bound>`, with the bound set to the pairing deadline plus 5 s. It
  comes from `SshOperationDeadlines`, so shortened test deadlines carry through.
- The script starts `bibcode pairing issue` in the background instead of `exec`ing it, and polls
  it with `kill -0` every 0.2 s. At the bound it sends TERM, sends KILL 2 s later, and exits 124.
- **Design rule:** the bound only limits leaks, so it always sits above the local deadline. The
  desktop's `[ssh_timeout:pairing]` stays the only failure a user sees, so the classification
  and the copy do not change.
- **Guarantee:** a host-side pairing command ends within 35 + 2 = 37 s of starting (the bound,
  then the TERM-to-KILL grace), even with no client. Retries start at least 31 s apart: the 30 s
  deadline plus the minimum 1 s backoff (`supervisor.ts:33`). So at most one earlier command
  overlaps a new one. Tests set their tolerances from these numbers.

**Part 2: harden the launch script** (this is a script change, not a watchdog):
- Set `trap '' PIPE`. Stop the server before any report is written, and make every report
  non-fatal (`|| true`).
- Run `wait_ready` against a `date +%s` deadline, so a limit of N s means at least N and at most
  N + 1 s (whole-second resolution), plus the probe under way. Curl probes have a 1 s timeout;
  wget's own 1 s timeout runs under the Part 1 poller with a 2 s limit (TERM after 1–2 s,
  then KILL 2 s later), bounding a stuck wget to about 4 s.
- A server the script started and gave up on gets TERM, then KILL after 2 s.
- Remove the pid and port files only while they still name that pid.
- Before trusting a recorded pid, check its command line with the runbook's
  `ps -p <pid> -o command=` (Linux and macOS). BusyBox `ps` is unverified: check it on the
  fixture hosts and fall back to `/proc/<pid>/cmdline` if needed.
  - If it is not this state's `bibcode serve --port <port>`, drop the files without killing it.
  - If it is, give it 10 s rather than 2 s to answer, then stop it before starting a replacement.
    At 10 s the one-second resolution is noise; at 2 s the window could be anywhere from 2 to
    3 s.
- Result: the script is bounded by its own waits (about 10 s + 15 s + the port scan), well
  inside the 60 s deadline. The pid check also means a stale pid can never make it kill an
  unrelated process.

**Part 3: private SSH I/O runtime (B1).**
- On first SSH use, `SshEnvironmentManager` creates a multi-thread runtime with 1 worker and at
  most 128 blocking threads. That covers 3 pipes for each of the `SSH_CHILD_REAPER_CAPACITY`
  (32) children (`ssh.rs:49`).
- Spawns, stdin writes, pipe reads, waits, reaps and tunnel stderr all run there. Prompts and
  events stay on Tauri's runtime.
- When a drain gives up (idle, deadline or shutdown), Windows calls `CancelIoEx` on each pipe
  whose read has not returned. It keeps polling the drain future while it repeats the call, for
  up to 1 s, until the read returns. A single cancel is not enough: a read still queued for a
  pool slot has no pending I/O yet (`ERROR_NOT_FOUND`). Once it starts, it would issue a fresh
  read that blocks until end of file.
- `synchronous_read` sets the I/O status before its wait returns, so a cancelled read ends with
  `STATUS_CANCELLED`. That keeps std's guard against a still-pending status (rust-lang#81357)
  from firing.
- Linux and macOS pipes do not use the blocking pool, so on those platforms only the driver
  changes.
- Shutdown order: `SshEnvironmentManager::shutdown()`, then `shutdown_background()`. The runtime
  is never dropped from async code.
- Cost: one idle worker thread; idle blocking threads expire after tokio's 10 s keep-alive.
- Build change: add the `Win32_System_IO` feature to the desktop's `windows-sys`
  (`apps/desktop/src-tauri/Cargo.toml:51`). The server already enables it.

## Affected packages and files

- `apps/desktop/src-tauri/src/ssh.rs` (scripts, arguments, runtime, drain cancellation)
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/tests/ssh_environment.rs`, `tests/fixtures/ssh/fake_ssh.py` and
  `tests/fixtures/ssh/remote-bin/bibcode`

The approved SS15 follow-up changes `apps/server/src/{config,lifecycle}.rs`: the opt-in
`ServerConfig.listener_bind_retry` and `bind_listener` retry `AddrInUse` for 3 s with a
25→250 ms backoff, enabled only for desktop same-port restarts.
Nothing changes in `apps/web`, `packages/*`, the `DesktopBridge` contract or the
`[ssh_timeout:*]` prefix. The same desktop build sends and parses the scripts, so no version
skew is added with old servers or old desktops.

## Test and live-validation plan

Every test below must be seen failing before the change and passing after it.

**Unit (`ssh.rs`, Unix).** Run under dash (`/bin/sh` on CI), `bash --posix` and `busybox sh`
when present.
- Part 1: with a 1 s bound, the poller kills a stand-in that never exits, leaves no process
  behind, and passes through the CLI's exit status.
- Part 2:
  - readiness ends at its wall-clock limit when every probe hangs (a listener that accepts and
    never answers);
  - with stdout and stderr closed, the not-ready branch still stops its server and clears its
    files;
  - a live but silent recorded server is stopped before exactly one replacement starts;
  - a stale pid is not killed;
  - files that name another pid survive.

**Integration (`ssh_environment.rs`, `#[ignore]`, CI Test job).**
- `fake_ssh.py` gains an sshd-like mode: the remote runs in its own session and the fake only
  relays stdio, so killing the client leaves the remote alive, as OpenSSH does.
- With `hang-pairing`, the `sleep 600` stand-in must exit within the bound plus 3 s after the
  client dies. The test asserts this before `disconnect` and `Drop` run: it fails today and
  passes afterwards.
- Three timed-out retries leave no stand-in.
- Scripts are classified by a header line, and the state key moves to its new argument position.

**Windows (`native_desktop` jobs).** Add a `#[cfg(windows)]` test on the pattern of
`apps/server/src/persistence/store.rs:864-880`.
- Setup: a runtime with `max_blocking_threads(1)`, its only slot held for 5 s. A fake ssh (a
  `.cmd` shim to PowerShell, like the askpass launcher at `ssh.rs:81-89`) prints a pairing JSON
  line.
- Before Part 3 the output is cut off; with Part 3 it is parsed within 2 s.
- A second case keeps a descendant holding stdout and checks that no reader stays parked.
- This red→green evidence can only come from CI or a Windows machine.

**Live (`docs/testing/ssh-environments.md`).**
- An optional scenario on a host you control: a wrapper `bibcode` earlier on non-interactive
  `sh`'s `PATH` sleeps on `pairing issue`. Expect the pairing-timeout copy, no wrapper left about
  37 s after each attempt, and no build-up over three retries.
- On Windows, the runbook owner repeats scenarios 1–5 with `ssh.exe`.

**Gates:**
- `cargo fmt --all --check`
- `cargo clippy -p bibcode-desktop --all-targets -- -D warnings`
- `cargo test -p bibcode-desktop`
- `cargo build -p bibcode-server --bin bibcode`, then
  `cargo test -p bibcode-desktop --test ssh_environment -- --ignored`
- `vp check`
- `vp run typecheck`

## Docs and runbooks to update

- **`docs/architecture/remote.md`.**
  - "Desktop-managed SSH": the pairing bound, the wall-clock launch waits, and the private
    runtime (a runtime-topology change).
  - "Current limitations": replace the two quoted bullets with what remains, namely
    uninterruptible I/O and open question 2.
- **`docs/testing/ssh-environments.md`.** The sshd-like harness mode and the new scenario.
  Cleanup step 3 should also run `pgrep -fl "bibcode pairing"`.
- **`docs/testing/execution-report-template.md`.** Add a remote-bound row.
- **`docs/testing/windows-desktop.md`.** Add a PowerShell prerequisite, if the new test needs one.
- **Coordination.** `remote.md`, the template and `windows-desktop.md` are on the
  connection-liveness change list, so the implementer must coordinate with that change.
- **Reviewed, no change expected.** `docs/user/remote-access.md` and `docs/operations/ci.md`.

## Risks

- **Shell portability.** `kill -0` succeeds on an unreaped child, and fractional `sleep` is
  already assumed (`ssh.rs:126`). The shell matrix covers both.
- **Stopping a silent server** ends its in-flight work. The 10 s window makes that a hang rather
  than a hiccup, and today's outcome is worse: an orphan plus a second server.
- **Host clock steps** shift the `date +%s` limits. The local deadline still bounds the desktop.
- **The private runtime** adds shutdown ordering.
- **`CancelIoEx`** relies on std opening child pipes for asynchronous I/O. If std changes that,
  the Windows test fails and shows it.
- **A read still queued at give-up** cannot be cancelled until it starts. The private pool's
  spare capacity keeps that window short.
- **No real-host or Windows evidence yet.** OpenSSH's non-PTY behaviour comes from its manuals,
  and Windows `ssh.exe` has not been run live.

## Open questions for the user

1. Approve all three parts, or Part 1 first? Parts 2 and 3 do not depend on it.
2. Should stop escalate to KILL when the managed server ignores TERM for 10 s? Escalating risks
   orphaned provider children; not escalating keeps orphaned servers possible.
3. Add the CLI self-exit (A3) later as defense in depth, or not at all?

## Implementation notes (2026-09-26)

All three parts are implemented in `apps/desktop/src-tauri/src/ssh.rs`, with the approved defaults.
Where the code refines this design:

- **Watchdog.** The poller is a shell function, `run_bounded LIMIT CMD…`, shared by the pairing
  script and the launch script's `wget` probes (limit 2 s). It reads a whole-second clock, so TERM
  comes between LIMIT − 1 and LIMIT seconds after the command starts; KILL follows 2 s later if
  the command still runs. With the default bound of 35 s, a host-side pairing command ends within
  about 37 s. The command's stdin is `/dev/null`, so it cannot read the script that `sh -s` is
  still reading.
- **Script arguments.** Only the pairing script gains an argument (`sh -s -- <bound>`). The launch
  and stop scripts keep `sh -s -- <state key>`, so the fixture reads the state key from the same
  position as before. Every script starts with `# bibcode-ssh:<kind>`, and the stand-ins classify
  scripts by that line.
- **Launch.** The script fails before touching any state when neither `curl` nor `wget` exists.
  The pid check reads `/proc/<pid>/cmdline` where it exists (Linux, BusyBox included) and
  `ps -p <pid> -o command=` elsewhere (macOS), so BusyBox `ps` is never needed; it rejects an
  empty, zero, signed or otherwise non-numeric pid before any `kill`. A live, silent recorded
  server that survives KILL makes the launch fail rather than start a second server. The port
  scan still starts from the recorded port after stale state files are dropped. All waits use
  one helper, `wait_while SECONDS CMD…`.
- **State records.** The port is recorded before the server starts, and the server records its own
  pid (`sh -c` writes `$$`, then `exec`s into the runner) before it becomes `bibcode serve`. Every
  file is replaced through a temporary file and `mv`. A launch cut short therefore never leaves a
  running server unrecorded, or recorded with another port. The launch still writes the `managed`
  marker but no longer reads it; the stop script still honours an `external` marker, which no
  current script writes. Both remain for compatibility with older host state.
- **Stop.** The stop script sends TERM only to a pid that is still this state's server, then waits
  up to 10 s (`REMOTE_STOP_WAIT_SECS`) for it to exit, and clears the state files only once it
  has, and only while they name that pid. Without the wait, Disconnect then Connect could start a
  second server beside one still shutting down. A server that outlives the wait is left running,
  reported as `{"stopped":false}`, and keeps its record; the next launch stops it (TERM, then
  KILL) before it starts one replacement. The stop never force-KILLs, and a slow shutdown now
  makes Disconnect wait for it, up to the 10 s.
- **Private runtime.** The runtime and the routing apply on every platform, so the Linux and
  macOS tests exercise them; only the `CancelIoEx` call is `#[cfg(windows)]`. The cancel-and-poll
  loop runs whenever a drain stops short: after the idle window, at shutdown, at the deadline
  (which now ends the drain inside `wait_with_output` instead of dropping it), and when an exited
  tunnel's stderr stops being read. It never polls a read that has already returned, since that
  would start a new one. A stdin write is not cancelled: Tokio buffers it, and it ends when ssh
  exits. On Windows, cancelling can add up to 1 s past a named deadline before the SSH child is
  killed; that delay is accepted. A published tunnel's terminate-and-reap is awaited on the caller's
  runtime, because a child wait needs no blocking-pool thread there.
- **Early ssh exit.** When ssh exits before reading its script (it could not connect), writing
  the script fails with a broken pipe. The desktop now waits for ssh instead and reports ssh's own
  status and stderr. Before, that race replaced the real error with "Broken pipe", and made a
  unit test flaky under load.
- **Deadline errors.** Only the operation's own deadline produces `[ssh_timeout:…]`; it has a
  variant of its own (`WaitError::DeadlinePassed`). Any I/O error is reported as a failure,
  whatever its kind. This matters on Windows: the compiled std 1.97.1 decodes
  `ERROR_OPERATION_ABORTED` (a cancelled read) as `ErrorKind::TimedOut`. That was checked by
  disassembling std's `decode_error_kind` for `x86_64-pc-windows-msvc`, not from source.
- **Windows test thresholds.** The saturating test holds the caller's only blocking slot until the
  pairing finishes, for at most 30 s, rather than for 5 s. This makes a queued read fail
  deterministically instead of racing a timer. Each run must finish within 10 s rather than 2 s,
  to allow for a cold `cmd.exe` start on CI runners. The descendant case also checks that the
  drain really gave up (at least 2 s). The stand-in `.cmd` reads its stdin to end of file, as ssh
  does.
- **Bind retry (SS15).** The approved follow-up adds `ServerConfig.listener_bind_retry` in
  `apps/server/src/config.rs` and `bind_listener` in `apps/server/src/lifecycle.rs`, retrying
  `AddrInUse` for 3 s with a 25→250 ms backoff only on desktop same-port restarts. First starts,
  WSL backends, and other bind errors still fail immediately.
- **Evidence.** On Linux, the new script tests and the sshd-like integration scenarios failed
  against the old scripts and pass now. The two Windows tests have not run anywhere yet. The
  Windows-only items were type-checked from a verbatim extract, for `x86_64-` and
  `aarch64-pc-windows-msvc`, but the Windows tests themselves were not compiled. Their first
  evidence will come from the Windows `native_desktop` CI jobs.
- **Documentation.** `docs/architecture/remote.md`, `docs/testing/ssh-environments.md`,
  `docs/testing/execution-report-template.md` and `docs/testing/windows-desktop.md` were updated.
  `docs/user/remote-access.md` and `docs/operations/ci.md` were reviewed and remain accurate.
