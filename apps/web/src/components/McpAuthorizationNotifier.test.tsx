// @vitest-environment happy-dom

import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  requests: [] as unknown[],
  canManage: true,
  added: [] as Array<Record<string, unknown>>,
  closed: [] as unknown[],
}));

vi.mock("~/state/mcpAuthorizations", () => ({
  usePrimaryMcpAuthorizations: () => ({ requests: h.requests, canManage: h.canManage }),
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({ label: "Office" }),
}));

vi.mock("./settings/McpRemoteAgentsPanel", () => ({
  REQUESTS_TO_CONNECT_ID: "mcp-requests-to-connect",
}));

vi.mock("./ui/toast", () => ({
  toastManager: {
    add: (options: Record<string, unknown>) => {
      h.added.push(options);
      return `toast-${h.added.length}`;
    },
    close: (id: unknown) => h.closed.push(id),
  },
  stackedThreadToast: (options: unknown) => options,
}));

import {
  __resetMcpAuthorizationNotifierForTests,
  mcpAuthorizationToastCopy,
  McpAuthorizationNotifier,
} from "./McpAuthorizationNotifier";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
const navigate = vi.fn(async () => {});

function request(id: string, minutes = 5) {
  return {
    id,
    code: "ABCD-2345",
    clientName: "Claude Code",
    redirectHost: "localhost:53682",
    redirectIsLoopback: true,
    origin: "https://env-1.connect.example",
    scopes: ["orchestration:read", "orchestration:operate"],
    createdAt: DateTime.makeUnsafe(Date.now()),
    expiresAt: DateTime.makeUnsafe(Date.now() + minutes * 60_000),
  };
}

async function render(): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<McpAuthorizationNotifier router={{ navigate } as never} />);
  });
  return root;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  h.requests = [];
  h.canManage = true;
  h.added = [];
  h.closed = [];
  __resetMcpAuthorizationNotifierForTests();
  vi.clearAllMocks();
});

describe("McpAuthorizationNotifier", () => {
  it("names the tool and the environment, and asks to compare the code", () => {
    expect(mcpAuthorizationToastCopy(request("a") as never, "Office")).toEqual({
      title: "Claude Code wants to operate Office",
      description: "Check the code ABCD-2345, then approve or deny it.",
    });
    expect(mcpAuthorizationToastCopy({ ...request("a"), clientName: " " } as never, "").title).toBe(
      "An AI tool wants to operate this environment",
    );
  });

  it("raises one notice per new request, with Review opening the requests", async () => {
    h.requests = [request("a")];
    const root = await render();
    expect(h.added).toHaveLength(1);
    expect(h.added[0]!.title).toBe("Claude Code wants to operate Office");
    // The same request again raises nothing; a new one does.
    h.requests = [request("a"), request("b")];
    await act(async () => {
      root.render(<McpAuthorizationNotifier router={{ navigate } as never} />);
    });
    expect(h.added).toHaveLength(2);
    const review = h.added[0]!.actionProps as { children: string; onClick: () => void };
    expect(review.children).toBe("Review");
    await act(async () => review.onClick());
    expect(h.closed).toEqual(["toast-1"]);
    expect(navigate).toHaveBeenCalledWith({ to: "/settings/agents" });
  });

  it("raises nothing without access:write, or for an expired request", async () => {
    h.canManage = false;
    h.requests = [request("a")];
    await render();
    expect(h.added).toHaveLength(0);
    h.canManage = true;
    h.requests = [request("expired", -1)];
    await render();
    expect(h.added).toHaveLength(0);
  });
});
