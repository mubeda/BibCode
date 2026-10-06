# Linux Desktop Validation

Read [Cross-platform validation](./cross-platform-validation.md) first. This
page contains only native Linux additions.

## Supported native target

Linux distribution support targets are Debian, Ubuntu, Fedora, and Arch. Desktop
release artifacts are ARM64 and x64 AppImages built on matching Ubuntu 22.04
runners. Record the distribution release, architecture, and desktop session for
each native validation; a passing Git subprocess check alone does not qualify
the complete desktop, installer, or updater on that system.

Standalone server releases add ARM64/x64 `.tar.gz`, `.deb`, and `.rpm` artifacts. Native
package evidence covers Ubuntu 22.04, Ubuntu 24.04, Debian 12, Rocky Linux 9, and Fedora
44 as prescribed by the shared runbook.

## Distribution, desktop, and toolchain inventory

Record:

```sh
cat /etc/os-release
uname -a
uname -m
printf 'desktop=%s\nsession=%s\nwayland=%s\ndisplay=%s\n' \
  "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_TYPE" "$WAYLAND_DISPLAY" "$DISPLAY"
gsettings get org.gnome.desktop.interface font-hinting
gsettings get org.gnome.desktop.interface font-antialiasing
git --version
gh --version
rustc -Vv
cargo -V
rustup show
node --version
vp --version
```

On a non-GNOME desktop record the equivalent hinting and antialiasing settings
instead. The host keys its hinting pin off the GTK `gtk-xft-hintstyle` value,
so any desktop that produces `hintfull` exercises it.

Check WebKitGTK, Tauri/AppImage, FUSE, graphics, and display dependencies
against current CI and release workflows. Use Xvfb for packaged E2E when the
host has no suitable interactive display. Do not install system packages
without permission.

Linux AppImages bundle WebKitGTK from their build host. Isolate XDG config,
cache, and data roots when running locally built AppImages on a newer
distribution (for example Fedora with WebKitGTK 2.52); otherwise they can
migrate IndexedDB metadata that a CI AppImage built on Ubuntu 22.04 with
WebKitGTK 2.50 cannot reopen. If an older build reuses that data root, expect
the connection-database reset dialog. On Linux the connection catalog lives in
IndexedDB, so that reset also deletes saved servers and credentials; isolate
the data root before the first launch rather than resetting afterwards.

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
- Local desktop presentation omits WSL controls while saved remote environments
  remain selectable in the environment rail without bypassing desktop-owned
  connection controls;
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

Run the AppImage GTK wrapper regression on Linux:

```sh
vp test scripts/tauri-linuxdeploy-plugin-gtk.test.ts
```

It covers Wayland library removal, the generated backend export, removal of
forced theme selection, user theme overrides, missing and drifted hooks failing
without post-processing mutations, discovery passthrough, and upstream failure
propagation.

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

With the same isolated test instance, arrange an installer failure and have a
test-owned listener acquire its backend port after shutdown, keeping it bound
past the 3 s restart window. Confirm **Update not installed** names that port
as in use, offers **Restart server**, and disables **Retry installation** with
the visible restart explanation. Keep an unsent composer draft and verify it
survives the outage. Release only the test listener, choose **Restart server**,
and confirm the same backend port reconnects, the draft remains, and **Retry
installation** becomes available without reopening the dialog. Record the
listener/installer fixture and observed port in the execution report; never use
the user's running instance for this check.

## AppImage build and inspection

Use the Ubuntu 22.04 release runners for release AppImage qualification. A
supported runtime distribution may have a newer build-host library layout
that the pinned bundler does not support. In particular, newer Arch
GdkPixbuf packages can omit the legacy loader directory that the GTK plugin
copies. The wrapper checks `pkg-config --variable=gdk_pixbuf_moduledir
gdk-pixbuf-2.0` before invoking the plugin, and refuses a missing/empty loader
path with an actionable build-host diagnostic. Missing package metadata also
fails before the plugin can modify the AppDir. Record the package versions and
advertised path; build with the documented native-architecture Ubuntu 22.04
baseline or use an official release AppImage on the newer runtime distribution.
This does not add Glycin bundling support. Do not create an empty loader
directory, downgrade desktop libraries, or bypass the pinned plugin to make
packaging pass. `--plugin-api-version` discovery does not require GTK metadata.
Successful local DEB/RPM packaging does not qualify the AppImage; its release
build and artifact checks must still pass on the documented baseline.

### User-facing child environment isolation

