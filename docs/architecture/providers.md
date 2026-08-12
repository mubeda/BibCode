# Provider architecture

BiBCode currently supports Codex, Claude, Cursor, and OpenCode. A provider
instance binds a driver to its configured executable, options, readiness state,
and instance metadata. Commands identify the instance rather than
reconstructing driver state in the client.

`supportsContextWindowUsage` is provider-inventory metadata, not a UI guess or
a property of an individual usage event. Codex and Claude are the only initial
providers that advertise this capability; an absent capability means that the
client must show the feature as unavailable even if stale activity exists for a
thread. The capability does not change ordinary provider execution or activity
support.

`supportsMcpStatus` follows the same inventory-owned rule. Codex and Claude
advertise it because their adapters publish canonical `mcp.status.updated`
snapshots. Other providers leave it absent until their adapter implements an
equivalent status source; clients keep the control visible but disabled.

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

The canonical `thread.token-usage.updated` event describes two distinct values:
`usedTokens` is active context-window usage, while optional
`totalProcessedTokens` is lifetime tokens processed by the provider. The latter
is informational and never replaces the active value used to calculate context
capacity. Provider-native usage is normalized and emitted as the canonical
`thread.token-usage.updated` event by the server runtime; the typed
orchestration path persists and publishes it. It does not cross a desktop bridge
or create a client-owned provider channel.

Claude context-window usage keeps stream-derived updates as its live fallback.
After a successful turn completion, the driver sends the official correlated
`get_context_usage` control request and waits for at most two seconds. A new
valid authoritative snapshot is emitted before the deferred `turn.completed`;
an unchanged snapshot, unsupported or malformed response, writer failure,
cancellation, EOF, or timeout releases the completion immediately. Control
responses are routed by their top-level request ID and never enter the normal
provider-event stream, while timeout and shutdown paths remove all pending
waiters. The response is applied only while that turn remains current, so a
late response cannot overwrite a newer turn; failures remain nonfatal and the
last valid stream-derived snapshot stays visible.

Claude MCP status uses the CLI's native status surfaces rather than filesystem
configuration guesses. The adapter normalizes the `system:init` `mcp_servers`
snapshot and, after each successful turn, sends the correlated `mcp_status`
control request concurrently with `get_context_usage`. Native `pending`,
`failed`, and `disabled` states become canonical `starting`, `error`, and
`disconnected` states. Malformed, timed-out, unsupported, cancelled, or failed
queries are ignored; identical snapshots are suppressed and the last valid
snapshot remains visible. Control responses retain the same request routing,
cleanup, and nonfatal shutdown behavior as context queries.

## Provider usage and local credential ownership

`ProviderUsageService` owns only bounded quota snapshots, refresh admission,
staleness, and provider-specific usage requests. It does not own local provider
accounts. Authentication readiness is part of provider inventory; quota usage
is an independent observation and cannot make an instance authenticated.

For Claude, the installed CLI is the sole credential writer and refresher.
Each usage fetch rebuilds and rereads its credential sources rather than
retaining a process-lifetime credential payload. On macOS the ordered sources
are the config-scoped Keychain service, the legacy Keychain service, and the
config directory's `.credentials.json`; elsewhere the file is used. The scoped
service suffix is derived from the exact UTF-8 config-directory string in the
same form used by Claude Code. `CLAUDE_CONFIG_DIR` replaces the default
`$HOME/.claude`, and `BIBCODE_CLAUDE_KEYCHAIN_ACCESS=disabled` is the explicit
Keychain-read opt-out.

Local Claude expiry metadata is advisory for usage observation: BiBCode sends
the current access token and lets the usage endpoint decide whether it remains
valid. Only HTTP 401 permits trying the next distinct source. BiBCode never
calls Claude's OAuth token endpoint and never writes the shared credential file
or Keychain from this path. This keeps account rotation and Enterprise policy
inside the provider CLI's trust boundary.

Normal provider-usage refreshes remain throttled. A typed `force` request
bypasses that throttle for explicit user actions and the successful
disabled-to-enabled Claude transition. Background and manual UI requests have
separate single-flight ownership so a click cannot silently join a stale
polling request.

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

Inventory, maintenance, capability probes, and runtime launch share one
effective executable-search policy. A provider instance's case-insensitive
`PATH` environment entry overrides the server's ambient `PATH`; without one,
the ambient value is used. Explicit executable paths retain their normal
platform-specific handling.

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

Ownership evidence uses exact provider package identities, executable
basenames, and recognized global shim, Homebrew formula/cask, native, or WinGet
layouts. Project-local `node_modules/.bin` paths, lookalike path components, and
conflicting resolved/canonical ownership are unknown rather than inferred.

The source/action mapping is installation-specific:

| Provider | Recognized source and latest metadata                                                                                           | Server update action                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Codex    | npm `@openai/codex`, selected only for a recognized standalone, Homebrew cask, or package-manager path                          | `codex update` for standalone; `brew upgrade --cask codex` for Homebrew; the matching package-manager command otherwise |
| Claude   | Native stable/latest channel, Homebrew `claude-code` or `claude-code@latest` cask, WinGet, or a marked Linux repository channel | Native `claude update`, Homebrew, and WinGet actions are executable; apt/dnf/apk guidance is display-only               |
| Cursor   | Official Cursor release paths and parsed official installer metadata                                                            | Resolved `cursor-agent update` only for an official path                                                                |
| OpenCode | npm `opencode-ai`, selected only for a recognized native, Homebrew, or package-manager path                                     | Native `opencode upgrade`, Homebrew, or the matching package-manager command                                            |

Claude channel discovery defaults native installations to `latest` when user
settings are missing or malformed. It reads only regular local evidence under
bounded per-file, aggregate, entry-count, and I/O limits, with managed settings
taking precedence. Metadata races, special files, timeouts, overflows, and read
errors fail closed. Every present managed `autoUpdatesChannel` value other than
the strings `stable` or `latest` is invalid, including null and non-string
values; BiBCode withholds its latest-version advisory rather than guessing a
channel. `DISABLE_UPDATES=1` from the effective provider environment or settings
removes the executable action but can leave recognized advisory metadata and
manual guidance.

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

An update reservation is bound to the complete maintenance target and settings
generation. After acquiring the per-command lock, the server rereads settings,
re-resolves the target and action, and rejects a queued update if its binary,
environment, source, or command changed. Immediately before publishing or
running the action, it probes the installed version from that exact resolved
target rather than trusting the last published snapshot.

After an update command exits zero, the server advances the latest-version
generation and reprobes the target instance. A fresh `current` advisory means
`succeeded` unless the version comparison proves a downgrade. A fresh
`behind_latest` advisory, provable downgrade, or absent refreshed target is
always `unchanged`. When the advisory cannot establish currency, only an
advance from the exact pre-command version succeeds; a failed pre-command probe
disables that fallback. Equal, ambiguous, or missing comparisons remain
`unchanged`. A zero exit alone is not success.

## Activity support

Activity is a separate capability from provider execution. The server
advertises activity protocol v2 only after its RPC surface is registered, and
each adapter reports only the activity it can prove.

Codex structured chat also reports targeted actor cancellation when its adapter
can publish exact verified child-thread/active-turn handles. Those handles stay
inside the server and dispatch through the child-specific App Server
`turn/interrupt` request; provider terminals remain observation-only.

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
