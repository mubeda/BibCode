# Center Panel Split Layout Design

Date: 2026-08-05
Status: Approved

## Summary

Extend BiBCode's multipanel center workspace from one flat tab strip into a
persisted, resizable tree of tab groups. Users can reorder tabs, move tabs
between groups, and create left, right, up, or down splits by drag and drop or
through native tab context menus. At most four pane groups may be visible.

Every pane owns its own tab order and active surface. One pane is focused at a
time and displays the existing center actions. Closing a split is a
non-destructive layout operation: its tabs move into a neighboring pane and
their chats and terminal sessions remain alive.

The design follows the useful structural patterns in Orca's tab-group
implementation while retaining BiBCode's existing surface lifecycle,
persistence, header actions, and bottom-terminal splitting.

## Goals

1. Support nested horizontal and vertical center-pane layouts.
2. Let users reorder and relocate chat and terminal tabs with drag and drop.
3. Let edge drops create directional splits with an unambiguous preview.
4. Provide equivalent directional split moves through the native tab context
   menu.
5. Resize adjacent panes smoothly and persist their ratios.
6. Keep layout operations separate from destructive session-closing actions.
7. Preserve existing center-tab navigation, overflow, and resource lifecycle
   behavior.
8. Recover predictably from stale, partial, or malformed persisted layouts.

## Non-Goals

- Adding terminal-internal splitting to center terminal tabs. The existing
  bottom terminal drawer already owns terminal-process splitting.
- Changing the existing bottom terminal drawer or right-panel terminal split
  model.
- Adding tab pinning, custom titles, or tab colors.
- Adding chat or terminal server protocol operations for layout management.
- Copying Orca's Electron webview hosting or remote tab-mirroring mechanisms.
- Replacing BiBCode's existing `dnd-kit` dependencies with a docking framework.

## Reference Findings

Orca models workspace tabs, pane groups, and the split layout separately:

- a content registry identifies each tab;
- each group owns ordered tab IDs and one active tab;
- a recursive binary tree contains group leaves and horizontal or vertical
  split nodes;
- a split node persists a ratio;
- moving the final tab out of a group removes its leaf and collapses its parent;
- `Close split pane` moves tabs into a sibling before removing the group;
- tab drag edge zones create a half-pane split preview;
- resize movement updates element styles directly and commits store state only
  when the gesture ends.

These patterns appear in Orca's `TabGroupLayoutNode`, tab-store split and merge
operations, `TabGroupSplitLayout`, `useTabDragSplit`, and tab workspace layout
menus under `/Users/admin/projects/orca/src/renderer/src/`. They are reference
material only; BiBCode will implement the behavior in its own center-panel
model and visual system.

BiBCode's right-panel terminal state is intentionally shallower: all panes in a
terminal group share one direction. It is useful for lifecycle and interaction
precedents but cannot express a full-height left pane beside two vertically
stacked right panes. The center workspace therefore needs the recursive model.

## State Model

The host-thread-scoped center-panel state will contain four coordinated parts:

```ts
type CenterPanelGroup = {
  id: string;
  surfaceIds: string[];
  activeSurfaceId: string | null;
};

type CenterPanelLayoutNode =
  | { type: "leaf"; groupId: string }
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      first: CenterPanelLayoutNode;
      second: CenterPanelLayoutNode;
      ratio: number;
    };

type ThreadCenterPanelState = {
  surfaces: CenterSurface[];
  groups: CenterPanelGroup[];
  layout: CenterPanelLayoutNode;
  focusedGroupId: string;
};
```

The exact exported names may change during implementation, but the separation
of responsibilities is fixed:

- `surfaces` owns chat and terminal descriptors and no visual ordering;
- `groups` owns tab membership, ordering, and active selection;
- `layout` owns pane nesting, orientation, and size;
- `focusedGroupId` owns keyboard/action routing and new-surface placement.

### Invariants

1. Every surface ID appears in exactly one group.
2. Every group ID appears in exactly one layout leaf.
3. Every layout leaf resolves to one existing group.
4. A group's active surface is either one of its members or `null` when empty.
5. The focused group resolves to an existing layout leaf.
6. The number of groups never exceeds four after an atomic operation.
7. A one-pane workspace may have one empty root group so creation actions remain
   available.
8. Multi-pane layouts never retain empty groups; an empty leaf collapses into
   its sibling.
