import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const NOISE_NK_PROTOCOL_NAME = "Noise_NK_25519_ChaChaPoly_SHA256";
export const MAX_NOISE_MESSAGE_BYTES = 65_535;
export const NOISE_TAG_BYTES = 16;

const DH_BYTES = 32;
const EMPTY = new Uint8Array(0);
const MAX_NONCE = (1n << 64n) - 1n;
const encoder = new TextEncoder();

export class NoiseProtocolError extends Error {}
export class NoiseAuthenticationError extends Error {}
export class NonceExhaustedError extends Error {
  constructor() {
    super("Noise nonce counter exhausted; the connection must be re-established.");
  }
}

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const hkdf2 = (chainingKey: Uint8Array, inputKeyMaterial: Uint8Array) => {
  const temporaryKey = hmac(sha256, chainingKey, inputKeyMaterial);
  const output1 = hmac(sha256, temporaryKey, Uint8Array.of(0x01));
  const output2 = hmac(sha256, temporaryKey, concat(output1, Uint8Array.of(0x02)));
  return [output1, output2] as const;
};

export interface NoiseCipherState {
  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}

class CipherState implements NoiseCipherState {
  private key: Uint8Array | null = null;
  nonce = 0n;

  initializeKey(key: Uint8Array): void {
    this.key = key;
    this.nonce = 0n;
  }

  private nonceBytes(): Uint8Array {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setBigUint64(4, this.nonce, true);
    return bytes;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.key === null) return plaintext;
    if (this.nonce >= MAX_NONCE) throw new NonceExhaustedError();
    const ciphertext = chacha20poly1305(this.key, this.nonceBytes(), ad).encrypt(plaintext);
    this.nonce += 1n;
    return ciphertext;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.key === null) return ciphertext;
    if (this.nonce >= MAX_NONCE) throw new NonceExhaustedError();
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.key, this.nonceBytes(), ad).decrypt(ciphertext);
    } catch (cause) {
      throw new NoiseAuthenticationError(`AEAD authentication failed: ${String(cause)}`);
    }
    this.nonce += 1n;
    return plaintext;
  }
}

class SymmetricState {
  chainingKey: Uint8Array;
  hash: Uint8Array;
  readonly cipher = new CipherState();

  constructor() {
    const protocolName = encoder.encode(NOISE_NK_PROTOCOL_NAME);
    this.hash = protocolName;
    this.chainingKey = protocolName.slice();
  }

  mixHash(data: Uint8Array): void {
    this.hash = sha256(concat(this.hash, data));
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, temporaryKey] = hkdf2(this.chainingKey, inputKeyMaterial);
    this.chainingKey = chainingKey;
    this.cipher.initializeKey(temporaryKey);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [key1, key2] = hkdf2(this.chainingKey, EMPTY);
    const first = new CipherState();
    first.initializeKey(key1);
    const second = new CipherState();
    second.initializeKey(key2);
    return [first, second];
  }
}

