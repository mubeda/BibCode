# Shell Finished-Thread Cap, Older Threads and Shell Resume

Status: Approved 2026-11-02 (user decision + Codex review, 3 rounds). Round 1
(`e724d358d`) returned REVISE with one P1 and seven P2 findings, round 2
(`38a523683`) with one P1 and four P2; [Review resolutions](#review-resolutions)
maps each to its change. The coordinator settled the open questions: caps of 25
overall plus 3 per project, workspace threads without a worktree are capped
too, and search matches titles only. Issue #223, the 2026-10-31 addendum
(proposed changes 6 to 9).

Revision 2 rests on one rule:

> **Absence from a capped shell never means a thread is gone.** Only `missing`
> from `orchestration.getThreadShells`, or absence from both an uncapped live
> shell and the archived snapshot (today's rule), means it was deleted. A
> removal item means only "no longer in the live shell": it updates lists, never
> persisted state.

Every reader that used to infer deletion from absence (lifecycle cleanup, the
route guard, actions) now asks for that evidence, and archiving keeps today's
behavior: an archived workspace keeps its saved tabs and layout.

- Builds on the shell deltas of #223 (`b286aa05f` and its review fixes): after
  the first snapshot the stream sends only the projects and threads that changed
  or left.
- Depends on #225, the 3G baseline and the byte-budget test
  (`apps/server/tests/transfer_budget.rs`).
- Composes with #226, the approved thread history window
  (`docs/plans/2026-11-01-thread-history-window-design.md` on
  `v015b/226-thread-history-window`). See [Interaction with #226](#interaction-with-226).

## Problem

Deltas fixed the resends during a turn. The first shell item is still every
non-archived thread with its previews: on every connect, reload and reconnect.
#225 measured that first snapshot at 246,121 bytes decoded (37,959 after
deflate) for 160 threads. A client that reconnects with a cached shell gets the
whole list again even when nothing changed. The streaming-turn measurement in
`orchestration_rpc.rs` (`shell_stream_traffic_during_a_streaming_turn`) puts
the first item at 45,357 bytes for 30 threads and 230,517 bytes for 150, while a
10 s streaming turn now costs about 30,000 bytes in deltas: the first item is
what remains.

Most of those threads are finished and nobody looks at them in this session.

## Current behavior (verified at `b286aa05f`)

### Server

- `Repositories::load_shell_snapshot_rows` (`repositories.rs:489-576`) selects
  every undeleted, non-archived thread whose project exists, ordered by
  `thread_id`, with no limit. Then, per thread, it reads the session, the newest
  user and assistant messages, the latest turn and, while that turn runs, its
  newest tool activities.
- `shell_snapshot_value` (`orchestration_rpc.rs`) serializes all projects and
  threads.
- `shell_stream_with_events` sends a snapshot, then deltas computed against
  `HeldShell` (a keyed fingerprint per project and thread id, plus the sequence
  the client holds). A lagged receiver, a failed re-read that later succeeds,
  or deltas that don't fit above the client's sequence get a whole snapshot.
- `orchestration.subscribeShell` ignores its input (`register_stream(…,
  move |_request, …|`).

### Contract

- `subscribeShell`'s payload is an empty struct. `OrchestrationShellStreamItem`
  is `snapshot` plus the four delta items. Items carry no revision.
- `OrchestrationProjectShell` has no thread counts.

### Client

- `makeEnvironmentShellState` (`client-runtime/src/state/shell.ts`) loads the
  cached shell as `degraded`, subscribes with `{}`, and becomes `live` only on
  a snapshot. It caches the shell as `StoredShellSnapshot`
  (`apps/web/src/connection/storage.ts:56`) with no revision.
- Pins and unread markers are client-only, persisted per device in
  `sidebarWorkspaceMetaStore.ts` (`pinnedThreadKeys`, `unreadThreadKeys`). The
  server knows neither.

### Web: who reads which threads from the shell

- **Left panel.** Per project, the primary row (the `default` thread), then
  workspace rows (every non-`panel` thread), pinned first, sorted by the
  sidebar sort order. Rows past `sidebarThreadPreviewCount` sit behind
  **Show more** (`Sidebar.tsx:1747`). `panel` threads are not rows; they count
  as **N more chats** on their checkout's card (`summarizeWorkspaceChats`,
  `Sidebar.logic.ts:902`).
- **Agents view and Inbox.** One row per chat agent and AI Terminal, grouped
  by status. Done is collapsed by default (`agentsSection.logic.ts`).
- **Command palette.** The Search row opens the palette over the shell's
  threads (`buildThreadActionItems`, `CommandPalette.logic.ts:127`).
- **Thread route.** `_chat.$environmentId.$threadId.tsx` treats a thread as
  present when it has a shell **or** a thread detail, so a thread opened by URL
  works without a shell row.
- **Workspace cards and the worktree catalog** need the `default` thread and
  every worktree thread.
- **AI Terminal rows.** `buildAgentRows` (`agentsSection.logic.ts:255-262`)
  drops a terminal row whose host thread has no shell. The terminal's agent
  status comes from the server's terminal metadata (`terminal/manager.rs`,
  `subscribe_metadata`).
