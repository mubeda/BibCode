// @vitest-environment happy-dom

import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, File, useCreateEditor } from "@pierre/diffs/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
});
