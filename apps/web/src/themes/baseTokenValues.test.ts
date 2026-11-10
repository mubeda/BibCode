import { TERMINAL_TOKENS, UI_COLOR_TOKENS } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  TERMINAL_ANSI_COLOR_NAMES,
  terminalAnsiColors,
  terminalOscColorEnv,
} from "../components/terminalTheme";
import { BASE_TOKEN_VALUES } from "./baseTokenValues";
import { evaluateCssTokens } from "./cssTokenEvaluator.testSupport";
import { toHex } from "./themeColor";

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
});
