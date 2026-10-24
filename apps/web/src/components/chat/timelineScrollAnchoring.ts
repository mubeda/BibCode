export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

/** Programmatic timeline scrolls jump instead of gliding when the user asks for reduced motion. */
export function timelineScrollAnimates(): boolean {
  return (
    typeof window === "undefined" ||
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** A page step as a browser takes one: 87.5% of what is visible, so the reader keeps context. */
const TIMELINE_PAGE_STEP_FRACTION = 0.875;

/** Where PageUp (-1) or PageDown (1) scrolls the timeline, within the list's scroll range. */
export function getTimelinePageScrollOffset({
  state,
  composerOverlayHeight,
  direction,
}: {
  readonly state: {
    readonly scroll: number;
    readonly scrollLength: number;
    readonly contentLength: number;
  };
  readonly composerOverlayHeight: number;
  readonly direction: -1 | 1;
}): number {
  const visibleHeight = Math.max(0, state.scrollLength - composerOverlayHeight);
  const maxScroll = Math.max(0, state.contentLength - state.scrollLength);
  const offset = state.scroll + direction * visibleHeight * TIMELINE_PAGE_STEP_FRACTION;
  return Math.min(maxScroll, Math.max(0, offset));
}

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}
