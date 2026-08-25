import {
  DesktopSshEnvironmentTargetSchema,
  DurableEnvironmentId,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@bibcode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  EnvironmentRoute as EnvironmentRouteSchema,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
  UnavailableConnectionTarget,
} from "./model.ts";

const StorageInstanceId = Schema.String.check(Schema.isUUID());

export const EnvironmentBindingCondition = Schema.Literals([
  "available",
  "unavailable",
  "stopped",
  "setup-required",
  "identity-conflict",
]);
export type EnvironmentBindingCondition = typeof EnvironmentBindingCondition.Type;

const EnvironmentBindingConditionFields = {
  condition: EnvironmentBindingCondition,
  detail: Schema.NullOr(TrimmedNonEmptyString),
};

/** The platform-owned binding for the desktop's primary in-process server. */
export class DesktopPrimaryBinding extends Schema.TaggedClass<DesktopPrimaryBinding>()(
  "DesktopPrimaryBinding",
  {
    bindingId: TrimmedNonEmptyString,
    acceptedEnvironmentId: DurableEnvironmentId,
    acceptedStorageInstanceIds: Schema.Array(StorageInstanceId),
    ...EnvironmentBindingConditionFields,
  },
) {}

/**
 * A mutable WSL locator kept separate from durable server identity. It may be
 * present before a server has been installed or its descriptor has been proved.
 */
export class DesktopWslBinding extends Schema.TaggedClass<DesktopWslBinding>()(
  "DesktopWslBinding",
  {
    bindingId: TrimmedNonEmptyString,
    distroName: TrimmedNonEmptyString,
    acceptedEnvironmentId: Schema.NullOr(DurableEnvironmentId),
    acceptedStorageInstanceIds: Schema.Array(StorageInstanceId),
    acceptedAt: Schema.NullOr(TrimmedNonEmptyString),
    lastDiscoveryGeneration: NonNegativeInt,
    ...EnvironmentBindingConditionFields,
  },
) {}

export const EnvironmentBinding = Schema.Union([DesktopPrimaryBinding, DesktopWslBinding]);
export type EnvironmentBinding = typeof EnvironmentBinding.Type;

const EnvironmentUiPreferenceFields = {
  alias: Schema.NullOr(TrimmedNonEmptyString),
  hidden: Schema.Boolean,
};

/** Client-local presentation fields stored independently from server settings. */
export const EnvironmentUiPreferences = Schema.Struct(EnvironmentUiPreferenceFields);
export type EnvironmentUiPreferences = typeof EnvironmentUiPreferences.Type;

export const KnownEnvironmentRecord = Schema.Struct({
  environmentId: DurableEnvironmentId,
  acceptedStorageInstanceId: StorageInstanceId,
  descriptor: Schema.NullOr(ExecutionEnvironmentDescriptor),
  ...EnvironmentUiPreferenceFields,
}).check(
  Schema.makeFilter(
    (environment) =>
      environment.descriptor === null ||
      environment.descriptor.environmentId === environment.environmentId ||
      "Descriptor environment identity must match the accepted environment identity.",
  ),
  Schema.makeFilter(
    (environment) =>
      environment.descriptor === null ||
      environment.descriptor.storageInstanceId === environment.acceptedStorageInstanceId ||
      "Descriptor storage identity must match the accepted storage identity.",
  ),
);
export type KnownEnvironmentRecord = typeof KnownEnvironmentRecord.Type;

function hasUniqueIdentifiers<Value, Identifier>(
  values: ReadonlyArray<Value>,
  getIdentifier: (value: Value) => Identifier,
): boolean {
  const identifiers = values.map(getIdentifier);
  return new Set(identifiers).size === identifiers.length;
}

