# Terminal Panel Close-Control Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the duplicate top-level trash button from center and right terminal panels while keeping panel-tab closure and individual split-terminal closure reliable.

**Architecture:** Keep whole-surface closure in the surrounding center/right workspace and keep individual-session closure in the right-panel terminal list. `ThreadTerminalPanel` retains only terminal-local create/split controls in its top toolbar, with conditional wrappers and separators so removing the trash action cannot leave empty chrome.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Base UI popovers, Vite+ tests, Tauri 2 desktop QA.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-06-terminal-panel-close-control-ownership-design.md`.
- Remove the exact top-level trash/`Close Terminal` action from both terminal-renderer toolbar variants and both `center-panel` and `right-panel` owners.
- Keep the panel/tab close control as the authoritative whole-surface close action.
- Keep per-terminal close controls for right-panel split/group sessions.
- Do not change `Cmd/Ctrl+W`, terminal split/new behavior, or `retireTerminalSession`.
- Do not leave an empty toolbar shell, a trailing separator, or a leading separator.
- Preserve the floating toolbar's existing `right-2 top-2` inset and all accessible names for retained controls.
- Do not add dependencies or edit `.repos/`.
- Use test-driven development for the behavior change.
- `vp test`, `vp check`, `vp run typecheck`, the desktop release build, and exact-bundle Codex Computer Use verification must pass before completion.

---

## File Responsibility Map

- `apps/web/src/components/ThreadTerminalPanel.tsx` — remove the duplicate whole-surface action; render only supported split/new toolbar actions; keep per-session list close buttons.
- `apps/web/src/components/ThreadTerminalPanel.test.tsx` — static markup contract for absent top-level close chrome, retained actions, empty-toolbar omission, and retained per-session controls.
- `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx` — interaction contract for retained split/new controls and per-session closure.
- `apps/web/src/components/CenterTerminalPanel.test.tsx` — prove the surrounding center host still forwards its panel-owned close callback.
- `apps/web/src/centerPanelActions.test.ts` — existing lifecycle regression proving a removed terminal surface is passed to the terminal-retirement callback; no production change expected.

---

### Task 1: Make Panel Tabs Own Whole-Terminal-Surface Closure

**Files:**

- Modify: `apps/web/src/components/ThreadTerminalPanel.tsx`
- Modify: `apps/web/src/components/ThreadTerminalPanel.test.tsx`
- Modify: `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx`
- Modify: `apps/web/src/components/CenterTerminalPanel.test.tsx`
- Verify: `apps/web/src/centerPanelActions.test.ts`

**Interfaces:**

- Preserves: `ThreadTerminalPanelProps.onCloseTerminal(terminalId: string): void` for session exit and per-session list closure.
- Preserves: `CenterTerminalPanelProps.onClose(): void`, forwarded as `ThreadTerminalPanelProps.onCloseTerminal` for the surrounding center surface.
- Produces: no exact top-level toolbar action with `aria-label="Close Terminal"` or `aria-label="Close Terminal (shortcut)"`.
- Preserves: per-session list labels such as `Close Terminal 1` and the active session's shortcut suffix.

- [ ] **Step 1: Write failing static renderer tests**

Update `ThreadTerminalPanel.test.tsx` so the single-terminal contract rejects the duplicate action:

```tsx
it("renders terminal-local actions without a whole-surface close control", () => {
  const markup = renderToStaticMarkup(<ThreadTerminalPanel {...panelProps()} />);
  expect(markup).toContain('aria-label="Split Terminal Horizontally"');
  expect(markup).toContain('aria-label="Split Terminal Vertically"');
  expect(markup).toContain('aria-label="New Terminal"');
  expect(markup).not.toContain('aria-label="Close Terminal"');
  expect(markup).not.toContain("lucide-trash-2");
});
```

Add the center-owner case:

```tsx
it("does not render a whole-surface close control for a center terminal", () => {
  const markup = renderToStaticMarkup(
    <ThreadTerminalPanel {...panelProps({ owner: "center-panel" })} />,
  );
  expect(markup).not.toContain('aria-label="Close Terminal"');
  expect(markup).not.toContain("lucide-trash-2");
});
```

Change the unsupported-actions case to require that no floating toolbar shell remains:

```tsx
expect(markup).not.toContain('aria-label="Split Terminal Horizontally"');
expect(markup).not.toContain('aria-label="Split Terminal Vertically"');
expect(markup).not.toContain('aria-label="New Terminal"');
expect(markup).not.toContain("pointer-events-none absolute right-2 top-2 z-20");
```

In the multi-terminal/sidebar case, require the exact top-level label to be absent while individual-session controls remain:

```tsx
expect(markup).not.toContain('aria-label="Close Terminal"');
expect(markup).toContain("Close Terminal 1");
expect(markup).toContain("Close Terminal 2");
```

- [ ] **Step 2: Write failing interaction and host-ownership tests**

In `ThreadTerminalPanel.interactions.test.tsx`, replace the top-level close click in the split/group test with the retained individual-session close control:

```tsx
await click(buttonByLabel("Split Terminal Horizontally"));
await click(buttonByLabel("Split Terminal Vertically"));
await click(buttonByLabel("New Terminal"));
await click(buttonByLabel("Close Terminal 1"));
expect(onSplitTerminal).toHaveBeenCalledOnce();
expect(onSplitTerminalVertical).toHaveBeenCalledOnce();
expect(onNewTerminal).toHaveBeenCalledOnce();
expect(onCloseTerminal).toHaveBeenCalledWith("term-1");
```

Update the single-terminal unsupported-actions interaction to assert that no renderer button is available rather than invoking the removed top-level close action:

```tsx
expect(document.querySelectorAll('button[aria-label^="Split Terminal"]')).toHaveLength(0);
expect(document.querySelector('button[aria-label^="New Terminal"]')).toBeNull();
expect(document.querySelector('button[aria-label="Close Terminal"]')).toBeNull();
expect(onCloseTerminal).not.toHaveBeenCalled();
```

In `CenterTerminalPanel.test.tsx`, pass a stable callback and prove the surrounding host still owns closure:

```tsx
const onClose = vi.fn();
renderToStaticMarkup(
  <CenterTerminalPanel
    threadRef={{
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    }}
    projectId={ProjectId.make("project-1")}
    surface={surface}
    launchContext={{
      cwd: "/repo/.bibcode/worktrees/feature",
      worktreePath: "/repo/.bibcode/worktrees/feature",
      runtimeEnv: { BIBCODE_PROJECT_ROOT: "/repo" },
    }}
    keybindings={{} as never}
    focusRequestId={1}
    onAddTerminalContext={vi.fn()}
    onClose={onClose}
  />,
);
expect(h.panelProps?.["onCloseTerminal"]).toBe(onClose);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
vp test apps/web/src/components/ThreadTerminalPanel.test.tsx \
  apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx \
  apps/web/src/components/CenterTerminalPanel.test.tsx \
  apps/web/src/centerPanelActions.test.ts
