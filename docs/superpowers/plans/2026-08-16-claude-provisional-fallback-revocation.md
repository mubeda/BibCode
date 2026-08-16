# Claude Provisional Fallback Revocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude nested-task fallback correlation independent of fact arrival order by revoking provisional targets when later sibling evidence makes ownership ambiguous.

**Architecture:** Keep exact authenticated `PostToolUse` identity authoritative and represent only inferred nested fallback ownership as a reversible, provenance-carrying value inside the existing session-generation correlator. Reconcile against the complete parent-local candidate set, synchronously retire invalid provisional targets through the existing Activity effect batch, and observe the public result through the Activity stream under one absolute test deadline.

**Tech Stack:** Rust, Tokio, Axum/WebSocket RPC, Claude authenticated hook fixtures, Cargo, Vite+.

## Global Constraints

- Do not change Claude's protocol, hook schema, public Activity schema, or persistence format.
- Production provider, delivery, cancellation, and process deadlines remain unchanged.
- Add no sleeps, debounce windows, retries, global locks, serialization, or timing-based correlation.
- Keep the unique documented parentless fallback and exact `PostToolUse` promotion behavior.
- Timing, arrival order, proximity, labels, descriptions, prompts, polling, and actor order are never correlation evidence.
- Ambiguous actors remain observable but unsupported; cancellation must fail before writing any provider request bytes.
- Preserve generation fencing, tombstones, the 200-correlation bound, terminal cleanup, runtime replacement, and ordinary Claude chat.
- Use one absolute 30-second test-only deadline for the public provider fixture; later milestones consume its remaining budget.
- Stop broad verification on the first different failure and report it without a blind rerun or unrelated edit.

---

## File Structure

- `apps/server/src/provider/claude/runtime.rs` owns Claude task-correlation state, reversible fallback provenance, synchronous target revocation, and deterministic owner-level tests.
- `apps/server/tests/production_provider_runtime.rs` owns the public RPC/hook fixture and its event-driven Activity-stream assertion.
- `docs/architecture/activity-observation.md` owns the cross-provider Activity identity and fail-closed control invariant.
- `docs/architecture/providers.md` owns Claude provider capability and downgrade behavior.

No new module, public API, schema, dependency, task, queue, mutex, or timer is required.

---

### Task 1: Make inferred Claude targets provisional and revocable

**Files:**

- Modify: `apps/server/src/provider/claude/runtime.rs:275-290`
- Modify: `apps/server/src/provider/claude/runtime.rs:500-552`
- Modify: `apps/server/src/provider/claude/runtime.rs:827-1143`
- Test: `apps/server/src/provider/claude/runtime.rs:3430-4400`
- Modify: `docs/architecture/activity-observation.md:350-390`
- Modify: `docs/architecture/providers.md:220-255`

**Interfaces:**

- Consumes: `ClaudeTaskControlCorrelator`, `ClaudeTaskControlEffect::{Install,Retire}`, exact `launched_agent_id`, verified lineage, `actor_target_by_agent`, and `agent_by_task`.
- Produces: private `ClaudeProvisionalFallback`, `ClaudeTaskCorrelation::provisional_fallback`, generation-owned `ClaudeTaskControlCorrelator::fallback_ambiguous_parents: BTreeSet<String>`, and `ClaudeTaskControlCorrelator::revoke_provisional_fallback(&str) -> Option<ClaudeTaskControlEffect>`.
- Preserves: `ClaudeTaskCorrelation::effective_agent_id() -> Option<&str>` and all existing callers of `reconcile_all()`.

- [ ] **Step 1: Preserve the diagnosed loaded RED evidence**

Record the already-observed unchanged-code failures as the concurrency RED; do not rerun the old code merely to manufacture another failure:

```text
vp run test
targeted_activity_rpc_keeps_ambiguous_claude_children_unsupported_without_provider_io
panic: ambiguous children remain observable and unsupported: Elapsed(())

direct eight-runtime harness, unchanged binary: 2/8 failed
instrumented eight-runtime harness: 1/8 failed after 14,590 activity.getSnapshot requests
authoritative failed snapshot:
  parent control = available, activeDescendantCount = 2
  child one actor = running, control = available
  child two actor = running, control = available
  all six authenticated hook requests completed
```

This proves the product state is order-dependent; it is not merely a short observer deadline.

- [ ] **Step 2: Write the deterministic late-sibling regression**

Add an output helper beside `mapped_targets`:

