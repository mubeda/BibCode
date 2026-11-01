// @vitest-environment happy-dom
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createStickyTimelineItemType, type MessagesTimelineRow } from "./MessagesTimeline.logic";

const VIEWPORT_HEIGHT = 100_000;

function assistantRow(id: string, length: number, streaming = false): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: id as never,
      role: "assistant",
      text: "x".repeat(length),
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming,
    },
    durationStart: "2026-01-01T00:00:00Z",
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    disclosure: undefined,
  };
}

describe("sticky timeline item types", () => {
  it("keeps a row's first type as its text grows", () => {
    const getItemType = createStickyTimelineItemType();
    expect(getItemType(assistantRow("a", 1_900))).toBe("message:assistant:0");
    expect(getItemType(assistantRow("a", 50_000))).toBe("message:assistant:0");
    expect(getItemType(assistantRow("b", 50_000))).toBe("message:assistant:5");
  });

  it("gives a row first seen streaming a live type it keeps once it settles", () => {
    const getItemType = createStickyTimelineItemType();
    expect(getItemType(assistantRow("live", 100, true))).toBe("message:assistant:live");
    expect(getItemType(assistantRow("live", 100_000))).toBe("message:assistant:live");
  });
});

/**
 * The real LegendList, with each row's height read from its `data-test-height`: happy-dom lays
 * nothing out, so the list measures what the test says each row is.
 */
describe("LegendList size estimates for growing replies (#228)", () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const rows = this.querySelectorAll<HTMLElement>("[data-test-height]");
      const height =
        this.dataset.testHeight !== undefined
          ? Number(this.dataset.testHeight)
          : rows.length === 1
            ? Number(rows[0]!.dataset.testHeight)
            : VIEWPORT_HEIGHT;
      return DOMRect.fromRect({ width: 800, height });
    };
  });
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    document.body.replaceChildren();
  });

  /** Renders `rows` in one real LegendList, each `length` characters long and 10 px per 100. */
  function mountTimelineList() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const list = createRef<LegendListRef>();
    const getItemType = createStickyTimelineItemType();
    const render = async (rows: readonly MessagesTimelineRow[]) => {
      await act(async () => {
        root.render(
          <LegendList<MessagesTimelineRow>
            ref={list}
            data={rows}
            keyExtractor={(row) => row.id}
            getItemType={getItemType}
            estimatedItemSize={90}
            recycleItems={false}
            style={{ height: VIEWPORT_HEIGHT }}
            renderItem={({ item }) => (
              <div data-test-height={item.kind === "message" ? item.message.text.length / 10 : 40}>
                {item.id}
              </div>
            )}
          />,
        );
      });
      // LegendList measures its containers after layout settles.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    };
    const averages = () => list.current!.getState().getAverageItemSizes();
    const unmount = () => act(async () => root.unmount());
    return { render, averages, unmount };
  }

  const replies = (count: number, length: number) =>
    Array.from({ length: count }, (_, index) => assistantRow(`reply-${index}`, length));

  it("keeps every reply's estimate when replies stream past a length bucket", async () => {
    const timeline = mountTimelineList();
    // 84 replies stream from 1,900 to 2,100 characters, growing from 190 to 210 px.
    await timeline.render(replies(84, 1_900));
    await timeline.render(replies(84, 2_100));

    const averages = timeline.averages();
    // Moved into bucket 1 without being counted there, the replies left it estimating 1,870 px
    // for every unmeasured reply of that length.
    expect(averages["message:assistant:1"]).toBeUndefined();
    expect(averages["message:assistant:0"]?.count).toBe(84);
    expect(averages["message:assistant:0"]?.average).toBeCloseTo(210);
    await timeline.unmount();
  });

  it("keeps a folded turn's rows in their type when the turn opens again", async () => {
    const timeline = mountTimelineList();
    const answer = assistantRow("answer", 500);
    // The turn's replies grow past 2,000 characters while it runs, then the turn folds and
    // leaves only its answer, and the reader opens it again.
    await timeline.render([...replies(84, 1_900), answer]);
    await timeline.render([...replies(84, 2_300), answer]);
    await timeline.render([answer]);
    await timeline.render([...replies(84, 2_300), answer]);

    const averages = timeline.averages();
    // LegendList keeps a folded row's measured size, so a row coming back under a new type
    // moves that size into it uncounted.
    expect(averages["message:assistant:1"]).toBeUndefined();
    expect(averages["message:assistant:0"]?.count).toBe(85);
    await timeline.unmount();
  });

  it("keeps short history rows' estimate while a reply streams long", async () => {
    const timeline = mountTimelineList();
    // Short history, 50 px each; then a reply streams from 100 to 100,000 characters (10,000 px)
    // in the same list.
    const history = replies(20, 500);
    for (const length of [100, 1_000, 10_000, 100_000]) {
      await timeline.render([...history, assistantRow("streaming", length, length < 100_000)]);
    }

    const averages = timeline.averages();
    expect(averages["message:assistant:0"]?.count).toBe(20);
    expect(averages["message:assistant:0"]?.average).toBeCloseTo(50);
    expect(averages["message:assistant:live"]?.average).toBeCloseTo(10_000);
    await timeline.unmount();
  });
});
