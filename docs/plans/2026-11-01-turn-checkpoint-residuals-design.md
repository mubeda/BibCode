# Turn Checkpoint Residuals (#234, #235, #236)

Status: Proposed 2026-11-01. It needs approval before implementation. It covers three
residuals the PR #213 review accepted. Verified at `9c8799b80` (`origin/main`, v0.14.0),
and line references are to that commit. Paths are under `apps/server/src/` unless they
name another package.

Implementation order: #235, then #236 (which relies on #235 to keep the next turn
revertible), then #234. The three can share one branch.

## Shared vocabulary

- **Capture valid**: ref `n` is turn `n`'s end state. Revert to `n` needs this.
- **Diff available**: ref `n - 1` is a trusted baseline for turn `n`, so the patch
  `n - 1..n` is turn `n`'s change. A one-turn patch needs this.
- Today `ready` means both, `missing` means neither (or not yet), and `error` means given
  up for good (terminal in the projector, `orchestration/engine.rs:8064-8071`).

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
  `files: []` and `diffAvailable: false` instead of returning `Err`. Append the
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

| Option                                                                                             | Trade-off                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Retry the delete with a bound (for example 3 tries, 100 ms apart)                               | Covers a transient ref lock. A lock held longer, or a Git failure that is not transient, still leaves the leftover. It reduces the hole but does not close it.                                                                                                                                                                                                                                                                                           |
| B. Mark the number in memory (as with the stale set) so the next baseline overwrites ref `n`       | A restart loses the mark, which is the #234 problem again. Overwriting from a `missing` row without a mark is not safe either: a queued `thread.message-sent` baseline (`Baseline::Message`) can run while turn `n + 1` runs, and it would overwrite the baseline of the running turn.                                                                                                                                                                   |
| C. Give the turn up durably: when the capture and the delete both fail, record turn `n` as `error` | Reuses the existing terminal state, with no new state and no persisted-shape change, and it survives a restart. `ensure_baseline` already skips an `error` latest turn (`:1198-1210`), and `record_checkpoint` already refuses an `error` previous turn as a baseline (`:1566-1572`). With #235, turn `n + 1` is then `ready` without a diff, so it can still be reverted to. Turn `n + 1` loses its diff only when Git failed twice on the same number. |

### Recommendation: C, without a retry

- When `capture_checkpoint_with_cancellation` fails and `delete_ref` also fails,
  `record_checkpoint` first calls `claim_checkpoint_completion`. If the claim is lost, the
  expiry already writes `error`. If the claim is won, it dispatches
  `dispatch_turn_checkpoint(.., "error", [])` before returning the capture error. The
  claim keeps the expiry from also writing `error` and appending a second activity. The
  record is written before the hold guard is dropped (`:1052-1059`), so no later turn
  starts first.
- If that `error` dispatch itself fails (the database is failing as well), the turn
  stays `missing`. Log it with `tracing::warn!`. This residual needs two Git failures and
  a database failure together, so it is accepted.
- A delete that fails because of cancellation (shutdown) is treated the same way. This
  is conservative: the next turn loses its diff but stays revertible.
- The retry from option A is not needed for correctness. Add it later only if transient
  locks turn out to be common.

### Tests (acceptance)

- New: `a_failed_capture_whose_leftover_ref_cannot_be_deleted_is_given_up` in
  `production/turn_delivery_queue_tests.rs`, using `RevertFixture`.
  - Setup: plant a leftover ref 3 (`capture_checkpoint` of `"leftover\n"`), then create
    `<git dir>/<checkpoint_ref("t", 3)>.lock`. This makes both the capture's
    `update-ref` and the `update-ref -d` fail, which is the "ref lock held across both
    steps" the issue asks for. End turn 3.
  - Assert: row 3 is `error`, and there is one `checkpoint.capture.failed` activity.
  - Then remove the lock and run turn 4. Assert: ref 3 still resolves to the leftover
    (no baseline rewrote it). Row 4 is `ready` with `diffAvailable: false`. The
    `orchestration.diff` 3..4 is refused. A revert to 4 is accepted, and a revert to 3 is
    refused.
- Guard, new:
  `a_failed_capture_without_a_leftover_stays_missing_and_the_next_baseline_writes_its_ref`.
  It proves that the common single failure keeps today's recovery.

---

## #234: a failed write of the `error` status still releases the thread

### Current behavior

- `expire_stale_hold` (`orchestration_effects.rs:1368-1430`) marks the turn stale in
  memory through `expire_checkpoint_hold` (`orchestration/engine.rs:2840-2858`). It then
  writes `error` (`orchestration_effects.rs:1402-1406`). On failure it only logs a
  warning, and then releases the hold anyway (`:1407`).
- The stale set lives only in memory (`engine.rs:2886-2892`). After a restart, the row is
  `missing` and nothing remembers the give-up. If the worker had not yet run turn
  `n + 1`'s baseline, `ensure_baseline` (`orchestration_effects.rs:1195-1221`) can write
  ref `n` from a checkout that already holds turn `n + 1`'s edits. Turn `n + 1`'s patch
  then misses those edits. Revert is still safe, because row `n` is never `ready`.

### Options

