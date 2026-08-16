# Claude Provisional Fallback Revocation Design

## Status

Approved on 2026-08-16.

## Context

Final verification of `vp run test` failed in
`targeted_activity_rpc_keeps_ambiguous_claude_children_unsupported_without_provider_io`.
The public Activity snapshot did not converge to the expected unsupported
controls within the test's ten-second polling window. The exact test passed in
2.47 seconds, so the first hypothesis was a load-sensitive observer deadline.

A direct concurrency harness ran eight already-built copies of the exact test
without Cargo or unrelated packages. It reproduced the failure in two of eight
runtimes. Temporary tagged instrumentation then reproduced it in one of eight
and captured the final authoritative state after 14,590 snapshot requests:

- both child actors existed and were `running`;
- the parent control was `available` with two active descendants; and
- both ambiguous child controls were incorrectly `available`, not
  `unsupported`.

The ready marker and all authenticated hook requests completed before the
failed observation. This rules out process startup, missing hook delivery, and
simple projection latency. The defect is an order-dependent control-correlation
race.

## Existing Invariant

Claude's documented `SubagentStart` hook identifies a child but omits its
parent. BiBCode therefore supports a bounded parent-local fallback only when
one active verified parent owns exactly one unresolved nested Agent/Task
candidate and exactly one unmatched verified child can belong to it. Ambiguous
children remain observable but unsupported and must cause no provider I/O.
Timing, arrival order, proximity, and polling are not correlation evidence.

Exact authenticated `PostToolUse` identity remains authoritative and may
promote a valid provisional fallback or resolve an otherwise unsupported child.

## Root Cause

`ClaudeTaskControlCorrelator::reconcile_parent_local_fallbacks` installs a
fallback as soon as the currently observed evidence has cardinality one. The
installed record is then excluded from later candidate and unmatched-child
sets.

If all sibling invocation/task facts arrive before their parentless
`SubagentStart` hooks, cardinality is greater than one and both children remain
unsupported. Under a different legal interleaving, child A becomes the sole
candidate and is installed before child B appears. Once child B arrives, child
A is no longer counted, so child B also appears uniquely resolvable and is
installed. The final state depends on scheduling even though the complete fact
set is identical.

## Goals

- Make parentless fallback correlation independent of fact arrival order.
- Revoke already-installed provisional targets when later evidence makes the
  owning parent ambiguous.
- Keep every ambiguous actor visible while rejecting targeted cancellation
  before provider I/O.
- Preserve exact PostToolUse correlation, bounded state, generation fencing,
  terminal cleanup, and ordinary Claude chat.
- Replace the integration test's snapshot-request loop with positive Activity
  stream observation under the existing provider-fixture deadline contract.

## Non-Goals

- Do not change Claude's protocol, hook schema, or public Activity schema.
- Do not add sleeps, debounce windows, retries, global locks, serialization, or
  timing-based correlation.
- Do not widen a production timeout or alter provider process ownership.
- Do not disable the unique parentless fallback.
- Do not infer identity from labels, descriptions, prompts, or actor order.

## Chosen Design

### Provisional fallback ownership

The correlator will retain enough provenance to distinguish an exact target
from a parentless fallback target. A fallback assignment remains provisional
until exact PostToolUse promotes it. Its record continues to participate in
the candidate set for its verified parent after installation.

For each active verified parent, reconciliation considers the complete set of
eligible unresolved nested correlations and their fallback-assigned children,
not only unassigned records. A fallback is admissible only while the complete
set has exactly one candidate and one compatible child.

### Ambiguity revocation

When later same-generation evidence makes a parent-local set non-unique,
reconciliation revokes every provisional fallback in that set before returning:

1. publish `ActorTarget { target: None }` for each installed provisional actor;
2. remove its provisional actor-to-task and task-to-actor associations;
3. clear the record's fallback agent identity;
4. revert only lineage that the fallback itself promoted from parentless root
   to the inferred parent; and
5. retain the actor, task correlation, and verified identity as bounded
   unresolved evidence.

The actors therefore remain visible and `running`, while the Activity control
overlay becomes `unsupported`. No stop request or root interrupt is emitted.
The revocation is idempotent, generation-owned, and bounded by the existing
200-correlation limit.

Affirmative competing evidence is retained as bounded parent-level ambiguity
for the rest of the runtime generation. A parent becomes fallback-ambiguous
when its complete set has multiple eligible nested candidates or multiple
compatible verified children, including the global parentless shape where
multiple candidates or children compete. Parent-local fallback admission then
stays disabled for that parent until generation reset. This prevents exact
resolution of one sibling from making an unresolved sibling appear newly
unique by elimination. Exact PostToolUse evidence remains authoritative and
can still resolve every named child independently.

The neighboring public selected-subtree regression must establish exact nested
identity before it introduces an unrelated parentless actor. Its authenticated
hook sequence therefore includes the child's matching `PostToolUse` response
after `PreToolUse` and `SubagentStart`. That test is intended to prove exact
subtree cancellation, not to preserve a provisional fallback after affirmative
sibling ambiguity; the later unrelated actor must leave the exact child target
available.

