# Thread History Window

Status: Draft for approval, 2026-11-01. Issue #226. Depends on #225 (the 3G
baseline and the byte-budget test). Composes with #227 (cached-thread resume,
checkpoint file cap) and #223 (shell side). No code until this is approved.

## Problem

Opening a thread sends all of it: every message, activity payload, reasoning
row, plan and checkpoint. That happens on first open, on a reload with no
cache, and on every resume the server can't answer with `unchanged`. A long
agent thread is megabytes of JSON. On a remote or slow link the chat stays
blank until all of it arrives, though the timeline first shows only the last
few turns.

## Current behavior (verified at `9c8799b80`)

### Server

- `orchestration.subscribeThread` is registered with `registry.register_stream`
  (`apps/server/src/production/orchestration_rpc.rs:262-265`). Its read scope is
  listed in `apps/server/src/auth/scope.rs:57`.
- `SubscribeThreadInput` (`orchestration_rpc.rs:2293-2303`) has `threadId`,
  `patches` and `resume`. Serde ignores unknown fields, so an older server
  ignores new input fields.
- `thread_stream_with_keys` (`:1419-1520`) subscribes to engine events, then
  loads `thread_snapshot` (`:1591-1596`). That calls `load_thread_snapshot`
  (`apps/server/src/orchestration/engine.rs:8917-8991`), which reads all of the
  thread's messages, reasoning, activities, plans, turns and checkpoints, and
  then `in_canonical_order` (`engine.rs:8995-9036`).
- The wire array order is not chronological for every array. Messages sort
  queued-last, then by `message_id` (`engine.rs:8999-9012`). Plans sort by
  `plan_id`, and checkpoints by `checkpoint_turn_count`. Activities keep
  `ACTIVITY_LIST_ORDER` (`sequence, created_at, activity_id`,
  `apps/server/src/persistence/repositories.rs:3398`). Reasoning sorts by
  `created_at, reasoning_id`. The client sorts for display.
- `thread_snapshot_value` (`orchestration_rpc.rs:1599-1643`) runs
  `thread_detail_rows` (`:1772-1807`, every row of the thread) and
  `thread_detail` (`:1645-1760`). The detail serializes all messages
  (`:1649-1700`), activities with full `payload` (`:1701-1720`), plans
  (`:1721-1739`) and checkpoints with full `files` (`:1740-1758`). Reasoning is
  added at `:1618-1641`.
- The first item is `unchanged` when `resume.revision` equals the revision of
  the loaded snapshot and its sequence is not behind (`:1452-1467`). Otherwise
  it's a `snapshot` (`send_snapshot`, `:1523-1538`).
- After that, each thread event or `Lagged` schedules one re-read 100 ms later
  (`THREAD_UPDATE_COALESCE`, `:1199`, loop `:1474-1516`). Each re-read loads and
  serializes the whole thread again. It's diffed against `HeldThread`
  (`:1205-1293`): one keyed 64-bit fingerprint per field and per array entry.
  The result is sent as a `patch` (`thread_patch`, `:1352-1400`). A changed
  array sends `length` plus the entries whose fingerprint differs at the same
  index. A shorter array means the client truncates.
- The revision (`HeldThread::revision`, `:1266-1292`) is a 128-bit digest of
  the held fingerprints, under per-process keys (`ThreadRevisionKeys`,
  `:1214-1234`). A server restart mismatches every old revision.
- `orchestration.replayEvents` already has a byte-budgeted page mode
  (`REPLAY_PAGE_TARGET_BYTES` = 1 MiB, `:52`, `ReplayBudget`, `:2170-2175`).
  It's a precedent for "always keep the first item, stop before the budget".

### Contract

- `OrchestrationThread` (`packages/contracts/src/orchestration.ts:559-593`)
  holds `messages`, `reasoning`, `proposedPlans`, `activities` and `checkpoints`
  as plain arrays. Nothing says "more history on the server".
- `OrchestrationSubscribeThreadInput` (`:734-750`) has the optional `patches`
  and `resume`. Both are documented as "older servers ignore it".