| Option                                                                                                                      | Trade-off                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Bounded retry, then release (today's behavior after N tries)                                                             | Shrinks the window but keeps the hole: "released but not durable" is still reachable.                                                                                                                                                                                                                                                            |
| B. Persist the stale mark somewhere else (a file or another table)                                                          | Adds a second source of truth. It fails in the same situation as the first, because it uses the same disk and database.                                                                                                                                                                                                                          |
| C. Keep the hold until `error` is durable: retry with capped backoff, and stop only on success, shutdown or thread deletion | Never releases a thread whose give-up is not durable. A restart before success leaves the row `missing`, but no turn ran since the expiry, so the checkout at restart is still the one turn `n` left. The next baseline writes ref `n` exactly as it does after an ordinary failed capture, and that ref is a correct baseline for turn `n + 1`. |

### Recommendation: C

The issue asks whether holding forever on a failing database is worse than releasing.
It is not. A turn delivery needs the same database: its claim and its events are
database writes, so releasing does not move the thread forward while the database fails.
When the database recovers, the next retry succeeds within one backoff interval and
releases the thread. The thread stays held until a restart only when that one command
fails deterministically, and the restart clears the hold safely, as argued above.

- In `expire_stale_hold`, after `expire_checkpoint_hold` returns `true`, retry the
  `error` dispatch in a loop with backoff starting at 1 s, doubling, capped at 30 s.
  - Exit on success, then release and append the activity as today.
  - Exit on `shutdown.cancelled()` without a release: the effects shutdown already
    releases every hold (`engine.rs:2790-2799`).
  - Exit when the hold is gone (the thread was deleted, `orchestration_effects.rs:1068-1071`).
    This needs a small `OrchestrationEngine::holds_checkpoint(thread, turn)` accessor
    next to `checkpoint_is_stale`.
- Log the first failure with `tracing::warn!` and include the attempt count. Log every
  tenth failure with `tracing::error!`, so a stuck thread is visible in the native log
  without flooding it.
- Acceptance takes the documented-trade-off branch of the issue. After a restart, the
  next baseline does write ref `n`. That is safe because no turn ran after the expiry.
  Record this in `docs/architecture/rpc-and-orchestration.md` (Turn checkpoints, step 3).

### Tests (acceptance)

Fault injection uses a SQLite trigger through `engine.repositories().database().call(..)`,
following the existing precedent (`production/mcp_tools_tests/foundation.rs:1130`):
`CREATE TRIGGER fail_stale BEFORE UPDATE ON projection_turns WHEN NEW.checkpoint_status =
'error' BEGIN SELECT RAISE(ABORT, 'injected'); END`. Confirm while implementing that a
projection abort fails `dispatch` without degrading the engine. If it degrades the
engine, inject the failure at the command decider instead.

- New: `a_stale_record_that_cannot_be_written_keeps_the_thread_held_until_it_is` in
  `production/turn_delivery_queue_tests.rs`. Use a 200 ms hold limit, a hung capture
  (`hold_workspace`) and the trigger. Assert that the queued follow-up is not received
  for 2.5 s (the limit plus two retries). Then drop the trigger and assert that row 3
  becomes `error`, the follow-up is received, and there is one
  `checkpoint.capture.failed` activity.
- New: `a_restart_while_the_stale_record_cannot_be_written_lets_no_later_turn_into_the_baseline`,
  modeled on `a_stale_turn_is_never_a_revert_target_after_a_restart`
  (`turn_delivery_queue_tests.rs:1587`). Restart with the trigger in place. Assert that
  the follow-up was never delivered before the restart, and that row 3 is `missing`
  after it. Assert that the next baseline's ref 3 holds `"three\n"` (turn 3's checkout,
  with no later turn's edits), and that a revert to 3 is refused.
- New: `deleting_a_thread_ends_its_stale_record_retry`. Delete the thread while the
  trigger fails, and assert that the hold is gone and another thread's delivery is not
  affected.
- Kept: `an_expired_hold_records_the_pending_checkpoint_stale_and_releases_the_thread`
  (`:1389`) and `an_expiry_during_a_taken_capture_reports_nothing_and_the_turn_is_ready`
  (`:1529`).

---

## Documentation and coverage for the implementation

- `docs/architecture/rpc-and-orchestration.md`:
  - Turn checkpoints, step 3: `ready` means capture valid, with `diffAvailable`; a double
    Git failure gives the turn up; the stale record is retried and the trade-off is
    stated.
  - Turn patches, step 0: the start of a one-turn range is trusted only with
    `diffAvailable`.
  - Checkpoint revert, step 1: a `ready` turn without a diff can be reverted to.
- `docs/reference/mcp.md`: the new `get_turn_diff` refusal.
- `docs/testing/`: review it. No commands or targets change, so the runbooks are expected
  to stay accurate.
- Profiler: no new child process, RPC method, removal path or binary mode. New failures
  are logged with `tracing::warn!` or `tracing::error!` at the effects boundary, and no
  profiler event or finding changes.
- Residual risks:
  - #236's give-up is lost when its own `error` write also fails.
  - Old `missing` rows that are really captured without a baseline are not backfilled.
    They stay refused, as they are today.
  - Migration id 63 may collide with another v0.15 slice.
