# External Worktree Discovery and Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover Git worktrees created outside BiBCode, let the user adopt them as ordinary workspace threads, preserve adopted rows as actionable warnings when their directories disappear, and require an explicit detach-only versus destructive-removal choice.

**Architecture:** Implement the approved server-owned Worktree Catalog described in [`docs/superpowers/specs/2026-08-09-external-worktree-discovery-and-adoption-design.md`](../specs/2026-08-09-external-worktree-discovery-and-adoption-design.md). Git and filesystem probes remain live truth; orchestration threads remain durable adoption truth; project metadata persists discovery policy plus a nullable repository-identity trust pin used only for fencing anchors. The catalog publishes server-resolved worktree descriptors and adopted-workspace availability so clients never normalize or compare host paths. Dedicated application RPCs validate opaque keys and generations, serialize adoption/removal per physical repository, and reuse the existing thread, provider, terminal, workspace, and Git boundaries.

**Tech Stack:** Rust, Tokio, Axum WebSocket RPC, SQLite/rusqlite, Effect Schema, TypeScript, Effect Atom/Stream, React, Vite+, Tauri 2, Git CLI.

## Final Reviewer-Safe Authority Amendment (2026-08-11)

This approved amendment supersedes any earlier task wording that exposed raw
worktree path/kind/policy/delete authority:

- Dedicated server-resolved RPCs are exclusive for discovery policy, managed
  creation (`worktree.createManaged`), host-derived panel creation
  (`worktree.createPanel`), opaque catalog retargeting (`worktree.retarget`),
  adoption, removal planning, detach, and destructive removal.
- Generic HTTP/WebSocket orchestration rejects client discovery policy,
  worktree kind/path/bootstrap cwd or path, metadata path retargeting,
  adopted-owner deletion, and project deletion while adopted owners remain.
  Ordinary non-worktree commands remain supported with permitted context
  derived by the server.
- Public raw-path `vcs.removeWorktree` and `vcs.createWorktree` are retired from
  contracts, registries, scopes, desktop bridges, and handlers. A private
  rollback owns the exact just-created registered nonprimary checkout and the
  actual newly created branch returned by Git, including automatic suffixes.
  Pull-request worktree mode resolves its branch and uses
  `worktree.createManaged`; legacy PR preparation is local-checkout-only.
- One physical identity governs present canonical paths and missing paths via
  their canonical nearest existing ancestor plus normalized suffix. It is used
  across catalog joins, owner uniqueness, availability, mutation locks,
  removal, and cross-project cleanup. Windows drive/UNC comparison uses native
  invariant uppercase mapping compatible with Windows ordinal caseless
  identity, including non-ASCII special folds.
- Worktree mutations are runtime-owned. Cancellation may win before
  engine-envelope handoff; after handoff, the command claim, locks, removal
  reservation/slot, guard, quiesce, and rollback ownership remain until a
  durable terminal result. One named non-waiting global semaphore admits at
  most 64 operation lifetimes, returns structured saturation/shutdown errors,
  and creates no waiter queue. Runtime shutdown closes admission and drains
  these operations first.
- Every filesystem read/search/browse/asset/review/mutation RPC retains a
  physical-path admission lease for the complete operation; mutations cross a
  finalization fence before their filesystem or durable commit.
- Removal planning and execution use and revalidate the catalog's pinned
  trusted anchor, allowing a same-repository adopted sibling or lifetime common
  directory when the primary is absent without transferring trust.
- Catalog subscriptions and scoped unary consumers share active-user lifetime;
  the final release schedules pointer-checked 60-second eviction.
- A false/missing `worktreeCatalog` capability makes no new-method call. The
  only legacy fallback is confirmed detach-only ordinary thread deletion,
  leaving Git/files untouched. One shared selector keeps cold, `present`, and
  retained `verification-unavailable` usable and disables only authoritative
  missing/removing states.

## Global Constraints

- Preserve the package ownership and trust boundaries in `AGENTS.md`; do not put Git or filesystem authority in `apps/web` or `apps/desktop`.
- Do not edit `.repos/` or `.codegraph/`, add a production Node runtime, or add a native helper sidecar.
- Use test-driven development for every behavior: add the focused failing test, run it and record the expected failure, implement the smallest behavior, then rerun the focused test.
- Treat the approved design as binding. If implementation evidence requires changing a source of truth, persisted shape, deletion guarantee, or trust boundary, update the design and obtain approval before continuing.
- Never accept a destructive filesystem path from the client. Mutation inputs contain `projectId`, `threadId` or opaque `worktreeKey`, an expected catalog generation, and confirmation fields; the server re-resolves the path.
- Never accept worktree policy, lifecycle kind, owner path, bootstrap root,
  retarget path, or adopted-owner deletion through generic orchestration.
- Use the same physical path key for all owner, catalog, availability, and
  removal decisions; fail closed rather than falling back to lexical identity.
- Pass Git paths after `--` through `ProcessRunner`; never interpolate a path into a shell command and never edit Git administrative directories directly.
- Preserve primary and bare worktrees, locked registrations, local branches, and unregistered replacement directories.
- A degraded scan retains the last authoritative descriptor and availability set. Only an authoritative Git-list absence may create `missing-unregistered`, and only a `NotFound` probe of a still-registered path may create `missing-registered`.
- Use these initial bounds and keep them named in one Rust options struct: 512 worktree records, 512 baseline paths, four concurrent repository scans, eight concurrent path probes, a one-second probe timeout, a two-second shallow poll interval, a one-second result TTL, a 60-second idle-entry TTL, and exponential failed-scan retry capped at 30 seconds.
- Use `tokio::sync::watch` for latest-value catalog publication and per-repository single-flight refresh. Do not queue an unbounded history of snapshots.
- Keep every project's joined snapshot, `watch` stream, subscribers, suppression state, and mutation epoch isolated even when multiple projects share one canonical repository observation.
- Persist the nullable repository trust pin only after an authoritative primary-checkout scan. Every fallback anchor must match it; never infer or replace repository identity from directory existence or a fallback scan.
- Subscriber and unary active-user reservation plus idle eviction must be atomic and cancellation-safe. Final active-user release cancels owned work as appropriate and schedules pointer-checked eviction after 60 seconds without later publication from the old lifecycle.
- Use a per-physical-project mutation lock for policy changes, adoption, and removal. Bulk adoption runs at concurrency four within one execution environment and never crosses environment boundaries in one server operation.
- A BiBCode-created worktree may be suppressed from discovery for at most 30 seconds while its normal thread is created. If thread creation fails, the worktree becomes a candidate after that bounded grace period.
- Adoption must not run `git worktree add`, switch branches, or invoke `runOnWorktreeCreate` scripts.
- Detach-only removal must commit even if runtime teardown reports a failure. Missing-registration cleanup must also detach and return a partial outcome when optional Git cleanup fails. Present destructive deletion keeps the thread when Git removal cannot be verified.
- Every task ends with a scoped commit. Do not stage unrelated user changes.

---

### Task 1: Add the schema-only worktree catalog domain

**Files:**
- Create: `packages/contracts/src/worktree.ts`
- Create: `packages/contracts/src/worktree.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/orchestration.test.ts`

**Interfaces:**
- Consumes: Existing `ProjectId`, `ThreadId`, `CommandId`, `ModelSelection`, `RuntimeMode`, `ProviderInteractionMode`, `IsoDateTime`, and schema defaults.
- Produces: Catalog, project-policy, adopted-workspace, adoption, removal-plan, removal-result, and structured-error schemas. This task does not register RPC methods.

The contract names and discriminants are fixed as follows:

```ts
export const WorktreeKey = TrimmedNonEmptyString.pipe(Schema.brand("WorktreeKey"));
export const WorktreeRepositoryKey = TrimmedNonEmptyString.pipe(
  Schema.brand("WorktreeRepositoryKey"),
);
export const WorktreeDiscoveryVisibility = Schema.Literals(["hidden", "shown"]);
export const ProjectWorktreeDiscoveryPolicy = Schema.Struct({
  visibility: WorktreeDiscoveryVisibility.pipe(
    Schema.withDecodingDefault(Effect.succeed("hidden" as const)),
  ),
  initialPromptDismissedAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  baselinePaths: Schema.Array(TrimmedNonEmptyString)
    .check(Schema.isMaxLength(512))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export const VcsWorktreeRegistrationState = Schema.Literals(["registered", "prunable"]);
export const VcsWorktreeDirectoryState = Schema.Literals(["present", "missing", "unknown"]);
export const AdoptedWorktreeAvailability = Schema.Literals([
  "present",
  "verification-unavailable",
  "missing-registered",
  "missing-unregistered",
  "removing",
]);
export const VcsWorktreeAdoptionState = Schema.Literals(["none", "active", "archived"]);
```

`VcsWorktreeDescriptor` contains `worktreeKey`, normalized `path`, nullable `branch`, nullable `head`, `isPrimary`, `isBare`, `locked`, optional `lockReason`, `registrationState`, `directoryState`, `adoptionState`, optional `adoptedThreadId`, and `eligibleForAdoption`. `VcsAdoptedWorktreeStatus` contains `threadId`, nullable `worktreeKey`, normalized `path`, nullable `branch`, `availability`, nullable `registrationState`, `locked`, and optional `lockReason`. The server supplies both values; clients do not compare paths to derive adoption.

`VcsWorktreeCatalogSnapshot` contains `repositoryKey`, `generation`, `authoritative`, `observedAt`, a tagged `scanStatus` (`ready`, `refreshing`, or `degraded`), at most 512 `worktrees`, and at most 512 `adoptedWorkspaces`. Degraded status carries one of `anchor-unavailable`, `git-unavailable`, `git-failed`, `timed-out`, `malformed-output`, or `output-limit`, plus `message`, `failedAt`, and nullable `lastAuthoritativeAt`.

Define these mutation/result schemas in the same module for later RPC tasks:

```ts
WorktreeAdoptionDisposition = "created" | "existing" | "restored"
WorktreeRemovalMode = "delete-git-worktree" | "cleanup-stale-registration"
WorktreeGitOutcome = "not-requested" | "removed" | "cleaned" | "failed"
WorktreeRemovalAvailability =
  | "present"
  | "verification-unavailable"
  | "missing-registered"
  | "missing-unregistered"
```

`WorktreeRemovalPlan` contains an opaque `planToken`, `generation`, `availability`, `registered`, `locked`, optional `lockReason`, counts for tracked changes and untracked files, and a bounded `pruneImpact` list of `{ path, locked, lockReason? }`. `WorktreeRemovalResult` contains `threadRemoved`, `gitOutcome`, optional `detail`, and `orphanCleanupPending`.

