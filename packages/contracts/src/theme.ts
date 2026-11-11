import * as Schema from "effect/Schema";

/**
 * Color theme file format (issue #290). A theme is a base plus optional overrides of the
 * supported tokens; every token it leaves unset keeps its base definition. Values are checked
 * by the web client's theme validation, which this schema-only module does not hold.
 */
export const THEME_FILE_VERSION = 1;

export const ThemeBase = Schema.Literals(["light", "dark"]);
export type ThemeBase = typeof ThemeBase.Type;

export const UI_COLOR_TOKENS = [
  "background",
  "app-chrome-background",
  "foreground",
  "foreground-strong",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "primary-hover",
  "primary-active",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "selected",
  "selected-foreground",
  "placeholder",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "panel-separator",
  "sidebar-well",
  "sidebar-card",
  "sidebar-card-border",
  "sidebar-env-band",
  "sidebar-env-accent",
  "sidebar-primary-badge",
  "sidebar-primary-badge-foreground",
  "sidebar-worktree",
  "sidebar-worktree-border",
  "sidebar-worktree-icon",
  "sidebar-chat-foreground",
  "sidebar-indent-guide",
  "link",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "find-match",
  "find-match-foreground",
  "find-match-active",
  "find-match-active-foreground",
] as const;
export type UiColorToken = (typeof UI_COLOR_TOKENS)[number];

export const UI_LENGTH_TOKENS = ["radius", "focus-ring-width", "focus-ring-offset"] as const;
export type UiLengthToken = (typeof UI_LENGTH_TOKENS)[number];

export const UI_KEYWORD_TOKENS = ["sidebar-card-shadow", "control-shadow"] as const;
export type UiKeywordToken = (typeof UI_KEYWORD_TOKENS)[number];

export type UiToken = UiColorToken | UiLengthToken | UiKeywordToken;

export const TERMINAL_TOKENS = [
  "background",
  "foreground",
  "cursor",
  "selection-background",
  "selection-foreground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const;
export type TerminalToken = (typeof TERMINAL_TOKENS)[number];

export const RESERVED_THEME_IDS = [
  "system",
  "light",
  "dark",
  "tokyo-night",
  "matrix-dark",
  "matrix-light",
  "verdant-light",
] as const;

export const ThemeId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(48),
  Schema.isPattern(/^[a-z0-9-]+$/),
);
export type ThemeId = typeof ThemeId.Type;

export const ThemeName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(48));

function tokenRecord<const Tokens extends ReadonlyArray<string>>(tokens: Tokens) {
  return Schema.Struct(
    Object.fromEntries(tokens.map((token) => [token, Schema.optionalKey(Schema.String)])) as {
      readonly [Token in Tokens[number]]: Schema.optionalKey<Schema.String>;
    },
  );
}

export const ThemeUiOverrides = tokenRecord([
  ...UI_COLOR_TOKENS,
  ...UI_LENGTH_TOKENS,
  ...UI_KEYWORD_TOKENS,
]);
export const ThemeTerminalOverrides = tokenRecord(TERMINAL_TOKENS);

export const ThemeFile = Schema.Struct({
  version: Schema.Literal(THEME_FILE_VERSION),
  id: ThemeId,
  name: ThemeName,
  base: ThemeBase,
  ui: Schema.optionalKey(ThemeUiOverrides),
  terminal: Schema.optionalKey(ThemeTerminalOverrides),
});
export type ThemeFile = typeof ThemeFile.Type;

/** Decode options for theme files: unknown keys are rejected at every level, every issue reported. */
export const THEME_FILE_PARSE_OPTIONS = { onExcessProperty: "error", errors: "all" } as const;
