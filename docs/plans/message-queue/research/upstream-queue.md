# Research — upstream reference message queue (2026-09-22)

Source: the upstream reference checkout at `aff9318bf` ("fix(web): retry failed
attachment uploads after reconnect (#10338)", 2026-09-22). Electron 44 shell,
React 19 web app, Effect server. Read-only survey; line numbers are from that
revision.

## Queue state

`apps/web/src/queuedMessageStore.ts` — one **client-side zustand store**,
in memory only (`:70` "a queued message is a live intent, not a draft worth
persisting"). Lost on reload; each connected client has its own queue.

Shape `QueuedComposerMessage` (`:15-36`): `id`, `prompt`, `images`, `files`,
`terminalContexts`, `previewAnnotations`, `reviewComments`,
`submissionIntent` (`foreground | background | alternate`),
`queuedAfterToolActivityId`, `holdUntilUserAction?`, `createdAt`. No model or
mode snapshot: the send path re-reads the live selection.

State: `queuesByThreadKey: Record<threadKey, QueuedComposerMessage[]>` (FIFO
per thread) and `drainGeneration`. Ops: `enqueue`, `take`, `remove`,
`holdAtFront`, `drain`.

## Composer behaviour

Decision at `components/ChatView.tsx:7632-7663`: when
`phase === "running"`, Enter queues and Mod+Enter steers (the
`followUpBehavior` setting inverts both; default `queue`). On queue the
composer clears fully and attachments move into the queued entry. No in-place
editing of a queued card; Cancel is the edit path.

- **Send now** (`:8654-8658`) sends the queued message as an ordinary
  `sendTurn` while the turn runs, which every adapter treats as a **provider
  steer**, not an interrupt. Shortcut `mod+shift+enter` →
  `thread.steerQueuedMessage` (`packages/shared/src/keybindings.ts:45`),
  head of queue only.
- **Cancel** (`:8659-8663`) → `restoreQueuedMessagesToComposer`
  (`:7203-7263`): prompts joined with blank lines, attachments re-added up to
  the provider limit, overflow re-queued with `holdUntilUserAction` and a
  toast. Never discards.

## Auto-send trigger

`queuedMessageStore.ts:188-197`:

```ts
if (input.message.holdUntilUserAction) return false;
if (input.phase === "connecting") return false;
if (input.phase !== "running") return true;
return input.latestToolActivityId !== input.message.queuedAfterToolActivityId;
```

So a queued message fires **mid-turn at the next completed tool call** or as
soon as the phase leaves `running`. One message per boundary; `take()`
re-anchors the rest. Dispatch is a `useEffect` (`ChatView.tsx:8633-8645`)
guarded by `isSendBusy`, pending approvals/questions, offline environment,
unhydrated settings and checkpoint rewinds.

Race handling: `take()` returns null when another caller took the head;
Stop drains the whole queue back into the composer (`:3972-3980`);
`drainGeneration` is captured at take and re-checked after attachment upload;
a failed send calls `holdAtFront`. Two clients or a reload: no coordination.

## Server side

No server queue. A `sendTurn` during a running turn is a steer in every
adapter:

- Claude (`apps/server/src/provider/Layers/ClaudeAdapter.ts:5153-5162`):
  "the message is queued into the live SDK agent loop and the work continues
  as the same turn — no synthetic turn boundary"; reuses the running
  `turnId`.
- Codex (`CodexSessionRuntime.ts:2533-2551`): `turn/start` while running;
  "Codex accepts follow-ups while the current turn is still running… the
  response contains the queued turn id, but `turn/interrupt` only accepts
  the id that is active now", hence `activeTurnId: session.activeTurnId ?? turnId`.

## UI

Row kind `queued-message` appended after all live rows including the working
row (`MessagesTimeline.logic.ts:1456-1464`). `QueuedMessageTimelineRow`
(`MessagesTimeline.tsx:1758-1858`): dashed right-aligned bubble, prompt body,
attachment summary, clock icon + `Queued`, status label ("Waits for Send
now" / "Sends after the next tool call or when the turn ends" / "Sends after
the messages above it"), `ArrowUpIcon` "Send now" and `XIcon` "Cancel and
return to the composer". Buttons `preventDefault` on pointer-down to keep
composer focus. `WorkingTimer` writes `textContent` on a 1 s interval.

## Tests

`queuedMessageStore.test.ts` (ordering, take-once, re-anchor, hold, drain,
dispatch timing); `MessagesTimeline.logic.test.ts:1095-1240` (placement,
`isNext`); `keybindings.test.ts:1226`. No test covers the auto-send effect,
`drainGeneration` or the Stop drain.

## What BibCode takes and what it changes

Taken: card anatomy and copy, FIFO per thread, head-only steer shortcut,
Cancel restores instead of discarding, Stop drains, never auto-send into a
pending approval or question.

Changed: the queue is server-owned and durable (BibCode serves browser,
desktop and remote clients concurrently, so a client-only queue double-sends
and vanishes on reload); auto-send waits for the turn to settle instead of
the next tool boundary (predictable on every provider); Steer is an explicit
provider steer operation with a capability flag rather than an accidental
second `turn/start`; model and modes are snapshotted at enqueue.
