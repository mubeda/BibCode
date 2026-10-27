# Plan: remote diagnostic logs download (#194)

Design: [2026-10-27-remote-logs-design.md](../specs/2026-10-27-remote-logs-design.md).
Branch `claude/b3-remote-logs` from `origin/develop` at `27702287cc`.

## Acceptance criteria (issue #194)

| #   | Criterion                                                                             | Proof (complete caller)                                                                                                     |
| --- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A1  | With a remote environment connected, Diagnostics downloads that one's log and trace   | Rust RPC test over a real `/ws` session: `server.downloadDiagnosticLogs` stream reassembles to a ZIP holding that server's `server.log`, `server.trace.ndjson`, `manifest.json`; web test: the row's click sends the stream to the selected environment and saves the assembled bytes |
| A2  | The archive names its source environment and server version                           | Rust bundle test: `manifest.json` fields and `bibcode-diagnostics-<slug>-<ts>.zip`; slug edge cases                         |
| A3  | Local download works as today                                                         | Existing HTTP integration test (`lifecycle.rs:1340`) still passes, extended to assert the manifest; web test: primary still uses the HTTP request |
| A4  | Older server / not connected / lost connection / refused scope: named error, no fallback | Web tests: capability `false` → disabled reason names the env and nothing is sent; disconnected → disabled; stream failure mid-way → toast names the env, nothing saved; manifest id mismatch → error. Rust test: `includeCrashDumps` with a read-only session → authorization failure, nothing built |
| A5  | Living docs describe the remote path                                                  | Diff of `observability.md` Diagnostic Bundle section, `remote.md` audit row, profiler skill                                 |

## Root cause

`apps/web/src/diagnostics/downloadDiagnosticLogs.ts:156` hard-wires
`resolvePrimaryEnvironmentHttpUrl` and `runPrimaryRawHttp` (line 115), and the
only server surface is the HTTP route `POST /api/diagnostics/logs.zip`
(`production/http_routes.rs:327`), which pinned profiles cannot authenticate
(`docs/architecture/remote.md:924`). No RPC serves the bundle, and
`DiagnosticBundleService` (`diagnostic_bundle.rs:39`) knows nothing about the
server's identity, so even a correct bundle could not say where it came from.

## Changes, in commit order (TDD where a seam exists)

1. **Bundle identity** (`apps/server/src/diagnostic_bundle.rs`). Add
   `DiagnosticBundleIdentity { environment_id, label, server_version }` to
   `DiagnosticBundleService::new`; write `manifest.json` first; slugged file
   name; `includes_crash_dumps` reflects the request. Failing tests first:
   manifest fields, slug (`"Local"`, `"ai-server"`, `"Mauro's Mac 🍎"`, empty,
   60-char label), name passes the client regex.
   Wire identity at `production/runtime.rs:419` from config (`:664`).
2. **Contracts** (`packages/contracts`). `diagnosticLogs` capability in
   `environment.ts`; `DiagnosticLogsDownloadInput`, `DiagnosticLogsManifest`,
   `DiagnosticLogsDownloadEvent`, `DiagnosticLogsError` (in `server.ts`, beside
   the other diagnostics schemas); `WS_METHODS.serverDownloadDiagnosticLogs`
   and `WsServerDownloadDiagnosticLogsRpc` (`stream: true`) in `rpc.ts`.
   Schema tests in `server.test.ts` / `environment.test.ts` (capability decodes
   `false` when absent). Regenerate `packages/contracts/fixtures/rpc-wire/`
   with `scripts/export-rust-rpc-fixtures.ts` so `rpcRustParity.test.ts`
   passes.
3. **Server RPC**. New `apps/server/src/production/diagnostic_logs_rpc.rs`:
   `register_diagnostic_logs_rpc(registry, DiagnosticBundleService)` via
   `register_stream_with_context`; producer per design (build, size check,
   `Started`, 512 KiB `Data` items through a capacity-1 channel, stop on
   cancellation). `RpcSessionContext::authorize_scope` helper in
   `rpc/session.rs` for the dump check. Register at `runtime.rs:632`.
   `read_stream("server.downloadDiagnosticLogs")` in `rpc/methods.rs`;
   `orchestration:read` in `auth/scope.rs`; `"diagnosticLogs": true` in
   `lifecycle.rs:72` plus the descriptor test at `lifecycle.rs:1208`.
   Tests (in the new module, through `RpcRegistry` and a test session, plus one
   lifecycle-level test over the real `/ws` like the HTTP one at
   `lifecycle.rs:1340`): reassembly equals the bundle and unzips; item size ≤
   512 KiB; read-only session + dumps → authorization failure; interrupt stops
   the producer; over-limit → `too-large`.
