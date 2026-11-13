// @vitest-environment happy-dom

import type { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RichMarkdownLinkPopover } from "./RichMarkdownLinkPopover";
import { createRichMarkdownEditor, type RichMarkdownEditor } from "./richMarkdownExtensions";

let container: HTMLDivElement;
let root: Root;
const editors: RichMarkdownEditor[] = [];

function openEditor(body: string, select: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = createRichMarkdownEditor({ body, element, onUpdate: vi.fn() });
  editors.push(editor);
  const view = element.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
  const tiptap = view.editor;
  const from = 1 + tiptap.state.doc.textContent.indexOf(select);
  act(() => {
    tiptap
      .chain()
      .focus()
      .setTextSelection({ from, to: from + select.length })
      .run();
  });
  return { editor, view };
}

function Harness({ editor, onClosed }: { editor: RichMarkdownEditor; onClosed: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <RichMarkdownLinkPopover
      editor={editor}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onClosed();
      }}
    />
  );
}

async function showPopover(editor: RichMarkdownEditor) {
  const onClosed = vi.fn();
  await act(async () => root.render(<Harness editor={editor} onClosed={onClosed} />));
  const field = document.body.querySelector<HTMLInputElement>("input[aria-label='Link URL']");
  if (!field) throw new Error("The link field is not shown");
  return { field, onClosed };
}

async function enter(field: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(label: string) {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`No ${label} button`);
  await act(async () => button.click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

describe("RichMarkdownLinkPopover", () => {
  it("linking selected text saves a Markdown link", async () => {
    const { editor } = openEditor("Read the docs today\n", "docs");
    const { field, onClosed } = await showPopover(editor);

    await enter(field, "https://example.test/docs");
    await press("Save");

    expect(editor.serialize()).toBe("Read the [docs](https://example.test/docs) today");
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("an empty URL removes the link and keeps the text", async () => {
    const { editor } = openEditor("Read the [docs](https://example.test/docs) today\n", "oc");
    const { field } = await showPopover(editor);

    await enter(field, "");
    await press("Save");

    expect(editor.serialize()).toBe("Read the docs today");
  });

  it("the field shows the current URL when the caret is in a link", async () => {
    const { editor } = openEditor("Read the [docs](https://example.test/docs) today\n", "oc");
    const { field } = await showPopover(editor);

    expect(field.value).toBe("https://example.test/docs");
    expect(
      [...document.body.querySelectorAll("button")].map((button) => button.textContent),
    ).toContain("Remove link");
  });

  it("Escape closes the dialog, changes nothing and returns focus to the editor", async () => {
    const { editor, view } = openEditor("Read the docs today\n", "docs");
    const { field, onClosed } = await showPopover(editor);
    await enter(field, "https://example.test/other");

    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onClosed).toHaveBeenCalledOnce();
    expect(editor.serialize()).toBe("Read the docs today");
    await vi.waitFor(() => expect(view.contains(document.activeElement)).toBe(true));
  });
});
