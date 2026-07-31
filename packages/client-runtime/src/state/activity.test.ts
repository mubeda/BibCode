import {
  ActivityEntryId,
  ActivityError,
  ActivityRecordId,
  ActivityScopeId,
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
  WS_METHODS,
  type ActivityDelta,
  type ActivityScopeRef,
  type ActivitySnapshot,
  type ActivityStreamItem,
  type ServerConfig,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  ACTIVITY_STATE_IDLE_TTL_MS,
  createEnvironmentActivityAtoms,
  makeEnvironmentActivityState,
  type EnvironmentActivityState,
} from "./activity.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const SCOPE: ActivityScopeRef = {
  _tag: "thread",
  threadId: ThreadId.make("thread-1"),
};
const SCOPE_ID = ActivityScopeId.make("scope:thread-1");
const REPLACEMENT_SCOPE: ActivityScopeRef = {
  _tag: "thread",
  threadId: ThreadId.make("thread-2"),
};
const REPLACEMENT_SCOPE_ID = ActivityScopeId.make("scope:thread-2");
const TERMINAL_SCOPE: ActivityScopeRef = {
  _tag: "terminal",
  threadId: ThreadId.make("thread-1"),
  terminalId: "terminal-1",
};
const TERMINAL_SCOPE_ID_1 = ActivityScopeId.make("scope:terminal-1:generation-1");
const TERMINAL_SCOPE_ID_2 = ActivityScopeId.make("scope:terminal-1:generation-2");
const ACTOR_ID = ActivityRecordId.make("actor:child-1");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function snapshot(
  revision = 3,
  name = "Explore provider events",
  overrides: Partial<ActivitySnapshot> = {},
): ActivitySnapshot {
  return {
    protocolVersion: 1,
    scopeId: SCOPE_ID,
    scope: SCOPE,
    revision,
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: null,
    capabilities: {
      actors: true,
      attributedActivity: true,
      backgroundWork: false,
      historyRecovery: "full",
      terminalObservation: false,
    },
    observationState: "live",
    sections: {
      subagents: { state: "live", message: null, retryable: false },
      backgroundTasks: { state: "unsupported", message: null, retryable: false },
    },
    counts: {
      subagents: { active: 1, done: 0 },
      backgroundTasks: { active: 0, done: 0 },
    },
    actors: [
      {
        _tag: "actor",
        id: ACTOR_ID,
        parentActorId: null,
        name,
        role: "explorer",
        providerType: "worker",
        status: "running",
        summary: "Reading protocol schemas",
        startedAt: "2026-07-22T12:00:00Z",
        updatedAt: "2026-07-22T12:00:01Z",
        terminalAt: null,
      },
    ],
    workItems: [],
    actorsHasMore: false,
    workItemsHasMore: false,
    updatedAt: "2026-07-22T12:00:01Z",
    ...overrides,
  };
}

function gapDelta(previousRevision = 5, revision = 6): ActivityDelta {
  return {
    scopeId: SCOPE_ID,
    previousRevision,
    revision,
    changes: [
      {
        kind: "actor-upserted",
        actor: {
          ...snapshot().actors[0]!,
          summary: "Gap",
        },
      },
    ],
    updatedAt: "2026-07-22T12:00:02Z",
  };
}

function serverConfig(protocolVersion: 1 | null): ServerConfig {
  return {
    environment: {
      capabilities: {
        activityProtocolVersion: protocolVersion,
      },
    },
  } as ServerConfig;
}

