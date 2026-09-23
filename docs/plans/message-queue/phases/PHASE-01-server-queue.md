# Message Queue / Phase 01 — Server: `queued` state, admission, hold, promote on settle, cancel, recovery

> **For agentic workers:** this phase is implemented by Codex (`codex:rescue`) and reviewed by the coordinating Claude session. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go. Work red → green.

**Goal:** A `thread.turn.start` with `queued: true` during a running session becomes a durable `queued` outbox row and a projected user message with `delivery.state = "queued"`, emits no `thread.turn-start-requested`, is never claimed by the delivery loop, is promoted to a real turn start when the session settles to `ready` (one per settle, gated by approvals and user input), can be cancelled (withdrawn, message deleted), and survives restart unchanged.

**Architecture:** Migration 50 widens the outbox and message delivery states and adds `mode` and `held`. Admission resolves `queued` from the projected session status and rewrites the command's flag before dispatch; the reducer branches on it. The delivery loop gains `promote_settled_threads`, woken by the engine's `ready` settle. `ThreadTurnPromote` (server on settle, client as Send now) replays the stored turn-start payload as `thread.turn-start-requested`. `cancel` is a new `resolve_turn_delivery` action that withdraws the row and deletes the message through a `thread.turn-delivery-updated { withdrawn: true }` event.

**Tech Stack:** Rust, rusqlite migrations, `tokio::sync::Notify`, existing `CommandAdmission`, `transition_turn_delivery`, `InternalOrchestrationCommand` pattern.

---

## Files

- **Modify:** `apps/server/src/persistence/migrations.rs` — `Migration::new(50, "QueuedTurnDeliveries", …)`: recreate `provider_turn_outbox` with the widened `state` CHECK, `mode TEXT NOT NULL DEFAULT 'start' CHECK(mode IN ('start','steer'))` and `held INTEGER NOT NULL DEFAULT 0`, copy rows, recreate `idx_provider_turn_outbox_thread_state` and `idx_provider_turn_outbox_message`; widen `projection_thread_messages.delivery_state` if it is CHECK-constrained (Phase 00 notes). Add the id to the migration list at `:54` and the count assertion wherever the suite pins it.
- **Modify:** `apps/server/src/persistence/repositories.rs` — `ProviderTurnDelivery.mode` and `.held`; `NewProviderTurnDelivery.state` (default `Pending`) and `.mode`; `list_provider_turn_deliveries` reads `mode`; new `list_queued_provider_turn_heads() -> Vec<ProviderTurnDelivery>` (oldest `queued` row per thread, with `held`); new `hold_queued_provider_turns(thread_id) -> Vec<command_id>`; new `requeue_provider_turn(command_id) ` (steer → `queued/start`, used by Phase 02); `get_thread_session` reused.
- **Modify:** `apps/server/src/production/orchestration_rpc.rs:528-585` — `dispatch_reserved_turn_command` reads `queued`; when true, reads the thread session; when the status is `running` or `starting` it writes the outbox row with `state: Queued` and keeps `queued: Some(true)`; otherwise it rewrites the command's `queued` to `Some(false)` before `engine.dispatch`. No Rust-only field.
- **Modify:** `apps/server/src/orchestration/engine.rs:3927-4045` — `ThreadTurnStart` reducer: when `queued == Some(true)`, emit `thread.message-sent` (user) and `thread.turn-delivery-updated { state: "queued", provider }` and **no** `thread.turn-start-requested`. New `ThreadTurnPromote` reducer: load the outbox row (must be `queued`; a client actor is accepted only while the projected session is not `running`), clear `held`, emit `thread.turn-start-requested` from the stored payload and `thread.turn-delivery-updated { state: "pending" }`, flip the row to `pending` in the same transaction (`CommandAdmission` or a dedicated repository transition). Hold: the `thread.turn-interrupt-requested` reducer and the `thread.session-set` reducer with status `error` call `hold_queued_provider_turns(thread_id)` and emit one `thread.turn-delivery-updated { state: "queued", held: true }` per row in the same transaction. `resolve_turn_delivery` (`:4700-4760`): `Cancel` allowed only from `queued`; row → `dismissed`; event payload `withdrawn: true`. Projector (`:5302`): on `withdrawn`, `DELETE FROM projection_thread_messages WHERE message_id = ? AND thread_id = ?`. Settle: where `thread.session-set` with status `ready` is applied, call the delivery wake handle (thread the `Arc<Notify>` or a `TurnDeliveryWaker` into the engine the way `bootstrap_effects()` is registered).
- **Modify:** `apps/server/src/production/turn_delivery.rs` — `fill_available_slots` additionally skips `pending/start` rows whose thread session is `running` or `starting` (read `get_thread_session` for the candidate threads once per fill); new `promote_settled_threads(engine)` executed at the top of each fill: for each head from `list_queued_provider_turn_heads()`, skip when `held`, when the thread has any `pending`/`sending` row, when `get_thread_session(thread_id).status != "ready"`, or when the thread has a pending approval or user input (read from the snapshot/projection the same way the supervisor gates deliveries); otherwise `engine.dispatch(ThreadTurnPromote { … })`. `claimable_oldest_per_thread` must never return `queued` rows (it filters `Pending`; add a test).
- **Modify:** `apps/server/tests/orchestration.rs` — engine tests listed below.
- **Modify:** `apps/server/tests/turn_delivery_recovery.rs:660` — truth-table rows for `queued` across restart (`before: Queued`, `after: Queued`, no send).
- **Create:** `apps/server/tests/turn_delivery_queue.rs` — hold/promote/gate tests with the existing fake router.

## Dependencies

Phase 00 (shapes and enums).

## Owner Agent

