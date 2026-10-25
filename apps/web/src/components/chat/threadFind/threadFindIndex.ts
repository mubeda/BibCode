/**
 * Find in thread's index of one timeline: which entries it searches and what text each one
 * shows, a projection cache keyed by content, the scan that counts a query in slices, and the
 * selection rules for moving between matches.
 *
 * The query never leaves this module's callers: projections do not depend on it, so a worker
 * that projects a large entry receives only the entry's text.
 */
import type { ServerProviderSkill } from "@bibcode/contracts";
import { isQueuedTimelineMessage, type QueuedCardStatus } from "../../ChatView.logic";
import { workEntryIndicatesToolNeutralStatus, type TimelineEntry } from "../../../session-logic";
import {
  proposedPlanCanCollapse,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../../proposedPlan";
import type { ChatMessage } from "../../../types";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import {
  MESSAGE_BODY_DISCLOSURE_KEY,
  PROPOSED_PLAN_DISCLOSURE_KEY,
  queuedMessageRowId,
  TOOL_ROW_DISCLOSURE_KEY,
  toolCallDisplayedCommand,
} from "../MessagesTimeline.logic";
import {
  deriveSentUserMessageBody,
  deriveUserMessageBodyLayout,
  shouldCollapseUserMessage,
  userMessageMarkdownParts,
} from "../userMessageBody";
import {
  ASSISTANT_MESSAGE_FIND_SCOPE,
  markdownFindScope,
  PLAN_BODY_FIND_SCOPE,
  PLAN_TITLE_FIND_SCOPE,
  TOOL_COMMAND_FIND_SCOPE,
} from "./threadFindScopes";
import {
  countFindOccurrences,
  projectFindSource,
  type FindProjectionContext,
  type FindSegment,
  type FindSource,
} from "./threadFindText";

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** One searchable entry, in timeline row order. */
export interface FindEntry {
  /** The timeline entry id (a queued message's row id), as `locateTimelineEntry` takes it. */
  readonly entryId: string;
  /** The id the entry's own disclosures live under: a tool row's work entry id. */
  readonly disclosureId: string;
  readonly sources: ReadonlyArray<FindSource>;
  /** The entry's own disclosure that hides these scopes' text until it opens. */
  readonly reveal: { readonly key: string; readonly scopes: ReadonlySet<string> } | null;
}

export interface FindEntriesInput {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly queuedMessages?: ReadonlyArray<ChatMessage> | undefined;
  readonly queuedStatuses?: ReadonlyArray<QueuedCardStatus> | undefined;
  readonly skills: ReadonlyArray<InlineSkill>;
}

function userBodySources(
  bodyText: string,
  terminalContexts: Parameters<typeof deriveUserMessageBodyLayout>[1],
  skills: ReadonlyArray<InlineSkill>,
): FindSource[] {
  return userMessageMarkdownParts(deriveUserMessageBodyLayout(bodyText, terminalContexts)).map(
    (part, index) => ({
      kind: "markdown",
      scope: markdownFindScope(index),
      text: part.text,
      lineBreaks: true,
      skills,
    }),
  );
}

function userBodyEntry(entryId: string, bodyText: string, sources: FindSource[]): FindEntry | null {
  if (sources.length === 0) return null;
  return {
    entryId,
    disclosureId: entryId,
    sources,
    // The clip is layout; any match in a body long enough to clip opens it.
    reveal: shouldCollapseUserMessage(bodyText)
      ? {
          key: MESSAGE_BODY_DISCLOSURE_KEY,
          scopes: new Set(sources.map((source) => source.scope)),
        }
      : null,
  };
}

const PLAN_BODY_SCOPES: ReadonlySet<string> = new Set([PLAN_BODY_FIND_SCOPE]);
const COMMAND_SCOPES: ReadonlySet<string> = new Set([TOOL_COMMAND_FIND_SCOPE]);

/**
 * The entries a timeline can show, with the text each renders: what
 * `deriveMessagesTimelineRows` shows, queued messages last, without tool calls whose status is
 * neutral, system notes, or text that is not searched (tool output, changed files, attachments,
 * terminal-context chips, review-comment cards, an empty reply's placeholder).
 */
export function deriveFindEntries(input: FindEntriesInput): FindEntry[] {
  const entries: FindEntry[] = [];
  for (const timelineEntry of input.timelineEntries) {
    if (timelineEntry.kind === "message") {
      const { message } = timelineEntry;
      if (isQueuedTimelineMessage(message)) continue;
      if (message.role === "assistant") {
        if (message.text.length === 0) continue;
        entries.push({
          entryId: timelineEntry.id,
          disclosureId: timelineEntry.id,
          sources: [
            {
              kind: "markdown",
              scope: ASSISTANT_MESSAGE_FIND_SCOPE,
              text: message.text,
              lineBreaks: false,
              skills: input.skills,
              streaming: message.streaming,
            },
          ],
          reveal: null,
        });
      } else if (message.role === "user") {
        const body = deriveSentUserMessageBody(message.text);
        const entry = userBodyEntry(
          timelineEntry.id,
          body.bodyText,
          userBodySources(body.bodyText, body.terminalContexts, input.skills),
        );
        if (entry) entries.push(entry);
      }
      continue;
    }
    if (timelineEntry.kind === "proposed-plan") {
      const { planMarkdown } = timelineEntry.proposedPlan;
      const title = proposedPlanTitle(planMarkdown);
      const sources: FindSource[] = [];
      if (title) {
        sources.push({ kind: "plain", scope: PLAN_TITLE_FIND_SCOPE, text: title });
      }
      // The plan card renders without skills.
      sources.push({
        kind: "markdown",
        scope: PLAN_BODY_FIND_SCOPE,
        text: stripDisplayedPlanMarkdown(planMarkdown),
        lineBreaks: false,
        skills: [],
      });
      entries.push({
        entryId: timelineEntry.id,
        disclosureId: timelineEntry.id,
        sources,
        // The preview is different text; any match in the body opens the plan.
        reveal: proposedPlanCanCollapse(planMarkdown)
          ? { key: PROPOSED_PLAN_DISCLOSURE_KEY, scopes: PLAN_BODY_SCOPES }
          : null,
      });
      continue;
    }
    const workEntry = timelineEntry.entry;
    if (workEntryIndicatesToolNeutralStatus(workEntry)) continue;
    const command = toolCallDisplayedCommand(workEntry);
    if (!command) continue;
    entries.push({
      entryId: timelineEntry.id,
      disclosureId: workEntry.id,
      sources: [{ kind: "plain", scope: TOOL_COMMAND_FIND_SCOPE, text: command }],
      reveal: { key: TOOL_ROW_DISCLOSURE_KEY, scopes: COMMAND_SCOPES },
    });
  }

  for (const [index, message] of (input.queuedMessages ?? []).entries()) {
    if (!input.queuedStatuses?.[index]) continue;
    const displayed = deriveDisplayedUserMessageState(message.text);
    const entry = userBodyEntry(
      queuedMessageRowId(message.id),
      displayed.visibleText,
      userBodySources(displayed.visibleText, displayed.contexts, input.skills),
    );
    if (entry) entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Projection and scheduling
// ---------------------------------------------------------------------------

/** Projects one source; may answer later, as a worker does for a large entry. */
export interface FindProjector {
  project(
    source: FindSource,
    context: FindProjectionContext,
  ): FindSegment[] | Promise<FindSegment[]>;
  dispose?(): void;
}

export const synchronousFindProjector: FindProjector = {
  project: projectFindSource,
};

export interface FindScheduler {
  now(): number;
  /** Lets the main thread run input and paint before the scan continues. */
  yield(): Promise<void>;
}

function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") {
    return scheduler.yield();
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener("message", () => {
      channel.port1.close();
      resolve();
    });
    // A port started by addEventListener needs an explicit start.
    channel.port1.start();
    channel.port2.postMessage(null);
  });
}

