import { expect, it } from "vite-plus/test";

import { resolveBranchCreateBase } from "./branchCreateBase";

it("creates from the checked-out branch, never from the repository default", () => {
  expect(resolveBranchCreateBase({ currentBranchName: "alpha", defaultBranch: "master" })).toBe(
    "alpha",
  );
  expect(resolveBranchCreateBase({ currentBranchName: "master", defaultBranch: "master" })).toBe(
    "master",
  );
});

it("falls back to the current HEAD (no start point) when HEAD is detached", () => {
  expect(resolveBranchCreateBase({ currentBranchName: null, defaultBranch: "master" })).toBeNull();
  expect(resolveBranchCreateBase({ currentBranchName: null, defaultBranch: null })).toBeNull();
});
