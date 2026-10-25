import type { SupervisorConnectionState } from "@bibcode/client-runtime/connection";
import type { ServerConfig } from "@bibcode/contracts";

/** The capability flag a repository module needs before it reads, and the one before it acts. */
export type RepositoryModuleReadsCapability = "pullRequestsReads" | "pipelinesReads";
export type RepositoryModuleMutationsCapability = "pullRequestsMutations" | "pipelinesMutations";

export type RepositoryModuleAvailability<Capability extends RepositoryModuleReadsCapability> =
  | { readonly kind: "ready" }
  | { readonly kind: "disabled_in_settings" }
  | { readonly kind: "pending"; readonly reason: string }
  | { readonly kind: "disconnected"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly missingCapability: Capability };

function disconnectedReason(connectionState: SupervisorConnectionState): string {
  switch (connectionState.phase) {
    case "available":
      return "This environment is disconnected.";
    case "offline":
      return "This environment is offline.";
    case "backoff":
      return connectionState.lastFailure?.message ?? "This environment is reconnecting.";
    case "blocked":
      return connectionState.lastFailure?.message ?? "This environment connection is blocked.";
    case "connecting":
    case "connected":
      return "This environment is unavailable.";
  }
}

/**
 * Whether a repository module (Pull Requests, Pipelines) can read: its setting, the
 * environment connection, and the server's read capability, in that order.
 */
export function resolveRepositoryModuleAvailability<
  Capability extends RepositoryModuleReadsCapability,
>(
  module: { readonly label: string; readonly readsCapability: Capability },
  connectionState: SupervisorConnectionState | null,
  serverConfig: ServerConfig | null,
  enabled: boolean,
): RepositoryModuleAvailability<Capability> {
  if (!enabled) return { kind: "disabled_in_settings" };
  if (connectionState === null) {
    return { kind: "pending", reason: "Waiting for the environment connection state." };
  }
  if (!connectionState.desired || connectionState.phase === "available") {
    return { kind: "disconnected", reason: "This environment is disconnected." };
  }
  if (connectionState.phase === "connecting") {
    return {
      kind: "pending",
      reason:
        connectionState.stage === "synchronizing"
          ? "This environment is synchronizing."
          : "This environment is connecting.",
    };
  }
  if (connectionState.phase !== "connected") {
    return { kind: "disconnected", reason: disconnectedReason(connectionState) };
  }
  if (serverConfig === null) {
    return { kind: "pending", reason: `Waiting for ${module.label} capabilities.` };
  }
  if (serverConfig.environment.capabilities[module.readsCapability] !== true) {
    return { kind: "unsupported", missingCapability: module.readsCapability };
  }
  return { kind: "ready" };
}

/** Why a module's actions are disabled on this server, or `null` when they are available. */
export function resolveRepositoryModuleMutationsDisabledReason(
  module: {
    readonly mutationsCapability: RepositoryModuleMutationsCapability;
    readonly mutationsUnsupportedMessage: string;
  },
  serverConfig: ServerConfig | null,
): string | null {
  return serverConfig?.environment.capabilities[module.mutationsCapability] === true
    ? null
    : module.mutationsUnsupportedMessage;
}
