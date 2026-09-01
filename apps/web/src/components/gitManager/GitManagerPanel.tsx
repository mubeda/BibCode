import { projectKey } from "@bibcode/client-runtime/state/entities";
import type { ScopedProjectRef, VcsWorktreeDescriptor } from "@bibcode/contracts";
import { GitBranchIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_GIT_MANAGER_VIEW_STATE,
  type GitManagerTab,
  useGitManagerStore,
} from "../../gitManagerStore";
import { useProject, useServerConfigs } from "../../state/entities";
import { useEnvironmentConnectionState } from "../../state/environments";
import { gitManagerEnvironment } from "../../state/gitManager";
import { useEnvironmentQuery } from "../../state/query";
import { worktreeEnvironment } from "../../state/worktrees";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import {
  resolveGitManagerAvailability,
  type GitManagerAvailability,
} from "./gitManagerAvailability";
import { GitManagerChangesView } from "./changes/GitManagerChangesView";
import { GitManagerToolbar } from "./GitManagerToolbar";

const EMPTY_WORKTREES: ReadonlyArray<VcsWorktreeDescriptor> = Object.freeze([]);

export interface GitManagerPanelProps {
  readonly projectRef: ScopedProjectRef;
}

interface GitManagerUnavailableStateProps {
  readonly reason: string;
}

const GitManagerUnavailableState = memo(function GitManagerUnavailableState({
  reason,
}: GitManagerUnavailableStateProps) {
  return (
    <section
      aria-live="polite"
      className="flex min-h-0 flex-1 items-center justify-center p-6"
      data-testid="git-manager-unavailable"
    >
      <div className="max-w-md rounded-xl border border-border/70 bg-card/30 px-5 py-4 text-center">
        <GitBranchIcon aria-hidden="true" className="mx-auto mb-3 size-5 text-muted-foreground" />
        <h1 className="text-balance text-sm font-medium text-foreground">
          Git Manager Unavailable
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{reason}</p>
      </div>
    </section>
  );
});

function unavailableReason(
  availability: Exclude<GitManagerAvailability, { readonly kind: "ready" }>,
): string {
  return availability.kind === "unsupported"
    ? `This environment does not support the Git Manager. Missing capability: ${availability.missingCapability}.`
    : availability.reason;
}

function selectedCheckoutCwd(
  storedCwd: string | null,
  mainCheckoutCwd: string,
  worktrees: ReadonlyArray<VcsWorktreeDescriptor>,
): string {
  if (storedCwd === null || storedCwd === mainCheckoutCwd) return mainCheckoutCwd;
  return worktrees.some((worktree) => worktree.path === storedCwd) ? storedCwd : mainCheckoutCwd;
}

export const GitManagerPanel = memo(function GitManagerPanel({ projectRef }: GitManagerPanelProps) {
  const { environmentId, projectId } = projectRef;
  const stableProjectRef = useMemo(
    () => ({ environmentId, projectId }) as ScopedProjectRef,
    [environmentId, projectId],
  );
  const project = useProject(stableProjectRef);
  const connection = useEnvironmentConnectionState(environmentId);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const availability = resolveGitManagerAvailability(connection.data, serverConfig);
  const catalogProjectId = project?.id ?? null;
  const storeKey = projectKey(stableProjectRef);
  const [selectionOwnerKey, setSelectionOwnerKey] = useState<string | null>(null);
  const selectViewState = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey] ?? DEFAULT_GIT_MANAGER_VIEW_STATE,
    [storeKey],
  );
  const viewState = useGitManagerStore(selectViewState);
  const touchProject = useGitManagerStore((state) => state.touchProject);
  const setActiveTab = useGitManagerStore((state) => state.setActiveTab);
  const setSelectedWorktree = useGitManagerStore((state) => state.setSelectedWorktree);

  useEffect(() => {
    touchProject({ environmentId, projectId } as ScopedProjectRef);
  }, [environmentId, projectId, touchProject]);

  const catalogAtom = useMemo(
    () =>
      availability.kind === "ready" && catalogProjectId !== null
        ? worktreeEnvironment.catalog({
            environmentId,
            input: { projectId: catalogProjectId },
          })
        : null,
    [availability.kind, catalogProjectId, environmentId],
  );
  const catalog = useEnvironmentQuery(catalogAtom);
  const worktrees = catalog.data?.worktrees ?? EMPTY_WORKTREES;
  const mainCheckoutCwd = project?.workspaceRoot ?? null;
  const sessionSelectedWorktreeCwd =
    selectionOwnerKey === storeKey ? viewState.selectedWorktreeCwd : null;
  const activeCwd =
    mainCheckoutCwd === null
      ? null
      : selectedCheckoutCwd(sessionSelectedWorktreeCwd, mainCheckoutCwd, worktrees);
  const activeScope = useMemo(
    () => ({ environmentId, cwd: activeCwd ?? "" }),
    [activeCwd, environmentId],
  );
  const signalAtom = useMemo(
    () =>
      availability.kind === "ready" && activeCwd !== null
        ? gitManagerEnvironment.signal({
            environmentId,
            input: { cwd: activeCwd },
          })
        : null,
    [activeCwd, availability.kind, environmentId],
  );
  useEnvironmentQuery(signalAtom);

  const handleTabChange = useCallback(
    (value: string | number | null) => {
      if (value === "changes" || value === "history") {
        setActiveTab(stableProjectRef, value as GitManagerTab);
      }
    },
    [setActiveTab, stableProjectRef],
  );
  const handleWorktreeChange = useCallback(
    (cwd: string) => {
      setSelectionOwnerKey(storeKey);
      setSelectedWorktree(stableProjectRef, cwd);
    },
    [setSelectedWorktree, stableProjectRef, storeKey],
  );

  if (availability.kind !== "ready") {
    return <GitManagerUnavailableState reason={unavailableReason(availability)} />;
  }
  if (project === null || mainCheckoutCwd === null || activeCwd === null) {
    return <GitManagerUnavailableState reason="Waiting for project data." />;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <GitManagerToolbar
        projectRef={stableProjectRef}
        mainCheckoutCwd={mainCheckoutCwd}
        selectedWorktreeCwd={activeCwd}
        worktrees={worktrees}
        catalogPending={catalog.isPending}
        catalogError={catalog.error}
        onSelectedWorktreeChange={handleWorktreeChange}
      />
      <Tabs
        className="min-h-0 flex-1 gap-0"
        value={viewState.activeTab}
        onValueChange={handleTabChange}
      >
        <div className="border-b border-border px-4 pt-2">
          <TabsList className="w-fit rounded-none border-0 bg-transparent p-0">
            <TabsTab
              className="rounded-none border-b-2 border-transparent px-3 py-2 data-selected:border-foreground data-selected:bg-transparent data-selected:shadow-none"
              value="changes"
            >
              Changes
            </TabsTab>
            <TabsTab
              className="rounded-none border-b-2 border-transparent px-3 py-2 data-selected:border-foreground data-selected:bg-transparent data-selected:shadow-none"
              value="history"
            >
              History
            </TabsTab>
          </TabsList>
        </div>
        <TabsPanel className="min-h-0 flex-1 gap-0 p-4" value="changes">
          <GitManagerChangesView scope={activeScope} projectRef={stableProjectRef} />
        </TabsPanel>
        <TabsPanel className="min-h-0 flex-1 gap-0 p-4" value="history">
          <p className="text-sm text-muted-foreground">Commit history will appear here.</p>
        </TabsPanel>
      </Tabs>
    </div>
  );
});
