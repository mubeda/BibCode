// @vitest-environment happy-dom

import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@bibcode/contracts";
import { createModelSelection } from "@bibcode/shared/model";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  shells: [] as EnvironmentThreadShell[],
  projects: [] as Array<{ id: string; title: string }>,
  environments: [] as Array<{ environmentId: string; label: string }>,
  availability: [] as Array<{ environmentId: string; status: string }>,
  sectionExpanded: true,
  groupExpandedById: {} as Record<string, boolean>,
  unreadThreadKeys: [] as string[],
  markRead: vi.fn(),
  setActiveEnvironmentId: vi.fn(),
  navigateToThread: vi.fn(),
  setAgentsSectionExpanded: vi.fn(),
  setAgentsGroupExpanded: vi.fn(),
  reset() {
    h.shells = [];
    h.projects = [];
    h.environments = [];
    h.availability = [];
    h.sectionExpanded = true;
    h.groupExpandedById = {};
    h.unreadThreadKeys = [];
    h.markRead.mockReset();
    h.setActiveEnvironmentId.mockReset();
    h.navigateToThread.mockReset();
    h.setAgentsSectionExpanded.mockReset().mockImplementation((expanded: boolean) => {
      h.sectionExpanded = expanded;
    });
    h.setAgentsGroupExpanded
      .mockReset()
      .mockImplementation((groupId: string, expanded: boolean) => {
        h.groupExpandedById = { ...h.groupExpandedById, [groupId]: expanded };
      });
  },
}));

vi.mock("../../state/entities", () => ({
  useThreadShells: () => h.shells,
  useProjects: () => h.projects,
  setActiveEnvironmentId: h.setActiveEnvironmentId,
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: h.environments }),
}));

vi.mock("../../state/shell", () => ({
  useEnvironmentShellSummary: () => ({ statuses: h.availability }),
}));

vi.mock("../../uiStateStore", () => ({
  resolveAgentsGroupExpanded: (expandedById: Record<string, boolean>, groupId: string) =>
    expandedById[groupId] ?? groupId !== "done",
  useUiStateStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      agentsSectionExpanded: h.sectionExpanded,
      agentsGroupExpandedById: h.groupExpandedById,
      setAgentsSectionExpanded: h.setAgentsSectionExpanded,
      setAgentsGroupExpanded: h.setAgentsGroupExpanded,
    }),
}));

vi.mock("../../sidebarWorkspaceMetaStore", () => ({
  selectIsUnread: (unreadThreadKeys: readonly string[], key: string) =>
    unreadThreadKeys.includes(key),
  useSidebarWorkspaceMetaStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ unreadThreadKeys: h.unreadThreadKeys, markRead: h.markRead }),
}));

vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children, ...props }: { children?: ReactNode }) => (
    <section {...props}>{children}</section>
  ),
  SidebarMenu: ({ children, ...props }: { children?: ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  SidebarMenuItem: ({ children, ...props }: { children?: ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  SidebarMenuButton: ({
    children,
    size: _size,
    isActive: _isActive,
    tooltip: _tooltip,
    ...props
  }: {
    children?: ReactNode;
    size?: string;
    isActive?: boolean;
    tooltip?: unknown;
  }) => <button {...props}>{children}</button>,
}));

import { AgentsSection } from "./AgentsSection";

const ENVIRONMENT_LOCAL = EnvironmentId.make("environment-local");
const ENVIRONMENT_REMOTE = EnvironmentId.make("environment-remote");
const PROJECT_ALPHA = ProjectId.make("project-alpha");
const UPDATED_AT = "2026-08-31T12:00:00.000Z";

type ThreadSession = NonNullable<EnvironmentThreadShell["session"]>;

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: ThreadId.make("thread-default"),
    status: "ready",
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: UPDATED_AT,
    ...overrides,
  } as ThreadSession;
}

