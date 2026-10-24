import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ReviewDiffPreviewInput,
  ReviewDiffPreviewSource,
  ReviewReadFileVersionInput,
  ReviewReadFileVersionResult,
} from "./review.ts";

const decodeInput = Schema.decodeUnknownSync(ReviewDiffPreviewInput);
const decodeSource = Schema.decodeUnknownSync(ReviewDiffPreviewSource);
const decodeVersionInput = Schema.decodeUnknownSync(ReviewReadFileVersionInput);
const decodeVersionResult = Schema.decodeUnknownSync(ReviewReadFileVersionResult);

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

describe("review file versions", () => {
  it("accepts only full lowercase object IDs", () => {
    for (const oid of ["a".repeat(40), "0".repeat(64)]) {
      expect(decodeVersionInput({ cwd: "/repo", version: { _tag: "blob", oid } }).version).toEqual({
        _tag: "blob",
        oid,
      });
    }
    for (const oid of ["abc123", "A".repeat(40), "--x", "g".repeat(40), "a".repeat(41)]) {
      expect(() => decodeVersionInput({ cwd: "/repo", version: { _tag: "blob", oid } })).toThrow();
    }
    expect(
      decodeVersionInput({
        cwd: "/repo",
        version: { _tag: "worktree", path: "src/a.ts", expectedOid: "f".repeat(40) },
      }).version,
    ).toEqual({ _tag: "worktree", path: "src/a.ts", expectedOid: "f".repeat(40) });
  });

  it("reads text and every unavailable reason", () => {
    expect(decodeVersionResult({ _tag: "text", contents: "a\n", byteLength: 2 })).toEqual({
      _tag: "text",
      contents: "a\n",
      byteLength: 2,
    });
    for (const reason of ["missing", "binary", "too-large", "not-a-file", "changed"]) {
      expect(decodeVersionResult({ _tag: "unavailable", reason, byteLength: null })).toEqual({
        _tag: "unavailable",
        reason,
        byteLength: null,
      });
    }
    expect(() =>
      decodeVersionResult({ _tag: "unavailable", reason: "gone", byteLength: null }),
    ).toThrow();
  });
});
