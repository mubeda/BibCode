import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Window } from "happy-dom";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

const openWindows: Window[] = [];

/**
 * A browser with a controllable OS colour scheme. Stubs the globals the theme
 * module reads at import, so import the module after calling this.
 */
function installThemeBrowser({
  stored = null,
  prefersDark = false,
}: { stored?: string | null; prefersDark?: boolean } = {}) {
  const browserWindow = new Window({ url: "https://bibcode.test/" });
  openWindows.push(browserWindow);
  const storage = createStorage();
  if (stored !== null) storage.setItem("bibcode:theme", stored);
  let matches = prefersDark;
  const mediaListeners = new Set<() => void>();
  const media = {
    get matches() {
      return matches;
    },
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  };
  const storageListeners = new Set<(event: StorageEvent) => void>();
  Object.defineProperties(browserWindow, {
    localStorage: { configurable: true, value: storage },
    matchMedia: { configurable: true, value: () => media },
  });
  const addEventListener = browserWindow.addEventListener.bind(browserWindow);
  const removeEventListener = browserWindow.removeEventListener.bind(browserWindow);
  vi.spyOn(browserWindow, "addEventListener").mockImplementation((type, listener) => {
    if (type === "storage") {
      storageListeners.add(listener as unknown as (event: StorageEvent) => void);
    }
    addEventListener(type, listener);
  });
  vi.spyOn(browserWindow, "removeEventListener").mockImplementation((type, listener) => {
    if (type === "storage") {
      storageListeners.delete(listener as unknown as (event: StorageEvent) => void);
    }
    removeEventListener(type, listener);
  });
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", browserWindow.document);
  vi.stubGlobal("getComputedStyle", browserWindow.getComputedStyle.bind(browserWindow));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  return {
    browserWindow,
    storage,
    isDark: () => browserWindow.document.documentElement.classList.contains("dark"),
    mediaListenerCount: () => mediaListeners.size,
    storageListenerCount: () => storageListeners.size,
    switchOs: (dark: boolean) => {
      matches = dark;
      for (const listener of mediaListeners) listener();
    },
    fireStorage: (key: string) => {
      for (const listener of storageListeners) listener({ key } as StorageEvent);
    },
  };
}

