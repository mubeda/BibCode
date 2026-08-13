# Cross-Provider Assistant Message Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve native assistant-message boundaries from Codex, Claude, and OpenCode while retaining deterministic one-message-per-turn behavior for Cursor and Grok.

**Architecture:** Provider runtimes carry an optional normalized `item_id` beside each assistant text or completion event. The production projector converts that provider identity into a thread-namespaced orchestration message ID, appends only same-ID deltas, and settles every existing streaming assistant record at terminal turn completion without fabricating empty rows. The React timeline remains unchanged because it already folds distinct settled interim messages and retains the final message.

**Tech Stack:** Rust 2024, Tokio, serde/serde_json, SQLite/rusqlite, React, TypeScript, Vite+, Vitest.

## Global Constraints

- Preserve provider-authored text exactly; do not insert whitespace or infer boundaries from punctuation, timing, tool calls, or chunk size.
- Keep `packages/contracts` schema-only; its existing optional `itemId` remains the public contract.
- Do not add a database migration or change persisted message shapes.
- Cursor and Grok must use one deterministic assistant message per ACP prompt turn until ACP exposes stable message identity.
- Do not change PowerShell or other fenced-code rendering.
- Previously merged persisted messages are not rewritten.
- Keep per-delta work allocation-only; add no per-delta database read, task, queue, or lock.
- Complete focused tests before broader validation and preserve unrelated worktree changes.

---

## File Map

- `apps/server/src/production/provider_runtime.rs`: shared `ProviderEvent` identity, orchestration message-ID resolution, provider adapter mappings, exact completion, and terminal settlement.
- `apps/server/src/production/operational_logs.rs`: initialize the new optional field in diagnostic-only provider event fixtures.
- `apps/server/src/provider/codex/runtime.rs`: extract Codex `params.itemId` and emit agent-message completion.
- `apps/server/src/provider/claude/canonical.rs`: carry optional item identity in Claude canonical events.
- `apps/server/src/provider/claude/runtime.rs`: track Claude `message_start.message.id` and attach it to assistant text.
- `apps/server/src/provider/opencode/runtime.rs`: attach OpenCode `messageID` to text and emit completion from terminal `message.updated` info.
- `apps/server/src/provider/cursor/runtime.rs`: align the internal runtime event with optional item identity while keeping ACP events unidentified.
- `apps/server/src/provider/grok/runtime.rs`: align the internal runtime event with optional item identity while keeping ACP events unidentified.
- `apps/server/tests/provider_codex.rs`: Codex native item-identity and completion regression.
- `apps/server/tests/provider_claude.rs`: Claude message-start identity regression.
- `apps/server/tests/provider_opencode.rs`: OpenCode per-message identity and completion regression.
- `apps/server/tests/provider_cursor.rs`: Cursor ACP fallback compatibility assertion.
- `apps/server/tests/provider_grok.rs`: Grok ACP fallback compatibility assertion.
- `apps/server/tests/production_provider_runtime.rs`: real provider-event to orchestration/SQLite boundary and lifecycle regression tests.
- `apps/server/tests/production_operational_logs.rs`: initialize the new optional field in integration fixtures.
- `docs/architecture/rpc-and-orchestration.md`: living invariant for provider assistant identity and terminal settlement.
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`: existing coverage proving settled interim messages fold and the terminal message remains visible; verification only.
- `apps/web/src/components/chat/MessagesTimeline.test.tsx`: existing rendered timeline coverage; verification only.

---

### Task 1: Add the normalized provider item-identity transport

**Files:**

- Modify: `apps/server/src/production/provider_runtime.rs:201-210, 3586-3600, 4493-4506, 4746-4758, 4945-4957, 5250-5264, 6910-6923, 7535-7548`
- Modify: `apps/server/src/provider/codex/runtime.rs:98-145`
- Modify: `apps/server/src/provider/claude/canonical.rs:1-45`
- Modify: `apps/server/src/provider/cursor/runtime.rs:38-100`
- Modify: `apps/server/src/provider/grok/runtime.rs:28-75`
- Modify: `apps/server/src/provider/opencode/runtime.rs:65-115`
- Modify: `apps/server/src/production/operational_logs.rs`
- Modify: `apps/server/tests/production_operational_logs.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`
- Modify: `apps/server/tests/provider_codex.rs`
- Modify: `apps/server/tests/provider_cursor.rs`
- Modify: `apps/server/tests/provider_grok.rs`
- Modify: `apps/server/tests/provider_opencode.rs`
- Test: `apps/server/src/production/provider_runtime.rs:10940-10975`

**Interfaces:**

- Produces: `ProviderEvent.item_id: Option<String>` and matching optional `item_id` fields on every provider runtime event.
- Produces: `assistant_message_id(event: &ProviderEvent) -> String`, resolving a valid native ID to `assistant:{threadId}:item:{itemId}` and unidentified events to `assistant:{threadId}:turn:{turnId}`.
- Consumes: existing contract semantics for optional camel-case `itemId`.

- [ ] **Step 1: Write failing resolver tests**

Add unit cases beside the existing `assistant_message_id` tests. Use literal expected IDs and construct real `ProviderEvent` values:

```rust
#[test]
fn assistant_message_ids_are_thread_namespaced_and_replay_stable() {
    let identified = ProviderEvent {
        native_event_id: None,
        event_type: "content.delta".to_owned(),
        thread_id: "thread-1".to_owned(),
        turn_id: Some("turn-1".to_owned()),
        item_id: Some("message-1".to_owned()),
        request_id: None,
        payload: json!({"streamKind":"assistant_text","delta":"First."}),
        activity: Vec::new(),
    };
    assert_eq!(
        assistant_message_id(&identified),
        "assistant:thread-1:item:message-1"
    );
    let other_thread = ProviderEvent {
        thread_id: "thread-2".to_owned(),
        ..identified.clone()
    };
    assert_eq!(
        assistant_message_id(&other_thread),
        "assistant:thread-2:item:message-1"
    );

    let unidentified = ProviderEvent {
        item_id: None,
        payload: json!({}),
        ..identified.clone()
    };
    assert_eq!(
        assistant_message_id(&unidentified),
        "assistant:thread-1:turn:turn-1"
    );
}

