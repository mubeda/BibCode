import {
  UI_COLOR_TOKENS,
  UI_KEYWORD_TOKENS,
  UI_LENGTH_TOKENS,
  type DesktopBridge,
  type ThemeFile,
} from "@bibcode/contracts";
import { safeErrorLogAttributes } from "@bibcode/client-runtime/errors";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  getTheme,
  getThemeRevision,
  handleThemesStorageEvent,
  paintRecordFor,
  readSlots,
  subscribeThemes,
} from "../themes/customThemes";

const ThemePreference = Schema.Literals(["light", "dark", "system"]);
type Theme = typeof ThemePreference.Type;
type ThemeSnapshot = {
  theme: Theme;
  systemDark: boolean;
  base: "light" | "dark";
  themeId: string;
  revision: number;
};

/** Every inline property a theme may set on the root element (#290). */
const THEME_PROPERTIES = [...UI_COLOR_TOKENS, ...UI_LENGTH_TOKENS, ...UI_KEYWORD_TOKENS].map(
  (token) => `--${token}`,
);

/**
 * Variables outside the token set that follow a theme only when it overrides their source token,
 * so a theme that leaves the source unset keeps today's colors (R57, design note finding A9).
 */
const DERIVED_PROPERTIES: Record<string, { source: string; value: string }> = {
  "--scrollbar-thumb": {
    source: "--border",
    value: "color-mix(in srgb, var(--border) 80%, transparent)",
  },
  "--scrollbar-thumb-hover": { source: "--border", value: "var(--border)" },
  "--scrollbar-thumb-subtle": {
    source: "--border",
    value: "color-mix(in srgb, var(--border) 60%, transparent)",
  },
  "--scrollbar-thumb-subtle-hover": {
    source: "--border",
    value: "color-mix(in srgb, var(--border) 80%, transparent)",
  },
  "--sidebar-card-muted-foreground": {
    source: "--muted-foreground",
    value: "var(--muted-foreground)",
  },
};

type DesktopThemeBridge = Pick<DesktopBridge, "setTheme">;

const STORAGE_KEY = "bibcode:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  systemDark: false,
  base: "light",
  themeId: "light",
  revision: 0,
};
const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

export class ThemeStorageError extends Schema.TaggedError<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

export const isThemeStorageError = Schema.is(ThemeStorageError);

