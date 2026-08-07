# Center Focus and Activity Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix center-terminal focus theft, restore Codex subagent activity when descendant listing is empty, and make multiline Activity controls intrinsically sized.

**Architecture:** The web app will pass pane-focus eligibility independently from the monotonic terminal focus request and will express multiline sizing through the shared Button primitive. The Rust Codex tracker will convert validated live or recovered `subAgentActivity` items into canonical provisional actors plus bounded child-read hints; the runtime will merge those hints with legacy list discovery under its existing epoch and cancellation fences.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, class-variance-authority, xterm 6, Rust, Tokio, Serde JSON, Codex App Server JSON-RPC, Vite+ tests, Cargo tests, Tauri 2, Codex Computer Use.

## Global Constraints

- Preserve all unrelated worktree changes and the approved design at `docs/superpowers/specs/2026-08-06-center-focus-and-activity-reliability-design.md`.
- Create no public Effect RPC schema, persisted activity shape, database migration, desktop bridge command, dependency, or provider-facing command.
- Keep `packages/contracts` schema-only and unchanged unless executable evidence disproves the approved design.
- Keep all Codex hint and history work bounded by 50 descendants, 20 turns per thread, 200 recovered entries per thread, and existing mutation limits.
- Preserve epoch fencing, cancellation, activity authorization, scope binding, sanitization, redaction, and raw-reasoning exclusion.
- Preserve legacy `thread/list` discovery and truthful capability downgrade for incompatible methods.
- Do not scrape rollout files or arbitrary terminal output.
- Do not create intermediate commits; make one final commit only after every required check and visual verification succeeds.
- Required completion gates are focused tests, broader applicable tests, `vp test`, `vp check`, `vp run typecheck`, Rust formatting/tests/Clippy, the desktop build, exact-bundle light/dark Computer Use verification, and final diff/status review.

## File Map

### Web presentation and focus

- Modify `apps/web/src/components/ui/button.tsx`: own the reusable intrinsic-content button size.
- Create `apps/web/src/components/ui/button.test.tsx`: prove the size contract contains no fixed responsive height.
- Modify `apps/web/src/components/activity/ActivityRoster.tsx`: use the intrinsic-content size for multiline roster rows.
- Modify `apps/web/src/components/activity/ActivityDock.tsx`: use the same size for expanded section rows.
- Modify `apps/web/src/components/activity/ActivityPanel.test.tsx`: cover the roster's sizing contract without weakening content/selection assertions.
- Modify `apps/web/src/components/activity/ActivityDock.test.tsx`: cover both expanded section controls.
- Modify `apps/web/src/components/ChatView.tsx`: pass a stable request ID and separate pane-focus eligibility.
- Modify `apps/web/src/components/CenterTerminalPanel.tsx`: forward the two focus inputs without interpreting them.
- Modify `apps/web/src/components/CenterTerminalPanel.test.tsx`: prove forwarding behavior.
- Modify `apps/web/src/components/ThreadTerminalPanel.tsx`: combine external eligibility with the selected local terminal before setting viewport autofocus.
- Modify `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx`: preserve the outstanding-request and animation-frame behavior.
- Modify `apps/web/src/components/ChatView.hooks.test.tsx`: prove an unfocused split receives the unchanged non-zero request token and `focusEligible={false}`.

### Codex activity

- Modify `apps/server/src/provider/codex/activity.rs`: parse one live/recovered hint path, seed canonical actors, return bounded read hints, validate descendant topology, and expose accepted reads.
- Modify `apps/server/src/provider/codex/runtime.rs`: retain bounded hinted IDs in the current activity generation, merge discovery sources, direct-read descendants breadth-first, and compute truthful recovery capabilities.
- Modify `apps/server/tests/provider_codex.rs`: reproduce Codex 0.146 empty-list behavior and cover nested recovery, deduplication, invalid topology, cancellation, and compatibility.

### Living documentation and completion

- Modify `docs/architecture/activity-observation.md`: document list-plus-hint Codex recovery and downgrade behavior.
- Modify `docs/providers/codex.md`: document provider-specific direct-read compatibility.
- Modify `docs/user/workspace-ui.md`: state the center focus/autofocus invariant.
- Keep the approved spec and this plan for the final commit.

---

### Task 1: Intrinsic Activity Control Sizing

**Files:**

