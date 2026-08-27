import { describe, expect, it } from "vite-plus/test";

import { Route } from "./settings.remote-servers";

describe("/settings/remote-servers", () => {
  it("keeps only recognized search params", () => {
    const validate = Route.options.validateSearch;
    if (typeof validate !== "function") throw new Error("validateSearch is not registered.");
    expect(validate({ tab: "share", code: "abc", junk: "x" })).toEqual({
      tab: "share",
      code: "abc",
    });
    expect(validate({ tab: "bogus", code: "" })).toEqual({});
    expect(validate({})).toEqual({});
  });
});
