import { type E2eeAuthenticatedMessage, type ServerConfig, WS_METHODS } from "@bibcode/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import { e2eeFailureOf, makeE2eeSocket } from "../e2ee/index.ts";
import type { ConnectionAttemptError, PreparedConnection } from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
  readonly e2eeAuthenticated: Effect.Effect<E2eeAuthenticatedMessage | null>;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@bibcode/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;

function mapInitialConfigError(error: InitialConfigError): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "UpdateMaintenanceActiveError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: error.message,
      });
  }
}

function mapE2eeFailure(error: unknown): ConnectionAttemptError | null {
  const failure = e2eeFailureOf(error);
  if (failure === null) return null;
  switch (failure.reason) {
    case "host-identity-mismatch":
      return new ConnectionBlockedError({
        reason: "host-identity",
        detail: "The remote host identity does not match the saved pairing.",
      });
    case "unauthorized":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail: "The remote environment rejected the saved credential.",
      });
    case "timeout":
      return new ConnectionTransientErrorClass({
        reason: "timeout",
        detail: "The encrypted channel handshake timed out.",
      });
    case "protocol":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: "The encrypted channel protocol failed.",
      });
  }
}

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionAttemptError>();
    const e2eeAuthenticated = yield* Deferred.make<E2eeAuthenticatedMessage | null>();
    const e2eeAttemptFailure = yield* Ref.make<ConnectionAttemptError | null>(null);
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Effect.all({
        wasConnected: Deferred.isDone(connected),
        e2eeFailure: Ref.get(e2eeAttemptFailure),
      }).pipe(
        Effect.flatMap(({ wasConnected, e2eeFailure }) =>
          Deferred.fail(
            disconnected,
            e2eeFailure ??
              new ConnectionTransientErrorClass({
                reason: "transport",
                detail: wasConnected
                  ? `${connection.label} disconnected.`
                  : `${connection.label} could not establish a WebSocket connection.`,
              }),
          ),
        ),
        Effect.asVoid,
      ),
    });
    const socketLayer = Layer.effect(
      Socket.Socket,
      Socket.makeWebSocket(connection.socketUrl, { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
        Effect.map((plainSocket) => {
          if (connection.e2ee === null) return plainSocket;
          const encryptedSocket = makeE2eeSocket(plainSocket, {
            hostKey: connection.e2ee.hostKey,
            auth: connection.e2ee.auth,
            onAuthenticated: (message) => {
              Deferred.doneUnsafe(e2eeAuthenticated, Effect.succeed(message));
            },
          });
          return Socket.make({
            runRaw: (handler, options) =>
              encryptedSocket.runRaw(handler, options).pipe(
                Effect.tapError((error) => {
                  const mapped = mapE2eeFailure(error);
                  return mapped === null ? Effect.void : Ref.set(e2eeAttemptFailure, mapped);
                }),
              ),
            writer: encryptedSocket.writer,
          });
        }),
      ),
    ).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)));
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfig = yield* Effect.cached(
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapInitialConfigError),
        Effect.withSpan("environment.initialSync"),
      ),
    );
    const probe = client[WS_METHODS.serverGetConfig]({}).pipe(
      Effect.mapError(mapInitialConfigError),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client,
      initialConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
      e2eeAuthenticated:
        connection.e2ee === null ? Effect.succeed(null) : Deferred.await(e2eeAuthenticated),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
