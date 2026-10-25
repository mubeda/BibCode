import { LegendList } from "@legendapp/list/react";
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CircleXIcon,
  ClockIcon,
  InfoIcon,
  TriangleAlertIcon,
  WrapTextIcon,
} from "lucide-react";
import { createContext, memo, use, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useTheme } from "../../../hooks/useTheme";
import { RepositoryModuleExternalLink } from "../../repositoryModule/RepositoryModuleExternalLink";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { PermissionButton } from "../../ui/permission-button";
import { Skeleton } from "../../ui/skeleton";
import { Toggle } from "../../ui/toggle";
import { useRateLimitCountdown } from "../shared/useRateLimitCountdown";
import { formatPipelineDuration } from "../shared/pipelineStatus.logic";
import {
  LINE_ERROR,
  LINE_NOTICE,
  LINE_SECTION,
  LINE_WARNING,
  SEARCH_MATCH_CAP,
  gutterNumber,
  type LogSection,
  type LogSpans,
  type LogStyle,
} from "./jobLog.parse";
import { logPalette, spanPresentation, type LogPalette } from "./jobLogStyle";
import {
  useJobLogController,
  type JobLogControllerOptions,
  type JobLogValue,
} from "./useJobLogController";
import { jobLogStatusCopy, logScrolledToEnd } from "./jobLog.logic";

export type { JobLogSource } from "./useJobLogController";

/** Every row has this height while lines do not wrap, so the list never measures one. */
export const JOB_LOG_ROW_HEIGHT = 20;

const JobLogContext = createContext<JobLogValue | null>(null);

/** The job log's state, actions and meta, for parts rendered inside `JobLog.Provider`. */
export function useJobLog(): JobLogValue {
  const value = use(JobLogContext);
  if (value === null) throw new Error("JobLog parts render inside JobLog.Provider.");
  return value;
}

/**
 * Owns the log: the parser worker, the loaded chunks, follow, search and the view
 * toggles. Its parts read it with `useJobLog`; `source` says whether the job runs.
 */
function Provider({ children, ...options }: JobLogControllerOptions & { children: ReactNode }) {
  const value = useJobLogController(options);
  return <JobLogContext value={value}>{children}</JobLogContext>;
}

function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div
      role="toolbar"
      aria-label="Log"
      className="flex flex-wrap items-center gap-2 border-b border-panel-separator px-3 py-2"
    >
      {children}
    </div>
  );
}

function matchCountLabel(count: number, capped: boolean, active: number): string {
  if (count === 0) return "No matches";
  if (capped) return `${SEARCH_MATCH_CAP.toLocaleString()}+ matches`;
  return `${active < 0 ? 0 : active + 1} of ${count.toLocaleString()}`;
}

