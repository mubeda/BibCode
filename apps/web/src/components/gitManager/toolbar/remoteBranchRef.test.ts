import type { GitManagerRefEntry } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { remoteDeleteBlockedReason, splitRemoteBranchRef } from "./remoteBranchRef";

function remoteRef(name: string, isDefault = false): GitManagerRefEntry {
  return {
    name,
    tipSha: "a".repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    current: false,
    isDefault,
    worktreePath: null,
    blocked: [],
  };
}

describe("splitRemoteBranchRef", () => {
  it("splits on the remote that prefixes the name, keeping slashes in the branch", () => {
    expect(splitRemoteBranchRef("origin/feature/a", ["origin"])).toEqual({
      remote: "origin",
      branch: "feature/a",
    });
  });

  it("gives null when no remote prefixes the name", () => {
    expect(splitRemoteBranchRef("upstream/main", ["origin"])).toBeNull();
    expect(splitRemoteBranchRef("origin", ["origin"])).toBeNull();
  });

  it("is ambiguous when two remotes prefix the name", () => {
    expect(splitRemoteBranchRef("team/fork/x", ["team", "team/fork"])).toBe("ambiguous");
  });

  it("does not take a remote whose name is only a text prefix", () => {
    expect(splitRemoteBranchRef("origin-fork/x", ["origin", "origin-fork"])).toEqual({
      remote: "origin-fork",
      branch: "x",
    });
  });
});

describe("remoteDeleteBlockedReason", () => {
  it("blocks the remote's default branch", () => {
    const ref = remoteRef("origin/trunk", true);
    expect(remoteDeleteBlockedReason(ref, splitRemoteBranchRef(ref.name, ["origin"]))).toBe(
      "Delete is blocked: this is the remote's default branch.",
    );
  });

  it("blocks a name two remotes match", () => {
    expect(remoteDeleteBlockedReason(remoteRef("team/fork/x"), "ambiguous")).toBe(
      "Delete is blocked: two remotes match this name. Delete it from a terminal.",
    );
  });

  it("blocks a name no remote matches", () => {
    expect(remoteDeleteBlockedReason(remoteRef("gone/x"), null)).toBe(
      "Delete is blocked: the remote of this branch is unknown.",
    );
  });

  it("allows other branches, including the local default's namesake on a remote", () => {
    const ref = remoteRef("upstream/main");
    expect(
      remoteDeleteBlockedReason(ref, splitRemoteBranchRef(ref.name, ["origin", "upstream"])),
    ).toBeNull();
  });
});
