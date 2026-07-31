import type { EnvironmentId } from "@bibcode/contracts";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";

export interface ProjectBranchPollingProject {
  /** Stable key for this project, e.g. `scopedProjectKey(environmentId, projectId)`. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface UseProjectBranchPollingResult {
  /** Live checkout branch by project key. Absent key = not yet polled. */
  readonly branchByProjectKey: Map<string, string | null>;
}

/**
 * Keeps the sidebar's primary-row "current branch" label live for the
 * project checkout (as opposed to `thread.branch`, which is static). Mirrors
 * Orca's 3s visibility-aware branch poll (research-orca-project-model.md
 * §1): the ACTIVE project (the one owning the currently routed thread) is
 * refreshed by the `vcs.status` subscription's server-side poller, avoiding a
 * heavyweight `vcs.refreshStatus` request every three seconds.
 */
export function useProjectBranchPolling(input: {
  readonly projects: ReadonlyArray<ProjectBranchPollingProject>;
  readonly activeProjectKey: string | null;
}): UseProjectBranchPollingResult {
  const { activeProjectKey, projects } = input;
  const activeProject = projects.find((project) => project.key === activeProjectKey) ?? null;

  const [branchByProjectKey, setBranchByProjectKey] = useState<Map<string, string | null>>(
    () => new Map(),
  );

  const activeStatusQuery = useEnvironmentQuery(
    activeProject
      ? vcsEnvironment.status({
          environmentId: activeProject.environmentId,
          input: { cwd: activeProject.workspaceRoot },
        })
      : null,
  );

  useEffect(() => {
    if (!activeProject) return;
    const branch = activeStatusQuery.data?.refName ?? null;
    setBranchByProjectKey((current) => {
      if (current.get(activeProject.key) === branch) return current;
      const next = new Map(current);
      next.set(activeProject.key, branch);
      return next;
    });
  }, [activeProject, activeStatusQuery.data]);

  return { branchByProjectKey };
}
