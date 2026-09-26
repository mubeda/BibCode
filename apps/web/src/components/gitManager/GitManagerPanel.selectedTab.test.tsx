// @vitest-environment happy-dom

import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@bibcode/client-runtime/connection";
import type {
  GitManagerRefsSnapshot,
  ServerConfig,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@bibcode/contracts";
import { applyGitStatusStreamEvent } from "@bibcode/shared/git";
import { makeTestExecutionEnvironmentCapabilities } from "@bibcode/shared/testSupport";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../gitManagerStore";

// Queries publish through a tiny external store, so a new value re-renders only the
// components that read it, as a live atom subscription does.
const h = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    status: null as VcsStatusResult | null,
    refs: null as GitManagerRefsSnapshot | null,
    /** The latest toolbar props, whose callback switches the checkout. */
    toolbar: null as { onSelectedWorktreeChange: (cwd: string) => void } | null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    publish: () => {
      version += 1;
      for (const listener of listeners) listener();
    },
    noop: () => undefined,
  };
});

vi.mock("../../state/query", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentQuery: (atom: { kind: string } | null) => {
      useSyncExternalStore(h.subscribe, h.version);
      const data =
        atom?.kind === "catalog"
          ? {
              worktrees: [
                { path: "/opaque/main", branch: "main", isPrimary: true },
                { path: "/opaque/feature", branch: "feature", isPrimary: false },
              ],
            }
          : atom?.kind === "status"
            ? h.status
            : atom?.kind === "refs"
              ? h.refs
              : atom?.kind === "signal"
                ? { generation: 1 }
                : null;
      return {
        data,
        emission: data === null ? { _tag: "Initial" } : { _tag: "Success", value: data },
        error: null,
        isPending: false,
        refresh: h.noop,
        revalidate: h.noop,
        requiresRetry: false,
      };
    },
  };
});

vi.mock("../../state/entities", () => ({
  useProject: () => ({
    id: "project-1",
    environmentId: "environment-1",
    title: "Repository",
    workspaceRoot: "/opaque/main",
  }),
  useServerConfigs: () =>
    new Map([
      [
        "environment-1",
        {
          environment: {
            capabilities: makeTestExecutionEnvironmentCapabilities({
              gitManagerReads: true,
              gitManagerBranchSyncOperations: true,
              gitManagerStashMergeOperations: true,
              gitManagerRewriteOperations: true,
              gitManagerTagOperations: true,
              gitManagerLiveSignal: true,
              gitManagerPullRequests: true,
            }),
          },
        } as ServerConfig,
      ],
    ]),
}));

vi.mock("../../state/environments", () => ({
  useEnvironmentConnectionState: () => ({
    data: {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected",
      network: "online",
    } satisfies SupervisorConnectionState,
  }),
  useEnvironment: () => ({ label: "Local" }),
}));

vi.mock("../../state/worktrees", () => ({
  worktreeEnvironment: { catalog: () => ({ kind: "catalog" }) },
}));

vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: () => ({ kind: "status" }) },
}));

vi.mock("../../state/gitManager", () => ({
  gitManagerEnvironment: {
    signalWithDegradedFocusRefresh: () => ({ kind: "signal" }),
    getRefs: () => ({ kind: "refs" }),
    getStashes: () => ({ kind: "stashes" }),
  },
  runGitManagerOperation: vi.fn(),
}));

vi.mock("./GitManagerToolbar", () => ({
  GitManagerToolbar: (props: { onSelectedWorktreeChange: (cwd: string) => void }) => {
    h.toolbar = props;
    return null;
  },
}));
vi.mock("./changes/GitManagerChangesView", () => ({
  GitManagerChangesView: () => <div data-testid="changes-view" />,
}));
vi.mock("./history/GitManagerHistoryView", () => ({
  GitManagerHistoryView: () => <div data-testid="history-view" />,
}));
vi.mock("./tags/GitManagerTagsView", () => ({
  GitManagerTagsView: () => <div data-testid="tags-view" />,
}));
vi.mock("./dialogs/GitManagerBranchDialogs", () => ({ GitManagerBranchDialogs: () => null }));
vi.mock("./tags/GitManagerTagDialog", () => ({ GitManagerTagDialog: () => null }));
vi.mock("./merge/GitManagerMergeDialog", () => ({ GitManagerMergeDialog: () => null }));
vi.mock("./rewrite/GitManagerResetDialog", () => ({ GitManagerResetDialog: () => null }));

import { GitManagerPanel } from "./GitManagerPanel";

const projectRef = { environmentId: "environment-1", projectId: "project-1" } as never;