/** Lets tests call `useTheme()` outside React; every call subscribes like a mounted component. */
function mockReactForHookCalls(
  onSubscribe: (unsubscribe: () => void) => void,
  listener = () => {},
) {
  vi.doMock("react", () => ({
    useCallback: <A>(callback: A) => callback,
    useEffect: (effect: () => void) => effect(),
    useSyncExternalStore: (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => {
      onSubscribe(subscribe(listener));
      return getSnapshot();
    },
  }));
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const browserWindow of openWindows.splice(0)) browserWindow.close();
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "bibcode:theme",
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "bibcode:theme",
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
        style: { removeProperty: vi.fn(), setProperty: vi.fn() },
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for bibcode:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "bibcode:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    // The theme library logs its own read failure; neither log carries the raw cause.
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const getItem = vi.fn(() => {
      throw cause;
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => {
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
        style: { removeProperty: vi.fn(), setProperty: vi.fn() },
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
      },
    });

    // The theme library reads its own keys; only reads and logs of the mode count here.
    const modeReads = () =>
      getItem.mock.calls.filter((call) => (call as unknown[])[0] === "bibcode:theme").length;
    const modeLogs = () =>
      errorLog.mock.calls.filter(([message]) => String(message).includes("theme preference"))
        .length;
    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(modeReads()).toBe(1);
    expect(modeLogs()).toBe(1);

    storageHandler?.({ key: "unrelated" } as StorageEvent);
    readSnapshot?.();
    expect(modeReads()).toBe(1);

    storageHandler?.({ key: "bibcode:theme" } as StorageEvent);
    readSnapshot?.();

    expect(modeReads()).toBe(2);
    expect(modeLogs()).toBe(2);
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", { desktopBridge: { setTheme } });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    setTheme.mockClear();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({
        theme: "dark",
        errorTag: "DesktopThemeSyncError",
      }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });

  it("uses server-safe defaults and validates stored browser preferences", async () => {
    vi.stubGlobal("window", undefined);
    const serverModule = await import("./useTheme");
    expect(serverModule.readThemePreference()).toBe("system");
    expect(() => serverModule.writeThemePreference("dark")).not.toThrow();
    expect(() => serverModule.syncDesktopTheme("dark")).not.toThrow();

    vi.resetModules();
    const storage = createStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const browserModule = await import("./useTheme");
    for (const theme of ["light", "dark", "system"] as const) {
      storage.setItem("bibcode:theme", theme);
      expect(browserModule.readThemePreference()).toBe(theme);
    }
    storage.setItem("bibcode:theme", "invalid");
    expect(browserModule.readThemePreference()).toBe("system");
    browserModule.writeThemePreference("light");
    expect(storage.getItem("bibcode:theme")).toBe("light");
  });

  it("synchronizes browser chrome colors and reuses its dynamic meta tag", async () => {
    const browserWindow = new Window({ url: "https://bibcode.test/" });
    const surface = browserWindow.document.createElement("main");
    surface.setAttribute("data-slot", "sidebar-inset");
    surface.style.backgroundColor = "rgb(12, 34, 56)";
    browserWindow.document.body.style.backgroundColor = "rgb(90, 80, 70)";
    browserWindow.document.body.append(surface);
    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("document", browserWindow.document);
    vi.stubGlobal("getComputedStyle", browserWindow.getComputedStyle.bind(browserWindow));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const { syncBrowserChromeTheme } = await import("./useTheme");
    syncBrowserChromeTheme();
    expect(browserWindow.document.documentElement.style.backgroundColor).toBe("rgb(12, 34, 56)");
    expect(
      browserWindow.document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    ).toBe("rgb(12, 34, 56)");

    surface.style.backgroundColor = "transparent";
    browserWindow.document.body.style.backgroundColor = "rgb(90, 80, 70)";
    syncBrowserChromeTheme();
    expect(browserWindow.document.body.style.backgroundColor).toBe("rgb(90, 80, 70)");
    expect(browserWindow.document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);

    surface.remove();
    browserWindow.document.body.style.backgroundColor = "rgba(0, 0, 0, 0)";
    syncBrowserChromeTheme();
    expect(browserWindow.document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    browserWindow.close();
  });

  it("applies system changes, storage events, and successful desktop sync through the hook", async () => {
    const browser = installThemeBrowser({ stored: "system", prefersDark: true });
    const setTheme = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(browser.browserWindow, "desktopBridge", {
      configurable: true,
      value: { setTheme },
    });
    let unsubscribe: (() => void) | undefined;
    let emitCount = 0;
    mockReactForHookCalls(
      (next) => {
        unsubscribe = next;
      },
      () => {
        emitCount += 1;
      },
    );

    const { useTheme } = await import("./useTheme");
    const theme = useTheme();
    expect(theme).toMatchObject({ theme: "system", resolvedTheme: "dark" });
    await Promise.resolve();
    expect(setTheme).toHaveBeenCalledWith("system");

    browser.switchOs(true);
    browser.fireStorage("unrelated");
    browser.storage.setItem("bibcode:theme", "dark");
    browser.fireStorage("bibcode:theme");
    expect(emitCount).toBe(2);

    theme.setTheme("light");
    expect(browser.storage.getItem("bibcode:theme")).toBe("light");
    expect(browser.isDark()).toBe(false);
    expect(emitCount).toBe(3);

    // Components come and go; the app-wide OS and storage listeners stay installed.
    unsubscribe?.();
    expect(browser.mediaListenerCount()).toBe(1);
    expect(browser.storageListenerCount()).toBe(1);
  });

  it("logs hook-level storage write failures without changing the current theme", async () => {
    const cause = new Error("quota");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    }));
    vi.stubGlobal("window", {
      localStorage: createStorage({
        setItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    const { useTheme } = await import("./useTheme");

    const theme = useTheme();
    theme.setTheme("dark");

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to write theme preference for bibcode:theme.",
      expect.objectContaining({ operation: "write", storageKey: "bibcode:theme", theme: "dark" }),
    );
  });
});

