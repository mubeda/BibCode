import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  executeEnvironmentRemoval,
  getEnvironmentRemovalAvailability,
  validateEnvironmentRemoval,
  type EnvironmentRemovalContext,
  type EnvironmentRemovalSelection,
} from "./environmentRemovalModel";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const environmentId = EnvironmentId.make("env-remote");

function context(overrides: Partial<EnvironmentRemovalContext> = {}): EnvironmentRemovalContext {
  return {
    environmentId,
    environmentGeneration: 4,
    alias: "Build host",
    kind: "remote",
    hidden: false,
    reachability: "online",
    storageId: "storage-1",
    hostAuthorityAvailable: true,
    plan: {
      schemaVersion: 1,
      planId: "plan-1",
      environmentId,
      environmentGeneration: 4,
      storageId: "storage-1",
      environmentName: "Build host",
      dataRoot: "/srv/bibcode",
      projectCount: 2,
      worktreeCount: 3,
      processCount: 1,
      otherPairedClientCount: 1,
      createdAt: "2026-08-25T12:00:00.000Z",
      expiresAt: "2026-08-25T12:05:00.000Z",
      uninstallSupported: true,
      uninstallUnavailableReason: null,
    },
    ...overrides,
  };
}

function selection(
  overrides: Partial<EnvironmentRemovalSelection> = {},
): EnvironmentRemovalSelection {
  return {
    uninstallServer: false,
    purgeRemoteData: false,
    typedAlias: "",
    forceRemoveConfirmed: false,
    ...overrides,
  };
}

