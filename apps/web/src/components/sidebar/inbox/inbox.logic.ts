import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentShellSummary } from "@bibcode/client-runtime/state/shell";
import type { ScopedThreadRef, ThreadId } from "@bibcode/contracts";

import { panelProviderLabel } from "../../../centerPanelAdoption";
import { HOST_SURFACE_ID } from "../../../centerPanelStore";
import type { InboxCategory } from "../../../uiStateStore";
import type { AgentGroupId, AgentRow } from "../agentsSection.logic";

/** The fields of an `AgentRow` the Inbox's pure logic reads. */
export type InboxAgentRowFields = Pick<AgentRow, "key" | "ref" | "group" | "terminalId"> & {
  readonly shell: Pick<AgentRow["shell"], "kind" | "hostThreadId" | "title" | "updatedAt">;
};

export interface InboxCategoryDefinition {
  readonly id: InboxCategory;
  readonly label: string;
  /** The status groups the tile lists; null lists every row, `unknown` included. */
  readonly groups: ReadonlyArray<AgentGroupId> | null;
}

/** The confirmed tile mapping (#186). `unknown` rows appear only under All Agents. */
export const INBOX_CATEGORIES = [
  { id: "all", label: "All Agents", groups: null },
  { id: "attention", label: "Needs Attention", groups: ["blocked", "waiting"] },
  { id: "working", label: "Working", groups: ["working"] },
  { id: "done", label: "Done", groups: ["done"] },
] as const satisfies ReadonlyArray<InboxCategoryDefinition>;

export type InboxCategoryCounts = Readonly<Record<InboxCategory, number>>;

function categoryOf(group: AgentGroupId): InboxCategory | null {
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

export interface InboxEnvironmentInfo {
  readonly label: string;
  /** A saved remote server, which Remote Servers settings can reconnect. */
  readonly remote: boolean;
}

/** Why the lists are partial, most actionable first. */
export type InboxPartialReason =
  | { readonly kind: "catalog" }
  | {
      readonly kind: "offline";
      readonly labels: ReadonlyArray<string>;
      readonly allRemote: boolean;
    }
  | { readonly kind: "reconnecting"; readonly labels: ReadonlyArray<string> };

export function resolveInboxPartialReason(
  summary: EnvironmentShellSummary,
  environmentById: ReadonlyMap<string, InboxEnvironmentInfo>,
): InboxPartialReason | null {
  if (summary.catalogHealth.status !== "ready") return { kind: "catalog" };
  const offline: InboxEnvironmentInfo[] = [];
  const reconnecting: InboxEnvironmentInfo[] = [];
  for (const status of summary.statuses) {
    if (status.status === "live" && status.hasSnapshot) continue;
    const info = environmentById.get(status.environmentId) ?? { label: "", remote: false };
    if (isTransientStatus(status) || status.status === "live") reconnecting.push(info);
    else offline.push(info);
  }
  if (offline.length > 0) {
    return {
      kind: "offline",
      labels: offline.map((info) => info.label),
      allRemote: offline.every((info) => info.remote),
    };
  }
  if (reconnecting.length > 0) {
    return { kind: "reconnecting", labels: reconnecting.map((info) => info.label) };
  }
  return null;
}

export interface InboxPartialNotice {
  readonly message: string;
  /** Where the user can fix it; reconnecting needs no action. */
  readonly action: { readonly to: "remote-servers" | "diagnostics"; readonly label: string } | null;
}

function serversPhrase(labels: ReadonlyArray<string>, state: string): string {
  return labels.length === 1
    ? `${labels[0] || "A server"} is ${state}, so its agents`
    : `${labels.length} servers are ${state}, so their agents`;
}

export function describeInboxPartialReason(reason: InboxPartialReason): InboxPartialNotice {
  switch (reason.kind) {
    case "catalog":
      return {
        message: "Saved servers couldn't be read, so their agents aren't listed.",
        action: { to: "diagnostics", label: "Diagnostics" },
      };
    case "offline":
      return {
        message: `${serversPhrase(reason.labels, "not connected")} may be missing or out of date.`,
        action: reason.allRemote
          ? { to: "remote-servers", label: "Open Remote Servers" }
          : { to: "diagnostics", label: "Diagnostics" },
      };
    case "reconnecting":
      return {
        message: `${serversPhrase(reason.labels, "reconnecting")} may be out of date.`,
        action: null,
      };
  }
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
  if (row.terminalId !== null) {
    return { hostRef: row.ref, surface: { kind: "terminal", terminalId: row.terminalId } };
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
