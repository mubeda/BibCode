import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Persistence from "../platform/persistence.ts";
import {
  ConnectionBlockedError,
  ConnectionStorageChangedError,
  type ConnectionTarget,
  type PreparedConnection,
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
      return `bearer:${target.connectionId}`;
    case "RelayConnectionTarget":
      return `relay:${target.environmentId}`;
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

export const verifyPreparedStorageIdentity = Effect.fn("verifyPreparedStorageIdentity")(function* (
  prepared: PreparedConnection,
) {
  const identities = yield* Persistence.AcceptedStorageIdentityStore;
  const targetKey = storageIdentityTargetKey(prepared.target);
  const accepted = yield* identities.get(targetKey).pipe(
    Effect.map(Option.getOrNull),
    Effect.mapError(() => identityPersistenceError(prepared)),
  );
  const reported = prepared.descriptor.storageInstanceId;
  const decision = decideStorageIdentity(accepted, reported);

  switch (decision._tag) {
    case "Bootstrap":
      yield* identities
        .accept({ targetKey, storageInstanceId: decision.reported })
        .pipe(Effect.mapError(() => identityPersistenceError(prepared)));
      return;
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
