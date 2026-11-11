// @effect-diagnostics nodeBuiltinImport:off - Test support reads the checked-in stylesheet.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

import { UI_COLOR_TOKENS } from "@bibcode/contracts";

import { mix, parseColor, toHex, type Rgba } from "./themeColor";

/**
 * Test support: evaluates the token blocks of `index.css` as a browser would paint them, from
 * the stylesheet text and Tailwind's palette. happy-dom does not compute `color-mix()`, so the
 * tests compare the theme resolver against this independent reading of the CSS.
 */
const require = NodeModule.createRequire(import.meta.url);
const css = NodeFS.readFileSync(new URL("../index.css", import.meta.url), "utf8");
const tailwindTheme = NodeFS.readFileSync(require.resolve("tailwindcss/theme.css"), "utf8");

function declarations(text: string, names = /--[a-z0-9-]+/): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = new RegExp(String.raw`^\s*(${names.source}):\s*([\s\S]*?);`, "gm");
  for (const match of text.matchAll(pattern)) {
    result.set(
      match[1]!,
      match[2]!.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim(),
    );
  }
  return result;
}

function between(startMarker: string, endMarker: string): string {
  const start = css.indexOf(startMarker);
  return css.slice(start, css.indexOf(endMarker, start + startMarker.length));
}

const palette = declarations(tailwindTheme);
const lightBlock = declarations(between(":root {\n  color-scheme: light;", "@variant dark {"));
const darkBlock = declarations(between("@variant dark {", "\n}\n"));
const themeInline = declarations(between("@theme inline {", "@keyframes"));

/** Splits `a, b, c` at top-level commas. */
function topLevelArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  args.push(current.trim());
  return args;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

export function evaluateCssTokens(
  base: "light" | "dark",
  overrides: Record<string, string> = {},
): (token: string) => string {
  const evaluate = evaluateCssTokensUnrounded(base, overrides);
  return (token: string) => toHex(formatRgba(evaluate(token)));
}

/** `evaluateCssTokens` before the final rounding to hex. */
export function evaluateCssTokensUnrounded(
  base: "light" | "dark",
  overrides: Record<string, string> = {},
): (token: string) => Rgba {
  const scope = new Map([...lightBlock, ...(base === "dark" ? darkBlock : [])]);
  for (const [name, value] of themeInline) {
    if (name.startsWith("--color-") && !scope.has(name)) scope.set(name, value);
  }
  for (const [token, value] of Object.entries(overrides)) scope.set(`--${token}`, value);

  function evaluate(expression: string): Rgba {
    const text = expression.trim();
    if (text === "transparent") return TRANSPARENT;
    const variable = /^var\((--[a-z0-9-]+)(?:,\s*([\s\S]+))?\)$/.exec(text);
    if (variable) {
      const value = scope.get(variable[1]!) ?? palette.get(variable[1]!);
      if (value !== undefined) return evaluate(value);
      if (variable[2] !== undefined) return evaluate(variable[2]);
      throw new Error(`Undefined variable ${variable[1]}`);
    }
    const alpha = /^--alpha\(([\s\S]+?)\s*\/\s*([\d.]+)%\)$/.exec(text);
    if (alpha) return mix(evaluate(alpha[1]!), TRANSPARENT, Number(alpha[2]));
    const colorMix = /^color-mix\(in [a-z]+,\s*([\s\S]+)\)$/.exec(text);
    if (colorMix) {
      const [first, second] = topLevelArgs(colorMix[1]!);
      const firstPercent = /\s([\d.]+)%$/.exec(first!);
      const secondPercent = /\s([\d.]+)%$/.exec(second!);
      const firstColor = first!.replace(/\s[\d.]+%$/, "");
      const secondColor = second!.replace(/\s[\d.]+%$/, "");
      const percent = firstPercent
        ? Number(firstPercent[1])
        : 100 - Number(secondPercent?.[1] ?? 50);
      return mix(evaluate(firstColor), evaluate(secondColor), percent);
    }
    const parsed = parseColor(text.replace(/\bnone\b/g, "0"));
    if (!parsed) throw new Error(`Cannot evaluate ${text}`);
    return parsed;
  }

  return (token: string) => {
    const value = scope.get(`--${token}`) ?? scope.get(`--color-${token}`);
    if (value === undefined) throw new Error(`index.css defines no --${token}`);
    return evaluate(value);
  };
}

function formatRgba(color: Rgba): string {
  return `rgb(${color.r} ${color.g} ${color.b} / ${color.a})`;
}

/** Every token declaration of a base block whose value refers to another token. */
export function derivedDeclarations(base: "light" | "dark"): string[] {
  const block = base === "light" ? lightBlock : new Map([...lightBlock, ...darkBlock]);
  return (
    [...block]
      .filter(([, value]) => /var\(--(?!color-)/.test(value))
      .map(([name]) => name.slice(2))
      // Variables outside the token set, such as the scrollbar ones, are not theme tokens.
      .filter((name) => (UI_COLOR_TOKENS as readonly string[]).includes(name))
  );
}

const normalizeSelector = (selector: string) =>
  selector.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

/**
 * The declarations, custom properties included, of every `index.css` rule for `selector`, a
 * later rule's value replacing an earlier one's (the unlayered rules follow the layered ones).
 */
export function ruleDeclarations(selector: string): Map<string, string> {
  const wanted = normalizeSelector(selector);
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const result = new Map<string, string>();
  for (const match of uncommented.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    if (normalizeSelector(match[1]!) !== wanted) continue;
    for (const entry of declarations(match[2]!, /(?:--)?[a-z][a-z0-9-]*/)) result.set(...entry);
  }
  if (result.size === 0) throw new Error(`index.css has no rule ${selector}`);
  return result;
}
