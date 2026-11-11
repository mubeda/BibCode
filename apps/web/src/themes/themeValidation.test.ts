import { describe, expect, it } from "vite-plus/test";

import { isSafeCssColor, MAX_THEME_FILE_BYTES, validateThemeFile } from "./themeValidation";

const base = { version: 1, id: "my-theme", name: "My theme", base: "light" } as const;

function errorsFor(
  input: unknown,
  options: { allowReservedId: boolean; byteLength?: number } = { allowReservedId: false },
) {
  const result = validateThemeFile(input, options);
  return result.ok ? [] : result.errors;
}

describe("isSafeCssColor", () => {
  it("a number that overflows to infinity is rejected in every argument of every syntax, and an exponent that stays finite is accepted", () => {
    const overflow = ["1e999", "-1e999", "+1e400", "1e999%", "1e99999", ".5e999", "1e999deg"];
    const forms = [
      (n: string) => `hsl(${n} 50% 50%)`,
      (n: string) => `hsl(10 ${n} 50%)`,
      (n: string) => `hsl(10 50% ${n})`,
      (n: string) => `hsl(10, 50%, ${n})`,
      (n: string) => `hsla(10, 50%, 50%, ${n})`,
      (n: string) => `rgb(${n} 20 30)`,
      (n: string) => `rgb(10 ${n} 30)`,
      (n: string) => `rgb(10 20 ${n})`,
      (n: string) => `rgb(10, 20, ${n})`,
      (n: string) => `rgb(10 20 30 / ${n})`,
      (n: string) => `oklch(${n} 0.1 250)`,
      (n: string) => `oklch(0.7 ${n} 250)`,
      (n: string) => `oklch(0.7 0.1 ${n})`,
      (n: string) => `oklch(0.7 0.1 250 / ${n})`,
    ];
    for (const form of forms) {
      for (const n of overflow) expect(isSafeCssColor(form(n)), form(n)).toBe(false);
    }
    // Finite exponents parse like CSS: huge channels clamp, tiny ones underflow to zero.
    for (const value of [
      "hsl(1e2 50% 50%)",
      "rgb(1e2 2e1 3E0)",
      "rgb(1e-999 0 0)",
      "oklch(7e-1 1e-1 2.5e2)",
    ]) {
      expect(isSafeCssColor(value), value).toBe(true);
    }
  });

  it("hex, rgb(), hsl() and oklch() colors are accepted and named colors, color-mix() and inherit are rejected", () => {
    for (const value of [
      "#fff",
      "#ffff",
      "#3b82f6",
      "#3b82f680",
      "rgb(10, 20, 30)",
      "rgb(10 20 30 / 50%)",
      "rgba(10, 20, 30, 0.5)",
      "hsl(210deg 50% 40%)",
      "hsl(210, 50%, 40%)",
      "oklch(0.7 0.1 250)",
      "oklch(70% 0.1 250 / 0.5)",
    ]) {
      expect(isSafeCssColor(value), value).toBe(true);
    }
    for (const value of [
      "red",
      "transparent",
      "color-mix(in srgb, red 50%, blue)",
      "inherit",
      "#12",
      "#1234567",
      "rgb()",
      "rgb(a, b, c)",
      "",
    ]) {
      expect(isSafeCssColor(value), value).toBe(false);
    }
  });

  it("url(), var(), expression(), a semicolon and a brace are rejected", () => {
    for (const value of [
      "url(https://example.test/x)",
      "var(--x)",
      "expression(1)",
      "red; background: blue",
      "red}",
      "#fff;",
      "rgb(1, 2, 3)}",
    ]) {
      expect(isSafeCssColor(value), value).toBe(false);
    }
  });
});

describe("validateThemeFile", () => {
  it("radius accepts 0 to 1rem and rejects 2rem", () => {
    for (const radius of ["0rem", "0px", "0.5rem", "1rem", "16px"]) {
      expect(errorsFor({ ...base, ui: { radius } }), radius).toEqual([]);
    }
    for (const radius of ["2rem", "17px", "0", "-1px", "1em"]) {
      expect(errorsFor({ ...base, ui: { radius } }), radius).toEqual([
        expect.objectContaining({ field: "ui.radius" }),
      ]);
    }
  });

  it("focus-ring-width accepts 1px to 3px and focus-ring-offset 0px to 3px", () => {
    expect(errorsFor({ ...base, ui: { "focus-ring-width": "1px" } })).toEqual([]);
    expect(errorsFor({ ...base, ui: { "focus-ring-width": "3px" } })).toEqual([]);
    expect(errorsFor({ ...base, ui: { "focus-ring-width": "0px" } })).toHaveLength(1);
    expect(errorsFor({ ...base, ui: { "focus-ring-width": "4px" } })).toHaveLength(1);
    expect(errorsFor({ ...base, ui: { "focus-ring-offset": "0px" } })).toEqual([]);
    expect(errorsFor({ ...base, ui: { "focus-ring-offset": "3px" } })).toEqual([]);
    expect(errorsFor({ ...base, ui: { "focus-ring-offset": "3.5px" } })).toHaveLength(1);
  });

  it("sidebar-card-shadow accepts only none and control-shadow only none or default", () => {
    expect(errorsFor({ ...base, ui: { "sidebar-card-shadow": "none" } })).toEqual([]);
    expect(errorsFor({ ...base, ui: { "sidebar-card-shadow": "default" } })).toHaveLength(1);
    expect(errorsFor({ ...base, ui: { "control-shadow": "none" } })).toEqual([]);
    expect(errorsFor({ ...base, ui: { "control-shadow": "default" } })).toEqual([]);
    expect(errorsFor({ ...base, ui: { "control-shadow": "default; color: red" } })).toHaveLength(1);
  });

  it("a 17 KiB file is rejected by size", () => {
    expect(errorsFor(base, { allowReservedId: false, byteLength: 17 * 1024 })).toEqual([
      expect.objectContaining({ field: "file" }),
    ]);
    expect(MAX_THEME_FILE_BYTES).toBe(16 * 1024);
  });

  it("a reserved id is rejected unless allowReservedId is set", () => {
    expect(errorsFor({ ...base, id: "dark" })).toEqual([expect.objectContaining({ field: "id" })]);
    expect(errorsFor({ ...base, id: "dark" }, { allowReservedId: true })).toEqual([]);
  });

  it("every error names its field", () => {
    const errors = errorsFor({
      ...base,
      ui: { primary: "url(x)" },
      terminal: { red: "var(--y)" },
    });
    expect(errors.map((error) => error.field).toSorted()).toEqual(["terminal.red", "ui.primary"]);
    expect(errors.every((error) => error.message.length > 0)).toBe(true);
  });

  it("a schema error names the unknown token", () => {
    expect(errorsFor({ ...base, ui: { "not-a-token": "#fff" } })).toEqual([
      expect.objectContaining({ field: "ui.not-a-token" }),
    ]);
  });

  it("a valid theme is returned as decoded", () => {
    const result = validateThemeFile(
      { ...base, ui: { primary: "#3b82f6" } },
      {
        allowReservedId: false,
      },
    );
    expect(result).toEqual({ ok: true, theme: { ...base, ui: { primary: "#3b82f6" } } });
  });
});
