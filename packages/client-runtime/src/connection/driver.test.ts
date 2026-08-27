import { EnvironmentId, type ServerConfig } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as Persistence from "../platform/persistence.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as RpcSessionFactory from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionStorageChangedError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

type IdentityMutation =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Set"; readonly storageInstanceId: string };

interface IdentityTransition<A> {
  readonly result: A;
  readonly mutation: IdentityMutation;
}

function target(suffix: string) {
  return new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make(`environment-${suffix}`),
    label: `Environment ${suffix}`,
    httpBaseUrl: `https://${suffix}.example.test`,
    wsBaseUrl: `wss://${suffix}.example.test`,
  });
}

function prepared(
  connectionTarget: PrimaryConnectionTarget,
  storageInstanceId: string | null,
): PreparedConnection {
  return {
    environmentId: connectionTarget.environmentId,
    label: connectionTarget.label,
    descriptor: {
      environmentId: connectionTarget.environmentId,
      label: connectionTarget.label,
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      storageInstanceId,
      remoteProtocolVersion: 1,
      minCompatibleRemoteProtocol: 1,
      capabilities: {
        repositoryIdentity: true,
        worktreeCatalog: false,
        worktreeCatalogRefreshReason: false,
        vcsStatusSummary: false,
        activityProtocolVersion: null,
      },
    },
    httpBaseUrl: connectionTarget.httpBaseUrl,
    socketUrl: `${connectionTarget.wsBaseUrl}/ws`,
    httpAuthorization: null,
    target: connectionTarget,
  };
}

function entry(connectionTarget: PrimaryConnectionTarget): ConnectionCatalogEntry {
  return { target: connectionTarget, profile: Option.none() };
}

function serverConfig(
  connection: PreparedConnection,
  storageInstanceId: string | null,
): ServerConfig {
  return {
    environment: { ...connection.descriptor, storageInstanceId },
  } as ServerConfig;
}

const makeBarrier = Effect.fn("TestConnectionDriver.makeBarrier")(function* (participants: number) {
  const arrivals = yield* Ref.make(0);
  const release = yield* Deferred.make<void>();
  return () =>
    Ref.updateAndGet(arrivals, (count) => count + 1).pipe(
      Effect.tap((count) =>
        count === participants ? Deferred.succeed(release, undefined) : Effect.void,
      ),
      Effect.andThen(Deferred.await(release)),
    );
});

const makeIdentityStore = Effect.fn("TestConnectionDriver.makeIdentityStore")(function* (
  initial: ReadonlyMap<string, string>,
  beforeReadOrTransition: Effect.Effect<void> = Effect.void,
  options?: { readonly failMutation?: boolean },
) {
  const accepted = yield* Ref.make(new Map(initial));
  const writes = yield* Ref.make<ReadonlyArray<Persistence.AcceptedStorageIdentity>>([]);
  const service = {
    get: (targetKey: string) =>
      Ref.get(accepted).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(targetKey))),
        Effect.flatMap((snapshot) => beforeReadOrTransition.pipe(Effect.as(snapshot))),
      ),
    accept: (identity: Persistence.AcceptedStorageIdentity) =>
      options?.failMutation === true
        ? Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "accept-storage-identity",
              message: "Catalog writer is unavailable.",
            }),
          )
        : Ref.update(accepted, (current) => {
            const next = new Map(current);
            next.set(identity.targetKey, identity.storageInstanceId);
            return next;
          }).pipe(Effect.andThen(Ref.update(writes, (current) => [...current, identity]))),
    transition: <A>(
      targetKey: string,
      decide: (acceptedStorageInstanceId: string | null) => IdentityTransition<A>,
    ) =>
      beforeReadOrTransition.pipe(
        Effect.andThen(
          options?.failMutation === true
            ? Ref.get(accepted).pipe(
                Effect.flatMap((current) => {
                  const transition = decide(current.get(targetKey) ?? null);
                  return transition.mutation._tag === "Keep"
                    ? Effect.succeed(transition.result)
                    : Effect.fail(
                        new Persistence.ConnectionPersistenceError({
                          operation: "accept-storage-identity",
                          message: "Catalog writer is unavailable.",
                        }),
                      );
                }),
              )
            : Ref.modify(accepted, (current) => {
                const transition = decide(current.get(targetKey) ?? null);
                if (transition.mutation._tag === "Keep") {
                  return [transition.result, current] as const;
                }
                const next = new Map(current);
                next.set(targetKey, transition.mutation.storageInstanceId);
                return [transition.result, next] as const;
              }),
        ),
      ),
  };
  return {
    accepted,
    identities: Persistence.AcceptedStorageIdentityStore.of(service),
    writes,
  };
});