```

Expected: FAIL because both toolbar variants still render the exact top-level `Close Terminal` action and trash icon; the old interaction tests still find and invoke that control.

- [ ] **Step 4: Remove the duplicate top-level actions and empty chrome**

In `ThreadTerminalPanel.tsx`:

1. Remove `Trash2` from the `lucide-react` import.
2. Delete `closeTerminalActionLabel`; `closeShortcutLabel` remains because individual-session labels still use it.
3. Add one availability flag after the existing split-limit and label calculations:

```tsx
const hasTerminalToolbarActions = Boolean(
  onSplitTerminal || onSplitTerminalVertical || onNewTerminal,
);
```

4. Change the floating toolbar's opening and closing conditional to gate it on both conditions:

```tsx
{!hasTerminalSidebar && hasTerminalToolbarActions ? (
```

```tsx
) : null}
```

5. Remove the final `TerminalActionButton` containing `Trash2` from the floating toolbar. Render separators only when another retained action follows:

```tsx
{onSplitTerminal && (onSplitTerminalVertical || onNewTerminal) ? (
  <div className="h-4 w-px bg-border/80" />
) : null}
```

Use the equivalent condition after vertical split:

```tsx
{onSplitTerminalVertical && onNewTerminal ? (
  <div className="h-4 w-px bg-border/80" />
) : null}
```

Do not render a divider after the New Terminal action.

6. Gate the sidebar toolbar row with `hasTerminalToolbarActions`. Remove its final trash button. Apply `border-l border-border/70` only when an earlier retained action exists:

```tsx
className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors hover:bg-accent/70 ${
  onSplitTerminal ? "border-l border-border/70" : ""
}`}
```

