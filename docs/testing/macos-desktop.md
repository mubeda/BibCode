# macOS Desktop Validation

Read [Cross-platform validation](./cross-platform-validation.md) first. This
page contains only native macOS additions.

## Supported native targets

The supported release targets are macOS 11 or newer on Apple Silicon arm64 and
Intel x64. A native run proves only the host architecture unless another native
Mac executes the other artifact. Record macOS build, hardware architecture,
and whether translation is involved.

## Host and toolchain inventory

Record:

```sh
sw_vers
uname -a
uname -m
sysctl -n hw.optional.arm64 2>/dev/null || true
xcodebuild -version
git --version
gh --version
rustc -Vv
cargo -V
rustup show
node --version
vp --version
```

Record available signing identities and notarization credentials without
printing secrets. Ordinary repository builds use the current release policy;
do not import or invent credentials for a local validation.

## Focused macOS contracts

Select focused tests from affected source and verify at least:

- symlinked ancestors such as `/tmp` and `/private/tmp` resolve to one physical
  worktree identity;
- persisted display path spelling remains unchanged;
- external-worktree adoption and restart remain idempotent;
- worktree removal fails closed when physical identity cannot be proven;
- Unix process-group ownership survives cancellation and natural leader exit,
  reaps late descendants, does not signal peer-runtime roots, and remains
  independent of the Windows-only Job implementation;
- local-only desktop presentation omits WSL and remote-device controls;
- Claude, Codex, Cursor, and OpenCode remain visible while Grok is absent;
- Activity observation timestamps and keyboard navigation remain correct; and
- update protection treats long-lived read subscriptions as reads, reports
  staged progress and active mutation counts while preparing, rejects a forged
  first-attempt bypass, and offers the acknowledged no-backup path only after a
  real protection failure; and
- app/DMG identity and updater security tests remain green.

Run affected concurrency-sensitive owners at default, 8, and 12 harness
threads without serializing broad suites.

## External worktree and symlink fixture

Use a unique test-owned root outside a user project:

```sh
run_root=$(mktemp -d /private/tmp/bibcode-macos-validation.XXXXXX)
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

Also record the physical identity of any fixture created through `/tmp` and its
`/private/tmp` spelling. Confirm all aliases map to one BiBCode owner while the
UI retains useful Git-reported display spelling. Exercise discovery, adoption,
**Add all**, **Keep hidden**, restart, and final on-disk existence only with the
fixture worktrees.

## Native tests and static gates

Run the shared focused and sequential broad/static gate set. Record macOS
linker, compact-unwind, process-signal, WebKit, signing, and DMG diagnostics
with their affected test or artifact. Do not suppress a warning without
classifying it.

For update validation, use an isolated `BIBCODE_HOME` and disposable project.
Keep a read subscription open while installing an available test update and
confirm it does not block protection. During a deliberately held mutation,
confirm the dialog promptly shows the waiting stage, elapsed time, and an
active-operation count. After the bounded failure, verify that normal retry is
still the primary action, the no-backup action requires acknowledgement, a
forged first-attempt bypass is rejected by the native host, and an installer
failure restarts the exact pre-update backend set.

## Application and DMG build inspection

Build the host-native artifact:

```sh
vp run dist:desktop:dmg
```

Discover the generated DMG and `.app`. Read the actual executable and version
from `Info.plist` rather than assuming that the display name equals the binary
name:

```sh
plist="/absolute/path/BiBCode.app/Contents/Info.plist"
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist"
test -x "/absolute/path/BiBCode.app/Contents/MacOS/$executable"
codesign --verify --deep --strict --verbose=2 /absolute/path/BiBCode.app
```

Mount the exact test-owned DMG read-only at a fresh mount point, inspect the
contained application, and detach that mount during cleanup. Report configured
signing, ad-hoc signing, and notarization separately. Never claim notarization
when credentials or a notarized ticket are absent.

Build and run packaged E2E with:

```sh
export BIBCODE_E2E_PLATFORM=mac
vp run test:ui:desktop:build

dmg=$(find "$PWD/target/release/bundle/dmg" -maxdepth 1 -type f -name 'BiBCode_*.dmg' -print -quit)
test -n "$dmg"
mount_dir=$(mktemp -d /private/tmp/bibcode-macos-e2e-mount.XXXXXX)
cleanup_e2e_mount() {
  hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  rmdir "$mount_dir" 2>/dev/null || true
}
trap cleanup_e2e_mount EXIT HUP INT TERM
hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$dmg"

