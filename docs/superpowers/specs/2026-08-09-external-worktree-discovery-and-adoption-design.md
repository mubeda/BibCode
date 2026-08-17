# External Worktree Discovery and Adoption Design

**Date:** 2026-08-09

**Status:** Approved, including the 2026-08-11 reviewer-safe authority amendment.

## Summary

Add repository-scoped discovery and adoption of Git worktrees that were not
created by BibCode. Newly discovered worktrees are hidden by default and shown
in an Orca-inspired discovery surface. A user can keep them hidden, expose
them as discovered rows, add one, or add all.

The Rust server owns an authoritative, in-memory Worktree Catalog backed by
`git worktree list`. Git and the filesystem remain the source of current
worktree truth. Existing orchestration threads remain the durable record that
a user adopted a worktree into BibCode. Adoption creates the same ordinary
workspace thread used for a BibCode-created worktree without running
`git worktree add`, so imported worktrees receive the existing agent,
terminal, Git, file, script, panel, and navigation behavior.

An adopted worktree that is authoritatively proven missing remains visible as
a disabled warning row. The user can always remove that row and its BibCode
history even when the worktree directory no longer exists or stale Git
metadata cannot be cleaned. For a present worktree, the user explicitly
chooses between removing it only from BibCode and destructively removing the
Git worktree as well.

## Context

BibCode represents every visible workspace row as an orchestration
thread:

- a project's `kind: "default"` thread is its primary checkout row;
- another non-panel thread with `worktreePath` is a worktree workspace row;
- managed creation is one server-resolved `worktree.createManaged` operation
  that chooses the checkout path and persists its canonical owner;
- panel creation and worktree retargeting use dedicated server-resolved RPCs;
- detach and destructive deletion use the catalog plan/removal flow, never a
  public raw-path Git removal.

This model already gives a worktree thread all downstream capabilities, but it
has no repository worktree inventory independent of threads. Consequently,
BibCode cannot show checkouts created by another application, and a missing
directory is encountered only when a later workspace operation fails.

The feature must preserve the existing package and runtime boundaries:

- `apps/server` owns Git, persistence, orchestration, processes, terminals,
  files, and authoritative runtime lifecycle;
- `packages/contracts` remains schema-only;
- `packages/client-runtime` owns shared RPC/state/reconciliation behavior;
- `apps/web` owns interaction and presentation;
- native desktop actions continue to cross `DesktopBridge`, while normal Git
  and application traffic continues over typed HTTP/WebSocket RPC.

## Reference Implementation Research

