# Checkpoint Delivery Fencing (#261)

Status: Proposed 2026-11-02 (awaiting review)

Follow-up to #234, #235 and #236 (PR #247): option D of
`docs/plans/2026-11-01-turn-checkpoint-residuals-design.md`. Verified at `main`
(`9c8799b80`) with `origin/v015/234-236-checkpoints` merged (`f83c9e849`). PR #247's
rules are assumed: a baseline writes ref 0 only, and a diff comes only from a trusted
baseline (ref 0, or the ref of a `ready` predecessor). Paths are under `apps/server/src/`.

## Problem

A thread's ref 0 is written by the serial effects worker, while turn delivery starts the
turn on its own. Nothing orders the two, so the agent can edit the checkout before ref 0 is
captured.

### Current behavior

- **Delivery** (`production/turn_delivery.rs`). Selection skips a thread whose ended turn is
  held for its checkpoint (`:1038`). `prepare_claim_and_deliver` runs a start's bootstrap
  (worktree, setup script) (`:1386`). It then takes the thread's turn reservation (`:1393`),
  checks the hold again (`:1401`), claims the row (`:1406`) and sends the turn (`:1415`).
  The claim sets `state = 'sending'` and increments `attempts`
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
- R2: once the delivery is claimed, nothing writes ref 0 for the thread, so a ref 0 always
  shows the checkout before the turn.
- R3: the wait is bounded and a failure is shown to the person, without losing the turn.
- R4: no Git call and no wait when the thread already has a numbered turn (the issue's "no
  added latency when the baseline already exists").
- R5: a restart, with a pending row from before it or with a slow worker after it, keeps R1.
- R6: shutdown cancels the wait without claiming, and leaves the row pending.

## Options

| Option                                                                                                                                                                                                                                                                                           | Trade-offs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Delivery waits on a per-thread barrier the worker clears.** The engine marks the thread "baseline pending" when it commits a baseline event. Delivery skips the thread, as it does for a checkpoint hold, until `ensure_baseline` clears the mark or the bound expires.                     | Git stays on the worker, which remains the only writer. But the mark is in memory and history is not replayed. A restart needs a new startup pass that finds pending first turns and queues their baselines. The decider cannot cheaply tell whether a baseline is needed (Git, turn numbers), so it marks every turn start, and each one waits for the worker. That adds latency to every turn, which breaks R4 unless the marking is made more complex. The worker is serial, so one thread's hung Git delays every other thread's first turn up to the bound. When the bound expires, the worker still captures later, from a checkout that may hold edits, which breaks R2 unless it also checks the row's claim state. Three new mechanisms. |
| **B. Delivery captures ref 0 itself, before the claim (recommended).** `prepare_claim_and_deliver` captures the baseline under the thread's turn reservation, after the hold check and before `claim_provider_turn`. The worker's two baseline arms are deleted, so delivery is the only writer. | R1, R2, R5 and R6 follow from where the call sits: every pending row goes through this path, the first claim included, and the reservation already orders the capture before the claim. The bootstrap runs first, so the worktree case is fixed. Git (2–6 processes) runs on the turn-start path, but only for a thread with no numbered turn. It runs per thread, in parallel with other deliveries, and no longer queues behind other threads on the serial worker. Costs: a hung capture holds one of the four delivery permits (`MAX_CONCURRENT_THREADS`) for up to the bound, and the tests that use a new thread's baseline to sync with the worker need another sync point.                                                                |
| **C. Ref 0 from the pre-turn state the provider reports.**                                                                                                                                                                                                                                       | No provider reports the checkout before a turn. Rebuilding it by reversing the reported file changes misses edits made by shell commands, formatters and setup scripts. It would also differ between Codex, Claude and OpenCode. Rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B′. B, keeping the worker's arm as a fallback.                                                                                                                                                                                                                                                   | After a failed or timed-out delivery capture, the worker would still write ref 0 later, possibly from an edited checkout, which is today's bug. Guarding against that means the worker takes the thread reservation and checks the row is unclaimed. That blocks the serial worker on a provider handoff. Rejected: two writers for one ref.                                                                                                                                                                                                                                                                                                                                                                                                      |

## Recommendation: B

### Design

1. **One writer.** Delete the two `process_event` arms (`orchestration_effects.rs:1041-1046`)
   along with `needs_turn_baseline` and the `Baseline` enum. `ensure_baseline` becomes
   `ensure_first_turn_baseline(repositories, callbacks, thread_id, message_id,
   cancellation) -> BaselineOutcome`. It and `resolve_workspace` take `&Repositories`
   instead of the engine, because `ProductionBootstrapEffects` (`:277`) holds no engine.
   `had_turns_before_checkpoints` and the predate rule are unchanged. A queued message is
   baselined when it is delivered, so the message-sent variant has nothing left to do.
2. **The seam.** Add one method to `ThreadTurnBootstrapEffects` (`orchestration/engine.rs:316`):
   `capture_first_turn_baseline(thread_id, message_id, limit, cancellation)`. The existing
   delivery-to-effects hook is the bootstrap. When no bootstrap effects are registered, or
   `engine.checkpoint_hold_limit()` is `None`, no effects worker records checkpoints, so
   delivery skips the step, as checkpoint holds already do.
3. **Call site** (`turn_delivery.rs`). After the hold check (`:1401`) and before the claim
   (`:1406`), still under `_reservation`, call it only for
   `row.mode == TurnDeliveryMode::Start && row.attempts == 0`. A steer joins a running turn
   that already has its baseline. A row with `attempts > 0` was claimed before, so the
   checkout may already hold its edits, and it never captures (R2 across retries and
   restarts).
4. **Fast path (R4).** First read the thread's turns (one indexed SQLite read). If an
   earlier turn has a number, return without Git or any wait. Otherwise resolve the
   workspace and check for `.git` with `in_git_checkout`, a filesystem walk that
   `record_turn_end` already uses. If `.git` is missing, return. Only then spawn Git
   (`is_git_repository`, `has_ref`, capture). A project outside Git therefore pays nothing
   per turn, and a Git thread pays once, at its first turn.
5. **Bounded wait (R3).** The bound is `engine.checkpoint_hold_limit()`
   (`EffectsOptions::checkpoint_hold_limit`, 120 s by default), the same bound a thread
   already waits for a turn-end capture. Tests can already set it, and no new setting is
   added. The step uses `token = stop_claiming.child_token()`, and a timer cancels it at the
   bound. Each non-Git await (the turn read and `workspace_for_thread`) is raced against
   the token, and the Git steps already honor it (`capture_checkpoint_with_cancellation`,
   `:2048`). The step is **awaited to its end before the claim**. So no Git process it
   started outlives the claim, and the temporary index is removed. Any ref it wrote came
   from a tree read before the claim. A ref that lands in the moment of cancellation is
   still a correct ref 0.
6. **Error (R3).** `Failed(reason)` and `TimedOut` are reported once:
   - `tracing::warn!(thread_id, elapsed_ms, error, "a first turn's checkpoint baseline was
     not captured; the turn goes on without one")`;
   - one `checkpoint.capture.failed` activity (tone `error`, `turnId: null`, payload
     `{turnCount: 0, detail}`), the kind and shape the worker's failure path uses today
     (`:1975-2000`). The detail says what happened and what follows: "The checkout before
     this thread's first turn could not be recorded (timed out after 120 seconds | <Git
     error>), so that turn's changes cannot be shown. Check that Git works in this folder."

   Delivery then claims and sends the turn. Checkpoints support the turn, so a broken or
   hung Git must not block the person's turn. PR #247 makes a missing ref 0 safe: turn 1 is
   `ready` with `diffAvailable: false` and can be reverted to. With one writer that writes
   only before the claim, a wrong ref 0 can no longer appear later.