// main.tsx loads this module at boot, so these listeners serve every route,
// including routes (such as the home route) that render no `useTheme` consumer.
describe("app-wide theme subscription", () => {
  it("sends the stored choice to a desktop bridge installed after the module loaded", async () => {
    const browser = installThemeBrowser({ stored: "dark" });
    const { applyStoredTheme } = await import("./useTheme");
    expect(browser.isDark()).toBe(true);

    const setTheme = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(browser.browserWindow, "desktopBridge", {
      configurable: true,
      value: { setTheme },
    });
    applyStoredTheme();

    expect(setTheme).toHaveBeenCalledOnce();
    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(browser.isDark()).toBe(true);
  });

  it("follows OS light/dark switches with no useTheme consumer mounted", async () => {
    const browser = installThemeBrowser();
    await import("./useTheme");
    expect(browser.isDark()).toBe(false);

    browser.switchOs(true);
    expect(browser.isDark()).toBe(true);

    browser.switchOs(false);
    expect(browser.isDark()).toBe(false);
  });

  it("follows a theme chosen in another tab with no useTheme consumer mounted", async () => {
    const browser = installThemeBrowser();
    await import("./useTheme");

    browser.storage.setItem("bibcode:theme", "dark");
    browser.fireStorage("bibcode:theme");
    expect(browser.isDark()).toBe(true);
  });

  it.each(["light", "dark"] as const)(
    "keeps an explicit %s choice while the OS switches",
    async (choice) => {
      const expectedDark = choice === "dark";
      const browser = installThemeBrowser({ stored: choice, prefersDark: !expectedDark });
      await import("./useTheme");
      expect(browser.isDark()).toBe(expectedDark);

      browser.switchOs(expectedDark);
      expect(browser.isDark()).toBe(expectedDark);
      browser.switchOs(!expectedDark);
      expect(browser.isDark()).toBe(expectedDark);
    },
  );

  it("installs one OS listener and one storage listener however many components read the theme", async () => {
    const browser = installThemeBrowser();
    const unsubscribers: Array<() => void> = [];
    mockReactForHookCalls((unsubscribe) => unsubscribers.push(unsubscribe));
    const { useTheme } = await import("./useTheme");
    useTheme();
    useTheme();
    useTheme();

    expect(unsubscribers).toHaveLength(3);
    expect(browser.mediaListenerCount()).toBe(1);
    expect(browser.storageListenerCount()).toBe(1);

    for (const unsubscribe of unsubscribers) unsubscribe();
    browser.switchOs(true);
    expect(browser.isDark()).toBe(true);
  });
});

