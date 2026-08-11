# Cross-Provider Assistant Message Boundaries Design

## Context

BiBCode currently projects every assistant text delta in a provider turn into a
single orchestration message unless the normalized event payload contains a
`messageId`. The provider runtimes do not preserve the native assistant item or
message identity in that payload, so the shared projector falls back to
`assistant:{turnId}`. Consecutive provider messages are therefore concatenated
without a boundary. A completed commentary message ending in `settings.` and a
later message beginning with `The` becomes `settings.The`.

This is visible in the Windows and macOS captures. It is not caused by a
Windows font, line-breaking, Markdown, or PowerShell code-block implementation.
Code blocks look correct because their source text is already contained in one
assistant item. The malformed prose has already been merged before it reaches
the web renderer.

The same identity loss also defeats the existing conversation timeline policy.
The UI can fold settled interim assistant messages under the turn's work log and
retain the final assistant message, but it cannot do so after those messages
have been persisted as one record.

The relevant existing boundaries are:

- provider runtimes in `apps/server` normalize native provider streams;
- the production provider supervisor maps normalized events to orchestration
  commands;
- orchestration owns persisted thread messages and streams their changes to the
  client;
- `apps/web` renders the resulting message records and already supports
  multiple assistant messages in one turn; and
- `packages/contracts` already defines optional `itemId` identity on a provider
  runtime event, so no new public concept is required.

## Goals

- Preserve assistant message boundaries for Codex, Claude, and OpenCode.
- Keep Cursor and Grok correct even though their current ACP text chunks expose
  no native assistant-message identifier.
- Prevent adjacent assistant messages from being concatenated without
  whitespace or paragraph structure.
- Preserve exact provider text; do not guess sentence boundaries or inject
  formatting characters into deltas.
- Settle every assistant message when a turn completes, fails, is interrupted,
  or ends after partial streaming.
- Avoid empty synthetic assistant messages on turns that produced no assistant
  text.
- Keep live and reloaded conversation projections equivalent.
- Retain the existing timeline behavior that folds interim messages and shows
  the final answer.

## Non-goals

- Reformatting provider-authored Markdown.
- Inserting spaces after punctuation with a text heuristic.
- Changing fonts, line heights, wrapping, code-block styling, or platform CSS.
- Recovering boundaries in already-corrupted persisted transcripts. Historical
  merged messages remain readable but cannot be split reliably after the native
  identities have been discarded.
- Inferring unsupported message boundaries from Cursor or Grok prose.
- Changing database schemas or persisted message shapes.
- Changing tool-call, approval, reasoning, or activity rendering.

## Ownership and Dependency Direction

`apps/server` owns this fix because provider normalization and orchestration
projection are the first shared boundaries at which native identity can be
preserved. Provider-specific runtimes extract identity from their protocols.
The shared production adapter transports it without provider-specific parsing.
The orchestration projector remains the source of truth for message persistence
and terminal settlement.

`apps/web` remains a consumer of orchestration messages. It will receive
multiple assistant message records where it previously received one merged
record, but its timeline and reducer require no new formatting policy.

`packages/contracts` remains schema-only. Its runtime-event base already has an
optional `itemId`; implementation types in Rust will be aligned with that
contract rather than adding `messageId` to provider-specific payloads.

There is no desktop bridge change. The behavior is identical in browser, Tauri,
Windows, macOS, Linux, WSL, SSH, and relay deployments because all normal
conversation traffic continues to use the typed server protocol.

## Normalized Identity Model

Add optional `item_id` identity to the internal Rust runtime event types and the
shared `ProviderEvent`. Serialized stable views expose it as the existing
camel-case `itemId` field only when present. Activity-only and lifecycle events
leave it absent.

The projection table keys messages globally, so native IDs are converted into a
thread-namespaced orchestration ID. The shared assistant-message ID resolver
applies this order:

1. a valid normalized `item_id` becomes
   `assistant:{threadId}:item:{itemId}`;
2. the legacy non-empty payload `messageId` is treated as an already-normalized
   orchestration ID, retained only as an input compatibility path for existing
   test or adapter events;
