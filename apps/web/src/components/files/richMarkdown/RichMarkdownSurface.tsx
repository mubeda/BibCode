import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { FileEditingSession } from "../fileEditingSession";
import { canReconcile, detectDominantEol, reconcileMarkdown } from "./markdownReconcile";
import { splitFrontmatter } from "./markdownSupport";
import type { MermaidDiagramView } from "./mermaidDiagramExtension";
import { RichMarkdownMermaid } from "./RichMarkdownMermaid";
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
  // Changes only when a diagram block is added or removed, never on typing.
  const [diagrams, setDiagrams] = useState<readonly MermaidDiagramView[]>([]);

  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // True from an edit until it is delivered, so an edit whose delivery threw stays unsaved.
    let waiting = false;
    let delivered = opened.source;
    let before = "";
    const send = (next: string) => {
      waiting = false;
      session.setPendingEditFlusher(null);
      if (next === delivered) return;
      delivered = next;
      session.changeFromRichEditor(next);
    };
    // `whole` is the last resort when the reconcile throws: the editor's whole serialization,
    // with the body's line ending and final-newline state, rather than a lost edit.
    const deliver = (whole = false) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (whole) {
        const eol = detectDominantEol(opened.body);
        const text = editor.serialize().trim().replaceAll("\n", eol);
        send(`${opened.frontmatter}${text}${opened.body.slice(opened.body.trimEnd().length)}`);
        return;
      }
      const body = reconcileMarkdown({ original: opened.body, before, after: editor.serialize() });
      send(`${opened.frontmatter}${body}`);
    };
    const editor = createRichMarkdownEditor({
      body: opened.body,
      element,
      onUpdate: () => {
        if (!waiting) session.setPendingEditFlusher(deliver);
        waiting = true;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => deliver(), SERIALIZE_DELAY_MS);
      },
      onDiagramViewsChange: setDiagrams,
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
      if (waiting) {
        try {
          deliver();
        } catch (error) {
          console.error("[rich-markdown] reconciling the last edit failed", error);
          deliver(true);
        }
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
      {/* ChatMarkdown's root classes: the diagram fonts are measured once per page from here. */}
      <div
        ref={editorRef}
        className="chat-markdown rich-markdown-editor text-sm leading-relaxed text-foreground/80"
      />
      {diagrams.map((view) =>
        createPortal(<RichMarkdownMermaid source={view.source} />, view.element, String(view.id)),
      )}
    </div>
  );
}
