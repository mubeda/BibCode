import type { ServerConfig } from "@bibcode/contracts";
import { makeTestExecutionEnvironmentCapabilities } from "@bibcode/shared/testSupport";
import { describe, expect, it } from "vite-plus/test";

import { devicePreviewsAvailability } from "./deviceAvailability";

function config(
  capabilities: Parameters<typeof makeTestExecutionEnvironmentCapabilities>[0],
  enableDevicePreviews = true,
): ServerConfig {
  return {
    environment: { capabilities: makeTestExecutionEnvironmentCapabilities(capabilities) },
    settings: { enableDevicePreviews },
  } as unknown as ServerConfig;
}

describe("devicePreviewsAvailability", () => {
  it("knows nothing before the server config arrives", () => {
    expect(devicePreviewsAvailability(null)).toEqual({
      known: false,
      supported: false,
      enabled: false,
      catalogRefresh: false,
    });
  });

  it("offers Refresh devices only on a server that advertises device.refreshCatalog (#169)", () => {
    // An older server with device previews but without the method.
    expect(devicePreviewsAvailability(config({ devicePreviews: true })).catalogRefresh).toBe(false);
    expect(
      devicePreviewsAvailability(config({ devicePreviews: true, deviceCatalogRefresh: true }))
        .catalogRefresh,
    ).toBe(true);
    expect(
      devicePreviewsAvailability(config({ devicePreviews: false, deviceCatalogRefresh: true }))
        .catalogRefresh,
    ).toBe(false);
  });
});
