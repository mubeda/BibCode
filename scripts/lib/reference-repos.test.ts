import { describe, expect, it } from "vite-plus/test";

import { referenceRepos } from "./reference-repos.ts";

describe("referenceRepos", () => {
  it("describes each vendored reference repository and its version source", () => {
    expect(referenceRepos).toEqual([
      {
        id: "effect-smol",
        prefix: ".repos/effect-smol",
        repository: "https://github.com/Effect-TS/effect.git",
        latestRef: "main",
        versionSourcePath: "pnpm-workspace.yaml",
        packageVersionPath: ["catalog", "effect"],
        versionTagPrefix: "effect@",
      },
    ]);
  });
});
