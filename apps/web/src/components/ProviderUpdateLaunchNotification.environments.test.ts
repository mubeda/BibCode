import { EnvironmentId } from "@bibcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  environments: [] as Array<Record<string, unknown>>,
  primaryEnvironmentId: "primary",
  capturedInputs: [] as Array<Record<string, unknown>>,
  displayInputs: [] as Array<Record<string, unknown>>,
  snapshotKeys: [] as string[],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: harness.environments }),
  usePrimaryEnvironmentId: () => harness.primaryEnvironmentId,
}));
vi.mock("~/connection/desktopLocal", () => ({
  isDesktopLocalConnectionTarget: (target: { local?: boolean }) => target.local === true,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly snapshotKey: string }) => {
    harness.snapshotKeys.push(atom.snapshotKey);
    return new Map(
      (JSON.parse(atom.snapshotKey) as string[]).map((id) => [id, { state: `snapshot-${id}` }]),
    );
  },
}));
vi.mock("~/state/providerUpdateAll", () => ({
  serverUpdateSnapshots: (snapshotKey: string) => ({ snapshotKey }),
}));
vi.mock("./ProviderUpdateLaunchNotification.logic", () => ({
  buildLocalEnvironmentUpdateGroups: (inputs: Array<Record<string, unknown>>) => {
    harness.capturedInputs = inputs;
    return {
      groups: inputs,
      isAnySettling: inputs.some((input) => input.connectionState === "connecting"),
    };
  },
  deriveEnvironmentDisplayLabel: (input: Record<string, unknown>) => {
    harness.displayInputs.push(input);
    return "Primary Linux";
  },
}));

import {
  useLocalEnvironmentUpdateGroups,
  useProviderUpdateEnvironments,
} from "./ProviderUpdateLaunchNotification.environments";

function environment(
  id: string,
  phase: string | undefined,
  options: {
    primary?: boolean;
    local?: boolean;
    remote?: boolean;
    withConfig?: boolean;
    remoteUpdateControl?: boolean;
  } = {},
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: `Label ${id}`,
    entry: {
      target: options.primary
        ? { _tag: "PrimaryConnectionTarget" }
        : { _tag: "BearerConnectionTarget", local: options.local, remote: options.remote },
    },
    connection: { phase },
    serverConfig:
      options.withConfig || options.remoteUpdateControl !== undefined
        ? {
            environment: {
              platform: { os: "linux" },
              capabilities: {
                remoteUpdateControl: options.remoteUpdateControl === true,
                remoteUpdateProgress: true,
              },
            },
            providers: [{ instanceId: id }],
          }
        : null,
  };
}

beforeEach(() => {
  harness.environments = [];
  harness.primaryEnvironmentId = "primary";
  harness.capturedInputs = [];
  harness.displayInputs = [];
  harness.snapshotKeys = [];
});

describe("useProviderUpdateEnvironments", () => {
  it("gives only connected remote environments with update control a server snapshot", () => {
    harness.environments = [
      environment("ssh", "connected", { remote: true, remoteUpdateControl: true }),
      environment("relay", "connected", { remote: true, remoteUpdateControl: false }),
      environment("offline", "offline", { remote: true, remoteUpdateControl: true }),
      environment("wsl", "connected", { local: true, remoteUpdateControl: true }),
      environment("primary", "connected", { primary: true, remoteUpdateControl: true }),
    ];

    const inputs = useProviderUpdateEnvironments();

    expect(harness.snapshotKeys).toEqual([JSON.stringify(["ssh"])]);
    expect(inputs.map((input) => input.environmentId)).toEqual([
      "primary",
      "ssh",
      "relay",
      "offline",
      "wsl",
    ]);
    expect(inputs.map((input) => input.serverUpdate)).toEqual([
      undefined,
      { progress: true, snapshot: { state: "snapshot-ssh" } },
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("useLocalEnvironmentUpdateGroups", () => {
  it("keeps local environments, sorts primary first, and normalizes connection phases", () => {
    harness.environments = [
      environment("connected", "connected", { local: true }),
      environment("connecting", "connecting", { local: true }),
      environment("reconnecting", "reconnecting", { local: true }),
      environment("error", "error", { local: true }),
      environment("offline", "offline", { local: true }),
      environment("available", "available", { local: true }),
      environment("unknown", undefined, { local: true }),
      environment("remote", "connected", { remote: true }),
      environment("primary", "offline", { primary: true, withConfig: true }),
    ];

    const result = useLocalEnvironmentUpdateGroups();
    expect(harness.capturedInputs.map((input) => input.environmentId)).toEqual([
      "primary",
      "connected",
      "connecting",
      "reconnecting",
      "error",
      "offline",
      "available",
      "unknown",
    ]);
    expect(harness.capturedInputs.map((input) => input.connectionState)).toEqual([
      "ready",
      "ready",
      "connecting",
      "connecting",
      "error",
      "disconnected",
      "connecting",
      "connecting",
    ]);
    expect(harness.capturedInputs[0]).toMatchObject({
      label: "Primary Linux",
      isPrimary: true,
      providers: [{ instanceId: "primary" }],
    });
    expect(harness.capturedInputs[1]).toMatchObject({ label: "Label connected", providers: [] });
    expect(harness.displayInputs[0]).toMatchObject({ platformOs: "linux" });
    expect(result.isAnySettling).toBe(true);
  });
});
