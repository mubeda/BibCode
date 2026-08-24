# Linux Desktop Validation

Read [Cross-platform validation](./cross-platform-validation.md) first. This
page contains only native Linux additions.

## Supported native target

The supported release target is Linux x64 AppImage built on Ubuntu 22.04. CI
also exercises Ubuntu 24.04, and release support includes Ubuntu 22.04,
Ubuntu 24.04, and Debian 12. Record any different distribution as compatibility
exploration rather than silently broadening support.

## Distribution, desktop, and toolchain inventory

Record:

```sh
cat /etc/os-release
uname -a
uname -m
printf 'desktop=%s\nsession=%s\nwayland=%s\ndisplay=%s\n' \
  "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE" "$WAYLAND_DISPLAY" "$DISPLAY"
git --version
gh --version
rustc -Vv
cargo -V
rustup show
node --version
vp --version
```

Check WebKitGTK, Tauri/AppImage, FUSE, graphics, and display dependencies
against current CI and release workflows. Use Xvfb for packaged E2E when the
host has no suitable interactive display. Do not install system packages
without permission.

## Focused Linux contracts

Select focused tests from affected source and verify at least:

- a symlinked ancestor and its physical path resolve to one worktree owner;
- persisted display path spelling is not replaced by canonical identity;
- repeated external-worktree adoption and restart remain idempotent;
- destructive worktree removal validates the registered physical identity and
  fails closed on replacement;
- Unix process groups retain one signal/wait/reap owner through cancellation,
  natural root exit, and late descendants, independently of the Windows-only
  Job implementation;
- independent runtimes cannot terminate each other's process roots;
- local-only desktop presentation omits WSL and remote-device controls;
- Claude, Codex, Cursor, and OpenCode remain visible while Grok is absent; and
- update protection treats long-lived read subscriptions as reads, reports
  staged progress and active mutation counts while preparing, rejects a forged
  first-attempt bypass, and offers the acknowledged no-backup path only after a
  real protection failure; and
- Linux AppImage/desktop identity and taskbar behavior remain covered.

Run affected concurrency-sensitive owners at default, 8, and 12 harness
threads without serializing broad suites.

## External worktree and symlink fixture

Use a unique test-owned root:

```sh
run_root=$(mktemp -d "${TMPDIR:-/tmp}/bibcode-linux-validation.XXXXXX")
repository="$run_root/Repository With Spaces"
worktrees="$run_root/External Worktrees"
alias_root="$run_root/Symlink Alias"
mkdir -p "$repository" "$worktrees"
git -C "$repository" init
git -C "$repository" config user.name 'BiBCode Test'
git -C "$repository" config user.email 'bibcode-test@example.invalid'
printf 'fixture\n' >"$repository/README.md"
git -C "$repository" add README.md
git -C "$repository" commit -m 'fixture baseline'
git -C "$repository" worktree add "$worktrees/Feature Alpha" -b feature-alpha
mkdir -p "$worktrees/feature-long-path/nested"
git -C "$repository" worktree add "$worktrees/feature-long-path/nested/candidate" -b feature-long
ln -s "$worktrees/Feature Alpha" "$alias_root"
git -C "$repository" worktree list --porcelain
realpath "$worktrees/Feature Alpha"
realpath "$alias_root"
```

Confirm the real path and symlink alias produce one BiBCode owner while the UI
retains the useful Git-reported display path. Exercise discovery, individual
adoption, **Add all**, **Keep hidden**, restart, and on-disk existence using
only fixture worktrees. Include the host's symlinked temporary-directory
behavior when applicable.

## Native tests and static gates

Run the shared focused tests and sequential broad/static gate set. Confirm
Linux-only tests are not filtered unexpectedly and record any AppImage,
WebKitGTK, X11, or Wayland diagnostic.

Do not run `vp run test` and a separate broad Cargo command concurrently. Do
not replace the normal Rust test harness with a serial harness.

For update validation, isolate `BIBCODE_HOME` plus XDG config, cache, and data
roots and use a disposable project. Keep a read subscription open while
installing an available test update and confirm it does not block protection.
During a deliberately held mutation, confirm the dialog promptly shows the
waiting stage, elapsed time, and an active-operation count. After the bounded
failure, verify that normal retry is still the primary action, the no-backup
action requires acknowledgement, a forged first-attempt bypass is rejected by
the native host, and an installer failure restarts the exact pre-update backend
set.

## AppImage build and inspection

Build the supported artifact:

```sh
vp run dist:desktop:linux
```

Discover the AppImage under the artifact output, record its absolute path,
verify it is nonempty and executable, and inspect version/architecture without
modifying the artifact. Record whether FUSE is available or the AppImage needs
its supported extraction fallback for testing.

Build and run packaged E2E with:

```sh
export BIBCODE_E2E_PLATFORM=linux
vp run test:ui:desktop:build
export BIBCODE_E2E_APP_PATH="$(find "$PWD/target/release/bundle/appimage" -maxdepth 1 -name '*.AppImage' -print -quit)"
test -n "$BIBCODE_E2E_APP_PATH"
xvfb-run --auto-servernum vp run test:ui:desktop
```

`BIBCODE_E2E_APP_PATH` deliberately selects the AppImage produced by the E2E
build in the current worktree, not an installed production copy.

Use the direct E2E command instead of Xvfb when a verified interactive display
is required and available. Isolate BiBCode application data and XDG config,
cache, and data roots for the test process without changing the parent shell or
user profile globally.

## Packaged UI scenarios

Use Codex Computer Use, not Orca. Capture the actual X11/Wayland and desktop
environment in the report. At normal and minimum sizes verify:

- Add Project has no Host selector or remote-device choice when only the local
  Linux environment is supported;
- WSL, Connections, SSH, pairing, Tailscale, relay, exposure, and remote retry
  UI is absent from ordinary desktop presentation;
- provider settings and action menus show Claude, Codex, Cursor, and OpenCode
  without Early Access labels and omit Grok/Grok Terminal;
- AppImage window identity, icon, launcher, and taskbar grouping are correct;
- external worktree grouping, paths, actions, physical identity, and restart
  are correct;
- thread switching, terminal I/O, Activity elapsed time, keyboard focus, and
  responsive overlays work; and
- repeated loaded interaction does not freeze, duplicate events, or grow an
  unbounded process tree.

Capture original-resolution screenshots plus focused crops and keep diagnostic
frames separate from acceptance evidence.

## Process-group cleanup

Capture PID, PPID, process group, start time, executable, and command line for
scoped AppImage, desktop, server, provider, terminal, WebDriver, Xvfb, and
fixture processes. Confirm cancellation and shutdown converge on bounded
terminate/wait/reap, late descendants cannot escape after a natural root exit,
peer runtimes remain alive, and no run-owned process survives.

Remove only exact fixture, profile, artifact, and evidence roots created by the
run. Report pre-existing processes or temporary roots without terminating or
deleting them.

## Windows and macOS compatibility audit

Audit that Linux fixes do not leak `/proc`, POSIX signals, Unix permissions,
shell syntax, or Linux-only paths into unguarded Windows/macOS code. Confirm
Windows native identity/Jobs/WSL contracts and macOS bundle/path/process-group
contracts remain present in host-independent tests. Report the result as
compatibility evidence only.

## Report and cleanup

Complete [the execution report template](./execution-report-template.md), then
perform the shared cleanup and final Git audit. Include distribution, display
protocol, AppImage execution mode, unsupported host differences, screenshot
paths, zero-survivor evidence, and whether anything was pushed.
