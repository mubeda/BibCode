# OpenCode Retained Reaper Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode retained-child submission and shutdown draining linearizable under parallel cancellation so no exact child owner or one-shot drain retry can be missed.

**Architecture:** Replace the split task vector, atomic shutdown latch, and change-only retry pulse with one mutex-owned registry containing pending/running entries and an active drain epoch. Submission reserves a pending entry before spawn; shutdown treats pending entries as live; retained tasks consume the current epoch as a snapshot, so tasks promoted after epoch publication still receive exactly one immediate retry.

**Tech Stack:** Rust, Tokio tasks/watch/Notify/semaphore, `std::sync::Mutex`, real child-process fixtures, paused Tokio time, Cargo/libtest.

## Global Constraints

- No production or test deadline is widened.
- The fixed non-`Interrupted` retry cadence remains exactly 100 ms.
- The retained-helper capacity remains exactly 16, acquired before helper spawn and held until a successful `Child::wait`.
- Registry state has one mutex; no `.await`, process operation, filesystem operation, stdout join, or task join occurs while it is held.
- Completion publication, process-group disarm, and permit release occur only after a successful kernel wait.
- `Interrupted` wait errors retry immediately and do not consume a drain epoch.
- Concurrent, repeated, and cancelled shutdown waiters share one active drain epoch until the registry becomes empty.
- A task promoted after epoch publication reads the current epoch snapshot and cannot miss its one immediate retry.
- A shutdown may return only after an empty-state linearization under the registry mutex; submissions reserved afterward belong to a new epoch.
- Tests establish ordering with positive events/state transitions, never sleeps or yield-count inference; wall-clock timeouts are outer failure bounds only.
- No public API, RPC, persistence, authentication, provider behavior, or terminal-manager shutdown order changes.

---

### Task 1: Replace the Split OpenCode Reaper Protocol with an Atomic Registry

**Files:**
- Modify: `apps/server/src/provider_terminal/opencode.rs:1803-1853`
- Modify: `apps/server/src/provider_terminal/opencode.rs:2364-2643`
- Modify: `apps/server/src/provider_terminal/opencode.rs:3260-3534`
- Modify: `docs/architecture/activity-observation.md:102-125`
- Test: `apps/server/src/provider_terminal/opencode.rs`

**Interfaces:**
- Consumes: `OpenCodeRetainedReaper::reserve`, `SystemOpenCodeReapGuard`, `wait_opencode_child`, `FixtureEvent`, `OpenCodeHelperWaitErrorEvents`, `TerminalManager`'s existing launcher shutdown hook.
- Produces: `OpenCodeRetainedReaperRegistryState`, `OpenCodeRetainedReaperEntry::{Pending, Running}`, `OpenCodePendingReaperRegistration`, snapshot drain epochs through `watch::Sender<Option<u64>>`, and a linearizable `OpenCodeRetainedReaper::shutdown`.

- [ ] **Step 1: Add a deterministic empty-to-pending submission RED**

Add a private reservation seam used by production submission and the test:

```rust
#[derive(Debug)]
struct OpenCodePendingReaperRegistration {
    reaper: Arc<OpenCodeRetainedReaper>,
    task_id: u64,
    promoted: bool,
}

impl OpenCodeRetainedReaper {
    fn reserve_pending(self: &Arc<Self>) -> OpenCodePendingReaperRegistration;

    fn submit_reserved(
        self: &Arc<Self>,
        registration: OpenCodePendingReaperRegistration,
        child: Child,
        process_group_id: Option<i32>,
        permit: OwnedSemaphorePermit,
        stdout_task: Option<JoinHandle<()>>,
        #[cfg(test)] fixture_events: Option<OpenCodeHelperFixtureEvents>,
    ) -> watch::Receiver<bool>;
}
```

Write `shutdown_observes_pending_submission_and_new_task_consumes_active_epoch` as a Unix, four-worker Tokio test. Use the existing real-child retained fixture, but reserve the registry entry before calling `submit_reserved`:

