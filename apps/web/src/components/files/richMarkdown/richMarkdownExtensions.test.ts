// @vitest-environment happy-dom

import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { List, Nodes } from "mdast";
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

  it("holds a closed mermaid fence as one diagram block, written as the code block was", () => {
    const { editor, tiptap } = open(corpus.mermaidFence);
    expect(tiptap.state.doc.child(1).type.name).toBe("mermaidDiagram");
    expect(editor.serialize()).toBe(
      "Before the diagram.\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nAfter the diagram.",
    );
    // An unclosed fence stays a code block, as chat shows it as source.
    expect(open("```mermaid\ngraph TD\n").tiptap.state.doc.child(0).type.name).toBe("codeBlock");
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

describe("an edit at any boundary of any level", () => {
  const table = "| a | b |\n|:--|--:|\n| one   |  two |\n| three | four |\n";
  const quote = (text: string) => text.replace(/^(?=.)/gm, "> ");
  const cases = [
    ...supported,
    ["tableBeforeParagraph", `${table}\nAfter.\n`],
    ["crlfTable", `${table}\nAfter.\n`.replaceAll("\n", "\r\n")],
    ["quotedTable", `${quote(table)}\nAfter.\n`],
    ["tableInDetails", `<details>\n<summary>More</summary>\n\n${table}\n</details>\n\nAfter.\n`],
    ["orderedList", "1) one\n2) two\n3) three\n\nAfter.\n"],
    ["nestedList", "- one\n  - nested a\n  - nested b\n- two\n\nAfter.\n"],
    ["quotedOrderedList", `${quote("1. one\n2. two\n")}\nAfter.\n`],
    ["quotedTaskList", `${quote("- [ ] open\n- [x] done\n")}\nAfter.\n`],
  ] as const;
  const containers = new Set([
    "table",
    "bulletList",
    "orderedList",
    "taskList",
    "blockquote",
    "detailsContent",
  ]);
  type Doc = Editor["state"]["doc"];
  type Edit = { readonly where: string; readonly apply: (tiptap: Editor) => void };

  interface Block {
    readonly type: string;
    readonly key: string;
    readonly start: number;
    readonly end: number;
  }
  /** Every block the reconcile copies whole, plus list items, in document order. */
  const blocksOf = (source: string) => {
    const blocks: Block[] = [];
    const text = (node: Nodes): string =>
      "value" in node ? node.value : "children" in node ? node.children.map(text).join(" ") : "";
    const lists: List[] = [];
    const summary = (html: string) => /<summary>([^<]*)<\/summary>/.exec(html)?.[1] ?? "";
    const visit = (node: Nodes, index: number, siblings: readonly Nodes[]) => {
      // A details block is one block too, written as one HTML node or as an opener and closer.
      if (node.type === "html" && node.value.startsWith("<details")) {
        const whole = node.value.includes("</details>");
        const close = whole
          ? index
          : siblings.findIndex(
              (other, at) => at > index && "value" in other && other.value === "</details>",
            );
        const body = siblings
          .slice(index + 1, Math.max(index + 1, close))
          .map(text)
          .join(" ");
        blocks.push({
          type: "details",
          key: `details:${summary(node.value)}:${body.replaceAll("\r\n", "\n")}`,
          start: node.position!.start.offset!,
          end: siblings[close]!.position!.end.offset!,
        });
        if (whole) return;
      }
      const isBlock = !["root", "list", "blockquote", "table"].includes(node.type);
      if (isBlock && node.position) {
        // The first item of an ordered list spells the number the list starts at.
        const parent = siblings === lists.at(-1)?.children ? lists.at(-1) : undefined;
        const start = parent?.ordered && index === 0 ? String(parent.start) : "";
        const checked = node.type === "listItem" ? `${String(node.checked)}${start}` : "";
        blocks.push({
          type: node.type,
          key: `${node.type}:${checked}:${text(node).replaceAll("\r\n", "\n")}`,
          start: node.position.start.offset!,
          end: node.position.end.offset!,
        });
      }
      if (node.type !== "listItem" && isBlock) return;
      if (node.type === "list") lists.push(node);
      if ("children" in node) node.children.forEach(visit);
      if (node.type === "list") lists.pop();
    };
    visit(processor.parse(source), 0, []);
    return blocks;
  };
  /** Pairs of indexes matched by the longest common subsequence of the keys. */
  const matches = (left: readonly Block[], right: readonly Block[]) => {
    const table = Array.from({ length: left.length + 1 }, () =>
      Array.from({ length: right.length + 1 }, () => 0),
    );
    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) {
        table[i]![j] =
          left[i]!.key === right[j]!.key
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    const pairs = new Map<number, number>();
    for (let i = 0, j = 0; i < left.length && j < right.length;) {
      if (left[i]!.key === right[j]!.key) pairs.set(i++, j++);
      else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
      else j += 1;
    }
    return pairs;
  };

  /**
   * Applies each edit to a fresh editor and reconciles. Every original block must keep its
   * bytes, in order, except the edited ones: a block whose content the edit changed or
   * removed, and everything inside a list item it changed (the receiving item and the items
   * that hold it).
   */
  const sweep = (edits: (doc: Doc) => Edit[], inserts: boolean) => {
    const failures: string[] = [];
    let count = 0;
    for (const [name, original] of cases) {
      const { tiptap: probe } = open(original);
      const before = probe.getMarkdown();
      expect(canReconcile({ original, before }), name).toBe(true);
      const originalBlocks = blocksOf(original);
      const beforeBlocks = blocksOf(before);
      const toBefore = matches(originalBlocks, beforeBlocks);
      for (const { where, apply } of edits(probe.state.doc)) {
        const { editor, tiptap } = open(original);
        apply(tiptap);
        const after = editor.serialize();
        const result = reconcileMarkdown({ original, before, after });
        const kept = new Set(matches(beforeBlocks, blocksOf(after)).keys());
        const edited = originalBlocks.filter((_block, index) => {
          const beforeIndex = toBefore.get(index);
          return beforeIndex !== undefined && !kept.has(beforeIndex);
        });
        const inEditedItem = (block: Block) =>
          edited.some(
            (item) =>
              item.type === "listItem" && item.start <= block.start && block.end <= item.end,
          );
        const label = `${name} ${where}`;
        if (inserts && !result.includes("Inserted")) failures.push(`${label} lost the edit`);
        let cursor = 0;
        for (const block of originalBlocks) {
          if (edited.includes(block) || inEditedItem(block)) continue;
          const text = original.slice(block.start, block.end);
          const found = result.indexOf(text, cursor);
          if (found < 0) failures.push(`${label} changed ${JSON.stringify(text)}`);
          else cursor = found;
        }
        count += 1;
      }
    }
    return { failures, count };
  };

  /** The doc and every container the reconcile recurses into, with their positions. */
  const levels = (doc: Doc) => {
    const found: { node: Doc; at: number; parent: number }[] = [{ node: doc, at: 0, parent: -1 }];
    doc.descendants((node, pos) => {
      // An empty details body is one leaf for the reconcile, not a level it recurses into.
      if (containers.has(node.type.name) && node.textContent !== "") {
        found.push({ node, at: pos + 1, parent: pos });
      }
    });
    return found;
  };
  const paragraph = (tiptap: Editor) =>
    tiptap.schema.nodes.paragraph!.create(null, tiptap.schema.text("Inserted"));

  it("inserting a block keeps every untouched block's bytes", () => {
    const { failures, count } = sweep(
      (doc) =>
        levels(doc).flatMap(({ node, at, parent }) =>
          Array.from({ length: node.childCount + 1 }, (_unused, index): Edit => {
            let offset = 0;
            for (let child = 0; child < index; child += 1) offset += node.child(child).nodeSize;
            return {
              where: `inserted at ${node.type.name} ${index}`,
              apply: (tiptap) => {
                const container = parent < 0 ? tiptap.state.doc : tiptap.state.doc.nodeAt(parent)!;
                const neighbour = container.child(Math.max(0, index - 1));
                const inserted =
                  container.type.name === "table"
                    ? neighbour.type.create(
                        null,
                        neighbour.content.content.map((cell) =>
                          cell.type.create(cell.attrs, paragraph(tiptap)),
                        ),
                      )
                    : container.type.name.endsWith("List")
                      ? neighbour.type.create(null, paragraph(tiptap))
                      : paragraph(tiptap);
                tiptap.view.dispatch(tiptap.state.tr.insert(at + offset, inserted));
              },
            };
          }),
        ),
      true,
    );
    expect(failures).toEqual([]);
    expect(count).toBe(130);
  });

  it("inserting a paragraph or a first nested item inside a list item keeps every other block's bytes", () => {
    const { failures, count } = sweep((doc) => {
      const edits: Edit[] = [];
      doc.descendants((node, pos) => {
        if (node.type.name !== "listItem" && node.type.name !== "taskItem") return true;
        const end = pos + 1 + node.content.size;
        const list = doc.resolve(pos).parent;
        edits.push({
          where: `paragraph in ${list.type.name} item at ${pos}`,
          apply: (tiptap) => tiptap.view.dispatch(tiptap.state.tr.insert(end, paragraph(tiptap))),
        });
        let nested = false;
        node.forEach((child) => (nested ||= child.type.name.endsWith("List")));
        if (!nested) {
          edits.push({
            where: `nested item in ${list.type.name} item at ${pos}`,
            apply: (tiptap) =>
              tiptap.view.dispatch(
                tiptap.state.tr.insert(
                  end,
                  list.type.create(null, node.type.create(null, paragraph(tiptap))),
                ),
              ),
          });
        }
        return true;
      });
      return edits;
    }, true);
    expect(failures).toEqual([]);
    expect(count).toBe(43);
  });

  it("deleting a block keeps every untouched block's bytes", () => {
    const { failures, count } = sweep(
      (doc) =>
        levels(doc).flatMap(({ node, at }) => {
          if (node.childCount < 2) return [];
          const edits: Edit[] = [];
          node.forEach((child, offset, index) =>
            edits.push({
              where: `deleted ${node.type.name} ${index}`,
              apply: (tiptap) =>
                tiptap.view.dispatch(
                  tiptap.state.tr.delete(at + offset, at + offset + child.nodeSize),
                ),
            }),
          );
          return edits;
        }),
      false,
    );
    expect(failures).toEqual([]);
    expect(count).toBe(84);
  });
});
