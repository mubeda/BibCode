/**
 * Everything that draws a Mermaid diagram, loaded on the first closed Mermaid fence only: Pele
 * through its lazy entry (one chunk per diagram type, never the full bundle) and the SVG
 * sanitizer. A worker could take over `renderMermaidDiagram` later without touching the UI.
 */
import { detectType, load, PeleError, render, type RenderOptions } from "pele/lazy";

import { MERMAID_EDGE_LIMIT, MERMAID_SOURCE_LIMIT } from "./mermaidFence";
import { sanitizeDiagramSvg } from "./mermaidSanitizer";

/** A quarter of Pele's default: caps the DOM one block can add. */
const MERMAID_OUTPUT_LIMIT = 1_000_000;

export interface MermaidFonts {
  readonly fontFamily: string;
  readonly fontFamilyMono: string;
  readonly fontSize: number;
}

export interface MermaidDiagram {
  /** Sanitized SVG markup. */
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

/** Why a diagram cannot be drawn, without its source. */
export type MermaidDiagramProblem =
  | { readonly kind: "invalid"; readonly line: number; readonly detail: string }
  | { readonly kind: "unsupported" }
  | { readonly kind: "too-large"; readonly limit: "characters" | "edges" | "output" }
  | { readonly kind: "failed"; readonly code: string };

/**
 * The render options. The diagram keeps its authored direction (`autoDirection: false`, no
 * `maxWidth`), so its output does not depend on the container and is computed once per source
 * and font. Links, images, icons and math stay off; Mermaid themes are not applied.
 */
export function mermaidRenderOptions(fonts: MermaidFonts, idPrefix: string): RenderOptions {
  return {
    fontFamily: fonts.fontFamily,
    fontFamilyMono: fonts.fontFamilyMono,
    fontSize: fonts.fontSize,
    idPrefix,
    responsive: true,
    autoDirection: false,
    links: false,
    images: false,
    limit: MERMAID_SOURCE_LIMIT,
    maxEdges: MERMAID_EDGE_LIMIT,
    outputLimit: MERMAID_OUTPUT_LIMIT,
  };
}

/** Loads the chunk for the source's diagram type. A source Pele cannot classify loads none. */
export async function loadMermaidDiagramType(source: string): Promise<void> {
  let type: ReturnType<typeof detectType>;
  try {
    type = detectType(source);
  } catch {
    // Invalid front matter: drawing reports the same error.
    return;
  }
  await load(type);
}

/** Draws and sanitizes one diagram. Throws when it cannot be drawn. */
export function renderMermaidDiagram(
  source: string,
  fonts: MermaidFonts,
  idPrefix: string,
): MermaidDiagram {
  const result = render(source, mermaidRenderOptions(fonts, idPrefix));
  return { svg: sanitizeDiagramSvg(result.svg), width: result.width, height: result.height };
}

/** The first line of Pele's message that is not its location or source snippet. */
function problemDetail(error: PeleError): string {
  const snippetLines = new Set(error.snippet.split("\n").map((line) => line.trim()));
  const detail = error.message
    .split("\n")
    .map((line) => line.replace(/^(?:Parse|Lexical) error on line \d+[.:]?\s*/, "").trim())
    .filter((line) => line.length > 0 && !snippetLines.has(line))
    .join(" ");
  return detail || "the diagram is not valid";
}

/** Classifies a render failure. Only `failed` is unexpected; the others are about the source. */
export function describeMermaidProblem(error: unknown): MermaidDiagramProblem {
  if (!(error instanceof PeleError)) {
    return { kind: "failed", code: error instanceof Error ? error.name : "unknown" };
  }
  switch (error.code) {
    case "unsupported-diagram":
      return { kind: "unsupported" };
    case "limit":
      return {
        kind: "too-large",
        limit: error.message.startsWith("Edge limit")
          ? "edges"
          : error.message.startsWith("Diagram source")
            ? "characters"
            : "output",
      };
    case "syntax":
    case "semantic":
      return { kind: "invalid", line: error.line, detail: problemDetail(error) };
  }
  return { kind: "failed", code: `pele-${String(error.code)}` };
}
