# Linux AppImage XWayland Taskbar Icon Design

## Status

This design supersedes
`2026-08-07-linux-appimage-kde-wayland-taskbar-icon-design.md`. Runtime and
artifact inspection disproved that document's GTK application ID hypothesis
before implementation. The earlier document remains unchanged as historical
evidence.

## Summary

When the BiBCode AppImage is executed in a KDE Plasma Wayland session, its
running window has no icon in the taskbar. Although the desktop session uses
Wayland, the AppImage's generated GTK AppRun hook forces the application onto
X11, so KWin manages the window through XWayland.

BiBCode supplies Tauri only a 1024 by 1024 PNG for Unix runtime window-icon
generation. GTK3 rejects that icon as too large for its X11 property request
and deletes `_NET_WM_ICON`. BiBCode will add a checked-in 128 by 128 Linux
runtime derivative and list it before the 1024-pixel source in `bundle.icon`.
Tauri will embed the smaller image into the native window while retaining the
larger image for AppImage file and bundle presentation.

## Confirmed Root Cause

The released v0.3.5 AppImage was downloaded, extracted, and executed on the
reported KDE Plasma Wayland host. The reproduction established all of the
following:

- The session reports `XDG_SESSION_TYPE=wayland`.
- The bundled `apprun-hooks/linuxdeploy-plugin-gtk.sh` exports
  `GDK_BACKEND=x11`.
- The running BiBCode process inherits `GDK_BACKEND=x11` and is therefore an
  XWayland client.
- Its X11 window exposes `WM_CLASS("bibcode-desktop", "Bibcode-desktop")` and
  the expected BiBCode title.
- `xprop` reports `_NET_WM_ICON: not found` for that window.
- The AppImage contains the expected desktop entry and
  `usr/share/icons/hicolor/1024x1024/apps/bibcode-desktop.png`.

The native source path explains the missing property:

1. Tauri code generation selects the first PNG in `bundle.icon` as the Unix
   default window icon.
2. BiBCode's first and only PNG in that list is
   `assets/prod/black-universal-1024.png`.
3. Tauri applies the decoded image to each configured window.
4. GTK3's X11 backend stops before adding an icon when
   `current_size + 2 + width * height` exceeds its capped X11 request size.
5. A 1024 by 1024 image exceeds that cap, leaving the serialized icon list
   empty; GTK then deletes `_NET_WM_ICON`.

This behavior is independent of the GTK application ID. Enabling
`app.enableGTKAppId` would not reduce the icon payload or create the missing
X11 property.

## Goals

- Make the directly executed BiBCode AppImage expose a valid `_NET_WM_ICON`
  under its current XWayland runtime.
- Display the canonical BiBCode icon in the KDE Plasma taskbar.
- Retain the 1024-pixel canonical Linux icon for high-resolution AppImage file
  and bundle presentation.
- Protect the runtime icon's ordering, dimensions, color type, and payload
  bound with portable automated coverage.
- Preserve non-Linux icon assets and runtime behavior.

## Non-Goals

- Change or remove the AppImage GTK hook's forced X11 backend.
- Add `enableGTKAppId`, a custom desktop entry, AppImage self-integration, or a
  new application identifier.
- Change taskbar grouping, `WM_CLASS`, executable naming, or product naming.
- Add runtime image decoding, scaling, or filesystem access.
- Redesign the BiBCode artwork.

## Chosen Approach

Create `assets/prod/black-universal-128.png` as a 128 by 128 RGBA derivative of
`assets/prod/black-universal-1024.png`. Generate it once with ImageMagick's
Lanczos resize and commit the result; ImageMagick does not become a build or
runtime dependency.

Order the Tauri icons as follows:

```json
"icon": [
  "../../../assets/prod/black-universal-128.png",
  "../../../assets/prod/black-universal-1024.png",
  "../../../assets/prod/bibcode-black-windows.ico",
  "../../../assets/prod/bibcode-black-macos.icns"
]
```

