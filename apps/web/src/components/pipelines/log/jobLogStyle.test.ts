import { describe, expect, it } from "vite-plus/test";
import { terminalExtendedAnsiPalette } from "../../terminalTheme";
import { FLAG_BOLD, FLAG_CONCEAL, FLAG_INVERSE, FLAG_STRIKE, FLAG_UNDERLINE } from "./jobLog.parse";
import { logPalette, spanPresentation } from "./jobLogStyle";

describe("job log styles", () => {
  it("sets the terminal's 16 colors on the log root for each theme", () => {
    expect(logPalette("dark").variables).toMatchObject({
      "--log-ansi-1": "rgb(255, 122, 142)",
      "--log-ansi-15": "rgb(244, 247, 252)",
    });
    expect(logPalette("light").variables).toMatchObject({ "--log-ansi-1": "rgb(191, 70, 87)" });
    expect(logPalette("light")).toBe(logPalette("light"));
  });

  it("draws named colors from the variables and 256 colors inline", () => {
    const palette = logPalette("light");
    expect(spanPresentation({ fg: 2, bg: 4, flags: 0 }, palette)).toEqual({
      className: undefined,
      style: { color: "var(--log-ansi-2)", backgroundColor: "var(--log-ansi-4)" },
    });
    expect(spanPresentation({ fg: 208, bg: -1, flags: 0 }, palette).style).toEqual({
      color: terminalExtendedAnsiPalette("light")[208 - 16],
    });
    expect(spanPresentation({ fg: -1, bg: -1, flags: 0 }, palette)).toEqual({
      className: undefined,
      style: undefined,
    });
  });

  it("maps weights and decorations to classes, inverse and conceal to colors", () => {
    const palette = logPalette("dark");
    expect(
      spanPresentation({ fg: -1, bg: -1, flags: FLAG_BOLD | FLAG_UNDERLINE | FLAG_STRIKE }, palette)
        .className,
    ).toBe("font-semibold [text-decoration-line:underline_line-through]");
    expect(spanPresentation({ fg: 1, bg: -1, flags: FLAG_INVERSE }, palette).style).toEqual({
      color: "var(--background)",
      backgroundColor: "var(--log-ansi-1)",
    });
    expect(spanPresentation({ fg: 1, bg: -1, flags: FLAG_CONCEAL }, palette).style?.color).toBe(
      "transparent",
    );
  });
});
