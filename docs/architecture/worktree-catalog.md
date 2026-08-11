# Worktree catalog

The worktree catalog discovers Git worktrees that belong to a persisted project
but do not yet have a BiBCode workspace thread. It also owns the lifecycle of an
adopted worktree when its directory disappears, returns, or is explicitly
removed. The server is authoritative for paths, repository identity, Git
membership, availability, and destructive decisions. Browser and desktop
clients receive opaque keys and display state; neither client is a path or Git
authority.

## Ownership and sources of truth

| Concern                | Owner and durable source                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository identity    | The server resolves `git-common-dir`; a successful authoritative scan establishes the project's durable compare-and-set repository pin. Generic project metadata writes cannot create or replace the pin. |
| Current Git membership | A bounded server inventory of `git worktree list --porcelain -z` plus known-path probes. The repository observation is shared by projects that have the same verified common directory.                   |
| Discovery preference   | The complete `ProjectWorktreeDiscoveryPolicy` persisted in project metadata: `hidden` or `shown`, prompt acknowledgement, and a capped baseline of known paths.                                           |
| Workspace ownership    | Orchestration projections and immutable thread events. A catalog snapshot joins them to the current inventory on the server.                                                                              |
| Availability           | The shared `WorkspaceAvailabilityRegistry`, indexed by workspace identity and normalized host path. All filesystem-backed services use the same admission guard.                                          |
| Mutation arbitration   | Durable orchestration command receipts plus a process-local command claim, then the stable project lock and optional repository lock.                                                                     |

`packages/contracts` defines only the schemas and wire contracts. Runtime policy
lives in the server catalog, orchestration, and availability services; React
does not reproduce it.

## Identity and trust

Clients address candidates by project ID, opaque worktree key, and catalog
generation. Adoption and removal requests never carry a checkout path. The
server normalizes host paths, verifies Git membership, resolves repository
identity, and looks up the persisted workspace path before acting.

The first authoritative scan through the configured primary checkout is the
only operation that may establish the durable repository pin. Once pinned, a
fallback anchor is accepted only when it resolves to that same identity. Anchor
selection prefers the configured primary checkout, then a present adopted
worktree, then a previously verified common directory retained for the service
lifetime. A different repository at a reused path cannot replace the pin.

The pin survives database restart and projection replay. This separates durable
repository trust from mutable project metadata and prevents a temporarily
missing primary checkout from transferring authority to an unrelated
repository.

## Observation and catalog snapshots

One repository observation is shared by every subscribed project with the same
verified repository identity. Each project still receives its own joined view:
eligible external worktrees, adopted workspaces, discovery policy, generation,
observation time, authority flag, and scan health.

The production bounds are intentionally finite:

| Resource                      | Bound                |
| ----------------------------- | -------------------- |
| Concurrent repository scans   | 4                    |
| Concurrent known-path probes  | 8                    |
| Individual probe timeout      | 1 second             |
| Active polling interval       | 2 seconds            |
| Result reuse window           | 1 second             |
| Idle repository-view eviction | 60 seconds           |
| Failed-scan retry backoff     | up to 30 seconds     |
| Discovery baseline            | 512 normalized paths |

The subscription is latest-value state, not an event queue: a slow consumer may
skip intermediate generations but receives the newest snapshot. The final
subscriber cancels in-flight work, stops polling, and permits idle eviction.
Explicit refresh participates in the same single-flight, bounded observation.

Only a definite not-found result marks a known workspace missing. Permission
errors, timeouts, canceled probes, and Git failures do not manufacture absence.
After an authoritative result, a failed scan retains the last authoritative
candidate and adopted-workspace arrays and reports degraded scan health. The
snapshot fields `generation`, `observedAt`, `authoritative`, `scanStatus`, and
degraded details let clients distinguish stale-but-useful state from a fresh
authoritative observation.

## Discovery policy and adoption

New projects default to hidden discovery. An authoritative generation may be
acknowledged as hidden, switched to shown, or compacted after adoption. The
server derives and caps the baseline from that exact snapshot; clients do not
submit paths. Incremental project metadata events omit the policy when it did
not change, so unrelated updates and event replay preserve the complete stored
policy.

Adoption accepts a project ID, opaque worktree key, expected generation,
command ID, and ordinary thread defaults. The handler:

1. claims and digests the public command before resolving catalog data;
2. acquires the stable project lock and then the optional repository lock;
3. refreshes a stale or non-authoritative generation and revalidates current
   membership, repository identity, eligibility, presence, and ownership;
4. creates one ordinary workspace, restores the archived owner, or returns the
   existing owner; and
5. records the immutable result and discovery-policy compaction in the same
   orchestration transaction.

Adoption is read-only with respect to Git. It does not create or repair a Git
worktree, and it does not run the project's worktree-creation script.
Concurrent matching adoption requests converge on one canonical thread.

