import { describe, expect, it } from "vite-plus/test";

import { latestThoughtLine, reasoningLabel, reasoningPreview } from "./reasoning.ts";

describe("reasoning presentation", () => {
  it("labels a streaming block Thinking and a finished one Thought", () => {
    expect(reasoningLabel({ streaming: true })).toBe("Thinking");
    expect(reasoningLabel({ streaming: false })).toBe("Thought");
  });

  it("previews the first non-empty line as plain text", () => {
    expect(
      reasoningPreview({
        text: "\n\n## **Checking** the `parser`   and [its tests](src/parser.test.ts)\n\nMore.",
      }),
    ).toBe("Checking the parser and its tests");
    expect(reasoningPreview({ text: "- *First* item\n- second" })).toBe("First item");
    expect(reasoningPreview({ text: "  \n\n " })).toBeNull();
  });

  it("caps the preview at 160 characters", () => {
    const preview = reasoningPreview({ text: "word ".repeat(100) });
    expect(Array.from(preview ?? "")).toHaveLength(160);
    expect(preview?.endsWith("…")).toBe(true);
  });

  it("uses a bold-only first line as the latest thought", () => {
    expect(
      latestThoughtLine({
        text: "**Planning the migration**\n\nI need to read the ledger first. Then add it.",
      }),
    ).toBe("Planning the migration");
  });

  it("uses the first sentence otherwise", () => {
    expect(
      latestThoughtLine({
        text: "The test fails because the\nfixture is stale. Regenerate it next.",
      }),
    ).toBe("The test fails because the fixture is stale.");
    expect(latestThoughtLine({ text: "Version 1.2 is installed" })).toBe(
      "Version 1.2 is installed",
    );
    expect(latestThoughtLine({ text: "" })).toBeNull();
  });

  it("caps the latest thought at 200 characters", () => {
    const line = latestThoughtLine({ text: `${"long ".repeat(80)}end.` });
    expect(Array.from(line ?? "")).toHaveLength(200);
    expect(line?.endsWith("…")).toBe(true);
  });
});
