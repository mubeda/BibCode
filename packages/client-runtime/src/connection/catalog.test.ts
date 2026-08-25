import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { EnvironmentBinding, EnvironmentUiPreferences, KnownEnvironment } from "./catalog.ts";
import {
  DirectHttpsRoute,
  EnvironmentRouteBlockedReason,
  EnvironmentRouteTransientReason,
} from "./model.ts";

const ENVIRONMENT_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f001";
const OTHER_ENVIRONMENT_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f002";
const STORAGE_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f101";

const descriptor = {
  environmentId: ENVIRONMENT_ID,
  label: "Build server",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.0.0",
  storageInstanceId: STORAGE_ID,
  protocol: { minimum: 1, maximum: 1 },
  capabilities: {
    repositoryIdentity: true,
    worktreeCatalog: true,
    worktreeCatalogRefreshReason: true,
    vcsStatusSummary: true,
    activityProtocolVersion: 2,
  },
} as const;

const sshRoute = {
  _tag: "SshTunnelRoute",
  routeId: "route:ssh",
  environmentId: ENVIRONMENT_ID,
  label: "SSH tunnel",
  priority: 20,
  pinned: false,
  autoconnect: true,
  secretRef: "bibcode-secret:ssh-session",
  target: {
    alias: "build-server",
    hostname: "build.example.test",
    username: "builder",
    port: 22,
  },
  hostKeyFingerprint: "SHA256:known-host-key",
} as const;

const httpsRoute = {
  _tag: "DirectHttpsRoute",
  routeId: "route:https",
  environmentId: ENVIRONMENT_ID,
  label: "Private HTTPS",
  priority: 10,
  pinned: true,
  autoconnect: true,
  secretRef: "bibcode-secret:https-session",
  httpsBaseUrl: "https://build.example.test",
  trust: { _tag: "PinnedSpki", sha256: "SHA256:pinned-spki" },
} as const;

const wslBinding = {
  _tag: "DesktopWslBinding",
  bindingId: "wsl:Ubuntu",
  distroName: "Ubuntu",
  acceptedEnvironmentId: ENVIRONMENT_ID,
  acceptedStorageInstanceIds: [STORAGE_ID],
  acceptedAt: "2026-08-25T12:00:00.000Z",
  lastDiscoveryGeneration: 4,
  condition: "available",
  detail: null,
} as const;

function knownEnvironment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentId: ENVIRONMENT_ID,
    acceptedStorageInstanceId: STORAGE_ID,
    descriptor,
    alias: "Build Linux",
    hidden: false,
    bindings: [wslBinding],
    routes: [sshRoute, httpsRoute],
    ...overrides,
  };
}

const decodeKnownEnvironment = Schema.decodeUnknownSync(KnownEnvironment);
const decodeEnvironmentBinding = Schema.decodeUnknownSync(EnvironmentBinding);
const decodeEnvironmentUiPreferences = Schema.decodeUnknownSync(EnvironmentUiPreferences);
const decodeDirectHttpsRoute = Schema.decodeUnknownSync(DirectHttpsRoute);
const decodeBlockedRouteReason = Schema.decodeUnknownSync(EnvironmentRouteBlockedReason);
const decodeTransientRouteReason = Schema.decodeUnknownSync(EnvironmentRouteTransientReason);

describe("known environment catalog", () => {
  it("keeps two routes under one proved environment", () => {
    const environment = decodeKnownEnvironment(knownEnvironment());

    expect(environment.routes.map((route) => route.routeId)).toEqual(["route:ssh", "route:https"]);
  });

  it("rejects route and binding identifier collisions inside one environment", () => {
    expect(() =>
      decodeKnownEnvironment(
        knownEnvironment({ routes: [sshRoute, { ...httpsRoute, routeId: sshRoute.routeId }] }),
      ),
    ).toThrow(/route identifiers must be unique/iu);

    expect(() =>
      decodeKnownEnvironment(
        knownEnvironment({ bindings: [wslBinding, { ...wslBinding, distroName: "Debian" }] }),
      ),
    ).toThrow(/binding identifiers must be unique/iu);
  });

  it("rejects routes and proved bindings owned by another environment", () => {
    expect(() =>
      decodeKnownEnvironment(
        knownEnvironment({
          routes: [{ ...sshRoute, environmentId: OTHER_ENVIRONMENT_ID }, httpsRoute],
        }),
      ),
    ).toThrow(/route must belong to its containing environment/iu);

    expect(() =>
      decodeKnownEnvironment(
        knownEnvironment({
          bindings: [{ ...wslBinding, acceptedEnvironmentId: OTHER_ENVIRONMENT_ID }],
        }),
      ),
    ).toThrow(/binding must belong to its containing environment/iu);
  });

  it("rejects more than one pinned route", () => {
    expect(() =>
      decodeKnownEnvironment(
        knownEnvironment({ routes: [{ ...sshRoute, pinned: true }, httpsRoute] }),
      ),
    ).toThrow(/at most one route may be pinned/iu);
  });

  it("rejects a descriptor that changes the accepted environment or storage identity", () => {
    expect(() =>
      decodeKnownEnvironment(
        knownEnvironment({ descriptor: { ...descriptor, environmentId: OTHER_ENVIRONMENT_ID } }),
      ),
    ).toThrow(/descriptor environment identity must match/iu);

    expect(() =>
      decodeKnownEnvironment(
        knownEnvironment({
          descriptor: {
            ...descriptor,
            storageInstanceId: "018f1f52-0d78-7d73-8dc8-7bd50db6f999",
          },
        }),
      ),
    ).toThrow(/descriptor storage identity must match/iu);
  });

  it("represents an unavailable WSL discovery as a binding condition without a route", () => {
    const binding = decodeEnvironmentBinding({
      ...wslBinding,
      acceptedEnvironmentId: null,
      acceptedStorageInstanceIds: [],
      acceptedAt: null,
      condition: "setup-required",
      detail: "BiBCode Server is not installed.",
    });

    expect(binding).toMatchObject({
      _tag: "DesktopWslBinding",
      acceptedEnvironmentId: null,
      condition: "setup-required",
    });
    expect("routeId" in binding).toBe(false);
  });

  it("normalizes client-local alias and hidden preferences", () => {
    expect(decodeEnvironmentUiPreferences({ alias: "  Build Linux  ", hidden: true })).toEqual({
      alias: "Build Linux",
      hidden: true,
    });
  });
});

describe("environment route security", () => {
  it("rejects plaintext and malformed direct routes", () => {
    expect(() =>
      decodeDirectHttpsRoute({ ...httpsRoute, httpsBaseUrl: "http://build.example.test" }),
    ).toThrow(/HTTPS URL/iu);
    expect(() => decodeDirectHttpsRoute({ ...httpsRoute, httpsBaseUrl: "not a URL" })).toThrow(
      /HTTPS URL/iu,
    );
  });

  it("keeps Relay-only reasons out of the canonical route failure vocabulary", () => {
    expect(decodeBlockedRouteReason("environment-changed")).toBe("environment-changed");
    expect(decodeBlockedRouteReason("certificate-changed")).toBe("certificate-changed");
    expect(decodeBlockedRouteReason("version-incompatible")).toBe("version-incompatible");
    expect(decodeBlockedRouteReason("identity-conflict")).toBe("identity-conflict");
    expect(() => decodeTransientRouteReason("relay-unavailable")).toThrow();
  });
});
