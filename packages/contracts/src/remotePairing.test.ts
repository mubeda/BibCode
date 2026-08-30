// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  E2eeAuthenticatedMessage,
  E2eeAuthMessage,
  E2eeErrorMessage,
  REMOTE_PAIRING_CODE_VERSION,
  RemotePairingCodePayload,
  RemotePairingReach,
} from "./remotePairing.ts";

const fixtureDirectory = NodePath.resolve(import.meta.dirname, "../fixtures/remote-pairing");
const readFixture = (name: string): string =>
  NodeFS.readFileSync(NodePath.join(fixtureDirectory, name), "utf8");

const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(RemotePairingCodePayload));
const decodeAuth = Schema.decodeUnknownSync(E2eeAuthMessage);
const decodeReady = Schema.decodeUnknownSync(E2eeAuthenticatedMessage);
const decodeError = Schema.decodeUnknownSync(E2eeErrorMessage);

describe("remote pairing contract", () => {
  it("decodes the canonical payload fixture", () => {
    const payload = decodePayload(readFixture("payload.json").trim());
    expect(payload.v).toBe(REMOTE_PAIRING_CODE_VERSION);
    expect(payload.endpoint).toBe("http://192.168.1.20:3773");
    expect(payload.name).toBe("AI-SERVER");
    expect(payload.reach).toBe("another-device");
    expect(payload.hostKey).toHaveLength(43);
  });

  it("the encoded code fixture is base64url of the payload fixture", () => {
    const code = readFixture("code.txt").trim();
    const decoded = Buffer.from(code, "base64url").toString("utf8");
    expect(JSON.parse(decoded)).toEqual(JSON.parse(readFixture("payload.json")));
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects an unsupported payload version at the schema level", () => {
    expect(() => decodePayload(readFixture("unsupported-version.json").trim())).toThrow();
  });

  it("covers all reach values", () => {
    expect([...RemotePairingReach.literals]).toEqual(["another-device", "this-computer", "custom"]);
  });

  it("round-trips the channel control messages", () => {
    const pairingForm = decodeAuth({
      type: "e2ee_auth",
      pairing: "one-time",
      pairingConfirmation: true,
    });
    expect("pairing" in pairingForm && pairingForm.pairing).toBe("one-time");
    expect("pairingConfirmation" in pairingForm && pairingForm.pairingConfirmation).toBe(true);
    expect(decodeAuth({ type: "e2ee_auth", pairing: "legacy" })).toEqual({
      type: "e2ee_auth",
      pairing: "legacy",
    });
    const bearerForm = decodeAuth({ type: "e2ee_auth", bearer: "stored" });
    expect("bearer" in bearerForm && bearerForm.bearer).toBe("stored");

    expect(decodeReady({ type: "e2ee_authenticated" }).type).toBe("e2ee_authenticated");
    const minted = decodeReady({
      type: "e2ee_authenticated",
      credential: "bearer-token",
      environmentId: "env-1",
      storageInstanceId: "3f2f6a52-6f5f-4f4e-9d38-0a1e2ac21d11",
      pairingConfirmationRequired: true,
    });
    expect(minted.credential).toBe("bearer-token");
    expect(minted.environmentId).toBe("env-1");
    expect(minted.pairingConfirmationRequired).toBe(true);

    expect(decodeError({ type: "e2ee_error", code: "unauthorized" }).code).toBe("unauthorized");
  });
});
