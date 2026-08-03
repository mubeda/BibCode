# Chat Activity Dock — OpenCode Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project verified OpenCode child sessions, statuses, messages, tool parts, and recovery history into the canonical activity graph.

**Architecture:** Maintain a root-scoped child-session registry populated by bounded recursive direct-child traversal of `/session/:id/children` and repaired with bare status/message REST responses. The SSE handler admits events for the root conversation or for verified descendants only. Root events continue through the existing conversation projector; descendant events go exclusively through `OpenCodeActivityTracker`.

**Tech Stack:** Rust, Tokio, Reqwest, Serde JSON, OpenCode HTTP/SSE API, Plan 01 activity projection.

## Prerequisites and Constraints

- Complete [01-activity-foundation.md](./01-activity-foundation.md).
- Preserve the current OpenCode root-session chat and SSE behavior.
- Do not remove the foreign-session guard. Replace it with root-or-verified-descendant routing.
- Child verification must come from the root-scoped children endpoint or a documented parent ID chain, never a matching display title.
- Bound polling, pages, messages, and text accumulation.
- OpenCode terminal attach mode is implemented in Plan 06.
- OpenCode 1.18.4 transport evidence (`.superpowers/sdd/p05-task-1-evidence-brief.md`) is authoritative: children, status, and message endpoints return bare arrays/maps; `/event` is directory-scoped; reconnect recovery is REST reconciliation rather than SSE replay.
- Before Task 3, complete
  [OpenCode Byte-Budgeted Text Coverage](../2026-07-25-opencode-byte-budgeted-text-coverage.md)
  as the human-approved Task 2b repair for the five-round tracker blocker.

---

## Task 1: Add representative OpenCode child-session fixtures

**Files:**

- Modify: `packages/contracts/fixtures/opencode-provider/manifest.json`
- Create: `packages/contracts/fixtures/opencode-provider/trace-child-sessions.json`
- Create: `packages/contracts/fixtures/opencode-provider/trace-child-sse.json`
- Create: `packages/contracts/fixtures/opencode-provider/trace-child-history.json`
- Create: `packages/contracts/fixtures/opencode-provider/trace-foreign-session.json`
- Create: `packages/contracts/fixtures/opencode-provider/trace-reconnect.json`
- Modify: `apps/server/tests/provider_opencode.rs`

- [x] **Step 1: Write failing fixture tests**

Capture exact OpenCode 1.18.4 HTTP response/SSE envelopes for:

- root children returns direct children only, requiring bounded root → direct → nested traversal with stable session and parent IDs;
- statuses use only `busy`, `retry`, `idle`, or absence; `idle`/absence is nonterminal without bounded message/tool terminal evidence;
- child `text` parts are commentary candidates while raw `reasoning` remains non-commentary;
- child `tool` parts become attributed entries and `command.executed` remains a separate attributed event;
- assistant completed/error evidence preserves the child terminal result after subsequent root activity;
- duplicate SSE plus history response is idempotent;
- an unrelated session event is ignored; and
- reconnect discovers a child missed during disconnection through recursive REST snapshots, not an SSE replay cursor.

Use redacted, versioned fixture metadata. The test must fail if a fixture omits `sessionID` or expected parent identity.

- [x] **Step 2: Verify red state and commit fixtures**

```bash
cargo test -p bibcode-server --test provider_opencode activity_fixture -- --nocapture
git add packages/contracts/fixtures/opencode-provider apps/server/tests/provider_opencode.rs
git commit -m "test(opencode): capture child session activity traces"
```

The Task 1 fixture-contract suite is self-contained and GREEN once the corpus
is present. Mapper/runtime behavior remains exclusively in Tasks 2–4.

---

## Task 2: Implement the pure OpenCode activity tracker

**Files:**

- Create: `apps/server/src/provider/opencode/activity.rs`
- Modify: `apps/server/src/provider/opencode/mod.rs`
- Modify: `apps/server/tests/provider_opencode.rs`

