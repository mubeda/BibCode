// @vitest-environment happy-dom

import type { GitManagerCommitEntry } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  listProps: null as Record<string, unknown> | null,
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

import { GitManagerCommitList } from "./GitManagerCommitList";

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
