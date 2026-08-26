// @vitest-environment happy-dom

import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { act, forwardRef, useImperativeHandle, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentTreeProjection, EnvironmentTreeRow } from "../../environmentTree";

const legend = vi.hoisted(() => ({ scrollToIndex: vi.fn(() => Promise.resolve()) }));

vi.mock("@legendapp/list/react", () => ({
  LegendList: forwardRef(function LegendList(
    props: {
      readonly data: readonly EnvironmentTreeRow[];
      readonly renderItem: (input: { item: EnvironmentTreeRow; index: number }) => ReactNode;
      readonly role?: string;
      readonly "aria-label"?: string;
      readonly className?: string;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex: legend.scrollToIndex }));
    return (
      <div role={props.role} aria-label={props["aria-label"]} className={props.className}>
        {props.data.map((item, index) => (
          <div key={item.key} data-virtual-index={index}>
            {props.renderItem({ item, index })}
          </div>
        ))}
      </div>
    );
  }),
}));

import { EnvironmentTree } from "./EnvironmentTree";

const ENV = EnvironmentId.make("remote");
const PROJECT = ProjectId.make("api");
const MAIN = ThreadId.make("main");
const WORKTREE = ThreadId.make("worktree");

const rows: readonly EnvironmentTreeRow[] = [
  {
    kind: "environment",
    key: "environment:remote",
    parentKey: null,
    environmentId: ENV,
    environmentKind: "remote",
    status: "offline",
    statusText: "Offline",
    canonicalLabel: "build-host.internal",
    lastSynchronizedAt: "2026-08-24T12:00:00.000Z",
    level: 1,
    label: "Build host",
    secondaryLabel: "build-host.internal",
    activityLabel: null,
    isExpanded: true,
    isSelected: false,
    isCached: true,
    isStale: true,
    ariaPosInSet: 1,
    ariaSetSize: 1,
  },
  {
    kind: "project",
    key: "project:remote:api",
    parentKey: "environment:remote",
    environmentId: ENV,
    projectId: PROJECT,
    workspaceRoot: "/srv/api",
    level: 2,
    label: "API",
    secondaryLabel: "/srv/api",
    activityLabel: null,
    isExpanded: true,
    isSelected: false,
    isCached: true,
    isStale: true,
    ariaPosInSet: 1,
    ariaSetSize: 1,
  },
  {
    kind: "thread",
    key: "thread:remote:main",
    parentKey: "project:remote:api",
    environmentId: ENV,
    projectId: PROJECT,
    threadId: MAIN,
    role: "main",
    branch: null,
    worktreePath: null,
    level: 3,
    label: "Main",
    secondaryLabel: null,
    activityLabel: null,
    isExpanded: false,
    isSelected: true,
    isCached: true,
    isStale: true,
    ariaPosInSet: 1,
    ariaSetSize: 2,
  },
  {
    kind: "thread",
    key: "thread:remote:worktree",
    parentKey: "project:remote:api",
    environmentId: ENV,
    projectId: PROJECT,
    threadId: WORKTREE,
    role: "worktree",
    branch: "feature/tree",
    worktreePath: "/srv/api-tree",
    level: 3,
    label: "Tree work",
    secondaryLabel: "feature/tree",
    activityLabel: "Running",
    isExpanded: false,
    isSelected: false,
    isCached: true,
    isStale: true,
    ariaPosInSet: 2,
    ariaSetSize: 2,
  },
];

const projection: EnvironmentTreeProjection = {
  rows,
  rowByKey: new Map(rows.map((row) => [row.key, row])),
  indexByKey: new Map(rows.map((row, index) => [row.key, index])),
  parentByKey: new Map(rows.map((row) => [row.key, row.parentKey])),
  environmentOrder: [ENV],
  environmentOrderChanged: false,
};

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

afterEach(async () => {
  await act(async () => {
    for (const entry of mounted.splice(0)) entry.root.unmount();
  });
  legend.scrollToIndex.mockClear();
});

async function renderTree() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  const onClearSearch = vi.fn();
  await act(async () => {
    root.render(
      <EnvironmentTree
        projection={projection}
        pinnedThreadKeys={["remote:worktree"]}
        unreadThreadKeys={["remote:worktree"]}
        onToggle={onToggle}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        onClearSearch={onClearSearch}
      />,
    );
  });
  return { container, root, onToggle, onSelect, onContextMenu, onClearSearch };
}

