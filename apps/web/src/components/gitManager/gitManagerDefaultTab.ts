import type { GitManagerInProgressOperation } from "@bibcode/contracts";

import type { GitManagerTab } from "../../gitManagerStore";

/**
 * A pending merge must remain on Changes so it can be finished there. Once the
 * working tree is known to be clean, History becomes the useful default. Dirty
 * or still-loading status preserves the tab the user already selected.
 */
export function resolveGitManagerDefaultTab(
  inProgressOperation: GitManagerInProgressOperation | null | undefined,
  hasWorkingTreeChanges: boolean | undefined,
): GitManagerTab | null {
  if (inProgressOperation?.kind === "merge") return "changes";
  return hasWorkingTreeChanges === false ? "history" : null;
}
