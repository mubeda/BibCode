// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  active: [] as unknown[],
  clients: [] as unknown[],
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
