import {
  RESERVED_THEME_IDS,
  THEME_FILE_PARSE_OPTIONS,
  ThemeFile,
  UI_KEYWORD_TOKENS,
  UI_LENGTH_TOKENS,
  type UiKeywordToken,
  type UiLengthToken,
} from "@bibcode/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export const MAX_THEME_FILE_BYTES = 16 * 1024;
export const MAX_CUSTOM_THEMES = 64;
const MAX_COLOR_LENGTH = 64;

export type ThemeFieldError = { field: string; message: string };

export type ThemeValidationResult =
  | { ok: true; theme: ThemeFile }
  | { ok: false; errors: ThemeFieldError[] };

const DENIED_COLOR_TEXT = /url\(|var\(|expression\(|[;{}<\\]/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ARG = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|deg)?`;
const MODERN_COLOR_FUNCTION = new RegExp(
  String.raw`^(?:rgba?|hsla?|oklch)\(\s*${ARG}\s+${ARG}\s+${ARG}(?:\s*\/\s*${ARG})?\s*\)$`,
  "i",
);
const LEGACY_COLOR_FUNCTION = new RegExp(
  String.raw`^(?:rgba?|hsla?)\(\s*${ARG}\s*,\s*${ARG}\s*,\s*${ARG}(?:\s*,\s*${ARG})?\s*\)$`,
  "i",
);

/** A hex color, `rgb()`, `hsl()` or `oklch()` with numeric arguments (plan decision P16). */
export function isSafeCssColor(value: string): boolean {
  if (value.length === 0 || value.length > MAX_COLOR_LENGTH || DENIED_COLOR_TEXT.test(value)) {
    return false;
  }
  return (
    HEX_COLOR.test(value) || MODERN_COLOR_FUNCTION.test(value) || LEGACY_COLOR_FUNCTION.test(value)
  );
}

/** Allowed ranges in px; a rem is 16px. */
export const LENGTH_TOKEN_RANGES: Record<
  UiLengthToken,
  { min: number; max: number; text: string }
> = {
  radius: { min: 0, max: 16, text: "0rem to 1rem" },
  "focus-ring-width": { min: 1, max: 3, text: "1px to 3px" },
  "focus-ring-offset": { min: 0, max: 3, text: "0px to 3px" },
};

export const KEYWORD_TOKEN_VALUES: Record<UiKeywordToken, readonly string[]> = {
  "sidebar-card-shadow": ["none"],
  "control-shadow": ["none", "default"],
};

const LENGTH = /^(\d+(?:\.\d+)?)(px|rem)$/;

export function isLengthInRange(token: UiLengthToken, value: string): boolean {
  const match = LENGTH.exec(value);
  if (!match) return false;
  const px = Number(match[1]) * (match[2] === "rem" ? 16 : 1);
  const range = LENGTH_TOKEN_RANGES[token];
  return px >= range.min && px <= range.max;
}

function isLengthToken(token: string): token is UiLengthToken {
  return (UI_LENGTH_TOKENS as readonly string[]).includes(token);
}

function isKeywordToken(token: string): token is UiKeywordToken {
  return (UI_KEYWORD_TOKENS as readonly string[]).includes(token);
}

/** The error for one token value, or null when the value is allowed. */
export function themeValueError(token: string, value: string): string | null {
  if (isLengthToken(token)) {
    return isLengthInRange(token, value)
      ? null
      : `Use a length from ${LENGTH_TOKEN_RANGES[token].text}.`;
  }
  if (isKeywordToken(token)) {
    const allowed = KEYWORD_TOKEN_VALUES[token];
    return allowed.includes(value) ? null : `Use ${allowed.join(" or ")}.`;
  }
  return isSafeCssColor(value) ? null : COLOR_ERROR;
}

const COLOR_ERROR = "Use a hex, rgb(), hsl() or oklch() color.";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
const decodeThemeFile = Schema.decodeUnknownResult(ThemeFile);

export function validateThemeFile(
  input: unknown,
  options: { allowReservedId: boolean; byteLength?: number },
): ThemeValidationResult {
  if (options.byteLength !== undefined && options.byteLength > MAX_THEME_FILE_BYTES) {
    return {
      ok: false,
      errors: [{ field: "file", message: "A theme file can be at most 16 KiB." }],
    };
  }
  const decoded = decodeThemeFile(input, THEME_FILE_PARSE_OPTIONS);
  if (Result.isFailure(decoded)) {
    return {
      ok: false,
      errors: formatIssues(decoded.failure.issue).issues.map((issue) => ({
        field: issue.path?.map(String).join(".") || "file",
        message: issue.message,
      })),
    };
  }
  const theme = decoded.success;
  const errors: ThemeFieldError[] = [];
  if (!options.allowReservedId && (RESERVED_THEME_IDS as readonly string[]).includes(theme.id)) {
    errors.push({ field: "id", message: "This id belongs to a built-in theme." });
  }
  for (const [token, value] of Object.entries(theme.ui ?? {})) {
    const message = themeValueError(token, value);
    if (message) errors.push({ field: `ui.${token}`, message });
  }
  for (const [token, value] of Object.entries(theme.terminal ?? {})) {
    if (!isSafeCssColor(value)) errors.push({ field: `terminal.${token}`, message: COLOR_ERROR });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, theme };
}
