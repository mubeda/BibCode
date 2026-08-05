# Center Panel Split Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn BiBCode's flat center tab rail into a persisted, resizable workspace of up to four nested tab groups with drag/drop relocation and layout-only context actions.

**Architecture:** Keep `CenterSurface` descriptors separate from a pure recursive split-tree model whose leaf groups own tab order and active selection. A center workspace component composes group chrome, drag/drop, resizing, and a flat surface-host layer so moving a visible chat or terminal does not change its React ancestry or terminate its resource. `ChatView` remains the resource-lifecycle and host-composition boundary.

**Tech Stack:** React 19, TypeScript, Zustand persistence, `@dnd-kit/core`, `@dnd-kit/sortable`, Tailwind CSS, Base UI menus, Vite+ tests, Tauri 2, Codex Computer Use.

## Global Constraints

- Support nested horizontal and vertical center layouts with at most four visible pane groups.
- Center-level tab grouping is in scope; terminal-internal splitting remains owned by the existing bottom terminal drawer and right-panel terminal system.
- Add layout actions only. Do not add tab pinning, custom titles, tab colors, or terminal-internal split entries.
- Each pane owns its tab order and active surface; one focused pane receives new surfaces and displays `ChatHeaderActions`.
- `Close Split Pane` merges tabs into its sibling destination without deleting chats or closing terminals.
- Existing close commands are group-local and retain explicit sibling-chat deletion and terminal-session shutdown.
- Keep the host chat mounted while inactive. Keep currently visible surface component identity stable across cross-group moves.
- Use the existing `@dnd-kit/*` packages and native nested context-menu contract; add no docking framework or production dependency.
- Initial split ratio is `0.5`; resize bounds are 15–85 percent where space permits, with 240-pixel horizontal and 160-pixel vertical target minimums.
- A new split is disabled when its target cannot host both children or its final atomic state would exceed four groups.
- Keep the existing `bibcode:center-panel-state:v1` storage key; advance only its persisted schema version and migrate current flat entries without losing valid surface metadata or host-closed/explicit-empty state.
- Do not change server protocols, Rust code, the right-panel model, or bottom-terminal behavior.
- Use test-driven development for every behavior change.
- Completion requires focused tests, `vp check`, `vp run typecheck`, a production desktop build, and desktop interaction verification.

---

## File Structure

- Create `apps/web/src/centerPanelLayout.ts`: pure layout types, validation, tree traversal/edge discovery, tab moves, split insertion, group merge/collapse, removals, and ratio updates.
- Create `apps/web/src/centerPanelLayout.test.ts`: exhaustive pure model, cap, no-op, and malformed-state tests.
- Modify `apps/web/src/centerPanelStore.ts`: persist surfaces plus groups/layout/focus, migrate flat state, expose atomic group-aware actions, and return removed surfaces from close operations.
- Modify `apps/web/src/centerPanelStore.test.ts`: cover legacy migration, focused creation, group-local close behavior, split moves, merging, ratios, and persistence repair.
- Modify `apps/web/src/centerPanelActions.ts`: route group-aware close results through one resource-cleanup path.
- Modify `apps/web/src/centerPanelActions.test.ts`: prove layout operations preserve resources and explicit closes clean only the returned surfaces.
- Create `apps/web/src/components/centerPanelDnd.ts`: drag metadata guards, edge geometry, insertion calculation, and final drop-intent resolution.
- Create `apps/web/src/components/centerPanelDnd.test.ts`: deterministic geometry and intent tests.
- Modify `apps/web/src/components/CenterPanelTabs.tsx`: render one group, register sortable tabs, and add the nested `Move Tab to Split` context submenu.
- Modify `apps/web/src/components/CenterPanelTabs.test.tsx`: cover group-local callbacks, submenu enablement, and drag metadata while preserving current interactions.
- Modify `apps/web/src/components/CenterPanelTabs.dom.test.tsx`: preserve per-group overflow measurement and DOM navigation behavior.
- Create `apps/web/src/components/CenterPanelSurfaceHosts.tsx`: body-target registry and flat keyed host layer.
- Create `apps/web/src/components/CenterPanelSurfaceHosts.test.tsx`: verify geometry, visibility, and mounted identity across relocation.
- Create `apps/web/src/components/CenterPanelSplitLayout.tsx`: recursive pane/group renderer, focus chrome, pane menu, droppable targets, and accessible resize handles.
- Create `apps/web/src/components/CenterPanelSplitLayout.test.tsx`: recursive rendering, focus, pane merge, and resize tests.
- Create `apps/web/src/components/CenterPanelWorkspace.tsx`: shared DnD context, drag overlay, target snapshots, drop dispatch, split preview, and composition of layout plus hosts.
- Create `apps/web/src/components/CenterPanelWorkspace.test.tsx`: drag lifecycle, preview, cancellation, group limit, and stable composition tests.
- Modify `apps/web/src/components/chat/ChatHeaderActions.tsx`: reserve root layout-control space only when actions occupy the top-right pane.
- Modify `apps/web/src/components/chat/ChatHeaderActions.render.test.tsx`: cover explicit title-bar control reservation.
- Modify `apps/web/src/components/CenterTerminalPanel.tsx`: remove the obsolete statement that center groups are out of scope; keep single-terminal ownership unchanged.
- Modify `apps/web/src/components/CenterTerminalPanel.test.tsx`: verify center layout integration does not expose terminal-internal split controls.
- Modify `apps/web/src/components/ChatView.tsx`: compose `CenterPanelWorkspace`, render focused actions, route creation/activation/cleanup by group, and supply stable chat/terminal surface bodies.
- Modify `apps/web/src/components/ChatView.test.tsx`: cover workspace composition, empty root, focused action placement, and visible surface rendering.
- Modify `apps/web/src/components/ChatView.hooks.test.tsx`: cover exact terminal/chat cleanup, focus-routed creation, and layout-only moves.
- Modify `docs/user/workspace-ui.md`: document split creation, focus, resizing, pane limit, persistence, and non-destructive pane closing.

---

### Task 1: Build the pure center layout algebra

**Files:**
- Create: `apps/web/src/centerPanelLayout.ts`
- Create: `apps/web/src/centerPanelLayout.test.ts`

**Interfaces:**
- Consumes: surface IDs as opaque strings; no React, Zustand, or `CenterSurface` dependency.
- Produces: `CenterPanelGroup`, `CenterPanelLayoutNode`, `CenterPanelLayoutState`, `CenterPanelSplitDirection`, `CenterPanelDropRequest`, `CenterPanelDropTarget`, `createCenterPanelLayoutState`, `repairCenterPanelLayoutState`, `insertCenterPanelSurface`, `canDropCenterPanelSurface`, `dropCenterPanelSurface`, `removeCenterPanelSurfaceIds`, `mergeCenterPanelGroup`, `setCenterPanelSplitRatio`, `findCenterPanelGroup`, `findCenterPanelGroupForSurface`, `findCenterPanelGroupEdges`, and `collectCenterPanelLeafIds`.

- [ ] **Step 1: Write failing tests for split direction, ordering, nesting, and the pane limit**

Create the test file with deterministic group IDs:

```ts
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_CENTER_PANEL_GROUPS,
  collectCenterPanelLeafIds,
  createCenterPanelLayoutState,
  dropCenterPanelSurface,
} from "./centerPanelLayout";

describe("centerPanelLayout", () => {
  it("moves a tab into a right split and then nests a down split", () => {
    const root = createCenterPanelLayoutState(["host", "chat-a", "term-a"], "host");
    const right = dropCenterPanelSurface(root, "chat-a", {
      groupId: "center:root",
      splitDirection: "right",
      newGroupId: "group-right",
    });
    expect(right.changed).toBe(true);
    expect(right.state.layout).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", groupId: "center:root" },
      second: { type: "leaf", groupId: "group-right" },
    });

    const down = dropCenterPanelSurface(right.state, "term-a", {
      groupId: "group-right",
      splitDirection: "down",
      newGroupId: "group-down",
    });
    expect(collectCenterPanelLeafIds(down.state.layout)).toEqual([
      "center:root",
      "group-right",
      "group-down",
    ]);
    expect(down.state.groups.find((group) => group.id === "group-down")?.surfaceIds).toEqual([
      "term-a",
    ]);
  });

  it("rejects a fifth final group but allows a four-to-four relocation", () => {
    let state = createCenterPanelLayoutState(["a", "b", "c", "d", "e"], "a");
    for (const [surfaceId, groupId] of [
      ["b", "g2"],
      ["c", "g3"],
      ["d", "g4"],
    ] as const) {
      state = dropCenterPanelSurface(state, surfaceId, {
        groupId: "center:root",
        splitDirection: "right",
        newGroupId: groupId,
      }).state;
    }
    expect(state.groups).toHaveLength(MAX_CENTER_PANEL_GROUPS);
    expect(
      dropCenterPanelSurface(state, "e", {
        groupId: "center:root",
        splitDirection: "left",
        newGroupId: "g5",
      }).changed,
    ).toBe(false);

    const relocated = dropCenterPanelSurface(state, "b", {
      groupId: "g3",
      splitDirection: "down",
      newGroupId: "g2-relocated",
    });
    expect(relocated.changed).toBe(true);
    expect(relocated.state.groups).toHaveLength(MAX_CENTER_PANEL_GROUPS);
  });
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
vp test apps/web/src/centerPanelLayout.test.ts
```

Expected: FAIL because `centerPanelLayout.ts` does not exist.

- [ ] **Step 3: Define the model and recursive tree helpers**

Create `centerPanelLayout.ts` with this public contract and private recursion:

```ts
export const MAX_CENTER_PANEL_GROUPS = 4;
export const CENTER_PANEL_ROOT_GROUP_ID = "center:root";
export const MIN_CENTER_PANEL_SPLIT_RATIO = 0.15;
export const MAX_CENTER_PANEL_SPLIT_RATIO = 0.85;

export type CenterPanelSplitDirection = "left" | "right" | "up" | "down";
export type CenterPanelLayoutDirection = "horizontal" | "vertical";
export type CenterPanelLayoutPathSegment = "first" | "second";
export type CenterPanelLayoutPath = readonly CenterPanelLayoutPathSegment[];

export interface CenterPanelGroup {
  readonly id: string;
  readonly surfaceIds: readonly string[];
  readonly activeSurfaceId: string | null;
}

export type CenterPanelLayoutNode =
  | { readonly type: "leaf"; readonly groupId: string }
  | {
      readonly type: "split";
      readonly direction: CenterPanelLayoutDirection;
      readonly first: CenterPanelLayoutNode;
      readonly second: CenterPanelLayoutNode;
      readonly ratio: number;
    };

export interface CenterPanelLayoutState {
  readonly groups: readonly CenterPanelGroup[];
  readonly layout: CenterPanelLayoutNode;
  readonly focusedGroupId: string;
}

export type CenterPanelDropRequest =
  | { readonly groupId: string; readonly index?: number }
  | { readonly groupId: string; readonly splitDirection: CenterPanelSplitDirection };

export type CenterPanelDropTarget =
  | { readonly groupId: string; readonly index?: number }
  | {
      readonly groupId: string;
      readonly splitDirection: CenterPanelSplitDirection;
      readonly newGroupId: string;
    };

export interface CenterPanelLayoutMutation {
  readonly state: CenterPanelLayoutState;
  readonly changed: boolean;
}

export function canDropCenterPanelSurface(
  current: CenterPanelLayoutState,
  surfaceId: string,
  request: CenterPanelDropRequest,
): boolean;

export function insertCenterPanelSurface(
  current: CenterPanelLayoutState,
  surfaceId: string,
  groupId?: string,
): CenterPanelLayoutMutation;

function splitOrientation(direction: CenterPanelSplitDirection): CenterPanelLayoutDirection {
  return direction === "left" || direction === "right" ? "horizontal" : "vertical";
}

function replaceLeaf(
  node: CenterPanelLayoutNode,
  groupId: string,
  replacement: CenterPanelLayoutNode,
): CenterPanelLayoutNode {
  if (node.type === "leaf") return node.groupId === groupId ? replacement : node;
  return {
    ...node,
    first: replaceLeaf(node.first, groupId, replacement),
    second: replaceLeaf(node.second, groupId, replacement),
  };
}

function removeLeaf(
  node: CenterPanelLayoutNode,
  groupId: string,
): CenterPanelLayoutNode | null {
  if (node.type === "leaf") return node.groupId === groupId ? null : node;
  const first = removeLeaf(node.first, groupId);
  const second = removeLeaf(node.second, groupId);
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

export function collectCenterPanelLeafIds(node: CenterPanelLayoutNode): string[] {
  return node.type === "leaf"
    ? [node.groupId]
    : [...collectCenterPanelLeafIds(node.first), ...collectCenterPanelLeafIds(node.second)];
}

export interface CenterPanelGroupEdges {
  readonly top: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
  readonly left: boolean;
}

export function findCenterPanelGroupEdges(
  layout: CenterPanelLayoutNode,
  groupId: string,
): CenterPanelGroupEdges | null {
  const walk = (
    node: CenterPanelLayoutNode,
    edges: CenterPanelGroupEdges,
  ): CenterPanelGroupEdges | null => {
    if (node.type === "leaf") return node.groupId === groupId ? edges : null;
    if (node.direction === "horizontal") {
      return (
        walk(node.first, { ...edges, right: false }) ??
        walk(node.second, { ...edges, left: false })
      );
    }
    return (
      walk(node.first, { ...edges, bottom: false }) ??
      walk(node.second, { ...edges, top: false })
    );
  };
  return walk(layout, { top: true, right: true, bottom: true, left: true });
}
```

Add `findCenterPanelGroup`, `findCenterPanelGroupForSurface`, a sibling-subtree lookup that selects the first depth-first leaf, and helpers that repair dangling active/focused IDs without importing application state.

- [ ] **Step 4: Implement atomic split/move/collapse semantics**

Implement `dropCenterPanelSurface` around these exact gates and ordering rules:

```ts
export function dropCenterPanelSurface(
  current: CenterPanelLayoutState,
  surfaceId: string,
  target: CenterPanelDropTarget,
): CenterPanelLayoutMutation {
  const source = findCenterPanelGroupForSurface(current, surfaceId);
  const destination = findCenterPanelGroup(current, target.groupId);
  if (!source || !destination) return { state: current, changed: false };

  const splitDirection = "splitDirection" in target ? target.splitDirection : null;
  if (
    splitDirection !== null &&
    current.groups.some((group) => group.id === target.newGroupId)
  ) {
    return { state: current, changed: false };
  }
  const sourceWillEmpty = source.surfaceIds.length === 1;
  if (splitDirection !== null && source.id === destination.id && sourceWillEmpty) {
    return { state: current, changed: false };
  }
  const finalGroupCount = current.groups.length + (splitDirection === null ? 0 : 1) -
    (sourceWillEmpty && source.id !== destination.id ? 1 : 0);
  if (finalGroupCount > MAX_CENTER_PANEL_GROUPS) {
    return { state: current, changed: false };
  }

  // Remove the source leaf first when its last tab moves to another group. This
  // lets a split of its sibling replace the already-collapsed target leaf.
  let layout = sourceWillEmpty && source.id !== destination.id
    ? (removeLeaf(current.layout, source.id) ?? current.layout)
    : current.layout;
  let destinationId = destination.id;
  let groups = current.groups
    .filter((group) => !(sourceWillEmpty && group.id === source.id))
    .map((group) =>
      group.id === source.id
        ? {
            ...group,
            surfaceIds: group.surfaceIds.filter((id) => id !== surfaceId),
            activeSurfaceId: fallbackActiveSurface(group, surfaceId),
          }
        : group,
    );

  if (splitDirection !== null) {
    destinationId = target.newGroupId;
    const newLeaf = { type: "leaf", groupId: destinationId } as const;
    const oldLeaf = { type: "leaf", groupId: destination.id } as const;
    layout = replaceLeaf(layout, destination.id, {
      type: "split",
      direction: splitOrientation(splitDirection),
      ratio: 0.5,
      first: splitDirection === "left" || splitDirection === "up" ? newLeaf : oldLeaf,
      second: splitDirection === "left" || splitDirection === "up" ? oldLeaf : newLeaf,
    });
    groups = [...groups, { id: destinationId, surfaceIds: [], activeSurfaceId: null }];
  }

  groups = groups.map((group) => {
    if (group.id !== destinationId) return group;
    const withoutMoved = group.surfaceIds.filter((id) => id !== surfaceId);
    const index = "index" in target
      ? Math.max(0, Math.min(target.index ?? withoutMoved.length, withoutMoved.length))
      : withoutMoved.length;
    const surfaceIds = [...withoutMoved];
    surfaceIds.splice(index, 0, surfaceId);
    return { ...group, surfaceIds, activeSurfaceId: surfaceId };
  });
  return { state: { groups, layout, focusedGroupId: destinationId }, changed: true };
}
```

Keep `fallbackActiveSurface` neighbor-based: if the removed surface was active, select the item now occupying its old index, otherwise the preceding item, otherwise `null`. Return the original object for invalid targets and exact no-ops.

Extract the source, destination, self-split, and final-group-count checks into a
private `validateCenterPanelDrop` helper used by both
`canDropCenterPanelSurface` and `dropCenterPanelSurface`; the latter adds only
the generated-group-ID uniqueness check. This keeps preview/menu enablement and
the final mutation on exactly the same legality path without allocating a group
ID during validation.
Implement `insertCenterPanelSurface` by reactivating and focusing the existing
owning group when the surface ID is already present. For a new ID, select the
requested valid group or `focusedGroupId`, append and activate the ID, and focus
that group. Before returning from
`dropCenterPanelSurface`, compare the resulting orders, activation, focus, and
layout to the input so a same-index drop that changes nothing preserves the
original object.

- [ ] **Step 5: Write failing tests for removals, deterministic pane merge, repair, and ratios**

Add cases that assert:

```ts
it("merges into the direct sibling or first depth-first leaf without losing tabs", () => {
  const result = mergeCenterPanelGroup(nestedState, "focused-source");
  expect(result.changed).toBe(true);
  expect(result.destinationGroupId).toBe("first-leaf-in-sibling-subtree");
  expect(findCenterPanelGroup(result.state, result.destinationGroupId!)?.surfaceIds).toEqual([
    "destination-existing",
    "source-first",
    "source-active",
  ]);
  expect(findCenterPanelGroup(result.state, result.destinationGroupId!)?.activeSurfaceId).toBe(
    "source-active",
  );
});

it("repairs duplicate leaves, orphaned surfaces, excess groups, and invalid ratios", () => {
  const repaired = repairCenterPanelLayoutState(malformedPersistedLayout, [
    "host",
    "chat-a",
    "term-a",
    "term-b",
    "term-c",
  ], "chat-a");
  expect(new Set(repaired.groups.flatMap((group) => group.surfaceIds))).toEqual(
    new Set(["host", "chat-a", "term-a", "term-b", "term-c"]),
  );
  expect(repaired.groups).toHaveLength(4);
  expect(collectCenterPanelLeafIds(repaired.layout)).toEqual(
    repaired.groups.map((group) => group.id),
  );
});

it("clamps a ratio update and preserves identity for an invalid path", () => {
  expect(setCenterPanelSplitRatio(splitState, [], 0.01).state.layout).toMatchObject({ ratio: 0.15 });
  expect(setCenterPanelSplitRatio(splitState, ["first"], 0.7)).toEqual({
    state: splitState,
    changed: false,
  });
});

it("derives outer edges for nested groups", () => {
  expect(findCenterPanelGroupEdges(nestedState.layout, "left-full-height")).toEqual({
    top: true,
    right: false,
    bottom: true,
    left: true,
  });
  expect(findCenterPanelGroupEdges(nestedState.layout, "right-bottom")).toEqual({
    top: false,
    right: true,
    bottom: true,
    left: false,
  });
});
```

Define `nestedState` and `malformedPersistedLayout` in the fixture with literal groups/tree nodes so the expected sibling and repair order are explicit.

- [ ] **Step 6: Run the focused tests and verify they fail**

Run:

```bash
vp test apps/web/src/centerPanelLayout.test.ts -t "merges|repairs|ratio"
```

Expected: FAIL because merge, repair, removal, and ratio functions are missing.

- [ ] **Step 7: Implement removal, merge, repair, and ratio updates**

Use these return contracts:

```ts
export interface CenterPanelRemovalResult extends CenterPanelLayoutMutation {
  readonly removedSurfaceIds: readonly string[];
}

export interface CenterPanelMergeResult extends CenterPanelLayoutMutation {
  readonly destinationGroupId: string | null;
}

export function removeCenterPanelSurfaceIds(
  current: CenterPanelLayoutState,
  surfaceIds: ReadonlySet<string>,
): CenterPanelRemovalResult;

export function mergeCenterPanelGroup(
  current: CenterPanelLayoutState,
  groupId: string,
): CenterPanelMergeResult;

export function setCenterPanelSplitRatio(
  current: CenterPanelLayoutState,
  path: CenterPanelLayoutPath,
  ratio: number,
): CenterPanelLayoutMutation;

export function repairCenterPanelLayoutState(
  persisted: unknown,
  validSurfaceIds: readonly string[],
  fallbackActiveSurfaceId: string | null,
): CenterPanelLayoutState;
```

