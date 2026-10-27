# Remote diagnostic logs download (#194)

Status: approved with review corrections and implemented on
`claude/b3-remote-logs`. Historical; the living description is in
`docs/operations/observability.md` (Diagnostic Bundle),
`docs/architecture/remote.md`, `docs/architecture/rpc-and-orchestration.md`
(Diagnostic logs download), and the profiler skill.

## Review corrections (approved, and what was built)

1. **Identity fails closed.** The client compares the manifest's
   `storageInstanceId` with the one its own connection reports
   (`server.getConfig` over the same session), requires both, and never falls
   back to `environmentId` (every server declares `local`,
   `client-runtime/src/connection/remoteIdentity.ts`).
2. **Builds are bounded through cancellation.** `DiagnosticBundleService` holds
   a two-slot semaphore; a build's permit moves into its `spawn_blocking`
   closure, so an interrupted request keeps its slot until compression exits.
3. **Items are bounded before decoding.** An encoded item longer than the
   512 KiB bound, or one that would overrun `byteLength`, is refused before
   `atob`; accepted items are decoded straight into one buffer.
4. **Remote caller proof.** No existing harness joins the TypeScript registry,
   RPC client, and a real pinned connection. The closest real seams are used:
   the Rust pinned-channel suite (`tests/e2ee_ws.rs`), the opt-in TypeScript
   initiator against the Rust responder (`e2ee/serverInterop.test.ts`), the
   client-runtime supervisor/session seam, and the web download-to-save seam.
5. **Default environment is the primary** unless `?environment=` names one.
   No Diagnostics link starts from a thread, so passing the active thread's
   environment is not a one-liner; that is deferred. The rail-selection default
   below was dropped.
6. **Manifest truth.** `crashDumps: { requested, included }`, where `included`
   counts the dumps actually written.
7. `docs/testing/cross-platform-validation.md` covers a capable remote, an older
   server, and a lost connection.

Sections below that contradict these are superseded by them.

## Problem

**Settings → Diagnostics → Download logs** always reaches the primary
environment: `apps/web/src/diagnostics/downloadDiagnosticLogs.ts:156` resolves
`/api/diagnostics/logs.zip` with `resolvePrimaryEnvironmentHttpUrl` and sends it
through `runPrimaryRawHttp`. A chat that runs on a remote environment logs its
provider launch and probe outcome (`provider_runtime.rs`) on that remote server,
so the bundle the user gets holds the wrong machine's `server.log` and trace.
The Profiler section's **Export bundle** has the same limit and says so
(`ProfilerSection.tsx:388`).

`docs/architecture/remote.md:924` already rules out the obvious fix: direct
authenticated HTTP is primary-only, a pinned (E2EE) profile has
`httpAuthorization: null`, and "environment-scoped remote diagnostics are
therefore unavailable until represented as RPC; an E2EE bearer must not be added
to this request."

## Acceptance criteria

1. With a remote environment connected, Diagnostics can download **that**
   environment's `server.log` and `server.trace.ndjson`.
2. The archive says which environment it came from: its file name and a small
   `manifest.json` name the source environment and its server version.
3. Downloading for the local (primary) environment works as it does today.
4. An environment that cannot serve the bundle (older server, not connected,
   connection lost mid-download, refused scope) gets an error that names the
   environment and says why. The client never falls back to another
   environment's bundle.
5. Living docs (`observability.md`, `remote.md`, the profiler skill) describe the
   remote path.

Kept unchanged: the 20 MiB archive limit (`diagnostic_bundle.rs:27`), the
redaction, the size bounds, and the crash-dump opt-in with its
`orchestration:operate` check (`http_routes.rs:532`).

## Decision

Add one **streaming RPC**, `server.downloadDiagnosticLogs`, served over the
selected environment's existing RPC connection (plain `/ws`, chunked `/ws`,
E2EE `/ws-e2ee`, relay, or SSH forward — whichever that environment uses). The
remote server builds and redacts its own bundle with the same
`DiagnosticBundleService` the HTTP route uses, then streams it as base64 items.
The client gates the call on a new descriptor capability and assembles the ZIP
before handing it to the existing save path (desktop `saveDiagnosticLogs` or a
browser anchor).

The primary environment keeps the HTTP route exactly as it is.

### Alternatives considered

