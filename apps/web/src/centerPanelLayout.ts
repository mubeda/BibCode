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

export interface CenterPanelRemovalResult extends CenterPanelLayoutMutation {
  readonly removedSurfaceIds: readonly string[];
}

export interface CenterPanelMergeResult extends CenterPanelLayoutMutation {
  readonly destinationGroupId: string | null;
}

export interface CenterPanelGroupEdges {
  readonly top: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
  readonly left: boolean;
}

export function createCenterPanelLayoutState(
  surfaceIds: readonly string[],
  fallbackActiveSurfaceId: string | null,
): CenterPanelLayoutState {
  const uniqueSurfaceIds = uniqueStrings(surfaceIds);
  const activeSurfaceId = uniqueSurfaceIds.includes(fallbackActiveSurfaceId ?? "")
    ? fallbackActiveSurfaceId
    : (uniqueSurfaceIds[0] ?? null);
  return {
    groups: [{ id: CENTER_PANEL_ROOT_GROUP_ID, surfaceIds: uniqueSurfaceIds, activeSurfaceId }],
    layout: { type: "leaf", groupId: CENTER_PANEL_ROOT_GROUP_ID },
    focusedGroupId: CENTER_PANEL_ROOT_GROUP_ID,
  };
}

export function findCenterPanelGroup(
  current: CenterPanelLayoutState,
  groupId: string,
): CenterPanelGroup | undefined {
  return current.groups.find((group) => group.id === groupId);
}

export function findCenterPanelGroupForSurface(
  current: CenterPanelLayoutState,
  surfaceId: string,
): CenterPanelGroup | undefined {
  return current.groups.find((group) => group.surfaceIds.includes(surfaceId));
}

export function collectCenterPanelLeafIds(node: CenterPanelLayoutNode): string[] {
  return node.type === "leaf"
    ? [node.groupId]
    : [...collectCenterPanelLeafIds(node.first), ...collectCenterPanelLeafIds(node.second)];
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
        walk(node.first, { ...edges, right: false }) ?? walk(node.second, { ...edges, left: false })
      );
    }
    return (
      walk(node.first, { ...edges, bottom: false }) ?? walk(node.second, { ...edges, top: false })
    );
  };
  return walk(layout, { top: true, right: true, bottom: true, left: true });
}

export function canDropCenterPanelSurface(
  current: CenterPanelLayoutState,
  surfaceId: string,
  request: CenterPanelDropRequest,
): boolean {
  return validateCenterPanelDrop(current, surfaceId, request) !== null;
}

export function insertCenterPanelSurface(
  current: CenterPanelLayoutState,
  surfaceId: string,
  groupId?: string,
): CenterPanelLayoutMutation {
  const owner = findCenterPanelGroupForSurface(current, surfaceId);
  const destination =
    owner ??
    (groupId === undefined ? undefined : findCenterPanelGroup(current, groupId)) ??
    findCenterPanelGroup(current, current.focusedGroupId);
  if (!destination) return { state: current, changed: false };
  const groups = current.groups.map((group) => {
    if (group.id !== destination.id) return group;
    return {
      ...group,
      surfaceIds: owner ? group.surfaceIds : [...group.surfaceIds, surfaceId],
      activeSurfaceId: surfaceId,
    };
  });
  const state = { ...current, groups, focusedGroupId: destination.id };
  return stateEquals(current, state)
    ? { state: current, changed: false }
    : { state, changed: true };
}

export function dropCenterPanelSurface(
  current: CenterPanelLayoutState,
  surfaceId: string,
  target: CenterPanelDropTarget,
): CenterPanelLayoutMutation {
  const validated = validateCenterPanelDrop(current, surfaceId, target);
  if (!validated) return { state: current, changed: false };
  const { source, destination, splitDirection } = validated;
  const splitTarget = "splitDirection" in target ? target : null;
  if (splitTarget !== null && current.groups.some((group) => group.id === splitTarget.newGroupId)) {
    return { state: current, changed: false };
  }

  const sourceWillEmpty = source.surfaceIds.length === 1;
  let layout =
    sourceWillEmpty && source.id !== destination.id
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
    destinationId = splitTarget!.newGroupId;
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
    const index =
      "index" in target
        ? Math.max(0, Math.min(target.index ?? withoutMoved.length, withoutMoved.length))
        : withoutMoved.length;
    const surfaceIds = [...withoutMoved];
    surfaceIds.splice(index, 0, surfaceId);
    return { ...group, surfaceIds, activeSurfaceId: surfaceId };
  });
  const state = { groups, layout, focusedGroupId: destinationId };
  return stateEquals(current, state)
    ? { state: current, changed: false }
    : { state, changed: true };
}

