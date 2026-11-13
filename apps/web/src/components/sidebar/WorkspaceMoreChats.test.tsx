// @vitest-environment happy-dom
import { EnvironmentId, ProjectId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  shell: { status: "live", snapshot: { _tag: "None" } } as {
    status: string;
    snapshot: { _tag: "None" } | { _tag: "Some"; value: { threads: unknown[] } };
  },
  state: {
    generation: 0,
    threads: new Map<string, { id: string; title: string }>(),
    missing: new Set<string>(),
    pages: new Map<string, { threadIds: string[]; cursor: string | null }>(),
  },
  outcome: null as null | ((value: "loaded" | "failed") => void),
  loads: [] as Array<{ scope: unknown; append: boolean }>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => h.shell }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("../../centerPanelAdoption", () => ({ panelProviderLabel: () => undefined }));
vi.mock("../../centerPanelActions", () => ({
  usePanelThreadOpener: () => ({ openPanelThread: async () => undefined }),
}));
vi.mock("../../state/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/shell")>()),
  environmentShell: { stateValueAtom: () => "shell" },
}));
vi.mock("../../state/offShell", () => ({
  olderPageKey: () => "page",
  useOffShellState: () => h.state,
  loadOlderThreads: (_environmentId: unknown, scope: unknown, options: { append: boolean }) => {
    h.loads.push({ scope, append: options.append });
    return new Promise((resolve) => {
      h.outcome = resolve;
    });
  },
}));

import { WorkspaceMoreChatsList } from "./WorkspaceMoreChats";

const ENVIRONMENT = EnvironmentId.make("environment-1");
const PROJECT = ProjectId.make("project-1");
let container: HTMLDivElement;
let root: Root;
const opened: string[] = [];

function panel(id: string, worktreePath: string | null) {
  return {
    id,
    title: `Chat ${id}`,
    kind: "panel",
    hostThreadId: "host",
    projectId: PROJECT,
    worktreePath,
    archivedAt: null,
  };
}

function mount(olderCount: number, worktreePath: string | null = "/wt/fix"): void {
  act(() => {
    root.render(
      <WorkspaceMoreChatsList
        environmentId={ENVIRONMENT}
        projectId={PROJECT}
        worktreePath={worktreePath}
        olderCount={olderCount}
        onOpenChat={(thread) => opened.push(thread.id)}
      />,
    );
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
  if (found === undefined) throw new Error(`no button ${name}: ${container.innerHTML}`);
  return found;
}

async function finish(outcome: "loaded" | "failed"): Promise<void> {
  await act(async () => {
    h.outcome?.(outcome);
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.shell = {
    status: "live",
    snapshot: {
      _tag: "Some",
      value: { threads: [panel("here", "/wt/fix"), panel("elsewhere", "/wt/other")] },
    },
  };
  h.state = { generation: 0, threads: new Map(), missing: new Set(), pages: new Map() };
  h.loads = [];
  opened.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WorkspaceMoreChatsList (#223)", () => {
  it("lists the checkout's chats and pages the left-out ones in on request", async () => {
    mount(2);
    expect(h.loads).toEqual([]);
    act(() => button("2 older chats").click());
    expect(h.loads).toEqual([
      { scope: { kind: "checkout", projectId: PROJECT, worktreePath: "/wt/fix" }, append: false },
    ]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading older chats…");
    expect(container.textContent).not.toContain("Chat elsewhere");
    h.state = {
      ...h.state,
      threads: new Map([["old", { id: "old", title: "Chat old" }]]),
      pages: new Map([["page", { threadIds: ["old"], cursor: "next" }]]),
    };
    await finish("loaded");
    act(() => button("Chat old").click());
    act(() => button("Chat here").click());
    expect(opened).toEqual(["old", "here"]);
    act(() => button("Load 20 more").click());
    expect(h.loads.at(-1)?.append).toBe(true);
  });

  it("draws each popover chat in the popover's own colour, not at chat level (R63)", () => {
    mount(0);
    const row = button("Chat here");
    // The chat colour is checked against the sidebar surfaces only, never the popover's.
    expect(row.hasAttribute("data-sidebar-level")).toBe(false);
    expect(row.className.split(/\s+/)).toContain("text-popover-foreground");
  });

  it("offers a retry in place when a page fails", async () => {
    mount(2);
    act(() => button("2 older chats").click());
    await finish("failed");
    expect(container.textContent).toContain("Couldn't load older chats.");
    act(() => button("Retry").click());
    expect(h.loads).toHaveLength(2);
    expect(button("Chat here")).toBeDefined();
  });

  it("is disabled offline and says why", () => {
    h.shell = { ...h.shell, status: "degraded" };
    mount(2);
    const row = button("2 older chats: reconnect to load");
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("aria-description")).toBe("Reconnect to load older chats.");
  });

  it("asks for nothing when no chat was left out", () => {
    mount(0, null);
    expect(h.loads).toEqual([]);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
