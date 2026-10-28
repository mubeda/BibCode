# Diagnostics from a thread, and remote bundles for the CLI (#201) — design

Status: approved (Option A); unattended access (Option C) is #202. Builds on #194 (`server.downloadDiagnosticLogs`).

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

1. **Finding the local server.** While it runs, the server writes
   `<state dir>/diagnostics-relay.json` (mode 0600 on Unix, in the per-user data
   root on Windows): its URL and a fresh random per-boot token. It removes the
   file on shutdown; a stale file fails the request as "BiBCode is not running".
   The command sends the token only to a loopback URL. Reading the file needs the
   same access as the data root, which already lets `bibcode pairing issue` mint
   an administrative credential while the server runs (`lib.rs`
   `run_pairing_command`, `tests/cli_smoke.rs`), so the token grants nothing new.
   It authorizes only the relay route. A WSL primary keeps the file in the
   distro's data root, so the command runs inside the distro there.
2. **CLI → server.** `POST /api/diagnostics/relay` with the token:
   `{ environment, includeCrashDumps, code, outputDirectory }`, where `code` is a
   short random code the command prints ("Approve request K7Q-4M in BiBCode…").
   The route refuses a peer that is not this machine and any request carrying a
   proxy's forwarding headers (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`,
   `Tailscale-*`); a proxy that strips them all could still forward a request
   from loopback, so the token is the real gate. The response is one JSON line
   per step: `waiting`, `started { fileName, byteLength, manifest }`, `data`
   (base64, at most 64 KiB), `finished`, `denied`, `failed { reason, message }`,
   or `ended { reason, message }`. One relay at a time per server; a second gets
   `busy`. After a denied or unanswered request, or a command that left before an
   answer, the next waits 30 s, doubling per refusal in a row up to 5 minutes
   (`cooling-down`); a saved archive clears it. Fields with control or Unicode
   format characters (Cc, Cf) are refused; the environment is kept as typed for
   display and trimmed only for lookup.
3. **Server → client.** `server.subscribeDiagnosticLogsRelay` (scope
   `access:write`) announces `Pending { requestId, environment,
   includeCrashDumps, code, outputDirectory }`, then `Claimed` and `Closed`.
   `access:write` is only the floor: each handler also requires the desktop app's
   own session (subject `desktop-bootstrap`), so no other paired device, not even
   an administrative one, can be made to pull logs onto this host (proved by
   `an_administrative_session_that_is_not_the_desktop_app_cannot_serve`). The
   first window to claim owns it, bound to its session and connection; `Claimed`
   makes the other windows drop their prompt.
4. **Consent.** Any program running as the user can make the request (an agent
   in a thread, a paired device's terminal), so the prompt says "A program
   running as you on this computer (not BiBCode) asks to save <label>'s
   redacted logs to a file" and shows the code, the environment as typed, and
   the output directory; the user shares only when the code matches the command
   they ran. Nothing is downloaded before **Share logs**; dismissing denies.
   Unanswered requests expire after two minutes. Crash dumps are asked for only
   with `--include-crash-dumps` and named in the prompt and the button.
5. **Resolving the environment.** The client resolves `<id|label>` among its
   environments. Unknown, ambiguous or disconnected returns `failed` naming only
   what was asked for, without a prompt; the command never learns which other
   environments the app can reach.
6. **Client → server → CLI.** The client registers the request's cancellation
   before claiming, so a request that closes during the claim never starts a
   download. It then runs `downloadDiagnosticLogs` (the assembler checks every
   bound and the storage identity) and sends the verified archive with
   `server.sendDiagnosticLogsRelayItem { requestId, item }` in 64 KiB items, one
   in flight: the server answers each call only after the CLI took the previous
   one, so it holds at most one item. The server re-checks the declared size
   against the 20 MiB bound, each item against 64 KiB, and the total against the
   declared size. The request ends after 10 minutes from the claim without
   `Started`, 60 s without the next item, or when the claiming connection closes;
   `Closed` stops the app's download.
7. **CLI output.** It waits at most 13 minutes for `started` and 90 s between
   items. It checks the received length against `byteLength` and that the
   archive's `manifest.json` names the same non-empty environment and store as
   the relayed manifest, writes and syncs a hidden `.<name>.<code>.partial` file
   in the output directory (a fresh name if one is taken), publishes it under its
   name with a hard link, which never replaces an existing file, and removes the
   temporary file; without hard links it saves nothing rather than risk a partial
   file. Response headers and error bodies get 30 s. It prints the path, or one
   JSON document with `--json`, with app- and remote-provided text stripped of
   control and format characters. Exit codes: 0 saved, 1 failed, 2 denied, unanswered or cooling
   down, 3 not running.
8. **Desktop executable.** `<desktop exe> diagnostics download …` dispatches like
   `profiler` (`cli.rs` `desktop_dispatch`), so a desktop install needs no
   separate binary.

### Security

- The remote enforces its own scopes on the client's own credential; nothing the
  CLI sends reaches the remote except the two download inputs.
- Who may ask: a process that can read the data root (equivalent to today's
  `pairing issue`). Who may serve: only the desktop app's own session on this
  host's server. Who decides: the user, per request, in the app, matching the
  command's code.
- The relay never persists bytes: they pass through one bounded slot in memory.
- The token appears in no URL, log, profiler record or argument; it travels in an
  `Authorization` header to a loopback URL only and is compared in constant
  time. The route refuses non-local peers and proxied requests even when the
  server listens wide.
- Redaction is the remote server's, unchanged. The client adds its own frontend
  log snapshot exactly as the Settings download does.

### Profiler and observability

The three RPC methods register through the `rpc/session.rs` wrappers. The
subscription waits on the user and the send call on the command, so those two
join `is_long_running` (`diagnostics/profiler/latency.rs`); the claim only takes
a lock and does not. The local server logs each request's id and outcome
(waiting, claimed, answered, the command left, or the reason it ended) with
`tracing::info!`/`warn!`, never the token, the environment name, or bytes.

## Out of scope

- Option C and any `bibcode profiler --remote` (findings/events over RPC).
- A diagnostics-only pairing scope.
- An implicit "last thread" default for a bare `/settings/diagnostics`.
- A Diagnostics link in the Activity panel: its alerts
  (`activity/ActivityRecordDetail.tsx:173,250`) are load errors of the panel's own
  query, not environment failures.
