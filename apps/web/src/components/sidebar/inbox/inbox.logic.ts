import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentShellSummary } from "@bibcode/client-runtime/state/shell";
import type { ScopedThreadRef, ThreadId } from "@bibcode/contracts";

import { panelProviderLabel } from "../../../centerPanelAdoption";
import { HOST_SURFACE_ID } from "../../../centerPanelStore";
import type { InboxCategory } from "../../../uiStateStore";
import type { InboxAgentGroupId, InboxAgentRowFields } from "./agentRowContract";

export interface InboxCategoryDefinition {
  readonly id: InboxCategory;
  readonly label: string;
  /** The status groups the tile lists; null lists every row, `unknown` included. */
  readonly groups: ReadonlyArray<InboxAgentGroupId> | null;
}

/** The confirmed tile mapping (#186). `unknown` rows appear only under All Agents. */
export const INBOX_CATEGORIES = [
  { id: "all", label: "All Agents", groups: null },
  { id: "attention", label: "Needs Attention", groups: ["blocked", "waiting"] },
  { id: "working", label: "Working", groups: ["working"] },
  { id: "done", label: "Done", groups: ["done"] },
] as const satisfies ReadonlyArray<InboxCategoryDefinition>;

export type InboxCategoryCounts = Readonly<Record<InboxCategory, number>>;

function categoryOf(group: InboxAgentGroupId): InboxCategory | null {
  switch (group) {
    case "blocked":
    case "waiting":
      return "attention";
    case "working":
      return "working";
    case "done":
      return "done";
    default:
      return null;
  }
}

export function countInboxCategories(
  rows: ReadonlyArray<Pick<InboxAgentRowFields, "group">>,
): InboxCategoryCounts {
  const counts = { all: rows.length, attention: 0, working: 0, done: 0 };
  for (const row of rows) {
    const category = categoryOf(row.group);
    if (category !== null) counts[category] += 1;
  }
  return counts;
}

function compareByRecentActivity(left: InboxAgentRowFields, right: InboxAgentRowFields): number {
  const order = Date.parse(right.shell.updatedAt) - Date.parse(left.shell.updatedAt);
  if (order !== 0) return order;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** The rows a tile lists, most recent activity first. */
export function selectInboxRows<Row extends InboxAgentRowFields>(
  rows: ReadonlyArray<Row>,
  category: InboxCategory,
): ReadonlyArray<Row> {
  const selected =
    category === "all" ? [...rows] : rows.filter((row) => categoryOf(row.group) === category);
  return selected.sort(compareByRecentActivity);
}

/**
 * How far the agent lists can be trusted. `partial` covers an offline,
 * reconnecting or still-synchronizing environment (its rows may be missing or
 * stale) and an unreadable saved-server catalog.
 */
export type InboxDataState = "loading" | "partial" | "complete";

export function resolveInboxDataState(summary: EnvironmentShellSummary): InboxDataState {
  if (!summary.catalogReady) return "loading";
  if (!summary.hasSnapshot && summary.statuses.some(isTransientStatus)) return "loading";
  const complete =
    summary.catalogHealth.status === "ready" &&
    summary.statuses.every((status) => status.status === "live" && status.hasSnapshot);
  return complete ? "complete" : "partial";
}

function isTransientStatus(status: EnvironmentShellSummary["statuses"][number]): boolean {
  return status.status === "starting" || status.status === "synchronizing";
}

/**
 * The tile to show and, when the default has settled, the tile to persist.
 * With nothing persisted, Needs Attention wins once any agent needs attention;
 * All Agents is only persisted when every environment has reported, so a
 * missing remote cannot hide an approval behind the default.
 */
export function resolveInboxSelection(input: {
  readonly persisted: InboxCategory | null;
  readonly counts: InboxCategoryCounts;
  readonly dataState: InboxDataState;
}): { readonly category: InboxCategory; readonly settle: InboxCategory | null } {
  if (input.persisted !== null) return { category: input.persisted, settle: null };
  if (input.dataState === "loading") return { category: "all", settle: null };
  if (input.counts.attention > 0) return { category: "attention", settle: "attention" };
  return { category: "all", settle: input.dataState === "complete" ? "all" : null };
}

export type InboxOpenSurface =
  | { readonly kind: "host" }
  | { readonly kind: "panel"; readonly threadId: ThreadId; readonly providerLabel?: string }
  | { readonly kind: "terminal"; readonly terminalId: string };

export interface InboxOpenTarget {
  /** The thread whose route and center layout show the agent. */
  readonly hostRef: ScopedThreadRef;
  readonly surface: InboxOpenSurface;
}

export function resolveInboxOpenTarget(row: InboxAgentRowFields): InboxOpenTarget {
  const terminalId = row.terminalId ?? null;
  if (terminalId !== null) {
    return { hostRef: row.ref, surface: { kind: "terminal", terminalId } };
  }
  const hostThreadId = row.shell.hostThreadId;
  if (row.shell.kind === "panel" && hostThreadId !== undefined) {
    const providerLabel = panelProviderLabel(row.shell.title);
    return {
      hostRef: scopeThreadRef(row.ref.environmentId, hostThreadId),
      surface: {
        kind: "panel",
        threadId: row.ref.threadId,
        ...(providerLabel !== undefined ? { providerLabel } : {}),
      },
    };
  }
  return { hostRef: row.ref, surface: { kind: "host" } };
}

export function inboxTargetSurfaceId(target: InboxOpenTarget): string {
  switch (target.surface.kind) {
    case "terminal":
      return `terminal:${target.surface.terminalId}`;
    case "panel":
      return `chat:${target.surface.threadId}`;
    case "host":
      return HOST_SURFACE_ID;
  }
}

/** Whether the main area shows this agent: its host is routed and its surface focused. */
export function isInboxRowCurrent(
  target: InboxOpenTarget,
  routeThreadKey: string | null,
  focusedSurfaceId: string | null,
): boolean {
  return (
    routeThreadKey === scopedThreadKey(target.hostRef) &&
    focusedSurfaceId === inboxTargetSurfaceId(target)
  );
}
