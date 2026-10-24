# Reasoning as Thinking Rows

Status: Proposed 2026-10-24; awaiting approval. Issue #173. Builds on #167
(v0.11.0) and composes with #142 (Verbose chat) and the Worked-for fold (#154).

## Problem

Provider reasoning reaches the chat in two broken ways. Claude's thinking is
stored as assistant text. Codex reasoning summaries never reach the chat at
all. While Claude thinks for minutes, the timeline shows only "Waiting for 3m".
The two providers' reasoning should look the same, be collapsed by default,
fold with the rest of a finished turn's work, and show the latest thought while
a turn runs. It must not repeat #167, where streaming fragments became most of
the database.

## Current behavior (verified at 4e023ac5ff)

**Claude.**

- The runtime turns each `thinking_delta` into `content.delta` with
  `streamKind: "reasoning_text"` through `self.event`, which sets no item id
  (`apps/server/src/provider/claude/runtime.rs:2605-2617`, `:2866-2883`). Text
  deltas carry the message id (`:2618-2630`).
- The projector does not check `streamKind`. Every `content.delta` becomes
  `ThreadMessageAssistantDelta` (`apps/server/src/production/provider_runtime.rs:9042-9058`).
  With no item id, `assistant_message_id` falls back to the per-turn id
  `assistant:{thread}:turn:{turn}` (`:9326-9344`). The documented fallback for
  "providers whose protocol does not expose a message identity"
  (`docs/architecture/rpc-and-orchestration.md:2302-2305`) therefore catches
  Claude's thinking. It is persisted as a second assistant message of the turn:
  one `thread.message-sent` event per delta, plus an `||` upsert of the row
  (`apps/server/src/orchestration/engine.rs:4524-4540`, `:5957-5974`).
- This answers the #142 open question. The text is neither dropped nor merged
  into the reply: it is a separate assistant message. The consequences are:
  - When it carries text, it is replayed into the next provider's context as
    `[assistant] …`, because the handoff keeps non-empty `user | assistant`
    rows (`provider_runtime.rs:6562-6576`).
  - It is drawn as an assistant message row
    (`apps/web/src/components/chat/MessagesTimeline.tsx:1206-1220`). An empty
    settled row reads "(empty response)" (`:1208`).
  - When a turn has no text reply, the fold keeps its last assistant message
    visible (`apps/web/src/components/chat/MessagesTimeline.logic.ts:384`).
    By that rule, a tool-only or interrupted Claude turn shows "(empty
    response)" as its answer.
  - The legacy event reducer would re-point `latestTurn.assistantMessageId`
    and the turn's checkpoint at the thinking row
    (`packages/client-runtime/src/state/threadReducer.ts:321`, `:328`). The
    live snapshot path does not: the server orders the turn's pointer by
    creation time (`engine.rs:6003-6016`), and no local turn points at a
    turn-keyed message.