3. `assistant:{threadId}:turn:{turnId}` is used when the provider protocol has
   no item identity; and
4. `assistant:{threadId}` is used only for malformed legacy events with no
   turn.

The normalized item ID must be non-empty, at most 512 characters, and free of
control characters. A malformed native ID is ignored and uses the deterministic
turn fallback. This keeps provider-controlled metadata bounded while preserving
replay behavior for ACP providers.

## Provider Mapping

### Codex

`item/agentMessage/delta` includes `params.itemId`. The Codex runtime attaches
that value to every normalized assistant `content.delta` event. An
`item/completed` notification whose item type is `agentMessage` emits an exact
`message.assistant.completed` event with the same item ID. Command-execution
item behavior is unchanged.

This supports multiple commentary and final-answer items in a single Codex turn
without combining them. Duplicate native completion notifications remain safe
because orchestration completion is idempotent.

### Claude

Each Claude `message_start` stream event includes `message.id`. The Claude
runtime stores that ID as the active assistant message for the current turn and
attaches it to subsequent assistant text deltas. A later `message_start`
replaces the active ID, as occurs when Claude resumes after a tool round. Turn
start clears stale active-message state.

Claude's currently supported stream protocol does not expose a dedicated
message-stop event. The shared terminal turn cleanup therefore settles every
streaming assistant message in the turn when the Claude result arrives. Tool,
thinking, child-task suppression, and plan events remain unchanged.

### OpenCode

OpenCode `message.part.updated` text parts include `messageID` (with the existing
`messageId` spelling accepted defensively). The runtime attaches that ID to the
emitted assistant delta. The corresponding assistant `message.updated` event
already identifies `info.id`; when `info.time.completed` is present, it emits an
exact assistant completion for that message.

The existing per-message cumulative-text map continues to calculate deltas.
Preserving the same key in the normalized event ensures two OpenCode assistant
messages in one session turn become two orchestration messages.

### Cursor

Cursor's current ACP `agent_message_chunk` payload contains text but no message
or item identifier. Cursor therefore intentionally uses the deterministic
`assistant:{turnId}` fallback and produces one assistant message per ACP prompt
turn. The prompt completion event settles that message through shared terminal
cleanup.

No punctuation, timing, tool call, or chunk-size heuristic is used to invent
boundaries. If a future ACP version exposes an item identity, Cursor can attach
it to the same normalized field without changing orchestration or the UI.

### Grok

Grok uses the same current ACP text-chunk shape as Cursor and follows the same
one-message-per-turn fallback and terminal settlement rules. Grok receives
explicit regression coverage so the cross-provider change cannot accidentally
create blank messages, change chunk concatenation, or leave a message
streaming.

## Projection and Lifecycle

Assistant deltas are projected with the resolved message ID. Deltas carrying
the same identity append exactly as they do today. A new identity creates a new
assistant record even when its `turnId` matches an earlier record.

Exact `message.assistant.completed` events complete only their identified
record. If no text delta created that record, the completion is ignored rather
than inserting an empty assistant message. At every `turn.completed`, the
projector lists the messages for that thread, selects assistant messages for
the completed turn that are still streaming, and completes them in persisted
chronological order. It does not create a fallback message when no matching
assistant content exists.

Terminal cleanup is deliberately shared and authoritative because it covers:

- providers without a message-completed signal;
- interrupted and failed turns;
- partial streams where a native completion notification was lost;
- adapter restarts after deltas were persisted; and
- duplicate completion signals.

The query is once per terminal turn, not once per delta. It uses the existing
thread-scoped message repository and filters by turn, role, and streaming state.
The event pump processes provider events in order, so all earlier deltas have
been projected before terminal cleanup runs. This avoids a hot-path database
read and preserves predictable behavior under long streams.

The session status and turn terminal state continue to be persisted even when
no assistant text exists. Failed turns still surface their provider error. The
only removed behavior is the creation or completion of a nonexistent synthetic
assistant row.

## UI Behavior

