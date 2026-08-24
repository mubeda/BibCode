# VCS Core Coordination Design

**Date:** 2026-08-20

## Outcome

Reduce BiBCode's idle and foreground Git subprocess load without changing the
current VCS wire schema, automatic-fetch behavior, focus/menu freshness, local
file-save latency, or Source Control semantics.

This design covers measurement, read-only Git command reduction, physical
repository fetch ownership, and mutation-safe status coordination. File Manager
indexing, event-driven filesystem observation, passive sidebar summaries, and
worktree-catalog fingerprinting are specified separately.

## Evidence

A live Windows sample recorded 117 `git.exe` processes in approximately 22
seconds, including at least 80 direct `bibcode-desktop` children and 13
concurrent Git processes.

The current implementation multiplies work along three axes:

- each subscribed canonical `cwd` owns a three-second ref poll, a 30-second
  local-status poll, and a 30-second automatic-fetch cycle;
- `local_status` starts approximately seven sequential Git commands, while a
  complete `status` repeats repository, branch, and remote work for a total of
  approximately 10–11 commands; and
- focus, visibility, and Git-menu refreshes share the same serial client lane
  as stage, pull, and stacked commit actions.

The historical behavior that must remain intact is defined by:

- `254aa363`, which restored automatic fetch, dynamic interval updates, and
  `0 = disabled`;
- `9b34f497`, which made `projects.writeFile` publish local status within 750
  ms; and
- `472197f5`, which separated local invalidation from slow remote/ref work.

## Ownership

### Worktree status owner

The Rust server owns one status-observation entry per canonical worktree path.
Each entry contains:

- a checked mutation epoch;
- one server-owned mutation lock shared by every client;
- at most one physical local/full status read;
- independent caller leases;
- one coalesced trailing-refresh request;
- the last usable local and remote snapshot; and
- lifecycle cancellation for final-subscriber release and shutdown.

Client scheduling reduces duplicate requests but is never the correctness
owner. This is required because several browser or desktop clients may issue
requests against the same server.

### Physical repository fetch owner

Automatic fetch is owned by the canonical Git common-directory identity, not by
one checkout path. A repository owner contains:

- the current configured interval;
- one fetch task and its failure backoff;
- the subscribed worktree status entries that share the repository; and
- lifecycle state preventing a prior owner from publishing into a replacement.

Fetch updates shared Git refs. After a successful fetch, every subscribed
worktree performs its own branch-specific remote comparison and PR enrichment.
One worktree's branch, upstream, or PR result is never copied to a sibling.

## Status Read

### Command shape

One internal status observation replaces the duplicated `local_status` plus
`remote_status` sequence.

The observation begins with:

```text
git -c core.quotePath=false status --porcelain=2 --branch --untracked-files=all
```

The porcelain result supplies repository success/failure, current branch,
upstream, ahead/behind counts, staged/unstaged/untracked file state, and the
dirty flag. BiBCode will no longer discard these headers and run a second status
command to reconstruct them.

Staged and unstaged numstats run concurrently and only for areas present in the
porcelain snapshot:

```text
git -c core.quotePath=false diff --cached --numstat
git -c core.quotePath=false diff --numstat
```

Default-ref delta, primary-remote discovery, and source-control-provider
discovery remain separate only when the requested result needs them. Stable
repository metadata may be retained under the physical repository owner, with
invalidation after config/ref changes and fetch. The first implementation must
not introduce a time cache whose invalidation cannot be proven.

Every background read uses `GIT_OPTIONAL_LOCKS=0`. Mutating commands and fetch
do not inherit that read-only environment by accident.

### Result compatibility

The public `VcsStatusResult` and `VcsStatusStreamEvent` shapes remain unchanged.
The implementation preserves:

- staging areas and duplicate paths for partially staged files;
- per-file additions and deletions;
- detached-HEAD representation;
- default-ref and primary-remote state;
- provider terminology and PR enrichment; and
- non-repository and bounded-error behavior.

## Read and Mutation Ordering

A read captures the current mutation epoch before starting. It may publish only
when that epoch still matches after all Git and enrichment work finishes.