Validate the [AppImage child environment policy](../architecture/overview.md#appimage-child-environments).
The regressions must cover:

- Each covered production launch class, including chat-mode providers, Claude
  runtime probes, provider inventory probes including Codex, the Codex usage
  app-server helper, Codex/OpenCode helpers, both review Git commands,
  editor/file-manager launches, and desktop-owned SSH, Tailscale, and `kill`.
  Removing a site's isolation call must make its regression fail.
- Library, executable, GTK, Python, Qt, GStreamer, and unknown plugin variables;
  launcher markers and forced settings; mixed and bundled-only values; real
  launcher trailing colons; host credentials; non-path lists; and raw-byte
  values and command overrides. Include colon/semicolon library paths and
  space/colon preloads, plus a planted working-directory library that must not
  load.
- Extracted AppDirs, paths containing spaces, stale absolute `.mount_*` paths,
  the five ordinary-launch no-op cases (`unset-appimage`, `empty-appimage`,
  `relative-appdir`, `root-appdir`, and `unset-appdir`), and the positive and
  negative extracted AppDir gate cases. Exercise both text and binary Git
  output and a real PTY shell and Python process.
- An unchanged complete parent environment and the login-shell PATH-probe
  exemption, including its AppDir-first PATH and original launcher values.
  Each re-executed test phase must prove entry and completion; a successful
  zero-test exit is insufficient.
- File-manager prompt return, survival after the launch call returns, a
  separate process group, eventual reaping, typed spawn errors, and candidate
  fallback order after spawn failure.

Run on Linux with a C compiler and system Git:

```sh
cargo test --locked -p bibcode-server --test linux_appimage_git_environment -j 2 -- --nocapture
cargo test --locked -p bibcode-server --test linux_appimage_child_environment -j 2 -- --nocapture
cargo test --locked -p bibcode-server --lib appimage -j 2 -- --nocapture
cargo test --locked -p bibcode-server --lib file_manager_launch -j 2 -- --nocapture
cargo test --locked -p bibcode-desktop --lib appimage -j 2 -- --nocapture
```

The Git regression must first demonstrate the incompatible fixture library's
loader failure, then pass through the real Git runner. The Python regression
requires a real PTY child to exit zero and print `ok`. Capture its completion
marker with `--nocapture`; to run it separately:

```sh
cargo test --locked -p bibcode-server --test linux_appimage_child_environment python_in_appimage_terminal_uses_host_standard_library -- --nocapture
```

Require `BIBCODE_PYTHON_PTY_RAN` and absence of `BIBCODE_PYTHON_PTY_SKIP` in the
captured stdout. A skip is **unavailable evidence, not a pass**; record it and
rerun on a host with Python.

`.github/workflows/linux-git-compatibility.yml` builds the Git regression on Ubuntu 22.04
and runs the executable with each distribution's system Git in Debian 12/13,
Ubuntu 22.04/24.04, Fedora 44, and Arch rolling containers. The build baseline
matters: a test built against a newer glibc cannot qualify older distributions.
The matrix tests x64 in CI; native ARM64 runs remain required for ARM64 evidence.

To repeat the matrix, pass the executable path from Cargo's
`--message-format=json` compiler-artifact event:

```sh
bash scripts/test-linux-git-compatibility.sh /absolute/path/to/test-executable
CONTAINER_ENGINE=podman bash scripts/test-linux-git-compatibility.sh /absolute/path/to/test-executable
```

Optional trailing arguments select specific image names from the script's
matrix. Package installation is confined to disposable containers; each
container has a bounded timeout and is removed after its result. Record every
distribution result separately, including failures.

For release qualification, also use the packaged app to fetch from a disposable
HTTPS repository on each target distribution, both through Git Manager and a
BiBCode terminal (`git ls-remote origin HEAD`). Confirm the terminal resolves
`xdg-open` and `xdg-mime` to host copies, then run
`python3 -c 'print("ok")'` and require exit zero and `ok` output. Confirm a
configured Claude Code status line whose script invokes Python renders normally.
Open a configured Flatpak editor and a file manager from the app and check for
GLib symbol errors and AppImage-rooted `xdg-open` selection. Repeat terminal
Git/Python and tool launch checks from an extracted `squashfs-root/AppRun`
without `APPIMAGE`, including Ubuntu without libfuse2. Record desktop URL/path
opening, Linux file reveal, deep-link registration, and the GTK hook's
`XDG_DATA_DIRS` limitation separately against the
[current limitations](../architecture/overview.md#appimage-child-environments).
Verify that the server's file-manager launch returns promptly, the running
file manager survives the RPC return, and its exited child is eventually
reaped.
Inspect a running provider's environment for the same isolation and confirm the
desktop still retains its bundled paths and renders correctly. Record the Git
Manager, terminal Git/Python, status line, and provider results, library-loader
diagnostics, and desktop/update checks separately from these subprocess
regressions.

### Native artifact

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
export BIBCODE_E2E_APP_PATH="$(find "$PWD/target/$(rustc -vV | sed -n 's/^host: //p')/release/bundle/appimage" -maxdepth 1 -name '*.AppImage' -print -quit)"
test -n "$BIBCODE_E2E_APP_PATH"
WAYLAND_DISPLAY=bibcode-no-wayland xvfb-run --auto-servernum vp run test:ui:desktop
```

The packaged AppImage prefers the Wayland backend, and libwayland connects to
`$XDG_RUNTIME_DIR/wayland-0` even when `WAYLAND_DISPLAY` is unset. On a host
with a live Wayland session the app would therefore open on the real desktop
instead of Xvfb, and document reloads fail the suite. Pointing
`WAYLAND_DISPLAY` at a socket that does not exist makes the Wayland connection
fail and exercises the X11 fallback inside Xvfb; `BIBCODE_GDK_BACKEND=x11`
is the alternative and skips the fallback path.

`BIBCODE_E2E_APP_PATH` deliberately selects the AppImage produced by the E2E
build in the current worktree, not an installed production copy. The E2E build
always passes the host target triple to Tauri, so the bundle lands under
`target/<host triple>/release/bundle/appimage/`, not `target/release/`.

Use the direct E2E command instead of Xvfb when a verified interactive display
is required and available. Isolate BiBCode application data and XDG config,
cache, and data roots for the test process without changing the parent shell or
user profile globally.

With that isolated instance running from the absolute `BIBCODE_E2E_APP_PATH`
on a FUSE-capable test host, perform an update relaunch or **Restart BiBCode**.
Once the replacement window is ready, require exactly one `.mount_` entry for
this AppImage in `/proc/mounts` and one AppImage runtime process. Use a host
where this is the only running BiBCode AppImage; the runtime's mount prefix uses
the first six characters of the artifact name. Both checks below must exit zero
and print exactly one entry; extraction mode cannot supply this FUSE evidence.

```sh
appimage_mount_prefix="/.mount_$(basename "$BIBCODE_E2E_APP_PATH" | cut -c1-6)"
awk -v prefix="$appimage_mount_prefix" '
  index($2, prefix) { print; mounts++ }
  END { exit (mounts != 1) }
' /proc/mounts &&
  ps -ww -eo pid=,args= | awk -v appimage="$BIBCODE_E2E_APP_PATH" '
    { pid = $1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "") }
    $0 == appimage || index($0, appimage " ") == 1 { print pid, $0; runtimes++ }
    END { exit (runtimes != 1) }
  '
```

### Manual headless development checks

Use the maintained packaged E2E procedure above for release evidence. For a
manual development check beside an installed app, choose a separate Tauri
identifier: Linux single-instance ownership is keyed by the identifier, so a
second launch with the production identifier can exit successfully without
opening a test window. An identifier alone does not isolate the backend data;
also set a disposable `BIBCODE_HOME` and XDG config, cache, and data roots for
every test process.

With the isolated development graph already running, invoke Tauri from
`apps/desktop` with an identifier override and an empty `beforeDevCommand`.
Set `build.devUrl` to that graph's actual web URL if its port differs from the
default in `tauri.conf.json`. Keep these overrides in the command's `--config`
JSON; do not edit the production configuration. Do not use
`tauri.e2e.conf.json` for a plain debug launch: its WebDriver permissions need
the `desktop-e2e` feature selected by the packaged E2E builder.

Use a test-owned Xvfb display and select X11 for the test process. Without a
window manager, `xdotool windowactivate` may not work; focus the exact test
window with `xdotool windowfocus --sync "$window_id"` before sending keyboard
input, including input to a native picker. Capture that window with
`import -window "$window_id" "$screenshot_file"` and inspect the image. Use
only disposable fixture directories in pickers. Follow the scoped process
cleanup below rather than terminating processes by application name.

Xvfb interaction evidence does not establish native Wayland scaling or the
session's font hinting. For hinting-dependent checks, record the actual GTK
hinting values and the host's override diagnostic on the test display. Follow
the [text-rendering contract](../architecture/overview.md#linux-webview-text-rendering);
do not change the user's desktop settings to make a harness reproduce it.

### GTK backend and fractional scaling

Inspect an extracted copy of the built AppImage: no `libwayland-client.so*`
files or symlinks may remain under `usr/lib*`, and
`apprun-hooks/linuxdeploy-plugin-gtk.sh` must contain exactly one
`export GDK_BACKEND="${BIBCODE_GDK_BACKEND:-wayland,x11}"` line. The hook must
contain no `gsettings get org.gnome.desktop.interface gtk-theme` line, no
`APPIMAGE_GTK_THEME="${APPIMAGE_GTK_THEME:-` default, and no unconditional
`export GTK_THEME=` line. Require exactly one conditional override:

```sh
if [ -n "${APPIMAGE_GTK_THEME:-}" ]; then export GTK_THEME="$APPIMAGE_GTK_THEME"; fi
```

Record the backend actually used by the packaged BiBCode window, alongside the
desktop session, monitor scale, `GDK_SCALE`, `GDK_DPI_SCALE`, and any
`BIBCODE_GDK_BACKEND` override:

- On Hyprland, capture `hyprctl clients -j` and identify BiBCode by its PID,
  class, and title. Its `xwayland` field must be `false` for native Wayland and
  `true` for Xwayland. Record monitor scaling with `hyprctl monitors -j`.
- Elsewhere, record `WAYLAND_DISPLAY` and `DISPLAY`, then use
  `xprop WM_CLASS _NET_WM_PID` to identify an X11 BiBCode window (Xwayland on a
  Wayland session). For native Wayland, use the compositor's window inspector
  to confirm the app's backend. `WAYLAND_DISPLAY` alone only shows that Wayland
  is available; it does not prove BiBCode used it. If the backend cannot be
  established, record that evidence as unavailable.

On Hyprland/Omarchy, launch with `BIBCODE_GDK_BACKEND` unset at a fractional
monitor scale such as 1.5×. Verify native Wayland and capture normal and minimum
window sizes: text and controls must no longer render about 1.33× too large.
Record the compositor's Xwayland scaling configuration, including
`xwayland:force_zero_scaling` when present.

Close the test instance and repeat with the override, using the same isolated
application and XDG roots:

```sh
BIBCODE_GDK_BACKEND=x11 /absolute/path/to/BiBCode.AppImage
```

Confirm X11/Xwayland through the window evidence above; the override restores
the previous behavior and may reproduce the oversized rendering. Also launch
without the override on an X11-only session (or Xvfb with `WAYLAND_DISPLAY`
unset) to verify automatic X11 fallback. Report unavailable desktop sessions
separately; Xvfb evidence alone does not validate native Wayland scaling.

### GTK light/dark theme

Use an isolated test session with a working desktop portal settings backend.
Record its `org.freedesktop.appearance` `color-scheme` and GTK theme name;
Xvfb alone does not provide a portal. Launch the AppImage with `GTK_THEME` and
`APPIMAGE_GTK_THEME` unset for the system-following checks:

- With **Settings → General → Theme** on **System**, launch once with a dark
  system scheme and once with a light scheme. Switch both ways while each
  instance runs. The webview, native menubar, and native dialogs must match at
  launch and after every switch.
- Include a light system scheme with the legacy GTK theme `Adwaita-dark`, and
  a dark system scheme with GTK theme `Adwaita`. The portal color scheme must
  determine the variant; the AppImage's process-local theme name stays Adwaita.
- Select **Light**, then **Dark**, and switch the system scheme both ways for
  each. The webview and native menubar/dialogs must retain the explicit choice.
  Return to **System** and verify immediate adoption and subsequent live changes.
- Separately launch with a user `GTK_THEME` override, then with a nonempty
  `APPIMAGE_GTK_THEME` override. Confirm those values are honored; the latter
  takes precedence if both are set. Explicit environment overrides may pin a
  variant and are excluded from the system-following acceptance checks.

Record screenshots at launch and after changes, the portal/backend setup, and
any unavailable native sessions. Restore settings only within the test session.

## Manual visual workflow registration

The default-branch `qualify-release-visuals.yml` is registration only. GitHub
requires a manually dispatched workflow to exist on the default branch; the
`--ref` option selects the workflow version on the nominated QA branch or tag.
The default-branch version always fails with the closed
`QUALIFICATION_REQUIRES_NOMINATED_QA_REF` classification before checkout,
dependencies, runtime admission, or artifact retention. That refusal is not a
native result. It does not install the QA owner or fixtures on `main`.

Review and nominate the fully merged QA source before dispatch. Require that
ref to contain the full workflow at the same path and its current owner,
fixtures, helper tests, guarded CLI build, web build, static gates, and explicit
evidence retention. Dispatch each existing selection separately:

```sh
qualification_ref="<nominated QA branch or tag>"
gh workflow run qualify-release-visuals.yml --ref "$qualification_ref" -f scene_selection=release-visual-core
gh workflow run qualify-release-visuals.yml --ref "$qualification_ref" -f scene_selection=release-visual-settings
gh workflow run qualify-release-visuals.yml --ref "$qualification_ref" -f scene_selection=release-visual-git-project
```

Record the reviewed commit and require the actual run's head SHA to match it.
The checkout, compiled inputs, and owner provenance must all name that same
source; do not substitute a different checkout while retaining the dispatch
SHA. Preserve the selected workflow's existing scene predicates, process and
namespace ownership, bounds, cleanup proofs, and named light/dark originals.
A completed preparation group does not prove the full 82-scene/164-original
requirement, packaged Tauri scenarios, or other platforms. Keep execution refs,
SHAs, counts, timings, and screenshot findings in the execution report.

Verify registration policy without starting the qualification runtime:

```sh
vp test run scripts/qualify-release-visuals-registration.test.ts scripts/ci-platform-contract.test.ts
```

## Manual remote update UI registration

The default-branch `qualify-release-ui.yml` also registers dispatch only. It
has the existing `matrix` choices `core` and `full`, with `core` as the default,
and refuses execution before checkout or runtime admission. Its historical
presence in the Actions workflow list is insufficient: verify that the file
exists on the current default branch before dispatching the nominated QA ref.

Choose one matrix on the reviewed QA source. The full workflow on that ref
retains its guarded server, maintained interactive fake host, source web build,
private PID/network owners, static/helper gates, and explicit original-image
and receipt retention. Its existing QA-branch push trigger stays in that
version; the default registration stub has no automatic trigger.

```sh
qualification_ref="<nominated QA branch or tag>"
qualification_matrix="full"
gh workflow run qualify-release-ui.yml --ref "$qualification_ref" -f matrix="$qualification_matrix"
```

Require the actual run's head SHA, compiled inputs and owner provenance to
match the reviewed nomination. Check joined controller/supervisor/namespace
cleanup and unchanged build inputs before independently inspecting the
originals. The controlled browser matrix does not qualify Tauri native dialogs,
real remote installers, other platforms, or the full screenshot obligation.
Record source and scope in the execution report; do not turn a registration
refusal or a partial matrix into acceptance evidence.

The static registration policy is safe to verify without starting its owner:

```sh
vp test run scripts/qualify-release-ui-registration.test.ts
```

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

Use Codex Computer Use to operate the packaged executable. Capture the actual
X11/Wayland and desktop environment in the report. At normal and minimum sizes
verify:

- when only the local Linux environment is configured, the rail shows Local and
  Add Project has no remote target; saved remote environments appear as separate
  rail entries and become the Add Project target when selected;
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
  Linux remote host: use `pgrep -f "bibcode serve"` or the process list to find
  the test server's PID, then run `kill -STOP <pid>` on that host. Hover the
  Settings row's status dot and wait for
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
  Run `kill -CONT <pid>` on the remote host to resume
  the same test server and confirm it reconnects;
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
  grant-driven sharing appears because the desktop bridge is present. Generate
  an **Another device** offer, verify the restart completes before the browser
  URL, deep link, pairing code, and QR code appear, then revoke the final
  native-managed **Another device** offer or client and verify exposure returns
  to loopback. Capture the
  shared runbook's four explicit ceremony outcomes: authoritative local-only
  confirmation even after cancellation failure, another live access reason kept
  wide, cancellation and cleanup both unconfirmed, and cleanup topology
  unverified. Also cover the three-pass/five-second reconciliation retry and
  terminal warning toast, last-browser-session
  revocation, one compensating widen during a concurrent grant, bounded handling
  of a blackholed create response, and explicit legacy resume after a local-only
  restart. The address picker lists only usable IPv4 candidates until a
  dual-stack listener exists, displays IP addresses (or endpoint hostnames)
  instead of network labels while retaining **Automatic (LAN)**, uses stable
  address/port IDs, safely preselects a
  private default, reports off-host interface observations unavailable before
  widening, and leaves generation disabled with externally managed
  listener/reverse-proxy guidance when native discovery has only a public or
  non-default private address. Public interface candidates remain
  non-actionable even after native exposure is wide. A custom off-host address
  mints without changing the native listener or firewall, and later auth
  revisions do not widen it. An externally managed public endpoint is never
  preselected and requires explicit public-address/firewall acknowledgement. If
  Tailscale is installed in its packaged location, discovery must not depend on
  shell `PATH` and must suppress unusable, public, or IPv6 candidates. Confirm
  Linux firewall management remains explicitly operator-owned. The local-machine
  flow still has no Host selector; remote targeting is driven by the environment
  rail;
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
  For the CI AppImage remote-install lane, use its isolated filename prefix:
  `/proc/mounts` must contain exactly one corresponding `.mount_` entry after
  restart, and the recorded runtime process count must be one. Count and stop
  only processes whose current environment has that lane's exact `BIBCODE_HOME`.

  The temporary `qualify-release-ui.yml` QA CI workflow qualifies the browser
  controls against the maintained `remote_update_fake_host` example and real
  headless CLI layouts. Its default **core** selection covers both themes for
  confirmation/cancel, fresh active-work counts, progress across remount, success,
  failure/retry/dismiss and manual instructions. **Full** additionally selects
  wrong-version restart, the actual three-minute no-return deadline, two active
  updates plus one queued update, and the real browser Reload button. A core
  result explicitly lists those pending cases and is not full UI qualification.
  The final bounded-parallel assertion records the core queue checks before
  removing its three owned hosts. Completion of that assertion does not prove
  host removal completed. Fixed `queued-remove-a/b/c-<operation>` markers
  identify the existing settings, More/Remove/confirmation waits and clicks,
  row-removal wait, child/tunnel joins and toast-display/click boundaries. Slot
  names come from the fixed host order, never labels or identifiers. Optional
  marker failures cannot skip an action, replace its original failure or alter
  a budget; these markers add no UI read, request or interaction. After row
  removal and owned child/tunnel joins, toast cleanup reads current visible close
  controls and their pinned SDK public clickability before dispatch. Skip
  displayed but ineligible controls during the current enumeration; click one
  eligible close at a time within the existing thirty-second owner observation
  bound. Keep cleanup incomplete while any visible close remains, even when none
  is currently clickable. Fixed `toast-clickable` phases attribute that read.
  Ending/reflowing roots can remain displayed while outside the viewport or
  covered; display alone does not establish interaction eligibility. Re-fetch
  after each dismissal and require a fresh read with zero visible
  close controls before completing cleanup. A recognized missing/stale click may
  count as already gone only when a second fresh enumeration proves that same
  zero-visible end state. Unknown click errors, visible replacements and failed
  absence reads preserve the original failure and click phase. This conservative
  recognition reads an own data message. It admits the canonical missing/stale
  prefixes, the exact public implicit-missing click message, the pinned SDK's exact
  internal scroll-missing or getHTML-missing message for that same toast-close
  selector during its Classic click fallbacks, and the pinned SDK's
  `WebDriverError` wrapper only for a bounded element-ID click command with `POST`
  and no argument suffix. Wrapped detail can contain the SDK's preserved line breaks
  within its 1024-character bound; element IDs remain bounded. Other error
  families, commands or methods, malformed wrappers and unavailable message data
  preserve the original error. The successful-HTML SDK middleware variant additionally
  requires its exact own data middleware name, at most 1024 message units, exact
  `Element … did not become interactable` framing and a single outer button with
  exactly one real `data-slot="toast-close"` attribute. The bounded opening-tag
  attribute check treats quoted values as opaque, rejects duplicate/spoofed markers,
  and never parses the inner markup. It still requires the unchanged fresh zero-visible
  close proof; visible/replacement controls and failed reads preserve the same error.
  Native closed shape alone does not identify this as the native cause. Keep raw
  HTML, messages, IDs, URLs and arguments private;
  recognition adds no evidence beyond the existing fixed phase markers. This
  proof needs no fabricated toast identity or changes to toast lifetimes, Retry
  behavior or functional assertions. A missing element alone does not establish
  an auto-dismiss cause. A null Reload witness before its stage remains
  unavailable evidence.
  After the scripted wrong-version restart, its updater status has no latest
  version. Verify the exact wrong-version error first, then use Settings Retry
  and require the named confirmation without a version plus fresh work counts.
  Cancel must retain exactly the original one install request. Do not invent a
  target or change the fixture's status to preserve the pre-restart dialog title.
  Separate Retry, reconfirmation, Cancel, request-count and removal phases locate
  failures without retaining page text or weakening the existing action bounds.
  The final failure-flow Check/Check again boundary separately records its
  displayed wait, clickability wait, click and row-state wait. A failure there
  adds one guarded row sample to the existing two-second failure observation:
  fixed row/control count and label categories, visibility/disabled flags,
  known update badge, expected version-action and Dismiss presence, and a finite
  center-point hit category. It requires the fixed QA origin, exact Remote
  Servers route, empty query/fragment and a light/dark fixture name before row
  inspection. Unknown, unsafe, missing or ambiguous scope remains unavailable.
  Decode only own enumerable data facts; refuse recognized accessors/nonenumerable
  descriptors or reflection failures locally, and leave inherited facts unknown.
  No text, input, path, URL, credential, selector, coordinate or raw interceptor
  leaves the page. These are current post-failure facts, not proof of the earlier
  native click's blocker. Preserve the one public action, owner and every
  existing wait, request-count, version and draft assertion.
  At only `failure-check-again-click`, `checkAgainInterception` may separately
  retain `receiverSlot` and `receiverEndingStyle` from that same original error
  before the existing post-failure observation. The message must be an own
  primitive data value of at most 4096 units, with a recognized interception
  prefix and exactly one explicit receiving-element clause. Decode only its
  single bounded opening tag; quoted values are opaque, attribute names must
  be unique, and self-closing, malformed or ambiguous markup remains null. The
  matching closing tag may follow only the literal ASCII `...` emitted by
  Chrome's serialized receiver. Nested markup, other ellipsis forms and trailing
  tags remain refused; only the existing two header facts leave this decoder.
  The slot is one of the fixed toast slots, the toast-root attribute fingerprint,
  `dialog-popup`, `other`, or null. Ending means the receiving element's own
  `data-ending-style` attribute is present; it says nothing about an ancestor
  or why the toast remains. Inherited/accessor messages and live/revoked proxies
  are refused without invoking their getters or traps. No message, HTML, ID,
  input, style, URL or argument is retained. This optional projection adds no
  DOM read, action, retry or deadline and cannot replace the original error,
  existing observations or joined cleanup. It locates the driver's explicit
  receiver, not a native timer, toast-lifecycle or click-time root cause.
  Full Reload captures the initially imported primary project, thread and route
  from public selected-card markup. The rail changes sidebar presentation only;
  it cannot establish an active chat. After selecting Local, select the same
  bound existing primary card only if its owned route is not already selected,
  then verify that identity before composer/draft work and after replacement.
  Capture the actual presence or absence of the primary session line; an empty
  existing thread has no session or preview and legitimately omits that line.
  Require the same public footprint throughout. Before an inactive-card click,
  use the existing authenticated primary `/api/orchestration/snapshot` read to
  prove exactly one live default thread matches the bound project/thread IDs.
  The HTTP producer uses the declared read model through the shared Rust
  serializers. Match project/thread `id` and thread `projectId`; require the
  explicit `deletedAt`, `archivedAt` and `worktreePath` fields. The populated
  cross-language HTTP fixture defines this public shape. Missing fields and
  legacy persistence-row names refuse proof; add no compatibility aliases.
  The owned fixture initializes Git on `main`. The active chat can synchronize
  its default thread's initially null branch metadata from live Git. Admit only
  null before that synchronization or exactly `main` afterward, with the same
  captured project/thread IDs, default kind and null worktree path. Never infer
  the permitted branch from the response or accept other non-null values.
  Keep raw read values in the page. Its boolean verdict may carry
  one closed witness from that same request: request/parse/list admission,
  finite HTTP status and matching-row counts, and nullable live/default/
  branch/worktree predicate flags. Retain that witness only in `failure.json`
  at the exact `reload-primary-thread-proof` phase, and leave unavailable facts
  null. Preserve `branchNull` and record `expectedBranchMatched` as a separate nullable
  boolean for the fixture's `main` branch; neither field exposes the value.
  Reproject own enumerable data and contain optional observation errors;
  never retain response/input/identity/error/URL/token values or add a request.
  This witness does not establish a past native cause. Missing, duplicated,
  foreign, deleted, archived or failed proof still prevents the click. Refuse
  missing/ambiguous/unbackfilled cards and changed identities; never create a
  thread, fabricate a session, pick another card or mutate renderer stores.
  Binding and snapshot values never enter retained evidence.
  Reload diagnostics similarly identify workspace/primary selection, composer
  readiness, the same-version connection transition, changed-version offer and
  actual replacement document. They add only fixed phase markers: preserve all
  public actions, clock/boot checks, negative observation windows, draft checks
  and existing bounds. An incomplete phase is not proof of a reload defect.
  Before each theme's primary import, measure the content viewport and current
  outer window size, then use the existing desktop window-size correction to
  request a 1280 by 960 content viewport. Require that exact content size to
  settle within the existing owner bound before import; viewport reads retain
  their two-second bound. This is one outer-size correction, with no retry or
  extended deadline. Every retained original PNG must independently decode to
  exactly 1280 by 960 before its existing write-once capture.
  After the original host-path `setValue`, require exactly one current path
  input with the same nonempty WebDriver element identity, the exact owned
  value and native focus before the original single Open project click. Keep
  the existing owner bound, one typing operation and composer wait. Refuse
  mismatched, ambiguous, remounted, unfocused or unreadable input without
  retyping, clicking another control or changing the imported fixture.
  At `primary-import-path-input`, `primary-import-submit` or
  `primary-import-composer`, the existing one failure sample may retain
  `primaryImport` with only closed facts: safe owned page, input cardinality,
  current value matching the expected owned path, actual owning form, submit
  cardinality/disabledness, form absent/idle/pending/ambiguous and composer
  cardinality. Missing, unsafe or malformed facts stay null. The private expected
  path is passed only to that failure sample, compared locally and never retained;
  credential/boot/foreign/query/hash contexts refuse. Exact own data, live/revoked
  proxies, getters and coercive values are handled without exporting raw data.
  Preserve the original input/send/click/composer waits and bounds, and all
  non-primary failure sample arguments. These facts do not prove a submit event
  or command outcome: an idle retained form with no form error can follow a
  typed create/open failure reported as a toast. Absent form and composer presence
  alone do not establish owned project identity. Do not infer a terminal fallback
  or native cause; no native rerun, delay, retry or product repair follows from
  modal presence alone.
  Only a push to `codex/qualify-release-ui` or a manual dispatch starts it; a push
  selects core, and manual dispatch offers core/full. There is no main-branch trigger.
  Neither selection installs software, supplies native host-toast evidence, or
  replaces the final integrated screenshot sweep.

  Each capture's existing viewport witness also requires nonzero, nonhidden
  fixed toast roots to fit within the viewport. This prevents accepting a host
  row while a notification is partly outside the image during entry or exit.
  Hidden or zero-area roots do not block capture. Use the same bounded screenshot
  wait and original six-field receipt; add no sleep, notification mutation or
  relaxed row, modal, identity, credential or image requirement. Source tests
  establish admission behavior; new CI originals are required for visual approval.

  Run this workflow only after independent harness review and the separate
  browser-startup prerequisite. It builds the web source once, copies the guarded
  server/example outside Cargo output and records source/build hashes; it serves
  those web assets with the existing preview configuration. One immutable
  preview server spans both themes; each theme still starts a fresh primary
  backend, browser profile and driver. Do not stop and rebind the preview between
  themes: terminating its launcher need not terminate its listening descendant.
  Final owner and PID1 cleanup still join and verify the whole private scope.
  Its shared Python
  owner admits only a disposable CI PID/network namespace, and its shared browser
  owner enables no performance logging. Keep its private TMPDIR short: Chromium
  adds a branded temporary subdirectory and Unix socket filename within the
  platform pathname limit. The allocated scenario prefix plus random UUID stays
  exclusive and `0700`; workflow run IDs belong in evidence/artifact names, not this
  private root. Prepare the reviewed contained topology
  before any fixture, service or browser admission. Browser state before setup is
  unobserved (`before:null`); each created browser must pass one bounded actual
  online read. No post-launch network mutation, repair, sleep or retry is allowed.
  The network helper validates the exact PID1 argument form for the selected
  qualifier: the ordinary chat form or the UI form with its fixed selector,
  canonical input identities and matching core/full selection. An owner-shape
  refusal precedes all network reads/mutations; preserve that receipt and repair
  the handoff instead of bypassing its ownership checks.
  The browser primary uses `localhost` for both its page and configured HTTP/WS
  target. Its fake host alone opts into the fixed `http://localhost:4901` dev
  origin on port `4887`, with the same dev profile selected by the grant command.
  Provider-disable settings must cover that active `dev` state directory before
  startup, and restarts reuse the configuration. Remote fake hosts remain in
  normal `userdata` mode. Do not widen CORS, rewrite cookies or add a grant-only
  dev URL to repair a pairing failure.
  Pairing, import and theme setup have separate phases. A failure may retain a
  bounded closed setup observation alongside the startup receipt: route/readiness
  categories, control presence/disabled flags and a known pairing-error category.
  Missing observations stay null; presence is not proof of authentication or
  visibility. No input values, URLs, page/error text, credentials or network logs
  are retained, and unavailable diagnostics cannot skip joined cleanup.
  Success preparation also records fixed host-start, Add Server action/read,
  project-import, draft, Settings and first-row-capture phases. These observers
  add no UI action or wait and do not identify a native cause by themselves.
  After that capture, fixed success markers distinguish the first card's
  workspace/capture, row confirmation/idle proof/capture, each row or card
  cancellation/request-count/draft proof, the row's return to the workspace,
  and card confirmation/capture. A retained capture can prove an earlier
  predicate passed even when an older failure phase remains. These markers
  change attribution only; preserve actions, read order, budgets, capture
  guards, original errors and the success/failure verdict.
  Isolate optional preparation-observer exceptions so the original actions
  continue; keep ordinary phase, UI/read and capture failures fail-closed.
  Success-case removal records fixed Settings/menu/confirmation, row-absence,
  child/tunnel cleanup and notification-list/visibility/click phases through the
  existing observer. One existing bounded failure sample may retain a closed
  `successRemoval` snapshot only for those phases on the exact owned origin and
  Remote Servers route, with no query/hash or credential controls and the admitted
  theme. It contains row/notification-close/visible-close/ending-toast count
  categories and removal-dialog presence; missing or unsafe observations remain
  unavailable. Ending-toast counts use distinct ending ancestors of the current
  close controls. These current facts do not prove an earlier target disappeared
  or identify the failed click. Keep the original failure and joined cleanup;
  add no actions, waits, retries, forced clicks or changed notification lifetime.
  Import diagnostics also retain the path control's disabled/busy flag and a
  finite category for the form's existing validation messages. Missing forms are
  unknown; other errors are unclassified. The path value and error text never
  leave the page, and these failure-only reads do not resubmit the form.
  Each action waits for its displayed target and the pinned WebDriverIO public
  clickability check under the existing readiness bounds, then invokes the existing
  public click command once. A displayed, enabled control may still be covered by a transient toast;
  it must not be clicked through an overlay. A persistent obstruction fails before
  dispatch, and a rejected click command is not retried by the qualifier. The pinned
  driver's existing internal scroll/interception fallback is unchanged; this is
  not a claim of one wire-level attempt. Keep toast
  lifetime and modal behavior unchanged, with separate Dismiss and Check phases
  for the final failure/retry flow. Do not force clicks, remove overlays, or close
  notifications merely to make the test pass.
  Remote pairing uses the real Add Server
  flow through an owned loopback tunnel. The fresh-terminal setup uses genuine
  authenticated public RPC and a pinned owned executable; dialog counts and all
  update actions use the real UI. Reports distinguish that setup from UI terminal
  creation. Manual CLI layouts qualify descriptor kind, visible instructions and
  actual clipboard contents; their install dispatch remains unobserved, and their
  instructions are never executed.
  Manual cases wait for the visible instruction block's running-version marker
  under the existing text-readiness bound before reading and validating its full
  text. Keep all platform/command, row-versus-card, clipboard and absent-install
  assertions. Record fixed per-kind setup/read/copy/capture phases so failures
  do not collapse into one manual stage.
  Manual row copying records displayed, clickable, click, and success-toast
  phases immediately before those existing awaits, without another browser
  read or action. Clipboard comparison remains a separate required step.
  Manual removal keeps its per-kind `remove-host` entry phase and forwards the
  existing removal observer as `manual-archive/package/unknown-remove-<operation>`.
  Those fixed phases identify the existing Settings/menu/confirmation, row-absence,
  child/tunnel joins and toast boundaries without another read, action or budget.
  The retry/dismiss flow also records the six existing import-helper boundaries as
  `failure-primary-import-workspace/menu/path-mode/path-input/submit/composer`.
  These fixed phases reuse the helper's optional observer; they add no browser
  read, action, wait or budget. After import succeeds, restore the original
  `failure-retry-dismiss` phase. A last marker identifies the attempted boundary,
  not a unique timeout cause or evidence that the operation completed.
  At exactly the per-kind `toast-list`, `toast-displayed`, `toast-clickable`, or
  `toast-click` removal phase, the same existing bounded failure sample may retain
  `manualRemoval` with the six closed removal-snapshot fields. Compare only the
  fixed owned manual row label locally on the exact Remote Servers origin, route
  and theme, with no query/hash or credential controls. Missing, unsafe, malformed,
  accessor or proxy-backed observations remain null. Failure of this optional
  manual snapshot preserves the other existing sample fields. Visible-close counts
  describe the existing current box/style checks; they do not substitute for the
  pinned SDK's visibility or clickability checks. A last visibility marker can also
  precede an owner failure after earlier controls remained visible and unclickable.
  These facts do not identify a failed operation or prove earlier absence. Preserve
  the original actions, owner loop, error, budgets, verdict and joined cleanup;
  add no requests, waits, retries or notification recovery.
  A failure receipt may contain only an
  allowlisted manual assertion code registered by that controller's own check;
  errors from the browser, arbitrary check strings, exception text and copied
  commands must never supply that field. Missing ownership remains null.
  Toast removal additionally records fixed recognition and existing recheck phases:
  message inspection/unavailable/unrecognized/matched, fresh-list lookup, visibility
  read, visible-replacement refusal, or confirmed-empty completion. These markers
  add no lookup, request, retry, deadline or recovery. A later empty snapshot cannot
  prove the earlier recheck succeeded; preserve the original click error on refusal.
  At exactly `success-remove-toast-click-unrecognized`, the existing failure receipt
  may include `toastErrorSignature` associated with that same thrown error object.
  The same owned signature is admitted at exactly
  `manual-archive-remove-toast-click-unrecognized`,
  `manual-package-remove-toast-click-unrecognized`, or
  `manual-unknown-remove-toast-click-unrecognized`. Retrieval uses the existing
  error-keyed WeakMap; it adds no message inspection or browser observation.
  It contains only wrapper/canonical-message family, exact click-POST suffix,
  argument-suffix shape, a coarse length bucket, exact toast-selector presence and
  an own-data name family. Three additional closed fields identify a fixed SDK
  template prefix, an allowlisted implicit command, and a recognized wait condition.
  These categories describe the message shape; they do not identify its native cause
  or admit recovery. Inspect at most 4096 message units; longer suffix/selector and
  SDK-category facts remain null. Missing/accessor/proxy metadata stays unavailable, and no raw
  message, name, selector, ID, URL or arguments leave the qualifier. Matched errors
  and unrelated phases/errors supply no signature. This failure-only classification
  adds no UI read, request, write, action, timer or recovery; it qualifies string
  shape, never the native cause or a successful absence recheck.

  For the full Reload negative control, observe the primary rail connected,
  then disconnected and connected again around the same-version restart, with a
  new server boot, before starting the unchanged ten-second no-prompt window.
  Missing/stale browser state or Node-only reachability cannot satisfy it. Keep
  that transition within the existing thirty-second bound, and record its closed
  transition receipt separately from the duration of the negative window.

  Retain only the workflow's finite screenshot names and closed JSON evidence.
  Each original image requires actual theme, selected environment, expected text,
  unobstructed visible target, nonblank PNG and no credential control or URL.

  For the exact `dismissed` scene, that same read also requires exactly one
  Check button, one button with the expected update label and one Disconnect
  button inside the owned row. Each must be enabled and visible through its
  ancestors, with finite positive own rectangles fully inside the viewport. Test
  an interior grid at one-quarter, one-half and three-quarters of each own
  rectangle and require the button or its descendant to receive each hit. Those
  points stay inside rounded controls; bounding-box corner points can fall outside
  their painted hit area. Reject any overlap with a visible fixed
  toast root rectangle even when that toast is pointer-transparent. A clear row
  container alone cannot prove that its right-side actions are inspectable.
  Keep the original six-field witness and extend only `targetInView`; pass the
  fixed scene through the existing single two-second DOM read. Other scenes keep
  their existing admission. Preserve the existing pointer move, thirty-second
  capture wait with 250ms polling, original actions, deadlines, PNG validation,
  write-once originals and joined cleanup. The same wait may observe normal
  notification ending; do not close toasts, change their lifetime, move controls,
  add sleeps/actions/reads, mutate product state or relax the owner bound to make
  an original pass. Persistent obstruction remains a bounded qualification
  failure. Inert source tests establish admission logic; new original CI pixels
  and independent inspection are required for visual approval.

  Inspect the original images before accepting visual quality. Shared cleanup
  joins the browser, proxies and children; PID1 then reaps descendants. The
  private fixture is deleted only after both owners report joined cleanup. Require
  unchanged build inputs, zero guard refusals, no namespace survivors and unchanged
  host network identity. Keep partial/failure evidence honest; no retained raw logs,
  profiles, tokens, requester identities or fabricated zero install counts.

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
- provider settings and action menus show Claude, Codex, Cursor, and OpenCode
  without Early Access labels and omit Grok/Grok Terminal;
- text rendering: body text in the sidebar and transcript shows no uneven
  whole-pixel letter gaps, including when the session hinting is `full` (the
  host pins `hintslight`); in a screenshot crop enlarged to 300%, text in the
  sidebar, transcript, settings column, and Agents list shows colored fringes
  at glyph edges like the window title (LCD subpixel text) rather than
  gray-only edges; and the sidebar and timeline have no top or bottom scroll
  fade, which is expected on Linux only;
- AppImage window identity, icon, launcher, and taskbar grouping are correct;
- external worktree grouping, paths, actions, physical identity, and restart
  are correct;
- sidebar menus: right-click a worktree card, the primary card and a project
  header, and open the header's **⋯** from the keyboard (Tab to it, then
  **Enter**). Each native menu separates Open in/Pull, the copy actions,
  Pin/Unread/Rename and the destructive item, with no doubled separator before
  **Delete Worktree…** or **Remove Project…**, and **⋯** shows the same items
  as the header's right-click menu. Tab to a card and press **Shift+F10**
  (and, on Linux, the **Menu** key): exactly one native menu opens at the card,
  and no error toast reports a second menu;
