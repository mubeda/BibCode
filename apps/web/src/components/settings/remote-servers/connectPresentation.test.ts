import { describe, expect, it } from "vite-plus/test";

import {
  ADD_SERVER_FAILURE_REASONS,
  describeAddServerFailure,
  describeCompatBadge,
  formatServerVersionLabel,
  isLoopbackAcknowledgementRequired,
  normalizePairingCodeInput,
  resolvePairingAddFailureReason,
  resolveTransportBadge,
} from "./connectPresentation";

describe("formatServerVersionLabel", () => {
  it("renders the D16 version string and hides unknown versions", () => {
    expect(formatServerVersionLabel("1.4.2")).toBe("BiBCode v1.4.2");
    expect(formatServerVersionLabel("  ")).toBeNull();
    expect(formatServerVersionLabel(null)).toBeNull();
    expect(formatServerVersionLabel(undefined)).toBeNull();
  });
});

describe("describeCompatBadge", () => {
  it("maps every verdict kind to the pinned copy", () => {
    expect(describeCompatBadge(null)).toBeNull();
    expect(describeCompatBadge({ kind: "compatible" })).toBeNull();
    expect(describeCompatBadge({ kind: "legacy" })).toEqual({
      tone: "warning",
      label: "Limited compatibility",
    });
    expect(
      describeCompatBadge({ kind: "server-too-old", serverVersion: 0, minSupported: 1 }),
    ).toEqual({ tone: "destructive", label: "Server update required" });
    expect(
      describeCompatBadge({ kind: "client-too-old", serverMinCompatible: 2, clientVersion: 1 }),
    ).toEqual({ tone: "destructive", label: "App update required" });
  });
});

describe("resolveTransportBadge", () => {
  const bearer = (profile: { readonly _tag: string; readonly hostKey?: string | null } | null) => ({
    relayManaged: false,
    entry: {
      target: { _tag: "BearerConnectionTarget", connectionId: "bearer:x" },
      profile:
        profile === null
          ? ({ _tag: "None" } as const)
          : ({ _tag: "Some", value: profile } as const),
    },
  });

  it("labels relay, ssh, e2ee, and legacy-unencrypted saved servers", () => {
    expect(
      resolveTransportBadge({
        relayManaged: true,
        entry: { target: { _tag: "RelayConnectionTarget" }, profile: { _tag: "None" } },
      }),
    ).toEqual({ kind: "relay", label: "BiBCode Connect" });
    expect(
      resolveTransportBadge({
        relayManaged: false,
        entry: { target: { _tag: "SshConnectionTarget" }, profile: { _tag: "None" } },
      }),
    ).toEqual({ kind: "ssh", label: "SSH tunnel" });
    expect(
      resolveTransportBadge(
        bearer({
          _tag: "BearerConnectionProfile",
          hostKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      ),
    ).toEqual({ kind: "e2ee", label: "End-to-end encrypted" });
    expect(
      resolveTransportBadge(bearer({ _tag: "BearerConnectionProfile", hostKey: null })),
    ).toEqual({
      kind: "unencrypted",
      label: "Unencrypted",
      guidance: "Re-pair with a new pairing code to secure this connection.",
    });
  });

  it("shows no transport badge for the desktop-managed local (WSL) environment", () => {
    expect(
      resolveTransportBadge({
        relayManaged: false,
        entry: {
          target: { _tag: "BearerConnectionTarget", connectionId: "local:wsl" },
          profile: { _tag: "None" },
        },
      }),
    ).toBeNull();
  });
});

describe("add-server failure copy", () => {
  it("has copy for all five spec-pinned failure reasons", () => {
    expect(ADD_SERVER_FAILURE_REASONS).toEqual([
      "unreachable",
      "host-identity-mismatch",
      "pairing-rejected",
      "incompatible",
      "duplicate-storage-identity",
    ]);
    for (const reason of ADD_SERVER_FAILURE_REASONS) {
      const described = describeAddServerFailure(reason);
      expect(described.title.length).toBeGreaterThan(0);
      expect(described.detail.length).toBeGreaterThan(0);
    }
    expect(describeAddServerFailure("pairing-rejected").title).toBe("Pairing rejected");
  });

  it("reads the reason off a PairingAddError and rejects everything else", () => {
    expect(
      resolvePairingAddFailureReason({
        _tag: "PairingAddError",
        reason: "host-identity-mismatch",
        detail: "pinned key changed",
      }),
    ).toBe("host-identity-mismatch");
    expect(resolvePairingAddFailureReason(new Error("boom"))).toBeNull();
    expect(
      resolvePairingAddFailureReason({ _tag: "PairingAddError", reason: "something-else" }),
    ).toBeNull();
    expect(resolvePairingAddFailureReason({ kind: "pairing-rejected" })).toBeNull();
  });

  it("detects the loopback-acknowledgement error by tag", () => {
    expect(
      isLoopbackAcknowledgementRequired({
        _tag: "PairingLoopbackAcknowledgementRequiredError",
        endpoint: "http://127.0.0.1:3773",
      }),
    ).toBe(true);
    expect(
      isLoopbackAcknowledgementRequired({ _tag: "PairingAddError", reason: "unreachable" }),
    ).toBe(false);
    expect(isLoopbackAcknowledgementRequired(new Error("boom"))).toBe(false);
  });
});

describe("normalizePairingCodeInput", () => {
  it("accepts raw codes, deep links, and web pair URLs", () => {
    expect(normalizePairingCodeInput("  abc123-_  ")).toBe("abc123-_");
    expect(normalizePairingCodeInput("bibcode://pair?code=abc123-_")).toBe("abc123-_");
    expect(normalizePairingCodeInput("http://192.168.1.20:3773/pair?code=abc123-_")).toBe(
      "abc123-_",
    );
    expect(normalizePairingCodeInput("")).toBeNull();
    expect(normalizePairingCodeInput("bibcode://pair")).toBeNull();
    expect(normalizePairingCodeInput("http://example.com/other?code=x")).toBe("x");
  });
});
