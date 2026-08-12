# Claude Nested Cancellation and Single-Icon Activity UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a uniquely attributable nested Claude subagent cancellable when the nested `PostToolUse` launch result is missing, and simplify Activity presentation to one provider icon, readable dock metadata, canonical hierarchy, and explicit Stop/Stop subtree actions.

**Architecture:** `apps/server` extends the existing generation-owned `ClaudeTaskControlCorrelator` with a bounded authenticated parent-local launch interval. The existing exact `PostToolUse` path remains authoritative; fallback correlation is admitted only for one active exact parent, one open nested Agent/Task invocation, one accepted task, and one verified unmatched child. `apps/web` remains a pure projection of canonical Activity data: the dock renders one scope-provider glyph, while the roster derives a bounded display forest from `parentActorId` and keeps server controls authoritative. No contract, RPC, persistence, client-runtime, or provider-native public shape changes.

**Tech Stack:** Rust, Tokio, Serde/JSON, authenticated Claude hooks, Axum/WebSocket RPC, TypeScript, React, Tailwind utilities, Base UI components, Vite+/Vitest, Cargo test, Clippy, Tauri 2, macOS Computer Use.

## Global Constraints

- Implement from the approved design at `docs/superpowers/specs/2026-08-12-claude-nested-cancellation-and-activity-ui-design.md` on merged base `c3f16d62305fe9f6f900bfc9157487a13243801c` or its descendants.
- Preserve the current Activity protocol version, schemas, RPC inputs/results, SQLite data, and client-runtime authority. No public or persisted provider-native identity may be added.
- The normal exact Claude path stays authoritative. The fallback is nested-only, parent-local, same-session, same-generation, authenticated, cardinality-one, bounded, and fail-closed.
- Correlation may use only `session_id`, generation, `tool_use_id`, exact Agent/Task class, parent tool identity, authenticated source `agent_id`, exact `task_id`, child `agent_id`, and exact `parent_agent_id`. Never use name, role, description, prompt, output, timestamp, event adjacency, or row order.
- A fallback association may install only when the source parent is verified, active, and owns an exact current `ClaudeTask` target. Ambiguity, conflict, stale generation, saturation, tombstone membership, invalid identity, terminal task state, or missing parent target emits no Install.
- A later matching `PostToolUse` may promote the same fallback mapping to the exact path. A contradictory explicit result retires the fallback target and tombstones its identity chain; it never remaps silently.
- Open nested launch state closes on matching `PostToolUse`, `PostToolUseFailure`, authoritative terminal task lifecycle, parent retirement/cancellation, capability disablement, runtime replacement, or shutdown.
- All live maps and reconciliation scans remain bounded by `ACTIVITY_PAGE_MAX_LENGTH` (200), with early quiescence and no per-candidate task, timer, polling loop, transcript read, or filesystem I/O.
- Every effect-producing accepted fact must carry a stable, bounded, domain-separated, opaque native event key. `PreToolUse` and `PostToolUseFailure` must never produce an install/retire that the production event pump drops.
- Provider-native task/agent/tool IDs remain redacted from Debug, diagnostics, Activity errors, contracts, logs, screenshots, and web state. Root `interrupt` is never a targeted fallback.
- The Activity dock renders one provider glyph total. Multiplicity is represented only by active/done counts; negative icon spacing and actor-count glyph stacks are removed.
- Each subagent row renders one provider glyph and no generic actor glyph. Background work renders one appropriate work-item glyph.
- Hierarchy is a bounded presentation projection only. Missing, paginated-out, self, cyclic, cross-kind, or otherwise invalid parents remain at root indentation in stable fallback order.
- Cancellation copy and state remain server-authoritative: `Stop subtree` for available actors with active descendants, `Stop` for available leaves, disabled `Stopping` for requested actors, and no action for unsupported or terminal actors.
- Stop remains a visible, normal-size sibling of row navigation, stops propagation, is keyboard reachable, retains exact subtree impact in its accessible label, and preserves focus.
- Reuse the same `ActivityPanel`/`ActivityRoster` composition in the inline right panel and `RightPanelSheet`; do not add a second responsive source of truth.
- Preserve unrelated worktree changes. Never edit or stage `.repos/` or `.codegraph/`.
- Run Claude tests with `BIBCODE_CLAUDE_KEYCHAIN_ACCESS` unset.
- Use `apply_patch` for source and documentation edits. Commit only after the task-specific focused tests are green.

---

## File Responsibility Map

### Claude correlation and production proof

- `apps/server/src/provider/claude/runtime.rs` — authenticated open-launch facts, fallback reconciliation, explicit-evidence promotion/conflict retirement, lifecycle cleanup, opaque event-key totality, bounds, and unit tests.
- `apps/server/tests/fixtures/claude-provider/targeted-rpc.sh` — successful real provider fixture whose nested child deliberately has no nested `PostToolUse` result.
- `apps/server/tests/fixtures/claude-provider/targeted-rpc-ambiguous.sh` — bounded ambiguous nested fixture with no exact mapping and no provider control write.
- `apps/server/tests/production_provider_runtime.rs` — public WebSocket cancellation proof for exact fallback, sibling/root isolation, and ambiguous zero-I/O behavior.

### Activity web presentation

