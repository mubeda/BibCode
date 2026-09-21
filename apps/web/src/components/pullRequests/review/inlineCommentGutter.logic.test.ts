import { describe, expect, it } from "vite-plus/test";
import {
  createInlineCommentGutter,
  insertSuggestion,
  sourceLinesForSelection,
} from "./inlineCommentGutter.logic";
describe("inline comment gutter", () => {
  it("a click selects one line and a reverse shift-drag normalizes the range", () => {
    const gutter = createInlineCommentGutter();
    expect(gutter.selectionRange()).toBeNull();
    gutter.beginSelection("src/a.ts", 9, "left");
    expect(gutter.selectionRange()).toEqual({
      path: "src/a.ts",
      startLine: 9,
      line: 9,
      side: "left",
    });
    gutter.extendSelection(4);
    expect(gutter.selectionRange()).toEqual({
      path: "src/a.ts",
      startLine: 4,
      line: 9,
      side: "left",
    });
    gutter.beginSelection("b.ts", 2, "right");
    gutter.extendSelection(5);
    expect(gutter.selectionRange()).toEqual({ path: "b.ts", startLine: 2, line: 5, side: "right" });
  });
  it("ignores invalid lines and extension before a selection", () => {
    const gutter = createInlineCommentGutter();
    gutter.extendSelection(5);
    gutter.beginSelection("a", -1, "right");
    expect(gutter.selectionRange()).toBeNull();
  });
  const patch = "--- a/a\n+++ b/a\n@@ -10,3 +20,3 @@\n context\n-old\n+new\n last\n";
  it.each([
    ["right", 20, 22, "context\nnew\nlast"],
    ["left", 10, 12, "context\nold\nlast"],
  ] as const)(
    "reads %s source lines from the original patch",
    (side, startLine, line, expected) => {
      expect(sourceLinesForSelection(patch, { startLine, line, side })).toBe(expected);
    },
  );
  it("does not invent source outside loaded hunks", () =>
    expect(sourceLinesForSelection(patch, { startLine: 1, line: 20, side: "right" })).toBeNull());
  it("inserts the selected source in a suggestion fence", () =>
    expect(insertSuggestion("Please change", "one\ntwo")).toBe(
      "Please change\n\n```suggestion\none\ntwo\n```",
    ));
});
