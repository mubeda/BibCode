// @vitest-environment happy-dom

import type { GitManagerCommitEntry } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  listProps: null as Record<string, unknown> | null,
  commitPage: null as {
    generation: number;
    pinnedTips: ReadonlyArray<string>;
    commits: ReadonlyArray<GitManagerCommitEntry>;
    nextOffset: number | null;
    exhausted: boolean;
    degradedToAllPaging: boolean;
  } | null,
  contextMenuShow: vi.fn(),
  dndProps: null as Record<string, unknown> | null,
  refreshCommits: vi.fn(),
}));

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: ReadonlyArray<GitManagerCommitEntry>;
    keyExtractor: (commit: GitManagerCommitEntry) => string;
    renderItem: (input: { item: GitManagerCommitEntry; index: number }) => React.ReactNode;
  }) => {
    h.listProps = props as unknown as Record<string, unknown>;
    return (
      <div>
        {props.data.map((item, index) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("../../../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: h.contextMenuShow } }),
}));

vi.mock("../../../state/gitManager", () => ({
  gitManagerEnvironment: {
    getCommits: vi.fn(() => ({ kind: "commits" })),
  },
}));

vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data: atom?.kind === "commits" ? h.commitPage : null,
    emission: { _tag: "Initial", waiting: false },
    error: null,
    isPending: false,
    refresh: atom?.kind === "commits" ? h.refreshCommits : vi.fn(),
  }),
}));

vi.mock("../rewrite/gitManagerCommitDrag", () => ({
  GitManagerCommitDndContext: (props: Record<string, unknown>) => {
    h.dndProps = props;
    return <>{props.children as React.ReactNode}</>;
  },
  GitManagerCommitInsertionTarget: () => null,
  useGitManagerCommitDragSource: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    isDragging: false,
    transform: undefined,
  }),
}));

import { GitManagerCommitList } from "./GitManagerCommitList";
import { GitManagerHistoryView } from "./GitManagerHistoryView";

let container: HTMLDivElement;
let root: Root | null;