```rust
fn retired_actor_targets(outputs: &[ClaudeRuntimeOutput]) -> Vec<String> {
    outputs
        .iter()
        .flat_map(|output| &output.activity_controls)
        .filter_map(|update| match update {
            crate::activity::ProviderActivityControlUpdate::ActorTarget {
                actor_id,
                target: None,
            } => Some(actor_id.clone()),
            crate::activity::ProviderActivityControlUpdate::ActorTarget { target: Some(_), .. }
            | crate::activity::ProviderActivityControlUpdate::WorkTarget { .. } => None,
        })
        .collect()
}
```

Add `targeted_task_correlation_late_sibling_revokes_provisional_parentless_fallback` using the existing `facts`, `nested_fallback_facts`, and `handle_fact` helpers. Remove `parent_agent_id` from both child `SubagentStart` values and set `agent_type` to `"same-role"`. The test must:

```rust
let parent = facts("session", "tool-parent", "agent-parent", "task-parent");
let mut child_one = nested_fallback_facts(
    "session", "tool-parent", "agent-parent",
    "tool-child-one", "agent-child-one", "task-child-one",
);
let mut child_two = nested_fallback_facts(
    "session", "tool-parent", "agent-parent",
    "tool-child-two", "agent-child-two", "task-child-two",
);
for child in [&mut child_one, &mut child_two] {
    child[3]
        .as_object_mut()
        .expect("SubagentStart object")
        .remove("parent_agent_id");
    child[3]["agent_type"] = json!("same-role");
}

let mut runtime = ClaudeProviderRuntime::new("thread".to_owned(), "session".to_owned());
for (index, fact) in parent.iter().enumerate() {
    let _ = handle_fact(&mut runtime, fact, true, index as u64);
}
let child_one_outputs = child_one
    .iter()
    .enumerate()
    .map(|(index, fact)| handle_fact(&mut runtime, fact, true, 10 + index as u64))
    .collect::<Vec<_>>();
assert_eq!(
    mapped_targets(&child_one_outputs),
    [("claude:agent:agent-child-one".to_owned(), "task-child-one".to_owned())],
);

let child_two_outputs = child_two
    .iter()
    .enumerate()
    .map(|(index, fact)| handle_fact(&mut runtime, fact, true, 20 + index as u64))
    .collect::<Vec<_>>();
assert_eq!(
    retired_actor_targets(&child_two_outputs),
    ["claude:agent:agent-child-one".to_owned()],
);
assert_eq!(runtime.task_control_correlator.actor_target_by_agent.len(), 1);
assert_eq!(
    runtime
        .task_control_correlator
        .actor_target_by_agent
        .get("agent-parent")
        .map(String::as_str),
    Some("task-parent"),
);
assert_eq!(runtime.task_control_correlator.agent_by_task.len(), 1);
assert_eq!(
    runtime
        .task_control_correlator
        .agent_by_task
        .get("task-parent")
        .map(String::as_str),
    Some("agent-parent"),
);
assert!(runtime.task_control_correlator.state_is_bounded());
```

Replay all four facts for both children and assert no new target is installed while the complete set remains ambiguous. In the same test, build a second runtime and deliver both children through task/PreToolUse before either parentless `SubagentStart`. Complete both starts afterward and assert the same target-free final maps. This is the order-invariance assertion, not a timing assertion.

Add `targeted_task_correlation_late_explicit_sibling_revokes_provisional_fallback` with the same sequence but retain the fixture's explicit `parent_agent_id` fields. Require child one's initial fallback install, its later retirement, no target for child two, the exact parent as the sole remaining actor/task mapping, and bounded retained state. This prevents the fix from covering only the documented parentless hook shape while leaving explicit verified lineage order-dependent.

- [ ] **Step 3: Write the exact-evidence-after-revocation regression**

Add `targeted_task_correlation_exact_evidence_resolves_one_child_after_fallback_ambiguity`. Recreate the ambiguous state from Step 2, then deliver this authenticated exact fact for child one:

```rust
let exact_child_one = json!({
    "hook_event_name": "PostToolUse",
    "session_id": "session",
    "agent_id": "agent-parent",
    "tool_name": "Agent",
    "tool_use_id": "tool-child-one",
    "tool_response": {
        "status": "async_launched",
        "agentId": "agent-child-one"
    }
});
let resolved = handle_fact(&mut runtime, &exact_child_one, true, 30);
assert_eq!(
    mapped_targets(&[resolved]),
    [("claude:agent:agent-child-one".to_owned(), "task-child-one".to_owned())],
);
assert_eq!(
    runtime
        .task_control_correlator
        .actor_target_by_agent
        .get("agent-child-one")
        .map(String::as_str),
    Some("task-child-one"),
);
assert!(!runtime
    .task_control_correlator
    .actor_target_by_agent
    .contains_key("agent-child-two"));
```

Also assert the resolved record has exact `launched_agent_id` and no provisional fallback, while the unresolved sibling remains retained and unsupported.
Assert `fallback_ambiguous_parents` still contains `agent-parent` after exact child-one installation. Replay child two's facts and require it to remain unsupported; only its own exact PostToolUse may install it.

