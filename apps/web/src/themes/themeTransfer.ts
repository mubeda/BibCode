import {
  TERMINAL_TOKENS,
  UI_COLOR_TOKENS,
  UI_KEYWORD_TOKENS,
  UI_LENGTH_TOKENS,
  type ThemeFile,
} from "@bibcode/contracts";

import { isBuiltinThemeId } from "./builtinThemes";
import { copyThemeId, getTheme, saveCustomTheme } from "./customThemes";
import { pairRatios, type FixedPair } from "./themeColor";
import { MAX_THEME_FILE_BYTES, validateThemeFile, type ThemeFieldError } from "./themeValidation";

/** Theme files move between devices as JSON (#290, R53, R55). */

const MINIMUM_RATIO = 4.5;
const UI_ORDER = [...UI_COLOR_TOKENS, ...UI_LENGTH_TOKENS, ...UI_KEYWORD_TOKENS];

export type ImportPlan =
  | { ok: true; theme: ThemeFile; resetPairs: FixedPair[]; conflict: boolean }
  | { ok: false; errors: ThemeFieldError[] };

function ordered(
  values: Record<string, string> | undefined,
  order: readonly string[],
): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(order.filter((token) => token in values).map((t) => [t, values[t]!]));
}

/** Stable key order (the contract's token order), two-space indent and a trailing newline. */
export function exportThemeJson(theme: ThemeFile): string {
  const file = {
    version: theme.version,
    id: theme.id,
    name: theme.name,
    base: theme.base,
    ui: ordered(theme.ui, UI_ORDER),
    terminal: ordered(theme.terminal, TERMINAL_TOKENS),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The theme without its own value for `token` (`terminal.<name>` or a UI token), or null. */
function withoutOverride(theme: ThemeFile, token: string): ThemeFile | null {
  const group = token.startsWith("terminal.") ? "terminal" : "ui";
  const name = group === "terminal" ? token.slice("terminal.".length) : token;
  const values: Record<string, string> | undefined = theme[group];
  if (values?.[name] === undefined) return null;
  const { [name]: _removed, ...rest } = values;
  const { [group]: _group, ...file } = theme;
  return Object.keys(rest).length > 0 ? { ...file, [group]: rest } : file;
}

/**
 * Removes the overrides that make a fixed pair unreadable (R55, amendment A3 revised). A pair
 * under 4.5:1 is reset only when the same pair at the theme's base values meets 4.5:1 or the
 * theme still overrides the pair's text token. A pair the base fails is left alone otherwise.
 * The text override goes first, then the surface override if the pair still fails.
 */
function resetUnreadablePairs(theme: ThemeFile): { theme: ThemeFile; resetPairs: FixedPair[] } {
  const base: ThemeFile = { version: 1, id: theme.base, name: theme.base, base: theme.base };
  const baseRatio = new Map(pairRatios(base).map(({ pair, ratio }) => [pair, ratio]));
  const resetPairs: FixedPair[] = [];
  let current = theme;
  // Each pass removes one override, so the loop ends.
  for (let changed = true; changed;) {
    changed = false;
    for (const { pair, ratio } of pairRatios(current)) {
      if (ratio >= MINIMUM_RATIO) continue;
      if (baseRatio.get(pair)! < MINIMUM_RATIO && !withoutOverride(current, pair.text)) continue; // no text override left
      const next = withoutOverride(current, pair.text) ?? withoutOverride(current, pair.surface);
      if (!next) continue;
      current = next;
      changed = true;
      if (!resetPairs.includes(pair)) resetPairs.push(pair);
      break;
    }
  }
  return { theme: current, resetPairs };
}

/** Parses and validates an import without storing anything. */
export function planThemeImport(text: string): ImportPlan {
  const byteLength = new TextEncoder().encode(text).length;
  // The size check runs before parsing, so a huge paste is never parsed.
  if (byteLength > MAX_THEME_FILE_BYTES) {
    const sizeCheck = validateThemeFile(null, { allowReservedId: false, byteLength });
    if (!sizeCheck.ok) return sizeCheck;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ field: "file", message: "The file is not valid JSON." }] };
  }
  const validation = validateThemeFile(parsed, { allowReservedId: false, byteLength });
  if (!validation.ok) return validation;
  const { theme, resetPairs } = resetUnreadablePairs(validation.theme);
  return { ok: true, theme, resetPairs, conflict: hasCustomTheme(theme.id) };
}

function hasCustomTheme(id: string): boolean {
  return getTheme(id) !== undefined && !isBuiltinThemeId(id);
}

/**
 * Stores a planned import. On an id conflict, "replace" overwrites the stored theme and
 * "keep-both" stores the import under a new id. "import" is the choice-free path: it stores
 * nothing and returns null when a custom theme took the id since validation (another window),
 * so the person can choose (R53). Throws when the theme cannot be saved.
 */
export function commitThemeImport(
  plan: Extract<ImportPlan, { ok: true }>,
  choice: "import" | "replace" | "keep-both",
): ThemeFile | null {
  if (choice === "import" && hasCustomTheme(plan.theme.id)) return null;
  const theme =
    plan.conflict && choice === "keep-both"
      ? { ...plan.theme, id: copyThemeId(plan.theme.id) }
      : plan.theme;
  const result = saveCustomTheme(theme);
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join(" "));
  return theme;
}
