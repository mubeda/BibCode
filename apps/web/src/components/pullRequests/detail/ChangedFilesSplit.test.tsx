// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChangedFilesSplit } from "./ChangedFilesSplit";

const STORAGE_KEY = "bibcode:changed-files-nav-width";
let root: Root;
let container: HTMLDivElement;
let resize: ((width: number) => void) | null;

async function render() {
  await act(async () => root.render(<ChangedFilesSplit tree={<p>tree</p>} files={<p>files</p>} />));
}
const nav = () => container.querySelector<HTMLElement>('nav[aria-label="Changed files"]')!;
const divider = () => container.querySelector<HTMLElement>('[role="separator"]')!;
const navWidth = () => nav().style.getPropertyValue("--changed-files-nav-width");
const stored = () => localStorage.getItem(STORAGE_KEY);
async function press(key: string) {
  await act(async () => {
    divider().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}
async function pointer(type: string, clientX: number) {
  await act(async () => {
    divider().dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, clientX, pointerId: 1 }),
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resize = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = (width) =>
          callback(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  );
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ChangedFilesSplit", () => {
  it("sizes the file list through a width variable used only by the wide layout", async () => {
    await render();

    expect(nav().className).toContain("h-48");
    expect(nav().className).toContain("@3xl/pull-request:w-(--changed-files-nav-width)");
    expect(navWidth()).toBe("256px");
    expect(nav().style.width).toBe("");
    expect(nav().textContent).toBe("tree");
    expect(nav().parentElement!.className).toContain("@3xl/pull-request:flex-row");
    expect([...nav().parentElement!.children].map((child) => child.textContent)).toEqual([
      "tree",
      "",
      "files",
    ]);
  });

  it("offers a focusable divider only at the wide layout", async () => {
    await render();

    const classes = divider().className.split(" ");
    expect(classes).toContain("hidden");
    expect(classes).toContain("@3xl/pull-request:block");
    expect(divider().tabIndex).toBe(0);
    expect(divider().getAttribute("aria-controls")).toBe(nav().id);
    expect(divider().getAttribute("aria-orientation")).toBe("vertical");
    expect(divider().getAttribute("aria-valuemin")).toBe("224");
    expect(divider().getAttribute("aria-valuemax")).toBe("720");
    expect(divider().getAttribute("aria-valuenow")).toBe("256");
  });

  it("restores the stored width", async () => {
    localStorage.setItem(STORAGE_KEY, "400");

    await render();

    expect(navWidth()).toBe("400px");
  });

  it("drags the divider and stores where the drag ends", async () => {
    await render();

    await pointer("pointerdown", 100);
    await pointer("pointermove", 180);
    await pointer("pointerup", 180);

    expect(navWidth()).toBe("336px");
    expect(stored()).toBe("336");
  });

  it("stores a drag that the minimum stops a pixel or two from where it started", async () => {
    localStorage.setItem(STORAGE_KEY, "226");
    await render();

    await pointer("pointerdown", 100);
    await pointer("pointermove", 0);
    await pointer("pointerup", 0);

    expect([navWidth(), stored()]).toEqual(["224px", "224"]);
  });

  it("keeps the stored width when the detail narrows during a press that does not move", async () => {
    localStorage.setItem(STORAGE_KEY, "600");
    await render();

    await pointer("pointerdown", 100);
    await act(async () => resize!(700));
    await pointer("pointerup", 100);

    expect([navWidth(), stored()]).toEqual(["316px", "600"]);
    await act(async () => resize!(1400));
    expect(navWidth()).toBe("600px");
  });

  it("nudges, jumps, and resets the width from the keyboard and double-click", async () => {
    await render();

    await press("ArrowRight");
    expect([navWidth(), stored()]).toEqual(["272px", "272"]);
    await press("ArrowLeft");
    expect([navWidth(), stored()]).toEqual(["256px", "256"]);
    await press("End");
    expect([navWidth(), stored()]).toEqual(["720px", "720"]);
    await press("Home");
    expect([navWidth(), stored()]).toEqual(["224px", "224"]);
    await act(async () => {
      divider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect([navWidth(), stored()]).toEqual(["256px", "256"]);
    await press("Tab");
    expect(stored()).toBe("256");
  });

  it("clamps the width to the detail's live width without overwriting the stored width", async () => {
    localStorage.setItem(STORAGE_KEY, "600");
    await render();

    await act(async () => resize!(700));

    expect(navWidth()).toBe("316px");
    expect(divider().getAttribute("aria-valuemax")).toBe("316");
    expect(stored()).toBe("600");

    await act(async () => resize!(1400));

    expect(navWidth()).toBe("600px");
    expect(divider().getAttribute("aria-valuemax")).toBe("720");
  });
});
