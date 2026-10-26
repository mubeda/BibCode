import { describe, expect, it } from "vite-plus/test";

import { nextListIndex } from "./DiffFileList";

describe("nextListIndex", () => {
  it("moves one row, to the ends, and by a page, clamped to the list", () => {
    expect(nextListIndex("ArrowDown", 0, 30)).toBe(1);
    expect(nextListIndex("ArrowDown", 29, 30)).toBe(29);
    expect(nextListIndex("ArrowUp", 0, 30)).toBe(0);
    expect(nextListIndex("ArrowUp", 5, 30)).toBe(4);
    expect(nextListIndex("ArrowUp", -1, 30), "nothing selected starts at the top").toBe(0);
    expect(nextListIndex("Home", 12, 30)).toBe(0);
    expect(nextListIndex("End", 0, 30)).toBe(29);
    expect(nextListIndex("PageDown", 25, 30)).toBe(29);
    expect(nextListIndex("PageDown", 0, 30)).toBe(10);
    expect(nextListIndex("PageUp", 4, 30)).toBe(0);
  });

  it("ignores other keys and an empty list", () => {
    expect(nextListIndex("Enter", 0, 30)).toBeNull();
    expect(nextListIndex("a", 0, 30)).toBeNull();
    expect(nextListIndex("ArrowDown", 0, 0)).toBeNull();
  });
});
