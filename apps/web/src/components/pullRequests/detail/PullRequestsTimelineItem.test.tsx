import { PullRequestsActionsContext } from "../usePullRequestsAction";
// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderReviewMarkup as renderToStaticMarkup, mount, click } from "../review/testHelpers";
import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    search,
    hash,
    children,
  }: {
    search: { tab: string };
    hash: string;
    children: ReactNode;
  }) => <a href={`?tab=${search.tab}#${hash}`}>{children}</a>,
}));
import { PullRequestsTimelineItem } from "./PullRequestsTimelineItem";
import { comment, context, detail, event, review, thread } from "./testFixtures";
const projectRef = { environmentId: "env", projectId: "project" } as never;
const props = {
  url: "https://github.example/repo/pull/14",
  projectRef,
  number: 14,
  permissions: detail.permissions,
  context,
};
describe("PullRequestsTimelineItem", () => {
  it("collapses a minimized thread comment and offers Unminimize using its authoritative state", async () => {
    const item = { ...thread, comments: [{ ...thread.comments[0]!, minimized: true }] };
    const view = await mount(
      <PullRequestsTimelineItem
        {...props}
        permissions={{ ...props.permissions, minimizeComment: { allowed: true, reason: null } }}
        item={item}
      />,
    );
    try {
      expect(view.container.textContent).not.toContain("Thread comment");
      await click("Comment actions");
      await click("Unminimize");
      expect(view.run).toHaveBeenCalledWith({
        action: "minimizeComment",
        commentId: item.comments[0]!.id,
        minimized: false,
      });
      await click("Show comment");
      expect(view.container.textContent).toContain("Thread comment");
    } finally {
      await view.unmount();
    }
  });
  it("uses a safe fallback for an unknown event matching an object property", () => {
    const html = renderToStaticMarkup(
      <PullRequestsTimelineItem
        {...props}
        item={{ ...event, event: "constructor", detail: null }}
      />,
    );
    expect(html).toContain("updated the request");
  });
  it.each([
    ["review_requested", "alice", "requested review from alice"],
    ["ready_for_review", null, "marked ready for review"],
    ["converted_to_draft", null, "converted to draft"],
    ["head_ref_force_pushed", null, "force-pushed the head branch"],
    ["commits_added", "added 2 commits", "added 2 commits"],
    ["unknown", "Host activity", "updated the request: Host activity"],
  ] as const)("presents %s as readable activity", (kind, value, expected) => {
    const html = renderToStaticMarkup(
      <PullRequestsTimelineItem {...props} item={{ ...event, event: kind, detail: value }} />,
    );
    expect(html).toContain(expected);
    expect(html).not.toContain(`>${kind}<`);
  });
  it.each([
    [comment, "A comment"],
    [review, "approved these changes"],
    [thread, "Thread comment"],
    [event, "labeled"],
  ] as const)("renders $0.kind", (item, text) => {
    const html = renderToStaticMarkup(<PullRequestsTimelineItem {...props} item={item} />);
    expect(html).toContain(text);
    expect(html).toContain("mubeda");
    expect(html).not.toContain("<img");
  });
  it("shows edited comments and read-only reactions", () => {
    const html = renderToStaticMarkup(<PullRequestsTimelineItem {...props} item={comment} />);
    expect(html).toContain("edited");
    expect(html).toContain("👍");
  });
  it("links a thread to the files tab with an encoded path and renders hunk, badges and suggestion", () => {
    const html = renderToStaticMarkup(<PullRequestsTimelineItem {...props} item={thread} />);
    expect(html).toContain("?tab=files#file=src%2Fa%20b%23%C3%A9.ts");
    expect(html).toContain("@@ -3 +3 @@");
    expect(html).toContain("Resolved");
    expect(html).toContain("Outdated");
    expect(html).toContain("Lines 3–4");
  });
  it("keeps a minimized comment collapsed until Show comment", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PullRequestsActionsContext value={{ run: vi.fn(), pending: false, error: null }}>
            <PullRequestsTimelineItem {...props} item={{ ...comment, minimized: true }} />
          </PullRequestsActionsContext>,
        ),
      );
      expect(container.textContent).not.toContain("A comment");
      expect(container.textContent).toContain("Show comment");
      await act(async () => container.querySelector("button")!.click());
      expect(container.textContent).toContain("A comment");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