const makeDriver = Effect.fn("TestConnectionDriver.make")(function* (
  reportedByEnvironment: ReadonlyMap<string, string | null>,
  sessionReportedByEnvironment: ReadonlyMap<string, string | null>,
  identities: Persistence.AcceptedStorageIdentityStore["Service"],
) {
  const sessionCount = yield* Ref.make(0);
  const sessionReleaseCount = yield* Ref.make(0);
  const resolver = ConnectionResolver.ConnectionResolver.of({
    prepare: (catalogEntry) =>
      Effect.succeed(
        prepared(
          catalogEntry.target as PrimaryConnectionTarget,
          reportedByEnvironment.get(catalogEntry.target.environmentId) ?? null,
        ),
      ),
  });
  const sessions = RpcSessionFactory.RpcSessionFactory.of({
    connect: (connection) =>
      Effect.acquireRelease(
        Ref.update(sessionCount, (count) => count + 1).pipe(
          Effect.as({
            client: {} as RpcSession["client"],
            initialConfig: Effect.succeed(
              serverConfig(
                connection,
                sessionReportedByEnvironment.get(connection.environmentId) ?? null,
              ),
            ),
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          } satisfies RpcSession),
        ),
        () => Ref.update(sessionReleaseCount, (count) => count + 1),
      ),
  });
  const driver = yield* ConnectionDriver.make.pipe(
    Effect.provideService(ConnectionResolver.ConnectionResolver, resolver),
    Effect.provideService(RpcSessionFactory.RpcSessionFactory, sessions),
    Effect.provideService(Persistence.AcceptedStorageIdentityStore, identities),
  );
  return { driver, sessionCount, sessionReleaseCount };
});