- `apps/web/src/components/activity/ActivityDock.tsx` — single provider glyph and split primary/secondary section layout.
- `apps/web/src/components/activity/ActivityDock.test.tsx` — single-glyph/count/metadata/responsive/accessibility coverage.
- `apps/web/src/components/activity/ActivityRoster.tsx` — bounded display forest, one-icon rows, indentation/connectors, and text cancellation actions.
- `apps/web/src/components/activity/ActivityRoster.test.tsx` — hierarchy, icon, action-copy, control-state, focus, and fallback-order coverage.
- `apps/web/src/components/ActivitySurfaces.test.tsx` — real inline `ActivityPanel` and `RightPanelSheet` keyboard/responsive/read-only proof.
- `apps/web/src/components/activity/ActivityPanel.test.tsx` — retain partial/retry and server-authoritative operation presentation coverage.

### Living documentation

- `docs/architecture/activity-observation.md` — bounded Claude parent-local fallback and display-projection invariants.
- `docs/architecture/providers.md` — Claude exact-or-unambiguous targeted capability wording.
- `docs/providers/claude.md` — supported hook sequence, ambiguity, cleanup, and no-root-fallback behavior.
- `docs/user/workspace-ui.md` — one-icon dock/roster, hierarchy, visible Stop copy, and responsive behavior.

---

### Task 1: Add the Bounded Claude Parent-Local Fallback

**Files:**
- Modify: `apps/server/src/provider/claude/runtime.rs`

**Interfaces:**
- Extends private `ClaudeTaskCorrelation` only.
- Adds private observation methods for authenticated `PreToolUse` and `PostToolUseFailure`.
- Continues to emit only existing private `ClaudeTaskControlEffect` and `ProviderActivityControlUpdate` values.
- Does not modify `ProviderActivityNativeTarget`, contracts, RPC DTOs, or persistence.

- [ ] **Step 1: Add RED helper facts for a nested launch without `PostToolUse`**

In `targeted_task_correlation_tests`, add a helper that first proves an exact active parent and then returns these four nested child facts:

```rust
fn nested_fallback_facts(
    session_id: &str,
    parent_tool_use_id: &str,
    parent_agent_id: &str,
    child_tool_use_id: &str,
    child_agent_id: &str,
    child_task_id: &str,
) -> [Value; 4] {
    [
        json!({
            "type":"stream_event", "session_id":session_id,
            "parent_tool_use_id":parent_tool_use_id,
            "event":{"type":"content_block_start","index":0,
                "content_block":{"type":"tool_use","id":child_tool_use_id,"name":"Agent","input":{}}}
        }),
        json!({
            "hook_event_name":"PreToolUse", "session_id":session_id,
            "agent_id":parent_agent_id, "tool_use_id":child_tool_use_id,
            "tool_name":"Agent"
        }),
        json!({
            "type":"system", "subtype":"task_started", "session_id":session_id,
            "task_id":child_task_id, "tool_use_id":child_tool_use_id,
            "task_type":"local_agent"
        }),
        json!({
            "hook_event_name":"SubagentStart", "session_id":session_id,
            "agent_id":child_agent_id, "parent_agent_id":parent_agent_id
        }),
    ]
}
```

Keep the existing `handle_fact(&mut runtime, fact, authenticated_hook, emitted_at_ms)` helper so `PreToolUse` and `SubagentStart` cross the same authenticated runtime boundary as production.

- [ ] **Step 2: Add RED convergence and exact-target tests**

Add tests proving:

1. after the exact parent chain is installed, all 24 permutations of the four child facts install exactly `("claude:agent:agent-child", "task-child")` once;
2. `task_type` absent, `local_agent`, and `remote_agent` all remain accepted on this nested fallback path;
3. the install-producing output always has a present `native_event_id`, bounded to 256 characters, prefixed `claude:control:`, and containing no raw tool/task/agent ID; and
4. duplicate accepted facts are idempotent.

Use this focused RED command:

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --lib targeted_task_correlation -- --nocapture
```

Expected RED: no target is installed because `observe_authenticated_control_hook` ignores `PreToolUse` and `reconcile` still requires `launched_agent_id` from `PostToolUse`.

- [ ] **Step 3: Add RED ambiguity, conflict, lifecycle, and bound tests**

Add behavioral coverage for each failure seam before production code:

- one active parent with two open nested tool/task candidates and one unmatched child stays unsupported;
- one active parent with one open candidate and two verified unmatched children stays unsupported;
- a child with a different `parent_agent_id`, missing parent target, invalid/control-character parent identity, duplicate task assignment, or tombstone membership stays unsupported;
- an exact later `PostToolUse` resolves an ambiguous candidate through the existing authoritative path;
- a matching later `PostToolUse` keeps an installed fallback stable and does not emit a second Install;
- a contradictory later `PostToolUse` emits Retire for the fallback child, removes its target, tombstones the chain, and never remaps it;
- matching `PostToolUseFailure`, parent terminal notification, child task terminal notification, runtime disable/re-enable, and generation replacement prevent a pending or installed fallback from reopening;
- 200 pending correlations stay bounded and the 201st remains unsupported under churn;
- Debug output and opaque event keys contain none of the raw identities.

For cardinality tests, assert both the emitted control effects and the private correlator maps. The positive assertion is exactly one Install; every negative case must assert no Install, no current actor target, and `state_is_bounded()`.

- [ ] **Step 4: Extend private correlation state without widening the boundary**

Add only private fields to `ClaudeTaskCorrelation`:

```rust
#[derive(Debug, Default)]
struct ClaudeTaskCorrelation {
    invocation_is_agent: Option<bool>,
    invocation_source: Option<ClaudeInvocationSource>,
    pre_tool_source: Option<ClaudeHookSource>,
    hook_source: Option<ClaudeHookSource>,
    launched_agent_id: Option<String>,
    fallback_agent_id: Option<String>,
    task_id: Option<String>,
    conflicted: bool,
}
```

`launched_agent_id` remains explicit `PostToolUse` evidence. `fallback_agent_id` is the provisional parent-local join and must never overwrite explicit evidence. Add a private effective-agent helper used by retirement, duplicate-assignment checks, and Debug-count logic:

```rust
impl ClaudeTaskCorrelation {
    fn effective_agent_id(&self) -> Option<&str> {
        self.launched_agent_id
            .as_deref()
            .or(self.fallback_agent_id.as_deref())
    }
}
```

Do not make either field public or serializable.

- [ ] **Step 5: Observe authenticated launch-open and launch-failure facts**

Add private correlator methods with the same session/generation/identity validation used by the exact path:

```rust
fn observe_pre_tool_use(
    &mut self,
    session_id: &str,
    generation: u64,
    tool_use_id: &str,
    tool_name: &str,
    source_agent_id: Option<&str>,
) -> Vec<ClaudeTaskControlEffect>;

