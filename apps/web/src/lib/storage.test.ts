import { describe, expect, it } from "vite-plus/test";

import { createMemoryStorage, resolveStorage } from "./storage";

describe("resolveStorage", () => {
  it("reads BiBCode values", () => {
    const base = createMemoryStorage();
    base.setItem("bibcode:panel", "saved");
    const storage = resolveStorage(base);

    expect(storage.getItem("bibcode:panel")).toBe("saved");
    expect(base.getItem("bibcode:panel")).toBe("saved");
    expect(base.getItem("bibcode:panel")).toBe("saved");
  });
});
