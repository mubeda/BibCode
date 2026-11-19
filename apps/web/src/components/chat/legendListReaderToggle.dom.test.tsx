// @vitest-environment happy-dom

import * as esm from "@legendapp/list/react";
import type { LegendListRef } from "@legendapp/list/react";
import * as NodeModule from "node:module";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

/**
 * The patched LegendList in both bundle formats, as the timeline uses it: it keeps the content
 * position, and a data change locks its anchor for 300 ms. A row the reader toggles must keep
 * its place even when that lock holds a row below it. happy-dom lays nothing out, so each row
 * measures the height the test gives it and the viewport VIEWPORT_HEIGHT; a row's place in the
 * view is its list position minus the list's scroll.
 */
const formats = {
  esm: esm.LegendList,
  cjs: (NodeModule.createRequire(import.meta.url)("@legendapp/list/react") as typeof esm)
    .LegendList,
};

type ReaderToggleList = LegendListRef & { holdAnchorAboveRow?: (key: string) => void };

const ROW_HEIGHT = 30;
const VIEWPORT_HEIGHT = 300;
const GROWTH = 182;
const SLACK_PX = 2;
const heights = new Map<string, number>();

interface Row {
  readonly id: string;
  readonly version: number;
}

/** Rows above the toggled one, the toggled row `t`, then the answer's rows. */
function rows(versions: Readonly<Record<string, number>> = {}, extra = 0): Row[] {
  const ids = [
    ...Array.from({ length: 6 }, (_, index) => `above-${index}`),
    "t",
    ...Array.from({ length: 30 + extra }, (_, index) => `answer-${index}`),
  ];
  return ids.map((id) => ({ id, version: versions[id] ?? 0 }));
}

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

function measuredHeight(element: HTMLElement): number {
  const own = element.dataset.testRow;
  if (own !== undefined) return heights.get(own) ?? ROW_HEIGHT;
  const inner = element.querySelectorAll<HTMLElement>("[data-test-row]");
  if (inner.length === 1) return heights.get(inner[0]!.dataset.testRow!) ?? ROW_HEIGHT;
  return VIEWPORT_HEIGHT;
}

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