Define tagged errors `WorktreeCatalogError`, `WorktreeAdoptionError`,
`WorktreeRemovalError`, `WorktreeOperationError`, `WorkspaceUnavailableError`,
and `WorkspaceIdentityError`. Each carries a bounded message and literal reason;
adoption/removal errors optionally carry `currentGeneration`.
`WorkspaceUnavailableError` carries `threadId`, `path`, and `availability`;
`WorkspaceIdentityError` aborts authority changes when physical identity cannot
be verified.

- [ ] **Step 1: Write failing schema tests**

Cover:

- legacy projects decode missing `worktreeDiscovery` to hidden/null/empty;
- all descriptor states and a degraded retained snapshot round-trip;
- active and archived adopted-workspace joins round-trip;
- arrays over 512 entries fail;
- every error and removal result round-trips;
- nullable branch, HEAD, registration, and lock-reason fields remain distinguishable.

Run:

```sh
vp test run packages/contracts/src/worktree.test.ts packages/contracts/src/orchestration.test.ts
```

Expected before implementation: imports and project fields are missing.

- [ ] **Step 2: Implement `worktree.ts` and add the optional project policy**

Add `worktreeDiscovery: ProjectWorktreeDiscoveryPolicy` with a decoding default to `OrchestrationProject`, `OrchestrationProjectShell`, and `ProjectCreatedPayload`. Add optional `worktreeDiscovery` to `ProjectMetaUpdatedPayload` and `ProjectMetaUpdateCommand`; the incremental payload must have no decoding default so omission remains distinguishable from an explicit policy update. Export `worktree.ts` from the package index.

- [ ] **Step 3: Run the focused contract tests**

```sh
vp test run packages/contracts/src/worktree.test.ts packages/contracts/src/orchestration.test.ts
```

Expected: both files pass without registering new wire methods.

- [ ] **Step 4: Commit the schema domain**

```sh
git add packages/contracts/src/worktree.ts packages/contracts/src/worktree.test.ts packages/contracts/src/index.ts packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts
git commit -m "feat(contracts): define worktree catalog domain"
```

### Task 2: Persist discovery policy through orchestration

**Files:**
- Modify: `apps/server/src/persistence/migrations.rs`
- Modify: `apps/server/src/persistence/repositories.rs`
- Modify: `apps/server/src/orchestration/engine.rs`
- Modify: `apps/server/src/production/orchestration_rpc.rs`
- Modify: `apps/server/tests/repositories.rs`
- Modify: `apps/server/tests/orchestration.rs`
- Modify: `apps/server/tests/persistence_compat.rs`
- Modify: `packages/client-runtime/src/state/shellReducer.ts`
- Modify: `packages/client-runtime/src/state/shellReducer.test.ts`

**Interfaces:**
- Consumes: `project.meta.update` and project projection/event replay.
- Produces: A durable, backward-compatible `worktree_discovery_json` project projection field and shell snapshots containing `worktreeDiscovery`.

The migration is ID 40, named `ProjectionProjectWorktreeDiscovery`, and adds:

```sql
ALTER TABLE projection_projects
ADD COLUMN worktree_discovery_json TEXT NOT NULL
DEFAULT '{"visibility":"hidden","initialPromptDismissedAt":null,"baselinePaths":[]}';
```

`ProjectionProject` gains `worktree_discovery: Value`. Every project select, insert, upsert, decoder, snapshot serializer, projector, and fixture must preserve that JSON value. `project.created` writes the default object. `project.meta-updated` changes it only when the event contains `worktreeDiscovery`.

For incremental `ProjectMetaUpdatedPayload` events, preserve omitted-versus-present semantics: `worktreeDiscovery` is optional and has no decoding default. Only complete project/shell representations and `ProjectCreatedPayload` decode missing policy fields to the hidden/null/empty default.

- [ ] **Step 1: Add failing migration and repository tests**

Prove a database at migration 39 upgrades to 40 with the default, a custom policy survives repository round-trip, and a malformed policy remains a contract decode error instead of being silently replaced.

Run:

```sh
cargo test -p bibcode-server persistence::migrations::tests -- --nocapture
cargo test -p bibcode-server --test repositories project -- --nocapture
cargo test -p bibcode-server --test persistence_compat -- --nocapture
```

Expected before implementation: migration 40 and the projection column are absent.

- [ ] **Step 2: Implement migration and repository persistence**

Update all `ProjectionProject` construction sites, including production tests. Keep the default in SQL and Rust identical to the contract default.

- [ ] **Step 3: Add failing engine and shell-reducer tests**

Prove:

- `project.create` emits the default policy;
- `project.meta.update` emits and projects a supplied policy in the same command transaction;
- an unrelated project metadata update leaves policy unchanged;
- shell replay and live `project.meta-updated` events update the client project entity.

Run:

```sh
cargo test -p bibcode-server orchestration::engine::tests::project -- --nocapture
vp test run packages/client-runtime/src/state/shellReducer.test.ts
```

Expected before implementation: policy is missing from event/project output.

- [ ] **Step 4: Implement event planning, projection, and reducer support**

Add the optional field to Rust `OrchestrationCommand::ProjectMetaUpdate`; include the default in `project.created`; pass the supplied value through `project.meta-updated`; update `apply_to_model`, project projection SQL, shell serialization in `apps/server/src/production/orchestration_rpc.rs`, and the client reducer.

- [ ] **Step 5: Run focused persistence and orchestration tests**

```sh
cargo test -p bibcode-server --test repositories -- --nocapture
cargo test -p bibcode-server --test orchestration -- --nocapture
cargo test -p bibcode-server --test persistence_compat -- --nocapture
vp test run packages/client-runtime/src/state/shellReducer.test.ts
```

- [ ] **Step 6: Commit durable policy support**

```sh
git add apps/server/src/persistence/migrations.rs apps/server/src/persistence/repositories.rs apps/server/src/orchestration/engine.rs apps/server/src/production/orchestration_rpc.rs apps/server/tests/repositories.rs apps/server/tests/orchestration.rs apps/server/tests/persistence_compat.rs packages/client-runtime/src/state/shellReducer.ts packages/client-runtime/src/state/shellReducer.test.ts
git commit -m "feat(orchestration): persist worktree discovery policy"
```

### Task 3: Build the strict Git worktree inventory parser

**Files:**
- Create: `apps/server/src/git/worktree.rs`
- Modify: `apps/server/src/git/mod.rs`
- Modify: `apps/server/src/git/repository.rs`
- Modify: `apps/server/src/git/model.rs`
- Modify: `apps/server/tests/git_coverage.rs`

**Interfaces:**
- Consumes: `git rev-parse --git-common-dir` and `git worktree list --porcelain [-z]` output through `ProcessRunner`.
- Produces: `GitWorktreeInventory { common_dir, records, format }`, strict parser errors, host path comparison keys, and opaque repository/worktree keys.

Use these Rust domain shapes:

```rust
pub struct GitWorktreeRecord {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub is_primary: bool,
    pub is_bare: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable_reason: Option<String>,
}

pub struct GitWorktreeInventory {
    pub common_dir: PathBuf,
    pub records: Vec<GitWorktreeRecord>,
    pub nul_delimited: bool,
}
```

The first parsed worktree record is primary. `branch refs/heads/name` becomes `name`; `detached` and unborn entries have a nullable branch. A `prunable` field preserves its optional reason. Unknown fields are ignored only when the record itself still has exactly one `worktree` field and no duplicate singleton fields. Empty, duplicate, truncated, unterminated, over-512, or pathless records are errors.

`normalize_worktree_path_key(path, platform)` normalizes separators and trailing
separators, uses native invariant uppercase mapping compatible with Windows
ordinal caseless identity for drive/UNC keys, and preserves POSIX case.
Authority-bearing identity then applies `canonical_worktree_path_key`: present
paths canonicalize through the filesystem, while genuine `NotFound` paths
canonicalize the nearest existing ancestor and append the normalized missing
suffix. Permission, symlink-loop, and all other failures propagate as typed
`WorkspaceIdentityError`; no lexical authority fallback is permitted. Catalog
joins, owner uniqueness, availability, mutation locks, removal, and
cross-project cleanup all use that physical key. `WorktreeRepositoryKey` and
`WorktreeKey` are lowercase SHA-256 hex over a version prefix, normalized
common-directory key, a NUL separator, and the physical worktree key.

- [ ] **Step 1: Add failing parser and identity tests**

Cover NUL and legacy records with spaces, Git C-style quoted paths, embedded
newline escapes, detached/unborn, bare, locked with and without reason, prunable
with and without reason, duplicate fields, missing record terminator, over-limit
output, Windows drive/UNC/non-ASCII/sigma equivalence for present and missing
paths, POSIX case distinction, present symlink/macOS aliases, missing nearest-
ancestor aliases, injected non-`NotFound` failures, and deterministic opaque
keys.

Run:

```sh
cargo test -p bibcode-server git::worktree::tests -- --nocapture
```

Expected before implementation: the module and parser do not exist.

- [ ] **Step 2: Implement parser, path identity, and key derivation**

Keep parsing pure. Do not call the filesystem from the parser.

- [ ] **Step 3: Add failing real-Git inventory tests**

Create a temporary repository and linked worktrees. Prove `GitRepository::worktree_inventory`:

- resolves a relative common Git directory against the command anchor;
- prefers `--porcelain -z`;
- falls back only for an explicit unsupported-`-z` diagnostic;
- caches the capability per `GitRepository` instance;
- rejects truncated `ProcessOutput` as non-authoritative;
- returns primary and linked records without modifying the repository.

Run:

```sh
cargo test -p bibcode-server --test git_coverage worktree_inventory -- --nocapture
```

Expected before implementation: `worktree_inventory` is missing.

- [ ] **Step 4: Implement repository inventory commands**

Add `GitRepository::worktree_inventory(anchor, cancellation)` and a private legacy capability cache. Use `OutputPolicy::Error`, a four-MiB output limit, and `allow_non_zero_exit` only for capability detection. Resolve common Git directory without requiring the primary checkout directory to remain present.

- [ ] **Step 5: Run Git tests**

```sh
cargo test -p bibcode-server git::worktree::tests -- --nocapture
cargo test -p bibcode-server --test git_coverage worktree -- --nocapture
```

- [ ] **Step 6: Commit inventory support**

```sh
git add apps/server/src/git/worktree.rs apps/server/src/git/mod.rs apps/server/src/git/repository.rs apps/server/src/git/model.rs apps/server/tests/git_coverage.rs
git commit -m "feat(git): inspect registered worktrees strictly"
```

