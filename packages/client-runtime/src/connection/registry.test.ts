import {
  type DesktopSshEnvironmentTarget,
  DurableEnvironmentId,
  EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionRegistration,
  PrimaryConnectionRegistration,
  RelayConnectionRegistration,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
  type KnownEnvironment,
  UnavailableConnectionRegistration,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionAttemptError,
  ConnectionStorageChangedError,
  ConnectionTransientError,
  BearerConnectionTarget,
  DesktopLoopbackRoute,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
  UnavailableConnectionTarget,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as RpcSession from "../rpc/session.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const SECOND_TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-2"),
  label: "Second environment",
  httpBaseUrl: "https://environment-2.example.test",
  wsBaseUrl: "wss://environment-2.example.test",
});
const NORMALIZED_ENVIRONMENT_ID = DurableEnvironmentId.make("00000000-0000-4000-8000-000000000091");
const NORMALIZED_ENVIRONMENT = {
  environmentId: NORMALIZED_ENVIRONMENT_ID,
  acceptedStorageInstanceId: "00000000-0000-4000-8000-000000000092",
  descriptor: null,
  alias: "Normalized environment",
  hidden: false,
  bindings: [],
  routes: [
    new DesktopLoopbackRoute({
      routeId: "normalized-loopback",
      environmentId: NORMALIZED_ENVIRONMENT_ID,
      label: "Normalized loopback",
      priority: 0,
      pinned: false,
      autoconnect: true,
      secretRef: null,
      httpBaseUrl: "http://127.0.0.1:48291",
      wsBaseUrl: "ws://127.0.0.1:48291",
    }),
  ],
} as KnownEnvironment;
const NORMALIZED_ROUTE_SECRET_REF = "bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8";
const MULTI_ROUTE_NORMALIZED_ENVIRONMENT = {
  ...NORMALIZED_ENVIRONMENT,
  routes: [
    new DesktopLoopbackRoute({
      routeId: "normalized-loopback",
      environmentId: NORMALIZED_ENVIRONMENT_ID,
      label: "Normalized loopback",
      priority: 0,
      pinned: false,
      autoconnect: true,
      secretRef: NORMALIZED_ROUTE_SECRET_REF,
      httpBaseUrl: "http://127.0.0.1:48291",
      wsBaseUrl: "ws://127.0.0.1:48291",
    }),
    new DesktopLoopbackRoute({
      routeId: "normalized-loopback-fallback",
      environmentId: NORMALIZED_ENVIRONMENT_ID,
      label: "Normalized loopback fallback",
      priority: 1,
      pinned: false,
      autoconnect: true,
      secretRef: null,
      httpBaseUrl: "http://127.0.0.1:48292",
      wsBaseUrl: "ws://127.0.0.1:48292",
    }),
  ],
} as KnownEnvironment;

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  descriptor: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    storageInstanceId: "store-test",
    protocol: { minimum: 1, maximum: 1 },
    capabilities: {
      repositoryIdentity: true,
      worktreeCatalog: false,
      worktreeCatalogRefreshReason: false,
      vcsStatusSummary: false,
      activityProtocolVersion: null,
    },
  },
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-relay"),
  label: "Relay environment",
});
const SECOND_RELAY_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-relay-2"),
  label: "Second relay environment",
});

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-bearer"),
  label: "Bearer environment",
  connectionId: "bearer-connection",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: BEARER_TARGET.environmentId,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://bearer.example.test",
  wsBaseUrl: "wss://bearer.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});

const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "test",
  hostname: "test.example.test",
  username: "developer",
  port: 22,
};
const SSH_CONNECTION = new SshConnectionTarget({
  environmentId: EnvironmentId.make("environment-ssh"),
  label: "SSH environment",
  connectionId: "ssh-connection",
});
const SSH_PROFILE = new SshConnectionProfile({
  connectionId: SSH_CONNECTION.connectionId,
  environmentId: SSH_CONNECTION.environmentId,
  label: SSH_CONNECTION.label,
  target: SSH_TARGET,
});

