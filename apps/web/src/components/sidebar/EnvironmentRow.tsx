import {
  ChevronRightIcon,
  CloudIcon,
  ContainerIcon,
  EllipsisIcon,
  MonitorIcon,
} from "lucide-react";
import { memo, type KeyboardEvent, type MouseEvent, type Ref } from "react";

import type { EnvironmentTreeEnvironmentRow } from "../../environmentTree";
import { cn } from "../../lib/utils";

export interface EnvironmentRowProps {
  readonly row: EnvironmentTreeEnvironmentRow;
  readonly focused: boolean;
  readonly rowRef?: Ref<HTMLDivElement>;
  readonly onFocus: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onToggle: () => void;
  readonly onSelect: () => void;
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}

function EnvironmentKindIcon({
  environmentKind,
}: Pick<EnvironmentTreeEnvironmentRow, "environmentKind">) {
  switch (environmentKind) {
    case "primary":
      return <MonitorIcon aria-hidden className="size-3.5 shrink-0" />;
    case "wsl":
      return <ContainerIcon aria-hidden className="size-3.5 shrink-0" />;
    case "remote":
      return <CloudIcon aria-hidden className="size-3.5 shrink-0" />;
  }
}

function EnvironmentStatus({ row }: { readonly row: EnvironmentTreeEnvironmentRow }) {
  if (row.status === "online") {
    return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />;
  }
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
      {row.statusText}
    </span>
  );
}

export const EnvironmentRow = memo(function EnvironmentRow({
  row,
  focused,
  rowRef,
  onFocus,
  onKeyDown,
  onToggle,
  onSelect,
  onContextMenu,
}: EnvironmentRowProps) {
  const accessibleName = `Environment ${row.label}, ${row.statusText}`;
  return (
    <div
      ref={rowRef}
      id={`environment-tree-row-${encodeURIComponent(row.key)}`}
      role="treeitem"
      aria-label={accessibleName}
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
        "group/tree-row flex h-8 min-w-0 items-center rounded-md px-1 text-xs outline-hidden",
        row.isSelected && "bg-accent text-accent-foreground",
        focused && "ring-1 ring-ring",
        (row.isCached || row.isStale) && "text-muted-foreground",
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${row.isExpanded ? "Collapse" : "Expand"} environment ${row.label}`}
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
        aria-label={`Open environment ${row.label}`}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 text-left"
      >
        <EnvironmentKindIcon environmentKind={row.environmentKind} />
        <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
        {row.secondaryLabel ? (
          <span className="max-w-20 truncate text-[10px] text-muted-foreground">
            {row.secondaryLabel}
          </span>
        ) : null}
        <EnvironmentStatus row={row} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Environment actions for ${row.label}`}
        onClick={onContextMenu}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <EllipsisIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
});
