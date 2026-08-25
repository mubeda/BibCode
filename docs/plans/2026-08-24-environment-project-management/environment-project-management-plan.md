# Environment and project management implementation plan

**Status:** Proposed; blocked on the product decisions in the companion specification
**Specification:** [Environment and project management specification](./environment-project-management-spec.md)
**Date:** 2026-08-24

## Delivery strategy

Deliver this as independently reversible vertical slices. Do not begin service
installer implementation until identity, pairing, and privilege decisions are
approved. Do not replace the current project-first sidebar until compound keys,
environment partitions, and stale-state tests are in place.

Every phase updates the relevant living architecture/user/operations documents
and affected `docs/testing/` runbooks in the same change. Every protocol phase
regenerates and verifies TypeScript/Rust fixtures.

## Phase 0 — approve decisions and baseline behavior

**Owners:** product/design, architecture, release engineering

1. Answer all questions in the specification and record accepted alternatives
   and trade-offs in an approved design document.
2. Capture current fixtures for:
   - two environments with colliding project/thread IDs;
   - offline cached environment snapshots;
   - current WSL primary/parallel/disabled modes;
   - bearer, Connect, and SSH catalog entries; and
   - environment removal while connection preparation is active.
3. Measure sidebar render/subscription behavior at 10 environments × 100
   projects × 20 visible threads, and set explicit memory, initial-sync, and
   reconnect-concurrency budgets.
4. Inventory signing/notarization secrets and supported CI runners. Decide
   whether Linux packages are built in containers or native jobs.

**Exit gate:** approved design, fixed release matrix, threat model, performance
budgets, and reproducible baseline report.

## Phase 1 — make environment scoping mechanically safe

**Owners:** `packages/contracts`, `packages/client-runtime`, `apps/web`

1. Define opaque compound navigation keys for environment/project and
   environment/thread. Audit routes, React keys, caches, layouts, selections,
   optimistic mutations, command lanes, prewarm state, terminal transcripts,
   preview sessions, and activity state for naked project/thread IDs.
2. Add collision tests everywhere aggregate snapshots are merged.
3. Partition persisted client projections by environment and store snapshot
   generation, server descriptor, observed time, and stale reason.
4. Fence all subscription publications by supervisor generation and accepted
   storage identity.
5. Introduce a flattened environment-tree view model without changing the
   rendered sidebar yet. Test ordering, collapsing, stale rows, actions, focus,
   keyboard traversal, and virtualization inputs.

**Failure tests:** late event after disconnect; old session after immediate
reconnect; storage identity change; one corrupt environment partition; duplicate
delivery; one slow environment while another synchronizes.

**Exit gate:** collision fixtures pass and no multi-environment runtime key uses
a naked project/thread ID.

## Phase 2 — enforce the server-local relational model

**Owners:** `apps/server`, `packages/contracts`

1. Add a preflight migration that identifies the canonical main thread per live
   project and aborts with actionable recovery diagnostics on ambiguity.
2. Add `projection_threads.role`, the project foreign key, and the partial unique
   live-main index. Rebuild SQLite tables where ALTER cannot enforce constraints.
3. Make project + main-thread creation one transaction/event-command outcome.
4. Make main-thread deletion impossible and project deletion an idempotent,
   previewed lifecycle command.
5. Verify projection rewind/replay, backup/restore, old unmarked-store adoption,
   and worktree/panel-thread compatibility.

**Focused validation:** migration fixtures for empty, ordinary, deleted,
ambiguous, and large stores; concurrent create/delete; crash between event and
projection; foreign-key check; replay determinism.

**Exit gate:** every live project has exactly one live main thread at database
and command boundaries.

## Phase 3 — expose environment-first navigation

**Owners:** `apps/web`, `packages/client-runtime`

1. Render environment nodes above projects using the phase-1 view model.
2. Add environment landing/empty/offline/blocked states and environment-scoped
   Add Project behavior.
3. Move connection status and recovery affordances from global/sidebar banners
   to the relevant environment row without hiding global catastrophic catalog
   errors.
4. Add environment context menus and settings routes; capability-filter every
   action by ownership and live descriptor.
5. Persist environment/project expansion, label/color/order, and hidden platform
   preferences through atomic catalog transitions.
6. Acquire lightweight project shells for desired environments and detail only
   for visible/expanded rows. Add flattened-tree virtualization if measurements
   cross the approved threshold.

