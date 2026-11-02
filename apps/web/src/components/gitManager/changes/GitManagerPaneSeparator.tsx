import type { KeyboardEvent } from "react";

import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";

const KEYBOARD_STEP = 16;

/**
 * Horizontal divider between two stacked Changes panes, dragged or moved with the arrow keys.
 * `growKey` is the arrow that enlarges the pane the divider resizes: Down for the pane above it,
 * Up for the pane below it.
 */
export function GitManagerPaneSeparator({
  label,
  controls,
  value,
  min,
  max,
  growKey,
  handlers,
  onResize,
  onReset,
}: {
  readonly label: string;
  /** Id of the pane the divider resizes. */
  readonly controls: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly growKey: "ArrowUp" | "ArrowDown";
  readonly handlers: ResizableWidthHandlers;
  readonly onResize: (size: number) => void;
  readonly onReset: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const shrinkKey = growKey === "ArrowUp" ? "ArrowDown" : "ArrowUp";
    const next =
      event.key === growKey
        ? value + KEYBOARD_STEP
        : event.key === shrinkKey
          ? value - KEYBOARD_STEP
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    onResize(next);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-controls={controls}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title="Drag to resize. Double-click to reset."
      className="group/separator relative z-10 -my-1 h-2 shrink-0 cursor-row-resize touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      {...handlers}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors group-hover/separator:bg-ring group-focus-visible/separator:bg-ring group-active/separator:bg-ring"
      />
    </div>
  );
}
