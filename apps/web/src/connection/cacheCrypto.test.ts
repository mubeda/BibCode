import { DurableEnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { CacheAssociatedDataScope } from "@bibcode/client-runtime/cache";

import { decryptCachePayload, encryptCachePayload, generateCacheKey } from "./cacheCrypto.ts";

const ENVIRONMENT_ID = DurableEnvironmentId.make("018f1f52-0d78-7d73-8dc8-7bd50db6f001");
const OTHER_ENVIRONMENT_ID = DurableEnvironmentId.make("018f1f52-0d78-7d73-8dc8-7bd50db6f002");
const STORAGE_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f101";
const scope: CacheAssociatedDataScope = {
  schemaVersion: 1,
  environmentId: ENVIRONMENT_ID,
  storageInstanceId: STORAGE_ID,
  entityKind: "thread",
  entityId: "thread-1",
};

describe("cacheCrypto", () => {
  it("round-trips an AES-GCM payload without making the key exportable", async () => {
    const key = await generateCacheKey();
    const envelope = await encryptCachePayload(key, {
      scope,
      serverRevision: 7,
      synchronizedAt: "2026-08-24T12:00:00.000Z",
      plaintext: '{"private":"content"}',
    });

    expect(key.extractable).toBe(false);
    expect(envelope.ciphertext).not.toContain("private");
    await expect(decryptCachePayload(key, envelope, scope)).resolves.toBe('{"private":"content"}');
  });

  it("rejects ciphertext tampering and a different environment scope", async () => {
    const key = await generateCacheKey();
    const envelope = await encryptCachePayload(key, {
      scope,
      serverRevision: 7,
      synchronizedAt: "2026-08-24T12:00:00.000Z",
      plaintext: "secret",
    });
    const bytes = Uint8Array.from(atob(envelope.ciphertext), (character) =>
      character.charCodeAt(0),
    );
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const tampered = {
      ...envelope,
      ciphertext: btoa(String.fromCharCode(...bytes)),
    };

    await expect(decryptCachePayload(key, tampered, scope)).rejects.toThrow();
    await expect(
      decryptCachePayload(key, envelope, {
        ...scope,
        environmentId: OTHER_ENVIRONMENT_ID,
      }),
    ).rejects.toThrow();
  });
});