**UX validation:** keyboard-only tree operation, screen-reader semantics,
offline cached state, 200% zoom, narrow panel, long host/project names, high row
counts, simultaneous status badges, and no accidental environment switch.

**Exit gate:** the panel always renders Environment → Project → Main/Threads and
all project creation/navigation stays on the selected execution host.

## Phase 4 — replace selected WSL backend with reconciled topology

**Owners:** `apps/desktop`, `packages/contracts`, `packages/client-runtime`,
`apps/web`

1. Add a bridge contract returning bounded WSL topology records with stable
   identity, display name, state, version, default flag, capability, and last
   probe error.
2. Refactor desktop backend management from one configured distro to an owner
   per desired distro, each with exact launch plan, process owner, bootstrap
   credential, and shutdown/reaper lifecycle.
3. Reconcile installed/running distributions into platform registrations.
   Persist only hide/auto-connect preference, never the platform target.
4. Preserve the last good topology on probe failure; debounce OS changes and cap
   launches/synchronization.
5. Migrate existing selected-distro settings to the matching topology
   preference and retain compatibility only for the migration window.
6. Remove `wslOnly` UI behavior only after an approved replacement handles a
   Windows host with zero, one, or several WSL environments.

**Focused validation:** missing `wsl.exe`; disabled feature; no distro; stopped,
running, renamed, removed, and default-changed distro; malformed/oversized or
timed-out output; parallel launch; desktop shutdown; storage identity change;
platform hide versus OS removal.

**Native evidence:** update Windows runbooks and capture packaged screenshots of
zero/one/multiple distro navigation.

**Exit gate:** enabled/running WSL is always presented according to approved
cardinality and never persisted as a user target.

## Phase 5 — environment settings and administrative capability

**Owners:** `apps/server`, `packages/contracts`, `packages/client-runtime`,
`apps/web`

1. Extend the environment descriptor additively with host facts and explicit
   read/admin capability bits.
2. Add revisioned server settings storage and typed get/patch RPC with compare-
   revision conflict handling, validation, redaction, authorization, and audit.
3. Implement client-owned display/access settings separately in the connection
   catalog.
4. Build environment settings sections that clearly label Client, Server, and
   Service ownership. Disabled controls explain missing capability rather than
   silently falling back.
5. Add authenticated diagnostics and version/update status without exposing
   sensitive paths through the public descriptor.

**Failure tests:** old server fields absent; stale revision; partial invalid
patch; unauthorized admin; reconnect during update; secret redaction; settings
write succeeds but response is lost.

**Exit gate:** every displayed setting has one source of truth and a tested
owner/authorization boundary.

## Phase 6 — secure one-time pairing and repair SSH bootstrap

**Owners:** `apps/server`, `packages/contracts`, `packages/client-runtime`,
`apps/desktop`, `apps/web`, `infra/relay`

1. Write and review a pairing threat model: local attacker, LAN attacker,
   malicious relay, leaked code, replay, brute force, clock skew, process-list
   disclosure, logs, and confused environment/store identity.
2. Add SQLite repositories for hashed pairing grants, device credentials,
   scopes, revocation, and bounded audit history.
3. Add CLI create/status/revoke commands and typed HTTP redeem endpoints.
4. Reuse existing bounded token exchange and WebSocket ticket plumbing; bind
   device credentials with DPoP if approved.
5. Add rate limiting, single-use atomic consume, expiry, polling backoff,
   constant-time comparison, redacted logs, and cleanup.
6. Replace the desktop SSH launcher's removed pairing command with the new
   machine-readable grant flow. Verify remote binary version/hash and launch
   loopback-only behind exact forwarding.
7. Build UI confirmation that displays verified descriptor, route, TLS state,
   and storage identity before trust is persisted.

**Security validation:** grant replay, concurrent redemption, expiry boundary,
attempt exhaustion, DPoP mismatch, TLS downgrade, descriptor swap, SSH
cancellation/reaping, secret scans of logs/process args/files, revoke during a
live session, and clock skew.

**Exit gate:** fresh SSH and manual service pairing work without reusable
bootstrap secrets or WebSocket URL credentials.

## Phase 7 — headless installers and service lifecycle

**Owners:** release engineering, `apps/server`, scripts, `.github/workflows`

