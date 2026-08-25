import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ContextMenuItemSchema,
  type DesktopBridge,
  DesktopSecretInputSchema,
  DesktopSecretReferenceSchema,
  DesktopSecretStoreErrorSchema,
  DesktopServerExposureStateSchema,
  DesktopProjectDataEnvironmentStatusSchema,
  DesktopProjectDataRecoveryResultSchema,
  DesktopWslDiscoverySchema,
  RemoteHostProbeSchema,
  RemoteSetupCancellationSchema,
  RemoteSetupConsentDecisionSchema,
  RemoteSetupConsentSchema,
  RemoteSetupProgressSchema,
  type DesktopUpdateState,
  DesktopEnvironmentBootstrapSchema,
  DesktopUpdateStateSchema,
} from "./ipc.ts";
import { expectDecodeFailure, expectEncodeFailure } from "./test/schemaAssertions.ts";

const decodeContextMenuItem = Schema.decodeUnknownSync(ContextMenuItemSchema);
const encodeContextMenuItem = Schema.encodeSync(ContextMenuItemSchema);
const decodeDesktopEnvironmentBootstrap = Schema.decodeUnknownSync(
  DesktopEnvironmentBootstrapSchema,
);
const decodeDesktopUpdateState = Schema.decodeUnknownSync(DesktopUpdateStateSchema);
const decodeProjectDataStatus = Schema.decodeUnknownSync(DesktopProjectDataEnvironmentStatusSchema);
const decodeProjectDataRecoveryResult = Schema.decodeUnknownSync(
  DesktopProjectDataRecoveryResultSchema,
);
const decodeDesktopSecretInput = Schema.decodeUnknownSync(DesktopSecretInputSchema);
const decodeDesktopSecretReference = Schema.decodeUnknownSync(DesktopSecretReferenceSchema);
const decodeDesktopSecretStoreError = Schema.decodeUnknownSync(DesktopSecretStoreErrorSchema);
const decodeDesktopServerExposureState = Schema.decodeUnknownSync(DesktopServerExposureStateSchema);
const decodeDesktopWslDiscovery = Schema.decodeUnknownSync(DesktopWslDiscoverySchema);
const decodeRemoteHostProbe = Schema.decodeUnknownSync(RemoteHostProbeSchema);
const decodeRemoteSetupConsent = Schema.decodeUnknownSync(RemoteSetupConsentSchema);
const decodeRemoteSetupConsentDecision = Schema.decodeUnknownSync(RemoteSetupConsentDecisionSchema);
const decodeRemoteSetupProgress = Schema.decodeUnknownSync(RemoteSetupProgressSchema);
const decodeRemoteSetupCancellation = Schema.decodeUnknownSync(RemoteSetupCancellationSchema);

describe("Desktop WSL discovery contract", () => {
  it("preserves Running/Stopped state, default marker, and WSL version", () => {
    expect(
      decodeDesktopWslDiscovery({
        generation: 7,
        observedAt: "2036-08-25T12:00:00.000Z",
        health: "available",
        detail: null,
        distros: [
          { name: "Ubuntu", isDefault: true, state: "running", version: 2 },
          { name: "Legacy Dev", isDefault: false, state: "stopped", version: 1 },
        ],
      }),
    ).toMatchObject({
      generation: 7,
      health: "available",
      distros: [
        { name: "Ubuntu", isDefault: true, state: "running", version: 2 },
        { name: "Legacy Dev", isDefault: false, state: "stopped", version: 1 },
      ],
    });
  });

  it.each(["disabled", "missing", "timedOut", "failed"] as const)(
    "represents %s discovery health without fabricating a distro",
    (health) => {
      expect(
        decodeDesktopWslDiscovery({
          generation: 8,
          observedAt: "2036-08-25T12:01:00.000Z",
          health,
          detail: health === "failed" ? "permission denied" : null,
          distros: [],
        }),
      ).toMatchObject({ health, distros: [] });
    },
  );

  it("carries a generation so consumers can reject a late snapshot", () => {
    const current = decodeDesktopWslDiscovery({
      generation: 11,
      observedAt: "2036-08-25T12:03:00.000Z",
      health: "available",
      detail: null,
      distros: [{ name: "Ubuntu", isDefault: true, state: "running", version: 2 }],
    });
    const late = decodeDesktopWslDiscovery({
      generation: 10,
      observedAt: "2036-08-25T12:02:00.000Z",
      health: "available",
      detail: null,
      distros: [{ name: "Debian", isDefault: false, state: "running", version: 2 }],
    });

    expect(late.generation).toBeLessThan(current.generation);
  });

  it("rejects malformed rows instead of weakening the event contract", () => {
    expect(() =>
      decodeDesktopWslDiscovery({
        generation: 12,
        observedAt: "2036-08-25T12:04:00.000Z",
        health: "available",
        detail: "one malformed native row was isolated before publication",
        distros: [{ name: "Ubuntu", isDefault: true, state: "paused", version: 2 }],
      }),
    ).toThrow();
  });

  it("rejects an unbounded native diagnostic", () => {
    expect(() =>
      decodeDesktopWslDiscovery({
        generation: 13,
        observedAt: "2036-08-25T12:05:00.000Z",
        health: "failed",
        detail: "x".repeat(4097),
        distros: [],
      }),
    ).toThrow();
  });
});

