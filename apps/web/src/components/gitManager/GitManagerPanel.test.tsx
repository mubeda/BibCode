// @vitest-environment happy-dom

import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@bibcode/client-runtime/connection";
import type { GitManagerRefsSnapshot, ServerConfig } from "@bibcode/contracts";
import { makeTestExecutionEnvironmentCapabilities } from "@bibcode/shared/testSupport";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
  refsAtom: vi.fn((args: { input: { cwd: string } }) => ({
    kind: "refs",
    cwd: args.input.cwd,
  })),
  stashesAtom: vi.fn((args: { input: { cwd: string } }) => ({
    kind: "stashes",
    cwd: args.input.cwd,
  })),
  listPullRequests: vi.fn((args: { input: { cwd: string } }) => ({
    kind: "provider",
    cwd: args.input.cwd,
  })),
  toolbarProps: [] as Array<Record<string, unknown>>,
  historyProps: [] as Array<Record<string, unknown>>,
  refsSnapshot: null as GitManagerRefsSnapshot | null,
  runOperation: vi.fn((_registry: unknown, _target: unknown, _onEvent: unknown) => ({
    result: new Promise(() => undefined),
    cancel: vi.fn(),
  })),
  branchDialogProps: [] as Array<Record<string, unknown>>,
  historyTagDialogProps: [] as Array<Record<string, unknown>>,
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
      data: atom?.kind === "catalog" ? h.catalog : atom?.kind === "refs" ? h.refsSnapshot : null,
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
    getRefs: h.refsAtom,
    getStashes: h.stashesAtom,
    listPullRequests: h.listPullRequests,
    commit: { label: "test:commit" },
    undoCommit: { label: "test:undo-commit" },
    discard: { label: "test:discard" },
  },
  runGitManagerOperation: h.runOperation,
}));

vi.mock("../../state/sourceControlActions", () => ({
  useGitStackedAction: () => ({
    run: vi.fn(),
    isPending: false,
    error: null,
  }),
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
    return (
      <div data-testid="git-manager-toolbar">
        {props.branchSyncDisabledReason as React.ReactNode}
        {props.stashMergeDisabledReason as React.ReactNode}
        {props.tagDisabledReason as React.ReactNode}
      </div>
    );
  },
}));

vi.mock("./history/GitManagerHistoryView", () => ({
  GitManagerHistoryView: (props: Record<string, unknown>) => {
    h.historyProps.push(props);
    return <div data-testid="git-manager-history" />;
  },
}));

vi.mock("./dialogs/GitManagerBranchDialogs", () => ({
  GitManagerBranchDialogs: (props: Record<string, unknown>) => {
    h.branchDialogProps.push(props);
    return props.dialog === null ? null : <div role="dialog">History branch dialog</div>;
  },
}));

vi.mock("./tags/GitManagerTagDialog", () => ({
  GitManagerTagDialog: (props: Record<string, unknown>) => {
    h.historyTagDialogProps.push(props);
    return props.open === true ? <div role="dialog">History tag dialog</div> : null;
  },
}));

import { GitManagerPanel } from "./GitManagerPanel";

const projectRef = {
  environmentId: "environment-1",
  projectId: "project-1",
} as never;