`repairCenterPanelLayoutState` must sanitize groups first, walk and prune the tree, append orphaned valid IDs to the first surviving group, merge groups beyond the fourth in depth-first leaf order, and finally repair active/focused IDs. If nothing survives, return `createCenterPanelLayoutState(validSurfaceIds, fallbackActiveSurfaceId)`.

- [ ] **Step 8: Run all pure layout tests**

Run:

```bash
vp test apps/web/src/centerPanelLayout.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the pure model**

```bash
git add apps/web/src/centerPanelLayout.ts apps/web/src/centerPanelLayout.test.ts
git commit -m "feat(web): add center panel split layout model"
```

---

### Task 2: Migrate the center store to groups and a split tree

**Files:**
- Modify: `apps/web/src/centerPanelStore.ts`
- Modify: `apps/web/src/centerPanelStore.test.ts`

**Interfaces:**
- Consumes: all Task 1 layout types and mutations.
- Produces: persisted `ThreadCenterPanelState extends CenterPanelLayoutState`, group-aware activation/drop/merge/ratio methods, group-local close methods returning `CenterSurface[]`, and visible/focused selectors used by Tasks 3 and 9.

- [ ] **Step 1: Rewrite store fixtures around one root group and add a legacy migration test**

Update assertions to use this shape:

```ts
expect(selectThreadCenterPanelState(store().byThreadKey, HOST)).toEqual({
  surfaces: [{ id: HOST_SURFACE_ID, kind: "chat-host" }],
  groups: [
    {
      id: CENTER_PANEL_ROOT_GROUP_ID,
      surfaceIds: [HOST_SURFACE_ID],
      activeSurfaceId: HOST_SURFACE_ID,
    },
  ],
  layout: { type: "leaf", groupId: CENTER_PANEL_ROOT_GROUP_ID },
  focusedGroupId: CENTER_PANEL_ROOT_GROUP_ID,
});
```

Add a migration test using the exact current flat payload:

```ts
it("migrates the flat v2 state into one root group", () => {
  const migrated = migratePersistedCenterPanelState({
    byThreadKey: {
      "environment-1:host-1": {
        surfaces: [
          { id: HOST_SURFACE_ID, kind: "chat-host" },
          { kind: "terminal", terminalId: "term-1" },
        ],
        activeSurfaceId: "terminal:term-1",
      },
    },
  });
  expect(migrated.byThreadKey["environment-1:host-1"]).toMatchObject({
    groups: [
      {
        id: CENTER_PANEL_ROOT_GROUP_ID,
        surfaceIds: [HOST_SURFACE_ID, "terminal:term-1"],
        activeSurfaceId: "terminal:term-1",
      },
    ],
    layout: { type: "leaf", groupId: CENTER_PANEL_ROOT_GROUP_ID },
    focusedGroupId: CENTER_PANEL_ROOT_GROUP_ID,
  });
});
```

- [ ] **Step 2: Run the store tests and verify they fail on the new shape**

Run:

```bash
vp test apps/web/src/centerPanelStore.test.ts
```

Expected: FAIL because the store still exposes one top-level `activeSurfaceId` and flat ordering.

- [ ] **Step 3: Replace the persisted shape and add group-aware actions**

Set `CENTER_PANEL_STORAGE_VERSION = 3` and define the store contract as:

```ts
export interface ThreadCenterPanelState extends CenterPanelLayoutState {
  readonly surfaces: readonly CenterSurface[];
}

interface CenterPanelStoreState {
  byThreadKey: Record<string, ThreadCenterPanelState>;
  openChatPanel: (ref: ScopedThreadRef, threadId: ThreadId, providerLabel?: string) => void;
  openTerminalPanel: (
    ref: ScopedThreadRef,
    terminalId: string,
    options?: OpenTerminalPanelOptions,
  ) => void;
  replaceMainWithTerminal: (
    ref: ScopedThreadRef,
    existingTerminalIds: ReadonlyArray<string>,
    options: OpenTerminalPanelOptions,
  ) => string;
  focusGroup: (ref: ScopedThreadRef, groupId: string) => void;
  activateSurface: (ref: ScopedThreadRef, groupId: string, surfaceId: string) => void;
  dropSurface: (ref: ScopedThreadRef, surfaceId: string, target: CenterPanelDropRequest) => boolean;
  mergeGroup: (ref: ScopedThreadRef, groupId: string) => boolean;
  setSplitRatio: (ref: ScopedThreadRef, path: CenterPanelLayoutPath, ratio: number) => void;
  closeSurface: (ref: ScopedThreadRef, groupId: string, surfaceId: string) => CenterSurface[];
  closeOtherSurfaces: (
    ref: ScopedThreadRef,
    groupId: string,
    surfaceId: string,
  ) => CenterSurface[];
  closeSurfacesToRight: (
    ref: ScopedThreadRef,
    groupId: string,
    surfaceId: string,
  ) => CenterSurface[];
  closeAllSurfaces: (ref: ScopedThreadRef, groupId: string) => CenterSurface[];
  removeThread: (ref: ScopedThreadRef) => void;
}
```

Generate split group IDs in the impure store boundary with `crypto.randomUUID()` and a `center-group:` prefix, then pass the completed `CenterPanelDropTarget` to the pure mutation. `openChatPanel` and `openTerminalPanel` call `insertCenterPanelSurface` with `focusedGroupId`. `replaceMainWithTerminal` intentionally resets to a one-group terminal-only state, preserving its current project-creation semantics.

- [ ] **Step 4: Implement migration and persistence pruning**

After sanitizing surfaces, derive layout state with:

```ts
const legacyActiveSurfaceId =
  typeof threadState.activeSurfaceId === "string" ? threadState.activeSurfaceId : null;
const layoutState = repairCenterPanelLayoutState(
  {
    groups: threadState.groups,
    layout: threadState.layout,
    focusedGroupId: threadState.focusedGroupId,
  },
  surfaces.map((surface) => surface.id),
  legacyActiveSurfaceId,
);
byThreadKey[threadKey] = { surfaces, ...layoutState };
```

Continue pruning only the exact implicit default: host-only surface, root-only group, host active, and root focused. Persist an explicit empty root group because it is distinct from a fresh host thread.

- [ ] **Step 5: Add failing tests for focused creation, atomic moves, group-local closes, and returned removals**

Add tests that create two groups and assert:

```ts
vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000002");
const groupRight = "center-group:00000000-0000-4000-8000-000000000002";
expect(
  store().dropSurface(HOST, "chat:panel-a", {
    groupId: CENTER_PANEL_ROOT_GROUP_ID,
    splitDirection: "right",
  }),
).toBe(true);
expect(stateOf().groups.some((group) => group.id === groupRight)).toBe(true);

store().focusGroup(HOST, groupRight);
store().openTerminalPanel(HOST, "term-2");
expect(stateOf().groups.find((group) => group.id === groupRight)?.surfaceIds).toContain(
  "terminal:term-2",
);

const removed = store().closeSurfacesToRight(HOST, groupRight, "chat:panel-a");
expect(removed.map((surface) => surface.id)).toEqual(["terminal:term-2"]);
expect(stateOf().groups.find((group) => group.id === "center:root")?.surfaceIds).toEqual(
  rootIdsBefore,
);

expect(store().mergeGroup(HOST, groupRight)).toBe(true);
expect(stateOf().surfaces.map((surface) => surface.id)).toEqual(allIdsBeforeMerge);
```

Also assert `dropSurface` returns `false` without publishing a new state for invalid/no-op targets and that `setSplitRatio` changes only the addressed split path.

- [ ] **Step 6: Run the focused store tests and verify they fail**

Run:

```bash
vp test apps/web/src/centerPanelStore.test.ts -t "focused|atomic|group-local|returned|ratio"
```

Expected: FAIL because the new store actions do not exist.

- [ ] **Step 7: Implement close result mapping and selectors**

For every close action, compute the target group's IDs first, preserve `HOST_SURFACE_ID` only for `closeOtherSurfaces` when the host belongs to that same group, call `removeCenterPanelSurfaceIds`, and map the returned IDs to descriptors before updating `surfaces`:

```ts
function applySurfaceRemoval(
  current: ThreadCenterPanelState,
  requestedIds: ReadonlySet<string>,
): { readonly state: ThreadCenterPanelState; readonly removed: CenterSurface[] } {
  const mutation = removeCenterPanelSurfaceIds(current, requestedIds);
  if (!mutation.changed) return { state: current, removed: [] };
  const removedIdSet = new Set(mutation.removedSurfaceIds);
  return {
    state: {
      surfaces: current.surfaces.filter((surface) => !removedIdSet.has(surface.id)),
      ...mutation.state,
    },
    removed: current.surfaces.filter((surface) => removedIdSet.has(surface.id)),
  };
}
```

Export focused and visible selectors:

```ts
export interface VisibleCenterSurface {
  readonly groupId: string;
  readonly surface: CenterSurface;
  readonly focused: boolean;
}

export function selectFocusedCenterPanelGroup(state: ThreadCenterPanelState): CenterPanelGroup;
export function selectFocusedCenterSurface(state: ThreadCenterPanelState): CenterSurface | null;
export function selectVisibleCenterSurfaces(state: ThreadCenterPanelState): VisibleCenterSurface[];
```

Keep `selectActiveCenterSurface(byThreadKey, ref)` as a compatibility wrapper around the focused selector until all callers migrate.

Because Zustand `set` is synchronous, each close method captures its result in
a local before returning it:

```ts
closeSurface: (ref, groupId, surfaceId) => {
  let removed: CenterSurface[] = [];
  set((storeState) => ({
    byThreadKey: updateThread(
      storeState.byThreadKey,
      scopedThreadKey(ref),
      (current) => {
        const result = applySurfaceRemoval(current, new Set([surfaceId]));
        removed = result.removed;
        return result.state;
      },
    ),
  }));
  return removed;
},
```

The other group-local close methods use the same pattern after calculating
their requested ID set from `groupId`; they must return `[]` and preserve state
identity for invalid groups or surface IDs.

- [ ] **Step 8: Run the store and creation-flow regression tests**

Run:

```bash
vp test apps/web/src/centerPanelStore.test.ts apps/web/src/components/CreateWorktreeDialog.test.tsx apps/web/src/components/add-project/useAddProjectWorkflow.public.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit the persisted store migration**

