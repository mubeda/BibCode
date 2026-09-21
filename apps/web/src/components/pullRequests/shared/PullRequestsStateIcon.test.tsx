import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PullRequestsStateIcon } from "./PullRequestsStateIcon";
describe("PullRequestsStateIcon", () => {
  it.each([
    ["open", "text-green", "git-pull-request"],
    ["draft", "text-muted", "git-pull-request-draft"],
    ["merged", "text-purple", "git-merge"],
    ["closed", "text-red", "git-pull-request-closed"],
  ] as const)("distinguishes %s with an accessible label", (state, color, icon) => {
    const markup = renderToStaticMarkup(<PullRequestsStateIcon state={state} />);
    expect(markup).toContain(`aria-label="${state}"`);
    expect(markup).toContain(color);
    expect(markup).toContain(icon);
  });
});
