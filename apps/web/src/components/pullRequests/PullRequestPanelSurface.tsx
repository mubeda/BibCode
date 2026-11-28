import { resolveChangeRequestPresentationForKind } from "@bibcode/shared/sourceControl";
import type {
  ScopedProjectRef,
  ScopedThreadRef,
  SourceControlProviderKind,
} from "@bibcode/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { usePrimarySettings } from "../../hooks/useSettings";
import { usePullRequestsStore } from "../../pullRequestsStore";
import {
  type PullRequestRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentConnectionState } from "../../state/environments";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { PullRequestsDetailView } from "./detail/PullRequestsDetailView";
import {
  PullRequestsFileAnchorContext,
  type PullRequestsNavigation,
  PullRequestsNavigationContext,
} from "./detail/pullRequestsNavigation";
import {
  PULL_REQUESTS_DISABLED_IN_SETTINGS_MESSAGE,
  resolvePullRequestsAvailability,
  resolvePullRequestsMutationsDisabledReason,
} from "./pullRequestsAvailability";
import { PullRequestsContextRefresh } from "./pullRequestsContextRefresh";
import { PullRequestsPanel } from "./PullRequestsPanel";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { usePullRequestsContextQuery } from "./usePullRequestsContextQuery";

export interface PullRequestPanelSurfaceProps {
  threadRef: ScopedThreadRef;
  projectRef: ScopedProjectRef | null;
  gitCwd: string | null;
  workspaceUnavailable: string | null;
  surface: PullRequestRightPanelSurface;
}

/** Pull Requests inside a thread's right panel: list view or one selected request. */
export function PullRequestPanelSurface(props: PullRequestPanelSurfaceProps) {
  // A definite width: the detail view lays out by its container's inline size.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PullRequestPanelSurfaceContent {...props} />
    </div>
  );
}

