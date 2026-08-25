# Environment-Owned Project Management

**Status:** Product, architecture, mockups, specifications, and implementation
plan approved on 2026-08-24. Implementation is in progress on the numbered
plans; their checked steps and progress notes record landed behavior.

## Goal

Make an execution environment the explicit owner of its projects and workspace
threads:

```text
Environment
└── Project
    ├── Main
    ├── Ordinary workspace thread
    └── Worktree-backed workspace thread
```

The same repository in two environments is two different projects. A project
never floats between environments, and a client never merges projects from
different environments merely because their Git remotes match.

This design also makes Linux, Windows, macOS, and WSL environments first-class,
adds server-only installers and secure enrollment, removes BiBCode Connect, and
keeps the current server-authoritative worktree lifecycle intact.

## Documents

- [Decision log](./decision-log.md)
- [Product and UX specification](./01-product-and-ux.spec.md)
- [Architecture and data specification](./02-architecture-and-data.spec.md)
- [Connection, security, and lifecycle specification](./03-connection-security-and-lifecycle.spec.md)
- [BiBCode Connect removal specification](./04-bibcode-connect-removal.spec.md)
- [Distribution, documentation, and verification specification](./05-distribution-docs-and-verification.spec.md)
- [Approved left-panel mockups](./left-panel-mockups.md)
- [External research](./research.md)
- [Master implementation plan and dependency map](./implementation-plan.md)
- [10 — Environment identity and project invariants](./10-environment-identity-and-project-invariants.plan.md)
- [20 — Catalog, routes, secrets, and cache](./20-catalog-routes-secrets-cache.plan.md)
- [30 — Control, pairing, transport, and services](./30-server-control-pairing-transport-service.plan.md)
- [40 — WSL and SSH provisioning](./40-wsl-ssh-provisioning.plan.md)
- [50 — Environment navigation and center settings](./50-environment-navigation-and-settings.plan.md)
- [60 — Complete BiBCode Connect removal](./60-bibcode-connect-removal.plan.md)
- [70 — Server distribution, CI, documentation, and verification](./70-server-distribution-ci-docs.plan.md)

Implementation follows the numbered plans in dependency order. Each task uses
test-first steps, names its source/doc owners, and includes verification and a
small commit boundary. Unchecked steps remain required unless an adjacent
progress note explicitly records a dependency-gated deferral.

## Current Repository Baseline

The design starts from these verified facts rather than treating earlier plans
as current behavior:

- One running BiBCode server already represents one execution environment.
- `apps/server` owns projects, threads, worktrees, Git, providers, terminals,
  persistence, authentication, and process supervision.
- `packages/client-runtime` already scopes project and thread references by
  environment and owns the connection registry and environment caches.
- The current connection catalog stores one target per environment in a
  versioned IndexedDB document. It must be separated into environment and route
  records to support several routes for one environment.
- The current document stores bearer credentials beside non-secret metadata.
  That must end; credentials and cache keys move behind platform secret-store
  interfaces.
- `apps/web` currently groups sidebar projects across environments by repository
  identity. That grouping conflicts with environment ownership and must be
  removed.
- Desktop presentation currently hides most remote-environment controls even
  though primary, bearer, SSH, unavailable, and BiBCode Connect relay targets
  exist underneath.
- The server database is already local to one environment. Adding an
  `environment_id` column to every project/thread table would duplicate the
  database boundary.
- Project creation already creates one canonical `kind = "default"` thread, and
  the existing UI treats it as the undeletable primary row.
- Worktree discovery, adoption, managed creation, retargeting, detach, and
  removal are already server-authoritative and have dedicated RPC boundaries.
- Windows desktop WSL support currently presents at most one selected secondary
  distribution; the bridge does not preserve the running/stopped state returned
  by `wsl.exe --list --verbose`.
- The SSH bootstrap path expects an installed binary and invokes a pairing CLI
  surface that is not yet implemented end to end.
- The release workflow currently builds desktop artifacts, not independently
  installable server packages.
- macOS desktop builds currently use Tauri's ad-hoc signing identity (`-`) and
  validate that baseline in CI. Developer ID signing and notarization are not a
  prerequisite for this design.

## Terminology

### Environment

One independently running BiBCode server and its data root. It has a durable,
server-generated environment UUID. Host names, WSL distribution names, SSH
aliases, URLs, and client display aliases are locators or presentation data,
not identity.

### Storage instance

The persistent identity of the environment's current BiBCode data store. It is
separate from the environment UUID so clients can distinguish a familiar
environment from an unexpected replacement or reset store.

### Project

An environment-local repository/workspace-root aggregate. Two separate clones
of the same remote are allowed. The same verified local Git common-directory
family cannot be represented by two active projects in one environment.

### Main

The single permanent `kind = "default"` workspace thread created atomically
with a project. Its UI label and role are stable. It cannot be archived,
renamed away from Main, or deleted independently; removing it means removing
the project through the existing guarded project lifecycle.

### Workspace thread

A left-panel conversation/execution owner. It may run in the project's primary
checkout or a server-owned Git worktree.

### Panel thread

A sibling provider session shown as a center-workspace tab. Panel threads remain
out of the left panel.

### Route

One verified way for a client to reach an environment. An environment can have
several ordered routes, but every route must prove the same environment and
accepted storage identities before it can join that environment record.

## In Scope

- Environment-owned left-panel hierarchy and center-workspace settings.
- Multi-route environment catalog, durable identity, encrypted offline cache,
  stable selection, status, search, hiding, forgetting, and destructive flows.
- Native primary, WSL, SSH-tunneled, and direct HTTPS/WSS routes.
- Linux, Windows, and macOS server installation, services, enrollment, updates,
  uninstall, and purge.
- Full removal of the BiBCode Connect cloud-relay product surface.
- Server-only release artifacts and CI validation.
- Living installation, usage, administration, architecture, testing, privacy,
  troubleshooting, and release documentation updated with implementation.

## Explicit Non-Goals

- Permission tiers or read-only client roles. Every paired client is initially
  a full environment administrator.
- A hosted control plane, cloud relay, telemetry, analytics, automated crash
  upload, or usage reporting.
- Non-loopback plaintext HTTP.
- Automatically starting stopped WSL distributions.
- Exposing `wsl --unregister`.
- Treating Git worktrees as projects or weakening current worktree authority.
- Synchronizing source code into a global client database.
- Moving panel tabs or informational/settings panels into the left panel.
- Replacing the current release toolchain wholesale without evidence that the
  existing workflows cannot be extended safely.

## Architectural Outcome

The approved approach is federated environment ownership:

```text
BiBCode client
├── local environment catalog and UI preferences
├── secure credential references and encrypted bounded cache
└── verified route supervisors
    ├── Environment A server → its projects, threads, worktrees, processes
    ├── Environment B server → its projects, threads, worktrees, processes
    └── Environment C server → its projects, threads, worktrees, processes
```

The client federates navigation and cached presentation. It does not become an
authoritative replica of remote domain state. Each server remains independently
usable and owns all mutations within its environment.
