import { describe, expect, it } from "vite-plus/test";

import { resolveFetchRemote } from "./resolveFetchRemote";

describe("resolveFetchRemote", () => {
  it("picks the longest remote prefix of a remote-tracking source", () => {
    expect(resolveFetchRemote("refs/remotes/team/origin/feature", ["team", "team/origin"])).toEqual(
      ["team/origin"],
    );
  });

  it("fetches every remote for a local or missing source", () => {
    expect(resolveFetchRemote("refs/heads/feature", ["origin", "upstream"])).toEqual([
      "origin",
      "upstream",
    ]);
    expect(resolveFetchRemote(null, ["origin"])).toEqual(["origin"]);
  });
});
