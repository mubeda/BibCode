import { describe, expect, it } from "vite-plus/test";

import { resolveTagDeleteDialogCopy, validateTagName } from "./GitManagerTagDialog.logic";

describe("validateTagName", () => {
  it("accepts a unique Git tag ref name", () => {
    expect(validateTagName("release/v1", ["v0.9"])).toEqual({ valid: true, reason: null });
  });

  it("rejects duplicates immediately and case-sensitively", () => {
    expect(validateTagName("release/v1", ["release/v1"])).toEqual({
      valid: false,
      reason: "A tag named release/v1 already exists.",
    });
    expect(validateTagName("Release/v1", ["release/v1"]).valid).toBe(true);
  });

  it("enforces the 245-character cap and Git ref-name rules", () => {
    expect(validateTagName("x".repeat(246), []).reason).toBe(
      "Tag names must be 245 characters or fewer.",
    );
    for (const name of ["-release", "bad..name", "refs/@{bad", "topic.lock", ".hidden"]) {
      expect(validateTagName(name, [])).toEqual({
        valid: false,
        reason: "Enter a valid Git tag name.",
      });
    }
  });
});

describe("resolveTagDeleteDialogCopy", () => {
  it("names the destructive local-only action and leaves remote deletion out of scope", () => {
    expect(resolveTagDeleteDialogCopy("release/v1")).toEqual({
      title: "Delete tag release/v1?",
      description:
        "This deletes the local tag release/v1. A tag already pushed to a remote is not deleted there.",
      confirmLabel: "Delete Tag",
    });
  });
});
