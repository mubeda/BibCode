import { projectKey } from "@bibcode/client-runtime/state/entities";
import { EnvironmentRpcUnavailableError } from "@bibcode/client-runtime/rpc";
import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import {
  type ContextMenuItem,
  GitManagerOperationError,
  type EditorId,
  type EnvironmentId,
  type GitManagerUndoCommitResult,
  type ScopedProjectRef,
  type VcsStatusResult,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { SearchIcon, XIcon } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import { readLocalApi } from "~/localApi";

import { DEFAULT_GIT_MANAGER_VIEW_STATE, useGitManagerStore } from "../../../gitManagerStore";
import { useProject, useServerConfigs } from "../../../state/entities";
import { gitManagerEnvironment } from "../../../state/gitManager";
import { useEnvironmentQuery } from "../../../state/query";
import { shellEnvironment } from "../../../state/shell";
import { useAtomCommand } from "../../../state/use-atom-command";
import { vcsEnvironment } from "../../../state/vcs";
import { joinWorkspacePath, parentRelativePath } from "../../files/FileTreeContextMenu.logic";
import { GitManagerAgentActivity } from "./GitManagerAgentActivity";
import { GitManagerCommitBox, type GitManagerCommitSubmission } from "./GitManagerCommitBox";
import { GitManagerDiscardDialog } from "./GitManagerDiscardDialog";
import { GitManagerDiffPane, type GitManagerPartialArea } from "./GitManagerDiffPane";
import { GitManagerChangesList } from "./GitManagerChangesList";
import {
  buildChangeRows,
  changeRowsHeader,
  DEFAULT_CHANGE_FILTERS,
  type ChangeFilters,
  type ChangeRow,
} from "./changesList.logic";

export interface GitManagerChangesViewProps {
  readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  readonly projectRef: ScopedProjectRef;
}

type ChangeContextAction =
  | "ignore-file"
  | "ignore-folder"
  | "ignore-extension"
  | "discard"
  | "toggle-inclusion"
  | "copy-path"
  | "copy-relative-path"
  | "reveal"
  | "open-editor";

const EMPTY_PATHS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_EDITORS: ReadonlyArray<EditorId> = Object.freeze([]);
const EMPTY_FILES: VcsStatusResult["workingTree"]["files"] = Object.freeze([]);
const FILTER_NAMES: ReadonlyArray<keyof ChangeFilters> = Object.freeze([
  "included",
  "excluded",
  "new",
  "modified",
  "deleted",
]);
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);
const isGitManagerOperationError = Schema.is(GitManagerOperationError);

interface PendingDiscard {
  readonly paths: ReadonlyArray<string>;
  readonly disposition: "trash" | "permanent";
}

function isEnvironmentUnavailable(
  emission: AsyncResult.AsyncResult<unknown, unknown> | undefined,
): boolean {
  return (
    emission?._tag === "Failure" && isEnvironmentRpcUnavailableError(Cause.squash(emission.cause))
  );
}

function fileExtension(path: string): string | null {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > separator && dot < path.length - 1 ? path.slice(dot) : null;
}

function contextMenuItems(
  row: ChangeRow,
  editorAvailable: boolean,
  revealAvailable: boolean,
  commitOperationsAvailable: boolean,
): ContextMenuItem<ChangeContextAction>[] {
  const extension = fileExtension(row.path);
  const ignoreExtensionItems: ContextMenuItem<ChangeContextAction>[] =
    extension === null
      ? []
      : (
          [
            {
              id: "ignore-extension",
              label: `Ignore all ${extension}`,
              disabled: true,
            },
          ] satisfies ContextMenuItem<ChangeContextAction>[]
        ).slice(0, 5);
  const inclusionDisabled = row.conflicted || row.disabledReason !== null;
  return [
    { id: "ignore-file", label: "Ignore file", disabled: true },
    {
      id: "ignore-folder",
      label: "Ignore folder",
      disabled: true,
    },
    ...ignoreExtensionItems,
    {
      id: "toggle-inclusion",
      label: row.inclusion === "none" ? "Include selected" : "Exclude selected",
      disabled: inclusionDisabled,
    },
    { id: "discard", label: "Discard changes", disabled: !commitOperationsAvailable },
    { id: "copy-path", label: "Copy path", icon: "copy" },
    { id: "copy-relative-path", label: "Copy relative path", icon: "copy" },
    { id: "reveal", label: "Reveal", disabled: !revealAvailable },
    { id: "open-editor", label: "Open in editor", disabled: !editorAvailable },
  ];
}

