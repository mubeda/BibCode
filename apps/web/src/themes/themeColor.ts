import type { ThemeFile } from "@bibcode/contracts";

import { BASE_TOKEN_VALUES, DERIVED_DEFAULTS } from "./baseTokenValues";

/** Channels 0 to 255 (unrounded), alpha 0 to 1. */
export type Rgba = { r: number; g: number; b: number; a: number };

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const ARG = String.raw`${NUMBER}(?:%|deg)?`;
const MODERN = new RegExp(
  String.raw`^(rgba?|hsla?|oklch)\(\s*(${ARG})\s+(${ARG})\s+(${ARG})(?:\s*\/\s*(${ARG}))?\s*\)$`,
  "i",
);
const LEGACY = new RegExp(
  String.raw`^(rgba?|hsla?)\(\s*(${ARG})\s*,\s*(${ARG})\s*,\s*(${ARG})(?:\s*,\s*(${ARG}))?\s*\)$`,
  "i",
);
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function number(arg: string): number {
  return Number.parseFloat(arg);
}

function alphaOf(arg: string | undefined): number | null {
  if (arg === undefined) return 1;
  if (arg.endsWith("deg")) return null;
  return clamp(arg.endsWith("%") ? number(arg) / 100 : number(arg), 0, 1);
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0) * 255, channel(8) * 255, channel(4) * 255];
}

function oklchToRgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  // shortcut: out-of-gamut channels are clipped, not chroma-reduced; upgrade if a theme shows a visible difference from the browser.
  return linear.map((value) => {
    const clipped = clamp(value, 0, 1);
    const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
    return encoded * 255;
  }) as [number, number, number];
}

/** Parses a hex color, `rgb()`, `hsl()` or `oklch()` (plan decision P16); anything else is null. */
export function parseColor(value: string): Rgba | null {
  const text = value.trim();
  if (HEX.test(text)) {
    let digits = text.slice(1);
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join("");
    const byte = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
  }
  const match = MODERN.exec(text) ?? LEGACY.exec(text);
  if (!match) return null;
  const [, name, first, second, third, alphaArg] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string | undefined,
  ];
  const a = alphaOf(alphaArg);
  if (a === null) return null;
  const kind = name.toLowerCase();
  if (kind.startsWith("rgb")) {
    if ([first, second, third].some((arg) => arg.endsWith("deg"))) return null;
    const channel = (arg: string) =>
      clamp(arg.endsWith("%") ? number(arg) * 2.55 : number(arg), 0, 255);
    return { r: channel(first), g: channel(second), b: channel(third), a };
  }
  if (kind.startsWith("hsl")) {
    if (second.endsWith("deg") || third.endsWith("deg")) return null;
    const hue = ((number(first) % 360) + 360) % 360;
    const [r, g, b] = hslToRgb(
      hue,
      clamp(number(second) / 100, 0, 1),
      clamp(number(third) / 100, 0, 1),
    );
    return { r, g, b, a };
  }
  if (first.endsWith("deg") || second.endsWith("deg")) return null;
  const lightness = first.endsWith("%") ? number(first) / 100 : number(first);
  const chroma = second.endsWith("%") ? (number(second) / 100) * 0.4 : number(second);
  const [r, g, b] = oklchToRgb(clamp(lightness, 0, 1), Math.max(0, chroma), number(third));
  return { r, g, b, a };
}