const CACHED_SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-06-06T00:00:00.000Z",
};
const CACHED_THREAD: OrchestrationThread = {
  id: ThreadId.make("thread-cached"),
  projectId: ProjectId.make("project-cached"),
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
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

interface SessionControl {
  readonly closed: Deferred.Deferred<never, ConnectionTransientError>;
}

const makeHarness = Effect.fn("TestEnvironmentRegistry.makeHarness")(function* (
  initialTargets: ReadonlyArray<ConnectionTarget>,
  initialProfiles: ReadonlyArray<ConnectionProfile> = [],
  initialCredentials: ReadonlyArray<readonly [string, ConnectionCredential]> = [],
  options?: {
    readonly initialEnvironments?: ReadonlyArray<KnownEnvironment>;
    readonly initialCleanupRepairs?: ReadonlyArray<Persistence.EnvironmentCleanupRepairReceipt>;
    readonly migrationCompleted?: boolean;
    readonly maxConcurrentEnvironmentAttempts?: number;
    readonly beforeSessionConnect?: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionAttemptError>;
    readonly beforeRegistrationRegister?: (
      registration: ConnectionRegistration,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly beforeRegistrationRemove?: (
      target: ConnectionTarget,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly afterStorageIdentityAccept?: (
      identity: Persistence.AcceptedStorageIdentity,
    ) => Effect.Effect<void>;
    readonly beforeEnvironmentSecretDelete?: (
      secretRef: string,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
  },
) {
  const storedTargets = yield* Ref.make(
    new Map(initialTargets.map((target) => [target.environmentId, target])),
  );
  const storedEnvironments = yield* Ref.make(
    new Map(
      (options?.initialEnvironments ?? []).map((environment) => [
        environment.environmentId,
        environment,
      ]),
    ),
  );
  const storedEnvironmentSecrets = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const cleanupRepairs = yield* Ref.make(
    new Map(
      (options?.initialCleanupRepairs ?? []).map((receipt) => [receipt.environmentId, receipt]),
    ),
  );
  const lifecycleEvents = yield* Ref.make<ReadonlyArray<string>>([]);
  const targetListCount = yield* Ref.make(0);
  const shellCache = yield* Ref.make(new Map([[TARGET.environmentId, CACHED_SNAPSHOT]]));
  const threadCache = yield* Ref.make(
    new Map([[TARGET.environmentId, new Map([[CACHED_THREAD.id, CACHED_THREAD]])]]),
  );
  const cacheClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const ownedDataClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const sessions = yield* Ref.make<ReadonlyArray<SessionControl>>([]);
  const releasedSessions = yield* Ref.make(0);
  const storedProfiles = yield* Ref.make(
    new Map(initialProfiles.map((profile) => [profile.connectionId, profile])),
  );
  const profileReadCount = yield* Ref.make(0);
  const storedCredentials = yield* Ref.make(new Map(initialCredentials));
  const storedRemoteTokens = yield* Ref.make(
    new Map([
      [
        SSH_CONNECTION.environmentId,
        new TokenStore.RemoteDpopAccessToken({
          environmentId: SSH_CONNECTION.environmentId,
          label: SSH_CONNECTION.label,
          endpoint: {
            httpBaseUrl: "https://ssh.example.test",
            wsBaseUrl: "wss://ssh.example.test",
            providerKind: "cloudflare_tunnel",
          },
          accessToken: "cached-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          dpopThumbprint: "thumbprint",
        }),
      ],
    ]),
  );
  const disconnectedSshTargets = yield* Ref.make<ReadonlyArray<DesktopSshEnvironmentTarget>>([]);
  const acceptedStorageIdentities = yield* Ref.make(new Map<string, string>());
  const acceptedStorageIdentityWrites = yield* Ref.make<
    ReadonlyArray<Persistence.AcceptedStorageIdentity>
  >([]);

  const targetStore = Persistence.ConnectionTargetStore.of({
    list: Ref.update(targetListCount, (count) => count + 1).pipe(
      Effect.andThen(Ref.get(storedTargets)),
      Effect.map((targets) => [...targets.values()]),
    ),
  });
  const environmentCatalogStore = Persistence.EnvironmentCatalogStore.of({
    list: Ref.get(storedEnvironments).pipe(Effect.map((current) => [...current.values()])),
    load: (environmentId) =>
      Ref.get(storedEnvironments).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      ),
    put: (environment) =>
      Ref.update(storedEnvironments, (current) =>
        new Map(current).set(environment.environmentId, environment),
      ),
    updateRoutes: (environmentId, routes) =>
      Ref.update(storedEnvironments, (current) => {
        const environment = current.get(environmentId);
        return environment === undefined
          ? current
          : new Map(current).set(environmentId, { ...environment, routes });
      }),
    listBindings: Effect.succeed([]),
    putBinding: () => Effect.void,
  });
  const environmentSecretStore = Persistence.EnvironmentSecretStore.of({
    put: (_environmentId, _purpose, value) => {
      const secretRef = "bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8";
      return Ref.update(storedEnvironmentSecrets, (current) =>
        new Map(current).set(secretRef, value),
      ).pipe(Effect.as(secretRef));
    },
    get: (secretRef) =>
      Ref.get(storedEnvironmentSecrets).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(secretRef))),
      ),
    delete: (secretRef) =>
      Effect.gen(function* () {
        yield* options?.beforeEnvironmentSecretDelete?.(secretRef) ?? Effect.void;
        yield* Ref.update(storedEnvironmentSecrets, (current) => {
          const next = new Map(current);
          next.delete(secretRef);
          return next;
        });
        yield* Ref.update(lifecycleEvents, (current) => [...current, "delete-secrets"]);
      }),
  });
  const environmentCleanupStore = Persistence.EnvironmentCleanupStore.of({
    repairs: Ref.get(cleanupRepairs).pipe(Effect.map((current) => [...current.values()])),
    saveRepair: (receipt) =>
      Ref.update(cleanupRepairs, (current) =>
        new Map(current).set(receipt.environmentId, receipt),
      ).pipe(
        Effect.andThen(
          receipt.phase === "pending"
            ? Ref.update(lifecycleEvents, (current) => [...current, "close-admission"])
            : Effect.void,
        ),
      ),
    commitForget: (environmentId) =>
      Effect.gen(function* () {
        yield* Ref.update(lifecycleEvents, (current) => [...current, "clear-cache"]);
        yield* Ref.update(shellCache, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* Ref.update(threadCache, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* Ref.update(lifecycleEvents, (current) => [...current, "clear-ui"]);
        yield* Ref.update(lifecycleEvents, (current) => [...current, "delete-routes"]);
        yield* Ref.update(lifecycleEvents, (current) => [...current, "delete-environment"]);
        yield* Ref.update(storedEnvironments, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
        yield* Ref.update(cleanupRepairs, (current) => {
          const next = new Map(current);
          next.delete(environmentId);
          return next;
        });
      }),
  });
  const environmentCacheManifestStore = Persistence.EnvironmentCacheManifestStore.of({
    load: () => Effect.succeed(Option.none()),
    save: () => Effect.void,
    remove: () => Effect.void,
  });
  const environmentUiStateStore = Persistence.EnvironmentUiStateStore.of({
    load: Effect.succeed(Option.none()),
    save: () => Effect.void,
    clearEnvironment: () => Effect.void,
  });
  const environmentMigrationStore = Persistence.EnvironmentMigrationStore.of({
    load: () =>
      Effect.succeed(
        options?.migrationCompleted === true
          ? Option.some({
              id: "catalog-v1-to-v3",
              completedAt: "2026-08-25T00:00:00.000Z",
            })
          : Option.none(),
      ),
    save: () => Effect.void,
  });
  const registrationStore = Persistence.ConnectionRegistrationStore.of({
    register: (registration) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRegister?.(registration) ?? Effect.void;
        yield* Ref.update(storedTargets, (current) => {
          const next = new Map(current);
          next.set(registration.target.environmentId, registration.target);
          return next;
        });
        switch (registration._tag) {
          case "RelayConnectionRegistration":
            return;
          case "BearerConnectionRegistration":
            yield* Ref.update(storedProfiles, (current) => {
              const next = new Map(current);
              next.set(registration.profile.connectionId, registration.profile);
              return next;
            });
            yield* Ref.update(storedCredentials, (current) => {
              const next = new Map(current);
              next.set(registration.target.connectionId, registration.credential);
              return next;
            });
            return;
          case "SshConnectionRegistration":
            yield* Ref.update(storedProfiles, (current) => {
              const next = new Map(current);
              next.set(registration.profile.connectionId, registration.profile);
              return next;
            });
        }
      }),
    remove: (target) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRemove?.(target) ?? Effect.void;
        yield* Ref.update(storedTargets, (current) => {
          const next = new Map(current);
          next.delete(target.environmentId);
          return next;
        });
        if (target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget") {
          yield* Ref.update(storedProfiles, (current) => {
            const next = new Map(current);
            next.delete(target.connectionId);
            return next;
          });
          yield* Ref.update(storedCredentials, (current) => {
            const next = new Map(current);
            next.delete(target.connectionId);
            return next;
          });
        }
        yield* Ref.update(storedRemoteTokens, (current) => {
          const next = new Map(current);
          next.delete(target.environmentId);
          return next;
        });
      }),
  });
  const acceptedStorageIdentityService = {
    get: (targetKey: string) =>
      Ref.get(acceptedStorageIdentities).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(targetKey))),
      ),
    accept: (identity: Persistence.AcceptedStorageIdentity) =>
      Ref.update(acceptedStorageIdentities, (current) => {
        const next = new Map(current);
        next.set(identity.targetKey, identity.storageInstanceId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(acceptedStorageIdentityWrites, (current) => [...current, identity]),
        ),
        Effect.andThen(options?.afterStorageIdentityAccept?.(identity) ?? Effect.void),
      ),
    transition: <A>(
      targetKey: string,
      decide: (acceptedStorageInstanceId: string | null) => {
        readonly result: A;
        readonly mutation:
          | { readonly _tag: "Keep" }
          | { readonly _tag: "Set"; readonly storageInstanceId: string };
      },
    ) =>
      Ref.modify(
        acceptedStorageIdentities,
        (
          current,
        ): readonly [
          {
            readonly result: A;
            readonly identity: Persistence.AcceptedStorageIdentity | null;
          },
          Map<string, string>,
        ] => {
          const transition = decide(current.get(targetKey) ?? null);
          if (transition.mutation._tag === "Keep") {
            return [{ result: transition.result, identity: null }, current] as const;
          }
          const identity = {
            targetKey,
            storageInstanceId: transition.mutation.storageInstanceId,
          };
          const next = new Map(current);
          next.set(targetKey, identity.storageInstanceId);
          return [{ result: transition.result, identity }, next] as const;
        },
      ).pipe(
        Effect.flatMap(({ result, identity }) =>
          identity === null
            ? Effect.succeed(result)
            : Ref.update(acceptedStorageIdentityWrites, (current) => [...current, identity]).pipe(
                Effect.andThen(options?.afterStorageIdentityAccept?.(identity) ?? Effect.void),
                Effect.as(result),
              ),
        ),
      ),
  };
  const acceptedStorageIdentityStore = Persistence.AcceptedStorageIdentityStore.of(
    acceptedStorageIdentityService,
  );
  const cacheStore = Persistence.EnvironmentCacheStore.of({
    loadShell: (environmentId) =>
      Ref.get(shellCache).pipe(
        Effect.map((cache) => Option.fromUndefinedOr(cache.get(environmentId))),
      ),
    saveShell: (environmentId, snapshot) =>
      Ref.update(shellCache, (current) => {
        const next = new Map(current);
        next.set(environmentId, snapshot);
        return next;
      }),
    loadThread: (environmentId, threadId) =>
      Ref.get(threadCache).pipe(
        Effect.map((cache) => Option.fromUndefinedOr(cache.get(environmentId)?.get(threadId))),
      ),
    saveThread: (environmentId, thread) =>
      Ref.update(threadCache, (current) => {
        const next = new Map(current);
        const threads = new Map(next.get(environmentId));
        threads.set(thread.id, thread);
        next.set(environmentId, threads);
        return next;
      }),
    removeThread: (environmentId, threadId) =>
      Ref.update(threadCache, (current) => {
        const next = new Map(current);
        const threads = new Map(next.get(environmentId));
        threads.delete(threadId);
        next.set(environmentId, threads);
        return next;
      }),
    clear: (environmentId) =>
      Ref.update(shellCache, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(threadCache, (current) => {
            const next = new Map(current);
            next.delete(environmentId);
            return next;
          }),
        ),
        Effect.andThen(
          Ref.update(cacheClears, (environmentIds) => [...environmentIds, environmentId]),
        ),
      ),
  });
  const ownedDataCleanup = Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Ref.update(ownedDataClears, (environmentIds) => [...environmentIds, environmentId]),
  });
  const networkStatus = yield* SubscriptionRef.make<"unknown" | "offline" | "online">("online");
  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });
  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) =>
      Ref.update(profileReadCount, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(storedProfiles)),
        Effect.map((current) => Option.fromUndefinedOr(current.get(connectionId))),
      ),
    put: (profile) =>
      Ref.update(storedProfiles, (current) => {
        const next = new Map(current);
        next.set(profile.connectionId, profile);
        return next;
      }),
    remove: (connectionId) =>
      Ref.update(storedProfiles, (current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      }),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) =>
      Ref.get(storedCredentials).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(connectionId))),
      ),
    put: (connectionId, credential) =>
      Ref.update(storedCredentials, (current) => {
        const next = new Map(current);
        next.set(connectionId, credential);
        return next;
      }),
    remove: (connectionId) =>
      Ref.update(storedCredentials, (current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      }),
  });
  const tokenStore = TokenStore.RemoteDpopAccessTokenStore.of({
    get: (environmentId) =>
      Ref.get(storedRemoteTokens).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      ),
    put: (token) =>
      Ref.update(storedRemoteTokens, (current) => {
        const next = new Map(current);
        next.set(token.environmentId, token);
        return next;
      }),
    remove: (environmentId) =>
      Ref.update(storedRemoteTokens, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }),
  });
  const sshGateway = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die(new Error("SSH provisioning is not used.")),
    prepare: () => Effect.die(new Error("SSH preparation is not used.")),
    inspect: () => Effect.die(new Error("SSH inspection is not used.")),
    exchange: () => Effect.die(new Error("SSH exchange is not used.")),
    disconnect: (target) => Ref.update(disconnectedSshTargets, (current) => [...current, target]),
  });
  const driver = ConnectionDriver.ConnectionDriver.of({
    connect: (input, reportProgress) =>
      Effect.gen(function* () {
        const target = "target" in input ? input.target : PREPARED.target;
        if (target._tag === "UnavailableConnectionTarget") {
          return yield* new ConnectionTransientError({
            reason: "endpoint-unavailable",
            detail: target.detail,
          });
        }
        const prepared = {
          ...PREPARED,
          environmentId: target.environmentId,
          label: target.label,
          target,
        };
        yield* reportProgress({ stage: "preparing" });
        yield* reportProgress({ stage: "opening", prepared });
        yield* options?.beforeSessionConnect?.(target.environmentId) ?? Effect.void;
        const closed = yield* Deferred.make<never, ConnectionTransientError>();
        yield* Ref.update(sessions, (current) => [...current, { closed }]);
        const session = yield* Effect.acquireRelease(
          Effect.succeed({
            client: {} as RpcSession.RpcSession["client"],
            initialConfig: Effect.die(new Error("Config is not used by registry tests.")),
            ready: Effect.void,
            probe: Effect.void,
            closed: Deferred.await(closed),
          } satisfies RpcSession.RpcSession),
          () =>
            Ref.update(lifecycleEvents, (current) => [
              ...current,
              "cancel-supervisor",
              "await-scope",
            ]).pipe(Effect.andThen(Ref.update(releasedSessions, (count) => count + 1))),
        );
        yield* reportProgress({ stage: "synchronizing", prepared });
        yield* session.ready;
        return { prepared, session };
      }),
  });

  const cacheLayer = Layer.succeed(Persistence.EnvironmentCacheStore, cacheStore);
  const registryLayer =
    options?.maxConcurrentEnvironmentAttempts === undefined
      ? EnvironmentRegistry.layer
      : EnvironmentRegistry.layerWithOptions({
          maxConcurrentEnvironmentAttempts: options.maxConcurrentEnvironmentAttempts,
        });
  const layer = registryLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Persistence.ConnectionTargetStore, targetStore),
        Layer.succeed(Persistence.EnvironmentCatalogStore, environmentCatalogStore),
        Layer.succeed(Persistence.EnvironmentCleanupStore, environmentCleanupStore),
        Layer.succeed(Persistence.EnvironmentCacheManifestStore, environmentCacheManifestStore),
        Layer.succeed(Persistence.EnvironmentSecretStore, environmentSecretStore),
        Layer.succeed(Persistence.EnvironmentUiStateStore, environmentUiStateStore),
        Layer.succeed(Persistence.EnvironmentMigrationStore, environmentMigrationStore),
        Layer.succeed(Persistence.ConnectionRegistrationStore, registrationStore),
        Layer.succeed(Persistence.AcceptedStorageIdentityStore, acceptedStorageIdentityStore),
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, tokenStore),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, sshGateway),
        Layer.succeed(Connectivity.Connectivity, connectivity),
        Layer.succeed(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
        ),
        Layer.succeed(ConnectionDriver.ConnectionDriver, driver),
        cacheLayer,
        Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, ownedDataCleanup),
      ),
    ),
  );

  return {
    layer,
    storedTargets,
    shellCache,
    threadCache,
    cacheClears,
    ownedDataClears,
    sessions,
    releasedSessions,
    storedProfiles,
    profileReadCount,
    storedCredentials,
    storedRemoteTokens,
    disconnectedSshTargets,
    acceptedStorageIdentities,
    acceptedStorageIdentityWrites,
    networkStatus,
    targetListCount,
    storedEnvironments,
    storedEnvironmentSecrets,
    cleanupRepairs,
    lifecycleEvents,
  };
});

