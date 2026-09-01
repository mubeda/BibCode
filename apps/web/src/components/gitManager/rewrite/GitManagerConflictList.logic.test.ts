// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GitManagerConflictList } from "./GitManagerConflictList";
import {
  hasLiveConflictMarkers,
  isConflictResolved,
  resolveConflictCount,
} from "./GitManagerConflictList.logic";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("resolveConflictCount", () => {
  it("converts raw marker diagnostics into user-facing conflict groups", () => {
    expect(resolveConflictCount(0)).toBe(0);
    expect(resolveConflictCount(1)).toBe(1);
    expect(resolveConflictCount(3)).toBe(1);
    expect(resolveConflictCount(4)).toBe(2);
  });
});

describe("conflict resolution state", () => {
  it("treats zero markers or an explicit side as resolved", () => {
    expect(
      isConflictResolved({ path: "text.ts", kind: "text", markerCount: 0, resolution: null }),
    ).toBe(true);
    expect(
      isConflictResolved({ path: "asset.bin", kind: "binary", markerCount: 1, resolution: "ours" }),
    ).toBe(true);
    expect(
      isConflictResolved({ path: "asset.bin", kind: "binary", markerCount: 0, resolution: null }),
    ).toBe(false);
    expect(
      isConflictResolved({ path: "text.ts", kind: "text", markerCount: 1, resolution: null }),
    ).toBe(false);
  });

  it("detects any path that still reports raw conflict markers", () => {
    expect(
      hasLiveConflictMarkers([
        { path: "clean.ts", kind: "text", markerCount: 0, resolution: null },
        { path: "live.ts", kind: "text", markerCount: 2, resolution: null },
      ]),
    ).toBe(true);
    expect(
      hasLiveConflictMarkers([
        { path: "clean.ts", kind: "text", markerCount: 0, resolution: null },
      ]),
    ).toBe(false);
  });
});

describe("GitManagerConflictList", () => {
  it("renders accessible resolution and undo actions with the verbatim Continue block", async () => {
    const onResolve = vi.fn();
    const onUndoResolve = vi.fn();
    const blocked = {
      operation: "continue",
      code: "merge-in-progress",
      message: "Server says every conflicted path must be staged.",
    } as const;

    await act(async () =>
      root.render(
        createElement(GitManagerConflictList, {
          conflicts: [
            { path: "resolved.ts", kind: "text", markerCount: 0, resolution: null },
            { path: "asset.bin", kind: "binary", markerCount: 0, resolution: null },
            { path: "vendor/lib", kind: "submodule", markerCount: 0, resolution: null },
          ],
          continueBlocked: blocked,
          onResolve,
          onUndoResolve,
        }),
      ),
    );

    const actions = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(actions.every((action) => Boolean(action.getAttribute("aria-label")))).toBe(true);
    expect(container.textContent).toContain("Resolved");
    expect(
      container.querySelector('[aria-label="Undo resolution for resolved.ts"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Resolve asset.bin with ours"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Resolve asset.bin with theirs"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Resolve vendor/lib with ours"]')).not.toBeNull();

    const continueButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Continue operation"]',
    );
    expect(continueButton).toMatchObject({ disabled: true, title: blocked.message });
    expect(continueButton?.getAttribute("aria-describedby")).toBe(
      "git-manager-conflicts-continue-reason",
    );
    expect(container.textContent).toContain(blocked.message);

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Resolve asset.bin with ours"]')
        ?.click(),
    );
    expect(onResolve).toHaveBeenCalledWith("asset.bin", "ours");
  });

  it("warns before committing files that still contain conflict markers", async () => {
    const onCommit = vi.fn();
    await act(async () =>
      root.render(
        createElement(GitManagerConflictList, {
          conflicts: [{ path: "src/live.ts", kind: "text", markerCount: 3, resolution: null }],
          continueBlocked: null,
          onCommit,
          onResolve: () => undefined,
          onUndoResolve: () => undefined,
        }),
      ),
    );

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Commit resolved files"]')?.click(),
    );
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Commit files with conflict markers?");

    await act(async () =>
      [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Commit Anyway")
        ?.click(),
    );
    expect(onCommit).toHaveBeenCalledOnce();
  });
});
