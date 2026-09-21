// @vitest-environment happy-dom
import { act } from "react";
import { expect, it } from "vite-plus/test";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { context, detail } from "../detail/testFixtures";
import { PullRequestsPendingReviewBar } from "./PullRequestsPendingReviewBar";
import { button, mount, projectRef } from "./testHelpers";
it("keeps the sticky review counter synchronized with the persisted draft", async () => {
  usePullRequestsStore.setState({ byProjectKey: {} });
  const view = await mount(
    <PullRequestsPendingReviewBar detail={detail} context={context} projectRef={projectRef} />,
  );
  try {
    expect(button("Review · 0 pending comments")).toBeDefined();
    expect(view.container.firstElementChild?.className).toContain("sticky");
    act(() =>
      usePullRequestsStore
        .getState()
        .setPendingReview(projectRef, detail.number, [
          { id: "new", path: "a.ts", line: 1, startLine: null, side: "right", body: "Review me" },
        ]),
    );
    expect(button("Review · 1 pending comments")).toBeDefined();
  } finally {
    await view.unmount();
  }
});