```bash
git add apps/web/src/centerPanelStore.ts apps/web/src/centerPanelStore.test.ts
git commit -m "feat(web): persist center panel tab groups"
```

---

### Task 3: Centralize group-aware chat and terminal cleanup

**Files:**
- Modify: `apps/web/src/centerPanelActions.ts`
- Modify: `apps/web/src/centerPanelActions.test.ts`

**Interfaces:**
- Consumes: Task 2 close actions returning exact removed `CenterSurface[]`.
- Produces: `useCenterPanelActions({ onCloseTerminal })` with group-aware activation and close methods; layout-only moves remain store-only and perform no cleanup.

- [ ] **Step 1: Write failing cleanup tests against exact removed surfaces**

Update the harness to supply `onCloseTerminal` and add:

```ts
const onCloseTerminal = vi.fn();
const actions = useCenterPanelActions({ onCloseTerminal });

actions.closeOtherSurfaces(HOST, "group-right", chatSurface);

expect(deleteThread).toHaveBeenCalledWith({
  environmentId: HOST.environmentId,
  input: { threadId: removedChat.threadId },
});
expect(onCloseTerminal).toHaveBeenCalledWith(HOST, removedTerminal);
expect(onCloseTerminal).not.toHaveBeenCalledWith(HOST, terminalInOtherGroup);
```

Add a layout-only case:

```ts
useCenterPanelStore.getState().dropSurface(HOST, terminal.id, {
  groupId: "group-right",
  index: 0,
});
useCenterPanelStore.getState().mergeGroup(HOST, "group-right");
expect(deleteThread).not.toHaveBeenCalled();
expect(onCloseTerminal).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the action tests and verify they fail**

Run:

```bash
vp test apps/web/src/centerPanelActions.test.ts
```

Expected: FAIL because the hook does not accept terminal cleanup and close methods are not group-aware.

- [ ] **Step 3: Implement one cleanup pipeline**

Use these signatures:

```ts
export interface CenterPanelActionsOptions {
  readonly onCloseTerminal: (
    hostRef: ScopedThreadRef,
    surface: Extract<CenterSurface, { kind: "terminal" }>,
  ) => void;
}

export interface CenterPanelActions {
  // Existing create/open methods remain unchanged.
  activateSurface: (hostRef: ScopedThreadRef, groupId: string, surfaceId: string) => void;
  closeSurface: (hostRef: ScopedThreadRef, groupId: string, surface: CenterSurface) => void;
  closeOtherSurfaces: (
    hostRef: ScopedThreadRef,
    groupId: string,
    surface: CenterSurface,
  ) => void;
  closeSurfacesToRight: (
    hostRef: ScopedThreadRef,
    groupId: string,
    surface: CenterSurface,
  ) => void;
  closeAllSurfaces: (hostRef: ScopedThreadRef, groupId: string) => void;
}

export function useCenterPanelActions({ onCloseTerminal }: CenterPanelActionsOptions) {
  const cleanupRemoved = useCallback(
    (hostRef: ScopedThreadRef, removed: readonly CenterSurface[]) => {
      for (const surface of removed) {
        if (surface.kind === "chat") {
          deletePanelThread(hostRef.environmentId, surface.threadId);
        } else if (surface.kind === "terminal") {
          onCloseTerminal(hostRef, surface);
        }
      }
    },
    [deletePanelThread, onCloseTerminal],
  );
  // Each close method calls its synchronous store action and passes only the
  // returned descriptors to cleanupRemoved.
}
```

Do not select and diff the whole workspace in this hook; the store's atomic result is the single source of truth for what was removed.

- [ ] **Step 4: Run all center action tests**

Run:

```bash
vp test apps/web/src/centerPanelActions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle consolidation**

```bash
git add apps/web/src/centerPanelActions.ts apps/web/src/centerPanelActions.test.ts
git commit -m "refactor(web): centralize center panel cleanup"
```

---

### Task 4: Define deterministic center drag/drop geometry

**Files:**
- Create: `apps/web/src/components/centerPanelDnd.ts`
- Create: `apps/web/src/components/centerPanelDnd.test.ts`

**Interfaces:**
- Consumes: `CenterPanelSplitDirection` and opaque group/surface IDs.
- Produces: drag/drop metadata guards, `captureCenterPanelDropGeometry`, `canCenterPanelPaneSplit`, `resolveCenterPanelSplitDirection`, `resolveCenterPanelInsertionIndex`, and `resolveCenterPanelDropIntent` for Tasks 5 and 8.

- [ ] **Step 1: Write failing geometry and intent tests**

Create literal rectangle fixtures and assert every direction, the tab-strip exclusion, corner tie-breaking, insertion midpoint, center append, and stale-pointer rejection:

```ts
it.each([
  [{ x: 101, y: 300 }, "left"],
  [{ x: 499, y: 300 }, "right"],
  [{ x: 300, y: 141 }, "up"],
  [{ x: 300, y: 499 }, "down"],
] as const)("resolves %o to %s", (point, expected) => {
  expect(
    resolveCenterPanelSplitDirection(point, {
      pane: { left: 100, right: 500, top: 100, bottom: 500, width: 400, height: 400 },
      tabStripBottom: 132,
    }),
  ).toBe(expected);
});

it("reserves the tab strip for insertion and rejects a stale outside pointer", () => {
  expect(resolveCenterPanelSplitDirection({ x: 300, y: 120 }, geometry)).toBeNull();
  expect(resolveCenterPanelSplitDirection({ x: 700, y: 300 }, geometry)).toBeNull();
  expect(resolveCenterPanelInsertionIndex({ left: 200, width: 100 }, 2, 249)).toBe(2);
  expect(resolveCenterPanelInsertionIndex({ left: 200, width: 100 }, 2, 251)).toBe(3);
});

it("rejects directions whose axis cannot fit both minimum pane sizes", () => {
  expect(canCenterPanelPaneSplit({ width: 479, height: 500 }, "left")).toBe(false);
  expect(canCenterPanelPaneSplit({ width: 480, height: 319 }, "right")).toBe(true);
  expect(canCenterPanelPaneSplit({ width: 480, height: 319 }, "down")).toBe(false);
  expect(canCenterPanelPaneSplit({ width: 480, height: 320 }, "up")).toBe(true);
});
```

- [ ] **Step 2: Run the geometry tests and verify they fail**

Run:

```bash
vp test apps/web/src/components/centerPanelDnd.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement metadata and geometry as pure functions**

Define the exact metadata unions:

```ts
export interface CenterPanelTabDragData {
  readonly type: "center-panel-tab";
  readonly surfaceId: string;
  readonly groupId: string;
  readonly surfaceKind: "chat-host" | "chat" | "terminal";
  readonly title: string;
}

export interface CenterPanelPaneDropData {
  readonly type: "center-panel-pane";
  readonly groupId: string;
}

export type CenterPanelDropIntent =
  | { readonly type: "insert"; readonly groupId: string; readonly index: number }
  | {
      readonly type: "split";
      readonly groupId: string;
      readonly direction: CenterPanelSplitDirection;
    }
  | { readonly type: "append"; readonly groupId: string }
  | { readonly type: "none" };
```

For edge selection, require the point inside the pane body, calculate normalized distance to all four edges, retain distances `<= 0.2`, and select the smallest with tie order `left`, `right`, `up`, `down`. Exclude `point.y < tabStripBottom` before evaluating vertical edges. `canCenterPanelPaneSplit` requires width `>= 480` for left/right and body height `>= 320` for up/down; filter undersized directions before selecting an edge. `resolveCenterPanelDropIntent` prioritizes a valid split, then a hovered tab insertion, then pane append.

- [ ] **Step 4: Run the pure drag/drop tests**

Run:

```bash
vp test apps/web/src/components/centerPanelDnd.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the drag/drop primitives**

```bash
git add apps/web/src/components/centerPanelDnd.ts apps/web/src/components/centerPanelDnd.test.ts
git commit -m "feat(web): add center panel drop resolution"
```

---

### Task 5: Make each center tab strip group-aware and sortable

**Files:**
- Modify: `apps/web/src/components/CenterPanelTabs.tsx`
- Modify: `apps/web/src/components/CenterPanelTabs.test.tsx`
- Modify: `apps/web/src/components/CenterPanelTabs.dom.test.tsx`

**Interfaces:**
- Consumes: Task 2 group-local callbacks and Task 4 `CenterPanelTabDragData`.
- Produces: a sortable tab strip for one `CenterPanelGroup`, exported shared `CenterSurfaceIcon`, native directional submenu callbacks, and group-scoped overflow/keyboard behavior.

- [ ] **Step 1: Add failing tests for group callbacks and the nested layout menu**

Change the shared fixture to include `groupId: "group-a"`, `canMoveToSplit: () => true`, and `onMoveToSplit: vi.fn()`. Assert the native menu shape and dispatch:

```ts
expect(show).toHaveBeenCalledWith(
  expect.arrayContaining([
    expect.objectContaining({
      id: "move-to-split",
      label: "Move Tab to Split",
      disabled: false,
      children: [
        { id: "move-to-split:left", label: "Left" },
        { id: "move-to-split:right", label: "Right" },
        { id: "move-to-split:up", label: "Up" },
        { id: "move-to-split:down", label: "Down" },
      ],
    }),
  ]),
  { x: 10, y: 20 },
);

show.mockResolvedValueOnce("move-to-split:down");
await openContextMenu();
expect(input.onMoveToSplit).toHaveBeenCalledWith("group-a", chat, "down");
```

Mock `useSortable` and assert it receives `{ surfaceId, groupId, title }` data while the source wrapper has no transform style.

- [ ] **Step 2: Run the tab tests and verify they fail**

Run:

```bash
vp test apps/web/src/components/CenterPanelTabs.test.tsx
```

Expected: FAIL because the component has no group ID, sortable registration, or move submenu.

- [ ] **Step 3: Update the props and native context action union**

Use this contract:

```ts
interface CenterPanelTabsProps {
  groupId: string;
  hostLabel: string;
  surfaces: readonly CenterSurface[];
  activeSurfaceId: string | null;
  terminalLabelsById?: ReadonlyMap<string, string>;
  canMoveToSplit: (direction: CenterPanelSplitDirection) => boolean;
  dragInProgress: boolean;
  onActivate: (groupId: string, surface: CenterSurface) => void;
  onCloseSurface: (groupId: string, surface: CenterSurface) => void;
  onCloseOtherSurfaces: (groupId: string, surface: CenterSurface) => void;
  onCloseSurfacesToRight: (groupId: string, surface: CenterSurface) => void;
  onCloseAllSurfaces: (groupId: string) => void;
  onMoveToSplit: (
    groupId: string,
    surface: CenterSurface,
    direction: CenterPanelSplitDirection,
  ) => void;
}

type TabContextMenuAction =
  | "move-to-split"
  | `move-to-split:${CenterPanelSplitDirection}`
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";
```

