# Center Header Icon Rail Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compact center header's mixed bare/outlined icons with the approved uniform outlined icon rail without changing any action behavior.

**Architecture:** Add one stateless `CenterHeaderIconButton` presentation component backed by the existing Button primitive, then use it from the tab-overflow navigator and compact workspace-action owners. Keep navigation, menus, density, and callbacks in their current components; share only geometry and interaction chrome.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Base UI menus, Lucide icons, Vite+ tests, Tauri 2 desktop packaging.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-06-center-header-icon-rail-polish-design.md`.
- Use the user-selected Option 2: uniform outlined controls.
- Covered controls are Previous tabs, Next tabs, All tabs, New panel, and compact More workspace actions.
- Use one 28px desktop design-system size, one outlined variant, 16px icons, and a 4px rhythm.
- The shared outlined treatment must render correctly in light and dark themes through the existing Button tokens.
- Preserve the single tab/action boundary divider and the existing 8px right inset.
- Preserve all menus, callbacks, labels, tooltips, shortcuts, density switching, disabled states, and focus behavior.
- Do not redesign tabs, tab close, expanded project/editor actions, split-pane controls, terminal content, or right-panel controls.
- Do not change global Button styles, add dependencies, or edit `.repos/`.
- Use test-driven development and record the expected RED failure before production edits.
- `vp check` and `vp run typecheck` must pass before completion.
- Exact desktop-app interaction uses bundled Codex Computer Use, never Orca.

---

## File Responsibility Map

- Create `apps/web/src/components/CenterHeaderIconButton.tsx` — the only owner of center-header icon-button size/variant/marker.
- Create `apps/web/src/components/CenterHeaderIconButton.test.tsx` — shared presentation contract.
- Modify `apps/web/src/components/CenterPanelTabs.tsx` — consume the shared control for overflow navigation and normalize navigator spacing.
- Modify `apps/web/src/components/CenterPanelTabs.test.tsx` — prove the three overflow controls use the shared contract while preserving callbacks.
- Modify `apps/web/src/components/CenterPanelTabs.dom.test.tsx` — keep the mounted Base UI trigger harness compatible with render-prop triggers.
- Modify `apps/web/src/components/chat/ChatHeaderPanelMenu.tsx` — consume the shared control for New panel.
- Modify `apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx` — prove New panel uses the shared contract without changing menu behavior.
- Modify `apps/web/src/components/chat/ChatHeaderActions.tsx` — consume the shared control for compact overflow and normalize compact spacing only.
- Modify `apps/web/src/components/chat/ChatHeaderActions.render.test.tsx` — prove compact uniformity, expanded-spacing preservation, and inset preservation.
- Modify no lifecycle, store, protocol, terminal, or global style files.

---

### Task 1: Shared Header Control and Tab Overflow Navigator

**Files:**

- Create: `apps/web/src/components/CenterHeaderIconButton.tsx`
- Create: `apps/web/src/components/CenterHeaderIconButton.test.tsx`
- Modify: `apps/web/src/components/CenterPanelTabs.tsx:1-460`
- Modify: `apps/web/src/components/CenterPanelTabs.test.tsx:1-430`
- Modify: `apps/web/src/components/CenterPanelTabs.dom.test.tsx:1-145`

**Interfaces:**

- Consumes: `Button` from `apps/web/src/components/ui/button.tsx` and `ComponentProps<typeof Button>`.
- Produces:

```tsx
export type CenterHeaderIconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "size" | "variant"
>;

export function CenterHeaderIconButton(props: CenterHeaderIconButtonProps): ReactElement;
```

- Contract: always renders `Button size="icon-sm" variant="outline"` with `data-center-header-icon-control`; callers retain labels, titles, children, disabled state, and handlers.

- [ ] **Step 1: Write the failing shared presentation test**

Create `CenterHeaderIconButton.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CenterHeaderIconButton } from "./CenterHeaderIconButton";

