import type { EnvironmentId, ScopedProjectRef } from "@bibcode/contracts";
import type { ToOptions } from "@tanstack/react-router";
import { createContext, use, useMemo, type ReactNode } from "react";
import { usePrimarySettings } from "../../../hooks/useSettings";
import { useServerConfigs } from "../../../state/entities";
import { useEnvironmentConnectionState } from "../../../state/environments";
import { resolveRepositoryModuleAvailability } from "../../repositoryModule/repositoryModuleAvailability";
import { pipelineJobLink } from "../job/pipelineJobRoute";

/**
 * Where a merge request's pipeline views open the Pipelines module. Each answer is
 * `null` when the module cannot open it, and the caller keeps the host link alone.
 */
export interface MergeRequestPipelineLinks {
  /** A check's job page, when the server named the job's route ids. */
  readonly job: (check: {
    readonly pipelineId?: number | undefined;
    readonly jobId?: number | undefined;
  }) => ToOptions | null;
  readonly pipeline: (pipelineId: number) => ToOptions | null;
}

const NO_PIPELINE_LINKS: MergeRequestPipelineLinks = { job: () => null, pipeline: () => null };

/** The links for one project, or none while the Pipelines module cannot open there. */
export function mergeRequestPipelineLinks(
  projectRef: ScopedProjectRef,
  ready: boolean,
): MergeRequestPipelineLinks {
  if (!ready) return NO_PIPELINE_LINKS;
  const { environmentId, projectId } = projectRef;
  return {
    job: ({ pipelineId, jobId }) =>
      pipelineId === undefined || jobId === undefined
        ? null
        : pipelineJobLink({ environmentId, projectId, pipelineId, jobId }),
    pipeline: (pipelineId) => ({
      to: "/project/$environmentId/$projectId/pipelines/$pipelineId",
      params: { environmentId, projectId, pipelineId: String(pipelineId) },
    }),
  };
}

/**
 * The Pipelines module's read gate. Not `pipelinesModule` itself, which would pull the
 * Pipelines runtime into the Pull Requests route's chunk.
 */
const PIPELINES_READS = { label: "Pipelines", readsCapability: "pipelinesReads" } as const;

/** Whether the Pipelines module would open for this environment: its setting and its server. */
function usePipelinesModuleReady(environmentId: EnvironmentId): boolean {
  const enabled = usePrimarySettings((settings) => settings.pipelinesEnabled);
  const connectionState = useEnvironmentConnectionState(environmentId).data;
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  return (
    resolveRepositoryModuleAvailability(PIPELINES_READS, connectionState, serverConfig, enabled)
      .kind === "ready"
  );
}

const MergeRequestPipelineLinksContext =
  createContext<MergeRequestPipelineLinks>(NO_PIPELINE_LINKS);

/** Gives a merge request's checks and pipeline summary their in-app Pipelines links. */
export function MergeRequestPipelineLinksProvider({
  projectRef,
  children,
}: {
  projectRef: ScopedProjectRef;
  children: ReactNode;
}) {
  const { environmentId, projectId } = projectRef;
  const ready = usePipelinesModuleReady(environmentId);
  const links = useMemo(
    () => mergeRequestPipelineLinks({ environmentId, projectId }, ready),
    [environmentId, projectId, ready],
  );
  return (
    <MergeRequestPipelineLinksContext value={links}>{children}</MergeRequestPipelineLinksContext>
  );
}

export function useMergeRequestPipelineLinks(): MergeRequestPipelineLinks {
  return use(MergeRequestPipelineLinksContext);
}
