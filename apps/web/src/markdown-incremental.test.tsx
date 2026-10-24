import type { Root } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { createIncrementalMarkdownPlugin } from "./markdown-incremental";

function render(source: string, incremental?: Plugin<[], Root>, parsedSources?: string[]) {
  let tree: Root | undefined;
  const observeParsing: Plugin<[], Root> = function () {
    const parse = this.parser;
    if (!parse) return;
    this.parser = (text, file) => {
      parsedSources?.push(text);
      return parse(text, file);
    };
  };
  const capture: Plugin<[], Root> = () => (root) => {
    tree = structuredClone(root);
  };
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        observeParsing,
        capture,
        remarkGfm,
        // A transform that rewrites text nodes, so a reused prefix must not leak its edits.
        remarkBreaks,
        ...(incremental ? [incremental] : []),
      ]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
    >
      {source}
    </ReactMarkdown>,
  );
  return { html, tree };
}

/** Renders every prefix of `source` as a stream would, against a full parse of that prefix. */
function expectStreamMatchesFullParse(source: string) {
  const incremental = createIncrementalMarkdownPlugin();
  for (let end = 0; end <= source.length; end++) {
    const text = source.slice(0, end);
    expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
  }
}

const prefix = "# Before\n\n```ts\nconst values = [1, 2];\n```\n\n";

describe("incremental Markdown parsing", () => {
  it.each([
    ["a backtick fence", "```js\nconst a = 1;\n```\n\nafter"],
    ["a tilde fence", "~~~py\nx = 1\n~~~\n\nafter\n\n~~~~\n~~~\n~~~~\n\nend"],
    ["a fence in a blockquote", "> quoted\n>\n> ```js\n> abc\n> ```\n\nend"],
    [
      "a fence in a list",
      "- item\n\n  ```js\n  abc\n  ```\n\n- next\n\n1. one\n   ~~~\n   b\n   ~~~\n",
    ],
    ["setext headings and loose lists", "a\n===\n\nb\n---\n\n- first\n\n  continued\n\n- next\n"],
    ["raw HTML", "<div>\nhello\n\n</div>\n\nend"],
    ["a table and task list", "a | b\n--|--\na | b\n\n- [ ] task\n- [x] done\n"],
    ["indented code", "\n\n\tcode\n\nmore"],
    ["a byte-order mark", "﻿text after a byte-order mark"],
  ])("matches a full parse at every streamed prefix of %s", (_name, tail) => {
    expectStreamMatchesFullParse(prefix + tail);
  });

  it.each([
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("matches a full parse with %s line endings split across chunks", (_name, newline) => {
    // Every prefix includes the ones that end between a CR and its LF.
    expectStreamMatchesFullParse(
      (prefix + "next\n\n```\nlast\n```\n\nend").replaceAll("\n", newline),
    );
  });

  it("parses only the text after a closed top-level fence once the fence is complete", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const parsedSources: string[] = [];
    render(prefix + "tail", incremental, parsedSources);
    parsedSources.length = 0;

    const next = prefix + "tail and more";
    expect(render(next, incremental, parsedSources)).toEqual(render(next));
    expect(parsedSources).toEqual(["tail and more"]);
  });

  it("takes a full parse when footnotes or definitions arrive after the reused prefix", () => {
    const before = "[later] and footnote[^note]\n\n" + prefix;
    const incremental = createIncrementalMarkdownPlugin();
    for (const tail of ["text", "[later]: /target", "[later]: /target\n\n[^note]: a note"]) {
      const parsedSources: string[] = [];
      expect(render(before + tail, incremental, parsedSources)).toEqual(render(before + tail));
      if (tail !== "text") expect(parsedSources).toContain(before + tail);
    }
    expectStreamMatchesFullParse(prefix + "a[^x] and [ref]\n\n[^x]: note\n\n[ref]: /later\n");
  });

  it("starts over after edits, replacements and repeated renders", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const documents = [
      prefix + "- first\n - second",
      prefix + "plain text",
      "replacement without fences",
      prefix.replace("Before", "Edited") + "edited prefix",
      prefix + "plain text",
      prefix + "plain text",
    ];
    for (const document of documents) {
      expect(render(document, incremental)).toEqual(render(document));
    }
  });

  it("does not reuse unclosed, nested, indented or mismatched fences", () => {
    const starts = [
      "```\nopen\n\n",
      "````\n```\n\n",
      "> ```\n> code\n> ```\n\n",
      "- ```\n  code\n  ```\n\n",
      "    ```\n    code\n    ```\n\n",
      "<script>\n```\ncode\n```\n\n",
    ];
    for (const start of starts) {
      const incremental = createIncrementalMarkdownPlugin();
      for (const tail of ["", "text", "\n```\n", "\n```\n\nnext"]) {
        expect(render(start + tail, incremental)).toEqual(render(start + tail));
      }
    }
  });
});