All activation and close callbacks include `groupId`. Existing close enablement remains based on this group's `surfaces` array.

- [ ] **Step 4: Register anchored sortable tabs**

Make the existing icon reusable by tab content and the drag overlay without
constructing a fake `CenterSurface`:

```tsx
export function CenterSurfaceIcon({ kind }: { kind: CenterPanelKind }) {
  switch (kind) {
    case "chat-host":
      return <MessageSquare className="size-3.5 shrink-0" />;
    case "chat":
      return <Bot className="size-3.5 shrink-0" />;
    case "terminal":
      return <TerminalSquare className="size-3.5 shrink-0" />;
  }
}
```

Extract a local `SortableCenterTab` that calls:

```tsx
const sortable = useSortable({
  id: surface.id,
  data: {
      type: "center-panel-tab",
      surfaceId: surface.id,
      groupId,
      surfaceKind: surface.kind,
      title,
  } satisfies CenterPanelTabDragData,
});

return (
  <div
    ref={sortable.setNodeRef}
    data-center-panel-tab-id={surface.id}
    data-center-panel-group-id={groupId}
    data-active-tab={active}
    data-dragging={sortable.isDragging}
    className={cn(baseClass, sortable.isDragging && "opacity-40")}
  >
    <button
      ref={sortable.setActivatorNodeRef}
      {...sortable.attributes}
      {...sortable.listeners}
      onClick={() => !dragInProgress && onActivate(groupId, surface)}
    >
      {content}
    </button>
    {closeButton}
  </div>
);
```

Do not apply `sortable.transform` or `sortable.transition`; the source stays anchored and `DragOverlay` represents motion. Stop pointer propagation on the close button so it never activates the drag listener.

- [ ] **Step 5: Add the nested native menu and preserve close behavior**

Prepend:

```ts
{
  id: "move-to-split",
  label: "Move Tab to Split",
  disabled: !(["left", "right", "up", "down"] as const).some(props.canMoveToSplit),
  children: (["left", "right", "up", "down"] as const).map((direction) => ({
    id: `move-to-split:${direction}` as const,
    label: direction[0]!.toUpperCase() + direction.slice(1),
    disabled: !props.canMoveToSplit(direction),
  })),
}
```

Dispatch a returned `move-to-split:*` ID by slicing the prefix and calling `onMoveToSplit(groupId, surface, direction)`. Keep middle-click, activation reveal, overflow controls, and arrow navigation scoped to the current strip.

- [ ] **Step 6: Run tab unit and DOM tests**

Run:

```bash
vp test apps/web/src/components/CenterPanelTabs.test.tsx apps/web/src/components/CenterPanelTabs.dom.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit group-aware tabs**

```bash
git add apps/web/src/components/CenterPanelTabs.tsx apps/web/src/components/CenterPanelTabs.test.tsx apps/web/src/components/CenterPanelTabs.dom.test.tsx
git commit -m "feat(web): make center tabs group aware"
```

---

### Task 6: Add the stable body-target and surface-host layer

**Files:**
- Create: `apps/web/src/components/CenterPanelSurfaceHosts.tsx`
- Create: `apps/web/src/components/CenterPanelSurfaceHosts.test.tsx`

**Interfaces:**
- Consumes: Task 2 `ThreadCenterPanelState`, `VisibleCenterSurface`, and a render callback supplied later by `ChatView`.
- Produces: `useCenterPanelBodyTargets`, `CenterPanelBodyTargetRegistry`, `CenterPanelSurfaceHosts`, and stable keyed wrappers that Task 8 composes.

- [ ] **Step 1: Write failing DOM tests for target-relative geometry and identity preservation**

Use happy-dom, mocked `getBoundingClientRect`, and `createRoot`:

```tsx
it("keeps a visible terminal host mounted while its group target changes", async () => {
  const mounted = vi.fn();
  function Surface({ id }: { id: string }) {
    useEffect(() => {
      mounted(id);
      return () => mounted(`unmount:${id}`);
    }, [id]);
    return <div data-surface-instance={id} />;
  }

  await renderHosts(stateWithTerminalInLeft, targets);
  const before = container.querySelector('[data-center-surface-host="terminal:term-1"]');
  await renderHosts(stateWithTerminalInRight, targets);
  const after = container.querySelector('[data-center-surface-host="terminal:term-1"]');

  expect(after).toBe(before);
  expect(mounted).toHaveBeenCalledWith("terminal:term-1");
  expect(mounted).not.toHaveBeenCalledWith("unmount:terminal:term-1");
});

it("keeps the inactive host mounted but hidden", async () => {
  await renderHosts(stateWithInactiveHost, targets);
  expect(container.querySelector('[data-center-surface-host="chat:host"]')).toHaveAttribute(
    "data-visible",
    "false",
  );
});

it("updates wrapper geometry imperatively without rerendering surface content", async () => {
  await renderHosts(stateWithTerminalInLeft, targets);
  targetRects.set("group-left", { left: 20, top: 40, width: 640, height: 360 });
  act(() => hostsRef.current?.syncRects());
  const host = container.querySelector<HTMLElement>(
    '[data-center-surface-host="terminal:term-1"]',
  );
  expect(host?.style.left).toBe("20px");
  expect(host?.style.width).toBe("640px");
  expect(mounted).toHaveBeenCalledTimes(1);
});

it("focuses the owning group from surface pointer and keyboard focus", async () => {
  await renderHosts(stateWithTerminalInLeft, targets);
  const host = container.querySelector<HTMLElement>(
    '[data-center-surface-host="terminal:term-1"]',
  )!;
  host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  host.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(onFocusGroup).toHaveBeenCalledWith("group-left");
});
```

- [ ] **Step 2: Run the host-layer tests and verify they fail**

Run:

```bash
vp test apps/web/src/components/CenterPanelSurfaceHosts.test.tsx
```

Expected: FAIL because the host layer does not exist.

- [ ] **Step 3: Implement the body-target registry**

Use this contract:

```ts
export interface CenterPanelBodyRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CenterPanelBodyTargetRegistry {
  readonly rootRef: (node: HTMLDivElement | null) => void;
  readonly registerBodyTarget: (groupId: string) => (node: HTMLDivElement | null) => void;
  readonly rects: ReadonlyMap<string, CenterPanelBodyRect>;
  readonly readBodyRect: (groupId: string) => CenterPanelBodyRect | null;
}
```

`readBodyRect` subtracts the workspace root rectangle from the registered body rectangle without setting React state. The registry batches normal observer updates through one `requestAnimationFrame` and publishes a new `rects` map only when a numeric rectangle changed. Observe the root and targets with one `ResizeObserver`; memoize one ref callback per group, cancel the pending frame, and disconnect on unmount.

- [ ] **Step 4: Implement flat keyed surface hosts**

Use one stable parent array and surface IDs as keys:

```tsx
export interface CenterPanelSurfaceRenderContext {
  readonly groupId: string;
  readonly visible: boolean;
  readonly focused: boolean;
}

export interface CenterPanelSurfaceHostsHandle {
  readonly syncRects: () => void;
}

export const CenterPanelSurfaceHosts = forwardRef<CenterPanelSurfaceHostsHandle, {
  state: ThreadCenterPanelState;
  rects: ReadonlyMap<string, CenterPanelBodyRect>;
  readBodyRect: (groupId: string) => CenterPanelBodyRect | null;
  onFocusGroup: (groupId: string) => void;
  renderSurface: (
    surface: CenterSurface,
    context: CenterPanelSurfaceRenderContext,
  ) => ReactNode;
}>(function CenterPanelSurfaceHosts(props, ref) {
  const membership = new Map<string, string>();
  for (const group of props.state.groups) {
    for (const surfaceId of group.surfaceIds) membership.set(surfaceId, group.id);
  }
  const visibleIds = new Set(
    props.state.groups.flatMap((group) =>
      group.activeSurfaceId === null ? [] : [group.activeSurfaceId],
    ),
  );
  const mounted = props.state.surfaces.filter(
    (surface) => surface.id === HOST_SURFACE_ID || visibleIds.has(surface.id),
  );
  return mounted.map((surface) => {
    const groupId = membership.get(surface.id)!;
    const rect = props.rects.get(groupId);
    const visible = visibleIds.has(surface.id) && rect !== undefined;
    return (
      <div
        key={surface.id}
        ref={(node) => setHostElement(surface.id, node)}
        data-center-surface-host={surface.id}
        data-center-surface-group-id={groupId}
        data-visible={String(visible)}
        className={cn(
          "pointer-events-auto absolute overflow-hidden",
          !visible && "invisible pointer-events-none",
        )}
        style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : {}}
        onPointerDownCapture={() => props.onFocusGroup(groupId)}
        onFocusCapture={() => props.onFocusGroup(groupId)}
      >
        {props.renderSurface(surface, {
          groupId,
          visible,
          focused: props.state.focusedGroupId === groupId,
        })}
      </div>
    );
  });
});
```

Keep host elements in a ref map and implement the referenced helpers as:

```ts
const hostElementsRef = useRef(new Map<string, HTMLDivElement>());
const setHostElement = useCallback((surfaceId: string, node: HTMLDivElement | null) => {
  if (node) hostElementsRef.current.set(surfaceId, node);
  else hostElementsRef.current.delete(surfaceId);
}, []);
const syncRects = useCallback(() => {
  for (const element of hostElementsRef.current.values()) {
    const groupId = element.dataset.centerSurfaceGroupId;
    const rect = groupId ? props.readBodyRect(groupId) : null;
    if (!rect) continue;
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  }
}, [props.readBodyRect]);
useImperativeHandle(ref, () => ({ syncRects }), [syncRects]);
useLayoutEffect(syncRects, [props.rects, props.state, syncRects]);
```

This assigns wrapper geometry directly without calling `setState` during a
pointer resize.

The host layer container itself is `pointer-events-none`; visible wrappers restore `pointer-events-auto`. Pointer and DOM focus capture on each visible wrapper route to `onFocusGroup(groupId)` because the overlay is a sibling rather than a descendant of the structural pane. Ignore the callback when that group is already focused. The split renderer calls the imperative handle during resize frames so host rectangles follow flex-basis changes without rerendering mounted chats or terminals.

- [ ] **Step 5: Run the host-layer tests**

Run:

```bash
vp test apps/web/src/components/CenterPanelSurfaceHosts.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit stable surface hosting**

