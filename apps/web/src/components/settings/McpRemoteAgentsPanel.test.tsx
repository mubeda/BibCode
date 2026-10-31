// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;

const h = vi.hoisted(() => ({
  baseUrl: null as string | null,
  settings: {
    enableMcpServer: true,
    mcpServerAccess: "approval-required",
    mcpCapabilities: { terminals: false },
  } as Record<string, unknown>,
  requests: [] as unknown[],
  canManage: true,
  copied: [] as string[],
  approve: vi.fn(async (..._args: unknown[]) => {}),
  deny: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("../../state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => h.baseUrl,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_environmentId: string, selector: (settings: unknown) => unknown) =>
    selector(h.settings),
}));

vi.mock("../../state/mcpAuthorizations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/mcpAuthorizations")>();
  return {
    ...actual,
    usePrimaryMcpAuthorizations: () => ({ requests: h.requests, canManage: h.canManage }),
    approveMcpAuthorization: h.approve,
    denyMcpAuthorization: h.deny,
  };
});

vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: (text: string) => h.copied.push(text),
    isCopied: false,
  }),
}));

vi.mock("../ui/select", () => ({
  Select: (props: AnyProps) => (
    <div data-disabled={String(Boolean(props.disabled))} data-value={props.value as string}>
      <select
        aria-label="level"
        value={props.value as string}
        disabled={Boolean(props.disabled)}
        onChange={(event) => (props.onValueChange as (value: string) => void)(event.target.value)}
      >
        <option value="read-only">read-only</option>
        <option value="approval-required">approval-required</option>
        <option value="auto-accept-edits">auto-accept-edits</option>
        <option value="full-access">full-access</option>
      </select>
      {props.children as ReactNode}
    </div>
  ),
  SelectTrigger: (props: AnyProps) => <span>{props.children as ReactNode}</span>,
  SelectValue: (props: AnyProps) => <span>{props.children as ReactNode}</span>,
  SelectPopup: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  SelectItem: (props: AnyProps) => <div role="option">{props.children as ReactNode}</div>,
}));

vi.mock("../ui/checkbox", () => ({
  Checkbox: (props: AnyProps) => (
    <input
      type="checkbox"
      aria-label="terminals"
      checked={Boolean(props.checked)}
      disabled={Boolean(props.disabled)}
      onChange={(event) =>
        (props.onCheckedChange as (checked: boolean) => void)(event.target.checked)
      }
    />
  ),
}));

import { approvableLevels, McpRemoteAgentsPanel } from "./McpRemoteAgentsPanel";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(isPrimary = true): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<McpRemoteAgentsPanel environmentId={"env-1" as never} isPrimary={isPrimary} />);
  });
  return container;
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(name),
  );
  if (!found) throw new Error(`no ${name} button`);
  return found;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "a-1",
    code: "ABCD-2345",
    clientName: "Claude Code",
    redirectHost: "localhost:53682",
    redirectIsLoopback: true,
    origin: "https://env-1.connect.example",
    scopes: ["orchestration:read", "orchestration:operate"],
    createdAt: "2026-10-31T10:00:00Z",
    expiresAt: "2026-10-31T10:10:00Z",
    ...overrides,
  };
}

async function choose(container: HTMLElement, level: string) {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="level"]')!;
  await act(async () => {
    select.value = level;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  h.baseUrl = null;
  h.settings = {
    enableMcpServer: true,
    mcpServerAccess: "approval-required",
    mcpCapabilities: { terminals: false },
  };
  h.requests = [];
  h.canManage = true;
  h.copied = [];
  vi.clearAllMocks();
});

