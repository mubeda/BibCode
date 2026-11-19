// @vitest-environment happy-dom

import * as esm from "@legendapp/list/react";
import type { LegendListRef } from "@legendapp/list/react";
import * as NodeModule from "node:module";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

/**
 * The patched LegendList in both bundle formats, as the timeline uses it: it keeps the content
 * position, and an end scroll is still under way when a turn settles and its last rows go.
 * happy-dom lays nothing out, so each row measures ROW_HEIGHT and the viewport VIEWPORT_HEIGHT.
 */
const formats = {
  esm: esm.LegendList,
  cjs: (NodeModule.createRequire(import.meta.url)("@legendapp/list/react") as typeof esm)
    .LegendList,
};

const ROW_HEIGHT = 30;
const ESTIMATED_ROW_HEIGHT = 90;
const VIEWPORT_HEIGHT = 300;

function rows(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `row-${index}`);
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const row = this.dataset.testRow !== undefined || this.querySelector("[data-test-row]");
    return DOMRect.fromRect({ width: 400, height: row ? ROW_HEIGHT : VIEWPORT_HEIGHT });
  };
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
  "patched LegendList (%s) with an end scroll under way",
  (format) => {
    const LegendList = formats[format];
    const list = createRef<LegendListRef>();

    async function render(data: readonly string[]) {
      await act(async () =>
        root.render(
          <LegendList<string>
            ref={list}
            data={data}
            estimatedItemSize={ESTIMATED_ROW_HEIGHT}
            keyExtractor={(row) => row}
            // The timeline's own setting outside a key scroll (resolveTimelineMaintainVisibleContentPosition).
            maintainVisibleContentPosition={{ data: true, size: true }}
            renderItem={({ item }) => <div data-test-row={item}>{item}</div>}
            style={{ height: VIEWPORT_HEIGHT }}
          />,
        ),
      );
    }

    it("keeps its content length when the rows the scroll targets go", async () => {
      await render(rows(40));
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(list.current!.getState().contentLength).toBe(40 * ROW_HEIGHT);

      // The end scroll completes about 100 ms later; the turn settles first and drops two rows.
      await act(async () => {
        void list.current!.scrollToEnd({ animated: false });
      });
      await render(rows(38));

      // The scroll's target row no longer exists; its estimated size must not become the total.
      expect(list.current!.getState().contentLength).toBe(38 * ROW_HEIGHT);
    });
  },
);
