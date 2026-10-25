import DOMPurify, { type DOMPurify as DOMPurifyInstance } from "dompurify";

/**
 * The trust boundary for Mermaid diagram SVG (#171). Diagram sources are untrusted (agent
 * output, pasted text, plan text, workspace Markdown files), and the SVG Pele draws from them
 * reaches the DOM outside the rehype-sanitize pass. Everything here is an allowlist, so the
 * boundary holds without relying on Pele's own filtering:
 *
 * - elements: the shapes, text and gradient elements Pele emits, so no `a`, `image`, `style`,
 *   `foreignObject`, `use` or animation element;
 * - attributes: geometry, presentation and ARIA attributes, so no `href`, `src`, event
 *   handler, `filter`, `mask`, `clip-path` or `marker-*`;
 * - CSS: DOMPurify does not parse CSS, so `style` keeps only allowlisted properties whose
 *   values use allowlisted functions (`var`, `rgb`, `rgba`, `hsl`, `hsla`), and no backslash
 *   escapes, comments, at-rules or braces. A blocklist of dangerous spellings would not hold:
 *   `image-set("/x" 1x)` loads a URL without the text `url(`, and `u\72l(` is `url(` once
 *   CSS unescapes it. Same-origin image loads pass both production CSPs, so these value rules
 *   carry the resource boundary;
 * - classes: only Pele's own `pele` and `pele-*` tokens, so app CSS cannot reach diagram nodes.
 */

const ALLOWED_TAGS = [
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "defs",
  "lineargradient",
  "stop",
];

/** Attributes whose value is a CSS value: checked as one. */
const CSS_VALUED_ATTRIBUTES = new Set([
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "opacity",
  "color",
  "stop-color",
  "stop-opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "baseline-shift",
  "letter-spacing",
  "word-spacing",
]);

/** Geometry attributes: numbers, lengths, path data and point lists only. */
const GEOMETRY_ATTRIBUTES = new Set([
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "dx",
  "dy",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "offset",
]);

/** Attributes that hold names or keywords and never a CSS value or a URL. */
const NAME_ATTRIBUTES = [
  "id",
  "role",
  "data-id",
  "data-icon",
  "gradientunits",
  "xml:space",
  "aria-roledescription",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-hidden",
];

const ALLOWED_ATTR = [
  ...CSS_VALUED_ATTRIBUTES,
  ...GEOMETRY_ATTRIBUTES,
  ...NAME_ATTRIBUTES,
  "transform",
  "class",
  "style",
  "xmlns",
];

/** The properties Pele writes into `style`, on its root element and from authored styles. */
const STYLE_PROPERTIES = new Set([
  ...CSS_VALUED_ATTRIBUTES,
  "max-width",
  "height",
  "font",
  "text-transform",
  "direction",
  "rx",
  "ry",
]);

