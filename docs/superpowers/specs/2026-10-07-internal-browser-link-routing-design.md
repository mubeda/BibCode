# Internal browser link routing (Phase 0) — design

Status: approved in conversation 2026-10-07; spec awaiting review.
Follow-up: [preview gateway (Phase 1)](2026-10-07-internal-browser-preview-gateway-design.md).
Research input (historical, verify before reuse):
`docs/plans/2026-10-06-internal-browser-and-mobile-emulator-research.md`.

## Goal

Every link a user clicks in BiBCode lands somewhere predictable: the internal
browser by default, the system browser on request, or an actionable notice when
the target cannot be reached from this client. Nothing silently opens the wrong
page and nothing goes nowhere.

What the user decided:

- Default target is the internal browser everywhere (chat already does this);
  the terminal and OSC 8 links follow it. Ctrl/Cmd (or middle-click) inverts to
  the system browser. A setting flips the default.
- Terminal `.html`/`.htm`/`.pdf` paths open in the internal browser; every other
  path still goes to the editor.

This phase adds no new server surface, protocol, or runtime topology. Remote
reach to server-loopback ports is Phase 1.

## Current behavior (verified at `eac7bcdc`)

| Source | Lands in today |
| --- | --- |
| Chat http(s) link, primary click | Internal browser, raw URL (`ChatMarkdown.tsx` → `openUrlInPreview` in `apps/web/src/browser/openFileInPreview.ts`) |
| Chat link with modifier / no thread / macOS < 14 | `<a target=_blank>` → nowhere on desktop (no `on_new_window`, opener plugin swallows it) |
| Chat `.html`/`.htm`/`.pdf` file link | Internal browser via signed `/api/assets` URL |
| Terminal loopback URL, Ctrl/Cmd-click | Two-item menu, no default (`openTerminalLinkInPreview.ts`) |
| Terminal non-loopback URL | System browser |
| Terminal file path (any type, incl. `.html`) | Editor on the server host |
| Terminal OSC 8 hyperlink | xterm default `confirm()` + `window.open` → nowhere |
| Git Manager PR anchors | `_blank` → nowhere on desktop |
| Agent `preview_open` on Tauri | Tab opens, then the tool reports failure: every `automation.*` in `apps/web/src/tauriPreviewBridge.ts` rejects, including `status` |
| `/api/assets` HTML | Served on the BiBCode UI origin with no CSP (`http_routes.rs` `asset`) |
| Port discovery | `"terminal": null` hard-coded (`apps/server/src/production/local_servers.rs`) |

`resolveDiscoveredServerUrl` (`apps/web/src/browser/browserTargetResolver.ts`)
swallows resolution errors and returns the raw URL, so remote environments
silently load the client's own `localhost`.

## Design

### Setting

`browserLinkTarget: "app" | "system"` in `packages/contracts/src/settings.ts`,
default `"app"`, client-side setting. Shown in Settings next to the existing
editor preference with copy that explains the modifier. No profile, history, or
per-surface variants.

### Router

One module, `apps/web/src/browser/openLink.ts`:

```ts
openLink(input: {
  url: string;                 // http(s) URL or file path already resolved by the caller
  kind: "url" | "file";
  threadRef: ScopedThreadRef | null;
  invert: boolean;             // modifier or middle-click held
}): Promise<OpenLinkOutcome>
```

Decision, in order:

