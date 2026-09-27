# TurnDelivery failure reason, and messages that say why they wait

Status: **Approved (yolo, lane manager) 2026-09-26**. A read-only Codex second opinion reviewed
it; its findings and the rulings are at the end.

This follows up two commits:
- 02535574 made the notice show `delivery.detail`, with the failed copy "Retry sends it again
  unchanged";
- 4afd5d11 made a refused option fail a turn once, with a plain-words detail.

The 02535574 commit body parked this: refusal-specific guidance "needs a contract field that tells
a refusal apart from other failures."

Citations were checked against `dedda27d` (lane branch `lane/wire-followups`).

## Problem and evidence

### 1. A failed delivery cannot say what to change

- `TurnDelivery` is `{ state, provider, mode?, held?, detail? }`
  (`packages/contracts/src/orchestration.ts:304-311`). Nothing tells a refusal apart from any
  other failure.
- The server does tell them apart:
  - A driver refusing the turn's own model or options raises
    `ProviderRuntimeError::InvalidOption`, through `option_error` (`provider_runtime.rs:1616-1632`)
    and at `:4330-4356`, `:6325-6356` and `:9015-9035`.
  - `RefusedOption` documents that "the same request is refused again on every retry"
    (`apps/server/src/provider/mod.rs:70-79`).
  - A launch refused that way fails the delivery once (`launch_failure_outcome`,
    `provider_runtime.rs:1547-1556`), and the worker records it as `failed`
    (`turn_delivery.rs:1288-1313`).
- The distinction is lost in two places:
  - `ProviderDeliveryOutcome::Rejected { detail }` (`provider_runtime.rs:257-262`) carries only
    text;
  - the outbox keeps only `last_error` (`persistence/migrations.rs:2170-2183`).
- So the notice (`apps/web/src/components/chat/TurnDeliveryNotice.tsx`) offers **Retry** for a
  refusal the server knows is deterministic.

### 2. Messages that wait behind an unresolved delivery do not say so

- **How the worker picks.** Per thread it looks only at the oldest row among pending, sending,
  uncertain and failed, in outbox order `(created_at, command_id)`
  (`persistence/repositories.rs:672-685`; `turn_delivery.rs:802-840, 1018-1030`), and it claims
  that row only while it is pending.
- **Why an unresolved head blocks everything.** A row becomes failed or uncertain only by being
  claimed as that head. So an unresolved delivery holds back every later start in its thread,
  until the user retries or dismisses it.
- **A later pending start shows nothing, so it looks sent:**
  - `TurnDeliveryNotice` renders only failed and uncertain;
  - `findActiveDeliveryMessage` ignores a pending row behind an unresolved one
    (`apps/web/src/components/ChatView.logic.ts:531-544`).
- **The queued head card offers Send now that appears to do nothing:**
  - it says **Waiting for you** and offers **Send now** (`deriveQueuedCardStatus`,
    `ChatView.logic.ts:580-632`);
  - manual promotion is blocked only by pending or sending rows, not failed or uncertain ones
    (`repositories.rs:2590-2634`, the `automatic = 0` branch);
  - so **Send now** usually turns the card into one more blocked pending start.
  - Automatic promotion has the same gap, so a card can move into the timeline and wait there
    unexplained.

## Goals and non-goals

**Goals:**

- A typed, optional failure reason on a failed delivery.
  - It is persisted with the outbox row and carried in the delivery event.
  - It is projected onto the message and included in thread snapshots.
  - It starts with one reason: the provider refused the turn's model or options.
- For that reason, the notice says what to change and offers no Retry that would be refused again.
- Pending starts and queued cards behind an unresolved delivery say they wait for it, and **Send
  now** is not offered where it would only join that wait.
- Every pairing of old and new clients and servers keeps working:
  - an old client ignores the field;
  - a new client treats an absent or unknown reason as "no reason".

**Non-goals:**

- Changing the server's claim, promotion or resolution rules.
- "Edit and resend": restoring a failed message into the composer. This is a possible follow-up.
  The message stays in the timeline with its copy button.
