import { describe, expect, it } from "vite-plus/test";

import { buttonVariants } from "./button";

describe("buttonVariants content size", () => {
  it("uses responsive minimum heights without a fixed height", () => {
    const classes = buttonVariants({ size: "content" });

    expect(classes).toContain("min-h-9");
    expect(classes).toContain("sm:min-h-8");
    expect(classes).not.toMatch(/(?:^|\s)h-[^\s]+/);
    expect(classes).not.toMatch(/(?:^|\s)sm:h-[^\s]+/);
  });
});
