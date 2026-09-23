# Message Queue / Phase 00 — Contracts, capability flag, keybinding command, client-runtime commands and reducer, fixtures

> **For agentic workers:** this phase is implemented by Codex (`codex:rescue`) and reviewed by the coordinating Claude session. Atomic steps use checkbox (`- [ ]`) syntax — tick them off in this file as you go. Work red → green: write the failing test, run it, implement, run it again.

**Goal:** Wire the whole feature's typed boundary once: the `queued` delivery state and `mode`, the `queued` flag on turn start, the `thread.turn.steer` client command, the `thread.turn.promote` internal command, the `cancel` resolution action, the `thread.turn-steer-requested` event, the `withdrawn`/`turnId` fields on delivery updates, `ServerProvider.supportsTurnSteer`, the `thread.steerQueuedMessage` keybinding command, the client-runtime commands and reducer cases, and the regenerated fixtures with bumped counts — so later phases only fill in behaviour.

**Architecture:** Schema-only changes in `packages/contracts`, mirrored in the Rust command/event enums only as far as `cargo test` in `apps/server/tests/orchestration.rs` requires shapes to round-trip (the engine behaviour lands in Phase 01). Client-runtime gains one command and three reducer cases.

**Tech Stack:** effect `Schema`, Vitest, the fixture export script `packages/contracts/scripts/export-rust-rpc-fixtures.ts`, cargo test for `rpc_wire` and `orchestration` shape tests.

---

## Files

- **Modify:** `packages/contracts/src/orchestration.ts` — `TurnDeliveryState` (+`queued`), new `TurnDeliveryMode`, `TurnDelivery.mode`, `TurnDelivery.held`, `TurnDeliveryResolutionAction` (+`cancel`), `queued?` on `ThreadTurnStartCommand` and `ClientThreadTurnStartCommand`, `ThreadTurnSteerCommand` (client + server unions), `ThreadTurnPromoteCommand` (in both the client union and `InternalOrchestrationCommand`: clients dispatch it as Send now), `OrchestrationEventType` (+`thread.turn-steer-requested`), `ThreadTurnSteerRequestedEvent`, `withdrawn?`/`turnId?`/`held?`/`mode?` on the delivery-updated event payload, and the event union.
- **Modify:** `packages/contracts/src/orchestration.test.ts` — decode cases for each new shape and rejection cases (`cancel` is a valid action; `mode` optional; `queued` optional boolean; steer command requires `messageId`).
- **Modify:** `packages/contracts/src/server.ts:172` — `supportsTurnSteer: Schema.optional(Schema.Boolean)` after `supportsMcpStatus`; test in `server.test.ts` if one exists for the sibling flags.
- **Modify:** `packages/contracts/src/keybindings.ts` — `"thread.steerQueuedMessage"` in `STATIC_KEYBINDING_COMMANDS`; `keybindings.test.ts` default-table assertion; the defaults table (find it by searching the repository for `modelPicker.toggle` outside `.repos/`): `thread.steerQueuedMessage` → `mod+shift+enter`, `when: "editableFocus"`.
- **Modify:** `packages/contracts/scripts/export-rust-rpc-fixtures.ts` and `.test.ts:101-116` — regenerate; bump `expectedOrchestrationEventShapes` (23 → 24) and any other count the script reports.
- **Modify:** `packages/contracts/fixtures/rpc-wire/**` — regenerated output only.
- **Modify:** `apps/server/tests/rpc_wire.rs:70-85` — bump the pinned counts to the regenerated values.
- **Modify:** `apps/server/src/orchestration/engine.rs` enums only: `OrchestrationCommand::ThreadTurnSteer { command_id, thread_id, message_id, created_at }`, `OrchestrationCommand::ThreadTurnPromote { … }`, `queued: Option<bool>` on `ThreadTurnStart`, `TurnDeliveryResolutionAction::Cancel`; `command_type()` names; the reducer returns `invariant(command, "Phase 01 implements …")` for the two new commands so shape tests pass without behaviour. `apps/server/tests/orchestration.rs:22` `command_values()` gains the new shapes.
- **Modify:** `apps/server/src/persistence/repositories.rs` — `TurnDeliveryState::Queued` variant and its string mapping (`"queued"`); `TurnDeliveryMode { Start, Steer }` with mapping. No SQL change yet (Phase 01 migrates); the variant exists so serialisation is exhaustive.
- **Modify:** `packages/client-runtime/src/operations/commands.ts` — `startThreadTurn` forwards `queued`; new `steerThreadTurn` and `promoteThreadTurn`; `resolveTurnDelivery` input type accepts `"cancel"`.
- **Modify:** `packages/client-runtime/src/state/threadCommands.ts:106-125` — `steerTurn` and `promoteTurn` commands; `threadCommands.test.ts:58` mapping table.
- **Modify:** `packages/client-runtime/src/state/threadReducer.ts` — cases `thread.turn-steer-requested`, `thread.turn-delivery-updated` with `withdrawn` (remove message) with `turnId` (set `message.turnId`), and with `held`/`mode` (update delivery fields); `threadReducer.test.ts` cases.
- **Modify:** `packages/contracts/src/index.ts` only if a new file is added (none planned).

## Dependencies

None. Everything later depends on this phase.

## Owner Agent

Codex (`codex:rescue`), `--fresh --write`.

## Risk / Effort

