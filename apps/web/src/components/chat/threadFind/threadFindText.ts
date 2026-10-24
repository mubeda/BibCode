/**
 * Find in thread's view of an entry: the text a reader sees, split into the blocks the renderer
 * draws, and the literal matcher that counts a query in it.
 *
 * Markdown is projected by running the renderer's own pipeline (`chatMarkdownPipeline.ts`) and
 * walking the sanitized tree, so raw HTML, sanitizing and plugins need no mirrored rules. Only
 * the custom components are mirrored here: file links show their chip label, `$skill` tokens
 * under a paragraph or list item show the skill's name, an external link with plain text shows
 * that text, and images and placeholders show nothing. A parity test renders `ChatMarkdown` and
 * compares its DOM counts with these.
 */
import type { Element, Root as HastRoot } from "hast";
import type { Root as MdastRoot } from "mdast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type Processor } from "unified";
import {
  buildMarkdownFileLinks,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  chatMarkdownRemarkPlugins,
  chatMarkdownUrlTransform,
  classifyChatMarkdownLink,
  markdownFileLinkLabel,
  readDetailsOrdinal,
  skillChipLabel,
  splitSkillTokens,
  type InlineSkill,
  type MarkdownFileLinks,
} from "../../chatMarkdownPipeline";

/** The most UTF-16 units a query holds; the find input truncates beyond it. */
export const MAX_FIND_QUERY_LENGTH = 256;

/** One block of displayed text. A match never crosses a segment. */
export interface FindSegment {
  /** The block's text, folded for matching (see `foldFindText`). */
  readonly folded: string;
  /** The `data-find-scope` value of the element that renders this text. */
  readonly scope: string;
  /** The ordinals of the `<details>` blocks whose content holds this text, outermost first. */
  readonly details: ReadonlyArray<number>;
}

/** Text one entry renders, in row order. */
export type FindSource =
  | {
      readonly kind: "markdown";
      readonly scope: string;
      readonly text: string;
      readonly lineBreaks: boolean;
      readonly skills: ReadonlyArray<InlineSkill>;
    }
  | { readonly kind: "plain"; readonly scope: string; readonly text: string };

export interface FindProjectionContext {
  readonly cwd: string | undefined;
}

/**
 * Elements that start a new block, in the projected tree and in the rendered DOM. The DOM side
 * adds `button` (a details summary renders in its trigger) and the renderer's wrapper `div`s.
 */
export const FIND_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "button",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** React drops whitespace-only text inside these, so it never reaches the DOM. */
const TABLE_STRUCTURE_TAGS: ReadonlySet<string> = new Set([
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
]);

const WHITESPACE_PATTERN = /\s/g;

/**
 * A line break reads as one whitespace character. A Markdown break is a `<br>` followed by the
 * newline it replaced; a raw `<br>` has none, so it stands for one itself.
 */
export function breakIsFollowedByNewline(nextText: string | null): boolean {
  return nextText !== null && nextText.startsWith("\n");
}

function foldCodePoints(text: string): string {
  let folded = "";
  for (const character of text) {
    const lower = character.toLowerCase();
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
}

/**
 * Folds text for a case-insensitive literal match that keeps every UTF-16 offset: a code point
 * is lowercased only when that keeps its length, and every whitespace character becomes a space.
 */
export function foldFindText(text: string): string {
  // Whole-string lowercasing differs from per-code-point lowercasing only for İ (which grows)
  // and Σ (which becomes ς at a word's end).
  let lower = text.includes("İ") || text.includes("Σ") ? foldCodePoints(text) : text.toLowerCase();
  if (lower.length !== text.length) {
    lower = foldCodePoints(text);
  }
  return lower.replace(WHITESPACE_PATTERN, " ");
}

/** The folded query, or null when there is nothing to search for. */
export function prepareFindQuery(query: string): string | null {
  if (query.length === 0) return null;
  return foldFindText(query.slice(0, MAX_FIND_QUERY_LENGTH));
}

/** Non-overlapping occurrences of `query` in `text`, both folded, left to right. */
export function findFoldedOccurrences(text: string, query: string): number[] {
  const offsets: number[] = [];
  if (query.length === 0) return offsets;
  let index = text.indexOf(query);
  while (index !== -1) {
    offsets.push(index);
    index = text.indexOf(query, index + query.length);
  }
  return offsets;
}

export function countFoldedOccurrences(text: string, query: string): number {
  if (query.length === 0) return 0;
  let count = 0;
  let index = text.indexOf(query);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(query, index + query.length);
  }
  return count;
}

/** One occurrence of a query in a projection. */
export interface FindOccurrence {
  readonly segment: FindSegment;
  readonly start: number;
}

export function locateFindOccurrences(
  segments: ReadonlyArray<FindSegment>,
  query: string,
): FindOccurrence[] {
  const occurrences: FindOccurrence[] = [];
  for (const segment of segments) {
    for (const start of findFoldedOccurrences(segment.folded, query)) {
      occurrences.push({ segment, start });
    }
  }
  return occurrences;
}

