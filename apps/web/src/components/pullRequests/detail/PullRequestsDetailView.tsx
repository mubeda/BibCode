import {
  resolveChangeRequestPresentationForKind,
  formatChangeRequestNumber,
} from "@bibcode/shared/sourceControl";
import { useAtomRefresh } from "@effect/atom-react";
import type { EnvironmentId, PullRequestsContext, ScopedProjectRef } from "@bibcode/contracts";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo } from "react";
import { PullRequestsActionProvider } from "../usePullRequestsAction";
import { usePullRequestsStore, type PullRequestsDetailTab } from "../../../pullRequestsStore";
import { pullRequestsEnvironment } from "../../../state/pullRequests";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../../ui/tabs";
import { Button } from "../../ui/button";
import { usePullRequestsQuery } from "../shared/usePullRequestsQuery";
import { PullRequestsQueryState } from "./PullRequestsQueryState";
import { PullRequestsHeader } from "./PullRequestsHeader";
import { PullRequestsConversation } from "./PullRequestsConversation";
import { PullRequestsSideColumn } from "./PullRequestsSideColumn";
import { PullRequestsCommits } from "./PullRequestsCommits";
import { PullRequestsChecks } from "./PullRequestsChecks";
const PullRequestsFiles = lazy(() =>
  import("./PullRequestsFiles").then((module) => ({ default: module.PullRequestsFiles })),
);
export interface PullRequestsDetailViewProps {
  scope: { environmentId: EnvironmentId; cwd: string };
  projectRef: ScopedProjectRef;
  context: Extract<PullRequestsContext, { status: "available" }>;
  number: number;
  tab: PullRequestsDetailTab;
  mutationsDisabledReason?: string | null;
}
export function PullRequestsDetailView({
  scope,
  projectRef,
  context,
  number,
  tab,
  mutationsDisabledReason = null,
}: PullRequestsDetailViewProps) {
  const navigate = useNavigate();
  const request = useMemo(
    () => ({ environmentId: scope.environmentId, input: { cwd: scope.cwd, number } }),
    [number, scope.cwd, scope.environmentId],
  );
  const detailQuery = usePullRequestsQuery(
    useMemo(() => pullRequestsEnvironment.get(request), [request]),
  );
  const timelineAtom = useMemo(() => pullRequestsEnvironment.getTimeline(request), [request]);
  const commitsAtom = useMemo(() => pullRequestsEnvironment.getCommits(request), [request]);
  const filesAtom = useMemo(() => pullRequestsEnvironment.getFiles(request), [request]);
  const checksAtom = useMemo(() => pullRequestsEnvironment.getChecks(request), [request]);
  const timelineQuery = usePullRequestsQuery(
    tab === "conversation" || tab === "files" ? timelineAtom : null,
  );
  const commitsQuery = usePullRequestsQuery(tab === "commits" ? commitsAtom : null);
  const checksQuery = usePullRequestsQuery(tab === "checks" ? checksAtom : null);
  const filesQuery = usePullRequestsQuery(tab === "files" ? filesAtom : null);
  // Refreshing an inactive atom invalidates its cache without mounting another query.
  const refreshTimelineAtom = useAtomRefresh(timelineAtom);
  const refreshCommitsAtom = useAtomRefresh(commitsAtom);
  const refreshFilesAtom = useAtomRefresh(filesAtom);
  const refreshChecksAtom = useAtomRefresh(checksAtom);
  const navigateAfterAction = useCallback(
    (target: number | null) => {
      if (target === null)
        void navigate({
          to: "/project/$environmentId/$projectId/pull-requests",
          params: projectRef,
        });
      else
        void navigate({
          to: "/project/$environmentId/$projectId/pull-requests/$number",
          params: { ...projectRef, number: String(target) },
          search: { tab: "conversation" },
          hash: "",
        });
    },
    [navigate, projectRef],
  );
  const actionRefresh = useMemo(
    () => ({
      get: detailQuery.refresh,
      timeline:
        tab === "conversation" || tab === "files" ? timelineQuery.refresh : refreshTimelineAtom,
      files: tab === "files" ? filesQuery.refresh : refreshFilesAtom,
      commits: tab === "commits" ? commitsQuery.refresh : refreshCommitsAtom,
      checks: tab === "checks" ? checksQuery.refresh : refreshChecksAtom,
      navigate: navigateAfterAction,
    }),
    [
      detailQuery.refresh,
      tab,
      timelineQuery.refresh,
      filesQuery.refresh,
      commitsQuery.refresh,
      refreshTimelineAtom,
      refreshFilesAtom,
      refreshCommitsAtom,
      checksQuery.refresh,
      refreshChecksAtom,
      navigateAfterAction,
    ],
  );
  const activeQuery = {
    conversation: timelineQuery,
    commits: commitsQuery,
    checks: checksQuery,
    files: filesQuery,
  }[tab];
  useEffect(() => {
    usePullRequestsStore.getState().setLastNumber(projectRef, number);
  }, [number, projectRef]);
  const vocabulary = context.capabilities.vocabulary;
  const presentation = resolveChangeRequestPresentationForKind(context.provider);
  const labels = {
    conversation: "Conversation",
    commits: "Commits",
    checks: vocabulary.checks,
    files: vocabulary.filesChanged,
  };
  const detail = detailQuery.data;
  const refreshing = detailQuery.isPending || activeQuery.isPending;
  const refreshDetail = detailQuery.refresh;
  const refreshTab = activeQuery.refresh;
  const refreshTimeline = timelineQuery.refresh;
  const refresh = useCallback(() => {
    refreshDetail();
    refreshTab();
    if (tab === "files") refreshTimeline();
  }, [refreshDetail, refreshTab, tab, refreshTimeline]);
  return (
    <PullRequestsActionProvider
      key={JSON.stringify([scope.environmentId, scope.cwd, number])}
      scope={scope}
      number={number}
      requestKind={presentation.longName}
      refresh={actionRefresh}
      disabledReason={mutationsDisabledReason}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-text-surface="background">
        <div className="shrink-0 px-4 pt-2">
          <Button
            size="sm"
            variant="link"
            onClick={() => {
              void navigate({
                to: "/project/$environmentId/$projectId/pull-requests",
                params: projectRef,
              });
            }}
          >
            Back to {presentation.pluralLongName}
          </Button>
        </div>
        <PullRequestsQueryState
          query={detailQuery}
          label={`${presentation.longName} ${formatChangeRequestNumber(context.provider, number)}`}
        >
          {detail ? (
            <>
              <PullRequestsHeader
                scope={scope}
                projectRef={projectRef}
                detail={detail}
                context={context}
                onRefresh={refresh}
                refreshing={refreshing}
              />
              <Tabs
                value={tab}
                className="min-h-0 flex-1 gap-0"
                onValueChange={(value) => {
                  if (
                    value === "conversation" ||
                    value === "commits" ||
                    value === "checks" ||
                    value === "files"
                  )
                    void navigate({
                      to: "/project/$environmentId/$projectId/pull-requests/$number",
                      params: { ...projectRef, number: String(number) },
                      search: { tab: value },
                      hash: "",
                      replace: true,
                    });
                }}
              >
                <TabsList
                  aria-label={`${presentation.longName} sections`}
                  className="mx-4 max-w-full shrink-0 overflow-x-auto"
                >
                  {(Object.keys(labels) as PullRequestsDetailTab[]).map((value) => (
                    <TabsTab key={value} value={value}>
                      {labels[value]}
                      {detail.tabCounts[value] === null ? "" : ` ${detail.tabCounts[value]}`}
                    </TabsTab>
                  ))}
                </TabsList>
                <div className="flex min-h-0 flex-1">
                  <TabsPanel value={tab} className="min-h-0 flex-1 gap-0">
                    <PullRequestsQueryState key={tab} query={activeQuery} label={labels[tab]}>
                      {tab === "conversation" && timelineQuery.data ? (
                        <PullRequestsConversation
                          scope={scope}
                          detail={detail}
                          context={context}
                          projectRef={projectRef}
                          timeline={timelineQuery.data}
                          detailsRefreshing={detailQuery.isPending}
                        />
                      ) : tab === "commits" && commitsQuery.data ? (
                        <PullRequestsCommits commits={commitsQuery.data} />
                      ) : tab === "checks" && checksQuery.data ? (
                        <PullRequestsChecks checks={checksQuery.data} context={context} />
                      ) : tab === "files" && filesQuery.data ? (
                        <Suspense
                          fallback={
                            <p role="status" className="p-4 text-sm">
                              Preparing diffs…
                            </p>
                          }
                        >
                          <PullRequestsQueryState query={timelineQuery} label="Review threads">
                            {timelineQuery.data ? (
                              <PullRequestsFiles
                                timeline={timelineQuery.data}
                                files={filesQuery.data}
                                detail={detail}
                                projectRef={projectRef}
                                context={context}
                              />
                            ) : null}
                          </PullRequestsQueryState>
                        </Suspense>
                      ) : null}
                    </PullRequestsQueryState>
                  </TabsPanel>
                  <div className="hidden w-64 shrink-0 overflow-auto border-l border-border lg:block">
                    <PullRequestsSideColumn
                      detail={detail}
                      context={context}
                      scope={scope}
                      projectRef={projectRef}
                      detailsRefreshing={detailQuery.isPending}
                    />
                  </div>
                </div>
              </Tabs>
            </>
          ) : null}
        </PullRequestsQueryState>
      </div>
    </PullRequestsActionProvider>
  );
}