- Create: `apps/web/src/components/ui/button.test.tsx`
- Modify: `apps/web/src/components/ui/button.tsx:10-54`
- Modify: `apps/web/src/components/activity/ActivityRoster.tsx:184-235`
- Modify: `apps/web/src/components/activity/ActivityDock.tsx:421-542`
- Test: `apps/web/src/components/activity/ActivityPanel.test.tsx`
- Test: `apps/web/src/components/activity/ActivityDock.test.tsx`

**Interfaces:**

- Consumes: existing `Button`, `buttonVariants`, and Tailwind-merge behavior.
- Produces: `ButtonProps.size = "content"`, with `min-h-9 sm:min-h-8`, normal horizontal padding, and no `h-*` or `sm:h-*` utility.

- [ ] **Step 1: Add a failing shared-primitive contract test**

Create `apps/web/src/components/ui/button.test.tsx`:

```tsx
import { describe, expect, it } from "vite-plus/test";

import { buttonVariants } from "./button";

describe("buttonVariants content size", () => {
  it("uses responsive minimum heights without a fixed height", () => {
    const classes = buttonVariants({ size: "content" });

    expect(classes).toContain("min-h-9");
    expect(classes).toContain("sm:min-h-8");
    expect(classes).not.toMatch(/(?:^|\s)h-[^\s]+/);
    expect(classes).not.toMatch(/(?:^|\s)sm:h-[^\s]+/);
  });
});
```

- [ ] **Step 2: Extend the Activity component tests so they fail on the current responsive classes**

In the existing Activity roster test, assert the first multiline row uses the content-size contract:

```tsx
expect(older.className).toContain("min-h-9");
expect(older.className).toContain("sm:min-h-8");
expect(older.className).not.toContain("sm:h-8");
```

In the expanded Activity dock test, inspect both `[data-activity-section]` buttons:

```tsx
const sectionButtons = Array.from(
  container.querySelectorAll<HTMLButtonElement>("button[data-activity-section]"),
);
expect(sectionButtons).toHaveLength(2);
expect(sectionButtons.every((button) => button.className.includes("min-h-9"))).toBe(true);
expect(sectionButtons.every((button) => button.className.includes("sm:min-h-8"))).toBe(true);
expect(sectionButtons.every((button) => !button.className.includes("sm:h-7"))).toBe(true);
```

- [ ] **Step 3: Run the focused tests and confirm the red state**

Run:

```bash
vp test run --project unit \
  apps/web/src/components/ui/button.test.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/activity/ActivityDock.test.tsx
```

Expected: the new `content` size is absent or the Activity rows retain fixed responsive height classes.

- [ ] **Step 4: Implement the intrinsic-content Button size**

Add this size beside `default` in `buttonVariants`:

```tsx
content: "min-h-9 px-[calc(--spacing(3)-1px)] sm:min-h-8",
```

Update `ActivityRecordRow`:

```tsx
<Button
  className="w-full items-start justify-start gap-3 whitespace-normal px-3 py-2 text-left"
  data-activity-row={record.id}
  onClick={() => onSelect(record)}
  ref={(element) => registerRow(record.id, element)}
  size="content"
  variant="ghost"
>
```

Update both expanded Activity dock section buttons to use:

```tsx
className="w-full justify-start px-2 py-1.5 text-left"
size="content"
```

Do not change the dock's single-line expand/collapse button.

- [ ] **Step 5: Run the focused tests and confirm the green state**

Run the Step 3 command. Expected: all listed tests pass, and existing roster order, accessible names, and click behavior remain green.

- [ ] **Step 6: Review the task diff**

Run:

```bash
git diff --check
git diff -- apps/web/src/components/ui/button.tsx \
  apps/web/src/components/ui/button.test.tsx \
  apps/web/src/components/activity/ActivityRoster.tsx \
  apps/web/src/components/activity/ActivityDock.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/activity/ActivityDock.test.tsx
```

Confirm fixed-height sizes remain unchanged for icon and single-line buttons. Do not commit.

---

