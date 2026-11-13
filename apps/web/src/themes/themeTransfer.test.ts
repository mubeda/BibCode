import type { ThemeFile } from "@bibcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { contrastRatio } from "./themeColor";

/** A window with an in-memory local storage; import the modules after calling this. */
function installStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  });
}

async function load() {
  return {
    transfer: await import("./themeTransfer"),
    store: await import("./customThemes"),
  };
}

const night: ThemeFile = {
  version: 1,
  id: "night",
  name: "Night",
  base: "dark",
  ui: { primary: "#1d4ed8" },
  terminal: { red: "#ff5555" },
};

beforeEach(() => installStorage());
afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("theme export and import", () => {
  it("export then import gives an equal theme", async () => {
    const { transfer } = await load();
    const json = transfer.exportThemeJson(night);
    expect(json.endsWith("}\n")).toBe(true);
    expect(json).toContain('\n  "version": 1,\n  "id": "night"');
    const plan = transfer.planThemeImport(json);
    expect(plan).toEqual({ ok: true, theme: night, resetPairs: [], conflict: false });
  });

  it("a translucent Dark background with card text at 4.5:1 on the derived card keeps that text", async () => {
    const { transfer } = await load();
    const file: ThemeFile = {
      version: 1,
      id: "alpha-background",
      name: "Alpha background",
      base: "dark",
      ui: { background: "#000000e6", "card-foreground": "#787779" },
    };
    const plan = transfer.planThemeImport(JSON.stringify(file));
    expect(plan).toEqual({ ok: true, theme: file, resetPairs: [], conflict: false });
  });

  it("invalid JSON gives one error on the file field", async () => {
    const { transfer } = await load();
    const plan = transfer.planThemeImport("{ not json");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.field).toBe("file");
  });

  it("two invalid colors give two field errors and no theme", async () => {
    const { transfer, store } = await load();
    const plan = transfer.planThemeImport(
      JSON.stringify({ ...night, ui: { primary: "url(x)" }, terminal: { red: "red" } }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors.map((error) => error.field)).toEqual(["ui.primary", "terminal.red"]);
    expect(store.getTheme("night")).toBeUndefined();
  });

  it("a file over 16 KiB is rejected by size", async () => {
    const { transfer } = await load();
    const plan = transfer.planThemeImport(`${JSON.stringify(night)}${" ".repeat(17 * 1024)}`);
    expect(plan).toEqual({
      ok: false,
      errors: [{ field: "file", message: "A theme file can be at most 16 KiB." }],
    });
  });

  it("a built-in id is rejected as reserved", async () => {
    const { transfer } = await load();
    const plan = transfer.planThemeImport(JSON.stringify({ ...night, id: "tokyo-night" }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors).toEqual([{ field: "id", message: "This id belongs to a built-in theme." }]);
  });

  it("an existing custom id sets conflict and replace overwrites while keep-both stores a second theme with a new id", async () => {
    const { transfer, store } = await load();
    store.saveCustomTheme({ ...night, ui: { primary: "#00ff00" } });
    const plan = transfer.planThemeImport(transfer.exportThemeJson(night));
    expect(plan.ok && plan.conflict).toBe(true);
    if (!plan.ok) return;
    expect(store.getTheme("night")?.ui?.primary).toBe("#00ff00");

    transfer.commitThemeImport(plan, "replace");
    expect(store.getTheme("night")?.ui?.primary).toBe("#1d4ed8");

    const copy = transfer.commitThemeImport(plan, "keep-both")!;
    expect(copy.id).not.toBe("night");
    expect(store.getTheme(copy.id)).toEqual(copy);
    expect(store.getTheme("night")).toBeDefined();
  });

  it("an import with no conflict at validation stores nothing when another window stored that id before Import", async () => {
    const { transfer, store } = await load();
    const plan = transfer.planThemeImport(transfer.exportThemeJson(night));
    expect(plan.ok && !plan.conflict).toBe(true);
    if (!plan.ok) return;
    store.saveCustomTheme({ ...night, ui: { primary: "#00ff00" } });

    expect(transfer.commitThemeImport(plan, "import")).toBeNull();
    expect(store.getTheme("night")?.ui?.primary).toBe("#00ff00");
    expect(store.listThemes().filter((theme) => theme.name === "Night")).toHaveLength(1);
  });

  it("a muted text of 2.1:1 on background is reset, the pair is listed, other overrides are kept, and exporting and importing the result changes nothing more", async () => {
    const { transfer, store } = await load();
    const muted = "#484d55";
    expect(contrastRatio(muted, "#161616")).toBeCloseTo(2.1, 1);
    const plan = transfer.planThemeImport(
      JSON.stringify({ ...night, ui: { ...night.ui, "muted-foreground": muted } }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.resetPairs.map((pair) => `${pair.text}:${pair.surface}`)).toEqual([
      "muted-foreground:background",
    ]);
    expect(plan.theme).toEqual(night);

    const stored = transfer.commitThemeImport(plan, "replace")!;
    expect(store.getTheme("night")).toEqual(night);
    const again = transfer.planThemeImport(transfer.exportThemeJson(stored));
    expect(again).toMatchObject({ ok: true, theme: night, resetPairs: [] });
  });

  it("a pair that still fails after the text reset also loses its surface override", async () => {
    const { transfer } = await load();
    const plan = transfer.planThemeImport(
      JSON.stringify({
        ...night,
        ui: { ...night.ui, card: "#eeeeee", "card-foreground": "#dddddd" },
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.resetPairs.map((pair) => `${pair.text}:${pair.surface}`)).toEqual([
      "card-foreground:card",
    ]);
    expect(plan.theme.ui).toEqual(night.ui);
  });

  it("an unreadable primary badge falls back to the base badge text, the pair is named and the other sidebar overrides are kept (R65)", async () => {
    const { transfer } = await load();
    const badge = {
      "sidebar-primary-badge": "#3a2a1a",
      "sidebar-primary-badge-foreground": "#3b2b1b",
      "sidebar-worktree": "#202830",
    };
    const plan = transfer.planThemeImport(
      JSON.stringify({ ...night, ui: { ...night.ui, ...badge } }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.resetPairs.map((pair) => `${pair.text}:${pair.surface}`)).toEqual([
      "sidebar-primary-badge-foreground:sidebar-primary-badge",
    ]);
    expect(plan.theme.ui).toEqual({
      ...night.ui,
      "sidebar-primary-badge": "#3a2a1a",
      "sidebar-worktree": "#202830",
    });
    const again = transfer.planThemeImport(transfer.exportThemeJson(plan.theme));
    expect(again).toMatchObject({ ok: true, theme: plan.theme, resetPairs: [] });
  });

  it("sidebar surfaces that make the global text unreadable lose only their own overrides, and an unreadable worktree icon loses its override", async () => {
    const { transfer } = await load();
    const grey = {
      "muted-foreground": "#999999",
      "sidebar-env-band": "#444444",
      "sidebar-worktree": "#444444",
      "sidebar-worktree-icon": "#444444",
    };
    const plan = transfer.planThemeImport(
      JSON.stringify({ ...night, ui: { ...night.ui, ...grey } }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.theme.ui).toEqual({ ...night.ui, "muted-foreground": "#999999" });
    const reset = plan.resetPairs.map((pair) => `${pair.text}:${pair.surface}`);
    expect(reset).toContain("sidebar-card-muted-foreground:sidebar-env-band");
    expect(reset).toContain("sidebar-worktree-icon:sidebar-worktree");
    const again = transfer.planThemeImport(transfer.exportThemeJson(plan.theme));
    expect(again).toMatchObject({ ok: true, theme: plan.theme, resetPairs: [] });
  });

  it("a Dark import that sets only the band, the worktree and its icon to #444444 loses all three, the default muted text named first", async () => {
    const { transfer } = await load();
    const file: ThemeFile = {
      version: 1,
      id: "grey",
      name: "Grey",
      base: "dark",
      ui: {
        "sidebar-env-band": "#444444",
        "sidebar-worktree": "#444444",
        "sidebar-worktree-icon": "#444444",
      },
    };
    const plan = transfer.planThemeImport(JSON.stringify(file));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const { ui: _ui, ...withoutUi } = file;
    expect(plan.theme).toEqual(withoutUi);
    const reset = plan.resetPairs.map((pair) => `${pair.text}:${pair.surface}`);
    expect(reset[0]).toBe("sidebar-card-muted-foreground:sidebar-env-band");
    expect(reset).toContain("sidebar-worktree-icon:sidebar-worktree");
  });

  it("a light theme saved with only sidebar-env-band #262626 loses that override through the chat pair (R65)", async () => {
    const { transfer } = await load();
    const old: ThemeFile = {
      version: 1,
      id: "old-band",
      name: "Old band",
      base: "light",
      ui: { "sidebar-env-band": "#262626" },
    };
    const plan = transfer.planThemeImport(JSON.stringify(old));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const { ui: _ui, ...withoutUi } = old;
    expect(plan.theme).toEqual(withoutUi);
    expect(plan.resetPairs.map((pair) => `${pair.text}:${pair.surface}`)).toEqual([
      "sidebar-chat-foreground:sidebar-env-band",
    ]);
  });

  it("a light import that sets only the background, with the default placeholder, keeps its background and resets nothing (amendment A3)", async () => {
    const { transfer } = await load();
    // Built-in Light already fails placeholder on background (about 3.1:1). The import is not
    // below that pair, so nothing is reset.
    const paper: ThemeFile = {
      version: 1,
      id: "paper",
      name: "Paper",
      base: "light",
      ui: { background: "#fff" },
    };
    const plan = transfer.planThemeImport(JSON.stringify(paper));
    expect(plan).toEqual({ ok: true, theme: paper, resetPairs: [], conflict: false });
  });

  it.each([
    ["light", "#fffdf8"],
    ["dark", "#101820"],
  ] as const)(
    "a %s import that sets only background %s keeps it, with no notice (amendment A3, revised)",
    async (base, background) => {
      const { transfer } = await load();
      const theme: ThemeFile = {
        version: 1,
        id: "tinted",
        name: "Tinted",
        base,
        ui: { background },
      };
      const plan = transfer.planThemeImport(JSON.stringify(theme));
      expect(plan).toEqual({ ok: true, theme, resetPairs: [], conflict: false });
    },
  );

  it("a light import that sets background #fffdf8 and placeholder #cccccc loses the placeholder, names it, and keeps the background (R55)", async () => {
    const { transfer } = await load();
    const theme: ThemeFile = {
      version: 1,
      id: "cream",
      name: "Cream",
      base: "light",
      ui: { background: "#fffdf8", placeholder: "#cccccc" },
    };
    const plan = transfer.planThemeImport(JSON.stringify(theme));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.resetPairs.map((pair) => `${pair.text}:${pair.surface}`)).toEqual([
      "placeholder:background",
    ]);
    expect(plan.theme.ui).toEqual({ background: "#fffdf8" });
  });

  it("a light import whose placeholder is under 4.5:1 loses that override and the pair is named, although the base fails the pair too", async () => {
    const { transfer } = await load();
    const theme: ThemeFile = {
      version: 1,
      id: "faint",
      name: "Faint",
      base: "light",
      ui: { placeholder: "#cccccc" },
    };
    const plan = transfer.planThemeImport(JSON.stringify(theme));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.resetPairs.map((pair) => `${pair.text}:${pair.surface}`)).toEqual([
      "placeholder:background",
    ]);
    expect(plan.theme.ui).toBeUndefined();
  });
});
