/*
 * detectDominantEol is adapted from Orca (https://github.com/stablyai/orca),
 * src/renderer/src/components/editor/rich-markdown/document/rich-markdown-source-reconcile.ts.
 * Copyright (c) 2026 Lovecast Inc. Licensed under the MIT License.
 * The block-level reconcile below is not from Orca.
 */
import type { Nodes, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * Keeps the file's own spelling when a rendered-view edit is saved. `original` is the file body,
 * `before` the editor's serialization when it loaded `original`, and `after` its serialization
 * now. Blocks that did not change keep `original`'s bytes; changed and inserted blocks take
 * `after`'s text. See docs/plans/2026-11-09-files-rich-markdown-toolbar-design.md.
 */

interface Block {
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  /** Null for a leaf: its text is emitted whole. */
  readonly children: readonly Block[] | null;
  /** The block's content without its spelling: equal keys are the same block. */
  readonly key: string;
}

interface Parsed {
  readonly source: string;
  readonly root: Root;
  readonly blocks: readonly Block[];
}

const CONTAINER_KINDS = new Set(["list", "listItem", "blockquote", "table"]);
export const DETAILS_OPEN =
  /^<details(?:\s+open(?:\s*=\s*(?:""|"open"|''|'open'|open))?)?\s*>\s*<summary>([^<]*)<\/summary>\s*$/i;
export const DETAILS_WHOLE =
  /^<details(?:\s+open(?:\s*=\s*(?:""|"open"|''|'open'|open))?)?\s*>\s*<summary>([^<]*)<\/summary>([\s\S]*?)<\/details>\s*$/i;
export const DETAILS_CLOSE = /^<\/details>\s*$/i;

const processor = unified().use(remarkParse).use(remarkGfm);
const parseCache = new Map<string, Parsed>();

/**
 * Parses `source`. With `keep`, the tree stays cached: `original` and `before` are the same for
 * a whole visit, so only `after` and the reconcile's own output are parsed on each edit.
 */
function parse(source: string, keep = false): Parsed {
  const cached = parseCache.get(source);
  if (cached) return cached;
  const root = processor.parse(source) as Root;
  const parsed = { source, root, blocks: toBlocks(root.children) };
  if (keep) {
    // Two visits' worth: the open file's `original` and `before`, and the previous file's.
    if (parseCache.size >= 4) parseCache.delete(parseCache.keys().next().value as string);
    parseCache.set(source, parsed);
  }
  return parsed;
}

function startOf(node: Nodes): number {
  return node.position?.start.offset ?? 0;
}

function endOf(node: Nodes): number {
  return node.position?.end.offset ?? 0;
}

function htmlValue(node: RootContent): string | null {
  return node.type === "html" ? node.value : null;
}

/** The index of the `</details>` node that closes the opener at `index`, or -1. */
function detailsClose(nodes: readonly RootContent[], index: number): number {
  let depth = 0;
  for (let cursor = index; cursor < nodes.length; cursor += 1) {
    const value = htmlValue(nodes[cursor]!);
    if (value === null) continue;
    if (DETAILS_OPEN.test(value)) depth += 1;
    else if (DETAILS_CLOSE.test(value)) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function toBlocks(nodes: readonly RootContent[]): Block[] {
  const blocks: Block[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const value = htmlValue(node);
    if (value !== null && DETAILS_OPEN.test(value)) {
      const close = detailsClose(nodes, index);
      if (close > index) {
        // An empty body is a leaf, as normalizeNodes counts it: one block, not an opener and a closer.
        blocks.push({
          kind: "details",
          start: startOf(node),
          end: endOf(nodes[close]!),
          children: close > index + 1 ? toBlocks(nodes.slice(index + 1, close)) : null,
          key: JSON.stringify(normalizeNodes(nodes.slice(index, close + 1))),
        });
        index = close;
        continue;
      }
    }
    const children =
      CONTAINER_KINDS.has(node.type) && "children" in node && node.children.length > 0
        ? toBlocks(node.children as RootContent[])
        : null;
    blocks.push({
      kind: value !== null && DETAILS_WHOLE.test(value) ? "details" : node.type,
      start: startOf(node),
      end: endOf(node),
      children,
      key: JSON.stringify(normalizeNodes([node])),
    });
  }
  return blocks;
}

function decodeSummary(text: string): string {
  return text
    .trim()
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

type Normalized = { readonly [key: string]: unknown };

/** The document a tree describes, without positions or spelling-only details. */
function normalizeNodes(nodes: readonly RootContent[]): Normalized[] {
  const out: Normalized[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const value = htmlValue(node);
    if (value !== null) {
      const whole = DETAILS_WHOLE.exec(value);
      if (whole) {
        const body = processor.parse(whole[2]!) as Root;
        out.push({
          type: "details",
          summary: decodeSummary(whole[1]!),
          children: normalizeNodes(body.children),
        });
        continue;
      }
      const open = DETAILS_OPEN.exec(value);
      const close = open ? detailsClose(nodes, index) : -1;
      if (open && close > index) {
        out.push({
          type: "details",
          summary: decodeSummary(open[1]!),
          children: normalizeNodes(nodes.slice(index + 1, close)),
        });
        index = close;
        continue;
      }
    }
    const {
      position: _position,
      data: _data,
      ...fields
    } = node as RootContent & {
      spread?: unknown;
      data?: unknown;
    };
    const { spread: _spread, ...rest } = fields as typeof fields & { spread?: unknown };
    const normalized: Record<string, unknown> = { ...rest };
    // A line break inside a paragraph means the same with either line ending.
    if (typeof normalized["value"] === "string") {
      normalized["value"] = (normalized["value"] as string).replaceAll("\r\n", "\n");
    }
    if ("children" in node) {
      normalized["children"] = normalizeNodes(node.children as RootContent[]);
    }
    const previous = out.at(-1);
    if (node.type === "text" && previous?.["type"] === "text") {
      out[out.length - 1] = { type: "text", value: `${previous["value"] as string}${node.value}` };
      continue;
    }
    out.push(normalized);
  }
  return out;
}

function sameDocument(left: string, right: string): boolean {
  return (
    JSON.stringify(normalizeNodes(parse(left).root.children)) ===
    JSON.stringify(normalizeNodes(parse(right).root.children))
  );
}

/** Same keys at every level, so each `before` block has the `original` block it stands for. */
function sameBlocks(left: readonly Block[], right: readonly Block[]): boolean {
  return (
    left.length === right.length &&
    left.every((block, index) => {
      const other = right[index]!;
      if (block.key !== other.key) return false;
      // A leaf on either side is copied or replaced whole, never recursed into.
      return block.children === null || other.children === null
        ? true
        : sameBlocks(block.children, other.children);
    })
  );
}

/**
 * True when `before` describes the same document as `original`, block for block, so edits can be
 * placed. The keys are normalized trees, so this also compares inline content.
 */
export function canReconcile(input: { original: string; before: string }): boolean {
  return sameBlocks(parse(input.original, true).blocks, parse(input.before, true).blocks);
}

/** CRLF when CRLF lines are at least as many as bare LF lines (Orca's rule). */
export function detectDominantEol(text: string): "\n" | "\r\n" {
  if (!text.includes("\r")) return "\n";
  const totalLf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return crlf > 0 && crlf >= totalLf - crlf ? "\r\n" : "\n";
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

/** The text that starts each continuation line at `offset`'s depth, with markers as spaces. */
function continuationPrefix(source: string, offset: number): string {
  return source
    .slice(lineStart(source, offset), offset)
    .replace(/\[[ xX]\]/g, "   ")
    .replace(/\d+[.)]|[-*+]/g, (marker) => " ".repeat(marker.length));
}

interface Level {
  readonly original: Parsed;
  readonly after: Parsed;
  readonly eol: string;
  /** Continuation prefixes of this level's children in `original` and in `after`. */
  readonly originalPrefix: string;
  readonly afterPrefix: string;
  /** The bullet character or ordered delimiter of the original list, for inserted items. */
  readonly listMarker: string | null;
}

/** Text from `after`, moved into `original`'s container prefix and line endings. */
function fromAfter(level: Level, text: string): string {
  const { afterPrefix, originalPrefix } = level;
  const lines = text.split("\n").map((line, index) => {
    if (index === 0) return line;
    let rest = line;
    if (rest.startsWith(afterPrefix)) rest = rest.slice(afterPrefix.length);
    else if (rest.startsWith(afterPrefix.trimEnd()))
      rest = rest.slice(afterPrefix.trimEnd().length);
    return rest === "" ? originalPrefix.trimEnd() : `${originalPrefix}${rest}`;
  });
  return lines.join(level.eol);
}

function textOf(parsed: Parsed, block: Block): string {
  return parsed.source.slice(block.start, block.end);
}

/**
 * Blocks match on content, not spelling: a renumbered list item or a table row re-padded after
 * an edit elsewhere in its table still matches.
 */
function keyOf(_parsed: Parsed, block: Block): string {
  return block.key;
}

type Step =
  | { readonly kind: "match"; readonly before: number; readonly after: number }
  | { readonly kind: "pair"; readonly before: number; readonly after: number }
  | { readonly kind: "insert"; readonly after: number };

/** Longest common subsequence of keys, as steps over `after` (unlisted `before` are deleted). */
function align(beforeKeys: readonly string[], afterKeys: readonly string[]): Step[] {
  let prefix = 0;
  while (
    prefix < beforeKeys.length &&
    prefix < afterKeys.length &&
    beforeKeys[prefix] === afterKeys[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeKeys.length - prefix &&
    suffix < afterKeys.length - prefix &&
    beforeKeys[beforeKeys.length - 1 - suffix] === afterKeys[afterKeys.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const middleBefore = beforeKeys.slice(prefix, beforeKeys.length - suffix);
  const middleAfter = afterKeys.slice(prefix, afterKeys.length - suffix);
  const rows = middleBefore.length;
  const columns = middleAfter.length;
  const table = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: columns + 1 }, () => 0),
  );
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row]![column] =
        middleBefore[row] === middleAfter[column]
          ? table[row + 1]![column + 1]! + 1
          : Math.max(table[row + 1]![column]!, table[row]![column + 1]!);
    }
  }
  const matches: [number, number][] = [];
  for (let index = 0; index < prefix; index += 1) matches.push([index, index]);
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (middleBefore[row] === middleAfter[column]) {
      matches.push([prefix + row, prefix + column]);
      row += 1;
      column += 1;
    } else if (table[row + 1]![column]! >= table[row]![column + 1]!) row += 1;
    else column += 1;
  }
  for (let index = 0; index < suffix; index += 1) {
    matches.push([beforeKeys.length - suffix + index, afterKeys.length - suffix + index]);
  }

  const steps: Step[] = [];
  let nextBefore = 0;
  let nextAfter = 0;
  const flushGap = (beforeEnd: number, afterEnd: number) => {
    // Unmatched blocks between two matches pair up in order; extra `after` blocks are inserts.
    while (nextAfter < afterEnd) {
      steps.push(
        nextBefore < beforeEnd
          ? { kind: "pair", before: nextBefore++, after: nextAfter }
          : { kind: "insert", after: nextAfter },
      );
      nextAfter += 1;
    }
    nextBefore = beforeEnd;
  };
  for (const [beforeIndex, afterIndex] of matches) {
    flushGap(beforeIndex, afterIndex);
    steps.push({ kind: "match", before: beforeIndex, after: afterIndex });
    nextBefore = beforeIndex + 1;
    nextAfter = afterIndex + 1;
  }
  flushGap(beforeKeys.length, afterKeys.length);
  return steps;
}