describe("ConnectionDriver storage identity", () => {
  it.effect("allows only one concurrent bootstrap winner to open a session", () =>
    Effect.gen(function* () {
      const firstTarget = target("first");
      const secondTarget = target("second");
      const barrier = yield* makeBarrier(2);
      const store = yield* makeIdentityStore(new Map(), barrier());
      const harness = yield* makeDriver(
        new Map([
          [firstTarget.environmentId, "store-a"],
          [secondTarget.environmentId, "store-b"],
        ]),
        new Map([
          [firstTarget.environmentId, "store-a"],
          [secondTarget.environmentId, "store-b"],
        ]),
        store.identities,
      );

      const results = yield* Effect.scoped(
        Effect.all(
          [
            harness.driver.connect(entry(firstTarget), () => Effect.void).pipe(Effect.result),
            harness.driver.connect(entry(secondTarget), () => Effect.void).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        ),
      );

      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      expect(results.filter(Result.isFailure)).toHaveLength(1);
      const failure = results.find(Result.isFailure);
      expect(failure?.failure).toBeInstanceOf(ConnectionStorageChangedError);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect([...(yield* Ref.get(store.accepted)).values()]).toHaveLength(1);
    }),
  );

  it.effect(
    "closes a session whose initial config reports a changed store before synchronization",
    () =>
      Effect.gen(function* () {
        const connectionTarget = target("toctou");
        const store = yield* makeIdentityStore(new Map([["platform:primary", "store-a"]]));
        const harness = yield* makeDriver(
          new Map([[connectionTarget.environmentId, "store-a"]]),
          new Map([[connectionTarget.environmentId, "store-b"]]),
          store.identities,
        );
        const stages = yield* Ref.make<ReadonlyArray<ConnectionDriver.ConnectionDriverProgress>>(
          [],
        );

        const result = yield* Effect.scoped(
          harness.driver
            .connect(entry(connectionTarget), (progress) =>
              Ref.update(stages, (current) => [...current, progress]),
            )
            .pipe(Effect.result),
        );

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            _tag: "ConnectionStorageChangedError",
            acceptedStorageInstanceId: "store-a",
            reportedStorageInstanceId: "store-b",
          });
        }
        expect((yield* Ref.get(stages)).map((progress) => progress.stage)).toEqual([
          "preparing",
          "opening",
        ]);
        expect(yield* Ref.get(harness.sessionCount)).toBe(1);
        expect(yield* Ref.get(harness.sessionReleaseCount)).toBe(1);
        expect(yield* Ref.get(store.accepted)).toEqual(new Map([["platform:primary", "store-a"]]));
        expect(yield* Ref.get(store.writes)).toEqual([]);
      }),
  );

  it.effect("publishes synchronization after a matching session config is ready", () =>
    Effect.gen(function* () {
      const connectionTarget = target("matching");
      const store = yield* makeIdentityStore(new Map([["platform:primary", "store-a"]]));
      const harness = yield* makeDriver(
        new Map([[connectionTarget.environmentId, "store-a"]]),
        new Map([[connectionTarget.environmentId, "store-a"]]),
        store.identities,
      );
      const stages = yield* Ref.make<ReadonlyArray<ConnectionDriver.ConnectionDriverProgress>>([]);

      const result = yield* Effect.scoped(
        harness.driver
          .connect(entry(connectionTarget), (progress) =>
            Ref.update(stages, (current) => [...current, progress]),
          )
          .pipe(Effect.result),
      );

      expect(Result.isSuccess(result)).toBe(true);
      expect((yield* Ref.get(stages)).map((progress) => progress.stage)).toEqual([
        "preparing",
        "opening",
        "synchronizing",
      ]);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionReleaseCount)).toBe(1);
    }),
  );

  it.effect("connects accepted and nullable stores when identity mutation is unavailable", () =>
    Effect.gen(function* () {
      const acceptedTarget = target("accepted-read-only");
      const nullableTarget = target("nullable-read-only");
      const store = yield* makeIdentityStore(
        new Map([["platform:primary", "store-a"]]),
        Effect.void,
        { failMutation: true },
      );

      const accepted = yield* makeDriver(
        new Map([[acceptedTarget.environmentId, "store-a"]]),
        new Map([[acceptedTarget.environmentId, "store-a"]]),
        store.identities,
      );
      const acceptedResult = yield* Effect.scoped(
        accepted.driver.connect(entry(acceptedTarget), () => Effect.void).pipe(Effect.result),
      );
      expect(Result.isSuccess(acceptedResult)).toBe(true);
      expect(yield* Ref.get(accepted.sessionCount)).toBe(1);

      const nullable = yield* makeDriver(
        new Map([[nullableTarget.environmentId, null]]),
        new Map([[nullableTarget.environmentId, null]]),
        store.identities,
      );
      const nullableResult = yield* Effect.scoped(
        nullable.driver.connect(entry(nullableTarget), () => Effect.void).pipe(Effect.result),
      );
      expect(Result.isSuccess(nullableResult)).toBe(true);
      expect(yield* Ref.get(nullable.sessionCount)).toBe(1);
      expect(yield* Ref.get(store.writes)).toEqual([]);
    }),
  );

  it.effect("keeps a changed-store error structured when identity mutation is unavailable", () =>
    Effect.gen(function* () {
      const connectionTarget = target("changed-read-only");
      const store = yield* makeIdentityStore(
        new Map([["platform:primary", "store-a"]]),
        Effect.void,
        { failMutation: true },
      );
      const harness = yield* makeDriver(
        new Map([[connectionTarget.environmentId, "store-b"]]),
        new Map([[connectionTarget.environmentId, "store-b"]]),
        store.identities,
      );

      const result = yield* Effect.scoped(
        harness.driver.connect(entry(connectionTarget), () => Effect.void).pipe(Effect.result),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "ConnectionStorageChangedError",
          acceptedStorageInstanceId: "store-a",
          reportedStorageInstanceId: "store-b",
        });
      }
      expect(yield* Ref.get(harness.sessionCount)).toBe(0);
      expect(yield* Ref.get(store.writes)).toEqual([]);
    }),
  );
});