Tauri's Unix context generator selects the first matching PNG, so the
128-pixel asset becomes the window icon. Its X11 payload contains 16,386
cardinals including width and height, safely below GTK3's cap of 262,144.

The AppImage bundler copies every configured PNG into the hicolor icon tree and
selects the largest square icon for the root AppImage icon. The existing
1024-pixel image therefore remains the AppImage presentation asset even though
the smaller image is listed first.

## Rejected Alternatives

### Enable the GTK Application ID

The artifact does not use GTK's Wayland backend. The missing taskbar icon is an
absent X11 `_NET_WM_ICON` property caused by payload size, so changing
application identity does not address the failing boundary.

### Resize the Icon in Rust

Loading and resizing the 1024-pixel image during application startup would add
CPU work, memory allocation, failure handling, and either a new image-processing
dependency or custom scaling code. Tauri already supports selecting a suitable
checked-in window icon at compile time.

### Use a Web Favicon

The existing 32-pixel favicon would fit the X11 property but couples native
desktop packaging to web-specific artwork and provides less source resolution
than a dedicated desktop runtime derivative.

### Force Native Wayland

Removing the GTK hook's X11 override is a separate compatibility decision. The
hook documents an upstream Tauri/GTK crash path, and changing it would expand
this focused icon fix into graphics-backend and distribution compatibility
work.

## Component Ownership and Boundaries

`assets/prod/black-universal-128.png` is the native Linux runtime derivative.
`assets/prod/black-universal-1024.png` remains the high-resolution canonical
source and AppImage presentation icon.

`apps/desktop/src-tauri/tauri.conf.json` owns icon ordering for both Tauri code
generation and packaging. No Linux-specific runtime code is needed.

`scripts/tauri-hardening.test.ts` owns the portable configuration and asset
contract. It will require:

- the 128-pixel PNG to be first in `bundle.icon`;
- the 1024-pixel PNG to remain immediately after it;
- both PNG files to exist and use RGBA color type;
- the runtime image to decode to exactly 128 by 128 pixels; and
- `width * height + 2` to remain below GTK3's 262,144-cardinal cap.

There is no server, frontend, RPC, persistence, updater, or `DesktopBridge`
change. No living architecture document changes because package ownership,
runtime topology, protocol flow, persisted shape, and trust boundaries remain
unchanged.

## Failure Handling

This change adds no runtime failure path. A missing, reordered, malformed,
wrong-sized, or oversized runtime PNG fails the portable hardening test before
packaging. The real artifact check remains necessary because a future Tauri,
GTK plugin, or bundler change could alter which image reaches the window.

## Testing and Verification

Implementation follows test-driven development:

1. Extend the hardening test with the new icon-order and payload-bound contract,
   then verify it fails because the runtime asset and configuration entry are
   absent.
2. Generate the 128-pixel derivative and place it first in `bundle.icon`.
3. Run the focused hardening test and broader desktop checks.
4. Run `vp check` and `vp run typecheck`.
5. Build the AppImage through `vp run dist:desktop:linux`.
6. Extract it and confirm both 128- and 1024-pixel hicolor icons are present,
   with the 1024-pixel image still selected as the root AppImage icon.
7. Execute the artifact on KDE Plasma, use `xprop` to confirm `_NET_WM_ICON`
   exists on the BiBCode window, and visually confirm the taskbar displays the
   BiBCode icon.

## Acceptance Criteria

1. The Unix runtime window icon is the checked-in 128 by 128 RGBA derivative.
2. The running AppImage exposes a non-empty `_NET_WM_ICON` property under KDE
   Plasma's XWayland path.
3. KDE displays the BiBCode icon in the taskbar.
4. The AppImage retains both hicolor icon sizes and uses the 1024-pixel image
   for its root icon.
5. The macOS ICNS, Windows ICO, web icons, and marketing icons are unchanged.
6. Focused tests, the desktop package test, `vp check`, and
   `vp run typecheck` pass.
