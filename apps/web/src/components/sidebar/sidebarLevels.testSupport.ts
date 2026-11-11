/** Tailwind `text-*` utilities that set a size, alignment or wrapping rather than a colour. */
const NON_COLOR_TEXT =
  /^text-(?:xs|sm|base|lg|[2-9]?xl|\[\d+(?:\.\d+)?(?:px|rem|em)\]|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;

/**
 * The colour utilities in `className`, with any variant prefix (`hover:`, `dark:`). A level label
 * or chat element must have none, or it outranks the level rules of `index.css` (R63).
 */
export function textColorUtilities(className: string): string[] {
  return className.split(/\s+/).filter((token) => {
    const utility = token.slice(token.lastIndexOf(":") + 1);
    return utility.startsWith("text-") && !NON_COLOR_TEXT.test(utility);
  });
}

/** Every opening tag in `markup` that a label or chat level rule paints. */
export function levelTextTags(markup: string): string[] {
  return (
    markup.match(/<[a-z]+\b[^>]*(?:data-sidebar-label|data-sidebar-level="chat")[^>]*>/g) ?? []
  );
}

/** The class attribute of an opening tag. */
export const classOf = (tag: string) => /\bclass="([^"]*)"/.exec(tag)?.[1] ?? "";
