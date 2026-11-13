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
  "foreground on sidebar-env-band",
  "foreground on sidebar-worktree",
  "sidebar-card-muted-foreground on sidebar-env-band",
  "sidebar-card-muted-foreground on sidebar-worktree",
  "sidebar-worktree-icon on sidebar-worktree",
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

    it(`${theme.name} keeps every sidebar level pair at or above its minimum`, () => {
      for (const { pair, ratio } of pairRatios(theme)) {
        const name = `${pair.text} on ${pair.surface}`;
        if (LEVEL_PAIRS.includes(name)) expect(ratio, name).toBeGreaterThanOrEqual(pair.minimum);
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

/** A state rule's declarations, with the dark base's overrides on top when it has any. */
function stateRule(theme: ThemeFile, selector: string): Map<string, string> {
  const shared = ruleDeclarations(selector);
  if (theme.base !== "dark") return shared;
  try {
    return new Map([...shared, ...ruleDeclarations(`.dark ${selector}`)]);
  } catch {
    return shared;
  }
}

/** What the row rules of index.css paint on a checkout or worktree row in each state (R64). */
function themeOverrides(theme: ThemeFile): Record<string, string> {
  return Object.fromEntries(
    Object.entries(theme.ui ?? {})
      .filter(([token]) => (UI_COLOR_TOKENS as readonly string[]).includes(token))
      .map(([token, value]) => [token, toHex(value)]),
  );
}

function paintRows(theme: ThemeFile, level: "checkout" | "worktree") {
  const overrides = themeOverrides(theme);
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
        label: evaluate(ruleDeclarations("[data-sidebar-label]").get("color")!),
        chat: resolve("sidebar-chat-foreground"),
        muted: resolveSidebarMuted(theme),
      },
    };
  for (const [state, selector] of Object.entries(STATES)) {
    const rule =
      level === "checkout" && state === "hover"
        ? ruleDeclarations('[data-sidebar-level="checkout"]:hover')
        : stateRule(theme, selector);
    const fill = rule.get("background-color");
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

describe("checkout and worktree row state rule order (R64)", () => {
  it("hover, active, selected and selected+active are unlayered and appear in that order", () => {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    const ROW = ':is([data-sidebar-level="checkout"], [data-sidebar-level="worktree"])';
    const hover = flat.indexOf(`${ROW}:hover {`);
    const active = flat.indexOf(`${ROW}[data-active="true"] {`);
    const selected = flat.indexOf(`${ROW}[data-selected="true"] {`);
    const selectedActive = flat.search(
      /:is\( \[data-sidebar-level="checkout"\], \[data-sidebar-level="worktree"\] \)\[data-selected="true"\]\[data-active="true"\] \{/,
    );
    const at = [hover, active, selected, selectedActive];
    expect(
      at.every((index) => index >= 0),
      `all four rules found: ${at}`,
    ).toBe(true);
    expect(at, "source order").toEqual(at.toSorted((x, y) => x - y));
    for (const index of at) {
      const before = flat.slice(0, index);
      const depth = before.split("{").length - before.split("}").length;
      expect(depth, "outside @layer and every other block").toBe(0);
    }
  });
});

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
      // 1.09:1 is about one and a half times the old 3 percent step (1.054:1 in five built-ins).
      expect(fromRest("hover"), "hover differs from resting").toBeGreaterThanOrEqual(1.09);
      expect(fromRest("active"), "active beyond hover").toBeGreaterThan(fromRest("hover"));
      expect(fromRest("selected"), "selected beyond hover").toBeGreaterThan(
        fromRest("hover") * 1.05,
      );
      expect(
        fromRest("selected and active"),
        "selected and active beyond selected",
      ).toBeGreaterThan(fromRest("selected"));
    });

    it(`${theme.name} paints a hovered checkout visibly over the band it rests on`, () => {
      const { surfaces } = paintRows(theme, "checkout");
      expect(
        contrastRatio(surfaces.hover!.surface, surfaces.resting!.surface),
        "hover differs from resting",
      ).toBeGreaterThanOrEqual(1.09);
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
          compositeHex(evaluate(stateRule(theme, selector).get("border-color")!), band),
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

describe("unread rows (R63)", () => {
  const UNREAD_TEXT =
    '[data-sidebar-label][data-unread="true"], [data-sidebar-level="chat"][data-unread="true"]';

  it("marks unread with a dot and the text at foreground, never a dimmer colour", () => {
    expect(ruleDeclarations("[data-sidebar-unread]").get("background-color")).toMatch(
      /^var\(--[a-z-]+\)$/,
    );
    expect(ruleDeclarations(UNREAD_TEXT).get("color")).toBe("var(--foreground)");
  });

  for (const theme of BUILTIN_THEMES) {
    it(`${theme.name} draws the unread dot at 3:1 and unread text at 4.5:1 on every row state`, () => {
      const evaluate = (expression: string) =>
        evaluateCssTokens(theme.base, { ...themeOverrides(theme), "probe-value": expression })(
          "probe-value",
        );
      const dot = evaluate(ruleDeclarations("[data-sidebar-unread]").get("background-color")!);
      const text = evaluate(ruleDeclarations(UNREAD_TEXT).get("color")!);
      for (const level of ["checkout", "worktree"] as const) {
        for (const [state, painted] of Object.entries(paintRows(theme, level).surfaces)) {
          expect(
            contrastRatio(dot, painted.surface),
            `${level} ${state} dot`,
          ).toBeGreaterThanOrEqual(3);
          expect(
            contrastRatio(text, painted.surface),
            `${level} ${state} unread text`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});

describe("environment band outside a repository card (R63)", () => {
  it("paints muted text in the sidebar card's muted colour, which the band pairs check", () => {
    expect(ruleDeclarations('[data-sidebar-level="environment"]').get("--muted-foreground")).toBe(
      "var(--sidebar-card-muted-foreground)",
    );
  });
});

describe("unavailable environment band (R63)", () => {
  const UNAVAILABLE = '[data-sidebar-level="environment"][data-unavailable="true"]';

  it("weakens the band fill and the accent rule, with no opacity that would fade its rows", () => {
    const rule = ruleDeclarations(UNAVAILABLE);
    expect(rule.get("background-color")).toContain("var(--sidebar-env-band)");
    expect(rule.get("box-shadow")).toContain("var(--sidebar-env-accent)");
    expect(rule.has("opacity")).toBe(false);
  });

  for (const theme of BUILTIN_THEMES) {
    it(`${theme.name} keeps label, chat and muted text at 4.5:1 on the weaker band fill`, () => {
      const overrides = themeOverrides(theme);
      const evaluate = (expression: string) =>
        evaluateCssTokens(theme.base, { ...overrides, "probe-value": expression })("probe-value");
      const resolve = (token: string) => resolveToken(theme, token);
      const card = compositeHex(
        resolve("sidebar-card"),
        compositeHex(resolve("sidebar-well"), resolve("background")),
      );
      const fill = compositeHex(
        evaluate(ruleDeclarations(UNAVAILABLE).get("background-color")!),
        card,
      );
      const text = {
        label: evaluate(ruleDeclarations("[data-sidebar-label]").get("color")!),
        chat: resolve("sidebar-chat-foreground"),
        muted: resolveSidebarMuted(theme),
      };
      for (const [name, color] of Object.entries(text)) {
        const ratio = contrastRatio(color, fill);
        expect(ratio, `${name} on the unavailable band`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
