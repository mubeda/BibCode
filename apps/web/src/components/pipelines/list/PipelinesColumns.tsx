import * as Schema from "effect/Schema";
import { Columns3Icon } from "lucide-react";
import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useResizableWidth, type UseResizableWidthOptions } from "~/hooks/useResizableWidth";
import { Button } from "../../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { PipelineColumnSeparator } from "../shared/PipelineColumnSeparator";
import {
  COLUMN_BOUNDS,
  OPTIONAL_COLUMNS,
  pipelinesGridTemplates,
  type PipelinesColumnId,
} from "./pipelinesColumns.logic";

/**
 * Header and rows read one template per container step from the list root. Cell
 * visibility at each step is the matching `hidden`/`block` pair on both sides.
 */
export const PIPELINES_GRID_CLASS =
  "grid items-center gap-3 px-4 grid-cols-(--pipelines-grid-narrow) @min-[720px]:grid-cols-(--pipelines-grid-compact) @min-[900px]:grid-cols-(--pipelines-grid-medium) @min-[1100px]:grid-cols-(--pipelines-grid-full)";
/** Created by exists only at the full step, before Stages folds. */
export const AUTHOR_CELL_CLASS = "hidden @min-[1100px]:block";

const HIDDEN_KEY = "bibcode:pipelines-list-hidden-columns";
const HiddenSchema = Schema.Array(Schema.Literals(["author", "stages", "timing"]));
const NO_HIDDEN: readonly PipelinesColumnId[] = [];

const columnWidth = (
  column: keyof typeof COLUMN_BOUNDS,
): Pick<UseResizableWidthOptions, "storageKey" | "defaultWidth" | "minWidth" | "maxWidth"> => ({
  storageKey: `bibcode:pipelines-list-${column}-width`,
  defaultWidth: COLUMN_BOUNDS[column].default,
  minWidth: COLUMN_BOUNDS[column].min,
  maxWidth: COLUMN_BOUNDS[column].max,
});

interface ColumnResize {
  readonly width: number;
  readonly handlers: ReturnType<typeof useResizableWidth>["handlers"];
  readonly commitWidth: (width: number) => void;
}

interface ColumnsLayout {
  readonly resize: Record<keyof typeof COLUMN_BOUNDS, ColumnResize>;
  readonly hidden: ReadonlySet<PipelinesColumnId>;
  readonly setColumnShown: (id: PipelinesColumnId, shown: boolean) => void;
}

/** Changes only when a column is shown or hidden, never while one is dragged. */
const ShownColumnsContext = createContext<{
  readonly author: boolean;
  readonly stages: boolean;
  readonly timing: boolean;
}>({ author: true, stages: true, timing: true });
const ColumnsLayoutContext = createContext<ColumnsLayout | null>(null);

export function useShownColumns() {
  return useContext(ShownColumnsContext);
}

/**
 * The list root. It owns the persisted column widths and visibility and paints them as
 * custom properties, so `children` (passed in whole) are not re-rendered by a drag.
 */
export function PipelinesColumnsRoot({
  className,
  children,
}: {
  readonly className: string;
  readonly children: ReactNode;
}) {
  const pipeline = useResizableWidth({ ...columnWidth("pipeline"), edge: "right" });
  const author = useResizableWidth({ ...columnWidth("author"), edge: "right" });
  const stages = useResizableWidth({ ...columnWidth("stages"), edge: "right" });
  const [hiddenList, setHiddenList] = useLocalStorage(HIDDEN_KEY, NO_HIDDEN, HiddenSchema);
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList]);
  const templates = pipelinesGridTemplates(
    { pipeline: pipeline.width, author: author.width, stages: stages.width },
    hidden,
  );
  const shown = useMemo(
    () => ({
      author: !hidden.has("author"),
      stages: !hidden.has("stages"),
      timing: !hidden.has("timing"),
    }),
    [hidden],
  );
  const setColumnShown = (id: PipelinesColumnId, isShown: boolean) =>
    setHiddenList((current) =>
      isShown ? current.filter((value) => value !== id) : [...new Set([...current, id])],
    );
  const layout: ColumnsLayout = {
    resize: {
      pipeline: { ...pipeline },
      author: { ...author },
      stages: { ...stages },
    },
    hidden,
    setColumnShown,
  };
  return (
    <ShownColumnsContext.Provider value={shown}>
      {/* Widths change on every drag frame, so only the header reads this context. */}
      {/* oxlint-disable-next-line react/jsx-no-constructed-context-values */}
      <ColumnsLayoutContext.Provider value={layout}>
        <div
          className={className}
          style={
            {
              "--pipelines-grid-narrow": templates.narrow,
              "--pipelines-grid-compact": templates.compact,
              "--pipelines-grid-medium": templates.medium,
              "--pipelines-grid-full": templates.full,
            } as CSSProperties
          }
        >
          {children}
        </div>
      </ColumnsLayoutContext.Provider>
    </ShownColumnsContext.Provider>
  );
}

function ResizeEdge({ column, label }: { column: keyof typeof COLUMN_BOUNDS; label: string }) {
  const layout = useContext(ColumnsLayoutContext)!;
  const { width, handlers, commitWidth } = layout.resize[column];
  const bounds = COLUMN_BOUNDS[column];
  return (
    <PipelineColumnSeparator
      label={`Resize ${label} column`}
      value={width}
      min={bounds.min}
      max={bounds.max}
      handlers={handlers}
      onResize={commitWidth}
      onReset={() => commitWidth(bounds.default)}
      className="hidden @min-[1100px]:block"
    />
  );
}

const HEADER_CELL = "relative min-w-0 whitespace-nowrap text-xs font-medium text-muted-foreground";

/**
 * Column names above the rows. It sits outside the scrolling list, so it stays put.
 * Rows are `role="row"` under a `role="table"` parent; this is the matching header row.
 */
export function PipelinesListHeader() {
  const layout = useContext(ColumnsLayoutContext)!;
  const { author, stages } = useShownColumns();
  return (
    <div role="rowgroup">
      <div
        role="row"
        aria-rowindex={1}
        className={`${PIPELINES_GRID_CLASS} h-9 border-b border-border bg-background`}
      >
        <div role="columnheader" className={HEADER_CELL}>
          <span className="sr-only @min-[720px]:not-sr-only">Status</span>
        </div>
        <div role="columnheader" className={HEADER_CELL}>
          Pipeline
          <ResizeEdge column="pipeline" label="Pipeline" />
        </div>
        {author ? (
          <div role="columnheader" className={`${HEADER_CELL} ${AUTHOR_CELL_CLASS}`}>
            Created by
            <ResizeEdge column="author" label="Created by" />
          </div>
        ) : null}
        {stages ? (
          <div role="columnheader" className={HEADER_CELL}>
            Stages
            <ResizeEdge column="stages" label="Stages" />
          </div>
        ) : null}
        <div
          role="columnheader"
          className="flex items-center justify-between text-xs font-medium text-muted-foreground"
        >
          <span>Actions</span>
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="Choose columns" />}
            >
              <Columns3Icon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              {OPTIONAL_COLUMNS.map((column) => (
                <MenuCheckboxItem
                  key={column.id}
                  checked={!layout.hidden.has(column.id)}
                  onCheckedChange={(checked) => layout.setColumnShown(column.id, checked)}
                >
                  {column.label}
                </MenuCheckboxItem>
              ))}
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </div>
  );
}
