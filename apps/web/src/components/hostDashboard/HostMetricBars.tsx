import { type KeyboardEvent, memo, useId, useState } from "react";

import { cn } from "~/lib/utils";

import { clampPercent } from "../status-bar/statusBarFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface Bar {
  readonly key: string;
  readonly average: number;
  readonly peak: number;
  readonly tooltip: string;
}

/** Where a key moves the active bar in a horizontal chart, or null to leave the key alone. */
function nextBarIndex(key: string, current: number, count: number): number | null {
  const last = count - 1;
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, current - 1);
    case "ArrowRight":
      return Math.min(last, current + 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * Percent bars, each an average with its peak drawn lighter above it, in the look of the
 * Resource Manager history chart. The chart is one tab stop, a horizontal listbox like the diff
 * file list: arrow keys, Home and End move the active bar (`aria-activedescendant`), and its value
 * shows under the chart. Bars are memoized on their values, so a new reading re-renders only the
 * bars it changed.
 */
export const HostMetricBars = memo(function HostMetricBars({
  bars,
  label,
}: {
  readonly bars: ReadonlyArray<Bar>;
  readonly label: string;
}) {
  const chartId = useId();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeIndex = activeKey === null ? -1 : bars.findIndex((bar) => bar.key === activeKey);
  const active = activeIndex < 0 ? null : bars[activeIndex]!;
  const barId = (key: string) => `${chartId}-${key}`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || bars.length === 0) return;
    const next = nextBarIndex(
      event.key,
      activeIndex < 0 ? bars.length - 1 : activeIndex,
      bars.length,
    );
    if (next === null) return;
    event.preventDefault();
    setActiveKey(bars[next]!.key);
  };

  return (
    <div className="grid gap-1">
      <div
        role="listbox"
        aria-orientation="horizontal"
        aria-label={label}
        tabIndex={0}
        {...(active === null ? {} : { "aria-activedescendant": barId(active.key) })}
        // Focus starts on the newest bar.
        onFocus={() => setActiveKey(bars.at(-1)?.key ?? null)}
        onBlur={() => setActiveKey(null)}
        onKeyDown={onKeyDown}
        className="flex h-16 items-end gap-px overflow-hidden rounded-sm bg-muted/40 p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {bars.map((bar) => (
          <ChartBar
            key={bar.key}
            id={barId(bar.key)}
            average={bar.average}
            peak={bar.peak}
            tooltip={bar.tooltip}
            active={bar.key === active?.key}
          />
        ))}
      </div>
      <p className="min-h-4 text-muted-foreground text-xs" aria-hidden>
        {active?.tooltip ?? ""}
      </p>
    </div>
  );
});

const ChartBar = memo(function ChartBar({
  id,
  average,
  peak,
  tooltip,
  active,
}: {
  readonly id: string;
  readonly average: number;
  readonly peak: number;
  readonly tooltip: string;
  readonly active: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            id={id}
            role="option"
            aria-selected={active}
            aria-label={tooltip}
            className={cn(
              "relative flex h-full min-w-px flex-1 items-end",
              active && "outline-2 outline-ring",
            )}
          >
            <div
              className="absolute inset-x-0 bottom-0 rounded-t-sm bg-blue-500/25"
              style={{ height: `${clampPercent(peak)}%` }}
            />
            <div
              className="relative w-full rounded-t-sm bg-blue-500/70"
              style={{ height: `${clampPercent(average)}%` }}
            />
          </div>
        }
      />
      <TooltipPopup side="top" className="max-w-xs text-left text-xs">
        {tooltip}
      </TooltipPopup>
    </Tooltip>
  );
});
