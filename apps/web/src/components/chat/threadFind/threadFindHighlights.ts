/**
 * Find in thread on the page: the occurrences of a query in the mounted rows, as `Range`s over
 * their existing text nodes, painted with the CSS Custom Highlight API. Nothing here writes to
 * the DOM except the fallback attribute on a row when the engine has no `CSS.highlights`.
 *
 * Text is read the way `threadFindText.ts` projects it: only inside `[data-find-scope]`
 * elements, skipping `[data-find-ignore]` chrome and SVG, and split into segments at block
 * elements, so the n-th occurrence here is the n-th occurrence there.
 */
import { breakIsFollowedByNewline, FIND_BLOCK_TAGS, foldFindText } from "./threadFindText";

export const FIND_SCOPE_ATTRIBUTE = "data-find-scope";
export const FIND_IGNORE_ATTRIBUTE = "data-find-ignore";

const SKIPPED_TAGS: ReadonlySet<string> = new Set(["svg", "script", "style", "template"]);

interface DomTextPiece {
  readonly node: Text;
  readonly start: number;
}

/** The attribute on a `<details>` block's content that holds the block's ordinal. */
const DETAILS_CONTENT_ATTRIBUTE = "data-markdown-details-content";

/** One block of displayed text in the DOM, with the text nodes that hold it. */
export interface DomFindSegment {
  readonly folded: string;
  readonly pieces: ReadonlyArray<DomTextPiece>;
  /** The ordinals of the `<details>` blocks whose content holds this text, outermost first. */
  readonly details: ReadonlyArray<number>;
}

interface DomWalk {
  readonly segments: DomFindSegment[];
  text: string;
  pieces: DomTextPiece[];
  details: ReadonlyArray<number>;
  textDetails: ReadonlyArray<number>;
}

function flushDomSegment(walk: DomWalk): void {
  if (walk.text.trim().length > 0) {
    walk.segments.push({
      folded: foldFindText(walk.text),
      pieces: walk.pieces,
      details: walk.textDetails,
    });
  }
  walk.text = "";
  walk.pieces = [];
}

function appendDomText(walk: DomWalk, text: string, piece: DomTextPiece | null): void {
  if (walk.text.length === 0) {
    walk.textDetails = walk.details;
  }
  if (piece) walk.pieces.push(piece);
  walk.text += text;
}

function detailsOrdinalOf(element: Element): number | null {
  const value = element.getAttribute(DETAILS_CONTENT_ATTRIBUTE);
  if (value === null || value.length === 0) return null;
  const ordinal = Number(value);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

function nextTextValue(node: Node): string | null {
  const next = node.nextSibling;
  return next !== null && next.nodeType === 3 ? ((next as Text).data ?? "") : null;
}

function walkDomChildren(walk: DomWalk, parent: Node): void {
  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 3) {
      const node = child as Text;
      if (node.data.length === 0) continue;
      appendDomText(walk, node.data, { node, start: walk.text.length });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const tag = element.localName;
    if (
      SKIPPED_TAGS.has(tag) ||
      element.hasAttribute(FIND_IGNORE_ATTRIBUTE) ||
      element.hasAttribute("hidden") ||
      // React hides a committed subtree that suspends again, such as a streaming code block
      // loading a grammar, while its fallback shows the same text.
      (element as HTMLElement).style?.display === "none"
    ) {
      continue;
    }
    if (tag === "br") {
      if (!breakIsFollowedByNewline(nextTextValue(element))) {
        appendDomText(walk, "\n", null);
      }
      continue;
    }
    const block = FIND_BLOCK_TAGS.has(tag);
    if (block) flushDomSegment(walk);
    const ordinal = detailsOrdinalOf(element);
    const outerDetails = walk.details;
    if (ordinal !== null) walk.details = [...outerDetails, ordinal];
    walkDomChildren(walk, element);
    walk.details = outerDetails;
    if (block) flushDomSegment(walk);
  }
}

/** The text of one find scope, as segments. */
export function collectScopeSegments(scope: Element): DomFindSegment[] {
  const walk: DomWalk = { segments: [], text: "", pieces: [], details: [], textDetails: [] };
  walkDomChildren(walk, scope);
  flushDomSegment(walk);
  return walk.segments;
}

function pointAtStart(pieces: ReadonlyArray<DomTextPiece>, offset: number): [Text, number] | null {
  for (const piece of pieces) {
    const end = piece.start + piece.node.data.length;
    if (offset < end) {
      return [piece.node, Math.max(0, offset - piece.start)];
    }
  }
  return null;
}

function pointAtEnd(pieces: ReadonlyArray<DomTextPiece>, offset: number): [Text, number] | null {
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index]!;
    if (offset > piece.start) {
      return [piece.node, Math.min(piece.node.data.length, offset - piece.start)];
    }
  }
  return null;
}

/** A `Range` over a segment's text from `start` to `end`, or null when it holds no text. */
export function rangeForSegmentOffsets(
  segment: DomFindSegment,
  start: number,
  end: number,
): Range | null {
  const from = pointAtStart(segment.pieces, start);
  const to = pointAtEnd(segment.pieces, end);
  if (!from || !to) return null;
  const range = from[0].ownerDocument.createRange();
  range.setStart(from[0], from[1]);
  range.setEnd(to[0], to[1]);
  return range;
}

/** One occurrence of a query in the DOM. */
export interface DomFindOccurrence {
  readonly segment: DomFindSegment;
  readonly start: number;
}

/** Every occurrence of the folded query in a scope, in reading order. */
export function findScopeOccurrences(scope: Element, query: string): DomFindOccurrence[] {
  const occurrences: DomFindOccurrence[] = [];
  if (query.length === 0) return occurrences;
  for (const segment of collectScopeSegments(scope)) {
    let index = segment.folded.indexOf(query);
    while (index !== -1) {
      occurrences.push({ segment, start: index });
      index = segment.folded.indexOf(query, index + query.length);
    }
  }
  return occurrences;
}
