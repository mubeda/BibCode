import { EnvironmentId, type ServerConfig } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
});

const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
};

const RELAY_ENTRY: ConnectionCatalogEntry = {
  target: RELAY_TARGET,
  profile: Option.none(),
};

const PREPARED_CONNECTION: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  descriptor: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    storageInstanceId: "store-test",
    remoteUpdateSupport: null,
    remoteProtocolVersion: 1,
    minCompatibleRemoteProtocol: 1,
    capabilities: {
      repositoryIdentity: true,
      worktreeCatalog: false,
      worktreeCatalogRefreshReason: false,
      vcsStatusSummary: false,
      activityProtocolVersion: null,
      remoteUpdateControl: false,
    },
  },
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  e2ee: null,
  target: TARGET,
};

const TEST_RPC_CLIENT = {} as WsRpcProtocolClient;

function transient(message = "Connection failed.") {
  return new ConnectionTransientError({
    reason: "transport",
    detail: message,
  });
}

function blocked(message = "Authentication required.") {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail: message,
  });
}

function awaitState(
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

const eventuallyState = Effect.fn("TestConnectionHarness.eventuallyState")(function* (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  let lastState = yield* SubscriptionRef.get(state);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    lastState = yield* SubscriptionRef.get(state);
    if (predicate(lastState)) {
      return lastState;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(
    new Error(
      `Expected supervisor state was not observed. Last state: phase=${lastState.phase}, stage=${lastState.stage ?? "none"}, attempt=${lastState.attempt}, generation=${lastState.generation}`,
    ),
  );
});

const makeHarness = Effect.fn("TestConnectionHarness.make")(function* (options?: {
  readonly networkStatus?: NetworkStatus;
  readonly prepare?: (
    attempt: number,
    target: ConnectionTarget,
  ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  readonly ready?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(
    options?.networkStatus ?? "online",
  );
  const prepareCount = yield* Ref.make(0);
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: "application-active" | "credentials-changed";
  }>({
    sequence: 0,
    reason: "application-active",
  });
  const closedSessions = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
  >([]);

  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });

  const prepare = Effect.fn("TestConnectionDriver.prepare")(function* (target: ConnectionTarget) {
    const attempt = yield* Ref.updateAndGet(prepareCount, (count) => count + 1);
    if (options?.prepare) {
      return yield* options.prepare(attempt, target);
    }
    return PREPARED_CONNECTION;
  });

  const connect = Effect.fn("TestConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const target = entry.target;
    yield* reportProgress({ stage: "preparing" });
    const prepared = yield* prepare(target);
    yield* reportProgress({ stage: "opening", prepared });

    const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
    const closed = yield* Deferred.make<never, ConnectionTransientError>();
    yield* Ref.update(closedSessions, (sessions) => [...sessions, closed]);

    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: TEST_RPC_CLIENT,
        initialConfig: Effect.die(new Error("Initial config is not used by supervisor tests.")),
        ready: options?.ready?.(attempt) ?? Effect.void,
        probe: options?.probe?.(attempt) ?? Effect.void,
        closed: Deferred.await(closed),
        e2eeAuthenticated: Effect.succeed(null),
      } satisfies RpcSession.RpcSession),
      () => Ref.update(releaseCount, (count) => count + 1),
    );

    yield* reportProgress({ stage: "synchronizing", prepared });
    yield* session.ready;
    return { prepared, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  const dependencies = Layer.mergeAll(
    Layer.succeed(Connectivity.Connectivity, connectivity),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        changes: SubscriptionRef.changes(wakeups).pipe(
          Stream.drop(1),
          Stream.map((event) => event.reason),
        ),
      }),
    ),
    Layer.succeed(
      ConnectionDriver.ConnectionDriver,
      ConnectionDriver.ConnectionDriver.of({ connect }),
    ),
  );

  return {
    dependencies,
    prepareCount,
    sessionCount,
    releaseCount,
    setNetworkStatus: (status: NetworkStatus) => SubscriptionRef.set(networkStatus, status),
    wake: (reason: "application-active" | "credentials-changed") =>
      SubscriptionRef.update(wakeups, (event) => ({
        sequence: event.sequence + 1,
        reason,
      })),
    closeLatestSession: Effect.fn("TestConnectionHarness.closeLatestSession")(function* (
      error = transient("Session closed."),
    ) {
      const sessions = yield* Ref.get(closedSessions);
      const latest = sessions.at(-1);
      if (latest) {
        yield* Deferred.fail(latest, error);
      }
    }),
  };
});

