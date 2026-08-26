import {
  ClientPresentation,
  EnvironmentCatalogStore,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  SshEnvironmentGateway,
} from "@bibcode/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  UnavailableConnectionRegistration,
  UnavailableConnectionTarget,
  Wakeups,
  type DesktopWslBinding,
} from "@bibcode/client-runtime/connection";
import { bootstrapRemoteBearerSession } from "@bibcode/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@bibcode/client-runtime/environment";
import { EnvironmentRpcRequestObserver } from "@bibcode/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@bibcode/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isHostedStaticApp } from "../hostedPairing";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import {
  desktopLocalConnectionId,
  observeDesktopLocalTopology,
  readDesktopLocalTopologySnapshot,
  reconcileDesktopWslBindings,
  type DesktopSecondaryBootstrapsRead,
} from "./desktopLocal";
import { connectionStorageLayer } from "./storage";

let nextObservedRpcRequestId = 0;

export function desktopWslBindingId(distroName: string): string {
  return `desktop:wsl:${encodeURIComponent(distroName.trim().toLocaleLowerCase("en-US"))}`;
}

export function desktopWslRouteId(bindingId: string): string {
  return `platform:wsl:${bindingId}`;
}

function desktopBootstrapDistro(bootstrap: DesktopEnvironmentBootstrap): string | null | undefined {
  return bootstrap.runningDistro ?? bootstrap.configuredDistro;
}

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            Queue.offerUnsafe(queue, "application-active");
          }
        };
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          document.removeEventListener("visibilitychange", listener);
        }),
    ).pipe(Effect.asVoid),
  ),
});

function clientMetadata() {
  const desktop = window.desktopBridge !== undefined;
  const platform = navigator.platform.trim();
  return {
    label: desktop ? "BiBCode Desktop" : "BiBCode Web",
    deviceType: "desktop" as const,
    ...(platform === "" ? {} : { os: platform }),
  };
}

function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}

function desktopSshPromise<A>(cancellation: AbortSignal, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: sshPreparationError,
  }).pipe(Effect.catch((error) => (cancellation.aborted ? Effect.interrupt : Effect.fail(error))));
}

function createSshOperationId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (randomUuid === undefined) {
    throw new Error("Secure UUID generation is unavailable for SSH operation fencing.");
  }
  return randomUuid.call(globalThis.crypto);
}

function ensureDesktopSshEnvironmentWithCancellation(
  bridge: DesktopBridge,
  input: {
    readonly target: Parameters<DesktopBridge["ensureSshEnvironment"]>[0];
    readonly hostKeyFingerprint: string | null;
    readonly environmentGeneration?: number;
    readonly bindingGeneration?: number;
    readonly cancellation: AbortSignal;
  },
): ReturnType<DesktopBridge["ensureSshEnvironment"]> {
  const operationId = createSshOperationId();
  const fence = {
    target: input.target,
    operationId,
    environmentGeneration: input.environmentGeneration ?? 0,
    bindingGeneration: input.bindingGeneration ?? 0,
  };

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      input.cancellation.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (cause: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(cause);
    };
    const onAbort = () => {
      const cancel = bridge.cancelSshOperation;
      if (cancel === undefined) {
        rejectOnce(
          new Error("The desktop host does not support generation-fenced SSH cancellation."),
        );
        return;
      }
      void cancel(fence).then(
        () => rejectOnce(new Error("SSH environment preparation was cancelled.")),
        rejectOnce,
      );
    };

    input.cancellation.addEventListener("abort", onAbort, { once: true });
    if (input.cancellation.aborted) {
      onAbort();
      return;
    }

    void bridge
      .ensureSshEnvironment(input.target, {
        expectedHostKeyFingerprint: input.hostKeyFingerprint,
        operationId,
        environmentGeneration: fence.environmentGeneration,
        bindingGeneration: fence.bindingGeneration,
      })
      .then((bootstrap) => {
        if (input.cancellation.aborted || settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(bootstrap);
      }, rejectOnce);
  });
}

