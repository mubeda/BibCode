import type { CSSProperties } from "react";
import {
  TERMINAL_ANSI_COLOR_NAMES,
  terminalAnsiColors,
  terminalExtendedAnsiPalette,
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

const palettes = new Map<TerminalThemeMode, LogPalette>();

/** The terminal's palette for a theme, as the log root's variables and the 256-color table. */
export function logPalette(mode: TerminalThemeMode): LogPalette {
  const known = palettes.get(mode);
  if (known) return known;
  const named = terminalAnsiColors(mode);
  const variables: Record<string, string> = {};
  for (const [index, name] of TERMINAL_ANSI_COLOR_NAMES.entries())
    variables[`--log-ansi-${index}`] = named[name];
  const palette = {
    variables: variables as CSSProperties,
    extended: terminalExtendedAnsiPalette(mode),
  };
  palettes.set(mode, palette);
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
