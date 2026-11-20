import { registerCustomCSSVariableTheme } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, File } from "@pierre/diffs/react";
import type { Editor as TipTapEditor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createRichMarkdownEditor,
  type RichMarkdownEditor,
} from "./richMarkdown/richMarkdownExtensions";

export type ChordPlatform = "mac" | "windows" | "linux";

type Chord = "undo" | "redo" | "ctrl+y";

function chordEvent(chord: Chord, mac: boolean): KeyboardEvent {
  const letter = chord === "ctrl+y" ? "y" : "z";
  const shift = chord === "redo";
  return new KeyboardEvent("keydown", {
    key: shift ? letter.toUpperCase() : letter,
    code: `Key${letter.toUpperCase()}`,
    keyCode: letter.toUpperCase().charCodeAt(0),
    metaKey: mac && chord !== "ctrl+y",
    ctrlKey: !mac || chord === "ctrl+y",
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
}

/** Dispatches the chord at `target` and returns whether a handler cancelled it. */
function press(target: EventTarget, chord: Chord, mac: boolean): boolean {
  const event = chordEvent(chord, mac);
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

const theme = "file-undo-chords";
registerCustomCSSVariableTheme(theme, { background: "#ffffff", foreground: "#000000" });

/**
 * The Files undo chords against the real source editor (Pierre) and rendered editor (TipTap),
 * dispatched where a browser delivers them. `platform` must match `navigator.platform` as the
 * editor modules saw it when they loaded.
 */
export function defineFileUndoChordSuite(platform: ChordPlatform): void {
  const mac = platform === "mac";

  describe(`source view chords on ${platform}`, () => {
    let container: HTMLDivElement;
    let root: Root;
    let getContext: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
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
      getContext.mockRestore();
    });

    async function openSource(): Promise<{ editor: Editor<unknown>; content: HTMLElement }> {
      let created: Editor<unknown> | null = null;
      const options: EditorOptions<unknown> = { persistState: true };
      await act(async () => {
        root.render(
          <EditProvider createEditor={() => (created ??= new Editor(options))}>
            <File
              edit
              editorOptions={options}
              file={{ name: "notes.txt", contents: "Hello\n", cacheKey: "notes" }}
              options={{ theme }}
            />
          </EditProvider>,
        );
      });
      const content = container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector<HTMLElement>("[contenteditable]");
      if (!created || !content) throw new Error("The source editor did not mount.");
      return { editor: created, content };
    }

    function typeAtEnd(editor: Editor<unknown>, text: string): void {
      const character = editor.getText().indexOf("\n");
      const at = { line: 0, character };
      editor.setSelections([{ start: at, end: at, direction: "none" }]);
      editor.applyEdits([{ range: { start: at, end: at }, newText: text }], true, true);
    }

    it("undoes one typed step, and the toolbar's state follows", async () => {
      const { editor, content } = await openSource();
      typeAtEnd(editor, " world");

      expect(press(content, "undo", mac)).toBe(true);

      expect(editor.getText()).toBe("Hello\n");
      expect({ canUndo: editor.canUndo, canRedo: editor.canRedo }).toEqual({
        canUndo: false,
        canRedo: true,
      });
    });

    it("redoes the undone step", async () => {
      const { editor, content } = await openSource();
      typeAtEnd(editor, " world");
      press(content, "undo", mac);

      expect(press(content, "redo", mac)).toBe(true);

      expect(editor.getText()).toBe("Hello world\n");
      expect(editor.canRedo).toBe(false);
    });

    it("changes nothing with nothing to undo, and still claims the chord", async () => {
      const { editor, content } = await openSource();

      expect(press(content, "undo", mac)).toBe(true);

      expect(editor.getText()).toBe("Hello\n");
    });

    it(mac ? "leaves Ctrl+Y alone" : "redoes with Ctrl+Y", async () => {
      const { editor, content } = await openSource();
      typeAtEnd(editor, " world");
      press(content, "undo", mac);

      press(content, "ctrl+y", mac);

      expect(editor.getText()).toBe(mac ? "Hello\n" : "Hello world\n");
    });

    it("leaves the file's history alone for a chord in the inline comment field", async () => {
      const { editor } = await openSource();
      typeAtEnd(editor, " world");
      const comment = document.createElement("textarea");
      container.append(comment);

      press(comment, "undo", mac);

      expect(editor.getText()).toBe("Hello world\n");
    });
  });

  describe(`rendered view chords on ${platform}`, () => {
    const editors: RichMarkdownEditor[] = [];

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(0);
    });

    afterEach(() => {
      for (const editor of editors.splice(0)) editor.destroy();
      vi.useRealTimers();
      document.body.replaceChildren();
    });

    function openRendered(): {
      editor: RichMarkdownEditor;
      view: HTMLElement;
      tiptap: TipTapEditor;
    } {
      const element = document.createElement("div");
      document.body.append(element);
      const editor = createRichMarkdownEditor({ body: "Hello\n", element, onUpdate: () => {} });
      editors.push(editor);
      const view = element.querySelector<HTMLElement & { editor: TipTapEditor }>(".ProseMirror");
      if (!view) throw new Error("The rendered editor did not mount.");
      return { editor, view, tiptap: view.editor };
    }

    /** Two typed steps, past the history's grouping delay so they stay two steps. */
    function typeTwoSteps(tiptap: TipTapEditor): void {
      tiptap.chain().setTextSelection(6).insertContent(" one").run();
      vi.setSystemTime(1_000);
      tiptap.chain().setTextSelection(10).insertContent(" two").run();
    }

    it("needs two undo steps for two edits made apart", () => {
      const { editor, tiptap } = openRendered();
      typeTwoSteps(tiptap);

      editor.undo();
      expect(editor.serialize()).toBe("Hello one");
      editor.undo();
      expect(editor.serialize()).toBe("Hello");
    });

    it("loses exactly one step per undo chord, and the redo chord restores it", () => {
      const { editor, view, tiptap } = openRendered();
      typeTwoSteps(tiptap);

      expect(press(view, "undo", mac)).toBe(true);
      expect(editor.serialize()).toBe("Hello one");
      expect(editor.canUndo).toBe(true);

      expect(press(view, "redo", mac)).toBe(true);
      expect(editor.serialize()).toBe("Hello one two");
    });

    it("undoes and redoes a formatting step", () => {
      const { editor, view, tiptap } = openRendered();
      tiptap.chain().setTextSelection({ from: 1, to: 6 }).run();
      editor.run("bold");
      expect(editor.serialize()).toBe("**Hello**");

      press(view, "undo", mac);
      expect(editor.serialize()).toBe("Hello");
      press(view, "redo", mac);
      expect(editor.serialize()).toBe("**Hello**");
    });

    it(mac ? "leaves Ctrl+Y alone" : "redoes with Ctrl+Y", () => {
      const { editor, view, tiptap } = openRendered();
      typeTwoSteps(tiptap);
      press(view, "undo", mac);

      press(view, "ctrl+y", mac);

      expect(editor.serialize()).toBe(mac ? "Hello one" : "Hello one two");
    });
  });
}
