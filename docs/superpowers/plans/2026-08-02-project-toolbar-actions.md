# Project Toolbar Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the project-row main-branch chat action without removing it and replace the worktree action's edit icon with the existing worktree icon.

**Architecture:** Keep both existing actions and handlers in `Sidebar.tsx`. Apply the existing Tailwind `invisible` utility to the main-chat button so it retains its layout footprint, and reuse Lucide's `FolderGit2Icon`, already established elsewhere in the app as the worktree symbol.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Lucide React, Vite+ tests.

## Global Constraints

- The main-branch chat button must remain rendered and keep its current layout space.
- The main-branch chat handler and tooltip must not be deleted.
- The worktree action must use `FolderGit2Icon`.
- Worktree click behavior, label, tooltip, sizing, spacing, hover behavior, and mobile behavior remain unchanged.
- Do not add dependencies or create a new icon abstraction.
- Preserve unrelated dirty-worktree changes.
- `vp check` and `vp run typecheck` must pass.

---

### Task 1: Clarify the project-row actions

**Files:**
- Modify: `apps/web/src/components/Sidebar.test.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `SIDEBAR_ICON_ACTION_BUTTON_CLASS`, `cn`, Lucide's `FolderGit2Icon`, and the existing project-row action handlers.
- Produces: An invisible but still-rendered `new-main-chat-button` and a visible `new-worktree-button` using the established worktree icon.

- [ ] **Step 1: Write the failing toolbar presentation test**

Add this test inside `staticDescribe("new thread entry points", ...)` in `Sidebar.test.tsx`:

```tsx
it("keeps the main-chat action invisible and uses the worktree icon", () => {
  baseScenario();
  const markup = render(<Sidebar />);

  const mainChat = mustFindProps(byTestId("new-main-chat-button"), "new main chat button");
  expect(mainChat["className"]).toContain("invisible");
  expect(markup).toContain("lucide-folder-git-2");
  expect(markup).not.toContain("lucide-square-pen");
});
```

The production change that makes this test pass is adding `invisible` to the existing main-chat button class and replacing `SquarePenIcon` with `FolderGit2Icon`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx -t "keeps the main-chat action invisible and uses the worktree icon"
```

Expected: FAIL because the main-chat button lacks `invisible` and the worktree action still renders `lucide-square-pen`.

- [ ] **Step 3: Implement the minimal presentation change**

In `Sidebar.tsx`, replace the Lucide import:

```tsx
FolderGit2Icon,
```

instead of:

```tsx
SquarePenIcon,
```

Keep the existing main-chat button and handler, changing only its class:

```tsx
className={cn(SIDEBAR_ICON_ACTION_BUTTON_CLASS, "invisible")}
```

Render the existing worktree action with:

```tsx
<FolderGit2Icon className="size-3.5" />
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx -t "keeps the main-chat action invisible and uses the worktree icon"
```

Expected: PASS.

- [ ] **Step 5: Run the full Sidebar test file**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx
```

Expected: all Sidebar tests PASS, including the existing main-chat and worktree click behavior.

- [ ] **Step 6: Run repository-required checks**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit the implementation**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx docs/superpowers/plans/2026-08-02-project-toolbar-actions.md
git commit -m "fix: clarify project toolbar actions"
```
