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
  Only a push to `codex/qualify-release-ui` or a manual dispatch starts it; a push
  selects core, and manual dispatch offers core/full. There is no main-branch trigger.
  Neither selection installs software, supplies native host-toast evidence, or
  replaces the final integrated screenshot sweep.

  Run this workflow only after independent harness review and the separate
  browser-startup prerequisite. It builds the web source once, copies the guarded
  server/example outside Cargo output and records source/build hashes; it serves
  those web assets with the existing preview configuration. Its shared Python
  owner admits only a disposable CI PID/network namespace, and its shared browser
  owner enables no performance logging. Prepare the reviewed contained topology
  before any fixture, service or browser admission. Browser state before setup is
  unobserved (`before:null`); each created browser must pass one bounded actual
  online read. No post-launch network mutation, repair, sleep or retry is allowed.
  The network helper validates the exact PID1 argument form for the selected
  qualifier: the ordinary chat form or the UI form with its fixed selector,
  canonical input identities and matching core/full selection. An owner-shape
  refusal precedes all network reads/mutations; preserve that receipt and repair
  the handoff instead of bypassing its ownership checks.
  Remote pairing uses the real Add Server
  flow through an owned loopback tunnel. The fresh-terminal setup uses genuine
  authenticated public RPC and a pinned owned executable; dialog counts and all
  update actions use the real UI. Reports distinguish that setup from UI terminal
  creation. Manual CLI layouts qualify descriptor kind, visible instructions and
  actual clipboard contents; their install dispatch remains unobserved, and their
  instructions are never executed.

  For the full Reload negative control, observe the primary rail connected,
  then disconnected and connected again around the same-version restart, with a
  new server boot, before starting the unchanged ten-second no-prompt window.
  Missing/stale browser state or Node-only reachability cannot satisfy it. Keep
  that transition within the existing thirty-second bound, and record its closed
  transition receipt separately from the duration of the negative window.

  Retain only the workflow's finite screenshot names and closed JSON evidence.
  Each original image requires actual theme, selected environment, expected text,
  unobstructed visible target, nonblank PNG and no credential control or URL.
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

For delivery Retry and the first release visual batch, a failure in the existing
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
staging. Both distinct repository PNGs must be loaded at natural 64 by 64 size;
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

At exactly `visual-git-branch-menu`, the existing failure receipt may retain
`coreBranchCaptureFailureFacts` from the last witness already returned by the
capture's existing polling or post-screenshot read. It adds no browser/RPC read,
action, timer, deadline, retry or capture fallback. The fixed ten booleans retain
false scene/text/geometry facts only when theme, selected context, credential
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

For this selection only, verify the canonical owned private clone-alias file and
its exact key/value, then set the actual server child's `GIT_CONFIG_GLOBAL` to
that file before startup. The valid fixed clone URL maps to the private bare
origin; it does not prove an HTTP transfer. Preserve the owner guard, discovery
isolation and all other child environment settings. The incomplete destination
must refuse before transfer and remain unimported and intact. Read actual typed
orchestration snapshots before/after that attempt; no guessed project count or
renderer store state supplies the import proof.

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
