import { describe, expect, it } from "vite-plus/test";
import {
  getAnchoredTurnMetrics,
  getRowBottom,
  getSentRowLandingDelta,
  getTimelinePageScrollOffset,
  isAboveReadingLine,
  keyboardScrollStopsLiveFollow,
  rowToggleNeedsEndReveal,
  type TimelineScrollMode,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline page scrolling", () => {
  // 1000px list, 200px of it under the composer: 800px visible, so a page is 700px.
  const page = (scroll: number, direction: -1 | 1) =>
    getTimelinePageScrollOffset({
      state: { scroll, scrollLength: 1000, contentLength: 5000 },
      composerOverlayHeight: 200,
      direction,
    });

  it("moves about one visible page and stops at either end", () => {
    expect(page(2000, 1)).toBe(2700);
    expect(page(2000, -1)).toBe(1300);
    expect(page(300, -1)).toBe(0);
    expect(page(3800, 1)).toBe(4000);
    expect(page(4000, 1)).toBe(4000);
  });
});

describe("timeline scroll anchoring", () => {
  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it("reports overflow only for the current anchored turn", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it("returns the minimal positive scroll delta needed to reveal the turn end", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it("subtracts composer height from usable viewport height", () => {
    const state = buildState({
      positions: [0, 300],
      sizes: [120, 470],
      scrollLength: 700,
    });

    const withoutComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 0,
      anchorOffset: 16,
    });
    const withComposer = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 220,
      anchorOffset: 16,
    });

    expect(withoutComposer?.overflowsUsableViewport).toBe(false);
    expect(withComposer?.overflowsUsableViewport).toBe(true);
  });
});

describe("rowToggleNeedsEndReveal", () => {
  it("asks for one reveal pass only for a toggle at the end of an anchored turn", () => {
    const toggle = (mode: TimelineScrollMode, scrollDeltaToRevealEnd: number | null) =>
      rowToggleNeedsEndReveal({ mode, scrollDeltaToRevealEnd });
    expect(toggle("anchoring-new-turn", 0)).toBe(true);
    expect(toggle("anchoring-new-turn", 1)).toBe(true);
    // Scrolled up from the turn's end, by a scroll the timeline may not have seen: the reader
    // keeps their place.
    expect(toggle("anchoring-new-turn", 1_014)).toBe(false);
    expect(toggle("anchoring-new-turn", null)).toBe(false);
    // Following the end keeps it in view by itself; a reader scrolled away keeps their place.
    expect(toggle("following-end", 0)).toBe(false);
    expect(toggle("free-scrolling", 0)).toBe(false);
    expect(toggle("free-scrolling", 400)).toBe(false);
  });
});

describe("reading line", () => {
  const base = { rowTop: -300, rowBottom: 400, viewportTop: 0 };

  it("is below an element that starts above the visible top inside the first visible row", () => {
    expect(isAboveReadingLine({ ...base, elementTop: -120 })).toBe(true);
    expect(isAboveReadingLine({ ...base, rowTop: 0, elementTop: -1 })).toBe(true);
  });

  it("leaves a row wholly above the viewport to the list's own anchoring", () => {
    expect(isAboveReadingLine({ ...base, rowTop: -900, rowBottom: -200, elementTop: -500 })).toBe(
      false,
    );
    expect(isAboveReadingLine({ ...base, rowTop: -900, rowBottom: 0, elementTop: -500 })).toBe(
      false,
    );
  });

  it("ignores an element in view and rows below the first visible one", () => {
    expect(isAboveReadingLine({ ...base, elementTop: 10 })).toBe(false);
    expect(isAboveReadingLine({ ...base, elementTop: 0 })).toBe(false);
    expect(isAboveReadingLine({ ...base, rowTop: 40, rowBottom: 500, elementTop: 80 })).toBe(false);
  });
});

describe("keyboard scrolling of the timeline", () => {
  // 1000 px of content in a 400 px scroller, so the end is at 600.
  const scroller = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 });
  /** A target that matches the selectors in `matches`, as `Element.closest` would. */
  const target = (matches: readonly string[] = [], isContentEditable = false) => ({
    isContentEditable,
    closest: (selector: string) =>
      selector.split(",").some((part) => matches.includes(part.trim())) ? {} : null,
  });
  const press = (
    key: string,
    options: {
      readonly shiftKey?: boolean;
      readonly defaultPrevented?: boolean;
      readonly target?: unknown;
      readonly scrollTop?: number;
    } = {},
  ) =>
    keyboardScrollStopsLiveFollow(
      {
        key,
        shiftKey: options.shiftKey ?? false,
        defaultPrevented: options.defaultPrevented ?? false,
        target: (options.target ?? target()) as EventTarget,
      },
      scroller(options.scrollTop ?? 300),
    );

  it("stops following for every key that scrolls the timeline", () => {
    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]) {
      expect(press(key)).toBe(true);
    }
    expect(press(" ", { shiftKey: true })).toBe(true);
    expect(press("ArrowUp", { target: target(["button"]) })).toBe(true);
  });

  it("leaves following on for keys that do not scroll it", () => {
    expect(press("ArrowLeft")).toBe(false);
    expect(press("Enter")).toBe(false);
    expect(press("a")).toBe(false);
  });

  it("leaves following on when a control owns the key", () => {
    expect(press("ArrowDown", { defaultPrevented: true })).toBe(false);
    expect(press(" ", { target: target(["button"]) })).toBe(false);
    expect(press(" ", { target: target(["summary"]) })).toBe(false);
  });

  it("leaves following on while the key edits text", () => {
    expect(press("ArrowUp", { target: target(["textarea"]) })).toBe(false);
    expect(press("End", { target: target(["input"]) })).toBe(false);
    expect(press("ArrowDown", { target: target(["select"]) })).toBe(false);
    expect(press("PageUp", { target: target([], true) })).toBe(false);
  });

  it("leaves following on when the list is already at the end the key moves toward", () => {
    for (const key of ["ArrowDown", "PageDown", "End", " "]) {
      expect(press(key, { scrollTop: 600 })).toBe(false);
      expect(press(key, { scrollTop: 599.5 })).toBe(false);
      expect(press(key, { scrollTop: 0 })).toBe(true);
    }
    for (const key of ["ArrowUp", "PageUp", "Home"]) {
      expect(press(key, { scrollTop: 0 })).toBe(false);
      expect(press(key, { scrollTop: 600 })).toBe(true);
    }
    expect(press(" ", { shiftKey: true, scrollTop: 0 })).toBe(false);
  });
});

describe("sent row landing", () => {
  it("measures how far the row rests from its offset below the scroller's top", () => {
    expect(getSentRowLandingDelta({ rowTop: 140, viewportTop: 100, anchorOffset: 16 })).toBe(24);
    expect(getSentRowLandingDelta({ rowTop: 104, viewportTop: 100, anchorOffset: 16 })).toBe(-12);
  });

  it("leaves a row within a pixel of its offset where it is", () => {
    expect(getSentRowLandingDelta({ rowTop: 116, viewportTop: 100, anchorOffset: 16 })).toBeNull();
    expect(getSentRowLandingDelta({ rowTop: 117, viewportTop: 100, anchorOffset: 16 })).toBeNull();
    expect(getSentRowLandingDelta({ rowTop: 114.5, viewportTop: 100, anchorOffset: 16 })).toBe(
      -1.5,
    );
  });
});
