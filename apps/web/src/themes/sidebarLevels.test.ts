// @effect-diagnostics nodeBuiltinImport:off - The level rule check reads the checked-in stylesheet.
import * as NodeFS from "node:fs";

import { type ThemeFile, UI_COLOR_TOKENS } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BASE_TOKEN_VALUES } from "./baseTokenValues";
import { BUILTIN_THEMES } from "./builtinThemes";
import { contrastRatio, FIXED_PAIRS, pairRatios, resolveToken } from "./themeColor";
import { validateThemeFile } from "./themeValidation";

/** The eight sidebar level tokens of R65 (amendment A9). */
const LEVEL_TOKENS = [
  "sidebar-env-accent",
  "sidebar-primary-badge",
  "sidebar-primary-badge-foreground",
  "sidebar-worktree",
  "sidebar-worktree-border",
  "sidebar-worktree-icon",
  "sidebar-chat-foreground",
  "sidebar-indent-guide",
] as const;

/** The level surfaces and markers that must differ from each other in every built-in (R63). */
const DISTINCT_TOKENS = [
  "sidebar-card",
  "sidebar-env-band",
  "sidebar-worktree",
  "sidebar-primary-badge",
  "sidebar-env-accent",
  "sidebar-worktree-icon",
  "sidebar-indent-guide",
] as const;

const LEVEL_PAIRS = [
  "sidebar-primary-badge-foreground on sidebar-primary-badge",
  "sidebar-chat-foreground on sidebar-card",
  "sidebar-chat-foreground on sidebar-env-band",
  "sidebar-chat-foreground on sidebar-worktree",
  "sidebar-worktree-icon on sidebar-worktree",
];

const css = NodeFS.readFileSync(new URL("../index.css", import.meta.url), "utf8");

/** Muted text on a sidebar card paints `--sidebar-card-muted-foreground` (index.css). */
function paintedCardMuted(theme: ThemeFile): string {
  if (theme.ui?.["muted-foreground"] !== undefined) return resolveToken(theme, "muted-foreground");
  return theme.base === "dark" ? "#a1a1a1" : resolveToken(theme, "muted-foreground");
}

const oldDarkFile: ThemeFile = {
  version: 1,
  id: "old-dark",
  name: "Old dark",
  base: "dark",
  ui: { primary: "#3b82f6", background: "#101820" },
};

describe("sidebar level tokens (R65)", () => {
  it("every level token is a supported color token with a light and a dark base value", () => {
    for (const token of LEVEL_TOKENS) {
      expect(UI_COLOR_TOKENS as readonly string[], token).toContain(token);
      for (const base of ["light", "dark"] as const) {
        expect(BASE_TOKEN_VALUES[base][token], `${base} ${token}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("a theme file saved before the level tokens decodes and resolves them from its base", () => {
    expect(validateThemeFile(oldDarkFile, { allowReservedId: false })).toEqual({
      ok: true,
      theme: oldDarkFile,
    });
    const defaults: ThemeFile = { version: 1, id: "plain", name: "Plain", base: "dark" };
    for (const token of LEVEL_TOKENS) {
      expect(resolveToken(oldDarkFile, token), token).toMatch(/^#[0-9a-f]{6}$/);
    }
    // The tinted levels follow the theme's own primary, not the base's orange.
    expect(resolveToken(oldDarkFile, "sidebar-env-accent")).toBe("#3b82f6");
    expect(resolveToken(oldDarkFile, "sidebar-primary-badge")).not.toBe(
      resolveToken(defaults, "sidebar-primary-badge"),
    );
  });

  it("a theme that sets sidebar-worktree and sidebar-primary-badge keeps those values", () => {
    const custom: ThemeFile = {
      ...oldDarkFile,
      ui: { ...oldDarkFile.ui, "sidebar-worktree": "#123456", "sidebar-primary-badge": "#2a2a55" },
    };
    expect(validateThemeFile(custom, { allowReservedId: false }).ok).toBe(true);
    expect(resolveToken(custom, "sidebar-worktree")).toBe("#123456");
    expect(resolveToken(custom, "sidebar-primary-badge")).toBe("#2a2a55");
  });

  it("the fixed pairs cover the level text and surface pairs", () => {
    const pairs = FIXED_PAIRS.map((pair) => `${pair.text} on ${pair.surface}`);
    for (const pair of LEVEL_PAIRS) expect(pairs, pair).toContain(pair);
  });
});

describe("sidebar levels in the built-in themes (R63)", () => {
  for (const theme of BUILTIN_THEMES) {
    it(`${theme.name} resolves the level surfaces and markers to distinct values`, () => {
      const values = DISTINCT_TOKENS.map((token) => resolveToken(theme, token));
      expect(new Set(values).size, values.join(" ")).toBe(DISTINCT_TOKENS.length);
      expect(resolveToken(theme, "sidebar-worktree-border")).not.toBe(
        resolveToken(theme, "sidebar-card-border"),
      );
    });

    it(`${theme.name} keeps every level text pair at or above 4.5:1`, () => {
      for (const { pair, ratio } of pairRatios(theme)) {
        const name = `${pair.text} on ${pair.surface}`;
        if (LEVEL_PAIRS.includes(name)) expect(ratio, name).toBeGreaterThanOrEqual(4.5);
      }
      const behind = resolveToken(theme, "background");
      for (const surface of ["sidebar-env-band", "sidebar-worktree"]) {
        const painted = resolveToken(theme, surface);
        expect(
          contrastRatio(resolveToken(theme, "foreground"), painted, behind),
          `foreground on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(paintedCardMuted(theme), painted, behind),
          `card muted text on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme.name} draws the environment accent rule at or above 3:1 on the band`, () => {
      expect(
        contrastRatio(
          resolveToken(theme, "sidebar-env-accent"),
          resolveToken(theme, "sidebar-env-band"),
        ),
      ).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("sidebar level rules in index.css", () => {
  it("styles each level from data-sidebar-level and the primary checkout from data-primary", () => {
    for (const level of ["environment", "checkout", "worktree", "chat"]) {
      expect(css, level).toContain(`[data-sidebar-level="${level}"]`);
    }
    expect(css).toContain("[data-primary]");
    for (const token of LEVEL_TOKENS) expect(css, token).toContain(`var(--${token})`);
  });
});
