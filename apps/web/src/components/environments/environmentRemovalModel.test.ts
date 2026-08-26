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
      dataRoot: "/srv/bibcode",
      projectCount: 2,
      worktreeCount: 3,
      processCount: 1,
      otherPairedClientCount: 1,
      expiresAt: "2026-08-25T12:05:00.000Z",
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
      canPurge: true,
      remoteActionReason: null,
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

  it("requires the exact alias independently for purge", () => {
    expect(
      validateEnvironmentRemoval(
        context(),
        selection({ purgeRemoteData: true, typedAlias: "build host" }),
        NOW,
      ),
    ).toEqual({
      valid: false,
      reason: "Type Build host exactly to delete remote data.",
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
