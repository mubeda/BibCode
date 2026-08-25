import {
  DurableEnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "@bibcode/contracts";
import * as Schema from "effect/Schema";

const StorageInstanceId = Schema.String.check(Schema.isUUID());

export const CacheEntityKind = Schema.Literals(["shell", "thread"]);
export type CacheEntityKind = typeof CacheEntityKind.Type;

/** Values authenticated as AES-GCM additional data and never inferred from the ciphertext. */
export const CacheAssociatedDataScope = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: DurableEnvironmentId,
  storageInstanceId: StorageInstanceId,
  entityKind: CacheEntityKind,
  entityId: TrimmedNonEmptyString,
});
export type CacheAssociatedDataScope = typeof CacheAssociatedDataScope.Type;

export const EncryptedCacheEnvelope = Schema.Struct({
  ...CacheAssociatedDataScope.fields,
  serverRevision: NonNegativeInt,
  synchronizedAt: IsoDateTime,
  nonce: TrimmedNonEmptyString,
  ciphertext: TrimmedNonEmptyString,
});
export type EncryptedCacheEnvelope = typeof EncryptedCacheEnvelope.Type;

export const CacheManifestEntry = Schema.Struct({
  entityKind: CacheEntityKind,
  entityId: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
  serverRevision: NonNegativeInt,
  synchronizedAt: IsoDateTime,
  lastAccessedAt: IsoDateTime,
});
export type CacheManifestEntry = typeof CacheManifestEntry.Type;

export const CacheQuarantineReason = Schema.Literals([
  "storage-identity-mismatch",
  "scope-mismatch",
  "authentication-failed",
  "payload-invalid",
]);
export type CacheQuarantineReason = typeof CacheQuarantineReason.Type;

export const CacheQuarantineEntry = Schema.Struct({
  entityKind: CacheEntityKind,
  entityId: TrimmedNonEmptyString,
  reason: CacheQuarantineReason,
  quarantinedAt: IsoDateTime,
});
export type CacheQuarantineEntry = typeof CacheQuarantineEntry.Type;

export interface CacheRevisionCandidate {
  readonly serverRevision: number;
  readonly synchronizedAt: string;
}

export interface CacheEvictionOptions {
  readonly maxBytes: number;
  readonly maxAgeMs: number;
  readonly nowEpochMs: number;
  readonly protectedEntity?: {
    readonly entityKind: CacheEntityKind;
    readonly entityId: string;
  } | null;
}

export function cacheAssociatedData(scope: CacheAssociatedDataScope): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      scope.schemaVersion,
      scope.environmentId,
      scope.storageInstanceId,
      scope.entityKind,
      scope.entityId,
    ]),
  );
}

export function shouldReplaceCacheEntry(
  current: CacheManifestEntry | undefined,
  candidate: CacheRevisionCandidate,
): boolean {
  if (current === undefined) return true;
  if (candidate.serverRevision !== current.serverRevision) {
    return candidate.serverRevision > current.serverRevision;
  }
  return Date.parse(candidate.synchronizedAt) > Date.parse(current.synchronizedAt);
}

function sameEntity(
  entry: CacheManifestEntry,
  entity: CacheEvictionOptions["protectedEntity"],
): boolean {
  return (
    entity !== null &&
    entity !== undefined &&
    entry.entityKind === entity.entityKind &&
    entry.entityId === entity.entityId
  );
}

/** Returns a stable deletion order without mutating the supplied manifest entries. */
export function selectCacheEvictions(
  entries: ReadonlyArray<CacheManifestEntry>,
  options: CacheEvictionOptions,
): ReadonlyArray<CacheManifestEntry> {
  let retainedBytes = entries.reduce((total, entry) => total + entry.byteLength, 0);
  const candidates = entries
    .filter((entry) => !sameEntity(entry, options.protectedEntity))
    .toSorted((left, right) => {
      const leftExpired = options.nowEpochMs - Date.parse(left.synchronizedAt) > options.maxAgeMs;
      const rightExpired = options.nowEpochMs - Date.parse(right.synchronizedAt) > options.maxAgeMs;
      return (
        Number(rightExpired) - Number(leftExpired) ||
        Date.parse(left.lastAccessedAt) - Date.parse(right.lastAccessedAt) ||
        left.entityKind.localeCompare(right.entityKind) ||
        left.entityId.localeCompare(right.entityId)
      );
    });
  const evicted: CacheManifestEntry[] = [];

  for (const candidate of candidates) {
    const expired = options.nowEpochMs - Date.parse(candidate.synchronizedAt) > options.maxAgeMs;
    if (!expired && retainedBytes <= options.maxBytes) break;
    evicted.push(candidate);
    retainedBytes -= candidate.byteLength;
  }
  return evicted;
}
