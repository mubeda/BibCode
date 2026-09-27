import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const RemoteUpdateInstallMode = Schema.Literals(["interactive", "manual", "supervised"]);
export type RemoteUpdateInstallMode = typeof RemoteUpdateInstallMode.Type;

export const RemoteUpdateSupportReason = Schema.Literals([
  "available",
  "manual-update-required",
  "unpackaged-build",
  "updater-unavailable",
]);
export type RemoteUpdateSupportReason = typeof RemoteUpdateSupportReason.Type;

/**
 * How a headless server was installed; the client picks its manual update steps from
 * it. Decoded as a plain string so an older client keeps working when a newer server
 * adds a kind: unknown values fall back to generic steps.
 */
export const REMOTE_UPDATE_INSTALL_KINDS = ["archive", "system-package", "unknown"] as const;
export type RemoteUpdateInstallKind = (typeof REMOTE_UPDATE_INSTALL_KINDS)[number];

export const RemoteUpdateSupport = Schema.Struct({
  installMode: RemoteUpdateInstallMode,
  reason: RemoteUpdateSupportReason,
  installKind: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("unknown"))),
});
export type RemoteUpdateSupport = typeof RemoteUpdateSupport.Type;

export const RemoteUpdateState = Schema.Literals([
  "idle",
  "checking",
  "update-available",
  "downloading",
  "installing",
  "up-to-date",
  "error",
]);
export type RemoteUpdateState = typeof RemoteUpdateState.Type;

export const RemoteUpdateSnapshot = Schema.Struct({
  serverVersion: TrimmedNonEmptyString,
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  state: RemoteUpdateState,
  error: Schema.NullOr(Schema.String),
  support: RemoteUpdateSupport,
  /** The host's download progress (0–100) while `state` is `downloading`. */
  downloadPercent: Schema.NullOr(Schema.Finite).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** The version this install applies: the available version, then the downloaded one. */
  targetVersion: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * The protection stage of the environment being protected, then `installing`. A plain
   * string: unknown stages get a generic label.
   */
  installStage: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type RemoteUpdateSnapshot = typeof RemoteUpdateSnapshot.Type;

export const REMOTE_UPDATE_MANUAL_REQUIRED = "remote_update_manual_required" as const;

export class RemoteUpdateInstallError extends Schema.TaggedError<RemoteUpdateInstallError>()(
  "RemoteUpdateInstallError",
  {
    code: Schema.Literal(REMOTE_UPDATE_MANUAL_REQUIRED),
  },
) {
  override get message(): string {
    return "This server must be updated manually.";
  }
}

/** Work an update restart would stop, counted across all clients of the server. */
export const RemoteUpdateActiveWork = Schema.Struct({
  runningTurns: NonNegativeInt,
  liveTerminals: NonNegativeInt,
  queuedMessages: NonNegativeInt,
});
export type RemoteUpdateActiveWork = typeof RemoteUpdateActiveWork.Type;

/** The server could not count its running work; clients fall back to a confirmation without counts. */
export class RemoteUpdateActiveWorkError extends Schema.TaggedError<RemoteUpdateActiveWorkError>()(
  "RemoteUpdateActiveWorkError",
  { message: TrimmedNonEmptyString },
) {}
