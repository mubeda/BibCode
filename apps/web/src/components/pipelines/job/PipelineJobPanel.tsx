import { projectKey } from "@bibcode/client-runtime/state/entities";
import type { ScopedProjectRef } from "@bibcode/contracts";
import { DEFAULT_PIPELINES_FILTERS, usePipelinesStore } from "../../../pipelinesStore";
import {
  RepositoryModule,
  useRepositoryModuleShell,
} from "../../repositoryModule/RepositoryModule";
import { pipelinesModule, usePipelinesFirstPagePrefetch } from "../pipelinesModule";
import { PipelineJobView } from "./PipelineJobView";

/**
 * The Pipelines module on one job's page: the repository module shell with the job's
 * header, log and details. It reads with the list filters remembered for the project,
 * so the job shares the list's poller.
 */
export function PipelineJobPanel({
  projectRef,
  pipelineId,
  jobId,
  at,
}: {
  projectRef: ScopedProjectRef;
  pipelineId: number;
  jobId: number;
  /** A line link's byte offset. */
  at: number | null;
}) {
  const filters = usePipelinesStore(
    (state) => state.byProjectKey[projectKey(projectRef)]?.filters ?? DEFAULT_PIPELINES_FILTERS,
  );
  const firstPagePrefetch = usePipelinesFirstPagePrefetch(projectRef.environmentId, filters);
  const shell = useRepositoryModuleShell({
    projectRef,
    module: pipelinesModule,
    view: "detail",
    firstPagePrefetch,
  });
  return (
    <RepositoryModule.Provider value={shell}>
      <RepositoryModule.Gate>
        <PipelineJobView
          key={`${pipelineId}:${jobId}`}
          filters={filters}
          pipelineId={pipelineId}
          jobId={jobId}
          at={at}
        />
      </RepositoryModule.Gate>
    </RepositoryModule.Provider>
  );
}
