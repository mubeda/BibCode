# Sidebar Open in File Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-desktop-only `Open in` → `File Explorer` action to project and worktree rows that opens the row's effective checkout directory in the operating system file manager.

**Architecture:** Keep menu composition and effective-path selection in `SidebarProjectItem`. Gate the action on the row belonging to the primary environment and on the existing optional `window.desktopBridge.openInFileManager` capability, then call that bridge directly with `isDirectory: true`; normal project traffic and remote paths never cross this native boundary.

**Tech Stack:** React 19, TypeScript, Vite+ test, Tauri `DesktopBridge`, Vitest-compatible `vite-plus/test` assertions.

## Global Constraints

- Put `File Explorer` first in the existing `Open in` submenu, before external editor entries.
- Show it only for rows in the primary local desktop environment when `DesktopBridge.openInFileManager` exists.
- Omit it for SSH/remote environments, browser mode, and hosts without the optional capability.
- Open `project.workspaceRoot` for the primary checkout and `thread.worktreePath` for worktrees.
- Preserve existing editor discovery, ordering, launch behavior, and the disabled `Open in` state when no child action is available.
- Reuse `DesktopBridge.openInFileManager(path, true)`; do not change contracts, RPC, the server, the Tauri adapter, or Rust.
- Preserve unrelated worktree changes and do not edit `.codegraph/` or `.repos/`.

## File Structure

- Modify `apps/web/src/components/Sidebar.tsx`: compose the eligible File Explorer submenu child, dispatch it before generic editor ids, select the effective row path, and report bridge rejections.
- Modify `apps/web/src/components/Sidebar.test.tsx`: exercise the real Sidebar callbacks while faking only the native bridge and native context-menu boundary.
- Modify `docs/user/workspace-ui.md`: document the local-only project/worktree File Explorer action.
- Reference only `docs/superpowers/specs/2026-08-07-sidebar-open-in-file-explorer-design.md`; the approved spec is historical evidence and is not changed during implementation.

---

### Task 1: Local-only menu composition and checkout-path launch

**Files:**
- Modify: `apps/web/src/components/Sidebar.test.tsx` in `staticDescribe("thread context menu", ...)` and the primary-row context-menu tests
- Modify: `apps/web/src/components/Sidebar.tsx` around `handleThreadContextMenu` and `handlePrimaryRowContextMenu`

**Interfaces:**
- Consumes: `usePrimaryEnvironmentId(): EnvironmentId | null`, `window.desktopBridge?.openInFileManager(path: string, isDirectory: boolean): Promise<void>`, `thread.worktreePath`, and `project.workspaceRoot`
- Produces: native context-menu action id `open-in:file-explorer`; no exported TypeScript API

- [ ] **Step 1: Add the failing primary-row test**

The production mistakes this catches are omitting the local action, placing it after editors, disabling the submenu when it is the only child, opening the wrong path, or treating a directory as a file.

Add this test beside `shows the primary-row context menu and handles update / copy / pin actions`:

```tsx
it("opens the local primary checkout in File Explorer even when no editor is available", async () => {
  baseScenario();
  h.state.atomValues.primaryServerConfig = {
    availableEditors: [],
    environment: { serverVersion: "0.1.0" },
  };
  const openInFileManager = vi.fn(async () => {});
  (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
    openInFileManager,
  };
  render(<Sidebar />);
  fakeLocalApi();
  const primaryRow = captured("SidebarMenuSubButton").find(
    (entry) =>
      entry.props["data-thread-item"] !== undefined && entry.props["render"] === undefined,
  )!;
  h.spies.contextMenuShow.mockImplementation(
    async (items: Array<{ id: string; disabled?: boolean; children?: Array<{ id: string }> }>) => {
      const openIn = items.find((item) => item.id === "open-in");
      expect(openIn?.disabled).not.toBe(true);
      expect(openIn?.children?.map((item) => item.id)).toEqual(["open-in:file-explorer"]);
      return "open-in:file-explorer";
    },
  );

  invoke(primaryRow.props, "onContextMenu", mouseEvent());
  await flush();

  expect(openInFileManager).toHaveBeenCalledOnce();
  expect(openInFileManager).toHaveBeenCalledWith("C:/repo-a", true);
});
```

- [ ] **Step 2: Run the primary-row test and verify RED**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx -t "opens the local primary checkout in File Explorer even when no editor is available"
```

Expected: FAIL because the editor-free `Open in` item is disabled and has no `open-in:file-explorer` child.

- [ ] **Step 3: Add the failing worktree-path test**

The production mistake this catches is falling back to the repository root instead of using the worktree's effective checkout directory.

Add this test inside `staticDescribe("thread context menu", ...)`:

```tsx
it("opens a local worktree path in File Explorer", async () => {
  baseScenario();
  const openInFileManager = vi.fn(async () => {});
  (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
    openInFileManager,
  };
  render(<Sidebar />);
  fakeLocalApi();
  h.spies.contextMenuShow.mockResolvedValue("open-in:file-explorer");
  const row = mustFindProps(byTestId("thread-row-thread-active"), "active worktree row");

  invoke(row, "onContextMenu", mouseEvent());
  await flush();

  expect(openInFileManager).toHaveBeenCalledWith("C:/wt/x", true);
});
```

- [ ] **Step 4: Run both positive-path tests and verify RED**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx -t "File Explorer"
```

