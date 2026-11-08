/**
 * The list's column grid. One template per container step is written to the list root as a
 * custom property, so the header and every row share it and a drag never re-renders a row.
 *
 * Fitting order as the list panel narrows (container width of the list root):
 *   >= 1100 px  full:    Status | Pipeline (capped) | Created by | Stages | Actions
 *   >= 900 px   medium:  Created by hides
 *   >= 720 px   compact: Stages folds to a short strip with a "+N" count
 *   <  720 px   narrow:  Status folds to its icon
 * Pipeline, Created by and Stages are user-resizable at the full step only.
 */
/** Hideable parts of a row; "timing" is the duration and age text under Status. */
export type PipelinesColumnId = "author" | "stages" | "timing";

export const OPTIONAL_COLUMNS: readonly {
  readonly id: PipelinesColumnId;
  readonly label: string;
}[] = [
  { id: "author", label: "Created by" },
  { id: "stages", label: "Stages" },
  { id: "timing", label: "Duration and age" },
];

export const COLUMN_BOUNDS = {
  pipeline: { default: 480, min: 240, max: 960 },
  author: { default: 160, min: 96, max: 320 },
  stages: { default: 160, min: 72, max: 360 },
} as const;

/** Fits "Passed with warnings" in full beside its icon at text-sm. */
const STATUS_WIDTH = 168;
const STATUS_ICON_WIDTH = 24;
/** Three icon-sm buttons (32 px) and two 4 px gaps, so empty slots keep their space. */
export const ACTIONS_WIDTH = 104;
const STAGES_COMPACT_WIDTH = 64;
const STAGES_MEDIUM_WIDTH = 160;

/** One stage icon (16 px) plus its 2 px gap. */
export const STAGE_ICON_PITCH = 18;
/** Room kept for the "+N" count when icons are left out. */
const OVERFLOW_LABEL_WIDTH = 28;

export interface PipelinesGridTemplates {
  readonly narrow: string;
  readonly compact: string;
  readonly medium: string;
  readonly full: string;
}

export function pipelinesGridTemplates(
  widths: { readonly pipeline: number; readonly author: number; readonly stages: number },
  hidden: ReadonlySet<PipelinesColumnId>,
): PipelinesGridTemplates {
  const stages = !hidden.has("stages");
  const author = !hidden.has("author");
  const join = (tracks: readonly (string | null)[]) => tracks.filter(Boolean).join(" ");
  const fill = "minmax(0,1fr)";
  const actions = `${ACTIONS_WIDTH}px`;
  const stagesTrack = (width: number) => (stages ? `${width}px` : null);
  return {
    narrow: join([`${STATUS_ICON_WIDTH}px`, fill, stagesTrack(STAGES_COMPACT_WIDTH), actions]),
    compact: join([`${STATUS_WIDTH}px`, fill, stagesTrack(STAGES_COMPACT_WIDTH), actions]),
    medium: join([`${STATUS_WIDTH}px`, fill, stagesTrack(STAGES_MEDIUM_WIDTH), actions]),
    full: join([
      `${STATUS_WIDTH}px`,
      `minmax(${COLUMN_BOUNDS.pipeline.min}px,${widths.pipeline}px)`,
      // Every resizable track may shrink to its minimum, so Actions stays inside the row
      // even when the widths a user set add up to more than the panel (at most ~1250 px).
      author ? `minmax(${COLUMN_BOUNDS.author.min}px,${widths.author}px)` : null,
      stages ? `minmax(${COLUMN_BOUNDS.stages.min}px,${widths.stages}px)` : null,
      actions,
    ]),
  };
}

/** How many stage icons a strip of `width` px shows; the rest become a "+N" count. */
export function visibleStageCount(width: number, total: number): number {
  // Unmeasured (not laid out yet): show everything rather than a bare count.
  if (!(width > 0) || total * STAGE_ICON_PITCH - 2 <= width) return total;
  return Math.max(0, Math.floor((width - OVERFLOW_LABEL_WIDTH + 2) / STAGE_ICON_PITCH));
}
