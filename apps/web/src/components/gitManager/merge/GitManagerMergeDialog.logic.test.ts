import type { GitManagerMergePreview } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMergeConfirmCopy, summarizeMergePreview } from "./GitManagerMergeDialog.logic";

function preview(
  value: Partial<GitManagerMergePreview> & Pick<GitManagerMergePreview, "_tag">,
): GitManagerMergePreview {
  return {
    source: "feature",
    current: "main",
    ahead: 7,
    behind: 3,
    ...value,
  } as GitManagerMergePreview;
}

describe("summarizeMergePreview", () => {
  it("uses the server's clean ahead and behind counts without recomputing them", () => {
    expect(summarizeMergePreview(preview({ _tag: "clean" }))).toEqual({
      kind: "clean",
      message: "This will merge 7 commits from `feature` into `main`.",
      mergeEnabled: true,
      ahead: 7,
      behind: 3,
    });
  });

  it("presents the server's conflicted file count", () => {
    expect(summarizeMergePreview(preview({ _tag: "conflicted", fileCount: 4 }))).toEqual({
      kind: "conflicted",
      message: "There will be 4 conflicted files.",
      mergeEnabled: true,
      ahead: 7,
      behind: 3,
    });
  });

  it("disables a server-classified unrelated-histories merge", () => {
    expect(summarizeMergePreview(preview({ _tag: "unrelated-histories" }))).toEqual({
      kind: "unrelated-histories",
      message: "These branches have unrelated histories and cannot be merged.",
      mergeEnabled: false,
      ahead: 7,
      behind: 3,
    });
  });
});

describe("resolveMergeConfirmCopy", () => {
  it("distinguishes merge commits from squash merges", () => {
    expect(resolveMergeConfirmCopy("merge")).toEqual({
      title: "Merge into current branch",
      confirmLabel: "Merge",
    });
    expect(resolveMergeConfirmCopy("squash")).toEqual({
      title: "Squash and merge into current branch",
      confirmLabel: "Squash and Merge",
    });
  });
});
