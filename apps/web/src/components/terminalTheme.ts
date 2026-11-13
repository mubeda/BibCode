import type { ThemeFile } from "@bibcode/contracts";
import type { TerminalThemePreference } from "@bibcode/contracts/settings";

import { resolveToken } from "../themes/themeColor";

export type TerminalThemeMode = "light" | "dark";

export interface TerminalLaunchThemeState {
  readonly generation: number;
  readonly theme: TerminalThemeMode;
  /** The full palette the session was launched with; a running session keeps it (R51). */
  readonly palette?: TerminalPalette | undefined;
}

/** Every color a terminal session is drawn and reported with, as hex. */
export type TerminalPalette = {
  mode: TerminalThemeMode;
  /** Changes whenever any color changes, including a saved edit to a theme with the same id. */
  key: string;
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  selectionForeground: string;
  ansi: TerminalAnsiColors;
};

const TERMINAL_OSC_COLORS = {
  dark: { background: "14,18,24", foreground: "237,241,247", cursor: "180,203,255" },
  light: { background: "255,255,255", foreground: "28,33,41", cursor: "38,56,78" },
} as const;

const WINDOWS_CONSOLE_THEME = "BIBCODE_WINDOWS_CONSOLE_THEME";
const RESERVED_TERMINAL_THEME_ENV = new Set([
  "BIBCODE_OSC_BACKGROUND",
  "BIBCODE_OSC_FOREGROUND",
  "BIBCODE_OSC_CURSOR",
  WINDOWS_CONSOLE_THEME,
]);

function withoutReservedTerminalThemeEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(([key]) => !RESERVED_TERMINAL_THEME_ENV.has(key)),
  );
}

/**
 * Resolves the theme the terminal surface renders with.
 *
 * The terminal is deliberately decoupled from the app theme. Provider TUIs such
 * as Codex paint their own surfaces with hardcoded dark 256-colour indices and
 * never query the terminal for its colours, so forcing a light terminal renders
 * their panels as dark blocks. `app` is the opt-in for users who want the
 * terminal to track the app instead.
 */
export function resolveTerminalThemeMode(
  preference: TerminalThemePreference,
  appTheme: TerminalThemeMode,
): TerminalThemeMode {
  return preference === "app" ? appTheme : preference;
}

/** The 16 named ANSI colors of the terminal palette, in SGR order (black … bright white). */
export const TERMINAL_ANSI_COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type TerminalAnsiColors = Record<(typeof TERMINAL_ANSI_COLOR_NAMES)[number], string>;

const TERMINAL_ANSI_COLORS: Record<TerminalThemeMode, TerminalAnsiColors> = {
  dark: {
    black: "rgb(24, 30, 38)",
    red: "rgb(255, 122, 142)",
    green: "rgb(134, 231, 149)",
    yellow: "rgb(244, 205, 114)",
    blue: "rgb(137, 190, 255)",
    magenta: "rgb(208, 176, 255)",
    cyan: "rgb(124, 232, 237)",
    white: "rgb(210, 218, 230)",
    brightBlack: "rgb(110, 120, 136)",
    brightRed: "rgb(255, 168, 180)",
    brightGreen: "rgb(176, 245, 186)",
    brightYellow: "rgb(255, 224, 149)",
    brightBlue: "rgb(174, 210, 255)",
    brightMagenta: "rgb(229, 203, 255)",
    brightCyan: "rgb(167, 244, 247)",
    brightWhite: "rgb(244, 247, 252)",
  },
  light: {
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  },
};

/**
 * The terminal's 16 named ANSI colors for a theme. The live terminal and the job log
 * viewer both draw from it, so a log's colors match the terminal in either theme.
 */
export function terminalAnsiColors(
  source: TerminalThemeMode | TerminalPalette,
): TerminalAnsiColors {
  return typeof source === "string" ? TERMINAL_ANSI_COLORS[source] : source.ansi;
}

/**
 * The palette a new terminal session uses. With "Follow app theme" the theme's terminal colors
 * win over its base's built-in palette; with Dark or Light the built-in palette is used (R51).
 */
export function resolveTerminalPalette(
  preference: TerminalThemePreference,
  theme: ThemeFile,
): TerminalPalette {
  const mode = preference === "app" ? theme.base : preference;
  const source: ThemeFile =
    preference === "app" ? theme : { version: 1, id: mode, name: mode, base: mode };
  const color = (token: string) => resolveToken(source, `terminal.${token}`);
  const ansi = Object.fromEntries(
    TERMINAL_ANSI_COLOR_NAMES.map((name) => [
      name,
      color(name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)),
    ]),
  ) as TerminalAnsiColors;
  const colors = {
    background: color("background"),
    foreground: color("foreground"),
    cursor: color("cursor"),
    selectionBackground: color("selection-background"),
    selectionForeground: color("selection-foreground"),
  };
  return {
    mode,
    key: [mode, ...Object.values(colors), ...Object.values(ansi)].join(","),
    ...colors,
    ansi,
  };
}

const BUILTIN_PALETTE_KEYS = new Map<TerminalThemeMode, string>();

/** Whether `palette` is the built-in Light or Dark terminal palette. */
export function isBuiltinTerminalPalette(palette: TerminalPalette): boolean {
  let key = BUILTIN_PALETTE_KEYS.get(palette.mode);
  if (key === undefined) {
    key = resolveTerminalPalette(palette.mode, {
      version: 1,
      id: palette.mode,
      name: palette.mode,
      base: palette.mode,
    }).key;
    BUILTIN_PALETTE_KEYS.set(palette.mode, key);
  }
  return palette.key === key;
}

