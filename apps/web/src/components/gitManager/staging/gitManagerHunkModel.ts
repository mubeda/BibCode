import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from "@pierre/diffs";

import {
  type GitManagerLineSelection,
  type GitManagerLineSelectionType,
  isLineSelected,
  withRangeSelection,
  withSelectAll,
  withSelectNone,
} from "./gitManagerLineSelection";

export interface GitManagerSelectableDiffLine {
  readonly index: number;
  readonly lineNumber: number;
  readonly side: SelectionSide;
}

export interface GitManagerContiguousRun {
  readonly start: number;
  readonly end: number;
  readonly indices: ReadonlyArray<number>;
  readonly lines: ReadonlyArray<GitManagerSelectableDiffLine>;
}

export function groupContiguousRuns(
  fileDiff: FileDiffMetadata,
): ReadonlyArray<GitManagerContiguousRun> {
  const runs: GitManagerContiguousRun[] = [];
  let compactBodyOffset = 0;

  for (const hunk of fileDiff.hunks) {
    let unifiedIndex = fileDiff.isPartial ? compactBodyOffset : hunk.unifiedLineStart;
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        unifiedIndex += content.lines;
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      const lines: GitManagerSelectableDiffLine[] = [];
      for (let offset = 0; offset < content.deletions; offset += 1) {
        lines.push({
          index: unifiedIndex + offset,
          lineNumber: deletionLineNumber + offset,
          side: "deletions",
        });
      }
      unifiedIndex += content.deletions;
      deletionLineNumber += content.deletions;
      for (let offset = 0; offset < content.additions; offset += 1) {
        lines.push({
          index: unifiedIndex + offset,
          lineNumber: additionLineNumber + offset,
          side: "additions",
        });
      }
      unifiedIndex += content.additions;
      additionLineNumber += content.additions;

      const first = lines[0];
      const last = lines.at(-1);
      if (first !== undefined && last !== undefined) {
        runs.push({
          start: first.index,
          end: last.index,
          indices: lines.map((line) => line.index),
          lines,
        });
      }
    }
    compactBodyOffset += hunk.unifiedLineCount;
  }

  return runs;
}

export function resolveHunkHandleState(
  selection: GitManagerLineSelection,
  run: GitManagerContiguousRun,
): GitManagerLineSelectionType {
  let selectedCount = 0;
  for (const index of run.indices) {
    if (isLineSelected(selection, index)) selectedCount += 1;
  }
  if (selectedCount === 0) return "none";
  return selectedCount === run.indices.length ? "all" : "partial";
}

export function resolveSelectedRangeIndices(
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
): readonly [number, number] | null {
  const lines = groupContiguousRuns(fileDiff).flatMap((run) => run.lines);
  const start = lines.find((line) => line.side === range.side && line.lineNumber === range.start);
  const endSide = range.endSide ?? range.side;
  const end = lines.find((line) => line.side === endSide && line.lineNumber === range.end);
  return start === undefined || end === undefined ? null : [start.index, end.index];
}

export function withToggleHunkSelection(
  selection: GitManagerLineSelection,
  run: GitManagerContiguousRun,
): GitManagerLineSelection {
  const selected = resolveHunkHandleState(selection, run) !== "all";
  return withRangeSelection(selection, run.start, run.end, selected);
}

export function withToggleFileSelection(
  selection: GitManagerLineSelection,
): GitManagerLineSelection {
  return selection.type === "none" ? withSelectAll(selection) : withSelectNone(selection);
}
