// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { GitManagerChangesSplit, GitManagerCommitPane } from "./GitManagerChangesPanes";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

const separator = (name: string) =>
  container.querySelector<HTMLElement>(`[role="separator"][aria-label="${name}"]`)!;

async function key(element: HTMLElement, name: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

async function renderSplit(diff: boolean) {
  await act(async () =>
    root.render(
      <GitManagerChangesSplit
        diff={diff ? <p>diff</p> : null}
        list={<p>list</p>}
        onKeyDown={() => {}}
      />,
    ),
  );
}

describe("GitManagerChangesSplit", () => {
  it("has no divider while no diff is open", async () => {
    await renderSplit(false);

    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  it("resizes the list with the arrow keys, remembers it, and resets on double-click", async () => {
    await renderSplit(true);
    const handle = separator("Resize changed files list");
    const start = Number(handle.getAttribute("aria-valuenow"));

    await key(handle, "ArrowDown");
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(start + 16);
    await key(handle, "ArrowUp");
    await key(handle, "ArrowUp");
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(start - 16);
    expect(window.localStorage.getItem("bibcode:git-changes-list-height")).toBe(String(start - 16));

    await key(handle, "Home");
    expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemin"));
    await key(handle, "End");
    expect(handle.getAttribute("aria-valuenow")).toBe(handle.getAttribute("aria-valuemax"));

    await act(async () => {
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(start);
  });

  it("restores the remembered height on the next mount", async () => {
    window.localStorage.setItem("bibcode:git-changes-list-height", "320");

    await renderSplit(true);

    expect(separator("Resize changed files list").getAttribute("aria-valuenow")).toBe("320");
    expect(container.querySelector<HTMLElement>("p")!.parentElement!.style.flexBasis).toBe("320px");
  });
});

describe("GitManagerCommitPane", () => {
  it("grows the form with Up and caps its height", async () => {
    await act(async () =>
      root.render(
        <GitManagerCommitPane>
          <p>form</p>
        </GitManagerCommitPane>,
      ),
    );
    const handle = separator("Resize commit form");
    const start = Number(handle.getAttribute("aria-valuenow"));

    await key(handle, "ArrowUp");

    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(start + 16);
    expect(document.getElementById(handle.getAttribute("aria-controls")!)!.style.maxHeight).toBe(
      `${start + 16}px`,
    );
  });
});
