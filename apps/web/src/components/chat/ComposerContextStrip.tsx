import { FolderIcon, GitBranchIcon, ServerIcon } from "lucide-react";
import { memo, useCallback, useRef } from "react";

import { markKeyboardContextMenuOpened } from "../../contextMenuKeyboard";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import { readLocalApi } from "../../localApi";
import { isContextMenuShortcut, isKeyboardContextMenuEcho } from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type ComposerCheckoutKind = "Main checkout" | "Worktree";

export interface ComposerContextStripProps {
  readonly environmentLabel: string | null;
  readonly checkoutPath: string | null;
  readonly checkoutKind: ComposerCheckoutKind | null;
  readonly branch: string | null;
}

export interface ComposerContextStripVcsStatus {
  readonly data: {
    readonly isRepo: boolean;
    readonly refName?: string | null;
  } | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface DeriveComposerContextStripInput {
  readonly environmentLabel: string | null;
  readonly projectCwd: string | null;
  readonly worktreePath: string | null;
  readonly fallbackBranch: string | null;
  readonly vcsStatus: ComposerContextStripVcsStatus | null;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function folderBasename(path: string): string {
  if (isWindowsStylePath(path)) {
    const trimmed = path.replace(/[\\/]+$/, "");
    if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) {
      return path;
    }
    const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
  }

  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) {
    return path;
  }
  const separatorIndex = trimmed.lastIndexOf("/");
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

export function deriveComposerContextStripState(
  input: DeriveComposerContextStripInput,
): ComposerContextStripProps {
  const environmentLabel = trimmedOrNull(input.environmentLabel);
  const projectCwd = trimmedOrNull(input.projectCwd);
  const worktreePath = trimmedOrNull(input.worktreePath);
  // Gate checkout path, kind, and branch on a resolved project root (matching `gitCwd`).
  const checkoutPath = projectCwd !== null ? (worktreePath ?? projectCwd) : null;

  let checkoutKind: ComposerCheckoutKind | null = null;
  if (checkoutPath !== null && projectCwd !== null) {
    checkoutKind =
      worktreePath !== null &&
      normalizeProjectPathForComparison(worktreePath) !==
        normalizeProjectPathForComparison(projectCwd)
        ? "Worktree"
        : "Main checkout";
  }

  let branch: string | null = null;
  if (checkoutPath !== null && input.vcsStatus !== null) {
    if (input.vcsStatus.data !== null) {
      branch =
        input.vcsStatus.data.isRepo === true ? trimmedOrNull(input.vcsStatus.data.refName) : null;
    } else if (input.vcsStatus.isPending && input.vcsStatus.error === null) {
      branch = trimmedOrNull(input.fallbackBranch);
    }
  }

  return {
    environmentLabel,
    checkoutPath,
    checkoutKind,
    branch,
  };
}

function elementMenuPosition(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

export const ComposerContextStrip = memo(function ComposerContextStrip({
  environmentLabel,
  checkoutPath,
  checkoutKind,
  branch,
}: ComposerContextStripProps) {
  const keyboardMenuOpenedAtRef = useRef(Number.NEGATIVE_INFINITY);

  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    target: "path",
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const { copyToClipboard: copyBranchNameToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Branch name copied",
        description: ctx.branch,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy branch name",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const openFolderContextMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (!checkoutPath) return;
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "copy-full-path", label: "Copy full path" }], position)
        .then((clicked) => {
          if (clicked === "copy-full-path") {
            copyPathToClipboard(checkoutPath, { path: checkoutPath });
          }
        })
        .catch(() => {
          // Ignore dismissed or cancelled context menu calls.
        });
    },
    [checkoutPath, copyPathToClipboard],
  );

  const openBranchContextMenu = useCallback(
    (position: { x: number; y: number }) => {
      if (!branch) return;
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "copy-branch-name", label: "Copy branch name" }], position)
        .then((clicked) => {
          if (clicked === "copy-branch-name") {
            copyBranchNameToClipboard(branch, { branch });
          }
        })
        .catch(() => {
          // Ignore dismissed or cancelled context menu calls.
        });
    },
    [branch, copyBranchNameToClipboard],
  );

  const handleFolderContextMenu = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isKeyboardContextMenuEcho(keyboardMenuOpenedAtRef.current, performance.now())) {
        return;
      }
      openFolderContextMenu({ x: event.clientX, y: event.clientY });
    },
    [openFolderContextMenu],
  );

  const handleFolderKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLSpanElement>) => {
      if (!isContextMenuShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      keyboardMenuOpenedAtRef.current = markKeyboardContextMenuOpened();
      openFolderContextMenu(elementMenuPosition(event.currentTarget));
    },
    [openFolderContextMenu],
  );

  const handleBranchContextMenu = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isKeyboardContextMenuEcho(keyboardMenuOpenedAtRef.current, performance.now())) {
        return;
      }
      openBranchContextMenu({ x: event.clientX, y: event.clientY });
    },
    [openBranchContextMenu],
  );

  const handleBranchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLSpanElement>) => {
      if (!isContextMenuShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      keyboardMenuOpenedAtRef.current = markKeyboardContextMenuOpened();
      openBranchContextMenu(elementMenuPosition(event.currentTarget));
    },
    [openBranchContextMenu],
  );

  if (!environmentLabel && !checkoutPath && !checkoutKind && !branch) {
    return null;
  }

  return (
    <div
      data-testid="composer-context-strip"
      className="pointer-events-auto mx-auto flex w-full max-w-220 min-w-0 items-center gap-3 overflow-hidden pt-1.5 text-xs text-muted-foreground select-none"
    >
      {environmentLabel ? (
        <span
          data-testid="composer-context-environment"
          title={environmentLabel}
          className="inline-flex min-w-0 max-w-[28%] shrink items-center gap-1"
        >
          <ServerIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{environmentLabel}</span>
        </span>
      ) : null}

      {checkoutPath ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-testid="composer-context-folder"
                tabIndex={0}
                title={checkoutPath}
                onContextMenu={handleFolderContextMenu}
                onKeyDown={handleFolderKeyDown}
                className="pointer-events-auto inline-flex min-w-0 max-w-fit flex-1 items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            }
          >
            <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{folderBasename(checkoutPath)}</span>
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-120 whitespace-normal wrap-anywhere">
            {checkoutPath}
          </TooltipPopup>
        </Tooltip>
      ) : null}

      {checkoutKind ? (
        <span data-testid="composer-context-checkout-kind" className="shrink-0 whitespace-nowrap">
          {checkoutKind}
        </span>
      ) : null}

      {branch ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-testid="composer-context-branch"
                tabIndex={0}
                title={branch}
                onContextMenu={handleBranchContextMenu}
                onKeyDown={handleBranchKeyDown}
                className="pointer-events-auto inline-flex min-w-0 max-w-fit flex-1 items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            }
          >
            <GitBranchIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{branch}</span>
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-120 whitespace-normal wrap-anywhere">
            {branch}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
});
