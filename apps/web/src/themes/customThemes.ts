import { safeErrorLogAttributes } from "@bibcode/client-runtime/errors";
import { UI_COLOR_TOKENS, type ThemeFile } from "@bibcode/contracts";
import { useSyncExternalStore } from "react";

import { BASE_TOKEN_VALUES } from "./baseTokenValues";
import { BUILTIN_THEMES, isBuiltinThemeId } from "./builtinThemes";
import { compositeHex, resolveToken, toHex } from "./themeColor";
import { MAX_CUSTOM_THEMES, validateThemeFile, type ThemeFieldError } from "./themeValidation";

/**
 * The custom theme library and the light and dark slots, stored per device (#290). Every write
 * goes paint record, library, slots, and the slots carry the paint record's stamp, so the
 * pre-paint script never paints a stale theme after an interrupted write (plan decision P22).
 */
const LIBRARY_KEY = "bibcode:themes:v1";
const SLOTS_KEY = "bibcode:theme-slots:v1";
const PAINT_KEY = "bibcode:theme-paint:v1";
const STORE_KEYS = new Set([LIBRARY_KEY, SLOTS_KEY, PAINT_KEY]);

export type ThemeBaseName = "light" | "dark";
export type ThemeSlots = { light: string; dark: string };
export type PaintRecord = {
  base: ThemeBaseName;
  background: string;
  vars: Record<string, string>;
  stamp: string;
};
export type ThemesSnapshot = { themes: ThemeFile[]; slots: ThemeSlots };

const DEFAULT_SLOTS: ThemeSlots = { light: "light", dark: "dark" };
const COLOR_TOKENS = new Set<string>(UI_COLOR_TOKENS);

let revision = 0;
let snapshot: ThemesSnapshot | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// Unreadable storage leaves the built-in themes working; it is logged once and read again only
// after a relevant storage event.
let storageReadFailed = false;

