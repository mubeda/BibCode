# Agent activity status design (#187)

Status: proposed, awaiting approval. Written 2026-10-27 against `origin/develop`
at `27702287cc` and Orca `main` at `32a9b3b9` (2026-10-27).

The left panel's workspace-card glyph and the Agents view group each chat into
**Working**, **Pending Approval**, **Awaiting Input**, or **Done**. Both read one
function, `resolveThreadStatusPill` (`apps/web/src/components/Sidebar.logic.ts:481-519`),
and the Agents view maps its result to `AgentGroupId`
(`apps/web/src/components/sidebar/agentsSection.logic.ts:63-76`). This document
traces where that state comes from, lists the cases where it is wrong, compares
it with Orca, and picks a design.

`AgentGroupId` keeps its name and its values (`working | blocked | waiting | done`).
The #186 Inbox can build on it unchanged. What changes is which rows land in
each group (see "Effect on #186").

## 1. Current pipeline

### Chat agents (Codex, Claude, OpenCode, Cursor, Grok)

1. **Provider runtime → orchestration commands.** Each provider adapter emits
   canonical events. `project_provider_event`
   (`apps/server/src/production/provider_runtime.rs:10830ff`) turns them into
   engine commands:
   - `turn.started` sets the session to `running` (10874-10908).
   - `turn.completed` sets it to `ready`, or to `error` when the turn failed
     (10919-10955).
   - `request.opened`, `request.resolved`, `user-input.requested` and
     `user-input.resolved` become `approval.requested`, `approval.resolved`,
     `user-input.requested` and `user-input.resolved` activities (11480-11485).
2. **Engine projection (SQLite).** Projectors run in `PROJECTOR_NAMES` order
   (`apps/server/src/orchestration/engine.rs:54-64`). For the status, three of
   them matter:
   - `thread.session-set` upserts `projection_thread_sessions` (7019-7049).
   - Approval activities upsert `projection_pending_approvals` (7368-7451).
   - Every thread event then runs `rebuild_thread_derived_fields_tx`
     (7453-7537, called from 6694-6696). It writes `pending_approval_count`,
     `pending_user_input_count` and `updated_at`, where `updated_at` is the
     session's `updated_at` whenever a session exists.
3. **Shell wire shape.** `thread_shell_with_records`
   (`apps/server/src/production/orchestration_rpc.rs:2026-2083`) sends `session`
   (`status`, which is one of `idle | starting | running | ready | interrupted |
   stopped | error`, per `packages/contracts/src/orchestration.ts:414-422`),
   `latestTurn`, `hasPendingApprovals`, `hasPendingUserInput`,
   `hasActionableProposedPlan`, `unresolvedDelivery` and `conversationPreview`.
4. **Stream.** `orchestration.subscribeShell` (`shell_stream`, 1131-1167)
   subscribes to engine events before it loads the first snapshot. It then
   re-sends a **whole** shell snapshot at most every 500 ms
   (`SHELL_SNAPSHOT_COALESCE`, 1376) while events arrive, and when the broadcast
   lags. It sends no per-thread deltas, so a dropped or reordered event cannot
   leave a thread partly updated.
5. **Client.** `EnvironmentShellState`
   (`packages/client-runtime/src/state/shell.ts:202-246`) replaces its snapshot on
   every `snapshot` item. Each (re)subscription starts with one. It persists the
   snapshot, so an app restart first shows the cached copy as non-live and then
   swaps in the live one. `applyShellStreamEvent`
   (`packages/client-runtime/src/state/shellReducer.ts:14-48`) ignores items
   whose sequence is not newer than the current one.
6. **UI.** `buildAgentRows` (`agentsSection.logic.ts:168-220`) keeps only
   non-archived threads that have a session (`isAgentRowShell`, 122-124). It
   calls `resolveThreadStatusPill({ thread: shell })` and groups the result.
   The workspace cards call the same pill through `resolveWorkspaceCardStatus`
   (`Sidebar.logic.ts:570-604`).

