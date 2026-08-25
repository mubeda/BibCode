import { DurableEnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  cacheAssociatedData,
  selectCacheEvictions,
  shouldReplaceCacheEntry,
  type CacheAssociatedDataScope,
  type CacheManifestEntry,
} from "./envelope.ts";

const ENVIRONMENT_ID = DurableEnvironmentId.make("018f1f52-0d78-7d73-8dc8-7bd50db6f001");
const OTHER_ENVIRONMENT_ID = DurableEnvironmentId.make("018f1f52-0d78-7d73-8dc8-7bd50db6f002");
const STORAGE_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f101";

function scope(overrides?: Partial<CacheAssociatedDataScope>): CacheAssociatedDataScope {
  return {
    schemaVersion: 1,
    environmentId: ENVIRONMENT_ID,
    storageInstanceId: STORAGE_ID,
    entityKind: "thread",
    entityId: "thread-1",
    ...overrides,
  };
}

function entry(
  entityId: string,
  byteLength: number,
  lastAccessedAt: string,
  overrides?: Partial<CacheManifestEntry>,
): CacheManifestEntry {
  return {
    entityKind: "thread",
    entityId,
    byteLength,
    serverRevision: 1,
    synchronizedAt: "2026-08-24T12:00:00.000Z",
    lastAccessedAt,
    ...overrides,
  };
}

describe("encrypted cache envelope policy", () => {
  it("serializes every identity boundary into deterministic associated data", () => {
    const encoded = new TextDecoder().decode(cacheAssociatedData(scope()));

    expect(encoded).toBe(
      '[1,"018f1f52-0d78-7d73-8dc8-7bd50db6f001","018f1f52-0d78-7d73-8dc8-7bd50db6f101","thread","thread-1"]',
    );
    expect(cacheAssociatedData(scope())).not.toEqual(
      cacheAssociatedData(scope({ environmentId: OTHER_ENVIRONMENT_ID })),
    );
    expect(cacheAssociatedData(scope())).not.toEqual(
      cacheAssociatedData(scope({ storageInstanceId: "018f1f52-0d78-7d73-8dc8-7bd50db6f102" })),
    );
    expect(cacheAssociatedData(scope())).not.toEqual(
      cacheAssociatedData(scope({ entityKind: "shell", entityId: "shell" })),
    );
  });

  it("rejects stale revisions and accepts an equal revision only when it is newer", () => {
    const current = entry("thread-1", 100, "2026-08-24T12:00:00.000Z", {
      serverRevision: 4,
      synchronizedAt: "2026-08-24T12:00:00.000Z",
    });

    expect(
      shouldReplaceCacheEntry(current, {
        serverRevision: 3,
        synchronizedAt: "2026-08-24T13:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      shouldReplaceCacheEntry(current, {
        serverRevision: 4,
        synchronizedAt: "2026-08-24T11:59:59.000Z",
      }),
    ).toBe(false);
    expect(
      shouldReplaceCacheEntry(current, {
        serverRevision: 4,
        synchronizedAt: "2026-08-24T12:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("evicts expired and least-recently-used entries while protecting selection", () => {
    const entries = [
      entry("expired", 200, "2026-08-24T10:00:00.000Z"),
      entry("oldest", 400, "2026-08-24T11:50:00.000Z"),
      entry("selected", 700, "2026-08-24T11:40:00.000Z"),
      entry("newest", 300, "2026-08-24T11:59:00.000Z"),
    ];

    const evicted = selectCacheEvictions(entries, {
      maxBytes: 1_024,
      maxAgeMs: 3_600_000,
      nowEpochMs: Date.parse("2026-08-24T12:00:00.000Z"),
      protectedEntity: { entityKind: "thread", entityId: "selected" },
    });

    expect(evicted.map((candidate) => candidate.entityId)).toEqual(["expired", "oldest"]);
    expect(evicted.some((candidate) => candidate.entityId === "selected")).toBe(false);
  });
});
