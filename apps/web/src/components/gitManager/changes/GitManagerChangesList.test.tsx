// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ChangeRow } from "./changesList.logic";

const h = vi.hoisted(() => ({
  rendersByPath: new Map<string, number>(),
  listProps: null as Record<string, unknown> | null,
}));

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: ReadonlyArray<ChangeRow>;
    keyExtractor: (row: ChangeRow) => string;
    renderItem: (input: { item: ChangeRow; index: number }) => React.ReactNode;
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

vi.mock("./GitManagerChangeRow", async () => {
  const { memo } = await import("react");
  return {
    GitManagerChangeRow: memo(function MockChangeRow({ row }: { row: ChangeRow }) {
      h.rendersByPath.set(row.path, (h.rendersByPath.get(row.path) ?? 0) + 1);
      return <span>{row.path}</span>;
    }),
  };
});

import { GitManagerChangesList } from "./GitManagerChangesList";

let container: HTMLDivElement;
let root: Root | null;

const onContextMenu = () => undefined;
const onOpenExternal = () => undefined;
const onSelect = () => undefined;
const onToggle = () => undefined;

function row(path: string): ChangeRow {
  return {
    path,
    status: "modified",
    area: "unstaged",
    insertions: 1,
    deletions: 0,
    inclusion: "all",
    conflicted: false,
    submodule: false,
    disabledReason: null,
  };
}

async function renderRows(rows: ReadonlyArray<ChangeRow>) {
  await act(async () =>
    root?.render(
      <GitManagerChangesList
        rows={rows}
        selectedPath={null}
        onContextMenu={onContextMenu}
        onOpenExternal={onOpenExternal}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.rendersByPath.clear();
  h.listProps = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("GitManagerChangesList", () => {
  it("keeps semantically unchanged row bodies stable across status ticks", async () => {
    await renderRows([row("src/a.ts"), row("src/b.ts")]);
    await renderRows([row("src/a.ts"), row("src/b.ts")]);

    expect(h.rendersByPath).toEqual(
      new Map([
        ["src/a.ts", 1],
        ["src/b.ts", 1],
      ]),
    );
    expect(h.listProps?.estimatedItemSize).toBe(29);
    expect((h.listProps?.getFixedItemSize as (() => number) | undefined)?.()).toBe(29);
  });
});
