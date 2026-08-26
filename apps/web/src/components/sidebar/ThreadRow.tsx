import { BellIcon, GitBranchIcon, MessageSquareIcon, PinIcon, StarIcon } from "lucide-react";
import { memo, type KeyboardEvent, type MouseEvent, type Ref } from "react";

import type { EnvironmentTreeThreadRow } from "../../environmentTree";
import { cn } from "../../lib/utils";

export interface ThreadRowProps {
  readonly row: EnvironmentTreeThreadRow;
  readonly environmentLabel: string;
  readonly projectLabel: string;
  readonly pinned: boolean;
  readonly unread: boolean;
  readonly focused: boolean;
  readonly rowRef?: Ref<HTMLDivElement>;
  readonly onFocus: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onSelect: () => void;
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

function ThreadRoleIcon({ role }: Pick<EnvironmentTreeThreadRow, "role">) {
  switch (role) {
    case "main":
      return <StarIcon aria-hidden className="size-3.5 shrink-0" />;
    case "ordinary":
      return <MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />;
    case "worktree":
      return <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />;
  }
}

function roleLabel(role: EnvironmentTreeThreadRow["role"]): string {
  switch (role) {
    case "main":
      return "Main thread";
    case "ordinary":
      return "Thread";
    case "worktree":
      return "Worktree thread";
  }
}

export const ThreadRow = memo(function ThreadRow({
  row,
  environmentLabel,
  projectLabel,
  pinned,
  unread,
  focused,
  rowRef,
  onFocus,
  onKeyDown,
  onSelect,
  onContextMenu,
}: ThreadRowProps) {
  const threadRole = roleLabel(row.role);
  const stateLabels = [pinned ? "Pinned" : null, unread ? "Unread" : null, row.activityLabel]
    .filter((label): label is string => Boolean(label))
    .join(", ");
  return (
    <div
      ref={rowRef}
      id={`environment-tree-row-${encodeURIComponent(row.key)}`}
      role="treeitem"
      aria-label={`${threadRole} ${row.label} in project ${projectLabel}, environment ${environmentLabel}${stateLabels ? `, ${stateLabels}` : ""}`}
      aria-level={row.level}
      aria-posinset={row.ariaPosInSet}
      aria-setsize={row.ariaSetSize}
      aria-selected={row.isSelected}
      data-environment-tree-row={row.key}
      data-thread-role={row.role}
      data-focused={focused ? "true" : "false"}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onClick={onSelect}
      className={cn(
        "group/tree-row flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md pr-2 pl-12 text-xs outline-hidden",
        row.isSelected && "bg-accent text-accent-foreground",
        focused && "ring-1 ring-ring",
        (row.isCached || row.isStale) && "text-muted-foreground",
      )}
    >
      <ThreadRoleIcon role={row.role} />
      {unread ? <BellIcon aria-label="Unread" className="size-3 shrink-0 text-sky-500" /> : null}
      {pinned ? <PinIcon aria-label="Pinned" className="size-3 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
      {row.secondaryLabel ? (
        <span className="max-w-24 truncate text-[10px] text-muted-foreground">
          {row.secondaryLabel}
        </span>
      ) : null}
      {row.activityLabel ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">{row.activityLabel}</span>
      ) : null}
    </div>
  );
});