- [ ] **Step 4: Run the owner regressions to verify RED**

Run sequentially:

```bash
cargo test -p bibcode-server --lib \
  provider::claude::runtime::targeted_task_correlation_tests::targeted_task_correlation_late_sibling_revokes_provisional_parentless_fallback \
  -- --exact --nocapture
cargo test -p bibcode-server --lib \
  provider::claude::runtime::targeted_task_correlation_tests::targeted_task_correlation_late_explicit_sibling_revokes_provisional_fallback \
  -- --exact --nocapture
cargo test -p bibcode-server --lib \
  provider::claude::runtime::targeted_task_correlation_tests::targeted_task_correlation_exact_evidence_resolves_one_child_after_fallback_ambiguity \
  -- --exact --nocapture
```

Expected on unchanged production code: both late-sibling tests fail because installed fallbacks are not revoked; the exact follow-up cannot establish the required post-revocation starting state.

- [ ] **Step 5: Replace the untyped fallback field with one coherent provisional value**

Add this private type and field:

```rust
#[derive(Debug, Clone, Eq, PartialEq)]
struct ClaudeProvisionalFallback {
    agent_id: String,
    parent_agent_id: String,
    promoted_parentless_lineage: bool,
}

#[derive(Debug, Default)]
struct ClaudeTaskCorrelation {
    invocation_is_agent: Option<bool>,
    invocation_source: Option<ClaudeInvocationSource>,
    pre_tool_source: Option<ClaudeHookSource>,
    hook_source: Option<ClaudeHookSource>,
    launched_agent_id: Option<String>,
    provisional_fallback: Option<ClaudeProvisionalFallback>,
    task_id: Option<String>,
    conflicted: bool,
}

impl ClaudeTaskCorrelation {
    fn effective_agent_id(&self) -> Option<&str> {
        self.launched_agent_id.as_deref().or_else(|| {
            self.provisional_fallback
                .as_ref()
                .map(|fallback| fallback.agent_id.as_str())
        })
    }
}
```

Update the exact-launch conflict check to compare `fact.agent_id` with `provisional_fallback.agent_id`. On accepted exact evidence, set `launched_agent_id` and clear the whole `provisional_fallback` value atomically. Do not change exact source, task, lineage, tombstone, or generation checks.

Add `fallback_ambiguous_parents: BTreeSet<String>` to `ClaudeTaskControlCorrelator`, initialize it empty in `new`, include its count in `Debug`, and require it to remain at or below `ACTIVITY_PAGE_MAX_LENGTH` in `state_is_bounded`. `reset` already replaces the correlator through `Self::new`, so it is the only operation that clears this generation-owned ambiguity memory. Exact launch and terminal cleanup must not remove an entry.

- [ ] **Step 6: Add reversible fallback cleanup**

Implement this private owner method, preserving conditional map removal so it cannot erase a newer exact association:

```rust
fn revoke_provisional_fallback(
    &mut self,
    tool_use_id: &str,
) -> Option<ClaudeTaskControlEffect> {
    let (fallback, task_id) = {
        let record = self.correlations_by_tool_use.get(tool_use_id)?;
        (record.provisional_fallback.clone()?, record.task_id.clone())
    };
    self.correlations_by_tool_use
        .get_mut(tool_use_id)
        .expect("provisional correlation remains present")
        .provisional_fallback = None;

    if fallback.promoted_parentless_lineage
        && self.verified_agents.get(&fallback.agent_id)
            == Some(&ClaudeVerifiedLineage::Parent(fallback.parent_agent_id.clone()))
    {
        self.verified_agents
            .insert(fallback.agent_id.clone(), ClaudeVerifiedLineage::Root);
    }

    let owned_target = task_id.as_ref().is_some_and(|task_id| {
        self.actor_target_by_agent.get(&fallback.agent_id) == Some(task_id)
    });
    if owned_target {
        self.actor_target_by_agent.remove(&fallback.agent_id);
    }
    if let Some(task_id) = task_id
        && self.agent_by_task.get(&task_id) == Some(&fallback.agent_id)
    {
        self.agent_by_task.remove(&task_id);
    }

    owned_target.then(|| ClaudeTaskControlEffect::Retire {
        agent_id: fallback.agent_id,
    })
}
```

This method must not call `retire_identity_chain`: ambiguity is reversible and must not tombstone or delete the actor, task correlation, verified identity, or pending same-generation evidence.

- [ ] **Step 7: Reconcile from complete candidate sets and revoke before reassigning**

Rewrite `reconcile_parent_local_fallbacks` in four explicit phases:

