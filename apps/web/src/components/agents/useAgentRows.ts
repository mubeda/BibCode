import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import { offShellThreads } from "@bibcode/client-runtime/state/off-shell-threads";
import { useEffect, useMemo } from "react";

import {
  type AgentEvidenceStamp,
  useAgentRowFreshness,
  useAgentTerminalSources,
  useRecordAgentEvidence,
} from "../../hooks/useAgentFreshness";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { isShellCapped, requestThreadShells, useOffShellThreadShells } from "../../state/offShell";
import { useEnvironmentShellSummary } from "../../state/shell";
import {
  type AgentRow,
  buildAgentRows,
  mergeOffShellThreads,
  resolveAgentCheckouts,
  terminalHostsMissing,
} from "../sidebar/agentsSection.logic";
import { useAgentLiveBranches } from "./useAgentLiveBranches";

/**
 * Every agent row across connected environments, as the Agents view and the
 * left panel's Inbox list them: chat and AI Terminal agents, each checkout's
 * live branch, and the status clock that decays a silent agent and marks a
 * disconnected one offline. One build per update; both views read it, so they
 * cannot disagree.
 */
export function useAgentRows(): ReadonlyArray<AgentRow> {
  const liveShells = useThreadShells();
  const offShells = useOffShellThreadShells();
  // Older agents paged into Done, and terminal hosts a capped shell left out (#223).
  const shells = useMemo(
    () => mergeOffShellThreads(liveShells, offShells),
    [liveShells, offShells],
  );
  const projects = useProjects();
  const { environments } = useEnvironments();
  const availability = useEnvironmentShellSummary().statuses;

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
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const terminalSources = useAgentTerminalSources(environmentIds);
  // A terminal whose host the capped shell left out is resolved, never dropped (#223).
  const missingHosts = useMemo(
    () => terminalHostsMissing(shells, terminalSources),
    [shells, terminalSources],
  );
  useEffect(() => {
    for (const [environmentId, threadIds] of missingHosts) {
      if (!isShellCapped(environmentId)) continue;
      const missing = offShellThreads.get(environmentId).missing;
      const unknown = threadIds.filter((threadId) => !missing.has(threadId));
      if (unknown.length > 0) void requestThreadShells(environmentId, unknown);
    }
  }, [missingHosts]);
  // Only a list with a status that can decay re-renders on the status clock.
  const decayable = useMemo(
    () =>
      shells.some(
        (shell) => shell.session?.status === "running" || shell.session?.status === "starting",
      ) ||
      terminalSources.some((source) =>
        source.rows.some((terminal) => terminal.agentStatus?.state === "working"),
      ),
    [shells, terminalSources],
  );
  const freshness = useAgentRowFreshness(decayable);
  const { rows, evidence } = useMemo(() => {
    const liveBranchByThreadKey = new Map<string, string>();
    for (const [threadKey, checkoutKey] of checkoutKeyByThreadKey) {
      const branch = liveBranchByCheckoutKey.get(checkoutKey);
      if (branch !== undefined) liveBranchByThreadKey.set(threadKey, branch);
    }
    const evidence: AgentEvidenceStamp[] = [];
    const rows = buildAgentRows({
      shells,
      projectTitleById: new Map<string, string>(
        projects.map((project) => [project.id, project.title]),
      ),
      environmentLabelById: new Map<string, string>(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
      availabilityByEnvironmentId,
      liveBranchByThreadKey,
      terminals: terminalSources,
      freshness: freshness(evidence),
    });
    return { rows, evidence };
  }, [
    availabilityByEnvironmentId,
    checkoutKeyByThreadKey,
    environments,
    freshness,
    liveBranchByCheckoutKey,
    projects,
    shells,
    terminalSources,
  ]);
  useRecordAgentEvidence(evidence);
  return rows;
}
