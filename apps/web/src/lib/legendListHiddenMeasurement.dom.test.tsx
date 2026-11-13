// @vitest-environment happy-dom

import * as esm from "@legendapp/list/react";
import type { LegendListRef } from "@legendapp/list/react";
import { createRequire } from "node:module";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

/**
 * The patched LegendList in both bundle formats, with a row that measures 0 by 0 under a hidden
 * ancestor as a browser reports it (#360). happy-dom lays nothing out, so each row measures the
 * height the test gives it and the list viewport 300 px.
 */
const formats = {
  esm: esm.LegendList,
  cjs: (createRequire(import.meta.url)("@legendapp/list/react") as typeof esm).LegendList,
};

const ROW_HEIGHT = 30;
const VIEWPORT_HEIGHT = 300;
const heights = new Map<string, number>();

interface Row {
  readonly id: string;
  readonly version: number;
}

function rows(count: number, version: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, version }));
}

function measuredHeight(element: HTMLElement): number {
  const own = element.dataset.testRow;
  if (own !== undefined) return heights.get(own) ?? ROW_HEIGHT;
  const inner = element.querySelectorAll<HTMLElement>("[data-test-row]");
  if (inner.length === 1) return heights.get(inner[0]!.dataset.testRow!) ?? ROW_HEIGHT;
  return VIEWPORT_HEIGHT;
}

/** Reports, like a browser after layout, each observed element whose box changed. */
const observed = new Map<Element, { callback: ResizeObserverCallback; last: string | null }>();
class ReportingResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    observed.set(target, { callback: this.callback, last: null });
  }
  unobserve(target: Element) {
    observed.delete(target);
  }
  disconnect() {
    for (const [target, entry] of observed) {
      if (entry.callback === this.callback) observed.delete(target);
    }
  }
}
globalThis.ResizeObserver = ReportingResizeObserver as unknown as typeof ResizeObserver;

function reportResizes() {
  const byCallback = new Map<ResizeObserverCallback, ResizeObserverEntry[]>();
  for (const [target, entry] of observed) {
    if (!target.isConnected) continue;
    const rect = target.getBoundingClientRect();
    const box = `${rect.width}x${rect.height}`;
    if (box === entry.last) continue;
    entry.last = box;
    const size = [{ blockSize: rect.height, inlineSize: rect.width }];
    const entries = byCallback.get(entry.callback) ?? [];
    entries.push({
      target,
      contentRect: rect,
      borderBoxSize: size,
      contentBoxSize: size,
      devicePixelContentBoxSize: size,
    } as unknown as ResizeObserverEntry);
    byCallback.set(entry.callback, entries);
  }
  for (const [callback, entries] of byCallback) callback(entries, {} as ResizeObserver);
}

async function frames() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

