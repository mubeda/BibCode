import type { Position, TextEdit } from "@pierre/diffs";

/** A line with its terminator; only a document's last line has none. */
interface LineUnit {
  readonly text: string;
  readonly eol: string;
}

interface LineHunk {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
}

/** Beyond this many changed lines the middle is replaced as one block instead of diffed. */
const MAX_LINE_DIFF_DISTANCE = 1_000;

/** Pierre's line model: `\r\n`, `\r` and `\n` each end a line. */
function splitLineUnits(contents: string): LineUnit[] {
  const units: LineUnit[] = [];
  let start = 0;
  for (let index = 0; index < contents.length; index += 1) {
    const code = contents.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    const eolEnd = code === 13 && contents.charCodeAt(index + 1) === 10 ? index + 2 : index + 1;
    units.push({ text: contents.slice(start, index), eol: contents.slice(index, eolEnd) });
    start = eolEnd;
    index = eolEnd - 1;
  }
  units.push({ text: contents.slice(start), eol: "" });
  return units;
}

/**
 * Myers' shortest edit script over the lines between the common prefix and suffix, as hunks of
 * replaced lines. Falls back to one hunk when the lines differ too much to diff cheaply.
 */
function diffLineHunks(before: readonly string[], after: readonly string[]): LineHunk[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  const n = oldEnd - prefix;
  const m = newEnd - prefix;
  if (n === 0 && m === 0) return [];
  const whole: LineHunk[] = [{ oldStart: prefix, oldEnd, newStart: prefix, newEnd }];
  if (n === 0 || m === 0) return whole;

  const maxDistance = Math.min(n + m, MAX_LINE_DIFF_DISTANCE);
  const offset = maxDistance + 1;
  const furthest = new Int32Array(2 * maxDistance + 3);
  const trace: Int32Array[] = [];
  let distance = -1;
  search: for (let d = 0; d <= maxDistance; d += 1) {
    trace.push(furthest.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && furthest[offset + k - 1]! < furthest[offset + k + 1]!)
          ? furthest[offset + k + 1]!
          : furthest[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && before[prefix + x] === after[prefix + y]) {
        x += 1;
        y += 1;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) {
        distance = d;
        break search;
      }
    }
  }
  if (distance < 0) return whole;

  // Walk the trace back into matched line pairs, then read the gaps between them as hunks.
  const matches: Array<readonly [number, number]> = [];
  let x = n;
  let y = m;
  for (let d = distance; d > 0; d -= 1) {
    const previous = trace[d]!;
    const k = x - y;
    const previousK =
      k === -d || (k !== d && previous[offset + k - 1]! < previous[offset + k + 1]!)
        ? k + 1
        : k - 1;
    const previousX = previous[offset + previousK]!;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    matches.push([x, y]);
  }
  matches.reverse();

  const hunks: LineHunk[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const [oldMatch, newMatch] of [...matches, [n, m] as const]) {
    if (oldMatch > oldCursor || newMatch > newCursor) {
      hunks.push({
        oldStart: prefix + oldCursor,
        oldEnd: prefix + oldMatch,
        newStart: prefix + newCursor,
        newEnd: prefix + newMatch,
      });
    }
    oldCursor = oldMatch + 1;
    newCursor = newMatch + 1;
  }
  return hunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The common prefix and suffix of two strings, shortened so neither boundary falls inside
 * `before`'s `\r\n` or surrogate pair: Pierre cannot address those positions.
 */
function commonEnds(before: string, after: string): { prefix: number; suffix: number } {
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  while (
    prefix > 0 &&
    ((before.charCodeAt(prefix - 1) === 13 && before.charCodeAt(prefix) === 10) ||
      (isHighSurrogate(before.charCodeAt(prefix - 1)) && isLowSurrogate(before.charCodeAt(prefix))))
  ) {
    prefix -= 1;
  }
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  while (suffix > 0) {
    const end = before.length - suffix;
    const splitsLineBreak = before.charCodeAt(end - 1) === 13 && before.charCodeAt(end) === 10;
    const splitsPair =
      isHighSurrogate(before.charCodeAt(end - 1)) && isLowSurrogate(before.charCodeAt(end));
    if (!splitsLineBreak && !splitsPair) break;
    suffix -= 1;
  }
  return { prefix, suffix };
}

/** The position of `offset` within the lines of `units` that start at `firstLine`. */
function positionInLines(units: readonly LineUnit[], firstLine: number, offset: number): Position {
  let line = firstLine;
  let remaining = offset;
  for (;;) {
    const unit = units[line]!;
    if (remaining <= unit.text.length || unit.eol === "") {
      return { line, character: Math.min(remaining, unit.text.length) };
    }
    remaining -= unit.text.length + unit.eol.length;
    line += 1;
  }
}

/**
 * Replaces `before[oldStart, oldEnd)` with `after`'s lines, trimmed to the characters that differ.
 * Text around the edit, and any caret in it, stays where it is.
 */
function blockEdit(
  units: readonly LineUnit[],
  oldStart: number,
  oldEnd: number,
  replacement: string,
): TextEdit | null {
  let original = "";
  for (let line = oldStart; line < oldEnd; line += 1) {
    original += units[line]!.text + units[line]!.eol;
  }
  if (original === replacement) return null;
  const { prefix, suffix } = commonEnds(original, replacement);
  return {
    range: {
      start: positionInLines(units, oldStart, prefix),
      end: positionInLines(units, oldStart, original.length - suffix),
    },
    newText: replacement.slice(prefix, replacement.length - suffix),
  };
}

/**
 * The disjoint edits that turn `current` into `disk`: a line diff, then each changed line edited
 * only where its characters differ. Pierre moves a caret inside a replaced range to that range's
 * end, so replacing whole lines would move a caret sitting on a line the disk changed.
 */
export function diskReloadEdits(current: string, disk: string): TextEdit[] {
  if (current === disk) return [];
  const before = splitLineUnits(current);
  const after = splitLineUnits(disk);
  const joined = (units: readonly LineUnit[]) => units.map((unit) => unit.text + unit.eol);
  const afterLines = joined(after);
  const edits: TextEdit[] = [];
  for (const hunk of diffLineHunks(joined(before), afterLines)) {
    const oldCount = hunk.oldEnd - hunk.oldStart;
    const newCount = hunk.newEnd - hunk.newStart;
    if (oldCount === newCount) {
      for (let index = 0; index < oldCount; index += 1) {
        const edit = blockEdit(
          before,
          hunk.oldStart + index,
          hunk.oldStart + index + 1,
          afterLines[hunk.newStart + index]!,
        );
        if (edit !== null) edits.push(edit);
      }
      continue;
    }
    const edit = blockEdit(
      before,
      hunk.oldStart,
      hunk.oldEnd,
      afterLines.slice(hunk.newStart, hunk.newEnd).join(""),
    );
    if (edit !== null) edits.push(edit);
  }
  return edits;
}
