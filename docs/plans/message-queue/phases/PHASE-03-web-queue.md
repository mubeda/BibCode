# Message Queue / Phase 03 — Web: enqueue path, busy state, queued card, cancel and Stop drain, shortcut

> **For agentic workers:** this phase is implemented by Codex (`codex:rescue`) and reviewed by the coordinating Claude session (including `vercel-react-best-practices` and `UI.md` reviews and a Playwright visual pass). Atomic steps use checkbox (`- [x]`) syntax. Work red → green.

**Goal:** While a turn runs, Enter queues; queued messages render as cards under the working indicator with Steer and Cancel; Cancel and Stop return text to the composer; `Mod+Shift+Enter` steers the head; queued rows never count as busy or working.

**Architecture:** `ChatView.onSend` branches on `phase === "running" || session.status === "starting"` and sends `queued: true` without local dispatch state. Pure helpers in `ChatView.logic.ts` derive the queued list and each card's status. `MessagesTimeline.logic.ts` appends `queued-message` rows after `working`. A new `QueuedMessageTimelineRow` component renders the card. Handlers in `ChatView` wire cancel, steer and the Stop drain through the existing atom commands.

**Tech Stack:** React 19, zustand, `@effect/atom` commands, LegendList, `lucide-react` (`Clock`, `ArrowUp`, `X`), Vitest, Base UI tooltip.

---

## Files

- **Modify:** `apps/web/src/components/ChatView.logic.ts` — `findLastCancellableDeliveryMessage` / `findActiveDeliveryMessage` ignore `queued`; new `selectQueuedMessages(messages: ReadonlyArray<ChatMessage>): ChatMessage[]` (delivery `queued`, or `pending` with `mode: "steer"`, in array order); new `deriveQueuedCardStatus(input: { index: number; phase: SessionPhase; sessionStatus: OrchestrationSessionStatus | null; supportsTurnSteer: boolean; delivery: TurnDelivery; hasPendingApproval: boolean; hasPendingUserInput: boolean }): { label: string; canSteer: boolean; steerDisabledReason: string | null; canCancel: boolean; steering: boolean }` implementing the spec § 6 copy table; new `shouldEnqueueOnSend({ phase, sessionStatus })`; new `isQueuedTimelineMessage(message)` (delivery `queued`, or `pending` with `mode: "steer"`) used to exclude those messages from normal rows.
- **Modify:** `apps/web/src/components/ChatView.logic.test.ts` — matrix tests.
- **Modify:** `apps/web/src/components/ChatView.tsx:4742-5130` — enqueue branch (no `beginLocalDispatch`, no optimistic row, draft cleared, `queued: true`); handlers `onSteerQueuedMessage(messageId)`, `onCancelQueuedMessage(messageId)` (resolve `cancel` then `restoreQueuedMessageToComposer`), Stop drain **before** `interruptThreadTurn` (`:5132-5165`; cancel and restore head to tail, then interrupt; a cancel failure does not block the interrupt); Send now handler → `promoteTurn`; the enqueue path records `File` objects in the cache; `supportsTurnSteer` read from the bound provider snapshot; keybinding handling for `thread.steerQueuedMessage`.
- **Create:** `apps/web/src/components/chat/queuedMessageCache.ts` — session-local `Map<MessageId, { attachments: ComposerAttachment[] }>` with `remember`, `take`, `forget`; test beside it.
- **Create:** `apps/web/src/components/chat/restoreQueuedMessage.ts` — pure `mergeQueuedMessageIntoDraft(draft, message, limits)` returning the next draft plus `droppedAttachmentCount` and `unrestoredAttachmentCount` (attachments present on the message but absent from the cache); test file beside it.
- **Modify:** `apps/web/src/components/chat/MessagesTimeline.logic.ts:97-151, 540-559` — row kind `queued-message { kind; id; createdAt; message; isHead; status }`; input gains `queuedMessages` and `queuedStatuses`; appended after `working`; queued messages are excluded from the `message` rows; `deriveTurnFolds` treats a user message whose `turnId` matches an existing group as part of that group (a delivered steered message renders as a normal user row inside the turn).
- **Modify:** `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` — placement and head tests.
- **Create:** `apps/web/src/components/chat/QueuedMessageTimelineRow.tsx` (+ `.test.tsx`) — dashed right-aligned bubble (`max-w-[80%] rounded-2xl border border-dashed border-border bg-secondary/60 p-3`), body via `CollapsibleUserMessageBody`, attachment count line, footer: `Clock` icon, `Queued`, status label, Steer button (`ArrowUp`, `aria-label="Steer into the running turn"`), Cancel button (`X`, `aria-label="Cancel and return to the composer"`); `onPointerDown={(e) => e.preventDefault()}` on both; disabled reasons in tooltips; `Steering…` state disables both; `role="status"` on the footer; timestamp on hover like user rows.
- **Modify:** `apps/web/src/components/chat/MessagesTimeline.tsx` — render the new row kind; ctx gains `onSteerQueuedMessage`, `onCancelQueuedMessage`, `resolvingQueuedMessageId`.
- **Modify:** `apps/web/src/components/ChatView.hooks.test.tsx` / `ChatView.test.tsx` — enqueue instead of dispatch when running; Stop drains and restores; cancel restores; steer calls the command.
- **Modify:** `apps/web/src/keybindings.ts` (+ test) and `apps/web/src/components/chat/ChatComposer.tsx:1852-1882` — `thread.steerQueuedMessage` intercepted in `onComposerCommandKey` before the `Enter && !shiftKey` submit and the Shift+Enter newline fall-through.
- **Modify:** `apps/web/src/components/Sidebar.logic.ts` — assert (test only) that a thread with only queued messages and a `ready` session shows no `Working` pill.

