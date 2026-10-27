import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@bibcode/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@bibcode/client-runtime/state/models";
import type { EnvironmentAvailabilityStatus } from "@bibcode/client-runtime/state/shell";
import {
  type EnvironmentId,
  isProviderDriverKind,
  type OrchestrationConversationPreview,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ScopedThreadRef,
  type TerminalSummary,
  ThreadId,
} from "@bibcode/contracts";

import { selectIsUnread } from "../../sidebarWorkspaceMetaStore";
import { formatProviderSlugLabel } from "../../providerModels";
import { normalizeSearchText } from "../CommandPalette.logic";
import {
  type AgentStatus,
  type AgentUnknownReason,
  resolveTerminalAgentStatus,
  resolveThreadAgentStatus,
  type ThreadStatusPill,
} from "../Sidebar.logic";

export type { AgentUnknownReason } from "../Sidebar.logic";

/**
 * The Agents view's status groups, shared with the Inbox (#186). `unknown` holds the
 * agents whose status BiBCode cannot vouch for; `AgentRow.unknownReason` says why.
 */
export type AgentGroupId = "working" | "blocked" | "waiting" | "done" | "unknown";

export const AGENT_GROUP_ORDER = [
  { id: "working", label: "Working" },
  { id: "blocked", label: "Pending Approval" },
  { id: "waiting", label: "Awaiting Input" },
  { id: "unknown", label: "Unknown" },
  { id: "done", label: "Done" },
] as const satisfies ReadonlyArray<{ id: AgentGroupId; label: string }>;

export const AGENTS_FILTER_MAX_BYTES = 2048;

export interface AgentRow {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
  /** The checkout's live branch when known, else the thread's recorded one. */
  readonly branch: string | null;
  readonly group: AgentGroupId;
  readonly pill: ThreadStatusPill | null;
  /** Why the row is in `unknown`; null in every other group. */
  readonly unknownReason: AgentUnknownReason | null;
  /** The AI Terminal this row is; null for the thread's chat agent. */
  readonly terminalId: string | null;
  readonly environmentLabel: string;
  readonly environmentLive: boolean;
  readonly environmentStatus: EnvironmentAvailabilityStatus | null;
  readonly projectTitle: string;
  readonly providerDriverKind: ProviderDriverKind | null;
  readonly providerLabel: string | null;
  readonly previewLine: string | null;
  readonly searchText: string;
}

export type AgentsGroupByMode = "status" | "project" | "environment";

export interface AgentViewGroup {
  readonly id: string;
  readonly label: string;
  readonly rows: ReadonlyArray<AgentRow>;
}