function makeShell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  const id = overrides.id ?? ThreadId.make("thread-default");
  return {
    id,
    projectId: PROJECT_ALPHA,
    title: "Default agent",
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
    session: makeSession({ threadId: id }),
    latestUserMessageAt: UPDATED_AT,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    conversationPreview: {
      prompt: "Inspect the project",
      tool: null,
      assistantMessage: "Ready to continue",
    },
    environmentId: ENVIRONMENT_LOCAL,
    ...overrides,
  } as EnvironmentThreadShell;
}

interface MountedSection {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedSections: MountedSection[] = [];

async function mountSection(): Promise<MountedSection> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedSections.push(mounted);
  await act(async () => {
    root.render(<AgentsSection navigateToThread={h.navigateToThread} />);
  });
  return mounted;
}

async function rerenderSection(mounted: MountedSection): Promise<void> {
  await act(async () => {
    mounted.root.render(<AgentsSection navigateToThread={(ref) => h.navigateToThread(ref)} />);
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => Promise.resolve());
}

function queryByTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function getByTestId(container: HTMLElement, testId: string): HTMLElement {
  const element = queryByTestId(container, testId);
  if (element === null) throw new Error(`Missing element with data-testid=${testId}`);
  return element;
}

function queryRow(container: HTMLElement, ariaLabel: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${ariaLabel}"]`);
}

function configureDefaultSources(): void {
  h.projects = [{ id: PROJECT_ALPHA, title: "Project Alpha" }];
  h.environments = [
    { environmentId: ENVIRONMENT_LOCAL, label: "Local" },
    { environmentId: ENVIRONMENT_REMOTE, label: "Build farm" },
  ];
  h.availability = [
    { environmentId: ENVIRONMENT_LOCAL, status: "live" },
    { environmentId: ENVIRONMENT_REMOTE, status: "live" },
  ];
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.reset();
  configureDefaultSources();
});

