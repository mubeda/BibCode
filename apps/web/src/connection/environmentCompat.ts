import { computeCompatVerdict, type CompatVerdict } from "@bibcode/client-runtime/connection";
import type { ServerConfig } from "@bibcode/contracts";

/**
 * Compatibility verdict for an environment. `null` means the environment has
 * never delivered a descriptor, so callers should degrade without treating it
 * as a legacy server.
 */
export function resolveEnvironmentCompatVerdict(
  serverConfig: ServerConfig | null,
): CompatVerdict | null {
  if (serverConfig === null) {
    return null;
  }
  return computeCompatVerdict(serverConfig.environment);
}

/**
 * Whether the server advertises remote update control. Phase 7 adds the typed
 * capability field; until then this is the single defensive compatibility
 * read and defaults closed for older descriptors.
 */
export function selectRemoteUpdateControlCapability(serverConfig: ServerConfig | null): boolean {
  if (serverConfig === null) {
    return false;
  }
  const capabilities = serverConfig.environment.capabilities as {
    readonly remoteUpdateControl?: unknown;
  };
  return capabilities.remoteUpdateControl === true;
}