#[test]
fn malformed_provider_item_ids_use_the_turn_fallback() {
    for item_id in ["", "contains\ncontrol"] {
        let event = ProviderEvent {
            native_event_id: None,
            event_type: "content.delta".to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            item_id: Some(item_id.to_owned()),
            request_id: None,
            payload: json!({}),
            activity: Vec::new(),
        };
        assert_eq!(
            assistant_message_id(&event),
            "assistant:thread-1:turn:turn-1"
        );
    }

    let event = ProviderEvent {
        item_id: Some("x".repeat(513)),
        native_event_id: None,
        event_type: "content.delta".to_owned(),
        thread_id: "thread-1".to_owned(),
        turn_id: Some("turn-1".to_owned()),
        request_id: None,
        payload: json!({}),
        activity: Vec::new(),
    };
    assert_eq!(
        assistant_message_id(&event),
        "assistant:thread-1:turn:turn-1"
    );
}
```

The production change these tests catch is dropping thread namespacing, accepting malformed provider metadata, or reverting to turn-wide identity when a native item ID exists.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test -p bibcode-server assistant_message_ids_are_thread_namespaced_and_replay_stable --lib -- --nocapture
```

Expected: compilation fails because `ProviderEvent` has no `item_id` field, or the assertion reports the current turn-wide ID.

- [ ] **Step 3: Add optional item identity to internal event types**

Add a plain `pub item_id: Option<String>` field after `turn_id` on the non-serialized shared `ProviderEvent`. Add this serde-enabled field after `turn_id` on `RuntimeEvent`, `CanonicalEvent`, `CursorRuntimeEvent`, `GrokRuntimeEvent`, and `OpenCodeRuntimeEvent`:

```rust
#[serde(skip_serializing_if = "Option::is_none")]
pub item_id: Option<String>,
```

Add the same serde-enabled optional field to each provider's stable-view struct and copy it in `stable_view()`. Set `item_id: None` in every existing constructor that does not yet extract a native item ID, including activity-only events and all `ProviderEvent` fixtures in operational-log and provider-runtime tests. Map each provider event's field into `ProviderEvent.item_id` in every production driver; map `ClaudeCanonicalEvent.item_id` in `claude_provider_event`.

- [ ] **Step 4: Implement bounded namespaced resolution**

Replace the resolver with the exact precedence from the approved design:

```rust
const PROVIDER_ITEM_ID_MAX_CHARS: usize = 512;

fn valid_provider_item_id(item_id: Option<&str>) -> Option<&str> {
    let item_id = item_id?.trim();
    (!item_id.is_empty()
        && item_id.chars().count() <= PROVIDER_ITEM_ID_MAX_CHARS
        && !item_id.chars().any(char::is_control))
    .then_some(item_id)
}

fn assistant_message_id(event: &ProviderEvent) -> String {
    valid_provider_item_id(event.item_id.as_deref())
        .map(|item_id| format!("assistant:{}:item:{item_id}", event.thread_id))
        .or_else(|| {
            event
                .payload
                .get("messageId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|message_id| !message_id.is_empty())
                .map(str::to_owned)
        })
        .or_else(|| {
            event.turn_id.as_ref().map(|turn_id| {
                format!("assistant:{}:turn:{turn_id}", event.thread_id)
            })
        })
        .unwrap_or_else(|| format!("assistant:{}", event.thread_id))
}
```

- [ ] **Step 5: Run focused identity tests and formatting**

Run:

```bash
cargo test -p bibcode-server assistant_message_ids_ --lib -- --nocapture
cargo fmt --all --check
```

Expected: all identity tests pass and formatting exits zero.

- [ ] **Step 6: Commit the transport layer**

```bash
git add apps/server/src/production/provider_runtime.rs apps/server/src/production/operational_logs.rs apps/server/src/provider/codex/runtime.rs apps/server/src/provider/claude/canonical.rs apps/server/src/provider/cursor/runtime.rs apps/server/src/provider/grok/runtime.rs apps/server/src/provider/opencode/runtime.rs apps/server/tests/production_operational_logs.rs apps/server/tests/production_provider_runtime.rs apps/server/tests/provider_codex.rs apps/server/tests/provider_cursor.rs apps/server/tests/provider_grok.rs apps/server/tests/provider_opencode.rs
git commit -m "fix: carry provider assistant item identity"
```

---

### Task 2: Preserve Codex assistant items and exact completion

**Files:**

- Modify: `apps/server/src/provider/codex/runtime.rs:2160-2200, 2314-2340, 2946-2975`
- Test: `apps/server/tests/provider_codex.rs:2548-2770`

**Interfaces:**

- Consumes: `RuntimeEvent.item_id: Option<String>` from Task 1.
- Produces: Codex `content.delta` and `message.assistant.completed` events sharing the native `params.itemId`/`item.id`.

- [ ] **Step 1: Add a failing real-protocol regression**

Extend the Codex mock peer trace with two native assistant items:

```rust
.emit_notification(json!({
    "method": "item/agentMessage/delta",
    "params": {
        "threadId": "provider-thread-1",
        "turnId": "fixture-turn",
        "itemId": "commentary-1",
        "delta": "First."
    }
}))
.emit_notification(json!({
    "method": "item/completed",
    "params": {
        "threadId": "provider-thread-1",
        "turnId": "fixture-turn",
        "item": { "id": "commentary-1", "type": "agentMessage" }
    }
}))
.emit_notification(json!({
    "method": "item/agentMessage/delta",
    "params": {
        "threadId": "provider-thread-1",
        "turnId": "fixture-turn",
        "itemId": "final-1",
        "delta": "Second."
    }
}))
```

