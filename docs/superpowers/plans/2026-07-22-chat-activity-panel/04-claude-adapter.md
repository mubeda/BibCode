# Chat Activity Dock — Claude Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project Claude Code subagent lifecycle, explicitly actor-correlated
tool/command activity, and bounded transcript recovery into the canonical
activity graph while preserving forwarded text without inventing actor
attribution.

**Architecture:** Enable Claude’s structured hook-event and forwarded-subagent streams on the existing provider process. A provider-local tracker correlates `agent_id`, hook lifecycle, parent session, tool-use IDs, and transcript records. Only events carrying a stable agent identity create actors; the normal Task tool continues to render in chat but is not treated as authoritative lineage by itself.

**Tech Stack:** Rust, Tokio, Serde JSON, Claude Code stream-json protocol, Claude hooks, Plan 01 activity projection.

## Prerequisites and Constraints

- Complete [01-activity-foundation.md](./01-activity-foundation.md).
- Preserve Claude permission/control-request behavior and stream-json conversation rendering.
- Add `--include-hook-events` and `--forward-subagent-text` only after a version/capability probe confirms they are supported.
- Never edit the user's Claude settings file for normal web chats.
- A `Task` tool call without stable `agent_id` remains a normal tool row, not a roster actor.
- Hook/tool input is untrusted. Normalize only documented bounded fields; redact environment, credentials, and raw settings.
- The interactive terminal hook topology is implemented in Plan 06.

### Verified Claude transport boundary