describe("CenterHeaderIconButton", () => {
  it("owns the uniform outlined center-header geometry", () => {
    const markup = renderToStaticMarkup(
      <CenterHeaderIconButton aria-label="New panel">
        <svg aria-hidden="true" />
      </CenterHeaderIconButton>,
    );

    expect(markup).toContain('data-center-header-icon-control="true"');
    expect(markup).toContain("size-8 sm:size-7");
    expect(markup).toContain("border-input");
    expect(markup).toContain("bg-popover");
    expect(markup).toContain("focus-visible:ring-ring");
  });
});
```

- [ ] **Step 2: Run the shared presentation test and verify RED**

Run:

```bash
NODE_NO_WARNINGS=1 vp test \
  apps/web/src/components/CenterHeaderIconButton.test.tsx
```

Expected: FAIL because `CenterHeaderIconButton.tsx` does not exist.

- [ ] **Step 3: Implement the shared stateless presentation**

Create `CenterHeaderIconButton.tsx`:

```tsx
import type { ComponentProps, ReactElement } from "react";

import { Button } from "./ui/button";

export type CenterHeaderIconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "size" | "variant"
>;

export function CenterHeaderIconButton(
  props: CenterHeaderIconButtonProps,
): ReactElement {
  return (
    <Button
      {...props}
      data-center-header-icon-control
      size="icon-sm"
      variant="outline"
    />
  );
}
```

The fixed props follow `{...props}` so callers cannot override size, variant, or the semantic marker through an unsafe cast.

- [ ] **Step 4: Run the shared presentation test and verify GREEN**

Run:

```bash
NODE_NO_WARNINGS=1 vp test \
  apps/web/src/components/CenterHeaderIconButton.test.tsx
```

Expected: PASS with the existing Button primitive supplying the outlined state and design-system geometry.

- [ ] **Step 5: Extend the overflow navigator test before changing its production branch**

In `CenterPanelTabs.test.tsx`, mock the shared component so the existing manual tree visitor can inspect its contract without executing the Button hook:

```tsx
vi.mock("./CenterHeaderIconButton", () => ({
  CenterHeaderIconButton: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" data-center-header-icon-control {...props}>
      {children}
    </button>
  ),
}));
```

In both `CenterPanelTabs.test.tsx` and `CenterPanelTabs.dom.test.tsx`, make the menu-trigger mock preserve the current direct-button path and the planned Base UI render path:

```tsx
DropdownMenuTrigger: ({
  children,
  render,
  ...props
}: React.ComponentProps<"button"> & { render?: React.ReactNode }) =>
  render ? (
    <>
      {render}
      {children}
    </>
  ) : (
    <button {...props}>{children}</button>
  ),
```

Inside `shows overflow navigation only for an overflowing rail...`, after resolving `previous`, `next`, and `allTabs`, add:

```tsx
for (const control of [previous, next, allTabs]) {
  expect(
    (control?.props as Record<string, unknown> | undefined)?.[
      "data-center-header-icon-control"
    ],
  ).toBe(true);
}
expect(String(navigatorClassName)).toContain("gap-1");
expect(String(navigatorClassName)).toContain("border-l");
expect(String(navigatorClassName)).not.toContain("gap-0.5");
```

Keep the existing `scrollBy`, All tabs activation, labels, and overflow-state assertions unchanged.

- [ ] **Step 6: Run the overflow navigator test and verify RED**

Run:

```bash
NODE_NO_WARNINGS=1 vp test apps/web/src/components/CenterPanelTabs.test.tsx
```

Expected: FAIL because production still renders local bare buttons and `gap-0.5`, so the shared-control markers and uniform spacing assertions fail.

- [ ] **Step 7: Replace all three overflow controls with the shared component**

In `CenterPanelTabs.tsx`:

```tsx
import { CenterHeaderIconButton } from "./CenterHeaderIconButton";
```

Replace Previous and Next raw buttons:

```tsx
<CenterHeaderIconButton
  aria-label="Previous tabs"
  title="Previous tabs"
  onClick={() => scrollTabPage(-1)}
