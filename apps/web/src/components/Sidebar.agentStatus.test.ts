import { ThreadId, type TerminalSummary } from "@bibcode/contracts";
import { DEFAULT_RUNTIME_MODE } from "../types";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentEvidenceStale,
  resolveTerminalAgentStatus,
  resolveThreadAgentStatus,
  resolveWorkspaceCardStatus,
  WORKSPACE_CARD_STATUS,
  type WorkspaceCardStatusContext,
} from "./Sidebar.logic";

// The left panel's agent status rules (#187): decay, offline, unavailable, and how a
// card folds its chat and its AI Terminals into one glyph.

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const FRESH = NOW - 60_000;
const STALE = NOW - AGENT_STATUS_STALE_AFTER_MS - 1;

const base = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestTurn: null,
  session: null,
  unresolvedDelivery: null,
};

function session(status: "running" | "starting" | "ready" | "error") {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: status === "running" ? ("turn-1" as never) : null,
    lastError: status === "error" ? "provider exited" : null,
    updatedAt: "2026-10-27T11:00:00.000Z",
  };
}

function terminal(
  state: NonNullable<TerminalSummary["agentStatus"]>["state"],
  overrides: { readonly running?: boolean; readonly failed?: boolean } = {},
): Pick<TerminalSummary, "status" | "agentStatus"> {
  return {
    status: overrides.running === false ? "exited" : "running",
    agentStatus: { state, failed: overrides.failed ?? false },
  };
}

const live = { now: NOW, evidenceAt: FRESH, environmentLive: true };

describe("isAgentEvidenceStale", () => {
  it("decays only past 30 minutes, and never without evidence", () => {
    expect(isAgentEvidenceStale(NOW - AGENT_STATUS_STALE_AFTER_MS, NOW)).toBe(false);
    expect(isAgentEvidenceStale(STALE, NOW)).toBe(true);
    expect(isAgentEvidenceStale(null, NOW)).toBe(false);
  });
});

describe("resolveThreadAgentStatus", () => {
  it("keeps a fresh Working and decays a silent one to an unknown No update", () => {
    const running = { ...base, session: session("running") };
    expect(resolveThreadAgentStatus(running, live).pill?.label).toBe("Working");
    expect(resolveThreadAgentStatus(running, { ...live, evidenceAt: STALE })).toMatchObject({
      pill: { label: "No update", pulse: false },
      unknownReason: "stale",
    });
    expect(
      resolveThreadAgentStatus(
        { ...base, session: session("starting") },
        { ...live, evidenceAt: STALE },
      ).unknownReason,
    ).toBe("stale");
  });

  it("never decays an approval or a question: the server holds them", () => {
    for (const thread of [
      { ...base, session: session("running"), hasPendingApprovals: true },
      { ...base, session: session("running"), hasPendingUserInput: true },
    ]) {
      expect(
        resolveThreadAgentStatus(thread, { ...live, evidenceAt: STALE }).unknownReason,
      ).toBeNull();
    }
    expect(
      resolveThreadAgentStatus(
        { ...base, session: session("running"), hasPendingUserInput: true },
        live,
      ).pill?.label,
    ).toBe("Awaiting Input");
  });

  it("reads a disconnected environment as offline whatever it cached", () => {
    expect(
      resolveThreadAgentStatus(
        { ...base, session: session("running"), hasPendingApprovals: true },
        { ...live, environmentLive: false },
      ),
    ).toMatchObject({ pill: { label: "Offline" }, unknownReason: "offline" });
  });

  it("names a failed session Failed instead of a plain Done", () => {
    expect(resolveThreadAgentStatus({ ...base, session: session("error") }, live)).toMatchObject({
      pill: { label: "Failed" },
      unknownReason: null,
    });
    expect(resolveThreadAgentStatus({ ...base, session: session("ready") }, live).pill).toBeNull();
  });

  it("applies no decay or connection rule without a context", () => {
    expect(resolveThreadAgentStatus({ ...base, session: session("running") }).pill?.label).toBe(
      "Working",
    );
  });
});

