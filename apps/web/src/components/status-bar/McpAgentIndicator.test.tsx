// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;

const h = vi.hoisted(() => ({
  active: [] as unknown[],
  clients: [] as unknown[],
  canManage: true,
  stop: vi.fn(async () => {}),
  setAccess: vi.fn(async () => {}),
  revoke: vi.fn(async () => {}),
}));

vi.mock("~/state/mcpActivity", () => ({
  usePrimaryMcpActivity: () => ({
    rows: [],
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

vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: AnyProps) => <>{props.children as ReactNode}</>,
  TooltipTrigger: (props: AnyProps) => {
    const render = props.render as { props: AnyProps } | undefined;
    return <span {...(render?.props ?? {})}>{props.children as ReactNode}</span>;
  },
  TooltipPopup: (props: AnyProps) => <div data-tooltip-popup>{props.children as ReactNode}</div>,
}));

import { McpAgentIndicator } from "./McpAgentIndicator";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<McpAgentIndicator />);
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

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  h.active = [];
  h.clients = [];
  h.canManage = true;
  vi.clearAllMocks();
});

describe("McpAgentIndicator", () => {
  it("shows nothing while no agent is active", async () => {
    const container = await render();
    expect(container.textContent).toBe("");
  });

  it("names the active agent, and Stop and Take over call their routes", async () => {
    h.active = [{ clientId: "s-1", label: "Claude Code", lastCallAt: null, running: true }];
    h.clients = [{ sessionId: "s-1", subject: "mcp-client", mcpAccess: "full-access" }];
    const container = await render();
    expect(container.textContent).toContain("Agent active · Claude Code");

    await act(async () => button(container, "Stop").click());
    expect(h.stop).toHaveBeenCalledWith("s-1");

    await act(async () => button(container, "Take over").click());
    expect(h.setAccess).toHaveBeenCalledWith("s-1", "read-only");
  });

  it("offers Hand back to the level it had once taken over", async () => {
    h.active = [{ clientId: "s-1", label: "Codex", lastCallAt: null, running: false }];
    h.clients = [{ sessionId: "s-1", mcpAccess: "read-only", mcpAccessHandBack: "auto-accept-edits" }];
    const container = await render();
    expect(container.textContent).toContain("Taken over · Codex");
    await act(async () => button(container, "Hand back").click());
    expect(h.setAccess).toHaveBeenCalledWith("s-1", "auto-accept-edits");
  });

  it("shows no controls to a session that may not manage access", async () => {
    h.active = [{ clientId: "s-1", label: "Claude Code", lastCallAt: null, running: true }];
    h.canManage = false;
    const container = await render();
    expect(container.textContent).toContain("Agent active · Claude Code");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
