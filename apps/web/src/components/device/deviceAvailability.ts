import type { EnvironmentId, ServerConfig } from "@bibcode/contracts";
import { useAtomValue } from "@effect/atom-react";

import { serverEnvironment } from "../../state/server";

/** Whether an environment offers device previews, from its server config. */
export interface DevicePreviewsAvailability {
  /** The server config has arrived; until then nothing is known. */
  readonly known: boolean;
  /** The server has device previews (the `devicePreviews` capability). */
  readonly supported: boolean;
  /** `enableDevicePreviews` is on. */
  readonly enabled: boolean;
  /**
   * The server has `device.refreshCatalog` (the `deviceCatalogRefresh` capability). An older
   * server answers an unknown method with a defect that breaks the whole RPC session.
   */
  readonly catalogRefresh: boolean;
}

export function devicePreviewsAvailability(
  serverConfig: ServerConfig | null | undefined,
): DevicePreviewsAvailability {
  if (serverConfig === null || serverConfig === undefined) {
    return { known: false, supported: false, enabled: false, catalogRefresh: false };
  }
  const { capabilities } = serverConfig.environment;
  const supported = capabilities.devicePreviews === true;
  return {
    known: true,
    supported,
    enabled: supported && serverConfig.settings.enableDevicePreviews === true,
    catalogRefresh: supported && capabilities.deviceCatalogRefresh === true,
  };
}

/** The one gate for every device-preview entry point: menu, palette, pane, and settings. */
export function useDevicePreviewsAvailability(
  environmentId: EnvironmentId | null,
): DevicePreviewsAvailability {
  return devicePreviewsAvailability(useAtomValue(serverEnvironment.configValueAtom(environmentId)));
}
