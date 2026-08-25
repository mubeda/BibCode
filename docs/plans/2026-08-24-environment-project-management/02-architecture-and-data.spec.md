# Architecture And Data Specification

## Chosen Architecture

Use federated environment ownership:

- Each server is authoritative for its environment identity, projects, threads,
  worktrees, processes, sessions, and server settings.
- The client is authoritative only for its catalog of known environments,
  routes, client-local presentation preferences, accepted identity bindings,
  secret references, and bounded offline cache.
- The desktop host is authoritative for privileged native operations through
  `DesktopBridge`, including desktop process launch, WSL enumeration/bootstrap,
  OS secret storage, and host-level installer/service operations.
- Shared contracts remain schemas and data types. Runtime policy remains in the
  package that owns it.

This extends current package boundaries rather than introducing a production
Node process, central sync daemon, or cloud control plane.

## Rejected Alternatives

### Central Client Mirror

Copying every remote project/thread/event into a single authoritative client
database simplifies global SQL queries but creates two sources of truth,
conflict resolution, replay/partial-sync hazards, and browser/desktop parity
problems. It also weakens the rule that an environment independently owns its
projects.

### Primary-Server Control Plane

Making the primary native server proxy all other environments centralizes
availability, credentials, and trust. A primary outage would make healthy
remote environments inaccessible, and a compromise would expose every route.
It is incompatible with direct independent clients and the privacy direction.

### Global Repository Projects

Keeping one global project and attaching environment instances would preserve
the current cross-environment repository grouping but contradicts the approved
ownership model. Remote URL equality is not runtime or filesystem equality.

## Dependency Direction

```text
packages/contracts (schemas only)
        ↑
packages/client-runtime (catalog, route selection, RPC, scoped cache)
        ↑                                      ↑
apps/web (tree/settings UX)      apps/desktop (DesktopBridge/host authority)
        ↘                                      ↙
                  apps/server (environment authority)
```

- `apps/web` must not reach directly into Tauri APIs; host work crosses typed
  `DesktopBridge` commands/events.
- Browser and desktop normal traffic uses typed HTTP/WebSocket RPC.
- `apps/server` does not import client persistence or presentation policy.
- `packages/contracts` contains no connection supervisor or migration logic.

## Identity Model

### Durable Environment Identity

Each data root owns one random UUID generated once and atomically persisted as
`environment-id`. It is returned in the unauthenticated minimal descriptor and
all authenticated session scopes. It is not accepted from CLI configuration,
host names, route configuration, WSL names, or clients.

Environment identity survives:

- Host, WSL distro, SSH alias, and client-alias renames.
- Port, URL, certificate, and route changes.
- Binary update/reinstall that preserves the data root.
- In-place backup restore of that environment.

A new/empty data root creates a new environment identity.

### Storage Instance Identity

The existing persistent store UUID becomes explicitly named
`storage-instance-id`. It identifies the accepted BiBCode store independently
from the environment. It remains part of storage backup/restore validation and
the connection acceptance record.

The current file named `environment-id` stores the storage UUID. Migration must
be atomic and crash recoverable:

1. Acquire the existing data-root initialization/maintenance lock.
2. Validate and read the legacy marker.
3. Publish the same value as `storage-instance-id` using the existing
   create-once/verify pattern.
4. Generate and publish a new durable `environment-id` only if absent.
5. Fsync files and containing directory according to the current persistence
   boundary.
6. Verify both markers before considering the migration complete.
7. Retain compatibility reading only inside the bounded migration path; normal
   runtime reads the new explicit files.

Backups, restore manifests, diagnostics, maintenance inspection, corruption
handling, and tests update together. A failed migration must not create a new
identity on each retry or point an existing database at a different storage ID.

### Routes And Discovery Bindings Are Not Identity

Examples of mutable locators:

- `primary` desktop slot.
- `wsl:<distribution-name>` discovery key.
- SSH config alias/user/host/port.
- HTTPS host/port/path.
- Local forwarded port.

The client can associate a locator with an environment only after a descriptor
proves the durable environment UUID. A route may join an existing environment
only when its reported storage UUID matches the accepted value. A mismatch
enters an explicit blocked state with Replace/Adopt/New Environment choices; it
never overwrites accepted identity automatically.

### Copied Data And Split Identity

Raw copying of a data root also copies its identities. BiBCode must not silently
treat two simultaneously divergent live copies as interchangeable routes. The
supported flows are:

- Move/restore the environment after the prior instance is offline, preserving
  identity and re-verifying a new route.
- Clone as a new environment through an explicit maintenance command that
  rotates environment and storage identities before the clone is admitted.

If two live endpoints report the same identities but incompatible store
generation/high-water state, supervisors block both as an identity conflict and
require administrative resolution. No last-writer-wins merge exists.

## Client Persistence Refactor

### Current Problem

`ConnectionCatalogDocument` schema version 1 combines:

- One target per environment.
- Connection profiles.
- Bearer credentials.
- Remote DPoP tokens.
- Accepted storage identities.

