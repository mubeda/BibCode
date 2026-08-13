# Activity Control-Unavailable Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain why an observed active subagent has no Stop action while preserving exact fail-closed cancellation and proving both Codex and Claude behavior.

**Architecture:** Keep durable lifecycle and ephemeral control authority separate. `ActivityRoster` will continue to render the canonical lifecycle label and will add a read-only trailing `Stop unavailable` label only when the current structured-thread mutation surface exists but the joined server control is neither `available` nor `requested`. No contract, reducer, RPC, provider, or persistence behavior changes.

**Tech Stack:** React 19, TypeScript, Vite+, happy-dom real-DOM tests, Tailwind CSS, Tauri 2, Rust provider integration tests, Codex Computer Use.

## Global Constraints

- Keep `Running` as lifecycle truth; do not relabel the actor lifecycle.
- Render `Stop unavailable` as non-interactive text, never as a disabled or focusable button.
- Do not infer native targets, descendants, or cancellation eligibility locally.
- Preserve `Stop`, `Stop subtree`, disabled `Stopping`, terminal/read-only omission, focus restoration, and streamed-control precedence.
- Do not change contracts, client-runtime state, server RPC, persistence, or provider dispatch.
- Use only the exact rebuilt worktree bundle for packaged visual verification and keep one BiBCode instance.
- Do not claim a live Claude pass if authentication or provider readiness blocks it; record the blocker and use the existing authenticated production fixture.

---

### Task 1: Present unavailable targeted control

**Files:**
- Modify: `apps/web/src/components/activity/ActivityRoster.test.tsx`
- Modify: `apps/web/src/components/activity/ActivityRoster.tsx`
- Modify: `docs/user/workspace-ui.md`

**Interfaces:**
- Consumes: `ActivityActorControl`, `ActivitySnapshot.capabilities.targetedActorCancellation`, structured `thread` scope, active actor summaries, and the existing optional `onCancelActor(actorId, controlRevision)` mutation callback.
- Produces: `ActivityRecordRow` prop `controlUnavailable: boolean` and DOM marker `data-activity-control-unavailable={record.id}` containing the exact text `Stop unavailable`.

- [ ] **Step 1: Write the failing real-DOM test**

Add a test inside `ActivityRoster targeted cancellation controls` that mounts the existing `props()` fixture and asserts:

```tsx
const container = await mount(<ActivityRoster {...props()} />);
const unavailable = container.querySelector(
  '[data-activity-control-unavailable="unsupported"]',
);
expect(unavailable?.textContent).toBe("Stop unavailable");
expect(unavailable?.closest("button")).toBeNull();
expect(
  container.querySelector('button[data-activity-row="unsupported"]')?.textContent,
).toContain("Running");
expect(container.querySelector('[data-activity-control-unavailable="done"]')).toBeNull();
```

Extend the existing terminal/background mutation test to assert that neither surface contains `[data-activity-control-unavailable]`.

- [ ] **Step 2: Run the test and verify RED**

Run from `apps/web`:

```bash
vp test run --passWithNoTests src/components/activity/ActivityRoster.test.tsx
```

Expected: the new active unsupported actor assertion fails because no unavailable label exists; the existing Stop/Stopping assertions remain green.

- [ ] **Step 3: Implement the minimal presentation**

Add `controlUnavailable` to `ActivityRecordRowProps`. In `ActivityRoster`, derive the mutation surface once:

```ts
const targetedActorMutationAvailable =
  section === "subagents" &&
  snapshot.scope._tag === "thread" &&
  snapshot.capabilities.targetedActorCancellation &&
  onCancelActor !== undefined;
```

Pass `controlUnavailable` only for an active actor on that mutation surface whose `controlForRecord(record)` result is `null`. In `ActivityRecordRow`, after the existing Stop tooltip branch, render:

```tsx
<span
  className="mt-2 shrink-0 whitespace-nowrap text-xs text-muted-foreground"
  data-activity-control-unavailable={record.id}
>
  Stop unavailable
</span>
```

The span must be the sibling trailing column, not nested in the detail button.

- [ ] **Step 4: Document the user-visible invariant**

Update `docs/user/workspace-ui.md` immediately after the paragraph describing when Stop is visible: active actors without a current exact target retain their lifecycle label and show read-only `Stop unavailable`; this performs no RPC and is distinct from server-authoritative `Stopping`.

- [ ] **Step 5: Run focused GREEN verification**

Run:

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/activity/ActivityRoster.test.tsx \
  src/components/activity/ActivityPanel.test.tsx \
  src/components/activity/ActivitySurfaces.test.tsx
```

Expected: all selected tests pass with no React act warnings. Confirm the existing available/requested/terminal/background assertions still pass.

- [ ] **Step 6: Commit the behavior**

```bash
git add apps/web/src/components/activity/ActivityRoster.tsx \
  apps/web/src/components/activity/ActivityRoster.test.tsx \
  docs/user/workspace-ui.md