1. Build `candidates_by_parent` from every active nested Agent/Task record with a task and no exact `launched_agent_id`, including records that already carry `provisional_fallback`.
2. Build child pools by classifying provisional children first. A `promoted_parentless_lineage` child remains in the global parentless pool even though its temporary verified lineage is `Parent`; an explicit-lineage provisional remains in its recorded parent's pool. Only then add unassigned verified children, excluding exact assignments, tombstones, and provisional agents already included.
3. Record affirmative ambiguity before mutating provisional state. Insert a parent when it has multiple eligible candidates or multiple compatible explicit-lineage children. When the global parentless pool contains at least one child and either multiple nested candidates or multiple parentless children, insert every parent represented in `candidates_by_parent`.
4. Validate every existing provisional fallback against the complete snapshot, collect invalid tool IDs, revoke all of them, rebuild the snapshot, and admit only cardinality-one assignments for parents absent from `fallback_ambiguous_parents`.

Use these exact ambiguity predicates:

```rust
for (parent_agent_id, tool_use_ids) in &candidates_by_parent {
    let child_count = children_by_parent
        .get(parent_agent_id)
        .map_or(0, Vec::len);
    if tool_use_ids.len() > 1 || child_count > 1 {
        self.fallback_ambiguous_parents
            .insert(parent_agent_id.clone());
    }
}
let parentless_competition = !parentless_children.is_empty()
    && (nested_candidate_count > 1 || parentless_children.len() > 1);
if parentless_competition {
    self.fallback_ambiguous_parents
        .extend(candidates_by_parent.keys().cloned());
}
```

The set is bounded because its members come only from the already bounded active candidate map. Do not mark a parent merely because evidence is missing or an unresolved root launch temporarily blocks admission; ambiguity memory requires affirmative multiple candidates or children.

Use these literal validity predicates:

```rust
let valid = if fallback.promoted_parentless_lineage {
    nested_candidate_count == 1
        && parentless_children.as_slice() == std::slice::from_ref(&fallback.agent_id)
        && !unresolved_root_launch
        && candidates_by_parent
            .get(&fallback.parent_agent_id)
            .is_some_and(|tools| tools.as_slice() == std::slice::from_ref(tool_use_id))
        && !children_by_parent.contains_key(&fallback.parent_agent_id)
} else {
    candidates_by_parent
        .get(&fallback.parent_agent_id)
        .is_some_and(|tools| tools.as_slice() == std::slice::from_ref(tool_use_id))
        && children_by_parent
            .get(&fallback.parent_agent_id)
            .is_some_and(|agents| {
                agents.as_slice() == std::slice::from_ref(&fallback.agent_id)
            })
};
```

Keep the vectors deterministically ordered through the existing `BTreeMap` iteration.

After invalid provisional values are revoked, rebuild the candidate/child snapshot before admission. New parentless admission stores:

```rust
ClaudeProvisionalFallback {
    agent_id: child_agent_id.clone(),
    parent_agent_id: parent_agent_id.clone(),
    promoted_parentless_lineage: true,
}
```

and changes verified lineage from `Root` to `Parent(parent_agent_id)`. New explicit-lineage admission stores the same value with `promoted_parentless_lineage: false` and leaves verified lineage unchanged. Return the collected `Retire` effects; the existing `reconcile_all` loop then installs only still-valid/new unique targets through `reconcile`.

Both parentless and explicit admission branches must first require:

```rust
!self.fallback_ambiguous_parents.contains(parent_agent_id)
```

Exact `launched_agent_id` records continue through the existing exact reconciliation path and never consult or clear this set.

- [ ] **Step 8: Update living architecture invariants in the same change**

In both living documents, extend the existing parent-local fallback paragraphs with this exact behavior:

```text
A fallback target is provisional until matching exact PostToolUse evidence promotes it.
It remains part of its parent's complete candidate set after installation. If later
same-generation evidence makes that set non-unique, the correlator synchronously
removes only the inferred target and inferred lineage, publishes unsupported control,
and retains the actors and task facts as unresolved evidence. Exact targets are not
revoked by sibling ambiguity, and exact evidence may later resolve one named child.
Affirmative parent-level ambiguity disables further fallback for that parent until
generation reset, so resolving one sibling exactly cannot reopen another by elimination.
```

Keep the existing statement that ambiguous control performs zero provider I/O and that order/timing are not correlation inputs.

- [ ] **Step 9: Run focused GREEN and the Claude runtime matrix**

Run sequentially:

```bash
cargo test -p bibcode-server --lib \
  provider::claude::runtime::targeted_task_correlation_tests::targeted_task_correlation_late_sibling_revokes_provisional_parentless_fallback \
  -- --exact --nocapture
cargo test -p bibcode-server --lib \
  provider::claude::runtime::targeted_task_correlation_tests::targeted_task_correlation_late_explicit_sibling_revokes_provisional_fallback \
  -- --exact --nocapture
cargo test -p bibcode-server --lib \
  provider::claude::runtime::targeted_task_correlation_tests::targeted_task_correlation_exact_evidence_resolves_one_child_after_fallback_ambiguity \
  -- --exact --nocapture
cargo test -p bibcode-server --lib provider::claude::runtime::targeted_task_correlation_tests -- --nocapture
cargo test -p bibcode-server --lib provider::claude::runtime::targeted_task_correlation_tests -- --test-threads=8
cargo test -p bibcode-server --lib provider::claude::runtime::targeted_task_correlation_tests -- --test-threads=12
```

Expected: the three new regressions and every existing exact/fallback/conflict/terminal/bounded-state test pass at all requested widths.

- [ ] **Step 10: Review and commit the owner repair**

Run:

```bash
cargo fmt --all --check
git diff --check
git diff -- apps/server/src/provider/claude/runtime.rs \
  docs/architecture/activity-observation.md docs/architecture/providers.md
```

Confirm there is no production deadline, hook schema, public Activity schema, lock, timer, task, retry, or serialization change. Then commit only Task 1 files:

```bash
git add apps/server/src/provider/claude/runtime.rs \
  docs/architecture/activity-observation.md docs/architecture/providers.md
git commit -m "fix(activity): revoke ambiguous Claude fallback targets"
```

---

### Task 2: Observe ambiguous control through the Activity stream

**Files:**

- Modify: `apps/server/tests/production_provider_runtime.rs:75-90`
- Modify: `apps/server/tests/production_provider_runtime.rs:1439-1485`
- Modify: `apps/server/tests/production_provider_runtime.rs:13678-13915`

**Interfaces:**

- Consumes: Task 1's order-independent target revocation, `subscribeActivity`, `ServerMessage::Chunk`, `tagged_rpc_request`, and the existing provider capture assertions.
- Produces: private `try_stream_rpc_request(WebSocketStream, &str, &str, Value) -> Result<(), String>`, `stream_rpc_message_until(WebSocketStream, tokio::time::Instant) -> Result<ServerMessage, String>`, `ambiguous_claude_children_are_observable_and_unsupported(&Value) -> bool`, and an event-driven version of `targeted_activity_rpc_keeps_ambiguous_claude_children_unsupported_without_provider_io`.
- Preserves: the original public RPC names, actor/control predicates, cancellation errors, and byte-for-byte provider-I/O assertions.

- [ ] **Step 1: Add fallible Activity-stream helpers**

Import `timeout_at` alongside `timeout`, and add these helpers beside `stream_rpc_request` and `stream_rpc_message`:

```rust
async fn try_stream_rpc_request<S>(
    socket: &mut WebSocketStream<S>,
    id: &str,
    tag: &str,
    payload: Value,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(
            json!({
                "_tag":"Request",
                "id":id,
                "tag":tag,
                "payload":payload,
                "headers":[]
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|error| format!("failed to send Activity stream request: {error}"))
}

async fn stream_rpc_message_until<S>(
    socket: &mut WebSocketStream<S>,
    deadline: tokio::time::Instant,
) -> Result<ServerMessage, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let frame = timeout_at(deadline, socket.next())
        .await
        .map_err(|_| "Activity stream deadline elapsed".to_owned())?
        .ok_or_else(|| "Activity stream closed before convergence".to_owned())?
        .map_err(|error| format!("invalid Activity stream frame: {error}"))?;
    let Message::Text(text) = frame else {
        return Err(format!("expected text Activity stream frame, got {frame:?}"));
    };
    serde_json::from_str(&text)
        .map_err(|error| format!("invalid Activity stream message: {error}"))
}
```

Do not change the existing infallible stream helpers used by unrelated tests.

- [ ] **Step 2: Connect before the provider turn and subscribe after admission**

After project/thread creation and before `thread.turn.start`, create one deadline and connect the dedicated stream WebSocket. Connection failure must close the main socket and join the server before panicking. Do not send `subscribeActivity` yet because production creates the Activity scope during provider launch:

```rust
const CLAUDE_ACTIVITY_INTEGRATION_TIMEOUT: Duration = Duration::from_secs(30);
let deadline = tokio::time::Instant::now() + CLAUDE_ACTIVITY_INTEGRATION_TIMEOUT;
let activity_connection = timeout_at(
    deadline,
    connect_async(format!("ws://{}/ws", handle.local_addr())),
)
.await;
let (mut activity_stream, _) = match activity_connection {
    Ok(Ok(connection)) => connection,
    Ok(Err(error)) => {
        let _ = socket.close(None).await;
        handle.shutdown();
        let join_result = handle.join().await;
        panic!(
            "Activity stream connection failed before provider launch: \
             error={error}; server_join={join_result:?}"
        );
    }
    Err(_) => {
        let _ = socket.close(None).await;
        handle.shutdown();
        let join_result = handle.join().await;
        panic!(
            "Activity stream connection deadline elapsed before provider launch; \
             server_join={join_result:?}"
        );
    }
};
let mut last_snapshot = None::<Value>;
let setup_result = timeout_at(deadline, async {
    tagged_rpc_request(
        &mut socket,
        "9603",
        "orchestration.dispatchCommand",
        json!({
            "type":"thread.turn.start","commandId":"claude-ambiguous-turn",
            "threadId":"claude-ambiguous-thread",
            "message":{
                "messageId":"claude-ambiguous-message","role":"user",
                "text":"start","attachments":[]
            },
            "modelSelection":{
                "instanceId":"claude-targeted-ambiguous","model":"claude-sonnet"
            },
            "runtimeMode":"full-access","interactionMode":"default","createdAt":NOW
        }),
    )
    .await
    .map_err(|error| format!("ambiguous Claude turn admission failed: {error}"))?;
    try_stream_rpc_request(
        &mut activity_stream,
        "9690",
        "subscribeActivity",
        json!({"_tag":"thread","threadId":"claude-ambiguous-thread"}),
    )
    .await?;
    let initial = stream_rpc_message_until(&mut activity_stream, deadline).await?;
    if !matches!(initial, ServerMessage::Chunk { ref values, .. }
        if values[0]["kind"] == "snapshot")
    {
        return Err(format!("initial Activity message was not a snapshot: {initial:?}"));
    }
    activity_stream
        .send(Message::Text(
            json!({"_tag":"Ack","requestId":"9690"})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|error| format!("failed to ACK initial Activity snapshot: {error}"))?;

    Ok::<(), String>(())
})
.await;
```

Before the final `Ok(())`, move the existing ready-marker wait and unchanged literal array of six authenticated hook POSTs into this setup block, after the initial Activity snapshot is ACKed. Replace each panicking `.expect` call inside the block with a stage-specific `map_err` call. The outer `timeout_at` uses the one shared absolute deadline; do not construct a new timeout duration at any later milestone. Handle `setup_result` with the owner-cleanup branch from Step 4 before entering the convergence loop.

The required order is therefore: connect stream socket, admit turn and create the scope, subscribe and ACK the initial snapshot, observe the positive fixture-ready marker, then send hooks. The clean pre-amendment RED for awaiting subscription before turn admission is `ActivityError(notFound)` followed by `server_join=Ok(())`; preserve it in the task report.

- [ ] **Step 3: Replace the snapshot hammer with notification-driven reads**

Delete the `timeout(Duration::from_secs(10))` loop that repeatedly calls `activity.getSnapshot` and `yield_now`. Retain `last_snapshot: Option<Value>` for diagnostics. Use this complete replacement loop; its successful value is the authoritative snapshot:

```rust
let mut request_id = 9_700_u64;
let observation = timeout_at(deadline, async {
    loop {
        let message = stream_rpc_message_until(&mut activity_stream, deadline).await?;
        let ServerMessage::Chunk { .. } = message else {
            return Err(format!("unexpected Activity stream message: {message:?}"));
        };
        activity_stream
            .send(Message::Text(
                json!({"_tag":"Ack","requestId":"9690"})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|error| format!("failed to ACK Activity stream: {error}"))?;

        request_id += 1;
        let snapshot = tagged_rpc_request(
            &mut socket,
            &request_id.to_string(),
            "activity.getSnapshot",
            json!({"_tag":"thread","threadId":"claude-ambiguous-thread"}),
        )
        .await
        .map_err(|error| format!("authoritative Activity snapshot failed: {error}"))?;
        last_snapshot = Some(snapshot.clone());
        if ambiguous_claude_children_are_observable_and_unsupported(&snapshot) {
            break Ok::<Value, String>(snapshot);
        }
    }
})
.await;
```

Add this private predicate beside the test and call it from the loop:

```rust
fn ambiguous_claude_children_are_observable_and_unsupported(snapshot: &Value) -> bool {
    let actors = snapshot["actors"].as_array();
    let controls = snapshot["control"]["actors"].as_array();
    let both_running = ["agent-child-one", "agent-child-two"]
        .iter()
        .all(|agent_id| {
            actors.is_some_and(|actors| actors.iter().any(|actor| {
                actor["id"] == format!("claude:agent:{agent_id}")
                    && actor["status"] == "running"
            }))
        });
    let both_unsupported = ["agent-child-one", "agent-child-two"]
        .iter()
        .all(|agent_id| {
            controls.is_some_and(|controls| controls.iter().any(|control| {
                control["actorId"] == format!("claude:agent:{agent_id}")
                    && control["state"] == "unsupported"
            }))
        });
    let parent_available = controls.is_some_and(|controls| controls.iter().any(|control| {
        control["actorId"] == "claude:agent:agent-parent"
            && control["state"] == "available"
    }));
    both_running && both_unsupported && parent_available
}
```