describe("McpRemoteAgentsPanel", () => {
  it("says remote agents need HTTPS on a plain HTTP address", async () => {
    h.baseUrl = "http://127.0.0.1:3773";
    const container = await render();
    expect(container.textContent).toContain(
      "Remote agents need an HTTPS address. Use the launch command over SSH instead.",
    );
    expect(container.querySelector('[aria-label="Remote MCP URL"]')).toBeNull();
  });

  it("shows the MCP URL and copies the Claude Code and Codex commands", async () => {
    h.baseUrl = "https://env-1.connect.example/";
    const container = await render();
    expect(container.querySelector('[aria-label="Remote MCP URL"]')?.textContent).toBe(
      "https://env-1.connect.example/mcp",
    );
    await act(async () => button(container, "Copy for Claude Code").click());
    await act(async () => button(container, "Copy for Codex").click());
    expect(h.copied).toEqual([
      "claude mcp add --transport http bibcode https://env-1.connect.example/mcp",
      "codex mcp add bibcode --url https://env-1.connect.example/mcp",
    ]);
    expect(container.textContent).not.toContain("Turn on MCP server first.");
  });

  it("says to turn the MCP server on first while it is off", async () => {
    h.baseUrl = "https://env-1.connect.example";
    h.settings = { ...h.settings, enableMcpServer: false };
    const container = await render();
    expect(container.textContent).toContain("Turn on MCP server first.");
  });

  it("shows no requests to connect when none waits, and none off the primary environment", async () => {
    let container = await render();
    expect(container.textContent).not.toContain("Requests to connect");
    h.requests = [request()];
    container = await render(false);
    expect(container.textContent).not.toContain("Requests to connect");
  });

  it("shows a request's client, code, return address, origin, scopes and the loopback warning", async () => {
    h.requests = [request({ clientName: "<b>Claude Code</b>" })];
    const container = await render();
    expect(container.querySelector("#mcp-requests-to-connect")).not.toBeNull();
    expect(container.textContent).toContain("<b>Claude Code</b>");
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("ABCD-2345");
    expect(container.textContent).toContain("Returns to localhost:53682");
    expect(container.textContent).toContain("https://env-1.connect.example");
    expect(container.textContent).toContain("Read and operate");
    expect(container.textContent).toContain(
      "Only approve if you just started this in an AI tool on that computer.",
    );
    h.requests = [request({ id: "a-2", redirectIsLoopback: false })];
    const second = await render();
    expect(second.textContent).not.toContain("Only approve if");
  });

  it("approves at the environment's level by default and offers nothing above it", async () => {
    h.requests = [request()];
    expect(approvableLevels("approval-required").map((level) => level.value)).toEqual([
      "read-only",
      "approval-required",
    ]);
    const container = await render();
    expect(container.querySelector('[data-value="approval-required"]')).not.toBeNull();
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
    await act(async () => button(container, "Approve").click());
    expect(h.approve).toHaveBeenCalledWith("a-1", "approval-required", false);
    // A decided card stays disabled until the stream removes it, so it is never sent twice.
    expect(button(container, "Approving…").disabled).toBe(true);
    const lower = await render();
    await choose(lower, "read-only");
    await act(async () => button(lower, "Approve").click());
    expect(h.approve).toHaveBeenLastCalledWith("a-1", "read-only", false);
  });

  it("denies, and says what failed when a decision is not saved", async () => {
    h.requests = [request()];
    const container = await render();
    await act(async () => button(container, "Deny").click());
    expect(h.deny).toHaveBeenCalledWith("a-1");
    const retry = await render();
    h.approve.mockRejectedValueOnce(new Error("The request expired."));
    await act(async () => button(retry, "Approve").click());
    expect(retry.querySelector('[role="alert"]')?.textContent).toContain(
      "Not approved. The request may have expired or been decided elsewhere.",
    );
    // A failure leaves the card usable, to try again or deny.
    expect(button(retry, "Approve").disabled).toBe(false);
  });

  it("offers terminals only when asked for and allowed, unchecked, and at Full access", async () => {
    h.requests = [request({ scopes: ["orchestration:read", "terminal:operate"] })];
    let container = await render();
    expect(container.querySelector('input[aria-label="terminals"]')).toBeNull();

    h.settings = {
      enableMcpServer: true,
      mcpServerAccess: "full-access",
      mcpCapabilities: { terminals: true },
    };
    container = await render();
    const box = () => container.querySelector<HTMLInputElement>('input[aria-label="terminals"]')!;
    expect(box().checked).toBe(false);
    expect(box().disabled).toBe(false);
    await act(async () => box().click());
    await act(async () => button(container, "Approve").click());
    expect(h.approve).toHaveBeenLastCalledWith("a-1", "full-access", true);
    container = await render();
    await act(async () => box().click());
    await choose(container, "auto-accept-edits");
    expect(box().disabled).toBe(true);
    expect(box().checked).toBe(false);
    expect(container.textContent).toContain("Set Agents may to Full access first.");
    await act(async () => button(container, "Approve").click());
    expect(h.approve).toHaveBeenLastCalledWith("a-1", "auto-accept-edits", false);

    h.requests = [request()];
    container = await render();
    expect(container.querySelector('input[aria-label="terminals"]')).toBeNull();
  });

  it("disables the decision without an administrator session, and says why", async () => {
    h.requests = [request()];
    h.canManage = false;
    const container = await render();
    expect(button(container, "Approve").disabled).toBe(true);
    expect(button(container, "Approve").title).toBe(
      "Deciding needs an administrator session here.",
    );
  });
});