```rust
#[cfg(unix)]
struct PreparedRetainedSubmission {
    child: Child,
    process_group_id: Option<i32>,
    permit: OwnedSemaphorePermit,
    pid: u32,
}

#[cfg(unix)]
impl RetainedReapFixture {
    async fn prepare_retained_submission(&self) -> PreparedRetainedSubmission;

    fn submit_reserved_real_child(
        &self,
        registration: OpenCodePendingReaperRegistration,
        prepared: PreparedRetainedSubmission,
    ) -> watch::Receiver<bool>;

    fn release_foreground_and_background_waits(&self) {
        self.timeout_events.foreground_return_release.publish();
        self.timeout_events.background_wait_release.publish();
    }
}
```

`prepare_retained_submission` acquires the existing reaper permit before it
spawns `/bin/sleep 3600` with `kill_on_drop(true)` and process group `0`, then
returns the exact `Child`, captured process-group ID, permit, and PID. It does
not start a second cleanup algorithm. `submit_reserved_real_child` passes those
values, no stdout task, and the fixture's existing events directly to
`OpenCodeRetainedReaper::submit_reserved`.

```rust
let wait_error = OpenCodeHelperWaitErrorEvents {
    failures_remaining: Arc::new(std::sync::atomic::AtomicUsize::new(1)),
    fail_persistently: Arc::new(AtomicBool::new(false)),
    injected: Arc::new(FixtureEvent::default()),
    recorded: Arc::new(FixtureEvent::default()),
    retry_started: Arc::new(FixtureEvent::default()),
};
let fixture = retained_reap_fixture("opencode-pending-drain-epoch")
    .with_wait_error(wait_error.clone());
let prepared = fixture.prepare_retained_submission().await;
let registration = fixture.launcher.reaper.reserve_pending();
let mut epoch = fixture.launcher.reaper.drain_epoch.subscribe();
let shutdown = tokio::spawn({
    let launcher = fixture.launcher.clone();
    async move { launcher.shutdown().await }
});
while epoch.borrow().is_none() {
    epoch.changed().await.expect("drain epoch sender remains live");
}
assert!(!shutdown.is_finished(), "pending registration is live drain work");

let _foreground_done = fixture.submit_reserved_real_child(registration, prepared);
fixture.release_foreground_and_background_waits();
wait_error.injected.wait_after(0).await;
wait_error.retry_started.wait_after(0).await;
assert_eq!(wait_error.retry_started.checkpoint(), 1);
```

The fixture helper must use the same `submit_reserved` production seam and the same real child/process-group/permit ownership as `SystemOpenCodeHelperProcess::terminate_and_reap`; it must not duplicate the reap algorithm or mock `Child::wait`.

- [ ] **Step 2: Run the empty-to-pending test and verify RED**

Run:

```bash
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::shutdown_observes_pending_submission_and_new_task_consumes_active_epoch -- --exact --nocapture
```

Expected: compile failure because `reserve_pending`, `submit_reserved`, registry entries, and `drain_epoch` do not exist.

- [ ] **Step 3: Add phase-reset and cancellation RED coverage before production edits**

Add `empty_registry_reset_starts_a_distinct_drain_epoch` using two sequential real children. The first task fails persistently, consumes epoch `E1`, then succeeds and drains. Reserve and submit the second task only after the first shutdown returns. Assert its shutdown publishes `E2 > E1`, its first failure consumes one immediate retry without advancing paused time, and repeated callers in `E2` do not cause a second immediate retry.

Extend `concurrent_and_repeated_shutdowns_coalesce_one_immediate_wait_retry` so the first shutdown future is dropped after the epoch becomes active, eight replacement shutdown futures reuse the same epoch, and `wait_error.injected` remains unchanged through 99 ms after the single epoch retry.

Run both exact tests and confirm they fail because the old global retry counter/atomic latch has no registry-coupled epoch or independent-phase reset proof:

```bash
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::empty_registry_reset_starts_a_distinct_drain_epoch -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::concurrent_and_repeated_shutdowns_coalesce_one_immediate_wait_retry -- --exact --nocapture
```

- [ ] **Step 4: Implement the mutex-owned registry state**

