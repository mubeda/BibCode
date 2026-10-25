// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { describeThreadFindStatus, ThreadFindBar } from "./ThreadFindBar";
import type { ThreadFindStatus } from "./useThreadFind";

const roots: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

function controllerWith(status: ThreadFindStatus) {
  return {
    status,
    close: vi.fn(),
    setQuery: vi.fn(),
    submit: vi.fn(),
    step: vi.fn(),
  };
}

async function renderBar(controller: ReturnType<typeof controllerWith>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () =>
    root.render(
      <ThreadFindBar
        query="needle"
        status={controller.status}
        attachInput={() => {}}
        onQueryChange={controller.setQuery}
        onSubmit={controller.submit}
        onStep={controller.step}
        onClose={controller.close}
      />,
    ),
  );
  return container;
}

async function keydown(target: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

const MATCH: ThreadFindStatus = { kind: "match", position: 3, total: 17, stale: false };

describe("ThreadFindBar", () => {
  it("steps with Enter and Shift+Enter, Mod+G, Mod+Shift+G, F3 and Shift+F3", async () => {
    const controller = controllerWith(MATCH);
    const container = await renderBar(controller);
    const input = container.querySelector("input")!;
    const mod = navigator.platform.toLowerCase().includes("mac")
      ? { metaKey: true }
      : { ctrlKey: true };

    await keydown(input, "Enter");
    await keydown(input, "Enter", { shiftKey: true });
    expect(controller.submit).toHaveBeenNthCalledWith(1, "next");
    expect(controller.submit).toHaveBeenNthCalledWith(2, "previous");

    await keydown(input, "g", mod);
    await keydown(input, "G", { ...mod, shiftKey: true });
    await keydown(input, "F3");
    await keydown(input, "F3", { shiftKey: true });
    expect(vi.mocked(controller.step).mock.calls).toEqual([
      ["next"],
      ["previous"],
      ["next"],
      ["previous"],
    ]);
  });

  it("closes on Escape from the input or a button", async () => {
    const controller = controllerWith(MATCH);
    const container = await renderBar(controller);
    await keydown(container.querySelector("input")!, "Escape");
    await keydown(container.querySelector('button[aria-label="Next match"]')!, "Escape");
    expect(controller.close).toHaveBeenCalledTimes(2);
  });

  it("does nothing while an input method composes", async () => {
    const controller = controllerWith(MATCH);
    const container = await renderBar(controller);
    await keydown(container.querySelector("input")!, "Enter", {
      isComposing: true,
    } as KeyboardEventInit);
    expect(controller.submit).not.toHaveBeenCalled();
  });

  it("shows the count with an accessible name, and limits the query to 256 units", async () => {
    const container = await renderBar(controllerWith(MATCH));
    expect(container.textContent).toContain("3/17");
    expect(describeThreadFindStatus(MATCH).announcement).toBe("3 of 17 matches");
    const input = container.querySelector("input")!;
    expect(input.maxLength).toBe(256);
    expect(input.getAttribute("placeholder")).toBe("Find in thread");
    expect(container.querySelector('[role="search"]')?.getAttribute("aria-label")).toBe(
      "Find in thread",
    );
    for (const label of ["Previous match", "Next match", "Close"]) {
      expect(container.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    }
  });

  it("disables Previous and Next with no results and says why beside them", async () => {
    const container = await renderBar(controllerWith({ kind: "none", stale: false }));
    expect(container.textContent).toContain("No results in messages, plans, or commands");
    const previous = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Previous match"]',
    );
    const next = container.querySelector<HTMLButtonElement>('button[aria-label="Next match"]');
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(true);
  });

  it.each([
    [{ kind: "loading" }, "Loading thread…"],
    [{ kind: "unavailable" }, "This thread could not be loaded"],
    [{ kind: "searching" }, "Searching…"],
    [
      { kind: "none", stale: true },
      "No results in messages, plans, or commands · may be out of date",
    ],
    [{ kind: "match", position: 1, total: 2, stale: true }, "May be out of date"],
  ] as const)("shows the %o status", async (status, text) => {
    const container = await renderBar(controllerWith(status));
    expect(container.textContent).toContain(text);
  });
});