export function removeCenterPanelSurfaceIds(
  current: CenterPanelLayoutState,
  surfaceIds: ReadonlySet<string>,
): CenterPanelRemovalResult {
  const groupsById = new Map(current.groups.map((group) => [group.id, group]));
  const removedSurfaceIds = collectCenterPanelLeafIds(current.layout).flatMap((groupId) => {
    const group = groupsById.get(groupId);
    return group ? group.surfaceIds.filter((surfaceId) => surfaceIds.has(surfaceId)) : [];
  });
  if (removedSurfaceIds.length === 0) {
    return { state: current, changed: false, removedSurfaceIds };
  }

  const groups = current.groups.map((group) => {
    const removed = group.surfaceIds.filter((surfaceId) => surfaceIds.has(surfaceId));
    if (removed.length === 0) return group;
    const remaining = group.surfaceIds.filter((surfaceId) => !surfaceIds.has(surfaceId));
    const activeSurfaceId =
      group.activeSurfaceId !== null && surfaceIds.has(group.activeSurfaceId)
        ? fallbackActiveSurfaceAfterRemovals(group, surfaceIds)
        : group.activeSurfaceId;
    return { ...group, surfaceIds: remaining, activeSurfaceId };
  });
  if (groups.every((group) => group.surfaceIds.length === 0)) {
    return {
      state: createCenterPanelLayoutState([], null),
      changed: true,
      removedSurfaceIds,
    };
  }

  const prunedState = pruneEmptyCenterPanelGroups({
    groups,
    layout: current.layout,
    focusedGroupId: current.focusedGroupId,
  });
  const state = repairActiveAndFocus(prunedState ?? createCenterPanelLayoutState([], null));
  return { state, changed: true, removedSurfaceIds };
}

export function mergeCenterPanelGroup(
  current: CenterPanelLayoutState,
  groupId: string,
): CenterPanelMergeResult {
  const source = findCenterPanelGroup(current, groupId);
  const destinationGroupId = findSiblingDestinationGroupId(current.layout, groupId);
  const destination =
    destinationGroupId === null ? undefined : findCenterPanelGroup(current, destinationGroupId);
  if (!source || !destination) {
    return { state: current, changed: false, destinationGroupId: null };
  }
  const layout = removeLeaf(current.layout, source.id);
  if (layout === null) return { state: current, changed: false, destinationGroupId: null };
  const groups = current.groups
    .filter((group) => group.id !== source.id)
    .map((group) =>
      group.id !== destination.id
        ? group
        : {
            ...group,
            surfaceIds: [...group.surfaceIds, ...source.surfaceIds],
            activeSurfaceId: source.activeSurfaceId ?? group.activeSurfaceId,
          },
    );
  const state = repairActiveAndFocus({
    groups,
    layout,
    focusedGroupId: current.focusedGroupId === source.id ? destination.id : current.focusedGroupId,
  });
  return { state, changed: true, destinationGroupId: destination.id };
}

export function setCenterPanelSplitRatio(
  current: CenterPanelLayoutState,
  path: CenterPanelLayoutPath,
  ratio: number,
): CenterPanelLayoutMutation {
  if (!Number.isFinite(ratio)) return { state: current, changed: false };
  const layout = updateSplitRatio(current.layout, path, clampRatio(ratio));
  if (layout === null || layout === current.layout) return { state: current, changed: false };
  return { state: { ...current, layout }, changed: true };
}

export function repairCenterPanelLayoutState(
  persisted: unknown,
  validSurfaceIds: readonly string[],
  fallbackActiveSurfaceId: string | null,
): CenterPanelLayoutState {
  const validIds = uniqueStrings(validSurfaceIds);
  const parsed = asRecord(persisted);
  const groups = sanitizePersistedGroups(parsed?.groups, validIds);
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const layout = sanitizeLayout(parsed?.layout, groupsById, new Set());
  if (layout === null) return createCenterPanelLayoutState(validIds, fallbackActiveSurfaceId);

  let state: CenterPanelLayoutState = {
    groups: collectCenterPanelLeafIds(layout)
      .map((groupId) => groupsById.get(groupId)!)
      .filter(Boolean),
    layout,
    focusedGroupId: typeof parsed?.focusedGroupId === "string" ? parsed.focusedGroupId : "",
  };
  const ownedIds = new Set(state.groups.flatMap((group) => group.surfaceIds));
  const orphanedIds = validIds.filter((surfaceId) => !ownedIds.has(surfaceId));
  if (orphanedIds.length > 0) {
    const firstGroup = state.groups[0]!;
    state = {
      ...state,
      groups: state.groups.map((group) =>
        group.id === firstGroup.id
          ? { ...group, surfaceIds: [...group.surfaceIds, ...orphanedIds] }
          : group,
      ),
    };
  }
  const prunedState = pruneEmptyCenterPanelGroups(state);
  if (prunedState === null) return createCenterPanelLayoutState(validIds, fallbackActiveSurfaceId);
  state = prunedState;
  while (state.groups.length > MAX_CENTER_PANEL_GROUPS) {
    const sourceId = collectCenterPanelLeafIds(state.layout)[MAX_CENTER_PANEL_GROUPS]!;
    const merged = mergeCenterPanelGroup(state, sourceId);
    if (!merged.changed) break;
    state = merged.state;
  }
  return repairActiveAndFocus(state, fallbackActiveSurfaceId);
}