### Task 4: Implement the bounded Worktree Catalog service

**Files:**
- Create: `apps/server/src/worktree_catalog/mod.rs`
- Create: `apps/server/src/worktree_catalog/model.rs`
- Create: `apps/server/src/worktree_catalog/service.rs`
- Create: `apps/server/src/worktree_catalog/tests.rs`
- Modify: `apps/server/src/lib.rs`
- Modify: `apps/server/src/persistence/repositories.rs`
- Modify: `apps/server/src/persistence/migrations.rs`
- Modify: `apps/server/tests/repositories.rs`
- Modify: `apps/server/tests/persistence_compat.rs`
- Create: `apps/server/tests/worktree_catalog.rs`

**Interfaces:**
- Consumes: `Repositories`, `GitRepository::worktree_inventory`, active and archived projection threads, project roots, and bounded directory probes.
- Produces: `WorktreeCatalogService`, `CatalogSubscription`, immutable generation-stamped snapshots, mutation locks, refresh invalidation, and server-resolved adoption/availability joins.

The service API is fixed as:

```rust
pub enum CatalogRefreshTrigger {
    FirstSubscriber,
    Focus,
    Explicit,
    MetadataChanged,
    AvailabilityChanged,
    Mutation,
}

impl WorktreeCatalogService {
    pub async fn subscribe(&self, project_id: &str) -> Result<CatalogSubscription, CatalogError>;
    pub async fn refresh(
        &self,
        project_id: &str,
        trigger: CatalogRefreshTrigger,
    ) -> Result<Arc<WorktreeCatalogSnapshot>, CatalogError>;
    pub async fn latest(&self, project_id: &str) -> Option<Arc<WorktreeCatalogSnapshot>>;
    pub async fn invalidate_after_mutation(&self, project_id: &str);
    pub async fn note_managed_creation(&self, project_id: &str, path: &Path);
    pub async fn with_project_mutation_lock<T, F, Fut>(&self, project_id: &str, operation: F) -> T;
}
```

Migration 41, named `ProjectionProjectWorktreeRepositoryKey`, adds nullable
`projection_projects.worktree_repository_key` for upgrade compatibility.
Migration 42, named `ProjectWorktreeRepositoryPins`, creates the durable
`project_worktree_repository_pins` identity table outside rebuildable
projection state and backfills any migration-41 pins. Project reads join the
dedicated table. Generic project upserts and projection replay cannot establish
or replace identity; only the authoritative-primary atomic pin operation can.
The pin survives project-projection delete/rewind/replay and is identity/fencing
metadata, not cached live-worktree truth. Once pinned, every primary, adopted,
or lifetime-common-directory anchor must resolve to the same key. A
same-repository adopted anchor may recover on cold start; a replacement
repository at an old path must remain unavailable and must never re-pin the
project. A warm mismatch degrades scan health while retaining the prior
authoritative arrays.

The internal runtime has project-specific catalog views plus repository
observations keyed by canonical common-Git identity. A project-to-repository
alias map lets a subscription start from `projectId`; projects sharing a
repository may coalesce Git observation but never share joined snapshots,
streams, thread IDs, subscriber counts, suppressions, or mutation epochs.
Snapshot joins follow these rules:

- active and archived non-panel, non-deleted threads count as adopted;
- panel threads never claim a worktree;
- a registered/present nonprimary/nonbare/unadopted record is eligible;
- a registered missing record produces `missing-registered` for its adopted thread;
- an adopted path absent from an authoritative inventory produces `missing-unregistered`; a directory that now exists at that unregistered path is treated as a replacement conflict, never as recovery;
- unknown probes preserve `verification-unavailable` or the prior proven state;
- degraded refreshes retain the last authoritative `worktrees` and `adoptedWorkspaces` arrays and publish only degraded scan health;
- two canonical threads resolving to one path produce a catalog conflict and no arbitrary ownership.

- [ ] **Step 1: Add failing deterministic service tests**

Use a fake inventory source, fake probe, paused Tokio time, and a configurable service options value. Prove:

- anchor preference is primary, then present adopted worktree, then lifetime common directory;
- first subscribers share one scan;
- projects sharing a repository receive isolated initial and concurrent
  publications while sharing only Git observation;
- four repositories scan concurrently while a fifth waits;
- probes never exceed eight and time out to `unknown`;
- mutation epoch rejects a stale in-flight result;
- a mutation refresh queued behind that stale completion performs one fresh
  current-epoch scan immediately, while repeated invalidations coalesce and
  ordinary pre-mutation waiters retain the identical stale result;
- a deliberately delayed repeated invalidation cannot start a second recovery
  task or an unnecessary scan after the first recovery publishes;
- final unsubscribe clears a pending mutation recovery before it can call Git
  or publish, and immediate reattachment cannot inherit that old lifecycle's
  pending worker or result;
- watch subscribers receive the latest snapshot after lag;
- polling inspects only common-Git shallow metadata and known paths;
- a failed scan retains authoritative data;
- final unsubscription stops polling; eviction begins only when the combined
  subscriber/unary-user count reaches zero;
- unary-only entry creation/reuse/cancellation holds counted active-user
  ownership and pointer-checked eviction begins 60 seconds after the final
  subscriber or unary user;
- aborting subscribe at every await point releases its guarded reservation;
- attachment at the idle deadline cannot join an evicted entry;
- final active-user release interrupts pending shallow signature, Git, and probe work
  and prevents a later publication;
- a physical-repository mutation lock remains serialized across aliased
  projects and project-view eviction;
- coalesced callers receive the same explicit ownership-conflict result;
- managed creation suppression expires after 30 seconds;
- server joins active, archived, panel, deleted, missing, and conflicting threads correctly.

Run:

```sh
cargo test -p bibcode-server worktree_catalog::tests -- --nocapture
```

Expected before implementation: the service does not exist.

- [ ] **Step 2: Implement model, registry, single-flight, and publication**

Use `watch::Sender<Arc<WorktreeCatalogSnapshot>>`, a global `Semaphore`, a
per-project-view refresh mutex and mutation epoch, a per-repository observation
mutex, and cancellation tokens owned by their lifetimes. Use an RAII subscriber
reservation, a scoped RAII unary-user reservation, and atomic registry/view
validation. Repository observations and
physical mutation locks may use weak registry slots, but a held or awaited lock
must retain strong ownership. Store only the last authoritative snapshot,
current scan status, last coalesced result, shallow signature, subscriber and
unary-user counts, suppression map, one pending mutation-refresh epoch, and lifecycle-owned
task handles for each project view. Mutation invalidations overwrite that
pending epoch and install at most one recovery worker under the entry-state
lock. The worker may bypass exactly one coalesced `StaleGeneration` completion
to scan the current epoch; this is not a general error retry and remains under
the existing single-flight lock and subscriber cancellation. Invalidations
before its scan fence coalesce into that scan. A mutation arriving during
recovery leaves newer pending work and causes at most the next serialized step
after an async yield. Final active-user release cancels and clears the worker and its
pending epoch before releasing lifecycle ownership. It also aborts the task so
a non-cancellation-aware dependency await cannot retain the project refresh
lock or block a new lifecycle. Reattachment cannot inherit either the old
worker or its result.
Initialization is an idempotent project-view-owned task with latest-generation
readiness, not work owned by whichever subscriber first reaches an await.
Zero-to-one active-user acquisition advances a lifecycle epoch and creates fresh
cancellation ownership for the project view and shared repository observation.
Older lifecycle completions are fenced from the new stream and result slot.
Mutation-stale leaders store and advance one explicit stale result so every
already coalesced waiter observes the same error without starting a divergent
refresh.
Scope reusable repository observations to the same selected anchor path so an
alias's valid observation cannot bypass validation of a different replacement
anchor. Decrement project-view and repository active-user ownership atomically
under the entry-to-repository lock order before allowing reattachment. Once a
caller owns the repository observation lock, move that guard and scan into
repository-lifecycle work and await it with the caller's view cancellation. A
detached leader then releases its project refresh lock immediately while an
alias may keep the exact-anchor repository observation alive; a new view never
inherits the old project worker or result, but may coalesce with that still-live
repository lifecycle.

- [ ] **Step 3: Implement anchor resolution and directory probing**

Use `tokio::fs::metadata` behind a one-second timeout. Only `ErrorKind::NotFound` becomes missing. Permission, I/O, and timeout become unknown. Canonicalize only present registered paths after common-directory membership is established. On a legacy null pin, require the primary anchor and persist its key only after the scan succeeds. On a pinned project, reject every mismatched primary, adopted, or lifetime anchor before joining or publishing.

- [ ] **Step 4: Add failing real-repository integration tests**

Prove external creation appears, directory deletion becomes missing-registered, `git worktree remove` or prune becomes missing-unregistered, the same path recovers, primary deletion does not become an authoritative empty catalog, and Git failure retains the preceding snapshot.

Run:

```sh
cargo test -p bibcode-server --test worktree_catalog -- --nocapture
```

- [ ] **Step 5: Implement shallow signature polling and recovery**

Hash metadata for the canonical common directory's `worktrees` directory and `worktrees/*/{gitdir,locked}` plus `stat` results for known paths. Do not descend into checkout contents or Git object directories. Poll every two seconds; run Git only when the signature or known-path availability changes.

- [ ] **Step 6: Run catalog tests**

```sh
cargo test -p bibcode-server worktree_catalog::tests -- --nocapture
cargo test -p bibcode-server --test worktree_catalog -- --nocapture
```

- [ ] **Step 7: Commit the catalog service**

```sh
git add apps/server/src/worktree_catalog apps/server/src/lib.rs apps/server/src/persistence/migrations.rs apps/server/src/persistence/repositories.rs apps/server/src/production/orchestration_effects.rs apps/server/tests/repositories.rs apps/server/tests/persistence_compat.rs apps/server/tests/worktree_catalog.rs docs/superpowers/specs/2026-08-09-external-worktree-discovery-and-adoption-design.md docs/superpowers/plans/2026-08-09-external-worktree-discovery-and-adoption.md
git commit -m "feat(server): add authoritative worktree catalog"
```

### Task 5: Expose catalog reads and discovery policy over typed RPC

**Files:**
- Modify: `packages/contracts/src/worktree.ts`
- Modify: `packages/contracts/src/worktree.test.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/rpc.test.ts`
- Modify: `packages/contracts/src/rpcRustParity.test.ts`
- Modify generated fixtures: `packages/contracts/fixtures/rpc-wire/**`
- Create: `apps/server/src/production/worktree_catalog_rpc.rs`
- Modify: `apps/server/src/production/mod.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/src/production/git_vcs.rs`
- Modify: `apps/server/src/rpc/methods.rs`
- Modify: `apps/server/src/auth/scope.rs`
- Modify: `apps/server/tests/rpc_wire.rs`
- Create: `apps/server/tests/production_worktree_catalog_rpc.rs`