interface Emitted {
  readonly text: string;
  /** The `original` sibling this block stands for, which decides its separators. */
  readonly original: number | null;
  readonly after: number;
  /** True when the block was rebuilt from its children rather than copied. */
  readonly rebuilt: boolean;
}

function headOf(parsed: Parsed, block: Block): string {
  return parsed.source.slice(block.start, block.children![0]!.start);
}

function tailOf(parsed: Parsed, block: Block): string {
  return parsed.source.slice(block.children!.at(-1)!.end, block.end);
}

function listMarkerOf(source: string, list: Block): string | null {
  const marker = /^\s*(?:([-*+])|\d+([.)]))/.exec(source.slice(list.start));
  return marker?.[1] ?? marker?.[2] ?? null;
}

function withListMarker(text: string, marker: string | null): string {
  if (marker === null) return text;
  return text.replace(/^(\s*)(?:[-*+]|(\d+)[.)])/, (_match, indent: string, number?: string) =>
    number === undefined ? `${indent}${marker}` : `${indent}${number}${marker}`,
  );
}

function rebuildHead(
  level: Level,
  original: Block,
  before: Parsed,
  beforeBlock: Block,
  after: Block,
): string {
  const originalHead = headOf(level.original, original);
  const beforeHead = headOf(before, beforeBlock);
  const afterHead = headOf(level.after, after);
  if (beforeHead === afterHead) return originalHead;
  if (original.kind === "listItem") {
    const checkbox = /\[([ xX])\]/.exec(afterHead);
    if (checkbox && /\[[ xX]\]/.test(originalHead)) {
      return originalHead.replace(/\[[ xX]\]/, `[${checkbox[1]}]`);
    }
    return fromAfter(level, withListMarker(afterHead, level.listMarker));
  }
  return fromAfter(level, afterHead);
}

