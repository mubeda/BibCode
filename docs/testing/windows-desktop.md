# Windows Desktop Validation

Read [Cross-platform validation](./cross-platform-validation.md) first. This
page contains only native Windows additions.

## Supported native targets

The supported Windows release targets are Windows 10 or 11 on x64 and Windows 11 on
ARM64. Release and native smoke workflows use the matching MSVC toolchain and build an
NSIS installer. Native ARM64 evidence must come from `windows-11-vs2026-arm`; emulation
or an x64 application mislabeled as ARM64 does not count.

Standalone server releases provide native ARM64 and x64 `.zip` archives with the
matching web client.

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
already route Rust/Tauri commands through `scripts/run-msvc.mjs`; use the
documented scripts rather than constructing an unverified Visual Studio
environment.

## Parallels guest execution preflight

When the Windows host is a Parallels virtual machine driven from macOS, complete
this preflight before dependency installation, packaging, packaged E2E, or
Computer Use capture:

- The VM is running and not paused or suspended.
- Every guest command runs as the logged-in interactive Windows account:

  ```sh
  prlctl exec 'Windows 11' --current-user -- pwsh -NoProfile -Command '...'
  ```

  Without `--current-user`, `prlctl exec` runs as `NT AUTHORITY\SYSTEM`. Tauri
  then caches the NSIS toolset under
  `C:\Windows\System32\config\systemprofile\AppData\Local`, where x86
  filesystem redirection on ARM64 makes the x86 NSIS bootstrapper fail with
  `Unable to start child process, error 0x2` after the Rust release build has
  already completed. `scripts/run-msvc.mjs` refuses `tauri build` under the
  SYSTEM profile before compiling and names the offending environment
  variables; record that exit code 3 as a harness misconfiguration, switch to
  `--current-user`, and rerun. Confirm the account with `whoami` and
  `$env:LOCALAPPDATA` before the first expensive command.

- Install workspace dependencies with that same account, from the checkout
  root, so pnpm's hard-linked store stays readable to the account that runs the
  tests and builds.
- Invoke Vite+ through the checkout-local launcher instead of a global `vp`
  whenever the command is `vp test ...`; a global installation can load a second
  Vitest runtime and fail with `Vitest failed to find the runner`:

  ```powershell
  node scripts/run-local-vp.mjs test run packages/client-runtime/src/state/vcs.test.ts
  ```

  Package `test` scripts, `check:contracts`, and `test:coverage:ts` already
  route their Vitest invocations through this launcher, so `vp run test` and
  `vp run check:contracts` stay correct under a global `vp`; record which
  launcher each directly typed `vp test` command used.

- Use an isolated `BIBCODE_HOME` for every launch and keep the production
  installer output (`release/desktop`) and the E2E build
  (`target/<triple>/release/bibcode-desktop.exe` from `test:ui:desktop:build`)
  in distinct, recorded paths.
- Before Codex Computer Use captures the guest, return Parallels to **Windowed**
  (not Full Screen or Coherence) mode; ScreenCaptureKit cannot capture the
  full-screen Parallels surface. Switching back is a host-tool limitation, not
  an application defect, so record it without changing app code.
