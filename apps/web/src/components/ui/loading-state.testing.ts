import { expect } from "vite-plus/test";

/**
 * Asserts the loading model of `loading-state.tsx` through the accessibility relations:
 * the named statuses are exactly `statuses` (one per read), no status is busy or has a
 * busy ancestor, and at least one busy region exists, none of them hidden from assistive
 * technology. `otherWaits` names statuses of waits that are not reads (preparing code, for
 * example), which may or may not be on screen; they are held to the same rules.
 */
export function expectLoadingModel(
  root: ParentNode,
  statuses: readonly string[],
  otherWaits: readonly string[] = [],
) {
  const found = [...root.querySelectorAll('[role="status"]')];
  const name = (status: Element) => status.getAttribute("aria-label") ?? status.textContent ?? "";
  expect(found.map(name).filter((label) => !otherWaits.includes(label.trim()))).toEqual(statuses);
  for (const status of found) {
    expect(status.closest('[aria-busy="true"]'), name(status)).toBeNull();
  }
  const busy = [...root.querySelectorAll('[aria-busy="true"]')];
  expect(busy.length).toBeGreaterThan(0);
  for (const region of busy) expect(region.closest('[aria-hidden="true"]')).toBeNull();
}