Git mutations for one canonical worktree serialize through the server-owned
mutation lock. They do not rely on one renderer's scheduler for mutual
exclusion. Reads do not hold that lock.

When a Git or workspace mutation is admitted for a worktree, the server:

1. acquires the worktree mutation lock and increments the mutation epoch;
2. cancels or retires any pre-mutation status read;
3. runs the mutation without waiting for remote fetch;
4. requests exactly one trailing local refresh for the admitted epoch; and
5. releases the mutation lock after the mutation's terminal local ownership is
   established, whether the mutation succeeds,
   fails after a possible partial Git effect, or the caller disconnects after
   admission.

The mutation set includes workspace writes and Git init, stage, unstage,
discard, ref switch/create, pull, commit, push, and stacked actions. A stale
read cannot overwrite a post-mutation snapshot.

Managed worktree create, retarget, and removal remain owned by the worktree
catalog operation runtime and its existing project/repository lock order. Their
terminal Git/durable settlement notifies the VCS status and physical-repository
fetch owners without moving those operations into the VCS mutation lock. This
preserves both newly supported create-dialog paths: reusing a free local branch
as-is and creating the server-selected suffixed branch when the requested branch
is already occupied.

Caller cancellation releases only that caller's lease. The physical read is
canceled only when its final lease is gone or an authoritative mutation/lifecycle
fence retires it.

## Client Scheduling

The existing mutation serial order per `(environmentId, cwd)` remains. Status
refresh moves to a read lane only after the server mutation epoch is available.

The read lane:

- collapses focus and visibility bursts;
- shares an active refresh;
- retains at most one trailing refresh when a signal may describe a later
  change; and
- never holds a later mutation behind an evidence-free read.

Focus, visibility, and Git-menu triggers remain user-facing freshness features.
They are not deleted. Explicit post-action refreshes remain authoritative and
cannot be satisfied from a pre-mutation result.

## Automatic Fetch

The first rollout preserves the current 30-second default, live settings
updates, `0 = disabled`, and bounded failure backoff. The change is ownership:
one physical repository fetches once per interval regardless of worktree count.

After the repository-scoped implementation is measured for ten minutes on
Windows, the default changes to 180 seconds when either condition remains true:

- more than 20 top-level Git processes per minute per idle physical repository;
  or
- foreground VCS scheduler delay exceeds 250 ms at p95.

The interval change is a separate reviewed commit and updates settings defaults,
tests, user documentation, and any presentation copy together.

## Instrumentation

Measurements distinguish:

- client queue delay;
- RPC handler time;
- subprocess launch, execution, and output-collection time;
- Git operation name;
- canonical worktree and physical repository identities;
- status subscriber/poller count;
- read coalescing and stale-publication rejection; and
- fetch coalescing and fan-out reconciliation.

Paths and identities remain bounded/redacted according to existing diagnostics
policy.

## Success Criteria

- A focus/visibility/menu burst starts at most one physical status observation.
- Stage reaches its mutation command within 250 ms while a background read is
  active.
- Project save still publishes local status within 750 ms.
- A blocked fetch cannot delay local publication.
- A pre-mutation read never publishes after its epoch is retired.
- Automatic fetch count is independent of worktree count.
- A staged-index commit with a supplied message starts no more than five Git
  subprocesses before completion.
- Managed creation still reuses a free local branch when requested and retains
  the existing safe suffixed-branch result for an occupied branch.
- The current status, Source Control, sidebar, fetch-setting, WSL, cancellation,
  and workspace-availability tests remain passing.

## Alternatives Rejected

- **Disable automatic fetch immediately:** regresses an explicitly restored
  BiBCode feature and hides the multiplicative ownership bug.
- **Client-only single-flight:** cannot protect several clients or prevent a
  stale server read from publishing after mutation.
- **Independent read scheduler before server fencing:** improves queue latency
  by introducing a stale-publication race.
- **Settled full-status TTL cache:** can hide an external terminal mutation,
  which is the reason focus refresh exists.
- **One global repository mutex:** lets a slow fetch block the sub-750 ms local
  mutation lane.
