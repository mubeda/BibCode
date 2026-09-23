# Message Queue / Phase 02 — Server: steer (driver operation, Codex `turn/steer`, Claude, capability, Codex active-turn fix)

> **For agentic workers:** this phase is implemented by Codex (`codex:rescue`) and reviewed by the coordinating Claude session. Atomic steps use checkbox (`- [ ]`) syntax. Work red → green.

**Goal:** `thread.turn.steer` on the head `queued` message turns it into a `pending/steer` delivery that the loop hands to a new `ProviderDriver::steer`. Codex sends `turn/steer` with the active turn id; Claude writes the user line without starting a runtime turn. On acceptance the message is attributed to the running turn. Providers without steer declare `supportsTurnSteer` false. The Codex runtime stops re-pointing its active turn id on follow-ups.

**Architecture:** `ThreadTurnSteer` reducer validates head-of-queue, `running` session and capability, emits `thread.turn-steer-requested { turnId }` and flips the row to `pending` with `mode = 'steer'`. `deliver_claimed` branches on `mode`. `Accepted` → `delivered` with `turnId` in the delivery-updated event; projector sets `projection_thread_messages.turn_id`. `Rejected` → row back to `queued/start` (`requeue_provider_turn`) and a wake. Steer rows are claimable only while the session is `running`.

**Tech Stack:** Rust; Codex app-server JSON-RPC (`turn/steer`, `TurnSteerParams { threadId, clientUserMessageId?, input, expectedTurnId }`, `TurnSteerResponse { turnId }`); Claude stream-JSON stdin.

---

## Files

- **Modify:** `apps/server/src/production/provider_runtime.rs:282` — `fn steer(&self, text: String, attachments: Vec<Value>, expected_turn_id: String) -> BoxRuntimeFuture<'_, ProviderDeliveryOutcome>` with the default `Rejected { detail: "provider does not support steering" }`; Claude driver (`:8704`) implements it (mirror `deliver` at `:8750-8830` minus `runtime.start_turn`; `Accepted { turn_id: Some(expected_turn_id) }`); Codex driver (`:5616`) calls `runtime.steer_turn`.
- **Modify:** `apps/server/src/provider/codex/runtime.rs` — `steer_turn(input, attachments, expected_turn_id, client_user_message_id) -> Result<String, RuntimeError>` building `turn/steer` params with `build_turn_steer_params` (input parts as in `build_turn_start_params`); `send_turn` (`:1224-1225`) keeps `active_turn_id` when `session.status == "running"` and `active_turn_id.is_some()`; a `turn/steer` error whose message mentions the turn precondition maps to `Rejected`.
- **Modify:** `apps/server/src/production/provider_inventory.rs:1595` — `supportsTurnSteer` true for Codex and Claude; test at `:1972-1976` extended.
- **Modify:** `apps/server/src/orchestration/engine.rs` — `ThreadTurnSteer` reducer (replaces the Phase 00 placeholder): validations, event, row flip; `thread.turn-delivery-updated` projector handles `turnId`.
- **Modify:** `apps/server/src/production/turn_delivery.rs` — `deliver_claimed` branch on `mode`; steer claim gate (session `running`, else `requeue_provider_turn` + wake); outcome mapping (`Accepted` → `Delivered` with `turn_id`; `Rejected` → requeue; `Ambiguous`/`DefinitelyNotSent` → existing).
- **Modify:** `apps/server/tests/production_provider_runtime.rs` — Codex fake transport asserts `turn/steer` params; Claude fake asserts the written line and that no `turn.started` canonical event is emitted; default driver returns `Rejected`.
- **Modify:** `apps/server/tests/orchestration.rs` — steer reducer tests.
- **Modify:** `apps/server/tests/turn_delivery_queue.rs` — steer delivery tests.
- **Modify:** `apps/server/tests/turn_delivery_recovery.rs` — steer rows on Codex (`Sending` → `Delivered`, reconciliation as for start) and Claude (`Sending` → `Uncertain`).
- **Modify:** `apps/server/src/provider/codex/runtime.rs` tests (`:3717` area) — `send_turn_keeps_the_active_turn_id_while_running` regression.

## Dependencies

Phase 01.

## Owner Agent

Codex (`codex:rescue`), `--fresh --write`.

## Risk / Effort

Medium risk (two provider protocols, a race between steer and settle). Medium effort.

## Discipline

- Steer never calls `runtime.start_turn` (Claude) and never overwrites `active_turn_id` (Codex).
- A steer that finds no running turn must fall back to `queued/start`, never be lost and never start a turn by itself.
- Only public, documented app-server methods (`turn/steer` is in the upstream v2 protocol; do not use experimental fields).
- No commits.

## Documents to Read