Assert the collected stable events contain these literal pairs in order:

```rust
assert_eq!(
    text_events
        .iter()
        .map(|event| (event.event_type.as_str(), event.item_id.as_deref()))
        .collect::<Vec<_>>(),
    vec![
        ("turn.started", None),
        ("content.delta", Some("commentary-1")),
        ("message.assistant.completed", Some("commentary-1")),
        ("content.delta", Some("final-1")),
        ("turn.completed", None),
    ]
);
```

The production change this test catches is discarding Codex `itemId` or continuing to ignore completed `agentMessage` items.

- [ ] **Step 2: Run the Codex regression and verify RED**

Run:

```bash
cargo test -p bibcode-server --test provider_codex session_runtime_matches_text_tool_and_approval_traces -- --exact --nocapture
```

Expected: event identity is `None`, the assistant-completed event is missing, or the stable trace length differs.

- [ ] **Step 3: Add an item-aware Codex emitter**

Keep the existing `emit` API for unidentified lifecycle events and have it delegate to:

```rust
async fn emit_with_item_id(
    &self,
    event_type: &str,
    turn_id: Option<String>,
    item_id: Option<String>,
    request_id: Option<String>,
    payload: Value,
)
```

Populate `RuntimeEvent.item_id` inside this helper. In `item/agentMessage/delta`, read non-empty `params.itemId` and emit assistant text with that ID. In `item/completed`, detect `item.type == "agentMessage"`, read `item.id`, and emit `message.assistant.completed` with the same ID. Keep the existing `command_item_event_payload` branch for `commandExecution` unchanged.

- [ ] **Step 4: Run Codex tests and verify GREEN**

Run:

```bash
cargo test -p bibcode-server --test provider_codex session_runtime_matches_text_tool_and_approval_traces -- --exact --nocapture
cargo test -p bibcode-server --test provider_codex codex_activity_text_deltas_are_replay_safe_across_completion -- --exact --nocapture
```

Expected: both tests pass with the native identities preserved.

- [ ] **Step 5: Commit the Codex mapping**

```bash
git add apps/server/src/provider/codex/runtime.rs apps/server/tests/provider_codex.rs packages/contracts/fixtures/codex-provider
git commit -m "fix: preserve Codex assistant message boundaries"
```

---

### Task 3: Track Claude message-start identity

**Files:**

- Modify: `apps/server/src/provider/claude/runtime.rs:250-370, 560-590, 780-850, 1039-1060`
- Test: `apps/server/tests/provider_claude.rs:2240-2400`

**Interfaces:**

- Consumes: `CanonicalEvent.item_id: Option<String>` from Task 1.
- Produces: every root Claude assistant text delta carries the most recent `message_start.message.id` for its turn.

- [ ] **Step 1: Write a failing Claude stream regression**

Create `claude_text_deltas_follow_message_start_identity` using the real `ClaudeProviderRuntime` and literal stream-json values:

```rust
let mut runtime = ClaudeProviderRuntime::new("thread-1".to_owned(), "session-1".to_owned());
runtime.start_turn(TurnInput {
    turn_id: "turn-1".to_owned(),
    input: "test boundaries".to_owned(),
});

for (message_id, text) in [("claude-message-1", "First."), ("claude-message-2", "Second.")] {
    runtime.handle_raw_value(&json!({
        "type": "stream_event",
        "session_id": "session-1",
        "uuid": format!("start-{message_id}"),
        "parent_tool_use_id": null,
        "event": { "type": "message_start", "message": { "id": message_id } }
    }), 1_000);
    let output = runtime.handle_raw_value(&json!({
        "type": "stream_event",
        "session_id": "session-1",
        "uuid": format!("delta-{message_id}"),
        "parent_tool_use_id": null,
        "event": {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": text }
        }
    }), 1_001);
    assert_eq!(output.events[0].item_id.as_deref(), Some(message_id));
}
```

Start `turn-2`, send a text delta without a new `message_start`, and assert `item_id == None`; this catches stale identity leaking across turns.