- Claude Code in `--print` mode usually sends no thinking text. The API
  defaults to `display: "omitted"` on Claude Opus 4.7, 4.8 and the 5.x models,
  and to `"summarized"` on Opus 4.6, Sonnet 4.6 and earlier models. In omitted
  mode each thinking block streams one `thinking_delta` with an empty string,
  then a `signature_delta`
  ([thinking docs](https://platform.claude.com/docs/en/build-with-claude/thinking#controlling-thinking-display)).
  BiBCode launches Claude with `--print --output-format stream-json --verbose`
  and no display flag (`provider_runtime.rs:14014-14060`).
- The installed CLI (2.1.310) accepts a `--thinking-display` flag that
  `--help` does not list. `claude --thinking-display bogus --version` exits 1
  with "Allowed choices are summarized, omitted, highlights". The same CLI
  ignores an option it does not know when `--version` is present:
  `claude --no-such-flag-xyz summarized --version` prints the version and
  exits 0. An exit-0 probe therefore cannot detect the flag.
- The Agent SDK maps the documented `thinking.display` option to that flag.
  The copy found on this machine, 0.3.284, pushes `--thinking-display` with
  the configured value (`sdk.mjs`;
  [SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)).
- The local store on this machine holds 17 turn-keyed assistant messages, all
  on `claudeAgent` sessions. They were built from 391 `thread.message-sent`
  events, 378 of them deltas. 343 deltas are empty, which is the
  omitted-display signature: one empty event per thinking block, 8 to 57 per
  message. Two of the messages have text. These counts were re-read on
  2026-10-24 from the main database file only, so events still in the WAL are
  not counted.
- Recent local Claude Code transcripts write one content block per assistant
  frame: 1,428 thinking frames, 1,087 of them empty, and no frame mixes block
  types. These counts were not re-checked in review.
- The protocol decodes only `tool_use` content blocks and
  `thinking | text | input_json` deltas
  (`apps/server/src/provider/claude/protocol.rs:47-62`, `:107-116`). A
  `content_block_start` of type `thinking`, every `signature_delta`, and every
  thinking-only `assistant` frame fail to decode. Each is dropped with a
  shape-only debug log (`runtime.rs:2044-2066`). A thinking block's
  `content_block_stop` matches no streaming tool and emits nothing (`:2646`).
  No signal for the end of a block reaches the server.
- Subagent frames share the root's handler. A child's `message_start` and its
  thinking and text deltas are suppressed before projection. A child's
  `content_block_start`, `input_json_delta` and `content_block_stop` are
  forwarded into the same `handle_stream_event`, with `parent_tool_use_id` set
  (`runtime.rs:3125-3165`, `:2069-2075`). Because a child's `message_start`
  never runs, `active_assistant_item_id` always names the root message
  (`:2563`). Tool blocks are matched by parent and index
  (`find_streaming_tool_mut`, `:2852-2865`). A child stop can carry the same
  index as an open root block.

**Codex.**

- The chat runtime has no case for `item/reasoning/*`. Those notifications
  reach the `unhandled` debug log (`apps/server/src/provider/codex/runtime.rs:2722`).
  `item/completed` emits events only for agent messages and command executions
  (`:2690-2716`, `:3805-3830`).
- Only the Activity tracker uses them. It writes a "Reasoning summary"
  commentary entry for the Subagents surface on `item/completed`
  (`apps/server/src/provider/codex/activity.rs:548`, `:1201-1240`). It treats
  the completed `summary[]` as authoritative over the deltas it saw: one
  streamed part followed by a two-part completion yields both parts
  (`apps/server/tests/provider_codex.rs:811-870`).
- `turn/start` sends no `summary`, so Codex's own `model_reasoning_summary`
  default applies (`apps/server/src/provider/codex/model.rs:726-752`). The
  protocol carries `item/reasoning/summaryTextDelta {itemId, delta,
  summaryIndex}`, `item/reasoning/textDelta {contentIndex}` (raw content), and
  `ThreadItem.reasoning {summary[], content[]}` (upstream
  `openai/codex` `970111f6cb`,
  `codex-rs/app-server-protocol/schema/typescript/v2/`).

**Settlement of streaming rows.**

- Turn completion settles the completed turn's streaming assistant rows
  (`provider_runtime.rs:9007`). The interrupt deadline settles its turn
  (`:8904`).
- EOF synthesizes a failed `turn.completed` only when the session still has an
  active turn (`:8695-8712`). With no active turn, nothing is settled.
- Restart reconciliation settles only the abandoned active turn
  (`:2537-2570`). Error reconciliation is thread-wide, but only for a session
  left in `error` with no active turn (`:2504-2533`).
- `stop_session` detaches the session, which aborts the pump
  (`close_publication_and_reap_event_task`, `:10091-10099`), and then deletes
  the runtime row (`:9592-9608`). It settles nothing. With the runtime row
  gone, startup reconciliation (`:2368`) never visits that thread again.

**Transport and client.**

- The thread stream does not send events. On each thread event it re-reads the
  thread from SQLite, at most every 100 ms, and sends the entries that changed
  (`apps/server/src/production/orchestration_rpc.rs:963`, `:1238-1280`). The
  client's patch decoder drops fields it does not know
  (`packages/client-runtime/src/state/threadPatch.ts:7-8`). A new literal in an
  existing field, such as a message role, fails decoding instead.
- The web has no reasoning row. `tone: "thinking"` marks `task.progress`
  (`apps/web/src/session-logic.ts:694-697`). That tone counts as tool-like
  (`:125-127`), so a work group drops it when it has no status
  (`MessagesTimeline.logic.ts:536`).
- `MAX_VISIBLE_WORK_LOG_ENTRIES = 1` (`MessagesTimeline.logic.ts:13`): a work
  group shows its newest entry and a "+N previous tool calls / log entries"
  toggle (`MessagesTimeline.tsx:1423-1424`).
- Scrolling has three modes: `following-end`, `anchoring-new-turn` and
  `free-scrolling` (`apps/web/src/components/chat/timelineScrollAnchoring.ts:1`).
  - Every send anchors the sent message and enters `anchoring-new-turn`
    (`apps/web/src/components/ChatView.tsx:5663`, `:6240`). While an anchor
    exists, `maintainScrollAtEnd` is off (`MessagesTimeline.tsx:526-536`). The
    only follow is then ChatView's frame effect. It runs when
    `timelineEntries` changes, and it reveals the end of the anchored turn
    once that turn overflows (`ChatView.tsx:4190-4253`).
  - `following-end` relies on `maintainScrollAtEnd` with `dataChange`,
    `itemLayout` and `layout`.
  - `free-scrolling` moves nothing.
- `MessagesTimeline.test.tsx` replaces `LegendList` with a mock (`:32`), so its
  tests cannot show real scrolling. The packaged desktop suite can. Its Claude
  shim already writes `stream_event` content deltas
  (`apps/desktop/e2e/support/test-project.ts:616`).
- The server setting **Assistant output** (`enableAssistantStreaming`,
  `packages/contracts/src/settings.ts:491`) is stored and shown, but no runtime
  code reads it. Nothing coalesces assistant deltas today.

## Goals

- One reasoning model for Claude thinking and Codex reasoning summaries.
  Reasoning is never stored or replayed as assistant text.
- A collapsed **Thinking** / **Thought** row per reasoning block, in order with
  tool calls. It expands to the full trace. In a finished turn it folds under
  "Worked for" and is never chosen as the answer.
- A live latest-thought line on the working row.
- Bounded persistence: no row for an empty thinking block, and rows that scale
  with time, not with token count.
- Scrolling stays stable while reasoning streams.
- No reasoning text in logs, traces, or profiler records.

## Non-goals

- Raw chain of thought. Claude returns at most a summary under any `display`
  value (thinking docs, Summarized thinking). Codex raw `content` and
  `item/reasoning/textDelta` are never projected.
- Subagent reasoning, OpenCode reasoning parts (dropped at
  `apps/server/src/provider/opencode/runtime.rs:2549-2555`), and Cursor
  reasoning. They can emit the same canonical events later.
- A "thinking…" state built from Claude's `thinking_tokens` progress frames
  when no text is sent. That needs an ephemeral channel BiBCode lacks.
- Backfilling turn-keyed thinking messages that earlier versions stored.
- Tool-row polish (#142), durations on Thinking rows, copy buttons.

## Alternatives

**Where reasoning lives.**

- **A. Keep the per-turn assistant message and restyle it on the client.**
  Rejected. The handoff, the turn pointer, the checkpoint rebind and the fold
  would all still treat it as text. All thinking blocks of a turn also merge
  into one blob with the first block's time, so the trace loses its order
  around tools.
- **B. A new message role `reasoning`.** Upstream PR 11784 stored reasoning as
  separate messages this way. Its reads negotiate reasoning support, older
  clients receive system messages in its place, and older servers cannot read
  a database that holds them. The approach reuses message streaming and
  settlement. But old BiBCode clients fail to decode the new role literal, so
  it needs the same negotiation and server-side filtering. It also stores
  reasoning rows in `projection_thread_messages`, where every message query
  must exclude them. An older BiBCode server opening the same store, which
  needs no migration, would then send them as messages to clients that cannot
  decode them.
- **C. Thread activities, one per block, updated in place.** Activities
  already fold as work. But each update re-sends the block's full text, so a
  long block writes quadratic bytes to the append-only log. Each update also
  costs the activity reducer's filter-and-sort (`threadReducer.ts:529-561`),
  the #167 cost.
- **D. A separate reasoning entity (recommended).** It gets its own commands,
  a `thread.reasoning-sent` event, a `projection_thread_reasoning` table and a
  `thread.reasoning` array. Old clients drop the unknown field, so no opt-in is
  needed. No message query can pick reasoning up. Deltas append like
  messages, with linear bytes. The cost is one migration, which is a one-way
  door (see Rollout).

**Coalescing (issue question 1).**

- **Per-delta, as assistant text.** This is about 10 characters a row for
  Claude summaries, so a 1.5 KB thought is about 150 permanent rows.
- **Only at block end.** This gives one row per block, but no live text.
- **Time-bounded flush in the event pump (recommended).** A thought shows
  within 250 ms. Each entry writes at most one streaming row per 250 ms window,
  and never more rows than it has deltas. The thread stream already limits the
  client to 10 updates a second, so a 250 ms flush costs the live view
  nothing.

**Visibility setting (issue question 2).**

- **A "Show thinking" switch.** It asks a question most users cannot answer,
  and the collapsed row already costs one line. UI.md says not to add
  preferences in place of design decisions. Rejected.
- **No setting (recommended).** Rows are collapsed by default, and raw
  reasoning is never shown.

**Claude display mode.**

- **Leave the CLI default.** From Opus 4.7 on, models send nothing by
  default, so the feature looks broken for Claude on them. Older models
  already send summaries.
- **Pass `--thinking-display summarized` when the CLI accepts it
  (recommended).** The cost is a slower first text token, which the thinking
  docs give as the benefit of omitted display.

## Decision

D, with the time-bounded pump flush, no setting, and summarized Claude
thinking gated on a probe.

### Canonical events (provider adapters)

- **Claude.**
  - `protocol.rs` gains `ContentBlock::{Thinking, RedactedThinking, Text}` and
    `ContentBlockDelta::SignatureDelta`, each ignoring its payload, plus
    `#[serde(other)]` unit variants on `ContentBlock`, `ContentBlockDelta` and
    `AssistantContent`. A new block type then no longer drops its frame.
  - Reasoning is handled for root frames only. A frame with
    `parent_tool_use_id` set never starts, extends or completes a reasoning
    entry.
  - A root `content_block_start` of type `thinking` records the block under
    `(active_assistant_item_id, index)`.
  - A non-empty root `thinking_delta` emits `content.delta`
    `{streamKind: "reasoning_text"}` with item id
    `{active_assistant_item_id}:{index}`. An empty one emits nothing.
  - A root `content_block_stop` for a recorded block emits `item.completed
    {itemType: "reasoning"}` with that item id and no text, then forgets the
    block. A child stop with the same index matches nothing. A
    `redacted_thinking` block emits nothing.
- **Codex.**
  - `item/reasoning/summaryTextDelta` emits `content.delta`
    `{streamKind: "reasoning_summary_text", summaryIndex}` with the `itemId`.
    When `summaryIndex` advances, the runtime prefixes the delta with a blank
    line.
  - `item/completed` of type `reasoning` emits `item.completed {itemType:
    "reasoning", text}`. `text` is `summary[]` joined with blank lines, the
    separator the deltas use. The completed summary is authoritative and
    replaces whatever streamed, so a stream that lost or cut parts ends with
    the full summary. An empty summary sends no text.
  - `item/reasoning/textDelta` and `content[]` stay unhandled.
- **Claude launch.**
  - `--thinking-display summarized` is added only when the CLI is known to
    accept it. The probe runs `claude --thinking-display <sentinel> --version`
    with an invalid sentinel value. The flag counts as supported only when the
    command exits nonzero and its output lists `summarized` among the allowed
    choices. A CLI without the flag ignores the option and exits 0, so it
    reads as unsupported.
  - A timeout or spawn failure is not cached, as for the existing probes.
    `run_claude_probe_command` treats every nonzero exit as an error
    (`provider_runtime.rs:13978-13980`), so this probe needs a variant that
    returns the exit status with the output.
  - The result is a `thinking_display` field on the cached `ClaudeProbeResult`
    (`:13921-13938`). It is probed once per executable identity and supervised
    like the other probes.
- **Output does not depend on the probe.** The probe decides only the launch
  flag. Any non-empty thinking delta becomes reasoning, whatever the flag,
  because older models send summaries by default. Only empty and redacted
  blocks produce no rows.

### Projection (supervisor event pump)

A `ReasoningCoalescer` lives in the pump task (`spawn_event_pump`,
`provider_runtime.rs:8359`). It keeps one buffer per open entry, keyed by
reasoning id, with the entry's length so far and the time its current buffer
started. Usually one entry is open.

- Drop an empty delta.
- Append a delta to its entry's buffer. The first byte of an empty buffer
  starts a 250 ms window.
- Flush an entry when its window ends, through a `sleep_until` branch on the
  earliest deadline, like the thread stream's
  (`orchestration_rpc.rs:1238-1240`).
- Flush early only for the entry's own `item.completed`, a `turn.completed`
  of the entry's turn, and pump exit. Other provider events never flush: tool
  starts, token usage, and other entries' deltas.
- Order on screen comes from `createdAt` (see Timestamps), not from write
  order. In a normal stream the entry's own completion also arrives before the
  next tool starts. A Claude block stops before the next block starts, and a
  Codex reasoning item completes before the next item. Write order therefore
  matches as well.

A flush dispatches `ThreadReasoningDelta`. A reasoning `item.completed` flushes
that entry, then dispatches `ThreadReasoningComplete` with the completion's
text, if any. It dispatches for an entry this pump opened, and for any
completion that carries text, which covers a Codex summary that streamed no
deltas. A completion without text for an unknown id dispatches nothing. A
reasoning `item.completed` never becomes an activity.

- **Reasoning id:** `reasoning:{thread}:item:{itemId}`, or
  `reasoning:{thread}:turn:{turn}` when there is no item id.
- **Timestamps:** the decider writes one time into both `createdAt` and
  `updatedAt` (`engine.rs:4538-4539`), and the projection keeps the first
  row's `created_at`. The first flush of an entry therefore carries the time
  its first delta was buffered, and later flushes carry their own flush time.
  Stamping every flush with the flush time would sort a thought after the tool
  call it preceded.
- **Size bound:** an entry stops growing at 32 KiB, cut at a UTF-8 boundary,
  and ends with `…`. Completion text is cut the same way, so a long completed
  summary cannot exceed the bound either. The pump tracks each open entry's
  length until the entry completes or the pump ends. Buffer memory is
  therefore at most 32 KiB per open entry.
- **Write bound:** an entry whose deltas span D writes at most
  ⌊D / 250 ms⌋ + 1 streaming rows, never more than its non-empty deltas, plus
  one completion row. Bursts, large deltas and interleaved events add no rows.

## Protocol, schema, and persistence

- **Contracts** (`packages/contracts/src/orchestration.ts`).
  - `OrchestrationReasoning { id, turnId: NullOr(TurnId), text, streaming,
    createdAt, updatedAt }`.
  - `OrchestrationThread.reasoning: Array(OrchestrationReasoning)`, decoding
    to `[]` when absent (`:487`).
  - The `thread.reasoning-sent` event payload, and the internal commands
    `thread.reasoning.delta` and `thread.reasoning.complete`. The completion
    carries an optional `text`.
  - Fixtures are regenerated, including the thread-stream lifecycle fixture.
- **Engine.**
  - The decider maps the two commands to `thread.reasoning-sent`. `streaming`
    is true for a delta and false for a completion, whose `text` is the
    completion text or `""`.
  - The projector follows the assistant-message rule (`engine.rs:5957-5974`),
    which the client reducer mirrors (`threadReducer.ts:264-283`). A streaming
    row appends. A completion with text replaces the text. A completion without
    text keeps it.
  - A completion without text only clears `is_streaming` on an existing
    streaming row and never creates one, as `UpdateExistingAssistantMessage`
    does (`engine.rs:5943-5955`). A completion with text upserts, so a Codex
    summary that streamed no deltas creates its row.
  - Repeating a completion leaves the text and streaming state unchanged,
    because the same text replaces the same text. Only `updated_at` moves, so
    one patch goes out.
  - Revert deletes the reasoning of reverted turns, as messages do (`:5902`).
    Thread purge and projection rebuild clear the table
    (`repositories.rs:1253`, `engine.rs:9216`, `:9593`, `:9700`).
  - `load_thread_snapshot` loads the rows (`engine.rs:7115-7160`), and
    `thread_snapshot_value` adds `reasoning`. Patches need no change: they
    diff every array field.
- **Migration.** A new migration adds the table `projection_thread_reasoning
  (reasoning_id PK, thread_id, turn_id, text, is_streaming, created_at,
  updated_at)`, indexed by `(thread_id, created_at)`, with a partial index on
  `thread_id WHERE is_streaming = 1` for the settlement sweeps. The table is
  listed in `CORE_TABLES` (`migrations.rs:29`, `:620`).
- **Settlement.** A text-less `ThreadReasoningComplete` settles a streaming
  reasoning row. Settlement has two scopes.
  - **Turn scope:** turn completion and the interrupt deadline settle that
    turn's streaming reasoning, next to its assistant rows
    (`provider_runtime.rs:9007`, `:8904`).
  - **Session scope:** when a session ends, every reasoning row still
    streaming on its thread is settled. This holds whatever the row's turn is,
    and whether or not a turn is active. Sessions are keyed by thread
    (`stop_session`, `:9592-9598`), so a streaming row on a thread without a
    live session is always orphaned. The sweep runs in three places:
    - the pump's EOF exit, after the final flush and before `settled_tx`,
      whether or not `active_turn_id` is set (`:8695-8766`);
    - the callers of `detach_session`, such as `stop_session`, right after the
      pump is reaped (`:10101-10119`), because an aborted pump cannot run its
      own cleanup;
    - once at startup, over the reasoning table itself and before any session
      starts. `stop_session` deletes the runtime row that
      `reconcile_abandoned_provider_sessions` (`:2368`) iterates, so that
      function would never reach the thread.
  - The assistant-message settlement paths do not change.
- **Unchanged:** messages, the handoff, the turn's final assistant pointer, and
  checkpoints. Reasoning never enters them.

## Client model (`packages/client-runtime`)

A new subpath `state/reasoning` holds pure functions shared by every client.
Each takes an `OrchestrationReasoning`:

- `reasoningLabel`: "Thinking" while streaming, "Thought" afterwards.
- `reasoningPreview`: the first non-empty line, with Markdown markers removed,
  whitespace collapsed, and at most 160 characters.
- `latestThoughtLine`: the first sentence of a trace, or its bold-only first
  line, which is how Codex summaries start. At most 200 characters. Upstream
  PR 16284 uses the same first-sentence rule.

`threadReducer` gains a `thread.reasoning-sent` case for the legacy event path.
It applies the message rule above. The live stream needs nothing new, because
the field arrives in snapshots and patches.

## UI behavior

**Placement.**

- ChatView adds each reasoning entry to the work log as a `WorkLogEntry` with a
  new tone, `reasoning`, its id, its turn and its `createdAt`. The entry sorts
  among tool calls by time.
- The entry carries its text, so a growing thought changes `timelineEntries`.
  ChatView's follow effect depends on that change.
- `workLogEntryIsToolLike` returns false for `reasoning`, so the neutral-status
  filter never hides it.
- Grouping is unchanged: the newest entry shows, and older ones sit behind the
  toggle. When the hidden entries include a thought, the toggle reads "+N
  previous steps".

**The Thinking row.**

- Collapsed, it uses the tool-row anatomy: a brain icon, then
  "Thought - <preview>", or "Thinking - <preview>" while streaming. It is one
  line at `text-xs` in solid `text-muted-foreground`, truncated. It shows no
  duration.
- The whole row is one button with a chevron, `aria-expanded`, the focus ring,
  and Enter/Space. Clicking the header again collapses it.
- Expanded, it renders the trace with `ChatMarkdown`, the assistant renderer,
  in a `max-h-64` scroller marked `data-text-surface` and `select-text`.
- An empty or redacted block has no row.

**Fold (#154).**

- Reasoning entries are turn entries that never become answers, so they hide
  inside "Worked for".
- A streaming reasoning entry keeps its turn unfolded, as a streaming message
  does (`MessagesTimeline.logic.ts:354`).
- A turn with no text reply no longer shows "(empty response)".

**Working row.**

- It reads "Waiting for 12s · <latest thought>". The timer comes first and
  never truncates. The thought is one muted line, truncated, so the row height
  stays fixed. It is static text.
- The thought is the running turn's newest reasoning entry. It is left out
  when that entry is already the newest visible work row, and once the answer
  has been delivered.
- The working-row comparison in `isRowUnchanged` includes the line.
- Upstream PR 16284 shows the thought as its own gray row above the running
  tool, wrapped to four lines. This design keeps it on the working row, as
  issue #173 asks, so the row height stays fixed.

**Verbose chat (#142).**

- Thinking rows follow the tool rows' expansion rule, whatever #142 makes it
  (`userToggle ?? verboseChat`). They take no separate state.
- With Verbose chat on, groups show every thought.

**Scrolling.**

- The row id is the reasoning id, so streaming re-measures a row and never
  remounts it.
- While a thought streams, each scroll mode behaves as follows.
  - `following-end`: `maintainScrollAtEnd` with `itemLayout` keeps the end in
    view.
  - `anchoring-new-turn`, the turn the user just sent: the row grows into the
    space reserved below the anchored message. Once the turn overflows,
    ChatView's follow effect reveals its end on each `timelineEntries` change,
    as it does for streaming assistant text.
  - `free-scrolling`: nothing moves. `maintainVisibleContentPosition` keeps the
    rows the reader is looking at in place.
- Toggling a row at the end keeps the end in view (upstream PR 17954).
  - In `following-end`, `maintainScrollAtEnd` does this.
  - In `anchoring-new-turn`, a toggle changes layout but not
    `timelineEntries`, so the follow effect does not see it. The Thinking
    row therefore reports its toggle to ChatView, which owns `isAtEndRef`.
    When the list was at the end, ChatView runs one reveal pass after the row
    re-measures, using the same `scrollDeltaToRevealEnd`
    (`timelineScrollAnchoring.ts`). The gate is a pure helper in that module.
- Toggling a row away from the end keeps its header in place, and the trace
  opens downward.
- The expanded trace's own scroller follows its newest text. It stops
  following once the reader scrolls up, and resumes within 4 px of the end
  (upstream PR 19334).

**UI.md review.** The design was checked against UI.md:

- No preference is added.
- Progress shows during long thinking.
- The preview shows what the thought is about.
- The whole row is the click target, and its chevron and hover mark it as
  clickable. The working-row line looks static and is static.
- It adds no new hue and nothing below `text-xs`, and its copy is plain.

## Trust boundaries

- Reasoning is untrusted provider output, like assistant text. It crosses the
  same boundaries: the provider stdout or JSON-RPC, the server, SQLite, and
  `orchestration.subscribeThread` under `orchestration:read`. It is rendered
  by the same Markdown renderer.
- It never enters these places:
  - the context handoff, thread titles, previews, or Activity commentary
    (`docs/architecture/activity-observation.md:528-531`, extended to chat);
  - the operational log, which records only metadata
    (`apps/server/src/production/operational_logs.rs:122-142`);
  - `tracing` fields, or profiler events and findings.
- The coalescer logs counts and ids only.
- No bridge command, network call, or credential is involved.

## Failure, cancellation, reconnect, concurrency

- **Interrupt:** the provider's `turn.completed` flushes the entry and settles
  it. The partial thought stays, labelled "Thought".
- **Provider exit, EOF, or crash:** the pump flushes every open entry. The
  session sweep then settles every streaming reasoning row on the thread, with
  or without an active turn.
- **Pump cancellation** (session teardown): the pump returns at once and loses
  at most 250 ms of buffered text per open entry. The caller that reaped it
  runs the session sweep.
- **Server restart or crash:** the startup sweep settles any row left
  streaming.
- **Reconnect:** the client resubscribes and gets `unchanged` or a snapshot
  with `reasoning`. A streaming entry continues through patches.
- **Late output:** reasoning tagged with an already settled turn (the #154 S2
  path) streams into its own entry. Its turn stays unfolded until the block's
  `item.completed`, or the end of its session, settles it.
- **Concurrency:** one pump per session runs sequentially, so the coalescer
  needs no locks. A restarted session gets a new pump with empty buffers.
  Item-based ids never join two sessions' blocks.
- **Duplicate delivery:** deltas behave as assistant deltas do today, with no
  deduplication. Fewer and larger rows make a duplicate rarer. A repeated
  completion leaves the text and streaming state unchanged, at the cost of one
  more event row and one patch.

## Performance on hot paths

- **Before:** one event row and one O(text) upsert per delta, about 10
  characters each for Claude summaries. With omitted display, one empty row per
  thinking block.
- **After:**
  - Zero rows for an omitted block.
  - A streamed block whose deltas span D writes at most ⌊D / 250 ms⌋ + 1
    streaming rows, capped by its delta count, plus one completion row. A
    1.5 KB thought streamed over 3 s writes at most 14 rows, against about 150.
  - A Codex completion that carries the summary rewrites the entry once, so a
    Codex entry stores its text about twice. Bytes stay linear.
- **Unchanged:** the 100 ms whole-thread reload and fingerprint while a thread
  streams. Reasoning adds to it, which is why entries stop at 32 KiB. A patch
  carries the changed entry's full text at most 10 times a second, as for
  assistant text.
- **Client:**
  - Deriving reasoning entries and the latest thought is O(n) once per thread
    update.
  - Stable rows re-render only the streaming row.
  - A collapsed row renders a preview string and parses no Markdown.
  - The scroll-follow effect reads layout only while its row is expanded and
    streaming.

## Profiler coverage

- **Child processes:** one more short probe, through a variant of the
  supervised `run_claude_probe_command` (`provider_runtime.rs:13941-13980`).
  No new long-lived process.
- **RPC methods:** none added. `orchestration.subscribeThread` carries one more
  field.
- **Worktree removal, binaries and re-exec, shutdown:** none apply. The
  coalescer lives and ends with the pump task.
- **Events, findings, logs:** no new profiler event or finding, so no
  `docs/skills/bibcode-profiler/references/` change. No reasoning text reaches
  records or logs; the verification step checks this with a sentinel string.
  `client.interaction`, `client.stall` and `rpc.bytes` measure the cost.

## Files to change

- **Server.**
  - `apps/server/src/provider/claude/{protocol,runtime}.rs`
  - `apps/server/src/provider/codex/runtime.rs`
  - `apps/server/src/production/provider_runtime.rs`: coalescer, projector
    branches, both settlement scopes, the startup sweep, the probe and the
    flag.
  - `apps/server/src/orchestration/engine.rs`
  - `apps/server/src/persistence/{migrations,repositories}.rs`
  - `apps/server/src/production/orchestration_rpc.rs`
  - `apps/server/tests/provider_{claude,codex}.rs`, plus fixtures under
    `apps/server/tests/fixtures/claude-provider/`.
- **Contracts.** `packages/contracts/src/orchestration.ts` and its fixtures.
- **Client runtime.**
  - `packages/client-runtime/src/state/reasoning.ts`, with its test, and the
    export in `package.json`.
  - `packages/client-runtime/src/state/threadReducer.ts`: the
    `thread.reasoning-sent` case, and the same turn filter on `reasoning` in
    the `thread.reverted` case (`:479`).
  - `packages/client-runtime/README.md`
- **Web.**
  - `apps/web/src/session-logic.ts`
  - `apps/web/src/components/ChatView.tsx`: work entries, and the reveal pass
    a Thinking-row toggle requests in anchored mode.
  - `apps/web/src/components/chat/timelineScrollAnchoring.ts`: the
    anchored-toggle gate, with its test.
  - `apps/web/src/components/chat/MessagesTimeline{.logic,}.ts(x)`, with their
    tests.
- **Desktop end-to-end.**
  - `apps/desktop/e2e/specs/chat-reasoning-rows.e2e.ts`
  - `apps/desktop/e2e/support/test-project.ts`: thinking frames in the Claude
    shim.
- **Docs.**
  - `docs/architecture/rpc-and-orchestration.md`: reasoning identity,
    persistence and settlement, and the corrected fallback sentence at
    `:2302-2305`.
  - `docs/architecture/activity-observation.md:528`
  - `docs/providers/claude.md`: the display flag and its probe.
  - `docs/providers/codex.md`
  - `docs/user/workspace-ui.md:555-565`: Thinking rows and the working row.
  - `docs/testing/cross-platform-validation.md`: the chat flow and the new
    end-to-end spec.
  - `CHANGELOG.md`

## Test plan (each fails on 4e023ac5ff first)

**Rust.**

- A Claude thinking-then-text fixture yields one assistant message and one
  reasoning entry. Today it yields two assistant messages.
- An omitted-display fixture yields no reasoning rows, no events, and no empty
  assistant message. It holds a `content_block_start` thinking frame, an empty
  delta, a `signature_delta` and a stop.
- Decoding: thinking, redacted-thinking and signature frames decode, and a
  thinking block's stop emits a reasoning `item.completed`.
- Subagent frames: a root thinking block at index 0 is interleaved with a
  child `content_block_start` (thinking) and a child `content_block_stop` at
  index 0, both carrying `parent_tool_use_id`. The root block keeps streaming
  and completes only at its own stop, as one entry with the full text.
- The coalescer, driven through the real pump with a scripted driver under
  paused Tokio time, as the existing pump tests do
  (`provider_runtime.rs:20053`):
  - 100 deltas of 10 bytes over 1 s give at most 5 streaming rows whose text
    is the concatenation.
  - A burst of four 4 KiB deltas within 100 ms gives one streaming row.
  - Deltas interleaved with tool starts, token-usage events and a second
    entry's deltas stay within each entry's bound. The thought still sorts
    before the tool that followed it.
  - An entry's completion, and its turn's `turn.completed`, flush first and
    then settle.
  - A completion without text or deltas writes nothing.
  - The 32 KiB bound holds for streamed text and for completion text.
- Codex:
  - Streamed summary parts 0 and 1 become one entry "A\n\nB".
  - Part 0 streamed, then a completion holding parts 0 and 1, ends as
    "A\n\nB". This is the activity fixture's shape (`provider_codex.rs:811`).
  - A summary that streamed no deltas is stored from its completion.
  - A repeated completion leaves the text and streaming state unchanged.
  - `textDelta` stores nothing.
- Settlement:
  - Interrupt and turn completion settle the turn's reasoning.
  - Late reasoning on a settled turn, then EOF with no active turn: the row
    settles.
  - `stop_session` during a thought: the row settles.
  - A row left streaming in the store, with no runtime row for its thread,
    settles at startup.
- The handoff excludes reasoning. Today Claude thinking that has text appears
  as `[assistant]`.
- Revert, thread purge and rebuild remove or rebuild reasoning.
- Probe:
  - A fake CLI that rejects the sentinel and lists `summarized` enables the
    flag.
  - A fake CLI that exits 0, ignoring the option, does not. Nor does one that
    rejects the sentinel without listing `summarized`.
  - A timeout is not cached.
- Output does not depend on the probe. With the probe reading unsupported, a
  fixture with non-empty thinking deltas still yields a reasoning entry, and
  an omitted-display fixture still yields none.
- The thread-stream lifecycle fixture, with reasoning, rebuilds through patches
  (`threadStreamParity.test.ts`).

**Contracts and client runtime.**

- A thread without `reasoning` decodes to `[]`.
- `reasoningPreview` and `latestThoughtLine`, including the bold heading and
  the cap.
- The reducer appends deltas, replaces the text on a completion with text,
  keeps it on a completion without, and settles the entry.

**Web logic** (`MessagesTimeline.logic.test.ts`).

- A streaming entry keeps its row id while its text grows.
- A settled turn hides reasoning in the fold, keeps the answer visible, and
  never picks reasoning as the answer.
- A tool-and-thought-only turn has no "(empty response)".
- Streaming reasoning keeps its turn unfolded.
- The neutral filter keeps reasoning, and the toggle reads "+N previous steps".
- The working row's `latestThought` is set, or null when the thought is the
  last visible row or the answer has been delivered.
- The anchored-toggle gate in `timelineScrollAnchoring.ts` asks for one reveal
  pass for a toggle at the end in anchored mode, and for none away from the
  end or in the other modes.

**Web component** (`MessagesTimeline.test.tsx`, with the mocked list).

- **Collapse and expand:** collapsed by default with "Thought - preview".
  Click and Enter expand it, and `aria-expanded` follows. A second click
  collapses it.
- **Folded turns:** expanding "Worked for" shows the Thought row.
- **Trace follow, with simulated geometry,** as upstream PR 19334 tested it:
  the expanded live trace stays at its end as text streams, pauses after the
  reader scrolls up, and resumes at the end.
- **Toggle report:** expanding or collapsing a Thinking row reports the
  toggle to ChatView once.

**Packaged desktop** (`chat-reasoning-rows.e2e.ts`, with the real list). The
Claude shim streams thinking, a tool call and text.

- Right after a send, in anchored mode, the Thinking row streams. The end of
  the turn stays visible once the turn overflows.
- With the thread reopened at the end, in `following-end`, streaming keeps the
  end visible.
- Expanding the Thought row at the end keeps the end visible. Expanding it
  after scrolling up keeps its header in place.
- After the turn, the Thought row folds under "Worked for", and expanding the
  fold shows it.

## Verification

- **Gates:**
  - focused `cargo test`, `cargo fmt --all --check`, and Clippy with
    `-D warnings`;
  - `vp check`, `vp run typecheck`, and `vp test` for contracts, client-runtime
    and web;
  - `check:contracts`;
  - the new desktop end-to-end spec on the packaged app.
- **Probe direction:** answered on 2.1.310. The CLI rejects an invalid value
  with a nonzero exit, and it ignores an unknown option under `--version` and
  exits 0. Hence the invalid-value probe. Confirm on an older CLI that lacks
  the flag that the probe reads unsupported.
- **Live Claude:** run a Claude CLI that accepts the flag with a thinking
  model.
  - Thought rows appear in order around tools, the working row shows the latest
    thought, and the turn folds.
  - Confirm the session really sends `display: "summarized"`, not omitted. The
    CLI's headless display logic was read only from minified code.
  - Compare SQLite `thread.reasoning-sent` rows with the delta count.
  - With the flag unsupported, an Opus 4.6 or Sonnet 4.6 session, which is
    summarized by default, still shows Thought rows. An Opus 4.7 or later
    session without the flag, which is omitted by default, shows no rows and
    no "(empty response)".
- **Live Codex:** summaries appear as Thought rows, and the full summary is
  kept when the deltas stop early. The Subagents "Reasoning summary" entry is
  unchanged.
- **Long thread:** profiler `client.interaction`, `client.stall` and `rpc.bytes`
  with and without reasoning. A sentinel phrase in a prompt-induced thought
  must not appear in server logs or the profiler JSONL.
- **Reviews:** UI.md and `vercel-react-best-practices` for the new rows. The
  `docs/testing/` runbooks are reviewed for the chat flow.

## Acceptance mapping (issue #173)

Issue #173 was read on 2026-10-24. Each acceptance item maps to this design:

- **Coalescing decided:** Alternatives (Coalescing) and Projection.
- **Visibility setting decided:** Alternatives (Visibility setting). There is
  no setting.
- **Tests for collapse and expand:** Web component tests.
- **Tests for reasoning inside folded turns:** Web logic tests, the component
  "Folded turns" test, and the desktop spec.
- **Tests for scroll-follow while reasoning streams:** the component trace
  follow test, the anchored-toggle gate test, and the desktop spec in anchored and
  `following-end` modes.
- **No reasoning text in profiler records or logs:** Trust boundaries, and the
  sentinel check under Verification.
- **UI.md and `vercel-react-best-practices` reviews recorded:** the UI.md
  review under UI behavior, and Reviews under Verification.
- **Profiler coverage line in the final report:** Profiler coverage.

The scope items map too. Client model holds the shared presentation model in
`packages/client-runtime`. UI behavior covers the collapsed row and its fold
under "Worked for", and the working row carries the live latest thought.

## Rollout

- **One release, no flag.**
- **The migration is a one-way door.** An older binary refuses the store,
  because its migration ledger is "not an exact prefix of this binary"
  (`migrations.rs:163`). The release notes must say so.
- **Mixed versions:**
  - A new client on an old server sees no Thinking rows and today's behavior.
  - An old client on a new server drops `reasoning`. Claude thinking stops
    appearing as assistant messages there too.
- **Earlier threads** keep their turn-keyed thinking messages, as #167 kept
  its rows. The changelog says so.

## Risks

- **The hidden CLI flag could change.** The probe then reads unsupported, and
  Claude falls back to the model's default: summaries on older models, nothing
  on newer ones. Nothing breaks. The SDK's own use of the flag makes a change
  unlikely.
- **Slower first text for Claude** with summarized display. This is product
  decision 4.
- **Snapshot cost grows with reasoning volume.** It is bounded per entry, and
  verification measures it. A follow-up could load older turns' traces on
  demand.
- **Conflicts with the parallel `MessagesTimeline` work** (#142, fold changes).
  The design touches only the work-entry path, the fold's streaming check, the
  working row and the anchored toggle pass. Land it after those changes and
  rebase. The "+N previous steps" label lives in `WorkGroupToggleTimelineRow`
  (`MessagesTimeline.tsx:1417-1452`), where #142 also removes the toggle in
  verbose mode. Whichever change lands second merges the label logic instead
  of overwriting it.
- **Duplicated Codex reasoning:** the Subagents surface keeps its own
  "Reasoning summary" entry, by design.

## Review

Codex critiqued this design on 2026-10-24. Each finding was checked against
the code before it was applied.

1. **Partial Codex deltas lose the completed summary.** Accepted. The
   Activity fixture (`provider_codex.rs:811`) streams one part and completes
   with two. Completion now carries the joined summary and replaces the
   streamed text. The rule is the existing assistant-message rule
   (`engine.rs:5957-5974`), and the 32 KiB cut applies to the completion text.
   Tests cover partial-then-full and repeated completion.
2. **Claude completion matched by index alone.** Accepted. Child
   `content_block_start` and `content_block_stop` reach the same handler with
   `parent_tool_use_id` set (`runtime.rs:3125-3165`). Reasoning now handles
   root frames only, keyed by root message and index. A regression test
   interleaves a child stop with a root thinking block.
3. **Late reasoning is never settled.** Accepted. EOF and restart
   reconciliation only act on an active turn (`provider_runtime.rs:8712`,
   `:2563`). `stop_session` settles nothing and deletes the runtime row, which
   Codex did not mention. Settlement now has a session scope: the EOF exit,
   after the pump is reaped, and a startup sweep over the reasoning table.
   Tests cover late output then EOF, teardown, and restart.
4. **The write bound contradicts the flush rules.** Accepted. The 4 KiB flush
   and the flush on every non-reasoning event are removed, and each entry gets
   its own 250 ms window. Order on screen already comes from the first
   delta's timestamp. The bound is now ⌊D / 250 ms⌋ + 1 streaming rows plus
   one completion. Tests drive the real pump with bursts and interleaved
   events.
5. **Scrolling assumes `maintainScrollAtEnd`.** Accepted. Every send sets an
   anchor, which turns `maintainScrollAtEnd` off (`MessagesTimeline.tsx:526`).
   The design now defines streaming and toggling in all three scroll modes,
   and an anchored toggle at the end requests one reveal pass. A packaged
   desktop spec on the real list replaces the claim that mocked-list tests
   prove scrolling.
6. **Unsupported flag does not mean no thinking.** Accepted. The thinking
   docs make summarized the default on Opus 4.6, Sonnet 4.6 and earlier.
   Probe tests and output tests are now separate, and live verification
   expects rows on those models without the flag. The unverified claim that
   Bedrock and Vertex ignore `display` is removed.
7. **Unverified acceptance, measurements, CLI and upstream claims.**
   Accepted. Issue #173 was read with `gh`, and its acceptance items are
   mapped above. The local store counts were re-read and corrected to 391
   events, 8 to 57 empty deltas per message, all on `claudeAgent`. The
   transcript counts remain unverified. The CLI check found that an unknown
   option exits 0 under `--version`, so the exit-0 probe could not work; it
   is replaced by an invalid-value probe. The SDK mapping was confirmed in
   0.3.284, the only copy found on this machine. Upstream PRs 11784, 16284,
   19334 and 17954 match their citations. Upstream PR 16284 places the latest
   thought differently, as noted under Working row.
