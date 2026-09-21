import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PullRequestsReactions } from "./PullRequestsReactions";
describe("PullRequestsReactions", () => {
  it("renders counts and the viewer reaction as read-only text", () => {
    const html = renderToStaticMarkup(
      <PullRequestsReactions
        reactions={[
          { content: "+1", count: 2, viewerReacted: true },
          { content: "heart", count: 1, viewerReacted: false },
        ]}
      />,
    );
    expect(html).toContain("👍");
    expect(html).toContain("2");
    expect(html).toContain("You reacted");
    expect(html).toContain("❤️");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<img");
  });
  it("does not render an empty bar", () =>
    expect(renderToStaticMarkup(<PullRequestsReactions reactions={[]} />)).toBe(""));
});