git commit -m "fix(activity): explain unavailable stop controls"
```

---

### Task 2: Automated cross-provider regression

**Files:**
- Verify only: `apps/server/tests/production_provider_runtime.rs`
- Verify only: `apps/server/tests/provider_claude.rs`
- Verify only: `apps/server/tests/provider_codex.rs`
- Verify only: `apps/web/src/components/activity/*`

**Interfaces:**
- Consumes: existing authenticated public-WebSocket provider fixtures and exact native request capture.
- Produces: fresh evidence that the presentation-only web change did not alter exact Codex `turn/interrupt`, Claude `stop_task`, subtree isolation, or unsupported zero-I/O behavior.

- [ ] **Step 1: Run the focused web package matrix**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/activity/ActivityDock.test.tsx \
  src/components/activity/ActivityRoster.test.tsx \
  src/components/activity/ActivityPanel.test.tsx \
  src/components/activity/ActivitySurfaces.test.tsx \
  src/components/right-panel/RightPanelTabs.test.tsx
```

Expected: zero failures.

- [ ] **Step 2: Run exact Claude and Codex server regressions**

From the repository root:

```bash
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test production_provider_runtime targeted_activity_rpc -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test provider_claude targeted_task -- --nocapture
env -u BIBCODE_CLAUDE_KEYCHAIN_ACCESS \
  cargo test -p bibcode-server --test provider_codex targeted_cancel -- --nocapture
```

Expected: the production RPC slice proves Claude selected subtree `stop_task`, Claude ambiguous/unmapped zero provider I/O, and Codex exact subtree isolation; the provider suites remain green.

- [ ] **Step 3: Run repository-required static gates**

```bash
vp run --filter @bibcode/web typecheck
vp check
vp run typecheck
git diff --check
```

Expected: every command exits zero; only existing non-failing Effect suggestions may appear.

---

### Task 3: Rebuild and visually verify Codex and Claude

**Files:**
- Create ignored evidence under `.superpowers/visual/2026-08-13-activity-control-unavailable/`
- Create ignored report `.superpowers/sdd/2026-08-13-activity-control-unavailable/verification-report.md`

**Interfaces:**
- Consumes: exact release bundle, one process, the shipped Activity panel, authenticated local Codex/Claude providers, and current server-authoritative controls.
- Produces: original-resolution screenshots, enlarged crops, process identity evidence, provider result evidence, and an honest blocker report if Claude cannot run live.

- [ ] **Step 1: Build and establish one exact instance**

Run `vp run build:desktop`. Using Codex Computer Use, normally quit the existing exact app, confirm its PID is absent, then launch only:

```text
target/release/bundle/macos/BiBCode.app
```

Use `pgrep -fal` to prove exactly one matching `Contents/MacOS/bibcode-desktop` process and record its full command.

- [ ] **Step 2: Capture the persisted unavailable state**

Open Activity. Capture a full frame and a lossless 2x/4x crop proving active persisted actors show `Running` and trailing `Stop unavailable`, with no button role, clipping, overlap, duplicate provider icon, or raw native ID.

- [ ] **Step 3: Verify fresh Codex controls and isolation**

In the exact app, start a uniquely named parent, nested child, and sibling through Codex. Keep the root turn live. Capture the fresh `Stop subtree`/`Stop` state at original resolution; inspect an enlarged crop. Activate the parent action by keyboard, prove route/focus isolation, and capture the parent/child terminal result while the sibling retains Running plus Stop. Clean up the sibling and root turn.

- [ ] **Step 4: Verify fresh Claude controls and isolation**

Open a Claude panel. If the composer can launch an authenticated provider, start a uniquely named parent, nested child, and sibling using Claude Agent tools, capture the same fresh-control geometry, activate the parent subtree action, and prove only parent/child receive terminal lifecycle while the sibling/root continue. Inspect original-resolution and enlarged crops.

If the provider reports unauthenticated/unavailable or cannot create authenticated hook controls, capture the blocker frame verbatim. Do not modify credentials. Cite the Task 2 authenticated production-RPC fixture as automated Claude dispatch evidence, while marking live Claude visual verification blocked.

- [ ] **Step 5: Final audit and report**

Review every screenshot at original resolution and cropped enlargement for status/action overlap, hierarchy, clipping, focus ring, icon multiplicity, and native-ID leakage. Run:

```bash
git diff --check
git status --short
pgrep -fal '/Users/admin/.codex/worktrees/c3e5/BibCode/target/release/bundle/macos/BiBCode.app/Contents/MacOS/bibcode-desktop'
```

Write exact commands, counts, bundle path/PID, screenshot paths, Claude live result or blocker, and residual risk into the ignored verification report. Leave exactly one rebuilt app instance running.