function validateCenterPanelDrop(
  current: CenterPanelLayoutState,
  surfaceId: string,
  request: CenterPanelDropRequest,
): {
  source: CenterPanelGroup;
  destination: CenterPanelGroup;
  splitDirection: CenterPanelSplitDirection | null;
} | null {
  const source = findCenterPanelGroupForSurface(current, surfaceId);
  const destination = findCenterPanelGroup(current, request.groupId);
  if (!source || !destination) return null;
  const splitDirection = "splitDirection" in request ? request.splitDirection : null;
  const sourceWillEmpty = source.surfaceIds.length === 1;
  if (splitDirection !== null && source.id === destination.id && sourceWillEmpty) return null;
  const finalGroupCount =
    current.groups.length +
    (splitDirection === null ? 0 : 1) -
    (sourceWillEmpty && source.id !== destination.id ? 1 : 0);
  return finalGroupCount <= MAX_CENTER_PANEL_GROUPS
    ? { source, destination, splitDirection }
    : null;
}

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

function removeLeaf(node: CenterPanelLayoutNode, groupId: string): CenterPanelLayoutNode | null {
  if (node.type === "leaf") return node.groupId === groupId ? null : node;
  const first = removeLeaf(node.first, groupId);
  const second = removeLeaf(node.second, groupId);
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

function pruneEmptyCenterPanelGroups(state: CenterPanelLayoutState): CenterPanelLayoutState | null {
  const emptyGroupIds = state.groups
    .filter((group) => group.surfaceIds.length === 0)
    .map((group) => group.id);
  let layout: CenterPanelLayoutNode | null = state.layout;
  for (const groupId of emptyGroupIds) {
    layout = layout === null ? null : removeLeaf(layout, groupId);
  }
  if (layout === null) return null;
  const survivingGroupIds = new Set(collectCenterPanelLeafIds(layout));
  return {
    ...state,
    groups: state.groups.filter((group) => survivingGroupIds.has(group.id)),
    layout,
  };
}

function fallbackActiveSurface(group: CenterPanelGroup, removedSurfaceId: string): string | null {
  if (group.activeSurfaceId !== removedSurfaceId) return group.activeSurfaceId;
  const index = group.surfaceIds.indexOf(removedSurfaceId);
  return group.surfaceIds[index + 1] ?? group.surfaceIds[index - 1] ?? null;
}

function fallbackActiveSurfaceAfterRemovals(
  group: CenterPanelGroup,
  removedSurfaceIds: ReadonlySet<string>,
): string | null {
  const activeIndex = group.surfaceIds.indexOf(group.activeSurfaceId ?? "");
  for (let index = activeIndex + 1; index < group.surfaceIds.length; index += 1) {
    if (!removedSurfaceIds.has(group.surfaceIds[index]!)) return group.surfaceIds[index]!;
  }
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    if (!removedSurfaceIds.has(group.surfaceIds[index]!)) return group.surfaceIds[index]!;
  }
  return null;
}

function findSiblingDestinationGroupId(
  node: CenterPanelLayoutNode,
  groupId: string,
): string | null {
  if (node.type === "leaf") return null;
  if (collectCenterPanelLeafIds(node.first).includes(groupId)) {
    return (
      findSiblingDestinationGroupId(node.first, groupId) ??
      collectCenterPanelLeafIds(node.second)[0] ??
      null
    );
  }
  if (collectCenterPanelLeafIds(node.second).includes(groupId)) {
    return (
      findSiblingDestinationGroupId(node.second, groupId) ??
      collectCenterPanelLeafIds(node.first)[0] ??
      null
    );
  }
  return null;
}

function updateSplitRatio(
  node: CenterPanelLayoutNode,
  path: CenterPanelLayoutPath,
  ratio: number,
): CenterPanelLayoutNode | null {
  if (path.length === 0) {
    return node.type === "split" && node.ratio !== ratio ? { ...node, ratio } : null;
  }
  if (node.type === "leaf") return null;
  const segment = path[0];
  if (segment === undefined) return null;
  const rest = path.slice(1);
  const updated = updateSplitRatio(node[segment], rest, ratio);
  return updated === null ? null : { ...node, [segment]: updated };
}

