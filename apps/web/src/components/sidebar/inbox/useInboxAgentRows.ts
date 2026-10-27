import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import { useMemo } from "react";

import { isDesktopLocalConnectionTarget } from "../../../connection/desktopLocal";
import { useProjects, useThreadShells } from "../../../state/entities";
import { useEnvironments } from "../../../state/environments";
import { useEnvironmentShellSummary } from "../../../state/shell";
import { useAgentLiveBranches } from "../../agents/useAgentLiveBranches";
import { type AgentRow, buildAgentRows, resolveAgentCheckouts } from "../agentsSection.logic";
import {
  type InboxDataState,
  type InboxEnvironmentInfo,
  type InboxPartialReason,
  resolveInboxDataState,
  resolveInboxPartialReason,
} from "./inbox.logic";

/**
 * Every agent row across connected environments, built as the Agents view
 * builds them (checkout live branches included), plus how complete they are
 * and, when they are not, why. Unread tracking is the left panel's
 * `AgentsUnreadTracker`, which stays mounted across views.
 */
export function useInboxAgentRows(): {
  readonly rows: ReadonlyArray<AgentRow>;
  readonly dataState: InboxDataState;
  readonly partialReason: InboxPartialReason | null;
} {
  const shells = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const shellSummary = useEnvironmentShellSummary();
  const availability = shellSummary.statuses;
  const availabilityByEnvironmentId = useMemo(
    () =>
      new Map<string, EnvironmentAvailabilityStatus>(
        availability.map(({ environmentId, status }) => [environmentId, status]),
      ),
    [availability],
  );
  const { checkoutKeyByThreadKey, checkouts } = useMemo(
    () => resolveAgentCheckouts({ shells, projects, availabilityByEnvironmentId }),
    [availabilityByEnvironmentId, projects, shells],
  );
  const liveBranchByCheckoutKey = useAgentLiveBranches(checkouts);
  const rows = useMemo(() => {
    const liveBranchByThreadKey = new Map<string, string>();
    for (const [threadKey, checkoutKey] of checkoutKeyByThreadKey) {
      const branch = liveBranchByCheckoutKey.get(checkoutKey);
      if (branch !== undefined) liveBranchByThreadKey.set(threadKey, branch);
    }
    return buildAgentRows({
      shells,
      projectTitleById: new Map(projects.map((project) => [project.id, project.title])),
      environmentLabelById: new Map(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
      availabilityByEnvironmentId,
      liveBranchByThreadKey,
    });
  }, [
    availabilityByEnvironmentId,
    checkoutKeyByThreadKey,
    environments,
    liveBranchByCheckoutKey,
    projects,
    shells,
  ]);
  const environmentById = useMemo(
    () =>
      new Map<string, InboxEnvironmentInfo>(
        environments.map((environment) => [
          environment.environmentId,
          {
            label: environment.label,
            remote:
              environment.entry.target._tag !== "PrimaryConnectionTarget" &&
              !isDesktopLocalConnectionTarget(environment.entry.target),
          },
        ]),
      ),
    [environments],
  );
  const dataState = resolveInboxDataState(shellSummary);
  const partialReason = useMemo(
    () =>
      dataState === "partial" ? resolveInboxPartialReason(shellSummary, environmentById) : null,
    [dataState, environmentById, shellSummary],
  );
  return { rows, dataState, partialReason };
}
