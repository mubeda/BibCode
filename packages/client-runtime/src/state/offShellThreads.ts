import type {
  EnvironmentId,
  OrchestrationGetThreadShellsResult,
  OrchestrationListOlderThreadsResult,
  OrchestrationShellStreamItem,
  OrchestrationThreadShell,
  ThreadId,
} from "@bibcode/contracts";

/**
 * Thread shells a capped shell left out (#223): older pages and threads looked up by id, per
 * environment, for this session only. Absence from a capped shell never means a thread is gone;
 * only `missing` from `getThreadShells` does.
 *
 * A reply can cross a deletion: every removal item, snapshot, `unchanged` and session change
 * bumps `generation`, and a reply sent under an older generation is dropped.
 */
export interface OffShellPage {
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** Null when nothing older remains. */
  readonly cursor: string | null;
}

export interface OffShellState {
  readonly generation: number;
  readonly threads: ReadonlyMap<ThreadId, OrchestrationThreadShell>;
  readonly missing: ReadonlySet<ThreadId>;
  readonly pages: ReadonlyMap<string, OffShellPage>;
}

const EMPTY: OffShellState = {
  generation: 0,
  threads: new Map(),
  missing: new Set(),
  pages: new Map(),
};

function withoutThreads(
  state: OffShellState,
  drop: (thread: OrchestrationThreadShell | undefined, threadId: ThreadId) => boolean,
): OffShellState {
  const threads = new Map(state.threads);
  for (const [threadId, thread] of state.threads) {
    if (drop(thread, threadId)) threads.delete(threadId);
  }
  const pages = new Map<string, OffShellPage>();
  for (const [key, page] of state.pages) {
    pages.set(key, {
      ...page,
      threadIds: page.threadIds.filter((threadId) => !drop(state.threads.get(threadId), threadId)),
    });
  }
  return { ...state, generation: state.generation + 1, threads, pages };
}

/** The store after a shell stream item: removals drop their threads, snapshots clear it. */
export function offShellAfterItem(
  state: OffShellState,
  item: OrchestrationShellStreamItem,
): OffShellState {
  switch (item.kind) {
    case "snapshot": {
      // A removal may have been missed; what was deleted stays missing, unless it is listed.
      const listed = new Set<ThreadId>(item.snapshot.threads.map((thread) => thread.id));
      const missing = [...state.missing].some((threadId) => listed.has(threadId))
        ? new Set([...state.missing].filter((threadId) => !listed.has(threadId)))
        : state.missing;
      return { ...EMPTY, generation: state.generation + 1, missing };
    }
    case "unchanged":
      return { ...EMPTY, generation: state.generation + 1, missing: state.missing };
    case "thread-removed": {
      const next = withoutThreads(state, (_, threadId) => threadId === item.threadId);
      return next;
    }
    case "project-removed":
      return withoutThreads(state, (thread) => thread?.projectId === item.projectId);
    default:
      return state;
  }
}

/** Adds a page reply sent at `generation`; a stale reply changes nothing. */
export function offShellWithPage(
  state: OffShellState,
  generation: number,
  key: string,
  result: OrchestrationListOlderThreadsResult,
  append: boolean,
): OffShellState {
  if (generation !== state.generation) return state;
  const threads = new Map(state.threads);
  for (const thread of result.threads) threads.set(thread.id, thread);
  const previous = append ? (state.pages.get(key)?.threadIds ?? []) : [];
  const seen = new Set(previous);
  const pages = new Map(state.pages);
  pages.set(key, {
    threadIds: [
      ...previous,
      ...result.threads.map((thread) => thread.id).filter((id) => !seen.has(id)),
    ],
    cursor: result.cursor,
  });
  return { ...state, threads, pages };
}

/** Adds a lookup reply sent at `generation`; a stale reply changes nothing. */
export function offShellWithLookup(
  state: OffShellState,
  generation: number,
  result: OrchestrationGetThreadShellsResult,
): OffShellState {
  if (generation !== state.generation) return state;
  const threads = new Map(state.threads);
  for (const thread of result.threads) threads.set(thread.id, thread);
  const missing = new Set(state.missing);
  for (const thread of result.threads) missing.delete(thread.id);
  for (const threadId of result.missing) missing.add(threadId);
  return { ...state, threads, missing };
}

export interface OffShellThreads {
  readonly get: (environmentId: EnvironmentId) => OffShellState;
  /** Every environment with loaded threads. */
  readonly environmentIds: () => ReadonlyArray<EnvironmentId>;
  /** Changes with every change of any environment, for readers of several. */
  readonly version: () => number;
  readonly subscribe: (listener: () => void) => () => void;
  readonly onShellItem: (environmentId: EnvironmentId, item: OrchestrationShellStreamItem) => void;
  /** A new session: nothing loaded before it is trusted. */
  readonly reset: (environmentId: EnvironmentId) => void;
  /** A removed environment: drops everything it loaded, so no list shows it again. */
  readonly forget: (environmentId: EnvironmentId) => void;
  readonly applyPage: (
    environmentId: EnvironmentId,
    generation: number,
    key: string,
    result: OrchestrationListOlderThreadsResult,
    append: boolean,
  ) => boolean;
  readonly applyLookup: (
    environmentId: EnvironmentId,
    generation: number,
    result: OrchestrationGetThreadShellsResult,
  ) => boolean;
}

export function createOffShellThreads(): OffShellThreads {
  const states = new Map<EnvironmentId, OffShellState>();
  const listeners = new Set<() => void>();
  let version = 0;
  const get = (environmentId: EnvironmentId) => states.get(environmentId) ?? EMPTY;
  const set = (environmentId: EnvironmentId, next: OffShellState): boolean => {
    if (next === get(environmentId)) return false;
    states.set(environmentId, next);
    version += 1;
    for (const listener of listeners) listener();
    return true;
  };
  return {
    get,
    environmentIds: () => [...states.keys()],
    version: () => version,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onShellItem: (environmentId, item) => {
      set(environmentId, offShellAfterItem(get(environmentId), item));
    },
    reset: (environmentId) => {
      set(environmentId, { ...EMPTY, generation: get(environmentId).generation + 1 });
    },
    forget: (environmentId) => {
      if (!states.delete(environmentId)) return;
      version += 1;
      for (const listener of listeners) listener();
    },
    applyPage: (environmentId, generation, key, result, append) =>
      set(environmentId, offShellWithPage(get(environmentId), generation, key, result, append)),
    applyLookup: (environmentId, generation, result) =>
      set(environmentId, offShellWithLookup(get(environmentId), generation, result)),
  };
}

/** The app's store; the shell state feeds it every item it applies. */
export const offShellThreads = createOffShellThreads();

/** A thread the shell does not hold, as last loaded; null when not loaded. */
export function readOffShellThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): OrchestrationThreadShell | null {
  return offShellThreads.get(environmentId).threads.get(threadId) ?? null;
}