```bash
git add apps/web/src/components/CenterPanelSurfaceHosts.tsx apps/web/src/components/CenterPanelSurfaceHosts.test.tsx
git commit -m "feat(web): add stable center surface hosts"
```

---

### Task 7: Render recursive groups and accessible resize handles

**Files:**
- Create: `apps/web/src/components/CenterPanelSplitLayout.tsx`
- Create: `apps/web/src/components/CenterPanelSplitLayout.test.tsx`

**Interfaces:**
- Consumes: Task 1 layout nodes, Task 2 state callbacks, Task 5 tab strips, and Task 6 body-target registration.
- Produces: `CenterPanelSplitLayout` with recursive leaf groups, focused action chrome, pane menu, droppable bodies, and ratio commit callbacks used by Task 8.

- [ ] **Step 1: Write failing recursive rendering and focus tests**

Render a three-leaf tree and assert:

```tsx
expect(container.querySelectorAll("[data-center-panel-group]")).toHaveLength(3);
expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(3);
expect(container.querySelectorAll('[role="region"][aria-label^="Center pane"]')).toHaveLength(3);
expect(container.querySelectorAll("[data-center-panel-focused-actions]")).toHaveLength(1);

firePointerDown(groupB);
expect(input.onFocusGroup).toHaveBeenCalledWith("group-b");

clickPaneAction("Close Split Pane");
expect(input.onMergeGroup).toHaveBeenCalledWith("group-b");
```

Assert the action chrome does not render `Close Split Pane` for a one-group layout.

- [ ] **Step 2: Write failing pointer and keyboard resize tests**

Mock a 1000-pixel horizontal split container. Pointer movement from 500 to 650 should set child flex bases to 65/35 during movement, call `onResizeFrame`, and call `onSetSplitRatio([], 0.65)` exactly once on pointer up. Add `ArrowLeft` and `ArrowRight` assertions for five-percent keyboard increments and `aria-valuenow="50"`.
Stub `setPointerCapture`, `hasPointerCapture`, and `releasePointerCapture` on the separator in happy-dom.
Also trigger the split node's `ResizeObserver`: a persisted `0.15` ratio in a
1000-pixel horizontal node renders as 24/76 to honor 240-pixel targets, while
the same node at 400 pixels renders 50/50 without workspace overflow. Assert
these responsive render adjustments do not call `onSetSplitRatio`.

```tsx
const dispatchPointer = (type: string, clientX: number) => {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerId: { value: 7 },
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: 0 },
  });
  separator.dispatchEvent(event);
};
const dispatchKey = (key: string) => {
  separator.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
};

dispatchPointer("pointerdown", 500);
dispatchPointer("pointermove", 650);
expect(first.style.flexBasis).toBe("65%");
expect(second.style.flexBasis).toBe("35%");
expect(input.onResizeFrame).toHaveBeenCalled();
expect(input.onSetSplitRatio).not.toHaveBeenCalled();
dispatchPointer("pointerup", 650);
expect(input.onSetSplitRatio).toHaveBeenCalledOnce();
expect(input.onSetSplitRatio).toHaveBeenCalledWith([], 0.65);

dispatchKey("ArrowLeft");
expect(input.onSetSplitRatio).toHaveBeenLastCalledWith([], 0.45);
dispatchKey("ArrowRight");
expect(input.onSetSplitRatio).toHaveBeenLastCalledWith([], 0.55);
```

- [ ] **Step 3: Run the split-layout tests and verify they fail**

Run:

```bash
vp test apps/web/src/components/CenterPanelSplitLayout.test.tsx
```

Expected: FAIL because the recursive renderer does not exist.

- [ ] **Step 4: Implement recursive split nodes and group leaves**

Use this main contract:

```ts
export interface CenterPanelSplitLayoutProps {
  readonly state: ThreadCenterPanelState;
  readonly hostLabel: string;
  readonly terminalLabelsById?: ReadonlyMap<string, string>;
  readonly dragInProgress: boolean;
  readonly focusedActions: ReactNode;
  readonly registerBodyTarget: (groupId: string) => (node: HTMLDivElement | null) => void;
  readonly onResizeFrame: () => void;
  readonly onFocusGroup: (groupId: string) => void;
  readonly onActivate: (groupId: string, surface: CenterSurface) => void;
  readonly onCloseSurface: (groupId: string, surface: CenterSurface) => void;
  readonly onCloseOtherSurfaces: (groupId: string, surface: CenterSurface) => void;
  readonly onCloseSurfacesToRight: (groupId: string, surface: CenterSurface) => void;
  readonly onCloseAllSurfaces: (groupId: string) => void;
  readonly canMoveToSplit: (
    groupId: string,
    direction: CenterPanelSplitDirection,
  ) => boolean;
  readonly onMoveToSplit: (
    groupId: string,
    surface: CenterSurface,
    direction: CenterPanelSplitDirection,
  ) => void;
  readonly onMergeGroup: (groupId: string) => void;
  readonly onSetSplitRatio: (path: CenterPanelLayoutPath, ratio: number) => void;
}
```

For a leaf, resolve surfaces by its `surfaceIds`, render `CenterPanelTabs` with `canMoveToSplit={(direction) => props.canMoveToSplit(group.id, direction)}`, then register a droppable body whose ID is `"center-pane:" + groupId` and whose data is `{ type: "center-panel-pane", groupId }`. Wrap the group in `role="region"` with an accessible label formatted as “Center pane N: Active title” (or “Empty”), `data-focused`, and a focus-visible inset outline so focus is not communicated only by color. Focus the group on `onPointerDownCapture` and `onFocusCapture`, but ignore redundant focus calls when it is already focused. Adapt the tab callback as `onMoveToSplit={(sourceGroupId, surface, direction) => props.onMoveToSplit(sourceGroupId, surface, direction)}`.

Carry `touchesTopEdge`, `touchesLeftEdge`, and `touchesRightEdge` through recursion: horizontal children inherit top-edge status and divide left/right status; only the first vertical child inherits top-edge status. Top-edge group headers use `workspace-topbar` so existing macOS title-bar height and drag space remain intact, with 32-pixel tab chrome centered inside. Interior headers use `h-8`. Apply the existing collapsed-sidebar inset only to the top-left group, and preserve the current right-side action reservation only when the focused group touches the top-right edge.

Render `focusedActions` and a Base UI `Menu` with `Close Split Pane` only in the focused group. Keep root desktop/window controls outside this component.

- [ ] **Step 5: Implement imperative pointer resizing with one commit**

For split nodes, render a row for `horizontal` and column for `vertical`. Store pointer ID, starting coordinate, starting ratio, and node size in a ref. On movement:

```ts
const rawRatio = resize.startRatio + (coordinate - resize.startCoordinate) / resize.axisSize;
const minimumRatio = Math.min(
  0.5,
  Math.max(
    MIN_CENTER_PANEL_SPLIT_RATIO,
    resize.minimumPixels / resize.axisSize,
  ),
);
const ratio = Math.min(1 - minimumRatio, Math.max(minimumRatio, rawRatio));
firstRef.current!.style.flexBasis = `${ratio * 100}%`;
secondRef.current!.style.flexBasis = `${(1 - ratio) * 100}%`;
pendingRatioRef.current = ratio;
props.onResizeFrame();
```

Observe each split node's own axis size. On observer notification, calculate the same dynamic minimum ratio, clamp the persisted ratio for rendering only, assign both flex bases directly, and call `onResizeFrame`; do not update the store merely because the window changed. This honors 240/160-pixel targets where possible and resolves to 50/50 when the whole axis is smaller than twice the minimum without creating overflow.

Commit `pendingRatioRef.current` once on pointer up, cancel, or lost capture. Give the separator `role="separator"`, orientation, `aria-valuemin={15}`, `aria-valuemax={85}`, and rounded `aria-valuenow`. Arrow keys adjust by `0.05` and commit immediately. Use a six-pixel hit target with a token-colored inner line.

- [ ] **Step 6: Run split-layout tests**

Run:

```bash
vp test apps/web/src/components/CenterPanelSplitLayout.test.tsx apps/web/src/components/CenterPanelTabs.test.tsx apps/web/src/components/CenterPanelTabs.dom.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit recursive rendering and resize behavior**

```bash
git add apps/web/src/components/CenterPanelSplitLayout.tsx apps/web/src/components/CenterPanelSplitLayout.test.tsx
git commit -m "feat(web): render resizable center panel groups"
```

---

### Task 8: Orchestrate drag/drop and split previews in the center workspace

**Files:**
- Create: `apps/web/src/components/CenterPanelWorkspace.tsx`
- Create: `apps/web/src/components/CenterPanelWorkspace.test.tsx`

**Interfaces:**
- Consumes: Tasks 2, 4, 6, and 7.
- Produces: the complete presentational center workspace consumed by `ChatView`, including shared drag state and one atomic `onDropSurface` callback.

- [ ] **Step 1: Write failing drag lifecycle tests with a mocked `DndContext`**

Capture the DnD handlers supplied to the mock and assert:

```tsx
const pointerDragStart = (
  surfaceId: string,
  groupId: string,
  point: { x: number; y: number },
) =>
  ({
    active: {
      id: surfaceId,
      data: {
        current: {
          type: "center-panel-tab",
          surfaceId,
          groupId,
          surfaceKind: "chat",
          title: "Dragged",
        },
      },
    },
    activatorEvent: Object.assign(new Event("pointerdown"), {
      clientX: point.x,
      clientY: point.y,
    }),
  }) as unknown as DragStartEvent;
const dragMoveOverPane = (groupId: string, point: { x: number; y: number }) =>
  ({
    delta: { x: point.x - 300, y: point.y - 200 },
    over: { id: `center-pane:${groupId}`, data: { current: { type: "center-panel-pane", groupId } } },
  }) as unknown as DragMoveEvent;
const dragEndOverPane = (groupId: string) =>
  ({
    delta: { x: 399, y: 100 },
    over: { id: `center-pane:${groupId}`, data: { current: { type: "center-panel-pane", groupId } } },
  }) as unknown as DragEndEvent;

dragHandlers.onDragStart(pointerDragStart("chat:a", "group-a", { x: 300, y: 200 }));
dragHandlers.onDragMove(dragMoveOverPane("group-b", { x: 699, y: 300 }));
expect(container.querySelector("[data-center-panel-split-preview='right']")).not.toBeNull();