fn observe_post_tool_failure(
    &mut self,
    session_id: &str,
    generation: u64,
    tool_use_id: &str,
    tool_name: &str,
    source_agent_id: Option<&str>,
) -> Vec<ClaudeTaskControlEffect>;
```

Rules:

- only exact `Agent`/legacy `Task` class is eligible;
- fallback requires a present `source_agent_id`, because it is nested-only;
- repeated identical facts are idempotent;
- conflicting tool class or source poisons the tool chain;
- `PostToolUseFailure` closes/tombstones the matching open chain and retires an installed fallback if present;
- source-parent retirement removes/tombstones open child correlations that name the parent's tool or agent as their source, while preserving unrelated parents.

Wire `PreToolUse` and `PostToolUseFailure` in `observe_authenticated_control_hook`. Do not accept unauthenticated hook-shaped stdout records.

- [ ] **Step 6: Implement bounded cardinality-one fallback reconciliation**

Keep the existing bounded fixpoint. Before or within each pass, derive candidates from cloned IDs only—never clone unbounded payloads:

```rust
fn reconcile_parent_local_fallbacks(&mut self) -> Vec<ClaudeTaskControlEffect> {
    // 1. collect at most 200 open nested Agent/Task tool IDs grouped by exact parent agent;
    // 2. collect at most 200 verified, unmatched child agent IDs grouped by exact parent agent;
    // 3. for a parent with exactly one candidate on each side, set fallback_agent_id;
    // 4. call the existing assignment/terminal reconciliation path;
    // 5. emit nothing for cardinality 0 or >1.
}
```

A tool candidate is eligible only when:

```rust
record.invocation_is_agent == Some(true)
    && matches!(record.invocation_source, Some(ClaudeInvocationSource::ParentTool(_)))
    && matches!(record.pre_tool_source, Some(ClaudeHookSource::Agent(_)))
    && record.launched_agent_id.is_none()
    && record.fallback_agent_id.is_none()
    && record.task_id.is_some()
    && !record.conflicted
```

The invocation parent tool must resolve to the same verified active parent named by `pre_tool_source`, and that parent must be present in `actor_target_by_agent`. The unmatched child must have `ClaudeVerifiedLineage::Parent` with that same parent, no current target, no explicit/fallback assignment in any correlation, no terminal/tombstone conflict, and no task assignment.

Use stable `BTreeMap`/`BTreeSet` iteration, preserve the 200-entry limits, and keep early quiescence. Do not associate from iteration order: cardinality must be checked before choosing an ID.

- [ ] **Step 7: Promote matching exact evidence and retire contradictions**

Update `observe_async_launch` so:

- exact `PostToolUse` with the same child as `fallback_agent_id` records `launched_agent_id`, clears `fallback_agent_id`, and proceeds through exact source/lineage validation without a duplicate target;
- a different exact child poisons the fallback chain and emits Retire for the currently installed fallback target;
- exact source disagreement also poisons rather than remaps;
- all retirement helpers use `effective_agent_id()` and cascade only the open dependent correlations owned by the retiring parent.

Preserve terminal-before-join authority: a task already in `pending_terminal_by_task` may later identify its actor only to emit the authoritative terminal lifecycle, never an Install.

- [ ] **Step 8: Make control-event key derivation total for the new effects**

Extend `claude_control_fact_native_event_id` with canonical branches for `PreToolUse` and `PostToolUseFailure`:

```rust
"PreToolUse" | "PostToolUseFailure" => {
    let tool_use_id = value.get("tool_use_id")?.as_str()?;
    let tool_name = value.get("tool_name")?.as_str()?;
    fields.extend([
        if event == "PreToolUse" {
            "hook/pre-tool-use"
        } else {
            "hook/post-tool-use-failure"
        },
        session_id,
        "source",
    ]);
    push_optional_control_identity(&mut fields, value.get("agent_id").and_then(Value::as_str))?;
    fields.extend([tool_use_id, classify_agent_tool(tool_name)]);
}
```

Validate bounded identities/tool labels. Do not hash arbitrary error text, prompt text, tool response payload, or filesystem paths. Extend the existing native-key totality test to prove every new Install/Retire has a key and literal identities cannot alias absence.

- [ ] **Step 9: Run the complete focused Claude unit slice**

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --lib targeted_task_correlation -- --nocapture

env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --lib claude_ -- --nocapture

cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
git diff --check
```

Expected: all new fallback, exact-path regression, bounds, lifecycle, key, and redaction tests pass; no public surface changes.

- [ ] **Step 10: Commit the server correlation slice**

```bash
git add apps/server/src/provider/claude/runtime.rs
git commit -m "fix(claude): correlate unambiguous nested tasks"
```

---

### Task 2: Prove Exact Claude Subtree Dispatch Through Public RPC