- Reasons for other failure classes. Add them when a client can act on them.
- A reason on the thread shell's `unresolvedDelivery`.
- Backfilling reasons into rows that failed before this change. They keep the generic copy.

## Alternatives

### The discriminator

**A. An optional `reason` literal on `TurnDelivery` (recommended).**

- The contract gains `reason?: "modelSelectionRefused"`: the provider refused the turn's model or
  one of its options, and the unchanged durable turn is refused again on every attempt.
- The name follows the contracts' `ModelSelection`, which is the model plus its options
  (`orchestration.ts:65`).
- For: one field says both whether Retry can help and what to change, and it grows one value at a
  time. Against: a closed value set needs forward-compatible decoding (below).

**B. A `retryable: false` flag.** It can hide Retry, but it cannot say what to change.

**C. A reason plus a flag.** The flag follows from the reason, so there would be two sources of
truth.

**Rejected outright:** matching detail text in the web. The detail is prose from one formatter
(`delivery_detail`, `provider_runtime.rs:1558-1614`), so rewording it would silently break the
match.

### Messages that wait

**W1. Derive it in the web from the thread's delivery states (recommended).**

- **The order proxy.** The worker orders deliveries by the outbox's `(created_at, command_id)`.
  The outbox `created_at` is the admitting command's `createdAt` (`turn_identity` →
  `NewProviderTurnDelivery.created_at` → the outbox INSERT), and no later statement changes it.
- **The message timestamp.** The admitted message's `createdAt` starts as that same value, for
  direct and queued admission alike. Only promotion restamps it, which moves it later.
- **The rule.** For an unresolved delivery (failed or uncertain, any mode, not queued),
  `Date.parse(card.createdAt) > Date.parse(unresolved.createdAt)` implies the card really waits
  behind it. The same comparison identifies pending starts that wait. Otherwise the UI stays
  permissive, and the timeline's waiting line explains any row that then waits. The only possible
  error is not disabling Send now, the benign direction.
- **Residual risk.** A promoter whose clock is behind the enqueuer's by more than the
  enqueue-to-promote interval can violate the timestamp assumption. This order proxy supersedes
  the original order-free rulings recorded in second opinions 1 and 6 below.

**W2. Project a per-row `blockedBy`.** It is derived data, and every head transition would
re-project every later row.

**W3. Expose authoritative outbox order or blocker information once per thread.** It is exact for
the edge case above, but it adds new derived server state and a contract field for a rare case.
Revisit if the edge case matters in practice.

## Recommendation: A + W1

### Server

1. **`production/provider_runtime.rs`.** This file is shared with two lanes, so keep the hunks
   minimal: no reformatting or moves.
   - Add `ProviderDeliveryOutcome::Refused { detail: String }` (`:257-262`), with a doc comment:
     a deterministic refusal of the turn's own model or options (`InvalidOption`), refused again on
     every unchanged attempt.
   - Add `fn frozen_failure_outcome(error, label) -> ProviderDeliveryOutcome`, next to
     `launch_failure_outcome`. `InvalidOption` becomes `Refused`; anything else becomes `Rejected`,
     with the same `delivery_detail` text.
   - Use it at the two frozen-route error returns that can carry `InvalidOption`:
     - the retry after launch (`:1524-1528`);
     - the first attempt (`:1535-1538`).
   - `launch_failure_outcome` (`:1547-1556`) returns `Refused` for `InvalidOption`. Other launch
     errors stay `DefinitelyNotSent`.
   - Leave `:1475-1482` alone (its errors are never `InvalidOption`; provider-misc edits
     `launch_request_for_command` just above), and every other `Rejected` site.
   - The out-of-bounds integration tests that match `Rejected` cover route drift and attachment
     failures, not `InvalidOption`. The option-refusal tests assert the durable `failed` state,
     which stays.
2. **`orchestration/delivery.rs`:** `pub enum TurnDeliveryFailureReason { ModelSelectionRefused }`,
   with `as_str()` returning `"modelSelectionRefused"`.
