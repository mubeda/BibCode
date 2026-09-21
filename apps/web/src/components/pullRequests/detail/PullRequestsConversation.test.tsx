// @vitest-environment happy-dom
import {
  renderReviewMarkup as renderToStaticMarkup,
  mount,
  click,
  projectRef,
  allowed,
} from "../review/testHelpers";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
const h = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: readonly unknown[];
    keyExtractor: (item: unknown) => string;
    renderItem: (p: { item: unknown }) => ReactNode;
    ListHeaderComponent: ReactNode;
    ListFooterComponent: ReactNode;
  }) => {
    h.props = props;
    return (
      <div>
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  },
}));
import { PullRequestsConversation } from "./PullRequestsConversation";
import { comment, context, detail } from "./testFixtures";
describe("PullRequestsConversation", () => {
  it("renders the conversation and review menus without console errors", async () => {
    usePullRequestsStore.setState({ byProjectKey: {} });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let view: Awaited<ReturnType<typeof mount>> | undefined;
    try {
      view = await mount(
        <PullRequestsConversation
          scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
          detail={{
            ...detail,
            reactions: comment.reactions,
            permissions: {
              ...detail.permissions,
              react: allowed,
              editOwnComment: allowed,
              deleteOwnComment: allowed,
              minimizeComment: allowed,
            },
          }}
          context={context}
          projectRef={projectRef}
          timeline={{ items: [{ ...comment, viewerIsAuthor: true }], truncated: false }}
        />,
      );
      expect(consoleError).not.toHaveBeenCalled();
      await click("Add reaction");
      expect(consoleError).not.toHaveBeenCalled();
      await click("React heart");
      await click("Comment actions");
      expect(consoleError).not.toHaveBeenCalled();
      await click("Edit", document.querySelector('[role="menu"]')!);
      expect(
        view.container.querySelector('section[aria-label="Edit comment"] textarea'),
      ).not.toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
      await click("Cancel");
      await click("Review · 0 pending comments");
      expect(consoleError).not.toHaveBeenCalled();
      await click("Close review");
      await view.unmount();
      view = undefined;
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await view?.unmount();
      consoleError.mockRestore();
    }
  });
  it("virtualizes timeline and renders description, truncated note, and a reasoned disabled comment box", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <PullRequestsConversation
        scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
        detail={detail}
        context={context}
        projectRef={{ environmentId: "env", projectId: "project" } as never}
        timeline={{ items: [comment], truncated: true }}
      />,
    );
    expect(container.textContent).toContain("description");
    expect(container.textContent).toContain("A comment");
    expect(h.props?.data).toEqual([comment]);
    expect(h.props?.estimatedItemSize).toBeGreaterThan(0);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.disabled).toBe(true);
    expect(textarea.title).toBe(detail.permissions.comment.reason);
    expect(
      container.querySelector(`[id="${textarea.getAttribute("aria-describedby")}"]`)?.textContent,
    ).toBe(detail.permissions.comment.reason);
    expect(container.textContent).toContain("Older activity is on the host page");
    expect(container.querySelector(`a[href="${detail.url}"]`)).not.toBeNull();
  });
});
