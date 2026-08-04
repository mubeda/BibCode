# Chat Activity Dock — Web Dock and Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the floating, collapsible activity dock to AI chats and a read-only right-panel inspector for Subagents and Background Tasks.

**Architecture:** Keep activity data in the Plan 01 client atoms and keep navigation in two small UI stores. The dock renders a bounded summary for the current activity scope; selecting a section opens a singleton `activity` right-panel surface. The inspector queries roster/detail pages and never reconstructs lineage from conversation messages.

**Tech Stack:** React 19, TypeScript, Zustand, Effect Atom, Base UI, Tailwind, Lucide, Vitest, Testing Library.

## Prerequisites and Constraints

- Complete [01-activity-foundation.md](./01-activity-foundation.md) first.
- Read the approved design and [00-overview.md](./00-overview.md).
- The dock is hidden when capabilities and counts show no observable activity.
- Expansion preference is workspace-level UI state; selected section/record is thread-scoped right-panel state.
- The current chat or terminal scope is the only data source.
- The inspector is read-only in v1: no stop, retry, resume, message, or jump controls.
- Use semantic buttons, keyboard focus, live status text, and the existing right-panel sheet breakpoint.
- Do not add activity to the manual “add panel” menu; it opens from the dock.

---

## Task 1: Add the singleton activity surface to right-panel state

**Files:**

- Modify: `apps/web/src/rightPanelStore.ts`
- Modify: `apps/web/src/rightPanelStore.test.ts`
- Modify: `apps/web/src/components/RightPanelTabs.tsx`
- Modify: `apps/web/src/components/RightPanelTabs.test.tsx`

**Interfaces:**

- Produces: `ActivityRightPanelSurface` and `openActivity` / `navigateActivity` actions.
- Consumed by: Tasks 3–5.

- [ ] **Step 1: Write failing store tests**

Add tests proving:

1. `openActivity(ref, "subagents")` creates and activates exactly one `activity` surface;
2. calling it again for `backgroundTasks` changes the route without duplicating the tab;
3. `navigateActivity` can select and clear an actor or work item;
4. selection is cleared when the section changes;
5. a terminal scope persists only its terminal ID and remains distinct from the thread scope;
6. v8 persisted state migrates to v9 without changing existing surfaces; and
7. malformed persisted activity routes are discarded or normalized to the Subagents roster.

Use this expected descriptor:

```ts
expect(active).toEqual({
  id: "activity",
  kind: "activity",
  scope: { _tag: "thread" },
  section: "subagents",
  selectedRecordKind: null,
  selectedRecordId: null,
});
```

- [ ] **Step 2: Run the focused store test and verify the red state**

```bash
vp test run apps/web/src/rightPanelStore.test.ts
```

Expected: FAIL because `activity` and its actions are absent.

- [ ] **Step 3: Extend the discriminated union and store API**

Add `"activity"` to `RIGHT_PANEL_KINDS`, increment `RIGHT_PANEL_STORAGE_VERSION` from 8 to 9, and add:

```ts
export type ActivityRightPanelSurface = {
  id: "activity";
  kind: "activity";
  scope: { _tag: "thread" } | { _tag: "terminal"; terminalId: string };
  section: "subagents" | "backgroundTasks";
  selectedRecordKind: "actor" | "workItem" | null;
  selectedRecordId: string | null;
};
```

Extend `RightPanelSurface` with this type. Add actions with explicit inputs:

```ts
openActivity: (
  ref: ScopedThreadRef,
  section: ActivityRightPanelSurface["section"],
  scope?: ActivityRightPanelSurface["scope"],
) => void;
navigateActivity: (
  ref: ScopedThreadRef,
  route: Pick<
    ActivityRightPanelSurface,
    "section" | "selectedRecordKind" | "selectedRecordId"
  >,
) => void;
```

`openActivity` upserts the singleton and defaults `scope` to `{ _tag: "thread" }`.
Switching scope clears record selection. `navigateActivity` must do nothing if no
activity surface exists, so an old callback cannot silently reopen a closed panel.

Update exhaustive switches in `singletonSurface`, migration validation, and cleanup. Existing generic `open` / `toggle` types must exclude `activity`; only `openActivity` owns its route.

- [ ] **Step 4: Add the Activity tab presentation**

Write a failing `RightPanelTabs.test.tsx` case that passes an activity surface and expects an Activity label/icon, then update `surfaceTitle` and `SurfaceIcon` to use `Bot` from Lucide. Keep Activity out of `RightPanelEmptyState` and the plus menu.

- [ ] **Step 5: Run tests and commit**

