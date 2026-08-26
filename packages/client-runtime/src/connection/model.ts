import {
  DesktopSshEnvironmentTargetSchema,
  DurableEnvironmentId,
  EnvironmentId,
  TrimmedNonEmptyString,
  type ExecutionEnvironmentDescriptor,
} from "@bibcode/contracts";
import * as Schema from "effect/Schema";

function isUrlWithProtocols(value: string, protocols: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value);
    return (
      protocols.has(url.protocol) &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function isLoopbackUrl(value: string, protocols: ReadonlySet<string>): boolean {
  try {
    const url = new URL(value);
    return (
      isUrlWithProtocols(value, protocols) &&
      isLoopbackHostname(url.hostname) &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const WEBSOCKET_PROTOCOLS = new Set(["ws:", "wss:"]);
const HTTPS_PROTOCOL = new Set(["https:"]);

const RouteId = TrimmedNonEmptyString;
const SecretReference = TrimmedNonEmptyString;
const LoopbackHttpUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      isLoopbackUrl(value, HTTP_PROTOCOLS) || "Expected an HTTP(S) URL whose host is loopback.",
  ),
);
const LoopbackWebSocketUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      isLoopbackUrl(value, WEBSOCKET_PROTOCOLS) ||
      "Expected a WebSocket URL whose host is loopback.",
  ),
);
const HttpsUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      isUrlWithProtocols(value, HTTPS_PROTOCOL) ||
      "Expected an HTTPS URL without credentials, query parameters, or a fragment.",
  ),
);

const EnvironmentRouteBase = {
  routeId: RouteId,
  environmentId: DurableEnvironmentId,
  label: TrimmedNonEmptyString,
  priority: Schema.Int,
  pinned: Schema.Boolean,
  autoconnect: Schema.Boolean,
  secretRef: Schema.NullOr(SecretReference),
};

/** The same-origin desktop server reached only through a loopback listener. */
export class DesktopLoopbackRoute extends Schema.TaggedClass<DesktopLoopbackRoute>()(
  "DesktopLoopbackRoute",
  {
    ...EnvironmentRouteBase,
    httpBaseUrl: LoopbackHttpUrl,
    wsBaseUrl: LoopbackWebSocketUrl,
  },
) {}

/** A WSL server reached through a desktop-owned loopback forwarder. */
export class DesktopWslRoute extends Schema.TaggedClass<DesktopWslRoute>()("DesktopWslRoute", {
  ...EnvironmentRouteBase,
  bindingId: TrimmedNonEmptyString,
  httpBaseUrl: LoopbackHttpUrl,
  wsBaseUrl: LoopbackWebSocketUrl,
}) {}

/** An SSH locator whose resulting tunnel remains desktop-owned and loopback-only. */
export class SshTunnelRoute extends Schema.TaggedClass<SshTunnelRoute>()("SshTunnelRoute", {
  ...EnvironmentRouteBase,
  target: DesktopSshEnvironmentTargetSchema,
  hostKeyFingerprint: Schema.NullOr(TrimmedNonEmptyString),
}) {}

export const DirectHttpsTrust = Schema.Union([
  Schema.TaggedStruct("System", {}),
  Schema.TaggedStruct("PinnedSpki", {
    sha256: TrimmedNonEmptyString,
  }),
]);
export type DirectHttpsTrust = typeof DirectHttpsTrust.Type;

/** A directly reachable server. Plaintext HTTP is deliberately unrepresentable. */
export class DirectHttpsRoute extends Schema.TaggedClass<DirectHttpsRoute>()("DirectHttpsRoute", {
  ...EnvironmentRouteBase,
  httpsBaseUrl: HttpsUrl,
  trust: DirectHttpsTrust,
}) {}

export const EnvironmentRoute = Schema.Union([
  DesktopLoopbackRoute,
  DesktopWslRoute,
  SshTunnelRoute,
  DirectHttpsRoute,
]);
export type EnvironmentRoute = typeof EnvironmentRoute.Type;

export const EnvironmentPresentationStatus = Schema.Literals([
  "online",
  "connecting",
  "reconnecting",
  "offline",
  "authentication-required",
  "version-incompatible",
  "updating",
  "stopped",
]);
export type EnvironmentPresentationStatus = typeof EnvironmentPresentationStatus.Type;

/** Failure reasons for the canonical multi-route runtime. */
export const EnvironmentRouteTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
  "remote-unavailable",
]);
export type EnvironmentRouteTransientReason = typeof EnvironmentRouteTransientReason.Type;

export const EnvironmentRouteBlockedReason = Schema.Literals([
  "authentication",
  "configuration",
  "permission",
  "recovery-required",
  "storage-changed",
  "unsupported",
  "environment-changed",
  "certificate-changed",
  "version-incompatible",
  "identity-conflict",
]);
export type EnvironmentRouteBlockedReason = typeof EnvironmentRouteBlockedReason.Type;

