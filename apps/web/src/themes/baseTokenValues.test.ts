import { TERMINAL_TOKENS, UI_COLOR_TOKENS } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  TERMINAL_ANSI_COLOR_NAMES,
  terminalAnsiColors,
  terminalOscColorEnv,
} from "../components/terminalTheme";
import { BASE_EXACT_VALUES, BASE_TOKEN_VALUES, DERIVED_DEFAULTS } from "./baseTokenValues";
import { evaluateCssTokens, evaluateCssTokensUnrounded } from "./cssTokenEvaluator.testSupport";
import { parseColor, toHex } from "./themeColor";

describe("BASE_TOKEN_VALUES", () => {
  it("every supported color token and terminal color has a light and a dark base value", () => {
    for (const base of ["light", "dark"] as const) {
      for (const token of UI_COLOR_TOKENS) {
        expect(BASE_TOKEN_VALUES[base][token], `${base} ${token}`).toMatch(
          /^#[0-9a-f]{6}([0-9a-f]{2})?$/,
        );
      }
      for (const token of TERMINAL_TOKENS) {
        expect(BASE_TOKEN_VALUES[base][`terminal.${token}`], `${base} terminal.${token}`).toMatch(
          /^#[0-9a-f]{6}([0-9a-f]{2})?$/,
        );
      }
    }
  });

  it("the terminal base values equal the built-in terminal palettes", () => {
    for (const base of ["light", "dark"] as const) {
      const ansi = terminalAnsiColors(base);
      for (const name of TERMINAL_ANSI_COLOR_NAMES) {
        const token = `terminal.${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
        expect(BASE_TOKEN_VALUES[base][token], `${base} ${token}`).toBe(toHex(ansi[name]));
      }
      const osc = terminalOscColorEnv(base);
      const rgb = (value: string) => toHex(`rgb(${value})`);
      expect(BASE_TOKEN_VALUES[base]["terminal.background"]).toBe(rgb(osc.BIBCODE_OSC_BACKGROUND!));
      expect(BASE_TOKEN_VALUES[base]["terminal.foreground"]).toBe(rgb(osc.BIBCODE_OSC_FOREGROUND!));
      expect(BASE_TOKEN_VALUES[base]["terminal.cursor"]).toBe(rgb(osc.BIBCODE_OSC_CURSOR!));
    }
  });

  it("each base value equals the computed value of its CSS variable", () => {
    for (const base of ["light", "dark"] as const) {
      const painted = evaluateCssTokens(base);
      for (const token of UI_COLOR_TOKENS) {
        expect(BASE_TOKEN_VALUES[base][token], `${base} ${token}`).toBe(painted(token));
      }
    }
  });

  it("every base value a recipe builds on is the unrounded value the stylesheet paints", () => {
    for (const base of ["light", "dark"] as const) {
      const sources = new Set<string>();
      for (const formula of Object.values(DERIVED_DEFAULTS[base])) {
        formula((token) => {
          sources.add(token);
          return BASE_TOKEN_VALUES[base][token]!;
        });
      }
      const painted = evaluateCssTokensUnrounded(base);
      for (const token of sources) {
        if (token in DERIVED_DEFAULTS[base]) continue;
        const value = BASE_EXACT_VALUES[base][token]?.() ?? BASE_TOKEN_VALUES[base][token]!;
        const exact = parseColor(value)!;
        const expected = painted(token);
        for (const channel of ["r", "g", "b", "a"] as const) {
          expect(exact[channel], `${base} ${token} ${channel}`).toBeCloseTo(expected[channel], 9);
        }
      }
    }
  });
});