Expected: both local primary/worktree tests FAIL because the action does not exist.

- [ ] **Step 5: Implement the minimal positive path through one shared callback**

Inside `SidebarProjectItem`, add one private callback shared by both row handlers. At this stage, deliberately leave eligibility gating for the next red-green cycle:

```tsx
const openWorkspaceInFileManager = useCallback(async (path: string) => {
  const bridge =
    typeof window === "undefined" ? undefined : window.desktopBridge?.openInFileManager;
  if (!bridge) return;
  await bridge(path, true);
}, []);
```

In both context-menu callbacks, prepend the action to the editor children:

```tsx
const openInChildren = [
  { id: "open-in:file-explorer", label: "File Explorer" },
  ...openInEditorOptions.map((editor) => ({
    id: `open-in:${editor.id}`,
    label: editor.label,
  })),
];
```

Replace the current editor-count conditional in both menus with:

```tsx
{ id: "open-in", label: "Open in", children: openInChildren },
```

Before the generic `clicked.startsWith("open-in:")` editor branch in each callback, dispatch the exact File Explorer id:

```tsx
if (clicked === "open-in:file-explorer") {
  await openWorkspaceInFileManager(threadWorkspacePath);
  return;
}
```

Use `cwd` rather than `threadWorkspacePath` in the primary-row callback. Add `openWorkspaceInFileManager` to both callback dependency arrays. Do not add fallback paths or call the server.

- [ ] **Step 6: Run both positive-path tests and verify GREEN**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx -t "File Explorer"
```

Expected: both local primary/worktree tests PASS with no unhandled promise rejection.

- [ ] **Step 7: Add failing availability-boundary tests**

The production mistakes these catch are exposing a local privileged action to remote paths or displaying an action that its host cannot execute. They are added only after Step 5 intentionally exposes the action broadly, so both tests must fail for the intended reason.

Add these tests inside `staticDescribe("thread context menu", ...)`:

```tsx

it("omits File Explorer for a remote row", async () => {
  const { remoteThread } = groupedScenario();
  const openInFileManager = vi.fn(async () => {});
  (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
    openInFileManager,
  };
  render(<Sidebar />);
  fakeLocalApi();
  h.spies.contextMenuShow.mockImplementation(
    async (items: Array<{ id: string; children?: Array<{ id: string }> }>) => {
      const openIn = items.find((item) => item.id === "open-in");
      expect(openIn?.children?.some((item) => item.id === "open-in:file-explorer")).toBe(false);
      return null;
    },
  );
  const row = mustFindProps(byTestId(`thread-row-${remoteThread.id}`), "remote row");

  invoke(row, "onContextMenu", mouseEvent());
  await flush();

  expect(openInFileManager).not.toHaveBeenCalled();
});

it("omits File Explorer when the desktop bridge capability is unavailable", async () => {
  baseScenario();
  render(<Sidebar />);
  fakeLocalApi();
  h.spies.contextMenuShow.mockImplementation(
    async (items: Array<{ id: string; children?: Array<{ id: string }> }>) => {
      const openIn = items.find((item) => item.id === "open-in");
      expect(openIn?.children?.map((item) => item.id)).toEqual(["open-in:vscode"]);
      return null;
    },
  );
  const row = mustFindProps(byTestId("thread-row-thread-active"), "active worktree row");

  invoke(row, "onContextMenu", mouseEvent());
  await flush();
});
```

- [ ] **Step 8: Run the availability tests and verify RED**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx -t "omits File Explorer"
```

Expected: both omission tests FAIL because Step 5 deliberately exposes `open-in:file-explorer` without environment or capability gates.

- [ ] **Step 9: Add the environment and capability gates**

In each context-menu callback, derive eligibility for that row:

```tsx
const canOpenInFileExplorer =
  thread.environmentId === primaryEnvironmentId && typeof window !== "undefined"
    ? window.desktopBridge?.openInFileManager !== undefined
    : false;
const openInChildren = [
  ...(canOpenInFileExplorer
    ? [{ id: "open-in:file-explorer", label: "File Explorer" }]
    : []),
  ...openInEditorOptions.map((editor) => ({
    id: `open-in:${editor.id}`,
    label: editor.label,
  })),
];
```

For `handlePrimaryRowContextMenu`, use `project.environmentId === primaryEnvironmentId` in place of `thread.environmentId === primaryEnvironmentId`. Replace the current editor-count conditional in both menus with:

```tsx
openInChildren.length > 0
  ? { id: "open-in", label: "Open in", children: openInChildren }
  : { id: "open-in", label: "Open in", disabled: true },
```

