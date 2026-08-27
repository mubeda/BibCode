import { describe, expect, it } from "vite-plus/test";

import { Route } from "./pair";

describe("/pair with a pairing code", () => {
  it("validates the code search param", () => {
    const validate = Route.options.validateSearch;
    if (typeof validate !== "function") throw new Error("validateSearch is not registered.");
    expect(validate({ code: "abc" })).toEqual({ code: "abc" });
    expect(validate({ code: "" })).toEqual({});
    expect(validate({})).toEqual({});
  });

  it("forwards an authenticated client to Remote Servers with the code", async () => {
    const beforeLoad = Route.options.beforeLoad;
    if (typeof beforeLoad !== "function") throw new Error("beforeLoad is not registered.");
    await expect(
      Promise.resolve().then(() =>
        beforeLoad({
          context: { authGateState: { status: "authenticated" } },
          search: { code: "abc" },
        } as never),
      ),
    ).rejects.toMatchObject({
      options: { to: "/settings/remote-servers", search: { code: "abc" }, replace: true },
    });
  });

  it("still sends an authenticated client without a code to the root", async () => {
    const beforeLoad = Route.options.beforeLoad;
    if (typeof beforeLoad !== "function") throw new Error("beforeLoad is not registered.");
    await expect(
      Promise.resolve().then(() =>
        beforeLoad({
          context: { authGateState: { status: "authenticated" } },
          search: {},
        } as never),
      ),
    ).rejects.toMatchObject({ options: { to: "/", replace: true } });
  });

  it("never gates a fresh unauthenticated device carrying a code", async () => {
    const beforeLoad = Route.options.beforeLoad;
    if (typeof beforeLoad !== "function") throw new Error("beforeLoad is not registered.");
    await expect(
      Promise.resolve().then(() =>
        beforeLoad({
          context: { authGateState: { status: "pairing", auth: {} } },
          search: { code: "abc" },
        } as never),
      ),
    ).resolves.toMatchObject({ authGateState: { status: "pairing" } });
  });
});
