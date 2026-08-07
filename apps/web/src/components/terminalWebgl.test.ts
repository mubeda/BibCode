import { describe, expect, it, vi } from "vite-plus/test";

const WebglAddon = vi.hoisted(
  () =>
    class WebglAddon {
      readonly kind = "webgl";
    },
);

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon }));

import {
  loadTerminalWebglAddon,
  resizeWebglCanvasBackingStore,
  webglCanvasFrom,
  webglContextFrom,
  type WebglAddonInstance,
} from "./terminalWebgl";

/** Stands in for the addon's private `_renderer._gl` handle. */
function addonWithContext(context: unknown): WebglAddonInstance {
  return { _renderer: { _gl: context } } as unknown as WebglAddonInstance;
}

it("lazily resolves the installed WebGL addon module", async () => {
  const module = await loadTerminalWebglAddon();

  expect(module.WebglAddon).toBe(WebglAddon);
});

describe("webglContextFrom", () => {
  it("reads the renderer's context when the addon is activated", () => {
    const context = { canvas: null };

    expect(webglContextFrom(addonWithContext(context))).toBe(context);
  });

  it("returns undefined before activation and when the private shape moves", () => {
    expect(webglContextFrom({} as WebglAddonInstance)).toBeUndefined();
    expect(webglContextFrom({ _renderer: {} } as unknown as WebglAddonInstance)).toBeUndefined();
  });

  it("survives a throwing accessor rather than breaking the terminal", () => {
    const addon = {
      get _renderer(): never {
        throw new Error("renderer detached");
      },
    } as unknown as WebglAddonInstance;

    expect(webglContextFrom(addon)).toBeUndefined();
  });
});

describe("webglCanvasFrom", () => {
  it("returns the measurable canvas the context paints into", () => {
    const canvas = { getBoundingClientRect: () => ({ width: 10, height: 10 }) };

    expect(webglCanvasFrom(addonWithContext({ canvas }))).toBe(canvas);
  });

  it("rejects a canvas that cannot be measured against the layout", () => {
    // An OffscreenCanvas has no `getBoundingClientRect`, so there is no CSS box
    // to correct the backing store against.
    expect(webglCanvasFrom(addonWithContext({ canvas: { width: 10, height: 10 } }))).toBeNull();
    expect(webglCanvasFrom(addonWithContext({ canvas: null }))).toBeNull();
    expect(webglCanvasFrom({} as WebglAddonInstance)).toBeNull();
  });
});

describe("resizeWebglCanvasBackingStore", () => {
  it("restores the previous backing store when a renderer layer rejects the synchronized resize", () => {
    const canvas = { width: 1215, height: 600 };
    const addon = {
      _renderer: {
        _gl: { canvas },
        _rectangleRenderer: { value: { handleResize: () => undefined } },
        _glyphRenderer: {
          value: {
            handleResize: () => {
              throw new Error("renderer detached");
            },
          },
        },
      },
    } as unknown as WebglAddonInstance;

    expect(resizeWebglCanvasBackingStore(addon, 1216, 600)).toBe(false);
    expect(canvas).toEqual({ width: 1215, height: 600 });
  });
});
