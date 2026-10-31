export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

/**
 * Whether a row the reader just expanded or collapsed needs one pass that reveals the end of
 * the turn (#173). Only an anchored new turn does, and only when the list was at its end:
 * there the end follows `timelineEntries` changes, which a toggle does not make. Following
 * the end already keeps it in view, and a reader scrolled away keeps their place.
 *
 * "At its end" is read from where the turn's end sat before the toggle, not from the
 * timeline's at-end flag: an anchored turn keeps that flag through scrolls it cannot tell
 * from its own, so a reader who scrolled up could otherwise be thrown back to the end.
 */
export function rowToggleNeedsEndReveal(input: {
  readonly mode: TimelineScrollMode;
  /** The anchored turn's `scrollDeltaToRevealEnd` before the toggle, or null without one. */
  readonly scrollDeltaToRevealEnd: number | null;
}): boolean {
  return (
    input.mode === "anchoring-new-turn" &&
    input.scrollDeltaToRevealEnd !== null &&
    input.scrollDeltaToRevealEnd <= 1
  );
}

/** Controls whose press is a click, not the reader taking over the timeline's scroll. */
const TIMELINE_CONTROL_SELECTOR =
  'button, a[href], input, textarea, select, summary, [role="button"]';

/**
 * Whether a pointer press inside the timeline stops live following. A press on a control, such
 * as a Thinking row's toggle (#173), a tool row or a copy button, is a click: the turn keeps
 * following its end, so a toggle at the end can reveal it again. A press anywhere else, such as
 * on the scrollbar or to start selecting text, is the reader taking over.
 */
export function pointerPressStopsLiveFollow(target: EventTarget | null): boolean {
  const element = target as Partial<Pick<Element, "closest">> | null;
  return (
    typeof element?.closest !== "function" || element.closest(TIMELINE_CONTROL_SELECTOR) === null
  );
}

/**
 * Controls that Space activates instead of scrolling. A link is not one: Space on a focused
 * link scrolls the page.
 */
const SPACE_ACTIVATED_CONTROL_SELECTOR =
  'button, input, textarea, select, summary, [role="button"]';

/** Keys that scroll the timeline toward its end, and toward its start. */
const TIMELINE_DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End"]);
const TIMELINE_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/** The parts of a keydown and of the timeline's scroll node the classification reads. */
export interface TimelineScrollKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
}

