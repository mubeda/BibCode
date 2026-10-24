import type { DiffsHighlighter } from "@pierre/diffs";
import { toHtml } from "hast-util-to-html";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { cloneElement, isValidElement, memo, type DOMAttributes } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

type HighlightedRoot = ReturnType<DiffsHighlighter["codeToHast"]>;
type HighlightedNode = HighlightedRoot["children"][number];

const runtime = { Fragment, jsx, jsxs };

function elementShell(node: Extract<HighlightedNode, { type: "element" }>) {
  const element = toJsxRuntime({ ...node, children: [] }, runtime);
  if (!isValidElement<DOMAttributes<HTMLElement>>(element)) {
    throw new Error("Expected a highlighted code element");
  }
  return element;
}

const HighlightedLine = memo(function HighlightedLine({ node }: { node: HighlightedNode }) {
  if (node.type !== "element") return toJsxRuntime(node, runtime);
  return cloneElement(elementShell(node), {
    dangerouslySetInnerHTML: { __html: toHtml({ type: "root", children: node.children }) },
  });
});

/**
 * Renders Shiki's highlighted tree with one memoized element per line. The incremental
 * highlighter keeps a completed line's node, so that line's DOM stays mounted: replacing the
 * whole block would make the browser parse and style every unchanged token span on each delta.
 */
export function HighlightedCodeLines({ root }: { root: HighlightedRoot }) {
  const pre = root.children[0];
  if (pre?.type !== "element" || pre.tagName !== "pre") return toJsxRuntime(root, runtime);
  const code = pre.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return toJsxRuntime(root, runtime);
  return cloneElement(
    elementShell(pre),
    undefined,
    cloneElement(
      elementShell(code),
      undefined,
      code.children.map((node, index) => (
        // A line keeps its position as tokens and lines are appended.
        // oxlint-disable-next-line react/no-array-index-key
        <HighlightedLine key={index} node={node} />
      )),
    ),
  );
}
