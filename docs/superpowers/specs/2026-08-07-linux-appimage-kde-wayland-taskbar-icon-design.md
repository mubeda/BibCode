# Linux AppImage KDE Wayland Taskbar Icon Design

## Summary

When the BiBCode AppImage is executed directly in a KDE Plasma Wayland
session, its running window does not display the bundled BiBCode icon in the
taskbar. The Linux bundle already contains the canonical RGBA PNG, and Tauri
already supplies that image as the window's default icon. The missing boundary
is the GTK application identity used by the Wayland desktop shell.

BiBCode will enable Tauri's GTK application ID on Linux so the existing
`com.bibcode.desktop` identifier is applied to the GTK application. This is a
Linux-only configuration change; the icon assets and other platform bundles
remain unchanged.

## Confirmed Root Cause

KDE Plasma on Wayland resolves a running application's desktop identity rather
than relying on the X11 window-icon path. BiBCode has all of the bundle inputs
needed for that lookup:

- `bundle.icon` includes `assets/prod/black-universal-1024.png`;
- the PNG is an RGBA image and is covered by the existing Tauri hardening test;
- the application identifier is the valid reverse-domain name
  `com.bibcode.desktop`;
- Tauri installs the bundled image as the default icon for configured windows.

However, `app.enableGTKAppId` is absent from both the base and Linux Tauri
configuration. Tauri defaults that option to `false`. Its runtime passes the
configured identifier to the GTK event loop only when the option is enabled,
so the current Wayland window has no stable BiBCode application ID for KDE to
associate with its packaged desktop metadata.

The reported environment is KDE Plasma on Wayland. This matches the upstream
Tauri failure mode in which a configured icon is replaced by a generic Wayland
icon when the application is run under Wayland.

## Goals

- Make a directly executed BiBCode AppImage display the BiBCode icon in the KDE
  Plasma Wayland taskbar.
- Use `com.bibcode.desktop` as the single application identity already owned by
  the Tauri configuration.
- Keep Linux package metadata and the GTK runtime identity aligned.
- Prevent removal or accidental disabling of this Linux contract.
- Preserve macOS, Windows, web, and marketing icon behavior.

## Non-Goals

- Redesign or regenerate any icon asset.
- Add a tray icon or change taskbar grouping behavior beyond establishing the
  correct application identity.
- Add a custom Linux desktop-entry template, AppRun wrapper, or installation
  mechanism.
- Change the product name, executable name, or bundle identifier.
- Change X11-specific `WM_CLASS` behavior unless the GTK identity setting
  naturally affects it through Tauri.

## Chosen Approach

Add the following Linux-only application configuration to
`apps/desktop/src-tauri/tauri.linux.conf.json`:

```json
"app": {
  "enableGTKAppId": true
}
```

Tauri merges this platform overlay into the base configuration. On Linux, the
runtime then passes the existing `identifier` to its GTK event-loop builder.
The source of truth remains `identifier`; the Linux overlay only opts into
using it at the native window boundary.

Scoping the option to `tauri.linux.conf.json` makes the platform intent
explicit and avoids changing configuration presented to macOS, Windows, or
mobile targets. No Rust setup hook is needed because Tauri owns this lifecycle
before application setup runs.

## Rejected Alternatives

### Set the Window Icon from Rust

Tauri already decodes the configured bundle icon and applies it as the default
window icon. Repeating that work in `setup` would create a second icon-loading
path without establishing the GTK application identity KDE Wayland needs.

### Add Custom Desktop or AppRun Metadata

A custom desktop template, `StartupWMClass`, or AppRun environment mutation
would replace Tauri's generated Linux metadata and introduce another identity
source. `StartupWMClass` is primarily an X11 compatibility mechanism and does
not address the missing GTK application ID at its source.

### Rename the Binary or Identifier

The existing reverse-domain identifier is valid and already owns application
configuration and data paths. Renaming it would broaden the migration surface
without addressing why Tauri currently omits it from GTK initialization.

## Component Ownership and Boundaries

`apps/desktop/src-tauri/tauri.linux.conf.json` owns the Linux-specific Tauri
runtime and bundle override. It will enable the GTK application ID while
leaving the base cross-platform configuration unchanged.

`scripts/tauri-hardening.test.ts` owns portable assertions about security- and
release-sensitive Tauri configuration. Its Linux configuration schema and
test will require:

- `app.enableGTKAppId` to be `true`;
- the base identifier to remain a valid GTK application ID; and
- the existing local AppImage tools setting to remain enabled.

The test will compare configuration values rather than private Tauri runtime
implementation. There is no server, frontend, RPC, persistence, updater, or
`DesktopBridge` change.

## Failure Handling

This change introduces no asynchronous or recoverable runtime operation. If the
identifier becomes invalid or GTK identity enablement is removed, the focused
configuration test fails before packaging. If a future Tauri release changes
the generated desktop metadata or runtime identity behavior, final AppImage
inspection and KDE Wayland acceptance testing remain the authoritative
user-visible checks.

## Testing and Verification

Implementation follows test-driven development:

1. Extend the Tauri hardening test to require Linux GTK application identity
   enablement and validate the configured identifier. Confirm it fails against
   the current configuration.
2. Enable `app.enableGTKAppId` in the Linux Tauri overlay and confirm the focused
   test passes.
3. Run the desktop package test and repository quality gates.
4. Build the Linux AppImage through the canonical artifact command.
5. Inspect the built artifact's desktop entry and icon payload to confirm they
   remain present and consistent with the application identity.
6. Execute the AppImage in a KDE Plasma Wayland session and confirm that its
   taskbar entry displays the BiBCode icon rather than a generic or missing
   icon.

The required automated commands are:

- the focused `scripts/tauri-hardening.test.ts` test;
- `vp run test:desktop` as the broader native desktop package check;
- `vp check`;
- `vp run typecheck`;
- `vp run dist:desktop:linux` for the real artifact boundary.

## Acceptance Criteria

1. The Linux merged Tauri configuration enables the GTK application ID.
2. The GTK application ID derives from the existing
   `com.bibcode.desktop` identifier rather than a duplicated literal.
3. A directly executed AppImage shows the BiBCode icon in KDE Plasma on
   Wayland.
4. The AppImage retains its generated desktop entry and canonical RGBA icon.
5. macOS, Windows, web, and marketing configuration and assets are unchanged.
6. Focused tests, `vp check`, and `vp run typecheck` pass, and any unavailable
   KDE visual verification is reported as residual risk.
