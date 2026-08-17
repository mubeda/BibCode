import { describe, expect, it, vi } from "vite-plus/test";

import { createEnvironmentPresentationPolicy } from "~/connection/environmentPresentationPolicy";

const h = vi.hoisted(() => ({
  policy: null as ReturnType<
    typeof import("~/connection/environmentPresentationPolicy").createEnvironmentPresentationPolicy
  > | null,
}));

vi.mock("~/connection/currentEnvironmentPresentation", () => ({
  readCurrentEnvironmentPresentationPolicy: () => h.policy,
}));

import { Route, connectionsRouteDestination } from "./settings.connections";

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

  it("registers a replacing General redirect for non-Windows desktop route loads", async () => {
    const beforeLoad = Route.options.beforeLoad;
    if (typeof beforeLoad !== "function") throw new Error("Route beforeLoad is not registered.");

    for (const platform of ["macos", "linux", "unknown"] as const) {
      h.policy = createEnvironmentPresentationPolicy({ surface: "desktop", platform });
      await expect(Promise.resolve().then(() => beforeLoad({} as never))).rejects.toMatchObject({
        status: 307,
        options: { to: "/settings/general", replace: true },
      });
    }
  });

  it("allows browser and Windows route loads without redirecting", async () => {
    const beforeLoad = Route.options.beforeLoad;
    if (typeof beforeLoad !== "function") throw new Error("Route beforeLoad is not registered.");

    for (const policy of [
      createEnvironmentPresentationPolicy({ surface: "browser", platform: "unknown" }),
      createEnvironmentPresentationPolicy({ surface: "desktop", platform: "windows" }),
    ]) {
      h.policy = policy;
      await expect(Promise.resolve().then(() => beforeLoad({} as never))).resolves.toBeUndefined();
    }
  });
});