function commit(index: number): GitManagerCommitEntry {
  const sha = index.toString(16).padStart(40, "0");
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents: [],
    decorations: [],
    subject: `Commit ${index}`,
    body: "",
    authorName: "Local Author",
    authorEmail: "local@example.test",
    authoredAtMs: index,
    committerName: "Local Author",
    committerEmail: "local@example.test",
    committedAtMs: index,
    changedFiles: [],
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.listProps = null;
  h.commitPage = null;
  h.contextMenuShow.mockReset();
  h.dndProps = null;
  h.refreshCommits.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("GitManagerCommitList", () => {
  it("requests one next page when the tenth-from-last row becomes visible", async () => {
    const commits = Array.from({ length: 100 }, (_, index) => commit(index));
    const onReachEnd = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    await act(async () =>
      root?.render(
        <GitManagerCommitList
          commits={commits}
          selectedSha={null}
          onSelect={() => undefined}
          onReachEnd={onReachEnd}
          isLoadingMore={false}
        />,
      ),
    );

    const onViewableItemsChanged = h.listProps?.onViewableItemsChanged as
      | ((input: { end: number }) => void)
      | undefined;
    expect(onViewableItemsChanged).toBeTypeOf("function");
    act(() => {
      onViewableItemsChanged?.({ end: 90 });
      onViewableItemsChanged?.({ end: 90 });
    });

    expect(onReachEnd).toHaveBeenCalledTimes(1);
    expect(h.listProps?.estimatedItemSize).toBe(50);
    expect((h.listProps?.getFixedItemSize as (() => number) | undefined)?.()).toBe(50);
  });

  it("moves selection with the arrow keys and exposes a useful row name", async () => {
    const commits = [commit(0), commit(1), commit(2)];
    const onSelect = vi.fn();

    await act(async () =>
      root?.render(
        <GitManagerCommitList
          commits={commits}
          selectedSha={commits[0]!.sha}
          onSelect={onSelect}
          onReachEnd={() => undefined}
          isLoadingMore={false}
        />,
      ),
    );

    const firstRow = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${commits[0]!.shortSha} ${commits[0]!.subject}"]`,
    );
    expect(firstRow).not.toBeNull();
    act(() => {
      firstRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith(commits[1]!.sha);
  });
});

describe("GitManagerHistoryView rewrite reachability", () => {
  it("opens the existing commit menu from the list and forwards the chosen operation", async () => {
    const selectedCommit = commit(7);
    h.commitPage = {
      generation: 1,
      pinnedTips: [selectedCommit.sha],
      commits: [selectedCommit],
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };
    h.contextMenuShow.mockResolvedValue("cherry-pick");
    const onAction = vi.fn();

    await act(async () =>
      root?.render(
        <GitManagerHistoryView
          branchSyncDisabledReason={null}
          blockedReasons={[
            {
              operation: "reset",
              code: "operation-in-flight",
              message: "Server says the repository mutation lane is occupied.",
            },
          ]}
          repositoryGeneration={null}
          projectRef={{ environmentId: "environment-1", projectId: "project-1" } as never}
          rewriteDisabledReason={null}
          scope={{ environmentId: "environment-1" as never, cwd: "/opaque/repository" }}
          tagDisabledReason={null}
          onAction={onAction}
        />,
      ),
    );

    const row = container.querySelector<HTMLButtonElement>(
      `button[data-commit-sha="${selectedCommit.sha}"]`,
    );
    expect(row).not.toBeNull();
    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 17,
          clientY: 29,
        }),
      );
      await Promise.resolve();
    });

    expect(h.contextMenuShow).toHaveBeenCalledOnce();
    const [items, position] = h.contextMenuShow.mock.calls[0] ?? [];
    expect(position).toEqual({ x: 17, y: 29 });
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cherry-pick", label: "Cherry-Pick", disabled: false }),
        expect.objectContaining({
          id: "reset",
          disabled: true,
          label: expect.stringContaining("Server says the repository mutation lane is occupied."),
        }),
      ]),
    );
    expect(onAction).toHaveBeenCalledWith({
      _tag: "cherry-pick",
      shas: [selectedCommit.sha],
    });
  });

  it("forwards commit-list drag reorder results through the history parent", async () => {
    const selectedCommit = commit(8);
    h.commitPage = {
      generation: 1,
      pinnedTips: [selectedCommit.sha],
      commits: [selectedCommit],
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };
    const onAction = vi.fn();

    await act(async () =>
      root?.render(
        <GitManagerHistoryView
          branchSyncDisabledReason={null}
          blockedReasons={[]}
          repositoryGeneration={null}
          projectRef={{ environmentId: "environment-1", projectId: "project-1" } as never}
          rewriteDisabledReason={null}
          scope={{ environmentId: "environment-1" as never, cwd: "/opaque/repository" }}
          tagDisabledReason={null}
          onAction={onAction}
        />,
      ),
    );

    const onCommitDrop = h.dndProps?.onCommitDrop;
    expect(onCommitDrop).toBeTypeOf("function");
    await act(async () =>
      (onCommitDrop as (resolution: unknown) => void)({
        _tag: "reorder",
        shas: [selectedCommit.sha],
        insertBeforeSha: null,
      }),
    );

    expect(onAction).toHaveBeenCalledWith({
      _tag: "reorder",
      shas: [selectedCommit.sha],
      insertBeforeSha: null,
    });
  });

  it("makes contiguous multi-commit actions reachable with standard range selection", async () => {
    const commits = [commit(10), commit(11), commit(12)];
    h.commitPage = {
      generation: 1,
      pinnedTips: commits.map((entry) => entry.sha),
      commits,
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };
    h.contextMenuShow.mockResolvedValue(null);

    await act(async () =>
      root?.render(
        <GitManagerHistoryView
          branchSyncDisabledReason={null}
          blockedReasons={[]}
          repositoryGeneration={null}
          projectRef={{ environmentId: "environment-1", projectId: "project-1" } as never}
          rewriteDisabledReason={null}
          scope={{ environmentId: "environment-1" as never, cwd: "/opaque/repository" }}
          tagDisabledReason={null}
          onAction={vi.fn()}
        />,
      ),
    );
    const rows = commits.map((entry) =>
      container.querySelector<HTMLButtonElement>(`button[data-commit-sha="${entry.sha}"]`),
    );
    await act(async () => rows[0]?.click());
    await act(async () =>
      rows[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })),
    );
    await act(async () => {
      rows[2]?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      await Promise.resolve();
    });

    const [items] = h.contextMenuShow.mock.calls[0] ?? [];
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "squash", label: "Squash 3", disabled: false }),
        expect.objectContaining({ id: "reorder", label: "Reorder 3", disabled: false }),
      ]),
    );
    expect(h.dndProps?.multiCommitSelection).toEqual(commits.map((entry) => entry.sha));
  });

  it("keeps rewrite entries disabled with their reason while branch, tag, and copy remain available", async () => {
    const selectedCommit = commit(13);
    const reason = "This environment does not support Git Manager rewrite operations.";
    h.commitPage = {
      generation: 1,
      pinnedTips: [selectedCommit.sha],
      commits: [selectedCommit],
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };
    h.contextMenuShow.mockResolvedValue(null);

    await act(async () =>
      root?.render(
        <GitManagerHistoryView
          branchSyncDisabledReason={null}
          blockedReasons={[]}
          repositoryGeneration={null}
          projectRef={{ environmentId: "environment-1", projectId: "project-1" } as never}
          rewriteDisabledReason={reason}
          scope={{ environmentId: "environment-1" as never, cwd: "/opaque/repository" }}
          tagDisabledReason={null}
          onAction={vi.fn()}
        />,
      ),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`button[data-commit-sha="${selectedCommit.sha}"]`)
        ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      await Promise.resolve();
    });

    const [items] = h.contextMenuShow.mock.calls[0] ?? [];
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reset",
          disabled: true,
          label: expect.stringContaining(reason),
        }),
        expect.objectContaining({
          id: "cherry-pick",
          disabled: true,
          label: expect.stringContaining(reason),
        }),
        expect.objectContaining({ id: "create-branch", disabled: false }),
        expect.objectContaining({ id: "create-tag", disabled: false }),
        expect.objectContaining({ id: "copy-sha", disabled: false }),
      ]),
    );
    expect(container.textContent).toContain(reason);
  });

  it("keeps explicit history refresh available without a repository generation", async () => {
    const selectedCommit = commit(14);
    h.commitPage = {
      generation: 1,
      pinnedTips: [selectedCommit.sha],
      commits: [selectedCommit],
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };

    await act(async () =>
      root?.render(
        <GitManagerHistoryView
          branchSyncDisabledReason={null}
          blockedReasons={[]}
          repositoryGeneration={null}
          projectRef={{ environmentId: "environment-1", projectId: "project-1" } as never}
          rewriteDisabledReason={null}
          scope={{ environmentId: "environment-1" as never, cwd: "/opaque/repository" }}
          tagDisabledReason={null}
          onAction={vi.fn()}
        />,
      ),
    );

    expect(h.refreshCommits).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Commit 14");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh history"]'),
    ).not.toBeNull();
  });
});

