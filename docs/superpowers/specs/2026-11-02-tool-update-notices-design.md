# Tool Update Notices Design (Claude Code and CodeGraph)

Status: proposed, awaiting approval. Nothing in this document is implemented
except the Claude Code regression tests named under "Claude Code today".

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
`server.updateTool { toolId }` next to `server.updateProvider`.

Server: a tool is a `ProviderMaintenanceTarget` whose `driver` is `codegraph`.
`ProviderMaintenance` is reused unchanged except for recognition rows:

| Installation                                   | Latest source                     | Action                                    |
| ---------------------------------------------- | --------------------------------- | ----------------------------------------- |
| Standalone `.../codegraph/current/bin/codegraph` | npm `@colbymchenry/codegraph`   | Resolved `codegraph upgrade`              |
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
pickers, thread binding and session code never see a tool. Reuses 100% of the
source recognition, caching, locking and post-update verification.

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
- **In use:** an update waits for, or refuses to start while, a `codegraph`
  process rooted in one of BiBCode's own agent sessions is running (an MCP
  server or `sync`). The refusal names the blocker and says to retry when the
  agent is idle. Detecting foreign processes is out of scope.
- **Profiler/crash coverage:** the update command runs through
  `ProcessRunner` exactly like provider updates (`provider.maintenance.update`
  operation), `server.updateTool` is added to `is_long_running` in
  `diagnostics/profiler/latency.rs`, and the profiler docs list it.
- **User configuration:** neither CodeGraph's nor any agent's configuration is
  read or written. The update does not run `codegraph install` or `init`.
- **Optional `codegraph sync` after an update:** not included. It writes into
  user repositories and needs its own consent design.

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

## Open questions for approval

1. Option A, or accept B's cost for less code?
2. Is the "in use" refusal worth including in the first cut, or ship the
   notice and update first?
3. Is the informational "updated" toast wanted for Claude Code only now?

## Evidence to add on approval

Fails-before tests at each layer: `source.rs` recognition rows (standalone,
npm, unknown), `provider_maintenance.rs` advisory with an injected registry
fixture, a control-plane `server.updateTool` test with an injected command and
version source (no real installs), contracts schema tests and RPC wire fixture
(`vp run check:contracts`), web logic tests for the shared candidate type, the
Tools group, the external-update toast, and a Settings runbook entry in
`docs/testing/`.
