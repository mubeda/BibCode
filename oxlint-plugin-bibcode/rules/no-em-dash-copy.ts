import { defineRule, type Node } from "@oxlint/plugins";

const EM_DASH = "—";
const NON_COPY_FILE =
  /(?:\.test\.|\.spec\.|\.d\.ts$|\.gen\.|\/(?:fixtures?|__fixtures__|generated)\/)/u;
const COPY_SCOPE = /(?:^|\/)(?:apps|packages)\/[^/]+\/src\//u;
const EM_DASH_ENTITY = /&(?:mdash|#8212|#x2014);/iu;

const MESSAGE =
  "Do not use an em dash in interface copy. Use a comma, colon, period, or parentheses. A lone em dash is allowed only as an empty-value placeholder.";

// A string or expression-free template must be exactly one em dash to be the
// empty-value placeholder; only JSX text may carry layout whitespace around it.
const isPlaceholder = (text: string) => text === EM_DASH;

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
        const { type, value, raw } = child as unknown as {
          type: string;
          value?: unknown;
          raw?: unknown;
        };
        if (type !== "JSXText") continue;
        // `value` may be decoded or raw depending on the parser, so check both for entities.
        const text = typeof value === "string" ? value : "";
        const source = typeof raw === "string" ? raw : text;
        const hasDash = text.includes(EM_DASH) || EM_DASH_ENTITY.test(source);
        if (!hasDash) continue;
        if (!(alone && text.trim() === EM_DASH && !EM_DASH_ENTITY.test(source))) {
          context.report({ node: child, message: MESSAGE });
        }
      }
    };
    return {
      before() {
        const file = context.filename.replaceAll("\\", "/");
        return COPY_SCOPE.test(file) && !NON_COPY_FILE.test(file);
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
