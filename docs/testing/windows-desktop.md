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
- remote device, SSH, Tailscale, relay, and connection actions do not mount in
  ordinary desktop presentation; and
- Claude, Codex, Cursor, and OpenCode are visible while Grok is absent.

Run affected concurrency-sensitive owners at default, 8, and 12 harness
threads. Do not replace the default harness with a serial run.

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
- Add Project offers **This device** plus only WSL locations with a matching
  usable bootstrap;
- native and WSL paths do not collapse into one project identity;
- a disposable WSL project can launch its supported session and terminal;
- restart retains the correct environment identity; and
- shutdown does not terminate unrelated WSL processes.

When WSL is unavailable:

- Local Environment still renders a meaningful unavailable state, not an empty
  section;
- refresh/retry remains accessible;
- Add Project does not present an unusable distribution; and
- local Windows projects remain usable.

Do not install a distribution or change system WSL configuration without
permission. SSH, Tailscale, relay, and remote-device targets remain absent in
both branches of the matrix.

## Native tests and static gates

Follow the shared focused and broad gates. Root workspace scripts already use
the package-specific MSVC launcher. When a direct native Rust command needs the
same environment, use:

```powershell
node scripts/run-msvc-x64.mjs cargo test --workspace -j 2
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

Use Codex Computer Use, not Orca. Capture normal, minimum-size, and relevant
Windows DPI states. Verify:

- Add Project shows **This device** and usable WSL locations only;
- Local Environment is visible and never empty;
- Connections, SSH, pairing, Tailscale, relay, exposure, and remote retry UI is
  absent from ordinary desktop presentation;
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
