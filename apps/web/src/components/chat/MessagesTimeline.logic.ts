import * as Equal from "effect/Equal";
import {
  formatDuration,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@bibcode/contracts";
import { latestThoughtLine } from "@bibcode/client-runtime/state/reasoning";
import { isQueuedTimelineMessage, type QueuedCardStatus } from "../ChatView.logic";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
}

/** LegendList keeps a timeline that follows its end there as rows arrive, grow, or the view resizes. */
const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true },
};

/**
 * Whether LegendList keeps the timeline at its end itself. Not while a sent turn is anchored,
 * which ChatView follows, and not once the reader has scrolled away: LegendList would otherwise
 * move the list to its end whenever the bottom region (the composer, the Activity card) changes
 * height while the list sits within its end threshold, or while the thread is shorter than the
 * view, taking the line the reader reads away.
 */
export function resolveTimelineMaintainScrollAtEnd(input: {
  readonly anchored: boolean;
  readonly followsEnd: boolean;
}): typeof TIMELINE_MAINTAIN_SCROLL_AT_END | false {
  return input.anchored || !input.followsEnd ? false : TIMELINE_MAINTAIN_SCROLL_AT_END;
}

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  return state?.isNearEnd ?? state?.isAtEnd;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

/** How far below the viewport top a minimap jump lands a turn's first row. */
export const TIMELINE_MINIMAP_JUMP_OFFSET = 24;

export type TimelineMinimapStep = "previous" | "next";

/**
 * The nearest turns whose jump would scroll up or down from `scrollTop`; null where none would
 * move. Partway through a turn, the previous step returns to that turn's start.
 *
 * `itemTops` are the list's row positions, which start below its header (`listStartOffset`);
 * a jump to a row scrolls past that header too, so each jump lands that much further down.
 */
