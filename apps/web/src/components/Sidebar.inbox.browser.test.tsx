// @vitest-environment happy-dom
/**
 * The Inbox view through its complete caller, the mounted left panel: the
 * view switch, the tiles and their default, and opening an agent into the
 * host thread's route with the agent's center surface focused, across a
 * reload and a remote reconnect. Shares `Sidebar.testHarness.tsx`.
 */
import {
  ENV_MAIN,
  ENV_REMOTE,
  environmentFixture,
  findProps,
  h,
  makeThread,
  projectA,
  threadKeyOf,
} from "./Sidebar.testHarness";
import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/shell";
import { ProjectId, ThreadId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const inboxTest = vi.hoisted(() => ({
  /** Terminal rows #187 adds; appended to the built rows until that branch lands. */
  terminalRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("./agents/useAgentLiveBranches", () => ({
  useAgentLiveBranches: () => new Map<string, string>(),
}));
vi.mock("./chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("./sidebar/agentsSection.logic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidebar/agentsSection.logic")>();
  return {
    ...actual,
    buildAgentRows: (input: Parameters<typeof actual.buildAgentRows>[0]) => [
      ...actual.buildAgentRows(input),
      ...inboxTest.terminalRows,
    ],
  };
});

import Sidebar from "./Sidebar";
import {
  HOST_SURFACE_ID,
  selectFocusedCenterSurface,
  useCenterPanelStore,
} from "../centerPanelStore";
import { CENTER_PANEL_ROOT_GROUP_ID } from "../centerPanelLayout";

type Session = NonNullable<EnvironmentThreadShell["session"]>;

function session(threadId: string, status: Session["status"] = "ready"): Session {
  return {
    threadId: ThreadId.make(threadId),
    status,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-07-06T11:00:00.000Z",
  } as Session;
}

const approvalThread = makeThread("thread-approval", {
  title: "Needs approval",
  session: session("thread-approval"),
  hasPendingApprovals: true,
  updatedAt: "2026-07-06T11:59:00.000Z",
});
const workingThread = makeThread("thread-working", {
  title: "Still working",
  session: session("thread-working", "running"),
});
const doneThread = makeThread("thread-done", {
  title: "Finished",
  session: session("thread-done"),
});
const hostThread = makeThread("thread-host", {
  title: "Host chat",
  session: session("thread-host"),
});
const panelThread = makeThread("thread-panel-agent", {
  kind: "panel",
  hostThreadId: ThreadId.make("thread-host"),
  title: "Panel — Codex",
  session: session("thread-panel-agent"),
});
const remoteApproval = makeThread("thread-remote-approval", {
  environmentId: ENV_REMOTE,
  projectId: ProjectId.make("project-remote"),
  title: "Remote approval",
  session: session("thread-remote-approval"),
  hasPendingApprovals: true,
});

function liveSummary(environmentIds: ReadonlyArray<string>, pending: ReadonlyArray<string> = []) {
  const statuses = [
    ...environmentIds.map((environmentId) => ({
      environmentId,
      status: "live",
      hasSnapshot: true,
      error: null,
    })),
    ...pending.map((environmentId) => ({
      environmentId,
      status: "synchronizing",
      hasSnapshot: false,
      error: null,
    })),
  ];
  return {
    catalogHealth: { status: "ready" },
    catalogReady: true,
    desiredEnvironmentCount: statuses.length,
    statuses,
    canShowEmptyProjects: pending.length === 0,
    hasSnapshot: true,
    hasSynchronizingShell: pending.length > 0,
    hasCachedShell: false,
    hasLiveShell: true,
    firstError: null,
    latestSnapshotUpdatedAt: null,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderSidebar(): Promise<HTMLDivElement> {
  if (container === null) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  // The harness stores are plain objects, so every state change re-renders explicitly.
  await act(async () => root!.render(<Sidebar />));
  await act(async () => root!.render(<Sidebar />));
  return container;
}

async function unmountSidebar(): Promise<void> {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}

function tile(id: string): HTMLButtonElement {
  const element = container!.querySelector<HTMLButtonElement>(`[data-testid="inbox-tile-${id}"]`);
  if (element === null) throw new Error(`Missing tile ${id}`);
  return element;
}

function pressedTiles(): string[] {
  return Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-testid^="inbox-tile-"]'))
    .filter((element) => element.getAttribute("aria-pressed") === "true")
    .map((element) => element.dataset["testid"]!.replace("inbox-tile-", ""));
}

/** The agent card buttons, by the thread title their accessible name starts with. */
function agentCard(title: string): HTMLButtonElement {
  const element = Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.getAttribute("aria-label")?.startsWith(`${title}, `),
  );
  if (element === undefined) throw new Error(`Missing agent card ${title}`);
  return element;
}

function listedTitles(): string[] {
  return Array.from(container!.querySelectorAll<HTMLButtonElement>("button"))
    .map((button) => button.getAttribute("aria-label") ?? "")
    .filter((label) => /, (Pending Approval|Awaiting Input|Working|Done|Connecting)/.test(label))
    .map((label) => label.split(", ")[0]!);
}

function focusedSurfaceId(threadId: string, environmentId = ENV_MAIN): string | null {
  const key = scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));
  const state = useCenterPanelStore.getState().byThreadKey[key];
  if (state === undefined) return HOST_SURFACE_ID;
  return selectFocusedCenterSurface(state)?.id ?? null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  inboxTest.terminalRows = [];
  useCenterPanelStore.setState({ byThreadKey: {}, pendingChatPanelThreadKeys: new Set() });
  h.state.projects = [projectA];
  h.state.environments = [
    environmentFixture({ environmentId: ENV_MAIN, label: "Main", connectionId: "primary" }),
  ];
  h.state.threads = [approvalThread, workingThread, doneThread];
  h.state.shellSummary = liveSummary([ENV_MAIN]);
  h.uiStore.setState({ sidebarView: "inbox", inboxCategory: null });
});