export BIBCODE_E2E_APP_PATH="$mount_dir/BiBCode.app"
test -d "$BIBCODE_E2E_APP_PATH"
vp run test:ui:desktop
```

`BIBCODE_E2E_APP_PATH` deliberately selects the application bundle produced by
the E2E build in the current worktree, not an installed production copy. The
DMG-only bundler removes its transient staging `.app` after packaging, so mount
the resulting DMG read-only instead of depending on that staging path. Keep the
cleanup trap active until WebDriver and the packaged application have exited.

## Renderer-data isolation

Prefer the E2E bundle identifier and isolated `BIBCODE_HOME` so the packaged
test cannot read a user's normal project store. Resolve the exact bundle
identifier from `Info.plist`; never target renderer data by display name.

If WebKit still uses a pre-existing profile for that exact bundle identifier,
stop before mutation and obtain authority to isolate it. With authority:

1. prove the exact application and related processes are absent;
2. inventory exact WebKit/cache roots, counts, sizes, ownership, permissions,
   and content/hash evidence;
3. move only those exact roots to a unique backup outside the active path;
4. launch the exact worktree bundle with isolated application data;
5. quit and prove all exact processes are absent;
6. move fresh test-created renderer roots to a separate evidence directory;
7. restore the original exact roots; and
8. compare the retained inventory and report any restoration discrepancy.

Do not delete user renderer data, Preferences, credentials, or an ambiguous
directory. If exact restoration cannot be proven, preserve both copies and
report the residual instead of attempting a destructive repair.

## Packaged UI scenarios

Use Codex Computer Use to operate the packaged executable. Confirm the
executable path and PID before using any frame as evidence. At normal and
minimum sizes verify:

- Add Project has no Host selector or remote-device choice for the local Mac;
- Settings shows **Remote Servers** with **Connect to a host** and **Share this
  host** tabs; `/settings/connections` redirects there. SSH discovery and
  grant-driven sharing appears because the desktop bridge is present. Generate
  an **Another device** offer, verify the restart completes before the browser
  URL, deep link, pairing code, and QR code appear, then revoke the last
  off-host offer or client and verify exposure returns to loopback.
  Add Project still has no Host selector for the local machine;
- from the OS, opening a well-formed `bibcode://pair?code=...` link while the
  packaged app is running lands on Add Server with the code prefilled. The
  custom scheme is bundle-time-only on macOS and is not an unbundled dev-mode
  check;
- provider settings and action menus show Claude, Codex, Cursor, and OpenCode
  without Early Access labels and omit Grok/Grok Terminal;
- external worktree grouping, full paths, actions, physical identity, and
  restart are correct;
- thread creation/switching, terminal I/O, Activity elapsed time, subagent row
  layout, background tasks, keyboard focus, and Shift+Tab work; and
- narrow panels, menus, overlays, icons, and focus states remain contained.

Capture original-resolution screenshots and focused crops. Exclude an installed
application splash or any frame from a different PID/bundle from acceptance
evidence.

## Process-group cleanup

Capture PID, PPID, process group, start time, executable, and command line for
scoped app, server, provider, terminal, WebDriver, mount, and fixture roots.
Confirm bounded terminate/wait/reap, late-descendant cleanup after natural root
exit, peer-runtime isolation, and zero run-owned survivors.

Detach only the exact DMG mount. Remove only exact fixture, profile, artifact,
and evidence directories created by the run. Leave pre-existing targets and
processes untouched.

## Windows and Linux compatibility audit

Audit that macOS fixes do not leak `/private/tmp`, Darwin APIs, bundle paths,
WebKit locations, `hdiutil`, or macOS signal behavior into unguarded shared
Windows/Linux code. Confirm Windows file identity/Jobs/WSL and Linux
AppImage/process-group/display contracts remain present in host-independent
tests. Report these as compatibility evidence only.

## Report, restoration, and cleanup

Complete [the execution report template](./execution-report-template.md), then
perform shared cleanup and final Git audit. Include the actual
`CFBundleExecutable`, bundle identifier, signing/notarization classification,
DMG mount/detach evidence, renderer restoration evidence, screenshot paths,
zero-survivor evidence, and whether anything was pushed.
