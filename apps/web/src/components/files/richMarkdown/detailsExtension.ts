/*
 * Adapted from Orca (https://github.com/stablyai/orca),
 * src/renderer/src/components/editor/rich-markdown/details/rich-markdown-details-extension.ts
 * and details-markdown-html.ts.
 * Copyright (c) 2026 Lovecast Inc. Licensed under the MIT License:
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or substantial portions of
 * the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 * Changed for BiBCode: only the `open` attribute is accepted and none is written, the toggle
 * heading variants, placeholders and Orca's class are dropped, and the fence scan is inlined.
 */
import { decodeHtmlEntities, type AnyExtension, type MarkdownToken } from "@tiptap/core";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";

type DetailsToken = MarkdownToken & {
  summaryTokens?: MarkdownToken[];
  bodyTokens?: MarkdownToken[];
  open?: boolean;
};

const OPENING_TAG = /^<details(?:\s+open(?:\s*=\s*(?:""|"open"|''|'open'|open))?)?\s*>/i;
const SUMMARY = /^\s*<summary>([^<]*)<\/summary>/i;
const TAG = /<\/?details\b[^>]*>/gi;

/** Offsets of lines inside fenced code, where a `</details>` is text, not a tag. */
function insideFence(content: string): (offset: number) => boolean {
  const ranges: [number, number][] = [];
  let fence: string | null = null;
  let fenceStart = 0;
  let offset = 0;
  for (const line of content.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker) {
      fence = marker;
      fenceStart = offset;
    } else if (
      fence !== null &&
      marker &&
      marker[0] === fence[0] &&
      marker.length >= fence.length
    ) {
      ranges.push([fenceStart, offset + line.length]);
      fence = null;
    }
    offset += line.length + 1;
  }
  if (fence !== null) ranges.push([fenceStart, content.length]);
  return (at) => ranges.some(([start, end]) => at > start && at <= end);
}

/** A `<details>` block at the start of `content`, through its matching close, or null. */
function matchDetailsBlock(content: string): { raw: string; inner: string } | null {
  const opening = OPENING_TAG.exec(content);
  if (!opening) return null;
  const fenced = insideFence(content);
  TAG.lastIndex = 0;
  let depth = 0;
  for (let tag = TAG.exec(content); tag !== null; tag = TAG.exec(content)) {
    if (tag.index !== 0 && fenced(tag.index)) continue;
    if (tag[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        return {
          raw: content.slice(0, tag.index + tag[0].length),
          inner: content.slice(opening[0].length, tag.index),
        };
      }
    } else if (OPENING_TAG.test(tag[0])) {
      depth += 1;
    } else {
      return null;
    }
  }
  return null;
}

export function escapeDetailsHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    filesDetails: {
      /** Inserts an open collapsible section titled "More", with the caret in its body. */
      insertDetails: () => ReturnType;
    };
  }
}

const FilesDetails = Details.extend({
  addCommands() {
    return {
      ...this.parent?.(),
      insertDetails:
        () =>
        ({ state, chain }) => {
          const at = state.selection.$from.after(1);
          const section = {
            type: "details",
            attrs: { open: true },
            content: [
              { type: "detailsSummary", content: [{ type: "text", text: "More" }] },
              { type: "detailsContent", content: [{ type: "paragraph" }] },
            ],
          };
          // Body paragraph start: details, summary text "More" and its close, content, paragraph.
          return chain()
            .insertContentAt(at, section)
            .setTextSelection(at + 1 + 6 + 1 + 1)
            .run();
        },
    };
  },
  markdownTokenizer: {
    name: "details",
    level: "block",
    start: (source: string) => {
      const match = /(?:^|\n) {0,3}<details\b/i.exec(source);
      return match ? match.index + (source[match.index] === "\n" ? 1 : 0) : -1;
    },
    tokenize(source, _tokens, lexer) {
      const block = matchDetailsBlock(source.replace(/^ {0,3}/, ""));
      if (!block) return undefined;
      const summary = SUMMARY.exec(block.inner);
      if (!summary) return undefined;
      const indent = /^ {0,3}/.exec(source)![0];
      return {
        type: "details",
        raw: indent + block.raw,
        block: true,
        open: /\sopen\b/i.test(OPENING_TAG.exec(block.raw)![0]),
        summaryTokens: lexer.inlineTokens(decodeHtmlEntities(summary[1]!.trim())),
        bodyTokens: lexer.blockTokens(block.inner.slice(summary[0].length).trim()),
      } as DetailsToken;
    },
  },
  parseMarkdown: (token, helpers) => {
    const details = token as DetailsToken;
    if (details.type !== "details") return [];
    const summary = helpers.createNode(
      "detailsSummary",
      {},
      helpers.parseInline(details.summaryTokens ?? []),
    );
    const body = helpers.parseChildren(details.bodyTokens ?? []);
    const content = helpers.createNode(
      "detailsContent",
      {},
      body.length > 0 ? body : [helpers.createNode("paragraph")],
    );
    return helpers.createNode("details", { open: details.open === true }, [summary, content]);
  },
  renderMarkdown: (node, helpers) => {
    const summary = node.content?.find((child) => child.type === "detailsSummary");
    const content = node.content?.find((child) => child.type === "detailsContent");
    const summaryText = escapeDetailsHtml(
      decodeHtmlEntities(helpers.renderChildren(summary?.content ?? [], "")),
    );
    const body = helpers.renderChildren(content?.content ?? [], "\n\n").trim();
    return `<details>\n<summary>${summaryText}</summary>\n\n${body}\n\n</details>`;
  },
});

// Inline images and links can sit in a summary; the upstream text-only content would reject them.
const FilesDetailsSummary = DetailsSummary.extend({ content: "inline*" });

export function createDetailsExtensions(): AnyExtension[] {
  // The open state lives in the document so a new section opens, but renderMarkdown never writes
  // it: toggling a section does not change the file, and a hand-written `open` stays as written.
  return [FilesDetails.configure({ persist: true }), FilesDetailsSummary, DetailsContent];
}