- thread switching, terminal I/O, Activity elapsed time, keyboard focus, and
  responsive overlays work, including reopening the global right panel after
  a sibling chat suppresses a previously active Activity surface; and
- repeated loaded interaction does not freeze, duplicate events, or grow an
  unbounded process tree.

Capture original-resolution screenshots plus focused crops and keep diagnostic
frames separate from acceptance evidence.

### Controlled delivery Retry interaction

The CI-only `delivery-retry-ui` selection in `scripts/qualify-chat-uploads.py`
uses the guarded real CLI, immutable web assets and an opt-in fake Claude. It
shares the reviewed private namespace, browser options and joined resource
owner; it is not a local desktop command. Its fixed payload contains the web
directory without an unused update-fake-host argument. Private fixture roots
use a short case prefix plus the complete UUID, with exclusive `0700` creation;
run IDs remain in evidence paths, keeping Chromium's branded and unbranded
Unix socket names within their limit.

For delivery Retry and release visual batches, a failure in the existing
`browser` phase records `browserReadinessStage`: `driver-readiness`,
`session-create`, or `online-proof`. These are the existing await boundaries;
the phase alone cannot identify which one failed. `browserDriverReadiness`
contains only closed facts from the existing driver `/status` polls: attempt
count capped at 1024 plus a cap flag, the last observed HTTP status category,
boolean-or-unknown parsed readiness, body-decode category, failure stage and
finite error class, and existing driver exit/spawn flags. Missing or malformed
metadata stays unknown. The last HTTP category may precede a later fetch failure,
and a successful status receipt can accompany a session or online-proof failure.
Optional observation errors cannot change the readiness predicate, original
failure, launch options, request count, waits or cleanup. No response body,
request URL, error text or driver log enters these receipts; preserve an unknown
cause until the closed evidence identifies a boundary. Other failure phases
retain null for both fields.