**Files:**
- Modify: `apps/server/tests/fixtures/claude-provider/targeted-rpc.sh`
- Create: `apps/server/tests/fixtures/claude-provider/targeted-rpc-ambiguous.sh`
- Modify: `apps/server/tests/production_provider_runtime.rs`

**Interfaces:**
- Exercises production executable launch, authenticated hook sink, Activity projection/control overlay, public WebSocket RPC, cancellation service, supervisor bridge, and real Claude `stop_task` wire capture.
- Adds no production test bypass and no public constructor.

- [ ] **Step 1: Turn the successful production fixture RED by omitting nested `PostToolUse`**

Keep root A and sibling B on the exact path. For nested child, retain the stream invocation and `task_started` in `targeted-rpc.sh`, but send authenticated hooks from the test in this order-flexible set:

```rust
json!({
    "hook_event_name":"PreToolUse", "session_id":session_id,
    "agent_id":"agent-a", "tool_name":"Agent", "tool_use_id":"tool-agent-child"
})
json!({
    "hook_event_name":"SubagentStart", "session_id":session_id,
    "agent_id":"agent-child", "parent_agent_id":"agent-a", "agent_type":"same-role"
})
```

Delete the nested `PostToolUse` hook carrying `tool_response.agentId = agent-child`. Keep the exact parent, sibling, and unmapped actor hooks unchanged.

Run:

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test production_provider_runtime \
  targeted_activity_rpc_writes_only_the_selected_claude_stop_task_subtree -- --nocapture
```

Expected RED before Task 1 GREEN: child control remains `unsupported`, parent descendant count/capture is incomplete, and exact `task-child` is absent from `stop_task` writes.

- [ ] **Step 2: Strengthen the successful public-RPC assertions**

Keep the real launch-ready barrier and authenticated hook token. Assert, through `activity.getSnapshot` and public `activity.cancelSubtree`, that:

- parent A and child are `available`, with parent A `activeDescendantCount == 1`;
- sibling B is `available` and unmapped actor is `unsupported`;
- cancelling unmapped actor fails with byte-for-byte unchanged complete-line capture;
- cancelling parent A writes exactly ordered `stop_task` targets `["task-a", "task-child"]`;
- no `task-b`, root `interrupt`, or unbounded native payload is written;
- A and child become terminal from provider notification, while B, unmapped actor, and a unique root follow-up remain live/observable.

Do not poll private registry state; use only the production server and public WebSocket methods already used by this test.

- [ ] **Step 3: Add an ambiguous real-provider fixture and RED zero-I/O proof**

Create `targeted-rpc-ambiguous.sh` using the same bounded launch/settings/token/session/ready mechanics. It must emit:

- one exact active parent;
- two nested Agent stream invocations owned by that parent;
- two accepted `task_started` IDs;
- two authenticated `PreToolUse` facts from that parent; and
- two authenticated `SubagentStart` children naming that parent;
- no nested `PostToolUse` result.

Add `targeted_activity_rpc_keeps_ambiguous_claude_children_unsupported_without_provider_io`. Through `activity.getSnapshot`, assert both children are observable/running with `unsupported` controls. Attempt public cancellation for each child using the unsupported revision, assert typed failure, then compare parsed complete NDJSON before/after: zero `stop_task`, zero root interrupt, and no other new targeted request.

- [ ] **Step 4: Run provider-isolation and regression suites**

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test production_provider_runtime targeted_activity_rpc -- --nocapture

env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test provider_claude targeted_task -- --nocapture

env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test provider_codex targeted_cancel -- --nocapture

env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server activity::cancellation::tests -- --nocapture

cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
git diff --check
```

Repeat the two public Claude RPC tests at least three consecutive times after the focused run to catch hook-readiness or event-pump races.

- [ ] **Step 5: Commit the production proof**

```bash
git add \
  apps/server/tests/fixtures/claude-provider/targeted-rpc.sh \
  apps/server/tests/fixtures/claude-provider/targeted-rpc-ambiguous.sh \
  apps/server/tests/production_provider_runtime.rs
git commit -m "test(claude): prove nested subtree cancellation fallback"
```

---

### Task 3: Replace Dock Glyph Stacks With One Provider Icon

**Files:**
- Modify: `apps/web/src/components/activity/ActivityDock.tsx`
- Modify: `apps/web/src/components/activity/ActivityDock.test.tsx`

**Interfaces:**
- Keeps `ActivityDockProps`, visibility, counts, announcements, section navigation, and responsive sheet inset unchanged.
- Changes only DOM presentation/data attributes needed by tests.

- [ ] **Step 1: Rewrite the dock glyph tests RED-first**

Replace the actor-glyph-roster and overflow expectations with assertions that, for 0, 1, 3, truncated, and count-only actors:

```ts
expect(container.querySelectorAll("[data-activity-provider-glyph]")).toHaveLength(1);
expect(container.querySelectorAll("[data-activity-glyph]")).toHaveLength(0);
expect(container.textContent).not.toContain("+2");
expect(container.textContent).toContain("Active 1");
expect(container.textContent).toContain("Done 2");
```

Preserve accessible count assertions and unsupported-section visibility behavior. Run:

```bash
vp test run --passWithNoTests --project unit \
  apps/web/src/components/activity/ActivityDock.test.tsx
```

Expected RED: current `MAX_GLYPHS`, `glyphActors`, negative spacing, and overflow badge render multiple provider circles.

- [ ] **Step 2: Add RED tests for separate expanded layout regions**

For each visible section, assert:

- one `[data-activity-section-primary="subagents"]` region contains section name and active/done counts;
- one `[data-activity-section-metadata="subagents"]` region contains elapsed text when active work exists;
- metadata is outside the primary region;
- compact mode keeps the primary counts but omits the metadata region;
- the dock still has one provider glyph while expanded;
- native buttons, Escape, Enter/Space, live region, reduced motion, and sheet inset remain unchanged.

- [ ] **Step 3: Implement one provider glyph in both collapsed and expanded toggle states**

Delete `MAX_GLYPHS`, `glyphActors`, `glyphOverflow`, `-space-x-1`, per-actor titles, and overflow rendering. Use the mapped provider icon exactly once in the dock toggle:

```tsx
<span
  aria-hidden="true"
  className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted"
  data-activity-provider-glyph={viewModel.provider}
>
  <ProviderIcon className="size-3" />
</span>
```

Render this same glyph whether expanded or collapsed. In expanded mode, retain the text `Activity` and chevron; do not add another provider glyph to the Subagents section row. Background Tasks may retain its one semantic `ListTodoIcon` because it is a section-kind glyph, not actor multiplicity.

- [ ] **Step 4: Split expanded section primary and metadata lines**

For the non-compact subagent row, use one flexible wrapper:

```tsx
<span className="min-w-0 flex-1">
  <span
    className="flex min-w-0 items-center gap-2"
    data-activity-section-primary="subagents"
  >
    <span className="min-w-0 flex-1 truncate">Subagents</span>
    <span className="shrink-0 whitespace-nowrap text-xs tabular-nums">Active {subagentActive}</span>
    <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
      Done {subagentDone}
    </span>
  </span>
  {activeSubagent === undefined ? null : (
    <span
      aria-hidden="true"
      className="mt-0.5 flex items-center text-xs text-muted-foreground tabular-nums"
      data-activity-section-metadata="subagents"
    >
      <Clock3Icon className="mr-1 size-3 shrink-0" />
      <span className="truncate">{activityElapsedLabel(activeSubagent.startedAt, elapsedNow)}</span>
    </span>
  )}
</span>
```

Apply the same structure to Background Tasks. Keep compact section rows count-only and omit elapsed metadata. Ensure the section status indicator does not overlap the provider glyph or primary counts.

- [ ] **Step 5: Run dock tests and web typecheck**

```bash
vp test run --passWithNoTests --project unit \
  apps/web/src/components/activity/ActivityDock.test.tsx

vp run --filter @bibcode/web typecheck
vp check
git diff --check
```

Expected: all dock behavior passes, exactly one provider glyph is present, and no glyph-overflow/negative-spacing source remains:

```bash
rg -n "MAX_GLYPHS|glyphActors|glyphOverflow|-space-x" \
  apps/web/src/components/activity/ActivityDock.tsx
```

Expected: no matches.

- [ ] **Step 6: Commit the dock slice**

```bash
git add \
  apps/web/src/components/activity/ActivityDock.tsx \
  apps/web/src/components/activity/ActivityDock.test.tsx
git commit -m "fix(activity): simplify dock provider presentation"
```

---

### Task 4: Add Canonical Roster Hierarchy and Explicit Text Actions

**Files:**
- Modify: `apps/web/src/components/activity/ActivityRoster.tsx`
- Modify: `apps/web/src/components/activity/ActivityRoster.test.tsx`
- Modify: `apps/web/src/components/ActivitySurfaces.test.tsx`
- Verify: `apps/web/src/components/activity/ActivityPanel.test.tsx`

**Interfaces:**
- Keeps `ActivityRosterProps`, selection callbacks, canonical IDs, control revisions, partial retry, and `ActivityPanel` routing unchanged.
- Adds a private/export-for-test presentation record shape only; no contract or client state changes.

- [ ] **Step 1: Add RED one-icon and text-action tests**

In `ActivityRoster.test.tsx`, update the controllable actor fixtures to assert:

```ts
expect(row.querySelectorAll("[data-activity-provider-glyph]")).toHaveLength(1);
expect(row.querySelector("[data-activity-record-glyph='actor']")).toBeNull();
expect(parentStop?.textContent).toBe("Stop subtree");
expect(leafStop?.textContent).toBe("Stop");
expect(requestedStop?.textContent).toBe("Stopping");
expect(requestedStop?.disabled).toBe(true);
```

Keep exact accessible labels:

- parent: `Stop Alpha and 1 child agent`;
- leaf: `Stop Beta`;
- requested parent: the same bounded impact label while disabled.

Assert unsupported/terminal actors have no action and background work has one work-item glyph, no provider/actor overlap.

Run:

```bash
vp test run --passWithNoTests --project unit \
  apps/web/src/components/activity/ActivityRoster.test.tsx
```

Expected RED: current rows render provider + generic actor circles and an icon-only square Stop button.

- [ ] **Step 2: Add RED hierarchy projection tests**

Export a testable presentation helper from `ActivityRoster.tsx`:

```ts
export interface ActivityRosterPresentationRecord {
  readonly record: ActivityRecordSummary;
  readonly depth: number;
  readonly connectedToVisibleParent: boolean;
}

export function projectActivityRosterHierarchy(
  records: ReadonlyArray<ActivityRecordSummary>,
  section: ActivitySection,
): ReadonlyArray<ActivityRosterPresentationRecord>;
```

Add tests with deliberately scrambled pages/base order proving:

- parent, child, grandchild, then sibling preorder;
- stable sibling order follows the already reconciled bounded order;
- child rows expose depth 1/2 and connector state;
- missing or paginated parent is depth 0;
- self-parent and every member of a cycle are depth 0 in stable fallback order;
- a cross-kind parent cannot create hierarchy;
- an eight-level chain keeps preorder but caps rendered depth at a named constant such as `MAX_ROSTER_INDENT_DEPTH = 4`;
- Background Tasks remain depth 0 and retain their existing stable ordering.