| Option                                                                                                  | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Point the existing HTTP request at the remote environment's `httpBaseUrl` with its bearer            | Rejected. Forbidden by `remote.md:924`: pinned profiles have no HTTP authorization, and adding the E2EE bearer to HTTP would leak an E2EE-only credential outside Noise. Relay and SSH profiles would each need their own HTTP auth path.                                                                                                                                                                                                                                                                                                                                     |
| B. RPC mints a token-in-path capability URL, bytes travel over plain HTTP (the `/api/transfers` model) | Rejected. `remote.md:303` documents that on a pinned profile over `http://` those bytes travel outside Noise, readable and alterable on the path. A log bundle names hosts, paths, and redacted-but-still-sensitive operational detail; the review correction requires the RPC connection.                                                                                                                                                                                                                                                                                  |
| C. One unary RPC returning `{ fileName, manifest, archiveBase64 }`                                      | Rejected. It fits the limits (E2EE outbound 64 MiB per connection, recorded messages up to 64 MiB), but a worst-case 20 MiB archive is a ~27 MiB single message. The connection has one writer and only control records interleave, so every chat stream, terminal echo, and reply on that environment waits behind it: about 13 s of frozen UI at 2 MiB/s over a relay. It also costs one ~27 MiB string on each side, parsed on the renderer's main thread.                                                                                                             |
| D. Staged download (`prepare` → `readChunk(offset)` × N → `release`), the inverse of `uploads.*`        | Rejected. Same wire safety as E, but adds server-held state with an owner, a TTL, a process cap, release-on-disconnect, and reconnect semantics — for a one-shot download nobody resumes.                                                                                                                                                                                                                                                                                                                                                                                     |
| **E. One stream: `Started` item, then `Data` items, then completion** (chosen)                          | Chosen. Streams already carry exactly one `Chunk` in flight and wait for the client's `Ack` (`session.rs` `run_stream`; `rpc-and-orchestration.md` "Wire protocol"), so a download is paced by the client, other traffic interleaves between items, `Interrupt` and disconnect cancel the producer, and no state outlives the request. `preview.tunnelOpen` is the precedent for base64 `Data` items (`packages/contracts/src/preview.ts:231`), and `previewTunnelBroker.ts:156` the precedent for the client glue (`runStream` inside `runInEnvironment`). |

Also considered and rejected for the **primary**: switching it to the RPC too,
to have one code path. It would change a path that works and that the desktop
release lanes cover, for no user-visible gain; criterion 3 favours leaving it.
Both paths share `build_bundle`, so the archive's content cannot drift.

## Wire shape

### Capability

`ExecutionEnvironmentCapabilities.diagnosticLogs: boolean`, decoding as `false`
when absent (`packages/contracts/src/environment.ts`, next to `profiler`), and
`"diagnosticLogs": true` in the server descriptor (`lifecycle.rs:72`). The
profiler flag is not reused: servers with the profiler but without this method
exist. The client never sends the method to an environment without the flag,
because an older server answers an unknown method with a connection-level
defect that fails every request in flight on that connection
(`rpc-and-orchestration.md:3717`).

### Method

`server.downloadDiagnosticLogs`, a `read_stream` with scope
`orchestration:read`.

```ts
// packages/contracts/src/server.ts (or a new diagnostics.ts)
DiagnosticLogsDownloadInput = Struct({
  frontendLog: String, // client-bounded to 512 KiB of request, as today
  includeCrashDumps: optional(Boolean), // absent = false
});

DiagnosticLogsManifest = Struct({
  schemaVersion: Literal(1),
  environmentId: EnvironmentId, // the server's self-declared id (often "local")
  storageInstanceId: NullOr(TrimmedNonEmptyString),
  environmentLabel: TrimmedNonEmptyString,
  serverVersion: TrimmedNonEmptyString,
  platform: Struct({ os: String, arch: String }),
  generatedAt: String, // RFC 3339 UTC
  crashDumps: Struct({ requested: Boolean, included: NonNegativeInt }),
});

DiagnosticLogsDownloadEvent = Union([
  TaggedStruct("Started", {
    fileName: String, // ^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$
    byteLength: NonNegativeInt, // <= 20 MiB
    manifest: DiagnosticLogsManifest,
  }),
  TaggedStruct("Data", { data: String }), // base64, <= 512 KiB decoded
]);

DiagnosticLogsError = TaggedError("DiagnosticLogsError", {
  reason: Literals(["invalid", "build-failed", "too-large"]),
  message: TrimmedNonEmptyString,
});
// error: Union([DiagnosticLogsError, EnvironmentRpcError])
```