function reconcileChildren(
  level: Level,
  before: Parsed,
  originalBlocks: readonly Block[],
  beforeBlocks: readonly Block[],
  afterBlocks: readonly Block[],
): Emitted[] {
  const steps = align(
    beforeBlocks.map((block) => keyOf(before, block)),
    afterBlocks.map((block) => keyOf(level.after, block)),
  );
  const matchedBefore = new Set(
    steps.flatMap((step) => (step.kind === "insert" ? [] : [step.before])),
  );
  const ambiguous = (index: number) =>
    [index - 1, index + 1].some(
      (neighbour) =>
        neighbour >= 0 &&
        neighbour < beforeBlocks.length &&
        !matchedBefore.has(neighbour) &&
        keyOf(before, beforeBlocks[neighbour]!) === keyOf(before, beforeBlocks[index]!) &&
        textOf(level.original, originalBlocks[neighbour]!) !==
          textOf(level.original, originalBlocks[index]!),
    );

  return steps.map((step): Emitted => {
    const afterBlock = afterBlocks[step.after]!;
    const afterText = textOf(level.after, afterBlock);
    if (step.kind === "insert") {
      const text =
        afterBlock.kind === "listItem" ? withListMarker(afterText, level.listMarker) : afterText;
      return { text: fromAfter(level, text), original: null, after: step.after, rebuilt: false };
    }
    const original = originalBlocks[step.before]!;
    const beforeBlock = beforeBlocks[step.before]!;
    if (step.kind === "match") {
      // Two blocks with one spelling in `before` but two in `original`: which survived is unknown.
      if (ambiguous(step.before)) {
        return {
          text: fromAfter(level, afterText),
          original: null,
          after: step.after,
          rebuilt: false,
        };
      }
      return {
        text: textOf(level.original, original),
        original: step.before,
        after: step.after,
        rebuilt: false,
      };
    }
    const canRecurse =
      original.kind === afterBlock.kind &&
      original.children !== null &&
      beforeBlock.children !== null &&
      afterBlock.children !== null;
    if (!canRecurse) {
      return {
        text: fromAfter(level, afterText),
        original: step.before,
        after: step.after,
        rebuilt: false,
      };
    }
    const inner: Level = {
      original: level.original,
      after: level.after,
      eol: level.eol,
      originalPrefix: continuationPrefix(level.original.source, original.children![0]!.start),
      afterPrefix: continuationPrefix(level.after.source, afterBlock.children![0]!.start),
      listMarker: original.kind === "list" ? listMarkerOf(level.original.source, original) : null,
    };
    const head = rebuildHead(level, original, before, beforeBlock, afterBlock);
    const tail =
      tailOf(before, beforeBlock) === tailOf(level.after, afterBlock)
        ? tailOf(level.original, original)
        : fromAfter(level, tailOf(level.after, afterBlock));
    const children = reconcileChildren(
      inner,
      before,
      original.children!,
      beforeBlock.children!,
      afterBlock.children!,
    );
    return {
      text: `${head}${join(inner, original.children!, afterBlock.children!, children)}${tail}`,
      original: step.before,
      after: step.after,
      rebuilt: true,
    };
  });
}