This predicate requires all three facts together:

- child one and child two actors are `running`;
- child one and child two controls are `unsupported`; and
- the parent control is `available`.

Issue at most one authoritative snapshot per Activity chunk. The Activity stream is the wake-up source; snapshots remain the final public source of truth.

- [ ] **Step 4: Make every failure path release owners before panic**

Convert both `setup_result` and the convergence loop's nested `Result<Result<Value, String>, Elapsed>` to `Result<_, String>` by mapping `Elapsed` to a stage-specific message. On setup failure, perform the cleanup below immediately. On convergence completion, extract the snapshot with this shape:

```rust
let observation = observation
    .map_err(|_| "shared 30-second Claude Activity deadline elapsed".to_owned())
    .and_then(std::convert::identity);
let snapshot = match observation {
    Ok(snapshot) => snapshot,
    Err(error) => {
        let diagnostic_snapshot = last_snapshot.clone().unwrap_or(Value::Null);
        let diagnostic_capture = std::fs::read_to_string(&capture).unwrap_or_default();
        let _ = activity_stream.close(None).await;
        let _ = socket.close(None).await;
        handle.shutdown();
        let join_result = handle.join().await;
        panic!(
            "ambiguous Claude Activity observation failed: {error}; \
             last_snapshot={diagnostic_snapshot}; provider_capture={diagnostic_capture:?}; \
             server_join={join_result:?}"
        );
    }
};
```

On success, keep both public `activity.cancelSubtree` assertions, the exact `targetUnavailable` payload, unchanged capture bytes, zero `stop_task` targets, and zero root interrupts. Close `activity_stream` before the main socket, then call `handle.shutdown()` and await `handle.join()`.

- [ ] **Step 5: Run the exact public regression**

Run:

```bash
cargo test -p bibcode-server --test production_provider_runtime \
  targeted_activity_rpc_keeps_ambiguous_claude_children_unsupported_without_provider_io \
  -- --exact --nocapture
```

Expected: 1 passed; both actors are visible/running, both controls are unsupported, both cancellation attempts fail locally, provider capture bytes do not change, and the runtime shuts down cleanly.

- [ ] **Step 6: Run the integration binary at native widths**

Run sequentially:

```bash
cargo test -p bibcode-server --test production_provider_runtime -- --nocapture
cargo test -p bibcode-server --test production_provider_runtime -- --test-threads=8
cargo test -p bibcode-server --test production_provider_runtime -- --test-threads=12
```

Expected: the complete integration binary passes at default, 8, and 12 harness threads. No test acquires a global provider lock or uses `--test-threads=1`.

- [ ] **Step 7: Run the direct eight-runtime concurrency harness**

Resolve the most recently built integration binary and launch eight copies without Cargo coordination:

```bash
test_binary="$(
node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const directory = path.join("target", "debug", "deps");
const candidates = fs.readdirSync(directory)
  .filter((name) => /^production_provider_runtime-[0-9a-f]+$/.test(name))
  .map((name) => {
    const full = path.join(directory, name);
    return { full, stat: fs.statSync(full) };
  })
  .filter(({ stat }) => stat.isFile() && (stat.mode & 0o111) !== 0)
  .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
if (candidates.length === 0) process.exit(1);
process.stdout.write(candidates[0].full);
NODE
)"
log_root="$(mktemp -d /tmp/bibcode-claude-fallback-load.XXXXXX)"
pids=()
for index in {1..8}; do
  "$test_binary" \
    targeted_activity_rpc_keeps_ambiguous_claude_children_unsupported_without_provider_io \
    --exact --nocapture >"$log_root/run-$index.log" 2>&1 &
  pids+=("$!")
done
parallel_exit=0
for pid in "${pids[@]}"; do
  wait "$pid" || parallel_exit=1
done
rg -n "test result:|FAILED|panicked|Elapsed" "$log_root"
exit "$parallel_exit"
```

Expected: all eight processes exit 0; every log reports 1 passed; no log contains `FAILED`, `panicked`, or `Elapsed`. Preserve `log_root` in the final report as diagnostic evidence rather than deleting it during validation.

- [ ] **Step 8: Review and commit the public regression**

Run:

```bash
cargo fmt --all --check
git diff --check
git diff -- apps/server/tests/production_provider_runtime.rs
```