**Interfaces:**
- Consumes: `WorktreeCatalogService`, `OrchestrationEngine`, and project metadata commands.
- Produces: `subscribeWorktreeCatalog`, `vcs.refreshWorktreeCatalog`, and `worktree.updateDiscoveryPolicy`.

Add these exact method names:

```ts
subscribeWorktreeCatalog: "subscribeWorktreeCatalog"
vcsRefreshWorktreeCatalog: "vcs.refreshWorktreeCatalog"
worktreeUpdateDiscoveryPolicy: "worktree.updateDiscoveryPolicy"
```

Inputs:

```ts
WorktreeCatalogInput = { projectId }
WorktreeCatalogRefreshInput = { projectId }
WorktreeDiscoveryPolicyUpdateInput = {
  commandId,
  projectId,
  visibility?,
  acknowledgeGeneration?,
  dismissInitialPrompt?,
}
```

Policy updates with `acknowledgeGeneration` require that exact authoritative generation; the server compacts `baselinePaths` from the latest eligible candidate path keys, deduplicates them, caps them at 512, and persists the policy through `project.meta.update`. Clients never submit baseline paths.

- [ ] **Step 1: Add failing RPC schema and parity tests**

Register the three TypeScript RPC definitions and add representative fixture shapes. The stream success is the snapshot itself. Unary and stream errors include `WorktreeCatalogError` and `EnvironmentAuthorizationError`.

Run:

```sh
vp test run packages/contracts/src/worktree.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts
```

Expected before the Rust registry change: TypeScript/Rust method parity fails for the new methods.

- [ ] **Step 2: Add failing server RPC tests**

Prove initial snapshot delivery, latest-value replacement, cancellation unsubscribe, explicit refresh, project-not-found failure, stale acknowledgement rejection, exact baseline compaction, and hidden/shown policy persistence. Prove read scope for subscribe/refresh and orchestration-operate scope for policy mutation.

Run:

```sh
cargo test -p bibcode-server --test production_worktree_catalog_rpc -- --nocapture
cargo test -p bibcode-server auth::scope::tests -- --nocapture
```

Expected before implementation: methods and handlers are absent.

- [ ] **Step 3: Implement RPC registration and runtime ownership**

Construct one `WorktreeCatalogService` in `ProductionRuntime::start` using the shared `GitRepository` and orchestration repositories. Register the stream and unary handlers before `finalize_rpc_registry`. Retain the service in `ProductionRuntime` so shutdown cancels pollers.

- [ ] **Step 4: Route BiBCode-created worktrees through server-resolved authority**

Register `worktree.createManaged`. It accepts project/ref intent, thread
identity/title, and ordinary defaults, but no `cwd`, kind, or target path. The
server resolves the project root, lets `GitRepository::create_worktree` choose
the path, persists the canonical owner, then calls `note_managed_creation` and
invalidates. If persistence fails after Git succeeds, a private exact rollback
uses internal creation metadata to re-verify and remove only that just-created
registered nonprimary checkout and the actual newly created branch, including
an automatic suffix. Retire public `vcs.createWorktree` and
`vcs.removeWorktree` from TypeScript contracts, Rust registry/scope/handler,
desktop bridge, and fixtures. PR worktree mode resolves its branch then invokes
`worktree.createManaged`; `git.preparePullRequestThread` remains local-only; catalog
removal is exclusively `worktree.removeFromBibCode` / `worktree.remove`. Never
turn a failed observational refresh into a failed already-committed mutation
response.

- [ ] **Step 5: Regenerate fixtures and run parity tests**

```sh
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
vp test run packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts
cargo test -p bibcode-server --test rpc_wire -- --nocapture
cargo test -p bibcode-server --test production_worktree_catalog_rpc -- --nocapture
```

- [ ] **Step 6: Commit catalog RPC reads**

```sh
git add packages/contracts/src/worktree.ts packages/contracts/src/worktree.test.ts packages/contracts/src/rpc.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts packages/contracts/fixtures/rpc-wire apps/server/src/production/worktree_catalog_rpc.rs apps/server/src/production/mod.rs apps/server/src/production/runtime.rs apps/server/src/production/git_vcs.rs apps/server/src/rpc/methods.rs apps/server/src/auth/scope.rs apps/server/tests/rpc_wire.rs apps/server/tests/production_worktree_catalog_rpc.rs
git commit -m "feat(rpc): stream worktree catalog state"
```

### Task 6: Implement idempotent adoption and server-resolved owner changes

**Files:**
- Modify: `packages/contracts/src/worktree.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/rpc.test.ts`
- Modify generated fixtures: `packages/contracts/fixtures/rpc-wire/**`
- Modify: `apps/server/src/orchestration/engine.rs`
- Modify: `apps/server/src/production/worktree_catalog_rpc.rs`
- Modify: `apps/server/src/worktree_catalog/service.rs`
- Modify: `apps/server/src/rpc/methods.rs`
- Modify: `apps/server/src/auth/scope.rs`
- Modify: `apps/server/tests/orchestration.rs`
- Modify: `apps/server/tests/worktree_catalog.rs`
- Modify: `apps/server/tests/production_worktree_catalog_rpc.rs`

**Interfaces:**
- Consumes: An eligible catalog key/generation, project thread defaults, project mutation lock, and orchestration transaction.
- Produces: `worktree.adopt` returning exactly one active ordinary workspace thread, `worktree.createPanel`, `worktree.retarget`, and catalog-driven durable branch updates. Managed creation is established in the corrected Task 5 boundary.

Add:

```ts
worktreeAdopt: "worktree.adopt"

WorktreeAdoptInput = {
  commandId,
  projectId,
  worktreeKey,
  expectedGeneration,
  threadDefaults: {
    modelSelection,
    runtimeMode,
    interactionMode,
  },
}

WorktreeAdoptResult = {
  threadId,
  disposition: "created" | "existing" | "restored",
}

WorktreeCreatePanelInput = {
  commandId,
  hostThreadId,
  threadId,
  title,
  threadDefaults,
}

WorktreeRetargetInput = {
  commandId,
  projectId,
  threadId,
  worktreeKey,
  expectedGeneration,
}
```

`worktree.createPanel` re-reads the host under the mutation lock and derives
panel kind, project, branch, and path. `worktree.retarget` refreshes and
revalidates the opaque catalog candidate, physical ownership, presence, and
nonprimary/nonbare eligibility before dispatching the resolved metadata update.
Generic `thread.create` and `thread.meta.update` cannot carry these authority
fields.

Use server-internal orchestration variants `WorktreeAdoptResolved` and `WorktreeBranchReconcileResolved`; reject those variants if they arrive through `orchestration.dispatchCommand`. `WorktreeAdoptResolved` contains only server-resolved path/key/branch data and emits `thread.created` or `thread.unarchived` plus `project.meta-updated` in one `persist_command` transaction. Extend `ThreadState` with branch, worktree path, and project membership needed for invariant checks.

- [ ] **Step 1: Add failing adoption RPC contract tests**

Prove key/generation/defaults encode, all three dispositions decode, and stale/ineligible failures carry the current generation.

Run:

```sh
vp test run packages/contracts/src/worktree.test.ts packages/contracts/src/rpc.test.ts
```

- [ ] **Step 2: Add failing orchestration transaction tests**

Prove a resolved adoption:

- creates `kind: "workspace"` with current branch/path and no setup-script event;
- returns an existing active canonical thread;
- unarchives a matching archived canonical thread;
- ignores panel threads as owners;
- rejects a second canonical thread for the exact physical server path;
- updates policy baseline in the same transaction;
- rolls back both events when either projector fails.

Run:

```sh
cargo test -p bibcode-server orchestration::engine::tests::worktree_adoption -- --nocapture
```

Expected before implementation: internal command planning is absent.

- [ ] **Step 3: Implement atomic adoption planning**

Reuse `persist_command`; do not write projection tables from the RPC handler. Populate title from branch, detached short SHA, or final path component in that order. The created thread has no session and behaves exactly like a normal workspace thread.

- [ ] **Step 4: Add failing concurrent RPC tests**

Prove two command IDs racing on one key converge to one thread, stale generation triggers one forced refresh then revalidation, an external disappearance fails without a thread, an archived thread restores, and an already active thread returns existing.

Run:

```sh
cargo test -p bibcode-server --test production_worktree_catalog_rpc adopt -- --nocapture
cargo test -p bibcode-server --test worktree_catalog adoption -- --nocapture
```

- [ ] **Step 5: Implement the adoption application handler**

Acquire the physical-project mutation lock, validate or refresh the generation, re-probe presence, verify common-directory membership and eligibility, then dispatch the resolved internal command. Adoption never invokes `GitRepository::create_worktree`.

- [ ] **Step 6: Reconcile externally changed branches**

After a healthy scan, compare each active adopted workspace's current catalog branch with durable `thread.branch`. Dispatch one deterministic server metadata command only when the value changes. Use a command ID derived from thread ID plus a hash of the new branch/HEAD, not the raw path. A degraded scan emits no branch update.

- [ ] **Step 7: Regenerate fixtures and run focused tests**

```sh
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
vp test run packages/contracts/src/worktree.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts
cargo test -p bibcode-server --test production_worktree_catalog_rpc -- --nocapture
cargo test -p bibcode-server --test worktree_catalog -- --nocapture
```

- [ ] **Step 8: Commit adoption**

```sh
git add packages/contracts/src/worktree.ts packages/contracts/src/rpc.ts packages/contracts/src/rpc.test.ts packages/contracts/fixtures/rpc-wire apps/server/src/orchestration/engine.rs apps/server/src/production/worktree_catalog_rpc.rs apps/server/src/worktree_catalog/service.rs apps/server/src/rpc/methods.rs apps/server/src/auth/scope.rs apps/server/tests/orchestration.rs apps/server/tests/worktree_catalog.rs apps/server/tests/production_worktree_catalog_rpc.rs
git commit -m "feat(worktrees): adopt external checkouts idempotently"
```

### Task 7: Add capability-gated client-runtime worktree state

**Files:**
- Create: `packages/client-runtime/src/state/worktrees.ts`
- Create: `packages/client-runtime/src/state/worktrees.test.ts`
- Modify: `packages/client-runtime/package.json`
- Modify: `packages/contracts/src/environment.ts`
- Modify: `packages/contracts/src/environment.test.ts`
- Create: `apps/web/src/state/worktrees.ts`
- Create: `apps/web/src/state/worktrees.test.tsx`

