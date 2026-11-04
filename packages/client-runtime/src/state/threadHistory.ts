import type {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationReasoning,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadHistoryKey,
  OrchestrationThreadHistoryPage,
} from "@bibcode/contracts";

/**
 * The thread history window on the client (#226). The server holds a window of recent history
 * that its patches apply to; older pages are loaded on demand and kept for the session only.
 * The thread state publishes one thread that merges them, so every state reader reads one
 * thread unchanged.
 */

/** Kind ranks of the history key, as the server orders kinds. */
export const HISTORY_RANK = { message: 0, activity: 1, reasoning: 2, plan: 3 } as const;

/** The older pages loaded so far, session only: never persisted. */
export interface OlderHistory {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly reasoning: ReadonlyArray<OrchestrationReasoning>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly checkpointsByTurnId: ReadonlyMap<string, OrchestrationCheckpointSummary>;
  /** The next page's cursor; `null` when nothing is older. */
  readonly cursor: string | null;
  readonly olderRows: number;
  /** The key of the oldest row a page returned. */
  readonly oldest: OrchestrationThreadHistoryKey | null;
}

export function compareHistoryKeys(
  left: OrchestrationThreadHistoryKey,
  right: OrchestrationThreadHistoryKey,
): number {
  // Code-unit order, as the server compares its strings; never locale order.
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function historyKey(
  rank: number,
  row: { readonly id: string; readonly createdAt: string },
): OrchestrationThreadHistoryKey {
  return { createdAt: row.createdAt, rank, id: row.id };
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** `ACTIVITY_LIST_ORDER` on the server: `sequence` (none first), then `createdAt`, then id. */
export function compareActivitiesCanonically(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const leftSequence = left.sequence ?? -1;
  const rightSequence = right.sequence ?? -1;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  return compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id);
}

function compareByCreatedAt(
  left: { readonly createdAt: string; readonly id: string },
  right: { readonly createdAt: string; readonly id: string },
): number {
  return compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id);
}

/** Adds one page to the older history loaded so far. */
export function appendHistoryPage(
  older: OlderHistory | null,
  page: OrchestrationThreadHistoryPage,
): OlderHistory {
  const keys = [
    ...page.messages.map((row) => historyKey(HISTORY_RANK.message, row)),
    ...page.activities.map((row) => historyKey(HISTORY_RANK.activity, row)),
    ...page.reasoning.map((row) => historyKey(HISTORY_RANK.reasoning, row)),
    ...page.proposedPlans.map((row) => historyKey(HISTORY_RANK.plan, row)),
  ];
  const oldestOfPage = keys.reduce<OrchestrationThreadHistoryKey | null>(
    (oldest, key) => (oldest === null || compareHistoryKeys(key, oldest) < 0 ? key : oldest),
    null,
  );
  const checkpointsByTurnId = new Map(older?.checkpointsByTurnId);
  for (const checkpoint of page.checkpoints) checkpointsByTurnId.set(checkpoint.turnId, checkpoint);
  return {
    messages: [...(older?.messages ?? []), ...page.messages],
    activities: [...(older?.activities ?? []), ...page.activities],
    reasoning: [...(older?.reasoning ?? []), ...page.reasoning],
    proposedPlans: [...(older?.proposedPlans ?? []), ...page.proposedPlans],
    checkpointsByTurnId,
    cursor: page.cursor,
    olderRows: page.olderRows,
    oldest: oldestOfPage ?? older?.oldest ?? null,
  };
}

