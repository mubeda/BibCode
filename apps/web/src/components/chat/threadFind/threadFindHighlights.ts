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

/** One block of displayed text in the DOM, with the text nodes that hold it. */
export interface DomFindSegment {
  readonly folded: string;
  readonly pieces: ReadonlyArray<DomTextPiece>;
}

interface DomWalk {
  readonly segments: DomFindSegment[];
  text: string;
  pieces: DomTextPiece[];
}

function flushDomSegment(walk: DomWalk): void {
  if (walk.text.trim().length > 0) {
    walk.segments.push({ folded: foldFindText(walk.text), pieces: walk.pieces });
  }
  walk.text = "";
  walk.pieces = [];
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
      walk.pieces.push({ node, start: walk.text.length });
      walk.text += node.data;
      continue;
    }
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    const tag = element.localName;
    if (
      SKIPPED_TAGS.has(tag) ||
      element.hasAttribute(FIND_IGNORE_ATTRIBUTE) ||
      element.hasAttribute("hidden")
    ) {
      continue;
    }
    if (tag === "br") {
      if (!breakIsFollowedByNewline(nextTextValue(element))) {
        walk.text += "\n";
      }
      continue;
    }
    const block = FIND_BLOCK_TAGS.has(tag);
    if (block) flushDomSegment(walk);
    walkDomChildren(walk, element);
    if (block) flushDomSegment(walk);
  }
}

/** The text of one find scope, as segments. */
export function collectScopeSegments(scope: Element): DomFindSegment[] {
  const walk: DomWalk = { segments: [], text: "", pieces: [] };
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

/** Every occurrence of the folded query in a scope, in reading order. */
export function findScopeOccurrences(
  scope: Element,
  query: string,
): Array<{ readonly segment: DomFindSegment; readonly start: number }> {
  const occurrences: Array<{ readonly segment: DomFindSegment; readonly start: number }> = [];
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
