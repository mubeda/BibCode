import { describe, expect, it } from "vite-plus/test";
import {
  EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH,
  resolveCenterPaneHeaderDensity,
} from "./centerPaneHeaderDensity";

describe("resolveCenterPaneHeaderDensity", () => {
  it.each([
    [Number.NaN, "compact"],
    [-1, "compact"],
    [EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH - 1, "compact"],
    [EXPANDED_CENTER_PANE_HEADER_MIN_WIDTH, "expanded"],
    [1200, "expanded"],
  ] as const)("maps %s to %s", (width, expected) => {
    expect(resolveCenterPaneHeaderDensity(width)).toBe(expected);
  });
});
