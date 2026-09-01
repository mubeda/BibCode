import { describe, expect, it } from "vite-plus/test";

import { classifyDiffPayload } from "./diffLadder";

describe("classifyDiffPayload", () => {
  it("never renders payloads at or above 70 MB", () => {
    expect(classifyDiffPayload({ byteLength: 69_999_999, longestLineLength: 10 })).toBe(
      "large-text",
    );
    expect(classifyDiffPayload({ byteLength: 70_000_000, longestLineLength: 10 })).toBe(
      "unrenderable",
    );
  });

  it("requires an explicit opt-in at 4.375 MB", () => {
    expect(classifyDiffPayload({ byteLength: 4_374_999, longestLineLength: 5_000 })).toBe(
      "renderable",
    );
    expect(classifyDiffPayload({ byteLength: 4_375_000, longestLineLength: 5_000 })).toBe(
      "large-text",
    );
  });

  it("degrades a line only when it is longer than 5,000 characters", () => {
    expect(classifyDiffPayload({ byteLength: 100, longestLineLength: 5_000 })).toBe("renderable");
    expect(classifyDiffPayload({ byteLength: 100, longestLineLength: 5_001 })).toBe("large-text");
  });
});