function testSession(
  client: WsRpcProtocolClient,
  protocolVersion: 1 | null = 1,
  initialConfig: Effect.Effect<ServerConfig, ConnectionTransientError> = Effect.succeed(
    serverConfig(protocolVersion),
  ),
): RpcSession.RpcSession {
  return {
    client,
    initialConfig,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitState(
  state: SubscriptionRef.SubscriptionRef<EnvironmentActivityState>,
  predicate: (value: EnvironmentActivityState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.runHead,
    Effect.repeat({
      until: Option.exists(predicate),
    }),
    Effect.map(Option.getOrThrow),
  );
}

interface HarnessOptions {
  readonly protocolVersion?: 1 | null;
  readonly initialConfig?: Effect.Effect<ServerConfig, ConnectionTransientError>;
  readonly getSnapshot?: (
    requestNumber: number,
    scope: ActivityScopeRef,
  ) => Effect.Effect<ActivitySnapshot, Error>;
  readonly scope?: ActivityScopeRef;
  readonly streamForSubscription?: (
    subscriptionNumber: number,
  ) => Stream.Stream<ActivityStreamItem, Error>;
}

const makeHarnessCore = Effect.fn("TestEnvironmentActivity.makeHarnessCore")(function* (
  options: HarnessOptions = {},
) {
  const inputs = yield* Queue.unbounded<ActivityStreamItem | Error>();
  const subscriptionCount = yield* Ref.make(0);
  const streamFinalizerCount = yield* Ref.make(0);
  const snapshotRequestCount = yield* Ref.make(0);
  const snapshotRequestScopes = yield* Ref.make<ReadonlyArray<ActivityScopeRef>>([]);
  const streamFromInputs = () =>
    Stream.fromQueue(inputs).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const client = {
    [WS_METHODS.subscribeActivity]: () =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.map((count) =>
            (options.streamForSubscription?.(count) ?? streamFromInputs()).pipe(
              Stream.ensuring(Ref.update(streamFinalizerCount, (finalizers) => finalizers + 1)),
            ),
          ),
        ),
      ),
    [WS_METHODS.activityGetSnapshot]: (scope: ActivityScopeRef) =>
      Ref.updateAndGet(snapshotRequestCount, (count) => count + 1).pipe(
        Effect.tap(() => Ref.update(snapshotRequestScopes, (scopes) => [...scopes, scope])),
        Effect.flatMap(
          (requestNumber) =>
            options.getSnapshot?.(requestNumber, scope) ??
            Effect.succeed(snapshot(6, "Reconciled")),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const initialConfig =
    options.initialConfig ??
    Effect.succeed(
      serverConfig(options.protocolVersion === undefined ? 1 : options.protocolVersion),
    );
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    generation: 1,
  });
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client, options.protocolVersion, initialConfig)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return {
    client,
    inputs,
    subscriptionCount,
    streamFinalizerCount,
    snapshotRequestCount,
    snapshotRequestScopes,
    supervisor,
    supervisorState,
    supervisorSession,
    reconnect: SubscriptionRef.set(
      supervisorSession,
      Option.some(testSession(client, 1, Effect.succeed(serverConfig(1)))),
    ),
  };
});

const makeHarness = Effect.fn("TestEnvironmentActivity.makeHarness")(function* (
  options: HarnessOptions = {},
) {
  const harness = yield* makeHarnessCore(options);
  const state = yield* makeEnvironmentActivityState(options.scope ?? SCOPE).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, harness.supervisor),
  );
  return { ...harness, state };
});

