import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import type { ScopedThreadRef } from "@bibcode/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useCallback, useDeferredValue, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { selectIsUnread, useSidebarWorkspaceMetaStore } from "../../sidebarWorkspaceMetaStore";
import { setActiveEnvironmentId, useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentShellSummary } from "../../state/shell";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { resolveAgentsGroupExpanded, useUiStateStore } from "../../uiStateStore";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import {
  AGENTS_GROUP_PREVIEW_COUNT,
  type AgentRow,
  buildAgentRows,
  groupAgentRows,
} from "./agentsSection.logic";

export interface AgentsSectionProps {
  readonly navigateToThread: (ref: ScopedThreadRef) => void;
}

interface AgentsRowProps {
  readonly navigateToThread: (ref: ScopedThreadRef) => void;
  readonly row: AgentRow;
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

const AgentsRow = memo(
  function AgentsRow({ navigateToThread, row }: AgentsRowProps) {
    const isUnread = useSidebarWorkspaceMetaStore((state) =>
      selectIsUnread(state.unreadThreadKeys, row.key),
    );
    const markRead = useSidebarWorkspaceMetaStore((state) => state.markRead);
    const statusLabel = row.pill?.label ?? "Done";
    const projectBranch = [row.projectTitle, row.shell.branch].filter(Boolean).join(" · ");
    const environmentStatus = row.environmentLive ? null : row.environmentStatus;

    const handleClick = useCallback(() => {
      markRead(row.key);
      setActiveEnvironmentId(row.ref.environmentId);
      navigateToThread(row.ref);
    }, [markRead, navigateToThread, row.key, row.ref]);

    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          className={cn(
            "h-auto min-h-16 items-stretch gap-0 px-2 py-1.5",
            !row.environmentLive && "opacity-60",
          )}
          aria-label={`${row.shell.title}, ${statusLabel}, ${row.environmentLabel}`}
          onClick={handleClick}
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
      </SidebarMenuItem>
    );
  },
  (previous, next) =>
    previous.navigateToThread === next.navigateToThread && sameAgentRow(previous.row, next.row),
);

export const AgentsSection = memo(function AgentsSection({ navigateToThread }: AgentsSectionProps) {
  const shells = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const availability = useEnvironmentShellSummary().statuses;
  const rows = useMemo(
    () =>
      buildAgentRows({
        shells,
        projectTitleById: new Map<string, string>(
          projects.map((project) => [project.id, project.title]),
        ),
        environmentLabelById: new Map<string, string>(
          environments.map((environment) => [environment.environmentId, environment.label]),
        ),
        availabilityByEnvironmentId: new Map<string, EnvironmentAvailabilityStatus>(
          availability.map(({ environmentId, status }) => [environmentId, status]),
        ),
      }),
    [shells, projects, environments, availability],
  );

  const agentsSectionExpanded = useUiStateStore((state) => state.agentsSectionExpanded);
  const agentsGroupExpandedById = useUiStateStore((state) => state.agentsGroupExpandedById);
  const setAgentsSectionExpanded = useUiStateStore((state) => state.setAgentsSectionExpanded);
  const setAgentsGroupExpanded = useUiStateStore((state) => state.setAgentsGroupExpanded);
  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter);
  const [expandedOverflow, setExpandedOverflow] = useState<ReadonlySet<string>>(() => new Set());
  const groups = useMemo(() => groupAgentRows(rows, deferredFilter), [deferredFilter, rows]);

  const toggleOverflow = useCallback((groupId: string) => {
    setExpandedOverflow((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  return (
    <SidebarGroup className="px-2 py-1">
      <button
        type="button"
        className="mb-1 flex w-full items-center justify-between rounded-md py-1 pl-2 pr-1.5 text-left hover:bg-accent"
        data-testid="agents-section-header"
        aria-expanded={agentsSectionExpanded}
        onClick={() => setAgentsSectionExpanded(!agentsSectionExpanded)}
      >
        <span className="flex min-w-0 items-center gap-1">
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground/60 transition-transform",
              agentsSectionExpanded && "rotate-90",
            )}
          />
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Agents
          </span>
        </span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-muted-foreground/70">
          {rows.length}
        </span>
      </button>

      {agentsSectionExpanded ? (
        <div className="flex min-w-0 flex-col gap-1">
          <input
            type="search"
            className="h-7 w-full rounded-md border border-border/70 bg-background px-2 text-xs outline-hidden placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Filter agents"
            placeholder="Filter agents…"
            data-testid="agents-filter-input"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />

          {rows.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground/60">No agents yet</div>
          ) : (
            groups.map((group) => {
              const groupExpanded = resolveAgentsGroupExpanded(agentsGroupExpandedById, group.id);
              const overflowExpanded = expandedOverflow.has(group.id);
              const visibleRows = overflowExpanded
                ? group.rows
                : group.rows.slice(0, AGENTS_GROUP_PREVIEW_COUNT);
              const hiddenCount = group.rows.length - AGENTS_GROUP_PREVIEW_COUNT;

              return (
                <div key={group.id} className="min-w-0">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[10px] font-medium text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                    data-testid={`agents-group-${group.id}`}
                    aria-expanded={groupExpanded}
                    onClick={() => setAgentsGroupExpanded(group.id, !groupExpanded)}
                  >
                    <span>{group.label}</span>
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] tabular-nums text-muted-foreground/70">
                      {group.rows.length}
                    </span>
                  </button>

                  {groupExpanded ? (
                    <SidebarMenu role="list" className="gap-0.5">
                      {visibleRows.map((row) => (
                        <AgentsRow key={row.key} row={row} navigateToThread={navigateToThread} />
                      ))}
                      {hiddenCount > 0 ? (
                        <SidebarMenuItem>
                          <SidebarMenuButton
                            size="sm"
                            className="justify-center text-[10px] text-muted-foreground/60"
                            onClick={() => toggleOverflow(group.id)}
                          >
                            {overflowExpanded ? "Show less" : `Show more (${hiddenCount})`}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ) : null}
                    </SidebarMenu>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </SidebarGroup>
  );
});
