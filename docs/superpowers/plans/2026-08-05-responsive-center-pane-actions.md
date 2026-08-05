# Responsive Center Pane Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the focused center pane's New Panel `+` usable at every supported width while replacing secondary project/editor controls with one accessible overflow menu when the local pane is narrow.

**Architecture:** Measure each center header's own inline size and pass a typed `expanded | compact` density into a render callback for the focused action slot. `ChatHeaderActions` creates one project-script controller and one editor-action controller, then renders either expanded triggers or a single compact menu from those same models. Dialogs, editor shortcuts, and hidden Git synchronization stay mounted once across density changes.

**Tech Stack:** React 19, TypeScript, ResizeObserver, CSS named size containers, Tailwind CSS v4, Base UI menus/dialogs, Vite+ tests.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-05-orange-interaction-theme-and-terminal-drawer-retirement-design.md`.
- Responsiveness follows the focused pane's own header width, not `window.innerWidth`.
- The New Panel `+` remains visible in both densities.
- Existing pane actions (including Close Split Pane) remain visible and separate from the workspace-action overflow.
- At wide widths, preserve the current project script and Open In controls.
- At narrow widths, render one `...` trigger containing the supported project-script and editor actions.
- Never mount duplicate stateful controls or duplicate global shortcut listeners to achieve responsive hiding.
- Keep project-script dialogs open and valid if density changes while a dialog is active.
- Keep `GitActionsControl hideTrigger` mounted exactly once for branch synchronization.
- Preserve native titlebar-control reservation in the focused top-right pane and use an 8-pixel action inset elsewhere.
- Preserve menu keyboard navigation, disabled states, focus restoration, accessible names, shortcuts, provider colors, and action callbacks.
- Do not add dependencies or edit `.repos/`.
- Use test-driven development for each behavior change.
- `vp check` and `vp run typecheck` must pass before completion.

---

## File Responsibility Map

### Local pane density

- Create `apps/web/src/components/centerPaneHeaderDensity.ts` and `.test.ts` — finite-width policy and stable `expanded | compact` type.
- `apps/web/src/components/CenterPanelSplitLayout.tsx` and `.test.tsx` — named size container, local ResizeObserver, and density-aware focused-action render callback.
- `apps/web/src/components/CenterPanelWorkspace.tsx` and `.test.tsx` — thread the render callback without owning density or action state.
- `apps/web/src/components/ChatView.tsx` and tests — render `ChatHeaderActions` for the density reported by the focused group.

### Single-owned action models

- Modify `apps/web/src/components/ProjectScriptsControl.tsx` and `.test.tsx` — extract one controller plus expanded/menu/dialog presentations.
- Modify `apps/web/src/components/chat/OpenInPicker.tsx` and `.test.tsx` — extract one controller plus expanded/menu presentations, with one shortcut effect.
- Modify `apps/web/src/components/chat/ChatHeaderActions.tsx` — compose the persistent controllers, always-visible `+`, expanded controls, compact overflow, dialogs, and one hidden Git control.
- Modify `apps/web/src/components/chat/ChatHeaderActions.render.test.tsx` — wide/compact markup, titlebar inset, one hidden lifecycle control.
- Modify `apps/web/src/components/chat/ChatHeaderActions.test.ts` — preserve policy helper tests and add compact action-model policy where useful.
- Modify `apps/web/src/components/chat/ChatHeaderPanelMenu.tsx` and `.test.tsx` — call the controller's stable `openAddDialog` directly.

---

### Task 1: Define and Test the Local Header Density Policy

**Files:**

- Create: `apps/web/src/components/centerPaneHeaderDensity.ts`
- Create: `apps/web/src/components/centerPaneHeaderDensity.test.ts`

**Interfaces:**

```ts
export type CenterPaneHeaderDensity = "expanded" | "compact";
export const EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH = 560;
export function resolveCenterPaneHeaderDensity(width: number): CenterPaneHeaderDensity;
```

- [ ] **Step 1: Write the failing boundary test**

```ts
import { describe, expect, it } from "vite-plus/test";
import {
  EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH,
  resolveCenterPaneHeaderDensity,
} from "./centerPaneHeaderDensity";

