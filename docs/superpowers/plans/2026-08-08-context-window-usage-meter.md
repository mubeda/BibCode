# Context Window Usage Meter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible chat-toolbar context-window meter that reports native Codex and Claude usage, remains disabled for unsupported providers, and survives duplicate delivery, reconnect, restart, compaction, and revert.

**Architecture:** Codex and Claude adapters normalize native usage into the existing `thread.token-usage.updated` contract. The server projects that event as bounded `context-window.updated` thread activity, the client reducer mirrors the retention rule, and the web renders unsupported, awaiting, and measured states from provider capability plus the latest valid snapshot. Claude uses the official response-correlated `get_context_usage` control frame after successful completion and falls back to bounded last-good stream usage when the query is unsupported, rejected, cancelled, or timed out.

**Tech Stack:** Rust 2024, Tokio, Serde/serde_json, rusqlite, React 19, TypeScript, Effect Schema, Tailwind CSS, Vite+, pnpm/Vite+ (`vp`).

## Global Constraints

- The normal composer order is MCP, context window, send/stop; the context control remains rendered even when unsupported or awaiting data.
- Only Codex and Claude advertise `supportsContextWindowUsage`; Cursor, Grok, and OpenCode remain disabled.
- `usedTokens` is active context; `totalProcessedTokens` is lifetime/accumulated processing. Never substitute one for the other.
- Do not estimate tokens from transcript text, model names, character counts, or a frontend tokenizer.
- Provider usage is observational: query/parser failure must never fail or indefinitely delay a turn.
- Preserve root-thread, turn, provider-instance, reconnect, restart, duplicate-delivery, and checkpoint-revert boundaries.
- Keep at most one valid projected/live context activity per thread and turn; malformed rows cannot evict a valid row.
- Do not add a production Node runtime, desktop bridge call, database schema migration, UI framework, icon dependency, or second usage cache.
- Do not edit `.repos/` or `.codegraph/`; no dependency version changes are planned, so no vendored subtree sync is required.
- When provider semantics or retention details become uncertain during execution, re-open the corresponding T3Code source under `/Users/admin/projects/t3code` before deciding, then confirm the result against BiBCode's boundary and the provider's authoritative protocol.
- Keep raw prompts, provider responses, environment variables, and authentication material out of diagnostics.
- Follow strict red-green-refactor: write each behavioral test first, run it and observe the expected failure, then write the minimum implementation.
- The approved design is `docs/superpowers/specs/2026-08-08-context-window-usage-meter-design.md`.

---

## File Map

### Contracts and capability publication

- Modify `packages/contracts/src/server.ts`: add the optional provider capability.
- Modify `packages/contracts/src/server.test.ts`: prove absent/true/false decoding.
- Modify `apps/server/src/production/provider_inventory.rs`: publish support only for Codex and Claude and test the matrix.

### Codex provider normalization

- Modify `apps/server/src/provider/codex/runtime.rs`: normalize root `thread/tokenUsage/updated` notifications into canonical usage events and add focused unit coverage beside the private helper.
- Modify `apps/server/tests/provider_codex.rs`: exercise observable runtime event ordering and root/child filtering with the existing scripted App Server peer.

### Claude provider normalization and control transport

- Create `apps/server/src/provider/claude/usage.rs`: own bounded last-good usage parsing, merge rules, clamping, and deduplication.
- Modify `apps/server/src/provider/claude/mod.rs`: register the private usage module.
- Modify `apps/server/src/provider/claude/runtime.rs`: attach usage state to the provider runtime, emit stream-derived canonical events before completion, encode official control request frames, and merge query responses.
- Modify `apps/server/src/provider/claude/protocol.rs`: decode response-correlated `control_response` frames without treating them as chat messages.
- Modify `apps/server/src/production/provider_runtime.rs`: route Claude control responses, issue a bounded completion query, defer completion only until query settlement, and clean up pending waiters.
- Modify `apps/server/tests/fixtures/claude-provider/control-requests.json`: update control request fixtures to the official top-level request ID shape and add `get_context_usage`.
- Create `apps/server/tests/fixtures/claude-provider/context-usage.json`: store complete message-delta, task, compact-boundary, result, query-success, query-error, and malformed samples.
- Modify `apps/server/tests/provider_claude.rs`: assert stream normalization, official wire encoding, query merge/deduplication, and fallback behavior.

### Projection and client state

- Modify `apps/server/src/production/provider_runtime.rs`: map canonical usage to an unwrapped info activity and drop malformed canonical usage rather than genericizing it.
- Modify `apps/server/src/orchestration/engine.rs`: replace earlier valid same-turn context projection rows transactionally and test turn/revert boundaries.
- Modify `packages/client-runtime/src/state/threadReducer.ts`: mirror latest-valid same-turn retention for live events.
- Modify `packages/client-runtime/src/state/threadReducer.test.ts`: prove valid replacement, malformed preservation, duplicate handling, and other-turn retention.

### Web presentation

- Modify `apps/web/src/lib/contextWindow.ts`: sanitize invalid optional values while deriving the latest snapshot.
- Modify `apps/web/src/lib/contextWindow.test.ts`: cover invalid maximum/category values and latest-valid scanning.
- Modify `apps/web/src/components/chat/ContextWindowMeter.tsx`: render unsupported, awaiting, and measured states from capability plus nullable usage.
- Modify `apps/web/src/components/chat/ContextWindowMeter.test.tsx`: exercise the real component's state, accessibility, popover, progress, and warning behavior.
- Modify `apps/web/src/components/chat/ChatComposer.tsx`: always place the meter after MCP and before primary actions.
- Modify `apps/web/src/components/chat/ChatComposer.test.tsx`: prove provider gating, nullable usage forwarding, and exact toolbar order.

### Living documentation

- Modify `docs/architecture/providers.md`.
- Modify `docs/architecture/rpc-and-orchestration.md`.
- Modify `docs/providers/codex.md`.
- Modify `docs/providers/claude.md`.
- Modify `docs/user/workspace-ui.md`.

---

### Task 1: Publish the provider capability contract

**Files:**
- Modify: `packages/contracts/src/server.ts:173-200`
- Modify: `packages/contracts/src/server.test.ts:42-73`
- Modify: `apps/server/src/production/provider_inventory.rs:1547-1582`
- Test: `apps/server/src/production/provider_inventory.rs:1870-1910`

