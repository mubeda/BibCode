import { ChevronRightIcon, FolderGit2Icon } from "lucide-react";
import { memo, useId, type ReactNode } from "react";

import { useUiStateStore } from "../../uiStateStore";
import { SidebarMenuItem } from "../ui/sidebar";
import type { RepositoryGroup } from "./repositoryView.logic";

/** A read-only grouping: no menu, rename, remove or drag. */
export const SidebarRepositoryGroup = memo(function SidebarRepositoryGroup({
  group,
  expanded,
  children,
}: {
  readonly group: RepositoryGroup;
  readonly expanded: boolean;
  readonly children: ReactNode;
}) {
  const listId = useId();
  const setRepositoryGroupExpanded = useUiStateStore((state) => state.setRepositoryGroupExpanded);
  const environmentCountLabel = `${group.environmentCount} ${
    group.environmentCount === 1 ? "environment" : "environments"
  }`;
  return (
    <SidebarMenuItem className="rounded-[10px] border border-border/75 bg-muted/30 p-1">
      <section
        aria-label={`Repository ${group.title}`}
        data-testid={`repository-group-${group.key}`}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          onClick={() => setRepositoryGroupExpanded(group.key, !expanded)}
          className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={`size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
          <FolderGit2Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
            {group.title}
            {group.showHost && group.host ? (
              <span className="font-normal text-muted-foreground">{` · ${group.host}`}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{environmentCountLabel}</span>
        </button>
        {expanded ? (
          <ul id={listId} className="mt-1 flex flex-col gap-1.5">
            {children}
          </ul>
        ) : null}
      </section>
    </SidebarMenuItem>
  );
});