The web implementation persists that document plus shell/thread cache in
IndexedDB. This shape prevents multi-route environments and places secrets next
to ordinary metadata.

### Target Stores

Keep the persistence interface in `packages/client-runtime`; implement the web
storage driver in `apps/web`. Replace the monolithic one-target document with
versioned logical stores (separate IndexedDB object stores are preferred):

| Store                      | Key                                           | Non-secret contents                                                                                                                             |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `environments`             | `environmentId`                               | origin, canonical descriptor cache, local alias, accepted storage ID, hidden, created/last-seen timestamps                                      |
| `environmentRoutes`        | `routeId`                                     | environment ID, kind, endpoint/SSH locator, priority, explicit pin, autoconnect, TLS trust metadata, last verification/result, secret reference |
| `environmentBindings`      | `(provider, locator)`                         | platform discovery source such as primary or WSL distro and optional resolved environment ID                                                    |
| `environmentUiState`       | client singleton and environment/project keys | stable order, pin, collapse, last scoped selection, local aliases                                                                               |
| `environmentCacheManifest` | `environmentId`                               | cache schema/key reference, last sync, byte/age budget, LRU state                                                                               |
| `shellCache`               | `environmentId`                               | encrypted shell snapshot envelope                                                                                                               |
| `threadCache`              | `(environmentId, threadId)`                   | encrypted recent thread envelope                                                                                                                |
| `migrationState`           | migration ID                                  | idempotent migration receipt only; no secrets                                                                                                   |

IndexedDB does not enforce SQL foreign keys. The driver therefore performs
environment/route/binding changes in one transaction, validates referential
integrity during load, and deletes dependent route/cache/UI records explicitly.
The in-memory catalog never publishes a partially migrated or half-updated
environment.

### Multi-Route Domain Shape

Replace `Map<EnvironmentId, ConnectionTarget>` semantics with an environment
entry containing zero or more routes:

```text
KnownEnvironment
├── identity and accepted storage binding
├── cached descriptor and local presentation
├── discovery bindings[]
├── routes[]
└── live supervisor state
```

One supervisor coordinates route attempts for an environment. Individual route
attempts have their own cancellation/deadline state, but only one verified
session is active for ordinary RPC at a time. Stale results carry a generation
and cannot replace a newer selected route.

### Secret Separation

Remove credentials, refresh/access tokens, DPoP private keys, and cache keys
from the catalog document and loggable contract values.

- Desktop: store opaque values using a typed `DesktopBridge` secret-store API
  backed by user-scoped DPAPI, macOS Keychain, or Linux Secret Service. Persist
  only an opaque secret reference in IndexedDB.
- Same-origin browser session: keep server sessions in Secure, HttpOnly,
  SameSite cookies. Do not mirror them into IndexedDB.
- Other browser contexts: if an origin-bound non-exportable Web Crypto key and
  required secure persistence cannot be established, keep credentials/cache
  session-only and disclose that persistence is unavailable.

Loss/lock/unavailability of a secret provider produces Authentication required
or session-only cache. It never falls back to plaintext persistence.

### Catalog Migration

The migration from schema version 1 is one idempotent IndexedDB transaction per
phase:

1. Decode raw legacy data with a bounded migration-only schema.
2. Remove Connect/Relay targets and cloud tokens.
3. Create an environment record and one route for each remaining persisted
   target; preserve accepted storage identities and non-secret labels.
4. Reconcile platform-managed primary/WSL entries from the current desktop
   snapshot rather than treating stale platform targets as user records.
5. Import eligible secrets into the secure provider before deleting their old
   values. If secure import is unavailable, make them session-only and scrub the
   persistent value.
6. Encrypt or delete legacy plaintext cache according to key availability.
7. Commit new stores and a migration receipt atomically; only then remove the
   legacy document.

Corrupt entries are quarantined into redacted local diagnostics and skipped
without preventing the primary environment from opening. The UI reports that
connection metadata needs repair; raw secret material is never included in an
export.

## Server Persistence Refactor

The server database remains environment-local. Do not add `environment_id` to
`projection_projects`, `projection_threads`, messages, activities, approvals,
provider runtime, or worktree tables.

### Local Repository Identity

Duplicate prevention uses a server-derived identity for the verified Git common
directory/worktree family, including the existing safe path/object identity
rules. It must not use remote URL equality; independent clones remain valid.

Refactor the existing project worktree repository pin into an explicit
transactional project repository claim:

```sql
CREATE TABLE project_repository_claims (
  project_id TEXT PRIMARY KEY NOT NULL,
  repository_key TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL
);
```

The exact migration may retain an existing table name if doing so avoids a
risky rebuild, but the semantic owner becomes project uniqueness as well as
worktree discovery. Event append/projection and claim acquisition/release occur
inside the orchestration transaction and existing project/repository lock
order. A racing create either returns the committed existing project or retries
against the winning claim; it cannot surface two active projects.