The same `browser` failure receipt also contains `browserSessionObservation`,
an exact four-boolean packet: `protocolClientCreated`, `remoteReturned`,
`alertBindingAttempted`, and `alertBindingCompleted`. The installed SDK's passive
client modifier records construction after the session handshake and returns
the identical client without reading it. The other facts come from the existing
remote await and alert-binding call boundaries. A constructed client with no
remote return narrows the failure to SDK post-handshake initialization; a remote
return without completed alert binding narrows it to that binding. These facts
add no request, client property or body read, timer, retry or changed launch option.
Missing, malformed, accessor, proxy or extra-field metadata stays unknown; other
failure phases retain null. The facts distinguish a boundary and do not name a
runtime cause or admit a visual original. Optional observer errors preserve
successful startup and the original failure and deadlines.

In each theme, the driver pairs and imports through the public UI, then creates
and selects a genuine managed worktree through **New worktree**. Its configured
worktree base stays inside the private fixture. Bind the selected card's public
thread/branch/title and worktree tooltip to one registered, non-primary Git
worktree with the same reachable common directory. Read Git with the pinned
fixture executable, private HOME, disabled system/global settings, bounded output
and joined synchronous commands; never retain paths, IDs or Git output.
The workflow's explicit helper gate includes `delivery-retry-workspace.test.ts`
for real disposable Git identity/refusal and restoration controls.

After selecting the exact Claude model on that worktree, complete a baseline
message and arm one withheld provider acknowledgement. Rename only the validated
managed worktree, keeping the project and common Git directory available. Require
the selected card's actual missing-registered notice and the original message's
Delivery uncertain state within the existing bound. Restore on success or failure;
verify the same selected card and Git identity recover before Retry. Moving the
primary repository root cannot substitute: default threads have no adopted
worktree path, and losing the only Git anchor degrades catalog scans instead of
authorizing workspace-loss teardown. The ordinary fixture is
unchanged unless `BIBCODE_E2E_CLAUDE_RETRY=1` is explicitly set. Its private
receipts distinguish fresh/resumed launches and the received/withheld input.

Import selects the exact Claude `opus` model row and waits for the trigger's
accessible provider-and-model label before sending the baseline. The visible
model name alone does not identify the provider. Closed `import-*` phase codes
identify the last attempted UI boundary without retaining workspace paths,
page text, credentials or raw errors; provider receipt assertions still apply.
The same model selection is repeated on the created worktree. Fixed `worktree-*`
and `workspace-*` phases locate preparation, identity, loss and recovery failures.
Closed successful receipts distinguish managed selection, matching Git identity,
preserved primary anchor, observed catalog loss and restoration; they do not
replace the actual Retry/draft/new-conversation acceptance below.

Pairing and theme changes also record literal subphases before each action or
read. If either fails, one read-only observation may take up to two seconds;
it records only known route/readiness enums and booleans for the form,
connection and theme controls. An unexpected origin, query or fragment stops
DOM inspection. Missing, malformed or late observations remain unknown and
cannot replace the original failure or skip joined cleanup. These facts are
failure diagnostics, not authentication or screenshot acceptance evidence.

An `import-*` failure may take one similarly bounded two-second read-only sample
in `importObservation`. It checks the fixed owned origin before DOM inspection
and retains only a route category, Add Project modal/path/submit presence and
disabled flags, modal/composer visibility with finite viewport geometry, primary
card count category and selected boolean, and a closed error category. Only exact
known Add Project validation/status copy, workspace alert titles and add/open
failure toast titles are classified; toast/workspace descriptions, input values
and card text stay unread. Error categories are `host-loading`, `path-invalid`,
`workspace-unavailable`, `other` or unknown. This is a current failure sample,
not proof that the earlier submit was disabled or that a project/card was opened.
Other phases retain null; unknown/malformed/throwing or late diagnostics cannot
replace the original error, change the normal UI sequence, or skip joined cleanup.

Worktree opening follows the existing public keyboard route: send real Tab
keys within the normal action bound until the unique **New worktree** button
reports focus, wait for it to be displayed and enabled, recheck uniqueness and
focus, then send Enter once. The header's focus-within action strip is independent
of hover capability. Do not assign DOM focus, synthesize a click, force visibility
or infer a runner's hover capability from a hovered header. Project/dialog/name,
selected-card and Git identity assertions remain mandatory.

Separate control-count, focus-search, displayed, enabled, focus-confirmation
and Enter phases identify opening failures. A failure in those phases may take one
two-second, location-guarded read-only sample: a finite control-count category
and boolean-or-unknown header/button visibility, hover, enabled and hit-target
facts, plus dialog/model-picker visibility. These are current DOM samples,
not the result of an earlier WebDriver command. Missing controls or unsupported
visibility observations remain unknown. No paths, IDs, coordinates, text,
input values, URLs or screenshots are retained; late samples cannot republish
after failure or alter cleanup. The normal action and outer qualification bounds
remain unchanged.

The Retry button must open the real browser confirmation. Read its exact copy
through WebDriver's alert API, dismiss once and prove no new input/launch, then
click again and accept. Do not replace `window.confirm`, call a private handler
or send the retry RPC directly. No DOM or screenshot command runs while the
prompt is open. The same public message row/text and unsent draft must survive;
one fresh no-resume launch and the exact quiet new-conversation notice establish
the accepted retry. The controller records the actual bounded no-resend window,
not a claim about every future moment.

Retain only the six declared uncertain/cancelled/delivered PNGs, their closed
capture proofs and source/input/cleanup receipts. Pairing material, profiles,
provider/session IDs, raw logs and protocol bodies stay outside the artifact
allowlist. Inspect original pixels in both themes. Browser interaction does
not qualify Tauri's native dialog, and this focused lane is not the final
merged-tree screenshot sweep. A pass also requires supervisor/namespace cleanup
and unchanged input hashes; the inner result alone is insufficient. Failed
cleanup preserves private files until owned processes have been reaped.

### First release visual batch

The manual-only `qualify-release-visuals.yml` preparation lane selects
`release-visual-core` through the same Python owner and real-server controller
as delivery Retry. It retains the existing 600-second inner and 660-second
outer bounds. Compile inputs beforehand. Do not add further scenes or widen
those bounds to make this batch pass. The image original uses its already-approved
scene; the full 82-scene/164-original obligation remains unchanged.

The fixed output is nine light/dark pairs: `workspace-composite`,
`workspace-card-menu`, `worktree-create-ref`, `git-image-diff`, `git-changes-diff`,
`git-history-stashes`, `git-branch-menu`, `files-editor-comment`, and
`command-palette`. Root must assemble and independently approve the immutable
release source before treating a later run as final-source evidence. This lane
has no automatic push trigger; a preparation result does not qualify the full
release matrix, Playwright, or Tauri/native dialogs.

Each theme uses the existing real pairing, public project import, exact Claude
model selection, and managed-worktree create/select/tooltip/Git identity
checks. The same keyboard worktree opener serves the create-ref preview; its
real dialog selects an occupied controlled ref and is cancelled. Missing
selection or Git identity remains a failure. Initial binding requires the
distinct human-readable title, visible exact branch description, selected card
and matching local route; subsequent reads require the captured immutable card
ID even after the provider changes its title. The real `tooltip-popup` must show
the verified worktree path hint. Never replace these checks with renderer stores,
a synthetic click, or a primary-checkout substitute.

Before branch-menu capture, type the fixed branch filter and require the real
remote-checkout row. Clear the unique displayed/enabled Filter branches input
through the same focused-control keyboard clear as Worktree name: prove active
focus and stable identity, select with Control+A, recheck uniqueness, focus and
identity, then press Backspace. Before advancing Tab focus, require the public
current-branch indicator to reappear within the existing owner focus bound.
Focus the unique displayed/enabled occupied branch row's main button by Tab,
then recheck its identity, focus and current-branch readiness. Do not activate
Switch to worktree. Keep the existing row hover and unchanged capture witness:
current local branch, remote checkout row, occupied worktree action, and visible
rename/delete controls are all required. The component's existing focus-within
rule exposes those controls even when their mutation actions are disabled.
Inert endpoint regressions cover actual controlled state and keyboard focus;
installed Tailwind compilation verifies the actual CSS rule. HappyDOM does not
implement focus-within visibility, so native CI must prove the gesture and
pixels. No capture predicate or request bound is relaxed. Independently inspect
the two footer actions as well: their bounded button and label spans use ellipsis
for long branch instructions while retaining full accessible text and disabled
explanations. Do not accept text clipped by the popup viewport, widen the window,
or infer visual approval from a successful capture witness. Compiled CSS/source
regressions establish the containment policy; fresh CI originals establish pixels.

After the branch-menu original, send Escape and require the public branch
popup to become undisplayed before selecting the managed card or opening Files.
Identify its fixed Branches content and exclude hidden ancestors so an unrelated
keep-mounted hidden popup cannot satisfy the proof. Use the existing reverse-
display wait with its existing SDK wait bound. Escape completion alone does not
admit the next interaction. The real BaseUI popup may remain mounted through
close settlement; its ending positioner is inert, so that lifecycle observation
alone does not prove an intercepted native click. Git Manager is a project
page, with no required Back or Close action before sidebar navigation. Return
through the unique managed card's standard keyboard activation: use ordinary
Tab under the existing focus owner, require displayed/enabled control, unique
card and active focus, then press Enter. Retain the existing selected-thread
route and owned-worktree identity proof before opening Files. The card's visible
content intentionally includes pointer-enabled siblings above its button;
WebDriver center-click admission cannot assume those siblings are button
descendants. Never force a click or change the card's product layout. A mounted
real-card/actual-caller regression and pinned SDK with inert geometry establish
this supported interaction contract; they do not identify the native covering
node or establish native capture success. Keep fixed phase attribution for
card focus/Enter and the remaining Files control waits/clicks, owned identity, panel visibility,
tree entries, line and comment draft. Phase labels export no selector, path,
text or identity and add no action, browser read, retry or time budget. A failed
close proof stops before Files, while existing click/read exceptions propagate
unchanged. Native CI still must establish the specific failure control and
subsequent capture success.

The card-menu scene requires a genuine no-editor fixture before server
admission. Only this selector removes the ordinary fixture's exact generated
`cursor` editor launcher; the default fixture retains it, and `cursor-agent`,
Claude and all other provider bytes and the actual server PATH remain intact.
Provider disablement does not change editor inventory. Home must focus the
disabled Open in row with its visible **No local opener is available for this
workspace.** explanation, alongside the grouped Pull and Copy Branch Name
actions. Any other real opener, including a host Zed installation found outside
PATH, leaves Open in enabled and refuses this scene. Do not hide candidates or
substitute a different disabled reason to pass; that runner needs a separately
approved truthful fixture.

Before server admission, seed only the new clean private repository: Pierre
text fixtures, nested source, two small PNG input swatches, local branches/tag,
one discovered worktree, a private bare origin and twelve real stashes. Git
commands use the pinned executable, private HOME, disabled system/global Git
configuration and hooks, five-second command bounds and 64 KiB output caps.
Reject pre-existing/dirty or aliased seed paths; retained evidence never includes
Git output or fixture paths. After the managed worktree identity is verified,
write only its controlled text/image changes. Public partial staging must put
exactly the first text hunk in the index while retaining the other two in the
working tree.

The baseline commit has one owned image-only parent so its PNG exists on both
sides as different valid 64 by 64 swatches. Keep the baseline bytes, subject,
tag, branch identities and stash inventory unchanged; never manufacture this
history in a real repository.

The browser uses public keyboard, pointer, scroll, input and menu actions.
The Files scene opens its real nested file and adds a line comment through the
editor's public line-number gutter selection. The existing selection-end callback
creates the local draft; a generic JS click alone does not prove that gesture.
For line one, the actual range formatter yields `L1`, so wait for the real
textarea labelled `Comment on lines L1` before entering the fixed review text
and pressing Comment. Keep the ordinary gutter action, input/submit sequence,
owner bounds and original capture guards. The pinned file viewer, real panel
callbacks, mounted annotation and SDK/fake-endpoint regression establish source
behavior; native gesture delivery and the resulting PNG still need CI evidence.
The palette filters to and highlights Open settings without executing it. In Changes, select the working-tree PNG and require the owned
image row, visible diff pane and disabled empty partial-staging gutter; that
binary representation does not provide an image preview. Use public History
controls to select the baseline commit and its PNG, then select the actual 2-up
mode and capture `git-image-diff` before returning to Changes for text partial
staging. Both distinct repository PNGs must be loaded at natural 64 by 64 size
and each rendered preview must occupy at least 64 by 64 CSS pixels; loaded
metadata and a nonzero one-pixel box do not qualify an inspectable preview.
Before/After figures, captions and all four mode controls must be contained and
visible, with 2-up uniquely pressed. Rejoin the local route/header/project,
connected selected rail, owned managed card and selected worktree/branch/theme.
Missing, ambiguous, clipped, hidden, credential or boot controls refuse admission.
The source checker reuses the existing immutable owned Git identity instead of
a chat-route substitute, before public image actions and after both outcomes.
The shared original owner requires that same source checker before its existing
capture polling and after screenshot, before retaining bytes. It keeps the
ordinary witness/alert/nonblank/1280 by 960/post-read/write-once PNG checks. No
renderer store, canonical event, state, CSS or viewport is injected to favor an
original. The genuine fixture swatches are source inputs, never screenshots.
Selecting the baseline commit again for the later History capture resets
selection to its first changed file; its old witness remains unchanged. Files
context menu and workspace terminal/other-chat remain unpictured and unqualified.