export const exchangeDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.exchangeDesktop",
)(function* (
  bridge: DesktopBridge,
  input: {
    readonly bootstrap: Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
    readonly descriptor: Awaited<ReturnType<DesktopBridge["fetchSshEnvironmentDescriptor"]>>;
  },
) {
  const access = yield* Effect.tryPromise({
    try: () => bridge.pairSshEnvironment(input.bootstrap.target, input.descriptor),
    catch: sshPreparationError,
  });
  if (
    access === null ||
    access.schemaVersion !== 1 ||
    access.tokenType !== "DPoP" ||
    typeof access.sessionSecret !== "string" ||
    access.sessionSecret === ""
  ) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not return a paired administrator session.",
    });
  }
  return {
    bootstrap: input.bootstrap,
    sessionSecret: access.sessionSecret,
  };
});

export const authorizeDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.authorizeDesktop",
)(function* (
  bridge: DesktopBridge,
  input: {
    readonly bootstrap: Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
    readonly sessionSecret: string;
  },
) {
  const session = yield* Effect.tryPromise({
    try: () => bridge.fetchSshSessionState(input.bootstrap.httpBaseUrl, input.sessionSecret),
    catch: sshPreparationError,
  });
  if (!session.authenticated) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH administrator session is no longer valid. Re-enroll this environment.",
    });
  }
  const ticket = yield* Effect.tryPromise({
    try: () => bridge.issueSshWebSocketTicket(input.bootstrap.httpBaseUrl, input.sessionSecret),
    catch: sshPreparationError,
  });
  const socketUrl = new URL(input.bootstrap.wsBaseUrl);
  if (socketUrl.pathname === "" || socketUrl.pathname === "/") {
    socketUrl.pathname = "/ws";
  }
  socketUrl.searchParams.set("wsTicket", ticket.ticket);
  return { socketUrl: socketUrl.toString() };
});

const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientPresentation.of({
      metadata: clientMetadata(),
      scopes: AuthStandardClientScopes,
    });
    const primaryAuth = PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    const ssh = SshEnvironmentGateway.of({
      inspect: Effect.fn("web.connectionPlatform.ssh.inspect")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        if (input.cancellation.aborted) {
          return yield* Effect.interrupt;
        }
        const bootstrap = yield* desktopSshPromise(input.cancellation, () =>
          ensureDesktopSshEnvironmentWithCancellation(bridge, {
            target: input.target,
            hostKeyFingerprint: input.hostKeyFingerprint,
            ...(input.environmentGeneration === undefined
              ? {}
              : { environmentGeneration: input.environmentGeneration }),
            ...(input.bindingGeneration === undefined
              ? {}
              : { bindingGeneration: input.bindingGeneration }),
            cancellation: input.cancellation,
          }),
        );
        if (input.cancellation.aborted) {
          return yield* Effect.interrupt;
        }
        const descriptor = yield* desktopSshPromise(input.cancellation, () =>
          bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
        );
        if (input.cancellation.aborted) {
          return yield* Effect.interrupt;
        }
        return { bootstrap, descriptor };
      }),
      exchange: Effect.fn("web.connectionPlatform.ssh.exchange")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        return yield* exchangeDesktopSshEnvironment(bridge, input);
      }),
      authorize: Effect.fn("web.connectionPlatform.ssh.authorize")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        if (input.cancellation.aborted) {
          return yield* Effect.interrupt;
        }
        const authorized = yield* authorizeDesktopSshEnvironment(bridge, input);
        if (input.cancellation.aborted) {
          return yield* Effect.interrupt;
        }
        return authorized;
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(
        function* (target, expectedHostKeyFingerprint) {
          const bridge = window.desktopBridge;
          if (bridge === undefined) {
            return;
          }
          yield* Effect.tryPromise({
            try: () =>
              bridge.disconnectSshEnvironment(target, {
                expectedHostKeyFingerprint,
              }),
            catch: (cause) =>
              new ConnectionTransientError({
                reason: "remote-unavailable",
                detail: `Could not disconnect the SSH environment: ${String(cause)}`,
              }),
          });
        },
      ),
    });

    return Context.make(PrimaryEnvironmentAuth, primaryAuth).pipe(
      Context.add(ClientPresentation, presentation),
      Context.add(SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer), Effect.mapError(mapRemoteEnvironmentError));
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
    descriptor,
  });
});