/** The key a window's floor starts at, read from its cursor; `null` for the whole thread. */
export function windowFloorKey(floor: string): OrchestrationThreadHistoryKey | null {
  try {
    const json = atob(floor.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed = JSON.parse(json) as { readonly k?: unknown };
    if (parsed.k === null) return null;
    const [createdAt, rank, id] = parsed.k as [unknown, unknown, unknown];
    if (typeof createdAt === "string" && typeof rank === "number" && typeof id === "string") {
      return { createdAt, rank, id };
    }
  } catch {
    // Fall through: a floor this client can't read hides every carried row until a page loads.
  }
  return UNREADABLE_FLOOR;
}

const UNREADABLE_FLOOR: OrchestrationThreadHistoryKey = {
  createdAt: "￿",
  rank: Number.MAX_SAFE_INTEGER,
  id: "",
};

/** Rows of `lower` whose id no row of `higher` holds. */
function withoutIds<T extends { readonly id: string }>(
  lower: ReadonlyArray<T>,
  higher: ReadonlySet<string>,
): T[] {
  return lower.filter((row) => !higher.has(row.id));
}

function idsOf(...arrays: ReadonlyArray<ReadonlyArray<{ readonly id: string }>>): Set<string> {
  const ids = new Set<string>();
  for (const array of arrays) for (const row of array) ids.add(row.id);
  return ids;
}

/** Keeps the first copy of each id: the caller lists higher-precedence rows first. */
function dedupe<T extends { readonly id: string }>(rows: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

/**
 * The thread a windowed state publishes: the window, with carried rows and older pages merged
 * in by id. The window's copy wins over a carried one, and a carried one over a page's. Each
 * array is put back in the server's canonical order for its collection.
 */
export function mergeThreadHistory(
  window: OrchestrationThread,
  older: OlderHistory | null,
): OrchestrationThread {
  const history = window.history;
  if (history === undefined) return window;
  const carried = history.carried;
  const hasOlder = older === null ? history.hasOlder : older.cursor !== null;
  const loadedFrom = !hasOlder ? null : (older?.oldest ?? windowFloorKey(history.floor));
  const published = {
    ...history,
    hasOlder,
    olderRows: older === null ? history.olderRows : older.olderRows,
    loadedFrom,
  };
  if (older === null && carried.activities.length === 0 && carried.proposedPlans.length === 0) {
    return { ...window, history: published };
  }

  const windowMessageIds = idsOf(window.messages);
  // Every message the server orders by anything but `createdAt` is live, so in the window: the
  // queue's admission order reaches its readers unchanged.
  const messages = older
    ? [
        ...withoutIds(older.messages, windowMessageIds).toSorted(compareByCreatedAt),
        ...window.messages,
      ]
    : window.messages;
  const activities = dedupe([
    ...window.activities,
    ...carried.activities,
    ...(older?.activities ?? []),
  ]).toSorted(compareActivitiesCanonically);
  const reasoning = older
    ? dedupe([...window.reasoning, ...older.reasoning]).toSorted(compareByCreatedAt)
    : window.reasoning;
  const proposedPlans = dedupe([
    ...window.proposedPlans,
    ...carried.proposedPlans,
    ...(older?.proposedPlans ?? []),
  ]).toSorted((left, right) => compareText(left.id, right.id));
  const checkpoints =
    older === null
      ? window.checkpoints
      : window.checkpoints.map((checkpoint) => {
          const page = older.checkpointsByTurnId.get(checkpoint.turnId);
          // The window's checkpoint is the authority: a page only fills in the files of the
          // same checkpoint, never an older status or ref.
          return page !== undefined &&
            page.checkpointRef === checkpoint.checkpointRef &&
            page.status === checkpoint.status &&
            page.filesTotal === checkpoint.filesTotal
            ? { ...checkpoint, files: page.files }
            : checkpoint;
        });
  return {
    ...window,
    messages,
    activities,
    reasoning,
    proposedPlans,
    checkpoints,
    history: published,
  };
}

/**
 * Whether a merged row is a carried state row whose place older history hasn't reached: state
 * readers read it, the timeline leaves it out until a page reaches it.
 */
export function isUnreachedCarriedRow(
  history: OrchestrationThread["history"],
  rank: number,
  row: { readonly id: string; readonly createdAt: string },
): boolean {
  const loadedFrom = history?.loadedFrom;
  if (!history || !loadedFrom) return false;
  const carried =
    rank === HISTORY_RANK.plan ? history.carried.proposedPlans : history.carried.activities;
  return (
    carried.some((entry) => entry.id === row.id) &&
    compareHistoryKeys(historyKey(rank, row), loadedFrom) < 0
  );
}

/** Whether the thread has a message, loaded or still on the server. */
export function threadHasMessages(
  thread: Pick<OrchestrationThread, "messages" | "history">,
): boolean {
  return thread.messages.length > 0 || thread.history?.hasOlder === true;
}
