import { renderReviewMarkup as renderToStaticMarkup } from "../review/testHelpers";
import { describe, expect, it } from "vite-plus/test";
import { PullRequestsSuggestionBlock } from "./PullRequestsSuggestionBlock";
import { denied, thread } from "../detail/testFixtures";
describe("PullRequestsSuggestionBlock", () => {
  it("renders from/to lines as a mini diff and explains disabled Apply", () => {
    const html = renderToStaticMarkup(
      <PullRequestsSuggestionBlock
        suggestion={thread.comments[0]!.suggestion!}
        permission={denied}
      />,
    );
    expect(html).toContain("Lines 3–4");
    expect(html).toContain("-old");
    expect(html).toContain("+new");
    expect(html).toContain(">Apply<");
    expect(html).toContain('disabled=""');
    expect(html).toContain(`title="${denied.reason}"`);
    expect(html).toContain("aria-describedby");
  });
  it("enables Apply when the host and suggestion allow it", () => {
    const html = renderToStaticMarkup(
      <PullRequestsSuggestionBlock
        suggestion={thread.comments[0]!.suggestion!}
        permission={{ allowed: true, reason: null }}
      />,
    );
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("Applying suggestions arrives in a later build");
  });
});
