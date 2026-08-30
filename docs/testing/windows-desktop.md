# Windows Desktop Validation

Read [Cross-platform validation](./cross-platform-validation.md) first. This
page contains only native Windows additions.

## Supported native target

The supported Windows release target is Windows 10 or 11 on x64. Release and
native smoke workflows use the x64 MSVC toolchain and build an NSIS installer.
Windows ARM commands may exist for development experiments, but they are not a
supported release target while `scripts/run-msvc-x64.mjs` remains x64-specific.

Record the exact Windows edition, build, architecture, and whether the host is
physical or virtual. Do not silently substitute Wine, WSL, or a cross-compiled
binary for native Windows evidence.

## Host and toolchain inventory

Use PowerShell 7 when available:

```powershell
Get-ComputerInfo |
  Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
$PSVersionTable
$env:PROCESSOR_ARCHITECTURE
git --version
gh --version
rustc -Vv
cargo -V
rustup show
node --version
vp --version
Get-Command cl.exe -ErrorAction SilentlyContinue
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.name -match 'WebView2' } |
  Select-Object name, pv
wsl.exe --status
wsl.exe --list --verbose
```

Record missing MSVC, Windows SDK, WebView2, WSL, or distribution capabilities.
Do not install or enable system components without permission. Package scripts
already route Rust/Tauri commands through `scripts/run-msvc-x64.mjs`; use the
documented scripts rather than constructing an unverified Visual Studio
environment.

## Focused Windows contracts

Select focused tests from affected source and verify at least:

- case-only drive or path variants do not create duplicate worktree owners;
- slash/backslash spelling and directory junction aliases preserve one physical
  identity while persisted display spelling remains exact;
- replacement or reuse of a path/file identity is rejected before destructive
  worktree removal;
- Windows handles remain live across validation and deletion where required;
- late process admission during shutdown fails closed and the child is waited;
- Windows Job ownership reaps descendants before shutdown returns, and repeated
  status probes after termination cannot consume or lose the terminal Job
  state;
- independent runtimes cannot terminate each other's process roots;
- local Windows and WSL presentation follows current environment capability;
- saved remote environments appear in the environment rail without exposing
  privileged SSH, Tailscale, relay, or connection-lifecycle controls outside
  their owning settings and desktop-bridge boundaries; and
- update protection treats long-lived read subscriptions as reads, reports
  staged progress and active mutation counts while preparing, rejects a forged
  first-attempt bypass, and offers the acknowledged no-backup path only after a
  real protection failure; and
- Claude, Codex, Cursor, and OpenCode are visible while Grok is absent.

Run affected concurrency-sensitive owners at default, 8, and 12 harness
threads. Do not replace the default harness with a serial run.

## VCS idle and foreground measurement

Before measuring an idle window, verify the current event-driven observation
boundary on native Windows:

```powershell
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib git::broadcaster::tests::ref_poll_is_replaced_by_watcher_and_safety_status_reads -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib git::watcher -- --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --lib production::runtime::tests::structured_terminal_process_exit_immediately_invalidates_status_under_watcher_fallback -- --exact --nocapture
node scripts/run-msvc-x64.mjs cargo test -p bibcode-server --test production_git_vcs_rpc native_watcher_publishes_external_worktree_and_head_changes_to_status_subscribers -- --exact --nocapture
vp test run packages/client-runtime/src/state/vcs.test.ts apps/web/src/components/GitActionsControl.test.tsx
```

Record the idle 59/60-second boundary, native content/index/`HEAD`/refs events,
watcher fallback and lifecycle outcomes, terminal exit invalidation, reconnect,
and hidden/reveal/focus/menu catch-up separately. A native Windows pass does not
claim real WSL, SSH, Linux, or macOS execution. When WSL is usable, repeat the
disposable-project branch and terminal scenarios in the selected distribution;
otherwise record them as unavailable.

Run the maintained controller from the repository root. It builds both
Windows-only examples through the root Cargo workspace and lockfile, then runs
the complete Git and production-Atom measurements:

```powershell
node scripts/measure-vcs-runtime.ts
```

Use a short window only to validate the harness itself, never as default-change
evidence:

