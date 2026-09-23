# Message Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository the implementer of every phase is Codex (`codex:rescue`) and the reviewer is the coordinating Claude session; see `execute-plan.md`.

**Goal:** Let the user keep composing while a provider turn runs: Enter queues the message as a durable, server-owned queued card that auto-sends when the turn ends, can be steered into the running turn on providers that support it, or cancelled back into the composer.

**Architecture:** A queued message is an ordinary user message whose durable outbox row is in a new `queued` state. The existing delivery loop refuses to claim `queued` rows and, on every session settle to `ready`, promotes the oldest one through a new internal command that emits the same `thread.turn-start-requested` a fresh send would. Steer is a new client command that converts the head row into a `pending/steer` delivery served by a new `ProviderDriver::steer` (Codex `turn/steer`, Claude user line without a runtime turn start). Cancel is a new action on the existing delivery-resolve command that withdraws the row and deletes the message. The web app renders queued messages from the thread snapshot as a `queued-message` timeline row and stops treating them as busy state.

**Tech Stack:** Rust (Axum/Tokio, rusqlite migrations, existing outbox and supervisor), effect `Schema` contracts, React 19 + zustand + `@effect/atom`, LegendList timeline, Vitest, cargo test, WebdriverIO (packaged desktop e2e), Playwright (coordinator visual pass).

**Spec:** `docs/plans/message-queue/message-queue-spec.md` (approved 2026-09-22). Research: `docs/plans/message-queue/research/`.

## Global Constraints

Every phase's requirements implicitly include this section. Copied from the spec.

- **The server owns the queue.** Queued messages are outbox rows plus projected user messages; no client keeps a second queue.
- **A queued message never looks like work.** No `thread.turn-start-requested`, no pending projection turn, no `session.status` change, no sidebar "Working".
- **Auto-send only into a `ready` session**, never while an approval or user-input question is pending. After `interrupted`/`error` the head is held (`Waiting for you`).
- **Steer is a real provider operation** through `ProviderDriver::steer`, attributed to the running turn, gated by `ServerProvider.supportsTurnSteer` (Codex, Claude). Never a second `turn/start`.
- **Model and modes are snapshotted at enqueue** exactly as a normal turn start.
- **Cancel never discards user text**; Stop drains every queued message back into the composer of the client that pressed Stop.
- **Recovery:** `queued` rows survive restart as `queued` and never become `uncertain`.
- **No new dependencies.** `packages/contracts` stays schema-only.
- **Every new command, event or capability** is registered in every gate: `packages/contracts/src/orchestration.ts` unions, `apps/server/tests/orchestration.rs` `command_values()`, the wire fixtures under `packages/contracts/fixtures/rpc-wire/`, and the pinned counts in `packages/contracts/scripts/export-rust-rpc-fixtures.test.ts` and `apps/server/tests/rpc_wire.rs` (re-read and bump in the same change).
- **Living documentation ships with the behaviour** (Phase 04 plus per-phase notes); `docs/testing/` runbooks updated or recorded as reviewed and unchanged.
- **Commit policy:** phases are commit-free; the coordinator commits only when the requester asks, with a task resume in the message.

> Line numbers in this plan drift. Re-verify every cited location before editing. Where the plan and the research documents disagree with the working tree, the working tree wins and the discrepancy is reported in `tasks.md`.

---

## Why this shape

