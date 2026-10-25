import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import {
  PullRequestsOperationError,
  type EnvironmentId,
  type PipelinesLogUnavailableReason,
} from "@bibcode/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { isChatFindFallbackShortcut } from "../../../keybindings";
import { pipelinesEnvironment } from "../../../state/pipelines";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useDocumentVisible } from "../../pullRequests/useDocumentVisible";
import { lineAtOffset, type JobLogLayout, type LogSpans, type LogStyle } from "./jobLog.parse";
import { createJobLogEngine, type JobLogEngine } from "./jobLogEngine";
import {
  INITIAL_JOB_LOG_READER_STATE,
  JobLogReader,
  type JobLogReaderState,
  type LogReadAnswer,
  type LogReadInput,
} from "./jobLogReader";

/**
 * What the log shows, from the job's own state: a running job's log is followed, a
 * finished one read once, and an erased one never read.
 */
export type JobLogSource =
  | {
      readonly _tag: "live";
      readonly jobId: number;
      readonly attempt: number | null;
      /** The job has started, so a missing log means no output yet. */
      readonly started: boolean;
    }
  | { readonly _tag: "complete"; readonly jobId: number; readonly attempt: number | null }
  | {
      readonly _tag: "unavailable";
      readonly reason: PipelinesLogUnavailableReason;
      readonly url: string | null;
    };

export interface JobLogSearchState {
  readonly query: string;
  readonly matches: Int32Array;
  readonly capped: boolean;
  /** Index into `matches`, or -1. */
  readonly active: number;
}

const EMPTY_MATCHES = new Int32Array(0);
const EMPTY_SEARCH: JobLogSearchState = {
  query: "",
  matches: EMPTY_MATCHES,
  capped: false,
  active: -1,
};
const SEARCH_DEBOUNCE_MS = 150;
/** Rows rendered around a missing one in a single spans request. */
const SPAN_WINDOW = 100;
/** Rendered rows kept with their spans before the cache starts over. */
const SPAN_CACHE_CAP = 5_000;
const EMPTY_SPANS: ReadonlyMap<number, LogSpans> = new Map();
const isOperationError = Schema.is(PullRequestsOperationError);

export interface JobLogValue {
  readonly state: {
    readonly layout: JobLogLayout | null;
    readonly reader: JobLogReaderState;
    readonly search: JobLogSearchState;
    readonly atBottom: boolean;
    readonly timestamps: boolean;
    readonly wrap: boolean;
    /** The linked line's raw index, or null. */
    readonly highlighted: number | null;
    /** Bumps whenever new spans arrive. */
    /** The spans of the rows rendered so far, a new map whenever more arrive. */
    readonly spans: ReadonlyMap<number, LogSpans>;
  };
  readonly actions: {
    readonly setQuery: (query: string) => void;
    readonly next: () => void;
    readonly previous: () => void;
    readonly toggleSection: (sectionId: number, collapsed: boolean) => void;
    readonly setAllCollapsed: (collapsed: boolean) => void;
    readonly setTimestamps: (on: boolean) => void;
    readonly setWrap: (on: boolean) => void;
    readonly scrollToTop: () => void;
    readonly scrollToBottom: () => void;
    readonly setAtBottom: (atBottom: boolean) => void;
    readonly loadEarlier: () => void;
    /** Reads a finished log's text after the loaded window, once its end is reached. */
    readonly loadLater: () => void;
    readonly retry: () => void;
    readonly linkLine: (index: number) => void;
    readonly requestSpans: (index: number) => void;
    readonly focusSearch: () => void;
    readonly focusLog: () => void;
  };
  readonly meta: {
    readonly source: JobLogSource;
    readonly styles: readonly LogStyle[];
    readonly rawLogUrl: string | null;
    readonly hostName: string;
    readonly canLoadEarlier: boolean;
    readonly canLoadLater: boolean;
    readonly initialOffset: number | null;
    readonly listRef: React.RefObject<LegendListRef | null>;
    readonly searchRef: React.RefObject<HTMLInputElement | null>;
    readonly logRef: React.RefObject<HTMLDivElement | null>;
  };
}

