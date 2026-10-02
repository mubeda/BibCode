import { describe, expect, it } from "vite-plus/test";

import { textSizesBelowTextXs } from "./uiTypography";

describe("textSizesBelowTextXs", () => {
  it("does not interpret expressions or percentages as pixel literals", () => {
    expect(
      textSizesBelowTextXs(
        'fontSize: 2 * 8, fontSize: 10 + offset, font-size: 9%; font-size: calc(8px + 4px); fontSize: "50%", fontSize: "0.5rem" + suffix',
      ),
    ).toEqual([]);
  });

  it("finds undersized CSS and inline numeric font declarations", () => {
    expect(
      textSizesBelowTextXs(
        'font-size: 11px !important; font-size: 0.6875rem; fontSize: 10, fontSize: "0.5em"',
      ),
    ).toEqual(["font-size: 11px", "font-size: 0.6875rem", "fontSize: 10", 'fontSize: "0.5em"']);
    expect(textSizesBelowTextXs('font-size: 12px; fontSize: 12, fontSize: "0.75rem"')).toEqual([]);
  });

  it("finds pixel sizes below 12 px, including fractional ones", () => {
    expect(
      textSizesBelowTextXs(
        '<span class="text-[9px]">a</span><span class="md:text-[11.5px]">b</span><i class="text-[10px]!"></i>',
      ),
    ).toEqual(["text-[9px]", "text-[11.5px]", "text-[10px]"]);
  });

  it("finds rem and em sizes below 0.75 (12 px at a 16 px base)", () => {
    expect(
      textSizesBelowTextXs(
        'class="text-[0.7rem] sm:text-[.625rem] text-[0.6875em] text-[length:0.5rem]"',
      ),
    ).toEqual(["text-[0.7rem]", "text-[.625rem]", "text-[0.6875em]", "text-[length:0.5rem]"]);
  });

  it("accepts text-xs and arbitrary sizes of 12 px or larger", () => {
    expect(
      textSizesBelowTextXs(
        'class="text-xs text-[12px] text-[13px] text-[0.75rem] text-[1em] text-[var(--size)] context-[9px]"',
      ),
    ).toEqual([]);
  });
});
