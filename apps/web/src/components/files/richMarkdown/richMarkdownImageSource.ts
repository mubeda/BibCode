import { parentRelativePath } from "../FileTreeContextMenu.logic";

/** Where an image in a Markdown file comes from. */
export type RichMarkdownImageSource =
  /** A URL the page loads as it is; the content security policy decides whether it may. */
  | { readonly kind: "url"; readonly url: string }
  /** A file in the workspace, as a workspace-relative path with `/` separators. */
  | { readonly kind: "workspace"; readonly path: string }
  /** Not loaded: another scheme, an absolute path, or a path that leaves the workspace. */
  | { readonly kind: "refused" };

const PASS_THROUGH_SCHEME = /^(?:https?|data|blob):/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolves an image's `src` against the folder of the Markdown file that holds it. File content
 * is untrusted: only plain relative paths that stay inside the workspace become workspace files.
 */
export function resolveRichMarkdownImageSource(
  markdownPath: string,
  src: string,
): RichMarkdownImageSource {
  if (PASS_THROUGH_SCHEME.test(src)) return { kind: "url", url: src };
  if (ANY_SCHEME.test(src) || src.startsWith("/") || src.includes("\\")) {
    return { kind: "refused" };
  }
  const pathPart = src.replace(/[?#].*$/s, "");
  const stack = parentRelativePath(markdownPath)
    .split("/")
    .filter((segment) => segment.length > 0);
  for (const raw of pathPart.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return { kind: "refused" };
    }
    // An encoded separator would hide a `..` from the walk below.
    if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      return { kind: "refused" };
    }
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return { kind: "refused" };
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length === 0 ? { kind: "refused" } : { kind: "workspace", path: stack.join("/") };
}
