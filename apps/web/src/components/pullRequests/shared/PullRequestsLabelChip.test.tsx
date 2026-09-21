import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PullRequestsLabelChip } from "./PullRequestsLabelChip";
describe("PullRequestsLabelChip", () => {
  it.each([
    ["ffffff", "#000000"],
    ["#000000", "#ffffff"],
    ["#fff", "#000000"],
  ])("chooses readable text on %s", (color, text) => {
    const markup = renderToStaticMarkup(
      <PullRequestsLabelChip label={{ name: "bug", color: color!, description: "A bug" }} />,
    );
    expect(markup).toContain(`color:${text}`);
    expect(markup).toContain("bug");
    expect(markup).toContain('title="A bug"');
  });
  it("rejects non-color host strings", () => {
    const markup = renderToStaticMarkup(
      <PullRequestsLabelChip
        label={{ name: "safe", color: "url(https://tracker.test)", description: null }}
      />,
    );
    expect(markup).not.toContain("tracker.test");
    expect(markup).not.toContain("style=");
  });
});
