import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PullRequestsActor } from "./PullRequestsActor";
describe("PullRequestsActor", () => {
  it("renders local initials and host identity without images", () => {
    const markup = renderToStaticMarkup(
      <PullRequestsActor actor={{ login: "alice", name: "Alice Example", isBot: true }} />,
    );
    expect(markup).toContain("AE");
    expect(markup).toContain("alice");
    expect(markup).toContain("bot");
    expect(markup).not.toContain("<img");
  });
  it("uses a host name only when requested and tolerates missing names", () => {
    expect(
      renderToStaticMarkup(
        <PullRequestsActor actor={{ login: "bob", name: "Robert", isBot: false }} preferName />,
      ),
    ).toContain("Robert");
    expect(
      renderToStaticMarkup(
        <PullRequestsActor actor={{ login: "bob", name: null, isBot: false }} preferName />,
      ),
    ).toContain("bob");
  });
});
