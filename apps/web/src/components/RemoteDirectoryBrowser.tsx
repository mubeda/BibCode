import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type { EnvironmentId } from "@bibcode/contracts";
import { joinHostPath } from "@bibcode/shared/path";
import {
  ArrowUpIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  HardDriveIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "./ui/button";
import { DraftInput } from "./ui/draft-input";
import { Input } from "./ui/input";
import { filesystemEnvironment } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export interface RemoteDirectoryBrowserProps {
  readonly environmentId: EnvironmentId;
  readonly initialPath: string;
  /**
   * Re-runs the reset effect (path, hidden toggle, warnings, pending create) when this
   * value changes. Pass a value that stays stable while the component is visible — for
   * example the browsing target's `environmentId` — not one that flips during a host
   * dialog's exit transition, since the browser typically stays mounted through it.
   */
  readonly resetKey: unknown;
  /** Called with the canonical directory path when the user confirms. */
  readonly onSelect: (path: string) => void;
  /** Called when the user cancels; omit to hide the Cancel button when the host provides its own way back. */
  readonly onCancel?: () => void;
  /** Optional extra secondary action rendered next to Cancel (Add Project uses "Type a path instead"). */
  readonly secondaryAction?: { readonly label: string; readonly onClick: () => void };
  readonly selectLabel?: string;
}

function validateNewFolderName(name: string): string | null {
  if (name.length === 0) return "Enter a folder name.";
  if (name === "." || name === "..") return "Choose a folder name other than . or ..";
  if (name.includes("/") || name.includes("\\")) {
    return "Use a single folder name without slashes.";
  }
  return null;
}

function createFolderErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "Unable to create folder.";
}

interface PickerContextIdentity {
  readonly environmentId: EnvironmentId;
  readonly resetKey: unknown;
  readonly initialPath: string;
  readonly path: string;
  readonly createEntry: unknown;
  readonly refreshRequestId: symbol | null;
  readonly key: symbol;
}

interface RefreshAfterNavigation {
  readonly environmentId: EnvironmentId;
  readonly createEntry: unknown;
  readonly path: string;
  readonly requestId: symbol;
  readonly contextKey: symbol;
}

