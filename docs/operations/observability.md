# Observability

BiBCode's production backend is the native Rust server. Axum request handling,
Tokio tasks, provider supervision, terminals, Git, persistence, and desktop
integration emit diagnostics through Rust's `tracing` facade. There is no
production Node.js logger or TypeScript server observability layer.

## Runtime Boundaries

- The Tauri host and in-process server share one native desktop process.
- A headless `bibcode serve` process runs the same Rust server library without Tauri.
- Provider CLIs, terminals, SSH forwards, and `cloudflared` are supervised child
  processes and appear in process diagnostics.
- Browser and WebView clients do not export traces to a remote collector.
- The hosted BiBCode Connect relay has no remote request trace exporter.

Native diagnostics remain local to each BiBCode installation.

## Logs

Rust diagnostics are emitted with `tracing::debug!`, `tracing::warn!`, and
`tracing::error!` at operational boundaries. Native tracing is one
process-wide stream with one subscriber. Each active server runtime owns an
exact sink lease for `userdata/logs/server.log` (or `dev/logs/server.log` for a
source development environment), while the subscriber also retains
human-readable stderr output. Production normally has one active runtime and
one file sink. When several embedded runtimes coexist in one process, every
native tracing event is mirrored to every active runtime-owned sink; those log
files are not runtime-isolated. Dropping one exact lease removes only that
runtime's sink, so it cannot retarget or tear down another runtime's logging,
and completed runtime entries do not accumulate. `BIBCODE_LOG` controls the
filter and falls back to the standard `RUST_LOG` behavior, then `info`.

In headless mode, run the native server from a terminal or service manager to
retain an additional stderr stream:

```bash
bibcode serve
```

From a source checkout:

```bash
cargo run -p bibcode-server -- serve
```

Desktop diagnostics come from the shared in-process Rust runtime and the same
`server.log`; no child server process is involved. The old `server-child.log`
belonged to the removed Node sidecar and is not part of the final architecture.

## Trace Diagnostics

The native server writes actionable RPC failures to
`userdata/logs/server.trace.ndjson`. Records are retained across application
restarts. The writer rotates at 4 MiB and keeps three backups, bounding disk and
memory use while preserving recent failures. The server exposes no
browser-to-server trace ingestion endpoint.

`server.getTraceDiagnostics` reads the current file and its backups on demand.
It reports parse errors, span counts, slow spans, common failures, recent
failures, and warning/error events. A missing file is reported explicitly as
`trace-file-not-found`; it is not presented as a healthy empty trace.

RPC error details are bounded before they reach this store. Authorization
headers, common token/password assignments, and URL credentials are redacted.
Git failures retain bounded stderr so errors such as malformed `.gitmodules`
entries remain actionable both in the original notification and after restart.

Provider and terminal lifecycle summaries are written as bounded NDJSON under
`userdata/logs/provider/events.log` and
`userdata/logs/terminals/events.log`. Each file rotates at 4 MiB and retains
three files total: the active file and two rotated generations. Records include
lifecycle identifiers, event types, statuses, sequence/PID/exit metadata, and
bounded counts. Provider option-reconciliation records may also include the
provider instance, model, option ID, application method, result, and requested
option value. Terminal output and provider prompts or response payloads are not
written to these operational logs. Do not put credentials or raw environment
values in option values or other diagnostic fields.

## Diagnostic Bundle

The Diagnostics settings page can prepare a timestamped, redacted ZIP through
`POST /api/diagnostics/logs.zip`. Desktop clients open a native save dialog;
browser clients download the response. The archive contains exactly:

- `server.log`, assembled oldest-first from the active native server log and up
  to three retained backups;
- `server.trace.ndjson`, assembled the same way from the active trace file and
  up to three retained backups; and
- `frontend.log`, containing the frontend warning/error snapshot supplied by
  the requesting client.

Provider and terminal operational logs are not included. Each retained server
or trace file is read up to 4 MiB and marked when truncated. The frontend
request and retained frontend content are bounded to 512 KiB; when necessary,
the client omits the oldest frontend records before upload.

Before writing the ZIP, the server redacts authorization and proxy-authorization
lines, bearer values, common token/API-key/password/secret assignments, and URL
credentials. This is a defensive pattern-based filter, not a proof that every
possible secret format is absent. Review an archive before sharing it outside
the trusted support boundary.

The former Effect logger, `Logger.tracerLogger`, TypeScript `TraceRecord`, and
Node OTLP exporter paths were removed with the TypeScript server. Environment
variables documented for that implementation are not a supported native-server
configuration surface unless they are reintroduced in Rust and covered by
tests.

## Process Diagnostics

Resource diagnostics are host-scoped. Each snapshot describes the selected
environment on one machine; it is not a whole-machine total and never combines
processes from different machines. The reported groups are:

- **Combined**: the complete monitored total for that host, equal to BiBCode Core
  plus External Tooling for CPU, RSS, and process count.
- **BiBCode Core**: the native BiBCode server or combined Tauri host/server root,
  plus UI processes that a desktop adapter can associate reliably with that
  BiBCode instance.
- **External Tooling**: provider CLIs, terminals, helpers, and other processes
  launched or supervised by BiBCode.

For a remote selected environment, Combined, Core, and External describe only
the remote host. A desktop client may also show the always-present local
environment's Core usage separately as **This device**; that local value is not
added to the remote total. Browser clients have no local desktop environment
to report and omit **This device**.

The UI coverage status qualifies whether co-located desktop UI processes are
included in Core:

- `available`: every UI process exposed by the supported platform mechanism was
  sampled;
- `partial`: some UI processes were sampled and a bounded failure explains the
  incomplete coverage;
- `unavailable`: the adapter could not associate any UI process reliably; and
- `notApplicable`: the runtime is headless and has no co-located BiBCode UI.

On Windows, the desktop observer associates WebView2 roots only when they are
current BiBCode descendants carrying WebView2's embedded-browser marker and the
running desktop executable name. Their helper descendants inherit Core UI
ownership.

On macOS, the desktop observer obtains PIDs from every WKWebView owned by the
current Tauri `AppHandle`, then validates each PID with an exact role-specific
executable match and matching resource and jetsam coalition IDs, both nonzero.
Coalition membership is validation rather than a discovery mechanism. A
missing private selector, failed dispatch, missing snapshot row, or unavailable
coalition data
yields `partial` or `unavailable` coverage. This requires neither elevated
privileges nor a new entitlement, but it uses private WebKit and process SPI,
so it is incompatible with a strict Mac App Store public-API-only policy.

Linux and other unsupported desktop targets report `unavailable`; the observer
never claims generic browser or renderer executable-name matches.

Production provider and terminal launchers register their root PID, scope,
kind, and bounded label. The schema reserves the `helper` kind, but no
production helper launcher currently registers it. Descendants inherit the
nearest registered root's attribution. A process with no registered provider or
terminal ancestor that remains descended from the native server is visible as
External Tooling with `unknown` kind and fallback confidence; missing
registration does not make it Core or remove it from the totals.

Attribution and process actions use a stable process identity made from PID and
operating-system start identity captured at launch. Registration fails closed
when that identity cannot be captured; sampling only validates the exact
captured identity, so a reused PID does not inherit the previous process's
ownership. The native sampler remains the source of CPU and memory values;
attribution does not perform a second machine-wide process refresh.

If refresh fails after a successful sample, the client retains the last good
snapshot and its original timestamp, marks it stale, and displays the bounded
failure. Before the first successful sample it shows unavailable placeholders,
not healthy-looking zeroes. Partial and unavailable UI coverage likewise remain
explicit rather than being encoded as zero usage.

Resource Manager never offers Interrupt or Kill for a Core row. For an eligible
External row, client state is only a request: immediately before signaling, the
server resamples and revalidates the PID/start identity, current ancestry, and
signal eligibility. Stale or reparented identities are rejected.

Use the Diagnostics UI or the corresponding typed RPC methods to:

- inspect current process rows and resource history;
- compare Combined, Core, and External current and historical usage;
- identify registered provider and terminal roots, their inherited descendants,
  and fallback descendants;
- signal a supervised process when the UI permits it;
- verify that shutdown leaves no owned child processes behind.

Packaged-runtime investigations should explicitly confirm that no `node`,
Electron, TypeScript server, or removed native-helper process appears in the
application tree. The desktop runtime measurement reports idle process count,
private memory or its POSIX RSS approximation, working set, and highest-memory
processes. Verify shutdown by checking that its recorded process IDs no longer
exist. Use Resource Manager's attributed CPU display for active-load checks;
the measurement script does not duplicate cross-platform CPU accounting.

## Instrumentation Guidance

Add spans and structured fields at meaningful Rust boundaries:

- Axum HTTP and WebSocket RPC requests;
- orchestration command dispatch and committed events;
- provider process start, request, cancellation, and exit;
- SQLite transactions and migrations;
- Git and source-control commands;
- terminal lifecycle and process-tree cleanup;
- relay installation, authentication, and tunnel lifecycle.

Keep high-cardinality values such as thread IDs, paths, and command IDs in span
fields, not metric labels. Never record prompts, credentials, bearer tokens,
pairing links, environment secrets, or raw provider authentication files.

## Verification

For observability changes, run focused Rust tests followed by the repository
gates:

```bash
cargo test -p bibcode-server
cargo clippy --workspace --all-targets -- -D warnings
vp check
vp run typecheck
```

For desktop changes, launch a packaged build, exercise provider and terminal
lifecycle, inspect diagnostics, then close the app and verify that its supervised
process tree is gone.
