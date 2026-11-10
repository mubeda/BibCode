import { useEffect, useRef, useState } from "react";

import type { FileEditingSession } from "../fileEditingSession";
import { canReconcile, reconcileMarkdown } from "./markdownReconcile";
import { splitFrontmatter } from "./markdownSupport";
import { createRichMarkdownEditor, type RichMarkdownEditor } from "./richMarkdownExtensions";
import "./richMarkdown.css";

const SERIALIZE_DELAY_MS = 300;

type RichEditingSession = Pick<
  FileEditingSession<unknown>,
  "changeFromRichEditor" | "setPendingEditFlusher" | "commitRichEdits" | "setComposing"
>;

export interface RichMarkdownSurfaceProps {
  readonly session: RichEditingSession;
  /** The text to open, read once: later changes come from this surface or remount it. */
  readonly contents: string;
  /**
   * The editor once it is ready, or null when the file cannot be edited block for block, with
   * the text it opened.
   */
  readonly onEditorChange: (editor: RichMarkdownEditor | null, opened: string) => void;
}

/**
 * The editable rendered view of a Markdown file. Edits reach the session 300 ms after the last
 * change, reconciled so untouched blocks keep the file's own bytes, with the frontmatter kept
 * verbatim and shown read-only above the editor.
 */
export default function RichMarkdownSurface({
  session,
  contents,
  onEditorChange,
}: RichMarkdownSurfaceProps) {
  const [opened] = useState(() => ({ source: contents, ...splitFrontmatter(contents) }));
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delivered = opened.source;
    let before = "";
    const deliver = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const body = reconcileMarkdown({ original: opened.body, before, after: editor.serialize() });
      const next = `${opened.frontmatter}${body}`;
      if (next === delivered) return;
      delivered = next;
      session.changeFromRichEditor(next);
    };
    const editor = createRichMarkdownEditor({
      body: opened.body,
      element,
      onUpdate: () => {
        if (timer === null) session.setPendingEditFlusher(deliver);
        else clearTimeout(timer);
        timer = setTimeout(() => {
          session.setPendingEditFlusher(null);
          deliver();
        }, SERIALIZE_DELAY_MS);
      },
    });
    before = editor.serialize();
    if (!canReconcile({ original: opened.body, before })) {
      // Saving would rewrite blocks the person did not touch; the panel shows the read-only view.
      editor.destroy();
      onEditorChange(null, opened.source);
      return;
    }
    const startComposing = () => session.setComposing(true);
    const endComposing = () => session.setComposing(false);
    element.addEventListener("compositionstart", startComposing);
    element.addEventListener("compositionend", endComposing);
    onEditorChange(editor, opened.source);
    return () => {
      element.removeEventListener("compositionstart", startComposing);
      element.removeEventListener("compositionend", endComposing);
      session.setComposing(false);
      if (timer !== null) {
        session.setPendingEditFlusher(null);
        deliver();
      }
      session.commitRichEdits();
      editor.destroy();
    };
  }, [onEditorChange, opened, session]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-5" data-text-surface>
      {opened.frontmatter ? (
        <div className="rich-markdown-frontmatter" data-rich-markdown-frontmatter>
          <p className="text-xs text-muted-foreground">Edit frontmatter in source view</p>
          <pre>{opened.frontmatter}</pre>
        </div>
      ) : null}
      <div ref={editorRef} className="chat-markdown rich-markdown-editor" />
    </div>
  );
}