export const browserFindScheduler: FindScheduler = {
  now: () => performance.now(),
  yield: yieldToMain,
};

/** A scheduling target between entries; one entry's parse is one synchronous call. */
export const FIND_SLICE_BUDGET_MS = 8;

interface CachedProjection {
  readonly segments: FindSegment[];
  usedByScan: number;
}

function skillsKey(skills: ReadonlyArray<InlineSkill>): string {
  return skills.map((skill) => `${skill.name}\u0001${skill.displayName ?? ""}`).join("\u0002");
}

/** Everything a source's projection depends on except its text. */
function sourceContextKey(source: FindSource, context: FindProjectionContext): string {
  return source.kind === "plain"
    ? `plain\u0000${source.scope}`
    : [
        "markdown",
        source.scope,
        source.lineBreaks ? "1" : "0",
        source.streaming === true ? "1" : "0",
        context.cwd ?? "",
        skillsKey(source.skills),
      ].join("\u0000");
}

export interface FindScanRequest {
  readonly entries: ReadonlyArray<FindEntry>;
  readonly context: FindProjectionContext;
  /** The folded query (`prepareFindQuery`). */
  readonly query: string;
  /** The entry index the scan starts at; it wraps around to cover every entry. */
  readonly startIndex: number;
  readonly signal: { readonly aborted: boolean };
  /** Called once with the first entry, in scan order, that holds a match. */
  readonly onFirstMatch?: (entryIndex: number) => void;
}