describe("environment activity stream state", () => {
  it.effect("treats a feature-disabled stream failure as terminal and does not retry", () =>
    Effect.gen(function* () {
      // Mutation caught: handling featureDisabled like a transient stream failure retries it.
      const harness = yield* makeHarness({
        streamForSubscription: () =>
          Stream.fail(
            new ActivityError({
              reason: "featureDisabled",
              message: "Agent activity is disabled for this environment.",
            }),
          ),
      });
      const failed = yield* awaitState(
        harness.state,
        (state) => state.status === "empty" || Option.isSome(state.error),
      );

      expect(failed.status).toBe("empty");
      expect(Option.isNone(failed.snapshot)).toBe(true);
      expect(Option.isNone(failed.error)).toBe(true);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.streamFinalizerCount)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.streamFinalizerCount)).toBe(1);

      yield* TestClock.adjust("1 second");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
    }),
  );

  it.effect("stops the stream when feature-disabled snapshot recovery fails", () =>
    Effect.gen(function* () {
      // Mutation caught: retaining a live stream or recovery token after a disabled read.
      const harness = yield* makeHarness({
        getSnapshot: () =>
          Effect.fail(
            new ActivityError({
              reason: "featureDisabled",
              message: "Agent activity is disabled for this environment.",
            }),
          ),
      });
      yield* Queue.offer(harness.inputs, { kind: "snapshot", snapshot: snapshot() });
      yield* awaitState(harness.state, (state) => state.status === "live");
      yield* Queue.offer(harness.inputs, { kind: "delta", delta: gapDelta() });
      const failed = yield* awaitState(
        harness.state,
        (state) => state.status === "empty" || Option.isSome(state.error),
      );

      expect(failed.status).toBe("empty");
      expect(Option.isNone(failed.snapshot)).toBe(true);
      expect(Option.isNone(failed.error)).toBe(true);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.streamFinalizerCount)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.streamFinalizerCount)).toBe(1);
    }),
  );

  it.effect("makes the initial stream snapshot live", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: snapshot(),
      });

      const live = yield* awaitState(
        harness.state,
        (state) => state.status === "live" && Option.isSome(state.snapshot),
      );

      expect(Option.getOrThrow(live.snapshot).revision).toBe(3);
      expect(Option.isNone(live.error)).toBe(true);
    }),
  );

  it.effect("preserves data as stale on disconnect and subscribes once on reconnect", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, { kind: "snapshot", snapshot: snapshot() });
      yield* awaitState(harness.state, (state) => state.status === "live");

      yield* SubscriptionRef.set(harness.supervisorSession, Option.none());
      const disconnected: SupervisorConnectionState = {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "offline",
        phase: "offline",
        generation: 1,
      };
      yield* SubscriptionRef.set(harness.supervisorState, disconnected);
      const stale = yield* awaitState(harness.state, (state) => state.status === "stale");

      expect(Option.getOrThrow(stale.snapshot).revision).toBe(3);

      yield* harness.reconnect;
      const reconnected: SupervisorConnectionState = {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connected",
        generation: 2,
      };
      yield* SubscriptionRef.set(harness.supervisorState, reconnected);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) === 2) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("fetches one authoritative snapshot for a revision gap and replaces atomically", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, { kind: "snapshot", snapshot: snapshot() });
      yield* awaitState(harness.state, (state) => state.status === "live");
      yield* Queue.offer(harness.inputs, { kind: "delta", delta: gapDelta() });

      const reconciled = yield* awaitState(
        harness.state,
        (state) =>
          state.status === "live" &&
          Option.isSome(state.snapshot) &&
          state.snapshot.value.revision === 6,
      );

      expect(Option.getOrThrow(reconciled.snapshot).actors[0]?.name).toBe("Reconciled");
      expect(yield* Ref.get(harness.snapshotRequestCount)).toBe(1);
    }),
  );

  it.effect("recovers an authoritative snapshot after a capped roster removes a visible row", () =>
    Effect.gen(function* () {
      const cappedActors = Array.from({ length: 200 }, (_, index) => ({
        ...snapshot().actors[0]!,
        id: ActivityRecordId.make(`actor:capped-${index}`),
        updatedAt: `2026-07-22T12:00:00.${String(index).padStart(3, "0")}Z`,
      }));
      const harness = yield* makeHarness({
        getSnapshot: () => Effect.succeed(snapshot(5, "Authoritative refill")),
      });
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: snapshot(3, "Capped roster", {
          actors: cappedActors,
          actorsHasMore: true,
        }),
      });
      yield* awaitState(harness.state, (state) => state.status === "live");
      yield* Queue.offer(harness.inputs, {
        kind: "delta",
        delta: {
          scopeId: SCOPE_ID,
          previousRevision: 3,
          revision: 4,
          changes: [{ kind: "actor-removed", actorId: cappedActors[0]!.id }],
          updatedAt: "2026-07-22T12:01:00.000Z",
        },
      });

      const recovered = yield* awaitState(
        harness.state,
        (state) =>
          state.status === "live" &&
          Option.isSome(state.snapshot) &&
          state.snapshot.value.revision === 5,
      );

      expect(yield* Ref.get(harness.snapshotRequestCount)).toBe(1);
      expect(Option.getOrThrow(recovered.snapshot).actors[0]?.name).toBe("Authoritative refill");
    }),
  );

  it.effect("finalizes an old activity scope before ignoring its late stream values", () =>
    Effect.gen(function* () {
      const oldScope = yield* Scope.make();
      const old = yield* makeHarness().pipe(Scope.provide(oldScope));
      yield* Queue.offer(old.inputs, { kind: "snapshot", snapshot: snapshot(3, "Old scope") });
      yield* awaitState(old.state, (state) => state.status === "live");

      yield* Scope.close(oldScope, Exit.void);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(old.streamFinalizerCount)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(old.streamFinalizerCount)).toBe(1);

      const replacement = yield* makeHarness({ scope: REPLACEMENT_SCOPE });
      yield* Queue.offer(replacement.inputs, {
        kind: "snapshot",
        snapshot: snapshot(1, "Replacement scope", {
          scope: REPLACEMENT_SCOPE,
          scopeId: REPLACEMENT_SCOPE_ID,
        }),
      });
      yield* awaitState(
        replacement.state,
        (state) =>
          Option.isSome(state.snapshot) && state.snapshot.value.scopeId === REPLACEMENT_SCOPE_ID,
      );

      yield* Queue.offer(old.inputs, {
        kind: "snapshot",
        snapshot: snapshot(99, "Late old scope"),
      });
      yield* Queue.offer(replacement.inputs, {
        kind: "snapshot",
        snapshot: snapshot(100, "Late old scope"),
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      const current = yield* SubscriptionRef.get(replacement.state);
      expect(Option.getOrThrow(current.snapshot).scopeId).toBe(REPLACEMENT_SCOPE_ID);
      expect(Option.getOrThrow(current.snapshot).revision).toBe(1);
      expect(Option.getOrThrow(current.snapshot).actors[0]?.name).toBe("Replacement scope");
    }),
  );

  it.effect(
    "accepts a new scope generation for the same terminal and clears generation entries",
    () =>
      Effect.gen(function* () {
        const oldGenerationRecovery = yield* Deferred.make<ActivitySnapshot, Error>();
        const harness = yield* makeHarness({
          scope: TERMINAL_SCOPE,
          getSnapshot: () => Deferred.await(oldGenerationRecovery),
        });
        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshot: snapshot(5, "Old generation", {
            scope: TERMINAL_SCOPE,
            scopeId: TERMINAL_SCOPE_ID_1,
          }),
        });
        yield* awaitState(
          harness.state,
          (state) =>
            Option.isSome(state.snapshot) && state.snapshot.value.scopeId === TERMINAL_SCOPE_ID_1,
        );
        yield* Queue.offer(harness.inputs, {
          kind: "delta",
          delta: {
            scopeId: TERMINAL_SCOPE_ID_1,
            previousRevision: 5,
            revision: 6,
            changes: [
              {
                kind: "entry-appended",
                entry: {
                  id: ActivityEntryId.make("entry:generation-1"),
                  ownerKind: "actor",
                  ownerId: ACTOR_ID,
                  kind: "commentary",
                  title: "Old generation entry",
                  detail: null,
                  tone: "info",
                  createdAt: "2026-07-22T12:00:02Z",
                },
              },
            ],
            updatedAt: "2026-07-22T12:00:02Z",
          },
        });
        yield* awaitState(harness.state, (state) => state.recentEntries.size === 1);
        yield* Queue.offer(harness.inputs, {
          kind: "delta",
          delta: {
            scopeId: TERMINAL_SCOPE_ID_1,
            previousRevision: 8,
            revision: 9,
            changes: [],
            updatedAt: "2026-07-22T12:00:03Z",
          },
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.snapshotRequestCount)) === 1) {
            break;
          }
          yield* Effect.yieldNow;
        }

        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshot: snapshot(1, "New generation", {
            scope: TERMINAL_SCOPE,
            scopeId: TERMINAL_SCOPE_ID_2,
          }),
        });
        const replaced = yield* awaitState(
          harness.state,
          (state) =>
            Option.isSome(state.snapshot) && state.snapshot.value.scopeId === TERMINAL_SCOPE_ID_2,
        );

        expect(Option.getOrThrow(replaced.snapshot).revision).toBe(1);
        expect(Option.getOrThrow(replaced.snapshot).actors[0]?.name).toBe("New generation");
        expect(replaced.recentEntries.size).toBe(0);

        yield* Deferred.succeed(
          oldGenerationRecovery,
          snapshot(50, "Late old generation", {
            scope: TERMINAL_SCOPE,
            scopeId: TERMINAL_SCOPE_ID_1,
          }),
        );
        for (let attempt = 0; attempt < 20; attempt += 1) {
          yield* Effect.yieldNow;
        }
        const afterLateRecovery = yield* SubscriptionRef.get(harness.state);
        expect(Option.getOrThrow(afterLateRecovery.snapshot).scopeId).toBe(TERMINAL_SCOPE_ID_2);
        expect(Option.getOrThrow(afterLateRecovery.snapshot).revision).toBe(1);
      }),
  );

  it.effect("coalesces gap requests and rejects an older replacement snapshot", () =>
    Effect.gen(function* () {
      const releaseSnapshot = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        getSnapshot: () => Deferred.await(releaseSnapshot).pipe(Effect.as(snapshot(4, "Older"))),
      });
      yield* Queue.offer(harness.inputs, { kind: "snapshot", snapshot: snapshot() });
      yield* awaitState(harness.state, (state) => state.status === "live");
      yield* Queue.offer(harness.inputs, { kind: "delta", delta: gapDelta() });
      yield* Queue.offer(harness.inputs, { kind: "delta", delta: gapDelta(7, 8) });
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: snapshot(10, "Newest"),
      });
      yield* awaitState(
        harness.state,
        (state) => Option.isSome(state.snapshot) && state.snapshot.value.revision === 10,
      );

      yield* Deferred.succeed(releaseSnapshot, undefined);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      const current = yield* SubscriptionRef.get(harness.state);

      expect(yield* Ref.get(harness.snapshotRequestCount)).toBe(1);
      expect(Option.getOrThrow(current.snapshot).revision).toBe(10);
      expect(Option.getOrThrow(current.snapshot).actors[0]?.name).toBe("Newest");
    }),
  );

  it.effect("ignores a failed reconciliation from a replaced session", () =>
    Effect.gen(function* () {
      const recovery = yield* Deferred.make<ActivitySnapshot, Error>();
      const harness = yield* makeHarness({
        getSnapshot: () => Deferred.await(recovery),
      });
      yield* Queue.offer(harness.inputs, { kind: "snapshot", snapshot: snapshot() });
      yield* awaitState(harness.state, (state) => state.status === "live");
      yield* Queue.offer(harness.inputs, { kind: "delta", delta: gapDelta() });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.snapshotRequestCount)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      yield* SubscriptionRef.set(harness.supervisorSession, Option.none());
      yield* harness.reconnect;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) === 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: snapshot(10, "Replacement session"),
      });
      yield* awaitState(
        harness.state,
        (state) =>
          state.status === "live" &&
          Option.isSome(state.snapshot) &&
          state.snapshot.value.revision === 10,
      );

      yield* Deferred.fail(recovery, new Error("old session failed"));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      const current = yield* SubscriptionRef.get(harness.state);

      expect(current.status).toBe("live");
      expect(Option.isNone(current.error)).toBe(true);
      expect(Option.getOrThrow(current.snapshot).revision).toBe(10);
    }),
  );

  it.effect("ignores a late reconciliation failure after a newer same-session snapshot", () =>
    Effect.gen(function* () {
      const recovery = yield* Deferred.make<ActivitySnapshot, Error>();
      const harness = yield* makeHarness({
        getSnapshot: () => Deferred.await(recovery),
      });
      yield* Queue.offer(harness.inputs, { kind: "snapshot", snapshot: snapshot() });
      yield* awaitState(harness.state, (state) => state.status === "live");
      yield* Queue.offer(harness.inputs, { kind: "delta", delta: gapDelta() });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.snapshotRequestCount)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: snapshot(10, "Newer stream snapshot"),
      });
      yield* awaitState(
        harness.state,
        (state) =>
          state.status === "live" &&
          Option.isSome(state.snapshot) &&
          state.snapshot.value.revision === 10,
      );
      yield* Deferred.fail(recovery, new Error("late same-session failure"));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      const current = yield* SubscriptionRef.get(harness.state);
      expect(current.status).toBe("live");
      expect(Option.isNone(current.error)).toBe(true);
      expect(Option.getOrThrow(current.snapshot).revision).toBe(10);
    }),
  );

  it.effect("starts a second recovery after stream progress and ignores the first finalizer", () =>
    Effect.gen(function* () {
      const firstRecovery = yield* Deferred.make<ActivitySnapshot, Error>();
      const secondRecovery = yield* Deferred.make<ActivitySnapshot, Error>();
      const harness = yield* makeHarness({
        getSnapshot: (requestNumber) =>
          requestNumber === 1 ? Deferred.await(firstRecovery) : Deferred.await(secondRecovery),
      });
      yield* Queue.offer(harness.inputs, { kind: "snapshot", snapshot: snapshot() });
      yield* awaitState(harness.state, (state) => state.status === "live");
      yield* Queue.offer(harness.inputs, { kind: "delta", delta: gapDelta() });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.snapshotRequestCount)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: snapshot(10, "Stream progress"),
      });
      yield* awaitState(
        harness.state,
        (state) => Option.isSome(state.snapshot) && state.snapshot.value.revision === 10,
      );
      yield* Queue.offer(harness.inputs, { kind: "delta", delta: gapDelta(12, 13) });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.snapshotRequestCount)) === 2) {
          break;
        }
        yield* Effect.yieldNow;
      }

      yield* Deferred.succeed(firstRecovery, snapshot(50, "Late first recovery"));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      const pendingSecond = yield* SubscriptionRef.get(harness.state);
      expect(yield* Ref.get(harness.snapshotRequestCount)).toBe(2);
      expect(Option.getOrThrow(pendingSecond.snapshot).revision).toBe(10);
      expect(pendingSecond.status).toBe("stale");

      yield* Deferred.succeed(secondRecovery, snapshot(13, "Second recovery"));
      const recovered = yield* awaitState(
        harness.state,
        (state) =>
          state.status === "live" &&
          Option.isSome(state.snapshot) &&
          state.snapshot.value.revision === 13,
      );

      expect(yield* Ref.get(harness.snapshotRequestCount)).toBe(2);
      expect(Option.getOrThrow(recovered.snapshot).actors[0]?.name).toBe("Second recovery");
    }),
  );

  it.effect("sets a user-safe stream error and retries after 250 milliseconds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("sensitive transport detail"));

      const failed = yield* awaitState(harness.state, (state) => Option.isSome(state.error));
      expect(Option.getOrThrow(failed.error)).toBe("Could not synchronize activity.");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("249 millis");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) === 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("does not subscribe when the activity protocol is unsupported", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ protocolVersion: null });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      const current = yield* SubscriptionRef.get(harness.state);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);
      expect(current.status).toBe("empty");
      expect(Option.isNone(current.error)).toBe(true);
    }),
  );

  it.effect("keeps a downgrade empty when connected follows the replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, { kind: "snapshot", snapshot: snapshot() });
      yield* awaitState(harness.state, (state) => state.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        generation: 2,
      } satisfies SupervisorConnectionState);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(
        harness.supervisorSession,
        Option.some(testSession(harness.client, null)),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = yield* SubscriptionRef.get(harness.state);
        if (
          (yield* Ref.get(harness.streamFinalizerCount)) === 1 &&
          current.status === "empty" &&
          Option.isNone(current.snapshot) &&
          current.recentEntries.size === 0
        ) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect((yield* SubscriptionRef.get(harness.state)).status).toBe("empty");

      yield* SubscriptionRef.set(harness.supervisorState, {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connected",
        generation: 2,
      } satisfies SupervisorConnectionState);
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: snapshot(99, "Late old session"),
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      const current = yield* SubscriptionRef.get(harness.state);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
      expect(yield* Ref.get(harness.streamFinalizerCount)).toBe(1);
      expect(current.status).toBe("empty");
      expect(Option.isNone(current.snapshot)).toBe(true);
      expect(current.recentEntries.size).toBe(0);
      expect(Option.isNone(current.error)).toBe(true);
    }),
  );

  it.effect("stops a supported session retry when replaced by an unsupported session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(harness.inputs, new Error("retry pending"));
      yield* awaitState(harness.state, (state) => Option.isSome(state.error));

      const unsupportedSubscriptions = yield* Ref.make(0);
      const unsupportedClient = {
        [WS_METHODS.subscribeActivity]: () =>
          Stream.unwrap(
            Ref.updateAndGet(unsupportedSubscriptions, (count) => count + 1).pipe(
              Effect.as(Stream.never),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        harness.supervisorSession,
        Option.some(testSession(unsupportedClient, null)),
      );
      yield* TestClock.adjust("1 second");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
      expect(yield* Ref.get(unsupportedSubscriptions)).toBe(0);

      const replacementSubscriptions = yield* Ref.make(0);
      const replacementClient = {
        [WS_METHODS.subscribeActivity]: () =>
          Stream.unwrap(
            Ref.updateAndGet(replacementSubscriptions, (count) => count + 1).pipe(
              Effect.as(Stream.never),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        harness.supervisorSession,
        Option.some(testSession(replacementClient, 1)),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(replacementSubscriptions)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(replacementSubscriptions)).toBe(1);
    }),
  );

  it.effect("distinguishes a transient capability failure and recovers on replacement", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialConfig: Effect.fail(
          new ConnectionTransientError({
            reason: "transport",
            detail: "config unavailable",
          }),
        ),
      });

      const failed = yield* awaitState(harness.state, (state) => Option.isSome(state.error));
      expect(Option.getOrThrow(failed.error)).toBe("Could not determine activity support.");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);

      yield* harness.reconnect;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) === 1) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
    }),
  );

  it.effect("cancels pending retries when its scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness().pipe(Scope.provide(scope));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));
      yield* awaitState(harness.state, (state) => Option.isSome(state.error));

      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("1 second");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
    }),
  );
});

