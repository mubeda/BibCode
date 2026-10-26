import type { Root, RootContent } from "mdast";
import type { Parser, Plugin } from "unified";

interface ParsedPrefix {
  readonly source: string;
  readonly offset: number;
  readonly line: number;
  readonly children: RootContent[];
}

function hasDefinitions(node: Root | RootContent): boolean {
  return (
    node.type === "definition" ||
    node.type === "footnoteDefinition" ||
    ("children" in node && node.children.some(hasDefinitions))
  );
}

function shiftPositions(node: Root | RootContent, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if ("children" in node) {
    for (const child of node.children) shiftPositions(child, offset, lines);
  }
}

/**
 * A remark plugin that, while a reply streams, parses only the text after the last completed
 * prefix and reuses that prefix's parsed nodes. The prefix ends at a closed top-level code fence
 * followed by a blank line, which no later text can reopen. Definitions and footnotes are
 * document-wide, so a document with any of them takes a full parse. One plugin instance keeps
 * one prefix, so each streaming message needs its own.
 */
export function createIncrementalMarkdownPlugin(): Plugin<[], Root> {
  let cached: ParsedPrefix | undefined;

  function parseIncrementally(source: string, parse: (text: string) => Root): Root {
    // A CR at the end of a chunk can become half of a CRLF, and a parser strips a leading BOM,
    // which inside the full document is text.
    if (source.includes("\r") || source.includes("﻿")) return parse(source);

    const prefix = cached && source.startsWith(cached.source) ? cached : undefined;
    let root: Root;
    if (prefix) {
      root = parse(source.slice(prefix.offset));
      if (hasDefinitions(root)) return parse(source);
      shiftPositions(root, prefix.offset, prefix.line - 1);
      if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
      // Remark transforms mutate the tree: the cache keeps pristine nodes and each render gets
      // its own copy.
      root.children.unshift(...structuredClone(prefix.children));
    } else {
      root = parse(source);
      if (hasDefinitions(root)) return root;
    }

    for (let index = root.children.length - 1; index >= 0; index--) {
      const node = root.children[index];
      if (node?.type !== "code") continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (prefix && end < prefix.offset) break;
      const value = source.slice(start, end);
      const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(value)?.[1];
      if (!opening) continue;
      const lastLine = value.slice(value.lastIndexOf("\n") + 1);
      const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
      const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0];
      if (!closing.test(lastLine) || !separator) continue;
      const offset = end + separator.length;
      cached = {
        source: source.slice(0, offset),
        offset,
        line: node.position!.end.line + 2,
        children: structuredClone(root.children.slice(0, index + 1)),
      };
      break;
    }
    return root;
  }

  return function () {
    const parse: Parser<Root> | undefined = this.parser as Parser<Root> | undefined;
    if (!parse) return;
    this.parser = (source, file) => parseIncrementally(source, (text) => parse(text, file));
  };
}