```bash
vp test run apps/web/src/rightPanelStore.test.ts apps/web/src/components/RightPanelTabs.test.tsx
git add apps/web/src/rightPanelStore.ts apps/web/src/rightPanelStore.test.ts \
  apps/web/src/components/RightPanelTabs.tsx apps/web/src/components/RightPanelTabs.test.tsx
git commit -m "feat(activity): add right panel activity route"
```

Expected: PASS.

---

## Task 2: Add persisted dock expansion state and pure presentation helpers

**Files:**

- Create: `apps/web/src/activityDockStore.ts`
- Create: `apps/web/src/activityDockStore.test.ts`
- Create: `apps/web/src/components/activity/activityPresentation.ts`
- Create: `apps/web/src/components/activity/activityPresentation.test.ts`

**Interfaces:**

- Produces: `useActivityDockStore`, `selectActivityDockVisibility`, grouping/status/time helpers.
- Consumed by: Task 3 and Task 4.

- [ ] **Step 1: Write failing expansion-store tests**

Cover:

- default expanded state is `false`;
- state is keyed by `scopedProjectKey(scopeProjectRef(environmentId, projectId))`, never by thread ID;
- toggling one workspace does not affect another;
- corrupt persisted input returns defaults; and
- only the boolean preference is persisted.

Use storage key `bibcode:activity-dock-state:v1` and the existing
`scopedProjectKey(scopeProjectRef(environmentId, projectId))` helper as the
workspace-equivalent key.

- [ ] **Step 2: Write failing pure-presentation tests**

Define and test:

```ts
export interface ActivityDockVisibility {
  readonly visible: boolean;
  readonly showSubagents: boolean;
  readonly showBackgroundTasks: boolean;
}

export function selectActivityDockVisibility(
  snapshot: ActivitySnapshot | null,
): ActivityDockVisibility;

export function activityStatusLabel(status: ActivityLifecycle): string;
export function activityElapsedLabel(startedAt: string, now: string): string;
```

Required cases:

- null snapshot is hidden;
- an actor capability with a non-zero active or done count shows Subagents;
- `backgroundWork: false` plus section state `unsupported` hides Background Tasks even if a malformed count is non-zero;
- a stale Background Tasks section with retained records remains visible even after capability downgrade and does not mark Subagents stale;
- all-zero supported sections keep the dock hidden until a record has actually existed;
- `interrupted`, `failed`, and `cancelled` are distinct labels; and
- elapsed time clamps future timestamps to zero and never returns `NaN`.

- [ ] **Step 3: Verify red state**

```bash
vp test run apps/web/src/activityDockStore.test.ts \
  apps/web/src/components/activity/activityPresentation.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement the store and helpers**

Use Zustand persistence for this shape:

```ts
interface ActivityDockStoreState {
  expandedByProject: Record<string, boolean>;
  setExpanded: (projectKey: string, expanded: boolean) => void;
  toggleExpanded: (projectKey: string) => void;
}
```

Do not persist counts, routes, scope IDs, or provider payloads. Presentation helpers must be pure and exhaustive.

A section is visible only when its exact count is non-zero and either its
capability is currently true or its section health is `stale`/`error` with
retained records. `unsupported` never renders. This preserves inspectable
history after a capability downgrade without showing phantom sections.

- [ ] **Step 5: Run tests and commit**

```bash
vp test run apps/web/src/activityDockStore.test.ts \
  apps/web/src/components/activity/activityPresentation.test.ts
git add apps/web/src/activityDockStore.ts apps/web/src/activityDockStore.test.ts \
  apps/web/src/components/activity/activityPresentation.ts \
  apps/web/src/components/activity/activityPresentation.test.ts
