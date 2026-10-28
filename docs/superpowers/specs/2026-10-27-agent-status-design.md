# Agent activity status design (#187)

Status: revision 2, awaiting approval. Written 2026-10-27 against `origin/develop`
at `27702287cc` and Orca `main` at `32a9b3b9` (2026-10-27).

The left panel's workspace-card glyph and the Agents view group each chat into
**Working**, **Pending Approval**, **Awaiting Input**, or **Done**. Both read one
function, `resolveThreadStatusPill` (`apps/web/src/components/Sidebar.logic.ts:481-519`),
and the Agents view maps its result to `AgentGroupId`
(`apps/web/src/components/sidebar/agentsSection.logic.ts:63-76`). This document
traces where that state comes from, lists the cases where it is wrong, compares
it with Orca, and picks a design.

Revision 2 (same day) folds in the lead's decisions and review findings. The
shared agent-row contract with #186 (`scratchpad/batch3/agent-row-contract.md`,
set by the lead) fixes the following:

- `AgentGroupId` is `working | blocked | waiting | done | unknown`.
- An `unknown` row carries one reason: `stale`, `unavailable` or `offline`.
- Rows are per agent, and a row has an optional `terminalId`.
- `STATUS_TONES` is exported, so #186 can use the same colors.
- `AgentsRow.tsx` takes an optional jump action.
- One hook file owns the freshness clock.

See §4 and "Effect on #186".

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
| Vocabulary          | working, blocked, waiting, done (`src/shared/agent-status-types.ts:50`). Claude `PermissionRequest`, `Elicitation` and `AskUserQuestion` all map to **waiting**, `Stop` maps to done (`providers/claude-events.ts:129-139`), and Codex is the same (`providers/codex-state.ts:162-181`). Only some agents report `blocked` (`pi-family-events.ts:73`, `copilot-events.ts:41`).                                                                                                                                                                                                                                                                                                                                 | The same four ids, with other meanings: `blocked` is an approval and `waiting` is a question or a ready plan. These are not the same buckets as Orca's.                                                                                                                   |
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

The user-input count gets the same treatment as approvals. It is maintained
only when a request's state changes, never on every thread event, because
streamed assistant deltas dispatch thread events too.

- `rebuild_thread_derived_fields_tx` stops writing `pending_user_input_count`,
  so the stored value stands.
- The activities projector recomputes the count for one thread when it applies
  any of these:
  - `user-input.requested`
  - `user-input.resolved`
  - `user-input.expired` (D2)
  - `provider.user-input.respond.failed`

The recount uses the rule the queued-head predicate already uses. Take the latest
of those activities for each `requestId`. The request is open when that latest
activity is `requested`, or a respond failure whose detail is not stale or
unknown.

That rule becomes one shared SQL constant in the persistence layer. The queue
predicate (`repositories.rs:3052-3061`) uses the same constant, so the two rules
cannot drift apart.

### D2. Settle requests the provider no longer holds (fixes F2, F3)

Two settlements are added. Both are written as activities, so the chat, the
card and the queue read the same facts.

**(a) Stale answers while the session still runs.** Today the server and the
client disagree about a stale answer:

- `derivePendingApprovals` (`session-logic.ts:383-390`) closes an approval on a
  `provider.approval.respond.failed` whose detail says the request is stale or
  unknown.
- Migration 1604-1640 already applies the same rule to stored rows.
- The runtime approval projector (`engine.rs:7384-7391`) ignores that kind, so
  the shell keeps saying Pending Approval.

The fix: the projector handles `provider.approval.respond.failed` with that
detail, using the migration's detail rule. It marks the row `resolved` with
decision `stale`. User inputs already follow this rule through D1.

