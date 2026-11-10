import type { ThemeFile } from "@bibcode/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const LIBRARY_KEY = "bibcode:themes:v1";
const SLOTS_KEY = "bibcode:theme-slots:v1";
const PAINT_KEY = "bibcode:theme-paint:v1";

function custom(id: string, base: "light" | "dark", ui: Record<string, string> = {}): ThemeFile {
  return { version: 1, id, name: `Theme ${id}`, base, ui };
}

/** A window with an in-memory local storage; import the store after calling this. */
function installStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const writes: string[] = [];
  let failWritesTo: string | null = null;
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWritesTo === key || failWritesTo === "*") throw new Error("QuotaExceededError");
      writes.push(key);
      store.set(key, value);
    },
    removeItem: (key: string) => store.delete(key),
  };
  vi.stubGlobal("window", { localStorage });
  return {
    store,
    writes,
    failWrites: (key: string | null) => {
      failWritesTo = key;
    },
    json: (key: string) => JSON.parse(store.get(key) ?? "null"),
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme library and slots store", () => {
  it("with nothing stored the slots are the built-ins and no key is written", async () => {
    const storage = installStorage();
    const store = await import("./customThemes");
    expect(store.readSlots()).toEqual({ light: "light", dark: "dark" });
    expect(store.listThemes().map((theme) => theme.id)).toEqual([
      "light",
      "dark",
      "tokyo-night",
      "matrix-dark",
      "matrix-light",
      "verdant-light",
    ]);
    expect(storage.writes).toEqual([]);
  });

  it("a light theme cannot be put in the dark slot", async () => {
    installStorage();
    const store = await import("./customThemes");
    expect(store.setSlot("dark", "verdant-light")).toEqual({ ok: false, reason: "wrong-base" });
    expect(store.setSlot("dark", "no-such-theme")).toEqual({ ok: false, reason: "unknown-theme" });
    expect(store.setSlot("dark", "tokyo-night")).toEqual({ ok: true });
    expect(store.readSlots()).toEqual({ light: "light", dark: "tokyo-night" });
  });

  it("saving validates and rejects a reserved id and a 65th theme", async () => {
    installStorage();
    const store = await import("./customThemes");
    expect(store.saveCustomTheme(custom("dark", "dark"))).toMatchObject({
      ok: false,
      errors: [{ field: "id" }],
    });
    for (let index = 0; index < 64; index += 1) {
      expect(store.saveCustomTheme(custom(`theme-${index}`, "dark")).ok).toBe(true);
    }
    expect(store.saveCustomTheme(custom("theme-64", "dark"))).toMatchObject({
      ok: false,
      errors: [{ field: "file", message: expect.stringContaining("64") }],
    });
    expect(store.saveCustomTheme({ ...custom("theme-0", "dark"), name: "Renamed" }).ok).toBe(true);
  });

  it("one corrupt stored entry is skipped and logged and the others load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installStorage({
      [LIBRARY_KEY]: JSON.stringify([
        custom("first", "dark"),
        { ...custom("second", "dark"), ui: { primary: "url(x)" } },
        custom("third", "light"),
      ]),
      [SLOTS_KEY]: JSON.stringify({ light: "third", dark: "second", paintStamp: "x" }),
    });
    const store = await import("./customThemes");
    expect(
      store
        .listThemes()
        .slice(6)
        .map((theme) => theme.id),
    ).toEqual(["first", "third"]);
    expect(store.readSlots()).toEqual({ light: "third", dark: "dark" });
    expect(warn).toHaveBeenCalled();
  });

  it("a slot that points at a missing theme falls back to the built-in of its base", async () => {
    installStorage({
      [SLOTS_KEY]: JSON.stringify({ light: "gone", dark: "also-gone", paintStamp: "x" }),
    });
    const store = await import("./customThemes");
    expect(store.readSlots()).toEqual({ light: "light", dark: "dark" });
  });

  it("deleting a theme in a slot puts the built-in of the same base in that slot", async () => {
    installStorage();
    const store = await import("./customThemes");
    store.saveCustomTheme(custom("mine", "dark"));
    store.setSlot("dark", "mine");
    expect(store.deleteCustomTheme("mine")).toEqual({ ok: true });
    expect(store.readSlots().dark).toBe("dark");
    expect(store.getTheme("mine")).toBeUndefined();
    expect(store.deleteCustomTheme("mine")).toEqual({ ok: false, reason: "unknown-theme" });
  });

  it("deleting a built-in is refused", async () => {
    installStorage();
    const store = await import("./customThemes");
    expect(store.deleteCustomTheme("tokyo-night")).toEqual({ ok: false, reason: "builtin" });
  });

  it('duplicating Tokyo Night gives "Tokyo Night copy" with the same values and a new id that is not reserved', async () => {
    installStorage();
    const store = await import("./customThemes");
    const copy = store.duplicateTheme("tokyo-night");
    const original = store.getTheme("tokyo-night")!;
    expect(copy.name).toBe("Tokyo Night copy");
    expect(copy.ui).toEqual(original.ui);
    expect(copy.terminal).toEqual(original.terminal);
    expect(copy.id).not.toBe("tokyo-night");
    expect(store.getTheme(copy.id)).toEqual(copy);
    expect(["system", "light", "dark", "tokyo-night"]).not.toContain(copy.id);
  });

  it("duplicating twice gives two different ids", async () => {
    installStorage();
    const store = await import("./customThemes");
    expect(store.duplicateTheme("tokyo-night").id).not.toBe(store.duplicateTheme("tokyo-night").id);
  });

  it("resetSlots keeps the library", async () => {
    installStorage();
    const store = await import("./customThemes");
    store.saveCustomTheme(custom("mine", "dark"));
    store.setSlot("dark", "mine");
    store.resetSlots();
    expect(store.readSlots()).toEqual({ light: "light", dark: "dark" });
    expect(store.getTheme("mine")).toBeDefined();
  });

  it("every write rewrites the paint record for both slots", async () => {
    const storage = installStorage();
    const store = await import("./customThemes");
    store.setSlot("dark", "tokyo-night");
    const paint = storage.json(PAINT_KEY);
    expect(paint.dark).toMatchObject({ base: "dark", background: "#1a1b26" });
    expect(paint.dark.vars["--primary"]).toBe("#7aa2f7");
    expect(paint.light).toMatchObject({ base: "light", background: "#ffffff", vars: {} });
    expect(paint.dark.stamp).toBe(storage.json(SLOTS_KEY).paintStamp);
    expect(paint.light.stamp).toBe(paint.dark.stamp);
    expect(storage.writes).toEqual([PAINT_KEY, LIBRARY_KEY, SLOTS_KEY]);
  });

  it("a storage event from another window updates the snapshot and notifies subscribers", async () => {
    const storage = installStorage();
    const store = await import("./customThemes");
    const before = store.getThemesSnapshot();
    expect(store.getThemesSnapshot()).toBe(before);
    const listener = vi.fn();
    store.subscribeThemes(listener);
    const revision = store.getThemeRevision();
    storage.store.set(LIBRARY_KEY, JSON.stringify([custom("remote", "dark")]));
    store.handleThemesStorageEvent({ key: "unrelated" });
    expect(listener).not.toHaveBeenCalled();
    store.handleThemesStorageEvent({ key: LIBRARY_KEY });
    expect(listener).toHaveBeenCalled();
    expect(store.getThemeRevision()).toBeGreaterThan(revision);
    expect(store.getThemesSnapshot()).not.toBe(before);
    expect(store.getThemesSnapshot().themes.map((theme) => theme.id)).toContain("remote");
  });

  it("a failed write (quota) reports an error and leaves the previous library readable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = installStorage();
    const store = await import("./customThemes");
    store.saveCustomTheme(custom("kept", "dark"));
    storage.failWrites(LIBRARY_KEY);
    expect(store.saveCustomTheme(custom("lost", "dark"))).toMatchObject({
      ok: false,
      errors: [{ field: "file" }],
    });
    expect(store.getTheme("kept")).toBeDefined();
    expect(store.getTheme("lost")).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("a missing, corrupt or stale paint record is rebuilt at start from the library and the slots", async () => {
    const seed = installStorage();
    const seeded = await import("./customThemes");
    seeded.saveCustomTheme(custom("mine", "dark", { primary: "#123456" }));
    seeded.setSlot("dark", "mine");
    const good = seed.store.get(PAINT_KEY)!;
    const library = seed.store.get(LIBRARY_KEY)!;
    const slots = seed.store.get(SLOTS_KEY)!;
    for (const paint of [
      undefined,
      "{not json",
      JSON.stringify({ ...JSON.parse(good), dark: { stamp: "old" } }),
    ]) {
      vi.resetModules();
      const initial: Record<string, string> = { [LIBRARY_KEY]: library, [SLOTS_KEY]: slots };
      if (paint !== undefined) initial[PAINT_KEY] = paint;
      const storage = installStorage(initial);
      await import("./customThemes");
      expect(storage.json(PAINT_KEY)).toEqual(JSON.parse(good));
    }
  });

  it("a failure between the library write and the paint write is repaired at the next start", async () => {
    const storage = installStorage();
    const store = await import("./customThemes");
    store.saveCustomTheme(custom("mine", "dark", { primary: "#123456" }));
    store.setSlot("dark", "mine");
    storage.failWrites(LIBRARY_KEY);
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.saveCustomTheme(custom("mine", "dark", { primary: "#654321" }));
    expect(storage.json(PAINT_KEY).dark.stamp).not.toBe(storage.json(SLOTS_KEY).paintStamp);

    storage.failWrites(null);
    vi.resetModules();
    await import("./customThemes");
    expect(storage.json(PAINT_KEY).dark.vars["--primary"]).toBe("#123456");
    expect(storage.json(PAINT_KEY).dark.stamp).toBe(storage.json(SLOTS_KEY).paintStamp);
  });

  it("paint record colors are normalized to hex", async () => {
    installStorage();
    const store = await import("./customThemes");
    const record = store.paintRecordFor(
      custom("mine", "dark", {
        primary: "rgb(255 0 0)",
        border: "hsl(120deg 100% 25% / 50%)",
        background: "#10182080",
        radius: "0.5rem",
        "control-shadow": "none",
      }),
    );
    expect(record.vars).toEqual({
      "--primary": "#ff0000",
      "--border": "#00800080",
      "--background": "#10182080",
      "--radius": "0.5rem",
      "--control-shadow": "none",
    });
    expect(record.background).toMatch(/^#[0-9a-f]{6}$/);
  });
});
