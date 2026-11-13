import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { DETAILS_CLOSE, DETAILS_OPEN, DETAILS_WHOLE } from "./markdownReconcile";

/** Markdown the rich editor cannot write back faithfully, so the file stays read-only (R34). */
export type UnsupportedConstruct =
  | "reference-link"
  | "footnote"
  | "raw-html"
  | "html-comment"
  | "math";

const FRONTMATTER = /^(---|\+\+\+)[ \t]*\r?\n(?:[\s\S]*?\r?\n)?\1[ \t]*(?:\r?\n|$)/;
/** Pandoc's rule: no space after the opening `$`, none before the closing one, no digit after. */
const INLINE_MATH = /(?:^|[^\\$])\$(?=\S)[^$\n]*?\S\$(?!\d)|\$\$/;

const processor = unified().use(remarkParse).use(remarkGfm);

/** A leading YAML (`---`) or TOML (`+++`) block, with its bytes exactly as written. */
export function splitFrontmatter(source: string): { frontmatter: string; body: string } {
  const frontmatter = FRONTMATTER.exec(source)?.[0] ?? "";
  return { frontmatter, body: source.slice(frontmatter.length) };
}

function htmlConstruct(value: string): UnsupportedConstruct | null {
  if (value.trimStart().startsWith("<!--")) return "html-comment";
  if (DETAILS_OPEN.test(value) || DETAILS_CLOSE.test(value)) return null;
  const whole = DETAILS_WHOLE.exec(value);
  if (whole) return findIn(processor.parse(whole[2]!) as Root);
  return "raw-html";
}

function findIn(node: Nodes): UnsupportedConstruct | null {
  switch (node.type) {
    case "code":
    case "inlineCode":
      return null;
    case "linkReference":
    case "imageReference":
    case "definition":
      return "reference-link";
    case "footnoteReference":
    case "footnoteDefinition":
      return "footnote";
    case "html":
      return htmlConstruct(node.value);
    case "text":
      return INLINE_MATH.test(node.value) ? "math" : null;
  }
  if (!("children" in node)) return null;
  for (const child of node.children) {
    const found = findIn(child);
    if (found !== null) return found;
  }
  return null;
}

/** The first construct in `body` that keeps the rendered view read-only, or null. */
export function findUnsupportedConstruct(body: string): UnsupportedConstruct | null {
  return findIn(processor.parse(body) as Root);
}
