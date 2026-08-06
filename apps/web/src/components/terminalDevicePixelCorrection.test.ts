import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { observeCanvasDevicePixelSize } from "./terminalDevicePixelCorrection";

let resizeObservers: FakeResizeObserver[];

class FakeResizeObserver {
  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  /** Drives the callback the way a layout change would. */
  emit(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

/**
 * xterm sizes the canvas backing store from its own cell math and the CSS box
 * from `Math.round(device / dpr)`, so the two can disagree by a fraction of a
 * device pixel. `cssWidth`/`cssHeight` stand in for the box the browser
 * actually laid out.
 */
function fakeCanvas(input: {
  readonly backingWidth: number;
  readonly backingHeight: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
}): HTMLCanvasElement {
  const canvas = {
    width: input.backingWidth,
    height: input.backingHeight,
    getBoundingClientRect: () => ({ width: input.cssWidth, height: input.cssHeight }),
  };
  return canvas as unknown as HTMLCanvasElement;
}

function stubNativeDevicePixelSupport(supported: boolean): void {
  const prototype = supported ? { devicePixelContentBoxSize: [] } : {};
  vi.stubGlobal("ResizeObserverEntry", { prototype });
}

beforeEach(() => {
  resizeObservers = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("devicePixelRatio", 2);
});

describe("observeCanvasDevicePixelSize", () => {
  it("snaps the backing store to the exact device-pixel box when WebKit drops the native path", () => {
    stubNativeDevicePixelSupport(false);
    // 607.5 CSS px at dpr 2 is 1215 device px, but xterm rounded the CSS box to
    // 608 and left the backing store at 1215 — a 1px rescale of every glyph.
    const canvas = fakeCanvas({
      backingWidth: 1215,
      backingHeight: 600,
      cssWidth: 608,
      cssHeight: 300,
    });
    const requestRedraw = vi.fn();

    const disposable = observeCanvasDevicePixelSize(canvas, requestRedraw);
    resizeObservers[0]?.emit();

    expect(canvas.width).toBe(1216);
    expect(canvas.height).toBe(600);
    expect(requestRedraw).toHaveBeenCalledTimes(1);

    disposable.dispose();
    expect(resizeObservers[0]?.disconnected).toBe(true);
  });

  it("stays inert where the browser implements device-pixel-content-box", () => {
    stubNativeDevicePixelSupport(true);
    const canvas = fakeCanvas({
      backingWidth: 1215,
      backingHeight: 600,
      cssWidth: 608,
      cssHeight: 300,
    });
    const requestRedraw = vi.fn();

    observeCanvasDevicePixelSize(canvas, requestRedraw).dispose();

    expect(resizeObservers).toHaveLength(0);
    expect(canvas.width).toBe(1215);
    expect(requestRedraw).not.toHaveBeenCalled();
  });

  it("leaves an already-exact backing store alone so it never redraws in a loop", () => {
    stubNativeDevicePixelSupport(false);
    const canvas = fakeCanvas({
      backingWidth: 1216,
      backingHeight: 600,
      cssWidth: 608,
      cssHeight: 300,
    });
    const requestRedraw = vi.fn();

    observeCanvasDevicePixelSize(canvas, requestRedraw);
    resizeObservers[0]?.emit();
    resizeObservers[0]?.emit();

    expect(canvas.width).toBe(1216);
    expect(requestRedraw).not.toHaveBeenCalled();
  });

  it("ignores a hidden canvas rather than collapsing it to zero", () => {
    stubNativeDevicePixelSupport(false);
    const canvas = fakeCanvas({
      backingWidth: 1216,
      backingHeight: 600,
      cssWidth: 0,
      cssHeight: 0,
    });
    const requestRedraw = vi.fn();

    observeCanvasDevicePixelSize(canvas, requestRedraw);
    resizeObservers[0]?.emit();

    expect(canvas.width).toBe(1216);
    expect(canvas.height).toBe(600);
    expect(requestRedraw).not.toHaveBeenCalled();
  });
});
