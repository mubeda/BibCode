# Activity Overlap Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove compact Activity-count collisions and the redundant Activity-tab tooltip, then prove the exact packaged UI at normal and narrow widths.

**Architecture:** `ActivityDock` remains the sole projection of canonical active/done counts and changes only its collapsed compact presentation from status glyphs to text. `RightPanelTabs` keeps tooltips for potentially truncated dynamic titles but renders the fixed visible Activity label directly without a duplicate popup. No Activity state, routing, cancellation, contract, or persistence boundary changes.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Base UI, lucide-react, Vite+, happy-dom, Tauri 2, Codex Computer Use.

## Global Constraints

- Keep exactly one provider icon in the collapsed Activity dock and one provider icon per roster row.
- Render collapsed compact counts as `Active <n> · Done <n>` with tabular numerals and no loader/check status glyphs.
- Remove only the redundant tooltip for the fixed visible Activity tab; preserve tooltips for dynamic/truncated surfaces.
- Preserve exact count saturation, stale-state accessibility, keyboard navigation, focus, tab activation, context menus, and cancellation behavior.
- Do not change contracts, RPC, persistence, client-runtime state, provider correlation, or server cancellation logic.
- Visual approval requires original-resolution plus zoomed crop inspection of rest, hover, focus, normal width, and narrow width.

---

## File Structure

- `apps/web/src/components/activity/ActivityDock.tsx` owns compact and expanded Activity dock presentation.
- `apps/web/src/components/activity/ActivityDock.test.tsx` owns real-DOM dock count/glyph assertions.
- `apps/web/src/components/RightPanelTabs.tsx` owns right-panel surface tabs and conditional title tooltips.
- `apps/web/src/components/RightPanelTabs.test.tsx` owns real-DOM tab label/icon/tooltip/activation assertions.
- `.superpowers/visual/2026-08-13-activity-overlap-polish/` stores ignored packaged-app evidence only; no evidence image is committed.

---

### Task 1: Replace Compact Count Glyphs with Text

**Files:**
- Modify: `apps/web/src/components/activity/ActivityDock.tsx:340-370`
- Test: `apps/web/src/components/activity/ActivityDock.test.tsx:700-745`

**Interfaces:**
- Consumes: existing sanitized `active: number`, `done: number`, `compact: boolean`, and the single `providerGlyph` React node.
- Produces: existing `data-activity-count="active"` and `data-activity-count="done"` spans with textual labels, plus a decorative separator.

- [ ] **Step 1: Write the failing compact-count DOM assertions**

Extend the compact dock test with a collapsed render and assert its visible structure:

```tsx
const collapsed = await mount(
  <ActivityDock {...props({ compact: true, expanded: false })} />,
);
const toggle = collapsed.querySelector<HTMLButtonElement>(
  'button[aria-label^="Expand activity summary"]',
);
expect(toggle?.querySelectorAll("[data-activity-provider-glyph]")).toHaveLength(1);
expect(toggle?.textContent).toContain("Active 2");
expect(toggle?.textContent).toContain("·");
expect(toggle?.textContent).toContain("Done 1");
expect(toggle?.querySelector(".lucide-loader-circle")).toBeNull();
expect(toggle?.querySelector(".lucide-circle-check-big")).toBeNull();
```

Use the fixture's actual default counts in the expected strings if they differ from `2` and `1`.

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
cd apps/web
vp test run --passWithNoTests src/components/activity/ActivityDock.test.tsx
```

Expected: FAIL because compact collapsed content contains bare numerals and loader/check-circle SVGs rather than `Active`, `Done`, and `·`.

- [ ] **Step 3: Implement the minimal compact presentation**

Replace only the collapsed `compact` fragment with:

```tsx
<>
  <span
    aria-hidden="true"
    className="whitespace-nowrap text-xs tabular-nums"
    data-activity-count="active"
  >
    Active {active}
  </span>
  <span aria-hidden="true" className="text-xs text-muted-foreground">
    ·
  </span>
  <span
    aria-hidden="true"
    className="whitespace-nowrap text-xs text-muted-foreground tabular-nums"
    data-activity-count="done"
  >
    Done {done}
  </span>
</>
```

Keep the button's existing `gap-2`, provider glyph, `aria-label`, sanitization, and non-compact branch unchanged. Do not remove loader/check imports while expanded compact section rows still use them.

- [ ] **Step 4: Run the focused dock suite to verify GREEN**

Run:

```bash
cd apps/web
vp test run --passWithNoTests src/components/activity/ActivityDock.test.tsx src/components/activity/ProviderTerminalActivityDock.test.tsx
```

Expected: all tests pass; collapsed compact dock has one provider glyph and no count glyphs.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/web/src/components/activity/ActivityDock.tsx \
  apps/web/src/components/activity/ActivityDock.test.tsx
git diff --cached --check
git commit -m "fix(activity): separate compact dock counts"
```

---

### Task 2: Remove the Redundant Activity Tab Tooltip

**Files:**
- Modify: `apps/web/src/components/RightPanelTabs.tsx:388-430`
- Test: `apps/web/src/components/RightPanelTabs.test.tsx:307-330`

**Interfaces:**
- Consumes: existing `surface: RightPanelSurface`, fixed `surface.kind === "activity"`, `title`, `SurfaceIcon`, and `onActivate(surface)`.
- Produces: the same tab button for all surfaces; only non-Activity surfaces are wrapped in `Tooltip`/`TooltipTrigger`/`TooltipPopup`.