// A desktop-local secondary backend (e.g. a parallel WSL backend) lives on its
// own loopback origin, so — unlike the same-origin primary — it authenticates
// with a bearer token minted from the bootstrap credential the desktop issues.
const loadSecondaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadSecondaryConnectionRegistration",
)(function* (entry: DesktopEnvironmentBootstrap) {
  if (entry.preflightError?.kind === "wsl-secondary-unavailable") {
    return {
      registration: new UnavailableConnectionRegistration({
        target: new UnavailableConnectionTarget({
          environmentId: EnvironmentId.make(entry.id),
          label: entry.label,
          connectionId: desktopLocalConnectionId(entry.id),
          configuredDistro: entry.configuredDistro ?? null,
          detail: entry.preflightError.detail,
        }),
      }),
    };
  }
  if (
    entry.httpBaseUrl === null ||
    entry.wsBaseUrl === null ||
    entry.bootstrapToken === undefined
  ) {
    return yield* new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: `Desktop-local backend ${entry.id} is not ready yet.`,
    });
  }
  const httpBaseUrl = entry.httpBaseUrl;
  const wsBaseUrl = entry.wsBaseUrl;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
  );
  const issuedAtEpochMs = yield* Clock.currentTimeMillis;
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: entry.bootstrapToken,
    scopes: AuthStandardClientScopes,
    clientMetadata: clientMetadata(),
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Keep the desktop pool's opaque runtime slot in the connection id for the
  // lifetime of this process. Descriptor UUIDs still scope durable projects,
  // RPC state, and catalog identity; the slot only classifies host-managed
  // desktop connections and must never be parsed as a distro locator.
  const connectionId = desktopLocalConnectionId(entry.id);
  // Prefer the desktop's bootstrap label (it identifies the backend and distro,
  // e.g. "WSL: Ubuntu") over the generic descriptor label, so consumers can show
  // a meaningful name without recovering it from the bootstrap list later.
  const label = entry.label || descriptor.label;
  return {
    registration: new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl,
      }),
      credential: new BearerConnectionCredential({ token: access.access_token }),
      descriptor,
    }),
    expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, access.expires_in),
    refreshAtEpochMs: secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, access.expires_in),
  };
});

const SECONDARY_BEARER_REFRESH_SKEW_MS = 5_000;

export function secondaryBearerExpiresAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return issuedAtEpochMs + Math.max(0, expiresInSeconds * 1_000);
}

export function secondaryBearerRefreshAtEpochMs(
  issuedAtEpochMs: number,
  expiresInSeconds: number,
): number {
  return Math.max(
    issuedAtEpochMs,
    secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, expiresInSeconds) -
      SECONDARY_BEARER_REFRESH_SKEW_MS,
  );
}

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
  readonly expiresAtEpochMs?: number;
  readonly refreshAtEpochMs?: number;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export function primaryRegistrationToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID) : undefined;
}

export function canReuseCachedPlatformRegistration(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    (cached.refreshAtEpochMs === undefined || nowEpochMs < cached.refreshAtEpochMs)
  );
}

export function canRetainCachedPlatformRegistrationAfterRefreshFailure(
  cached: CachedPlatformRegistration,
  signature: string,
  nowEpochMs: number,
): boolean {
  return (
    cached.signature === signature &&
    cached.expiresAtEpochMs !== undefined &&
    nowEpochMs < cached.expiresAtEpochMs
  );
}

