import type { ServerConfig } from "@bibcode/contracts";
import type { PreparedConnection } from "../connection/model.ts";

export type FileContentRoute = "http" | "in-channel" | "unavailable";

/** Only the carrying session's capability can authorize a pinned content route. */
export function fileContentRoute(
  prepared: PreparedConnection,
  config: ServerConfig,
): FileContentRoute {
  return prepared.e2ee === null
    ? "http"
    : config.environment.capabilities.inChannelTransfers === true
      ? "in-channel"
      : "unavailable";
}
