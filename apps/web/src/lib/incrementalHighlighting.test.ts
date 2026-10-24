import { getSharedHighlighter } from "@pierre/diffs";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";

import { DIFF_THEME_NAMES } from "./diffRendering";
import { createIncrementalHighlightedDocument } from "./incrementalHighlighting";

const samples = {
  typescript: "/* multi\nline comment */\nconst x = `template\n${1 + 2}`;\nconst re = /abc/;\n",
  python: '#!/usr/bin/python\nx = """multi\nline"""\nprint(x)\n',
  bash: "#!/bin/bash\ncat <<EOF\nhello\nEOF\necho hi\n",
  html: "<script>\nconst x = 1;\n</script>\n<style>\np {color:red;}\n</style>\n",
  markdown: "# heading\n\n```ts\nconst a = 1;\n```\n\ntext\n",
  rust: 'fn main() {\n let x = r#"multi\nline"#;\n}\n',
  tsx: 'const element = <div\n className="x">\n{value}\n</div>;\n',
  json: '{\n "value": [1,\n 2, 3]\n}\n',
  yaml: "key: |\n  multiline\n  value\nnext: true\n",
  css: '/* comment\n continued */\np::before {\n content: "text";\n}\n',
  sql: "SELECT 'multi\nline'\nFROM table_name;\n",
} as const;

const themes = [DIFF_THEME_NAMES.dark, DIFF_THEME_NAMES.light] as const;

// The same engine ChatMarkdown asks for.
const highlighterPromise = getSharedHighlighter({
  langs: Object.keys(samples) as Array<keyof typeof samples>,
  themes: [...themes],
  preferredHighlighter: "shiki-js",
});

describe("incremental code highlighting", () => {
  it.each(Object.entries(samples))(
    "matches a full highlight at every streamed prefix in %s",
    async (language, code) => {
      const highlighter = await highlighterPromise;
      for (const theme of themes) {
        const highlight = createIncrementalHighlightedDocument(highlighter, language, theme);
        for (let end = 0; end <= code.length; end++) {
          const text = code.slice(0, end);
          expect(toHtml(highlight(text)), `${theme}, prefix ${end}`).toBe(
            highlighter.codeToHtml(text, { lang: language, theme }),
          );
        }
      }
    },
  );

  it.each([
    ["without", ""],
    // Markdown code blocks always end with a newline, also while their last line streams.
    ["with", "\n"],
  ])(
    "tokenizes only the unfinished line once earlier lines are complete, %s a final newline",
    async (_name, end) => {
      const highlighter = await highlighterPromise;
      const highlight = createIncrementalHighlightedDocument(highlighter, "typescript", themes[0]);
      const first = highlight(`const completed = 1;\nconst cur${end}`);
      const original = highlighter.codeToHast.bind(highlighter);
      const tokenized: string[] = [];
      highlighter.codeToHast = (code, options) => {
        tokenized.push(code);
        return original(code, options);
      };
      try {
        const next = highlight(`const completed = 1;\nconst current = 2;${end}`);
        expect(tokenized).toEqual([`const current = 2;${end}`]);
        // The completed line keeps its node, so its rendered DOM can stay mounted.
        expect(lineNodes(next)[0]).toBe(lineNodes(first)[0]);
      } finally {
        highlighter.codeToHast = original;
      }
    },
  );

  it("starts over after edits and truncation, including edits to a completed line", async () => {
    const highlighter = await highlighterPromise;
    const highlight = createIncrementalHighlightedDocument(highlighter, "typescript", themes[0]);
    const inputs = [
      "/* open\ncomment\n",
      "/* open\ncomment\n*/\nconst x = 1;",
      "const edited = 2;\nconst x = 1;",
      "const edited = 2;\nconst x = 10;",
      "const edited = 2;\n",
      "",
      "\n\n\nconst fresh = true;\n",
    ];
    for (const text of inputs) {
      expect(toHtml(highlight(text))).toBe(
        highlighter.codeToHtml(text, { lang: "typescript", theme: themes[0] }),
      );
    }
  });

  it("matches a full highlight with CRLF and CR line endings split across chunks", async () => {
    const highlighter = await highlighterPromise;
    for (const code of [
      "/* multi\r\nline */\r\nconst x = 1;\r\n",
      "/* multi\rline */\rconst x;\r",
    ]) {
      const highlight = createIncrementalHighlightedDocument(highlighter, "typescript", themes[0]);
      for (let end = 0; end <= code.length; end++) {
        const text = code.slice(0, end);
        expect(toHtml(highlight(text))).toBe(
          highlighter.codeToHtml(text, { lang: "typescript", theme: themes[0] }),
        );
      }
    }
  });
});

function lineNodes(root: ReturnType<ReturnType<typeof createIncrementalHighlightedDocument>>) {
  const pre = root.children[0];
  const code = pre?.type === "element" ? pre.children[0] : undefined;
  return code?.type === "element" ? code.children : [];
}