**Interfaces:**
- Consumes: Existing `ServerProvider` provider-instance snapshots.
- Produces: `ServerProvider.supportsContextWindowUsage?: boolean`; exact selected-instance capability consumed by `ChatComposer` in Task 6.

- [ ] **Step 1: Install the already-locked workspace dependencies**

Run:

```bash
vp install
```

Expected: installation succeeds without changing `package.json`, `pnpm-lock.yaml`, or catalog manifests. Review `git status --short` immediately and preserve only the already committed design/plan history.

- [ ] **Step 2: Write the failing contract decoding test**

Extend the existing compatibility test in `packages/contracts/src/server.test.ts` with literal expectations:

```ts
it("keeps old snapshots compatible and decodes context-usage capability", () => {
  expect(decodeServerProvider(baseProviderSnapshot).supportsContextWindowUsage).toBeUndefined();
  expect(
    decodeServerProvider({
      ...baseProviderSnapshot,
      supportsContextWindowUsage: true,
    }).supportsContextWindowUsage,
  ).toBe(true);
  expect(
    decodeServerProvider({
      ...baseProviderSnapshot,
      supportsContextWindowUsage: false,
    }).supportsContextWindowUsage,
  ).toBe(false);
});
```

- [ ] **Step 3: Write the failing inventory matrix test**

Replace the narrow MCP-only fixture assertion with a test that constructs all five built-in definitions and asserts literal capabilities:

```rust
assert_eq!(codex["supportsContextWindowUsage"], true);
assert_eq!(claude["supportsContextWindowUsage"], true);
assert!(cursor.get("supportsContextWindowUsage").is_none());
assert!(grok.get("supportsContextWindowUsage").is_none());
assert!(opencode.get("supportsContextWindowUsage").is_none());
```

Keep the existing independent assertion that only Codex advertises `supportsMcpStatus`.

- [ ] **Step 4: Run both focused tests and observe the missing-field failures**

Run:

```bash
vp test packages/contracts/src/server.test.ts
cargo test -p bibcode-server production::provider_inventory::tests::codex_and_claude_inventory_advertise_context_usage
```

Expected: the TypeScript test fails because the schema strips the new field; the Rust test fails because neither snapshot publishes it.

- [ ] **Step 5: Add the schema field and inventory publication**

Add beside `supportsMcpStatus`:

```ts
supportsContextWindowUsage: Schema.optional(Schema.Boolean),
```

Publish capability from the inventory without deriving it from installed state:

```rust
if matches!(definition.driver.as_str(), "codex" | "claudeAgent") {
    result["supportsContextWindowUsage"] = json!(true);
}
```

- [ ] **Step 6: Run the focused tests to green**

Run the two commands from Step 4.

Expected: both pass; legacy snapshots still decode with `undefined`.

- [ ] **Step 7: Commit the capability slice**

```bash
git add packages/contracts/src/server.ts packages/contracts/src/server.test.ts apps/server/src/production/provider_inventory.rs
git commit -m "feat: publish context usage capability"
```

---

### Task 2: Normalize Codex App Server token usage

**Files:**
- Modify: `apps/server/src/provider/codex/runtime.rs:2060-2180`
- Test: `apps/server/src/provider/codex/runtime.rs` private test module
- Test: `apps/server/tests/provider_codex.rs:2535-2750`

**Interfaces:**
- Consumes: Codex notification `thread/tokenUsage/updated` with `{ threadId, turnId, tokenUsage: { last, total, modelContextWindow } }`.
- Produces: canonical `RuntimeEvent` type `thread.token-usage.updated`, scoped to the root thread and native turn, with `payload: { usage: ThreadTokenUsageSnapshot-compatible JSON }`.

- [ ] **Step 1: Write failing normalization tests beside the private helper**

Define the expected helper interface in the test first:

```rust
#[test]
fn token_usage_normalization_separates_active_and_lifetime_totals() {
    let params = json!({
        "threadId": "root-1",
        "turnId": "turn-1",
        "tokenUsage": {
            "last": {
                "inputTokens": 1_000,
                "cachedInputTokens": 500,
                "outputTokens": 50,
                "reasoningOutputTokens": 25,
                "totalTokens": 1_075
            },
            "total": {
                "inputTokens": 9_000,
                "cachedInputTokens": 5_000,
                "outputTokens": 800,
                "reasoningOutputTokens": 400,
                "totalTokens": 10_200
            },
            "modelContextWindow": 258_400
        }
    });

    let (turn_id, payload) = normalize_token_usage_notification(&params, "root-1")
        .expect("valid root usage");
    assert_eq!(turn_id.as_deref(), Some("turn-1"));
    assert_eq!(payload, json!({
        "usage": {
            "usedTokens": 1_075,
            "totalProcessedTokens": 10_200,
            "maxTokens": 258_400,
            "inputTokens": 1_000,
            "cachedInputTokens": 500,
            "outputTokens": 50,
            "reasoningOutputTokens": 25,
            "lastUsedTokens": 1_075,
            "lastInputTokens": 1_000,
            "lastCachedInputTokens": 500,
            "lastOutputTokens": 50,
            "lastReasoningOutputTokens": 25,
            "compactsAutomatically": true
        }
    }));
}
```

Add table cases proving a child `threadId`, zero/missing `last.totalTokens`, and negative values return `None`, while malformed optional categories are omitted from a valid sample.

- [ ] **Step 2: Run the private-helper tests and observe the missing helper failure**

Run:

```bash
cargo test -p bibcode-server provider::codex::runtime::tests::token_usage_normalization
```

Expected: compile failure because `normalize_token_usage_notification` does not exist.

- [ ] **Step 3: Implement the pure normalizer**

Add a private helper returning the native turn and already-wrapped canonical payload:

```rust
fn normalize_token_usage_notification(
    params: &Value,
    root_thread_id: &str,
) -> Option<(Option<String>, Value)>;
```

Use `Value::as_u64` for every non-negative integer, require root `threadId` equality and `last.totalTokens > 0`, copy optional positive `modelContextWindow`, and populate each category from `last`. Populate `totalProcessedTokens` only from `total.totalTokens`; never sum categories to invent a total.

- [ ] **Step 4: Run the helper tests to green**

Run the command from Step 2.

Expected: all normalization boundary cases pass.

- [ ] **Step 5: Write the failing observable runtime test**

In `apps/server/tests/provider_codex.rs`, extend the existing `scripted_peer()` turn trace with these two complete notifications before `turn/completed`:

```rust
.emit_notification(json!({
    "method": "thread/tokenUsage/updated",
    "params": {
        "threadId": "provider-thread-1",
        "turnId": "fixture-turn",
        "tokenUsage": {
            "last": { "totalTokens": 1_075 },
            "total": { "totalTokens": 10_200 },
            "modelContextWindow": 258_400
        }
    }
}))
.emit_notification(json!({
    "method": "thread/tokenUsage/updated",
    "params": {
        "threadId": "child-1",
        "turnId": "child-turn",
        "tokenUsage": {
            "last": { "totalTokens": 999_999 },
            "total": { "totalTokens": 999_999 },
            "modelContextWindow": 1_000_000
        }
    }
}))
```

Assert the collected root events contain exactly one token event before `turn.completed`, with root turn ID and the literal active/lifetime values, and contain no payload value `999_999`.

- [ ] **Step 6: Run the observable test and observe the missing event**

Run:

```bash
cargo test -p bibcode-server --test provider_codex root_token_usage_notifications_are_normalized_and_child_usage_is_ignored
```

Expected: failure because the runtime currently drops both notification methods.

- [ ] **Step 7: Route the normalized event after the existing child/root filter**

Add the match branch before turn completion handling:

```rust
"thread/tokenUsage/updated" => {
    let root_thread_id = self
        .inner
        .session
        .lock()
        .await
        .resume_cursor
        .clone();
    if let Some(root_thread_id) = root_thread_id {
        if let Some((turn_id, payload)) =
            normalize_token_usage_notification(&params, &root_thread_id)
        {
            self.emit("thread.token-usage.updated", turn_id, None, payload)
                .await;
        }
    }
}
```

Absence simply emits nothing. Do not move the branch ahead of the established verified-child and foreign-thread returns.

- [ ] **Step 8: Run Codex focused tests to green**

Run:

```bash
cargo test -p bibcode-server provider::codex::runtime::tests::token_usage_normalization
cargo test -p bibcode-server --test provider_codex root_token_usage_notifications_are_normalized_and_child_usage_is_ignored
```

Expected: both pass and existing trace order remains unchanged except for the new usage event in the amended fixture.

- [ ] **Step 9: Commit the Codex slice**

```bash
git add apps/server/src/provider/codex/runtime.rs apps/server/tests/provider_codex.rs
git commit -m "feat: normalize Codex context usage"
```

---

### Task 3: Normalize Claude stream and result usage

**Files:**
- Create: `apps/server/src/provider/claude/usage.rs`
- Create: `apps/server/tests/fixtures/claude-provider/context-usage.json`
- Modify: `apps/server/src/provider/claude/mod.rs:1-20`
- Modify: `apps/server/src/provider/claude/runtime.rs:1-360, 620-850`
- Test: `apps/server/tests/provider_claude.rs`

**Interfaces:**
- Consumes: raw Claude stream-json frames and completion-query response bodies.
- Produces: `ClaudeTokenUsageSnapshot`, `ClaudeTokenUsageState::observe_stream_value`, and `ClaudeTokenUsageState::observe_context_response`; runtime method `apply_context_usage_response(turn_id, response)` used by Task 4.

- [ ] **Step 1: Add the complete Claude usage fixture**

Create `context-usage.json` with named values matching real stream-json shapes:

```json
{
  "messageDelta": {
    "type": "stream_event",
    "session_id": "session-1",
    "uuid": "message-1",
    "parent_tool_use_id": null,
    "event": {
      "type": "message_delta",
      "delta": { "stop_reason": "end_turn" },
      "usage": {
        "input_tokens": 1000,
        "cache_creation_input_tokens": 200,
        "cache_read_input_tokens": 300,
        "output_tokens": 50
      }
    }
  },
  "taskProgress": {
    "type": "system",
    "subtype": "task_progress",
    "session_id": "session-1",
    "task_id": "task-1",
    "usage": { "total_tokens": 1800, "tool_uses": 4, "duration_ms": 900 }
  },
  "compactBoundary": {
    "type": "system",
    "subtype": "compact_boundary",
    "session_id": "session-1",
    "compact_metadata": { "pre_tokens": 190000, "post_tokens": 24000 }
  },
  "result": {
    "type": "result",
    "subtype": "success",
    "is_error": false,
    "errors": [],
    "stop_reason": "end_turn",
    "session_id": "session-1",
    "uuid": "result-1",
    "usage": { "total_tokens": 42000 },
    "modelUsage": { "claude-sonnet": { "contextWindow": 200000 } }
  },
  "querySuccess": {
    "totalTokens": 31251,
    "maxTokens": 200000,
    "rawMaxTokens": 200000,
    "percentage": 15.6255,
    "model": "claude-sonnet",
    "isAutoCompactEnabled": true,
    "categories": [],
    "memoryFiles": [],
    "mcpTools": [],
    "agents": [],
    "gridRows": []
  },
  "malformed": { "totalTokens": -1, "maxTokens": 0, "isAutoCompactEnabled": "yes" }
}
```

- [ ] **Step 2: Write failing fixture-driven runtime tests**

Add tests that feed the real raw values through `ClaudeProviderRuntime::handle_raw_value` after `start_turn` and assert:

```rust
assert_eq!(message_delta.events[0].event_type, "thread.token-usage.updated");
assert_eq!(message_delta.events[0].payload["usage"]["usedTokens"], 1_550);
assert_eq!(task_progress.events[0].payload["usage"]["toolUses"], 4);
assert_eq!(compact.events[0].payload["usage"]["usedTokens"], 24_000);
assert_eq!(compact.events[0].payload["usage"]["lastUsedTokens"], 190_000);
assert_eq!(result.events.last().expect("completion").event_type, "turn.completed");
assert_eq!(result.events[0].payload["usage"]["usedTokens"], 24_000);
assert_eq!(result.events[0].payload["usage"]["totalProcessedTokens"], 42_000);
assert_eq!(result.events[0].payload["usage"]["maxTokens"], 200_000);
```

The result assertion proves accumulated `42_000` does not replace the post-compaction active `24_000`. Add a second test proving malformed/empty frames emit no usage and do not clear the last-good sample.
Add a third case with `parent_tool_use_id: "child-tool"` and assert its
message-delta usage emits no root usage event.

- [ ] **Step 3: Run the Claude usage tests and observe the missing events**

Run:

```bash
cargo test -p bibcode-server --test provider_claude claude_stream_usage_preserves_active_context_and_accumulated_total
cargo test -p bibcode-server --test provider_claude malformed_claude_usage_cannot_clear_last_good_context
```

