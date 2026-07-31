import { describe, expect, it } from "vite-plus/test";

import { createMemoryStorage, resolveStorage } from "./storage";

describe("resolveStorage", () => {
  it("copies a legacy T4Code value to its canonical BiBCode key", () => {
    const base = createMemoryStorage();
    base.setItem("t4code:panel", "saved");
    const storage = resolveStorage(base);

    expect(storage.getItem("bibcode:panel")).toBe("saved");
    expect(base.getItem("bibcode:panel")).toBe("saved");
    expect(base.getItem("t4code:panel")).toBe("saved");
  });
});
