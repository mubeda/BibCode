/**
 * Threads a capped shell left out (#223): loading older pages, looking threads up by id, and
 * the one resolver every thread reader uses. Absence from a capped shell never means a thread is
 * gone; only `missing` from `orchestration.getThreadShells` does.
 */
import {
  type OffShellState,
  offShellThreads,
} from "@bibcode/client-runtime/state/off-shell-threads";
import {
  type EnvironmentThreadShell,
  scopeThreadShell,
} from "@bibcode/client-runtime/state/models";
import { runAtomCommand } from "@bibcode/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationOlderThreadsScope,
  OrchestrationThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@bibcode/contracts";
import * as Option from "effect/Option";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "./shell";

/** Whether the environment's live shell left threads out; an old server's never does. */
export function isShellCapped(environmentId: EnvironmentId): boolean {
  const state = appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
  return Option.isSome(state.snapshot) && state.snapshot.value.capped === true;
}

export function useOffShellState(environmentId: EnvironmentId): OffShellState {
  return useSyncExternalStore(
    offShellThreads.subscribe,
    () => offShellThreads.get(environmentId),
    () => offShellThreads.get(environmentId),
  );
}

let offShellListCache: {
  readonly version: number;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
} = { version: -1, threads: [] };

/** Every off-shell thread, rebuilt once per store version. */
function readOffShellThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  const version = offShellThreads.version();
  if (offShellListCache.version !== version) {
    offShellListCache = {
      version,
      threads: offShellThreads
        .environmentIds()
        .flatMap((environmentId) =>
          [...offShellThreads.get(environmentId).threads.values()].map((thread) =>
            scopeThreadShell(environmentId, thread),
          ),
        ),
    };
  }
  return offShellListCache.threads;
}

/** Every thread the capped shells left out and this session loaded, scoped. */
export function useOffShellThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useSyncExternalStore(
    offShellThreads.subscribe,
    readOffShellThreadShells,
    readOffShellThreadShells,
  );
}

/**
 * One thread as the off-shell store holds it, and whether the server reported it missing; a
 * reader re-renders only when that thread changes.
 */
export function useOffShellThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): { readonly thread: OrchestrationThreadShell | null; readonly missing: boolean } {
  const read = () =>
    environmentId === null || threadId === null
      ? null
      : (offShellThreads.get(environmentId).threads.get(threadId) ?? null);
  const thread = useSyncExternalStore(offShellThreads.subscribe, read, read);
  const readMissing = () =>
    environmentId !== null &&
    threadId !== null &&
    offShellThreads.get(environmentId).missing.has(threadId);
  const missing = useSyncExternalStore(offShellThreads.subscribe, readMissing, readMissing);
  return { thread, missing };
}

/** The key of a page of `scope` and `query`. */
export function olderPageKey(scope: OrchestrationOlderThreadsScope, query?: string): string {
  return JSON.stringify([scope, query ?? null]);
}

export type OlderPageOutcome = "loaded" | "failed";

/**
 * Loads the next page of `scope` (or the first, when `append` is false). A reply that crossed a
 * removal or snapshot is dropped and asked for again once.
 */
export async function loadOlderThreads(
  environmentId: EnvironmentId,
  scope: OrchestrationOlderThreadsScope,
  options: { readonly query?: string; readonly append: boolean; readonly signal?: AbortSignal },
): Promise<OlderPageOutcome> {
  const key = olderPageKey(scope, options.query);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = offShellThreads.get(environmentId);
    const cursor = options.append ? state.pages.get(key)?.cursor : undefined;
    if (options.append && cursor === null) return "loaded";
    const { orchestrationEnvironment } = await import("./orchestration");
    const result = await runAtomCommand(
      appAtomRegistry,
      orchestrationEnvironment.listOlderThreads,
      {
        environmentId,
        input: {
          scope,
          ...(options.query === undefined ? {} : { query: options.query }),
          ...(cursor === undefined || cursor === null ? {} : { cursor }),
        },
      },
      { reportFailure: false, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
    if (result._tag !== "Success") return "failed";
    const fresh = offShellThreads.get(environmentId).generation === state.generation;
    offShellThreads.applyPage(environmentId, state.generation, key, result.value, options.append);
    if (fresh) return "loaded";
  }
  return "failed";
}

const pendingLookups = new Map<EnvironmentId, Set<ThreadId>>();
const lookupWaiters = new Map<EnvironmentId, Array<() => void>>();

/** Looks the ids up with `getThreadShells`, batched per tick and per environment. */
export function requestThreadShells(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): Promise<void> {
  let pending = pendingLookups.get(environmentId);
  const scheduled = pending !== undefined;
  if (pending === undefined) {
    pending = new Set();
    pendingLookups.set(environmentId, pending);
  }
  for (const threadId of threadIds) pending.add(threadId);
  const done = new Promise<void>((resolve) => {
    const waiters = lookupWaiters.get(environmentId) ?? [];
    waiters.push(resolve);
    lookupWaiters.set(environmentId, waiters);
  });
  if (!scheduled) {
    queueMicrotask(() => {
      void flushLookups(environmentId);
    });
  }
  return done;
}

async function flushLookups(environmentId: EnvironmentId): Promise<void> {
  const ids = [...(pendingLookups.get(environmentId) ?? [])];
  const waiters = lookupWaiters.get(environmentId) ?? [];
  pendingLookups.delete(environmentId);
  lookupWaiters.delete(environmentId);
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generation = offShellThreads.get(environmentId).generation;
      const { orchestrationEnvironment } = await import("./orchestration");
      const result = await runAtomCommand(
        appAtomRegistry,
        orchestrationEnvironment.getThreadShells,
        { environmentId, input: { threadIds: batch } },
        { reportFailure: false },
      );
      if (result._tag !== "Success") break;
      if (offShellThreads.applyLookup(environmentId, generation, result.value)) break;
      if (offShellThreads.get(environmentId).generation === generation) break;
    }
  }
  for (const resolve of waiters) resolve();
}

/** A thread the shell left out, as last loaded; null when not loaded. */
export function readOffShellThreadShell(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  const thread = offShellThreads.get(ref.environmentId).threads.get(ref.threadId);
  return thread === undefined ? null : scopeThreadShell(ref.environmentId, thread);
}

export type ResolvedThreadShell =
  | { readonly kind: "resolved"; readonly thread: EnvironmentThreadShell }
  /** The server says the thread is deleted or never existed. */
  | { readonly kind: "missing" }
  /** Not in an uncapped shell (an old server): readers behave as before #223. */
  | { readonly kind: "unknown" };

/**
 * The resolver's three steps: the live shell (via `readShell`), the off-shell store, then, for a
 * capped shell, the server.
 */
export async function resolveThreadShellWith(
  ref: ScopedThreadRef,
  readShell: (ref: ScopedThreadRef) => EnvironmentThreadShell | null,
): Promise<ResolvedThreadShell> {
  const known = readShell(ref) ?? readOffShellThreadShell(ref);
  if (known !== null) return { kind: "resolved", thread: known };
  if (!isShellCapped(ref.environmentId)) return { kind: "unknown" };
  if (!offShellThreads.get(ref.environmentId).missing.has(ref.threadId)) {
    await requestThreadShells(ref.environmentId, [ref.threadId]);
  }
  const fetched = readShell(ref) ?? readOffShellThreadShell(ref);
  if (fetched !== null) return { kind: "resolved", thread: fetched };
  return offShellThreads.get(ref.environmentId).missing.has(ref.threadId)
    ? { kind: "missing" }
    : { kind: "unknown" };
}
