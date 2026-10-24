import type { Root } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_SANITIZE_SCHEMA, extractCodeBlock } from "../ChatMarkdown";
import { createIncrementalMarkdownPlugin } from "../../markdown-incremental";
import { fenceBody, isClosedMermaidFence } from "./mermaidFence";

interface FenceVerdict {
  readonly className: string | undefined;
  readonly body: string;
  readonly closed: boolean;
}

/** Runs ChatMarkdown's parser pipeline and asks the gate about every code block it produced. */
function fenceVerdicts(
  text: string,
  {
    isStreaming = false,
    incremental,
  }: { isStreaming?: boolean; incremental?: Plugin<[], Root> } = {},
): FenceVerdict[] {
  const verdicts: FenceVerdict[] = [];
  const components: Components = {
    pre({ node, children }) {
      const block = extractCodeBlock(children);
      if (block) {
        const body = fenceBody(block.code);
        verdicts.push({
          className: block.className,
          body,
          closed: isClosedMermaidFence(text, node?.position, body, isStreaming),
        });
      }
      return null;
    },
  };
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, ...(incremental ? [incremental] : [])]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA]]}
      components={components}
    >
      {text}
    </ReactMarkdown>,
  );
  return verdicts;
}

function onlyFence(text: string, isStreaming = false): FenceVerdict {
  const verdicts = fenceVerdicts(text, { isStreaming });
  expect(verdicts, text).toHaveLength(1);
  return verdicts[0]!;
}

describe("closed Mermaid fence gate", () => {
  it.each([
    ["a backtick fence", "```mermaid\ngraph TD\nA-->B\n```", "graph TD\nA-->B"],
    ["a tilde fence", "~~~mermaid\ngraph TD\nA-->B\n~~~", "graph TD\nA-->B"],
    ["a longer closing run", "```mermaid\nA-->B\n`````", "A-->B"],
    ["a closer with trailing spaces", "```mermaid\nA-->B\n```   ", "A-->B"],
    ["three-space indentation", "   ```mermaid\n   A-->B\n   ```", "A-->B"],
    ["a blockquote", "> ```mermaid\n> A-->B\n> ```", "A-->B"],
    ["a list item", "- item\n\n  ```mermaid\n  A-->B\n  ```", "A-->B"],
    ["a tab-indented list item", "-\t```mermaid\n\tA-->B\n\t```", "A-->B"],
    ["a blockquote inside a list", "- > ```mermaid\n  > A-->B\n  > ```", "A-->B"],
    ["CRLF line endings", "```mermaid\r\ngraph TD\r\nA-->B\r\n```\r\n", "graph TD\r\nA-->B"],
    ["lone CR line endings", "```mermaid\rgraph TD\rA-->B\r```", "graph TD\rA-->B"],
    ["blank first and last body lines", "```mermaid\n\nA-->B\n\n```", "\nA-->B\n"],
    ["text after the fence", "```mermaid\nA-->B\n```\n\nAfter.", "A-->B"],
  ])("draws %s", (_name, text, body) => {
    expect(onlyFence(text)).toEqual({ className: "language-mermaid", body, closed: true });
  });

  it.each([
    ["a closer indented four spaces", "```mermaid\nA-->B\n    ```"],
    ["`> ```` as content of a top-level fence", "```mermaid\nA-->B\n> ```"],
    ["a closer followed by an info string", "```mermaid\nA-->B\n```x"],
    ["a run shorter than the opener", "````mermaid\nA-->B\n```"],
    ["an unclosed fence without a trailing newline", "```mermaid\nA-->B"],
    ["an unclosed fence with a trailing newline", "```mermaid\nA-->B\n"],
    ["an unclosed fence with a trailing blank line", "```mermaid\nA-->B\n\n"],
    ["a fence its blockquote ended", "> ```mermaid\n> A-->B\n\nAfter."],
    ["an empty body", "```mermaid\n```"],
    ["a blank body", "```mermaid\n   \n\t\n```"],
  ])("keeps %s as source", (_name, text) => {
    expect(onlyFence(text).closed).toBe(false);
  });

  it("keeps a fence its list item ended, before an unindented closer, as source", () => {
    const [listFence, ...rest] = fenceVerdicts("- ```mermaid\n  A-->B\n```");
    expect(listFence).toEqual({ className: "language-mermaid", body: "A-->B", closed: false });
    // The unindented run opens a new top-level fence instead of closing the list item's.
    expect(rest.map((verdict) => verdict.closed)).toEqual([false]);
  });

  it.each([
    ['<pre><code class="language-mermaid">A-->B\n</code></pre>'],
    // Its line count matches a closed fence's, so only the missing fence run tells them apart.
    ['<pre><code\nclass="language-mermaid">A-->B\n</code></pre>'],
  ])("keeps raw-HTML language-mermaid blocks as source: %j", (text) => {
    const verdict = onlyFence(text);
    expect(verdict.className).toBe("language-mermaid");
    expect(verdict.closed).toBe(false);
  });

  it("treats a missing position as not closed", () => {
    expect(isClosedMermaidFence("```mermaid\nA\n```", undefined, "A", false)).toBe(false);
    expect(isClosedMermaidFence("```mermaid\nA\n```", { start: {}, end: {} }, "A", false)).toBe(
      false,
    );
  });

  describe("while streaming", () => {
    it.each([
      ["a closer at the very end of the text", "```mermaid\nA-->B\n```"],
      ["a closer with trailing spaces at the end", "```mermaid\nA-->B\n```  "],
    ])("keeps %s open", (_name, text) => {
      expect(onlyFence(text, true).closed).toBe(false);
      expect(onlyFence(text, false).closed).toBe(true);
    });

    it.each([
      ["a newline", "```mermaid\nA-->B\n```\n"],
      ["a carriage return", "```mermaid\nA-->B\n```\r"],
    ])("closes a fence once %s follows its closer", (_name, text) => {
      expect(onlyFence(text, true).closed).toBe(true);
    });
  });

  it("gives every fence the same verdict under the incremental streaming parser", () => {
    const source = [
      "# Diagrams",
      "",
      "```mermaid",
      "graph TD",
      "A-->B",
      "```",
      "",
      "Between the diagrams.",
      "",
      "~~~mermaid",
      "sequenceDiagram",
      "A->>B: hi",
      "~~~",
      "",
      "> ```mermaid",
      "> pie",
      "> ```",
      "",
      "- item",
      "",
      "  ```mermaid",
      "  graph LR",
      "  C-->D",
      "  ```",
      "",
      "```mermaid",
      "graph TD",
      "E-->F",
      "    ```",
      "```",
      "",
      "End.",
    ].join("\n");
    const incremental = createIncrementalMarkdownPlugin();
    let sawReuse = false;
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      const streamed = fenceVerdicts(text, { isStreaming: true, incremental });
      const full = fenceVerdicts(text, { isStreaming: true });
      expect(streamed, `prefix ${end}`).toEqual(full);
      sawReuse ||= full.filter((verdict) => verdict.closed).length >= 2;
    }
    expect(sawReuse).toBe(true);
  });
});
