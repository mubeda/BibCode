import type { GitManagerInProgressOperation } from "@bibcode/contracts";

import type { GitManagerTab } from "../../gitManagerStore";

/**
 * History is the tab the manager opens on. Changes opens instead only while a
 * merge is in progress, because that merge can only be finished (conflicts
 * resolved, merge commit made) from the Changes tab.
 */
export function resolveGitManagerDefaultTab(
  inProgressOperation: GitManagerInProgressOperation | null | undefined,
): GitManagerTab {
  return inProgressOperation?.kind === "merge" ? "changes" : "history";
}