const PELE_CUSTOM_PROPERTY = /^--_[a-z]{1,2}$/;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const FORBIDDEN_CSS_TEXT = /[\\<>{};@]|\/\*/;
const QUOTED_STRING = /"[^"';:]*"|'[^"';:]*'/g;
const ALLOWED_CSS_FUNCTIONS = new Set(["var", "rgb", "rgba", "hsl", "hsla"]);
const FUNCTION_CALL = /([A-Za-z-]*)\(/g;
const SAME_DOCUMENT_PAINT = /^url\(#[A-Za-z_][\w.:-]*\)$/;
const GEOMETRY_VALUE = /^[\d\s.,+\-eE%a-zA-Z]*$/;
const TRANSFORM_VALUE =
  /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[-+\d.eE]+(?:[\s,]+[-+\d.eE]+)*\s*\)\s*,?)*\s*$/;

/** True when a CSS value can name no resource, run no expression and escape no context. */
export function isSafeCssValue(value: string): boolean {
  if (FORBIDDEN_CSS_TEXT.test(value)) return false;
  // Quoted strings (font family names) may not hold quotes, `;` or `:`; an unbalanced quote
  // is refused with everything else.
  const unquoted = value.replace(QUOTED_STRING, "_");
  if (/["']/.test(unquoted)) return false;
  for (const match of unquoted.matchAll(FUNCTION_CALL)) {
    const name = match[1]!.toLowerCase();
    if (!ALLOWED_CSS_FUNCTIONS.has(name)) return false;
    if (name === "var" && !/^\s*--/.test(unquoted.slice(match.index + match[0].length))) {
      return false;
    }
  }
  return true;
}

function isSafePaint(property: string, value: string): boolean {
  return (
    isSafeCssValue(value) ||
    ((property === "fill" || property === "stroke") && SAME_DOCUMENT_PAINT.test(value.trim()))
  );
}

/** Rebuilds a style attribute from its allowed declarations; null when none remain. */
function cleanStyle(value: string, dropped: string[]): string | null {
  const kept: string[] = [];
  // Splitting on `;` is safe: an allowed quoted string cannot contain one.
  for (const declaration of value.split(";")) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(":");
    const property = colon > 0 ? declaration.slice(0, colon).trim().toLowerCase() : "";
    const propertyValue = colon > 0 ? declaration.slice(colon + 1).trim() : "";
    if (
      (STYLE_PROPERTIES.has(property) || PELE_CUSTOM_PROPERTY.test(property)) &&
      isSafePaint(property, propertyValue)
    ) {
      kept.push(`${property}:${propertyValue}`);
    } else {
      dropped.push(`style ${property || declaration.trim()}`);
    }
  }
  return kept.length > 0 ? kept.join(";") : null;
}

function cleanClass(value: string, dropped: string[]): string | null {
  const tokens = value.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((token) => token === "pele" || token.startsWith("pele-"));
  for (const token of tokens) if (!kept.includes(token)) dropped.push(`class ${token}`);
  return kept.length > 0 ? kept.join(" ") : null;
}

/** The checked value of an allowed attribute, or null to drop it. */
function cleanAttribute(name: string, value: string, dropped: string[]): string | null {
  if (name === "style") return cleanStyle(value, dropped);
  if (name === "class") return cleanClass(value, dropped);
  let safe = true;
  if (CSS_VALUED_ATTRIBUTES.has(name)) safe = isSafePaint(name, value);
  else if (GEOMETRY_ATTRIBUTES.has(name)) safe = GEOMETRY_VALUE.test(value);
  else if (name === "transform") safe = TRANSFORM_VALUE.test(value);
  else if (name === "xmlns") safe = value === SVG_NAMESPACE;
  if (!safe) dropped.push(`${name} value`);
  return safe ? value : null;
}

interface DiagramPurifier {
  readonly window: typeof window;
  readonly purifier: DOMPurifyInstance;
  /** Value-level drops of the sanitize call in progress. */
  dropped: string[];
}

let diagramPurifier: DiagramPurifier | null = null;

/** One dedicated instance per window, so its hook affects no other DOMPurify user. */
function purifierFor(currentWindow: typeof window): DiagramPurifier {
  if (diagramPurifier?.window === currentWindow) return diagramPurifier;
  const purifier = DOMPurify(currentWindow);
  // Unsupported, DOMPurify returns its input unchanged: never let that reach the DOM.
  if (!purifier.isSupported) throw new Error("The diagram sanitizer is unavailable.");
  const created: DiagramPurifier = { window: currentWindow, purifier, dropped: [] };
  created.purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    const value = cleanAttribute(data.attrName, data.attrValue, created.dropped);
    if (value === null) data.keepAttr = false;
    else data.attrValue = value;
  });
  diagramPurifier = created;
  return created;
}

export interface DiagramSanitizeReport {
  readonly svg: string;
  /** Elements and attributes DOMPurify removed, by name. */
  readonly removed: readonly string[];
  /** Attribute values, style declarations and class tokens the value rules dropped. */
  readonly dropped: readonly string[];
}

/** Sanitizes diagram SVG and reports what it took out (for tests and the corpus check). */
export function sanitizeDiagramSvgWithReport(svg: string): DiagramSanitizeReport {
  const instance = purifierFor(window);
  const dropped: string[] = [];
  instance.dropped = dropped;
  const clean = instance.purifier.sanitize(svg, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    RETURN_TRUSTED_TYPE: false,
  });
  const removed = instance.purifier.removed.flatMap((entry) => {
    if (!("element" in entry)) return [`attribute ${entry.attribute?.name ?? "?"}`];
    // The parse root is a body element outside the allowlist: DOMPurify sanitizes its children
    // in place, detaches it and serializes what it holds.
    if (entry.element.nodeName === "BODY") return [];
    return [`element ${entry.element.nodeName.toLowerCase()}`];
  });
  return { svg: clean, removed, dropped };
}

/** Sanitizes diagram SVG for insertion into the page. */
export function sanitizeDiagramSvg(svg: string): string {
  return sanitizeDiagramSvgWithReport(svg).svg;
}
