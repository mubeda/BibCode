# Chat Activity Dock — Codex Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project native Codex App Server collaboration, descendant-thread, child activity, and background-terminal events into the canonical activity graph.

**Architecture:** A provider-local `CodexActivityTracker` consumes live App Server notifications and bounded reconciliation responses. It maps stable Codex thread IDs to actors, native collaboration calls to work items/relationships, and child-thread items to attributed entries. Reconciliation is debounced and repairs missed notification history without polluting the normal conversation stream.

**Tech Stack:** Rust, Tokio, Serde JSON, Codex App Server JSON-RPC, Plan 01 activity projection.

## Prerequisites and Constraints

- Complete [01-activity-foundation.md](./01-activity-foundation.md).
- Preserve all current Codex chat behavior and approval handling.
- Keep `experimentalApi: true` in initialize params; do not add a second Codex process for normal web chats.
- Never infer an actor solely from display text. Use stable child thread/agent IDs.
- Root-thread messages remain in the conversation pipeline. Child-thread messages become activity entries only.
- Reconciliation is bounded, debounced, cancel-safe, and unavailable-method errors downgrade capabilities without terminating the chat.
- The terminal `codex --remote` topology is implemented later in Plan 06.

---

## Task 1: Capture representative Codex collaboration fixtures

**Files:**

- Modify: `packages/contracts/fixtures/codex-provider/manifest.json`
- Create: `packages/contracts/fixtures/codex-provider/trace-collaboration.json`
- Create: `packages/contracts/fixtures/codex-provider/trace-child-activity.json`
- Create: `packages/contracts/fixtures/codex-provider/trace-reconcile.json`
- Create: `packages/contracts/fixtures/codex-provider/trace-schema-downgrade.json`
- Modify: `apps/server/tests/provider_codex.rs`

- [ ] **Step 1: Add fixture-loader tests before parser code**

Add a manifest-driven test like the existing Claude provider fixtures. Each fixture must contain ordered inbound messages and an expected bounded activity mutation list. Redact prompts, paths, and command output.

Required fixture scenarios:

- a root collab-agent tool call creates two receiver actors;
- `agentsStates` transitions one receiver from starting to running to completed;
- a child thread emits commentary, a tool start/completion, and command completion;
- descendant reconciliation discovers one missed child and does not duplicate the live child;
- an unknown item type produces no activity mutation; and
- `method not found` for an experimental list/read call downgrades recovery without failing the parent turn.

Represent the wire inputs exactly as App Server JSON-RPC envelopes, for example:

```json
{
  "jsonrpc": "2.0",
  "method": "item/started",
  "params": {
    "threadId": "root-1",
    "turnId": "turn-1",
    "item": {
      "id": "item-collab-1",
      "type": "collabAgentToolCall",
      "tool": "spawnAgent",
      "status": "inProgress",
      "senderThreadId": "root-1",
      "receiverThreadIds": ["child-1"]
    }
  }
}
```

- [ ] **Step 2: Run the fixture test and verify the red state**

```bash
cargo test -p bibcode-server --test provider_codex activity_fixture -- --nocapture
```

Expected: FAIL because the tracker/parser does not exist.

- [ ] **Step 3: Commit protocol fixtures separately**

```bash
git add packages/contracts/fixtures/codex-provider apps/server/tests/provider_codex.rs
git commit -m "test(codex): capture collaboration activity traces"
```

The test may remain red in this test-only commit.

---

## Task 2: Implement the pure Codex activity mapper

**Files:**

- Create: `apps/server/src/provider/codex/activity.rs`
- Modify: `apps/server/src/provider/codex/mod.rs`
- Modify: `apps/server/tests/provider_codex.rs`

**Interfaces:**

- Consumes: method plus JSON params and reconciliation DTOs.
- Produces: `Vec<ActivityMutation>` plus reconciliation hints.
- Consumed by: Task 3.

- [ ] **Step 1: Define and test stable identity mapping**

The module must expose provider-internal types equivalent to:

```rust
pub(crate) struct CodexActivityTracker {
    root_thread_id: Option<String>,
    actors_by_thread: HashMap<String, ActivityActorState>,
    work_items_by_native_id: HashMap<String, ActivityWorkItemState>,
    seen_native_events: BoundedSeenSet,
}

pub(crate) struct CodexActivityOutput {
    pub mutations: Vec<ActivityMutation>,
    pub request_reconciliation: bool,
}
```