```powershell
node scripts/measure-vcs-runtime.ts --duration-ms 3000 --queue-warmups 2 --queue-samples 10
```

The controller pre-resolves the real Git executable, creates a unique
test-owned data root plus one disposable physical repository/worktree and bare
origin, and completes fixture Git work before adding the shim to the server's
PATH. It overrides inherited Cargo target configuration with an isolated target
inside that evidence root, consumes Cargo `compiler-artifact` JSON, and builds
and launches the exact resulting `measure_vcs_runtime_server` executable even
when Cargo uses a configured target-triple directory. The example constructs the production
`ServerRuntime`, RPC registry,
`StatusBroadcaster`, and `GitRepository`. The example opens the real WebSocket
RPC path, keeps exactly one `subscribeVcsStatus` stream alive, acknowledges
chunks, and makes no focus, menu, mutation, or external Git changes during the
idle window. Desktop UI automation is not required for this server-owned path.

Record the server PID, creation time, executable path, fixture common directory,
worktrees, subscribers, exact interval boundaries, and any other process that
could share attribution. Capture process-start events for direct `git.exe`
children of that exact server identity. The controller copies the tracked
`measure_vcs_git_shim` example to the test-owned PATH as `git.exe`. It appends
the timestamp, PID, process and parent creation identities, and argument vector
under one named mutex, delegates once to the pre-resolved real Git executable
with inherited standard handles/environment, and returns its exit status. Count
the shim launch only; do not also count its delegated Git child.

Before starting the ten-minute clock, run a short probe that proves all of the
following: the subscription received its snapshot, the physical-repository
owner attached, the recorder captured a direct Git child with its arguments,
and the recorded parent still has the same creation identity. Clear the probe
records. Then keep the verified scenario idle for at least 600 seconds and
summarize command arguments into discovery, status/diff, and fetch categories.
If the evidence exposes command lines but not Rust `ProcessRequest.operation`,
report that exact limitation instead of assigning internal operation names.

On completion or failure the controller uses one bounded cleanup routine. One
atomic Windows process snapshot binds PID, parent PID, decimal FILETIME, and
normalized executable before stop. While the root remains alive the controller
captures its exact child/grandchild closure. Graceful success also reaps and
verifies captured orphans; timeout revalidates the immutable identities,
terminates verified descendants leaf-first and the owned server handle last,
awaits the parent exit, and rejects any survivor. After a clean completion it
parses only the
half-open `[start, start + duration)` window, filters the exact direct-parent
identity, reports non-direct and wrong-identity records, calculates the
per-minute/per-physical-repository rate, and prints and writes every evidence
path. A parse, identity, snapshot, common-directory, quiescence, shutdown, or
queue-summary failure makes the command fail.

`scripts/measure-desktop-runtime.ts` remains the supported startup, memory, and
point-in-time process-tree sampler. Its Windows ownership monitor does not
retain process-start history, so it cannot by itself prove the VCS Git-launch
rate. Use it only as additional current-process identity/memory evidence.

The same controller runs the tracked Vite+ production-Atom benchmark with the
requested warm-up and sample counts. It uses the real `createVcsEnvironmentAtoms`
commands, keeps `refreshStatus` deferred while same-key `stageFiles` is
scheduled, and measures with `performance.now()` until the stage RPC effect
begins. Record its warm-up and measured sample counts, sorted nearest-rank p95,
maximum, and the 250 ms comparison.

## External worktree and junction fixture

Use a unique test-owned root, never a user project. One example shape is:

```powershell
$runId = [guid]::NewGuid().ToString('N')
$testRoot = Join-Path $env:TEMP "bibcode-win-validation-$runId"
$repository = Join-Path $testRoot 'Repository With Spaces'
$worktrees = Join-Path $testRoot 'External Worktrees'
$junction = Join-Path $testRoot 'Junction Alias'

New-Item -ItemType Directory -Path $testRoot | Out-Null
New-Item -ItemType Directory -Path $repository, $worktrees | Out-Null
git -C $repository init
git -C $repository config user.name 'BiBCode Test'
git -C $repository config user.email 'bibcode-test@example.invalid'
Set-Content -LiteralPath (Join-Path $repository 'README.md') -Value 'fixture'
git -C $repository add README.md
git -C $repository commit -m 'fixture baseline'
git -C $repository worktree add (Join-Path $worktrees 'Feature Alpha') -b feature-alpha
New-Item -ItemType Directory -Path (Join-Path $worktrees 'feature-long-path\nested') | Out-Null
git -C $repository worktree add (Join-Path $worktrees 'feature-long-path\nested\candidate') -b feature-long
$junctionTarget = Join-Path $worktrees 'Feature Alpha'
cmd.exe /d /c "mklink /J `"$junction`" `"$junctionTarget`""
git -C $repository worktree list --porcelain
Resolve-Path -LiteralPath (Join-Path $worktrees 'Feature Alpha')
Resolve-Path -LiteralPath $junction
```

Check that a drive-letter case variant, separator variant, and junction alias
cannot create another BiBCode owner for the same physical worktree. Confirm the
UI retains useful Git-reported display spelling and restart reconstructs the
same identity. **Keep hidden** and removal from BiBCode must not unexpectedly
delete the external Git worktree.

Use only fixture-owned paths for deletion/replacement identity tests. Record
the exact target before and after each destructive action.

## WSL matrix

Record:

```powershell
wsl.exe --status
wsl.exe --list --verbose
```

When WSL and a supported distribution are usable:

- Settings shows **Local environment** and WSL status/setup controls;
- Add Project targets the selected environment; Local offers **This device**
  plus only WSL locations with a matching usable bootstrap, while saved remote
  rail selections remain valid remote hosts;
- native and WSL paths do not collapse into one project identity;
- a disposable WSL project can launch its supported session and terminal;
- entering WSL-only first persists and verifies native local-only exposure and
  removes the managed firewall rule before switching topology; leaving WSL-only
  restarts the native backend explicitly local-only before share-state may
  request a later widen. Confirm both transitions serialize with concurrent
  exposure/settings mutations;
- restart retains the correct environment identity; and
- shutdown does not terminate unrelated WSL processes.

When WSL is unavailable:

- Local Environment still renders a meaningful unavailable state, not an empty
  section;
- refresh/retry remains accessible;
- Add Project does not present an unusable distribution; and
- local Windows projects remain usable.

Do not install a distribution or change system WSL configuration without
permission. Remote-server targets and exposure controls are validated in the
packaged UI scenarios independently of the WSL branch.

For update validation, use an isolated `BIBCODE_HOME` and disposable native
project; include a disposable WSL project when WSL is usable. Keep a read
subscription open while installing an available test update and confirm it
does not block protection. During a deliberately held mutation, confirm the
dialog promptly shows the waiting stage, elapsed time, and an active-operation
count. After the bounded failure, verify that normal retry is still the primary
action, the no-backup action requires acknowledgement, a forged first-attempt
bypass is rejected by the native host, and an installer failure restarts the
exact pre-update native and WSL backend set.

## Native tests and static gates

Follow the shared focused and broad gates. Root workspace scripts already use
the package-specific MSVC launcher. When a direct native Rust command needs the
same environment, use:

```powershell
node scripts/run-msvc-x64.mjs cargo test --workspace -j 2 -- --test-threads=2
node scripts/run-msvc-x64.mjs cargo clippy --workspace --all-targets -- -D warnings
```

Run the desktop E2E support contract natively on Windows:

```powershell
vp test run apps/desktop/e2e/support/test-project.test.ts
```

The `native_desktop` Windows CI row runs this exact command after the desktop
Rust host tests. A native pass includes real execution of the generated Cursor
`.cmd` shim through the Windows command processor and verification of its exact
action-log record. The same file's simulated macOS/Linux/Windows fixture and
filesystem assertions on a non-Windows host are compatibility evidence; the
guarded `.cmd` case is unavailable there and must not be reported as passed.

Keep `vp run test`, `vp check`, `vp run typecheck`, `cargo fmt --all --check`,
and `git diff --check` in the recorded gate set. Do not run separate broad
Cargo commands concurrently.

## NSIS package build and inspection

Build the supported artifact:

```powershell
vp run dist:desktop:win:x64
```

Discover the produced installer and executable from the command output and
`release/desktop`, then record absolute paths. Inspect PE version metadata and
architecture. Classify Authenticode without changing the package:

```powershell
Get-AuthenticodeSignature -FilePath $installer |
  Select-Object Status, StatusMessage, SignerCertificate