The captured
[installed Claude Code `2.1.218` probe](../../../../apps/server/tests/fixtures/claude-provider/trace-subagent-hooks.json)
confirms `--include-hook-events` and `--forward-subagent-text`. Its emitted
`system/hook_started` and `system/hook_response` records identify the hook but
do not carry `agent_id` or `tool_use_id`. The current
[official TypeScript Agent SDK types](https://code.claude.com/docs/en/agent-sdk/typescript#basehookinput)
document optional `agent_id`/`agent_type` on `BaseHookInput`, populated inside a
subagent, while Pre/Post/PostFailure hook inputs carry `tool_use_id`. Those
hook-input fields are the supported actor/tool correlation path.

Forwarded assistant/user records carry `parent_tool_use_id`, and task lifecycle
records correlate `task_id` with the spawning `tool_use_id`, but neither
transport documents a stable link to `SubagentStart.agent_id`. Consequently:

- forwarded text stays in the normal conversation/task presentation and emits
  no actor activity mutation;
- identity-free task notifications, including failures, cannot update a
  specific actor;
- a failed tool does not imply that its actor failed; and
- Claude `2.1.218` exposes no explicit correlated failed/cancelled discriminator
  on `SubagentStop`, so only the documented completed terminal transition is
  projected until a future transport adds one.

Never infer these relationships from event order, matching agent types, or a
single currently running actor.

---

## Task 1: Capture Claude hook/subagent protocol fixtures

**Files:**

- Create: `apps/server/tests/fixtures/claude-provider/trace-subagent-hooks.json`
- Create: `apps/server/tests/fixtures/claude-provider/trace-forwarded-subagent-text.json`
- Create: `apps/server/tests/fixtures/claude-provider/trace-subagent-tools.json`
- Create: `apps/server/tests/fixtures/claude-provider/trace-subagent-recovery.json`
- Create: `apps/server/tests/fixtures/claude-provider/trace-unsupported-hook-flags.json`
- Modify: `apps/server/tests/fixtures/claude-provider/manifest.json`
- Modify: `apps/server/tests/provider_claude.rs`

- [ ] **Step 1: Write manifest-driven failing fixture tests**

Cover these ordered scenarios:

- `SubagentStart` with `agent_id` and `agent_type` creates an actor;
- forwarded subagent text retains task correlation but emits no actor activity
  without a documented task-to-agent key;
- Pre/Post tool hook inputs carrying the same `agent_id` and tool-use ID produce
  one actor-owned tool/command entry lifecycle;
- `SubagentStop` marks the actor completed and captures a bounded summary;
- a failed actor-owned tool produces a distinct error entry while the actor
  remains running until its documented `SubagentStop`;
- an identity-free failed task notification emits no actor mutation;
- duplicate hook delivery is a no-op;
- a Task tool trace with no `agent_id` creates no actor; and
- unsupported flags downgrade capabilities while the base Claude launch remains functional.

Each fixture includes raw input lines and expected `ActivityMutation` JSON.
Capture the installed stream wrapper exactly, for example:

```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_name": "activity-capture",
  "hook_event": "SubagentStart",
  "hook_id": "hook-1",
  "output": "{}",
  "stdout": "",
  "stderr": "",
  "exit_code": 0,
  "outcome": "success",
  "uuid": "hook-response-1",
  "session_id": "session-root"
}
```

If the installed CLI emits a different documented wrapper, capture that exact wrapper and keep the mapper tolerant of additive fields.

- [ ] **Step 2: Verify red state and commit fixtures**

```bash
cargo test -p bibcode-server --test provider_claude activity_fixture -- --nocapture
git add apps/server/tests/fixtures/claude-provider apps/server/tests/provider_claude.rs
git commit -m "test(claude): capture subagent activity traces"
```

Expected before implementation: FAIL because the activity parser does not exist.

---

## Task 2: Implement the pure Claude activity tracker

**Files:**

- Create: `apps/server/src/provider/claude/activity.rs`
- Modify: `apps/server/src/provider/claude/mod.rs`
- Modify: `apps/server/tests/provider_claude.rs`

**Interfaces:**

- Consumes: decoded stream-json messages, hook events, transcript entries.
- Produces: deterministic activity mutation batches.
- Consumed by: Tasks 3 and 4.

- [ ] **Step 1: Add identity and lifecycle tests**

Use deterministic identities:

```text
actor ID = claude:agent:<agent_id>
entry ID = claude:event:<hook_event_id-or-event/session/agent/tool/status-key>
```

The tracker state must be bounded and equivalent to:

```rust
pub(crate) struct ClaudeActivityTracker {
    root_session_id: String,
    actors: HashMap<String, ClaudeActorState>,
    tool_owner_by_use_id: HashMap<String, String>,
    seen_events: BoundedSeenSet,
}
```

Test that an event for a different root session is ignored unless its stable `agent_id` is already correlated to the current root.

- [ ] **Step 2: Parse hook envelopes defensively**

Implement a small untagged/envelope decoder that extracts only:

- hook event name;
- root session ID;
- agent ID and type;
- tool name and tool-use ID;
- success/error/status;
- bounded display summary;
- event timestamp; and
- main-session `transcript_path` for session metadata; and
- child `agent_transcript_path` from `SubagentStop` for recovery metadata.

Do not retain arbitrary `tool_input`, `tool_response`, `cwd`, permission payload, or environment maps. For commands, extract only the normalized command display string already allowed by the provider event model, clipped to contract length.

- [ ] **Step 3: Normalize lifecycle and parentage**

Map events as follows:

| Claude event | Mutation |
|---|---|
| `SubagentStart` | actor upsert `starting` then `running` |
| forwarded subagent text | no activity mutation without a documented task-to-agent key |
| attributed `PreToolUse` / tool start | tool or command entry started for that input's `agent_id` |
| attributed `PostToolUse` | tool or command entry completed only when agent and tool-use IDs match |
| attributed `PostToolUseFailure` | error entry plus actor remains running |
| `SubagentStop` success | actor completed |
| identity-free task failure | no actor mutation |
| explicit correlated failure/cancel | actor failed/cancelled only when a future transport supplies the discriminator |

If hook input exposes a parent agent ID, set `parentActorId`; otherwise leave it null. Never invent nested lineage from event arrival order.

- [ ] **Step 4: Preserve the forwarded-text attribution boundary**

Retain `parent_tool_use_id` for normal conversation/task rendering, but emit no
actor activity entry until the transport supplies a documented stable link to
`agent_id`. Test interleaved same-type agents so event order cannot become an
accidental correlation key.

- [ ] **Step 5: Pass pure mapping tests and commit**

```bash
cargo test -p bibcode-server --test provider_claude activity_fixture activity_tracker -- --nocapture
git add apps/server/src/provider/claude/activity.rs apps/server/src/provider/claude/mod.rs \
  apps/server/tests/provider_claude.rs
git commit -m "feat(claude): map hook and subagent activity"
```

---

## Task 3: Enable and route structured hook events in the Claude driver

**Files:**

- Modify: `apps/server/src/production/provider_runtime.rs`
- Create: `apps/server/src/provider/claude/hook_sink.rs`
- Modify: `apps/server/src/provider/claude/runtime.rs`
- Modify: `apps/server/tests/provider_claude.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`

- [x] **Step 1: Write failing launch-argument tests**

Extend the existing Claude launch assertions to require this ordering when the installed version supports it:

```text
--print
--input-format stream-json
--output-format stream-json
--include-partial-messages
--include-hook-events
--forward-subagent-text
--verbose
```

Also test:

- configured permission mode, resume/session ID, model, effort, and MCP args remain unchanged;
- flags appear exactly once;
- supported and simulated older CLIs both start with
  `NO_ACTIVITY_CAPABILITIES`, while the older CLI also omits the two flags; and
- hook support probing is cached per executable/version rather than running for every turn.

- [x] **Step 2: Add a bounded CLI capability probe**

Introduce a production helper near other binary probes that executes the
configured Claude binary with a non-interactive version/help capability check
under one absolute two-second budget. Resolution, canonicalization, metadata,
spawn, reads, termination, and reap all belong to that budget. Blocking
filesystem work runs through `spawn_blocking`; timed-out process trees are
terminated and reaped by the shared supervised-process owner without dropping
its cleanup future.

Cache successful probes by canonical executable path, metadata fingerprint,
and version. Concurrent misses share one probe, transient failures remain
retryable, and ready/in-flight state is bounded and pruned.

The result is explicit:

```rust
struct ClaudeActivitySupport {
    include_hook_events: bool,
    forward_subagent_text: bool,
    transcript_recovery: bool,
}
```

Failure to probe is a safe unsupported result for activity only. It must not block normal Claude launch.

- [x] **Step 3: Install and route an authenticated per-launch hook sink**

For supported web-chat launches, bind an ephemeral Axum listener on
`127.0.0.1`, generate a 256-bit bearer token, and pass that token only through
the child environment. Add an inline `--settings` JSON overlay containing HTTP
hooks for `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, and
`PostToolUseFailure`; use Claude's header environment interpolation and
`allowedEnvVars` so normal user/project/local settings continue to compose.

Bound authorization, media type, request body, channel capacity, and request
time. Hook delivery failures remain non-blocking for Claude. Keep the endpoint
alive until the child is terminated/reaped, then shut it down. Launch failure
uses handle ownership/Drop cleanup and never leaves a listener behind.

- [x] **Step 4: Extend the Claude message decoder and driver output**

In `provider/claude/runtime.rs`, decode hook/system envelopes before the existing
fallback path. Feed hook inputs carrying stable `agent_id` to
`ClaudeActivityTracker`, then attach its mutations and native ID to the provider
event plumbing from Plan 01. Keep the ordinary root Task tool on the normal
conversation/task path. Do not feed forwarded text into actor activity without
a documented task-to-agent key, and do not replay forwarded assistant text as a
second root-assistant message.

Root assistant/user/result messages still follow the existing conversation
path. Subagent-forwarded text must not also become root assistant text and must
not be projected as actor commentary without a stable task-to-agent key.
Use an explicit three-way route: ordinary root messages follow the existing
conversation mapper; forwarded assistant/reasoning text is suppressed from
root `content.delta`; forwarded tool starts/updates/stops and user tool results
remain canonical item lifecycle events carrying `parentToolUseId`.

The presence of `--include-hook-events` and `--forward-subagent-text` is not
identity evidence: Claude Code `2.1.218` emits wrapper/task records without
`agent_id`. Therefore every normal web-chat launch initially advertises:

```text
actors=false
attributedActivity=false
backgroundWork=false
historyRecovery=none
terminalObservation=false
```

Only after the runtime receives an actual stable hook input carrying correlated
`session_id` and `agent_id` does it upgrade the live scope to
`actors=true`/`attributedActivity=true`. Flag support, hook wrappers, forwarded
text, and task notifications alone never upgrade the scope. Here the live
`attributedActivity=true` upgrade covers tool lifecycle hook inputs whose
individual inputs carry `agent_id`; it does not advertise forwarded-text
attribution or failed/cancelled actor terminal detection. Those remain
unsupported until the transport exposes explicit correlation/discriminator
fields.

Store runtime-observed capabilities and retained-section truth in shared
lifecycle state used by the event pump, unexpected stream-end handling,
restart, and stop/cancellation compensation. A replacement launch that reports
`none` must not erase support already proven by a stable runtime hook, while a
genuine launch-time capability downgrade remains allowed.

Derive hook native IDs from length-framed identity fields and reject NUL/control
characters before either hashing or activity tracking.

Until Task 4's transcript path validation and parser are implemented, advertise
`historyRecovery=none`; Task 4 upgrades it to `bounded` or `full` only after a
successful recovery handshake. Do not advertise recovery code that is not yet
present in an intermediate commit.

- [x] **Step 5: Verify permission and stream regressions**

```bash
cargo test -p bibcode-server --test provider_claude -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime claude -- --nocapture
```

Explicitly confirm existing control requests, plan-mode transitions, interrupt, partial text, and task-tool rendering still pass.

- [x] **Step 6: Commit live integration**

```bash
git add apps/server/src/production/provider_runtime.rs \
  apps/server/src/provider/claude/runtime.rs apps/server/tests/provider_claude.rs \
  apps/server/tests/production_provider_runtime.rs
git commit -m "feat(claude): enable structured activity events"
```

---

## Task 4: Recover bounded Claude subagent history from transcripts

**Files:**

- Create: `apps/server/src/provider/claude/transcript.rs`
- Modify: `apps/server/src/provider/claude/activity.rs`
- Modify: `apps/server/src/provider/claude/runtime.rs`
- Modify: `apps/server/src/provider/claude/mod.rs`
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/Cargo.toml`
- Modify: `apps/server/tests/provider_claude.rs`
- Modify: `apps/server/tests/production_provider_runtime.rs`

- [x] **Step 1: Write failing transcript recovery tests**

Create temporary JSONL transcripts and cover:

- authenticated child `SubagentStop` input recovers normalized child activity;
- normalized activity remains reloadable from the existing ActivityRepository;
- only transcript records correlated to the current root session are accepted;
- nested agent records preserve a documented parent ID when available;
- malformed/truncated final JSONL line is ignored;
- files over 10 MiB are tail-read with a bounded scan instead of loaded whole;
- at most 50 recovery targets per root and 200 entries per actor are normalized;
- live and recovery delivery de-duplicate in either order;
- terminal actors cannot reopen; and
- missing, unreadable, replaced, identity-mismatched, or cancelled transcripts
  remain nonfatal and do not claim recovery support.

- [x] **Step 2: Implement safe transcript access**

Treat `agent_transcript_path` as provider-supplied untrusted input. The common
BaseHookInput `transcript_path` is the main-session transcript and must not be
substituted for the child transcript:

- canonicalize before opening;
- require a regular file;
- do not follow a later symlink replacement between metadata and open;
- read in `spawn_blocking` with cancellation;
- retain no raw transcript beyond parsing; and
- never expose the path through activity RPC.

If the provider already has a transcript path validator/helper, extract and reuse it rather than duplicating path logic.

- [x] **Step 3: Add bounded reconciliation**

Recover a child immediately when an authenticated, correlated hook input first
supplies its `agent_transcript_path`. Keep normalized mutations in the existing
ActivityRepository, which is the authoritative reload, reconnect, and cold
resume source. Do not persist raw or canonical transcript paths, enumerate the
main transcript, or add provider paths to runtime/public payloads. An
in-process replacement may scan a child again only when Claude supplies its
path again; deterministic IDs make that idempotent.

Parse only documented record forms and generate the same semantic tool IDs as
live hooks. Set `historyRecovery: "bounded"` only after a successfully opened,
correlation-validated scan, including a valid scan with zero supported entries.
Never advertise `"full"`.

- [x] **Step 4: Verify and commit**

```bash
cargo test -p bibcode-server --test provider_claude transcript_recovery -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime claude -- --nocapture
git add apps/server/Cargo.toml apps/server/src/provider/claude/activity.rs \
  apps/server/src/provider/claude/mod.rs apps/server/src/provider/claude/runtime.rs \
  apps/server/src/provider/claude/transcript.rs apps/server/src/production/provider_runtime.rs \
  apps/server/tests/provider_claude.rs apps/server/tests/production_provider_runtime.rs
git commit -m "feat(claude): recover bounded subagent history"
```

---

## Plan 04 Verification

- [x] Run the complete Claude slice:

```bash
cargo test -p bibcode-server --test provider_claude -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime claude -- --nocapture
cargo test -p bibcode-server --test activity_repository -- --nocapture
cargo test -p bibcode-server --test activity_rpc -- --nocapture
```

- [ ] Manual web-chat smoke test with installed Claude:

  - run an agent that delegates at least one subagent;
  - confirm the actor appears only after stable hook identity arrives;
  - inspect forwarded commentary and tool/command entries;
  - confirm the ordinary Task tool still renders in the transcript;
  - reload/resume and compare recovered bounded history; and
  - run with activity flags unavailable and confirm chat works with no misleading dock.
