import { SearchIcon, XIcon } from "lucide-react";
import { useId, useRef, type KeyboardEvent } from "react";

import {
  DIFF_FILE_STATUS_LABELS,
  DIFF_FILE_STATUS_LETTERS,
  EMPTY_DIFF_FILE_FILTERS,
  formatFileCount,
  hasActiveDiffFileFilters,
  type DiffFileFilters,
  type DiffFileRow,
  type DiffStatusFilter,
} from "~/lib/diffCompareModel";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WindowedList, type WindowedListHandle } from "../WindowedList";

/** Every row is exactly this tall; the windowed list depends on it. */
export const DIFF_FILE_ROW_HEIGHT = 28;
const PAGE_ROWS = 10;

const STATUS_OPTIONS: ReadonlyArray<{ readonly value: DiffStatusFilter; readonly label: string }> =
  [
    { value: "all", label: "All" },
    { value: "added", label: DIFF_FILE_STATUS_LABELS.added },
    { value: "modified", label: DIFF_FILE_STATUS_LABELS.modified },
    { value: "deleted", label: DIFF_FILE_STATUS_LABELS.deleted },
    { value: "renamed", label: DIFF_FILE_STATUS_LABELS.renamed },
  ];

const STATUS_TONE: Readonly<Record<DiffFileRow["status"], string>> = {
  added: "text-[var(--diffs-addition-base,var(--success))]",
  modified: "text-[var(--diffs-modified-base,var(--foreground))]",
  deleted: "text-[var(--diffs-deletion-base,var(--destructive))]",
  renamed: "text-[var(--diffs-modified-base,var(--foreground))]",
};

function splitPath(path: string): { readonly directory: string; readonly name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { directory: "", name: path }
    : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** The key that moves the selection, and where to: an index into `rows`, or null to ignore. */
export function nextListIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowDown":
      return Math.min(last, current + 1);
    case "ArrowUp":
      return Math.max(0, current < 0 ? 0 : current - 1);
    case "Home":
      return 0;
    case "End":
      return last;
    case "PageDown":
      return Math.min(last, Math.max(0, current) + PAGE_ROWS);
    case "PageUp":
      return Math.max(0, current - PAGE_ROWS);
    default:
      return null;
  }
}

export interface DiffFileFilterControlsProps {
  readonly filters: DiffFileFilters;
  readonly onFiltersChange: (filters: DiffFileFilters) => void;
  readonly visibleCount: number;
  readonly totalCount: number;
}

/** The name filter and the status choice, with "N of M files" while either narrows the list. */
export function DiffFileFilterControls({
  filters,
  onFiltersChange,
  visibleCount,
  totalCount,
}: DiffFileFilterControlsProps) {
  const filtered = hasActiveDiffFileFilters(filters);
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-2">
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          aria-label="Filter files"
          autoComplete="off"
          className="h-7 w-full rounded-md border border-input bg-background pr-7 pl-7 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Filter files"
          type="search"
          value={filters.query}
          onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filters.query.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              onFiltersChange({ ...filters, query: "" });
            }
          }}
        />
        {filters.query.length === 0 ? null : (
          <Button
            aria-label="Clear name filter"
            className="absolute top-1/2 right-0.5 -translate-y-1/2"
            size="icon-xs"
            variant="ghost"
            onClick={() => onFiltersChange({ ...filters, query: "" })}
          >
            <XIcon aria-hidden="true" className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Select
          items={STATUS_OPTIONS}
          modal={false}
          value={filters.status}
          onValueChange={(value) => {
            if (value) onFiltersChange({ ...filters, status: value as DiffStatusFilter });
          }}
        >
          <SelectTrigger aria-label="Show files with status" className="w-auto min-w-0" size="xs">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {filtered ? (
          <span className="truncate text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {formatFileCount(visibleCount, totalCount)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export interface DiffFileListProps extends DiffFileFilterControlsProps {
  readonly rows: ReadonlyArray<DiffFileRow>;
  readonly selectedKey: string | null;
  readonly onSelect: (row: DiffFileRow) => void;
  readonly className?: string;
}

/**
 * Compare's changed-file list: a listbox whose active row is the selected file. Focus stays on
 * the list, and Up, Down, Home, End, Page Up and Page Down move the selection.
 */
export function DiffFileList({
  rows,
  selectedKey,
  onSelect,
  className,
  ...filterProps
}: DiffFileListProps) {
  const listId = useId();
  const listRef = useRef<WindowedListHandle>(null);
  const selectedIndex =
    selectedKey === null ? -1 : rows.findIndex((row) => row.key === selectedKey);
  const optionId = (index: number) => `${listId}-option-${index}`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = nextListIndex(event.key, selectedIndex, rows.length);
    if (next === null) return;
    event.preventDefault();
    const row = rows[next];
    if (!row) return;
    listRef.current?.scrollToIndex(next);
    if (next !== selectedIndex) onSelect(row);
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <DiffFileFilterControls {...filterProps} />
      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3 text-center">
          <p className="text-xs text-muted-foreground">No files match these filters.</p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => filterProps.onFiltersChange(EMPTY_DIFF_FILE_FILTERS)}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <WindowedList
          {...(selectedIndex < 0 ? {} : { "aria-activedescendant": optionId(selectedIndex) })}
          aria-label="Changed files"
          className="min-h-0 flex-1"
          itemHeight={() => DIFF_FILE_ROW_HEIGHT}
          itemKey={(row) => row.key}
          items={rows}
          listRef={listRef}
          role="listbox"
          textSurface="background"
          onKeyDown={onKeyDown}
          renderItem={(row, index) => (
            <DiffFileListRow
              id={optionId(index)}
              row={row}
              selected={row.key === selectedKey}
              onSelect={onSelect}
            />
          )}
        />
      )}
    </div>
  );
}

function DiffFileListRow({
  id,
  row,
  selected,
  onSelect,
}: {
  readonly id: string;
  readonly row: DiffFileRow;
  readonly selected: boolean;
  readonly onSelect: (row: DiffFileRow) => void;
}) {
  const { directory, name } = splitPath(row.path);
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      title={row.previousPath ? `${row.previousPath} → ${row.path}` : row.path}
      className={cn(
        "flex h-full cursor-pointer select-none items-center gap-2 px-2 text-xs",
        selected ? "bg-accent text-accent-foreground" : "text-foreground/80 hover:bg-muted/60",
      )}
      onClick={() => onSelect(row)}
    >
      <span
        aria-hidden="true"
        className={cn("w-3 shrink-0 text-center font-mono font-medium", STATUS_TONE[row.status])}
      >
        {DIFF_FILE_STATUS_LETTERS[row.status]}
      </span>
      <span className="sr-only">{DIFF_FILE_STATUS_LABELS[row.status]}</span>
      <span className="flex min-w-0 flex-1 items-baseline">
        {directory ? (
          <span className="min-w-0 shrink-[999] truncate text-muted-foreground">{directory}</span>
        ) : null}
        <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
      </span>
      {row.additions > 0 || row.deletions > 0 ? (
        <span className="flex shrink-0 gap-1 font-mono tabular-nums">
          {row.additions > 0 ? (
            <span className="text-[var(--diffs-addition-base,var(--success))]">
              +{row.additions}
            </span>
          ) : null}
          {row.deletions > 0 ? (
            <span className="text-[var(--diffs-deletion-base,var(--destructive))]">
              −{row.deletions}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
