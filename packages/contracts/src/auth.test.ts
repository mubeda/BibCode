import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AuthPairingLink } from "./auth.ts";

const authPairingLinkJsonCodec = Schema.toCodecJson(AuthPairingLink);
const decodeAuthPairingLink = Schema.decodeUnknownSync(authPairingLinkJsonCodec);
const encodeAuthPairingLink = Schema.encodeUnknownSync(authPairingLinkJsonCodec);

describe("pairing administration contracts", () => {
  it("exposes metadata only and never serializes the one-time credential or scopes", () => {
    const encoded = encodeAuthPairingLink(
      decodeAuthPairingLink({
        id: "pairing-1",
        credentialFingerprint: "sha256:91b7e2e2d164",
        clientLabel: "Work laptop",
        createdAt: "2026-08-25T12:00:00.000Z",
        expiresAt: "2026-08-25T12:05:00.000Z",
      }),
    );

    expect(encoded).toEqual({
      id: "pairing-1",
      credentialFingerprint: "sha256:91b7e2e2d164",
      clientLabel: "Work laptop",
      createdAt: "2026-08-25T12:00:00.000Z",
      expiresAt: "2026-08-25T12:05:00.000Z",
    });
    expect(JSON.stringify(encoded)).not.toContain('credential"');
    expect(JSON.stringify(encoded)).not.toContain("scopes");
    expect(JSON.stringify(encoded)).not.toContain("subject");
  });

  it("uses an explicit null client label", () => {
    expect(
      decodeAuthPairingLink({
        id: "pairing-2",
        credentialFingerprint: "sha256:df9ecf4c79e5",
        clientLabel: null,
        createdAt: "2026-08-25T12:00:00.000Z",
        expiresAt: "2026-08-25T12:05:00.000Z",
      }).clientLabel,
    ).toBeNull();
  });
});
