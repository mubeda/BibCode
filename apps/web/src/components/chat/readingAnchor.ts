import { createContext } from "react";
import { flushSync } from "react-dom";

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
  /**
   * The same for a commit React makes from new props, such as a reply's final text replacing
   * a block's source: records where `element` ends before that commit and returns the step
   * that scrolls by its change once the commit is in the DOM, or null when the element does
   * not start above the line the user reads.
   */
  readonly holdReadingPosition: (element: HTMLElement) => (() => void) | null;
}

export const ReadingAnchorContext = createContext<ReadingAnchor | null>(null);

interface ReadingAnchorList {
  readonly getState?: () =>
    | {
        readonly scroll?: number;
        /**
         * The list is within `maintainScrollAtEnd`'s threshold, where it scrolls back to its
         * end after a size change. Its wider `isNearEnd` threshold holds nothing.
         */
        readonly isWithinMaintainScrollAtEndThreshold?: boolean;
      }
    | undefined;
  readonly scrollToOffset: (params: { offset: number; animated?: boolean }) => unknown;
}

export interface ReadingAnchorTimeline {
  readonly list: ReadingAnchorList | null;
  readonly viewport: HTMLElement | null;
  /** The sent-row anchor holds the list, so following the end does not hold the line. */
  readonly anchoringEndSpace: boolean;
}

/**
 * The timeline's hold on the reading line across one height change of `element`. LegendList
 * keeps the first visible row's top in place when a row changes size, which holds the reading
 * line for rows wholly above the viewport. Inside the first visible row, content below a
 * growing element still moves, so the list scrolls by the element's change, as a work-group
 * toggle does. While the list is close enough to its end for `maintainScrollAtEnd` to act,
 * that already holds the newest line.
 */
export function holdTimelineReadingPosition(
  timeline: ReadingAnchorTimeline,
  element: HTMLElement,
): (() => void) | null {
  const { list, viewport } = timeline;
  const row = element.closest<HTMLElement>("[data-timeline-root]");
  if (!list || !viewport || !row) return null;
  const before = element.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const followingEnd =
    !timeline.anchoringEndSpace && list.getState?.()?.isWithinMaintainScrollAtEndThreshold === true;
  const aboveReadingLine = isAboveReadingLine({
    elementTop: before.top,
    rowTop: rowBox.top,
    rowBottom: rowBox.bottom,
    viewportTop: viewport.getBoundingClientRect().top,
    followingEnd,
  });
  if (!aboveReadingLine) return null;
  return () => {
    const delta = element.getBoundingClientRect().bottom - before.bottom;
    const scroll = list.getState?.()?.scroll;
    if (Math.abs(delta) >= 0.5 && typeof scroll === "number") {
      list.scrollToOffset({ offset: scroll + delta, animated: false });
    }
  };
}

/**
 * Commits a swap that changes `element`'s height under the timeline's hold on the reading
 * line: synchronously, so the change can be measured, when the element is above that line.
 */
export function preserveTimelineReadingPosition(
  timeline: ReadingAnchorTimeline,
  element: HTMLElement,
  commit: () => void,
): void {
  const restore = holdTimelineReadingPosition(timeline, element);
  if (!restore) {
    commit();
    return;
  }
  flushSync(commit);
  restore();
}