Require the exact 1280 by 960 viewport and every scene's current read-only
witness, in addition to the selected environment/workspace, real theme, visible
unobstructed target, absent credential/boot controls and a nonblank original PNG.
Recheck the witness after the screenshot returns before retaining its unchanged
bytes. Missing, duplicated, stale, unknown or failed facts refuse capture;
there is no screenshot fallback. Only the eighteen named PNGs and seven closed
JSON receipt files enter the artifact allowlist. Inspect the originals
independently before accepting visual quality. No private logs, provider inputs,
credentials or profiles are retained.

Before the palette's single ArrowDown, the owner waits within its existing
polling bound for one palette and one displayed `Open settings` result, with
the search input still focused and its value equal to `settings`. The query
updates before the deferred result collection, so typing alone does not prove
that keyboard navigation will target the filtered collection. Failed reads or
readiness refuse navigation and capture; no extra key, sleep, retry, deadline
extension, or relaxed highlighted-row witness is permitted. The component/SDK
ordering replay covers this preparation seam; the CI original pixels and
post-capture witness still supply the actual browser qualification.

At exactly `visual-git-branch-menu` or `visual-command-palette`, the existing
failure receipt may retain `coreCaptureFailureFacts` from the last witness already
returned by the capture's existing polling or post-screenshot read. It adds no
browser/RPC read, action, timer, deadline, retry or capture fallback. Each scene's
fixed ten booleans retain false scene/text/geometry facts only when theme,
selected context, credential
absence and boot absence remain safe. Before reflection, native Node proxy
checks reject live or revoked witnesses, ownership and association inputs;
accessors, inherited/missing/extra keys, malformed data and reflection faults
remain unavailable (`null`). Bind the observer to the current source and the
existing verified managed thread/branch/theme; rejoin those private facts before
retaining only fixed scene/theme and witness booleans. Only that actual capture
failure's original error object owns its snapshot. Before any returned witness,
after unsafe latest facts or without matching identity, facts remain null.
Observer faults preserve the original exception and joined cleanup. These facts
describe the last returned sample, do not approve a screenshot, and do not prove
which native event or layout caused an earlier wait to fail.

If the exact create-ref capture fails, `failure.json` additionally records
`createRefObservation`: one read of the same twelve closed witness booleans,
bounded to two seconds before cleanup. False facts identify unmet predicates;
unavailable, malformed or extra fields remain unknown (`null`). This observation
never approves a screenshot and retains no page text, input, path, URL or driver
error. Other phases do not perform this read.

At only `visual-partial-stage-text-row-displayed`, `failure.json` additionally
records `textRowObservation`: one failure-only DOM sample bounded to two seconds
using the theme, origin, thread and branch already verified by the core managed
worktree callback. The safe local Git route, empty query/hash, exact toolbar
ownership and absent credential controls are checked before reading rows. The
Changes tab's ARIA relation locates its active panel locally without retaining
its ID. Closed facts report Changes active, capped global/scoped fixture text-row
counts, first-match visibility, active Changes listbox presence/positive size/
visibility, and known empty/loading/error/filter presence. They retain no text,
values, names, paths, IDs, URLs, HTML or driver errors. Unsafe, unavailable or
malformed observations remain `null`; failures in this sample cannot replace
the original wait failure, approve capture, alter recovery or delay joined
cleanup beyond the single bound. These facts describe the later sample, not
the state at the earlier failed wait.

The same sample additionally records optional `layout` facts, never capture
approval: capped named-listbox cardinality; separate positive-width/height facts
for that list, its ARIA-owned panel and unique Changes section; a fixed blocking-
ancestor category; diff/Commit presence; and whether measured direct-flow box
heights, margins and gap exhaust the section's available content height. Raw
sizes, CSS strings, text, IDs, paths, HTML, errors and URLs are never retained.
Only the unique owned direct-parent/sibling structure is measured. New layout
inspection is bounded to eight direct children and twenty-four ancestors;
unknown, ambiguous, invalid or exceptional optional measurements remain null.
Nonflow children are excluded, and unsupported flow such as display:contents
refuses the demand calculation rather than recursively reading descendants.
The original eleven facts and the single failure-only two-second sample remain
unchanged. Synthetic geometry regressions qualify measurement logic, not native
CSS, zero-height diagnosis or a unique cause. Review the current projector schema
and this procedure together when analyzing a failed sample.

The same failure receipt also records `createRefClearObservation`, captured by
one disposable event observer around the existing Worktree name
public keyboard clear. Before selecting text, prove one displayed/enabled name
control and its active focus through ordinary WebDriver actions. Use the pinned
`keys(["Control", "a"])` command, then recheck the same element identity,
unique control and active focus before `keys("Backspace")`. Missing, duplicated,
replaced or unfocused controls refuse deletion; do not use empty `setValue`,
force clicks, renderer state writes or synthetic input dispatch to clear this
controlled field. Only the single name control at the owned local route
is observed; its received `input`/`change` and trusted-event counts saturate at
`none`, `one` or `multiple`, and value reads export only empty-before/after
booleans. Finish removes the listeners before typing Create From. A replaced
control is reported without reading its value. Unsafe locations, unavailable
observations or malformed fields remain `null`; probe failure does not replace
the original command failure or approve capture. Inert endpoint regressions
exercise the installed WDIO command sequence against the mounted controlled
dialog and compare the legacy change-only clear with keyboard deletion, but do
not prove which events native Chrome delivers for the new gesture. Establish
that from this closed native observation before claiming a native correction.

Admission refuses preexisting marker and lifetime-anchor properties. Only an
acknowledged start can finish its exact host-issued observation lifetime; finish
uses its immutable anchor, never a mutable or foreign marker callback. A replaced
marker remains untouched while only the admitted listeners are removed. Element
and listener references are released on finish; one small closed anchor per planned
clear remains until the existing owned browser teardown. The lifetime identifier
never enters retained receipts or logs. A throwing diagnostic callback cannot
interrupt the existing input sequence or replace its original clear failure.

As for delivery Retry, acceptance requires the outer input hashes unchanged,
zero guard refusals, joined browser/server cleanup, no namespace survivors and
the unchanged host network identity. The private fixture is deleted only after
both owners prove joined cleanup. A partial or failed run records only the
captures it actually completed and keeps its failure classification; it cannot
claim all nine pairs from the manifest alone.

### Settings release visual batch

The same manual-only `qualify-release-visuals.yml` offers the fixed
`release-visual-settings` choice separately from its default
`release-visual-core`. It uses the same real-server controller, Python namespace
owner, browser profile, pairing, public theme/import/Claude model selection and
one managed-worktree creator per theme. The core selection now has its fixed nine pairs/eighteen filenames; its
600/660-second bounds remain unchanged. Settings uses those
same bounds for exactly four pairs: `model-picker`, `settings-keybindings`,
`settings-source-control`, and `settings-provider-form`. Never append these
scenes to the nine-scene core sequence or widen its deadline.

Compile the guarded CLI and UI before admission. The settings preflight joins
the existing owner's `provenance.json` source/default-Abort/server hash to the
actual canonical, regular, executable immutable binary. It also verifies the
private fixture directories and generated Claude launcher/marker files, exact
owned PATH/private HOME and known disabled/missing configuration before writing
only the returned private settings. Positive filesystem/guard facts must come
from this preflight; do not manufacture flags or use host providers. Its Claude
form uses literal `claude`, empty home/launch fields and no environment values;
the owned missing Cursor path supports an unavailable instance. Default fixture
modes and provider resolver/guard behavior are unchanged.

The shared creator proves the real selected card, branch/path tooltip and Git
identity once before the ordinary baseline. Require exact 1280x960 and retain
`Owned visual review draft` and Claude/Opus selection. The model picker shows
the current ready-model list/search/favorite controls. Keybindings opens the
public filtered condition editor and cancels its unsaved new row. Source
Control observes real Git version/availability, explained unavailable
GitHub/GitLab indicators and an expanded fetch interval after discovery settles.
Readonly availability requires native `disabled` or exact public
`aria-disabled="true"`. Base UI switch roots use the latter; a data marker,
muted style or disabled-looking text alone is not readonly evidence. Preserve
the exact checked states and existing full geometry/identity/credential fences.
At only `visual-settings-source-control` or `visual-settings-provider-form`, the
existing failure receipt may include
`settingsCaptureFailureFacts` for that same thrown error and current scene/theme.
The provider form retains its existing `nonSecretFieldsVisible`,
`ownedConfigOnly`, `modelsVisible`, `modelControlsVisible` and `accountsRedacted`
booleans alongside the unchanged common facts. `modelsCustomFieldInView` and
`modelsCustomFieldReady` retain the original in-view and empty-input conjunctions.
The same existing selector, box and style reads additionally retain ordered
`Present`, `Visible`, `ViewportContained` and `AncestorsContained` boolean prefixes
for `binaryField`, `modelsCustomField` and `modelOrderControl`. Presence means an
existing selector found a node; visible means the unique matching node passed
its own visibility checks, and fields also require the original input type.
With visible true, viewport false identifies failed viewport containment. With
viewport true, ancestors false identifies failed ancestor containment. A later
false prefix does not claim its checks ran after an earlier failure. These facts
cannot distinguish an ambiguous, wrong-kind or hidden node by themselves.
Binary prefixes do not add home/launch-field reads. Custom ready false after
in-view true identifies a non-empty input; ready true with models visible false
identifies the existing favorite-control predicate. An unready input adds no
favorite query. No raw value, geometry, style or ancestor identity is retained.
Capture admission remains equivalent on the actual reader, not relaxed.
It reuses the latest actual witness from existing capture reads; it adds no DOM
execution or retry. Exact known own-data booleans may retain false scene/text or
geometry facts. Unsafe theme, selection, credential or boot context, malformed or
unavailable data and failed owned-identity checks remain null. No text, values,
IDs, styles, HTML, URLs or credentials are retained. Observer faults preserve the
original capture exception and joined cleanup; facts never approve a capture or
identify its cause, and an earlier valid sample cannot prove the later state.
The two owned provider fields scroll through the pinned SDK fallback's supported
browser execution path, using native `Element.scrollIntoView` with binary-start
and custom-model-end alignment and nearest inline alignment. The pinned desktop
SDK wheel path serializes zero scroll deltas on success and need not perform this
scroll; do not require an action failure to obtain its native fallback. Refuse
foreign route/theme/selection, credential or boot context and ambiguous or missing
owned inputs. Keep the existing before/after outer-page scroll guard and all
one-scene visibility, clipping, identity, nonsecret-config and PNG admission
predicates. The existing binary-field SDK display wait additionally binds the
opened Collapsible panel's public `--collapsible-panel-height: auto` state. The
pinned component publishes it from its actual open-animation completion callback;
input display alone can precede that completion. Keep the same wait command and
configured timeout, then the same two native scroll actions and outer-page guard.
Generated utility CSS and the pinned Web Animations/component regression establish
this lifecycle contract; they do not prove native layout or an attainable field span.

The qualifier does not authenticate, forge, toggle availability or save settings. Providers
is the current `/settings/providers` route, separate from Agents. Expand the
existing Claude card to show actual non-secret fields and model controls.

Keep the hidden Add instance opener hidden. Its computed visibility determines
the closed unsupported diagnostic; a source inventory does not establish Add
wizard pixels. Provider account/status overviews, the Add wizard, Effort/Fast
Mode and Azure/Bitbucket rows stay explicitly unpictured. A blank or hidden
password input still refuses the unchanged credential fence. A clipped,
obstructed, stale or secret form leaves that pair unqualified; there is no
closed-card substitute, gallery or screenshot fallback. Provider form runs
after the other three scenes and any refusal remains fatal.

Every retained PNG passes the full scene witness, immutable private Git identity
on both sides of capture, the existing six common facts and unchanged original
PNG parser. Before writing assertions, project only the fixed boolean/enum
receipts; successful completion requires all eight unique scene/theme files and
both theme assertions. Settings evidence uses the separate
`issue29-settings-<run-id>` producer directory and only its eight named originals
plus the same seven closed JSON receipts. No logs, profiles, credentials,
provider/session IDs or private fixture inputs enter that artifact allowlist.
The outer owner also requires unchanged input hashes, zero guard refusals and
joined namespace/browser/server cleanup before deleting its private fixture.

Inspect all original light/dark images independently and preserve incomplete
substates in the report. A passed preparation lane does not qualify the full
release matrix or native/Tauri behavior. Root must nominate the immutable final
product source separately from the reviewed harness overlay; neither static
tests nor provisional source captures establish final-product pixels. If the
canonical workflow is not registered on the default branch, report that
registration limitation; do not repurpose another live manual workflow without
root approval.

Inspect the Git Manager branch popup footer with a long branch name in both
themes. Its New branch and merge-instruction buttons and label spans must stay
inside the bounded popup and use ellipsis while retaining complete accessible
text and disabled explanations. Reject text clipped by the popup viewport; do
not widen the window to hide a layout failure. Compiled CSS and component
regressions establish the containment policy; fresh native originals establish
pixel quality.

## Contained PR/MR visual preparation

Dispatch `qualify-release-visuals.yml` with the exact
`release-visual-pull-requests` selection from the registered default branch.
The existing visual owner runs the five approved request rows in both themes;
its finite allowlist retains ten base originals and thirty-eight supplementary
originals. Checks/Pipelines, Files changed/Changes, Conversation and activity,
inline/pending drafts, base selection and confirmation, review dismissal,
merge configuration and confirmation, secondary confirmation, retained errors
and confirmation with Undo each require their own existing substate witness.
Inspect every original independently; an intermediate receipt does not prove
an unpictured tab or dialog.

Run this producer only in the workflow's private user/network namespace. It
prepares separate GitHub and GitLab repositories and private bare origins
before the server starts. Before the unchanged desktop context factory runs,
the PR selection exclusively creates each themed root with mode `0700` beneath
the admitted private fixture and verifies its canonical path and current-user
ownership. Existing directories, aliases, foreign ownership or non-private
permissions are refused; the owner never repairs an existing root with `chmod`
or changes the ordinary context factory or process umask. Their exact invalid host remotes resolve only to
those owned local origins through the sealed fixture Git configuration. Owned
`gh`/`glab` protocol executables provide raw source-bound replies to the normal
hosting drivers; they refuse unmatched requests and never forward to a real
hosting executable or account. Create, comment, review and other error scenes
use the owned rejection responses; confirmation scenes cancel, and the one
fixture metadata edit uses ordinary Undo. No real hosting message or request
is sent, and no renderer/store/backend state is injected.

