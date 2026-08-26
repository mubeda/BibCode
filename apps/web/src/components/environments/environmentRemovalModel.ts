import type { EnvironmentId } from "@bibcode/contracts";

export type EnvironmentRemovalReachability = "online" | "offline" | "stopped" | "setup-required";

export interface EnvironmentRemovalPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly environmentId: EnvironmentId;
  readonly environmentGeneration: number;
  readonly storageId: string;
  readonly dataRoot: string;
  readonly projectCount: number;
  readonly worktreeCount: number;
  readonly processCount: number;
  readonly otherPairedClientCount: number;
  readonly expiresAt: string;
}

export interface EnvironmentRemovalContext {
  readonly environmentId: EnvironmentId;
  readonly environmentGeneration: number;
  readonly alias: string;
  readonly kind: "primary" | "wsl" | "remote";
  readonly hidden: boolean;
  readonly reachability: EnvironmentRemovalReachability;
  readonly storageId: string | null;
  readonly hostAuthorityAvailable: boolean;
  readonly plan: EnvironmentRemovalPlan | null;
}

export interface EnvironmentRemovalSelection {
  readonly uninstallServer: boolean;
  readonly purgeRemoteData: boolean;
  readonly typedAlias: string;
  readonly forceRemoveConfirmed: boolean;
}

export interface EnvironmentRemovalAvailability {
  readonly canDisconnect: boolean;
  readonly canHide: boolean;
  readonly canRestore: boolean;
  readonly canForget: boolean;
  readonly canForceRemove: boolean;
  readonly canUninstall: boolean;
  readonly canPurge: boolean;
  readonly remoteActionReason: string | null;
}

export type EnvironmentRemovalValidation =
  | { readonly valid: true; readonly plan: EnvironmentRemovalPlan | null }
  | { readonly valid: false; readonly reason: string };

export type EnvironmentRemoteRemovalRequest =
  | {
      readonly action: "uninstall";
      readonly environmentId: EnvironmentId;
      readonly planId: string;
      readonly preserveData: true;
    }
  | {
      readonly action: "purge";
      readonly environmentId: EnvironmentId;
      readonly planId: string;
      readonly preserveData: false;
    };

export interface EnvironmentRemovalOutcome {
  readonly status: "removed" | "remote-failed" | "local-failed";
  readonly localRemoved: boolean;
  readonly remoteOutcome: "not-requested" | "verified" | "unknown" | "failed";
  readonly retainCatalog: boolean;
  readonly message: string;
}

export interface EnvironmentRemovalHandlers {
  readonly executeRemote: (
    request: EnvironmentRemoteRemovalRequest,
  ) => Promise<{ readonly verified: true }>;
  readonly forgetLocal: (environmentId: EnvironmentId) => Promise<void>;
}

function isOnline(context: EnvironmentRemovalContext): boolean {
  return context.reachability === "online";
}

export function isFreshEnvironmentRemovalPlan(
  context: EnvironmentRemovalContext,
  now: Date,
): context is EnvironmentRemovalContext & { readonly plan: EnvironmentRemovalPlan } {
  const plan = context.plan;
  return (
    plan !== null &&
    plan.schemaVersion === 1 &&
    plan.environmentId === context.environmentId &&
    plan.environmentGeneration === context.environmentGeneration &&
    context.storageId !== null &&
    plan.storageId === context.storageId &&
    Number.isFinite(Date.parse(plan.expiresAt)) &&
    Date.parse(plan.expiresAt) > now.getTime()
  );
}

export function getEnvironmentRemovalAvailability(
  context: EnvironmentRemovalContext,
  now: Date,
): EnvironmentRemovalAvailability {
  const primary = context.kind === "primary";
  const online = isOnline(context);
  const freshPlan = isFreshEnvironmentRemovalPlan(context, now);
  let remoteActionReason: string | null = null;
  if (!online) {
    remoteActionReason =
      context.reachability === "stopped"
        ? "Start the server before uninstalling it or deleting remote data."
        : context.reachability === "setup-required"
          ? "Complete server setup before using remote removal actions."
          : "Remote actions are unavailable while this environment is offline.";
  } else if (!context.hostAuthorityAvailable) {
    remoteActionReason = "This client has no verified host-authority channel for remote actions.";
  } else if (!freshPlan) {
    remoteActionReason = "Fetch a fresh removal plan before changing the remote host.";
  }

  const canMutateRemote = !primary && online && context.hostAuthorityAvailable && freshPlan;
  return {
    canDisconnect: !primary && online,
    canHide: !primary && !context.hidden,
    canRestore: !primary && context.hidden,
    canForget: !primary && online,
    canForceRemove: !primary && !online,
    canUninstall: canMutateRemote,
    canPurge: canMutateRemote,
    remoteActionReason: canMutateRemote ? null : remoteActionReason,
  };
}