`AGENTS.md`; spec §§ 3–5; plan § Server (Steer); `research/bibcode-turn-lifecycle.md` (drivers, upstream `turn/steer`); `docs/architecture/providers.md` § Execution path; `docs/providers/codex.md` and `docs/providers/claude.md`; `apps/server/src/provider/codex/runtime.rs:1186-1300`; `apps/server/src/production/provider_runtime.rs:254-340, 5616-5700, 8704-8870`; `apps/server/src/production/turn_delivery.rs:1040-1140`.

## Pre-execution check

- [ ] `git status --short` clean apart from this plan's docs and Phases 00–01.
- [ ] Re-verify cited lines; note drift in `tasks.md` under "Phase 02".
- [ ] Confirm the installed `codex app-server` advertises `turn/steer` (run `codex --version`; ≥ 0.155 ships it; record the version). Upstream `common.rs` lists `TurnSteer => "turn/steer"` without an experimental gate on the method (only two optional params are experimental); if the handshake still rejects it, record the exact error and stop.
- [x] **Live probe, Codex (coordinator, see tasks.md):** in a scratch app-server session start a long turn and send one `turn/steer { threadId, input, expectedTurnId }`; record the response and the notifications that follow (does the steered input appear inside the same turn?). Paste the transcript path in `tasks.md`.
- [x] **Live probe, Claude (coordinator, see tasks.md):** run `claude -p --input-format stream-json --output-format stream-json --verbose` (Claude Code 2.1.278), start a long tool-using turn, write a second `{"type":"user",…}` line mid-turn, and record whether it is consumed inside the running turn (before the turn's `result`) or processed after `result` as a new turn. If the latter, the Claude driver must assign a fresh turn id at that boundary instead of attributing to the running turn; update the plan and this phase before coding.
- [ ] **Acknowledgement ambiguity, Claude:** `emit_claude_value` (`provider_runtime.rs:9636-9640`) acknowledges on any non-hook `type: user` line, which includes tool-result user lines during a running turn. A steer must not be acknowledged by a tool-result line: acknowledge only a user line whose content contains no `tool_result` block (or match the echoed text). Add this to Step 1's Claude test.

## Atomic steps

- [ ] **Step 1 (red):** `production_provider_runtime.rs`: `default_driver_steer_is_rejected` (a driver without an override); Codex fake: `codex_steer_sends_turn_steer_with_expected_turn_id` asserting method `turn/steer`, `threadId`, `expectedTurnId`, `input` parts, `clientUserMessageId`, and that `active_turn_id` is unchanged afterwards; Claude fake: `claude_steer_writes_user_line_without_turn_started` asserting the JSON line and that the runtime emitted no `turn.started` and `current_turn_id` is unchanged. Run — fail.
- [ ] **Step 2 (green):** trait method, Codex `steer_turn`, Claude `steer`. Re-run; pass.
- [ ] **Step 3 (red/green):** Codex regression `send_turn_keeps_the_active_turn_id_while_running` at the runtime test site; implement the guard in `send_turn`.
- [ ] **Step 4 (red):** engine tests: `steer_requires_head_running_and_capability` (refused for non-head, for `ready` session, for a provider without the flag), `steer_emits_turn_steer_requested_and_flips_row` (row `pending`, `mode steer`; event carries the active `turnId`). Run — fail.
- [ ] **Step 5 (green):** `ThreadTurnSteer` reducer. Re-run; pass.
- [ ] **Step 6 (red):** `turn_delivery_queue.rs`: `steer_row_is_delivered_through_driver_steer_and_attributed_to_the_turn` (router receives `steer` with the active id; message `turn_id` set; row `delivered`), `steer_claimed_after_settle_requeues_as_start` (session `ready` at claim time → row `queued/start`, then normal promotion), `steer_rejected_by_provider_requeues` (driver returns `Rejected`). Run — fail.
- [ ] **Step 7 (green):** `deliver_claimed` branch, claim gate, outcome mapping, `turnId` projection. Re-run; pass.
- [ ] **Step 8:** `provider_inventory.rs` flag + test.
- [ ] **Step 9:** recovery rows for steer (Codex, Claude). Run the recovery suite.
- [ ] **Step 10:** `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`, `cargo test -p bibcode-server --test orchestration --test turn_delivery_queue --test turn_delivery_recovery --test production_provider_runtime -j 2`, Codex runtime unit tests, `vp check`, `vp run typecheck`.
- [ ] **Step 11:** paste gate output under "Phase 02" in `tasks.md`; record the codex version used.

## Verification

- `cargo test -p bibcode-server --test orchestration --test turn_delivery_queue --test turn_delivery_recovery --test production_provider_runtime -j 2`
- `cargo test -p bibcode-server codex::runtime -j 2`
- `cargo fmt --all --check` · `cargo clippy -p bibcode-server --all-targets -- -D warnings` · `vp check` · `vp run typecheck`

## Notes for downstream phases

Record the exact `Rejected` detail strings so the web card can show them, and confirm the `turnId` field name on the delivery-updated event.
