import { describe, expect, it, vi } from "@effect/vitest";
import { buildBrowserPairUrl, buildPairingDeepLink } from "@bibcode/shared/pairingCode";

import { generateShareOffer, resolveShareAddressOptions } from "./shareOffer.ts";

const wideState = {
  mode: "network-accessible" as const,
  endpointUrl: "http://192.168.1.20:3773",
  advertisedHost: "192.168.1.20",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};

const loopbackState = {
  ...wideState,
  mode: "local-only" as const,
  endpointUrl: null,
  advertisedHost: null,
};

const defaultDeps = {
  newIdempotencyKey: () => "key-1",
  classifyMintError: (): "retryable" | "fatal" => "retryable",
  cleanupExposureAfterFailedMint: null,
  sleep: async () => {},
};

describe("share offer links", () => {
  it("builds the deep link and browser URL from one code", () => {
    expect(buildPairingDeepLink("abc123")).toBe("bibcode://pair?code=abc123");
    expect(buildBrowserPairUrl("http://192.168.1.20:3773", "abc123")).toBe(
      "http://192.168.1.20:3773/pair?code=abc123",
    );
  });
});

describe("generateShareOffer", () => {
  it("widens before minting for another-device on a loopback desktop", async () => {
    const calls: string[] = [];
    const applyServerExposure = vi.fn(async () => {
      calls.push("widen");
      return wideState;
    });
    const mintOffer = vi.fn(async (input: { endpoint: string }) => {
      calls.push("mint");
      return {
        code: "c0de",
        endpoint: input.endpoint,
        name: "AI-SERVER",
        expiresAt: "2026-08-27T01:00:00.000Z",
      };
    });
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure,
      mintOffer,
      ...defaultDeps,
    });
    expect(calls).toEqual(["widen", "mint"]);
    expect(result).toMatchObject({
      ok: true,
      offer: { endpoint: "http://192.168.1.20:3773", deepLink: "bibcode://pair?code=c0de" },
    });
  });

  it("fails visibly without minting when widening fails", async () => {
    const mintOffer = vi.fn();
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => {
        throw new Error("Could not change server exposure; reverted to local-only: bind failed.");
      },
      mintOffer,
      ...defaultDeps,
    });
    expect(mintOffer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, failure: { kind: "widen-failed" } });
  });

  it("never widens for this-computer offers", async () => {
    const applyServerExposure = vi.fn();
    const result = await generateShareOffer({
      intent: "this-computer",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: {
        id: "primary",
        label: "This computer",
        httpBaseUrl: "http://127.0.0.1:3773",
      },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure,
      mintOffer: async (input) => ({
        code: "c0de",
        endpoint: input.endpoint,
        name: input.name,
        expiresAt: "2026-08-27T01:00:00.000Z",
      }),
      ...defaultDeps,
    });
    expect(applyServerExposure).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, offer: { endpointClass: "loopback" } });
  });

  it("retries retryable mint failures with one stable idempotency key", async () => {
    let attempts = 0;
    const seenKeys = new Set<string>();
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: wideState,
      applyServerExposure: async () => wideState,
      mintOffer: async (input) => {
        attempts += 1;
        seenKeys.add(input.idempotencyKey);
        if (attempts < 3) throw new Error("connection re-establishing");
        return {
          code: "c0de",
          endpoint: input.endpoint,
          name: input.name,
          expiresAt: "2026-08-27T01:00:00.000Z",
        };
      },
      ...defaultDeps,
    });
    expect(attempts).toBe(3);
    expect(seenKeys.size).toBe(1);
    expect(result).toMatchObject({ ok: true });
  });

  it("never retries fatal mint failures", async () => {
    const mintOffer = vi.fn(async () => {
      throw new Error("invalid_pairing_offer");
    });
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: wideState,
      applyServerExposure: async () => wideState,
      mintOffer,
      ...defaultDeps,
      classifyMintError: () => "fatal",
    });
    expect(mintOffer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, failure: { kind: "mint-failed" } });
  });

  it("caps retryable mint attempts at five", async () => {
    const mintOffer = vi.fn(async () => {
      throw new Error("still unreachable");
    });
    const sleep = vi.fn(async () => {});
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: wideState,
      applyServerExposure: async () => wideState,
      mintOffer,
      ...defaultDeps,
      sleep,
    });
    expect(mintOffer).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ ok: false, failure: { kind: "mint-failed" } });
  });

  it("restores local-only exposure after widening when every mint attempt fails", async () => {
    const cleanupExposureAfterFailedMint = vi.fn(async () => "narrowed" as const);
    const mintOffer = vi.fn(async () => {
      throw new Error("still unreachable");
    });
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => wideState,
      mintOffer,
      ...defaultDeps,
      cleanupExposureAfterFailedMint,
    });

    expect(mintOffer).toHaveBeenCalledTimes(5);
    expect(cleanupExposureAfterFailedMint).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "mint-failed", widened: true, cleanup: "restored" },
    });
  });

  it("reports a failed exposure cleanup alongside the mint error", async () => {
    const cleanupExposureAfterFailedMint = vi.fn(async () => {
      throw new Error("firewall cleanup failed");
    });
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => wideState,
      mintOffer: async () => {
        throw new Error("mint failed");
      },
      ...defaultDeps,
      classifyMintError: () => "fatal",
      cleanupExposureAfterFailedMint,
    });

    expect(cleanupExposureAfterFailedMint).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "mint-failed",
        widened: true,
        cleanup: "failed",
        message: expect.stringContaining("firewall cleanup failed"),
      },
    });
  });

  it("does not run exposure cleanup when the ceremony did not widen", async () => {
    const cleanupExposureAfterFailedMint = vi.fn(async () => "narrowed" as const);
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: {
        id: "existing-wide",
        label: "Existing wide endpoint",
        httpBaseUrl: wideState.endpointUrl,
      },
      hasDesktopBridge: true,
      exposureState: wideState,
      applyServerExposure: async () => wideState,
      mintOffer: async () => {
        throw new Error("mint failed");
      },
      ...defaultDeps,
      classifyMintError: () => "fatal",
      cleanupExposureAfterFailedMint,
    });

    expect(cleanupExposureAfterFailedMint).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "mint-failed", widened: false, cleanup: "not-needed" },
    });
  });

  it("classifies a loopback custom address without widening", async () => {
    const applyServerExposure = vi.fn(async () => wideState);
    const result = await generateShareOffer({
      intent: "custom",
      name: "AI-SERVER",
      customAddress: "http://127.0.0.1:9022",
      selectedOption: { id: "custom", label: "Custom address", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure,
      mintOffer: async (input) => ({
        code: "c0de",
        endpoint: input.endpoint,
        name: input.name,
        expiresAt: "2026-08-27T01:00:00.000Z",
      }),
      ...defaultDeps,
    });
    expect(applyServerExposure).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      offer: { endpointClass: "loopback", reach: "custom" },
    });
  });

  it("rejects unconnectable custom addresses before widening or minting", async () => {
    const applyServerExposure = vi.fn();
    const mintOffer = vi.fn();
    const result = await generateShareOffer({
      intent: "custom",
      name: "AI-SERVER",
      customAddress: "http://0.0.0.0:3773",
      selectedOption: { id: "custom", label: "Custom address", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure,
      mintOffer,
      ...defaultDeps,
    });
    expect(applyServerExposure).not.toHaveBeenCalled();
    expect(mintOffer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid-address" } });
  });
});

