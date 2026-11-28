import { projectKey } from "@bibcode/client-runtime/state/entities";
import type { PullRequestsProviderKind, ScopedProjectRef } from "@bibcode/contracts";
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
import {
  type EmbeddedPipelinesNavigation,
  EmbeddedPipelinesNavigationProvider,
  PipelineLinksProvider,
  pipelinePageLinks,
} from "./detail/PipelineLinks";
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
export interface PipelineRoute {
  readonly pipelineId: number;
  readonly attempt: number | null;
  /** The job whose log shows beside the stages (`?job=`). */
  readonly jobId: number | null;
  readonly jobLogOffset?: number | null;
}

function AvailablePipelines({
  filters,
  onFiltersChange,
  pipeline,
  onJobChange,
}: {
  filters: PipelinesFilters;
  onFiltersChange: (filters: PipelinesFilters) => void;
  pipeline: PipelineRoute | null;
  onJobChange: (jobId: number | null) => void;
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
            jobId={pipeline.jobId}
            onJobChange={onJobChange}
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
  jobId = null,
  mode = "page",
  embeddedState,
  onEmbeddedStateChange,
  onOpenMergeRequest,
}: {
  projectRef: ScopedProjectRef;
  search?: PipelinesRouteSearch;
  pipelineId?: number;
  attempt?: number | null;
  jobId?: number | null;
  mode?: "page" | "embedded";
  embeddedState?: PipelineRoute | null;
  onEmbeddedStateChange?: (next: PipelineRoute | null) => void;
  onOpenMergeRequest?: (target: {
    readonly number: number;
    readonly provider: PullRequestsProviderKind;
    readonly cwd?: string;
  }) => void;
}) {
  const navigate = useNavigate();
  const { environmentId, projectId } = projectRef;
  const embedded = mode === "embedded";
  const currentScopeKey = `${environmentId}:${projectId}`;
  const [localEmbeddedState, setLocalEmbeddedState] = useState<{
    readonly scopeKey: string;
    readonly route: PipelineRoute | null;
  }>({
    scopeKey: currentScopeKey,
    route: null,
  });
  const controlledEmbedded = embedded && onEmbeddedStateChange !== undefined;
  const embeddedPipeline = controlledEmbedded
    ? (embeddedState ?? null)
    : localEmbeddedState.scopeKey === currentScopeKey
      ? localEmbeddedState.route
      : null;
  const updateEmbeddedPipeline = useCallback(
    (updater: (current: PipelineRoute | null) => PipelineRoute | null) => {
      if (controlledEmbedded) {
        onEmbeddedStateChange!(updater(embeddedPipeline));
        return;
      }
      setLocalEmbeddedState((current) => {
        const base = current.scopeKey === currentScopeKey ? current.route : null;
        return { scopeKey: currentScopeKey, route: updater(base) };
      });
    },
    [controlledEmbedded, currentScopeKey, embeddedPipeline, onEmbeddedStateChange],
  );
  const storedFilters = usePipelinesStore(
    (state) => state.byProjectKey[projectKey(projectRef)]?.filters ?? DEFAULT_PIPELINES_FILTERS,
  );
  const shown = shownFilters(search, storedFilters);
  const { scope, ref, workflowId } = shown;
  const filters = useMemo(() => ({ scope, ref, workflowId }), [ref, scope, workflowId]);
  const pipeline = useMemo<PipelineRoute | null>(() => {
    if (embedded) return embeddedPipeline;
    return pipelineId === undefined ? null : { pipelineId, attempt, jobId };
  }, [attempt, embedded, embeddedPipeline, jobId, pipelineId]);
  const firstPagePrefetch = usePipelinesFirstPagePrefetch(projectRef.environmentId, filters);
  const shell = useRepositoryModuleShell({
    projectRef,
    module: pipelinesModule,
    view: pipeline === null ? "list" : "detail",
    firstPagePrefetch,
  });
  // A copied link or Back opens on the route's filters; remember them for the project.
  useEffect(() => {
    const store = usePipelinesStore.getState();
    if (!sameFilters(store.selectViewState(projectRef).filters, filters))
      store.setFilters(projectRef, filters);
  }, [filters, projectRef]);
  const setFilters = useCallback(
    (next: PipelinesFilters) => {
      usePipelinesStore.getState().setFilters({ environmentId, projectId }, next);
      if (embedded) return;
      void navigate({
        to: "/project/$environmentId/$projectId/pipelines",
        params: { environmentId, projectId },
        search: filtersSearch(next),
        replace: true,
      });
    },
    [embedded, environmentId, navigate, projectId],
  );
  // Opening or closing a log is a history step, so Back undoes it; switching between
  // logs replaces the step instead of stacking one per job.
  const setJob = useCallback(
    (next: number | null) => {
      if (embedded) {
        updateEmbeddedPipeline((current) =>
          current === null ? null : { ...current, jobId: next, jobLogOffset: null },
        );
        return;
      }
      if (pipelineId === undefined) return;
      void navigate({
        to: "/project/$environmentId/$projectId/pipelines/$pipelineId",
        params: { environmentId, projectId, pipelineId: String(pipelineId) },
        search: {
          ...(attempt === null ? {} : { attempt }),
          ...(next === null ? {} : { job: next }),
        },
        replace: jobId !== null && next !== null,
      });
    },
    [
      attempt,
      embedded,
      environmentId,
      jobId,
      navigate,
      pipelineId,
      projectId,
      updateEmbeddedPipeline,
    ],
  );
  const embeddedJobLogOffset = embeddedPipeline?.jobLogOffset ?? null;
  const embeddedNavigation = useMemo<EmbeddedPipelinesNavigation | null>(() => {
    if (!embedded) return null;
    return {
      openPipeline: (nextPipelineId, options) => {
        updateEmbeddedPipeline(() => ({
          pipelineId: nextPipelineId,
          attempt: options?.attempt ?? null,
          jobId: options?.jobId ?? null,
          jobLogOffset: options?.jobLogOffset ?? null,
        }));
      },
      backToList: () => {
        updateEmbeddedPipeline(() => null);
      },
      selectAttempt: (nextAttempt) => {
        updateEmbeddedPipeline((current) =>
          current === null
            ? null
            : {
                pipelineId: current.pipelineId,
                attempt: nextAttempt,
                jobId: null,
                jobLogOffset: null,
              },
        );
      },
      jobLogOffset: embeddedJobLogOffset,
      setJobLogOffset: (offset) => {
        updateEmbeddedPipeline((current) =>
          current === null ? null : { ...current, jobLogOffset: offset },
        );
      },
      openMergeRequest: onOpenMergeRequest,
    };
  }, [embedded, embeddedJobLogOffset, onOpenMergeRequest, updateEmbeddedPipeline]);
  const content = (
    <RepositoryModule.Provider value={shell}>
      <RepositoryModule.Gate>
        <AvailablePipelines
          filters={filters}
          onFiltersChange={setFilters}
          pipeline={pipeline}
          onJobChange={setJob}
        />
      </RepositoryModule.Gate>
    </RepositoryModule.Provider>
  );
  return embeddedNavigation !== null ? (
    <EmbeddedPipelinesNavigationProvider value={embeddedNavigation}>
      {content}
    </EmbeddedPipelinesNavigationProvider>
  ) : (
    content
  );
}
