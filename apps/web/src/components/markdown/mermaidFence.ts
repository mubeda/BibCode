/** A parsed node's position; offsets are absolute in the parsed text. */
export interface SourcePosition {
  readonly start: { readonly offset?: number | undefined };
  readonly end: { readonly offset?: number | undefined };
}

/**
 * The longest diagram source drawn, mermaid.js's own `maxTextSize` default. A longer source
 * shows an error before any renderer code loads.
 */
export const MERMAID_SOURCE_LIMIT = 50_000;

const LINE_ENDING = /\r\n|\r|\n/g;
const FENCE_OPENING = /^(?:`{3,}|~{3,})/;
const ENDS_WITH_LINE_ENDING = /[\r\n]$/;
const STARTS_WITH_LINE_ENDING = /^[\r\n]/;

function countLineEndings(value: string): number {
  return value.match(LINE_ENDING)?.length ?? 0;
}

/** A fenced block's source: its code element's text without the `\n` the HTML step appends. */
export function fenceBody(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

/**
 * Whether a fenced code block was closed by its own closing fence, from what the parser
 * decided rather than by parsing CommonMark again. `position` is the block's position in
 * `text`, and `body` its source (`fenceBody`). The block is closed when its slice of `text`
 * starts with a fence run, ends at a closing run and holds one line more than its opening
 * line and body: the closing line. An apparent closer that the parser kept as content (one
 * indented four spaces, one followed by an info string, one shorter than the opener) is a
 * body line, so the counts differ. A fence ended by its container or by the end of the text
 * is not closed, nor is raw-HTML `<pre>`. While a reply streams, a closing run at the very end
 * of the text could still grow into content, so it counts only once a line ending follows.
 */
export function isClosedMermaidFence(
  text: string,
  position: SourcePosition | undefined,
  body: string,
  isStreaming: boolean,
): boolean {
  const start = position?.start.offset;
  const end = position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return false;
  const slice = text.slice(start, end);
  if (!FENCE_OPENING.test(slice)) return false;
  if (body.trim().length === 0) return false;
  // An unclosed fence at the end of the text keeps its trailing line endings.
  if (ENDS_WITH_LINE_ENDING.test(slice)) return false;
  // The opening line, every body line, and the closing line.
  if (countLineEndings(slice) !== countLineEndings(body) + 2) return false;
  return !isStreaming || STARTS_WITH_LINE_ENDING.test(text.slice(end));
}