Low risk, medium effort. The fixture regeneration is mechanical but touches many files; the count bumps must match the script's output, never be guessed.

## Discipline

- Schema-only in `packages/contracts`. No runtime logic.
- Do not implement engine behaviour; the two new commands return an invariant error in this phase.
- Do not edit `.repos/`.
- Report every count the script prints in `tasks.md`.

## Documents to Read

`AGENTS.md`; `docs/plans/message-queue/message-queue-spec.md` §§ 3–4; `message-queue-plan.md` § Contracts and § Client runtime; `research/bibcode-turn-lifecycle.md` (command entry, tests); `docs/architecture/rpc-and-orchestration.md` § Provider turn flow; `packages/contracts/src/orchestration.ts` around lines 286–330, 765–830, 887–1035; `packages/client-runtime/src/state/threadReducer.ts:140-260`.

## Pre-execution check

- [x] `git status --short` clean apart from `docs/plans/message-queue/`.
- [x] Re-verify each cited line; note drift in `tasks.md` under "Phase 00".

## Atomic steps

- [x] **Step 1 (red):** in `packages/contracts/src/orchestration.test.ts` add tests: `TurnDelivery` decodes `{ state: "queued", provider: "codex" }` and `{ state: "pending", provider: "codex", mode: "steer" }`; `TurnDeliveryResolutionAction` decodes `"cancel"`; `ClientOrchestrationCommand` decodes a `thread.turn.start` with `queued: true` and a `thread.turn.steer` with `messageId`; `ClientOrchestrationCommand` and `OrchestrationCommand` both decode `thread.turn.promote`; `OrchestrationEvent` decodes `thread.turn-steer-requested { threadId, messageId, turnId, createdAt }` and `thread.turn-delivery-updated` with `withdrawn: true` with `turnId`, and with `held: true`. Run `vp run --filter @bibcode/contracts test` — expect failures naming the missing literals.
- [x] **Step 2 (green):** implement the schema changes listed under Files in `orchestration.ts`. Keep `mode` optional with the documented meaning "absent = start". Re-run; expect pass.
- [x] **Step 3:** `server.ts` `supportsTurnSteer` + test. Run the package tests.
- [x] **Step 4:** `keybindings.ts` command + default + tests. Run `vp run --filter @bibcode/contracts test`.
- [x] **Step 5:** Rust enums and `command_values()` shapes; `TurnDeliveryState::Queued`, `TurnDeliveryMode`. Run `cargo test -p bibcode-server --test orchestration -j 2` — expect the new shapes to round-trip and the two new commands to hit the placeholder invariant in any test that dispatches them (none should yet).
- [x] **Step 6:** regenerate fixtures: `vp run --filter @bibcode/contracts export:rust-rpc-fixtures` (or the script name in `packages/contracts/package.json`); read the printed counts; bump `export-rust-rpc-fixtures.test.ts` and `apps/server/tests/rpc_wire.rs`. Run `vp run --filter @bibcode/contracts test` and `cargo test -p bibcode-server --test rpc_wire -j 2`.
- [x] **Step 7 (red):** client-runtime tests: `threadCommands.test.ts` mapping table gains `steerTurn → thread.turn.steer`; `threadReducer.test.ts` gains the three cases (steer-requested sets `delivery: { state: "pending", mode: "steer" }`; withdrawn removes the message and leaves others untouched; `turnId` update sets it). Run `vp run --filter @bibcode/client-runtime test` — expect failures.
- [x] **Step 8 (green):** implement `steerThreadTurn`, `steerTurn`, `queued` pass-through, `cancel` acceptance and the reducer cases. Re-run; expect pass.
- [x] **Step 9:** `vp check`, `vp run typecheck`, `cargo fmt --all --check`, `cargo clippy -p bibcode-server --all-targets -- -D warnings`.
- [x] **Step 10:** paste every gate's output under "Phase 00" in `tasks.md` with the regenerated counts.

## Verification

- `vp run --filter @bibcode/contracts test`
- `vp run --filter @bibcode/client-runtime test`
- `cargo test -p bibcode-server --test orchestration --test rpc_wire -j 2`
- `vp check` · `vp run typecheck` · `cargo fmt --all --check` · `cargo clippy -p bibcode-server --all-targets -- -D warnings`

## Notes for downstream phases

- Counts observed from the exporter: 131 RPC methods, 20 stream methods, 70 top-level stream shapes, 24 orchestration event shapes, 70 stream-shape fixtures, 288 typed-failure fixtures, 16 explicit contract-shape fixtures, 388 fixtures total, 358 schema fingerprints, three stale method identifiers. Formatting includes the manifest: 389 files. Eight explicit message-queue fixtures were added.
- Keybinding defaults: `packages/shared/src/keybindings.defaults.json`.
- `projection_thread_messages.delivery_state` is **not CHECK-constrained** (`migrations.rs` adds a plain TEXT column); `provider_turn_outbox.state` is CHECK-constrained and still needs the Phase 01 migration.
- Delivery enums are owned by `apps/server/src/orchestration/delivery.rs`, with existing SQL string mappings in `persistence/repositories.rs`.
- `queued` forwarding and `cancel` input typing already followed from schema-derived operation inputs; tests now cover both.
- Gate outputs, temporary red-to-green sequencing differences, and sandbox limitations are recorded under Phase 00 in `../tasks.md`.