function formatHex(color: Rgba): string {
  const byte = (value: number) =>
    Math.round(clamp(value, 0, 255))
      .toString(16)
      .padStart(2, "0");
  const alpha = Math.round(clamp(color.a, 0, 1) * 255);
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${alpha === 255 ? "" : byte(alpha)}`;
}

/** `#rrggbb`, or `#rrggbbaa` when the color is not opaque. Throws on a value that is not a color. */
export function toHex(value: string): string {
  const color = parseColor(value);
  if (!color) throw new Error(`Not a theme color: ${value}`);
  return formatHex(color);
}

/** CSS `color-mix(in srgb, a p%, b)`, premultiplied by alpha. */
export function mix(a: Rgba, b: Rgba, percentOfA: number): Rgba {
  const weightA = percentOfA / 100;
  const weightB = 1 - weightA;
  const alpha = a.a * weightA + b.a * weightB;
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (key: "r" | "g" | "b") =>
    (a[key] * a.a * weightA + b[key] * b.a * weightB) / alpha;
  return { r: channel("r"), g: channel("g"), b: channel("b"), a: alpha };
}

/** `mix` on color strings, returned as hex. */
export function mixHex(a: string, b: string, percentOfA: number): string {
  return formatHex(mix(parseOrThrow(a), parseOrThrow(b), percentOfA));
}

function parseOrThrow(value: string): Rgba {
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const color = parseColor(value);
  if (!color) throw new Error(`Not a theme color: ${value}`);
  return color;
}

/** `top` painted over `bottom` (made opaque first), as opaque hex. */
export function compositeHex(top: string, bottom: string): string {
  return formatHex(over(parseOrThrow(top), over(parseOrThrow(bottom), WHITE)));
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

function over(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function luminance(color: Rgba): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/**
 * WCAG contrast of `text` on `surface`. A translucent surface is composited over `behind`
 * (white when absent) and a translucent text over the resulting surface.
 */
export function contrastRatio(text: string, surface: string, behind?: string): number {
  const backdrop =
    behind === undefined
      ? { r: 255, g: 255, b: 255, a: 1 }
      : over(parseOrThrow(behind), { r: 255, g: 255, b: 255, a: 1 });
  const paintedSurface = over(parseOrThrow(surface), backdrop);
  const paintedText = over(parseOrThrow(text), paintedSurface);
  const [light, dark] = [luminance(paintedText), luminance(paintedSurface)].toSorted(
    (x, y) => y - x,
  );
  return (light! + 0.05) / (dark! + 0.05);
}

export type FixedPair = { text: string; surface: string; label: string };

/** The pairs every theme is checked against (spec, Fixed pairs), in the spec's order. */
export const FIXED_PAIRS: readonly FixedPair[] = [
  { text: "foreground", surface: "background", label: "Text on background" },
  { text: "card-foreground", surface: "card", label: "Card text on card" },
  { text: "popover-foreground", surface: "popover", label: "Menu text on menu" },
  { text: "primary-foreground", surface: "primary", label: "Primary label on primary" },
  { text: "secondary-foreground", surface: "secondary", label: "Secondary text on secondary" },
  { text: "accent-foreground", surface: "accent", label: "Accent text on accent" },
  { text: "muted-foreground", surface: "background", label: "Muted text on background" },
  { text: "muted-foreground", surface: "card", label: "Muted text on card" },
  { text: "muted-foreground", surface: "accent", label: "Muted text on accent" },
  { text: "selected-foreground", surface: "selected", label: "Selected text on selected" },
  { text: "placeholder", surface: "background", label: "Placeholder on background" },
  { text: "find-match-foreground", surface: "find-match", label: "Find match text on find match" },
  {
    text: "find-match-active-foreground",
    surface: "find-match-active",
    label: "Active find match text on active find match",
  },
  {
    text: "terminal.foreground",
    surface: "terminal.background",
    label: "Terminal text on terminal background",
  },
];

/**
 * The value `token` paints under `theme`: the theme's own value, else the base's formula for a
 * derived token evaluated against the theme, else the base value. Terminal tokens are written
 * `terminal.<name>`.
 */
export function resolveToken(theme: ThemeFile, token: string): string {
  if (token.startsWith("terminal.")) {
    const own = theme.terminal?.[token.slice("terminal.".length) as keyof typeof theme.terminal];
    return own === undefined ? baseValue(theme, token) : toHex(own);
  }
  const own = theme.ui?.[token as keyof typeof theme.ui];
  if (own !== undefined) return toHex(own);
  const formula = DERIVED_DEFAULTS[theme.base][token];
  return formula ? formula((source) => resolveToken(theme, source)) : baseValue(theme, token);
}

function baseValue(theme: ThemeFile, token: string): string {
  const value = BASE_TOKEN_VALUES[theme.base][token];
  if (value === undefined) throw new Error(`No base value for ${token}`);
  return value;
}

/** Every fixed pair with its ratio under `theme`, in the spec's order. */
export function pairRatios(theme: ThemeFile): { pair: FixedPair; ratio: number }[] {
  return FIXED_PAIRS.map((pair) => {
    const behind = pair.surface.startsWith("terminal.") ? "terminal.background" : "background";
    const ratio = contrastRatio(
      resolveToken(theme, pair.text),
      resolveToken(theme, pair.surface),
      resolveToken(theme, behind),
    );
    return { pair, ratio };
  });
}

export function failingPairs(
  theme: ThemeFile,
  minimum: number,
): { pair: FixedPair; ratio: number }[] {
  return pairRatios(theme).filter(({ ratio }) => ratio < minimum);
}