**Interfaces:**

- Consumes: child summaries, statuses, messages, and descendant SSE events.
- Produces: deterministic activity mutation batches.
- Consumed by: Tasks 3 and 4.

- [x] **Step 1: Add stable identity and graph tests**

Use these identities:

```text
actor ID = opencode:session:<child-session-id>
entry ID = opencode:part:<message-id>:<part-id>:<state-or-content-hash>
```

The content hash, when needed, is a fixed digest of already-bounded normalized text; raw JSON is not stored. Add tests for cycle rejection, missing parent rejection, and a maximum lineage depth of 16.

- [x] **Step 2: Implement child registry and lifecycle mapping**

Use a state shape equivalent to:

```rust
pub(crate) struct OpenCodeActivityTracker {
    root_session_id: String,
    children: HashMap<String, OpenCodeChildState>,
    message_text: HashMap<(String, String), BoundedTextAccumulator>,
    seen_entries: BoundedSeenSet,
}
```

`reconcile_children` accepts only nodes reachable from the root within depth/budget. Unknown parents remain quarantined until a later response proves their lineage.

Map status truthfully from the documented OpenCode 1.18.4 variants:

| OpenCode status | Canonical lifecycle |
|---|---|
| busy | running |
| retry `{ attempt, message, next, action? }` | waiting |
| idle or absent | waiting unless bounded terminal evidence proves another outcome |

Terminal truth comes only from assistant `time.completed`/`finish`, assistant
error, or `MessageAbortedError`. OpenCode 1.18.4 fixtures/OpenAPI expose no
stable parent Task ToolPart-to-child-session correlation field, so root Task
parts are not terminal evidence. Do not infer completed/failed/cancelled from
a session status.

- [x] **Step 3: Normalize child message parts**

Map only documented part/event types:

- text -> commentary;
- raw reasoning -> no commentary projection;
- tool state pending/running/completed/error -> tool;
- `command.executed` -> command (a separate SSE event, not a Part);
- status transition -> status.

Use `messageID` plus part ID for deduplication. For cumulative text, compute the suffix relative to the prior normalized content and coalesce at 100ms. A child assistant part must not enter the root assistant text accumulator.

- [x] **Step 4: Pass mapper tests and commit**

```bash
cargo test -p bibcode-server --test provider_opencode activity_fixture activity_tracker -- --nocapture
git add apps/server/src/provider/opencode/activity.rs apps/server/src/provider/opencode/mod.rs \
  apps/server/tests/provider_opencode.rs
git commit -m "feat(opencode): map verified child activity"
```

---

## Task 3: Add bounded child/status/message API clients and reconciliation

**Files:**

- Modify: `apps/server/src/provider/opencode/model.rs`
- Modify: `apps/server/src/provider/opencode/runtime.rs`
- Modify: `apps/server/src/provider/opencode/activity.rs`
- Modify: `apps/server/tests/provider_opencode.rs`

- [x] **Step 1: Write failing mock-server tests**

Against the existing provider test HTTP server, assert calls to:

```text
GET /session/:rootSessionId/children (then bounded recursive direct-child requests)
GET /session/status
GET /session/:childSessionId/message
```

Required behavior:

- initial session start runs one reconciliation;
- child/session bursts debounce to one pass per 250ms;
- only status rows for verified root/children are consumed;
- message history is fetched for newly discovered or changed children only;
- limits are 50 child sessions and 200 messages/parts per child;
- HTTP timeout is 5 seconds per pass, with cancellation on runtime shutdown;
- 404/unsupported endpoints downgrade activity capabilities but not chat; and
- transient 5xx marks observation stale and retries through bounded backoff.

The three successful response bodies are bare `Session[]`, `{ [sessionID]:
SessionStatus }`, and `[{ info: Message, parts: Part[] }]` respectively; do
not require legacy `{ data: ... }` envelopes in the fixture contract. A
reconnect begins with `server.connected` and must recover missed activity from
the same recursive REST pass, because OpenCode provides no SSE replay or
Last-Event-ID contract.

