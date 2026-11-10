import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readPreviewAnnotationTheme } from "./annotationTheme";

const originalDocument = globalThis.document;
const originalGetComputedStyle = globalThis.getComputedStyle;

function installComputedStyle(values: ReadonlyMap<string, string>): void {
  globalThis.document = {
    documentElement: { classList: { contains: () => false } },
  } as unknown as Document;
  globalThis.getComputedStyle = (() => ({
    fontFamily: "system-ui",
    getPropertyValue: (name: string) => values.get(name) ?? "",
  })) as unknown as typeof getComputedStyle;
}

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalGetComputedStyle === undefined) {
    delete (globalThis as { getComputedStyle?: typeof getComputedStyle }).getComputedStyle;
  } else {
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

describe("readPreviewAnnotationTheme", () => {
  it("falls back to the approved interaction colors", () => {
    installComputedStyle(new Map());

    expect(readPreviewAnnotationTheme()).toMatchObject({
      primary: "#d8610e",
      primaryForeground: "white",
      ring: "#d8610e",
    });
  });

  it("prefers live semantic tokens over fallbacks", () => {
    installComputedStyle(
      new Map([
        ["--primary", "rgb(1 2 3)"],
        ["--ring", "rgb(4 5 6)"],
      ]),
    );

    expect(readPreviewAnnotationTheme()).toMatchObject({
      primary: "rgb(1 2 3)",
      ring: "rgb(4 5 6)",
    });
  });
});

describe("annotation colors follow the applied theme (#290, R58)", () => {
  /** A browser for the theme modules; import them after calling this. */
  async function installBrowser() {
    const browser = new Window({ url: "https://bibcode.test/" });
    browser.localStorage.setItem("bibcode:theme", "dark");
    vi.stubGlobal("window", browser);
    vi.stubGlobal("document", browser.document);
    vi.stubGlobal("getComputedStyle", browser.getComputedStyle.bind(browser));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.resetModules();
    return {
      browser,
      annotation: await import("./annotationTheme"),
      store: await import("../themes/customThemes"),
      theme: await import("../hooks/useTheme"),
      setMode: (mode: string) => {
        browser.localStorage.setItem("bibcode:theme", mode);
        browser.dispatchEvent(new browser.StorageEvent("storage", { key: "bibcode:theme" }));
      },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("the annotation reader returns the new primary after a theme change", async () => {
    const { annotation, store } = await installBrowser();
    store.setSlot("dark", "tokyo-night");
    expect(annotation.readPreviewAnnotationTheme().primary).toBe("#7aa2f7");
  });

  it("watchAnnotationTheme pushes once and again after a slot change, a mode change, a preview and a Cancel", async () => {
    const { annotation, store, theme, setMode } = await installBrowser();
    const pushes: { colorScheme: string; primary: string }[] = [];
    annotation.watchAnnotationTheme((colors) => pushes.push(colors));
    expect(pushes).toHaveLength(1);

    store.setSlot("dark", "tokyo-night");
    expect(pushes.at(-1)?.primary).toBe("#7aa2f7");
    setMode("light");
    expect(pushes.at(-1)?.colorScheme).toBe("light");
    theme.setThemePreview({
      version: 1,
      id: "draft",
      name: "Draft",
      base: "light",
      ui: { primary: "#087f5b" },
    });
    expect(pushes.at(-1)?.primary).toBe("#087f5b");
    theme.setThemePreview(null);
    expect(pushes).toHaveLength(5);
    expect(pushes.at(-1)?.primary).not.toBe("#087f5b");
  });

  it("the returned function stops further pushes", async () => {
    const { annotation, store } = await installBrowser();
    const push = vi.fn();
    const stop = annotation.watchAnnotationTheme(push);
    stop();
    store.setSlot("dark", "tokyo-night");
    expect(push).toHaveBeenCalledOnce();
  });
});