export function resolveAgentGroup(
  pill: ThreadStatusPill | null,
  unknownReason: AgentUnknownReason | null = null,
): AgentGroupId {
  if (unknownReason !== null) return "unknown";
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

export function resolveAgentProvider(providerName: string | null | undefined): {
  readonly driverKind: ProviderDriverKind | null;
  readonly label: string | null;
} {
  const trimmed = providerName?.trim() ?? "";
  if (trimmed === "") return { driverKind: null, label: null };
  // Sessions store the driver kind verbatim (for example `claudeAgent`).
  const driverKind = isProviderDriverKind(trimmed) ? trimmed : null;
  return {
    driverKind,
    label:
      (driverKind === null ? undefined : PROVIDER_DISPLAY_NAMES[driverKind]) ??
      formatProviderSlugLabel(trimmed),
  };
}

/** The preview line: the running tool while working, else the latest reply, else the prompt. */
export function resolveConversationPreviewLine(
  isWorking: boolean,
  preview: OrchestrationConversationPreview | null | undefined,
): string | null {
  if (preview === null || preview === undefined) return null;
  if (isWorking && preview.tool !== null) {
    return preview.tool;
  }
  return preview.assistantMessage ?? preview.prompt ?? null;
}

export function resolveAgentPreviewLine(
  pill: ThreadStatusPill | null,
  preview: OrchestrationConversationPreview | null | undefined,
): string | null {
  return resolveConversationPreviewLine(
    pill?.label === "Working" || pill?.label === "Connecting",
    preview,
  );
}

/** A checkout whose passive VCS summary names the branch of the rows in it. */
export interface AgentCheckout {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

function isAgentRowShell(shell: EnvironmentThreadShell): boolean {
  return shell.archivedAt === null && shell.session !== null;
}

/**
 * Each listed thread's checkout, as the left panel resolves it: its worktree, else its
 * project's root. Only live environments are read; other rows keep the recorded branch.
 */
export function resolveAgentCheckouts(input: {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly availabilityByEnvironmentId: ReadonlyMap<string, EnvironmentAvailabilityStatus>;
}): {
  readonly checkoutKeyByThreadKey: ReadonlyMap<string, string>;
  readonly checkouts: ReadonlyArray<AgentCheckout>;
} {
  const rootByProjectKey = new Map(
    input.projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project.workspaceRoot,
    ]),
  );
  const checkoutKeyByThreadKey = new Map<string, string>();
  const checkoutsByKey = new Map<string, AgentCheckout>();
  for (const shell of input.shells) {
    if (!isAgentRowShell(shell)) continue;
    if (input.availabilityByEnvironmentId.get(shell.environmentId) !== "live") continue;
    const cwd =
      shell.worktreePath ??
      rootByProjectKey.get(scopedProjectKey(scopeProjectRef(shell.environmentId, shell.projectId)));
    if (cwd === undefined) continue;
    const key = JSON.stringify([shell.environmentId, cwd]);
    checkoutKeyByThreadKey.set(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)), key);
    if (!checkoutsByKey.has(key)) {
      checkoutsByKey.set(key, { key, environmentId: shell.environmentId, cwd });
    }
  }
  return {
    checkoutKeyByThreadKey,
    checkouts: [...checkoutsByKey.values()].toSorted((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    ),
  };
}

/** The status clock and evidence stamps a row list reads (`useAgentFreshness`). */
export interface AgentRowFreshness {
  readonly now: number;
  /** When this client first saw `evidence` for the row `key`, on its own clock. */
  readonly evidenceAt: (
    key: string,
    evidence: string | undefined,
    ageMs: number | undefined,
    live: boolean,
  ) => number | null;
}

/** One environment's terminal metadata, as the terminal stream reports it. */
export interface AgentTerminalSource {
  readonly environmentId: EnvironmentId;
  readonly rows: ReadonlyArray<TerminalSummary>;
}

/** The row key of a thread's AI Terminal agent; its chat agent's row is the thread key. */
export function terminalAgentRowKey(threadKey: string, terminalId: string): string {
  return `${threadKey}#terminal:${terminalId}`;
}

/**
 * One row per agent: each thread's chat agent while it has a session, and each AI
 * Terminal it hosts, including in a workspace with no chat session at all. Without
 * `freshness` nothing decays and every environment counts as connected.
 */
export function buildAgentRows(input: {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly availabilityByEnvironmentId: ReadonlyMap<string, EnvironmentAvailabilityStatus>;
  /** Live branch per thread key; a thread without one shows its recorded branch. */
  readonly liveBranchByThreadKey?: ReadonlyMap<string, string>;
  readonly terminals?: ReadonlyArray<AgentTerminalSource>;
  readonly freshness?: AgentRowFreshness;
}): ReadonlyArray<AgentRow> {
  const rows: AgentRow[] = [];
  const shellsByKey = new Map<string, EnvironmentThreadShell>();
  for (const shell of input.shells) {
    if (shell.archivedAt !== null) continue;
    const key = scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));
    shellsByKey.set(key, shell);
    if (!isAgentRowShell(shell)) continue;
    const live = input.availabilityByEnvironmentId.get(shell.environmentId) === "live";
    const status = resolveThreadAgentStatus(
      shell,
      input.freshness === undefined
        ? undefined
        : {
            now: input.freshness.now,
            environmentLive: live,
            evidenceAt: input.freshness.evidenceAt(
              key,
              shell.lastActivityAt,
              shell.lastActivityAgeMs,
              live,
            ),
          },
    );
    rows.push(buildAgentRow(input, shell, key, null, status, chatAgentDetails(shell, status)));
  }
  for (const source of input.terminals ?? []) {
    const live = input.availabilityByEnvironmentId.get(source.environmentId) === "live";
    for (const terminal of source.rows) {
      const threadKey = scopedThreadKey(
        scopeThreadRef(source.environmentId, ThreadId.make(terminal.threadId)),
      );
      const shell = shellsByKey.get(threadKey);
      if (shell === undefined || terminal.agentStatus === undefined) continue;
      const key = terminalAgentRowKey(threadKey, terminal.terminalId);
      const status = resolveTerminalAgentStatus(
        terminal,
        input.freshness === undefined
          ? undefined
          : {
              now: input.freshness.now,
              environmentLive: live,
              evidenceAt: input.freshness.evidenceAt(
                key,
                terminal.agentStatus.observedAt,
                terminal.agentStatus.ageMs,
                live,
              ),
            },
      );
      if (status === null) continue;
      rows.push(
        buildAgentRow(input, shell, key, terminal.terminalId, status, {
          provider: resolveAgentProvider(terminal.command?.activity?.driverKind),
          previewLine: terminal.command?.label ?? terminal.label,
          searchTerms: [terminal.command?.label ?? "", terminal.label],
        }),
      );
    }
  }
  return rows;
}

