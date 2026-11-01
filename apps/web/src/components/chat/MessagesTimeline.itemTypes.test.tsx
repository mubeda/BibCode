// @vitest-environment happy-dom
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createStickyTimelineItemType, type MessagesTimelineRow } from "./MessagesTimeline.logic";

const VIEWPORT_HEIGHT = 100_000;

function assistantRow(id: string, length: number): MessagesTimelineRow {
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
      streaming: false,
    },
    durationStart: "2026-01-01T00:00:00Z",
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    disclosure: undefined,
  };
}

describe("sticky timeline item types", () => {
  it("keeps a row's first type as its text grows, and forgets rows that left", () => {
    const itemTypes = createStickyTimelineItemType();
    expect(itemTypes.resolve(assistantRow("a", 1_900))).toBe("message:assistant:0");
    expect(itemTypes.resolve(assistantRow("a", 50_000))).toBe("message:assistant:0");
    expect(itemTypes.resolve(assistantRow("b", 50_000))).toBe("message:assistant:5");

    itemTypes.retain([assistantRow("b", 50_000)]);
    expect(itemTypes.resolve(assistantRow("a", 50_000))).toBe("message:assistant:5");
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

  it("keeps every reply's estimate when replies stream past a length bucket", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const list = createRef<LegendListRef>();
    const itemTypes = createStickyTimelineItemType();
    const heights = new Map<number, number>([
      [1_900, 190],
      [2_100, 210],
    ]);
    const render = async (length: number) => {
      const rows = Array.from({ length: 84 }, (_, index) => assistantRow(`reply-${index}`, length));
      await act(async () => {
        root.render(
          <LegendList<MessagesTimelineRow>
            ref={list}
            data={rows}
            keyExtractor={(row) => row.id}
            getItemType={itemTypes.resolve}
            estimatedItemSize={90}
            recycleItems={false}
            style={{ height: VIEWPORT_HEIGHT }}
            renderItem={({ item }) => (
              <div
                data-test-height={heights.get(
                  item.kind === "message" ? item.message.text.length : 0,
                )}
              >
                {item.id}
              </div>
            )}
          />,
        );
      });
      // LegendList measures its containers after layout settles.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    };

    // 84 replies stream from 1,900 to 2,100 characters, growing from 190 to 210 px.
    await render(1_900);
    await render(2_100);

    const averages = list.current!.getState().getAverageItemSizes();
    // Moved into bucket 1 without being counted there, the replies left it estimating 1,870 px
    // for every unmeasured reply of that length.
    expect(averages["message:assistant:1"]).toBeUndefined();
    expect(averages["message:assistant:0"]?.count).toBe(84);
    expect(averages["message:assistant:0"]?.average).toBeCloseTo(210);
    await act(async () => root.unmount());
  });
});
