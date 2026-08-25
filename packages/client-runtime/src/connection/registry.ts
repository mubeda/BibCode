import { EnvironmentId } from "@bibcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  type KnownEnvironment,
  type PlatformConnectionRegistration,
  type PrimaryConnectionRegistration,
  SshConnectionProfile,
  connectionRegistrationCatalogEntry,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as Connectivity from "./connectivity.ts";
import type {
  ConnectionAttemptError,
  ConnectionTarget,
  EnvironmentRoute,
  NetworkStatus,
  SupervisorConnectionState,
} from "./model.ts";
import {
  BearerConnectionTarget,
  DesktopLoopbackRoute,
  DesktopWslRoute,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  UnavailableConnectionTarget,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { deriveWsBaseUrl } from "../environment/endpoint.ts";
import { eligibleRoutes } from "./routeSelection.ts";

const isSshConnectionProfile = Schema.is(SshConnectionProfile);

export class EnvironmentNotRegisteredError extends Schema.TaggedErrorClass<EnvironmentNotRegisteredError>()(
  "EnvironmentNotRegisteredError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} is not registered.`;
  }
}

export class PlatformEnvironmentRemovalError extends Schema.TaggedErrorClass<PlatformEnvironmentRemovalError>()(
  "PlatformEnvironmentRemovalError",
  {
    environmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Platform-managed environment ${this.environmentId} cannot be removed.`;
  }
}

export interface EnvironmentRegistrationInput {
  readonly environment: KnownEnvironment;
  readonly sessionSecret?: {
    readonly routeId: string;
    readonly value: string;
  };
}

export class EnvironmentRegistry extends Context.Service<
  EnvironmentRegistry,
  {
    readonly environments: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, KnownEnvironment>
    >;
    /** Transitional projection for consumers that have not moved to environment aggregates yet. */
    readonly entries: SubscriptionRef.SubscriptionRef<
      ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
    >;
    readonly networkStatus: SubscriptionRef.SubscriptionRef<NetworkStatus>;
    readonly start: Effect.Effect<void>;
    readonly registerEnvironment: (
      input: EnvironmentRegistrationInput,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly register: (
      registration: ConnectionRegistration,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly registerPlatform: (
      registration: PrimaryConnectionRegistration,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly reconcilePlatform: (
      registrations: ReadonlyArray<PlatformConnectionRegistration>,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly hide: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      Persistence.ConnectionPersistenceError | EnvironmentNotRegisteredError
    >;
    readonly restore: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      Persistence.ConnectionPersistenceError | EnvironmentNotRegisteredError
    >;
    readonly removeRoute: (
      environmentId: EnvironmentId,
      routeId: string,
    ) => Effect.Effect<
      void,
      Persistence.ConnectionPersistenceError | EnvironmentNotRegisteredError
    >;
    readonly forget: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | EnvironmentNotRegisteredError
      | PlatformEnvironmentRemovalError
    >;
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | EnvironmentNotRegisteredError
      | PlatformEnvironmentRemovalError
    >;
    readonly removeRelayEnvironments: () => Effect.Effect<
      void,
      | Persistence.ConnectionPersistenceError
      | ConnectionAttemptError
      | PlatformEnvironmentRemovalError
    >;
    readonly retryNow: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly acceptStorageIdentity: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      Persistence.ConnectionPersistenceError | EnvironmentNotRegisteredError
    >;
    readonly state: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly stateChanges: (
      environmentId: EnvironmentId,
    ) => Stream.Stream<SupervisorConnectionState, EnvironmentNotRegisteredError>;
    readonly run: <A, E, R>(
      environmentId: EnvironmentId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly runStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<
      A,
      E | EnvironmentNotRegisteredError,
      Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>
    >;
    readonly followStream: <A, E, R>(
      environmentId: EnvironmentId,
      stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E, Exclude<R, EnvironmentSupervisor.EnvironmentSupervisor>>;
  }
>()("@bibcode/client-runtime/connection/registry/EnvironmentRegistry") {}

interface EnvironmentServiceScope {
  readonly entry: KnownEnvironment;
  readonly legacyEntry: ConnectionCatalogEntry | null;
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly scope: Scope.Closeable;
}

type EnvironmentAdmissionPhase = "open" | "forgetting" | "forgotten" | "repair";

interface EnvironmentAdmissionState {
  readonly generation: number;
  readonly phase: EnvironmentAdmissionPhase;
}

interface EnvironmentAdmissionTicket {
  readonly generation: number;
  readonly phase: "open" | "forgotten";
}

export interface EnvironmentRegistryOptions {
  /** Bounds concurrent connection establishment without limiting healthy sessions. */
  readonly maxConcurrentEnvironmentAttempts?: number;
}

const DEFAULT_MAX_CONCURRENT_ENVIRONMENT_ATTEMPTS = 4;
const CATALOG_V1_TO_V3_MIGRATION_ID = "catalog-v1-to-v3";

function environmentLabel(environment: KnownEnvironment): string {
  return environment.alias ?? environment.descriptor?.label ?? "Environment";
}

function projectCatalogEntry(environment: KnownEnvironment): ConnectionCatalogEntry {
  const route = eligibleRoutes(environment, { activeRouteId: null })[0];
  const label = environmentLabel(environment);
  if (route === undefined) {
    return {
      target: new UnavailableConnectionTarget({
        environmentId: environment.environmentId,
        label,
        connectionId: `environment:${environment.environmentId}`,
        configuredDistro: null,
        detail: "This environment has no configured connection route.",
      }),
      profile: Option.none(),
    };
  }
  switch (route._tag) {
    case "DesktopLoopbackRoute":
      if (route.secretRef === null) {
        return {
          target: new PrimaryConnectionTarget({
            environmentId: environment.environmentId,
            label,
            httpBaseUrl: route.httpBaseUrl,
            wsBaseUrl: route.wsBaseUrl,
          }),
          profile: Option.none(),
        };
      }
      return bearerProjection(environment, route, route.httpBaseUrl, route.wsBaseUrl);
    case "DesktopWslRoute":
      return bearerProjection(environment, route, route.httpBaseUrl, route.wsBaseUrl);
    case "DirectHttpsRoute":
      return bearerProjection(
        environment,
        route,
        route.httpsBaseUrl,
        deriveWsBaseUrl(route.httpsBaseUrl),
      );
    case "SshTunnelRoute":
      return {
        target: new SshConnectionTarget({
          environmentId: environment.environmentId,
          label,
          connectionId: route.routeId,
        }),
        profile: Option.some(
          new SshConnectionProfile({
            connectionId: route.routeId,
            environmentId: environment.environmentId,
            label,
            target: route.target,
          }),
        ),
      };
  }
}

function bearerProjection(
  environment: KnownEnvironment,
  route: EnvironmentRoute,
  httpBaseUrl: string,
  wsBaseUrl: string,
): ConnectionCatalogEntry {
  const label = environmentLabel(environment);
  return {
    target: new BearerConnectionTarget({
      environmentId: environment.environmentId,
      label,
      connectionId: route.routeId,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: route.routeId,
        environmentId: environment.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl,
      }),
    ),
  };
}

function normalizedPlatformRegistration(
  registration: PlatformConnectionRegistration,
): EnvironmentRegistrationInput | null {
  if (registration._tag === "UnavailableConnectionRegistration") return null;
  const descriptor = registration.descriptor;
  if (descriptor === undefined) return null;
  const route =
    registration._tag === "PrimaryConnectionRegistration"
      ? new DesktopLoopbackRoute({
          routeId: "platform:primary",
          environmentId: descriptor.environmentId,
          label: registration.target.label,
          priority: 0,
          pinned: true,
          autoconnect: true,
          secretRef: null,
          httpBaseUrl: registration.target.httpBaseUrl,
          wsBaseUrl: registration.target.wsBaseUrl,
        })
      : new DesktopWslRoute({
          routeId: registration.target.connectionId,
          environmentId: descriptor.environmentId,
          label: registration.target.label,
          priority: 0,
          pinned: true,
          autoconnect: true,
          secretRef: null,
          bindingId: registration.target.connectionId,
          httpBaseUrl: registration.profile.httpBaseUrl,
          wsBaseUrl: registration.profile.wsBaseUrl,
        });
  return {
    environment: {
      environmentId: descriptor.environmentId,
      acceptedStorageInstanceId: descriptor.storageInstanceId,
      descriptor,
      alias: registration.target.label,
      hidden: false,
      bindings: [],
      routes: [route],
    },
    ...(registration._tag === "BearerConnectionRegistration"
      ? {
          sessionSecret: {
            routeId: registration.target.connectionId,
            value: registration.credential.token,
          },
        }
      : {}),
  };
}

function jitterRetryDelay(environmentId: EnvironmentId, baseDelayMs: number, failureCount: number) {
  let hash = failureCount;
  for (const character of environmentId) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  }
  const factor = 0.8 + (hash % 401) / 1_000;
  return baseDelayMs * factor;
}

export const make = Effect.fn("EnvironmentRegistry.make")(function* (
  options?: EnvironmentRegistryOptions,
) {
  const maxConcurrentEnvironmentAttempts =
    options?.maxConcurrentEnvironmentAttempts ?? DEFAULT_MAX_CONCURRENT_ENVIRONMENT_ATTEMPTS;
  if (
    !Number.isSafeInteger(maxConcurrentEnvironmentAttempts) ||
    maxConcurrentEnvironmentAttempts < 1
  ) {
    return yield* Effect.die(
      new Error("maxConcurrentEnvironmentAttempts must be a positive safe integer."),
    );
  }
  const connectionAttemptSemaphore = yield* Semaphore.make(maxConcurrentEnvironmentAttempts);
  const environmentCatalog = yield* Persistence.EnvironmentCatalogStore;
  const environmentCleanup = yield* Persistence.EnvironmentCleanupStore;
  const environmentSecrets = yield* Persistence.EnvironmentSecretStore;
  const cacheManifests = yield* Persistence.EnvironmentCacheManifestStore;
  const migrationStore = yield* Persistence.EnvironmentMigrationStore;
  const storage = yield* Persistence.ConnectionTargetStore;
  const registrations = yield* Persistence.ConnectionRegistrationStore;
  const identities = yield* Persistence.AcceptedStorageIdentityStore;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const ownedDataCleanup = yield* Persistence.EnvironmentOwnedDataCleanup;
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const cleanupRepairs = yield* environmentCleanup.repairs;
  const environmentGenerations = yield* Ref.make<ReadonlyMap<EnvironmentId, number>>(
    new Map(cleanupRepairs.map((receipt) => [receipt.environmentId, receipt.generation])),
  );
  const admissionStates = yield* Ref.make<ReadonlyMap<EnvironmentId, EnvironmentAdmissionState>>(
    new Map(
      cleanupRepairs.map((receipt) => [
        receipt.environmentId,
        { generation: receipt.generation, phase: "repair" as const },
      ]),
    ),
  );
  const normalizedEnvironments = yield* environmentCatalog.list;
  const migrationReceipt = yield* migrationStore.load(CATALOG_V1_TO_V3_MIGRATION_ID);
  const persistedTargets = Option.isNone(migrationReceipt) ? yield* storage.list : [];
  const initialLegacyEntries = new Map(
    yield* Effect.forEach(
      persistedTargets,
      Effect.fn("EnvironmentRegistry.loadCatalogEntry")(function* (target) {
        const profile =
          target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
            ? yield* profiles.get(target.connectionId)
            : Option.none();
        return [
          target.environmentId,
          { target, profile } satisfies ConnectionCatalogEntry,
        ] as const;
      }),
      { concurrency: "unbounded" },
    ),
  );
  const initialEnvironments = new Map<EnvironmentId, KnownEnvironment>(
    normalizedEnvironments.map((environment) => [environment.environmentId, environment]),
  );
  for (const [environmentId, entry] of initialLegacyEntries) {
    if (!initialEnvironments.has(environmentId)) {
      initialEnvironments.set(environmentId, EnvironmentSupervisor.legacyCatalogEnvironment(entry));
    }
  }
  const environments =
    yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, KnownEnvironment>>(initialEnvironments);
  const legacyEntries =
    yield* Ref.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(initialLegacyEntries);
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(
      [...initialEnvironments].map(([environmentId, environment]) => [
        environmentId,
        initialLegacyEntries.get(environmentId) ?? projectCatalogEntry(environment),
      ]),
    ),
  );
  const networkStatus = yield* SubscriptionRef.make(yield* connectivity.status);
  const serviceScopes = yield* SubscriptionRef.make<
    ReadonlyMap<EnvironmentId, EnvironmentServiceScope>
  >(new Map());
  const platformEnvironmentIds = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());
  const persistedTargetsByEnvironment = yield* Ref.make<
    ReadonlyMap<EnvironmentId, ConnectionTarget>
  >(new Map(persistedTargets.map((target) => [target.environmentId, target])));
  interface LeaseLock {
    readonly semaphore: Semaphore.Semaphore;
    readonly users: number;
  }

  const leaseLocks = yield* Ref.make<ReadonlyMap<EnvironmentId, LeaseLock>>(new Map());
  const leaseLocksGuard = yield* Semaphore.make(1);
  const started = yield* Ref.make(false);

  const issueAdmissionTicket = Effect.fn("EnvironmentRegistry.issueAdmissionTicket")(function* (
    environmentId: EnvironmentId,
  ) {
    const current = (yield* Ref.get(admissionStates)).get(environmentId) ?? {
      generation: 0,
      phase: "open" as const,
    };
    return current.phase === "open" || current.phase === "forgotten"
      ? ({
          generation: current.generation,
          phase: current.phase,
        } satisfies EnvironmentAdmissionTicket)
      : null;
  });

  const admitRegistration = Effect.fn("EnvironmentRegistry.admitRegistration")(function* (
    environmentId: EnvironmentId,
    ticket: EnvironmentAdmissionTicket | null,
  ) {
    if (ticket === null) return false;
    return yield* Ref.modify(admissionStates, (states) => {
      const current = states.get(environmentId) ?? {
        generation: 0,
        phase: "open" as const,
      };
      if (current.generation !== ticket.generation || current.phase !== ticket.phase) {
        return [false, states] as const;
      }
      if (current.phase === "open") return [true, states] as const;
      return [
        true,
        new Map(states).set(environmentId, {
          generation: current.generation,
          phase: "open",
        }),
      ] as const;
    });
  });

  const beginForgetAdmission = Effect.fn("EnvironmentRegistry.beginForgetAdmission")(function* (
    environmentId: EnvironmentId,
  ) {
    const generation = yield* Ref.modify(admissionStates, (states) => {
      const current = states.get(environmentId) ?? {
        generation: 0,
        phase: "open" as const,
      };
      const nextGeneration = current.generation + 1;
      return [
        nextGeneration,
        new Map(states).set(environmentId, {
          generation: nextGeneration,
          phase: "forgetting",
        }),
      ] as const;
    });
    yield* Ref.update(environmentGenerations, (current) =>
      new Map(current).set(environmentId, (current.get(environmentId) ?? 0) + 1),
    );
    return generation;
  });

  const setAdmissionPhase = (
    environmentId: EnvironmentId,
    generation: number,
    phase: EnvironmentAdmissionPhase,
  ) =>
    Ref.update(admissionStates, (states) => {
      const current = states.get(environmentId);
      return current === undefined || current.generation !== generation
        ? states
        : new Map(states).set(environmentId, { generation, phase });
    });

  const ensureAdmissionOpen = Effect.fn("EnvironmentRegistry.ensureAdmissionOpen")(function* (
    environmentId: EnvironmentId,
  ) {
    const phase = (yield* Ref.get(admissionStates)).get(environmentId)?.phase ?? "open";
    if (phase !== "open") {
      return yield* new EnvironmentNotRegisteredError({ environmentId });
    }
  });

  const withLeaseLock = <A, E, R>(
    environmentId: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      leaseLocksGuard.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(leaseLocks);
          const existing = current.get(environmentId);
          if (existing !== undefined) {
            yield* Ref.set(
              leaseLocks,
              new Map(current).set(environmentId, {
                semaphore: existing.semaphore,
                users: existing.users + 1,
              }),
            );
            return existing.semaphore;
          }
          const semaphore = yield* Semaphore.make(1);
          yield* Ref.set(leaseLocks, new Map(current).set(environmentId, { semaphore, users: 1 }));
          return semaphore;
        }),
      ),
      (semaphore) => semaphore.withPermits(1)(effect),
      (semaphore) =>
        leaseLocksGuard.withPermits(1)(
          Ref.update(leaseLocks, (current) => {
            const existing = current.get(environmentId);
            if (existing === undefined || existing.semaphore !== semaphore) {
              return current;
            }
            const next = new Map(current);
            if (existing.users === 1) {
              next.delete(environmentId);
            } else {
              next.set(environmentId, {
                semaphore,
                users: existing.users - 1,
              });
            }
            return next;
          }),
        ),
    ).pipe(Effect.withSpan("EnvironmentRegistry.withLeaseLock"));

  const getEnvironment = Effect.fn("EnvironmentRegistry.getEnvironment")(function* (
    environmentId: EnvironmentId,
  ) {
    const environment = (yield* SubscriptionRef.get(environments)).get(environmentId);
    if (environment === undefined) {
      return yield* new EnvironmentNotRegisteredError({
        environmentId,
      });
    }
    return environment;
  });

  const closeServiceScope = Effect.fn("EnvironmentRegistry.closeServiceScope")(function* (
    environmentId: EnvironmentId,
  ) {
    const current = yield* SubscriptionRef.get(serviceScopes);
    const lease = current.get(environmentId);
    if (lease === undefined) {
      return;
    }
    const next = new Map(current);
    next.delete(environmentId);
    yield* SubscriptionRef.set(serviceScopes, next);
    yield* Scope.close(lease.scope, Exit.void);
  });

  const createServiceScope = Effect.fn("EnvironmentRegistry.createServiceScope")(
    (environment: KnownEnvironment, legacyEntry: ConnectionCatalogEntry | null) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const environmentId = environment.environmentId;
          const environmentGeneration = yield* Ref.modify(environmentGenerations, (current) => {
            const generation = (current.get(environmentId) ?? 0) + 1;
            return [generation, new Map(current).set(environmentId, generation)] as const;
          });
          const scope = yield* Scope.make();
          const supervisor = yield* EnvironmentSupervisor.make(legacyEntry ?? environment, {
            initiallyDesired: false,
            environmentGeneration,
            attemptSemaphore: connectionAttemptSemaphore,
            jitterRetryDelayMs: (baseDelayMs, failureCount) =>
              jitterRetryDelay(environmentId, baseDelayMs, failureCount),
          }).pipe(
            Effect.provideService(Connectivity.Connectivity, connectivity),
            Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
            Effect.provideService(ConnectionWakeups.ConnectionWakeups, wakeups),
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          yield* supervisor.connect;
          yield* SubscriptionRef.update(serviceScopes, (current) => {
            const next = new Map(current);
            next.set(environmentId, { entry: environment, legacyEntry, supervisor, scope });
            return next;
          });
          return supervisor;
        }),
      ),
  );

  const acquireSupervisor = Effect.fn("EnvironmentRegistry.acquireSupervisor")(function* (
    environmentId: EnvironmentId,
  ) {
    return yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        yield* ensureAdmissionOpen(environmentId);
        const environment = yield* getEnvironment(environmentId);
        const legacyEntry = (yield* Ref.get(legacyEntries)).get(environmentId) ?? null;
        const existing = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
        if (existing !== undefined) {
          if (
            Equal.equals(existing.entry, environment) &&
            Equal.equals(existing.legacyEntry, legacyEntry)
          ) {
            return existing.supervisor;
          }
          yield* closeServiceScope(environmentId);
        }
        return yield* createServiceScope(environment, legacyEntry);
      }),
    );
  });

  const run: EnvironmentRegistry["Service"]["run"] = Effect.fn("EnvironmentRegistry.run")(
    function* <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) {
      const supervisor = yield* acquireSupervisor(environmentId);
      return yield* Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );
    },
  );

  const runStream: EnvironmentRegistry["Service"]["runStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.unwrap(
      acquireSupervisor(environmentId).pipe(
        Effect.map((supervisor) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        ),
      ),
    );

  const followStream: EnvironmentRegistry["Service"]["followStream"] = <A, E, R>(
    environmentId: EnvironmentId,
    stream: Stream.Stream<A, E, R>,
  ) =>
    Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(environments)),
      SubscriptionRef.changes(environments),
    ).pipe(
      Stream.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: () =>
            Stream.unwrap(
              acquireSupervisor(environmentId).pipe(
                Effect.match({
                  onFailure: () => Stream.empty,
                  onSuccess: (supervisor) =>
                    Stream.provideService(
                      stream,
                      EnvironmentSupervisor.EnvironmentSupervisor,
                      supervisor,
                    ),
                }),
              ),
            ),
        }),
      ),
    );

  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) {
      return;
    }
    yield* Effect.forEach(
      (yield* SubscriptionRef.get(environments)).keys(),
      (environmentId) =>
        acquireSupervisor(environmentId).pipe(
          Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
        ),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
  }).pipe(Effect.withSpan("EnvironmentRegistry.start"));

  const installEnvironmentLocked = Effect.fn("EnvironmentRegistry.installEnvironmentLocked")(
    function* (
      environment: KnownEnvironment,
      legacyEntry: ConnectionCatalogEntry | null,
      options?: { readonly retainEquivalentRuntime?: boolean },
    ) {
      const environmentId = environment.environmentId;
      const previous = (yield* SubscriptionRef.get(environments)).get(environmentId);
      const previousLegacyEntry = (yield* Ref.get(legacyEntries)).get(environmentId) ?? null;
      const existingScope = (yield* SubscriptionRef.get(serviceScopes)).get(environmentId);
      if (
        options?.retainEquivalentRuntime === true &&
        previous !== undefined &&
        Equal.equals(previous, environment) &&
        Equal.equals(previousLegacyEntry, legacyEntry) &&
        existingScope !== undefined &&
        Equal.equals(existingScope.entry, environment) &&
        Equal.equals(existingScope.legacyEntry, legacyEntry)
      ) {
        return;
      }

      yield* closeServiceScope(environmentId);
      yield* Ref.update(legacyEntries, (current) => {
        const next = new Map(current);
        if (legacyEntry === null) {
          next.delete(environmentId);
        } else {
          next.set(environmentId, legacyEntry);
        }
        return next;
      });
      yield* SubscriptionRef.update(environments, (current) => {
        const next = new Map(current);
        next.set(environmentId, environment);
        return next;
      });
      yield* SubscriptionRef.update(entries, (current) => {
        const next = new Map(current);
        next.set(environmentId, legacyEntry ?? projectCatalogEntry(environment));
        return next;
      });
      yield* createServiceScope(environment, legacyEntry);
    },
  );

  const installLegacyEntryLocked = Effect.fn("EnvironmentRegistry.installLegacyEntryLocked")(
    (entry: ConnectionCatalogEntry, options?: { readonly retainEquivalentRuntime?: boolean }) =>
      installEnvironmentLocked(
        EnvironmentSupervisor.legacyCatalogEnvironment(entry),
        entry,
        options,
      ),
  );

  const registerEnvironmentLocked = Effect.fn("EnvironmentRegistry.registerEnvironmentLocked")(
    function* (input: EnvironmentRegistrationInput) {
      const environmentId = input.environment.environmentId;
      const current = (yield* SubscriptionRef.get(environments)).get(environmentId);
      if (
        current !== undefined &&
        current.acceptedStorageInstanceId !== input.environment.acceptedStorageInstanceId
      ) {
        return yield* new Persistence.ConnectionPersistenceError({
          operation: "put-environment",
          message: "The environment reports a different accepted persistent store.",
        });
      }

      const inputRouteIds = new Set(input.environment.routes.map((route) => route.routeId));
      const mergedRoutes = [
        ...(current?.routes.filter((route) => !inputRouteIds.has(route.routeId)) ?? []),
        ...input.environment.routes,
      ];
      let importedSecretRef: string | null = null;
      const previousSecretRef =
        input.sessionSecret === undefined
          ? null
          : (current?.routes.find((route) => route.routeId === input.sessionSecret?.routeId)
              ?.secretRef ?? null);

      yield* Effect.gen(function* () {
        if (input.sessionSecret !== undefined) {
          if (!inputRouteIds.has(input.sessionSecret.routeId)) {
            return yield* new Persistence.ConnectionPersistenceError({
              operation: "put-environment",
              message: "The session secret does not match a registered environment route.",
            });
          }
          importedSecretRef = yield* environmentSecrets.put(
            environmentId,
            "environment-session",
            input.sessionSecret.value,
          );
        }

        const nextEnvironment: KnownEnvironment = {
          ...input.environment,
          alias: input.environment.alias ?? current?.alias ?? null,
          hidden: current?.hidden ?? input.environment.hidden,
          bindings:
            input.environment.bindings.length === 0 && current !== undefined
              ? current.bindings
              : input.environment.bindings,
          routes: mergedRoutes.map((route) =>
            input.sessionSecret !== undefined &&
            route.routeId === input.sessionSecret.routeId &&
            importedSecretRef !== null
              ? { ...route, secretRef: importedSecretRef }
              : route,
          ),
        };
        yield* environmentCatalog.put(nextEnvironment);
        yield* installEnvironmentLocked(nextEnvironment, null);
      }).pipe(
        Effect.onError(() =>
          importedSecretRef === null
            ? Effect.void
            : environmentSecrets.delete(importedSecretRef).pipe(Effect.ignore),
        ),
      );

      if (previousSecretRef !== null && previousSecretRef !== importedSecretRef) {
        yield* environmentSecrets.delete(previousSecretRef).pipe(
          Effect.catch(() =>
            Effect.logWarning("Could not remove a superseded environment secret.", {
              environmentId,
            }),
          ),
        );
      }
    },
  );

  const registerEnvironment = Effect.fn("EnvironmentRegistry.registerEnvironment")(function* (
    input: EnvironmentRegistrationInput,
  ) {
    const environmentId = input.environment.environmentId;
    const ticket = yield* issueAdmissionTicket(environmentId);
    if (ticket === null) return;
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if (!(yield* admitRegistration(environmentId, ticket))) return;
        yield* registerEnvironmentLocked(input);
      }),
    );
  });

  const register = Effect.fn("EnvironmentRegistry.register")(function* (
    registration: ConnectionRegistration,
  ) {
    const entry = connectionRegistrationCatalogEntry(registration);
    const environmentId = entry.target.environmentId;
    const ticket = yield* issueAdmissionTicket(environmentId);
    if (ticket === null) return;
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if (!(yield* admitRegistration(environmentId, ticket))) return;
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return;
        }
        yield* registrations.register(registration);
        yield* Ref.update(persistedTargetsByEnvironment, (current) => {
          const next = new Map(current);
          next.set(environmentId, registration.target);
          return next;
        });
        yield* installLegacyEntryLocked(entry);
      }),
    );
  });

  const removePersistedPlatformShadow = Effect.fn(
    "EnvironmentRegistry.removePersistedPlatformShadow",
  )(function* (environmentId: EnvironmentId) {
    const persistedTarget = (yield* Ref.get(persistedTargetsByEnvironment)).get(environmentId);
    if (persistedTarget === undefined) return;
    yield* registrations.remove(persistedTarget).pipe(
      Effect.tap(() =>
        Ref.update(persistedTargetsByEnvironment, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning(
          "Could not remove a persisted registration shadowed by a platform environment.",
          { environmentId, error },
        ),
      ),
    );
  });

  const installPlatformRegistration = Effect.fn("EnvironmentRegistry.installPlatformRegistration")(
    function* (
      registration: PlatformConnectionRegistration,
      ticket: EnvironmentAdmissionTicket | null,
    ) {
      if (ticket === null) return;
      const entry = connectionRegistrationCatalogEntry(registration);
      const target = entry.target;
      yield* withLeaseLock(
        target.environmentId,
        Effect.gen(function* () {
          if (!(yield* admitRegistration(target.environmentId, ticket))) return;
          yield* Ref.update(platformEnvironmentIds, (current) => {
            const next = new Set(current);
            next.add(target.environmentId);
            return next;
          });

          yield* removePersistedPlatformShadow(target.environmentId);
          const normalized = normalizedPlatformRegistration(registration);
          if (normalized !== null) {
            yield* registerEnvironmentLocked(normalized);
            return;
          }

          // Secondary desktop-local backends (e.g. a parallel WSL backend) live
          // on their own loopback origin, so they authenticate with a bearer
          // token instead of the primary's same-origin cookie. Stash it where
          // the resolver's bearer broker looks it up.
          if (registration._tag === "BearerConnectionRegistration") {
            yield* credentials.put(registration.target.connectionId, registration.credential).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not store the platform bearer credential.", {
                  environmentId: target.environmentId,
                  error,
                }),
              ),
            );
          } else if (registration._tag === "UnavailableConnectionRegistration") {
            // A desired-but-unavailable desktop backend must not retain a
            // credential from its previous live registration. Its typed
            // target keeps identity/cache state without remaining usable.
            yield* credentials.remove(registration.target.connectionId).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not clear the unavailable platform credential.", {
                  environmentId: target.environmentId,
                  error,
                }),
              ),
            );
          }

          yield* installLegacyEntryLocked(entry, { retainEquivalentRuntime: true });
        }),
      );
    },
  );

  // Tear down a platform-managed environment that the host no longer reports
  // (e.g. the user turned the parallel WSL backend off). Platform environments
  // bypass the user-facing `remove` guard since they are reconciled from the
  // bootstrap rather than removed by hand.
  const removePlatformEnvironment = Effect.fn("EnvironmentRegistry.removePlatformEnvironment")(
    function* (environmentId: EnvironmentId) {
      yield* withLeaseLock(
        environmentId,
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
          yield* Ref.update(platformEnvironmentIds, (current) => {
            const next = new Set(current);
            next.delete(environmentId);
            return next;
          });
          yield* closeServiceScope(environmentId);
          yield* Ref.update(legacyEntries, (current) => {
            const next = new Map(current);
            next.delete(environmentId);
            return next;
          });
          yield* SubscriptionRef.update(environments, (current) => {
            const next = new Map(current);
            next.delete(environmentId);
            return next;
          });
          yield* SubscriptionRef.update(entries, (current) => {
            const next = new Map(current);
            next.delete(environmentId);
            return next;
          });
          if (
            entry !== undefined &&
            (entry.target._tag === "BearerConnectionTarget" ||
              entry.target._tag === "UnavailableConnectionTarget")
          ) {
            yield* credentials.remove(entry.target.connectionId).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not clear the platform bearer credential.", {
                  environmentId,
                  error,
                }),
              ),
            );
          }
          yield* Effect.all(
            [
              cache.clear(environmentId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not clear cached environment data after removal.", {
                    environmentId,
                    error,
                  }),
                ),
              ),
              ownedDataCleanup.clear(environmentId),
            ],
            { concurrency: "unbounded", discard: true },
          );
        }),
      );
    },
  );

  const registerPlatform = Effect.fn("EnvironmentRegistry.registerPlatform")(function* (
    registration: PrimaryConnectionRegistration,
  ) {
    const ticket = yield* issueAdmissionTicket(registration.target.environmentId);
    yield* installPlatformRegistration(registration, ticket);
  });

  // Reconcile the full set of platform-managed environments against what the
  // host currently reports: add/refresh the desired ones and tear down any
  // platform environment that disappeared (WSL toggled off, distro switched).
  const reconcilePlatform = Effect.fn("EnvironmentRegistry.reconcilePlatform")(function* (
    platformRegistrations: ReadonlyArray<PlatformConnectionRegistration>,
  ) {
    const pendingRegistrations = yield* Effect.forEach(
      platformRegistrations,
      Effect.fn("EnvironmentRegistry.issuePlatformAdmissionTicket")(function* (registration) {
        return {
          registration,
          ticket: yield* issueAdmissionTicket(registration.target.environmentId),
        } as const;
      }),
    );
    const desiredIds = new Set(
      platformRegistrations.map((registration) => registration.target.environmentId),
    );
    const currentPlatformIds = yield* Ref.get(platformEnvironmentIds);
    yield* Effect.forEach(
      currentPlatformIds,
      (environmentId) =>
        desiredIds.has(environmentId) ? Effect.void : removePlatformEnvironment(environmentId),
      { discard: true },
    );
    yield* Effect.forEach(
      pendingRegistrations,
      ({ registration, ticket }) => installPlatformRegistration(registration, ticket),
      { discard: true },
    );
  });

  const publishEnvironmentMetadataLocked = Effect.fn(
    "EnvironmentRegistry.publishEnvironmentMetadataLocked",
  )(function* (environment: KnownEnvironment) {
    const environmentId = environment.environmentId;
    const legacyEntry = (yield* Ref.get(legacyEntries)).get(environmentId) ?? null;
    yield* SubscriptionRef.update(environments, (current) =>
      new Map(current).set(environmentId, environment),
    );
    yield* SubscriptionRef.update(entries, (current) =>
      new Map(current).set(environmentId, legacyEntry ?? projectCatalogEntry(environment)),
    );
    yield* SubscriptionRef.update(serviceScopes, (current) => {
      const existing = current.get(environmentId);
      return existing === undefined
        ? current
        : new Map(current).set(environmentId, { ...existing, entry: environment });
    });
  });

  const setHidden = Effect.fn("EnvironmentRegistry.setHidden")(function* (
    environmentId: EnvironmentId,
    hidden: boolean,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        yield* ensureAdmissionOpen(environmentId);
        const environment = yield* getEnvironment(environmentId);
        if (environment.hidden === hidden) return;
        const next = { ...environment, hidden };
        yield* environmentCatalog.put(next);
        yield* publishEnvironmentMetadataLocked(next);
      }),
    );
  });

  const hide = (environmentId: EnvironmentId) =>
    setHidden(environmentId, true).pipe(Effect.withSpan("EnvironmentRegistry.hide"));
  const restore = (environmentId: EnvironmentId) =>
    setHidden(environmentId, false).pipe(Effect.withSpan("EnvironmentRegistry.restore"));

  const removeRoute = Effect.fn("EnvironmentRegistry.removeRoute")(function* (
    environmentId: EnvironmentId,
    routeId: string,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        yield* ensureAdmissionOpen(environmentId);
        const environment = yield* getEnvironment(environmentId);
        const removedRoute = environment.routes.find((route) => route.routeId === routeId);
        if (removedRoute === undefined) return;
        if (removedRoute.secretRef !== null) {
          yield* environmentSecrets.delete(removedRoute.secretRef);
        }
        const next: KnownEnvironment = {
          ...environment,
          routes: environment.routes.filter((route) => route.routeId !== routeId),
        };
        yield* environmentCatalog.updateRoutes(environmentId, next.routes);
        yield* installEnvironmentLocked(next, null);
        if (removedRoute._tag === "SshTunnelRoute" && removedRoute.hostKeyFingerprint !== null) {
          yield* ssh
            .disconnect(removedRoute.target, removedRoute.hostKeyFingerprint)
            .pipe(Effect.ignore);
        }
      }),
    );
  });

  const forgetNormalizedEnvironmentLocked = Effect.fn(
    "EnvironmentRegistry.forgetNormalizedEnvironmentLocked",
  )(function* (environment: KnownEnvironment) {
    const environmentId = environment.environmentId;
    const generation = yield* beginForgetAdmission(environmentId);
    const repairReceipt = (
      phase: Persistence.EnvironmentCleanupRepairPhase,
    ): Persistence.EnvironmentCleanupRepairReceipt => ({
      schemaVersion: 1,
      environmentId,
      generation,
      phase,
    });
    const markRepair = (phase: Persistence.EnvironmentCleanupRepairPhase) =>
      environmentCleanup
        .saveRepair(repairReceipt(phase))
        .pipe(
          Effect.ignore,
          Effect.andThen(setAdmissionPhase(environmentId, generation, "repair")),
        );

    yield* environmentCleanup
      .saveRepair(repairReceipt("pending"))
      .pipe(Effect.tapError(() => setAdmissionPhase(environmentId, generation, "open")));
    yield* closeServiceScope(environmentId);

    const cacheManifest = yield* cacheManifests
      .load(environmentId)
      .pipe(Effect.tapError(() => markRepair("metadata-deletion-failed")));
    const cacheKeyRef = Option.getOrNull(cacheManifest)?.keyRef ?? null;
    const secretReferences = [
      ...new Set([
        ...environment.routes.flatMap((route) =>
          route.secretRef === null ? [] : [route.secretRef],
        ),
        ...(cacheKeyRef === null ? [] : [cacheKeyRef]),
      ]),
    ];
    yield* Effect.forEach(secretReferences, (secretRef) => environmentSecrets.delete(secretRef), {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.tapError(() => markRepair("secret-deletion-failed")));
    yield* ownedDataCleanup.clear(environmentId);
    yield* environmentCleanup
      .commitForget(environmentId)
      .pipe(Effect.tapError(() => markRepair("metadata-deletion-failed")));

    yield* Ref.update(legacyEntries, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
    yield* SubscriptionRef.update(environments, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
    yield* SubscriptionRef.update(entries, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
    yield* setAdmissionPhase(environmentId, generation, "forgotten");

    const sshTargets = environment.routes.flatMap((route) =>
      route._tag === "SshTunnelRoute" && route.hostKeyFingerprint !== null
        ? [
            {
              target: route.target,
              hostKeyFingerprint: route.hostKeyFingerprint,
            },
          ]
        : [],
    );
    yield* Effect.forEach(
      sshTargets,
      ({ target, hostKeyFingerprint }) =>
        ssh.disconnect(target, hostKeyFingerprint).pipe(Effect.ignore),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
  });

  const forget = Effect.fn("EnvironmentRegistry.forget")(function* (environmentId: EnvironmentId) {
    yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return yield* new PlatformEnvironmentRemovalError({ environmentId });
        }
        const environment = yield* getEnvironment(environmentId);
        if ((yield* Ref.get(legacyEntries)).has(environmentId)) {
          return yield* new Persistence.ConnectionPersistenceError({
            operation: "forget-environment",
            message: "This legacy environment must use the compatibility removal path.",
          });
        }
        yield* forgetNormalizedEnvironmentLocked(environment);
      }),
    );
  });

  const remove = Effect.fn("EnvironmentRegistry.remove")(function* (environmentId: EnvironmentId) {
    return yield* withLeaseLock(
      environmentId,
      Effect.gen(function* () {
        if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) {
          return yield* new PlatformEnvironmentRemovalError({
            environmentId,
          });
        }
        const environment = yield* getEnvironment(environmentId);
        const entry = (yield* SubscriptionRef.get(entries)).get(environmentId);
        if (entry === undefined) {
          return yield* new EnvironmentNotRegisteredError({ environmentId });
        }
        const target = entry.target;
        const legacyEntry = (yield* Ref.get(legacyEntries)).get(environmentId);
        const legacyProfile =
          target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget"
            ? yield* profiles.get(target.connectionId)
            : Option.none();

        if (legacyEntry !== undefined) {
          yield* registrations.remove(target);
          yield* Ref.update(persistedTargetsByEnvironment, (current) => {
            const next = new Map(current);
            next.delete(environmentId);
            return next;
          });
          yield* closeServiceScope(environmentId);
          yield* Effect.all(
            [
              cache.clear(environmentId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not clear cached environment data after removal.", {
                    environmentId,
                    error,
                  }),
                ),
              ),
              ownedDataCleanup.clear(environmentId),
            ],
            { concurrency: "unbounded", discard: true },
          );
        } else {
          yield* forgetNormalizedEnvironmentLocked(environment);
          return;
        }

        yield* Ref.update(legacyEntries, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* SubscriptionRef.update(environments, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* SubscriptionRef.update(entries, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });

        const normalizedSshRoute = environment.routes.find(
          (route) => route._tag === "SshTunnelRoute",
        );
        const normalizedSshTarget = normalizedSshRoute?.target;
        const legacySshTarget =
          target._tag === "SshConnectionTarget" &&
          Option.isSome(legacyProfile) &&
          isSshConnectionProfile(legacyProfile.value)
            ? legacyProfile.value.target
            : null;
        const sshTarget = normalizedSshTarget ?? legacySshTarget;
        const sshHostKeyFingerprint = normalizedSshRoute?.hostKeyFingerprint ?? null;
        if (sshTarget !== null && sshTarget !== undefined && sshHostKeyFingerprint !== null) {
          yield* ssh.disconnect(sshTarget, sshHostKeyFingerprint).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not disconnect the managed SSH environment.", {
                environmentId,
                error,
              }),
            ),
            Effect.ignore,
          );
        }
      }),
    );
  });

  const removeRelayEnvironments = Effect.fn("EnvironmentRegistry.removeRelayEnvironments")(
    function* () {
      const relayEnvironmentIds = [...(yield* SubscriptionRef.get(entries)).values()]
        .filter((entry) => entry.target._tag === "RelayConnectionTarget")
        .map((entry) => entry.target.environmentId);

      yield* Effect.forEach(
        relayEnvironmentIds,
        (environmentId) =>
          remove(environmentId).pipe(
            Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
          ),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    },
  );

  const retryNow = (environmentId: EnvironmentId) =>
    acquireSupervisor(environmentId).pipe(
      Effect.flatMap((supervisor) => supervisor.retryNow),
      Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.void),
      Effect.withSpan("EnvironmentRegistry.retryNow"),
    );
  const acceptStorageIdentity = Effect.fn("EnvironmentRegistry.acceptStorageIdentity")(function* (
    environmentId: EnvironmentId,
  ) {
    yield* withLeaseLock(
      environmentId,
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* getEnvironment(environmentId);
          const supervisor = (yield* SubscriptionRef.get(serviceScopes)).get(
            environmentId,
          )?.supervisor;
          if (supervisor === undefined) {
            return yield* new Persistence.ConnectionPersistenceError({
              operation: "accept-storage-identity",
              message: "The environment is not currently blocked by a persistent store change.",
            });
          }
          const current = yield* SubscriptionRef.get(supervisor.state);
          if (
            current.phase !== "blocked" ||
            current.lastFailure?._tag !== "ConnectionStorageChangedError"
          ) {
            return yield* new Persistence.ConnectionPersistenceError({
              operation: "accept-storage-identity",
              message: "The environment is not currently blocked by a persistent store change.",
            });
          }
          const storageFailure = current.lastFailure;
          const adopted = yield* identities.transition(
            storageFailure.targetKey,
            (acceptedStorageInstanceId) =>
              acceptedStorageInstanceId === storageFailure.acceptedStorageInstanceId
                ? {
                    result: true,
                    mutation: {
                      _tag: "Set",
                      storageInstanceId: storageFailure.reportedStorageInstanceId,
                    },
                  }
                : { result: false, mutation: { _tag: "Keep" } },
          );
          if (!adopted) {
            return yield* new Persistence.ConnectionPersistenceError({
              operation: "accept-storage-identity",
              message: "The accepted persistent store changed before it could be adopted.",
            });
          }
          yield* supervisor.retryNow;
        }),
      ),
    );
  });
  const state = Effect.fn("EnvironmentRegistry.state")(function* (environmentId: EnvironmentId) {
    const supervisor = yield* acquireSupervisor(environmentId);
    return yield* SubscriptionRef.get(supervisor.state);
  });
  const stateChanges = (environmentId: EnvironmentId) =>
    followStream(
      environmentId,
      Stream.unwrap(
        EnvironmentSupervisor.EnvironmentSupervisor.pipe(
          Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
        ),
      ),
    );

  yield* Effect.addFinalizer(() =>
    SubscriptionRef.get(serviceScopes).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), (lease) => Scope.close(lease.scope, Exit.void), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );
  yield* connectivity.changes.pipe(
    Stream.runForEach((status) => SubscriptionRef.set(networkStatus, status)),
    Effect.forkScoped,
  );

  return EnvironmentRegistry.of({
    environments,
    entries,
    networkStatus,
    start,
    registerEnvironment,
    register,
    registerPlatform,
    reconcilePlatform,
    hide,
    restore,
    removeRoute,
    forget,
    remove,
    removeRelayEnvironments,
    retryNow,
    acceptStorageIdentity,
    state,
    stateChanges,
    run,
    runStream,
    followStream,
  });
});

export const layer = Layer.effect(EnvironmentRegistry, make());

export const layerWithOptions = (options: EnvironmentRegistryOptions) =>
  Layer.effect(EnvironmentRegistry, make(options));
