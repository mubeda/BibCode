/*
 * The extension set follows Orca's rich Markdown schema (https://github.com/stablyai/orca,
 * src/renderer/src/components/editor/rich-markdown/schema/rich-markdown-extensions.ts).
 * Copyright (c) 2026 Lovecast Inc. Licensed under the MIT License (full text in
 * detailsExtension.ts).
 */
import { Editor, type AnyExtension, type JSONContent } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import Image from "@tiptap/extension-image";
import { BulletList, ListItem, TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

import { createDetailsExtensions } from "./detailsExtension";
import {
  createMermaidDiagramExtension,
  fencedCode,
  type MermaidDiagramView,
} from "./mermaidDiagramExtension";

export type FormatName =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "bold"
  | "italic"
  | "strike"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "link"
  | "details";

export type FormatCommand = FormatName | "image";

/** The rendered-view editor as the rest of Files sees it, without TipTap types. */
export type RichMarkdownEditor = {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): void;
  redo(): void;
  isActive(name: FormatName): boolean;
  run(command: FormatCommand): void;
  subscribe(listener: () => void): () => void;
  /** The link under the caret or selection, or null. */
  currentLink(): { href: string } | null;
  /** Links the selection, or inserts `href` as linked text when nothing is selected. */
  setLink(href: string): void;
  /** Removes the link under the caret and keeps its text. */
  removeLink(): void;
  /** Inserts an image linking `relativePath` (a plain, unencoded path) at the caret. */
  insertImage(relativePath: string): void;
  serialize(): string;
  destroy(): void;
};

// Two adjacent lists that differ only in marker are two lists; writing both as `-` merges them.
const MarkedBulletList = BulletList.extend({
  addAttributes() {
    return { marker: { default: "-", renderHTML: () => ({}) } };
  },
  parseMarkdown: (token, helpers) => {
    if (token.type !== "list" || token.ordered) return [];
    const marker = /^\s*([-*+])/.exec(token.raw ?? "")?.[1] ?? "-";
    return {
      type: "bulletList",
      attrs: { marker },
      content: token.items ? helpers.parseChildren(token.items) : [],
    };
  },
});

const MarkedListItem = ListItem.extend({
  renderMarkdown: (node: JSONContent, helpers, context) => {
    const rendered = ListItem.config.renderMarkdown!.call(
      undefined as never,
      node,
      helpers,
      context,
    );
    const marker = (context?.meta?.["parentAttrs"] as { marker?: string } | undefined)?.marker;
    return context?.parentType === "bulletList" && marker && marker !== "-"
      ? rendered.replace(/^- /, `${marker} `)
      : rendered;
  },
});

// Three backticks would end early at a three-backtick line inside the code.
const FencedCodeBlock = CodeBlock.extend({
  renderMarkdown: (node: JSONContent, helpers) => {
    const code = node.content ? helpers.renderChildren(node.content) : "";
    return fencedCode(code, (node.attrs?.["language"] as string | null) ?? "");
  },
});

function extensions(
  onDiagramViewsChange?: (views: readonly MermaidDiagramView[]) => void,
): AnyExtension[] {
  return [
    StarterKit.configure({
      bulletList: false,
      listItem: false,
      codeBlock: false,
      underline: false,
      trailingNode: false,
      link: { openOnClick: false, autolink: false },
    }),
    MarkedBulletList,
    MarkedListItem,
    FencedCodeBlock,
    createMermaidDiagramExtension(onDiagramViewsChange),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    // Markdown puts images inside paragraphs.
    Image.configure({ inline: true }),
    ...createDetailsExtensions(),
    Markdown.configure({ markedOptions: { gfm: true } }),
  ];
}

const HEADING_LEVELS = {
  heading1: 1,
  heading2: 2,
  heading3: 3,
  heading4: 4,
  heading5: 5,
} as const;

function isActive(editor: Editor, name: FormatName): boolean {
  if (name in HEADING_LEVELS) {
    return editor.isActive("heading", {
      level: HEADING_LEVELS[name as keyof typeof HEADING_LEVELS],
    });
  }
  return editor.isActive(name);
}

function run(editor: Editor, command: FormatCommand): void {
  const chain = editor.chain().focus();
  switch (command) {
    case "paragraph":
      chain.setParagraph().run();
      return;
    case "heading1":
    case "heading2":
    case "heading3":
    case "heading4":
    case "heading5":
      chain.toggleHeading({ level: HEADING_LEVELS[command] }).run();
      return;
    case "bold":
      chain.toggleBold().run();
      return;
    case "italic":
      chain.toggleItalic().run();
      return;
    case "strike":
      chain.toggleStrike().run();
      return;
    case "bulletList":
      chain.toggleBulletList().run();
      return;
    case "orderedList":
      chain.toggleOrderedList().run();
      return;
    case "taskList":
      chain.toggleTaskList().run();
      return;
    case "blockquote":
      chain.toggleBlockquote().run();
      return;
    case "details":
      chain.insertDetails().run();
      return;
    // The link dialog and the image picker take input first; the format group opens them.
    case "link":
    case "image":
      return;
  }
}

export function createRichMarkdownEditor(input: {
  body: string;
  element: HTMLElement | null;
  onUpdate(): void;
  /** Where each Mermaid diagram block sits, whenever one is added or removed. */
  onDiagramViewsChange?: (views: readonly MermaidDiagramView[]) => void;
}): RichMarkdownEditor {
  const editor = new Editor({
    element: input.element,
    extensions: extensions(input.onDiagramViewsChange),
    content: input.body,
    contentType: "markdown",
    onUpdate: () => input.onUpdate(),
  });
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  editor.on("transaction", notify);
  return {
    get canUndo() {
      return editor.can().undo();
    },
    get canRedo() {
      return editor.can().redo();
    },
    undo: () => editor.commands.undo(),
    redo: () => editor.commands.redo(),
    isActive: (name) => isActive(editor, name),
    run: (command) => run(editor, command),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentLink: () =>
      editor.isActive("link") ? { href: String(editor.getAttributes("link")["href"] ?? "") } : null,
    setLink: (href) => {
      const chain = editor.chain().focus();
      if (editor.isActive("link")) chain.extendMarkRange("link").setLink({ href }).run();
      else if (editor.state.selection.empty) {
        chain
          .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
          .run();
      } else chain.setLink({ href }).run();
    },
    removeLink: () => {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    },
    insertImage: (relativePath) => {
      // `#`, `?` and spaces would split the URL, and parentheses can end the Markdown destination.
      const src = relativePath
        .split("/")
        .map((segment) =>
          encodeURIComponent(segment).replace(/[()]/g, (paren) => (paren === "(" ? "%28" : "%29")),
        )
        .join("/");
      editor.chain().focus().setImage({ src, alt: "" }).run();
    },
    serialize: () => editor.getMarkdown(),
    destroy: () => {
      listeners.clear();
      editor.off("transaction", notify);
      editor.destroy();
    },
  };
}
