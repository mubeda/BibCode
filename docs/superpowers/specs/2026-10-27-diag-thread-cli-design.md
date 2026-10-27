# Diagnostics from a thread, and remote bundles for the CLI (#201) — design

Status: proposed, awaiting approval. Builds on #194 (`server.downloadDiagnosticLogs`).

## Problem

1. Settings → Diagnostics targets the primary unless the URL carries
   `?environment=` (`apps/web/src/routes/settings.diagnostics.tsx:12`,
   `apps/web/src/components/settings/diagnosticsEnvironment.tsx:44`). Nothing that
   starts from a thread or an error surface passes it: `ThreadErrorBanner` has no
   Diagnostics link at all, and the sidebar's project-availability **Diagnostics**
   button navigates bare (`apps/web/src/components/Sidebar.tsx:4888`) although its
   view carries `view.environmentId`.
2. `docs/skills/bibcode-profiler/SKILL.md:25,43` reaches a remote only through
   `ssh <host> bibcode profiler`. Without SSH the agent must ask the user to click
   **Download logs** and hand the file over.

## Facts that constrain the design

- **No server holds a connection to another environment.** The production server
  has no Noise initiator or WebSocket client (`build_initiator` is test-only,
  `apps/server/src/rpc/e2ee.rs:2010`; `connect_async` appears only in tests). Every
  remote connection, its credential and its `EnvironmentSupervisor` live in the UI
  client (web app or desktop WebView): `packages/client-runtime/src/connection/`.
- **Saved credentials are client-private.** On macOS and Linux the connection
  catalog is in the WebView's IndexedDB; only Windows keeps a native DPAPI file
  (`apps/desktop/src-tauri/src/security.rs:3,29`). Profiles and credentials are
  kept apart so the catalog can be listed without exposing secrets
  (`docs/architecture/connection-runtime.md:138-141`).
- **`bibcode profiler` is offline by contract.** It "never starts a server and
  works while one is stopped" (`apps/server/src/diagnostics/profiler/cli.rs:1-4`).
- The download already enforces everything we must keep: `orchestration:read` for
  logs and `orchestration:operate` for crash dumps on the remote
  (`apps/server/src/production/diagnostic_logs_rpc.rs:117`, `auth/scope.rs:65`),
  server-side redaction, the 20 MiB archive and 64 KiB item bounds, and the
  manifest `storageInstanceId` check against the connection's verified identity
  (`packages/client-runtime/src/diagnostics/logs.ts` `DiagnosticLogsAssembler`).
- Local precedent for "a command asks the client to act": `bibcode open-url` posts
  to `POST /api/preview/open-url` with a scoped token, and clients race to claim
  the announced request (`apps/server/src/open_url.rs`,
  `apps/server/src/preview/mod.rs:482-536`). It is one-way; nothing flows back.

So "the CLI uses the existing environment connection" can only mean
**CLI → local server → a UI client on this host → the remote environment**.
"Connect directly" can only mean the CLI holds a credential of its own.

## Part 1: Diagnostics opened from a thread or an error surface

Every entry point that knows an environment passes it as `?environment=<id>`; the
route already keeps it and `useDiagnosticsEnvironment` already falls back when it is
not connected (and says so through `waitingFor`). No new state.

| Entry point                                                     | Today                          | Change                                                                            |
| --------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| Thread error banner (`chat/ThreadErrorBanner.tsx`, via ChatView) | no link                        | a ghost **Diagnostics** link to the thread's environment                          |
| Command palette, a thread open                                  | only **Open settings**         | **Open diagnostics**, to the active thread's environment (primary when none)      |
| Sidebar project availability **Diagnostics**                    | bare                           | `view.environmentId`                                                              |
| Desktop update protection dialog **Diagnostics**                | shares the sidebar handler     | split off; keeps the primary (an update concerns this host)                       |
| Status bar Profiler segment                                     | already passes its environment | unchanged                                                                         |
| WSL rows in Local environment settings                          | bare                           | unchanged: they concern the primary/WSL backend, which is the default already     |