### Task 2: Center-Pane Terminal Focus Eligibility

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx:1030-1105`
- Modify: `apps/web/src/components/CenterTerminalPanel.tsx:11-89`
- Modify: `apps/web/src/components/ThreadTerminalPanel.tsx:1774-1806,1840-1864,2147-2203`
- Test: `apps/web/src/components/CenterTerminalPanel.test.tsx`
- Test: `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx`
- Test: `apps/web/src/components/ChatView.hooks.test.tsx`

**Interfaces:**

- Consumes: `CenterPanelSurfaceRenderContext.focused` and monotonic `terminalFocusRequestId`.
- Produces: required `CenterTerminalPanelProps.focusEligible: boolean` and optional `ThreadTerminalPanelProps.focusEligible?: boolean`, defaulting to `true` for non-center callers.
- Preserves: `TerminalViewport.focusRequestId` and `TerminalViewport.autoFocus`; no viewport API change is required.

- [ ] **Step 1: Write failing forwarding tests**

In `CenterTerminalPanel.test.tsx`, render with a non-zero token and ineligible pane:

```tsx
<CenterTerminalPanel
  threadRef={{ environmentId: EnvironmentId.make("environment-1"), threadId: ThreadId.make("thread-1") }}
  projectId={ProjectId.make("project-1")}
  surface={{ id: "terminal:term-1", kind: "terminal", terminalId: "term-1" }}
  launchContext={{ cwd: "/repo", worktreePath: null, runtimeEnv: {} }}
  keybindings={{} as never}
  focusRequestId={7}
  focusEligible={false}
  onAddTerminalContext={vi.fn()}
  onClose={vi.fn()}
/>

