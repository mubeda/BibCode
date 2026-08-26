import type { EnvironmentPresentation, KnownEnvironment } from "@bibcode/client-runtime/connection";
import type { OrchestrationShellSnapshot, ServerConfig } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildEnvironmentWorkspaceSource } from "./environmentWorkspaceSource";

const environment = {
  environmentId: "00000000-0000-4000-8000-000000000091",
  acceptedStorageInstanceId: "00000000-0000-4000-8000-000000000092",
  alias: "Build host",
  hidden: false,
  descriptor: {
    environmentId: "00000000-0000-4000-8000-000000000091",
    storageInstanceId: "00000000-0000-4000-8000-000000000092",
    label: "build.internal",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.4.1",
    protocol: { minimum: 1, maximum: 2 },
    capabilities: {
      repositoryIdentity: true,
      worktreeCatalog: true,
      worktreeCatalogRefreshReason: false,
      vcsStatusSummary: true,
      activityProtocolVersion: 2,
    },
  },
  bindings: [],
  routes: [
    {
      _tag: "DirectHttpsRoute",
      routeId: "https:build",
      environmentId: "00000000-0000-4000-8000-000000000091",
      label: "Direct",
      priority: 0,
      pinned: true,
      autoconnect: true,
      secretRef: null,
      httpsBaseUrl: "https://build.internal/",
      trust: { _tag: "System" },
    },
  ],
} as unknown as KnownEnvironment;

const presentation = {
  entry: {
    target: {
      _tag: "BearerConnectionTarget",
      environmentId: environment.environmentId,
      label: "build.internal",
      connectionId: "https:build",
    },
  },
  connection: { phase: "offline", error: null, traceId: null },
  serverConfig: null,
} as unknown as EnvironmentPresentation;

describe("buildEnvironmentWorkspaceSource", () => {
  it("projects secure route identity and cached shell counts without exposing secrets", () => {
    const source = buildEnvironmentWorkspaceSource({
      environment,
      presentation,
      shellStatus: "degraded",
      shellSnapshot: {
        updatedAt: "2026-08-25T12:00:00.000Z",
        projects: [
          { id: "project-1", title: "First", workspaceRoot: "/src/first" },
          { id: "project-2", title: "Second", workspaceRoot: "/src/second" },
        ],
        threads: [{ id: "thread-1" }],
      } as unknown as OrchestrationShellSnapshot,
      activeRouteId: null,
      desktopBridgeAvailable: false,
    });

    expect(source).toMatchObject({
      alias: "Build host",
      canonicalLabel: "build.internal",
      status: "offline",
      hasCachedContent: true,
      projectCount: 2,
      threadCount: 1,
      lastSynchronizedAt: "2026-08-25T12:00:00.000Z",
      routes: [
        {
          routeId: "https:build",
          kind: "https",
          address: "https://build.internal/",
          trust: "Operating-system certificate trust",
        },
      ],
    });
    expect(JSON.stringify(source)).not.toContain("secretRef");
  });

  it("marks update maintenance and derives desktop host authority", () => {
    const source = buildEnvironmentWorkspaceSource({
      environment,
      presentation: {
        ...presentation,
        connection: { phase: "connected", error: null, traceId: null },
        serverConfig: {
          environment: environment.descriptor,
          service: {
            serviceMode: "workstation",
            startupMechanism: "systemdUser",
            runtimeState: "running",
            version: "0.4.1",
            accountKind: "currentUser",
            bind: { scope: "loopback", transport: "http", port: 4100 },
            update: {
              phase: "preparing",
              currentVersion: "0.4.1",
              targetVersion: "0.4.2",
              lastResult: null,
            },
            hostControl: {
              available: false,
              reason: "hostAuthorityRequired",
              allowedChannels: ["desktop", "localControl", "sshAdmin"],
            },
          },
        } as unknown as ServerConfig,
      },
      shellStatus: "live",
      shellSnapshot: null,
      activeRouteId: "https:build",
      desktopBridgeAvailable: true,
    });

    expect(source.status).toBe("updating");
    expect(source.activeRouteId).toBe("https:build");
    expect(source.hostAuthorityChannels).toEqual(["desktop"]);
    expect(source.service).toMatchObject({
      mode: "workstation",
      startupMechanism: "systemdUser",
      runtimeState: "running",
      updatePhase: "preparing",
    });
  });
});