describe("resolveCenterPaneHeaderDensity", () => {
  it.each([
    [Number.NaN, "compact"],
    [-1, "compact"],
    [EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH - 1, "compact"],
    [EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH, "expanded"],
    [1200, "expanded"],
  ] as const)("maps %s to %s", (width, expected) => {
    expect(resolveCenterPaneHeaderDensity(width)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test and confirm red**

```bash
vp test apps/web/src/components/centerPaneHeaderDensity.test.ts
```

Expected: compilation failure because the policy module does not exist.

- [ ] **Step 3: Implement the pure policy**

```ts
export type CenterPaneHeaderDensity = "expanded" | "compact";
export const EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH = 560;

export function resolveCenterPaneHeaderDensity(width: number): CenterPaneHeaderDensity {
  return Number.isFinite(width) && width >= EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH
    ? "expanded"
    : "compact";
}
```

Use compact as the safe default for unavailable/invalid measurements.

- [ ] **Step 4: Run the focused test and commit**

```bash
vp test apps/web/src/components/centerPaneHeaderDensity.test.ts
git add apps/web/src/components/centerPaneHeaderDensity.ts apps/web/src/components/centerPaneHeaderDensity.test.ts
git commit -m "feat(web): define center header density policy"
```

---

### Task 2: Make the Focused Action Slot Density-Aware

**Files:**

- Modify: `apps/web/src/components/CenterPanelSplitLayout.tsx`
- Modify: `apps/web/src/components/CenterPanelSplitLayout.test.tsx`
- Modify: `apps/web/src/components/CenterPanelWorkspace.tsx`
- Modify: `apps/web/src/components/CenterPanelWorkspace.test.tsx`

**Interfaces:**

```ts
export interface CenterPanelSplitLayoutProps {
  // existing props
  readonly renderFocusedActions: (density: CenterPaneHeaderDensity) => ReactNode;
}
```

The old `focusedActions: ReactNode` prop is removed.

- [ ] **Step 1: Add a controllable ResizeObserver test harness**

In `CenterPanelSplitLayout.test.tsx`, install a mock that records observed elements and can emit a width. Change the shared input to:

```tsx
let resizeCallback: ResizeObserverCallback | null = null;

class MockResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function emitHeaderWidth(width: number): void {
  const callback = resizeCallback;
  if (!callback) throw new Error("Center header ResizeObserver was not installed");
  act(() => {
    callback(
      [{ contentRect: { width } as DOMRectReadOnly } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  });
}

const renderFocusedActions: CenterPanelSplitLayoutProps["renderFocusedActions"] = (density) => (
  <button type="button" data-density={density}>New panel</button>
);
```

Assign `renderFocusedActions` to that property in the existing `input()` fixture.

Add tests:

```tsx
it("renders compact actions for a narrow focused pane", async () => {
  await renderLayout(input());
  emitHeaderWidth(420);
  expect(root.querySelector("[data-density='compact']")).not.toBeNull();
});

it("renders expanded actions for a wide focused pane", async () => {
  await renderLayout(input());
  emitHeaderWidth(800);
  expect(root.querySelector("[data-density='expanded']")).not.toBeNull();
});
```

- [ ] **Step 2: Add local-container and edge-preservation assertions**

Assert each group header has the named `@container/center-pane-header` class, only the focused group renders actions, `data-touches-top-right` remains accurate, and the pane-action menu remains beside workspace actions in both densities.

- [ ] **Step 3: Run the split-layout test and confirm red**

```bash
vp test apps/web/src/components/CenterPanelSplitLayout.test.tsx
```

Expected: FAIL because the component consumes a static React node and does not measure local width.

- [ ] **Step 4: Implement a per-header observer without window listeners**

Inside `GroupLeaf`:

```tsx
const headerRef = useRef<HTMLElement>(null);
const [density, setDensity] = useState<CenterPaneHeaderDensity>("compact");

useLayoutEffect(() => {
  const header = headerRef.current;
  if (!header) return;
  const update = (width: number) => {
    const next = resolveCenterPaneHeaderDensity(width);
    setDensity((current) => (current === next ? current : next));
  };
  update(header.getBoundingClientRect().width);
  if (typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(([entry]) => {
    if (entry) update(entry.contentRect.width);
  });
  observer.observe(header);
  return () => observer.disconnect();
}, []);
```

Attach `ref={headerRef}` and `@container/center-pane-header` to the group header. Call `renderFocusedActions(density)` only for the focused group. Keep pane actions and tab rail outside the callback.

- [ ] **Step 5: Thread the callback through `CenterPanelWorkspace`**

Rename the workspace prop to `renderFocusedActions` and pass it through unchanged. Do not create action state or a second observer in the workspace.

- [ ] **Step 6: Run layout/workspace tests and commit**

```bash
vp test apps/web/src/components/centerPaneHeaderDensity.test.ts apps/web/src/components/CenterPanelSplitLayout.test.tsx apps/web/src/components/CenterPanelWorkspace.test.tsx
git add apps/web/src/components/CenterPanelSplitLayout.tsx apps/web/src/components/CenterPanelSplitLayout.test.tsx apps/web/src/components/CenterPanelWorkspace.tsx apps/web/src/components/CenterPanelWorkspace.test.tsx
git commit -m "feat(web): adapt center actions to pane width"
```

---

### Task 3: Extract a Single Project-Script Controller

**Files:**

- Modify: `apps/web/src/components/ProjectScriptsControl.tsx`
- Modify: `apps/web/src/components/ProjectScriptsControl.test.tsx`

**Interfaces:**

```ts
export interface ProjectScriptsController {
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly primaryScript: ProjectScript | null;
  readonly openAddDialog: () => void;
  readonly openEditDialog: (script: ProjectScript) => void;
  readonly runScript: (script: ProjectScript) => void;
  // private form/dialog state remains typed in this module
}

export function useProjectScriptsController(props: ProjectScriptsControlProps): ProjectScriptsController;
export function ProjectScriptsExpandedActions(props: { controller: ProjectScriptsController }): ReactNode;
export function ProjectScriptsMenuItems(props: { controller: ProjectScriptsController }): ReactNode;
export function ProjectScriptsDialogs(props: { controller: ProjectScriptsController }): ReactNode;
```

- [ ] **Step 1: Add controller/presentation behavior tests**

Extend the current tests to prove:

- the expanded primary action and dropdown call the controller callbacks;
- overflow menu items expose every script, shortcut, edit action, and Add action;
- `openAddDialog` and `openEditDialog` operate the same dialog state from either presentation;
- form validation, save, edit, delete, icon selection, and preview fields remain unchanged.

Using the test file's existing `renderControl`, `mustFind`, `buttonByText`, `invoke`, and state-seeding helpers, render `ProjectScriptsMenuItems` with the same controller returned by `useProjectScriptsController`; invoke `Edit Build`, then assert the recorded `Dialog` is open, `DialogTitle` receives `Edit Action`, and the `script-name` Input value is `Build`.

- [ ] **Step 2: Run the suite and confirm red**

```bash
vp test apps/web/src/components/ProjectScriptsControl.test.tsx
```

Expected: FAIL because state, expanded triggers, menu items, and dialogs are inseparable.

- [ ] **Step 3: Extract the hook without changing business rules**

Move existing `useState`, validation, form submission, add/edit/delete callbacks, primary-script selection, and request handling into `useProjectScriptsController`. Return stable action methods with `useCallback`; keep transient fields and setters available only to `ProjectScriptsDialogs` through a module-private extended controller type.

- [ ] **Step 4: Split the presentations**

- `ProjectScriptsExpandedActions` renders the existing primary button plus script dropdown.
- `ProjectScriptsMenuItems` renders script run items, per-script edit affordances, shortcuts, and Add action without a nested `Menu`/`MenuPopup`.
- `ProjectScriptsDialogs` renders the existing Dialog and AlertDialog exactly once.

Retain the default `ProjectScriptsControl` export as a compatibility wrapper that calls the hook once and composes expanded actions plus dialogs. Remove `addDialogRequestId`; callers use the stable `openAddDialog` directly.

- [ ] **Step 5: Run the project-script suite and commit**

```bash
vp test apps/web/src/components/ProjectScriptsControl.test.tsx apps/web/src/projectScripts.test.ts
git add apps/web/src/components/ProjectScriptsControl.tsx apps/web/src/components/ProjectScriptsControl.test.tsx
git commit -m "refactor(web): separate project action state and views"
```

---

### Task 4: Extract a Single Open-In Editor Controller

**Files:**

- Modify: `apps/web/src/components/chat/OpenInPicker.tsx`
- Modify: `apps/web/src/components/chat/OpenInPicker.test.tsx`

**Interfaces:**

```ts
export interface OpenInEditorController {
  readonly options: ReadonlyArray<OpenInEditorOption>;
  readonly preferredEditor: EditorId | null;
  readonly primaryOption: OpenInEditorOption | null;
  readonly shortcutLabel: string | null;
  readonly disabled: boolean;
  readonly openInEditor: (editorId: EditorId | null) => unknown;
}

export function useOpenInEditorController(props: OpenInPickerProps): OpenInEditorController;
export function OpenInExpandedActions(props: { controller: OpenInEditorController }): ReactNode;
export function OpenInMenuItems(props: { controller: OpenInEditorController }): ReactNode;
```

- [ ] **Step 1: Add one-owner and menu-item tests**

Add tests that:

- menu items list installed editors only;
- selecting an item invokes `shellEnvironment.openInEditor` and persists the preferred editor;
- the favorite-editor keybinding registers one window listener and invokes one mutation;
- compact menu composition does not register a second listener;
- no cwd/preferred editor yields disabled expanded action and safe no-op menu behavior.

- [ ] **Step 2: Run the Open In suite and confirm red**

```bash
vp test apps/web/src/components/chat/OpenInPicker.test.tsx
```

Expected: FAIL because the current component owns both state/effect and expanded UI.

- [ ] **Step 3: Move behavior into one hook and split presentations**

Keep option resolution, preferred-editor state, mutation, and shortcut effect in `useOpenInEditorController`. The expanded component renders the existing button/group. `OpenInMenuItems` returns only `MenuItem` children for insertion into a parent overflow popup. Keep a compatibility `OpenInPicker` wrapper if other call sites still need the expanded presentation.

- [ ] **Step 4: Run the focused tests and commit**

```bash
vp test apps/web/src/components/chat/OpenInPicker.test.tsx
git add apps/web/src/components/chat/OpenInPicker.tsx apps/web/src/components/chat/OpenInPicker.test.tsx
git commit -m "refactor(web): share open in editor action model"
```

---

### Task 5: Compose Expanded and Compact Actions from One State Owner

**Files:**

- Modify: `apps/web/src/components/chat/ChatHeaderActions.tsx`
- Modify: `apps/web/src/components/chat/ChatHeaderActions.render.test.tsx`
- Modify: `apps/web/src/components/chat/ChatHeaderActions.test.ts`
- Modify: `apps/web/src/components/chat/ChatHeaderPanelMenu.tsx`
- Modify: `apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx`

**Interfaces:**

```ts
interface ChatHeaderActionsProps {
  readonly density: CenterPaneHeaderDensity;
  // existing action/context props remain
}
```

- [ ] **Step 1: Add wide and compact render tests**

```tsx
it("keeps New panel and expanded controls at wide density", () => {
  const markup = renderToStaticMarkup(<ChatHeaderActions {...props()} density="expanded" />);
  expect(markup).toContain('aria-label="New panel"');
  expect(markup).toContain('aria-label="Project scripts"');
  expect(markup).toContain('aria-label="Open in editor"');
  expect(markup).not.toContain('aria-label="More workspace actions"');
});

it("keeps New panel and one overflow trigger at compact density", () => {
  const markup = renderToStaticMarkup(<ChatHeaderActions {...props()} density="compact" />);
  expect(markup).toContain('aria-label="New panel"');
  expect(markup).toContain('aria-label="More workspace actions"');
  expect(markup).not.toContain('aria-label="Script actions"');
  expect(markup).not.toContain('aria-label="Copy options"');
});
```

Mock Base UI portals as existing tests do so menu content can be asserted independently.

- [ ] **Step 2: Add continuity and single-lifecycle tests**

Mount expanded actions, open Add Action, rerender the same `ChatHeaderActions` instance with `density="compact"`, and assert the dialog/form state remains. Assert `GitActionsControl` is rendered once in both densities and one favorite-editor shortcut produces one command.

- [ ] **Step 3: Run header tests and confirm red**

```bash
vp test apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.test.ts apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx
```

Expected: FAIL because density and unified overflow do not exist.

- [ ] **Step 4: Compose the single controllers**

Call `useProjectScriptsController` and `useOpenInEditorController` unconditionally with enabled flags/current inputs so hook order never depends on availability. Render:

```tsx
<ChatHeaderPanelMenu
  providerStatuses={providerStatuses}
  settings={settings}
  canCreatePanel={canCreatePanel}
  onCreateChatPanel={onCreateChatPanel}
  onOpenTerminalPanel={onOpenTerminalPanel}
  onOpenProviderTerminalPanel={onOpenProviderTerminalPanel}
  onAddCustomAction={projectScripts.openAddDialog}
/>
{density === "expanded" ? (
  <>
    <ProjectScriptsExpandedActions controller={projectScripts} />
    <OpenInExpandedActions controller={openInEditor} />
  </>
) : (
  <Menu>
    <MenuTrigger
      render={<Button size="icon-xs" variant="outline" aria-label="More workspace actions" />}
    >
      <MoreHorizontal className="size-4" />
    </MenuTrigger>
    <MenuPopup align="end" className="min-w-56">
      <ProjectScriptsMenuItems controller={projectScripts} />
      <MenuSeparator />
      <OpenInMenuItems controller={openInEditor} />
    </MenuPopup>
  </Menu>
)}
<ProjectScriptsDialogs controller={projectScripts} />
```

Omit empty sections/separators when unavailable. Keep `GitActionsControl hideTrigger` after the visible branch so it mounts exactly once.

- [ ] **Step 5: Apply the consistent right inset**

Keep the action root non-shrinking and set:

```tsx
reserveTitlebarControls ? "pr-[4.5rem]" : "pr-2"
```

The extra 0.5rem is the required action inset outside the 4rem native-titlebar reservation. Preserve `[-webkit-app-region:no-drag]`, opaque background, and existing gap behavior.

- [ ] **Step 6: Run header/action tests and commit**

```bash
vp test apps/web/src/components/ProjectScriptsControl.test.tsx apps/web/src/components/chat/OpenInPicker.test.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.test.ts apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx
git add apps/web/src/components/ProjectScriptsControl.tsx apps/web/src/components/ProjectScriptsControl.test.tsx apps/web/src/components/chat/OpenInPicker.tsx apps/web/src/components/chat/OpenInPicker.test.tsx apps/web/src/components/chat/ChatHeaderActions.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.test.ts apps/web/src/components/chat/ChatHeaderPanelMenu.tsx apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx
git commit -m "feat(web): collapse narrow pane actions into overflow"
```

---

### Task 6: Wire Density from the Focused Pane through ChatView

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`

- [ ] **Step 1: Change workspace composition tests**

Update the `CenterPanelWorkspace` mock to capture `renderFocusedActions`. Call it with both densities and assert `ChatHeaderActions` receives `density`, while all existing callbacks and `reserveTitlebarControls` derive from the focused group's current edges.

- [ ] **Step 2: Run ChatView tests and confirm red**

```bash
vp test apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: FAIL because ChatView passes a static `focusedActions` node.

- [ ] **Step 3: Replace the static node with a stable render callback**

Inside the center-workspace composition, keep the existing focused-edge calculation and pass:

```tsx
renderFocusedActions={(density) => (
  <ChatHeaderActions
    density={density}
    activeThreadEnvironmentId={activeThread.environmentId}
    activeThreadId={activeThread.id}
    {...(routeKind === "draft" && draftId ? { draftId } : {})}
    activeProjectName={activeProject?.title}
    openInCwd={gitCwd}
    activeProjectScripts={activeProject?.scripts}
    preferredScriptId={
      activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
    }
    keybindings={keybindings}
    availableEditors={availableEditors}
    reserveTitlebarControls={reserveCenterTitlebarControls}
    gitCwd={gitCwd}
    providerStatuses={providerStatuses as ServerProvider[]}
    settings={settings}
    canCreatePanel={centerPanelLaunchContext !== null}
    onCreateChatPanel={handleCreateChatPanel}
    onOpenTerminalPanel={handleOpenTerminalPanel}
    onOpenProviderTerminalPanel={handleOpenProviderTerminalPanel}
    onRunProjectScript={runProjectScript}
    onAddProjectScript={saveProjectScript}
    onUpdateProjectScript={updateProjectScript}
    onDeleteProjectScript={deleteProjectScript}
  />
)}
```

Thread this callback through `LiveCenterPanelWorkspace`. Do not use window width or terminal kind. Ensure the callback is rendered only for the focused group so the stateful action owner exists once.

- [ ] **Step 4: Run ChatView and layout tests and commit**

```bash
vp test apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/CenterPanelSplitLayout.test.tsx apps/web/src/components/CenterPanelWorkspace.test.tsx
git add apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
git commit -m "feat(web): render actions for focused pane density"
```

---

### Task 7: Verify Responsive Behavior under Real Split Geometry

**Files:**

- Local only: `.artifacts/visual-qa/responsive-center-actions/`

- [ ] **Step 1: Run the complete focused suite**

```bash
vp test apps/web/src/components/centerPaneHeaderDensity.test.ts apps/web/src/components/CenterPanelSplitLayout.test.tsx apps/web/src/components/CenterPanelWorkspace.test.tsx apps/web/src/components/ProjectScriptsControl.test.tsx apps/web/src/components/chat/OpenInPicker.test.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/chat/ChatHeaderActions.test.ts apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run full repository gates**

```bash
vp test
vp check
vp run typecheck
git diff --check
```

Expected: all exit 0.

- [ ] **Step 3: Build and launch the desktop app**

Run the canonical production build, then launch this worktree's desktop development host:

```bash
vp run build:desktop
vp run start:desktop
```

Keep this process available for the combined theme, terminal, and responsive verification.

- [ ] **Step 4: Verify with Codex Computer Use**

Invoke `computer-use:computer-use` (not Orca computer use) and verify:

1. A wide focused pane shows `+`, project script controls, and Open In controls.
2. Narrowing the pane switches to `+` and one `...` overflow without clipping.
3. The exact narrow geometry from the reported terminal-toolbar screenshot has an 8-pixel right inset and no overlap.
4. Every script and installed editor action is keyboard reachable in overflow.
5. Add/Edit Action remains open and retains form contents while resizing across the threshold.
6. Top-right panes still reserve native titlebar controls.
7. Pane actions and the tab rail remain usable at the minimum supported split size.
8. Git branch synchronization still updates once, with no duplicate listeners/actions.

Save light/dark and wide/narrow screenshots under ignored `.artifacts/visual-qa/responsive-center-actions/`; inspect full-resolution images before claiming completion.

- [ ] **Step 5: Stop the app and commit any final corrections**

Stop only the process started for verification. If corrections were needed, rerun their focused tests plus `vp test`, `vp check`, and `vp run typecheck` before the final commit.
