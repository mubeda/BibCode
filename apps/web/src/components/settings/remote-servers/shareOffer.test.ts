import { describe, expect, it, vi } from "@effect/vitest";
import type { AdvertisedEndpoint } from "@bibcode/contracts";
import { buildBrowserPairUrl, buildPairingDeepLink } from "@bibcode/shared/pairingCode";

import {
  describeWidenFailure,
  generateShareOffer,
  nativeShareAddressUnavailableReason,
  resolveShareAddressOptions,
} from "./shareOffer.ts";

const RESTORED = "Restored local-only safeguards.";

describe("describeWidenFailure", () => {
  it("explains missing administrator permission from the desktop's string rejection", () => {
    expect(
      describeWidenFailure(
        `Could not apply server exposure network-accessible: open remote-access firewall rule: firewall-elevation-required. ${RESTORED}`,
      ),
    ).toEqual({
      reason: "elevation-required",
      message:
        "Windows needs administrator permission to open the firewall for BiBCode, so remote access was not turned on. This computer is still local-only. Try again and approve the Windows permission prompt, or close BiBCode, start it with Run as administrator, and try again.",
    });
  });

  it.each([
    ["firewall-add-failed", "BiBCode could not add its Windows Firewall rule"],
    ["firewall-remove-failed", "BiBCode could not replace its old Windows Firewall rule"],
    ["firewall-read-failed", "BiBCode could not read the Windows Firewall rules"],
    ["firewall-timed-out", "the Windows Firewall change took too long"],
    ["firewall-unavailable", "the Windows Firewall step could not run"],
  ])("names the failed firewall step for %s", (token, step) => {
    expect(
      describeWidenFailure(new Error(`open remote-access firewall rule: ${token}. ${RESTORED}`)),
    ).toEqual({
      message: `Remote access was not turned on: ${step}. This computer is still local-only. Try again.`,
    });
  });

  it("does not claim local-only when recovery could not confirm it", () => {
    expect(
      describeWidenFailure(
        "Could not apply server exposure network-accessible: open remote-access firewall rule: firewall-add-failed. Local-only recovery also reported: stop failed.",
      ).message,
    ).toContain("BiBCode could not confirm that this computer is back to local-only");
  });

  it("keeps a string rejection's own reason instead of the generic text", () => {
    expect(
      describeWidenFailure("  restart did not produce a network-accessible endpoint "),
    ).toEqual({ message: "restart did not produce a network-accessible endpoint" });
    expect(describeWidenFailure("x".repeat(600)).message).toHaveLength(500);
    expect(describeWidenFailure(undefined)).toEqual({ message: "Could not enable remote access." });
  });
});

const wideState = {
  configuredMode: "network-accessible" as const,
  management: "native" as const,
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
  requestTimeoutMs: 1_000,
  newIdempotencyKey: () => "key-1",
  classifyMintError: (): "retryable" | "fatal" => "retryable",
  cancelOffer: async () => {},
  cleanupExposureAfterFailedMint: null,
  sleep: async () => {},
};