/** Joins emitted siblings with `original`'s separators where both sides have an original. */
function join(
  level: Level,
  originalBlocks: readonly Block[],
  afterBlocks: readonly Block[],
  emitted: readonly Emitted[],
): string {
  const { eol, originalPrefix } = level;
  const afterSeparator = (previous: Emitted, block: Emitted) =>
    fromAfter(
      level,
      level.after.source.slice(afterBlocks[previous.after]!.end, afterBlocks[block.after]!.start),
    );
  const rows = originalBlocks[0]?.kind === "tableRow";
  let text = "";
  emitted.forEach((block, index) => {
    const previous = emitted[index - 1];
    if (previous && rows) {
      // Exactly one separator holds the delimiter row: the one after the first emitted row.
      if (index === 1) {
        text +=
          originalBlocks.length > 1
            ? level.original.source.slice(originalBlocks[0]!.end, originalBlocks[1]!.start)
            : afterSeparator(previous, block);
      } else {
        text += `${eol}${originalPrefix}`;
      }
    } else if (previous) {
      if (
        previous.original !== null &&
        block.original !== null &&
        block.original > previous.original
      ) {
        // Up to the next original block only, so a deleted block is not copied back.
        const from = originalBlocks[previous.original]!;
        const to = originalBlocks[previous.original + 1]!;
        text += level.original.source.slice(from.end, to.start);
      } else {
        const leading =
          block.original !== null && block.original > 0
            ? level.original.source.slice(
                originalBlocks[block.original - 1]!.end,
                originalBlocks[block.original]!.start,
              )
            : "";
        // After an inserted block, an original block keeps the blank lines that led into it.
        // One without a blank line at this depth would join the inserted block to it.
        const quote = originalPrefix.trimEnd();
        const blank = leading
          .split(/\r?\n/)
          .slice(1, -1)
          .some((line) => line.startsWith(quote) && line.slice(quote.length).trim() === "");
        text += blank ? leading : afterSeparator(previous, block);
      }
    }
    text += block.text;
  });
  return text;
}