> **Revised after review.** Expiry no longer happens at `ready`: a provider may
> end its turn while its ask still waits, and the queue holds behind it exactly
> as before. A request expires only on a real transition, read in the same
> transaction, of a `running` or `starting` session to `error`, `interrupted`,
> `stopped` or `idle`, or on a turn interrupt; never at a launch's `ready` or on
> a settled session settling again. A resumed OpenCode session launches
> `starting` and turns `ready` on `session.recovery-settled`, after its stream
> has shown the asks it kept. Startup expires, as events, requests left open on
> threads whose session is not live, and migration 057 backfills
> `last_activity_at` from the latest provider event. The text below records the
> first design; the revision supersedes its `ready` case and its correction.

**(b) Expiry when a session leaves `running`.** When the engine commits a
`thread.session-set` whose new status is not `running` or `starting`, the same
transaction appends an expiry activity for each request still open on that
thread:

- `approval.expired` for an approval, and `user-input.expired` for a question.
- Payload `{ requestId, reason: "session-ended", sessionStatus }`, tone `info`.

The precedent is the `hold` step that `ThreadSessionSet` already gets
(`engine.rs:5301-5310`).

The activity then reaches every consumer through its normal path:

- **Approvals projector:** marks the row `expired`. Unlike `resolved`, a later
  `approval.requested` with the same id reopens it.
- **D1:** treats `expired` as closing the request.
- **Chat:** `derivePendingApprovals` and `derivePendingUserInputs` close the
  request on `*.expired` and reopen it on a later request.
- **OpenCode recovery:** `request_is_recorded` (`repositories.rs:955-972`)
  returns false when a request's latest record is an expiry. OpenCode's
  recovered asks (`provider_runtime.rs:10843-10858`) therefore reappear.

**Why this is safe.** No supported provider can complete, interrupt or lose a
turn while it is still waiting for an answer BiBCode has to deliver. The
session leaves `running` only on exactly those paths:

- completion
- interrupt
- stream end
- interrupt deadline
- compaction retirement
- restart reconciliation
- workspace loss

One seam covers all of them, and `provider_runtime.rs` needs no production
changes.

| Alternative                                                    | Why rejected                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Count a request in the shell only while the session is `running`. | Only the card changes. The chat card stays stale (F3) and the queue stays held. It also hides an OpenCode ask recovered while the session reads `ready`. |
| Settle in the projector without an activity.                   | The chat derives its state from activities, so the chat and the card would disagree.                                                                                         |
| Settle at each exit path in the provider runtime.              | Seven call sites in code another agent owns. The next exit path added would regress without anyone noticing.                                                    |

**Queue behavior, compared with today's drain.** A queued message auto-delivers
only when all of these hold (`repositories.rs:3036-3075`):

- the session is `ready`;
- the message is not `held`;
- no approval or question is open;
- no turn is running.

Today an approval the user answers is marked `resolved` immediately
(`thread.approval-response-requested`). The queue then drains when that turn
completes `ready`.

With D2, a request is expired at the session transition that ends its turn:

- **Turn completes `ready`.** The queue drains exactly as it does after an
  answered approval.
- **Interrupt, `error`, `interrupted`, restart reconciliation.** These already
  hold the queue in the same commit (`ThreadTurnInterrupt` and the
  error/interrupted `hold`, `engine.rs:5295-5310`). The follow-ups stay queued
  until the user releases them.

The drain after a turn ends matches today's drain after an answered approval.

**Correction found in implementation, then withdrawn.** The first
implementation expired a request when its turn ended `ready`, which sent a
queued follow-up past it. Review restored today's behavior: the request stays
open and holds the queue (`no_promotion_while_approval_or_user_input_pending`),
and only the transitions in the revision above expire it
(`an_interrupted_or_failed_turn_expires_its_request_and_holds_the_queue`,
`a_relaunch_with_a_recovered_ask_does_not_send_the_follow_up`).
A request the provider raises while the session is `ready`, as OpenCode does
for a recovered ask, still holds the queue.

### D3. One freshness clock and the `unknown` group (fixes F4, F6)

**Evidence (server).**

