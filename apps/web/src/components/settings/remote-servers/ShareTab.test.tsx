// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import { ShareTab } from "./ShareTab";

describe("ShareTab", () => {
  it("exports the moved share-side settings surface", () => {
    expect(typeof ShareTab).toBe("function");
  });
});