- [ ] **Step 1: Write the failing Activity-tab regression**

Strengthen the existing Activity singleton test:

```tsx
const activityButton = buttonWithText("Activity");
expect(activityButton).toBeDefined();
expect(document.querySelector(".lucide-bot")).not.toBeNull();
expect(document.querySelector('[data-testid="tooltip"]')).toBeNull();
await click(activityButton);
expect(onActivate).toHaveBeenCalledWith(activitySurface);
```

Pass an explicit `onActivate` spy through `tabsProps`. Retain another existing dynamic-surface test that proves tooltip rendering still exists for truncated/dynamic titles.

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
cd apps/web
vp test run --passWithNoTests src/components/RightPanelTabs.test.tsx
```

Expected: FAIL because the mocked tooltip currently renders a tooltip node for Activity.

- [ ] **Step 3: Implement conditional tooltip rendering**

Build the common button once:

```tsx
const tabButton = (
  <button
    type="button"
    className="flex min-w-0 flex-1 items-center gap-1.5"
    onClick={() => props.onActivate(surface)}
  >
    <SurfaceIcon surface={surface} theme={resolvedTheme} />
    <span className="truncate">{title}</span>
  </button>
);
```

Render it directly for Activity and retain the existing tooltip for every other surface:

```tsx
{surface.kind === "activity" ? (
  tabButton
) : (
  <Tooltip>
    <TooltipTrigger render={tabButton} />
    <TooltipPopup>{title}</TooltipPopup>
  </Tooltip>
)}
```

Do not alter tab sizing, active styling, middle-click/context-menu handling, close buttons, or keyboard focus behavior.

- [ ] **Step 4: Run the focused right-panel suite to verify GREEN**

Run:

```bash
cd apps/web
vp test run --passWithNoTests src/components/RightPanelTabs.test.tsx \
  src/components/ActivitySurfaces.test.tsx
```

Expected: all tests pass; Activity has no tooltip node and remains activatable.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/web/src/components/RightPanelTabs.tsx \
  apps/web/src/components/RightPanelTabs.test.tsx
git diff --cached --check
git commit -m "fix(activity): remove redundant tab tooltip"
```

---

### Task 3: Verify Web Behavior and the Exact Packaged UI

**Files:**
- Verify: `apps/web/src/components/activity/ActivityDock.test.tsx`
- Verify: `apps/web/src/components/RightPanelTabs.test.tsx`
- Verify: `apps/web/src/components/ActivitySurfaces.test.tsx`
- Create ignored evidence: `.superpowers/visual/2026-08-13-activity-overlap-polish/*`

**Interfaces:**
- Consumes: Tasks 1-2 committed UI behavior and existing exact release bundle workflow.
- Produces: reproducible automated results plus original-resolution and zoomed visual evidence.

- [ ] **Step 1: Run focused and package checks**

```bash
cd apps/web
vp test run --passWithNoTests \
  src/components/activity/ActivityDock.test.tsx \
  src/components/activity/ProviderTerminalActivityDock.test.tsx \
  src/components/RightPanelTabs.test.tsx \
  src/components/ActivitySurfaces.test.tsx
cd ../..
vp run --filter @bibcode/web typecheck
vp check
vp run typecheck
git diff --check
git status --short
```

Expected: every command exits zero; only intentional committed paths differ from the pre-feature base.

- [ ] **Step 2: Build the exact release bundle**

Ensure no other build is running, then run:

```bash
vp run build:desktop
```

Resolve and record the exact bundle and executable paths under this worktree's `target/release/bundle/macos/BiBCode.app`.

- [ ] **Step 3: Relaunch exactly one worktree bundle**

Close only the previously recorded exact worktree bundle through Codex Computer Use or its normal application quit action. Confirm its exact executable is absent with `pgrep -fal` before using `open -n` on the rebuilt bundle. Confirm exactly one matching PID and record its full executable command. Never kill or launch an installed `/Applications` copy or another worktree.

- [ ] **Step 4: Capture the corrected states with Codex Computer Use**

Use `computer-use:computer-use`, never Orca. Capture to `.superpowers/visual/2026-08-13-activity-overlap-polish/`:

1. normal-width collapsed dock;
2. zoomed collapsed-dock crop showing one provider icon and `Active n · Done n`;
3. Activity tab at rest;
4. Activity tab hover with the Subagents heading unobscured;
5. Activity tab keyboard focus with the heading unobscured and full focus ring;
6. normal-width roster;
7. narrow-width sheet and collapsed dock.

- [ ] **Step 5: Inspect every image at original resolution and zoomed crops**

For each frame, explicitly verify:

- no icon/count, tooltip/heading, status/time, or action/status overlap;
- exactly one provider icon in the dock and per roster row;
- `Active`, separator, and `Done` remain visually distinct;
- no tooltip appears under Activity on hover or focus;
- focus rings are complete and not clipped;
- hierarchy connector, indentation, names, metadata, and actions remain legible;
- no raw provider-native ID is visible.

If any item fails, return to Task 1 or 2 and repeat the test-first cycle before claiming completion.

- [ ] **Step 6: Request final read-only review and commit any evidence-independent correction**

Provide the reviewer the spec, plan, final diff, automated outputs, exact bundle/PID, and screenshot paths. Critical or Important findings require one focused fix/re-review cycle. Do not commit `.superpowers/visual` evidence.