- [ ] **Step 2: Run the Claude regression and verify RED**

Run:

```bash
cargo test -p bibcode-server --test provider_claude claude_text_deltas_follow_message_start_identity -- --exact --nocapture
```

Expected: assistant text events have no item identity.

- [ ] **Step 3: Track identity in the Claude runtime**

Add `active_assistant_item_id: Option<String>` to `ClaudeProviderRuntime`, initialize it to `None`, and clear it in `start_turn`. In `StreamEvent::MessageStart`, assign `message.id` before emitting the existing thread-started event. Add an `item_event` helper that calls `event` and then assigns `CanonicalEvent.item_id`; use it only for `ContentBlockDelta::TextDelta` with `self.active_assistant_item_id.clone()`. Thinking, tool, plan, child-task, approval, and usage events retain `item_id: None`.

- [ ] **Step 4: Run Claude tests and verify GREEN**

Run:

```bash
cargo test -p bibcode-server --test provider_claude claude_text_deltas_follow_message_start_identity -- --exact --nocapture
cargo test -p bibcode-server --test provider_claude forwarded_text_is_suppressed_while_forwarded_task_lifecycle_stays_canonical -- --exact --nocapture
```

Expected: both tests pass and forwarded child text remains suppressed.

- [ ] **Step 5: Commit the Claude mapping**

```bash
git add apps/server/src/provider/claude/canonical.rs apps/server/src/provider/claude/runtime.rs apps/server/tests/provider_claude.rs
git commit -m "fix: preserve Claude assistant message boundaries"
```

---

### Task 4: Preserve OpenCode identity and characterize ACP fallbacks

**Files:**

- Modify: `apps/server/src/provider/opencode/runtime.rs:1390-1475, 1599-1625`
- Test: `apps/server/tests/provider_opencode.rs:6660-6770`
- Test: `apps/server/tests/provider_cursor.rs:180-280`
- Test: `apps/server/tests/provider_grok.rs:85-165`

**Interfaces:**

- Consumes: `OpenCodeRuntimeEvent.item_id`, `CursorRuntimeEvent.item_id`, and `GrokRuntimeEvent.item_id` from Task 1.
- Produces: OpenCode text/completion identity keyed by `messageID`/`info.id`.
- Preserves: Cursor and Grok assistant chunks carry no item identity and therefore use the shared turn fallback.

- [ ] **Step 1: Write a failing OpenCode identity regression**

Add two assistant `message.updated` plus `message.part.updated` pairs to the real root SSE runtime test. Use IDs `opencode-message-1` and `opencode-message-2`, texts `First.` and `Second.`, and a terminal update shaped as:

```rust
json!({
    "type": "message.updated",
    "properties": {
        "sessionID": "session-1",
        "info": {
            "id": "opencode-message-1",
            "sessionID": "session-1",
            "role": "assistant",
            "time": { "completed": 20 },
            "finish": "stop"
        }
    }
})
```

Assert text and completion events use the same native identity:

```rust
assert_eq!(
    events
        .iter()
        .filter(|event| {
            event.event_type == "content.delta"
                || event.event_type == "message.assistant.completed"
        })
        .map(|event| (event.event_type.as_str(), event.item_id.as_deref()))
        .collect::<Vec<_>>(),
    vec![
        ("content.delta", Some("opencode-message-1")),
        ("message.assistant.completed", Some("opencode-message-1")),
        ("content.delta", Some("opencode-message-2")),
    ]
);
```

- [ ] **Step 2: Run the OpenCode regression and verify RED**

Run:

```bash
cargo test -p bibcode-server --test provider_opencode root_assistant_text_preserves_message_identity_and_completion -- --exact --nocapture
```

Expected: the text event item IDs are `None` and the message-level completion is absent.

- [ ] **Step 3: Implement OpenCode item-aware emission**