BibCode already has the three hard parts of a durable queue: a per-thread outbox with at-most-once delivery and crash recovery (`apps/server/src/production/turn_delivery.rs`), a thread snapshot that every client receives on every durable event, and a message projection with a delivery state the composer already reads. What is missing is a state that means "not yet eligible" and a hook that makes it eligible. Adding `queued` to the existing state machine is the smallest coherent change; a client-only queue (the upstream project's design) would double-send across BibCode's concurrent clients and vanish on reload, and a separate queued-prompt table would be a second source of truth next to the outbox.

Steer needs its own operation because both providers that support it behave badly when fed a second turn start: Codex re-points the active turn id (so Stop targets the wrong turn), and the Claude driver resets the runtime turn id (so the running turn's events are re-labelled). Upstream Codex ships `turn/steer` with an `expectedTurnId` precondition precisely for this (`research/bibcode-turn-lifecycle.md`).

## Architecture

### Ownership

| Concern                                  | Owner                                                                                                                                                                                                                  | Notes                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Delivery states, `mode`, cancel, promote | `apps/server/src/orchestration/engine.rs`, `apps/server/src/persistence/{migrations,repositories}.rs`                                                                                                                  | `queued` state, `withdrawn` delivery update, `thread.turn.promote` internal command |
| Hold and promote on settle               | `apps/server/src/production/turn_delivery.rs`                                                                                                                                                                          | Never claims `queued`; settle hook promotes the head                                |
| Steer                                    | `apps/server/src/production/provider_runtime.rs` (`ProviderDriver::steer`), `apps/server/src/provider/codex/runtime.rs`, Claude driver                                                                                 | Codex `turn/steer`; Claude user line without `start_turn`                           |
| Capability                               | `apps/server/src/production/provider_inventory.rs`, `packages/contracts/src/server.ts`                                                                                                                                 | `supportsTurnSteer`                                                                 |
| Contracts                                | `packages/contracts/src/orchestration.ts`, `server.ts`, `keybindings.ts`                                                                                                                                               | Schema only                                                                         |
| Client commands                          | `packages/client-runtime/src/operations/commands.ts`, `state/threadCommands.ts`, `state/threadReducer.ts`                                                                                                              | `steerThreadTurn`, `queued` flag, reducer cases                                     |
| Web                                      | `apps/web/src/components/ChatView.tsx`, `ChatView.logic.ts`, `components/chat/{MessagesTimeline.tsx,MessagesTimeline.logic.ts,QueuedMessageTimelineRow.tsx,ComposerPrimaryActions.tsx}`, `apps/web/src/keybindings.ts` | Enqueue path, busy state, card, Stop drain, shortcut                                |
| Docs                                     | `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/providers.md`, `docs/user/workspace-ui.md`, `docs/user/keybindings.md`, `docs/testing/*`                                                              | Phase 04                                                                            |

### Server

**Persistence (migration 50 `QueuedTurnDeliveries`).** SQLite cannot alter a CHECK constraint, so the migration recreates `provider_turn_outbox` with `state IN ('queued','pending','sending','delivered','uncertain','dismissed','failed')` and a new column `mode TEXT NOT NULL DEFAULT 'start' CHECK(mode IN ('start','steer'))`, copying rows and both indexes, and widens `projection_thread_messages.delivery_state` the same way (recreate or, if that column is unconstrained, no change; the implementer verifies in `migrations.rs`). `TurnDeliveryState` in Rust gains `Queued`; `ProviderTurnDelivery` gains `mode: TurnDeliveryMode`.

**Admission.** `dispatch_reserved_turn_command` (`orchestration_rpc.rs:528`) reads `queued` from the command. When true, it consults `repositories.get_thread_session(thread_id)`; if the status is `running` or `starting`, the `NewProviderTurnDelivery` is written with `state: Queued` and the engine reducer for `ThreadTurnStart` emits only `thread.message-sent` (user, `turnId: null`) plus a `thread.turn-delivery-updated` to `queued`; it skips `thread.turn-start-requested`. Otherwise the flag is ignored and the existing path runs. Admission rewrites the command's `queued` flag to the resolved value before `engine.dispatch`, so no Rust-only field is added and the reducer simply branches on `queued`. (Reducers already read repositories, e.g. `list_proposed_plans_by_thread`; no purity claim is made.)

**Delivery loop.** `fill_available_slots` keeps loading `Pending | Sending | Uncertain | Failed`, so `queued` rows are invisible to claiming. A new `promote_settled_threads` step runs on every wake: for each thread that has a `queued` row, no `pending`/`sending` row, a session with status `ready`, and no pending approval or user input, it dispatches `OrchestrationCommand::ThreadTurnPromote { thread_id, message_id }` for the oldest `queued` row. The engine's settle path (`thread.session-set` with status `ready`, `engine.rs:5561`) calls `turn_delivery.wake()`; the loop already owns a `Notify`. `ThreadTurnPromote` is an `InternalOrchestrationCommand`: it loads the stored command payload from the outbox row, emits `thread.turn-start-requested` with that payload (message id, model selection, runtime and interaction mode, createdAt = now) and `thread.turn-delivery-updated` to `pending`, and flips the row to `pending` in the same transaction. The existing claim path then delivers it.

A `pending/steer` row is claimable only while the projected session is `running`; the loop checks this before claiming and, if not running, rewrites the row to `queued/start` (`mode = 'start'`) and re-evaluates promotion.

**Claim gate and hold.** `fill_available_slots` also refuses to claim any `pending/start` row while the thread's projected session is `running` or `starting`, so a turn start admitted during a running turn (older client, or the enqueue race) waits for the settle instead of steering by accident. Applying `thread.turn-interrupt-requested`, or a session settle to `error`, sets `held = 1` on every `queued` row of the thread and emits `thread.turn-delivery-updated { held: true }` per row; `promote_settled_threads` skips held rows; `ThreadTurnPromote` clears `held` on the promoted row and accepts a client actor only when the session is not `running` (Send now).

**Steer.** `ProviderDriver::steer(&self, text, attachments, expected_turn_id: String) -> BoxRuntimeFuture<ProviderDeliveryOutcome>` with the default `Rejected { detail: "provider does not support steering" }`. `deliver_claimed` routes `mode == Steer` rows to `steer` with the session's `active_turn_id`; `Accepted` → row `delivered` and `thread.turn-delivery-updated { state: "delivered", turnId }` whose projector sets `projection_thread_messages.turn_id`; `Rejected` → row back to `queued/start` and a wake; `Ambiguous` → existing `uncertain` handling.

- Codex (`provider/codex/runtime.rs`): new `steer_turn(input, attachments, expected_turn_id, client_user_message_id)` that sends `turn/steer` with `TurnSteerParams` and returns the response `turnId`; it does not touch `session.active_turn_id`. `send_turn` (`:1224-1225`) keeps `active_turn_id` when the session is already `running`.
- Claude driver (`provider_runtime.rs:8704`): `steer` mirrors `deliver` minus `runtime.start_turn`; `Accepted { turn_id: Some(expected_turn_id) }` after acknowledgement. The runtime's `current_turn_id` is untouched.
- Cursor, Grok, OpenCode: default.

`ServerProvider.supportsTurnSteer` is set in `provider_inventory.rs` next to `supportsMcpStatus` for Codex and Claude.

**Cancel.** `TurnDeliveryResolutionAction` gains `cancel`; `resolve_turn_delivery` (`engine.rs:4700-4760`) accepts it only from `queued`, sets the row `dismissed`, emits `thread.turn-delivery-updated { state: "dismissed", withdrawn: true }`, and the projector deletes the `projection_thread_messages` row (and the outbox row may be deleted or left `dismissed`; leave it, the unique message index no longer matters once the message is gone).

### Contracts

`packages/contracts/src/orchestration.ts`:

```ts
export const TurnDeliveryState = Schema.Literals([
  "queued",
  "pending",
  "sending",
  "delivered",
  "uncertain",
  "dismissed",
  "failed",
]);
export const TurnDeliveryMode = Schema.Literals(["start", "steer"]);
export const TurnDelivery = Schema.Struct({
  state: TurnDeliveryState,
  provider: ProviderDriverKind,
  mode: Schema.optional(TurnDeliveryMode), // absent means "start"
  held: Schema.optional(Schema.Boolean), // set on interrupt/error; cleared by promote
  detail: Schema.optional(TrimmedNonEmptyString),
});
export const TurnDeliveryResolutionAction = Schema.Literals(["retry", "dismiss", "cancel"]);
// ThreadTurnStartCommand and ClientThreadTurnStartCommand: `queued: Schema.optional(Schema.Boolean)`
const ThreadTurnSteerCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.steer"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});
const ThreadTurnPromoteCommand = Schema.Struct({
  // client (Send now) and server (settle); in both command unions
  type: Schema.Literal("thread.turn.promote"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});
// OrchestrationEventType += "thread.turn-steer-requested"
// ThreadTurnSteerRequestedEvent payload: { threadId, messageId, turnId, createdAt }
// ThreadTurnDeliveryUpdatedEvent payload += withdrawn?: boolean, turnId?: TurnId, held?: boolean, mode?: TurnDeliveryMode
```

`packages/contracts/src/server.ts`: `supportsTurnSteer: Schema.optional(Schema.Boolean)` on `ServerProvider`. `packages/contracts/src/keybindings.ts`: `"thread.steerQueuedMessage"` in `STATIC_KEYBINDING_COMMANDS`; default `mod+shift+enter` with `when: "editableFocus"` wherever the defaults live (`docs/user/keybindings.md` documents them; the implementer finds the defaults table by searching for `modelPicker.toggle`).

### Client runtime

`operations/commands.ts`: `startThreadTurn` passes `queued` through; new `steerThreadTurn(input: { threadId, messageId })` dispatching `thread.turn.steer` and `promoteThreadTurn(input: { threadId, messageId })` dispatching `thread.turn.promote` (Send now); `resolveTurnDelivery` accepts `cancel`. `state/threadCommands.ts`: `steerTurn` and `promoteTurn` commands. `state/threadReducer.ts`: `thread.turn-steer-requested` sets the message's delivery to `{ state: "pending", mode: "steer" }`; `thread.turn-delivery-updated` with `withdrawn` removes the message, with `turnId` sets `message.turnId`, with `held`/`mode` updates the delivery fields.

### Web

- `ChatView.tsx` `onSend`: when `phase === "running"` (or session `starting`), build the payload as today and send with `queued: true`; record the queued `File` objects in a session-local enqueue cache (`components/chat/queuedMessageCache.ts`, keyed by message id, cleared on delivery or withdrawal); skip `beginLocalDispatch` and the optimistic user row (the snapshot arrives with the queued message); clear the draft as today. A queued send never sets `isSendActivelyWorking`.
- `ChatView.logic.ts`: `findLastCancellableDeliveryMessage` and `findActiveDeliveryMessage` ignore `queued` rows; new `selectQueuedMessages(messages)` (ordered) and `deriveQueuedCardStatus({ index, phase, sessionStatus, supportsTurnSteer, delivery })` returning `{ label, canSteer, steerDisabledReason, canCancel }`.
- `MessagesTimeline.logic.ts`: row kind `queued-message { id, createdAt, message, isHead, status }` appended after the `working` row in message order; messages whose delivery is `queued` or `pending/steer` are excluded from the normal `message` rows so they render once; a delivered steered message (its `turnId` now set) renders as a normal user row inside its turn, and `deriveTurnFolds` treats a user message whose `turnId` matches an existing group as part of that group (no new boundary, no fold end); `MessagesTimeline.tsx`: `QueuedMessageTimelineRow` in `components/chat/QueuedMessageTimelineRow.tsx` (dashed bubble reusing `CollapsibleUserMessageBody`, attachment count, footer with `Clock`, `Queued`, status, `ArrowUp` Steer, `X` Cancel; `onPointerDown` preventDefault; tooltips carry disabled reasons).
- Cancel handler: `resolveDelivery({ action: "cancel" })` then `restoreQueuedMessageToComposer` (append with `\n\n`, re-add attachments from the enqueue cache up to `PROVIDER_SEND_TURN_MAX_ATTACHMENTS`, toast on overflow and on attachments that could not be restored because the cache had no entry). Stop handler: cancel and restore each queued message head to tail **first**, then `interruptThreadTurn`; a cancel failure does not block the interrupt. Send now handler (held head, or session not running): `promoteTurn({ messageId })`.
- `apps/web/src/keybindings.ts`: `thread.steerQueuedMessage` intercepted in `ChatComposer.onComposerCommandKey` **before** the `Enter && !shiftKey` / Shift+Enter newline fall-through; steers the head only when `canSteer`.
- `ComposerPrimaryActions.tsx`: no change in shape; the "Cancel queued message" label remains for the legacy blocked-delivery case, which still cannot be `queued`.

## Phases

| #   | Phase                                                                                         | Layer                     | Depends on                         |
| --- | --------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------- |
| 00  | Contracts, capability flag, keybinding command, client-runtime commands and reducer, fixtures | contracts, client-runtime | —                                  |
| 01  | Server: `queued` state, admission, hold, promote on settle, cancel, recovery                  | server                    | 00                                 |
| 02  | Server: steer (driver op, Codex `turn/steer`, Claude, capability, Codex active-turn fix)      | server                    | 01                                 |
| 03  | Web: enqueue path, busy state, queued card, cancel and Stop drain, shortcut                   | web                       | 00, 01 (02 for steer verification) |
| 04  | Docs, WebdriverIO scenario, full verification, runbooks                                       | docs, e2e                 | 03                                 |

Phases are strictly sequential (one Codex task at a time in one worktree). Phase 03 can be started after 01 if 02 is delayed, with Steer rendered disabled by the missing capability.

## Testing strategy

- Contracts: decode/encode of every new shape; fixture export and pinned counts.
- Server: `orchestration.rs` command coverage; live pre-flight probes in Phase 02 (one `turn/steer` against the installed codex app-server; one Claude stream-JSON session fed a second user line mid-turn to observe whether it is consumed inside the running turn or after `result`); engine tests for queued admission (no `turn-start-requested`), promote, cancel/withdraw, steer-requested projection; `turn_delivery` tests for hold, settle promotion, approval/user-input gating, steer claim gating and fallback; `turn_delivery_recovery.rs` rows for `queued` across restart and for `steer` on Codex and Claude; `production_provider_runtime.rs` driver tests with fake transports for `turn/steer` params and the Claude no-`turn.started` guarantee; Codex `active_turn_id` regression.
- Client runtime: reducer cases; command name mapping table.
- Web: `ChatView.logic.test.ts` (busy state ignores queued, card status matrix), `MessagesTimeline.logic.test.ts` (placement, head flag), `QueuedMessageTimelineRow.test.tsx` (labels, disabled reasons, pointer-down), `ChatView.hooks.test.tsx` (enqueue instead of dispatch when running; Stop drains), `keybindings.test.ts`.
- End to end: WebdriverIO spec `apps/desktop/e2e/specs/composer-message-queue.e2e.ts` with the stub providers (queue two, steer head, cancel second, reload mid-queue) and a coordinator Playwright pass against `vp run dev` with real Codex and Claude for acceptance items 3 and 7.