Write unit cases for these deterministic IDs:

```text
actor ID     = codex:thread:<child-thread-id>
work item ID = codex:item:<native-item-id>
entry ID     = codex:event:<native-event-id-or-method/thread/turn/item/status-key>
```

If a notification lacks a native event ID, derive the fallback from bounded stable identifiers and the state transition, not from the whole JSON blob.

- [ ] **Step 2: Implement lifecycle normalization**

Use an exhaustive mapper:

```rust
fn map_codex_status(value: &str) -> ActivityLifecycle {
    match value {
        "pending" | "starting" => ActivityLifecycle::Starting,
        "inProgress" | "running" => ActivityLifecycle::Running,
        "waiting" => ActivityLifecycle::Waiting,
        "completed" => ActivityLifecycle::Completed,
        "failed" => ActivityLifecycle::Failed,
        "cancelled" => ActivityLifecycle::Cancelled,
        _ => ActivityLifecycle::Unknown,
    }
}
```

Apply the shared terminal-state monotonicity rule from Plan 01. A late `inProgress` event cannot reopen completed/failed/cancelled work.

- [ ] **Step 3: Map collaboration calls and relationships**

For native collaboration items:

- upsert each receiver thread as an actor;
- set `parentActorId` from `senderThreadId` when the sender is a non-root child;
- upsert the collaboration call itself as a work item only when it represents bounded asynchronous/background work;
- preserve the item/tool name as a safe title;
- take summaries only from documented summary/status fields, clipped by the contract; and
- use the latest `agentsStates` entry for lifecycle without deleting finished actors.

Unsupported collaboration fields are ignored. Do not serialize raw params into `detail`.

- [ ] **Step 4: Map child-thread items to attributed entries**

When `threadId` resolves to a verified child actor, map:

| App Server item/event | Canonical entry |
|---|---|
| agent message delta/completion | `commentary` |
| reasoning summary delta | `commentary` with summary title only |
| command execution start/completion | `command` |
| tool/MCP start/completion | `tool` |
| turn status/error | `state` or `error` |

Coalesce text deltas per native item and emit at most one projection mutation every 100ms or at completion. Limit accumulated text to `ACTIVITY_DETAIL_MAX_LENGTH` in bytes on a valid UTF-8 boundary.

- [ ] **Step 5: Pass the pure fixture tests**

```bash
cargo test -p bibcode-server --test provider_codex activity_fixture activity_lifecycle -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit the mapper**

```bash
git add apps/server/src/provider/codex/activity.rs apps/server/src/provider/codex/mod.rs \
  apps/server/tests/provider_codex.rs
git commit -m "feat(codex): map native collaboration activity"
```

---

## Task 3: Wire live notifications without changing conversation behavior

**Files:**

- Modify: `apps/server/src/provider/codex/runtime.rs`
- Modify: `apps/server/tests/provider_codex.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`

- [ ] **Step 1: Write failing runtime event tests**

Drive the runtime with the live fixtures and assert:

- after experimental initialization succeeds, `StartedSession.activity_capabilities` advertises actors and attribution, but keeps background work false and history recovery none until Task 4 handshakes those methods;
- every mapped output appears in `ProviderEvent.activity` with a deterministic `native_event_id`;
- the existing `turn.started`, `content.delta`, `item.started`, and `item.completed` outputs remain byte-for-byte compatible for root events;
- child content does not produce root conversation `content.delta`; and
- explicit runtime shutdown stops coalescing/reconciliation tasks.

- [ ] **Step 2: Run the tests and verify red state**

```bash
cargo test -p bibcode-server --test provider_codex activity_runtime -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime codex -- --nocapture
```

- [ ] **Step 3: Add the tracker to runtime state**

Initialize one tracker per `CodexProviderRuntime`. In `handle_notification`, run the activity mapper before or alongside the existing root event match, then emit a provider event carrying only activity mutations when necessary.

Important routing rule:

```rust
let is_root = tracker.is_root_thread(notification_thread_id);
let activity = tracker.handle_notification(&method, &params, now);
emit_activity(activity).await;
if !is_root && tracker.is_verified_child(notification_thread_id) {
    return;
}
// existing root notification handling follows unchanged
```

Do not early-return unverified foreign thread IDs into activity; ignore them entirely.

- [ ] **Step 4: Pass runtime regressions and commit**

```bash
cargo test -p bibcode-server --test provider_codex -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime codex -- --nocapture
git add apps/server/src/provider/codex/runtime.rs apps/server/tests/provider_codex.rs \
  apps/server/tests/production_provider_runtime.rs