afterEach(async () => {
  await unmountSidebar();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Sidebar Inbox view", () => {
  it("replaces the projects list and hides the rail-scoped context card", async () => {
    await renderSidebar();
    expect(container!.querySelector('[data-testid="sidebar-inbox-view"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="agents-nav-row"]')).toBeNull();
    expect(findProps((props) => props["data-mock"] === "EnvironmentContextCard")).toBeNull();
    const header = findProps((props) =>
      String(props["className"] ?? "").includes("@container/sidebar-header"),
    );
    expect(String(header?.["className"])).toContain("md:pl-[var(--environment-rail-width)]");
  });

  it("is reached from the view switch and leaves Environments unchanged when switched back", async () => {
    h.uiStore.setState({ sidebarView: "environments" });
    await renderSidebar();
    expect(container!.querySelector('[data-testid="sidebar-inbox-view"]')).toBeNull();
    const inboxButton = container!.querySelector<HTMLButtonElement>('[aria-label="Inbox view"]')!;
    await act(async () => inboxButton.click());
    await renderSidebar();
    expect(container!.querySelector('[data-testid="sidebar-inbox-view"]')).not.toBeNull();
    const environmentsButton = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Environments view"]',
    )!;
    await act(async () => environmentsButton.click());
    await renderSidebar();
    expect(container!.querySelector('[data-testid="sidebar-inbox-view"]')).toBeNull();
    expect(container!.querySelector('[data-testid="agents-nav-row"]')).not.toBeNull();
  });

  it("counts each tile, settles on Needs Attention, and filters by the picked tile", async () => {
    await renderSidebar();
    expect(tile("all").getAttribute("aria-label")).toBe("All Agents, 3 agents");
    expect(tile("attention").getAttribute("aria-label")).toBe("Needs Attention, 1 agent");
    expect(tile("working").getAttribute("aria-label")).toBe("Working, 1 agent");
    expect(tile("done").getAttribute("aria-label")).toBe("Done, 1 agent");
    expect(h.uiStore.getState().inboxCategory).toBe("attention");
    expect(pressedTiles()).toEqual(["attention"]);
    expect(listedTitles()).toEqual(["Needs approval"]);

    await act(async () => tile("done").click());
    await renderSidebar();
    expect(h.uiStore.getState().inboxCategory).toBe("done");
    expect(pressedTiles()).toEqual(["done"]);
    expect(listedTitles()).toEqual(["Finished"]);
  });

  it("updates counts live and shows an empty state for an empty tile", async () => {
    h.uiStore.setState({ inboxCategory: "working" });
    await renderSidebar();
    expect(listedTitles()).toEqual(["Still working"]);

    h.state.threads = [approvalThread, { ...workingThread, session: session("thread-working") }];
    await renderSidebar();
    expect(tile("working").getAttribute("aria-label")).toBe("Working, 0 agents");
    expect(tile("done").getAttribute("aria-label")).toBe("Done, 1 agent");
    expect(container!.querySelector('[data-testid="inbox-empty"]')?.textContent).toBe(
      "No agents are running.",
    );
  });

  it("opens a chat agent on its route, restoring a closed host chat, and survives a reload", async () => {
    h.uiStore.setState({ inboxCategory: "done" });
    const ref = scopeThreadRef(ENV_MAIN, doneThread.id);
    useCenterPanelStore.getState().closeAllSurfaces(ref, CENTER_PANEL_ROOT_GROUP_ID);
    expect(focusedSurfaceId("thread-done")).toBeNull();
    await renderSidebar();

    await act(async () => agentCard("Finished").click());

    expect(h.spies.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENV_MAIN, threadId: "thread-done" },
    });
    expect(focusedSurfaceId("thread-done")).toBe(HOST_SURFACE_ID);
    expect(h.spies.markRead).toHaveBeenCalledWith(threadKeyOf(doneThread));
    expect(h.state.activeEnvironmentId).toBe(ENV_MAIN);

    // Reload: the route is the agent's thread, the layout comes back from storage.
    const persisted = window.localStorage.getItem("bibcode:center-panel-state:v1");
    await unmountSidebar();
    useCenterPanelStore.setState({ byThreadKey: {}, pendingChatPanelThreadKeys: new Set() });
    if (persisted !== null) window.localStorage.setItem("bibcode:center-panel-state:v1", persisted);
    await useCenterPanelStore.persist.rehydrate();
    h.state.routeParams = { environmentId: ENV_MAIN, threadId: "thread-done" };
    h.state.captures.length = 0;
    await renderSidebar();
    expect(pressedTiles()).toEqual(["done"]);
    expect(focusedSurfaceId("thread-done")).toBe(HOST_SURFACE_ID);
    expect(
      findProps((props) => String(props["aria-label"] ?? "").startsWith("Finished, "))?.[
        "aria-pressed"
      ],
    ).toBe(true);
  });

  it("opens a chat panel agent on its host thread with the panel focused", async () => {
    h.state.threads = [hostThread, panelThread];
    h.uiStore.setState({ inboxCategory: "all" });
    await renderSidebar();

    await act(async () => agentCard("Panel — Codex").click());

    expect(h.spies.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENV_MAIN, threadId: "thread-host" },
    });
    expect(focusedSurfaceId("thread-host")).toBe("chat:thread-panel-agent");
    expect(h.spies.markRead).toHaveBeenCalledWith(threadKeyOf(panelThread));

    // Reload: the focused panel comes back from the persisted center layout.
    const persisted = window.localStorage.getItem("bibcode:center-panel-state:v1");
    expect(persisted).toContain("chat:thread-panel-agent");
    await unmountSidebar();
    useCenterPanelStore.setState({ byThreadKey: {}, pendingChatPanelThreadKeys: new Set() });
    window.localStorage.setItem("bibcode:center-panel-state:v1", persisted!);
    await useCenterPanelStore.persist.rehydrate();
    expect(focusedSurfaceId("thread-host")).toBe("chat:thread-panel-agent");
    h.state.routeParams = { environmentId: ENV_MAIN, threadId: "thread-host" };
    h.state.captures.length = 0;
    await renderSidebar();
    expect(
      findProps((props) => String(props["aria-label"] ?? "").startsWith("Panel — Codex, "))?.[
        "aria-pressed"
      ],
    ).toBe(true);
  });

  it("opens a terminal agent's AI terminal by its id on the host thread", async () => {
    const hostRef = scopeThreadRef(ENV_MAIN, hostThread.id);
    useCenterPanelStore.getState().openTerminalPanel(hostRef, "term-ai");
    useCenterPanelStore.getState().openHostChat(hostRef);
    expect(focusedSurfaceId("thread-host")).toBe(HOST_SURFACE_ID);
    h.state.threads = [hostThread];
    inboxTest.terminalRows = [
      {
        key: `${scopedThreadKey(hostRef)}#terminal:term-ai`,
        ref: hostRef,
        shell: { ...hostThread, title: "Claude terminal" },
        branch: null,
        group: "working",
        pill: { label: "Working", colorClass: "", dotClass: "", pulse: false },
        environmentLabel: "Main",
        environmentLive: true,
        environmentStatus: "live",
        projectTitle: "Repo A",
        providerDriverKind: null,
        providerLabel: null,
        previewLine: null,
        searchText: "",
        terminalId: "term-ai",
        unknownReason: null,
      },
    ];
    h.uiStore.setState({ inboxCategory: "working" });
    await renderSidebar();

    await act(async () => agentCard("Claude terminal").click());

    expect(h.spies.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENV_MAIN, threadId: "thread-host" },
    });
    expect(focusedSurfaceId("thread-host")).toBe("terminal:term-ai");
    expect(h.spies.markRead).toHaveBeenCalledWith(threadKeyOf(hostThread));
  });

  it("treats a reconnecting remote as partial and settles the default once it reports", async () => {
    h.state.environments = [
      environmentFixture({ environmentId: ENV_MAIN, label: "Main", connectionId: "primary" }),
      environmentFixture({ environmentId: ENV_REMOTE, label: "Remote", connectionId: "remote" }),
    ];
    h.state.threads = [doneThread];
    h.state.shellSummary = liveSummary([ENV_MAIN], [ENV_REMOTE]);
    await renderSidebar();
    expect(container!.querySelector('[data-testid="inbox-partial"]')).not.toBeNull();
    expect(pressedTiles()).toEqual(["all"]);
    expect(h.uiStore.getState().inboxCategory).toBeNull();

    h.state.threads = [doneThread, remoteApproval];
    h.state.shellSummary = liveSummary([ENV_MAIN, ENV_REMOTE]);
    await renderSidebar();
    expect(container!.querySelector('[data-testid="inbox-partial"]')).toBeNull();
    expect(h.uiStore.getState().inboxCategory).toBe("attention");
    expect(pressedTiles()).toEqual(["attention"]);
    expect(listedTitles()).toEqual(["Remote approval"]);
  });
});