9. A split ratio is finite and normalized to the renderable range.

Store mutations must maintain these invariants in one Zustand update. React
must never observe intermediate duplicate assignments, empty multi-pane leaves,
or a group count temporarily above the limit.

## Default State and Migration

The persisted center-panel version will advance. Current flat state migrates to
one root group while preserving surface order and the active surface. Existing
host-only implicit behavior remains compatible with selectors, and an existing
explicitly empty state becomes one focused empty root group.

Hydration will normalize in this order:

1. Sanitize surface descriptors with the existing bounded metadata rules.
2. Sanitize group IDs, deduplicate surface membership, and repair active IDs.
3. Validate layout nodes, directions, ratios, leaf IDs, and duplicate leaves.
4. Prune invalid branches and collapse split nodes that have only one valid
   child.
5. Recover valid orphaned surfaces into the root or first valid group.
6. Merge excess valid groups in deterministic layout order until at most four
   remain.
7. Repair the focused group and per-group active selections.
8. Fall back to one usable root group if no valid layout survives.

Migration and repair must preserve surface resources rather than silently drop
valid chat or terminal descriptors because their layout metadata is damaged.

## Tree Operations

Pure helpers outside React will implement all layout mutations. Drag/drop,
context menus, hydration, and tests will call these same helpers.

### Split

Splitting a target leaf replaces it with a split node whose children are the
existing target group and a new group. Left and up place the new group first;
right and down place it second. Left/right use horizontal layout and up/down use
vertical layout. The initial ratio is `0.5`.

The four-pane limit applies to the final atomic state. An edge move that removes
the source's final tab and creates a destination split may remain legal at four
groups because its final group count is unchanged.

### Move and Reorder

A tab move removes the surface ID from its source group and inserts it exactly
once in the destination order. The moved tab becomes active and its destination
becomes focused. If the source becomes empty and another group exists, its leaf
is removed and the parent split collapses.

Moving a group's sole tab to a new split adjacent to that same group is a no-op:
it would create and immediately collapse an equivalent layout. The native
context-menu action is disabled in this case.

### Close Split Pane

`Close Split Pane` is available only when multiple groups exist. It finds the
source leaf's parent split and selects the direct sibling leaf, or the first
leaf in depth-first layout order when that sibling is itself a subtree. It
appends the source group's tabs to that destination, preserving their order.
Because pane actions are shown only for the focused pane, the source's active
tab becomes active in the destination, and the destination becomes focused.
The source leaf and its parent split then collapse.

This operation does not call chat deletion or terminal shutdown. It changes
layout and group membership only.

### Explicit Tab Closure

Closing a tab, closing other tabs, closing tabs to the right, or closing all
tabs retains the current resource lifecycle:

- hidden sibling chat threads are deleted;
- center terminal backend sessions are closed;
- the host surface follows its existing close behavior.

These commands are scoped to the tab's group. If they empty a leaf in a
multi-pane layout, the empty leaf collapses. If they empty the only group, the
empty root remains so the user can create another surface.

## Component Architecture

`ChatView` remains the host composition and lifecycle boundary but delegates
center layout rendering to a dedicated workspace component.

Suggested boundaries:

- a pure center layout module owns tree traversal, validation, split, move,
  reorder, merge, and collapse helpers;
- `centerPanelStore.ts` owns persistence and exposes atomic host-thread actions;
- a center workspace component owns the shared drag context and recursive tree;
- a split-node component owns flex direction and resize handles;
- a group component owns focus, one group-local `CenterPanelTabs`, focused action
  chrome, and a body target;
- a flat surface-host layer keeps visible surface component identity independent
  from recursive group ancestry and positions each host over its group's body
  target;
- `CenterPanelTabs` remains responsible for tab presentation, overflow,
  keyboard navigation, middle-click, and native tab menus, but receives one
  group's order and drag metadata;
- chat and terminal body components retain their existing server/session
  responsibilities.

This prevents layout logic from accumulating in `ChatView` or being duplicated
between pointer and menu interactions.

## Header and Focus Behavior

Each pane has its own 32-pixel-class tab strip. Pointer interaction anywhere in
a pane, or DOM focus entering it, makes that group focused.

Only the focused pane displays `ChatHeaderActions` and the pane-actions menu.
The existing `+`, provider terminal, project-script, and Open actions therefore
move with focus. A newly created chat or terminal is inserted and activated in
the focused group.

