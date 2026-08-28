# Environment and project management specification

**Status:** Proposed; product decisions in [Questions requiring approval](#questions-requiring-approval) must be resolved before implementation
**Date:** 2026-08-24
**Scope:** desktop, server, web, contracts, client runtime, relay, persistence, installers, release CI, and native validation

## Summary

BiBCode should present the hierarchy users actually operate:

```text
Environment
└── Project (exists only in that environment)
    ├── Main thread (canonical, undeletable)
    └── Threads (zero or more ordinary, panel, or worktree threads)
```

An environment is not a folder or a transport. It is one logical BiBCode
server, its execution host, filesystem, credentials, provider processes,
projects, threads, and durable store. A direct URL, BiBCode Connect route, SSH
tunnel, and desktop-managed launch are alternative access paths to that same
environment. The server remains authoritative for projects and threads. The
client catalog owns only how this client discovers, labels, connects to, and
trusts an environment.

This is an information-architecture and lifecycle change, not a reason to make
projects global. Two clones of the same repository on different machines are
two projects with independent IDs, settings, sessions, transcripts, and
filesystem state.

## Goals

1. Make multiple local and remote environments first-class in the left panel.
2. Show only the projects reported by each environment, including a cached but
   visibly stale view while that environment is unavailable.
3. Preserve the existing main-checkout/default-thread invariant and allow
   multiple sibling threads beneath every project.
4. Support Linux, Windows, macOS, and Windows WSL execution hosts without
   placing platform-specific paths or process behavior in the renderer.
5. Make discovery, connection, settings, forgetting, unlinking, and remote
   uninstall distinct operations with explicit consequences.
6. Ship a headless server package for each supported OS and provide secure,
   understandable onboarding after installation.
7. Remain predictable during disconnects, restarts, identity changes, partial
   synchronization, duplicate discovery, and concurrent catalog edits.

## Non-goals

- Synchronizing project files, Git state, provider credentials, or transcripts
  between environments.
- Treating a Git remote URL as global project identity.
- Running a Node.js, Electron, or TypeScript production server.
- Letting browser code execute SSH, install services, inspect WSL, or manipulate
  remote files outside typed server RPC.
- Deleting server data when a client merely forgets a connection.
- Introducing a relay data plane; BiBCode Connect remains a control plane.

## Current-state findings

The repository already contains most of the difficult connection foundation:

- one server already represents one environment and publishes stable
  `environmentId` plus persistent `storageInstanceId`;
- client state and RPC commands are keyed by environment;
- bearer, relay, SSH, primary, and platform-unavailable targets already share
  one supervised connection pipeline;
- the desktop owns WSL and SSH launch, while normal application traffic uses
  HTTP and Effect RPC over WebSocket;
- a server-local SQLite store already owns project and thread projections; and
- the UI already merges environment-scoped project snapshots, but its primary
  navigation is project-first and environment management is hidden in settings.

The main functional gaps are that fresh desktop SSH pairing calls a removed CLI
command, platform WSL topology is modeled as a selected auxiliary backend rather
than a durable per-distribution navigation concept, and release automation ships
desktop bundles rather than installable headless services.

## Product model and invariants

### Environment identity

An `Environment` navigation record is a client-side join, never a duplicate of
server-owned project data:

```ts
interface EnvironmentNavigationRecord {
  environmentId: EnvironmentId;
  source: "primary" | "platform" | "manual" | "ssh" | "connect";
  ownership: "platform" | "user" | "relay";
  display: { label: string; color: string | null; icon: string | null };
  target: ConnectionTarget;
  descriptor: ExecutionEnvironmentDescriptor | null;
  connection: SupervisorConnectionState;
  acceptedStorageInstanceId: string | null;
  cachedProjectSnapshot: EnvironmentProjectSnapshot | null;
}
```

Hard invariants:

- `environmentId` routes requests; `storageInstanceId` protects durable-store
  continuity. Neither a URL nor a host name is identity.
- A navigation record may have several candidate access methods, but exactly one
  supervised live session wins at a time. A later multi-route feature must use
  an ordered route set under one target rather than create duplicate environment
  nodes.
- Platform-discovered records are reconciled, not persisted as user-created
  targets. A user may hide one, but cannot claim to delete the underlying OS
  environment.
- A changed non-null storage identity blocks project cache publication before
  synchronization. The user must explicitly accept or recover it.

### Project identity and ownership

The environment server remains the sole source of truth. The server database
does **not** need an `environment_id` column: a store belongs to exactly one
environment, so such a column would duplicate a constant, permit impossible
cross-environment rows, and complicate restore.

Project IDs need only be unique inside an environment. Every client key, route,
cache key, optimistic mutation lane, selection, and persisted layout that can
contain data from multiple environments must use the compound runtime identity
`(environmentId, projectId)`. The same rule extends to threads:
`(environmentId, threadId)`.

Within one server store:

- `projection_projects.project_id` is the parent identity;
- each thread row references exactly one project with an enforced foreign key;
- exactly one canonical main thread exists for every live project;
- the main thread cannot be removed independently from its project;
- ordinary/panel/worktree threads can be numerous; and
- project deletion is an explicit server command with a preview/confirmation
  contract, not a client-side cascade.

### Main thread

Do not add a nullable `main_thread_id` in both project and thread records. That
would create two writable sources of truth. Prefer a thread role:

```sql
ALTER TABLE projection_threads
  ADD COLUMN role TEXT NOT NULL DEFAULT 'secondary'
  CHECK (role IN ('main', 'secondary'));

CREATE UNIQUE INDEX projection_threads_one_live_main_per_project
  ON projection_threads(project_id)
  WHERE role = 'main' AND deleted_at IS NULL;
```

The migration must derive `role = 'main'` from the existing default/canonical
thread invariant, fail closed on zero or multiple candidates, and only then add
the unique partial index. Commands that create projects create project plus main
thread in one SQLite transaction. Projection replay must preserve the invariant.

## Left-panel information architecture

The panel uses a three-level tree, with virtualization once row count warrants
it:

```text
▾ This Mac                                      ● Connected   …
    ▾ BiBCode                           branch/main   +
        Main                                         Working
        Fix updater                                  Approval
        Experiment                                   Completed
▸ Ubuntu (WSL)                                  ○ Sleeping    …
▾ Build PC                                      ! Offline     …
    Cached Project                                  stale
+ Add environment
```

### Environment row

The row contains:

- platform icon and editable client-local label;
- one calm status affordance: connected, connecting, backoff, offline, blocked,
  update available, or platform sleeping;
- aggregate actionable indicators, not a count of every low-level event;
- disclosure control independent of selection; and
- an overflow menu for Connect/Disconnect, Retry, Settings, Diagnostics, Copy
  connection details, Hide/Show, Forget, Unlink Connect, and Uninstall help as
  applicable to ownership and access type.

Click selects the environment landing state; disclosure expands it. Selecting
an offline environment never silently switches to another host. Cached projects
remain visible, marked stale, and mutating controls remain disabled until that
environment is authoritative.

### Project and thread rows

Projects are rendered only inside their environment. Project actions inherit
that environment and never open a global environment picker. Each project shows
its canonical `Main` row first, followed by pinned/active threads and then the
configured thread sort. The existing worktree and panel-thread distinctions
remain properties of threads, not extra hierarchy levels.

The add-project button on an environment row opens a folder picker **on that
execution host** through server RPC. Desktop local/WSL privileged picker bridges
may be used only when the selected server advertises the matching capability.
No local path is offered for a remote server.

### Scale and accessibility

- Persist expansion by `environmentId` and by compound project identity.
- Virtualize the flattened visible tree and preserve stable row keys.
- Use ARIA tree/treeitem semantics, Left/Right collapse/expand, Up/Down traversal,
  Home/End, and type-ahead; actions remain keyboard reachable.
- Do not continuously subscribe to every environment's high-volume domains.
  Maintain one lightweight environment shell/project subscription per desired
  environment and acquire thread detail only for expanded/visible/prewarmed rows.
- Cap concurrent initial environment synchronization and reconnect attempts;
  apply per-environment jittered backoff so one outage cannot create a reconnect
  storm.

## Environment settings

Settings are divided by owner so the UI does not imply unsupported remote
mutation.

### Client-owned settings

- label, icon/color, ordering, expanded/hidden state;
- auto-connect and reconnect policy;
- preferred access method/endpoint and fallback order;
- manual endpoint URL or SSH profile reference;
- trusted `storageInstanceId` decision and credential replacement/removal; and
- Connect link state.

### Server-owned settings (read/write through typed RPC)

- server label and update channel;
- provider installation, authentication health, defaults, and capabilities;
- default shell, Git executable/identity visibility, project base directories;
- worktree root/policy and terminal defaults;
- listen/reachability policy, advertised endpoints, proxy/TLS status;
- log level, diagnostics export, data-root/store identity (sensitive paths are
  restricted to authenticated administrators); and
- service version, OS/architecture, uptime, resource/capacity summary, and
  restart/update availability.

### Host/service-owned settings

- startup mode and service account;
- bind interface and port;
- firewall instructions/status;
- TLS certificate source/renewal status;
- update policy and maintenance window; and
- uninstall while keeping or removing data.

These settings require an authenticated administrative capability. They must
not be inferred from ordinary project RPC availability. Secrets are referenced
by credential IDs and stored using OS facilities where supported, never echoed
in general settings payloads or logs.

## Environment types and discovery

`hostPlatform` (`linux | windows | macos`) is a server descriptor fact.
`source` and `transport` are client facts. Do not create Linux/Windows/macOS
connection target classes: the same bearer, relay, or SSH transport can reach
any supported host.

### Local desktop host

The in-process server is the immutable primary platform environment. It can be
collapsed or hidden from routine navigation only if another environment is
selected, but cannot be forgotten while the desktop owns it.

### WSL

On Windows, the desktop periodically and on relevant lifecycle events executes
a bounded, output-limited `wsl.exe --list --verbose` topology probe. Microsoft
documents this command as reporting installed distributions, their running or
stopped state, and WSL version. Each installed distribution becomes a stable
platform environment `wsl:<normalized distribution identity>`.

When WSL is enabled and a distribution is running, it is always reconciled into
the catalog by default. Recommended policy is to show every installed distro;
running distros are desired immediately, while stopped distros are visible as
sleeping and start only on explicit Connect or project selection. A user may
hide a distro but may not forget it. Unregistering a WSL distro is deliberately
out of scope because that can destroy unrelated Linux data.

Persist an OS-derived distribution identity plus its latest display name; do
not key settings only by mutable display order or the `default` alias. Debounce
topology changes, retain the last good snapshot on probe failure, and never run
unbounded WSL commands on the UI thread. The desktop launches the existing
native `bibcode` binary inside the selected distribution and publishes a
platform registration through the bridge. Projects remain in that distro's
server store.

### Remote Linux, Windows, and macOS

All three may be reached by:

1. a previously installed headless BiBCode service over a private/LAN endpoint,
   TLS endpoint, or BiBCode Connect;
2. desktop-managed SSH that probes/launches a user-mode server and forwards it;
   or
3. a manually supplied endpoint and one-time pairing credential.

SSH and service installation are separate capabilities. Browser clients can
pair with a reachable service but cannot perform SSH bootstrap.

## Headless server packaging and connection

### Artifacts

CI should produce signed/checksummed native packages from the existing Rust
`bibcode` binary:

| OS      | Required first-class package | Service manager                 | Initial architecture |
| ------- | ---------------------------- | ------------------------------- | -------------------- |
| Windows | MSI                          | Windows Service Control Manager | x64                  |
| macOS   | signed/notarized `.pkg`      | `launchd` LaunchDaemon          | arm64 and x64        |
| Linux   | `.deb` and `.rpm`            | systemd system service          | x64, then arm64      |

A `.tar.gz`/`.zip` portable binary may accompany packages but is not called an
installer and does not auto-register a service. Package scripts must use
OS-native service definitions; they must not add a Node runtime or generic
sidecar.

Default service behavior is fail-closed and conservative:

- create a dedicated least-privilege service account where practical;
- create a durable data/config directory with restrictive permissions;
- listen on loopback by default, or require an explicit private-network/TLS
  choice before non-loopback binding;
- generate environment/store identity on first start;
- emit no reusable secret to logs;
- restart on abnormal failure with bounded backoff; and
- preserve data on ordinary uninstall unless the user explicitly selects a
  destructive purge action.

### Pairing after installation

The current removed `auth pairing create` dependency should not be resurrected
as a long-lived shared token. Add a typed, bounded pairing lifecycle:

1. An administrator runs `bibcode pairing create` locally (or the installer
   displays the result once).
2. The server creates a random, single-use, short-lived pairing grant and shows
   a human-readable code plus a URL/QR whose secret is in the fragment.
3. The client fetches the public environment descriptor, shows environment
   identity, host, reachability, and TLS verification, then asks the user to
   confirm.
4. The client redeems the grant over authenticated TLS/private forwarding for a
   revocable device credential, preferably DPoP-bound.
5. The server atomically consumes the grant; replay, expiry, identity mismatch,
   excessive attempts, or storage mismatch fail closed.
6. Ordinary HTTP authorization and a short-lived WebSocket ticket then use the
   existing connection runtime.

RFC 8628 provides useful device-code polling, expiry, and backoff semantics;
RFC 8252 requires external user agents and redirect protection for native apps;
RFC 9449 provides sender-constrained DPoP tokens. BiBCode can reuse these
properties without claiming full OAuth conformance for a local pairing API.

For SSH bootstrap, repair the current flow to install/probe a versioned binary,
start it loopback-only, obtain the same one-time pairing grant through a
machine-readable local command, and forward the port. Never parse a reusable
credential from process listings or a world-readable file.

### Discovery

Use explicit setup, Connect discovery, and SSH profiles as authoritative paths.
Tailscale MagicDNS may improve names, but names are not identity. Optional mDNS
advertising is appropriate only for same-link convenience, is disabled by
default for managed/headless deployments, carries no secret, and still requires
pairing and descriptor verification.

## Persistence and contract refactoring

### Server SQLite

1. Add/enforce `projection_threads.project_id` foreign key to projects.
2. Add the single-source `role` invariant and partial unique main-thread index.
3. Add a durable server-settings table with revision/CAS semantics for settings
   mutable over RPC. Do not mix it with the client connection catalog.
4. Add pairing grants and device credentials as hashed/derived secrets with
   expiry, consumed/revoked timestamps, attempt counters, scopes, and audit
   metadata. Raw grants are returned once and never persisted.
5. Add an idempotent device-revocation command and bounded audit retention.

SQLite foreign keys must be enabled and checked for every connection. Migration
tests must cover old stores, malformed canonical-thread states, rollback backup,
projection rewind/replay, and concurrent create/delete.

### Contracts

- Extend `ExecutionEnvironmentDescriptor` additively with OS, architecture,
  service/runtime metadata, administrative capabilities, and a monotonically
  increasing settings revision. Older servers decode absent fields safely.
- Introduce typed `EnvironmentSettingsPublic`, `EnvironmentSettingsAdmin`,
  `EnvironmentSettingsPatch`, and redacted error schemas.
- Introduce pairing create/status/redeem/revoke HTTP contracts and stable error
  codes. Keep secrets out of WebSocket URLs.
- Add environment topology bridge contracts for a list of WSL distributions,
  not one selected distro.
- Do not put runtime logic into `packages/contracts`.

### Client catalog and presentation

Evolve the catalog with a versioned migration rather than additive unversioned
ambiguity. Separate:

- `savedEnvironments`: user-owned target/access metadata;
- `credentials`: protected secrets referenced by IDs;
- `acceptedStorageIdentities`;
- `environmentPresentation`: label override, color, order, hidden/collapsed;
- `platformEnvironmentPreferences`: hide/auto-connect per stable platform key;
  and
- optional preferred route selection.

Project/thread data stays in environment-keyed cache stores and is invalidated
or quarantined as one environment partition. Forgetting an environment removes
its saved target, credentials, accepted identity, and cached partition in one
retry-safe operation; it never sends project deletion RPCs.

## Removal and lifecycle semantics

Use distinct verbs and confirmation copy:

| Action                 | Owner               | Result                                                                                                  |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| Disconnect             | client supervisor   | closes live lease; keeps target, credentials, cache                                                     |
| Hide                   | client presentation | removes platform node from normal tree; OS environment remains                                          |
| Forget                 | client catalog      | removes user-owned target, credentials, trust, and cache only                                           |
| Unlink                 | relay control plane | removes Connect association; server and other access paths remain                                       |
| Revoke device          | environment server  | invalidates one client's credential                                                                     |
| Remove project         | environment server  | archives/deletes project state according to a previewed plan; never deletes repository files by default |
| Uninstall server       | OS administrator    | removes service/binary; data is retained unless separately purged                                       |
| Purge environment data | OS administrator    | destructive, local-to-host operation requiring explicit typed confirmation                              |

Removal closes new work, cancels/awaits owned synchronization and sessions,
then changes durable catalog state. A concurrent platform reconciliation cannot
convert a platform-owned environment into a forgettable saved target. A failed
credential deletion leaves a visible recovery-required state rather than a
half-forgotten usable environment.

## Reliability, security, and performance requirements

- Partition caches, command lanes, subscriptions, optimistic state, and stale
  results by environment; reject late publications from retired generations.
- Bound connection preparation, descriptor fetch, pairing, SSH, WSL, installer
  smoke tests, and shutdown. Cancellation must retain a reaper for spawned work.
- Serialize mutations per environment while permitting independent environments
  to make progress; cap global expensive operations.
- Maintain last-known project snapshots through transient outages, label them
  stale, and never allow stale mutations.
- Validate paths on the execution host; never reinterpret Windows paths as Unix
  paths or vice versa in the client.
- Use least privilege, TLS/private tunnels, short-lived grants, rate limits,
  constant-time secret verification, credential hashing, redacted structured
  logs, and explicit administrative scopes.
- No unauthenticated endpoint may reveal project names, filesystem paths,
  providers, usernames, or service configuration beyond the minimal public
  environment descriptor needed for pairing.
- Service upgrades preserve store identity, run verified backups/migrations,
  and provide a tested rollback boundary.

## Research basis

Primary and vendor documentation consulted on 2026-08-24:

- [VS Code Remote Development over SSH](https://code.visualstudio.com/docs/remote/ssh)
  demonstrates keeping UI local while commands and extensions execute on the
  remote filesystem, and using SSH configuration as a connection profile.
- [VS Code Developing in WSL](https://code.visualstudio.com/docs/remote/wsl)
  treats a WSL distribution as a distinct execution context rather than
  translating its filesystem into a Windows-local project.
- [Microsoft WSL basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
  defines `wsl --list --verbose` and distro lifecycle controls.
- [Windows `sc.exe create`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/sc-create)
  documents native Windows service registration.
- [Apple launch daemon guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
  describes property-list based launchd jobs and daemon placement.
- [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628),
  [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252), and
  [RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449) inform expiring
  device grants, native-app authorization, and proof-of-possession credentials.
- [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html) informs
  replay resistance, throttling, and verifier treatment.
- [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html) and
  [CREATE TABLE](https://www.sqlite.org/lang_createtable.html) define the
  relational enforcement and migration constraints.
- [mDNS RFC 6762](https://www.rfc-editor.org/rfc/rfc6762.html) and
  [Tailscale MagicDNS](https://tailscale.com/kb/1081/magicdns) support treating
  discovery names as convenience routes, never environment identity.

The integrated web-search tool returned HTTP 401 in this environment. The same
research was completed by directly retrieving these official sources; no blog
or generated secondary source is used as an architectural authority.

## Questions requiring approval

Implementation must not begin until the product owner answers these deliberately
hard questions:

1. **First-release onboarding:** should signed service installers + one-time
   pairing be primary (recommended), SSH bootstrap be primary, or must both be
   release-blocking from day one?
2. **WSL cardinality:** should every installed distro be a node (recommended),
   only the default distro appear automatically, or should one WSL node contain
   a distro selector?
3. **Environment scope:** confirm that matching Git remotes never merge project
   identity across environments (recommended). Is explicit cross-environment
   linking needed now or deferred?
4. **Service exposure:** is loopback/private-network-only an acceptable secure
   default, or must the installer configure public TLS without Connect?
5. **Privilege model:** system service under a dedicated account (operationally
   robust) or per-user service under the interactive developer account (better
   access to existing Git/provider credentials)? Supporting both increases the
   test and support matrix substantially.
6. **Uninstall semantics:** confirm installers retain project data by default
   and expose purge only as a separate, high-friction administrative operation.
7. **Cached navigation:** may offline environments reveal cached project/thread
   titles on the local device, or is a lock/clear-on-disconnect policy required?
8. **Multiple access routes:** should v1 choose exactly one saved route per
   environment (recommended), or implement automatic direct/Connect/SSH
   failover immediately?
9. **WSL stopped state:** may selecting a stopped distro start it, or must the
   user explicitly press Connect first?
10. **Release matrix:** are Linux x64 DEB/RPM, Windows x64 MSI, and macOS
    arm64/x64 PKG sufficient for v1, and which signing/notarization credentials
    are available in CI?

## Acceptance criteria

- The tree cannot display a project outside the environment that supplied it.
- Identical `projectId` or `threadId` values from two environments never collide.
- Every project has exactly one main thread after migration and replay.
- Offline environments retain an explicitly stale read-only snapshot and do not
  redirect mutations to another environment.
- Each supported remote OS passes install, start, pair, connect, restart,
  upgrade, revoke, uninstall-retain, and clean-install smoke scenarios.
- Running/enabled WSL distributions are reconciled as platform environments
  without becoming user-persisted connection targets.
- Forget, unlink, uninstall, and purge have distinct tested effects.
- Pairing grants are single-use, expiring, rate-limited, replay-resistant, and
  absent from logs and WebSocket URLs.
- `vp check`, `vp run typecheck`, contract parity, Rust formatting/Clippy/tests,
  migration tests, CI contract tests, and platform runbooks pass before release.
