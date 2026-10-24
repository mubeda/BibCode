import { createContext } from "react";

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
