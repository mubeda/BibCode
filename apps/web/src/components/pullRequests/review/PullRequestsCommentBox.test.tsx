// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { PullRequestsCommentBox, PullRequestsConversationComment } from "./PullRequestsCommentBox";
import { allowed, button, click, input, mount, projectRef, mockRun } from "./testHelpers";
let view: Awaited<ReturnType<typeof mount>>;
beforeEach(() => {
  usePullRequestsStore.setState({ byProjectKey: {} });
});
afterEach(async () => {
  await view?.unmount();
});
const draft = () => usePullRequestsStore.getState().selectDraft(projectRef, 14).comment;
const composer = (
  <PullRequestsConversationComment permission={allowed} projectRef={projectRef} number={14} />
);
describe("PullRequestsCommentBox", () => {
  it("persists the draft across unmount and reload", async () => {
    view = await mount(composer);
    await input(view.container.querySelector("textarea")!, "Persist **me**");
    await view.render(null);
    await act(async () => {
      await usePullRequestsStore.persist.rehydrate();
    });
    await view.render(composer);
    expect(view.container.querySelector("textarea")?.value).toBe("Persist **me**");
    await click("Preview");
    expect(view.container.querySelector("strong")?.textContent).toBe("me");
  });
  it("failure keeps text throughout the pending action", async () => {
    let reject!: (reason: unknown) => void;
    const run = mockRun().mockImplementation(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    usePullRequestsStore.getState().setCommentDraft(projectRef, 14, "Keep this draft");
    view = await mount(composer, run);
    await click("Comment");
    expect(draft()).toBe("Keep this draft");
    expect(button("Posting…").disabled).toBe(true);
    await act(async () => reject(new Error("Try again")));
    expect(draft()).toBe("Keep this draft");
    expect(view.container.querySelector("textarea")?.value).toBe("Keep this draft");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
  });
  it("clears only the submitted draft after success and submits on Ctrl/Cmd+Enter", async () => {
    view = await mount(composer);
    await input(view.container.querySelector("textarea")!, "Send me");
    await act(async () =>
      view.container
        .querySelector("textarea")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
        ),
    );
    expect(view.run).toHaveBeenCalledWith({ action: "comment", body: "Send me" });
    expect(draft()).toBe("");
    await input(view.container.querySelector("textarea")!, "Second");
    await act(async () =>
      view.container
        .querySelector("textarea")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
        ),
    );
    expect(view.run).toHaveBeenCalledTimes(2);
  });
  it("does not erase a newer draft entered after navigating away during submission", async () => {
    let resolve!: (value: { kind: "done" }) => void;
    const run = mockRun().mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    usePullRequestsStore.getState().setCommentDraft(projectRef, 14, "Old draft");
    view = await mount(composer, run);
    await click("Comment");
    await view.render(null);
    usePullRequestsStore.getState().setCommentDraft(projectRef, 14, "New draft");
    await act(async () => resolve({ kind: "done" }));
    expect(draft()).toBe("New draft");
  });
  it("shows the permission reason and guards empty submissions", async () => {
    const onSubmit = vi.fn();
    view = await mount(
      <PullRequestsCommentBox
        permission={{ allowed: false, reason: "Conversation is locked" }}
        draft="text"
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(button("Comment").disabled).toBe(true);
    expect(button("Comment").title).toBe("Conversation is locked");
    await view.render(
      <PullRequestsCommentBox
        permission={allowed}
        draft="   "
        onDraftChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(button("Comment").disabled).toBe(true);
    await click("Comment");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
