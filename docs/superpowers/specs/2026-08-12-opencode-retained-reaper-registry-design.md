# OpenCode Retained Reaper Registry Design

**Status:** Approved in conversation on 2026-08-12; written-spec review pending.

## Context

The parallel Rust test migration exposed a production lifecycle defect in the
OpenCode helper reaper. The launcher correctly retains the exact child,
process-group identity, stdout task, and finite cleanup permit after a bounded
foreground reap times out. It also retries non-`Interrupted` kernel wait errors
at a fixed cadence and lets shutdown request one immediate retry.

The current registry splits one logical state transition across an atomic flag,
a retry watch, task spawning, and a mutex-protected task vector. A shutdown can
consume or reset the one-shot retry state while a newly spawned retained task
has not yet been inserted. That shutdown may return without observing the task,
and the task may subscribe after the retry notification. Repeated latch fixes
cannot make those separate linearization points atomic.

This defect is load-bearing for the parallel-test plan: later tasks remove more
serialization and rely on provider-terminal shutdown to retain and reap every
exact child under concurrent cancellation and teardown.

## Decision

Replace the split latch/vector protocol with one mutex-owned retained-reaper
registry state. The registry linearizes task reservation, running-task
publication, completion removal, drain-phase creation, and drain-phase reset.
Async process waits, stdout joins, task joins, timers, and notifications always
run after releasing the registry mutex.

The approved design is preferred to:

- another atomic-latch adjustment, which leaves task insertion and drain phase
  changes at different linearization points;
- a new actor/channel subsystem, which would add a scheduler hop and still need
  an acknowledged pre-spawn reservation to prevent shutdown from passing an
  in-flight submission;
- parking or reverting retained reap ownership, which would allow runtime
  teardown to abandon an exact child or restore an unbounded wait.

## Registry State

One `Mutex<RetainedReaperRegistryState>` owns:

- a monotonically increasing task identifier;
- entries keyed by task identifier;
- a monotonically increasing drain epoch;
- the active drain epoch, or none when the registry is empty;
- the completion notification identity needed by shutdown waiters.

An entry has an explicit lifecycle:

1. `Pending`: reserved synchronously before the retained task is spawned;
2. `Running`: the spawned task handle and its completion/failure state are
   published;
3. completed: the task has positively completed `Child::wait`; shutdown removes
   the entry and joins its handle outside the registry mutex.

The entry's child, process-group guard, stdout task, and cleanup permit move
into the spawned task in one synchronous submission call. A pending-entry guard
rolls back an unpromoted reservation if spawning or publication unwinds. The
existing child/process-group fallback guard remains responsible for terminating
the child during such an exceptional unwind; normal completion still requires
a successful kernel wait.

## Submission Linearization

Submission performs no async wait:

1. lock the registry;
2. allocate and insert a `Pending` entry;
3. unlock;
4. spawn the retained task with the exact child, process-group identity, stdout
   task, and already-reserved finite permit;
5. lock the registry and promote the same entry to `Running` with its handle;
6. unlock and notify drain waiters that registry state advanced.

Shutdown treats `Pending` as live work and cannot return while it exists. A task
may run before promotion, but completion state is monotonic and the published
handle remains joinable. There is no cancellation point between reservation and
promotion.

The existing finite permit remains acquired before helper spawn and remains
owned through foreground cleanup, pending registration, retained execution,
and the final successful wait. The registry does not introduce an unbounded
submission queue.

## Drain Epochs and Retry Semantics

Shutdown prepares its notification before inspecting state, then locks the
registry:

- completed entries are removed and their handles are collected for joining
  outside the mutex;
- if the registry is empty, the active epoch is cleared under the same lock and
  shutdown may linearize its return;
- if the registry is non-empty and no epoch is active, shutdown allocates one
  new epoch;
- if an epoch is already active, concurrent, repeated, and replacement shutdown
  waiters reuse it.

The epoch is published through a watch-style snapshot, not a change-only pulse.
Each retained task records the latest drain epoch for which it consumed an
immediate retry. After a non-`Interrupted` wait failure it first inspects the
current epoch:

- a new non-empty epoch permits exactly one immediate retry for that task;
- the same epoch cannot bypass the fixed 100 ms cadence twice;
- a task promoted after epoch publication still reads the current epoch and
  therefore cannot miss the shutdown retry;
- when the registry becomes empty, reset and return linearize under the same
  mutex; a later submission belongs to a new phase and receives a new epoch.

Persistent platform wait errors retain exact ownership and retry no faster than
once per 100 ms after their one per-task epoch retry. Shutdown remains pending
rather than releasing an unreaped child. `Interrupted` remains an immediate
kernel retry and does not consume the drain epoch.

## Concurrency and Lock Rules

- Registry state has one mutex and one documented linearization point.
- No `.await`, process operation, filesystem operation, stdout join, or task
  join occurs while that mutex is held.
- Notifications are enabled before state inspection to prevent lost wakes.
- Completion is published only after a successful `Child::wait`.
- Process-group disarm and cleanup-permit release remain success-only.
- Shutdown cancellation drops only that waiter; registry entries, epochs, child
  ownership, and retained tasks remain owned by the launcher.
- Repeated shutdown after an empty-state linearization is inert.
- A submission that reserves after empty-state linearization belongs to the next
  drain phase; the completed shutdown is not required to wait for later work.

## Error Handling

- `Interrupted` wait errors retry immediately.
- Other wait errors update the retained diagnostic once, notify waiters once,
  and retain ownership.
- A transient wait error automatically recovers on its epoch retry or fixed
  cadence and clears the diagnostic only after success.
- A persistent wait error leaves shutdown pending at the bounded cadence.
- Pending-entry rollback is exceptional and must leave no registry entry or
  permit leak; it must not fabricate successful reap completion.

## Deterministic Verification

The implementation starts with owner-level RED tests using positive test-only
events and paused Tokio time:

1. pause submission after `Pending` insertion but before spawn/promotion; start
   shutdown from an otherwise empty registry; prove shutdown cannot return;
2. activate the drain epoch while the task is pending, then promote a task whose
   first wait fails; prove it consumes that current epoch immediately without
   waiting 100 ms;
3. cancel the first shutdown waiter and start concurrent/repeated waiters; prove
   they share the same epoch and cannot accelerate persistent failures;
4. complete and remove the last entry, submit another task, and prove the new
   non-empty phase receives a distinct epoch and one immediate retry;
5. prove every completed task is joined, the exact child reports `ECHILD` on
   Unix after reap, and all permits return;
6. rerun the existing transient/persistent wait-error, stdout-join cancellation,
   foreground-waiter cancellation, manager shutdown, and 8-thread provider
   fixture suites.

No production or test deadline is widened. Wall-clock timeouts remain outer
failure bounds; ordering is established only by positive events and epochs.

## Scope

The change is internal to the OpenCode retained helper reaper and its living
provider-terminal lifecycle documentation. It does not change RPC contracts,
provider behavior, helper capacity, terminal-manager shutdown order,
persistence, authentication, or public APIs. Tasks 6-9 of the parallel Rust
test plan remain blocked until this registry design is implemented and its
scoped review has no open Critical or Important finding.