function readRaw(key: string): string | null {
  if (storageReadFailed) return null;
  try {
    return storage()?.getItem(key) ?? null;
  } catch (cause) {
    storageReadFailed = true;
    console.error("Could not read stored themes.", {
      storageKey: key,
      ...safeErrorLogAttributes(cause),
    });
    return null;
  }
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readLibrary(): ThemeFile[] {
  const stored = parseJson(readRaw(LIBRARY_KEY));
  if (stored === null) return [];
  if (!Array.isArray(stored)) {
    console.warn("Skipped the stored theme library because it is not a list.");
    return [];
  }
  return stored.flatMap((entry, index) => {
    const result = validateThemeFile(entry, { allowReservedId: false });
    if (result.ok) return [result.theme];
    console.warn("Skipped a stored theme that could not be read.", {
      index,
      fields: result.errors.map((error) => error.field),
    });
    return [];
  });
}

function readStoredSlots(): (Partial<ThemeSlots> & { paintStamp?: unknown }) | null {
  const stored = parseJson(readRaw(SLOTS_KEY));
  return stored !== null && typeof stored === "object" ? (stored as Partial<ThemeSlots>) : null;
}

function resolveSlots(library: ThemeFile[], stored: Partial<ThemeSlots> | null): ThemeSlots {
  const pick = (base: ThemeBaseName): string => {
    const id = stored?.[base];
    const theme = typeof id === "string" ? findTheme(library, id) : undefined;
    return theme?.base === base ? theme.id : DEFAULT_SLOTS[base];
  };
  return { light: pick("light"), dark: pick("dark") };
}

function findTheme(library: ThemeFile[], id: string): ThemeFile | undefined {
  return (
    BUILTIN_THEMES.find((theme) => theme.id === id) ?? library.find((theme) => theme.id === id)
  );
}

function stripSubtitle(theme: ThemeFile & { subtitle?: string }): ThemeFile {
  const { subtitle: _subtitle, ...file } = theme;
  return file;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function computeStamp(library: ThemeFile[], slots: ThemeSlots): string {
  const theme = (id: string) => {
    const found = findTheme(library, id);
    return found ? stripSubtitle(found) : null;
  };
  return fnv1a(JSON.stringify([slots, theme(slots.light), theme(slots.dark)]));
}

/** The pre-paint record of one theme: its overrides with colors as hex, and an opaque background. */
export function paintRecordFor(theme: ThemeFile): PaintRecord {
  const vars: Record<string, string> = {};
  for (const [token, value] of Object.entries(theme.ui ?? {})) {
    vars[`--${token}`] = COLOR_TOKENS.has(token) ? toHex(value) : value;
  }
  return {
    base: theme.base,
    background: compositeHex(
      resolveToken(theme, "background"),
      BASE_TOKEN_VALUES[theme.base].background!,
    ),
    vars,
    stamp: fnv1a(JSON.stringify(stripSubtitle(theme))),
  };
}

type WriteResult = { ok: true } | { ok: false; message: string };

/** The stored paint record text for both slots, as every writer serializes it. */
function paintText(library: ThemeFile[], slots: ThemeSlots, stamp: string): string {
  const record = (id: string): PaintRecord => ({
    ...paintRecordFor(findTheme(library, id)!),
    stamp,
  });
  return JSON.stringify({ light: record(slots.light), dark: record(slots.dark) });
}

function write(library: ThemeFile[], slots: ThemeSlots): WriteResult {
  const target = storage();
  if (!target) return { ok: false, message: "Theme storage is not available in this browser." };
  const stamp = computeStamp(library, slots);
  try {
    target.setItem(PAINT_KEY, paintText(library, slots, stamp));
    target.setItem(LIBRARY_KEY, JSON.stringify(library));
    target.setItem(SLOTS_KEY, JSON.stringify({ ...slots, paintStamp: stamp }));
  } catch (cause) {
    console.error("Could not save themes.", { cause });
    return { ok: false, message: "Could not save the theme. The browser storage may be full." };
  } finally {
    changed();
  }
  return { ok: true };
}

function changed() {
  snapshot = null;
  revision += 1;
  for (const listener of listeners) listener();
}

/**
 * Rewrites the paint record and the slots' stamp unless both equal what the library and slots
 * derive, so a record edited by hand is rebuilt even when its stamps still match (P18).
 */
function repair() {
  if (readRaw(LIBRARY_KEY) === null && readRaw(SLOTS_KEY) === null) return;
  const library = readLibrary();
  const storedSlots = readStoredSlots();
  const slots = resolveSlots(library, storedSlots);
  const expected = computeStamp(library, slots);
  const expectedPaint = paintText(library, slots, expected);
  if (readRaw(PAINT_KEY) === expectedPaint && storedSlots?.paintStamp === expected) return;
  const target = storage();
  if (!target) return;
  try {
    target.setItem(PAINT_KEY, expectedPaint);
    target.setItem(SLOTS_KEY, JSON.stringify({ ...slots, paintStamp: expected }));
  } catch (cause) {
    console.error("Could not repair the stored theme paint record.", { cause });
  }
}

export function getThemeRevision(): number {
  return revision;
}

export function getThemesSnapshot(): ThemesSnapshot {
  if (snapshot) return snapshot;
  const library = readLibrary();
  snapshot = {
    themes: [...BUILTIN_THEMES.map(stripSubtitle), ...library],
    slots: resolveSlots(library, readStoredSlots()),
  };
  return snapshot;
}

/** Built-ins then custom themes. */
export function listThemes(): ThemeFile[] {
  return getThemesSnapshot().themes;
}

export function getTheme(id: string): ThemeFile | undefined {
  return listThemes().find((theme) => theme.id === id);
}

export function readSlots(): ThemeSlots {
  return getThemesSnapshot().slots;
}

/** The theme in the slot of `base`; slots always hold an existing theme of their base. */
export function slotTheme(base: ThemeBaseName): ThemeFile {
  return getTheme(readSlots()[base])!;
}

export function setSlot(
  base: ThemeBaseName,
  id: string,
): { ok: true } | { ok: false; reason: "wrong-base" | "unknown-theme" | "storage-failed" } {
  const theme = getTheme(id);
  if (!theme) return { ok: false, reason: "unknown-theme" };
  if (theme.base !== base) return { ok: false, reason: "wrong-base" };
  const result = write(readLibrary(), { ...readSlots(), [base]: id });
  return result.ok ? result : { ok: false, reason: "storage-failed" };
}

export function saveCustomTheme(
  theme: ThemeFile,
): { ok: true } | { ok: false; errors: ThemeFieldError[] } {
  const validation = validateThemeFile(theme, { allowReservedId: false });
  if (!validation.ok) return validation;
  const library = readLibrary();
  const index = library.findIndex((entry) => entry.id === theme.id);
  if (index < 0 && library.length >= MAX_CUSTOM_THEMES) {
    return {
      ok: false,
      errors: [
        { field: "file", message: `The theme library holds at most ${MAX_CUSTOM_THEMES} themes.` },
      ],
    };
  }
  const next = index < 0 ? [...library, validation.theme] : library.with(index, validation.theme);
  const result = write(next, resolveSlots(next, readStoredSlots()));
  return result.ok ? result : { ok: false, errors: [{ field: "file", message: result.message }] };
}

export function deleteCustomTheme(
  id: string,
): { ok: true } | { ok: false; reason: "builtin" | "unknown-theme" | "storage-failed" } {
  if (isBuiltinThemeId(id)) return { ok: false, reason: "builtin" };
  const library = readLibrary();
  if (!library.some((theme) => theme.id === id)) return { ok: false, reason: "unknown-theme" };
  const next = library.filter((theme) => theme.id !== id);
  const result = write(next, resolveSlots(next, readStoredSlots()));
  return result.ok ? result : { ok: false, reason: "storage-failed" };
}

/** Stores an editable copy named "<name> copy" under a new id. Throws when it cannot be saved. */
export function duplicateTheme(id: string): ThemeFile {
  const source = getTheme(id);
  if (!source) throw new Error(`Unknown theme ${id}`);
  const taken = new Set(listThemes().map((theme) => theme.id));
  const stem = `${source.id.slice(0, 36)}-copy`;
  let candidate = stem;
  for (let suffix = 2; taken.has(candidate) || isBuiltinThemeId(candidate); suffix += 1) {
    candidate = `${stem}-${suffix}`;
  }
  const copy: ThemeFile = { ...source, id: candidate, name: `${source.name} copy`.slice(0, 48) };
  const result = saveCustomTheme(copy);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join(" "));
  return copy;
}

export function resetSlots(): void {
  if (readRaw(LIBRARY_KEY) === null && readRaw(SLOTS_KEY) === null) return;
  write(readLibrary(), DEFAULT_SLOTS);
}

export function subscribeThemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemeLibrary(): ThemesSnapshot {
  return useSyncExternalStore(subscribeThemes, getThemesSnapshot, getThemesSnapshot);
}

/**
 * Follows a change another window made (R61). `useTheme` owns the app's one `storage` listener
 * and forwards every event here.
 */
export function handleThemesStorageEvent(event: Pick<StorageEvent, "key">): void {
  if (event.key !== null && !STORE_KEYS.has(event.key)) return;
  storageReadFailed = false;
  repair();
  changed();
}

if (typeof window !== "undefined") repair();
