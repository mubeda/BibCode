import { type AgentSessionHistoryEntry, ThreadId } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  COPY_NEEDS_UPDATE,
  HISTORY_NOT_STARTED_REASON,
  HISTORY_VIEW_ONLY_REASON,
  historyUnavailableReason,
  terminalSessionRow,
  viewOnlyReason,
} from "./ComposerHistoryMenu.logic";

function entry(overrides: Partial<AgentSessionHistoryEntry> = {}): AgentSessionHistoryEntry {
  return {
    sessionId: "1a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40",
    title: "Flaky test",
    lastActiveAt: "2026-10-24T10:00:00.000Z",
    branch: "feature/history",
    liveness: "closed",
    importDeleted: false,
    ...overrides,
  } as AgentSessionHistoryEntry;
}

const imported = {
  threadId: ThreadId.make("import:claudeAgent:1a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40"),
  hostThreadId: ThreadId.make("host"),
  archived: true,
  resumeRefused: false,
};

describe("History's disabled reasons", () => {
  it("names the first reason that applies", () => {
    const ready = { started: true, unavailableEnvironmentLabel: null, workspaceUnavailable: null };
    expect(historyUnavailableReason(ready)).toBeNull();
    expect(
      historyUnavailableReason({
        started: false,
        unavailableEnvironmentLabel: "Studio",
        workspaceUnavailable: "gone",
      }),
    ).toBe(HISTORY_NOT_STARTED_REASON);
    expect(historyUnavailableReason({ ...ready, unavailableEnvironmentLabel: "Studio" })).toBe(
      "Studio is not connected",
    );
    expect(
      historyUnavailableReason({ ...ready, workspaceUnavailable: "This worktree is missing." }),
    ).toBe("This worktree is missing.");
  });

  it("disables History only for a scope list that lacks operate access", () => {
    expect(viewOnlyReason(undefined)).toBeNull();
    expect(viewOnlyReason(["orchestration:read", "orchestration:operate"])).toBeNull();
    expect(viewOnlyReason(["orchestration:read"])).toBe(HISTORY_VIEW_ONLY_REASON);
    expect(viewOnlyReason([])).toBe(HISTORY_VIEW_ONLY_REASON);
  });
});

describe("terminal session rows", () => {
  it("continues a closed session that has no thread yet", () => {
    expect(terminalSessionRow(entry(), true)).toEqual({
      action: { kind: "continue", mode: "resume" },
      actionLabel: "Continue",
      status: null,
      disabledReason: null,
    });
  });

  it("offers a copy whenever another writer may hold the session", () => {
    for (const [overrides, status] of [
      [{ liveness: "live" }, "Open in a terminal"],
      [{ liveness: "unknown" }, "Can't tell whether it's open"],
      [{ importDeleted: true }, null],
      [{ importedThread: { ...imported, resumeRefused: true } }, "Couldn't continue it here"],
    ] as const) {
      expect(terminalSessionRow(entry(overrides), true)).toEqual({
        action: { kind: "continue", mode: "fork" },
        actionLabel: "Continue in a copy",
        status,
        disabledReason: null,
      });
    }
  });

  it("disables a copy this server's Claude Code can't make", () => {
    const row = terminalSessionRow(entry({ liveness: "live" }), false);
    expect(row.disabledReason).toBe(COPY_NEEDS_UPDATE);
    expect(terminalSessionRow(entry(), false).disabledReason).toBeNull();
  });

  it("opens a session that already has a usable thread, live or not", () => {
    expect(
      terminalSessionRow(entry({ importedThread: imported, liveness: "live" }), false),
    ).toEqual({
      action: {
        kind: "open",
        threadId: imported.threadId,
        hostThreadId: imported.hostThreadId,
        archived: true,
      },
      actionLabel: "Open",
      status: null,
      disabledReason: null,
    });
  });
});