The precedence is: approval, then input, then running (**Working**), then
starting (**Connecting**), then plan ready, then unseen completion, then none.
`resolveAgentGroup` sends every other label, and a missing pill, to `done`.

**Reconnect and restart are already sound at the transport level.** Every
subscription starts from a full server snapshot. On server restart,
`reconcile_abandoned_provider_session` (`provider_runtime.rs:2660-2723`) moves
sessions that were running to `error`. A provider whose event stream ends
mid-turn gets a synthesized failed `turn.completed` (10202-10262), which leaves
`running`. An interrupt the provider does not settle is retired after a
deadline (10410-10445). The failures below are in what the snapshot says, not
in how it travels.

### Terminal agents (AI Terminals)

An AI Terminal is a provider CLI (Codex, Claude, OpenCode, Cursor, Grok) that
BiBCode launches as a center-panel terminal of a host thread
(`apps/web/src/components/chat/providerTerminalActions.ts:165-200`). Its
`TerminalSummary` (`packages/contracts/src/terminal.ts:205-225`) carries
`status` (`starting | running | exited | error`), `hasRunningSubprocess`,
`label`, and the launch `command`, whose `activity.driverKind` names the
provider. It carries no agent turn state.

The terminal observers in `apps/server/src/provider_terminal/` feed only the
Activity (Subagents and Background Tasks) projection:

- Claude uses an authenticated loopback HTTP hook receiver
  (`provider_terminal/claude.rs:558`, `1322-1339`). It registers only
  `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse` and
  `PostToolUseFailure` (1352-1360).
- Codex connects to the TUI's app server over a Unix socket and reads
  `thread/list` and `thread/read` (`provider_terminal/codex.rs:1590ff`, 1699).
- OpenCode reads its server API.

All three run only when **AI Terminal** activity is enabled
(`enableTerminalAgentActivity`, `packages/contracts/src/settings.ts:536`, default
off), and only on Unix.

## 2. Failure cases

Every case below was **derived by reading the code**. None was observed in a
user session, and the issue does not yet list user-reported cases. Each repro is
the procedure that should show the case, to be confirmed in phase 2.