- A migration adds `projection_threads.last_activity_at`. It is set only from
  provider progress, and title, mode, archive and other client updates never
  touch it. Provider progress means either of:
  - an event the engine attributes to the provider (`infer_actor_kind` returns
    `provider`, `engine.rs:7593-7606`);
  - a `thread.session-set` to `running` or `starting`.
- The shell gains `lastActivityAt: Schema.optional(IsoDateTime)`.
- Terminal agents carry their own evidence time (D5).

**Age, measured skew-free on the client.**

- The age of an evidence value is taken once, from a live snapshot:
  `serverAge = snapshot.updatedAt − lastActivityAt`. Both are server-clock
  times, and `snapshot.updatedAt` is the server's time when it built the
  snapshot (`orchestration_rpc.rs:1545`).
- The client stores `evidenceAt = localNow − serverAge`. Later snapshots with
  the same evidence value keep that stored time; a new value replaces it.
- An app launch therefore does not grant 30 fresh minutes. An agent that has
  been silent for 40 minutes reads stale as soon as the first live snapshot
  arrives.
- Terminal statuses use the same rule. Their `ageMs` is computed when the
  summary is serialized (D5).

**Clock owner.** One hook file, `apps/web/src/hooks/useAgentFreshness.ts`, owns
the receipt map and the clock:

- The map is keyed by row key and pruned to the rows that are present.
- The clock is the existing shared `useMinuteClock`. Only callers with a decayable
  row subscribe.
- The hook exports `useAgentRows(...)`, which is used by the memoized
  `AgentsPage` rows and groups and by `AgentsNavRow`.
- It also exports `useWorkspaceCardStatus(thread, lastVisitedAt)`. The card
  status lines in `Sidebar.tsx` (873, 1411) change by one line each, from
  `resolveWorkspaceCardStatus(...)` to the hook. At line 1411 the conditional
  moves inside the hook's argument, because hooks cannot run conditionally.
- The pure resolvers (`resolveThreadStatusPill`, `resolveAgentGroup`,
  `resolveWorkspaceCardStatus`) take `{ now, evidenceAt, environmentLive }` as
  data and stay pure.

**Rules (contract item 1).**

| Condition                                                                                                                                          | Group     | Reason        | Label                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------- | ---------------------------------------- |
| Environment not `live` (cached snapshot at launch, disconnected, synchronizing)                                                                   | `unknown` | `offline`     | "Offline", or "Connecting" while starting |
| No status observer for this platform and provider (§D5 matrix)                                                                                    | `unknown` | `unavailable` | "Status unavailable"                     |
| Working or Connecting with evidence older than `AGENT_STATUS_STALE_AFTER_MS = 30 min`                                                              | `unknown` | `stale`       | "No update in 34m"                       |
| Open approval                                                                                                                                      | `blocked` | —             | Pending Approval (never decays)          |
| Open question, or Plan Ready                                                                                                                       | `waiting` | —             | Awaiting Input or Plan Ready (never decays) |
| Running or starting with fresh evidence                                                                                                            | `working` | —             | Working or Connecting                    |
| Session `error` (D4)                                                                                                                               | `done`    | —             | Failed                                   |
| Otherwise                                                                                                                                          | `done`    | —             | Done                                     |

`offline` outranks every other state, because a cached state is not current
evidence. Rows in `unknown` never pulse. The workspace card glyph gets
`WORKSPACE_CARD_STATUS.unknown`, an idle-kind glyph labelled by the reason.

The 30-minute threshold is Orca's (§3). It is long enough for legitimate silent
tools, such as a 20-minute build.

| Alternative                               | Why rejected                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Stale rows go to `done`.                  | Claims a completion that nobody observed. Replaced by `unknown` (lead decision).                  |
| Age measured as client now minus server time. | Server clock skew stretches or shrinks every age.                                            |
| First sight stamped "now".                | Grants 30 fresh minutes on every launch (review P2).                                             |
| A server watchdog that flips `running`.   | It would invent a session state. Decay is a display claim, not a transition.                     |

### D4. Failed is distinct inside Done (fixes F5)

