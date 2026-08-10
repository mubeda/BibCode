import type { ConnectionTarget } from "./model.ts";

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
