import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@bibcode/client-runtime/state/models";
import type { EnvironmentShellAvailability } from "@bibcode/client-runtime/state/shell";
import { memo, useMemo } from "react";

import { buildAgentRows } from "./agentsSection.logic";
import type { InboxAgentRowFields } from "./inbox/agentRowContract";
import { useAgentsUnread } from "./useAgentsUnread";

function isChatRow(row: InboxAgentRowFields): boolean {
  return (row.terminalId ?? null) === null;
}

export interface AgentsUnreadTrackerProps {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<Pick<EnvironmentProject, "id" | "title">>;
  readonly environments: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
  readonly availability: ReadonlyArray<
    Pick<EnvironmentShellAvailability, "environmentId" | "status">
  >;
}

/**
 * The left panel's one unread detector. It stays mounted across the
 * Environments, Repositories and Inbox views: the detector compares each turn
 * with the one it saw before, so remounting it on a view switch would miss a
 * turn that settles in the same update. The panel passes the data it already
 * subscribes to. Terminal rows read their host thread's unread state and never
 * feed it.
 */
export const AgentsUnreadTracker = memo(function AgentsUnreadTracker({
  shells,
  projects,
  environments,
  availability,
}: AgentsUnreadTrackerProps) {
  const chatRows = useMemo(
    () =>
      buildAgentRows({
        shells,
        projectTitleById: new Map(projects.map((project) => [project.id, project.title])),
        environmentLabelById: new Map(
          environments.map((environment) => [environment.environmentId, environment.label]),
        ),
        availabilityByEnvironmentId: new Map(
          availability.map(({ environmentId, status }) => [environmentId, status]),
        ),
      }).filter(isChatRow),
    [availability, environments, projects, shells],
  );
  useAgentsUnread(chatRows);
  return null;
});
