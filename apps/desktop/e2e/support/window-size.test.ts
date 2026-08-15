import { describe, expect, it } from "vite-plus/test";

import { correctDesktopUiOuterSize, scaleDesktopUiWindowSize } from "./window-size.ts";

describe("scaleDesktopUiWindowSize", () => {
  it("keeps CSS pixels unchanged on standard-density runners", () => {
    expect(scaleDesktopUiWindowSize({ width: 960, height: 640 }, 1)).toEqual({
      width: 960,
      height: 640,
    });
  });

  it("converts CSS pixels to physical pixels on Retina macOS runners", () => {
    expect(scaleDesktopUiWindowSize({ width: 960, height: 640 }, 2)).toEqual({
      width: 1_920,
      height: 1_280,
    });
  });

  it("rounds fractional device-pixel ratios up to preserve the requested viewport", () => {
    expect(scaleDesktopUiWindowSize({ width: 1_001, height: 721 }, 1.25)).toEqual({
      width: 1_252,
      height: 902,
    });
  });
});

describe("correctDesktopUiOuterSize", () => {
  it("adds Windows frame decoration when the inner viewport is smaller", () => {
    expect(
      correctDesktopUiOuterSize(
        { width: 800, height: 720 },
        { width: 800, height: 720 },
        { width: 784, height: 661 },
        1,
      ),
    ).toEqual({ width: 816, height: 779 });
  });

  it("keeps an outer size that already produces the requested viewport", () => {
    expect(
      correctDesktopUiOuterSize(
        { width: 1_920, height: 1_280 },
        { width: 960, height: 640 },
        { width: 960, height: 640 },
        2,
      ),
    ).toEqual({ width: 1_920, height: 1_280 });
  });

  it("rounds fractional viewport corrections up", () => {
    expect(
      correctDesktopUiOuterSize(
        { width: 1_252, height: 902 },
        { width: 1_001, height: 721 },
        { width: 1_000, height: 720 },
        1.25,
      ),
    ).toEqual({ width: 1_254, height: 904 });
  });
});
