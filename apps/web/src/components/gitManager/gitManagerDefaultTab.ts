import type { GitManagerInProgressOperation } from "@bibcode/contracts";

import type { GitManagerTab } from "../../gitManagerStore";

/**
 * A pending merge must remain on Changes so it can be finished there. Once the
 * working tree is known to be clean, History becomes the useful default. Dirty
 * or still-loading status preserves the tab the user already selected, and so
 * does the Tags tab: it is unrelated to the working tree, so a clean transition
 * never pulls the user away from it.
 */
export function resolveGitManagerDefaultTab(
  inProgressOperation: GitManagerInProgressOperation | null | undefined,
  hasWorkingTreeChanges: boolean | undefined,
  currentTab: GitManagerTab = "history",
): GitManagerTab | null {
  if (inProgressOperation?.kind === "merge") return "changes";
  if (currentTab === "tags") return null;
  return hasWorkingTreeChanges === false ? "history" : null;
}
