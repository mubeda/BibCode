import type { ThemeFile } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BASE_TOKEN_VALUES, DERIVED_DEFAULTS } from "./baseTokenValues";
import { derivedDeclarations, evaluateCssTokens } from "./cssTokenEvaluator.testSupport";
import {
  contrastRatio,
  failingPairs,
  FIXED_PAIRS,
  parseColor,
  resolveToken,
  toHex,
} from "./themeColor";

const theme = (base: "light" | "dark", ui: Record<string, string> = {}): ThemeFile => ({
  version: 1,
  id: "test-theme",
  name: "Test theme",
  base,
  ui,
});

// Each derived token and a token it depends on, from index.css lines 243 to 331.
const DERIVED_SOURCES: Record<string, string> = {
  "app-chrome-background": "background",
  card: "background",
  popover: "background",
  "panel-separator": "ring",
  "sidebar-well": "background",
  "sidebar-card": "background",
  "sidebar-env-band": "background",
  "find-match": "background",
  "foreground-strong": "foreground",
  placeholder: "muted-foreground",
  "primary-hover": "primary",
  "primary-active": "primary",
  selected: "accent",
  "selected-foreground": "accent-foreground",
  "sidebar-env-accent": "primary",
  "sidebar-primary-badge": "primary",
  "sidebar-primary-badge-foreground": "primary",
  "sidebar-worktree": "primary",
  "sidebar-worktree-border": "foreground",
  "sidebar-worktree-icon": "primary",
  "sidebar-chat-foreground": "foreground",
  "sidebar-indent-guide": "foreground",
};

describe("resolveToken against the stylesheet", () => {
  it("for every derived token, overriding the token it depends on changes resolveToken the same way it changes the painted value", () => {
    for (const base of ["light", "dark"] as const) {
      const derived = [
        ...derivedDeclarations(base),
        "foreground-strong",
        "placeholder",
        "primary-hover",
        "primary-active",
        "selected",
        "selected-foreground",
      ];
      expect(new Set(derived)).toEqual(new Set(Object.keys(DERIVED_DEFAULTS[base])));
      for (const token of derived) {
        const source = DERIVED_SOURCES[token];
        expect(source, `${base} ${token} has a known source`).toBeDefined();
        // Both sides start from the base background in hex; the stylesheet alone keeps Dark's
        // background unrounded, which would shift a token two steps from it by one channel step.
        const overrides = {
          background: BASE_TOKEN_VALUES[base].background!,
          [source!]: "#123456",
        };
        expect(resolveToken(theme(base, overrides), token), `${base} ${token}`).toBe(
          evaluateCssTokens(base, overrides)(token),
        );
      }
    }
  });
});

describe("parseColor and toHex", () => {
  it("parseColor reads hex, rgb(), hsl() and oklch() and returns null for a named color", () => {
    expect(parseColor("#ff8000")).toEqual({ r: 255, g: 128, b: 0, a: 1 });
    expect(parseColor("#f80")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor("rgb(255 128 0 / 50%)")).toEqual({ r: 255, g: 128, b: 0, a: 0.5 });
    expect(parseColor("rgba(255, 128, 0, 0.5)")).toEqual({ r: 255, g: 128, b: 0, a: 0.5 });
    expect(toHex("hsl(120deg 100% 25%)")).toBe("#008000");
    expect(toHex("oklch(62.8% 0.2577 29.23)")).toBe("#ff0000");
    expect(toHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(parseColor("red")).toBeNull();
  });

  it("toHex round-trips", () => {
    for (const hex of ["#000000", "#ffffff", "#1a1b26", "#7aa2f7", "#3b82f680"]) {
      expect(toHex(hex)).toBe(hex);
      expect(toHex(toHex(hex))).toBe(hex);
    }
    expect(toHex("#ABC")).toBe("#aabbcc");
  });
});

describe("contrastRatio", () => {
  it("contrastRatio matches known values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(contrastRatio("#a9b1d6", "#1a1b26")).toBeCloseTo(8.1, 1);
    expect(Math.abs(contrastRatio("#a9b1d6", "#1a1b26") - 8.1)).toBeLessThan(0.01);
    expect(Math.abs(contrastRatio("#087f5b", "#ffffff") - 5.0)).toBeLessThan(0.01);
  });

  it("a color with alpha is composited over its surface before the ratio is computed", () => {
    // Black at 128/255 over white paints 255 * (1 - 128/255) = 127, which is #7f7f7f.
    expect(contrastRatio("#00000080", "#ffffff")).toBeCloseTo(
      contrastRatio("#7f7f7f", "#ffffff"),
      2,
    );
    expect(contrastRatio("#000000", "#00000000", "#ffffff")).toBeCloseTo(21, 2);
  });
});

describe("resolveToken", () => {
  it("resolveToken returns an override first", () => {
    expect(resolveToken(theme("dark", { primary: "#3b82f6" }), "primary")).toBe("#3b82f6");
  });

  it("an unset primary-hover follows an overridden primary", () => {
    expect(resolveToken(theme("dark", { primary: "#3b82f6" }), "primary-hover")).toBe("#3b82f6e6");
  });

  it("an unset placeholder follows an overridden muted-foreground", () => {
    expect(resolveToken(theme("light", { "muted-foreground": "#59636b" }), "placeholder")).toBe(
      "#59636bb8",
    );
  });

  it("an unset panel-separator follows an overridden ring", () => {
    expect(resolveToken(theme("light", { ring: "#087f5b" }), "panel-separator")).toBe("#087f5b40");
  });
});

describe("fixed pairs", () => {
  it("failingPairs lists a pair below the minimum and resolves unset tokens", () => {
    const failing = failingPairs(theme("dark", { foreground: "#222222" }), 4.5);
    const labels = failing.map((entry) => `${entry.pair.text} on ${entry.pair.surface}`);
    expect(labels).toContain("foreground on background");
    expect(labels).not.toContain("card-foreground on card");
    const pair = failing.find((entry) => entry.pair.text === "foreground");
    expect(pair?.ratio).toBeLessThan(4.5);
  });

  it("FIXED_PAIRS has the fourteen pairs of the spec, then the four sidebar level pairs of R65, in order", () => {
    expect(FIXED_PAIRS.map((pair) => `${pair.text} on ${pair.surface}`)).toEqual([
      "foreground on background",
      "card-foreground on card",
      "popover-foreground on popover",
      "primary-foreground on primary",
      "secondary-foreground on secondary",
      "accent-foreground on accent",
      "muted-foreground on background",
      "muted-foreground on card",
      "muted-foreground on accent",
      "selected-foreground on selected",
      "placeholder on background",
      "find-match-foreground on find-match",
      "find-match-active-foreground on find-match-active",
      "terminal.foreground on terminal.background",
      "sidebar-primary-badge-foreground on sidebar-primary-badge",
      "sidebar-chat-foreground on sidebar-card",
      "sidebar-chat-foreground on sidebar-env-band",
      "sidebar-chat-foreground on sidebar-worktree",
    ]);
    expect(FIXED_PAIRS.every((pair) => pair.label.length > 0)).toBe(true);
  });
});
