/**
 * What `ChatMarkdown` and Find in thread both use to turn chat Markdown into the text a reader
 * sees: the plugin lists, the sanitize schema, the URL transform, the file-link chip label and
 * the skill-token splitter. A change here reaches the renderer and the find projection at once,
 * so the two keep counting the same text.
 */
import type { Element, Root as HastRoot } from "hast";
import type { Root as MdastRoot } from "mdast";
import type { ServerProviderSkill } from "@bibcode/contracts";
import { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import {
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  type MarkdownFileLinkMeta,
} from "../markdown-links";
import { formatProviderSkillDisplayName } from "../providerSkillPresentation";

export type { MarkdownFileLinkMeta };

export const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

/** Keeps a fence's meta (`ts title="x.ts"`) on the rendered `code` element. */
export function remarkPreserveCodeMeta() {
  return (tree: MdastRoot) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree as MarkdownAstNode);
  };
}

/** The hast property that holds a `<details>` block's ordinal within its document. */
export const DETAILS_ORDINAL_PROPERTY = "dataDetailsOrdinal";

/**
 * Numbers each `<details>` element in document order, after sanitizing so the number cannot be
 * forged. The renderer and the find projection read the same number, which is how find opens
 * the block that holds a match.
 */
export function rehypeNumberDetails() {
  return (tree: HastRoot) => {
    let ordinal = 0;
    const visit = (node: HastRoot | Element) => {
      for (const child of node.children) {
        if (child.type !== "element") continue;
        if (child.tagName === "details") {
          child.properties[DETAILS_ORDINAL_PROPERTY] = ordinal;
          ordinal += 1;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

/** A `<details>` element's ordinal, as numbered by `rehypeNumberDetails`. */
export function readDetailsOrdinal(node: Pick<Element, "properties"> | undefined): number | null {
  const value = node?.properties?.[DETAILS_ORDINAL_PROPERTY];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkPreserveCodeMeta];
const REMARK_PLUGINS_WITH_BREAKS: PluggableList = [remarkGfm, remarkBreaks, remarkPreserveCodeMeta];

/** The remark plugins, in order; `lineBreaks` treats single newlines as hard breaks. */
export function chatMarkdownRemarkPlugins(lineBreaks: boolean): PluggableList {
  return lineBreaks ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS;
}

export const CHAT_MARKDOWN_REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
  rehypeNumberDetails,
];

export function chatMarkdownUrlTransform(href: string): string {
  return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

export function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
}

/** The file links a message's source names, by normalized href. */
export function buildMarkdownFileLinkMetaByHref(
  text: string,
  cwd: string | undefined,
): Map<string, MarkdownFileLinkMeta> {
  const metaByHref = new Map<string, MarkdownFileLinkMeta>();
  for (const href of extractMarkdownLinkHrefs(text)) {
    const normalizedHref = normalizeMarkdownLinkHrefKey(href);
    if (metaByHref.has(normalizedHref)) continue;
    const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);
    if (meta) {
      metaByHref.set(normalizedHref, meta);
    }
  }
  return metaByHref;
}

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

/** The parent suffix that tells apart files with the same basename in one message. */
export function buildFileLinkParentSuffixByPath(
  filePaths: ReadonlyArray<string>,
): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const pathSegments = filePath
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

/** A message's file links and the parent suffixes their chip labels need. */
export interface MarkdownFileLinks {
  readonly metaByHref: ReadonlyMap<string, MarkdownFileLinkMeta>;
  readonly parentSuffixByPath: ReadonlyMap<string, string>;
}

export function buildMarkdownFileLinks(text: string, cwd: string | undefined): MarkdownFileLinks {
  const metaByHref = buildMarkdownFileLinkMetaByHref(text, cwd);
  const parentSuffixByPath = buildFileLinkParentSuffixByPath(
    [...metaByHref.values()].map((meta) => meta.filePath),
  );
  return { metaByHref, parentSuffixByPath };
}

/** A file link's chip label: the basename, the parent suffix when needed, and the line. */
export function markdownFileLinkLabel(
  meta: MarkdownFileLinkMeta,
  parentSuffixByPath: ReadonlyMap<string, string>,
): string {
  const parentSuffix = parentSuffixByPath.get(meta.filePath);
  const labelParts = [meta.basename];
  if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
    labelParts.push(parentSuffix);
  }
  if (meta.line) {
    labelParts.push(`L${meta.line}${meta.column ? `:C${meta.column}` : ""}`);
  }
  return labelParts.join(" · ");
}

export function resolveExternalLinkHost(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

/** The element's text when every child is a text node, otherwise null. */
export function plainHastText(node: unknown): string | null {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return null;
  }
  const parts = node.children.map((child) => {
    if (
      child &&
      typeof child === "object" &&
      "type" in child &&
      child.type === "text" &&
      "value" in child &&
      typeof child.value === "string"
    ) {
      return child.value;
    }
    return null;
  });
  return parts.every((part) => part !== null) ? parts.join("") : null;
}

/**
 * How a link renders: a file chip with its own label, an external link that shows its plain text
 * after a favicon, or ordinary link content.
 */
export type ChatMarkdownLinkKind =
  | { readonly kind: "file"; readonly meta: MarkdownFileLinkMeta; readonly normalizedHref: string }
  | { readonly kind: "external"; readonly host: string; readonly plainText: string | null }
  | { readonly kind: "plain" };

export function classifyChatMarkdownLink(
  href: string | undefined,
  node: unknown,
  fileLinkMetaByHref: ReadonlyMap<string, MarkdownFileLinkMeta>,
): ChatMarkdownLinkKind {
  const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
  const meta = normalizedHref ? fileLinkMetaByHref.get(normalizedHref) : undefined;
  if (meta) {
    return { kind: "file", meta, normalizedHref };
  }
  const host = resolveExternalLinkHost(href);
  if (host) {
    return { kind: "external", host, plainText: plainHastText(node) };
  }
  return { kind: "plain" };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

export type SkillTextSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "skill";
      readonly skill: InlineSkill;
      readonly rawText: string;
      readonly start: number;
    };

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

/** Splits text at `$skill` tokens that name a known skill. */
export function splitSkillTokens(
  text: string,
  skills: ReadonlyArray<InlineSkill>,
): ReadonlyArray<SkillTextSegment> {
  if (skills.length === 0 || !text.includes("$")) {
    return [{ kind: "text", text }];
  }
  const segments: SkillTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const rawText = `$${name}`;
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) {
      continue;
    }
    if (start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, start) });
    }
    segments.push({ kind: "skill", skill, rawText, start });
    cursor = start + rawText.length;
  }
  if (cursor === 0) {
    return [{ kind: "text", text }];
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

/** A skill chip's label. */
export function skillChipLabel(skill: InlineSkill): string {
  return formatProviderSkillDisplayName(skill);
}