Add `emit_with_item_id` with the same argument order as the Codex helper and keep `emit` delegating with `None`. In `message.part.updated`, pass the already-parsed `messageID`/`messageId` to the assistant text event. In `message.updated`, after recording an assistant `info.id`, emit `message.assistant.completed` with that ID when `info.time.completed` exists and is not null. Do not emit completion for user messages, child-session events routed to activity, or nonterminal assistant updates.

- [ ] **Step 4: Run OpenCode tests and verify GREEN**

Run:

```bash
cargo test -p bibcode-server --test provider_opencode root_assistant_text_preserves_message_identity_and_completion -- --exact --nocapture
cargo test -p bibcode-server --test provider_opencode opencode_runtime_matches_session_and_rollback_traces -- --exact --nocapture
```

Expected: OpenCode preserves both message IDs and existing cumulative-text delta behavior.

- [ ] **Step 5: Add explicit Cursor and Grok compatibility assertions**

In each existing ACP runtime trace, assert the assistant chunk has `item_id == None`, retains the exact provider text, and is followed by a `turn.completed` event for the same turn. These are characterization assertions for the protocol limitation, so they may pass immediately; they protect the deliberate one-message-per-turn fallback and require no Cursor/Grok production branch.

Run:

```bash
cargo test -p bibcode-server --test provider_cursor cursor_runtime_matches_approval_and_cancel_traces -- --exact --nocapture
cargo test -p bibcode-server --test provider_grok grok_runtime_matches_user_input_and_cancel_traces -- --exact --nocapture
```

Expected: both ACP provider tests pass without synthesized item IDs.

- [ ] **Step 6: Commit OpenCode and ACP coverage**

```bash
git add apps/server/src/provider/opencode/runtime.rs apps/server/tests/provider_opencode.rs apps/server/tests/provider_cursor.rs apps/server/tests/provider_grok.rs
git commit -m "fix: preserve OpenCode assistant message boundaries"
```

---

### Task 5: Settle real messages without creating blank fallbacks

**Files:**

- Modify: `apps/server/src/production/provider_runtime.rs:3361-3465`
- Test: `apps/server/tests/production_provider_runtime.rs:8789-8970`

**Interfaces:**

- Consumes: namespaced `assistant_message_id` from Task 1 and provider identities from Tasks 2-4.
- Produces: exact completion only for an existing assistant row; terminal completion for every streaming assistant row matching the event's thread and turn.

- [ ] **Step 1: Replace the single-message projection test with the failing boundary regression**

Rename it to `projects_distinct_provider_messages_and_settles_the_completed_turn`. Send these events through the real `ProviderRuntimeSupervisor` and SQLite-backed orchestration engine:

```rust
for event in [
    ProviderEvent {
        native_event_id: None,
        event_type: "content.delta".to_owned(),
        thread_id: "t1".to_owned(),
        turn_id: Some("provider-turn-1".to_owned()),
        item_id: Some("commentary-1".to_owned()),
        request_id: None,
        payload: json!({"streamKind":"assistant_text","delta":"First"}),
        activity: Vec::new(),
    },
    ProviderEvent {
        native_event_id: None,
        event_type: "content.delta".to_owned(),
        thread_id: "t1".to_owned(),
        turn_id: Some("provider-turn-1".to_owned()),
        item_id: Some("commentary-1".to_owned()),
        request_id: None,
        payload: json!({"streamKind":"assistant_text","delta":"."}),
        activity: Vec::new(),
    },
    ProviderEvent {
        native_event_id: None,
        event_type: "content.delta".to_owned(),
        thread_id: "t1".to_owned(),
        turn_id: Some("provider-turn-1".to_owned()),
        item_id: Some("final-1".to_owned()),
        request_id: None,
        payload: json!({"streamKind":"assistant_text","delta":"Second."}),
        activity: Vec::new(),
    },
    ProviderEvent {
        native_event_id: None,
        event_type: "turn.completed".to_owned(),
        thread_id: "t1".to_owned(),
        turn_id: Some("provider-turn-1".to_owned()),
        item_id: None,
        request_id: None,
        payload: json!({"state":"completed"}),
        activity: Vec::new(),
    },
] {
    events_tx.send(event).await.unwrap();
}
```

