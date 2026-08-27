import { describe, expect, it } from "vite-plus/test";

import { Route } from "./settings.connections";

describe("/settings/connections", () => {
  it("always redirects to /settings/remote-servers (D7)", async () => {
    const beforeLoad = Route.options.beforeLoad;
    if (typeof beforeLoad !== "function") throw new Error("beforeLoad is not registered.");
    await expect(Promise.resolve().then(() => beforeLoad({} as never))).rejects.toMatchObject({
      options: { to: "/settings/remote-servers", replace: true },
    });
  });
});
