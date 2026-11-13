import {
  findUnsupportedConstruct,
  splitFrontmatter,
  type UnsupportedConstruct,
} from "./richMarkdown/markdownSupport";

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

/** Larger files stay read-only: each rendered edit reparses the whole file (R34). */
const RICH_MARKDOWN_MAX_BYTES = 128 * 1024;

/** Whether the rendered view of `path` may be edited, and why not when it may not (R34). */
export function richMarkdownMode(
  path: string,
  source: string,
):
  | { editable: true }
  | { editable: false; reason: UnsupportedConstruct | "mdx" | "not-markdown" | "too-large" } {
  if (!isMarkdownPreviewFile(path)) return { editable: false, reason: "not-markdown" };
  if (/\.mdx$/i.test(path)) return { editable: false, reason: "mdx" };
  if (new TextEncoder().encode(source).length > RICH_MARKDOWN_MAX_BYTES) {
    return { editable: false, reason: "too-large" };
  }
  const reason = findUnsupportedConstruct(splitFrontmatter(source).body);
  return reason === null ? { editable: true } : { editable: false, reason };
}

/**
 * How the Files panel shows a file, chosen from its extension before any text read. The server's
 * asset route serves exactly these types (images, SVG as an image, PDF, audio); anything else is
 * read as text, and a binary one explains itself.
 */
export type FilePreviewKind = "text" | "image" | "svg" | "pdf" | "audio";

const MEDIA_PREVIEW_KINDS: ReadonlyMap<string, Exclude<FilePreviewKind, "text">> = new Map([
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "ico"].map((ext) => [ext, "image"] as const),
  ["svg", "svg"],
  ["pdf", "pdf"],
  ...["mp3", "m4a", "wav", "ogg", "oga", "webm", "flac"].map((ext) => [ext, "audio"] as const),
]);

const FILE_EXTENSION_PATTERN = /\.([^./\\]+)$/;

export function filePreviewKind(path: string): FilePreviewKind {
  const extension = FILE_EXTENSION_PATTERN.exec(path)?.[1]?.toLowerCase();
  return (extension && MEDIA_PREVIEW_KINDS.get(extension)) || "text";
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