dragHandlers.onDragEnd(dragEndOverPane("group-b"));
expect(input.onDropSurface).toHaveBeenCalledWith("chat:a", {
  groupId: "group-b",
  splitDirection: "right",
});
expect(container.querySelector("[data-center-panel-split-preview]")).toBeNull();
```

Add separate tests for same-strip insertion, other-pane append, cancel with no callback, window blur with no callback, invalid outside pointer, sole-tab self-edge no-op, and fifth-pane suppression. The component emits a `CenterPanelDropRequest` containing only direction and target group; the store is the sole boundary that generates a new group ID.

- [ ] **Step 2: Run the workspace tests and verify they fail**

Run:

```bash
vp test apps/web/src/components/CenterPanelWorkspace.test.tsx
```

Expected: FAIL because the workspace component does not exist.

- [ ] **Step 3: Define the workspace prop contract**

```ts
export interface CenterPanelWorkspaceProps {
  readonly state: ThreadCenterPanelState;
  readonly hostLabel: string;
  readonly terminalLabelsById?: ReadonlyMap<string, string>;
  readonly focusedActions: ReactNode;
  readonly renderSurface: (
    surface: CenterSurface,
    context: CenterPanelSurfaceRenderContext,
  ) => ReactNode;
  readonly onFocusGroup: (groupId: string) => void;
  readonly onActivate: (groupId: string, surface: CenterSurface) => void;
  readonly onCloseSurface: (groupId: string, surface: CenterSurface) => void;
  readonly onCloseOtherSurfaces: (groupId: string, surface: CenterSurface) => void;
  readonly onCloseSurfacesToRight: (groupId: string, surface: CenterSurface) => void;
  readonly onCloseAllSurfaces: (groupId: string) => void;
  readonly onDropSurface: (surfaceId: string, target: CenterPanelDropRequest) => void;
  readonly onMergeGroup: (groupId: string) => void;
  readonly onSetSplitRatio: (path: CenterPanelLayoutPath, ratio: number) => void;
}
```

- [ ] **Step 4: Implement sensors, collision detection, and geometry snapshots**

Use a 12-pixel pointer activation threshold and pointer-first collision:

```tsx
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 12 } }),
);
const collisionDetection = useCallback<CollisionDetection>((args) => {
  const pointer = pointerWithin(args);
  return pointer.length > 0 ? pointer : closestCenter(args);
}, []);
```

On drag start, read the pointer from the `PointerEvent`, capture pane/tab rectangles once, set `dragInProgress`, and retain the active metadata. Derive the current pointer from the start point plus `event.delta`. Re-capture only when a `ResizeObserver` reports workspace bounds changed during drag.

- [ ] **Step 5: Resolve previews and dispatch exactly once on drag end**

On move, call `resolveCenterPanelDropIntent`; store only a changed preview intent. On end, resolve once more against the final pointer and dispatch:

```ts
switch (intent.type) {
  case "split":
    props.onDropSurface(active.surfaceId, {
      groupId: intent.groupId,
      splitDirection: intent.direction,
    });
    break;
  case "insert":
    props.onDropSurface(active.surfaceId, { groupId: intent.groupId, index: intent.index });
    break;
  case "append":
    props.onDropSurface(active.surfaceId, { groupId: intent.groupId });
    break;
  case "none":
    break;
}
clearDragState();
```

Render a token-based half-pane preview above hosts and below the drag overlay. Include a visible `New split: Left|Right|Up|Down` label in the preview. Export `CenterSurfaceIcon` from `CenterPanelTabs` and render `DragOverlay` with that shared icon plus the title from active metadata; do not duplicate surface-kind presentation logic. `onDragCancel`, `window.blur`, component unmount, and invalid end all call the same idempotent `clearDragState` and never mutate the store. Install the blur listener only for an active drag and remove it during cleanup.

For both pointer previews and the native context menu, gate with `canDropCenterPanelSurface(props.state, surfaceId, request)`. Also require `canCenterPanelPaneSplit` for the requested direction using the registered body rectangle. Dispatch the context action directly to `onDropSurface(surface.id, { groupId: sourceGroupId, splitDirection })`; the store repeats the same no-op, unique-ID, and cap gates before mutation.

- [ ] **Step 6: Compose layout, targets, and hosts**

The workspace root is `relative flex min-h-0 min-w-0 flex-1 overflow-hidden`. Attach the Task 6 registry root ref, render `CenterPanelSplitLayout`, render `CenterPanelSurfaceHosts` as its sibling overlay, and pass an imperative host sync as `onResizeFrame`. Keep resize handles and drop overlays above surface wrappers with explicit z-index classes.

```tsx
const surfaceHostsRef = useRef<CenterPanelSurfaceHostsHandle>(null);

