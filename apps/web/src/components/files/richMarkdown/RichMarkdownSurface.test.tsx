// @vitest-environment happy-dom

import type { Editor } from "@tiptap/core";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@pierre/diffs/edit", () => ({
  Editor: class {
    readonly cleanUp = vi.fn();
    readonly getFile = () => undefined;
  },
}));

const reconcile = vi.hoisted(() => ({ fail: false }));

vi.mock("./markdownReconcile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markdownReconcile")>();
  return {
    ...actual,
    reconcileMarkdown: (input: Parameters<typeof actual.reconcileMarkdown>[0]) => {
      if (reconcile.fail) throw new Error("reconcile failed");
      return actual.reconcileMarkdown(input);
    },
  };
});

import { FileEditingSession } from "../fileEditingSession";
import { FileEditingSessionRegistry } from "../fileEditingSessionRegistry";
import type { RichMarkdownEditor } from "./richMarkdownExtensions";
import RichMarkdownSurface from "./RichMarkdownSurface";

let container: HTMLDivElement;
let root: Root;

function createSession(contents: string, relativePath = "notes.md") {
  const persist = vi.fn(async (path: string, saved: string) =>
    AsyncResult.success({ relativePath: path, version: `saved:${saved.length}` }),
  );
  const session = new FileEditingSession<never>({
    cwd: "/repo",
    relativePath,
    debounceMs: 500,
    base: { version: "v1", contents },
    persist,
    onPendingChange: vi.fn(),
    onConfirmed: vi.fn(),
  });
  vi.spyOn(session, "changeFromRichEditor");
  return { session, persist };
}