function sanitizePersistedGroups(
  value: unknown,
  validSurfaceIds: readonly string[],
): CenterPanelGroup[] {
  if (!Array.isArray(value)) return [];
  const validIds = new Set(validSurfaceIds);
  const groupIds = new Set<string>();
  const ownedSurfaceIds = new Set<string>();
  const groups: CenterPanelGroup[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (record === null) continue;
    const id = record.id;
    if (typeof id !== "string" || id.length === 0 || groupIds.has(id)) continue;
    groupIds.add(id);
    const surfaceIds: string[] = [];
    if (Array.isArray(record.surfaceIds)) {
      for (const surfaceId of record.surfaceIds) {
        if (
          typeof surfaceId === "string" &&
          validIds.has(surfaceId) &&
          !ownedSurfaceIds.has(surfaceId)
        ) {
          surfaceIds.push(surfaceId);
          ownedSurfaceIds.add(surfaceId);
        }
      }
    }
    const activeSurfaceId =
      typeof record.activeSurfaceId === "string" && surfaceIds.includes(record.activeSurfaceId)
        ? record.activeSurfaceId
        : (surfaceIds[0] ?? null);
    groups.push({ id, surfaceIds, activeSurfaceId });
  }
  return groups;
}

function sanitizeLayout(
  value: unknown,
  groupsById: ReadonlyMap<string, CenterPanelGroup>,
  seenGroupIds: Set<string>,
): CenterPanelLayoutNode | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.type === "leaf") {
    if (
      typeof record.groupId !== "string" ||
      seenGroupIds.has(record.groupId) ||
      !groupsById.has(record.groupId)
    ) {
      return null;
    }
    seenGroupIds.add(record.groupId);
    return { type: "leaf", groupId: record.groupId };
  }
  if (
    record.type !== "split" ||
    (record.direction !== "horizontal" && record.direction !== "vertical")
  )
    return null;
  const first = sanitizeLayout(record.first, groupsById, seenGroupIds);
  const second = sanitizeLayout(record.second, groupsById, seenGroupIds);
  if (first === null) return second;
  if (second === null) return first;
  return {
    type: "split",
    direction: record.direction,
    ratio:
      typeof record.ratio === "number" && Number.isFinite(record.ratio)
        ? clampRatio(record.ratio)
        : 0.5,
    first,
    second,
  };
}

function repairActiveAndFocus(
  state: CenterPanelLayoutState,
  fallbackActiveSurfaceId?: string | null,
): CenterPanelLayoutState {
  const groups = state.groups.map((group) => {
    const activeSurfaceId = group.surfaceIds.includes(group.activeSurfaceId ?? "")
      ? group.activeSurfaceId
      : group.surfaceIds.includes(fallbackActiveSurfaceId ?? "")
        ? (fallbackActiveSurfaceId ?? null)
        : (group.surfaceIds[0] ?? null);
    return activeSurfaceId === group.activeSurfaceId ? group : { ...group, activeSurfaceId };
  });
  const focusedGroupId = groups.some((group) => group.id === state.focusedGroupId)
    ? state.focusedGroupId
    : (groups[0]?.id ?? CENTER_PANEL_ROOT_GROUP_ID);
  return { ...state, groups, focusedGroupId };
}

function clampRatio(ratio: number): number {
  return Math.max(MIN_CENTER_PANEL_SPLIT_RATIO, Math.min(MAX_CENTER_PANEL_SPLIT_RATIO, ratio));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return values.filter(
    (value, index) => typeof value === "string" && values.indexOf(value) === index,
  );
}

function stateEquals(left: CenterPanelLayoutState, right: CenterPanelLayoutState): boolean {
  return (
    left.focusedGroupId === right.focusedGroupId &&
    left.groups.length === right.groups.length &&
    left.groups.every((group, index) => groupEquals(group, right.groups[index])) &&
    layoutEquals(left.layout, right.layout)
  );
}

function groupEquals(left: CenterPanelGroup, right: CenterPanelGroup | undefined): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.activeSurfaceId === right.activeSurfaceId &&
    left.surfaceIds.length === right.surfaceIds.length &&
    left.surfaceIds.every((surfaceId, index) => surfaceId === right.surfaceIds[index])
  );
}

function layoutEquals(left: CenterPanelLayoutNode, right: CenterPanelLayoutNode): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "leaf" && right.type === "leaf") return left.groupId === right.groupId;
  if (left.type === "split" && right.type === "split") {
    return (
      left.direction === right.direction &&
      left.ratio === right.ratio &&
      layoutEquals(left.first, right.first) &&
      layoutEquals(left.second, right.second)
    );
  }
  return false;
}
