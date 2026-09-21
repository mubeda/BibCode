// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { comment, context, permissions } from "../detail/testFixtures";
import { PullRequestsCommentActions } from "./PullRequestsCommentActions";
import { allowed, button, click, input, mount, projectRef, mockRun } from "./testHelpers";
let view: Awaited<ReturnType<typeof mount>>;
const own = { ...comment, id: "ic:17:opaque-node", viewerIsAuthor: true };
const grants = {
  ...permissions,
  editOwnComment: allowed,
  deleteOwnComment: allowed,
  minimizeComment: allowed,
};
const url = "https://github.example/team/repo/pull/14";
const ui = (overrides = {}) => (
  <PullRequestsCommentActions
    comment={own}
    permissions={grants}
    projectRef={projectRef}
    number={14}
    host={context.host}
    url={url}
    {...overrides}
  />
);
beforeEach(() => {
  usePullRequestsStore.setState({ byProjectKey: {} });
});
afterEach(async () => {
  await view?.unmount();
});
describe("PullRequestsCommentActions", () => {
  it("edits own comments with a persisted draft; Save preserves the opaque id and clears after success", async () => {
    view = await mount(ui());
    await click("Comment actions");
    await click("Edit");
    await input(view.container.querySelector("textarea")!, "Updated comment");
    await view.render(null);
    await view.render(ui());
    expect(view.container.querySelector("textarea")?.value).toBe("Updated comment");
    await click("Save");
    expect(view.run).toHaveBeenCalledWith({
      action: "editComment",
      commentId: own.id,
      body: "Updated comment",
    });
    expect(
      usePullRequestsStore.getState().selectDraft(projectRef, 14).commentEdits[own.id],
    ).toBeUndefined();
  });
  it("keeps a failed edit and explicitly discards on Cancel", async () => {
    view = await mount(ui(), mockRun().mockRejectedValue(new Error("Save failed")));
    await click("Comment actions");
    await click("Edit");
    await input(view.container.querySelector("textarea")!, "Keep edit");
    await click("Save");
    expect(view.container.querySelector("textarea")?.value).toBe("Keep edit");
    await click("Cancel");
    expect(
      usePullRequestsStore.getState().selectDraft(projectRef, 14).commentEdits[own.id],
    ).toBeUndefined();
  });
  it("confirms Delete on the host, keeps the dialog on failure, and passes the id verbatim", async () => {
    const run = mockRun().mockRejectedValueOnce(new Error("Delete failed"));
    view = await mount(ui(), run);
    await click("Comment actions");
    await click("Delete");
    expect(run).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      `This cannot be undone on ${context.host}.`,
    );
    await click("Delete comment");
    expect(run).toHaveBeenCalledWith({ action: "deleteComment", commentId: own.id });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await click("Delete comment");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
  it("minimizes/unminimizes and copies the supplied host link without parsing an id", async () => {
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    view = await mount(ui());
    await click("Comment actions");
    await click("Minimize");
    expect(view.run).toHaveBeenLastCalledWith({
      action: "minimizeComment",
      commentId: own.id,
      minimized: true,
    });
    await view.render(ui({ comment: { ...own, minimized: true } }));
    await click("Comment actions");
    await click("Unminimize");
    expect(view.run).toHaveBeenLastCalledWith({
      action: "minimizeComment",
      commentId: own.id,
      minimized: false,
    });
    await click("Comment actions");
    await click("Copy link");
    expect(copy).toHaveBeenCalledWith(url);
    await click("Comment actions");
    expect(document.querySelector(`a[href="${url}"]`)?.textContent).toContain("Open on host");
    copy.mockRestore();
  });
  it("keeps unsupported minimize visible with the host reason; only own comments offer edit/delete", async () => {
    view = await mount(
      ui({
        comment,
        permissions: {
          ...grants,
          minimizeComment: {
            allowed: false,
            reason: "GitLab does not support minimizing comments",
          },
        },
      }),
    );
    await click("Comment actions");
    expect(button("Minimize").getAttribute("aria-disabled")).toBe("true");
    expect(button("Minimize").title).toBe("GitLab does not support minimizing comments");
    await click("Minimize");
    expect(view.run).not.toHaveBeenCalled();
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent === "Edit"),
    ).toBe(false);
  });
});
