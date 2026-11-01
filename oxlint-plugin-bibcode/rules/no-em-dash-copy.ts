import { defineRule, type Node } from "@oxlint/plugins";

const EM_DASH = "—";
const NON_COPY_FILE = /(?:\.test\.|\.spec\.|\.d\.ts$)/u;

const MESSAGE =
  "Do not use an em dash in interface copy. Use a comma, colon, period, or parentheses. A lone em dash is allowed only as an empty-value placeholder.";

// A string, JSX text, or expression-free template that is exactly one em dash
// is the empty-value placeholder.
const isPlaceholder = (text: string) => text.trim() === EM_DASH;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow em dashes in interface text; a lone em dash is allowed as an empty-value placeholder.",
    },
  },
  createOnce(context) {
    const reportJsxText = (children: ReadonlyArray<Node>) => {
      // Text next to other children is a separator, not a placeholder.
      const alone = children.length === 1;
      for (const child of children) {
        const { type, value: text } = child as unknown as { type: string; value?: unknown };
        if (type !== "JSXText" || typeof text !== "string" || !text.includes(EM_DASH)) {
          continue;
        }
        if (!(alone && isPlaceholder(text))) context.report({ node: child, message: MESSAGE });
      }
    };
    return {
      before() {
        return !NON_COPY_FILE.test(context.filename.replaceAll("\\", "/"));
      },
      Literal(node) {
        if (typeof node.value !== "string" || !node.value.includes(EM_DASH)) return;
        if (!isPlaceholder(node.value)) context.report({ node, message: MESSAGE });
      },
      // JSXText nodes are not dispatched to a JSXText visitor, so read them off their parent.
      JSXElement(node) {
        reportJsxText(node.children);
      },
      JSXFragment(node) {
        reportJsxText(node.children);
      },
      TemplateLiteral(node) {
        const soleQuasi = node.expressions.length === 0 && node.quasis.length === 1;
        for (const quasi of node.quasis) {
          const text = quasi.value.cooked ?? quasi.value.raw;
          if (!text.includes(EM_DASH)) continue;
          if (soleQuasi && isPlaceholder(text)) continue;
          context.report({ node: quasi, message: MESSAGE });
        }
      },
    };
  },
});
