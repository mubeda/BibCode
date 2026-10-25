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
import { PipelinesListView, type PipelinesListViewHandle } from "./list/PipelinesListView";
import {
  filtersSearch,
  sameFilters,
  shownFilters,
  type PipelinesRouteSearch,
} from "./list/pipelinesList.logic";
import { pipelinesModule, usePipelinesFirstPagePrefetch } from "./pipelinesModule";

const HOST_NAMES = { github: "GitHub", gitlab: "GitLab" } as const;

function AvailablePipelines({
  filters,
  onFiltersChange,
}: {
  filters: PipelinesFilters;
  onFiltersChange: (filters: PipelinesFilters) => void;
}) {
  const { context } = useRepositoryModule();
  const listRef = useRef<PipelinesListViewHandle>(null);
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
          onClick={() => listRef.current?.refresh()}
          permission={
            backedOff
              ? { allowed: false, reason: "The host asked BiBCode to wait before reading again." }
              : { allowed: true, reason: null }
          }
        >
          <RefreshCwIcon aria-hidden="true" />
          Refresh
        </PermissionButton>
        <RepositoryModuleExternalLink href={pipelinesUrl} className="text-xs">
          Open on {HOST_NAMES[context.provider]}
        </RepositoryModuleExternalLink>
      </RepositoryModule.Header>
      <PipelinesListView
        ref={listRef}
        filters={filters}
        onFiltersChange={onFiltersChange}
        onBackoffChange={setBackedOff}
      />
    </section>
  );
}

/**
 * The Pipelines module for one project: the repository module shell with the
 * pipelines list. Filters come from the route's search when it names any, and
 * otherwise from the ones last used for the project.
 */
export function PipelinesPanel({
  projectRef,
  search,
}: {
  projectRef: ScopedProjectRef;
  search: PipelinesRouteSearch;
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
    view: "list",
    firstPagePrefetch,
  });
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
        <AvailablePipelines filters={filters} onFiltersChange={setFilters} />
      </RepositoryModule.Gate>
    </RepositoryModule.Provider>
  );
}