const requireKey = (bytes: Uint8Array, label: string): Uint8Array => {
  if (bytes.length !== DH_BYTES) {
    throw new NoiseProtocolError(`${label} must be ${DH_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
};

const requireMessageSize = (message: Uint8Array, label: string): void => {
  if (message.length > MAX_NOISE_MESSAGE_BYTES) {
    throw new NoiseProtocolError(
      `${label} exceeds the ${MAX_NOISE_MESSAGE_BYTES}-byte Noise message limit`,
    );
  }
};

export const derivePublicKey = (privateKey: Uint8Array): Uint8Array =>
  x25519.getPublicKey(requireKey(privateKey, "private key"));

export interface NkTransport {
  readonly send: NoiseCipherState;
  readonly receive: NoiseCipherState;
  readonly handshakeHash: Uint8Array;
}

export interface NkInitiator {
  writeMessageA(payload: Uint8Array): Uint8Array;
  readMessageB(message: Uint8Array): Uint8Array;
  split(): NkTransport;
}

export interface NkResponder {
  readMessageA(message: Uint8Array): Uint8Array;
  writeMessageB(payload: Uint8Array): Uint8Array;
  split(): NkTransport;
}

export const createNkInitiator = (options: {
  responderStaticPublicKey: Uint8Array;
  prologue?: Uint8Array;
  ephemeralPrivateKey?: Uint8Array;
}): NkInitiator => {
  const responderStatic = requireKey(
    options.responderStaticPublicKey,
    "responder static public key",
  ).slice();
  const state = new SymmetricState();
  state.mixHash(options.prologue ?? EMPTY);
  state.mixHash(responderStatic);
  const ephemeralPrivate = options.ephemeralPrivateKey
    ? requireKey(options.ephemeralPrivateKey, "ephemeral private key").slice()
    : x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  let phase: "a" | "b" | "done" | "split" = "a";

  return {
    writeMessageA(payload) {
      if (phase !== "a") throw new NoiseProtocolError("message A already written");
      state.mixHash(ephemeralPublic);
      state.mixKey(x25519.getSharedSecret(ephemeralPrivate, responderStatic));
      const ciphertext = state.encryptAndHash(payload);
      const message = concat(ephemeralPublic, ciphertext);
      requireMessageSize(message, "message A");
      phase = "b";
      return message;
    },
    readMessageB(message) {
      if (phase !== "b") throw new NoiseProtocolError("message B out of order");
      requireMessageSize(message, "message B");
      if (message.length < DH_BYTES + NOISE_TAG_BYTES) {
        throw new NoiseProtocolError("message B is too short");
      }
      const remoteEphemeral = message.slice(0, DH_BYTES);
      state.mixHash(remoteEphemeral);
      state.mixKey(x25519.getSharedSecret(ephemeralPrivate, remoteEphemeral));
      const payload = state.decryptAndHash(message.slice(DH_BYTES));
      phase = "done";
      return payload;
    },
    split() {
      if (phase !== "done") throw new NoiseProtocolError("handshake incomplete");
      phase = "split";
      const [send, receive] = state.split();
      return { send, receive, handshakeHash: state.hash.slice() };
    },
  };
};

export const createNkResponder = (options: {
  staticPrivateKey: Uint8Array;
  prologue?: Uint8Array;
  ephemeralPrivateKey?: Uint8Array;
}): NkResponder => {
  const staticPrivate = requireKey(options.staticPrivateKey, "static private key").slice();
  const staticPublic = x25519.getPublicKey(staticPrivate);
  const state = new SymmetricState();
  state.mixHash(options.prologue ?? EMPTY);
  state.mixHash(staticPublic);
  const ephemeralPrivate = options.ephemeralPrivateKey
    ? requireKey(options.ephemeralPrivateKey, "ephemeral private key").slice()
    : x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  let remoteEphemeral: Uint8Array | null = null;
  let phase: "a" | "b" | "done" | "split" = "a";

  return {
    readMessageA(message) {
      if (phase !== "a") throw new NoiseProtocolError("message A out of order");
      requireMessageSize(message, "message A");
      if (message.length < DH_BYTES + NOISE_TAG_BYTES) {
        throw new NoiseProtocolError("message A is too short");
      }
      remoteEphemeral = message.slice(0, DH_BYTES);
      state.mixHash(remoteEphemeral);
      state.mixKey(x25519.getSharedSecret(staticPrivate, remoteEphemeral));
      const payload = state.decryptAndHash(message.slice(DH_BYTES));
      phase = "b";
      return payload;
    },
    writeMessageB(payload) {
      if (phase !== "b" || remoteEphemeral === null) {
        throw new NoiseProtocolError("message B out of order");
      }
      state.mixHash(ephemeralPublic);
      state.mixKey(x25519.getSharedSecret(ephemeralPrivate, remoteEphemeral));
      const ciphertext = state.encryptAndHash(payload);
      const message = concat(ephemeralPublic, ciphertext);
      requireMessageSize(message, "message B");
      phase = "done";
      return message;
    },
    split() {
      if (phase !== "done") throw new NoiseProtocolError("handshake incomplete");
      phase = "split";
      const [initiatorToResponder, responderToInitiator] = state.split();
      return {
        send: responderToInitiator,
        receive: initiatorToResponder,
        handshakeHash: state.hash.slice(),
      };
    },
  };
};

export const decodeBase64UrlKey = (encoded: string): Uint8Array => {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary =
      typeof Buffer !== "undefined"
        ? Buffer.from(padded, "base64").toString("binary")
        : atob(padded);
  } catch (cause) {
    throw new NoiseProtocolError(`host key is not base64url: ${String(cause)}`);
  }
  return requireKey(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    "host key",
  );
};