git commit -m "feat(codex): emit live activity mutations"
```

---

## Task 4: Add bounded descendant and background-terminal reconciliation

**Files:**

- Modify: `apps/server/src/provider/codex/model.rs`
- Modify: `apps/server/src/provider/codex/runtime.rs`
- Modify: `apps/server/src/provider/codex/activity.rs`
- Modify: `apps/server/tests/provider_codex.rs`

**Interfaces:**

- Calls App Server: `thread/list`, `thread/read`, and `thread/backgroundTerminals/list`.
- Repairs the canonical graph after reconnect, lag, or incomplete live notifications.

- [ ] **Step 1: Write failing reconciliation tests**

Use a fake JSON-RPC connection and assert:

- first root `thread/started` schedules one immediate reconciliation;
- bursty collaboration notifications produce only one call per 250ms debounce window;
- list uses `ancestorThreadId: root` and never imports unrelated threads;
- reads are limited to 50 descendants, 20 turns per descendant, and 200 normalized entries per record;
- a missed child becomes an actor and its bounded history becomes entries;
- live and reconciled copies de-duplicate by stable key;
- background terminals become Background Tasks only when App Server reports them;
- reconnect runs one repair pass; and
- cancellation aborts in-flight requests without emitting an error entry.

- [ ] **Step 2: Implement typed request/response decoders**

Add private Serde DTOs for only used fields. Do not expose App Server wire DTOs through `packages/contracts`.

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListParams<'a> {
    ancestor_thread_id: &'a str,
    limit: u16,
}
```

Decode unknown fields permissively, but treat missing stable IDs as an ignored record. Page until `nextCursor` is absent or the 50-descendant budget is reached.

- [ ] **Step 3: Implement the debounced repair loop**

The runtime owns a cancellation token and a single reconciliation worker. Hints send into a capacity-1 channel; they do not spawn unbounded tasks. On repair:

1. list descendants for the current root;
2. reconcile actor identity/parent/status;
3. read only new or stale descendants;
4. normalize bounded entries;
5. list background terminals; and
6. emit one activity mutation batch with deterministic native key.

- [ ] **Step 4: Downgrade safely on protocol incompatibility**

If the server returns JSON-RPC `-32601` or fails schema decoding for an experimental method:

- stop calling that method for this runtime;
- change `historyRecovery` from `full` to `bounded` or `none` as appropriate;
- set `backgroundWork: false` only when its method is unavailable and no native live record proves support;
- update only Background Tasks section health when that method fails, preserving Subagents as live;
- emit one bounded operational warning; and
- keep normal Codex chat live.

Transient transport errors retain capabilities, mark observation stale through the shared projection, and retry with the runtime reconnect path.

After successful descendant list/read reconciliation, publish
`historyRecovery: "full"`. Enable `backgroundWork` only after the background
terminal method succeeds or a documented native live record proves it. These
upgrades are scope mutations, so a client already subscribed receives them.

- [ ] **Step 5: Verify and commit**

```bash
cargo test -p bibcode-server --test provider_codex reconciliation -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime codex -- --nocapture
git add apps/server/src/provider/codex/model.rs apps/server/src/provider/codex/runtime.rs \
  apps/server/src/provider/codex/activity.rs apps/server/tests/provider_codex.rs
git commit -m "feat(codex): reconcile descendant activity"
```

---

## Plan 03 Verification

- [ ] Run all Codex and projection tests:

```bash
cargo test -p bibcode-server --test provider_codex -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime codex -- --nocapture
cargo test -p bibcode-server --test activity_repository -- --nocapture
cargo test -p bibcode-server --test activity_rpc -- --nocapture
```

- [ ] Manual web-chat smoke test with installed Codex:

  - spawn at least two subagents, including one nested child;
  - confirm Active/Done counts and parent relation;
  - open a child and inspect commentary/tool/command entries;
  - reload T4Code and confirm bounded history recovery;
  - stop the provider connection briefly and confirm stale/reconnect behavior; and
  - confirm the root transcript contains no duplicate child commentary.
