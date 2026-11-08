// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  active: [] as unknown[],
  clients: [] as unknown[],
  idle: [] as unknown[],
  canManage: true,
  revoke: vi.fn(async () => {}),
  setAccess: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));

vi.mock("~/state/mcpActivity", () => ({
  usePrimaryMcpActivity: () => ({
    rows: h.rows,
    active: h.active,
    canManage: h.canManage,
    environmentId: "env-1",
  }),
  usePrimaryMcpClients: () => h.clients,
  usePrimaryIdleNamedClients: () => h.idle,
  takenOverLevel: (client: { mcpAccessHandBack?: string } | undefined) =>
    client?.mcpAccessHandBack ?? null,
  stopMcpAgent: h.stop,
  revokeMcpAgent: h.revoke,
  setMcpAgentAccess: h.setAccess,
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (options: unknown) => options,
}));

import { activityTargetText, McpAgentsPanel } from "./McpAgentsPanel";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<McpAgentsPanel />);
  });
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
  if (!found) throw new Error(`no ${name} button`);
  return found;
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s-1",
    subject: "mcp-client",
    scopes: ["orchestration:read", "orchestration:operate"],
    client: { label: "Claude Code", deviceType: "unknown" },
    mcpAccess: "approval-required",
    ...overrides,
  };
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  h.rows = [];
  h.active = [];
  h.clients = [];
  h.idle = [];
  h.canManage = true;
  vi.clearAllMocks();
});

describe("McpAgentsPanel", () => {
  it("says how to connect an agent while none is authorized", async () => {
    const container = await render();
    expect(container.textContent).toContain("No agent is authorized");
    expect(container.textContent).toContain("No agent has changed anything yet.");
  });

  it("lists each agent with its access, and Revoke and Take over call their routes", async () => {
    h.clients = [client()];
    const container = await render();
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("operate · Supervised");

    await act(async () => button(container, "Take over").click());
    expect(h.setAccess).toHaveBeenCalledWith("s-1", "read-only");
    await act(async () => button(container, "Revoke").click());
    expect(h.revoke).toHaveBeenCalledWith("s-1");
  });

  it("offers Stop for an agent with running turns, revoked or not", async () => {
    h.clients = [client()];
    h.active = [
      { clientId: "s-1", label: "Claude Code", lastCallAt: null, running: true, runningTurns: 1 },
      { clientId: "s-2", label: "Codex", lastCallAt: null, running: true, runningTurns: 3 },
    ];
    const container = await render();
    expect(container.textContent).toContain("1 turn running");
    // Revoked, so not in Authorized clients, but its turns still run.
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Revoked · 3 turns running");
    const stops = [...container.querySelectorAll("button")].filter(
      (entry) => entry.textContent === "Stop",
    );
    expect(stops).toHaveLength(2);
    const revokedRow = [...container.querySelectorAll("li")].find((row) =>
      row.textContent?.includes("Codex"),
    );
    await act(async () => button(revokedRow!, "Stop").click());
    expect(h.stop).toHaveBeenCalledWith("s-2");
  });

  it("says a named agent keeps its identity, and that Revoke and Stop end it", async () => {
    h.clients = [
      client({ mcpNamedClient: { id: "nc_1", name: "builder" } }),
      client({ sessionId: "s-2", client: { label: "Codex", deviceType: "unknown" } }),
    ];
    h.active = [
      { clientId: "s-1", label: "MCP · builder", lastCallAt: null, running: true, runningTurns: 1 },
    ];
    const container = await render();
    const rows = [...container.querySelectorAll("li")];
    const named = rows.find((row) => row.textContent?.includes("Keeps its identity"))!;
    const unnamed = rows.find((row) => row.textContent?.includes("Codex"))!;
    expect(unnamed.textContent).not.toContain("Keeps its identity");
    const ends =
      "Ends this agent's identity. Its paired webhooks turn off, and its next run starts fresh.";
    expect(button(named, "Revoke").title).toBe(ends);
    expect(button(named, "Stop").title).toBe(ends);
    expect(button(unnamed, "Revoke").title).toBe("");
  });

  it("lists a named agent with no run live, whose Revoke ends its identity", async () => {
    h.idle = [{ id: "nc_1", name: "builder", createdAt: "2026-11-07T00:00:00.000Z" }];
    const container = await render();
    expect(container.textContent).not.toContain("No agent is authorized");
    const row = [...container.querySelectorAll("li")].find((entry) =>
      entry.textContent?.includes("MCP · builder"),
    )!;
    expect(row.textContent).toContain("Not running · Keeps its identity across runs");
    expect(button(row, "Revoke").title).toBe(
      "Ends this agent's identity. Its paired webhooks turn off, and its next run starts fresh.",
    );
    expect(row.textContent).not.toContain("Take over");
    await act(async () => button(row, "Revoke").click());
    expect(h.revoke).toHaveBeenCalledWith("nc_1");
  });

  it("offers no Revoke on an idle named agent without access:write", async () => {
    h.idle = [{ id: "nc_1", name: "builder", createdAt: "2026-11-07T00:00:00.000Z" }];
    h.canManage = false;
    const container = await render();
    expect(container.textContent).toContain("MCP · builder");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("warns that Stop on a revoked named run ends its identity", async () => {
    h.active = [
      {
        clientId: "s-old",
        label: "MCP · builder",
        lastCallAt: null,
        running: true,
        runningTurns: 1,
        namedClientId: "nc_1",
      },
      { clientId: "s-2", label: "Codex", lastCallAt: null, running: true, runningTurns: 1 },
    ];
    const container = await render();
    const rows = [...container.querySelectorAll("li")];
    const named = rows.find((row) => row.textContent?.includes("MCP · builder"))!;
    const unnamed = rows.find((row) => row.textContent?.includes("Codex"))!;
    expect(button(named, "Stop").title).toBe(
      "Ends this agent's identity. Its paired webhooks turn off, and its next run starts fresh.",
    );
    expect(button(unnamed, "Stop").title).toBe("");
  });

  it("hands a taken-over agent back to the level it had", async () => {
    h.clients = [client({ mcpAccess: "read-only", mcpAccessHandBack: "full-access" })];
    const container = await render();
    expect(container.textContent).toContain("Taken over (was Full access)");
    await act(async () => button(container, "Hand back").click());
    expect(h.setAccess).toHaveBeenCalledWith("s-1", "full-access");
  });

  it("lists activity with its target and outcome, and no controls without access:write", async () => {
    h.canManage = false;
    h.clients = [client()];
    h.rows = [
      {
        id: 2,
        occurredAt: "2026-10-30T10:00:00.000Z",
        clientId: "s-1",
        label: "Claude Code",
        tool: "git_commit",
        threadId: "t-1",
        outcome: "success",
        target: { sha: "abcdef1234567" },
      },
      {
        id: 1,
        occurredAt: "2026-10-30T09:00:00.000Z",
        clientId: "s-1",
        label: "Claude Code",
        tool: "git_push",
        threadId: "t-1",
        outcome: "McpOutcomeUnknownError",
        target: {},
      },
    ];
    const container = await render();
    expect(container.textContent).toContain("git_commit · commit abcdef1");
    expect(container.textContent).toContain("Outcome unknown");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("describes a target from ids and counts only", () => {
    expect(
      activityTargetText({
        id: 1,
        occurredAt: "2026-10-30T10:00:00.000Z",
        clientId: "s-1",
        label: null,
        tool: "git_stage",
        threadId: null,
        outcome: "success",
        target: { fileCount: 1, pullRequest: 7 },
      }),
    ).toBe("PR #7 · 1 file");
  });
});
