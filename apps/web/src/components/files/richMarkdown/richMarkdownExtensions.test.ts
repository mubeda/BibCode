// @vitest-environment happy-dom

import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import * as corpus from "./fixtures/corpus";
import { canReconcile, reconcileMarkdown } from "./markdownReconcile";
import { findUnsupportedConstruct, splitFrontmatter } from "./markdownSupport";
import { createRichMarkdownEditor, type RichMarkdownEditor } from "./richMarkdownExtensions";

const editors: RichMarkdownEditor[] = [];
const processor = unified().use(remarkParse).use(remarkGfm);

function open(body: string, onUpdate = vi.fn()) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = createRichMarkdownEditor({ body, element, onUpdate });
  editors.push(editor);
  const tiptap = (element.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  return { editor, element, tiptap, onUpdate };
}

/** Types `text` at the end of the first text block that contains `marker`. */
function typeAfter(tiptap: Editor, marker: string, text: string) {
  let position = -1;
  tiptap.state.doc.descendants((node, pos) => {
    if (position >= 0) return false;
    if (node.isTextblock && node.textContent.includes(marker)) {
      position = pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  expect(position).toBeGreaterThan(0);
  tiptap.chain().setTextSelection(position).insertContent(text).run();
}

const supported = Object.entries({
  ...corpus.supportedFixtures,
  yamlFrontmatterBody: splitFrontmatter(corpus.yamlFrontmatter).body,
});

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

describe("createRichMarkdownEditor", () => {
  it("loads every supported corpus fixture so it can be reconciled", () => {
    for (const [name, original] of supported) {
      expect(findUnsupportedConstruct(original), name).toBeNull();
      const { editor } = open(original);
      expect(canReconcile({ original, before: editor.serialize() }), name).toBe(true);
    }
  });

  it.each([
    ["an entity", "Copyright &copy; 2026 and&nbsp;more.\n"],
    ["a link around an image", "See [![logo](logo.png)](https://example.test) here.\n"],
    ["an angle-bracket link target", "Read [a](<b c.md>) first.\n"],
  ])("refuses a file with %s, which the editor cannot write back", (_name, original) => {
    expect(findUnsupportedConstruct(original)).toBeNull();
    const { editor } = open(original);
    expect(canReconcile({ original, before: editor.serialize() })).toBe(false);
  });

  it("reconciles an untouched editor to the original bytes", () => {
    for (const [name, original] of supported) {
      const { editor } = open(original);
      const before = editor.serialize();
      expect(reconcileMarkdown({ original, before, after: editor.serialize() }), name).toBe(
        original,
      );
    }
  });

  it("changes only the typed paragraph after reconcile", () => {
    const original = corpus.fourBacktickFence;
    const { editor, tiptap, onUpdate } = open(original);
    const before = editor.serialize();

    typeAfter(tiptap, "The last paragraph.", " again");

    expect(onUpdate).toHaveBeenCalled();
    expect(reconcileMarkdown({ original, before, after: editor.serialize() })).toBe(
      original.replace("The last paragraph.", "The last paragraph. again"),
    );
  });

  it("changes only the typed row of a table after reconcile", () => {
    const original = corpus.alignedTable;
    const { editor, tiptap } = open(original);
    const before = editor.serialize();

    typeAfter(tiptap, "one", "!");

    const lines = reconcileMarkdown({ original, before, after: editor.serialize() }).split("\n");
    const originalLines = original.split("\n");
    expect(lines).toHaveLength(originalLines.length);
    lines.forEach((line, index) => {
      if (index === 2) expect(line).toMatch(/^\|\s*one!\s*\|\s*1\s*\|\s*a\s*\|$/);
      else expect(line).toBe(originalLines[index]);
    });
  });

  it("inserting a block at any boundary of any level keeps every untouched block's bytes", () => {
    const table = "| a | b |\n|:--|--:|\n| one   |  two |\n| three | four |\n";
    const quote = (text: string) => text.replace(/^(?=.)/gm, "> ");
    const cases = [
      ...supported,
      ["tableBeforeParagraph", `${table}\nAfter.\n`],
      ["crlfTable", `${table}\nAfter.\n`.replaceAll("\n", "\r\n")],
      ["quotedTable", `${quote(table)}\nAfter.\n`],
      ["tableInDetails", `<details>\n<summary>More</summary>\n\n${table}\n</details>\n\nAfter.\n`],
    ] as const;
    const containers = new Set([
      "table",
      "bulletList",
      "orderedList",
      "taskList",
      "blockquote",
      "detailsContent",
    ]);
    /** Every block the reconcile copies whole, plus list items, in document order. */
    const untouchedBlocks = (original: string) => {
      const blocks: string[] = [];
      const visit = (node: Nodes) => {
        const isLeaf = !["root", "list", "blockquote", "table"].includes(node.type);
        if (isLeaf && node.position) {
          blocks.push(original.slice(node.position.start.offset, node.position.end.offset));
        }
        if (node.type !== "listItem" && isLeaf) return;
        if ("children" in node) node.children.forEach(visit);
      };
      visit(processor.parse(original));
      return blocks;
    };
    const failures: string[] = [];
    let insertions = 0;
    for (const [name, original] of cases) {
      const boundaries: { at: number; parent: number; index: number }[] = [];
      const { tiptap: probe } = open(original);
      expect(canReconcile({ original, before: probe.getMarkdown() }), name).toBe(true);
      const collect = (node: typeof probe.state.doc, at: number, parent: number) => {
        node.forEach((_child, offset, index) =>
          boundaries.push({ at: at + offset, parent, index }),
        );
        boundaries.push({ at: at + node.content.size, parent, index: node.childCount });
      };
      collect(probe.state.doc, 0, -1);
      probe.state.doc.descendants((node, pos) => {
        // An empty details body is one leaf for the reconcile, not a level it recurses into.
        if (containers.has(node.type.name) && node.textContent !== "") collect(node, pos + 1, pos);
      });

      for (const { at, parent, index } of boundaries) {
        const { editor, tiptap } = open(original);
        const before = editor.serialize();
        const { schema, doc } = tiptap.state;
        const container = parent < 0 ? doc : doc.nodeAt(parent)!;
        const text = () => schema.nodes.paragraph!.create(null, schema.text("Inserted"));
        const neighbour = container.child(Math.max(0, index - 1));
        const inserted =
          container.type.name === "table"
            ? neighbour.type.create(
                null,
                neighbour.content.content.map((cell) => cell.type.create(cell.attrs, text())),
              )
            : container.type.name.endsWith("List")
              ? neighbour.type.create(null, text())
              : text();
        tiptap.view.dispatch(tiptap.state.tr.insert(at, inserted));
        const result = reconcileMarkdown({ original, before, after: editor.serialize() });
        const where = `${name} at ${container.type.name} ${index}`;

        if (!result.includes("Inserted")) failures.push(`${where} lost the inserted block`);
        let cursor = 0;
        for (const block of untouchedBlocks(original)) {
          const found = result.indexOf(block, cursor);
          if (found < 0) failures.push(`${where} changed ${JSON.stringify(block)}`);
          else cursor = found;
        }
        insertions += 1;
      }
    }
    expect(failures).toEqual([]);
    expect(insertions).toBe(94);
  });

  it("a ticked task checkbox changes only that item's marker, and Undo reverses it", () => {
    const original = "-   [ ] Keep\n- [ ] Other\n";
    const { editor, element } = open(original);
    const before = editor.serialize();

    const checkbox = element.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    expect(reconcileMarkdown({ original, before, after: editor.serialize() })).toBe(
      "-   [x] Keep\n- [ ] Other\n",
    );
    editor.undo();
    expect(reconcileMarkdown({ original, before, after: editor.serialize() })).toBe(original);
  });

  it("an inserted image links its file even when the name holds #, ?, a space or parentheses", () => {
    const names = ["diagram#1.png", "a?b.png", "my image.png", "fig (1).png", "fig).png"];
    for (const name of names) {
      const { editor } = open("Text\n");
      editor.insertImage(`img/${name}`);
      const images: string[] = [];
      const collect = (node: Nodes) => {
        if (node.type === "image") images.push(node.url);
        if ("children" in node) node.children.forEach(collect);
      };
      collect(processor.parse(editor.serialize()));
      expect(images, name).toHaveLength(1);
      // Resolved the way a browser resolves it: the whole name is the path, with no query or fragment.
      const resolved = new URL(images[0]!, "https://files.example.test/docs/");
      expect(decodeURIComponent(resolved.pathname), name).toBe(`/docs/img/${name}`);
      expect(`${resolved.search}${resolved.hash}`, name).toBe("");
    }
  });

  it("reports and performs undo and redo", () => {
    const { editor, tiptap } = open("Hello world\n");
    expect(editor.canUndo).toBe(false);

    typeAfter(tiptap, "Hello world", " again");
    expect(editor.serialize()).toBe("Hello world again");
    expect(editor.canUndo).toBe(true);

    editor.undo();
    expect(editor.serialize()).toBe("Hello world");
    expect(editor.canRedo).toBe(true);
    editor.redo();
    expect(editor.serialize()).toBe("Hello world again");
  });

  it("stops notifying and releases its view when destroyed", () => {
    const { editor, element, tiptap } = open("Hello\n");
    const listener = vi.fn();
    editor.subscribe(listener);
    typeAfter(tiptap, "Hello", "!");
    expect(listener).toHaveBeenCalled();
    listener.mockClear();

    editor.destroy();

    expect(tiptap.isDestroyed).toBe(true);
    expect(element.querySelector("[contenteditable='true']")).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });
});