describe("GitManagerHistoryView repository generation tracking", () => {
  function renderHistory(repositoryGeneration: number | null) {
    return act(async () =>
      root?.render(
        <GitManagerHistoryView
          branchSyncDisabledReason={null}
          blockedReasons={[]}
          repositoryGeneration={repositoryGeneration}
          projectRef={{ environmentId: "environment-1", projectId: "project-1" } as never}
          rewriteDisabledReason={null}
          scope={{ environmentId: "environment-1" as never, cwd: "/opaque/repository" }}
          tagDisabledReason={null}
          onAction={vi.fn()}
        />,
      ),
    );
  }

  it("refreshes a cached page that is behind the repository generation on mount", async () => {
    const tip = commit(20);
    h.commitPage = {
      generation: 1,
      pinnedTips: [tip.sha],
      commits: [tip, commit(19), commit(18), commit(17)],
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };

    await renderHistory(2);

    expect(h.refreshCommits).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Commit 20");
  });

  it("refreshes once per newer generation and splices the new tip without losing rows", async () => {
    const commits = [commit(23), commit(22), commit(21)];
    h.commitPage = {
      generation: 4,
      pinnedTips: [commits[0]!.sha],
      commits,
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };

    await renderHistory(4);
    expect(h.refreshCommits).not.toHaveBeenCalled();

    await renderHistory(5);
    expect(h.refreshCommits).toHaveBeenCalledOnce();
    await renderHistory(5);
    expect(h.refreshCommits).toHaveBeenCalledOnce();

    const newTip = commit(24);
    h.commitPage = {
      generation: 5,
      pinnedTips: [newTip.sha],
      commits: [newTip, ...commits],
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };
    await renderHistory(5);

    expect(h.refreshCommits).toHaveBeenCalledOnce();
    const rows = [...container.querySelectorAll<HTMLButtonElement>("button[data-commit-sha]")].map(
      (row) => row.dataset.commitSha,
    );
    expect(rows).toEqual([newTip.sha, ...commits.map((entry) => entry.sha)]);

    await renderHistory(3);
    expect(h.refreshCommits).toHaveBeenCalledOnce();
  });

  it("shows the committed tip after remount without an explicit refresh click", async () => {
    // History was loaded at generation 1, the user committed from Changes while
    // History was unmounted, and the panel's refs snapshot now reports 2.
    const preCommit = [commit(31), commit(30)];
    h.commitPage = {
      generation: 1,
      pinnedTips: [preCommit[0]!.sha],
      commits: preCommit,
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };
    h.refreshCommits.mockImplementation(() => {
      const committed = commit(32);
      h.commitPage = {
        generation: 2,
        pinnedTips: [committed.sha],
        commits: [committed, ...preCommit],
        nextOffset: null,
        exhausted: true,
        degradedToAllPaging: false,
      };
    });

    await renderHistory(2);
    expect(h.refreshCommits).toHaveBeenCalledOnce();
    await renderHistory(2);

    const rows = [...container.querySelectorAll<HTMLButtonElement>("button[data-commit-sha]")].map(
      (row) => row.dataset.commitSha,
    );
    expect(rows).toEqual([commit(32).sha, ...preCommit.map((entry) => entry.sha)]);
    expect(container.textContent).toContain("3 commits loaded");
    expect(h.refreshCommits).toHaveBeenCalledOnce();
  });

  it("ignores a stale first page that resolves behind the loaded generation", async () => {
    const newTip = commit(44);
    const older = [commit(43), commit(42)];
    h.commitPage = {
      generation: 6,
      pinnedTips: [newTip.sha],
      commits: [newTip, ...older],
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };
    await renderHistory(6);
    expect(container.textContent).toContain("3 commits loaded");

    // An older in-flight read completing late must not restore pre-commit history
    // or trigger another refresh cycle.
    h.commitPage = {
      generation: 5,
      pinnedTips: [older[0]!.sha],
      commits: older,
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };
    await renderHistory(6);

    const rows = [...container.querySelectorAll<HTMLButtonElement>("button[data-commit-sha]")].map(
      (row) => row.dataset.commitSha,
    );
    expect(rows).toEqual([newTip.sha, ...older.map((entry) => entry.sha)]);
    expect(container.textContent).toContain("3 commits loaded");
    expect(h.refreshCommits).not.toHaveBeenCalled();
  });

  it("requests history only for the scoped repository", async () => {
    const getCommits = vi.mocked(
      (await import("../../../state/gitManager")).gitManagerEnvironment.getCommits,
    );
    getCommits.mockClear();
    h.commitPage = {
      generation: 1,
      pinnedTips: [],
      commits: [],
      nextOffset: null,
      exhausted: true,
      degradedToAllPaging: false,
    };

    await act(async () =>
      root?.render(
        <GitManagerHistoryView
          branchSyncDisabledReason={null}
          blockedReasons={[]}
          repositoryGeneration={1}
          projectRef={{ environmentId: "environment-1", projectId: "project-a" } as never}
          rewriteDisabledReason={null}
          scope={{ environmentId: "environment-1" as never, cwd: "/repositories/a" }}
          tagDisabledReason={null}
          onAction={vi.fn()}
        />,
      ),
    );

    const requestedTargets = getCommits.mock.calls.map(
      (call) => call[0] as { environmentId: string; input: { cwd: string } },
    );
    expect(requestedTargets.length).toBeGreaterThan(0);
    for (const target of requestedTargets) {
      expect(target.environmentId).toBe("environment-1");
      expect(target.input.cwd).toBe("/repositories/a");
    }
  });
});
