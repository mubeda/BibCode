import type { GitManagerRefEntry, GitManagerRefsSnapshot } from "@bibcode/contracts";
import { expect, it } from "vite-plus/test";

import { newBranchDialog } from "./branchCreateBase";

function branch(name: string, current: boolean): GitManagerRefEntry {
  return {
    name,
    tipSha: "a".repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    current,
    isDefault: false,
    worktreePath: null,
    blocked: [],
  };
}

function snapshot(overrides: Partial<GitManagerRefsSnapshot>): GitManagerRefsSnapshot {
  return {
    generation: 1,
    headRef: "alpha",
    detachedSha: null,
    isDirty: false,
    defaultBranch: "master",
    remotes: [],
    localBranches: [branch("alpha", true), branch("master", false)],
    remoteBranches: [],
    tags: [],
    worktrees: [],
    inProgressOperation: null,
    conflictedPaths: [],
    ...overrides,
  };
}

it("creates from the checked-out branch, never from the repository default", () => {
  expect(newBranchDialog(snapshot({}))).toEqual({
    kind: "create",
    baseBranch: "alpha",
    baseCommit: null,
    unborn: false,
  });
});

it("starts from the current HEAD (no start point) when HEAD is detached", () => {
  const detached = snapshot({
    headRef: null,
    detachedSha: "b".repeat(40),
    localBranches: [branch("alpha", false)],
  });
  expect(newBranchDialog(detached)).toEqual({
    kind: "create",
    baseBranch: null,
    baseCommit: null,
    unborn: false,
  });
});

it("starts from no start point on an unborn branch, whose name is not a ref yet", () => {
  // `refs/heads/main` does not exist before the first commit, so naming it would fail.
  const unborn = snapshot({ headRef: "main", localBranches: [] });
  expect(newBranchDialog(unborn)).toEqual({
    kind: "create",
    baseBranch: null,
    baseCommit: null,
    unborn: true,
  });
});

it("names the branch entry, not HEAD's short name, when a tag shares the branch name", () => {
  // `symbolic-ref --short` says `heads/main` when a tag `main` exists.
  const shadowed = snapshot({ headRef: "heads/main", localBranches: [branch("main", true)] });
  expect(newBranchDialog(shadowed).baseBranch).toBe("main");
});
