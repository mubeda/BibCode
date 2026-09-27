import { describe, expect, it } from "vite-plus/test";
import { pullRequestsHostAddress } from "./pullRequestsHost.logic";

describe("pullRequestsHostAddress", () => {
  it("takes the host's address from the repository URL the server reported", () => {
    expect(
      pullRequestsHostAddress({
        webUrl: "https://luna.tripunkt.de/group/repo",
        host: "luna.tripunkt.de",
      }),
    ).toBe("https://luna.tripunkt.de");
  });

  it("keeps the scheme and port a self-hosted instance uses", () => {
    expect(
      pullRequestsHostAddress({
        webUrl: "http://git.acme.example:8080/team/repo",
        host: "git.acme.example",
      }),
    ).toBe("http://git.acme.example:8080");
  });

  it("falls back to the bare host when the repository URL does not parse", () => {
    expect(pullRequestsHostAddress({ webUrl: "not a url", host: "git.acme.example" })).toBe(
      "git.acme.example",
    );
  });
});