The public import owner selects the original primary context before repository
imports. Every request scene binds the decoded local descriptor, boot/storage
identity and required capabilities, the reconciled `repositoryIdentity`, exact
clean physical Git refs/origin/config and immutable fixture hashes. A separate
Node grant opens one owned typed WebSocket for `pullRequests.getContext` only;
normal UI request traffic stays with the authenticated application client.
Before and after each original, require the current public route/project/host,
all seven closed DOM facts and the unchanged source joins. The original primary
is restored by public navigation and verified before the context socket closes.
The capture owner requires the owned alert observation and original
1280 by 960 nonblank PNG bytes; it does not accept hidden, clipped, obstructed,
foreign or credential-bearing surfaces.

The label edit's Undo runs asynchronously. Clicking its toast does not prove
restoration. The read-only hosting owner pins the original false label state,
sealed source/config/CLI/alias bytes and append-only call-log identity before
public edits. It follows the existing bounded owner wait until the owned label
add and reversal have completed normal process exits and the exact baseline
bytes are restored. It never repeats a mutation or erases fixture state.
Before publishing success and before Python deletion, recheck both themes after
owned processes join: source/theme, private file ownership, unchanged hosting
inputs, completed add/remove records and baseline state must all match their
closed boolean/hash proofs. Missing, failed, cancelled, expired, substituted or
unknown restoration retains the private evidence and permanently refuses
deletion, even if later cleanup or a late Undo restores the bytes.

The contained command is:

```sh
python3 -B scripts/qualify-chat-uploads.py --scenario release-visual-pull-requests
```

The controller and outer supervisor retain the existing 600/660 second bounds
and thirty-second owner waits. Evidence uses `issue29-pull-requests-<run-id>` and
only the seven closed JSON receipts plus the forty-eight exact original names
listed in the workflow. No logs, profiles, host replies, credentials or private
fixture inputs enter the artifact. Any source, API-close, restoration or process
cleanup failure monotonically refuses fixture deletion. Delete only after
successful source joins, zero guard refusals, unchanged immutable inputs and
joined controller/supervisor/namespace/browser/server cleanup. A preparation
pass still requires independent original pixel review and does not establish
native/Tauri or full-matrix acceptance.

## Process-group cleanup

Capture PID, PPID, process group, start time, executable, and command line for
scoped AppImage, desktop, server, provider, terminal, WebDriver, Xvfb, and
fixture processes. Confirm cancellation and shutdown converge on bounded
terminate/wait/reap, late descendants cannot escape after a natural root exit,
peer runtimes remain alive, and no run-owned process survives.

Run a terminal command that exits immediately, then close its terminal after
observing completion. Also close while the command is finishing. Both paths
must complete without an exit-wait timeout or a surviving process. The native
PTY regression covers exit before any subscriber exists and verifies that a
late subscriber receives the retained completion.

Remove only exact fixture, profile, artifact, and evidence roots created by the
run. Report pre-existing processes or temporary roots without terminating or
deleting them.

## Windows and macOS compatibility audit

Audit that Linux fixes do not leak `/proc`, POSIX signals, Unix permissions,
shell syntax, or Linux-only paths into unguarded Windows/macOS code, and that
Linux-only CSS stays inside the `html[data-linux-webkit]` scope. Confirm
Windows native identity/Jobs/WSL contracts and macOS bundle/path/process-group
contracts remain present in host-independent tests. Report the result as
compatibility evidence only.

## Report and cleanup

Complete [the execution report template](./execution-report-template.md), then
perform the shared cleanup and final Git audit. Include distribution, display
protocol, the app's verified GTK backend and override, monitor and GTK scaling,
AppImage execution mode, unsupported host differences, screenshot
paths, zero-survivor evidence, and whether anything was pushed.

## Git and project visual preparation

The same manual-only `qualify-release-visuals.yml` offers the fixed
`release-visual-git-project` selection through the existing guarded CLI/server,
private PID/network owner and current-source web build. Core remains the default;
core and settings keep their existing commands, assertions and budgets. The
Git/project selection uses the existing per-theme private run root and HOME,
with one newly admitted fixture recipe before the server starts. Local tests
use inert Git/browser/owner/HTTP ports; they do not run this recipe or launch the
qualification runtime. Run the Git/project helper and fixture tests alongside
the shared controller/owner and wrapper admission tests before a native trial.

For this selection only, public import waits for the composer, then runs the
caller's existing typed snapshot/default-thread binding before selecting Claude
Opus. Reuse the exact primary-card click and server/snapshot/source/public-route
admission at that boundary; do not duplicate their RPCs or actions after model
selection. The source-derived primary composer surface is `chat:host`;
`chat:<thread-id>` is a sibling surface and cannot stand in for the default
thread. Other core/settings/delivery import actions retain their existing order.

Each controlled Changes, History, or Tags tab reports its displayed, uniqueness,
enabled, click, and completed awaits. A later failure therefore does not inherit
the import's model-verification phase after a successful tab click. Optional
reporting failures preserve the original command and outcome. Only a failure
at one of those exact click phases may add `gitProjectTabInterception`: the
fixed tab name, receiving-slot enum, and receiving element's own ending-style
boolean decoded from the original error. No raw error, markup, identifier, new
DOM/RPC read, action, delay, retry, or cause verdict is retained. Unknown or
unsafe error data remains null; this attribution never qualifies an original.

Only a failed existing Changes, History or Tags click may also retain
`gitProjectTabFailureFacts` from one two-second failure-only browser read. Reuse
the already verified selected project/thread binding and require the exact
origin, Git Manager project route, theme, unique visible primary card, matching
Git environment/project header and checkout title, connected Local rail and
credential absence. Retain only tab cardinality (`none`/`one`/`many`), nullable visibility,
enabled, viewport, hit and selected-state flags, plus a fixed receiving-slot enum
and its own ending-style flag. No values, names, markup, identifiers, paths,
coordinates or raw errors leave the read. Project only exact own data fields;
proxy/accessor/malformed/unavailable/late samples remain null. Associate the
sample with the original error and exact tab, clearing stale reused-error data.
The original exception, public actions, waits and joined cleanup remain unchanged.
These facts describe the sampled state and cannot identify a cause or qualify
pixels. The manual workflow includes the closest observer test in its existing
Git helper gate; new CI receipts still require independent inspection.

The switch-with-changes original also requires `dialogSettled`: neither starting
nor ending style is present, and the popup's own Web Animations samples are
finished or idle with no pending animation. Unknown, missing, or failed samples
refuse capture. This read is part of the existing witness polling; no sleep,
extra navigation, retry, or wider deadline is introduced. A visible dialog can
still be between presentation frames, so geometry alone cannot establish a
steady original. Component tests qualify this admission check; independently
review the CI original to establish actual paint quality.

At `import-verify-claude-opus`, the existing single bounded `importObservation`
read may also retain `modelFacts` from that private binding. Exact route,
selected project card, local rail, primary host/form and trigger must join;
pairing-token/password/one-time-code/pairing-URI controls refuse these new facts.
They contain only nullable `expectedTriggerLabel`, `triggerDisabled`,
`desiredOptionSelected` and `desiredOptionDisabled` booleans. Option facts require
the trigger's unique currently visible controlled popup; closed, missing or
ambiguous selection/disabled metadata remains null. A displayed label never
proves the selected model or provider readiness. IDs, labels, reasons, HTML,
credentials and private snapshot/source payloads stay out of receipts. These
facts cannot replace the original failure or joined cleanup, or approve pixels.

The exact owned private Git executable runs with a non-shell five-second bound,
64 KiB output cap, isolated HOME/PATH/global/system configuration, noninteractive
prompts, disabled hooks/fsmonitor and fixed fixture commit identity. Every short
Git command returns reaped. The fixture contains real private rich/merge/unborn,
ordinary-directory and recoverable broken-config cases, a bare origin, an
external discovered worktree and a retained incomplete clone destination. The
owned nested directory contains the real `Open nested` entry required by the
strict directory witness. None of these files substitutes for rendered product
state or screenshot evidence. That reader requires the unique folder-row button
inside the current Add Project dialog, identified by its existing direct
`data-directory-folder-icon` child. The current directory's same-label breadcrumb
is a distinct public control; it cannot substitute for the required child folder.
The Add Project browser's confirmation action is `Open project`; require that
actual control rather than the standalone directory browser's default
`Select folder` caption. Preserve its visibility and geometry requirements.
Missing, hidden, clipped, duplicate or outside-dialog folder rows refuse the
unchanged path, geometry, context and screenshot fences.

Directory-opening attribution preserves `visual-git-project-directory-open`, then
marks only existing awaits with `visual-git-project-directory-` plus
`add`, `browse` or `nested` and `displayed`, `unique`, `enabled` or `click`, or
`path-focus`/`path-select`/`path-fill`/`path-commit`. These closed markers describe
only their existing public awaits and contain attribution faults without replacing
original exceptions or cleanup. Fill this Linux browser's buffered directory field
through public focus, Control+A, SDK addValue and the existing Enter commit. SDK
setValue clears and unfocuses before send-keys focuses again; the DraftInput can
restore its server-backed value on that second focus. The public selection replaces
that value without another blur/navigation. No extra wait or larger timeout is used.
They identify an awaited boundary, not the cause of a native timeout. The real
Add Project hook/dialog/directory browser and pinned SDK typing regression prove
source behavior using inert operation/query ports; they do not qualify native
XPath lookup, geometry, process timing or pixels.

At the exact `visual-git-project-directory-nested-displayed` failure, the existing
producer may retain `gitProjectDirectoryFailureFacts`. One failure-only browser
read uses the existing two-second bound and the already verified rich-project
binding. The read requires the exact origin, route, theme, selected primary card,
connected Local rail, unique dialog and unchanged credential/boot fences. It
retains only nullable booleans for path equality/focus, selected ordinary
breadcrumb, loading/fallback/error presence, control availability, visibility,
viewport/hit testing and the popup's own transition/animation state; path, folder
and breadcrumb counts use only `none`, `one` and `many`. Folder rows and
breadcrumbs are counted separately using the folder icon marker. No path, text,
HTML, source/server/thread identifier, native error or credential is retained.
Missing/foreign/ambiguous surfaces, malformed/accessor/proxy output, unavailable
or late reads leave the field null. A reused original error cannot retain an
older sample. The original display exception, public action order, capture
admission, 30-second existing wait and 600/660-second batch bounds remain
unchanged. These facts identify a sampled state; they do not establish the
native timeout's cause, qualify an original or replace full82/164 coverage.
The manual workflow's existing Git helper test gate includes
`release-visual-git-project-directory-failure.test.ts`; current-source root
check/type and independent native-original review remain required.

For this selection only, verify the canonical owned private clone-alias file and
its exact key/value, then set the actual server child's `GIT_CONFIG_GLOBAL` to
that file before startup. The valid fixed clone URL maps to the private bare
origin; it does not prove an HTTP transfer. Preserve the owner guard, discovery
isolation and all other child environment settings. The incomplete destination
must refuse before transfer and remain unimported and intact. Read actual typed
orchestration snapshots before/after that attempt; no guessed project count or
renderer store state supplies the import proof. Submit Clone with the explicit
owned-dialog XPath matching its existing dialog role/data-slot and exact caption.
The pinned SDK does not compose this CSS ancestor with its bare text-selector
syntax. Keep the original displayed, unique, enabled and click order, fixture
retention and snapshot checks, public submission and refusal polling. The real
mounted Clone form and installed-SDK regression use inert operation ports;
native XPath execution, layout and pixels still require CI evidence. A retained
chooser original and its later unchanged phase do not identify which subsequent
check or await failed.

Use the ordinary public Add Project/path/primary-card and project menu controls.
Wait for an asynchronously mounted control to display before checking its unique
cardinality, then require enabledness before interaction. Hidden project-header
controls use their genuine keyboard focus/Enter path. Join the typed default
thread/project/root with the actual local server storage/boot identity and owned
source HEAD/branch before each capture; broken config remains independently
observed while its owned HEAD stays unchanged. Preserve the existing route,
credential, theme, 1280 by 960 geometry, unobstructed target, original nonblank
PNG and post-screenshot witness checks. Missing, zero-size or stale controls
refuse capture; do not force clicks, widen budgets or fabricate a busy state.

Git/project snapshot admission issues one separate, unconsumed Node pairing
grant through the existing bounded private CLI owner for each producer. The
browser keeps its original grant; Continue consumes that grant before this
snapshot reader starts. Exchange the distinct Node grant once through the
existing owned OAuth bootstrap helper, then cache that private plain-session
access token across the existing typed snapshot reads. Cache issue/exchange
failure too: fail without retrying or reminting a consumed grant. A pairing
grant is a bootstrap subject, never a snapshot bearer; that endpoint requires
a session with `orchestration:read`. Public descriptor reads remain
unauthenticated, and the snapshot decoder, source/default-thread/card proof
and existing request bounds remain unchanged. The added CLI issue and OAuth
exchange each use their existing ten-second owner/request bound. No grant,
access token, header, cookie or private snapshot payload enters retained
evidence.

The Git/project producer corrects browser outer size to the same 1280 by 960
content viewport required by its existing witness and original-PNG checks.
Read the actual content size and device scale, use the shared outer-size
correction, then require the content size to settle before producer admission.
A requested outer window size alone does not establish content dimensions.
Keep the existing owner deadline and refuse an unsettled viewport before
capturing; do not relax target geometry or synthesize browser layout.

Snapshot admission must decode the endpoint's public `OrchestrationReadModel`,
not raw persistence rows. The server uses its shared project/thread projection
from one repository load, preserves archived/deleted markers, and emits the
existing public camel-case identities. A populated public fixture is checked
against the Rust projection and decoded through the actual QA reader; empty
mock bodies alone cannot prove this boundary. No raw snapshot, path, message,
model selection or credential becomes retained native evidence. Source parity
can establish a contract defect and repair, while the native failed substep
and final captures still require the controlled CI run.

The finite lane retains eleven named originals per theme: `worktree-discovery`,
`project-open-directory`, `project-clone-chooser`, `project-clone-incomplete`,
`git-tags`, `git-switch-with-changes`, `git-merge-conflict`,
`git-rewrite-preview`, `git-unborn`,
`git-no-repository`, and `git-broken-recovery`. Only their explicit light/dark
filenames and the same seven closed phase/failure/provenance/result/assertions/
namespace-cleanup/supervisor JSON receipts enter the artifact allowlist. No
private config, snapshots, names, paths, credentials, logs or raw errors are
retained. The actual owner still joins browser/server/process cleanup and the
Python namespace owner before deleting its private fixture.

