// @vitest-environment jsdom
// DOMPurify, which every drawn diagram goes through, does not run under happy-dom.
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import type { Editor } from "@tiptap/core";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@pierre/diffs/edit", () => ({
  Editor: class {
    readonly cleanUp = vi.fn();
    readonly getFile = () => undefined;
  },
}));

import { writeThemePreference } from "../../../hooks/useTheme";
import {
  __resetMermaidDiagramsForTests,
  __setMermaidRendererLoaderForTests,
} from "../../markdown/MarkdownMermaidBlock";
import { FileEditingSession } from "../fileEditingSession";
import type { RichMarkdownEditor } from "./richMarkdownExtensions";
import RichMarkdownSurface from "./RichMarkdownSurface";

type MermaidRenderer = typeof import("../../markdown/mermaidRenderer");

const FLOWCHART = "graph TD\n  Write --> Draw";
// A tilde fence: the editor writes backticks, so only the reconcile keeps these bytes.
const FENCE = `~~~mermaid\n${FLOWCHART}\n~~~`;
const FILE = `# Diagram\n\nBefore the diagram.\n\n${FENCE}\n\nAfter the diagram.\n`;

let container: HTMLDivElement;
let root: Root;
let renderedSources: string[] = [];

async function countingRenderer(): Promise<MermaidRenderer> {
  const renderer = await import("../../markdown/mermaidRenderer");
  return {
    ...renderer,
    renderMermaidDiagram: (source, fonts, idPrefix) => {
      renderedSources.push(source);
      return renderer.renderMermaidDiagram(source, fonts, idPrefix);
    },
  };
}

function createSession(contents: string) {
  const session = new FileEditingSession<never>({
    cwd: "/repo",
    relativePath: "notes.md",
    debounceMs: 60_000,
    base: { version: "v1", contents },
    persist: vi.fn(async (path: string, saved: string) =>
      AsyncResult.success({ relativePath: path, version: `saved:${saved.length}` }),
    ),
    onPendingChange: vi.fn(),
    onConfirmed: vi.fn(),
  });
  vi.spyOn(session, "changeFromRichEditor");
  return session;
}

async function mount(session: FileEditingSession<never>, contents: string) {
  const onEditorChange = vi.fn<(editor: RichMarkdownEditor | null, opened: string) => void>();
  await act(async () => {
    root.render(
      <RichMarkdownSurface
        session={session}
        contents={contents}
        onEditorChange={onEditorChange}
        workspace={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          cwd: "/repo",
          markdownPath: "notes.md",
        }}
      />,
    );
  });
  const element = container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
  return { onEditorChange, tiptap: element.editor };
}

async function settle(ms = 0): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; !condition(); attempt += 1) {
    if (attempt > 400) throw new Error(message);
    await settle();
  }
}

/** Lets the 300 ms serialization deliver the last edit. */
const deliver = () => settle(350);

const svg = () => container.querySelector(".chat-markdown-mermaid svg");
const errorText = () => container.querySelector(".chat-markdown-mermaid-error")?.textContent;

