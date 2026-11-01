# Turn Checkpoint Residuals (#234, #235, #236)

Status: Proposed 2026-11-01, revised the same day after a Codex review (REVISE, three P2
defects in the #234 retry lifecycle; see "Review findings" at the end). It needs approval
before implementation. It covers three residuals the PR #213 review accepted. Verified at
`9c8799b80` (`origin/main`, v0.14.0), and line references are to that commit. Paths are
under `apps/server/src/` unless they name another package.

Implementation order: #235 (the `diffAvailable` flag), then the trusted-baseline rule that
#236 and #234 share, then #234's hold and revert guards. The three can share one branch.

## Shared vocabulary

- **Capture valid**: ref `n` is turn `n`'s end state. Revert to `n` needs this.
- **Diff available**: ref `n - 1` is a trusted baseline for turn `n`, so the patch
  `n - 1..n` is turn `n`'s change. A one-turn patch needs this.
- Today `ready` means both, `missing` means neither (or not yet), and `error` means given
  up for good (terminal in the projector, `orchestration/engine.rs:8064-8071`).
- **Trusted baseline** (new, shared by #236 and #234): ref 0, or ref `n` of a `ready` row.
  Ref `n >= 1` is then written only by turn `n`'s own capture, while turn `n`'s hold keeps
  every later turn out of the checkout. That is the only time the checkout is known to be
  turn `n`'s end state. Turn-start baselines write ref 0 only.

---

## #235: a captured turn with a missing baseline cannot be reverted to

### Current behavior

- `record_checkpoint` writes turn `n`'s own ref first
  (`production/orchestration_effects.rs:1515-1535`). It then returns `Err` when ref
  `n - 1` is absent or turn `n - 1` is `error` (`:1565-1576`). The row stays `missing`,
  and the caller appends a `checkpoint.capture.failed` activity
  (`:741-750`).
- `plan_revert` accepts only `ready` (`:1705-1709`), and MCP's revert preflight does the
  same (`mcp/tools/threads.rs:995-1008`). So a turn with a valid end-state ref cannot be
  reverted to.
- `orchestration.diff` requires `ready` at each end of the range. It trusts the start of a
  one-turn range because the end is `ready` (`production/orchestration_rpc.rs:965-987`).
  MCP `get_turn_diff` requires `ready` (`mcp/tools/threads.rs:1363-1374`), and
  `latest_checkpoint(captured = true)` picks the newest `ready` row
  (`mcp/tools/threads.rs:1481-1499`).
- Wire: `OrchestrationCheckpointStatus = "ready" | "missing" | "error"`
  (`packages/contracts/src/orchestration.ts:477`). It is used by the summary (`:480-488`),
  the command (`:1187-1198`) and the event payload (`:1489-1498`).
- Client: the reducer keeps a non-`missing` row over a later `missing` one, and maps every
  status to `completed` (`packages/client-runtime/src/state/threadReducer.ts:522-536`,
  `:701-712`). The timeline shows changed files only when `files` is non-empty
  (`apps/web/src/components/chat/MessagesTimeline.tsx:1827-1851`). A turn with no
  baseline therefore looks the same as a turn that changed nothing.

### Options

| Option                                                                                    | Wire / contract                                                                                                                           | Persisted shape                                                            | Trade-off                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. New status literal `captured` (end state valid, no diff)                               | Adds a new `OrchestrationCheckpointStatus` literal. An older client decodes the literal strictly and rejects the whole snapshot or event. | None (TEXT value)                                                          | `docs/architecture/remote.md` already refused a new literal for this reason. A remote server newer than its client is a supported setup, so this option is rejected.                                                                                                                                                                                 |
| B. Keep `ready` = capture valid, add an additive `diffAvailable` flag                     | Optional `diffAvailable?: boolean` on the summary, the payload and the command. Absent means `true`. Older clients ignore the key.        | One additive column `checkpoint_diff_available INTEGER NOT NULL DEFAULT 1` | One migration. An older binary already refuses a newer ledger (`persistence/migrations.rs:163-174`), so a downgrade cannot misread a `ready` row that has no diff. Existing rows need no backfill: every existing `ready` row was recorded with a baseline.                                                                                          |
| C. Keep `ready` = capture valid and derive diff availability at read time (no stored bit) | None                                                                                                                                      | None                                                                       | The diff RPC would check that row `n - 1` is not `error` and that ref `n - 1` resolves, which repeats the capture-time rule. But a missing from-ref falls back to legacy diff blobs (`orchestration_rpc.rs:1035-1049`). The client cannot tell "no diff" from "no changes", so the acceptance criterion ("shows no diff available") fails in the UI. |

### Recommendation: B

- `record_checkpoint`: when the baseline is unusable (`:1565-1576`), record `ready` with
  `files: []` and `diffAvailable: false` instead of returning `Err`. Unusable means the
  trusted-baseline rule fails: `n - 1 >= 1` and row `n - 1` is not `ready` (`missing` or
  `error`; this replaces today's `previous_given_up` check), or ref `n - 1` does not
  resolve. Append the
  `checkpoint.captured` activity with tone `warning` and the detail "The checkpoint before
  turn n is missing, so this turn's changes cannot be shown. You can still revert to it."
  A turn whose own capture failed still returns `Err` and stays `missing`.
- Command, event and projector: `ThreadTurnDiffComplete` gains
  `diff_available: bool` (serde default `true`). The event payload
  (`orchestration/engine.rs:5354`) emits `"diffAvailable": false` only when it is false, so
  existing fixtures stay valid. The projector (`:8080`) writes the column, and an `error`
  row keeps `1`.
- Migration 63 `ProjectionTurnCheckpointDiffAvailable`: `ALTER TABLE projection_turns ADD
  COLUMN checkpoint_diff_available INTEGER NOT NULL DEFAULT 1`. Also update
  `ProjectionCheckpoint` and `decode_checkpoint` (`persistence/repositories.rs:3107-3116`,
  `:4468-4479`), the selects at `:1608` and `:1615`, the checkpoint upsert at `:1602`, the
  ledger name test (`persistence/migrations.rs:4023-4036`), and the snapshot mapping.
  Other v0.15 slices may also claim id 63, and the coordinator renumbers at merge.
- Revert: keep `plan_revert` and the MCP preflight on `ready`. `ready` now means
  "capture valid", so they need no change.
- Diff reads:
  - `orchestration.diff` keeps `ready` for both range ends. It trusts the start of a
    one-turn range only when the end has `diffAvailable`. Otherwise it refuses with the
    new `no_baseline_diff_detail(n)`: "Turn n has no diff: the checkpoint before it is
    missing. You can still revert to it."
  - MCP `get_turn_diff` refuses such a turn with `McpNoTurnDiffError` and the same detail.
  - `latest_checkpoint(captured = true)` adds `AND checkpoint_diff_available = 1`.
  - Multi-turn and full-thread ranges whose two ends are `ready` still work, because both
    refs are end states.
- Contracts: add `diffAvailable: Schema.optional(Schema.Boolean)` to
  `OrchestrationCheckpointSummary`, `ThreadTurnDiffCompletedPayload` and
  `ThreadTurnDiffCompleteCommand`. The reducer copies it through. Consumers read it as
  `diffAvailable !== false`.
- Web: for a `ready` summary with `diffAvailable === false`, the assistant message shows
  one muted line where changed files would be: "Changes can't be shown for this turn: the
  checkpoint before it is missing." Its revert control is unchanged. This change needs the
  `UI.md` review and the `vercel-react-best-practices` review.

### Tests (acceptance)

- Server, effects, new:
  `a_turn_without_its_baseline_is_ready_without_a_diff_and_can_be_reverted_to` in
  `apps/server/tests/production_orchestration_effects.rs`. It deletes ref `n - 1` before
  turn `n` is captured. It asserts that row `n` is `ready` with `files == []` and
  `diff_available == false`, then reverts to `n` and asserts the files are restored.
- Server, rewritten:
  `a_stale_captures_leftover_ref_never_makes_the_next_turn_ready`
  (`production/turn_delivery_queue_tests.rs:1451`) becomes
  `a_stale_captures_leftover_ref_is_never_the_next_turns_diff_baseline`. It asserts that
  turn 4 is `ready` with `diffAvailable: false`, that a revert to 4 restores `"four\n"`,
  and that `orchestration.diff` 3..4 is refused with the no-baseline detail.
- RPC, new: `a_one_turn_diff_without_a_baseline_is_refused_but_a_wider_range_is_served`
  next to the existing `orchestration_rpc.rs` diff tests.
- MCP, new:
  `get_turn_diff_refuses_a_turn_without_a_baseline_and_revert_accepts_it` in
  `production/mcp_tools_tests/thread_actions.rs`.
- Regression guard, kept: `revert_to_an_uncaptured_turn_is_refused_even_with_its_ref`
  (`production/mcp_tools_tests/thread_actions.rs:690`) and
  `revert_with_a_missing_checkpoint_fails_before_the_provider_rewinds`
  (`tests/production_orchestration_effects.rs:1161`). Together they prove that a turn
  whose own capture failed is still refused.
- Persistence: the migration ledger test, plus a round-trip test that `get_checkpoint`
  reads the column back.
- Contracts: a decode test in `packages/contracts` for a summary with and without
  `diffAvailable`. It also checks that a schema without the field ignores the key, which
  is what an older client does.
- Client: a `threadReducer.test.ts` case that keeps `diffAvailable: false`. A
  `MessagesTimeline` test that renders the no-diff line.

---

## #236: two Git failures on one turn number leave a later diff read against a leftover

### Current behavior

- When turn `n`'s capture fails, `record_checkpoint` deletes ref `n`, which may be a
  leftover from a reverted turn. When that delete also fails, it only logs a warning
  (`orchestration_effects.rs:1515-1535`; `delete_ref` is at `:2259-2282`). The row stays
  `missing`.
- At turn `n + 1`'s start, `ensure_baseline` writes ref `n` only when it is absent
  (`:1211-1221`), so it keeps the leftover. Turn `n + 1`'s capture then diffs against it
  (`:1565-1578`) and records `ready`. The patch is wrong, but the revert target (ref
  `n + 1`) is right.

### Options

| Option                                                                                             | Trade-off                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Retry the delete with a bound (for example 3 tries, 100 ms apart)                               | Covers a transient ref lock. A lock held longer, or a Git failure that is not transient, still leaves the leftover. It reduces the hole but does not close it.                                                                                                                                                                              |
| B. Mark the number in memory (as with the stale set) so the next baseline overwrites ref `n`       | A restart loses the mark, which is the #234 problem again. Overwriting from a `missing` row is not safe either: the baseline runs on the effects worker, unordered with the delivery of the turn it is for (see #234), so it can capture that turn's edits.                                                                                 |
| C. Give the turn up durably: when the capture and the delete both fail, record turn `n` as `error` | The first revision's choice. It needs a claim against the hold's expiry and a second record, and that record can fail on its own (a residual the first revision accepted).                                                                                                                                                                  |
| D. Trust only a `ready` predecessor (the trusted-baseline rule)                                    | The row that is already written is the durable mark: a capture that failed leaves row `n` `missing`, so turn `n + 1`'s capture never reads ref `n`, leftover or not. No new state, record, claim or failure mode. The same rule closes #234 (see there). With #235, turn `n + 1` is `ready` without a diff, so it can still be reverted to. |

### Recommendation: D

- `record_checkpoint` uses the trusted-baseline rule for ref `n - 1` (the #235 bullet
  above). A leftover ref `n` behind a `missing` or `error` row is never a baseline.
- `ensure_baseline` writes ref 0 only (#234, rule 1), so no baseline overwrites or keeps a
  leftover as a diff start.
- The failed delete keeps its `tracing::warn!`. The leftover stays in Git until a revert or
  a later capture of number `n` replaces it, as today. It is harmless, because nothing
  reads it.
- Turn `n + 1` loses its diff whenever turn `n`'s capture did not complete, not only after
  two Git failures. That is #234's trade-off, stated there.

### Tests (acceptance)

- New: `a_failed_capture_whose_leftover_ref_cannot_be_deleted_is_never_a_baseline` in
  `production/turn_delivery_queue_tests.rs`, using `RevertFixture`.
  - Setup: plant a leftover ref 3 (`capture_checkpoint` of `"leftover\n"`), then create
    `<git dir>/<checkpoint_ref("t", 3)>.lock`. This makes both the capture's
    `update-ref` and the `update-ref -d` fail, which is the "ref lock held across both
    steps" the issue asks for. End turn 3.
  - Assert: row 3 is `missing`, and there is one `checkpoint.capture.failed` activity.
  - Then remove the lock and run turn 4 (start, edit, end). Assert: ref 3 still resolves
    to the leftover. Row 4 is `ready` with `diffAvailable: false`. The
    `orchestration.diff` 3..4 is refused. A revert to 4 is accepted, and a revert to 3 is
    refused.
- Guard, new:
  `a_failed_capture_leaves_its_ref_unwritten_and_the_next_turn_revertible_without_a_diff`.
  Turn 3's capture fails without a leftover. Then turn 4 starts after its edits are
  already in the checkout. Sync on the worker with `other_thread_gets_its_baseline`, so
  turn 4's baseline event has been handled. Assert that ref 3 does not resolve. Then end
  turn 4 and assert that row 4 is `ready` with `diffAvailable: false` and that a revert
  to 4 restores its files. This replaces the first revision's guard, which asserted that
  the next baseline writes ref 3.

---

## #234: a failed write of the `error` status still releases the thread

### Current behavior

- `expire_stale_hold` (`orchestration_effects.rs:1368-1430`) marks the turn stale in
  memory through `expire_checkpoint_hold` (`orchestration/engine.rs:2840-2858`). It then
  writes `error` once (`orchestration_effects.rs:1402-1406`). On failure it only logs a
  warning, and then releases the hold anyway (`:1407`).
- The capture worker also releases the hold however its capture ends:
  `CheckpointHoldRelease` is taken at `:1050-1058` and releases on drop (`:1270-1275`).
  That includes the stale error it returns at entry (`:1507-1509`) or after a lost claim
  (`:1539-1551`). So the release can come before the expiry's write lands, even today
  (review finding 1).
- `ensure_baseline` (`:1159-1221`) writes ref `n` (the latest number) when it is absent,
  unless row `n` is `error` or stale in memory (`:1195-1210`). It runs on the effects
  worker (`:1041-1045`). Delivery checks only the hold before it claims and sends the turn
  (`production/turn_delivery.rs:1399-1415`), so nothing orders a baseline before the turn
  it is for. A baseline that writes ref `n >= 1` can therefore capture the next turn's
  edits whenever the worker is behind. Three cases reach it:
  - a restart, which loses the stale marks (review finding 2);
  - an ordinary failed capture, with no restart;
  - a turn cut off by a restart, whose ref the next baseline is meant to capture
    (`production/provider_runtime.rs:2787-2790`).
- A revert does not consult holds (`plan_revert`, `:1643-1711`). `thread.reverted` deletes
  the rows above the target (`orchestration/engine.rs:8103-8110`). A later
  `thread.turn-diff-completed` for a deleted turn inserts its row again
  (`orchestration/engine.rs:8080-8100`, `TURN_UPSERT_SQL`). That brings back a reverted
  turn and raises the thread's current number, which a later revert's provider rewind
  counts (`orchestration_effects.rs:1684-1733`). Only the expiry writes records from
  outside the serial worker, so today the window is one dispatch. A retry loop would make
  it unbounded (review finding 3).
- History is not replayed across a restart. The effects producer starts at the log head
  (`:473-476`, `:548-549`), so a `missing` row whose capture had not completed is never
  captured later.

### Options

| Option                                                                                                   | Trade-off                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Bounded retry, then release (today's behavior after N tries)                                          | Shrinks the window but keeps the hole: "released but not durable" is still reachable.                                                                                                                                                                                                                                                                                                      |
| B. Persist the stale mark somewhere else (a file or another table)                                       | Adds a second source of truth. It fails in the same situation as the first, because it uses the same disk and database.                                                                                                                                                                                                                                                                    |
| C. Keep the hold until `error` is durable (retry with capped backoff)                                    | The first revision's choice. The review found three defects: the worker still releases the hold early (finding 1); a restart is not safe, because the baseline is not ordered before delivery (finding 2); a pending retry brings back a turn that a revert removed (finding 3). Fixing all three needs a transfer of release ownership, delivery fencing and revert-aware retries.        |
| D. Fence delivery behind its baseline                                                                    | Fixes the baseline race for every ref, ref 0 included, and keeps diffs after an incomplete capture. But it puts Git calls on the turn-start path (or makes delivery wait on a watermark of the effects worker, which is serial across all threads, so one hung Git would delay every thread). It also moves baseline ownership out of the worker. Larger, and it costs turn-start latency. |
| E. Make durability unnecessary: baselines write ref 0 only, and captures trust only `ready` predecessors | Deletes the permission that a `missing` row granted, instead of making the `error` record durable. No retry, no new state, and a restart cannot change the outcome. Cost: the turn after an incomplete capture has no diff (below).                                                                                                                                                        |

### Recommendation: E

The defect behind #234 is that a `missing` row let a baseline write ref `n` later, from a
checkout that might already hold the next turn's edits. Remove that permission, and the
`error` record no longer has to be durable for correctness:

1. **Baselines write ref 0 only.** `ensure_baseline` returns once `turn_count >= 1`. The
   `latest_went_stale` block (`:1195-1210`) and its `error` and stale checks are deleted.
   Ref 0 (a thread's first turn, or the thread whose turns predate checkpoints) is
   unchanged.
2. **Captures trust only `ready` predecessors** (the trusted-baseline rule, shared with
   #235 and #236).
3. **The expiry writes `error` once**, as today, with no retry or loop. On failure it logs
   `tracing::warn!` (thread id, turn number and error) and the row stays `missing`. That
   is now safe:
   - a revert refuses it (`plan_revert` accepts only `ready`);
   - it is never a baseline (rule 2), and no baseline writes its ref (rule 1);
   - it is never captured later, because the stale mark blocks the worker before a
     restart, and history is not replayed after one.
     The `error` record and its activity remain the user-visible record when the database
     accepts them.
4. **A stale turn's hold is released only by its expiry task**, after its single write
   attempt. `CheckpointHoldRelease::drop` skips the release when
   `engine.checkpoint_is_stale(thread, turn)`. `expire_checkpoint_hold` sets the mark
   under the hold lock before it returns `true`, and the task then always reaches its
   release. Thread deletion (`:1068-1071`) and effects shutdown (`engine.rs:2790-2799`)
   still release every hold. This resolves finding 1 as the review suggests, although
   rule 3 already makes an early release harmless for baselines. Rule 5 needs it.
5. **A revert waits out the hold.** `plan_revert` refuses while
   `engine.turns_held_for_checkpoint(thread)`, with
   `checkpoint_record_pending_detail()`: "The last turn's checkpoint is still being
   recorded. Try the revert again in a moment." Every checkpoint record of a turn lands
   before its hold is released: the worker records before its guard drops, and the expiry
   by rule 4. So no record can land after a revert and bring a row back. The serial worker
   already orders a revert after the thread's earlier captures (`:858-920`), so the
   refusal is reachable only while an expiry's write is in flight. MCP's preflight needs
   no change, because it reports the effects refusal.

Trade-off, recorded in `docs/architecture/rpc-and-orchestration.md` (Turn checkpoints):
the turn after one whose capture did not complete (it failed, timed out or was cut off by
a restart) is `ready` without a diff (#235). It is still revertible. It does not get a
diff from a late baseline that may contain its own edits. Today that diff depends on a
race and can be wrong. Option D is the follow-up if diffs after incomplete captures, or
the same race on ref 0, turn out to matter.

The issue asks whether holding forever on a failing database is worse than releasing. It
no longer has to choose: the thread is released after one write attempt, and nothing is
lost if that attempt fails. Acceptance takes the test branch of the issue: the
`error` write fails, the server restarts, and the next baseline never writes that turn's
ref.

### Tests (acceptance)

Fault injection uses a SQLite trigger through `engine.repositories().database().call(..)`,
following the existing precedent (`production/mcp_tools_tests/foundation.rs:1130`):
`CREATE TRIGGER fail_stale BEFORE UPDATE ON projection_turns WHEN NEW.checkpoint_status =
'error' BEGIN SELECT RAISE(ABORT, 'injected'); END`. Confirm while implementing that a
projection abort fails `dispatch` without degrading the engine. If it degrades the
engine, inject the failure at the command decider instead.

- New: `an_unwritten_stale_record_releases_the_thread_and_never_becomes_a_baseline` in
  `production/turn_delivery_queue_tests.rs`. Use a 200 ms hold limit, a hung capture
  (`hold_workspace`) and the trigger.
  - Assert that the queued follow-up is received after the expiry, and that row 3 is
    `missing`.
  - Then resume the hung capture while the trigger is still installed (the review's
    "resume the capture while the write still fails"). Sync with
    `other_thread_gets_its_baseline`. Assert that row 3 is still `missing` and that ref 3
    does not resolve.
  - Write `"four\n"` and end turn 4. Assert that ref 3 still does not resolve, that row 4
    is `ready` with `diffAvailable: false`, that a revert to 3 is refused ("no captured
    checkpoint"), and that a revert to 4 restores `"four\n"`.
- New: `a_restart_after_an_unwritten_stale_record_never_writes_that_turns_ref`, modeled on
  `a_stale_turn_is_never_a_revert_target_after_a_restart`
  (`turn_delivery_queue_tests.rs:1587`).
  - Restart with the trigger in place. Assert that row 3 is `missing` and that the engine
    has no stale mark.
  - Write `"four\n"` before turn 4's `thread.turn.start` is dispatched. The checkout then
    already holds turn 4's edits when its baseline event is handled, which is the order
    of a delivery that beats its baseline (finding 2).
  - Sync with `other_thread_gets_its_baseline`. Assert that ref 3 does not resolve.
  - End turn 4. Assert that row 4 is `ready` with `diffAvailable: false`, and that a
    revert to 3 is refused.
- New: `a_stale_captures_worker_leaves_the_hold_to_its_expiry`. Use a long hold limit, so
  the real expiry does not fire.
  - Take a hold with `engine.hold_turns_for_checkpoint("t", "turn-3")`, and mark it stale
    with `engine.expire_checkpoint_hold(.., id)`. This is the expiry with its write still
    pending, by construction.
  - Dispatch the `missing` record and sync on the worker. Assert that
    `turns_held_for_checkpoint("t")` is still true and that the queued follow-up is not
    received.
  - Then `release_checkpoint_hold`, and assert that the follow-up is received.
- New: `a_revert_is_refused_while_a_stale_record_holds_the_thread`. Use the same setup
  with a ready turn 2.
  - Request a revert to 2. Assert one `checkpoint.revert.failed` with the pending-record
    detail, that row 3 still exists, and that the provider was not rewound.
  - Write the `error` record and release the hold, as the expiry does. Then revert to 2
    again, and assert that it succeeds and that row 3 is gone. This test covers finding 3.
- Kept:
  - `an_expired_hold_records_the_pending_checkpoint_stale_and_releases_the_thread`
    (`:1389`);
  - `an_expiry_during_a_taken_capture_reports_nothing_and_the_turn_is_ready` (`:1529`);
  - `a_stale_turn_is_never_a_revert_target_after_a_restart` (`:1587`). Update its
    comment: the baseline does not write ref 3 because ref 3 has a number, not because the
    row is `error`.
- Dropped from the first revision:
  `a_stale_record_that_cannot_be_written_keeps_the_thread_held_until_it_is` and
  `deleting_a_thread_ends_its_stale_record_retry` (there is no retry).

---

## Documentation and coverage for the implementation

- `docs/architecture/rpc-and-orchestration.md`:
  - Turn checkpoints, step 1: a turn start writes ref 0 only; it never writes a numbered
    ref.
  - Step 3:
    - `ready` means capture valid, with `diffAvailable`;
    - ref `n - 1` is a diff start only from a `ready` row, or ref 0;
    - the turn after an incomplete capture has no diff (the trade-off);
    - the expiry writes `error` once, and a stale turn's hold is released only by its
      expiry.
  - Step 4: the next baseline no longer captures a cut-off turn's ref. Also update the
    comment at `production/provider_runtime.rs:2787-2790`.
  - Turn patches, step 0: the start of a one-turn range is trusted only with
    `diffAvailable`.
  - Checkpoint revert, step 1: a `ready` turn without a diff can be reverted to, and a
    revert is refused while a checkpoint hold stands.
- `docs/reference/mcp.md`: the new `get_turn_diff` refusal.
- `docs/testing/`: review it. No commands or targets change, so the runbooks are expected
  to stay accurate.
- Profiler: no new child process, RPC method, removal path or binary mode. New failures
  are logged with `tracing::warn!` at the effects boundary, and no profiler event or
  finding changes.
- Residual risks:
  - The turn after an incomplete capture has no diff (#234 trade-off).
  - The ref 0 baseline still runs on the effects worker, unordered with the first turn's
    delivery. This race existed before this change and is not changed by it. Option D is
    the fix, and it should get its own issue.
  - Old `missing` rows that are really captured without a baseline are not backfilled.
    They stay refused, as they are today. An old `missing` predecessor whose ref a
    baseline wrote under the old rule is no longer a diff start.
  - Migration id 63 may collide with another v0.15 slice.

## Review findings (Codex, first revision)

| Finding                                                              | Verified against source                                                                                                      | Resolution                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The capture worker releases the hold before the record is durable | Yes: `orchestration_effects.rs:1050-1058`, `:1270-1275`, `:1507-1509`, `:1539-1551`. It also happens today, without a retry. | Rule 4: a stale turn's hold is released only by its expiry. Rules 1-3 make a release before durability harmless for baselines. Test: `a_stale_captures_worker_leaves_the_hold_to_its_expiry`. |
| 2. A restart does not guarantee a safe baseline                      | Yes: `turn_delivery.rs:1399-1415` against `orchestration_effects.rs:1041-1045`. Also reachable without a restart (see #234). | Rule 1: no baseline writes a numbered ref, so ordering cannot matter. Test: `a_restart_after_an_unwritten_stale_record_never_writes_that_turns_ref`, with the edits in the checkout first.    |
| 3. A pending retry brings back a turn that a revert removed          | Yes: `engine.rs:8080-8100`, `:8103-8110`. The window is one dispatch today.                                                  | No retry exists any more. Rules 4-5 make every record land before the release, and a revert waits for the release. Test: `a_revert_is_refused_while_a_stale_record_holds_the_thread`.         |
