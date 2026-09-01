import type { SupervisorConnectionState } from "@bibcode/client-runtime/connection";
import type { ServerConfig } from "@bibcode/contracts";

export type GitManagerAvailability =
  | { readonly kind: "ready" }
  | { readonly kind: "pending"; readonly reason: string }
  | { readonly kind: "disconnected"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly missingCapability: "gitManagerReads" };

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

export function resolveGitManagerAvailability(
  connectionState: SupervisorConnectionState | null,
  serverConfig: ServerConfig | null,
): GitManagerAvailability {
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
    return { kind: "pending", reason: "Waiting for Git Manager capabilities." };
  }
  if (serverConfig.environment.capabilities.gitManagerReads !== true) {
    return { kind: "unsupported", missingCapability: "gitManagerReads" };
  }
  return { kind: "ready" };
}
