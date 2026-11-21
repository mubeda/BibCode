# Linux software rendering setting

Status: draft for Codex and advisor review (Task 6.1 of
`docs/plans/2026-11-20-undo-remote-delete-antigravity/`, requirement R17,
issue #411).

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
  (`lib.rs:139-146`); preview webviews come later. Decisions made before
  tracing exists are recorded and logged in `setup`, as
  `shell_path_hydration.record()` does (`lib.rs:102`, `lib.rs:160`).
- Desktop-level settings live in `desktop-settings.json` under the state
  directory: `<data root>/userdata` in release builds and `<data root>/dev`
  in debug builds (`config.rs:170-176`). The data root is `BIBCODE_HOME` or
  `~/.bibcode` (`config.rs:147-164`, `apps/server/src/data_root.rs:80-104`).
  The bridge reads and writes the file (`bridge.rs:67`, `bridge.rs:76-92`,
  `bridge.rs:402-426`) and the backend reads it by its own route
  (`backend.rs:3215-3224`). The writer emits only the keys it knows
  (`bridge.rs:316-323`), so a key added by hand is dropped on the next
  write.
- The state directory needs an `AppHandle` only for the home directory:
  Tauri 2.11.6 resolves it with `dirs::home_dir()`
  (`src/path/desktop.rs:153-155`), which on Linux is `$HOME`, then the
  password database. `std::env::home_dir()` follows the same order on Unix,
  so `main` can resolve the same file before Tauri starts.
- The `bibcode://` handler: `tauri-plugin-deep-link` 2.4.10 writes
  `<exe name>-handler.desktop` with `Exec` set to `$APPIMAGE` when that is
  set, else to the binary itself (`src/lib.rs:285-296`). From an extracted
  AppDir the link therefore starts `usr/bin/bibcode-desktop` directly and
  skips `AppRun` and its hooks. Registration runs in `setup`
  (`lib.rs:164-170`).
- Launcher-level options exist today only in the GTK hook:
  `BIBCODE_GDK_BACKEND` is applied by `AppRun`
  (`scripts/tauri/linuxdeploy-plugin-gtk.sh:121`), so it has the same gap.
- Restarts start the new process from the old one. The Settings restart
  (`bridge.rs:1088-1101`) and the update restart (`updates.rs:933-935`) end
  in Tauri's `restart`, which spawns the current binary with the inherited
  environment (Tauri 2.11.6 `src/process.rs:74-83`). The systemd scope
  relaunch also inherits it, apart from AppImage path isolation
  (`relaunch.rs:39-58`).
- Child processes inherit the desktop process environment. Terminals,
  providers, Git and other user-facing commands go through the AppImage
  isolation policy, which strips bundled paths and launcher markers but
  keeps unrelated variables byte for byte
  (`docs/superpowers/specs/2026-09-23-appimage-child-environment-design.md`,
  "Alternatives and decisions"). WebKitGTK's own child processes and the
  in-process server are excluded from that policy.

## Decisions

### 1. Where the setting lives

- **A. A key in `desktop-settings.json`, read by `main` before Tauri
  (recommended).** It is in the data root, so it survives an AppDir
  replacement. It applies to every route that runs the binary: the menu
  launcher, the binary itself and a `bibcode://` link. A user can edit it
  without a window. Settings writes it through the existing desktop
  settings code. Cost: `main` does one small file read per GUI start, and
  the bridge's settings struct, document and writer gain one field, or
  the next WSL or exposure write would drop it.
- **B. A separate file owned by the new module.** Avoids touching
  `bridge.rs`'s settings struct, but adds a second desktop settings file
  with the same location rules. Rejected: one desktop settings file is
  easier to find and back up, and the struct change is one field.
- **C. An environment variable only.** No file and no Settings control,
  but R17 requires the Settings control, and a variable set in a shell
  does not reach a launch from the application menu or a link. Kept as the
  override in decision 3.
- **D. A launcher change (an `AppRun` hook, like `BIBCODE_GDK_BACKEND`).**
  Rejected: a direct-binary `Exec` skips it, an AppDir replacement resets
  it, and the hook cannot read the Settings value without duplicating the
  data-root rules in shell.

The key is `linuxSoftwareRendering` (boolean). A missing file, missing key,
unreadable file or malformed JSON means off; the reason is recorded and
logged once tracing starts. `main` resolves the file with
`std::env::home_dir()` and `BIBCODE_HOME` through the same
`resolve_data_root` and `dev`/`userdata` rule as `config::state_dir`; that
rule moves into one helper both use, so the two cannot disagree.

### 2. Default

- **Off (recommended).** Tauri's Linux graphics guidance is not to ship
  these variables unconditionally. Software rendering moves painting to
  one CPU thread, and most machines are not affected.
- **On for detected Intel GPUs.** Rejected: detection before Tauri means
  probing DRM devices, the hang is not limited to one device ID, and it
  would slow every unaffected Intel machine.

### 3. Override without a window

`BIBCODE_SOFTWARE_RENDERING=1` turns it on and `=0` turns it off for that
launch, winning over the stored setting in both directions. Any other
value, including empty, is ignored, the stored setting applies, and a
warning is logged once tracing starts. Together with editing the JSON key,
this covers a machine where no window can be shown.

### 4. Which variables, and the user's own values

When on, BiBCode sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` and
`WEBKIT_DISABLE_DMABUF_RENDERER=1`. `WEBKIT_SKIA_ENABLE_CPU_RENDERING` is
not set: the issue shows it alone did not prevent a hang.

A variable present in the environment, with any value including empty, is
the user's and is never overwritten or removed. The check is per variable,
so a user who exported one still gets the other.

A restart inherits the environment, so a value BiBCode set would look
exported in the next process, and turning the setting off then restarting
would keep software rendering on. BiBCode therefore also sets
`BIBCODE_SOFTWARE_RENDERING_SET` to the comma-separated names it set. At
start, a variable named in an inherited marker is treated as BiBCode's,
not the user's: it is removed before the decision, then set again only if
the decision is on. The marker is rewritten to the names set by this
launch, or removed when none.

- **Alternative: remove the variables before restarting.** Rejected: by
  then the process is multi-threaded, so mutating its environment is
  unsound, and it would not cover a BiBCode started from its own terminal.
- **Accepted limit:** a user who re-exports the same variable in a shell
  that also carries the marker (a BiBCode terminal) is indistinguishable
  from an inherited value; that launch follows the setting.

### 5. What child processes inherit

- **Inherit everywhere (recommended).** WebKitGTK's child processes and
  the preview webviews in this process need the variables to stay off the
  GPU. Terminals, providers and Git also inherit them and the marker.
  Their only effect is on another WebKitGTK program started from a BiBCode
  terminal, which then also runs without GPU compositing: the safe
  direction on an affected machine, and what the `AppRun` workaround
  already does.
- **Remove them from user-facing children.** Rejected for now: it needs a
  change to the server's shared AppImage isolation policy
  (`apps/server/src/process/appimage.rs`), outside this phase's ownership,
  and the policy would need the marker to tell BiBCode's values from the
  user's. No reported problem requires it.

### 6. Code shape

- New module `apps/desktop/src-tauri/src/software_rendering.rs`. A pure
  function takes the stored setting, the override value, a lookup of the
  current environment (variables and marker) and whether the platform is
  Linux, and returns the variables to set, the inherited ones to remove,
  the new marker, and whether software rendering is active. It compiles on
  every platform so its tests run anywhere; off Linux it changes nothing.
  The file read takes the path as a parameter, so tests use a temporary
  directory.
- `main` calls the Linux-only apply step after the open-url and CLI
  branches have exited and immediately before `run()`: the crash hook is
  still first, the process is still single-threaded, and the CLI paths,
  which create no webview, skip the file read. The decision is kept in a
  `OnceLock` and logged in `setup`.
- Bridge: `getLinuxSoftwareRendering()` and
  `setLinuxSoftwareRendering(enabled)` return `{ enabled, override,
  active }`, where `override` is `"on" | "off" | null` and `active` is
  this launch's decision. Files: `bridge.rs` (settings field and two
  commands), `lib.rs` handler lists, `permissions/desktop-bridge.toml`,
  `packages/contracts/src/ipc.ts`, `apps/web/src/tauriDesktopBridge.ts`.
  The methods are optional on the bridge type, as `restartApp` is, so the
  bridge version does not change.
- Settings: a row in `AppearanceSettingsPanel.tsx`, shown only when
  `isLinuxPlatform(navigator.platform)` and the bridge has the methods. A
  switch labelled "Render without the GPU", with one line on what it is
  for and its cost. When `override` is set, the switch is disabled and says
  that `BIBCODE_SOFTWARE_RENDERING` controls it. When `enabled` differs
  from `active`, the row says a restart is needed and offers "Restart now"
  through the existing `restartApp`.
- Docs: `docs/user/linux-desktop.md` gets the setting, the variable and
  the JSON key; `docs/testing/linux-desktop.md` gets the packaged check.

## Not changed

macOS and Windows behavior, the crash hook order, the AppImage hooks, the
child isolation policy and the deep-link plugin. Whether the hang stops on
the affected machine is not proven by this change; issue #411 stays open
until its owner reports the 20 launches and 24-hour run.
