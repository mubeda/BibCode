import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
} from "@bibcode/contracts";
import { resolveRemotePairingTarget } from "@bibcode/shared/remote";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
  type KnownEnvironment,
} from "./catalog.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  DesktopLoopbackRoute,
  DirectHttpsRoute,
  isLoopbackHostname,
  SshTunnelRoute,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@bibcode/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

interface PreparedPairingEnrollment {
  readonly registration: BearerConnectionRegistration;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

const preparePairingEnrollment = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingEnrollment",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const endpoint = new URL(target.httpBaseUrl);
  if (endpoint.protocol !== "https:" && !isLoopbackHostname(endpoint.hostname)) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Remote environments require HTTPS; plaintext HTTP is allowed only on loopback.",
    });
  }
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    scopes: presentation.scopes,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const connectionId = `bearer:${descriptor.environmentId}`;

  const registration = new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({
      token: access.access_token,
    }),
  });
  return { registration, descriptor } satisfies PreparedPairingEnrollment;
});

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  return (yield* preparePairingEnrollment(input)).registration;
});

function pairingEnvironment(enrollment: PreparedPairingEnrollment): KnownEnvironment {
  const { descriptor, registration } = enrollment;
  const endpoint = new URL(registration.profile.httpBaseUrl);
  const routeBase = {
    routeId: registration.target.connectionId,
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    priority: 0,
    pinned: false,
    autoconnect: true,
    secretRef: null,
  } as const;
  const route = isLoopbackHostname(endpoint.hostname)
    ? new DesktopLoopbackRoute({
        ...routeBase,
        httpBaseUrl: registration.profile.httpBaseUrl,
        wsBaseUrl: registration.profile.wsBaseUrl,
      })
    : new DirectHttpsRoute({
        ...routeBase,
        httpsBaseUrl: registration.profile.httpBaseUrl,
        trust: { _tag: "System" },
      });
  return {
    environmentId: descriptor.environmentId,
    acceptedStorageInstanceId: descriptor.storageInstanceId,
    descriptor,
    alias: descriptor.label,
    hidden: false,
    bindings: [],
    routes: [route],
  };
}

export const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const enrollment = yield* preparePairingEnrollment(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.registerEnvironment({
    environment: pairingEnvironment(enrollment),
    sessionSecret: {
      routeId: enrollment.registration.target.connectionId,
      value: enrollment.registration.credential.token,
    },
  });
  return enrollment.registration.target.environmentId;
});

const isBearerCredential = Schema.is(BearerConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);

export const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const environment = (yield* SubscriptionRef.get(registry.environments)).get(input.environmentId);
  if (environment === undefined) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "The environment is not registered.",
    });
  }
  const route = environment.routes.find((candidate) => candidate._tag === "DirectHttpsRoute");
  if (route === undefined || route._tag !== "DirectHttpsRoute") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only direct HTTPS routes can be edited from this connection form.",
    });
  }
  const label = input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpsBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  if (new URL(httpsBaseUrl).protocol !== "https:") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Direct environments require HTTPS; no insecure HTTP override is available.",
    });
  }
  yield* registry.registerEnvironment({
    environment: {
      ...environment,
      alias: label,
      routes: environment.routes.map((candidate) =>
        candidate.routeId === route.routeId
          ? new DirectHttpsRoute({
              ...route,
              label,
              httpsBaseUrl,
            })
          : candidate,
      ),
    },
  });
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
    credential: credential.value,
  });
});

interface PreparedSshEnrollment {
  readonly registration: SshConnectionRegistration;
  readonly environment: KnownEnvironment;
  readonly sessionSecret: string;
}

const prepareSshEnrollment = Effect.fn("clientRuntime.connection.onboarding.prepareSshEnrollment")(
  function* (input: SshConnectionInput) {
    const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
    const provisioned = yield* gateway.provision(input.target);
    const connectionId = `ssh:${provisioned.environmentId}`;
    const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

    const registration = new SshConnectionRegistration({
      target: new SshConnectionTarget({
        environmentId: provisioned.environmentId,
        label,
        connectionId,
      }),
      profile: new SshConnectionProfile({
        connectionId,
        environmentId: provisioned.environmentId,
        label,
        target: provisioned.bootstrap.target,
      }),
    });
    return {
      registration,
      environment: {
        environmentId: provisioned.descriptor.environmentId,
        acceptedStorageInstanceId: provisioned.descriptor.storageInstanceId,
        descriptor: provisioned.descriptor,
        alias: label,
        hidden: false,
        bindings: [],
        routes: [
          new SshTunnelRoute({
            routeId: connectionId,
            environmentId: provisioned.descriptor.environmentId,
            label,
            priority: 0,
            pinned: false,
            autoconnect: true,
            secretRef: null,
            target: provisioned.bootstrap.target,
            hostKeyFingerprint: null,
          }),
        ],
      },
      sessionSecret: provisioned.bearerToken,
    } satisfies PreparedSshEnrollment;
  },
);

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  return (yield* prepareSshEnrollment(input)).registration;
});

export const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const enrollment = yield* prepareSshEnrollment(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.registerEnvironment({
    environment: enrollment.environment,
    sessionSecret: {
      routeId: enrollment.registration.target.connectionId,
      value: enrollment.sessionSecret,
    },
  });
  return enrollment.registration.target.environmentId;
});

export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;

  return ConnectionOnboarding.of({
    registerPairing: (input) =>
      registerPairingConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    registerSsh: (input) =>
      registerSshConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    updateBearer: (input) =>
      updateBearerConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
