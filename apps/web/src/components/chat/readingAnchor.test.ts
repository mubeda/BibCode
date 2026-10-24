import { describe, expect, it, vi } from "vite-plus/test";

import { preserveTimelineReadingPosition } from "./readingAnchor";

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
  isAtEnd = false,
  anchoringEndSpace = false,
}: {
  elementBox: Box;
  rowBox: Box;
  scroll?: number;
  isAtEnd?: boolean;
  anchoringEndSpace?: boolean;
}) {
  const row = { getBoundingClientRect: () => ({ ...rowBox }) };
  const target = element(elementBox, row);
  const scrollToOffset = vi.fn();
  const timeline = {
    list: { getState: () => ({ scroll, isAtEnd }), scrollToOffset },
    viewport: { getBoundingClientRect: () => ({ top: 100, bottom: 700 }) } as HTMLElement,
    anchoringEndSpace,
  };
  const anchor = {
    preserveReadingPosition: (target: HTMLElement, commit: () => void) =>
      preserveTimelineReadingPosition(timeline, target, commit),
  };
  return { anchor, target, scrollToOffset, elementBox };
}

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
    ["an element in view", { top: 300, bottom: 400 }, { top: 50, bottom: 800 }, false, false],
    [
      "a row wholly above the viewport",
      { top: -300, bottom: -100 },
      { top: -400, bottom: 50 },
      false,
      false,
    ],
    [
      "a list that follows its end",
      { top: -200, bottom: 0 },
      { top: -400, bottom: 500 },
      true,
      false,
    ],
  ])("only commits for %s", (_name, elementBox, rowBox, isAtEnd, anchoringEndSpace) => {
    const { anchor, target, scrollToOffset } = setup({
      elementBox,
      rowBox,
      isAtEnd,
      anchoringEndSpace,
    });
    const commit = vi.fn();
    anchor.preserveReadingPosition(target, commit);
    expect(commit).toHaveBeenCalledOnce();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it("compensates at the end while the sent-row anchor holds the list instead", () => {
    const { anchor, target, scrollToOffset, elementBox } = setup({
      elementBox: { top: -200, bottom: 0 },
      rowBox: { top: -400, bottom: 500 },
      isAtEnd: true,
      anchoringEndSpace: true,
    });
    anchor.preserveReadingPosition(target, () => {
      elementBox.bottom = -40;
    });
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 960, animated: false });
  });

  it("commits without measuring outside a timeline row", () => {
    const scrollToOffset = vi.fn();
    const commit = vi.fn();
    preserveTimelineReadingPosition(
      {
        list: { getState: () => ({ scroll: 0 }), scrollToOffset },
        viewport: { getBoundingClientRect: () => ({ top: 0, bottom: 600 }) } as HTMLElement,
        anchoringEndSpace: false,
      },
      element({ top: -100, bottom: 0 }, null),
      commit,
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
});