- `OrchestrationThreadPatch` (`:1690-1701`), and `OrchestrationThreadStreamItem`
  (`:1710-1735`), which is `snapshot | event | patch | unchanged`.
- `OrchestrationRpcSchemas` (`:1850-1879`), the RPC definitions in
  `packages/contracts/src/rpc.ts:1991-2040`, and the local API surface in
  `packages/contracts/src/ipc.ts:1651-1662`.
- The wire fixtures are `packages/contracts/fixtures/thread-stream/lifecycle.json`,
  `thread-stream/resume.json` and `rpc-wire/` (with its `manifest.json`).

### Client runtime

- `makeEnvironmentThreadState` (`packages/client-runtime/src/state/threads.ts`)
  starts from `cache.loadThread`. It keeps `resumeFrom` in memory only (`:79`).
  It persists the whole thread through a sliding queue debounced at 500 ms
  (`:83-104`).
- `applyItem` (`:163-226`) handles four kinds of item. A `snapshot` replaces the
  thread (`:166-171`). A `patch` is applied by index through `applyThreadPatch`
  (`state/threadPatch.ts`). `unchanged` keeps the thread and goes live
  (`:184-194`). An event clears the resume revision and reduces.
- Each resubscribe builds its input lazily: `{ threadId, patches: true }`, plus
  `resume` when the client holds a revision (`:233-241`). So a resubscribe can
  carry new state.
- `createEnvironmentThreadDetailAtoms` (`state/threadDetail.ts:110-190`) keeps
  unchanged entries by identity across snapshots (`shareUnchanged`, `:184`).
- The cached record is `StoredThreadSnapshot { schemaVersion: 1, environmentId,
  threadId, thread: OrchestrationThread }` (`apps/web/src/connection/storage.ts:62-68`).

### Web

- `MessagesTimeline` renders `LegendList` (`apps/web/src/components/chat/MessagesTimeline.tsx:701-725`)
  with `initialScrollAtEnd` and `maintainVisibleContentPosition`.
  `resolveTimelineMaintainVisibleContentPosition`
  (`MessagesTimeline.logic.ts:50-62`) sets `{ data: true, size: true }`, except
  while a key scroll's native scroll is pending (#207), when it sets nothing.
  Rows prepended to `data` therefore already keep the first visible row in
  place, outside that pending window.
- Several features read the whole loaded thread:
  - **Find in thread**: `threadFind/useThreadFind.ts`, with its entries from
    `deriveFindEntries`. Its load state comes from `useThreadFindLoadState`
    (`apps/web/src/state/threads.ts:38-79`).
  - **Turn folds**: `deriveTurnFolds` (`MessagesTimeline.logic.ts:518-690`).
    The "Worked for" duration uses `latestTurn` timings for the latest turn.
    For any other turn it uses the turn's user message (`startBoundary`), or
    the first entry when that message is missing.
  - **Pending approvals and user input** are derived from activities, by
    matching `approval.requested` with `approval.resolved` or `approval.expired`
    (`apps/web/src/session-logic.ts:347-403`, `:457`).
  - **Queue and delivery cards**: `selectQueuedMessages`, `findBlockingDelivery`,
    `findActiveDeliveryMessage` (`ChatView.tsx:677-709`, `:2333-2338`).
  - **"Has this thread any message"** checks: `envLocked` (`ChatView.tsx:2816-2819`),
    `canOverrideServerThreadEnvMode` (`:4283-4289`), `isFirstMessage`, which
    decides whether to create a worktree on send (`:5579-5588`), and
    `ChatView.logic.ts:422`.
  - **Turn diff summaries, revert and the Diff panel** read `thread.checkpoints`
    (`apps/web/src/hooks/useTurnDiffSummaries.ts:5-19`). Revert is
    `onRevertToTurnCount` (`ChatView.tsx:4999`).
  - **The Plan panel** reads `proposedPlans` (`ChatView.tsx:2288-2291`).
  - **The minimap and scroll-to-row** use indices into the rows that are
    loaded (`MessagesTimeline.tsx:726-740`).
- BiBCode has no conversation export and no unread-message marker inside a
  thread. Unread is a shell-level thread flag. Neither is affected.
