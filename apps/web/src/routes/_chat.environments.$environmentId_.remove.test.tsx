import {
  BearerConnectionTarget,
  DesktopWslBinding,
  DesktopWslRoute,
  DirectHttpsRoute,
  SshConnectionTarget,
  SshTunnelRoute,
} from "@bibcode/client-runtime/connection";
import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  environmentRemovalHostAuthority,
  removalReachability,
} from "./_chat.environments.$environmentId_.remove";

const environmentId = EnvironmentId.make("76aa78e8-67aa-477e-bd25-68f491885224");

describe("environment removal route", () => {
  it("does not treat stopped or setup-required WSL as remotely reachable", () => {
    expect(
      removalReachability({
        phase: "offline",
        targetTag: "UnavailableConnectionTarget",
        detail: "WSL distribution is stopped",
      }),
    ).toBe("stopped");
    expect(
      removalReachability({
        phase: "offline",
        targetTag: "UnavailableConnectionTarget",
        detail: "Server setup required",
      }),
    ).toBe("setup-required");
  });

  it("allows ordinary removal only after a live connection", () => {
    expect(
      removalReachability({
        phase: "connected",
        targetTag: "BearerConnectionTarget",
        detail: null,
      }),
    ).toBe("online");
    expect(
      removalReachability({
        phase: "reconnecting",
        targetTag: "BearerConnectionTarget",
        detail: null,
      }),
    ).toBe("offline");
  });

  it("derives WSL host authority only from the active route and its live discovery binding", () => {
    const binding = new DesktopWslBinding({
      bindingId: "wsl:Ubuntu",
      distroName: "Ubuntu",
      acceptedEnvironmentId: environmentId,
      acceptedStorageInstanceIds: ["3039b232-95d0-4b2f-a35e-c297b4c895af"],
      acceptedAt: "2026-08-25T12:00:00.000Z",
      lastDiscoveryGeneration: 7,
      condition: "available",
      detail: null,
    });
    const route = new DesktopWslRoute({
      routeId: "wsl-route",
      environmentId,
      label: "Ubuntu",
      priority: 10,
      pinned: true,
      autoconnect: true,
      secretRef: "secret-1",
      bindingId: binding.bindingId,
      httpBaseUrl: "http://127.0.0.1:42100",
      wsBaseUrl: "ws://127.0.0.1:42100",
    });
    expect(
      environmentRemovalHostAuthority({
        target: new BearerConnectionTarget({
          environmentId,
          label: "Ubuntu",
          connectionId: route.routeId,
        }),
        routes: [route],
        bindings: [binding],
      }),
    ).toEqual({
      target: { transport: "wsl", distro: "Ubuntu", discoveryGeneration: 7 },
      environmentGeneration: 7,
    });
  });

  it("requires a pinned fingerprint for SSH and never grants host authority to direct HTTPS", () => {
    const sshRoute = new SshTunnelRoute({
      routeId: "ssh-route",
      environmentId,
      label: "Build host",
      priority: 10,
      pinned: true,
      autoconnect: true,
      secretRef: "secret-1",
      target: { alias: "build", hostname: "build.internal", username: "dev", port: 22 },
      hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const sshTarget = new SshConnectionTarget({
      environmentId,
      label: "Build host",
      connectionId: sshRoute.routeId,
    });
    expect(
      environmentRemovalHostAuthority({ target: sshTarget, routes: [sshRoute], bindings: [] }),
    ).toEqual({
      target: {
        transport: "ssh",
        target: sshRoute.target,
        expectedHostKeyFingerprint: sshRoute.hostKeyFingerprint,
      },
      environmentGeneration: 0,
    });
    expect(
      environmentRemovalHostAuthority({
        target: sshTarget,
        routes: [new SshTunnelRoute({ ...sshRoute, hostKeyFingerprint: null })],
        bindings: [],
      }),
    ).toBeNull();
    expect(
      environmentRemovalHostAuthority({
        target: sshTarget,
        routes: [new SshTunnelRoute({ ...sshRoute, hostKeyFingerprint: "SHA256:not-a-pin" })],
        bindings: [],
      }),
    ).toBeNull();

    const httpsRoute = new DirectHttpsRoute({
      routeId: "https-route",
      environmentId,
      label: "Direct HTTPS",
      priority: 1,
      pinned: true,
      autoconnect: true,
      secretRef: "secret-2",
      httpsBaseUrl: "https://build.internal",
      trust: { _tag: "System" },
    });
    expect(
      environmentRemovalHostAuthority({
        target: new BearerConnectionTarget({
          environmentId,
          label: "Direct HTTPS",
          connectionId: httpsRoute.routeId,
        }),
        routes: [httpsRoute],
        bindings: [],
      }),
    ).toBeNull();
  });
});
