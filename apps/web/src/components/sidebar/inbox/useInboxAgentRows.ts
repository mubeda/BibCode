import { useMemo } from "react";

import { isDesktopLocalConnectionTarget } from "../../../connection/desktopLocal";
import { useEnvironments } from "../../../state/environments";
import { useEnvironmentShellSummary } from "../../../state/shell";
import { useAgentRows } from "../../agents/useAgentRows";
import type { AgentRow } from "../agentsSection.logic";
import {
  type InboxDataState,
  type InboxEnvironmentInfo,
  type InboxPartialReason,
  resolveInboxDataState,
  resolveInboxPartialReason,
} from "./inbox.logic";

/**
 * The Agents view's rows (one shared build, `useAgentRows`), plus how complete
 * they are and, when they are not, why. Unread tracking is the left panel's
 * `AgentsUnreadTracker`, which stays mounted across views.
 */
export function useInboxAgentRows(): {
  readonly rows: ReadonlyArray<AgentRow>;
  readonly dataState: InboxDataState;
  readonly partialReason: InboxPartialReason | null;
} {
  const rows = useAgentRows();
  const { environments } = useEnvironments();
  const shellSummary = useEnvironmentShellSummary();
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
