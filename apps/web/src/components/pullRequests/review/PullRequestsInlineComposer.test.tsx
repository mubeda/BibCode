// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { usePullRequestsStore, type PendingInlineComment } from "../../../pullRequestsStore";
import {
  PullRequestsInlineComposer,
  PullRequestsPendingComment,
} from "./PullRequestsInlineComposer";
import { allowed, button, click, input, mount, projectRef, mockRun } from "./testHelpers";
let view: Awaited<ReturnType<typeof mount>>;
const draft: PendingInlineComment = {
  id: "local-id",
  path: "a.ts",
  startLine: 20,
  line: 21,
  side: "right",
  body: "",
};
const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +20,2 @@\n-old\n+new\n context\n";
const ui = (
  <PullRequestsInlineComposer
    projectRef={projectRef}
    number={14}
    draftId={draft.id}
    permission={allowed}
    headSha="loaded-head"
    patch={patch}
  />
);
beforeEach(() => {
  usePullRequestsStore.setState({ byProjectKey: {} });
  usePullRequestsStore.getState().setInlineDraft(projectRef, 14, draft);
});
afterEach(async () => {
  await view?.unmount();
});
describe("PullRequestsInlineComposer", () => {
  it("posts an edited pending card once without leaving its obsolete version queued", async () => {
    const original = { ...draft, body: "Original pending body" };
    usePullRequestsStore.getState().setPendingReview(projectRef, 14, [original]);
    view = await mount(
      ui,
      mockRun().mockResolvedValue({
        kind: "reviewSubmitted",
        reviewPosted: true,
        landed: 1,
        failed: [],
      }),
    );
    await input(view.container.querySelector("textarea")!, "Edited body");
    await click("Add single comment");
    expect(usePullRequestsStore.getState().selectDraft(projectRef, 14).pendingReview).toEqual([]);
  });
  it("inserts a prefilled suggestion and persists the pending card with its range", async () => {
    view = await mount(ui);
    await click("Insert suggestion");
    expect(view.container.querySelector("textarea")?.value).toBe(
      "```suggestion\nnew\ncontext\n```",
    );
    await click("Add review comment");
    const pending = usePullRequestsStore.getState().selectDraft(projectRef, 14).pendingReview;
    expect(pending).toEqual([{ ...draft, body: "```suggestion\nnew\ncontext\n```" }]);
    await act(async () => {
      await usePullRequestsStore.persist.rehydrate();
    });
    await view.render(
      <PullRequestsPendingComment
        comment={pending[0]!}
        projectRef={projectRef}
        number={14}
        permission={allowed}
      />,
    );
    expect(view.container.textContent).toContain("Pending review comment");
    expect(view.container.querySelector("article")?.className).toContain("amber");
    await click("Edit");
    expect(usePullRequestsStore.getState().selectDraft(projectRef, 14).inlineDrafts[0]).toEqual(
      pending[0],
    );
    await click("Remove");
    expect(usePullRequestsStore.getState().selectDraft(projectRef, 14).pendingReview).toEqual([]);
  });
  it("retains an unadded composer across unmount and rehydration", async () => {
    view = await mount(ui);
    await input(view.container.querySelector("textarea")!, "Not added yet");
    await view.render(null);
    await act(async () => {
      await usePullRequestsStore.persist.rehydrate();
    });
    await view.render(ui);
    expect(view.container.querySelector("textarea")?.value).toBe("Not added yet");
  });
  it("adds a single comment immediately with loaded head and no pending siblings", async () => {
    const run = mockRun().mockResolvedValue({
      kind: "reviewSubmitted",
      reviewPosted: true,
      landed: 1,
      failed: [],
    });
    view = await mount(ui, run);
    await input(view.container.querySelector("textarea")!, "Single");
    await click("Add single comment");
    expect(run).toHaveBeenCalledWith({
      action: "submitReview",
      event: "comment",
      body: null,
      headSha: "loaded-head",
      comments: [{ path: "a.ts", startLine: 20, line: 21, side: "right", body: "Single" }],
    });
    expect(usePullRequestsStore.getState().selectDraft(projectRef, 14).inlineDrafts).toEqual([]);
  });
  it.each(["stale_head", "partial"])("keeps the composer on %s failure", async (kind) => {
    const run = mockRun();
    if (kind === "partial")
      run.mockResolvedValue({
        kind: "reviewSubmitted",
        reviewPosted: true,
        landed: 0,
        failed: [{ path: "a.ts", line: 21, body: "Keep inline", message: "Position invalid" }],
      });
    else run.mockRejectedValue(new Error("stale_head"));
    view = await mount(ui, run);
    await input(view.container.querySelector("textarea")!, "Keep inline");
    await click("Add single comment");
    expect(view.container.querySelector("textarea")?.value).toBe("Keep inline");
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("shows a permission reason for review actions", async () => {
    view = await mount(
      <PullRequestsInlineComposer
        projectRef={projectRef}
        number={14}
        draftId={draft.id}
        permission={{ allowed: false, reason: "Reviewing is unavailable" }}
        headSha="head"
        patch={patch}
      />,
    );
    expect(button("Add review comment").disabled).toBe(true);
    expect(button("Add single comment").title).toBe("Reviewing is unavailable");
  });
});
