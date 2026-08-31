import { describe, expect, it } from "@effect/vitest";

import { computeCompatVerdict } from "./compat.ts";

describe("protocol compatibility verdict", () => {
  it("reports a pre-window server (both fields 0) as legacy", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 0, minCompatibleRemoteProtocol: 0 }),
    ).toEqual({ kind: "legacy" });
  });

  it("reports the current window (1/1) as compatible", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 1, minCompatibleRemoteProtocol: 1 }),
    ).toEqual({ kind: "compatible" });
  });

  it("accepts a newer server that still supports this client's floor", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 5, minCompatibleRemoteProtocol: 1 }),
    ).toEqual({ kind: "compatible" });
  });

  it("accepts a server floor of 0 when the server version is inside the window", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 1, minCompatibleRemoteProtocol: 0 }),
    ).toEqual({ kind: "compatible" });
  });

  it("rejects a server below this client's floor as server-too-old", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 0, minCompatibleRemoteProtocol: 1 }),
    ).toEqual({ kind: "server-too-old", serverVersion: 0, minSupported: 1 });
  });

  it("rejects this client when it is below the server's floor as client-too-old", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 2, minCompatibleRemoteProtocol: 2 }),
    ).toEqual({ kind: "client-too-old", serverMinCompatible: 2, clientVersion: 1 });
  });

  it("reports server-too-old before client-too-old when both checks fail", () => {
    expect(
      computeCompatVerdict({ remoteProtocolVersion: 0, minCompatibleRemoteProtocol: 99 }),
    ).toEqual({ kind: "server-too-old", serverVersion: 0, minSupported: 1 });
  });
});
