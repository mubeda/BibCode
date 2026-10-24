import { describe, expect, it } from "vite-plus/test";
import {
  countFindOccurrences,
  foldFindText,
  locateFindOccurrences,
  prepareFindQuery,
  projectFindSource,
  type FindSegment,
} from "./threadFindText";

const SKILLS = [{ name: "review", displayName: "Code Review" }];

function project(
  text: string,
  options: { lineBreaks?: boolean; skills?: typeof SKILLS; cwd?: string } = {},
): FindSegment[] {
  return projectFindSource(
    {
      kind: "markdown",
      scope: "md:0",
      text,
      lineBreaks: options.lineBreaks ?? false,
      skills: options.skills ?? [],
    },
    { cwd: options.cwd },
  );
}

function count(text: string, query: string, options?: Parameters<typeof project>[1]): number {
  return countFindOccurrences(project(text, options), prepareFindQuery(query)!);
}

describe("threadFindText projection", () => {
  it("matches a phrase across emphasis", () => {
    expect(count("**foo** bar", "foo bar")).toBe(1);
    expect(count("**foo** bar", "**")).toBe(0);
  });

  it("matches a link's text but not its URL", () => {
    const text = "See [the docs](https://example.com/guide) and [notes](#notes).";
    expect(count(text, "the docs")).toBe(1);
    expect(count(text, "example.com")).toBe(0);
    expect(count(text, "notes")).toBe(1);
  });

  it("matches a file link by its chip label, with the parent suffix for a shared basename", () => {
    const text = "Edit [a](/repo/src/a/file.ts) and [b](/repo/src/b/file.ts#L12).";
    expect(count(text, "file.ts · src/a")).toBe(1);
    expect(count(text, "src/b · L12")).toBe(1);
    // The path and the link text are not shown.
    expect(count(text, "/repo")).toBe(0);
    expect(count(text, "and b")).toBe(0);
  });

  it("counts a word in a file chip, a skill chip and ordinary text", () => {
    const text = "review [x](/repo/review.ts) then $review";
    expect(count(text, "review", { skills: SKILLS })).toBe(3);
    // The skill shows its name, not the token.
    expect(count(text, "$review", { skills: SKILLS })).toBe(0);
    expect(count(text, "code review", { skills: SKILLS })).toBe(1);
  });

  it("splits skills only where the renderer does: under a paragraph or list item", () => {
    expect(count("# Use $review", "code review", { skills: SKILLS })).toBe(0);
    expect(count("- use $review", "code review", { skills: SKILLS })).toBe(1);
    expect(count("Use `$review`", "code review", { skills: SKILLS })).toBe(0);
  });

  it("matches inline and fenced code, never across a block or a table cell", () => {
    const text = [
      "Run `npm test` now.",
      "",
      "```sh",
      "npm run build",
      "```",
      "",
      "| left | right |",
      "| ---- | ----- |",
      "| one  | two   |",
    ].join("\n");
    expect(count(text, "npm test")).toBe(1);
    expect(count(text, "npm run build")).toBe(1);
    expect(count(text, "now. npm")).toBe(0);
    expect(count(text, "one two")).toBe(0);
    expect(count(text, "left")).toBe(1);
  });

  it("flags text inside details with its ordinal, but not the summary", () => {
    const text = [
      "<details>",
      "<summary>First summary</summary>",
      "",
      "hidden one",
      "",
      "</details>",
      "",
      "<details>",
      "<summary>Second</summary>",
      "",
      "hidden two",
      "",
      "</details>",
    ].join("\n");
    const occurrences = (query: string) =>
      locateFindOccurrences(project(text), prepareFindQuery(query)!).map(
        (occurrence) => occurrence.segment.details,
      );
    expect(occurrences("hidden")).toEqual([[0], [1]]);
    expect(occurrences("summary")).toEqual([[]]);
  });

  it("drops what the sanitizer drops and shows nothing for an image", () => {
    const text = 'Safe <script>alert("x")</script> <img src="a.png" alt="picture"> text';
    expect(count(text, "alert")).toBe(0);
    expect(count(text, "picture")).toBe(0);
    expect(count(text, "safe")).toBe(1);
  });

  it("treats whitespace as equal and keeps offsets through the case fold", () => {
    expect(count("one\ntwo", "one two")).toBe(1);
    expect(count("one\ntwo", "one two", { lineBreaks: true })).toBe(1);
    expect(foldFindText("İstanbul").length).toBe("İstanbul".length);
    expect(foldFindText("ÉCOLE Σ")).toBe("école σ");
    expect(count("Welcome to ISTANBUL", "istanbul")).toBe(1);
  });

  it("projects plain text as one segment", () => {
    const segments = projectFindSource(
      { kind: "plain", scope: "command", text: "git status\n  --short" },
      { cwd: undefined },
    );
    expect(segments).toEqual([{ folded: "git status   --short", scope: "command", details: [] }]);
    expect(
      projectFindSource({ kind: "plain", scope: "command", text: "  " }, { cwd: undefined }),
    ).toEqual([]);
  });

  it("accepts a query of 1 to 256 units", () => {
    expect(prepareFindQuery("")).toBeNull();
    expect(prepareFindQuery("a")).toBe("a");
    expect(prepareFindQuery("x".repeat(256))?.length).toBe(256);
    expect(prepareFindQuery("x".repeat(300))?.length).toBe(256);
  });
});
