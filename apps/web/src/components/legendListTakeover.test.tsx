// Drives the patched LegendList itself (patches/@legendapp__list@3.3.10.patch), not a fake:
// `cancelScrollRequests()` stops a glide and commits the adjustment it held for rows that
// resized during it, and the content must stay where the reader saw it (#214).
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

const VIEW_HEIGHT = 500;
const ROW_HEIGHT = 100;
/** The glide's target: the end of 20 rows in a 500 px view. */
const GLIDE_TARGET = 1_500;
/** Where the scroller was, as the page saw it, when the key landed. */
const KEY_SCROLL = 1_480;
/** The adjustment LegendList held during the glide, here for a bottom inset that grew. */
const HELD = 160;

let domWindow: Window | null = null;
let root: Root | null = null;
// LegendList keeps one observer for the module's lifetime, so the observers outlive each test.
const observers: Array<{ targets: Set<Element>; callback: (entries: unknown[]) => void }> = [];
let heights = new Map<Element, number>();

/** The element grows or shrinks to `height`, and the observers watching it report it. */
function resize(element: Element, height: number) {
  heights.set(element, height);
  const entry = {
    target: element,
    borderBoxSize: [{ blockSize: height, inlineSize: 800 }],
    contentRect: { top: 0, left: 0, width: 800, height },
  };
  for (const observer of observers) {
    if (observer.targets.has(element)) observer.callback([entry]);
  }
}

beforeEach(() => {
  domWindow = new Window({ url: "https://bibcode.test/" });
  const globals = {
    window: domWindow,
    document: domWindow.document,
    navigator: domWindow.navigator,
    Node: domWindow.Node,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    Event: domWindow.Event,
    requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
    cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
    // Each observer reports a size only when a test resizes an element it observes.
    ResizeObserver: class {
      readonly targets = new Set<Element>();
      constructor(readonly callback: (entries: unknown[]) => void) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  // happy-dom lays nothing out: the scroller is the view's height and every row a row's height.
  vi.spyOn(domWindow.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = heights.get(this) ?? (this.style.overflow === "auto" ? VIEW_HEIGHT : ROW_HEIGHT);
    return new domWindow!.DOMRect(0, 0, 800, height);
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  heights = new Map();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await domWindow?.happyDOM.abort();
  domWindow = null;
});

async function frames(count = 3) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => domWindow!.setTimeout(resolve, 0));
    });
  }
}

/** A list of 20 rows in a 500 px view, scrolled to 1200 px, as the patched LegendList draws it. */
async function mountList() {
  const { LegendList } = await import("@legendapp/list/react");
  const ref = createRef<LegendListRef>();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = ({ rows = 20, endInset = 0 }: { rows?: number; endInset?: number } = {}) =>
    act(async () => {
      root!.render(
        <LegendList
          ref={ref}
          data={Array.from({ length: rows }, (_, index) => ({ id: `row-${index}` }))}
          keyExtractor={(item) => item.id}
          estimatedItemSize={ROW_HEIGHT}
          recycleItems={false}
          maintainVisibleContentPosition
          contentInsetEndAdjustment={endInset}
          style={{ height: VIEW_HEIGHT }}
          renderItem={({ item }) => <div>{item.id}</div>}
        />,
      );
    });
  await render();
  await frames();
  const list = ref.current!;
  const scroller = list.getScrollableNode() as unknown as HTMLElement;
  const contentHeight = () => list.getState().contentLength + 400;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEW_HEIGHT });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: contentHeight });
  const content = scroller.firstElementChild as HTMLElement;
  Object.defineProperty(content, "scrollHeight", { configurable: true, get: contentHeight });
  Object.defineProperty(content, "scrollWidth", { configurable: true, get: () => 800 });
  const browserScrolls = (top: number) => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event("scroll"));
  };
  browserScrolls(1_200);
  await frames();
  return { list, scroller, render, browserScrolls };
}

/**
 * The list gliding to its end when a key takes it over: the browser runs the glide itself (a
 * smooth scroll it does not finish here), and LegendList holds an adjustment for the bottom
 * inset that grew during it.
 */
