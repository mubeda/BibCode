import type { OrchestrationLatestTurnState } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AgentRow } from "./agentsSection.logic";
import { detectUnreadTransitions } from "./useAgentsUnread";

function rowWithTurn(key: string, turnId: string, state: OrchestrationLatestTurnState): AgentRow {
  return {
    key,
    shell: {
      latestTurn: { turnId, state },
    },
  } as unknown as AgentRow;
}

function rowWithoutTurn(key: string): AgentRow {
  return {
    key,
    shell: { latestTurn: null },
  } as unknown as AgentRow;
}

describe("detectUnreadTransitions", () => {
  it("marks unread when the latest turn transitions into a settled state", () => {
    const previous = new Map([["k1", "turn-1:running"]]);

    const result = detectUnreadTransitions({
      previous,
      rows: [rowWithTurn("k1", "turn-1", "completed")],
      openThreadKey: null,
    });

    expect(result.markUnreadKeys).toEqual(["k1"]);
    expect(result.next).toEqual(new Map([["k1", "turn-1:completed"]]));
  });

  it("does not mark the open route thread, unchanged states, or first observations", () => {
    const openThread = detectUnreadTransitions({
      previous: new Map([["k1", "turn-1:running"]]),
      rows: [rowWithTurn("k1", "turn-1", "completed")],
      openThreadKey: "k1",
    });
    const unchanged = detectUnreadTransitions({
      previous: new Map([["k1", "turn-1:completed"]]),
      rows: [rowWithTurn("k1", "turn-1", "completed")],
      openThreadKey: null,
    });
    const firstObservation = detectUnreadTransitions({
      previous: new Map(),
      rows: [rowWithTurn("k1", "turn-1", "completed")],
      openThreadKey: null,
    });

    expect(openThread.markUnreadKeys).toEqual([]);
    expect(openThread.next).toEqual(new Map([["k1", "turn-1:completed"]]));
    expect(unchanged.markUnreadKeys).toEqual([]);
    expect(unchanged.next).toEqual(new Map([["k1", "turn-1:completed"]]));
    expect(firstObservation.markUnreadKeys).toEqual([]);
    expect(firstObservation.next).toEqual(new Map([["k1", "turn-1:completed"]]));
  });

  it("treats interrupted and error like completed, and running/null as not-settled", () => {
    const result = detectUnreadTransitions({
      previous: new Map([
        ["interrupted", "turn-1:running"],
        ["error", "turn-2:running"],
        ["running", "turn-3:completed"],
        ["without-turn", "turn-4:running"],
      ]),
      rows: [
        rowWithTurn("interrupted", "turn-1", "interrupted"),
        rowWithTurn("error", "turn-2", "error"),
        rowWithTurn("running", "turn-3", "running"),
        rowWithoutTurn("without-turn"),
      ],
      openThreadKey: null,
    });

    expect(result.markUnreadKeys).toEqual(["interrupted", "error"]);
    expect(result.next).toEqual(
      new Map([
        ["interrupted", "turn-1:interrupted"],
        ["error", "turn-2:error"],
        ["running", "turn-3:running"],
      ]),
    );
  });
});
