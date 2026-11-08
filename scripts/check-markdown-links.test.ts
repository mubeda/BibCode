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

  const failuresFor = (files: Record<string, string>) =>
    checkMarkdownLinks(NodePath.join(fixture(files), "README.md"));

  it("checks reference definitions and every srcset candidate", () => {
    expect(
      failuresFor({
        "README.md": '[bad][ref]\n\n[ref]: missing.md\n<img srcset="a.webp 1x, b.webp 2x" alt="x">',
        "a.webp": "",
      }),
    ).toHaveLength(2);
  });

  it("decodes paths and fragments and ignores query strings", () => {
    expect(
      failuresFor({
        "README.md": "[a](hello%20world.md) [b](a.md?raw=1#caf%C3%A9)",
        "hello world.md": "",
        "a.md": "# Café\n",
      }),
    ).toEqual([]);
  });

  it("derives anchors like GitHub", () => {
    expect(
      failuresFor({
        "README.md": "[a](a.md#hello-world) [b](a.md#foo) [c](a.md#foo-1) [d](a.md#foo-1-1)",
        "a.md": "# *Hello* _world_\n# Foo\n# Foo\n# Foo-1\n",
      }),
    ).toEqual([]);
  });

  it("handles indented and longer code fences", () => {
    expect(
      failuresFor({
        "README.md":
          "   ```\n[x](gone.md)\n   ```\n\n````md\n```\n[y](gone.md)\n```\n````\n[z](gone.md)",
      }),
    ).toHaveLength(1);
  });

  it("slugs headings like GitHub", () => {
    expect(githubSlug("Files & editor")).toBe("files--editor");
  });
});