3. **`production/turn_delivery.rs`:**
   - `provider_delivery_outcome` (`:1288-1313`) maps `Refused` to `failed`, its detail and
     `Some(ModelSelectionRefused)`. Every other outcome carries no reason.
   - In `deliver_claimed`, a steer that meets `Refused` returns to the queue, as `Rejected` does
     (`:1194-1201`).
   - `persist_delivery_outcome` (`:1216-1273`) takes the reason and passes it on every attempt of
     its retry loop.
4. **`orchestration/engine.rs`:**
   - Add `transition_turn_delivery_with_reason(transition, Option<TurnDeliveryFailureReason>)`.
     `transition_turn_delivery` delegates with `None`, so existing callers keep compiling.
   - `TurnDeliveryTransition` is unchanged, because a test literal in `production/runtime.rs:1383`
     belongs to in-flight main-3 work. The reason rides in the private `DeliveryTransitionEnvelope`
     (`:1747-1750`).
   - `persist_turn_delivery_transition` (`:4882-4960`):
     - the generic UPDATE writes `failure_reason` with `state` and `last_error`, non-NULL only when
       `next_state` is failed;
     - the requeue branch clears it;
     - the event's nested `delivery` gains `reason` only when present.
   - Retry (`:5032`) and Dismiss (`:5040`) set `failure_reason = NULL`. These are the only other
     statements that move a row out of failed. Claim, promotion, steer, cancel and requeue never
     touch a failed row, and they must leave the column NULL.
   - The message projector (`:5622-5647`) sets `delivery_reason = ?` from
     `payload.delivery.reason`. It is a plain assignment, not `COALESCE`, so any later delivery
     update clears it.
5. **`persistence/migrations.rs`:** migration 051, registered after 050:
   - `provider_turn_outbox.failure_reason TEXT` and `projection_thread_messages.delivery_reason TEXT`,
     both nullable with no default;
   - update the hard-coded latest-migration expectations (`:681`, `:3106`).
6. **`persistence/repositories.rs`:** `ProjectionThreadMessage.delivery_reason: Option<String>`,
   with its SELECT, decode and upsert. The outbox's `ProviderTurnDelivery` is unchanged, because
   no server logic reads the reason back yet.
7. **`production/orchestration_rpc.rs`:** the thread snapshot's message `delivery` gains `reason`
   when present (`:1030-1050`), and its test literals gain the field.
8. **`apps/server/tests/repositories.rs`:** `delivery_reason: None` in its two literals
   (controller-approved, two lines).

**Existing databases, restart and replay:**

- Old rows read as "no reason".
- The reason reaches the projection only through `thread.turn-delivery-updated`, which is written
  in the same transaction as the outbox update. So a projection rebuilt from events restores it.
- Events from before this change carry no reason.
- Restart recovery scans only sending rows, and `replayEvents` returns payloads verbatim.

### Contracts (`packages/contracts/src/orchestration.ts`)

- `TurnDeliveryFailureReason = Schema.Literals(["modelSelectionRefused"])`.
- `TurnDelivery.reason`: `Schema.optionalKey` over the literals with
  `Schema.catchDecoding(() => Effect.succeedNone)`. An unknown value from a newer server decodes as
  absent instead of failing the snapshot. The precedent is `settings.ts:85`.
- A doc comment says the reason is set only while the state is `failed`.
- Run `vp run check:contracts`, and commit any regenerated fixtures.

### Provider instance naming

The controller's addition makes `TurnDelivery.providerInstanceId` an optional `ProviderInstanceId`:
it identifies the provider instance the delivery is routed to and is absent from older servers.
The outbox already stores `provider_instance_id`; migration 051 adds the nullable projection
column `delivery_provider_instance_id`. Every `thread.turn-delivery-updated` event carries the
outbox instance in its nested `delivery`, and snapshots include it when set. The projection keeps
it once set, including when an older event lacks the field.

The web resolves the name the standard way: the instance entry from `deriveProviderInstanceEntries`
plus `applyProviderInstanceSettings` in `apps/web/src/providerInstances.ts`. This gives the settings
name, then the snapshot's `displayName`, then the driver name. It falls back to the driver name
when the instance no longer exists or the field is absent (an old server or event). It is never
the composer's current selection. This naming applies to both the notice copy and the uncertain-Retry
confirmation.