function errorPanel(title: string, message: string) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6" role="alert">
      <div className="max-w-md text-center">
        <p className="font-medium text-sm text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

function gitManagerMutationErrorMessage(error: unknown): string {
  if (isGitManagerOperationError(error)) {
    return error.blocked?.message ?? error.message;
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Git could not complete the requested operation.";
}

export const GitManagerChangesView = memo(function GitManagerChangesView({
  scope,
  projectRef,
}: GitManagerChangesViewProps) {
  const { environmentId, cwd } = scope;
  const { projectId } = projectRef;
  const stableProjectRef = useMemo(
    () => ({ environmentId, projectId }) as ScopedProjectRef,
    [environmentId, projectId],
  );
  const storeKey = projectKey(stableProjectRef);
  const selectFilterText = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      (state.byProjectKey[storeKey] ?? DEFAULT_GIT_MANAGER_VIEW_STATE).filterText,
    [storeKey],
  );
  const selectSelectedPath = useCallback(
    (state: ReturnType<typeof useGitManagerStore.getState>) =>
      (state.byProjectKey[storeKey] ?? DEFAULT_GIT_MANAGER_VIEW_STATE).selectedFilePath,
    [storeKey],
  );
  const filterText = useGitManagerStore(selectFilterText);
  const deferredFilterText = useDeferredValue(filterText);
  const selectedPath = useGitManagerStore(selectSelectedPath);
  const setFilterText = useGitManagerStore((state) => state.setFilterText);
  const setSelectedFile = useGitManagerStore((state) => state.setSelectedFile);
  const [filters, setFilters] = useState<ChangeFilters>(() => DEFAULT_CHANGE_FILTERS);
  const [excludedPaths, setExcludedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  const readsAvailable = typeof gitManagerEnvironment.getRefs === "function";
  const project = useProject(stableProjectRef);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const liveSignalAvailable = serverConfig?.environment?.capabilities.gitManagerLiveSignal === true;

  const statusAtom = useMemo(
    () => (readsAvailable ? vcsEnvironment.status({ environmentId, input: { cwd } }) : null),
    [cwd, environmentId, readsAvailable],
  );
  const refsAtom = useMemo(() => {
    const getRefs = gitManagerEnvironment.getRefs;
    return typeof getRefs === "function" ? getRefs({ environmentId, input: { cwd } }) : null;
  }, [cwd, environmentId]);
  const signalAtom = useMemo(
    () =>
      readsAvailable && liveSignalAvailable
        ? gitManagerEnvironment.signal({ environmentId, input: { cwd } })
        : null,
    [cwd, environmentId, liveSignalAvailable, readsAvailable],
  );
  const latestCommitAtom = useMemo(() => {
    const getCommits = gitManagerEnvironment.getCommits;
    return typeof getCommits === "function"
      ? getCommits({ environmentId, input: { cwd, offset: 0, limit: 1 } })
      : null;
  }, [cwd, environmentId]);
  const statusQuery = useEnvironmentQuery(statusAtom);
  const refsQuery = useEnvironmentQuery(refsAtom);
  const signalQuery = useEnvironmentQuery(signalAtom);
  const latestCommitQuery = useEnvironmentQuery(latestCommitAtom);
  const signalGeneration = signalQuery.data?.generation ?? null;
  const refreshRefs = refsQuery.refresh;
  const refreshLatestCommit = latestCommitQuery.refresh;
  useEffect(() => {
    if (signalGeneration !== null) refreshRefs();
  }, [refreshRefs, signalGeneration]);

  const availableEditors = serverConfig?.availableEditors ?? EMPTY_EDITORS;
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const revealInFileManager = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const stageFiles = useAtomCommand(vcsEnvironment.stageFiles, { reportFailure: false });
  const unstageFiles = useAtomCommand(vcsEnvironment.unstageFiles, { reportFailure: false });
  const commit = useAtomCommand(gitManagerEnvironment.commit, { reportFailure: false });
  const undoCommit = useAtomCommand(gitManagerEnvironment.undoCommit, { reportFailure: false });
  const discard = useAtomCommand(gitManagerEnvironment.discard, { reportFailure: false });

  const files = statusQuery.data?.workingTree.files ?? EMPTY_FILES;
  const conflictedPaths = refsQuery.data?.conflictedPaths ?? EMPTY_PATHS;
  const rows = useMemo(
    () =>
      buildChangeRows({
        files,
        conflictedPaths,
        submodulePaths: EMPTY_PATHS,
        filterText: deferredFilterText,
        filters,
        excludedPaths,
      }),
    [conflictedPaths, deferredFilterText, excludedPaths, files, filters],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const header = useMemo(() => changeRowsHeader(rows), [rows]);
  const includedPaths = useMemo(() => {
    const conflicted = new Set(conflictedPaths);
    const included = new Set<string>();
    for (const file of files) {
      if (!excludedPaths.has(file.path) && !conflicted.has(file.path)) included.add(file.path);
    }
    return [...included];
  }, [conflictedPaths, excludedPaths, files]);
  const includedPathsRef = useRef(includedPaths);
  includedPathsRef.current = includedPaths;
  const allChangedPaths = useMemo(() => [...new Set(files.map((file) => file.path))], [files]);
  const latestCommit = latestCommitQuery.data?.commits[0] ?? null;
  const localBranches = refsQuery.data?.localBranches ?? [];
  const currentBranch = localBranches.find((branch) => branch.current) ?? null;
  const currentBranchHasLocalCommit =
    currentBranch !== null && (currentBranch.upstream === null || currentBranch.ahead > 0);
  const latestCommittedAtMs = latestCommit?.committedAtMs ?? null;
  const latestCommitParentCount = latestCommit?.parents.length ?? 0;
  const latestLocalCommit = useMemo(
    () =>
      currentBranchHasLocalCommit && latestCommittedAtMs !== null
        ? { committedAtMs: latestCommittedAtMs, isMerge: latestCommitParentCount > 1 }
        : null,
    [currentBranchHasLocalCommit, latestCommitParentCount, latestCommittedAtMs],
  );
  const branch = refsQuery.data?.headRef ?? statusQuery.data?.refName ?? "HEAD";
  const commitOperationsAvailable =
    serverConfig?.environment?.capabilities.gitManagerCommitOperations === true;
  const commitDisabledReason = commitOperationsAvailable
    ? null
    : "This environment does not support Git Manager commit operations.";
  const partialStagingAvailable =
    serverConfig?.environment?.capabilities.gitManagerPartialStaging === true;
  const partialStagingDisabledReason = partialStagingAvailable
    ? null
    : "This environment does not support partial staging.";
  const selectedRow = useMemo(
    () => rows.find((row) => row.path === selectedPath) ?? null,
    [rows, selectedPath],
  );
  const selectedAreas = useMemo<ReadonlyArray<GitManagerPartialArea>>(() => {
    if (selectedRow?.area === "staged") return ["staged"];
    if (selectedRow?.area === "unstaged") return ["unstaged"];
    return ["unstaged", "staged"];
  }, [selectedRow?.area]);

  const handleSelect = useCallback(
    (path: string) => setSelectedFile(stableProjectRef, path),
    [setSelectedFile, stableProjectRef],
  );
  const handleToggle = useCallback((path: string) => {
    setExcludedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const handleToggleAll = useCallback(() => {
    setExcludedPaths((current) => {
      const next = new Set(current);
      const includeVisible = header.inclusion !== "all";
      for (const row of rows) {
        if (row.conflicted || row.disabledReason !== null) continue;
        if (includeVisible) next.delete(row.path);
        else next.add(row.path);
      }
      return next;
    });
  }, [header.inclusion, rows]);
  const toggleFilter = useCallback((name: keyof ChangeFilters) => {
    setFilters((current) => ({ ...current, [name]: !current[name] }));
  }, []);
  const clearFilters = useCallback(() => {
    setFilterText(stableProjectRef, "");
    setFilters(DEFAULT_CHANGE_FILTERS);
  }, [setFilterText, stableProjectRef]);
  const handleCommit = useCallback(
    async (input: GitManagerCommitSubmission) => {
      const selectedAtInvocation = new Set(includedPathsRef.current);
      setMutationBusy(true);
      setMutationError(null);
      try {
        const freshStatus = await refreshStatus({ environmentId, input: { cwd } });
        if (freshStatus._tag === "Failure") {
          const message = gitManagerMutationErrorMessage(squashAtomCommandFailure(freshStatus));
          setMutationError(message);
          throw new Error(message);
        }

        const pathsToStage = new Set<string>();
        const pathsToUnstage = new Set<string>();
        for (const file of freshStatus.value.workingTree.files) {
          if (selectedAtInvocation.has(file.path)) {
            if (file.area !== "staged") pathsToStage.add(file.path);
          } else if (file.area === "staged") {
            pathsToUnstage.add(file.path);
          }
        }
        if (selectedAtInvocation.size > 0 && pathsToStage.size === 0) {
          const freshPaths = new Set(freshStatus.value.workingTree.files.map((file) => file.path));
          if (![...selectedAtInvocation].some((path) => freshPaths.has(path))) {
            const message =
              "The selected changes are no longer present. Review the refreshed status before committing.";
            setMutationError(message);
            throw new Error(message);
          }
        }
        if (pathsToUnstage.size > 0) {
          const result = await unstageFiles({
            environmentId,
            input: { cwd, filePaths: [...pathsToUnstage] },
          });
          if (result._tag === "Failure") {
            const message = gitManagerMutationErrorMessage(squashAtomCommandFailure(result));
            setMutationError(message);
            throw new Error(message);
          }
        }
        if (pathsToStage.size > 0) {
          const result = await stageFiles({
            environmentId,
            input: { cwd, filePaths: [...pathsToStage] },
          });
          if (result._tag === "Failure") {
            const message = gitManagerMutationErrorMessage(squashAtomCommandFailure(result));
            setMutationError(message);
            throw new Error(message);
          }
        }
        const result = await commit({
          environmentId,
          input: {
            cwd,
            summary: input.summary,
            description: input.description,
            amend: input.amend,
            noVerify: input.noVerify,
            signoff: input.signoff,
            allowEmpty: input.allowEmpty,
            coAuthors: [...input.coAuthors],
          },
        });
        if (result._tag === "Failure") {
          const message = gitManagerMutationErrorMessage(squashAtomCommandFailure(result));
          setMutationError(message);
          throw new Error(message);
        }
        refreshRefs();
        refreshLatestCommit();
      } finally {
        setMutationBusy(false);
      }
    },
    [
      commit,
      cwd,
      environmentId,
      refreshLatestCommit,
      refreshRefs,
      refreshStatus,
      stageFiles,
      unstageFiles,
    ],
  );
  const handleUndo = useCallback(async (): Promise<GitManagerUndoCommitResult | null> => {
    setMutationBusy(true);
    setMutationError(null);
    try {
      const result = await undoCommit({ environmentId, input: { cwd } });
      if (result._tag === "Failure") {
        setMutationError(gitManagerMutationErrorMessage(squashAtomCommandFailure(result)));
        return null;
      }
      refreshRefs();
      refreshLatestCommit();
      return result.value;
    } finally {
      setMutationBusy(false);
    }
  }, [cwd, environmentId, refreshLatestCommit, refreshRefs, undoCommit]);
  const requestDiscardAll = useCallback(() => {
    if (allChangedPaths.length > 0) {
      setPendingDiscard({ paths: allChangedPaths, disposition: "trash" });
    }
  }, [allChangedPaths]);
  const handleDiscardOpenChange = useCallback((open: boolean) => {
    if (!open) setPendingDiscard(null);
  }, []);
  const confirmDiscard = useCallback(async (): Promise<"keep-open" | void> => {
    const requested = pendingDiscard;
    if (requested === null) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      const result = await discard({
        environmentId,
        input: {
          cwd,
          paths: [...requested.paths] as [string, ...string[]],
          permitPermanent: requested.disposition === "permanent",
        },
      });
      if (result._tag === "Failure") {
        const message = gitManagerMutationErrorMessage(squashAtomCommandFailure(result));
        setMutationError(message);
        throw new Error(message);
      }
      if (requested.disposition === "trash" && result.value.trashUnavailable.length > 0) {
        setPendingDiscard({
          paths: result.value.trashUnavailable,
          disposition: "permanent",
        });
        return "keep-open";
      }
    } finally {
      setMutationBusy(false);
    }
  }, [cwd, discard, environmentId, pendingDiscard]);
  const handleOpenExternal = useCallback(
    (path: string) => {
      if (availableEditors.length === 0) return;
      void openInPreferredEditor(joinWorkspacePath(cwd, path));
    },
    [availableEditors.length, cwd, openInPreferredEditor],
  );
  const handleContextMenu = useCallback(
    (path: string, position: { x: number; y: number }) => {
      const row = rowsRef.current.find((candidate) => candidate.path === path);
      const api = readLocalApi();
      if (row === undefined || api === undefined) return;
      const revealAvailable = availableEditors.includes("file-manager");
      void api.contextMenu
        .show(
          contextMenuItems(
            row,
            availableEditors.length > 0,
            revealAvailable,
            commitOperationsAvailable,
          ),
          position,
        )
        .then(async (action) => {
          switch (action) {
            case "toggle-inclusion":
              handleToggle(path);
              return;
            case "discard":
              setPendingDiscard({ paths: [path], disposition: "trash" });
              return;
            case "copy-path":
              await navigator.clipboard?.writeText(joinWorkspacePath(cwd, path));
              return;
            case "copy-relative-path":
              await navigator.clipboard?.writeText(path);
              return;
            case "open-editor":
              handleOpenExternal(path);
              return;
            case "reveal":
              await revealInFileManager({
                environmentId,
                input: {
                  cwd: joinWorkspacePath(cwd, parentRelativePath(path)),
                  editor: "file-manager",
                },
              });
              return;
            case "ignore-file":
            case "ignore-folder":
            case "ignore-extension":
            case null:
              return;
          }
        })
        .catch(() => undefined);
    },
    [
      availableEditors,
      commitOperationsAvailable,
      cwd,
      environmentId,
      handleOpenExternal,
      handleToggle,
      revealInFileManager,
    ],
  );

  const statusUnavailable = isEnvironmentUnavailable(statusQuery.emission);
  const refsUnavailable = isEnvironmentUnavailable(refsQuery.emission);
  if (statusQuery.error !== null || refsQuery.error !== null) {
    const message = statusQuery.error ?? refsQuery.error ?? "The environment request failed.";
    return statusUnavailable || refsUnavailable
      ? errorPanel("Environment unavailable", message)
      : errorPanel("Could not load changes", message);
  }
  if (statusQuery.data === null || refsQuery.data === null) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
        role="status"
      >
        Connecting to changes…
      </div>
    );
  }

  const filterActive = rows.filterActive;
  const noLocalChanges = rows.totalCount === 0;
  const mainCheckoutCwd = project?.workspaceRoot ?? cwd;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col" aria-label="Changes">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon
            aria-hidden="true"
            className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            aria-label="Filter changed files"
            autoComplete="off"
            className="h-8 w-full rounded-md border border-input bg-background pr-8 pl-7 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            name="git-manager-change-filter"
            placeholder="Filter changed files…"
            type="search"
            value={filterText}
            onChange={(event) => setFilterText(stableProjectRef, event.target.value)}
          />
          {filterText.length === 0 ? null : (
            <Button
              aria-label="Clear file filter"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              size="icon-xs"
              title="Clear filter"
              variant="ghost"
              onClick={clearFilters}
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </Button>
          )}
        </div>
        <GitManagerAgentActivity
          projectRef={stableProjectRef}
          cwd={cwd}
          mainCheckoutCwd={mainCheckoutCwd}
        />
        <Button
          aria-describedby={commitOperationsAvailable ? undefined : "git-manager-discard-disabled"}
          disabled={!commitOperationsAvailable || mutationBusy || allChangedPaths.length === 0}
          size="sm"
          title={commitDisabledReason ?? undefined}
          variant="destructive-outline"
          onClick={requestDiscardAll}
        >
          Discard All
        </Button>
        {commitOperationsAvailable ? null : (
          <span className="sr-only" id="git-manager-discard-disabled">
            {commitDisabledReason}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-2 py-1.5">
        {FILTER_NAMES.map((name) => (
          <label
            className="inline-flex items-center gap-1 text-xs capitalize text-muted-foreground"
            key={name}
          >
            <Checkbox
              aria-label={`Filter ${name} changed files`}
              checked={filters[name]}
              onCheckedChange={() => toggleFilter(name)}
            />
            {name}
          </label>
        ))}
      </div>
      {noLocalChanges ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <p className="text-sm text-muted-foreground">No local changes</p>
        </div>
      ) : rows.length === 0 && filterActive ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">No changed files match these filters.</p>
          <Button size="sm" variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      ) : (
        <>
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-xs">
            <Checkbox
              aria-label={
                header.inclusion === "all"
                  ? "Exclude all visible changes"
                  : "Include all visible changes"
              }
              checked={header.inclusion === "all"}
              indeterminate={header.inclusion === "partial"}
              onCheckedChange={handleToggleAll}
            />
            <span className="font-medium">{header.label}</span>
            {rows.hiddenIncludedCount > 0 ? (
              <span className="ml-auto text-warning">
                {rows.hiddenIncludedCount} hidden{" "}
                {rows.hiddenIncludedCount === 1 ? "change" : "changes"} will be committed
              </span>
            ) : null}
          </div>
          <GitManagerChangesList
            rows={rows}
            selectedPath={selectedPath}
            onContextMenu={handleContextMenu}
            onOpenExternal={handleOpenExternal}
            onSelect={handleSelect}
            onToggle={handleToggle}
          />
          {selectedRow === null ? null : (
            <GitManagerDiffPane
              availableAreas={selectedAreas}
              key={selectedRow.path}
              mutationBusy={mutationBusy}
              partialStagingDisabledReason={partialStagingDisabledReason}
              path={selectedRow.path}
              projectRef={stableProjectRef}
              scope={scope}
            />
          )}
        </>
      )}
      {mutationError === null ? null : (
        <p aria-live="polite" className="border-t border-border px-3 py-2 text-xs text-destructive">
          {mutationError}
        </p>
      )}
      <GitManagerCommitBox
        branch={branch}
        disabledReason={commitDisabledReason}
        includedPaths={includedPaths}
        isBusy={mutationBusy}
        latestCommit={latestLocalCommit}
        scope={scope}
        workingTreeDirty={refsQuery.data.isDirty === true}
        onCommit={handleCommit}
        onUndo={handleUndo}
      />
      {pendingDiscard === null ? null : (
        <GitManagerDiscardDialog
          disposition={pendingDiscard.disposition}
          errorMessage={mutationError}
          isBusy={mutationBusy}
          open
          paths={pendingDiscard.paths}
          onConfirm={confirmDiscard}
          onOpenChange={handleDiscardOpenChange}
        />
      )}
    </section>
  );
});