- Plan the exact process and firewall cleanup checks from
  [Process and Job cleanup](#process-and-job-cleanup) before launching anything.

## Focused Windows contracts

Verify the Git Manager trust command with native Windows PowerShell and Git:

```powershell
node scripts/run-local-vp.mjs test run apps/web/src/components/gitManager/gitManagerRepositoryAvailability.test.ts
```

The Windows-only round-trip case executes the application-generated commands
for drive and UNC paths containing spaces, dollar signs, backticks, and
typographic quotes, then checks the exact `safe.directory` values stored by
Git. It uses temporary global/system configuration and HOME, so it never adds
trust to the user's Git configuration. The UNC check covers command parsing
and registration, without contacting a network share. A real-share access or
packaged-terminal/clipboard check is separate evidence. A skipped case or a
PowerShell-on-Linux run is not a native Windows result. Both Windows CI rows
run this contract alongside the desktop shell fixture tests.

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
- desktop-managed SSH child I/O runs on the desktop's own SSH runtime: with the
  calling runtime's only blocking thread held, a stand-in ssh's pairing line is
  still parsed, and after a descendant holding its pipes makes the drain give
  up, no pipe read stays parked
  (`node scripts/run-msvc.mjs cargo test -p bibcode-desktop --lib ssh::tests::windows_drain`;
  the tests start `cmd.exe` and the built-in `powershell.exe`, and kill the
  descendant they record);
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
node scripts/run-msvc.mjs cargo test -p bibcode-server --lib git::broadcaster::tests::ref_poll_is_replaced_by_watcher_and_safety_status_reads -- --exact --nocapture
node scripts/run-msvc.mjs cargo test -p bibcode-server --lib git::watcher -- --nocapture
node scripts/run-msvc.mjs cargo test -p bibcode-server --lib production::runtime::tests::structured_terminal_process_exit_immediately_invalidates_status_under_watcher_fallback -- --exact --nocapture
node scripts/run-msvc.mjs cargo test -p bibcode-server --test production_git_vcs_rpc native_watcher_publishes_external_worktree_and_head_changes_to_status_subscribers -- --exact --nocapture
node scripts/run-local-vp.mjs test run packages/client-runtime/src/state/vcs.test.ts apps/web/src/components/GitActionsControl.test.tsx
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

With the same isolated test instance, arrange an installer failure and have a
test-owned listener acquire the native backend port after shutdown, keeping it
bound past the 3 s restart window. Confirm **Update not installed** names that
port as in use, offers **Restart server**, and disables **Retry installation**
with the visible restart explanation. Keep an unsent composer draft and verify
it survives the outage in the packaged WebView. Release only the test listener,
choose **Restart server**, and confirm the same backend port reconnects, the
draft remains, and **Retry installation** becomes available without reopening
the dialog. Record the listener/installer fixture and observed port in the
execution report; never use the user's running instance for this check.

## Native tests and static gates

Follow the shared focused and broad gates. Root workspace scripts already use
the package-specific MSVC launcher. When a direct native Rust command needs the
same environment, use:

```powershell
node scripts/run-msvc.mjs cargo check -p bibcode-server --all-targets
node scripts/run-msvc.mjs cargo test --workspace -j 2 -- --test-threads=2
node scripts/run-msvc.mjs cargo clean -p bibcode-server -p bibcode-desktop -p bibcode-updater-verifier
node scripts/run-msvc.mjs cargo clippy --workspace --all-targets -- -D warnings
```

Run the `--all-targets` check first. Unix-only test helpers and imports must sit
behind the same `cfg(unix)` as their consumers; an unused import in a Windows
test target fails the whole `bibcode-server` test build under `-D warnings` and
blocks every focused server test below. CI's Windows native rows run the same
command.

A test target that fails with `Failed to launch Windows Cargo target ... EACCES`
while the same binary runs from a neutral file name is UAC installer detection
(names containing `install`, `setup`, `update`, or `patch`). The shared runner's
sidecar manifest declares `asInvoker` and touches the binary to bypass the
manifest cache; report the launch error rather than elevating the shell or
renaming targets.

Check free space before the broad Rust gates: on ARM64 MSVC the `target\debug`
test binaries and their PDBs grow to tens of gigabytes across the server
integration targets, and a full disk surfaces as `LNK1104: cannot open file`
or `LNK1140: limit exceeded for program database` rather than a disk error.
Delete only the checkout's own `target\debug` to recover; never the retained
validation tree.

Git for Windows installs with `core.autocrlf=true` in the system and global
configuration. Test fixtures that assert on checked-out file bytes pin
`core.autocrlf=false` on the repository they create right after `git init`;
a `"base\r\n"` versus `"base\n"` assertion failure means a fixture is missing
that pin, not that the product rewrote line endings. Do not change the host
Git configuration to make a suite pass.

Run the desktop E2E support contract and the launcher contracts natively on
Windows:

```powershell
node scripts/run-local-vp.mjs test run apps/desktop/e2e/support/test-project.test.ts
node scripts/run-local-vp.mjs test run scripts/run-msvc.test.mjs scripts/run-local-vp.test.mjs scripts/remove-test-firewall-rules.test.ts scripts/tauri-hardening.test.ts
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

On Windows ARM64 the relay package cannot execute its Vitest suites: Cloudflare's
`workerd` ships no `win32 arm64` binary, so every relay test file fails at load
and `vp run` then cancels the still-running Rust suites. Run the broad gate
there with the same path filters the root `build` script uses, which selects
every workspace package except `infra/relay`:

```powershell
vp run --filter './apps/*' --filter './packages/*' --filter './oxlint-plugin-bibcode' --filter './scripts' test
```

Record the relay package as unavailable evidence and leave its coverage to the
Linux and macOS rows. Do not exclude any other package.

## NSIS package build and inspection

Build the supported artifact for the host architecture as the interactive
account (see the Parallels preflight above):

```powershell
vp run dist:desktop:win:x64     # x64 hosts
vp run dist:desktop:win:arm64   # Windows 11 ARM64 hosts
```

`tauri.windows.conf.json` sets `bundle.useLocalToolsDir`, so the NSIS toolset
is cached under the checkout's `target/.tauri` directory rather than
`%LOCALAPPDATA%`; retain it with the Cargo cache. If `run-msvc.mjs` exits with
code 3 before compiling, the account is wrong: do not copy tools into Windows
system directories, change ACLs, or modify the installed toolchain.

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

In the CI-only seeded upgrade lanes, the updater host exiting is not proof of
installation. Before cleanup and relaunch, the harness waits for the installed
executable's exact candidate `ProductVersion`, a readable SHA-256, and no
candidate-named updater installer. Its bounded `windows-install-handoff.log`
records path/version/hash and installer PID/path observations without command
lines or credentials. Inspect that artifact on timeout; the later public
runtime-version and retained-data checks remain required.
Each PowerShell observation keeps its ten-second command bound. A command
deadline becomes an unavailable sample only after the exact child emits
`close`; the next sample remains inside the original overall installation
deadline. Cleanup that cannot prove `close` within its existing five-second
budget fails the lane, including after forced termination. Spawn and other
cleanup errors remain fatal. An unavailable sample never satisfies the exact
version/hash/no-installer predicate.

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

The embedded test WebDriver server (`tauri-plugin-wdio-webdriver`) binds
`127.0.0.1` only and never opens UDP, so it does not by itself raise a Windows
Defender Firewall prompt. Desktop port selection used to listen briefly on
`0.0.0.0` and `[::]`, which made Windows treat any freshly built executable as
a network server and, when the prompt was cancelled, create program-scoped
Public inbound Block rules (one TCP, one UDP). The probe now binds without
listening. If a prompt still appears for a test executable, do not approve it;
cancel it, finish the run, and remove the generated rules with the helper in
[Process and Job cleanup](#process-and-job-cleanup). Changing firewall exposure,
approving a prompt, or generating an **Another device** pairing offer requires
explicit operator approval recorded in the report.

## Packaged UI scenarios

Include the shared [Pull Requests smoke](./cross-platform-validation.md#pull-requests-web-shell-validation):
open the project-header sidebar button, inspect the repository list, open a
request, and render a real text patch on Files changed/Changes with `tab=files`
retained after reload. Record unavailable fixture/host states separately from
that pass. The packaged Pierre spec's sibling checks route entry only; the
shared procedure owns authenticated list/detail/files evidence.

Include the shared [slow-link liveness scenario](./cross-platform-validation.md#slow-link-liveness-scenario)
when a browser client and a development or standalone server are available on
this platform; otherwise record it as unavailable evidence.

Use Codex Computer Use to operate the packaged executable. Capture normal,
minimum-size, and relevant Windows DPI states. Verify:

- the environment rail groups **This device** and usable WSL locations under
  Local, shows saved remote servers separately, and Add Project targets the
  current rail selection;
- in the **Repositories** view, the header's Add Project button opens the dialog
  with the **Location** selector; choosing a remote server makes **Browse folder**
  and the clone and create **Browse…** buttons list that server's folders;
- **Local environment** is visible at `/settings/local-environment` and never
  empty;
- Add a server by pairing code with a **Server alias**. Confirm the saved-server
  list and environment rail show that alias after reconnecting and restarting
  the app. Blank aliases use the pairing code's server name; failed pairing
  preserves the alias for retry. The remote server's own name remains unchanged;
- Add a headless web-mode `bibcode serve` server without an alias (pairing code
  or **Advanced: manual endpoint and token**) and confirm its name is the
  machine's hostname, with "Local" only if no usable hostname is reported.
  `bibcode start`, bare `bibcode`, and desktop-owned backends keep "Local".
  Select this server in the rail, then open **Settings → Remote Servers**.
  Choose **Rename…** from its **⋯** menu: the dialog is prefilled, refuses a
  blank name with **Enter a name for this server.**, and Enter in the name field
  saves. Enter on **Cancel** cancels; Enter on **Use the server's name** restores
  the reported name without saving. During saving, Escape and backdrop clicks
  keep the dialog open. A failed save explains the known reason and preserves
  the typed name for retry. Save a distinct name such as **Edge box** and confirm
  it appears immediately in the Settings row title, environment rail entry, and
  selected server's workspace card. Confirm the rail avatar initials update
  (**EB** for **Edge box**). Hover the Settings row's status dot before and after
  saving: it stays **Connected**, with no reconnect during the rename. Reload
  the app, then restart it; after each, confirm the saved name and initials
  persist. Disconnect reasons also use the saved name: rename the connected server, then
  close or interrupt its connection and confirm the reconnecting detail names
  the new alias. Repeat with a liveness timeout. Storage-identity errors still
  use the server's reported name;
- With that renamed test server connected, check a stalled connection on a
  Windows remote host: open Resource Monitor (`resmon.exe`) on that host, select
  the **CPU** tab, find the test server's `bibcode` process in the process list,
  right-click it, and choose **Suspend process**. Hover the Settings row's status
  dot and wait for
  `No data from <saved name> for 30 seconds. The connection is too slow or was lost. Reconnecting…`,
  followed by
  `Remote environment endpoint <base URL>/.well-known/bibcode/environment timed out after 10000ms. Reconnecting…`
  with the test server's endpoint URL. The disconnect reason uses the saved
  name (**Edge box**) and appears 27–33 seconds after the last data from the
  stopped server, when the client's liveness timeout closes the socket with
  code 4408. Keep BiBCode visible and focused for the whole stall: the
  disconnect then appears before a health-check message can become visible. If
  the window is restored from hidden or minimized during the stall, the
  application-active health check can report
  `<saved name> did not respond to a connection health check.` after 15
  seconds instead; repeat the check with the window kept visible.
  In Resource Monitor, right-click the same test
  server process, choose **Resume process**, and confirm it reconnects;
- select a saved server within a second of launch and confirm the rail keeps it
  selected for at least ten seconds while provider and settings updates arrive;
  repeat while the first primary welcome is delayed. A primary identity change
  follows the new primary only when the old primary was selected; a selected
  remote remains selected, including on `/agents` and with the mobile rail
  closed;
- Pair a loopback offer through a local connection or tunnel and confirm the
  already-active standard credential remains saved without administrative
  confirmation scope. Pending and off-host scope denials must still fail;
- Settings shows **Remote Servers** with **Connect to a host** and **Share this
  host** tabs; `/settings/connections` redirects there. SSH discovery and
  grant-driven sharing appears because the desktop bridge is present.
  remote targeting is driven by the environment rail rather than mixing saved
  servers into the Local WSL picker;
- Headless pairing: on a second machine or VM run `bibcode serve --host
<routable address>`, confirm the startup line contains `pairingCode`, and add it
  through **Add Server → Pairing code**. Confirm the saved server appears
  alongside — not in place of — the app's own **Local** environment, since both
  hosts declare the environment id `local`. Mint a second offer with `bibcode
pairing offer --endpoint http://<address>:3773` and confirm the dialog refuses
  it by name ("<label> is already saved."): two offers describe one environment.
  Then restart the headless server and confirm the saved server reconnects
  without re-pairing.
- Headless service: on the second machine run `bibcode service install --host
<routable address>`, confirm `bibcode service status` reports `active`,
  reboot that machine, and confirm the desktop's saved server reconnects
  without re-pairing. On Linux confirm `loginctl show-user $USER` reports
  `Linger=yes`; on macOS confirm automatic login is enabled; on Windows confirm
  the `BiBCode Server` task shows `Running` after logon. Finish with
  `bibcode service uninstall` and confirm the definition is gone.
- Remote server updates: with a second BiBCode server saved (headless
  `bibcode serve` is sufficient), open Remote Servers settings, run **Check for
  Server Updates**, and confirm each saved server row shows an update badge
  (**Manual updates** for a headless server) and a manual-instructions block
  with a copy button. An offline server must not block the rest of the batch and
  shows no update failure while it is disconnected; a blackholed check must settle
  after 30 seconds across supervisor acquisition, readiness, and RPC execution,
  then release its batch worker. A check that fails over a live connection shows
  **Check failed** with the reason as its tooltip, and the row's button reads
  **Check again**. When the second server is a desktop-hosted release build,
  restart it and confirm its sidebar card reads **Not checked yet**, then changes
  to **Up to date** or **Update to v…** within about a minute without **Check
  for updates**;
  Use a desktop-hosted release shared through **Another device** as the second
  host. From both Settings and its card, **Update to v…** must open a named
  confirmation; with one terminal open there, counts must say it will stop.
  Cancel starts nothing. Confirm, observe downloading/backup/restart/version
  checking and success; closing Settings must not cancel the run. A failed
  restart beyond the three-minute budget shows actionable failure; **Retry**
  reconfirms with fresh counts, and row **Dismiss** clears settled feedback.
  A manual host offers **Show update steps** and **Copy** matching its platform
  and install kind. The host notice names the requester and **Manage devices**
  opens sharing controls. Update a browser page's own host from another client;
  verify its explicit Reload prompt preserves typed composer input. Capture
  both themes. The notice may be classified as tests-only when no controlled
  release host is available; do not run the CI seeded harness locally.
  If remote protection fails on a WSL secondary, the error must instruct you
  to finish the update on the host; remote clients cannot exclude that backend.

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
  runbook's four explicit ceremony outcomes: authoritative local-only
  confirmation even after cancellation failure, another live access reason kept
  wide, cancellation and cleanup both unconfirmed, and cleanup topology
  unverified. Also cover the three-pass/five-second reconciliation retry and
  terminal warning toast, last-browser-session revocation
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
  listener exists, displays IP addresses (or endpoint hostnames) instead of
  network labels while retaining **Automatic (LAN)**, uses stable address/port
  IDs, safely preselects a private
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
- sidebar menus use the in-app menu: separators split the groups and are
  never doubled or at an edge. From the keyboard, focus starts on the first
  enabled item, the arrow keys skip separators but land on disabled items
  (focus is visible, the reason stays readable, and **Enter**, **Space** or a
  click leaves the menu open), **Home** and **End** jump to the ends, **→** and
  **←** open and close **Open in**, **Enter** or **Space** chooses, and
  **Escape** closes the menu and returns focus to the card or **⋯**.
  **Shift+F10** and the **Menu** key on a focused card open the menu once, at
  the card;
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

Run a terminal command that exits immediately, then close its terminal after
observing completion. Also close while the command is finishing. Both paths
must complete without an exit-wait timeout or a surviving process. The native
PTY regression covers exit before any subscriber exists and verifies that a
late subscriber receives the retained completion.

Remove the junction before its target, then remove only the exact fixture and
profile roots created by this run. Never delete a pre-existing `%TEMP%`, build,
or user directory.

After the last packaged launch, confirm no BiBCode, WebDriver, or Tauri process
from the run survives, then remove any firewall rules Windows generated for the
exact test executable and prove none remain. From an elevated PowerShell:

```powershell
Get-Process | Where-Object { $_.Path -and ($_.Path -ieq $env:BIBCODE_E2E_APP_PATH) }
node scripts/remove-test-firewall-rules.ts --executable $env:BIBCODE_E2E_APP_PATH --dry-run
node scripts/remove-test-firewall-rules.ts --executable $env:BIBCODE_E2E_APP_PATH
Get-NetFirewallApplicationFilter |
  Where-Object { $_.Program -ieq $env:BIBCODE_E2E_APP_PATH } |
  Get-NetFirewallRule
```

The helper selects rules by that exact program path, refuses installed
locations, never removes `BiBCode Remote Access`, and exits non-zero unless the
final query returns zero matching rules; the last command must print nothing.
Record the rule names removed and the empty verification in the report.

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

### Existing native Local/WSL visual follow-up partition

The fixed `release-visual-native-followups` selection reuses the native Windows
x64 WSL seeded owner with `--native-followups --wsl`. Require actual usable WSL
plus an installed distribution, the exact current-source Linux server asset
matching the protected desktop version, a real interactive display and private
Windows ACLs. The native adapter verifies distro/hostname/wslpath and the mapped
project-store root; a WSL primary may report Linux platform metadata. Never
relabel that metadata as Windows or use a native Windows substitute.

The adapter changes and restores the real display mode and records original
1280 by 960 desktop pixels for native-wsl-local in both themes. Missing WSL or
display capability is unavailable/incomplete evidence. The native opt-in fails
an unavailable WSL prerequisite and retains a closed status, including after
the fixture preparation step itself fails. The recorder uses `always()` so
that earlier failure cannot skip the existing unavailable receipt. The ordinary WSL
upgrade lane's documented skip remains unchanged. Native prerequisite failures
retain one of four closed `reasonCode` values: `wsl-status-failed`,
`wsl-list-failed`, `wsl-no-distro`, or `wsl-fixture-owner-refused`. The same status records
`wslStatusSucceeded`, `wslListObserved`, and `wslListSucceeded`; the last is null
when the existing status command failed and the list command did not run.
Unknown flags or inconsistent reason/observation tuples are refused.
Only `wsl-fixture-owner-refused` may additionally retain `prepareStage`, a fixed
name for the last existing Prepare block entered before its refusal. The failed
Prepare receipt and recorder validate the same finite stages. This identifies
the boundary without retaining paths, exception text or command output; success
and other actions retain their original receipts, and no new native action,
read, timeout or authority fallback is added. The registered Pester tests must execute the actual Prepare/catch and workflow
recorder bodies with inert ports before provisioning. Source consistency and
Node-only checks do not establish this PowerShell proof; report it as unexecuted
until the Windows CI gate passes.
At a `signed-metadata` Prepare refusal only, `signedMetadata` may retain the fixed
metadata item/operation, existing HTTP or GPG exit outcome and computed size,
fingerprint, signature and checksum match facts. Unreached facts remain null.
The failed receipt and recorder require exact keys, types, enum casing and
bounded counts; raw output and paths remain private. The registered CI-only
GPG test uses authenticated fixed metadata copies in an isolated test homedir. The pinned
Git `usr/bin/gpg.exe` uses MSYS POSIX absolute-home semantics. The owning
`Get-PinnedGitGpgHomeArgument` helper converts only the already-admitted local
native drive homedir to its `/drive/...` CLI form for both Prepare and the real
verifier. Drive-relative, UNC, extended namespace and noncanonical paths are
refused. Filesystem admission, ownership/ACLs, executable pins and key/signature
operands stay native; replacing separators with a drive-letter `C:/...` alone
does not make a POSIX-absolute homedir. No `cygpath` process or extra GPG action
is needed. The public-only import, fingerprint and detached-signature
verifier operations use documented `--no-autostart`: no private-key signing,
decryption or daemon lifecycle is part of this metadata boundary. The same
pinned public key and exact signer fingerprint remain mandatory; signature
mathematics, nonzero exit admission and corrupt-signature rejection are not
relaxed. The isolated owned home and native file operands are unchanged.
It adds no download or action to Prepare and does not establish the real refusal
cause until the actual Windows command outcome is observed.

The
ACL-protected zero-original status is written before the native prerequisite
step fails. No distro names, raw WSL output, host paths or exception text enter
these fields. The existing status read and conditional quiet list remain the
only capability commands; these diagnostics do not provision or change WSL,
download a root filesystem, update the host, select a default distro or reboot.
If owned Prepare was available and dependencies were installed, a failed native
source/public gate or later version/signing prerequisite can skip the native
wrapper. The failure-only fallback then records the existing failed Windows
status under the same secure root before finite upload: zero originals, two
required originals and `native-owner-start`, which identifies the unreached
owner boundary. It requires the actual Windows CI checkout/source, reuses the
joined command owner and existing ACL admission, and publishes create-new;
an existing status or ambiguous root refuses. It never requires release
versions, updater keys or a remaining distro manifest, invokes no product
runner, and does not relabel the failed prerequisite. Cancellation, unavailable
Prepare, failed dependency install, executed wrappers, ordinary lanes and Linux
are excluded. Native Windows CI must confirm the actual ACL/artifact boundary;
Node fixtures only prove source compatibility.

Native screenshot/status evidence uploads only two named PNGs, the three
retainer JSONs and the closed workflow status. Credentials,
private paths, ACL output and raw OS/driver logs remain in protected private
roots. Join exact owned processes and source/store/window identities before
retention; no generic process-name cleanup is admitted. This partition does not
qualify native Preview annotations or the full six-target release matrix.

### Owned files and the trusted system WSL launcher

The owned WSL fixture has two explicit pin roles. Generic owned non-directory
files retain the single-link guard. The system launcher is derived from the
maintained managed Windows System folder before the early signature/status/list
calls, independently of `SystemRoot` or a saved manifest path. Its named boundary
requires that exact location, a non-directory canonical leaf, no leaf/ancestor
reparse, a positive native link count, stable physical identity and SHA256, and
the existing Valid Microsoft Authenticode gate. The manifest retains the same
`wsl` pin/hash shape; no binary is copied and no replacement is re-pinned.

Every later fixture action enters through the manifest reader and repeats all
launcher path/type/reparse/identity/hash/signature checks. A servicing or identity
change refuses the lifecycle action; other owned-file/image/GPG/ACL/source and
cleanup guards remain unchanged. Pester must execute actual Prepare and manifest
consumers with inert faults and the native reader on owned one-/two-link files;
Node source compatibility checks cannot establish PowerShell or native identity
acceptance. Real launcher and kernel/lifecycle validation remains Windows CI.

### Optional encrypted original Prepare refusal

An approved manual Windows-only native follow-up dispatch may additionally set
`wsl_prepare_refusal_evidence=true` (default false). It reuses the existing
paired public SPKI/fingerprint and admitted private staging output. It does
not arm Pester controls, ordinary/callable workflows, Linux, or non-Prepare
operations. After passing Pester, the workflow admits the recipient and installs
one callback immediately around the real Prepare invocation; finally revokes
that capability before clearing its references, including receipt failures.

Only the original entire Prepare refusal is projected. Stock ErrorRecord and
InvocationInfo types and an exact maintained exception allowlist are admitted
before getters. No TargetObject, command/provider graph, arbitrary Data or
PowerShell serializer crosses this boundary. The maintained JSON serializer
receives only readonly owned primitive DTO fields: payloadVersion,
exceptionChain (type/message/hResult/clrStack), scriptStack, scriptLineNumber,
pinInputPath, pinAncestorPath, pinIsDirectory, pinLeafAttributes,
pinAncestorAttributes, nativeBranch, nativeWin32Error and nativeLinkCount.
Unknown results remain null. The at-most-four exception chain refuses cycles
and unknown subclasses. Per-string bounds and cumulative strict UTF8 256 KiB
omit rather than truncate. Original source lines identify existing ACL,
serialization/write/hash statements; only pin failures retain actual supplied
pin input/refusing ancestor and already-returned native results. Native branches
are CreateFile, GetFileInformationByHandle and SingleLinkPolicy; the Win32 error
is cached before disposal and the single-link guard is unchanged.

The same managed string Seal API and exact five encrypted files carry this
closed JSON under explicit AAD scope `wsl-owned-prepare-refusal`. Root must
nominate that scope before dispatch and validate the twelve payload keys after
authenticated decryption; it cannot interpret this ciphertext as GPG stderr.
No private key/plaintext, sixth artifact, new public field, filesystem probe,
provider/native command, guard waiver or acceptance claim is introduced.
Optional projection/serialization/encryption/publication failures preserve the
original closed Prepare receipt and exit. Strings cannot be promised erased.
Node/source controls are supporting proof only; actual managed projection,
Pester/callback/SDK interop and native identity remain Windows CI requirements.

### Optional encrypted real-GPG refusal evidence

For an approved single diagnostic run, manual `workflow_dispatch` may pair
`gpg_evidence_public_spki` (standard base64 public RSA SPKI DER) with
`gpg_evidence_public_sha256` (64 lowercase hex SHA256 of those DER bytes).
Both default empty. Require `native_followups=true` and
`native_windows_only=true`; callable workflows, PRs, ordinary seeded lanes,
and Linux selection do not receive the pair. Missing, malformed, mismatched,
or unsupported input omits this optional evidence and preserves the original
failed test. The operational private key stays only in the operator's private
0700 task root with 0600 permissions, never CI, source, secrets, logs or inputs.

The real failed import catch seals only the existing validated `command.stderr`
with managed RSA-3072/OAEP-SHA256 and AES-256-GCM. It admits a complete DER key
with exponent 65537, bounds public DER to 1024 bytes and UTF8 stderr to 1 MiB
before allocation, and never truncates or newly persists plaintext. Original
GPG arguments, mandatory exit/fingerprint/signature checks, and the native
artifact allowlist remain unchanged. Pester controls execute the actual catch
and SDK with inert keys; Node/source controls cannot establish Windows SDK
interop and must be reported separately.

The optional staging directory is separately admitted beneath `RUNNER_TEMP`
before Pester, with exclusive reservation, no existing-directory reuse,
reparse refusal, and protected current-user/SYSTEM ACLs. Five create-new files
become publishable together by directory rename: `context.json`,
`stderr.aesgcm.bin`, `key.rsa-oaep-sha256.bin`, `nonce.bin`, and `tag.bin`.
The separate pinned optional upload uses exactly those paths, one-day
retention, and omission on absent files. It cannot qualify a native row or
replace mandatory failure. Partial staging is never uploaded.

Before dispatch record exact source/ref, workflow/job role, recipient
fingerprint and manual choices privately. After dispatch authenticate and
uniquely bind the created run and current attempt; ambiguous joining stops
retrieval. The receiver validates the authenticated artifact identity/digest,
exact five bounded entries with no traversal/links/duplicates, and all nine
public context keys: version=1, scope=`wsl-real-gpg-import`,
alg=`RSA-OAEP-SHA256`, enc=`AES-256-GCM`, full source, positive-safe run and
attempt, jobRole=`windows-native`, and the independently nominated recipient
fingerprint. Authenticate the original context bytes as AES-GCM AAD, not a
reserialization. Only after successful authentication may complete UTF8 stderr
be written as 0600 under a fresh private root. No decrypted text enters tool
output, repository, issues, PRs, CI logs, or native artifacts. Encryption does
not authenticate the sender; authenticated GitHub provenance remains required.

Dispatch once after reviewed gates. Missing, invalid, unsupported, or unjoined
evidence requires stopping and replanning, not more labels or an unchanged
GPG retry. A decrypted error guides a caller regression; it is not native
acceptance or an established cause until inspected and reproduced.

### Owned WSL2 fixture for the native Local row

The selected native follow-up partition provisions one disposable WSL2 distro
only when the Windows CI owner can read a clean empty distro/default inventory.
It authenticates Canonical checksum metadata against the complete Ubuntu image
signing fingerprint, then verifies the pinned Ubuntu24.04.5 image before explicit
`--import --version 2`. It never runs a distribution installer, changes Windows
features, updates WSL, reboots, switches host defaults or borrows an existing
distro. Ordinary WSL upgrade capability/skip behavior remains unchanged.

A successful import is insufficient. The fixture must run an actual Microsoft
WSL2 kernel, x86_64 and Ubuntu24.04, join its physical Windows import path and
registration, and resolve the real checkout through that exact distro. Failed
kernel or ownership proof remains unavailable with zero originals. Hosted nested
virtualization is not assumed.

The native seeded lane takes the protected source/version overlay, builds its
real Linux server in this owned distro with locked inputs, and seeds the existing
isolated desktop settings to WSL-only, local-only exposure and the exact admitted
distro before app launch. It verifies the actual native bridge/descriptor, mapped
root and same running distro. No native Windows or WSL1 fallback is accepted.

Cleanup authority exists before import. The existing seeded process owner joins
native app/backend shutdown first. It then independently terminates and unregisters
only the exact owned distro, checks the original empty/default-null state and
physical private root, and removes only owned files. This completes before native
evidence retention. Partial startup, cancellation, changed registration/root or
unjoined app cleanup refuses deletion and acceptance; no global WSL shutdown or
name-prefix sweep is permitted. The workflow fallback uses the same authority
for setup failures and refuses an app that has not joined.

Run the declared helper and Pester controls before the native job. Local source,
TempFS or fake-command tests do not prove WSL, Windows ACLs or native originals.
The cheap Windows caller workflow also installs the existing frozen Node
workspace and runs the same fixed native helper set before any costly WSL
build. Its real process fixture uses the owned child IPC-ready acknowledgement before
the parent exits and joins the writer exit marker before removing TempFS. POSIX
requires the flushed inherited late tail; Windows requires the exact parent
output and avoids writing to its already closed inherited pipe. All-host inert
collector cases require data before close to be retained and exit alone not to
settle the result. Linux
UID/chmod/AppImage/D-Bus backend cases remain actual Linux CI requirements;
all-host inert metadata guard cases preserve their behavior without claiming
Windows ACL or native ownership. Portable Windows capture/evidence fixtures pass
the same platform argument as production, retaining byte/source/alias guards.
Its Ubuntu companion executes the actual Linux filesystem cases; neither row
substitutes for packaged native validation or accepted original captures.

`owned-wsl-fixture-controls.yml` runs the actual Pester caller controls on Windows
before packaging. It starts for fixture changes on the reviewed QA branch and
can also be dispatched manually. Require its green result at the exact candidate
commit before the expensive WSL partition; a source-only compatibility pass does
not satisfy that caller gate. This controls-only lane does not import a distro,
launch the product, build an installer or accept native screenshots.
For a changed Windows recipe, dispatch `desktop-upgrade-smoke.yml` from its
reviewed QA ref with both `native_followups=true` and `native_windows_only=true`.
This selects the existing Windows partition without repeating Linux. The
selector defaults to false for manual and reusable calls, preserving the combined
native group and ordinary upgrade lanes. Linux qualification remains required;
the Windows-only run does not complete the full native group.
Keep command logs, names, registry IDs, paths and private manifests outside public
evidence. The existing two original Local/WSL frames remain 1280 by 960; Preview
and complete-group acceptance remain pending.