async function mount(session: FileEditingSession<never>, contents: string) {
  const onEditorChange = vi.fn<(editor: RichMarkdownEditor | null, opened: string) => void>();
  await act(async () => {
    root.render(
      <RichMarkdownSurface session={session} contents={contents} onEditorChange={onEditorChange} />,
    );
  });
  const element = container.querySelector(".ProseMirror") as
    | (HTMLElement & { editor: Editor })
    | null;
  return { onEditorChange, tiptap: element?.editor ?? null };
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
  expect(position, marker).toBeGreaterThan(0);
  act(() => {
    tiptap.chain().setTextSelection(position).insertContent(text).run();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  reconcile.fail = false;
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("RichMarkdownSurface", () => {
  it("typing in a paragraph updates the session text", async () => {
    const { session } = createSession("Hello world\n");
    const { tiptap } = await mount(session, "Hello world\n");

    typeAfter(tiptap!, "Hello world", " again");
    await act(async () => vi.advanceTimersByTime(300));

    expect(session.unsavedContents).toBe("Hello world again\n");
    expect(session.getSnapshot().save.phase).toBe("pending");
  });

  it("opening a file does not mark it changed", async () => {
    const original = "Title\n=====\n\n* one\n* two\n";
    const { session } = createSession(original);
    const { onEditorChange } = await mount(session, original);
    await act(async () => vi.advanceTimersByTime(1_000));
    await act(async () => root.render(null));

    expect(onEditorChange).toHaveBeenCalledWith(
      expect.objectContaining({ canUndo: false }),
      original,
    );
    expect(session.changeFromRichEditor).not.toHaveBeenCalled();
    expect(session.getSnapshot().save.phase).toBe("clean");
  });

  it("frontmatter is shown read-only and kept on edit", async () => {
    const source = "---\ntitle:   Spaced\n---\nBody text.\n";
    const { session } = createSession(source);
    const { tiptap } = await mount(session, source);

    const block = container.querySelector("[data-rich-markdown-frontmatter]");
    expect(block?.textContent).toContain("Edit frontmatter in source view");
    expect(block?.textContent).toContain("title:   Spaced");
    expect(block?.closest("[contenteditable='true']")).toBeNull();
    expect(tiptap!.getText()).not.toContain("Spaced");

    typeAfter(tiptap!, "Body text.", " More.");
    await act(async () => vi.advanceTimersByTime(300));

    expect(session.unsavedContents).toBe("---\ntitle:   Spaced\n---\nBody text. More.\n");
  });

  it("undo and redo reverse a rich edit", async () => {
    const { session } = createSession("Text\n");
    const { tiptap, onEditorChange } = await mount(session, "Text\n");
    const editor = onEditorChange.mock.lastCall![0]!;

    typeAfter(tiptap!, "Text", "!");
    expect(editor.canUndo).toBe(true);
    act(() => editor.undo());
    expect(editor.serialize()).toBe("Text");
    act(() => editor.redo());
    expect(editor.serialize()).toBe("Text!");
  });

  it("typing works in a list item, a block quote and a table cell", async () => {
    const original = "* item\n\n> quoted\n\n| a | b |\n|---|---|\n| cell | 2 |\n";
    const { session } = createSession(original);
    const { tiptap } = await mount(session, original);

    typeAfter(tiptap!, "item", " one");
    typeAfter(tiptap!, "quoted", " two");
    typeAfter(tiptap!, "cell", " three");
    await act(async () => vi.advanceTimersByTime(300));

    const saved = session.unsavedContents!;
    expect(saved).toContain("* item one\n");
    expect(saved).toContain("> quoted two\n");
    expect(saved).toMatch(/\| cell three \|\s*2\s*\|/);
    expect(saved).toContain("| a | b |\n|---|---|\n");
  });

  it("rapid typing serializes once after 300 ms", async () => {
    const { session } = createSession("Fast\n");
    const { tiptap } = await mount(session, "Fast\n");

    for (const letter of ["a", "b", "c"]) {
      typeAfter(tiptap!, "Fast", letter);
      await act(async () => vi.advanceTimersByTime(100));
    }
    expect(session.changeFromRichEditor).not.toHaveBeenCalled();
    expect(session.getSnapshot().editPending).toBe(true);
    await act(async () => vi.advanceTimersByTime(300));

    expect(session.changeFromRichEditor).toHaveBeenCalledOnce();
    expect(session.changeFromRichEditor).toHaveBeenCalledWith("Fastabc\n");
    expect(session.getSnapshot().editPending).toBe(false);
  });

  it.each([
    ["Save", (session: FileEditingSession<never>) => void session.flush()],
    ["a view switch", (session: FileEditingSession<never>) => session.commitRichEdits()],
    [
      "a file switch",
      (session: FileEditingSession<never>) => {
        const registry = new FileEditingSessionRegistry<FileEditingSession<never>>();
        registry.getOrCreate("notes.md", () => session);
        registry.setActivePath("notes.md");
        registry.setActivePath("other.md");
      },
    ],
    ["a rename", (session: FileEditingSession<never>) => session.rename("renamed.md")],
  ])("%s delivers a pending edit without advancing the clock", async (_name, operation) => {
    const { session } = createSession("Pending\n");
    const { tiptap } = await mount(session, "Pending\n");
    typeAfter(tiptap!, "Pending", " edit");

    act(() => operation(session));

    expect(session.changeFromRichEditor).toHaveBeenCalledWith("Pending edit\n");
    expect(session.documentContents).toBe("Pending edit\n");
  });

  it("a disk change during the 300 ms wait shows the conflict choice and loses neither version", async () => {
    const { session } = createSession("Mine\n");
    const { tiptap } = await mount(session, "Mine\n");
    typeAfter(tiptap!, "Mine", " edited");

    const token = session.beginDiskCheck();
    expect(token).not.toBeNull();
    expect(session.reconcileVersion(token!, { _tag: "present", version: "v2" })).toBe("read");
    session.reconcileRead(token!, { version: "v2", contents: "Theirs\n" });

    expect(session.getSnapshot().conflict).toMatchObject({ reason: "changed", diskKnown: true });
    expect(session.documentContents).toBe("Mine edited\n");
    act(() => session.reloadFromDisk());
    expect(session.documentContents).toBe("Theirs\n");
  });

  it("an edit typed while a disk check is out makes a newer disk version a conflict", async () => {
    const { session, persist } = createSession("Mine\n");
    const { tiptap } = await mount(session, "Mine\n");
    const token = session.beginDiskCheck()!;

    typeAfter(tiptap!, "Mine", " edited");
    expect(session.reconcileVersion(token, { _tag: "present", version: "v2" })).toBe("read");
    session.reconcileRead(token, { version: "v2", contents: "Theirs\n" });
    await act(async () => vi.advanceTimersByTime(300));
    await act(async () => root.render(null));
    await act(async () => session.flush());

    expect(session.getSnapshot().conflict).toMatchObject({ reason: "changed" });
    expect(session.documentContents).toBe("Mine edited\n");
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ["an entity", "Copyright &copy; 2026.\n"],
    ["a link around an image", "See [![logo](logo.png)](https://example.test) here.\n"],
  ])("a file with %s opens without an editor", async (_name, original) => {
    const { session } = createSession(original);
    const { onEditorChange } = await mount(session, original);

    expect(onEditorChange).toHaveBeenCalledExactlyOnceWith(null, original);
  });

  it("an edit after an empty details block reaches the session and survives leaving", async () => {
    const original = "<details><summary>More</summary></details>\n\nHello\n";
    const { session } = createSession(original);
    const { tiptap, onEditorChange } = await mount(session, original);
    expect(onEditorChange.mock.lastCall![0]).not.toBeNull();

    typeAfter(tiptap!, "Hello", " world");
    await act(async () => vi.advanceTimersByTime(300));
    await act(async () => root.render(null));

    expect(session.unsavedContents).toBe(
      "<details><summary>More</summary></details>\n\nHello world\n",
    );
  });

  it("an edit the reconcile throws on stays pending and visible", async () => {
    const { session } = createSession("Hello\n");
    const { tiptap } = await mount(session, "Hello\n");
    reconcile.fail = true;

    typeAfter(tiptap!, "Hello", " world");
    await act(async () => {
      expect(() => vi.advanceTimersByTime(300)).toThrow("reconcile failed");
    });

    expect(session.getSnapshot().editPending).toBe(true);
  });

  it("an edit whose delivery fails is still saved after Save, a fix and leaving the file", async () => {
    const { session, persist } = createSession("Hello\n");
    const { tiptap } = await mount(session, "Hello\n");
    reconcile.fail = true;
    typeAfter(tiptap!, "Hello", " world");
    await act(async () => {
      expect(() => vi.advanceTimersByTime(300)).toThrow("reconcile failed");
    });

    await act(async () => {
      await expect(session.flush()).resolves.toBe("failed");
    });
    expect(session.getSnapshot().editPending).toBe(true);
    reconcile.fail = false;
    await act(async () => root.render(null));
    await act(async () => void (await session.flush()));

    expect(persist.mock.lastCall?.[1]).toBe("Hello world\n");
  });

  it("leaving the file while the reconcile still throws keeps the editor's text", async () => {
    const source = "---\r\na: 1\r\n---\r\nOne\r\n\r\nHello\r\n";
    const { session } = createSession(source);
    const { tiptap } = await mount(session, source);
    reconcile.fail = true;
    typeAfter(tiptap!, "Hello", " world");

    await act(async () => root.render(null));

    expect(session.unsavedContents).toBe("---\r\na: 1\r\n---\r\nOne\r\n\r\nHello world\r\n");
    expect(session.getSnapshot().editPending).toBe(false);
  });

  it("Reload and Overwrite change nothing while a waiting edit cannot be delivered", async () => {
    const { session, persist } = createSession("Mine\n");
    const { tiptap } = await mount(session, "Mine\n");
    typeAfter(tiptap!, "Mine", " edited");
    const token = session.beginDiskCheck()!;
    session.reconcileVersion(token, { _tag: "present", version: "v2" });
    session.reconcileRead(token, { version: "v2", contents: "Theirs\n" });
    reconcile.fail = true;
    typeAfter(tiptap!, "Mine edited", " more");

    act(() => session.reloadFromDisk());
    act(() => session.overwriteDisk());

    expect(session.getSnapshot().conflict).toMatchObject({ reason: "changed" });
    expect(session.documentContents).toBe("Mine edited\n");
    expect(session.getSnapshot().editPending).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("a disk check while delivery fails applies no result and keeps the edit", async () => {
    const { session } = createSession("Mine\n");
    const { tiptap } = await mount(session, "Mine\n");
    const token = session.beginDiskCheck()!;
    reconcile.fail = true;
    typeAfter(tiptap!, "Mine", " edited");

    expect(session.reconcileVersion(token, { _tag: "present", version: "v2" })).toBe("stale");
    session.reconcileRead(token, { version: "v2", contents: "Theirs\n" });
    expect(session.beginDiskCheck()).toBeNull();
    reconcile.fail = false;
    await act(async () => root.render(null));

    expect(session.documentContents).toBe("Mine edited\n");
    expect(session.getSnapshot().save.phase).toBe("pending");
  });
});
