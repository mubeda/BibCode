import { describe, expect, it } from "vite-plus/test";
import {
  FRESH_MS,
  VISIBLE_REFRESH_MS,
  shouldRefreshOnShow,
  visibleRefreshDelay,
} from "./visibleRefresh.logic";

describe("visibleRefreshDelay", () => {
  it("waits 20s from the last success while visible", () => {
    expect(visibleRefreshDelay(true, 1_000, 1_000)).toBe(VISIBLE_REFRESH_MS);
    expect(visibleRefreshDelay(true, 1_000, 6_000)).toBe(15_000);
  });

  it("does not schedule while hidden or before any success", () => {
    expect(visibleRefreshDelay(false, 1_000, 2_000)).toBeNull();
    expect(visibleRefreshDelay(true, null, 2_000)).toBeNull();
  });

  it("is due immediately once the period has elapsed", () => {
    expect(visibleRefreshDelay(true, 0, VISIBLE_REFRESH_MS)).toBe(0);
  });
});

describe("shouldRefreshOnShow", () => {
  it("refreshes when the last success is older than 5s", () => {
    expect(shouldRefreshOnShow(0, FRESH_MS)).toBe(false);
    expect(shouldRefreshOnShow(0, FRESH_MS + 1)).toBe(true);
    expect(shouldRefreshOnShow(null, 1)).toBe(false);
  });
});
