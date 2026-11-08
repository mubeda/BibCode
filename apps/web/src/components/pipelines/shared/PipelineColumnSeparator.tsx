import type { KeyboardEvent } from "react";

import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";

/** Pixels one arrow-key press moves a column edge. */
const KEYBOARD_STEP = 16;

/**
 * Vertical divider on a column's right edge, shared by the list header and the pipeline
 * page. Drag it, or use Left/Right (shrink/grow), Home (minimum) and End (maximum);
 * double-click resets. The 8 px hit area straddles the edge; wiring comes from
 * `useResizableWidth`, so a drag repaints one CSS custom property and no row.
 */
export function PipelineColumnSeparator({
  label,
  value,
  min,
  max,
  handlers,
  onResize,
  onReset,
  controls,
  className,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly handlers: ResizableWidthHandlers;
  readonly onResize: (width: number) => void;
  readonly onReset: () => void;
  /** Id of the column the divider resizes, when it has one. */
  readonly controls?: string;
  readonly className?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowRight"
        ? value + KEYBOARD_STEP
        : event.key === "ArrowLeft"
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
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title="Drag to resize. Double-click to reset."
      className={`group/separator absolute inset-y-0 -right-2.5 z-10 w-2 cursor-col-resize touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring/70 ${className ?? ""}`}
      {...handlers}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover/separator:bg-ring group-focus-visible/separator:bg-ring group-active/separator:bg-ring"
      />
    </div>
  );
}