async function glidingList() {
  const { list, scroller, render, browserScrolls } = await mountList();
  const writes: Array<ScrollToOptions> = [];
  const scrollTo = scroller.scrollTo.bind(scroller);
  scroller.scrollTo = ((options: ScrollToOptions) => {
    writes.push(options);
    if (options.behavior !== "smooth") scrollTo(options);
  }) as typeof scroller.scrollTo;
  void list.scrollToOffset({ offset: GLIDE_TARGET, animated: true });
  await frames(1);
  browserScrolls(KEY_SCROLL);
  await frames(1);
  await render({ endInset: HELD });
  expect(list.getState().scroll).toBe(KEY_SCROLL + HELD);
  expect(scroller.scrollTop).toBe(KEY_SCROLL);
  writes.length = 0;
  const cancelScrollRequests = (
    list as unknown as { cancelScrollRequests: (input?: { holdStop?: boolean }) => void }
  ).cancelScrollRequests;
  return { scroller, writes, browserScrolls, cancelScrollRequests };
}

describe("cancelScrollRequests during a glide", () => {
  it("commits the held adjustment as a scroll at the stop", async () => {
    const { scroller, cancelScrollRequests } = await glidingList();

    cancelScrollRequests({ holdStop: true });

    expect(scroller.scrollTop).toBe(KEY_SCROLL + HELD);
  });

  it("keeps a key's stop when the browser's glide moves the scroller after it", async () => {
    // WebKit runs the glide off the page's thread. On packaged macOS x64 a key landed while the
    // page still saw it 4-21 px short of its end, and the glide's last step then overwrote the
    // stop and the committed adjustment, while the rows had already dropped their offset: the
    // reader's line moved by the adjustment, 139-156 px (#214).
    const { scroller, writes, browserScrolls, cancelScrollRequests } = await glidingList();
    cancelScrollRequests({ holdStop: true });

    browserScrolls(GLIDE_TARGET);

    // Back at the stop in the same task, before the next frame paints.
    expect(scroller.scrollTop).toBe(KEY_SCROLL + HELD);
    expect(writes.at(-1)).toEqual({ behavior: "auto", top: KEY_SCROLL + HELD });
  });

  it("leaves the key's own scroll, and any after it, where the browser puts them", async () => {
    const { scroller, writes, browserScrolls, cancelScrollRequests } = await glidingList();
    cancelScrollRequests({ holdStop: true });
    const stopWrites = writes.length;

    // PageUp's scroll starts above the stop, off the glide's way.
    browserScrolls(1_100);
    // The stop holds once only: a later scroll back into the glide's path is the reader's.
    browserScrolls(GLIDE_TARGET);

    expect(scroller.scrollTop).toBe(GLIDE_TARGET);
    expect(writes.length).toBe(stopWrites);
  });

  it("does not hold the stop for a takeover whose own scroll starts at once", async () => {
    // A wheel or a press scrolls with the takeover, so the next scroll may be the reader's.
    const { scroller, writes, browserScrolls, cancelScrollRequests } = await glidingList();
    cancelScrollRequests();
    const stopWrites = writes.length;

    browserScrolls(GLIDE_TARGET);

    expect(scroller.scrollTop).toBe(GLIDE_TARGET);
    expect(writes.length).toBe(stopWrites);
  });
});

describe("scrollToOffset", () => {
  it("lands where the content it was asked for moved when a row above grew meanwhile", async () => {
    // ChatView asks for an offset from the list's metrics. On packaged macOS x64 a row above
    // grew 160 px before the request ran; LegendList held the content by scrolling 160 px, and
    // the request then scrolled to its stale offset, dropping that compensation: the reader's
    // line moved 144 px at the next scroll key (#214).
    const { list, scroller, render } = await mountList();
    // A data change locks LegendList's anchor, so it compensates a resize on the next frame.
    await render({ rows: 21 });
    const rowAbove = observers
      .flatMap((observer) => [...observer.targets])
      .find((element) => element.textContent === "row-8")!;
    resize(rowAbove, ROW_HEIGHT + 160);

    void list.scrollToOffset({ offset: 1_500, animated: false });
    await frames();

    expect(list.getState().scroll).toBe(1_660);
    expect(scroller.scrollTop).toBe(1_660);
  });
});
