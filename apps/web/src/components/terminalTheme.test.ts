import { describe, expect, it } from "vite-plus/test";
import {
  mergeTerminalSpawnEnv,
  resolveTerminalThemeMode,
  TERMINAL_ANSI_COLOR_NAMES,
  terminalAnsiColors,
  terminalExtendedAnsiPalette,
  retainTerminalLaunchTheme,
  terminalOscColorEnv,
  usesPersistentWindowsConsoleTheme,
  resolveTerminalPalette,
} from "./terminalTheme";
import type { ThemeFile } from "@bibcode/contracts";
import { BUILTIN_THEMES } from "../themes/builtinThemes";

describe("terminal theme launch values", () => {
  it("maps resolved light and dark themes to exact OSC colors", () => {
    expect(terminalOscColorEnv("light")).toEqual({
      BIBCODE_OSC_BACKGROUND: "255,255,255",
      BIBCODE_OSC_FOREGROUND: "28,33,41",
      BIBCODE_OSC_CURSOR: "38,56,78",
    });
    expect(terminalOscColorEnv("dark")).toEqual({
      BIBCODE_OSC_BACKGROUND: "14,18,24",
      BIBCODE_OSC_FOREGROUND: "237,241,247",
      BIBCODE_OSC_CURSOR: "180,203,255",
    });
  });

  it("replaces exact reserved keys with authoritative values inserted last", () => {
    const merged = mergeTerminalSpawnEnv({
      commandEnv: {
        SHARED: "command",
        COMMAND_ONLY: "yes",
        BIBCODE_OSC_BACKGROUND: "0,0,0",
        BIBCODE_WINDOWS_CONSOLE_THEME: "command",
      },
      runtimeEnv: {
        SHARED: "runtime",
        RUNTIME_ONLY: "yes",
        BIBCODE_OSC_FOREGROUND: "0,0,0",
        BIBCODE_OSC_CURSOR: "0,0,0",
        BIBCODE_WINDOWS_CONSOLE_THEME: "runtime",
      },
      resolvedTheme: "light",
      windowsConsoleTheme: true,
    });

    expect(merged).toEqual({
      SHARED: "runtime",
      COMMAND_ONLY: "yes",
      RUNTIME_ONLY: "yes",
      BIBCODE_OSC_BACKGROUND: "255,255,255",
      BIBCODE_OSC_FOREGROUND: "28,33,41",
      BIBCODE_OSC_CURSOR: "38,56,78",
      BIBCODE_WINDOWS_CONSOLE_THEME: "light",
    });
    expect(Object.keys(merged).slice(-4)).toEqual([
      "BIBCODE_OSC_BACKGROUND",
      "BIBCODE_OSC_FOREGROUND",
      "BIBCODE_OSC_CURSOR",
      "BIBCODE_WINDOWS_CONSOLE_THEME",
    ]);
  });

  it("preserves differently cased variables for case-sensitive platforms", () => {
    expect(
      mergeTerminalSpawnEnv({
        commandEnv: {
          bibcode_osc_foreground: "command-lowercase",
          BiBCode_Osc_Cursor: "command-mixed-case",
          bibcode_windows_console_theme: "command-lowercase",
        },
        runtimeEnv: {
          bibcode_osc_background: "runtime-lowercase",
          BiBCode_Windows_Console_Theme: "runtime-mixed-case",
        },
        resolvedTheme: "light",
        windowsConsoleTheme: true,
      }),
    ).toEqual({
      bibcode_osc_foreground: "command-lowercase",
      BiBCode_Osc_Cursor: "command-mixed-case",
      bibcode_windows_console_theme: "command-lowercase",
      bibcode_osc_background: "runtime-lowercase",
      BiBCode_Windows_Console_Theme: "runtime-mixed-case",
      BIBCODE_OSC_BACKGROUND: "255,255,255",
      BIBCODE_OSC_FOREGROUND: "28,33,41",
      BIBCODE_OSC_CURSOR: "38,56,78",
      BIBCODE_WINDOWS_CONSOLE_THEME: "light",
    });
  });

  it("omits the Windows console theme when it is not requested", () => {
    expect(
      mergeTerminalSpawnEnv({
        commandEnv: { BIBCODE_WINDOWS_CONSOLE_THEME: "command" },
        runtimeEnv: { BIBCODE_WINDOWS_CONSOLE_THEME: "runtime" },
        resolvedTheme: "dark",
        windowsConsoleTheme: false,
      }),
    ).toEqual({
      BIBCODE_OSC_BACKGROUND: "14,18,24",
      BIBCODE_OSC_FOREGROUND: "237,241,247",
      BIBCODE_OSC_CURSOR: "180,203,255",
    });
  });

  it("retains a Codex launch theme until the terminal generation changes", () => {
    const initial = retainTerminalLaunchTheme(null, {
      persistentConsoleTheme: true,
      generation: 4,
      resolvedTheme: "dark",
    });

    expect(
      retainTerminalLaunchTheme(initial, {
        persistentConsoleTheme: true,
        generation: 4,
        resolvedTheme: "light",
      }),
    ).toEqual({ generation: 4, theme: "dark" });
    expect(
      retainTerminalLaunchTheme(initial, {
        persistentConsoleTheme: true,
        generation: 5,
        resolvedTheme: "light",
      }),
    ).toEqual({ generation: 5, theme: "light" });
  });

  it("uses the requested process theme when that restart advances the generation", () => {
    const previous = { generation: 4, theme: "dark" } as const;

    expect(
      retainTerminalLaunchTheme(previous, {
        persistentConsoleTheme: true,
        generation: 5,
        resolvedTheme: "dark",
        restartRequest: { sourceGeneration: 4, targetTheme: "light" },
      }),
    ).toEqual({ generation: 5, theme: "light" });
  });

  it("tracks the resolved theme live for non-Codex terminals", () => {
    const initial = retainTerminalLaunchTheme(null, {
      persistentConsoleTheme: false,
      generation: 4,
      resolvedTheme: "dark",
    });

    expect(
      retainTerminalLaunchTheme(initial, {
        persistentConsoleTheme: false,
        generation: 4,
        resolvedTheme: "light",
      }),
    ).toEqual({ generation: 4, theme: "light" });
  });
  it("keeps the terminal on its own theme unless it is told to follow the app", () => {
    // Codex paints hardcoded dark panels and never queries the terminal, so a
    // dark terminal inside a light app is the correct default, not a mismatch.
    expect(resolveTerminalThemeMode("dark", "light")).toBe("dark");
    expect(resolveTerminalThemeMode("dark", "dark")).toBe("dark");
    expect(resolveTerminalThemeMode("light", "dark")).toBe("light");
    expect(resolveTerminalThemeMode("light", "light")).toBe("light");
  });

  it("tracks the app theme only for the explicit follow preference", () => {
    expect(resolveTerminalThemeMode("app", "light")).toBe("light");
    expect(resolveTerminalThemeMode("app", "dark")).toBe("dark");
  });
  it("flips only the grayscale ramp so hardcoded TUI surfaces follow a light terminal", () => {
    const dark = terminalExtendedAnsiPalette("dark");
    const light = terminalExtendedAnsiPalette("light");

    // Indices 16..255 inclusive.
    expect(dark).toHaveLength(240);
    expect(light).toHaveLength(240);

    // Codex fills its panels with index 235, deep in the grayscale ramp.
    const at = (palette: ReadonlyArray<string>, index: number) => palette[index - 16];
    expect(at(dark, 235)).toBe("#262626");
    expect(at(light, 235)).toBe("#d0d0d0");

    // The ramp ends swap, and the 6x6x6 colour cube is untouched in both.
    expect(at(dark, 232)).toBe(at(light, 255));
    expect(at(dark, 255)).toBe(at(light, 232));
    expect(at(dark, 196)).toBe("#ff0000");
    expect(at(light, 196)).toBe("#ff0000");
    expect(dark.slice(0, 216)).toEqual(light.slice(0, 216));
  });

  it("detects Codex launches that pin the spawn theme until restart", () => {
    expect(usesPersistentWindowsConsoleTheme({ executable: "codex", args: [] })).toBe(true);
    expect(
      usesPersistentWindowsConsoleTheme({
        executable: "/usr/local/bin/codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
      }),
    ).toBe(true);
    expect(usesPersistentWindowsConsoleTheme({ executable: "claude", args: [] })).toBe(false);
    expect(usesPersistentWindowsConsoleTheme(undefined)).toBe(false);
  });

  it("shares the 16 named ANSI colors per theme, so the job log matches the terminal", () => {
    for (const mode of ["light", "dark"] as const) {
      const colors = terminalAnsiColors(mode);
      expect(Object.keys(colors)).toEqual([...TERMINAL_ANSI_COLOR_NAMES]);
      expect(Object.values(colors).every((value) => /^rgb\(\d+, \d+, \d+\)$/.test(value))).toBe(
        true,
      );
    }
    expect(terminalAnsiColors("dark").red).toBe("rgb(255, 122, 142)");
    expect(terminalAnsiColors("light").red).toBe("rgb(191, 70, 87)");
  });
});