function PullRequestPanelSurfaceContent({
  threadRef,
  projectRef,
  gitCwd,
  workspaceUnavailable,
  surface,
}: PullRequestPanelSurfaceProps) {
  const navigate = useNavigate();
  const { environmentId } = threadRef;
  const projectId = projectRef?.projectId ?? null;
  // The thread view rebuilds its project ref on every thread update; the detail view's
  // effects key on it.
  const stableProjectRef = useMemo(
    () => (projectId === null ? null : { environmentId, projectId }),
    [environmentId, projectId],
  );
  const connection = useEnvironmentConnectionState(environmentId);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const enabled = usePrimarySettings((settings) => settings.pullRequestsEnabled);
  const availability = resolvePullRequestsAvailability(connection.data, serverConfig, enabled);
  const selection = surface.selection;
  const effectiveCwd = selection?.cwd ?? gitCwd;
  // ChatView derives gitCwd from the loaded project, so a cwd means the project is known.
  const usable =
    availability.kind === "ready" &&
    effectiveCwd !== null &&
    workspaceUnavailable === null &&
    selection !== undefined;
  const { query, storedContext, rescan, recover } = usePullRequestsContextQuery({
    environmentId,
    cwd: effectiveCwd,
    enabled: usable,
  });
  const [fileAnchor, setFileAnchor] = useState<string | null>(null);
  const selectedNumber = selection?.number ?? null;
  const selectedProvider = selection?.provider ?? null;
  const handleSelectRequest = useCallback(
    (target: {
      readonly number: number;
      readonly provider: SourceControlProviderKind;
      readonly cwd?: string;
    }) => {
      setFileAnchor(null);
      useRightPanelStore.getState().openPullRequest(threadRef, target);
    },
    [threadRef],
  );
  const navigation = useMemo<PullRequestsNavigation>(() => {
    const store = () => useRightPanelStore.getState();
    const clearSelection = () => {
      setFileAnchor(null);
      store().clearPullRequestSelection(threadRef);
    };
    const goBack = () => {
      setFileAnchor(null);
      const returnSurface = store().consumePullRequestReturnSurface(threadRef);
      if (returnSurface === "pipelines") {
        store().clearPullRequestSelection(threadRef, { preserveFocus: true });
        store().open(threadRef, "pipelines");
        return;
      }
      store().clearPullRequestSelection(threadRef);
    };
    return {
      selectTab: (tab) => {
        if (selectedNumber === null) return;
        store().setPullRequestTab(threadRef, selectedNumber, tab);
      },
      showFile: (path) => {
        if (selectedNumber === null) return;
        setFileAnchor(path);
        store().setPullRequestTab(threadRef, selectedNumber, "files");
      },
      setFileAnchor,
      openRequest: (target) => {
        if (selectedProvider === null) return;
        setFileAnchor(null);
        store().openPullRequest(threadRef, {
          number: target,
          provider: selectedProvider,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        });
      },
      requestGone: clearSelection,
      discardDeleted: () => {
        if (selectedNumber === null || selectedProvider === null) return;
        const current = selectThreadRightPanelState(store().byThreadKey, threadRef).surfaces.find(
          (entry): entry is PullRequestRightPanelSurface => entry.kind === "pullRequest",
        );
        const currentEffectiveCwd = current?.selection?.cwd ?? gitCwd;
        if (
          current?.selection?.number === selectedNumber &&
          current.selection.provider === selectedProvider &&
          currentEffectiveCwd === effectiveCwd
        ) {
          setFileAnchor(null);
          store().clearPullRequestSelection(threadRef, { preserveFocus: true });
        }
      },
      back: goBack,
    };
  }, [effectiveCwd, gitCwd, selectedNumber, selectedProvider, threadRef]);
  const scope = useMemo(
    () => ({ environmentId, cwd: effectiveCwd ?? "" }),
    [effectiveCwd, environmentId],
  );

  if (availability.kind !== "ready") {
    return (
      <PullRequestsUnavailableState
        reason={
          availability.kind === "disabled_in_settings"
            ? PULL_REQUESTS_DISABLED_IN_SETTINGS_MESSAGE
            : availability.kind === "unsupported"
              ? "This environment does not support Pull Requests."
              : availability.reason
        }
        disabledInSettings={availability.kind === "disabled_in_settings"}
      />
    );
  }
  if (workspaceUnavailable !== null) {
    return <PullRequestsUnavailableState reason={workspaceUnavailable} />;
  }
  if (stableProjectRef === null || effectiveCwd === null) {
    return <PullRequestsUnavailableState reason="Waiting for project data." />;
  }
  if (selection === undefined) {
    return (
      <PullRequestsPanel
        projectRef={stableProjectRef}
        mode="embedded"
        onSelectRequest={handleSelectRequest}
      />
    );
  }
  const { number, provider, tab } = selection;
  if ((query.error !== null && !storedContext) || query.data?.status === "unavailable") {
    const unavailable = query.data?.status === "unavailable" ? query.data : null;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center border-b border-border/60 px-3 py-1.5">
          <Button type="button" size="xs" variant="ghost" onClick={() => navigation.back?.()}>
            Back
          </Button>
        </div>
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
  if (query.data === null) {
    return (
      <div role="status" className="space-y-3 p-4">
        <span className="sr-only">
          Loading {resolveChangeRequestPresentationForKind(provider).longName}…
        </span>
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  const openFullPage = () => {
    // The full page reads its checkout from the project's saved choice. Carry the active one,
    // so the page shows the same request against the same checkout; its Worktree picker
    // shows the switch and changes it back in one step, like Git Manager's link.
    usePullRequestsStore.getState().setCheckoutCwd(stableProjectRef, effectiveCwd);
    void navigate({
      to: "/project/$environmentId/$projectId/pull-requests/$number",
      params: { ...stableProjectRef, number: String(number) },
      search: { tab },
    });
  };
  // An element, not a component: the detail view calls headerActions while rendering.
  const openFullPageButton = (
    <Button size="sm" variant="link" onClick={openFullPage}>
      Open full page
    </Button>
  );
  return (
    <PullRequestsContextRefresh value={recover}>
      <PullRequestsNavigationContext value={navigation}>
        <PullRequestsFileAnchorContext value={fileAnchor}>
          <PullRequestsDetailView
            // A different repository or account at the same checkout path remounts the
            // detail, as on the full page: its queries are keyed by checkout and number.
            key={JSON.stringify([
              effectiveCwd,
              number,
              query.data.provider,
              query.data.host,
              query.data.repository,
              query.data.account.login,
            ])}
            scope={scope}
            projectRef={stableProjectRef}
            context={query.data}
            number={number}
            tab={tab}
            mutationsDisabledReason={resolvePullRequestsMutationsDisabledReason(serverConfig)}
            headerActions={() => openFullPageButton}
          />
        </PullRequestsFileAnchorContext>
      </PullRequestsNavigationContext>
    </PullRequestsContextRefresh>
  );
}