Exactly one `Started` comes first, then `Data` items in order whose decoded
lengths sum to `byteLength`, then the stream completes. A `Data` item carries
512 KiB of archive (about 683 KiB encoded). An item over the 64 KiB coalescing
bound rides alone in its own `Chunk`, so throughput is one item per round trip:
40 round trips for a worst-case archive, 10 s over a 250 ms link before
bandwidth. Larger items would block other traffic for longer per item; smaller
ones would cost more round trips.

### Server behaviour

- Registered with `register_stream_with_context` in a new
  `production/diagnostic_logs_rpc.rs`, called from `runtime.rs` next to the
  other `register_*_rpc` calls (`runtime.rs:632`). The `rpc/session.rs` wrapper
  times the stream to its first item (`first-item`), which is log-only, so no
  `rpc.slow` or hang finding can come from it.
- `includeCrashDumps: true` re-authorizes the session for
  `orchestration:operate` the way `admit_request` does (`session.rs:1182`,
  `auth.authorize_session(&principal.session_id, scope)`), through a small
  `RpcSessionContext::authorize_scope` helper. A refusal ends the stream with
  the standard authorization failure before anything is built. This keeps the
  HTTP route's rule: dumps need `operate` of the same credential.
- The producer builds the bundle with `DiagnosticBundleService::build` (already
  `spawn_blocking`), refuses one over `MAX_DIAGNOSTIC_ARCHIVE_BYTES` with
  `too-large` (the HTTP route leaves that to the desktop host; a browser could
  not), sends `Started`, then sends `Data` slices through a bounded channel of
  capacity 1, so the server holds the archive plus at most two encoded items.
  The producer stops when the request's cancellation token fires (interrupt,
  disconnect, or request end).
- `frontendLog` is the requesting client's snapshot, as on the HTTP route: the
  issue's symptom is visible on the client and explained on the server, so both
  belong in the archive.

### Manifest and file name (shared with the HTTP route)

`DiagnosticBundleService::new` gains the server's identity (environment id,
label, server version; `runtime.rs:419` has them from config). `build_bundle`
then writes `manifest.json` (the manifest above, pretty-printed) as the last
entry, once it knows how many dumps it wrote, and names the archive
`bibcode-diagnostics-<label-slug>-<YYYYMMDDTHHMMSSZ>.zip`. The slug lowercases
the label, maps every run of characters outside `[a-z0-9]` to `-`, trims `-`,
caps at 40 characters, and falls back to `server`; the result passes the
client's existing name guard (`downloadDiagnosticLogs.ts:96`). A desktop's
local server is labelled `Local`, so the local archive becomes
`bibcode-diagnostics-local-…zip` with a manifest. This is the one visible change
to the primary path: additive, and it is what criterion 2 asks for.

The server's own label can differ from the name the user gave a saved remote
profile. The manifest carries the server's label and id; the client's toast and
errors use the client's label. The client also checks the manifest against the
`storageInstanceId` its own connection reports, not against its environment key
or `environmentId`: every server declares itself `local`. A missing or
different id fails the download rather than saving another machine's logs.

## Client behaviour

`downloadDiagnosticLogs(frontendLog, { environmentId, includeCrashDumps })`:

- `environmentId` is the primary, or absent: unchanged HTTP path.
- Otherwise: refuse before sending when the environment is not connected or its
  descriptor lacks `diagnosticLogs`; then `Stream.runFoldEffect` over
  `runStream(WS_METHODS.serverDownloadDiagnosticLogs, input)` inside
  `runInEnvironment(environmentId, …)`. Validate: `Started` first and once,
  `byteLength` ≤ 20 MiB, manifest id matches, base64 decodes, running total
  never exceeds `byteLength`, final total equals it. Any failure throws a
  `DiagnosticLogsDownloadError` that carries the environment label and a
  user-facing reason. The stream must fail, not resubscribe, when the
  connection drops; phase 2 verifies `runStream` does that and adds a test.
- The assembled bytes go to the same save step as today.

### Default environment

The route's `?environment=` when present (the status bar's Profiler link sets
it), else the primary. The Profiler section and the Diagnostic logs row read
that one selection (`components/settings/diagnosticsEnvironment.tsx`), so the
page never shows two environments at once. No Diagnostics link starts from a
thread today; carrying the active thread's environment is deferred.

## UI (reviewed against `UI.md`)

**Diagnostic logs** section, one row:

- Title stays **Download diagnostic logs**. Description:
  "A redacted ZIP of `server.log`, `server.trace.ndjson`, `frontend.log`, and
  any recorded `profiler` data (without crash dumps), from {label}." The source
  is named in the row, so the user never has to guess which machine the file
  came from (priority 8: show, do not make them remember).
