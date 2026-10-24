import type { DiffsHighlighter } from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

type HighlightedRoot = ReturnType<DiffsHighlighter["codeToHast"]>;

const PLAIN_LANGUAGES = new Set(["text", "plaintext", "plain", "txt", "ansi"]);

function codeChildren(root: HighlightedRoot) {
  const pre = root.children.find((node) => node.type === "element" && node.tagName === "pre");
  if (pre?.type !== "element") throw new Error("Missing highlighted pre element");
  const code = pre.children.find((node) => node.type === "element" && node.tagName === "code");
  if (code?.type !== "element") throw new Error("Missing highlighted code element");
  return code.children;
}

/**
 * Highlights a code block that only grows, as a streamed one does. Completed lines are
 * tokenized once: each call resumes Shiki from the grammar state after the last completed line,
 * tokenizes only the last line, and returns the completed lines' nodes unchanged, so
 * their rendered DOM can stay mounted. Any other change starts over with a full highlight.
 */
export function createIncrementalHighlightedDocument(
  highlighter: DiffsHighlighter,
  language: string,
  theme: DiffThemeName,
): (code: string) => HighlightedRoot {
  const options = { lang: language, theme };
  const newline = { type: "text" as const, value: "\n" };
  let cached:
    | {
        prefix: string;
        state: NonNullable<ReturnType<DiffsHighlighter["getLastGrammarState"]>>;
        children: ReturnType<typeof codeChildren>;
      }
    | undefined;

  return (code) => {
    // Plain text and ANSI have no grammar state. A CR at the end of a chunk can still become
    // half of a CRLF, so that input takes the full path.
    if (!language || PLAIN_LANGUAGES.has(language) || code.includes("\r")) {
      return highlighter.codeToHast(code, options);
    }
    if (cached && !code.startsWith(cached.prefix)) cached = undefined;
    // The last line stays unfinished even when a newline ends it: a Markdown code block's text
    // always ends with one, so its last line can still grow.
    const end = code.lastIndexOf("\n", code.length - 2) + 1;
    if (end > (cached?.prefix.length ?? 0)) {
      // Leave out the final newline: Shiki would tokenize an extra empty line and advance the
      // grammar state twice before the next line.
      const root = highlighter.codeToHast(code.slice(cached?.prefix.length ?? 0, end - 1), {
        ...options,
        ...(cached ? { grammarState: cached.state } : {}),
      });
      const state = highlighter.getLastGrammarState(root);
      if (!state) {
        cached = undefined;
        return highlighter.codeToHast(code, options);
      }
      cached = {
        prefix: code.slice(0, end),
        state,
        children: [...(cached ? [...cached.children, newline] : []), ...codeChildren(root)],
      };
    }
    const prefix = cached;
    if (!prefix) return highlighter.codeToHast(code, options);
    return highlighter.codeToHast(code.slice(prefix.prefix.length), {
      ...options,
      grammarState: prefix.state,
      transformers: [
        {
          code: (node) => ({ ...node, children: [...prefix.children, newline, ...node.children] }),
        },
      ],
    });
  };
}
