import { RegistryContext } from "@effect/atom-react";
import { projectKey } from "@bibcode/client-runtime/state/entities";
import type {
  GitManagerInProgressOperation,
  GitManagerOperationEvent,
  GitManagerOperationRequest,
  GitManagerRefEntry,
  GitManagerRefsSnapshot,
  GitManagerStashEntry,
  ScopedProjectRef,
  VcsWorktreeDescriptor,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { ArchiveIcon, GitBranchIcon, GitMergeIcon, GitPullRequestIcon } from "lucide-react";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_GIT_MANAGER_VIEW_STATE,
  type GitManagerTab,
  useGitManagerStore,
} from "../../gitManagerStore";
import { useProject, useServerConfigs } from "../../state/entities";
import { useEnvironmentConnectionState } from "../../state/environments";
import {
  gitManagerEnvironment,
  runGitManagerOperation,
  type GitManagerOperationHandle,
} from "../../state/gitManager";
import { useEnvironmentQuery } from "../../state/query";
import { worktreeEnvironment } from "../../state/worktrees";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import { GitManagerInProgressStrip } from "./GitManagerInProgressStrip";
import { GitManagerMergeDialog } from "./merge/GitManagerMergeDialog";
import { GitManagerStashDiff } from "./stash/GitManagerStashDiff";
import { GitManagerStashList } from "./stash/GitManagerStashList";
import { resolveStashIndex } from "./stash/GitManagerStashList.logic";
import {
  resolveGitManagerAvailability,
  type GitManagerAvailability,
} from "./gitManagerAvailability";
import { GitManagerChangesView } from "./changes/GitManagerChangesView";
import { GitManagerImageDiffModeProvider } from "./diff/GitManagerImageDiffModeContext";
import { GitManagerHistoryView } from "./history/GitManagerHistoryView";
import { GitManagerPullRequestPanel } from "./provider/GitManagerPullRequestPanel";
import { GitManagerToolbar } from "./GitManagerToolbar";
import { GitManagerOperationBanner } from "./toolbar/GitManagerOperationBanner";

const EMPTY_WORKTREES: ReadonlyArray<VcsWorktreeDescriptor> = Object.freeze([]);
const EMPTY_REFS: ReadonlyArray<GitManagerRefEntry> = Object.freeze([]);
const EMPTY_STASHES: ReadonlyArray<GitManagerStashEntry> = Object.freeze([]);
const STASH_MUTATION_OPERATIONS = new Set(["stash-apply", "stash-pop", "stash-drop"]);

type ResumableInProgressOperation = Omit<GitManagerInProgressOperation, "kind"> & {
  readonly kind: "merge" | "rebase" | "cherry-pick" | "revert";
};

function asResumableOperation(
  operation: GitManagerInProgressOperation | null,
): ResumableInProgressOperation | null {
  if (operation === null || operation.kind === "squash") return null;
  return { ...operation, kind: operation.kind };
}

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

interface GitManagerRepositorySurfacesProps {
  readonly scope: {
    readonly environmentId: ScopedProjectRef["environmentId"];
    readonly cwd: string;
  };
  readonly projectRef: ScopedProjectRef;
  readonly signalGeneration: number | null;
}

