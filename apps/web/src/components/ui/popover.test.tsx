// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "./popover";

describe("Popover", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("reuses its portal across Escape dismissal", async () => {
    const handle = PopoverCreateHandle();

    await act(async () => {
      root.render(
        <Popover handle={handle}>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverPopup>
            <button type="button">Inside</button>
          </PopoverPopup>
        </Popover>,
      );
    });
    const portal = document.querySelector("[data-base-ui-portal]");
    expect(portal).not.toBeNull();

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(handle.isOpen).toBe(true);
    const inside = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Inside",
    ) as HTMLButtonElement;
    inside.focus();

    await act(async () => {
      inside.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
      );
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(handle.isOpen).toBe(false);
    expect(document.body.contains(portal)).toBe(true);
    expect(inside.closest('[data-slot="popover-positioner"]')?.hasAttribute("hidden")).toBe(true);

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(document.querySelector("[data-base-ui-portal]")).toBe(portal);
  });
});