Assert exactly two assistant rows exist, their `(message_id, text, is_streaming)` values are:

```rust
vec![
    (
        "assistant:t1:item:commentary-1",
        "First.",
        false,
    ),
    (
        "assistant:t1:item:final-1",
        "Second.",
        false,
    ),
]
```

Also assert no row text equals `First.Second.`.

- [ ] **Step 2: Add a failing blank-completion regression**

Add `completion_without_assistant_text_does_not_create_a_message`. Send an exact `message.assistant.completed` event with `item_id: Some("empty-1")`, then a successful `turn.completed`, and assert the thread has no assistant message. This catches both the exact-completion insert and the successful-turn fallback insert.

Add `failed_and_interrupted_turns_settle_existing_assistant_messages`. For each terminal state `failed` and `interrupted`, create an isolated engine/supervisor, stream `Partial response` under a native item ID, send the terminal event, and assert that exact row remains present with unchanged text and `is_streaming == false`. For `failed`, also assert the existing provider error state remains populated.

- [ ] **Step 3: Run all three projection tests and verify RED**

Run:

```bash
cargo test -p bibcode-server --test production_provider_runtime projects_distinct_provider_messages_and_settles_the_completed_turn -- --exact --nocapture
cargo test -p bibcode-server --test production_provider_runtime completion_without_assistant_text_does_not_create_a_message -- --exact --nocapture
cargo test -p bibcode-server --test production_provider_runtime failed_and_interrupted_turns_settle_existing_assistant_messages -- --exact --nocapture
```

Expected: the first test finds a third blank fallback row and streaming native rows; the second finds an empty assistant row; the third leaves identified partial messages streaming and may add an unrelated fallback row.

- [ ] **Step 4: Implement thread-scoped terminal settlement**

In `project_provider_event`, remove the unconditional single `assistant_message_id` completion from the `turn.completed` prelude. After persisting runtime and session terminal state, call `list_messages_by_thread(event.thread_id.clone())`, then filter:

```rust
message.thread_id == event.thread_id
    && message.turn_id.as_ref() == event.turn_id.as_ref()
    && message.role == "assistant"
    && message.is_streaming
```

Dispatch `ThreadMessageAssistantComplete` once per match in repository order, using each existing `message.message_id`. Keep distinct command IDs by appending the loop index. When the list contains no match, dispatch no assistant command.

For `message.assistant.completed` and `assistant.message.completed`, resolve the namespaced message ID, call `get_message`, and dispatch completion only when the row exists, belongs to the event thread and turn, has role `assistant`, and is still streaming. Return without creating an orchestration message when it does not exist.

Keep session ready/error state, provider error activity, persisted runtime status, and turn terminal projection unchanged.

- [ ] **Step 5: Run lifecycle regressions and verify GREEN**

Run:

```bash
cargo test -p bibcode-server --test production_provider_runtime projects_distinct_provider_messages_and_settles_the_completed_turn -- --exact --nocapture
cargo test -p bibcode-server --test production_provider_runtime completion_without_assistant_text_does_not_create_a_message -- --exact --nocapture
cargo test -p bibcode-server --test production_provider_runtime failed_and_interrupted_turns_settle_existing_assistant_messages -- --exact --nocapture
cargo test -p bibcode-server --test production_provider_runtime failed_provider_completion_clears_running_state_and_preserves_the_error -- --exact --nocapture
```

Expected: distinct texts remain distinct, every streamed record is settled, textless completion creates no row, and failed turns retain their error state.

- [ ] **Step 6: Add and verify the unidentified ACP projection case**

Add `unidentified_provider_chunks_share_one_settled_turn_message`. Send two `content.delta` events with `item_id: None`, texts `hello ` and `from cursor`, followed by terminal completion. Assert one message exists with ID `assistant:t1:turn:provider-turn-1`, text `hello from cursor`, and `is_streaming == false`.

