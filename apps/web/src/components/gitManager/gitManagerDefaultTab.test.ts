import { expect, it } from "vite-plus/test";

import { resolveGitManagerDefaultTab } from "./gitManagerDefaultTab";

it("selects History when the checkout is known to be clean", () => {
  expect(resolveGitManagerDefaultTab(null, false)).toBe("history");
  expect(resolveGitManagerDefaultTab(undefined, false)).toBe("history");
  expect(resolveGitManagerDefaultTab({ kind: "rebase", current: 1, total: 3 }, false)).toBe(
    "history",
  );
  expect(
    resolveGitManagerDefaultTab({ kind: "cherry-pick", current: null, total: null }, false),
  ).toBe("history");
});

it("preserves the selected tab while changes exist or status is still loading", () => {
  expect(resolveGitManagerDefaultTab(null, true)).toBeNull();
  expect(resolveGitManagerDefaultTab(null, undefined)).toBeNull();
});

it("selects Changes while a merge needs to be finished", () => {
  expect(resolveGitManagerDefaultTab({ kind: "merge", current: null, total: null }, true)).toBe(
    "changes",
  );
  expect(resolveGitManagerDefaultTab({ kind: "merge", current: null, total: null }, false)).toBe(
    "changes",
  );
});