describe("Remote setup contracts", () => {
  it.each([
    ["linux", "x86_64"],
    ["macos", "aarch64"],
    ["windows", "x86_64"],
  ] as const)("decodes a staged %s/%s host probe", (os, architecture) => {
    expect(
      decodeRemoteHostProbe({
        os,
        architecture,
        installedVersion: "0.4.1",
        serviceMode: "workstation",
        serviceState: "running",
        dataRoot: "/managed/bibcode",
        controlAvailable: true,
      }),
    ).toMatchObject({ os, architecture, serviceState: "running" });
  });

  it("binds install consent to one request and probe generation", () => {
    const consent = decodeRemoteSetupConsent({
      requestId: "setup-1",
      probeGeneration: 4,
      transport: "ssh",
      targetLabel: "build-host",
      targetVersion: "0.4.2",
      artifact: {
        product: "bibcode-server",
        version: "0.4.2",
        os: "linux",
        architecture: "x86_64",
        format: "tar.gz",
        downloadName: "bibcode-server-linux-x86_64.tar.gz",
        size: 4096,
        sha256: "a".repeat(64),
        signatureName: "bibcode-server-linux-x86_64.tar.gz.sig",
      },
      installDestination: "/home/dev/.local/share/bibcode/server/0.4.2",
      dataRoot: "/home/dev/.bibcode",
      serviceMode: "workstation",
      requiredCommands: ["transfer verified artifact", "install atomically"],
      expiresAt: "2036-08-25T12:10:00.000Z",
    });
    const decision = decodeRemoteSetupConsentDecision({
      requestId: consent.requestId,
      probeGeneration: consent.probeGeneration,
      accepted: true,
    });

    expect(decision).toEqual({ requestId: "setup-1", probeGeneration: 4, accepted: true });
  });

  it("reports bounded stage progress without a credential field", () => {
    const progress = decodeRemoteSetupProgress({
      requestId: "setup-1",
      generation: 5,
      stage: "transfer",
      status: "running",
      completedBytes: 1024,
      totalBytes: 4096,
      message: "Transferring verified server artifact.",
      credential: "must-not-survive-decoding",
    });

    expect(progress).toMatchObject({ stage: "transfer", completedBytes: 1024 });
    expect(progress).not.toHaveProperty("credential");
    expect(() =>
      decodeRemoteSetupProgress({
        ...progress,
        completedBytes: 4097,
        totalBytes: 4096,
      }),
    ).toThrow();
    expect(() =>
      decodeRemoteSetupProgress({
        ...progress,
        message: "x".repeat(4097),
      }),
    ).toThrow();
  });

  it("represents cancellation as a terminal request-scoped event", () => {
    expect(
      decodeRemoteSetupCancellation({
        requestId: "setup-1",
        generation: 6,
        stage: "install",
        status: "cancelled",
        mutationStatus: "partial",
        cleanupStatus: "completed",
        message: "Installation was cancelled; the previous version remains active.",
      }),
    ).toMatchObject({ status: "cancelled", mutationStatus: "partial" });
  });
});

describe("Desktop server exposure contract", () => {
  it("represents only the packaged loopback listener", () => {
    expect(
      decodeDesktopServerExposureState({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      }),
    ).toMatchObject({ mode: "local-only" });
    expect(() =>
      decodeDesktopServerExposureState({
        mode: "network-accessible",
        endpointUrl: "http://192.0.2.10:3773",
        advertisedHost: "192.0.2.10",
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      }),
    ).toThrow();
  });
});

