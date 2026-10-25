import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ReviewDiffPreviewInput,
  ReviewDiffPreviewSource,
  ReviewDiffToolError,
  ReviewListDiffToolsResult,
  ReviewOpenDiffToolInput,
  ReviewOpenDiffToolResult,
  ReviewReadFileVersionInput,
  ReviewReadFileVersionResult,
} from "./review.ts";

const decodeInput = Schema.decodeUnknownSync(ReviewDiffPreviewInput);
const decodeSource = Schema.decodeUnknownSync(ReviewDiffPreviewSource);
const decodeVersionInput = Schema.decodeUnknownSync(ReviewReadFileVersionInput);
const decodeVersionResult = Schema.decodeUnknownSync(ReviewReadFileVersionResult);
const decodeToolList = Schema.decodeUnknownSync(ReviewListDiffToolsResult);
const decodeOpenInput = Schema.decodeUnknownSync(ReviewOpenDiffToolInput);
const decodeOpenResult = Schema.decodeUnknownSync(ReviewOpenDiffToolResult);
const decodeToolError = Schema.decodeUnknownSync(ReviewDiffToolError);

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

describe("review diff tools", () => {
  it("reads the server's tool list and the source of its default", () => {
    const list = decodeToolList({
      tools: [
        { id: "bc", label: "Beyond Compare", kind: "builtin" },
        { id: "sourcetree", label: "sourcetree", kind: "custom" },
      ],
      defaultToolId: "bc",
      defaultSource: "diff.guitool",
    });
    expect(list.tools.map((tool) => tool.id)).toEqual(["bc", "sourcetree"]);
    expect(list.defaultSource).toBe("diff.guitool");
    for (const defaultSource of ["merge.guitool", "diff.tool", "merge.tool", null]) {
      expect(decodeToolList({ tools: [], defaultToolId: null, defaultSource }).defaultSource).toBe(
        defaultSource,
      );
    }
    expect(() =>
      decodeToolList({ tools: [], defaultToolId: null, defaultSource: "core.editor" }),
    ).toThrow();
  });

  it("names a file or every file, in a working-tree, branch or turn scope", () => {
    const base = { cwd: "/repo", toolId: "bc" };
    expect(
      decodeOpenInput({
        ...base,
        target: { _tag: "file", path: "new.ts", previousPath: "old.ts" },
        scope: { _tag: "working-tree" },
      }).target,
    ).toEqual({ _tag: "file", path: "new.ts", previousPath: "old.ts" });
    expect(
      decodeOpenInput({
        ...base,
        target: { _tag: "all" },
        scope: { _tag: "branch", baseRef: null },
      }).scope,
    ).toEqual({ _tag: "branch", baseRef: null });
    expect(
      decodeOpenInput({
        ...base,
        target: { _tag: "all" },
        scope: { _tag: "turn", threadId: "thread-1", fromTurnCount: 1, toTurnCount: 2 },
      }).scope,
    ).toEqual({ _tag: "turn", threadId: "thread-1", fromTurnCount: 1, toTurnCount: 2 });
    for (const toolId of ["", "-x", "--extcmd=sh", "a b", ".x"]) {
      expect(() =>
        decodeOpenInput({
          ...base,
          toolId,
          target: { _tag: "all" },
          scope: { _tag: "working-tree" },
        }),
      ).toThrow();
    }
    expect(() =>
      decodeOpenInput({
        ...base,
        target: { _tag: "all" },
        scope: { _tag: "turn", threadId: "thread-1", fromTurnCount: 2, toTurnCount: 1 },
      }),
    ).toThrow();
  });

  it("reads an opened app and every launch failure with its command", () => {
    expect(decodeOpenResult({ _tag: "opened" })).toEqual({ _tag: "opened" });
    for (const reason of ["launch-failed", "too-many-open", "shutting-down", "invalid-request"]) {
      const error = decodeToolError({
        _tag: "ReviewDiffToolError",
        reason,
        message: "tool failed (exit 3)",
        command: ["git", "-C", "/repo", "difftool"],
      });
      expect(error.reason).toBe(reason);
      expect(error.command).toEqual(["git", "-C", "/repo", "difftool"]);
    }
  });
});
