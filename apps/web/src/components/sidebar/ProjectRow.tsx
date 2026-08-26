import { ChevronRightIcon, EllipsisIcon, FolderGit2Icon } from "lucide-react";
import { memo, type KeyboardEvent, type MouseEvent, type Ref } from "react";

import type { EnvironmentTreeProjectRow } from "../../environmentTree";
import { cn } from "../../lib/utils";

export interface ProjectRowProps {
  readonly row: EnvironmentTreeProjectRow;
  readonly environmentLabel: string;
  readonly focused: boolean;
  readonly rowRef?: Ref<HTMLDivElement>;
  readonly onFocus: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onToggle: () => void;
  readonly onSelect: () => void;
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

export const ProjectRow = memo(function ProjectRow({
  row,
  environmentLabel,
  focused,
  rowRef,
  onFocus,
  onKeyDown,
  onToggle,
  onSelect,
  onContextMenu,
}: ProjectRowProps) {
  return (
    <div
      ref={rowRef}
      id={`environment-tree-row-${encodeURIComponent(row.key)}`}
      role="treeitem"
      aria-label={`Project ${row.label} in environment ${environmentLabel}`}
      aria-level={row.level}
      aria-posinset={row.ariaPosInSet}
      aria-setsize={row.ariaSetSize}
      aria-expanded={row.isExpanded}
      aria-selected={row.isSelected}
      data-environment-tree-row={row.key}
      data-focused={focused ? "true" : "false"}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      className={cn(
        "group/tree-row flex h-8 min-w-0 items-center rounded-md pr-1 pl-4 text-xs outline-hidden",
        row.isSelected && "bg-accent text-accent-foreground",
        focused && "ring-1 ring-ring",
        (row.isCached || row.isStale) && "text-muted-foreground",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${row.isExpanded ? "Collapse" : "Expand"} project ${row.label}`}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", row.isExpanded && "rotate-90")}
        />
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Open project ${row.label} in ${environmentLabel}`}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 text-left"
      >
        <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
        {row.activityLabel ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{row.activityLabel}</span>
        ) : null}
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Project actions for ${row.label} in ${environmentLabel}`}
        onClick={onContextMenu}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <EllipsisIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
});