Desktop window controls and root panel-layout controls remain anchored to the
workspace shell and reserve their existing title-bar space. They do not move
into lower nested pane headers. Top-edge tab strips preserve any required
desktop drag-region behavior; interior pane strips do not become window drag
regions.

Focused styling must be visible but subtle. Unfocused groups retain full
readability while their action chrome collapses rather than occupying dead
space.

## Drag and Drop

BiBCode already depends on `@dnd-kit/core` and `@dnd-kit/sortable`; no new
docking dependency is required. One drag context wraps the entire center
workspace.

### Gesture Rules

- A pointer movement threshold prevents ordinary clicks from starting drags.
- The source tab stays anchored; a drag overlay represents the moving tab.
- Same-strip drops reorder by the hovered tab midpoint.
- Other-strip drops insert at the indicated position.
- Pane-body center drops append to that group.
- The outer 20 percent of a pane body resolves to left, right, up, or down split
  targets.
- The tab strip is excluded from vertical edge split zones so tab reordering
  remains predictable.
- The actual pointer must be inside the current pane rectangle before accepting
  a split target; stale collision results are ignored.
- A valid split target paints a token-based half-pane overlay and directional
  label.
- Drag cancellation, pointer cancellation, focus loss, or an invalid final
  target leaves persisted state unchanged.

Tab activation, close buttons, tooltips, and overflow navigation are suppressed
only as needed during an active drag to avoid an accidental click after drop.
Store mutation happens once at successful drag end.

## Native Context Menus

The existing desktop context-menu contract already supports nested children.
Center tab menus gain one layout-only submenu:

- `Move Tab to Split`
  - `Left`
  - `Right`
  - `Up`
  - `Down`

The submenu calls the same split-move operation as drag and drop. It is disabled
when the current group has only that tab or the final layout would exceed four
groups. Existing close commands remain and become group-local.

The focused pane's pane-actions menu contains `Close Split Pane` when more than
one group exists. No pin, rename, color, or terminal-internal split entries are
added.

## Resizing

Each split node renders a separator between flex children. Pointer movement
updates the two immediate child flex bases directly so resizing remains smooth
without publishing 60–120 global store updates per second. Pointer up, pointer
cancel, or lost capture commits one normalized ratio to the store.

Initial sizing constraints are:

- ratios remain within 15–85 percent where the available axis permits;
- target minimums are 240 pixels for horizontal pane width and 160 pixels for
  vertical pane height;
- a new split is disabled when its target axis cannot reasonably host both
  children;
- if the whole window later shrinks below those combined minimums, both panes
  share the available space rather than forcing workspace-level overflow.

The separator has an approximately six-pixel pointer hit area and a thinner
visible line. It exposes separator semantics, current value, orientation, and
keyboard resizing in predictable increments.

## Surface Rendering and Lifecycle

The recursive tree renders pane chrome and registered body targets, not the
stateful chat and terminal components directly. A sibling flat host layer under
the workspace root renders currently visible active surfaces keyed by stable
surface ID and positions/clips them over those targets. Target refs and a
`ResizeObserver` keep resting geometry synchronized; active pointer resizing
updates host rectangles in the same animation frame as the split flex bases.
This avoids changing React ancestry when a visible tab moves between groups.

At most four active pane bodies render simultaneously. The host chat remains in
the flat host layer whenever its surface exists, including when inactive, and
is hidden rather than unmounted so its transcript, scroll, and composer state
retain today's behavior. Other inactive group tabs keep today's remount
behavior.

Relocating a currently visible surface changes its target rectangle without
remounting its component or invoking resource cleanup. A terminal therefore
keeps its attached viewport while moving, and a sibling chat continues to use
the same component and server thread. Explicit close actions remain the only
layout UI path that terminates those resources. Host-layer wrappers do not
intercept pointer input outside their body target, and resize handles and drop
previews remain above them in the layout stacking order.

The existing bottom terminal drawer remains mounted and managed independently.

## Accessibility

- Each pane is a labeled region with its own tablist.
- Active tab and focused pane are exposed independently.
- Arrow-key tab navigation stays within the current group.
- Native context-menu relocation is the non-drag alternative for creating a
  split.
- Pane bodies can receive focus without stealing focus from terminal input or a
  chat composer.