function oscTriplet(hex: string): string {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(",");
}

const XTERM_CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const GRAYSCALE_RAMP_START = 232;
const GRAYSCALE_RAMP_STEPS = 24;

function rgbHex(red: number, green: number, blue: number): string {
  const channel = (value: number) => value.toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/**
 * The 240 colours xterm indexes from 16 to 255, with the grayscale ramp flipped
 * for a light terminal.
 *
 * Full-screen TUIs paint their own surfaces from the grayscale ramp with
 * hardcoded indices — Codex fills its panels with 235 (#262626) — and never ask
 * the terminal which colours it uses. Serving the standard ramp to a light
 * terminal therefore renders those panels as dark blocks. Flipping only the
 * ramp turns a TUI's "darkest surface" into the lightest one, so the same
 * hardcoded index lands on a surface that suits the terminal. The 6x6x6 colour
 * cube is left untouched: those are chosen hues, not surface shades, and
 * altering them would misrepresent real content.
 */
export function terminalExtendedAnsiPalette(mode: TerminalThemeMode): Array<string> {
  const palette: Array<string> = [];
  for (let index = 16; index < GRAYSCALE_RAMP_START; index += 1) {
    const offset = index - 16;
    palette.push(
      rgbHex(
        XTERM_CUBE_LEVELS[Math.floor(offset / 36) % 6]!,
        XTERM_CUBE_LEVELS[Math.floor(offset / 6) % 6]!,
        XTERM_CUBE_LEVELS[offset % 6]!,
      ),
    );
  }
  for (let step = 0; step < GRAYSCALE_RAMP_STEPS; step += 1) {
    const position = mode === "light" ? GRAYSCALE_RAMP_STEPS - 1 - step : step;
    const level = 8 + position * 10;
    palette.push(rgbHex(level, level, level));
  }
  return palette;
}

export function terminalOscColorEnv(
  source: TerminalThemeMode | TerminalPalette,
): Record<string, string> {
  const colors =
    typeof source === "string"
      ? TERMINAL_OSC_COLORS[source]
      : {
          background: oscTriplet(source.background),
          foreground: oscTriplet(source.foreground),
          cursor: oscTriplet(source.cursor),
        };
  return {
    BIBCODE_OSC_BACKGROUND: colors.background,
    BIBCODE_OSC_FOREGROUND: colors.foreground,
    BIBCODE_OSC_CURSOR: colors.cursor,
  };
}

export function mergeTerminalSpawnEnv(input: {
  readonly commandEnv?: Readonly<Record<string, string>> | undefined;
  readonly runtimeEnv?: Readonly<Record<string, string>> | undefined;
  readonly resolvedTheme: TerminalThemeMode;
  readonly palette?: TerminalPalette | undefined;
  readonly windowsConsoleTheme: boolean;
}): Record<string, string> {
  return {
    ...withoutReservedTerminalThemeEnv(input.commandEnv),
    ...withoutReservedTerminalThemeEnv(input.runtimeEnv),
    ...terminalOscColorEnv(
      input.palette?.mode === input.resolvedTheme ? input.palette : input.resolvedTheme,
    ),
    ...(input.windowsConsoleTheme ? { [WINDOWS_CONSOLE_THEME]: input.resolvedTheme } : {}),
  };
}

/** Codex snapshots OSC (and on Windows, ConPTY) colors at spawn; live xterm theme changes leave unreadable UI. */
export function usesPersistentWindowsConsoleTheme(
  command:
    | {
        readonly executable: string;
        readonly args: ReadonlyArray<string>;
      }
    | null
    | undefined,
): boolean {
  if (!command) return false;
  const executable = command.executable.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  return (
    executable.includes("codex") ||
    command.args.includes("--dangerously-bypass-approvals-and-sandbox")
  );
}

export function retainTerminalLaunchTheme(
  previous: TerminalLaunchThemeState | null,
  input: Parameters<typeof retainLaunchMode>[1] & { readonly palette?: TerminalPalette },
): TerminalLaunchThemeState {
  const next = retainLaunchMode(previous, input);
  const palette =
    previous !== null && previous.generation === input.generation && previous.palette
      ? previous.palette
      : input.palette;
  return next.palette === palette ? next : { ...next, palette };
}

function retainLaunchMode(
  previous: TerminalLaunchThemeState | null,
  input: {
    readonly persistentConsoleTheme: boolean;
    readonly generation: number;
    readonly resolvedTheme: TerminalThemeMode;
    readonly authoritativeTheme?: TerminalThemeMode | null;
    readonly restartRequest?: {
      readonly sourceGeneration: number;
      readonly targetTheme: TerminalThemeMode;
    } | null;
  },
): TerminalLaunchThemeState {
  if (
    input.persistentConsoleTheme &&
    input.authoritativeTheme !== null &&
    input.authoritativeTheme !== undefined
  ) {
    return { generation: input.generation, theme: input.authoritativeTheme };
  }
  if (!input.persistentConsoleTheme || previous === null) {
    return { generation: input.generation, theme: input.resolvedTheme };
  }
  if (previous.generation !== input.generation) {
    const requestedTheme =
      input.restartRequest !== null &&
      input.restartRequest !== undefined &&
      input.generation > input.restartRequest.sourceGeneration
        ? input.restartRequest.targetTheme
        : input.resolvedTheme;
    return { generation: input.generation, theme: requestedTheme };
  }
  return previous;
}
