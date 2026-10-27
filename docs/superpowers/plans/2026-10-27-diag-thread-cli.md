# Plan: diag-thread-cli (#201)

Design: [2026-10-27-diag-thread-cli-design.md](../specs/2026-10-27-diag-thread-cli-design.md).
Branch `claude/b3f-diag-thread-cli` from `claude/issue-batch-after-v0.12.0` (449f4cdd0f).
Part 1 is independent of the Part 2 decision and lands first.

## Acceptance criteria

1. **AC1.** Opening Diagnostics from a thread, or from an error surface that links
   there, opens it with that environment selected, so **Download logs** targets it.
2. **AC2.** `bibcode diagnostics download --environment <id|label>` saves a connected
   remote environment's bundle through `server.downloadDiagnosticLogs`, with the same
   scopes, redaction and size bounds; the profiler skill documents it.

## Root cause

- `apps/web/src/routes/settings.diagnostics.tsx:12` takes `?environment=`, but no
  thread surface sets it: `chat/ThreadErrorBanner.tsx` has no link,
  `Sidebar.tsx:4888-4890` navigates bare although `SidebarProjectAvailability`'s
  `view.environmentId` is in scope, and `CommandPalette.tsx:475-484` only opens
  `/settings`.
- No CLI path exists: `bibcode profiler` is offline by contract (`cli.rs:1-4`), and
  remote connections live only in the UI client (design, "Facts").

## Part 1 (AC1)

Change:

- `apps/web/src/diagnostics/diagnosticsLink.ts` (new): `diagnosticsSearchFor(id)`.
- `chat/ThreadErrorBanner.tsx` + `ChatView.tsx`: optional `diagnosticsEnvironmentId`
  renders a ghost **Diagnostics** link (other owner: link only).
- `CommandPalette.tsx`: **Open diagnostics** action, active thread's environment
  (other owner: one action).
- `Sidebar.tsx`: project-availability handler takes `view.environmentId`; the
  update-dialog handler is split and keeps the primary.

Tests (complete caller, failing first):

- Route-level: render the router at a thread on environment X, click the banner's
  **Diagnostics**, assert location `/settings/diagnostics?environment=X` and that
  `DiagnosticLogsSection`'s download is enabled for X's label (extends
  `routes/settings.diagnostics.test.tsx` / `DiagnosticsSettings.test.tsx`).
- `SidebarProjectAvailability.test.tsx`: Diagnostics calls back with the view's id;
  `Sidebar` wiring navigates with it; update dialog navigates without.
- `CommandPalette.test.tsx`: the action navigates with the active thread's id.

## Part 2 (AC2), Option A as designed (pending approval)

Change:

- Contracts (other owner, flag): `server.subscribeDiagnosticLogsRelay`,
  `server.claimDiagnosticLogsRelay`, `server.sendDiagnosticLogsRelayItem` and their
  schemas in `packages/contracts/src/server.ts`/`rpc.ts`, plus the rpc-wire manifest.
- Server: `production/diagnostic_logs_relay.rs` (new: one slot, two-minute consent
  expiry, 60 s item deadline, bound re-checks, one item in flight); the
  `POST /api/diagnostics/relay` loopback route in `http_routes.rs`; `cli-endpoint.json`
  written and removed in `lifecycle.rs`; scopes in `auth/scope.rs` (`access:write`);
  `is_long_running` in `diagnostics/profiler/latency.rs`.
- CLI: `diagnostics/logs_cli.rs` (new) and `CliCommand::Diagnostics` in `config.rs`;
  desktop dispatch next to `profiler` in `apps/desktop/src-tauri/src/main.rs` (other
  owner, two lines).
- Client: `packages/client-runtime/src/diagnostics/relay.ts` (claim, resolve,
  download, send items); `apps/web/src/diagnostics/useDiagnosticLogsRelay.ts` and a
  consent prompt, mounted once at the app root (other owner, one mount).

Tests:

- Rust unit: slot busy, expiry, denied, over-size declared, over-size item, short
  total, stalled client, CLI reader gone (slot released), token and loopback refusal.
- Rust integration (`apps/server/tests/`): a real server, a WebSocket client with an
  administrative session that claims and sends items, and the CLI's run function
  saving the ZIP; an ordinary-scope session cannot subscribe.
- client-runtime: relay handler with a fake environment (claim, unknown environment
  lists connected ones, assembler failure becomes `failed`, deny sends nothing).
- web: the prompt names the environment and crash dumps; Allow starts, Deny declines,
  expiry closes it.

## Docs and runbooks

- `docs/skills/bibcode-profiler/SKILL.md` (prefix table line 25, remote notes 43-51):
  the `diagnostics download` path, its approval step, and `--json`.
- `docs/operations/observability.md` "Diagnostic Bundle": entry points with
  `?environment=`, the CLI relay, its bounds and outcomes.
- `docs/architecture/rpc-and-orchestration.md` method list and
  `docs/cloud/environment-auth.md` scope note for the relay methods.
- `docs/testing/` runbooks: reviewed; updated only if the packaged Diagnostics flow
  there names the entry points.

## Validation

`vp check --no-fmt`, `vp check <changed files>`, `vp run typecheck`,
`vp test run --project unit <web paths>` from `apps/web`, client-runtime and
contracts tests, `vp test run scripts/bibcode-identity.test.ts`; Rust with the
1.98.1 toolchain, own `target/`, `CARGO_BUILD_JOBS=3`: `cargo fmt --all --check`,
`cargo test -p bibcode-server` (relay unit and integration),
`cargo clippy -p bibcode-server --all-targets -- -D warnings` (and `-p bibcode-desktop`
for the dispatch). Reviews: vercel-react-best-practices, UI.md.

## Skipped (ponytail)

Option C (CLI as its own paired device), `profiler --remote`, a diagnostics-only
scope, a "last thread" default, an Activity panel link. Residual for A: a
`bibcode serve` user whose browser page holds only an ordinary session has no client
that may serve the relay; the CLI then says so.
