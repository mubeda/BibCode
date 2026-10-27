import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import { useMemo } from "react";

import { useProjects, useThreadShells } from "../../../state/entities";
import { useEnvironments } from "../../../state/environments";
import { useEnvironmentShellSummary } from "../../../state/shell";
import { useAgentLiveBranches } from "../../agents/useAgentLiveBranches";
import { type AgentRow, buildAgentRows, resolveAgentCheckouts } from "../agentsSection.logic";
import { useAgentsUnread } from "../useAgentsUnread";
import type { InboxAgentRowFields } from "./agentRowContract";
import { type InboxDataState, resolveInboxDataState } from "./inbox.logic";

function isChatRow(row: InboxAgentRowFields): boolean {
  return (row.terminalId ?? null) === null;
}

/**
 * Every agent row across connected environments, built as the Agents view
 * builds them (checkout live branches included), plus how complete they are.
 * The Inbox replaces the Agents nav row, so it also runs the unread detector;
 * terminal rows read their host's unread state and never feed it.
 */
export function useInboxAgentRows(): {
  readonly rows: ReadonlyArray<AgentRow>;
  readonly dataState: InboxDataState;
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
  const chatRows = useMemo(() => rows.filter(isChatRow), [rows]);
  useAgentsUnread(chatRows);
  return { rows, dataState: resolveInboxDataState(shellSummary) };
}
