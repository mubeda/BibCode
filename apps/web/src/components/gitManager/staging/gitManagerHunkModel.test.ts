import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  groupContiguousRuns,
  resolveSelectedRangeIndices,
  resolveHunkHandleState,
  withToggleFileSelection,
  withToggleHunkSelection,
} from "./gitManagerHunkModel";
import { createLineSelection, withLineSelection } from "./gitManagerLineSelection";

const FILE_DIFF: FileDiffMetadata = {
  name: "file.ts",
  type: "change",
  hunks: [
    {
      collapsedBefore: 0,
      additionStart: 1,
      additionCount: 3,
      additionLines: 2,
      additionLineIndex: 0,
      deletionStart: 1,
      deletionCount: 3,
      deletionLines: 2,
      deletionLineIndex: 0,
      hunkContent: [
        { type: "change", deletions: 1, deletionLineIndex: 0, additions: 1, additionLineIndex: 0 },
        { type: "context", lines: 1, additionLineIndex: 1, deletionLineIndex: 1 },
        { type: "change", deletions: 1, deletionLineIndex: 2, additions: 1, additionLineIndex: 2 },
      ],
      splitLineStart: 0,
      splitLineCount: 3,
      unifiedLineStart: 0,
      unifiedLineCount: 5,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    },
  ],
  splitLineCount: 3,
  unifiedLineCount: 5,
  isPartial: true,
  deletionLines: ["old", "context", "third"],
  additionLines: ["new", "context", "fourth"],
};

const fileDiff = () => FILE_DIFF;

describe("gitManagerHunkModel", () => {
  it("splits consecutive changed lines at context lines", () => {
    const runs = groupContiguousRuns(fileDiff());

    expect(runs.map((run) => run.indices)).toEqual([
      [0, 1],
      [3, 4],
    ]);
    expect(runs[0]?.lines).toEqual([
      { index: 0, lineNumber: 1, side: "deletions" },
      { index: 1, lineNumber: 1, side: "additions" },
    ]);
  });

  it("reports a half-selected run as partial and toggles it to all", () => {
    const run = groupContiguousRuns(fileDiff())[0]!;
    const partial = withLineSelection(createLineSelection("none", run.indices), 0, true);
    const selected = withToggleHunkSelection(partial, run);

    expect(resolveHunkHandleState(partial, run)).toBe("partial");
    expect(resolveHunkHandleState(selected, run)).toBe("all");
  });

  it("toggles a partial file selection to excluded, distinct from a partial hunk", () => {
    const run = groupContiguousRuns(fileDiff())[0]!;
    const partial = withLineSelection(createLineSelection("none", run.indices), 0, true);

    expect(withToggleFileSelection(partial).type).toBe("none");
  });

  it("maps a rendered mixed-side range back to unified diff-body indices", () => {
    expect(
      resolveSelectedRangeIndices(fileDiff(), {
        start: 1,
        end: 3,
        side: "deletions",
        endSide: "additions",
      }),
    ).toEqual([0, 4]);
  });
});
