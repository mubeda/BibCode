import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import type { ScopedThreadRef } from "@bibcode/contracts";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, BellIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { ChatRouteInset } from "../../routes/-ChatRouteInset";
import { selectIsUnread, useSidebarWorkspaceMetaStore } from "../../sidebarWorkspaceMetaStore";
import { setActiveEnvironmentId, useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentShellSummary } from "../../state/shell";
import { buildThreadRouteParams } from "../../threadRoutes";
import { resolveAgentsGroupExpanded, useUiStateStore } from "../../uiStateStore";
import ChatView from "../ChatView";
import {
  type AgentRow,
  type AgentsGroupByMode,
  buildAgentRows,
  buildAgentViewGroups,
  countUnreadAgentRows,
} from "../sidebar/agentsSection.logic";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarMenu } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { AgentsRow } from "./AgentsRow";

const GROUP_BY_LABELS: Record<AgentsGroupByMode, string> = {
  status: "Status",
  project: "Project",
  environment: "Environment",
};

function isAgentsGroupByMode(value: string | null): value is AgentsGroupByMode {
  return value === "status" || value === "project" || value === "environment";
}

export function AgentsPage() {
  const router = useRouter();
  const shells = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const availability = useEnvironmentShellSummary().statuses;
  const unreadThreadKeys = useSidebarWorkspaceMetaStore((state) => state.unreadThreadKeys);
  const markRead = useSidebarWorkspaceMetaStore((state) => state.markRead);
  const agentsGroupExpandedById = useUiStateStore((state) => state.agentsGroupExpandedById);
  const setAgentsGroupExpanded = useUiStateStore((state) => state.setAgentsGroupExpanded);
  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter);
  const [groupBy, setGroupBy] = useState<AgentsGroupByMode>("status");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

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
    [availability, environments, projects, shells],
  );
  const unreadCount = useMemo(
    () => countUnreadAgentRows(rows, unreadThreadKeys),
    [rows, unreadThreadKeys],
  );
  const groups = useMemo(
    () =>
      buildAgentViewGroups(rows, {
        query: deferredFilter,
        groupBy,
        unreadOnly,
        unreadThreadKeys,
        selectedKey,
      }),
    [deferredFilter, groupBy, rows, selectedKey, unreadOnly, unreadThreadKeys],
  );
  const selectedRow = useMemo(
    () => rows.find((row) => row.key === selectedKey) ?? null,
    [rows, selectedKey],
  );

  useEffect(() => {
    if (selectedKey !== null && !rows.some((row) => row.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [rows, selectedKey]);

  const handleBack = useCallback(() => {
    if (router.history.canGoBack?.()) {
      router.history.back();
      return;
    }
    void router.navigate({ to: "/" });
  }, [router]);

  const navigateToThread = useCallback(
    (ref: ScopedThreadRef) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      });
    },
    [router],
  );

  const handleSelect = useCallback(
    (key: string) => {
      markRead(key);
      setSelectedKey(key);
    },
    [markRead],
  );

  const handleJumpToWorkspace = useCallback(
    (row: AgentRow) => {
      markRead(row.key);
      setActiveEnvironmentId(row.ref.environmentId);
      navigateToThread(row.ref);
    },
    [markRead, navigateToThread],
  );

  const handleMarkAllRead = useCallback(() => {
    for (const row of rows) {
      if (selectIsUnread(unreadThreadKeys, row.key)) {
        markRead(row.key);
      }
    }
  }, [markRead, rows, unreadThreadKeys]);

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={handleBack}>
          <ArrowLeftIcon className="size-4" aria-hidden />
        </Button>
        <h1 className="text-sm font-medium">agents</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {unreadCount} unread
        </span>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          className="flex w-[340px] shrink-0 flex-col border-r border-border bg-card"
          data-testid="agents-view-list"
        >
          <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1.5 border-b border-border/70 p-2">
            <input
              type="search"
              className="h-7 min-w-0 rounded-md border border-border/70 bg-background px-2 text-xs outline-hidden placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="Filter agents"
              placeholder="Filter agents…"
              data-testid="agents-filter-input"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
            />
            <Select
              value={groupBy}
              onValueChange={(value) => {
                if (isAgentsGroupByMode(value)) setGroupBy(value);
              }}
            >
              <SelectTrigger
                size="xs"
                variant="ghost"
                className="w-auto min-w-20"
                aria-label="Group agents by"
              >
                <SelectValue>{GROUP_BY_LABELS[groupBy]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="status">Status</SelectItem>
                <SelectItem value="project">Project</SelectItem>
                <SelectItem value="environment">Environment</SelectItem>
              </SelectPopup>
            </Select>
            <Toggle
              size="xs"
              variant="ghost"
              pressed={unreadOnly}
              onPressedChange={setUnreadOnly}
              aria-label="Show unread only"
              title="Show unread only"
            >
              <BellIcon className="size-3.5" aria-hidden />
            </Toggle>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Agents actions"
                    title="Agents actions"
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={unreadCount === 0} onClick={handleMarkAllRead}>
                  Mark all read
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
            <div className="min-w-0" data-text-surface="card">
              {rows.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">No agents yet</div>
              ) : groups.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">No agents found</div>
              ) : (
                groups.map((group) => {
                  const groupExpanded = resolveAgentsGroupExpanded(
                    agentsGroupExpandedById,
                    group.id,
                  );
                  return (
                    <div key={group.id} className="min-w-0">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                        data-testid={`agents-group-${group.id}`}
                        aria-expanded={groupExpanded}
                        onClick={() => setAgentsGroupExpanded(group.id, !groupExpanded)}
                      >
                        <span className="flex min-w-0 items-center gap-1">
                          <ChevronRightIcon
                            className={cn(
                              "size-3 shrink-0 transition-transform",
                              groupExpanded && "rotate-90",
                            )}
                            aria-hidden
                          />
                          <span className="truncate">{group.label}</span>
                        </span>
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                          {group.rows.length}
                        </span>
                      </button>

                      {groupExpanded ? (
                        <SidebarMenu role="list" className="gap-0.5">
                          {group.rows.map((row) => (
                            <AgentsRow
                              key={row.key}
                              row={row}
                              selected={row.key === selectedKey}
                              onSelect={handleSelect}
                              onJumpToWorkspace={handleJumpToWorkspace}
                            />
                          ))}
                        </SidebarMenu>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 bg-background">
          {selectedRow === null ? (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              Select an agent to view its activity
            </div>
          ) : (
            <ChatRouteInset>
              <ChatView
                environmentId={selectedRow.ref.environmentId}
                threadId={selectedRow.ref.threadId}
                routeKind="server"
              />
            </ChatRouteInset>
          )}
        </section>
      </div>
    </main>
  );
}
