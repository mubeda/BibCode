# Provider architecture

The web app communicates with the server via WebSocket using a simple JSON-RPC-style protocol:

- **Request/Response**: `{ id, method, params }` → `{ id, result }` or `{ id, error }`
- **Push events**: typed envelopes with `channel`, `sequence` (monotonic per connection), and channel-specific `data`

Push channels: `server.welcome`, `server.configUpdated`, `terminal.event`, `orchestration.domainEvent`. Payloads are schema-validated at the transport boundary (`wsTransport.ts`). Decode failures produce structured `WsDecodeDiagnostic` with `code`, `reason`, and path info.

Methods mirror the `NativeApi` interface defined in `@bibcode/contracts`:

- `providers.startSession`, `providers.sendTurn`, `providers.interruptTurn`
- `providers.respondToRequest`, `providers.stopSession`
- `shell.openInEditor`, `server.getConfig`

Provider instances are configured per driver. Current drivers include Codex,
Claude, Cursor, Grok, and OpenCode. Enabled instances remain visible in the
center-panel `+` menu. Ready instances can create a hidden panel thread; unready
instances are disabled with their readiness reason.

The same menu also exposes provider terminal actions for enabled instances.
Each action resolves the instance's configured binary path plus the built-in
provider terminal arguments and stores a structured launch command on a center
terminal surface. Terminal attachment sends the executable and argument vector
to the Rust terminal manager, which starts it directly under the PTY in the
host thread's current worktree. Ordinary terminal actions continue to launch
the user's shell.

## Activity support

Structured activity is a separate capability from provider execution. The
server advertises activity protocol v1 to compatible clients, then each
provider adapter reports only the capabilities it can prove. Provider-terminal
observation is opt-in metadata on a BiBCode-managed terminal launch; it is not
terminal-output scraping.

| Provider | Structured provider chat | Structured activity                                                                                       | Provider-terminal observation                                                                                                         | Recovery and downgrade                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | Supported.               | Actors and attributed entries; background tasks only after the runtime accepts its reconciliation method. | Supported when the configured executable advertises App Server listener and remote-TUI features.                                      | Structured chat downgrades incompatible recovery/background methods. The terminal observer publishes only after root resume and preserves known state across optional reconciliation failures; later observer failure neither respawns the original command nor directly closes unresolved records.                                                                                                                   |
| Claude   | Supported.               | Actors and attributed entries when both hook-event switches are detected; no background tasks.            | Supported only after safe settings composition, authenticated hooks, additive merge attestation, and safe private executable pinning. | History is `none` until correlated transcript recovery proves bounded recovery. Unsupported probes preserve normal chat/terminal execution without activity. After terminal handoff, failure does not respawn the original command; an ending observer interrupts the active records it tracked.                                                                                                                      |
| OpenCode | Supported.               | Actors and attributed entries after child-session correlation; no background tasks.                       | Supported after authenticated serve/attach preparation and owned-root correlation.                                                    | Structured chat exposes none, bounded, or full recovery from child/status/message endpoint support and marks transient reconciliation failure stale. The terminal path publishes `full` after correlation, then skips later endpoint failures without a capability downgrade. Failed asynchronous correlation leaves the prepared attach running without a published scope; it does not respawn the original command. |
| Cursor   | Supported.               | Unsupported in v1.                                                                                        | Unsupported in v1.                                                                                                                    | Cursor remains an ordinary BiBCode provider; no structured activity or activity dock is exposed.                                                                                                                                                                                                                                                                                                                      |
| Grok     | Supported.               | Unsupported in v1.                                                                                        | Unsupported in v1.                                                                                                                    | Grok remains an ordinary BiBCode provider; no structured activity or activity dock is exposed.                                                                                                                                                                                                                                                                                                                        |

For all three terminal observers, rejected or timed-out preparation passes
through the original command. A reserved observer environment-key collision is
a hard terminal error, as is failure to spawn the selected prepared command. If
a prepared observer becomes not-ready before `on_spawned`, the manager discards
the uncommitted prepared PTY and respawns the original command. An `on_spawned`
timeout or panic cancels and fences activity observation but preserves and
registers the running prepared terminal; it does not perform that fallback.
Later provider correlation is also asynchronous and does not respawn the
original command.

The complete invariants, handshake fallback, retention, and troubleshooting
states are documented in
[Activity observation](./activity-observation.md). Shared adapter semantics are
fixture-driven in
[`apps/server/tests/activity_provider_conformance.rs`](../../apps/server/tests/activity_provider_conformance.rs)
and
[`apps/server/tests/fixtures/activity-conformance/canonical-scenarios.json`](../../apps/server/tests/fixtures/activity-conformance/canonical-scenarios.json);
terminal negotiation and pass-through behavior are covered by
[`apps/server/tests/provider_terminal_supervisor.rs`](../../apps/server/tests/provider_terminal_supervisor.rs).

## Client transport

`wsTransport.ts` manages connection state: `connecting` → `open` → `reconnecting` → `closed` → `disposed`. Outbound requests are queued while disconnected and flushed on reconnect. Inbound pushes are decoded and validated at the boundary, then cached per channel. Subscribers can opt into `replayLatest` to receive the last push on subscribe.

## Server-side orchestration layers

Provider runtime events flow through queue-based workers:

1. **ProviderRuntimeIngestion** — consumes provider runtime streams, emits orchestration commands
2. **ProviderCommandReactor** — reacts to orchestration intent events, dispatches provider calls
3. **CheckpointReactor** — captures git checkpoints on turn start/complete, publishes runtime receipts

All three use `DrainableWorker` internally and expose `drain()` for deterministic test synchronization.