/** Puts the caret at the end of the first text block that contains `marker`. */
function caretAfter(tiptap: Editor, marker: string): void {
  let position = -1;
  tiptap.state.doc.descendants((node, pos) => {
    if (position >= 0) return false;
    if (node.isTextblock && node.textContent.includes(marker)) {
      position = pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  expect(position, marker).toBeGreaterThan(0);
  act(() => {
    tiptap.commands.setTextSelection(position);
  });
}

function caretBefore(tiptap: Editor, marker: string): void {
  let position = -1;
  tiptap.state.doc.descendants((node, pos) => {
    if (position >= 0) return false;
    if (node.isTextblock && node.textContent.includes(marker)) {
      position = pos + 1;
      return false;
    }
    return true;
  });
  expect(position, marker).toBeGreaterThan(0);
  act(() => {
    tiptap.commands.setTextSelection(position);
  });
}

function type(tiptap: Editor, text: string): void {
  act(() => {
    tiptap.commands.insertContent(text);
  });
}

/**
 * Presses `key` through the editor's key handlers, as a real key press reaches them. TipTap's
 * `keyboardShortcut` command keeps only the steps of what the key did, not its selection.
 */
function press(tiptap: Editor, key: string): void {
  act(() => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    tiptap.view.someProp("handleKeyDown", (handle) => handle(tiptap.view, event));
  });
}

function selectDiagram(tiptap: Editor): void {
  let position = -1;
  tiptap.state.doc.descendants((node, pos) => {
    if (node.type.name === "mermaidDiagram") position = pos;
    return position < 0;
  });
  expect(position).toBeGreaterThanOrEqual(0);
  act(() => {
    tiptap.commands.setNodeSelection(position);
  });
}

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  // ProseMirror measures the selection to scroll it into view; jsdom has no layout.
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects ??= emptyRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

beforeEach(() => {
  __resetMermaidDiagramsForTests();
  __setMermaidRendererLoaderForTests(countingRenderer);
  renderedSources = [];
  writeThemePreference("light");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __setMermaidRendererLoaderForTests();
  vi.restoreAllMocks();
});

describe("Mermaid diagrams in the rendered Markdown editor", () => {
  it("draws a valid fence as the diagram, read-only, with its source in source view", async () => {
    const session = createSession(FILE);
    const { onEditorChange } = await mount(session, FILE);
    expect(onEditorChange.mock.lastCall![0]).not.toBeNull();

    await waitFor(() => svg() !== null, "the diagram never drew");
    const block = container.querySelector(".chat-markdown-codeblock")!;
    expect(block.closest("[contenteditable='false']")).not.toBeNull();
    expect(block.parentElement?.textContent).toContain("Edit the diagram in source view");
    expect(renderedSources).toEqual([FLOWCHART]);
  });

  it("shows an invalid fence's refusal as chat does", async () => {
    const invalid = "# Invalid\n\n```mermaid\ngraph TD\n  A --> B\n  B --> C]\n```\n";
    const session = createSession(invalid);
    await mount(session, invalid);

    await waitFor(() => errorText() != null, "no error was shown");
    expect(errorText()).toBe("Can't draw this diagram: line 3, Unrecognized text.");
    expect(container.querySelector(".chat-markdown-codeblock pre")?.textContent).toContain(
      "B --> C]",
    );
  });

  it("opening the file and leaving it untouched changes no byte", async () => {
    const session = createSession(FILE);
    const { onEditorChange } = await mount(session, FILE);
    await waitFor(() => svg() !== null, "the diagram never drew");
    await deliver();
    await act(async () => root.render(null));

    expect(onEditorChange.mock.calls[0]![0]).not.toBeNull();
    expect(session.changeFromRichEditor).not.toHaveBeenCalled();
    expect(session.getSnapshot().save.phase).toBe("clean");
  });

  it("typing before and after the diagram keeps the fence's bytes and its drawing", async () => {
    const session = createSession(FILE);
    const { tiptap } = await mount(session, FILE);
    await waitFor(() => svg() !== null, "the diagram never drew");
    const drawn = svg();

    caretAfter(tiptap, "Before the diagram.");
    type(tiptap, " Typed before.");
    caretBefore(tiptap, "After the diagram.");
    type(tiptap, "Typed after. ");
    await deliver();

    expect(session.unsavedContents).toBe(
      `# Diagram\n\nBefore the diagram. Typed before.\n\n${FENCE}\n\nTyped after. After the diagram.\n`,
    );
    // Typing elsewhere neither draws the diagram again nor replaces it.
    expect(svg()).toBe(drawn);
    expect(renderedSources).toEqual([FLOWCHART]);
  });

  it("Enter on a selected last-block diagram opens a paragraph after it", async () => {
    const last = `Intro.\n\n${FENCE}\n`;
    const session = createSession(last);
    const { tiptap } = await mount(session, last);

    selectDiagram(tiptap);
    press(tiptap, "Enter");
    type(tiptap, "Written after.");
    await deliver();

    expect(session.unsavedContents).toBe(`Intro.\n\n${FENCE}\n\nWritten after.\n`);
  });

  it("Delete removes a selected diagram and exactly its fence", async () => {
    const session = createSession(FILE);
    const { tiptap } = await mount(session, FILE);

    selectDiagram(tiptap);
    press(tiptap, "Delete");
    await deliver();

    expect(session.unsavedContents).toBe(
      "# Diagram\n\nBefore the diagram.\n\nAfter the diagram.\n",
    );
  });

  it("Backspace at the start of the next paragraph deletes exactly the fence, Undo restores it", async () => {
    const session = createSession(FILE);
    const { tiptap, onEditorChange } = await mount(session, FILE);
    const editor = onEditorChange.mock.lastCall![0]!;

    caretBefore(tiptap, "After the diagram.");
    // As before a horizontal rule: the block before the caret goes whole.
    press(tiptap, "Backspace");
    await deliver();
    expect(session.unsavedContents).toBe(
      "# Diagram\n\nBefore the diagram.\n\nAfter the diagram.\n",
    );
    expect(container.querySelector(".chat-markdown-codeblock")).toBeNull();

    act(() => editor.undo());
    await deliver();
    expect(session.changeFromRichEditor).toHaveBeenLastCalledWith(FILE);
    await waitFor(() => svg() !== null, "the restored diagram never drew");
  });

  it("a theme switch recolors the drawn diagram without drawing or replacing it", async () => {
    const session = createSession(FILE);
    await mount(session, FILE);
    await waitFor(() => svg() !== null, "the diagram never drew");
    const drawn = svg();
    const card = container.querySelector(".chat-markdown-codeblock");

    await act(async () => writeThemePreference("dark"));
    await settle();

    expect(container.querySelector(".chat-markdown-codeblock")).toBe(card);
    expect(svg()).toBe(drawn);
    expect(renderedSources).toEqual([FLOWCHART]);
  });
});
