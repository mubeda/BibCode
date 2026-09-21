import { describe, expect, it } from "vite-plus/test";

import { makeTestExecutionEnvironmentCapabilities } from "./testSupport.ts";

describe("test environment Pull Requests capabilities", () => {
  it("defaults to unsupported and allows independent read and mutation overrides", () => {
    expect(makeTestExecutionEnvironmentCapabilities()).toMatchObject({
      pullRequestsReads: false,
      pullRequestsMutations: false,
    });
    expect(makeTestExecutionEnvironmentCapabilities({ pullRequestsReads: true })).toMatchObject({
      pullRequestsReads: true,
      pullRequestsMutations: false,
    });
  });
});
