// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { useDocumentVisible } from "./useDocumentVisible";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function Probe() {
  return createElement("span", null, useDocumentVisible() ? "visible" : "hidden");
}

describe("useDocumentVisible", () => {
  let root: Root;
  let node: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    node = document.createElement("div");
    document.body.appendChild(node);
    root = createRoot(node);
  });
  afterEach(() => {
    act(() => root.unmount());
    node.remove();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  it("follows the document's visibility", () => {
    act(() => root.render(createElement(Probe)));
    expect(node.textContent).toBe("visible");
    act(() => setVisibility("hidden"));
    expect(node.textContent).toBe("hidden");
    act(() => setVisibility("visible"));
    expect(node.textContent).toBe("visible");
  });
});
