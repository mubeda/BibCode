// @vitest-environment happy-dom
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ tooltipRenders: 0 }));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => {
    h.tooltipRenders += 1;
    return <>{children}</>;
  },
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
}));

import { HostMetricBars } from "./HostMetricBars";

const BARS = [
  { key: "a", average: 10, peak: 20, tooltip: "7:00 PM: average 10.0%, peak 20.0%" },
  { key: "b", average: 30, peak: 40, tooltip: "7:01 PM: average 30.0%, peak 40.0%" },
  { key: "c", average: 50, peak: 60, tooltip: "7:02 PM: average 50.0%, peak 60.0%" },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.tooltipRenders = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

async function render(bars: typeof BARS) {
  await act(async () => root!.render(<HostMetricBars bars={bars} label="CPU since start" />));
  return container!.querySelector<HTMLElement>('[aria-label="CPU since start"]')!;
}

async function key(chart: HTMLElement, name: string) {
  await act(async () => {
    chart.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

describe("HostMetricBars keyboard", () => {
  it("is one tab stop whose arrow keys move through the bars and show the value", async () => {
    const chart = await render(BARS);
    expect(chart.getAttribute("role")).toBe("listbox");
    expect(chart.tabIndex).toBe(0);
    expect(container!.querySelectorAll("[tabindex]")).toHaveLength(1);
    const options = [...chart.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual(
      BARS.map((bar) => bar.tooltip),
    );

    await act(async () => chart.focus());
    const active = () => chart.getAttribute("aria-activedescendant");
    expect(active()).toBe(options[2]!.id);
    expect(container!.textContent).toContain(BARS[2]!.tooltip);

    await key(chart, "ArrowLeft");
    expect(active()).toBe(options[1]!.id);
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(container!.textContent).toContain(BARS[1]!.tooltip);
    await key(chart, "Home");
    expect(active()).toBe(options[0]!.id);
    await key(chart, "ArrowLeft");
    expect(active()).toBe(options[0]!.id);
    await key(chart, "End");
    expect(active()).toBe(options[2]!.id);

    await act(async () => chart.blur());
    expect(container!.textContent).not.toContain(BARS[2]!.tooltip);
  });

  it("re-renders only the bar whose value changed", async () => {
    await render(BARS);
    h.tooltipRenders = 0;
    await render([
      ...BARS.slice(0, 2).map((bar) => ({ ...bar })),
      { ...BARS[2]!, average: 55, tooltip: "7:02 PM: average 55.0%, peak 60.0%" },
    ]);
    expect(h.tooltipRenders).toBe(1);
  });
});
