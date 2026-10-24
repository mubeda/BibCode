/**
 * The Find in thread controller for one timeline: the query, the scan, the active match, the
 * reveal (open what hides it, scroll the virtualized list to its row, settle on the text) and
 * the highlights. Its working state lives in a session object outside React; the bar
 * re-renders only when the status, the query or the open state changes.
 *
 * Privacy: the query is matched on the main thread and is never passed to `console`, the
 * profiler, storage, a worker or the network.
 */
import type { ServerProviderSkill, TurnId } from "@bibcode/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import type { TimelineEntry } from "../../../session-logic";
import type { ThreadFindLoadState } from "../../../state/threads";
import type { ChatMessage } from "../../../types";
import type { QueuedCardStatus } from "../../ChatView.logic";
import {
  detailsDisclosureKey,
  locateTimelineEntry,
  type MessagesTimelineRow,
  type TimelineDisclosureChange,
  type TimelineDisclosures,
  type TimelineLatestTurn,
} from "../MessagesTimeline.logic";
import {
  claimFindHighlights,
  clearFindHighlights,
  collectRowRanges,
  FIND_ACTIVE_ROW_ATTRIBUTE,
  locateTargetRange,
  MAX_PAINTED_FIND_RANGES,
  ownsFindHighlights,
  paintFindHighlights,
  releaseFindHighlights,
  type FindOccurrenceTarget,
} from "./threadFindHighlights";
import {
  deriveFindEntries,
  firstMatchFrom,
  matchPosition,
  reconcileActiveMatch,
  stepMatch,
  ThreadFindIndex,
  type FindEntry,
  type FindMatch,
  type FindProjector,
  type FindScheduler,
} from "./threadFindIndex";
import { locateFindOccurrences, prepareFindQuery } from "./threadFindText";
import { createWorkerFindProjector } from "./threadFindWorkerProjector";

export type ThreadFindStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "searching" }
  | { readonly kind: "none"; readonly stale: boolean }
  | {
      readonly kind: "match";
      readonly position: number;
      readonly total: number;
      readonly stale: boolean;
    };

/** What the timeline shows, which the controller reads when it scans or reveals. */
export interface ThreadFindInput {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly queuedMessages: ReadonlyArray<ChatMessage>;
  readonly queuedStatuses: ReadonlyArray<QueuedCardStatus>;
  readonly latestTurn: TimelineLatestTurn | null;
  readonly runningTurnId: TurnId | null;
  readonly verboseChat: boolean;
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  readonly cwd: string | undefined;
  readonly disclosures: TimelineDisclosures;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
}

type FindListRef = Pick<
  LegendListRef,
  "getState" | "scrollToIndex" | "scrollToOffset" | "getScrollableNode"
>;

export interface UseThreadFindOptions {
  readonly input: ThreadFindInput;
  /** The thread's state as the client holds it, from its status and error atoms. */
  readonly loadState: ThreadFindLoadState;
  readonly listRef: RefObject<FindListRef | null>;
  /** The element that holds the timeline's rows. */
  readonly timelineElement: HTMLElement | null;
  /** The composer's height over the list's end, outside the visible band. */
  readonly contentInsetEndAdjustment: number;
  readonly changeDisclosures: (change: TimelineDisclosureChange) => void;
  /** Stops live follow and the new-turn anchor from pulling the list. */
  readonly onManualNavigation: () => void;
  readonly onFocusComposer: () => void;
  /** The chat surface's root, for Mod+F routing; the host chat is the default surface. */
  readonly surfaceRoot: HTMLElement | null;
  readonly isHostSurface: boolean;
  readonly projector?: FindProjector;
  readonly scheduler?: FindScheduler;
  readonly nextFrame?: () => Promise<void>;
}