async function settle() {
  for (let frame = 0; frame < 5; frame += 1) {
    await frames();
    await act(async () => reportResizes());
  }
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalStackTraceLimit = Error.stackTraceLimit;
let container: HTMLDivElement;
let root: Root;
let uncaught: unknown[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Error.stackTraceLimit = 50;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.closest("[hidden]") !== null) return DOMRect.fromRect({ width: 0, height: 0 });
    return DOMRect.fromRect({ width: 400, height: measuredHeight(this) });
  };
  heights.clear();
  observed.clear();
  uncaught = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container, { onUncaughtError: (error) => uncaught.push(error) });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  Error.stackTraceLimit = originalStackTraceLimit;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe.each(Object.keys(formats) as Array<keyof typeof formats>)(
  "patched LegendList (%s) under a hidden ancestor (#360)",
  (format) => {
    const LegendList = formats[format];
    const list = createRef<LegendListRef>();
    const wrapper = createRef<HTMLDivElement>();
    const thrown: unknown[] = [];

    async function render(data: readonly Row[], hidden: boolean) {
      try {
        await act(async () =>
          root.render(
            <div hidden={hidden} ref={wrapper}>
              <LegendList<Row>
                ref={list}
                data={data}
                estimatedItemSize={ROW_HEIGHT}
                keyExtractor={(row) => row.id}
                renderItem={({ item }) => (
                  <div data-test-row={item.id}>
                    {item.id} {item.version}
                  </div>
                )}
                style={{ height: VIEWPORT_HEIGHT }}
              />
            </div>,
          ),
        );
        await settle();
      } catch (error) {
        thrown.push(error);
      }
    }

    const errors = () => [...thrown.splice(0), ...uncaught].map(String);
    const state = () => list.current!.getState();
    const renderedRows = () => document.querySelectorAll("[data-test-row]").length;
    /**
     * The list defers a shrink only after it has seen a scroll since its data changed; a person
     * scrolling the list is the case where a deferred shrink can be pending.
     */
    async function scrollBy(offset: number) {
      const scroller = [...wrapper.current!.querySelectorAll<HTMLElement>("div")].find((element) =>
        /auto|scroll/.test(element.style.overflowY || element.style.overflow),
      )!;
      // happy-dom has no scroll extent, and the list ignores a scroll of an empty content box.
      const extent = { configurable: true, get: () => state().contentLength };
      Object.defineProperties(HTMLElement.prototype, { scrollHeight: extent, scrollWidth: extent });
      Object.defineProperty(scroller, "scrollTop", { configurable: true, value: offset });
      try {
        await act(async () => {
          scroller.dispatchEvent(new Event("scroll"));
        });
        await settle();
      } finally {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
        Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
      }
    }

    it("keeps its sizes and range when its data changes while hidden, and measures again when shown", async () => {
      await render(rows(2_000, 1), false);
      const contentLength = state().contentLength;
      const rowsWhileVisible = renderedRows();
      expect(contentLength).toBe(2_000 * ROW_HEIGHT);
      expect(state().sizeAtIndex(0)).toBe(ROW_HEIGHT);

      await render(rows(2_000, 1), true);
      await render(rows(2_000, 2), true);

      expect(errors()).toEqual([]);
      expect(state().contentLength).toBe(contentLength);
      expect(state().sizeAtIndex(0)).toBe(ROW_HEIGHT);
      expect(renderedRows()).toBeLessThanOrEqual(rowsWhileVisible);

      heights.set("row-0", 45);
      await render(rows(2_000, 2), false);

      expect(errors()).toEqual([]);
      expect(state().sizeAtIndex(0)).toBe(45);
      expect(state().contentLength).toBeGreaterThan(contentLength);
      expect(document.body.textContent).toContain("row-0 2");
    });

    it("does not record a deferred shrink that is confirmed after the list was hidden", async () => {
      await render(rows(50, 1), false);
      expect(state().sizeAtIndex(0)).toBe(ROW_HEIGHT);

      await scrollBy(1);
      // The row shrinks, so the list waits a frame to confirm it, and the popup closes first.
      heights.set("row-0", 20);
      await act(async () => {
        reportResizes();
        expect(state().sizeAtIndex(0)).toBe(ROW_HEIGHT);
        wrapper.current!.hidden = true;
      });
      await settle();

      expect(errors()).toEqual([]);
      expect(state().sizeAtIndex(0)).toBe(ROW_HEIGHT);

      await act(async () => {
        wrapper.current!.hidden = false;
      });
      await settle();
      expect(state().sizeAtIndex(0)).toBe(20);
    });

    it.each([
      ["at once", false],
      ["after the deferred confirmation", true],
    ])("accepts a row that really shrinks while visible, %s", async (_name, afterScroll) => {
      await render(rows(50, 1), false);
      expect(state().sizeAtIndex(0)).toBe(ROW_HEIGHT);
      if (afterScroll) await scrollBy(1);

      heights.set("row-0", 20);
      await settle();

      expect(errors()).toEqual([]);
      expect(state().sizeAtIndex(0)).toBe(20);
      expect(state().contentLength).toBeLessThan(50 * ROW_HEIGHT);
    });
  },
);
