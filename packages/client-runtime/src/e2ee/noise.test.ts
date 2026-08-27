import { describe, expect, it } from "@effect/vitest";

import {
  MAX_NOISE_MESSAGE_BYTES,
  NoiseAuthenticationError,
  NonceExhaustedError,
  createNkInitiator,
  createNkResponder,
  decodeBase64UrlKey,
  derivePublicKey,
} from "./noise.ts";

const hex = (value: string): Uint8Array =>
  value === "" ? new Uint8Array(0) : Uint8Array.from(Buffer.from(value, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

// Source: https://raw.githubusercontent.com/mcginty/snow/main/tests/vectors/cacophony.txt
// Retrieved 2026-08-27. This object is the corpus's NK/25519/ChaChaPoly/SHA256 entry verbatim.
const OFFICIAL_NK_VECTOR = {
  protocol_name: "Noise_NK_25519_ChaChaPoly_SHA256",
  init_prologue: "4a6f686e2047616c74",
  init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  init_remote_static: "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
  resp_prologue: "4a6f686e2047616c74",
  resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  resp_ephemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  handshake_hash: "2efa38a9c7c93ac98f3a097af25c2f58b9e7673787717bc27e98827118c2c1a5",
  messages: [
    {
      payload: "4c756477696720766f6e204d69736573",
      ciphertext:
        "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79448134d00711fdb390a0d178fa008f6d47d2891e5ea18ae136c3b4c23ac384efb0",
    },
    {
      payload: "4d757272617920526f746862617264",
      ciphertext:
        "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088438ea16e3701bc0d77744f117bee22451c9afa7f4cdbbcff00c04a8ee0913c88",
    },
    {
      payload: "462e20412e20486179656b",
      ciphertext: "a62de29ce27cb80245d440d986ed816c156e9d757d7008df2198b0",
    },
    {
      payload: "4361726c204d656e676572",
      ciphertext: "174a35f11c689f4530d7208618e0564ae12f2f50ba8eb4df5382ff",
    },
    {
      payload: "4a65616e2d426170746973746520536179",
      ciphertext: "337e475ebb8eae60f91974c4e455a5af38d1d8628d1803b160d60442874b0a1777",
    },
    {
      payload: "457567656e2042f6686d20766f6e2042617765726b",
      ciphertext: "047e80e060b7bb08b53c5a23dfe9920cae135b9d1dc6302fc475003062723700366346ac9d",
    },
  ],
} as const;

describe("Noise NK against the official vector", () => {
  it("initiator reproduces message A and decrypts message B", () => {
    const initiator = createNkInitiator({
      responderStaticPublicKey: hex(OFFICIAL_NK_VECTOR.init_remote_static),
      prologue: hex(OFFICIAL_NK_VECTOR.init_prologue),
      ephemeralPrivateKey: hex(OFFICIAL_NK_VECTOR.init_ephemeral),
    });
    const messageA = initiator.writeMessageA(hex(OFFICIAL_NK_VECTOR.messages[0].payload));
    expect(toHex(messageA)).toBe(OFFICIAL_NK_VECTOR.messages[0].ciphertext);
    const payloadB = initiator.readMessageB(hex(OFFICIAL_NK_VECTOR.messages[1].ciphertext));
    expect(toHex(payloadB)).toBe(OFFICIAL_NK_VECTOR.messages[1].payload);
    const transport = initiator.split();
    expect(toHex(transport.handshakeHash)).toBe(OFFICIAL_NK_VECTOR.handshake_hash);
    for (let index = 2; index < OFFICIAL_NK_VECTOR.messages.length; index += 1) {
      const message = OFFICIAL_NK_VECTOR.messages[index];
      if (message === undefined) throw new Error(`missing official vector message ${index}`);
      const fromInitiator = index % 2 === 0;
      const cipher = fromInitiator ? transport.send : transport.receive;
      const produced = fromInitiator
        ? cipher.encryptWithAd(new Uint8Array(0), hex(message.payload))
        : cipher.decryptWithAd(new Uint8Array(0), hex(message.ciphertext));
      expect(toHex(produced)).toBe(fromInitiator ? message.ciphertext : message.payload);
    }
  });

  it("responder reproduces the vector from the other side", () => {
    const responder = createNkResponder({
      staticPrivateKey: hex(OFFICIAL_NK_VECTOR.resp_static),
      prologue: hex(OFFICIAL_NK_VECTOR.resp_prologue),
      ephemeralPrivateKey: hex(OFFICIAL_NK_VECTOR.resp_ephemeral),
    });
    const payloadA = responder.readMessageA(hex(OFFICIAL_NK_VECTOR.messages[0].ciphertext));
    expect(toHex(payloadA)).toBe(OFFICIAL_NK_VECTOR.messages[0].payload);
    const messageB = responder.writeMessageB(hex(OFFICIAL_NK_VECTOR.messages[1].payload));
    expect(toHex(messageB)).toBe(OFFICIAL_NK_VECTOR.messages[1].ciphertext);
  });
});

describe("Noise NK self round-trip", () => {
  const establish = () => {
    const responderStatic = crypto.getRandomValues(new Uint8Array(32));
    const responder = createNkResponder({ staticPrivateKey: responderStatic });
    const initiator = createNkInitiator({
      responderStaticPublicKey: derivePublicKey(responderStatic),
    });
    responder.readMessageA(initiator.writeMessageA(new Uint8Array(0)));
    initiator.readMessageB(responder.writeMessageB(new Uint8Array(0)));
    return { client: initiator.split(), server: responder.split() };
  };

  it("round-trips transport messages both directions", () => {
    const { client, server } = establish();
    const empty = new Uint8Array(0);
    const outbound = client.send.encryptWithAd(empty, Uint8Array.from([1, 2, 3]));
    expect(server.receive.decryptWithAd(empty, outbound)).toEqual(Uint8Array.from([1, 2, 3]));
    const inbound = server.send.encryptWithAd(empty, Uint8Array.from([4, 5]));
    expect(client.receive.decryptWithAd(empty, inbound)).toEqual(Uint8Array.from([4, 5]));
  });

  it("wrong pinned key makes message B fail authentication", () => {
    const responder = createNkResponder({
      staticPrivateKey: crypto.getRandomValues(new Uint8Array(32)),
    });
    const initiator = createNkInitiator({
      responderStaticPublicKey: crypto.getRandomValues(new Uint8Array(32)),
    });
    const messageA = initiator.writeMessageA(new Uint8Array(0));
    expect(() => responder.readMessageA(messageA)).toThrow(NoiseAuthenticationError);
  });

  it("tampered transport frames fail authentication", () => {
    const { client, server } = establish();
    const empty = new Uint8Array(0);
    const frame = client.send.encryptWithAd(empty, Uint8Array.from([9]));
    const finalIndex = frame.length - 1;
    frame[finalIndex] = (frame[finalIndex] ?? 0) ^ 1;
    expect(() => server.receive.decryptWithAd(empty, frame)).toThrow(NoiseAuthenticationError);
  });

  it("exhausted nonce counters refuse to encrypt", () => {
    const { client } = establish();
    (client.send as unknown as { nonce: bigint }).nonce = (1n << 64n) - 1n;
    expect(() => client.send.encryptWithAd(new Uint8Array(0), new Uint8Array(1))).toThrow(
      NonceExhaustedError,
    );
  });

  it("decodes base64url host keys and rejects wrong lengths", () => {
    expect(decodeBase64UrlKey("HcMLXPPBHFNvcbHrCVMH-DMh49rd5AGCzSCqAVJ49hM")).toHaveLength(32);
    expect(() => decodeBase64UrlKey("dG9vLXNob3J0")).toThrow();
  });

  it("pins the Noise message size to the protocol maximum", () => {
    expect(MAX_NOISE_MESSAGE_BYTES).toBe(65_535);
  });
});