describe("theme slots and overrides", () => {
  function seed(
    browser: ReturnType<typeof installThemeBrowser>,
    slots: { light?: string; dark?: string },
    library: unknown[] = [],
  ) {
    browser.storage.setItem(
      "bibcode:theme-slots:v1",
      JSON.stringify({ light: "light", dark: "dark", ...slots, paintStamp: "seed" }),
    );
    browser.storage.setItem("bibcode:themes:v1", JSON.stringify(library));
  }
  const rootStyle = (browser: ReturnType<typeof installThemeBrowser>) =>
    browser.browserWindow.document.documentElement.style;
  function customProperties(browser: ReturnType<typeof installThemeBrowser>): string[] {
    const style = rootStyle(browser);
    return Array.from({ length: style.length }, (_, index) => style.item(index)).filter((name) =>
      name.startsWith("--"),
    );
  }
  function withDesktopBridge(browser: ReturnType<typeof installThemeBrowser>) {
    const setTheme = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(browser.browserWindow, "desktopBridge", {
      configurable: true,
      value: { setTheme },
    });
    return setTheme;
  }
  const mine = {
    version: 1,
    id: "mine",
    name: "Mine",
    base: "dark",
    ui: { primary: "#3b82f6" },
  };

  it("with no stored slots nothing but the dark class changes", async () => {
    const browser = installThemeBrowser({ stored: "dark" });
    await import("./useTheme");
    expect(browser.isDark()).toBe(true);
    expect(customProperties(browser)).toEqual([]);
    expect(browser.storage.getItem("bibcode:theme-paint:v1")).toBeNull();
  });

  it('Tokyo Night sets the dark class and --background #1a1b26, --primary #7aa2f7 and --border #414868 and calls setTheme("dark")', async () => {
    const browser = installThemeBrowser({ stored: "dark" });
    seed(browser, { dark: "tokyo-night" });
    const setTheme = withDesktopBridge(browser);
    await import("./useTheme");
    expect(browser.isDark()).toBe(true);
    expect(rootStyle(browser).getPropertyValue("--background")).toBe("#1a1b26");
    expect(rootStyle(browser).getPropertyValue("--primary")).toBe("#7aa2f7");
    expect(rootStyle(browser).getPropertyValue("--border")).toBe("#414868");
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("switching from Matrix Dark to Dark removes every Matrix Dark property", async () => {
    const browser = installThemeBrowser({ stored: "dark" });
    seed(browser, { dark: "matrix-dark" });
    await import("./useTheme");
    const store = await import("../themes/customThemes");
    expect(customProperties(browser).length).toBeGreaterThan(10);

    store.setSlot("dark", "dark");
    expect(customProperties(browser)).toEqual([]);
    expect(browser.isDark()).toBe(true);
  });

  it('Matrix Light leaves the dark class off, sets --input #16a34a and calls setTheme("light")', async () => {
    const browser = installThemeBrowser({ stored: "light" });
    seed(browser, { light: "matrix-light" });
    const setTheme = withDesktopBridge(browser);
    await import("./useTheme");
    expect(browser.isDark()).toBe(false);
    expect(rootStyle(browser).getPropertyValue("--input")).toBe("#16a34a");
    expect(setTheme).toHaveBeenCalledWith("light");
  });

  it("Verdant Light sets --foreground #303840, --placeholder #667078, --selected #eaf5ef, --selected-foreground #065f46 and --panel-separator #dee3e6", async () => {
    const browser = installThemeBrowser({ stored: "light" });
    seed(browser, { light: "verdant-light" });
    await import("./useTheme");
    const style = rootStyle(browser);
    expect(style.getPropertyValue("--foreground")).toBe("#303840");
    expect(style.getPropertyValue("--placeholder")).toBe("#667078");
    expect(style.getPropertyValue("--selected")).toBe("#eaf5ef");
    expect(style.getPropertyValue("--selected-foreground")).toBe("#065f46");
    expect(style.getPropertyValue("--panel-separator")).toBe("#dee3e6");
  });

  it("in System mode an operating-system change to light applies the light slot and clears the dark theme's properties", async () => {
    const browser = installThemeBrowser({ stored: "system", prefersDark: true });
    seed(browser, { dark: "mine" }, [mine]);
    await import("./useTheme");
    expect(browser.isDark()).toBe(true);
    expect(rootStyle(browser).getPropertyValue("--primary")).toBe("#3b82f6");

    browser.switchOs(false);
    expect(browser.isDark()).toBe(false);
    expect(customProperties(browser)).toEqual([]);
  });

  it('a custom theme on a dark base resolves to "dark" and its id', async () => {
    const browser = installThemeBrowser({ stored: "dark" });
    seed(browser, { dark: "mine" }, [mine]);
    mockReactForHookCalls(() => {});
    const { useTheme } = await import("./useTheme");
    expect(useTheme()).toMatchObject({ resolvedTheme: "dark", resolvedThemeId: "mine" });
  });

  it("the theme-color meta uses the theme's background", async () => {
    const browser = installThemeBrowser({ stored: "dark" });
    seed(browser, { dark: "tokyo-night" });
    await import("./useTheme");
    expect(
      browser.browserWindow.document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute("content"),
    ).toBe("#1a1b26");
  });

  it("subscribeAppliedTheme fires on a mode change, a System change, a slot change and a same-id saved edit, and stops after unsubscribing", async () => {
    const browser = installThemeBrowser({ stored: "system", prefersDark: false });
    seed(browser, {}, [mine]);
    mockReactForHookCalls(() => {});
    const { subscribeAppliedTheme, useTheme } = await import("./useTheme");
    const store = await import("../themes/customThemes");
    const listener = vi.fn();
    const unsubscribe = subscribeAppliedTheme(listener);

    browser.switchOs(true);
    expect(listener).toHaveBeenCalledTimes(1);
    store.setSlot("dark", "mine");
    expect(listener).toHaveBeenCalledTimes(2);
    store.saveCustomTheme({ ...mine, ui: { primary: "#ff0000" } } as never);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(rootStyle(browser).getPropertyValue("--primary")).toBe("#ff0000");
    useTheme().setTheme("light");
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    useTheme().setTheme("dark");
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("a custom dark theme that sets muted and border derives the scrollbar thumb from its border and the sidebar card text from its muted-foreground, and Dark keeps today's values", async () => {
    const browser = installThemeBrowser({ stored: "dark" });
    const outlined = {
      version: 1,
      id: "outlined",
      name: "Outlined",
      base: "dark",
      ui: { muted: "#222833", "muted-foreground": "#9aa5b8", border: "#3a4252" },
    };
    seed(browser, { dark: "outlined" }, [outlined, mine]);
    await import("./useTheme");
    const store = await import("../themes/customThemes");
    const style = rootStyle(browser);
    expect(style.getPropertyValue("--scrollbar-thumb")).toBe(
      "color-mix(in srgb, var(--border) 80%, transparent)",
    );
    expect(style.getPropertyValue("--scrollbar-thumb-hover")).toBe("var(--border)");
    expect(style.getPropertyValue("--scrollbar-thumb-subtle")).toBe(
      "color-mix(in srgb, var(--border) 60%, transparent)",
    );
    expect(style.getPropertyValue("--scrollbar-thumb-subtle-hover")).toBe(
      "color-mix(in srgb, var(--border) 80%, transparent)",
    );
    expect(style.getPropertyValue("--sidebar-card-muted-foreground")).toBe(
      "var(--muted-foreground)",
    );

    // A theme that leaves border and muted-foreground unset keeps the stylesheet's values.
    store.setSlot("dark", "mine");
    expect(customProperties(browser)).toEqual(["--primary"]);
    store.setSlot("dark", "dark");
    expect(customProperties(browser)).toEqual([]);
  });

  it("Verdant Light sets the focus ring attribute, --focus-ring-width 2px and --focus-ring-offset 2px, and the control-shadow attribute", async () => {
    const browser = installThemeBrowser({ stored: "light" });
    seed(browser, { light: "verdant-light" });
    await import("./useTheme");
    const root = browser.browserWindow.document.documentElement;
    expect(root.hasAttribute("data-theme-focus-ring")).toBe(true);
    expect(root.style.getPropertyValue("--focus-ring-width")).toBe("2px");
    expect(root.style.getPropertyValue("--focus-ring-offset")).toBe("2px");
    expect(root.getAttribute("data-theme-control-shadow")).toBe("none");
  });

  it("Light and Dark set neither attribute", async () => {
    const browser = installThemeBrowser({ stored: "light" });
    seed(browser, { light: "verdant-light" });
    await import("./useTheme");
    const store = await import("../themes/customThemes");
    const root = browser.browserWindow.document.documentElement;
    store.setSlot("light", "light");
    expect(root.hasAttribute("data-theme-focus-ring")).toBe(false);
    expect(root.hasAttribute("data-theme-control-shadow")).toBe(false);
    browser.storage.setItem("bibcode:theme", "dark");
    browser.fireStorage("bibcode:theme");
    expect(browser.isDark()).toBe(true);
    expect(root.hasAttribute("data-theme-focus-ring")).toBe(false);
    expect(root.hasAttribute("data-theme-control-shadow")).toBe(false);
  });

  it("a preview applies over the active theme and null restores the stored theme", async () => {
    const browser = installThemeBrowser({ stored: "dark" });
    seed(browser, { dark: "tokyo-night" });
    const { setThemePreview, subscribeAppliedTheme } = await import("./useTheme");
    const listener = vi.fn();
    subscribeAppliedTheme(listener);

    setThemePreview({ version: 1, id: "draft", name: "Draft", base: "dark", ui: mine.ui });
    expect(rootStyle(browser).getPropertyValue("--primary")).toBe("#3b82f6");
    expect(rootStyle(browser).getPropertyValue("--background")).toBe("");
    setThemePreview({ version: 1, id: "draft", name: "Draft", base: "light" });
    expect(browser.isDark()).toBe(false);
    expect(customProperties(browser)).toEqual([]);

    setThemePreview(null);
    expect(browser.isDark()).toBe(true);
    expect(rootStyle(browser).getPropertyValue("--primary")).toBe("#7aa2f7");
    expect(rootStyle(browser).getPropertyValue("--background")).toBe("#1a1b26");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
