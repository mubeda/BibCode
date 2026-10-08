// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SourceControlMergeChanges } from "./SourceControlMergeChanges";

const CONFLICTED = {
  path: "src/a.txt",
  insertions: 0,
  deletions: 0,
  status: "conflicted",
  area: "unstaged",
} as const;

let container: HTMLDivElement;
let root: Root | null;

function buttonLabelled(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

describe("SourceControlMergeChanges", () => {
  it("resolves a conflicted file with ours or theirs and opens it in the editor", async () => {
    const onResolve = vi.fn();
    const onOpenInEditor = vi.fn();
    const onMarkResolved = vi.fn();
    await act(async () =>
      root?.render(
        <SourceControlMergeChanges
          disabled={false}
          files={[CONFLICTED]}
          onMarkResolved={onMarkResolved}
          onOpenInEditor={onOpenInEditor}
          onResolve={onResolve}
        />,
      ),
    );

    expect(container.textContent).toContain("Merge Changes");
    expect(container.textContent).toContain("src/a.txt");
    await act(async () => buttonLabelled("Keep ours for src/a.txt").click());
    await act(async () => buttonLabelled("Take theirs for src/a.txt").click());
    await act(async () => buttonLabelled("Open src/a.txt in editor").click());
    expect(onResolve.mock.calls).toEqual([
      ["src/a.txt", "ours"],
      ["src/a.txt", "theirs"],
    ]);
    expect(onOpenInEditor).toHaveBeenCalledWith("src/a.txt");
    await act(async () => buttonLabelled("Mark src/a.txt resolved").click());
    expect(onMarkResolved).toHaveBeenCalledWith("src/a.txt");
  });

  it("disables resolving while busy but keeps the file openable", async () => {
    await act(async () =>
      root?.render(
        <SourceControlMergeChanges
          disabled
          files={[CONFLICTED]}
          onMarkResolved={vi.fn()}
          onOpenInEditor={vi.fn()}
          onResolve={vi.fn()}
        />,
      ),
    );

    expect(buttonLabelled("Keep ours for src/a.txt").disabled).toBe(true);
    expect(buttonLabelled("Take theirs for src/a.txt").disabled).toBe(true);
    expect(buttonLabelled("Mark src/a.txt resolved").disabled).toBe(true);
    expect(buttonLabelled("Open src/a.txt in editor").disabled).toBe(false);
  });
});
