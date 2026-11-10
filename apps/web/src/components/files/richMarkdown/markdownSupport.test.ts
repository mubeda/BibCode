import { describe, expect, it } from "vite-plus/test";

import { richMarkdownMode } from "../filePreviewMode";
import * as corpus from "./fixtures/corpus";
import { findUnsupportedConstruct, splitFrontmatter } from "./markdownSupport";

describe("splitFrontmatter", () => {
  it("returns a YAML block byte for byte", () => {
    const { frontmatter, body } = splitFrontmatter(corpus.yamlFrontmatter);

    expect(frontmatter).toBe("---\ntitle: Guide\ntags: [a, b]\n---\n");
    expect(body).toBe("\n# Guide\n\nIntro text.\n");
  });

  it("returns a TOML block with no final newline byte for byte", () => {
    expect(splitFrontmatter(corpus.tomlFrontmatterNoFinalNewline)).toEqual({
      frontmatter: '+++\ntitle = "Guide"\n+++',
      body: "",
    });
  });

  it("returns no frontmatter for a file without one, or with a rule further down", () => {
    expect(splitFrontmatter("# Title\n\nText.\n").frontmatter).toBe("");
    expect(splitFrontmatter("Intro.\n\n---\n\nMore.\n---\n").frontmatter).toBe("");
  });

  it("always joins back into the source", () => {
    for (const source of Object.values(corpus).filter((value) => typeof value === "string")) {
      const { frontmatter, body } = splitFrontmatter(source as string);
      expect(frontmatter + body).toBe(source);
    }
    const crlf = "---\r\ntitle: x\r\n---\r\nBody\r\n";
    expect(splitFrontmatter(crlf).frontmatter).toBe("---\r\ntitle: x\r\n---\r\n");
  });
});

describe("findUnsupportedConstruct", () => {
  it("finds each construct the editor cannot represent", () => {
    expect(findUnsupportedConstruct(corpus.referenceLinks)).toBe("reference-link");
    expect(findUnsupportedConstruct(corpus.footnote)).toBe("footnote");
    expect(findUnsupportedConstruct(corpus.htmlComment)).toBe("html-comment");
    expect(findUnsupportedConstruct(corpus.rawDiv)).toBe("raw-html");
    expect(findUnsupportedConstruct(corpus.inlineMath)).toBe("math");
    expect(findUnsupportedConstruct(corpus.blockMath)).toBe("math");
  });

  it("accepts the representable variants", () => {
    for (const body of [
      corpus.setextHeadings,
      corpus.alignedTable,
      corpus.listWithNestedFence,
      corpus.handWrittenDetails,
      corpus.taskList,
      "It costs $5 and $10 today.\n",
    ]) {
      expect(findUnsupportedConstruct(body)).toBeNull();
    }
  });

  it("ignores text that only looks like a construct inside code", () => {
    const body =
      "Text.\n\n```\n[docs]: https://example.test\n<div>x</div>\n<!-- c -->\n$$\n```\n\nUse `$a$` and `[^1]`.\n";

    expect(findUnsupportedConstruct(body)).toBeNull();
  });

  it("treats a details block with other attributes or inner HTML as raw HTML", () => {
    expect(
      findUnsupportedConstruct(
        '<details class="x">\n<summary>More</summary>\n\nText\n\n</details>\n',
      ),
    ).toBe("raw-html");
    expect(
      findUnsupportedConstruct("<details>\n<summary>More</summary>\n\nA<br>B\n\n</details>\n"),
    ).toBe("raw-html");
  });
});

describe("richMarkdownMode", () => {
  it("decides from the extension and the content", () => {
    expect(richMarkdownMode("notes.md", "# Notes\n\nText.\n")).toEqual({ editable: true });
    expect(richMarkdownMode("notes.mdx", "# Notes\n")).toEqual({ editable: false, reason: "mdx" });
    expect(richMarkdownMode("notes.md", corpus.footnote)).toEqual({
      editable: false,
      reason: "footnote",
    });
    expect(richMarkdownMode("notes.txt", "Text.\n")).toEqual({
      editable: false,
      reason: "not-markdown",
    });
    expect(richMarkdownMode("docs/GUIDE.MD", corpus.yamlFrontmatter)).toEqual({ editable: true });
  });
});
