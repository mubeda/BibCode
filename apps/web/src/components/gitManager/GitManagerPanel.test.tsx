import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@bibcode/client-runtime/connection";
import type { ServerConfig } from "@bibcode/contracts";
import { makeTestExecutionEnvironmentCapabilities } from "@bibcode/shared/testSupport";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../gitManagerStore";

const h = vi.hoisted(() => ({
  connectionState: null as SupervisorConnectionState | null,
  serverConfig: null as ServerConfig | null,
  project: {
    id: "project-1",
    environmentId: "environment-1",
    title: "Repository",
    workspaceRoot: "/opaque/main",
  } as Record<string, unknown> | null,
  catalog: null as Record<string, unknown> | null,
  queryAtoms: [] as Array<{ kind: string; cwd?: string } | null>,
  effects: [] as Array<() => void | (() => void)>,
  activeSubscriptions: 0,
  catalogAtom: vi.fn((args: { input: { projectId: string } }) => ({
    kind: "catalog",
    projectId: args.input.projectId,
  })),
  signalAtom: vi.fn((args: { input: { cwd: string } }) => ({
    kind: "signal",
    cwd: args.input.cwd,
  })),
  toolbarProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
}));

vi.mock("../../state/entities", () => ({
  useProject: () => h.project,
  useServerConfigs: () =>
    new Map(h.serverConfig === null ? [] : [["environment-1", h.serverConfig]]),
}));

vi.mock("../../state/environments", () => ({
  useEnvironmentConnectionState: () => ({ data: h.connectionState }),
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; cwd?: string } | null) => {
    h.queryAtoms.push(atom);
    if (atom !== null) {
      h.effects.push(() => {
        h.activeSubscriptions += 1;
        return () => {
          h.activeSubscriptions -= 1;
        };
      });
    }
    return {
      data: atom?.kind === "catalog" ? h.catalog : null,
      error: null,
      isPending: false,
      refresh: () => undefined,
    };
  },
}));

vi.mock("../../state/worktrees", () => ({
  worktreeEnvironment: { catalog: h.catalogAtom },
}));

vi.mock("../../state/gitManager", () => ({
  gitManagerEnvironment: {
    signal: h.signalAtom,
    commit: { label: "test:commit" },
    undoCommit: { label: "test:undo-commit" },
    discard: { label: "test:discard" },
  },
}));

vi.mock("../ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTab: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

vi.mock("./GitManagerToolbar", () => ({
  GitManagerToolbar: (props: Record<string, unknown>) => {
    h.toolbarProps.push(props);
    return <div data-testid="git-manager-toolbar" />;
  },
}));

import { GitManagerPanel } from "./GitManagerPanel";

const projectRef = {
  environmentId: "environment-1",
  projectId: "project-1",
} as never;

function config(gitManagerReads: boolean): ServerConfig {
  return {
    environment: {
      capabilities: makeTestExecutionEnvironmentCapabilities({ gitManagerReads }),
    },
  } as ServerConfig;
}

function connection(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return { ...AVAILABLE_CONNECTION_STATE, ...overrides };
}

function renderPanel(): string {
  h.effects.length = 0;
  h.queryAtoms.length = 0;
  h.toolbarProps.length = 0;
  return renderToStaticMarkup(<GitManagerPanel projectRef={projectRef} />);
}

beforeEach(() => {
  h.connectionState = connection({
    desired: true,
    phase: "connected",
    network: "online",
  });
  h.serverConfig = config(true);
  h.project = {
    id: "project-1",
    environmentId: "environment-1",
    title: "Repository",
    workspaceRoot: "/opaque/main",
  };
  h.catalog = {
    worktrees: [
      { path: "/opaque/main", branch: "main", isPrimary: true },
      { path: "/opaque/worktree", branch: "feature", isPrimary: false },
    ],
  };
  h.activeSubscriptions = 0;
  h.catalogAtom.mockClear();
  h.signalAtom.mockClear();
  useGitManagerStore.setState({ byProjectKey: {} });
});

describe("GitManagerPanel", () => {
  it("renders the disconnected reason and starts no RPC-backed atom", () => {
    h.connectionState = connection({
      desired: false,
      phase: "available",
      network: "online",
    });

    const markup = renderPanel();

    expect(markup).toContain("This environment is disconnected.");
    expect(h.catalogAtom).not.toHaveBeenCalled();
    expect(h.signalAtom).not.toHaveBeenCalled();
    expect(h.queryAtoms).toEqual([null, null]);
  });

  it("renders tabs and targets the selected checkout only while ready", () => {
    useGitManagerStore
      .getState()
      .setSelectedWorktree(
        { environmentId: "environment-1", projectId: "different-project" } as never,
        "/opaque/different-worktree",
      );
    const markup = renderPanel();

    expect(markup).toContain("Changes");
    expect(markup).toContain("History");
    expect(h.catalogAtom).toHaveBeenCalledTimes(1);
    expect(h.signalAtom).toHaveBeenCalledWith(
      expect.objectContaining({ input: { cwd: "/opaque/main" } }),
    );
    expect(h.toolbarProps[0]).toMatchObject({
      mainCheckoutCwd: "/opaque/main",
      selectedWorktreeCwd: "/opaque/main",
    });
    (h.toolbarProps[0]?.onSelectedWorktreeChange as ((cwd: string) => void) | undefined)?.(
      "/opaque/worktree",
    );
    expect(useGitManagerStore.getState().selectViewState(projectRef).selectedWorktreeCwd).toBe(
      "/opaque/worktree",
    );
  });

  it("releases every server subscription when the panel unmounts", () => {
    renderPanel();
    const cleanups = h.effects.map((effect) => effect()).filter((value) => value !== undefined);

    expect(h.activeSubscriptions).toBe(2);
    for (const cleanup of cleanups) cleanup?.();
    expect(h.activeSubscriptions).toBe(0);
  });
});
