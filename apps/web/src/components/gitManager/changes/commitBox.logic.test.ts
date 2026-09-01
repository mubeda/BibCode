import { describe, expect, it } from "vite-plus/test";

import {
  buildCommitMessage,
  buildPlaceholderSummary,
  formatCoAuthorTrailers,
  isCommitEnabled,
  isSummaryOverIdealLength,
} from "./commitBox.logic";

describe("isCommitEnabled", () => {
  it("requires a usable summary and changes unless an explicit commit mode supplies them", () => {
    expect(
      isCommitEnabled({
        summary: "",
        includedCount: 0,
        allowEmpty: false,
        isAmending: false,
        isBusy: false,
      }),
    ).toBe(false);
    expect(
      isCommitEnabled({
        summary: "",
        includedCount: 1,
        allowEmpty: false,
        isAmending: false,
        isBusy: false,
      }),
    ).toBe(true);
    expect(
      isCommitEnabled({
        summary: "",
        includedCount: 0,
        allowEmpty: true,
        isAmending: false,
        isBusy: false,
      }),
    ).toBe(true);
    expect(
      isCommitEnabled({
        summary: "Ready",
        includedCount: 1,
        allowEmpty: false,
        isAmending: false,
        isBusy: true,
      }),
    ).toBe(false);
  });
});

describe("buildPlaceholderSummary", () => {
  it("uses the basename only when exactly one path is included", () => {
    expect(buildPlaceholderSummary(["src/feature/panel.tsx"])).toBe("Update panel.tsx");
    expect(buildPlaceholderSummary(["one.ts", "two.ts"])).toBe("");
    expect(buildPlaceholderSummary([])).toBe("");
  });
});

describe("formatCoAuthorTrailers", () => {
  it("formats one trailer per email and de-duplicates email case-insensitively", () => {
    expect(
      formatCoAuthorTrailers([
        { name: "Ada Lovelace", email: "ada@example.test" },
        { name: "Ada Again", email: "ADA@EXAMPLE.TEST" },
        { name: "Grace Hopper", email: "grace@example.test" },
      ]),
    ).toBe(
      "Co-Authored-By: Ada Lovelace <ada@example.test>\nCo-Authored-By: Grace Hopper <grace@example.test>",
    );
  });
});

describe("buildCommitMessage", () => {
  it("separates the summary, description, and co-author trailers with blank lines", () => {
    expect(
      buildCommitMessage({
        summary: "Add the commit surface",
        description: "Keep the checkout draft shared.",
        coAuthors: [{ name: "Ada Lovelace", email: "ada@example.test" }],
      }),
    ).toBe(
      "Add the commit surface\n\nKeep the checkout draft shared.\n\nCo-Authored-By: Ada Lovelace <ada@example.test>",
    );
  });
});

describe("isSummaryOverIdealLength", () => {
  it("shows the hint only after 50 characters", () => {
    expect(isSummaryOverIdealLength("x".repeat(50))).toBe(false);
    expect(isSummaryOverIdealLength("x".repeat(51))).toBe(true);
  });
});