Project Active and Done buckets independently so the existing truthful headings remain intact. A parent in the other lifecycle bucket is treated as absent for this presentation bucket rather than moving a record across status headings.

- [ ] **Step 3: Implement a bounded stable forest projection**

Use the already bounded reconciled input. Build `byId`, stable index, and child lists once. Reject invalid edges before DFS. One suitable shape is:

```ts
const MAX_ROSTER_INDENT_DEPTH = 4;

function invalidParentIds(records: ReadonlyArray<ActivityRecordSummary>): ReadonlySet<string> {
  // Follow only present actor->actor parent edges.
  // Mark self/cycle members invalid; stop after records.length hops.
}

export function projectActivityRosterHierarchy(
  records: ReadonlyArray<ActivityRecordSummary>,
  section: ActivitySection,
): ReadonlyArray<ActivityRosterPresentationRecord> {
  if (section !== "subagents") {
    return records.map((record) => ({ record, depth: 0, connectedToVisibleParent: false }));
  }
  // Roots preserve input order. Each root is followed by its child subtrees.
  // Any unvisited/invalid record is appended once at root depth in input order.
}
```

Complexity must remain bounded by 200 records and avoid recursive overflow. Prefer an explicit stack carrying `{ id, depth }`, push children in reverse stable order, and keep a `visited` set. Cap visual depth, not traversal/order depth.

- [ ] **Step 4: Render one icon, hierarchy connector, and stable three-column row**

Change `recordGroups`/row mapping to carry `ActivityRosterPresentationRecord`. Pass `depth` and `connectedToVisibleParent` to `ActivityRecordRow`.

The row wrapper should remain bounded and expose deterministic test attributes:

```tsx
<div
  className="relative flex min-w-0 w-full items-start gap-2"
  data-activity-hierarchy-depth={depth}
  data-activity-row-layout={record.id}
  style={{ paddingInlineStart: `${Math.min(depth, MAX_ROSTER_INDENT_DEPTH) * 12}px` }}
>
  {connectedToVisibleParent ? (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-1 top-0 w-px bg-border"
      data-activity-hierarchy-connector={record.id}
      style={{ insetInlineStart: `${Math.max(0, depth - 1) * 12 + 6}px` }}
    />
  ) : null}
  {/* navigation button with one icon + flexible content */}
  {/* sibling text action */}
</div>
```

Keep inline numeric styles derived only from the named depth cap. Use logical `paddingInlineStart`/`insetInlineStart` so RTL does not hard-code left positioning.

Inside navigation:

- actors render only the mapped provider circle with `data-activity-provider-glyph`;
- work items render only the `ListTodoIcon` circle with `data-activity-record-glyph="workItem"`;
- the flexible content keeps name/status, optional summary, relationship/role, and elapsed/completed duration;
- a child metadata label includes `Child agent` without replacing the provider role;
- icon and action are `shrink-0`; name/summary are `min-w-0` and may truncate/wrap.

- [ ] **Step 5: Replace the square glyph with server-authoritative text copy**

Derive visible and accessible text separately:

```ts
const activeDescendants = control?.activeDescendantCount ?? 0;
const stopImpactLabel =
  control === null || record._tag !== "actor"
    ? null
    : activeDescendants === 0
      ? `Stop ${record.name}`
      : `Stop ${record.name} and ${activeDescendants} child ${activeDescendants === 1 ? "agent" : "agents"}`;

const actionText =
  control?.state === "requested"
    ? "Stopping"
    : activeDescendants > 0
      ? "Stop subtree"
      : "Stop";
```

Render a sibling `Button size="sm" variant="outline"` with a normal minimum height/width, `aria-label={stopImpactLabel}`, disabled only for `requested`, and the existing exact `controlRevision` callback. Retain both `onPointerDown` and `onClick` propagation stops. Do not nest it in the row navigation button. Keep `Stopping` in the status line as well as on the disabled action.

- [ ] **Step 6: Strengthen inline/sheet focus and responsive RED/GREEN coverage**

In `ActivitySurfaces.test.tsx`, make the actor fixture a parent plus child and render the actual `ActivityPanel` in:

1. the inline right-panel wrapper; and
2. `RightPanelSheet` at a narrow width.

For Enter and Space:

- Tab from parent navigation to `Stop subtree`;
- activate exactly once;
- assert `onCancelActor(parentId, revision)` once;
- assert `onNavigate` remains untouched;
- assert focus remains on the text action;
- assert the action is a sibling, never nested;
- assert parent precedes indented child and both have one provider icon;
- assert terminal scope renders both rows read-only with no Stop/Stopping action.

Retain the existing control-only delta precedence tests: snapshot `requested` must override stale roster-page `available` and show disabled `Stopping` immediately.

- [ ] **Step 7: Run the focused Activity UI matrix**

```bash
vp test run --passWithNoTests --project unit \
  apps/web/src/components/activity/ActivityRoster.test.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/ActivitySurfaces.test.tsx

vp run --filter @bibcode/web typecheck
vp check
git diff --check
```

Also audit the source:

```bash
rg -n "-space-x|size=\"icon-xs\"|data-activity-record-glyph=\{record\._tag\}" \
  apps/web/src/components/activity/ActivityRoster.tsx
```

Expected: no overlapping actor/provider icon implementation and no icon-only cancellation action.

- [ ] **Step 8: Commit the roster/UI slice**

