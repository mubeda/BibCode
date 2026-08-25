import {
  cacheAssociatedData,
  type CacheAssociatedDataScope,
  type EncryptedCacheEnvelope,
} from "@bibcode/client-runtime/cache";

const AES_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const BASE64_CHUNK_BYTES = 32_768;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function webCrypto(): Crypto {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error("Web Crypto is unavailable.");
  }
  return globalThis.crypto;
}

export async function generateCacheKey(): Promise<CryptoKey> {
  return webCrypto().subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export function generateCacheKeyMaterial(): Uint8Array<ArrayBuffer> {
  return webCrypto().getRandomValues(new Uint8Array(AES_KEY_BYTES));
}

export async function importCacheKeyMaterial(material: Uint8Array): Promise<CryptoKey> {
  return webCrypto().subtle.importKey(
    "raw",
    Uint8Array.from(material),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export function encodeCacheKeyMaterial(material: Uint8Array): string {
  return bytesToBase64(material);
}

export function decodeCacheKeyMaterial(encoded: string): Uint8Array<ArrayBuffer> {
  return base64ToBytes(encoded);
}

export interface EncryptCachePayloadInput {
  readonly scope: CacheAssociatedDataScope;
  readonly serverRevision: number;
  readonly synchronizedAt: string;
  readonly plaintext: string;
}

export async function encryptCachePayload(
  key: CryptoKey,
  input: EncryptCachePayloadInput,
): Promise<EncryptedCacheEnvelope> {
  const nonce = webCrypto().getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: Uint8Array.from(cacheAssociatedData(input.scope)),
    },
    key,
    new TextEncoder().encode(input.plaintext),
  );
  return {
    ...input.scope,
    serverRevision: input.serverRevision,
    synchronizedAt: input.synchronizedAt,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptCachePayload(
  key: CryptoKey,
  envelope: EncryptedCacheEnvelope,
  expectedScope: CacheAssociatedDataScope,
): Promise<string> {
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.nonce),
      additionalData: Uint8Array.from(cacheAssociatedData(expectedScope)),
    },
    key,
    base64ToBytes(envelope.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export function cacheEnvelopeByteLength(envelope: EncryptedCacheEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
}
