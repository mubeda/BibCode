// @vitest-environment happy-dom
/**
 * Find in thread end to end in one timeline: the real `MessagesTimeline` with a list double
 * whose `scrollToIndex` can be held back, and a fake highlight registry. Assertions are about
 * intent (the index requested, the range painted, the disclosures opened), never positions.
 */
import { EnvironmentId, MessageId, TurnId } from "@bibcode/contracts";
import {
  act,
  createRef,
  useImperativeHandle,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";
import type { TimelineEntry } from "../../../session-logic";
import type { ThreadFindLoadState } from "../../../state/threads";
import { clientCollector, setClientBatchSender } from "../../../profiler/clientCollector";
import {
  FIND_ACTIVE_HIGHLIGHT_NAME,
  FIND_ACTIVE_ROW_ATTRIBUTE,
  FIND_HIGHLIGHT_NAME,
  setFindHighlightSupportForTests,
} from "./threadFindHighlights";
import { openThreadFindForTarget } from "./useThreadFind";

const h = vi.hoisted(() => ({
  loadState: { status: "live", error: null, hasData: true } as ThreadFindLoadState,
  loadStateListeners: new Set<() => void>(),
  lists: [] as Array<{
    start: number;
    scroll: number;
    data: Array<{ id: string }>;
    scrollToIndex: ReturnType<
      typeof vi.fn<(params: { index: number; animated?: boolean }) => Promise<void>>
    >;
    scrollToOffset: ReturnType<
      typeof vi.fn<(params: { offset: number; animated?: boolean }) => Promise<void>>
    >;
    deferred: Array<() => void>;
    holdScrolls: boolean;
    onScrollToIndex?: (index: number) => void;
  }>,
}));

vi.mock("../../../state/threads", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    // As the real hook does through its atom: a change re-renders the subscriber.
    useThreadFindLoadState: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          h.loadStateListeners.add(listener);
          return () => h.loadStateListeners.delete(listener);
        },
        () => h.loadState,
      ),
  };
});

async function setLoadState(next: ThreadFindLoadState): Promise<void> {
  await act(async () => {
    h.loadState = next;
    for (const listener of h.loadStateListeners) listener();
  });
}

vi.mock("@legendapp/list/react", async () => {
  const { useId, useState } = await import("react");
  type ListDouble = (typeof h.lists)[number];
  const doubles = new Map<string, ListDouble>();
  /** The list for one mounted LegendList, kept outside React and given the latest data. */
  function listDouble(id: string, data: Array<{ id: string }>): ListDouble {
    const existing = doubles.get(id);
    if (existing) {
      existing.data = data;
      return existing;
    }
    const list: ListDouble = {
      start: 0,
      scroll: 120,
      data,
      deferred: [],
      holdScrolls: false,
      scrollToOffset: vi.fn(async ({ offset }: { offset: number }) => {
        // A new imperative scroll cancels the one LegendList is holding back.
        list.deferred.length = 0;
        list.scroll = offset;
      }),
      scrollToIndex: vi.fn(
        ({ index }: { index: number }) =>
          new Promise<void>((resolve) => {
            const run = () => {
              list.onScrollToIndex?.(index);
              list.scroll = index * 90;
              resolve();
            };
            if (list.holdScrolls) list.deferred.push(run);
            else run();
          }),
      ),
    };
    h.lists.push(list);
    doubles.set(id, list);
    return list;
  }
  function LegendList(props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ref?: Ref<unknown>;
  }) {
    const id = useId();
    const [element, setElement] = useState<HTMLDivElement | null>(null);
    const { data, keyExtractor, renderItem, ListHeaderComponent, ListFooterComponent, ref } = props;
    listDouble(id, data);
    useImperativeHandle(
      ref,
      () => ({
        getState: () => {
          const list = doubles.get(id)!;
          return {
            start: list.start,
            scroll: list.scroll,
            indexByKey: (key: string) => {
              const index = list.data.findIndex((item) => keyExtractor(item) === key);
              return index === -1 ? undefined : index;
            },
          };
        },
        scrollToIndex: (params: { index: number }) => doubles.get(id)!.scrollToIndex(params),
        scrollToOffset: (params: { offset: number }) => doubles.get(id)!.scrollToOffset(params),
        getScrollableNode: () => element,
      }),
      [element, id, keyExtractor],
    );
    return (
      <div ref={setElement} data-testid="legend-list">
        {ListHeaderComponent}
        {data.map((item) => (
          <div key={keyExtractor(item)}>{renderItem({ item })}</div>
        ))}
        {ListFooterComponent}
      </div>
    );
  }
  return { LegendList };
});

vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

interface FakeHighlight {
  readonly ranges: ReadonlyArray<Range>;
  readonly priority: number;
}
const registry = new Map<string, FakeHighlight>();

// Importing the timeline is slow while the whole suite runs, as in MessagesTimeline.test.tsx.
const SLOW_TIMELINE_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  await import("../MessagesTimeline");
}, SLOW_TIMELINE_TIMEOUT_MS);

beforeEach(() => {
  registry.clear();
  h.lists.length = 0;
  h.loadState = { status: "live", error: null, hasData: true };
  setFindHighlightSupportForTests({
    registry: {
      set: (name, highlight) => registry.set(name, highlight as FakeHighlight),
      delete: (name) => registry.delete(name),
    },
    createHighlight: (ranges, priority) => ({ ranges: [...ranges], priority }),
  });
});

interface Mounted {
  readonly container: HTMLDivElement;
  readonly root: Root;
}
const mounted: Mounted[] = [];

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  setFindHighlightSupportForTests(undefined);
  vi.restoreAllMocks();
});

const TURN = TurnId.make("turn-1");
const at = (second: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + second * 1000).toISOString();

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  second: number,
  turnId: TurnId | null = null,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: at(second),
    message: {
      id: MessageId.make(id),
      role,
      text,
      turnId,
      createdAt: at(second),
      updatedAt: at(second),
      streaming: false,
    },
  };
}

function work(id: string, command: string, second: number, turnId: TurnId | null): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: at(second),
    entry: {
      id,
      createdAt: at(second),
      turnId,
      label: "Run",
      command,
      detail: "output only text",
      tone: "tool",
    },
  };
}

/** Many short settled exchanges, then a settled turn whose work is folded. */
function longThread(foldedTurn: ReadonlyArray<TimelineEntry>): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (let index = 0; index < 250; index += 1) {
    entries.push(message(`user-${index}`, "user", `question ${index}`, index * 2));
    entries.push(message(`answer-${index}`, "assistant", `answer ${index}`, index * 2 + 1));
  }
  return [...entries, ...foldedTurn];
}

const settledTurn = {
  turnId: TURN,
  state: "completed" as const,
  startedAt: at(600),
  completedAt: at(700),
};

type MessagesTimelineProps = ComponentProps<typeof import("../MessagesTimeline").MessagesTimeline>;

function buildProps(overrides: Partial<MessagesTimelineProps>): MessagesTimelineProps {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    timelineEntries: [],
    queuedMessages: [],
    queuedStatuses: [],
    latestTurn: settledTurn,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    onResolveTurnDelivery: () => {},
    resolvingTurnDeliveryMessageId: null,
    blockingDelivery: null,
    instanceLabels: new Map(),
    onSteerQueuedMessage: () => {},
    onSendNowQueuedMessage: () => {},
    onCancelQueuedMessage: () => {},
    resolvingQueuedMessageId: null,
    queuedMessageErrors: {},
    attachmentUploads: {},
    onCancelAttachmentUpload: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    verboseChat: false,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
    isHostFindSurface: true,
    ...overrides,
  };
}

async function mountTimeline(overrides: Partial<MessagesTimelineProps>): Promise<{
  container: HTMLDivElement;
  render: (next: Partial<MessagesTimelineProps>) => Promise<void>;
}> {
  const { MessagesTimeline } = await import("../MessagesTimeline");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  let props = buildProps({ findSurfaceRoot: container, ...overrides });
  await act(async () => root.render(<MessagesTimeline {...props} />));
  return {
    container,
    render: async (next) => {
      props = { ...props, ...next };
      await act(async () => root.render(<MessagesTimeline {...props} />));
    },
  };
}