function key(target: Element, value: string, options: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, ...options }));
}

describe("EnvironmentTree", () => {
  it("renders one virtualized semantic tree with exact flattened metadata", async () => {
    const { container } = await renderTree();
    expect(container.querySelectorAll('[role="tree"]')).toHaveLength(1);
    const items = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.getAttribute("aria-level"))).toEqual(["1", "2", "3", "3"]);
    expect(items[2]?.getAttribute("aria-posinset")).toBe("1");
    expect(items[3]?.getAttribute("aria-posinset")).toBe("2");
    expect(items[3]?.getAttribute("aria-setsize")).toBe("2");
    expect(items[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(items[2]?.getAttribute("aria-selected")).toBe("true");
    expect(items[0]?.getAttribute("aria-label")).toContain("Offline");
    expect(items[3]?.getAttribute("aria-label")).toContain("Worktree thread");
    expect(container.textContent).not.toContain("Panel");
    expect(container.textContent).not.toContain("Diagnostics");
  });

  it("keeps caret, name activation, and pointer context menus separate", async () => {
    const { container, onToggle, onSelect, onContextMenu } = await renderTree();
    const caret = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse environment Build host"]',
    );
    const name = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open environment Build host"]',
    );
    const actions = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Environment actions for Build host"]',
    );
    await act(async () => {
      caret?.click();
      name?.click();
      actions?.click();
    });
    expect(onToggle).toHaveBeenCalledWith(rows[0]);
    expect(onSelect).toHaveBeenCalledWith(rows[0]);
    expect(onContextMenu).toHaveBeenCalledWith(
      rows[0],
      expect.objectContaining({ source: "pointer" }),
    );
  });

  it("implements deterministic tree keyboard navigation and virtual focus", async () => {
    const { container, onToggle, onSelect, onContextMenu, onClearSearch } = await renderTree();
    const item = (index: number) =>
      container.querySelectorAll<HTMLElement>('[role="treeitem"]')[index]!;

    await act(async () => {
      item(2).focus();
      key(item(2), "ArrowLeft");
      await Promise.resolve();
    });
    expect(legend.scrollToIndex).toHaveBeenLastCalledWith({ index: 1, animated: false });

    await act(async () => {
      key(item(1), "ArrowLeft");
      key(item(1), "ArrowRight");
      key(item(1), "End");
      key(item(3), "Home");
      key(item(0), "A");
      key(item(1), "Enter");
      key(item(1), "F10", { shiftKey: true });
      key(item(1), "Escape");
      await Promise.resolve();
    });

    expect(onToggle).toHaveBeenCalledWith(rows[1]);
    expect(onSelect).toHaveBeenCalledWith(rows[1]);
    expect(onContextMenu).toHaveBeenCalledWith(rows[1], {
      source: "keyboard",
      clientX: 0,
      clientY: 0,
    });
    expect(onClearSearch).toHaveBeenCalledTimes(1);
    expect(legend.scrollToIndex).toHaveBeenCalledWith({ index: 3, animated: false });
    expect(legend.scrollToIndex).toHaveBeenCalledWith({ index: 0, animated: false });
  });

  it("restores DOM focus when reconciliation removes the focused row", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { container, root, onToggle, onSelect, onContextMenu, onClearSearch } =
      await renderTree();
    const worktree = container.querySelector<HTMLElement>(
      '[data-environment-tree-row="thread:remote:worktree"]',
    );
    await act(async () => {
      worktree?.focus();
    });
    expect(document.activeElement).toBe(worktree);

    const nextRows = rows.slice(0, 3);
    const nextProjection: EnvironmentTreeProjection = {
      ...projection,
      rows: nextRows,
      rowByKey: new Map(nextRows.map((row) => [row.key, row])),
      indexByKey: new Map(nextRows.map((row, index) => [row.key, index])),
      parentByKey: new Map(nextRows.map((row) => [row.key, row.parentKey])),
    };
    await act(async () => {
      root.render(
        <EnvironmentTree
          projection={nextProjection}
          pinnedThreadKeys={["remote:worktree"]}
          unreadThreadKeys={["remote:worktree"]}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onClearSearch={onClearSearch}
        />,
      );
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(
      container.querySelector('[data-environment-tree-row="thread:remote:main"]'),
    );
    expect(legend.scrollToIndex).toHaveBeenLastCalledWith({ index: 2, animated: false });
    vi.unstubAllGlobals();
  });
});