function config(
  gitManagerReads: boolean,
  overrides: Parameters<typeof makeTestExecutionEnvironmentCapabilities>[0] = {},
): ServerConfig {
  return {
    environment: {
      capabilities: makeTestExecutionEnvironmentCapabilities({
        gitManagerReads,
        gitManagerBranchSyncOperations: true,
        gitManagerStashMergeOperations: true,
        gitManagerRewriteOperations: true,
        gitManagerTagOperations: true,
        gitManagerLiveSignal: true,
        gitManagerPullRequests: true,
        ...overrides,
      }),
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
  h.historyProps.length = 0;
  return renderToStaticMarkup(<GitManagerPanel projectRef={projectRef} />);
}

function refsSnapshot(overrides: Partial<GitManagerRefsSnapshot> = {}): GitManagerRefsSnapshot {
  return {
    generation: 1,
    headRef: "main",
    detachedSha: null,
    isDirty: false,
    defaultBranch: "main",
    remotes: ["origin"],
    localBranches: [
      {
        name: "main",
        tipSha: "a".repeat(40),
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
        current: true,
        isDefault: true,
        worktreePath: "/opaque/main",
        blocked: [],
      },
      {
        name: "feature/base",
        tipSha: "f".repeat(40),
        upstream: null,
        ahead: 0,
        behind: 0,
        current: false,
        isDefault: false,
        worktreePath: null,
        blocked: [],
      },
    ],
    remoteBranches: [],
    tags: [],
    worktrees: [],
    inProgressOperation: null,
    conflictedPaths: [],
    ...overrides,
  };
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
  h.refsSnapshot = refsSnapshot();
  h.catalogAtom.mockClear();
  h.signalAtom.mockClear();
  h.refsAtom.mockClear();
  h.stashesAtom.mockClear();
  h.listPullRequests.mockClear();
  h.runOperation.mockClear();
  h.historyProps.length = 0;
  h.branchDialogProps.length = 0;
  h.historyTagDialogProps.length = 0;
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

  it.each([
    [
      "gitManagerBranchSyncOperations",
      "This environment does not support Git Manager branch and sync operations.",
    ],
    [
      "gitManagerStashMergeOperations",
      "This environment does not support Git Manager stash and merge operations.",
    ],
    [
      "gitManagerRewriteOperations",
      "This environment does not support Git Manager rewrite operations.",
    ],
    ["gitManagerTagOperations", "This environment does not support Git Manager tag operations."],
    [
      "gitManagerPullRequests",
      "This environment does not support Git Manager pull request operations.",
    ],
  ] as const)("degrades only the %s surface and renders its reason", (capability, reason) => {
    h.serverConfig = config(true, { [capability]: false });

    const markup = renderPanel();

    expect(markup).toContain(reason);
    expect(markup).toContain("Changes");
    expect(markup).toContain("History");
    expect(markup).not.toContain("Git Manager Unavailable");
    expect(h.refsAtom).toHaveBeenCalled();
  });

  it("uses explicit reads without a live subscription or timer when live updates are unsupported", () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    h.serverConfig = config(true, { gitManagerLiveSignal: false });

    try {
      const markup = renderPanel();

      expect(markup).toContain(
        "This environment does not support Git Manager live updates. Use Refresh to load new repository data.",
      );
      expect(markup).toContain("Changes");
      expect(markup).toContain("History");
      expect(h.signalAtom).not.toHaveBeenCalled();
      expect(h.refsAtom).toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("releases every server subscription when the panel unmounts", () => {
    renderPanel();
    const expectedSubscriptions = h.queryAtoms.filter((atom) => atom !== null).length;
    const cleanups = h.effects.map((effect) => effect()).filter((value) => value !== undefined);

    expect(h.activeSubscriptions).toBe(expectedSubscriptions);
    for (const cleanup of cleanups) cleanup?.();
    expect(h.activeSubscriptions).toBe(0);
  });

  it("does not mount the provider pane while it is disabled", () => {
    expect(renderPanel()).not.toContain("Pull requests and checks");
    expect(h.listPullRequests).not.toHaveBeenCalled();
  });

  it("mounts the enabled provider pane without requesting provider data", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useGitManagerStore.getState().setProviderPaneOpen(projectRef, true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<GitManagerPanel projectRef={projectRef} />));

      expect(container.textContent).toContain("Pull requests and checks");
      expect(container.textContent).toContain("load only when you choose Refresh");
      expect(h.listPullRequests).not.toHaveBeenCalled();

      const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Refresh"),
      );
      expect(refresh).toBeDefined();
      await act(async () => refresh?.click());

      expect(h.listPullRequests).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("opens the multi-commit dialog when History chooses an operation", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useGitManagerStore.getState().setActiveTab(projectRef, "history");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<GitManagerPanel projectRef={projectRef} />));
      const historyProps = h.historyProps.at(-1);
      expect(historyProps).toBeDefined();
      const onAction = historyProps?.onAction;
      expect(onAction).toBeTypeOf("function");

      await act(async () =>
        (onAction as (action: unknown) => void)({
          _tag: "cherry-pick",
          shas: ["b".repeat(40)],
        }),
      );

      expect(document.body.textContent).toContain("Cherry-Pick in Progress");
      expect(h.runOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({ _tag: "cherry-pick", shas: ["b".repeat(40)] }),
        }),
        expect.any(Function),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("mounts the conflict list for an externally conflicted history operation", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    h.refsSnapshot = refsSnapshot({
      inProgressOperation: { kind: "cherry-pick", current: 1, total: 2 },
      conflictedPaths: ["src/conflicted.bin"],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<GitManagerPanel projectRef={projectRef} />));

      expect(document.body.querySelector('section[aria-label="Conflicted files"]')).not.toBeNull();
      expect(document.body.textContent).toContain("src/conflicted.bin");
      const resolve = document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Resolve src/conflicted.bin with theirs"]',
      );
      expect(resolve).not.toBeNull();
      await act(async () => resolve?.click());
      expect(h.runOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            _tag: "resolve-conflict",
            path: "src/conflicted.bin",
            side: "theirs",
          }),
        }),
        expect.any(Function),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("leaves an external non-conflicted operation in the existing resumable strip", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    h.refsSnapshot = refsSnapshot({
      inProgressOperation: { kind: "rebase", current: 1, total: 2 },
      conflictedPaths: [],
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<GitManagerPanel projectRef={projectRef} />));

      expect(document.body.textContent).toContain("Rebase underway");
      expect(document.body.textContent).not.toContain("Rebase in Progress");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("keeps reset behind a destructive confirmation before dispatching", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useGitManagerStore.getState().setActiveTab(projectRef, "history");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const sha = "c".repeat(40);

    try {
      await act(async () => root.render(<GitManagerPanel projectRef={projectRef} />));
      const onAction = h.historyProps.at(-1)?.onAction;
      expect(onAction).toBeTypeOf("function");
      await act(async () => (onAction as (action: unknown) => void)({ _tag: "reset", sha }));

      expect(document.body.textContent).toContain("Reset to ccccccc?");
      expect(h.runOperation).not.toHaveBeenCalled();
      const hardReset = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Discard Changes and Reset",
      );
      expect(hardReset?.className).toContain("destructive");

      await act(async () => hardReset?.click());
      expect(h.runOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({ _tag: "reset", mode: "hard", sha }),
        }),
        expect.any(Function),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("routes revert, create-branch, and create-tag intents through existing parent owners", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useGitManagerStore.getState().setActiveTab(projectRef, "history");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const sha = "d".repeat(40);

    try {
      await act(async () => root.render(<GitManagerPanel projectRef={projectRef} />));
      const onAction = h.historyProps.at(-1)?.onAction as (action: unknown) => void;

      await act(async () => onAction({ _tag: "revert", sha }));
      expect(h.runOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ input: expect.objectContaining({ _tag: "revert", sha }) }),
        expect.any(Function),
      );

      await act(async () => onAction({ _tag: "create-branch", sha }));
      expect(h.branchDialogProps.at(-1)?.dialog).toEqual({ kind: "create", baseBranch: sha });

      await act(async () => onAction({ _tag: "create-tag", sha }));
      expect(h.historyTagDialogProps.at(-1)).toMatchObject({
        action: "create",
        open: true,
        targetSha: sha,
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("opens the existing multi-commit chooser from the Rebase control", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<GitManagerPanel projectRef={projectRef} />));
      const rebase = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Rebase…",
      );
      expect(rebase).toBeDefined();

      await act(async () => rebase?.click());
      expect(document.body.textContent).toContain("Choose a Branch to Rebase");
      const baseBranch = document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Choose branch feature/base"]',
      );
      expect(baseBranch).not.toBeNull();
      await act(async () => baseBranch?.click());
      const confirmRewrite = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Rewrite History",
      );
      expect(confirmRewrite).toBeDefined();
      await act(async () => confirmRewrite?.click());
      expect(h.runOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            _tag: "rebase",
            base: "feature/base",
            target: "main",
          }),
        }),
        expect.any(Function),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("dispatches squash and drag reorder intents through the multi-commit dialog owner", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useGitManagerStore.getState().setActiveTab(projectRef, "history");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const first = "1".repeat(40);
    const second = "2".repeat(40);

    try {
      h.runOperation.mockImplementationOnce(() => ({
        result: Promise.resolve({
          _tag: "Success",
          value: { _tag: "finished", operation: "squash", message: "Squashed." },
        }),
        cancel: vi.fn(),
      }));
      await act(async () => root.render(<GitManagerPanel projectRef={projectRef} />));
      const onAction = h.historyProps.at(-1)?.onAction as (action: unknown) => void;

      await act(async () =>
        onAction({ _tag: "squash", shas: [first, second], message: "Combined change" }),
      );
      expect(document.body.textContent).toContain("Rewrite Squash History?");
      expect(h.runOperation).not.toHaveBeenCalled();
      const confirmSquash = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Rewrite History",
      );
      await act(async () => confirmSquash?.click());
      expect(document.body.textContent).toContain("Squash in Progress");
      expect(h.runOperation).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            _tag: "squash",
            shas: [first, second],
            message: "Combined change",
          }),
        }),
        expect.any(Function),
      );
      await act(async () => onAction({ _tag: "reorder", shas: [second], insertBeforeSha: first }));
      expect(document.body.textContent).toContain("Rewrite Reorder History?");
      const confirmReorder = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Rewrite History",
      );
      await act(async () => confirmReorder?.click());
      expect(document.body.textContent).toContain("Reorder in Progress");
      expect(h.runOperation).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            _tag: "reorder",
            shas: [second],
            insertBeforeSha: first,
          }),
        }),
        expect.any(Function),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
