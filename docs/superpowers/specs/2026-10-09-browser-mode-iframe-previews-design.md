# Browser-mode iframe previews — design

Status: approved 2026-10-09 (navigation reporter injected; same-host framing).
Builds on: [preview gateway (Phase 1)](2026-10-07-internal-browser-preview-gateway-design.md)
("Browser mode opens gateway targets in a new top-level tab (no iframe)") and
[SSH same-port](2026-10-09-preview-ssh-same-port-design.md). Second of the Phase 1
leftovers. Relay reach (#68), SOCKS profiles (#69), and emulators (#70) are
separate issues.

## Goal

In browser mode (BiBCode's web UI in a normal browser), a dev server on the
server's loopback (`http://localhost:5173`) opens **inside BiBCode's preview
panel**, like the desktop's internal browser, instead of in a new browser tab.
The address bar shows the canonical `localhost` URL and follows the page;
Back, Forward, and Reload work.

## Current state

- `resolveForNavigation` (`apps/web/src/browser/previewGateway.ts`) mints a gateway
  capability and returns `http://<server>:<gateway port>/__bibcode/bootstrap?…`;
  browser mode opens it in a new tab (`openPendingTab`, `browserTab.ts`) and the
  preview panel has no live view.
- The gateway is plain HTTP on its own port per target, with a `SameSite=Lax`
  session cookie and Origin enforcement for writes and WebSocket upgrades.

## Decisions

1. **Same-site framing works without new cookies.** The UI
   (`http://<host>:<server port>`) and a gateway target
   (`http://<host>:<gateway port>`) share scheme and host, so they are the same
   *site*: the `Lax` gateway cookie is sent inside the iframe. Another site that
   frames the gateway is cross-site, gets no cookie, and sees the `401` page.
2. **Mixed content falls back to a tab.** An HTTPS UI (Tailscale Serve, a TLS
   reverse proxy) cannot frame the HTTP gateway. Then the preview keeps opening
   in a new tab, with the panel showing "Opened in a new tab: this BiBCode
   page is served over HTTPS and previews are HTTP" and an **Open again** action.
3. **Framing headers.** The gateway answers every response for a framed target
   with `Content-Security-Policy: frame-ancestors http://<host>:*
   https://<host>:*` (the request's host) and drops upstream `X-Frame-Options`
   and `frame-ancestors` directives, so dev servers that forbid framing still
   preview. Only pages on the same host can frame them, and those still need
   the cookie.
4. **Navigation reporting (recommended).** For `text/html` responses the gateway
   inserts `<script src="/__bibcode/frame.js"></script>` as the first element
   of `<head>` (a same-origin script, allowed by `script-src 'self'`). The
   script posts `{ url, title, canGoBack, canGoForward }` to `window.parent`
   with the UI origin as `targetOrigin` on load, `popstate`, `hashchange`, and
   `history.pushState`/`replaceState`, and obeys `{ command: "back" |
   "forward" | "reload" }` messages from that origin only. The panel maps the
   reported gateway URL back to the canonical `localhost` URL. Pages whose CSP
   blocks it (`strict-dynamic`, nonce-only) still preview; the address bar then
   shows the last opened URL and Back/Forward are disabled with a tooltip
   ("This page doesn't allow BiBCode to follow its navigation").
5. **The iframe** is `sandbox="allow-scripts allow-same-origin allow-forms
   allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"`,
   `allow="clipboard-read; clipboard-write; fullscreen"`, and
   `referrerpolicy="no-referrer"`. The gateway origin differs from the UI
   origin, so the page cannot reach the UI's DOM or storage.
6. **Automation in browser mode is unchanged** (status and open only; open now
   shows the page in the panel). Driving a cross-origin iframe needs the
   desktop engine's design; out of scope here.

## Components

- **Server (`apps/server/src/preview/gateway/proxy.rs`):** response header
  rewrite (decision 3); HTML head injection with a bounded streaming rewriter
  (only the first chunk up to `<head>`; bodies stay streamed; compressed bodies
  are passed through uninjected); `GET /__bibcode/frame.js` serving the
  reporter (static, cacheable, no cookie needed).
- **Web:** a `BrowserModePreviewFrame` surface in the preview panel replacing
  the "opened in a new tab" state when framing is possible; message handling
  keyed by the frame's `contentWindow` and origin; canonical URL mapping via
  `canonicalizePreviewUrl`; Back/Forward/Reload wired to messages (Reload
  re-resolves through the gateway when the session expired).
- **Fallback:** HTTPS UI, gateway refusals, or a user preference "Open
  previews in a new tab" keep today's tab behaviour.

## Error handling

- Gateway `401`/`502` pages render inside the frame with their own copy; the
  panel offers **Reopen** (re-resolve, new capability).
- `postMessage` from any other source or origin is ignored.
- A frame that never reports within 5 s after load keeps working without
  navigation sync (decision 4 fallback).

## Testing

- Server: header rewrite (X-Frame-Options dropped, frame-ancestors set),
  injection only into `text/html` heads, compressed/streamed bodies untouched,
  `/__bibcode/frame.js` served without auth.
- Web: frame surface choice (http UI → frame, https UI → tab), message
  validation (origin/source), URL mapping, Back/Forward/Reload commands,
  CSP-blocked fallback state.
- Runbook: browser mode on a LAN server — preview a Vite app in the panel,
  navigate, Back/Forward, HMR, and an HTTPS UI falling back to a tab.

## Out of scope

Automation in browser mode, relay (#68), SOCKS (#69), HTTPS gateway targets.