export interface ThreadFindController {
  readonly isOpen: boolean;
  readonly query: string;
  readonly status: ThreadFindStatus;
  /** The bar's input, as a callback ref. */
  readonly attachInput: (input: HTMLInputElement | null) => void;
  open(): void;
  close(): void;
  /** `composing` is true while an IME composes; nothing scans until it ends. */
  setQuery(query: string, composing: boolean): void;
  /** Enter and Shift+Enter: scan at once when typing is pending, else step. */
  submit(direction: "next" | "previous"): void;
  step(direction: "next" | "previous"): void;
}

/** Typing waits this long before rescanning. */
export const FIND_TYPING_DELAY_MS = 120;
/** Live updates recount at most this often. */
export const FIND_RECOUNT_INTERVAL_MS = 300;
const MAX_SETTLE_FRAMES = 10;
const MAX_ROW_WAIT_FRAMES = 5;
/** Where in the viewport a jump lands its row. */
const FIND_SCROLL_VIEW_POSITION = 0.3;
const BAND_MARGIN_PX = 16;

const IDLE: ThreadFindStatus = { kind: "idle" };

function animationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// ---------------------------------------------------------------------------
// Chat surfaces, for routing Mod+F and the command palette
// ---------------------------------------------------------------------------

interface ThreadFindSurface {
  readonly root: HTMLElement;
  readonly isHost: boolean;
  readonly open: () => void;
  readonly focusInput: () => void;
}

const surfaces = new Set<ThreadFindSurface>();

function surfaceFor(target: EventTarget | null): ThreadFindSurface | null {
  if (target instanceof Node) {
    for (const surface of surfaces) {
      if (surface.root.contains(target)) return surface;
    }
  }
  for (const surface of surfaces) {
    if (surface.isHost) return surface;
  }
  return null;
}

/** Opens find in the chat surface that holds `target`, or the host chat. */
export function openThreadFindForTarget(target: EventTarget | null): boolean {
  const surface = surfaceFor(target);
  if (!surface) return false;
  surface.open();
  return true;
}