```

Current release documentation states that Windows artifacts are not
Authenticode-signed. An unsigned local artifact is expected evidence, not a
signed pass. Do not use production secrets.

Build and run packaged E2E with the supported platform value
`BIBCODE_E2E_PLATFORM=win`:

```powershell
$env:BIBCODE_E2E_PLATFORM = 'win'
vp run test:ui:desktop:build
$env:BIBCODE_E2E_APP_PATH = (Resolve-Path 'target/release/bibcode-desktop.exe').Path
vp run test:ui:desktop
```

Use a unique test profile supported by the E2E harness. Do not launch an
installed BiBCode executable or overwrite `%APPDATA%`/`%LOCALAPPDATA%` user
data. `BIBCODE_E2E_APP_PATH` deliberately selects the executable produced by
the E2E build in the current worktree, not an installed production copy.

## Packaged UI scenarios

Use Codex Computer Use to operate the packaged executable. Capture normal,
minimum-size, and relevant Windows DPI states. Verify:

- the environment rail groups **This device** and usable WSL locations under
  Local, shows saved remote servers separately, and Add Project targets the
  current rail selection;
- **Local environment** is visible at `/settings/local-environment` and never
  empty;
- Settings shows **Remote Servers** with **Connect to a host** and **Share this
  host** tabs; `/settings/connections` redirects there. SSH discovery and
  grant-driven sharing appears because the desktop bridge is present.
  remote targeting is driven by the environment rail rather than mixing saved
  servers into the Local WSL picker;
- Remote server updates: with a second BiBCode server saved (headless
  `bibcode serve` is sufficient), open Remote Servers settings, run **Check for
  Server Updates**, and confirm each saved server row shows an update badge
  (**Manual updates** for a headless server) and a manual-instructions block
  with a copy button. An offline server must show **Status unavailable** without
  blocking the rest of the batch; a blackholed check must settle after 30
  seconds across supervisor acquisition, readiness, and RPC execution, then
  release its batch worker;
- in **Settings → Remote Servers → Share this host**, generate an **Another
  device** offer. Confirm the local server restarts before the pairing offer is
  shown, and that the result contains the browser URL, `bibcode://` deep link,
  pairing code, and QR code. Then inspect the firewall rule:

  ```powershell
  netsh advfirewall firewall show rule name="BiBCode Remote Access"
  ```

  Confirm it is enabled, program-scoped to the exact packaged executable,
  TCP-only, and limited to Domain/Private profiles. Revoke the final
  native-managed **Another device** offer or paired client, verify exposure
  returns to loopback, and confirm the
  named rule is absent. Record an elevation or policy denial as failed native
  evidence; do not substitute a manually created rule. Run the host-independent
  deletion-spawn and policy-denial tests, then reproduce a deletion denial
  natively and confirm the app reports incomplete cleanup rather than claiming
  the rule was removed. A missing rule is benign only when the persistent
  firewall store can be queried and its absence verified. Capture the shared
  runbook's four explicit ceremony outcomes: confirmed local-only, another live
  access reason kept wide, cancellation unconfirmed and deliberately unchanged,
  and cleanup topology unverified. Also cover last-browser-session revocation
  with a local-only restart and removed rule, one compensating widen during a
  concurrent grant, bounded handling of a blackholed create response, and
  explicit legacy resume after a local-only restart. Confirm the caller returns
  a bounded failure after five seconds even when process spawn is delayed; the
  firewall worker must retain ownership, remove and verify absence of any rule
  enabled after that deadline, and complete that cleanup before a later enable.
  Burst multiple requests while one command is in flight and confirm the worker
  retains only the latest pending desired state, reports superseded callers
  explicitly, and applies that latest state after mandatory late cleanup.
  Separately confirm a hung `netsh` or PowerShell child is terminated and reaped
  by its 15-second process timeout and never retains the exposure coordinator
  indefinitely;

