import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { THEME_FILE_PARSE_OPTIONS, ThemeFile } from "./theme.ts";

const decodeThemeFile = Schema.decodeUnknownResult(ThemeFile);
const decode = (input: unknown) => decodeThemeFile(input, THEME_FILE_PARSE_OPTIONS);

function failureText(input: unknown): string {
  const result = decode(input);
  if (Result.isSuccess(result)) throw new Error("expected the theme to be rejected");
  return String(result.failure);
}

const base = { version: 1, id: "my-theme", name: "My theme", base: "dark" } as const;

describe("ThemeFile", () => {
  it("a theme with only a base decodes", () => {
    const result = decode(base);
    expect(Result.isSuccess(result)).toBe(true);
  });

  it("a one-color theme decodes and keeps only that token", () => {
    const result = decode({ ...base, ui: { primary: "#3b82f6" } });
    expect(Result.isSuccess(result) && result.success.ui).toEqual({ primary: "#3b82f6" });
  });

  it("an unknown ui token is rejected and the error names it", () => {
    expect(failureText({ ...base, ui: { "not-a-token": "#ffffff" } })).toContain("not-a-token");
  });

  it("an unknown top-level field is rejected", () => {
    expect(failureText({ ...base, extra: true })).toContain("extra");
  });

  it("a name of 0 or 49 characters is rejected", () => {
    expect(Result.isFailure(decode({ ...base, name: "" }))).toBe(true);
    expect(Result.isFailure(decode({ ...base, name: "x".repeat(49) }))).toBe(true);
    expect(Result.isSuccess(decode({ ...base, name: "x".repeat(48) }))).toBe(true);
  });

  it("an id with uppercase or spaces is rejected", () => {
    expect(Result.isFailure(decode({ ...base, id: "My-Theme" }))).toBe(true);
    expect(Result.isFailure(decode({ ...base, id: "my theme" }))).toBe(true);
  });
});
