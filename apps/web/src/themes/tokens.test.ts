// @effect-diagnostics nodeBuiltinImport:off - The token checks read the checked-in stylesheet.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const css = NodeFS.readFileSync(new URL("../index.css", import.meta.url), "utf8");

function block(startMarker: string, endMarker: string): string {
  const start = css.indexOf(startMarker);
  const end = css.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`index.css has no block starting at ${startMarker}`);
  return css.slice(start, end);
}

function declarations(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of text.matchAll(/^\s*(--[a-z0-9-]+):\s*([\s\S]*?);/gm)) {
    result[match[1]!] = match[2]!
      .replace(/\s+/g, " ")
      .replace(/\( /g, "(")
      .replace(/ \)/g, ")")
      .trim();
  }
  return result;
}

const themeInline = () => block("@theme inline {", "@keyframes");
const lightBlock = () => block(":root {\n  color-scheme: light;", "@variant dark {");
const darkBlock = () => block("@variant dark {", "\n}\n");

const NEW_TOKEN_MAPPINGS = {
  "--color-foreground-strong": "var(--foreground-strong, var(--foreground))",
  "--color-placeholder":
    "var(--placeholder, color-mix(in srgb, var(--muted-foreground) 72%, transparent))",
  "--color-primary-hover":
    "var(--primary-hover, color-mix(in srgb, var(--primary) 90%, transparent))",
  "--color-primary-active":
    "var(--primary-active, color-mix(in srgb, var(--primary) 90%, transparent))",
  "--color-selected": "var(--selected, var(--accent))",
  "--color-selected-foreground": "var(--selected-foreground, var(--accent-foreground))",
};

// The light and dark token blocks as they were before the custom themes change (#290).
const TOKEN_SNAPSHOT: { light: Record<string, string>; dark: Record<string, string> } = {
  light: {
    "--radius": "0.625rem",
    "--background": "var(--color-white)",
    "--app-chrome-background": "var(--background)",
    "--foreground": "var(--color-neutral-800)",
    "--card": "var(--color-white)",
    "--card-foreground": "var(--color-neutral-800)",
    "--popover": "var(--color-white)",
    "--popover-foreground": "var(--color-neutral-800)",
    "--primary": "#d8610e",
    "--primary-foreground": "var(--color-white)",
    "--secondary": "--alpha(var(--color-black) / 4%)",
    "--secondary-foreground": "var(--color-neutral-800)",
    "--muted": "--alpha(var(--color-black) / 4%)",
    "--muted-foreground": "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-black))",
    "--accent": "--alpha(var(--color-black) / 4%)",
    "--accent-foreground": "var(--color-neutral-800)",
    "--destructive": "var(--color-red-500)",
    "--border": "--alpha(var(--color-black) / 8%)",
    "--input": "--alpha(var(--color-black) / 10%)",
    "--ring": "#d8610e",
    "--panel-separator": "--alpha(var(--ring) / 25%)",
    "--sidebar-well": "color-mix(in srgb, var(--color-black) 4.5%, var(--background))",
    "--sidebar-card": "var(--background)",
    "--sidebar-card-border": "--alpha(var(--color-black) / 9%)",
    "--sidebar-card-shadow": "0 1px 2px --alpha(var(--color-black) / 6%)",
    "--sidebar-env-band": "color-mix(in srgb, var(--color-black) 2.5%, var(--background))",
    "--destructive-foreground": "var(--color-red-700)",
    "--link": "var(--color-blue-700)",
    "--info": "var(--color-blue-500)",
    "--info-foreground": "var(--color-blue-700)",
    "--success": "var(--color-emerald-500)",
    "--success-foreground": "var(--color-emerald-700)",
    "--warning": "var(--color-amber-500)",
    "--warning-foreground": "var(--color-amber-700)",
    "--find-match": "var(--color-amber-200)",
    "--find-match-foreground": "var(--color-neutral-900)",
    "--find-match-active": "var(--color-amber-500)",
    "--find-match-active-foreground": "var(--color-neutral-950)",
  },
  dark: {
    "--background": "color-mix(in srgb, var(--color-neutral-950) 95%, var(--color-white))",
    "--app-chrome-background": "var(--background)",
    "--foreground": "var(--color-neutral-100)",
    "--card": "color-mix(in srgb, var(--background) 98%, var(--color-white))",
    "--card-foreground": "var(--color-neutral-100)",
    "--popover": "color-mix(in srgb, var(--background) 98%, var(--color-white))",
    "--popover-foreground": "var(--color-neutral-100)",
    "--primary": "#d8610e",
    "--primary-foreground": "var(--color-white)",
    "--secondary": "--alpha(var(--color-white) / 4%)",
    "--secondary-foreground": "var(--color-neutral-100)",
    "--muted": "--alpha(var(--color-white) / 4%)",
    "--muted-foreground": "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-white))",
    "--accent": "--alpha(var(--color-white) / 4%)",
    "--accent-foreground": "var(--color-neutral-100)",
    "--destructive": "color-mix(in srgb, var(--color-red-500) 90%, var(--color-white))",
    "--border": "--alpha(var(--color-white) / 6%)",
    "--input": "--alpha(var(--color-white) / 8%)",
    "--ring": "#d8610e",
    "--sidebar-well": "color-mix(in srgb, var(--color-black) 55%, var(--background))",
    "--sidebar-card": "color-mix(in srgb, var(--color-white) 4%, var(--background))",
    "--sidebar-card-border": "--alpha(var(--color-white) / 13%)",
    "--sidebar-card-shadow":
      "inset 0 1px 0 --alpha(var(--color-white) / 5%), 0 2px 6px --alpha(var(--color-black) / 60%)",
    "--sidebar-env-band": "color-mix(in srgb, var(--color-white) 7%, var(--background))",
    "--destructive-foreground": "var(--color-red-400)",
    "--link": "var(--color-blue-400)",
    "--info": "var(--color-blue-500)",
    "--info-foreground": "var(--color-blue-400)",
    "--success": "var(--color-emerald-500)",
    "--success-foreground": "var(--color-emerald-400)",
    "--warning": "var(--color-amber-500)",
    "--warning-foreground": "var(--color-amber-400)",
    "--find-match": "color-mix(in srgb, var(--color-amber-400) 35%, var(--background))",
    "--find-match-foreground": "var(--color-neutral-50)",
    "--find-match-active": "var(--color-amber-300)",
    "--find-match-active-foreground": "var(--color-neutral-950)",
  },
};

describe("new color tokens", () => {
  it("each of the six new tokens has a --color mapping in the theme block with the exact fallback from Interfaces", () => {
    const mapped = declarations(themeInline());
    for (const [name, value] of Object.entries(NEW_TOKEN_MAPPINGS)) {
      expect(mapped[name], name).toBe(value);
    }
  });

  it("none of the six variables is declared in the light or dark block", () => {
    const declared = { ...declarations(lightBlock()), ...declarations(darkBlock()) };
    for (const name of Object.keys(NEW_TOKEN_MAPPINGS)) {
      expect(declared[name.replace("--color-", "--")], name).toBeUndefined();
    }
  });

  it("no existing token value in the light or dark block changed", () => {
    const light = declarations(lightBlock());
    const dark = declarations(darkBlock());
    for (const [name, value] of Object.entries(TOKEN_SNAPSHOT.light)) {
      expect(light[name], `light ${name}`).toBe(value);
    }
    for (const [name, value] of Object.entries(TOKEN_SNAPSHOT.dark)) {
      expect(dark[name], `dark ${name}`).toBe(value);
    }
  });
});
