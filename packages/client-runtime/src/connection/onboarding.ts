import {
  ExecutionEnvironmentDescriptor,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
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
import { verifyRouteIdentity } from "./storageIdentity.ts";

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

interface InspectedSshEnrollment {
  readonly registration: SshConnectionRegistration;
  readonly environment: KnownEnvironment;
  readonly inspected: ClientCapabilities.InspectedSshEnvironment;
}

interface ExistingSshTarget {
  readonly environment: KnownEnvironment;
  readonly route: SshTunnelRoute;
}

function sshTargetIdentityKey(target: DesktopSshEnvironmentTarget): string {
  const alias = target.alias.trim();
  const destination = (alias || target.hostname.trim()).toLowerCase();
  return JSON.stringify([destination, target.username?.trim() ?? "", target.port]);
}

function existingSshTargets(
  environments: ReadonlyMap<EnvironmentId, KnownEnvironment>,
  target: DesktopSshEnvironmentTarget,
): ReadonlyArray<ExistingSshTarget> {
  const targetKey = sshTargetIdentityKey(target);
  const matches: ExistingSshTarget[] = [];
  for (const environment of environments.values()) {
    for (const route of environment.routes) {
      if (route._tag === "SshTunnelRoute" && sshTargetIdentityKey(route.target) === targetKey) {
        matches.push({ environment, route });
      }
    }
  }
  return matches;
}

const decodeSshDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const inspectSshEnrollment = Effect.fn("clientRuntime.connection.onboarding.inspectSshEnrollment")(
  function* (input: SshConnectionInput) {
    const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const environments = yield* SubscriptionRef.get(registry.environments);
    const matchingTargets = existingSshTargets(environments, input.target);
    if (matchingTargets.length > 1) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "This SSH target is already associated with multiple saved environments.",
      });
    }
    const existingTarget = matchingTargets[0];
    const inspected = yield* gateway.inspect({
      target: input.target,
      hostKeyFingerprint: existingTarget?.route.hostKeyFingerprint ?? null,
      cancellation: new AbortController().signal,
    });
    const descriptor = yield* Effect.try({
      try: () => decodeSshDescriptor(inspected.descriptor),
      catch: () =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: "The SSH environment returned an invalid identity descriptor.",
        }),
    });
    if (descriptor.transport?.mode !== "loopback-http") {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "SSH enrollment requires a loopback HTTP tunnel descriptor.",
      });
    }
    if (
      existingTarget?.route.hostKeyFingerprint !== null &&
      existingTarget?.route.hostKeyFingerprint !== undefined &&
      inspected.bootstrap.hostKeyFingerprint !== existingTarget.route.hostKeyFingerprint
    ) {
      return yield* new ConnectionBlockedError({
        reason: "environment-changed",
        detail: "The SSH target reported a different host-key fingerprint.",
      });
    }
    const connectionId = `ssh:${descriptor.environmentId}`;
    const label = input.label?.trim() || descriptor.label || inspected.bootstrap.target.alias;
    const route = new SshTunnelRoute({
      routeId: connectionId,
      environmentId: descriptor.environmentId,
      label,
      priority: 0,
      pinned: false,
      autoconnect: true,
      secretRef: null,
      target: inspected.bootstrap.target,
      hostKeyFingerprint: inspected.bootstrap.hostKeyFingerprint,
    });
    const acceptedEnvironment =
      existingTarget?.environment ?? environments.get(descriptor.environmentId);
    yield* verifyRouteIdentity({
      environment:
        acceptedEnvironment ??
        ({
          environmentId: descriptor.environmentId,
          acceptedStorageInstanceId: descriptor.storageInstanceId,
          descriptor,
          alias: label,
          hidden: false,
          bindings: [],
          routes: [route],
        } satisfies KnownEnvironment),
      route: existingTarget?.route ?? route,
      descriptor,
      transportTrust: "ssh-host-key",
    });
    const registration = new SshConnectionRegistration({
      target: new SshConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new SshConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        target: inspected.bootstrap.target,
      }),
    });
    return {
      registration,
      environment: {
        environmentId: descriptor.environmentId,
        acceptedStorageInstanceId: descriptor.storageInstanceId,
        descriptor,
        alias: label,
        hidden: false,
        bindings: [],
        routes: [route],
      },
      inspected: {
        bootstrap: inspected.bootstrap,
        descriptor,
      },
    } satisfies InspectedSshEnrollment;
  },
);

const prepareSshEnrollment = Effect.fn("clientRuntime.connection.onboarding.prepareSshEnrollment")(
  function* (input: SshConnectionInput) {
    const inspectedEnrollment = yield* inspectSshEnrollment(input);
    const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
    const exchanged = yield* gateway.exchange(inspectedEnrollment.inspected);
    return {
      registration: inspectedEnrollment.registration,
      environment: inspectedEnrollment.environment,
      sessionSecret: exchanged.sessionSecret,
    } satisfies PreparedSshEnrollment;
  },
);

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  return (yield* inspectSshEnrollment(input)).registration;
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