## Dependencies

Phases 00 and 01 (02 for live steer; without it the flag is false and Steer renders disabled with the reason "This provider cannot steer a running turn").

## Owner Agent

Codex (`codex:rescue`), `--fresh --write`.

## Risk / Effort

Medium risk (busy-state derivation is subtle; `ChatView.tsx` is large). High effort.

## Discipline

- No new store. Queued messages come from the thread snapshot only.
- No optimistic queued row: the snapshot arrives within the same round trip as today's optimistic user row; if the reviewer measures a visible gap, add the optimistic row through the existing `setOptimisticUserMessages` path with `delivery: { state: "queued" }`, never a separate list.
- Follow `vercel-react-best-practices`: derive during render, memoise the card, primitive deps, no inline component definitions, functional `setState`.
- Follow `UI.md`: disabled controls explain themselves; errors are actionable and shown in place; user text is never lost.
- No commits.

## Documents to Read

`AGENTS.md`; `UI.md`; spec § 6 and § 8; plan § Web; `research/bibcode-send-path.md`; `research/upstream-queue.md` (card anatomy and copy); `apps/web/src/components/ChatView.tsx:951-1040, 2420-2530, 4742-5170`; `apps/web/src/components/ChatView.logic.ts:500-620`; `apps/web/src/components/chat/MessagesTimeline.tsx:846-1000`; `apps/web/src/components/chat/MessagesTimeline.logic.ts:378-559`; `apps/web/src/components/chat/TurnDeliveryNotice.tsx`; `apps/web/src/composerDraftStore.ts:261-312`.

## Pre-execution check

- [x] `git status --short` clean apart from this plan's docs and Phases 00–02.
- [x] Re-verify cited lines; note drift in `tasks.md` under "Phase 03".

## Atomic steps

- [x] **Step 1 (red):** `ChatView.logic.test.ts`: `findLastCancellableDeliveryMessage` ignores `queued`; `selectQueuedMessages` order and inclusion of `pending/steer`; `deriveQueuedCardStatus` matrix (head running + steer → "Sends when the turn ends. Steer to send it now."; head running no steer → "Sends when the turn ends." with reason; head after interrupted/error → "Waiting for you", `canSteer` false; non-head → "Sends after the messages above."; steering → "Steering…", both disabled; pending approval → `canSteer` false with reason); `shouldEnqueueOnSend`. Run `vp run --filter @bibcode/web test -- ChatView.logic` — fail.
- [x] **Step 2 (green):** implement the helpers. Pass.
- [x] **Step 3 (red):** `MessagesTimeline.logic.test.ts`: queued rows appended after `working`, in order, `isHead` on the first only; none when the list is empty; a queued message never also appears as a `message` row; a delivered steered user message with the running turn's `turnId` renders as a `message` row inside the turn and does not start a new fold boundary or end the fold. Run — fail.
- [x] **Step 4 (green):** row kind and derivation. Pass.
- [x] **Step 5 (red):** `restoreQueuedMessage.test.ts`: empty draft → message text; existing draft → joined by a blank line; attachments from the cache appended up to the limit; overflow counted; attachments missing from the cache counted as unrestored. Run — fail.
- [x] **Step 6 (green):** implement. Pass.
- [x] **Step 7 (red):** `QueuedMessageTimelineRow.test.tsx`: renders body, count line, labels; Steer hidden/disabled per status with tooltip reason; buttons call handlers; pointer-down prevented; `Steering…` disables both. Run — fail.
- [x] **Step 8 (green):** component. Pass.
- [x] **Step 9 (red):** `ChatView.hooks.test.tsx`: when `phase === "running"`, submit calls `startTurn` with `queued: true`, does not call `beginLocalDispatch`, clears the draft; Stop calls `resolveDelivery(cancel)` per queued message head to tail (restoring in order) and only then `interruptTurn`; a failed cancel still lets the interrupt run; cancel restores text and cached attachments and toasts unrestored ones; Send now calls `promoteTurn` on a held head; `Mod+Shift+Enter` never inserts a newline; `Mod+Shift+Enter` steers the head only when `canSteer`. Run — fail.
- [x] **Step 10 (green):** `ChatView.tsx` wiring, keybinding path, timeline ctx. Pass.
- [x] **Step 11:** Sidebar logic test (no `Working` for queued-only). `keybindings.test.ts` default.
- [x] **Step 12:** `vp run --filter @bibcode/web test`, `vp check`, `vp run typecheck`.
- [x] **Step 13:** paste gate output under "Phase 03" in `tasks.md`; list every changed component and hook for the coordinator's React and UI reviews.

## Verification

- `vp run --filter @bibcode/web test`
- `vp check` · `vp run typecheck`
- Coordinator: `vercel-react-best-practices` review of every changed component/hook; `UI.md` review; Playwright against `vp run dev` with a real Codex thread: queue two, observe cards, steer head, cancel second, reload mid-queue, Stop with a queued message; screenshots viewed.

## Notes for downstream phases

Record the `data-*` attributes added to the card and its buttons (Phase 04's WebdriverIO spec selects by them: `data-queued-message-row`, `data-queued-message-steer`, `data-queued-message-cancel`).