The banner and the palette are owned by other agents for behavior; this adds one
link each and no behavior. The helper that builds the link lives in
`apps/web/src/diagnostics/` so every caller uses one function:
`diagnosticsSearchFor(environmentId | null)`.

Rejected: an implicit "remember the last thread's environment" default for a bare
`/settings/diagnostics`. It needs new state (`uiStateStore` tracks visit times,
not a current environment), changes what the Settings nav does without the user
asking, and is a hidden fallback.

## Part 2: a CLI path to a connected remote's bundle

### Alternatives

**A. Relay through a UI client on this host (recommended).**
`bibcode diagnostics download --environment <id|label>` asks the local server,
which announces the request to its own host's UI client; the user approves it in
the app; the client runs the existing `downloadDiagnosticLogs` against that
environment and streams the verified items back through the local server to the
CLI, which writes the ZIP.

- Reuses the whole client path: scopes, redaction, bounds, the storage-identity
  check and the failure copy are the ones Settings uses, unchanged.
- Works for every target kind the app can reach (direct E2EE, legacy bearer,
  BiBCode Connect, desktop SSH tunnels). No credential is created, copied or
  stored. Nothing is configured on the remote.
- Needs the app running with that environment connected, and one click per
  request. It adds a new channel: the local server asks a client to reach another
  environment. That is the trust boundary to guard (see Security).
- Largest surface: contracts, a server relay, a client handler with a consent
  prompt, an HTTP route and the CLI.

**B. The CLI reads the app's saved credentials and connects directly.** Rejected.
On macOS/Linux they are in WebView IndexedDB (unreadable, and not meant to be
read); on Windows any process of the user can decrypt the DPAPI file, so this
would make every saved remote's full-scope credential (`terminal:operate`
included) a file any local process uses. SSH and Connect targets would still not
work without the desktop. It weakens the boundary the catalog split exists for.

**C. The CLI pairs as its own device.** The user creates a pairing offer on the
remote once (`bibcode pairing offer` there, or its Share tab) and runs
`bibcode remote add <name> '<bibcode://pair?code=…>'`; afterwards
`bibcode diagnostics download --remote <name>` connects itself.

- Clean trust model: an ordinary paired device, listed and revocable on the
  remote; works with the app closed; no contract or UI change; all code in
  `apps/server`.
- Needs the first production Rust client of the wire protocol: Noise NK
  initiator pinned to the offer's host key, E2EE record framing, `e2ee_auth` and
  `auth.confirmPairing`, the RPC request/ack/chunk/exit codec, and a port of the
  assembler. That duplicates `client-runtime` and must track its protocol changes.
- Stores a credential with the ordinary pairing scopes (`terminal:operate`
  included; `docs/cloud/environment-auth.md` "Ordinary pairing credentials") at
  rest on this machine; a diagnostics-only scope would need an auth change.
- Needs one action on the remote, which is what the issue tries to avoid, and
  does not reach SSH-only or Connect-only environments.

**D. Keep SSH.** Fails the acceptance criterion.

Recommendation: **A**, because it is the only option that uses the existing
connection and its verified checks, reaches every kind of connected environment,
and creates no new credential. C is the better path for headless automation and
is left as a follow-up if that need appears.

### A in detail

```
bibcode diagnostics download ──HTTP (loopback, CLI token)──▶ local server
      ▲                                                        │ relay request event
      │ chunked response: started, data…, end                  ▼
      └──────────────────────────────────────────── host UI client (admin session)
                                                      │ user approves in the app
                                                      ▼
                                       server.downloadDiagnosticLogs on <environment>
```

1. **Finding the local server.** At listen time the server writes
   `<state dir>/cli-endpoint.json` (mode 0600 on Unix, in the per-user data root
   on Windows): its loopback URL and a fresh random per-boot CLI token. It removes
   the file on shutdown; a stale file fails the request as "BiBCode is not
   running". Reading the file needs the same access as the data root, which
   already lets `bibcode pairing issue` mint an administrative credential, so the
   token grants nothing new. It authorizes only the relay route.
