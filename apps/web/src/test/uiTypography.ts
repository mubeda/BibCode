/**
 * UI.md typography: the smallest text in the app is `text-xs` (12 px). Tests pin a rendered
 * surface with `expect(textSizesBelowTextXs(markup)).toEqual([])`.
 */

/** 16 px, the root font size that rem (and, approximately, em) sizes are measured against. */
const BASE_FONT_SIZE_PX = 16;
const TEXT_XS_PX = 12;

/** An arbitrary Tailwind font size: `text-[11px]`, `md:text-[.7rem]`, `text-[length:0.6em]`. */
const ARBITRARY_TEXT_SIZE = /\btext-\[(?:length:)?(\d*\.?\d+)(px|rem|em)\]/g;

/** Every arbitrary text size below 12 px in `markup` (or source), in order of appearance. */
export function textSizesBelowTextXs(markup: string): string[] {
  return [...markup.matchAll(ARBITRARY_TEXT_SIZE)]
    .filter(([, amount, unit]) => {
      const px = Number(amount) * (unit === "px" ? 1 : BASE_FONT_SIZE_PX);
      return px < TEXT_XS_PX;
    })
    .map(([size]) => size);
}
