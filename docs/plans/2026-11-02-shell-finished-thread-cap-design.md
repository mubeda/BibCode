# Shell Finished-Thread Cap, Older Threads and Shell Resume

Status: Proposed 2026-11-02, awaiting review. Issue #223, the 2026-10-31
addendum (proposed changes 6 to 9). No code until this is approved.

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

## Goals

1. The first shell item and a reconnect carry the threads the person can see or
   act on, not every finished thread.
2. No workspace card, live agent, unread or pinned thread disappears.
3. Older threads stay reachable: from each project, from the Done group, and
   from search.
4. A reconnect or reload whose shell didn't change costs a few bytes.
5. Old clients and old servers keep today's behavior, in both directions.

## Design

### 1. Which threads the shell carries

A subscriber that opts in (see [Wire contract](#5-wire-contract)) gets the
**kept set**: the union of

1. **Live threads.** The session is `starting` or `running`, the latest turn is
   running, a request is pending (`hasPendingApprovals`,
   `hasPendingUserInput`), a delivery is unresolved, a compaction is unsettled,
   or a message is queued. These are the Working, Pending Approval and Awaiting
   Input agents, plus the states the left panel flags.
2. **Card-backing threads.** Every `default` thread, and every `workspace`
   thread with a `worktreePath`. No card disappears, and the worktree catalog
   keeps every thread it pairs with.
3. **Threads the client names** in `cap.include`: its pinned and unread thread
   ids for this environment, and the routed thread at subscribe time. At most
   `SHELL_INCLUDE_LIMIT` = 256 ids; the rest are ignored, and those threads
   stay reachable through older-thread pages.
4. **Recent finished threads.** Of the rest, the newest
   `SHELL_RECENT_FINISHED` = 25 across the environment, plus the newest
   `SHELL_RECENT_PER_PROJECT` = 3 of each project, so every project shows its
   own recent work. "Newest" is `COALESCE(latest_user_message_at, updated_at)`
   descending, then `thread_id`. This is the left panel's default sort; the
   other sort orders only reorder what is loaded.
5. **Panel threads of a kept host.** A `panel` thread whose `hostThreadId` is
   kept and that is live or among the newest 3 panels of that host. The rest of
   that host's panels are counted (§2).

Archived and deleted threads are never in the live shell, as today.

The cap is applied in `load_shell_snapshot_rows`, in SQL, before the per-thread
reads, so a left-out thread costs one row of the thread scan and nothing else:
no session, message, turn or activity reads.

**Sticky within a subscription.** The stream never removes a thread because it
left the kept set, for example when a newer finished thread pushes it out of
the newest 25. It sends `thread-removed` only when a thread is deleted,
archived or loses its project, as today. Each re-read loads the kept set plus
the ids `HeldShell` already holds. A fallback snapshot (lag, failed read,
sequence overflow) uses the same union, so it never takes rows away from the
client. The set is recomputed fresh on the next subscription. This keeps
deltas exact and cheap, and the shell grows during a session only by the
threads that became live or were created in it.

A left-out thread that becomes live is now in the kept set, so the next re-read
sends it as `thread-upserted`. That is the existing delta path; nothing new is
needed.

### 2. Counting what was left out

Each project shell gains an optional field:

```ts
olderThreads: Schema.optional(Schema.Struct({
  count: NonNegativeInt,          // left-out non-panel threads of this project
  panels: Schema.Array(Schema.Struct({
    hostThreadId: ThreadId,
    count: NonNegativeInt,        // left-out panel threads of that host
  })),
})),
```

- It is present only for an opted-in subscriber, and only when a count is above
  zero.
- `count` drives the left panel's **N older** row. `panels` keeps a card's
  **N more chats** exact: the card shows its loaded panels plus its left-out
  panel count.
- The counts are part of the project shell's fingerprint, so a change, such as
  an older thread archived, deleted, or becoming live, is a `project-upserted`.
- The counts come from the same SQL pass as the kept set: one grouped count, no
  per-thread reads.

### 3. `orchestration.listOlderThreads`

A new unary RPC that pages the threads the shell left out, and searches.

```ts
input: {
  projectId: Schema.optional(ProjectId),
  hostThreadId: Schema.optional(ThreadId),   // a host's panels; otherwise non-panel threads
  query: Schema.optional(TrimmedNonEmptyString),
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(Int.check(between(1, 100))),  // default 20
}
output: {
  threads: Schema.Array(OrchestrationThreadShell),   // the shell's own shape, with previews
  cursor: Schema.NullOr(TrimmedNonEmptyString),      // null: nothing older
}
// typed failure: OrchestrationListOlderThreadsError (malformed cursor, unknown project)
```

- **Without `query`** it returns the non-archived threads outside the kept set,
  without `cap.include` (the server doesn't know a page caller's include set),
  newest first by the §1 key. The client drops ids it already holds. Paging is
  keyset on `(newestKey, thread_id)`, so every left-out thread is returned once
  for a store that doesn't change while paging. A thread that changes while the
  client pages moves to the kept set or to an earlier page. The client
  dedupes by id, and the thread arrives by delta if it became live.
- **With `query`** it searches every non-archived thread of the environment, or
  of `projectId`, kept or not, by case-insensitive title substring (`LIKE` with
  `ESCAPE`, a `lower(title)` comparison). Newest first, same cursor. The palette
  merges the results with its local matches by id.
- **Cursor.** Base64url JSON `{ v: 1, key, threadId }`. It holds a timestamp
  and an id, never content. The client only stores it and echoes it back.
- **Rows.** Each thread is built by the same `thread_shell_with_records`, with
  the same per-thread reads as the shell, for the page's threads only.
- **Old server.** The client calls it only when a project shell has
  `olderThreads` or the person searches with a capped shell, which only a new
  server sends. An old server never sees the call.

### 4. Shell resume (`unchanged`)

As `subscribeThread` does (see the thread resume design,
`docs/superpowers/specs/2026-10-17-thread-resubscribe-resume-design.md`):

- An opted-in snapshot item carries `revision`: a 128-bit digest of
  `HeldShell`'s fingerprints, the ids, the counts and the cap parameters, under
  `ThreadRevisionKeys`-style keys secret to the server process. A restart draws
  new keys, so every revision from before it mismatches.
- **Each delta chunk's last item** carries the revision after the chunk. The
  client records a revision only from an item that carries one, and clears it
  when it applies an item without one. A client that missed or dropped an item
  therefore holds no revision, or a stale one, and gets a snapshot.
- The client persists the revision with the cached shell (§7).
- On subscribe with `resume: { revision, snapshotSequence }`, the server loads
  the kept set for the request and compares. It answers
  `{ kind: "unchanged", snapshotSequence, revision }` only when the revision is
  equal and the server's sequence is at least the client's. It then sends
  deltas against that shell. Anything else gets the snapshot: a change the
  client missed, a restart, an unknown revision, a newer sequence than the
  server's, or a different include set that changed the kept set.
- Sticky rows from the previous subscription aren't in a fresh kept set, so a
  client that held them gets a snapshot. That costs bytes, never correctness,
  and only after a session that kept extra rows.

### 5. Wire contract

`packages/contracts/src/orchestration.ts`, schema only:

```ts
export const OrchestrationSubscribeShellInput = Schema.Struct({
  /** Apply the finished-thread cap; older servers ignore it and send every thread. */
  cap: Schema.optional(
    Schema.Struct({
      include: Schema.optional(Schema.Array(ThreadId)),
    }),
  ),
  /** The revision of the shell the client holds; older servers ignore it. */
  resume: Schema.optional(
    Schema.Struct({
      revision: TrimmedNonEmptyString,
      snapshotSequence: NonNegativeInt,
    }),
  ),
});
```

- `subscribeShell`'s payload becomes this struct. `{}` stays valid, so an old
  client's request decodes unchanged.
- `OrchestrationShellStreamItem` gains `{ kind: "unchanged", snapshotSequence,
  revision }`. The `snapshot` item and the delta items gain an optional
  `revision`.
- `OrchestrationProjectShell` gains the optional `olderThreads`.
- New RPC `orchestration.listOlderThreads` in `ORCHESTRATION_WS_METHODS` and
  `WsRpcGroup`.
- `rpc-wire` fixtures regenerate: the `unchanged` stream shape, the new
  method, its typed failure. Counts in the exporter, its test and
  `apps/server/tests/rpc_wire.rs` move with them.

`resume` without `cap` is valid: it resumes a full shell. Sending `cap` or
`resume` is what opts a client into revisions; a request with neither, as an
old client sends, gets no `revision` and never `unchanged`.

### 6. Compatibility matrix

| Client     | Server | Result                                                                                                                                   |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| old        | old    | today                                                                                                                                    |
| old (`{}`) | new    | every thread, no `revision`, no `olderThreads`, never `unchanged`: byte for byte the delta stream of #223                                |
| new        | old    | the server ignores `cap` and `resume`; every thread, no `revision`; the client sees no `olderThreads` and never calls `listOlderThreads` |
| new        | new    | the kept set, counts, revisions, `unchanged`, older pages                                                                                |

- **Unknown fields and variants.** An old client never receives `unchanged`,
  `revision` or `olderThreads`, because it never opts in. A new client of an
  old server never receives them either. `Schema.Struct` ignores an extra key in
  any case.
- **Downgraded client.** An old client loads a cache written by a new one; the
  `revision` key is ignored. The cache holds a capped shell, shown as
  `degraded` until its first snapshot, which is full and replaces it.
- **Downgraded server.** A cached revision mismatches the old server's
  behavior (it ignores `resume`), so the full snapshot replaces the cache.

### 7. Client runtime

- `makeEnvironmentShellState` subscribes with
  `{ cap: { include }, resume }` when it holds a cached revision. `include` is
  built when the subscription starts, from this environment's pinned and unread
  thread keys and the routed thread. It is read once per subscription, so
  pinning a thread doesn't resubscribe; a pinned thread is already loaded
  because the person could see it to pin it.
- **`unchanged`.** It applies like a snapshot equal to the cached one: status
  `live`, nothing published if nothing changed, the revision kept. Like a
  snapshot it is accepted only from the current session and generation.
- **Revision.** Held in the shell state beside the snapshot. Set from an item
  that carries one, cleared by one that doesn't. Persisted: `StoredShellSnapshot`
  gains an optional `revision`, so the cache schema needs no version bump.
- **Older pages.** A new session-only store, `olderThreads`, keyed by
  environment and `(projectId | hostThreadId | "all", query)`. It holds the
  loaded threads and the next cursor, is never persisted, and is cleared when
  the session changes, since the server may have restarted. A thread that
  later arrives in the shell wins over its page copy (the shell copy is
  live-updated; the page copy isn't).
- **Shell plus pages.** Readers that list finished threads (left panel older
  rows, Done group, palette) merge the shell's threads with the loaded pages,
  deduped by id, shell first.

### 8. Web

- **Left panel, per project.** Under the project's rows, after **Show
  more**/**Show less**, a row **N older threads** when `olderThreads.count > 0`.
  Selecting it loads the first page inline (20 rows) as ordinary workspace rows
  in the project's sort order. While more remain, the last row is **Load 20
  more**. **Hide older threads** collapses them again; the loaded rows stay in
  memory for the session.
- **N more chats.** The count adds `olderThreads.panels` for that host. The
  menu that lists the chats pages the host's older panels the same way.
- **Agents view and Inbox Done.** Done lists the loaded finished agents. When
  any project has older threads, the group ends with **Show older (N)**, paging
  `listOlderThreads` without a project.
- **Command palette.** Search matches the shell and loaded pages at once. When
  the query has at least 2 characters and the shell is capped, it asks
  `listOlderThreads({ query, limit: 20 })` after 250 ms of no typing and appends
  the new matches under **Older threads**. A newer query cancels the request in
  flight.

### 9. UI.md states

- **Loading.** The **N older threads** row turns into **Loading older
  threads…** with a spinner and keeps its place. The palette section shows
  **Searching older threads…** under the local results, which stay usable.
- **Error.** **Couldn't load older threads.** with **Retry**, in place. The
  palette shows the same line under its local results. Loaded rows stay.
- **Offline.** While the environment isn't live, the row reads
  **N older threads: reconnect to load** and is disabled, with that reason as
  its accessible description. The palette doesn't search older threads and
  says **Older threads are searched when <name> is connected.**
- **Empty.** A page with no rows, because the counts moved on, removes the row
  and refreshes the count from the next project upsert. A search with no older
  matches shows nothing extra.
- **No surprise.** Nothing a person pinned, left unread, or has open
  disappears. A card's **N more chats** count is unchanged by the cap.
- **Accessibility.** The rows are buttons with their count in the name
  ("12 older threads in <project>"). Loading and errors are announced through
  the sidebar's existing polite live region.

### 10. Server stream

- `shell_stream_with_events` decodes `OrchestrationSubscribeShellInput`. A
  decode failure ends the stream with `InvalidRequest`, as `subscribeThread`
  does.
- `HeldShell` gains the include set, the counts' fingerprints and the
  `revision(keys)` method. The kept set of each re-read is `kept(include) ∪
  held ids`.
- `listOlderThreads` is `register_unary` in `register_orchestration_rpc_inner`,
  next to `getArchivedShellSnapshot`.

### 11. Persistence

- **Server.** No migration. The cap's ordering uses `latest_user_message_at`
  and `updated_at` on `projection_threads`. If #225's server-time numbers show
  the scan matters, add an index on `(project_id, archived_at, deleted_at,
  latest_user_message_at, updated_at)` in the same PR.
- **Client.** The optional `revision` in `StoredShellSnapshot`. Older pages
  are never written.

### 12. Profiler, crash and trace coverage

- **The new RPC.** `listOlderThreads` is registered through
  `registry.register_unary` (`rpc/session.rs`), which times it. It's a local
  database read, so it is **not** added to `is_long_running`
  (`diagnostics/profiler/latency.rs:106`). A slow one is a real `rpc.slow`.
- **`subscribeShell`** stays a `register_stream`; its input changes, not its
  registration.
- **Auth.** `orchestration.listOlderThreads` joins the read scope next to
  `orchestration.subscribeShell` (`auth/scope.rs:56`) and the read mutability
  table tested in `production_maintenance.rs`.
- **Logs.** A malformed cursor or input logs `tracing::warn!` with the method
  and the reason only. A search query, thread titles and previews never reach
  logs or profiler records; at most the query's length.
- **Measurements.** The budget and traffic tests record counts, bytes and
  durations only.
- No new process, service, shutdown step, re-exec mode or removal path.

### 13. Budget

- `transfer_budget.rs` gets a capped shell entry on #225's fixture. Its budget
  replaces the shell's 40,000 / 255,000 bytes (deflated / decoded), set to the
  measured capped size plus 3-5%.
- The 3G reconnect row is re-measured with `scripts/measure-remote-latency.ts
  --link 3g`, before and after, in the PR.

## Interaction with the shell deltas

- The cap decides which threads enter `HeldShell`; deltas then work exactly as
  in #223. Sticky ids (§1) mean a delta never removes a thread for leaving the
  cap.
- Counts are project fields, so they travel as `project-upserted`.
- A fallback snapshot uses `kept ∪ held`, so it doesn't drop the client's rows.
- The revision is computed from the same `HeldShell` fingerprints after each
  tick, once per chunk.

## Interaction with #226

- **Separate streams, same patterns.** #226 windows a thread inside
  `subscribeThread`; this caps the list inside `subscribeShell`. Both resume
  with `{ revision, snapshotSequence }` and `unchanged`, under process-secret
  keys, and both are opt-in with optional inputs.
- **Opening a left-out thread.** The route works from the thread detail, which
  #226 windows. The thread's shell row arrives only if it is routed at the next
  shell subscription, pinned, or becomes live. Until then the card for a left-out
  ad-hoc thread shows in the project's older rows (§8) with the page copy.
- **Budgets.** #225's budget test gets both entries: a windowed thread open
  (#226) and a capped shell (this design). The cold-connect 3G row improves by
  both.
- **No shared code beyond the revision helper.** The keyed digest of
  `HeldThread::revision` moves to a small shared function used by both
  `HeldThread` and `HeldShell`.

## Tests that prove the acceptance criteria

### Rust, `apps/server/src/persistence/repositories.rs`

- `shell_rows_keep_live_card_included_and_recent_threads_of_150` — with 150
  finished threads, the rows hold the newest 25 plus 3 per project, every live,
  `default`, worktree and included thread, and the right `olderThreads` counts
  per project and per host.
- `shell_rows_read_no_sessions_or_messages_for_left_out_threads` — a
  statement-count probe (`sqlite3_trace` profile or a counting wrapper) shows
  per-thread reads only for kept threads.
- `shell_rows_order_recent_finished_by_last_user_message_then_update`.

### Rust, `apps/server/src/production/orchestration_rpc.rs`

- `shell_stream_without_cap_sends_every_thread` — `{}` gets today's full list
  and no `revision`.
- `shell_stream_cap_sends_kept_set_and_counts`.
- `shell_stream_upserts_a_left_out_thread_that_starts_a_turn`.
- `shell_stream_keeps_a_thread_pushed_out_of_the_cap` — no `thread-removed`.
- `shell_stream_fallback_snapshot_keeps_held_threads` — after `Lagged`.
- `shell_stream_resume_with_current_revision_answers_unchanged`.
- `shell_stream_resume_with_stale_revision_or_new_keys_sends_snapshot` — a
  missed change, a restart (fresh keys), an unknown revision, a newer sequence.
- `shell_stream_delta_chunks_carry_the_revision_on_their_last_item`.
- `list_older_threads_pages_every_left_out_thread_once_newest_first`.
- `list_older_threads_filters_by_project_and_host`.
- `list_older_threads_searches_titles_case_insensitively_with_escaped_wildcards`.
- `list_older_threads_rejects_a_malformed_cursor`.

### Rust, integration

- `apps/server/tests/production_orchestration_rpc.rs`:
  `shell_cap_and_resume_over_the_wire`.
- `apps/server/tests/transfer_budget.rs`: the capped shell entry.
- `apps/server/tests/production_maintenance.rs`: `listOlderThreads` is a read.

### Contracts (`vp run check:contracts`)

- Regenerated `rpc-wire` fixtures for `unchanged`, `listOlderThreads` and its
  failure; `rpcRustParity.test.ts` passes.
- `orchestration.test.ts`: `{}` decodes as a `subscribeShell` input; an old
  project shell without `olderThreads` decodes.

### Client runtime

- `shell-sync.test.ts`, `describe("shell cap and resume")`:
  - `subscribes with the cap, the include set and the cached revision`;
  - `applies a capped snapshot and keeps its counts`;
  - `takes unchanged as live without publishing`;
  - `clears the revision on an item without one and resubscribes without it`;
  - `ignores unchanged from a stale session`.
- `olderThreads.test.ts`: `pages and dedupes against the shell`,
  `clears pages when the session changes`, `a shell copy wins over a page copy`.
- `storage` test (`apps/web/src/connection/storage.test.ts`): a cached shell
  with and without `revision` loads.

### Web (happy-dom, from `apps/web`)

- `Sidebar.logic.test.ts`: `shows N older threads under a capped project`,
  `adds left-out panels to N more chats`, `keeps every workspace card`.
- `agentsSection.logic.test.ts`: `ends Done with Show older when threads were
  left out`, `pages older agents into Done`.
- `CommandPalette.logic.test.ts`: `appends older matches after local ones`,
  `cancels an older search when the query changes`.
- A component test for the older row's loading, error, offline and empty
  states.

### Desktop e2e and manual

- `apps/desktop/e2e/specs/main-window.e2e.ts` still passes with the cap on.
- Manual, on #225's 3G scenario: a cold connect, a reconnect answered
  `unchanged`, the older row, Done paging and search finding a left-out
  thread.

## Living docs (same PR)

- `docs/architecture/rpc-and-orchestration.md`: the kept set, sticky ids,
  counts, `listOlderThreads` and shell resume.
- `docs/architecture/connection-runtime.md`: a cached shell's revision and
  `unchanged`.
- `docs/user/workspace-ui.md`: the left panel's older rows, **N more chats**,
  Done paging and search.
- `docs/testing/` runbooks: reviewed; the manual 3G check goes in #225's
  slow-link scenario.

## Options considered

1. **Recommended: an opt-in kept set with sticky ids, per-project counts, a
   paged RPC and revision resume.** It reuses the delta path, `HeldShell`, the
   thread resume pattern and the route's detail fallback.
2. **The server tracks unread.** Rejected for this issue. Unread and pins are
   per device today; moving them to the server is a product change.
3. **A global newest-N only.** Rejected. A project with only old threads would
   show none of its own recent work.
4. **Per-project newest-N only.** Rejected. With six projects it keeps most of
   the 160 threads, so it barely cuts bytes.
5. **Remove a thread that leaves the cap with `thread-removed`.** Rejected. The
   client can't tell it from a deletion, and the row would vanish while the
   person looks at it.
6. **Resubscribe the shell when the routed thread changes.** Rejected. Every
   navigation would cost a round trip and often a snapshot. The route already
   works from the thread detail.
7. **Search in the client over pages.** Rejected. It would have to page every
   older thread first.
8. **A capability flag in `server.getConfig`.** Not needed. The client learns
   from the shell itself (`olderThreads`, `revision`) whether the server caps.

## Open questions for approval

1. `SHELL_RECENT_FINISHED` = 25 and `SHELL_RECENT_PER_PROJECT` = 3, to be
   checked against #225's fixture once the capped size is measured.
2. Whether a `workspace` thread without a worktree (an ad-hoc main-checkout
   row) should stay card-backing. This design caps it, because those rows are
   most of the finished list; keeping them would make the cap close to useless
   on #225's fixture.
3. Whether the search should also match the conversation preview. This design
   matches titles only, as the palette does today.

## Residual risk

- **Order differs between kept and paged rows.** The kept set is chosen by the
  default sort; with another sort order the older rows can interleave with the
  loaded ones once loaded.
- **Include set staleness.** A thread pinned or marked unread on another device
  is not in this client's include set; it shows only once paged or when it
  becomes live.
- **Sticky growth.** A long session that creates many threads keeps them all
  until the next subscription.
