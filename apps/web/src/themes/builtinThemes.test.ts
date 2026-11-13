import { RESERVED_THEME_IDS, TERMINAL_TOKENS } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BUILTIN_THEMES, isBuiltinThemeId } from "./builtinThemes";
import { contrastRatio, failingPairs, resolveToken } from "./themeColor";
import { validateThemeFile } from "./themeValidation";

function builtin(id: string) {
  const theme = BUILTIN_THEMES.find((entry) => entry.id === id);
  if (!theme) throw new Error(`No built-in theme ${id}`);
  return theme;
}

const NEW_BUILTINS = ["tokyo-night", "matrix-dark", "matrix-light", "verdant-light"] as const;

describe("built-in theme files", () => {
  for (const id of NEW_BUILTINS) {
    it(`${id} decodes with validateThemeFile and has no unknown token`, () => {
      const { subtitle: _subtitle, ...file } = builtin(id);
      expect(validateThemeFile(file, { allowReservedId: true })).toEqual({ ok: true, theme: file });
    });
  }

  it("Tokyo Night sets background #1a1b26, primary #7aa2f7, border #414868, foreground-strong #c0caf5 and ANSI green #9ece6a", () => {
    const theme = builtin("tokyo-night");
    expect(theme.base).toBe("dark");
    expect(theme.ui).toMatchObject({
      background: "#1a1b26",
      primary: "#7aa2f7",
      border: "#414868",
      "foreground-strong": "#c0caf5",
    });
    expect(theme.terminal?.green).toBe("#9ece6a");
  });

  it("Matrix Dark sets background #080c09, primary #3cbf5c, panel-separator #3cbf5c and ANSI green #2d9a48", () => {
    const theme = builtin("matrix-dark");
    expect(theme.base).toBe("dark");
    expect(theme.ui).toMatchObject({
      background: "#080c09",
      primary: "#3cbf5c",
      "panel-separator": "#3cbf5c",
    });
    expect(theme.terminal?.green).toBe("#2d9a48");
  });

  it("Matrix Light sets background #ffffff, primary #15803d, input #16a34a and ANSI green #15803d", () => {
    const theme = builtin("matrix-light");
    expect(theme.base).toBe("light");
    expect(theme.ui).toMatchObject({ background: "#ffffff", primary: "#15803d", input: "#16a34a" });
    expect(theme.terminal?.green).toBe("#15803d");
  });

  it("Verdant Light sets background #ffffff, foreground #303840, primary #087f5b, input #87939b, placeholder #667078, primary-hover #066649, primary-active #05543d, selected #eaf5ef, selected-foreground #065f46 and panel-separator #dee3e6", () => {
    const theme = builtin("verdant-light");
    expect(theme.base).toBe("light");
    expect(theme.ui).toMatchObject({
      background: "#ffffff",
      foreground: "#303840",
      primary: "#087f5b",
      input: "#87939b",
      placeholder: "#667078",
      "primary-hover": "#066649",
      "primary-active": "#05543d",
      selected: "#eaf5ef",
      "selected-foreground": "#065f46",
      "panel-separator": "#dee3e6",
    });
  });

  it("Verdant Light sets focus-ring-width 2px, focus-ring-offset 2px and control-shadow none", () => {
    expect(builtin("verdant-light").ui).toMatchObject({
      "focus-ring-width": "2px",
      "focus-ring-offset": "2px",
      "control-shadow": "none",
    });
  });

  it("Light and Dark have no overrides", () => {
    for (const id of ["light", "dark"]) {
      const theme = builtin(id);
      expect(theme.ui).toBeUndefined();
      expect(theme.terminal).toBeUndefined();
      expect(theme.base).toBe(id);
    }
  });

  it("the list order is Light, Dark, Tokyo Night, Matrix Dark, Matrix Light, Verdant Light", () => {
    expect(BUILTIN_THEMES.map((theme) => theme.name)).toEqual([
      "Light",
      "Dark",
      "Tokyo Night",
      "Matrix Dark",
      "Matrix Light",
      "Verdant Light",
    ]);
  });

  it("every reserved id is a built-in or system", () => {
    for (const id of RESERVED_THEME_IDS) {
      expect(id === "system" || isBuiltinThemeId(id), id).toBe(true);
    }
    expect(isBuiltinThemeId("my-theme")).toBe(false);
  });
});

describe("built-in theme contrast", () => {
  it("each new built-in keeps every fixed pair at or above 4.5", () => {
    for (const id of NEW_BUILTINS) {
      expect(failingPairs(builtin(id)), id).toEqual([]);
    }
    const ratio = (id: string, text: string, surface: string) =>
      contrastRatio(
        resolveToken(builtin(id), text),
        resolveToken(builtin(id), surface),
        resolveToken(builtin(id), "background"),
      );
    expect(Math.abs(ratio("tokyo-night", "muted-foreground", "background") - 5.75)).toBeLessThan(
      0.01,
    );
    expect(Math.abs(ratio("matrix-dark", "muted-foreground", "accent") - 4.81)).toBeLessThan(0.01);
    expect(Math.abs(ratio("verdant-light", "placeholder", "background") - 5.06)).toBeLessThan(0.01);
  });

  it("Matrix Light and Verdant Light keep the input token at or above 3 on the background", () => {
    for (const id of ["matrix-light", "verdant-light"]) {
      const theme = builtin(id);
      expect(
        contrastRatio(resolveToken(theme, "input"), resolveToken(theme, "background")),
        id,
      ).toBeGreaterThanOrEqual(3);
    }
    const verdant = builtin("verdant-light");
    expect(
      Math.abs(
        contrastRatio(resolveToken(verdant, "input"), resolveToken(verdant, "background")) - 3.15,
      ),
    ).toBeLessThan(0.01);
  });

  it("every ANSI color of Matrix Light and Verdant Light is at or above 4.5 on the terminal background", () => {
    const ansi = TERMINAL_TOKENS.filter(
      (token) =>
        !["background", "foreground", "cursor"].includes(token) && !token.startsWith("selection"),
    );
    expect(ansi).toHaveLength(16);
    for (const id of ["matrix-light", "verdant-light"]) {
      const theme = builtin(id);
      const background = resolveToken(theme, "terminal.background");
      for (const token of ansi) {
        expect(
          contrastRatio(resolveToken(theme, `terminal.${token}`), background),
          `${id} ${token}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("each new built-in's placeholder is at or above 4.5 on its background", () => {
    for (const id of NEW_BUILTINS) {
      const theme = builtin(id);
      expect(
        contrastRatio(
          resolveToken(theme, "placeholder"),
          resolveToken(theme, "background"),
          resolveToken(theme, "background"),
        ),
        id,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