// Status frames recorded from a live server while `.git/HEAD` was broken ("not a ref") and
// then repaired; a malformed `.git/config` produced the same unreadable frame.
const DIRTY_LOCAL = {
  defaultRefName: "main",
  hasPrimaryRemote: false,
  hasWorkingTreeChanges: true,
  isDefaultRef: true,
  isRepo: true,
  refName: "main",
  workingTree: {
    deletions: 0,
    files: [
      { area: "unstaged", deletions: 0, insertions: 1, path: "a.txt", status: "modified" },
      { area: "untracked", deletions: 0, insertions: 1, path: "c.txt", status: "untracked" },
    ],
    insertions: 2,
  },
} as const;
const CLEAN_LOCAL = {
  ...DIRTY_LOCAL,
  hasWorkingTreeChanges: false,
  workingTree: { deletions: 0, files: [], insertions: 0 },
} as const;
const REMOTE = {
  aheadCount: 0,
  aheadOfDefaultCount: 0,
  behindCount: 0,
  hasUpstream: false,
  pr: null,
} as const;
const UNREADABLE: ReadonlyArray<VcsStatusStreamEvent> = [
  {
    _tag: "localUpdated",
    local: {
      hasPrimaryRemote: false,
      hasWorkingTreeChanges: false,
      isDefaultRef: false,
      isRepo: false,
      refName: null,
      workingTree: { deletions: 0, files: [], insertions: 0 },
    },
  },
  { _tag: "remoteUpdated", remote: null },
];
const recovered = (local: typeof DIRTY_LOCAL | typeof CLEAN_LOCAL): VcsStatusStreamEvent[] => [
  { _tag: "localUpdated", local },
  { _tag: "remoteUpdated", remote: REMOTE },
];

const REFS: GitManagerRefsSnapshot = {
  conflictedPaths: [],
  defaultBranch: "main",
  detachedSha: null,
  generation: 1,
  headRef: "main",
  inProgressOperation: null,
  isDirty: true,
  localBranches: [
    {
      ahead: 0,
      behind: 0,
      blocked: [],
      current: true,
      isDefault: true,
      name: "main",
      tipSha: "7".repeat(40),
      upstream: null,
      worktreePath: "/opaque/main",
    },
  ],
  remoteBranches: [],
  remotes: [],
  tags: [],
  worktrees: [],
};

let container: HTMLDivElement;
let root: Root;

/** Applies each frame as its own emission, the way the status stream delivers them. */
async function deliver(frames: ReadonlyArray<VcsStatusStreamEvent>): Promise<void> {
  for (const frame of frames) {
    await act(async () => {
      h.status = applyGitStatusStreamEvent(h.status, frame);
      h.publish();
    });
  }
}

function tab(name: "Changes" | "History" | "Tags"): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (element) => element.textContent?.trim() === name,
  );
  expect(match).toBeDefined();
  return match!;
}

function selectedTab(): string | null {
  return container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null;
}

async function openManagerOn(name: "Changes" | "History" | "Tags"): Promise<void> {
  await act(async () => root.render(<GitManagerPanel projectRef={projectRef} />));
  await act(async () => tab(name).click());
  expect(selectedTab()).toBe(name);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useGitManagerStore.setState({ byProjectKey: {} });
  h.status = null;
  h.refs = REFS;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("GitManagerPanel selected tab", () => {
  it("stays on Changes while Git cannot read the repository and after it recovers", async () => {
    h.status = applyGitStatusStreamEvent(null, {
      _tag: "snapshot",
      local: DIRTY_LOCAL,
      remote: null,
    });
    await openManagerOn("Changes");

    await deliver(UNREADABLE);
    expect(selectedTab()).toBe("Changes");
    expect(container.querySelector('[data-testid="changes-view"]')).not.toBeNull();

    await deliver(recovered(DIRTY_LOCAL));
    expect(selectedTab()).toBe("Changes");
    expect(container.querySelector('[data-testid="changes-view"]')).not.toBeNull();
  });

  it("stays on Changes when a clean repository fails and recovers clean", async () => {
    h.status = applyGitStatusStreamEvent(null, {
      _tag: "snapshot",
      local: CLEAN_LOCAL,
      remote: REMOTE,
    });
    await openManagerOn("Changes");

    await deliver(UNREADABLE);
    expect(selectedTab()).toBe("Changes");

    await deliver(recovered(CLEAN_LOCAL));
    expect(selectedTab()).toBe("Changes");
  });

  it("keeps Changes when it is picked from Tags on a clean checkout", async () => {
    h.status = applyGitStatusStreamEvent(null, {
      _tag: "snapshot",
      local: CLEAN_LOCAL,
      remote: REMOTE,
    });
    await openManagerOn("Tags");

    await act(async () => tab("Changes").click());

    expect(selectedTab()).toBe("Changes");
  });

  it("underlines the selected tab through the data-active attribute Base UI sets", async () => {
    h.status = applyGitStatusStreamEvent(null, {
      _tag: "snapshot",
      local: DIRTY_LOCAL,
      remote: null,
    });
    await openManagerOn("Changes");

    expect(tab("Changes").hasAttribute("data-active")).toBe(true);
    expect(tab("History").hasAttribute("data-active")).toBe(false);
    expect(tab("Changes").className).toMatch(/(^|\s)data-active:border-foreground(\s|$)/);
    expect(tab("Changes").className).not.toMatch(/data-selected:/);
  });

  it("treats another checkout like opening the panel on it", async () => {
    h.status = applyGitStatusStreamEvent(null, {
      _tag: "snapshot",
      local: CLEAN_LOCAL,
      remote: REMOTE,
    });
    // A pick on a clean checkout stays; moving to another clean checkout starts over.
    await openManagerOn("Changes");

    await act(async () => h.toolbar?.onSelectedWorktreeChange("/opaque/feature"));

    expect(selectedTab()).toBe("History");
  });

  it("still moves from Changes to History when a dirty checkout becomes clean", async () => {
    h.status = applyGitStatusStreamEvent(null, {
      _tag: "snapshot",
      local: DIRTY_LOCAL,
      remote: null,
    });
    await openManagerOn("Changes");

    await deliver([{ _tag: "localUpdated", local: CLEAN_LOCAL }]);

    expect(selectedTab()).toBe("History");
  });
});
