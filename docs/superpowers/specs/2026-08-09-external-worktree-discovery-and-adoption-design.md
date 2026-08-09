# External Worktree Discovery and Adoption Design

**Date:** 2026-08-09

**Status:** Approved.

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

BibCode currently represents every visible workspace row as an orchestration
thread:

- a project's `kind: "default"` thread is its primary checkout row;
- another non-panel thread with `worktreePath` is a worktree workspace row;
- creating a worktree performs `vcs.createWorktree` and then `thread.create`;
- deletion currently attempts Git worktree removal before deleting the final
  canonical thread for that path.

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
| Current scan health, cache, generations, and subscribers | In-memory Worktree Catalog runtime |

The design does not persist a duplicate live worktree list. Catalog state is
rebuilt from Git after server restart.

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
normalized path and is opaque to clients. It is not treated as stable across
an external move.

Path comparison is server-only:

- Windows drive and UNC paths are separator-normalized and compared
  case-insensitively.
- POSIX paths are separator-normalized and remain case-sensitive.
- Present paths are canonicalized after registration has been established.
- Missing paths use normalized Git output because canonicalization is
  impossible.
- Branch or HEAD similarity never establishes path identity.

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

## Worktree Catalog Service

### Registry and ownership

`apps/server` owns a shared catalog registry keyed by the canonical Git common
directory. Projects opened through the primary checkout or a linked worktree
share one catalog entry on the same execution host.

Each entry retains only bounded runtime state:

```text
lastAuthoritativeSnapshot
scanStatus
generation
mutationEpoch
inFlightScan
subscriberCount
pollerCancellation
lastMetadataSignature
```

Unsubscribed entries stop polling and are evicted after a bounded idle
retention window. A global semaphore bounds simultaneous Git catalog scans,
and each repository admits only one scan at a time.

### Scan anchor resolution

The service selects a trustworthy Git command working directory in this
order:

1. the persisted project primary checkout;
2. any present adopted worktree for that project;
3. a common Git directory resolved earlier in the current server lifetime.

If no anchor is reachable, the catalog becomes degraded. It does not publish
an authoritative empty set.

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

- Concurrent refresh requests for the same catalog share one in-flight scan.
- A short result TTL absorbs renderer/query fan-out without masking explicit
  invalidation.
- Each create/remove mutation increments `mutationEpoch` before invalidating
  the catalog.
- A pre-mutation scan may finish but cannot publish over the newer epoch.
- The stream uses latest-value semantics. Slow subscribers receive the newest
  snapshot rather than an unbounded queue of intermediate refreshes.
- Shared scans outlive one caller cancellation while other subscribers still
  need them. The poller and pending work stop when the final subscriber leaves.
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
worktree.adopt { projectId, worktreeKey, generation, thread defaults }
worktree.removeFromBibCode { projectId, threadId }
worktree.remove { projectId, threadId, mode, force, expected generation }
```

The exact final names must follow the repository's method naming conventions,
but their responsibilities remain separate: catalog observation, adoption,
detach-only removal, and optional Git removal.

Clients send `projectId`, opaque worktree identity, and generation. The server
resolves project roots and registered paths; the browser never supplies a
destructive target path.

Execution-environment capabilities gain optional `worktreeCatalog`, decoding
to `false`. A newer client connected to an older server:

- does not call the new RPC methods;
- keeps existing adopted workspace threads functional;
- omits discovery controls for that environment;
- does not interpret the unsupported environment as an authoritative empty
  catalog;
- may still show discovery rows from newer sibling environments in a grouped
  project.

Catalog reads use the existing orchestration/VCS read authority. Adoption and
removal require the corresponding orchestration write authority. Destructive
Git removal retains the existing protected VCS mutation boundary.

## Candidate Derivation and Sidebar UX

A discovered worktree is eligible for adoption when it:

- is registered and its directory is present;
- is not primary or bare;
- belongs to the project's canonical common Git directory;
- has no non-deleted canonical workspace thread with the same normalized path.

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

If the same normalized path returns as a registered worktree in the same
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
4. If the dry run affects other registrations, show those effects and require
   explicit confirmation before `git worktree prune --expire now`.
5. Strictly verify the target registration again.

Git command success without verification is insufficient. Git administrative
directories are never manually deleted, and locked registrations fail
closed.

### Idempotent removal state machine

Removal runs as a retry-safe application operation:

1. Acquire the workspace `removing` guard and reject new activity.
2. Quiesce sessions and terminals.
3. Perform and verify the requested Git mutation, if any.
4. Atomically delete the workspace thread and update the discovery baseline.
5. Invalidate and refresh the catalog.

For present destructive removal, a Git failure before verification keeps the
thread and returns it to `present` or its newly observed state. Detach-only
removal does not depend on Git.

If the server crashes after Git removal and before thread deletion, restart
reconciliation produces a missing warning row. The user can safely repeat
detach or cleanup. Command IDs make retries idempotent.

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
- provider/terminal supervision: unavailable guard and bounded teardown.

### `packages/client-runtime`

Add a focused `state/worktrees` boundary owning:

- catalog subscription atoms keyed by scoped project;
- capability/version gating;
- last-authoritative retention;
- candidate derivation;
- joins between project policy, thread adoption, and catalog availability;
- add-one/add-all and removal application operations;
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
- Immediately before mutation, the server re-reads the worktree registration
  and common Git directory from authoritative state.
- Primary and bare worktrees are never adoption or removal targets.
- Present paths are canonicalized only after registration is proven.
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
- Catalog cache entries and warnings have bounded retention.
- Add-all and missing-runtime teardown are coalesced/bounded.
- Stale scan results cannot overwrite a later mutation epoch.
- Non-authoritative results cannot remove or teardown workspaces.

## Migration and Rollout

- Existing project records decode to hidden/pending/empty discovery policy; no
  eager rewrite is required.
- Existing worktree threads are matched to catalog entries by server path
  semantics.
- Existing missing worktree threads become warning rows only after an
  authoritative scan.
- Worktrees orphaned by an earlier create-thread failure become discovery
  candidates.
- New clients capability-gate older remote servers.
- The catalog is rebuilt on restart and never requires persisted cache
  migration.
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
- Whitespace, quoted paths, newline-capable records, Windows separators, and
  POSIX case sensitivity.
- Primary, bare, detached, unborn, locked, lock reason, and prunable records.
- Malformed and truncated scans remain non-authoritative.
- Directory probe `NotFound`, permission, timeout, and bounded concurrency.
- Normalized path equality and replacement conflict detection.
- Catalog coalescing, global limits, generation fencing, mutation epochs,
  backpressure, cancellation, idle eviction, and degraded recovery.
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
- Handle mixed server capabilities and disconnected environments.
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

## Required Living Documentation During Implementation

Because this feature changes protocol flow, project metadata, runtime
lifecycle, and documented sidebar behavior, implementation must update:

- `docs/user/workspace-ui.md`
- `docs/architecture/rpc-and-orchestration.md`
- `docs/architecture/connection-runtime.md`
- a dedicated living Worktree Catalog architecture document linked from
  `docs/README.md`