afterEach(async () => {
  for (const mounted of mountedSections.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("AgentsSection", () => {
  it("renders non-empty groups in pinned order with counts and Done collapsed by default", async () => {
    h.shells = [
      makeShell({ id: ThreadId.make("thread-done"), title: "Done agent" }),
      makeShell({
        id: ThreadId.make("thread-waiting"),
        title: "Waiting agent",
        hasPendingUserInput: true,
      }),
      makeShell({
        id: ThreadId.make("thread-blocked"),
        title: "Blocked agent",
        hasPendingApprovals: true,
      }),
      makeShell({
        id: ThreadId.make("thread-working"),
        title: "Working agent",
        session: makeSession({
          threadId: ThreadId.make("thread-working"),
          status: "running",
        }),
      }),
    ];

    const { container } = await mountSection();
    const groupHeaders = Array.from(
      container.querySelectorAll<HTMLElement>("[data-testid^='agents-group-']"),
    );

    expect(groupHeaders.map((header) => header.dataset.testid)).toEqual([
      "agents-group-working",
      "agents-group-blocked",
      "agents-group-waiting",
      "agents-group-done",
    ]);
    expect(groupHeaders.map((header) => header.textContent)).toEqual([
      "Working1",
      "Pending Approval1",
      "Awaiting Input1",
      "Done1",
    ]);
    expect(getByTestId(container, "agents-group-done").getAttribute("aria-expanded")).toBe("false");
    expect(queryRow(container, "Done agent, Done, Local")).toBeNull();
    expect(queryRow(container, "Working agent, Working, Local")).not.toBeNull();
    expect(container.querySelectorAll("[role='list']")).toHaveLength(3);
  });

  it("filters rows from deferred text and rejects queries over 2048 UTF-8 bytes", async () => {
    h.groupExpandedById = { done: true };
    h.shells = [
      makeShell({ id: ThreadId.make("thread-alpha"), title: "Alpha agent" }),
      makeShell({ id: ThreadId.make("thread-beta"), title: "Beta agent" }),
    ];
    const { container } = await mountSection();
    const input = getByTestId(container, "agents-filter-input") as HTMLInputElement;

    await changeInput(input, "beta");
    expect(queryRow(container, "Alpha agent, Done, Local")).toBeNull();
    expect(queryRow(container, "Beta agent, Done, Local")).not.toBeNull();

    await changeInput(input, "x".repeat(2049));
    expect(container.querySelectorAll("button[aria-label$=', Local']")).toHaveLength(0);
  });

  it("marks a row read, selects its environment, then navigates with its scoped ref", async () => {
    h.groupExpandedById = { done: true };
    h.shells = [
      makeShell({
        id: ThreadId.make("thread-remote"),
        title: "Remote agent",
        environmentId: ENVIRONMENT_REMOTE,
      }),
    ];
    const { container } = await mountSection();
    const row = queryRow(container, "Remote agent, Done, Build farm");
    expect(row).not.toBeNull();

    await click(row!);

    const ref = {
      environmentId: ENVIRONMENT_REMOTE,
      threadId: ThreadId.make("thread-remote"),
    };
    expect(h.markRead).toHaveBeenCalledExactlyOnceWith("environment-remote:thread-remote");
    expect(h.setActiveEnvironmentId).toHaveBeenCalledExactlyOnceWith(ENVIRONMENT_REMOTE);
    expect(h.navigateToThread).toHaveBeenCalledExactlyOnceWith(ref);
    expect(h.markRead.mock.invocationCallOrder[0]).toBeLessThan(
      h.setActiveEnvironmentId.mock.invocationCallOrder[0]!,
    );
    expect(h.setActiveEnvironmentId.mock.invocationCallOrder[0]).toBeLessThan(
      h.navigateToThread.mock.invocationCallOrder[0]!,
    );
  });

  it("greys a stale environment row and shows its availability status", async () => {
    h.groupExpandedById = { done: true };
    h.availability = [{ environmentId: ENVIRONMENT_REMOTE, status: "degraded" }];
    h.shells = [
      makeShell({
        id: ThreadId.make("thread-stale"),
        title: "Stale agent",
        environmentId: ENVIRONMENT_REMOTE,
      }),
    ];
    const { container } = await mountSection();
    const row = queryRow(container, "Stale agent, Done, Build farm");

    expect(row?.className).toContain("opacity-60");
    expect(row?.textContent).toContain("Build farm");
    expect(row?.textContent).toContain("degraded");
  });

  it("collapses the section body from its header toggle", async () => {
    h.shells = [makeShell({ id: ThreadId.make("thread-visible"), title: "Visible agent" })];
    const mounted = await mountSection();

    await click(getByTestId(mounted.container, "agents-section-header"));
    expect(h.setAgentsSectionExpanded).toHaveBeenCalledExactlyOnceWith(false);
    await rerenderSection(mounted);

    expect(queryByTestId(mounted.container, "agents-filter-input")).toBeNull();
    expect(queryByTestId(mounted.container, "agents-group-done")).toBeNull();
    expect(queryByTestId(mounted.container, "agents-section-header")).not.toBeNull();
  });

  it("renders an unread agent title in semibold text", async () => {
    h.shells = [makeShell({ id: ThreadId.make("thread-unread"), title: "Unread agent" })];
    h.unreadThreadKeys = ["environment-local:thread-unread"];
    const { container } = await mountSection();
    h.groupExpandedById = { done: true };
    const mounted = mountedSections.at(-1)!;
    await rerenderSection(mounted);
    const row = queryRow(container, "Unread agent, Done, Local");
    const title = Array.from(row?.querySelectorAll("span") ?? []).find(
      (element) => element.textContent === "Unread agent",
    );

    expect(title?.className).toContain("font-semibold");
  });

  it("renders the empty state while keeping the section header", async () => {
    const { container } = await mountSection();

    expect(getByTestId(container, "agents-section-header").textContent).toContain("Agents");
    expect(getByTestId(container, "agents-section-header").textContent).toContain("0");
    expect(container.textContent).toContain("No agents yet");
  });
});