>
  <ChevronLeftIcon className="size-4" />
</CenterHeaderIconButton>
```

```tsx
<CenterHeaderIconButton
  aria-label="Next tabs"
  title="Next tabs"
  onClick={() => scrollTabPage(1)}
>
  <ChevronRightIcon className="size-4" />
</CenterHeaderIconButton>
```

Render All tabs through Base UI's existing render contract:

```tsx
<DropdownMenuTrigger
  render={
    <CenterHeaderIconButton aria-label="All tabs" title="All tabs" />
  }
>
  <Rows3Icon className="size-4" />
</DropdownMenuTrigger>
```

Change only the navigator wrapper rhythm:

```tsx
className="relative z-10 hidden shrink-0 items-center gap-1 border-l border-border/60 bg-background px-1 group-data-[overflow=true]/tabbar:flex"
```

Do not change overflow measurement, callbacks, popup content, or scroll behavior.

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run:

```bash
NODE_NO_WARNINGS=1 vp test \
  apps/web/src/components/CenterHeaderIconButton.test.tsx \
  apps/web/src/components/CenterPanelTabs.test.tsx \
  apps/web/src/components/CenterPanelTabs.dom.test.tsx
```

Expected: all tests PASS; the existing navigation callback assertions remain green.

- [ ] **Step 9: Run static gates for the scoped diff**

Run:

```bash
vp check
vp run typecheck
git diff --check
```

Expected: all commands exit 0; existing Effect Schema suggestions may remain informational.

- [ ] **Step 10: Commit Task 1**

```bash
git add \
  apps/web/src/components/CenterHeaderIconButton.tsx \
  apps/web/src/components/CenterHeaderIconButton.test.tsx \
  apps/web/src/components/CenterPanelTabs.tsx \
  apps/web/src/components/CenterPanelTabs.test.tsx \
  apps/web/src/components/CenterPanelTabs.dom.test.tsx
git commit -m "refactor(web): unify center tab navigation controls"
```

---

### Task 2: New Panel, Compact Overflow, and Uniform Rhythm

**Files:**

- Modify: `apps/web/src/components/chat/ChatHeaderPanelMenu.tsx:1-70`
- Modify: `apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx:1-230`
- Modify: `apps/web/src/components/chat/ChatHeaderActions.tsx:1-175`
- Modify: `apps/web/src/components/chat/ChatHeaderActions.render.test.tsx:1-490`

**Interfaces:**

- Consumes: `CenterHeaderIconButton` from Task 1 with no size/variant inputs.
- Produces: New panel and compact More workspace actions through the same `data-center-header-icon-control` contract as tab overflow navigation.
- Preserves: `ChatHeaderActionsProps`, `ChatHeaderPanelMenuProps`, menu contents, action controllers, and callback signatures unchanged.

- [ ] **Step 1: Add failing New panel contract coverage**

In `ChatHeaderPanelMenu.test.tsx`, replace the broad Button mock with a focused shared-control mock:

```tsx
vi.mock("../CenterHeaderIconButton", () => ({
  CenterHeaderIconButton: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" data-center-header-icon-control {...props}>
      {children}
    </button>
  ),
}));
```

In `renders enabled providers and terminal/custom actions`, add:

```tsx
expect(markup).toContain('aria-label="New panel"');
expect(markup).toContain('data-center-header-icon-control="true"');
```

Do not remove the existing menu order, divider count, callback, disabled-state, or provider-terminal assertions.

- [ ] **Step 2: Add failing compact overflow and spacing coverage**

In the hoisted harness in `ChatHeaderActions.render.test.tsx`, add:

```tsx
iconControlProps: [] as Array<Record<string, unknown>>,
```

Mock the shared control after the existing Button mock:

```tsx
vi.mock("../CenterHeaderIconButton", () => ({
  CenterHeaderIconButton: ({ children, ...props }: Record<string, unknown>) => {
    harness.iconControlProps.push(props);
    return (
      <button type="button" data-center-header-icon-control {...props}>
        {children as ReactNode}
      </button>
    );
  },
}));
```

Reset `harness.iconControlProps.length = 0` in `beforeEach`.

In `keeps New panel and one overflow trigger at compact density`, add:

```tsx
expect(harness.iconControlProps).toEqual([
  expect.objectContaining({ "aria-label": "More workspace actions" }),
]);
expect(markup).toContain('data-center-header-icon-control="true"');
expect(markup).toContain("gap-1");
```

In `keeps New panel and expanded controls at wide density`, add:

```tsx
expect(markup).toContain("gap-2");
expect(markup).toContain("@3xl/header-actions:gap-3");
```

Keep the existing density, controller-singleton, dialog persistence, shortcut, Git lifecycle, and inset assertions.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
NODE_NO_WARNINGS=1 vp test \
  apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx \
  apps/web/src/components/chat/ChatHeaderActions.render.test.tsx
```

