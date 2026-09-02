import { expect, it } from "vite-plus/test";

import { resolveGitManagerDefaultTab } from "./gitManagerDefaultTab";

it("opens History unless a merge is pending", () => {
  expect(resolveGitManagerDefaultTab(null)).toBe("history");
  expect(resolveGitManagerDefaultTab(undefined)).toBe("history");
  expect(resolveGitManagerDefaultTab({ kind: "rebase", current: 1, total: 3 })).toBe("history");
  expect(resolveGitManagerDefaultTab({ kind: "cherry-pick", current: null, total: null })).toBe(
    "history",
  );
});

it("opens Changes while a merge needs to be finished", () => {
  expect(resolveGitManagerDefaultTab({ kind: "merge", current: null, total: null })).toBe(
    "changes",
  );
});
