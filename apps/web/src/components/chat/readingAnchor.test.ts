import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { holdTimelineReadingPosition, preserveTimelineReadingPosition } from "./readingAnchor";

interface Box {
  top: number;
  bottom: number;
}

function element(box: Box, row: { getBoundingClientRect: () => Box } | null) {
  return {
    getBoundingClientRect: () => ({ ...box }),
    closest: (selector: string) => (selector === "[data-timeline-root]" ? row : null),
  } as unknown as HTMLElement;
}

function setup({
  elementBox,
  rowBox,
  scroll = 1000,
  atEnd = false,
  isNearEnd = atEnd,
}: {
  elementBox: Box;
  rowBox: Box;
  scroll?: number;
  /** The list is within `maintainScrollAtEnd`'s threshold of its end. */
  atEnd?: boolean;
  /** The list is within its wider end-reached threshold, half a viewport. */
  isNearEnd?: boolean;
}) {
  const row = { getBoundingClientRect: () => ({ ...rowBox }) };
  const target = element(elementBox, row);
  const position = { scroll };
  const scrollToOffset = vi.fn(({ offset }: { offset: number }) => {
    position.scroll = offset;
  });
  const timeline = {
    list: {
      getState: () => ({
        scroll: position.scroll,
        isAtEnd: atEnd,
        isNearEnd,
        isWithinMaintainScrollAtEndThreshold: atEnd,
      }),
      scrollToOffset,
    },
    viewport: { getBoundingClientRect: () => ({ top: 100, bottom: 700 }) } as HTMLElement,
  };
  const anchor = {
    preserveReadingPosition: (target: HTMLElement, commit: () => void) =>
      preserveTimelineReadingPosition(timeline, target, commit),
  };
  return { anchor, timeline, target, scrollToOffset, elementBox, position };
}

let frames: FrameRequestCallback[] = [];

/** Runs the callbacks requested before this frame; ones they request wait for the next. */
function runFrame(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback(0);
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("timeline reading anchor", () => {
  it("scrolls by the height change of an element above the reading line in the first row", () => {
    const { anchor, target, scrollToOffset, elementBox } = setup({
      elementBox: { top: -200, bottom: 0 },
      rowBox: { top: -400, bottom: 500 },
    });
    const commit = vi.fn(() => {
      elementBox.bottom = 160;
    });

    anchor.preserveReadingPosition(target, commit);

    expect(commit).toHaveBeenCalledOnce();
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 1160, animated: false });
  });

  it.each([
    ["an element in view", { top: 300, bottom: 400 }, { top: 50, bottom: 800 }],
    ["a row wholly above the viewport", { top: -300, bottom: -100 }, { top: -400, bottom: 50 }],
  ])("only commits for %s away from the end", (_name, elementBox, rowBox) => {
    const { anchor, target, scrollToOffset } = setup({ elementBox, rowBox });
    const commit = vi.fn();
    anchor.preserveReadingPosition(target, commit);
    runFrame();
    runFrame();
    expect(commit).toHaveBeenCalledOnce();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  describe("at the end", () => {
    it.each([
      ["in view", { top: 300, bottom: 400 }, { top: 50, bottom: 800 }],
      ["above the reading line", { top: -200, bottom: 0 }, { top: -400, bottom: 500 }],
    ])(
      "follows an element %s that grows, once the list has measured it",
      (_name, elementBox, rowBox) => {
        const { anchor, target, scrollToOffset } = setup({ elementBox, rowBox, atEnd: true });
        anchor.preserveReadingPosition(target, () => {
          elementBox.bottom += 94;
        });
        // LegendList clamps a scroll to the content size it knows, which grows only once its
        // resize observer has measured the row.
        expect(scrollToOffset).not.toHaveBeenCalled();
        runFrame();
        expect(scrollToOffset).not.toHaveBeenCalled();
        runFrame();
        expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 1094, animated: false });
      },
    );

    it("leaves the end to the browser when an element shrinks", () => {
      const { anchor, target, scrollToOffset, elementBox } = setup({
        elementBox: { top: -200, bottom: 0 },
        rowBox: { top: -400, bottom: 500 },
        atEnd: true,
      });
      anchor.preserveReadingPosition(target, () => {
        elementBox.bottom = -40;
      });
      runFrame();
      runFrame();
      expect(scrollToOffset).not.toHaveBeenCalled();
    });

    it("stays put when the user scrolled up or another follow got there first", () => {
      const scrolledUp = setup({
        elementBox: { top: 300, bottom: 400 },
        rowBox: { top: 50, bottom: 800 },
        atEnd: true,
      });
      scrolledUp.anchor.preserveReadingPosition(scrolledUp.target, () => {
        scrolledUp.elementBox.bottom += 50;
      });
      scrolledUp.position.scroll = 900;
      runFrame();
      runFrame();
      expect(scrolledUp.scrollToOffset).not.toHaveBeenCalled();

      const followed = setup({
        elementBox: { top: 300, bottom: 400 },
        rowBox: { top: 50, bottom: 800 },
        atEnd: true,
      });
      followed.anchor.preserveReadingPosition(followed.target, () => {
        followed.elementBox.bottom += 50;
      });
      followed.position.scroll = 1050;
      runFrame();
      runFrame();
      expect(followed.scrollToOffset).not.toHaveBeenCalled();
    });

    it("follows a growth across a commit made elsewhere, such as new text from props", () => {
      const { timeline, target, scrollToOffset, elementBox } = setup({
        elementBox: { top: 300, bottom: 400 },
        rowBox: { top: 50, bottom: 800 },
        atEnd: true,
      });
      const restore = holdTimelineReadingPosition(timeline, target);
      expect(restore).not.toBeNull();
      elementBox.bottom = 430;
      restore!();
      runFrame();
      runFrame();
      expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 1030, animated: false });
    });
  });

  it("compensates near the end when the list is not within its end threshold", () => {
    // LegendList reports `isNearEnd` within half a viewport of the end, but follows the end
    // only within `maintainScrollAtEnd`'s tenth of one.
    const { anchor, target, scrollToOffset, elementBox } = setup({
      elementBox: { top: -200, bottom: 0 },
      rowBox: { top: -400, bottom: 500 },
      isNearEnd: true,
    });
    anchor.preserveReadingPosition(target, () => {
      elementBox.bottom = 160;
    });
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 1160, animated: false });
  });

  it("holds the line across a commit made elsewhere, such as new text from props", () => {
    const { timeline, target, scrollToOffset, elementBox } = setup({
      elementBox: { top: -200, bottom: 0 },
      rowBox: { top: -400, bottom: 500 },
    });
    const restore = holdTimelineReadingPosition(timeline, target);
    expect(restore).not.toBeNull();
    elementBox.bottom = -80;
    restore!();
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 920, animated: false });

    const { timeline: inView, target: visible } = setup({
      elementBox: { top: 300, bottom: 400 },
      rowBox: { top: 50, bottom: 800 },
    });
    expect(holdTimelineReadingPosition(inView, visible)).toBeNull();
  });

  it("commits without measuring outside a timeline row", () => {
    const scrollToOffset = vi.fn();
    const commit = vi.fn();
    preserveTimelineReadingPosition(
      {
        list: { getState: () => ({ scroll: 0 }), scrollToOffset },
        viewport: { getBoundingClientRect: () => ({ top: 0, bottom: 600 }) } as HTMLElement,
      },
      element({ top: -100, bottom: 0 }, null),
      commit,
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
});
