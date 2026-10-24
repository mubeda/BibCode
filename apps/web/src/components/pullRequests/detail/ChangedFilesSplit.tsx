import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useResizableWidth } from "../../../hooks/useResizableWidth";

const STORAGE_KEY = "bibcode:changed-files-nav-width";
const DEFAULT_WIDTH = 256;
const MIN_WIDTH = 224;
const MAX_WIDTH = 720;
/** Room the diffs keep when the file list grows. */
const DIFF_RESERVED_WIDTH = 384;
const KEYBOARD_STEP = 16;

/**
 * The Changes tab's file list beside its diffs. At `@3xl/pull-request` and
 * wider the list is a left column resized by the divider on its right edge,
 * with the width remembered per browser; below that it stacks above the diffs
 * at a fixed height and offers no divider.
 */
export function ChangedFilesSplit({ tree, files }: { tree: ReactNode; files: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const navId = useId();
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    // A hidden row measures 0; keep the last ceiling until it has a width again.
    const measure = (rowWidth: number) => {
      if (rowWidth > 0)
        setMaxWidth(
          Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(rowWidth) - DIFF_RESERVED_WIDTH)),
        );
    };
    measure(row.clientWidth);
    const observer = new ResizeObserver(([entry]) => measure(entry?.contentRect.width ?? 0));
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const { width, handlers, commitWidth } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth,
    edge: "right",
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowLeft"
        ? width - KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? width + KEYBOARD_STEP
          : event.key === "Home"
            ? MIN_WIDTH
            : event.key === "End"
              ? maxWidth
              : null;
    if (next === null) return;
    event.preventDefault();
    commitWidth(next);
  };
  return (
    <div ref={rowRef} className="flex min-h-0 flex-1 flex-col @3xl/pull-request:flex-row">
      <nav
        id={navId}
        aria-label="Changed files"
        className="flex h-48 shrink-0 flex-col border-b border-border @3xl/pull-request:h-auto @3xl/pull-request:w-(--changed-files-nav-width) @3xl/pull-request:border-r @3xl/pull-request:border-b-0"
        style={{ "--changed-files-nav-width": `${width}px` } as CSSProperties}
      >
        {tree}
      </nav>
      <div
        role="separator"
        tabIndex={0}
        aria-controls={navId}
        aria-label="Resize changed files"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        title="Drag to resize. Double-click to reset."
        className="group/separator relative z-10 -mx-1 hidden w-2 shrink-0 cursor-col-resize touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring/70 @3xl/pull-request:block"
        {...handlers}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commitWidth(DEFAULT_WIDTH)}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover/separator:bg-ring group-focus-visible/separator:bg-ring group-active/separator:bg-ring"
        />
      </div>
      {files}
    </div>
  );
}
