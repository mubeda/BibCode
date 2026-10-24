# Context-Limit Auto-Recovery

Status: Proposed 2026-10-24; awaiting approval.

Issue #160, the part left after v0.11.0. Depends on #163 (Codex) and #164
(OpenCode) for their providers; this document sets the provider seam they
implement. Their branch had no commits when this was written. Revised the same
day after a Codex review; see Review.

## Problem

When a conversation fills the provider's context window, the turn fails and
the user has to compact the conversation and send the message again by hand.
v0.11.0 made the failure readable and added a one-click **Compact
conversation** for Claude, but BiBCode still never compacts or resends on its
own, does nothing before the window is full, offers Compact only for Claude,
and records turn failures in the Profiler only for Claude.

The incident behind #160: a 1M-token Claude thread at 961,230 tokens, about 6K
under Claude's own auto-compact point (about 967K), sent a message that
crossed Claude's blocking limit; Claude stopped with `blocking_limit` without
compacting. Why Claude skipped its own compaction is upstream and unknown. Two
minutes later Claude did auto-compact the next message (`compact_boundary`,
`trigger: auto`, 993,785 tokens; #166 evidence), so the skip is intermittent.
BiBCode must recover without depending on it.

## Current behavior (verified at 4e023ac5ff)

- **Classification.** `describe_failed_turn` classes `blocking_limit`,
  `prompt_too_long` and `rapid_refill_breaker`, or a synthetic
  `invalid_request` message starting `Prompt is too long`, as `context_limit`
  with "Claude's context window is full. Compact the conversation, then send
  your message again." plus Claude's text
  (`apps/server/src/provider/claude/failure.rs:24`, `:130`, `:171`, `:192`).
  The failure carries no structured facts beyond the class and text. The
  synthetic assistant message is captured without being shown
  (`apps/server/src/provider/claude/runtime.rs:2320`).
- **Projection.** A failed `turn.completed` sets the session to `error` with
  `lastError` and `lastErrorClass`
  (`apps/server/src/production/provider_runtime.rs:8984`, class normalized at
  `:9385`). In the same transaction an `error` or `interrupted` session holds
  every queued row until **Send now**
  (`apps/server/src/orchestration/engine.rs:4953`, `:4989`).
- **Delivery state.** The failed message's outbox row is `delivered`, which is
  terminal: Retry accepts only `uncertain` or `failed`
  (`engine.rs:5284`). `provider_turn_outbox.message_id` is unique
  (`apps/server/src/persistence/migrations.rs:2494`). OpenCode reconciles a
  resend by its delivery-derived message id and skips one it already has
  (`docs/architecture/rpc-and-orchestration.md`, "Durable message queue").
- **Turn markers.** Admitting an ordinary start appends
  `thread.turn-start-requested`, which stamps the message with the admission
  time and inserts a `projection_turns` row with no turn id for it, its pending
  marker (`engine.rs:5886`, `:6168`). The next running `thread.session-set`
  with a new turn id binds the newest marker to that turn, whoever started the
  turn; one for a turn already known deletes every marker of the thread
  (`engine.rs:6197`, `:6218`, `:6223`). A queued start has no marker until it
  is promoted.
- **Claims, holds and admission.** The delivery claim takes a pending start
  whenever the session is not running or starting, so also in `error` or
  `interrupted`, and ignores `held`
  (`apps/server/src/persistence/repositories.rs:1074`). The hold an error or
  interrupt applies covers queued rows and pending or sending steers, not a
  pending start (`repositories.rs:2866`). Admission keeps `queued: true` only
  while the session is running or starting and never queues a start sent
  without it (`apps/server/src/production/orchestration_rpc.rs:650`). Automatic
  promotion needs a `ready` session and no running turn marker
  (`repositories.rs:2932`).
- **Manual Compact.** The thread error offers **Compact conversation** only for
  `context_limit` (`apps/web/src/components/ChatView.logic.ts:855`), disabled
  while the thread is busy. It sends the literal `/compact` as an ordinary user
  message (`ChatView.logic.ts:845`, `apps/web/src/components/ChatView.tsx:6354`,
  `:6430`), which only Claude understands. Claude acknowledges it by its
  `local_command` result, and the 60 s acknowledgement wait pauses while
  Claude reports `status: "compacting"` (#166, `docs/providers/claude.md`,
  "Steering a running turn").
- **Claude's stale results.** After a resume Claude can report a successful
  `result` before it reads the new input. The runtime ignores such a result
  only while a write awaits its replay (`runtime.rs:2724`, `await_turn_input`
  at `:1786`). A delivered `/compact` is never replayed: its `local_command`
  result acknowledges the write before the result itself is handled
  (`provider_runtime.rs:12207`, `:15666`), so that result, and no earlier one,
  ends its turn.
- **Compaction visibility.** Claude's compaction is a `context_compaction` item
  (`item.started`/`item.completed`, status `completed` or `failed`) on the
  current turn (`runtime.rs:2955`, `:2986`). Codex reports
  `contextWindowExceeded` as `provider_error`, not `context_limit`
  (`apps/server/src/provider/codex/runtime.rs:3699`), and surfaces no
  compaction item (#163). OpenCode 2 surfaces neither (#164).
- **Usage.** Claude's `get_context_usage` gives `totalTokens`, `maxTokens`,
  `isAutoCompactEnabled` and `autoCompactThreshold`
  (`apps/server/src/provider/claude/usage.rs:68`), projected as
  `compactsAutomatically` and `autoCompactTokens`
  (`packages/contracts/src/providerRuntime.ts:341`) in the latest
  `context-window.updated` activity per turn. The activity records no provider
  instance or conversation (`provider_runtime.rs:9091`, `:9262`). Nothing acts
  on it.
- **Launch.** BiBCode passes no auto-compact window to Claude
  (`provider_runtime.rs:14014`). A provider instance's environment variables
  reach the session, so a user can already set
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or `DISABLE_AUTO_COMPACT` there. A
  delivery freezes its provider route at admission and reopens a suspended
  session with it (`freeze_delivery_route`, `provider_runtime.rs:1697`;
  `build_launch_request_for_command`, `:4819`). Revert reopens with the
  thread's current configuration instead (`:7855`).
- **Profiler.** `record_turn_failure` raises `provider.turn-failed` (warn for
  `context_limit`) from the Claude runtime only (`runtime.rs:2759`,
  `apps/server/src/diagnostics/profiler/provider_turns.rs:21`); Codex and
  OpenCode failures record nothing. Its `identifier` redaction keeps only
  lowercase snake or kebab case and turns anything else into `other`
  (`provider_turns.rs:73`).
- **Precedents reused here.** Checkpoint revert runs as an orchestration effect
  that reserves the thread's turns in memory, so delivery and automatic
  promotion skip the thread, and reopens a suspended session first
  (`engine.rs:2542`, `rpc-and-orchestration.md`, "Checkpoint revert"). A turn
  the provider starts itself runs without a user message
  (`provider_runtime.rs:8956`). `stop_session_if_current` ends a session only
  if it is still the one captured (`provider_runtime.rs:1285`). Provider
  capabilities are driver-owned predicates such as `supports_turn_steer`
  (`apps/server/src/provider/mod.rs:13`) advertised on the provider snapshot
  (`packages/contracts/src/server.ts:209`).

## Goals

1. After a context-limit failure that compaction can fix, compact once and send
   the failed message once more, without the user typing anything.
2. Never loop: at most one automatic compaction and one resend per failed
   message, and no automatic compaction where the provider said it cannot help.
3. Before a message that would likely hit the limit, compact first, where the
   provider reports where it compacts.
4. One provider-generic path: Claude now; Codex and OpenCode by implementing one
   driver method.
5. Every provider's failed turn, and every compaction outcome, recorded by the
   Profiler without content.
6. Queued messages keep their order and are not stranded by a recovery.

## Non-goals

- Fixing why Claude skipped its own auto-compaction (upstream).
- Changing what compaction keeps; that is the provider's summary.
- Splitting, trimming or rewriting a message too large for the window.
- Recovering a turn that already did work before the limit (see Eligibility).
- Implementing Codex and OpenCode compaction (#163, #164), beyond the contract.

## Alternatives

### Where recovery runs

**A. Status quo.** Manual Compact, then retype. Rejected: the issue.

**B. Client.** The web app sees `context_limit`, sends `/compact`, waits, then
resends. Rejected: nothing happens while no client is open, two windows both
act, a reconnect mid-recovery loses its state, `/compact` is Claude-only, and
the client does not own the queue.

**C. Inside the Claude adapter.** The runtime writes `/compact` and the message
again within one BiBCode turn. Rejected: a resend the outbox does not know about
is exactly the hidden delivery state #166 had to remove; it is Claude-only, has
no restart or cancel story, and cannot be shown honestly.

**D. Server orchestration (chosen).** The engine decides eligibility in the
transaction that records the failure, and an orchestration effect drives the
compaction, as checkpoint revert does. Durable, single owner, provider-generic,
visible to every client.

**E. Resend only.** Rely on Claude compacting the resent message itself, as it
did two minutes later in #166. Rejected: the skip is intermittent, and a resend
that fails the same way invites the loop the issue forbids.

### How the failed message is sent again

**R1. Same message, `delivered` back to `pending`.** No duplicate bubble.
Rejected: it breaks the terminal-`delivered` invariant, needs a new delivery key
(OpenCode would otherwise report the message already received and send
nothing), and rebinds a historical turn's user message to a new turn. The
provider's conversation holds the message twice, so "Revert to this message",
which counts turns, would no longer match it.

**R2. A server-admitted copy, created when the compaction succeeds (chosen).** A
new user message with the original's text, attachments (by attachment id),
frozen options and frozen route, marked `resendOf` the original. All delivery
invariants hold, the key is new, turns stay one per user message as in the
provider, and the copy says what it is. Creating it only on success means a
failed, stopped or unknown compaction leaves nothing to withdraw, and the copy
cannot be overtaken by the compaction turn.

### Proactive guard

**G1. Pass `--autocompact <tokens>` (Claude Code 2.1.221+) or set
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` at launch.** Native, no BiBCode state. Rejected
as a default: the flag overrides the user's saved window and "isn't preempted by
a higher-priority settings scope such as managed settings", and the variable
takes precedence over every other source, so BiBCode would silently override the
user's and an administrator's choice. It is also Claude-only and would still
fail the way #160 did when one message crosses both thresholds. Users who want
headroom can already set the variable on the provider instance; the provider
guide will say so. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (lower-only) has the same
trade-offs.

**G2. Compact before delivering a message when usage is near the provider's
compaction point (chosen).** Server-side, provider-generic, reuses the
compaction path, and compacts only when the user is actually sending, which is
when the provider would compact anyway.

**G3. Compact when a turn ends near the limit (the issue's wording).**
Rejected: it spends a near-window-size summarization request on threads the user
may never return to, and races the 60 s idle suspension.

**G4. Client threshold.** Rejected as B.

### Setting

**S1. A BiBCode switch, default on.** Rejected: UI.md asks not to add
preferences in place of decisions, and the provider already has this switch.

**S2. Follow the provider's own auto-compact switch (chosen).** BiBCode compacts
automatically only when the provider's latest usage reading says it compacts
automatically (`compactsAutomatically`, from Claude's `isAutoCompactEnabled`:
off with `autoCompactEnabled: false` or `DISABLE_AUTO_COMPACT`, and expected to
be off with `DISABLE_COMPACT`, which the test plan checks). A user who turned
auto-compaction off keeps the manual Compact action and nothing else, which is
what they asked the provider for. There is nothing new to find in Settings.

## Decision

D with R2, G2 and S2. One provider-generic `thread.compact` path serves the
manual action, automatic recovery and the guard; recovery and the guard are
gated by a provider capability and the provider's own auto-compact switch.

What this trades away: a recovered message appears twice in the thread (the
failed original and the labelled copy), because it was sent twice; each
recovery or guard costs one compaction request; the guard compacts about 5% of
the window earlier than the provider would. A turn that did work before the
limit is not recovered automatically. A compaction whose outcome BiBCode cannot
confirm keeps the thread waiting until the provider session that ran it ends.

## Answers to the issue's open questions

- **Recover automatically?** Yes, once: compact, then resend a copy. A copy whose
  own turn fails at the limit, a compaction that fails, or a provider that said
  compaction cannot help ends at today's actionable error.
- **Setting, on by default?** No BiBCode setting; the provider's own
  auto-compact switch decides, and it is on by default in Claude.
- **Guard: launch-time window or threshold?** A server threshold before
  delivery (G2), not a launch flag (G1).
- **Where the state machine lives?** Server: the engine decides, an
  orchestration effect drives, the outbox delivers.
- **Queued messages (#166)?** An eligible failure does not hold the queue;
  messages sent during the recovery are queued; once the compaction succeeds
  the copy goes first; a failed or stopped recovery holds the queue as an error
  does today.
- **Profiler?** Every provider's failed turn records `provider.turn-failed`;
  every compaction records `provider.compaction`.
- **Why Claude skipped auto-compact?** Not answered; recovery does not depend on
  it, and the Profiler's recurring `provider.turn-failed` count shows whether it
  persists.

## Design

### Provider seam

- `ProviderDriver::compact(&self, compaction_id: &str) ->
  BoxRuntimeFuture<'_, ProviderCompactionStart>` in
  `apps/server/src/production/provider_runtime.rs`, where
  `ProviderCompactionStart` is `Started { turn_id: Option<String> }` (the
  provider took the request; the outcome arrives as events),
  `NotStarted { detail }` (certainly not sent; the default, "provider does not
  support compaction") or `Unknown { detail }` (the request may have reached
  the provider). `ProviderDeliveryOutcome` is not reused: its new-conversation,
  already-delivered and retry-after outcomes mean nothing for a compaction.
- `supports_compaction(provider)` in `apps/server/src/provider/mod.rs`,
  advertised as `supportsCompaction` on the provider snapshot, like
  `supportsTurnSteer`. Claude only in this change; #163 and #164 flip it for
  Codex and OpenCode.
- **Compaction turns are tagged.** Each driver reports the compaction as a turn
  of its own and puts the `compactionId` it was given on that turn's
  `turn.started` and `turn.completed`. The event pump carries it on the running
  `thread.session.set`. A running session update with `compactionId` gives the
  turn its own row and neither binds nor deletes a pending marker, in either
  branch of the turns projector, so a message waiting behind the compaction
  keeps its marker for its own turn. The tag is explicit because Claude and
  Codex report every turn, delivered or not, and `providerStarted` is set only
  by OpenCode.
- **Claude:** writes `/compact` on stdin and opens a turn for it tagged with the
  compaction id. The write is registered for acknowledgement as a delivery
  write is, but as an operation entry with no delivery key and no outbox row,
  and the turn awaits its input (`await_turn_input`). A successful result that
  arrives first is the stale one Claude reports after a resume and is ignored,
  as for a delivered `/compact`; a background-task notification in that window
  follows the turn as today. Only the matching `local_command: "compact"`
  result acknowledges the write, and it ends the compaction turn. For this
  write the acknowledgement wait has no deadline of its own; the operation's
  bound (Recovery flow, step 4) covers it. No other write can take the
  acknowledgement: `thread.compact` is refused while the session is running or
  starting, and the delivery claim is refused while a compaction is unsettled,
  so no delivered `/compact` awaits acknowledgement at the same time.
- **Codex (#163):** `thread/compact/start { threadId }`, progress as `turn/*`
  and a `contextCompaction` item
  ([protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)).
  The adapter tags the turn Codex starts for the request. Also
  `contextWindowExceeded` must become `context_limit`.
- **OpenCode (#164):** `POST /api/session/{id}/compact` and
  `Session.Message.Compaction` (`running`, `completed`, `failed`), tagged the
  same way.
- **Outcome contract.** Each driver reports the compaction as a
  `context_compaction` item in the tagged turn and ends that turn with a
  `turn.completed`. The compaction succeeded only when that turn completed (not
  failed or interrupted) and an item in it completed with status `completed`.
  Anything else, including no item at all (Claude's "Not enough messages to
  compact."), is a failure. Settlement matches both the compaction id and the
  turn id, so a late event of one compaction cannot settle another.
- **Failure facts.** A `context_limit` `turn.completed` gains two optional
  facts, reported by the adapter and never inferred from text by the engine:
  `beforeOutput: true` when the provider refused the turn's input before any
  assistant text, tool call or compaction; `compactable: false` when the
  provider said compaction cannot help. For Claude, `compactable: false` on
  `rapid_refill_breaker` (by its name and Claude's grouping, a breaker against
  context refilling straight after compaction; undocumented, so inferred), on
  `Prompt is too long · automatic compaction failed: …` ("`/compact` fails on
  the same error until you do", [errors](https://code.claude.com/docs/en/errors#prompt-is-too-long)),
  and on the single-exchange forms. `ClaudeTurnFailure` carries these as fields
  set where `failure.rs` reads Claude's raw text, not from the user-facing
  message. Absent facts mean no automatic recovery.

### Identity

Every compaction row records the provider instance and kind and the
conversation it compacts (Claude's session id, Codex's thread id, OpenCode's
session id, from the session's resume cursor). Recovery takes them from the
failed delivery and the guard from the guarded delivery; manual Compact takes
them from the thread's saved runtime.

- The effect reopens a suspended session for recovery or the guard with that
  delivery's frozen launch (`build_launch_request_for_command` with the
  delivery, as a delivery retry does), not with the thread's current
  configuration as revert does. Like revert, it fails rather than start a new
  conversation when the provider no longer has this one.
- Before calling `compact`, the effect checks that the live session has the
  recorded instance and conversation; if not, it settles `failed` ("The
  thread's provider or conversation changed, so it wasn't compacted.").
- The copy reuses the failed delivery's frozen payload and route verbatim; the
  route is not frozen again (that reads settings and cannot run inside the
  settle transaction). Its claim checks the session again
  (`freeze_provider_turn_session`).
- The event pump tags each `context-window.updated` activity with the provider
  instance and conversation it was read from. Eligibility and the guard use the
  latest reading only when both match the delivery's; an untagged reading,
  such as one recorded before this change, means no automatic compaction.

### Eligibility

Checked by the engine inside the transaction that projects the failure. All
must hold:

1. `errorClass` is `context_limit`, `beforeOutput` is true, and `compactable` is
   not false.
2. The failed turn was started by a delivered `start` delivery of a user
   message, which is not itself a copy (`resendOf` absent), has no recovery
   row, and whose delivery had no guard compaction that failed or was stopped.
3. The provider instance supports compaction.
4. The thread's latest valid context-window reading from the failed delivery's
   instance and conversation has `compactsAutomatically: true`.
5. No compaction of the thread is unsettled, no other delivery of the thread is
   pending or sending (a steer written during the failing turn is input the
   provider reads next; compacting behind it would reorder the conversation),
   and the thread is neither deleted nor an archived panel.

A turn that did work first is excluded on purpose: resending its message would
repeat tool calls that already ran, and compacting alone leaves the user to
re-prompt, which the manual action already does in one click.

### Recovery flow

1. **Failure.** The event pump's failed `turn.completed` passes the failure
   facts on its internal `thread.session.set` as `contextLimit: { turnId,
   beforeOutput, compactable }`. If eligible, in one transaction the engine:
   projects the session `error` with `lastErrorClass: context_limit` and, in
   place of the adapter's message, a server constant for `lastError` (the
   recovery text under UI; it is not built in `describe_failed_turn`); skips
   the queue hold; inserts a `thread_compactions` row
   (`trigger: contextRecovery`, `failedMessageId`, the identity, state
   `requested`); appends `thread.compact-requested`; and wakes the effects
   worker. No copy exists yet. Otherwise nothing changes from today.
2. **Compaction.** The effect reserves the thread's turns, reopens a suspended
   session (Identity), and moves the row from `requested` to `running` with a
   conditional update, so a Stop that got there first wins and nothing is sent.
   It checks the identity and calls `compact(compactionId)`. `NotStarted`
   settles `failed`. `Started` records the turn id when the driver knows it.
   `Unknown` marks the row `unresolved`; there is no retry, because a second
   compaction is not harmless.
3. **Wait.** The pump resolves the thread's compaction waiter after projecting
   the tagged turn's `turn.completed`, with whether a completed
   `context_compaction` item was seen in it. An operation whose outcome is not
   known yet stays `unresolved`, and the SQL gate keeps holding the thread:
   - It settles only from its own turn's `turn.completed`, or when the
     provider session that owns it ends.
   - The bound is 15 minutes (a near-1M compaction takes 70-80 s, #166). At the
     bound the effect interrupts the turn and, if that is not confirmed within
     30 s, stops the session with the identity it captured
     (`stop_session_if_current`).
   - An `Unknown` request that starts no turn within 60 s is ended the same way.
   - A session that ends this way settles its row `failed` with "BiBCode
     couldn't confirm whether the conversation was compacted."
4. **Settle** (`thread.compacted`, one transaction; the reservation is released
   after):
   - `completed`, with no Stop requested: admit the copy as a pending `start`
     with command id `server:context-resend:<failedMessageId>` and a new
     delivery key. Its command receipt and the original's attachment refs,
     with their digests, are recorded under the copy's command id, as
     admission does, because the delivery's attachment check looks them up by
     command (`repositories.rs:1036`). Its `thread.turn-start-requested`
     stamps it now, so it
     renders after the compaction step, and creates its pending marker after
     the compaction turn has ended. Wake delivery. Every start that arrived
     during the recovery was queued (Queue and delivery state), so the copy is
     the thread's only pending start and is delivered first.
   - `failed`: session `error`, `lastErrorClass: context_limit`, `lastError`
     naming the compaction failure ("Claude couldn't compact the
     conversation.", provider by instance label); hold the queue. No copy: the
     failed original stays, with the manual Compact action.
   - `interrupted` (Stop, before or during the compaction, even if it then
     completed): no copy; `lastError` restored to the context-limit text so the
     manual action returns; queue held by the interrupt as today.
5. **Resend.** The copy is an ordinary delivery. If its turn fails at the limit
   again, rule 2 makes it ineligible: today's error, with text saying the
   conversation was already compacted once.

The delivery claim and automatic promotion also refuse a thread with a
`requested`, `running` or `unresolved` compaction row, in SQL. Nothing is sent
in the gap before the effect takes the reservation, while the outcome is
unknown, or after a restart.

### Manual Compact

**Compact conversation** dispatches a new client command `thread.compact`
(`trigger: manual`) for any provider with `supportsCompaction`; it uses the same
row, effect and settle, without a copy. It compacts the conversation the next
message would continue: the effect reopens the thread's saved runtime as revert
does, and the engine refuses a thread with no saved conversation for that
instance ("There's no saved Claude conversation for this thread to compact.").
The identity check before `compact` applies. The engine also refuses it while
the session is running or starting, while a compaction is unsettled, or for an
unsupported provider. Typing `/compact` in the composer keeps today's message
path. Against an older server (no `supportsCompaction`), the button keeps
sending `/compact` for Claude.

### Proactive guard

Before claiming a pending `start` delivery, the delivery worker reads the
thread's latest context-window reading from the delivery's frozen instance and
the conversation it will continue. When the provider reports
`autoCompactTokens` and `compactsAutomatically: true`, and
`usedTokens >= autoCompactTokens - 0.05 * maxTokens` (917K for the incident's
967K of 1M; it was at 961K), it dispatches `thread.compact` (`trigger: guard`,
command id `server:context-guard:<deliveryCommandId>`, one per delivery), sets
the delivery's detail to "Waiting for the conversation to be compacted.", and
skips the claim. The guarded message keeps its pending marker; the compaction
turn's tag stops that turn from taking it. The SQL gate holds the message until
the compaction settles:

- `completed` or `failed`: the message is delivered. A failed guard makes the
  message ineligible for recovery (rule 2).
- `interrupted` (Stop, or a restart): the message is not sent. In the same
  transaction it becomes `failed` with "Not sent: you stopped the conversation
  compaction. Retry sends it." (or the restart text under Failure), through a
  server-only `pending` to `failed` transition. Its marker stays, as for any
  failed start, so Retry binds its turn as usual. Retry sends it without
  compacting again (one guard per delivery), and recovery does not apply to it
  (rule 2).
- `unresolved`: the gate keeps holding the message until the operation settles.

The guard skips a thread whose last completed compaction has no ordinary turn
after it, because the reading it has predates that compaction; this stops a
recovery's copy, or the message right after a guard, from being compacted
twice. A conversation that is still above the threshold after compacting and
one more turn is compacted again before the next message, as the provider's
own threshold would. Providers that do not report where they compact (Codex and
OpenCode today) are not guarded; their own auto-compaction stands.

### Queue and delivery state (#166)

- While a compaction is unsettled, admission treats the thread as running. It
  keeps `queued: true`, and it also queues a start sent without it (an older
  client, or one that has not seen the snapshot yet), so no message is admitted
  ahead of the copy or with a marker the compaction turn could overtake. The
  web composer asks for queued admission while the snapshot's `compaction` is
  set, as it does while a turn runs.
- An eligible failure does not hold queued rows: they were queued to follow the
  failed message, which is being sent again. Automatic promotion needs a
  `ready` session, and the SQL gate refuses it too, so nothing is promoted
  while the session reads `error` or the compaction runs. After `completed` the
  copy's running marker holds promotion until the copy's turn has run; then
  queued rows follow in order.
- A failed or stopped recovery holds the queue exactly as an error or interrupt
  does today.
- The compaction is not a delivery: it has no outbox row and no user message,
  so it can never become "Delivery uncertain" or block later messages. The copy
  is a normal delivery with every #166 rule.

## Protocol, schema and persistence

- **Contracts** (`packages/contracts/src/orchestration.ts`): client command
  `thread.compact { commandId, threadId, createdAt }`; events
  `thread.compact-requested { threadId, compactionId, trigger, failedMessageId? }`
  and `thread.compacted { threadId, compactionId, outcome, detail? }` with
  `trigger` `manual | contextRecovery | guard` and `outcome`
  `completed | failed | interrupted`; optional `resendOf: MessageId` on
  `OrchestrationMessage`; optional `compaction: { trigger, state,
  failedMessageId? }` on the thread snapshot while one is unsettled; internal
  `thread.session.set` gains optional `contextLimit` and `compactionId`.
  `server.ts`: `supportsCompaction`. `providerRuntime.ts`: optional
  `beforeOutput`, `compactable` and `providerReason` on a failed
  `turn.completed`; optional `compactionId` on `turn.started` and
  `turn.completed`; optional `providerInstanceId` and `conversationId` on the
  context-window payload. All additive; older clients ignore the new fields and
  decode unknown events as today.
- **Persistence** (one migration): table `thread_compactions(compaction_id PK,
  thread_id, trigger, state, stop_requested, provider_instance_id,
  provider_kind, conversation_id NULL, turn_id NULL, failed_message_id UNIQUE
  NULL, guarded_delivery_command_id UNIQUE NULL, resend_message_id NULL,
  detail NULL, created_at, updated_at)` with an index on `(thread_id, state)`.
  States are `requested`, `running` and `unresolved` (unsettled), then
  `completed`, `failed` or `interrupted`. Column
  `projection_thread_messages.resend_of_message_id`. The table is the source of
  truth for unsettled compactions, as the outbox is for the queue; events
  project the snapshot field and replay. The outbox schema is unchanged; the
  copy's payload carries `resendOf`.
- **Turn projection:** a running `thread.session-set` with `compactionId`
  upserts that turn's row without a pending message and leaves every
  `turn_id IS NULL` marker alone.
- **Delivery transitions:** one new server-only transition, `pending` to
  `failed`, used only for a guarded start whose compaction was stopped or cut
  short by a restart. Clients cannot request it.
- **RPC:** no new method. `thread.compact` goes through
  `orchestration.dispatchCommand`, which returns at admission.

## Trust boundaries

- The copy is built on the server from the failed message's stored outbox
  payload (text, attachment ids, frozen options and route); no client input
  reaches it. It goes only to the same thread, provider instance and
  conversation, which the effect checks before compacting and the claim checks
  again.
- `contextLimit`, `compactionId` on session updates and the server command ids
  exist only on internal commands (`thread.session.set` is in
  `InternalOrchestrationCommand`); a client cannot start a recovery, fake
  failure facts or detach a turn from its message.
- `thread.compact` is admitted under the existing `orchestration:operate`
  dispatch authorization, like `thread.turn.start`.
- No new process, file, network destination or launch argument. Codex and
  OpenCode reach the endpoints their adapters already use.

## Failure, cancellation, restart and concurrency

- **Duplicate events.** The unique `failed_message_id` and
  `guarded_delivery_command_id`, the deterministic copy command id, and
  settlement by compaction id and turn id make a replayed failure, guard check
  or late compaction event a no-op.
- **Stop.** The engine admits `thread.turn.interrupt` without a running turn
  and routes it to the runtime only after admission
  (`orchestration_rpc.rs:519`), so Stop also works in the gap before the
  compaction turn starts. In the interrupt's transaction, a `requested` row
  becomes `interrupted` (the effect's conditional update then fails and
  nothing is sent). A `running` or `unresolved` row gets `stop_requested`, and the
  runtime interrupts its turn; the row settles `interrupted` when that turn
  ends or the session ends, even if the compaction completed meanwhile.
  Recovery then sends no copy, the guard fails its message (Proactive guard),
  and a manual compaction just stops.
- **Restart.** Startup reconciliation (`reconcile_abandoned_provider_sessions`,
  `provider_runtime.rs:2368`) already treats every provider session as ended
  when BiBCode stopped. Before delivery starts, it settles every unsettled row
  `interrupted`. A recovery sends no copy and holds the queue, leaving the
  original's error and the manual Compact action. A guard fails its message
  with "BiBCode restarted before the conversation was compacted. Retry sends
  it." The effect, like revert, is not replayed. #164 must confirm that an
  OpenCode 2 server BiBCode started ends with it, since this relies on that.
- **Reconnect.** State is durable and in snapshots; a client that reconnects
  mid-recovery sees the compaction step, the snapshot's `compaction` field and,
  once admitted, the copy.
- **Concurrency.** The thread reservation excludes revert and a delivery in
  flight; the SQL gate excludes claims and promotion; admission queues new
  starts; one unsettled compaction per thread. Idle suspension does not stop a
  compaction: it is a running turn. An `Unknown` request with no turn is ended
  by its own 60 s bound.
- **Shutdown.** A compaction waiter is abandoned at shutdown like a revert
  waiter; restart settles its row. It stops with the orchestration effects,
  before the Profiler's teardown.

## Performance

No hot-path cost. Eligibility runs only on failed `context_limit` turns: a
handful of indexed reads in an existing transaction. The guard adds one indexed
read of the latest context-window activity per claimed start delivery, not per
event or delta. The SQL gate is one `NOT EXISTS` on `(thread_id, state)` in the
claim and promotion queries, and admission already reads the session; it adds
the same lookup. The waiter is one map entry per compacting thread. The real
cost is the provider's: one compaction request, on the order of the window's
size in input tokens, per recovery or guard.

## Profiler coverage

- **Provider turn failures:** move `record_turn_failure` from the Claude runtime
  (`runtime.rs:2759`) to the shared failed-`turn.completed` projection
  (`provider_runtime.rs:8990`), with `providerReason`: Claude's
  `terminal_reason`, Codex's error variant, OpenCode's error name. A shared
  normalizer in `provider_turns.rs` rewrites a camelCase or PascalCase name in
  snake_case before the existing `identifier` redaction, treating a run of
  capitals as one word (`contextWindowExceeded` becomes
  `context_window_exceeded`, `APIError` becomes `api_error`). Distinct variants
  stay distinct instead of all becoming `other`; free text still becomes
  `other`. Every provider records it; Claude once.
- **Compaction:** a `provider.compaction` event `{ provider, trigger, outcome,
  reason, durationMs }` on every settle, where `reason` is one of
  `not_started`, `no_compaction`, `turn_failed`, `unconfirmed`,
  `identity_changed` or `stopped`, and a `provider.compaction-failed` finding
  (warn) for `failed`, fingerprinted by provider, trigger and reason. No
  message, summary or error text. `tracing::warn!` on failed settles and on
  stopping a session at the bound.
- **RPC methods, child processes, binaries, worktree removal:** none added.
  Stopping a session at the bound is an existing requested stop
  (`stop_session_if_current`), so it raises no `subprocess.crash`; only an
  unexpected exit does (`provider_runtime.rs:8773`). The `tracing::warn!`
  above records it.
- **Shutdown:** covered above.
- **Documentation:** `docs/skills/bibcode-profiler/references/events.md` and
  `findings.md` (drop "Claude turns only, today"), and the Profiler section of
  `docs/architecture/overview.md`.

## UI (UI.md)

- **During recovery**, while the session reads `error`, the banner keeps its
  title ("Claude ran out of context") and says "The context window is full.
  Compacting the conversation, then sending your message again.", without the
  Compact button. The user needs this to know not to resend by hand. Once the
  compaction turn runs, the banner clears; the failed original shows a muted
  notice, "Sends again after the conversation is compacted.", driven by the
  snapshot's `compaction.failedMessageId`, and the timeline shows the existing
  **Conversation compaction** step.
- **The copy** shows the existing delivery notice, muted, "Sent again after the
  conversation was compacted." (`TurnDeliveryNotice.tsx`, beside
  `startedNewConversation`). A failed copy keeps the existing Retry, so the user
  never retypes it.
- **While a compaction is unsettled** the composer queues what the user sends,
  and Stop is offered. Stopping a guard leaves the message failed with "Not
  sent: you stopped the conversation compaction. Retry sends it."
- **Compact conversation** shows for any provider with `supportsCompaction`,
  disabled with "Compacting the conversation…" while one is unsettled, as well
  as today's busy reason. Without support it is not shown.
- **After a failed compaction** the banner names the failure and keeps the
  Compact action; the original stays in the thread.
- **After a second failure** the banner says the conversation was already
  compacted once, so the user does not try the same thing again.
- **No setting.** Nothing new in Settings (S2).

## Files to change

- `apps/server/src/production/provider_runtime.rs`: `ProviderDriver::compact`
  and `ProviderCompactionStart`; pass failure facts and `compactionId`; tag
  context-window readings; compaction waiter and bound; shared
  `record_turn_failure`; startup settle; Claude `compact` with its
  acknowledgement entry.
- `apps/server/src/provider/claude/{failure.rs,runtime.rs}`: `beforeOutput`,
  `compactable`, `providerReason`; tagged compaction turn that awaits its
  input; drop the local profiler call.
- `apps/server/src/provider/mod.rs`: `supports_compaction`.
- `apps/server/src/orchestration/engine.rs`: `thread.compact`; eligibility and
  recovery begin in the session-set transaction; settle and copy admission;
  Stop handling; tagged turns in the turns projector; SQL gate in promotion.
- `apps/server/src/production/orchestration_effects.rs`: compaction effect.
- `apps/server/src/production/orchestration_rpc.rs`: queued admission while a
  compaction is unsettled.
- `apps/server/src/production/turn_delivery.rs`: SQL gate in the claim; guard.
- `apps/server/src/persistence/{migrations.rs,repositories.rs}`: table, column,
  `pending` to `failed` for a guarded start.
- `apps/server/src/diagnostics/profiler/provider_turns.rs`: `&str` provider;
  reason normalizer; `provider.compaction` event and finding.
- `packages/contracts/src/{orchestration.ts,server.ts,providerRuntime.ts}` and
  regenerated fixtures.
- `apps/web/src/components/{ChatView.tsx,ChatView.logic.ts}`,
  `apps/web/src/components/chat/{TurnDeliveryNotice.tsx,ThreadErrorBanner.tsx}`.
- Docs: `docs/providers/claude.md` ("Compaction and the context limit", and the
  auto-compact window as the user's headroom lever), `docs/architecture/providers.md`
  (failure attribution, compaction capability, tagged compaction turns),
  `docs/architecture/rpc-and-orchestration.md` (a "Context-limit recovery"
  section under Provider turn flow; the queue-hold exception; queued admission
  while compacting; startup reconciliation), `docs/user/workspace-ui.md`, the
  Profiler documents above, `docs/testing/cross-platform-validation.md`
  ("Durable message queue": new focused tests), and the CHANGELOG known
  limitation.

## Test plan (each written to fail first)

Server, with the fake provider driver and recorded Claude stream-json frames:

1. `failure.rs`: bare `Prompt is too long` with `blocking_limit` gives
   `compactable` unset; `rapid_refill_breaker`, `automatic compaction failed:`
   and the single-exchange text give `compactable: false`.
2. Claude runtime: a turn that fails at its first request reports
   `beforeOutput: true`; one with a tool call or streamed text first reports
   false.
3. Claude `compact`: writes `/compact` and opens a turn tagged with the
   compaction id. On a resumed session a successful result before the
   `local_command` result is ignored and the turn stays open; a background-task
   notification in that window follows the turn; the `local_command: "compact"`
   result ends it. It settles `completed` only with a completed
   `context_compaction` item; "Not enough messages to compact." settles
   `failed`.
4. Turn projection: with a start pending, a running session update tagged with
   a compaction id creates its own turn row and neither binds nor deletes the
   marker, including a second update for the same turn; the pending message's
   own turn later binds its marker. Untagged updates behave as today.
5. Engine: an eligible failure projects `error`, holds no queued row, inserts
   one `requested` row with the failed delivery's identity, admits no message,
   and appends one `thread.compact-requested`; replaying the same
   `turn.completed` adds nothing.
6. Engine: each ineligible case (copy fails again, `compactsAutomatically`
   false, a reading from another instance or conversation or with no identity,
   no `supportsCompaction`, `beforeOutput` false, `compactable` false, a failed
   or stopped guard, a steer still pending or sending) behaves exactly as
   today, queue held. A recorded `get_context_usage` response from a session
   launched with `DISABLE_COMPACT=1` shows `isAutoCompactEnabled: false`; if it
   does not, eligibility also reads the instance environment.
7. Settle `completed`: admits one copy with `resendOf`, the original's frozen
   route and a new key, stamped after the compaction turn; it is claimed first.
   A message sent in the gap before the compaction turn, or during it, with and
   without `queued: true`, is admitted queued and follows the copy.
8. Settle `failed`: no copy, queue held, `lastErrorClass` `context_limit`. Stop
   with the row `requested` (no write reaches the provider), `running` (the
   turn is interrupted; the row settles `interrupted` when it ends), and racing
   a compaction that completes anyway (still `interrupted`, no copy):
   `lastError` restored, queue held.
9. Unresolved: `Unknown` keeps the gate (no claim, no promotion, admission
   queues) until the tagged turn completes, or until the session is stopped
   after 60 s without a turn. At the 15-minute bound the turn is interrupted,
   then the session stopped. A `turn.completed` carrying an earlier compaction
   id settles nothing.
10. Identity: a change of the thread's model or instance between the failure
    and the reopen does not change the target; the reopen uses the failed
    delivery's frozen launch; a live session on another instance or
    conversation settles `failed` without calling `compact`; a lost
    conversation fails instead of starting a new one.
11. Restart with a `requested`, a `running` and an `unresolved` row:
    reconciliation settles each `interrupted`, admits no copy, holds the
    queue, fails a guarded start, and the fake provider sees no write.
12. `thread.compact` is refused while running, while unsettled, when
    unsupported and with no saved conversation; accepted, it calls `compact`
    once.
13. Guard: a pending start at or above the threshold compacts first, once, then
    delivers; below it, or with no `autoCompactTokens`, it delivers directly;
    it does not compact again before an ordinary turn has run. A failed guard
    still delivers. A Stop before or during the guard compaction leaves the
    message `failed` and unclaimed in the `interrupted` session; Retry delivers
    it without a second compaction.
14. Profiler: a Codex and an OpenCode failed turn each record one
    `provider.turn-failed`; Claude records one, not two;
    `contextWindowExceeded` and `usageLimitExceeded` stay distinct, `APIError`
    becomes `api_error`, free text becomes `other`; `provider.compaction`
    carries no text.

Contracts: `rpcRustParity.test.ts` and `persistenceRustParity.test.ts` cover the
command, events, `compactionId` and column; `check:contracts` fixtures; an
older-client decode of a message with `resendOf`.

Web: `threadErrorCompactAction` keys on `supportsCompaction` and the snapshot's
`compaction`; `onCompactConversation` dispatches `thread.compact`, or `/compact`
against an older server; the composer requests queued admission while
`compaction` is set; the failed original shows its notice while
`compaction.failedMessageId` names it; `TurnDeliveryNotice` shows the copy text.

## Verification

- Focused Rust tests above, `cargo fmt --all --check`, Clippy with warnings
  denied for the server; `vp check`, `vp run typecheck`, focused web tests;
  `check:contracts`.
- Reviews: UI.md and `vercel-react-best-practices` for the banner, notice,
  composer and action changes.
- Manual, packaged app: the failure itself cannot be produced on demand with
  auto-compaction on, so recovery is proven by the fake-provider tests and one
  replay of the recorded #160 frames through the Claude adapter. Manually: with
  `DISABLE_AUTO_COMPACT=1` on the instance, a context-limit stop shows today's
  error and no recovery; **Compact conversation** compacts through
  `thread.compact` and shows the step; a thread over the guard threshold shows
  "Waiting for the conversation to be compacted." then the compaction, then the
  answer; Stop during that compaction leaves the message failed with Retry.

## Rollout

Three changes, each shippable: (1) the seam, tagged compaction turns, Claude
`compact`, manual `thread.compact`, and the shared Profiler recording; (2)
recovery; (3) the guard. No flag: capability and the provider's switch gate it.
Codex and OpenCode join when #163 and #164 advertise `supportsCompaction`, tag
their compaction turns and report the failure facts. The CHANGELOG's v0.11.0
known limitation is replaced by the new behavior.

## Risks

- **Duplicate meaning.** After compaction the provider sees the summary, which
  may mention the failed message, and the copy. This is Claude's own documented
  manual recovery ("Run `/compact` and send your message again").
- **Inferred semantics.** `rapid_refill_breaker` is undocumented; treating it as
  not compactable is conservative.
- **Cost.** Each recovery or guard spends one large compaction request; the
  guard spends it about 5% earlier than the provider would.
- **Revert counting.** A Codex compaction is a turn in Codex's history; #163
  must confirm "Revert to this message" counts it.
- **OpenCode.** Compaction "steers by default, at the next step boundary"; its
  behaviour on an idle session needs #164's fixtures, as does the assumption
  that its server ends with BiBCode.
- **Restart mid-recovery.** No copy exists yet, so after a restart the user
  compacts and resends by hand; the original stays in the thread to copy from.
- **Unconfirmed outcomes.** A thread whose compaction cannot be confirmed waits
  up to the bound, then loses its provider session; the next message resumes
  the saved conversation.
- **Older clients.** A start sent without `queued` during a compaction is
  queued anyway; an older client's optimistic message becomes a queue card.
- **Brief window.** Before the compaction turn starts, the banner is the main
  signal; a user who resends by hand gets a duplicate message, queued behind
  the copy.

## References

- Claude Code errors, "Prompt is too long":
  <https://code.claude.com/docs/en/errors#prompt-is-too-long>
- Auto-compact window, defaults and precedence:
  <https://code.claude.com/docs/en/model-config#set-the-auto-compact-window>
- `--autocompact`: <https://code.claude.com/docs/en/cli-reference>
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
  `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`:
  <https://code.claude.com/docs/en/env-vars>
- `autoCompactEnabled`: <https://code.claude.com/docs/en/settings-reference>
- `terminal_reason`, `local_command`, `SDKCompactBoundaryMessage`,
  `autoCompactThreshold`: <https://code.claude.com/docs/en/agent-sdk/typescript>
- Codex `thread/compact/start`:
  <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs>
- OpenCode 2.1.2 compaction endpoint and message shape: #164.

## Review

Codex reviewed the first draft on 2026-10-24. Each finding was checked against
the code at 4e023ac5ff before it was applied.

1. **The compaction turn takes the waiting message's turn marker** (major).
   Accepted. Admission creates the marker (`engine.rs:6168`) and the next
   running session update binds it whoever started the turn (`:6223`); the
   existing-turn branch also deletes it (`:6218`). Changed: the copy is admitted
   only when the compaction succeeds, and compaction turns carry `compactionId`
   so they neither bind nor delete a marker. The guarded message keeps its own.
2. **Stop does not stop a guarded message** (major). Accepted. The claim
   ignores `held` and accepts a pending start in an `interrupted` session
   (`repositories.rs:1074`), and the interrupt's hold skips pending starts
   (`:2866`). Changed: a stopped or restart-ended guard fails its message, so
   Retry is the explicit way to resume it, and a stopped guard rules out
   recovery. Tests cover Stop before, during and racing the compaction, and
   restart. `failed` was chosen over a held queue head so the message stays
   where the user saw it.
3. **Unknown outcomes release exclusivity too early** (major). Accepted.
   Changed: an `unresolved` state keeps the SQL gate until the tagged turn
   completes or the owning session ends; the bound interrupts and then stops
   that session; settlement matches compaction id and turn id. A dedicated
   `ProviderCompactionStart` replaces `ProviderDeliveryOutcome`.
4. **No stale-result protection for the compaction turn** (major). Accepted.
   Suppression applies only while a write awaits replay (`runtime.rs:2724`).
   Changed: the `/compact` write is registered for acknowledgement as an
   operation entry without an outbox row, its turn awaits its input, and only
   the matching `local_command` result ends it. Tests cover a resumed stale
   result and background-task follow-ups.
5. **Same conversation not enforced** (major). Accepted. Revert reopens from
   the thread's current configuration (`provider_runtime.rs:7855`); deliveries
   freeze theirs (`:1697`, `:4819`). Changed: the row records instance, kind
   and conversation; recovery and the guard reopen with the delivery's frozen
   launch and check the live identity before compacting; the copy reuses the
   frozen route; usage readings are tagged and must match.
6. **`identifier` discards Codex's failure reasons** (minor). Accepted with a
   change: a shared camelCase and PascalCase to snake_case normalizer runs
   before `identifier`, instead of a per-variant table, so unknown variants
   stay distinct too. Tests check that known variants stay distinct.

**Simpler alternative** (create the copy only in the successful settlement).
Accepted. It removes the pending copy during compaction, the timestamp repair
(the copy's own `thread.turn-start-requested` stamps it), the withdrawal
transition and the restart handling for an unsent copy. Its costs are covered
above: admission now queues starts while a compaction is unsettled so nothing
overtakes the copy, a notice on the original replaces the pending copy as the
signal, and after a restart mid-recovery the user resends by hand.
