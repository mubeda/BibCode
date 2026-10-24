import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ReviewDiffPreviewInput, ReviewDiffPreviewSource } from "./review.ts";

const decodeInput = Schema.decodeUnknownSync(ReviewDiffPreviewInput);
const decodeSource = Schema.decodeUnknownSync(ReviewDiffPreviewSource);

const SOURCE = {
  id: "working-tree",
  kind: "working-tree",
  title: "Dirty worktree",
  baseRef: "HEAD",
  headRef: null,
  diff: "",
  diffHash: "0".repeat(64),
  truncated: false,
};

describe("review diff context lines", () => {
  it("accepts a context count from 0 to 99 and refuses anything else", () => {
    expect(decodeInput({ cwd: "/repo", contextLines: 0 }).contextLines).toBe(0);
    expect(decodeInput({ cwd: "/repo", contextLines: 99 }).contextLines).toBe(99);
    expect("contextLines" in decodeInput({ cwd: "/repo" })).toBe(false);
    for (const contextLines of [-1, 100, 1.5, "3"]) {
      expect(() => decodeInput({ cwd: "/repo", contextLines })).toThrow();
    }
  });

  it("reads the echoed count, and an older server's source without one", () => {
    expect(decodeSource({ ...SOURCE, contextLines: 7 }).contextLines).toBe(7);
    expect("contextLines" in decodeSource(SOURCE)).toBe(false);
  });
});
