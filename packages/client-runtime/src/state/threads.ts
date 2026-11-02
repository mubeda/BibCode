import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  EnvironmentCacheStore,
  type CachedThread,
  type ThreadResumePoint,
} from "../platform/persistence.ts";
import {
  request,
  subscribe,
  type EnvironmentRpcFailure,
  type EnvironmentRpcUnavailableError,
} from "../rpc/client.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadPatch } from "./threadPatch.ts";
import { appendHistoryPage, mergeThreadHistory, type OlderHistory } from "./threadHistory.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

/** Why an older history page did not load. */
export type ThreadHistoryPageFailure =
  | EnvironmentRpcFailure<typeof ORCHESTRATION_WS_METHODS.getThreadHistoryPage>
  | EnvironmentRpcUnavailableError;

/** Loading of a windowed thread's older history (#226). */
export interface ThreadOlderHistory {
  readonly status: "idle" | "loading" | "error";
  /** Loads the next older page. Single-flight: a call while one loads waits for that one. */
  readonly loadOlder: Effect.Effect<void, ThreadHistoryPageFailure>;
  /** Loads every older page; stops at, and fails with, the first failure. */
  readonly loadAllOlder: Effect.Effect<void, ThreadHistoryPageFailure>;
}

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationThread>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /** Present on the state of a subscription; it has older history when `data.history.hasOlder`. */
  readonly olderHistory?: ThreadOlderHistory;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
};

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<CachedThread>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (entry) => entry.thread);
  // The server-held thread, which patches apply to by index; a windowed one holds recent
  // history (#226). `older` is the older pages loaded since, never persisted. `data` publishes
  // the two merged, so every state reader reads one thread.
  let window: Option.Option<OrchestrationThread> = cachedThread;
  let older: OlderHistory | null = null;
  // Bumped whenever `older` stops matching the window: a page answering an earlier generation
  // is dropped.
  let generation = 0;
  let inFlight: Deferred.Deferred<void, ThreadHistoryPageFailure> | null = null;
  let olderStatus: ThreadOlderHistory["status"] = "idle";
  let merged: {
    window: OrchestrationThread;
    older: OlderHistory | null;
    thread: OrchestrationThread;
  } | null = null;
  const publishedThread = (thread: OrchestrationThread) => {
    if (merged === null || merged.window !== thread || merged.older !== older) {
      merged = { window: thread, older, thread: mergeThreadHistory(thread, older) };
    }
    return merged.thread;
  };
  const resetOlder = () => {
    generation += 1;
    older = null;
    olderStatus = "idle";
  };
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: Option.map(cachedThread, publishedThread),
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
  });
  const lastSequence = yield* SubscriptionRef.make(0);
  // The server's revision of the thread this state holds, after the last item applied in full.
  // A resubscribe sends it so the server can answer `unchanged` instead of the whole thread; any
  // change the server did not describe with a revision clears it. It is cached with the thread,
  // so the first subscribe after a reload or an app restart resumes too (#227).
  let resumeFrom: ThreadResumePoint | null = Option.match(cached, {
    onNone: () => null,
    onSome: (entry) => entry.resumeFrom,
  });
  const resumeAt = (revision: string | undefined, snapshotSequence: number) => {
    resumeFrom = revision === undefined ? null : { revision, snapshotSequence };
  };
  const persistence = yield* Queue.sliding<CachedThread>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    cachedEntry: CachedThread,
  ) {
    yield* cache.saveThread(environmentId, cachedEntry).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
  }));
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
      error: Option.some(formatThreadError(cause)),
    }));

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
  ) {
    window = Option.some(thread);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      data: Option.some(publishedThread(thread)),
      status: "live" as const,
      error: Option.none(),
    }));
  });

  // Publishes `older` and its loading status against the current window.
  const publishOlder = SubscriptionRef.update(state, (current) => ({
    ...current,
    data: Option.map(window, publishedThread),
    ...(current.olderHistory === undefined
      ? {}
      : { olderHistory: { ...current.olderHistory, status: olderStatus } }),
  }));

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    resumeFrom = null;
    window = Option.none();
    resetOlder();
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      data: Option.none(),
      status: "deleted" as const,
      error: Option.none(),
    }));
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const applyStreamItem = Effect.fn("EnvironmentThreadState.applyStreamItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    if (item.kind === "snapshot") {
      // A new floor, or a whole thread from an older server, makes the loaded pages stale.
      const history = item.snapshot.thread.history;
      if (
        history === undefined ||
        history.floor !== Option.getOrUndefined(window)?.history?.floor
      ) {
        resetOlder();
      }
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* setThread(item.snapshot.thread);
      resumeAt(item.revision, item.snapshot.snapshotSequence);
      return;
    }
    if (item.kind === "patch") {
      // Computed against the window this subscription holds, so it always applies.
      if (Option.isNone(window)) {
        resumeFrom = null;
        return;
      }
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      yield* setThread(applyThreadPatch(window.value, item.patch));
      resumeAt(item.revision, item.snapshotSequence);
      return;
    }
    if (item.kind === "unchanged") {
      // The server still has the revision this state holds: keep the thread, it is live again.
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isNone(current.data)
          ? current
          : { ...current, status: "live" as const, error: Option.none() },
      );
      resumeAt(item.revision, item.snapshotSequence);
      return;
    }
    resumeFrom = null;

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);

    if (Option.isNone(window)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    const result = applyThreadDetailEvent(window.value, item.event);
    if (result.kind === "updated") {
      yield* setThread(result.thread);
    } else if (result.kind === "deleted") {
      yield* setDeleted();
    }
  });

  // Caches the thread with its revision whenever either changes. A new snapshot sequence under
  // the same revision is not worth rewriting the thread: the server accepts the older one.
  // Only the window is cached; older pages are session only.
  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    const before = window;
    const revisionBefore = resumeFrom?.revision;
    yield* applyStreamItem(item);
    const after = window;
    if (Option.isSome(after) && (after !== before || resumeFrom?.revision !== revisionBefore)) {
      yield* Queue.offer(persistence, { thread: after.value, resumeFrom });
    }
  });

  // The cursor of the next older page: the window's floor until a page loads.
  const nextCursor = (): string | null => {
    if (older !== null) return older.cursor;
    const history = Option.getOrUndefined(window)?.history;
    return history?.hasOlder === true ? history.floor : null;
  };
  const services = yield* Effect.context<EnvironmentSupervisor>();
  const fetchPage = (cursor: string) =>
    request(ORCHESTRATION_WS_METHODS.getThreadHistoryPage, { threadId, cursor }).pipe(
      Effect.provideContext(services),
    );
  // Single-flight: the check for a load in flight and the reservation of a new one run in one
  // synchronous step, inside the uninterruptible region, so no yield falls between them and an
  // interruption can't leave a reservation nobody completes.
  const loadOlder: Effect.Effect<void, ThreadHistoryPageFailure> = Effect.uninterruptibleMask(
    (restore) =>
      Effect.suspend(() => {
        if (inFlight !== null) return restore(Deferred.await(inFlight));
        const cursor = nextCursor();
        if (cursor === null) return Effect.void;
        const requested = generation;
        const done = Deferred.makeUnsafe<void, ThreadHistoryPageFailure>();
        inFlight = done;
        olderStatus = "loading";
        return Effect.gen(function* () {
          yield* publishOlder;
          const exit = yield* Effect.exit(restore(fetchPage(cursor)));
          inFlight = null;
          if (Exit.isSuccess(exit)) {
            // A page for a floor or cursor this state no longer holds is stale or a duplicate.
            if (requested === generation && nextCursor() === cursor) {
              older = appendHistoryPage(older, exit.value);
            }
            olderStatus = "idle";
          } else if (
            Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag ===
            "OrchestrationThreadHistoryStaleError"
          ) {
            // A revert this state missed: the next re-read or resubscribe brings the new window.
            resetOlder();
          } else {
            olderStatus = Cause.hasInterruptsOnly(exit.cause) ? "idle" : "error";
          }
          yield* publishOlder;
          yield* Deferred.done(done, Exit.isSuccess(exit) ? Exit.void : exit);
          return yield* exit;
        });
      }),
  ).pipe(Effect.asVoid);
  const loadAllOlder: Effect.Effect<void, ThreadHistoryPageFailure> = Effect.gen(function* () {
    // Each round either moves the cursor or fails, so this can't spin. A page another caller
    // started and then dropped is only retried.
    while (nextCursor() !== null) {
      const exit = yield* Effect.exit(loadOlder);
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) return yield* exit;
    }
  });
  yield* SubscriptionRef.update(state, (current) => ({
    ...current,
    olderHistory: { status: olderStatus, loadOlder, loadAllOlder },
  }));

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  yield* setSynchronizing;
  yield* subscribe(
    ORCHESTRATION_WS_METHODS.subscribeThread,
    // Updates arrive as patches against the snapshot this subscription holds; a resubscribe
    // names the revision it holds, so an unchanged thread is not sent again. It asks for a
    // history window (#226) and echoes the floor of the window it holds.
    () => {
      const floor = Option.getOrUndefined(window)?.history?.floor;
      const history = floor === undefined ? {} : { floor };
      return resumeFrom === null
        ? { threadId, patches: true, history }
        : { threadId, patches: true, history, resume: resumeFrom };
    },
    {
      onExpectedFailure: setStreamError,
      // A thread can appear just after its view subscribes, so a failure is retried soon. A
      // deleted thread fails every time; a fixed 250 ms retry hammered the server (#113).
      retryExpectedFailure: {
        when: () => true,
        initialDelay: "250 millis",
        maxDelay: "30 seconds",
        resetAfter: "30 seconds",
      },
    },
  ).pipe(Stream.runForEach(applyItem), Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() =>
      Option.match(window, {
        onNone: () => Effect.void,
        onSome: (thread) => persist({ thread, resumeFrom }),
      }),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadHistory.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
