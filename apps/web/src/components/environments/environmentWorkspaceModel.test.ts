import { describe, expect, it } from "vite-plus/test";

import {
  createEnvironmentWorkspaceModel,
  environmentWorkspaceTabs,
  parseDirectEnvironmentEndpoint,
  parseEnvironmentWorkspaceSearch,
  type EnvironmentWorkspaceSource,
} from "./environmentWorkspaceModel";

const source = (
  overrides: Partial<EnvironmentWorkspaceSource> = {},
): EnvironmentWorkspaceSource => ({
  environmentId: "00000000-0000-4000-8000-000000000071",
  acceptedStorageInstanceId: "00000000-0000-4000-8000-000000000072",
  alias: "Build Linux",
  canonicalLabel: "build-linux.internal",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.4.1",
  protocol: { minimum: 1, maximum: 2 },
  capabilities: {
    repositoryIdentity: true,
    worktreeCatalog: true,
    worktreeCatalogRefreshReason: true,
    vcsStatusSummary: true,
    activityProtocolVersion: 2,
  },
  status: "offline",
  hasCachedContent: true,
  lastSynchronizedAt: "2026-08-25T10:00:00.000Z",
  projectCount: 3,
  threadCount: 9,
  projects: [],
  pairedClients: [],
  activeRouteId: null,
  routes: [
    {
      routeId: "ssh:build-linux",
      label: "SSH build-linux",
      kind: "ssh",
      address: "dev@build-linux.internal:22",
      priority: 0,
      pinned: true,
      autoconnect: true,
      trust: "SHA256:known-host",
    },
  ],
  service: {
    mode: "workstation",
    startupMechanism: "systemdUser",
    runtimeState: "stopped",
    version: "0.4.1",
    account: "Current user",
    bind: "loopback · HTTPS · 443",
    binaryPath: null,
    dataPath: "/home/dev/.local/share/bibcode",
    updatePhase: "idle",
  },
  hostAuthorityChannels: [],
  platformDetails: [{ label: "systemd user unit", value: "Installed" }],
  ...overrides,
});

describe("environment workspace model", () => {
  it("keeps the approved stable tabs and defaults invalid search to Overview", () => {
    expect(environmentWorkspaceTabs.map((tab) => tab.id)).toEqual([
      "overview",
      "connection",
      "service",
      "security",
      "projects",
      "updates",
      "diagnostics",
      "platform",
    ]);
    expect(parseEnvironmentWorkspaceSearch({})).toEqual({ tab: "overview" });
    expect(parseEnvironmentWorkspaceSearch({ tab: "security" })).toEqual({ tab: "security" });
    expect(parseEnvironmentWorkspaceSearch({ tab: "permissions" })).toEqual({ tab: "overview" });
  });

  it("keeps client preferences editable while making cached server and host state read-only", () => {
    const model = createEnvironmentWorkspaceModel(source());

    expect(model.banner).toMatchObject({
      kind: "offline",
      title: "Offline · last synchronized Aug 25, 2026, 10:00 AM",
      readOnly: true,
    });
    expect(model.clientPreferences).toEqual({
      aliasEditable: true,
      orderEditable: true,
      pinEditable: true,
    });
    expect(
      model.sections.overview.fields.find((field) => field.label === "Server version"),
    ).toMatchObject({ readOnly: true, source: "server" });
    expect(model.hostControls).toEqual({
      enabled: false,
      reason:
        "Reconnect this environment before changing its host service. Host controls are never queued.",
    });
  });

  it("enables host controls only for an online environment with an explicit authority channel", () => {
    const model = createEnvironmentWorkspaceModel(
      source({ status: "online", hostAuthorityChannels: ["sshAdmin"] }),
    );

    expect(model.banner).toBeNull();
    expect(model.hostControls).toEqual({ enabled: true, reason: null });
    expect(model.sections.service.fields.every((field) => field.readOnly === false)).toBe(true);
  });

  it("states when offline content was never cached instead of implying an empty environment", () => {
    const model = createEnvironmentWorkspaceModel(
      source({ hasCachedContent: false, lastSynchronizedAt: null }),
    );

    expect(model.banner?.description).toContain("Content unavailable offline.");
  });

  it("contains privacy and administrator language without telemetry or permission-level controls", () => {
    const model = createEnvironmentWorkspaceModel(source());
    const serialized = JSON.stringify(model);

    expect(serialized).toContain("Full administrator");
    expect(serialized).toContain("No upload, analytics, crash reporting, or usage reporting");
    expect(serialized.toLowerCase()).not.toContain("telemetry control");
    expect(serialized.toLowerCase()).not.toContain("permission level");
  });
});

describe("direct environment endpoint admission", () => {
  it.each([
    ["https://server.example.com", "https://server.example.com/"],
    ["wss://server.example.com/socket", "wss://server.example.com/"],
  ])("accepts only explicit secure transports: %s", (input, expected) => {
    expect(parseDirectEnvironmentEndpoint(input)).toBe(expected);
  });

  it.each([
    "http://server.example.com",
    "ws://server.example.com",
    "server.example.com",
    "https://user:secret@server.example.com",
    "https://server.example.com?token=secret",
    "https://server.example.com#token=secret",
  ])("rejects insecure, implicit, or secret-bearing endpoints: %s", (input) => {
    expect(() => parseDirectEnvironmentEndpoint(input)).toThrow(
      /https:\/\/ or wss:\/\/|credentials, query parameters, or fragments/iu,
    );
  });
});