git commit -m "feat(activity): add dock presentation state"
```

---

## Task 3: Build the floating activity dock

**Files:**

- Create: `apps/web/src/components/activity/ActivityDock.tsx`
- Create: `apps/web/src/components/activity/ActivityDock.test.tsx`

**Interfaces:**

- Inputs: snapshot, connection phase, expansion state, `onOpenSection`.
- Output: a purely presentational floating dock.
- Consumed by: Task 5.

- [ ] **Step 1: Write failing component tests**

The tests must cover:

- no DOM when visibility is false;
- collapsed mode shows provider glyphs plus total active/done count;
- expanded mode shows independent `Subagents` and `Background tasks` buttons;
- each section exposes active/done counts and calls `onOpenSection` with the exact section;
- opening a section first calls `onExpandedChange(false)` so the summary collapses as the inspector opens;
- reconnecting/stale state keeps last counts and exposes `aria-label="Activity data stale"`;
- toggle has `aria-expanded` and an accessible name;
- Escape collapses the expanded summary without closing the surrounding panel;
- Tab/Enter/Space work through native buttons;
- status updates use one polite live region without repeatedly announcing elapsed time; and
- at a 700px test viewport the detailed labels are replaced by compact icons/counts.

Use a fixed `now` prop in tests; do not make fake timers part of every assertion.

- [ ] **Step 2: Run the component test and verify the red state**

```bash
vp test run apps/web/src/components/activity/ActivityDock.test.tsx
```

Expected: FAIL because `ActivityDock` does not exist.

- [ ] **Step 3: Implement the dock component**

Use this bounded prop surface:

```ts
export interface ActivityDockProps {
  readonly snapshot: ActivitySnapshot;
  readonly expanded: boolean;
  readonly compact: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onOpenSection: (section: ActivitySection) => void;
  readonly now?: string;
}
```

Layout requirements:

- `position: absolute; top: 12px; right: 12px; z-index` above the timeline but below modal overlays;
- use the app surface/background/border tokens, not hard-coded light colors;
- 36px minimum control size and visible focus rings;
- collapsed width is content-bounded; expanded width is no more than 288px;
- use `pointer-events-none` on the placement wrapper and `pointer-events-auto` on the card;
- labels truncate, counts do not wrap; and
- the dock never obscures the composer because it is anchored to the scroll/timeline wrapper.

Show at most four provider/actor glyphs in collapsed mode followed by a `+N` text count. Do not animate count changes. A short opacity/width transition must obey `prefers-reduced-motion`.

- [ ] **Step 4: Verify and commit**

```bash
vp test run apps/web/src/components/activity/ActivityDock.test.tsx
git add apps/web/src/components/activity/ActivityDock.tsx \
  apps/web/src/components/activity/ActivityDock.test.tsx
git commit -m "feat(activity): build floating activity dock"
```

---

## Task 4: Build roster and record-detail inspector views

**Files:**

- Create: `apps/web/src/components/activity/ActivityPanel.tsx`
- Create: `apps/web/src/components/activity/ActivityPanel.test.tsx`
- Create: `apps/web/src/components/activity/ActivityRoster.tsx`
- Create: `apps/web/src/components/activity/ActivityRecordDetail.tsx`
- Create: `apps/web/src/components/activity/ActivityEntryRow.tsx`

**Interfaces:**

- Inputs: activity surface route, snapshot, roster/detail query results, navigation/load-more callbacks.
- Output: read-only Activity right-panel content.
- Consumed by: Task 5 and Plan 06 terminal integration.

- [ ] **Step 1: Write failing roster tests**

Test the `ActivityPanel` public boundary with stubbed query results:

- Subagents roster divides records into `Active` and `Done · N`;
- Background Tasks roster uses work items only;
- active rows order oldest-started first; done rows order newest-terminal first;
- a row shows provider/type glyph, name, safe summary, status, and elapsed/completed time;
- selecting a row invokes `{ section, selectedRecordKind, selectedRecordId }`;
- `hasMore` renders one load-more button and appends the next page without duplicates;
- stale state remains inspectable with a non-blocking banner;
- a section-specific stale/error banner appears only for the routed section and its retry affordance refreshes the snapshot;
- provider/stream failure has retry text but does not discard the last page; and
- no-results text distinguishes unsupported from observed-but-empty.

- [ ] **Step 2: Write failing detail tests**

Cover:

- Back returns to the same section roster;
- heading includes name, type, lifecycle, provider, start and end time;
- parent actor is a navigable relation only when present in the current scope;
- commentary, tool, command, state, and error entries have distinct labels/icons;
- command text is rendered as text, never HTML;
- 16KiB detail text is collapsible and does not expand by default;
- pagination preserves chronological ordering and de-duplicates by entry ID;
- focus moves to the detail heading after row selection and back to the row after Back; and
- record removal during inspection returns to roster with a polite message.

- [ ] **Step 3: Verify red state**

```bash
vp test run apps/web/src/components/activity/ActivityPanel.test.tsx
```

Expected: FAIL because the inspector modules do not exist.

- [ ] **Step 4: Implement the inspector hierarchy**

`ActivityPanel` owns route-to-query wiring only. `ActivityRoster` and `ActivityRecordDetail` remain controlled and receive decoded contracts. Use `ScrollArea` and the existing loading/error primitives.

Do not place raw JSON, hidden chain-of-thought, provider auth data, full environment variables, or unbounded command output in the inspector. Render only the normalized `ActivityEntry` title/detail fields from Plan 01.

Use a virtualized or windowed list once more than 100 rows are loaded. If the repository has no shared windowing package, render pages in bounded groups and keep a maximum of 200 roster rows and 200 entries in memory, matching the contract.

- [ ] **Step 5: Verify and commit**

```bash
vp test run apps/web/src/components/activity/ActivityPanel.test.tsx
git add apps/web/src/components/activity/ActivityPanel.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/activity/ActivityRoster.tsx \
  apps/web/src/components/activity/ActivityRecordDetail.tsx \
  apps/web/src/components/activity/ActivityEntryRow.tsx