export interface FindScanOutcome {
  /** Occurrences per entry, parallel to the request's entries. */
  readonly counts: ReadonlyArray<number>;
  readonly total: number;
}

/**
 * One timeline's projection cache and scanner. The cache is keyed by content and render
 * context, not by object, because work entries are re-derived as new objects on every change.
 */
export class ThreadFindIndex {
  readonly #projector: FindProjector;
  readonly #scheduler: FindScheduler;
  /** By context key, then by text, so a key never copies the text. */
  readonly #cache = new Map<string, Map<string, CachedProjection>>();
  /** Projections a worker has not answered yet, keyed like the cache. */
  readonly #inFlight = new Map<string, Map<string, Promise<FindSegment[]>>>();
  #scanGeneration = 0;

  constructor(options: { projector?: FindProjector; scheduler?: FindScheduler } = {}) {
    this.#projector = options.projector ?? synchronousFindProjector;
    this.#scheduler = options.scheduler ?? browserFindScheduler;
  }

  #cached(source: FindSource, context: FindProjectionContext): CachedProjection | undefined {
    return this.#cache.get(sourceContextKey(source, context))?.get(source.text);
  }

  #store(source: FindSource, context: FindProjectionContext, segments: FindSegment[]): void {
    const key = sourceContextKey(source, context);
    let byText = this.#cache.get(key);
    if (!byText) {
      byText = new Map();
      this.#cache.set(key, byText);
    }
    byText.set(source.text, { segments, usedByScan: this.#scanGeneration });
  }

  /** Remembers a pending projection until it settles, so a later scan awaits it, not a copy. */
  #trackInFlight(key: string, text: string, projected: Promise<FindSegment[]>): void {
    let byText = this.#inFlight.get(key);
    if (!byText) {
      byText = new Map();
      this.#inFlight.set(key, byText);
    }
    byText.set(text, projected);
    const settle = () => {
      const current = this.#inFlight.get(key);
      if (current?.get(text) !== projected) return;
      current.delete(text);
      if (current.size === 0) this.#inFlight.delete(key);
    };
    projected.then(settle, settle);
  }

  /** The cached projection of an entry, or null when one of its sources is not projected yet. */
  cachedEntrySegments(entry: FindEntry, context: FindProjectionContext): FindSegment[] | null {
    const segments: FindSegment[] = [];
    for (const source of entry.sources) {
      const cached = this.#cached(source, context);
      if (!cached) return null;
      segments.push(...cached.segments);
    }
    return segments;
  }

  /** Projects an entry's sources, from the cache where it can. */
  async entrySegments(entry: FindEntry, context: FindProjectionContext): Promise<FindSegment[]> {
    const segments: FindSegment[] = [];
    for (const source of entry.sources) {
      const cached = this.#cached(source, context);
      if (cached) {
        cached.usedByScan = this.#scanGeneration;
        segments.push(...cached.segments);
        continue;
      }
      const key = sourceContextKey(source, context);
      const inFlight = this.#inFlight.get(key)?.get(source.text);
      const projected = inFlight ?? this.#projector.project(source, context);
      let resolved: FindSegment[];
      if (projected instanceof Promise) {
        if (!inFlight) this.#trackInFlight(key, source.text, projected);
        resolved = await projected;
      } else {
        resolved = projected;
      }
      // Kept even when the scan that asked was superseded: the next one reuses it.
      if (!this.#cached(source, context)) this.#store(source, context, resolved);
      segments.push(...resolved);
    }
    return segments;
  }

  /**
   * Counts the query in every entry, from `startIndex` to the end and then from the start,
   * yielding between entries once a slice has run its budget. Returns null when aborted.
   */
  async scan(request: FindScanRequest): Promise<FindScanOutcome | null> {
    this.#scanGeneration += 1;
    const { entries } = request;
    const counts: number[] = Array.from({ length: entries.length }, () => 0);
    const start =
      entries.length === 0 ? 0 : Math.min(Math.max(0, request.startIndex), entries.length - 1);
    let firstReported = false;
    let sliceStart = this.#scheduler.now();
    for (let step = 0; step < entries.length; step += 1) {
      const index = (start + step) % entries.length;
      const entry = entries[index]!;
      const segments =
        this.cachedEntrySegments(entry, request.context) ??
        (await this.entrySegments(entry, request.context));
      if (request.signal.aborted) return null;
      for (const source of entry.sources) {
        const cached = this.#cached(source, request.context);
        if (cached) cached.usedByScan = this.#scanGeneration;
      }
      const count = countFindOccurrences(segments, request.query);
      counts[index] = count;
      if (count > 0 && !firstReported) {
        firstReported = true;
        request.onFirstMatch?.(index);
      }
      if (this.#scheduler.now() - sliceStart >= FIND_SLICE_BUDGET_MS) {
        await this.#scheduler.yield();
        if (request.signal.aborted) return null;
        sliceStart = this.#scheduler.now();
      }
    }
    this.#evictUnused();
    let total = 0;
    for (const count of counts) total += count;
    return { counts, total };
  }

  /** Drops what the last complete scan did not use, so memory stays within this thread. */
  #evictUnused(): void {
    for (const [key, byText] of this.#cache) {
      for (const [text, cached] of byText) {
        if (cached.usedByScan !== this.#scanGeneration) byText.delete(text);
      }
      if (byText.size === 0) this.#cache.delete(key);
    }
  }

  /** The number of projected sources held, for tests. */
  get cachedSourceCount(): number {
    let count = 0;
    for (const byText of this.#cache.values()) count += byText.size;
    return count;
  }

  dispose(): void {
    this.#cache.clear();
    this.#inFlight.clear();
    this.#projector.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** A match, by its entry and its occurrence in that entry, not by its global index. */
export interface FindMatch {
  readonly entryId: string;
  readonly occurrence: number;
}

export interface FindCounts {
  readonly entries: ReadonlyArray<Pick<FindEntry, "entryId">>;
  readonly counts: ReadonlyArray<number>;
}

/** The first match in an entry at or after `startIndex`, wrapping to the first match. */
export function firstMatchFrom(counts: FindCounts, startIndex: number): FindMatch | null {
  const length = counts.entries.length;
  if (length === 0) return null;
  const start = Math.min(Math.max(0, startIndex), length - 1);
  for (let step = 0; step < length; step += 1) {
    const index = (start + step) % length;
    if ((counts.counts[index] ?? 0) > 0) {
      return { entryId: counts.entries[index]!.entryId, occurrence: 0 };
    }
  }
  return null;
}

/** The match's 0-based position among all matches, or null when it is not one. */
export function matchPosition(counts: FindCounts, match: FindMatch): number | null {
  let position = 0;
  for (let index = 0; index < counts.entries.length; index += 1) {
    const count = counts.counts[index] ?? 0;
    if (counts.entries[index]!.entryId === match.entryId) {
      return match.occurrence < count ? position + match.occurrence : null;
    }
    position += count;
  }
  return null;
}

/** The next or previous match, wrapping at both ends. */
export function stepMatch(
  counts: FindCounts,
  match: FindMatch,
  direction: "next" | "previous",
): FindMatch | null {
  const length = counts.entries.length;
  const index = counts.entries.findIndex((entry) => entry.entryId === match.entryId);
  if (index === -1) return firstMatchFrom(counts, 0);
  const count = counts.counts[index] ?? 0;
  if (direction === "next" && match.occurrence + 1 < count) {
    return { entryId: match.entryId, occurrence: match.occurrence + 1 };
  }
  if (direction === "previous" && match.occurrence > 0 && match.occurrence - 1 < count) {
    return { entryId: match.entryId, occurrence: Math.min(match.occurrence, count) - 1 };
  }
  for (let step = 1; step <= length; step += 1) {
    const candidate =
      direction === "next" ? (index + step) % length : (index - step + length * 2) % length;
    const candidateCount = counts.counts[candidate] ?? 0;
    if (candidateCount > 0) {
      return {
        entryId: counts.entries[candidate]!.entryId,
        occurrence: direction === "next" ? 0 : candidateCount - 1,
      };
    }
  }
  return null;
}

/**
 * Keeps the active match across a recount. Matches that arrive before it change its position
 * but not the selection; when its occurrence is gone, the next match is selected. An entry that
 * vanished is placed by `previousOrder`, the entry ids before the recount.
 */
export function reconcileActiveMatch(
  counts: FindCounts,
  active: FindMatch,
  previousOrder: ReadonlyArray<string>,
): FindMatch | null {
  const index = counts.entries.findIndex((entry) => entry.entryId === active.entryId);
  if (index !== -1) {
    if (active.occurrence < (counts.counts[index] ?? 0)) return active;
    return stepMatch(
      counts,
      { entryId: active.entryId, occurrence: Number.MAX_SAFE_INTEGER },
      "next",
    );
  }
  const previousIndex = previousOrder.indexOf(active.entryId);
  if (previousIndex === -1) return firstMatchFrom(counts, 0);
  const surviving = new Map(counts.entries.map((entry, entryIndex) => [entry.entryId, entryIndex]));
  for (let next = previousIndex + 1; next < previousOrder.length; next += 1) {
    const survivingIndex = surviving.get(previousOrder[next]!);
    if (survivingIndex !== undefined) return firstMatchFrom(counts, survivingIndex);
  }
  return firstMatchFrom(counts, 0);
}