Run:

```bash
cargo test -p bibcode-server --test production_provider_runtime unidentified_provider_chunks_share_one_settled_turn_message -- --exact --nocapture
```

Expected: the characterization passes and proves Cursor/Grok fallback compatibility at the persistence seam.

- [ ] **Step 7: Commit the lifecycle fix**

```bash
git add apps/server/src/production/provider_runtime.rs apps/server/tests/production_provider_runtime.rs
git commit -m "fix: settle distinct assistant messages per turn"
```

---

### Task 6: Update the living invariant and run complete verification

**Files:**

- Modify: `docs/architecture/rpc-and-orchestration.md:74-100`
- Verify: `apps/web/src/components/chat/MessagesTimeline.logic.test.ts:506-610, 1119-1145`
- Verify: `apps/web/src/components/chat/MessagesTimeline.test.tsx:990-1060`

**Interfaces:**

- Consumes: the completed cross-provider runtime and projection behavior.
- Produces: living documentation and fresh validation evidence; no UI production change.

- [ ] **Step 1: Document the provider message invariant**

Add a subsection after “Provider turn flow” stating:

```markdown
### Assistant message identity

Provider assistant text preserves a native runtime `itemId` when the provider
exposes one. The server converts it to a thread-namespaced orchestration
message ID before persistence. Providers whose protocol does not expose a
message identity use one deterministic assistant message per thread turn.

Terminal turn projection completes every existing streaming assistant message
for that thread and turn and never creates an empty assistant message. The
client therefore receives the same message boundaries from live events and
reloaded SQLite projections; Markdown rendering does not infer or repair
provider message boundaries.
```

- [ ] **Step 2: Ensure JavaScript workspace dependencies are available**

Run the focused web command first. If it reports that workspace dependencies are missing, run `vp install` once and rerun the same command. Do not alter dependency declarations or accept lockfile drift.

```bash
vp test run --project unit apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/components/chat/MessagesTimeline.test.tsx
```

Expected: existing folding tests prove a settled interim assistant message is hidden behind the Worked-for row while the terminal message remains visible; the streaming-message case remains unfolded.

- [ ] **Step 3: Run focused provider and projection suites**

```bash
cargo test -p bibcode-server --test provider_codex
cargo test -p bibcode-server --test provider_claude
cargo test -p bibcode-server --test provider_opencode
cargo test -p bibcode-server --test provider_cursor
cargo test -p bibcode-server --test provider_grok
cargo test -p bibcode-server --test production_provider_runtime
```

Expected: every command exits zero with no failed tests.

- [ ] **Step 4: Run required repository quality gates**

```bash
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: all four commands exit zero without warnings promoted to errors.

- [ ] **Step 5: Run the broader affected package test graph**

```bash
vp run --filter bibcode test
vp run --filter @bibcode/web test
```

Expected: the server and web package scripts exit zero.

- [ ] **Step 6: Review the final patch and generated state**

```bash
git diff --check
git diff 49f1f768..HEAD --stat
git diff 49f1f768..HEAD -- apps/server/src apps/server/tests packages/contracts/fixtures docs/architecture docs/superpowers/plans
git status --short
rg -n '\[DEBUG-[^]]+\]' apps/server apps/web
```

Expected: no whitespace errors, no debug instrumentation, no `.codegraph/` or dependency drift, and only the planned source, test, fixture, and documentation files are changed since the approved-design commit.

- [ ] **Step 7: Commit documentation if it is not already included**

```bash
git add docs/architecture/rpc-and-orchestration.md
git commit -m "docs: define assistant message identity lifecycle"
```

- [ ] **Step 8: Report evidence and residual risk**

Report every exact command from Steps 2-5 with its exit status. State that new Codex, Claude, and OpenCode turns preserve native boundaries; Cursor and Grok remain one message per ACP turn; existing corrupted transcripts are unchanged; and any unavailable command remains an explicit residual risk rather than being described as passing.
