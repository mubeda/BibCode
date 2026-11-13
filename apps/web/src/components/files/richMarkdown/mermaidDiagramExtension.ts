import { Node } from "@tiptap/core";

import { isClosedMermaidFence } from "../../markdown/mermaidFence";
import { createNodeViewSet } from "./nodeViewSet";

/** A diagram's place in the editor, where the surface draws it with chat's Mermaid block. */
export interface MermaidDiagramView {
  readonly id: number;
  readonly element: HTMLElement;
  /** The fence body, as the file holds it. */
  readonly source: string;
}

/** A fence one backtick longer than any backtick run in `code`, at least three. */
export function fencedCode(code: string, info: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${code}\n${fence}`;
}

/** The whole info string of a copied fence; its `language-` class keeps only the first word. */
export const FENCE_INFO_ATTRIBUTE = "data-fence-info";
const MERMAID_DIAGRAM_ATTRIBUTE = "data-mermaid-diagram";
const MERMAID_INFO = /^mermaid(?:\s|$)/;
let nextViewId = 0;

/**
 * A closed ```mermaid fence as one block the person selects, deletes or moves whole, never
 * edits: its source is edited in source view. It serializes exactly as a code block with the
 * same info string does, so the reconcile sees the same document and keeps the fence's bytes.
 * Only a fence chat would draw (closed, with a body) becomes one; others stay code blocks.
 */
export function createMermaidDiagramExtension(
  onViewsChange?: (views: readonly MermaidDiagramView[]) => void,
) {
  const views = createNodeViewSet(onViewsChange);
  return Node.create({
    onDestroy() {
      views.destroy();
    },
    name: "mermaidDiagram",
    group: "block",
    atom: true,
    selectable: true,
    draggable: false,
    // Ahead of the code block, whose Markdown handler would take the same `code` token.
    priority: 101,
    addAttributes() {
      return {
        source: { default: "", rendered: false },
        info: { default: "mermaid", rendered: false },
      };
    },
    // Cut and pasted, it comes back as this diagram with its source and whole info string.
    // Elsewhere it pastes as a Mermaid code block.
    renderHTML: ({ node }) => [
      "pre",
      { [MERMAID_DIAGRAM_ATTRIBUTE]: "", [FENCE_INFO_ATTRIBUTE]: node.attrs["info"] as string },
      ["code", { class: "language-mermaid" }, node.attrs["source"] as string],
    ],
    parseHTML: () => [
      {
        tag: `pre[${MERMAID_DIAGRAM_ATTRIBUTE}]`,
        // Ahead of the code block's `pre` rule.
        priority: 60,
        getAttrs: (element) => ({
          source: element.textContent,
          info: element.getAttribute(FENCE_INFO_ATTRIBUTE) ?? "mermaid",
        }),
      },
    ],
    renderText: ({ node }) =>
      fencedCode(node.attrs["source"] as string, node.attrs["info"] as string),
    markdownTokenName: "code",
    parseMarkdown: (token, helpers) => {
      const info = token.lang ?? "";
      const body = token.text ?? "";
      const slice = (token.raw ?? "").replace(/[\r\n]+$/, "");
      const closed = isClosedMermaidFence(
        slice,
        { start: { offset: 0 }, end: { offset: slice.length } },
        body,
        false,
      );
      if (!MERMAID_INFO.test(info) || !closed) return [];
      return helpers.createNode("mermaidDiagram", { source: body, info });
    },
    renderMarkdown: (node) =>
      fencedCode(node.attrs?.["source"] as string, node.attrs?.["info"] as string),
    addNodeView() {
      return ({ node }) => {
        const element = document.createElement("div");
        element.className = "rich-markdown-mermaid";
        element.setAttribute("contenteditable", "false");
        const view: MermaidDiagramView = {
          id: (nextViewId += 1),
          element,
          source: node.attrs["source"] as string,
        };
        views.add(view);
        return {
          dom: element,
          // A node with another source gets a new view, drawn for that source.
          update: (next) => next.type === node.type && next.attrs["source"] === view.source,
          // React owns everything inside.
          ignoreMutation: () => true,
          stopEvent: (event) =>
            event.target instanceof Element && event.target.closest("button") !== null,
          destroy: () => {
            views.delete(view);
          },
        };
      };
    },
  });
}