1. `kind: "file"`:
   - `.html`/`.htm`/`.pdf` (and `file:///…` with those extensions) → signed
     asset URL via the existing `openFileInPreview` path, unless `invert`, which
     sends it to the editor. Outside the thread workspace → notice "This file is
     outside the workspace, so it can't be previewed. Open in editor?" with an
     action.
   - Anything else → editor (today's behavior).
2. `kind: "url"`:
   - Loopback host with a thread → `resolvePreviewTarget` (below) **first**,
     whatever the target. Unreachable → notice, never the client's localhost,
     even for `"system"`, a modifier click, browser mode, or an unsupported
     preview host. Reachable → continue with the resolved URL.
   - target = `invert ? flip(setting) : setting`.
   - `"system"` → `openExternal`.
   - `"app"` with no thread, preview unsupported on this host, or browser mode
     → system browser on desktop; new tab in browser mode (Phase 1 refines
     browser mode).
   - `"app"` → internal browser with the (resolved) URL.

Callers routed through it:

- Chat links (`ChatMarkdown.tsx`): primary, modifier, and middle click. The
  right-click menu stays.
- Terminal (`ThreadTerminalPanel.tsx`): URL link provider replaces the two-item
  menu with a direct `openLink`; file-path provider routes `.html`/`.htm`/`.pdf`
  through it; other paths unchanged.
- OSC 8: set xterm `linkHandler` to `openLink` (no `confirm()`).
- Git Manager PR anchors (`GitManagerPullRequestPanel.tsx`): `openLink` like
  any other URL (internal by default, modifier for system).

### Resolver

`resolveDiscoveredServerUrl` and `resolveBrowserNavigationTarget` merge into one
`resolvePreviewTarget(environment, url)` returning
`{ kind: "reachable", url } | { kind: "unreachable", reason }`. It never throws
and never falls back to the raw URL for a remote environment.

| Topology | Loopback URL resolves to |
| --- | --- |
| Local primary | itself |
| LAN / tailnet / WSL | `<environment host>:<port>` (works when the dev server binds non-loopback; otherwise the browser shows its own connection error) |
| SSH, relay | `unreachable` until Phase 1 |

Notice copy (UI.md review required): "This address is on <environment name>,
not this computer. Opening it here needs the preview gateway, which isn't
available yet for <SSH | BiBCode Connect> environments." with "Open in system
browser" as a secondary action only when the environment is local.

All existing callers (port cards, URL bar, agent `environment-port`) move to the
new function.

### Desktop `on_new_window`

Prerequisite: `tauri_plugin_opener::init()` (`apps/desktop/src-tauri/src/lib.rs`)
installs an injected click handler that swallows `_blank` http(s) anchors and
calls `plugin:opener|open_url`, which no capability grants. Register it as
`tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build()` so
`_blank` navigations reach `on_new_window`. Rust-side `openExternal` usage of
the plugin is unchanged.

In `apps/desktop/src-tauri/src/preview/host.rs` (preview children) and the main
window builder:

- Preview webview popup / `target=_blank` → new internal tab in the same thread
  (event to the web host through the existing preview event path), denied in the
  child itself.
- Main-window `target=_blank` → deny in-webview and emit to the web app, which
  calls `openLink` with `invert: false` (so it honors the setting).

### Agent `preview_open` on Tauri

`tauriPreviewBridge.ts` `automation.status` resolves to an "available, no
automation" status instead of rejecting. Other automation methods keep
rejecting with a clear "not supported in the desktop browser yet" error.
`PreviewAutomationHosts.tsx` treats the no-automation status as success for
open/navigate. Correct `docs/architecture/overview.md` (preview automation
claim) in the same change.

### Asset sandbox

`/api/assets` responses:

- `text/html` → `content-security-policy: sandbox allow-scripts allow-forms allow-popups`.
- `image/svg+xml` → `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`.

Trade-off accepted: agent-written HTML loses `localStorage`/cookies (opaque
origin).

### Port attribution

Fill `terminal` in `local_servers.rs` by matching listening-socket pids against
terminal session process trees the terminal manager already owns. Thread
attribution follows from the terminal's thread. No new RPC; the existing
`terminal`/thread filters in `portDiscoveryState.ts` start returning data.

Linux prerequisite: both `/proc/net/tcp{,6}` parsers return `pid: None` today.
Add a socket-inode → pid lookup (scan `/proc/<pid>/fd` symlinks for
`socket:[<inode>]`, limited to the terminal sessions' descendant pids, not the
whole host). Unreadable or vanished `/proc` entries are skipped (permission and
exit races), leaving that port unattributed. macOS/Windows keep their existing
pid sources.

## Failure and edge cases

- Environment disconnected while resolving → `unreachable` notice, no open.
- Thread closed between click and open → system browser fallback on desktop.
- `openExternal` failure → toast with the URL and a copy action.
- Setting change applies to the next click; nothing is migrated.
- macOS < 14 (preview unsupported) → `"app"` behaves as `"system"`.

## Testing

- Vitest: `openLink` decision table (setting × invert × kind × extension ×
  topology × preview support × browser mode); `resolvePreviewTarget` per
  topology, including "never returns raw URL for SSH/relay".
- Component tests: terminal URL click no longer shows the menu; OSC 8 handler
  routes; chat modifier click goes to system.
- Rust: asset CSP headers for HTML/SVG and absence for other types;
  `on_new_window` policy unit tests in the desktop crate; opener registered
  with link interception off; port attribution with a fake process tree and a
  Linux `/proc` fixture (inode match, unreadable fd dir, vanished pid).
- Vitest: remote loopback link with `"system"`, modifier, and browser mode all
  yield the notice, never `openExternal` of the raw URL.
- Tauri bridge test: `automation.status` resolves; `click` still rejects.
- `docs/testing/`: add an integrated-browser section (link routing matrix,
  modifier, OSC 8, popup, agent `preview_open`).
- Reviews: `UI.md` (notice, setting copy) and `vercel-react-best-practices`.

## Docs

- `docs/user/workspace-ui.md`: link behavior, setting, modifier; correct the
  "when the environment supports previewing" claim (the gate is the client host).
- `docs/architecture/overview.md`: preview automation on Tauri.
- `packages/contracts/src/preview.ts` header comment: Tauri child webview, not
  Chromium `<webview>`.

## Out of scope

Remote reach for SSH/relay (Phase 1), `BROWSER` hook (Phase 1), browser-mode
preview (Phase 1), Linux child-webview geometry (Phase 1 spec, conditional),
picker/annotation, automation parity, emulators.