describe("createEnvironmentActivityAtoms", () => {
  it.effect(
    "finalizes and starts a fresh subscription when the same target is disabled and re-enabled",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarnessCore();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);
        expect(yield* Ref.get(harness.streamFinalizerCount)).toBe(0);
        const environmentRegistry = EnvironmentRegistry.of({
          followStream: (_environmentId: EnvironmentId, stream: Stream.Stream<unknown, unknown>) =>
            Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              harness.supervisor,
            ),
        } as never);
        const activity = createEnvironmentActivityAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)),
        );
        const atomRegistry = AtomRegistry.make();
        const target = { environmentId: ENVIRONMENT_ID, input: SCOPE };
        const stateValueAtom = activity.stateValueAtom(target);
        expect(
          activity.stateValueAtom({
            environmentId: ENVIRONMENT_ID,
            input: { _tag: "thread", threadId: SCOPE.threadId },
          }),
        ).toBe(stateValueAtom);

        const unsubscribeFirst = atomRegistry.subscribe(stateValueAtom, () => undefined, {
          immediate: true,
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.subscriptionCount)) === 1) {
            break;
          }
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshot: snapshot(1, "First subscription"),
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (atomRegistry.get(stateValueAtom).status === "live") {
            break;
          }
          yield* Effect.yieldNow;
        }
        expect(Option.getOrThrow(atomRegistry.get(stateValueAtom).snapshot).actors[0]?.name).toBe(
          "First subscription",
        );

        unsubscribeFirst();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.streamFinalizerCount)) === 1) {
            break;
          }
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.streamFinalizerCount)).toBe(1);

        const unsubscribeSecond = atomRegistry.subscribe(stateValueAtom, () => undefined, {
          immediate: true,
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.subscriptionCount)) === 2) {
            break;
          }
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshot: snapshot(2, "Fresh subscription"),
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (
            Option.isSome(atomRegistry.get(stateValueAtom).snapshot) &&
            Option.getOrThrow(atomRegistry.get(stateValueAtom).snapshot).actors[0]?.name ===
              "Fresh subscription"
          ) {
            break;
          }
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.streamFinalizerCount)).toBe(1);
        expect(Option.getOrThrow(atomRegistry.get(stateValueAtom).snapshot).actors[0]?.name).toBe(
          "Fresh subscription",
        );

        unsubscribeSecond();
        atomRegistry.dispose();
      }),
  );

  it.effect(
    "finalizes an old scoped atom and ignores its late delta after a scope-key switch",
    () =>
      Effect.gen(function* () {
        const lateOldDelta = yield* Deferred.make<ActivityStreamItem>();
        const harness = yield* makeHarness({
          streamForSubscription: (subscriptionNumber) =>
            Stream.fromIterable(
              subscriptionNumber === 1
                ? [{ kind: "snapshot" as const, snapshot: snapshot(3, "Old scope") }]
                : [
                    {
                      kind: "snapshot" as const,
                      snapshot: snapshot(1, "Replacement scope", {
                        scope: REPLACEMENT_SCOPE,
                        scopeId: REPLACEMENT_SCOPE_ID,
                      }),
                    },
                  ],
            ).pipe(
              Stream.concat(
                subscriptionNumber === 1
                  ? Stream.never
                  : Stream.fromEffect(Deferred.await(lateOldDelta)),
              ),
              Stream.concat(Stream.never),
            ),
        });
        const environmentRegistry = EnvironmentRegistry.of({
          followStream: (_environmentId: EnvironmentId, stream: Stream.Stream<unknown, unknown>) =>
            Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              harness.supervisor,
            ),
        } as never);
        const activity = createEnvironmentActivityAtoms(
          Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)),
        );
        const atomRegistry = AtomRegistry.make();
        const oldAtom = activity.stateValueAtom({ environmentId: ENVIRONMENT_ID, input: SCOPE });
        const replacementAtom = activity.stateValueAtom({
          environmentId: ENVIRONMENT_ID,
          input: REPLACEMENT_SCOPE,
        });

        const unmountOld = atomRegistry.mount(oldAtom);
        const unsubscribeOld = atomRegistry.subscribe(oldAtom, () => undefined, {
          immediate: true,
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.subscriptionCount)) === 1) {
            break;
          }
          yield* Effect.yieldNow;
        }
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (atomRegistry.get(oldAtom).status === "live") {
            break;
          }
          yield* Effect.yieldNow;
        }

        unsubscribeOld();
        unmountOld();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.streamFinalizerCount)) === 1) {
            break;
          }
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.streamFinalizerCount)).toBe(1);

        const unmountReplacement = atomRegistry.mount(replacementAtom);
        const unsubscribeReplacement = atomRegistry.subscribe(replacementAtom, () => undefined, {
          immediate: true,
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.subscriptionCount)) === 2) {
            break;
          }
          yield* Effect.yieldNow;
        }
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const replacementState = atomRegistry.get(replacementAtom);
          if (
            Option.isSome(replacementState.snapshot) &&
            replacementState.snapshot.value.scopeId === REPLACEMENT_SCOPE_ID
          ) {
            break;
          }
          yield* Effect.yieldNow;
        }

        expect(yield* Ref.get(harness.snapshotRequestCount)).toBe(0);
        expect(yield* Ref.get(harness.streamFinalizerCount)).toBe(1);
        const beforeLateDelta = atomRegistry.get(replacementAtom);
        expect(beforeLateDelta.status).toBe("live");
        expect(Option.getOrThrow(beforeLateDelta.snapshot).scopeId).toBe(REPLACEMENT_SCOPE_ID);

        yield* Deferred.succeed(lateOldDelta, { kind: "delta", delta: gapDelta(3, 4) });
        for (let attempt = 0; attempt < 20; attempt += 1) {
          yield* Effect.yieldNow;
        }

        const replacementState = atomRegistry.get(replacementAtom);
        expect(yield* Ref.get(harness.snapshotRequestScopes)).not.toContainEqual(REPLACEMENT_SCOPE);
        expect(replacementState.status).toBe("live");
        expect(Option.getOrThrow(replacementState.snapshot)).toMatchObject({
          scopeId: REPLACEMENT_SCOPE_ID,
          revision: 1,
        });
        expect(Option.getOrThrow(replacementState.snapshot).actors[0]?.name).toBe(
          "Replacement scope",
        );

        unsubscribeReplacement();
        unmountReplacement();
        atomRegistry.dispose();
      }),
  );

  it("uses exact scope and record query inputs as cache keys", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const activity = createEnvironmentActivityAtoms(runtime);
    const stateTarget = { environmentId: ENVIRONMENT_ID, input: SCOPE };
    const rosterTarget = {
      environmentId: ENVIRONMENT_ID,
      input: {
        scope: SCOPE,
        scopeId: SCOPE_ID,
        section: "subagents" as const,
        bucket: "active" as const,
      },
    };
    const detailTarget = {
      environmentId: ENVIRONMENT_ID,
      input: {
        scope: SCOPE,
        scopeId: SCOPE_ID,
        recordKind: "actor" as const,
        recordId: ACTOR_ID,
      },
    };

    const stateAtom = activity.stateAtom(stateTarget);
    expect(stateAtom.idleTTL).toBe(ACTIVITY_STATE_IDLE_TTL_MS);
    expect(activity.stateAtom({ ...stateTarget })).toBe(stateAtom);
    expect(
      activity.stateAtom({
        ...stateTarget,
        input: { _tag: "thread", threadId: ThreadId.make("thread-2") },
      }),
    ).not.toBe(stateAtom);

    const roster = activity.roster(rosterTarget);
    expect(roster.idleTTL).toBe(0);
    expect(activity.roster({ ...rosterTarget, input: { ...rosterTarget.input } })).toBe(roster);
    expect(
      activity.roster({
        ...rosterTarget,
        input: { ...rosterTarget.input, bucket: "done" },
      }),
    ).not.toBe(roster);

    const detail = activity.detail(detailTarget);
    expect(detail.idleTTL).toBe(0);
    expect(activity.detail({ ...detailTarget, input: { ...detailTarget.input } })).toBe(detail);
    expect(
      activity.detail({
        ...detailTarget,
        input: {
          ...detailTarget.input,
          recordId: ActivityRecordId.make("actor:child-2"),
        },
      }),
    ).not.toBe(detail);
  });
});