Codex (`codex:rescue`), `--fresh --write`.

## Risk / Effort

Medium risk (migration recreates a table; settle hook wiring crosses engine and delivery loop). Medium-high effort.

## Discipline

- Never claim `queued` rows. Never promote into a non-`ready` session.
- The session read happens in admission, which rewrites the command's `queued` flag; the reducer never reads the session projection for this decision.
- Keep `thread.turn-start-requested` payload identical to the fresh-send payload so the client reducer and projector need no new branch.
- Log hygiene: no prompt text in logs; command ids and counts only.
- No commits.

## Documents to Read

`AGENTS.md`; spec §§ 3–5; plan § Server; `research/bibcode-turn-lifecycle.md`; `docs/architecture/rpc-and-orchestration.md` § Provider turn flow and § Invariants; `apps/server/src/production/turn_delivery.rs:421-960`; `apps/server/src/orchestration/engine.rs:3927-4045, 4700-4760, 5302-5330, 5546-5700`; `apps/server/src/persistence/migrations.rs:2168-2195`; `apps/server/tests/turn_delivery_recovery.rs`.

## Pre-execution check

- [x] `git status --short` clean apart from this plan's docs and Phase 00's changes.
- [x] Re-verify cited lines; note drift in `tasks.md` under "Phase 01".
- [x] Confirm whether `projection_thread_messages.delivery_state` is CHECK-constrained.

## Atomic steps

- [x] **Step 1 (red):** migration test: open a fresh database, run all migrations, assert `provider_turn_outbox` accepts `state='queued'` and `mode='steer'` and rejects `mode='x'`; assert both indexes exist; assert an existing `pending` row copied by the recreate keeps its values. Run `cargo test -p bibcode-server migrations -j 2` — expect failure.
- [x] **Step 2 (green):** write migration 50 and the repository struct/mapping changes. Re-run; expect pass. Run the whole persistence test module.
- [x] **Step 3 (red):** engine test `queued_turn_start_records_message_without_turn_start_requested`: dispatch `ThreadTurnStart { queued: Some(true), … }` (as admission would after resolving it); assert emitted events are exactly `thread.message-sent` (user, `turnId: null`) and `thread.turn-delivery-updated { state: "queued" }`; assert `projection_turns` has no new row and the snapshot message has `delivery.state == "queued"`. Run — expect failure.
- [x] **Step 4 (green):** reducer branch. Re-run; pass.
- [x] **Step 5 (red):** engine test `promote_replays_the_stored_turn_start`: seed a `queued` row, dispatch `ThreadTurnPromote`; assert `thread.turn-start-requested` payload equals the stored one (message id, model selection, modes) and the row is `pending`; a second promote returns an invariant error. Run — fail.
- [x] **Step 6 (green):** `ThreadTurnPromote` reducer + transaction. Re-run; pass.
- [x] **Step 7 (red):** engine test `cancel_withdraws_a_queued_message`: resolve with `Cancel`; assert the row is `dismissed`, the event has `withdrawn: true`, the snapshot no longer contains the message, and `Cancel` on a `pending` row is refused (`Ok(None)`). Run — fail.
- [x] **Step 8 (green):** `Cancel` action + projector delete. Re-run; pass.
- [x] **Step 9 (red):** `turn_delivery_queue.rs`: (a) `queued_rows_are_never_claimed` — a `queued` row with a `ready` session and a fake router: the router receives nothing until promotion; (b) `settle_promotes_the_oldest_queued_row_once` — two queued rows, session `running`; apply `thread.session-set` `ready`; exactly one becomes `pending` and is delivered; the other stays `queued`; a second `ready` settle after that turn promotes the second; (c) `no_promotion_while_approval_or_user_input_pending`; (d) `no_promotion_after_interrupted_or_error_settle`; (e) `claimable_oldest_per_thread_ignores_queued`; (f) `pending_start_is_not_claimed_while_session_running` (an older-client turn start admitted mid-turn is delivered only after the `ready` settle); (g) `interrupt_holds_queued_rows_and_ready_does_not_promote_held` (interrupt → held; Codex-style `ready` settle → no promotion; `ThreadTurnPromote` from a client clears the hold and delivers); (h) `error_settle_holds_queued_rows`. Run — fail.
- [x] **Step 10 (green):** `promote_settled_threads`, the wake on `ready`, the claim gate, the hold, and the gating. Re-run; pass.
- [x] **Step 11 (red/green):** `turn_delivery_recovery.rs` rows: `queued` before restart stays `queued` after restart and the provider is never launched for it. Run the recovery suite (`-j 2`, foreground; it is pipe-heavy, see `memory: host-pipe-budget-flake` if it fails on 8 KiB pipes).
- [x] **Step 12:** backward compatibility test: `ThreadTurnStart` without `queued` during a running session still admits as `pending`, and is claimed only after the session settles (covered by (f)).
- [x] **Step 13:** `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo test -p bibcode-server --test orchestration --test turn_delivery_queue --test turn_delivery_recovery --test production_orchestration_rpc -j 2`, `vp check`, `vp run typecheck`.
- [x] **Step 14:** paste gate output under "Phase 01" in `tasks.md`; note the migration id and how the wake handle reached the engine.

## Verification

- `cargo test -p bibcode-server --test orchestration --test turn_delivery_queue --test turn_delivery_recovery --test production_orchestration_rpc -j 2`
- `cargo test -p bibcode-server migrations -j 2`
- `cargo fmt --all --check` · `cargo clippy -p bibcode-server --all-targets -- -D warnings` · `vp check` · `vp run typecheck`

## Notes for downstream phases

Record the exact wake mechanism, the `requeue_provider_turn` signature, and where the approval/user-input gate reads from.