Confirm the test sends no repeated snapshot request without a preceding Activity notification and uses one absolute deadline. Then commit only the integration test:

```bash
git add apps/server/tests/production_provider_runtime.rs
git commit -m "test(activity): observe ambiguous Claude control by stream"
```

---

### Task 3: Verify the repair under package and workspace load

**Files:**

- Review: `apps/server/src/provider/claude/runtime.rs`
- Review: `apps/server/tests/production_provider_runtime.rs`
- Review: `docs/architecture/activity-observation.md`
- Review: `docs/architecture/providers.md`
- Review: `docs/superpowers/specs/2026-08-16-claude-provisional-fallback-revocation-design.md`
- Review: `docs/superpowers/plans/2026-08-16-claude-provisional-fallback-revocation.md`

**Interfaces:**

- Consumes: Tasks 1 and 2 and their committed focused evidence.
- Produces: final static, server-package, workspace-graph, scope, and independent-review evidence with no additional product changes unless a genuine finding receives its own RED.

- [ ] **Step 1: Run Rust formatting and all-target server Clippy**

Run sequentially:

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: both exit 0. Report the existing macOS compact-unwind linker warning separately if it appears; it is not a Clippy failure.

- [ ] **Step 2: Run repository static gates**

Run sequentially:

```bash
vp check
vp run typecheck
```

Expected: both exit 0. Existing nonfatal Effect schema suggestions may be reported but are not failures.

- [ ] **Step 3: Run the server package as the sole Cargo owner**

Run:

```bash
cargo test -p bibcode-server -j 2
```

Expected: the server library, every integration binary, and doc tests pass. Do not start another Cargo command while this command owns the shared target.

- [ ] **Step 4: Run one fresh workspace graph as the sole graph owner**

Run:

```bash
vp run test
```

Expected: all workspace package tasks pass, including the exact integration that originally failed. If any different test fails, stop immediately, preserve its output, and report the new blocker without another graph rerun or unrelated source edit.

- [ ] **Step 5: Perform the final scope and invariant audit**

Run:

```bash
git diff --check
git status --short
rg -n "test-threads=1|sleep\(|sleep_until|CLAUDE_ACTIVITY_INTEGRATION_TIMEOUT|provisional_fallback" \
  apps/server/src/provider/claude/runtime.rs \
  apps/server/tests/production_provider_runtime.rs \
  docs/architecture/activity-observation.md \
  docs/architecture/providers.md
git diff a8343047..HEAD -- \
  apps/server/src/provider/claude/runtime.rs \
  apps/server/tests/production_provider_runtime.rs \
  docs/architecture/activity-observation.md \
  docs/architecture/providers.md \
  docs/superpowers/specs/2026-08-16-claude-provisional-fallback-revocation-design.md \
  docs/superpowers/plans/2026-08-16-claude-provisional-fallback-revocation.md
```

Confirm:

- only the planned correlator, public integration test, living docs, approved spec, and this plan changed in the range;
- exact targets cannot enter the provisional revocation path;
- fallback revocation removes only matching inferred maps and inferred lineage;
- actors/task facts remain bounded and untombstoned after ambiguity;
- public cancellation writes zero provider bytes while unsupported;
- no production timeout, concurrency, package script, workflow, dependency, or generated file changed; and
- `.codegraph/` remains ignored and unstaged.

- [ ] **Step 6: Request an independent read-only review**

Provide the reviewer the stable range `a8343047..HEAD`, the approved design, this plan, the focused RED/GREEN logs, the eight-runtime log directory, server-package result, and workspace-graph result. Require this verdict shape:

```text
Critical: 0, or a numbered list of concrete findings
Important: 0, or a numbered list of concrete findings
Minor: 0, or a numbered list of concrete findings
Spec compliant: Yes or No with the violated requirement
Quality approved: Yes or No with the blocking reason
Ready: Yes or No with the blocking reason
```

Address any Critical or Important finding with a deterministic RED, focused GREEN, proportionate static gates, a separate scoped commit, and re-review. Do not rerun the broad graph when the finding is confined to already-covered owner logic unless the fix changes runtime behavior exercised only there.

- [ ] **Step 7: Report completion evidence and residual risk**

Report:

- owner-level late-sibling and exact-promotion RED/GREEN results;
- Claude runtime default/8/12 results;
- public integration exact/default/8/12 results;
- direct eight-runtime concurrency results and log path;
- server package and workspace graph outcomes;
- fmt, Clippy, `vp check`, and typecheck outcomes;
- exact commit SHAs and final clean status;
- independent review verdict; and
- native Windows execution as a residual only if the changed shared Rust code could not be exercised there; Windows CI must retain compile/test coverage.
