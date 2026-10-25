import { resolveChangeRequestPresentationForKind } from "@bibcode/shared/sourceControl";
import type { PullRequestsDetail, ScopedProjectRef } from "@bibcode/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { usePullRequestsStore, type PullRequestsDetailTab } from "../../pullRequestsStore";
import { GitManagerCreatePullRequestDialog } from "../gitManager/provider/GitManagerCreatePullRequestDialog";
import {
  RepositoryModule,
  useRepositoryModule,
  useRepositoryModuleShell,
} from "../repositoryModule/RepositoryModule";
import { Button } from "../ui/button";
import { PermissionButton } from "../ui/permission-button";
import { PullRequestsListView, type PullRequestsListViewHandle } from "./list/PullRequestsListView";
import { pullRequestsHostAddress } from "./pullRequestsHost.logic";
import { pullRequestsModule, usePullRequestsFirstPagePrefetch } from "./pullRequestsModule";
import { OpenBesideThreadButton } from "./OpenBesideThreadButton";
import { PullRequestsDetailView } from "./detail/PullRequestsDetailView";
import { PullRequestsRouteNavigation } from "./detail/pullRequestsNavigation";

export interface PullRequestsPanelProps {
  projectRef: ScopedProjectRef;
  number?: number;
  tab?: PullRequestsDetailTab;
}

// The shell remounts this boundary on a checkout change, so a dialog or old list
// cannot cross scopes.
function AvailablePullRequests({
  number,
  tab = "conversation",
}: Pick<PullRequestsPanelProps, "number" | "tab">) {
  const {
    context,
    state: { scope, contextQuery, freshPageKey },
    actions: { rescan, consumeFreshPage },
    meta: { projectRef, mutationsDisabledReason },
  } = useRepositoryModule();
  const listRef = useRef<PullRequestsListViewHandle>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const openPrLink = useOpenPrLink();
  const presentation = resolveChangeRequestPresentationForKind(context.provider);
  // Not a component: the detail view calls this while rendering its header.
  const renderDetailActions = (detail: PullRequestsDetail) => (
    <OpenBesideThreadButton
      projectRef={projectRef}
      number={detail.number}
      provider={context.provider}
      headBranch={detail.headBranch}
    />
  );
  const refresh = () => (number === undefined ? listRef.current?.refresh() : rescan());
  const isPending = contextQuery.isPending;
  // This context already identified the host, so the dialog need not wait for status.
  const providerHint = useMemo(
    () => ({
      kind: context.provider,
      baseUrl: pullRequestsHostAddress({ webUrl: context.webUrl, host: context.host }),
    }),
    [context.host, context.provider, context.webUrl],
  );
  return (
    <section
      aria-label="Pull Requests"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <RepositoryModule.Header>
        <RepositoryModule.Identity />
        <RepositoryModule.WorktreeSelect />
        {number === undefined ? (
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCwIcon aria-hidden="true" />
            Refresh
          </Button>
        ) : null}
        <PermissionButton
          variant="outline"
          size="sm"
          onClick={rescan}
          permission={{
            allowed: !isPending,
            reason: isPending ? "Scanning repository context…" : null,
          }}
        >
          Rescan
        </PermissionButton>
        <span className="inline-flex" title={mutationsDisabledReason ?? undefined}>
          <Button
            size="sm"
            disabled={mutationsDisabledReason !== null}
            title={mutationsDisabledReason ?? undefined}
            aria-describedby={
              mutationsDisabledReason ? "pull-requests-mutations-disabled" : undefined
            }
            aria-haspopup="dialog"
            onClick={() => setCreateOpen(true)}
          >
            New {presentation.longName}
          </Button>
        </span>
        <a
          href={context.webUrl}
          className="text-xs underline underline-offset-4"
          onClick={(event) => openPrLink(event, context.webUrl)}
        >
          Open in browser
        </a>
        {mutationsDisabledReason ? (
          <span id="pull-requests-mutations-disabled" className="sr-only">
            {mutationsDisabledReason}
          </span>
        ) : null}
      </RepositoryModule.Header>
      {number === undefined ? (
        <PullRequestsListView
          ref={listRef}
          scope={scope}
          projectRef={projectRef}
          context={context}
          freshPageKey={freshPageKey}
          onFreshPageConsumed={consumeFreshPage}
        />
      ) : (
        <PullRequestsRouteNavigation projectRef={projectRef} number={number}>
          <PullRequestsDetailView
            key={number}
            scope={scope}
            projectRef={projectRef}
            context={context}
            number={number}
            tab={tab}
            mutationsDisabledReason={mutationsDisabledReason}
            headerActions={renderDetailActions}
          />
        </PullRequestsRouteNavigation>
      )}
      {createOpen ? (
        <GitManagerCreatePullRequestDialog
          open
          scope={scope}
          onOpenChange={setCreateOpen}
          onSettled={refresh}
          providerHint={providerHint}
        />
      ) : null}
    </section>
  );
}

export function PullRequestsPanel({ projectRef, number, tab }: PullRequestsPanelProps) {
  const { environmentId, projectId } = projectRef;
  useEffect(() => {
    usePullRequestsStore.getState().touchProject({ environmentId, projectId });
  }, [environmentId, projectId]);
  useEffect(() => {
    if (number !== undefined)
      usePullRequestsStore.getState().setLastNumber({ environmentId, projectId }, number);
  }, [environmentId, number, projectId]);
  const firstPagePrefetch = usePullRequestsFirstPagePrefetch(projectRef);
  const shell = useRepositoryModuleShell({
    projectRef,
    module: pullRequestsModule,
    view: number === undefined ? "list" : "detail",
    firstPagePrefetch,
  });
  return (
    <RepositoryModule.Provider value={shell}>
      <RepositoryModule.Gate>
        <AvailablePullRequests
          {...(number === undefined ? {} : { number })}
          {...(tab === undefined ? {} : { tab })}
        />
      </RepositoryModule.Gate>
    </RepositoryModule.Provider>
  );
}
