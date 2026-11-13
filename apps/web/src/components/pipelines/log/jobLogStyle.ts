import type { CSSProperties } from "react";
import {
  TERMINAL_ANSI_COLOR_NAMES,
  terminalAnsiColors,
  terminalExtendedAnsiPalette,
  isBuiltinTerminalPalette,
  type TerminalPalette,
  type TerminalThemeMode,
} from "../../terminalTheme";
import {
  FLAG_BOLD,
  FLAG_CONCEAL,
  FLAG_DIM,
  FLAG_INVERSE,
  FLAG_ITALIC,
  FLAG_STRIKE,
  FLAG_UNDERLINE,
  type LogStyle,
} from "./jobLog.parse";

export interface LogPalette {
  /** `--log-ansi-0` … `--log-ansi-15`, set on the log's root. */
  readonly variables: CSSProperties;
  /** Colors 16-255, drawn inline. */
  readonly extended: readonly string[];
}

const palettes = new Map<string, LogPalette>();

/**
 * The terminal's palette, as the log root's variables and the 256-color table. A built-in
 * palette keeps the mode's own values; a theme's palette is cached by its key, so a saved edit
 * to a theme with the same id is not served from the cache.
 */
export function logPalette(source: TerminalThemeMode | TerminalPalette): LogPalette {
  const named =
    typeof source !== "string" && isBuiltinTerminalPalette(source) ? source.mode : source;
  const mode = typeof named === "string" ? named : named.mode;
  const cacheKey = typeof named === "string" ? named : named.key;
  const known = palettes.get(cacheKey);
  if (known) return known;
  const ansi = terminalAnsiColors(named);
  const variables: Record<string, string> = {};
  for (const [index, name] of TERMINAL_ANSI_COLOR_NAMES.entries())
    variables[`--log-ansi-${index}`] = ansi[name];
  const palette = {
    variables: variables as CSSProperties,
    extended: terminalExtendedAnsiPalette(mode),
  };
  palettes.set(cacheKey, palette);
  return palette;
}

function color(index: number, palette: LogPalette): string | undefined {
  if (index < 0) return undefined;
  return index < 16 ? `var(--log-ansi-${index})` : palette.extended[index - 16];
}

/** A span's class and inline style; host text is never markup, only these. */
export function spanPresentation(
  style: LogStyle,
  palette: LogPalette,
): { readonly className: string | undefined; readonly style: CSSProperties | undefined } {
  const classes: string[] = [];
  if (style.flags & FLAG_BOLD) classes.push("font-semibold");
  if (style.flags & FLAG_DIM) classes.push("opacity-70");
  if (style.flags & FLAG_ITALIC) classes.push("italic");
  if (style.flags & FLAG_UNDERLINE && style.flags & FLAG_STRIKE)
    classes.push("[text-decoration-line:underline_line-through]");
  else if (style.flags & FLAG_UNDERLINE) classes.push("underline");
  else if (style.flags & FLAG_STRIKE) classes.push("line-through");
  let fg = color(style.fg, palette);
  let bg = color(style.bg, palette);
  if (style.flags & FLAG_INVERSE) {
    [fg, bg] = [bg ?? "var(--background)", fg ?? "var(--foreground)"];
  }
  if (style.flags & FLAG_CONCEAL) fg = "transparent";
  const css: CSSProperties = {};
  if (fg !== undefined) css.color = fg;
  if (bg !== undefined) css.backgroundColor = bg;
  return {
    className: classes.length > 0 ? classes.join(" ") : undefined,
    style: fg === undefined && bg === undefined ? undefined : css,
  };
}