export function validateEnvironmentRemoval(
  context: EnvironmentRemovalContext,
  selection: EnvironmentRemovalSelection,
  now: Date,
): EnvironmentRemovalValidation {
  if (context.kind === "primary") {
    return { valid: false, reason: "The primary environment cannot be removed." };
  }
  const online = isOnline(context);
  if (!online) {
    if (selection.uninstallServer || selection.purgeRemoteData) {
      return {
        valid: false,
        reason: "Remote uninstall and purge cannot run or be queued while offline.",
      };
    }
    if (selection.typedAlias !== context.alias) {
      return { valid: false, reason: `Type ${context.alias} exactly to confirm local removal.` };
    }
    if (!selection.forceRemoveConfirmed) {
      return { valid: false, reason: "Confirm Force remove from this client." };
    }
    return { valid: true, plan: null };
  }

  if (!selection.uninstallServer && !selection.purgeRemoteData) {
    return { valid: true, plan: null };
  }
  if (!context.hostAuthorityAvailable) {
    return {
      valid: false,
      reason: "Remote removal requires a verified host-authority channel.",
    };
  }
  if (!isFreshEnvironmentRemovalPlan(context, now)) {
    return { valid: false, reason: "The removal plan is missing, stale, or for another identity." };
  }
  if (selection.purgeRemoteData && selection.typedAlias !== context.alias) {
    return { valid: false, reason: `Type ${context.alias} exactly to delete remote data.` };
  }
  return { valid: true, plan: context.plan };
}

export async function executeEnvironmentRemoval(
  context: EnvironmentRemovalContext,
  selection: EnvironmentRemovalSelection,
  handlers: EnvironmentRemovalHandlers,
  now: Date,
): Promise<EnvironmentRemovalOutcome> {
  const validation = validateEnvironmentRemoval(context, selection, now);
  if (!validation.valid) {
    return {
      status: "local-failed",
      localRemoved: false,
      remoteOutcome: "not-requested",
      retainCatalog: true,
      message: validation.reason,
    };
  }

  const offline = !isOnline(context);
  if (!offline && (selection.uninstallServer || selection.purgeRemoteData)) {
    const plan = validation.plan;
    if (plan === null) {
      return {
        status: "remote-failed",
        localRemoved: false,
        remoteOutcome: "failed",
        retainCatalog: true,
        message: "A verified removal plan is required.",
      };
    }
    try {
      await handlers.executeRemote(
        selection.purgeRemoteData
          ? {
              action: "purge",
              environmentId: context.environmentId,
              planId: plan.planId,
              preserveData: false,
            }
          : {
              action: "uninstall",
              environmentId: context.environmentId,
              planId: plan.planId,
              preserveData: true,
            },
      );
    } catch (error) {
      return {
        status: "remote-failed",
        localRemoved: false,
        remoteOutcome: "failed",
        retainCatalog: true,
        message:
          error instanceof Error
            ? error.message
            : "Remote removal failed. The environment was kept so the operation can be resumed.",
      };
    }
  }

  try {
    await handlers.forgetLocal(context.environmentId);
  } catch (error) {
    return {
      status: "local-failed",
      localRemoved: false,
      remoteOutcome: offline
        ? "unknown"
        : selection.uninstallServer || selection.purgeRemoteData
          ? "verified"
          : "not-requested",
      retainCatalog: true,
      message: error instanceof Error ? error.message : "Local environment cleanup failed.",
    };
  }

  return {
    status: "removed",
    localRemoved: true,
    remoteOutcome: offline
      ? "unknown"
      : selection.uninstallServer || selection.purgeRemoteData
        ? "verified"
        : "not-requested",
    retainCatalog: false,
    message: offline
      ? "Removed from this client. The remote host outcome is unknown."
      : "Environment removal completed.",
  };
}
