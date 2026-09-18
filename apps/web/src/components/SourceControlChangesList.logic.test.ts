import { describe, expect, it } from "vite-plus/test";

import {
  folderActionTarget,
  folderCheckboxState,
  groupFilesByDirectory,
  ROOT_FOLDER_LABEL,
} from "./SourceControlChangesList.logic";
import type { WorkingTreeFile } from "./SourceControlPanel.logic";

function file(path: string): WorkingTreeFile {
  return { path, insertions: 1, deletions: 0 };
}

describe("groupFilesByDirectory", () => {
  it("returns no groups for no files", () => {
    expect(groupFilesByDirectory([])).toEqual([]);
  });

  it("puts root files in a leading group labeled /", () => {
    const groups = groupFilesByDirectory([file("src/app.ts"), file("README.md")]);
    expect(groups.map((group) => group.label)).toEqual([ROOT_FOLDER_LABEL, "src"]);
    expect(groups[0]?.directory).toBeNull();
    expect(groups[0]?.files.map((entry) => entry.path)).toEqual(["README.md"]);
    expect(groups[1]?.directory).toBe("src");
  });

  it("sorts directories in path order so a parent precedes its deeper siblings", () => {
    const groups = groupFilesByDirectory([
      file("src/b/c/deep.ts"),
      file("src/a/one.ts"),
      file("docs/guide.md"),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["docs", "src/a", "src/b/c"]);
  });

  it("sorts numbered directories numerically", () => {
    const groups = groupFilesByDirectory([
      file("run/10/log.txt"),
      file("run/2/log.txt"),
      file("run/1/log.txt"),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["run/1", "run/2", "run/10"]);
  });

  it("keeps every file of a directory in one group, in server order", () => {
    const groups = groupFilesByDirectory([file("src/z.ts"), file("docs/a.md"), file("src/a.ts")]);
    expect(groups.map((group) => group.files.map((entry) => entry.path))).toEqual([
      ["docs/a.md"],
      ["src/z.ts", "src/a.ts"],
    ]);
  });
});

describe("folderCheckboxState", () => {
  const files = [file("src/a.ts"), file("src/b.ts")];

  it("reports none when no file is checked", () => {
    expect(folderCheckboxState(files, () => false)).toBe("none");
  });

  it("reports all when every file is checked", () => {
    expect(folderCheckboxState(files, () => true)).toBe("all");
  });

  it("reports mixed when only some files are checked", () => {
    expect(folderCheckboxState(files, (entry) => entry.path === "src/a.ts")).toBe("mixed");
  });
});

describe("folderActionTarget", () => {
  it("names the directory", () => {
    expect(folderActionTarget({ directory: "src/app", label: "src/app", files: [] })).toBe(
      "src/app",
    );
  });

  it("names the repository root for rootless files", () => {
    expect(folderActionTarget({ directory: null, label: ROOT_FOLDER_LABEL, files: [] })).toBe(
      "the repository root",
    );
  });
});
