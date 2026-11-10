// @vitest-environment happy-dom

import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as corpus from "./fixtures/corpus";
import { canReconcile, reconcileMarkdown } from "./markdownReconcile";
import { findUnsupportedConstruct, splitFrontmatter } from "./markdownSupport";
import { createRichMarkdownEditor, type RichMarkdownEditor } from "./richMarkdownExtensions";

const editors: RichMarkdownEditor[] = [];

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
