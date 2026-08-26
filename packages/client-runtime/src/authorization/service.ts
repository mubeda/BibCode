import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@bibcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { environmentMismatchError, mapRemoteEnvironmentError } from "../connection/errors.ts";
import type {
  ConnectionAttemptError,
  PreparedHttpAuthorization,
  VerifiedRouteIdentity,
} from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { resolveRemoteWebSocketConnectionUrl } from "./remote.ts";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeVerifiedBearer: (input: {
      readonly identity: VerifiedRouteIdentity;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
  }
>()("@bibcode/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) {
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: input.httpBaseUrl,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        descriptor,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  const authorizeVerifiedBearer = Effect.fn(
    "clientRuntime.connection.remote.authorizeVerifiedBearer",
  )(function* (input: {
    readonly identity: VerifiedRouteIdentity;
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly bearerToken: string;
  }) {
    const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
      wsBaseUrl: input.wsBaseUrl,
      httpBaseUrl: input.httpBaseUrl,
      bearerToken: input.bearerToken,
    }).pipe(
      Effect.mapError(mapRemoteEnvironmentError),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return {
      descriptor: input.identity.descriptor,
      environmentId: input.identity.environmentId,
      label: input.identity.descriptor.label,
      httpBaseUrl: input.httpBaseUrl,
      socketUrl,
      httpAuthorization: {
        _tag: "Bearer" as const,
        token: input.bearerToken,
      },
    };
  });

  return RemoteEnvironmentAuthorization.of({ authorizeBearer, authorizeVerifiedBearer });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
