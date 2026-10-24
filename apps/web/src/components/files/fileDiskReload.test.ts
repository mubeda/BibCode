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

  it("edits two changed lines separately rather than replacing the lines between them", () => {
    const edits = diskReloadEdits("a1\nkeep\nkeep\nb1\n", "a2\nkeep\nkeep\nb2\nadded\n");
    expect(edits.map((edit) => edit.range.start.line)).toEqual([0, 3]);
  });
});
