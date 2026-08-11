import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ContextMenuItemSchema,
  type DesktopBridge,
  DesktopProjectDataEnvironmentStatusSchema,
  DesktopProjectDataRecoveryResultSchema,
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

describe("Desktop project-data recovery contract", () => {
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