The design was informed by a source-level review of
[Orca at commit `343b8bf0`](https://github.com/stablyai/orca/tree/343b8bf0ee5db52aaa3ac03c515bca1d093747d0).
The original external-worktree refresh feature landed in
[commit `8ed89037`](https://github.com/stablyai/orca/commit/8ed890374ad0e7fa13c84966f1cb1433b967e519)
(`Refresh project worktrees created outside Orca (#6241)`). Relevant current
source includes:

- `src/shared/external-worktree-visibility.ts`
- `src/shared/external-worktree-inbox.ts`
- `src/shared/worktree-ownership.ts`
- `src/main/git/worktree.ts`
- `src/main/repo-worktrees.ts`
- `src/main/ipc/worktrees.ts`
- `src/main/ipc/worktree-base-directory-watcher.ts`
- `src/main/local-worktree-removal-recovery.ts`
- `src/renderer/src/components/sidebar/ImportedWorktreesVisibilityLine.tsx`
- `src/renderer/src/components/sidebar/NewExternalWorktreesInboxLine.tsx`
- `src/renderer/src/store/slices/worktrees.ts`

The load-bearing findings are:

1. Git remains the discovery source. Orca persists user visibility, inbox
   baseline, and explicit-import intent instead of persisting a second live
   worktree inventory.
2. Detection uses `git worktree list --porcelain -z`, with a capability-cached
   fallback for older Git versions. The stable porcelain format is also the
   format recommended by the
   [Git worktree documentation](https://git-scm.com/docs/git-worktree).
3. Detected results explicitly distinguish authoritative Git scans from
   metadata/session fallbacks. Only authoritative absence may purge state.
4. Concurrent scans are coalesced, results are briefly cached, and mutation
   generations prevent a stale in-flight scan from overwriting a newer
   create/remove result.
5. Orca watches or polls shallow workspace and common-Git metadata rather than
   recursively observing checkout contents. This avoids high-volume filesystem
   event streams from worktree source trees and Git objects.
6. `prunable` registrations are excluded from Orca's live detected listing,
   and an authoritative absence triggers terminal teardown and a broad purge
   of worktree-keyed renderer state.
7. Stale-registration cleanup does not trust a successful `git worktree prune`
   exit by itself. It strictly lists worktrees again and fails closed when the
   registration remains, particularly for locked registrations.
8. Orca normally removes a proven-missing worktree row. BibCode deliberately
   differs here: an adopted thread is user data and remains as a recoverable
   warning row until the user removes it.

## Goals

- Discover linked Git worktrees regardless of which application created them.
- Keep new external worktrees hidden by default while making discovery
  obvious, reversible, and controllable per physical project.
- Add one or all discovered worktrees without recreating or modifying them.
- Give an adopted external worktree every capability of a BibCode-created
  worktree.
- Keep Git/filesystem truth separate from durable user adoption intent.
- Detect externally deleted directories without interpreting transient Git,
  network, or environment failure as deletion.
- Preserve a missing workspace row, conversation, and recovery actions until
  the user explicitly removes it.
- Let the user choose detach-only or destructive Git removal for a present
  worktree.
- Guarantee detach-only removal even when the directory is absent, Git no
  longer registers it, or optional stale-registration cleanup fails.
- Remain predictable under concurrent scans, multiple windows, restarts,
  reconnects, partial bulk adoption, and process teardown failures.
- Keep scans, probes, tasks, subprocesses, queues, and retained state bounded.

## Non-goals

- Discovering unrelated clones that are not registered Git worktrees.
- Automatically moving an adopted thread to a newly discovered path based on
  branch or commit similarity.
- Automatically deleting local branches when a worktree is removed.
- Automatically running `runOnWorktreeCreate` scripts for an existing external
  checkout.
- Silently unlocking worktrees or hand-editing Git administrative files.
- Treating an unavailable environment or failed Git scan as an empty
  repository.
- Sharing filesystem paths or scan authority across environments in a grouped
  logical project.

## Approved Architectural Choice

Use a **server-owned Worktree Catalog with thread-backed adoption**.

The final reviewer-safe authority ruling makes the catalog RPC boundary
exclusive for worktree policy, identity, creation, panel derivation,
retargeting, adoption, detach, and destructive removal. Generic orchestration
may continue to mutate ordinary non-worktree state, but cannot accept discovery
policy, worktree kind/path/bootstrap authority, adopted-owner deletion, or
project deletion while adopted owners remain. Public `vcs.removeWorktree` and
`vcs.createWorktree` are retired; the only raw removal-shaped primitive is
private rollback of the exact just-created, still-unowned managed checkout and
actual newly created branch after owner persistence fails. Pull-request
worktree mode resolves the PR branch and enters `worktree.createManaged`; the
legacy PR preparation operation is local-checkout-only.

Rejected alternatives were:

1. **Client-side list-and-import.** A unary list RPC plus web-side comparison
   would be smaller initially, but authoritative deletion, caching, race
   fencing, path normalization, and stale cleanup would leak into React and
   produce multiple sources of policy.
2. **A new persistent Workspace aggregate.** Projects owning separate
   workspaces and threads referencing workspace IDs would be conceptually
   clean, but it would require a broad migration through orchestration,
   providers, routing, panels, terminals, and persistence. The existing
   canonical workspace thread already supplies the requested capability
   boundary without that cost.

## Domain Model and Sources of Truth

| Concern | Source of truth |
| --- | --- |
| Registered worktrees, current branch, HEAD, lock, and directory availability | Server Worktree Catalog backed by Git and server filesystem probes |
| Whether a worktree is adopted into BibCode | A non-deleted canonical workspace thread with that `worktreePath` |
| Conversations, agents, terminals, panels, and model settings | Existing orchestration thread |
| Hidden/shown discovery intent and acknowledgement | Project orchestration metadata |
| Repository identity fence | Nullable durable project `WorktreeRepositoryKey` stored outside rebuildable projections and established only by a trusted authoritative primary-checkout scan |
| Current scan health, cache, generations, subscribers, and scoped unary users | In-memory Worktree Catalog runtime |

The design does not persist a duplicate live worktree list. Catalog state is
rebuilt from Git after server restart. The durable repository identity is a
trust pin, not an alternative source of live worktree, branch, registration,
lock, or availability truth.

### Worktree descriptor

The contract exposes a `VcsWorktreeDescriptor` with this conceptual shape:

```text
worktreeKey        opaque branded identifier derived by the server
path               server-normalized Git path; canonical when present
branch             local branch name or null for detached/unborn worktrees
head               commit ID when available
isPrimary          true only for the repository's primary checkout
isBare             true for a bare worktree record
locked             Git lock state
lockReason         optional Git lock reason
registrationState  registered | prunable
directoryState     present | missing | unknown
```

`worktreeKey` is scoped to the execution environment and canonical Git common
directory. It is derived from the repository identity plus the server's
physical path key and is opaque to clients. It is not treated as stable across
an external move.

Path comparison is server-only and uses one physical identity across catalog
joins, canonical-owner uniqueness, availability, mutation locks, removal, and
cross-project cleanup:

- present paths are canonicalized through the filesystem after registration
  has been established;
- missing paths canonicalize their nearest existing ancestor and append the
  normalized missing suffix, so symlinked parents, macOS `/var` aliases, and
  lexical `.`/`..` spellings cannot split identity;
- Windows drive and UNC paths are separator-normalized and compared with the
  native invariant uppercase mapping compatible with Windows ordinal caseless
  identity, including non-ASCII and sigma/final-sigma components;
- POSIX paths are separator-normalized and remain case-sensitive;
- only genuine `NotFound` walks to the nearest existing ancestor; permission,
  symlink-loop, and every other identity failure returns typed
  `WorkspaceIdentityError` and aborts the authority transition instead of
  creating a lexical fallback owner; and
- branch or HEAD similarity never establishes path identity.

If a worktree is moved externally, the former adopted path becomes missing
and the new path becomes a new discovered candidate. The user decides whether
to remove the former row and adopt the new one.

### Catalog snapshot

`VcsWorktreeCatalogSnapshot` contains:

```text
repositoryKey
generation
authoritative
observedAt
scanStatus
worktrees[]
```

`scanStatus` distinguishes healthy, refreshing, and degraded observation and
contains a structured failure class when degraded. A failed observation does
not overwrite `worktrees` from the last authoritative snapshot.

### Project discovery policy

Project metadata gains an optional `worktreeDiscovery` value:

```text
visibility: hidden | shown
initialPromptDismissedAt: timestamp | null
baselinePaths: normalized path list
```

Decoding an absent value produces `hidden`, `null`, and an empty baseline.
The baseline supports Orca-style resurfacing of newly discovered paths after a
user keeps the current set hidden. It is normalized, deduplicated, bounded,
and compacted only during explicit policy mutations against the latest
authoritative candidate set. An active or archived canonical thread already
records adoption, so imported paths are not persisted a second time.

Policy and catalogs are scoped to each physical `(environmentId, projectId)`.
A logical sidebar group may aggregate their presentation, but paths,
authority, mutations, and failures remain host-specific.

Project projection reads expose a nullable `worktreeRepositoryKey`, but the
identity row is stored in a dedicated durable table outside the rebuildable
project projection. Migration 42 backfills that table from migration 41's
nullable projection column. Legacy projects start unpinned. Only a successful,
authoritative scan anchored at the persisted primary checkout may call the
atomic establish-or-match operation. Generic project upserts and event replay
cannot establish or replace the pin. It therefore survives projection
delete/rewind/replay, and no scan implicitly re-pins it. Every later primary,
adopted-worktree, or lifetime-common-directory anchor must resolve to the same
key; mismatch fails closed and a warm view publishes degraded scan health
while retaining its prior authoritative arrays. This permits a cold-start
adopted anchor only when it matches the durable pin and prevents a replacement
repository at an old path from being reported as present.

## Worktree Catalog Service

### Registry and ownership

`apps/server` owns project-specific catalog views addressed by `projectId` and
a shared repository-observation layer keyed by canonical Git common-directory
identity. Projects that resolve to the same repository may share the bounded
Git observation, but never share their joined snapshot, `watch` sender,
subscriber count, suppression set, mutation epoch, or poll lifecycle. A
project refresh can therefore neither overwrite another project's stream nor
expose its thread IDs.

Each entry retains only bounded runtime state:

```text
lastAuthoritativeSnapshot
scanStatus
generation
mutationEpoch
pendingMutationRefreshEpoch
lifecycleEpoch
inFlightScan
subscriberCount
unaryUserCount
pollerCancellation
mutationRefreshWorkerCancellation
lastMetadataSignature
```

Project views with no subscribers stop polling and, after the final subscriber
or scoped unary user releases, are evicted after a 60-second idle retention
window. Refresh, adoption, retarget, removal, trusted-anchor resolution, and
current-snapshot reads hold unary-user ownership. Active-user reservation and
eviction are atomic: acquisition validates the currently registered view while
holding the registry lock, and pointer-checked eviction cannot remove a reused
or replacement view. Shared repository and
mutation-lock registry slots are weak references; a held or awaited physical
repository mutation lock remains strongly owned and cannot be removed and
recreated concurrently. A global semaphore bounds simultaneous Git catalog
scans, and each repository admits only one observation at a time.
Poll initialization is an idempotent project-view-owned task rather than an
individual subscriber-owned future. All attaching subscribers await the same
readiness generation, so aborting the subscriber that initiated initialization
cannot strand later subscribers. Transitions from zero to one active user
advance project-view and shared-repository lifecycle epochs and create fresh
cancellation ownership; completions from an older epoch cannot publish or
populate the new epoch's coalesced result.
Repository observations are reusable only for callers that selected the same
anchor path; a result from another alias's anchor cannot substitute for
resolving and validating the current caller's primary, adopted, or lifetime
anchor. Final view and repository active-user decrements share the same
entry-to-repository lock scope, so a reattachment cannot observe half-released
ownership or skip the repository lifecycle transition.

### Scan anchor resolution

For an already pinned project, the service selects a Git command working
directory in this order:

1. the persisted project primary checkout;
2. any present adopted worktree for that project;
3. a common Git directory resolved earlier in the current server lifetime.

For a legacy unpinned project, only the persisted primary checkout is eligible;
adopted and lifetime-common-directory anchors cannot establish identity. Every
selected anchor is scanned and compared with the durable pin before its result
is accepted. If no anchor is reachable or the key mismatches, the catalog
becomes degraded or unavailable. It does not publish an authoritative empty
set and never treats directory existence as recovery for an unregistered path.

Removal planning uses the same trusted-anchor resolver. It excludes the target,
requires the persisted repository pin, and may select the reachable primary, a
present adopted sibling, or the lifetime common directory only when the chosen
anchor resolves to that pin. Destructive execution re-resolves and revalidates
the anchor under its mutation locks after quiesce and immediately before Git.
The primary being absent therefore does not block a valid pinned fallback, but
neither path reuse nor anchor substitution can transfer removal authority.

### Authoritative scan algorithm

An authoritative refresh:

1. Resolves the project and an eligible scan anchor on the server.
2. Resolves and canonicalizes `git rev-parse --git-common-dir`.
3. Runs `git worktree list --porcelain -z` through the existing process API.
4. Falls back to newline-delimited `--porcelain` only when Git rejects `-z`,
   and caches that capability result.
5. Strictly parses every worktree record, including primary, bare, detached,
   unborn, locked, lock reason, and prunable fields.
6. Treats malformed, incomplete, or output-limited data as a failed,
   non-authoritative scan rather than silently omitting a row.
7. Probes registered linked paths and adopted thread paths with bounded
   concurrency and per-probe timeouts.
8. Distinguishes `NotFound` from permission, timeout, and other probe errors;
   only `NotFound` proves directory absence.
9. Produces one immutable, generation-stamped snapshot.
10. Publishes only if the scan's captured mutation epoch is still current.

Directory absence is observed separately from Git registration so BibCode can
distinguish a stale registered worktree from an externally removed Git row.

### Refresh triggers

A refresh is requested:

- when the first subscriber attaches;
- after client focus returns;
- after explicit user refresh;
- after BibCode creates or removes a worktree;
- when the shallow poll signature of the common Git worktree metadata changes;
- when availability of a previously known worktree path changes.

The server poller observes only shallow Git administrative metadata and
`stat` information for known worktree paths. It does not recursively inspect
repository files, worktree contents, or Git objects. Cheap signature polls
run frequently enough to meet the five-second discovery target; an actual Git
subprocess runs only after a signature change, explicit refresh, mutation, or
initial subscription.

### Coalescing, backpressure, and stale scans

- Concurrent refresh requests for the same project view share one in-flight
  result, including the same explicit conflict error. Project views for the
  same repository may share only the underlying repository observation.
- A short result TTL absorbs renderer/query fan-out without masking explicit
  invalidation.
- Each create/remove mutation increments `mutationEpoch` before invalidating
  the catalog.
- A pre-mutation scan may finish but cannot publish over the newer epoch.
- A stale pre-mutation leader records and advances one explicit stale result;
  every caller already coalesced behind it receives that identical result and
  no waiter silently starts a divergent refresh.
- Mutation invalidation atomically advances `mutationEpoch`, overwrites one
  pending mutation-refresh epoch, and starts at most one lifecycle-owned worker
  for the project view. The worker queued behind a stale leader recognizes only
  that stored stale completion and performs a scan against the current epoch.
  Invalidations captured before its refresh fence coalesce into that scan; an
  invalidation arriving during recovery leaves a newer pending epoch and causes
  at most the next serialized scan after an async yield. When mutations stop,
  the worker clears its slot without a lost wake. Final active-user release atomically
  clears the pending epoch, cancels the worker token, and aborts the worker
  task. Even a non-cancellation-aware dependency await therefore releases the
  project refresh lock, and a later lifecycle cannot inherit the old task or
  result.
- The stream uses latest-value semantics. Slow subscribers receive the newest
  snapshot rather than an unbounded queue of intermediate refreshes.
- Shared observations outlive one project-view cancellation while subscribers
  to another view still need them. After a caller wins the repository
  single-flight lock, the guard and observation run as repository-lifecycle
  work; the project view awaits that result with its own cancellation. A
  detached leader therefore releases its project refresh lock immediately,
  while an alias or reattached view may coalesce only with the same live
  repository lifecycle and exact anchor. This never carries the old
  project-view worker or result into the new lifecycle. Subscription ownership
  uses a guarded RAII reservation, so abort at any attachment await point
  releases both view and repository counts. Poll sleep, shallow signatures,
  Git inventory, directory probes, and the mutation-recovery worker are
  cancellation-aware; the associated pending work stops without later
  publication when the final active user leaves.
- Directory probes and bulk adoption use bounded concurrency.

### Failure behavior

Git failure, timeout, malformed output, output truncation, missing scan anchor,
or environment loss updates only `scanStatus`. The last authoritative
worktree set and last proven availability remain intact. Absence from a
fallback or degraded scan never creates a missing transition and never tears
down workspace state.

After repeated failures the catalog backs off expensive Git retries while
retaining explicit refresh and cheap recovery detection. A successful scan
clears degradation automatically.

Create/remove RPCs invalidate the catalog and request an immediate bounded
refresh. A successful Git mutation is not reclassified as failed merely
because this subsequent observational refresh fails; degradation is reported
through the catalog stream.

## RPC and Compatibility

Add typed RPC contracts equivalent to:

```text
subscribeWorktreeCatalog { projectId }
vcs.refreshWorktreeCatalog { projectId }
worktree.updateDiscoveryPolicy { commandId, projectId, generation/presentation intent }
worktree.createManaged { commandId, projectId, threadId, ref intent, thread defaults }
worktree.createPanel { commandId, hostThreadId, threadId, title, thread defaults }
worktree.retarget { commandId, projectId, threadId, worktreeKey, expectedGeneration }
worktree.adopt { projectId, worktreeKey, generation, thread defaults }
worktree.getRemovalPlan { projectId, threadId }
worktree.removeFromBibCode { projectId, threadId }
worktree.remove { projectId, threadId, mode, confirmations, expected generation, plan token }
```

Their responsibilities remain separate: catalog observation/policy, managed
creation, host-derived panel creation, opaque catalog retargeting, adoption,
detach-only removal, and optional verified Git removal.

Clients send persisted IDs, ref intent where creation requires it, opaque
worktree identity, and generation. The server resolves project roots, host
metadata, checkout paths, and registered paths; the browser never supplies a
worktree root, retarget path, or destructive target path. Public
`vcs.removeWorktree` and `vcs.createWorktree` are absent. A private
managed-creation rollback carries the exact checkout path and actual branch
reported as newly created by Git, including automatic suffixes, and may remove
only that state if owner persistence fails. PR worktree creation uses
`worktree.createManaged`; `git.preparePullRequestThread` accepts only local mode.

Generic HTTP and WebSocket orchestration dispatch use the same public decoder.
They reject discovery policy, explicit worktree kind/path, bootstrap cwd/path,
metadata worktree-path retargeting, adopted-owner deletion, and project deletion
while adopted owners remain. Internal resolved variants are also rejected.
Ordinary non-worktree commands remain available, with permitted kind and
project working-directory context derived by the server. The engine repeats
these owner and deletion constraints as defense in depth.

Execution-environment capabilities gain optional `worktreeCatalog`, decoding
to `false`. A newer client connected to an older server:

- does not call the new RPC methods;
- keeps existing adopted workspace threads functional;
- omits discovery controls for that environment;
- does not interpret the unsupported environment as an authoritative empty
  catalog;
- offers only a confirmed legacy detach through ordinary thread deletion,
  leaving Git and files untouched and never calling a raw destructive method;
- may still show discovery rows from newer sibling environments in a grouped
  project.

Capability selection covers subscriptions plus every direct, bulk, archived,
creation, retarget, adoption, policy, planning, detach, and destructive-removal
entry point. It is read from the negotiated session and the request uses that
same session, preventing a reconnect from racing capability and transport.

Catalog reads use the existing orchestration/VCS read authority. Adoption and
removal require the corresponding orchestration write authority. Destructive
Git removal retains the existing protected VCS mutation boundary.

## Candidate Derivation and Sidebar UX

A discovered worktree is eligible for adoption when it:

- is registered and its directory is present;
- is not primary or bare;
- belongs to the project's canonical common Git directory;
- has no non-deleted canonical workspace thread with the same physical path.

An archived canonical workspace thread still counts as adopted. A matching
archived thread yields a restore action instead of a second thread. Panel
threads do not count as canonical adoption records.

### Initial discovery

On the first authoritative snapshot containing eligible external worktrees:

- the project remains in default `hidden` mode;
- an expanded discovery card appears above the primary row;
- candidates are grouped by environment and parent directory;
- each candidate shows its branch, or detached short SHA, and full path;
- the user may add one, add all, or keep the candidates hidden.

`Keep hidden` acknowledges the current normalized paths and collapses the
surface to `Hiding N discovered worktrees`. A later candidate outside the
baseline can expand the inbox again. The project menu always offers
`Show hidden worktrees` or its inverse.

`Show in worktree list` renders candidates as clearly marked discovered rows.
It does not silently persist workspace threads. Selecting one or choosing
`Add to BibCode` performs adoption.

Grouped logical projects group candidates first by environment and then by
parent directory. Bulk actions retain environment boundaries and report
partial results per candidate.

## Managed and Derived Owner Workflows

Managed worktree creation is one idempotent server application operation. The
request carries project/ref intent and thread defaults, not `cwd`, kind, or
path. Under catalog mutation locks the server resolves the project root, lets
the Git owner choose the managed checkout path, then persists the ordinary
workspace owner. Once Git succeeds, caller cancellation cannot split Git from
the owner transaction. If persistence fails, private rollback re-verifies the
exact created registration and rejects primary/bare substitution before removal.

A panel request identifies its persisted host, and the server derives panel
kind, project, branch, and worktree path under the same authority boundary. A
retarget request identifies a catalog candidate by opaque key and exact
generation; the server refreshes/revalidates repository membership, presence,
eligibility, and exclusive ownership before changing the thread. Raw generic
thread creation or metadata update cannot express either operation.

## Adoption Workflow

Adoption is an idempotent server application command serialized per physical
project:

1. Resolve the current catalog by project.
2. Validate the supplied opaque key and generation.
3. Refresh before proceeding when the generation is stale.
4. Revalidate presence, eligibility, and common-Git membership.
5. Check active and archived non-panel threads using server path semantics.
6. Return an existing active thread when already adopted.
7. Unarchive and return a matching archived canonical workspace.
8. Otherwise create the same normal `kind: "workspace"` thread used by a
   BibCode-created worktree, populated with the current branch and path.
9. Update the discovery baseline in the same durable transaction.
10. Return `{ threadId, disposition: created | existing | restored }`.

Two clients racing to adopt the same worktree converge on one canonical
workspace thread. The second command returns the winner rather than failing or
creating a duplicate.

Adding one opens the resulting workspace. `Add all` uses bounded concurrency
per environment, keeps the current route, and reports each failure without
rolling back independent successful adoptions.

Adoption never calls `git worktree add` and does not automatically execute
`runOnWorktreeCreate`. Existing project scripts remain manually available.

### Capability parity

After the thread exists, downstream features do not branch on worktree
provenance:

- providers launch with the adopted worktree context;
- Git status and actions use the checkout;
- terminals and scripts use the checkout as their working directory;
- file, diff, review, editor, and panel operations use the existing workspace
  context;
- pinning, unread state, title changes, archiving, and panel threads behave as
  they do for BibCode-created worktrees;
- local desktop-only operations remain restricted to the local environment.

The catalog is authoritative for a present worktree's current branch.
`thread.branch` remains a last-known durable value for offline shells. An
actual external branch change produces one idempotent system metadata update
so orchestration, provider launches, and presentation converge without
writing an event for unchanged scans.

## Adopted Workspace Availability

Client-runtime joins non-deleted workspace threads with the latest
authoritative catalog and derives:

| State | Meaning |
| --- | --- |
| `present` | Registration and directory both exist |
| `verification-unavailable` | Current observation is degraded; prior authoritative state is retained |
| `missing-registered` | Git still registers the worktree, but its directory is absent |
| `missing-unregistered` | The adopted path is absent from an authoritative Git listing |
| `removing` | An idempotent detach or deletion operation owns the workspace guard |

A failed scan never transitions a workspace into either missing state.

Client-runtime exports one presentation selector used by every surface. A
cold/no-status workspace, `present`, and retained
`verification-unavailable` remain usable because none authoritatively proves
absence. Only `missing-registered`, `missing-unregistered`, and `removing`
disable workspace actions. Sidebar and chat/panel flows do not implement
separate interpretations.

### Missing warning row

A proven-missing worktree remains in the normal project location as a warning
row. It is disabled for workspace-dependent operations but remains selectable
so the user can inspect conversation history and recovery actions.

The row displays:

- last known branch and full path;
- whether Git registration remains;
- lock reason when present;
- retry detection;
- remove from BibCode;
- optional stale-registration cleanup.

New agent turns, terminals, Git actions, scripts, and file operations fail with
a structured `WorkspaceUnavailableError`, not a generic process or path error.

Server filesystem file, browse, search, asset, review, and mutation RPCs retain
one physical-path admission lease for the complete operation. Mutations enter a
finalization fence before their filesystem or durable commit. Authoritative
loss/removal either closes admission first or waits for the admitted operation
and its finalization to finish; a paused write/delete cannot outlive guard
publication.

### Runtime loss reconciliation

When an authoritative transition proves a previously present adopted
workspace missing, the server:

1. installs a workspace-unavailable guard before any teardown;
2. rejects new activity;
3. requests bounded graceful shutdown of provider sessions and terminals;
4. force-terminates processes that exceed existing supervision limits;
5. preserves conversation and terminal history;
6. marks interrupted work with an actionable workspace-missing reason.

Repeated refreshes and concurrent subscribers share one teardown request per
workspace transition. A degraded scan performs no teardown.

If the same physical path returns as a registered worktree in the same
repository, the guard clears and the existing workspace becomes usable. No
new adoption is required. A differently located worktree is never guessed to
be the same workspace.

## Removal Semantics

### Present worktree

The user must choose:

1. **Remove from BibCode** permanently deletes the canonical workspace thread,
   conversation history, and dependent panel threads while leaving Git and
   files untouched.
2. **Delete Git worktree and remove from BibCode** quiesces activity, performs
   verified Git removal, and then removes BibCode metadata.
3. **Cancel** performs no mutation.

Destructive preflight verifies the exact fresh registered record, common-Git
membership, non-primary/non-bare eligibility, lock state, tracked changes, and
untracked files. Dirty deletion requires a second explicit force
confirmation. The checked-out local branch is preserved by default.

### Missing worktree

The recovery dialog offers:

- **Remove from BibCode**, which is always available and never requires the
  directory or registration;
- **Clean stale Git registration and remove from BibCode**, when a stale
  unlocked registration exists;
- retry detection or cancel.

Removing from BibCode is not blocked by optional Git cleanup failure. The
operation returns a partial outcome when BibCode removal succeeds but Git
cleanup does not, and the UI explains the remaining manual Git issue.

Runtime teardown is bounded as well. Once the unavailable/removing guard is
installed, a provider or terminal process that cannot be confirmed stopped is
handed to the server's supervised orphan cleanup and reported separately; it
does not retain the sidebar row or prevent the durable detach transaction.

A locked stale registration is never pruned automatically. The lock reason is
shown while detach-only removal remains available. An adopted path absent
from Git is never recursively deleted even if an unrelated directory has been
created at the old location.

### Stale Git registration cleanup

Cleanup follows this order:

1. Attempt targeted `git worktree remove --force -- <registered-path>` using a
   path re-read from the fresh catalog.
2. Strictly list worktrees and verify that the exact registration disappeared.
3. If Git requires repository-wide prune, run
   `git worktree prune --dry-run --verbose --expire now` first.
4. If the dry run affects other registrations, show every exact path and prune
   reason and require explicit confirmation before `git worktree prune
   --expire now`. Bind that confirmation to the sorted path-plus-reason impact
   so either kind of drift invalidates it.
5. Strictly verify the target registration again.

Git command success without verification is insufficient. Git administrative
directories are never manually deleted, and locked registrations fail
closed.

### Idempotent removal state machine

Removal runs as a retry-safe application operation:

1. Claim the command and acquire a finite cleanup-lifetime slot before any
   reservation, guard, quiesce, Git, or detach effect.
2. Reserve the exact durable request, acquire project/repository/physical-owner
   locks, and install the workspace `removing` guard.
3. Quiesce sessions and terminals while retaining the cleanup slot and guard.
4. Re-resolve the physical target and trusted repository anchor, then perform
   and verify the requested Git mutation, if any.
5. Atomically delete the workspace thread/panels, update the discovery baseline,
   and record immutable result metadata.
6. Invalidate and refresh every affected catalog view.

For present destructive removal, a Git failure before verification keeps the
thread and returns it to `present` or its newly observed state. Detach-only
removal does not depend on Git.

If the server crashes after Git removal and before thread deletion, restart
reconciliation produces a missing warning row. The user can safely repeat
detach or cleanup. Command IDs make retries idempotent.

Client cancellation, WebSocket interrupt, or socket closure may win before the
engine-envelope handoff. After handoff, a server-owned operation retains the
command claim, project/repository/physical-owner locks, cleanup slot,
reservation, `Removing` guard, quiesce ownership, and any rollback duty until a
durable terminal result exists. Canceling the caller wait cannot expose the
workspace or permit a stale overlapping mutation. Runtime shutdown drains these
operation owners before catalog/provider/terminal teardown.

Admission is a named global non-waiting semaphore bound of 64 server-owned
operation lifetimes. Saturation and closed shutdown admission return structured
`WorktreeOperationError` reasons; the accepted task owns the permit through its
terminal result, and shutdown closes admission before draining all tasks. No
unbounded waiter queue is created.

Dependent panel threads follow the existing teardown path. An unexpected
second canonical thread sharing the path produces an explicit conflict rather
than an arbitrary delete choice.

## Package Ownership

### `packages/contracts`

- Worktree descriptor, catalog snapshot, scan status, discovery policy,
  commands, results, and structured errors.
- Optional `worktreeCatalog` environment capability.
- Optional project fields with backward-compatible decode defaults.
- Wire fixtures for new unary/stream shapes.
- No path normalization, candidate policy, or runtime logic.

### `apps/server`

- `git`: porcelain parser, common-directory resolution, path normalization,
  bounded probes, destructive preflight, and verified Git removal.
- catalog service: registry, signatures, polling, caching, coalescing,
  generations, subscriptions, and scan health.
- production RPC: authorization, project lookup, streams, and command routing.
- orchestration: discovery-policy events and idempotent adoption/detach/remove
  application commands.
- runtime-owned worktree operations: pre-handoff cancellation, post-handoff
  resource retention, shutdown drain, and private exact managed-create rollback.
- provider/terminal supervision: unavailable guard and bounded teardown.

### `packages/client-runtime`

Add a focused `state/worktrees` boundary owning:

- catalog subscription atoms keyed by scoped project;
- capability/version gating;
- last-authoritative retention;
- candidate derivation;
- joins between project policy, thread adoption, and catalog availability;
- add-one/add-all and removal application operations;
- negotiated-session capability policy and one shared availability selector;
- a presentation-neutral sidebar workspace-row model.

### `apps/web`

- discovery card, grouping, menus, and candidate rows;
- add-one/add-all progress and partial-failure reporting;
- warning rows and recovery screen;
- detach/delete/force/prune confirmation dialogs;
- workspace-action disabling based on the client-runtime row model.

React does not own Git reconciliation or path identity.

### `apps/desktop`

No Git or catalog ownership changes. The desktop bridge continues to provide
native file-manager behavior only for local environment paths.

## Security and Trust Boundaries

- Catalog and mutation inputs resolve a persisted `projectId`; clients cannot
  nominate an arbitrary discovery root.
- Adoption and deletion use opaque worktree keys and expected generations,
  not client-provided filesystem targets.
- Managed creation, panel creation, and retargeting use dedicated
  server-resolved inputs; generic orchestration cannot set worktree policy,
  kind, path, bootstrap root, or retarget path.
- Generic thread deletion rejects an adopted owner, and generic project
  deletion rejects a project containing adopted owners, so availability rows
  and physical guards cannot be orphaned outside the exact detach transaction.
- Public raw-path worktree creation and removal are absent; private creation
  rollback proves the exact just-created registered nonprimary target and the
  actual newly created branch, including automatic suffixes.
- Immediately before mutation, the server re-reads the worktree registration
  and common Git directory from authoritative state.
- Primary and bare worktrees are never adoption or removal targets.
- Present paths are canonicalized only after registration is proven; missing
  identity uses the canonical nearest existing ancestor plus normalized suffix.
- Windows drive and UNC identities use native invariant uppercase mapping
  compatible with Windows ordinal caseless comparison, including non-ASCII and
  sigma/final-sigma folds.
- Missing/unregistered paths are never recursively deleted.
- Path arguments are passed through the process API after `--`, without shell
  interpolation.
- Symlink/canonicalization changes, repository mismatch, stale generation, and
  replacement-directory conflicts fail closed.
- Output and record limits are bounded; truncation makes the scan
  non-authoritative.
- Desktop-native actions remain behind `DesktopBridge`; remote worktrees use
  server RPC only.

## Performance and Reliability Constraints

- At most one active catalog scan per repository.
- A small global semaphore bounds scans across repositories.
- Directory probes use bounded concurrency and timeouts.
- Shallow metadata signatures avoid recursive filesystem observation.
- Actual Git scans occur on signature changes, explicit requests, mutations,
  and initial subscription rather than every poll tick.
- Stream publication is latest-value and bounded.
- Catalog subscriptions and unary consumers share counted active-user
  lifetimes; final release schedules pointer-checked 60-second eviction.
- Catalog cache entries and warnings have bounded retention.
- Add-all and missing-runtime teardown are coalesced/bounded.
- Post-handoff worktree operations are runtime-owned, admitted by one named
  non-waiting global bound of 64, and drained at shutdown. Structured saturation
  never creates an unbounded wait queue.
- Stale scan results cannot overwrite a later mutation epoch.
- Non-authoritative results cannot remove or teardown workspaces.

## Migration and Rollout

- Existing project records decode to hidden/pending/empty discovery policy; no
  eager rewrite is required.
- Existing project records decode with a null repository-identity pin. The
  first trusted primary-checkout scan establishes it; it then persists across
  server restarts and project-projection rewind/replay, and fences every
  fallback anchor. Migration 42 backfills any migration-41 projection pin into
  the dedicated durable identity table.
- Existing worktree threads are matched to catalog entries by server path
  semantics.
- Existing missing worktree threads become warning rows only after an
  authoritative scan.
- Worktrees orphaned by an earlier create-thread failure become discovery
  candidates.
- New clients capability-gate every catalog subscription and command against
  the same negotiated session used for the request. Older servers receive no
  new-method call; their only fallback is explicit detach-only ordinary thread
  deletion, which leaves Git and files untouched.
- The catalog cache is rebuilt on restart; only the repository identity fence,
  not a live catalog snapshot, is persisted.
- No vendored dependency or production Node runtime is introduced.

## Observability

Structured server diagnostics record:

- project/repository identity safe for logs;
- scan generation and captured mutation epoch;
- scan duration and descriptor count;
- coalesced caller count;
- trigger and failure class;
- authoritative versus degraded outcome;
- missing/recovered transition counts;
- teardown and cleanup outcome.

Normal log levels do not emit full filesystem paths. Repeated watcher and scan
warnings are deduplicated and bounded.

## Testing Strategy

### Contracts

- Encode/decode catalog, commands, events, errors, and stream items.
- Regenerate Rust wire fixtures.
- Prove missing optional project policy and capability fields decode safely.
- Prove older-server feature gating.

### Rust unit tests

- NUL-delimited and legacy porcelain parsing.
- Whitespace, quoted paths, newline-capable records, Windows separators,
  drive/UNC non-ASCII comparison, and POSIX case sensitivity.
- Primary, bare, detached, unborn, locked, lock reason, and prunable records.
- Malformed and truncated scans remain non-authoritative.
- Directory probe `NotFound`, permission, timeout, and bounded concurrency.
- Present symlink/macOS aliases, missing nearest-ancestor aliases, physical path
  equality, and replacement conflict detection.
- Catalog coalescing, global limits, generation fencing, mutation epochs,
  backpressure, subscription/unary cancellation, pointer-checked idle eviction,
  and degraded recovery.
- Candidate validation and common-Git membership.
- Verified targeted removal and prune dry-run handling.

### Rust integration tests with real temporary repositories

- Discover an externally created linked worktree after subscription.
- Detect a directory deleted outside Git as missing-registered.
- Detect an externally removed/pruned registration as missing-unregistered.
- Retain catalog and threads on scan failure or missing anchor.
- Recover when the same path is registered again.
- Refuse primary, bare, locked, dirty, replacement, and repository-mismatch
  destructive targets as specified.
- Require explicit force for dirty deletion.
- Preserve the branch after worktree removal.
- Converge simultaneous adoption commands on one thread.
- Reject every generic raw policy/kind/path/bootstrap/retarget/delete bypass and
  prove dedicated managed-create/panel/retarget flows.
- Retain post-handoff lifecycle ownership across WebSocket interrupt and socket
  closure; permit pre-handoff cancellation.
- Hold filesystem leases/finalization through paused read/write/delete versus
  authoritative loss or `Removing`.
- Plan and execute removal through a pinned trusted fallback anchor when the
  primary checkout is missing.
- Restore a matching archived thread.
- Complete detach-only removal when Git cleanup fails.
- Recover from the crash boundary after Git removal but before thread deletion.
- Stop existing runtime activity once for an authoritative missing transition
  and never for degraded observation.

### Client-runtime tests

- Derive candidates against active, archived, panel, and deleted threads.
- Maintain hidden/shown policy and new-path baseline behavior.
- Retain last-authoritative data through degraded refreshes.
- Join present, verification-unavailable, both missing states, and recovery.
- Keep grouped environments isolated.
- Handle mixed server capabilities and disconnected environments without any
  new-method call when capability is false; legacy fallback remains detach-only.
- Apply one cold/present/degraded/missing/removing availability selector across
  every presentation surface.
- Report add-all partial failures without rolling back successes.

### Web tests

- Initial expanded discovery card, collapsed hidden card, and project menu.
- Parent-directory and environment grouping.
- Add one, add all, existing, restored, stale generation, and partial failure.
- Persistent missing warning and recovery view.
- Composer, terminal, Git, file, and script guards.
- Detach versus destructive deletion choice.
- Dirty force confirmation, locked explanation, and prune dry-run disclosure.
- Guaranteed row removal when the directory is absent.
- Existing workspace-row behaviors remain unchanged after adoption.

### Repository validation

Implementation completion requires focused tests for every changed behavior,
broader cross-package and RPC checks, and the repository gates:

- `vp check`
- `vp run typecheck`
- relevant `vp test` and workspace package-script tests
- `cargo fmt --all --check`
- relevant Rust tests
- Clippy for affected Rust targets with warnings denied
- final `git diff` and `git status --short` review

## Acceptance Criteria

1. An external worktree appears within five seconds while its project catalog
   is subscribed, or immediately after focus/manual refresh.
2. Newly discovered worktrees are hidden by default and always recoverable
   through the discovery card or project menu.
3. Adoption performs no Git creation mutation and produces exactly one normal
   workspace thread.
4. An adopted external worktree supports the same agent, terminal, Git, file,
   panel, script, and navigation behavior as a BibCode-created worktree.
5. An authoritative directory loss creates a persistent warning row instead
   of silently deleting the thread.
6. Git failure, environment disconnection, malformed output, or timeout never
   produces a false missing transition or teardown.
7. `Remove from BibCode` succeeds when the directory and registration are
   absent and when optional Git cleanup fails.
8. The user explicitly chooses detach-only versus destructive removal for a
   present worktree.
9. Re-registering the same path in the same repository restores the existing
   workspace automatically.
10. Destructive removal never targets a primary, bare, locked, unregistered
    replacement, repository-mismatched, or unconfirmed dirty worktree.
11. Concurrent scans, mutations, adoption requests, and slow subscribers
    remain bounded and converge predictably.
12. Dedicated server-resolved APIs are the only public path for worktree
    policy, creation, panel derivation, retarget, adoption, detach, and
    destructive removal; generic/raw bypasses fail closed.
13. Pre-handoff cancellation may win, while post-handoff worktree lifecycle
    ownership survives interrupt/socket closure through a durable terminal
    result.
14. Present and missing aliases share one physical identity, and every
    filesystem operation retains admission/finalization for its complete
    lifetime.
15. A false/missing catalog capability makes no new-method call, and every UI
    uses the shared availability decision for cold, degraded, missing, and
    removing states.

## Required Living Documentation During Implementation

Because this feature changes protocol flow, project metadata, runtime
lifecycle, and documented sidebar behavior, implementation must update:

- `docs/user/workspace-ui.md`
- `docs/architecture/rpc-and-orchestration.md`
- `docs/architecture/connection-runtime.md`
- a dedicated living Worktree Catalog architecture document linked from
  `docs/README.md`
