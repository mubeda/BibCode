import type { Position, TextEdit } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { diskReloadEdits } from "./fileDiskReload";

/** Pierre's line model: `\r\n`, `\r` and `\n` each end a line. */
function offsetAt(contents: string, position: Position): number {
  let line = 0;
  let offset = 0;
  while (line < position.line) {
    const lineFeed = contents.slice(offset).search(/\r\n|\r|\n/);
    if (lineFeed < 0) throw new Error(`line ${position.line} is past the end`);
    offset += lineFeed + (contents.startsWith("\r\n", offset + lineFeed) ? 2 : 1);
    line += 1;
  }
  const lineEnd = contents.slice(offset).search(/\r\n|\r|\n|$/);
  if (position.character > lineEnd) throw new Error("character is past the line end");
  return offset + position.character;
}

/** Applies edits the way Pierre does: all against the original text, sorted, disjoint. */
function applyEdits(contents: string, edits: readonly TextEdit[]): string {
  const resolved = edits
    .map((edit) => ({
      start: offsetAt(contents, edit.range.start),
      end: offsetAt(contents, edit.range.end),
      text: edit.newText,
    }))
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < resolved.length; index += 1) {
    expect(resolved[index - 1]!.end).toBeLessThanOrEqual(resolved[index]!.start);
  }
  let result = "";
  let cursor = 0;
  for (const edit of resolved) {
    result += contents.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + contents.slice(cursor);
}

/**
 * Where a caret at `position` ends up once Pierre applies `edits`: an offset inside a replaced
 * range moves to the end of its replacement, one at or after an edit's end shifts with it
 * (`remapOffsetThroughEdits`, `@pierre/diffs` `dist/editor/selection.js`).
 */
function caretAfter(contents: string, edits: readonly TextEdit[], position: Position): Position {
  const resolved = edits
    .map((edit) => ({
      start: offsetAt(contents, edit.range.start),
      end: offsetAt(contents, edit.range.end),
      text: edit.newText,
    }))
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  const offset = offsetAt(contents, position);
  let delta = 0;
  let mapped: number | null = null;
  for (const edit of resolved) {
    if (offset < edit.start) break;
    if (offset >= edit.end) {
      delta += edit.text.length - (edit.end - edit.start);
    } else {
      mapped = edit.start + delta + edit.text.length;
      break;
    }
  }
  const after = applyEdits(contents, edits);
  const target = mapped ?? offset + delta;
  const lines = after.slice(0, target).split(/\r\n|\r|\n/);
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}

describe("diskReloadEdits", () => {
  it.each([
    ["identical", "same\ntext\n", "same\ntext\n"],
    ["one changed word", "alpha\nhello world\nomega\n", "alpha\nhello there\nomega\n"],
    ["an inserted line", "a\nb\nc\n", "a\nb\nnew\nc\n"],
    ["a deleted line", "a\nb\nc\n", "a\nc\n"],
    ["an appended line without a final newline", "a", "a\nb"],
    ["a removed final line", "a\nb", "a"],
    ["a removed final newline", "a\n", "a"],
    ["an added final newline", "a", "a\n"],
    ["emptied", "abc", ""],
    ["filled", "", "line one\nline two\n"],
    ["CRLF line endings kept", "one\r\ntwo\r\n", "one\r\n2\r\n"],
    ["CRLF to LF", "one\r\ntwo\r\n", "one\ntwo\n"],
    ["CR only", "one\rtwo", "one\rtoo"],
    ["a surrogate pair edited", "x😀y\n", "x😃y\n"],
    ["mixed hunks", "1\n2\n3\n4\n5\n6\n7\n", "1\n2 changed\n3\n4\n5\nnew\n6\n"],
    [
      "a line inserted between two changed lines",
      "foo = 1;\nbar = 2;\n",
      "foo = 10;\nnew line\nbar = 20;\n",
    ],
    [
      "a line removed between two changed lines",
      "foo = 10;\nold line\nbar = 20;\n",
      "foo = 1;\nbar = 2;\n",
    ],
    ["a changed last line gains a line", "a", "a2\nb"],
    ["a changed first line loses the last", "a\nb", "a2"],
  ])("rewrites to the disk text: %s", (_name, current, disk) => {
    expect(applyEdits(current, diskReloadEdits(current, disk))).toBe(disk);
  });

  it("rewrites random line soups to the disk text", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pieces = ["a", "b", "\n", "\r\n", "\r", "😀", "cd"];
    const soup = () =>
      Array.from({ length: Math.floor(random() * 12) }, () => {
        return pieces[Math.floor(random() * pieces.length)]!;
      }).join("");
    for (let round = 0; round < 500; round += 1) {
      const current = soup();
      const disk = soup();
      expect(applyEdits(current, diskReloadEdits(current, disk)), JSON.stringify(current)).toBe(
        disk,
      );
    }
  });

  it("keeps each edit inside the changed characters of a changed line", () => {
    expect(diskReloadEdits("alpha\nhello world\nomega\n", "alpha\nhello there\nomega\n")).toEqual([
      {
        range: { start: { line: 1, character: 6 }, end: { line: 1, character: 11 } },
        newText: "there",
      },
    ]);
  });

  it.each([
    [
      "a line inserted between two changed lines",
      "foo = 1;\nbar = 2;\n",
      "foo = 10;\nnew line\nbar = 20;\n",
      { line: 1, character: 1 },
      { line: 2, character: 1 },
    ],
    [
      "a line removed between two changed lines",
      "foo = 10;\nold line\nbar = 20;\n",
      "foo = 1;\nbar = 2;\n",
      { line: 2, character: 1 },
      { line: 1, character: 1 },
    ],
    [
      "lines inserted above a changed line",
      "head\nvalue = 1;\n",
      "head changed\none\ntwo\nvalue = 2;\n",
      { line: 1, character: 3 },
      { line: 3, character: 3 },
    ],
  ])(
    "keeps a caret on a changed line in place when lines are also inserted or removed: %s",
    (_name, current, disk, caret, expected) => {
      const edits = diskReloadEdits(current, disk);
      expect(applyEdits(current, edits)).toBe(disk);
      expect(caretAfter(current, edits, caret)).toEqual(expected);
    },
  );

  it("edits two changed lines separately rather than replacing the lines between them", () => {
    const edits = diskReloadEdits("a1\nkeep\nkeep\nb1\n", "a2\nkeep\nkeep\nb2\nadded\n");
    // Line 3 is rewritten in place and the added line is inserted after it, not merged into it.
    expect(edits.map((edit) => edit.range.start.line)).toEqual([0, 3, 4]);
  });
});