/** Search field with previous and next; Enter and Shift+Enter step, Escape returns to the log. */
function Search() {
  const {
    state: { search },
    actions: { setQuery, next, previous, focusLog },
    meta: { searchRef },
  } = useJobLog();
  const hasQuery = search.query.trim() !== "";
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Input
        ref={searchRef}
        type="search"
        size="sm"
        className="w-56"
        aria-label="Search log"
        placeholder="Search log"
        value={search.query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) previous();
            else next();
          } else if (event.key === "Escape") {
            event.preventDefault();
            focusLog();
          }
        }}
      />
      {hasQuery ? (
        <span aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
          {matchCountLabel(search.matches.length, search.capped, search.active)}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        disabled={search.matches.length === 0}
        onClick={previous}
      >
        <ChevronUpIcon aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        disabled={search.matches.length === 0}
        onClick={next}
      >
        <ChevronDownIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

/** Shown only when the log carries timestamps. */
function TimestampsToggle() {
  const {
    state: { layout, timestamps },
    actions: { setTimestamps },
  } = useJobLog();
  if (!layout?.hasTimestamps) return null;
  return (
    <Toggle size="xs" variant="outline" pressed={timestamps} onPressedChange={setTimestamps}>
      <ClockIcon aria-hidden="true" />
      Timestamps
    </Toggle>
  );
}

function WrapToggle() {
  const {
    state: { wrap },
    actions: { setWrap },
  } = useJobLog();
  return (
    <Toggle size="xs" variant="outline" pressed={wrap} onPressedChange={setWrap}>
      <WrapTextIcon aria-hidden="true" />
      Wrap lines
    </Toggle>
  );
}

/** Collapse all, or Expand all once every section is folded. Shown when the log has sections. */
function SectionsToggle() {
  const {
    state: { layout },
    actions: { setAllCollapsed },
  } = useJobLog();
  const sections = layout?.sections ?? [];
  if (sections.length === 0) return null;
  const allCollapsed = sections.every((section) => section.collapsed);
  return (
    <Button size="xs" variant="ghost" onClick={() => setAllCollapsed(!allCollapsed)}>
      {allCollapsed ? (
        <ChevronsUpDownIcon aria-hidden="true" />
      ) : (
        <ChevronsDownUpIcon aria-hidden="true" />
      )}
      {allCollapsed ? "Expand all" : "Collapse all"}
    </Button>
  );
}

function ScrollButtons() {
  const {
    actions: { scrollToTop, scrollToBottom },
  } = useJobLog();
  return (
    <span className="flex items-center gap-0.5">
      <Button variant="ghost" size="icon-xs" aria-label="Scroll to top" onClick={scrollToTop}>
        <ArrowUpToLineIcon aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Scroll to bottom" onClick={scrollToBottom}>
        <ArrowDownToLineIcon aria-hidden="true" />
      </Button>
    </span>
  );
}

function RawLink() {
  const {
    meta: { rawLogUrl },
  } = useJobLog();
  if (rawLogUrl === null) return null;
  return (
    <RepositoryModuleExternalLink href={rawLogUrl} className="ms-auto text-xs">
      Raw log
    </RepositoryModuleExternalLink>
  );
}

/** Earlier text: a button while the host has more, and why line numbers are relative. */
function LoadEarlier() {
  const {
    state: { layout, reader },
    actions: { loadEarlier },
    meta: { canLoadEarlier, rawLogUrl, hostName },
  } = useJobLog();
  if (layout === null) return null;
  const relative = layout.firstLine === null;
  const capped = reader.earlierLimit === "cap" && (reader.range?.start ?? 0) > 0;
  const dropped = reader.truncatedHead && !canLoadEarlier && reader.earlierLimit === "start";
  if (!canLoadEarlier && !capped && !dropped && !relative) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
      {canLoadEarlier ? (
        <PermissionButton
          size="xs"
          variant="outline"
          onClick={loadEarlier}
          permission={{
            allowed: !reader.busy,
            reason: reader.busy ? "Reading the log…" : null,
          }}
        >
          {reader.loadingEarlier ? "Loading earlier lines…" : "Load earlier"}
        </PermissionButton>
      ) : null}
      {relative ? <span>Line numbers start at the first loaded line.</span> : null}
      {capped || dropped ? (
        <span>
          {capped
            ? "Earlier lines are on the host."
            : "This log is over 16 MB; earlier lines are on the host."}
          {rawLogUrl ? (
            <>
              {" "}
              <RepositoryModuleExternalLink href={rawLogUrl}>
                Raw log on {hostName}
              </RepositoryModuleExternalLink>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** `spans` with each case-insensitive occurrence of `needle` marked. */
function markedSpans(
  spans: LogSpans,
  styles: readonly LogStyle[],
  palette: LogPalette,
  needle: string | null,
  active: boolean,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  for (const [text, styleId] of spans) {
    const style = styles[styleId];
    const { className, style: css } = style
      ? spanPresentation(style, palette)
      : { className: undefined, style: undefined };
    if (needle === null) {
      nodes.push(
        <span key={key++} className={className} style={css}>
          {text}
        </span>,
      );
      continue;
    }
    const lower = text.toLowerCase();
    let from = 0;
    let found = lower.indexOf(needle);
    const parts: ReactNode[] = [];
    while (found !== -1) {
      if (found > from) parts.push(text.slice(from, found));
      parts.push(
        <mark
          key={found}
          className={
            active
              ? "rounded-sm bg-amber-400 text-inherit dark:bg-amber-500"
              : "rounded-sm bg-amber-200 text-inherit dark:bg-amber-500/40"
          }
        >
          {text.slice(found, found + needle.length)}
        </mark>,
      );
      from = found + needle.length;
      found = lower.indexOf(needle, from);
    }
    if (from < text.length) parts.push(text.slice(from));
    nodes.push(
      <span key={key++} className={className} style={css}>
        {parts}
      </span>,
    );
  }
  return nodes;
}

const KIND_ICONS = {
  [LINE_ERROR]: { Icon: CircleXIcon, className: "text-red-600 dark:text-red-400", label: "Error" },
  [LINE_WARNING]: {
    Icon: TriangleAlertIcon,
    className: "text-amber-600 dark:text-amber-400",
    label: "Warning",
  },
  [LINE_NOTICE]: { Icon: InfoIcon, className: "text-sky-600 dark:text-sky-400", label: "Notice" },
} as const;

interface JobLogRowProps {
  readonly raw: number;
  readonly number: number;
  readonly kind: number;
  readonly time: number;
  readonly section: LogSection | null;
  readonly spans: LogSpans | undefined;
  readonly styles: readonly LogStyle[];
  readonly palette: LogPalette;
  readonly needle: string | null;
  readonly active: boolean;
  readonly highlighted: boolean;
  readonly showTime: boolean;
  readonly wrap: boolean;
  readonly onToggleSection: (sectionId: number, collapsed: boolean) => void;
  readonly onLink: (raw: number) => void;
  readonly onNeedSpans: (raw: number) => void;
}

const JobLogRow = memo(function JobLogRow({
  raw,
  number,
  kind,
  time,
  section,
  spans,
  styles,
  palette,
  needle,
  active,
  highlighted,
  showTime,
  wrap,
  onToggleSection,
  onLink,
  onNeedSpans,
}: JobLogRowProps) {
  useEffect(() => {
    if (spans === undefined) onNeedSpans(raw);
  }, [onNeedSpans, raw, spans]);
  const content = spans === undefined ? null : markedSpans(spans, styles, palette, needle, active);
  const marker = kind in KIND_ICONS ? KIND_ICONS[kind as keyof typeof KIND_ICONS] : null;
  const text = (
    <span
      className={
        wrap ? "min-w-0 flex-1 whitespace-pre-wrap break-all" : "min-w-0 flex-1 whitespace-pre"
      }
    >
      {content}
    </span>
  );
  return (
    <div
      data-line={number}
      aria-current={highlighted ? "true" : undefined}
      className={`flex items-start font-mono text-xs leading-5 ${
        highlighted
          ? "bg-amber-100 dark:bg-amber-500/20"
          : active
            ? "bg-accent"
            : kind === LINE_ERROR
              ? "bg-red-50 dark:bg-red-500/10"
              : ""
      }`}
      style={wrap ? { minHeight: JOB_LOG_ROW_HEIGHT } : { height: JOB_LOG_ROW_HEIGHT }}
    >
      <button
        type="button"
        aria-label={`Link to line ${number}`}
        className="sticky left-0 w-14 shrink-0 cursor-pointer bg-background pe-3 text-right text-muted-foreground tabular-nums select-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => onLink(raw)}
      >
        {number}
      </button>
      {showTime ? (
        <span
          className="w-18 shrink-0 pe-2 text-muted-foreground tabular-nums select-none"
          title={Number.isNaN(time) ? undefined : new Date(time).toISOString()}
        >
          {Number.isNaN(time) ? "" : timeFormat.format(time)}
        </span>
      ) : null}
      {marker ? (
        <marker.Icon
          aria-label={marker.label}
          className={`mt-0.5 me-1 size-3.5 shrink-0 ${marker.className}`}
        />
      ) : null}
      {section !== null && kind === LINE_SECTION ? (
        <button
          type="button"
          aria-expanded={!section.collapsed}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-1 text-left font-semibold hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => onToggleSection(section.id, !section.collapsed)}
        >
          {section.collapsed ? (
            <ChevronRightIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <ChevronDownIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          )}
          {text}
          {section.durationSeconds !== null ? (
            <span className="shrink-0 ps-2 font-normal text-muted-foreground tabular-nums">
              {formatPipelineDuration(section.durationSeconds)}
            </span>
          ) : null}
        </button>
      ) : (
        text
      )}
    </div>
  );
});

const getRowSize = () => JOB_LOG_ROW_HEIGHT;
const rowKey = (raw: number) => String(raw);

/**
 * The log's rows, virtualized: only the lines on screen are rendered. A running log
 * stays at the bottom while the reader is there; scrolling up offers Jump to latest.
 */
function Lines() {
  const {
    state: { layout, search, highlighted, timestamps, wrap, atBottom, spans, reader },
    actions: { toggleSection, linkLine, requestSpans, setAtBottom, scrollToBottom, loadLater },
    meta: { styles, listRef, logRef, initialOffset, source, canLoadLater },
  } = useJobLog();
  const { resolvedTheme } = useTheme();
  const palette = logPalette(resolvedTheme);
  const rows = useMemo(() => (layout === null ? [] : Array.from(layout.rows)), [layout]);
  const sectionsByHeader = useMemo(() => {
    const byHeader = new Map<number, LogSection>();
    for (const section of layout?.sections ?? []) byHeader.set(section.header, section);
    return byHeader;
  }, [layout]);
  const needle = search.query.trim() === "" ? null : search.query.trim().toLowerCase();
  const matched = useMemo(() => new Set(search.matches), [search.matches]);
  const activeRaw = search.active < 0 ? null : (search.matches[search.active] ?? null);
  const showTime = timestamps && (layout?.hasTimestamps ?? false);
  const renderRow = useCallback(
    ({ item }: { item: number }) => {
      if (layout === null) return null;
      return (
        <JobLogRow
          raw={item}
          number={gutterNumber(layout, item)}
          kind={layout.kinds[item]!}
          time={layout.timestamps[item]!}
          section={sectionsByHeader.get(item) ?? null}
          spans={spans.get(item)}
          styles={styles}
          palette={palette}
          needle={needle !== null && matched.has(item) ? needle : null}
          active={item === activeRaw}
          highlighted={item === highlighted}
          showTime={showTime}
          wrap={wrap}
          onToggleSection={toggleSection}
          onLink={linkLine}
          onNeedSpans={requestSpans}
        />
      );
    },
    [
      activeRaw,
      highlighted,
      layout,
      linkLine,
      matched,
      needle,
      palette,
      requestSpans,
      sectionsByHeader,
      showTime,
      spans,
      styles,
      toggleSection,
      wrap,
    ],
  );
  if (layout === null) return null;
  const linkedRow =
    initialOffset === null || highlighted === null ? -1 : layout.rows.indexOf(highlighted);
  return (
    <div
      ref={logRef}
      tabIndex={-1}
      className="relative min-h-0 flex-1 outline-none"
      style={palette.variables}
    >
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">The log is empty.</p>
      ) : (
        <LegendList<number>
          key={wrap ? "wrap" : "fixed"}
          ref={listRef}
          className="h-full min-h-0 overflow-auto"
          role="log"
          aria-label="Job log"
          data-text-surface="background"
          data={rows}
          // Rows re-render when anything they draw changes, not only their data.
          extraData={renderRow}
          estimatedItemSize={JOB_LOG_ROW_HEIGHT}
          {...(wrap ? {} : { getFixedItemSize: getRowSize })}
          keyExtractor={rowKey}
          renderItem={renderRow}
          maintainScrollAtEnd
          {...(linkedRow >= 0
            ? { initialScrollIndex: { index: linkedRow, viewPosition: 0.4 } }
            : { initialScrollAtEnd: true })}
          onScroll={(event) => setAtBottom(logScrolledToEnd(event.nativeEvent))}
          // A line link opens a finished log mid-way: its later text loads at the end.
          {...(canLoadLater ? { onEndReached: loadLater } : {})}
        />
      )}
      {/* Only a log that still grows has a latest to jump to. */}
      {source._tag === "live" &&
      (reader.phase === "following" || reader.phase === "waiting_start") &&
      !atBottom ? (
        <Button
          size="sm"
          variant="outline"
          className="absolute right-4 bottom-4 shadow-md"
          onClick={() => {
            scrollToBottom();
            setAtBottom(true);
          }}
        >
          <ArrowDownIcon aria-hidden="true" />
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}

/** Loading, live, unavailable and failure states, each with what the reader can do next. */
function Status() {
  const {
    state: { layout, reader },
    actions: { retry },
    meta: { source, hostName, rawLogUrl },
  } = useJobLog();
  const waitSeconds = useRateLimitCountdown(reader.error, retry);
  const copy = jobLogStatusCopy({ source, reader, hostName });
  if (layout === null && (reader.phase === "opening" || reader.phase === "catching_up"))
    return (
      <div role="status" className="space-y-1.5 p-4">
        <span className="sr-only">Loading the log…</span>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  if (copy === null) return null;
  const link = copy.link ? (reader.unavailable?.url ?? rawLogUrl) : null;
  return (
    <div
      role={copy.tone === "error" ? "alert" : "status"}
      className={`space-y-2 px-4 py-3 text-sm ${layout === null ? "" : "border-t border-border"}`}
    >
      <p>{copy.message}</p>
      {waitSeconds !== null ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          Trying again in {waitSeconds} s.
        </p>
      ) : reader.error?.hostDetail ? (
        <p className="text-xs text-muted-foreground">{reader.error.hostDetail}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {copy.retry ? (
          <PermissionButton
            size="sm"
            variant="outline"
            onClick={retry}
            permission={
              waitSeconds !== null
                ? { allowed: false, reason: "The host asked BiBCode to wait before reading again." }
                : { allowed: !reader.busy, reason: reader.busy ? "Reading the log…" : null }
            }
          >
            Retry
          </PermissionButton>
        ) : null}
        {link ? (
          <RepositoryModuleExternalLink href={link} className="text-xs">
            Open on {hostName}
          </RepositoryModuleExternalLink>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A job's log: ANSI colors, line numbers, sections, timestamps, search, line links and
 * follow, over a parser that runs in a worker. Compose the parts inside `Provider`.
 */
export const JobLog = {
  Provider,
  Toolbar,
  Search,
  TimestampsToggle,
  WrapToggle,
  SectionsToggle,
  ScrollButtons,
  RawLink,
  LoadEarlier,
  Lines,
  Status,
};