All eleven approved group IDs remain in the closed assertion. Tags pictures
only groups/names: its disabled-actions check is unqualified. The pushed rebase
preview opens from History through Rebase and the fixed base branch choice.
Its named original joins the visible owned current branch, exact operation
warning and enabled Cancel/Rewrite History controls. Use Cancel after capture;
never confirm Rewrite History. Failed chooser admission uses the dialog's
ordinary Escape cancellation. The existing source/default-thread/server joins
remain required. Before opening the preview, admit the fixed upstream and
record private refs, index bytes, dirty diff and porcelain status. The cleanup
callback always checks them unchanged, including when capture or cancellation
fails; its read-only Git observations use --no-optional-locks. Never retain
those private snapshots. A cleanup failure remains failed and cannot replace
an original capture exception. `completeGroup` is always false; the
complete approved 82-scene/164-original obligation remains unchanged. The
initial discovery Add/Keep-hidden state is pictured, while the later real
Show Hidden Worktrees state has no extra original. The clone chooser is opened
and cancelled with input retention, but its named original pictures the returned
form; chooser pixels are not separately retained. Broken recovery's real busy
and focused Retry must survive both witness checks and may fail honestly.
Review actual paired original pixels independently before any native, visual,
group or full-matrix acceptance claim.

## Cursor later-question visual preparation

The manual visual workflow offers a separate fixed
`release-visual-cursor-question` selection for the existing later-multiselect
row. It retains one named `question-multiselect` original per theme. It is not
appended to the bounded nine-scene core sequence; `completeGroup` stays false
and the full 82-scene/164-original obligation remains unchanged.

Only the reviewed CI owner passes `question-multiselect-v1` to the existing
fixture installer. Undefined selection retains the default Cursor shim bytes
and settings. Selection outside CI is refused before fixture creation. The
fixed question flag belongs only to the owned Cursor instance environment;
other providers and ordinary callers remain unchanged. The controller preserves
that environment while restricting provider executables to its private shims.
It enables no real host provider and changes no production inventory/capability.

The fixture uses Cursor's actual newline ACP `cursor/ask_question` route: the
first question is single-select and the later question retains `allowMultiple`.
The original prompt remains pending until an exact correlated label-array
answer completes both questions. CI first runs the inert
`provider::cursor::runtime::tests::owned_later_question_keeps_multiple_labels_and_original_prompt_correlation`
library replay, which checks actual runtime mapping, original wire/turn
correlation and first scalar/later label-array preservation. This compatibility
proof does not replace the real product/provider/browser qualification below.

Select the owned Cursor Fixture model through public model controls in the real
managed thread. Send the fixed owned prompt through the existing delivery path;
click Workspace, allow the actual single-select advance, then click Tests and
Docs. Require the later question, readable 2/2, both genuine selection indicators,
all three owned options and visible/enabled explicit Submit. Capture before
submitting, submit once publicly, then require the typed public snapshot to
report that exact newly started Cursor turn as completed with its completion
timestamp. A missing question or working row alone does not prove success;
failed, interrupted, foreign, or timestamp-free turns refuse qualification.
Restore the original imported primary/default public context through the
existing cleanup owner and verify its existing Claude Opus selection without
changing the completed Cursor thread's driver. Join every owned child on all
exits. Failed restoration remains fatal; capture failures and their original
errors are preserved. Never inject a canonical pending input or renderer state,
force a click or replace the question with static markup.

For the fixed Cursor question selection, keep its new managed workspace
thread unstarted before selecting Cursor. Skip only this selection's unrelated
Claude baseline; all other selections retain their ordinary baseline. Admit
its empty workspace and the same project's original primary/default context
from the current decoded public snapshot, with exact live identity, branch,
path and project-root checks. Do not rewrite sessions or relax the public
started-thread driver binding.

The real Cursor turn establishes this conversation. Keep the actual original
turn correlation, two ordered questions, selected-label proof, explicit Submit,
original-turn completion and source/PNG checks. Afterward, restore the imported
primary/default public context with supported navigation and verify its exact
route/card identity and existing Claude Opus trigger. The original context's
provider is restored; the completed Cursor workspace session stays Cursor.
Keep the retained managed-worktree identity check and complete owner cleanup.
A failed public context restoration remains a logical cleanup failure.

Preserve the original failure's closed phase before cleanup can update phase
markers, keyed by the exact original exception identity. Source and mounted
probes establish the binding/setup contract, not the failed trial's native
cause. New current-source CI receipts and independently reviewed original
pixels remain necessary; this preparation does not close full82/164 coverage.

The shared owned original-capture helper preserves the existing Git/project
lifecycle: duplicate/file/alert refusal, identity before and after the original,
owner-bounded 2-second observations and 5-second screenshot, both witness
checks, original nonblank PNG validation at 1280 by 960, strict closed receipt
and private mode-0600 exclusive write. Scene readers retain route/theme/selected-card,
provider, credential, boot-shell, visibility, hit-testing and clipping fences.
The new selection retains the existing 600/660-second controller/outer bounds,
private profile/network/guard admission and joined namespace cleanup. Capture
metadata contains only fixed enums/booleans/counts/dimensions and hashes; no
question replies, IDs, input, HTML, credentials, logs or private paths enter
retained evidence. Its allowlist is only two named originals plus the same seven
closed phase/failure/provenance/result/assertions/namespace/supervisor receipts.

Run the Cursor fixture/installer/public-flow/shared-capture tests with existing
Git/project capture negatives and the actual mounted question controls before a
native trial. Inspect both CI original images independently. Hermetic ports,
geometry, scripted transport and static gates do not establish native pixels,
Tauri behavior, a final product nomination or full-matrix acceptance.

For the dedicated Cursor question producer, record an original failure only
before restore cleanup, using the original exception and one of the nine
closed Cursor phase names. On the same exception only, restore that
phase before existing failure observations and receipts. Clear the attribution
record before each producer entry; a reused error cannot borrow an earlier
phase. Optional attribution/reporting failure cannot replace the original
exception, skip the public restore or hide a logical cleanup failure. This
changes failure attribution only: model choices, native question actions,
capture count, wait bounds and owner cleanup remain unchanged. A restore failure
can otherwise overwrite the global phase, so an old recorded worktree model
phase alone does not prove that the question producer was never entered.

The Cursor send callback separately attributes its original decoded-thread read,
public composer send and native pending-question wait. The historical phase name
`visual-cursor-question-turn-running` now locates that pending-request wait.
Cursor delivery acknowledgement awaits the prompt response, which the question
itself holds, so the current read model may have no `latestTurn` before Submit.
Bind exactly one fresh fixed prompt and pending/sending Cursor delivery to the
same Cursor session, one fresh native turn-start activity and one later native
question activity with both exact questions and choices. Retain their private
thread/message/turn/request identities and durable request sequence. After the
unchanged public selections and explicit Submit, require that same prompt's
delivered start state, exact request-resolved answers, a later
successful native turn-completed activity, ready/idle error-free Cursor session
and the existing public quiescence witness. Normal start-delivery projection keeps
its user message's `turnId` null; only delivered steering binds that field. The
native started/question/resolved/completed activity chain owns the exact original
turn correlation, joined to the one fresh fixed prompt and its delivered start.
Do not invent message turn attribution or fabricate a running turn,
accept DOM silence as completion or bypass provider delivery acknowledgement.
The two original images, public controls, restoration and wait bounds remain.
These markers add no snapshot reads, actions or timeout budget.
At only an original Cursor running-turn failure, `cursorTurnObservation` may retain
nine booleans from the last already-required schema-decoded snapshot during that
pending-request wait: selected
Cursor model, latest-turn presence/newness/running state, session presence/Cursor
provider, matching active turn, session error presence and the fixed prompt's
public message presence. Reset the record at producer entry and emit it only for
the same original error and phase; otherwise it is null. No snapshot, message,
ID, path or error text leaves this projection, and it adds no read or action.
These are the last observed predicate facts, not a native cause or screenshot
qualification. The existing failure JSON gains this nullable field; artifact
filenames and all existing failure fields remain unchanged.

### Existing workspace row substates

The existing workspace preparation reports separate fixed phases for draft
typing, descriptor read/identity, typed snapshot read, thread count/binding,
project binding and batch entry. These markers add no action, read, retry or
time budget, and identify only the attempted boundary. Preserve the original
exception and cleanup; an earlier compound open phase alone does not establish
which check failed or identify a native cause.

The fixed manual `release-visual-workspace-substates` selection uses the same
real-server controller, public pairing/import, selected managed Git worktree,
owned Claude fixture and private Python PID/network namespace. Its separate
600-second inner and 660-second outer batch leaves the original nine core scenes
and full82/164 base obligation unchanged. This is six extra originals bound to
three existing rows, not three new scenes or substitutes for base originals.

The `git-history-stashes-selected-diff-{light,dark}.png` originals select only the
owned last stash and its actual `visual-stash.txt` diff. Scrolling remains inside
the stash list; selection returns to baseline history afterward. Never apply,
pop or drop a stash. The `files-editor-comment-item-context-menu-{light,dark}.png`
originals open the actual selected owned file's shadow-tree item menu by public
right-click, retain the real editor and comment, then close the menu with Escape.

The `workspace-composite-activity-lines-{light,dark}.png` originals use New panel
→ Open Terminal, ordinary terminal focus and the fixed `/bin/sleep 600` subprocess
inside CI. Open one actual Claude chat panel through the same public menu, send
the owned prompt and wait for the fixture response. Return to the original host
chat and hover its existing Terminal process running indicator. Require its own
linked tooltip, provider/model/age session line, exactly `1 more chat`, original
response and original unsent draft. Terminal activity means the existing
indicator/tooltip; it does not invent a terminal text preview row. Interrupt and
close only the created terminal, close the created chat and prove counts gone.
Missing/disabled public controls, foreign identities or incomplete cleanup fail. The
activity helper records only fixed phase enums before context and managed admission,
the single-panel check, terminal open/focus/command/running, host return, chat
open/compose/send/response, host restore, hover and capture. Cleanup preserves the
original operation exception and its last phase; these markers add no page reads,
actions or deadline changes. A marker locates the failing boundary and does not
prove its native cause or qualify a missing screenshot.

Every capture rechecks the actual local server boot/storage identity, schema-decoded
public snapshot thread/project/worktree binding and filesystem Git identity,
then reads strict closed facts before and after the original screenshot. Six
unique 1280×960 nonblank originals must join both incomplete-group assertions.
Only those six named PNGs and the existing seven closed JSON receipts are uploaded;
credentials, IDs, paths, provider inputs, profiles and raw logs remain private.
Outer controller/process and Python supervisor/namespace joins remain required.
Compile inputs beforehand and execute only in the disposable Linux CI namespace;
local source/HappyDOM/TempGit/fake-port tests prove compatibility, not pixels or
native acceptance. Independently inspect both-theme original pixels, and keep
completeGroup false; no full matrix, Tauri or final release acceptance follows.

## Seven provider and chat visual rows

The fixed manual `release-visual-provider-chat` selection of the visual preparation
workflow runs the existing seven provider/chat rows in a separate disposable Linux
PID/network namespace. Its 600-second controller and 660-second supervisor bounds
retain the core, Settings, Git/project, Cursor and workspace selections and their
defaults. This batch produces fourteen originals; `completeGroup` remains false
and the original 82-row/164-original obligation remains unchanged. The later
multiselect question stays exclusively in the separate Cursor selection.

Use only the private CI opt-in `provider-chat-v1` fixture installation. The
undefined installer selection preserves the existing provider source bytes;
non-CI, unknown or simultaneous Cursor/provider opt-ins refuse before creating
files. Enable only the owned Claude and Codex instances, retain the existing
Claude Opus baseline on the selected managed workspace, and use the genuine
New panel → Codex action once for the Codex rows. A started Claude conversation
cannot change its driver. Admit the decoded host and newly created panel as an
explicit pair: same project, resolved managed path and branch, ordinary strict
Git identity, exact visible panel surface and original host route/card. Recheck
the public server's boot/storage identity throughout the source/capture joins.
Do not change the product provider filter, persisted schema or canonical state.
Normal START deliveries retain a null user-message `turnId` in the current
server projection. Require exact delivered/start metadata and one fresh owned
prompt; bind the native turn through the changed latest turn, running session
where applicable and the single native input record (including Codex's real
turn ID). Completed plan/checkpoint/assistant and held-loss FIFO checks use that
native binding while preserving the START user's null attribution. Refused and
queued messages remain null with no extra native dispatch; do not substitute
steering attribution or a stale latest turn.

On the Claude host, capture the `/comp` command suggestions, context popover,
MCP popover, and actual markdown/plan/checkpoint row in that order. Seed the
owned `visual-chat.ts` before the baseline checkpoint. Obtain its sibling
`visual-swatch.png` through the typed public `assets.createUrl` RPC and require
the signed same-origin route to serve the exact pinned PNG bytes. The opt-in
native Claude protocol then changes only the pinned source file and emits its
ordinary markdown/plan frames. Require the completed exact turn, matching plan,
ready real checkpoint file and assistant before capture; require the actual
64×64 image to finish loading. Never substitute static markup or a synthetic
checkpoint or asset. Close popovers and the plan, and clear only owned drafts.

On the owned Codex panel, capture Activity at the closed 960×800 viewport; all
other rows remain 1280×960. Open the actual dock/Subagents/detail controls. Join
sent messages to the bounded native input log and decoded delivery/session
metadata. Publicly select GPT-5.4 and High before arming the owned catalog
refusal marker. Capture the real `modelSelectionRefused` message and exact FIFO
successor with no native dispatch. Cancel the successor through its own public
row first, wait for its withdrawal and restore/clear only that owned draft,
then dismiss the refused predecessor. This ordering prevents cleanup from
sending the queued message. Restore only the original marker inode/bytes;
an unsafe marker cleanup is fatal even when the capture already failed.

For held workspace loss, send the genuine Codex slow turn, join its exact native
turn ID, enqueue its separate FIFO successor, and retain the owned review draft.
Before moving the disposable managed directory, pin its inode, `.git` pointer,
admin/backlink, primary/common anchors and exact Git registration. During the
intentional absence, use only the explicit opaque loss scope: original absent,
exact renamed inode, unchanged anchors/registration and the same decoded
host/panel ownership pair. Never relax the ordinary worktree reader or realpath
the intentionally missing path. Require the real settled error, nonstreaming
partial assistant, held FIFO and no automatic resend before and after the
original screenshot. Restore that exact directory, prove ordinary identity,
and cancel the owned queue. Close only the created Codex panel and publicly
restore the original Claude host. Preserve both original and cleanup failures.

The capture owner rechecks identity, typed turn/FIFO/file joins and strict closed
DOM witnesses on both sides of each original screenshot. The artifact allowlist
contains only `composer-command-menu`, `context-popover`, `mcp-popover`,
`chat-markdown-plan`, `activity-narrow`, `chat-refused-model` and
`chat-held-workspace-loss` with `-light.png` and `-dark.png`, plus the seven closed
JSON receipts. Provider inputs, IDs, credentials, filesystem paths, profiles and
raw logs remain private. Python deletes this batch's private root only after
the controller's exact source/selection receipt reports safe restoration and
closed children with no cleanup failures, and both supervisor/namespace owners
join. Missing or unsafe restoration proof retains the fixture and fails the run.

