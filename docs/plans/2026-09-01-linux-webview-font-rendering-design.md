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

## Revision 3 (same day) — spacing regression traced to full hinting

The user's screenshot and a capture of the packaged AppImage under Xwayland
showed uneven whole-pixel gaps inside words: “prim ary”, “s erver”, “No t
hreads yet”, “Securi ty”, “st andards”, and “SECURIT Y”. The measured session
was Fedora 44 on GNOME Wayland at display scale 1.0, with the non-default GNOME
`font-hinting='full'` (GNOME defaults to `slight`) and
`font-antialiasing='rgba'`. The reference Electron app on the same machine
uses Geist Variable with body `letter-spacing: 0.01em` and sets no Chromium
font-rendering switches.

Revision 2's headless harness ran at GTK's default `hintmedium`: its isolated
`settings.ini` hint style never reached GDK on X11. It therefore could not
reproduce the user's `hintfull` session. More importantly, the user's complaint
was spacing rather than stroke density, and Revision 2's added tracking made
that spacing worse.

WebKit source (`Source/WebCore/platform/graphics/skia/FontPlatformDataSkia.cpp`
and `FontRenderOptionsSkia.cpp`) and Chromium source
(`ui/gfx/font_render_params_linux.cc`) explain the measurements. At device
scale 1.0, both engines disable subpixel glyph positioning when the session
hint style is `full` and rasterize fully hinted glyphs at whole-pixel
positions; with any other hint style WebKitGTK forces subpixel positioning on.
The `0.01em` tracking adds a fractional advance of about 0.13px at 13px, which
accumulates and periodically snaps into an extra whole-pixel gap in both
engines. WebKitGTK's fully hinted DM Sans additionally shows gaps without
tracking, while Chromium's does not.

Oversized (≥3px) intra-word gaps per 56-character no-space line at 13px were
deterministic across 3 runs:

| Font/CSS variant                                | WebKitGTK `hintfull` | WebKitGTK `hintslight` | Chromium `hintfull` |
| ----------------------------------------------- | -------------------: | ---------------------: | ------------------: |
| DM Sans 400                                     |                    7 |                      0 |                   0 |
| DM Sans 400 + `0.01em`                          |                   12 |                      0 |                   4 |
| DM Sans 450                                     |                    7 |                      0 |                   0 |
| DM Sans 450 + `0.01em` (shipped Revision 2 CSS) |                   12 |                      0 |                   5 |
| Geist 400 + `0.01em`                            |                    2 |                      0 |                   2 |
| Geist 400                                       |                    0 |                      0 |                   0 |
| System font (Adwaita Sans)                      |                    0 |                      1 |                   0 |

WebKitGTK `hintnone` also measured 0 for every DM Sans and Geist row, and
Chromium `hintslight` and `hintnone` measured 0 for the DM Sans rows. With the
system still at `hintfull`, an application-level GtkSettings override to
`gtk-xft-hintstyle=hintslight` measured 0 for every DM Sans row, including when
applied after the page loaded; WebKitGTK re-rendered on the settings change.
Under `hintslight`, mean ink per row was 280 for DM Sans 400 and 300 for DM Sans
450 (+7%).

**Superseding decision:** combine a process-local host correction with the
smallest CSS correction, retaining the measured stroke-density improvement:

- **Application GtkSettings override — accepted.** On Linux, when the session
  reports hinting enabled with `hintfull`, the desktop host pins its own
  `gtk-xft-hintstyle` to `hintslight` in
  `apps/desktop/src-tauri/src/linux_text_rendering.rs`. Application-source
  settings outrank XSettings/GSettings, so this leaves the user's system
  preference untouched. Remove body tracking, keep body `font-weight: 450`,
  and keep the `pre`/`code` weight pin at 400.
- **Switch the product typeface to Geist — rejected.** Geist at weight 400
  without tracking fixes WebKitGTK spacing without a host change, but changing
  cross-platform typography is outside a Linux bug fix; Geist with tracking
  still shows 2 gaps.
- **Remove tracking only — rejected.** This removes Revision 2's regression but
  leaves 7 gaps in fully hinted WebKitGTK DM Sans.

The known side effect is that the app's own native GTK menu bar also renders
with `hintslight`. Whether the application-source override survives a later
live change to the system preference was not verified and remains residual
risk.

Verification: rebuild the AppImage, capture the packaged app under Xwayland
with the same temporary-HOME harness, and require the “prim ary” and “No t
hreads yet” gaps to be gone and the 13px matrix to measure 0 gaps on every DM
Sans row.

## Revision 4 (same day) — LCD text inside scroll containers is app-side after all

