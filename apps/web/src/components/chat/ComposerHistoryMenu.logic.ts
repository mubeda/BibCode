/**
 * Pure model for the composer's History menu: why the button is disabled, and what each Claude
 * Code terminal session row offers.
 */
import {
  AuthOrchestrationOperateScope,
  type AgentSessionHistoryEntry,
  type AgentSessionOpenMode,
  type ThreadId,
} from "@bibcode/contracts";

export const HISTORY_NOT_STARTED_REASON = "Available once this thread has started.";
export const HISTORY_VIEW_ONLY_REASON = "This connection can only view threads.";

/** Why History cannot be used for this thread now, or `null`. The first reason that applies wins. */
export function historyUnavailableReason(input: {
  readonly started: boolean;
  readonly unavailableEnvironmentLabel: string | null;
  readonly workspaceUnavailable: string | null;
}): string | null {
  if (!input.started) return HISTORY_NOT_STARTED_REASON;
  if (input.unavailableEnvironmentLabel !== null) {
    return `${input.unavailableEnvironmentLabel} is not connected`;
  }
  return input.workspaceUnavailable;
}

/**
 * The reason a connection with these granted scopes can't use History. Only a list that is
 * present and lacks operate access says so: an older server sends no list, and its refusal then
 * shows in the menu instead.
 */
export function viewOnlyReason(scopes: ReadonlyArray<string> | undefined): string | null {
  return scopes !== undefined && !scopes.includes(AuthOrchestrationOperateScope)
    ? HISTORY_VIEW_ONLY_REASON
    : null;
}

/** What choosing a terminal session row does. */
export type TerminalSessionAction =
  | {
      readonly kind: "open";
      readonly threadId: ThreadId;
      /** The panel's host, or `null` for a sidebar thread. */
      readonly hostThreadId: ThreadId | null;
      readonly archived: boolean;
    }
  | { readonly kind: "continue"; readonly mode: AgentSessionOpenMode };

export interface TerminalSessionRow {
  readonly action: TerminalSessionAction;
  /** The name of the action, shown on the row. */
  readonly actionLabel: string;
  /** Why the row is not plain Continue: open in a terminal, unknown, refused. */
  readonly status: string | null;
  /** A row whose copy this server's Claude Code can't make. */
  readonly disabledReason: string | null;
}

export const COPY_NEEDS_UPDATE = "Update Claude Code to continue this in a copy.";

/**
 * The action a row takes. A session is continued itself only when nothing says another writer
 * may have it: a session a terminal has open (or may have), a deleted import, and an import whose
 * resume Claude refused are continued in a copy. An import that is still usable opens.
 */
export function terminalSessionRow(
  entry: AgentSessionHistoryEntry,
  copySupported: boolean,
): TerminalSessionRow {
  const imported = entry.importedThread;
  if (imported !== undefined && !imported.resumeRefused) {
    return {
      action: {
        kind: "open",
        threadId: imported.threadId,
        hostThreadId: imported.hostThreadId,
        archived: imported.archived,
      },
      actionLabel: "Open",
      status: null,
      disabledReason: null,
    };
  }
  const status =
    imported?.resumeRefused === true
      ? "Couldn't continue it here"
      : entry.liveness === "live"
        ? "Open in a terminal"
        : entry.liveness === "unknown"
          ? "Can't tell whether it's open"
          : null;
  const copy = status !== null || entry.importDeleted;
  if (!copy) {
    return {
      action: { kind: "continue", mode: "resume" },
      actionLabel: "Continue",
      status: null,
      disabledReason: null,
    };
  }
  return {
    action: { kind: "continue", mode: "fork" },
    actionLabel: "Continue in a copy",
    status,
    disabledReason: copySupported ? null : COPY_NEEDS_UPDATE,
  };
}