const GitManagerRepositorySurfaces = memo(function GitManagerRepositorySurfaces({
  scope,
  projectRef,
  signalGeneration,
}: GitManagerRepositorySurfacesProps) {
  const registry = useContext(RegistryContext);
  const { environmentId, cwd } = scope;
  const { projectId } = projectRef;
  const storeKey = projectKey(projectRef);
  const selectSelectedStashSha = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.selectedStashSha ??
      DEFAULT_GIT_MANAGER_VIEW_STATE.selectedStashSha,
    [storeKey],
  );
  const selectStashPaneOpen = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.stashPaneOpen ?? DEFAULT_GIT_MANAGER_VIEW_STATE.stashPaneOpen,
    [storeKey],
  );
  const selectSelectedFilePath = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.selectedFilePath ??
      DEFAULT_GIT_MANAGER_VIEW_STATE.selectedFilePath,
    [storeKey],
  );
  const selectProviderPaneOpen = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.providerPaneOpen ??
      DEFAULT_GIT_MANAGER_VIEW_STATE.providerPaneOpen,
    [storeKey],
  );
  const selectRecentRef = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      state.byProjectKey[storeKey]?.selectedRef ?? DEFAULT_GIT_MANAGER_VIEW_STATE.selectedRef,
    [storeKey],
  );
  const selectedStashSha = useGitManagerStore(selectSelectedStashSha);
  const stashPaneOpen = useGitManagerStore(selectStashPaneOpen);
  const selectedFilePath = useGitManagerStore(selectSelectedFilePath);
  const providerPaneOpen = useGitManagerStore(selectProviderPaneOpen);
  const recentRef = useGitManagerStore(selectRecentRef);
  const setSelectedStash = useGitManagerStore((state) => state.setSelectedStash);
  const setStashPaneOpen = useGitManagerStore((state) => state.setStashPaneOpen);
  const setSelectedFile = useGitManagerStore((state) => state.setSelectedFile);
  const setProviderPaneOpen = useGitManagerStore((state) => state.setProviderPaneOpen);

  const refsAtom = useMemo(
    () =>
      gitManagerEnvironment.getRefs?.({
        environmentId,
        input: { cwd },
      }) ?? null,
    [cwd, environmentId],
  );
  const stashesAtom = useMemo(
    () =>
      !stashPaneOpen
        ? null
        : (gitManagerEnvironment.getStashes?.({
            environmentId,
            input: { cwd },
          }) ?? null),
    [cwd, environmentId, stashPaneOpen],
  );
  const refsQuery = useEnvironmentQuery(refsAtom);
  const stashesQuery = useEnvironmentQuery(stashesAtom);
  const refreshRefs = refsQuery.refresh;
  const refreshStashes = stashesQuery.refresh;
  useEffect(() => {
    if (signalGeneration === null) return;
    refreshRefs();
    if (stashPaneOpen) refreshStashes();
  }, [refreshRefs, refreshStashes, signalGeneration, stashPaneOpen]);

  const snapshot: GitManagerRefsSnapshot | null = refsQuery.data ?? null;
  const localBranches = snapshot?.localBranches ?? EMPTY_REFS;
  const stashes = stashesQuery.data ?? EMPTY_STASHES;
  const repositoryBlockedReasons = useMemo(
    () => localBranches.flatMap((branch) => branch.blocked),
    [localBranches],
  );
  const stashBlockedReasons = useMemo(
    () =>
      repositoryBlockedReasons.filter((reason) => STASH_MUTATION_OPERATIONS.has(reason.operation)),
    [repositoryBlockedReasons],
  );
  const inProgressBlocked =
    repositoryBlockedReasons.find((reason) => reason.code === "merge-in-progress") ?? null;
  const inProgressOperation = snapshot?.inProgressOperation ?? null;
  const resumableOperation = asResumableOperation(inProgressOperation);
  const recentNames = useMemo(() => (recentRef === null ? [] : [recentRef]), [recentRef]);

  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [operationEvent, setOperationEvent] = useState<GitManagerOperationEvent | null>(null);
  const [operationRunning, setOperationRunning] = useState(false);
  const activeOperationRef = useRef<GitManagerOperationHandle | null>(null);
  useEffect(
    () => () => {
      activeOperationRef.current?.cancel();
    },
    [],
  );
  const refreshRepositoryReads = useCallback(() => {
    refreshRefs();
    if (stashPaneOpen) refreshStashes();
  }, [refreshRefs, refreshStashes, stashPaneOpen]);
  const executeOperation = useCallback(
    async (input: GitManagerOperationRequest): Promise<boolean> => {
      if (activeOperationRef.current !== null) return false;
      setOperationRunning(true);
      setOperationEvent({ _tag: "started", operation: input._tag });
      const handle = runGitManagerOperation(registry, { environmentId, input }, (event) => {
        setOperationEvent(event);
        if (event._tag === "failed" || event._tag === "finished") {
          setOperationRunning(false);
        }
      });
      activeOperationRef.current = handle;
      const result = await handle.result;
      if (activeOperationRef.current === handle) activeOperationRef.current = null;
      setOperationRunning(false);
      refreshRepositoryReads();
      if (result._tag === "Failure") {
        if (Cause.hasInterruptsOnly(result.cause)) return false;
        const error = Cause.squash(result.cause);
        const message = error instanceof Error ? error.message : "The Git operation failed.";
        setOperationEvent({
          _tag: "failed",
          operation: input._tag,
          code: "transport-error",
          message,
          blocked: null,
        });
        return false;
      }
      return result.value._tag === "finished";
    },
    [environmentId, refreshRepositoryReads, registry],
  );
  const cancelOperation = useCallback(() => {
    activeOperationRef.current?.cancel();
    activeOperationRef.current = null;
    setOperationRunning(false);
  }, []);
  const runStashMutation = useCallback(
    async (kind: "stash-apply" | "stash-pop" | "stash-drop", sha: string) => {
      const index = resolveStashIndex(stashes, sha);
      if (index === null) {
        refreshStashes();
        return;
      }
      await executeOperation({ _tag: kind, cwd, projectId, index });
    },
    [cwd, executeOperation, projectId, refreshStashes, stashes],
  );
  const runStashApply = useCallback(
    (sha: string) => runStashMutation("stash-apply", sha),
    [runStashMutation],
  );
  const runStashPop = useCallback(
    (sha: string) => runStashMutation("stash-pop", sha),
    [runStashMutation],
  );
  const runStashDrop = useCallback(
    (sha: string) => runStashMutation("stash-drop", sha),
    [runStashMutation],
  );
  const selectStash = useCallback(
    (sha: string) => setSelectedStash(projectRef, sha),
    [projectRef, setSelectedStash],
  );
  const selectStashFile = useCallback(
    (path: string) => setSelectedFile(projectRef, path),
    [projectRef, setSelectedFile],
  );
  const toggleStashPane = useCallback(
    () => setStashPaneOpen(projectRef, !stashPaneOpen),
    [projectRef, setStashPaneOpen, stashPaneOpen],
  );
  const toggleProviderPane = useCallback(
    () => setProviderPaneOpen(projectRef, !providerPaneOpen),
    [projectRef, providerPaneOpen, setProviderPaneOpen],
  );
  const openMergeDialog = useCallback(() => setMergeDialogOpen(true), []);
  const handleMergeFinished = useCallback(() => refreshRefs(), [refreshRefs]);
  const continueInProgress = useCallback(() => {
    if (resumableOperation === null) return;
    void executeOperation({
      _tag: "continue",
      cwd,
      projectId,
      operation: resumableOperation.kind,
    });
  }, [cwd, executeOperation, projectId, resumableOperation]);
  const abortInProgress = useCallback(() => {
    if (resumableOperation === null) return;
    void executeOperation({
      _tag: "abort",
      cwd,
      projectId,
      operation: resumableOperation.kind,
    });
  }, [cwd, executeOperation, projectId, resumableOperation]);
  const mergeDisabledReason =
    refsQuery.isPending || snapshot === null
      ? "Loading branches."
      : localBranches.every((branch) => branch.current)
        ? "No source branch is available."
        : null;

  return (
    <>
      <GitManagerOperationBanner operation={operationEvent} onCancel={cancelOperation} />
      {resumableOperation === null ? null : (
        <GitManagerInProgressStrip
          blocked={inProgressBlocked}
          operation={resumableOperation}
          onAbort={abortInProgress}
          onContinue={continueInProgress}
        />
      )}
      <div className="flex items-center justify-end gap-2 border-b border-border px-4 py-1.5">
        <Button
          aria-expanded={providerPaneOpen}
          aria-label={`${providerPaneOpen ? "Hide" : "Show"} pull requests and checks`}
          size="xs"
          variant="ghost"
          onClick={toggleProviderPane}
        >
          <GitPullRequestIcon aria-hidden="true" />
          {providerPaneOpen ? "Hide pull requests" : "Show pull requests"}
        </Button>
        <Button
          aria-expanded={stashPaneOpen}
          aria-label="Toggle repository stashes"
          size="xs"
          variant="ghost"
          onClick={toggleStashPane}
        >
          <ArchiveIcon aria-hidden="true" />
          Stashes{stashPaneOpen && !stashesQuery.isPending ? ` (${stashes.length})` : ""}
        </Button>
        <Button
          aria-describedby={
            mergeDisabledReason === null ? undefined : "git-manager-merge-trigger-reason"
          }
          disabled={mergeDisabledReason !== null}
          size="xs"
          title={mergeDisabledReason ?? "Merge a branch into the current branch"}
          variant="ghost"
          onClick={openMergeDialog}
        >
          <GitMergeIcon aria-hidden="true" />
          Merge…
        </Button>
        {mergeDisabledReason === null ? null : (
          <span className="sr-only" id="git-manager-merge-trigger-reason">
            {mergeDisabledReason}
          </span>
        )}
      </div>
      {providerPaneOpen ? (
        <div className="h-80 min-h-0 overflow-auto border-b border-border">
          <GitManagerPullRequestPanel scope={scope} onRefresh={refreshRefs} />
        </div>
      ) : null}
      {stashPaneOpen ? (
        <section
          aria-label="Repository stash browser"
          className="grid h-80 min-h-0 grid-cols-[minmax(14rem,32%)_minmax(0,1fr)] border-b border-border"
        >
          <div className="min-h-0 border-r border-border">
            {stashesQuery.error !== null && stashes.length === 0 ? (
              <p className="p-3 text-xs text-destructive">{stashesQuery.error}</p>
            ) : (
              <GitManagerStashList
                blockedReasons={stashBlockedReasons}
                entries={stashes}
                operationInFlight={operationRunning}
                projectRef={projectRef}
                scope={scope}
                selectedSha={selectedStashSha}
                onApply={runStashApply}
                onDrop={runStashDrop}
                onPop={runStashPop}
                onSelectStash={selectStash}
              />
            )}
          </div>
          <GitManagerStashDiff
            entries={stashes}
            projectRef={projectRef}
            scope={scope}
            selectedPath={selectedFilePath}
            selectedStashSha={selectedStashSha}
            stashesPending={stashesQuery.isPending}
            onRefreshStashes={refreshStashes}
            onSelectPath={selectStashFile}
          />
        </section>
      ) : null}
      <GitManagerMergeDialog
        open={mergeDialogOpen}
        projectRef={projectRef}
        recentNames={recentNames}
        refs={localBranches}
        scope={scope}
        onFinished={handleMergeFinished}
        onOpenChange={setMergeDialogOpen}
      />
    </>
  );
});

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
  const signalQuery = useEnvironmentQuery(signalAtom);
  const signalGeneration = signalQuery.data?.generation ?? null;

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
    <GitManagerImageDiffModeProvider projectRef={stableProjectRef}>
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
        <GitManagerRepositorySurfaces
          projectRef={stableProjectRef}
          scope={activeScope}
          signalGeneration={signalGeneration}
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
            {viewState.activeTab === "history" ? (
              <GitManagerHistoryView scope={activeScope} projectRef={stableProjectRef} />
            ) : null}
          </TabsPanel>
        </Tabs>
      </div>
    </GitManagerImageDiffModeProvider>
  );
});