After Revision 3 the packaged app still read noticeably softer than the
reference Electron app. Measuring color fringing (the share of text ink pixels
carrying subpixel color) on an Xwayland capture of the packaged app: the static
title text was 0.956, every text inside the sidebar and other scrollers 0.000.
Revision 2 recorded grayscale-in-scrollers as "engine behavior with no public
knob, not fixable app-side". That sentence is retracted: the Revision 2 harness
never tested a painted descendant inside the scroller.

A real WebKitGTK 2.52 window on the user's session (Xwayland, accelerated
compositing, `gtk-xft-rgba=rgb`) rendered 30 DOM variants. The rule that
survived every case:

- Text placed directly on the scrolled contents of an `overflow: auto` element
  renders grayscale (0.000), whatever background the scroller itself paints
  (`#fff`, `#fefefe`, `#f7f7f7`, 50% white, `background-attachment: local`).
- Text inside any ancestor _within_ the scroller that paints a background
  renders LCD (0.91–0.94). Partial coverage, half width, 99% alpha, a light
  grey, a fade `mask-image` on the scroller, nesting three levels deep, and a
  composited wrapper (`will-change: transform`, `translateZ(0)`) all pass; the
  plain painted wrapper is the cheapest and is the one used.
- A plain block outside any scroller renders LCD (0.936), matching the
  reference app's fringe ratio measured on the user's earlier screenshot.
- The Wayland web process paints the same way when compositing is disabled,
  so the rule is a property of composited scroll layers, not of the backend.
- Two more suppressors found by bisecting the real sidebar DOM in the same
  harness: the scroll-fade `mask-image` that `ScrollArea` applies to its
  viewport (sidebar crop 0.000 with it, 0.667 without it; icons count as ink)
  and any element `opacity` below 1 on the text's ancestors (0.015). A
  translucent text _color_, `color-mix` with transparency, a `button`, a
  transformed ancestor, and `position: fixed` all keep LCD.
- Observation not relied on: in a dark scroller (`#1a1a1a` with light text) even
  bare text showed color fringes. The painted-wrapper rule held in dark theme
  too, so the implementation does not depend on this.

Font candidates (DM Sans 400/450, Geist 400, Adwaita Sans, Noto Sans, Open Sans)
were rendered inside an LCD-enabled scroller at `hintslight` and `hintfull`.
At `hintslight` every font reads evenly; DM Sans 450 is the current shipped
face. At `hintfull` every font including Geist shows whole-pixel letter gaps
("lo aded"). The typeface was therefore never the lever; the hinting pin from
Revision 3 stays.

**Decision:** keep DM Sans and the `hintslight` pin; mark the content wrapper
of each main reading surface with `data-text-surface="background|card|sidebar"`
and, under `html[data-linux-webkit]` only, paint the matching theme token on it.
Surfaces covered: sidebar content, chat timeline rows, the Agents view list, and
the settings scroller. The Linux webview also drops the `ScrollArea` scroll-fade
mask (cosmetic) because it suppresses LCD text underneath it. Not covered (still grayscale until marked): popovers,
the command palette, git manager panes, file preview and diff virtualizers, and
the other `ScrollArea` consumers. A `will-change` layer per surface was rejected:
it adds GPU memory on tall transcripts for no measured gain over the painted
wrapper.

Verification: rebuild the AppImage, capture it under Xwayland with the same
temporary-HOME harness, and require the sidebar text crop's fringe ratio to
rise from 0.000 to at least 0.85 while the static title stays LCD. The chat
timeline is verified by analog (per-row painted wrapper equals harness
variants 8 and 24) because the throwaway HOME has no thread to render.

## Revision 5 (same day) — sidebar typography floor and contrast

With LCD text restored, the remaining gap against the reference Electron app in
the user's side-by-side screenshot was typographic, not rendering: its sidebar
navigation rows are 13px medium on a near-black foreground at 60% alpha, while
BiBCode's were 12px regular on the muted foreground at 70% alpha (two
reductions stacked), and badges such as `primary` were 9px. Published minimums
agree: Apple's macOS guidance accepts 11pt as the smallest text, and both
Apple and Material put comfortable body text well above that.

**Decision:** add a theme token `--text-2xs` (11px, 1rem line height) as the
smallest size in the app and use it for every 8/9/10px label in the sidebar,
the Agents view, and timeline metadata; set navigation rows and project and
thread titles to 13px medium on `foreground/80`; never alpha-reduce
`muted-foreground` for text (badges, subtitles, and empty states use the solid
token). The `primary` badge gains a border at 11px. Remaining `text-[9px]` and
`text-[10px]` uses outside those surfaces (settings diagnostics, worktree
discovery, status bar, git manager) are a follow-up sweep to the same token.
If 11px still reads small on the user's display, raise the token to 12px
rather than adjusting individual labels.
