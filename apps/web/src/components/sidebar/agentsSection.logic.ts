import { scopeThreadRef, scopedThreadKey } from "@bibcode/client-runtime/environment";
import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import type { OrchestrationConversationPreview, ScopedThreadRef } from "@bibcode/contracts";

import { selectIsUnread } from "../../sidebarWorkspaceMetaStore";
import { normalizeSearchText } from "../CommandPalette.logic";
import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";

export type AgentGroupId = "working" | "blocked" | "waiting" | "done";

export const AGENT_GROUP_ORDER = [
  { id: "working", label: "Working" },
  { id: "blocked", label: "Pending Approval" },
  { id: "waiting", label: "Awaiting Input" },
  { id: "done", label: "Done" },
] as const satisfies ReadonlyArray<{ id: AgentGroupId; label: string }>;

export const AGENTS_FILTER_MAX_BYTES = 2048;

export interface AgentRow {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
  readonly group: AgentGroupId;
  readonly pill: ThreadStatusPill | null;
  readonly environmentLabel: string;
  readonly environmentLive: boolean;
  readonly environmentStatus: EnvironmentAvailabilityStatus | null;
  readonly projectTitle: string;
  readonly previewLine: string | null;
  readonly searchText: string;
}

export type AgentsGroupByMode = "status" | "project" | "environment";

export interface AgentViewGroup {
  readonly id: string;
  readonly label: string;
  readonly rows: ReadonlyArray<AgentRow>;
}

export function resolveAgentGroup(pill: ThreadStatusPill | null): AgentGroupId {
  switch (pill?.label) {
    case "Working":
    case "Connecting":
      return "working";
    case "Pending Approval":
      return "blocked";
    case "Awaiting Input":
    case "Plan Ready":
      return "waiting";
    default:
      return "done";
  }
}

export function resolveAgentPreviewLine(
  pill: ThreadStatusPill | null,
  preview: OrchestrationConversationPreview | null | undefined,
): string | null {
  if (preview === null || preview === undefined) return null;
  if ((pill?.label === "Working" || pill?.label === "Connecting") && preview.tool !== null) {
    return preview.tool;
  }
  return preview.assistantMessage ?? preview.prompt ?? null;
}

export function buildAgentRows(input: {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly availabilityByEnvironmentId: ReadonlyMap<string, EnvironmentAvailabilityStatus>;
}): ReadonlyArray<AgentRow> {
  return input.shells
    .filter((shell) => shell.archivedAt === null && shell.session !== null)
    .map((shell) => {
      const ref = scopeThreadRef(shell.environmentId, shell.id);
      const pill = resolveThreadStatusPill({ thread: shell });
      const group = resolveAgentGroup(pill);
      const projectTitle = input.projectTitleById.get(shell.projectId) ?? "";
      const environmentLabel = input.environmentLabelById.get(shell.environmentId) ?? "";
      const environmentStatus = input.availabilityByEnvironmentId.get(shell.environmentId) ?? null;
      const preview = shell.conversationPreview;

      return {
        key: scopedThreadKey(ref),
        ref,
        shell,
        group,
        pill,
        environmentLabel,
        environmentLive: environmentStatus === "live",
        environmentStatus,
        projectTitle,
        previewLine: resolveAgentPreviewLine(pill, preview),
        searchText: normalizeSearchText(
          [
            shell.title,
            projectTitle,
            shell.branch ?? "",
            environmentLabel,
            shell.session?.providerName ?? "",
            pill?.label ?? "",
            preview?.prompt ?? "",
            preview?.tool ?? "",
            preview?.assistantMessage ?? "",
          ].join(" "),
        ),
      } satisfies AgentRow;
    });
}

function compareAgentRows(left: AgentRow, right: AgentRow): number {
  const updatedAtOrder = Date.parse(right.shell.updatedAt) - Date.parse(left.shell.updatedAt);
  if (updatedAtOrder !== 0) {
    return updatedAtOrder;
  }
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

export function buildAgentViewGroups(
  rows: ReadonlyArray<AgentRow>,
  options: {
    readonly query: string;
    readonly groupBy: AgentsGroupByMode;
    readonly unreadOnly: boolean;
    readonly unreadThreadKeys: ReadonlyArray<string>;
    readonly selectedKey: string | null;
  },
): ReadonlyArray<AgentViewGroup> {
  if (new TextEncoder().encode(options.query).length > AGENTS_FILTER_MAX_BYTES) {
    return [];
  }

  const normalizedQuery = normalizeSearchText(options.query);
  const rowsByStatus = new Map<AgentGroupId, AgentRow[]>();
  for (const row of rows) {
    if (!row.searchText.includes(normalizedQuery)) {
      continue;
    }
    const statusRows = rowsByStatus.get(row.group);
    if (statusRows === undefined) {
      rowsByStatus.set(row.group, [row]);
    } else {
      statusRows.push(row);
    }
  }

  const filteredGroups = AGENT_GROUP_ORDER.flatMap(({ id, label }) => {
    const statusRows = rowsByStatus.get(id);
    if (statusRows === undefined || statusRows.length === 0) {
      return [];
    }
    return [{ id, label, rows: statusRows.sort(compareAgentRows) }];
  });
  const visibleGroups = options.unreadOnly
    ? filteredGroups.flatMap((group) => {
        const visibleRows = group.rows.filter(
          (row) =>
            row.key === options.selectedKey || selectIsUnread(options.unreadThreadKeys, row.key),
        );
        return visibleRows.length === 0 ? [] : [{ ...group, rows: visibleRows }];
      })
    : filteredGroups;
  if (options.groupBy === "status") {
    return visibleGroups.map((group) => ({
      id: `status:${group.id}`,
      label: group.label,
      rows: group.rows,
    }));
  }

  const filteredRows = visibleGroups.flatMap((group) => group.rows);
  const rowsByLabel = new Map<string, AgentRow[]>();
  for (const row of filteredRows) {
    const rowLabel = options.groupBy === "project" ? row.projectTitle : row.environmentLabel;
    const label = rowLabel === "" ? "Unknown" : rowLabel;
    const labelRows = rowsByLabel.get(label);
    if (labelRows === undefined) {
      rowsByLabel.set(label, [row]);
    } else {
      labelRows.push(row);
    }
  }

  return Array.from(rowsByLabel, ([label, labelRows]) => ({
    id: `${options.groupBy}:${label}`,
    label,
    rows: labelRows.sort(compareAgentRows),
  })).sort((left, right) => compareAgentRows(left.rows[0]!, right.rows[0]!));
}

export function countUnreadAgentRows(
  rows: ReadonlyArray<AgentRow>,
  unreadThreadKeys: ReadonlyArray<string>,
): number {
  let count = 0;
  for (const row of rows) {
    if (selectIsUnread(unreadThreadKeys, row.key)) {
      count += 1;
    }
  }
  return count;
}
