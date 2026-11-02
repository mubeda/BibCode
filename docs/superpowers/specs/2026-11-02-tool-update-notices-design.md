# Tool Update Notices Design (Claude Code and CodeGraph)

Status: Revised for Codex review round 2. Option A, the Claude Code external
update toast, and "no in-use guard in the first cut" are decided. Nothing in
this document is implemented except the Claude Code regression tests named
under "Claude Code today".

Issue: #212, "Update notifications for Claude Code and CodeGraph like Codex".

## Context

The update notice the reporter sees for Codex is not Codex-specific. One
mechanism serves every provider driver:

1. `ProviderMaintenance::capabilities` (`apps/server/src/production/provider_maintenance.rs`
   and `provider_maintenance/source.rs`) resolves the configured executable and
   its canonical target, recognizes the installation that owns it, and returns
   the latest-version source plus the update action for that installation.
   Unrecognized paths get neither (fail closed).
2. `ProviderMaintenance::enrich_snapshot` probes nothing itself. It takes the
   installed version from the provider probe, fetches the latest version (npm
   `/latest`, the Claude release channel, or the Cursor installer metadata;
   cached one hour, retried after a failure), and writes
   `versionAdvisory { status, currentVersion, latestVersion, updateCommand,
canUpdate, message }` onto the `ServerProvider` snapshot.
3. `server.updateProvider` re-resolves the target under the per-command lock,
   runs the action through `ProcessRunner`, reprobes, and reports
   `succeeded`, `unchanged` or `failed` in `updateState`.
4. The web client turns a `behind_latest` advisory into the launch toast, the
   sidebar pill, the per-environment rows and **Settings → Providers → Update
   all…**. These are keyed by `driver` and `instanceId`, never by provider name.
   Remote, WSL and SSH environments are separate servers, so each one probes and
   updates the installation it owns; the client only fans the call out.

## Claude Code today

Claude Code is already a full participant. `claudeAgent` has a package
definition, a native `claude update` action (including
`%USERPROFILE%\.local\bin\claude.exe`), Homebrew and WinGet actions,
display-only apt/dnf/apk guidance, and release-channel latest lookup. The
reporter's Windows native install (`claude.exe` under `~/.local/bin`) maps to
`claude-native` with `claude update` and the `latest` channel.

I could not find a defect that would suppress the notice. What the issue
actually exposes is a different gap: Claude Code's own auto-updater advances the
installed version in the background, so BiBCode usually sees "current" and
nothing ever says that an update happened. This design therefore treats
Claude Code as "already served" and adds only the missing sentence (see
"External update notice").

Regression tests added with this document pin the Windows native path,
including the verbatim canonical form (`\\?\C:\Users\...`) that
`std::fs::canonicalize` returns on Windows, so a future ownership change cannot
silently drop the notice.

## CodeGraph today

BiBCode does not track it. CodeGraph is not an agent provider: it has no
sessions, models, authentication or thread binding, and it is not in
`settings.providerInstances`. Facts checked on a real install (1.6.2):

- `codegraph --version` prints the bare version (`1.6.2`).
- It ships its own updater: `codegraph upgrade [--check] [--force] [version]`.
- It has more than one install layout. This repository's maintainer machine
  uses the standalone layout `%LOCALAPPDATA%\codegraph\current\bin\codegraph`;
  the reporter uses a global npm install (`@colbymchenry/codegraph`).
- npm `/latest` for `@colbymchenry/codegraph` returns the top-level `version`
  that `LatestVersionSource::Npm` already parses.

## Decision needed: how CodeGraph enters the mechanism

### Option A (recommended): a small, separate "tools" snapshot that reuses the maintenance backend

Add `ServerTool`, a strict subset of the fields the update flow already reads
from `ServerProvider`: `toolId` (`"codegraph"`), `displayName`, `installed`,
`version`, `versionAdvisory`, `updateState`, `checkedAt`. Carry `tools` next
to `providers` in the server config snapshot and its stream, and add
`server.updateTool { toolId }` next to `server.updateProvider`. The exact wire
rules are under "Wire compatibility".