```bash
git add \
  apps/web/src/components/activity/ActivityRoster.tsx \
  apps/web/src/components/activity/ActivityRoster.test.tsx \
  apps/web/src/components/ActivitySurfaces.test.tsx
git commit -m "fix(activity): clarify subagent hierarchy and actions"
```

---

### Task 5: Align Living Documentation With Implemented Behavior

**Files:**
- Modify: `docs/architecture/activity-observation.md`
- Modify: `docs/architecture/providers.md`
- Modify: `docs/providers/claude.md`
- Modify: `docs/user/workspace-ui.md`

- [ ] **Step 1: Update the Activity architecture invariant**

In `docs/architecture/activity-observation.md`, preserve the complete exact path and add the nested-only fallback:

- authenticated `PreToolUse` opens a parent-owned interval;
- stream parent tool, accepted task, and verified child lineage must all agree;
- exactly one candidate on both sides is required;
- exact `PostToolUse` remains authoritative and can promote/contradict fallback;
- ambiguity is unsupported and zero-I/O;
- pending state is generation-owned, bounded at 200, no timers/polling/transcript reads;
- accepted effect facts always have opaque event keys;
- lifecycle/replacement/disablement closes pending state.

Do not imply that all nested Claude versions supply `PostToolUse` or that semantic inference is permitted.

- [ ] **Step 2: Update provider and user-facing documentation**

In `docs/architecture/providers.md` and `docs/providers/claude.md`, describe targeted support as exact explicit correlation or the bounded authenticated cardinality-one nested fallback. State that ambiguous nested actors remain observable but unsupported and root interrupt is never used.

In `docs/user/workspace-ui.md`, document:

- one provider icon in the dock and one per subagent row;
- active/done counts as the only multiplicity signal;
- primary counts and secondary elapsed metadata;
- canonical hierarchy indentation/connector with fail-safe root fallback;
- `Stop subtree`, `Stop`, disabled `Stopping`, and no action for unsupported/terminal actors;
- identical behavior in inline right panel and responsive sheet.

- [ ] **Step 3: Check living-doc links and formatting**

```bash
vp check
git diff --check
rg -n "parent-local|PreToolUse|Stop subtree|one provider icon" \
  docs/architecture/activity-observation.md \
  docs/architecture/providers.md \
  docs/providers/claude.md \
  docs/user/workspace-ui.md
```

- [ ] **Step 4: Commit the living docs**

```bash
git add \
  docs/architecture/activity-observation.md \
  docs/architecture/providers.md \
  docs/providers/claude.md \
  docs/user/workspace-ui.md
git commit -m "docs(activity): explain nested Claude control and hierarchy"
```

---

### Task 6: Run Full Verification and Inspect the Exact Packaged App

**Files:**
- Verify all changed files.
- Create ignored visual evidence under `.superpowers/visual/2026-08-12-claude-activity-ui/` only if needed; do not stage it.

- [ ] **Step 1: Run the focused final matrix from the repository root**

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --lib targeted_task_correlation -- --nocapture

env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test production_provider_runtime targeted_activity_rpc -- --nocapture

env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test provider_claude targeted_task -- --nocapture

env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test provider_codex targeted_cancel -- --nocapture

vp test run --passWithNoTests --project unit \
  apps/web/src/components/activity/ActivityDock.test.tsx \
  apps/web/src/components/activity/ActivityRoster.test.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/ActivitySurfaces.test.tsx
```

- [ ] **Step 2: Run package and workspace quality gates**

Run without overlapping broad commands:

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS cargo test -p bibcode-server -j 2 -- --test-threads=1
vp run --filter @bibcode/web test
vp run --filter @bibcode/web typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
vp check
vp run typecheck
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS vp run test
git diff --check
git status --short
```

If a broad run fails, reproduce the exact failing test alone before changing source. Do not “fix” unrelated process-fixture timing without a deterministic product failure.

- [ ] **Step 3: Perform privacy, boundary, and source audits**

```bash
git diff -- packages/contracts packages/client-runtime apps/server/src/activity apps/server/src/activity/repository.rs
rg -n "task-child|agent-child|tool-agent-child" apps/web packages/contracts packages/client-runtime
rg -n "MAX_GLYPHS|glyphActors|glyphOverflow|-space-x" \
  apps/web/src/components/activity/ActivityDock.tsx \
  apps/web/src/components/activity/ActivityRoster.tsx
git status --short
```

Expected:

- no contract/client-runtime/persistence diff;
- no provider-native child ID in web or contracts;
- no glyph stack/negative spacing source;
- no generated `.codegraph`, `.repos`, dependency, or debug-output drift.

- [ ] **Step 4: Build the exact release desktop bundle**

```bash
vp run build:desktop
test -d "$PWD/target/release/bundle/macos/BiBCode.app"
find "$PWD/target/release/bundle/macos/BiBCode.app/Contents/MacOS" \
  -maxdepth 1 -type f -perm -111 -print
```

Record the exact executable path printed by `find`. Do not substitute `/Applications/BiBCode.app`, a mounted DMG, a debug bundle, another worktree, or an already running process.

- [ ] **Step 5: Prove there is exactly one correct BiBCode instance**

Before launch, inspect—not broadly kill—matching processes:

```bash
exact_bundle="$PWD/target/release/bundle/macos/BiBCode.app"
exact_binary=$(find "$exact_bundle/Contents/MacOS" -maxdepth 1 -type f -perm -111 -print -quit)
test -n "$exact_binary"
pgrep -af "$exact_binary" || true
```

If an exact old worktree-bundle process exists, terminate only its validated PID and wait for it to exit. Re-run the process inventory. Then launch precisely:

```bash
open -n "$exact_bundle"
```

