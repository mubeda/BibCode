import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import * as Persistence from "../platform/persistence.ts";
import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type KnownEnvironment,
  SshConnectionProfile,
} from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  EnvironmentRoute,
  PreparedConnection,
} from "./model.ts";
import { BearerConnectionTarget, PrimaryConnectionTarget, SshConnectionTarget } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as RpcSession from "../rpc/session.ts";
import { verifyPreparedStorageIdentity } from "./storageIdentity.ts";
import { deriveWsBaseUrl } from "../environment/endpoint.ts";

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

export interface EnvironmentRouteConnectionAttempt {
  readonly environment: KnownEnvironment;
  readonly route: EnvironmentRoute;
  readonly environmentGeneration: number;
  readonly routeGeneration: number;
  /** Aborted whenever retry, disconnect, Forget, or scope closure supersedes this attempt. */
  readonly cancellation: AbortSignal;
}

export type ConnectionDriverInput = ConnectionCatalogEntry | EnvironmentRouteConnectionAttempt;

function isRouteAttempt(input: ConnectionDriverInput): input is EnvironmentRouteConnectionAttempt {
  return "route" in input;
}

function legacyEntryForRoute(attempt: EnvironmentRouteConnectionAttempt): ConnectionCatalogEntry {
  const route = attempt.route;
  const label = route.label;
  switch (route._tag) {
    case "DesktopLoopbackRoute":
      if (route.secretRef === null) {
        return {
          target: new PrimaryConnectionTarget({
            environmentId: route.environmentId,
            label,
            httpBaseUrl: route.httpBaseUrl,
            wsBaseUrl: route.wsBaseUrl,
          }),
          profile: Option.none(),
        };
      }
      return {
        target: new BearerConnectionTarget({
          environmentId: route.environmentId,
          label,
          connectionId: route.routeId,
        }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: route.routeId,
            environmentId: route.environmentId,
            label,
            httpBaseUrl: route.httpBaseUrl,
            wsBaseUrl: route.wsBaseUrl,
          }),
        ),
      };
    case "DesktopWslRoute":
      return {
        target: new BearerConnectionTarget({
          environmentId: route.environmentId,
          label,
          connectionId: route.routeId,
        }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: route.routeId,
            environmentId: route.environmentId,
            label,
            httpBaseUrl: route.httpBaseUrl,
            wsBaseUrl: route.wsBaseUrl,
          }),
        ),
      };
    case "DirectHttpsRoute":
      return {
        target: new BearerConnectionTarget({
          environmentId: route.environmentId,
          label,
          connectionId: route.routeId,
        }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: route.routeId,
            environmentId: route.environmentId,
            label,
            httpBaseUrl: route.httpsBaseUrl,
            wsBaseUrl: deriveWsBaseUrl(route.httpsBaseUrl),
          }),
        ),
      };
    case "SshTunnelRoute":
      return {
        target: new SshConnectionTarget({
          environmentId: route.environmentId,
          label,
          connectionId: route.routeId,
        }),
        profile: Option.some(
          new SshConnectionProfile({
            connectionId: route.routeId,
            environmentId: route.environmentId,
            label,
            target: route.target,
          }),
        ),
      };
  }
}

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      input: ConnectionDriverInput,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
  }
>()("@bibcode/client-runtime/connection/driver/ConnectionDriver") {}

export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const identities = yield* Persistence.AcceptedStorageIdentityStore;

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    input: ConnectionDriverInput,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const entry = isRouteAttempt(input) ? legacyEntryForRoute(input) : input;
    const target = entry.target;
    if (isRouteAttempt(input)) {
      if (input.cancellation.aborted) {
        return yield* Effect.interrupt;
      }
      yield* Effect.annotateCurrentSpan({
        "connection.environment.generation": input.environmentGeneration,
        "connection.route.generation": input.routeGeneration,
        "connection.route.id": input.route.routeId,
        "connection.route.kind": input.route._tag,
      });
    }
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    yield* reportProgress({ stage: "preparing" });
    const prepared = yield* isRouteAttempt(input)
      ? resolver.prepareRoute(input)
      : resolver.prepare(entry);
    yield* verifyPreparedStorageIdentity(prepared).pipe(
      Effect.provideService(Persistence.AcceptedStorageIdentityStore, identities),
    );
    yield* reportProgress({ stage: "opening", prepared });
    const session = yield* sessions.connect(prepared);
    yield* session.ready;
    const initialConfig = yield* session.initialConfig;
    yield* verifyPreparedStorageIdentity(prepared, initialConfig.environment).pipe(
      Effect.provideService(Persistence.AcceptedStorageIdentityStore, identities),
    );
    yield* reportProgress({ stage: "synchronizing", prepared });
    return { prepared, session } satisfies EnvironmentConnectionLease;
  });

  return ConnectionDriver.of({ connect });
});

export const layer = Layer.effect(ConnectionDriver, make);
