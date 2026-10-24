import { createContext } from "react";
import { flushSync } from "react-dom";

import { resolveTimelineIsAtEnd, type TimelineEndState } from "./MessagesTimeline.logic";
import { isAboveReadingLine } from "./timelineScrollAnchoring";

/**
 * Lets content that changes its own height (a Mermaid diagram replacing its source) keep the
 * line the user is reading in place. The timeline provides it; elsewhere it is absent and the
 * change commits normally.
 */
export interface ReadingAnchor {
  /**
   * Commits `commit`, a state update that changes `element`'s height, and scrolls by the
   * height change when `element` starts above the line the user reads.
   */
  readonly preserveReadingPosition: (element: HTMLElement, commit: () => void) => void;
}

export const ReadingAnchorContext = createContext<ReadingAnchor | null>(null);

interface ReadingAnchorList {
  readonly getState?: () => (TimelineEndState & { readonly scroll?: number }) | undefined;
  readonly scrollToOffset: (params: { offset: number; animated?: boolean }) => unknown;
}

/**
 * The timeline's reading anchor. LegendList keeps the first visible row's top in place when a
 * row changes size, which holds the reading line for rows wholly above the viewport. Inside the
 * first visible row, content below a growing element still moves, so a swap there is committed
 * synchronously and the list scrolls by the element's change, as a work-group toggle does.
 * While the list follows its end, `maintainScrollAtEnd` already holds the newest line.
 */
export function preserveTimelineReadingPosition(
  timeline: {
    readonly list: ReadingAnchorList | null;
    readonly viewport: HTMLElement | null;
    /** The sent-row anchor holds the list, so following the end does not hold the line. */
    readonly anchoringEndSpace: boolean;
  },
  element: HTMLElement,
  commit: () => void,
): void {
  const { list, viewport } = timeline;
  const row = element.closest<HTMLElement>("[data-timeline-root]");
  if (!list || !viewport || !row) {
    commit();
    return;
  }
  const before = element.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const followingEnd =
    !timeline.anchoringEndSpace && resolveTimelineIsAtEnd(list.getState?.()) === true;
  const aboveReadingLine = isAboveReadingLine({
    elementTop: before.top,
    rowTop: rowBox.top,
    rowBottom: rowBox.bottom,
    viewportTop: viewport.getBoundingClientRect().top,
    followingEnd,
  });
  if (!aboveReadingLine) {
    commit();
    return;
  }
  flushSync(commit);
  const delta = element.getBoundingClientRect().bottom - before.bottom;
  const scroll = list.getState?.()?.scroll;
  if (Math.abs(delta) >= 0.5 && typeof scroll === "number") {
    list.scrollToOffset({ offset: scroll + delta, animated: false });
  }
}
