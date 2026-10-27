import { parseScopedThreadKey, scopedThreadKey } from "@bibcode/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type ComponentType, useCallback, useEffect, useMemo, useRef } from "react";

import {
  selectFocusedCenterSurface,
  selectThreadCenterPanelState,
  useCenterPanelStore,
} from "../../../centerPanelStore";
import { useSidebarWorkspaceMetaStore } from "../../../sidebarWorkspaceMetaStore";
import { setActiveEnvironmentId } from "../../../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../../threadRoutes";
import { type InboxCategory, useUiStateStore } from "../../../uiStateStore";
import { AgentsRow, type AgentsRowProps } from "../../agents/AgentsRow";
import { SidebarContent, SidebarGroup, SidebarMenu, useSidebar } from "../../ui/sidebar";
import { InboxCategoryTiles } from "./InboxCategoryTiles";
import {
  INBOX_CATEGORIES,
  countInboxCategories,
  type InboxOpenTarget,
  isInboxRowCurrent,
  resolveInboxOpenTarget,
  resolveInboxSelection,
  selectInboxRows,
} from "./inbox.logic";
import { useInboxAgentRows } from "./useInboxAgentRows";

/**
 * The agent card without its Jump to workspace action: here the whole card
 * opens the workspace. #187 makes `onJumpToWorkspace` optional on `AgentsRow`;
 * once that lands this alias is the component itself.
 */
const InboxAgentCard = AgentsRow as unknown as ComponentType<
  Omit<AgentsRowProps, "onJumpToWorkspace"> & {
    readonly onJumpToWorkspace?: AgentsRowProps["onJumpToWorkspace"];
  }
>;

const EMPTY_STATES: Record<InboxCategory, { readonly title: string; readonly detail?: string }> = {
  all: { title: "No agents yet.", detail: "Start a chat in a project and it shows up here." },
  attention: {
    title: "Nothing needs you.",
    detail: "Approvals and questions from agents appear here.",
  },
  working: { title: "No agents are running." },
  done: { title: "No finished agents yet." },
};

/** Focuses the agent's surface in its host's center layout; the route then shows it. */
function focusInboxTarget(target: InboxOpenTarget): void {
  const store = useCenterPanelStore.getState();
  switch (target.surface.kind) {
    case "terminal":
      store.openTerminalPanel(target.hostRef, target.surface.terminalId);
      return;
    case "panel":
      store.openChatPanel(target.hostRef, target.surface.threadId, target.surface.providerLabel);
      return;
    case "host":
      store.openHostChat(target.hostRef);
  }
}

export function SidebarInboxView() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { rows, dataState } = useInboxAgentRows();
  const persistedCategory = useUiStateStore((state) => state.inboxCategory);
  const setInboxCategory = useUiStateStore((state) => state.setInboxCategory);
  const markRead = useSidebarWorkspaceMetaStore((state) => state.markRead);
  const routeThreadKey = useParams({
    strict: false,
    select: (params) => {
      const ref = resolveThreadRouteRef(params);
      return ref === null ? null : scopedThreadKey(ref);
    },
  });
  const focusedSurfaceId = useCenterPanelStore((state) => {
    if (routeThreadKey === null) return null;
    const routeRef = parseScopedThreadKey(routeThreadKey);
    return (
      selectFocusedCenterSurface(selectThreadCenterPanelState(state.byThreadKey, routeRef))?.id ??
      null
    );
  });

  const counts = useMemo(() => countInboxCategories(rows), [rows]);
  const { category, settle } = resolveInboxSelection({
    persisted: persistedCategory,
    counts,
    dataState,
  });
  useEffect(() => {
    if (settle !== null) setInboxCategory(settle);
  }, [setInboxCategory, settle]);

  const visibleRows = useMemo(() => selectInboxRows(rows, category), [category, rows]);
  // Rows change on every agent event; reading them through a ref keeps `openAgent`
  // stable, so the memoized cards re-render only when their own row changes.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const openAgent = useCallback(
    (key: string) => {
      const row = rowsRef.current.find((entry) => entry.key === key);
      if (row === undefined) return;
      const target = resolveInboxOpenTarget(row);
      // Terminal rows show their host's unread state, which the host's chat clears.
      if (target.surface.kind !== "terminal") markRead(row.key);
      setActiveEnvironmentId(target.hostRef.environmentId);
      focusInboxTarget(target);
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(target.hostRef),
      });
    },
    [isMobile, markRead, navigate, setOpenMobile],
  );

  const label = INBOX_CATEGORIES.find((entry) => entry.id === category)?.label ?? "";
  const empty = EMPTY_STATES[category];

  return (
    <SidebarContent className="min-h-full gap-0" data-testid="sidebar-inbox-view">
      <SidebarGroup className="px-2 pt-2 pb-1">
        <InboxCategoryTiles counts={counts} selected={category} onSelect={setInboxCategory} />
      </SidebarGroup>
      <SidebarGroup className="px-2 py-1">
        <div className="min-w-0" data-text-surface="card">
          {dataState === "partial" ? (
            <p className="px-2 pb-1.5 text-xs text-muted-foreground" data-testid="inbox-partial">
              Some servers are not connected. Their agents may be missing or out of date.
            </p>
          ) : null}
          {dataState === "loading" ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">Loading agents…</p>
          ) : visibleRows.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground" data-testid="inbox-empty">
              <span className="font-medium text-foreground/80">{empty.title}</span>
              {empty.detail ? ` ${empty.detail}` : null}
            </p>
          ) : (
            <SidebarMenu role="list" aria-label={`${label} agents`} className="gap-0">
              {visibleRows.map((row) => (
                <InboxAgentCard
                  key={row.key}
                  row={row}
                  selected={isInboxRowCurrent(
                    resolveInboxOpenTarget(row),
                    routeThreadKey,
                    focusedSurfaceId,
                  )}
                  onSelect={openAgent}
                />
              ))}
            </SidebarMenu>
          )}
        </div>
      </SidebarGroup>
    </SidebarContent>
  );
}
