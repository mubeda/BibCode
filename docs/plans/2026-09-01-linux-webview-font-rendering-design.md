# Linux webview font rendering — session subpixel mirror (design)

Date: 2026-09-01. Status: approved (user-requested fix after the diagnosis
below). Scope: `apps/desktop` Linux only.

## Problem

On Linux the desktop app's text renders with grayscale antialiasing while the
rest of the desktop renders subpixel (LCD) text, so BiBCode looks thin and
fuzzy next to every other app. Measured on user screenshots: 51.4% of text ink
pixels carry subpixel color fringes in a Chromium-based app on the same
desktop; 0.0% in BiBCode.

Verified mechanism:

- GNOME publishes the user's subpixel preference (`font-antialiasing='rgba'`)
  to apps via XSettings/GtkSettings (`gtk-xft-rgba=rgb`), not via fontconfig;
  Fedora's fontconfig leaves `rgba` **unknown**.
- Chromium consults GtkSettings; WebKitGTK's Skia web process (2.46+) consults
  **fontconfig only**. With `rgba` unknown it renders grayscale.
- WebKitGTK 2.52 renders correct subpixel text when fontconfig supplies
  `rgba` (proved with a `FONTCONFIG_FILE` harness: fringe ratio 0 → 0.906).
- Not caused by AppImage library bundling (bundled cairo/pango/WebKit match
  the system) and not a settings-delivery failure (GtkSettings resolve
  identically inside the AppImage environment).

## Decision

At the very top of `bibcode_desktop_lib::run()` — before
`shell_environment::hydrate_process_path()`, any plugin, thread, or webview —
the Linux desktop host mirrors the session's subpixel preference into a
process-scoped fontconfig file and exports `FONTCONFIG_FILE`, so the WebKit
web processes it spawns inherit it.

Behavior (`apps/desktop/src-tauri/src/linux_font_rendering.rs`):

1. No-op unless `target_os = "linux"`.
2. No-op if `FONTCONFIG_FILE` is already set (user/environment intent wins).
3. `gtk::init_check()`; on failure (headless) no-op. Pre-initializing GTK
   ahead of tao is tolerated: `gtk_init` is idempotent.
4. Read `gtk-xft-rgba` and `gtk-xft-antialias` from `GtkSettings` (these carry
   the XSettings-resolved session values under both X11 and Wayland).
5. Mirror only when antialiasing is not disabled and rgba is one of
   `rgb|bgr|vrgb|vbgr`. `none`/unset → no-op (the session did not ask for
   subpixel; mirroring nothing is the correct parity).
6. Write the mirror config to `$XDG_RUNTIME_DIR/bibcode-fontconfig.conf`
   (user-private dir; fallback: skip with a recorded reason rather than
   writing to a world-writable location).
7. `std::env::set_var("FONTCONFIG_FILE", …)` inside `unsafe` with a SAFETY
   comment (process still single-threaded; same justification as the existing
   PATH hydration at `shell_environment.rs:504`).
8. Defer logging: return a small report value that `run()` hands to
   `tracing` once telemetry is initialized (mirrored/skipped + reason).

Mirror config content (generated):

```xml
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <match target="font">
    <test name="rgba" compare="eq"><const>unknown</const></test>
    <edit name="rgba" mode="assign"><const>RGBA</const></edit>
    <edit name="lcdfilter" mode="assign"><const>lcddefault</const></edit>
  </match>
</fontconfig>
```

The `rgba == unknown` guard means an explicit fontconfig choice by the user
(e.g. KDE's fontconfig-persisted settings, or a hand-written
`~/.config/fontconfig/fonts.conf` rule — both reachable through the standard
include chain) always wins; the mirror only fills the value fontconfig left
undecided. Hinting is deliberately untouched: Fedora configures
`hintstyle=hintslight` in fontconfig explicitly, and overriding it with the
legacy XSettings `hintfull` would change glyph shapes, not fix the reported
defect.

## Alternatives rejected

- **CSS weight bump for Linux WebKit** — hides the thinness, cannot restore
  subpixel rendering; papering over the mechanism.
- **Hardcoding `rgba=rgb`** — wrong on displays where the session says
  grayscale (HiDPI users who disabled subpixel, unusual panel geometries).
  Mirroring the session is what Chromium effectively does.
- **Waiting for upstream WebKitGTK** to honor XSettings — correct long-term,
  unusable now.
- **Reading GSettings directly** — GNOME-only and schema-dependent;
  GtkSettings is the DE-neutral aggregation point (KDE feeds it via
  xsettingsd/kde-gtk-config).

## Testing

- Pure-function tests: config generation (exact XML for each rgba value) and
  the mirror decision table (env set / rgba none / antialias off / missing
  runtime dir), with the GTK read isolated behind a seam so tests run
  headless.
- `cargo fmt --check`, desktop-crate tests, Clippy `-D warnings`.
- Live verification (the diagnosis feedback loop): rebuild the AppImage,
  launch on the real display, screenshot, and require text fringe ratio > 0.3
  where the pre-fix measurement was 0.0.

## Revision 2 (same day) — original decision superseded by measurement

Instrumenting the real AppImage headlessly (Xvfb + isolated HOME + GTK
`settings.ini`, root-window capture, per-region subpixel-fringe metrics)
falsified the original mechanism before implementation landed:

- With the session preference reaching GTK, the app's **static chrome already
  renders subpixel** (menu bar 0.888, top bar 0.713, toast 0.885 fringe
  ratio) — the GtkSettings→web-process plumbing works without our help.
- Text inside **scrollable containers renders grayscale in every mode**
  (sidebar list 0.000; by extension the chat transcript and terminal — the
  surfaces users actually read). `WEBKIT_DISABLE_COMPOSITING_MODE`,
  `WEBKIT_DISABLE_DMABUF_RENDERER`, and `WEBKIT_SKIA_ENABLE_CPU_RENDERING`
  change nothing. This per-scroll-layer grayscale is engine behavior with no
  public knob; Chromium keeps LCD text on such layers, which is the visible
  BiBCode-vs-Electron delta.
- The fontconfig mirror is additionally unreachable: the web process runs in
  WebKit's bubblewrap sandbox, which cannot see a process-private
  `FONTCONFIG_FILE` path (verified: forcing one changes nothing in the app
  while changing an unsandboxed harness).

**Superseding decision:** compensate typography on the surfaces the engine
insists on rendering grayscale, scoped to the Linux desktop webview only:

- When the desktop bridge is present and the platform is Linux, the web app
  stamps `data-linux-webkit` on `<html>` (pure, unit-tested gate).
- CSS under that attribute sets body `font-weight: 450` (DM Sans Variable
  instances the axis; measured stroke density mean-ink 116.9 → 120.1,
  dark-stem ratio 0.236 → 0.267, visually fuller without reading as bold)
  and `letter-spacing: 0.01em` (the same global tracking the reference app
  uses); `pre`/`code` pin `font-weight: 400` so the mono stack does not jump
  to its 500 face.
- Chromium browser mode and macOS/Windows webviews are untouched.

Verification: rebuild the AppImage and re-run the headless capture; require
the sidebar text crops' mean-ink density to rise accordingly, with
screenshots for the user's subjective judgment. The subpixel gap inside
scrollers is recorded as an upstream WebKitGTK limitation, not fixable
app-side.
