// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Execute the pinned SDK predicates against actual toast output and inert geometry ports.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  useParams: (input: { select: (params: object) => unknown }) => input.select({}),
}));
import { ToastProvider, toastManager } from "./toast";

it("preserves an ending close that the actual SDK displays but cannot interact with", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let finishAnimation: () => void = () => {};
  const animation = new Promise<void>((resolve) => {
    finishAnimation = resolve;
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const originalAnimations = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getAnimations",
  );
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [{ finished: animation, pending: true, playState: "running" }],
  });
  try {
    await act(async () => root.render(<ToastProvider timeout={0} />));
    let front = "";
    await act(async () => {
      toastManager.add({ title: "Owned live notification", type: "info", timeout: 0 });
      front = toastManager.add({ title: "Owned ending notification", type: "info", timeout: 0 });
    });
    await act(async () => toastManager.close(front));
    const closes = [
      ...document.querySelectorAll<HTMLButtonElement>('button[data-slot="toast-close"]'),
    ];
    const ending = closes.find((close) => close.closest("[data-ending-style]"));
    const live = closes.find((close) => !close.closest("[data-ending-style]"));
    expect(ending).toBeDefined();
    expect(live).toBeDefined();
    const endingRoot = ending!.closest<HTMLElement>("[data-position]")!;
    const liveRoot = live!.closest<HTMLElement>("[data-position]")!;
    expect(endingRoot.style.getPropertyValue("--toast-index")).toBe("0");
    expect(liveRoot.style.getPropertyValue("--toast-index")).toBe("0");
    expect(endingRoot.style.getPropertyValue("--toast-offset-y")).toBe("0px");
    expect(liveRoot.style.getPropertyValue("--toast-offset-y")).toBe("0px");
    expect(endingRoot.className).toContain("data-ending-style");

    const require = NodeModule.createRequire(
      new NodeURL.URL("../../../../desktop/package.json", import.meta.url),
    );
    const directory = NodePath.dirname(require.resolve("webdriverio"));
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(directory, "../package.json"), "utf8"),
    );
    expect(manifest.version).toBe("9.29.1");
    const source = NodeFS.readFileSync(NodePath.join(directory, "node.js"), "utf8");
    const cut = (first: string, last: string) => {
      const a = source.indexOf(first),
        b = source.indexOf(last, a);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a);
      return source.slice(a, b);
    };
    const script = NodeFS.readFileSync(
      NodePath.join(directory, "scripts/isElementClickable.js"),
      "utf8",
    );
    const clickable = NodeVM.runInNewContext(
      script.slice(0, script.indexOf("export {")) + "\nisElementClickable",
      { window, document },
    );
    // Mid-exit opacity remains positive; the fixed ending transform can already
    // put the control outside the viewport. Geometry/animation are inert ports,
    // not evidence that this layout occurred in the native failure.
    for (const close of closes) {
      const x = close === ending ? 1290 : 1200;
      const box = {
        left: x,
        top: 80,
        right: x + 24,
        bottom: 104,
        width: 24,
        height: 24,
        x,
        y: 80,
        toJSON: () => ({}),
      };
      close.getBoundingClientRect = () => box;
      close.getClientRects = () => [box] as unknown as DOMRectList;
      Object.defineProperty(close, "clientWidth", { configurable: true, value: 24 });
      Object.defineProperty(close, "clientHeight", { configurable: true, value: 24 });
      close.scrollIntoView = () => {};
      close.checkVisibility = () => true;
    }
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 960);
    const elementFromPoint = vi
      .spyOn(document, "elementFromPoint")
      .mockImplementation((x) => (x < 1280 ? live! : null));
    const browser = {
      isMobile: false,
      execute: async (
        fn: (...args: unknown[]) => unknown,
        argument: unknown,
        ...args: unknown[]
      ) => {
        const wire = argument as { node?: HTMLElement; ELEMENT?: string };
        const node = wire.node ?? (wire.ELEMENT === "ending" ? ending : live);
        return fn(node, ...args);
      },
    };
    const commands = NodeVM.runInNewContext(
      cut("async function isClickable()", "// src/commands/element/isDisplayed.ts") +
        cut("async function isDisplayed(commandParams", "// src/commands/element/isEnabled.ts") +
        "\n({isDisplayed,isClickable})",
      {
        window,
        document,
        getBrowserObject22: () => browser,
        getBrowserObject23: () => browser,
        hasElementId: async () => true,
        ELEMENT_KEY13: "element-6066-11e4-a52e-4f735466cecf",
        isElementClickableScript: clickable,
      },
    );
    const wire = (node: HTMLElement, elementId: string) => ({
      node,
      elementId,
      isMobile: false,
      isNativeContext: false,
      isDisplayed: () => commands.isDisplayed.call({ node, elementId }),
    });
    const endingWire = wire(ending!, "ending"),
      liveWire = wire(live!, "live");
    expect(await commands.isDisplayed.call(endingWire)).toBe(true);
    expect(await commands.isClickable.call(endingWire)).toBe(false);
    expect(await commands.isClickable.call(liveWire)).toBe(true);
    expect(elementFromPoint).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    finishAnimation();
    if (originalAnimations)
      Object.defineProperty(HTMLElement.prototype, "getAnimations", originalAnimations);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).getAnimations;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
