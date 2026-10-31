import type { McpActivityRow } from "@bibcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@bibcode/client-runtime/state/mcpActivity", () => ({
  createMcpActivityEnvironmentAtoms: () => ({ activity: () => null }),
  EMPTY_MCP_ACTIVITY: { rows: [], active: [] },
}));
vi.mock("./auth", () => ({ authEnvironment: { accessChanges: () => null } }));
vi.mock("./environments", () => ({ usePrimaryEnvironment: () => null }));
vi.mock("./query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
interface StopAnswer {
  revoked: boolean;
  interrupted?: number;
  failed?: number;
  timedOut?: boolean;
}
const stopServerMcpClient = vi.hoisted(() =>
  vi.fn(async (): Promise<StopAnswer> => ({ revoked: true, interrupted: 0, failed: 0 })),
);
vi.mock("../environments/primary", () => ({
  revokeServerClientSession: vi.fn(),
  setServerMcpClientAccess: vi.fn(),
  stopServerMcpClient,
  usePrimarySessionState: () => ({ data: null }),
}));

import { AuthSessionId } from "@bibcode/contracts";

import {
  agentCommitLabels,
  agentLabelForCommit,
  stopMcpAgent,
  takenOverLevel,
} from "./mcpActivity";

describe("stopMcpAgent", () => {
  it("fails when the server stopped nothing", async () => {
    stopServerMcpClient.mockResolvedValueOnce({ revoked: true, interrupted: 2, failed: 0 });
    await expect(stopMcpAgent(AuthSessionId.make("s-1"))).resolves.toBeUndefined();
    stopServerMcpClient.mockResolvedValueOnce({ revoked: false });
    await expect(stopMcpAgent(AuthSessionId.make("s-1"))).rejects.toThrow(
      "BiBCode no longer knows this agent",
    );
  });

  it("fails when an interrupt failed or did not finish in time", async () => {
    stopServerMcpClient.mockResolvedValueOnce({ revoked: true, interrupted: 1, failed: 1 });
    await expect(stopMcpAgent(AuthSessionId.make("s-1"))).rejects.toThrow(
      "1 of 2 turns could not be interrupted",
    );
    stopServerMcpClient.mockResolvedValueOnce({ revoked: true, timedOut: true });
    await expect(stopMcpAgent(AuthSessionId.make("s-1"))).rejects.toThrow("still interrupting");
  });
});

function row(id: number, sha: string | undefined, outcome = "success"): McpActivityRow {
  return {
    id,
    occurredAt: "2026-10-30T00:00:00.000Z",
    clientId: "s-1",
    label: id === 2 ? null : "Claude Code",
    tool: "git_commit",
    threadId: null,
    outcome,
    target: sha === undefined ? {} : { sha },
  };
}

describe("agent commit labels", () => {
  it("maps each commit an agent made to its label, by full or short sha", () => {
    const labels = agentCommitLabels([
      row(3, "abcdef1234567890"),
      row(2, "1234567890abcdef"),
      row(1, "fedcba", "McpOutcomeUnknownError"),
      row(0, undefined),
    ]);
    expect(agentLabelForCommit(labels, "abcdef1234567890")).toBe("Claude Code");
    expect(agentLabelForCommit(labels, "abcdef1")).toBe("Claude Code");
    expect(agentLabelForCommit(labels, "1234567890abcdef")).toBe("MCP agent");
    // A call that did not succeed made no commit worth marking.
    expect(agentLabelForCommit(labels, "fedcba")).toBeNull();
    expect(agentLabelForCommit(labels, "0000000")).toBeNull();
  });
});

describe("takenOverLevel", () => {
  it("is the level Hand back restores, and only an operate level", () => {
    expect(takenOverLevel(undefined)).toBeNull();
    expect(
      takenOverLevel({ mcpAccessHandBack: "full-access" } as Parameters<typeof takenOverLevel>[0]),
    ).toBe("full-access");
    expect(
      takenOverLevel({ mcpAccessHandBack: "read-only" } as Parameters<typeof takenOverLevel>[0]),
    ).toBeNull();
  });
});