export function RemoteDirectoryBrowser({
  environmentId,
  initialPath,
  resetKey,
  onSelect,
  onCancel,
  secondaryAction,
  selectLabel,
}: RemoteDirectoryBrowserProps) {
  const createEntry = useAtomCommand(projectEnvironment.createEntry, { reportFailure: false });
  const [path, setPath] = useState(initialPath || "~");
  const [fallbackWarning, setFallbackWarning] = useState<string | null>(null);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const currentContextRef = useRef<PickerContextIdentity | null>(null);
  const activeCreateRef = useRef<symbol | null>(null);
  const mountedRef = useRef(false);
  const refreshAfterNavigationRef = useRef<RefreshAfterNavigation | null>(null);

  const previousContext = currentContextRef.current;
  if (
    previousContext === null ||
    previousContext.environmentId !== environmentId ||
    previousContext.resetKey !== resetKey ||
    previousContext.initialPath !== initialPath ||
    previousContext.path !== path ||
    previousContext.createEntry !== createEntry
  ) {
    currentContextRef.current = {
      environmentId,
      resetKey,
      initialPath,
      path,
      createEntry,
      refreshRequestId: null,
      key: Symbol("picker-context"),
    };
  }

  useEffect(() => {
    activeCreateRef.current = null;
    refreshAfterNavigationRef.current = null;
    setNewFolderName(null);
    setCreatePending(false);
    setCreateError(null);
    setPath(initialPath || "~");
    setFallbackWarning(null);
    setShowHiddenFolders(false);
  }, [createEntry, environmentId, initialPath, resetKey]);

  const query = useEnvironmentQuery(
    filesystemEnvironment.browse({
      environmentId,
      input: { partialPath: path, mode: "directory" },
    }),
  );
  const directoryPath = query.data?.directoryPath ?? null;
  const breadcrumbs = query.data?.breadcrumbs ?? [];
  const entries = query.data?.entries ?? [];
  const hiddenFolderCount = entries.filter((entry) => entry.name.startsWith(".")).length;
  const visibleEntries = showHiddenFolders
    ? entries
    : entries.filter((entry) => !entry.name.startsWith("."));
  const displayPath = directoryPath ?? path;
  const trimmedFolderName = newFolderName?.trim() ?? "";
  const folderNameError = validateNewFolderName(trimmedFolderName);
  const visibleCreateError =
    trimmedFolderName.length > 0 ? (folderNameError ?? createError) : createError;
  const canCreateInCurrentDirectory =
    directoryPath !== null && !query.isPending && query.error === null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeCreateRef.current = null;
      refreshAfterNavigationRef.current = null;
    };
  }, []);

  const invalidateCreateContext = useCallback(
    (overrides: Partial<Pick<PickerContextIdentity, "path">> = {}) => {
      const context = currentContextRef.current;
      if (context !== null) {
        currentContextRef.current = {
          ...context,
          ...overrides,
          refreshRequestId: null,
          key: Symbol("picker-context"),
        };
      }
      activeCreateRef.current = null;
      refreshAfterNavigationRef.current = null;
      setNewFolderName(null);
      setCreatePending(false);
      setCreateError(null);
    },
    [],
  );

  const navigateTo = useCallback(
    (nextPath: string) => {
      invalidateCreateContext({ path: nextPath });
      setPath(nextPath);
    },
    [invalidateCreateContext],
  );

  useEffect(() => {
    const marker = refreshAfterNavigationRef.current;
    if (marker === null) return;
    const context = currentContextRef.current;
    if (
      context?.key === marker.contextKey &&
      environmentId === marker.environmentId &&
      createEntry === marker.createEntry &&
      path === marker.path &&
      context.refreshRequestId === marker.requestId
    ) {
      refreshAfterNavigationRef.current = null;
      query.refresh();
      return;
    }
    refreshAfterNavigationRef.current = null;
  }, [createEntry, environmentId, path, query.refresh]);

  useEffect(() => {
    if (newFolderName === null && query.error && path !== "~" && fallbackWarning === null) {
      setFallbackWarning("The previous folder is unavailable. Showing the server home directory.");
      navigateTo("~");
    }
  }, [fallbackWarning, navigateTo, newFolderName, path, query.error]);

  const closeNewFolder = () => {
    if (createPending) return;
    activeCreateRef.current = null;
    setNewFolderName(null);
    setCreateError(null);
  };

  const submitNewFolder = () => {
    if (
      activeCreateRef.current !== null ||
      !canCreateInCurrentDirectory ||
      directoryPath === null
    ) {
      return;
    }
    if (folderNameError !== null) {
      setCreateError(folderNameError);
      return;
    }

    const requestContext = currentContextRef.current;
    if (requestContext === null) return;
    const parentPath = directoryPath;
    const request = Symbol("create-folder");
    activeCreateRef.current = request;
    setCreatePending(true);
    setCreateError(null);

    const isCurrentRequest = () =>
      mountedRef.current &&
      activeCreateRef.current === request &&
      currentContextRef.current === requestContext;

    void createEntry({
      environmentId,
      input: { cwd: parentPath, relativePath: trimmedFolderName, kind: "directory" },
    }).then(
      (result) => {
        if (!isCurrentRequest()) return;
        activeCreateRef.current = null;
        setCreatePending(false);

        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setCreateError(createFolderErrorMessage(squashAtomCommandFailure(result)));
          }
          return;
        }

        const normalizedParentPath = joinHostPath(parentPath, "");
        const createdPath = joinHostPath(parentPath, result.value.relativePath);
        if (result.value.relativePath.trim().length === 0 || createdPath === normalizedParentPath) {
          setCreateError("The server did not return a valid created folder path.");
          return;
        }

        const targetContext: PickerContextIdentity = {
          ...requestContext,
          path: createdPath,
          refreshRequestId: request,
          key: Symbol("picker-context"),
        };
        currentContextRef.current = targetContext;
        setNewFolderName(null);
        setCreateError(null);
        refreshAfterNavigationRef.current = {
          environmentId,
          createEntry,
          path: createdPath,
          requestId: request,
          contextKey: targetContext.key,
        };
        setPath(createdPath);
      },
      (error: unknown) => {
        if (!isCurrentRequest()) return;
        activeCreateRef.current = null;
        setCreatePending(false);
        setCreateError(createFolderErrorMessage(error));
      },
    );
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Up one directory"
          disabled={!query.data?.ancestorPath || query.isPending}
          onClick={() => {
            if (query.data?.ancestorPath) navigateTo(query.data.ancestorPath);
          }}
        >
          <ArrowUpIcon className="size-4" />
        </Button>
        <DraftInput
          value={displayPath}
          onCommit={navigateTo}
          aria-label="Server directory path"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" onClick={query.refresh}>
          Refresh
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="New folder"
          disabled={!canCreateInCurrentDirectory || createPending}
          onClick={() => {
            setNewFolderName("");
            setCreateError(null);
          }}
        >
          <FolderPlusIcon className="size-4" />
          New folder
        </Button>
      </div>
      {newFolderName !== null ? (
        <form
          className="flex items-start gap-2 rounded-lg border bg-muted/24 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitNewFolder();
          }}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <Input
              autoFocus
              aria-label="New folder name"
              value={newFolderName}
              disabled={createPending}
              onChange={(event) => {
                setNewFolderName(event.currentTarget.value);
                setCreateError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeNewFolder();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  submitNewFolder();
                }
              }}
            />
            {visibleCreateError ? (
              <p role="alert" className="text-xs text-destructive">
                {visibleCreateError}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={createPending}
            onClick={closeNewFolder}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={folderNameError !== null || createPending || !canCreateInCurrentDirectory}
          >
            {createPending ? "Creating…" : "Create"}
          </Button>
        </form>
      ) : null}
      <nav
        aria-label="Directory breadcrumbs"
        className="flex min-h-8 items-center overflow-x-auto rounded-lg border bg-muted/24 px-1.5"
      >
        {breadcrumbs.map((breadcrumb, index) => {
          const isCurrent = index === breadcrumbs.length - 1;
          return (
            <div key={breadcrumb.fullPath} className="flex shrink-0 items-center">
              {index > 0 ? (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-3 text-muted-foreground/50"
                  data-directory-breadcrumb-separator=""
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Open ${breadcrumb.name}`}
                aria-current={isCurrent ? "page" : undefined}
                className={
                  isCurrent
                    ? "max-w-44 gap-1.5 px-1.5 font-medium"
                    : "max-w-44 gap-1.5 px-1.5 font-normal text-muted-foreground"
                }
                title={breadcrumb.fullPath}
                onClick={() => navigateTo(breadcrumb.fullPath)}
              >
                {index === 0 ? (
                  <HardDriveIcon className="size-3.5" />
                ) : isCurrent ? (
                  <FolderIcon className="size-3.5" />
                ) : null}
                <span className="truncate">{breadcrumb.name}</span>
              </Button>
            </div>
          );
        })}
      </nav>
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="flex min-h-8 items-center justify-between border-b bg-muted/36 px-3">
          <span className="text-xs font-medium text-muted-foreground">Folders</span>
          {hiddenFolderCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="-mr-1 h-6 px-1.5 font-normal text-muted-foreground"
              onClick={() => setShowHiddenFolders((current) => !current)}
            >
              {showHiddenFolders ? "Hide hidden folders" : "Show hidden folders"}
            </Button>
          ) : null}
        </div>
        <div className="max-h-72 min-h-48 overflow-y-auto py-1">
          {visibleEntries.map((entry) => (
            <Button
              type="button"
              variant="ghost"
              key={entry.fullPath}
              aria-label={`Open ${entry.name}`}
              className="h-8 w-full justify-start rounded-none border-0 px-3 py-1.5 font-normal text-left shadow-none hover:bg-muted/72"
              onClick={() => navigateTo(entry.fullPath)}
            >
              <FolderIcon
                aria-hidden="true"
                className="size-4 text-muted-foreground/80"
                data-directory-folder-icon=""
              />
              <span className="truncate">{entry.name}</span>
            </Button>
          ))}
          {query.isPending ? (
            <div
              role="status"
              className="flex min-h-40 flex-col items-center justify-center gap-2 px-3 text-sm text-muted-foreground"
            >
              <LoaderCircleIcon className="size-4 animate-spin" />
              <span>Loading folders…</span>
            </div>
          ) : null}
          {!query.isPending && !query.error && visibleEntries.length === 0 ? (
            <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {hiddenFolderCount > 0 && !showHiddenFolders
                ? "No visible folders. Show hidden folders to browse hidden directories."
                : "No folders in this location."}
            </div>
          ) : null}
        </div>
      </div>
      {fallbackWarning ? (
        <p role="status" className="text-sm text-muted-foreground">
          {fallbackWarning}
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2 pt-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {secondaryAction ? (
          <Button type="button" variant="ghost" onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={directoryPath === null || query.isPending || query.error !== null}
          onClick={() => {
            if (directoryPath) onSelect(directoryPath);
          }}
        >
          {selectLabel ?? "Select folder"}
        </Button>
      </div>
    </div>
  );
}