Expected: failures because raw system/message-delta usage is ignored and `ResultMessage` discards usage fields.

- [ ] **Step 4: Implement the bounded usage state in the new module**

Define these exact private interfaces:

```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeTokenUsageSnapshot {
    pub used_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_processed_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_uses: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compacts_automatically: Option<bool>,
}

#[derive(Debug, Default)]
pub(crate) struct ClaudeTokenUsageState {
    last_good: Option<ClaudeTokenUsageSnapshot>,
    total_processed_tokens: Option<u64>,
    max_tokens: Option<u64>,
    last_emitted: Option<ClaudeTokenUsageSnapshot>,
}

impl ClaudeTokenUsageState {
    pub(crate) fn observe_stream_value(
        &mut self,
        value: &Value,
    ) -> Option<ClaudeTokenUsageSnapshot>;

    pub(crate) fn observe_context_response(
        &mut self,
        value: &Value,
    ) -> Option<ClaudeTokenUsageSnapshot>;
}
```

Use named parsing helpers equivalent to T3Code's proven behavior:

```rust
fn non_negative_integer(value: Option<&Value>) -> Option<u64>;
fn positive_integer(value: Option<&Value>) -> Option<u64>;
fn usage_input_tokens(usage: &serde_json::Map<String, Value>) -> u64;
fn usage_output_tokens(usage: &serde_json::Map<String, Value>) -> u64;
fn usage_total_tokens(usage: &serde_json::Map<String, Value>) -> Option<u64>;
fn max_model_context_window(value: &Value) -> Option<u64>;
```

Reject values above JavaScript's maximum safe integer. Clamp active tokens to a known maximum. Ignore stream-event usage whose `parent_tool_use_id` is non-null. A `result.usage.total_tokens` updates only `total_processed_tokens` unless the result carries a real active iteration/input/output sample. Task progress may advance active context monotonically before compaction; compact boundary post-tokens may reduce it. Return `None` when the merged snapshot equals `last_emitted`.

- [ ] **Step 5: Attach usage state to `ClaudeProviderRuntime`**

Add `token_usage: ClaudeTokenUsageState` to the runtime and initialize it with `Default::default()`. In `handle_raw_value_inner`, observe the raw value before typed deserialization while the current turn ID still exists, then prepend a canonical usage event to any normal output:

```rust
let token_usage = self.token_usage.observe_stream_value(value);
let turn_id = self.current_turn_id.clone();
let mut output = self.handle_non_usage_raw_value(value, emitted_at_ms, authenticated_hook);
if let (Some(turn_id), Some(usage)) = (turn_id, token_usage) {
    output.events.insert(0, self.token_usage_event(turn_id, usage));
}
output
```

Extract the current body into a private helper so there is one hook/activity path. Add:

```rust
pub(crate) fn apply_context_usage_response(
    &mut self,
    turn_id: &str,
    response: &Value,
) -> Option<CanonicalEvent>;
```

It delegates to `observe_context_response` and emits `thread.token-usage.updated` with `payload: { "usage": snapshot }`.

- [ ] **Step 6: Run the Claude usage tests to green**

Run the two commands from Step 3 plus:

```bash
cargo test -p bibcode-server --test provider_claude fixture_tool_streams_decode_to_canonical_events
```

Expected: usage tests pass and existing tool-stream behavior is unchanged.

- [ ] **Step 7: Commit the Claude normalization slice**

```bash
git add apps/server/src/provider/claude/usage.rs apps/server/src/provider/claude/mod.rs apps/server/src/provider/claude/runtime.rs apps/server/tests/fixtures/claude-provider/context-usage.json apps/server/tests/provider_claude.rs
git commit -m "feat: normalize Claude context usage"
```

---

### Task 4: Add Claude's response-correlated completion query

**Files:**
- Modify: `apps/server/src/provider/claude/protocol.rs:1-130`
- Modify: `apps/server/src/provider/claude/runtime.rs:65-125`
- Modify: `apps/server/src/provider/claude/mod.rs:14-25`
- Modify: `apps/server/src/production/provider_runtime.rs:5260-5330, 5840-6200, 6300-6870`
- Modify: `apps/server/tests/fixtures/claude-provider/control-requests.json`
- Test: `apps/server/tests/provider_claude.rs:1750-1795`
- Test: `apps/server/src/production/provider_runtime.rs` private test module

**Interfaces:**
- Consumes: official control request `{ type, request_id, request }` and response `{ type: "control_response", response: { subtype, request_id, response|error } }`.
- Produces: `ClaudeControlRequest::get_context_usage(sequence)`, a bounded `ClaudeControlResponseRouter`, and completion ordering `stream usage -> query usage when changed -> turn.completed`.

Official references:
- `https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py` (`_send_control_request` and response routing).
- `https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py` (`ContextUsageResponse`).

- [ ] **Step 1: Update the failing wire fixture and serialization test**

Change each fixture to the official full frame and add the query:

```json
{
  "interrupt": {
    "type": "control_request",
    "request_id": "bibcode-17",
    "request": { "subtype": "interrupt" }
  },
  "setPermissionMode": {
    "type": "control_request",
    "request_id": "bibcode-18",
    "request": { "subtype": "set_permission_mode", "mode": "acceptEdits" }
  },
  "cancelToolCall": {
    "type": "control_request",
    "request_id": "bibcode-19",
    "request": { "subtype": "cancel_request", "request_id": "approval:1001" }
  },
  "getContextUsage": {
    "type": "control_request",
    "request_id": "bibcode-20",
    "request": { "subtype": "get_context_usage" }
  }
}
```

Extend `control_requests_encode_interrupt_permission_mode_and_cancel_frames` to assert `ClaudeControlRequest::get_context_usage(20)` and rename the test to include context usage.

- [ ] **Step 2: Run the wire test and observe the old nested shape failure**

Run:

```bash
cargo test -p bibcode-server --test provider_claude control_requests_encode_official_correlated_frames
```

Expected: failure because the current type serializes `{ sequence, request }` and production wraps it under another `request` field.

- [ ] **Step 3: Encode the official request and response types**

