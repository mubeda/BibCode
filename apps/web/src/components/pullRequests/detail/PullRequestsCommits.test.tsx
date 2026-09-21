// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({
  copy: vi.fn().mockResolvedValue(true),
  open: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: h.copy }));
vi.mock("../../../localApi", () => ({ readLocalApi: () => ({ shell: { openExternal: h.open } }) }));
import { PullRequestsCommits } from "./PullRequestsCommits";
import { detail } from "./testFixtures";
describe("PullRequestsCommits", () => {
  it("shows identity, short sha, subject, date and copies the full sha and opens the commit URL", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const commit = {
      sha: "1234567890abcdef",
      shortSha: "1234567",
      subject: "Fix the tests",
      body: null,
      author: detail.author,
      authoredAt: detail.createdAt,
      url: "https://example.com/commit/123",
    };
    try {
      await act(async () => root.render(<PullRequestsCommits commits={{ commits: [commit] }} />));
      for (const text of ["1234567", "Fix the tests", "mubeda"])
        expect(container.textContent).toContain(text);
      expect(container.querySelector("time")?.dateTime).toBe(commit.authoredAt);
      expect(container.querySelector("img")).toBeNull();
      await act(async () => container.querySelector("button")!.click());
      expect(h.copy).toHaveBeenCalledWith(commit.sha, "commit SHA");
      await act(async () => container.querySelector("a")!.click());
      expect(h.open).toHaveBeenCalledWith(commit.url);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
