import { describe, expect, it } from "vite-plus/test";

import { textColorUtilities } from "./sidebarLevels.testSupport";

describe("textColorUtilities", () => {
  it("finds plain and variant colour utilities and skips size and alignment", () => {
    expect(textColorUtilities("truncate text-xs text-center hover:text-foreground")).toEqual([
      "hover:text-foreground",
    ]);
  });

  it("finds an arbitrary colour whose value holds a colon", () => {
    expect(textColorUtilities("text-[color:var(--foreground)]")).toEqual([
      "text-[color:var(--foreground)]",
    ]);
    expect(textColorUtilities("dark:text-[color:var(--x)]")).toEqual([
      "dark:text-[color:var(--x)]",
    ]);
  });

  it("finds an important colour utility", () => {
    expect(textColorUtilities("!text-foreground")).toEqual(["!text-foreground"]);
    expect(textColorUtilities("hover:!text-foreground")).toEqual(["hover:!text-foreground"]);
    expect(textColorUtilities("text-foreground!")).toEqual(["text-foreground!"]);
    expect(textColorUtilities("!text-xs")).toEqual([]);
  });
});