| #   | Case                                                                                           | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Repro (derived)                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Awaiting Input never appears.** A question reads as Working.                                 | `rebuild_thread_derived_fields_tx` hard-codes `pending_user_input_count = 0` (`engine.rs:7523`), and it runs on every thread event. Nothing else writes the count at runtime. So `hasPendingUserInput` is always false on the wire (`orchestration_rpc.rs:2076`). Migration 1660-1691 and the queued-head predicate (`apps/server/src/persistence/repositories.rs:3052-3061`) both compute it correctly from the latest activity per request. ChatView computes it on the client (`apps/web/src/session-logic.ts:453-494`), so the chat shows the question. | In a Claude chat, ask for a plan that uses `AskUserQuestion`, or ask Codex in plan mode to ask before it starts. The composer shows the question, while the Agents view and the card show **Working**, because the session stays `running`.                                                                                                     |
| F2  | **Pending Approval sticks after the turn ends.** It also outranks a later Working.             | A row in `projection_pending_approvals` leaves `pending` only through an `approval.resolved` activity or the user's `thread.approval-response-requested` (7368-7421). Nothing settles open requests when the turn completes or is interrupted, when its stream ends, when the interrupt deadline retires the session, or when restart reconciliation moves it to `error` (2660-2723 leaves approvals alone). The pill checks approvals first (`Sidebar.logic.ts:486`). F1's fix exposes the same gap for questions. | In a Codex chat in approval mode, wait for a command approval and press **Stop** instead of answering. Or quit BiBCode while the approval is open and relaunch. The card shows **Pending Approval** for good, including during the next running turn. Its queued follow-ups also stay held (`repositories.rs:3051`). |
| F3  | **The chat shows a dead approval card, and the card disagrees after a refused answer.**        | `derivePendingApprovals` (`session-logic.ts:347-397`) clears a request on `provider.approval.respond.failed` with a stale or unknown detail. The server projector ignores that kind, and nothing marks a request dead when its turn ends (F2).                                                                                                                                                                                                                                        | Follow F2, then open the chat. The approval card is still there, and answering it fails.                                                                                                                                                                                                                |
| F4  | **A silent agent stays Working indefinitely.**                                                 | No status has an expiry. `running` lasts until the provider reports `turn.completed` or its stream ends. A provider that is alive but wedged (a stalled network request, a hung MCP server, a deadlocked SDK child) reports neither. The shell has no evidence timestamp to age, because `updatedAt` is the session's own `updated_at` (`engine.rs:7510-7521`).                                                                                                                                                       | Point a chat at an MCP server that accepts a tool call and never answers. Watch the card show **Working** with no time limit. (A legitimate long tool, such as a 20-minute build, looks the same, which is why the threshold below is 30 minutes.)                                                                   |
| F5  | **A failed or crashed agent reads Done**, the same as a success.                               | `resolveThreadStatusPill` returns `null` for `error`, `interrupted` and `stopped`, and `resolveAgentGroup` sends `null` to `done`. The Agents row has no failed label: its footer falls back to `"Done"` (`AgentsRow.tsx:50`). The workspace card already shows **Failed** (`Sidebar.logic.ts:589-594`).                                                                                                                                                                                         | Kill a provider process mid-turn. The session becomes `error`, and the Agents view lists the thread under **Done** with the label "Done".                                                                                                                                                                       |
| F6  | **A disconnected environment keeps live claims.**                                              | While an environment is not live, rows show the cached snapshot. A cached Working row keeps pulsing (`AgentsRow.tsx:81-82`), and only the footer adds the environment's availability.                                                                                                                                                                                                                                                                                                | Start a long turn on a remote server, then stop its network. The row keeps pulsing **Working · unavailable** until the connection returns.                                                                                                                                                          |
| F7  | **Terminal agents never appear.**                                                              | Agent rows need `session !== null` (`agentsSection.logic.ts:122-124`), and the pill reads only chat fields. AI Terminal state never reaches the shell or `TerminalSummary`. The Claude observer does not register `UserPromptSubmit`, `Stop`, `PermissionRequest` or `Notification`.                                                                                                                                                                                             | Create a workspace and open only a **Claude Terminal** or **Codex Terminal** in it. The Agents view does not list it. In a thread that also has a chat, the card follows the chat and ignores the terminal.                                                                                                     |

Checked and found handled, so these are not bugs:

- A provider crash mid-turn leaves `running` through the synthesized failed
  turn (10202-10262).
- A server restart reconciles sessions that were running to `error`.
- A reconnect hydrates from a full snapshot.
- Stale or out-of-order shell items are dropped by sequence.

Out of scope:

- A thread whose first message is still being delivered has no session yet, so
  it is briefly absent from the Agents view. The session becomes `starting`
  within one launch.

## 3. Orca comparison (re-verified at `32a9b3b9`)

