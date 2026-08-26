import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  UnavailableConnectionTarget,
  type ConnectionTarget,
} from "@bibcode/client-runtime/connection";
import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { desktopLocalConnectionId } from "./desktopLocal";
import {
  createEnvironmentPresentationPolicy,
  normalizeDesktopHostPlatform,
} from "./environmentPresentationPolicy";

const primaryTarget = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("primary"),
  httpBaseUrl: "http://127.0.0.1:3773",
  label: "This device",
  wsBaseUrl: "ws://127.0.0.1:3773",
});

const wslTarget = new BearerConnectionTarget({
  connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
  environmentId: EnvironmentId.make("wsl"),
  label: "WSL: Ubuntu",
});

const unavailableWslTarget = new UnavailableConnectionTarget({
  configuredDistro: "Ubuntu",
  connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
  detail: "WSL is unavailable",
  environmentId: EnvironmentId.make("wsl-unavailable"),
  label: "WSL: Ubuntu",
});

const sshTarget = new SshConnectionTarget({
  connectionId: "ssh:server",
  environmentId: EnvironmentId.make("ssh"),
  label: "SSH server",
});

const remoteBearerTarget = new BearerConnectionTarget({
  connectionId: "remote:server",
  environmentId: EnvironmentId.make("bearer"),
  label: "Remote server",
});

const allTargetKinds: readonly ConnectionTarget[] = [
  primaryTarget,
  wslTarget,
  unavailableWslTarget,
  sshTarget,
  remoteBearerTarget,
];

describe("environment presentation policy", () => {
  it.each([
    ["browser", "macos", "full", true],
    ["desktop", "macos", "full", true],
    ["desktop", "linux", "full", true],
    ["desktop", "windows", "full", true],
    ["desktop", "unknown", "full", true],
  ] as const)("derives %s/%s presentation", (surface, platform, connections, remote) => {
    const policy = createEnvironmentPresentationPolicy({ surface, platform });

    expect(policy.connectionsPresentation).toBe(connections);
    expect(policy.showRemoteDeviceControls).toBe(remote);
  });

  it.each(["browser", "desktop"] as const)(
    "presents every environment target on the %s surface",
    (surface) => {
      const policy = createEnvironmentPresentationPolicy({ surface, platform: "unknown" });

      for (const target of allTargetKinds) {
        expect(policy.presentsTarget(target)).toBe(true);
        expect(policy.permitsConnectionAction(target)).toBe(true);
      }
    },
  );

  it.each([
    ["MacIntel", "macos"],
    ["MacBookPro", "macos"],
    ["Win32", "windows"],
    ["Windows", "windows"],
    ["Linux x86_64", "linux"],
    ["FreeBSD", "unknown"],
  ] as const)("normalizes %s as %s", (platform, expected) => {
    expect(normalizeDesktopHostPlatform(platform)).toBe(expected);
  });
});
