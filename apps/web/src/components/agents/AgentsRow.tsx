import { ArrowUpRightIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { cn } from "../../lib/utils";
import { selectIsUnread, useSidebarWorkspaceMetaStore } from "../../sidebarWorkspaceMetaStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import type { AgentRow } from "../sidebar/agentsSection.logic";

export interface AgentsRowProps {
  readonly row: AgentRow;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
  readonly onJumpToWorkspace: (row: AgentRow) => void;
}

function samePill(left: AgentRow["pill"], right: AgentRow["pill"]): boolean {
  return (
    left === right ||
    (left?.label === right?.label &&
      left?.colorClass === right?.colorClass &&
      left?.dotClass === right?.dotClass &&
      left?.pulse === right?.pulse)
  );
}

function sameAgentRow(left: AgentRow, right: AgentRow): boolean {
  return (
    left === right ||
    (left.key === right.key &&
      left.shell === right.shell &&
      left.environmentLabel === right.environmentLabel &&
      left.environmentLive === right.environmentLive &&
      left.environmentStatus === right.environmentStatus &&
      left.projectTitle === right.projectTitle &&
      left.previewLine === right.previewLine &&
      samePill(left.pill, right.pill))
  );
}

export const AgentsRow = memo(
  function AgentsRow({ row, selected, onSelect, onJumpToWorkspace }: AgentsRowProps) {
    const isUnread = useSidebarWorkspaceMetaStore((state) =>
      selectIsUnread(state.unreadThreadKeys, row.key),
    );
    const statusLabel = row.pill?.label ?? "Done";
    const projectBranch = [row.projectTitle, row.shell.branch].filter(Boolean).join(" · ");
    const environmentStatus = row.environmentLive ? null : row.environmentStatus;

    const handleSelect = useCallback(() => {
      onSelect(row.key);
    }, [onSelect, row.key]);
    const handleJumpToWorkspace = useCallback(() => {
      onJumpToWorkspace(row);
    }, [onJumpToWorkspace, row]);

    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          isActive={selected}
          className={cn(
            "h-auto min-h-16 items-stretch gap-0 px-2 py-1.5 pr-9",
            selected && "bg-accent/70 text-accent-foreground",
            !row.environmentLive && "opacity-60",
          )}
          aria-label={`${row.shell.title}, ${statusLabel}, ${row.environmentLabel}`}
          aria-pressed={selected}
          onClick={handleSelect}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 text-[10px] font-medium",
                  row.pill?.colorClass ?? "text-muted-foreground/60",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    row.pill?.dotClass ?? "bg-muted-foreground/30",
                    row.pill?.pulse && "animate-pulse",
                  )}
                />
                {statusLabel}
              </span>
              <span className={cn("min-w-0 flex-1 truncate", isUnread && "font-semibold")}>
                {row.shell.title}
              </span>
            </div>
            {projectBranch ? (
              <div className="truncate text-[10px] text-muted-foreground/60">{projectBranch}</div>
            ) : null}
            {row.previewLine ? (
              <div className="truncate text-[11px] text-muted-foreground/80">{row.previewLine}</div>
            ) : null}
            <div className="flex min-w-0 items-center justify-between gap-2 pt-0.5">
              <span className="min-w-0 truncate rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground/70">
                {row.environmentLabel}
                {environmentStatus ? ` · ${environmentStatus}` : null}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40">
                {formatRelativeTimeLabel(row.shell.updatedAt)}
              </span>
            </div>
          </div>
        </SidebarMenuButton>
        <SidebarMenuAction
          showOnHover
          className="top-1/2 right-2 size-6 -translate-y-1/2 bg-background/80"
          aria-label={`Jump to workspace for ${row.shell.title}`}
          title="Jump to workspace"
          onClick={handleJumpToWorkspace}
        >
          <ArrowUpRightIcon className="size-3.5" aria-hidden />
        </SidebarMenuAction>
      </SidebarMenuItem>
    );
  },
  (previous, next) =>
    previous.selected === next.selected &&
    previous.onSelect === next.onSelect &&
    previous.onJumpToWorkspace === next.onJumpToWorkspace &&
    sameAgentRow(previous.row, next.row),
);