No whitespace is inserted by the UI. The live reducer receives distinct
message IDs and keeps their text separate. After terminal settlement, the
existing message timeline can fold earlier commentary entries under the work
log and display the final assistant message as normal prose. A reload produces
the same result from SQLite because message identity is persisted at the server
boundary.

PowerShell and other fenced code blocks continue through the same Markdown
renderer without changes.

## Failure, Replay, and Concurrency Behavior

- Empty or missing native identity uses the deterministic fallback rather than
  creating an unaddressable record.
- Duplicate deltas retain existing provider replay and native-event deduplication
  behavior; this change does not introduce content-level deduplication.
- Duplicate exact or terminal completion commands are idempotent.
- A failed or interrupted turn completes already-streamed assistant messages and
  does not fabricate response text.
- A turn with several identified messages settles all remaining streaming
  records, so the timeline never keeps an earlier commentary record live after
  the turn is terminal.
- Events remain serialized by the provider event pump; no new task, queue, or
  lock is introduced.
- Native identity is validated and bounded before it becomes a projection key.
  Provider IDs are metadata, not authorization inputs, filesystem paths,
  commands, or log content.

## Performance and Storage

The per-delta cost is one optional string carried through existing event
objects. There is no text clone beyond the existing delta and message update
path, no Markdown preprocessing, and no additional client-side state source.

Terminal cleanup adds one thread-scoped message-list read per completed turn.
It replaces the current failed-turn global snapshot lookup and avoids using the
global snapshot on successful turns. No migration is needed because the
projection table already stores arbitrary message IDs and multiple messages per
turn.

## Testing Strategy

Provider-runtime tests will prove native extraction:

- Codex preserves two different `itemId` values and emits exact completion for
  an `agentMessage` item;
- Claude assigns text to each `message_start` ID and resets identity between
  turns;
- OpenCode preserves two different `messageID` values and emits completion from
  terminal `message.updated` info;
- Cursor keeps multiple chunks in one deterministic turn message without
  inventing boundaries; and
- Grok has the same ACP fallback guarantee.

Production projection tests will run normalized provider events through the
real orchestration engine and SQLite repository. They will assert that:

- `First.` and `Second.` from two native message IDs persist as two records,
  never `First.Second.`;
- same-ID deltas still append exactly;
- successful, failed, and interrupted terminal events settle every assistant
  message in their turn;
- a textless terminal turn creates no assistant row; and
- fallback ACP events create and settle exactly one assistant record.

Web timeline/reducer coverage will assert the end-user outcome: two settled
assistant records in one turn retain the final message and fold the interim
message, while a code block remains unchanged. Existing cross-platform CSS
snapshots are not the primary regression test because the defect occurs before
rendering.

Focused provider and projection tests will run first. Completion validation
also includes the affected server suite, web timeline tests, `vp check`,
`vp run typecheck`, `cargo fmt --all --check`, and Clippy for the affected Rust
targets with warnings denied.

## Alternatives Considered

### Insert a space or blank line while concatenating messages

Rejected. The projector cannot distinguish a provider message boundary from a
normal streaming delta after identity is lost. A space heuristic can corrupt
Markdown, code, URLs, punctuation, and non-Latin text while still leaving
commentary and final answers as one semantic message.

### Fix Codex only

Rejected. Codex exposed the reported defect, but OpenCode and Claude also expose
native identities that their current adapters discard. A provider-specific
patch would leave the shared invariant false and invite the same bug elsewhere.

### Split text in the web renderer

Rejected. The client has no reliable boundary evidence, live and reloaded state
could diverge, and other consumers of persisted conversations would retain the
corruption.

### Synthesize multiple Cursor and Grok messages around tools

Rejected. Current ACP chunks provide no contract that a tool transition or
pause marks a new assistant message. One deterministic message per prompt turn
is lossless and forward-compatible.

## Documentation Impact and Residual Risk

The living provider-runtime documentation will be updated with the normalized
assistant identity and terminal settlement invariant. No public API or database
documentation changes are required.

The main residual risk is historical data: previously merged message text
cannot be separated safely. Cursor and Grok will continue to show one assistant
message per ACP turn until their protocol supplies a stable message identity.
These are explicit protocol limitations rather than renderer fallbacks.