const makeStorageIdentityHarness = Effect.fn("TestStorageIdentityHarness.make")(function* (
  acceptedStorageInstanceId: string | null,
  reportedStorageInstanceId: string | null,
  options?: {
    readonly beforeInitialConfig?: Effect.Effect<void>;
    readonly failAcceptance?: boolean;
    readonly sessionReportedStorageInstanceId?: string | null;
  },
) {
  const acceptedIdentities = yield* Ref.make<Map<string, string>>(
    new Map(
      acceptedStorageInstanceId === null
        ? []
        : [["platform:primary", acceptedStorageInstanceId] as const],
    ),
  );
  const sessionConnectCount = yield* Ref.make(0);
  const sessionReleaseCount = yield* Ref.make(0);
  const identityAcceptCount = yield* Ref.make(0);
  const acceptedAtSessionConnect = yield* Ref.make<string | null>(null);
  const prepared: PreparedConnection = {
    ...PREPARED_CONNECTION,
    descriptor: {
      ...PREPARED_CONNECTION.descriptor,
      storageInstanceId: reportedStorageInstanceId,
    },
  };
  const resolver = ConnectionResolver.ConnectionResolver.of({
    prepare: () => Effect.succeed(prepared),
  });
  const sessions = RpcSession.RpcSessionFactory.of({
    connect: () =>
      Ref.get(acceptedIdentities).pipe(
        Effect.tap((current) =>
          Ref.set(acceptedAtSessionConnect, current.get("platform:primary") ?? null),
        ),
        Effect.andThen(Ref.update(sessionConnectCount, (count) => count + 1)),
        Effect.andThen(
          Effect.acquireRelease(
            Effect.succeed({
              client: TEST_RPC_CLIENT,
              initialConfig: (options?.beforeInitialConfig ?? Effect.void).pipe(
                Effect.as({
                  environment: {
                    ...prepared.descriptor,
                    storageInstanceId:
                      options?.sessionReportedStorageInstanceId === undefined
                        ? reportedStorageInstanceId
                        : options.sessionReportedStorageInstanceId,
                  },
                } as ServerConfig),
              ),
              ready: Effect.void,
              probe: Effect.void,
              closed: Effect.never,
              e2eeAuthenticated: Effect.succeed(null),
            } satisfies RpcSession.RpcSession),
            () => Ref.update(sessionReleaseCount, (count) => count + 1),
          ),
        ),
      ),
  });
  const identityService = {
    get: (targetKey: string) =>
      Ref.get(acceptedIdentities).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(targetKey))),
      ),
    accept: ({ targetKey, storageInstanceId }: Persistence.AcceptedStorageIdentity) =>
      options?.failAcceptance === true
        ? Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "accept-storage-identity",
              message: "Storage is unavailable.",
            }),
          )
        : Ref.update(acceptedIdentities, (current) => {
            const next = new Map(current);
            next.set(targetKey, storageInstanceId);
            return next;
          }).pipe(Effect.andThen(Ref.update(identityAcceptCount, (count) => count + 1))),
    rollbackAcceptance: (
      { targetKey, storageInstanceId }: Persistence.AcceptedStorageIdentity,
      previousStorageInstanceId: string | null,
    ) =>
      options?.failAcceptance === true
        ? Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "accept-storage-identity",
              message: "Storage is unavailable.",
            }),
          )
        : Ref.modify(acceptedIdentities, (current) => {
            if (current.get(targetKey) !== storageInstanceId) {
              return [false, current] as const;
            }
            const next = new Map(current);
            if (previousStorageInstanceId === null) next.delete(targetKey);
            else next.set(targetKey, previousStorageInstanceId);
            return [true, next] as const;
          }),
    transition: <A>(
      targetKey: string,
      decide: (
        acceptedStorageInstanceId: string | null,
      ) => Persistence.AcceptedStorageIdentityTransition<A>,
    ) =>
      Ref.get(acceptedIdentities).pipe(
        Effect.flatMap((current) => {
          const transition = decide(current.get(targetKey) ?? null);
          if (transition.mutation._tag === "Keep") {
            return Effect.succeed(transition.result);
          }
          if (options?.failAcceptance === true) {
            return Effect.fail(
              new Persistence.ConnectionPersistenceError({
                operation: "accept-storage-identity",
                message: "Storage is unavailable.",
              }),
            );
          }
          const next = new Map(current);
          next.set(targetKey, transition.mutation.storageInstanceId);
          return Ref.set(acceptedIdentities, next).pipe(
            Effect.andThen(Ref.update(identityAcceptCount, (count) => count + 1)),
            Effect.as(transition.result),
          );
        }),
      ),
  };
  const identities = Persistence.AcceptedStorageIdentityStore.of(identityService);
  const driver = yield* ConnectionDriver.make.pipe(
    Effect.provideService(ConnectionResolver.ConnectionResolver, resolver),
    Effect.provideService(RpcSession.RpcSessionFactory, sessions),
    Effect.provideService(Persistence.AcceptedStorageIdentityStore, identities),
  );
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({
        status: SubscriptionRef.get(networkStatus),
        changes: SubscriptionRef.changes(networkStatus),
      }),
    ),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
    ),
    Layer.succeed(ConnectionDriver.ConnectionDriver, driver),
  );

  return {
    acceptedAtSessionConnect,
    acceptedIdentities,
    dependencies,
    identityAcceptCount,
    sessionConnectCount,
    sessionReleaseCount,
  };
});