interface AgentRowDetails {
  readonly provider: ReturnType<typeof resolveAgentProvider>;
  readonly previewLine: string | null;
  readonly searchTerms: ReadonlyArray<string>;
}

function chatAgentDetails(shell: EnvironmentThreadShell, status: AgentStatus): AgentRowDetails {
  const preview = shell.conversationPreview;
  return {
    provider: resolveAgentProvider(shell.session?.providerName),
    previewLine: resolveAgentPreviewLine(status.pill, preview),
    searchTerms: [
      shell.session?.providerName ?? "",
      preview?.prompt ?? "",
      preview?.tool ?? "",
      preview?.assistantMessage ?? "",
    ],
  };
}

function buildAgentRow(
  input: {
    readonly projectTitleById: ReadonlyMap<string, string>;
    readonly environmentLabelById: ReadonlyMap<string, string>;
    readonly availabilityByEnvironmentId: ReadonlyMap<string, EnvironmentAvailabilityStatus>;
    readonly liveBranchByThreadKey?: ReadonlyMap<string, string>;
  },
  shell: EnvironmentThreadShell,
  key: string,
  terminalId: string | null,
  status: AgentStatus,
  details: AgentRowDetails,
): AgentRow {
  const ref = scopeThreadRef(shell.environmentId, shell.id);
  const branch = input.liveBranchByThreadKey?.get(scopedThreadKey(ref)) ?? shell.branch;
  const { pill, unknownReason } = status;
  const projectTitle = input.projectTitleById.get(shell.projectId) ?? "";
  const environmentLabel = input.environmentLabelById.get(shell.environmentId) ?? "";
  const environmentStatus = input.availabilityByEnvironmentId.get(shell.environmentId) ?? null;
  return {
    key,
    ref,
    shell,
    branch,
    group: resolveAgentGroup(pill, unknownReason),
    pill,
    unknownReason,
    terminalId,
    environmentLabel,
    environmentLive: environmentStatus === "live",
    environmentStatus,
    projectTitle,
    providerDriverKind: details.provider.driverKind,
    providerLabel: details.provider.label,
    previewLine: details.previewLine,
    searchText: normalizeSearchText(
      [
        shell.title,
        projectTitle,
        branch ?? "",
        environmentLabel,
        pill?.label ?? "",
        ...details.searchTerms,
      ].join(" "),
    ),
  };
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
            row.key === options.selectedKey ||
            selectIsUnread(options.unreadThreadKeys, agentRowUnreadKey(row)),
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

/**
 * The unread key a row reads and marks: its thread's. A terminal row shares its host
 * thread's unread state instead of keeping one of its own.
 */
export function agentRowUnreadKey(row: Pick<AgentRow, "key" | "ref" | "terminalId">): string {
  return row.terminalId === null ? row.key : scopedThreadKey(row.ref);
}

/** Unread agents, counting each thread once whatever terminals it hosts. */
export function countUnreadAgentRows(
  rows: ReadonlyArray<AgentRow>,
  unreadThreadKeys: ReadonlyArray<string>,
): number {
  let count = 0;
  for (const row of rows) {
    if (row.terminalId === null && selectIsUnread(unreadThreadKeys, row.key)) {
      count += 1;
    }
  }
  return count;
}