### Web

**Shared logic (`ChatView.logic.ts`):**

- `deliveryOffersRetry(delivery)`: false only for `failed` with reason `modelSelectionRefused`.
- `findBlockingDelivery(messages)`: the thread's unresolved delivery (failed or uncertain, any
  mode, not a queued-timeline message), or null.
- `deriveQueuedCardStatus` gains `blockingDelivery`. For the head card, right after the `steering`
  and `index > 0` checks, apply the waiting status only when
  `Date.parse(card.createdAt) > Date.parse(blockingDelivery.createdAt)`; otherwise keep Send now
  permissive:
  - label: **Waiting for an earlier message**;
  - Steer and Send now are disabled with "Retry or dismiss the earlier message first", or "Dismiss
    the earlier message first" when that delivery offers no Retry.
  - Later cards keep "Sends after the messages above."

**`chat/TurnDeliveryNotice.tsx`:**

- **Failed with `modelSelectionRefused`:**
  - heading and detail are unchanged;
  - guidance: "Sending it again unchanged would fail. Dismiss it, then send it again with another
    model or without that option.";
  - only **Dismiss** is shown.
- Every other failed and uncertain notice is unchanged.
- **A pending start later than a blocking delivery** (not the message itself, and with
  `Date.parse(message.createdAt) > Date.parse(blockingDelivery.createdAt)`): a muted,
  non-alert line, "Waiting for an earlier message. Retry or dismiss it to send this one." ("Dismiss
  it…" when that delivery offers no Retry).
- **Wording.** "Earlier" matches the existing "later messages wait behind it" and holds in outbox
  order.

**`ChatView.tsx`:** compute `findBlockingDelivery` once per messages array. Pass it into the queued
statuses and to the timeline.

**`chat/MessagesTimeline.tsx`:** pass it to `TurnDeliveryNotice` through the existing row context.
The value changes only when the blocker changes.

### Docs

- **`docs/architecture/rpc-and-orchestration.md`:**
  - the delivery notice paragraph: the reason and its only value;
  - the durable message queue section: the persisted `failure_reason` and `delivery_reason`
    columns, their lifecycle (set on failed, cleared by retry, dismiss and any later update, and
    restored on replay), and the client's blocking rule.
- **`docs/user/workspace-ui.md`:** the refused notice, the waiting line and the queued card.
- **`docs/testing/cross-platform-validation.md`:** review the queue steps. Add one refused-option
  check only if that scenario covers delivery notices; otherwise state "reviewed and remain
  accurate".

### Copy rules (UI.md)

- Say what failed (the detail), why Retry won't help, and what to do next.
- Don't offer an action that cannot work.
- A disabled Send now or Steer explains itself.
- The message stays in the timeline with its copy button, so no work is lost.

## Affected files

- **Server:**
  - `apps/server/src/production/provider_runtime.rs` (hunks at `:257-262` and `:1520-1570` only);
  - `apps/server/src/orchestration/delivery.rs`;
  - `apps/server/src/production/turn_delivery.rs`;
  - `apps/server/src/orchestration/engine.rs`;
  - `apps/server/src/persistence/migrations.rs`;
  - `apps/server/src/persistence/repositories.rs`;
  - `apps/server/src/production/orchestration_rpc.rs`;
  - `apps/server/tests/repositories.rs` (two lines).
- **Contracts:**
  - `packages/contracts/src/orchestration.ts` and `orchestration.test.ts`;
  - regenerated `packages/contracts/fixtures/**`, only if `check:contracts` changes them.
- **Client runtime:** `packages/client-runtime/src/state/threadReducer.test.ts`.
- **Web:**
  - `apps/web/src/components/chat/TurnDeliveryNotice.tsx` and its test;
  - `apps/web/src/components/ChatView.logic.ts` and its test;
  - `apps/web/src/components/ChatView.tsx`;
  - `apps/web/src/components/chat/MessagesTimeline.tsx`, and its test if one covers the notice.
- **Docs:** the three docs above, plus this design at
  `docs/superpowers/specs/2026-09-26-turn-delivery-failure-reason-design.md`.

## Tests

- **Rust:**
  - `InvalidOption` on launch, on the first frozen attempt and on the retry after launch becomes
    `Refused`, and other frozen errors stay `Rejected`;
  - `Refused` persists `failed`, the detail and the reason, on the row, the event and the snapshot;
  - retry and dismiss clear the reason in the outbox and in the projected message;
  - a steer meeting `Refused` returns to the queue;
  - the snapshot wire includes `reason` only when present;
  - a projection rebuilt from events restores the reason;
  - a delivery-loop case extending the existing refusal tests in `turn_delivery.rs` unit tests (a
    refused option ends the turn once, with the reason).
- **Migration 051:** both columns are added as NULL on an existing database, and an existing failed
  row stays readable with no reason.
- **Contracts:**
  - decode with and without `reason`;
  - an unknown reason decodes as absent;
  - `reason` survives inside `ThreadTurnDeliveryUpdatedPayload`.
- **Client runtime:** the reducer carries `reason`, and a later update without it clears it.
- **Web:**
  - the refused notice has no Retry and has the new guidance;
  - other notices are unchanged;
  - a pending start shows the waiting line in both copies;
  - the head card is blocked with its reason, and later cards are unchanged;
  - `findBlockingDelivery` ignores queued rows and resolved rows, and it finds an uncertain steer.
- **Live (Playwright, light and dark), on an isolated dev server with a fake provider that refuses
  an option:**
  - the refused notice;
  - a pending start waiting behind it;
  - a queued card waiting behind it, with its disabled reason;
  - after Dismiss, the pending start is claimed and the card follows the normal queue rules.

## Risks

- **`provider_runtime.rs` is shared.** The READY file lists exact line ranges.
- **The W1 order proxy** keeps Send now permissive when timestamps do not prove that a card waits.
  When the failed head was itself promoted, its message `createdAt` is the promotion time while
  its outbox row retains the enqueue time. A pending start admitted between those times sits
  behind it in outbox order, but `waitsBehind` returns false, so that row shows no waiting line.
  Conversely, a promoted pending row whose enqueue time is older than the head's can show a
  transient false waiting line until it is claimed. Both errors are permissive or transient;
  the outbox remains authoritative for delivery order. Residual risk: a promoter whose clock is
  behind the enqueuer's by more than the enqueue-to-promote interval.
- **A restore restart can mask the turn's own refusal.** During a live selection change, a failed
  restore restart propagates its own error instead of the turn's refusal
  (`provider_runtime.rs:4122-4146`, second opinion 2). The classification follows whatever error
  propagates, so a restart refusal of the previous configuration would read as "refused". The
  detail still names the refused option.
- **Dismissing a refused message lets later messages go first,** so a corrected resend lands after
  them. The follow-up "Edit and resend" would address that.
- **A later reason value needs a web mapping.** Until then, the generic copy applies.

## Second opinion (Codex, read-only) and rulings

1. **Evidence:** agreed. Blocking follows outbox order. Ruling: W1 keys on delivery states, not on
   timeline order.
2. **Coverage:** no missed `InvalidOption` site. `:1475` is redundant. Ruling: leave `:1475`
   untouched, and record the restore-restart risk.
3. **`catchDecoding` with `Option.none`:** valid on effect 4.0.0-beta.107. Ruling: use
   `Effect.succeedNone`.
4. **Naming:** agreed on `modelSelectionRefused`.
5. **Persistence:**
   - register 051, fix the expectations, and thread the reason through the retry loop;
   - Retry and Dismiss clear the reason; the other statements never touch failed rows.

   Ruling: adopted as written.
6. **Web ordering:** ties, skew and promotion restamps make timeline order unreliable, and
   uncertain steers also block. Ruling: the order-free rule over any mode.
7. **"Put the reason on the existing transition":** rejected. `runtime.rs` belongs to in-flight
   work, and the delegating method keeps every caller unchanged. "Dismiss releases both"
   overpromised; the live check wording is fixed.