A session in `error` with no pending request becomes `done` with the pill
`Failed`, in the destructive tone. This matches the card's existing failed rule.
`interrupted` and `stopped` stay plain Done.

`STATUS_TONES` is exported from `Sidebar.logic.ts` (contract item 3). Its
existing keys stay unchanged, and `failed` and `unknown` are added.

### D5. Terminal agents (fixes F7). In scope

**Default change, visible to users.** Every observable AI Terminal (Claude,
Codex, OpenCode) now launches with its status observer attached. This is no
longer tied to the default-off **AI Terminal** activity setting.

The setting still gates the detailed Subagents and Background Tasks activity:

- The observer's activity publication stays `Dormant` unless the setting is on.
  The `TerminalAgentActivityControl` live/dormant transition already exists.
- Main-agent status emission is independent of that state.

The user-facing effects:

- A Claude Terminal runs with BiBCode's additive hook settings, from a directory
  owned by that generation.
- A Codex Terminal starts BiBCode's supervised Unix-socket helper.
- OpenCode is observed through its API.

Users see this as terminal rows with live statuses. The change is named in the
release notes and in `docs/user/workspace-ui.md`. If an observer cannot be
prepared within its existing budget, the terminal launches unobserved, and the
row reads `unknown` / `unavailable`. Examples: Claude older than v2.1.63, a
Codex probe failure, a rejected settings merge.

**Sources, per provider (existing observers).**

- **Claude** (`provider_terminal/claude.rs`). Add `UserPromptSubmit`, `Stop`,
  `StopFailure`, `PermissionRequest`, `Notification` and `SessionEnd` to the
  settings injected at 1352-1360, and extend `validate_claude_hook` to bound
  their fields.
  - `UserPromptSubmit`, and `PreToolUse`/`PostToolUse` other than
    `AskUserQuestion`, map to **working**.
  - `PermissionRequest` maps to **blocked**.
  - `PreToolUse` for `AskUserQuestion`, and `Elicitation`, map to **waiting**.
  - `Stop` maps to **done**, and `StopFailure` to **done** with failed.
  - `SessionEnd` clears the status.
- **Codex** (`provider_terminal/codex.rs`). The changes go only in the observer
  and status-emission code, from about line 802 on. The preparation
  budget and timeouts (about 451-505) and `supervisor.rs` (about 481) belong to
  another agent. Map the root thread's status (`thread/status/changed`, or
  `thread/read` on reconnect):
  - `active` with `waitingOnApproval` maps to **blocked**.
  - `active` with `waitingOnUserInput` maps to **waiting**.
  - `active` with no flags maps to **working**.
  - `idle` maps to **done**, and `systemError` to **done** with failed.
- **OpenCode** (`provider_terminal/opencode.rs`). Session busy maps to
  **working**, idle to **done**, a permission ask to **blocked**, and a
  question to **waiting**.

**Supported status matrix.** Chat rows depend only on the server protocol. The
platform is the OS of the server host that runs the PTY.

| Provider | Chat (any OS) | AI Terminal, macOS and Linux                                   | AI Terminal, Windows        |
| -------- | ------------- | -------------------------------------------------------------- | --------------------------- |
| Claude   | full          | full (Claude Code ≥ 2.1.63, else `unknown/unavailable`)        | `unknown/unavailable`       |
| Codex    | full          | full (when the helper probe succeeds, else `unavailable`)      | `unknown/unavailable`       |
| OpenCode | full          | full                                                           | `unknown/unavailable`       |
| Cursor   | full          | `unknown/unavailable`                                          | `unknown/unavailable`       |
| Grok     | full          | `unknown/unavailable`                                          | `unknown/unavailable`       |

Here "full" means all four states plus decay. An unavailable terminal is never
shown as Working or Done.

**Publication and hydration.**

- `TerminalSummary` gains an optional field:
  `agentStatus: { state: "working"|"blocked"|"waiting"|"done"|"unavailable", failed, ageMs }`.
  The terminal manager keeps it in memory for each generation and publishes it
  through the existing metadata `upsert`.
