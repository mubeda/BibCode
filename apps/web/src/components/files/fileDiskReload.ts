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

/** An edit in offsets of the text being replaced. */
interface OffsetEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Where each line of `units` starts; the extra last entry is the text's length. */
function lineStartOffsets(units: readonly LineUnit[]): number[] {
  const starts = [0];
  for (const unit of units)
    starts.push(starts[starts.length - 1]! + unit.text.length + unit.eol.length);
  return starts;
}

/** The position of `offset`; edits never start or end inside a line break. */
function positionAt(
  units: readonly LineUnit[],
  starts: readonly number[],
  offset: number,
): Position {
  let low = 0;
  let high = units.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, character: Math.min(offset - starts[low]!, units[low]!.text.length) };
}

/** Rewrites one line, trimmed to the characters that differ, so a caret elsewhere on it stays. */
function lineEdit(original: string, start: number, replacement: string): OffsetEdit | null {
  if (original === replacement) return null;
  const { prefix, suffix } = commonEnds(original, replacement);
  return {
    start: start + prefix,
    end: start + original.length - suffix,
    text: replacement.slice(prefix, replacement.length - suffix),
  };
}

/** How many characters a line edit removes and inserts. */
function lineEditCost(original: string, replacement: string): number {
  if (original === replacement) return 0;
  const { prefix, suffix } = commonEnds(original, replacement);
  return original.length + replacement.length - 2 * (prefix + suffix);
}

/** `starts[i]` is the total length of `lines[0, i)`, so any run's length costs one subtraction. */
function lengthPrefixes(lines: readonly string[]): number[] {
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1]! + line.length);
  return starts;
}

/**
 * The edits for one hunk. When it has more lines on one side, the extra lines are inserted or
 * removed as one block, and the other lines pair up from the hunk's start and end: the split
 * between the two is the one that changes the fewest characters. So a line the disk changed
 * keeps a caret in place even when lines were inserted or removed next to it.
 */
function hunkEdits(
  oldLines: readonly string[],
  newLines: readonly string[],
  start: number,
): OffsetEdit[] {
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const paired = Math.min(oldCount, newCount);
  const front = Array.from({ length: paired }, (_, index) =>
    lineEditCost(oldLines[index]!, newLines[index]!),
  );
  const back = Array.from({ length: paired }, (_, index) =>
    lineEditCost(oldLines[oldCount - 1 - index]!, newLines[newCount - 1 - index]!),
  );
  const extra = Math.abs(oldCount - newCount);
  // The block fallback for a hunk too costly to diff can be most of the file: keep this linear.
  const extraStarts = lengthPrefixes(oldCount > newCount ? oldLines : newLines);
  const extraLength = (split: number) => extraStarts[split + extra]! - extraStarts[split]!;
  let frontCost = 0;
  let backCost = back.reduce((total, cost) => total + cost, 0);
  let best = { split: 0, cost: backCost + extraLength(0) };
  for (let split = 1; split <= paired; split += 1) {
    frontCost += front[split - 1]!;
    backCost -= back[paired - split]!;
    const cost = frontCost + backCost + extraLength(split);
    if (cost < best.cost) best = { split, cost };
  }

  const edits: OffsetEdit[] = [];
  let offset = start;
  const pair = (oldIndex: number, newIndex: number) => {
    const edit = lineEdit(oldLines[oldIndex]!, offset, newLines[newIndex]!);
    if (edit !== null) edits.push(edit);
    offset += oldLines[oldIndex]!.length;
  };
  for (let index = 0; index < best.split; index += 1) pair(index, index);
  if (oldCount > newCount) {
    const removed = extraLength(best.split);
    if (removed > 0) edits.push({ start: offset, end: offset + removed, text: "" });
    offset += removed;
  } else if (extra > 0) {
    edits.push({
      start: offset,
      end: offset,
      text: newLines.slice(best.split, best.split + extra).join(""),
    });
  }
  for (let index = best.split; index < paired; index += 1) {
    pair(index + (oldCount > newCount ? extra : 0), index + (newCount > oldCount ? extra : 0));
  }
  return edits;
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
  const beforeLines = joined(before);
  const afterLines = joined(after);
  const starts = lineStartOffsets(before);
  const edits: OffsetEdit[] = [];
  for (const hunk of diffLineHunks(beforeLines, afterLines)) {
    for (const edit of hunkEdits(
      beforeLines.slice(hunk.oldStart, hunk.oldEnd),
      afterLines.slice(hunk.newStart, hunk.newEnd),
      starts[hunk.oldStart]!,
    )) {
      // Touching edits become one, so two insertions never share a position Pierre must order.
      const previous = edits[edits.length - 1];
      if (previous !== undefined && previous.end === edit.start) {
        edits[edits.length - 1] = {
          start: previous.start,
          end: edit.end,
          text: previous.text + edit.text,
        };
      } else {
        edits.push(edit);
      }
    }
  }
  return edits.map((edit) => ({
    range: {
      start: positionAt(before, starts, edit.start),
      end: positionAt(before, starts, edit.end),
    },
    newText: edit.text,
  }));
}