describe("resolveTerminalAgentStatus", () => {
  it("maps each observed state", () => {
    expect(resolveTerminalAgentStatus(terminal("working"), live)?.pill?.label).toBe("Working");
    expect(resolveTerminalAgentStatus(terminal("blocked"), live)?.pill?.label).toBe(
      "Pending Approval",
    );
    expect(resolveTerminalAgentStatus(terminal("waiting"), live)?.pill?.label).toBe(
      "Awaiting Input",
    );
    expect(resolveTerminalAgentStatus(terminal("done"), live)).toEqual({
      pill: null,
      unknownReason: null,
    });
    expect(resolveTerminalAgentStatus(terminal("done", { failed: true }), live)?.pill?.label).toBe(
      "Failed",
    );
    expect(
      resolveTerminalAgentStatus(terminal("working"), { ...live, evidenceAt: STALE })
        ?.unknownReason,
    ).toBe("stale");
  });

  it("never shows an unobserved agent as Working or Done", () => {
    expect(resolveTerminalAgentStatus(terminal("unavailable"), live)).toMatchObject({
      pill: { label: "Status unavailable" },
      unknownReason: "unavailable",
    });
    expect(
      resolveTerminalAgentStatus(terminal("unavailable", { running: false }), live),
      "an unobserved agent whose process ended is not listed",
    ).toBeNull();
  });

  it("lists nothing for a plain shell", () => {
    expect(resolveTerminalAgentStatus({ status: "running" }, live)).toBeNull();
  });
});

describe("resolveWorkspaceCardStatus with agents (#187)", () => {
  const context = (
    terminals: WorkspaceCardStatusContext["terminals"],
    overrides: Partial<WorkspaceCardStatusContext> = {},
  ): WorkspaceCardStatusContext => ({ ...live, terminals, ...overrides });

  it("never reads Done over an agent BiBCode cannot see", () => {
    // A finished, unseen chat and a Cursor terminal still running.
    const finished = {
      ...base,
      session: session("ready"),
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed" as const,
        requestedAt: "2026-10-27T11:00:00.000Z",
        startedAt: "2026-10-27T11:00:00.000Z",
        completedAt: "2026-10-27T11:05:00.000Z",
        assistantMessageId: null,
      },
    };
    expect(resolveWorkspaceCardStatus(finished, "2026-10-27T11:00:00.000Z")).toBe(
      WORKSPACE_CARD_STATUS.done,
    );
    expect(
      resolveWorkspaceCardStatus(
        finished,
        "2026-10-27T11:00:00.000Z",
        context([{ terminal: terminal("unavailable"), evidenceAt: null }]),
      ),
    ).toBe(WORKSPACE_CARD_STATUS.unavailable);
  });

  it("keeps the more urgent of the chat and its terminals", () => {
    const idle = { ...base, session: session("ready") };
    expect(
      resolveWorkspaceCardStatus(
        { ...base, session: session("running") },
        null,
        context([{ terminal: terminal("unavailable"), evidenceAt: null }]),
      ),
    ).toBe(WORKSPACE_CARD_STATUS.working);
    expect(
      resolveWorkspaceCardStatus(
        idle,
        null,
        context([{ terminal: terminal("waiting"), evidenceAt: FRESH }]),
      ),
    ).toBe(WORKSPACE_CARD_STATUS.input);
    expect(
      resolveWorkspaceCardStatus(
        idle,
        null,
        context([{ terminal: terminal("done"), evidenceAt: FRESH }]),
      ),
      "an agent idle at its prompt asks nothing",
    ).toBe(WORKSPACE_CARD_STATUS.idle);
    expect(
      resolveWorkspaceCardStatus(
        idle,
        null,
        context([{ terminal: terminal("working"), evidenceAt: STALE }]),
      ),
    ).toBe(WORKSPACE_CARD_STATUS.stale);
  });

  it("decays a silent chat and marks a disconnected claim offline", () => {
    const running = { ...base, session: session("running") };
    expect(resolveWorkspaceCardStatus(running, null, context([], { evidenceAt: STALE }))).toBe(
      WORKSPACE_CARD_STATUS.stale,
    );
    expect(resolveWorkspaceCardStatus(running, null, context([], { environmentLive: false }))).toBe(
      WORKSPACE_CARD_STATUS.offline,
    );
    expect(
      resolveWorkspaceCardStatus(
        { ...base, session: session("ready") },
        null,
        context([], { environmentLive: false }),
      ),
      "an idle card claims nothing and stays idle",
    ).toBe(WORKSPACE_CARD_STATUS.idle);
  });
});