function awaitConnectionState(
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  predicate: (state: SupervisorConnectionState) => boolean,
) {
  return Effect.gen(function* () {
    const current = yield* registry.state(environmentId);
    if (predicate(current)) {
      return current;
    }
    return yield* registry
      .stateChanges(environmentId)
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  });
}

describe("EnvironmentRegistry", () => {
  it.effect("uses normalized environments exclusively after the migration receipt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([SSH_CONNECTION], [], [], {
        initialEnvironments: [NORMALIZED_ENVIRONMENT],
        migrationCompleted: true,
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        expect([...(yield* SubscriptionRef.get(registry.environments)).keys()]).toEqual([
          NORMALIZED_ENVIRONMENT_ID,
        ]);
        expect(yield* Ref.get(harness.targetListCount)).toBe(0);

        const owned = yield* registry.run(
          NORMALIZED_ENVIRONMENT_ID,
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => supervisor.environment),
          ),
        );
        expect(owned).toEqual(NORMALIZED_ENVIRONMENT);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("hides and restores only client presentation metadata without restarting runtime", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], {
        initialEnvironments: [NORMALIZED_ENVIRONMENT],
        migrationCompleted: true,
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          NORMALIZED_ENVIRONMENT_ID,
          (state) => state.phase === "connected",
        );

        yield* registry.hide(NORMALIZED_ENVIRONMENT_ID);
        expect(
          (yield* Ref.get(harness.storedEnvironments)).get(NORMALIZED_ENVIRONMENT_ID)?.hidden,
        ).toBe(true);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        expect(yield* Ref.get(harness.releasedSessions)).toBe(0);

        yield* registry.restore(NORMALIZED_ENVIRONMENT_ID);
        expect(
          (yield* Ref.get(harness.storedEnvironments)).get(NORMALIZED_ENVIRONMENT_ID)?.hidden,
        ).toBe(false);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect(
    "removes one route secret while retaining the environment and its remaining route",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([], [], [], {
          initialEnvironments: [MULTI_ROUTE_NORMALIZED_ENVIRONMENT],
          migrationCompleted: true,
        });
        yield* Ref.set(
          harness.storedEnvironmentSecrets,
          new Map([[NORMALIZED_ROUTE_SECRET_REF, "protected-session-value"]]),
        );

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.removeRoute(NORMALIZED_ENVIRONMENT_ID, "normalized-loopback");

          const retained = (yield* Ref.get(harness.storedEnvironments)).get(
            NORMALIZED_ENVIRONMENT_ID,
          );
          expect(retained?.routes.map((route) => route.routeId)).toEqual([
            "normalized-loopback-fallback",
          ]);
          expect(
            (yield* Ref.get(harness.storedEnvironmentSecrets)).has(NORMALIZED_ROUTE_SECRET_REF),
          ).toBe(false);
          expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );

  it.effect("forgets in cleanup order and ignores registration that completes during cleanup", () =>
    Effect.gen(function* () {
      const deleteStarted = yield* Deferred.make<void>();
      const continueDelete = yield* Deferred.make<void>();
      const harness = yield* makeHarness([], [], [], {
        initialEnvironments: [MULTI_ROUTE_NORMALIZED_ENVIRONMENT],
        migrationCompleted: true,
        beforeEnvironmentSecretDelete: () =>
          Deferred.succeed(deleteStarted, undefined).pipe(
            Effect.andThen(Deferred.await(continueDelete)),
          ),
      });
      yield* Ref.set(
        harness.storedEnvironmentSecrets,
        new Map([[NORMALIZED_ROUTE_SECRET_REF, "protected-session-value"]]),
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          NORMALIZED_ENVIRONMENT_ID,
          (state) => state.phase === "connected",
        );

        const forgetting = yield* registry
          .forget(NORMALIZED_ENVIRONMENT_ID)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(deleteStarted);
        yield* registry.registerEnvironment({ environment: MULTI_ROUTE_NORMALIZED_ENVIRONMENT });
        yield* Deferred.succeed(continueDelete, undefined);
        yield* Fiber.join(forgetting);

        expect(yield* Ref.get(harness.lifecycleEvents)).toEqual([
          "close-admission",
          "cancel-supervisor",
          "await-scope",
          "delete-secrets",
          "clear-cache",
          "clear-ui",
          "delete-routes",
          "delete-environment",
        ]);
        expect((yield* Ref.get(harness.storedEnvironments)).has(NORMALIZED_ENVIRONMENT_ID)).toBe(
          false,
        );
        expect(yield* Ref.get(harness.cleanupRepairs)).toEqual(new Map());

        yield* registry.registerEnvironment({
          environment: MULTI_ROUTE_NORMALIZED_ENVIRONMENT,
          sessionSecret: {
            routeId: "normalized-loopback",
            value: "new-authoritative-session",
          },
        });
        expect((yield* Ref.get(harness.storedEnvironments)).has(NORMALIZED_ENVIRONMENT_ID)).toBe(
          true,
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps a redacted repair receipt and closed admission when secret deletion fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], {
        initialEnvironments: [MULTI_ROUTE_NORMALIZED_ENVIRONMENT],
        migrationCompleted: true,
        beforeEnvironmentSecretDelete: () =>
          Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "delete-environment-secret",
              message: "Protected secret cleanup failed.",
            }),
          ),
      });
      yield* Ref.set(
        harness.storedEnvironmentSecrets,
        new Map([[NORMALIZED_ROUTE_SECRET_REF, "must-not-appear"]]),
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          NORMALIZED_ENVIRONMENT_ID,
          (state) => state.phase === "connected",
        );

        const error = yield* registry.forget(NORMALIZED_ENVIRONMENT_ID).pipe(Effect.flip);

        expect(error).toMatchObject({ operation: "delete-environment-secret" });
        expect((yield* Ref.get(harness.storedEnvironments)).has(NORMALIZED_ENVIRONMENT_ID)).toBe(
          true,
        );
        expect([...(yield* Ref.get(harness.cleanupRepairs)).values()]).toEqual([
          {
            schemaVersion: 1,
            environmentId: NORMALIZED_ENVIRONMENT_ID,
            generation: expect.any(Number),
            phase: "secret-deletion-failed",
          },
        ]);
        expect(yield* Effect.flip(registry.state(NORMALIZED_ENVIRONMENT_ID))).toMatchObject({
          _tag: "EnvironmentNotRegisteredError",
        });
        expect([...(yield* Ref.get(harness.cleanupRepairs)).values()][0]).not.toHaveProperty(
          "secret",
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps restart admission closed while a cleanup repair receipt exists", () =>
    Effect.gen(function* () {
      const repair = {
        schemaVersion: 1,
        environmentId: NORMALIZED_ENVIRONMENT_ID,
        generation: 7,
        phase: "metadata-deletion-failed",
      } as const;
      const harness = yield* makeHarness([], [], [], {
        initialEnvironments: [NORMALIZED_ENVIRONMENT],
        initialCleanupRepairs: [repair],
        migrationCompleted: true,
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        for (let iteration = 0; iteration < 20; iteration += 1) yield* Effect.yieldNow;

        expect(yield* Ref.get(harness.sessions)).toEqual([]);
        expect(yield* Effect.flip(registry.state(NORMALIZED_ENVIRONMENT_ID))).toMatchObject({
          _tag: "EnvironmentNotRegisteredError",
        });

        yield* registry.forget(NORMALIZED_ENVIRONMENT_ID);
        expect((yield* Ref.get(harness.storedEnvironments)).has(NORMALIZED_ENVIRONMENT_ID)).toBe(
          false,
        );
        expect(yield* Ref.get(harness.cleanupRepairs)).toEqual(new Map());
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("stores enrollment secrets before publishing a normalized environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], { migrationCompleted: true });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerEnvironment({
          environment: NORMALIZED_ENVIRONMENT,
          sessionSecret: {
            routeId: "normalized-loopback",
            value: "protected-session-value",
          },
        });

        const stored = (yield* Ref.get(harness.storedEnvironments)).get(NORMALIZED_ENVIRONMENT_ID);
        const secretRef = stored?.routes[0]?.secretRef;
        expect(secretRef).toMatch(/^bibcode-secret:/u);
        expect((yield* Ref.get(harness.storedEnvironmentSecrets)).get(secretRef!)).toBe(
          "protected-session-value",
        );
        expect(
          (yield* SubscriptionRef.get(registry.environments)).get(NORMALIZED_ENVIRONMENT_ID),
        ).toEqual(stored);

        yield* registry.remove(NORMALIZED_ENVIRONMENT_ID);
        expect((yield* Ref.get(harness.storedEnvironments)).has(NORMALIZED_ENVIRONMENT_ID)).toBe(
          false,
        );
        expect((yield* Ref.get(harness.storedEnvironmentSecrets)).size).toBe(0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("reconciles descriptor-backed platform registrations into normalized storage", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], [], [], { migrationCompleted: true });
      const target = new PrimaryConnectionTarget({
        environmentId: NORMALIZED_ENVIRONMENT_ID,
        label: "Local BiBCode",
        httpBaseUrl: "http://127.0.0.1:48291",
        wsBaseUrl: "ws://127.0.0.1:48291",
      });
      const descriptor = {
        ...PREPARED.descriptor,
        environmentId: NORMALIZED_ENVIRONMENT_ID,
        label: target.label,
        storageInstanceId: NORMALIZED_ENVIRONMENT.acceptedStorageInstanceId,
      };

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target, descriptor }));

        const stored = (yield* Ref.get(harness.storedEnvironments)).get(NORMALIZED_ENVIRONMENT_ID);
        expect(stored).toMatchObject({
          acceptedStorageInstanceId: NORMALIZED_ENVIRONMENT.acceptedStorageInstanceId,
          routes: [{ _tag: "DesktopLoopbackRoute", routeId: "platform:primary" }],
        });
        expect(
          (yield* SubscriptionRef.get(registry.environments)).get(NORMALIZED_ENVIRONMENT_ID),
        ).toEqual(stored);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("hydrates connection profiles into catalog entries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          SSH_CONNECTION.environmentId,
        );

        expect(entry?.target).toEqual(SSH_CONNECTION);
        expect(Option.getOrThrow(entry?.profile ?? Option.none())).toEqual(SSH_PROFILE);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("publishes network status changes independently of connection state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const offline = yield* Effect.forkChild(
          SubscriptionRef.changes(registry.networkStatus).pipe(
            Stream.filter((status) => status === "offline"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        );

        yield* SubscriptionRef.set(harness.networkStatus, "offline");

        expect(yield* Fiber.join(offline)).toBe("offline");
        expect(yield* SubscriptionRef.get(registry.networkStatus)).toBe("offline");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts persisted environments independently", () =>
    Effect.gen(function* () {
      const bothLoadsStarted = yield* Deferred.make<void>();
      const releaseLoads = yield* Deferred.make<void>();
      const loadCount = yield* Ref.make(0);
      const harness = yield* makeHarness([TARGET, SECOND_TARGET], [], [], {
        beforeSessionConnect: () =>
          Ref.updateAndGet(loadCount, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(bothLoadsStarted, undefined) : Effect.void,
            ),
            Effect.andThen(Deferred.await(releaseLoads)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const start = yield* Effect.forkChild(registry.start);

        yield* Deferred.await(bothLoadsStarted).pipe(Effect.timeout("1 second"));
        yield* Deferred.succeed(releaseLoads, undefined);
        yield* Fiber.join(start);

        expect(yield* Ref.get(loadCount)).toBe(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("bounds simultaneous environment establishment without serializing live sessions", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const startedCount = yield* Ref.make(0);
      const activeCount = yield* Ref.make(0);
      const maxActiveCount = yield* Ref.make(0);
      const harness = yield* makeHarness([TARGET, SECOND_TARGET], [], [], {
        maxConcurrentEnvironmentAttempts: 1,
        beforeSessionConnect: () =>
          Effect.gen(function* () {
            const started = yield* Ref.updateAndGet(startedCount, (count) => count + 1);
            const active = yield* Ref.updateAndGet(activeCount, (count) => count + 1);
            yield* Ref.update(maxActiveCount, (current) => Math.max(current, active));
            yield* Deferred.succeed(started === 1 ? firstStarted : secondStarted, undefined);
            if (started === 1) {
              yield* Deferred.await(releaseFirst);
            }
          }).pipe(Effect.ensuring(Ref.update(activeCount, (count) => count - 1))),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* Deferred.await(firstStarted).pipe(Effect.timeout("1 second"));
        for (let iteration = 0; iteration < 20; iteration += 1) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(startedCount)).toBe(1);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted).pipe(Effect.timeout("1 second"));
        expect(yield* Ref.get(maxActiveCount)).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("exposes the current RPC generation to late query subscribers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const generation = yield* registry
          .runStream(
            TARGET.environmentId,
            Stream.unwrap(
              EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                Effect.map((supervisor) =>
                  Stream.concat(
                    Stream.fromEffect(SubscriptionRef.get(supervisor.state)),
                    SubscriptionRef.changes(supervisor.state),
                  ).pipe(
                    Stream.filterMap((state) =>
                      state.phase === "connected"
                        ? Result.succeed(state.generation)
                        : Result.failVoid,
                    ),
                    Stream.changes,
                  ),
                ),
              ),
            ),
          )
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));

        expect(generation).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("preserves cached data on connection failure and clears it on explicit removal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        const controls = yield* Ref.get(harness.sessions);
        expect(controls).toHaveLength(1);
        const active = controls[0];
        expect(active).toBeDefined();
        expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );

        const retryFiber = yield* Effect.forkChild(
          awaitConnectionState(
            registry,
            TARGET.environmentId,
            (state) => state.phase === "backoff",
          ),
        );
        yield* Effect.yieldNow;
        yield* Deferred.fail(
          active!.closed,
          new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
          }),
        );
        yield* Fiber.join(retryFiber);
        expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );

        yield* registry.remove(TARGET.environmentId);
        expect((yield* Ref.get(harness.storedTargets)).has(TARGET.environmentId)).toBe(false);
        expect((yield* Ref.get(harness.shellCache)).has(TARGET.environmentId)).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([TARGET.environmentId]);
        expect((yield* SubscriptionRef.get(registry.entries)).has(TARGET.environmentId)).toBe(
          false,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("persists and starts a newly registered environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(new RelayConnectionRegistration({ target: RELAY_TARGET }));
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect((yield* Ref.get(harness.storedTargets)).get(RELAY_TARGET.environmentId)).toEqual(
          RELAY_TARGET,
        );
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("moves durable streams to a replacement supervisor", () =>
    Effect.gen(function* () {
      const replacement = new RelayConnectionTarget({
        environmentId: RELAY_TARGET.environmentId,
        label: "Replacement relay environment",
      });
      const harness = yield* makeHarness([RELAY_TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const firstObserved = yield* Deferred.make<void>();
        const secondObserved = yield* Deferred.make<void>();
        const labels = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const subscription = yield* Effect.forkChild(
          registry
            .followStream(
              RELAY_TARGET.environmentId,
              Stream.unwrap(
                EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                  Effect.map((supervisor) =>
                    Stream.concat(Stream.succeed(supervisor.target.label), Stream.never),
                  ),
                ),
              ),
            )
            .pipe(
              Stream.tap((label) =>
                Ref.updateAndGet(labels, (current) => [...current, label]).pipe(
                  Effect.flatMap((current) =>
                    current.length === 1
                      ? Deferred.succeed(firstObserved, undefined)
                      : Deferred.succeed(secondObserved, undefined),
                  ),
                ),
              ),
              Stream.runDrain,
            ),
        );

        yield* Deferred.await(firstObserved).pipe(Effect.timeout("1 second"));
        yield* registry.register(new RelayConnectionRegistration({ target: replacement }));
        yield* Deferred.await(secondObserved).pipe(Effect.timeout("1 second"));
        yield* Fiber.interrupt(subscription);

        expect(yield* Ref.get(labels)).toEqual([RELAY_TARGET.label, replacement.label]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("ignores retry signals for environments that are no longer registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.retryNow(EnvironmentId.make("removed-environment"));
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("adopts the current structured storage change and retries exactly once", () =>
    Effect.gen(function* () {
      const connectionAttempts = yield* Ref.make(0);
      const adoptionOrder = yield* Ref.make<ReadonlyArray<string>>([]);
      const firstAttemptStarted = yield* Deferred.make<void>();
      const releaseFirstAttempt = yield* Deferred.make<void>();
      const harness = yield* makeHarness([TARGET], [], [], {
        beforeSessionConnect: () =>
          Ref.updateAndGet(connectionAttempts, (count) => count + 1).pipe(
            Effect.tap((attempt) =>
              Ref.update(adoptionOrder, (current) => [...current, `attempt:${attempt}`]),
            ),
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Deferred.succeed(firstAttemptStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstAttempt)),
                    Effect.andThen(
                      Effect.fail(
                        new ConnectionStorageChangedError({
                          reason: "storage-changed",
                          detail: "The environment reported a different persistent store.",
                          targetKey: "structured:error-target",
                          acceptedStorageInstanceId: "store-a",
                          reportedStorageInstanceId: "store-b",
                        }),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
        afterStorageIdentityAccept: (identity) =>
          Ref.update(adoptionOrder, (current) => [
            ...current,
            `accept:${identity.targetKey}:${identity.storageInstanceId}`,
          ]),
      });
      yield* Ref.set(
        harness.acceptedStorageIdentities,
        new Map([["structured:error-target", "store-a"]]),
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* Deferred.await(firstAttemptStarted);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseFirstAttempt, undefined);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "blocked",
        );

        yield* registry.acceptStorageIdentity(TARGET.environmentId);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect(yield* Ref.get(harness.acceptedStorageIdentityWrites)).toEqual([
          {
            targetKey: "structured:error-target",
            storageInstanceId: "store-b",
          },
        ]);
        expect(yield* Ref.get(connectionAttempts)).toBe(2);
        expect(yield* Ref.get(adoptionOrder)).toEqual([
          "attempt:1",
          "accept:structured:error-target:store-b",
          "attempt:2",
        ]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("rejects stale storage adoption without overwriting a newer accepted identity", () =>
    Effect.gen(function* () {
      const connectionAttempts = yield* Ref.make(0);
      const firstAttemptStarted = yield* Deferred.make<void>();
      const releaseFirstAttempt = yield* Deferred.make<void>();
      const storageChanged = () =>
        new ConnectionStorageChangedError({
          reason: "storage-changed",
          detail: "The environment reported a different persistent store.",
          targetKey: "structured:error-target",
          acceptedStorageInstanceId: "store-a",
          reportedStorageInstanceId: "store-b",
        });
      const harness = yield* makeHarness([TARGET], [], [], {
        beforeSessionConnect: () =>
          Ref.updateAndGet(connectionAttempts, (count) => count + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Deferred.succeed(firstAttemptStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstAttempt)),
                    Effect.andThen(Effect.fail(storageChanged())),
                  )
                : Effect.fail(storageChanged()),
            ),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* Deferred.await(firstAttemptStarted);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseFirstAttempt, undefined);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "blocked",
        );
        yield* Ref.update(harness.acceptedStorageIdentities, (current) => {
          const next = new Map(current);
          next.set("structured:error-target", "store-c");
          return next;
        });

        const result = yield* Effect.result(registry.acceptStorageIdentity(TARGET.environmentId));

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            _tag: "ConnectionPersistenceError",
            operation: "accept-storage-identity",
          });
        }
        expect(yield* Ref.get(harness.acceptedStorageIdentities)).toEqual(
          new Map([["structured:error-target", "store-c"]]),
        );
        expect(yield* Ref.get(harness.acceptedStorageIdentityWrites)).toEqual([]);
        expect(yield* Ref.get(connectionAttempts)).toBe(1);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("refuses storage adoption unless the environment is currently storage-blocked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const error = yield* Effect.flip(registry.acceptStorageIdentity(TARGET.environmentId));

        expect(error).toMatchObject({
          _tag: "ConnectionPersistenceError",
          operation: "accept-storage-identity",
        });
        expect(yield* Ref.get(harness.acceptedStorageIdentityWrites)).toEqual([]);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not start an unsupervised environment to evaluate storage adoption", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;

        const error = yield* Effect.flip(registry.acceptStorageIdentity(TARGET.environmentId));
        for (let iteration = 0; iteration < 100; iteration += 1) {
          yield* Effect.yieldNow;
        }

        expect(error).toMatchObject({
          _tag: "ConnectionPersistenceError",
          operation: "accept-storage-identity",
        });
        expect(yield* Ref.get(harness.sessions)).toEqual([]);
        expect(yield* Ref.get(harness.acceptedStorageIdentityWrites)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("removes all relay-owned data without touching non-cloud connections", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [RELAY_TARGET, SECOND_RELAY_TARGET, BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRelayEnvironments();

        const targets = yield* Ref.get(harness.storedTargets);
        expect(targets.has(RELAY_TARGET.environmentId)).toBe(false);
        expect(targets.has(SECOND_RELAY_TARGET.environmentId)).toBe(false);
        expect(targets.get(BEARER_TARGET.environmentId)).toEqual(BEARER_TARGET);
        expect(yield* Ref.get(harness.cacheClears)).toEqual(
          expect.arrayContaining([RELAY_TARGET.environmentId, SECOND_RELAY_TARGET.environmentId]),
        );
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual(
          expect.arrayContaining([RELAY_TARGET.environmentId, SECOND_RELAY_TARGET.environmentId]),
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).has(BEARER_TARGET.environmentId),
        ).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps the runtime registered when durable removal fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET], [], [], {
        beforeRegistrationRemove: () =>
          Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "remove-connection",
              message: "Storage is unavailable.",
            }),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          RELAY_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const error = yield* Effect.flip(registry.removeRelayEnvironments());

        expect(error._tag).toBe("ConnectionPersistenceError");
        expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
        expect((yield* SubscriptionRef.get(registry.entries)).has(RELAY_TARGET.environmentId)).toBe(
          true,
        );
        expect((yield* Ref.get(harness.storedTargets)).has(RELAY_TARGET.environmentId)).toBe(true);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
        expect(yield* Ref.get(harness.ownedDataClears)).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts a newly paired bearer environment without re-reading its profile", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(
          new BearerConnectionRegistration({
            target: BEARER_TARGET,
            profile: BEARER_PROFILE,
            credential: BEARER_CREDENTIAL,
          }),
        );
        yield* awaitConnectionState(
          registry,
          BEARER_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect(yield* Ref.get(harness.profileReadCount)).toBe(0);
        expect(
          Option.getOrThrow(
            (yield* SubscriptionRef.get(registry.entries)).get(BEARER_TARGET.environmentId)
              ?.profile ?? Option.none(),
          ),
        ).toEqual(BEARER_PROFILE);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts platform environments without persisting or removing them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }));
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        expect((yield* Ref.get(harness.storedTargets)).has(TARGET.environmentId)).toBe(false);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);

        const error = yield* Effect.flip(registry.remove(TARGET.environmentId));
        expect(error._tag).toBe("PlatformEnvironmentRemovalError");
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("gives a primary platform registration precedence over persisted registrations", () =>
    Effect.gen(function* () {
      const shadowedTarget = new RelayConnectionTarget({
        environmentId: TARGET.environmentId,
        label: "Shadowed relay environment",
      });
      const harness = yield* makeHarness([shadowedTarget]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }));

        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
        expect((yield* Ref.get(harness.storedTargets)).has(TARGET.environmentId)).toBe(false);

        yield* registry.register(new RelayConnectionRegistration({ target: shadowedTarget }));

        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
        expect((yield* Ref.get(harness.storedTargets)).has(TARGET.environmentId)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("rechecks platform ownership after waiting for the environment lease", () =>
    Effect.gen(function* () {
      const registrationStarted = yield* Deferred.make<void>();
      const continueRegistration = yield* Deferred.make<void>();
      const shadowedTarget = new RelayConnectionTarget({
        environmentId: TARGET.environmentId,
        label: "Shadowed relay environment",
      });
      const harness = yield* makeHarness([], [], [], {
        beforeRegistrationRegister: () =>
          Deferred.succeed(registrationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(continueRegistration)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const persistedRegistration = yield* registry
          .register(new RelayConnectionRegistration({ target: shadowedTarget }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(registrationStarted);

        const platformRegistration = yield* registry
          .registerPlatform(new PrimaryConnectionRegistration({ target: TARGET }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        const removal = yield* Effect.flip(registry.remove(TARGET.environmentId)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Deferred.succeed(continueRegistration, undefined);
        yield* Fiber.join(persistedRegistration);
        yield* Fiber.join(platformRegistration);
        const error = yield* Fiber.join(removal);

        expect(error._tag).toBe("PlatformEnvironmentRemovalError");
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
        ).toEqual(TARGET);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not reacquire a runtime while its registration is being removed", () =>
    Effect.gen(function* () {
      const removalStarted = yield* Deferred.make<void>();
      const continueRemoval = yield* Deferred.make<void>();
      const harness = yield* makeHarness([TARGET], [], [], {
        beforeRegistrationRemove: () =>
          Deferred.succeed(removalStarted, undefined).pipe(
            Effect.andThen(Deferred.await(continueRemoval)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const removal = yield* Effect.forkChild(registry.remove(TARGET.environmentId));
        yield* Deferred.await(removalStarted);

        const stateLookup = yield* Effect.forkChild(
          Effect.flip(registry.state(TARGET.environmentId)),
        );
        yield* Effect.yieldNow;
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);

        yield* Deferred.succeed(continueRemoval, undefined);
        yield* Fiber.join(removal);
        const error = yield* Fiber.join(stateLookup);
        expect(error._tag).toBe("EnvironmentNotRegisteredError");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("retains a healthy runtime when the platform repeats an identical registration", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const registration = new PrimaryConnectionRegistration({ target: TARGET });
        yield* registry.registerPlatform(registration);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        yield* registry.registerPlatform(registration);

        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect(
    "retains shell and thread caches for a desired unavailable platform environment until disable",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          [],
          [],
          [
            [
              "local:wsl:Ubuntu",
              new BearerConnectionCredential({ token: "previous-live-session-token" }),
            ],
          ],
        );
        const unavailableTarget = new UnavailableConnectionTarget({
          environmentId: TARGET.environmentId,
          label: "WSL (Ubuntu)",
          connectionId: "local:wsl:Ubuntu",
          configuredDistro: "Ubuntu",
          detail: "the configured WSL distribution could not start",
        });
        const unavailableRegistration = new UnavailableConnectionRegistration({
          target: unavailableTarget,
        });

        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;

          yield* registry.reconcilePlatform([unavailableRegistration]);
          yield* awaitConnectionState(
            registry,
            TARGET.environmentId,
            (state) => state.phase === "backoff",
          );

          expect(
            (yield* SubscriptionRef.get(registry.entries)).get(TARGET.environmentId)?.target,
          ).toEqual(unavailableTarget);
          expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
            CACHED_SNAPSHOT,
          );
          expect(
            (yield* Ref.get(harness.threadCache)).get(TARGET.environmentId)?.get(CACHED_THREAD.id),
          ).toEqual(CACHED_THREAD);
          expect(yield* Ref.get(harness.cacheClears)).toEqual([]);
          expect((yield* Ref.get(harness.storedCredentials)).has("local:wsl:Ubuntu")).toBe(false);

          yield* registry.reconcilePlatform([]);
          expect((yield* Ref.get(harness.shellCache)).has(TARGET.environmentId)).toBe(false);
          expect((yield* Ref.get(harness.threadCache)).has(TARGET.environmentId)).toBe(false);
          expect(yield* Ref.get(harness.cacheClears)).toEqual([TARGET.environmentId]);

          yield* registry.reconcilePlatform([]);
          expect(yield* Ref.get(harness.cacheClears)).toEqual([TARGET.environmentId]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );

  it.effect("removes all owned SSH state only on explicit removal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [SSH_CONNECTION],
        [SSH_PROFILE],
        [
          [
            SSH_CONNECTION.connectionId,
            new BearerConnectionCredential({ token: "temporary-token" }),
          ],
        ],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.remove(SSH_CONNECTION.environmentId);

        expect((yield* Ref.get(harness.storedProfiles)).has(SSH_CONNECTION.connectionId)).toBe(
          false,
        );
        expect((yield* Ref.get(harness.storedCredentials)).has(SSH_CONNECTION.connectionId)).toBe(
          false,
        );
        expect((yield* Ref.get(harness.storedRemoteTokens)).has(SSH_CONNECTION.environmentId)).toBe(
          false,
        );
        expect(yield* Ref.get(harness.disconnectedSshTargets)).toEqual([SSH_TARGET]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
