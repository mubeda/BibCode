import type { ScopedProjectRef, VcsWorktreeDescriptor } from "@bibcode/contracts";
import { CloudDownloadIcon, FolderGit2Icon, GitBranchIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

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

export interface GitManagerToolbarProps {
  readonly projectRef: ScopedProjectRef;
  readonly mainCheckoutCwd: string;
  readonly selectedWorktreeCwd: string;
  readonly worktrees: ReadonlyArray<VcsWorktreeDescriptor>;
  readonly catalogPending: boolean;
  readonly catalogError: string | null;
  readonly onSelectedWorktreeChange: (cwd: string) => void;
}

export const GitManagerToolbar = memo(function GitManagerToolbar({
  projectRef,
  mainCheckoutCwd,
  selectedWorktreeCwd,
  worktrees,
  catalogPending,
  catalogError,
  onSelectedWorktreeChange,
}: GitManagerToolbarProps) {
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

  return (
    <header
      className="flex min-w-0 items-stretch border-b border-border bg-card/20"
      data-environment-id={projectRef.environmentId}
      data-project-id={projectRef.projectId}
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

      {/* TODO(PHASE-10): replace the branch placeholder with the branch dropdown. */}
      <div className="flex min-w-0 flex-1 items-center border-r border-border px-2 py-1.5">
        <button
          aria-describedby="git-manager-branch-placeholder-reason"
          aria-label="Branch Selector Coming in Phase 10"
          className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground opacity-60"
          disabled
          title="Branch controls are not available in this phase."
          type="button"
        >
          <GitBranchIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">Current Branch</span>
        </button>
        <span className="sr-only" id="git-manager-branch-placeholder-reason">
          Branch controls are not available in this phase.
        </span>
      </div>

      {/* TODO(PHASE-10): replace the sync placeholder with fetch/pull/push controls. */}
      <div className="flex min-w-0 flex-1 items-center px-2 py-1.5">
        <button
          aria-describedby="git-manager-sync-placeholder-reason"
          aria-label="Sync Controls Coming in Phase 10"
          className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground opacity-60"
          disabled
          title="Sync controls are not available in this phase."
          type="button"
        >
          <CloudDownloadIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">Fetch Origin</span>
        </button>
        <span className="sr-only" id="git-manager-sync-placeholder-reason">
          Sync controls are not available in this phase.
        </span>
      </div>
    </header>
  );
});