- with WSL-only primary mode active, generate an **Another device** offer from
  a usable WSL advertised endpoint. Confirm the native Windows backend process,
  native exposure state, and `BiBCode Remote Access` firewall rule do not change;
  the ceremony and reconciler must not call the native exposure bridge for this
  topology. In the Exposure section, confirm the available off-host WSL URL is
  shown, exposure is described as externally managed by WSL/Hyper-V policy, and
  the native-only **Limited to this machine** and **Managed automatically** copy
  is absent. Start one native reconciliation before the
  switch and let it resume after WSL-only becomes active; work that has not
  applied must produce no exposure side effects. Separately unmount after a
  local-only apply commits and prove its authoritative refetch and one required
  compensating widen still complete. A direct native exposure bridge invocation
  after the switch must be rejected by the host-side topology guard;

- the address picker lists only usable IPv4 candidates until a dual-stack
  listener exists, uses stable address/port IDs, safely preselects a private
  default, reports off-host interface observations unavailable before widening,
  and leaves generation disabled with externally managed listener/reverse-proxy
  guidance when native discovery has only a public or non-default private
  address. Public interface candidates remain non-actionable even after native
  exposure is wide. A custom off-host address mints without changing the native
  listener or firewall rule, and later auth revisions do not widen it. An
  externally managed public endpoint is never preselected and requires an
  explicit public-address/firewall warning. A packaged Tailscale CLI is
  discovered without shell `PATH` and unusable, public, or IPv6 candidates are
  suppressed;
- seed an incompatible newer connection IndexedDB version and confirm the
  boot-level recovery dialog lists the deleted data classes, keeps **Reload** as
  a non-destructive exit, requires a separately acknowledged confirmation that a
  double-click cannot trigger, and treats a blocked deletion as visibly queued
  until the original request succeeds or errors. It must not reload while
  blocked or after failure, and reloads automatically only after success;
- open a hosted `/pair` link whose host includes an IDN and explicit port and
  confirm the normalized punycode host shown is exactly the destination used.
  Reject a target containing username/password, and confirm legacy `code` query
  parameters are removed from both `/pair` and Remote Servers history after
  being retained for the current attempt;

- from the OS, opening a well-formed `bibcode://pair?code=...` link while the
  packaged app is running focuses that instance and lands on Add Server with
  the code prefilled;
- provider settings and action menus contain Claude, Codex, Cursor, and
  OpenCode without Early Access labels and omit Grok/Grok Terminal;
- external worktrees group by parent, expose full paths accessibly, adopt
  idempotently through junction/case aliases, and persist across restart;
- thread creation, switching, persistence, terminal I/O, and panel switching
  work;
- Activity subagents/background tasks align, show realistic elapsed time, and
  support keyboard focus/Shift+Tab; and
- narrow overlays and menus remain contained and reachable.

Record unavailable authenticated provider scenarios instead of substituting a
different executable or exposing credentials.

## Process and Job cleanup

Capture PID, parent PID, executable, creation time, and command line for scoped
desktop, server, provider, terminal, WSL, WebDriver, and fixture processes.
Use exact identity before terminating anything. Confirm Job-owned descendants
and canceled children are waited before ownership is released, independent app
instances remain alive, and the final snapshot contains no process launched by
the run.

Remove the junction before its target, then remove only the exact fixture and
profile roots created by this run. Never delete a pre-existing `%TEMP%`, build,
or user directory.

## Linux and macOS compatibility audit

Audit that Windows fixes do not introduce drive letters, backslashes,
case-folding, handles, Jobs, PowerShell, or WSL into unguarded shared Unix code.
Run host-independent Linux/macOS contracts and source-inclusion tests. Confirm
Unix physical identity, process groups, local-only presentation, package
contracts, and provider/Activity behavior remain unchanged. Report this as
compatibility evidence, not a native pass.

## Report and cleanup

Complete [the execution report template](./execution-report-template.md), then
perform the shared cleanup and final Git audit. Report whether WSL was usable,
which distributions were exercised, Authenticode status, any native command
that could not run, and whether anything was pushed.