describe("Desktop secret-store contract", () => {
  it("round-trips opaque references without exposing an inventory operation", async () => {
    const stored = new Map<string, string>();
    const reference = "bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8";
    const bridge: Required<Pick<DesktopBridge, "putSecret" | "getSecret" | "deleteSecret">> = {
      putSecret: async (input) => {
        stored.set(reference, input.value);
        return reference;
      },
      getSecret: async (secretRef) => stored.get(secretRef) ?? null,
      deleteSecret: async (secretRef) => {
        stored.delete(secretRef);
      },
    };

    const secretRef = await bridge.putSecret({
      purpose: "environment-session",
      value: "secret-value",
    });

    expect(secretRef).toMatch(/^bibcode-secret:/u);
    await expect(bridge.getSecret(secretRef)).resolves.toBe("secret-value");
    await bridge.deleteSecret(secretRef);
    await expect(bridge.getSecret(secretRef)).resolves.toBeNull();
    expect("listSecrets" in bridge).toBe(false);
  });

  it("decodes only approved purposes and canonical opaque references", () => {
    expect(
      decodeDesktopSecretInput({ purpose: "dpop-private-key", value: "private material" }),
    ).toEqual({ purpose: "dpop-private-key", value: "private material" });
    expect(
      decodeDesktopSecretReference("bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8"),
    ).toBe("bibcode-secret:70a3dd71-952a-4eb6-a9a8-424a462e33c8");
    expect(() =>
      decodeDesktopSecretReference("bibcode-secret:70A3DD71952A4EB6A9A8424A462E33C8"),
    ).toThrow();
    expect(() =>
      decodeDesktopSecretInput({ purpose: "telemetry-token", value: "blocked" }),
    ).toThrow();
  });

  it("keeps provider failures typed and structurally unable to carry secret material", () => {
    expect(decodeDesktopSecretStoreError({ code: "unavailable" })).toEqual({
      code: "unavailable",
    });
    expect(decodeDesktopSecretStoreError({ code: "locked" })).toEqual({ code: "locked" });
    const decoded = decodeDesktopSecretStoreError({ code: "locked", detail: "secret-value" });
    expect(decoded).toEqual({ code: "locked" });
    expect(JSON.stringify(decoded)).not.toContain("secret-value");
  });
});