export class DesktopThemeSyncError extends Schema.TaggedError<DesktopThemeSyncError>()(
  "DesktopThemeSyncError",
  {
    theme: ThemePreference,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sync the ${this.theme} theme to the desktop shell.`;
  }
}

export const isDesktopThemeSyncError = Schema.is(DesktopThemeSyncError);

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: Theme | null = null;
let lastAppliedKey: string | null = null;
let themeStorageReadFailure: ThemeStorageError | null = null;
let previewTheme: ThemeFile | null = null;
let previewRevision = 0;
const appliedListeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

/** The theme on screen: an unsaved preview, else the slot of the resolved mode. */
function activeTheme(theme: Theme, systemDark: boolean): ThemeFile {
  if (previewTheme) return previewTheme;
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const slots = readSlots();
  return getTheme(dark ? slots.dark : slots.light) ?? getTheme(dark ? "dark" : "light")!;
}

/** Fires after every effective application of a theme, in this window. */
export function subscribeAppliedTheme(listener: () => void): () => void {
  appliedListeners.add(listener);
  return () => {
    appliedListeners.delete(listener);
  };
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

export function readThemePreference(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT.theme;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: STORAGE_KEY,
      cause,
    });
  }
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return DEFAULT_THEME_SNAPSHOT.theme;
}

export function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
    themeStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: STORAGE_KEY,
      theme,
      cause,
    });
  }
}

function getStored(): Theme {
  if (themeStorageReadFailure !== null) {
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: STORAGE_KEY,
          cause,
        });
    themeStorageReadFailure = error;
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme(themeBackground?: string) {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = surfaceColor ?? fallbackColor ?? themeBackground;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
}

function applyTheme(theme: Theme, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const systemDark = theme === "system" ? getSystemDark() : false;
  const active = activeTheme(theme, systemDark);
  const record = paintRecordFor(active);
  const key = `${theme}|${systemDark}|${active.id}|${record.stamp}`;
  if (lastAppliedKey === key) {
    syncDesktopTheme(theme);
    return;
  }

  const root = document.documentElement;
  if (suppressTransitions) {
    root.classList.add("no-transitions");
  }
  root.classList.toggle("dark", active.base === "dark");
  // Clears every theme property the new theme does not set, including what the pre-paint
  // script set, then sets the new overrides one property at a time (never as style text).
  for (const name of THEME_PROPERTIES) {
    if (!(name in record.vars)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(record.vars)) root.style.setProperty(name, value);
  for (const [name, { source, value }] of Object.entries(DERIVED_PROPERTIES)) {
    if (source in record.vars) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  lastAppliedKey = key;
  syncBrowserChromeTheme(Object.keys(record.vars).length > 0 ? record.background : undefined);
  syncDesktopTheme(theme);
  for (const listener of appliedListeners) listener();
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

export async function syncDesktopThemePreference(
  bridge: DesktopThemeBridge,
  theme: Theme,
): Promise<void> {
  try {
    await bridge.setTheme(theme);
  } catch (cause) {
    throw new DesktopThemeSyncError({ theme, cause });
  }
}

export function syncDesktopTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void syncDesktopThemePreference(bridge, theme).catch((cause: unknown) => {
    const error = isDesktopThemeSyncError(cause)
      ? cause
      : new DesktopThemeSyncError({ theme, cause });
    console.error(error.message, {
      theme: error.theme,
      ...safeErrorLogAttributes(error),
    });
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

function handleSystemThemeChange() {
  if (getStored() === "system") applyTheme("system", true);
  emitChange();
}

function handleThemeStorageChange(event: StorageEvent) {
  handleThemesStorageEvent(event);
  if (event.key !== STORAGE_KEY) return;
  themeStorageReadFailure = null;
  applyTheme(getStored(), true);
  emitChange();
}

// Apply immediately on module load to prevent flash, then follow OS light/dark
// switches and theme changes from other tabs for the app's lifetime. These are
// the app's only theme listeners: main.tsx loads this module at boot, so every
// route follows the OS, including routes that render no `useTheme` consumer.
// The desktop bridge does not exist yet at boot; main.tsx calls
// `applyStoredTheme` once it does.
if (typeof document !== "undefined" && typeof window !== "undefined") {
  applyTheme(getStored());
  const systemDarkQuery =
    typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
  if (typeof systemDarkQuery?.addEventListener === "function") {
    systemDarkQuery.addEventListener("change", handleSystemThemeChange);
  }
  if (typeof window.addEventListener === "function") {
    window.addEventListener("storage", handleThemeStorageChange);
  }
  subscribeThemes(() => {
    applyTheme(getStored(), true);
    emitChange();
  });
}

/**
 * Paints an unsaved theme over the active one in this window only; `null` paints the stored
 * theme again. The desktop window keeps the stored mode, so a Cancel does not flash it.
 */
export function setThemePreview(theme: ThemeFile | null): void {
  previewTheme = theme;
  previewRevision += 1;
  applyTheme(getStored(), true);
  emitChange();
}

/** Applies the stored theme everywhere, including a desktop bridge installed after boot. */
export function applyStoredTheme(): void {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT;
  const theme = getStored();
  const systemDark = theme === "system" ? getSystemDark() : false;
  const active = activeTheme(theme, systemDark);
  const revision = getThemeRevision() + previewRevision;

  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.themeId === active.id &&
    lastSnapshot.base === active.base &&
    lastSnapshot.revision === revision
  ) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, systemDark, base: active.base, themeId: active.id, revision };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

// Components only subscribe to snapshot changes; the module-level listeners
// above apply OS and cross-tab theme changes once for the whole app.
function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = snapshot.theme;
  // The active theme's base: a slot's theme always has the base of its mode.
  const resolvedTheme = snapshot.base;

  const setTheme = useCallback((next: Theme) => {
    if (typeof window === "undefined") return;
    try {
      writeThemePreference(next);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: STORAGE_KEY,
            theme: next,
            cause,
          });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        theme: next,
        ...safeErrorLogAttributes(error),
      });
      return;
    }
    applyTheme(next, true);
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return {
    theme,
    setTheme,
    resolvedTheme,
    resolvedThemeId: snapshot.themeId,
    themeRevision: snapshot.revision,
  } as const;
}
