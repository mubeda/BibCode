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
   * height change when `element` starts above the line the user reads or the list is at its
   * end.
   */
  readonly preserveReadingPosition: (element: HTMLElement, commit: () => void) => void;
  /**
   * The same for a commit React makes from new props, such as a reply's final text replacing
   * a block's source: records where `element` ends before that commit and returns the step
   * that scrolls by its change once the commit is in the DOM, or null when the change moves
   * nothing the user reads.
   */
  readonly holdReadingPosition: (element: HTMLElement) => (() => void) | null;
}

export const ReadingAnchorContext = createContext<ReadingAnchor | null>(null);

interface ReadingAnchorList {
  readonly getState?: () =>
    | {
        readonly scroll?: number;
        /**
         * The list is within `maintainScrollAtEnd`'s threshold of its end. Its wider
         * `isNearEnd` threshold is half a viewport.
         */
        readonly isWithinMaintainScrollAtEndThreshold?: boolean;
      }
    | undefined;
  readonly scrollToOffset: (params: { offset: number; animated?: boolean }) => unknown;
}

export interface ReadingAnchorTimeline {
  readonly list: ReadingAnchorList | null;
  readonly viewport: HTMLElement | null;
}

/**
 * The timeline's hold on the reading line across one height change of `element`. LegendList
 * keeps the first visible row's top in place when a row changes size, which holds the reading
 * line for rows wholly above the viewport. Inside the first visible row, content below a
 * growing element still moves, so the list scrolls by the element's change, as a work-group
 * toggle does.
 *
 * At the end of the list the newest line is the one read, and a growing element pushes it
 * down: neither `maintainScrollAtEnd` nor the sent-row anchor's follow of new entries follows
 * a row that grows in view (#171). The list scrolls by the growth there too, once it has
 * measured it, since LegendList clamps a scroll to the content size it knows.
 */
export function holdTimelineReadingPosition(
  timeline: ReadingAnchorTimeline,
  element: HTMLElement,
): (() => void) | null {
  const { list, viewport } = timeline;
  const row = element.closest<HTMLElement>("[data-timeline-root]");
  if (!list || !viewport || !row) return null;
  const atEnd = list.getState?.()?.isWithinMaintainScrollAtEndThreshold === true;
  const before = element.getBoundingClientRect();
  if (!atEnd) {
    const rowBox = row.getBoundingClientRect();
    const aboveReadingLine = isAboveReadingLine({
      elementTop: before.top,
      rowTop: rowBox.top,
      rowBottom: rowBox.bottom,
      viewportTop: viewport.getBoundingClientRect().top,
    });
    if (!aboveReadingLine) return null;
  }
  return () => {
    const delta = element.getBoundingClientRect().bottom - before.bottom;
    const scroll = list.getState?.()?.scroll;
    if (Math.abs(delta) < 0.5 || typeof scroll !== "number") return;
    if (!atEnd) {
      list.scrollToOffset({ offset: scroll + delta, animated: false });
      return;
    }
    // A shrink at the end leaves the end in view: the browser clamps the scroll.
    if (delta > 0) followGrowthOnceMeasured(list, scroll, scroll + delta);
  };
}

/**
 * Scrolls the list to `target` two frames from now, once LegendList has measured the growth
 * from its resize observer and laid out its content at the new size. A list the user scrolled
 * up from `from` meanwhile, or one another follow already took to `target`, stays put.
 */
function followGrowthOnceMeasured(list: ReadingAnchorList, from: number, target: number): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const scroll = list.getState?.()?.scroll;
      if (typeof scroll !== "number" || scroll < from - 1 || scroll >= target - 0.5) return;
      list.scrollToOffset({ offset: target, animated: false });
    });
  });
}

/**
 * Commits a swap that changes `element`'s height under the timeline's hold on the reading
 * line: synchronously, so the change can be measured, when the element is above that line or
 * the list is at its end.
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