4. **Client download** (`apps/web/src/diagnostics/downloadDiagnosticLogs.ts`,
   `useDiagnosticLogsDownload.ts`). `environmentId` option; non-primary path
   through `runStream` + `runInEnvironment` (glue modelled on
   `previewTunnelBroker.ts:156`, injected as a dependency for tests);
   validation and `DiagnosticLogsDownloadError` carrying the label; hook takes
   the environment and labels toasts. Check whether `runStream` resubscribes
   on reconnect; if it does, fail the download explicitly. If the method must
   be excluded from `PRE_VERIFICATION_SUBSCRIPTIONS`
   (`packages/client-runtime/src/rpc/session.ts:335`) as `preview.tunnelOpen`
   is, add that with its test. Tests in `downloadDiagnosticLogs.test.ts`:
   assembled bytes saved; byte-count mismatch, missing `Started`, id mismatch,
   oversize `byteLength`, mid-stream failure → named errors, nothing saved;
   primary still calls the HTTP executor.
5. **UI** (`DiagnosticsSettings.tsx`, `ProfilerSection.tsx`,
   `routes/settings.diagnostics.tsx`). One resolved selection (route param →
   connected non-primary rail environment → primary) shared by the Profiler
   section and the Diagnostic logs row; the row's environment select,
   description naming the source, disabled reasons and toasts per the design's
   copy tables; **Export bundle** enabled for capable non-primary
   environments. Tests in `DiagnosticsSettings.test.tsx`,
   `ProfilerSection.test.tsx`, `routes/settings.diagnostics.test.tsx`: default
   follows a connected remote rail selection; download goes to the selected
   environment; capability `false` → reason text and no call; disconnected
   choice → disabled, never downloads another environment.
6. **Docs**. `observability.md` "Diagnostic Bundle" (RPC path, manifest, name,
   remote and local split; only my hunks — another agent edits the provider
   probe paragraph); `remote.md:924` audit row (now represented as RPC, bytes
   inside the environment's channel); profiler skill `SKILL.md` "Reach the
   profiler" note: a remote host's logs and profiler files can be downloaded
   from Settings → Diagnostics with that environment selected, without SSH.

## Touches outside my owned files (need the integrator's OK)

Each is a one- or few-line declaration any new RPC requires:

- `apps/server/src/auth/scope.rs` — scope for the new method.
- `apps/server/src/rpc/methods.rs` — `read_stream` declaration.
- `apps/server/src/lifecycle.rs` — descriptor capability and its test; HTTP
  integration test assertion for the manifest.
- `apps/server/src/production/runtime.rs` — identity into
  `DiagnosticBundleService::new` and the `register_diagnostic_logs_rpc` call.
- `apps/server/src/production/diagnostic_logs_rpc.rs` (new) and its `mod`
  line in `production/mod.rs`.
- `packages/contracts/src/environment.ts` — capability flag.
- `packages/contracts/fixtures/rpc-wire/*` — regenerated parity fixtures.
- `packages/client-runtime/src/rpc/session.ts` — only if the pre-verification
  exclusion is needed.
- `docs/architecture/rpc-and-orchestration.md` — the new method in the RPC
  table near "Profiler timing and client reports".
- `docs/architecture/overview.md:1897-1913` — "Export bundle covers only the
  primary environment" and "selector that defaults to the primary" become
  false.

## Validation (phase 2)

- Rust (rustup 1.98.1 first on `PATH`, worktree `target/`, `CARGO_BUILD_JOBS=4`):
  `cargo test -p bibcode-server --lib diagnostic_bundle`, `… diagnostic_logs_rpc`,
  `… lifecycle::` (descriptor + HTTP bundle), `… auth::scope`, `… rpc::methods`;
  `cargo fmt --all --check`; `cargo clippy -p bibcode-server --all-targets -- -D warnings`.
- TS: `vp test run packages/contracts/src/rpcRustParity.test.ts packages/contracts/src/server.test.ts packages/contracts/src/environment.test.ts`;
  from `apps/web`: `vp test run --project unit src/diagnostics src/components/settings/DiagnosticsSettings.test.tsx src/components/settings/ProfilerSection.test.tsx src/routes/settings.diagnostics.test.tsx`;
  `vp check --no-fmt`, `vp check <changed files>`, `vp run typecheck`;
  `vp test run scripts/bibcode-identity.test.ts`.
- Reviews: `vercel-react-best-practices` on the changed components and hook;
  `UI.md` on the row, select, disabled reasons, and toasts.
- Not planned: a live run against a real remote server (no SSH from this Mac;
  the Omarchy server needs the user). Native visual validation runbooks under
  `docs/testing/` will be reviewed; the Diagnostics download is not one of
  their packaged flows today, so I expect "reviewed and remain accurate".

## Skipped (ponytail)

Local+remote in one archive; `bibcode` CLI access for agents; a concurrent
build cap; switching the primary to the RPC path.
