import { describe, expect, it } from "vite-plus/test";

import { createCommitLookup, shouldLoadNextPage, spliceCommitGeneration } from "./commitPaging";

describe("spliceCommitGeneration", () => {
  it("prepends new commits above the pinned pages and keeps loaded rows and their order", () => {
    const loaded = [{ sha: "b" }, { sha: "a" }];
    const result = spliceCommitGeneration({
      loaded,
      incoming: [{ sha: "c" }, { sha: "b" }],
      pinnedTips: ["b"],
    });

    expect(result.commits.map((commit) => commit.sha)).toEqual(["c", "b", "a"]);
    expect(result.requiresReset).toBe(false);
  });
});

describe("shouldLoadNextPage", () => {
  it("loads at exactly ten rows from the end", () => {
    expect(
      shouldLoadNextPage({
        renderedIndex: 90,
        totalRows: 100,
        isLoading: false,
        lastRequestAtMs: 0,
        nowMs: 500,
      }),
    ).toBe(true);
  });

  it("uses a 500 ms re-entrancy guard", () => {
    const input = {
      renderedIndex: 90,
      totalRows: 100,
      isLoading: false,
      lastRequestAtMs: 1_000,
    };

    expect(shouldLoadNextPage({ ...input, nowMs: 1_499 })).toBe(false);
    expect(shouldLoadNextPage({ ...input, nowMs: 1_500 })).toBe(true);
    expect(shouldLoadNextPage({ ...input, nowMs: 1_500, isLoading: true })).toBe(false);
    expect(shouldLoadNextPage({ ...input, nowMs: 1_500, renderedIndex: 89 })).toBe(false);
  });
});

describe("createCommitLookup", () => {
  it("evicts the least-recently-read commit when the entry bound is exceeded", () => {
    const lookup = createCommitLookup<{ sha: string; subject: string }>(2, 1_000);
    lookup.set({ sha: "a", subject: "first" });
    lookup.set({ sha: "b", subject: "second" });
    expect(lookup.get("a")?.subject).toBe("first");

    lookup.set({ sha: "c", subject: "third" });

    expect(lookup.get("a")?.subject).toBe("first");
    expect(lookup.get("b")).toBeNull();
    expect(lookup.get("c")?.subject).toBe("third");
  });
});