export function countFindOccurrences(segments: ReadonlyArray<FindSegment>, query: string): number {
  let count = 0;
  for (const segment of segments) {
    count += countFoldedOccurrences(segment.folded, query);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

type ChatMarkdownProcessor = Processor<MdastRoot, MdastRoot, HastRoot, undefined, undefined>;

const processors = new Map<boolean, ChatMarkdownProcessor>();

/** react-markdown's own order: parse, remark plugins, to hast with raw HTML, rehype plugins. */
function chatMarkdownProcessor(lineBreaks: boolean): ChatMarkdownProcessor {
  let processor = processors.get(lineBreaks);
  if (!processor) {
    processor = unified()
      .use(remarkParse)
      .use(chatMarkdownRemarkPlugins(lineBreaks))
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(CHAT_MARKDOWN_REHYPE_PLUGINS)
      .freeze() as unknown as ChatMarkdownProcessor;
    processors.set(lineBreaks, processor);
  }
  return processor;
}

interface ProjectionWalk {
  readonly scope: string;
  readonly skills: ReadonlyArray<InlineSkill>;
  readonly fileLinks: MarkdownFileLinks;
  readonly segments: FindSegment[];
  buffer: string;
  bufferDetails: ReadonlyArray<number>;
}

interface WalkContext {
  readonly details: ReadonlyArray<number>;
  /** Under a paragraph or list item, where the renderer turns `$skill` tokens into chips. */
  readonly skillText: boolean;
  readonly inCode: boolean;
}

function flush(walk: ProjectionWalk): void {
  if (walk.buffer.length > 0 && walk.buffer.trim().length > 0) {
    walk.segments.push({
      folded: foldFindText(walk.buffer),
      scope: walk.scope,
      details: walk.bufferDetails,
    });
  }
  walk.buffer = "";
}

function emit(walk: ProjectionWalk, text: string, context: WalkContext): void {
  if (text.length === 0) return;
  if (walk.buffer.length === 0) {
    walk.bufferDetails = context.details;
  }
  walk.buffer += text;
}

function emitText(walk: ProjectionWalk, value: string, context: WalkContext): void {
  if (!context.skillText || context.inCode) {
    emit(walk, value, context);
    return;
  }
  for (const segment of splitSkillTokens(value, walk.skills)) {
    emit(walk, segment.kind === "text" ? segment.text : skillChipLabel(segment.skill), context);
  }
}

function walkChildren(
  walk: ProjectionWalk,
  parent: Element | HastRoot,
  context: WalkContext,
): void {
  const tableStructure = parent.type === "element" && TABLE_STRUCTURE_TAGS.has(parent.tagName);
  const { children } = parent;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (child.type === "text") {
      if (tableStructure && child.value.trim().length === 0) continue;
      emitText(walk, child.value, context);
    } else if (child.type === "element") {
      if (child.tagName === "br") {
        const next = children[index + 1];
        if (!breakIsFollowedByNewline(next?.type === "text" ? next.value : null)) {
          emit(walk, "\n", context);
        }
        continue;
      }
      walkElement(walk, child, context);
    }
  }
}

function walkDetails(walk: ProjectionWalk, element: Element, context: WalkContext): void {
  flush(walk);
  const ordinal = readDetailsOrdinal(element);
  const summary = element.children.find(
    (child): child is Element => child.type === "element" && child.tagName === "summary",
  );
  // The renderer shows the summary first, as the block's trigger, wherever it was authored.
  if (summary && summary.children.length > 0) {
    walkChildren(walk, summary, context);
    flush(walk);
  }
  const inner: WalkContext = {
    ...context,
    details: ordinal === null ? context.details : [...context.details, ordinal],
  };
  for (const child of element.children) {
    if (child === summary) continue;
    if (child.type === "text") {
      emitText(walk, child.value, inner);
    } else if (child.type === "element") {
      walkElement(walk, child, inner);
    }
  }
  flush(walk);
}

function walkLink(walk: ProjectionWalk, element: Element, context: WalkContext): void {
  const rawHref = element.properties["href"];
  const href =
    rawHref === undefined || rawHref === null
      ? undefined
      : chatMarkdownUrlTransform(String(rawHref));
  const link = classifyChatMarkdownLink(href, element, walk.fileLinks.metaByHref);
  if (link.kind === "file") {
    emit(walk, markdownFileLinkLabel(link.meta, walk.fileLinks.parentSuffixByPath), context);
    return;
  }
  if (link.kind === "external" && link.plainText !== null) {
    emit(walk, link.plainText, context);
    return;
  }
  walkChildren(walk, element, context);
}

function walkElement(walk: ProjectionWalk, element: Element, context: WalkContext): void {
  const tag = element.tagName;
  switch (tag) {
    case "img":
    case "input":
    case "svg":
      return;
    case "a":
      walkLink(walk, element, context);
      return;
    case "details":
      walkDetails(walk, element, context);
      return;
    case "code":
      walkChildren(walk, element, { ...context, inCode: true });
      return;
    case "p":
    case "li":
      flush(walk);
      walkChildren(walk, element, { ...context, skillText: true });
      flush(walk);
      return;
    default:
      break;
  }
  if (FIND_BLOCK_TAGS.has(tag)) {
    flush(walk);
    walkChildren(walk, element, context);
    flush(walk);
    return;
  }
  walkChildren(walk, element, context);
}

function projectMarkdown(
  source: Extract<FindSource, { kind: "markdown" }>,
  context: FindProjectionContext,
): FindSegment[] {
  const processor = chatMarkdownProcessor(source.lineBreaks);
  const tree = processor.runSync(processor.parse(source.text), source.text);
  const walk: ProjectionWalk = {
    scope: source.scope,
    skills: source.skills,
    fileLinks: buildMarkdownFileLinks(source.text, context.cwd),
    segments: [],
    buffer: "",
    bufferDetails: [],
  };
  walkChildren(walk, tree, { details: [], skillText: false, inCode: false });
  flush(walk);
  return walk.segments;
}

/** The displayed text of one source, as segments. */
export function projectFindSource(
  source: FindSource,
  context: FindProjectionContext,
): FindSegment[] {
  if (source.kind === "plain") {
    return source.text.trim().length === 0
      ? []
      : [{ folded: foldFindText(source.text), scope: source.scope, details: [] }];
  }
  if (source.text.length === 0) return [];
  return projectMarkdown(source, context);
}
