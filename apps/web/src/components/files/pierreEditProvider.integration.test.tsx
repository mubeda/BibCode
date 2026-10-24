// @vitest-environment happy-dom

import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, File, useCreateEditor } from "@pierre/diffs/react";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FileEditingSession } from "./fileEditingSession";

const editorOptions: EditorOptions<unknown> = { persistState: true };
const testTheme = "task-7-editor-integration";

registerCustomCSSVariableTheme(testTheme, {
  background: "#ffffff",
  foreground: "#000000",
});

function EditorFactoryProbe({ options }: { readonly options: EditorOptions<unknown> }) {
  const createEditor = useCreateEditor();
  const first = createEditor?.(options);
  const second = createEditor?.(options);

  return <output data-reuses-editor={String(first === second)} />;
}

function EditableFile({ show }: { readonly show: boolean }) {
  if (!show) return null;

  return (
    <File
      edit
      editorOptions={editorOptions}
      file={{ name: "src/session.ts", contents: "original\n", cacheKey: "session-file" }}
      options={{ theme: testTheme }}
    />
  );
}

describe("Pierre stable edit integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let canvasGetContext: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    canvasGetContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    canvasGetContext.mockRestore();
  });

  it("caches a stable editor factory and preserves the editable document across File remount", async () => {
    const editors: Editor<unknown>[] = [];
    const createEditor = vi.fn((options: EditorOptions<unknown>) => {
      const editor = new Editor(options);
      editors.push(editor);
      return editor;
    });
    const edit = vi.spyOn(Editor.prototype, "edit");
    const cleanUp = vi.spyOn(Editor.prototype, "cleanUp");

    const render = async (show: boolean) => {
      await act(async () => {
        root.render(
          <EditProvider createEditor={createEditor}>
            <EditorFactoryProbe options={editorOptions} />
            <EditableFile show={show} />
          </EditProvider>,
        );
      });
    };

    try {
      await render(true);

      expect(
        container.querySelector("diffs-container")?.shadowRoot?.querySelector("[contenteditable]"),
      ).not.toBeNull();
      expect(container.querySelector("output")?.dataset.reusesEditor).toBe("true");
      expect(createEditor).toHaveBeenCalledOnce();
      expect(edit).toHaveBeenCalledOnce();

      const editor = editors[0]!;
      editor.setSelections([
        {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
          direction: "none",
        },
      ]);
      editor.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "edited ",
        },
      ]);
      expect(editor.getText()).toBe("edited original\n");
      expect(editor.canUndo).toBe(true);

      await render(false);
      expect(cleanUp).toHaveBeenCalledWith();

      await render(true);
      expect(createEditor).toHaveBeenCalledOnce();
      expect(edit).toHaveBeenCalledTimes(2);
      expect(editor.getText()).toBe("edited original\n");
      editor.undo();
      expect(editor.getText()).toBe("original\n");
    } finally {
      edit.mockRestore();
      cleanUp.mockRestore();
    }
  });

  describe("undo boundary (patched Editor.applyEdits)", () => {
    const renderEditor = async (options: EditorOptions<unknown>): Promise<Editor<unknown>> => {
      let created: Editor<unknown> | null = null;
      const createEditor = () => {
        created ??= new Editor({ ...editorOptions, ...options });
        return created;
      };
      await act(async () => {
        root.render(
          <EditProvider createEditor={createEditor}>
            <EditableFile show />
          </EditProvider>,
        );
      });
      if (created === null) throw new Error("EditProvider did not create an editor");
      const editor: Editor<unknown> = created;
      editor.setSelections([
        {
          start: { line: 0, character: 8 },
          end: { line: 0, character: 8 },
          direction: "none",
        },
      ]);
      return editor;
    };

    const insertAt = (character: number, newText: string) => [
      {
        range: {
          start: { line: 0, character },
          end: { line: 0, character },
        },
        newText,
      },
    ];

    it("keeps a boundary edit out of the typing before it", async () => {
      const onChange = vi.fn();
      const editor = await renderEditor({ onChange });

      editor.applyEdits(insertAt(8, "a"));
      onChange.mockClear();
      editor.applyEdits(insertAt(9, "b"), true, true);
      // onChange runs synchronously inside the boundary call, before it returns.
      expect(onChange).toHaveBeenCalledOnce();

      expect(editor.getText()).toBe("originalab\n");
      editor.undo();
      expect(editor.getText()).toBe("originala\n");
    });

    it("keeps typing after a boundary edit out of it", async () => {
      const editor = await renderEditor({});

      editor.applyEdits(insertAt(8, "a"), true, true);
      editor.applyEdits(insertAt(9, "b"));

      expect(editor.getText()).toBe("originalab\n");
      editor.undo();
      expect(editor.getText()).toBe("originala\n");
      editor.undo();
      expect(editor.getText()).toBe("original\n");
    });

    it("still merges adjacent edits without the boundary", async () => {
      const editor = await renderEditor({});

      editor.applyEdits(insertAt(8, "a"));
      editor.applyEdits(insertAt(9, "b"));

      expect(editor.getText()).toBe("originalab\n");
      editor.undo();
      expect(editor.getText()).toBe("original\n");
    });
  });

  describe("open-file disk reload through FileEditingSession", () => {
    const createSession = (contents: string) => {
      const persist = vi.fn(async (_path: string, saved: string) =>
        AsyncResult.success({ relativePath: "src/session.ts", version: `saved:${saved}` }),
      );
      const session = new FileEditingSession<unknown>({
        cwd: "/repo",
        relativePath: "src/session.ts",
        debounceMs: 500,
        base: { version: "v1", contents },
        persist,
        onPendingChange: vi.fn(),
        onConfirmed: vi.fn(),
      });
      return { session, persist };
    };

    const renderSession = async (session: FileEditingSession<unknown>, contents: string) => {
      await act(async () => {
        root.render(
          <EditProvider createEditor={() => session.editor}>
            <File
              edit
              file={{ name: session.relativePath, contents, cacheKey: session.cacheKey }}
              options={{ theme: testTheme }}
            />
          </EditProvider>,
        );
      });
      const editor = session.editor;
      if (editor.getFile() === undefined) throw new Error("the session editor did not attach");
      return editor;
    };

    const caretAt = (editor: Editor<unknown>, line: number, character: number) => {
      editor.setSelections([
        { start: { line, character }, end: { line, character }, direction: "none" },
      ]);
    };

    const reconcile = (session: FileEditingSession<unknown>, version: string, contents: string) => {
      const token = session.beginDiskCheck();
      if (token === null) throw new Error("no disk check may run");
      expect(session.reconcileVersion(token, { _tag: "present", version })).toBe("read");
      session.reconcileRead(token, { version, contents });
    };

    it("reloads a clean editor in place, and Undo restores the old text as unsaved", async () => {
      const before = "one\ntwo words\nthree\n";
      const { session, persist } = createSession(before);
      const editor = await renderSession(session, before);
      caretAt(editor, 1, 2);

      reconcile(session, "v2", "one\ntwo changed words\nthree\n");

      expect(editor.getText()).toBe("one\ntwo changed words\nthree\n");
      // The caret sat on the changed line, before the change: it stays where it was.
      expect(editor.getState().selections?.[0]?.start).toEqual({ line: 1, character: 2 });
      expect(session.getSnapshot()).toMatchObject({ save: { phase: "clean" }, conflict: null });
      expect(session.unsavedContents).toBeNull();

      session.undo();
      expect(editor.getText()).toBe(before);
      expect(session.getSnapshot().save.phase).toBe("pending");
      expect(session.unsavedContents).toBe(before);
      expect(persist).not.toHaveBeenCalled();
    });

    it("keeps a caret on a changed line in place when the reload also inserts a line", async () => {
      const before = "foo = 1;\nbar = 2;\n";
      const { session } = createSession(before);
      const editor = await renderSession(session, before);
      caretAt(editor, 1, 1);

      reconcile(session, "v2", "foo = 10;\nnew line\nbar = 20;\n");

      expect(editor.getText()).toBe("foo = 10;\nnew line\nbar = 20;\n");
      // Still between "b" and "ar", now one line down.
      expect(editor.getState().selections?.[0]?.start).toEqual({ line: 2, character: 1 });
      session.undo();
      expect(editor.getText()).toBe(before);
    });

    it("never changes an edited editor, and Reload from disk then Undo gives back only the edits", async () => {
      const { session, persist } = createSession("abc");
      const editor = await renderSession(session, "abc");
      caretAt(editor, 0, 3);
      // The user deletes "c" with Backspace.
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
          newText: "",
        },
      ]);

      reconcile(session, "v2", "");
      expect(editor.getText()).toBe("ab");
      expect(session.getSnapshot().conflict).toMatchObject({ reason: "changed", diskKnown: true });
      await expect(session.flush()).resolves.toBe("failed");

      session.reloadFromDisk();
      expect(editor.getText()).toBe("");
      expect(session.getSnapshot()).toMatchObject({ save: { phase: "clean" }, conflict: null });

      // One Undo removes the reload alone; the user's own delete of "c" stays.
      session.undo();
      expect(editor.getText()).toBe("ab");
      expect(session.unsavedContents).toBe("ab");
      expect(persist).not.toHaveBeenCalled();
    });
  });
});