<div ref={targets.rootRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
  <CenterPanelSplitLayout
    {...layoutProps}
    registerBodyTarget={targets.registerBodyTarget}
    onResizeFrame={() => surfaceHostsRef.current?.syncRects()}
    canMoveToSplit={(groupId, direction) => {
      const group = findCenterPanelGroup(props.state, groupId);
      const rect = targets.rects.get(groupId);
      return Boolean(
        group &&
          group.surfaceIds.length > 1 &&
          rect &&
          canCenterPanelPaneSplit(rect, direction) &&
          canDropCenterPanelSurface(props.state, group.surfaceIds[0]!, {
            groupId,
            splitDirection: direction,
          }),
      );
    }}
  />
  <div className="pointer-events-none absolute inset-0 z-10">
    <CenterPanelSurfaceHosts
      ref={surfaceHostsRef}
      state={props.state}
      rects={targets.rects}
      readBodyRect={targets.readBodyRect}
      onFocusGroup={props.onFocusGroup}
      renderSurface={props.renderSurface}
    />
  </div>
  {splitPreview}
  <DragOverlay>{dragOverlay}</DragOverlay>
</div>
```

- [ ] **Step 7: Run all center workspace component tests**

Run:

```bash
vp test apps/web/src/components/centerPanelDnd.test.ts apps/web/src/components/CenterPanelTabs.test.tsx apps/web/src/components/CenterPanelTabs.dom.test.tsx apps/web/src/components/CenterPanelSurfaceHosts.test.tsx apps/web/src/components/CenterPanelSplitLayout.test.tsx apps/web/src/components/CenterPanelWorkspace.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit workspace orchestration**

```bash
git add apps/web/src/components/CenterPanelWorkspace.tsx apps/web/src/components/CenterPanelWorkspace.test.tsx
git commit -m "feat(web): add center workspace drag and drop"
```

---

### Task 9: Integrate the split workspace with `ChatView` lifecycle

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/ChatView.test.tsx`
- Modify: `apps/web/src/components/ChatView.hooks.test.tsx`
- Modify: `apps/web/src/components/chat/ChatHeaderActions.tsx`
- Modify: `apps/web/src/components/chat/ChatHeaderActions.render.test.tsx`
- Modify: `apps/web/src/components/CenterTerminalPanel.tsx`
- Modify: `apps/web/src/components/CenterTerminalPanel.test.tsx`

**Interfaces:**
- Consumes: Task 3 group-aware actions and Task 8 `CenterPanelWorkspace`.
- Produces: live multi-pane chat/terminal rendering, focus-routed creation, exact explicit cleanup, root-level desktop controls, and unchanged bottom-terminal behavior.

- [ ] **Step 1: Replace `CenterPanelTabs` test mocks with a workspace mock and write failing composition tests**

Capture `CenterPanelWorkspace` props in both `ChatView.test.tsx` and `ChatView.hooks.test.tsx`:

```tsx
vi.mock("./CenterPanelWorkspace", () => ({
  CenterPanelWorkspace: (props: Record<string, unknown>) => {
    harness.centerWorkspaceProps = props;
    return <div data-mock="center-panel-workspace" />;
  },
}));
```

Assert one workspace replaces the old root tab header, `panelLayoutControls` remain root-owned, and the focused action node is supplied even for an empty root group.

In `ChatHeaderActions.render.test.tsx`, add a failing class assertion:

```tsx
const reserved = renderToStaticMarkup(
  <ChatHeaderActions {...props()} reserveTitlebarControls />,
);
const unreserved = renderToStaticMarkup(
  <ChatHeaderActions {...props()} reserveTitlebarControls={false} />,
);
expect(reserved).toContain("pr-16");
expect(unreserved).toContain("pr-0");
```

Replace the two existing `ChatView.test.tsx` assertions that inspect
`chatHeaderActions.rightPanelOpen` with `reserveTitlebarControls`. Assert `true`
only when the right panel is closed and the focused group touches the top-right
workspace edge; assert `false` when the right panel is open or focus is in a
lower/left group. Keep `PanelLayoutControls.rightPanelOpen` assertions
unchanged because that component still owns panel visibility.

- [ ] **Step 2: Write failing hook tests for focused creation and exact cleanup**

Seed two groups, focus the second, call captured `onOpenTerminalPanel`, and assert the terminal appears in the second group's `surfaceIds`. Invoke captured group-local close callbacks and assert only removed terminal IDs call `closeTerminalMutation`. Invoke `onDropSurface` and `onMergeGroup` and assert neither terminal close nor sibling thread deletion runs.

```tsx
act(() => capturedWorkspaceProps.onFocusGroup("group-b"));
act(() => capturedHeaderActionsProps.onOpenTerminalPanel());
expect(groupState("group-b").surfaceIds.at(-1)).toMatch(/^terminal:/);

act(() => capturedWorkspaceProps.onCloseAllSurfaces("group-b"));
expect(closeTerminalMutation).toHaveBeenCalledWith(
  expect.objectContaining({ input: expect.objectContaining({ terminalId: "term-b" }) }),
);
expect(closeTerminalMutation).not.toHaveBeenCalledWith(
  expect.objectContaining({ input: expect.objectContaining({ terminalId: "term-a" }) }),
);

closeTerminalMutation.mockClear();
deleteThread.mockClear();
act(() => capturedWorkspaceProps.onDropSurface("terminal:term-a", { groupId: "group-b" }));
act(() => capturedWorkspaceProps.onMergeGroup("group-b"));
expect(closeTerminalMutation).not.toHaveBeenCalled();
expect(deleteThread).not.toHaveBeenCalled();
```

- [ ] **Step 3: Run the focused ChatView tests and verify they fail**

Run:

```bash
vp test apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx -t "center panel|center workspace|center terminal"
```

Expected: FAIL because `ChatView` still composes one flat active center surface.

- [ ] **Step 4: Move terminal cleanup behind `useCenterPanelActions`**

Replace the old pre-diff cleanup callbacks with one memoized terminal resource callback:

```ts
const closeCenterTerminalResource = useCallback(
  (
    hostRef: ScopedThreadRef,
    surface: Extract<CenterSurface, { kind: "terminal" }>,
  ) => {
    storeCloseTerminal(hostRef, surface.terminalId);
    void closeTerminalMutation({
      environmentId: hostRef.environmentId,
      input: {
        threadId: hostRef.threadId,
        terminalId: surface.terminalId,
        deleteHistory: true,
      },
    }).then((result) => {
      if (result._tag === "Success") {
        releaseTerminalInputScheduler(
          hostRef.environmentId,
          hostRef.threadId,
          surface.terminalId,
        );
      }
    });
  },
  [closeTerminalMutation, storeCloseTerminal],
);
const centerPanelActions = useCenterPanelActions({
  onCloseTerminal: closeCenterTerminalResource,
});
```

Delete the old whole-array diffing in `closeOtherCenterPanelSurfaces`, `closeCenterPanelSurfacesToRight`, and `closeAllCenterPanelSurfaces`; pass `groupId` into the Task 3 methods.

- [ ] **Step 5: Wire focus, activation, drops, merging, and ratios**

Create callbacks that read/write only the active host thread:

```ts
const dropCenterPanelSurface = useCallback(
  (surfaceId: string, target: CenterPanelDropRequest) => {
    if (!activeThreadRef) return;
    useCenterPanelStore.getState().dropSurface(activeThreadRef, surfaceId, target);
  },
  [activeThreadRef],
);
```

Use equivalent small callbacks for `focusGroup`, `activateSurface`, `mergeGroup`, and `setSplitRatio`. Creation methods require no group argument because the store appends to `focusedGroupId`.

- [ ] **Step 6: Replace the top header and single active body with `CenterPanelWorkspace`**

Keep desktop `panelLayoutControls` at the root. Move the existing host header actions into `focusedActions`. Build a `renderCenterSurface` callback:

```tsx
const renderCenterSurface = useCallback(
  (surface: CenterSurface, context: CenterPanelSurfaceRenderContext) => {
    switch (surface.kind) {
      case "chat-host":
        return hostChatSurfaceBody;
      case "chat":
        return (
          <ChatView
            variant="panel"
            panelThreadRef={scopeThreadRef(activeThreadRef!.environmentId, surface.threadId)}
          />
        );
      case "terminal":
        return (
          <CenterTerminalPanel
            threadRef={activeThreadRef!}
            projectId={activeThread.projectId}
            surface={surface}
            launchContext={centerTerminalLaunchContext}
            keybindings={keybindings}
            focusRequestId={context.focused ? terminalFocusRequestId : 0}
            onAddTerminalContext={addTerminalContextToDraft}
            onClose={() => closeCenterPanelSurface(context.groupId, surface)}
          />
        );
    }
  },
  [
    activeThread,
    activeThreadRef,
    addTerminalContextToDraft,
    centerTerminalLaunchContext,
    closeCenterPanelSurface,
    hostChatSurfaceBody,
    keybindings,
    terminalFocusRequestId,
  ],
);
```

Define `hostChatSurfaceBody` from the existing provider banners, timeline, composer, dialogs, and host activity dock. Pass it to the flat host layer instead of toggling the old `centerHostHidden` wrapper. Derive `focusedCenterSurface` with the Task 2 selector for focus-dependent activity/right-panel policy; do not use one top-level active ID.

Replace `ChatHeaderActionsProps.rightPanelOpen` with
`reserveTitlebarControls: boolean` and make its padding explicit:

```tsx
className={cn(
  "@container/header-actions relative z-10 flex shrink-0 items-center justify-end gap-2 bg-background @3xl/header-actions:gap-3",
  reserveTitlebarControls ? "pr-16" : "pr-0",
)}
```

Derive the value at the host boundary:

```ts
const focusedGroupEdges = findCenterPanelGroupEdges(
  centerPanelState.layout,
  centerPanelState.focusedGroupId,
);
const reserveCenterTitlebarControls =
  !effectiveRightPanelOpen && focusedGroupEdges?.top === true && focusedGroupEdges.right;
```

Pass `reserveTitlebarControls={reserveCenterTitlebarControls}` into the focused action node. This keeps the fixed desktop controls root-owned without wasting right padding when the focused action chrome is in a lower or left pane.

Render:

```tsx
<CenterPanelWorkspace
  state={centerPanelState}
  hostLabel={centerHostLabel}
  terminalLabelsById={activeTerminalLabelsById}
  focusedActions={chatHeaderActions}
  renderSurface={renderCenterSurface}
  onFocusGroup={focusCenterPanelGroup}
  onActivate={activateCenterPanelSurface}
  onCloseSurface={closeCenterPanelSurface}
  onCloseOtherSurfaces={closeOtherCenterPanelSurfaces}
  onCloseSurfacesToRight={closeCenterPanelSurfacesToRight}
  onCloseAllSurfaces={closeAllCenterPanelSurfaces}
  onDropSurface={dropCenterPanelSurface}
  onMergeGroup={mergeCenterPanelGroup}
  onSetSplitRatio={setCenterPanelSplitRatio}
/>
```

Leave `PersistentThreadTerminalDrawer` after the workspace exactly as it is.

- [ ] **Step 7: Update the center terminal contract comment and regression test**

Replace the obsolete “splits/groups are out of scope” comment with: “This component owns one center terminal surface. Center workspace grouping is external; terminal-process split controls remain intentionally omitted.” Assert `ThreadTerminalDrawer` still receives one synthesized terminal group and no `onSplitTerminal` or `onSplitTerminalVertical` props.

```tsx
expect(harness.drawerProps).toMatchObject({
  mode: "panel",
  terminalIds: ["term-1"],
  activeTerminalId: "term-1",
  terminalGroups: [{ id: "terminal:term-1", terminalIds: ["term-1"] }],
});
expect(harness.drawerProps.onSplitTerminal).toBeUndefined();
expect(harness.drawerProps.onSplitTerminalVertical).toBeUndefined();
```

- [ ] **Step 8: Run center integration and terminal regressions**

Run:

```bash
vp test apps/web/src/centerPanelLayout.test.ts apps/web/src/centerPanelStore.test.ts apps/web/src/centerPanelActions.test.ts apps/web/src/components/centerPanelDnd.test.ts apps/web/src/components/CenterPanelTabs.test.tsx apps/web/src/components/CenterPanelTabs.dom.test.tsx apps/web/src/components/CenterPanelSurfaceHosts.test.tsx apps/web/src/components/CenterPanelSplitLayout.test.tsx apps/web/src/components/CenterPanelWorkspace.test.tsx apps/web/src/components/CenterTerminalPanel.test.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit the live workspace integration**

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx apps/web/src/components/chat/ChatHeaderActions.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/CenterTerminalPanel.tsx apps/web/src/components/CenterTerminalPanel.test.tsx
git commit -m "feat(web): integrate split center workspace"
```

---

### Task 10: Document and verify the complete desktop behavior

**Files:**
- Modify: `docs/user/workspace-ui.md`

**Interfaces:**
- Consumes: the complete Tasks 1–9 feature.
- Produces: user-facing documentation and final automated/desktop verification evidence.

- [ ] **Step 1: Update the center-panel user documentation**

Add this behavior after the existing persistence paragraph, adjusted only for established project terminology:

```md
Center tabs can be arranged into as many as four visible split panes. Drag a tab
within its strip to reorder it, into another pane to move it, or onto a pane edge
to create a left, right, upper, or lower split. The tab context menu offers the
same four moves. Each pane has its own active tab; the focused pane owns the
center creation actions, so new chats and terminals open there.

Drag pane dividers to resize them. Layout, focus, tab order, and split ratios
persist across reloads. Closing a split pane merges its tabs into the adjacent
layout without closing chats or terminals. Explicit tab close commands remain
pane-local and do close their underlying panel thread or terminal session.
```

- [ ] **Step 2: Run the entire focused feature suite**

Run:

```bash
vp test apps/web/src/centerPanelLayout.test.ts apps/web/src/centerPanelStore.test.ts apps/web/src/centerPanelActions.test.ts apps/web/src/components/centerPanelDnd.test.ts apps/web/src/components/CenterPanelTabs.test.tsx apps/web/src/components/CenterPanelTabs.dom.test.tsx apps/web/src/components/CenterPanelSurfaceHosts.test.tsx apps/web/src/components/CenterPanelSplitLayout.test.tsx apps/web/src/components/CenterPanelWorkspace.test.tsx apps/web/src/components/CenterTerminalPanel.test.tsx apps/web/src/components/chat/ChatHeaderActions.render.test.tsx apps/web/src/components/ChatView.test.tsx apps/web/src/components/ChatView.hooks.test.tsx
```

Expected: PASS with no skipped center workspace tests.

- [ ] **Step 3: Run repository-required checks**

Run:

```bash
vp check
vp run typecheck
```

Expected: both exit 0. Advisory TypeScript suggestions are acceptable only when the command still exits 0; lint warnings or errors are not.

- [ ] **Step 4: Commit the documentation**

```bash
git add docs/user/workspace-ui.md
git commit -m "docs: explain center panel split layouts"
```

- [ ] **Step 5: Build the production desktop application**

Run:

```bash
vp run build:desktop
```

Expected: exit 0 and produce `target/release/bundle/macos/BiBCode.app` on this macOS environment.

- [ ] **Step 6: Launch and verify the desktop app with Computer Use**

Launch the built app, then invoke the `computer-use:computer-use` skill. Create enough chat/terminal tabs to verify:

1. Same-strip reorder and cross-pane movement.
2. Left, right, up, and down edge previews and resulting nested layouts.
3. A full-height pane beside two stacked panes.
4. Focused action chrome moves between panes and new tabs open in the focused pane.
5. Pointer resize is smooth; keyboard resize works; ratios restore after relaunch.
6. `Move Tab to Split` matches drag behavior.
7. `Close Split Pane` merges tabs without stopping chat or terminal sessions.
8. Explicit group-local close commands stop only their selected resources.
9. Fifth-pane creation is disabled while four panes exist.
10. The bottom terminal drawer still splits and operates independently.
11. Tab overflow navigation, middle-click close, tooltips, and arrow keys still work per group.

Capture fresh accessibility snapshots and screenshots of the three-pane nested layout, the native move submenu, the split preview, and the four-pane limit. Treat overlap, clipped action chrome, stale drop zones, remounted visible terminals, malformed reload state, or unintended resource shutdown as a failed verification.

- [ ] **Step 7: Confirm the final worktree state**

Run:

```bash
git status --short
git log --oneline -10
```

Expected: no uncommitted implementation changes and one focused commit per completed task.
