import { memo } from "react";

import { clampPercent } from "../status-bar/statusBarFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Percent bars, each an average with its peak drawn lighter above it, in the look of the
 * Resource Manager history chart. Bars and label must be stable for the memo to hold.
 */
export const HostMetricBars = memo(function HostMetricBars({
  bars,
  label,
}: {
  readonly bars: ReadonlyArray<{
    readonly key: string;
    readonly average: number;
    readonly peak: number;
    readonly tooltip: string;
  }>;
  readonly label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-16 items-end gap-px overflow-hidden rounded-sm bg-muted/40 p-1"
    >
      {bars.map((bar) => (
        <Tooltip key={bar.key}>
          <TooltipTrigger
            render={
              <div
                className="relative flex h-full min-w-px flex-1 items-end"
                aria-label={bar.tooltip}
              >
                <div
                  className="absolute inset-x-0 bottom-0 rounded-t-sm bg-blue-500/25"
                  style={{ height: `${clampPercent(bar.peak)}%` }}
                />
                <div
                  className="relative w-full rounded-t-sm bg-blue-500/70"
                  style={{ height: `${clampPercent(bar.average)}%` }}
                />
              </div>
            }
          />
          <TooltipPopup side="top" className="max-w-xs text-left text-xs">
            {bar.tooltip}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
});
