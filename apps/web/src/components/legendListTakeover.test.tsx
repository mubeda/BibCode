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
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  // happy-dom lays nothing out: the scroller is the view's height and every row a row's height.
  vi.spyOn(domWindow.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new domWindow!.DOMRect(
      0,
      0,
      800,
      this.style.overflow === "auto" ? VIEW_HEIGHT : ROW_HEIGHT,
    );
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
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

/**
 * A list of 20 rows, gliding to its end when a key takes it over: the browser runs the glide
 * itself (a smooth scroll it does not finish here), and LegendList holds an adjustment for the
 * bottom inset that grew during it.
 */
async function glidingList() {
  const { LegendList } = await import("@legendapp/list/react");
  const ref = createRef<LegendListRef>();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const data = Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}` }));
  const render = (endInset: number) =>
    act(async () => {
      root!.render(
        <LegendList
          ref={ref}
          data={data}
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
  await render(0);
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
  await render(HELD);
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