For New Terminal, the earlier-action condition is `onSplitTerminal || onSplitTerminalVertical`.

7. Keep the per-session `XIcon`/popover block inside `terminalGroup.terminalIds.map` unchanged.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run the same focused command from Step 3.

Expected: all four files pass; the renderer has no top-level close action, individual-session closure still calls `onCloseTerminal`, and the center host still forwards its surface-owned close callback.

- [ ] **Step 6: Run formatting and diff validation**

Run:

```bash
vp check
git diff --check
```

Expected: both commands exit 0 without modifying the intended behavior.

- [ ] **Step 7: Commit the implementation**

```bash
git add apps/web/src/components/ThreadTerminalPanel.tsx \
  apps/web/src/components/ThreadTerminalPanel.test.tsx \
  apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx \
  apps/web/src/components/CenterTerminalPanel.test.tsx
git commit -m "fix(web): make panel tabs own terminal closure"
```

---

### Task 2: Full Verification and Exact-Bundle Desktop QA

**Files:**

- Verify: `apps/web/src/components/ThreadTerminalPanel.tsx`
- Verify: `apps/web/src/components/CenterTerminalPanel.tsx`
- Verify: `apps/web/src/centerPanelActions.ts`
- Verify: `apps/web/src/terminalRetirement.ts`
- Evidence: `.artifacts/visual-qa/terminal-panel-close-ownership/`

**Interfaces:**

- Verifies: renderer content has no top-level trash control.
- Verifies: panel/tab close removes the terminal surface and backend session.
- Verifies: right-panel individual-session controls remain.
- Produces: exact-worktree release screenshot and interaction report.

- [ ] **Step 1: Run a static ownership audit**

Run:

```bash
rg -n "Trash2|closeTerminalActionLabel" apps/web/src/components/ThreadTerminalPanel.tsx
rg -n "onCloseTerminal|retireTerminalSession" \
  apps/web/src/components/CenterTerminalPanel.tsx \
  apps/web/src/centerPanelActions.ts \
  apps/web/src/components/ChatView.tsx \
  apps/web/src/terminalRetirement.ts
```

Expected: the first command has no matches; the second shows the supported panel-owned and individual-session lifecycle paths.

- [ ] **Step 2: Run full repository verification**

Run:

```bash
NODE_NO_WARNINGS=1 vp test
vp check
vp run typecheck
git diff --check
```

Expected: 0 test failures, 0 unhandled errors, 0 lint/format errors, 0 type errors, and no whitespace errors.

- [ ] **Step 3: Build the desktop release**

Run:

```bash
vp run build:desktop
```

Expected release bundle:

```text
/Users/admin/.codex/worktrees/eccd/BibCode/target/release/bundle/macos/BiBCode.app
```

- [ ] **Step 4: Verify the exact bundle with Codex Computer Use**

Use bundled Codex Computer Use, never Orca, and target the exact bundle path above.

1. Open the existing BibCode thread from the Command Palette.
2. Open a center terminal surface and capture a screenshot proving no in-content trash icon appears.
3. Record the center tab label and monitored terminal count.
4. Click the tab button whose accessible name begins with `Close Terminal`.
5. Verify the tab disappears and the monitored terminal count decreases by one.
6. Open the right panel's terminal surface, verify the top toolbar has no trash icon, and verify individual split/group close controls remain when multiple sessions exist.
7. Confirm `Cmd+W` still closes the active terminal surface and leaves the application window open.
8. Save screenshots and a short report under `.artifacts/visual-qa/terminal-panel-close-ownership/`.
9. Restore the original layout/theme and stop the exact QA application process.

- [ ] **Step 5: Commit only corrections discovered by QA**

If QA reveals a defect, add a failing regression first, implement the minimal correction, rerun Steps 1-4, and commit:

```bash
git add apps/web/src
git commit -m "fix(web): correct terminal panel close chrome"
```

If QA finds no defect, do not create an empty commit.