git commit -m "feat(activity): add activity roster and detail inspector"
```

---

## Task 5: Integrate the dock and inspector into `ChatView`

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ChatView.logic.test.ts`

**Interfaces:**

- Consumes: Plan 01 activity atoms and Tasks 1–4.
- Produces: the approved current-chat activity experience.

- [ ] **Step 1: Write failing integration tests**

Extend `ChatView.test.tsx` with a controllable activity-state test harness and prove:

1. a regular unsupported provider chat has no dock;
2. a Codex snapshot with one active actor displays the dock;
3. clicking Subagents opens the singleton activity surface and roster;
4. clicking a roster item displays its detail without changing the chat route;
5. switching threads selects the new thread scope and does not leak the old roster;
6. reconnect retains the dock with stale styling;
7. closing Activity closes the surface but not the durable subscription for the visible dock; and
8. compact desktop width uses the existing right-panel sheet and preserves Back behavior.

- [ ] **Step 2: Verify red state**

```bash
vp test run apps/web/src/components/ChatView.test.tsx \
  apps/web/src/components/ChatView.logic.test.ts
```

Expected: FAIL because ChatView does not consume activity state.

- [ ] **Step 3: Bind the current thread scope**

Derive exactly one `ActivityScopeRef` from `activeThreadRef` and the activity
surface route. The chat dock opens the default thread route:

```ts
const activityScope = activeThreadRef
  ? { _tag: "thread" as const, threadId: activeThreadRef.threadId }
  : null;
```

Use the environment activity atom for that scope. Do not scan `messages`, `threadActivities`, or `task.started` events. Keep stale snapshots rendered while connection state changes.

- [ ] **Step 4: Mount the dock and inspector**

Mount `ActivityDock` inside the relative chat/timeline wrapper, immediately above the timeline content so its absolute placement follows the chat column. Pass `openActivity(activeThreadRef, section)` to section clicks.

Add the activity branch before generic file branches in `rightPanelContent`:

```tsx
activeRightPanelSurface?.kind === "activity" ? (
  <ActivityPanel
    scope={resolveActivityScope(activeThreadRef, activeRightPanelSurface.scope)}
    surface={activeRightPanelSurface}
    onNavigate={(route) =>
      rightPanelActions.navigateActivity(activeThreadRef, route)
    }
  />
) : // existing branches
```

The same content already flows through inline panel or `RightPanelSheet`; do not create a separate activity modal.

- [ ] **Step 5: Verify UI behavior and type exhaustiveness**

```bash
vp test run apps/web/src/rightPanelStore.test.ts \
  apps/web/src/components/activity/activityPresentation.test.ts \
  apps/web/src/components/activity/ActivityDock.test.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/RightPanelTabs.test.tsx \
  apps/web/src/components/ChatView.test.tsx
vp run --filter @bibcode/web typecheck
```

Expected: PASS with no non-exhaustive `RightPanelSurface` switches.

- [ ] **Step 6: Commit ChatView integration**

```bash
git add apps/web/src/components/ChatView.tsx \
  apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.logic.test.ts
git commit -m "feat(activity): integrate chat activity dock"
```

---

## Plan 02 Verification

- [ ] Run the complete web slice:

```bash
vp test run apps/web/src/activityDockStore.test.ts \
  apps/web/src/rightPanelStore.test.ts \
  apps/web/src/components/activity/activityPresentation.test.ts \
  apps/web/src/components/activity/ActivityDock.test.tsx \
  apps/web/src/components/activity/ActivityPanel.test.tsx \
  apps/web/src/components/RightPanelTabs.test.tsx \
  apps/web/src/components/ChatView.test.tsx
vp run --filter @bibcode/web typecheck
```

- [ ] Manually verify at wide, medium, and narrow widths:

  - the dock starts at the top-right of the chat timeline;
  - collapsed/expanded state survives a reload in the same workspace;
  - the right panel becomes the existing sheet at its normal breakpoint;
  - every control is keyboard reachable with a visible focus ring;
  - unsupported and truly empty sessions have no dock; and
  - no dock interaction mutates a provider or background task.