export function secondaryRegistrationsToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: DesktopSecondaryBootstrapsRead,
  nowEpochMs: number,
): ReadonlyMap<string, CachedPlatformRegistration> {
  if (topologyRead._tag === "Success") {
    return new Map();
  }
  return new Map(
    [...previous].filter(
      ([, cached]) => cached.expiresAtEpochMs !== undefined && nowEpochMs < cached.expiresAtEpochMs,
    ),
  );
}

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    if (isHostedStaticApp()) {
      return PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());
    const lastWslRegistrationsRef = yield* Ref.make<ReadonlyArray<PlatformConnectionRegistration>>(
      [],
    );
    const environmentCatalog = yield* EnvironmentCatalogStore;

    const reconcileWslRegistrations = Effect.fn("web.connectionPlatform.reconcileWslRegistrations")(
      function* (
        registrations: ReadonlyArray<PlatformConnectionRegistration>,
        topologyRead: DesktopSecondaryBootstrapsRead,
      ) {
        const wslState = readDesktopLocalTopologySnapshot().wslState;
        const catalogSnapshot = yield* Effect.all([
          environmentCatalog.listBindings,
          environmentCatalog.list,
        ]).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not read the environment catalog for WSL reconciliation.", {
              error,
            }),
          ),
          Effect.option,
        );
        if (Option.isNone(catalogSnapshot)) {
          const retained = yield* Ref.get(lastWslRegistrationsRef);
          return [
            ...registrations.filter(
              (registration) => registration._tag === "PrimaryConnectionRegistration",
            ),
            ...retained,
          ];
        }
        const [catalogBindings, environments] = catalogSnapshot.value;
        const wslBindings = catalogBindings.filter(
          (binding): binding is DesktopWslBinding => binding._tag === "DesktopWslBinding",
        );
        if (topologyRead._tag === "Failure") {
          const representedBindingIds = new Set<string>();
          const retained = registrations.flatMap(
            (registration): ReadonlyArray<PlatformConnectionRegistration> => {
              if (registration._tag === "PrimaryConnectionRegistration") return [registration];
              const binding =
                registration.wslBinding ??
                wslBindings.find(
                  (candidate) =>
                    candidate.acceptedEnvironmentId === registration.target.environmentId,
                );
              if (binding === undefined || binding.acceptedEnvironmentId === null) return [];
              representedBindingIds.add(binding.bindingId);
              if (registration._tag === "BearerConnectionRegistration") {
                return [
                  new BearerConnectionRegistration({
                    ...registration,
                    wslBinding: binding,
                    wslRouteId: desktopWslRouteId(binding.bindingId),
                  }),
                ];
              }
              return [registration];
            },
          );
          for (const binding of wslBindings) {
            if (
              binding.acceptedEnvironmentId === null ||
              representedBindingIds.has(binding.bindingId)
            ) {
              continue;
            }
            retained.push(
              new UnavailableConnectionRegistration({
                target: new UnavailableConnectionTarget({
                  environmentId: binding.acceptedEnvironmentId,
                  label: `WSL: ${binding.distroName}`,
                  connectionId: desktopLocalConnectionId(`candidate:${binding.bindingId}`),
                  configuredDistro: binding.distroName,
                  detail: "Desktop WSL topology is temporarily unavailable.",
                }),
                wslBinding: binding,
                wslRouteId: desktopWslRouteId(binding.bindingId),
              }),
            );
          }
          yield* Ref.set(
            lastWslRegistrationsRef,
            retained.filter(
              (registration) => registration._tag !== "PrimaryConnectionRegistration",
            ),
          );
          return retained;
        }
        if (wslState === null) {
          const wslConnectionIds = new Set(
            topologyRead.bootstraps
              .filter((bootstrap) => desktopBootstrapDistro(bootstrap) != null)
              .map((bootstrap) => desktopLocalConnectionId(bootstrap.id)),
          );
          return registrations.filter(
            (registration) =>
              registration._tag === "PrimaryConnectionRegistration" ||
              !wslConnectionIds.has(registration.target.connectionId),
          );
        }
        const bootstrapByConnectionId = new Map(
          topologyRead.bootstraps.map((bootstrap) => [
            desktopLocalConnectionId(bootstrap.id),
            bootstrap,
          ]),
        );
        const observations = topologyRead.bootstraps.flatMap((bootstrap) => {
          const connectionId = desktopLocalConnectionId(bootstrap.id);
          const registration = registrations.find(
            (candidate) =>
              candidate._tag !== "PrimaryConnectionRegistration" &&
              candidate.target.connectionId === connectionId,
          );
          const distroName = desktopBootstrapDistro(bootstrap);
          if (distroName === null || distroName === undefined) return [];
          return [
            {
              distroName,
              descriptor:
                registration?._tag === "BearerConnectionRegistration"
                  ? (registration.descriptor ?? null)
                  : null,
              detail:
                registration?._tag === "UnavailableConnectionRegistration"
                  ? registration.target.detail
                  : null,
            },
          ];
        });
        const reconciled = reconcileDesktopWslBindings({
          discovery: wslState.discovery,
          observations,
          bindings: wslBindings,
          environments: environments.map((environment) => ({
            environmentId: environment.environmentId,
            hidden: environment.hidden,
          })),
          observedAt: wslState.discovery.observedAt,
          createBindingId: desktopWslBindingId,
          legacyAcceptedDistro: wslState.legacyAcceptedDistro,
        });

        yield* Effect.forEach(
          reconciled.supersededBindings,
          (binding) =>
            environmentCatalog.removeWslBindingIfUnchanged(binding).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not remove a superseded WSL locator binding.", {
                  error,
                }),
              ),
            ),
          { discard: true },
        );

        yield* Effect.forEach(
          reconciled.bindings.filter((binding) => binding.acceptedEnvironmentId === null),
          (binding) =>
            environmentCatalog.putBinding(binding).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not persist an unproved WSL binding.", {
                  error,
                }),
              ),
            ),
          { discard: true },
        );

        const representedBindingIds = new Set<string>();
        const decorated = registrations.map((registration): PlatformConnectionRegistration => {
          if (registration._tag === "PrimaryConnectionRegistration") return registration;
          const bootstrap = bootstrapByConnectionId.get(registration.target.connectionId);
          const distroName =
            bootstrap === undefined ? undefined : desktopBootstrapDistro(bootstrap);
          const binding = reconciled.bindings.find(
            (candidate) =>
              (registration._tag === "BearerConnectionRegistration" &&
                candidate.acceptedEnvironmentId === registration.target.environmentId) ||
              (distroName !== null &&
                distroName !== undefined &&
                candidate.distroName.localeCompare(distroName, "en-US", {
                  sensitivity: "base",
                }) === 0),
          );
          if (binding === undefined) return registration;
          representedBindingIds.add(binding.bindingId);
          const routeId = desktopWslRouteId(binding.bindingId);
          if (registration._tag === "BearerConnectionRegistration") {
            if (binding.condition !== "available") {
              return new UnavailableConnectionRegistration({
                target: new UnavailableConnectionTarget({
                  environmentId: binding.acceptedEnvironmentId ?? registration.target.environmentId,
                  label: `WSL: ${binding.distroName}`,
                  connectionId: registration.target.connectionId,
                  configuredDistro: binding.distroName,
                  detail:
                    binding.detail ??
                    "This WSL locator did not prove the identity accepted for this environment.",
                }),
                wslBinding: binding,
                wslRouteId: routeId,
              });
            }
            return new BearerConnectionRegistration({
              ...registration,
              wslBinding: binding,
              wslRouteId: routeId,
            });
          }
          return new UnavailableConnectionRegistration({
            ...registration,
            target: new UnavailableConnectionTarget({
              ...registration.target,
              environmentId: binding.acceptedEnvironmentId ?? registration.target.environmentId,
            }),
            wslBinding: binding,
            wslRouteId: routeId,
          });
        });

        for (const binding of reconciled.bindings) {
          if (representedBindingIds.has(binding.bindingId) || binding.condition === "available") {
            continue;
          }
          const detail =
            binding.detail ??
            (binding.condition === "stopped"
              ? "This WSL distribution is stopped."
              : "BiBCode Server setup is required in this WSL distribution.");
          decorated.push(
            new UnavailableConnectionRegistration({
              target: new UnavailableConnectionTarget({
                environmentId:
                  binding.acceptedEnvironmentId ??
                  EnvironmentId.make(`wsl-candidate:${binding.bindingId}`),
                label: `WSL: ${binding.distroName}`,
                connectionId: desktopLocalConnectionId(`candidate:${binding.bindingId}`),
                configuredDistro: binding.distroName,
                detail,
              }),
              wslBinding: binding,
              wslRouteId: desktopWslRouteId(binding.bindingId),
            }),
          );
        }
        yield* Ref.set(
          lastWslRegistrationsRef,
          decorated.filter((registration) => registration._tag !== "PrimaryConnectionRegistration"),
        );
        return decorated;
      },
    );

    // Resolve the full set of platform-managed environments the host currently
    // reports: the primary (same-origin cookie auth) plus any desktop-local
    // backends running alongside it (bearer auth). Reused registrations come
    // from the cache; a failed entry is skipped and retried on the next poll.
    const buildPlatformRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];

      const primaryTopologyRead = readPrimaryEnvironmentTargetResult();
      const retainedPrimary = primaryRegistrationToRetainAfterTopologyRead(
        previous,
        primaryTopologyRead,
      );
      if (retainedPrimary !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, retainedPrimary);
        registrations.push(retainedPrimary.registration);
      }

      if (primaryTopologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: primaryTopologyRead.cause,
        });
      } else if (primaryTopologyRead.target !== null) {
        const primaryTarget = primaryTopologyRead.target;
        const signature = `primary|${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        if (
          cached !== undefined &&
          canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
        ) {
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cached);
          registrations.push(cached.registration);
        } else {
          const built = yield* loadPrimaryConnectionRegistration(primaryTarget).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, registration: built.value };
            next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
            registrations.push(built.value);
          }
        }
      }

      const topologyRead = readDesktopLocalTopologySnapshot().secondaryBootstraps;
      for (const [id, cached] of secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        topologyRead,
        nowEpochMs,
      )) {
        next.set(id, cached);
        registrations.push(cached.registration);
      }

      if (topologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the desktop-local backend topology.", {
          cause: topologyRead.cause,
        });
      } else {
        const wslStateReady = readDesktopLocalTopologySnapshot().wslState !== null;
        for (const bootstrap of topologyRead.bootstraps) {
          if (desktopBootstrapDistro(bootstrap) != null && !wslStateReady) continue;
          const signature = [
            bootstrap.httpBaseUrl,
            bootstrap.wsBaseUrl,
            bootstrap.bootstrapToken ?? "",
            bootstrap.configuredDistro ?? "",
            bootstrap.preflightError?.kind ?? "",
            bootstrap.preflightError?.detail ?? "",
          ].join("|");
          const cached = previous.get(bootstrap.id);
          if (
            cached !== undefined &&
            canReuseCachedPlatformRegistration(cached, signature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
            continue;
          }
          const built = yield* loadSecondaryConnectionRegistration(bootstrap).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not connect a desktop-local backend.", {
                id: bootstrap.id,
                error,
              }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, ...built.value };
            next.set(bootstrap.id, cacheEntry);
            registrations.push(built.value.registration);
          } else if (
            cached !== undefined &&
            canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, signature, nowEpochMs)
          ) {
            next.set(bootstrap.id, cached);
            registrations.push(cached.registration);
          }
        }
      }

      yield* Ref.set(cacheRef, next);
      return yield* reconcileWslRegistrations(registrations, topologyRead);
    }).pipe(Effect.provide(FetchHttpClient.layer));

    const topologyChanges = Stream.callback<void>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          observeDesktopLocalTopology(() => {
            Queue.offerUnsafe(queue, undefined);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    );
    return PlatformConnectionSource.of({
      registrations: topologyChanges.pipe(Stream.mapEffect(() => buildPlatformRegistrations)),
    });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, `${method} · ${environmentId}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

const connectionPlatformServicesLayer = Layer.mergeAll(
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);

export const connectionPlatformLayer = connectionPlatformServicesLayer.pipe(
  Layer.provideMerge(connectionStorageLayer),
);