**Interfaces:**
- Consumes: Catalog stream, project policy, server-resolved descriptor/adopted joins, environment capability, and adoption/policy RPCs.
- Produces: `createWorktreeEnvironmentAtoms`, one negotiated-session capability policy, one shared availability selector, pure discovery derivation, availability lookup by scoped thread, add-one/add-all commands, and focus refresh support.

Add `worktreeCatalog: Boolean` to `ExecutionEnvironmentCapabilities` with a decoding default of `false`. Do not advertise it from the server yet.

The client module exports:

```ts
createWorktreeEnvironmentAtoms(runtime)
deriveWorktreeDiscoveryState(input)
deriveAdoptedWorkspaceStateByThreadId(snapshot)
isWorktreeCatalogSupported(environmentDescriptor)
```

`deriveWorktreeDiscoveryState` uses `eligibleForAdoption`, server-provided normalized paths, and policy baseline only. It returns `newCandidates`, `acknowledgedCandidates`, `showInitialPrompt`, `showCollapsedHiddenLine`, and `shownCandidates`. It never calls a path-normalization helper.

- [ ] **Step 1: Add failing capability and pure-state tests**

Cover:

- missing capability decodes false;
- false/missing capability starts no subscription and makes no refresh, policy,
  create, panel, retarget, adopt, plan, destructive-remove, direct/bulk/archived
  new-method call;
- legacy fallback performs only confirmed ordinary thread detach and never raw
  Git removal;
- hidden initial candidates expand;
- acknowledged candidates collapse;
- a new path outside baseline re-expands;
- shown mode exposes discovered rows without creating threads;
- active and archived server joins prevent candidates;
- panel-only state remains eligible because the server marks it eligible;
- degraded data retains the last usable rows;
- cold/no-status, present, and retained `verification-unavailable` remain
  usable through one exported selector, while both missing states and
  `removing` are blocked across surfaces;
- grouped environments stay isolated.

Run:

```sh
vp test run packages/contracts/src/environment.test.ts packages/client-runtime/src/state/worktrees.test.ts
```

Expected before implementation: capability and module are absent.

- [ ] **Step 2: Implement capability decode and worktree atom family**

Use `createEnvironmentSubscriptionAtomFamily` for snapshots. Every worktree
command first reads capability from the current negotiated `RpcSession` and
uses that exact session for the request, preventing reconnect races. Centralize
false-capability policy, legacy detach-only behavior, and the availability
presentation selector in this module. Key project commands serially by
`environmentId + projectId`, panel commands by host, and refresh as
single-flight. Export the new `./state/worktrees` package subpath.

- [ ] **Step 3: Add failing add-all tests**

Prove per-environment concurrency never exceeds four, successes are retained when siblings fail, stale-generation failures are surfaced per key, add-one returns the thread to navigate to, and add-all does not request navigation.

Run:

```sh
vp test run packages/client-runtime/src/state/worktrees.test.ts
```

- [ ] **Step 4: Implement mutation helpers and web bindings**

Create the app-owned atom instance in `apps/web/src/state/worktrees.ts`. Add a hook that refreshes subscribed physical projects on `window.focus` and when `document.visibilityState` returns to `visible`; remove listeners on unmount and coalesce duplicate focus/visibility events through the command scheduler.

- [ ] **Step 5: Run client tests**

```sh
vp test run packages/contracts/src/environment.test.ts packages/client-runtime/src/state/worktrees.test.ts apps/web/src/state/worktrees.test.tsx
```

- [ ] **Step 6: Commit client state**

```sh
git add packages/client-runtime/src/state/worktrees.ts packages/client-runtime/src/state/worktrees.test.ts packages/client-runtime/package.json packages/contracts/src/environment.ts packages/contracts/src/environment.test.ts apps/web/src/state/worktrees.ts apps/web/src/state/worktrees.test.tsx
git commit -m "feat(client-runtime): reconcile discovered worktrees"
```

### Task 8: Render Orca-style discovery and adoption controls

**Files:**
- Create: `apps/web/src/components/WorktreeDiscoverySection.tsx`
- Create: `apps/web/src/components/WorktreeDiscoverySection.test.tsx`
- Create: `apps/web/src/components/WorktreeDiscoverySection.logic.ts`
- Create: `apps/web/src/components/WorktreeDiscoverySection.logic.test.ts`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/Sidebar.test.tsx`
- Modify: `apps/web/src/sidebarProjectGrouping.ts`
- Modify: `apps/web/src/sidebarProjectGrouping.test.ts`

**Interfaces:**
- Consumes: Each `SidebarProjectSnapshot.memberProjects`, catalog/policy state, and adoption/policy commands.
- Produces: Initial discovery card, collapsed hidden line, shown discovered rows, per-candidate adoption, add-all progress, and project-menu visibility toggle.

`WorktreeDiscoverySection` renders one physical-project child per environment member. A grouped logical project therefore groups by environment first; each child groups candidates by normalized parent-directory display path. Candidate labels use branch or detached short SHA and show the full server path. Remote/local badges reuse existing environment presentation.

- [ ] **Step 1: Add failing pure presentation tests**

Prove deterministic grouping and sorting by environment label, parent directory, branch/SHA, and path. Prove detached labels, plural counts, partial-success summaries, and hidden/shown menu labels.

Run:

```sh
vp test run apps/web/src/components/WorktreeDiscoverySection.logic.test.ts apps/web/src/sidebarProjectGrouping.test.ts
```

- [ ] **Step 2: Implement pure grouping/presentation helpers**

Do not normalize paths for identity. Parent-directory extraction is display-only and handles both separators.

- [ ] **Step 3: Add failing component and Sidebar tests**

Cover:

- first discovery card is expanded above the primary row;
- add-one adopts and navigates to the returned scoped thread;
- add-all stays on the current route and reports mixed results;
- Keep hidden acknowledges the exact generation;
- collapsed text says `Hiding N discovered worktrees` and can expand;
- shown mode displays clearly marked discovered rows;
- selecting a shown discovered row adopts rather than pretending it is a thread;
- project context menu toggles `Show hidden worktrees` / `Hide discovered worktrees`;
- unsupported environments render no controls and do not subscribe;
- grouped projects retain physical environment boundaries.

Run:

```sh
vp test run apps/web/src/components/WorktreeDiscoverySection.test.tsx apps/web/src/components/Sidebar.test.tsx
```

Expected before implementation: no discovery surface is rendered.

- [ ] **Step 4: Implement discovery components and Sidebar integration**

Mount discovery immediately before `SidebarPrimaryRow`. Keep existing primary/workspace split, thread selection, drag behavior, and preview limits unchanged. Use existing Button, Tooltip, ContextMenu, toast, and sidebar primitives.

- [ ] **Step 5: Run web discovery tests**

```sh
vp test run apps/web/src/components/WorktreeDiscoverySection.logic.test.ts apps/web/src/components/WorktreeDiscoverySection.test.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/sidebarProjectGrouping.test.ts
```

- [ ] **Step 6: Commit discovery UI**

```sh
git add apps/web/src/components/WorktreeDiscoverySection.tsx apps/web/src/components/WorktreeDiscoverySection.test.tsx apps/web/src/components/WorktreeDiscoverySection.logic.ts apps/web/src/components/WorktreeDiscoverySection.logic.test.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/sidebarProjectGrouping.ts apps/web/src/sidebarProjectGrouping.test.ts
git commit -m "feat(web): show and adopt discovered worktrees"
```

### Task 9: Guard and quiesce authoritatively missing workspaces

**Files:**
- Create: `apps/server/src/worktree_catalog/availability.rs`
- Create: `apps/server/src/production/worktree_runtime.rs`
- Modify: `apps/server/src/worktree_catalog/service.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/src/production/orchestration_rpc.rs`
- Modify: `apps/server/src/production/server_terminal.rs`
- Modify: `apps/server/src/production/git_vcs.rs`
- Modify: `apps/server/src/workspace/rpc.rs`
- Modify: `apps/server/src/production/workspace_preview.rs`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/rpc.test.ts`
- Modify: `packages/contracts/src/worktree.test.ts`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/production_server_terminal_rpc.rs`
- Modify: `apps/server/tests/production_git_vcs_rpc.rs`
- Modify: `apps/server/tests/workspace_rpc.rs`
- Modify: `apps/server/tests/worktree_catalog.rs`

**Interfaces:**
- Consumes: Authoritative adopted-workspace transitions from the catalog.
- Produces: `WorkspaceAvailabilityRegistry`, structured path/thread guards, one coalesced runtime quiesce per loss transition, recovery clearing, and bounded orphan cleanup.

The guard API is:

```rust
pub enum WorkspaceGuardState {
    MissingRegistered,
    MissingUnregistered,
    Removing,
}

