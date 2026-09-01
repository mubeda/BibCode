// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GitManagerImageDiff } from "./GitManagerImageDiff";

const before = "data:image/png;base64,iVBORw0KGgo=";
const after = "data:image/png;base64,YWZ0ZXI=";
const noop = () => undefined;

let container: HTMLDivElement;
let root: Root;

async function render(
  mode: React.ComponentProps<typeof GitManagerImageDiff>["mode"],
  beforeSrc: string | null = before,
) {
  await act(async () =>
    root.render(
      <GitManagerImageDiff before={beforeSrc} after={after} mode={mode} onModeChange={noop} />,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("GitManagerImageDiff", () => {
  it("renders all four labelled modes from data URIs without issuing a fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const mode of ["two-up", "swipe", "onion", "difference"] as const) {
      await render(mode);
      const images = [...container.querySelectorAll<HTMLImageElement>("img")];
      expect(images).toHaveLength(2);
      expect(images.every((image) => image.src.startsWith("data:image/png;base64,"))).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const label of ["2-up", "Swipe", "Onion-skin", "Difference"]) {
      expect(
        [...container.querySelectorAll("button")].some((button) => button.textContent === label),
      ).toBe(true);
    }
  });

  it("renders a one-sided added image without a broken before image", async () => {
    await render("two-up", null);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.textContent).toContain("Before image unavailable");
  });

  it("offers keyboard-operable swipe and onion controls and reports mode changes", async () => {
    const onModeChange = vi.fn();
    await act(async () =>
      root.render(
        <GitManagerImageDiff
          before={before}
          after={after}
          mode="swipe"
          onModeChange={onModeChange}
        />,
      ),
    );
    expect(
      container.querySelector('input[type="range"][aria-label="Swipe position"]'),
    ).not.toBeNull();
    const difference = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Difference",
    );
    await act(async () => difference?.click());
    expect(onModeChange).toHaveBeenCalledWith("difference");
  });

  it("rejects non-data image sources instead of contacting a host", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await render("two-up", "https://example.test/image.png");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.textContent).toContain("Before image unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