- MCP thread reads and the HTTP snapshot use the engine and
  `all_thread_detail_rows` (`orchestration_rpc.rs:1810`), not this stream.
  They're unaffected.

### Not measured

`v015b/225-load-budget` has no commits yet. So BiBCode has no numbers for
thread-open bytes on a long thread. The budget numbers below are provisional.
They're settled against #225 before implementation starts (see Budget).

## Goals and non-goals

Goals:

- The first `snapshot` for an opted-in client holds a bounded window of
  recent history.
- Older history loads in pages when the user scrolls up, without a jump.
- Live streaming, patches, resume and reconnect keep their guarantees.
- Older clients and older servers keep working in every pairing.

Non-goals: the shell stream (#223), checkpoint file lists (#227), lazy images
(#224), archived threads, and server-side full-text search.

## Design

### 1. What is windowed

Only **messages, activities and reasoning** are windowed.

`proposedPlans` and `checkpoints` stay whole:

- Plans are few: one per plan-mode turn. The Plan panel and "implement plan"
  need the latest one, however old.
- Checkpoints drive the turn diff summaries, the Diff panel turn list and
  revert. After #227 each checkpoint's `files` list is capped at 200.

If #225 shows either of them is large, it gets its own follow-up.

### 2. Order and the window floor

All windowed rows share one total order, the **history key**:

`K = (createdAt, kindRank, id)`, with `kindRank` message=0, activity=1,
reasoning=2. It compares as strings, the same way in SQL and in Rust.

`createdAt` is the order the timeline shows, so a window cut by `K` is one
contiguous slice of the timeline, with no holes between row kinds.

The window is everything at or above a **floor** `F` (a history key), plus
every row written after the window opened:

```
inWindow(row) = K(row) >= F  ||  rowid(row) > hwm[table(row)]
```

`hwm` is the SQLite `rowid` high-water mark of each of the three tables when
the window was chosen. These are the implicit rowids of the existing
`TEXT PRIMARY KEY` tables, so the change needs no schema change.

The rowid term matters. User messages carry the client's `createdAt`
(commands send it), and a client clock can be behind the server's. A message
sent from such a client sorts below `F` but has a new rowid, so it still
joins the window. A rule based only on `createdAt` would hide the user's own
message.

The floor and the high-water marks are **fixed for the life of a
subscription**. Rows only ever enter the window. So:

- Patches stay index-based and cheap.
- Nothing outside the window is ever sent as a removal.
- Rows actually deleted, by a revert or a thread delete, still are removed.

### 3. Choosing the floor (server, at open)

The server walks the thread's windowed rows newest first, by `K`. For each row
it counts its serialized JSON bytes, using a counting `io::Write` with
`serde_json::to_writer`, so nothing is allocated. It counts the row too. At
every **user message** it records a *turn cut*: the `K` of that message and a
turn count.

The walk stops before the next row would exceed any budget:
`HISTORY_WINDOW_BYTES`, `HISTORY_WINDOW_ROWS`, or more than
`HISTORY_WINDOW_TURNS` user messages.

- **Normal case.** `F` is the oldest turn cut reached. The window starts at a
  user message, so every turn in it is whole and its "Worked for" duration is
  right.
- **One turn over the budget** (a 900-row tool run). No turn cut is reached
  before the budget, so `F` is the `K` of the oldest row that fit. The window
  holds that turn's newest rows. `latestTurn.startedAt` and `completedAt` keep
  its duration right.
- **Pinned rows lower the floor.** `F = min(F, K(p))` for every pinned row `p`:
  - a streaming message or reasoning row;
  - a message whose delivery is `queued`, `pending` or `sending`;
  - the thread's newest message whose delivery is `uncertain` or `failed`.
    This is the one `unresolved_delivery_state` reports, which
    `findBlockingDelivery` shows.
  - while the thread's `pending_approval_count` plus
    `pending_user_input_count` is above zero, the oldest `*.requested` activity
    of the latest turn. Open requests expire when the session leaves `running`
    (`session-logic.ts:383`), so they can only belong to the latest turn.

  Lowering `F` keeps the window contiguous and monotonic. Pinning a row
  without lowering `F` would drop it again when it settles. The cost: a
  window can exceed the budget by the active turn's rows since its oldest
  pending item.
- **The whole thread fits** (`F` reaches the oldest row). Then `hasOlder` is
  false. It's still a window, with its metadata.

`olderRows` is the number of windowed rows below `F` when the window opens.

### 4. Wire contract (`packages/contracts`, schema only)

Subscribe input, optional:

```ts
history: Schema.optional(Schema.Struct({
  /** The floor the client holds, from `thread.history.floor`; absent on first open. */
  floor: Schema.optional(TrimmedNonEmptyString),
})),
```

Sending `history` opts in. An older server ignores it (serde drops unknown
fields) and sends the whole thread, which the client already handles.

A new field on the thread, optional:

```ts
/** Present only on a windowed thread from the thread stream. */
history: Schema.optional(Schema.Struct({
  floor: TrimmedNonEmptyString,      // opaque cursor: the window's floor and high-water marks
  hasOlder: Schema.Boolean,
  olderRows: NonNegativeInt,         // rows below the floor when the window opened
})),
```

Because `history` is a field of `thread`:

- `HeldThread` fingerprints it.
- The revision covers it.
- `thread_patch` sends it when it changes, which happens only on a re-window.

A full thread has no `history` key, so its revision can never equal a
window's. A client that switches mode can't get a false `unchanged`.

New unary RPC `orchestration.getThreadHistoryPage`:

```ts
input:  { threadId: ThreadId, cursor: TrimmedNonEmptyString }
output: {
  messages: Array(OrchestrationMessage),
  activities: Array(OrchestrationThreadActivity),
  reasoning: Array(OrchestrationReasoning),
  cursor: Schema.NullOr(TrimmedNonEmptyString), // null: nothing older
  olderRows: NonNegativeInt,                    // rows still older than `cursor`
}
// typed failure: OrchestrationGetThreadHistoryPageError { message }
```

The RPC returns rows with `K < cursor.K` and `rowid <= cursor.hwm`, newest
first. It stops at `HISTORY_PAGE_ROWS` or `HISTORY_PAGE_BYTES`, always keeping
the first row. Each array comes back in the same order as the stream's
arrays. The next cursor is the `K` of the oldest row returned, with the same
`hwm`.

A page is disjoint from the window by construction. Window rows have
`K >= F` or `rowid > hwm`, and page rows have `K < F` and `rowid <= hwm`.

The cursor is
`base64url(JSON { v: 1, at, rank, id, hwm: [m, a, r] })`. It's opaque to the
client: the client only stores it and echoes it back. It holds ids and
timestamps, never content.

The server decodes it and checks it:

- A malformed cursor, or an unknown `v`, on the page RPC returns the typed
  error.
- The same on subscribe means the server ignores it and picks a fresh window.

It's a `rowid`, not an id set, so it survives a server restart. A projection
rebuild renumbers rowids. That can only move a skewed late row into a page
instead of the window, where the client still gets it once. It's an accepted
edge (see Residual risk).

Rows in the page use the existing serializers. `thread_detail`'s per-row
`json!` blocks move into `message_value`, `activity_value` and
`reasoning_value`, so the stream and the page can't drift apart.

### 5. Server stream behavior

`thread_stream_with_keys` gets a per-subscription
`Option<HistoryWindow { floor, hwm, older_rows }>`. It's `None` unless the
input has `history`.

- **Open.**
  1. Load as today, then choose the window (§3).
  2. If the input carries a valid `history.floor`, use that floor instead.
     The exception: if the rows at or above it serialize over
     `HISTORY_FLOOR_HONOUR_BYTES` (4 × the window budget), pick a fresh window.
     Honouring the client's floor keeps the pages it loaded contiguous across
     reconnects and server restarts.
  3. Build the thread value with only `inWindow` rows, plus the `history`
     field.
- **Resume.** Unchanged logic. The revision is computed over the window value,
  so a client that resubscribes with its floor and current revision gets
  `unchanged`. This settles the issue's open question: one revision per window
  as sent.
- **Updates.** Each 100 ms re-read applies the same fixed `inWindow` filter
  before `thread_detail`. So new rows arrive as appended or changed entries.
  A message updated in place is a single changed entry.
- **Revert.** A `thread.reverted` event drops the window, re-chooses it from
  scratch, and sends a `snapshot`. The client sees a new floor and drops its
  older pages, which may hold reverted rows.
- **No flag.** `HistoryWindow` is `None` and every code path is today's. The
  first item is byte-identical to today's.

Phase 2, only if #225's server-time numbers call for it: push the fixed
`inWindow` predicate into SQL (`list_*_by_thread` gets an optional floor) so a
streaming tick stops re-reading the whole history. Wire bytes are the same
either way. Phase 1 already serializes only the window, which is most of the
per-tick CPU.

### 6. Client runtime

`EnvironmentThreadState` (`threads.ts`) changes as follows:

- **The window stays private.** It's a scope-local `window`, like
  `resumeFrom`, and it's what patches apply to, by index, unchanged.
- **Older pages are session-only.**
  `older: { rows: {messages, activities, reasoning}, cursor, olderRows, status: idle|loading|error, generation }`.
- **Published `data` is the merge.** It's
  `merge(older, window) = { ...window, messages: [...older.messages, ...window.messages], ... }`.
  So every web consumer keeps reading one `OrchestrationThread`, and
  `shareUnchanged` keeps unchanged entries by identity. The merge copies
  references once per applied item, which is cheap next to today's patch
  decode.
- **`hasOlder` comes from the cursor.** `history.hasOlder` is derived from
  `older.cursor ?? window.history.floor`, and is false once a page returns
  `cursor: null`.
- **Persist the window only.** The persistence queue gets `window`, not
  `data`. That answers the caching question: older pages aren't cached. It
  keeps the cache bounded, avoids stale pages after a revert, and makes a
  cached window plus #227's saved revision resume as `unchanged`.
- **Resubscribe input:**
  `{ threadId, patches: true, history: { floor? }, resume? }`, where `floor` is
  `window.history.floor` when held.
- **`snapshot`:** set the window. If the new `history.floor` differs from the
  held one, or `history` is missing (an older server sent a full thread),
  clear `older` and bump `generation`. Otherwise keep `older`.
- **`unchanged`:** keep both.
- **`loadOlder()`:** single-flight, a no-op while loading or when there's no
  cursor.
  1. Capture `(generation, cursor)` and call `getThreadHistoryPage`.
  2. On success, apply the page only if `generation` and `cursor` still match.
     Anything else is a stale or duplicate answer and is dropped.
  3. Drop page rows whose id is already held. This is defensive, since pages
     are disjoint by construction.
  4. Prepend the rows and set `cursor` and `olderRows`.
  5. On failure, `status: error`, keeping the rows already loaded.

  It's exposed to the web as a writable atom next to `stateAtom`.
- **`loadAllOlder()`:** for Find in thread. It loops `loadOlder` until the
  cursor is null or it's interrupted. Closing the find bar interrupts it.

### 7. Web

- **`MessagesTimeline`:**
  - When `hasOlder`, a first row of type `history-start` reads "Load earlier
    messages", as a button. While loading it reads "Loading earlier messages…".
    On error it reads "Couldn't load earlier messages." with **Retry**.
  - When `olderRows` is known, the button says how many: "Load earlier
    messages (240 more)".
  - LegendList `onStartReached`, with a threshold of about one viewport, calls
    `loadOlder`. It doesn't fire while `nativeScrollPending`, so a page can't
    start while LegendList holds no content position (#207).
  - The existing `maintainVisibleContentPosition.data` keeps the first visible
    row in place when rows are prepended.
  - The button is the fallback with no scroll: keyboard users, short
    viewports, and a find bar that's already open.
- **Partial oldest turn.** When `hasOlder` and the oldest loaded row isn't a
  user message, `deriveTurnFolds` labels that turn's fold "Worked", with no
  duration, unless it's `latestTurn`. Today it would undercount from the
  first loaded entry.
- **"Has messages" checks.** A helper `threadHasMessages(thread)` returns
  `thread.messages.length > 0 || thread.history?.hasOlder === true`. It
  replaces the checks at `ChatView.tsx:2818`, `:4286` and `:5579`, and
  `ChatView.logic.ts:422`. Without it, a window of 500 activities with no
  message would count as a first message, and could create a worktree on send.
- **Find in thread** searches the history that's loaded, and says so.
  `ThreadFindLoadState` gains `hasOlder`. While it's true, the bar shows
  "Searched loaded messages" and a **Search all** action that runs
  `loadAllOlder` and then rescans. Pages carry no query, so the query still
  never leaves the main thread.

  Server-side search would need a new RPC and an index for a thread's text.
  It's deferred, and recorded under Options.
- **Unchanged:**
  - Plans and checkpoints are whole, so revert, the diff summaries and the
    Plan panel are unaffected.
  - Pending approvals, user input and the queue are covered by the pinned
    rows.
  - The minimap and scroll-to-row index rows that are loaded.

### 8. Budget

These are provisional, T3's numbers. They're confirmed or replaced from
#225's p50/p99 big-thread sizes before code, and recorded in this doc's
approval.

| Constant | Value | Unit |
| --- | --- | --- |
| `HISTORY_WINDOW_BYTES` | 1 MiB | serialized JSON of windowed rows, before deflate |
| `HISTORY_WINDOW_ROWS` | 500 | messages + activities + reasoning |
| `HISTORY_WINDOW_TURNS` | 10 | user messages |
| `HISTORY_PAGE_ROWS` | 75 | rows |
| `HISTORY_PAGE_BYTES` | 512 KiB | under `MAX_RECORDED_MESSAGE_BYTES`, always ≥ 1 row |
| `HISTORY_FLOOR_HONOUR_BYTES` | 4 MiB | 4 × window bytes |

How to settle them:

- **Window bytes.** Lower the bytes until #225's "cold connect + open the big
  thread" row at 3G paints in a target the owner names. #225 reports deflated
  size too, at about 50 KB/s.
- **Window rows.** Keep the row cap only if it binds before the bytes on real
  threads.
- **Measure uncompressed.** Budgets are measured on uncompressed JSON. It's
  deterministic, and the server serializes it anyway.
- **Budget file.** #225's byte-budget test gets a windowed thread-open entry,
  and the PR lowers the thread-open budget in its checked-in budget file.

### 9. Compatibility matrix

| Client | Server | Result |
| --- | --- | --- |
| old | old | today |
| old (no `history`) | new | full thread, byte-identical to today; no `history` field |
| new | old | server ignores `history`; full thread; client sees no `history`, `hasOlder` false, never calls the page RPC |
| new | new | window plus pages |

- **Downgrade, client side.** An old client reading a cached window decodes it
  as a whole thread, because Effect `Struct` ignores the extra key. It shows a
  short history until its first snapshot, a full one, replaces it.
- **Remote server downgraded.** The client's cached window, sent with its
  floor and revision, mismatches, and the full snapshot replaces it.
- **No migration.** `StoredThreadSnapshot` keeps `schemaVersion: 1` and gets
  no migration, because `history` is an optional field.

### 10. Persistence

- **Server.** No schema change and no migration. Queries read the implicit
  `rowid`, through a `#[serde(skip)] row_id` on the three projection row
  structs. Page queries use the existing indexes:
  - messages `(thread_id, created_at, message_id)` (`migrations.rs:1927`);
  - activities `(thread_id, created_at)` (`:1038`);
  - reasoning `(thread_id, created_at)` (`:2609`).
- **Client.** The cache holds the window and its `history` field. Older pages
  are never written.

### 11. Profiler, crash and trace coverage

- **The new RPC.** `getThreadHistoryPage` is registered with
  `registry.register_unary`, the `rpc/session.rs` wrapper, which times it. It's
  a local database read, so it isn't added to `is_long_running`.
- **Auth.** It's added to the read scope next to
  `orchestration.subscribeThread` (`auth/scope.rs:57`).
- **Logs.** A rejected cursor logs `tracing::warn!` with the method and the
  thread id only. Cursors, message text, activity payloads and reasoning never
  reach profiler records or logs.
- **No new process, service, shutdown step or removal path.**

### 12. Living docs (same PR)

- `docs/architecture/rpc-and-orchestration.md`, the snapshot section at
  about `:2672-2700`: the window, the floor, `hwm`, the page RPC and the
  re-window on revert.
- `docs/architecture/connection-runtime.md` (`:40-48`): a resumed client holds
  a window and resubscribes with its floor.
- `docs/user/workspace-ui.md`, "Reading the timeline" (`:541`) and "Finding
  text in a chat" (`:594`): older history loads on scroll, and what Find
  covers.
- `docs/reference/encyclopedia.md`: "history window".
- `docs/testing/` runbooks: reviewed. The manual 3G check goes in the slow-link
  scenario that #225 adds.

## Tests that prove the acceptance criteria

### Rust (`apps/server/src/production/orchestration_rpc.rs` tests)

**New tests:**

- `thread_window_over_budget_opens_under_the_byte_row_and_turn_budgets`: the
  window is at most 1 MiB, 500 rows and 10 turns, `hasOlder` is true,
  `olderRows` is exact, and the window starts at a user message.
- `thread_window_opens_a_single_900_row_turn_with_its_newest_rows_and_older_count`.
- `thread_window_lowers_its_floor_for_pending_rows`: a queued message, an open
  approval request and a streaming message older than the budget floor are in
  the window.
- `history_pages_return_every_older_row_exactly_once_in_order`: paging a
  thread to the end gives `cursor: null`, `hasOlder: false`, and the union is
  equal to the full thread's rows.
- `history_page_respects_its_row_and_byte_caps`.
- `history_page_rejects_a_malformed_cursor`.
- `windowed_stream_patches_a_new_message_and_never_removes_rows_outside_the_window`.
- `a_late_message_with_an_old_timestamp_joins_the_window` (the rowid term).
- `windowed_resubscribe_at_the_current_revision_sends_unchanged`.
- `windowed_resubscribe_with_its_floor_keeps_the_floor_after_a_change`.
- `a_revert_rewindows_the_subscription`.
- `clients_without_the_history_flag_get_the_full_thread_byte_identical`: the
  first item serializes to the same bytes as `send_snapshot(thread_snapshot(..))`.
- `thread_stream_window_fixture_matches_the_wire`, against
  `fixtures/thread-stream/window.json`.

**Existing tests that must still pass:**

- `resubscribing_at_the_current_revision_sends_unchanged`
- `clients_without_resume_keep_full_snapshots`
- `thread_stream_sends_patches_to_clients_that_apply_them`
- `thread_stream_resume_fixture_matches_the_wire`
- `thread_stream_lifecycle_fixture_matches_the_wire`
- `a_reconnect_storm_of_resumes_stays_exact`

**Elsewhere:**

- `apps/server/src/auth/scope.rs`: the existing read-scope table test covers
  `orchestration.getThreadHistoryPage`.

### Contracts (`vp run check:contracts`)

- New `fixtures/thread-stream/window.json`: a subscribe with `history`, then
  the windowed snapshot, a patch, two page requests and responses, and the
  merged result.
- New `rpc-wire` contract shapes and a `manifest.json` entry for
  `orchestration.getThreadHistoryPage`, including its typed failure.
- `rpcRustParity.test.ts` and `threadStreamParity.test.ts` pass. The latter
  gets "rebuilds the windowed snapshot and its pages from window.json".

### Client runtime (`packages/client-runtime/src/state/threads-sync.test.ts`, new `describe("history window")`)

**New tests:**

- "opens with the server's window and reports older history"
- "loads two older pages in order before the window"
- "applies a patch that arrives between two pages to the window only"
- "sends exactly N-1 page requests to reach the start of an N-page thread"
- "drops a page that answers a superseded cursor or generation"
- "keeps loaded pages when a resubscribe is answered unchanged"
- "keeps loaded pages when a snapshot keeps the floor and drops them when it
  moves"
- "resubscribes with the floor it holds"
- "persists the window, not the loaded pages"
- "treats a snapshot without history as the whole thread"

**Existing tests that must still pass:**

- "resumes from the revision it applied and keeps its thread when unchanged"
- `reconnectRetention.test.ts`
- `threads-atoms.test.ts`

### Web (happy-dom, run from `apps/web`)

- `MessagesTimeline.test.tsx`:
  - "keeps the first visible row in place when an older page loads"
  - "loads earlier messages from the top row without scrolling"
  - "offers a retry when an older page fails"
- `MessagesTimeline.logic.test.ts`: "labels the partial oldest turn Worked
  without a duration".
- `ChatView.logic.test.ts`: "a windowed thread with older history counts as
  having messages".
- `threadFind/useThreadFind.test.tsx`:
  - "says it searched loaded messages while older history remains"
  - "Search all loads every older page and rescans"
- `apps/web/src/connection/storage.test.ts`: "decodes a cached thread with and
  without history".

### Desktop e2e and manual

- Run `vp run test:ui:desktop`, including `document-navigation.e2e.ts`,
  `chat-reasoning-rows.e2e.ts` and `chat-activity-panel.e2e.ts`. They cover
  short threads, where the window is the whole thread. No new e2e spec: the
  packaged fixtures type their history through the composer, so a long thread
  is impractical there. The happy-dom tests and #225's harness cover the long
  case.
- Manual: a remote environment at #225's 3G preset. A long thread paints its
  last turns, scrolling up loads older turns without a jump, and a short
  thread looks as it did.

## Options considered

1. **Recommended: a fixed-floor window in the `subscribeThread` snapshot, plus
   a page RPC.** This document. It reuses `patches`, `resume`, `HeldThread`
   and LegendList's content-position upkeep. It adds one optional input field,
   one optional thread field and one unary RPC. The cost: the floor never
   moves up during a subscription, so a session that streams for hours grows
   its window. That's the same as an open thread today.
2. **A sliding window that keeps the window under budget as rows arrive.**
   Rejected. It sends removals, which the issue forbids. It shifts every array
   index, so each patch becomes most of the window, and it invalidates the
   client's pages.
3. **A window by `turn_id`.** Rejected. User messages are written with
   `turnId: null` (`engine.rs:4897`), and boot activities have no turn either
   (`engine.rs:3059`).
4. **A floor from rowids per table alone, without `createdAt`.** Rejected.
   Each table pages on its own, so the loaded region has holes between row
   kinds, for example messages without their tool calls.
5. **A floor from `createdAt` alone, without `hwm`.** Rejected. A message from
   a client whose clock is behind lands below the floor and stays invisible.
6. **Rebuild older history from `replayEvents`.** Rejected. Events are larger
   than projected rows, and the client would have to reduce them into rows
   again.
7. **Window only on the client.** Rejected. It saves no bytes.
8. **Find searches the server.** Deferred. It needs a text index and a new
   RPC. "Searched loaded messages" with **Search all** is honest and costs no
   server work.
9. **Cache older pages.** Rejected for now. The cache would grow without
   bound, a revert could leave pages stale, and the window plus #227's resume
   already covers the cold start.

## Open questions for approval

1. The budget numbers, once #225's baseline exists.
2. Whether the "(N more)" count is worth showing in the button. It costs only
   the `olderRows` integer already on the wire.
3. Whether to do phase 2 (the SQL floor for streaming ticks) in the same PR.
   The recommendation is to decide from #225's server-time numbers.

## Residual risk

- **Projection rebuild.** After a rebuild renumbers rowids, a skewed late row
  can land in a page instead of the window. It's still delivered once, but
  only when the user scrolls to it.
- **A page landing during a key scroll.** A page that arrives while a key
  scroll's native scroll is pending (#207) can shift the view once.
- **Pins can exceed the budget.** Pinned rows lower the floor, so a long active
  turn with an early pending request can push a window over its budget.
- **Stale rows in older pages.** Rows below the floor that change in place,
  which is rare because settled history is append-only, aren't updated in
  older pages until the next snapshot that moves the floor.
