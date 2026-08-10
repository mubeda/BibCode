// @vitest-environment happy-dom

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeKey,
  WorktreeRepositoryKey,
  type ServerConfig,
  type VcsWorktreeCatalogSnapshot,
  type VcsWorktreeDescriptor,
} from "@bibcode/contracts";
import { createModelSelection } from "@bibcode/shared/model";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";

const testState = vi.hoisted(() => ({
  catalogs: new Map<string, unknown>(),
  catalogSubscriptions: [] as Array<unknown>,
  focusRefreshProjects: [] as Array<unknown>,
  commandCalls: [] as Array<{ label: string; input: unknown }>,
  commandHandlers: new Map<string, (input: unknown) => Promise<unknown>>(),
  navigate: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("../state/worktrees", () => ({
  worktreeEnvironment: {
    catalog: (target: { environmentId: string; input: { projectId: string } }) => {
      testState.catalogSubscriptions.push(target);
      return { key: `${target.environmentId}:${target.input.projectId}` };
    },
    updatePolicy: { label: "worktree.updatePolicy" },
    addOne: { label: "worktree.addOne" },
    addAll: { label: "worktree.addAll" },
  },
  useWorktreeCatalogFocusRefresh: (projects: ReadonlyArray<unknown>) => {
    testState.focusRefreshProjects = [...projects];
  },
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: { key: string } | null) => ({
    data: atom ? (testState.catalogs.get(atom.key) ?? null) : null,
    emission: AsyncResult.initial(false),
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => async (input: unknown) => {
    testState.commandCalls.push({ label: command.label, input });
    return (
      testState.commandHandlers.get(command.label)?.(input) ??
      Promise.resolve(AsyncResult.success(undefined))
    );
  },
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children?: ReactNode }) =>
    children === undefined ? render : cloneElement(render, undefined, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toastAdd },
  stackedThreadToast: (toast: unknown) => toast,
}));

import { WorktreeDiscoverySection } from "./WorktreeDiscoverySection";

const ENVIRONMENT_ID = EnvironmentId.make("environment-main");
const PROJECT_ID = ProjectId.make("project-main");

function candidate(path: string, branch: string): VcsWorktreeDescriptor {
  return {
    worktreeKey: WorktreeKey.make(`key:${path}`),
    path,
    branch,
    head: "abcdef0123456789",
    isPrimary: false,
    isBare: false,
    locked: false,
    registrationState: "registered",
    directoryState: "present",
    adoptionState: "none",
    eligibleForAdoption: true,
  };
}

function snapshot(
  candidates: ReadonlyArray<VcsWorktreeDescriptor>,
  generation = 42,
): VcsWorktreeCatalogSnapshot {
  return {
    repositoryKey: WorktreeRepositoryKey.make("repository-main"),
    generation,
    authoritative: true,
    observedAt: "2026-08-09T12:00:00.000Z",
    scanStatus: { _tag: "ready" },
    worktrees: [...candidates],
    adoptedWorkspaces: [],
  };
}

function project(
  visibility: "hidden" | "shown" = "hidden",
  initialPromptDismissedAt: string | null = null,
  baselinePaths: ReadonlyArray<string> = [],
): SidebarProjectSnapshot {
  const member = {
    id: PROJECT_ID,
    title: "Repo",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    defaultModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
    scripts: [],
    worktreeDiscovery: { visibility, initialPromptDismissedAt, baselinePaths },
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    environmentId: ENVIRONMENT_ID,
    physicalProjectKey: "environment-main:/repo",
    environmentLabel: "This device",
  } as const;
  return {
    ...member,
    projectKey: "repository-main",
    displayName: "Repo",
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    memberProjects: [member],
    memberProjectRefs: [{ environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID }],
    remoteEnvironmentLabels: [],
  } as SidebarProjectSnapshot;
}

function serverConfigs(supported: boolean): ReadonlyMap<EnvironmentId, ServerConfig> {
  return new Map([
    [
      ENVIRONMENT_ID,
      {
        environment: { capabilities: { worktreeCatalog: supported } },
        settings: DEFAULT_SERVER_SETTINGS,
        providers: [],
      } as unknown as ServerConfig,
    ],
  ]);
}

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedTrees.push({ container, root });
  await act(async () => root.render(element));
  return container;
}

function button(name: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (entry) => entry.getAttribute("aria-label") === name || entry.textContent?.trim() === name,
  );
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.catalogs.clear();
  testState.catalogSubscriptions = [];
  testState.focusRefreshProjects = [];
  testState.commandCalls = [];
  testState.commandHandlers.clear();
  testState.navigate.mockReset();
  testState.toastAdd.mockReset();
});