Replace the request struct with:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaudeControlRequest {
    #[serde(rename = "type")]
    message_type: String,
    request_id: String,
    request: ControlRequestBody,
}
```

All constructors set `message_type` to `control_request` and `request_id` to `format!("bibcode-{sequence}")`. Add `GetContextUsage` to `ControlRequestBody`, `get_context_usage(sequence)`, and `request_id(&self) -> &str`.

In `protocol.rs`, add response decoding:

```rust
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ClaudeControlResponseFrame {
    pub response: ClaudeControlResponse,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ClaudeControlResponse {
    pub subtype: String,
    pub request_id: String,
    #[serde(default)]
    pub response: Value,
    pub error: Option<String>,
}
```

Re-export `ClaudeControlResponseFrame` from `claude/mod.rs` as `pub(crate)` so
the production driver can route the wire frame without exposing it outside the
server crate.

- [ ] **Step 4: Update existing control writers and run the wire test to green**

Serialize the complete request directly:

```rust
self.write_json(serde_json::to_value(request).map_err(provider_error(&self.provider))?)
    .await
```

Apply this to permission mode and interrupt. Preserve `control_response` writes used to answer CLI-originated permission/user-input requests; those are the opposite protocol direction.

Run the command from Step 2.

Expected: pass with unique top-level correlation IDs.

- [ ] **Step 5: Write failing router lifecycle tests**

In the private `provider_runtime.rs` tests, exercise real oneshot routing with literal frames:

```rust
let router = ClaudeControlResponseRouter::default();
let registration = router.register("bibcode-20".to_owned()).expect("registration");
assert!(!router.route(&json!({
    "type": "control_response",
    "response": { "subtype": "success", "request_id": "other", "response": {} }
})));
assert!(router.route(&json!({
    "type": "control_response",
    "response": {
        "subtype": "success",
        "request_id": "bibcode-20",
        "response": { "totalTokens": 31251, "maxTokens": 200000, "isAutoCompactEnabled": true }
    }
})));
assert_eq!(registration.receive().await.expect("response")["totalTokens"], 31_251);
```

Add tests proving error responses settle with an error category, dropping a timed-out registration removes it, and `close()` settles all pending waiters without retaining senders.

- [ ] **Step 6: Run router tests and observe the missing router failure**

Run:

```bash
cargo test -p bibcode-server production::provider_runtime::claude_control_response_tests
```

Expected: compile failure because the router does not exist.

- [ ] **Step 7: Implement the bounded control response router**

Add a cloneable router backed by:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClaudeControlQueryError {
    Remote,
    Closed,
}

Arc<StdMutex<HashMap<String, oneshot::Sender<Result<Value, ClaudeControlQueryError>>>>>
```

Use these exact interfaces:

```rust
impl ClaudeControlResponseRouter {
    fn register(
        &self,
        request_id: String,
    ) -> Option<ClaudeControlResponseRegistration>;
    fn route(&self, value: &Value) -> bool;
    fn close(&self);
}

impl ClaudeControlResponseRegistration {
    async fn receive(self) -> Result<Value, ClaudeControlQueryError>;
}
```

`register` rejects duplicate IDs and returns a registration whose `Drop` removes its own still-pending ID. `route` returns `true` for every syntactically valid `control_response`, including an unmatched late response, so such frames never become chat/provider activities. `close` drains the map and sends `Closed` to each waiter.

- [ ] **Step 8: Run router tests to green**

Run the command from Step 6.

Expected: matching success/error, unmatched, drop cleanup, and close cleanup pass.

- [ ] **Step 9: Write failing completion-query ordering and timeout tests**

Add private tests around this extracted async helper:

```rust
async fn query_claude_context_usage(
    provider: &str,
    writer: &Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    responses: &ClaudeControlResponseRouter,
    cancellation: &CancellationToken,
    sequence: u64,
    timeout: Duration,
) -> Option<Value>;
```

One test writes a query to a Tokio duplex stream, routes a matching success frame, and asserts the query body plus returned response. A second leaves the response pending and asserts a 10 ms timeout returns `None` and the router pending count returns to zero.

Add a runtime-level assertion using Task 3's state:

```rust
let queried = runtime.apply_context_usage_response("turn-1", &query_success)
    .expect("authoritative query changes snapshot");
assert_eq!(queried.event_type, "thread.token-usage.updated");
assert_eq!(queried.payload["usage"]["usedTokens"], 31_251);
assert_eq!(queried.payload["usage"]["compactsAutomatically"], true);
assert!(runtime.apply_context_usage_response("turn-1", &query_success).is_none());
```

Add driver-policy tests proving failed and interrupted `turn.completed` events are returned without writing `get_context_usage`; only successful completion enters the query path.

- [ ] **Step 10: Run the query tests and observe missing query/order behavior**

Run:

```bash
cargo test -p bibcode-server production::provider_runtime::claude_context_query_tests
cargo test -p bibcode-server --test provider_claude authoritative_context_query_is_deduplicated
```

Expected: failures because no query is written/routed and no completion augmentation exists.

- [ ] **Step 11: Integrate the bounded query into `ClaudeDriver`**

Add:

```rust
const CLAUDE_CONTEXT_QUERY_TIMEOUT: Duration = Duration::from_secs(2);
```

Give the driver a `control_responses: ClaudeControlResponseRouter` and `deferred_events: Mutex<VecDeque<ProviderEvent>>`. Pass the router into `spawn_claude_output`; the stdout loop calls `route(&value)` before `emit_claude_value` and continues when it returns `true`.

Factor canonical-to-provider conversion out of `emit_claude_value` into one helper so query-derived and stream-derived events have identical scope and payload mapping.

In `next_event`:

1. return a deferred event first;
2. receive the next normal event;
3. for successful `turn.completed` with a turn ID, call the bounded query;
4. pass a successful body to `runtime.apply_context_usage_response`;
5. when that returns a usage event, defer completion and return usage first;
6. on error, timeout, cancellation, or unchanged usage, return completion immediately.

Do not query failed or interrupted completions. Shutdown closes the router before joining output tasks.

- [ ] **Step 12: Run Claude transport and usage tests to green**

Run:

```bash
cargo test -p bibcode-server production::provider_runtime::claude_control_response_tests
cargo test -p bibcode-server production::provider_runtime::claude_context_query_tests
cargo test -p bibcode-server --test provider_claude control_requests_encode_official_correlated_frames
cargo test -p bibcode-server --test provider_claude authoritative_context_query_is_deduplicated
cargo test -p bibcode-server --test provider_claude claude_stream_usage_preserves_active_context_and_accumulated_total
```

Expected: all pass; timeout coverage proves completion is bounded and router cleanup proves no waiter leak.

- [ ] **Step 13: Commit the Claude control slice**

```bash
git add apps/server/src/provider/claude/protocol.rs apps/server/src/provider/claude/runtime.rs apps/server/src/provider/claude/mod.rs apps/server/src/production/provider_runtime.rs apps/server/tests/fixtures/claude-provider/control-requests.json apps/server/tests/provider_claude.rs
git commit -m "feat: query Claude context usage"
```

---

### Task 5: Project and retain latest valid per-turn usage

**Files:**
- Modify: `apps/server/src/production/provider_runtime.rs:3360-3565`
- Test: `apps/server/src/production/provider_runtime.rs:10070-10180`
- Modify: `apps/server/src/orchestration/engine.rs:3083-3120`
- Test: `apps/server/src/orchestration/engine.rs` test module near projector tests
- Modify: `packages/client-runtime/src/state/threadReducer.ts:25-60, 458-470`
- Test: `packages/client-runtime/src/state/threadReducer.test.ts` activity tests

**Interfaces:**
- Consumes: canonical `ProviderEvent` type `thread.token-usage.updated` with `payload.usage`.
- Produces: info activity `{ kind: "context-window.updated", summary: "Context window updated", payload: usage }`; latest-valid same-turn projection/reducer behavior.

- [ ] **Step 1: Write the failing canonical projection test**

Using the existing in-memory orchestration engine helper, project:

```rust
ProviderEvent {
    native_event_id: None,
    event_type: "thread.token-usage.updated".to_owned(),
    thread_id: "t1".to_owned(),
    turn_id: Some("turn-1".to_owned()),
    request_id: None,
    payload: json!({
        "usage": {
            "usedTokens": 1_075,
            "totalProcessedTokens": 10_200,
            "maxTokens": 258_400,
            "compactsAutomatically": true
        }
    }),
    activity: Vec::new(),
}
```

Load the real snapshot and assert literal `tone`, `kind`, `summary`, `turnId`, and unwrapped payload. Project a second event with `{ "usage": {} }` and assert no generic `provider.event` activity is added.

- [ ] **Step 2: Run the projection test and observe generic activity output**

Run:

```bash
cargo test -p bibcode-server production::provider_runtime::tests::provider_projection_maps_context_usage
```

Expected: failure because token usage currently maps to the generic provider activity shape and keeps the `usage` envelope.

- [ ] **Step 3: Implement strict usage activity projection**

Add a pure sanitizer:

```rust
fn context_window_activity_payload(payload: &Value) -> Option<Value>;
```

Require `payload.usage.usedTokens` as a non-negative integer. Clone only contract fields; omit optional non-integers, negative values, and non-positive `maxTokens`. Preserve a boolean `compactsAutomatically`. Special-case the event before `event_activity_shape` and dispatch `ThreadActivityAppend` with info tone, exact summary, and unwrapped sanitized payload. Return `Ok(())` without a command for malformed canonical usage.

- [ ] **Step 4: Run the projection test to green**

Run the command from Step 2.

Expected: one correctly shaped context activity and no malformed generic activity.

- [ ] **Step 5: Write failing durable projector retention tests**

Use a file-backed temporary SQLite database. Within one transaction, apply
literal activities in this order:

1. valid turn-1 usage `1000`;
2. malformed turn-1 usage without `usedTokens`;
3. valid turn-0 usage `500`;
4. valid turn-1 usage `2000`.

Commit, close the database/engine, reopen it from the same temporary path, and
load the real thread snapshot. Assert IDs are exactly malformed turn-1, valid
turn-0, and latest valid turn-1; this is the restart/reconnect evidence. Then
apply the existing revert event past turn-1 and assert only turn-0 remains.

- [ ] **Step 6: Run the projector retention test and observe duplicate valid rows**

Run:

```bash
cargo test -p bibcode-server orchestration::engine::tests::context_window_projection_keeps_latest_valid_per_turn
```

Expected: failure because the projector currently upserts only by unique activity ID.

- [ ] **Step 7: Add transactional same-turn replacement**

Before inserting a resolvable context activity, execute a bounded delete in the same transaction:

```sql
DELETE FROM projection_thread_activities
WHERE thread_id = ?1
  AND turn_id IS ?2
  AND kind = 'context-window.updated'
  AND json_type(payload_json, '$.usedTokens') IN ('integer', 'real')
  AND json_extract(payload_json, '$.usedTokens') >= 0
```

Run it only when the incoming activity kind is `context-window.updated` and its payload has a non-negative numeric `usedTokens`. An incoming malformed row is inserted for forward-compatible audit display but does not delete valid state.

- [ ] **Step 8: Run durable projector tests to green**

Run the command from Step 6.

Expected: valid rows are bounded per turn, malformed rows cannot evict, and existing revert behavior removes reverted turns.

- [ ] **Step 9: Write failing client reducer parity tests**

Port T3Code's independently derived behavior cases into `threadReducer.test.ts`:

```ts
expect(idsAfterValidReplacement).toEqual([
  "activity-other-turn",
  "activity-cw-malformed",
  "activity-cw-latest",
]);
expect(idsAfterMalformedUpdate).toEqual([
  "activity-cw-valid",
  "activity-cw-malformed-new",
]);
expect(idsAfterExactDuplicate).toEqual(["activity-cw-latest"]);
```

Use literal activities with real contract brands. The test should fail if replacement ignores turn ID, treats malformed data as resolvable, or leaves two valid rows for one turn.

- [ ] **Step 10: Run the reducer tests and observe duplicate rows**

Run:

```bash
vp test packages/client-runtime/src/state/threadReducer.test.ts
```

Expected: the new tests fail because the reducer removes only matching activity IDs.

- [ ] **Step 11: Port the T3Code resolvable-context retention rule**

Add the exact validity helper:

```ts
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") return false;
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}
```

When the incoming activity is resolvable, filter both its exact ID and every earlier resolvable context activity whose `turnId` equals the incoming `turnId`; otherwise retain the generic exact-ID replacement behavior. Append and sort once.

- [ ] **Step 12: Run all retention tests to green**

Run:

```bash
cargo test -p bibcode-server production::provider_runtime::tests::provider_projection_maps_context_usage
cargo test -p bibcode-server orchestration::engine::tests::context_window_projection_keeps_latest_valid_per_turn
vp test packages/client-runtime/src/state/threadReducer.test.ts
```

Expected: all pass.

- [ ] **Step 13: Commit the projection/state slice**

```bash
git add apps/server/src/production/provider_runtime.rs apps/server/src/orchestration/engine.rs packages/client-runtime/src/state/threadReducer.ts packages/client-runtime/src/state/threadReducer.test.ts
git commit -m "feat: retain latest context usage per turn"
```

---

### Task 6: Render the persistent toolbar control

**Files:**
- Modify: `apps/web/src/lib/contextWindow.ts:1-125`
- Test: `apps/web/src/lib/contextWindow.test.ts`
- Modify: `apps/web/src/components/chat/ContextWindowMeter.tsx:1-130`
- Test: `apps/web/src/components/chat/ContextWindowMeter.test.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.tsx:360-430, 900-930`
- Test: `apps/web/src/components/chat/ChatComposer.test.tsx:970-1035, 1260-1310`

**Interfaces:**
- Consumes: `selectedProviderStatus?.supportsContextWindowUsage === true` and nullable `ContextWindowSnapshot` derived from active thread activities.
- Produces: `ContextWindowMeter({ supported, usage, providerDisplayName })` with unsupported, awaiting, and measured presentation.

- [ ] **Step 1: Write failing derivation sanitization tests**

Change the existing invalid-capacity expectation and add a latest-valid case:

```ts
expect(
  deriveLatestContextWindowSnapshot([
    makeActivity("valid", "context-window.updated", { usedTokens: 5, maxTokens: 100 }),
    makeActivity("malformed", "context-window.updated", { usedTokens: -1 }),
  ]),
).toMatchObject({ usedTokens: 5, maxTokens: 100 });

expect(
  deriveLatestContextWindowSnapshot([
    makeActivity("invalid-optional", "context-window.updated", {
      usedTokens: 5,
      maxTokens: 0,
      totalProcessedTokens: -1,
      inputTokens: Number.NaN,
      compactsAutomatically: "yes",
    }),
  ]),
).toMatchObject({
  usedTokens: 5,
  maxTokens: null,
  totalProcessedTokens: null,
  remainingTokens: null,
  usedPercentage: null,
  inputTokens: null,
  compactsAutomatically: false,
});
```

- [ ] **Step 2: Run derivation tests and observe the invalid maximum failure**

Run:

```bash
vp test apps/web/src/lib/contextWindow.test.ts
```

Expected: failure because `maxTokens: 0` currently survives as zero and produces `remainingTokens: 0`.

- [ ] **Step 3: Sanitize optional values in the pure helper**

Add separate readers:

```ts
function asNonNegativeFiniteNumber(value: unknown): number | null;
function asPositiveFiniteNumber(value: unknown): number | null;
```

Use the positive reader for `maxTokens`, the non-negative reader for token/category/duration fields, and keep reverse scanning past malformed required usage. Do not change zero `usedTokens` validity.

- [ ] **Step 4: Run derivation tests to green**

Run the command from Step 2.

Expected: pass.

- [ ] **Step 5: Write failing real-component tests for all three meter states**

Update the test render helper to accept `supported` and nullable usage. Add literal assertions:

```tsx
expect(render({ supported: false, usage: null })).toContain('aria-disabled="true"');
expect(render({ supported: false, usage: null })).toContain(
  "Context window usage unavailable",
);
expect(render({ supported: false, usage: null })).not.toContain("Awaiting context usage");

expect(render({ supported: true, usage: null })).toContain(
  "Context window usage awaiting data",
);
expect(render({ supported: true, usage: null })).toContain("Awaiting context usage");
expect(render({ supported: true, usage: usage() })).toContain("Context window 50% used");
```

Assert the unsupported variant renders a tooltip but no Popover wrapper/trigger, awaiting uses a neutral ring without progressbar, and measured retains hover/click popover behavior and the over-90-percent warning.

- [ ] **Step 6: Run meter tests and observe the required-prop/null failures**

Run:

```bash
vp test apps/web/src/components/chat/ContextWindowMeter.test.tsx
```

Expected: failure because the component requires measured usage and has no unsupported/awaiting variants.

- [ ] **Step 7: Implement the three-state meter**

Change the public props exactly:

```ts
export function ContextWindowMeter(props: {
  supported: boolean;
  usage: ContextWindowSnapshot | null;
  providerDisplayName?: string | null;
})
```

Extract one ring renderer so its 24 px geometry and focus treatment remain stable. For unsupported state, render a focusable button with `aria-disabled="true"`, no click handler, and a `Tooltip` explaining `Context usage is not available for this provider.` Do not wrap it in `Popover`.

For supported/null, render the normal `Popover` with neutral ring, accessible name `Context window usage awaiting data`, heading `Context Window`, and body `Awaiting context usage. Usage will appear after the first provider response.` Do not render a progressbar or zero token count.

For measured usage, retain existing percentage formatting, 150 ms intentional hover, click support, token/max formatting, optional total, optional compaction guidance, clamping, reduced-motion transitions, and warning color above 90 percent.

- [ ] **Step 8: Run meter and derivation tests to green**

Run:

```bash
vp test apps/web/src/components/chat/ContextWindowMeter.test.tsx apps/web/src/lib/contextWindow.test.ts
```

Expected: pass.

- [ ] **Step 9: Write failing composer capability and order tests**

Replace the current measured-only order test with assertions that cover:

```ts
expect(findCapture("ContextWindowMeter")["supported"]).toBe(true);
expect(findCapture("ContextWindowMeter")["usage"]).toMatchObject({ usedTokens: 50 });
expect(mcpIndex).toBeLessThan(contextIndex);
expect(contextIndex).toBeLessThan(primaryIndex);
```

Add a table for Cursor, Grok, and OpenCode with no usage activities; each must capture one meter with `{ supported: false, usage: null }`. Add Codex/Claude awaiting cases with capability true and no activity; each must capture `{ supported: true, usage: null }`.
Add an unsupported-provider case with a stale measured context activity and
assert the meter still receives `supported: false`; rendering tests prove the
unsupported branch ignores the non-null usage and cannot open the popover.

- [ ] **Step 10: Run composer tests and observe hidden/wrong-order failures**

Run:

```bash
vp test apps/web/src/components/chat/ChatComposer.test.tsx
```

Expected: unsupported/awaiting cases fail because no meter renders; measured ordering fails because context currently precedes MCP.

- [ ] **Step 11: Always pass capability and nullable usage in the required order**

Compute:

```ts
const supportsContextWindowUsage =
  selectedProviderStatus?.supportsContextWindowUsage === true;
```

Render footer controls in this exact sequence:

```tsx
{props.isPreparingWorktree ? (
  <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
) : null}
{props.activeMcpStatus ? <McpStatusPopover snapshot={props.activeMcpStatus} /> : null}
<ContextWindowMeter
  supported={props.supportsContextWindowUsage}
  usage={props.activeContextWindow}
  providerDisplayName={props.activeThreadProviderDisplayName}
/>
<ComposerPrimaryActions
  compact={props.compact}
  pendingAction={props.pendingAction}
  isRunning={props.isRunning}
  canCancelPendingSend={props.canCancelPendingSend}
  showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
  promptHasText={props.promptHasText}
  isSendBusy={props.isSendBusy}
  isConnecting={props.isConnecting}
  isEnvironmentUnavailable={props.isEnvironmentUnavailable}
  sendBlockedReason={props.sendBlockedReason}
  isPreparingWorktree={props.isPreparingWorktree}
  hasSendableContent={props.hasSendableContent}
  preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
  onPreviousPendingQuestion={props.onPreviousPendingQuestion}
  onInterrupt={props.onInterrupt}
  onImplementPlanInNewThread={props.onImplementPlanInNewThread}
/>
```

Add `supportsContextWindowUsage: boolean` to the footer props and pass it from `ChatComposer`. Keep the specialized approval/question footer unchanged because it has no MCP/send pair.

- [ ] **Step 12: Run all web focused tests to green**

Run:

```bash
vp test apps/web/src/lib/contextWindow.test.ts apps/web/src/components/chat/ContextWindowMeter.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx
```

Expected: all pass.

- [ ] **Step 13: Commit the web slice**

```bash
git add apps/web/src/lib/contextWindow.ts apps/web/src/lib/contextWindow.test.ts apps/web/src/components/chat/ContextWindowMeter.tsx apps/web/src/components/chat/ContextWindowMeter.test.tsx apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/ChatComposer.test.tsx
git commit -m "feat: show persistent context usage meter"
```

---

### Task 7: Align living documentation and run completion gates

**Files:**
- Modify: `docs/architecture/providers.md`
- Modify: `docs/architecture/rpc-and-orchestration.md`
- Modify: `docs/providers/codex.md`
- Modify: `docs/providers/claude.md`
- Modify: `docs/user/workspace-ui.md`

**Interfaces:**
- Consumes: implemented provider capability, native normalization, projection retention, and UI state behavior from Tasks 1-6.
- Produces: living documentation that states the current architecture and user-visible behavior; final repository evidence.

- [ ] **Step 1: Update provider architecture documentation**

In `docs/architecture/providers.md`, document:

- `supportsContextWindowUsage` is instance metadata owned by inventory;
- Codex and Claude are the only initial providers;
- canonical active/lifetime semantics;
- Claude control-query timeout/fallback and nonfatal failure boundary;
- provider events stay on server-owned process and typed orchestration paths.

- [ ] **Step 2: Update orchestration lifecycle documentation**

In `docs/architecture/rpc-and-orchestration.md`, add the canonical-to-activity flow and state that the append-only event log is preserved while durable/client snapshots retain the latest valid context activity per turn. State that malformed rows do not evict valid rows and revert remains turn-scoped.

- [ ] **Step 3: Update provider-specific documentation**

In `docs/providers/codex.md`, record `last.totalTokens` as active, `total.totalTokens` as lifetime processed, `modelContextWindow` as maximum, root-only filtering, and automatic compaction.

In `docs/providers/claude.md`, record the official response-correlated `get_context_usage` query, `totalTokens`, `maxTokens`, `isAutoCompactEnabled`, the two-second bound, stream/result fallback, last-good behavior, and the rule that accumulated result totals never replace active context.

- [ ] **Step 4: Update user workspace documentation**

In `docs/user/workspace-ui.md`, document MCP -> context -> send ordering and the unsupported, awaiting, and measured states, including the disabled provider matrix and warning treatment above 90 percent.

- [ ] **Step 5: Run all focused TypeScript tests**

```bash
vp test packages/contracts/src/server.test.ts packages/client-runtime/src/state/threadReducer.test.ts apps/web/src/lib/contextWindow.test.ts apps/web/src/components/chat/ContextWindowMeter.test.tsx apps/web/src/components/chat/ChatComposer.test.tsx
```

Expected: pass.

- [ ] **Step 6: Run all focused Rust tests**

```bash
cargo test -p bibcode-server provider::codex::runtime::tests::token_usage_normalization
cargo test -p bibcode-server --test provider_codex root_token_usage_notifications_are_normalized_and_child_usage_is_ignored
cargo test -p bibcode-server --test provider_claude claude_stream_usage_preserves_active_context_and_accumulated_total
cargo test -p bibcode-server --test provider_claude authoritative_context_query_is_deduplicated
cargo test -p bibcode-server production::provider_runtime::claude_control_response_tests
cargo test -p bibcode-server production::provider_runtime::claude_context_query_tests
cargo test -p bibcode-server production::provider_runtime::tests::provider_projection_maps_context_usage
cargo test -p bibcode-server orchestration::engine::tests::context_window_projection_keeps_latest_valid_per_turn
cargo test -p bibcode-server production::provider_inventory::tests::codex_and_claude_inventory_advertise_context_usage
```

Expected: pass.

- [ ] **Step 7: Run formatting and affected Rust lint gates**

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: both pass with no warnings.

- [ ] **Step 8: Run repository-required checks**

```bash
vp check
vp run typecheck
```

Expected: both pass.

- [ ] **Step 9: Run broader cross-boundary checks**

```bash
vp run test
vp run build
```

Expected: all workspace tests and application/package builds pass.

- [ ] **Step 10: Review final diff and worktree state**

```bash
git diff --check
git diff --stat 14356ec..HEAD
git diff 14356ec..HEAD -- packages/contracts apps/server packages/client-runtime apps/web docs
git status --short
```

Expected: only context-usage implementation, tests, fixtures, and listed living documentation changed; no `.codegraph/`, `.repos/`, generated output, debug logging, dependency drift, or unrelated user files appear.

- [ ] **Step 11: Commit documentation after all evidence is green**

```bash
git add docs/architecture/providers.md docs/architecture/rpc-and-orchestration.md docs/providers/codex.md docs/providers/claude.md docs/user/workspace-ui.md
git commit -m "docs: document context usage flow"
```

- [ ] **Step 12: Run the verification-before-completion review**

Record the exact exit result of every command in Steps 5-9, re-run `git status --short`, and report any skipped/unavailable command plus residual risk. Do not claim completion from earlier output or from an expected result written in this plan.