export interface TimelineScrollKeyScroller {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** The parts of the timeline's scroll node and its document that the takeover listeners use. */
export type TimelineTakeoverScrollNode = Pick<
  HTMLElement,
  | "contains"
  | "addEventListener"
  | "removeEventListener"
  | "scrollTop"
  | "scrollHeight"
  | "clientHeight"
>;
export type TimelineTakeoverDocument = Pick<
  Document,
  "body" | "documentElement" | "addEventListener" | "removeEventListener"
>;

/**
 * How the reader took the timeline's scroll over: a scroll key, the wheel or a touch move
 * (`pointer`), or a press, which scrolls nothing itself.
 */
export type TimelineTakeoverInput = "keyboard" | "pointer" | "press";

/**
 * Listens for the reader taking the timeline's scroll over and calls `onTakeover` (#190): the
 * wheel, a touch move, a pointer press that is not a click on a control, and the scrolling
 * keys. A key counts when it is pressed inside the timeline, or with focus on the page itself
 * after the last press was inside the timeline: clicking its text, or a control a webview does
 * not focus on click (WebKit's buttons), leaves focus on the body, and the browser then scrolls
 * the timeline with the key. Keys are heard on the document after they bubble, so a control's
 * `preventDefault`, including one React makes at its root, is already seen. `onTakeover` is told
 * whether a key, the wheel or a touch, or a press took over: the browser scrolls for a key only
 * after the keydown, and on a slow webview up to several hundred milliseconds later (#207). Returns a function that removes the
 * listeners.
 */
export function bindTimelineTakeoverListeners(
  scrollNode: TimelineTakeoverScrollNode,
  ownerDocument: TimelineTakeoverDocument,
  onTakeover: (input: TimelineTakeoverInput) => void,
): () => void {
  let pressedInTimeline = false;
  const handleNavigation = () => onTakeover("pointer");
  const handlePointerDown = (event: PointerEvent) => {
    if (pointerPressStopsLiveFollow(event.target)) {
      onTakeover("press");
    }
  };
  const handleDocumentPointerDown = (event: PointerEvent) => {
    pressedInTimeline = scrollNode.contains(event.target as Node | null);
  };
  const handleFocusIn = (event: FocusEvent) => {
    if (!scrollNode.contains(event.target as Node | null)) {
      pressedInTimeline = false;
    }
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as Node | null;
    const fromTimeline = scrollNode.contains(target);
    const fromPage =
      target === ownerDocument.body ||
      target === ownerDocument.documentElement ||
      (target as unknown) === ownerDocument;
    if (!fromTimeline && !(fromPage && pressedInTimeline)) {
      return;
    }
    if (keyboardScrollStopsLiveFollow(event, scrollNode)) {
      onTakeover("keyboard");
    }
  };
  scrollNode.addEventListener("wheel", handleNavigation, { passive: true });
  scrollNode.addEventListener("touchmove", handleNavigation, { passive: true });
  scrollNode.addEventListener("pointerdown", handlePointerDown, { passive: true });
  ownerDocument.addEventListener("pointerdown", handleDocumentPointerDown, {
    capture: true,
    passive: true,
  });
  ownerDocument.addEventListener("focusin", handleFocusIn);
  ownerDocument.addEventListener("keydown", handleKeyDown);
  return () => {
    scrollNode.removeEventListener("wheel", handleNavigation);
    scrollNode.removeEventListener("touchmove", handleNavigation);
    scrollNode.removeEventListener("pointerdown", handlePointerDown);
    ownerDocument.removeEventListener("pointerdown", handleDocumentPointerDown, {
      capture: true,
    });
    ownerDocument.removeEventListener("focusin", handleFocusIn);
    ownerDocument.removeEventListener("keydown", handleKeyDown);
  };
}

/**
 * Whether a key pressed inside the timeline's scroller is the reader scrolling it, which stops
 * live following as the wheel does (#190). It is not when a control owned the key (it called
 * `preventDefault`), when the key edits text, when Space activates a focused control, or when
 * the list is already at the end the key moves toward: nothing moves, so following goes on.
 */
export function keyboardScrollStopsLiveFollow(
  event: TimelineScrollKeyEvent,
  scroller: TimelineScrollKeyScroller,
): boolean {
  if (event.defaultPrevented) {
    return false;
  }
  const isSpace = event.key === " ";
  const down = TIMELINE_DOWN_KEYS.has(event.key) || (isSpace && !event.shiftKey);
  const up = TIMELINE_UP_KEYS.has(event.key) || (isSpace && event.shiftKey);
  if (!down && !up) {
    return false;
  }
  const element = event.target as Partial<
    Pick<HTMLElement, "closest" | "isContentEditable">
  > | null;
  if (element?.isContentEditable === true) {
    return false;
  }
  if (typeof element?.closest === "function") {
    if (element.closest("input, textarea, select") !== null) {
      return false;
    }
    if (isSpace && element.closest(SPACE_ACTIVATED_CONTROL_SELECTOR) !== null) {
      return false;
    }
  }
  if (down) {
    return scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 1;
  }
  return scroller.scrollTop > 1;
}

/**
 * How far the timeline must scroll for a sent row to rest `anchorOffset` below the scroller's
 * top, measured on screen (#191), or null when it is already within a pixel of there.
 */
export function getSentRowLandingDelta({
  rowTop,
  viewportTop,
  anchorOffset,
}: {
  readonly rowTop: number;
  readonly viewportTop: number;
  readonly anchorOffset: number;
}): number | null {
  const delta = rowTop - viewportTop - anchorOffset;
  return Math.abs(delta) <= 1 ? null : delta;
}

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

export interface ReadingLineGeometry {
  /** The changing element's top edge, in viewport coordinates like the others. */
  readonly elementTop: number;
  /** The top and bottom edges of the timeline row that holds the element. */
  readonly rowTop: number;
  readonly rowBottom: number;
  /** The top edge of the list's visible area. */
  readonly viewportTop: number;
}

/**
 * Whether a height change of the element would move the line the user reads, so the timeline
 * must scroll by the change: the element starts above the visible top inside the first visible
 * row. The list keeps that row's top in place, so content below the element in the same row
 * would move. A row wholly above the viewport is left to the list, which keeps the first
 * visible row in place when one above it changes size; an element in view moves only content
 * below it.
 */
export function isAboveReadingLine(geometry: ReadingLineGeometry): boolean {
  if (geometry.rowBottom <= geometry.viewportTop || geometry.rowTop > geometry.viewportTop) {
    return false;
  }
  return geometry.elementTop < geometry.viewportTop;
}
