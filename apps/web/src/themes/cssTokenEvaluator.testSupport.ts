// @effect-diagnostics nodeBuiltinImport:off - Test support reads the checked-in stylesheet.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

import { mix, parseColor, toHex, type Rgba } from "./themeColor";

/**
 * Test support: evaluates the token blocks of `index.css` as a browser would paint them, from
 * the stylesheet text and Tailwind's palette. happy-dom does not compute `color-mix()`, so the
 * tests compare the theme resolver against this independent reading of the CSS.
 */
const require = NodeModule.createRequire(import.meta.url);
const css = NodeFS.readFileSync(new URL("../index.css", import.meta.url), "utf8");
const tailwindTheme = NodeFS.readFileSync(require.resolve("tailwindcss/theme.css"), "utf8");

function declarations(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of text.matchAll(/^\s*(--[a-z0-9-]+):\s*([\s\S]*?);/gm)) {
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
    return toHex(formatRgba(evaluate(value)));
  };
}

function formatRgba(color: Rgba): string {
  return `rgb(${color.r} ${color.g} ${color.b} / ${color.a})`;
}

/** Every token declaration of a base block whose value refers to another token. */
export function derivedDeclarations(base: "light" | "dark"): string[] {
  const block = base === "light" ? lightBlock : new Map([...lightBlock, ...darkBlock]);
  return [...block]
    .filter(([, value]) => /var\(--(?!color-)/.test(value))
    .map(([name]) => name.slice(2));
}
