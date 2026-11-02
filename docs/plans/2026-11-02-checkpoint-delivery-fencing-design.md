# Checkpoint Delivery Fencing (#261)

Status: Approved 2026-11-02 (Codex review, 3 rounds)

Follow-up to #234, #235 and #236 (PR #247): option D of
`docs/plans/2026-11-01-turn-checkpoint-residuals-design.md`. Verified at `main`
(`9c8799b80`) with `origin/v015/234-236-checkpoints` merged (`f83c9e849`). PR #247's
rules are assumed: a baseline writes ref 0 only, and a diff comes only from a trusted
baseline (ref 0, or the ref of a `ready` predecessor). Paths are under `apps/server/src/`
unless they name `apps/server/tests/`.

## Problem

A thread's ref 0 is written by the serial effects worker, while turn delivery starts the
turn on its own. Nothing orders the two, so the agent can edit the checkout before ref 0 is
captured.

### Current behavior

- **Delivery** (`production/turn_delivery.rs`). `fill_available_slots` stops selecting when
  every slot is busy (`:998-1000`). Selection skips a thread whose ended turn is held for
  its checkpoint (`:1038`). `prepare_claim_and_deliver` runs a start's bootstrap (worktree,
  setup script) (`:1386`). It then takes the thread's turn reservation (`:1393`), checks
  the hold again (`:1401`), claims the row (`:1406`) and sends the turn (`:1415`). The
  claim sets `state = 'sending'` and increments `attempts`
  (`persistence/repositories.rs:1102`). No step waits for ref 0.
- **Baseline** (`production/orchestration_effects.rs`). `process_event` calls
  `ensure_baseline` for `thread.turn-start-requested`, and for a user `thread.message-sent`
  that is not imported history (`:1041-1046`, `needs_turn_baseline` `:1137`).
  `ensure_baseline` (`:1159-1209`) resolves the workspace, spawns
  `git rev-parse --is-inside-work-tree`, and reads the thread's turns. It returns when an
  earlier turn has a number (`:1197`). It captures ref 0 when that ref is missing, or again
  for a thread whose turns predate checkpoints (`:1200-1206`). The worker handles events one
  at a time for every thread, and only reverts are parked (`:1005-1021`).