Deletion/detach follows existing project/worktree guards. A project claim is
released only when authoritative project removal commits and no adopted
worktree owner remains. Replay/rebuild deterministically reconstructs claims
from verified project/repository identity facts.

### Permanent Main Invariant

The existing `projection_threads.kind` values already distinguish `default`,
`workspace`, and `panel`. Keep that contract and add database defense for one
active Main:

```sql
CREATE UNIQUE INDEX idx_projection_threads_one_active_default
ON projection_threads(project_id)
WHERE kind = 'default' AND deleted_at IS NULL;
```

Before creating the index, migration validates and repairs only states that can
be proven from canonical project/thread events; ambiguous duplicate defaults
fail migration with actionable diagnostics rather than deleting data.

Project creation remains a single orchestration command that persists project
and Main events atomically. Ordinary thread update/archive/delete validators
reject `kind = "default"`. Project selection consumes the canonical Main ID
returned by project creation/snapshot; the client does not manufacture a
fallback thread except during a bounded legacy data migration.

### Create Result

Project creation returns an idempotent disposition:

```text
created  { projectId, mainThreadId }
existing { projectId, mainThreadId, reason: same-local-repository }
```

The server ignores client-supplied repository keys, worktree paths, thread kind,
or Main ID. All are resolved/created inside the owning domain boundary.

## Cache And Scoped References

Every client cache key and route/navigation parameter includes environment ID:

- `(environmentId, projectId)`
- `(environmentId, threadId)`
- `(environmentId, worktreeKey/generation)`
- `(environmentId, terminalId)` where terminal identifiers are not already
  globally scoped by the session.

The existing scoped reference contracts are extended consistently rather than
creating string-concatenated IDs. A project/thread ID collision between two
servers is expected and safe.

Cached content uses authenticated encryption. The envelope contains schema
version, environment ID, storage ID, entity ID, server revision/high-water
mark, synchronized timestamp, nonce, and ciphertext. Associated data binds the
scope and version. A cache from an unexpected storage identity is quarantined
and never rendered under the environment.

Retention defaults are implementation-configurable but bounded by both bytes
and age. Eviction is LRU after protecting the current selection. Forget and
Force remove synchronously clear the environment cache before the catalog entry
disappears.

## State Ownership Summary

| State                                   | Owner                               | Offline editing                       |
| --------------------------------------- | ----------------------------------- | ------------------------------------- |
| Project/thread/worktree domain          | Environment server                  | No                                    |
| Environment UUID/storage UUID           | Environment data root               | No                                    |
| Server descriptor/capabilities          | Environment server                  | Cached read-only                      |
| Paired clients/provider/server settings | Environment server                  | Cached read-only                      |
| Service/bind/install/update settings    | Host OS via local control boundary  | Only when that boundary is reachable  |
| Alias/order/pin/hide/collapse/selection | Current client                      | Yes                                   |
| Routes and TLS pin metadata             | Current client                      | Yes; verification requires connection |
| Credentials/private/cache keys          | Platform secret provider            | No plaintext fallback                 |
| Offline content cache                   | Current client, derived from server | Read-only                             |

## Failure, Concurrency, And Recovery Requirements

- All discovery and connection work is generation-fenced; late attempts cannot
  replace a newer route or revive a forgotten environment.
- Per-environment route attempts are bounded, cancellable, and back off with
  jitter. A failing environment cannot starve healthy environments.
- Descriptor identity is verified before consuming a one-time credential.
- Consuming pairing is idempotent only through its server receipt; a successful
  response lost to transport can be recovered without issuing two clients.
- Duplicate project commands use command idempotency plus repository claims.
- Cache writes use per-environment revision checks; a stale reconnect cannot
  overwrite a newer cached snapshot.
- Forget/force-remove closes admission, cancels supervisors, waits for owned
  tasks, clears secrets/cache, then removes metadata. A concurrent reconnect
  cannot re-register the entry.
- Environment/storage mismatch, certificate mismatch, and divergent cloned
  identity fail closed.
- Server shutdown/update drains new admission, bounds existing work, publishes
  terminal outcomes where possible, and preserves current process-reaping
  guarantees.
- No path from UI directly performs privileged filesystem/process/network
  mutations without the server or `DesktopBridge` authority that owns it.

## Architecture Acceptance Criteria

- The same project/thread ID from two environments renders and operates
  independently in all caches, routes, drafts, tabs, and commands.
- Two routes proving one environment/storage identity create one tree node.
- Identity/storage/certificate mismatch never mutates the accepted binding.
- Concurrent duplicate project creates result in exactly one project/Main.
- Separate clones of one remote produce separate projects.
- Exactly one active Main exists per project after migration and replay.
- No server project/thread table gains a redundant environment column.
- No persistent client store contains bearer credentials, refresh tokens, DPoP
  private keys, or cache encryption keys in plaintext.
- Existing worktree behavioral tests continue to pass without routing raw paths
  through new generic APIs.
- Catalog migration is crash-idempotent and can always open the primary
  environment even when an unrelated remote entry is corrupt.