- `ageMs` is computed when the summary is serialized, so the metadata snapshot
  that every subscription starts with carries skew-free ages. Reconnect
  hydration needs nothing new.
- On terminal restart, the new generation starts unobserved until its first
  hook.
- On server restart, PTYs end, and the summaries go with them (`remove`).
- On client restart, the client hydrates from the metadata snapshot, applying
  D3's age rule.
- When a PTY exits, the status becomes `done`, or `done` with failed for a
  non-zero exit.

**Rows (contract item 2).**

- One chat row per thread with a session, keyed `scopedThreadKey`.
- One row per AI Terminal, keyed `${scopedThreadKey}#terminal:${terminalId}`,
  with `terminalId` set and `ref` pointing at the host thread.
- A worktree with no chat session but an AI terminal gets its terminal row.
- Activating a terminal row goes through the center-panel API
  (`terminal:${terminalId}`, `centerPanelStore.ts:533`).
- The workspace card glyph takes the most urgent state among its chat and its
  terminals, in this order:
  1. approval
  2. input
  3. working
  4. failed
  5. plan ready
  6. **unknown** (stale, unavailable or offline)
  7. done
  8. idle

  Because unknown outranks done, an unobservable terminal never lets the card
  read Done. A finished chat with a running Cursor terminal shows the
  unavailable glyph. A terminal agent idle at its prompt counts as idle, so it
  adds nothing to the card. In a disconnected environment, any card that
  claims something reads offline.

**Trust boundary (AGENTS.md).** Status rides the observers' existing boundaries
and adds no new listener:

- The Claude receiver is bound to `Ipv4Addr::LOCALHOST` on an ephemeral port
  (`claude.rs:558`).
- Each generation has its own bearer token, compared in constant time
  (1322-1339).
- The settings live in a directory owned by that generation, and
  `validate_claude_hook` bounds every field.
- Codex uses a Unix socket owned by the generation's helper.

The default change widens who reaches these boundaries. Every observable AI
Terminal now opens one, not only opted-in ones. What reaches them does not
change: local processes that hold the generation's token or socket. Hook
payloads come from the agent and are untrusted:

- Only the event name, the derived enum and the tool name are kept, and the
  tool name only to recognize `AskUserQuestion`.
- No prompt, message or terminal text is stored, published or recorded by the
  profiler.

Status reaches clients only over the existing authenticated terminal metadata
WebSocket. For a remote environment, the loopback listener runs on the remote
server host, and nothing is exposed beyond that host's loopback.

### Effect on #186

The contract fixes the groups. The Inbox counts `unknown` in All Agents only.
Compared with today:

- `waiting` starts receiving questions.
- `blocked` loses orphaned approvals.
- `unknown` holds stale, offline and unavailable rows.
- `done` gains Failed rows.
- Terminal rows appear.

## 5. Tests

