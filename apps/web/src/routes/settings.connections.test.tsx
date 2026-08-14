import { describe, expect, it } from "@effect/vitest";

import { createEnvironmentPresentationPolicy } from "~/connection/environmentPresentationPolicy";
import { connectionsRouteDestination } from "./settings.connections";

describe("connectionsRouteDestination", () => {
  it("keeps browser and Windows on Connections while redirecting other desktops", () => {
    expect(
      connectionsRouteDestination(
        createEnvironmentPresentationPolicy({ surface: "browser", platform: "unknown" }),
      ),
    ).toBe("/settings/connections");
    expect(
      connectionsRouteDestination(
        createEnvironmentPresentationPolicy({ surface: "desktop", platform: "windows" }),
      ),
    ).toBe("/settings/connections");

    for (const platform of ["macos", "linux", "unknown"] as const) {
      expect(
        connectionsRouteDestination(
          createEnvironmentPresentationPolicy({ surface: "desktop", platform }),
        ),
      ).toBe("/settings/general");
    }
  });
});