- **Lifecycle cleanup.** `ThreadLifecycleReconciler.tsx:127-163` deletes the
  persisted center and right panel state of every thread that is in neither
  the live shell nor the archived snapshot.
- **Route guard.** `missingRouteThreadRedirectDelay` (`threadRoutes.ts:84-88`)
  bounces a route to the index 1 s after a live shell lacks its thread and no
  detail has arrived.
- **Entity readers.** `readThreadShell`, `useThreadShell` and `findThreadRef`
  (`state/entities.ts`) read only the shell. Their callers:
  - actions: `useThreadActions.ts:104,121,123,317,431` (archive returns success
    without dispatching when it finds no shell, `:241`),
    `centerPanelActions.ts:133,159,185`, `WorktreeRemovalDialog.tsx:115`,
    `useHandleNewThread.ts:90`, `useAddProjectWorkflow.ts:1089`,
    `UiIntentNotifier.tsx:60` (a panel's host);
  - labels: `UiIntentNotifier.tsx:118`, `OpenRequestRouter.tsx:109`,
    `MessageProvenance.tsx:48`, `deviceOwner.tsx:26`,
    `PanelTabAgentBadge.tsx:13-14`, `WorktreeRemovalDialog.tsx:160`;
  - the route: `_chat.$environmentId.$threadId.tsx:21`.

## Goals

1. The first shell item and a reconnect carry the threads the person can see or
   act on, not every finished thread.
2. No workspace card, live agent (chat or AI Terminal), unread or pinned thread
   disappears.
3. Older threads stay reachable: from each project, from each checkout's chats,
   from the Done group, and from search.
4. Nothing is cleaned up, redirected or silently skipped because a thread is
   merely left out.
5. A reconnect or reload whose shell didn't change costs a few bytes.
6. Old clients and old servers keep today's behavior, in both directions.

## Design

### 1. Which threads the shell carries

A subscriber that opts in (see [Wire contract](#6-wire-contract)) gets the
**kept set**: the union of

1. **Live threads.** The session is `starting` or `running`, the latest turn is
   running, a request is pending (`hasPendingApprovals`,
   `hasPendingUserInput`), a delivery is unresolved, a compaction is unsettled,
   or a message is queued.
2. **Live AI Terminal hosts.** Threads hosting a terminal whose agent status
   is not settled: working, waiting for input, or blocked. The terminal
   manager already knows this (`TerminalSummary.agentStatus`); the shell stream
   reads the set from it (§11).
3. **Card-backing threads.** Every `default` thread, and every `workspace`
   thread with a `worktreePath`.
4. **Threads the client names** in `cap.include`: its pinned and unread thread
   ids for this environment, the routed thread, and the hosts of its open chat
   panels, at subscribe time. At most `SHELL_INCLUDE_LIMIT` = 256 ids; the rest
   are ignored, and those threads stay reachable through §3 and §4.
5. **Recent finished threads.** Of the rest (workspace threads without a
   worktree and `panel` threads), the newest `SHELL_RECENT_FINISHED` = 25
   across the environment, plus the newest `SHELL_RECENT_PER_PROJECT` = 3
   non-panel threads of each project. "Newest" is
   `COALESCE(latest_user_message_at, updated_at)` descending, then `thread_id`.

Archived and deleted threads are never in the live shell, as today.

The cap is applied in `load_shell_snapshot_rows`, in SQL, before the per-thread
reads, so a left-out thread costs one row of the thread scan and nothing else.

**Sticky within a subscription.** The stream never removes a thread because it
left the kept set. Each re-read loads the kept set plus the ids `HeldShell`
already holds, and a fallback snapshot (lag, failed read, sequence overflow)
uses the same union. A left-out thread that becomes live, or whose terminal
starts working, is now kept, so the next re-read sends it as `thread-upserted`.

**The snapshot says it is capped.** A capped snapshot carries
`capped: true`. A client uses it, never its own request, to decide that
absence means nothing (the rule at the top): an old server ignores the request
and sends no marker, so its full list stays authoritative.

### 2. Counting what was left out, by checkout

Each project shell gains an optional field, grouped exactly as the left panel
groups chats (`workspaceCheckoutKey`, `Sidebar.logic.ts:891`):

```ts
olderThreads: Schema.optional(Schema.Struct({
  count: NonNegativeInt,                   // left-out non-panel threads
  chats: Schema.Array(Schema.Struct({
    worktreePath: Schema.NullOr(TrimmedNonEmptyString), // null: the main checkout
    count: NonNegativeInt,                 // left-out unarchived panel threads there
  })),
})),
```

- A card's **N more chats** is its loaded panels in that checkout plus the
  `chats` count for its `worktreePath`. This counts pathless panels of other
  hosts in the main checkout as `summarizeWorkspaceChats` does.
- `count` drives the project's **N older threads** row.
- The counts are part of the project fingerprint, so a change is a
  `project-upserted`.
- One grouped `COUNT` in the same SQL pass; no per-thread reads.

### 3. `orchestration.listOlderThreads`

A new unary RPC that pages left-out threads, and searches.

```ts
input: {
  scope: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
    Schema.Struct({
      kind: Schema.Literal("checkout"),
      projectId: ProjectId,
      worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    }),
    Schema.Struct({ kind: Schema.Literal("agents") }),
    Schema.Struct({ kind: Schema.Literal("search") }), // requires `query`
  ]),
  query: Schema.optional(TrimmedNonEmptyString),
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(Int.check(between(1, 100))),  // default 20
}
output: {
  threads: Schema.Array(OrchestrationThreadShell),
  cursor: Schema.NullOr(TrimmedNonEmptyString),        // null: nothing older
}
// typed failure: OrchestrationListOlderThreadsError (malformed cursor or input)
```

- **`project`**: the project's left-out non-panel threads (the **N older
  threads** row). **`checkout`**: the left-out panel threads of one checkout,
  grouped as in §2 (**N more chats**). **`agents`**: every left-out agent,
  panels included, as the Agents rows list them (Done paging). **`search`**:
  every unarchived thread of the environment, of any kind, with or without a
  session, kept or not; it requires `query` and is what the palette uses,
  because the Agents rows skip threads without a session
  (`agentsSection.logic.ts:147-148`).
- **Without `query`** it returns threads outside the kept set computed without
  `cap.include` (a page caller's include set is unknown), newest first by the
  §1 key, keyset paged on `(key, thread_id)`. The client drops ids it already
  holds, so every left-out thread arrives once for a store that doesn't change
  while paging.
- **With `query`** it searches every unarchived thread of the scope, kept or
  not, by case-insensitive title substring (`lower(title) LIKE ? ESCAPE '\'`).
  `search` without `query` is an `OrchestrationListOlderThreadsError`.
- **Cursor.** Base64url JSON `{ v: 1, scope, key, threadId }`: a timestamp and
  ids, never content.
- **Rows** use `thread_shell_with_records`, with the shell's per-thread reads
  for the page's threads only.

### 4. `orchestration.getThreadShells`: the authority for one thread

```ts
input:  { threadIds: Schema.Array(ThreadId).check(isMinLength(1), isMaxLength(100)) }
output: {
  threads: Schema.Array(OrchestrationThreadShell), // live or archived (archivedAt set)
  missing: Schema.Array(ThreadId),                 // deleted, or never existed
}
```

It answers "does this thread exist, and what is it" for any id, kept or not.
It is the only source of `missing`, which is the only evidence besides a
removal item that a thread is gone.

### 5. Shell resume (`unchanged`)

As `subscribeThread` does
(`docs/superpowers/specs/2026-10-17-thread-resubscribe-resume-design.md`):

- An opted-in snapshot carries `revision`: a 128-bit digest of `HeldShell`'s
  fingerprints, ids, counts and cap parameters, under keys secret to the server
  process. A restart draws new keys.
- **Each delta chunk's last item** carries the revision after the chunk. The
  client records a revision only from an item that carries one and clears it
  on one that doesn't.
- On `resume: { revision, snapshotSequence }` the server loads the kept set and
  answers `{ kind: "unchanged", snapshotSequence, revision, activityAges }` only
  when the revision is equal and its sequence is at least the client's;
  anything else gets the snapshot.
- **`activityAges`** maps each kept thread with a `lastActivityAt` to its age
  on the server's clock now: `Schema.Record(ThreadId, NonNegativeInt)`. The
  revision excludes ages (they grow every second), and a cached shell loses the
  client's receipt times (§7), so without this a cache restored an hour later
  would show Working from its original one-second age. The client pins each
  age on receipt of `unchanged`, exactly as for a snapshot. At 25 to 60 kept
  threads this is about 2 KB, and only on resume.

### 6. Wire contract

`packages/contracts/src/orchestration.ts`, schema only:

```ts
export const OrchestrationSubscribeShellInput = Schema.Struct({
  cap: Schema.optional(Schema.Struct({ include: Schema.optional(Schema.Array(ThreadId)) })),
  resume: Schema.optional(
    Schema.Struct({
      revision: TrimmedNonEmptyString,
      snapshotSequence: NonNegativeInt,
    }),
  ),
});
```

- `{}` stays valid, so an old client's request decodes unchanged. Sending
  `cap` or `resume` opts into revisions; neither gets no `revision`, no
  `capped` and never `unchanged`.
- `OrchestrationShellSnapshot` gains `capped: Schema.optional(Schema.Boolean)`.
- `OrchestrationShellStreamItem` gains `unchanged` (with `activityAges`); the
  `snapshot` and delta items gain an optional `revision`.
- `OrchestrationProjectShell` gains `olderThreads` (§2).
- New RPCs `orchestration.listOlderThreads` and `orchestration.getThreadShells`.
- `rpc-wire` fixtures regenerate, with the counts in the exporter, its test and
  `apps/server/tests/rpc_wire.rs`.

### 7. Compatibility matrix

| Client     | Server | Result                                                                                                                                                         |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| old        | old    | today                                                                                                                                                          |
| old (`{}`) | new    | every thread, no `capped`, `revision` or `olderThreads`, never `unchanged`: #223's delta stream                                                                |
| new        | old    | the server ignores `cap` and `resume`; every thread, no `capped`, so absence stays authoritative as today; no `olderThreads`, so the new RPCs are never called |
| new        | new    | the kept set, counts, revisions, `unchanged`, older pages, the resolver                                                                                        |

- An old client never receives the new fields or items, because it never opts
  in, and `Schema.Struct` ignores an extra key anyway.
- **Downgraded client.** It loads a cache written by a new one, ignores
  `revision` and `capped`, shows it `degraded`, and replaces it with its first
  snapshot, which is full. Its own lifecycle cleanup then runs against a full
  list, as today.
- **Downgraded server.** A cached revision mismatches (the old server ignores
  `resume`); the full snapshot without `capped` replaces the cache.

### 8. Removal items reach left-out threads

A page copy or a resolved copy must not outlive its thread.

- The shell stream also collects, from the events of each coalesce window, the
  aggregate ids of every `thread.deleted`, `thread.archived`,
  `thread.unarchived` and `project.deleted` event. These are only candidates.
  At the tick, after the re-read, it reads the **final** state of those ids
  (one `SELECT thread_id, archived_at, deleted_at … WHERE thread_id IN (…)`,
  plus the project rows) and sends `thread-removed` or `project-removed` only
  for ids that are, at that point, not live-shell threads (archived, deleted
  or without a project) and that the delta didn't already cover, held or not.
  An archive and an unarchive in one window therefore send nothing. It is a few
  bytes per event and only for opted-in subscribers.
- After `Lagged`, a failed read or any snapshot, the client drops every page
  and resolved copy for the environment (§9), since a removal may have been
  missed.
- A thread that was paged, entered the shell, and is then deleted gets the
  ordinary removal delta; the client drops it from the shell and any page.

### 9. Client runtime

- **Subscribe.** `{ cap: { include }, resume? }`, with `include` built at
  subscribe time from this environment's pinned and unread thread keys, the
  routed thread and the hosts of open chat panels.
- **`unchanged`.** Applies like a snapshot equal to the cache: status `live`,
  `capped` kept, the revision kept, and `activityAges` pinned to the receipt
  time. Accepted only from the current session and generation.
- **Revision.** Held beside the snapshot, set from items that carry one,
  cleared by items that don't, persisted as an optional `revision` in
  `StoredShellSnapshot`.
- **Off-shell threads.** A session-only store per environment holds thread
  shells that are not in the live shell: older pages (keyed by scope and query,
  with their cursors) and threads resolved by `getThreadShells`. It is never
  persisted. It drops an id on a removal item, drops a project's threads on
  `project-removed`, yields to the shell when the id arrives there (the shell
  copy is live-updated, the off-shell copy isn't), and is cleared on any
  snapshot, `Lagged`-triggered or not, and on session change.
- **Generation fence.** The store has a `generation` counter that every
  removal item, snapshot, `unchanged` and session change bumps. Each
  `listOlderThreads` or `getThreadShells` request records the generation it was
  sent at, and its reply is dropped if the generation moved meanwhile; a
  reader still waiting re-issues it. A reply that was in flight across a
  deletion therefore never brings the row back.
- **Resolver.** One lookup in `state/entities.ts` for every reader:
  1. the live shell;
  2. the off-shell store;
  3. when both miss and the shell is `capped`, `getThreadShells([id])`,
     batched per tick, whose `threads` fill the store and whose `missing` is
     remembered for the session. A shell without `capped` comes from an old
     server, which has no `getThreadShells`: the resolver answers `Unknown`,
     never `Missing`.

  `readThreadShell`, `useThreadShell` and `findThreadRef` read steps 1 and 2
  synchronously; `useThreadShell` also starts step 3 and re-renders when it
  lands. A new `resolveThreadShell(ref): Promise<Resolved | Missing | Unknown>`
  runs all three. `getThreadShells` returns archived threads too, so a resolved
  thread may carry `archivedAt`. Its callers, from the list under Current
  behavior:
  - **Unarchive and delete** keep today's direct dispatch
    (`useThreadActions.ts:286-313`): their commands are valid for an archived
    thread the live shell never holds, so they never wait on the resolver and
    work against old servers exactly as today. Delete still uses a resolved
    shell, when there is one, for its worktree handling.
  - **Other actions** await `resolveThreadShell` and fail visibly on `Missing`
    (**This thread no longer exists.**), never succeed silently; on `Unknown`
    (old server) they behave as today: `useThreadActions.ts` archive, rename
    and fork paths (`:104,121,123,431`), `centerPanelActions.ts:133,159,185`,
    `WorktreeRemovalDialog.tsx:115`, `useHandleNewThread.ts:90`,
    `useAddProjectWorkflow.ts:1089`, and `UiIntentNotifier.tsx:60`, which
    therefore finds an omitted panel's host before it routes.
  - **Labels** use the synchronous read and its re-render:
    `UiIntentNotifier.tsx:118`, `OpenRequestRouter.tsx:109`,
    `MessageProvenance.tsx:48`, `deviceOwner.tsx:26`, `PanelTabAgentBadge.tsx:13-14`,
    `WorktreeRemovalDialog.tsx:160`. While unresolved they show what they show
    today for an unknown thread.

- **Lifecycle cleanup.** `ThreadLifecycleReconciler` keeps today's rule for a
  snapshot without `capped`, and today's archive handling in both cases: an
  archived non-panel thread keeps its state, a closed (archived) chat panel
  does not (`ThreadLifecycleReconciler.tsx:153-161`). For a capped shell, a
  thread with persisted panel state that is in neither the live shell, the
  archived snapshot nor the drafts is a candidate, not a deletion: the
  reconciler asks `getThreadShells(candidates)` in batches of 100, retains every
  returned thread except an archived panel, and deletes state only for
  `missing` ids. Removal items never delete state: they change live membership,
  which, as today, refetches the archived snapshot that decides.
- **Route guard.** `shouldRedirectMissingRouteThread` gains the capped input.
  For a capped shell the 1 s timer never runs; the route redirects only when
  the resolver returns `Missing` for the routed thread. Until then the route
  shows the thread's loading state while its detail (#226's window) arrives,
  however slow the link.
- **Agents rows.** A terminal row whose host is not in the shell resolves the
  host through the resolver instead of being dropped, so a terminal that turns
  live between re-reads is never lost (§1 keeps it from the next re-read on).

### 10. Web

- **Left panel, per project.** After **Show more**/**Show less**, a row **N
  older threads** when `olderThreads.count > 0`. Selecting it loads the first
  `project` page inline as ordinary workspace rows; **Load 20 more** while a
  cursor remains; **Hide older threads** collapses them for the session.
- **N more chats.** The count adds the checkout's `chats` count. Its menu pages
  the `checkout` scope.
- **Agents view and Inbox Done.** When the environment's shell is capped, Done
  ends with **Show older**, paging the `agents` scope, so finished panel chats
  are reachable too.
- **Command palette.** Search matches the shell and the off-shell store at
  once. With 2 or more characters and a capped shell, it asks
  `listOlderThreads({ scope: { kind: "search" }, query, limit: 20 })` after
  250 ms without typing, appends new matches under **Older threads**, and a
  newer query cancels the request in flight.

### 11. Server stream

- `shell_stream_with_events` decodes `OrchestrationSubscribeShellInput`; a
  decode failure ends the stream with `InvalidRequest`.
- `HeldShell` gains the include set, the counts, the lifecycle candidate ids
  collected in the window (§8, resolved against final state at the tick) and
  `revision(keys)`.
- **Terminal hosts.** The stream takes the terminal manager's live-agent host
  set when it re-reads, and the terminal metadata subscription schedules a
  re-read when that set changes. Only the set of host ids crosses the module
  boundary.
- `listOlderThreads` and `getThreadShells` are `register_unary` in
  `register_orchestration_rpc_inner`.

### 12. UI.md states

- **Loading.** **N older threads** becomes **Loading older threads…** with a
  spinner in place. The palette shows **Searching older threads…** under local
  results, which stay usable. A route to a left-out thread shows the thread's
  normal loading state, never a redirect.
- **Error.** **Couldn't load older threads.** with **Retry**, in place; loaded
  rows stay. An action on a thread the server reports missing says **This
  thread no longer exists.** and changes nothing.
- **Offline.** The row reads **N older threads: reconnect to load**, disabled,
  with that reason as its accessible description. The palette says **Older
  threads are searched when <name> is connected.**
- **Empty.** A page with no rows removes the row; the next project upsert
  refreshes the count.
- **No surprise.** Nothing pinned, unread, open, or hosting a live AI Terminal
  disappears; **N more chats** is unchanged by the cap; no panel state is lost
  because a thread was left out.
- **Accessibility.** The rows are buttons named with their count ("12 older
  threads in <project>"); loading and errors use the sidebar's polite live
  region.

### 13. Persistence

- **Server.** No migration. If #225's server-time numbers call for it, an index
  on `(project_id, archived_at, deleted_at, latest_user_message_at,
  updated_at)` in the same PR.
- **Client.** Optional `revision` and `capped` in `StoredShellSnapshot`. The
  off-shell store is never written.

### 14. Profiler, crash and trace coverage

- **New RPCs.** `listOlderThreads` and `getThreadShells` register through
  `registry.register_unary` (`rpc/session.rs`), which times them. Both are
  local database reads, so neither joins `is_long_running`
  (`diagnostics/profiler/latency.rs:106`); a slow one is a real `rpc.slow`.
- **`subscribeShell`** stays a `register_stream`.
- **Auth.** Both RPCs join the read scope beside `orchestration.subscribeShell`
  (`auth/scope.rs:56`) and the read mutability table in
  `production_maintenance.rs`.
- **Logs.** Malformed input or cursors log `tracing::warn!` with the method and
  reason only. Queries, titles and previews never reach logs or profiler
  records; at most a query's length.
- No new process, service, shutdown step, re-exec mode or removal path. The
  terminal-host set is read from the existing terminal manager.

### 15. Budget

- `transfer_budget.rs` gets a capped shell entry on #225's fixture and lowers
  the shell budget to the measured size plus 3-5%.
- The 3G cold-connect and reconnect rows are re-measured before and after.

## Interaction with the shell deltas

- The cap decides which threads enter `HeldShell`; deltas work as in #223.
  Sticky ids mean a delta never removes a thread for leaving the cap.
- Counts travel as `project-upserted`; removal items for left-out threads (§8)
  share the chunk's sequence numbering.
- A fallback snapshot uses `kept ∪ held`, so it never drops the client's rows.
- The revision is computed from `HeldShell` once per chunk.

## Interaction with #226

- **Same patterns, separate streams.** Both resume with
  `{ revision, snapshotSequence }` and `unchanged` under process-secret keys,
  and both are opt-in.
- **Opening a left-out thread.** The route resolves through §9 and never
  redirects before the resolver answers; the thread itself arrives as #226's
  window. The shell row joins the live shell when the thread is routed at the
  next subscription, pinned, unread or live.
- **Budgets.** #225's test gets a windowed thread open (#226) and a capped
  shell (this design).
- **Shared code.** The keyed digest of `HeldThread::revision` moves to a small
  function used by `HeldThread` and `HeldShell`.

## Tests that prove the acceptance criteria

### Rust, `apps/server/src/persistence/repositories.rs`

- `shell_rows_keep_live_card_included_and_recent_threads_of_150` — with 150
  finished threads: the newest 25 plus 3 per project, every live, `default`,
  worktree and included thread, and the right `olderThreads` counts per
  project and per checkout.
- `shell_rows_count_main_checkout_chats_of_every_host` — pathless panels of
  two hosts count under one main-checkout entry.
- `shell_rows_read_no_sessions_or_messages_for_left_out_threads`.
- `shell_rows_order_recent_finished_by_last_user_message_then_update`.

### Rust, `apps/server/src/production/orchestration_rpc.rs`

- `shell_stream_without_cap_sends_every_thread` — `{}`: full list, no
  `capped`, no `revision`.
- `shell_stream_cap_sends_kept_set_counts_and_capped`.
- `shell_stream_keeps_a_live_terminal_host` — an old pathless workspace with a
  working terminal and no session is kept, and becomes kept when its terminal
  starts working.
- `shell_stream_upserts_a_left_out_thread_that_starts_a_turn`.
- `shell_stream_keeps_a_thread_pushed_out_of_the_cap`.
- `shell_stream_sends_removal_for_a_left_out_thread_deleted_or_archived`.
- `shell_stream_sends_no_removal_for_archive_then_unarchive_in_one_window`.
- `shell_stream_fallback_snapshot_keeps_held_threads`.
- `shell_stream_resume_with_current_revision_answers_unchanged_with_ages`.
- `shell_stream_resume_with_stale_revision_or_new_keys_sends_snapshot`.
- `shell_stream_delta_chunks_carry_the_revision_on_their_last_item`.
- `list_older_threads_pages_every_left_out_thread_once_newest_first`.
- `list_older_threads_checkout_scope_matches_the_chat_grouping`.
- `list_older_threads_agents_scope_includes_panels`.
- `list_older_threads_search_scope_finds_threads_without_sessions`.
- `list_older_threads_search_scope_requires_a_query`.
- `list_older_threads_searches_titles_case_insensitively_with_escaped_wildcards`.
- `list_older_threads_rejects_a_malformed_cursor`.
- `get_thread_shells_returns_live_and_archived_and_lists_missing`.

### Rust, integration

- `production_orchestration_rpc.rs`: `shell_cap_and_resume_over_the_wire`.
- `transfer_budget.rs`: the capped shell entry.
- `production_maintenance.rs`: both new RPCs are reads.

### Contracts (`vp run check:contracts`)

- Regenerated fixtures; `rpcRustParity.test.ts` passes.
- `orchestration.test.ts`: `{}` decodes as a `subscribeShell` input; a snapshot
  and a project shell without the new fields decode.

### Client runtime

- `shell-sync.test.ts`, `describe("shell cap and resume")`:
  - `subscribes with the cap, the include set and the cached revision`;
  - `takes unchanged as live and pins its activity ages`;
  - `a cold resume after an hour shows No update, not Working` (cached shell,
    `unchanged` with an hour-old age, then the freshness reader);
  - `clears the revision on an item without one`;
  - `ignores unchanged from a stale session`.
- `offShellThreads.test.ts`: `pages and dedupes against the shell`,
  `a removal item drops a page copy`, `project-removed drops its threads`,
  `any snapshot clears the store`, `the shell copy wins`,
  `drops a page reply that completes after a removal`,
  `drops a lookup reply that completes after a snapshot`.
- `entities` resolver tests: `resolves shell, then off-shell, then the server`,
  `remembers missing for the session`, `batches lookups per tick`,
  `answers Unknown, never Missing, for an uncapped shell`,
  `resolves an archived thread with archivedAt`.

### Web (happy-dom, from `apps/web`)

- `ThreadLifecycleReconciler.test.tsx`:
  `keeps panel state of a thread left out of a capped snapshot`,
  `deletes panel state only for ids getThreadShells reports missing`,
  `keeps an archived workspace's state after a removal item and restores it on
  unarchive`, `drops an archived chat panel's state`, and the existing
  full-list tests unchanged.
- `threadRoutes.test.ts`: `never redirects a capped route before the resolver
  answers`, `redirects when the resolver reports missing`.
- `useThreadActions.test.ts`: `archives a left-out thread through the
  resolver`, `reports a missing thread instead of succeeding`,
  `unarchives and deletes an archived thread by direct dispatch against an old
  server`.
- `UiIntentNotifier.test.tsx`: `routes a left-out panel to its host`.
- `agentsSection.agents.test.ts`: `keeps a terminal row whose host is
  off-shell`, `pages older agents into Done, panels included`.
- `Sidebar.logic.test.ts`: `shows N older threads`, `adds the checkout's chats
  count to N more chats`, `keeps every workspace card`.
- `CommandPalette.logic.test.ts`: `appends older matches`, `finds a left-out thread without a session`, `cancels an older
  search when the query changes`.
- A component test for the older row's loading, error, offline and empty
  states.

### Desktop e2e and manual

- `apps/desktop/e2e/specs/main-window.e2e.ts` passes with the cap on.
- Manual on #225's 3G scenario: cold connect, a reconnect answered
  `unchanged`, older rows, Done paging, search, opening a left-out thread on
  the slow link without a redirect.

## Living docs (same PR)

- `docs/architecture/rpc-and-orchestration.md`: the kept set, `capped`, sticky
  ids, counts, removal items, both RPCs, shell resume and `activityAges`.
- `docs/architecture/connection-runtime.md`: the absence rule, the resolver,
  the reconciler and route guard evidence, the cached revision.
- `docs/user/workspace-ui.md`: older rows, **N more chats**, Done paging,
  search.
- `docs/testing/` runbooks: reviewed; the manual check goes in #225's slow-link
  scenario.

## Options considered

1. **Recommended: an opt-in kept set with sticky ids, a `capped` marker,
   checkout-grouped counts, two read RPCs, removal items for left-out threads,
   one resolver, and revision resume with ages.**
2. **Send every thread id in a capped snapshot** so absence stays meaningful.
   Rejected: ids alone are tens of KB on large stores, and they still don't
   carry what readers need (host, title, archived state).
3. **The server tracks unread and pins.** Rejected for this issue; they are
   per device today.
4. **Remove a thread that leaves the cap.** Rejected: indistinguishable from a
   deletion, and rows would vanish in use.
5. **Resubscribe the shell when the route changes.** Rejected: a round trip
   and often a snapshot per navigation; the resolver covers the route.
6. **Search in the client over pages.** Rejected: it must page everything
   first.
7. **Persist client receipt times instead of `activityAges`.** Rejected: the
   cache would trust a clock across restarts and sleeps; the server's age is
   authoritative.

## Residual risk

- **Order differs between kept and paged rows** under a non-default sort.
- **Include-set staleness.** A thread pinned or marked unread on another
  device appears only once paged, resolved or live.
- **Sticky growth.** A long session keeps every thread it created until the
  next subscription.
- **Resolver traffic.** A view listing many off-shell ids (for example a long
  provenance chain) costs one batched `getThreadShells` per tick.

## Review resolutions

### Round 1 (`e724d358d`)

1. **P1, capped snapshots trigger lifecycle cleanup.** The absence rule; the
   `capped` marker; the reconciler deletes only on `getThreadShells` `missing`
   (§1, §4, §9; narrowed in round 2).
2. **P2, live AI Terminals lose their hosts.** Kept set item 2, read from the
   terminal manager with re-reads on its changes (§1, §11), and the Agents
   rows resolve an off-shell host instead of dropping it (§9).
3. **P2, opening a left-out thread can redirect.** For a capped shell the 1 s
   timer never runs; only a resolver `Missing` redirects (§9).
4. **P2, actions and notifiers miss off-shell threads.** One resolver in
   `state/entities.ts`, every caller listed with its sync or async use; actions
   fail visibly on `Missing` (§9).
5. **P2, page copies outlive deletion.** Removal items for left-out ids from
   the window's lifecycle events, `project-removed` drops a project's copies,
   and any snapshot clears the off-shell store (§8, §9).
6. **P2, Done can't page panels.** The `agents` scope pages every left-out
   agent, panels included (§3, §10).
7. **P2, host-based counts disagree with checkout cards.** Counts and the
   `checkout` scope use `workspaceCheckoutKey`'s grouping (§2, §3).
8. **P2, cold resume resets freshness.** `unchanged` carries `activityAges`,
   pinned on receipt; a cold-resume test (§5, §9).

### Round 2 (`38a523683`)

1. **P1, a removal item for an archive drops saved tabs.** Removal items never
   touch persisted state; the archived snapshot and `getThreadShells` decide,
   so an archived workspace keeps its state and a closed panel drops it, as
   today (§9, the absence rule).
2. **P2, archive then unarchive in one window sends a false removal.** Lifecycle
   events only nominate ids; removals come from their final state at the tick
   (§8).
3. **P2, a delayed reply resurrects a deleted row.** A generation fence that
   removals, snapshots, `unchanged` and session changes bump; stale replies are
   dropped (§9).
4. **P2, archived-thread actions against old servers.** Unarchive and delete
   keep today's direct dispatch; the resolver answers `Unknown`, never
   `Missing`, for an uncapped shell, and resolves archived threads with
   `archivedAt` (§9).
5. **P2, search misses threads without sessions.** A `search` scope over every
   unarchived thread of the environment, used by the palette (§3, §10).

### Implementation review (Codex, after `e87a269a4`)

1. **P1, panel adoption closed tabs on a capped reconnect.** Adoption never
   closes a tracked panel's tab because a capped list left it out; the
   reconciler drops it once the server reports it archived or missing.
2. **P1, a delayed lookup deleted a reopened panel.** A capped cleanup applies
   its lookup's answer only if no newer shell or archived snapshot arrived
   meanwhile.
3. **P2, `missing` outlived the session.** A new session empties the off-shell
   store; a snapshot that lists a thread, or a lookup that returns it, clears
   its `missing` mark.
4. **P2, a failed re-read dropped sticky ids.** The stream keeps `held` across
   the failure, so the recovery snapshot keeps every thread the client holds.
5. **P2, item sequences past the engine's.** Items numbered past the engine's
   sequence carry it as `engineSequence`; the client keeps it beside the
   shell, the reconciler compares the archived snapshot with it, and a resume
   sends it. Alternatives rejected: a snapshot whenever items outnumber events
   (it clears every page on an archive), and holding items back until events
   make room (a terminal's host would wait for the next event).
6. **P2, streaming re-read resolved threads.** Cleanup looks up only threads
   the off-shell store has not resolved.
7. **P2, Done paging never rendered.** The Agents view matches the
   `status:done` group; the Inbox's Done category ends with **Show older** too.
8. **P2, N more chats was static.** It opens the checkout's chats, then a row
   that loads the left-out ones a page at a time, with loading, failure and
   offline states.
9. **P2, palette search outcomes were silent.** Under the results it shows
   **Searching older threads…**, **Couldn't search older threads.** with
   **Retry**, and **Older threads are searched when <name> is connected.**
10. **P2, no capped budget.** `transfer_budget.rs` measures a capped shell on
    #225's fixture (one default thread per project, the rest workspace threads
    without a worktree, and panels), and the streaming-turn benchmark measures
    both subscriptions.
11. **Found while fixing 5: every re-read widened the cap.** Forced (held and
    included) threads were taken out of the newest-first ranking, so the
    threads a stream held handed their 25 recent slots to older ones on the
    first re-read. A forced thread now keeps its place in the ranking.
