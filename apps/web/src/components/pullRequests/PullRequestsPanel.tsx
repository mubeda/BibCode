import { projectKey } from "@bibcode/client-runtime/state/entities";
import type { ScopedProjectRef } from "@bibcode/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { usePullRequestsStore, type PullRequestsDetailTab } from "../../pullRequestsStore";
import { useProject, useServerConfigs } from "../../state/entities";
import { useEnvironmentConnectionState } from "../../state/environments";
import { pullRequestsEnvironment } from "../../state/pullRequests";
import { useEnvironmentQuery } from "../../state/query";
import { worktreeEnvironment } from "../../state/worktrees";
import { GitHubIcon, GitLabIcon } from "../Icons";
import { GitManagerCreatePullRequestDialog } from "../gitManager/provider/GitManagerCreatePullRequestDialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import {
  PullRequestsListView,
  type PullRequestsListViewHandle,
  type PullRequestsListViewProps,
} from "./list/PullRequestsListView";
import {
  PULL_REQUESTS_DISABLED_IN_SETTINGS_MESSAGE,
  resolvePullRequestsAvailability,
  resolvePullRequestsMutationsDisabledReason,
} from "./pullRequestsAvailability";
import { PullRequestsContextRefresh } from "./pullRequestsContextRefresh";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { PullRequestsDetailView } from "./detail/PullRequestsDetailView";
import { PullRequestsPermissionButton } from "./shared/PullRequestsPermissionButton";

export interface PullRequestsPanelProps {
  projectRef: ScopedProjectRef;
  number?: number;
  tab?: PullRequestsDetailTab;
}

// A checkout change remounts this boundary so a dialog or old list cannot cross scopes.
function AvailablePullRequests({
  projectRef,
  number,
  tab = "conversation",
  scope,
  context,
  mutationsDisabledReason,
  onRescan,
  isPending,
  children,
}: PullRequestsPanelProps &
  Omit<PullRequestsListViewProps, "ref"> & {
    mutationsDisabledReason: string | null;
    onRescan: () => void;
    isPending: boolean;
    children: React.ReactNode;
  }) {
  const listRef = useRef<PullRequestsListViewHandle>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const openPrLink = useOpenPrLink();
  const vocabulary = context.capabilities.vocabulary;
  const Icon = context.provider === "github" ? GitHubIcon : GitLabIcon;
  const customHost = context.host !== "github.com" && context.host !== "gitlab.com";
  const refresh = () => (number === undefined ? listRef.current?.refresh() : onRescan());
  return (
    <section
      aria-label="Pull Requests"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-panel-separator px-4 py-3">
        <Icon aria-hidden="true" className="size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{context.repository}</p>
          <p className="text-xs text-muted-foreground">
            {customHost ? `${context.host} · ` : ""}
            {context.account.login}
          </p>
        </div>
        {children}
        {number === undefined ? (
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCwIcon aria-hidden="true" />
            Refresh
          </Button>
        ) : null}
        <PullRequestsPermissionButton
          variant="outline"
          size="sm"
          onClick={onRescan}
          permission={{
            allowed: !isPending,
            reason: isPending ? "Scanning repository context…" : null,
          }}
        >
          Rescan
        </PullRequestsPermissionButton>
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
            New {vocabulary.pullRequest}
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
      </header>
      {number === undefined ? (
        <PullRequestsListView
          ref={listRef}
          scope={scope}
          projectRef={projectRef}
          context={context}
        />
      ) : (
        <PullRequestsDetailView
          key={number}
          scope={scope}
          projectRef={projectRef}
          context={context}
          number={number}
          tab={tab}
          mutationsDisabledReason={mutationsDisabledReason}
        />
      )}
      {createOpen ? (
        <GitManagerCreatePullRequestDialog
          open
          scope={scope}
          onOpenChange={setCreateOpen}
          onSettled={refresh}
        />
      ) : null}
    </section>
  );
}