export function resolveTimelineMinimapStepTargets(input: {
  readonly itemTops: ReadonlyArray<number | null>;
  readonly scrollTop: number;
  readonly maxScrollTop: number;
  readonly listStartOffset?: number;
}): Record<TimelineMinimapStep, number | null> {
  const listStartOffset = input.listStartOffset ?? 0;
  let previous: number | null = null;
  let next: number | null = null;
  for (const [index, top] of input.itemTops.entries()) {
    if (top === null) {
      continue;
    }
    const jumpTop = Math.min(
      input.maxScrollTop,
      Math.max(0, top + listStartOffset - TIMELINE_MINIMAP_JUMP_OFFSET),
    );
    if (jumpTop < input.scrollTop - 1) {
      previous = index;
    } else if (jumpTop > input.scrollTop + 1 && next === null) {
      next = index;
    }
  }
  return { previous, next };
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

/**
 * An entry's own open or closed choices, by key: its tool row, its long body, its plan, and
 * each `<details>` block in its Markdown. A key with no choice keeps the default.
 */
export type EntryDisclosure = ReadonlyMap<string, boolean>;

export const TOOL_ROW_DISCLOSURE_KEY = "tool";
export const MESSAGE_BODY_DISCLOSURE_KEY = "body";
export const PROPOSED_PLAN_DISCLOSURE_KEY = "plan";

export function detailsDisclosureKey(scope: string, ordinal: number): string {
  return `details:${scope}:${ordinal}`;
}

const NO_DETAILS_OPEN: ReadonlyMap<number, boolean> = new Map();
const detailsOpenByDisclosure = new WeakMap<
  EntryDisclosure,
  Map<string, ReadonlyMap<number, boolean>>
>();

/**
 * The open state of one Markdown part's `<details>` blocks, by ordinal. The same disclosure
 * and scope always give the same map, so a memoized `ChatMarkdown` keeps its props.
 */
export function detailsOpenForScope(
  disclosure: EntryDisclosure | undefined,
  scope: string,
): ReadonlyMap<number, boolean> {
  if (!disclosure) return NO_DETAILS_OPEN;
  let byScope = detailsOpenByDisclosure.get(disclosure);
  if (!byScope) {
    byScope = new Map();
    detailsOpenByDisclosure.set(disclosure, byScope);
  }
  const cached = byScope.get(scope);
  if (cached) return cached;
  const prefix = `details:${scope}:`;
  const open = new Map<number, boolean>();
  for (const [key, value] of disclosure) {
    if (!key.startsWith(prefix)) continue;
    const ordinal = Number(key.slice(prefix.length));
    if (Number.isSafeInteger(ordinal)) open.set(ordinal, value);
  }
  const result = open.size > 0 ? open : NO_DETAILS_OPEN;
  byScope.set(scope, result);
  return result;
}

/**
 * Every open or closed choice in one timeline: turn folds, long work groups, and each entry's
 * own disclosures. One owner holds them, so a find reveal and the reader's own toggle write the
 * same state, and a row keeps its choice when the list unmounts and remounts it.
 */
export interface TimelineDisclosures {
  readonly turns: ReadonlyMap<TurnId, boolean>;
  readonly groups: ReadonlyMap<string, boolean>;
  readonly entries: ReadonlyMap<string, EntryDisclosure>;
}

export const EMPTY_TIMELINE_DISCLOSURES: TimelineDisclosures = {
  turns: new Map(),
  groups: new Map(),
  entries: new Map(),
};

export interface TimelineDisclosureChange {
  readonly turns?: ReadonlyArray<readonly [TurnId, boolean]>;
  readonly groups?: ReadonlyArray<readonly [string, boolean]>;
  /** `[entryId, key, open]`. */
  readonly entries?: ReadonlyArray<readonly [string, string, boolean]>;
}

function withChoices<K>(
  current: ReadonlyMap<K, boolean>,
  choices: ReadonlyArray<readonly [K, boolean]> | undefined,
): ReadonlyMap<K, boolean> {
  if (!choices || choices.every(([key, value]) => current.get(key) === value)) return current;
  const next = new Map(current);
  for (const [key, value] of choices) next.set(key, value);
  return next;
}

/**
 * Applies a change, keeping every map it does not touch, so only the rows whose disclosures
 * changed get new row objects. Returns `current` when nothing changes.
 */
export function applyTimelineDisclosureChange(
  current: TimelineDisclosures,
  change: TimelineDisclosureChange,
): TimelineDisclosures {
  const turns = withChoices(current.turns, change.turns);
  const groups = withChoices(current.groups, change.groups);
  let entries = current.entries;
  if (change.entries && change.entries.length > 0) {
    const byEntry = new Map<string, Array<readonly [string, boolean]>>();
    for (const [entryId, key, open] of change.entries) {
      const list = byEntry.get(entryId) ?? [];
      list.push([key, open]);
      byEntry.set(entryId, list);
    }
    let nextEntries: Map<string, EntryDisclosure> | null = null;
    for (const [entryId, choices] of byEntry) {
      const existing = current.entries.get(entryId) ?? new Map<string, boolean>();
      const updated = withChoices(existing, choices);
      if (updated === existing && current.entries.has(entryId)) continue;
      nextEntries ??= new Map(current.entries);
      nextEntries.set(entryId, updated);
    }
    if (nextEntries) entries = nextEntries;
  }
  return turns === current.turns && groups === current.groups && entries === current.entries
    ? current
    : { turns, groups, entries };
}

export type MessagesTimelineRow =
  | {
      kind: "queued-message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      isHead: boolean;
      status: QueuedCardStatus;
      disclosure: EntryDisclosure | undefined;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      /** Whether the row's tool call shows its command and output. */
      expanded: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
      /** The hidden entries include a thought, so they read as steps, not tool calls. */
      hidesReasoning: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      /** The turn's first entry, which the fold row stands in for while folded. */
      anchorEntryId: string;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
      disclosure: EntryDisclosure | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
      disclosure: EntryDisclosure | undefined;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      /**
       * The turn already produced its terminal assistant message and is only
       * waiting for the provider to close it. Codex routinely takes tens of
       * seconds to send `turn/completed` after the final answer (measured
       * 19.8s-114.9s; claude and cursor are ~0s), and reporting that as an
       * undifferentiated wait made the provider's lag look like BiBCode hanging.
       */
      answerDelivered: boolean;
      /**
       * The running turn's newest thought, one line, when no visible row already shows it
       * and the answer is not yet delivered.
       */
      latestThought: string | null;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function workEntryRawCommand(
  workEntry: Pick<WorkLogEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

/** The command a tool row shows when expanded: the raw command when it differs. */
export function toolCallDisplayedCommand(
  workEntry: Pick<WorkLogEntry, "command" | "rawCommand">,
): string | null {
  const raw = workEntryRawCommand(workEntry);
  if (raw) return raw;
  return workEntry.command?.trim() || null;
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

interface TurnFolds {
  foldsByAnchorEntryId: ReadonlyMap<string, TurnFold>;
  /** Assistant messages a settled turn keeps visible as its answer. */
  answerMessageIds: ReadonlySet<string>;
}

/**
 * An assistant message is long or structured enough to read as an answer
 * rather than a progress line ("Waiting for the build."). Only used to keep
 * such a message out of a fold when the turn's last message is a short one.
 */
const SUBSTANTIVE_ANSWER_MIN_LENGTH = 240;
const MARKDOWN_BLOCK_PATTERN = /^[ \t]{0,3}(?:#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s|```|~~~|>|\|.*\|)/m;
const PARAGRAPH_BREAK_PATTERN = /\S[ \t]*\n[ \t]*\n\s*\S/;

function isSubstantiveAssistantText(text: string): boolean {
  return (
    text.length >= SUBSTANTIVE_ANSWER_MIN_LENGTH ||
    PARAGRAPH_BREAK_PATTERN.test(text) ||
    MARKDOWN_BLOCK_PATTERN.test(text)
  );
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
export function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

/** The turn still running, which Verbose chat leaves as it is with the setting off. */
export function isWorkEntryInUnsettledTurn(
  entry: Pick<WorkLogEntry, "turnId">,
  unsettledTurnId: TurnId | null,
): boolean {
  return unsettledTurnId !== null && entry.turnId === unsettledTurnId;
}

/**
 * Settled turns fold their commentary and tool activity behind a
 * "Worked for ..." row anchored at the turn's first foldable entry. The
 * turn's answer stays visible below the fold: its last assistant message,
 * plus the last substantive assistant message before it when the turn ends
 * on a short progress line. Assistant output that arrives after the latest
 * turn recorded its completion stays visible too and never displaces that
 * answer.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): TurnFolds {
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    /** Assistant messages in timeline order. */
    assistantEntries: Array<Extract<TimelineEntry, { kind: "message" }>>;
    hasStreamingMessage: boolean;
    /**
     * The user message that kicked the turn off. Entry timestamps alone
     * undercount the duration (the first entry appears only once the
     * provider starts producing output), and a turn cut short by a steer may
     * hold a single instantaneous commentary message.
     */
    startBoundary: string | null;
  }
  const groupsByTurnId = new Map<TurnId, TurnGroup>();

  let pendingUserBoundary: string | null = null;
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      const existingGroup = entry.message.turnId
        ? groupsByTurnId.get(entry.message.turnId)
        : undefined;
      if (existingGroup) {
        existingGroup.entries.push(entry);
        continue;
      }
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId =
      entry.kind === "message" && entry.message.role === "assistant"
        ? (entry.message.turnId ?? null)
        : entry.kind === "work"
          ? (entry.entry.turnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        assistantEntries: [],
        hasStreamingMessage: false,
        // Each user boundary starts at most one turn; a second turn after the
        // same user message (e.g. a steer-superseded continuation) falls back
        // to its own first entry.
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      group.assistantEntries.push(entry);
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    } else if (entry.kind === "work" && entry.entry.reasoning?.streaming === true) {
      // A thought still streaming keeps its turn open, as a streaming message does.
      group.hasStreamingMessage = true;
    }
  }

  const latestCompletedAtMs =
    input.latestTurn?.completedAt != null ? Date.parse(input.latestTurn.completedAt) : Number.NaN;
  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  const answerMessageIds = new Set<string>();
  for (const [turnId, group] of groupsByTurnId) {
    if (turnId === input.unsettledTurnId) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }

    // Output tagged with the latest turn after it recorded its completion
    // (e.g. a background task reporting back) is new output, not part of
    // the work the fold summarizes.
    const completedAtMs = input.latestTurn?.turnId === turnId ? latestCompletedAtMs : Number.NaN;
    const lateEntries = Number.isFinite(completedAtMs)
      ? group.assistantEntries.filter((entry) => Date.parse(entry.createdAt) > completedAtMs)
      : [];
    const onTimeEntries =
      lateEntries.length === 0
        ? group.assistantEntries
        : group.assistantEntries.filter((entry) => !lateEntries.includes(entry));

    const visibleEntryIds = new Set<string>(lateEntries.map((entry) => entry.id));
    const terminalEntry = onTimeEntries.at(-1);
    if (terminalEntry) {
      visibleEntryIds.add(terminalEntry.id);
      answerMessageIds.add(terminalEntry.message.id);
      if (!isSubstantiveAssistantText(terminalEntry.message.text)) {
        const substantiveEntry = onTimeEntries.findLast((entry) =>
          isSubstantiveAssistantText(entry.message.text),
        );
        if (substantiveEntry) {
          visibleEntryIds.add(substantiveEntry.id);
          answerMessageIds.add(substantiveEntry.message.id);
        }
      }
    }

    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      if (!visibleEntryIds.has(entry.id)) {
        hiddenEntryIds.add(entry.id);
      }
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const lateOutputEnd = lateEntries.reduce<string | null>(
      (end, entry) => maxIsoTimestamp(end, entry.message.updatedAt),
      null,
    );
    const elapsedMs =
      input.latestTurn?.turnId === turnId &&
      input.latestTurn.startedAt &&
      input.latestTurn.completedAt
        ? computeElapsedMs(
            input.latestTurn.startedAt,
            maxIsoTimestamp(input.latestTurn.completedAt, lateOutputEnd) ??
              input.latestTurn.completedAt,
          )
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ?? lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return { foldsByAnchorEntryId, answerMessageIds };
}

/** What decides which turns, work groups and entries a timeline shows. */
export interface TimelineDisclosureInput {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  queuedMessages?: ReadonlyArray<ChatMessage>;
  queuedStatuses?: ReadonlyArray<QueuedCardStatus>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  /** Turns the user opened (true) or folded (false); the rest follow `verboseChat`. */
  turnFoldChoices?: ReadonlyMap<TurnId, boolean>;
  /** Long work groups the user opened or folded; the rest follow `verboseChat`. */
  workGroupChoices?: ReadonlyMap<string, boolean>;
  /**
   * Settled turns and their long work groups start open, still behind their fold and toggle
   * rows so one click folds them. The turn still running is the same either way.
   */
  verboseChat?: boolean;
}

interface TimelineLayout {
  /** The entries in row order, without the queued messages that render last. */
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly unsettledTurnId: TurnId | null;
  readonly turnFolds: TurnFolds;
}

function deriveTimelineLayout(input: TimelineDisclosureInput): TimelineLayout {
  const timelineEntries = input.timelineEntries.filter(
    (entry) => entry.kind !== "message" || !isQueuedTimelineMessage(entry.message),
  );
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const turnFolds = deriveTurnFolds({
    timelineEntries,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  return { timelineEntries, unsettledTurnId, turnFolds };
}

/** Whether a settled turn shows its folded entries. Running turns never fold. */
function isTurnFoldExpanded(input: TimelineDisclosureInput, turnId: TurnId): boolean {
  return input.turnFoldChoices?.get(turnId) ?? input.verboseChat === true;
}

/** The entries that folded turns hide. */
function collectCollapsedEntryIds(
  turnFolds: TurnFolds,
  isTurnExpanded: (turnId: TurnId) => boolean,
): Set<string> {
  const collapsedEntryIds = new Set<string>();
  for (const fold of turnFolds.foldsByAnchorEntryId.values()) {
    if (!isTurnExpanded(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }
  return collapsedEntryIds;
}

/**
 * The run of work entries that starts at `startIndex`: it ends at the first entry that is not
 * work, that a fold hides, or that anchors a fold. `end` is the index after the run.
 */
function collectWorkRun(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  startIndex: number,
  collapsedEntryIds: ReadonlySet<string>,
  foldsByAnchorEntryId: ReadonlyMap<string, TurnFold>,
): { readonly groupedEntries: WorkLogEntry[]; readonly end: number } {
  const first = timelineEntries[startIndex];
  const groupedEntries: WorkLogEntry[] = first?.kind === "work" ? [first.entry] : [];
  let cursor = startIndex + 1;
  while (cursor < timelineEntries.length) {
    const nextEntry = timelineEntries[cursor];
    if (
      !nextEntry ||
      nextEntry.kind !== "work" ||
      collapsedEntryIds.has(nextEntry.id) ||
      foldsByAnchorEntryId.has(nextEntry.id)
    ) {
      break;
    }
    groupedEntries.push(nextEntry.entry);
    cursor += 1;
  }
  return { groupedEntries, end: cursor };
}

function workGroupId(anchorEntryId: string): string {
  return `work-group:${anchorEntryId}`;
}

function isWorkGroupExpanded(
  input: TimelineDisclosureInput,
  groupId: string,
  visibleEntries: ReadonlyArray<WorkLogEntry>,
  unsettledTurnId: TurnId | null,
): boolean {
  return (
    input.workGroupChoices?.get(groupId) ??
    (input.verboseChat === true &&
      !visibleEntries.some((entry) => isWorkEntryInUnsettledTurn(entry, unsettledTurnId)))
  );
}

/** Where an entry renders, and what must open first for its row to exist. */
export type TimelineEntryLocation =
  | { readonly kind: "absent" }
  | {
      readonly kind: "found";
      readonly rowId: string;
      readonly openTurnId?: TurnId;
      readonly openGroupId?: string;
    };

const QUEUED_MESSAGE_ROW_PREFIX = "queued-message:";

export function queuedMessageRowId(messageId: string): string {
  return `${QUEUED_MESSAGE_ROW_PREFIX}${messageId}`;
}

/**
 * The reveal plan for one entry, computed the way `deriveMessagesTimelineRows` builds rows. A
 * work group's id and hidden part depend on which turns are folded, so the group is found under
 * the turns the plan opens: the plan names the group and row that exist after the fold opens.
 */
export function locateTimelineEntry(
  entryId: string,
  input: TimelineDisclosureInput,
): TimelineEntryLocation {
  if (entryId.startsWith(QUEUED_MESSAGE_ROW_PREFIX)) {
    const messageId = entryId.slice(QUEUED_MESSAGE_ROW_PREFIX.length);
    const index = (input.queuedMessages ?? []).findIndex((message) => message.id === messageId);
    return index >= 0 && input.queuedStatuses?.[index]
      ? { kind: "found", rowId: entryId }
      : { kind: "absent" };
  }

  const { timelineEntries, unsettledTurnId, turnFolds } = deriveTimelineLayout(input);
  const targetIndex = timelineEntries.findIndex((entry) => entry.id === entryId);
  const target = timelineEntries[targetIndex];
  if (!target) {
    return { kind: "absent" };
  }

  let openTurnId: TurnId | undefined;
  for (const fold of turnFolds.foldsByAnchorEntryId.values()) {
    if (fold.hiddenEntryIds.has(entryId) && !isTurnFoldExpanded(input, fold.turnId)) {
      openTurnId = fold.turnId;
    }
  }
  const collapsedEntryIds = collectCollapsedEntryIds(
    turnFolds,
    (turnId) => turnId === openTurnId || isTurnFoldExpanded(input, turnId),
  );
  const turnPart = openTurnId === undefined ? {} : { openTurnId };

  if (target.kind !== "work") {
    return { kind: "found", rowId: target.id, ...turnPart };
  }
  if (workEntryIndicatesToolNeutralStatus(target.entry)) {
    return { kind: "absent" };
  }

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (
      !timelineEntry ||
      collapsedEntryIds.has(timelineEntry.id) ||
      timelineEntry.kind !== "work"
    ) {
      continue;
    }
    const run = collectWorkRun(
      timelineEntries,
      index,
      collapsedEntryIds,
      turnFolds.foldsByAnchorEntryId,
    );
    if (targetIndex >= index && targetIndex < run.end) {
      const visibleEntries = run.groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
        return { kind: "found", rowId: timelineEntry.id, ...turnPart };
      }
      const groupId = workGroupId(timelineEntry.id);
      const hiddenEntries = visibleEntries.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
      const needsGroup =
        hiddenEntries.includes(target.entry) &&
        !isWorkGroupExpanded(input, groupId, visibleEntries, unsettledTurnId);
      return {
        kind: "found",
        rowId: target.entry.id,
        ...turnPart,
        ...(needsGroup ? { openGroupId: groupId } : {}),
      };
    }
    index = run.end - 1;
  }
  return { kind: "absent" };
}

export function deriveMessagesTimelineRows(
  input: TimelineDisclosureInput & {
    isWorking: boolean;
    activeTurnStartedAt: string | null;
    turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
    revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
    /** Each entry's own disclosure choices, by entry id (a tool row's work entry id). */
    entryDisclosures?: ReadonlyMap<string, EntryDisclosure>;
  },
): MessagesTimelineRow[] {
  const { timelineEntries, unsettledTurnId, turnFolds } = deriveTimelineLayout(input);
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  const { answerMessageIds, foldsByAnchorEntryId } = turnFolds;
  const isTurnExpanded = (turnId: TurnId) => isTurnFoldExpanded(input, turnId);
  const collapsedEntryIds = collectCollapsedEntryIds(turnFolds, isTurnExpanded);
  const disclosureOf = (entryId: string) => input.entryDisclosures?.get(entryId);
  // The user's choice wins; until they make one, Verbose chat opens tool rows outside the
  // running turn.
  const isToolRowExpanded = (entry: WorkLogEntry) =>
    disclosureOf(entry.id)?.get(TOOL_ROW_DISCLOSURE_KEY) ??
    (input.verboseChat === true && !isWorkEntryInUnsettledTurn(entry, unsettledTurnId));

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.turnId}`,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        anchorEntryId: turnFold.anchorEntryId,
        label: turnFold.label,
        expanded: isTurnExpanded(turnFold.turnId),
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const { groupedEntries, end: cursor } = collectWorkRun(
        timelineEntries,
        index,
        collapsedEntryIds,
        foldsByAnchorEntryId,
      );
      const visibleGroupedEntries = groupedEntries.filter(
        (entry) => !workEntryIndicatesToolNeutralStatus(entry),
      );
      if (visibleGroupedEntries.length > 0) {
        if (visibleGroupedEntries.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            expanded: visibleGroupedEntries.some(isToolRowExpanded),
          });
        } else {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = isWorkGroupExpanded(
            input,
            groupId,
            visibleGroupedEntries,
            unsettledTurnId,
          );
          const hiddenEntries = visibleGroupedEntries.slice(0, -MAX_VISIBLE_WORK_LOG_ENTRIES);
          const visibleEntries = visibleGroupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);
          const renderedEntries = expanded ? [...hiddenEntries, ...visibleEntries] : visibleEntries;

          for (const workEntry of renderedEntries) {
            nextRows.push({
              kind: "work",
              id: workEntry.id,
              createdAt: workEntry.createdAt,
              groupedEntries: [workEntry],
              expanded: isToolRowExpanded(workEntry),
            });
          }

          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: hiddenEntries.length,
            expanded,
            onlyToolEntries: visibleGroupedEntries.every((entry) => workLogEntryIsToolLike(entry)),
            hidesReasoning: hiddenEntries.some((entry) => entry.tone === "reasoning"),
          });
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
        disclosure: disclosureOf(timelineEntry.id),
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      (terminalAssistantMessageIds.has(timelineEntry.message.id) ||
        answerMessageIds.has(timelineEntry.message.id)) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
      disclosure: disclosureOf(timelineEntry.id),
    });
  }

  if (input.isWorking) {
    const answerDelivered =
      unsettledTurnId !== null &&
      timelineEntries.some(
        (entry) =>
          entry.kind === "message" &&
          entry.message.role === "assistant" &&
          entry.message.turnId === unsettledTurnId &&
          !entry.message.streaming &&
          terminalAssistantMessageIds.has(entry.message.id),
      );
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
      answerDelivered,
      latestThought: answerDelivered
        ? null
        : deriveLatestThought(timelineEntries, unsettledTurnId, nextRows),
    });
  }

  for (const [index, message] of (input.queuedMessages ?? []).entries()) {
    const status = input.queuedStatuses?.[index];
    if (!status) continue;
    const rowId = queuedMessageRowId(message.id);
    nextRows.push({
      kind: "queued-message",
      id: rowId,
      createdAt: message.createdAt,
      message,
      isHead: index === 0,
      status,
      disclosure: disclosureOf(rowId),
    });
  }
  return nextRows;
}

/**
 * The running turn's newest thought as one line, or null when it is already the newest
 * visible work row, which shows it in full.
 */
function deriveLatestThought(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  unsettledTurnId: TurnId | null,
  rows: ReadonlyArray<MessagesTimelineRow>,
): string | null {
  if (unsettledTurnId === null) {
    return null;
  }
  const thought = timelineEntries.findLast(
    (entry): entry is Extract<TimelineEntry, { kind: "work" }> =>
      entry.kind === "work" &&
      entry.entry.turnId === unsettledTurnId &&
      entry.entry.reasoning !== undefined,
  );
  if (thought?.entry.reasoning === undefined) {
    return null;
  }
  const newestWorkRow = rows.findLast(
    (row): row is Extract<MessagesTimelineRow, { kind: "work" }> => row.kind === "work",
  );
  if (newestWorkRow?.groupedEntries.at(-1)?.id === thought.entry.id) {
    return null;
  }
  return latestThoughtLine(thought.entry.reasoning);
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "queued-message": {
      const bq = b as typeof a;
      return (
        a.message === bq.message &&
        a.isHead === bq.isHead &&
        Equal.equals(a.status, bq.status) &&
        a.disclosure === bq.disclosure
      );
    }
    case "working": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.answerDelivered === bw.answerDelivered &&
        a.latestThought === bw.latestThought
      );
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.anchorEntryId === bf.anchorEntryId &&
        a.label === bf.label &&
        a.expanded === bf.expanded
      );
    }

    case "proposed-plan": {
      const bp = b as typeof a;
      return a.proposedPlan === bp.proposedPlan && a.disclosure === bp.disclosure;
    }

    case "work": {
      const bw = b as typeof a;
      return a.expanded === bw.expanded && Equal.equals(a.groupedEntries, bw.groupedEntries);
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries &&
        a.hidesReasoning === bw.hidesReasoning
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount &&
        a.disclosure === bm.disclosure
      );
    }
  }
}