Keep the exact action dispatch from Step 5. Ensure `primaryEnvironmentId` remains in both callback dependency arrays.

- [ ] **Step 10: Run all Task 1 tests and verify GREEN**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx -t "File Explorer"
```

Expected: all File Explorer success and omission tests PASS with no unhandled promise rejection.

- [ ] **Step 11: Run the complete Sidebar test file**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx
```

Expected: all Sidebar tests PASS, including existing editor launch behavior and disabled-menu coverage.

- [ ] **Step 12: Commit Task 1**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx
git commit -m "feat(web): open local workspaces in File Explorer"
```

---

### Task 2: Native-launch failure handling and living documentation

**Files:**
- Modify: `apps/web/src/components/Sidebar.test.tsx` in the File Explorer context-menu tests
- Modify: `apps/web/src/components/Sidebar.tsx` in the shared File Explorer launch callback
- Modify: `docs/user/workspace-ui.md` under `## Left Panel`

**Interfaces:**
- Consumes: the `open-in:file-explorer` action and `openWorkspaceInFileManager(path: string): Promise<void>` callback introduced in Task 1
- Produces: visible toast `{ type: "error", title: "Unable to open File Explorer", description: string }`; updated user-facing workspace behavior documentation

- [ ] **Step 1: Add failing rejection tests**

The first test catches swallowed native errors and incorrect titles. The second catches leaking opaque rejection values into UI or using inconsistent fallback copy.

Add these tests beside the Task 1 File Explorer tests:

```tsx
it.each([
  [new Error("finder unavailable"), "finder unavailable"],
  ["opaque failure", "An unexpected error occurred."],
])("reports File Explorer launch failures", async (rejection, description) => {
  baseScenario();
  const openInFileManager = vi.fn(async () => Promise.reject(rejection));
  (globalThis.window as unknown as Record<string, unknown>)["desktopBridge"] = {
    openInFileManager,
  };
  render(<Sidebar />);
  fakeLocalApi();
  h.spies.contextMenuShow.mockResolvedValue("open-in:file-explorer");
  const row = mustFindProps(byTestId("thread-row-thread-active"), "active worktree row");

  invoke(row, "onContextMenu", mouseEvent());
  await flush();

  expect(h.spies.toastAdd).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      title: "Unable to open File Explorer",
      description,
    }),
  );
});
```

- [ ] **Step 2: Run the rejection tests and verify RED**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx -t "reports File Explorer launch failures"
```

Expected: FAIL through an unhandled rejection or missing toast because Task 1 performs a bare awaited bridge call.

- [ ] **Step 3: Add the minimal rejection handling once in the shared callback**

Add `try`/`catch` inside the single `openWorkspaceInFileManager` callback while retaining its capability guard:

```tsx
const openWorkspaceInFileManager = useCallback(async (path: string) => {
  const bridge =
    typeof window === "undefined" ? undefined : window.desktopBridge?.openInFileManager;
  if (!bridge) return;
  try {
    await bridge(path, true);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Unable to open File Explorer",
      description: error instanceof Error ? error.message : "An unexpected error occurred.",
    });
  }
}, []);
```

Both row handlers continue calling this shared callback with their already-selected path. Do not retry, navigate, mutate project state, or fall back to an editor.

- [ ] **Step 4: Run the rejection test and verify GREEN**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx -t "reports File Explorer launch failures"
```

Expected: both table cases PASS with no unhandled rejection.

- [ ] **Step 5: Update living documentation**

In `docs/user/workspace-ui.md`, replace the final sentence of the Left Panel introduction:

```markdown
Workspace row context menus include update/open/copy/pin/unread actions, plus
delete worktree for worktree rows and remove project for primary rows. On the
local desktop environment, **Open in → File Explorer** opens the repository
folder for a primary row or the worktree folder for a worktree row. The action
is omitted for remote environments and browser mode.
```

- [ ] **Step 6: Run focused and package-level web tests**

Run:

```bash
vp test run apps/web/src/components/Sidebar.test.tsx
vp test run --project unit
```

Expected: both commands exit 0 with no failed tests or unhandled rejections.

- [ ] **Step 7: Run repository-required checks**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit 0. No Rust formatting, Clippy, or Rust test command is required because no Rust file changes.

- [ ] **Step 8: Review the final patch and worktree state**

Run:

```bash
git diff --check
git diff -- apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx docs/user/workspace-ui.md
git status --short
```

Confirm the diff contains only the requested Sidebar behavior, focused tests, and living documentation; contains no `.codegraph/`, `.repos/`, generated, dependency, or debug changes; and preserves any unrelated user work.

- [ ] **Step 9: Commit Task 2**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx docs/user/workspace-ui.md
git commit -m "fix(web): report File Explorer launch failures"
```

- [ ] **Step 10: Record validation evidence for handoff**

Report the exact focused and broad commands run, their exit status, any command that could not run, CodeGraph's failed sync status from pre-work, and the residual risk that automated tests fake the OS file-manager boundary rather than launching Finder, Explorer, or a Linux file manager in CI.