const ConnectionTargetBase = {
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class PrimaryConnectionTarget extends Schema.TaggedClass<PrimaryConnectionTarget>()(
  "PrimaryConnectionTarget",
  {
    ...ConnectionTargetBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
  },
) {}

export class BearerConnectionTarget extends Schema.TaggedClass<BearerConnectionTarget>()(
  "BearerConnectionTarget",
  {
    ...ConnectionTargetBase,
    connectionId: Schema.String,
  },
) {}

export class SshConnectionTarget extends Schema.TaggedClass<SshConnectionTarget>()(
  "SshConnectionTarget",
  {
    ...ConnectionTargetBase,
    connectionId: Schema.String,
  },
) {}

/**
 * A platform-owned environment that remains desired but currently has no
 * usable endpoint. It is deliberately not persistable: the host topology is
 * the sole owner and the resolver must fail before any transport/session work.
 */
export class UnavailableConnectionTarget extends Schema.TaggedClass<UnavailableConnectionTarget>()(
  "UnavailableConnectionTarget",
  {
    ...ConnectionTargetBase,
    connectionId: Schema.String,
    configuredDistro: Schema.NullOr(Schema.String),
    detail: Schema.String,
  },
) {}

export const ConnectionTarget = Schema.Union([
  PrimaryConnectionTarget,
  BearerConnectionTarget,
  SshConnectionTarget,
  UnavailableConnectionTarget,
]);
export type ConnectionTarget = typeof ConnectionTarget.Type;

export const PersistedConnectionTarget = Schema.Union([
  BearerConnectionTarget,
  SshConnectionTarget,
]);
export type PersistedConnectionTarget = typeof PersistedConnectionTarget.Type;

export type ConnectionTargetKind = ConnectionTarget["_tag"];

export type NetworkStatus = "unknown" | "offline" | "online";

export const ConnectionTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
  "remote-unavailable",
]);
export type ConnectionTransientReason = typeof ConnectionTransientReason.Type;

export const ConnectionBlockedReason = Schema.Literals([
  "authentication",
  "configuration",
  "permission",
  "recovery-required",
  "storage-changed",
  "unsupported",
  "environment-changed",
  "certificate-changed",
  "version-incompatible",
  "identity-conflict",
]);
export type ConnectionBlockedReason = typeof ConnectionBlockedReason.Type;

export class ConnectionTransientError extends Schema.TaggedErrorClass<ConnectionTransientError>()(
  "ConnectionTransientError",
  {
    reason: ConnectionTransientReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ConnectionBlockedError extends Schema.TaggedErrorClass<ConnectionBlockedError>()(
  "ConnectionBlockedError",
  {
    reason: ConnectionBlockedReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ConnectionStorageChangedError extends Schema.TaggedErrorClass<ConnectionStorageChangedError>()(
  "ConnectionStorageChangedError",
  {
    reason: Schema.Literal("storage-changed"),
    detail: Schema.String,
    targetKey: Schema.String,
    acceptedStorageInstanceId: Schema.String,
    reportedStorageInstanceId: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type ConnectionAttemptError =
  | ConnectionTransientError
  | ConnectionBlockedError
  | ConnectionStorageChangedError;

export type VerifiedRouteTransportTrust =
  | "loopback"
  | "ssh-host-key"
  | "system-tls"
  | "pinned-spki";

/** Identity proved from a transport-trusted descriptor before any credential access. */
export interface VerifiedRouteIdentity {
  readonly routeId: string;
  readonly environmentId: EnvironmentId;
  readonly storageInstanceId: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly transportTrust: VerifiedRouteTransportTrust;
}

export type PreparedHttpAuthorization =
  | {
      readonly _tag: "Bearer";
      readonly token: string;
    }
  | {
      readonly _tag: "Dpop";
      readonly accessToken: string;
    };

export interface PreparedConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly target: ConnectionTarget;
  readonly route?: EnvironmentRoute;
  readonly verifiedRouteIdentity?: VerifiedRouteIdentity;
}

export type SupervisorConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "backoff"
  | "connected"
  | "blocked";

export type ConnectionAttemptStage = "preparing" | "opening" | "synchronizing";

export interface SupervisorConnectionState {
  readonly desired: boolean;
  readonly network: NetworkStatus;
  readonly phase: SupervisorConnectionPhase;
  readonly stage: ConnectionAttemptStage | null;
  readonly attempt: number;
  readonly generation: number;
  readonly lastFailure: ConnectionAttemptError | null;
  readonly retryAt: number | null;
}

export type ConnectionProjectionPhase = "disconnected" | "synchronizing" | "ready";

export function connectionProjectionPhase(
  state: SupervisorConnectionState,
): ConnectionProjectionPhase {
  switch (state.phase) {
    case "connecting":
      return "synchronizing";
    case "connected":
      return "ready";
    case "available":
    case "offline":
    case "backoff":
    case "blocked":
      return "disconnected";
  }
}

export const AVAILABLE_CONNECTION_STATE: SupervisorConnectionState = Object.freeze({
  desired: false,
  network: "unknown",
  phase: "available",
  stage: null,
  attempt: 0,
  generation: 0,
  lastFailure: null,
  retryAt: null,
});