1. Add reproducible server artifact scripts that consume Cargo artifact JSON,
   select the exact `bibcode` binary, stage licenses/config/service definitions,
   compute checksums, and reject unexpected files.
2. Package:
   - Windows x64 MSI + Windows Service definition;
   - macOS arm64/x64 signed and notarized PKG + LaunchDaemon plist;
   - Linux x64 DEB/RPM + hardened systemd unit; and
   - portable archives as optional expert artifacts.
3. Make account, data directory, loopback/private bind, firewall, TLS, service
   recovery, upgrade, uninstall-retain, and explicit purge behavior match the
   approved privilege model.
4. Add a CI matrix distinct from desktop artifacts, signed manifest/provenance,
   release asset naming, collision checks, and release workflow contract tests.
5. Add clean VM/container smoke jobs for install, start, health, create grant,
   pair, project persistence across restart/upgrade, revoke, uninstall retaining
   data, reinstall adoption, and explicit purge.
6. Update release documentation, support diagnostics, and native OS testing
   runbooks. Never place machine paths, exact timings, or execution SHAs in
   living runbooks.

**Exit gate:** signed release artifacts and service lifecycle smoke pass on the
supported matrix; the desktop can connect to each through the same connection
runtime.

## Phase 8 — removal semantics and recovery

**Owners:** all runtime packages

1. Implement distinct Disconnect, Hide, Forget, Unlink, Revoke, Remove Project,
   Uninstall, and Purge commands with exact confirmation copy.
2. Refactor environment removal into a resumable client transaction: retire
   supervisor generation; stop/await owned work; remove credential; remove
   saved target/trust/presentation; delete environment cache partition; publish
   completion. Persist recovery-required state if a durable step fails.
3. Ensure Connect unlink and device revocation are independent and idempotent.
4. Add project-removal preview listing sessions/worktrees/server state affected;
   repository files remain by default.
5. Test concurrent platform reconciliation, active turns/terminals, reconnect,
   lost responses, client crash between steps, another tab mutating the catalog,
   and server offline during local forget.

**Exit gate:** no action has surprising cross-boundary deletion and every
partial failure has a visible recovery path.

## Phase 9 — broad validation and rollout

1. Run focused suites after each behavior change, then:
   - `vp check`
   - `vp run typecheck`
   - `vp run check:contracts`
   - relevant `vp test ...` projects and `vp run test`
   - `cargo fmt --all --check`
   - affected Rust tests
   - affected-target Clippy with warnings denied
   - CI workflow contract tests
   - packaged desktop and headless installer smoke on every supported OS.
2. Add telemetry/diagnostics for connection stage, route kind, stale snapshot
   age, reconnect attempts, WSL topology/launch outcome, pairing error category,
   and service version—never environment names, paths, or secrets by default.
3. Roll out contracts additively first, environment tree behind a development
   flag second, WSL topology third, pairing/SSH fourth, and installers last.
4. Define rollback as UI flag rollback plus server binary rollback only when the
   migrated database remains forward/backward compatible; otherwise use the
   verified pre-migration backup procedure.
5. Remove compatibility fields and the old project-first presentation only
   after one stable release and migration telemetry review.

## Required documentation changes during implementation

- `docs/architecture/overview.md`
- `docs/architecture/remote.md`
- `docs/architecture/connection-runtime.md`
- `docs/architecture/runtime-modes.md`
- `docs/user/workspace-ui.md`
- `docs/user/remote-access.md`
- cloud authentication docs if pairing/Connect contracts intersect
- `docs/operations/ci.md` and `docs/operations/release.md`
- Windows, Linux, macOS, remote-access, persistence/recovery, and packaged UI
  runbooks under `docs/testing/`
- package READMEs/manifests and CLI help

## Definition of done

- Approved decisions are reflected in living architecture documents.
- Source, schemas, fixtures, migrations, and UI use the same hierarchy and
  terminology.
- Focused and broad validation commands pass with platform evidence attached to
  execution reports.
- Server-only installers are signed, reproducible, smoke-tested, and published
  without a Node runtime.
- WSL behavior meets the approved discovery cardinality and lifecycle contract.
- Removal/recovery and service upgrade/uninstall behavior are tested under
  interruption and restart.
- Final diff/status review contains no `.codegraph/`, `.repos/`, generated debug
  output, unintended dependency drift, or unrelated user changes.