expect(h.panelProps).toMatchObject({ focusRequestId: 7, focusEligible: false });
```

Update existing renders in this file to pass `focusEligible` explicitly.

- [ ] **Step 2: Write a failing ChatView split regression**

Use the existing hook-state harness to seed a non-zero request:

```tsx
seedHostState("terminalFocusRequestId", 7);
```

Seed a two-group layout whose chat group is focused and terminal group is visible. After rendering, assert the mocked `CenterTerminalPanel` receives:

```tsx
expect(capturedProps<Record<string, unknown>>("centerTerminalPanel")).toMatchObject({
  focusRequestId: 7,
  focusEligible: false,
});
```

Then focus the terminal group through the captured workspace callback and assert the token remains `7` while eligibility becomes `true`. Focus the chat group again and assert the token remains `7` while eligibility returns to `false`.

- [ ] **Step 3: Write the viewport-level outstanding-request regression**

Add to `ThreadTerminalPanel.interactions.test.tsx` beside the existing focus tests:

```tsx
it("keeps an ineligible focus request outstanding until the pane becomes eligible", async () => {
  const view = await mountViewport({ visible: true, autoFocus: false, focusRequestId: 7 });
  const terminal = view.fakeTerminal!;

  await view.flushFrame();
  expect(terminal.focus).not.toHaveBeenCalled();

  await view.setAutoFocus(true);
  await view.flushFrame();
  expect(terminal.focus).toHaveBeenCalledOnce();

  terminal.focus.mockClear();
  await view.setAutoFocus(false);
  await view.setAutoFocus(true);
  await view.flushFrame();
  expect(terminal.focus).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run focused tests and verify the red state**

Run:

```bash
vp test run --project unit \
  apps/web/src/components/CenterTerminalPanel.test.tsx \
  apps/web/src/components/ChatView.hooks.test.tsx \
  apps/web/src/components/ChatView.test.tsx \
  apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx
```

Expected: center props lack `focusEligible`, and ChatView converts the non-zero token to `0` for the unfocused pane.

- [ ] **Step 5: Implement explicit focus eligibility**

Add to `CenterTerminalPanelProps` and forward it:

```tsx
focusRequestId: number;
focusEligible: boolean;
```

```tsx
<ThreadTerminalPanel
  ...
  focusRequestId={focusRequestId}
  focusEligible={focusEligible}
  ...
/>
```

Add to `ThreadTerminalPanelProps`:

```tsx
focusEligible?: boolean;
```

Destructure with a default:

```tsx
focusRequestId,
focusEligible = true,
```

Set viewport autofocus only when both ownership conditions hold:

```tsx
autoFocus={focusEligible && terminalId === resolvedActiveTerminalId}
```

For the single active renderer use:

```tsx
autoFocus={focusEligible}
```

Finally replace the ChatView sentinel expression:

```tsx
focusRequestId={terminalFocusRequestId}
focusEligible={context.focused}
```

- [ ] **Step 6: Run focused tests and inspect the focus call path**

Run the Step 4 command. Expected: all tests pass. Then run:

```bash
rg -n "focusRequestId=.*\? .*: 0|focusEligible|autoFocus=" \
  apps/web/src/components/ChatView.tsx \
  apps/web/src/components/CenterTerminalPanel.tsx \
  apps/web/src/components/ThreadTerminalPanel.tsx
```

Confirm no inactive sentinel remains and right-panel callers retain the default `true` eligibility. Do not commit.

---

### Task 3: Canonical Codex Subagent Hint Tracking

**Files:**

- Modify: `apps/server/src/provider/codex/activity.rs:35-74,221-530,1223-1483`
- Test: unit tests inside `apps/server/src/provider/codex/activity.rs`

**Interfaces:**

- Consumes: live JSON `subAgentActivity` items and typed historical `ReconciliationThreadItem::SubAgentActivity` values.
- Produces: `CodexActivityOutput.hinted_descendant_ids: Vec<String>`; provisional `UpsertActor` mutations; `CodexDescendantReconciliation.accepted_thread_ids: Vec<String>`; one shared live/history hint-normalization path.

- [ ] **Step 1: Write failing tracker tests for valid live hints**

Add a unit test that seeds root `provider-root`, sends:

```rust
let output = tracker.handle_notification(
    "item/started",
    &serde_json::json!({
        "threadId": "provider-root",
        "turnId": "root-turn",
        "item": {
            "id": "spawn-child",
            "type": "subAgentActivity",
            "agentThreadId": "child-1",
            "agentPath": "/root/reviewer",
            "kind": "started"
        }
    }),
    2_000,
    1,
);
```

Assert exactly one `UpsertActor` has ID `codex:thread:child-1`, name `reviewer`, no parent, `running`, timestamps derived from `2_000`, and that `hinted_descendant_ids == ["child-1"]` with reconciliation requested.

- [ ] **Step 2: Write failing tracker tests for topology, lifecycle, and deduplication**

Cover these exact inputs and outcomes:

```rust
// Verified child owns a nested hint.
assert_eq!(nested_actor.parent_actor_id.as_deref(), Some("codex:thread:child-1"));

// Interrupted is terminal.
assert_eq!(interrupted_actor.status, ActivityLifecycle::Interrupted);
assert_eq!(interrupted_actor.terminal_at, Some(interrupted_actor.updated_at.clone()));

// Duplicate live item produces no new actor mutation, read hint, or reconciliation request.
assert!(duplicate.mutations.is_empty());
assert!(duplicate.hinted_descendant_ids.is_empty());
assert!(!duplicate.request_reconciliation);
```

Also assert empty/whitespace IDs, whitespace-containing native IDs, empty paths, unknown kinds, root self-links, unverified owners, and parent cycles produce `CodexActivityOutput::default()`.

- [ ] **Step 3: Write failing recovery tests for historical hints**

Construct a root `ReconciliationThread` containing a recent `SubAgentActivity` item and assert a new tracker method:

```rust
let output = tracker.reconcile_sub_agent_hints(&root_thread);
assert_eq!(output.hinted_descendant_ids, vec!["child-1"]);
```

Construct a child thread whose bounded recent history hints `child-nested`; after the child actor is verified, assert the nested actor and parent relationship are emitted. Include more than 20 old turns and prove only the newest 20 are scanned.

- [ ] **Step 4: Write a failing accepted-read topology test**

Extend `CodexDescendantReconciliation` expectations:

```rust
let reconciliation = tracker.reconcile_descendants(&[valid_child]);
assert_eq!(reconciliation.accepted_thread_ids, vec!["child-1"]);

let rejected = tracker.reconcile_descendants(&[mismatched_parent]);
assert!(rejected.accepted_thread_ids.is_empty());
```

Cover self-parent and a child whose parent is neither root nor a verified actor.

- [ ] **Step 5: Run tracker tests and verify the red state**

Run:

```bash
cargo test -p bibcode-server provider::codex::activity::tests::sub_agent -- --nocapture
```

If test name filtering misses one new case, run:

```bash
cargo test -p bibcode-server provider::codex::activity::tests -- --nocapture
```

Expected: the current tracker only requests list reconciliation and exposes neither provisional actors nor read IDs.

- [ ] **Step 6: Extend the tracker output and merge policy**

Change the internal outputs to:

```rust
#[derive(Debug, Default)]
pub struct CodexActivityOutput {
    pub mutations: Vec<ProviderActivityMutation>,
    pub request_reconciliation: bool,
    pub hinted_descendant_ids: Vec<String>,
}

#[derive(Debug, Default)]
pub(crate) struct CodexDescendantReconciliation {
    pub output: CodexActivityOutput,
    pub threads_to_read: Vec<String>,
    pub accepted_thread_ids: Vec<String>,
}
```

Add bounded output helpers that append no more than `MAX_RECONCILED_DESCENDANTS` unique hinted IDs and no more than `MAX_MUTATIONS_PER_OUTPUT` mutations.

- [ ] **Step 7: Implement one live/history hint normalization path**

Refactor `handle_sub_agent_activity` to accept `&mut self` and the provider timestamp. Normalize the fields into:

```rust
struct ValidatedSubAgentHint<'a> {
    native_thread_id: &'a str,
    fallback_name: String,
    status: ActivityLifecycle,
}
```

The validator must:

```rust
let status = match kind {
    "started" | "interacted" => ActivityLifecycle::Running,
    "interrupted" => ActivityLifecycle::Interrupted,
    _ => return None,
};
```

Use `usable_native_id`, the final non-empty `agentPath` segment, `bounded_label`, root/verified-parent checks, and the existing `upsert_actor_state`. Pass `ActorReopenAuthority::ProviderTimestamp(timestamp)` only for accepted non-terminal hints. Derive historical timestamps from `completed_at`, then `started_at`, then `thread.updated_at`, in that order.

Implement `reconcile_sub_agent_hints(&ReconciliationThread)` by scanning at most the newest `MAX_RECONCILED_TURNS` and dispatching typed `SubAgentActivity` fields through the same validator/upsert helper. Do not feed these items into entry recovery; they are topology hints, not activity detail entries.

- [ ] **Step 8: Record accepted descendant metadata**

When `reconcile_descendants` accepts a unique child whose parent is root or a verified actor, push its raw native ID into `accepted_thread_ids`. Do not mark unresolved parents accepted. Keep the existing 50-descendant cap and loop that repairs nested parent ordering.

- [ ] **Step 9: Run tracker tests and review bounds**

Run both commands from Step 5. Expected: all tracker tests pass. Then inspect:

```bash
rg -n "MAX_RECONCILED_DESCENDANTS|MAX_RECONCILED_TURNS|hinted_descendant_ids|accepted_thread_ids" \
  apps/server/src/provider/codex/activity.rs
```

Confirm every hint collection and scan is explicitly bounded. Do not commit.

---

### Task 4: Bounded Codex Direct-Read Recovery

**Files:**

- Modify: `apps/server/src/provider/codex/runtime.rs:184-215,444-463,489-513,770-793,1191-1564,1648-1749`
- Test: `apps/server/tests/provider_codex.rs`

**Interfaces:**

- Consumes: `CodexActivityOutput.hinted_descendant_ids`, `reconcile_sub_agent_hints`, `reconcile_descendants.accepted_thread_ids`, existing `ThreadReadParams`, list results, epoch, and cancellation token.
- Produces: a bounded generation-owned pending-hint queue and a reconciliation pass that merges root history, live hints, list descendants, and nested child hints before direct reads.

- [ ] **Step 1: Replace the optimistic list-based test with a failing Codex 0.146 regression**

Update `sub_agent_activity_debounces_follow_up_reconciliation_and_repairs_nested_parentage` so every `thread/list` response is empty. Script these reads:

```rust
"thread/read" => match message["params"]["threadId"].as_str() {
    Some("provider-root") => json!({
        "thread": {
            "id": "provider-root",
            "createdAt": 1,
            "updatedAt": 4,
            "status": {"type": "idle"},
            "turns": [{
                "id": "root-turn",
                "status": "completed",
                "startedAt": 1,
                "completedAt": 4,
                "items": [{
                    "id": "spawn-direct",
                    "type": "subAgentActivity",
                    "agentThreadId": "child-direct",
                    "agentPath": "/root/direct",
                    "kind": "started"
                }]
            }]
        }
    }),
    Some("child-direct") => json!({
        "thread": {
            "id": "child-direct",
            "parentThreadId": "provider-root",
            "agentNickname": "Direct child",
            "agentRole": "worker",
            "createdAt": 2,
            "updatedAt": 4,
            "status": {"type": "notLoaded"},
            "turns": [{
                "id": "direct-turn",
                "status": "completed",
                "startedAt": 2,
                "completedAt": 4,
                "items": [
                    {"id": "spawn-nested", "type": "subAgentActivity", "agentThreadId": "child-nested", "agentPath": "/root/direct/nested", "kind": "started"},
                    {"id": "direct-result", "type": "agentMessage", "text": "Direct result"}
                ]
            }]
        }
    }),
    Some("child-nested") => json!({
        "thread": {
            "id": "child-nested",
            "parentThreadId": "child-direct",
            "agentNickname": "Nested child",
            "agentRole": "worker",
            "createdAt": 3,
            "updatedAt": 5,
            "status": {"type": "notLoaded"},
            "turns": [{"id": "nested-turn", "status": "completed", "startedAt": 3, "completedAt": 5, "items": [{"id": "nested-result", "type": "agentMessage", "text": "Nested result"}]}]
        }
    }),
    other => panic!("unexpected thread/read target {other:?}"),
},
```

Assert both actors, parentage, completed states, and result entries publish even though all lists are empty.

- [ ] **Step 2: Add failing restart, deduplication, and invalid-response tests**

Add separate integration tests for:

```rust
// Restart/reconnect recovery: no live subAgentActivity notification is sent;
// the initial/reconnected root read alone discovers the child.
assert!(reconciliation.activity.iter().any(|mutation| matches!(
    mutation,
    ProviderActivityMutation::UpsertActor(actor)
        if actor.id == "codex:thread:recovered-child"
)));

// Duplicate root/live hints produce one child read in the same pass.
assert_eq!(child_read_count, 1);

// Response ID mismatch and unrelated parent do not publish history.
assert!(!reconciliation.activity.iter().any(|mutation| matches!(
    mutation,
    ProviderActivityMutation::AppendEntry(entry)
        if entry.detail.as_deref() == Some("foreign result")
)));
```

Use the existing cancellation test pattern to hold a child read, replace the reconciliation epoch, release the response, and assert no stale activity event is emitted.

- [ ] **Step 3: Run the affected integration tests and verify the red state**

Run:

```bash
cargo test -p bibcode-server --test provider_codex sub_agent_activity -- --nocapture
cargo test -p bibcode-server --test provider_codex reconciliation -- --nocapture
```

Expected: empty lists produce no actors and root `thread/read` is not requested.

- [ ] **Step 4: Add the bounded generation-owned hint queue**

Extend `RuntimeActivityState`:

```rust
pending_hinted_descendants: VecDeque<String>,
pending_hinted_descendant_ids: HashSet<String>,
```

Initialize both empty. Add private helpers that:

- reject empty IDs and IDs already present;
- cap the queue and set at `RECONCILIATION_DESCENDANT_LIMIT`/50;
- preserve insertion order;
- snapshot without draining before a pass;
- remove an ID only after a valid direct read or a permanent incompatibility/rejection;
- clear both collections when activity is disabled or a different root is installed.

When `handle_notification` receives tracker output, enqueue `hinted_descendant_ids` while the activity lock and epoch are current, then emit mutations and request the existing debounced reconciliation. Reconnect to the same root keeps pending IDs but fences the old pass with the incremented epoch.

- [ ] **Step 5: Read bounded root history independently of list support**

At the beginning of `reconcile_once`, if `thread_read_support` is not `Unsupported`, request:

```rust
ThreadReadParams {
    thread_id: &root_thread_id,
    include_turns: true,
}
```

Require the returned ID to equal `root_thread_id`. Under the activity lock and current-pass check, call `tracker.reconcile_sub_agent_hints(&response.thread)`, append provisional actor mutations, and enqueue returned IDs. Mark `thread_read_support` supported after a decoded matching response. On method incompatibility, mark it unsupported and emit the existing one-time warning. On cancellation return silently; on transient failure emit stale and retain pending hints.

- [ ] **Step 6: Merge list IDs and process direct reads breadth-first**

Keep the paginated `thread/list` request. After `reconcile_descendants`, seed a local `VecDeque<String>` and `HashSet<String>` from:

1. pending hinted IDs;
2. `descendants.threads_to_read`.

Stop after `MAX_RECONCILED_DESCENDANTS` accepted/read candidates. For each ID:

1. request `thread/read(includeTurns: true)` with the pass cancellation token;
2. require the response ID to match the requested ID;
3. call `reconcile_descendants` with the returned thread and continue only if `accepted_thread_ids` contains the ID;
4. call `reconcile_sub_agent_hints` and enqueue new nested IDs if capacity remains;
5. call `reconcile_thread_history` and append canonical mutations;
6. remove the successfully verified ID from the persistent pending-hint queue.

Do not require list support before direct reads. Preserve transient failure as stale without deleting pending hints. Clear pending hints if `thread/read` is permanently incompatible.

- [ ] **Step 7: Make history capability truthful for both discovery sources**

Replace the current list-gated match with:

```rust
history_recovery: match (list_support, read_support) {
    (ReconciliationMethodSupport::Supported, ReconciliationMethodSupport::Supported) => {
        ActivityHistoryRecovery::Full
    }
    (ReconciliationMethodSupport::Unsupported, ReconciliationMethodSupport::Unsupported) => {
        ActivityHistoryRecovery::None
    }
    _ => ActivityHistoryRecovery::Bounded,
},
```

This reports full recovery only when both enumeration and direct history are proven, bounded recovery when exactly one source remains usable or unproven, and none only when both are incompatible.

- [ ] **Step 8: Update existing scripted peers for the root-read request**

For each affected `provider_codex.rs` peer, add an exact `thread/read` response for `provider-root`. Use an empty bounded root history when that test is unrelated:

```rust
json!({
    "thread": {
        "id": "provider-root",
        "createdAt": 1,
        "updatedAt": 1,
        "status": {"type": "idle"},
        "turns": []
    }
})
```

Do not relax peers to accept arbitrary methods; retain exact request and target assertions.

- [ ] **Step 9: Run focused and complete Codex provider tests**

Run:

```bash
cargo test -p bibcode-server provider::codex::activity::tests -- --nocapture
cargo test -p bibcode-server --test provider_codex -- --nocapture
```

Expected: all Codex tracker and runtime integration tests pass, including legacy list-only, incompatibility, cancellation, and background-terminal coverage.

- [ ] **Step 10: Run Rust formatting and affected-target Clippy**

Run:

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: both commands exit successfully. Do not commit.

---

### Task 5: Living Documentation Alignment

**Files:**

- Modify: `docs/architecture/activity-observation.md`
- Modify: `docs/providers/codex.md`
- Modify: `docs/user/workspace-ui.md`
- Review: `docs/superpowers/specs/2026-08-06-center-focus-and-activity-reliability-design.md`

**Interfaces:**

- Consumes: implemented runtime and focus behavior from Tasks 2-4.
- Produces: living documentation that states the actual current lifecycle and compatibility guarantees.

- [ ] **Step 1: Update Codex activity recovery documentation**

In `docs/architecture/activity-observation.md`, replace list-only wording with these explicit guarantees:

- structured Codex recovery merges validated bounded `subAgentActivity` hints with `thread/list` descendants;
- hinted child IDs are direct-read under the current activity generation;
- bounded root/child history repairs restart and nested topology;
- empty lists do not erase or suppress hinted actors;
- full history requires both listing and direct reads, one usable source reports bounded recovery, and two incompatible sources report none.

- [ ] **Step 2: Update the Codex provider guide**

In `docs/providers/codex.md`, document Codex 0.146 compatibility without pinning BiBCode to exactly that version:

```markdown
BiBCode accepts validated `subAgentActivity` items as bounded child-discovery
hints and direct-reads those child thread IDs. This remains effective when an
App Server version omits spawned children from `thread/list`; listing remains
enabled as a complementary discovery source for versions that expose it.
```

State that malformed/out-of-scope hints are ignored and that incompatible read/list methods downgrade recovery capabilities rather than disabling ordinary chat.

- [ ] **Step 3: Document center focus ownership**

In the Center Panel section of `docs/user/workspace-ui.md`, add:

```markdown
Only the focused center pane may programmatically focus its terminal. Moving
focus to a chat pane leaves visible terminals mounted but prevents them from
reclaiming keyboard input until the user explicitly activates a terminal again.
```

- [ ] **Step 4: Review documentation and formatting**

Run:

```bash
git diff --check
git diff -- docs/architecture/activity-observation.md \
  docs/providers/codex.md \
  docs/user/workspace-ui.md \
  docs/superpowers/specs/2026-08-06-center-focus-and-activity-reliability-design.md \
  docs/superpowers/plans/2026-08-06-center-focus-and-activity-reliability.md
```

Confirm living docs describe implemented behavior, while dated spec/plan files remain historical artifacts. Do not commit.

---

### Task 6: Repository Verification and Exact Desktop QA

**Files:**

- Review all files changed by Tasks 1-5.
- Build output only: existing ignored build directories; do not stage generated artifacts.

**Interfaces:**

- Consumes: all implemented fixes and tests.
- Produces: completion evidence and the single final commit.

- [ ] **Step 1: Run focused web regressions once more**

Run:

```bash
vp test run --project unit \
  apps/web/src/components/ui/button.test.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/activity/ActivityDock.test.tsx \
  apps/web/src/components/CenterTerminalPanel.test.tsx \
  apps/web/src/components/ChatView.hooks.test.tsx \
  apps/web/src/components/ChatView.test.tsx \
  apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx
```

Expected: all focused web regressions pass.

- [ ] **Step 2: Run focused Rust regressions once more**

Run:

```bash
cargo test -p bibcode-server provider::codex::activity::tests -- --nocapture
cargo test -p bibcode-server --test provider_codex -- --nocapture
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: all commands pass with no warnings.

- [ ] **Step 3: Run repository-wide required gates**

Run in this order:

```bash
vp run test
vp test
vp check
vp run typecheck
```

Expected: every command invoked exits successfully. Record the exact result and duration for the final report.

- [ ] **Step 4: Build the desktop app from this worktree**

Run:

```bash
vp run build:desktop
```

Locate the exact built `.app` under the Tauri bundle output, terminate only the prior worktree-built BiBCode process if necessary, and launch this exact bundle. Do not substitute `/Applications/BiBCode.app` or the mounted release image.

- [ ] **Step 5: Verify terminal focus with Codex Computer Use**

Using the bundled Codex Computer Use skill, not Orca:

1. create or open a chat and a center terminal in separate split panes;
2. type a harmless marker into the terminal;
3. click the chat composer;
4. type `composer-focus-ok`;
5. wait through queued UI frames and terminal output;
6. confirm the marker appears only in the composer and not at the shell prompt;
7. explicitly click the terminal and confirm typing returns to it.

Capture a screenshot that contains no secrets, environment values, private paths, or unrelated personal content.

- [ ] **Step 6: Verify Codex activity with an empty-list-compatible scenario**

In a clean demo workspace, ask Codex to create a bounded set of harmless subagents. Confirm:

- the Activity dock reports active/done actors;
- the right Activity panel lists every actor;
- completed details appear;
- closing/reopening the app or reconnecting preserves recovered actors;
- ordinary Codex chat remains usable.

Use only synthetic prompts and output suitable for marketing screenshots.

- [ ] **Step 7: Verify Activity layout in light and dark themes**

Open an Activity panel containing at least three actors whose rows show title, summary, and metadata. In each theme:

1. capture the panel screenshot;
2. inspect consecutive row top/bottom edges visually;
3. confirm no title, summary, metadata, icon, hover background, or focus ring overlaps another row;
4. confirm long names truncate and summaries remain at most two lines;
5. confirm the orange interaction theme remains unchanged.

- [ ] **Step 8: Perform final diff, generated-file, and scope review**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff
```

Confirm:

- only planned source, tests, living docs, spec, and plan files are present;
- `.codegraph/`, build artifacts, screenshots, logs, fixtures with secrets, and debug output are not staged;
- no dependency or lockfile drift occurred;
- no public contract or database shape changed;
- every acceptance criterion maps to passing evidence.

- [ ] **Step 9: Create the single final commit**

Stage only reviewed files explicitly, then commit once:

```bash
git add \
  apps/web/src/components/ui/button.tsx \
  apps/web/src/components/ui/button.test.tsx \
  apps/web/src/components/activity/ActivityRoster.tsx \
  apps/web/src/components/activity/ActivityDock.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/activity/ActivityDock.test.tsx \
  apps/web/src/components/ChatView.tsx \
  apps/web/src/components/CenterTerminalPanel.tsx \
  apps/web/src/components/CenterTerminalPanel.test.tsx \
  apps/web/src/components/ThreadTerminalPanel.tsx \
  apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx \
  apps/web/src/components/ChatView.hooks.test.tsx \
  apps/web/src/components/ChatView.test.tsx \
  apps/server/src/provider/codex/activity.rs \
  apps/server/src/provider/codex/runtime.rs \
  apps/server/tests/provider_codex.rs \
  docs/architecture/activity-observation.md \
  docs/providers/codex.md \
  docs/user/workspace-ui.md \
  docs/superpowers/specs/2026-08-06-center-focus-and-activity-reliability-design.md \
  docs/superpowers/plans/2026-08-06-center-focus-and-activity-reliability.md
git commit -m "fix: restore center focus and agent activity reliability"
```

If an implementation task legitimately changes a different file, add it only after reviewing and documenting why in the final report. After committing, run `git status --short` and require a clean result.