impl WorkspaceAvailabilityRegistry {
    pub async fn guard_thread(&self, thread_id: &str) -> Result<(), WorkspaceUnavailable>;
    pub async fn guard_path(&self, path: &Path) -> Result<(), WorkspaceUnavailable>;
    pub async fn acquire_admission(...) -> Result<WorkspaceAdmissionLease, WorkspaceUnavailable>;
    pub async fn acquire_path_admission(...) -> Result<WorkspaceAdmissionLease, WorkspaceUnavailable>;
    pub async fn mark_unavailable(&self, transition: WorkspaceLossTransition) -> bool;
    pub async fn mark_removing(&self, thread_id: &str, path: &Path) -> RemovalGuard;
    pub async fn clear_recovered(&self, thread_id: &str, path: &Path);
}
```

`mark_unavailable` returns true only for the first transition token `(threadId, generation, availability)`. The production quiescer stops the provider session and all thread terminals with a five-second graceful bound. Work that remains is placed on a bounded 64-entry reaper queue owned and shut down by `ProductionRuntime`; queue saturation is logged and reflected as `orphanCleanupPending` without dropping the guard.

- [ ] **Step 1: Add failing guard state-machine tests**

Prove guard-before-callback ordering, duplicate transition coalescing, degraded
no-op, recovery clearing only for the same physical path/repository, removing
precedence, present symlink/macOS and missing-nearest-ancestor alias collapse,
Windows drive/UNC/non-ASCII comparison, and bounded reaper behavior.

Run:

```sh
cargo test -p bibcode-server worktree_catalog::availability::tests -- --nocapture
cargo test -p bibcode-server --test worktree_catalog runtime_loss -- --nocapture
```

- [ ] **Step 2: Implement registry and catalog transition callbacks**

Install the guard synchronously with catalog publication before starting quiesce. Append one warning activity using a deterministic transition-derived activity ID. Preserve conversation and terminal transcript rows.

- [ ] **Step 3: Add failing boundary tests**

Prove guarded workspaces reject:

- `thread.turn.start` before durable turn admission;
- terminal open, restart, write, and restart-on-attach;
- client Git status/mutation requests whose `cwd` is guarded;
- project file/search/mutation and review requests whose `cwd` is guarded.

Also pause file read/search/browse/asset and write/delete operations after
admission. Prove the lease is held for the complete RPC, `Removing` or
authoritative loss waits for admitted work, mutations acquire finalization
before their filesystem/durable commit, and later work is rejected. Cover
cancellation/error release without leaking a lease.

Closing a terminal, reading conversation history, deleting/detaching the thread, refreshing the catalog, and internal cleanup Git commands remain allowed.

Run:

```sh
cargo test -p bibcode-server --test production_orchestration_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test production_git_vcs_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test workspace_rpc workspace_unavailable -- --nocapture
```

- [ ] **Step 4: Wire structured guards into RPC owners**

Add `WorkspaceUnavailableError` to the affected contract RPC error unions.
Inject the same registry into orchestration, terminal, Git VCS, and
`WorkspaceRpcDependencies`. Replace entry-point-only filesystem checks with
owned admission leases retained across the entire handler. Every mutation
calls `begin_finalization` before its commit boundary and retains that permit
through completion. Internal catalog/removal calls use `GitRepository` directly
under their own resolved removal guard and bypass client-path guards.

- [ ] **Step 5: Run focused lifecycle tests**

```sh
vp test run packages/contracts/src/worktree.test.ts packages/contracts/src/rpc.test.ts
cargo test -p bibcode-server --test worktree_catalog -- --nocapture
cargo test -p bibcode-server --test production_orchestration_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test production_server_terminal_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test production_git_vcs_rpc workspace_unavailable -- --nocapture
cargo test -p bibcode-server --test workspace_rpc workspace_unavailable -- --nocapture
```

- [ ] **Step 6: Commit missing-workspace lifecycle**

```sh
git add apps/server/src/worktree_catalog/availability.rs apps/server/src/production/worktree_runtime.rs apps/server/src/worktree_catalog/service.rs apps/server/src/production/runtime.rs apps/server/src/production/orchestration_rpc.rs apps/server/src/production/server_terminal.rs apps/server/src/production/git_vcs.rs apps/server/src/workspace/rpc.rs apps/server/src/production/workspace_preview.rs packages/contracts/src/rpc.ts packages/contracts/src/worktree.test.ts apps/server/tests/production_provider_runtime.rs apps/server/tests/production_server_terminal_rpc.rs apps/server/tests/production_git_vcs_rpc.rs apps/server/tests/workspace_rpc.rs apps/server/tests/worktree_catalog.rs
git commit -m "feat(server): guard missing worktree workspaces"
```

### Task 10: Add verified destructive-removal Git primitives

**Files:**
- Modify: `apps/server/src/git/worktree.rs`
- Modify: `apps/server/src/git/model.rs`
- Modify: `apps/server/src/git/repository.rs`
- Modify: `apps/server/tests/git_coverage.rs`
- Modify: `apps/server/tests/git_rpc.rs`

**Interfaces:**
- Consumes: A fresh server-resolved catalog record and cancellation token.
- Produces: Removal preflight, plan-token digest inputs, verified targeted removal, prune preview, verified stale cleanup, and explicit protected/dirty/locked failures.

Add repository APIs:

```rust
pub async fn inspect_worktree_removal(
    &self,
    anchor: &Path,
    record: &GitWorktreeRecord,
    cancellation: &CancellationToken,
) -> Result<GitWorktreeRemovalInspection, GitCommandError>;

pub async fn remove_worktree_verified(
    &self,
    anchor: &Path,
    record: &GitWorktreeRecord,
    force_dirty: bool,
    cancellation: &CancellationToken,
) -> Result<(), GitCommandError>;