7. **Cancellation (R6).** If `stop_claiming` fires (shutdown) during the step, it returns
   `Err("provider delivery claim cancelled")` like the reservation wait (`:1393-1398`). The
   row stays `pending` with `attempts = 0`, no activity is written, and the next start runs
   the baseline again. `force_cancel` is not involved before the claim. A thread deleted
   during the step has its row settled by the existing deletion paths, and the claim then
   finds nothing.
8. **Restart (R5).** No new mechanism. A row left pending by a restart takes the same path
   with `attempts = 0`, so its baseline is captured before its first claim, wherever its
   start event sits relative to the worker's floor. A row that was `sending` goes through
   `recover_sending` (`turn_delivery.rs:870`) and never through a baseline. If recovery
   returns it to `pending` (attempts > 0), rule 3 skips the baseline. Turn-end captures,
   holds and their expiry are unchanged.
9. **Load.** At most one capture per thread runs at a time (the reservation), and at most
   four in total (the delivery permits). The worker no longer spawns Git for turn starts,
   so its backlog is smaller. The reservation also delays a revert of that thread while
   the capture runs. A thread with no numbered turn has no revert target, so nothing is
   lost.

### Profiler, crash and trace coverage

- RPC: no method is added or changed. No RPC handler waits for a delivery claim. The only
  `wait_for_delivery_state` is a test helper (`production/orchestration_rpc.rs:4384`), and
  MCP's waiting tools are already long-running. So `is_long_running` does not change: delivery
  is a background task, not a handler.
- Child processes: the capture uses the existing `run_git` and `ProcessRunner` path
  (supervised, cancellable), which is unchanged.
- Trace: `tracing::warn!` on failure or timeout (step 6), and `tracing::debug!(thread_id,
  elapsed_ms)` when a capture succeeds, so slow first-turn baselines show up in the native
  trace. No profiler event or finding changes, so `docs/skills/bibcode-profiler/references/`
  needs no update.
- No worktree removal, binary mode or shutdown order changes. The step stops with
  `stop_claiming`, which delivery shutdown already cancels before the profiler tears down.

### Tests