describe("terminal palette from the app theme", () => {
  const builtin = (id: string) => BUILTIN_THEMES.find((theme) => theme.id === id)!;
  const custom = (terminal: Record<string, string> = {}): ThemeFile => ({
    version: 1,
    id: "mine",
    name: "Mine",
    base: "dark",
    terminal,
  });

  it("with preference app and Tokyo Night the ANSI green is #9ece6a and the OSC background is 26,27,38", () => {
    const palette = resolveTerminalPalette("app", builtin("tokyo-night"));
    expect(terminalAnsiColors(palette).green).toBe("#9ece6a");
    expect(terminalOscColorEnv(palette).BIBCODE_OSC_BACKGROUND).toBe("26,27,38");
  });

  it("Matrix Dark gives ANSI green #2d9a48 and OSC background 8,12,9", () => {
    const palette = resolveTerminalPalette("app", builtin("matrix-dark"));
    expect(terminalAnsiColors(palette).green).toBe("#2d9a48");
    expect(terminalOscColorEnv(palette).BIBCODE_OSC_BACKGROUND).toBe("8,12,9");
  });

  it("Matrix Light gives ANSI green #15803d and OSC background 255,255,255", () => {
    const palette = resolveTerminalPalette("app", builtin("matrix-light"));
    expect(palette.mode).toBe("light");
    expect(terminalAnsiColors(palette).green).toBe("#15803d");
    expect(terminalOscColorEnv(palette).BIBCODE_OSC_BACKGROUND).toBe("255,255,255");
  });

  it("Verdant Light gives ANSI green #26734d, ANSI red #b42318 and OSC foreground 48,56,64", () => {
    const palette = resolveTerminalPalette("app", builtin("verdant-light"));
    expect(terminalAnsiColors(palette)).toMatchObject({ green: "#26734d", red: "#b42318" });
    expect(terminalOscColorEnv(palette).BIBCODE_OSC_FOREGROUND).toBe("48,56,64");
  });

  it("with preference dark the built-in dark palette is used whatever the theme", () => {
    for (const id of ["tokyo-night", "verdant-light"]) {
      const palette = resolveTerminalPalette("dark", builtin(id));
      expect(palette.mode).toBe("dark");
      expect(terminalOscColorEnv(palette)).toEqual(terminalOscColorEnv("dark"));
      expect(terminalAnsiColors(palette).green).toBe("#86e795");
    }
  });

  it("a theme with no terminal colors uses its base's built-in palette", () => {
    const palette = resolveTerminalPalette("app", custom());
    expect(terminalOscColorEnv(palette)).toEqual(terminalOscColorEnv("dark"));
    expect(terminalAnsiColors(palette).red).toBe("#ff7a8e");
  });

  it("editing a theme's ANSI red changes the palette key although the id is the same", () => {
    const before = resolveTerminalPalette("app", custom({ red: "#ff5555" }));
    const after = resolveTerminalPalette("app", custom({ red: "#ff0000" }));
    expect(terminalAnsiColors(before).red).toBe("#ff5555");
    expect(after.key).not.toBe(before.key);
    expect(resolveTerminalPalette("app", custom({ red: "#ff5555" })).key).toBe(before.key);
  });

  it("a running session keeps the full palette it was launched with after the theme changes", () => {
    const launched = resolveTerminalPalette("app", builtin("tokyo-night"));
    const changed = resolveTerminalPalette("app", builtin("matrix-dark"));
    const input = { persistentConsoleTheme: false, resolvedTheme: "dark" as const };
    const first = retainTerminalLaunchTheme(null, { ...input, generation: 1, palette: launched });
    const same = retainTerminalLaunchTheme(first, { ...input, generation: 1, palette: changed });
    expect(same.palette).toBe(launched);
    const next = retainTerminalLaunchTheme(same, { ...input, generation: 2, palette: changed });
    expect(next.palette).toBe(changed);
  });
});