An explicit parent lineage is never erased by fallback cleanup. Exact
PostToolUse identity is never revoked merely because other unresolved siblings
exist. Exact evidence arriving after revocation can resolve and install its
named child through the existing authoritative path.

### Positive integration observer

The public integration test opens dedicated thread and Activity WebSockets
before starting the provider turn. Dispatch admission is asynchronous and does
not prove that provider launch has created the Activity scope, so the test
subscribes to `orchestration.subscribeThread` first, ACKs every chunk, starts
the turn, and waits for a thread snapshot whose session status is `ready` or
`running`. Production publishes either status only after
`ensure_live_activity_scope` has returned, making that public thread event the
causal readiness boundary for the test's single `subscribeActivity` request.
The test then ACKs the initial Activity snapshot before observing the positive
fixture-ready marker or sending authenticated hooks. The fixture cannot publish
a child actor/control transition before that marker, so no relevant Activity
transition can be missed. Turn admission, thread readiness, the single Activity
subscription, the fixture ready marker, authenticated hook requests, Activity
stream notifications, and the final authoritative snapshot share one absolute
30-second test-only deadline, matching the already approved provider-fixture
deadline policy.

The test ACKs each stream chunk. A stream notification triggers an
authoritative `activity.getSnapshot` read; the test does not issue another
snapshot until another Activity event arrives. Success still requires both
children `running`, both controls `unsupported`, and the parent control
`available`. It then proves both cancellation attempts return
`targetUnavailable` and that the provider capture is byte-for-byte unchanged.

On deadline or stream failure, the test reports the last authoritative snapshot
and fixture capture, closes all three WebSockets, and shuts down and joins the
server owner before failing.

## Data and Concurrency Flow

1. Claude stream and authenticated hook facts enter one session-generation
   correlator.
2. Each fact updates bounded correlation state and runs reconciliation.
3. Reconciliation computes parent-local cardinality from both pending and
   provisional fallback records.
4. A unique set installs or retains one provisional target.
5. A competing fact synchronously produces revocation effects in the same
   provider event batch before Activity projection.
6. Activity control observation applies target removal before publishing the
   corresponding stream delta.
7. Public cancellation sees no native target and fails before provider I/O.

There is no new task, timer, queue, mutex, or cross-runtime state.

## Failure and Cleanup Semantics

- Malformed, conflicting, saturated, stale-generation, and duplicate identity
  facts continue to fail closed.
- Partial revocation is not observable: all effects are computed within the
  correlator call and published through the existing provider event batch.
- Replayed provisional facts cannot reinstall a target while the complete
  parent-local set remains ambiguous.
- Exact resolution of one child cannot clear parent-level fallback ambiguity
  or reopen fallback for its unresolved siblings; only generation reset clears
  that bounded ambiguity memory.
- Runtime replacement, Activity disablement, terminal observation, and session
  shutdown retain their existing retirement and bounded cleanup paths.
- The integration deadline is test-only; production delivery, cancellation,
  and process deadlines remain unchanged.

## Test Strategy

### Deterministic owner regression

Add a `ClaudeTaskControlCorrelator` test using one legal interleaving:

1. fully install the exact parent;
2. deliver child A's nested invocation, task, PreToolUse, and parentless
   SubagentStart so the current implementation installs its fallback;
3. deliver child B's equivalent facts afterward; and
4. require a retirement effect for A, no install for B, no remaining native
   target for either child, and bounded retained correlation state.

The unchanged implementation fails because both children remain installed.
Permutation coverage must also show that the same complete fact set produces
the same unsupported result when both sibling candidates arrive before either
SubagentStart.

Add a follow-up exact-evidence case proving a matching PostToolUse can resolve
one child after provisional ambiguity without reopening the other.

### Public integration regression

The existing ambiguous-child RPC test adopts the Activity stream and absolute
deadline described above. Run it alone, the complete Claude runtime unit
module, the complete `production_provider_runtime` integration binary at
default, 8, and 12 harness threads, and the direct eight-runtime concurrency
harness. Zero targeted provider request bytes and normal shutdown remain
mandatory.

### Repository verification

Run formatting, server all-target Clippy with warnings denied, `vp check`, and
`vp run typecheck`. Then run the server package and one final `vp run test`
graph as sole owners. Stop on the first different failure.

## Alternatives

### Only replace polling and increase the test deadline

Rejected after diagnosis. The captured final state was wrong, not merely late;
an event-driven observer alone would faithfully report the same product bug.

### Add a quiescence or debounce interval before fallback installation

Rejected. A timing heuristic cannot prove that another sibling will not arrive
later and would make correctness dependent on host scheduling.

### Disable parentless fallback

Rejected. It would remove valid targeted cancellation for the documented,
common unique nested-child shape.

### Trust the first child and ignore later ambiguity

Rejected. It violates fail-closed identity ownership and could send provider
control to the wrong child.

## Documentation Impact

Update `docs/architecture/activity-observation.md` and
`docs/architecture/providers.md` with the provisional revocation invariant:
later competing evidence revokes inferred targets, restores unsupported
control, and never affects exact targets. No public schema or migration changes
are required.