Server: a tool is a `ProviderMaintenanceTarget` whose `driver` is `codegraph`
and whose `instance_id` is the tool id. `ProviderMaintenance` is reused with
recognition rows plus the adapter under "Maintenance adapter":

| Installation                                   | Latest source                     | Action                                    |
| ---------------------------------------------- | --------------------------------- | ----------------------------------------- |
| Standalone `.../codegraph/current/bin/codegraph` | npm `@colbymchenry/codegraph`   | Resolved `codegraph upgrade`, with the environment in "Agent configuration" |
| Recognized npm/pnpm/Bun/Vite+ global path      | npm `@colbymchenry/codegraph`     | Matching package-manager command          |
| Anything else                                  | none                              | Manual only, with the reason shown        |

The installed version comes from `codegraph --version` run through the same
bounded `run_command` probe. The target is resolved from `PATH` with the
server's own environment, so a WSL, SSH or remote-environment server checks and
updates the CodeGraph installed in that environment, never the client's.

Web: widen the update logic's input type from `ServerProvider` to the shared
subset (`instanceId`/`driver` become the tool id), so the toast, pill,
environment rows and Update all pick tools up with the same keys. Add a
**Tools** group to Settings → Providers that lists installed and latest
versions per tool, with **Update**, and a reason when it cannot update.

Trade-offs: one new contract type and one RPC; the provider list, model
pickers, thread binding and session code never see a tool. Reuses the
source recognition, caching, locking and post-update verification, through a small field-based adapter.

### Option B: CodeGraph as a hidden provider driver

Emit a `ServerProvider` snapshot for `codegraph` with `models: []` and an
`isTool` marker, so every existing update surface works with no contract or RPC
change. Rejected: 23 non-test web modules and the server's provider routing
iterate the provider list (pickers, defaults, readiness banners, capability
discovery). Each needs an exclusion and a missed one shows CodeGraph as a
selectable agent. The marker would be a permanent tax on every provider change.

### Option C: only document `codegraph upgrade`

No code. Rejected: the issue asks for a notice and a one-click action.

## Behaviour (Option A)

- **Where the check runs:** on the server that owns the environment; checks
  never cross an environment boundary.
- **Cadence:** same as providers: with the five-minute subscription refresh,
  hourly cache, and manual refresh. Disabled by the same "update checks"
  setting that disables provider checks.
- **Not installed:** no row and no notice (nothing to update). Settings shows
  "CodeGraph is not installed" only on the Tools group.
- **Unknown install method:** version is shown, latest is unknown, the row says
  "BiBCode cannot tell how CodeGraph was installed, so it will not update it.
  Run `codegraph upgrade` yourself." No button.
- **Offline or registry failure:** the existing unknown advisory with a retry
  prompt; nothing else changes.
- **In use:** no guard in the first cut (decided). An update can replace
  files a running CodeGraph MCP server or `sync` holds; the row says so before
  the click ("Close running agent sessions that use CodeGraph first.") and a
  failed replacement is handled by "Update ownership and interruption".
- **Profiler/crash coverage:** see "Profiler and attribution".
- **Agent configuration:** see "Agent configuration". BiBCode never reads or
  writes any agent's configuration, and the update does not run
  `codegraph install` or `init`.
- **Optional `codegraph sync` after an update:** not included. It writes into
  user repositories and needs its own consent design.

## Update ownership and interruption

Request-bound `ProcessRunner` is wrong for this action: `process/supervised.rs`
kills the whole process tree when the handler future drops, and CodeGraph
1.6.2's Windows updater replaces files one by one and keeps its rollback
journal in memory. A client disconnect after an old file is renamed would kill
the updater before it can roll back, leaving missing or mixed-version files.

So `server.updateTool` does not run the command in its own handler:

- The handler validates, reserves the tool (`reserve_target`: one update per
  tool at a time, plus the existing per-command lock) and spawns the update as
  a **server-owned background task** whose cancellation token belongs to the
  server, not to the request. If the client is still connected the handler
  waits for the task and returns; if not, the task keeps running and publishes
  the final `updateState` and refreshed `tools` through the config stream like
  any refresh. A second `server.updateTool` for the same tool while one runs
  gets the existing "already updating" refusal.
- The only cancellation is server shutdown. Policy: at quiesce the server waits
  for a running tool update for at most 30 seconds (inside the existing
  5-minute command timeout) and never kills the updater earlier, because
  killing is what corrupts the install. If it has not finished, shutdown logs
  `tracing::warn!` with the tool and proceeds (shutdown's process cleanup and
  the Windows job object then reap it), and the recovery below covers the
  result.
- **Recovery if interrupted.** After any update that ends without a verified
  success (timeout, non-zero exit, shutdown, crash) and on every startup, the
  next probe runs `codegraph --version`. A probe that fails or prints no
  version for an executable that still resolves, or a resolved path whose
  install directory no longer exists, is reported as a **broken install**:
  `installed: true`, `version: null`, advisory `unknown` with the message
  "CodeGraph looks damaged (the last update may have been interrupted)." The
  one-click action becomes a reinstall (`codegraph upgrade --force`, or the npm
  install command for an npm install) when the executable still runs;
  otherwise the row shows the manual reinstall instructions. BiBCode never
  deletes or repairs files itself.
- Tests: with an injected updater command that renames a marker file, sleeps,
  then restores it (a stand-in for the rollback journal), start
  `server.updateTool` and drop the request mid-sleep. Assert the child is still
  alive, finishes and restores the marker, `updateState` ends
  `succeeded`/`unchanged`, and the broken-install state appears only when the
  marker is left unrestored and the following probe fails. A second test
  asserts shutdown during an update waits up to the stated budget and does not
  kill earlier.

## Agent configuration

`codegraph upgrade` 1.6.2 can, on its success path, write Claude's prompt hook
and run `codegraph install --refresh`, which rewrites agent instructions and
MCP configuration. Every CodeGraph update action therefore runs with
`CODEGRAPH_NO_PROMPT_HOOK=1` and `CODEGRAPH_NO_INSTALL_REFRESH=1` added to the
child's normalized environment. The npm and package-manager variants get the
same two variables because package lifecycle scripts may reach the same code.
The variables are verified against 1.6.2 only: the code records that version,
and an installed major newer than the verified one shows the update as manual
until the variables are re-verified.

Tests: a unit test on the command builder asserts both variables are present
for every CodeGraph action; an integration test runs an injected stub updater
that fails if either variable is missing, and asserts a sentinel agent-config
file in a temporary home is untouched. No test touches a real user's
configuration.

## Maintenance adapter

`enrich_snapshot` reads `enabled`, `installed`, `version` and `checkedAt` from a
JSON snapshot, and `overlay_update_state` reads `instanceId` and `driver`.
`ServerTool` has no `enabled`, so passing it unchanged would skip the latest
lookup (always `unknown`) and never overlay progress. Rather than make a tool
pretend to be a provider, extract the two functions' cores into field-based
entry points that both callers use:

- `enrich_advisory(target, ProbeFields { enabled, installed, version,
checked_at }, checks_enabled) -> Value` (the existing `enrich_snapshot`
  becomes a thin wrapper that reads those fields from the provider JSON), and
- `update_state_for(instance_id, driver) -> Option<Value>` (the existing
  `overlay_update_state` wraps it).

The tool path passes `enabled: true` and writes the results onto the tool JSON.
Provider behavior must not change: the existing maintenance tests stay green
unmodified.

End-to-end test (injected registry fixture, version probe and command; no real
install): a tool at `1.6.1` against a fixture latest of `1.6.2` yields
`behind_latest` with `canUpdate: true`; `server.updateTool` publishes
`queued`/`running`/`succeeded` through the config stream and the final reprobe
shows `current`. It fails before the adapter exists (the advisory stays
`unknown`).

