# AppImage child environment isolation

Status: **Approved by the user on 2026-09-23**. Amended on 2026-10-30 for
issue #209: the extracted-AppDir gate derives the root from the running
executable instead of `APPDIR`, also strips an inherited `APPDIR` that
names another AppDir, and the mounted gate also strips the executable's own
extracted AppDir (see [Gate and effective
environment](#gate-and-effective-environment)).

## Ownership and scope

`bibcode_server::process` owns one cross-platform child-command entry point,
with a no-op implementation off Linux. Standard, Tokio, and portable-pty
commands use adapters in `process/appimage.rs`; one loop applies the policy's
environment overrides. `isolate_appimage_environment(&mut command)` defaults
standard and Tokio commands to inherited environments. Explicit
`EnvironmentInheritance::{Inherit, Cleared}` belongs to
`ChildCommand::Process { command, inheritance }`; PTYs already hold their full
environment and accept no inheritance mode. The gate runs before copying an
environment. No schemas, persisted state, cancellation, or RPC boundaries
change. The desktop uses the same public helper for system commands. Linux
file-manager children use the detached ownership described below.

Provider commands share
`provider::environment::sanitize_provider_subprocess_environment`, which removes
`RUST_LOG` and delegates to the process policy. This provider-owned module has
no dependency on `production`; production services and provider terminals both
depend on it.

## Alternatives and decisions

- **Fixed names versus values:** inspect all effective environment values.
  linuxdeploy's `AppRun.wrapped` and downloaded GTK hook add Python, Qt,
  GStreamer, GTK, and other paths; a fixed list already missed Python startup.
  Retain non-bundled entries in order and leave wholly unrelated values byte
  for byte intact. This also covers future launcher variables without an
  application release, at the cost of scanning the environment on AppImage
  child spawns.
- **Restore versus strip:** strip entries under the gated AppDir root or absolute paths
  with a `.mount_*` component. The launcher keeps no `ORIGINAL_*` copy, so the
  pre-launch environment cannot be restored. Do not invent distribution paths.
- **Per-child versus process-wide:** change only selected child commands.
  The desktop and WebKitGTK need bundled libraries. Global environment mutation
  would break them and race concurrent spawns in the in-process server.
- **Trailing empty entries:** AppRun appends `:<original value>`, commonly
  leaving a trailing colon. After bundled entries disappear, unset a variable
  if every survivor is empty. Commit e0de4ef4 converted a sole empty loader
  entry to `.`, allowing a repository's libraries to load; remove that rule and
  reverse its regression expectation. Keep empty entries alongside real host
  entries, including explicitly requested `.` entries. Unsetting an empty
  GStreamer system path also restores its ordinary plugin discovery.
- **Forced values:** remove `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`, `GTK_THEME`,
  `GDK_BACKEND`, `PYTHONDONTWRITEBYTECODE`, and `GTK_PATH`. The GTK hook overwrites
  `GTK_PATH` with both bundled and host directories without preserving the
  original; its surviving host directories are not user configuration. Shell
  rc files may reapply the user's own settings.

## Gate and effective environment

Retain the existing trigger: nonempty `APPIMAGE` and absolute, non-root
`APPDIR` make `APPDIR` the root. When the executable is not under that
`APPDIR` and has the extracted layout below, its `<root>` is a second root.
Also support manually extracted AppDirs
without `APPIMAGE`: the root is the directory `<root>` of a current executable
at `<root>/usr/bin/<name>` when `<root>` is not `/` and `<root>/AppRun` exists.
`APPDIR` does not choose this root; once gated it is removed like the other
launcher markers. If it names a different absolute, non-root directory that
contains `AppRun`, its entries are stripped as a second root, because an AppDir
launched from another extracted AppDir keeps the outer AppDir's paths. Pass the executable path to the policy for focused positive
and negative gate tests. Missing executable identity fails closed. A stray
`APPDIR=/usr` alone must not change a normal installed server's environment.

The 2026-10-30 amendment (#209) replaced the original extracted-AppDir rule,
which required the executable to be under `APPDIR` and `$APPDIR/AppRun` to
exist. The shipped `apprun-hooks/linuxdeploy-plugin-gtk.sh` keeps an inherited
`APPDIR`, while `AppRun.wrapped` builds `LD_LIBRARY_PATH` and the other paths
from its own location. A preset, mismatched `APPDIR`, or a launcher that execs
`usr/bin/bibcode-desktop` without one, therefore skipped isolation, and system
Git loaded the bundled `libnghttp2`. Alternatives considered:

- **Trust `APPDIR` versus the executable:** `APPDIR` is inherited state that
  the hook does not correct; `/proc/self/exe` names the directory whose paths
  the runtime actually added. Derive the extracted root from the executable.
- **Fixed layout versus ancestor walk:** walking every ancestor for `AppRun`
  costs a `stat` per ancestor on each PTY, Git, and provider spawn and could
  match an unrelated directory. The linuxdeploy layout is fixed, so check
  only `<root>/usr/bin/<name>`: at most one `stat`, none for an installed
  `/usr/local/bin` binary.
- **A second root from a valid `APPDIR`:** first rejected as speculative,
  because the runtime does not add paths under a stale `APPDIR`. Review then
  found the stacked case: extracted AppDir B launched from extracted AppDir A
  inherits A's `APPDIR` and A's `usr/lib` entries, and B's `AppRun.wrapped`
  only prepends its own paths. Stripping B alone left A's libraries for system
  Git, the issue's inherited-`APPDIR` hypothesis. So once the executable gate
  matches, an `APPDIR` naming a different absolute, non-root directory with
  `AppRun` is a second root. That costs one more `stat` only on gated spawns
  with such an `APPDIR`; an ungated process still ignores `APPDIR` entirely,
  and a stale or non-AppDir `APPDIR` adds nothing, so host paths under it stay.
- **Removing launcher markers without a root:** always removing `APPDIR`,
  `APPIMAGE`, `ARGV0`, and `OWD` was rejected; it would change an ordinary
  installation's children and break the no-op cases above.
- **Mounted AppImages:** `APPIMAGE` with `APPDIR` still activates the gate
  regardless of the executable location, and stale `.mount_*` entries are
  still removed. Review found a second stacked case: extracted AppDir B
  launched from mounted AppImage A inherits A's `APPIMAGE` and
  `APPDIR=/tmp/.mount_A…`, so the gate rooted only in A's mount and left B's
  own `usr/lib` for system Git. When the executable is not under `APPDIR`, the
  extracted-layout rule above now adds its `<root>` as well. A genuine mounted
  launch runs under `APPDIR`, so it gains one `/proc/self/exe` readlink per
  gated spawn and no `stat`, and its roots are unchanged.

Overlay command-local additions and removals on the inherited environment;
`Cleared` commands never recover ambient values. PTYs use their captured
environment. A minimal raw `iter_full_env` accessor in vendored portable-pty is
necessary: its UTF-8 iterator drops raw entries, and reconstructing from parent
names misses newly added non-UTF-8 command overrides. The accessor contains no
isolation policy. Colon separates entries; `LD_LIBRARY_PATH` additionally accepts
semicolon and `LD_PRELOAD` space. Parent state never changes.

## Covered and deliberately excluded launches

Cover PTYs, provider processes and probes, Codex/OpenCode helpers, Git and
review Git commands, editor/file-manager launches, and desktop-owned system
commands where the command environment is controllable (SSH, Tailscale probes,
and the host `kill` command used during backend shutdown). Tests must exercise
each covered launch class and fail when its isolation call is removed.

Exclude the desktop process and WebKitGTK-owned children, desktop
`BackendLaunchTarget::ExternalProcess`, and the generic supervised runner:
these can require or launch BiBCode's bundled binaries. Plugins that spawn
internally without environment control are reported with source locations for
a separate decision; this change does not patch those plugins. Remote SSH
commands retain their existing remote-environment semantics.

The login-shell PATH probe is also exempt. Its captured PATH hydrates the
desktop process in `hydrate_posix_path` before Tauri starts in `lib.rs`; changing
that child environment would remove or reorder the desktop's own AppDir paths.
Keep the probe's original environment, process-group cleanup, timeout, and
capture behavior. Its regression requires the original AppDir-first PATH,
unchanged AppImage markers and other launcher values, and an unchanged parent
environment.

Linux file-manager launching uses `open::commands` and isolates each candidate.
A fallible named reaper thread takes ownership of the command before spawning
any child. The command is configured with the safe `process_group(0)` API and
null stdio. The thread calls `spawn`, reports its result through a channel, and
owns the child handle until
`wait` completes, even if the caller has gone away. Opening therefore returns
without waiting for a long-lived GUI process. Preserve opener order and
thread/spawn-error fallback; a thread-start failure creates no child. Exit
status after a successful spawn remains outside the launch result. This
replaces the copied double-fork approach: no raw `fork`, `waitpid`, or `pre_exec`
closure runs Rust allocation or opener logic after a fork in the multithreaded
server. Other platforms keep `open::that_detached`, including Windows
ShellExecute enabled by the desktop plugin dependency graph. No plugin
internals are copied or patched.

Desktop URL/path opening through `tauri-plugin-opener` remains unresolved: its
internal commands expose no environment customization API. The affected call
sites in `apps/desktop/src-tauri/src/bridge.rs` are:

- `desktop_bridge_open_project_data_path`, line 1078: `open_path`.
- `desktop_bridge_open_external`, line 1890: `open_url`.
- `desktop_bridge_open_in_file_manager`, line 1904: `open_path` for directories.

The same file's `reveal_item_in_dir` call at line 1906 uses D-Bus on Linux and
does not spawn a local opener. This limitation is separate from the server's
file-manager launch boundary.

Linux deep-link registration is another plugin boundary without command
environment control. `apps/desktop/src-tauri/src/lib.rs:120` calls
`app.deep_link().register_all()` during startup. In `tauri-plugin-deep-link`
2.4.10, `src/lib.rs:351` starts `update-desktop-database` and `:358` starts
`xdg-mime` for registration. Both inherit the desktop's AppImage environment.
These calls use `status()` but discard the returned exit status. A failure to
start a command becomes an `Err` logged as a warning at
`apps/desktop/src-tauri/src/lib.rs:121`; a tool that starts and exits nonzero
because of bundled libraries fails silently and can leave the `bibcode://`
handler missing. The plugin also starts `xdg-mime` for `is_registered` at
`src/lib.rs:459`, but BiBCode does not call that method. This change does not
patch the plugin.

## Known residual launcher behavior

The pinned GTK hook sets
`XDG_DATA_DIRS="$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS"`. With the original
variable unset, removing the AppDir entry leaves `/usr/share:`. This loses the
usual `/usr/local/share` default and adds an empty, working-directory-relative
entry. The child policy preserves empty entries alongside surviving host
entries and cannot know whether the original variable was unset, so it does
not reconstruct that default. A candidate follow-up is a packaging-time hook
rewrite that preserves the original/default semantics before launch. This
change only records the limitation; it does not implement that rewrite.

## Validation

Use real launcher-shaped trailing-colon fixtures, the incompatible-library Git
loader regression, all five ordinary-launch no-op cases, extracted-AppDir gate
tests, raw-byte and explicit-override coverage, real Python PTY execution, and
focused tests for each additional launch class and the desktop PATH-probe
exemption. A Python skip is unavailable evidence: require its stdout completion
marker with `--nocapture`. Run Rust
formatting, server/affected desktop Clippy, focused suites, `vp check`, and
`vp run typecheck`; host review supplies socket and live packaged-app evidence.