Expected: FAIL because New panel and More workspace actions still instantiate `Button` directly, the shared-control harness records no usage, and compact headers still use `gap-2`.

- [ ] **Step 4: Move New panel to the shared control**

In `ChatHeaderPanelMenu.tsx`, replace the Button import with:

```tsx
import { CenterHeaderIconButton } from "../CenterHeaderIconButton";
```

Change the trigger only:

```tsx
<MenuTrigger render={<CenterHeaderIconButton aria-label="New panel" />}>
  <PlusIcon className="size-4" />
</MenuTrigger>
```

Keep the popup and all enabled/disabled menu branches unchanged.

- [ ] **Step 5: Move compact overflow to the shared control**

In `ChatHeaderActions.tsx`, import the shared presentation:

```tsx
import { CenterHeaderIconButton } from "../CenterHeaderIconButton";
```

Replace only the compact overflow trigger:

```tsx
<MenuTrigger render={<CenterHeaderIconButton aria-label="More workspace actions" />}>
  <MoreHorizontal className="size-4" />
</MenuTrigger>
```

Remove the now-unused Button import only if no other local branch uses it.

- [ ] **Step 6: Make spacing density-specific without changing the inset**

Change the `data-chat-header-actions` class composition to:

```tsx
className={cn(
  "@container/header-actions relative z-10 flex shrink-0 items-center justify-end bg-background [-webkit-app-region:no-drag]",
  density === "compact" ? "gap-1" : "gap-2 @3xl/header-actions:gap-3",
  reserveTitlebarControls ? "pr-[4.5rem]" : "pr-2",
)}
```

Do not change `pr-[4.5rem]`, `pr-2`, or the titlebar/no-drag safeguards.

- [ ] **Step 7: Run Task 2 tests and verify GREEN**

Run:

```bash
NODE_NO_WARNINGS=1 vp test \
  apps/web/src/components/CenterHeaderIconButton.test.tsx \
  apps/web/src/components/CenterPanelTabs.test.tsx \
  apps/web/src/components/CenterPanelTabs.dom.test.tsx \
  apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx \
  apps/web/src/components/chat/ChatHeaderActions.render.test.tsx
```

Expected: all tests PASS, including every pre-existing behavior assertion.

- [ ] **Step 8: Run static gates for the integrated UI diff**

Run:

```bash
vp check
vp run typecheck
git diff --check
```

Expected: all commands exit 0; existing Effect Schema suggestions may remain informational.

- [ ] **Step 9: Commit Task 2**

```bash
git add \
  apps/web/src/components/chat/ChatHeaderPanelMenu.tsx \
  apps/web/src/components/chat/ChatHeaderPanelMenu.test.tsx \
  apps/web/src/components/chat/ChatHeaderActions.tsx \
  apps/web/src/components/chat/ChatHeaderActions.render.test.tsx
git commit -m "fix(web): polish center header icon rail"
```

---

### Task 3: Integrated Review, Release Build, and Exact-App Visual QA