All tests are in `production/turn_delivery_queue_tests.rs`, unless marked otherwise, and use
`RevertFixture` (production Git, `GatedRewind` callbacks) with a `TurnDeliveryService`
whose router reports each delivered command. The new thread is `n`, in the fixture's
checkout, whose `tracked.txt` holds `two\n` before `n`'s first turn. Today the
`t`-specific helpers (`checkpoint_of`, `captured`, `turn_patch`) take thread `t` only.
They gain a thread parameter. `GatedRewind` gains `workspace_entered: Notify`, which
announces a held `workspace_for_thread`.

1. `a_first_turn_delivered_while_the_effects_worker_lags_after_a_restart_diffs_its_edit`.
   This is the issue's test, and it fails today.
   - Create the fixture on a file database, then restart: shut down the effects and the
     engine, then reopen both on the same file, as in
     `a_stale_turn_is_never_a_revert_target_after_a_restart`.
   - Delay the worker. Set `hold_workspace`, record turn 3 of `t` ended
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
   regression guard). Thread `t` has numbered turns. Set `hold_workspace` and never
   release it. Enqueue a turn for `t`. Assert that it is received within the usual 3 s and
   that `hold_workspace` is still set, so no workspace lookup and no Git ran.
4. `a_first_turn_baseline_that_fails_is_reported_and_the_turn_still_goes` (R3). Lock ref
   `n/0` (`lock_ref`) so `update-ref` fails. Enqueue `n-first`. Assert that it is received,
   that there is exactly one `checkpoint.capture.failed` activity with `turnCount: 0`, and
   that ref `n/0` does not resolve. Remove the lock, end the turn, and assert that turn 1 is
   `ready` with `diffAvailable: false`.
5. `a_hung_first_turn_baseline_is_given_up_at_the_limit` (R3). Use a 200 ms limit and set
   `hold_workspace`, which the delivery's lookup takes because the worker is idle. Assert
   that the turn is received within the limit plus the usual slack, and that the activity
   says the capture timed out. Release the hold and sync with the worker. Assert that ref
   `n/0` never resolves.
6. `a_shutdown_during_a_first_turn_baseline_leaves_the_turn_unclaimed` (R6). Set
   `hold_workspace`, enqueue `n-first`, and wait for `workspace_entered`. Shut down the
   service, and assert that it returns promptly. Assert that the row is `pending` with
   `attempts == 0`, that there is no activity, and that ref `n/0` does not resolve. Start a
   new service without the hold, and assert that ref `n/0` resolves before the turn is
   received.
7. `a_redelivered_first_turn_never_captures_a_baseline` (R2 across retries). Set row
   `n-first` to `attempts = 1` (SQL through `database().call`, as `fail_stale_records`
   does), with no ref `n/0`. Assert that the turn is received, that ref `n/0` still does not
   resolve, and that there is no activity.
8. Update existing tests:
   - The test helpers `other_thread_gets_its_baseline` and `worker_caught_up` (19 call
     sites) sync with the serial worker through a new thread's ref 0, which the worker no
     longer writes. Use a deleted thread instead: create and delete `other`, and wait
     until `GatedRewind::close_terminals` has seen it. The worker calls
     `cleanup_deleted_thread` (`orchestration_effects.rs:1953`) for that.
     `a_revert_reopening_a_suspended_session_does_not_delay_another_threads_checkpoint` and
     the other tests using that check keep their meaning: the worker is not blocked.
   - `orchestration_effects.rs` `imported_history_captures_no_turn_baseline` is deleted
     along with `needs_turn_baseline`. Imported history creates no delivery row, so it never
     reaches a baseline. `only_turns_before_checkpoints_refresh_ref_zero` stays as it is.

Validation: `node scripts/run-msvc.mjs cargo test -p bibcode-server turn_delivery`,
`... orchestration_effects`, `... orchestration_rpc` and `... mcp_tools_tests`, then the full
`-p bibcode-server` suite. Also `cargo fmt --all --check`,
`cargo clippy -p bibcode-server --all-targets -- -D warnings`, `vp check` and
`vp run typecheck`. Show tests 1 and 2 red before the change.

### Documentation

- `docs/architecture/rpc-and-orchestration.md`, Turn checkpoints. The opening sentence (the
  checkpoint is "written by the orchestration effects worker") gains "except ref 0". Step
  1 becomes: turn delivery captures ref 0 before it first claims a thread's first turn,
  bounded by the hold limit and reported as `checkpoint.capture.failed` if it fails. Step 4
  covers restarts.
- `docs/testing/`: no commands or targets change. Review it, and expect it to stay accurate.

### Residual risks

- A hung Git delays a thread's first turn by up to 120 s, and can take one of the four
  delivery permits for that long. That matches the bound a turn-end capture already holds a
  thread for. A shorter, separate bound is a small follow-up if this is seen in practice.
- A first turn now waits for a few Git processes before it starts, typically tens to
  hundreds of milliseconds. Before, that time was spent on the worker. Later turns pay
  nothing.
- A setup script that the bootstrap started may still be writing files during the capture.
  Ignored output is not captured. Tracked or untracked non-ignored output may land in ref 0
  or in turn 1, as before.
- The worktree-root case (consequence 3) is inferred from source. Its test will show
  whether it really happens today.
