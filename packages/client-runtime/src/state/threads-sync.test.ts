import {
  CheckpointRef,
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetThreadHistoryPageError,
  OrchestrationThreadHistoryStaleError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadHistoryPage,
  type OrchestrationThreadStreamItem,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  reasoning: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

type TestThreadInput = OrchestrationThreadStreamItem | Error;

function testSession(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationThread;
  readonly cachedResumeFrom?: Persistence.ThreadResumePoint;
  /** Answers `orchestration.getThreadHistoryPage` by cursor. */
  readonly pages?: (
    cursor: string,
  ) => Effect.Effect<
    OrchestrationThreadHistoryPage,
    OrchestrationThreadHistoryStaleError | OrchestrationGetThreadHistoryPageError
  >;
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const subscribeInputs = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const pageRequests = yield* Ref.make<ReadonlyArray<string>>([]);
  const savedThreads = yield* Ref.make<ReadonlyArray<Persistence.CachedThread>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: unknown) =>
      Stream.unwrap(
        Ref.update(subscribeInputs, (current) => [...current, input]).pipe(
          Effect.andThen(Ref.updateAndGet(subscriptionCount, (count) => count + 1)),
          Effect.map(() => streamFrom(inputs)),
        ),
      ),
    [ORCHESTRATION_WS_METHODS.getThreadHistoryPage]: (input: { readonly cursor: string }) =>
      Ref.update(pageRequests, (current) => [...current, input.cursor]).pipe(
        Effect.andThen(options?.pages?.(input.cursor) ?? Effect.die("no history pages")),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({
              thread: options.cached,
              resumeFrom: options.cachedResumeFrom ?? null,
            })
          : Option.none(),
      ),
    saveThread: (_environmentId, cached) =>
      Ref.update(savedThreads, (current) => [...current, cached]),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    clear: () => Effect.void,
  });
  const threadState = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
  );
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    subscribeInputs,
    pageRequests,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    replaceSession: SubscriptionRef.set(supervisorSession, Option.some(testSession(client))),
  };
});

const snapshot = (
  thread: OrchestrationThread,
): Extract<OrchestrationThreadStreamItem, { kind: "snapshot" }> => ({
  kind: "snapshot",
  snapshot: {
    snapshotSequence: 1,
    thread,
  },
});

const titleUpdated = (title: string, sequence = 2): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-title"),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title,
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  },
});

const deleted = (): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-deleted"),
    sequence: 3,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.deleted",
    payload: {
      threadId: THREAD_ID,
      deletedAt: "2026-04-01T02:00:00.000Z",
    },
  },
});

