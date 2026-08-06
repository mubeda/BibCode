# Provider architecture

BiBCode currently supports Codex, Claude, Cursor, and OpenCode. A provider
instance binds a driver to its configured executable, options, and readiness
state. Commands identify the instance rather than reconstructing driver state
in the client.

## Execution path

The web app sends typed Effect RPC requests to the Rust server. New turns and
thread controls use `orchestration.dispatchCommand`; snapshots and live updates
use the orchestration query and subscription methods. The server validates the
request, admits it through the `OrchestrationEngine`, and delegates provider
work to `ProviderRuntimeSupervisor`. `TurnDeliveryService` preserves delivery
ordering and recovery semantics across reconnects and process failures.

Each driver translates between the common orchestration model and its native
protocol:

| Provider | Native integration                             | Activity support                                                                           |
| -------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Codex    | Codex App Server JSON-RPC                      | Structured chat and managed-terminal observation.                                          |
| Claude   | Claude stream-JSON CLI and authenticated hooks | Structured chat and managed-terminal observation when required capabilities are available. |
| Cursor   | Agent Client Protocol                          | Normal chat only in activity protocol v1.                                                  |
| OpenCode | OpenCode server/events API                     | Structured chat and managed-terminal observation.                                          |

Provider-specific events are normalized into shared orchestration contracts;
provider wire payloads do not leak into React state. See
[RPC and orchestration](./rpc-and-orchestration.md).

## Provider instances and terminals

Enabled instances appear in the center-panel add menu. A ready instance can
create a provider panel thread; an unready instance remains visible with its
readiness reason. The same menu exposes provider-terminal actions for enabled
instances.

A provider-terminal action resolves the configured executable and built-in
arguments, then sends the structured executable/argument vector to the Rust PTY
manager in the host thread's worktree. Ordinary terminals continue to launch
the user's shell. Observation is opt-in launch metadata, not terminal-output
scraping.

## Activity support

Activity is a separate capability from provider execution. The server
advertises activity protocol v1 only after its RPC surface is registered, and
each adapter reports only the activity it can prove.

| Provider | Structured chat | Structured activity                                                                            | Provider-terminal observation                                                                                      | Downgrade behavior                                                                                       |
| -------- | --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Codex    | Supported       | Actors, attributed entries, and version-gated background tasks.                                | Supported when the executable advertises the required App Server listener and remote-TUI features.                 | Incompatible recovery or background methods reduce capabilities without disabling ordinary provider use. |
| Claude   | Supported       | Actors and attributed entries when both hook-event switches are detected; no background tasks. | Supported after safe settings composition, authenticated hooks, merge attestation, and private executable pinning. | Failed probes or recovery preserve normal chat/terminal execution without claiming unsupported activity. |
| OpenCode | Supported       | Actors and attributed entries after child-session correlation; no background tasks.            | Supported after authenticated serve/attach preparation and owned-root correlation.                                 | Reconciliation can report none, bounded, full, or stale without restarting the original command.         |
| Cursor   | Supported       | Unsupported in protocol v1.                                                                    | Unsupported in protocol v1.                                                                                        | Cursor remains usable for ordinary chat without an activity dock.                                        |

For every terminal observer, failed or timed-out preparation passes through the
original command. Once a prepared command is running, later observer failure
does not respawn it. Reserved observer-environment collisions and failure to
spawn the selected command remain hard terminal errors.

The full handshake, retention, authorization, and troubleshooting invariants
are in [Activity observation](./activity-observation.md). Shared behavior is
covered by
[`activity_provider_conformance.rs`](../../apps/server/tests/activity_provider_conformance.rs),
the
[`canonical scenarios`](../../apps/server/tests/fixtures/activity-conformance/canonical-scenarios.json),
and
[`provider_terminal_supervisor.rs`](../../apps/server/tests/provider_terminal_supervisor.rs).
