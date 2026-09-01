// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GitManagerDiscardDialog } from "./GitManagerDiscardDialog";

let container: HTMLDivElement;
let root: Root | null;

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
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

describe("GitManagerDiscardDialog", () => {
  it("lists at most 10 paths and reports the remaining count", async () => {
    const paths = Array.from({ length: 12 }, (_, index) => `src/file-${index + 1}.ts`);
    await act(async () =>
      root?.render(
        <GitManagerDiscardDialog
          disposition="trash"
          isBusy={false}
          open
          paths={paths}
          onConfirm={() => Promise.resolve()}
          onOpenChange={() => undefined}
        />,
      ),
    );

    expect(document.body.textContent).toContain("src/file-10.ts");
    expect(document.body.textContent).not.toContain("src/file-11.ts");
    expect(document.body.textContent).toContain("and 2 more");
    expect(document.body.textContent).toContain("OS trash");
  });

  it("runs confirm and keeps cancel free of mutations", async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    const onOpenChange = vi.fn();
    await act(async () =>
      root?.render(
        <GitManagerDiscardDialog
          disposition="permanent"
          isBusy={false}
          open
          paths={["src/file.ts"]}
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />,
      ),
    );

    await act(async () => buttonWithText("Cancel").click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();

    await act(async () => buttonWithText("Discard Permanently").click());
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  });
});
