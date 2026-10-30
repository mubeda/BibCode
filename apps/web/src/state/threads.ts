import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@bibcode/client-runtime/environment";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
  createThreadEnvironmentAtoms,
} from "@bibcode/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@bibcode/contracts";
import { useMemo } from "react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const threadEnvironment = createThreadEnvironmentAtoms(connectionAtomRuntime);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("web-environment-thread:empty"),
);

/**
 * A thread's load state for Find in thread, as one string so a subscriber re-renders only when
 * the status, the error or whether any data is held changes, not on every patch.
 */
const threadFindLoadStateAtomFamily = Atom.family((key: string) =>
  Atom.make((get): string => {
    const ref = parseScopedThreadKey(key);
    if (!ref) return LIVE_THREAD_FIND_LOAD_STATE;
    const state = get(environmentThreadDetails.stateAtom(ref));
    return [
      state.status,
      Option.isSome(state.data) ? "1" : "0",
      Option.getOrElse(state.error, () => ""),
    ].join("\u0000");
  }).pipe(Atom.withLabel(`web-thread-find-load-state:${key}`)),
);

const LIVE_THREAD_FIND_LOAD_STATE = "live\u00001\u0000";
const LIVE_THREAD_FIND_LOAD_STATE_ATOM = Atom.make(LIVE_THREAD_FIND_LOAD_STATE).pipe(
  Atom.withLabel("web-thread-find-load-state:live"),
);

export interface ThreadFindLoadState {
  readonly status: EnvironmentThreadStatus;
  readonly error: string | null;
  readonly hasData: boolean;
}

/** A server thread's load state; a draft, which has no server state, reads as live. */
export function useThreadFindLoadState(ref: ScopedThreadRef | null): ThreadFindLoadState {
  const encoded = useAtomValue(
    ref === null
      ? LIVE_THREAD_FIND_LOAD_STATE_ATOM
      : threadFindLoadStateAtomFamily(scopedThreadKey(ref)),
  );
  return useMemo(() => {
    const [status, hasData, error] = encoded.split("\u0000");
    return {
      status: (status ?? "live") as EnvironmentThreadStatus,
      hasData: hasData === "1",
      error: error ? error : null,
    };
  }, [encoded]);
}

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}

/**
 * Keeps a thread's stream subscription warm without reading its data. Mounting the atom holds
 * the subscription (and its idle retention) while React holds no snapshot of the thread, unlike
 * `useEnvironmentThread`, whose hook state keeps one earlier copy of the thread alive.
 */
export function usePrewarmEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): void {
  useAtomMount(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
}
