import { projectKey } from "@bibcode/client-runtime/state/entities";
import type { ScopedProjectRef } from "@bibcode/contracts";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PIPELINES_FILTERS,
  usePipelinesStore,
  type PipelinesFilters,
} from "../../pipelinesStore";
import {
  RepositoryModule,
  useRepositoryModule,
  useRepositoryModuleShell,
} from "../repositoryModule/RepositoryModule";
import { RepositoryModuleExternalLink } from "../repositoryModule/RepositoryModuleExternalLink";
import { PermissionButton } from "../ui/permission-button";
import { PipelineLinksProvider, pipelinePageLinks } from "./detail/PipelineLinks";
import { PipelinesDetailView, type PipelinesDetailViewHandle } from "./detail/PipelinesDetailView";
import { PipelinesListView, type PipelinesListViewHandle } from "./list/PipelinesListView";
import {
  filtersSearch,
  sameFilters,
  shownFilters,
  type PipelinesRouteSearch,
} from "./list/pipelinesList.logic";
import { pipelinesModule, usePipelinesFirstPagePrefetch } from "./pipelinesModule";

const HOST_NAMES = { github: "GitHub", gitlab: "GitLab" } as const;

/** The pipeline a route shows; absent on the list route. */
interface PipelineRoute {
  readonly pipelineId: number;
  readonly attempt: number | null;
}

function AvailablePipelines({
  filters,
  onFiltersChange,
  pipeline,
}: {
  filters: PipelinesFilters;
  onFiltersChange: (filters: PipelinesFilters) => void;
  pipeline: PipelineRoute | null;
}) {
  const {
    context,
    meta: { projectRef },
  } = useRepositoryModule();
  const { environmentId, projectId } = projectRef;
  const pipelineId = pipeline?.pipelineId ?? null;
  // Job rows open the job page; kept stable so the memoized stages skip a re-render.
  const links = useMemo(
    () =>
      pipelineId === null ? null : pipelinePageLinks({ environmentId, projectId, pipelineId }),
    [environmentId, pipelineId, projectId],
  );
  const viewRef = useRef<PipelinesListViewHandle | PipelinesDetailViewHandle>(null);
  const [backedOff, setBackedOff] = useState(false);
  const pipelinesUrl = `${context.webUrl.replace(/\/+$/, "")}/${
    context.provider === "github" ? "actions" : "-/pipelines"
  }`;
  return (
    <section
      aria-label="Pipelines"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <RepositoryModule.Header>
        <RepositoryModule.Identity />
        <RepositoryModule.WorktreeSelect />
        <PermissionButton
          variant="outline"
          size="sm"
          onClick={() => viewRef.current?.refresh()}
          permission={
            backedOff
              ? { allowed: false, reason: "The host asked BiBCode to wait before reading again." }
              : { allowed: true, reason: null }
          }
        >
          <RefreshCwIcon aria-hidden="true" />
          Refresh
        </PermissionButton>
        {/* A pipeline's own header links to its host page. */}
        {pipeline === null ? (
          <RepositoryModuleExternalLink href={pipelinesUrl} className="text-xs">
            Open on {HOST_NAMES[context.provider]}
          </RepositoryModuleExternalLink>
        ) : null}
      </RepositoryModule.Header>
      {pipeline === null || links === null ? (
        <PipelinesListView
          ref={viewRef}
          filters={filters}
          onFiltersChange={onFiltersChange}
          onBackoffChange={setBackedOff}
        />
      ) : (
        <PipelineLinksProvider value={links}>
          <PipelinesDetailView
            key={`${pipeline.pipelineId}:${pipeline.attempt ?? "latest"}`}
            ref={viewRef}
            pipelineId={pipeline.pipelineId}
            attempt={pipeline.attempt}
            onBackoffChange={setBackedOff}
          />
        </PipelineLinksProvider>
      )}
    </section>
  );
}

/**
 * The Pipelines module for one project: the repository module shell with the
 * pipelines list, or with one pipeline on its route. List filters come from the
 * route's search when it names any, and otherwise from the ones last used for the
 * project; a pipeline route uses the remembered ones to join that list's poller.
 */
export function PipelinesPanel({
  projectRef,
  search,
  pipelineId,
  attempt = null,
}: {
  projectRef: ScopedProjectRef;
  search?: PipelinesRouteSearch;
  pipelineId?: number;
  attempt?: number | null;
}) {
  const navigate = useNavigate();
  const storedFilters = usePipelinesStore(
    (state) => state.byProjectKey[projectKey(projectRef)]?.filters ?? DEFAULT_PIPELINES_FILTERS,
  );
  const shown = shownFilters(search, storedFilters);
  const { scope, ref, workflowId } = shown;
  const filters = useMemo(() => ({ scope, ref, workflowId }), [ref, scope, workflowId]);
  const firstPagePrefetch = usePipelinesFirstPagePrefetch(projectRef.environmentId, filters);
  const shell = useRepositoryModuleShell({
    projectRef,
    module: pipelinesModule,
    view: pipelineId === undefined ? "list" : "detail",
    firstPagePrefetch,
  });
  const pipeline = useMemo(
    () => (pipelineId === undefined ? null : { pipelineId, attempt }),
    [attempt, pipelineId],
  );
  // A copied link or Back opens on the route's filters; remember them for the project.
  useEffect(() => {
    const store = usePipelinesStore.getState();
    if (!sameFilters(store.selectViewState(projectRef).filters, filters))
      store.setFilters(projectRef, filters);
  }, [filters, projectRef]);
  const { environmentId, projectId } = projectRef;
  const setFilters = useCallback(
    (next: PipelinesFilters) => {
      usePipelinesStore.getState().setFilters({ environmentId, projectId }, next);
      void navigate({
        to: "/project/$environmentId/$projectId/pipelines",
        params: { environmentId, projectId },
        search: filtersSearch(next),
        replace: true,
      });
    },
    [environmentId, navigate, projectId],
  );
  return (
    <RepositoryModule.Provider value={shell}>
      <RepositoryModule.Gate>
        <AvailablePipelines filters={filters} onFiltersChange={setFilters} pipeline={pipeline} />
      </RepositoryModule.Gate>
    </RepositoryModule.Provider>
  );
}