/** Focuses the find input of the surface that holds `target`, or the host chat's. */
export function focusThreadFindInput(target: EventTarget | null): boolean {
  const surface = surfaceFor(target);
  if (!surface) return false;
  surface.focusInput();
  return true;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

interface ActiveReveal {
  readonly rowId: string;
  readonly target: FindOccurrenceTarget;
}

interface PendingScroll {
  readonly generation: number;
  readonly rowId: string;
  readonly index: number;
}

type ScanKind = "new" | "extend" | "recount";

interface SessionCallbacks {
  readonly setOpen: (open: boolean) => void;
  readonly setQuery: (query: string) => void;
  readonly setStatus: (status: ThreadFindStatus) => void;
}

class ThreadFindSession {
  readonly #token = Symbol("thread-find");
  readonly #callbacks: SessionCallbacks;
  #index: ThreadFindIndex | null = null;
  #open = false;
  #query = "";
  #scannedQuery: string | null = null;
  #entries: ReadonlyArray<FindEntry> = [];
  #counts: ReadonlyArray<number> | null = null;
  #active: FindMatch | null = null;
  #reveal: ActiveReveal | null = null;
  #scanSignal: { aborted: boolean } | null = null;
  #generation = 0;
  #typingTimer: ReturnType<typeof setTimeout> | null = null;
  #recountTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingScroll: PendingScroll | null = null;
  #composing = false;
  #rowRanges = new Map<Element, Range[]>();
  #observer: MutationObserver | null = null;
  #paintFrame: number | null = null;
  #markedRow: Element | null = null;
  #latestOptions: UseThreadFindOptions | null = null;
  #input: HTMLInputElement | null = null;
  #dataIdentity: ReadonlyArray<unknown> = [];

  constructor(callbacks: SessionCallbacks) {
    this.#callbacks = callbacks;
  }

  /** The latest props, set after each commit; work only starts from effects and events. */
  setOptions(options: UseThreadFindOptions): void {
    this.#latestOptions = options;
  }

  get #options(): UseThreadFindOptions {
    if (!this.#latestOptions) throw new Error("Find in thread was used before it mounted.");
    return this.#latestOptions;
  }

  readonly attachInput = (input: HTMLInputElement | null): void => {
    this.#input = input;
  };

  focusInput(): void {
    this.#input?.focus();
    this.#input?.select();
  }

  #setStatus(status: ThreadFindStatus): void {
    this.#callbacks.setStatus(status);
  }

  #frame(): Promise<void> {
    return (this.#options.nextFrame ?? animationFrame)();
  }

  #ensureIndex(): ThreadFindIndex {
    this.#index ??= new ThreadFindIndex({
      projector: this.#options.projector ?? createWorkerFindProjector(),
      ...(this.#options.scheduler ? { scheduler: this.#options.scheduler } : {}),
    });
    return this.#index;
  }

  // -- open and close ------------------------------------------------------

  open(): void {
    if (this.#open) {
      this.focusInput();
      return;
    }
    this.#open = true;
    claimFindHighlights(this.#token, () => this.close({ focusComposer: false }));
    this.#callbacks.setOpen(true);
    this.#observe();
    this.#runSearch("new");
  }

  close(options: { focusComposer: boolean } = { focusComposer: true }): void {
    if (!this.#open) return;
    this.#open = false;
    this.#cancelWork();
    this.#supersedePendingScroll();
    this.#clearPaint();
    releaseFindHighlights(this.#token);
    this.#callbacks.setOpen(false);
    if (options.focusComposer) {
      this.#focusComposerOrTimeline();
    }
  }

  dispose(): void {
    if (this.#open) {
      this.#open = false;
      this.#cancelWork();
      this.#supersedePendingScroll();
      this.#clearPaint();
    }
    // Unmounting a surface that does not own the highlights leaves them alone.
    releaseFindHighlights(this.#token);
    this.#index?.dispose();
    this.#index = null;
  }

  #focusComposerOrTimeline(): void {
    const { onFocusComposer } = this.#options;
    onFocusComposer();
    void this.#frame().then(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const timeline = this.#options.timelineElement;
      if (!timeline) return;
      if (!timeline.hasAttribute("tabindex")) timeline.setAttribute("tabindex", "-1");
      timeline.focus({ preventScroll: true });
    });
  }

  #cancelWork(): void {
    this.#generation += 1;
    if (this.#scanSignal) this.#scanSignal.aborted = true;
    this.#scanSignal = null;
    if (this.#typingTimer !== null) clearTimeout(this.#typingTimer);
    this.#typingTimer = null;
    if (this.#recountTimer !== null) clearTimeout(this.#recountTimer);
    this.#recountTimer = null;
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#paintFrame !== null) cancelAnimationFrame(this.#paintFrame);
    this.#paintFrame = null;
  }

  // -- query ---------------------------------------------------------------

  setQuery(query: string, composing: boolean): void {
    const previous = this.#query;
    this.#query = query;
    this.#callbacks.setQuery(query);
    this.#composing = composing;
    if (composing) return;
    if (this.#typingTimer !== null) clearTimeout(this.#typingTimer);
    const kind: ScanKind =
      previous.length > 0 && query.startsWith(previous) && this.#active !== null ? "extend" : "new";
    this.#typingTimer = setTimeout(() => {
      this.#typingTimer = null;
      this.#runSearch(kind);
    }, FIND_TYPING_DELAY_MS);
  }

  submit(direction: "next" | "previous"): void {
    if (this.#composing) return;
    if (this.#typingTimer !== null) {
      clearTimeout(this.#typingTimer);
      this.#typingTimer = null;
      this.#runSearch(this.#active === null ? "new" : "extend");
      return;
    }
    this.step(direction);
  }

  step(direction: "next" | "previous"): void {
    if (this.#composing || !this.#counts || !this.#open) return;
    const counts = { entries: this.#entries, counts: this.#counts };
    const next = this.#active
      ? stepMatch(counts, this.#active, direction)
      : firstMatchFrom(counts, 0);
    if (!next) return;
    this.#active = next;
    this.#publishMatchStatus();
    void this.#navigate(next);
  }

  // -- data and load state -------------------------------------------------

  /**
   * Called with the timeline's data after each commit; when it changed, recounts at most every
   * 300 ms while find is in use.
   */
  noteData(identity: ReadonlyArray<unknown>): void {
    const changed =
      identity.length !== this.#dataIdentity.length ||
      identity.some((value, index) => value !== this.#dataIdentity[index]);
    this.#dataIdentity = identity;
    if (!changed) return;
    if (!this.#open || this.#scannedQuery === null || this.#recountTimer !== null) return;
    this.#recountTimer = setTimeout(() => {
      this.#recountTimer = null;
      this.#runSearch("recount");
    }, FIND_RECOUNT_INTERVAL_MS);
  }

  /** Called when the thread's status, error or held data changes. */
  noteLoadState(_loadState: UseThreadFindOptions["loadState"]): void {
    if (!this.#open) return;
    if (this.#options.loadState.status === "deleted") {
      this.close({ focusComposer: false });
      return;
    }
    this.#runSearch(this.#counts ? "recount" : "new");
  }

  #isStale(): boolean {
    const { status, hasData } = this.#options.loadState;
    return status === "cached" || (status === "synchronizing" && hasData);
  }

  #loadStatus(): ThreadFindStatus | null {
    const { status, error, hasData } = this.#options.loadState;
    if (status === "empty" || (status === "synchronizing" && !hasData)) {
      return error ? { kind: "unavailable" } : { kind: "loading" };
    }
    return null;
  }

  // -- scanning ------------------------------------------------------------

  #runSearch(kind: ScanKind): void {
    if (!this.#open) return;
    if (this.#scanSignal) this.#scanSignal.aborted = true;
    this.#scanSignal = null;
    const loadStatus = this.#loadStatus();
    if (loadStatus) {
      this.#resetResults();
      this.#setStatus(loadStatus);
      return;
    }
    const folded = prepareFindQuery(this.#query);
    if (folded === null) {
      this.#resetResults();
      this.#setStatus(IDLE);
      return;
    }
    const options = this.#options;
    const entries = deriveFindEntries({
      timelineEntries: options.input.timelineEntries,
      queuedMessages: options.input.queuedMessages,
      queuedStatuses: options.input.queuedStatuses,
      skills: options.input.skills,
    });
    const previousOrder = this.#entries.map((entry) => entry.entryId);
    const startIndex =
      kind === "extend" && this.#active
        ? Math.max(
            0,
            entries.findIndex((entry) => entry.entryId === this.#active?.entryId),
          )
        : kind === "new"
          ? this.#viewportEntryIndex(entries)
          : 0;
    const signal = { aborted: false };
    this.#scanSignal = signal;
    if (this.#scannedQuery !== folded) {
      this.#setStatus({ kind: "searching" });
    }
    let navigated = false;
    const index = this.#ensureIndex();
    void index
      .scan({
        entries,
        context: { cwd: options.input.cwd },
        query: folded,
        startIndex,
        signal,
        onFirstMatch: (entryIndex) => {
          if (kind === "recount") return;
          // The first match is shown as soon as it is found; the total follows.
          navigated = true;
          this.#entries = entries;
          this.#scannedQuery = folded;
          this.#active = { entryId: entries[entryIndex]!.entryId, occurrence: 0 };
          this.#counts = null;
          void this.#navigate(this.#active);
        },
      })
      .then((outcome) => {
        if (!outcome || signal.aborted || !this.#open) return;
        this.#scanSignal = null;
        this.#entries = entries;
        this.#counts = outcome.counts;
        this.#scannedQuery = folded;
        this.#rowRanges.clear();
        if (outcome.total === 0) {
          this.#active = null;
          this.#reveal = null;
          this.#supersedePendingScroll();
          this.#setStatus({ kind: "none", stale: this.#isStale() });
          this.#schedulePaint();
          return;
        }
        const counts = { entries, counts: outcome.counts };
        if (kind === "recount" && this.#active) {
          // The selection stays put; only its row and text position are read again.
          this.#active = reconcileActiveMatch(counts, this.#active, previousOrder);
          this.#reveal = this.#active ? this.#revealFor(this.#active) : null;
        } else if (!navigated || this.#active === null) {
          this.#active = firstMatchFrom(counts, startIndex);
          if (this.#active) void this.#navigate(this.#active);
        } else if (matchPosition(counts, this.#active) === null) {
          this.#active = firstMatchFrom(counts, startIndex);
          if (this.#active) void this.#navigate(this.#active);
        }
        this.#publishMatchStatus();
        this.#schedulePaint();
      });
  }

  #resetResults(): void {
    this.#generation += 1;
    this.#counts = null;
    this.#active = null;
    this.#reveal = null;
    this.#scannedQuery = null;
    this.#supersedePendingScroll();
    this.#clearPaint();
  }

  #publishMatchStatus(): void {
    if (!this.#counts || !this.#active) return;
    const counts = { entries: this.#entries, counts: this.#counts };
    const position = matchPosition(counts, this.#active);
    let total = 0;
    for (const count of this.#counts) total += count;
    if (position === null) return;
    this.#setStatus({ kind: "match", position: position + 1, total, stale: this.#isStale() });
  }

  /** The first entry at or below the top of the viewport. */
  #viewportEntryIndex(entries: ReadonlyArray<FindEntry>): number {
    const state = this.#options.listRef.current?.getState?.();
    const rows = this.#options.input.rows;
    const startRow = typeof state?.start === "number" ? Math.max(0, state.start) : 0;
    const byId = new Map<string, number>();
    for (const [index, entry] of entries.entries()) {
      byId.set(entry.entryId, index);
      byId.set(entry.disclosureId, index);
    }
    const timeline = this.#options.input.timelineEntries;
    const timelinePosition = new Map(timeline.map((entry, index) => [entry.id, index]));
    const workLogPosition = new Map(
      timeline.flatMap((entry, index) =>
        entry.kind === "work" ? [[entry.entry.id, index] as const] : [],
      ),
    );
    // An entry the find list skips maps to the next one it lists.
    const nextListedAt = (position: number): number | null => {
      for (let cursor = position; cursor < timeline.length; cursor += 1) {
        const index = byId.get(timeline[cursor]!.id);
        if (index !== undefined) return index;
      }
      return null;
    };
    for (let rowIndex = startRow; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!;
      const position =
        row.kind === "turn-fold"
          ? timelinePosition.get(row.anchorEntryId)
          : row.kind === "work"
            ? workLogPosition.get(row.groupedEntries[0]?.id ?? "")
            : row.kind === "message" || row.kind === "proposed-plan"
              ? timelinePosition.get(row.id)
              : undefined;
      if (position !== undefined) {
        const listed = nextListedAt(position);
        if (listed !== null) return listed;
      }
      if (row.kind === "queued-message") {
        const listed = byId.get(row.id);
        if (listed !== undefined) return listed;
      }
    }
    return 0;
  }

  // -- revealing -------------------------------------------------------------

  #targetFor(match: FindMatch): { entry: FindEntry; target: FindOccurrenceTarget } | null {
    const entry = this.#entries.find((candidate) => candidate.entryId === match.entryId);
    const folded = this.#scannedQuery;
    if (!entry || folded === null || !this.#index) return null;
    const segments = this.#index.cachedEntrySegments(entry, { cwd: this.#options.input.cwd });
    if (!segments) return null;
    const occurrences = locateFindOccurrences(segments, folded);
    const occurrence = occurrences[match.occurrence];
    if (!occurrence) return null;
    const { scope, details } = occurrence.segment;
    let index = 0;
    for (let cursor = 0; cursor < match.occurrence; cursor += 1) {
      const earlier = occurrences[cursor]!.segment;
      if (
        earlier.scope === scope &&
        earlier.details.length === details.length &&
        earlier.details.every((ordinal, position) => ordinal === details[position])
      ) {
        index += 1;
      }
    }
    return { entry, target: { scope, details, index } };
  }

  #locate(entry: FindEntry) {
    const { input } = this.#options;
    return locateTimelineEntry(entry.entryId, {
      timelineEntries: input.timelineEntries,
      queuedMessages: input.queuedMessages,
      queuedStatuses: input.queuedStatuses,
      latestTurn: input.latestTurn,
      runningTurnId: input.runningTurnId,
      turnFoldChoices: input.disclosures.turns,
      workGroupChoices: input.disclosures.groups,
      verboseChat: input.verboseChat,
    });
  }

  /** Where the match is now, without opening or scrolling anything. */
  #revealFor(match: FindMatch): ActiveReveal | null {
    const resolved = this.#targetFor(match);
    if (!resolved) return null;
    const location = this.#locate(resolved.entry);
    return location.kind === "found" ? { rowId: location.rowId, target: resolved.target } : null;
  }

  async #navigate(match: FindMatch): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    const options = this.#options;
    const resolved = this.#targetFor(match);
    const location = resolved ? this.#locate(resolved.entry) : null;
    if (!resolved || !location || location.kind === "absent") {
      this.#reveal = null;
      return;
    }
    const { entry, target } = resolved;
    const entryChanges: Array<readonly [string, string, boolean]> = target.details.map(
      (ordinal) => [entry.disclosureId, detailsDisclosureKey(target.scope, ordinal), true] as const,
    );
    if (entry.reveal?.scopes.has(target.scope)) {
      entryChanges.push([entry.disclosureId, entry.reveal.key, true]);
    }
    // One update opens everything the plan names, so the row exists when the list renders.
    options.changeDisclosures({
      ...(location.openTurnId ? { turns: [[location.openTurnId, true] as const] } : {}),
      ...(location.openGroupId ? { groups: [[location.openGroupId, true] as const] } : {}),
      entries: entryChanges,
    });
    this.#reveal = { rowId: location.rowId, target };
    this.#clearRing();
    await this.#scrollToRow(generation, location.rowId);
  }

  async #scrollToRow(generation: number, rowId: string): Promise<void> {
    let index: number | undefined;
    for (let frame = 0; frame < MAX_ROW_WAIT_FRAMES; frame += 1) {
      await this.#frame();
      if (generation !== this.#generation) return;
      index = this.#options.listRef.current?.getState?.().indexByKey(rowId);
      if (index !== undefined) break;
    }
    const list = this.#options.listRef.current;
    if (!list || index === undefined) return;
    this.#options.onManualNavigation();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.#pendingScroll = { generation, rowId, index };
      await list.scrollToIndex({ index, animated: false, viewPosition: FIND_SCROLL_VIEW_POSITION });
      if (generation !== this.#generation) return;
      this.#pendingScroll = null;
      const current = list.getState().indexByKey(rowId);
      if (current === index) {
        await this.#settle(generation, rowId);
        return;
      }
      if (current === undefined) break;
      // A turn folded, a row streamed in or a resync replaced the rows: once more.
      index = current;
    }
    this.#markRow(rowId);
  }

  #supersedePendingScroll(): void {
    const pending = this.#pendingScroll;
    this.#pendingScroll = null;
    if (!pending) return;
    const list = this.#options.listRef.current;
    if (!list) return;
    // A new imperative scroll cancels LegendList's deferred one and leaves the list in place.
    void list.scrollToOffset({ offset: list.getState().scroll, animated: false });
  }

  #rowElement(rowId: string): Element | null {
    const timeline = this.#options.timelineElement;
    if (!timeline) return null;
    for (const row of timeline.querySelectorAll("[data-timeline-row-id]")) {
      if (row.getAttribute("data-timeline-row-id") === rowId) return row;
    }
    return null;
  }

  async #settle(generation: number, rowId: string): Promise<void> {
    const reveal = this.#reveal;
    const folded = this.#scannedQuery;
    if (!reveal || folded === null) return;
    let range: Range | null = null;
    let previous: DOMRect | null = null;
    let stableFrames = 0;
    for (let frame = 0; frame < MAX_SETTLE_FRAMES; frame += 1) {
      await this.#frame();
      if (generation !== this.#generation) return;
      const row = this.#rowElement(rowId);
      range = row ? locateTargetRange(row, reveal.target, folded) : null;
      if (!range) continue;
      const rect = range.getBoundingClientRect();
      if (
        previous &&
        rect.top === previous.top &&
        rect.left === previous.left &&
        rect.height === previous.height
      ) {
        stableFrames += 1;
        if (stableFrames >= 2) break;
      } else {
        stableFrames = 0;
      }
      previous = rect;
    }
    if (generation !== this.#generation) return;
    if (!range) {
      // The text never rendered where the projection put it: mark the row instead.
      this.#markRow(rowId);
      this.#schedulePaint();
      return;
    }
    this.#scrollIntoBand(range);
    this.#schedulePaint();
  }

  #scrollIntoBand(range: Range): void {
    const row = range.startContainer.parentElement?.closest("[data-timeline-row-id]") ?? null;
    // Inner scrollers first: a code block's horizontal scroll, a tool row's clamped block.
    for (
      let element = range.startContainer.parentElement;
      element && element !== row;
      element = element.parentElement
    ) {
      if (
        element.scrollHeight <= element.clientHeight &&
        element.scrollWidth <= element.clientWidth
      ) {
        continue;
      }
      const box = element.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      if (rect.top < box.top || rect.bottom > box.bottom) {
        element.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
      }
      if (rect.left < box.left || rect.right > box.right) {
        element.scrollLeft += rect.left - box.left - (box.width - rect.width) / 2;
      }
    }
    const list = this.#options.listRef.current;
    const scroller = list?.getScrollableNode?.() as HTMLElement | null | undefined;
    if (!list || !scroller || typeof scroller.getBoundingClientRect !== "function") return;
    const band = scroller.getBoundingClientRect();
    const top = band.top + BAND_MARGIN_PX;
    const bottom = band.bottom - this.#options.contentInsetEndAdjustment - BAND_MARGIN_PX;
    const rect = range.getBoundingClientRect();
    let delta = 0;
    if (rect.top < top) delta = rect.top - top;
    else if (rect.bottom > bottom) delta = rect.bottom - bottom;
    if (Math.abs(delta) >= 1) {
      void list.scrollToOffset({ offset: list.getState().scroll + delta, animated: false });
    }
  }

  // -- painting --------------------------------------------------------------

  #observe(): void {
    const timeline = this.#options.timelineElement;
    if (!timeline || this.#observer || typeof MutationObserver === "undefined") return;
    this.#observer = new MutationObserver((records) => {
      for (const record of records) {
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        const row = element?.closest("[data-timeline-row-id]");
        if (row) this.#rowRanges.delete(row);
        for (const removed of record.removedNodes) {
          if (removed instanceof Element) this.#rowRanges.delete(removed);
        }
      }
      this.#schedulePaint();
    });
    this.#observer.observe(timeline, { childList: true, subtree: true, characterData: true });
  }

  #schedulePaint(): void {
    if (this.#paintFrame !== null || !this.#open) return;
    this.#paintFrame = requestAnimationFrame(() => {
      this.#paintFrame = null;
      this.#paint();
    });
  }

  #paint(): void {
    const folded = this.#scannedQuery;
    const timeline = this.#options.timelineElement;
    if (!this.#open || folded === null || !timeline || !ownsFindHighlights(this.#token)) {
      return;
    }
    const rows = [...timeline.querySelectorAll("[data-timeline-row-id]")];
    const reveal = this.#reveal;
    const activeRowIndex = reveal
      ? rows.findIndex((row) => row.getAttribute("data-timeline-row-id") === reveal.rowId)
      : -1;
    const activeRow = activeRowIndex >= 0 ? rows[activeRowIndex]! : null;
    const active =
      activeRow && reveal && this.#active
        ? locateTargetRange(activeRow, reveal.target, folded)
        : null;
    const ordered =
      activeRowIndex >= 0
        ? rows
            .map((row, index) => ({ row, distance: Math.abs(index - activeRowIndex) }))
            .toSorted((a, b) => a.distance - b.distance)
            .map(({ row }) => row)
        : rows;
    const inactive: Range[] = [];
    for (const row of ordered) {
      let ranges = this.#rowRanges.get(row);
      if (!ranges) {
        ranges = collectRowRanges(row, folded);
        this.#rowRanges.set(row, ranges);
      }
      for (const range of ranges) {
        if (inactive.length >= MAX_PAINTED_FIND_RANGES) break;
        if (
          active &&
          range.startContainer === active.startContainer &&
          range.startOffset === active.startOffset
        ) {
          continue;
        }
        inactive.push(range);
      }
    }
    const painted = paintFindHighlights(this.#token, inactive, active);
    if (!painted && reveal && this.#active) {
      this.#markRow(reveal.rowId);
    }
  }

  /** The fallback emphasis: a ring on the active match's row. */
  #markRow(rowId: string): void {
    const row = this.#rowElement(rowId);
    if (row === this.#markedRow) return;
    this.#clearRing();
    if (!row) return;
    row.setAttribute(FIND_ACTIVE_ROW_ATTRIBUTE, "");
    this.#markedRow = row;
  }

  #clearRing(): void {
    this.#markedRow?.removeAttribute(FIND_ACTIVE_ROW_ATTRIBUTE);
    this.#markedRow = null;
  }

  #clearPaint(): void {
    this.#rowRanges.clear();
    this.#clearRing();
    clearFindHighlights(this.#token);
  }
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useThreadFind(options: UseThreadFindOptions): ThreadFindController {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ThreadFindStatus>(IDLE);
  const [session] = useState(
    () => new ThreadFindSession({ setOpen: setIsOpen, setQuery, setStatus }),
  );
  useLayoutEffect(() => {
    session.setOptions(options);
  });

  useEffect(() => () => session.dispose(), [session]);

  const { timelineEntries, queuedMessages, queuedStatuses } = options.input;
  useEffect(() => {
    session.noteData([timelineEntries, queuedMessages, queuedStatuses]);
  }, [queuedMessages, queuedStatuses, session, timelineEntries]);

  const { loadState } = options;
  useEffect(() => {
    session.noteLoadState(loadState);
  }, [loadState, session]);

  const { surfaceRoot, isHostSurface } = options;
  useEffect(() => {
    if (!surfaceRoot) return;
    const surface: ThreadFindSurface = {
      root: surfaceRoot,
      isHost: isHostSurface,
      open: () => session.open(),
      focusInput: () => session.focusInput(),
    };
    surfaces.add(surface);
    return () => {
      surfaces.delete(surface);
    };
  }, [isHostSurface, session, surfaceRoot]);

  // A newly opened bar takes focus with its last query selected.
  useLayoutEffect(() => {
    if (isOpen) session.focusInput();
  }, [isOpen, session]);

  return {
    isOpen,
    query,
    status,
    attachInput: session.attachInput,
    open: () => session.open(),
    close: () => session.close(),
    setQuery: (next, composing) => session.setQuery(next, composing),
    submit: (direction) => session.submit(direction),
    step: (direction) => session.step(direction),
  };
}