Wait for startup and verify one matching process:

```bash
pgrep -af "$exact_binary"
test "$(pgrep -f "$exact_binary" | wc -l | tr -d ' ')" = "1"
```

Also inspect the command path:

```bash
exact_pid=$(pgrep -f "$exact_binary")
ps -p "$exact_pid" -o command=
```

If zero or more than one exact process is present, stop visual verification and correct the launch state before clicking anything.

- [ ] **Step 6: Use Codex Computer Use for Codex visual/behavioral proof**

Invoke the `computer-use:computer-use` skill and use Codex Computer Use only—never Orca or the Orca CLI. Fetch a fresh app accessibility state before every interaction sequence and never reuse stale element identifiers.

In the exact packaged app:

1. select the configured Codex provider;
2. start a prompt that creates parent Alpha, nested Alpha-child, and sibling Beta and keeps them active long enough to inspect;
3. open the collapsed Activity dock and capture an original-resolution screenshot;
4. expand Subagents/right panel and capture an original-resolution screenshot showing one provider glyph per row, hierarchy, counts, elapsed metadata, and `Stop subtree`/`Stop`;
5. keyboard-focus `Stop subtree`, activate it, and verify focus does not navigate to detail;
6. capture after-state showing Alpha and Alpha-child stopping/terminal while Beta/root remain live;
7. confirm no overlapping icons, text, counts, elapsed labels, connectors, or actions at normal and narrow/sheet widths.

Save screenshots under the ignored visual-evidence directory with names such as `codex-before.png`, `codex-roster.png`, `codex-after.png`, and `codex-sheet.png`.

- [ ] **Step 7: Use Codex Computer Use for Claude visual/behavioral proof**

Still in the one exact packaged process:

1. select the configured Claude provider;
2. create parent Alpha, nested Alpha-child, and sibling Beta;
3. verify the nested child has an available target/action even when live Claude omits nested `PostToolUse`;
4. capture collapsed dock and expanded roster screenshots;
5. activate Alpha's `Stop subtree` action;
6. verify Alpha and Alpha-child stop, Beta/root continue, and no child is stranded active without a Stop action;
7. capture the after-state and narrow/sheet state.

Save `claude-before.png`, `claude-roster.png`, `claude-after.png`, and `claude-sheet.png`. If the live provider produces ambiguity instead of the approved cardinality-one sequence, record the child as unsupported and verify zero provider action rather than forcing cancellation.

- [ ] **Step 8: Review every screenshot at original resolution**

Use local image inspection at `detail: "original"` for each screenshot. Check pixel-level geometry:

- exactly one provider icon in the dock;
- exactly one icon per subagent row;
- provider glyph is not clipped or doubled;
- primary counts and secondary elapsed metadata occupy separate vertical regions;
- parent/child order, indentation, and connector are visible but subtle;
- bounded indentation leaves a usable flexible text column;
- `Stop subtree`, `Stop`, and disabled `Stopping` have normal hit areas and do not overlap status or duration;
- focus ring is complete and not clipped;
- right-panel and sheet edges do not clip content;
- no raw provider-native identity appears.

If any visual defect remains, add a DOM regression test first, fix it, rerun the focused web suite, rebuild the exact bundle, relaunch one verified process, and recapture the affected screenshots.

- [ ] **Step 9: Request code review and apply only verified findings**

Use `superpowers:requesting-code-review` against the complete branch diff. The review must explicitly inspect:

- fallback ambiguity/cardinality and exact-evidence contradiction;
- event-key totality for `PreToolUse`/`PostToolUseFailure`;
- parent retirement/generation/terminal cleanup;
- map bounds and redaction;
- public-RPC sibling/root isolation;
- hierarchy cycle/missing-parent fallback;
- one-icon DOM and text-action accessibility;
- exact bundle/process/screenshot evidence.

If feedback is actionable, use `superpowers:receiving-code-review`, reproduce it RED-first, implement the narrow correction, and rerun the relevant focused and broad gates.

- [ ] **Step 10: Commit final verification-only corrections if any**

If verification required source/test/doc corrections, commit them intentionally:

```bash
git add \
  apps/server/src/provider/claude/runtime.rs \
  apps/server/tests/fixtures/claude-provider/targeted-rpc.sh \
  apps/server/tests/fixtures/claude-provider/targeted-rpc-ambiguous.sh \
  apps/server/tests/production_provider_runtime.rs \
  apps/web/src/components/activity/ActivityDock.tsx \
  apps/web/src/components/activity/ActivityDock.test.tsx \
  apps/web/src/components/activity/ActivityRoster.tsx \
  apps/web/src/components/activity/ActivityRoster.test.tsx \
  apps/web/src/components/ActivitySurfaces.test.tsx \
  docs/architecture/activity-observation.md \
  docs/architecture/providers.md \
  docs/providers/claude.md \
  docs/user/workspace-ui.md
git diff --cached --check
git commit -m "fix(activity): address final nested cancellation review"
```

Do not stage screenshots, `.superpowers` evidence, `.codegraph`, `.repos`, or generated build artifacts.

- [ ] **Step 11: Produce the completion handoff**

Report:

- exact implementation commits and final HEAD;
- exact focused and broad commands with pass counts;
- exact release bundle and executable paths;
- process inventory proving one launched instance;
- clickable absolute screenshot paths for Codex and Claude before/after/sheet states;
- pixel-level visual findings;
- any live-provider limitation or ambiguity observed;
- final `git diff --check` and `git status --short` state;
- residual risk limited to provider-version/event-shape gating and live provider nondeterminism.

Do not claim completion without fresh command output and visual evidence from the exact final bundle.
