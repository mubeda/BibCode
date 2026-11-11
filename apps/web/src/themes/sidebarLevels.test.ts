// @effect-diagnostics nodeBuiltinImport:off - The level rule check reads the checked-in stylesheet.
import * as NodeFS from "node:fs";

import { type ThemeFile, UI_COLOR_TOKENS } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BASE_TOKEN_VALUES } from "./baseTokenValues";
import { BUILTIN_THEMES } from "./builtinThemes";
import { evaluateCssTokens, ruleDeclarations } from "./cssTokenEvaluator.testSupport";
import {
  compositeHex,
  contrastRatio,
  FIXED_PAIRS,
  pairRatios,
  resolveSidebarMuted,
  resolveToken,
  toHex,
} from "./themeColor";
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
];

const css = NodeFS.readFileSync(new URL("../index.css", import.meta.url), "utf8");

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
          contrastRatio(resolveSidebarMuted(theme), painted, behind),
          `card muted text on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme.name} draws the accent rule and the worktree icon at or above 3:1`, () => {
      const graphic = (marker: string, surface: string) =>
        contrastRatio(resolveToken(theme, marker), resolveToken(theme, surface));
      expect(graphic("sidebar-env-accent", "sidebar-env-band"), "accent").toBeGreaterThanOrEqual(3);
      expect(graphic("sidebar-worktree-icon", "sidebar-worktree"), "icon").toBeGreaterThanOrEqual(
        3,
      );
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

const ROWS = ':is([data-sidebar-level="checkout"], [data-sidebar-level="worktree"])';
const STATES = {
  hover: `${ROWS}:hover`,
  active: `${ROWS}[data-active="true"]`,
  selected: `${ROWS}[data-selected="true"]`,
  "selected and active": `${ROWS}[data-selected="true"][data-active="true"]`,
} as const;

/** What the row rules of index.css paint on a checkout or worktree row in each state (R64). */
function paintRows(theme: ThemeFile, level: "checkout" | "worktree") {
  const overrides: Record<string, string> = Object.fromEntries(
    Object.entries(theme.ui ?? {})
      .filter(([token]) => (UI_COLOR_TOKENS as readonly string[]).includes(token))
      .map(([token, value]) => [token, toHex(value)]),
  );
  const worktree = ruleDeclarations('[data-sidebar-level="worktree"]');
  const evaluate = (expression: string) =>
    evaluateCssTokens(theme.base, { ...overrides, "probe-value": expression })("probe-value");
  const resolve = (token: string) => resolveToken(theme, token);
  const card = compositeHex(
    resolve("sidebar-card"),
    compositeHex(resolve("sidebar-well"), resolve("background")),
  );
  const band = compositeHex(resolve("sidebar-env-band"), card);
  // A checkout row paints no surface of its own at rest.
  const rest =
    level === "worktree" ? compositeHex(evaluate(worktree.get("background-color")!), band) : band;
  const inState = `${ROWS}:is(:hover, [data-active="true"], [data-selected="true"])`;
  const stateLabel = ruleDeclarations(
    `${ROWS}:not([data-primary]):is(:hover, [data-active="true"], [data-selected="true"]) [data-sidebar-label]`,
  ).get("color")!;
  const stateMuted = ruleDeclarations(inState).get("--muted-foreground")!;
  const surfaces: Record<string, { surface: string; label: string; chat: string; muted: string }> =
    {
      resting: {
        surface: rest,
        label: evaluate("color-mix(in srgb, var(--foreground) 90%, transparent)"),
        chat: resolve("sidebar-chat-foreground"),
        muted: resolveSidebarMuted(theme),
      },
    };
  for (const [state, selector] of Object.entries(STATES)) {
    const fill = ruleDeclarations(selector).get("background-color");
    expect(fill, `${selector} sets a background`).toBeDefined();
    surfaces[state] = {
      surface: compositeHex(evaluate(fill!), band),
      label: evaluate(stateLabel),
      chat: resolve("sidebar-chat-foreground"),
      muted: evaluate(stateMuted),
    };
  }
  return { band, surfaces };
}

describe("checkout and worktree row states (R63, R64)", () => {
  for (const theme of BUILTIN_THEMES) {
    for (const level of ["checkout", "worktree"] as const) {
      it(`${theme.name} keeps label, chat and muted text at 4.5:1 on every ${level} state`, () => {
        const { surfaces } = paintRows(theme, level);
        for (const [state, painted] of Object.entries(surfaces)) {
          for (const text of ["label", "chat", "muted"] as const) {
            expect(
              contrastRatio(painted[text], painted.surface),
              `${level} ${state} ${text}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      });
    }

    it(`${theme.name} paints a hovered worktree over its surface and a selected one clearly stronger`, () => {
      const { surfaces } = paintRows(theme, "worktree");
      const fromRest = (state: string) =>
        contrastRatio(surfaces[state]!.surface, surfaces.resting!.surface);
      expect(fromRest("hover"), "hover differs from resting").toBeGreaterThan(1.03);
      expect(fromRest("selected"), "selected beyond hover").toBeGreaterThan(
        fromRest("hover") * 1.05,
      );
      expect(
        fromRest("selected and active"),
        "selected and active beyond selected",
      ).toBeGreaterThan(fromRest("selected"));
    });
  }

  it("gives an active row a stronger border than a resting worktree and keeps the selection borders", () => {
    const worktree = ruleDeclarations('[data-sidebar-level="worktree"]');
    expect(worktree.get("border-color")).toBe("var(--sidebar-worktree-border)");
    for (const theme of BUILTIN_THEMES) {
      const { band } = paintRows(theme, "worktree");
      const evaluate = (expression: string) =>
        evaluateCssTokens(theme.base, { "probe-value": expression })("probe-value");
      const border = (selector: string) =>
        contrastRatio(
          compositeHex(evaluate(ruleDeclarations(selector).get("border-color")!), band),
          band,
        );
      expect(border(STATES.active), `${theme.name} active border`).toBeGreaterThan(
        contrastRatio(compositeHex(resolveToken(theme, "sidebar-worktree-border"), band), band),
      );
    }
    expect(ruleDeclarations(STATES.selected).get("border-color")).toContain("var(--primary) 40%");
    expect(ruleDeclarations(STATES["selected and active"]).get("border-color")).toContain(
      "var(--primary) 60%",
    );
  });
});