**Files:**

- Review: all files changed by Tasks 1-2.
- Evidence only: ignored `.superpowers/sdd/2026-08-06-center-header-icon-rail-polish/` and `.artifacts/visual-qa/center-header-icon-rail-polish/` paths.
- Do not modify tracked files unless review or verification exposes a real defect.

**Interfaces:**

- Consumes: the shared marker and fixed outlined presentation from Tasks 1-2.
- Produces: final review verdict, full verification evidence, exact `.app`/DMG artifacts, and compact/wide visual evidence.

- [ ] **Step 1: Run an independent integrated code review**

Review the design, this plan, and the complete base-to-HEAD diff. Audit:

- all five controls use the shared component;
- no covered local control retains a duplicate size/variant class list;
- only compact workspace-action spacing changes;
- the overflow divider and 8px inset remain;
- no menu/action/callback/shortcut behavior changes;
- tests would fail if any covered control stopped using the shared contract.

Expected: no Critical or Important findings. Route any finding back through a test-first fix and scoped re-review.

- [ ] **Step 2: Run the full repository test suite and fresh verification from final HEAD**

Run:

```bash
NODE_NO_WARNINGS=1 vp test
vp check
vp run typecheck
git diff --check
git status --short
```

Expected: all tests and required gates pass; tracked status is clean.

- [ ] **Step 3: Build the exact desktop release artifacts**

Run:

```bash
vp run build:desktop
```

Expected artifacts:

```text
target/release/bundle/macos/BiBCode.app
target/release/bundle/dmg/BiBCode_0.3.3_aarch64.dmg
```

Expected: build and local signing succeed; missing notarization credentials may produce the existing non-fatal warning.

- [ ] **Step 4: Validate the exact `.app` with bundled Codex Computer Use**

Use this exact path, never another installed BiBCode and never Orca:

```text
/Users/admin/.codex/worktrees/eccd/BibCode/target/release/bundle/macos/BiBCode.app
```

Open the persisted `codex/orange-theme-remove-terminal-drawer` thread. In the existing many-tab compact overflow state, verify visually and through the accessibility tree:

1. Previous tabs, Next tabs, All tabs, New panel, and More workspace actions retain their exact labels.
2. Every visible covered control has matching square geometry, outline, radius, icon scale, and 4px rhythm.
3. Only one divider separates the tab rail from the icon rail.
4. The right edge retains an 8px inset with no clipping or overlap.
5. Open and dismiss All tabs, New panel, and More workspace actions to confirm menus still work.
6. Capture a compact screenshot with the pointer moved away from the tab close button.

Then reduce tab overflow by selecting/closing only a temporary surface created for QA, or open a normal wide pane, and verify the non-overflow header remains aligned. Do not delete user-owned persisted tabs or sessions. Quit the exact QA app and confirm its process is stopped.

- [ ] **Step 5: Complete the requirement ledger**

Record:

- final commit hashes;
- focused and full test counts;
- `vp check`, typecheck, and diff-check results;
- review verdict;
- exact bundle paths and hashes;
- compact/wide Computer Use observations;
- confirmation that temporary QA state was cleaned up.

Expected: the design acceptance criteria have one explicit evidence item each and no unresolved findings remain.

---

## Completion Checklist

- [ ] Option 2 is implemented through one shared presentation component.
- [ ] All five covered controls share outlined geometry and interaction chrome.
- [ ] Compact spacing is 4px; expanded action spacing is unchanged.
- [ ] The single boundary divider and 8px right inset remain.
- [ ] Menus, callbacks, labels, shortcuts, density behavior, and focus behavior are unchanged.
- [ ] Focused tests, full tests, `vp check`, typecheck, and `git diff --check` pass.
- [ ] Independent final review is approved.
- [ ] The exact desktop app and DMG build successfully.
- [ ] Exact-app compact and wide Computer Use QA match the approved visual.
- [ ] Tracked worktree is clean and temporary QA state is removed.