describe("EnvironmentThreads", () => {
  it.effect("publishes cached data before a live snapshot arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "cached" && Option.isSome(value.data),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.thread.title).toBe("Live title");
    }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
    }),
  );

  it.effect("removes cached data when the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Recovered thread",
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Materialized thread",
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("backs off a subscription that keeps failing, as a deleted thread's does", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const subscriptionsAfterSettling = Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow;
        return yield* Ref.get(harness.subscriptionCount);
      });
      // Each attempt fails at once. A fixed 250 ms retry opened about 4 subscriptions a
      // second per deleted thread, for as long as its view stayed mounted (#113).
      const failAttempt = Queue.offer(harness.inputs, new Error("Thread gone was not found")).pipe(
        Effect.andThen(subscriptionsAfterSettling),
      );
      yield* failAttempt;
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.error));
      expect(yield* subscriptionsAfterSettling).toBe(1);

      for (const [index, delay] of [250, 500, 1000].entries()) {
        yield* TestClock.adjust(delay - 1);
        expect(yield* subscriptionsAfterSettling).toBe(index + 1);
        yield* TestClock.adjust(1);
        expect(yield* subscriptionsAfterSettling).toBe(index + 2);
        yield* failAttempt;
      }
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );

  describe("resuming", () => {
    const resubscribe = Effect.fn("TestEnvironmentThreads.resubscribe")(function* (
      harness: Effect.Success<ReturnType<typeof makeHarness>>,
    ) {
      const before = yield* Ref.get(harness.subscriptionCount);
      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) > before) break;
        yield* Effect.yieldNow;
      }
      return (yield* Ref.get(harness.subscribeInputs)).at(-1);
    });
    const live = (title: string) => (value: EnvironmentThreadState) =>
      value.status === "live" && Option.isSome(value.data) && value.data.value.title === title;

    it.effect("resumes from the revision it applied and keeps its thread when unchanged", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Queue.offer(harness.inputs, { ...snapshot(BASE_THREAD), revision: "rev-1" });
        const opened = yield* awaitThreadState(harness.observed, live(BASE_THREAD.title));
        expect((yield* Ref.get(harness.subscribeInputs))[0]).toEqual({
          threadId: THREAD_ID,
          patches: true,
          history: {},
        });

        expect(yield* resubscribe(harness)).toEqual({
          threadId: THREAD_ID,
          patches: true,
          history: {},
          resume: { revision: "rev-1", snapshotSequence: 1 },
        });
        yield* Queue.offer(harness.inputs, {
          kind: "unchanged",
          snapshotSequence: 1,
          revision: "rev-1",
        });
        const resumed = yield* awaitThreadState(
          harness.observed,
          (value) => value.status === "live",
        );
        expect(Option.getOrThrow(resumed.data)).toBe(Option.getOrThrow(opened.data));
      }),
    );

    it.effect("resumes from a patch's revision", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Queue.offer(harness.inputs, { ...snapshot(BASE_THREAD), revision: "rev-1" });
        yield* Queue.offer(harness.inputs, {
          kind: "patch",
          snapshotSequence: 4,
          patch: { set: { title: "Patched" }, unset: [], arrays: {} },
          revision: "rev-2",
        });
        yield* awaitThreadState(harness.observed, live("Patched"));
        expect(yield* resubscribe(harness)).toMatchObject({
          resume: { revision: "rev-2", snapshotSequence: 4 },
        });
      }),
    );

    // Mixed versions: an older server sends no revision, so the client never asks to resume.
    it.effect("does not resume from a server that sends no revision", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
        yield* awaitThreadState(harness.observed, live(BASE_THREAD.title));
        expect(yield* resubscribe(harness)).toEqual({
          threadId: THREAD_ID,
          patches: true,
          history: {},
        });
      }),
    );

    it.effect("does not resume once a thread changed without a revision", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Queue.offer(harness.inputs, { ...snapshot(BASE_THREAD), revision: "rev-1" });
        yield* Queue.offer(harness.inputs, titleUpdated("Evented"));
        yield* awaitThreadState(harness.observed, live("Evented"));
        expect(yield* resubscribe(harness)).toEqual({
          threadId: THREAD_ID,
          patches: true,
          history: {},
        });
      }),
    );

    // A reload or an app restart against a server that kept running (#227).
    describe("after a cold start", () => {
      const firstSubscribe = Effect.fn("TestEnvironmentThreads.firstSubscribe")(function* (
        harness: Effect.Success<ReturnType<typeof makeHarness>>,
      ) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.subscriptionCount)) > 0) break;
          yield* Effect.yieldNow;
        }
        return (yield* Ref.get(harness.subscribeInputs))[0];
      });
      const lastSaved = Effect.fn("TestEnvironmentThreads.lastSaved")(function* (
        harness: Effect.Success<ReturnType<typeof makeHarness>>,
      ) {
        yield* TestClock.adjust("500 millis");
        yield* Effect.yieldNow;
        return (yield* Ref.get(harness.savedThreads)).at(-1);
      });

      it.effect("resumes from the cached revision and keeps the cached thread when unchanged", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({
            cached: BASE_THREAD,
            cachedResumeFrom: { revision: "rev-1", snapshotSequence: 3 },
          });
          const cached = yield* awaitThreadState(
            harness.observed,
            (value) => value.status === "cached",
          );
          expect(yield* firstSubscribe(harness)).toEqual({
            threadId: THREAD_ID,
            patches: true,
            history: {},
            resume: { revision: "rev-1", snapshotSequence: 3 },
          });

          yield* Queue.offer(harness.inputs, {
            kind: "unchanged",
            snapshotSequence: 5,
            revision: "rev-1",
          });
          const resumed = yield* awaitThreadState(
            harness.observed,
            (value) => value.status === "live",
          );
          expect(Option.getOrThrow(resumed.data)).toBe(Option.getOrThrow(cached.data));
          // Nothing changed, so the cached thread is not written again.
          expect(yield* lastSaved(harness)).toBeUndefined();
        }),
      );

      it.effect("subscribes without resume from a cache written before revisions were saved", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ cached: BASE_THREAD });
          expect(yield* firstSubscribe(harness)).toEqual({
            threadId: THREAD_ID,
            patches: true,
            history: {},
          });
        }),
      );

      it.effect("saves the revision with the thread it describes", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* Queue.offer(harness.inputs, { ...snapshot(BASE_THREAD), revision: "rev-1" });
          yield* Queue.offer(harness.inputs, {
            kind: "patch",
            snapshotSequence: 4,
            patch: { set: { title: "Patched" }, unset: [], arrays: {} },
            revision: "rev-2",
          });
          yield* awaitThreadState(harness.observed, live("Patched"));
          expect(yield* lastSaved(harness)).toMatchObject({
            thread: { title: "Patched" },
            resumeFrom: { revision: "rev-2", snapshotSequence: 4 },
          });
        }),
      );

      it.effect("clears the saved revision after a snapshot without one", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({
            cached: BASE_THREAD,
            cachedResumeFrom: { revision: "rev-1", snapshotSequence: 3 },
          });
          yield* Queue.offer(harness.inputs, snapshot({ ...BASE_THREAD, title: "Fresh" }));
          yield* awaitThreadState(harness.observed, live("Fresh"));
          expect(yield* lastSaved(harness)).toMatchObject({
            thread: { title: "Fresh" },
            resumeFrom: null,
          });
        }),
      );

      it.effect("clears the saved revision after a change no revision describes", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* Queue.offer(harness.inputs, { ...snapshot(BASE_THREAD), revision: "rev-1" });
          yield* Queue.offer(harness.inputs, titleUpdated("Evented"));
          yield* awaitThreadState(harness.observed, live("Evented"));
          expect(yield* lastSaved(harness)).toMatchObject({
            thread: { title: "Evented" },
            resumeFrom: null,
          });
        }),
      );

      it.effect("clears the saved revision even when the change leaves the thread as it was", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* Queue.offer(harness.inputs, {
            kind: "snapshot",
            snapshot: { snapshotSequence: 5, thread: BASE_THREAD },
            revision: "rev-1",
          });
          yield* awaitThreadState(harness.observed, live(BASE_THREAD.title));
          expect(yield* lastSaved(harness)).toMatchObject({ resumeFrom: { revision: "rev-1" } });
          // A replayed event changes nothing but no longer matches a revision.
          yield* Queue.offer(harness.inputs, titleUpdated("Replayed", 2));
          for (let index = 0; index < 10; index += 1) {
            yield* Effect.yieldNow;
          }
          expect(yield* lastSaved(harness)).toMatchObject({
            thread: { title: BASE_THREAD.title },
            resumeFrom: null,
          });
        }),
      );
    });
  });

  // The thread history window (#226).
  describe("history window", () => {
    const at = (minute: number) => `2026-04-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
    const floor = (minute: number, id: string) =>
      btoa(JSON.stringify({ v: 1, k: [at(minute), 0, id], openedAt: 50, epoch: 0 }))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    const FLOOR = floor(10, "m10");
    const message = (
      id: string,
      minute: number,
      extra: Partial<OrchestrationThread["messages"][number]> = {},
    ): OrchestrationThread["messages"][number] => ({
      id: MessageId.make(id),
      role: "user",
      text: id,
      turnId: null,
      streaming: false,
      createdAt: at(minute),
      updatedAt: at(minute),
      ...extra,
    });
    const activity = (
      id: string,
      minute: number,
      sequence: number,
      extra: Partial<OrchestrationThread["activities"][number]> = {},
    ): OrchestrationThread["activities"][number] => ({
      id: EventId.make(id),
      tone: "info",
      kind: "status",
      summary: id,
      payload: {},
      turnId: null,
      sequence,
      createdAt: at(minute),
      ...extra,
    });
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => from + index);
    const windowThread = (
      messages = range(10, 19).map((minute) => message(`m${minute}`, minute)),
      history: Partial<NonNullable<OrchestrationThread["history"]>> = {},
      extra: Partial<OrchestrationThread> = {},
    ): OrchestrationThread => ({
      ...BASE_THREAD,
      messages,
      history: {
        floor: FLOOR,
        hasOlder: true,
        olderRows: 10,
        carried: { activities: [], proposedPlans: [] },
        ...history,
      },
      ...extra,
    });
    const page = (
      minutes: ReadonlyArray<number>,
      cursor: string | null,
      extra: Partial<OrchestrationThreadHistoryPage> = {},
    ): OrchestrationThreadHistoryPage => ({
      messages: minutes.map((minute) => message(`m${minute}`, minute)),
      activities: [],
      reasoning: [],
      proposedPlans: [],
      checkpoints: [],
      cursor,
      olderRows: cursor === null ? 0 : 5,
      ...extra,
    });
    // Pages by cursor: the window's floor, then `c1`, `c2`, ...
    const pagesOf = (pages: ReadonlyArray<OrchestrationThreadHistoryPage>) => (cursor: string) => {
      const index = cursor === FLOOR ? 0 : Number(cursor.slice(1));
      const found = pages[index];
      return found === undefined ? Effect.die(`no page ${cursor}`) : Effect.succeed(found);
    };
    const TWO_PAGES = [page([5, 6, 7, 8, 9], "c1"), page([0, 1, 2, 3, 4], null)];
    const messageIds = (state: EnvironmentThreadState) =>
      Option.getOrThrow(state.data).messages.map((row) => row.id as string);
    const current = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
      Ref.get(harness.latest);
    const loadOlder = Effect.fn("TestEnvironmentThreads.loadOlder")(function* (
      harness: Effect.Success<ReturnType<typeof makeHarness>>,
    ) {
      const state = yield* current(harness);
      return yield* state.olderHistory!.loadOlder;
    });
    const opened = Effect.fn("TestEnvironmentThreads.opened")(function* (
      harness: Effect.Success<ReturnType<typeof makeHarness>>,
      thread: OrchestrationThread = windowThread(),
    ) {
      yield* Queue.offer(harness.inputs, { ...snapshot(thread), revision: "rev-1" });
      return yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
    });
    const settle = Effect.fn("TestEnvironmentThreads.settle")(function* () {
      for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
    });
    const resubscribe = Effect.fn("TestEnvironmentThreads.resubscribeWindow")(function* (
      harness: Effect.Success<ReturnType<typeof makeHarness>>,
    ) {
      const before = yield* Ref.get(harness.subscriptionCount);
      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) > before) break;
        yield* Effect.yieldNow;
      }
      return (yield* Ref.get(harness.subscribeInputs)).at(-1);
    });
    const patchMessages = (
      length: number,
      changes: ReadonlyArray<readonly [number, unknown]>,
      sequence = 2,
    ): OrchestrationThreadStreamItem => ({
      kind: "patch",
      snapshotSequence: sequence,
      patch: { set: {}, unset: [], arrays: { messages: { length, changes } } },
      revision: `rev-${sequence}`,
    });

    describe("loading pages", () => {
      it.effect("opens with the server's window and reports older history", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const state = yield* opened(harness);
          const history = Option.getOrThrow(state.data).history;
          expect(history).toMatchObject({ floor: FLOOR, hasOlder: true, olderRows: 10 });
          expect(history?.loadedFrom).toEqual({ createdAt: at(10), rank: 0, id: "m10" });
          expect(state.olderHistory?.status).toBe("idle");
        }),
      );

      it.effect("publishes carried rows to state readers", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const ask = activity("ask", 1, 3, {
            kind: "user-input.requested",
            payload: { requestId: "q1" },
          });
          const state = yield* opened(
            harness,
            windowThread(
              undefined,
              { carried: { activities: [ask], proposedPlans: [] } },
              {
                activities: [activity("recent", 15, 9)],
              },
            ),
          );
          expect(Option.getOrThrow(state.data).activities.map((row) => row.id)).toEqual([
            "ask",
            "recent",
          ]);
        }),
      );

      it.effect("loads two older pages in order before the window", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ pages: pagesOf(TWO_PAGES) });
          yield* opened(harness);
          yield* loadOlder(harness);
          yield* loadOlder(harness);
          const state = yield* current(harness);
          expect(messageIds(state)).toEqual(range(0, 19).map((minute) => `m${minute}`));
          expect(Option.getOrThrow(state.data).history).toMatchObject({
            hasOlder: false,
            olderRows: 0,
            loadedFrom: null,
          });
          expect(yield* Ref.get(harness.pageRequests)).toEqual([FLOOR, "c1"]);
        }),
      );

      it.effect("applies a patch that arrives between two pages to the window only", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ pages: pagesOf(TWO_PAGES) });
          yield* opened(harness);
          yield* loadOlder(harness);
          yield* Queue.offer(harness.inputs, patchMessages(11, [[10, message("m20", 20)]]));
          yield* awaitThreadState(harness.observed, (value) => messageIds(value).includes("m20"));
          yield* loadOlder(harness);
          const state = yield* current(harness);
          expect(messageIds(state)).toEqual(range(0, 20).map((minute) => `m${minute}`));
          yield* TestClock.adjust("500 millis");
          yield* Effect.yieldNow;
          expect(
            (yield* Ref.get(harness.savedThreads)).at(-1)?.thread.messages.map((row) => row.id),
          ).toEqual(range(10, 20).map((minute) => `m${minute}`));
        }),
      );

      it.effect("sends exactly N-1 page requests to reach the start of an N-page thread", () =>
        Effect.gen(function* () {
          // The window and four older pages.
          const pages = [3, 2, 1, 0].map((index) =>
            page([index * 2, index * 2 + 1], index === 0 ? null : `c${4 - index}`),
          );
          const harness = yield* makeHarness({ pages: pagesOf(pages) });
          yield* opened(harness);
          yield* (yield* current(harness)).olderHistory!.loadAllOlder;
          yield* loadOlder(harness);
          expect(yield* Ref.get(harness.pageRequests)).toHaveLength(4);
          expect(Option.getOrThrow((yield* current(harness)).data).history?.hasOlder).toBe(false);
        }),
      );
    });

    describe("merge", () => {
      it.effect("a window copy replaces the copy a page loaded", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ pages: pagesOf(TWO_PAGES) });
          yield* opened(harness);
          yield* loadOlder(harness);
          // The server wrote m9 again after the window opened: it moved into the window.
          yield* Queue.offer(
            harness.inputs,
            patchMessages(11, [[10, message("m9", 9, { text: "edited" })]]),
          );
          const state = yield* awaitThreadState(harness.observed, (value) =>
            Option.getOrThrow(value.data).messages.some((row) => row.text === "edited"),
          );
          const copies = Option.getOrThrow(state.data).messages.filter((row) => row.id === "m9");
          expect(copies.map((row) => row.text)).toEqual(["edited"]);
        }),
      );

      it.effect("a withdrawn queued message disappears and no page resurrects it", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ pages: pagesOf(TWO_PAGES) });
          const queued = message("queued", 2, {
            delivery: { state: "queued", provider: ProviderDriverKind.make("codex") },
          });
          yield* opened(harness, windowThread([...windowThread().messages, queued]));
          yield* loadOlder(harness);
          yield* Queue.offer(harness.inputs, patchMessages(10, []));
          yield* awaitThreadState(
            harness.observed,
            (value) => !messageIds(value).includes("queued"),
          );
          yield* loadOlder(harness);
          expect(messageIds(yield* current(harness))).not.toContain("queued");
        }),
      );

      it.effect(
        "keeps the admission order of queued messages when one is backdated below the floor",
        () =>
          Effect.gen(function* () {
            const harness = yield* makeHarness({ pages: pagesOf(TWO_PAGES) });
            const first = message("queued-first", 30, {
              delivery: { state: "queued", provider: ProviderDriverKind.make("codex") },
            });
            const backdated = message("queued-backdated", 1, {
              delivery: { state: "queued", provider: ProviderDriverKind.make("codex") },
            });
            yield* opened(harness, windowThread([...windowThread().messages, first, backdated]));
            yield* loadOlder(harness);
            const ids = messageIds(yield* current(harness));
            expect(ids.slice(-2)).toEqual(["queued-first", "queued-backdated"]);
          }),
      );

      it.effect(
        "merges activities in canonical order so a carried status with a higher sequence wins",
        () =>
          Effect.gen(function* () {
            const usage = (id: string, minute: number, sequence: number, usedTokens: number) =>
              activity(id, minute, sequence, {
                kind: "context-window.updated",
                payload: { usedTokens },
              });
            const harness = yield* makeHarness({
              pages: pagesOf([
                page([5, 6, 7, 8, 9], "c1", { activities: [usage("usage-stale", 7, 10, 2000)] }),
              ]),
            });
            yield* opened(
              harness,
              windowThread(
                undefined,
                // A clock correction: the newest usage has the highest sequence, an early time.
                { carried: { activities: [usage("usage-now", 3, 200, 1000)], proposedPlans: [] } },
                { activities: [activity("tool", 15, 100)] },
              ),
            );
            yield* loadOlder(harness);
            expect(
              Option.getOrThrow((yield* current(harness)).data).activities.map((row) => row.id),
            ).toEqual(["usage-stale", "tool", "usage-now"]);
          }),
      );

      it.effect(
        "a page checkpoint fills in files only while it matches the window's checkpoint",
        () =>
          Effect.gen(function* () {
            const TURN = TurnId.make("turn-1");
            const checkpoint = (
              status: "ready" | "missing" | "error",
              files: number,
              filesTotal: number,
            ): OrchestrationThread["checkpoints"][number] => ({
              turnId: TURN,
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.make("ref-1"),
              status,
              files: range(1, files).map((index) => ({
                path: `src/${index}.ts`,
                kind: "modified",
                additions: 1,
                deletions: 0,
              })),
              filesTotal,
              assistantMessageId: null,
              completedAt: at(9),
            });
            const harness = yield* makeHarness({
              pages: pagesOf([
                page([5, 6, 7, 8, 9], "c1", { checkpoints: [checkpoint("ready", 2, 2)] }),
              ]),
            });
            yield* opened(
              harness,
              windowThread(undefined, {}, { checkpoints: [checkpoint("ready", 0, 2)] }),
            );
            yield* loadOlder(harness);
            const files = (state: EnvironmentThreadState) =>
              Option.getOrThrow(state.data).checkpoints[0]?.files.length;
            expect(files(yield* current(harness))).toBe(2);
            // The stream moves the window's checkpoint on: the page copy no longer matches it.
            yield* Queue.offer(harness.inputs, {
              kind: "patch",
              snapshotSequence: 3,
              patch: {
                set: {},
                unset: [],
                arrays: { checkpoints: { length: 1, changes: [[0, checkpoint("error", 0, 2)]] } },
              },
              revision: "rev-3",
            });
            const moved = yield* awaitThreadState(
              harness.observed,
              (value) => Option.getOrThrow(value.data).checkpoints[0]?.status === "error",
            );
            expect(files(moved)).toBe(0);
          }),
      );
    });

    describe("stale and duplicate answers", () => {
      const delayed = Effect.fn("TestEnvironmentThreads.delayed")(function* () {
        const answer = yield* Deferred.make<OrchestrationThreadHistoryPage>();
        return { answer, pages: () => Deferred.await(answer) };
      });

      it.effect("drops a page that answers a superseded cursor or generation", () =>
        Effect.gen(function* () {
          const { answer, pages } = yield* delayed();
          const harness = yield* makeHarness({ pages });
          yield* opened(harness);
          const first = yield* Effect.forkChild(loadOlder(harness));
          const duplicate = yield* Effect.forkChild(loadOlder(harness));
          yield* settle();
          // An older server's whole thread supersedes the window the page was for.
          yield* Queue.offer(
            harness.inputs,
            snapshot({ ...BASE_THREAD, messages: [message("m0", 0)] }),
          );
          yield* awaitThreadState(harness.observed, (value) => messageIds(value).length === 1);
          yield* Deferred.succeed(answer, TWO_PAGES[0]!);
          yield* Fiber.join(first);
          yield* Fiber.join(duplicate);
          expect(messageIds(yield* current(harness))).toEqual(["m0"]);
          expect(yield* Ref.get(harness.pageRequests)).toHaveLength(1);
        }),
      );

      it.effect("drops a page in flight when a snapshot moves the floor", () =>
        Effect.gen(function* () {
          const { answer, pages } = yield* delayed();
          const harness = yield* makeHarness({ pages });
          yield* opened(harness);
          const loading = yield* Effect.forkChild(loadOlder(harness));
          yield* settle();
          const moved = windowThread(
            range(15, 19).map((minute) => message(`m${minute}`, minute)),
            {
              floor: floor(15, "m15"),
            },
          );
          yield* Queue.offer(harness.inputs, snapshot(moved));
          yield* awaitThreadState(harness.observed, (value) => messageIds(value)[0] === "m15");
          yield* Deferred.succeed(answer, TWO_PAGES[0]!);
          yield* Fiber.join(loading);
          expect(messageIds(yield* current(harness))[0]).toBe("m15");
        }),
      );

      it.effect("drops loaded pages when a page answers stale", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({
            pages: (cursor) =>
              cursor === FLOOR
                ? Effect.succeed(TWO_PAGES[0]!)
                : Effect.fail(new OrchestrationThreadHistoryStaleError({ message: "reverted" })),
          });
          yield* opened(harness);
          yield* loadOlder(harness);
          expect(messageIds(yield* current(harness))).toHaveLength(15);
          const failed = yield* Effect.flip(loadOlder(harness));
          expect(failed._tag).toBe("OrchestrationThreadHistoryStaleError");
          const state = yield* current(harness);
          expect(messageIds(state)).toEqual(range(10, 19).map((minute) => `m${minute}`));
          expect(state.olderHistory?.status).toBe("idle");
        }),
      );
    });

    describe("reconnect and persistence", () => {
      it.effect("keeps loaded pages when a resubscribe is answered unchanged", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ pages: pagesOf(TWO_PAGES) });
          yield* opened(harness);
          yield* loadOlder(harness);
          yield* resubscribe(harness);
          yield* Queue.offer(harness.inputs, {
            kind: "unchanged",
            snapshotSequence: 1,
            revision: "rev-1",
          });
          yield* settle();
          expect(messageIds(yield* current(harness))).toHaveLength(15);
        }),
      );

      it.effect(
        "keeps loaded pages when a snapshot keeps the floor and drops them when it moves",
        () =>
          Effect.gen(function* () {
            const harness = yield* makeHarness({ pages: pagesOf(TWO_PAGES) });
            yield* opened(harness);
            yield* loadOlder(harness);
            yield* Queue.offer(
              harness.inputs,
              snapshot(windowThread([...windowThread().messages, message("m20", 20)])),
            );
            const kept = yield* awaitThreadState(harness.observed, (value) =>
              messageIds(value).includes("m20"),
            );
            expect(messageIds(kept)).toHaveLength(16);
            yield* Queue.offer(
              harness.inputs,
              snapshot(windowThread([message("m19", 19)], { floor: floor(19, "m19") })),
            );
            const dropped = yield* awaitThreadState(
              harness.observed,
              (value) => messageIds(value)[0] === "m19",
            );
            expect(messageIds(dropped)).toEqual(["m19"]);
          }),
      );

      it.effect("resubscribes with the floor it holds", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* opened(harness);
          expect(yield* resubscribe(harness)).toEqual({
            threadId: THREAD_ID,
            patches: true,
            history: { floor: FLOOR },
            resume: { revision: "rev-1", snapshotSequence: 1 },
          });
        }),
      );

      it.effect("persists the window, not the loaded pages", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ pages: pagesOf(TWO_PAGES) });
          yield* opened(harness);
          yield* loadOlder(harness);
          yield* Queue.offer(harness.inputs, patchMessages(11, [[10, message("m20", 20)]]));
          yield* awaitThreadState(harness.observed, (value) => messageIds(value).includes("m20"));
          yield* TestClock.adjust("500 millis");
          yield* Effect.yieldNow;
          const saved = (yield* Ref.get(harness.savedThreads)).at(-1)?.thread;
          expect(saved?.messages).toHaveLength(11);
          expect(saved?.history?.loadedFrom).toBeUndefined();
        }),
      );

      it.effect("treats a snapshot without history as the whole thread", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ pages: pagesOf(TWO_PAGES) });
          const state = yield* opened(harness, { ...BASE_THREAD, messages: [message("m0", 0)] });
          expect(Option.getOrThrow(state.data).history).toBeUndefined();
          yield* loadOlder(harness);
          yield* (yield* current(harness)).olderHistory!.loadAllOlder;
          expect(yield* Ref.get(harness.pageRequests)).toEqual([]);
        }),
      );
    });

    describe("load-all", () => {
      it.effect("loadAllOlder waits for a page already in flight instead of looping", () =>
        Effect.gen(function* () {
          const answer = yield* Deferred.make<void>();
          const harness = yield* makeHarness({
            pages: (cursor) =>
              Deferred.await(answer).pipe(Effect.andThen(pagesOf(TWO_PAGES)(cursor))),
          });
          yield* opened(harness);
          const single = yield* Effect.forkChild(loadOlder(harness));
          yield* settle();
          const all = yield* Effect.forkChild((yield* current(harness)).olderHistory!.loadAllOlder);
          yield* settle();
          expect(yield* Ref.get(harness.pageRequests)).toEqual([FLOOR]);
          yield* Deferred.succeed(answer, undefined);
          yield* Fiber.join(single);
          yield* Fiber.join(all);
          expect(yield* Ref.get(harness.pageRequests)).toEqual([FLOOR, "c1"]);
          expect(messageIds(yield* current(harness))).toHaveLength(20);
        }),
      );

      it.effect("loadAllOlder stops on the first failure", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({
            pages: (cursor) =>
              cursor === FLOOR
                ? Effect.succeed(TWO_PAGES[0]!)
                : Effect.fail(new OrchestrationGetThreadHistoryPageError({ message: "offline" })),
          });
          yield* opened(harness);
          const failure = yield* Effect.flip((yield* current(harness)).olderHistory!.loadAllOlder);
          expect(failure._tag).toBe("OrchestrationGetThreadHistoryPageError");
          expect(yield* Ref.get(harness.pageRequests)).toEqual([FLOOR, "c1"]);
          expect((yield* current(harness)).olderHistory?.status).toBe("error");
        }),
      );

      it.effect("interrupting loadAllOlder releases the loading state", () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ pages: () => Effect.never });
          yield* opened(harness);
          const all = yield* Effect.forkChild((yield* current(harness)).olderHistory!.loadAllOlder);
          yield* awaitThreadState(
            harness.observed,
            (value) => value.olderHistory?.status === "loading",
          );
          yield* Fiber.interrupt(all);
          yield* settle();
          expect((yield* current(harness)).olderHistory?.status).toBe("idle");
          // Nothing is left in flight: the next load sends its own request.
          yield* Effect.forkChild(loadOlder(harness));
          yield* settle();
          expect(yield* Ref.get(harness.pageRequests)).toHaveLength(2);
        }),
      );
    });
  });
});
