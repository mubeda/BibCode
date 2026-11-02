# Thread History Window

Status: Draft for approval, revision 3, 2026-11-01. Issue #226.

- Depends on #225, the 3G baseline and the byte-budget test.
- Lands after #227, because it reuses #227's `filesTotal` checkpoint field.
- Composes with #223, the shell side.

No code until this is approved.

Revisions 2 and 3 answer two Codex reviews, of `9ec004e40` and `0ab5e0dc1`.
The section [Review resolutions](#review-resolutions) at the end maps each
finding to the change it caused.

Revision 3 replaces several special cases with one rule. A row is in the
window if it's recent by `K`, or it was written after the window opened, or
it's still live. A row that's in the window always wins over any other copy.

## Problem

Opening a thread sends all of it: every message, activity payload, reasoning
row, plan and checkpoint. That happens on first open, on a reload with no
cache, and on every resume the server can't answer with `unchanged`. A long
agent thread is megabytes of JSON. On a remote or slow link the chat stays
blank until all of it arrives, though the timeline first shows only the last
few turns.

## Current behavior (verified at `9c8799b80`)

### Server

- **Registration.** `orchestration.subscribeThread` is registered with
  `registry.register_stream` (`apps/server/src/production/orchestration_rpc.rs:262-265`).
  Its read scope is listed at `apps/server/src/auth/scope.rs:57`.
- **Input.** `SubscribeThreadInput` (`orchestration_rpc.rs:2293-2303`) has
  `threadId`, `patches` and `resume`. Serde ignores unknown fields, so an older
  server ignores new input fields.
- **First load.** `thread_stream_with_keys` (`:1419-1520`) subscribes to engine
  events, then loads `thread_snapshot` (`:1591-1596`). That calls
  `load_thread_snapshot` (`apps/server/src/orchestration/engine.rs:8917-8991`),
  which reads all of the thread's messages, reasoning, activities, plans, turns
  and checkpoints, and then `in_canonical_order` (`engine.rs:8995-9036`).
- **Array order.** It isn't chronological for every array:
  - messages: queued last, then by `message_id` (`engine.rs:8999-9012`);
  - plans: by `plan_id`;
  - checkpoints: by `checkpoint_turn_count`;
  - activities: `sequence, created_at, activity_id`
    (`apps/server/src/persistence/repositories.rs:3398`);
  - reasoning: by `created_at, reasoning_id`.

  The client sorts for display.
- **Serialization.** `thread_snapshot_value` (`orchestration_rpc.rs:1599-1643`)
  runs `thread_detail_rows` (`:1772-1807`, every row) and `thread_detail`
  (`:1645-1760`). The detail holds:
  - messages (`:1649-1700`);
  - activities with full `payload` (`:1701-1720`);
  - plans with full markdown (`:1721-1739`);
  - checkpoints with full `files` (`:1740-1758`);
  - reasoning (`:1618-1641`).

  None of these is bounded. Message text has no size limit
  (`packages/contracts/src/orchestration.ts:380`).
- **First item.** It's `unchanged` when `resume.revision` matches and the
  sequence is not behind (`:1452-1467`). Otherwise it's a `snapshot`
  (`send_snapshot`, `:1523-1538`).
- **Updates.** Each thread event, or `Lagged`, schedules one re-read 100 ms
  later (`THREAD_UPDATE_COALESCE`, `:1199`, loop `:1474-1516`). Each re-read
  loads and serializes the whole thread again. It's diffed against
  `HeldThread` (`:1205-1293`), which holds keyed 64-bit fingerprints per field
  and per array entry. The result is sent as a `patch` (`thread_patch`,
  `:1352-1400`): array `length`, plus the entries that differ at the same
  index.
- **Revision.** `HeldThread::revision` (`:1266-1292`) is a digest under
  per-process keys (`ThreadRevisionKeys`, `:1214-1234`).
- **Paging precedent.** `orchestration.replayEvents` has a byte-budgeted page
  mode that always keeps its first item (`REPLAY_PAGE_TARGET_BYTES`, `:52`;
  `ReplayBudget`, `:2170-2175`).
- **Rows are deleted outside reverts too.** A withdrawn queued message is
  deleted (`engine.rs:7518-7528`). The projection tables use implicit rowids
  without `AUTOINCREMENT`, so SQLite can hand a deleted top rowid to the next
  insert. A rowid is therefore not a safe "written after" marker.
- **Reverts delete rows.** `thread.reverted` deletes messages, reasoning and
  activities of the reverted turns (`engine.rs:7508-7517`).
- **Projections are rebuildable.** They're rebuilt from the event log
  (`apps/server/src/persistence/migrations.rs:2380`). A rebuild replays the same
  event `sequence` values, but rows get new rowids.
- **Open requests are server state.**
  - Approvals live in `projection_pending_approvals` (`migrations.rs:1012-1020`).
  - Open user-input requests come from `open_user_input_requests_sql`
    (`repositories.rs:4230`).
  - A request expires only on evidence that it can no longer be answered
    (`engine.rs:5791-5793`). A completed turn keeps its requests.
  - OpenCode asks recovered after a restart can have no turn id
    (`apps/server/src/provider/opencode/runtime.rs:3969`).
- **Streaming rows keep their identity as they grow.** A delta appends to the
  text and keeps `created_at` (`engine.rs:7570-7580` for messages,
  `:7631-7636` for reasoning). Settlement is an `UPDATE … SET is_streaming = 0`
  inside the projector transaction (`:7558`, `:7621`).
- **Queue order is the admission sequence.** Queued messages sort by durable
  admission sequence, not by timestamp (`repositories.rs:3391`).
  `selectQueuedMessages` keeps array order (`apps/web/src/components/ChatView.logic.ts:645-648`),
  and the head action requires `queuedMessages[0]` (`ChatView.tsx:5230-5237`).
- **Status readers skip malformed rows.** They keep an older valid snapshot
  instead (`apps/web/src/lib/contextWindow.ts:57-66`, tested at
  `contextWindow.test.ts:145`; `McpStatusPopover.tsx:67-71`).
- **Implementation turns name their source plan.** `projection_turns` records
  `source_proposed_plan_thread_id` and `source_proposed_plan_id`
  (`migrations.rs:1151-1152`).

### Contract

- `OrchestrationThread` (`packages/contracts/src/orchestration.ts:559-593`)
  holds plain arrays. Nothing says "more history on the server".
- `OrchestrationSubscribeThreadInput` (`:734-750`) has optional `patches` and
  `resume`, both documented as "older servers ignore it".
- Related schemas:
  - `OrchestrationThreadPatch` (`:1690-1701`);
  - `OrchestrationThreadStreamItem` (`:1710-1735`);
  - `OrchestrationRpcSchemas` (`:1850-1879`);
  - the RPCs in `packages/contracts/src/rpc.ts:1991-2040`;
  - the local API in `packages/contracts/src/ipc.ts:1651-1662`.
- Fixtures: `packages/contracts/fixtures/thread-stream/{lifecycle,resume}.json`
  and `rpc-wire/`.

### Client runtime

- `makeEnvironmentThreadState` (`packages/client-runtime/src/state/threads.ts`)
  starts from `cache.loadThread`.
  - It keeps `resumeFrom` in memory (`:79`).
  - It persists the thread, debounced 500 ms (`:83-104`).
  - It applies items in `applyItem` (`:163-226`). A `snapshot` replaces the
    thread. A `patch` applies by index through `applyThreadPatch`. `unchanged`
    keeps the thread.
  - It builds each resubscribe's input lazily (`:233-241`).
- `createEnvironmentThreadDetailAtoms` (`state/threadDetail.ts:110-190`) keeps
  unchanged entries by identity (`shareUnchanged`, `:184`).
- The cached record is `StoredThreadSnapshot { schemaVersion: 1, …, thread }`
  (`apps/web/src/connection/storage.ts:62-68`).

### Web: readers of the whole loaded thread

- **Timeline.** `MessagesTimeline` renders `LegendList`
  (`apps/web/src/components/chat/MessagesTimeline.tsx:701-725`).
  `maintainVisibleContentPosition` is `{ data: true, size: true }`, except
  while a key scroll is pending (#207) (`MessagesTimeline.logic.ts:50-62`).
  Timeline entries come from a single call to `deriveTimelineEntries`
  (`ChatView.tsx:2689`, `session-logic.ts:1362`). Find in thread, the turn
  folds and the minimap all read those entries.
- **Turn folds.** `deriveTurnFolds` (`MessagesTimeline.logic.ts:518-690`) uses
  `latestTurn` timings for the latest turn. Any other turn uses its user
  message, or else its first entry.
- **Pending approvals and user input** are derived from activities
  (`session-logic.ts:347-403`, `:457`).
- **MCP status and context-window usage** scan the activities for the newest
  matching row (`apps/web/src/components/chat/ChatComposer.tsx:999-1012`;
  `McpStatusPopover.tsx:52-81`; `lib/contextWindow.ts:54`).
- **Queue and delivery cards**: `ChatView.tsx:677-709`, `:2333-2338`.
- **Plans.** The Plan panel uses `findLatestProposedPlan`
  (`ChatView.tsx:2284-2291`). While an implementation turn runs, the sidebar
  shows its source plan, looked up by id in the source thread's
  `proposedPlans` (`session-logic.ts:596-618`, `ChatView.tsx:1653-1675`).
- **"Has this thread any message"** checks: `ChatView.tsx:2818`, `:4286`, and
  `:5579`, which decides whether to create a worktree on send. Also
  `ChatView.logic.ts:422`.
- **Checkpoints.** The timeline's changed-files list reads
  `turnSummary.files` (`MessagesTimeline.tsx:1839`). Diff summaries and revert
  read `thread.checkpoints` (`hooks/useTurnDiffSummaries.ts:5-19`,
  `ChatView.tsx:4999`).
- **Not affected.** BiBCode has no conversation export and no per-message
  unread marker. MCP reads and the HTTP snapshot don't use this stream
  (`all_thread_detail_rows`, `orchestration_rpc.rs:1810`).

### Not measured

`v015b/225-load-budget` has no commits yet. The budget numbers below are
provisional and are settled against #225 before implementation starts.

## Design

### 1. Three kinds of content

| Kind | What | On the wire |
| --- | --- | --- |
| **History rows** | messages, activities, reasoning, proposed plans | windowed (§2); older rows load in pages |
| **State rows** | immutable activities, and plans, that current state needs but the window may not hold (§4) | in `thread.history.carried`, used by state readers only |
| **Turn index** | checkpoints | every checkpoint, but `files` only for turns in the window or a loaded page (§5) |

Everything else on the thread is the fixed-size shell: title, session, latest
turn, and so on.

### 2. Order, the floor, and the window rule

**The history key.** Every history row has
`K = (createdAt, kindRank, id)`, with `kindRank` message=0, activity=1,
reasoning=2, plan=3. `createdAt` is the order the timeline shows, so a range
cut by `K` is one contiguous slice of the timeline across all kinds.

**Write sequence.** A new column `written_sequence INTEGER NOT NULL DEFAULT 0`
goes on the four history tables. Every write sets it to the sequence of the
event being projected (`event.sequence`). That covers the insert, every
`ON CONFLICT … DO UPDATE`, a streaming delta, the settlement `UPDATE`s at
`engine.rs:7558` and `:7621`, and delivery updates.

This fixes what a rowid can't:

- It never repeats, because event sequences are `AUTOINCREMENT`
  (`migrations.rs:841`).
- A rebuild replays the same sequences, so it's identical after a rebuild.
- Existing rows get 0, which correctly means "not written since any window
  opened".

A test asserts that every write path to these tables sets it.

**History epoch.** A new column `history_epoch INTEGER NOT NULL DEFAULT 0`
goes on `projection_threads`. The `thread.reverted` projection sets it to that
event's `sequence`, so it's also rebuild-stable. Reverts are the only deletions
that can touch settled rows; a withdrawn message is always live (see below).

**The window rule:**

```
inWindow(row) = floor == ALL
             || K(row) >= floor.K                    // recent
             || row.written_sequence > floor.openedAt // written since the window opened
             || live(row)                             // can still change, or needs the user
```

`live(row)` holds for:

- a message or reasoning row with `is_streaming = 1`;
- a message whose delivery is `queued`, `pending`, `sending`, `uncertain` or
  `failed`.

The floor is `{ K | ALL, openedAt, epoch }`:

- `openedAt` is the `snapshotSequence` when the window was chosen.
- `epoch` is `history_epoch` at that moment.
- `ALL` means the whole thread: an empty thread, or one that fits the budget.

**Rows only ever enter the window.** A row stops being live only through a
write: a settlement, a delivery update, a dismissal or a withdrawal. That write
sets `written_sequence > openedAt`, so the row stays in the window, unless the
write deleted it, and then its removal is real. `K` and `openedAt` are fixed for
the subscription. So patches stay index-based, nothing outside the window is
sent as a removal, and:

- **A message from a skewed client clock** joins the window through
  `written_sequence`, though its `createdAt` sorts below `floor.K`.
- **A streaming row that predates the floor** is in the window from the cold
  open (`live`). Each delta keeps it there, and so does its settlement.
- **A settled row that changes later** (a plan marked implemented, a dismissed
  failure) moves into the window. The window's copy wins over any copy a page
  loaded earlier, so loaded pages can't show a stale or deleted version.

### 3. Choosing the floor (server, at open)

1. **Budget for rows.** Serialize the fixed parts first: the shell, live rows,
   carried state rows (§4) and the turn index (§5), counting bytes with a
   counting `io::Write`. The history-row budget is `HISTORY_OPEN_BYTES` minus
   that total, floored at 0.
2. **Walk newest first.** Walk the other history rows newest first by `K`,
   counting bytes and rows. At each **user message**, record a turn cut. Stop
   before the next row would exceed the row-byte budget,
   `HISTORY_WINDOW_ROWS`, or `HISTORY_WINDOW_TURNS` user messages.
3. **The newest row is always taken**, however large. This is the
   `ReplayBudget::Page` rule. A settled 3 MiB assistant message opens as a
   window of one row. Only a row over the transport's 64 MiB message limit
   fails, as it does today (`MAX_RECORDED_MESSAGE_BYTES`,
   `apps/server/src/rpc/transport.rs:58`).
4. **Where the floor goes:**
   - If the walk reaches the oldest row, or there are no history rows, the
     floor is `ALL` and `hasOlder` is false.
   - Otherwise the floor is the oldest turn cut reached, so every turn is
     whole.
   - If no turn cut was reached (one turn over budget, such as a 900-row tool
     run), the floor is the `K` of the oldest row taken. `latestTurn` timings
     keep that turn's duration right.
5. **`olderRows`** is the number of history rows below the floor at open.

### 4. Carried state rows

Some current state comes from rows that never change and so never enter the
window by the rule above. An open request is resolved by a *different*
activity, and a status reader keeps an older valid row when the newer ones
aren't valid.

For these, the server sends **the rows the readers would select**, recomputed
on every read and computed by the same selectors the readers use:

- **Open requests.** Every `*.requested` activity whose request is still open:
  - an approval whose `projection_pending_approvals` row is `pending`;
  - a user-input request in `open_user_input_requests_sql`.

  This covers any turn, a completed turn, and turnless recovered OpenCode
  asks. It's the server's own open-request policy.
- **Effective status.**
  - The row `deriveLatestContextWindowSnapshot` would return: the newest
    `context-window.updated` with a valid `usedTokens`.
  - Per `providerInstanceId`, the row `deriveMcpStatusSnapshot` would return:
    the newest MCP status activity whose snapshot parses.

  Rust ports of the two validity checks live next to the selector. One shared
  fixture, `packages/contracts/fixtures/thread-stream/carried-status.json`,
  lists valid and malformed payloads, including a malformed newest row over a
  valid older one. The Rust test and the web reader tests both run against it,
  so the two can't drift apart.
- **Plans.** The newest proposed plan, plus any plan named as
  `source_proposed_plan_id` by a turn in state `running`.

A selected row is carried only when it isn't already in the window. Every rule
is bounded: by open requests, by one row per status key, or by running
implementation turns. `carried` holds `activities` and `proposedPlans` only.
Messages and reasoning that matter to state are live, and so already in the
window.

### 5. Turn index (checkpoints)

Every checkpoint is sent, so revert, the diff summaries and the Diff panel's
turn list are unchanged.

A checkpoint whose turn has no history row in the window is sent with
`files: []` and `filesTotal: n`. That's #227's field, and #227 caps `files` at
200 for the rest. Its skeleton is about 200 bytes, counted in the open budget.

A history page returns the full checkpoints of the turns its rows belong to.

### 6. Wire contract (`packages/contracts`, schema only)

**Subscribe input**, optional:

```ts
history: Schema.optional(Schema.Struct({
  floor: Schema.optional(TrimmedNonEmptyString), // echo of thread.history.floor
})),
```

**A new field on the thread**, optional. It's present only on a windowed
thread from the thread stream:

```ts
history: Schema.optional(Schema.Struct({
  floor: TrimmedNonEmptyString,   // opaque cursor: { v, k | null, openedAt, epoch }
  hasOlder: Schema.Boolean,
  olderRows: NonNegativeInt,      // rows below the floor at open
  carried: Schema.Struct({            // state rows selected as in §4; never shown in the timeline
    activities: Schema.Array(OrchestrationThreadActivity),
    proposedPlans: Schema.Array(OrchestrationProposedPlan),
  }),
})),
```

`HeldThread` fingerprints `history` and the revision covers it. A full thread
has no `history` key, so its revision can't equal a window's.

**New unary RPC `orchestration.getThreadHistoryPage`:**

```ts
input:  { threadId: ThreadId, cursor: TrimmedNonEmptyString }
output: {
  messages, activities, reasoning, proposedPlans,  // same element schemas as the thread
  checkpoints: Array(OrchestrationCheckpointSummary), // full, for the page's turns
  cursor: Schema.NullOr(TrimmedNonEmptyString),       // null: nothing older
  olderRows: NonNegativeInt,
}
// typed failures:
//   OrchestrationThreadHistoryStaleError  (the cursor's epoch is not the thread's)
//   OrchestrationGetThreadHistoryPageError (malformed cursor, unknown thread, …)
```

The page returns rows with `K < cursor.K` that are not `inWindow` under the
cursor's floor at the time of the page: `written_sequence <= cursor.openedAt`
and not `live`. Rows come newest first. It stops at `HISTORY_PAGE_ROWS` or
`HISTORY_PAGE_BYTES`, always keeping the first row. The next cursor is the `K`
of the oldest row returned, with the same `openedAt` and `epoch`.

So a page never holds a live row: no queued, in-flight or failed message, and
no streaming row. A page row that is written later moves into the window, and
the client lets the window's copy win (§8). A page can repeat a carried
activity or plan; the client dedupes it by id.

A page is served only if `cursor.epoch` equals the thread's `history_epoch`.
That check is the durable fence for a revert the client missed.

The cursor is base64url JSON. It holds ids, timestamps and sequences, never
content. The client only stores it and echoes it back.

Rows use the existing serializers. `thread_detail`'s per-row `json!` blocks
move into shared `message_value`, `activity_value`, `reasoning_value` and
`plan_value`.

### 7. Server stream

`thread_stream_with_keys` keeps an `Option<HistoryWindow>` per subscription.
It's `None` unless the input has `history`.

- **Open.** Choose the window (§3).
  - With a valid `history.floor` whose `epoch` equals the thread's
    `history_epoch`, the server uses that floor instead. This keeps the pages
    the client already loaded contiguous across reconnects and restarts.
  - If the rows at or above the client's floor would serialize over
    `HISTORY_FLOOR_HONOUR_BYTES`, a fresh window is picked instead.
  - A malformed or stale floor also gets a fresh window.
- **Resume.** The logic is unchanged. The revision is computed over the window
  value, so a client that sends its floor and current revision gets
  `unchanged`. One revision per window as sent.
- **Every re-read**, whatever triggered it (event or `Lagged`), compares the
  loaded thread's `history_epoch` with the window's.
  - If they're equal, apply `inWindow`, recompute `carried` and the turn index,
    and patch.
  - If they differ, re-window from scratch and send a `snapshot`. This covers a
    revert seen live and a revert lost to `Lagged`. A revert that happened
    while the client was disconnected is caught at open by the epoch check.
- **No flag.** The code path and output are today's, byte for byte.

**Phase 2**, only if #225's server-time numbers call for it: push `inWindow`
into SQL so a streaming tick stops loading the whole history. Wire bytes are
the same either way.

### 8. Client runtime

`EnvironmentThreadState` (`threads.ts`):

- **`window`** is private and scope-local. It's the server-held thread, which
  patches apply to by index.
- **`older`** is session-only and never persisted:
  `{ rows, checkpointsByTurnId, cursor, olderRows, generation, inFlight: Deferred | null, status: idle | loading | error }`.
- **Published `data`** is `window`, with these changes. Each history array is
  keyed by id:
  - **Precedence:** window, then carried, then older. A copy from a
    lower-precedence source is dropped when a higher one holds the id. The
    window's copy is the server's current version.
  - **Order:** older rows in page order, oldest page first, then carried rows
    the window doesn't hold, then the window array in **its server order**.

    Every row whose order the server defines by something other than
    `createdAt` is a live message: queued messages sort by admission sequence
    (`repositories.rs:3391`). Live messages are always in the window, and
    neither pages nor `carried` hold messages, so the queue's admission order
    reaches `selectQueuedMessages` unchanged. The queue head stays the head.
    Activities, reasoning and plans already carry their own order keys, and
    their readers sort or scan from the newest.
  - **Checkpoints:** `window.checkpoints`, each replaced by
    `older.checkpointsByTurnId[turnId]` when present.
  - **`history`:** `{ ...window.history, hasOlder, loadedFrom }`, where
    `loadedFrom` is the `K` of the oldest page row, or the window floor's `K`
    before any page loads, or `ALL` once nothing is older.

  So every state reader (approvals, user input, queue, MCP status, context
  window, plans) reads one thread with no change. `shareUnchanged` keeps
  unchanged entries by identity.
- **Persistence.** Only `window` is persisted.
- **Resubscribe input.** `{ threadId, patches: true, history: { floor? }, resume? }`.
- **`snapshot`.** Set `window`. If `history.floor` changed, or `history` is
  absent (an older server sent a full thread), bump `generation` and reset
  `older`. Otherwise keep `older`.
- **`unchanged`.** Keep both.
- **`loadOlder(): Effect<void, PageError>`.** Single-flight.
  - If `inFlight` is set, it awaits that same `Deferred` and doesn't send a
    second request.
  - Otherwise it captures `(generation, cursor)`, creates `inFlight` and calls
    the RPC.
  - The result is applied only if `generation` and `cursor` still match;
    anything else is stale or a duplicate and is dropped. A `Stale` error
    bumps `generation` and resets `older`; the next re-read or resubscribe
    brings the new window.
  - The `inFlight` deferred is completed and cleared in an `ensuring`, so
    success, failure and interruption all release `loading`.
  - Interrupting a waiter doesn't cancel the request that another caller
    started.
- **`loadAllOlder()`.** It loops on `loadOlder()`, which waits for any request
  already in flight. It stops when the cursor is null, stops on the first
  failure (`status: error`), and returns on interruption. Each iteration
  either moves the cursor or fails, so the loop can't spin.

### 9. Web

- **Carried rows stay out of the timeline.**
  `deriveTimelineEntries(messages, plans, workEntries, loadedFrom)`, at
  `ChatView.tsx:2689`, drops an entry below `loadedFrom` only when the window
  doesn't hold it. That leaves out exactly the carried state rows until a page
  reaches their place.

  Window rows are always shown, including live or recently written rows whose
  `createdAt` sorts below the floor. Such a row, a streaming reply or a
  skewed-clock message, appears at the top of the loaded region, in
  `createdAt` order, just under "Load earlier messages". Find in thread, the
  folds and the minimap read these entries, so they agree.
- **`MessagesTimeline`.**
  - When `hasOlder`, a first row `history-start` shows "Load earlier messages
    (N more)" as a button. While loading it reads "Loading earlier messages…".
    On error it reads "Couldn't load earlier messages." with **Retry**.
  - LegendList `onStartReached`, with a threshold of about one viewport, calls
    `loadOlder`. It doesn't fire while `nativeScrollPending` (#207).
  - `maintainVisibleContentPosition.data` keeps the first visible row in place.
- **Partial oldest turn.** When `hasOlder` and the oldest loaded entry isn't a
  user message, that turn's fold is labelled "Worked", with no duration,
  unless it's `latestTurn`.
- **"Has messages" checks.**
  `threadHasMessages(thread) = messages.length > 0 || history?.hasOlder === true`
  replaces the four checks listed in Current behavior.
- **Find in thread.** It searches loaded history. While `hasOlder`, the bar
  says "Searched loaded messages" and offers **Search all**, which runs
  `loadAllOlder` and then rescans. If that fails it says "Couldn't load all
  earlier messages." with **Retry**. Closing the bar interrupts it. Pages
  carry no query.
- **Changed files on older turns.** A turn below the window whose page hasn't
  loaded has a skeleton checkpoint. The changed-files section shows #227's
  "N files changed" row, which opens the turn diff.

### 10. Budget

These are provisional, T3's numbers. They're confirmed from #225's p50/p99
big-thread sizes before code.

| Constant | Value | Covers |
| --- | --- | --- |
| `HISTORY_OPEN_BYTES` | 1 MiB | the **whole** first thread value: shell + carried + turn index + history rows, serialized JSON before deflate |
| `HISTORY_WINDOW_ROWS` | 500 | history rows |
| `HISTORY_WINDOW_TURNS` | 10 | user messages |
| `HISTORY_PAGE_ROWS` | 75 | rows |
| `HISTORY_PAGE_BYTES` | 512 KiB | always ≥ 1 row |
| `HISTORY_FLOOR_HONOUR_BYTES` | 4 MiB | reconnect with a client floor |

**What can still push the first payload over budget**, each bounded by
something other than history length:

- the newest row, when it's larger than the budget;
- live rows: streaming rows, plus in-flight and unresolved deliveries;
- carried state rows: open requests, one status row per key, the newest plan,
  and plans of running implementations;
- the turn index, at about 200 bytes per turn. 1,000 turns is about 200 KiB.

#225's byte-budget test gets a windowed thread-open entry on its large
fixture, and the PR lowers that budget.

### 11. Compatibility matrix

| Client | Server | Result |
| --- | --- | --- |
| old | old | today |
| old (no `history`) | new | full thread, byte-identical to today |
| new | old | server ignores `history`; full thread; no `history` field; the page RPC is never called |
| new | new | window, carried state rows and pages |

- **Downgraded client.** An old client decodes a cached window as a thread,
  because `Struct` ignores the extra key. Its first snapshot is full and
  replaces it.
- **Downgraded server.** A cached window, sent with its floor and revision,
  mismatches. The full snapshot replaces it.
- **No client migration.** `history` is optional, so the client cache needs no
  migration.

### 12. Persistence

- **Server migration**, guarded like migration 044 for restored databases
  without projection tables:
  - `written_sequence INTEGER NOT NULL DEFAULT 0` on
    `projection_thread_messages`, `projection_thread_activities`,
    `projection_thread_reasoning` and `projection_thread_proposed_plans`;
  - `history_epoch INTEGER NOT NULL DEFAULT 0` on `projection_threads`.

  Page queries use the existing `(thread_id, created_at…)` indexes
  (`migrations.rs:1038`, `:1134`, `:1927`, `:2609`). Live rows are found
  through the existing streaming index (`:2612`) and the `delivery_state`
  filter.
- **Client.** The cache holds the window. Older pages are never written.

### 13. Profiler, crash and trace coverage

- **The new RPC.** `getThreadHistoryPage` is registered with
  `registry.register_unary`, the `rpc/session.rs` wrapper, which times it. It's
  a local database read, so it isn't added to `is_long_running`.
- **Auth.** It's added to the read scope next to `orchestration.subscribeThread`.
- **Logs.** A rejected or stale cursor logs `tracing::warn!` with the method,
  the thread id and the reason only. Cursors and row content never reach
  profiler records or logs.
- **No new process, service, shutdown step or removal path.**

### 14. Living docs (same PR)

- `docs/architecture/rpc-and-orchestration.md`, the snapshot section at about
  `:2672-2700`: the window rule, `written_sequence`, `history_epoch`, carried
  state rows, the turn index and the page RPC.
- `docs/architecture/connection-runtime.md` (`:40-48`): a resumed client holds
  a window and sends its floor.
- `docs/user/workspace-ui.md`, "Reading the timeline" (`:541`) and "Finding
  text in a chat" (`:594`).
- `docs/reference/encyclopedia.md`: "history window".
- `docs/testing/` runbooks: reviewed. The manual 3G check goes in #225's
  slow-link scenario.

## Tests that prove the acceptance criteria

### Rust, `orchestration_rpc.rs` tests

**Window:**

- `thread_window_over_budget_opens_under_the_byte_row_and_turn_budgets`:
  - the whole thread value is at most `HISTORY_OPEN_BYTES`;
  - at most 500 rows and 10 turns;
  - `hasOlder` is true, `olderRows` is exact, and the window starts at a user
    message.
- `thread_window_opens_a_single_900_row_turn_with_its_newest_rows_and_older_count`
- `thread_window_takes_an_oversized_newest_row_alone`
- `an_empty_thread_opens_with_the_all_floor_and_no_older_history`
- `a_thread_under_budget_opens_whole_with_the_all_floor`

**Live rows:**

- `a_cold_open_includes_a_streaming_message_and_reasoning_row_that_predate_the_floor`
- `a_streaming_row_below_the_floor_stays_in_the_window_through_deltas_and_settlement`
- `live_rows_include_every_in_flight_and_unresolved_delivery`
- `every_history_write_path_sets_written_sequence`

**Carried state rows:**

- `carried_rows_hold_every_open_request_below_the_floor`, including a
  completed turn's request and a turnless request.
- `a_recovered_turnless_opencode_ask_below_the_floor_is_carried`: restart the
  engine, recover, and subscribe.
- `carried_status_is_the_newest_valid_row_when_a_newer_row_is_malformed`:
  context window, and MCP status per instance.
- `carried_status_selection_matches_the_shared_fixture`, against
  `carried-status.json`.
- `carried_rows_hold_the_newest_plan_and_the_source_plan_of_a_running_implementation`
- `a_carried_row_leaves_the_carried_set_once_the_window_holds_the_selected_row`

**Pages:**

- `history_pages_return_every_older_row_exactly_once_in_order`: the union of
  window and pages equals the full thread, and the last page ends with
  `cursor: null`.
- `history_pages_never_return_a_live_row`
- `history_page_respects_its_row_and_byte_caps`
- `history_page_returns_full_checkpoints_for_its_turns`
- `history_page_rejects_a_malformed_cursor`
- `history_page_rejects_a_cursor_from_before_a_revert`

**Live stream:**

- `windowed_stream_patches_a_new_message_and_never_removes_rows_outside_the_window`
- `a_backdated_message_after_a_withdrawn_queued_message_joins_the_window`:
  withdraw the top-rowid queued message, then insert a backdated one. This is
  the case that broke rowids.
- `a_settled_row_below_the_floor_that_changes_moves_into_the_window`
- `written_sequence_survives_a_projection_rebuild`
- `windowed_resubscribe_at_the_current_revision_sends_unchanged`
- `windowed_resubscribe_with_its_floor_keeps_the_floor_after_a_change`
- `a_live_revert_rewindows_the_subscription`
- `a_revert_lost_to_lag_rewindows_on_the_next_read`: overflow the broadcast
  receiver.
- `a_resubscribe_after_a_missed_revert_gets_a_fresh_window`: subscribe, cancel,
  revert, then resubscribe with the old floor.
- `clients_without_the_history_flag_get_the_full_thread_byte_identical`
- `thread_stream_window_fixture_matches_the_wire`

**Still pass:**

- `resubscribing_at_the_current_revision_sends_unchanged`
- `clients_without_resume_keep_full_snapshots`
- `thread_stream_sends_patches_to_clients_that_apply_them`
- `thread_stream_resume_fixture_matches_the_wire`
- `thread_stream_lifecycle_fixture_matches_the_wire`
- `a_reconnect_storm_of_resumes_stays_exact`

**Elsewhere:**

- Migration test in `persistence/migrations.rs`:
  `history_window_columns_default_existing_rows_to_zero`.
- `auth/scope.rs`: the read-scope table test covers
  `orchestration.getThreadHistoryPage`.

### Contracts (`vp run check:contracts`)

- New `fixtures/thread-stream/window.json`: subscribe with `history`, then a
  windowed snapshot with live and carried rows, a patch, two pages, a
  stale-page failure, and the merged result.
- New `fixtures/thread-stream/carried-status.json`: valid and malformed status
  payloads, and the row each reader selects.
- New `rpc-wire` contract shapes and a `manifest.json` entry for
  `orchestration.getThreadHistoryPage`, with both typed failures.
- `rpcRustParity.test.ts` and `threadStreamParity.test.ts` pass. The latter
  gets "rebuilds the windowed snapshot, carried rows and pages from
  window.json".

### Client runtime, `threads-sync.test.ts`, `describe("history window")`

**Loading pages:**

- "opens with the server's window and reports older history"
- "publishes carried rows to state readers"
- "loads two older pages in order before the window"
- "applies a patch that arrives between two pages to the window only"
- "sends exactly N-1 page requests to reach the start of an N-page thread"

**Merge:**

- "a window copy replaces the copy a page loaded"
- "a withdrawn queued message disappears and no page resurrects it"
- "keeps the admission order of queued messages when one is backdated below
  the floor"

**Stale and duplicate answers:**

- "drops a page that answers a superseded cursor or generation"
- "drops a page in flight when a snapshot moves the floor"
- "drops loaded pages when a page answers stale"

**Reconnect and persistence:**

- "keeps loaded pages when a resubscribe is answered unchanged"
- "keeps loaded pages when a snapshot keeps the floor and drops them when it
  moves"
- "resubscribes with the floor it holds"
- "persists the window, not the loaded pages"
- "treats a snapshot without history as the whole thread"

**Load-all:**

- "loadAllOlder waits for a page already in flight instead of looping"
- "loadAllOlder stops on the first failure"
- "interrupting loadAllOlder releases the loading state"

**Still pass:** "resumes from the revision it applied and keeps its thread
when unchanged", `reconnectRetention.test.ts` and `threads-atoms.test.ts`.

### Web (happy-dom, from `apps/web`)

- `MessagesTimeline.test.tsx`:
  - "keeps the first visible row in place when an older page loads"
  - "loads earlier messages from the top row without scrolling"
  - "offers a retry when an older page fails"
- `MessagesTimeline.logic.test.ts`: "labels the partial oldest turn Worked
  without a duration".
- `session-logic.test.ts`:
  - "deriveTimelineEntries leaves out carried rows below the loaded history"
  - "deriveTimelineEntries keeps a window row that sorts below the floor"
- `ChatView.logic.test.ts`: "a windowed thread with older history counts as
  having messages".
- `lib/contextWindow.test.ts` and `McpStatusPopover` tests: run the readers on
  `carried-status.json`. The existing "keeps the latest valid snapshot when a
  newer usage activity is malformed" still passes.
- `ChatComposer` tests: "shows the carried MCP status and context-window usage
  of a windowed thread".
- `threadFind/useThreadFind.test.tsx`:
  - "says it searched loaded messages while older history remains"
  - "Search all loads every older page and rescans"
  - "Search all reports a failed page and offers retry"
- `connection/storage.test.ts`: "decodes a cached thread with and without
  history".

### Desktop e2e and manual

- Run `vp run test:ui:desktop`, including `document-navigation.e2e.ts`,
  `chat-reasoning-rows.e2e.ts` and `chat-activity-panel.e2e.ts`. Those are
  short threads, so the floor is `ALL`. There's no new spec: the packaged
  fixtures type history through the composer.
- Manual: a remote environment at 3G. A long thread paints its last turns,
  scrolling up loads older ones without a jump, and a short thread looks as it
  did.

## Options considered

1. **Recommended: a fixed-floor window with the recent/written/live rule,
   carried state rows and a turn index, plus a page RPC.** It reuses
   `patches`, `resume`, `HeldThread` and LegendList's content-position upkeep.
   It adds two migration columns, one optional input field, one optional
   thread field and one unary RPC.
2. **Lower the floor to include pinned rows** (revision 1). Rejected. The
   current MCP status or a completed turn's open request can be days old, so
   the window would be unbounded.
3. **Carry mutable rows such as messages, and reconcile their copies in pages**
   (revision 2). Rejected. Deletes and updates of carried rows needed their own
   reconciliation, and the merge could reverse queue order. Making those rows
   live puts them in the window, whose copy and order are authoritative.
4. **Sticky per-subscription id sets of carried rows.** Rejected. They're lost
   on reconnect, and they're server memory per subscription.
5. **Rowid high-water marks** (revision 1). Rejected. Rowids are reused after a
   delete and renumbered by a rebuild.
6. **Epoch alone, bumped on every delete.** Rejected. Withdrawing a queued
   message would re-window and drop the user's loaded pages.
7. **A sliding window.** Rejected. It sends removals and invalidates index
   patches and pages.
8. **A window by `turn_id`.** Rejected. User messages are written with
   `turnId: null` (`engine.rs:4897`), and boot activities have none either
   (`engine.rs:3059`).
9. **Keep plans and checkpoints whole.** Rejected. 200 plans of 20 KiB, or
   thousands of checkpoint file lists, would exceed the budget before any row.
10. **Older history from `replayEvents`, or a window only on the client.**
    Rejected. Events are larger and need reducing, and a client-only window
    saves no bytes.
11. **Find searches the server.** Deferred. It needs a text index and an RPC.
12. **Cache older pages.** Rejected. The cache would grow without bound, and
    reverts would invalidate it.

## Open questions for approval

1. The budget numbers, once #225's baseline exists.
2. Whether to do phase 2 (the window rule pushed into SQL) in the same PR.
   Decide from #225's server-time numbers.

## Residual risk

- **A page landing during a key scroll.** A page that arrives while a key
  scroll's native scroll is pending (#207) can shift the view once.
- **Rows can show out of place.** A live or recently written window row that
  sorts below the floor shows at the top of the loaded region until pages
  reach its place.
- **A new state reader can drift.** A new web reader that selects "the newest
  valid activity of kind X" needs a matching server selector and a fixture
  case. The parity fixture covers the known readers only.

## Review resolutions

### Round 1 (`9ec004e40`)

1. **Rowid reuse and rebuilds.** Accepted. Rowid marks are replaced by a
   sequence column written from the event sequence; revision 3 renames it
   `written_sequence` and sets it on every write (§2). Tests: the backdated
   message after a withdrawal, and survival across a rebuild.
2. **Pin every outstanding request.** Accepted. The "requests expire with the
   turn" premise was wrong (`engine.rs:5791-5793`). Every open request is
   carried from server state, whatever its turn (§4). Tests: the two
   carried-request tests, including OpenCode recovery.
3. **A missed revert.** Accepted. `history_epoch` travels in the floor and
   every cursor. It's checked at open, on every re-read and by the page RPC,
   and fences pages in flight together with `generation` (§2, §6-§8). Tests:
   the live, lag and disconnect revert tests and the stale-page tests.
4. **MCP status and context-window usage.** Accepted, and completed in round
   2, item 4.
5. **Empty thread and an oversized first row.** Accepted. The `ALL` floor, and
   the newest row is always taken (§3).
6. **"Search all" can loop.** Accepted. `loadOlder` awaits the request in
   flight, `loadAllOlder` stops on failure, and `ensuring` releases `loading`
   (§8).
7. **Plans and checkpoints unbounded.** Accepted. Plans are windowed,
   checkpoints are a turn index, and the budget covers the whole first payload
   (§1, §5, §10).

### Round 2 (`0ab5e0dc1`)

1. **Withdrawn or changed carried rows resurrected from pages.** Accepted.
   Messages are no longer carried: queued, in-flight and failed deliveries are
   `live`, so they sit in the window. Pages never return live rows, any write
   moves a row into the window, and the window's copy wins (§2, §6, §8).
   Tests: `history_pages_never_return_a_live_row`, "a withdrawn queued message
   disappears and no page resurrects it", and "a window copy replaces the copy
   a page loaded".
2. **The merge could reverse queue order.** Accepted. Every row whose order
   isn't `createdAt` is a live message, so it's in the window. The merge keeps
   the window array in server order and never adds messages from carried rows
   or pages ahead of it (§8). Test: "keeps the admission order of queued
   messages when one is backdated below the floor".
3. **Streaming rows that predate the window.** Accepted. Streaming messages
   and reasoning are `live`. Deltas and settlement set `written_sequence`, so
   they stay in the window, and the timeline always shows window rows (§2,
   §9). Tests: the cold-open and through-settlement tests.
4. **Carry the effective status.** Accepted. The server carries the row each
   reader would select: the newest *valid* one. A shared
   `carried-status.json` fixture runs against both the Rust selector and the
   web readers (§4). Tests: the malformed-newest test, the fixture parity
   tests, and the existing `contextWindow.test.ts` case.
