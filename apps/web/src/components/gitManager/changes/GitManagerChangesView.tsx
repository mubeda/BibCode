import { projectKey } from "@bibcode/client-runtime/state/entities";
import { EnvironmentRpcUnavailableError } from "@bibcode/client-runtime/rpc";
import type {
  ContextMenuItem,
  EditorId,
  EnvironmentId,
  ScopedProjectRef,
  VcsStatusResult,
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
  const readsAvailable = typeof gitManagerEnvironment.getRefs === "function";

  const statusAtom = useMemo(
    () => (readsAvailable ? vcsEnvironment.status({ environmentId, input: { cwd } }) : null),
    [cwd, environmentId, readsAvailable],
  );
  const refsAtom = useMemo(() => {
    const getRefs = gitManagerEnvironment.getRefs;
    return typeof getRefs === "function" ? getRefs({ environmentId, input: { cwd } }) : null;
  }, [cwd, environmentId]);
  const signalAtom = useMemo(
    () => (readsAvailable ? gitManagerEnvironment.signal({ environmentId, input: { cwd } }) : null),
    [cwd, environmentId, readsAvailable],
  );
  const statusQuery = useEnvironmentQuery(statusAtom);
  const refsQuery = useEnvironmentQuery(refsAtom);
  const signalQuery = useEnvironmentQuery(signalAtom);
  const signalGeneration = signalQuery.data?.generation ?? null;
  const refreshRefs = refsQuery.refresh;
  useEffect(() => {
    if (signalGeneration !== null) refreshRefs();
  }, [refreshRefs, signalGeneration]);

  const project = useProject(stableProjectRef);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const availableEditors = serverConfig?.availableEditors ?? EMPTY_EDITORS;
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const revealInFileManager = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });

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
        .show(contextMenuItems(row, availableEditors.length > 0, revealAvailable), position)
        .then(async (action) => {
          switch (action) {
            case "toggle-inclusion":
              handleToggle(path);
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
    [availableEditors, cwd, environmentId, handleOpenExternal, handleToggle, revealInFileManager],
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
        </>
      )}
    </section>
  );
});