| Aspect              | Orca                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | BiBCode today                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                | One terminal pane, keyed `${tabId}:${leafId}`. Everything is a terminal agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | One chat thread, keyed by environment and thread. Terminals are keyed by `(threadId, terminalId)` but have no agent state.                                                                                                                                   |
| Source              | Managed hooks for each CLI POST JSON to a hook server in the main process. The server mints a random token per start (`src/main/agent-hooks/server/server-lifecycle.ts:55`) and answers 403 to a request without a matching `x-orca-agent-hook-token` header (:70). A test fixture binds `127.0.0.1` (`vendor-hook-delivery.test-fixture.ts:19`). We did not locate the production bind call. OSC 9999 and terminal-title heuristics are fallbacks. | Structured provider protocols are owned by the server: app-server JSON-RPC, the Claude SDK stream and the OpenCode API. A hook is never the status source for chats.                                                                                       |
| Vocabulary          | `working | blocked | waiting | done` (`src/shared/agent-status-types.ts:50`). Claude `PermissionRequest`, `Elicitation` and `AskUserQuestion` all map to **waiting**, `Stop` maps to done (`providers/claude-events.ts:129-139`), and Codex is the same (`providers/codex-state.ts:162-181`). Only some agents report `blocked` (`pi-family-events.ts:73`, `copilot-events.ts:41`).                                                                                                                                                                                                                                                                                                                                 | The same four ids, with other meanings: `blocked` is an approval and `waiting` is a question or a ready plan. These are not the same buckets as Orca's.                                                                                                                   |
| Fan-out             | IPC `agentStatus:set` and `agentStatus:clear`, and `agentStatus:getSnapshot` for hydration (`src/preload/api/agent-status-bridge.ts:16-26`). Paired web clients mirror snapshots of the host's session tabs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | An authenticated WebSocket shell stream sends a full snapshot on every subscription, then coalesced full snapshots.                                                                                                                                  |
| Ordering            | The renderer drops events older than the stored `updatedAt`, queues events for panes it does not know yet, and drops late events from a disconnected transport by watermark.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | A global sequence. The snapshot replaces client state, so nothing has to be queued.                                                                                                                                                                                   |
| Restart             | `last-status.json` is restored as `restoredUnconfirmed` and is never fresh (`agent-status-freshness.ts:57-58`). Hydrated rows are kept for up to 7 days (:7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The server reconciles abandoned sessions to `error`, and SQLite is the source of truth.                                                                                                                                                              |
| Staleness           | **The threshold is 30 minutes**, not the 30 seconds the issue says: `AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000` (`src/shared/agent-status-freshness.ts:4`). The 30 seconds is the `useNow(30_000)` re-render tick (`WorktreeCardAgents.tsx:192`). Age counts from local receipt for mirrored entries, so host clock skew cannot stretch it (`agent-status-freshness.ts:16-40`). A quiet entry decays to `unverifiable` while its PTY is live and to `idle` otherwise, labelled "No update in 34m" (`src/shared/agent-row-decay-state.ts:13-41`). | None.                                                                                                                                                                                                                                                 |

**What we take from Orca:**

- Status needs an expiry, but the expiry must not claim a completion. Orca's
  `unverifiable` label is honest; moving a row to Done silently would not be.
- Age counts from local receipt of new evidence, never from a remote clock.
- One shared re-render tick, and only when something can decay.

**What we do not take:**

- Hooks for chat agents. The server already holds an authoritative structured
  protocol for them.
- Title heuristics.
- A client-side pending queue. Full snapshots make it unnecessary.

## 4. Design

### D1. Awaiting Input from the projection (fixes F1)

`rebuild_thread_derived_fields_tx` computes `pending_user_input_count` with the
rule the queued-head predicate already uses: take the latest of
`user-input.requested`, `user-input.resolved` and
`provider.user-input.respond.failed` for each `requestId`. The request counts as
open when that latest activity is `requested`, or is a failure that is not
stale. The predicate moves into one shared SQL fragment in the engine, and the
queue predicate (`repositories.rs:3052-3061`) uses the same fragment, so the two
cannot drift apart. The latest-per-request window query is indexed by
`thread_id`. Its cost is one more query per thread event, next to the existing
`COUNT(*)` on approvals.

### D2. BiBCode expires open requests when a session leaves `running` (fixes F2, F3)

When the engine commits a `thread.session-set` whose new status is not
`running` or `starting`, the same transaction appends one activity for each
request that is still open on that thread. The precedent is the `hold` step that
`ThreadSessionSet` already gets (`engine.rs:5301-5310`). The activity is
`approval.expired` for an approval and `user-input.expired` for a question,
with payload `{ requestId, reason: "session-ended", sessionStatus }` and tone
`info`.

The appended activities then reach every consumer through the normal paths:

- The approvals projector marks the row `expired`. Unlike `resolved`, a later
  `approval.requested` for the same id can reopen it.
- D1's user-input rule treats `expired` as closing the request.
- `derivePendingApprovals` and `derivePendingUserInputs` close a request on
  `*.expired`, so the chat card disappears with the sidebar state.
- `request_is_recorded` (`repositories.rs:955-972`) is the deduplication for
  OpenCode's recovered asks (`provider_runtime.rs:10843-10858`). It returns
  false when a request's latest record is an expiry. An ask that OpenCode lists
  again after a restart or a helper crash therefore reappears and reopens the
  request.

This works because no supported provider can finish, interrupt or lose a turn
while it is still waiting on an answer BiBCode has to deliver. Every session
transition out of `running` already happens on exactly those paths: completion,
interrupt, stream end, the interrupt deadline, compaction retirement, restart
reconciliation and workspace loss. One seam covers all seven, with no hunks in
`provider_runtime.rs`.

| Alternative                                                           | Why rejected                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Count a pending request in the shell only while the session is `running`. | Fixes only the card. The chat card stays stale (F3), and queued follow-ups stay held. It also hides an OpenCode ask recovered while the session reads `ready`.                                                                                       |
| Settle in the projector only, with no activity.                       | The chat derives its state from activities, so the chat and the card would disagree.                                                                                                                                                           |
| Settle at each exit path in the provider runtime.                     | Seven call sites to keep in step, in code another agent owns (`provider_runtime.rs`), and the next exit path added would regress silently.                                                                       |

**Behavior change.** Queued follow-ups that an orphaned approval held now
deliver automatically once the session is `ready`, because the queue predicate
reads `projection_pending_approvals`. Nobody is waiting on that approval any
more, so delivering is correct. The design names it because the change is
visible to users.

### D3. Evidence age and decay of Working (fixes F4, F6)

- **Server.** A new `projection_threads.last_activity_at` column, added by a
  migration, holds the `occurred_at` of the latest event on the thread
  aggregate. `rebuild_thread_derived_fields_tx` writes it from the triggering
  event; the other rebuild callers keep the stored value. The shell gains
  `lastActivityAt: Schema.optional(IsoDateTime)`. Older servers omit it, and
  their rows never decay.
- **Client.** A small pure module (`agentStatusFreshness.ts`, next to
  `agentsSection.logic.ts`) keeps, per thread key, the local time when it first
  saw each `lastActivityAt` value. This is Orca's mirrored receipt rule. A
  repeated value does not refresh the stamp, a new value resets it, and keys
  that left the shell are pruned. Age is therefore measured on the client's own
  clock, and server skew cannot stretch or shrink it.
- **Rule.** A Working or Connecting pill whose evidence is older than
  `AGENT_STATUS_STALE_AFTER_MS = 30 minutes` (Orca's threshold) becomes the pill
  `No update` (not pulsing, neutral tone). The tooltip and footer read
  "No update in 34m". The row moves to `done`, and the workspace card glyph
  becomes an idle-kind `WORKSPACE_CARD_STATUS.stale`. Approval and question
  rows never decay: the server holds them, and D2 ends them.
- **Tick.** The existing shared `useMinuteClock` drives the decay. Its
  one-minute resolution is enough for a 30-minute threshold. Only rows in the
  Working group subscribe, through the row components or a memoized selector,
  so idle lists pay no timer cost. That matches the `RelativeAge` rule.
- **Offline environments (F6).** Their evidence stops changing, so their Working
  rows decay by the same rule. Rows of a non-live environment also stop
  pulsing.
- **Restart.** After an app restart the first sight stamps "now", the same as
  Orca's `restoredUnconfirmed`. A hung agent can therefore read Working for up to
  30 minutes after launch. We accept that rather than trust a remote clock.

| Alternative                                             | Why rejected                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep stale rows in Working with a badge.                 | Fails the acceptance criterion that silent agents leave Working. #186 would count them as Working.                                                                                                                                                                |
| Move stale rows to `waiting` ("needs attention").        | The group label would read **Awaiting Input** for something that is not a question. That mislabel is the class of bug this issue is about.                                                                                                                |
| Add a fifth `AgentGroupId`, such as `stale`.             | Changes the shape #186 is building on. Deferred: the coordinator can still choose it, since moving these rows out of `done` later is a one-function change.                                                                                       |
| Age as client now minus the server's `lastActivityAt`.   | Server clock skew breaks it. A remote server that is 40 minutes behind would mark every agent stale.                                                                                                                                           |
| A server-side watchdog that flips `running`.             | It would invent a provider state the server cannot know, since a legitimate 40-minute tool call looks the same. Decay is a display claim, not a session transition.                                                                                       |

### D4. Failed is distinct inside Done (fixes F5)

`buildAgentRows` gives a thread with no live pill and `session.status === "error"`
the pill `Failed`, in the destructive tone. That matches the workspace card's
existing failed rule. The row stays in `done`. `interrupted` and `stopped` stay
plain Done, because a person or BiBCode's own settlement ended them.

### D5. Terminal agents through the existing observers (F7). Separable, needs approval

We reuse the observers that already exist and build no new hook infrastructure.

**Sources, per provider:**

- **Claude.** Add `UserPromptSubmit`, `Stop`, `StopFailure`, `PermissionRequest`,
  `Notification` and `SessionEnd` to the settings that
  `provider_terminal/claude.rs:1352-1360` already injects. Map them as follows:
  - `UserPromptSubmit`, and `PreToolUse`/`PostToolUse` other than
    `AskUserQuestion`, map to **working**.
  - `PermissionRequest` maps to **blocked**.
  - `PreToolUse` for `AskUserQuestion`, and `Elicitation`, map to **waiting**.
  - `Stop` maps to **done**, and `StopFailure` to **done** with failed.
  - `SessionEnd` clears the status.
- **Codex.** Map the root thread's status, already read by
  `provider_terminal/codex.rs`, as follows:
  - `active` with `waitingOnApproval` maps to **blocked**.
  - `active` with `waitingOnUserInput` maps to **waiting**.
  - `active` with no flags maps to **working**.
  - `idle` maps to **done**, and `systemError` to **done** with failed.
- **OpenCode.** Map session busy to **working**, idle to **done**, a permission
  ask to **blocked**, and a question to **waiting**.

**Publication.** `TerminalSummary` gains an optional
`agentStatus: { state, failed, observedAt }`, published through the terminal
manager's existing metadata upsert. That stream already starts with a snapshot,
so reconnect hydration comes for free, and the thread shell does not need a
wake. Clients key the status by `(environment, threadId, terminalId)`, which is
Orca's per-pane keying.

**Web.**

- A card or row takes the most urgent of its chat pill and the statuses of its
  AI terminals. The order is blocked, then waiting, then working, then done.
- A thread with no chat session but an AI terminal that has a status becomes a
  row.
- D3 decay applies with the local receipt of `observedAt`.

**Trust boundary.** The process and network boundary stays the one the Claude
observer already enforces:

- Its listener is bound to `Ipv4Addr::LOCALHOST` on an ephemeral port.
- Each generation has its own bearer token, compared in constant time.
- Its settings live in a directory owned by that generation.
- `validate_claude_hook` bounds every field.

Hook payloads come from the agent, so they are untrusted. Only the event name
and the enum derived from it are kept, and no prompt or message text is stored
or sent to the profiler. Codex keeps its Unix-socket helper, which is owned and
supervised per generation. Status reaches clients only over the existing
authenticated terminal metadata WebSocket, and no listener is exposed beyond
loopback on the host that runs the PTY. That host is the remote server for a
remote environment.

**Decisions for the coordinator:**

1. Should status hooks run whenever an AI Terminal is launched, rather than only
   when the default-off AI Terminal activity setting is on? Injecting hooks
   changes what the CLI runs.
2. Windows has no observer, so terminal rows there have no status. This must be
   documented in the runbooks.
3. This part touches `packages/contracts/src/terminal.ts` and
   `provider_terminal/*`, neither of which is on the owned-files list.

**Recommendation:** ship D1 to D4 first, then D5 as a follow-up commit series
once these decisions are made.

### Effect on #186

`AgentGroupId` keeps its name and values. Three things change in which rows
land in each group:

- `waiting` (Awaiting Input) starts receiving question rows. It never could
  before, because of F1.
- `blocked` loses orphaned approvals.
- `done` gains stale Working rows (`No update`) and Failed rows. If the Inbox
  wants them under **Needs Attention**, it can read the pill label. The group
  does not need to change.

## 5. Tests

| Behavior                                                                                 | Test seam (extend the existing tests)                                                                                                                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1: requested gives 1, resolved gives 0, a non-stale respond failure stays 1, a stale one gives 0, expired gives 0 | Engine projection tests next to the approval-projection tests (`engine.rs` ~12650-12725), through `dispatch` → shell JSON                                  |
| D2: leaving `running` (`ready`, `error`, `interrupted`, restart reconcile) appends expiries in the same commit; `running` and `starting` do not; a repeat `ready` adds no duplicate; `approval.requested` after expiry reopens | Engine dispatch tests. Restart path: `reconcile_abandoned_provider_session` test module (`provider_runtime.rs` `workspace_loss_tests`), assertions only |
| D2: an OpenCode recovered ask reappears after an expiry                                  | `request_is_recorded` repository test (`apps/server/tests/repositories.rs`)                                                                                |
| D2: the chat closes a request on `*.expired` and reopens it on a later request           | `apps/web/src/session-logic.test.ts`                                                                                                                      |
| Hydration: a new `subscribeShell` after the change carries `hasPendingUserInput` and `lastActivityAt` | `shell_stream_coalesces_event_bursts` neighbourhood (`orchestration_rpc.rs:7348`); client `shell-sync.test.ts` (snapshot replaces cached flags)            |
| D3: first-sight stamp, a repeat value does not extend, a new value resets, the 30-minute boundary, approval and question never decay, skew immunity (server time far off) | Pure tests in `agentStatusFreshness.test.ts` and `Sidebar.logic.test.ts` with injected `now` and receipt map                                               |
| Mapping table: every pill to a group, including `No update` and `Failed` to `done` and `Plan Ready` to `waiting`; non-live rows do not pulse | `agentsSection.logic.test.ts`; a new `AgentsRow` component test                                                                                                 |
| Complete caller: `AgentsPage` and `AgentsNavRow` group a thread whose shell has an open question under Awaiting Input, and a decayed one under Done | `AgentsPage` component test (`vp test run --project unit`)                                                                                                 |

## 6. Documentation

- `docs/architecture/rpc-and-orchestration.md`: the `lastActivityAt` shell field,
  the expiry activities, and the queue behavior change.
- `docs/user/workspace-ui.md`: Awaiting Input, the `No update` and `Failed`
  labels, and decay.
- `docs/testing/cross-platform-validation.md`: add the Agents view status checks,
  covering a question, Stop during an approval, and a relaunch during an
  approval.
- For D5 only: `docs/architecture/activity-observation.md` and
  `docs/providers/claude.md` for the hook list.

## 7. Profiler, crash and trace coverage

D1 to D4 add no process, RPC, worktree-removal path, binary mode or service.
Expiries are ordinary orchestration events. None applies. D5 adds hook events
inside an existing supervised observer and no RPC. Its status must not record
prompt text, which is already the observer's rule.
