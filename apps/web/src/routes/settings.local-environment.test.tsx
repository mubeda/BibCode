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

import { Route } from "./settings.local-environment";

describe("/settings/local-environment", () => {
  it("redirects to Remote Servers unless the WSL local page applies", async () => {
    const beforeLoad = Route.options.beforeLoad;
    if (typeof beforeLoad !== "function") throw new Error("beforeLoad is not registered.");

    h.policy = createEnvironmentPresentationPolicy({ surface: "desktop", platform: "windows" });
    await expect(Promise.resolve().then(() => beforeLoad({} as never))).resolves.toBeUndefined();

    for (const input of [
      { surface: "desktop", platform: "macos" },
      { surface: "desktop", platform: "linux" },
      { surface: "browser", platform: "unknown" },
    ] as const) {
      h.policy = createEnvironmentPresentationPolicy(input);
      await expect(Promise.resolve().then(() => beforeLoad({} as never))).rejects.toMatchObject({
        options: { to: "/settings/remote-servers", replace: true },
      });
    }
  });
});