## Wire compatibility

- `ServerConfig.tools` is `Schema.optionalKey(Schema.Array(ServerTool))`, and the
  client reads an absent key as `[]`. A required array would reject an older
  remote or SSH server's initial snapshot and block the connection.
- Stream: `tools` is an optional key on `ServerConfigProviderStatusesPayload`,
  not a new event type, so an older client ignores it and an older server never
  sends it. An absent `tools` on a statuses event means "unchanged", not
  "none".
- `server.updateTool` is a new RPC. The client gates every tool surface and the
  call on server support: a snapshot that carries a `tools` key (even `[]`)
  means the server supports tools; a missing key hides the Tools group and the
  tool candidates, and the client never calls `updateTool` on that environment
  (an old server would answer with an unknown-method error).
- Fixtures under `packages/contracts/fixtures/rpc-wire`: an old-server snapshot
  and statuses event (no `tools`) decode in the new client and yield `[]`; a
  new-server snapshot and statuses event (with `tools`) decode under the
  previous schema (the unknown key is ignored); a client test asserts no
  `updateTool` request is issued for an environment whose snapshot lacks
  `tools`. `vp run check:contracts` covers the manifest.

## Profiler and attribution

`ProcessRunner` registers no process identity, so an unregistered descendant is
found only by the 60-second sampler sweep and classed `other`, which raises no
resource findings; a short updater could be missed entirely. The updater is
therefore spawned through `process::supervised` and its identity is registered
with `ProcessAttributionRegistry::register_identity` for the updater's
lifetime. The `ProcessRegistration` is held by the background task and dropped
when the child exits, on every path (success, failure, timeout, shutdown). The
exit goes through `diagnostics::profiler::exits::report_exit` with the right
`Watch`, so an unrequested death becomes a `subprocess.crash`.
`server.updateTool` is added to `is_long_running` in
`diagnostics/profiler/latency.rs`, shutdown stops the background update before
the profiler's teardown, and the docs under
`docs/skills/bibcode-profiler/references/` and the architecture Profiler
section list the new operation. Test: the registry holds the updater's
identity while it runs and is empty after it exits, including after a
mid-update disconnect, and `server.updateTool` does not raise `rpc.slow`.

## External update notice

Claude Code (and later CodeGraph) can be updated by its own updater. The web
client already receives every version change through the provider snapshot
stream. When an enabled instance's reported `version` increases between two
snapshots from the same environment and BiBCode did not start an update, show
one informational toast: "Claude Code updated to 2.1.318. New sessions use it."
It is dismissible, appears once per version per environment, is stored with the
existing dismissed-notification keys, and is never shown on first connect
(there is no previous version to compare). Running sessions keep the version
they started with, and the toast says so.

## Alternatives not taken

- A server-side "last seen version" store: needs a persisted shape for one toast.
- Auto-updating on a timer: the existing mechanism never installs without a click.
- Updating through `claude update` while `DISABLE_UPDATES=1`: unchanged; the
  advisory remains visible without the action.

## Decisions

1. Option A (separate `ServerTool` snapshot plus `server.updateTool`).
2. The first cut has no running-CodeGraph guard; the row warns instead.
3. The informational "updated" toast ships for Claude Code in this change.

## Evidence to add on implementation

Fails-before tests at each layer, with no real installs (injected version,
registry and command sources): `source.rs` recognition rows (standalone, npm,
unknown, broken install); the adapter advisory/progress test; the
disconnect-during-update, shutdown-budget and identity-registration tests; the
environment propagation test; contracts schema tests plus the old/new wire
fixtures (`vp run check:contracts`); web logic tests for the shared candidate
type, the capability gate (no call to servers without `tools`), the Tools group
and the external-update toast; and a Settings entry in `docs/testing/`.