- Resize handles are keyboard-operable separators with orientation and value
  metadata.
- Drop previews supplement rather than replace textual tab and pane labels.
- Focus rings and pane focus indication do not rely on color alone.

## Reliability and Performance

- All group/tree mutations are pure and atomic.
- Invalid targets and no-op moves preserve object identity where practical and
  do not wake unrelated subscribers.
- Resize gestures commit persisted state only at gesture end.
- Drag geometry is captured at drag start or recomputed only when layout bounds
  change, rather than on every pointer event.
- The four-pane limit bounds simultaneously mounted active chats and terminals.
- Hydration favors retaining valid surface resources and repairing layout.
- No drag, resize, or merge action performs asynchronous resource cleanup.
- Existing explicit close cleanup remains centralized through center panel
  actions instead of being duplicated inside components.

## Testing

Implementation will follow a red-green-refactor sequence around the pure state
model before wiring React interactions.

### Pure state and migration tests

- flat-state migration preserves order, activation, host-closed state, and
  explicit empty state;
- split insertion produces the correct orientation and first/second ordering;
- same-group reorder and cross-group insertion preserve uniqueness;
- moving the final source tab collapses the source leaf;
- context and drag split moves share identical results;
- moving a sole tab into an adjacent self-split is a no-op;
- final-state pane counting allows a four-to-four relocation but rejects a
  four-to-five split;
- close-pane merging preserves resources, order, and active focus;
- a close-pane destination is the direct sibling leaf or first depth-first leaf
  of the sibling subtree;
- group-local close commands return the exact removed surfaces needed for
  existing cleanup;
- malformed layouts, duplicate leaves, orphaned surfaces, dangling IDs,
  invalid ratios, and excess groups recover deterministically.

### Component and integration tests

- each layout leaf renders its own tablist and active body;
- moving a visible host chat or terminal between groups preserves its mounted
  component identity;
- actions render only in the focused pane and new surfaces enter that group;
- tab-strip and pane-body drop targets resolve correctly;
- edge zones exclude the tab strip and show the correct directional preview;
- drag cancellation does not mutate state;
- resize movement remains local and commits one clamped ratio at gesture end;
- keyboard resize and context-menu relocation work without drag input;
- pane-local close menus affect only their group;
- close split pane does not delete chats or close terminals;
- explicit tab closure still deletes sibling chats and shuts down terminal
  sessions;
- existing overflow rail, wheel navigation, activation reveal, middle-click,
  and arrow-key behavior remain covered.

### Required verification

1. Run focused tests for the pure layout, store, tab group, drag/drop, resize,
   `CenterPanelTabs`, and `ChatView` integration changes.
2. Run `vp check`.
3. Run `vp run typecheck`.
4. Build the production desktop application.
5. Use desktop UI automation and screenshots to verify:
   - nested left/right and top/bottom layouts;
   - same-group reorder and cross-group relocation;
   - edge-drop split previews and all four directions;
   - focused action movement and creation placement;
   - smooth resize and persisted ratios after reload;
   - pane-local close commands and non-destructive pane merging;
   - blocked fifth-pane creation;
   - continued bottom-terminal split behavior;
   - no accidental session closure during layout operations.

Any failed automated check, missing accepted behavior, malformed restored
layout, visual overlap, unreachable tab, or unexpected session termination is a
failed verification that must be corrected before completion.

## Acceptance Criteria

- The center workspace can display one to four nested tab groups.
- Each group has an independent tab order and active surface.
- Pointer or keyboard focus selects the group that displays center actions.
- New chats and terminals open in the focused group.
- Tabs reorder and move between groups through drag and drop.
- Valid pane-edge drops create left, right, up, or down splits with a preview.
- Native tab menus expose the same four directional split moves.
- Pane dividers resize smoothly and persist their ratios.
- Closing a split merges its tabs into a sibling without deleting chats or
  closing terminals.
- Existing close commands are group-local and retain explicit resource cleanup.
- Empty leaves collapse, while a sole empty root remains usable.
- A fifth visible pane cannot be created.
- Current persisted flat state migrates without losing valid surfaces.
- Existing tab overflow, keyboard navigation, bottom terminal splitting, and
  host-chat state retention continue to work.
- Focused tests, `vp check`, `vp run typecheck`, the production desktop build,
  and desktop interaction verification all pass.