export function PullRequestsPanel({ projectRef, number, tab }: PullRequestsPanelProps) {
  const { environmentId, projectId } = projectRef;
  const stableProjectRef = useMemo(
    () => ({ environmentId, projectId }),
    [environmentId, projectId],
  );
  const project = useProject(stableProjectRef);
  const connection = useEnvironmentConnectionState(environmentId);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const enabled = usePrimarySettings((settings) => settings.pullRequestsEnabled);
  const availability = resolvePullRequestsAvailability(connection.data, serverConfig, enabled);
  const ready = availability.kind === "ready";
  const storeKey = projectKey(stableProjectRef);
  const storedCwd = usePullRequestsStore(
    (state) => state.byProjectKey[storeKey]?.checkoutCwd ?? null,
  );
  const cwd = storedCwd ?? project?.workspaceRoot ?? null;
  const catalogProjectId = project?.id ?? null;
  const catalogAtom = useMemo(
    () =>
      ready && catalogProjectId !== null
        ? worktreeEnvironment.catalog({ environmentId, input: { projectId: catalogProjectId } })
        : null,
    [ready, catalogProjectId, environmentId],
  );
  const contextAtom = useMemo(
    () =>
      ready && cwd !== null && catalogProjectId !== null
        ? pullRequestsEnvironment.getContext({ environmentId, input: { cwd } })
        : null,
    [ready, catalogProjectId, cwd, environmentId],
  );
  const catalog = useEnvironmentQuery(catalogAtom);
  const query = useEnvironmentQuery(contextAtom);
  const scope = useMemo(() => ({ environmentId, cwd: cwd ?? "" }), [environmentId, cwd]);
  const worktreeOptions = useMemo(() => {
    const main = project?.workspaceRoot;
    const options = main ? [{ value: main, label: "Main checkout" }] : [];
    for (const worktree of catalog.data?.worktrees ?? []) {
      if (worktree.path === main || worktree.isBare) continue;
      options.push({ value: worktree.path, label: worktree.branch ?? worktree.path });
    }
    if (cwd !== null && !options.some((option) => option.value === cwd))
      options.push({ value: cwd, label: cwd });
    return options;
  }, [catalog.data, cwd, project?.workspaceRoot]);
  useEffect(() => {
    usePullRequestsStore.getState().touchProject({ environmentId, projectId });
  }, [environmentId, projectId]);
  useEffect(() => {
    if (number !== undefined)
      usePullRequestsStore.getState().setLastNumber({ environmentId, projectId }, number);
  }, [environmentId, number, projectId]);
  const rescan = () => {
    query.refresh();
    catalog.refresh();
  };
  const worktreeStatus =
    catalog.error ?? (catalog.isPending && catalog.data === null ? "Loading worktrees…" : null);
  const checkoutSelector = (
    <div className="w-48">
      <Select
        modal={false}
        items={worktreeOptions}
        value={cwd}
        onValueChange={(value) => {
          if (value !== null)
            usePullRequestsStore.getState().setCheckoutCwd(stableProjectRef, value);
        }}
      >
        <SelectTrigger
          aria-label="Worktree"
          aria-describedby={worktreeStatus ? "pull-requests-worktree-status" : undefined}
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {worktreeOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className="flex flex-col">
                <span>{option.label}</span>
                <span className="text-xs text-muted-foreground">{option.value}</span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {worktreeStatus ? (
        <p id="pull-requests-worktree-status" className="text-xs text-muted-foreground">
          {worktreeStatus}
        </p>
      ) : null}
    </div>
  );
  if (availability.kind !== "ready") {
    const reason =
      availability.kind === "disabled_in_settings"
        ? PULL_REQUESTS_DISABLED_IN_SETTINGS_MESSAGE
        : availability.kind === "unsupported"
          ? "This environment does not support Pull Requests."
          : availability.reason;
    return (
      <PullRequestsUnavailableState
        reason={reason}
        disabledInSettings={availability.kind === "disabled_in_settings"}
      />
    );
  }
  if (!project || cwd === null)
    return <PullRequestsUnavailableState reason="Waiting for project data." />;
  if (query.error !== null || query.data?.status === "unavailable") {
    const unavailable = query.data?.status === "unavailable" ? query.data : null;
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <div className="border-b border-panel-separator p-3">{checkoutSelector}</div>
        <PullRequestsUnavailableState
          reason={query.error ?? unavailable!.message}
          authCommand={unavailable?.authCommand ?? null}
          installHint={unavailable?.installHint ?? null}
          onRescan={rescan}
          isPending={query.isPending}
        />
      </div>
    );
  }
  if (query.data === null)
    return (
      <div role="status" className="space-y-3 p-4">
        <span className="sr-only">Loading Pull Requests…</span>
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  return (
    <PullRequestsContextRefresh value={query.refresh}>
      <AvailablePullRequests
        key={JSON.stringify([
          storeKey,
          cwd,
          query.data.provider,
          query.data.host,
          query.data.repository,
          query.data.account.login,
        ])}
        projectRef={stableProjectRef}
        {...(number === undefined ? {} : { number })}
        {...(tab === undefined ? {} : { tab })}
        scope={scope}
        context={query.data}
        mutationsDisabledReason={resolvePullRequestsMutationsDisabledReason(serverConfig)}
        onRescan={rescan}
        isPending={query.isPending}
      >
        {checkoutSelector}
      </AvailablePullRequests>
    </PullRequestsContextRefresh>
  );
}