The workflow includes focused hermetic provider, installer, public context,
turn, asset, file and loss-owner tests before compiling the real server/web
inputs. Local HappyDOM, VM, fake-port and TempGit results prove those boundaries;
the real provider/server/browser run remains CI-only. Independently inspect
all fourteen paired original pixels before accepting these rows. No full-matrix,
Tauri, native application or final release acceptance follows from this batch.

### Contained native sharing visual qualification

The manual release visual workflow also accepts `release-visual-native-sharing`.
Dispatch it from the same reviewed candidate ref used for the visual report:

```sh
gh workflow run qualify-release-visuals.yml --ref '<qualified-ref>' -f scene_selection=release-visual-native-sharing
```

This selection calls the packaged desktop workflow in its native-sharing mode.
It builds a Linux x64 E2E AppImage with the embedded Tauri driver and the server
hermetic guard, then runs it with a private data root, owned Xvfb and the
checked PID1/network namespace. The ordinary six-platform packaged smoke
selection retains its original matrix and commands.

The native Classic driver acknowledges the URL assignment before navigation
has necessarily settled. Before admitting the public UI ports or capturing, the
controller follows that acknowledgement with the existing bounded read-only
proof of the exact requested `tauri://localhost/#/settings/general` route. The
owner deadline and strict capture guards remain unchanged; original driver
errors propagate. The closed navigation phase and boolean distinguish an
acknowledged assignment from an observed route without retaining URLs or window
identities in the evidence.

The owned Xvfb display is 1920 by 1440 at 24-bit color so the native window has
room for its chrome. The pinned native Classic driver reports and sets the full
outer rectangle, while its screenshot contains the visible WebKit client. The
native-sharing-only viewport lease reads the actual client size and scale,
requires devicePixelRatio 1 and the owned display dimensions, and uses stable
outer/client measurements to account for bounded chrome. At most three owned
main-window corrections run within the existing owner readiness deadline. The
lease requires a 1280 by 960 client before capture and at the existing identity
fences, retains unchanged original PNG bytes, and restores the exact original
outer x, y, width and height before shutdown. It does not crop or rescale an
image. URL restoration, rectangle restoration, and the final owned identity
check are attempted independently within their existing bounds, including after
an earlier cleanup failure. The original visual failure remains primary;
otherwise the first cleanup failure is retained. Impossible or drifting geometry,
failed correction or restoration, and
unproven ownership fail qualification and preserve an unsafe fixture.

The initial outer-rectangle read records `native-original-rect-admission` before
its strict validation. The same admission inspection projects eight fixed
boolean-or-null fields: `originalRectRecordMatched`, `originalRectKeysMatched`,
`originalRectNumbersFinite`, `originalRectNumbersInteger`,
`originalRectPositionNonnegative`, `originalRectDimensionsPositive`,
`originalRectHorizontalWithinDisplay`, and `originalRectVerticalWithinDisplay`.
Null means that the predicate has not been established: before the existing read
returns, after unsafe record/accessor metadata, or when an earlier refusal leaves
later predicates uninspected. Missing or extra keys record only the closed key
mismatch; their values are never inspected. Geometric facts are derived only
from the already-admitted finite integer fields. Horizontal and vertical bounds
include the nonnegative origin and the opposite edge within the owned display.

The original admission snapshot and its projected packet are immutable. An
optional diagnostic failure or callback reentry cannot change the admission or
replace its original refusal. No numeric rectangle values, window identity,
URL, body or error text enters these facts. They add no SDK/renderer/native read,
poll, resize, launch option, request or deadline. Zero, negative, malformed or
out-of-display rectangles still fail the existing guard. An opaque failure must
remain unattributed until actual native evidence identifies its predicate;
these facts do not establish readiness or waive a capture or cleanup fence.

The last seven closed DOM booleans are retained from the existing witness read
in the existing phase/failure receipts. They admit no extra renderer read and
retain no markup, text, URLs or private identity. These facts distinguish a
remaining admission condition after geometry is established; they do not prove
a native runtime cause or waive a failed original. The separate native
follow-ups OS screenshot mode retains its own outer-window geometry contract.

The native controller uses public Theme, Share this host and Refresh addresses
controls. It removes and restores only the already-admitted private default
route, checks the real native bridge and typed loopback descriptor, and never
mints an offer or widens exposure. Boot, storage, endpoint, input bytes, window,
route ownership and original UI restoration must stay joined across captures.
The four original PNGs bind the existing native-share-no-route and
native-share-refresh rows in both themes at 1280 by 960. These are native
main-webview sharing observations; they do not qualify OS menus, separate
Preview windows, updater recovery or WSL.

Retained artifacts are the four exact original names plus the finite phase,
failure, provenance, result, assertions, owned-cleanup, namespace-cleanup and
supervisor JSON receipts. Preserve original bytes and inspect each original at
original detail. A green local helper or compiled component test is not native
evidence. Candidate source/input hashes, zero guard refusals, joined controller
and child cleanup, unchanged host namespace and safe fixture deletion must be
verified from the same CI run. Unsafe or unproven cleanup preserves the fixture
and fails qualification. Record run-specific SHAs, timings and original hashes
in the execution report, not this runbook.

### Contained project lifecycle visual qualification

The manual release visual workflow accepts `release-visual-project-lifecycle`
from a reviewed, nominated QA ref. Default-branch execution remains registration
only and fails closed; the separate native sharing selection retains its own
packaged workflow and evidence boundary.

Before lifecycle or Settings follow-up capture, the native Linux job runs
`cargo fmt --all --check`, the complete `server_runtime` integration target,
and server Clippy for all targets with warnings denied. Its descriptor tests
compare the supported `vcsCloneReattach` and `attachmentStaging` flags across
the public HTTP response, authenticated config, config snapshot and lifecycle
events. Keep those capability checks active; missing flags from older servers
decode as false. Record the native test and lint results with the capture report.

```sh
gh workflow run qualify-release-visuals.yml --ref '<qualified-ref>' -f scene_selection=release-visual-project-lifecycle
```

This fixed browser selection covers only the existing worktree-remove-busy,
project-clone-progress and git-trust-refusal rows in light and dark at the
standard 1280 by 960 bounds. It skips the unrelated common Claude baseline.
Select Codex through the public model picker only while the decoded managed
workspace has no session, turn, messages, activities, plans or checkpoints.
Require the owned project/path/branch identity before and after selection.
Normal START user messages retain null turn attribution; join their fresh
message and delivered/start metadata to the real native input, latest turn and
running session instead of inventing user-message turn IDs.

Prepare the private fixture before starting the owned server. Its protected Git
config explicitly exempts the primary, seed, origin and trust checkouts plus
only the exact future destination derived from the caller's configured managed
base and requested branch. Keep that destination absent for the server's
exclusive reservation; validate its canonical private parent and re-admit the
actual Git inventory, admin/backlink and decoded thread after public creation.
Do not add wildcard exemptions or change host config or ownership. The
ownership-test environment belongs to the owned server only during native
qualification; direct forced-ownership Git commands are hermetic TempGit tests.

Open the real idle removal dialog without clicking its destructive action,
start one maintained Codex turn, and require a generation-bound typed removal
refusal with session-running. Capture the actual disabled action and reason,
then close the dialog, stop and reap that provider and retain the original
checkout. Trust refusal uses the actual server's Git classification and typed
untrusted status after removing only the owned target exemption. Restore the
private config bytes, retry publicly and require readable status and retained
inputs. The owned primary and other anchors must remain admitted.

Clone progress must come from one real Git transport. Its exact owned URL is
rewritten to a file transport by the protected config, and its admitted pack
hook delegates unchanged real pack bytes before holding the remaining transfer.
Wait boundedly for the valid owned marker; malformed or foreign marker data
refuses admission. Use the advertised join-only attach request on that same
active URL/destination without starting another clone. Capture only the
Cloning/busy state the public form exposes. Cancel through its original public
control, join the waiter, reap the Git/hook children and require removal of the
partial destination with original form values and source inputs retained. Clone
is last so its retained form can remain visible until browser teardown. The
private PID1 lifecycle reaper handles adopted zombies without signalling or
reaping the direct controller; Popen.wait remains its status owner.

Retain only the six fixed original names, using the three row names with
`-light.png` and `-dark.png`, and the seven phase/failure/provenance/result/
assertions/namespace-cleanup/supervisor JSON receipts. Require closed witnesses,
exact source/input hashes, byte-preserved originals, stable identity and zero
guard refusals. Safe deletion additionally requires the lifecycle restoration
flag, closed children, no cleanup failures and both controller/namespace and
supervisor joins. Missing or unsafe proof retains the private fixture. Preserve
the original error even when restoration fails.

The workflow runs focused helper, current-contract, mounted public widget,
actual caller VM and owner/namespace tests before the contained runtime. Those
local results establish source behavior only. Real application/server/provider
execution remains CI-only; independent inspection of all six original pixels
is still required. completeGroup remains false, the 82-row/164-original scope
is unchanged, and this batch provides no final native or release acceptance.

### Contained Settings follow-up visual qualification

The manual release visual workflow accepts `release-visual-settings-followups`
on a nominated QA ref. Its default remains `release-visual-core`; the default
branch refuses capture jobs. Run this lane in CI only:

```sh
gh workflow run qualify-release-visuals.yml --ref '<qualified-ref>' -f scene_selection=release-visual-settings-followups
```

This selector covers the existing `settings-diagnostics`, `usage-detail`,
`remote-rename`, and `remote-receiving-settings` rows. It emits nine original
PNG scenes per theme: `settings-diagnostics`, `diagnostics-live-processes`,
`diagnostics-unknown-duration`, `usage-detail-available`, `usage-detail`,
`remote-rename`, `remote-rename-applied`, `receiving-settings-row`, and
`remote-receiving-settings`. The eight base originals retain their names; the
ten supplementary originals join the same four rows. `completeGroup` stays
false, and the full 82-row/164-original obligation remains unchanged. Add
instance wizard, unrelated substates, native/final acceptance and independent
original-pixel review remain separate obligations.

The actual delivery caller starts server A on owned loopback 4885 and server B
on 4888 using the admitted native CLI and separate private HOME/state/project
roots. A owns its managed workspace, selected model and preserved draft. A
uses an exclusively created empty Codex auth file and a copied, pinned Node
development interpreter running a bounded native app-server protocol fixture.
The production usage mapper creates the displayed session and weekly windows;
B has no Codex auth file and produces the genuine unavailable state. Only child
environment copies clear inherited `CODEX_HOME`; no host credentials are read.
All other providers remain disabled/missing except the existing owned Claude
fixture. No renderer store, canonical runtime state or provider availability is
injected.

The caller obtains separate private Node grants for the typed A/B APIs and a
genuine B pairing offer for the browser. The public Add Server form, remote
rail, Browse folder import, Rename form, Disconnect/Connect and Remove server
confirmation own every browser mutation. Native descriptors remain `local`;
the remote client ID is derived from the native storage ID, and route joins
encode both environment and thread segments. Decoded native config/snapshots,
full repository identity, registered managed Git identity, physical branch,
common directory and HEAD join the same boot/storage/project/thread before
and after each original. Diagnostics include a real safe owned read-only Git
failure, native process ancestry and measured/unknown-duration source rows.

The transparent owned listener on 4889 forwards to B4888. Initial connection
and pairing pass unchanged. After public Disconnect, the returning Noise
upgrade and authentication bytes pass unchanged; the gate holds only subsequent
original encrypted application records. The caller waits within its existing
30-second owner bound for actual held bytes from exactly the returning owned
Noise generation, then requires strict holding and the actual public Receiving
notice/read-only widgets before capture. The gate retains its 20-second expiry,
record/byte limits, joined timers and original-byte release. Counts and dots do
not substitute for authentication or UI readiness.

The caller delegates B import to the same shared public import adapter used by A,
without its local-only optional source callback; it does not maintain duplicate
Browse folder or path-mode selectors. B native/default-thread source binding
still waits after the real import and public Claude selection.

The producer restores the original alias, releases held bytes, removes only the
owned remote browser registration, and restores A's model/draft/selection while
both native source owners remain alive. Typed API scopes and gate join before B
stops. Browser/driver/A join before usage files and the copied interpreter may be
removed; unsafe cleanup preserves the private fixture and the original failure.
Input deletion refusal is monotonic in each fixture and in the shared owner: after
any unsafe callback or refused close, both exact usage executable and copied
interpreter bytes remain intact even if a later resource join succeeds. Resource
join retries still execute; only unsafe input deletion is prohibited.
The existing private PID1 adopted-child reaper also covers this selector without
signalling live children or stealing the controller status. Safe deletion requires
`settingsFollowupFixtureSafeToDelete`, closed children, empty cleanup failures,
the matching source/selection, and empty joined namespace/supervisor receipts.
The original inner/outer budgets stay 600/660 seconds.

Retain only the eighteen explicitly named PNGs and seven closed JSON receipts
from `issue29-settings-followups-<run-id>`. Private pairing material, provider
inputs, interpreter files, logs, profiles, IDs, paths and process arguments are
never artifact entries. Hermetic caller/producer/source/transport tests and
workflow/Python boundary checks establish the source contract; only this CI
lane and independent original-pixel review can establish visual qualification.

### Existing native menu and update follow-up partition

The fixed `release-visual-native-followups` manual selection calls the existing
seeded owner with its default-false native opt-in. The selected Linux x64 lane
uses a nonroot runner and real 1280 by 960 Xvfb display. Its private session owns
D-Bus, Openbox, GNOME XSettings, AT-SPI and the GTK desktop portal; public
gsettings actions change and restore that session's real appearance preference.
Require the actual portal reply, native GTK menu grouping and original root
pixels. Missing services or controls remain unavailable, never synthesized.

The existing owner builds both a current-source protected baseline and a valid
ephemeral-signed candidate in isolated checkouts. Its nonroot read-only install
parent creates a genuine permission failure while retaining the original app.
The public update coordinator must produce protection/recovery controls, verified
pre-update backups and retained draft/store/boot/source/process joins. No invalid
signature or fake update state substitutes for this failure. All original package
and operation deadlines stay unchanged.

The finite Linux originals are native-menu-theme, native-update-protection and
native-update-recovery in light/dark. Keep only these six PNGs, the three
retainer-owned native-followups JSON receipts and the closed workflow-status JSON.
Raw native/OS/WDIO logs, signer files and source/store observations stay private;
unsafe cleanup refuses retention. No crop, resize or alternate window is allowed.
This is a six-original partition, not full-matrix or native Preview annotation
acceptance. The normal six-platform seeded matrix and ordinary lanes remain the
default; this explicit opt-in does not qualify omitted platforms.
