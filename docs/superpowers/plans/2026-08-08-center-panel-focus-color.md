# Center Panel Focus Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make focused and unfocused center panes use the same neutral framing color in light and dark themes without changing focus behavior.

**Architecture:** `apps/web/src/components/CenterPanelSplitLayout.tsx` owns center-pane chrome shared by browser and Tauri desktop modes. Preserve the existing `focusedGroupId` state flow and all event handlers, remove the focus-state Tailwind ring utilities that map through the orange global `--ring` token, and use `focus-visible:after:ring-border` for the existing keyboard-focus ring geometry.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, Vite+ unit tests, Tauri 2 desktop host.

## Global Constraints

- Do not change panel focus, pointer, keyboard, terminal, layout, persistence, action-rail, or drag-and-drop behavior.
- Do not change the global `--ring`, `--primary`, or other theme tokens.
- Do not add contracts, persistence fields, RPCs, desktop bridge operations, dependencies, or Rust changes.
- Verify the worktree-built Tauri desktop application in both actual light and dark themes.
- Preserve unrelated user changes and do not edit `.codegraph/` or `.repos/` data.
- Approved runtime-discovered amendment: retain `focus-visible:after:ring-2`,
  but replace `focus-visible:after:ring-ring/70` with the neutral
  `focus-visible:after:ring-border` on the pane region only. Do not alter
  separator focus or hover colors.

---

### Task 1: Remove Focus-Dependent Center-Pane Color

**Files:**

- Modify: `apps/web/src/components/CenterPanelSplitLayout.test.tsx`
- Modify: `apps/web/src/components/CenterPanelSplitLayout.tsx:218`

**Interfaces:**

- Consumes: `ThreadCenterPanelState.focusedGroupId`, the existing `data-focused` region attribute, and the existing `GroupLeaf` event handlers.
- Produces: Center-pane region class lists that are independent of `data-focused`, while leaving the focus state and focused action rail observable in the DOM.

- [ ] **Step 1: Add the focused/unfocused framing regression test**

Add this test inside the existing `describe("CenterPanelSplitLayout", ...)` block:

```tsx
it("uses the same framing for focused and unfocused panes", async () => {
  await renderLayout(input());

  const focusedPane = container.querySelector<HTMLElement>(
    '[data-center-panel-group][data-focused="true"]',
  );
  const unfocusedPane = container.querySelector<HTMLElement>(
    '[data-center-panel-group][data-focused="false"]',
  );

  expect(focusedPane).not.toBeNull();
  expect(unfocusedPane).not.toBeNull();
  expect(focusedPane?.className).toBe(unfocusedPane?.className);
  expect(focusedPane?.className).not.toContain("data-[focused=true]:after:ring");
  expect(focusedPane?.className).toContain("focus-visible:after:ring-2");
  expect(focusedPane?.className).toContain("focus-visible:after:ring-border");
  expect(focusedPane?.className).not.toContain("focus-visible:after:ring-ring");
  expect(container.querySelectorAll("[data-center-panel-focused-actions]")).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test and confirm the expected red failure**

Run:

```bash
cd apps/web
vp test run --project unit src/components/CenterPanelSplitLayout.test.tsx
```

Expected: FAIL only because the pane class list still contains
`focus-visible:after:ring-ring/70` and lacks
`focus-visible:after:ring-border`. The state and focused action assertions must
already pass.

- [ ] **Step 3: Remove only the focus-state ring utilities**

Change the `GroupLeaf` section classes from:

```tsx
className={cn(
  "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none",
  "after:pointer-events-none after:absolute after:inset-0 after:z-50 after:ring-inset after:content-['']",
  "focus-visible:after:ring-2 focus-visible:after:ring-ring/70",
  "data-[focused=true]:after:ring-1 data-[focused=true]:after:ring-ring/40",
)}
```

to:

```tsx
className={cn(
  "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none",
  "after:pointer-events-none after:absolute after:inset-0 after:z-50 after:ring-inset after:content-['']",
  "focus-visible:after:ring-2 focus-visible:after:ring-border",
)}
```

Do not edit `data-focused`, `focusGroup`, `handleFocusCapture`,
`onPointerDownCapture`, `onFocusCapture`, or the conditional focused action
rail.

- [ ] **Step 4: Run the focused test and confirm green**

Run:

```bash
cd apps/web
vp test run --project unit src/components/CenterPanelSplitLayout.test.tsx
```

Expected: PASS with all `CenterPanelSplitLayout` tests green and no warnings.

- [ ] **Step 5: Review the source diff for visual-only scope**

Run:

```bash
git diff -- apps/web/src/components/CenterPanelSplitLayout.tsx apps/web/src/components/CenterPanelSplitLayout.test.tsx
```

Expected: one regression test and removal of the two focus-state ring utilities;
no event, state, props, action, or layout changes.

- [ ] **Step 6: Commit the visual fix**

```bash
git add apps/web/src/components/CenterPanelSplitLayout.tsx apps/web/src/components/CenterPanelSplitLayout.test.tsx
git commit -m "fix(web): neutralize focused center pane framing"
```

---

### Task 2: Validate and Inspect the Built Desktop Application

**Files:**

- Inspect: `apps/web/src/components/CenterPanelSplitLayout.tsx`
- Inspect: `apps/web/src/components/CenterPanelSplitLayout.test.tsx`
- Build: `apps/web/dist/` and Tauri output under `target/` (generated and uncommitted)
- Capture: light- and dark-mode PNG screenshots in a temporary or artifact directory outside tracked source

**Interfaces:**

- Consumes: The Tauri build pipeline configured by `apps/desktop/src-tauri/tauri.conf.json` and the web theme preference control.
- Produces: Fresh command output plus light/dark desktop screenshots demonstrating equal focused/unfocused pane framing.

- [ ] **Step 1: Run required repository checks**

Run:

```bash
vp check
vp run typecheck
```

Expected: both commands exit 0 with no errors.

- [ ] **Step 2: Build the desktop application**

Run:

```bash
vp run build:desktop
```

Expected: the web assets and host-native Tauri application build successfully,
with a macOS `BiBCode.app` bundle under `target/release/bundle/`.

- [ ] **Step 3: Launch the worktree-built desktop bundle**

Resolve the exact bundle path read-only, then open that exact path:

```bash
find target/release/bundle -maxdepth 3 -type d -name BiBCode.app -print -quit
open target/release/bundle/macos/BiBCode.app
```

Expected: the desktop app launches and displays a workspace with at least two
center panes. If the persisted workspace has only one pane, use the existing
panel split UI without altering source or application settings beyond the
temporary test layout.

- [ ] **Step 4: Capture and inspect light mode**

Use the desktop theme preference to select `Light`, focus one pane, and capture
a PNG screenshot. Inspect both pane boundaries and confirm the focused pane has
no orange frame and matches the unfocused pane's neutral framing color.

- [ ] **Step 5: Capture and inspect dark mode**

Use the desktop theme preference to select `Dark`, focus the other pane, and
capture a PNG screenshot. Inspect both pane boundaries and confirm the focused
pane has no orange frame and matches the unfocused pane's neutral framing color.

- [ ] **Step 6: Perform final verification and scope review**

Run:

```bash
cd apps/web
vp test run --project unit src/components/CenterPanelSplitLayout.test.tsx
cd ../..
vp check
vp run typecheck
git diff HEAD^ --check
git status --short
```

Expected: the focused tests and repository gates pass, the diff is clean, and
only the approved spec, plan, test, and visual-only component change are
tracked. Generated build outputs and `.codegraph/` data remain untracked or
ignored.