Accepted retries replay the immutable `created`, `existing`, or `restored`
result. Modern receipts must contain consistent result metadata. The accepted
legacy exception is deliberately narrow: a metadata-free receipt may prove
`created` or `restored` only from its matching immutable thread event. It cannot
reconstruct `existing` from mutable projections and otherwise fails closed.

Discovery-policy mutation uses the same command-claim, project-lock, and
repository-lock order. Once a command crosses the engine-envelope handoff, RPC
cancellation no longer releases its locks or claim; they remain until a
terminal receipt prevents a following mutation from committing stale policy.
A digest-free accepted legacy policy receipt replays only when the exact
project, terminal sequence, sole policy event, and complete payload prove the
operation. Reserved or prepared legacy receipts resume through normal
aggregate-checked recovery.

## Availability, panels, and recovery

Adopted workspaces can be `present`, `verification-unavailable`,
`missing-registered`, `missing-unregistered`, or `removing`. Every filesystem-
backed RPC consults the shared server availability registry before starting
work. The registry's admission lease and commit-finalization fence ensure an
authoritative loss either rejects a new operation before persistence or waits
for an admitted local commit before publishing the guard. Removal uses the same
fence.

A panel thread is not a separate filesystem owner. Its persisted host
association and worktree path map it to the host workspace's availability, so
chat panels, terminals, Git, files, previews, and other consumers all observe
the same warning and admission decision. The browser cannot override this
mapping.

The first authoritative loss installs the guard before cleanup and schedules
exactly one bounded cleanup lifecycle for the host and its panels. Canonical
cleanup starts immediately while panel aliases resolve in parallel. Provider
and terminal cleanup uses persisted identities; stale work cannot terminate a
replacement that recovered at the same path. The five-second graceful bound is
shared with explicit removal. Reaper capacity is finite (64 lifetimes, with 16
cleanup attempts at once); saturation retains the guard and orphan marker for
retry rather than admitting unsafe work.

Recovery clears the guard only after the exact normalized path and pinned
repository membership are verified again. A different directory or repository
at the same spelling is not recovery.

## Removal

Removal is a server-resolved plan/execute flow:

| RPC                          | Scope                   | Purpose                                                                                                                    |
| ---------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `worktree.getRemovalPlan`    | `orchestration:read`    | Resolve the current target and return an opaque versioned token plus dirty, lock, prune-impact, and availability facts.    |
| `worktree.removeFromBibCode` | `orchestration:operate` | Atomically detach BiBCode ownership without asking Git to remove anything.                                                 |
| `worktree.remove`            | `orchestration:operate` | Execute an explicitly chosen Git deletion or stale-registration cleanup, then detach only under the mode's verified rules. |

Before reservation, `Removing`, cleanup, Git mutation, or detach, a new removal
must acquire one of the same 64 cleanup-lifetime slots. Saturation returns the
retryable `cleanup-capacity` error with no side effects. The slot follows the
operation through foreground work, queueing, retry backoff, cancellation, and
shutdown.

The removal-plan token binds the physical project, thread, repository identity,
worktree or missing-path identity, availability, dirty counts, lock state, and
the sorted normalized paths with their exact prune reasons. Immediately before
mutation, verified stale cleanup reruns the inventory and dry-run and compares
that exact digest. A changed path, reason, lock, directory, repository, owner,
or generation requires a new plan. The server never substitutes recursive
directory deletion for Git worktree removal.

Present worktrees require a separate user choice between detach-only and Git
deletion, plus explicit dirty and prune-impact confirmations when applicable.
A failed present deletion retains BiBCode ownership. For an already missing
worktree, optional verified stale-registration cleanup may fail while the
bounded outcome is reported and detach still succeeds. An accepted removal is
one atomic transaction: same-path panel deletions, canonical thread deletion,
discovery-baseline compaction, and immutable result metadata. Exact retries
therefore replay after the projection disappears. A prepared receipt can
recover a crash after Git mutation only when the exact target is now proven
missing and unregistered.

## Protocol, capability, and operations

The live method names and scopes are mirrored in
[`rpc.ts`](../../packages/contracts/src/rpc.ts),
[`methods.rs`](../../apps/server/src/rpc/methods.rs), and
[`scope.rs`](../../apps/server/src/auth/scope.rs). A server advertises the
`worktreeCatalog` capability only when the complete handler set is available;
older or partial servers do not expose catalog UI or start subscriptions.

Operational evidence is available through catalog health fields, typed RPC
errors, removal outcomes, and structured warnings for alias resolution,
availability persistence, cleanup, saturation, and reaper failures. Normal
logs identify projects, threads, repositories, and worktrees without granting
clients or logs path authority. See [Connection runtime](./connection-runtime.md)
for reconnect behavior and [RPC and orchestration](./rpc-and-orchestration.md)
for durable command flow.