export const KnownEnvironment = Schema.Struct({
  environmentId: DurableEnvironmentId,
  acceptedStorageInstanceId: StorageInstanceId,
  descriptor: Schema.NullOr(ExecutionEnvironmentDescriptor),
  ...EnvironmentUiPreferenceFields,
  bindings: Schema.Array(EnvironmentBinding),
  routes: Schema.Array(EnvironmentRouteSchema),
}).check(
  Schema.makeFilter(
    (environment) =>
      hasUniqueIdentifiers(environment.routes, (route) => route.routeId) ||
      "Route identifiers must be unique within an environment.",
  ),
  Schema.makeFilter(
    (environment) =>
      hasUniqueIdentifiers(environment.bindings, (binding) => binding.bindingId) ||
      "Binding identifiers must be unique within an environment.",
  ),
  Schema.makeFilter(
    (environment) =>
      environment.routes.every((route) => route.environmentId === environment.environmentId) ||
      "Every route must belong to its containing environment.",
  ),
  Schema.makeFilter(
    (environment) =>
      environment.bindings.every(
        (binding) =>
          binding.acceptedEnvironmentId === null ||
          binding.acceptedEnvironmentId === environment.environmentId,
      ) || "Every proved binding must belong to its containing environment.",
  ),
  Schema.makeFilter(
    (environment) =>
      environment.routes.filter((route) => route.pinned).length <= 1 ||
      "At most one route may be pinned for an environment.",
  ),
  Schema.makeFilter(
    (environment) =>
      environment.descriptor === null ||
      environment.descriptor.environmentId === environment.environmentId ||
      "Descriptor environment identity must match the accepted environment identity.",
  ),
  Schema.makeFilter(
    (environment) =>
      environment.descriptor === null ||
      environment.descriptor.storageInstanceId === environment.acceptedStorageInstanceId ||
      "Descriptor storage identity must match the accepted storage identity.",
  ),
);
export type KnownEnvironment = typeof KnownEnvironment.Type;

const ConnectionProfileBase = {
  connectionId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class BearerConnectionProfile extends Schema.TaggedClass<BearerConnectionProfile>()(
  "BearerConnectionProfile",
  {
    ...ConnectionProfileBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
  },
) {}

export class SshConnectionProfile extends Schema.TaggedClass<SshConnectionProfile>()(
  "SshConnectionProfile",
  {
    ...ConnectionProfileBase,
    target: DesktopSshEnvironmentTargetSchema,
  },
) {}

export const ConnectionProfile = Schema.Union([BearerConnectionProfile, SshConnectionProfile]);
export type ConnectionProfile = typeof ConnectionProfile.Type;

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
}

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  {
    token: Schema.String,
  },
) {}

export const ConnectionCredential = Schema.Union([BearerConnectionCredential]);
export type ConnectionCredential = typeof ConnectionCredential.Type;

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  {
    target: PrimaryConnectionTarget,
  },
) {}

export class RelayConnectionRegistration extends Schema.TaggedClass<RelayConnectionRegistration>()(
  "RelayConnectionRegistration",
  {
    target: RelayConnectionTarget,
  },
) {}

export class BearerConnectionRegistration extends Schema.TaggedClass<BearerConnectionRegistration>()(
  "BearerConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: BearerConnectionCredential,
  },
) {}

export class SshConnectionRegistration extends Schema.TaggedClass<SshConnectionRegistration>()(
  "SshConnectionRegistration",
  {
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
  },
) {}

export class UnavailableConnectionRegistration extends Schema.TaggedClass<UnavailableConnectionRegistration>()(
  "UnavailableConnectionRegistration",
  {
    target: UnavailableConnectionTarget,
  },
) {}

export const ConnectionRegistration = Schema.Union([
  RelayConnectionRegistration,
  BearerConnectionRegistration,
  SshConnectionRegistration,
]);
export type ConnectionRegistration = typeof ConnectionRegistration.Type;

/**
 * Platform-managed registrations are reconciled from the host (the desktop
 * bootstrap IPC) rather than persisted by the user. They cover the primary
 * local environment plus any additional desktop-local backends running
 * alongside it (e.g. a parallel WSL backend). The primary stays on same-origin
 * cookie auth (`PrimaryConnectionRegistration`); secondary local backends live
 * on a separate loopback origin and authenticate with a bearer token minted
 * from their bootstrap credential (`BearerConnectionRegistration`).
 */
export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  BearerConnectionRegistration,
  UnavailableConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationTarget(
  registration:
    | ConnectionRegistration
    | PrimaryConnectionRegistration
    | UnavailableConnectionRegistration,
): ConnectionTarget {
  return registration.target;
}

export function connectionRegistrationCatalogEntry(
  registration:
    | ConnectionRegistration
    | PrimaryConnectionRegistration
    | UnavailableConnectionRegistration,
): ConnectionCatalogEntry {
  switch (registration._tag) {
    case "PrimaryConnectionRegistration":
    case "RelayConnectionRegistration":
    case "UnavailableConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.none(),
      };
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
      };
  }
}
