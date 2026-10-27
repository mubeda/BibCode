/**
 * The agent-row shape the Inbox reads, as agreed with the status work in #187
 * (`docs/superpowers/plans/2026-10-27-inbox.md`). Until that branch lands, the
 * extra fields are optional here and `STATUS_TONES` is mirrored; afterwards
 * `AgentRow` carries `group: "unknown"`, `unknownReason` and `terminalId`
 * itself, and these tones are imported from `Sidebar.logic.ts`.
 */
import type { ScopedThreadRef } from "@bibcode/contracts";
import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";

import type { AgentGroupId } from "../agentsSection.logic";

export type InboxAgentGroupId = AgentGroupId | "unknown";

/** The fields of an `AgentRow` the Inbox's pure logic reads. */
export interface InboxAgentRowFields {
  readonly key: string;
  /** The thread; for a terminal row, the host thread that owns the terminal. */
  readonly ref: ScopedThreadRef;
  readonly shell: Pick<EnvironmentThreadShell, "kind" | "hostThreadId" | "title" | "updatedAt">;
  readonly group: InboxAgentGroupId;
  /** The AI terminal this row is; null or absent for a chat row. */
  readonly terminalId?: string | null;
}

/** Mirrors `STATUS_TONES` in `Sidebar.logic.ts` until it is exported there. */
export const INBOX_STATUS_TONES = {
  approval: { colorClass: "text-amber-600 dark:text-amber-300/90" },
  working: { colorClass: "text-sky-600 dark:text-sky-300/80" },
  completed: { colorClass: "text-emerald-600 dark:text-emerald-300/90" },
} as const;
