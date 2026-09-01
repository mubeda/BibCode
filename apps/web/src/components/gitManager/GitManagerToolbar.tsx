import { RegistryContext } from "@effect/atom-react";
import { projectKey } from "@bibcode/client-runtime/state/entities";
import type {
  GitManagerBlockedReason,
  GitManagerOperationEvent,
  GitManagerOperationRequest,
  GitManagerRefEntry,
  GitManagerRefsSnapshot,
  ScopedProjectRef,
  VcsWorktreeDescriptor,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { FolderGit2Icon, TagIcon } from "lucide-react";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { DEFAULT_GIT_MANAGER_VIEW_STATE, useGitManagerStore } from "../../gitManagerStore";
import {
  gitManagerEnvironment,
  runGitManagerOperation,
  type GitManagerOperationHandle,
} from "../../state/gitManager";
import { useEnvironmentQuery } from "../../state/query";
import {
  GitManagerBranchDialogs,
  type GitManagerBranchDialog,
  type GitManagerBranchDialogSubmission,
} from "./dialogs/GitManagerBranchDialogs";
import { GitManagerSwitchWithChangesDialog } from "./dialogs/GitManagerSwitchWithChangesDialog";
import { GitManagerBranchDropdown } from "./toolbar/GitManagerBranchDropdown";
import { GitManagerOperationBanner } from "./toolbar/GitManagerOperationBanner";
import { GitManagerSyncButton, type SyncOperationKind } from "./toolbar/GitManagerSyncButton";
import { resolveSyncState, type SyncState } from "./toolbar/syncButton.logic";
import { GitManagerTagDialog } from "./tags/GitManagerTagDialog";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

interface WorktreeOption {
  readonly value: string;
  readonly label: string;
  readonly path: string;
}

type GitManagerTagAction = "create" | "delete" | "push";

interface TagDialogState {
  readonly open: boolean;
  readonly action: GitManagerTagAction;
  readonly tag: string | null;
}

interface TagActionMenuItemProps {
  readonly action: "delete" | "push";
  readonly entry: GitManagerRefEntry;
  readonly disabledReason: string | null;
  readonly onSelect: (action: "delete" | "push", tag: string) => void;
}

const TagActionMenuItem = memo(function TagActionMenuItem({
  action,
  entry,
  disabledReason,
  onSelect,
}: TagActionMenuItemProps) {
  const select = useCallback(() => onSelect(action, entry.name), [action, entry.name, onSelect]);
  const verb = action === "delete" ? "Delete" : "Push";
  return (
    <MenuItem
      aria-label={`${verb} tag ${entry.name}`}
      disabled={disabledReason !== null}
      title={disabledReason ?? `${verb} tag ${entry.name}`}
      variant={action === "delete" ? "destructive" : "default"}
      onClick={select}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono" translate="no">
          {entry.name}
        </span>
        {disabledReason === null ? null : (
          <span className="text-[10px] text-muted-foreground">{disabledReason}</span>
        )}
      </span>
    </MenuItem>
  );
});

const EMPTY_BRANCHES: ReadonlyArray<GitManagerRefEntry> = Object.freeze([]);
const EMPTY_TAG_NAMES: ReadonlyArray<string> = Object.freeze([]);
const LOADING_SYNC_STATE: SyncState = Object.freeze({
  kind: "running",
  label: "Loading repository state…",
  ahead: 0,
  behind: 0,
  disabledReason: "Loading repository state.",
});

function remoteForBranch(
  branch: GitManagerRefEntry | null,
  remotes: ReadonlyArray<string>,
): string {
  if (branch?.upstream !== null && branch?.upstream !== undefined) {
    const matchingRemote = remotes.find((remote) => branch.upstream?.startsWith(`${remote}/`));
    if (matchingRemote !== undefined) return matchingRemote;
  }
  return remotes[0] ?? "origin";
}

function remoteBranchName(branch: GitManagerRefEntry, remote: string): string | null {
  if (branch.upstream === null) return null;
  const prefix = `${remote}/`;
  return branch.upstream.startsWith(prefix)
    ? branch.upstream.slice(prefix.length)
    : branch.upstream;
}

function guardedOperation(kind: SyncState["kind"]): string | null {
  switch (kind) {
    case "fetch-unborn":
    case "fetch":
      return "fetch";
    case "publish-branch":
    case "force-push":
    case "pull":
    case "push":
      return kind;
    case "running":
    case "no-remote":
    case "detached":
      return null;
  }
}

export interface GitManagerToolbarProps {
  readonly projectRef: ScopedProjectRef;
  readonly mainCheckoutCwd: string;
  readonly selectedWorktreeCwd: string;
  readonly worktrees: ReadonlyArray<VcsWorktreeDescriptor>;
  readonly catalogPending: boolean;
  readonly catalogError: string | null;
  readonly branchSyncDisabledReason: string | null;
  readonly stashMergeDisabledReason: string | null;
  readonly tagDisabledReason: string | null;
  readonly liveSignalAvailable: boolean;
  readonly onSelectedWorktreeChange: (cwd: string) => void;
}

export const GitManagerToolbar = memo(function GitManagerToolbar({
  projectRef,
  mainCheckoutCwd,
  selectedWorktreeCwd,
  worktrees,
  catalogPending,
  catalogError,
  branchSyncDisabledReason,
  stashMergeDisabledReason,
  tagDisabledReason,
  liveSignalAvailable,
  onSelectedWorktreeChange,
}: GitManagerToolbarProps) {
  const registry = useContext(RegistryContext);
  const { environmentId, projectId } = projectRef;
  const stableProjectRef = useMemo(
    () => ({ environmentId, projectId }) as ScopedProjectRef,
    [environmentId, projectId],
  );
  const storeKey = projectKey(stableProjectRef);
  const worktreeOptions = useMemo<ReadonlyArray<WorktreeOption>>(() => {
    const options: WorktreeOption[] = [
      { value: mainCheckoutCwd, label: "Main Checkout", path: mainCheckoutCwd },
    ];
    for (const worktree of worktrees) {
      if (worktree.isPrimary || worktree.path === mainCheckoutCwd) continue;
      options.push({
        value: worktree.path,
        label: worktree.branch ?? `Worktree ${options.length}`,
        path: worktree.path,
      });
    }
    return options;
  }, [mainCheckoutCwd, worktrees]);
  const handleWorktreeChange = useCallback(
    (value: string | null) => {
      if (value !== null) onSelectedWorktreeChange(value);
    },
    [onSelectedWorktreeChange],
  );
  const worktreeStatus = catalogError ?? (catalogPending ? "Loading worktrees…" : null);

  const refsAtom = useMemo(
    () =>
      gitManagerEnvironment.getRefs({
        environmentId,
        input: { cwd: selectedWorktreeCwd },
      }),
    [environmentId, selectedWorktreeCwd],
  );
  const signalAtom = useMemo(
    () =>
      liveSignalAvailable
        ? gitManagerEnvironment.signal({
            environmentId,
            input: { cwd: selectedWorktreeCwd },
          })
        : null,
    [environmentId, liveSignalAvailable, selectedWorktreeCwd],
  );
  const refsQuery = useEnvironmentQuery(refsAtom);
  const signalQuery = useEnvironmentQuery(signalAtom);
  const refreshRefs = refsQuery.refresh;
  const signalGeneration = signalQuery.data?.generation ?? null;
  useEffect(() => {
    if (signalGeneration !== null) refreshRefs();
  }, [refreshRefs, signalGeneration]);

  const snapshot: GitManagerRefsSnapshot | null = refsQuery.data ?? null;
  const localBranches = snapshot?.localBranches ?? EMPTY_BRANCHES;
  const currentBranch = useMemo(
    () => localBranches.find((branch) => branch.current) ?? null,
    [localBranches],
  );
  const currentBranchName = snapshot?.headRef ?? currentBranch?.name ?? null;
  const existingTags = snapshot?.tags.map((tag) => tag.name) ?? EMPTY_TAG_NAMES;
  const tagTargetSha = currentBranch?.tipSha ?? snapshot?.detachedSha ?? null;
  const remote = remoteForBranch(currentBranch, snapshot?.remotes ?? []);
  const isUnborn =
    snapshot !== null &&
    snapshot.headRef !== null &&
    snapshot.detachedSha === null &&
    currentBranch === null;
  const ahead = currentBranch?.ahead ?? 0;
  const behind = currentBranch?.behind ?? 0;
  const hasUpstream = currentBranch?.upstream !== null && currentBranch?.upstream !== undefined;
  const [isOperationRunning, setIsOperationRunning] = useState(false);
  const syncState = useMemo(
    () =>
      snapshot === null
        ? LOADING_SYNC_STATE
        : resolveSyncState({
            isOperationRunning,
            hasRemote: snapshot.remotes.length > 0,
            isUnborn,
            isDetached: snapshot.detachedSha !== null,
            aheadBehind: hasUpstream ? { ahead, behind } : null,
            forcePushRecommended: hasUpstream && ahead > 0 && behind > 0,
            remote,
          }),
    [ahead, behind, hasUpstream, isOperationRunning, isUnborn, remote, snapshot],
  );
  const syncGuardOperation = guardedOperation(syncState.kind);
  const syncBlockedReason: GitManagerBlockedReason | null =
    syncGuardOperation === null
      ? null
      : (currentBranch?.blocked.find((reason) => reason.operation === syncGuardOperation) ?? null);

  const selectRecentRef = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      (state.byProjectKey[storeKey] ?? DEFAULT_GIT_MANAGER_VIEW_STATE).selectedRef,
    [storeKey],
  );
  const selectedRecentRef = useGitManagerStore(selectRecentRef);
  const setSelectedRef = useGitManagerStore((state) => state.setSelectedRef);
  const recentNames = useMemo(
    () => (selectedRecentRef === null ? [] : [selectedRecentRef]),
    [selectedRecentRef],
  );

  const [branchDialog, setBranchDialog] = useState<GitManagerBranchDialog | null>(null);
  const [tagDialog, setTagDialog] = useState<TagDialogState>({
    open: false,
    action: "create",
    tag: null,
  });
  const [switchTarget, setSwitchTarget] = useState<GitManagerRefEntry | null>(null);
  const [operationEvent, setOperationEvent] = useState<GitManagerOperationEvent | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const activeOperationRef = useRef<GitManagerOperationHandle | null>(null);
  useEffect(
    () => () => {
      activeOperationRef.current?.cancel();
    },
    [],
  );

  const executeOperation = useCallback(
    async (input: GitManagerOperationRequest): Promise<boolean> => {
      if (activeOperationRef.current !== null) return false;
      setOperationError(null);
      setIsOperationRunning(true);
      setOperationEvent({ _tag: "started", operation: input._tag });
      const handle = runGitManagerOperation(registry, { environmentId, input }, (event) => {
        setOperationEvent(event);
        if (event._tag === "failed") setOperationError(event.blocked?.message ?? event.message);
      });
      activeOperationRef.current = handle;
      const result = await handle.result;
      if (activeOperationRef.current === handle) activeOperationRef.current = null;
      setIsOperationRunning(false);
      refreshRefs();
      if (result._tag === "Failure") {
        if (Cause.hasInterruptsOnly(result.cause)) return false;
        const error = Cause.squash(result.cause);
        const message = error instanceof Error ? error.message : "The Git operation failed.";
        setOperationError(message);
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
    [environmentId, refreshRefs, registry],
  );
  const cancelOperation = useCallback(() => {
    const active = activeOperationRef.current;
    if (active === null) return;
    active.cancel();
    activeOperationRef.current = null;
    setIsOperationRunning(false);
    setOperationEvent({
      _tag: "failed",
      operation: "cancelled",
      code: "cancelled",
      message: "The Git operation was cancelled.",
      blocked: null,
    });
  }, []);

  const checkoutBranch = useCallback(
    async (branch: GitManagerRefEntry, strategy: "stash" | "bring" | null) => {
      if (branchSyncDisabledReason !== null) {
        setOperationError(branchSyncDisabledReason);
        return false;
      }
      if (strategy === "stash" && stashMergeDisabledReason !== null) {
        setOperationError(stashMergeDisabledReason);
        return false;
      }
      if (strategy === "stash") {
        const stashed = await executeOperation({
          _tag: "stash-push",
          cwd: selectedWorktreeCwd,
          projectId,
          message: `WIP before switching to ${branch.name}`,
          paths: [],
        });
        if (!stashed) return false;
      }
      const success = await executeOperation({
        _tag: "branch-checkout",
        cwd: selectedWorktreeCwd,
        projectId,
        name: branch.name,
        strategy: strategy === "stash" ? null : strategy,
      });
      if (success) setSelectedRef(stableProjectRef, branch.name);
      return success;
    },
    [
      branchSyncDisabledReason,
      executeOperation,
      projectId,
      selectedWorktreeCwd,
      setSelectedRef,
      stableProjectRef,
      stashMergeDisabledReason,
    ],
  );
  const selectBranch = useCallback(
    (branch: GitManagerRefEntry) => {
      if (snapshot?.isDirty) {
        setSwitchTarget(branch);
        return;
      }
      void checkoutBranch(branch, null);
    },
    [checkoutBranch, snapshot?.isDirty],
  );
  const createBranch = useCallback(
    () =>
      setBranchDialog({
        kind: "create",
        baseBranch: snapshot?.defaultBranch ?? currentBranchName,
      }),
    [currentBranchName, snapshot?.defaultBranch],
  );
  const renameBranch = useCallback(
    (branch: GitManagerRefEntry) => setBranchDialog({ kind: "rename", branch }),
    [],
  );
  const deleteBranch = useCallback(
    (branch: GitManagerRefEntry) =>
      setBranchDialog({ kind: "delete", branch, existsUpstream: branch.upstream !== null }),
    [],
  );
  const mergeIntoCurrent = useCallback(
    (branch: GitManagerRefEntry) => {
      if (stashMergeDisabledReason !== null) {
        setOperationError(stashMergeDisabledReason);
        return;
      }
      void executeOperation({
        _tag: "merge",
        cwd: selectedWorktreeCwd,
        projectId,
        source: branch.name,
        noVerify: false,
      });
    },
    [executeOperation, projectId, selectedWorktreeCwd, stashMergeDisabledReason],
  );
  const closeBranchDialog = useCallback(() => {
    if (!isOperationRunning) setBranchDialog(null);
  }, [isOperationRunning]);
  const submitBranchDialog = useCallback(
    async (submission: GitManagerBranchDialogSubmission) => {
      if (branchSyncDisabledReason !== null) {
        setOperationError(branchSyncDisabledReason);
        return;
      }
      let request: GitManagerOperationRequest;
      switch (submission.kind) {
        case "create":
          request = {
            _tag: "branch-create",
            cwd: selectedWorktreeCwd,
            projectId,
            name: submission.name,
            startPoint: submission.startPoint,
            checkout: true,
          };
          break;
        case "rename":
          request = {
            _tag: "branch-rename",
            cwd: selectedWorktreeCwd,
            projectId,
            name: submission.name,
            newName: submission.newName,
          };
          break;
        case "delete":
          request = {
            _tag: "branch-delete",
            cwd: selectedWorktreeCwd,
            projectId,
            name: submission.name,
            force: true,
            deleteRemote: submission.deleteRemote,
          };
          break;
      }
      if (await executeOperation(request)) setBranchDialog(null);
    },
    [branchSyncDisabledReason, executeOperation, projectId, selectedWorktreeCwd],
  );
  const resolveSwitchWithChanges = useCallback(
    async ({ strategy }: { readonly strategy: "stash" | "bring" }) => {
      const target = switchTarget;
      if (target === null) return;
      if (await checkoutBranch(target, strategy)) setSwitchTarget(null);
    },
    [checkoutBranch, switchTarget],
  );
  const changeSwitchDialogOpen = useCallback((open: boolean) => {
    if (!open) setSwitchTarget(null);
  }, []);
  const openCreateTagDialog = useCallback(
    () => setTagDialog({ open: true, action: "create", tag: null }),
    [],
  );
  const openExistingTagDialog = useCallback((action: "delete" | "push", tag: string) => {
    setTagDialog({ open: true, action, tag });
  }, []);
  const changeTagDialogOpen = useCallback((open: boolean) => {
    setTagDialog((current) => ({ ...current, open }));
  }, []);
  const runSyncOperation = useCallback(
    (kind: SyncOperationKind) => {
      if (branchSyncDisabledReason !== null) {
        setOperationError(branchSyncDisabledReason);
        return;
      }
      if (currentBranch === null && kind !== "fetch-unborn" && kind !== "fetch") return;
      const base = { cwd: selectedWorktreeCwd, projectId };
      if (kind === "fetch-unborn" || kind === "fetch") {
        void executeOperation({ _tag: "fetch", ...base, remote });
        return;
      }
      if (kind === "pull") {
        void executeOperation({ _tag: "pull", ...base, remote });
        return;
      }
      if (currentBranch === null) return;
      const pushBase = {
        ...base,
        remote,
        localBranch: currentBranch.name,
        remoteBranch: remoteBranchName(currentBranch, remote),
      };
      void executeOperation({
        _tag: kind,
        ...pushBase,
        remoteBranch: kind === "publish-branch" ? null : pushBase.remoteBranch,
      });
    },
    [
      branchSyncDisabledReason,
      currentBranch,
      executeOperation,
      projectId,
      remote,
      selectedWorktreeCwd,
    ],
  );
  const tagScope = useMemo(
    () => ({ environmentId, cwd: selectedWorktreeCwd }),
    [environmentId, selectedWorktreeCwd],
  );
  const tagMenuDisabledReason =
    tagDisabledReason ?? (refsQuery.isPending || snapshot === null ? "Loading tags." : null);
  const createTagDisabledReason =
    tagMenuDisabledReason ??
    (tagTargetSha === null ? "Create a commit before creating a tag." : null);
  const tagRemote = snapshot?.remotes.includes(remote) === true ? remote : null;

  return (
    <div className="min-w-0 shrink-0">
      <header
        className="flex min-w-0 items-stretch border-b border-border bg-card/20"
        data-environment-id={environmentId}
        data-project-id={projectId}
      >
        <div className="flex min-w-0 flex-1 items-center border-r border-border px-2 py-1.5">
          <Select
            items={worktreeOptions}
            modal={false}
            value={selectedWorktreeCwd}
            onValueChange={handleWorktreeChange}
          >
            <SelectTrigger
              aria-describedby={worktreeStatus === null ? undefined : "git-manager-worktree-status"}
              aria-label="Worktree"
              className="min-w-0 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-2"
              size="sm"
              variant="ghost"
            >
              <FolderGit2Icon aria-hidden="true" className="size-4" />
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectGroup>
                <SelectGroupLabel>Worktree</SelectGroupLabel>
                {worktreeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{option.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{option.path}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>
          {worktreeStatus === null ? null : (
            <span className="sr-only" id="git-manager-worktree-status">
              {worktreeStatus}
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-center border-r border-border px-2 py-1.5">
          <GitManagerBranchDropdown
            branchDisabledReason={branchSyncDisabledReason}
            currentBranchName={currentBranchName}
            mergeDisabledReason={stashMergeDisabledReason}
            projectRef={stableProjectRef}
            recentNames={recentNames}
            refs={localBranches}
            selectedWorktreeCwd={selectedWorktreeCwd}
            onCreateBranch={createBranch}
            onDeleteBranch={deleteBranch}
            onMergeInto={mergeIntoCurrent}
            onRenameBranch={renameBranch}
            onSelectBranch={selectBranch}
            onSwitchWorktree={onSelectedWorktreeChange}
          />
          <Menu>
            <MenuTrigger
              aria-describedby={
                tagMenuDisabledReason === null ? undefined : "git-manager-tag-trigger-reason"
              }
              className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
              disabled={tagMenuDisabledReason !== null}
              title={tagMenuDisabledReason ?? "Create, delete, or push a tag"}
            >
              <TagIcon aria-hidden="true" className="size-3.5" />
              Tags…
            </MenuTrigger>
            <MenuPopup align="start" side="bottom" className="min-w-52">
              <MenuItem
                aria-label="Create tag"
                disabled={createTagDisabledReason !== null}
                title={createTagDisabledReason ?? "Create a tag at the current commit"}
                onClick={openCreateTagDialog}
              >
                <span className="flex min-w-0 flex-col">
                  <span>Create Tag…</span>
                  {createTagDisabledReason === null ? null : (
                    <span className="text-[10px] text-muted-foreground">
                      {createTagDisabledReason}
                    </span>
                  )}
                </span>
              </MenuItem>
              <MenuSeparator />
              {snapshot !== null && snapshot.tags.length > 0 ? (
                <MenuSub>
                  <MenuSubTrigger>Delete Tag</MenuSubTrigger>
                  <MenuSubPopup className="min-w-52">
                    {snapshot.tags.map((entry) => (
                      <TagActionMenuItem
                        action="delete"
                        disabledReason={
                          tagDisabledReason ??
                          entry.blocked.find((reason) => reason.operation === "tag-delete")
                            ?.message ??
                          null
                        }
                        entry={entry}
                        key={entry.name}
                        onSelect={openExistingTagDialog}
                      />
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              ) : (
                <MenuItem disabled title="Create a local tag before deleting one">
                  <span className="flex flex-col">
                    <span>Delete Tag</span>
                    <span className="text-[10px] text-muted-foreground">No local tags.</span>
                  </span>
                </MenuItem>
              )}
              {snapshot !== null && snapshot.tags.length > 0 && tagRemote !== null ? (
                <MenuSub>
                  <MenuSubTrigger>Push Tag</MenuSubTrigger>
                  <MenuSubPopup className="min-w-52">
                    {snapshot.tags.map((entry) => (
                      <TagActionMenuItem
                        action="push"
                        disabledReason={
                          tagDisabledReason ??
                          entry.blocked.find((reason) => reason.operation === "tag-push")
                            ?.message ??
                          null
                        }
                        entry={entry}
                        key={entry.name}
                        onSelect={openExistingTagDialog}
                      />
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              ) : (
                <MenuItem
                  disabled
                  title={
                    snapshot !== null && snapshot.tags.length === 0
                      ? "Create a local tag before pushing one"
                      : "Add a remote before pushing a tag"
                  }
                >
                  <span className="flex flex-col">
                    <span>Push Tag</span>
                    <span className="text-[10px] text-muted-foreground">
                      {snapshot !== null && snapshot.tags.length === 0
                        ? "No local tags."
                        : "No remote is configured."}
                    </span>
                  </span>
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
          {tagMenuDisabledReason === null ? null : (
            <span className="sr-only" id="git-manager-tag-trigger-reason">
              {tagMenuDisabledReason}
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-center px-2 py-1.5">
          <GitManagerSyncButton
            blockedReason={syncBlockedReason}
            currentBranchName={currentBranchName}
            disabledReason={branchSyncDisabledReason}
            remote={remote}
            state={syncState}
            onOperation={runSyncOperation}
          />
        </div>
      </header>

      <GitManagerOperationBanner operation={operationEvent} onCancel={cancelOperation} />
      <GitManagerBranchDialogs
        busy={isOperationRunning}
        dialog={branchDialog}
        disabledReason={branchSyncDisabledReason}
        errorMessage={operationError}
        refs={localBranches}
        onClose={closeBranchDialog}
        onSubmit={submitBranchDialog}
      />
      <GitManagerTagDialog
        action={tagDialog.action}
        disabledReason={tagDisabledReason}
        existingTags={existingTags}
        open={tagDialog.open}
        projectRef={stableProjectRef}
        remote={tagRemote}
        scope={tagScope}
        tag={tagDialog.tag}
        targetSha={tagTargetSha}
        onFinished={refreshRefs}
        onOpenChange={changeTagDialogOpen}
      />
      <GitManagerSwitchWithChangesDialog
        branchDisabledReason={branchSyncDisabledReason}
        branchName={switchTarget?.name ?? "branch"}
        busy={isOperationRunning}
        open={switchTarget !== null}
        stashDisabledReason={stashMergeDisabledReason}
        onOpenChange={changeSwitchDialogOpen}
        onResolve={resolveSwitchWithChanges}
      />
    </div>
  );
});
