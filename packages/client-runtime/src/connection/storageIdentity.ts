import * as Effect from "effect/Effect";
import type { ExecutionEnvironmentDescriptor } from "@bibcode/contracts";

import * as Persistence from "../platform/persistence.ts";
import type { KnownEnvironment } from "./catalog.ts";
import {
  ConnectionBlockedError,
  ConnectionStorageChangedError,
  type ConnectionTarget,
  type EnvironmentRoute,
  type PreparedConnection,
  type VerifiedRouteIdentity,
  type VerifiedRouteTransportTrust,
} from "./model.ts";

export type StorageIdentityDecision =
  | {
      readonly _tag: "Bootstrap";
      readonly reported: string;
    }
  | {
      readonly _tag: "Accepted";
      readonly value: string;
    }
  | {
      readonly _tag: "Changed";
      readonly accepted: string;
      readonly reported: string;
    }
  | {
      readonly _tag: "Unverifiable";
      readonly accepted: string | null;
    };

export function storageIdentityTargetKey(target: ConnectionTarget): string {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
      return "platform:primary";
    case "BearerConnectionTarget":
    case "UnavailableConnectionTarget":
      return `bearer:${target.connectionId}`;
    case "SshConnectionTarget":
      return `ssh:${target.connectionId}`;
  }
}

export function decideStorageIdentity(
  accepted: string | null,
  reported: string | null,
): StorageIdentityDecision {
  if (reported === null) {
    return { _tag: "Unverifiable", accepted };
  }
  if (accepted === null) {
    return { _tag: "Bootstrap", reported };
  }
  if (accepted === reported) {
    return { _tag: "Accepted", value: accepted };
  }
  return { _tag: "Changed", accepted, reported };
}

function identityPersistenceError(prepared: PreparedConnection): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `${prepared.label} persistent storage identity could not be verified.`,
  });
}

const CLIENT_PROTOCOL_MINIMUM = 1;
const CLIENT_PROTOCOL_MAXIMUM = 1;

export function verifyRouteIdentity(input: {
  readonly environment: KnownEnvironment;
  readonly route: EnvironmentRoute;
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly transportTrust: VerifiedRouteTransportTrust;
}): Effect.Effect<VerifiedRouteIdentity, ConnectionBlockedError | ConnectionStorageChangedError> {
  const { environment, route, descriptor, transportTrust } = input;
  if (descriptor.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ConnectionBlockedError({
        reason: "environment-changed",
        detail: `${route.label} reported a different environment identity.`,
      }),
    );
  }
  if (descriptor.storageInstanceId !== environment.acceptedStorageInstanceId) {
    return Effect.fail(
      new ConnectionStorageChangedError({
        reason: "storage-changed",
        detail: `${route.label} is reporting a different persistent store.`,
        targetKey: `environment:${environment.environmentId}`,
        acceptedStorageInstanceId: environment.acceptedStorageInstanceId,
        reportedStorageInstanceId: descriptor.storageInstanceId,
      }),
    );
  }
  if (
    descriptor.protocol.maximum < CLIENT_PROTOCOL_MINIMUM ||
    descriptor.protocol.minimum > CLIENT_PROTOCOL_MAXIMUM
  ) {
    return Effect.fail(
      new ConnectionBlockedError({
        reason: "version-incompatible",
        detail: `${route.label} does not support this client's connection protocol.`,
      }),
    );
  }
  return Effect.succeed({
    routeId: route.routeId,
    environmentId: descriptor.environmentId,
    storageInstanceId: descriptor.storageInstanceId,
    descriptor,
    transportTrust,
  });
}

export const verifyPreparedStorageIdentity = Effect.fn("verifyPreparedStorageIdentity")(function* (
  prepared: PreparedConnection,
  descriptor: ExecutionEnvironmentDescriptor = prepared.descriptor,
) {
  if (prepared.verifiedRouteIdentity !== undefined) {
    const verified = prepared.verifiedRouteIdentity;
    if (descriptor.environmentId !== verified.environmentId) {
      return yield* new ConnectionBlockedError({
        reason: "environment-changed",
        detail: `${prepared.label} changed environment identity after route verification.`,
      });
    }
    if (descriptor.storageInstanceId !== verified.storageInstanceId) {
      return yield* new ConnectionStorageChangedError({
        reason: "storage-changed",
        detail: `${prepared.label} changed persistent stores after route verification.`,
        targetKey: `environment:${verified.environmentId}`,
        acceptedStorageInstanceId: verified.storageInstanceId,
        reportedStorageInstanceId: descriptor.storageInstanceId,
      });
    }
    return;
  }
  const identities = yield* Persistence.AcceptedStorageIdentityStore;
  const targetKey = storageIdentityTargetKey(prepared.target);
  const reported = descriptor.storageInstanceId;
  const decision = yield* identities
    .transition(targetKey, (accepted) => {
      const decision = decideStorageIdentity(accepted, reported);
      return {
        result: decision,
        mutation:
          decision._tag === "Bootstrap"
            ? { _tag: "Set" as const, storageInstanceId: decision.reported }
            : { _tag: "Keep" as const },
      };
    })
    .pipe(Effect.mapError(() => identityPersistenceError(prepared)));

  switch (decision._tag) {
    case "Bootstrap":
    case "Accepted":
    case "Unverifiable":
      return;
    case "Changed":
      return yield* new ConnectionStorageChangedError({
        reason: "storage-changed",
        detail: `${prepared.label} is reporting a different persistent store.`,
        targetKey,
        acceptedStorageInstanceId: decision.accepted,
        reportedStorageInstanceId: decision.reported,
      });
  }
});