interface CodeSpan {
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly value: string;
}

/** Fenced code blocks at the start of a line, with the span their content occupies. */
function topLevelFences(source: string): CodeSpan[] {
  return parse(source)
    .root.children.filter((node) => node.type === "code")
    .flatMap((node) => {
      const start = startOf(node);
      const end = endOf(node);
      if (!/^(?:`{3,}|~{3,})/.test(source.slice(start, start + 3))) return [];
      const valueStart = source.indexOf("\n", start) + 1;
      let valueEnd = source.lastIndexOf("\n", end - 1);
      if (valueStart === 0 || valueEnd < valueStart) return [];
      if (source[valueEnd - 1] === "\r") valueEnd -= 1;
      return [{ valueStart, valueEnd, value: source.slice(valueStart, valueEnd) }];
    });
}

/** Puts back fenced code content that differs from the original only in line endings. */
function restoreFenceContents(replacement: string, original: string): string {
  const originalFences = topLevelFences(original);
  const toLf = (text: string) => text.replaceAll("\r\n", "\n");
  let result = replacement;
  for (const fence of topLevelFences(replacement).toReversed()) {
    const source = originalFences.find(
      (candidate) => candidate.value !== fence.value && toLf(candidate.value) === toLf(fence.value),
    );
    if (source) {
      result = `${result.slice(0, fence.valueStart)}${source.value}${result.slice(fence.valueEnd)}`;
    }
  }
  return result;
}

export function reconcileMarkdown(input: {
  original: string;
  before: string;
  after: string;
}): string {
  if (input.before === input.after) return input.original;
  const original = parse(input.original, true);
  const before = parse(input.before, true);
  const after = parse(input.after);
  const eol = detectDominantEol(input.original);
  const level: Level = {
    original,
    after,
    eol,
    originalPrefix: "",
    afterPrefix: "",
    listMarker: null,
  };
  const head = input.original.slice(0, original.blocks[0]?.start ?? input.original.length);
  const tail = input.original.slice(original.blocks.at(-1)?.end ?? input.original.length);
  const asAfter = (text: string) => restoreFenceContents(fromAfter(level, text), input.original);

  const fallback = () => `${head}${asAfter(input.after.trim())}${tail}`;
  let result: string;
  try {
    const emitted = reconcileChildren(
      level,
      before,
      original.blocks,
      before.blocks,
      after.blocks,
    ).map((block) => {
      // A rebuilt block that no longer reads as the edited one is taken from `after` alone.
      const afterText = textOf(after, after.blocks[block.after]!);
      return block.rebuilt && !sameDocument(block.text, afterText)
        ? { ...block, text: asAfter(afterText), rebuilt: false }
        : block;
    });
    result = `${head}${join(level, original.blocks, after.blocks, emitted)}${tail}`;
  } catch (error) {
    // The edit must still reach the session: losing it is worse than rewriting the body.
    console.error("[markdown-reconcile] placing the edit failed; saving the serialization", error);
    return fallback();
  }
  if (sameDocument(result, input.after)) return result;
  return fallback();
}