describe("environment removal action matrix", () => {
  it("separates disconnect, hide, restore, forget, uninstall, and purge", () => {
    expect(getEnvironmentRemovalAvailability(context(), NOW)).toEqual({
      canDisconnect: true,
      canHide: true,
      canRestore: false,
      canForget: true,
      canForceRemove: false,
      canUninstall: true,
      canPurge: false,
      remoteActionReason: null,
      purgeActionReason:
        "Remove 2 projects and 3 worktrees, and stop 1 running process before deleting remote data.",
    });
    expect(getEnvironmentRemovalAvailability(context({ hidden: true }), NOW)).toMatchObject({
      canHide: false,
      canRestore: true,
    });
  });

  it.each(["offline", "stopped", "setup-required"] as const)(
    "allows only guarded local force removal when %s",
    (reachability) => {
      const availability = getEnvironmentRemovalAvailability(context({ reachability }), NOW);
      expect(availability).toMatchObject({
        canForget: false,
        canForceRemove: true,
        canUninstall: false,
        canPurge: false,
      });
      expect(availability.remoteActionReason).toBeTruthy();
    },
  );

  it("blocks removal of the primary environment", () => {
    const primary = context({ kind: "primary" });
    expect(getEnvironmentRemovalAvailability(primary, NOW)).toMatchObject({
      canDisconnect: false,
      canHide: false,
      canForget: false,
      canForceRemove: false,
      canUninstall: false,
      canPurge: false,
    });
    expect(validateEnvironmentRemoval(primary, selection(), NOW)).toEqual({
      valid: false,
      reason: "The primary environment cannot be removed.",
    });
  });

  it("rejects stale, expired, and identity-mismatched removal plans", () => {
    const remote = selection({ uninstallServer: true });
    expect(
      validateEnvironmentRemoval(context({ environmentGeneration: 5 }), remote, NOW),
    ).toMatchObject({ valid: false });
    expect(
      validateEnvironmentRemoval(
        context({ plan: { ...context().plan!, expiresAt: "2026-08-25T11:59:59.000Z" } }),
        remote,
        NOW,
      ),
    ).toMatchObject({ valid: false });
    expect(
      validateEnvironmentRemoval(context({ storageId: "changed" }), remote, NOW),
    ).toMatchObject({ valid: false });
  });

  it("shows a verified managed-install limitation instead of offering a partial uninstall", () => {
    const unavailable = context({
      plan: {
        ...context().plan!,
        uninstallSupported: false,
        uninstallUnavailableReason:
          "This server was installed by the host package manager; use its native uninstaller.",
      },
    });
    expect(getEnvironmentRemovalAvailability(unavailable, NOW)).toMatchObject({
      canUninstall: false,
      canPurge: false,
      remoteActionReason:
        "This server was installed by the host package manager; use its native uninstaller.",
      purgeActionReason: null,
    });
    expect(
      validateEnvironmentRemoval(unavailable, selection({ uninstallServer: true }), NOW),
    ).toEqual({
      valid: false,
      reason: "This server was installed by the host package manager; use its native uninstaller.",
    });
  });

  it("requires the exact alias independently for purge", () => {
    const emptyPlan = {
      ...context().plan!,
      projectCount: 0,
      worktreeCount: 0,
      processCount: 0,
    };
    expect(
      validateEnvironmentRemoval(
        context({ plan: emptyPlan }),
        selection({ purgeRemoteData: true, typedAlias: "build host" }),
        NOW,
      ),
    ).toEqual({
      valid: false,
      reason: "Type Build host exactly to delete remote data.",
    });
  });

  it("permits purge only when the verified plan has no owned projects, worktrees, or processes", () => {
    const emptyPlan = {
      ...context().plan!,
      projectCount: 0,
      worktreeCount: 0,
      processCount: 0,
    };
    expect(getEnvironmentRemovalAvailability(context({ plan: emptyPlan }), NOW)).toMatchObject({
      canUninstall: true,
      canPurge: true,
      purgeActionReason: null,
    });
  });

  it("never executes or queues a remote action during offline force removal", async () => {
    const executeRemote = vi.fn(async () => ({ verified: true as const }));
    const forgetLocal = vi.fn(async () => undefined);
    const result = await executeEnvironmentRemoval(
      context({ reachability: "offline", plan: null, hostAuthorityAvailable: false }),
      selection({ typedAlias: "Build host", forceRemoveConfirmed: true }),
      { executeRemote, forgetLocal },
      NOW,
    );
    expect(result).toMatchObject({
      status: "removed",
      localRemoved: true,
      remoteOutcome: "unknown",
      retainCatalog: false,
    });
    expect(executeRemote).not.toHaveBeenCalled();
    expect(forgetLocal).toHaveBeenCalledWith(environmentId);
  });

  it("rejects offline remote options and typed-alias mismatch", () => {
    const offline = context({ reachability: "offline" });
    expect(
      validateEnvironmentRemoval(offline, selection({ uninstallServer: true }), NOW),
    ).toMatchObject({ valid: false });
    expect(
      validateEnvironmentRemoval(
        offline,
        selection({ typedAlias: "wrong", forceRemoveConfirmed: true }),
        NOW,
      ),
    ).toEqual({
      valid: false,
      reason: "Type Build host exactly to confirm local removal.",
    });
  });

  it("preserves data during uninstall and forgets only after remote verification", async () => {
    const events: string[] = [];
    const result = await executeEnvironmentRemoval(
      context(),
      selection({ uninstallServer: true }),
      {
        executeRemote: async (request) => {
          events.push(`remote:${request.action}:${String(request.preserveData)}`);
          return { verified: true };
        },
        forgetLocal: async () => {
          events.push("local:forget");
        },
      },
      NOW,
    );
    expect(events).toEqual(["remote:uninstall:true", "local:forget"]);
    expect(result.remoteOutcome).toBe("verified");
  });

  it("passes the exact typed alias through the destructive purge request", async () => {
    const requests: unknown[] = [];
    const emptyPlan = {
      ...context().plan!,
      projectCount: 0,
      worktreeCount: 0,
      processCount: 0,
    };
    const result = await executeEnvironmentRemoval(
      context({ plan: emptyPlan }),
      selection({ purgeRemoteData: true, typedAlias: "Build host" }),
      {
        executeRemote: async (request) => {
          requests.push(request);
          return { verified: true };
        },
        forgetLocal: async () => undefined,
      },
      NOW,
    );
    expect(requests).toEqual([
      {
        action: "purge",
        environmentId,
        planId: "plan-1",
        confirmEnvironmentName: "Build host",
        preserveData: false,
      },
    ]);
    expect(result.status).toBe("removed");
  });

  it("retains catalog metadata when the remote step fails", async () => {
    const forgetLocal = vi.fn(async () => undefined);
    const result = await executeEnvironmentRemoval(
      context(),
      selection({ uninstallServer: true }),
      {
        executeRemote: async () => {
          throw new Error("Host became unreachable; retry is available.");
        },
        forgetLocal,
      },
      NOW,
    );
    expect(result).toEqual({
      status: "remote-failed",
      localRemoved: false,
      remoteOutcome: "failed",
      retainCatalog: true,
      message: "Host became unreachable; retry is available.",
    });
    expect(forgetLocal).not.toHaveBeenCalled();
  });
});
