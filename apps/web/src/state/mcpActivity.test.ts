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
vi.mock("../environments/primary", () => ({
  revokeServerClientSession: vi.fn(),
  setServerMcpClientAccess: vi.fn(),
  stopServerMcpClient: vi.fn(),
  usePrimarySessionState: () => ({ data: null }),
}));

import { agentCommitLabels, agentLabelForCommit, takenOverLevel } from "./mcpActivity";

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
