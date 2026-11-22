# Linux setting to disable GPU compositing

Status: revised after Codex and advisor review round 1 (Task 6.1 of
`docs/plans/2026-11-20-undo-remote-delete-antigravity/`, requirement R17,
issue #411). The pull request closes #411, so the proof in
[Verification](#verification) must come from the packaged app.

## Problem

On one machine, an Intel integrated GPU under a Wayland compositor, the
kernel reported repeated GPU hangs in WebKitGTK's `ThreadedCompositor`
thread while BiBCode ran. The driver failed to reset the render engine,
reset the whole GPU, and the compositor aborted, ending the desktop
session. The defect is in the driver (tracked upstream in Mesa), but
BiBCode is the program that triggers it. Exporting
`WEBKIT_DISABLE_COMPOSITING_MODE=1` and `WEBKIT_DISABLE_DMABUF_RENDERER=1`
in the AppDir launcher stopped the hangs in the runs since. That
workaround is lost when the AppDir is replaced, and it does not apply when
a `bibcode://` link starts the binary directly.

## How start-up works today

- `main` (`apps/desktop/src-tauri/src/main.rs:6-10`) first dispatches the
  `--crash-monitor` re-exec, then attaches the crash hook. Next, still
  single-threaded, it repairs the GStreamer variables on Linux
  (`main.rs:11-13`, `gstreamer_environment.rs:39-56`, whose SAFETY comment
  records why mutating the environment is sound there). Then the open-url
  shim (`main.rs:16-24`) and the profiler/diagnostics/MCP CLI
  (`main.rs:28-32`) exit without Tauri or a webview. Only then does
  `bibcode_desktop_lib::run()` start (`main.rs:33`).
- `run()` hydrates `PATH` from the login shell before any thread
  (`lib.rs:101-102`), starts the crash monitor child (`lib.rs:104`) and
  builds Tauri. The first webview is the main window, built in `setup`
  (`lib.rs:139-146`); preview webviews come later. A decision made before
  the log sink exists is kept and logged in `setup`, as
  `shell_path_hydration.record()` does (`lib.rs:102`, `lib.rs:160`,
  `shell_environment.rs:93-105`).
- Desktop-level settings live in `desktop-settings.json` under the state
  directory: `<data root>/userdata` in release builds and `<data root>/dev`
  in debug builds (`config.rs:170-176`). The data root is `BIBCODE_HOME` or
  `~/.bibcode` (`config.rs:147-164`, `apps/server/src/data_root.rs:80-104`).
  The bridge reads and writes the file (`bridge.rs:67`, `bridge.rs:76-92`,
  `bridge.rs:402-426`) and the backend reads it through
  `config::data_root` (`backend.rs:3215-3224`, `backend.rs:3257-3259`).
- Two loss cases exist in that code. The writer emits only the keys it
  knows (`bridge.rs:316-323`), so a key added by hand is dropped on the
  next write. And the reader decodes the whole document at once with
  `unwrap_or_default()` (`bridge.rs:407`), so one field of the wrong type
  resets every field to its default, and the next write saves those
  defaults.
- The home directory is the only part of the state directory that needs
  an `AppHandle`: Tauri 2.11.6 resolves it with `dirs::home_dir()`
  (`src/path/desktop.rs:153-155`). The server already depends on the same
  crate (`apps/server/Cargo.toml:33`, `dirs.workspace = true`).
- The `bibcode://` handler: `tauri-plugin-deep-link` 2.4.10 writes
  `<exe name>-handler.desktop` with `Exec` set to `$APPIMAGE` when that is
  set, else to the binary itself (`src/lib.rs:285-296`). From an extracted
  AppDir the link therefore starts `usr/bin/bibcode-desktop` directly and
  skips `AppRun` and its hooks. Registration runs in `setup`
  (`lib.rs:164-170`).
- Launcher-level options exist today only in the GTK hook:
  `BIBCODE_GDK_BACKEND` is applied by `AppRun`
  (`scripts/tauri/linuxdeploy-plugin-gtk.sh:121`), so it has the same gap.
- Restarts start the new process from the old one, which passes its
  environment on.
  - Settings' restart (`bridge.rs:1088-1101`) calls `request_restart`.
    Tauri then emits `RunEvent::Exit`, whose callback
    (`lib.rs:303-309`) calls `relaunch_outside_service_unit`, and
    afterwards spawns the current binary with the inherited environment
    (Tauri 2.11.6 `src/process.rs:74-83`). Settings' restart never calls
    `note_relaunch_requested`, so it skips the systemd scope handoff that
    keeps a service-unit launch alive (`relaunch.rs:15-18`,
    `relaunch.rs:39-58`).
  - The update restart (`updates.rs:931-935`) sets that flag and calls
    `app.restart()` on the main thread, which skips `RunEvent::Exit`, so
    only Tauri's own spawn runs.
  - Only the systemd path builds its own child command (`relaunch.rs:52-58`).
- Child processes inherit the desktop process environment, with
  exceptions. Terminals, providers, Git and other user-facing commands go
  through the AppImage isolation policy, which strips bundled paths and
  launcher markers but keeps unrelated variables
  (`docs/superpowers/specs/2026-09-23-appimage-child-environment-design.md`).
  Some Git commands run with a cleared environment
  (`apps/server/src/git/process.rs:322`, `:332`, `:921`). WebKitGTK's own
  child processes (`WebKitWebProcess`, `WebKitNetworkProcess`) and the
  in-process server are outside that policy and inherit everything.
- Engine version: release AppImages are built on Ubuntu 22.04 runners
  (`.github/workflows/release.yml:403-409`) and bundle that host's
  `libwebkit2gtk-4.1`, the 2.50 series per
  `docs/testing/linux-desktop.md` ("AppImage build and inspection"). The
  exact bundled version is read in the lab and recorded in the task report.
  WebKitGTK 2.54 changed how it renders without compositing. This note,
  and the proof, cover the 2.50 engine BiBCode ships. A move to a newer
  engine must check the two variables again.

## Decisions

### 1. Where the setting lives

- **A. A key in `desktop-settings.json`, read by `main` before Tauri
  (recommended).** It is in the data root, so it survives an AppDir
  replacement. It applies to every route that runs the binary: the menu
  launcher, the binary itself and a `bibcode://` link. A user can edit it
  without a window. Cost: `main` reads one small file per GUI start, and
  the bridge's settings code gains one Linux-only field.
- **B. A separate file owned by the new module.** It would leave the
  bridge's settings struct alone, but it adds a second desktop settings
  file with the same location rules. Rejected: one desktop settings file
  is easier to find and back up.
- **C. An environment variable only.** Rejected: R17 requires a Settings
  control, and a variable set in a shell does not reach a launch from the
  application menu or a link. It stays as the override in decision 3.
- **D. A launcher change (an `AppRun` hook, like `BIBCODE_GDK_BACKEND`).**
  Rejected: a direct-binary `Exec` skips it, an AppDir replacement resets
  it, and the hook cannot read the Settings value without copying the
  data-root rules into shell.

Details:

- The key is `linuxSoftwareRendering`, a boolean. One function in the new
  module decodes it from the parsed document, separately from
  `DesktopSettingsDocument`, so a bad value for it, or for any other key,
  cannot reset the other settings. A non-boolean value means off.
- The field exists only on Linux. The writer keeps it on every write, so
  WSL and exposure writes cannot drop it. macOS and Windows write the file
  as they do today.
- Settings writes it through the server exposure coordinator's
  `run_exclusive` (as `bridge.rs:1464-1477` does for WSL), so it cannot
  interleave with another read-modify-write.
- **One resolver.** `config::data_root` uses a new `config::home_dir()`
  (`dirs::home_dir()`, the function Tauri's `home_dir()` calls, so no
  platform changes behavior). The state directory rule becomes one helper
  that takes the home directory, and both `main` and `state_dir(app)` call
  it. The desktop crate adds `dirs.workspace = true`.
- A missing file means off. An unreadable file or malformed JSON also means
  off, and the reason is logged once the log sink is ready (decision 6).
- A `BIBCODE_HOME` exported in one shell only moves every BiBCode setting
  for launches from that shell. This is existing behavior; the user
  document says so in one line.

### 2. Default

- **Off (recommended).** Tauri's Linux graphics guidance is not to ship
  these variables unconditionally. Software rendering moves painting to
  the CPU, and most machines are not affected.
- **On for detected Intel GPUs.** Rejected: detecting the GPU before Tauri
  means probing DRM devices, the hang is not limited to one device ID, and
  it would slow every unaffected Intel machine.

### 3. Override without a window

`BIBCODE_SOFTWARE_RENDERING=1` turns the setting on for that launch, and
`BIBCODE_SOFTWARE_RENDERING=0` makes BiBCode set neither variable,
whatever is stored. Any other value, including empty, is ignored, the
stored setting applies, and a warning is logged. Together with editing the
JSON key, this covers a machine where no window can be shown.

### 4. Which variables, and the user's own values

When on, BiBCode sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` and
`WEBKIT_DISABLE_DMABUF_RENDERER=1`. It does not set
`WEBKIT_SKIA_ENABLE_CPU_RENDERING`: the issue shows that variable alone
did not prevent a hang.

A variable already in the environment, with any value including empty,
belongs to the user. BiBCode never overwrites or removes it. The check is
per variable, so a user who exported one still gets the other.

BiBCode remembers, in process memory only, which of the two variables it
set itself. No marker variable is used: an inherited marker could not tell
a user's export apart from BiBCode's own.

### 5. Restarts

Every in-app restart reaches the `RunEvent::Exit` callback through one
path, and that path strips exactly the variables BiBCode set from the new
process:

- Settings' restart calls `note_relaunch_requested()` before
  `request_restart`, so it also gets the systemd scope handoff (#94).
- In the exit callback, `relaunch_outside_service_unit` (renamed for what
  it now does) builds the child command itself:
  - when the process runs in a service unit, as today;
  - when BiBCode set either variable.
    It removes those variables from the command, spawns it and exits, as the
    systemd path already does. Otherwise it returns and Tauri's own restart
    runs unchanged.
- If that spawn fails, the warning is logged and Tauri's restart runs. The
  new process then inherits the variables and stays in software rendering,
  which fails safe.

The update restart (`updates.rs:931-935`) calls `app.restart()` from the
install command, off the main thread. Tauri 2.11.6 then restarts through
`RunEvent::Exit` (`src/app.rs:588-600`), so the same handoff strips the
variables there too. Only a restart that runs on the main thread skips the
exit callback and inherits them; that fails safe.

Rejected: removing the variables from this process before restarting.
By then the process is multi-threaded, so changing its environment is
unsound.

Residual, documented and not fixed: a BiBCode started from a BiBCode
terminal inherits the variables as if the user exported them, and stays in
software rendering until it is started from elsewhere. That fails safe.
Fixing it would need the server's process policy, which this change does
not touch.

### 6. What child processes inherit

- **Inherit (recommended).** WebKitGTK's child processes and the preview
  webviews need the variables to stay off the GPU. Terminals, providers and
  most Git commands also inherit them. The only visible effect is on
  another WebKitGTK program started from a BiBCode terminal: it also runs
  without GPU compositing, which is the safe direction on an affected
  machine and what the `AppRun` workaround already does. Git commands with
  a cleared environment do not get them; Git does not use WebKit.
- **Remove them from user-facing children.** Rejected: it needs a change
  to the server's shared AppImage isolation policy
  (`apps/server/src/process/appimage.rs`), which is outside this phase's
  ownership, and no reported problem requires it.

### 7. Code shape

- New module `apps/desktop/src-tauri/src/software_rendering.rs`, whose test
  names all contain `software_rendering`.
  - A pure decision function takes the stored setting, the override value,
    a lookup of the present environment and whether the platform is
    Linux. It returns which variables to set and a record for the log.
  - Pure helpers say whether a restart can apply the stored setting and
    whether GPU compositing is off in this process: either variable is
    present and is not `"0"`. Checked on WebKitGTK 2.50 in a Hyprland VM:
    either variable alone removes the web process's `ThreadedCompositor`
    thread, and `WEBKIT_DISABLE_COMPOSITING_MODE=0` alone keeps it.
  - The module compiles on every platform, so its tests run anywhere, and
    off Linux it changes nothing. The file read takes the path as a
    parameter, so tests use a temporary directory.
- `main` calls the Linux-only apply step after the open-url and CLI
  branches and immediately before `run()`. The crash hook is still first,
  the process is still single-threaded, and the CLI paths, which create no
  webview, skip the file read. The result goes into a `OnceLock`, and
  `setup` logs it with `tracing` beside `shell_path_hydration.record()`.
- Bridge: `getLinuxSoftwareRendering()` and
  `setLinuxSoftwareRendering(enabled)` return
  `{ enabled, override, gpuCompositingDisabled, restartApplies }`:
  - `override` is `"on" | "off" | null`.
  - `gpuCompositingDisabled` is the state of this process.
  - `restartApplies` is true only when no override is set and a restart
    would change what BiBCode sets: on, and a variable is still missing;
    or off, and BiBCode set one.

  Off Linux both commands return the existing `tauri_capability_unsupported`
  payload, so the command lists stay the same on every platform. Files:
  `bridge.rs`, the `lib.rs` handler lists,
  `permissions/desktop-bridge.toml`, `packages/contracts/src/ipc.ts` and
  `apps/web/src/tauriDesktopBridge.ts`. The methods are optional on the
  bridge type, as `restartApp` is, so the bridge version does not change.

- Settings: a row in `AppearanceSettingsPanel.tsx`, shown only when
  `isLinuxPlatform(navigator.platform)` and the bridge has the methods.
  - The switch is labelled "Disable GPU compositing". One line says what
    it is for and that the CPU then renders the window.
  - A status line says whether GPU compositing is off for this session,
    from `gpuCompositingDisabled`, so a user's `=0` export never shows as
    off.
  - When `override` is set, the switch is disabled and the row names
    `BIBCODE_SOFTWARE_RENDERING` as the reason.
  - When `restartApplies` is true, the row says a restart is needed and
    offers "Restart now" through the existing `restartApp`.
- Docs: `docs/user/linux-desktop.md` gets the setting, the variable, the
  JSON key, the `BIBCODE_HOME` line and the terminal residual.
  `docs/testing/linux-desktop.md` gets the packaged check.

## Verification

`/proc/<pid>/environ` of the desktop process shows only its initial
environment, so it proves nothing about variables set in `main`. The lab
reads the variables from the environment of the WebKit child processes
(`WebKitWebProcess`, `WebKitNetworkProcess`), which are spawned after
`main` ran.

The Linux lab runs the packaged build with the Profiler on and records
these cases:

| Case                                                    | What is checked                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Setting on, cold start                                  | Both variables are set in the WebKit children, and the app renders                       |
| Setting off (default), cold start                       | Neither variable is set                                                                  |
| On to off through "Restart now"                         | After the restart, the WebKit children of the new process lack both variables            |
| Cold start through the generated handler's `Exec` line  | With the setting on, both variables are set                                              |
| User exported `WEBKIT_DISABLE_COMPOSITING_MODE=0`       | The value is kept, the other variable is set, and the UI does not say compositing is off |
| Override `=0` with the setting on, and `=1` with it off | The override wins                                                                        |
| Malformed `desktop-settings.json`                       | Off, with a log line, and the other settings survive the next write                      |
| Write failure (read-only state directory)               | Settings shows the error and changes nothing                                             |

Unit tests cover the decision function, the decoding of the key, both
settings loss cases, and the Linux-only UI states. Whether the GPU hang
itself stops on the affected machine can only be shown there, by the 20
launches and the 24-hour run named in #411.

Found while verifying, and not changed here: from an extracted AppDir, the
binary started from any folder other than its `usr` folder aborts before the
first window, because the bundled WebKitGTK finds its helper processes
relative to the working directory. The generated `bibcode://` handler of an
extracted AppDir starts the binary that way, so that cold-start route fails
with or without this setting. A mounted AppImage's handler starts the
AppImage, whose `AppRun` changes to `usr` first.

## Not changed

macOS and Windows behavior, the crash hook order, the AppImage hooks, the
child isolation policy and the deep-link plugin.