- **Restart**. `OrchestrationEffects::start` reads the event log head as a floor and never
  replays events at or below it (`:473-477`, producer `:552`). Turn delivery selects every
  pending row again when it starts. So a turn whose start event was committed before the
  restart, but not handled by the worker, never gets ref 0. After the restart, a backlog on
  the worker (identity backfill, captures, another thread's slow Git) lets delivery win
  the race again.
- **Process runner** (`process/supervised.rs`). On Windows, process creation runs in
  `spawn_blocking`. If it stalls past the deadline, the run returns `Timeout`. A detached
  task waits for the late child and only then terminates it (`:151-169`). The cleanup
  waits up to 2 s (`:20`). A stalled child can therefore start, and run briefly, after its
  caller has moved on.

### Consequences under PR #247

1. **Late ref 0**: the worker captures the checkout after the agent edited it. Turn 1 is
   `ready` with a diff from that ref, which silently leaves out the agent's edits. This is
   the case the issue describes.
2. **No ref 0** (restart): turn 1 is `ready` with `diffAvailable: false`. That is safe, but
   the diff is lost.
3. **Probably also**: for a start that bootstraps a worktree, the worker can handle
   `thread.turn-start-requested` before the delivery's `ThreadMetaUpdate` sets the thread's
   `worktree_path` (`turn_delivery.rs` `execute_bootstrap_prerequisites`).
   `workspace_for_thread` (`production/runtime.rs:1022-1044`) then falls back to the
   project root, and ref 0 is taken from the wrong checkout. Checkpoint refs live in the
   shared common directory, so the turn-1 diff compares the project root with the
   worktree. Confirm this with a test while implementing. The recommended design fixes it
   by order: the baseline runs after the bootstrap.

## Requirements

- R1: the first turn of a thread (ref 0 missing) is claimed only after its ref 0 is
  captured, or after the capture has failed or timed out and that was reported.
- R2: whatever writes ref 0, and whenever it lands, ref 0 always
  shows the checkout before the turn. No ref-0 write is requested after the claim.
- R3: every wait is bounded, and a failure is shown to the person without losing the turn.
- R4: no Git call and no wait when the thread already has a numbered turn (the issue's "no
  added latency when the baseline already exists"). That includes not waiting behind other
  threads' first-turn captures.
- R5: a restart, with a pending row from before it or with a slow worker after it, keeps R1.
- R6: shutdown cancels the wait without claiming, and leaves the row pending.

## Options

| Option                                                                                                                                                                                                                                                                                                                                                                    | Trade-offs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Delivery waits on a per-thread barrier the worker clears.** The engine marks the thread "baseline pending" when it commits a baseline event. Delivery skips the thread, as it does for a checkpoint hold, until `ensure_baseline` clears the mark or the bound expires.                                                                                              | Git stays on the worker, which remains the only writer. But the mark is in memory and history is not replayed. A restart needs a new startup pass that finds pending first turns and queues their baselines. The decider cannot cheaply tell whether a baseline is needed (Git, turn numbers), so it marks every turn start, and each one waits for the worker. That adds latency to every turn, which breaks R4 unless the marking is made more complex. The worker is serial, so one thread's hung Git delays every other thread's first turn up to the bound. When the bound expires, the worker still captures later, from a checkout that may hold edits, which breaks R2 unless it also checks the row's claim state. Three new mechanisms. |
| **B. Delivery captures ref 0 itself, before the first claim (recommended).** A per-thread baseline stage in the delivery loop captures ref 0 outside the delivery slots. The row is selected for a slot only after that stage has ended. The worker's two baseline arms are deleted, so delivery is the only writer. A late write can only publish the pre-turn snapshot. | R1, R5 and R6 follow from where the stage sits: every pending row passes it before its first claim. R2 comes from the snapshot-before-claim rule. A worktree bootstrap runs first, so the worktree case is fixed. Git (2–6 processes) runs only for a thread with no numbered turn. It runs per thread, and it neither queues behind other threads on the serial worker nor holds a delivery slot. Costs: one more in-memory stage in the delivery loop. The tests that sync with the worker through a new thread's ref 0 also need another sync point.                                                                                                                                                                                           |
| **C. Ref 0 from the pre-turn state the provider reports.**                                                                                                                                                                                                                                                                                                                | No provider reports the checkout before a turn. Rebuilding it by reversing the reported file changes misses edits made by shell commands, formatters and setup scripts. It would also differ between Codex, Claude and OpenCode. Rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B′. B, keeping the worker's arm as a fallback.                                                                                                                                                                                                                                                                                                                            | After a failed or timed-out delivery capture, the worker would still write ref 0 later, possibly from an edited checkout, which is today's bug. Guarding against that means the worker takes the thread reservation and checks the row is unclaimed. That blocks the serial worker on a provider handoff. Rejected: two writers for one ref.                                                                                                                                                                                                                                                                                                                                                                                                      |
| B″. B, with the capture inline in the delivery slot (the first revision).                                                                                                                                                                                                                                                                                                 | Four slow captures take all four slots, and selection stops when the slots are full, so a thread that already has its baseline waits up to the bound (review round 1). Rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Recommendation: B

### Design

1. **One writer.** Delete the two `process_event` arms (`orchestration_effects.rs:1041-1046`),
   along with `needs_turn_baseline` and the `Baseline` enum. `ensure_baseline` becomes
   `ensure_first_turn_baseline(repositories, callbacks, thread_id, message_id, cancellation)
   -> BaselineOutcome`, with the outcomes `Captured`, `NotNeeded`, `Failed(reason)`,
   `TimedOut` and `Cancelled`. It and `resolve_workspace` take `&Repositories` instead of
   the engine, because `ProductionBootstrapEffects` (`:277`) holds no engine.
   `had_turns_before_checkpoints` and the rule for threads whose turns predate checkpoints
   are unchanged. A queued message is baselined when it is delivered, so the message-sent
   variant has nothing left to do.
2. **The seam.** Add one method to `ThreadTurnBootstrapEffects` (`orchestration/engine.rs:316`):
   `capture_first_turn_baseline(thread_id, message_id, limit, cancellation)`. Delivery
   already reaches the effects through this bootstrap hook. When no bootstrap effects are
   registered, or `engine.checkpoint_hold_limit()` is `None`, no effects worker records
   checkpoints, so delivery skips the stage, as checkpoint holds already do. Tests outside
   the crate reach the same function through a public
   `OrchestrationEffects::capture_first_turn_baseline` (test 12).
3. **A baseline stage outside the delivery slots** (`turn_delivery.rs`). The capture must not
   hold one of the `MAX_CONCURRENT_THREADS` (4) slots. `fill_available_slots` stops
   selecting when they are full (`:998-1000`), so four slow captures would hold back a
   thread that already has its baseline.
   - The delivery loop owns a `baselined: HashSet<command_id>`, a `baselining:
     HashSet<thread_id>`, a `baselines: JoinSet<BaselineCompletion>`, and a semaphore of
     `MAX_CONCURRENT_BASELINES = 4`.
   - In candidate selection, after the existing hold, session and archive checks (`:1030-1060`),
     look at each row with `mode == Start`, `attempts == 0` and a command id not in
     `baselined`. If the thread already has a numbered turn (step 4, one SQLite read), insert
     the command id into `baselined` and go on as today. Otherwise, if the thread is not in
     `baselining` and a baseline permit is free, spawn the stage into `baselines` and skip
     the row for this fill (`continue`), the way a held thread is skipped (`:1038`). It does
     not count against `available`. A row whose stage cannot start yet is skipped too.
   - A finished stage puts its command id into `baselined`, except when it was `Cancelled`.
     It then leaves `baselining`, and the loop, which waits on `baselines` as on its tasks, fills again. Only then can the row take a slot.
     `baselined` is pruned to active commands, like `retry_backoffs` (`:1017`).
   - A start with a `bootstrap` (it may prepare a worktree) needs its baseline taken after
     the bootstrap, in the checkout the bootstrap set up. `prepare_claim_and_deliver` runs
     the bootstrap in its slot as today (`:1386`). When the row still needs its baseline,
     the task then returns `DeliveryTaskOutcome::Bootstrapped` without claiming, which
     releases the slot. The loop records the command id in `bootstrapped`. The row then
     goes through the baseline stage like any other first turn. When it takes a slot again,
     `prepare_claim_and_deliver` skips the bootstrap it already ran. After a restart,
     `bootstrapped` starts empty, and the bootstrap runs again, as it already does for a
     retry.
   - The stage runs only before a row's first claim (`attempts == 0`). A steer joins a turn
     that already has its baseline. A row with `attempts > 0` may already have edited the
     checkout, so it never captures (R2 across retries and restarts).
4. **Fast path (R4).** First read the thread's turns, one indexed SQLite read. If an earlier
   turn has a number, return `NotNeeded` without Git and without the stage. Otherwise
   resolve the workspace, then check for `.git` with `in_git_checkout` (`:1337-1347`), the
   filesystem walk `record_turn_end` already uses. If there is no `.git`, return
   `NotNeeded`. Only then start Git: `is_git_repository`, `has_ref`, then the capture. A
   project outside Git pays one filesystem walk per first-attempt start, and a Git thread
   pays the Git cost once, at its first turn.
5. **One bound for every await (R3).** The bound is `engine.checkpoint_hold_limit()`
   (`EffectsOptions::checkpoint_hold_limit`, 120 s by default), the same time a thread
   already waits for a turn-end capture.
   - The stage uses `token = stop_claiming.child_token()`, and a timer cancels it at the
     bound.
   - Every non-Git await is raced against the token. That covers the turn read,
     `workspace_for_thread`, and the `in_git_checkout` walk. The walk runs in
     `spawn_blocking` and cannot be interrupted, but it only reads. On cancellation its
     `JoinHandle` is dropped, and the blocking thread ends whenever the filesystem answers.
   - The Git steps already honor the token (`capture_checkpoint_with_cancellation`,
     `:2048`).
   - A test-only engine hook, `TestHooks::hold_checkout_probe`
     (`#[cfg(test)]`), lets a test hold the walk.
6. **The fence (R2).** Awaiting the stage is not enough on its own. After a stalled spawn,
   the runner returns `Timeout` while a detached task still waits for the child, and only
   afterwards terminates it (`process/supervised.rs:151-169`). So a Git process may start,
   and run briefly, after the stage has returned and the turn has been claimed. That is
   harmless.
   - **Snapshot before claim.** The only command that writes a ref is `update-ref`, and its
     arguments are fixed when it is spawned. The commit it names was built by
     `read-tree`/`add -A`/`write-tree`/`commit-tree` runs that all finished, and were
     awaited, before `update-ref` was started, so before the claim. A late `read-tree`,
     `add`, `write-tree` or `commit-tree` writes only the temporary index or unreachable
     objects. A late `update-ref` can therefore only publish a snapshot of the checkout
     before the turn.
   - **No tombstone.** Round 2 proposed a permanent `<ref 0>.lock` file to refuse late
     writes. It was dropped: a leftover ref lock blocks `pack-refs --all` pruning,
     `reflog expire --all` and automatic gc in the person's repository. The snapshot rule
     needs no file, and it works the same in a reftable repository.
   - A late ref 0 lands after turn 1 may already have been captured. That turn then stays
     `ready` with `diffAvailable: false`, as it was recorded. A diff is never computed from
     a ref that could hold the turn's own edits.
7. **Error (R3).** `Failed(reason)` and `TimedOut` are reported once.
   - `tracing::warn!(thread_id, elapsed_ms, error, "a first turn's checkpoint baseline was
     not captured; the turn goes on without one")`.
   - One `checkpoint.capture.failed` activity, with tone `error`, `turnId: null` and payload
     `{turnCount: 0, detail}`. That is the kind and shape the worker's failure path uses
     today (`:1975-2000`). The detail: "The checkout before this thread's first turn could
     not be recorded (timed out after 120 seconds | <Git error>), so that turn's changes
     cannot be shown. Check that Git works in this folder."

   The row then takes a slot and is claimed and sent. Checkpoints support the turn, so a
   broken or hung Git must not block it. PR #247 makes a missing ref 0 safe: turn 1 is
   `ready` with `diffAvailable: false` and can be reverted to.

8. **Cancellation (R6).** When `stop_claiming` fires (shutdown), the stage returns
   `Cancelled`. Its Git children are stopped through the token, which waits for them to
   exit through the runner's cancellation branch. No activity is written, the
   row stays `pending` with `attempts = 0`, and the next start runs the stage again.
   Delivery shutdown closes and drains `baselines` along with its delivery tasks. A thread
   deleted during the stage has its row settled by the existing deletion paths.
9. **Restart (R5).** No new mechanism. A row left pending by a restart still has
   `attempts = 0` and is not in the new loop's `baselined`, so it passes the stage before
   its first claim, wherever its start event sits relative to the worker's floor. A row that
   was `sending` goes through `recover_sending` (`turn_delivery.rs:870`) and never through
   the stage. Turn-end captures, holds and their expiry are unchanged.
10. **Load.** At most one stage per thread runs at a time (`baselining`), and at most four in
    total. They are separate from the four delivery slots. A thread that already has its
    baseline is never delayed by first-turn captures. A fifth first-turn thread waits for a
    baseline permit, which is bounded by the hold limit of the stages ahead of it. The worker
    no longer spawns Git for turn starts.

### Profiler, crash and trace coverage

- RPC: no method is added or changed. No RPC handler waits for a delivery claim. The only
  `wait_for_delivery_state` is a test helper (`production/orchestration_rpc.rs:4384`), and
  MCP's waiting tools are already long-running. So `is_long_running` does not change: delivery
  is a background task, not a handler.
- Child processes: the capture uses the existing `run_git` and `ProcessRunner` path
  (supervised, cancellable), which is unchanged. A late child after a stalled spawn is still
  reaped by the runner's own detached cleanup, and the snapshot rule (step 6) makes it
  harmless.
- Trace: `tracing::warn!` on failure or timeout (step 7), and `tracing::debug!(thread_id,
  elapsed_ms)` when a capture succeeds, so slow first-turn baselines show up in the native
  trace. No profiler event or finding changes, so `docs/skills/bibcode-profiler/references/`
  needs no update.
- No worktree removal, binary mode or shutdown order changes. The stage stops with
  `stop_claiming`, which delivery shutdown already cancels before the profiler tears down,
  and the shutdown drains `baselines`.

### Tests

All tests are in `production/turn_delivery_queue_tests.rs`, unless marked otherwise, and use
`RevertFixture` (production Git, `GatedRewind` callbacks) with a `TurnDeliveryService`
whose router reports each delivered command. The new thread is `n`, in the fixture's
checkout, whose `tracked.txt` holds `two\n` before `n`'s first turn. Today the
`t`-specific helpers (`checkpoint_of`, `captured`, `turn_patch`) take thread `t` only.
They gain a thread parameter. `GatedRewind` also gains:

- `workspace_entered: Notify`, which announces a held `workspace_for_thread`;
- `hold_workspace_for: Mutex<HashSet<String>>`, which holds the lookup of the named threads
  until `workspace_release`.

1. `a_first_turn_delivered_while_the_effects_worker_lags_after_a_restart_diffs_its_edit`.
   This is the issue's test, and it fails today.
   - Create the fixture on a file database, then restart: shut down the effects and the
     engine, then reopen both on the same file, as in
     `a_stale_turn_is_never_a_revert_target_after_a_restart`.
   - Delay the worker. Hold `t`'s workspace lookup, record turn 3 of `t` ended
     (`end_turn_unheld`), and wait for `workspace_entered`. The serial worker is now
     blocked.
   - Create `n`, start delivery, and enqueue `n-first`. Wait until it is `received`. Then
     write `edited\n`, the agent's edit.
   - Assert that ref `n/0` resolves and that its `tracked.txt` is `two\n`.
   - `record_turn_end(n, turn-n1, Live)`, then release the worker.
   - Assert that `n`'s turn 1 is `ready` with `diffAvailable: true` and files
     `[tracked.txt]`, and that the patch from 0 to 1 holds `-two` and `+edited`.
   - Today ref 0 is captured after the release from the edited checkout, so the files are
     empty.
2. `a_first_turn_left_pending_across_a_restart_gets_its_baseline_before_delivery` (fails
   today). Enqueue `n-first` with the effects running but no delivery service, and with the
   worker held as in test 1, so the start event is never handled. Restart, start delivery,
   and wait until it is received. Assert that ref `n/0` holds `two\n` before the edit, and
   that turn 1's diff holds the edit. Today ref 0 is never written (the floor), and the
   turn has `diffAvailable: false`.
3. `a_turn_on_a_thread_with_checkpoints_is_delivered_without_git_or_wait` (R4, a
   regression guard). Thread `t` has numbered turns. Hold `t`'s workspace lookup and never
   release it. Enqueue a turn for `t`. Assert that it is received within the usual 3 s and
   that no `workspace_entered` fired, so no workspace lookup and no Git ran.
4. `first_turn_captures_never_hold_back_a_thread_that_has_its_baseline` (saturation, R4,
   fails against the first revision of this design). Use the production slot count
   (`start_with_router_and_capacity(engine, 4, 4, ..)`). Create `n1` to `n5` and hold all
   five workspace lookups. Enqueue a first turn for each, then wait until four
   `workspace_entered` have fired: the baseline permits are full, and `n5` waits for one.
   Enqueue a turn for `t`. Assert that it is received within 3 s and that no `n*` turn was
   received. Release the holds. Assert that every `n*` is received after its ref 0 resolves.
   A second case uses four first turns that each carry a `bootstrap`, and runs their
   bootstraps in their slots. Each releases its slot before its capture, the four captures
   hang, and `t` is still received within 3 s.
5. `a_first_turn_baseline_that_fails_is_reported_and_the_turn_still_goes` (R3). Lock ref
   `n/0` (`lock_ref`) so `update-ref` fails. Enqueue `n-first`. Assert that it is received,
   that there is exactly one `checkpoint.capture.failed` activity with `turnCount: 0`, and
   that ref `n/0` does not resolve. End the turn, and assert that turn 1 is `ready` with
   `diffAvailable: false`.
6. `a_hung_workspace_lookup_is_given_up_at_the_limit` (R3). Use a 200 ms limit and hold
   `n`'s lookup. Assert that the turn is received within the limit plus the usual slack,
   and that the activity says the capture timed out. Release the hold and sync with the worker. Assert that ref `n/0` never resolves.
7. `a_hung_checkout_probe_is_given_up_at_the_limit` (R3, for `in_git_checkout`). Use a 200 ms
   limit and hold the probe (`TestHooks::hold_checkout_probe`). Assert the same as in test 6, then release the gate.
8. `a_live_ref_zero_writer_is_stopped_before_the_claim` (live-child cancellation). Install a
   `reference-transaction` hook in the fixture checkout (`core.hooksPath`) that waits for a
   marker file. Git runs it inside `update-ref` while holding the ref's lock. Use a 200 ms
   limit and enqueue `n-first`.
   - Assert that the turn is received only after the limit, with one timed-out activity.
   - Write the marker, wait twice the cleanup wait, and assert that ref `n/0` does not
     resolve: the child and its hook were stopped before the claim.
9. `a_late_ref_zero_write_after_the_claim_publishes_the_pre_turn_checkout` (stalled spawn).
   A stalled `CreateProcess` cannot be reproduced in a test, so this test reproduces its
   consequence: an `update-ref` that runs after the claim.
   - Hold `n`'s capture in the `reference-transaction` hook as in test 8, and record the
     commit the hook was asked to publish.
   - The stage times out, and the turn is received and edits `tracked.txt`.
   - Run `git update-ref <ref n/0> <recorded commit>` in the test, as the late child would.
   - Assert that ref `n/0`'s `tracked.txt` is the pre-turn `two\n`, not the edit. Assert
     that turn 1, once ended, is `ready` with `diffAvailable: false`, as recorded when it
     was captured.
10. `a_shutdown_during_a_first_turn_baseline_leaves_the_turn_unclaimed` (R6). Hold `n`'s
    lookup, enqueue `n-first`, and wait for `workspace_entered`. Shut down the service and
    assert that it returns promptly. Assert that the row is `pending` with `attempts == 0`,
    that there is no activity and no ref `n/0`. Start a new service without
    the hold, and assert that ref `n/0` resolves before the turn is received.
11. `a_redelivered_first_turn_never_captures_a_baseline` (R2 across retries). Set row
    `n-first` to `attempts = 1` (SQL through `database().call`, as `fail_stale_records`
    does), with no ref `n/0`. Assert that the turn is received, that ref `n/0` still does not
    resolve, and that there is no activity.
12. Migrate the tests that depend on the worker writing ref 0, and keep their assertions.
    - `tests/production_orchestration_effects.rs:667-691`
      (`captures_baseline_and_replaces_missing_turn_checkpoint_with_real_diff`) and
      `:839-888` (`a_thread_with_turns_before_checkpoints_starts_them_from_its_next_turn`)
      start the turn with a plain `dispatch` and wait for the worker's ref 0. Move both into
      `production/turn_delivery_queue_tests.rs`, where the real `TurnDeliveryService` can
      run (its constructors are `pub(crate)`).
      - The trigger becomes an admitted start (`enqueue_as`, with a provider-turn row),
        delivered by a service whose router reports it.
      - The first test's ref-0 wait, edits, `missing` record, real diff (two files) and
        revert run as they do today.
      - The second test's assertion that ref 0 holds `changed since` runs once the start is
        received, so through delivery's recapture for a thread whose turns predate
        checkpoints.
    - `tests/production_provider_runtime.rs`: `CheckpointedSession::start_turn`
      (`:11729-11751`) hands the turn to the supervisor directly, without delivery, and
      seven tests read turn 1's diff (`:11868`-`:12222`).
      - `start_turn` now calls the public `OrchestrationEffects::capture_first_turn_baseline`
        between `dispatch` and `handle_orchestration`, the order delivery uses.
      - `a_turn_without_a_baseline_is_never_ready_and_the_next_turn_is` keeps its ref-0
        lock. Its ref-0 failure is now reported by that call. It is updated to PR #247's
        rule: turn 1 is `ready` with `diffAvailable: false`, and a revert to it succeeds.
        It is renamed `a_turn_without_a_baseline_is_ready_without_a_diff_and_revertible`.
      - `a_turn_that_ends_before_the_worker_handles_its_start_is_numbered_and_captured`
        holds the worker on the turn's capture instead of its start. Its assertions stay:
        numbered while the worker is behind, `ready` after the release.
    - The test helpers `other_thread_gets_its_baseline` and `worker_caught_up` (19 call
      sites) sync with the serial worker through a new thread's ref 0. Use a deleted thread
      instead: create and delete `other`, and wait until `GatedRewind::close_terminals` has
      seen it. The worker calls `cleanup_deleted_thread` (`orchestration_effects.rs:1953`)
      for that. The tests using that check keep their meaning: the worker is not blocked.
    - `orchestration_effects.rs` `imported_history_captures_no_turn_baseline` is deleted
      along with `needs_turn_baseline`. Imported history creates no delivery row, so it
      never reaches a baseline. `only_turns_before_checkpoints_refresh_ref_zero` stays.
    - Before implementing, run
      `rg "checkpoint_ref\(.*, 0\)|wait_for_git_ref|turn/0" apps/server` again to find any
      other test that relies on the worker's ref 0.

Validation:

- `node scripts/run-msvc.mjs cargo test -p bibcode-server turn_delivery`, then the same for
  `orchestration_effects`, `orchestration_rpc` and `mcp_tools_tests`.
- `cargo test -p bibcode-server --test production_orchestration_effects --test
  production_provider_runtime`, then the full `-p bibcode-server` suite.
- `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`,
  `vp check` and `vp run typecheck`.
- Show tests 1, 2 and 4 red before the change.

### Documentation

- `docs/architecture/rpc-and-orchestration.md`, Turn checkpoints. The opening sentence (the
  checkpoint is "written by the orchestration effects worker") gains "except ref 0". Step
  1 becomes: turn delivery captures ref 0 in a baseline stage before a thread's first turn
  is first claimed. The stage runs outside the delivery slots, is bounded by the hold
  limit, and is reported as `checkpoint.capture.failed` if it fails. A late write can only
  publish the pre-turn snapshot. Step 4 covers restarts.
- `docs/testing/`: no commands or targets change. Review it, and expect it to stay accurate.

### Residual risks

- A hung Git delays that thread's first turn by up to 120 s, the bound a turn-end capture
  already holds a thread for. Other threads are not delayed, unless more than four
  first-turn captures hang at once. Then later first turns also wait for a baseline permit.
- A first turn now waits for a few Git processes before it starts, typically tens to
  hundreds of milliseconds, plus one delivery-loop wake. Before, that time was spent on the
  worker. Later turns pay nothing.
- After a stalled spawn, ref 0 can appear after its failure was reported. It holds the
  pre-turn checkout (step 6), but turn 1 keeps the `diffAvailable: false` it was captured
  with.
- A setup script that the bootstrap started may still be writing files during the capture.
  Ignored output is not captured. Tracked or untracked non-ignored output may land in ref 0
  or in turn 1, as before.
- The worktree-root case (consequence 3) is inferred from source. Its test will show
  whether it really happens today.
