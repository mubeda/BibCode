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

## Provider maintenance

The Rust server owns installed-version probes, latest-version registry checks,
and provider update commands. The installed version always comes from the
executable BiBCode resolves for that provider instance; package-manager
inventories from other tools are not authoritative and may describe a different
installation on hosts with multiple CLI paths. The resolved executable and its
canonical target select both the latest-version source and the update action.
This ties an advisory to the installation BiBCode will update rather than to a
provider name or a package manager detected elsewhere on the host.

Source recognition is intentionally fail-closed. A custom path, wrapper, or
ambiguous installation gets no latest-version source and no executable update
action; Settings may still show a manual command when the recognized source is
display-only. Official Cursor installer metadata is fetched and parsed only to
obtain its release identifier—the installer script is never executed. Likewise,
the Claude apt, dnf, and apk maintenance commands are display-only guidance,
not commands run by the server.

The source/action mapping is installation-specific:

| Provider | Recognized source and latest metadata                                                                                           | Server update action                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Codex    | npm `@openai/codex`, selected only for a recognized standalone, Homebrew cask, or package-manager path                          | `codex update` for standalone; `brew upgrade --cask codex` for Homebrew; the matching package-manager command otherwise |
| Claude   | Native stable/latest channel, Homebrew `claude-code` or `claude-code@latest` cask, WinGet, or a marked Linux repository channel | Native `claude update`, Homebrew, and WinGet actions are executable; apt/dnf/apk guidance is display-only               |
| Cursor   | Official Cursor release paths and parsed official installer metadata                                                            | Resolved `cursor-agent update` only for an official path                                                                |
| OpenCode | npm `opencode-ai`, selected only for a recognized native, Homebrew, or package-manager path                                     | Native `opencode upgrade`, Homebrew, or the matching package-manager command                                            |

Claude channel discovery reads bounded user and managed settings, with managed
settings taking precedence, and honors `DISABLE_UPDATES=1` from the effective
provider environment or settings. That value removes the executable action but
can leave a recognized latest-version advisory and manual guidance. A managed
`autoUpdatesChannel` outside `stable` or `latest` is not a valid release source:
BiBCode withholds its latest-version advisory rather than guessing a channel.

Successful registry results are cached in memory for one hour. A manual
`server.refreshProviders` request advances the latest-version generation before
probing, so it cannot reuse a result from an earlier manual or background
refresh. Cache and in-flight lock keys are the complete latest source, including
the npm package and the Claude stable/latest channel. Lookups for different
sources remain concurrent, while instances of the same source share one lookup
per generation.

npm lookups use each package's `/latest` document. The full package document is
not a latest-version response and does not provide the top-level `version` field
consumed by provider maintenance.

Registry transport failures, non-success statuses, malformed responses, and
missing versions are not cached. They produce a visible unknown advisory with a
retry prompt but do not change provider readiness or discard inventory data.
The advisory timestamp records the registry result or attempt; the provider's
top-level `checkedAt` continues to record the executable and capability probe.

After an update command exits zero, the server advances the latest-version
generation and reprobes the target instance. A fresh `current` advisory means
`succeeded` unless the version comparison proves a downgrade. A fresh
`behind_latest` advisory, provable downgrade, or absent refreshed target is
always `unchanged`. When the advisory cannot establish currency, only a
provable installed-version advance succeeds; equal, ambiguous, or missing
comparisons remain `unchanged`. A zero exit alone is not success.

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
