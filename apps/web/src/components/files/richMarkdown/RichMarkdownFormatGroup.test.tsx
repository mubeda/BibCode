// @vitest-environment happy-dom

import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "../../ui/tooltip";
import { RichMarkdownFormatGroup } from "./RichMarkdownFormatGroup";
import { createRichMarkdownEditor, type RichMarkdownEditor } from "./richMarkdownExtensions";

let container: HTMLDivElement;
let root: Root;
const editors: RichMarkdownEditor[] = [];

function openEditor(body: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = createRichMarkdownEditor({ body, element, onUpdate: vi.fn() });
  editors.push(editor);
  const tiptap = (element.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  // Select the whole first block's text, as a person selecting the word would.
  act(() => {
    tiptap.commands.setTextSelection({
      from: 1,
      to: 1 + tiptap.state.doc.firstChild!.content.size,
    });
  });
  return { editor, tiptap };
}

function renderGroup(
  editor: RichMarkdownEditor | null,
  handlers = { onLink: vi.fn(), onImage: vi.fn() },
) {
  act(() => {
    root.render(
      <TooltipProvider>
        <RichMarkdownFormatGroup editor={editor} {...handlers} />
      </TooltipProvider>,
    );
  });
  return handlers;
}

function control(label: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`No control named ${label}`);
  return element;
}

function click(label: string) {
  act(() => control(label).click());
}

async function openMore() {
  await act(async () => control("More formatting").click());
}

function menuItem(name: string): HTMLElement {
  const item = [...document.body.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!item) throw new Error(`No menu item ${name}`);
  return item;
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

describe("RichMarkdownFormatGroup", () => {
  it("every control has an accessible name", async () => {
    const { editor } = openEditor("Item\n");
    renderGroup(editor);

    for (const label of [
      "Paragraph",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bold",
      "Italic",
      "Strikethrough",
      "Bullet list",
      "Numbered list",
      "Task list",
      "Quote",
      "Link",
      "Image",
      "More formatting",
    ]) {
      expect(control(label).tagName).toBe("BUTTON");
    }
    expect(control("Bold").closest("[role='group']")?.getAttribute("aria-label")).toBe(
      "Formatting",
    );
    await openMore();
    for (const name of ["Heading 4", "Heading 5", "Collapsible section"]) {
      expect(menuItem(name)).toBeTruthy();
    }
  });

  it("controls are disabled with a reason when there is no editor", async () => {
    const handlers = renderGroup(null);

    for (const label of ["Paragraph", "Bold", "Link", "Image", "More formatting"]) {
      expect(control(label).getAttribute("aria-disabled")).toBe("true");
    }
    click("Link");
    click("Image");
    expect(handlers.onLink).not.toHaveBeenCalled();
    expect(handlers.onImage).not.toHaveBeenCalled();
    await act(async () => {
      control("Bold").dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      control("Bold").focus();
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Formatting is available in rendered view"),
    );
  });

  it("heading 2 then bold serializes as a bold heading", () => {
    const { editor } = openEditor("Title\n");
    renderGroup(editor);

    click("Heading 2");
    click("Bold");

    expect(editor.serialize()).toBe("## **Title**");
  });

  it.each([
    ["Paragraph", "Item"],
    ["Heading 1", "# Item"],
    ["Heading 2", "## Item"],
    ["Heading 3", "### Item"],
    ["Bold", "**Item**"],
    ["Italic", "*Item*"],
    ["Strikethrough", "~~Item~~"],
    ["Bullet list", "- Item"],
    ["Numbered list", "1. Item"],
    ["Task list", "- [ ] Item"],
    ["Quote", "> Item"],
  ])("each format command serializes as expected: %s", (label, expected) => {
    const { editor } = openEditor("Item\n");
    renderGroup(editor);

    click(label);

    expect(editor.serialize()).toBe(expected);
  });

  it.each([
    ["Heading 4", "#### Item"],
    ["Heading 5", "##### Item"],
  ])("the More menu applies %s", async (name, expected) => {
    const { editor } = openEditor("Item\n");
    renderGroup(editor);

    await openMore();
    await act(async () => menuItem(name).click());

    expect(editor.serialize()).toBe(expected);
  });

  it("an active format shows as pressed and toggles off", () => {
    const { editor } = openEditor("- Item\n");
    renderGroup(editor);

    expect(control("Bullet list").getAttribute("aria-pressed")).toBe("true");
    expect(control("Numbered list").getAttribute("aria-pressed")).toBe("false");
    click("Bullet list");

    expect(editor.serialize()).toBe("Item");
    expect(control("Bullet list").getAttribute("aria-pressed")).toBe("false");
  });

  it("a collapsible section is saved as details with a summary and reopens editable", async () => {
    const { editor, tiptap } = openEditor("Intro\n");
    renderGroup(editor);
    act(() => {
      tiptap.commands.setTextSelection(1 + tiptap.state.doc.firstChild!.content.size);
    });

    await openMore();
    await act(async () => menuItem("Collapsible section").click());
    act(() => {
      tiptap.commands.insertContent("Text");
    });

    const saved = editor.serialize();
    expect(saved).toContain("<details>");
    expect(saved).toContain("<summary>More</summary>");
    expect(saved).toContain("Text");
    const reopened = openEditor(saved);
    let detailsNodes = 0;
    reopened.tiptap.state.doc.descendants((node) => {
      if (node.type.name === "details") detailsNodes += 1;
    });
    expect(detailsNodes).toBe(1);
    expect(reopened.tiptap.isEditable).toBe(true);
  });
});