pub async fn preview_worktree_prune(
    &self,
    anchor: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<GitPrunableWorktree>, GitCommandError>;

pub async fn prune_worktrees_verified(
    &self,
    anchor: &Path,
    target: &GitWorktreeRecord,
    expected_impact_digest: &str,
    cancellation: &CancellationToken,
) -> Result<(), GitCommandError>;
```

Inspection runs status in the target checkout when present and reports separate tracked and untracked counts. Missing targets skip dirty inspection. Targeted removal runs `git worktree remove --force -- <fresh-record-path>` only after exact record/common-directory revalidation, then strictly lists and proves absence. Prune runs the approved dry-run first and verifies target absence afterward.

- [ ] **Step 1: Add failing protection/preflight tests**

Prove primary, bare, locked, mismatched repository, changed path identity, and unregistered replacement directory are rejected. Prove clean, tracked-dirty, untracked-dirty, and both-dirty counts. Prove the branch remains after successful worktree removal.

Run:

```sh
cargo test -p bibcode-server --test git_coverage worktree_removal -- --nocapture
```

- [ ] **Step 2: Implement preflight and targeted verification**

Use porcelain-v2 NUL status for dirty inspection. Re-read inventory immediately before mutation and immediately after Git reports success or failure. Do not use `remove_dir_all` in these new verified APIs.

- [ ] **Step 3: Add failing stale-cleanup tests**

Prove targeted cleanup succeeds for an unlocked missing registration, locked cleanup fails closed with its reason, prune preview identifies every affected registration, repository-wide prune requires a matching confirmed impact set, and a successful Git exit with a surviving target is an error.

Run:

```sh
cargo test -p bibcode-server --test git_coverage worktree_prune -- --nocapture
cargo test -p bibcode-server --test git_rpc worktree -- --nocapture
```

- [ ] **Step 4: Implement prune preview and verification**

Parse `git worktree prune --dry-run --verbose --expire now` into bounded records and compare confirmed impacts by a versioned digest over sorted `(normalized registration path, exact prune reason)` tuples. The public `GitPrunableWorktree` impact retains the exact dry-run reason. The verified prune primitive owns the final TOCTOU fence: it reruns the bounded dry-run immediately before mutation and rejects unless that fresh path-plus-reason digest exactly matches the caller-confirmed `expected_impact_digest`. Never prune a locked target.

- [ ] **Step 5: Run Git removal tests**

```sh
cargo test -p bibcode-server --test git_coverage worktree -- --nocapture
cargo test -p bibcode-server --test git_rpc worktree -- --nocapture
```

- [ ] **Step 6: Commit verified Git removal**

```sh
git add apps/server/src/git/worktree.rs apps/server/src/git/model.rs apps/server/src/git/repository.rs apps/server/tests/git_coverage.rs apps/server/tests/git_rpc.rs
git commit -m "feat(git): verify worktree removal and stale cleanup"
```

### Task 11: Implement removal planning, detach, and deletion RPCs

**Files:**
- Modify: `packages/contracts/src/worktree.ts`
- Modify: `packages/contracts/src/worktree.test.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/rpc.test.ts`
- Modify: `packages/contracts/src/environment.test.ts`
- Modify generated fixtures: `packages/contracts/fixtures/rpc-wire/**`
- Modify: `apps/server/src/orchestration/engine.rs`
- Modify: `apps/server/src/production/worktree_catalog_rpc.rs`
- Modify: `apps/server/src/production/control.rs`
- Modify: `apps/server/src/worktree_catalog/service.rs`
- Modify: `apps/server/src/worktree_catalog/availability.rs`
- Modify: `apps/server/src/rpc/methods.rs`
- Modify: `apps/server/src/auth/scope.rs`
- Modify: `apps/server/tests/orchestration.rs`
- Modify: `apps/server/tests/production_worktree_catalog_rpc.rs`
- Modify: `apps/server/tests/worktree_catalog.rs`

**Interfaces:**
- Consumes: Thread ID, fresh catalog generation, opaque plan token, explicit removal mode/confirmations, physical target identity, catalog-selected trusted repository anchor, runtime quiescer, and verified Git primitives.
- Produces: `worktree.getRemovalPlan`, `worktree.removeFromBibCode`, `worktree.remove`, runtime-owned retry-safe detach/delete transactions, generic adopted-owner/project-delete rejection, and partial cleanup outcomes.

Add exact methods:

```ts
worktreeGetRemovalPlan: "worktree.getRemovalPlan"
worktreeRemoveFromBibCode: "worktree.removeFromBibCode"
worktreeRemove: "worktree.remove"
```

Inputs:

```ts
WorktreeGetRemovalPlanInput = { projectId, threadId }
WorktreeRemoveFromBibCodeInput = { commandId, projectId, threadId }
WorktreeRemoveInput = {
  commandId,
  projectId,
  threadId,
  mode: "delete-git-worktree" | "cleanup-stale-registration",
  expectedGeneration,
  planToken,
  forceDirty,
  confirmRepositoryWidePrune,
}
```

The plan token is SHA-256 over a version prefix, physical project, thread, repository key, worktree key or missing-path identity, generation, availability, dirty counts, lock state, and sorted prune-impact `(normalized registration path, exact prune reason)` tuples. Removal always reruns preflight and requires the digest to match.

- [ ] **Step 1: Add failing contract and RPC registration tests**

Prove detach requires no generation/path, destructive modes require confirmations, all result outcomes decode, and errors distinguish stale plan, dirty confirmation, protected target, lock, conflict, Git failure, and repository mismatch.

Run:

```sh
vp test run packages/contracts/src/worktree.test.ts packages/contracts/src/rpc.test.ts
```

- [ ] **Step 2: Add failing atomic detach tests**

Add server-internal `WorktreeDetachResolved`, rejected through generic client dispatch. It emits dependent panel `thread.deleted` events, canonical `thread.deleted`, and `project.meta-updated` baseline compaction in one transaction. Prove detach works for present, missing-registered, missing-unregistered, archived, and already-deleted retries; prove a second canonical owner is an explicit conflict.

Run:

```sh
cargo test -p bibcode-server orchestration::engine::tests::worktree_detach -- --nocapture
```

- [ ] **Step 3: Implement removal planning and detach-only**

`getRemovalPlan` resolves the current server state and never mutates. It resolves
the catalog-selected trusted anchor, excludes the target, and requires that the
primary, present adopted sibling, or lifetime common directory match the
durable pin. `removeFromBibCode` claims the command, reserves a cleanup-lifetime
slot, acquires project/repository/physical-owner locks and the removing guard,
requests bounded quiesce, dispatches `WorktreeDetachResolved` regardless of
quiesce result, clears guard state for the deleted thread, invalidates the
catalog, and returns `gitOutcome: "not-requested"`. Generic thread deletion of
an adopted owner and generic project deletion containing any adopted owner fail
closed before persistence.

- [ ] **Step 4: Add failing destructive state-machine tests**

Cover:

- present clean delete removes Git then atomically detaches;
- dirty delete requires `forceDirty` and a fresh matching plan;
- Git failure or failed absence verification keeps the present thread;
- missing cleanup targeted success detaches with `cleaned`;
- missing cleanup failure still detaches with `failed` and detail;
- prune impact requires explicit confirmation;
- locked stale registration skips cleanup but detach-only remains available;
- crash simulation after Git removal/before detach yields a missing row and a safe detach retry;
- duplicate command ID is idempotent;
- runtime teardown failure sets `orphanCleanupPending` without blocking detach.
- WebSocket `Interrupt` and socket closure immediately after engine enqueue do
  not release the command claim, locks, cleanup slot/reservation, `Removing`
  guard, quiesce, or detach owner before a durable terminal result;
- cancellation before handoff wins without later mutation;
- a missing primary uses a pinned adopted sibling/common-directory anchor, and
  anchor or pin drift after quiesce aborts before Git;
- symlink/macOS/missing-leaf/cross-project aliases cannot split ownership or
  quiesce.

Run:

```sh
cargo test -p bibcode-server --test production_worktree_catalog_rpc removal -- --nocapture
cargo test -p bibcode-server --test worktree_catalog removal -- --nocapture
```

- [ ] **Step 5: Implement destructive and cleanup flows**

For present destructive mode, re-resolve and revalidate the trusted repository
anchor under the mutation locks after quiesce, then perform verified Git
mutation before durable detach and release `removing` back to the refreshed
state on failure. For missing cleanup, attempt targeted cleanup, conditionally
prune only with a matching confirmation, then detach even on cleanup failure.
Preserve the checked-out branch. Run adoption, policy, detach, and removal in a
server-owned operation runtime: cancellation wins only before engine-envelope
handoff; after handoff retain all lifecycle resources until the durable receipt,
and drain this runtime before catalog/provider/terminal shutdown. Admit at most
64 server-owned operation lifetimes with one named non-waiting global semaphore
before spawn. Return structured capacity/shutdown failures, keep the permit
through the terminal result, close admission during shutdown, and never create
an unbounded waiter queue.

- [ ] **Step 6: Advertise the capability only after the complete server surface exists**

Set `worktreeCatalog: true` in the environment descriptor and control-stream
config only when the complete catalog surface is registered. Add descriptor
tests proving older payloads decode false and the production server advertises
true. Register read/operate scopes and update `ACTIVE_RPC_METHODS` for catalog
stream/refresh/policy, managed creation, panel creation, retarget, adoption,
planning, detach, and destructive removal. Prove public raw removal is absent.

- [ ] **Step 7: Regenerate fixtures and run server tests**

```sh
vp run --filter @bibcode/contracts generate:rust-rpc-fixtures
vp test run packages/contracts/src/worktree.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts packages/contracts/src/environment.test.ts
cargo test -p bibcode-server --test rpc_wire -- --nocapture
cargo test -p bibcode-server --test production_worktree_catalog_rpc -- --nocapture
cargo test -p bibcode-server --test worktree_catalog -- --nocapture
cargo test -p bibcode-server production::control::tests::environment_descriptor -- --nocapture
```

- [ ] **Step 8: Commit removal application services**

```sh
git add packages/contracts/src/worktree.ts packages/contracts/src/worktree.test.ts packages/contracts/src/rpc.ts packages/contracts/src/rpc.test.ts packages/contracts/fixtures/rpc-wire packages/contracts/src/environment.test.ts apps/server/src/orchestration/engine.rs apps/server/src/production/worktree_catalog_rpc.rs apps/server/src/worktree_catalog/service.rs apps/server/src/worktree_catalog/availability.rs apps/server/src/production/control.rs apps/server/src/rpc/methods.rs apps/server/src/auth/scope.rs apps/server/tests/orchestration.rs apps/server/tests/production_worktree_catalog_rpc.rs apps/server/tests/worktree_catalog.rs
git commit -m "feat(worktrees): detach or delete with verified choices"
```

### Task 12: Render persistent warnings and explicit removal choices

**Files:**
- Create: `apps/web/src/components/WorktreeRemovalDialog.tsx`
- Create: `apps/web/src/components/WorktreeRemovalDialog.test.tsx`
- Create: `apps/web/src/components/WorktreeAvailabilityWarning.tsx`
- Create: `apps/web/src/components/WorktreeAvailabilityWarning.test.tsx`
- Modify: `packages/client-runtime/src/state/worktrees.ts`
- Modify: `packages/client-runtime/src/state/worktrees.test.ts`
- Modify: `apps/web/src/hooks/useThreadActions.ts`
- Modify: `apps/web/src/hooks/useThreadActions.test.ts`
- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/Sidebar.test.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.test.tsx`
- Modify: `apps/web/src/worktreeCleanup.ts`
- Modify: `apps/web/src/worktreeCleanup.test.ts`

**Interfaces:**
- Consumes: Server removal plan, adopted availability map, detach/delete/cleanup commands, and existing thread navigation cleanup.
- Produces: Persistent missing row, recovery detail, three-way present deletion choice, missing cleanup choice, dirty second confirmation, prune disclosure, and safe archived/bulk removal behavior.

`WorktreeRemovalDialog` is a controlled React dialog shared by Sidebar and Archived Threads. Present state buttons are `Remove from BiBCode`, `Delete Git worktree and remove`, and `Cancel`. Missing-registered state adds `Clean stale Git registration and remove`; missing-unregistered offers detach only. Locked state explains the reason and never enables cleanup. A dirty destructive choice opens a second confirmation showing tracked/untracked counts. A nonempty prune impact lists every affected path and requires a separate confirmation.

- [ ] **Step 1: Add failing client command tests**

Prove removal commands serialize per physical project, detach does not require a catalog snapshot, stale plan causes a fresh-plan result rather than an automatic retry, and partial cleanup success is represented without restoring the row.

Run:

```sh
vp test run packages/client-runtime/src/state/worktrees.test.ts
```

- [ ] **Step 2: Implement client removal commands**

Add get-plan, detach, and destructive commands to `createWorktreeEnvironmentAtoms`. Preserve `AsyncResult` failure semantics and expose typed partial results.

- [ ] **Step 3: Add failing dialog tests**

Cover every availability, lock, dirty, prune, partial-result, cancel, loading, and stale-plan branch. Assert that no action sends a path. Assert detach remains enabled when the directory and registration are both absent.

Run:

```sh
vp test run apps/web/src/components/WorktreeRemovalDialog.test.tsx apps/web/src/components/WorktreeAvailabilityWarning.test.tsx
```

- [ ] **Step 4: Implement removal and warning components**

Display last-known branch and full path, registration state, lock reason, `Retry detection`, `Remove from BiBCode`, and eligible cleanup. Keep the row selectable for conversation history while disabling workspace-specific context-menu items.

- [ ] **Step 5: Replace browser-owned Git deletion**

Remove direct `vcsEnvironment.removeWorktree` and raw-path deletion from `useThreadActions`. Ordinary non-worktree threads continue using `thread.delete`. Worktree-backed active and archived threads open the reusable removal dialog. Bulk thread deletion uses explicit detach-only copy and never destructively removes Git in bulk. Keep fallback navigation, draft cleanup, center/right panel cleanup, and archived refresh behavior.

Centralize false-capability handling for Sidebar, archived settings, direct, and
bulk removal. An older server receives only an explicitly confirmed ordinary
thread deletion described as detach-only; it never receives a catalog method or
raw Git removal request. A capable server must use the dedicated removal flow,
and generic deletion of its adopted owner fails closed.

- [ ] **Step 6: Add failing integration tests for deleted directories**

Prove a missing row remains rendered, selecting it opens history, Git/open/file/script actions are disabled, Retry requests catalog refresh, detach removes the row even without a directory, and partial stale cleanup reports the remaining manual issue after row removal.

Run:

```sh
vp test run apps/web/src/hooks/useThreadActions.test.ts apps/web/src/components/Sidebar.test.tsx apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/worktreeCleanup.test.ts
```

- [ ] **Step 7: Run web removal tests**

```sh
vp test run apps/web/src/components/WorktreeRemovalDialog.test.tsx apps/web/src/components/WorktreeAvailabilityWarning.test.tsx apps/web/src/hooks/useThreadActions.test.ts apps/web/src/components/Sidebar.test.tsx apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/worktreeCleanup.test.ts
```

- [ ] **Step 8: Commit warning and removal UI**

```sh
git add apps/web/src/components/WorktreeRemovalDialog.tsx apps/web/src/components/WorktreeRemovalDialog.test.tsx apps/web/src/components/WorktreeAvailabilityWarning.tsx apps/web/src/components/WorktreeAvailabilityWarning.test.tsx packages/client-runtime/src/state/worktrees.ts packages/client-runtime/src/state/worktrees.test.ts apps/web/src/hooks/useThreadActions.ts apps/web/src/hooks/useThreadActions.test.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/SettingsPanels.test.tsx apps/web/src/worktreeCleanup.ts apps/web/src/worktreeCleanup.test.ts
git commit -m "feat(web): recover and remove missing worktrees"
```

### Task 13: Prove adopted-worktree capability parity and guarded UX

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/GitActionsControl.tsx`
- Modify: `apps/web/src/components/GitActionsControl.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalPanel.tsx`
- Modify: `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx`
- Modify: `apps/web/src/components/chat/ChatHeaderActions.tsx`
- Modify: `apps/web/src/components/chat/ChatHeaderActions.render.test.tsx`
- Modify: `apps/web/src/components/files/FileBrowserPanel.tsx`
- Modify: `apps/web/src/components/files/FileBrowserPanel.test.tsx`
- Modify: `apps/web/src/components/files/FilePreviewPanel.tsx`
- Modify: `apps/web/src/components/files/FilePreviewPanel.test.tsx`
- Modify: `apps/web/src/components/DiffPanel.tsx`
- Modify: `apps/web/src/components/DiffPanel.test.tsx`
- Create: `apps/server/tests/external_worktree_lifecycle.rs`

**Interfaces:**
- Consumes: An adopted ordinary thread and its availability state.
- Produces: Existing provider, terminal, Git, file, diff, review, script, panel, editor, pin/unread, archive, and navigation behavior when present; predictable disabled/banners when missing.

- [ ] **Step 1: Add failing cross-feature web tests**

For a present adopted thread, prove existing components receive its `worktreePath` exactly as they do for a BiBCode-created thread. For missing/removing states, prove composer send, terminal create/restart/write, Git actions, setup/script launch, file mutation, and diff refresh are disabled with the same actionable reason. Conversation rendering, copy path, retry, and removal remain available.

Run:

```sh
vp test run apps/web/src/components/ChatView.test.tsx apps/web/src/components/GitActionsControl.test.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/files/FileBrowserPanel.test.tsx apps/web/src/components/files/FilePreviewPanel.test.tsx apps/web/src/components/DiffPanel.test.tsx
```

- [ ] **Step 2: Implement one shared availability selector**

Read availability from client-runtime by scoped thread and call the one exported
presentation selector used by Sidebar and archived surfaces. Cold/no-status,
`present`, and retained `verification-unavailable` remain usable; only
authoritative `missing-registered`, `missing-unregistered`, and `removing`
disable workspace-dependent controls. Pass a single `workspaceUnavailable`
value through the active chat/panel surface instead of adding independent
catalog subscriptions to every component. Render one banner and use it to
disable workspace-dependent controls.

- [ ] **Step 3: Add failing end-to-end server lifecycle tests**

Using real temporary Git repositories and production RPC registration, prove:

- external discovery completes within five seconds while subscribed;
- adoption performs no Git add and creates exactly one thread;
- provider/terminal/file/Git requests use the adopted path while present;
- external directory deletion produces one guard/quiesce and a retained row;
- degraded Git observation produces no guard/quiesce;
- re-registering the same path clears the guard;
- destructive removal preserves the branch;
- detach succeeds after external deletion and after cleanup failure.

Run:

```sh
cargo test -p bibcode-server --test external_worktree_lifecycle -- --nocapture
```

- [ ] **Step 4: Implement missing integration wiring exposed by the tests**

Reuse the normal workspace-thread paths. Do not add provenance conditionals for present adopted worktrees.

- [ ] **Step 5: Run focused parity suites**

```sh
vp test run apps/web/src/components/ChatView.test.tsx apps/web/src/components/GitActionsControl.test.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/files/FileBrowserPanel.test.tsx apps/web/src/components/files/FilePreviewPanel.test.tsx apps/web/src/components/DiffPanel.test.tsx
cargo test -p bibcode-server --test external_worktree_lifecycle -- --nocapture
```

- [ ] **Step 6: Commit parity and guarded UX**

```sh
git add apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/GitActionsControl.tsx apps/web/src/components/GitActionsControl.test.tsx apps/web/src/components/ThreadTerminalPanel.tsx apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx apps/web/src/components/chat/ChatHeaderActions.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/files/FileBrowserPanel.tsx apps/web/src/components/files/FileBrowserPanel.test.tsx apps/web/src/components/files/FilePreviewPanel.tsx apps/web/src/components/files/FilePreviewPanel.test.tsx apps/web/src/components/DiffPanel.tsx apps/web/src/components/DiffPanel.test.tsx apps/server/tests/external_worktree_lifecycle.rs
git commit -m "test(worktrees): prove adopted workspace parity"
```

### Task 14: Update living architecture and run completion gates

**Files:**
- Create: `docs/architecture/worktree-catalog.md`
- Modify: `docs/README.md`
- Modify: `docs/user/workspace-ui.md`
- Modify: `docs/architecture/rpc-and-orchestration.md`
- Modify: `docs/architecture/connection-runtime.md`
- Modify if required by discovered command changes: `docs/reference/scripts.md`

**Interfaces:**
- Consumes: Final implemented contracts, ownership, lifecycle, commands, and UI.
- Produces: Current living documentation, complete validation evidence, and a clean final diff.

- [ ] **Step 1: Write the dedicated living architecture document**

Document sources of truth, catalog entry lifecycle, anchor selection, authoritative/degraded semantics, path/key security, snapshot joins, polling bounds, policy persistence, adoption transaction, missing guard/quiesce, recovery, removal state machine, crash boundaries, authorization scopes, capability rollout, and observability. Link it from the architecture index in `docs/README.md`.

- [ ] **Step 2: Update existing living documentation**

Update workspace UI with discovery/hidden/shown/warning/removal UX; RPC/orchestration with new methods and atomic events; connection runtime with capability gating, per-environment subscriptions, latest-value/backpressure, focus refresh, and reconnect behavior. Update script documentation only if script behavior or commands changed; explicitly state adopted external worktrees do not auto-run create scripts.

- [ ] **Step 3: Run focused feature suites**

```sh
vp test run packages/contracts/src/worktree.test.ts packages/contracts/src/environment.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/rpcRustParity.test.ts packages/client-runtime/src/state/worktrees.test.ts apps/web/src/state/worktrees.test.tsx apps/web/src/components/WorktreeDiscoverySection.logic.test.ts apps/web/src/components/WorktreeDiscoverySection.test.tsx apps/web/src/components/WorktreeRemovalDialog.test.tsx apps/web/src/components/WorktreeAvailabilityWarning.test.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/hooks/useThreadActions.test.ts
cargo test -p bibcode-server git::worktree::tests -- --nocapture
cargo test -p bibcode-server worktree_catalog::tests -- --nocapture
cargo test -p bibcode-server --test worktree_catalog -- --nocapture
cargo test -p bibcode-server --test production_worktree_catalog_rpc -- --nocapture
cargo test -p bibcode-server --test external_worktree_lifecycle -- --nocapture
```

- [ ] **Step 4: Run broader package and repository gates**

```sh
vp check
vp run typecheck
vp run test
cargo test -p bibcode-server --lib --tests -- --test-threads=1
cargo fmt --all --check
cargo clippy -p bibcode-server --lib --tests -- -D warnings
```

Expected: all commands pass. If an environment-specific test cannot run, record the exact command, output, and residual risk; do not describe the feature as fully verified without that disclosure.

- [ ] **Step 5: Check architectural and completeness consistency**

```sh
rg -n "TO[D]O|TB[D]|placeholde[r]|client.*normalize.*worktree|remove_dir_all.*worktree|vcsEnvironment\.removeWorktree" packages/contracts/src/worktree.ts packages/client-runtime/src/state/worktrees.ts apps/server/src/worktree_catalog apps/server/src/production/worktree_catalog_rpc.rs apps/web/src/components/WorktreeDiscoverySection.tsx apps/web/src/components/WorktreeRemovalDialog.tsx apps/web/src/hooks/useThreadActions.ts docs/architecture/worktree-catalog.md
rg -n "subscribeWorktreeCatalog|vcs\.refreshWorktreeCatalog|worktree\.updateDiscoveryPolicy|worktree\.createManaged|worktree\.createPanel|worktree\.retarget|worktree\.adopt|worktree\.getRemovalPlan|worktree\.removeFromBibCode|worktree\.remove" packages/contracts/src/rpc.ts apps/server/src/rpc/methods.rs apps/server/src/auth/scope.rs apps/server/src/production/worktree_catalog_rpc.rs
rg -n "vcs\.removeWorktree|VcsRemoveWorktree|remove_worktree_handler" packages apps
```

Expected: no unresolved markers, no client path/kind/policy/delete authority, no
recursive worktree deletion fallback, no browser-owned or public raw Git removal,
and every dedicated method appears in contracts, registry, scope map, and
handler registration. The raw-removal search may match only explicit negative
tests or documentation explaining its absence.

- [ ] **Step 6: Review final diff and status**

```sh
git diff --check
git diff --stat
git status --short
```

Inspect the full diff for unintended generated files, `.repos/`, `.codegraph/`, debug output, dependency drift, raw destructive paths, missing docs, and unrelated edits.

- [ ] **Step 7: Commit living documentation**

```sh
git add docs/architecture/worktree-catalog.md docs/README.md docs/user/workspace-ui.md docs/architecture/rpc-and-orchestration.md docs/architecture/connection-runtime.md docs/reference/scripts.md
git commit -m "docs: document external worktree lifecycle"
```

- [ ] **Step 8: Record completion evidence**

Report every validation command and result, the final commit range, any skipped platform-specific coverage, and residual risks. Confirm all fifteen acceptance criteria in the approved design against an automated test or an explicitly identified manual verification.

## Specification Coverage Audit

| Approved acceptance criterion | Planned evidence |
| --- | --- |
| External worktree appears within five seconds | Two-second shallow poll and real-time-bound assertion in Tasks 4 and 13 |
| Newly discovered worktrees default hidden and remain recoverable | Policy defaults and discovery-card/menu tests in Tasks 1, 7, and 8 |
| Adoption performs no Git creation and creates one thread | Git mutation spy, orchestration atomicity, and concurrent adoption tests in Task 6 |
| Adopted worktree has normal workspace capabilities | Cross-feature web tests and production lifecycle test in Task 13 |
| Authoritative directory loss retains a warning row | Catalog transition tests in Task 4 and warning/removal tests in Task 12 |
| Degraded observation never creates false absence or teardown | Catalog retention tests in Task 4 and quiesce no-op tests in Tasks 9 and 13 |
| Detach succeeds without directory/registration and after cleanup failure | Removal state-machine tests in Task 11 and UI integration tests in Task 12 |
| User chooses detach-only or destructive deletion | Three-way dialog and destructive confirmation tests in Task 12 |
| Same registered path heals the existing workspace | Catalog recovery and guard-clearing tests in Tasks 4, 9, and 13 |
| Destructive protections fail closed | Primary, bare, locked, dirty, replacement, and repository-mismatch tests in Tasks 10 and 11 |
| Concurrency and slow consumers remain bounded | Semaphore, single-flight, watch, mutation-epoch, bulk, and reaper tests in Tasks 4, 7, and 9 |
| Dedicated authority has no raw/generic bypass | Contract/runtime method absence, raw-wire negatives, dedicated create/panel/retarget/adopt/removal tests in corrected Tasks 5, 6, and 11 |
| Cancellation ownership changes only at handoff | Pre-handoff cancellation plus post-enqueue Interrupt/socket-close lifecycle races in Task 11 |
| Physical aliases and full-operation leases converge | Symlink/macOS/missing-leaf/Windows identity and paused filesystem-operation tests in Tasks 3, 9, and 11 |
| Trusted fallback anchors remain pinned | Missing-primary plan/execute and post-quiesce revalidation tests in Tasks 4 and 11 |
| Unary entries evict safely | Paused-time unary create/reuse/cancel/final-user eviction tests in Task 4 |
| Capability and availability policies are shared | False-capability direct/bulk/archived tests and cold/degraded/missing selector tests in Tasks 7, 12, and 13 |
