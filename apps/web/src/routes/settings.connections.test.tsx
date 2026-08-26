import { describe, expect, it } from "vite-plus/test";

import { Route } from "./settings.connections";

describe("legacy connections route", () => {
  it("always redirects to Environments", async () => {
    const beforeLoad = Route.options.beforeLoad;
    if (typeof beforeLoad !== "function") throw new Error("Route beforeLoad is not registered.");

    await expect(Promise.resolve().then(() => beforeLoad({} as never))).rejects.toMatchObject({
      status: 307,
      options: { to: "/settings/environments", replace: true },
    });
  });
});
