import { describe, expect, it } from "vite-plus/test";
import { newerObservedAt } from "./snapshotDisplay.logic";

describe("newerObservedAt", () => {
  it("accepts the first copy and a later copy, and rejects an older one", () => {
    expect(newerObservedAt(null, 10)).toBe(true);
    expect(newerObservedAt(10, 11)).toBe(true);
    expect(newerObservedAt(11, 10)).toBe(false);
    expect(newerObservedAt(10, 10)).toBe(false);
  });
});
