import type { CenterPanelSplitDirection } from "../centerPanelLayout";

const SPLIT_EDGE_THRESHOLD = 0.2;
const MIN_SPLIT_WIDTH = 480;
const MIN_SPLIT_HEIGHT = 320;

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

export interface CenterPanelPoint {
  readonly x: number;
  readonly y: number;
}

export interface CenterPanelRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface CenterPanelTabRect {
  readonly left: number;
  readonly width: number;
}

export interface CenterPanelDropGeometry {
  readonly pane: CenterPanelRect;
  readonly tabStripBottom: number;
}

export interface CenterPanelDropIntentInput {
  readonly point: CenterPanelPoint;
  readonly geometry: CenterPanelDropGeometry;
  readonly groupId: string;
  readonly hoveredTab?: { readonly rect: CenterPanelTabRect; readonly index: number };
}

export function isCenterPanelTabDragData(value: unknown): value is CenterPanelTabDragData {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === "center-panel-tab" &&
    isNonEmptyString(value.surfaceId) &&
    isNonEmptyString(value.groupId) &&
    (value.surfaceKind === "chat-host" ||
      value.surfaceKind === "chat" ||
      value.surfaceKind === "terminal") &&
    isNonEmptyString(value.title)
  );
}

export function isCenterPanelPaneDropData(value: unknown): value is CenterPanelPaneDropData {
  return isRecord(value) && value.type === "center-panel-pane" && isNonEmptyString(value.groupId);
}

export function captureCenterPanelDropGeometry(
  pane: CenterPanelRect,
  tabStrip: CenterPanelRect,
): CenterPanelDropGeometry | null {
  if (!isValidRect(pane) || !isValidRect(tabStrip)) {
    return null;
  }

  if (tabStrip.bottom < pane.top || tabStrip.bottom > pane.bottom) {
    return null;
  }

  return { pane, tabStripBottom: tabStrip.bottom };
}

export function canCenterPanelPaneSplit(
  dimensions: Pick<CenterPanelRect, "width" | "height">,
  direction: CenterPanelSplitDirection,
): boolean {
  if (!isFiniteNumber(dimensions.width) || !isFiniteNumber(dimensions.height)) {
    return false;
  }

  return direction === "left" || direction === "right"
    ? dimensions.width >= MIN_SPLIT_WIDTH
    : dimensions.height >= MIN_SPLIT_HEIGHT;
}

export function resolveCenterPanelSplitDirection(
  point: CenterPanelPoint,
  geometry: CenterPanelDropGeometry,
): CenterPanelSplitDirection | null {
  if (!isFinitePoint(point) || !isValidGeometry(geometry) || !isPointInPaneBody(point, geometry)) {
    return null;
  }

  const bodyHeight = geometry.pane.bottom - geometry.tabStripBottom;
  const candidates: readonly {
    readonly direction: CenterPanelSplitDirection;
    readonly distance: number;
  }[] = [
    { direction: "left", distance: (point.x - geometry.pane.left) / geometry.pane.width },
    { direction: "right", distance: (geometry.pane.right - point.x) / geometry.pane.width },
    { direction: "up", distance: (point.y - geometry.tabStripBottom) / bodyHeight },
    { direction: "down", distance: (geometry.pane.bottom - point.y) / bodyHeight },
  ];

  let resolved: CenterPanelSplitDirection | null = null;
  let resolvedDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.distance <= SPLIT_EDGE_THRESHOLD && candidate.distance < resolvedDistance) {
      resolved = candidate.direction;
      resolvedDistance = candidate.distance;
    }
  }

  return resolved;
}

export function resolveCenterPanelInsertionIndex(
  tab: CenterPanelTabRect,
  index: number,
  pointerX: number,
): number | null {
  if (
    !isFiniteNumber(tab.left) ||
    !isFiniteNumber(tab.width) ||
    tab.width <= 0 ||
    !Number.isInteger(index) ||
    index < 0 ||
    !isFiniteNumber(pointerX)
  ) {
    return null;
  }

  return pointerX < tab.left + tab.width / 2 ? index : index + 1;
}

export function resolveCenterPanelDropIntent(
  input: CenterPanelDropIntentInput,
): CenterPanelDropIntent {
  if (
    !isNonEmptyString(input.groupId) ||
    !isFinitePoint(input.point) ||
    !isValidGeometry(input.geometry)
  ) {
    return { type: "none" };
  }

  const direction = resolveCenterPanelSplitDirection(input.point, input.geometry);
  const paneWidth = input.geometry.pane.right - input.geometry.pane.left;
  const bodyHeight = input.geometry.pane.bottom - input.geometry.tabStripBottom;
  if (
    direction !== null &&
    canCenterPanelPaneSplit({ width: paneWidth, height: bodyHeight }, direction)
  ) {
    return { type: "split", groupId: input.groupId, direction };
  }

  if (!isPointInPane(input.point, input.geometry.pane)) {
    return { type: "none" };
  }

  if (input.hoveredTab !== undefined) {
    const index = resolveCenterPanelInsertionIndex(
      input.hoveredTab.rect,
      input.hoveredTab.index,
      input.point.x,
    );
    if (index !== null) {
      return { type: "insert", groupId: input.groupId, index };
    }
  }

  return isPointInPaneBody(input.point, input.geometry)
    ? { type: "append", groupId: input.groupId }
    : { type: "none" };
}

function isValidGeometry(geometry: CenterPanelDropGeometry): boolean {
  return (
    isValidRect(geometry.pane) &&
    isFiniteNumber(geometry.tabStripBottom) &&
    geometry.tabStripBottom >= geometry.pane.top &&
    geometry.tabStripBottom <= geometry.pane.bottom
  );
}

function isValidRect(rect: CenterPanelRect): boolean {
  return (
    isFiniteNumber(rect.left) &&
    isFiniteNumber(rect.right) &&
    isFiniteNumber(rect.top) &&
    isFiniteNumber(rect.bottom) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > rect.left &&
    rect.bottom > rect.top &&
    rect.right - rect.left === rect.width &&
    rect.bottom - rect.top === rect.height
  );
}

function isPointInPane(point: CenterPanelPoint, pane: CenterPanelRect): boolean {
  return (
    point.x >= pane.left && point.x <= pane.right && point.y >= pane.top && point.y <= pane.bottom
  );
}

function isPointInPaneBody(point: CenterPanelPoint, geometry: CenterPanelDropGeometry): boolean {
  return isPointInPane(point, geometry.pane) && point.y >= geometry.tabStripBottom;
}

function isFinitePoint(point: CenterPanelPoint): boolean {
  return isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
