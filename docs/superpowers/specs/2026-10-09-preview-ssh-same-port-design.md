# Preview over SSH on the same local port — design

Status: approved in conversation 2026-10-09; spec awaiting review.
Builds on: [preview gateway (Phase 1)](2026-10-07-internal-browser-preview-gateway-design.md),
whose "Out of scope" list named SSH same-port forwarding. First of the Phase 1
leftovers (then browser-mode iframe previews, then relay reach), each with its
own spec.

## Goal

Over a desktop-managed SSH environment, a preview of `http://localhost:5173`
loads at exactly `http://localhost:5173` on the client, so origin-sensitive apps
(OAuth redirects to `localhost:<port>`, CORS allowlists, absolute URLs) work as
they do on the server. When that local port is busy, the preview still opens
on a random local port, as in Phase 1, and says why.

What the user decided:

- Automatic: always try the same local port; fall back to a random port with a
  one-time note. No setting.
- Keep the gateway in the path (option C below); only the local end of the
  existing forward changes.

## Architecture decision record

| Option | Decision |
| --- | --- |
| C. Same local port for the existing forward to the gateway listener | **Chosen.** Real origin; keeps the gateway's capability, principal check, revocation, limits, and lifecycle; no server change |
| A. Raw `ssh -L P:localhost:P` bypassing the gateway | Rejected: any local process or web page that can reach `localhost:P` gets the remote service while a tab is open; a second forward bookkeeping path |
| B. Gateway listener on the exact remote port | Not viable: the dev server already holds that port on the server |

## 1. Desktop forward

Owner: `apps/desktop/src-tauri/src/ssh.rs`, `bridge.rs`.

- `DesktopBridge.sshForward(target, remotePort, preferredLocalPort?)`; the Tauri
  command `desktop_bridge_ssh_forward` gains `preferred_local_port: Option<u16>`.
  It still returns the actual local port.
- `SshEnvironmentManager::ensure_port_forward` keeps one live forward per remote
  (gateway) port. It honours the preference when it creates a forward, or when
  the live forward for that remote port sits on a different local port than the
  preference; otherwise it reuses the live forward as today.
- A preferred port binds **both** `127.0.0.1:P` and `[::1]:P`: two `-L`
  arguments on one `ssh -N` child with `ExitOnForwardFailure=yes`. Binding only
  IPv4 would let a local process on `[::1]:P` (Node ≥ 17 binds `::1` for
  `localhost`) receive the webview's `localhost` requests. When the client has
  no IPv6 loopback (binding `[::1]:0` fails), only `127.0.0.1:P` is bound.
- Before spawning, the desktop probes the preferred port by binding each family
  briefly. A busy family, or an ssh child that exits with a forward failure
  (another process won the race), falls back to `portpicker` and a single
  `127.0.0.1:<random>` bind, exactly as today. A preferred port below 1024 is
  ignored.
- Unchanged: the 8-per-tunnel and 12-global limits, LRU eviction, release,
  `ControlPath=none`, loopback-only binds, the tunnel lock, and password prompts.

## 2. Web resolver

Owner: `apps/web/src/browser/previewGateway.ts`.

- Over SSH the resolver still calls `preview.gatewayOpen` first (admission,
  HTTPS refusal, capability), then `bridge.sshForward(target, gatewayPort,
  preferred)`, where `preferred` is the canonical URL's port, omitted below 1024.
- Returned port equals the preference → the client origin is the canonical
  origin (`http://localhost:5173`, or `127.0.0.1` / `[::1]` if the URL used
  that host), and the bootstrap URL is built on it. Otherwise the client origin
  is `http://127.0.0.1:<port>` as today.
- `canonicalOrigins` maps the client origin to the canonical origin in both
  cases (identity for same-port), so the URL bar, history, and agent tools keep
  showing the canonical URL.
- Fallback note: one info toast per environment and canonical origin per app
  session: "localhost:5173 is in use on this computer, so this preview runs on a
  different local port. Apps that expect localhost:5173 (OAuth sign-in, for
  example) may not work until you free it." It names the canonical host and port.
- Two threads previewing the same canonical port on one SSH host: each thread
  has its own gateway listener (remote port), so the first holds local `P` and
  the second falls back with the note. A fallback tab keeps its random port
  until it is reopened; it never switches origin live (that would reload the
  page and lose its state).
- Unchanged: local, LAN, WSL, and browser mode; forward holders, leases, grace
  release, and failure copy.

## 3. Errors and compatibility

- A probe or bind failure on the preferred port is never an error: the desktop
  falls back and returns the random port. Only failing to get any local port, or
  an inactive tunnel, returns today's errors ("SSH connection is not active."
  and the forward failures), which the resolver already maps to notices.
- The desktop host serves its own bundled web build, so the bridge and the
  resolver always come from the same release; no version negotiation is needed.
- No server RPC, schema, or persistence change.

## 4. Testing

Rust (`ssh.rs` tests):

- The forward plan for a preferred port carries `127.0.0.1:P:127.0.0.1:R` and
  `[::1]:P:127.0.0.1:R`; with IPv6 loopback unavailable, only the first.
- A busy preferred port (IPv4 or IPv6) falls back to one `127.0.0.1:<random>`
  bind; a preferred port below 1024 is ignored.
- A live forward on the preferred port is reused; one on another port is
  replaced when the preference is free.
- An ssh child that fails its preferred-port forward is retried on a random port.

Web (`previewGateway.test.ts`):

- Same port returned → bootstrap URL on `http://localhost:5173`, identity
  mapping, no toast.
- Different port → `127.0.0.1` origin, toast once per environment and origin.
- A second thread on the same canonical port falls back.
- A canonical port below 1024 sends no preference.

Native validation (`docs/testing/cross-platform-validation.md`): over SSH,
preview a dev server whose page redirects to an absolute
`http://localhost:<port>/callback` and confirm the URL and origin stay on
`localhost:<port>`; then occupy that port locally on IPv4 and on IPv6 in turn
and confirm the fallback port and the one-time note.

## 5. Documentation

Same change: `docs/architecture/remote.md` (preview port forwards),
`docs/user/workspace-ui.md` (what users see over SSH), the cross-platform
runbook step above, and a pointer from the Phase 1 spec's "Out of scope".

## Out of scope

Same-port reach for LAN, WSL, relay, and browser mode; switching an open
fallback tab to the real port; HTTPS upstreams.