afterEach(async () => {
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("WorktreeDiscoverySection", () => {
  it("adds one candidate and navigates to the returned scoped workspace", async () => {
    const discovered = candidate("/worktrees/one", "feature/one");
    testState.catalogs.set(`${ENVIRONMENT_ID}:${PROJECT_ID}`, snapshot([discovered]));
    testState.commandHandlers.set("worktree.addOne", async () =>
      AsyncResult.success({ threadId: ThreadId.make("thread-adopted"), disposition: "created" }),
    );
    await mount(
      <WorktreeDiscoverySection
        project={project()}
        serverConfigs={serverConfigs(true)}
        onNavigateToThread={testState.navigate}
      />,
    );

    await act(async () => button("Add feature/one to BiBCode").click());

    expect(testState.commandCalls).toContainEqual({
      label: "worktree.addOne",
      input: {
        environmentId: ENVIRONMENT_ID,
        input: expect.objectContaining({
          projectId: PROJECT_ID,
          worktreeKey: discovered.worktreeKey,
          expectedGeneration: 42,
        }),
      },
    });
    expect(testState.navigate).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      threadId: ThreadId.make("thread-adopted"),
    });
  });

  it("keeps the current route while add-all reports pending and mixed results", async () => {
    const candidates = [
      candidate("/worktrees/one", "feature/one"),
      candidate("/worktrees/two", "feature/two"),
    ];
    testState.catalogs.set(`${ENVIRONMENT_ID}:${PROJECT_ID}`, snapshot(candidates));
    let resolveAddAll!: (value: unknown) => void;
    testState.commandHandlers.set(
      "worktree.addAll",
      () => new Promise((resolve) => (resolveAddAll = resolve)),
    );
    await mount(
      <WorktreeDiscoverySection
        project={project()}
        serverConfigs={serverConfigs(true)}
        onNavigateToThread={testState.navigate}
      />,
    );

    await act(async () => {
      button("Add all discovered worktrees").click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Adding 2 discovered worktrees…");

    await act(async () =>
      resolveAddAll(
        AsyncResult.success({
          results: [
            {
              _tag: "Success",
              worktreeKey: candidates[0]!.worktreeKey,
              result: { threadId: ThreadId.make("thread-one"), disposition: "created" },
            },
            {
              _tag: "Failure",
              worktreeKey: candidates[1]!.worktreeKey,
              error: new Error("stale"),
            },
          ],
        }),
      ),
    );

    expect(testState.navigate).not.toHaveBeenCalled();
    expect(testState.toastAdd).toHaveBeenCalledWith({
      type: "warning",
      title: "Added 1 of 2 discovered worktrees",
      description: "1 worktree could not be added.",
    });
  });

  it("acknowledges the exact generation, collapses, and can expand the hidden line", async () => {
    testState.catalogs.set(
      `${ENVIRONMENT_ID}:${PROJECT_ID}`,
      snapshot([candidate("/worktrees/one", "feature/one")], 87),
    );
    testState.commandHandlers.set("worktree.updatePolicy", async () =>
      AsyncResult.success({
        visibility: "hidden",
        initialPromptDismissedAt: null,
        baselinePaths: [],
      }),
    );
    await mount(
      <WorktreeDiscoverySection
        project={project()}
        serverConfigs={serverConfigs(true)}
        onNavigateToThread={testState.navigate}
      />,
    );

    await act(async () => button("Keep hidden").click());
    expect(testState.commandCalls).toContainEqual({
      label: "worktree.updatePolicy",
      input: {
        environmentId: ENVIRONMENT_ID,
        input: expect.objectContaining({
          projectId: PROJECT_ID,
          acknowledgeGeneration: 87,
          dismissInitialPrompt: true,
        }),
      },
    });
    expect(document.body.textContent).toContain("Hiding 1 discovered worktree");

    await act(async () => button("Hiding 1 discovered worktree").click());
    expect(document.body.textContent).toContain("Discovered worktrees");
    expect(document.body.textContent).toContain("/worktrees/one");
  });

  it("resurfaces only new candidates after acknowledgement and limits add-all to that set", async () => {
    const acknowledged = candidate("/worktrees/acknowledged", "feature/acknowledged");
    const newlyDiscovered = candidate("/worktrees/new", "feature/new");
    testState.catalogs.set(
      `${ENVIRONMENT_ID}:${PROJECT_ID}`,
      snapshot([acknowledged, newlyDiscovered], 91),
    );
    testState.commandHandlers.set("worktree.addAll", async () =>
      AsyncResult.success({
        results: [
          {
            _tag: "Success",
            worktreeKey: newlyDiscovered.worktreeKey,
            result: { threadId: ThreadId.make("thread-new"), disposition: "created" },
          },
        ],
      }),
    );
    await mount(
      <WorktreeDiscoverySection
        project={project("hidden", "2026-08-09T12:00:00.000Z", [acknowledged.path])}
        serverConfigs={serverConfigs(true)}
        onNavigateToThread={testState.navigate}
      />,
    );

    expect(document.body.textContent).toContain("/worktrees/new");
    expect(document.body.textContent).not.toContain("/worktrees/acknowledged");
    await act(async () => button("Add all discovered worktrees").click());

    const call = testState.commandCalls.find((entry) => entry.label === "worktree.addAll");
    expect(call?.input).toEqual({
      environmentId: ENVIRONMENT_ID,
      input: {
        candidates: [
          expect.objectContaining({
            worktreeKey: newlyDiscovered.worktreeKey,
            expectedGeneration: 91,
          }),
        ],
      },
    });
  });

  it("renders shown candidates as discovered rows whose selection adopts them", async () => {
    const discovered = candidate("/worktrees/shown", "feature/shown");
    testState.catalogs.set(`${ENVIRONMENT_ID}:${PROJECT_ID}`, snapshot([discovered]));
    testState.commandHandlers.set("worktree.addOne", async () =>
      AsyncResult.success({ threadId: ThreadId.make("thread-shown"), disposition: "created" }),
    );
    await mount(
      <WorktreeDiscoverySection
        project={project("shown")}
        serverConfigs={serverConfigs(true)}
        onNavigateToThread={testState.navigate}
      />,
    );

    expect(document.body.textContent).toContain("Discovered");
    expect(document.body.textContent).toContain("/worktrees/shown");
    await act(async () => button("Add discovered worktree feature/shown to BiBCode").click());

    expect(testState.commandCalls.some((call) => call.label === "worktree.addOne")).toBe(true);
    expect(testState.navigate).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      threadId: ThreadId.make("thread-shown"),
    });
  });

  it("renders no controls and creates no catalog subscription for unsupported environments", async () => {
    testState.catalogs.set(
      `${ENVIRONMENT_ID}:${PROJECT_ID}`,
      snapshot([candidate("/worktrees/unsupported", "feature/unsupported")]),
    );
    await mount(
      <WorktreeDiscoverySection
        project={project()}
        serverConfigs={serverConfigs(false)}
        onNavigateToThread={testState.navigate}
      />,
    );

    expect(testState.catalogSubscriptions).toEqual([]);
    expect(testState.focusRefreshProjects).toEqual([]);
    expect(document.body.textContent).not.toContain("Discovered worktrees");
    expect(document.body.textContent).not.toContain("feature/unsupported");
  });
});