- When more than one environment is known, an **Environment** select sits
  beside the button, bound to the same selection as the Profiler section's.
  Items that are not connected are disabled, as in the Profiler select.
- Button: **Download logs**, busy label **Preparing logs...** (unchanged).

Disabled states explain themselves (shown as the row's status line, with
`aria-describedby` on the button):

| State                                   | Copy                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| Chosen environment not connected        | "{label} is not connected. Reconnect it to download its logs."                          |
| Server older than this feature          | "{label} runs an older BiBCode server that cannot send its logs. Update it to download them here." |

The "not connected" row disables the button instead of following the Profiler's
"Showing {other}" fallback: a download must never silently target a machine the
user did not pick.

Toasts (failures keep the user's place; the button is ready to retry):

| Outcome                         | Title                                | Description                                                                          |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| Saved (desktop)                 | "Diagnostic logs from {label} saved" | the saved path                                                                       |
| Download started (browser)      | "Diagnostic logs from {label} downloading" | the file name                                                                   |
| Connection lost mid-download    | "Could not download {label}'s logs"  | "The connection to {label} was lost. Reconnect and try again."                       |
| Crash dumps refused (scope)     | "Could not download {label}'s logs"  | "This connection to {label} cannot read crash dumps. Turn off Include crash dumps, or pair again with full access." |
| Too large                       | "Could not download {label}'s logs"  | "{label}'s logs are over the 20 MiB download limit. Turn off Include crash dumps and try again." |
| Server could not build it       | "Could not download {label}'s logs"  | "{label} could not prepare its logs: {server message}"                               |
| Incomplete or wrong-environment | "Could not download {label}'s logs"  | "{label} sent an incomplete archive. Try again."                                     |

The primary keeps today's copy byte for byte, except that the primary's label is
shown in the row description like any other environment.

**Profiler** section: **Export bundle** and **Include crash dumps** work for any
selected environment that advertises `diagnosticLogs`, through the same call
with `includeCrashDumps`. The disabled reason "Export bundle covers {primary}
only. Use `bibcode profiler` on {label}." remains only for an environment
without the capability, reworded to the older-server copy above. **Open folder**
stays primary-and-desktop only (it opens a local path).

## Performance, reliability, and security

- Memory: ≤ 20 MiB archive plus two encoded items on the server per download;
  the client holds the decoded parts (≤ 20 MiB) and one assembled copy.
- No new process, task outliving the request, or persisted state.
- Redaction happens on the server that owns the logs, before encoding; nothing
  crosses the connection unredacted. On E2EE and SSH the bytes stay inside the
  channel; on plain `/ws` they get the same protection as every other RPC on
  that profile.
- Crash dumps keep the `operate` rule; the client sends the flag only from
  **Export bundle** with the checkbox ticked, as today.
- An authenticated reader can trigger repeated 20 MiB builds; the HTTP route
  already allows the same. Not changed here (see Deferred).

## Profiler, crash, and trace coverage

- **RPC methods:** the new stream is registered through the `rpc/session.rs`
  `register_stream_with_context` wrapper, which times it to its first item. It
  is not added to `is_long_running` in `diagnostics/profiler/latency.rs`: the
  handler waits on local disk reads and compression, never on a network,
  provider, hosting service, or hook. Checked in `latency.rs`: a stream's timer
  (`RequestTimer::stream`) registers no in-flight entry, so it has no hang
  check, and `observe` never files a `rpc.slow` for the `first-item` outcome.
  A multi-second build therefore records one log-only `rpc.timing` event and
  cannot raise `rpc.slow`, `rpc.saturation`, or `rpc.hang`; `is_long_running`
  and `is_background` would change nothing for it.
- **Events/logs:** a failed build logs `tracing::warn!` at the RPC boundary
  (`diagnostic logs bundle failed`), with no path or content.
- Child processes, worktree removal, binaries, shutdown: not touched.

## Deferred (named, not done)

- One archive with both the remote server's and the local desktop's logs: two
  servers build two bundles, and combining them needs a ZIP writer on the
  client or a desktop command. It does not fall out for free. The user can
  download the primary's bundle separately; the docs say so.
- Exposing the remote bundle to agents through `bibcode` (so the profiler skill
  does not need `ssh <host>`): a CLI with its own remote connection is a
  separate design.
- A process-wide cap on concurrent bundle builds (shared with the HTTP route).