Replace `tasks: Mutex<Vec<_>>`, `retry: watch::Sender<u64>`, and `shutdown_retry_requested: AtomicBool` with:

```rust
#[derive(Debug)]
enum OpenCodeRetainedReaperEntry {
    Pending,
    Running(OpenCodeRetainedReaperTask),
}

#[derive(Debug)]
struct OpenCodeRetainedReaperRegistryState {
    next_task_id: u64,
    next_drain_epoch: u64,
    active_drain_epoch: Option<u64>,
    entries: std::collections::BTreeMap<u64, OpenCodeRetainedReaperEntry>,
}

#[derive(Debug)]
struct OpenCodeRetainedReaper {
    permits: Arc<Semaphore>,
    registry: Mutex<OpenCodeRetainedReaperRegistryState>,
    changed: Arc<tokio::sync::Notify>,
    drain_epoch: watch::Sender<Option<u64>>,
}
```

Initialize `next_task_id` and `next_drain_epoch` to `1`, `active_drain_epoch` to `None`, the entry map with capacity bounded indirectly by the existing 16 permits, and the watch value to `None`.

`reserve_pending` locks the registry, allocates the next wrapping ID while rejecting an occupied ID, inserts `Pending`, unlocks, notifies `changed`, and returns an armed registration. `Drop` for an armed registration removes only its matching `Pending` entry. If that makes the registry empty, clear `active_drain_epoch` and synchronously publish `None` while still at the registry linearization point; unlock before notifying waiters.

- [ ] **Step 5: Make submission reserve-before-spawn and promotion cancellation-free**

Change `submit` to take `self: &Arc<Self>` and implement it only as:

```rust
fn submit(
    self: &Arc<Self>,
    child: Child,
    process_group_id: Option<i32>,
    permit: OwnedSemaphorePermit,
    stdout_task: Option<JoinHandle<()>>,
    #[cfg(test)] fixture_events: Option<OpenCodeHelperFixtureEvents>,
) -> watch::Receiver<bool> {
    let registration = self.reserve_pending();
    self.submit_reserved(
        registration,
        child,
        process_group_id,
        permit,
        stdout_task,
        #[cfg(test)] fixture_events,
    )
}
```

In `submit_reserved`, construct `SystemOpenCodeReapGuard` before `tokio::spawn`, subscribe to `drain_epoch` only after the pending reservation exists, spawn the retained future, then lock the registry and replace that exact ID's `Pending` entry with `Running(OpenCodeRetainedReaperTask { ... })`. Disarm the registration only after successful promotion. There is no `.await` between reservation and promotion. Notify `changed` after unlocking.

If promotion finds no matching pending entry or a running entry, abort the spawned task and panic with a precise invariant message in debug/test builds; the captured `SystemOpenCodeReapGuard` and permit must remain in the aborted future so Drop terminates the child and releases capacity. Do not fabricate reap completion.

- [ ] **Step 6: Replace pulse retries with per-task epoch snapshots**

Inside each retained task keep:

```rust
let mut drain_epoch = self.drain_epoch.subscribe();
let mut consumed_drain_epoch: Option<u64> = None;
```

After each non-`Interrupted` `wait_opencode_child` failure, inspect `*drain_epoch.borrow_and_update()` before waiting. If it is `Some(epoch)` and differs from `consumed_drain_epoch`, set `consumed_drain_epoch = Some(epoch)`, publish the existing test-only `retry_started` event, and immediately retry exactly once. Otherwise select between the fixed 100 ms sleep and `drain_epoch.changed()`; after a change, loop back through the snapshot check rather than treating any watch change as permission to retry.

Remove `request_shutdown_retry` and every test fallback that calls it. The tests must drive behavior only by starting real shutdown or advancing paused time.

- [ ] **Step 7: Linearize shutdown against pending, running, and completed entries**

At the top of every shutdown loop, create and enable `changed.notified()` before locking the registry. Under one registry lock:

1. remove completed `Running` entries and collect their `JoinHandle`s;
2. leave `Pending` entries untouched and treat them as live;
3. collect at most one retained failure string for logging;
4. if entries are empty, clear `active_drain_epoch`, publish `None`, and mark this loop as the empty-state return point;
5. otherwise, if no epoch is active, allocate one epoch, set it active, and publish `Some(epoch)`; reuse an existing epoch without sending another value.

Release the registry lock before awaiting collected handles, logging, or awaiting `changed`. If the loop linearized empty, join collected handles and return even if a later submission creates a new phase. Otherwise join collected handles, log the retained failure once for this loop, and await the enabled notification.

Do not perform a second unlocked emptiness scan; it would recreate the split linearization defect.

- [ ] **Step 8: Run the new RED tests to GREEN**

Run:

```bash
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::shutdown_observes_pending_submission_and_new_task_consumes_active_epoch -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::empty_registry_reset_starts_a_distinct_drain_epoch -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::concurrent_and_repeated_shutdowns_coalesce_one_immediate_wait_retry -- --exact --nocapture
```

Expected: all three pass without sleeps, yield-count inference, fallback retry calls, or widened timeouts.

- [ ] **Step 9: Re-run the complete retained-owner regression matrix**

Run each exact test with `--exact --nocapture`:

```bash
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::foreground_timeout_transfers_exact_child_before_error_return -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::aborting_foreground_waiter_does_not_lose_reaper_ownership -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::launcher_shutdown_waits_for_retained_child_true_reap -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::abort_during_stdout_join_cannot_preempt_registry_ownership -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::transient_wait_error_recovers_automatically_at_retry_boundary -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::persistent_wait_error_retries_at_finite_cadence_during_shutdown -- --exact --nocapture
cargo test -p bibcode-server --lib terminal::manager::tests::shutdown_drains_provider_terminal_observer_factory -- --exact --nocapture
```

On Unix, retain the positive `ECHILD` assertion after successful shutdown. On all platforms, prove the permit count returns to 16 and the registry is empty after the final join.

- [ ] **Step 10: Run the parallel provider-terminal suite**

Run:

```bash
cargo test -p bibcode-server --lib provider_terminal::claude::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_terminal::codex::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_terminal::opencode::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::relay::tests -- --test-threads=8
```

Expected: all pass with no `SYSTEM_PROCESS_TEST_LOCK`, `EXTERNAL_PROCESS_TEST_LOCK`, process leak, retry hot loop, or serialized fixture fallback.

- [ ] **Step 11: Align the living lifecycle documentation**

Update `docs/architecture/activity-observation.md` so it states:

- pending registration exists before retained-task spawn;
- pending/running entries and the active drain epoch share one registry mutex;
- tasks consume the current epoch as a snapshot, including tasks promoted after epoch publication;
- empty-state reset and shutdown return linearize under the same lock;
- no async work is performed while holding that mutex.

Remove wording that describes one global latch/nudge independent of registry state.

- [ ] **Step 12: Run static and broader validation**

Run:

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
vp check
vp run typecheck
git diff --check
rg -n "shutdown_retry_requested|request_shutdown_retry|retry: watch::Sender<u64>" apps/server/src/provider_terminal/opencode.rs
```

Expected search result: no matches. Do not start multiple Cargo commands concurrently; wait for each retained command to finish.

- [ ] **Step 13: Review scope and commit**

Verify:

```bash
git status --short
git diff --stat
git diff -- apps/server/src/provider_terminal/opencode.rs docs/architecture/activity-observation.md
git diff --check
```

The implementation commit must contain only the OpenCode reaper owner, its tests, and the living lifecycle document; no `.codegraph`, `.repos`, ignored SDD report, dependency, manifest, lockfile, RPC, or timeout change.

Commit:

```bash
git add apps/server/src/provider_terminal/opencode.rs docs/architecture/activity-observation.md
git commit -m "fix(provider): linearize retained reaper drains"
```

After commit, generate a scoped review package from the pre-implementation base and require an independent reviewer to verify pending insertion, phase reset, new-receiver epoch consumption, cancellation, no await-under-lock, and exact reap truth before unblocking Tasks 6-9 of the parallel Rust test plan.
