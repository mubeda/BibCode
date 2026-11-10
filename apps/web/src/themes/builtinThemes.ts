import { THEME_FILE_VERSION, type ThemeFile } from "@bibcode/contracts";

// Tokyo Night: color values from Omarchy's themes/tokyo-night/colors.toml (MIT, Copyright (c)
// David Heinemeier Hansson), a palette that originates in enkia's Tokyo Night for VS Code (MIT)
// and folke's tokyonight.nvim (Apache-2.0). Only color values are used, mapped onto BiBCode's
// own tokens.
import tokyoNight from "./builtin/tokyo-night.json";
// Matrix Dark: color values from BVisagie/omarchy-matrix-theme colors.toml (MIT, Copyright (c)
// 2026 Bernard Visagie).
import matrixDark from "./builtin/matrix-dark.json";
// Matrix Light and Verdant Light are original to BiBCode.
import matrixLight from "./builtin/matrix-light.json";
import verdantLight from "./builtin/verdant-light.json";

export type BuiltinTheme = ThemeFile & { subtitle: string };

/** The six read-only themes, in list order (R37). Light and Dark carry no overrides. */
export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  { version: THEME_FILE_VERSION, id: "light", name: "Light", base: "light", subtitle: "Built-in" },
  { version: THEME_FILE_VERSION, id: "dark", name: "Dark", base: "dark", subtitle: "Built-in" },
  { ...(tokyoNight as ThemeFile), subtitle: "Based on Omarchy's Tokyo Night" },
  { ...(matrixDark as ThemeFile), subtitle: "Based on omarchy-matrix-theme" },
  { ...(matrixLight as ThemeFile), subtitle: "BiBCode original" },
  { ...(verdantLight as ThemeFile), subtitle: "BiBCode original" },
];

const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((theme) => theme.id));

export function isBuiltinThemeId(id: string): boolean {
  return BUILTIN_IDS.has(id);
}
