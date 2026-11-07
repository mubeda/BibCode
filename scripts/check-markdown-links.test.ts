// @effect-diagnostics nodeBuiltinImport:off - Tests write throwaway Markdown files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { checkMarkdownLinks, githubSlug } from "./check-markdown-links.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "md-links-"));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, name), body);
  }
  return root;
}

describe("checkMarkdownLinks", () => {
  it("accepts existing files, anchors, and images and skips external links", () => {
    const root = fixture({
      "README.md": [
        "# Title",
        "[a](docs/a.md#git-manager) [b](#title) [c](https://example.com/x)",
        '<picture><source srcset="img/d.webp"><img src="img/l.webp" alt="x"></picture>',
      ].join("\n"),
      "docs/a.md": "## Git Manager\n",
      "img/d.webp": "",
      "img/l.webp": "",
    });
    expect(checkMarkdownLinks(NodePath.join(root, "README.md"))).toEqual([]);
  });

  it("reports missing files, anchors, and images, ignoring fenced code", () => {
    const root = fixture({
      "README.md": [
        "[a](docs/missing.md) [b](docs/a.md#nope) [c](#gone)",
        '<img src="img/missing.webp" alt="x">',
        "```",
        "[ignored](nowhere.md)",
        "```",
      ].join("\n"),
      "docs/a.md": "## Real\n",
    });
    expect(checkMarkdownLinks(NodePath.join(root, "README.md"))).toHaveLength(4);
  });

  it("slugs headings like GitHub", () => {
    expect(githubSlug("Files & editor")).toBe("files--editor");
  });
});
