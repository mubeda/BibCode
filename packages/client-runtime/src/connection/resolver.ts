import type { ExecutionEnvironmentDescriptor } from "@bibcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type KnownEnvironment,
  SshConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapRemoteEnvironmentError,
  profileMissingError,
} from "./errors.ts";
import type {
  ConnectionTarget,
  DirectHttpsRoute,
  EnvironmentRoute,
  PreparedConnection,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  VerifiedRouteIdentity,
} from "./model.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  isLoopbackHostname,
  PrimaryConnectionTarget as PrimaryConnectionTargetClass,
  SshConnectionTarget as SshConnectionTargetClass,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import { deriveWsBaseUrl } from "../environment/endpoint.ts";
import { verifyRouteIdentity } from "./storageIdentity.ts";

export interface RoutePreparationInput {
  readonly environment: KnownEnvironment;
  readonly route: EnvironmentRoute;
  readonly environmentGeneration?: number;
  readonly routeGeneration?: number;
  readonly cancellation: AbortSignal;
}

export interface RouteTransportSecurityService {
  readonly verifyDirectHttps: (
    route: DirectHttpsRoute,
    cancellation: AbortSignal,
  ) => Effect.Effect<void, ConnectionAttemptError>;
}

export class RouteTransportSecurity extends Context.Reference<RouteTransportSecurityService>(
  "@bibcode/client-runtime/connection/resolver/RouteTransportSecurity",
  {
    defaultValue: () => ({
      verifyDirectHttps: (route, cancellation) => {
        if (cancellation.aborted) {
          return Effect.interrupt;
        }
        if (route.trust._tag === "PinnedSpki") {
          return Effect.fail(
            new ConnectionBlockedError({
              reason: "unsupported",
              detail: "Pinned SPKI verification requires a trusted desktop transport verifier.",
            }),
          );
        }
        return Effect.void;
      },
    }),
  },
) {}

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
    readonly prepareRoute: (
      input: RoutePreparationInput,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@bibcode/client-runtime/connection/resolver/ConnectionResolver") {}

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isSshProfile = Schema.is(SshConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

function primarySocketUrl(target: PrimaryConnectionTarget): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  return url.toString();
}

function isSecureLoopbackPair(httpBaseUrl: string, wsBaseUrl: string): boolean {
  try {
    const http = new URL(httpBaseUrl);
    const socket = new URL(wsBaseUrl);
    return (
      (http.protocol === "http:" || http.protocol === "https:") &&
      (socket.protocol === "ws:" || socket.protocol === "wss:") &&
      isLoopbackHostname(http.hostname) &&
      isLoopbackHostname(socket.hostname) &&
      http.username === "" &&
      http.password === "" &&
      socket.username === "" &&
      socket.password === ""
    );
  } catch {
    return false;
  }
}

function routeTarget(route: EnvironmentRoute): ConnectionTarget {
  switch (route._tag) {
    case "DesktopLoopbackRoute":
      if (route.secretRef === null) {
        return new PrimaryConnectionTargetClass({
          environmentId: route.environmentId,
          label: route.label,
          httpBaseUrl: route.httpBaseUrl,
          wsBaseUrl: route.wsBaseUrl,
        });
      }
      return new BearerConnectionTarget({
        environmentId: route.environmentId,
        label: route.label,
        connectionId: route.routeId,
      });
    case "DesktopWslRoute":
    case "DirectHttpsRoute":
      return new BearerConnectionTarget({
        environmentId: route.environmentId,
        label: route.label,
        connectionId: route.routeId,
      });
    case "SshTunnelRoute":
      return new SshConnectionTargetClass({
        environmentId: route.environmentId,
        label: route.label,
        connectionId: route.routeId,
      });
  }
}

const makePrimaryBroker = Effect.fn("clientRuntime.connection.broker.makePrimary")(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const httpClient = yield* HttpClient.HttpClient;

  return Effect.fn("clientRuntime.connection.broker.primary")(function* (
    target: PrimaryConnectionTarget,
  ) {
    const bearerToken = yield* auth.bearerToken;
    if (Option.isNone(bearerToken)) {
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: target.httpBaseUrl,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (descriptor.environmentId !== target.environmentId) {
        return yield* environmentMismatchError({
          expected: target.environmentId,
          actual: descriptor.environmentId,
        });
      }
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        descriptor,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: primarySocketUrl(target),
        httpAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }

    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      bearerToken: bearerToken.value,
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* () {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.bearer")(function* (
    entry: ConnectionCatalogEntry & { readonly target: BearerConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Option.match(entry.profile, {
      onNone: () => Effect.fail(profileMissingError(target.connectionId)),
      onSome: Effect.succeed,
    });
    if (!isBearerProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not a bearer connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    const credential = yield* credentials.get(target.connectionId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(credentialMissingError(target.connectionId)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!isBearerCredential(credential)) {
      return yield* credentialMissingError(target.connectionId);
    }
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: profile.httpBaseUrl,
      wsBaseUrl: profile.wsBaseUrl,
      bearerToken: credential.token,
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      descriptor: authorized.descriptor,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

const makeSshBroker = Effect.fn("clientRuntime.connection.broker.makeSsh")(() =>
  Effect.succeed(
    Effect.fn("clientRuntime.connection.broker.ssh")(function* (
      entry: ConnectionCatalogEntry & { readonly target: SshConnectionTarget },
    ) {
      const target = entry.target;
      const profile = yield* Option.match(entry.profile, {
        onNone: () => Effect.fail(profileMissingError(target.connectionId)),
        onSome: Effect.succeed,
      });
      if (!isSshProfile(profile)) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: `Connection profile ${target.connectionId} is not an SSH connection.`,
        });
      }
      if (profile.environmentId !== target.environmentId) {
        return yield* environmentMismatchError({
          expected: target.environmentId,
          actual: profile.environmentId,
        });
      }
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `${target.label} is a pre-v3 SSH entry and must be migrated or explicitly re-enrolled before pairing.`,
      });
    }),
  ),
);

export const make = Effect.gen(function* () {
  const primary = yield* makePrimaryBroker();
  const bearer = yield* makeBearerBroker();
  const routeTransportSecurity = yield* RouteTransportSecurity;
  const routeSecrets = yield* Persistence.EnvironmentSecretStore;
  const routePrimaryAuth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const routeSsh = yield* ClientCapabilities.SshEnvironmentGateway;
  const routeAuthorization = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const routeHttpClient = yield* HttpClient.HttpClient;

  const fetchRouteDescriptor = (httpBaseUrl: string, cancellation: AbortSignal) =>
    Effect.gen(function* () {
      if (cancellation.aborted) {
        return yield* Effect.interrupt;
      }
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, routeHttpClient),
      );
      if (cancellation.aborted) {
        return yield* Effect.interrupt;
      }
      return descriptor;
    });

  const loadRouteSecret = Effect.fn("clientRuntime.connection.broker.loadRouteSecret")(function* (
    secretRef: string,
    routeLabel: string,
  ) {
    const secret = yield* routeSecrets.get(secretRef).pipe(
      Effect.mapError(
        () =>
          new ConnectionBlockedError({
            reason: "authentication",
            detail: `${routeLabel} authorization is unavailable from the protected secret store.`,
          }),
      ),
    );
    if (Option.isNone(secret)) {
      return yield* new ConnectionBlockedError({
        reason: "authentication",
        detail: `${routeLabel} requires administrator pairing.`,
      });
    }
    return secret.value;
  });

  const authorizeVerified = Effect.fn("clientRuntime.connection.broker.authorizeVerified")(
    function* (input: {
      readonly identity: VerifiedRouteIdentity;
      readonly route: EnvironmentRoute;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) {
      const authorized = yield* routeAuthorization.authorizeVerifiedBearer({
        identity: input.identity,
        httpBaseUrl: input.httpBaseUrl,
        wsBaseUrl: input.wsBaseUrl,
        bearerToken: input.bearerToken,
      });
      return {
        ...authorized,
        target: routeTarget(input.route),
        route: input.route,
        verifiedRouteIdentity: input.identity,
      } satisfies PreparedConnection;
    },
  );

  const prepareRoute = Effect.fn("clientRuntime.connection.broker.prepareRoute")(function* (
    input: RoutePreparationInput,
  ) {
    const { environment, route, cancellation } = input;
    if (route.environmentId !== environment.environmentId) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `${route.label} does not belong to the selected environment.`,
      });
    }
    if (
      route._tag === "SshTunnelRoute" &&
      (route.hostKeyFingerprint === null || route.secretRef === null)
    ) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `${route.label} must be explicitly re-enrolled before SSH pairing so its host fingerprint and administrator session can be persisted.`,
      });
    }
    if (cancellation.aborted) {
      return yield* Effect.interrupt;
    }

    let descriptor: ExecutionEnvironmentDescriptor;
    let httpBaseUrl: string;
    let wsBaseUrl: string;
    let transportTrust: VerifiedRouteIdentity["transportTrust"];
    let sshBootstrap: ClientCapabilities.InspectedSshEnvironment["bootstrap"] | null = null;

    switch (route._tag) {
      case "DesktopLoopbackRoute":
      case "DesktopWslRoute":
        if (!isSecureLoopbackPair(route.httpBaseUrl, route.wsBaseUrl)) {
          return yield* new ConnectionBlockedError({
            reason: "configuration",
            detail: `${route.label} must use a loopback-only HTTP/WebSocket endpoint.`,
          });
        }
        httpBaseUrl = route.httpBaseUrl;
        wsBaseUrl = route.wsBaseUrl;
        transportTrust = "loopback";
        descriptor = yield* fetchRouteDescriptor(httpBaseUrl, cancellation);
        break;
      case "DirectHttpsRoute":
        yield* routeTransportSecurity.verifyDirectHttps(route, cancellation);
        httpBaseUrl = route.httpsBaseUrl;
        wsBaseUrl = deriveWsBaseUrl(route.httpsBaseUrl);
        transportTrust = route.trust._tag === "PinnedSpki" ? "pinned-spki" : "system-tls";
        descriptor = yield* fetchRouteDescriptor(httpBaseUrl, cancellation);
        break;
      case "SshTunnelRoute": {
        const inspected = yield* routeSsh.inspect({
          target: route.target,
          hostKeyFingerprint: route.hostKeyFingerprint,
          ...(input.environmentGeneration === undefined
            ? {}
            : { environmentGeneration: input.environmentGeneration }),
          ...(input.routeGeneration === undefined
            ? {}
            : { bindingGeneration: input.routeGeneration }),
          cancellation,
        });
        sshBootstrap = inspected.bootstrap;
        httpBaseUrl = inspected.bootstrap.httpBaseUrl;
        wsBaseUrl = inspected.bootstrap.wsBaseUrl;
        transportTrust = "ssh-host-key";
        descriptor = inspected.descriptor;
        break;
      }
    }

    const identity = yield* verifyRouteIdentity({
      environment,
      route,
      descriptor,
      transportTrust,
    });
    if (cancellation.aborted) {
      return yield* Effect.interrupt;
    }

    switch (route._tag) {
      case "DesktopLoopbackRoute": {
        if (route.secretRef !== null) {
          const bearerToken = yield* loadRouteSecret(route.secretRef, route.label);
          return yield* authorizeVerified({
            identity,
            route,
            httpBaseUrl,
            wsBaseUrl,
            bearerToken,
          });
        }
        const bearerToken = yield* routePrimaryAuth.bearerToken;
        if (Option.isSome(bearerToken)) {
          return yield* authorizeVerified({
            identity,
            route,
            httpBaseUrl,
            wsBaseUrl,
            bearerToken: bearerToken.value,
          });
        }
        const target = routeTarget(route);
        if (target._tag !== "PrimaryConnectionTarget") {
          return yield* new ConnectionBlockedError({
            reason: "configuration",
            detail: `${route.label} has an invalid loopback route configuration.`,
          });
        }
        return {
          environmentId: identity.environmentId,
          label: identity.descriptor.label,
          descriptor: identity.descriptor,
          httpBaseUrl,
          socketUrl: primarySocketUrl(target),
          httpAuthorization: null,
          target,
          route,
          verifiedRouteIdentity: identity,
        } satisfies PreparedConnection;
      }
      case "DesktopWslRoute":
      case "DirectHttpsRoute": {
        if (route.secretRef === null) {
          return yield* new ConnectionBlockedError({
            reason: "authentication",
            detail: `${route.label} requires administrator pairing.`,
          });
        }
        const bearerToken = yield* loadRouteSecret(route.secretRef, route.label);
        return yield* authorizeVerified({
          identity,
          route,
          httpBaseUrl,
          wsBaseUrl,
          bearerToken,
        });
      }
      case "SshTunnelRoute": {
        if (sshBootstrap === null) {
          return yield* new ConnectionBlockedError({
            reason: "configuration",
            detail: `${route.label} did not establish an SSH tunnel.`,
          });
        }
        if (route.secretRef === null) {
          return yield* new ConnectionBlockedError({
            reason: "configuration",
            detail: `${route.label} must be explicitly re-enrolled before SSH pairing.`,
          });
        }
        const sessionSecret = yield* loadRouteSecret(route.secretRef, route.label);
        const authorized = yield* routeSsh.authorize({
          bootstrap: sshBootstrap,
          sessionSecret,
          cancellation,
        });
        return {
          environmentId: identity.environmentId,
          label: identity.descriptor.label,
          descriptor: identity.descriptor,
          httpBaseUrl,
          socketUrl: authorized.socketUrl,
          httpAuthorization: { _tag: "NativeDpop" as const },
          target: routeTarget(route),
          route,
          verifiedRouteIdentity: identity,
        } satisfies PreparedConnection;
      }
    }
  });
  const ssh = yield* makeSshBroker();

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target: ConnectionTarget = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    switch (target._tag) {
      case "PrimaryConnectionTarget":
        return yield* primary(target);
      case "BearerConnectionTarget":
        return yield* bearer({ ...entry, target });
      case "SshConnectionTarget":
        return yield* ssh({ ...entry, target });
      case "UnavailableConnectionTarget":
        return yield* new ConnectionTransientError({
          reason: "endpoint-unavailable",
          detail: target.detail,
        });
    }
  });

  return ConnectionResolver.of({ prepare, prepareRoute });
});

export const layer = Layer.effect(ConnectionResolver, make);