| Behavior                                                                                                                                                | Test seam                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 count from request-state activities only. Requested gives 1, resolved 0, non-stale failure 1, stale failure 0, expired 0. An assistant delta does not recompute it. | Engine tests through `dispatch` → shell JSON (next to the approval-projection tests, `engine.rs` ~12650-12725)                                                |
| D2a: a stale `provider.approval.respond.failed` while the session is running clears Pending Approval                                                  | Same engine tests                                                                                                                                              |
| D2b: leaving `running` (`ready`, `error`, `interrupted`, restart reconcile) appends expiries in the same commit. `running` and `starting` do not. No duplicates. A re-request reopens. | Engine dispatch tests; restart assertions in the `provider_runtime.rs` test modules (test code only)                                                             |
| D2b queue: an expiry at `ready` drains like an answered approval; an expiry on interrupt or error stays held                                           | Repository queue-head tests (`apps/server/tests/repositories.rs`) and the engine hold tests                                                                     |
| D2: an OpenCode recovered ask reappears after an expiry                                                                                                 | `request_is_recorded` repository test                                                                                                                         |
| D2 client: `*.expired` closes a request, and a later request reopens it                                                                               | `apps/web/src/session-logic.test.ts`                                                                                                                          |
| D3 evidence: provider events and `running` session-sets move `lastActivityAt`; title, mode and archive updates do not                                 | Engine tests                                                                                                                                                  |
| D3 age: skew-free conversion (server clock ±2 h), a repeated value keeps its time, a new value resets it, a launch after 40 min of silence is stale at once, 30-min boundary, approval and question never decay, offline outranks | `apps/web/src/hooks/useAgentFreshness.test.ts` and `Sidebar.logic.test.ts` (pure, injected `now`)                                                               |
| Mapping table, every row of the D3 table plus the D5 matrix                                                                                            | `agentsSection.logic.test.ts`                                                                                                                                  |
| Mounted threshold, AgentsPage: a row moves from Working to `unknown`/`stale` when the fake clock passes 30 min                                         | `AgentsPage.test.tsx` (`vp test run --project unit`, fake timers)                                                                                              |
| Mounted threshold, card: a workspace card glyph moves from working to the unknown glyph at the threshold                                               | Sidebar card component test through the `useWorkspaceCardStatus` call site                                                                                      |
| AgentsRow: no pulse in `unknown`, labels per reason, jump action omitted when no `onJumpToWorkspace`                                                  | New `AgentsRow.test.tsx`                                                                                                                                       |
| D5 server, per provider: hook or status → `agentStatus` on `TerminalSummary`, and the metadata snapshot carries it with `ageMs`. Emitted with the activity setting off. Unavailable when unobserved. No prompt text. | `provider_terminal` unit tests; `apps/server/tests/production_server_terminal_rpc.rs`, `provider_terminal_supervisor.rs`                                         |
| **Joined caller test**: a chat status and a terminal status are published, a client hydrates, the client reconnects (fresh snapshot), the client restarts (cached → offline → live), then grouping and card rendering | `apps/web/src/agentStatus.server.test.tsx` (opt-in: `BIBCODE_AGENT_STATUS_SERVER_BIN`). A real `bibcode serve` with a fake Codex app server publishes a question, and a Cursor AI Terminal reads unavailable. The test reads them over the authenticated WebSocket RPC, decodes them with the JSON codec, and renders the real `AgentsRow` and card glyph. It then reconnects (fresh snapshots) and restarts the server (the question expires, the row reads Failed). The observed terminal states are covered by `provider_terminal_supervisor.rs`. |

## 6. Documentation and runbooks

- `docs/architecture/rpc-and-orchestration.md`: `lastActivityAt`, the expiry and
  stale-failure settlements, and the queue behavior.
- `docs/architecture/activity-observation.md`: observers always attached for
  status, with detailed activity still gated; the status hook events; the trust
  boundary.
- `docs/providers/claude.md`: the injected hook list.
- `docs/user/workspace-ui.md`:
  - the five groups, with Unknown and its reasons, and Failed;
  - terminal rows and activating them;
  - the platform × provider matrix;
  - the default change.
- `docs/testing/cross-platform-validation.md` (native macOS, Linux and Windows):
  - Agents view status checks for a question, Stop during an approval, and a
    relaunch during an approval;
  - terminal availability per platform (Windows shows `unavailable`);
  - per-terminal row navigation;
  - offline and restart behavior.
- `docs/testing/ssh-environments.md` (remote): a remote AI terminal's status,
  and a network drop showing `unknown`/`offline` and then recovering.

## 7. Profiler, crash and trace coverage

- **Child processes.** The status observers are the existing supervised
  observers, and the Codex helper is already registered with
  `ProcessAttributionRegistry`. They now run for more terminals, but no new
  process kind is added.
- **Remaining items.** D1 to D4 add no RPC method, worktree-removal path,
  binary mode or service.
- **Logging.** Observer preparation failures, which lead to `unavailable`, log
  with `tracing::warn!` at the existing boundary.
- **Content.** Status records carry no prompt or terminal content.