function localOnlyObservation(
  idPrefix: string,
  host: string,
  reachability: AdvertisedEndpoint["reachability"],
  isDefault: boolean | undefined,
): AdvertisedEndpoint {
  return {
    id: `${idPrefix}:${host}:3773`,
    label: reachability === "lan" ? "Local network" : "Private network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: `http://${host}:3773/`,
    wsBaseUrl: `ws://${host}:3773/`,
    reachability,
    compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
    source: "desktop-core",
    status: "unavailable",
    unavailableReason: "local-only",
    ...(isDefault === undefined ? {} : { isDefault }),
  };
}

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

  it("keeps the port of an externally served HTTPS address when widening", async () => {
    const mintOffer = vi.fn(async (input: { endpoint: string }) => ({
      code: "c0de",
      endpoint: input.endpoint,
      name: "AI-SERVER",
      expiresAt: "2026-08-27T01:00:00.000Z",
    }));
    await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: {
        id: "tailscale-magicdns:https://machine.tailnet.ts.net/",
        label: "machine.tailnet.ts.net",
        httpBaseUrl: "https://machine.tailnet.ts.net/",
      },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => ({ ...wideState, endpointUrl: "http://192.168.1.20:3774" }),
      mintOffer,
      ...defaultDeps,
    });
    expect(mintOffer).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://machine.tailnet.ts.net/" }),
    );
  });

  it.each([
    [
      "firewall-prompt-open",
      "A Windows permission prompt for the BiBCode firewall rule is still open, so remote access was not turned on. This computer is still local-only. Answer or close that prompt, then try again.",
    ],
    [
      "firewall-rule-removed-not-added",
      "BiBCode removed its old Windows Firewall rule, which named an earlier install, but the new rule was not added, so remote access was not turned on. This computer is still local-only. Try again and approve the Windows permission prompt.",
    ],
  ])("explains %s", (token, message) => {
    expect(
      describeWidenFailure(
        `Could not apply server exposure network-accessible: open remote-access firewall rule: ${token}. No exposure change was made.`,
      ).message,
    ).toBe(message);
  });

  it("keeps the chosen host but takes the port the widened server listens on", async () => {
    const mintOffer = vi.fn(async (input: { endpoint: string }) => ({
      code: "c0de",
      endpoint: input.endpoint,
      name: "AI-SERVER",
      expiresAt: "2026-08-27T01:00:00.000Z",
    }));
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: {
        id: "desktop-network:10.20.0.5:3773",
        label: "10.20.0.5 (enables remote access)",
        httpBaseUrl: "http://10.20.0.5:3773/",
        servedByNativeListener: true,
      },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => ({ ...wideState, endpointUrl: "http://192.168.1.20:3774" }),
      mintOffer,
      ...defaultDeps,
    });
    expect(mintOffer).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "http://10.20.0.5:3774/" }),
    );
    expect(result).toMatchObject({ ok: true, offer: { endpoint: "http://10.20.0.5:3774/" } });
  });

  it("says nothing changed when the permission step failed before any restart", () => {
    expect(
      describeWidenFailure(
        "Could not apply server exposure network-accessible: open remote-access firewall rule: firewall-elevation-required. No exposure change was made.",
      ).message,
    ).toContain("This computer is still local-only.");
  });

  it("widens first and keeps a chosen local-only address for the code", async () => {
    const calls: string[] = [];
    const applyServerExposure = vi.fn(async () => {
      calls.push("widen");
      return wideState;
    });
    const mintOffer = vi.fn(async (input: { endpoint: string }) => {
      calls.push(`mint ${input.endpoint}`);
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
      selectedOption: {
        id: "desktop-network:10.20.0.5:3773",
        label: "10.20.0.5 (enables remote access)",
        httpBaseUrl: "http://10.20.0.5:3773/",
      },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure,
      mintOffer,
      ...defaultDeps,
    });
    expect(calls).toEqual(["widen", "mint http://10.20.0.5:3773/"]);
    expect(applyServerExposure).toHaveBeenCalledWith("network-accessible");
    expect(result).toMatchObject({ ok: true, offer: { endpoint: "http://10.20.0.5:3773/" } });
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

  it("awaits native widening past the HTTP request deadline before minting", async () => {
    let finishWidening: ((state: typeof wideState) => void) | undefined;
    const applyServerExposure = vi.fn(
      () =>
        new Promise<typeof wideState>((resolve) => {
          finishWidening = resolve;
        }),
    );
    const mintOffer = vi.fn(async (input: { endpoint: string; name: string }) => ({
      code: "c0de",
      endpoint: input.endpoint,
      name: input.name,
      expiresAt: "2026-08-27T01:00:00.000Z",
    }));
    const pending = generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure,
      mintOffer,
      ...defaultDeps,
      requestTimeoutMs: 5,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mintOffer).not.toHaveBeenCalled();
    finishWidening?.(wideState);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(mintOffer).toHaveBeenCalledOnce();
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

  it("times out blackholed mint attempts and confirms local-only after cancellation", async () => {
    const cancelOffer = vi.fn(async () => {});
    const cleanupExposureAfterFailedMint = vi.fn(async () => "local-confirmed" as const);
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => wideState,
      mintOffer: () => new Promise(() => {}),
      ...defaultDeps,
      requestTimeoutMs: 5,
      classifyMintError: () => "fatal",
      cancelOffer,
      cleanupExposureAfterFailedMint,
    });

    expect(cancelOffer).toHaveBeenCalledExactlyOnceWith("key-1");
    expect(cleanupExposureAfterFailedMint).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "mint-failed", cleanup: "local-confirmed" },
    });
  });

  it("consults the authority when blackholed cancellation cannot rule out a live offer", async () => {
    const cancelOffer = vi.fn(() => new Promise<void>(() => {}));
    const cleanupExposureAfterFailedMint = vi.fn(async () => "active-reason" as const);
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => wideState,
      mintOffer: async () => {
        throw new Error("response lost");
      },
      ...defaultDeps,
      requestTimeoutMs: 5,
      classifyMintError: () => "fatal",
      cancelOffer,
      cleanupExposureAfterFailedMint,
    });

    expect(cancelOffer.mock.calls).toEqual([["key-1"], ["key-1"], ["key-1"]]);
    // The cleanup consults the authoritative share state, so it runs even
    // with the cancellation unconfirmed; a possibly live offer keeps the
    // host wide as an active reason.
    expect(cleanupExposureAfterFailedMint).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "mint-failed",
        cleanup: "active-reason",
        message: expect.stringContaining("timed out"),
      },
    });
  });

  it("bounds cancellation retries without narrowing while offer creation remains ambiguous", async () => {
    const cancelOffer = vi.fn(async () => {
      throw new Error("server unreachable");
    });
    const cleanupExposureAfterFailedMint = vi.fn(async () => "active-reason" as const);
    const sleep = vi.fn(async () => {});
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => wideState,
      mintOffer: async () => {
        throw new Error("mint result unknown");
      },
      ...defaultDeps,
      requestTimeoutMs: 5,
      classifyMintError: () => "fatal",
      cancelOffer,
      cleanupExposureAfterFailedMint,
      sleep,
    });

    expect(cancelOffer.mock.calls).toEqual([["key-1"], ["key-1"], ["key-1"]]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(cleanupExposureAfterFailedMint).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "mint-failed", cleanup: "active-reason" },
    });
  });

  it("keeps wide exposure with honest copy when authoritative state still has an active reason", async () => {
    const cleanupExposureAfterFailedMint = vi.fn(async () => "active-reason" as const);
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => wideState,
      mintOffer: async () => {
        throw new Error("mint result unknown");
      },
      ...defaultDeps,
      classifyMintError: () => "fatal",
      cancelOffer: async () => {
        throw new Error("cancellation unconfirmed");
      },
      cleanupExposureAfterFailedMint,
    });

    expect(cleanupExposureAfterFailedMint).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "mint-failed",
        cleanup: "active-reason",
        message: expect.stringContaining("cancellation unconfirmed"),
      },
    });
  });

  it("restores local-only exposure after widening when every mint attempt fails", async () => {
    const calls: string[] = [];
    const cleanupExposureAfterFailedMint = vi.fn(async () => "local-confirmed" as const);
    const mintOffer = vi.fn(async () => {
      calls.push("mint");
      throw new Error("still unreachable");
    });
    const cancelOffer = vi.fn(async () => {
      calls.push("cancel");
    });
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => {
        calls.push("widen");
        return wideState;
      },
      mintOffer,
      ...defaultDeps,
      cancelOffer,
      cleanupExposureAfterFailedMint,
    });

    expect(mintOffer).toHaveBeenCalledTimes(5);
    expect(cancelOffer).toHaveBeenCalledExactlyOnceWith("key-1");
    expect(cleanupExposureAfterFailedMint).toHaveBeenCalledOnce();
    expect(calls).toEqual(["widen", "mint", "mint", "mint", "mint", "mint", "cancel"]);
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "mint-failed", widened: true, cleanup: "local-confirmed" },
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
        cleanup: "cleanup-failed",
        message: expect.stringContaining("firewall cleanup failed"),
      },
    });
  });

  it("does not narrow on cancellation failure even if a stale read reports loopback", async () => {
    const cancelOffer = vi.fn(async () => {
      throw new Error("server unreachable");
    });
    const cleanupExposureAfterFailedMint = vi.fn(async () => "local-confirmed" as const);
    const result = await generateShareOffer({
      intent: "another-device",
      name: "AI-SERVER",
      customAddress: null,
      selectedOption: { id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure: async () => wideState,
      mintOffer: async () => {
        throw new Error("response lost");
      },
      ...defaultDeps,
      classifyMintError: () => "fatal",
      cancelOffer,
      cleanupExposureAfterFailedMint,
    });

    expect(cancelOffer).toHaveBeenCalledTimes(3);
    // The authority reports no live sharing reason, so the host narrows
    // instead of staying bound to 0.0.0.0 with an open firewall until the
    // app restarts.
    expect(cleanupExposureAfterFailedMint).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "mint-failed",
        cleanup: "local-confirmed",
        message: expect.stringContaining("Pairing-offer cancellation failed: server unreachable"),
      },
    });
  });

  it("does not run exposure cleanup when the ceremony did not widen", async () => {
    const cleanupExposureAfterFailedMint = vi.fn(async () => "local-confirmed" as const);
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
      failure: { kind: "mint-failed", widened: false, cleanup: "active-reason" },
    });
  });

  it("reports when another live sharing reason correctly keeps exposure wide", async () => {
    const cleanupExposureAfterFailedMint = vi.fn(async () => "active-reason" as const);
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

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "mint-failed", widened: true, cleanup: "active-reason" },
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

  it("treats an off-host custom address as externally managed without native widening", async () => {
    const applyServerExposure = vi.fn(async () => wideState);
    const mintOffer = vi.fn(async (input: { endpoint: string; name: string }) => ({
      code: "c0de",
      endpoint: input.endpoint,
      name: input.name,
      expiresAt: "2026-08-27T01:00:00.000Z",
    }));
    const result = await generateShareOffer({
      intent: "custom",
      name: "AI-SERVER",
      customAddress: "https://server.example.com",
      selectedOption: { id: "custom", label: "Custom address", httpBaseUrl: null },
      hasDesktopBridge: true,
      exposureState: loopbackState,
      applyServerExposure,
      mintOffer,
      ...defaultDeps,
    });

    expect(applyServerExposure).not.toHaveBeenCalled();
    expect(mintOffer).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://server.example.com/", reach: "custom" }),
    );
    expect(result).toMatchObject({
      ok: true,
      offer: { endpoint: "https://server.example.com/", endpointClass: "off-host" },
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

describe("nativeShareAddressUnavailableReason", () => {
  const privateObservation: AdvertisedEndpoint = {
    id: "desktop-network:192.168.1.20:3773",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.20:3773/",
    wsBaseUrl: "ws://192.168.1.20:3773/",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
    source: "desktop-core",
    status: "unavailable",
  };

  it("reports no private address when no endpoints were observed", () => {
    expect(nativeShareAddressUnavailableReason([])).toBe("no-private-address");
  });

  it("reports no private address for a public-only endpoint", () => {
    expect(
      nativeShareAddressUnavailableReason([
        {
          ...privateObservation,
          httpBaseUrl: "http://8.8.8.8:3773/",
          reachability: "public",
          isDefault: true,
        },
      ]),
    ).toBe("no-private-address");
  });

  it.each(["http://127.0.0.1:3773/", "http://0.0.0.0:3773/"])(
    "ignores an endpoint that is not off-host: %s",
    (httpBaseUrl) => {
      expect(
        nativeShareAddressUnavailableReason([
          { ...privateObservation, httpBaseUrl, isDefault: true },
        ]),
      ).toBe("no-private-address");
    },
  );

  it.each(["desktop-addon", "server", "user"] as const)(
    "ignores private endpoints from %s",
    (source) => {
      expect(
        nativeShareAddressUnavailableReason([{ ...privateObservation, source, isDefault: true }]),
      ).toBe("no-private-address");
    },
  );

  it.each(["lan", "private-network"] as const)(
    "reports no private default route for a %s endpoint without isDefault",
    (reachability) => {
      expect(nativeShareAddressUnavailableReason([{ ...privateObservation, reachability }])).toBe(
        "no-private-default-route",
      );
    },
  );

  it("reports no private default route when the default route is public", () => {
    expect(
      nativeShareAddressUnavailableReason([
        { ...privateObservation, isDefault: false },
        {
          ...privateObservation,
          httpBaseUrl: "http://8.8.8.8:3773/",
          reachability: "public",
          isDefault: true,
        },
      ]),
    ).toBe("no-private-default-route");
  });

  it.each(["lan", "private-network"] as const)(
    "has no unavailable reason when a private %s default offers Automatic (LAN)",
    (reachability) => {
      const advertisedEndpoints = [{ ...privateObservation, reachability, isDefault: true }];
      expect(nativeShareAddressUnavailableReason(advertisedEndpoints)).toBeNull();
      expect(
        resolveShareAddressOptions({
          intent: "another-device",
          advertisedEndpoints,
          exposureState: loopbackState,
          primaryHttpBaseUrl: "http://127.0.0.1:3773",
        }),
      ).toEqual([
        {
          id: "auto-lan",
          label: "Automatic (LAN)",
          httpBaseUrl: null,
          description: "BiBCode will enable remote access and choose a LAN address.",
        },
      ]);
    },
  );
});

describe("resolveShareAddressOptions", () => {
  it("offers automatic LAN plus non-loopback advertised endpoints for another-device", () => {
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [
        {
          id: "desktop-network:192.168.1.20:3773",
          label: "Local network",
          provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
          httpBaseUrl: "http://192.168.1.20:3773/",
          wsBaseUrl: "ws://192.168.1.20:3773/",
          reachability: "lan",
          compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
          source: "desktop-core",
          status: "unavailable",
          isDefault: true,
        },
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

  it("does not offer a public-only observation while native exposure is local-only", () => {
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [
        {
          id: "desktop-network:8.8.8.8:3773",
          label: "Public address",
          provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
          httpBaseUrl: "http://8.8.8.8:3773/",
          wsBaseUrl: "ws://8.8.8.8:3773/",
          reachability: "public",
          compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
          source: "desktop-core",
          status: "unavailable",
          unavailableReason: "local-only",
          isDefault: false,
        },
      ],
      exposureState: loopbackState,
      primaryHttpBaseUrl: "http://127.0.0.1:3773",
    });

    expect(options).toEqual([]);
  });

  it("requires a private default-route observation before offering native automatic LAN", () => {
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [
        {
          id: "desktop-network:192.168.2.20:3773",
          label: "Local network",
          provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
          httpBaseUrl: "http://192.168.2.20:3773/",
          wsBaseUrl: "ws://192.168.2.20:3773/",
          reachability: "lan",
          compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
          source: "desktop-core",
          status: "unavailable",
          unavailableReason: "local-only",
          isDefault: false,
        },
      ],
      exposureState: loopbackState,
      primaryHttpBaseUrl: "http://127.0.0.1:3773",
    });

    expect(options).toEqual([]);
  });

  it("offers native automatic LAN for an observed private default route before widening", () => {
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [localOnlyObservation("desktop-network", "192.168.0.10", "lan", true)],
      exposureState: loopbackState,
      primaryHttpBaseUrl: "http://127.0.0.1:3773",
    });

    expect(options).toEqual([
      expect.objectContaining({ id: "auto-lan", httpBaseUrl: null }),
      expect.objectContaining({
        id: "desktop-network:192.168.0.10:3773",
        httpBaseUrl: "http://192.168.0.10:3773/",
      }),
    ]);
  });

  it("lists every private address that enabling remote access makes reachable", () => {
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [
        localOnlyObservation("desktop-network", "192.168.0.10", "lan", true),
        localOnlyObservation("desktop-network", "10.20.0.5", "lan", false),
        localOnlyObservation("desktop-network", "100.64.0.7", "private-network", false),
        // The Tailscale CLI reports the same tailnet address the interface scan found.
        {
          ...localOnlyObservation("tailscale-ip", "100.64.0.7", "private-network", undefined),
          label: "Tailscale IP",
          provider: { id: "tailscale", label: "Tailscale", kind: "private-network", isAddon: true },
          source: "desktop-addon",
        },
        {
          ...localOnlyObservation("desktop-network", "8.8.8.8", "public", false),
          label: "Public address",
        },
      ],
      exposureState: loopbackState,
      primaryHttpBaseUrl: "http://127.0.0.1:3773",
    });

    expect(options).toEqual([
      expect.objectContaining({ id: "auto-lan", label: "Automatic (LAN)", httpBaseUrl: null }),
      ...["192.168.0.10", "10.20.0.5", "100.64.0.7"].map((host) => ({
        id: `desktop-network:${host}:3773`,
        label: `${host} (enables remote access)`,
        httpBaseUrl: `http://${host}:3773/`,
        description: "BiBCode will enable remote access, then use this address.",
        servedByNativeListener: true,
      })),
    ]);
  });

  it("leaves out an address that is unavailable for a reason other than local-only", () => {
    const { unavailableReason: _omitted, ...withoutReason } = localOnlyObservation(
      "desktop-network",
      "10.20.0.5",
      "lan",
      false,
    );
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [
        localOnlyObservation("desktop-network", "192.168.0.10", "lan", true),
        withoutReason,
      ],
      exposureState: loopbackState,
      primaryHttpBaseUrl: "http://127.0.0.1:3773",
    });

    expect(options.map((option) => option.httpBaseUrl)).toEqual([
      null,
      "http://192.168.0.10:3773/",
    ]);
  });

  it("does not offer local-only addresses while exposure is managed outside BiBCode", () => {
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [localOnlyObservation("desktop-network", "192.168.0.10", "lan", true)],
      exposureState: { ...loopbackState, management: "external" },
      primaryHttpBaseUrl: "http://127.0.0.1:3773",
    });

    expect(options).toEqual([]);
  });

  it("never offers public interface candidates for a native-managed wide server", () => {
    const options = resolveShareAddressOptions({
      intent: "another-device",
      advertisedEndpoints: [
        {
          id: "desktop-network:8.8.8.8:3773",
          label: "Public address",
          provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
          httpBaseUrl: "http://8.8.8.8:3773/",
          wsBaseUrl: "ws://8.8.8.8:3773/",
          reachability: "public",
          compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
          source: "desktop-core",
          status: "available",
          isDefault: false,
        },
      ],
      exposureState: wideState,
      primaryHttpBaseUrl: "http://127.0.0.1:3773",
    });

    expect(options).toEqual([
      expect.objectContaining({
        id: "auto-lan",
        httpBaseUrl: "http://192.168.1.20:3773",
      }),
    ]);
  });
});