2. **CLI → server.** `POST /api/diagnostics/relay` from a loopback peer with the
   token: `{ environment, includeCrashDumps }`. The response is a stream of
   length-prefixed items: `waiting` (shown as "Approve the request in BiBCode"),
   `started { fileName, size, manifest }`, `data` (raw bytes, at most 64 KiB),
   `failed { reason, message }`, `end`. One relay at a time per server; a second
   gets `busy`.
3. **Server → client.** A new stream `server.subscribeDiagnosticLogsRelay` (scope
   `access:write`) announces `{ requestId, environment, includeCrashDumps }`.
   `access:write` limits it to administrative sessions: the desktop's own WebView
   and command-line bootstraps, never an ordinary paired device such as a phone,
   so another device can never be made to pull logs onto this host. The first
   client to claim (`server.claimDiagnosticLogsRelay`) owns it, as with open-url.
4. **Consent.** The claiming client shows a prompt: "A command on this computer
   asks for <label>'s logs (with crash dumps). Allow / Deny". Nothing is
   downloaded before **Allow**. Unanswered requests expire after two minutes.
   Crash dumps are asked for only with `--include-crash-dumps` and named in the
   prompt.
5. **Resolving the environment.** The client resolves `<id|label>` among its
   connected environments. Unknown or ambiguous returns `failed` listing the
   connected environments' labels and ids (no consent needed, nothing else
   leaves), so `bibcode diagnostics download` without `--environment` doubles as
   the listing.
6. **Client → server → CLI.** The client runs `downloadDiagnosticLogs` (the
   assembler checks every bound and the storage identity), then sends the
   verified archive with `server.sendDiagnosticLogsRelayItem { requestId, item }`
   in 64 KiB items, one in flight: the server answers each call only after the CLI
   took the previous one, so it holds at most one item. The server re-checks the
   declared size against the 20 MiB bound, each item against 64 KiB, and the
   total against the declared size; a client that stalls for 60 s (the server's
   existing `ITEM_ACK_DEADLINE`) ends the relay.
7. **CLI output.** It writes `<dir>/<fileName>` atomically (temp file, then
   rename; default dir the current one, `--output DIR`), checks the received
   length against `started.size`, and prints the path, or one JSON document with
   `--json` (path, environment, manifest). Exit codes: 0 saved, 1 failed (the
   message is the same copy Settings shows), 2 denied, 3 not running.
8. **Desktop executable.** `<desktop exe> diagnostics download …` dispatches like
   `profiler` (`cli.rs` `desktop_dispatch`), so a desktop install needs no
   separate binary.

### Security

- The remote enforces its own scopes on the client's own credential; nothing the
  CLI sends reaches the remote except the two download inputs.
- Who may ask: a process that can read the data root (equivalent to today's
  `pairing issue`). Who may serve: only an administrative session of this host's
  own server. Who decides: the user, per request, in the app.
- The relay never persists bytes: they pass through one bounded slot in memory.
- The token appears in no URL, log, profiler record or argument; it travels in an
  `Authorization` header and is compared in constant time. The route refuses
  non-loopback peers even when the server listens wide.
- Redaction is the remote server's, unchanged. The client adds its own frontend
  log snapshot exactly as the Settings download does.

### Profiler and observability

The relay route and the three RPC methods register through the `rpc/session.rs`
wrappers; the relay waits on the user and on a remote, so its methods join
`is_long_running` (`diagnostics/profiler/latency.rs`). Each relay outcome
(saved, denied, expired, failed reason) logs one `tracing::info!`/`warn!` line
with the environment id and reason, never the token or bytes.

## Out of scope

- Option C and any `bibcode profiler --remote` (findings/events over RPC).
- A diagnostics-only pairing scope.
- An implicit "last thread" default for a bare `/settings/diagnostics`.
- A Diagnostics link in the Activity panel: its alerts
  (`activity/ActivityRecordDetail.tsx:173,250`) are load errors of the panel's own
  query, not environment failures.