describe("Desktop project-data recovery contract", () => {
  it("exposes a disposable project data status invalidation subscription", () => {
    let listener: (event: { readonly environmentId: string }) => void = () => undefined;
    const dispose = vi.fn();
    const bridge: Pick<DesktopBridge, "onProjectDataStatusChanged"> = {
      onProjectDataStatusChanged: (nextListener) => {
        listener = nextListener;
        return dispose;
      },
    };
    const received: unknown[] = [];

    const unsubscribe = bridge.onProjectDataStatusChanged?.((event) => received.push(event));
    listener({ environmentId: "primary" });
    unsubscribe?.();

    expect(received).toEqual([{ environmentId: "primary" }]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("decodes redacted environment-specific status and verified backups", () => {
    expect(
      decodeProjectDataStatus({
        environmentId: "wsl:Ubuntu",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        status: "recovery-required",
        requestedRoot: "/home/user/.bibcode",
        effectiveRoot: "/home/user/.bibcode",
        isFilesystemAlias: false,
        storageInstanceId: "b102f72a-c63b-4801-8f14-fba7a16856b8",
        issue: "The database is missing while its storage marker remains.",
        backups: [
          {
            backupId: "26b6ca53-27d3-401a-b51f-d7bdf534081f",
            createdAt: "2026-08-10T12:30:00Z",
            trigger: "pre-update",
            appVersion: "0.3.10",
            schemaVersion: 38,
            sizeBytes: 1024,
          },
        ],
      }),
    ).toMatchObject({
      environmentId: "wsl:Ubuntu",
      status: "recovery-required",
      backups: [{ trigger: "pre-update", sizeBytes: 1024 }],
    });
  });

  it("keeps a committed recovery distinct from a restart failure", () => {
    expect(
      decodeProjectDataRecoveryResult({
        environmentId: "primary",
        action: "restore",
        committed: true,
        preservedDirectory: "/Users/user/.bibcode/recovery/userdata/operation",
        storageInstanceId: "b102f72a-c63b-4801-8f14-fba7a16856b8",
        restartError: "The backend could not restart.",
      }),
    ).toMatchObject({ committed: true, restartError: "The backend could not restart." });
  });

  it("exposes only environment and backup identifiers to privileged mutations", async () => {
    const bridge: Pick<
      DesktopBridge,
      "restoreProjectData" | "startEmptyProjectData" | "retryProjectData"
    > = {
      restoreProjectData: async (environmentId, backupId) => ({
        environmentId,
        action: "restore",
        committed: true,
        preservedDirectory: "preserved",
        storageInstanceId: backupId,
        restartError: null,
      }),
      startEmptyProjectData: async (environmentId) => ({
        environmentId,
        action: "start-empty",
        committed: true,
        preservedDirectory: "preserved",
        storageInstanceId: null,
        restartError: null,
      }),
      retryProjectData: async () => undefined,
    };

    await expect(bridge.restoreProjectData!("primary", "backup-id")).resolves.toMatchObject({
      environmentId: "primary",
      action: "restore",
    });
    await expect(bridge.startEmptyProjectData!("primary")).resolves.toMatchObject({
      action: "start-empty",
    });
    await expect(bridge.retryProjectData!("primary")).resolves.toBeUndefined();
  });
});

const legacyUpdateState = {
  enabled: true,
  status: "downloaded",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
} satisfies DesktopUpdateState;

describe("Desktop update protection contract", () => {
  it("decodes additive protection fields from a current host", () => {
    expect(
      decodeDesktopUpdateState({
        ...legacyUpdateState,
        phase: "protecting",
        protection: [
          {
            environmentId: "primary",
            label: "Local",
            status: "protected",
            message: null,
          },
          {
            environmentId: "wsl:Ubuntu",
            label: "WSL (Ubuntu)",
            status: "failed",
            message: "Backup failed.",
          },
        ],
      }),
    ).toMatchObject({
      phase: "protecting",
      protection: [
        { environmentId: "primary", status: "protected" },
        { environmentId: "wsl:Ubuntu", status: "failed" },
      ],
    });
  });

  it("defaults fields omitted by an older desktop host without losing update state", () => {
    expect(decodeDesktopUpdateState(legacyUpdateState)).toEqual({
      ...legacyUpdateState,
      phase: "idle",
      protection: [],
    });
  });

  it("exposes explicit named exclusions on the asynchronous install command", async () => {
    const installUpdate: Pick<DesktopBridge, "installUpdate">["installUpdate"] = async (input) => ({
      accepted: true,
      completed: false,
      state: {
        ...legacyUpdateState,
        phase: "failed",
        protection: [
          {
            environmentId: input?.excludedEnvironmentIds?.[0] ?? "missing",
            label: "WSL (Ubuntu)",
            status: "excluded",
            message: null,
          },
        ],
      },
    });

    await expect(installUpdate({ excludedEnvironmentIds: ["wsl:Ubuntu"] })).resolves.toMatchObject({
      state: { protection: [{ environmentId: "wsl:Ubuntu", status: "excluded" }] },
    });
  });
});

describe("DesktopBridge connection catalog", () => {
  it("exposes an exact-raw compare-and-set operation", async () => {
    let catalog: string | null = "before";
    const bridge: Pick<DesktopBridge, "compareAndSetConnectionCatalog"> = {
      compareAndSetConnectionCatalog: async (expected, next) => {
        if (catalog !== expected) return false;
        catalog = next;
        return true;
      },
    };

    await expect(bridge.compareAndSetConnectionCatalog!("stale", "ignored")).resolves.toBe(false);
    await expect(bridge.compareAndSetConnectionCatalog!("before", "after")).resolves.toBe(true);
    expect(catalog).toBe("after");
  });

  it("exposes an exact-raw comparison without mutation", async () => {
    const catalog: string | null = "current";
    const bridge: Pick<DesktopBridge, "compareConnectionCatalog"> = {
      compareConnectionCatalog: async (expected) => catalog === expected,
    };

    await expect(bridge.compareConnectionCatalog!("current")).resolves.toBe(true);
    await expect(bridge.compareConnectionCatalog!("stale")).resolves.toBe(false);
    expect(catalog).toBe("current");
  });
});

describe("DesktopEnvironmentBootstrapSchema", () => {
  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decodeDesktopEnvironmentBootstrap({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decodeDesktopEnvironmentBootstrap({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });

  it("preserves a configured but unavailable WSL secondary as typed topology", () => {
    expect(
      decodeDesktopEnvironmentBootstrap({
        id: "wsl:Ubuntu",
        label: "WSL (Ubuntu)",
        configuredDistro: "Ubuntu",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
        preflightError: {
          kind: "wsl-secondary-unavailable",
          detail: "the configured distribution could not start",
        },
      }),
    ).toEqual({
      id: "wsl:Ubuntu",
      label: "WSL (Ubuntu)",
      configuredDistro: "Ubuntu",
      runningDistro: null,
      httpBaseUrl: null,
      wsBaseUrl: null,
      preflightError: {
        kind: "wsl-secondary-unavailable",
        detail: "the configured distribution could not start",
      },
    });
  });
});

describe("ContextMenuItemSchema", () => {
  it("round-trips nested menu items and optional presentation fields", () => {
    const input = {
      id: "git",
      label: "Git",
      header: true,
      children: [
        {
          id: "push",
          label: "Push",
          destructive: false,
          disabled: true,
          icon: "upload",
        },
      ],
    };
    const decoded = decodeContextMenuItem(input);

    expect(decoded.children?.[0]?.id).toBe("push");
    expect(encodeContextMenuItem(decoded)).toEqual(input);
  });

  it("reports invalid recursive children on decode and encode", () => {
    const invalid = { id: "git", label: "Git", children: [{ id: 1, label: "Push" }] };
    const expected = {
      rootTag: "Composite" as const,
      paths: [["children", 0, "id"]],
      containsTag: "InvalidType" as const,
    };
    expectDecodeFailure(ContextMenuItemSchema, invalid, expected);
    expectEncodeFailure(ContextMenuItemSchema, invalid, expected);
  });
});
