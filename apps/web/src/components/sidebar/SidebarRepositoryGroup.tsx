import { ChevronRightIcon, FolderGit2Icon } from "lucide-react";
import { memo, useId, type ReactNode } from "react";

import { useUiStateStore } from "../../uiStateStore";
import { SIDEBAR_CARD_CLASS } from "../Sidebar.logic";
import { cn } from "~/lib/utils";
import { SidebarMenuItem } from "../ui/sidebar";
import type { RepositoryGroup } from "./repositoryView.logic";

/** A read-only grouping (no menu, rename, remove or drag); `actions` sit beside its toggle. */
export const SidebarRepositoryGroup = memo(function SidebarRepositoryGroup({
  group,
  expanded,
  actions,
  children,
}: {
  readonly group: RepositoryGroup;
  readonly expanded: boolean;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const listId = useId();
  const setRepositoryGroupExpanded = useUiStateStore((state) => state.setRepositoryGroupExpanded);
  const environmentCountLabel = `${group.environmentCount} ${
    group.environmentCount === 1 ? "environment" : "environments"
  }`;
  return (
    <SidebarMenuItem className={cn(SIDEBAR_CARD_CLASS, "p-1")} data-sidebar-card="true">
      <section
        aria-label={`Repository ${group.title}`}
        data-testid={`repository-group-${group.key}`}
      >
        <div className="group/repository-header flex items-center gap-0.5">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            onClick={() => setRepositoryGroupExpanded(group.key, !expanded)}
            className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
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
          {actions ? (
            <div className="pointer-events-none flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-focus-within/repository-header:pointer-events-auto group-focus-within/repository-header:opacity-100 group-hover/repository-header:pointer-events-auto group-hover/repository-header:opacity-100 max-sm:pointer-events-auto max-sm:opacity-100">
              {actions}
            </div>
          ) : null}
        </div>
        {expanded ? (
          <ul id={listId} className="mt-1 flex flex-col gap-1.5">
            {children}
          </ul>
        ) : null}
      </section>
    </SidebarMenuItem>
  );
});
