import type { McpActivityRow } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyMcpActivityEvent, EMPTY_MCP_ACTIVITY } from "./mcpActivity.ts";

function row(id: number, tool = "git_commit"): McpActivityRow {
  return {
    id,
    occurredAt: "2026-10-30T00:00:00.000Z",
    clientId: "session-1",
    label: "Claude Code",
    tool,
    threadId: "thread-1",
    outcome: "success",
    target: { sha: "abc123" },
  };
}

describe("applyMcpActivityEvent", () => {
  it("replaces on a snapshot, puts a new row first once, and keeps the active list apart", () => {
    const snapshot = applyMcpActivityEvent(EMPTY_MCP_ACTIVITY, {
      type: "snapshot",
      rows: [row(1)],
      active: [],
    });
    expect(snapshot.rows.map((entry) => entry.id)).toEqual([1]);

    const added = applyMcpActivityEvent(snapshot, { type: "row", row: row(2, "git_push") });
    expect(added.rows.map((entry) => entry.id)).toEqual([2, 1]);
    // A duplicate delivery keeps one row.
    expect(
      applyMcpActivityEvent(added, { type: "row", row: row(2, "git_push") }).rows,
    ).toHaveLength(2);

    const active = applyMcpActivityEvent(added, {
      type: "active",
      active: [{ clientId: "session-1", label: "Claude Code", lastCallAt: null, running: true }],
    });
    expect(active.rows).toBe(added.rows);
    expect(active.active[0]?.running).toBe(true);
  });

  it("keeps at most 200 rows", () => {
    let state = EMPTY_MCP_ACTIVITY;
    for (let id = 1; id <= 205; id += 1) {
      state = applyMcpActivityEvent(state, { type: "row", row: row(id) });
    }
    expect(state.rows).toHaveLength(200);
    expect(state.rows[0]?.id).toBe(205);
  });
});