describe("resolveShareAddressOptions", () => {
  it("offers automatic LAN plus non-loopback advertised endpoints for another-device", () => {
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [
        {
          id: "tailscale-https",
          label: "Tailscale HTTPS",
          provider: {
            id: "tailscale",
            label: "Tailscale",
            kind: "private-network",
            isAddon: true,
          },
          httpBaseUrl: "https://machine.tailnet.ts.net/",
          wsBaseUrl: "wss://machine.tailnet.ts.net/",
          reachability: "private-network",
          compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
          source: "desktop-addon",
          status: "available",
        },
      ],
      exposureState: loopbackState,
      primaryHttpBaseUrl: "http://127.0.0.1:3773",
    });
    expect(options[0]).toMatchObject({ id: "auto-lan", httpBaseUrl: null });
    expect(options.some((option) => option.httpBaseUrl === "https://machine.tailnet.ts.net/")).toBe(
      true,
    );
  });

  it("offers only the loopback primary endpoint for this-computer", () => {
    const options = resolveShareAddressOptions({
      intent: "this-computer",
      advertisedEndpoints: [],
      exposureState: loopbackState,
      primaryHttpBaseUrl: "http://127.0.0.1:3773",
    });
    expect(options).toEqual([
      {
        id: "primary",
        label: "This computer",
        httpBaseUrl: "http://127.0.0.1:3773",
        description: "Only clients on this machine (or a tunnel into it) can use this offer.",
      },
    ]);
  });

  it("uses the current server URL as the automatic browser-mode address", () => {
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [],
      exposureState: null,
      primaryHttpBaseUrl: "https://server.example.com/",
    });
    expect(options[0]).toMatchObject({
      id: "auto-lan",
      httpBaseUrl: "https://server.example.com/",
    });
  });
});