async function frame() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 16)));
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return DOMRect.fromRect({ width: 400, height: measuredHeight(this) });
  };
  heights.clear();
  observed.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe.each(Object.keys(formats) as Array<keyof typeof formats>)(
  "patched LegendList (%s) with a row the reader toggles",
  (format) => {
    const LegendList = formats[format];
    const list = createRef<ReaderToggleList>();

    async function render(data: readonly Row[]) {
      await act(async () =>
        root.render(
          <LegendList<Row>
            ref={list}
            data={data}
            estimatedItemSize={ROW_HEIGHT}
            keyExtractor={(row) => row.id}
            // The timeline's own setting outside a key scroll (resolveTimelineMaintainVisibleContentPosition).
            maintainVisibleContentPosition={{ data: true, size: true }}
            renderItem={({ item }) => (
              <div data-test-row={item.id}>
                {item.id} {item.version}
              </div>
            )}
            style={{ height: VIEWPORT_HEIGHT }}
          />,
        ),
      );
    }

    const state = () => list.current!.getState();
    const indexOf = (id: string) => state().data.findIndex((row) => (row as Row).id === id);
    /** Where the row's top sits in the view: its list position minus the list's scroll. */
    const viewTop = (id: string) => state().positionAtIndex(indexOf(id)) - state().scroll;

    async function settle(count = 4) {
      for (let index = 0; index < count; index += 1) {
        await frame();
        await act(async () => reportResizes());
      }
    }

    /**
     * The scroll event a browser sends once the scroller is at `offset`. happy-dom has no scroll
     * extent, and the list ignores a scroll of an empty content box.
     */
    async function nativeScroll(offset: number) {
      const scroller = [...container.querySelectorAll<HTMLElement>("div")].find((element) =>
        /auto|scroll/.test(element.style.overflowY || element.style.overflow),
      )!;
      const extent = { configurable: true, get: () => state().contentLength };
      Object.defineProperties(HTMLElement.prototype, { scrollHeight: extent, scrollWidth: extent });
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        writable: true,
        value: offset,
      });
      try {
        await act(async () => {
          scroller.dispatchEvent(new Event("scroll"));
        });
      } finally {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
        Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
      }
    }

    /** The answer's rows on screen, and a data change that locks the anchor on one of them. */
    async function lockAnswerAnchor(versions: Record<string, number>) {
      await render(rows(versions));
      await settle();
      // The reader scrolls to the answer.
      await nativeScroll(state().positionAtIndex(indexOf("answer-0")));
      await settle();
      versions["answer-0"] = (versions["answer-0"] ?? 0) + 1;
      await render(rows(versions));
      await frame();
      // The list's own scroll, which no reader made, brings the toggled row into view.
      const offset = state().positionAtIndex(indexOf("above-2"));
      await act(async () => {
        void list.current!.scrollToOffset({ offset, animated: false });
      });
      await nativeScroll(offset);
      await frame();
    }

    /** The reader's toggle: the row object is replaced under its key, then its new size lands. */
    async function toggle(
      versions: Record<string, number>,
      height: number,
      beforeMeasure?: () => Promise<void>,
    ) {
      list.current!.holdAnchorAboveRow?.("t");
      versions.t = (versions.t ?? 0) + 1;
      await render(rows(versions));
      if (beforeMeasure) await beforeMeasure();
      heights.set("t", height);
      const tops: number[] = [];
      for (let index = 0; index < 6; index += 1) {
        await frame();
        await act(async () => reportResizes());
        tops.push(viewTop("t"));
      }
      return tops;
    }

    const moved = (tops: readonly number[], from: number) =>
      tops.filter((top) => Math.abs(top - from) > SLACK_PX);

    it("keeps the toggled row in place while a lock holds an answer row below it", async () => {
      const versions: Record<string, number> = {};
      await lockAnswerAnchor(versions);
      const before = viewTop("t");
      expect(before).toBeGreaterThanOrEqual(0);
      expect(before).toBeLessThan(VIEWPORT_HEIGHT);
      expect(moved(await toggle(versions, ROW_HEIGHT + GROWTH), before)).toEqual([]);
    });

    it("keeps it in place when a delivery lands between the toggle and its measure", async () => {
      const versions: Record<string, number> = {};
      await lockAnswerAnchor(versions);
      const before = viewTop("t");
      const tops = await toggle(versions, ROW_HEIGHT + GROWTH, async () => {
        versions["answer-1"] = (versions["answer-1"] ?? 0) + 1;
        await render(rows(versions, 1));
        await frame();
      });
      expect(moved(tops, before)).toEqual([]);
    });

    it("keeps it in place when it collapses from a nonzero offset", async () => {
      const versions: Record<string, number> = {};
      heights.set("t", ROW_HEIGHT + GROWTH);
      await lockAnswerAnchor(versions);
      const before = viewTop("t");
      expect(state().scroll).toBeGreaterThan(0);
      expect(moved(await toggle(versions, ROW_HEIGHT), before)).toEqual([]);
    });

    it("leaves an anchor above the toggled row in place", async () => {
      const versions: Record<string, number> = {};
      await render(rows(versions));
      await settle();
      await act(async () => {
        void list.current!.scrollToOffset({
          offset: indexOf("above-1") * ROW_HEIGHT,
          animated: false,
        });
      });
      await settle();
      // A lock on a row above the toggled one, which the toggle must not drop.
      versions["above-1"] = 1;
      await render(rows(versions));
      await frame();
      const anchorBefore = viewTop("above-1");
      const before = viewTop("t");
      const tops = await toggle(versions, ROW_HEIGHT + GROWTH);
      expect(moved(tops, before)).toEqual([]);
      expect(Math.abs(viewTop("above-1") - anchorBefore)).toBeLessThanOrEqual(SLACK_PX);
    });
  },
);