export interface JobLogControllerOptions {
  readonly source: JobLogSource;
  readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  /** A line link's byte offset; read once, so a later link only highlights. */
  readonly initialOffset: number | null;
  readonly rawLogUrl: string | null;
  readonly hostName: string;
  readonly onLineLink: (offset: number) => void;
  readonly createEngine?: (onLost: () => void) => JobLogEngine;
}

/**
 * The job log's state: the parser engine, the reader that follows the host, search,
 * the view toggles and follow. Only `JobLog.Provider` calls it.
 */
export function useJobLogController({
  source,
  scope,
  initialOffset: requestedOffset,
  rawLogUrl,
  hostName,
  onLineLink,
  createEngine,
}: JobLogControllerOptions): JobLogValue {
  const { environmentId, cwd } = scope;
  const [initialOffset] = useState(requestedOffset);
  const runRead = useAtomCommand(pipelinesEnvironment.getJobLog, {
    reportFailure: false,
    reportDefect: false,
  });
  const [readerState, setReaderState] = useState<JobLogReaderState>(INITIAL_JOB_LOG_READER_STATE);
  const [layout, setLayout] = useState<JobLogLayout | null>(null);
  const [styles, setStyles] = useState<readonly LogStyle[]>([]);
  const [spans, setSpans] = useState<ReadonlyMap<number, LogSpans>>(EMPTY_SPANS);
  const [search, setSearch] = useState<JobLogSearchState>(EMPTY_SEARCH);
  const [atBottom, setAtBottom] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  // Bumps when loaded text changes (not when a section folds), for spans and search.
  const [contentVersion, setContentVersion] = useState(0);
  const contentRef = useRef(0);
  const engineRef = useRef<JobLogEngine | null>(null);
  const readerRef = useRef<JobLogReader | null>(null);
  const spansRef = useRef(new Map<number, LogSpans>());
  const pendingSpansRef = useRef(new Set<number>());
  const layoutRef = useRef<JobLogLayout | null>(null);
  const scrollTargetRef = useRef<number | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const readable = source._tag !== "unavailable";
  const jobId = readable ? source.jobId : null;
  const attempt = readable ? source.attempt : null;
  const live = source._tag === "live";

  const read = useEffectEvent(
    async (input: LogReadInput, signal: AbortSignal): Promise<LogReadAnswer> => {
      if (jobId === null) return { _tag: "interrupted" };
      const result = await runRead(
        { environmentId, input: { cwd, jobId, attempt, from: input.from, refresh: input.refresh } },
        { signal },
      );
      if (result._tag === "Success") return { _tag: "answer", log: result.value };
      if (isAtomCommandInterrupted(result)) return { _tag: "interrupted" };
      const failure = squashAtomCommandFailure(result);
      const error = isOperationError(failure) ? failure : null;
      return {
        _tag: "failure",
        error,
        message: error?.message ?? "BiBCode couldn't read this log. Try again.",
      };
    },
  );
  const currentlyLive = useEffectEvent(() => live);
  const linkOffset = useEffectEvent(() => initialOffset);
  const make = useEffectEvent((onLost: () => void) =>
    createEngine ? createEngine(onLost) : createJobLogEngine({ onLost }),
  );

  // The job page and the module shell remount this view for another environment,
  // checkout or job, so the reader lives as long as the job and its attempt.
  const readKey = jobId === null ? null : `${jobId}:${attempt ?? ""}`;
  useEffect(() => {
    if (readKey === null) return;
    let reader: JobLogReader | null = null;
    // A worker that stopped answering leaves an empty main-thread parser: read again.
    const engine = make(() => reader?.open());
    reader = new JobLogReader({
      read: (input, signal) => read(input, signal),
      engine,
      live: currentlyLive(),
      at: linkOffset(),
      onLayout: (next) => {
        // New text: every row's spans are rendered again from the new parse.
        spansRef.current = new Map();
        setSpans(EMPTY_SPANS);
        contentRef.current += 1;
        layoutRef.current = next;
        setLayout(next);
        setContentVersion(contentRef.current);
      },
      onState: setReaderState,
    });
    engineRef.current = engine;
    readerRef.current = reader;
    reader.open();
    return () => {
      reader?.dispose();
      engine.dispose();
      engineRef.current = null;
      readerRef.current = null;
      layoutRef.current = null;
      spansRef.current = new Map();
      setSpans(EMPTY_SPANS);
      setLayout(null);
      setReaderState(INITIAL_JOB_LOG_READER_STATE);
      setSearch(EMPTY_SEARCH);
    };
  }, [readKey]);

  useEffect(() => {
    readerRef.current?.setLive(live);
  }, [live]);

  // Follow reads run only while the page is visible.
  const visible = useDocumentVisible();
  useEffect(() => {
    readerRef.current?.setVisible(visible);
  }, [visible]);

  // The linked line is highlighted until the reader links another.
  const linkedLine = useMemo(() => {
    if (layout === null || initialOffset === null) return null;
    const index = lineAtOffset(layout.byteStarts, initialOffset);
    return index === -1 ? null : index;
  }, [initialOffset, layout]);
  const shownHighlight = highlighted ?? linkedLine;

  // Search runs in the engine, again whenever the log's text changes.
  const query = search.query;
  const hasLayout = layout !== null;
  useEffect(() => {
    const engine = engineRef.current;
    if (engine === null || !hasLayout || query.trim() === "") return;
    let cancelled = false;
    // A search of text that has since changed is answered again for the new text.
    const searched = contentVersion;
    const timer = window.setTimeout(() => {
      void engine.search(query).then((result) => {
        if (cancelled || searched !== contentRef.current) return;
        setSearch((current) =>
          current.query !== query
            ? current
            : {
                query,
                matches: result.matches,
                capped: result.capped,
                active:
                  result.matches.length === 0
                    ? -1
                    : Math.min(Math.max(current.active, 0), result.matches.length - 1),
              },
        );
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [contentVersion, hasLayout, query]);

  const scrollToRaw = useCallback((raw: number) => {
    const current = layoutRef.current;
    if (current === null) return;
    const row = current.rows.indexOf(raw);
    if (row === -1) return;
    void listRef.current?.scrollToIndex({ index: row, viewPosition: 0.4, animated: false });
  }, []);

  // A revealed match scrolls once its expanded layout is on screen.
  useEffect(() => {
    const target = scrollTargetRef.current;
    if (target === null || layout === null) return;
    scrollTargetRef.current = null;
    scrollToRaw(target);
  }, [layout, scrollToRaw]);

  const goToMatch = useCallback(
    (active: number) => {
      const { matches } = search;
      if (matches.length === 0) return;
      // Next and previous wrap around the ends.
      const wrapped = (active + matches.length) % matches.length;
      const raw = matches[wrapped]!;
      setSearch({ ...search, active: wrapped });
      const engine = engineRef.current;
      if (layoutRef.current?.rows.includes(raw) ?? false) scrollToRaw(raw);
      else if (engine !== null) {
        // A match inside a folded section opens it first.
        scrollTargetRef.current = raw;
        void engine.reveal(raw).then((nextLayout) => {
          layoutRef.current = nextLayout;
          setLayout(nextLayout);
        });
      }
    },
    [scrollToRaw, search],
  );
  const activeMatch = search.active;
  const next = useCallback(() => goToMatch(activeMatch + 1), [activeMatch, goToMatch]);
  const previous = useCallback(
    () => goToMatch(activeMatch < 0 ? -1 : activeMatch - 1),
    [activeMatch, goToMatch],
  );

  const relayout = useCallback((run: (engine: JobLogEngine) => Promise<JobLogLayout>) => {
    const engine = engineRef.current;
    if (engine === null) return;
    void run(engine).then((nextLayout) => {
      layoutRef.current = nextLayout;
      setLayout(nextLayout);
    });
  }, []);
  const toggleSection = useCallback(
    (sectionId: number, collapsed: boolean) =>
      relayout((engine) => engine.setCollapsed(sectionId, collapsed)),
    [relayout],
  );
  const setAllCollapsed = useCallback(
    (collapsed: boolean) => relayout((engine) => engine.setAllCollapsed(collapsed)),
    [relayout],
  );

  const flushSpans = useCallback(() => {
    const engine = engineRef.current;
    const current = layoutRef.current;
    const wanted = pendingSpansRef.current;
    pendingSpansRef.current = new Set();
    if (engine === null || current === null || wanted.size === 0) return;
    // One request covers the rows around every missing one, so a scroll fills at once.
    const indices = new Set<number>();
    for (const raw of wanted) {
      const row = current.rows.indexOf(raw);
      if (row === -1) continue;
      const from = Math.max(0, row - SPAN_WINDOW);
      const to = Math.min(current.rows.length, row + SPAN_WINDOW);
      for (let index = from; index < to; index += 1) {
        const line = current.rows[index]!;
        if (!spansRef.current.has(line)) indices.add(line);
      }
    }
    if (indices.size === 0) return;
    const content = contentRef.current;
    void engine.render([...indices]).then((rendered) => {
      // Spans of text that has since been replaced are dropped; folding keeps them.
      if (contentRef.current !== content) return;
      // A long scroll would grow the map without bound: past the cap it starts over
      // from the rows just rendered.
      const next = new Map(spansRef.current.size >= SPAN_CACHE_CAP ? [] : spansRef.current);
      for (const [line, lineSpans] of rendered.spans) next.set(line, lineSpans);
      spansRef.current = next;
      setStyles(rendered.styles);
      setSpans(next);
    });
  }, []);
  const requestSpans = useCallback(
    (raw: number) => {
      const pending = pendingSpansRef.current;
      if (pending.size === 0) queueMicrotask(flushSpans);
      pending.add(raw);
    },
    [flushSpans],
  );

  const scrollToTop = useCallback(() => {
    void listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);
  const scrollToBottom = useCallback(() => {
    void listRef.current?.scrollToEnd({ animated: false });
  }, []);
  const loadEarlier = useCallback(() => readerRef.current?.loadEarlier(), []);
  const loadLater = useCallback(() => readerRef.current?.loadLater(), []);
  const retry = useCallback(() => readerRef.current?.retry(), []);
  const linkLine = useCallback(
    (raw: number) => {
      const offset = layoutRef.current?.byteStarts[raw];
      if (offset === undefined) return;
      setHighlighted(raw);
      onLineLink(offset);
    },
    [onLineLink],
  );
  const setQuery = useCallback(
    (value: string) =>
      setSearch((current) =>
        value.trim() === ""
          ? { query: value, matches: EMPTY_MATCHES, capped: false, active: -1 }
          : { ...current, query: value, active: -1 },
      ),
    [],
  );
  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);
  const focusLog = useCallback(() => logRef.current?.focus(), []);

  // Mod+F searches the log while the job page is open. Find in thread lives in the
  // chat view, which module routes do not mount, so one press is handled once.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isChatFindFallbackShortcut(event)) return;
      event.preventDefault();
      focusSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusSearch]);

  const canLoadEarlier =
    readerState.range !== null && readerState.range.start > 0 && readerState.earlierLimit === null;
  const canLoadLater =
    readerState.range !== null &&
    !live &&
    !readerState.complete &&
    !readerState.busy &&
    !readerState.laterExhausted &&
    readerState.phase === "done";

  return useMemo<JobLogValue>(
    () => ({
      state: {
        layout,
        reader: readerState,
        search,
        atBottom,
        timestamps,
        wrap,
        highlighted: shownHighlight,
        spans,
      },
      actions: {
        setQuery,
        next,
        previous,
        toggleSection,
        setAllCollapsed,
        setTimestamps,
        setWrap,
        scrollToTop,
        scrollToBottom,
        setAtBottom,
        loadEarlier,
        loadLater,
        retry,
        linkLine,
        requestSpans,
        focusSearch,
        focusLog,
      },
      meta: {
        source,
        styles,
        rawLogUrl,
        hostName,
        canLoadEarlier,
        canLoadLater,
        initialOffset,
        listRef,
        searchRef,
        logRef,
      },
    }),
    [
      atBottom,
      canLoadEarlier,
      canLoadLater,
      focusLog,
      focusSearch,
      shownHighlight,
      hostName,
      initialOffset,
      layout,
      linkLine,
      loadEarlier,
      loadLater,
      next,
      previous,
      rawLogUrl,
      readerState,
      requestSpans,
      retry,
      scrollToBottom,
      scrollToTop,
      search,
      setAllCollapsed,
      setQuery,
      source,
      spans,
      styles,
      timestamps,
      toggleSection,
      wrap,
    ],
  );
}