describe("EnvironmentSupervisor", () => {
  it.effect("blocks a changed store before opening or synchronizing the RPC session", () =>
    Effect.gen(function* () {
      const harness = yield* makeStorageIdentityHarness("store-a", "store-b");
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const state = yield* eventuallyState(
        supervisor.state,
        (current) => current.phase === "blocked" || current.phase === "connected",
      );

      expect(state).toMatchObject({
        phase: "blocked",
        lastFailure: {
          _tag: "ConnectionStorageChangedError",
          reason: "storage-changed",
          targetKey: "platform:primary",
          acceptedStorageInstanceId: "store-a",
          reportedStorageInstanceId: "store-b",
        },
      });
      expect(yield* Ref.get(harness.sessionConnectCount)).toBe(0);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }),
  );

  it.effect("persists the first reported store before opening the RPC session", () =>
    Effect.gen(function* () {
      const harness = yield* makeStorageIdentityHarness(null, "store-a");
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* eventuallyState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.acceptedAtSessionConnect)).toBe("store-a");
      expect(yield* Ref.get(harness.acceptedIdentities)).toEqual(
        new Map([["platform:primary", "store-a"]]),
      );
      expect(yield* Ref.get(harness.sessionConnectCount)).toBe(1);
      expect(yield* Ref.get(harness.identityAcceptCount)).toBe(1);
    }),
  );

  it.effect("opens one RPC session when the reported store matches the accepted store", () =>
    Effect.gen(function* () {
      const harness = yield* makeStorageIdentityHarness("store-a", "store-a");
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* eventuallyState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.sessionConnectCount)).toBe(1);
      expect(yield* Ref.get(harness.identityAcceptCount)).toBe(0);
    }),
  );

  it.effect("blocks a session config store change without publishing or retrying the lease", () =>
    Effect.gen(function* () {
      const initialConfigStarted = yield* Deferred.make<void>();
      const releaseInitialConfig = yield* Deferred.make<void>();
      const harness = yield* makeStorageIdentityHarness("store-a", "store-a", {
        beforeInitialConfig: Deferred.succeed(initialConfigStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInitialConfig)),
        ),
        sessionReportedStorageInstanceId: "store-b",
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(initialConfigStarted);
      expect((yield* SubscriptionRef.get(supervisor.state)).stage).toBe("opening");
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
      yield* Deferred.succeed(releaseInitialConfig, undefined);

      const state = yield* eventuallyState(
        supervisor.state,
        (current) => current.phase === "blocked",
      );
      for (let iteration = 0; iteration < 100; iteration += 1) {
        yield* Effect.yieldNow;
      }

      expect(state).toMatchObject({
        phase: "blocked",
        lastFailure: {
          _tag: "ConnectionStorageChangedError",
          acceptedStorageInstanceId: "store-a",
          reportedStorageInstanceId: "store-b",
        },
      });
      expect(yield* Ref.get(harness.sessionConnectCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionReleaseCount)).toBe(1);
      expect(yield* Ref.get(harness.identityAcceptCount)).toBe(0);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("blocked");
    }),
  );

  it.effect("blocks before opening when the first store identity cannot be persisted", () =>
    Effect.gen(function* () {
      const harness = yield* makeStorageIdentityHarness(null, "store-a", {
        failAcceptance: true,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const state = yield* eventuallyState(
        supervisor.state,
        (current) => current.phase === "blocked" || current.phase === "connected",
      );

      expect(state).toMatchObject({
        phase: "blocked",
        lastFailure: {
          _tag: "ConnectionBlockedError",
          reason: "configuration",
        },
      });
      expect(yield* Ref.get(harness.sessionConnectCount)).toBe(0);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }),
  );

  it.effect("keeps an accepted store when an older server reports no storage identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeStorageIdentityHarness("store-a", null);
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* eventuallyState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.acceptedIdentities)).toEqual(
        new Map([["platform:primary", "store-a"]]),
      );
      expect(yield* Ref.get(harness.identityAcceptCount)).toBe(0);
      expect(yield* Ref.get(harness.sessionConnectCount)).toBe(1);
    }),
  );

  it.effect("does not attempt a connection until it is desired", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);
    }),
  );

  it.effect("does not let the initial connect signal cancel the first attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect("waits while offline and connects immediately when the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkStatus: "offline" });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);

      yield* harness.setNetworkStatus("online");
      const ready = yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(ready).toMatchObject({
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
        lastFailure: null,
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("retries forever with exponential backoff capped at sixteen seconds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.fail(transient()),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 16_000].entries()) {
        yield* TestClock.adjust(delay);
        yield* eventuallyState(
          supervisor.state,
          (state) => state.phase === "backoff" && state.attempt === index + 2,
        );
      }

      expect(yield* Ref.get(harness.prepareCount)).toBe(7);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the latest failure visible throughout the next connection attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient("Relay connection timed out.")) : Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("1 second");

      const retrying = yield* awaitState(
        supervisor.state,
        (state) =>
          state.phase === "connecting" && state.stage === "preparing" && state.attempt === 2,
      );
      expect(retrying).toMatchObject({
        phase: "connecting",
        stage: "preparing",
        attempt: 2,
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Relay connection timed out.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retries when a session never becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ready: () => Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "synchronizing",
      );
      yield* TestClock.adjust("14 seconds");
      expect((yield* SubscriptionRef.get(supervisor.state)).stage).toBe("synchronizing");

      yield* TestClock.adjust("1 second");
      const retrying = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");

      expect(retrying).toMatchObject({
        phase: "backoff",
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("interrupts and releases a connection attempt when setup times out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      yield* TestClock.adjust("15 seconds");
      const retrying = yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(retrying).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("converts unexpected driver defects into retryable failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.die(new Error("Native transport defect."))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(failed).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Test environment connection failed unexpectedly.",
        },
      });

      yield* TestClock.adjust("1 second");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("explicit retry interrupts the current backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("keeps blocked failures idle until an external signal requests another attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* TestClock.adjust("1 hour");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("releases a live session while offline and starts a new generation when online", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.setNetworkStatus("offline");
      yield* awaitState(supervisor.state, (state) => state.phase === "offline");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);

      yield* harness.setNetworkStatus("online");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }),
  );

  it.effect("retries a blocked connection when platform credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* harness.wake("credentials-changed");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("does not let platform wakeups reset an in-flight attempt", () =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: () =>
          Deferred.succeed(firstAttemptStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      yield* Effect.all(
        [
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* TestClock.adjust("15 seconds");
      const retrying = yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(retrying).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("treats an involuntary session close as transient and reconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);

      yield* TestClock.adjust("1 second");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(Option.isSome(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps escalating backoff when a newly opened session flaps", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      yield* TestClock.adjust("1 second");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      yield* harness.closeLatestSession();
      const secondFailure = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );

      expect(secondFailure.retryAt).not.toBeNull();

      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);

      yield* TestClock.adjust("1 second");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a healthy session when the application becomes active", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const probeCalled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () =>
          Ref.update(probeCount, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(probeCalled, undefined)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeCalled);

      expect(yield* Ref.get(probeCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("reconnects when the foreground liveness probe fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) =>
          attempt === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust("1 second");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("times out a stalled foreground liveness probe and reconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("15 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.lastFailure?.reason === "timeout",
      );
      yield* TestClock.adjust("1 second");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("honors an explicit disconnect while a foreground probe is stalled", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeStarted);
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("does not churn a healthy session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("releases and reconnects a relay session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("interrupts relay setup when credentials change", () =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Deferred.succeed(firstAttemptStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      yield* harness.wake("credentials-changed");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
    }),
  );

  it.effect("explicit disconnect releases the session and returns to available", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }),
  );

  it.effect("does not lose an explicit disconnect among concurrent wakeup signals", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* Effect.all(
        [
          supervisor.disconnect,
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
    }),
  );
});
