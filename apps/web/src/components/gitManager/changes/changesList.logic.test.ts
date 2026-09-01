import { describe, expect, it } from "vite-plus/test";

import { buildChangeRows, changeRowsHeader, nextChangeInclusion } from "./changesList.logic";

describe("buildChangeRows", () => {
  it("marks a file as conflicted when the refs snapshot lists it", () => {
    const rows = buildChangeRows({
      files: [
        {
          path: "src/a.ts",
          insertions: 1,
          deletions: 0,
          status: "modified",
          area: "unstaged",
        },
        {
          path: "src/b.ts",
          insertions: 2,
          deletions: 2,
          status: "modified",
          area: "unstaged",
        },
      ],
      conflictedPaths: ["src/b.ts"],
      submodulePaths: [],
      filterText: "",
      excludedPaths: new Set(),
    });

    expect(rows.map((row) => row.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(rows[1]!.conflicted).toBe(true);
    expect(rows[1]!.inclusion).toBe("none");
    expect(rows[0]!.conflicted).toBe(false);
  });

  it("AND-combines text and boolean filters and reports included rows hidden by them", () => {
    const rows = buildChangeRows({
      files: [
        {
          path: "src/new-file.ts",
          insertions: 3,
          deletions: 0,
          status: "untracked",
          area: "untracked",
        },
        {
          path: "src/modified-file.ts",
          insertions: 1,
          deletions: 1,
          status: "modified",
          area: "unstaged",
        },
        {
          path: "docs/new-file.md",
          insertions: 2,
          deletions: 0,
          status: "added",
          area: "staged",
        },
      ],
      conflictedPaths: [],
      submodulePaths: [],
      filterText: "src/",
      filters: { included: true, excluded: false, new: true, modified: false, deleted: false },
      excludedPaths: new Set(["src/modified-file.ts"]),
    });

    expect(rows.map((row) => row.path)).toEqual(["src/new-file.ts"]);
    expect(rows.filterActive).toBe(true);
    expect(rows.hiddenIncludedCount).toBe(1);
    expect(rows.totalCount).toBe(3);
  });

  it("toggles fully included and partial rows to excluded", () => {
    expect(nextChangeInclusion("all")).toBe("none");
    expect(nextChangeInclusion("partial")).toBe("none");
    expect(nextChangeInclusion("none")).toBe("all");
  });

  it("preserves server-authored submodule reasons and forces partial state", () => {
    const rows = buildChangeRows({
      files: [
        {
          path: "vendor/dirty",
          insertions: 0,
          deletions: 0,
          status: "modified",
          area: "unstaged",
        },
        {
          path: "vendor/partial",
          insertions: 1,
          deletions: 0,
          status: "modified",
          area: "staged",
        },
      ],
      conflictedPaths: [],
      submodulePaths: [
        {
          path: "vendor/dirty",
          inclusion: "none",
          disabledReason: "Server says the nested checkout is dirty.",
        },
        {
          path: "vendor/partial",
          inclusion: "partial",
          disabledReason: "Server says only the recorded commit is included.",
        },
      ],
      filterText: "",
      excludedPaths: new Set(),
    });

    expect(rows[0]).toMatchObject({
      submodule: true,
      inclusion: "none",
      disabledReason: "Server says the nested checkout is dirty.",
    });
    expect(rows[1]).toMatchObject({
      submodule: true,
      inclusion: "partial",
      disabledReason: "Server says only the recorded commit is included.",
    });
  });

  it("collapses staged and unstaged records into one path-keyed row", () => {
    const rows = buildChangeRows({
      files: [
        {
          path: "src/partial.ts",
          insertions: 2,
          deletions: 1,
          status: "modified",
          area: "staged",
        },
        {
          path: "src/partial.ts",
          insertions: 3,
          deletions: 4,
          status: "modified",
          area: "unstaged",
        },
      ],
      conflictedPaths: [],
      submodulePaths: [],
      filterText: "",
      excludedPaths: new Set(),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: "src/partial.ts",
      insertions: 5,
      deletions: 5,
      area: undefined,
      inclusion: "all",
    });
  });

  it("summarizes only visible inclusion when a filter is active", () => {
    const rows = buildChangeRows({
      files: [
        { path: "src/a.ts", insertions: 1, deletions: 0, status: "modified" },
        { path: "src/b.ts", insertions: 1, deletions: 0, status: "modified" },
        { path: "docs/c.md", insertions: 1, deletions: 0, status: "modified" },
      ],
      conflictedPaths: [],
      submodulePaths: [],
      filterText: "src/",
      excludedPaths: new Set(["src/b.ts"]),
    });

    expect(changeRowsHeader(rows)).toEqual({
      inclusion: "partial",
      label: "2 of 3 changed files",
    });
  });
});