- [x] **Step 2: Implement private typed API DTOs**

Add Serde DTOs in `model.rs` for only fields used by the mapper. Keep HTTP path construction in the runtime client and percent-encode session IDs.

Do not accept absolute URLs from child/session responses. All follow-up requests use the already configured, authenticated OpenCode base URL.

- [x] **Step 3: Implement one reconciliation worker**

As in the Codex adapter, use a capacity-1 hint channel and one cancellation-aware task. The pass order is:

1. fetch root children;
2. validate and update reachable lineage;
3. fetch global status once and filter locally;
4. fetch bounded history only where cursor/signature changed; and
5. emit one deterministic mutation batch.

Set normal web-chat capabilities after successful endpoint handshake:

```text
actors=true
attributedActivity=true
backgroundWork=false
historyRecovery=full
terminalObservation=false
```

If message history is unsupported but children/status work, downgrade `historyRecovery` to `bounded` and keep actor/status observability.

- [x] **Step 4: Verify and commit**

```bash
cargo test -p bibcode-server --test provider_opencode reconciliation -- --nocapture
git add apps/server/src/provider/opencode/model.rs apps/server/src/provider/opencode/runtime.rs \
  apps/server/src/provider/opencode/activity.rs apps/server/tests/provider_opencode.rs
git commit -m "feat(opencode): reconcile child session activity"
```

---

## Task 4: Route verified descendant SSE without leaking into root chat

**Files:**

- Modify: `apps/server/src/provider/opencode/runtime.rs`
- Modify: `apps/server/tests/provider_opencode.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`

- [x] **Step 1: Write failing routing tests**

Drive `handle_sse_event` with three session classes:

1. root session -> existing conversation output only, plus root status reconciliation hints;
2. verified child -> activity output only; and
3. unverified/foreign session -> no output.

Also prove that a child event arriving before the children response is buffered only as a reconciliation hint, not rendered. After lineage is verified, the history request recovers it.

- [x] **Step 2: Replace the broad non-root early return**

Refactor the current guard into an explicit routing enum:

```rust
enum OpenCodeEventRoute {
    Root,
    VerifiedChild,
    Foreign,
}
```

The handler obtains the payload session ID once, classifies it against the tracker, then calls either the existing root match or the activity mapper. Keep root `assistant_message_ids` and `assistant_text` maps isolated from child maps.

- [x] **Step 3: Attach mutation batches to provider events**

Use Plan 01’s `ProviderEvent.activity` and native ID fields. One child SSE frame should produce at most one provider event. Empty mutation outputs produce no event.

- [x] **Step 4: Run full provider regressions and commit**

```bash
cargo test -p bibcode-server --test provider_opencode -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime opencode -- --nocapture
git add apps/server/src/provider/opencode/runtime.rs apps/server/tests/provider_opencode.rs \
  apps/server/tests/production_provider_runtime.rs
git commit -m "feat(opencode): route verified child session events"
```

---

## Plan 05 Verification

- [x] Run all OpenCode and projection tests:

```bash
cargo test -p bibcode-server --test provider_opencode -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime opencode -- --nocapture
cargo test -p bibcode-server --test activity_repository -- --nocapture
cargo test -p bibcode-server --test activity_rpc -- --nocapture
```

- [x] Manual web-chat smoke test with installed OpenCode:

  - create a child session that runs a tool and command;
  - confirm it appears in Subagents with attributed entries;
  - send an unrelated session SSE event and confirm it never appears;
  - disconnect/reconnect and confirm the missed child is recovered;
  - reload and inspect history; and
  - confirm root assistant text contains no child duplicates.

  Installed OpenCode 1.18.4 completed the child/tool, attribution, reload,
  stop/start recovery, and root-isolation checks. Unrelated-session rejection
  is covered by the exact production Root/VerifiedChild/Foreign routing
  regression because the installed UI exposes no safe foreign-SSE injection
  control.