async function settle(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for find");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}

function findInput(container: HTMLElement = document.body): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>("[data-thread-find-bar] input");
}

async function openFind(target: EventTarget | null = null): Promise<HTMLInputElement> {
  await act(async () => {
    openThreadFindForTarget(target);
  });
  await settle(() => findInput() !== null);
  return findInput()!;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Types while an input method composes, as the bar's change handler sees it. */
async function compose(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
  });
}

async function wait(ms: number): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}

/** Holds animation frames until the test runs them. */
function holdAnimationFrames(): { flush: (frames: number) => Promise<void> } {
  const queue: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    queue.push(callback);
    return queue.length;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  return {
    flush: async (frames) => {
      for (let frame = 0; frame < frames; frame += 1) {
        await act(async () => {
          for (const callback of queue.splice(0)) callback(performance.now());
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    },
  };
}

async function press(
  element: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

function statusText(container: HTMLElement = document.body): string {
  return container.querySelector("[data-thread-find-bar]")?.textContent ?? "";
}

function activeRange(): Range | null {
  return registry.get(FIND_ACTIVE_HIGHLIGHT_NAME)?.ranges[0] ?? null;
}

function rowOf(node: Node | null | undefined): string | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest("[data-timeline-row-id]")?.getAttribute("data-timeline-row-id") ?? null;
}

const foldButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-timeline-row-kind="turn-fold"] button');

describe("useThreadFind", () => {
  it(
    "opens a folded turn, scrolls its row into view and paints the match in a 500-row thread",
    async () => {
      const { container } = await mountTimeline({
        timelineEntries: longThread([
          message("user-x", "user", "do the thing", 600),
          message("commentary", "assistant", "Looking for the needle first.", 601, TURN),
          message("final", "assistant", "Done.", 602, TURN),
        ]),
      });
      expect(foldButton(container)?.getAttribute("aria-expanded")).toBe("false");

      await type(await openFind(), "needle");
      await settle(() => activeRange() !== null);

      expect(foldButton(container)?.getAttribute("aria-expanded")).toBe("true");
      const list = h.lists[0]!;
      const commentaryIndex = list.data.findIndex((row) => row.id === "commentary");
      expect(list.scrollToIndex).toHaveBeenCalledWith({
        index: commentaryIndex,
        animated: false,
        viewPosition: 0.3,
      });
      expect(rowOf(activeRange()?.startContainer)).toBe("commentary");
      expect(activeRange()?.toString()).toBe("needle");
      expect(statusText()).toContain("1/1");
    },
    SLOW_TIMELINE_TIMEOUT_MS,
  );

  it("reaches a command behind a fold and a collapsed group, and ignores tool output", async () => {
    const { container } = await mountTimeline({
      timelineEntries: [
        message("user-x", "user", "build it", 0),
        message("commentary", "assistant", "Starting.", 1, TURN),
        work("tool-1", "git status", 2, TURN),
        work("tool-2", "pnpm build --filter web", 3, TURN),
        work("tool-3", "git diff", 4, TURN),
        message("final", "assistant", "Done.", 5, TURN),
      ],
    });
    const input = await openFind();
    await type(input, "output only");
    await settle(() => statusText().includes("No results"));

    await type(input, "--filter web");
    await settle(() => activeRange() !== null);

    expect(foldButton(container)?.getAttribute("aria-expanded")).toBe("true");
    const groupToggle = container.querySelector('[data-timeline-row-kind="work-toggle"] button');
    expect(groupToggle?.getAttribute("aria-expanded")).toBe("true");
    const toolRow = container.querySelector('[data-timeline-row-id="tool-2"] [role="button"]');
    expect(toolRow?.getAttribute("aria-expanded")).toBe("true");
    expect(rowOf(activeRange()?.startContainer)).toBe("tool-2");
  });

  it("opens a long message past its clip and a long plan past its preview", async () => {
    const longBody = [...Array.from({ length: 12 }, (_, line) => `line ${line}`), "deep tail"].join(
      "\n",
    );
    const planBody = Array.from({ length: 30 }, (_, line) => `- plan step ${line}`).join("\n");
    const { container } = await mountTimeline({
      latestTurn: null,
      timelineEntries: [
        message("long", "user", longBody, 0),
        {
          id: "plan",
          kind: "proposed-plan",
          createdAt: at(1),
          proposedPlan: {
            id: "plan",
            turnId: null,
            planMarkdown: `# Plan\n\n${planBody}\n- final hidden step`,
            implementedAt: null,
            implementationThreadId: null,
            createdAt: at(1),
            updatedAt: at(1),
          } as never,
        },
      ],
    });
    const input = await openFind();
    await type(input, "deep tail");
    await settle(() => activeRange() !== null);
    expect(
      container
        .querySelector('[data-timeline-row-id="long"] [data-user-message-body]')
        ?.getAttribute("data-user-message-collapsed"),
    ).toBe("false");

    await type(input, "final hidden step");
    await settle(() => rowOf(activeRange()?.startContainer) === "plan");
    expect(container.textContent).toContain("Collapse plan");
  });

  it("opens only the closed details block that holds the active match", async () => {
    const reply = [
      "<details>",
      "<summary>First</summary>",
      "",
      "the word in block zero",
      "",
      "</details>",
      "",
      "<details>",
      "<summary>Second</summary>",
      "",
      "the word in block one",
      "",
      "</details>",
    ].join("\n");
    const { container } = await mountTimeline({
      latestTurn: null,
      timelineEntries: [message("reply", "assistant", reply, 0)],
    });
    const blocks = () =>
      [...container.querySelectorAll<HTMLElement>("[data-markdown-details]")].map(
        (block) => block.dataset.markdownDetailsOpen,
      );
    expect(blocks()).toEqual(["false", "false"]);

    const input = await openFind();
    await type(input, "block one");
    await settle(() => activeRange() !== null);

    // Only the second block opens, and the range is in its text.
    expect(blocks()).toEqual(["false", "true"]);
    expect(activeRange()?.toString()).toBe("block one");
    expect(
      activeRange()
        ?.startContainer.parentElement?.closest("[data-markdown-details-content]")
        ?.getAttribute("data-markdown-details-content"),
    ).toBe("1");

    // A query that matches in both blocks starts at the first; stepping opens the second.
    await type(input, "the word");
    await settle(() => blocks()[0] === "true");
    expect(statusText()).toContain("1/2");
  });

  it("opens a row again that the reader collapsed", async () => {
    const { container } = await mountTimeline({
      latestTurn: null,
      timelineEntries: [
        work("tool-1", "make check", 0, null),
        work("tool-2", "make check", 1, null),
      ],
    });
    const input = await openFind();
    await type(input, "make check");
    // The group shows its newest call at the top of the viewport, so find starts there.
    await settle(() => rowOf(activeRange()?.startContainer) === "tool-2");
    const toolRow = () =>
      container.querySelector<HTMLElement>('[data-timeline-row-id="tool-2"] [role="button"]')!;
    await act(async () => toolRow().click());
    expect(toolRow().getAttribute("aria-expanded")).toBe("false");

    await press(input, "Enter");
    await settle(() => rowOf(activeRange()?.startContainer) === "tool-1");
    await press(input, "Enter");
    await settle(() => rowOf(activeRange()?.startContainer) === "tool-2");

    expect(toolRow().getAttribute("aria-expanded")).toBe("true");
  });

  it("supersedes a held-back scroll on close and on a query with no matches", async () => {
    await mountTimeline({
      latestTurn: null,
      timelineEntries: [message("a", "user", "alpha one", 0), message("b", "user", "alpha two", 1)],
    });
    const list = h.lists[0]!;
    list.holdScrolls = true;
    list.start = 1;
    const input = await openFind();
    await type(input, "alpha");
    await settle(() => list.scrollToIndex.mock.calls.length > 0);
    expect(list.deferred).toHaveLength(1);

    await type(input, "zzz-no-match");
    await settle(() => statusText().includes("No results"));
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 120, animated: false });
    expect(list.deferred).toHaveLength(0);

    await type(input, "alpha");
    await settle(() => list.deferred.length > 0);
    list.scrollToOffset.mockClear();
    await press(input, "Escape");
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: list.scroll, animated: false });
    expect(list.deferred).toHaveLength(0);
    expect(findInput()).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("stops a settling navigation when the query is replaced by one with no matches", async () => {
    await mountTimeline({
      latestTurn: null,
      timelineEntries: [message("a", "user", "alpha one", 0)],
    });
    const list = h.lists[0]!;
    const frames = holdAnimationFrames();
    const input = await openFind();
    await type(input, "alpha");
    // The scroll lands at once; the settle that follows waits on frames.
    for (let attempt = 0; attempt < 50 && list.scrollToIndex.mock.calls.length === 0; attempt++) {
      await frames.flush(1);
      await wait(20);
    }
    expect(list.scrollToIndex).toHaveBeenCalledTimes(1);

    await type(input, "zzz-no-match");
    await settle(() => statusText().includes("No results"));
    list.scrollToOffset.mockClear();
    await frames.flush(12);

    // The obsolete match is never scrolled into the band.
    expect(list.scrollToOffset).not.toHaveBeenCalled();
  });

  it("neither scans nor navigates while an input method composes", async () => {
    await mountTimeline({
      latestTurn: null,
      timelineEntries: [message("a", "user", "alpha one", 0)],
    });
    const list = h.lists[0]!;
    const input = await openFind();
    await type(input, "alpha");
    await compose(input, "alpha o");
    await wait(400);
    expect(statusText()).not.toContain("1/1");
    expect(list.scrollToIndex).not.toHaveBeenCalled();

    // Composition ends: the composed query is searched.
    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await settle(() => statusText().includes("1/1"));
  });

  it("reissues a scroll once when the row moved while it was held back", async () => {
    const { render } = await mountTimeline({
      latestTurn: null,
      timelineEntries: [message("a", "user", "nothing", 0), message("b", "user", "target here", 1)],
    });
    const list = h.lists[0]!;
    list.holdScrolls = true;
    const input = await openFind();
    await type(input, "target");
    await settle(() => list.deferred.length > 0);
    expect(list.scrollToIndex).toHaveBeenLastCalledWith(expect.objectContaining({ index: 1 }));

    // A row streams in above while the scroll waits.
    await render({
      timelineEntries: [
        message("new", "user", "inserted first", -1),
        message("a", "user", "nothing", 0),
        message("b", "user", "target here", 1),
      ],
    });
    list.holdScrolls = false;
    await act(async () => list.deferred.shift()?.());
    await settle(() => list.scrollToIndex.mock.calls.length === 2);
    expect(list.scrollToIndex).toHaveBeenLastCalledWith(expect.objectContaining({ index: 2 }));
  });

  it("keeps one find per document: opening another closes the first", async () => {
    const first = await mountTimeline({
      latestTurn: null,
      timelineEntries: [message("a", "user", "shared word", 0)],
    });
    const second = await mountTimeline({
      latestTurn: null,
      isHostFindSurface: false,
      routeThreadKey: "environment-local:thread-2",
      timelineEntries: [message("b", "user", "shared word too", 0)],
    });
    await type(await openFind(first.container), "shared");
    await settle(() => rowOf(activeRange()?.startContainer) === "a");

    await act(async () => {
      openThreadFindForTarget(second.container.firstElementChild);
    });
    await settle(() => findInput(second.container) !== null);
    expect(findInput(first.container)).toBeNull();
    expect(registry.size).toBe(0);

    await type(findInput(second.container)!, "shared");
    await settle(() => rowOf(activeRange()?.startContainer) === "b");
    await press(findInput(second.container)!, "Escape");
    expect(registry.size).toBe(0);

    // Unmounting the first surface, which no longer owns the registry, leaves it alone.
    registry.set(FIND_HIGHLIGHT_NAME, { ranges: [], priority: 0 });
    const firstMounted = mounted.find((entry) => entry.container === first.container)!;
    await act(async () => firstMounted.root.unmount());
    mounted.splice(mounted.indexOf(firstMounted), 1);
    expect(registry.has(FIND_HIGHLIGHT_NAME)).toBe(true);
  });

  it("reports the thread's load state and closes when it is deleted", async () => {
    h.loadState = { status: "empty", error: null, hasData: false };
    const { render } = await mountTimeline({ latestTurn: null, timelineEntries: [] });
    const input = await openFind();
    expect(statusText()).toContain("Loading thread…");

    await setLoadState({
      status: "empty",
      error: "Could not synchronize the thread.",
      hasData: false,
    });
    await settle(() => statusText().includes("This thread could not be loaded"));

    await setLoadState({ status: "cached", error: "offline", hasData: true });
    await render({ timelineEntries: [message("a", "user", "cached text", 0)] });
    await type(input, "cached");
    await settle(() => statusText().includes("1/1"));
    expect(statusText()).toContain("May be out of date");

    await setLoadState({ status: "deleted", error: null, hasData: true });
    await settle(() => findInput() === null);
  });

  it("closes on Escape, clears its highlights, focuses the composer and stays in place", async () => {
    const onFindFocusComposer = vi.fn();
    await mountTimeline({
      latestTurn: null,
      onFindFocusComposer,
      timelineEntries: [message("a", "user", "stay here", 0)],
    });
    const input = await openFind();
    await type(input, "stay");
    await settle(() => activeRange() !== null);
    const list = h.lists[0]!;
    const offset = list.scroll;
    list.scrollToIndex.mockClear();

    await press(input, "Escape");

    expect(findInput()).toBeNull();
    expect(registry.size).toBe(0);
    expect(onFindFocusComposer).toHaveBeenCalledTimes(1);
    expect(list.scroll).toBe(offset);
    expect(list.scrollToIndex).not.toHaveBeenCalled();

    // Reopening restores the last query, selected.
    const reopened = await openFind();
    expect(reopened.value).toBe("stay");
  });

  it("rings the active row when the engine cannot paint highlights", async () => {
    setFindHighlightSupportForTests(null);
    const { container } = await mountTimeline({
      latestTurn: null,
      timelineEntries: [message("a", "user", "ring me", 0)],
    });
    await type(await openFind(), "ring");
    await settle(() => container.querySelector(`[${FIND_ACTIVE_ROW_ATTRIBUTE}]`) !== null);
    expect(
      container
        .querySelector(`[${FIND_ACTIVE_ROW_ATTRIBUTE}]`)
        ?.getAttribute("data-timeline-row-id"),
    ).toBe("a");
    await press(findInput()!, "Escape");
    expect(container.querySelector(`[${FIND_ACTIVE_ROW_ATTRIBUTE}]`)).toBeNull();
  });

  it("never passes the search text to the console, the profiler or storage", async () => {
    const sentinel = "sentinel-7f3a9c";
    const consoleCalls = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const send = vi.fn(async () => {});
    setClientBatchSender(send);
    clientCollector.setEnabledEnvironments(new Set(["environment-local"]));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    try {
      await mountTimeline({
        latestTurn: null,
        timelineEntries: [message("a", "user", `contains ${sentinel} here`, 0)],
      });
      const input = await openFind();
      await type(input, sentinel);
      await settle(() => activeRange() !== null);
      await press(input, "Enter");
      await clientCollector.flush();
      const seen = JSON.stringify([
        ...consoleCalls.flatMap((spy) => spy.mock.calls),
        send.mock.calls,
        storage.mock.calls,
      ]);
      expect(seen).not.toContain(sentinel);
    } finally {
      clientCollector.setEnabledEnvironments(new Set());
      setClientBatchSender(null);
    }
  });
});
