import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const RemoteUpdateInstallMode = Schema.Literals(["interactive", "manual", "supervised"]);
export type RemoteUpdateInstallMode = typeof RemoteUpdateInstallMode.Type;

export const RemoteUpdateSupportReason = Schema.Literals([
  "available",
  "manual-update-required",
  "unpackaged-build",
  "updater-unavailable",
]);
export type RemoteUpdateSupportReason = typeof RemoteUpdateSupportReason.Type;

export const RemoteUpdateSupport = Schema.Struct({
  installMode: RemoteUpdateInstallMode,
  reason: RemoteUpdateSupportReason,
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
  error: Schema.NullOr(TrimmedNonEmptyString),
  support: RemoteUpdateSupport,
});
export type RemoteUpdateSnapshot = typeof RemoteUpdateSnapshot.Type;

export const REMOTE_UPDATE_MANUAL_REQUIRED = "remote_update_manual_required" as const;

export class RemoteUpdateInstallError extends Schema.TaggedErrorClass<RemoteUpdateInstallError>()(
  "RemoteUpdateInstallError",
  {
    code: Schema.Literal(REMOTE_UPDATE_MANUAL_REQUIRED),
  },
) {
  override get message(): string {
    return "This server must be updated manually.";
  }
}
