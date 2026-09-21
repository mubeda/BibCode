// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { permissions, thread } from "../detail/testFixtures";
import { PullRequestsThreadActions } from "./PullRequestsThreadActions";
import { allowed, button, click, input, mount, projectRef, mockRun } from "./testHelpers";
let view: Awaited<ReturnType<typeof mount>>;
const grants = { ...permissions, comment: allowed, resolveThreads: allowed };
const ui = (overrides = {}) => (
  <PullRequestsThreadActions
    thread={{ ...thread, id: "ds:opaque-17", canResolve: true }}
    permissions={grants}
    projectRef={projectRef}
    number={14}
    {...overrides}
  />
);
beforeEach(() => usePullRequestsStore.setState({ byProjectKey: {} }));
afterEach(async () => {
  await view?.unmount();
});
describe("PullRequestsThreadActions", () => {
  it("persists replies through unmount/reload and clears only after success with the opaque thread id", async () => {
    view = await mount(ui());
    await input(view.container.querySelector("textarea")!, "Thread reply");
    await view.render(null);
    await act(async () => {
      await usePullRequestsStore.persist.rehydrate();
    });
    await view.render(ui());
    expect(view.container.querySelector("textarea")?.value).toBe("Thread reply");
    await click("Reply");
    expect(view.run).toHaveBeenCalledWith({
      action: "replyThread",
      threadId: "ds:opaque-17",
      body: "Thread reply",
    });
    expect(
      usePullRequestsStore.getState().selectDraft(projectRef, 14).replyDrafts["ds:opaque-17"],
    ).toBeUndefined();
  });
  it("keeps a reply draft on failure", async () => {
    view = await mount(ui(), mockRun().mockRejectedValue(new Error("Reply failed")));
    await input(view.container.querySelector("textarea")!, "Keep reply");
    await click("Reply");
    expect(view.container.querySelector("textarea")?.value).toBe("Keep reply");
    expect(
      usePullRequestsStore.getState().selectDraft(projectRef, 14).replyDrafts["ds:opaque-17"],
    ).toBe("Keep reply");
  });
  it.each([true, false])("toggles resolved=%s without optimistic changes", async (isResolved) => {
    view = await mount(ui({ thread: { ...thread, canResolve: true, isResolved } }));
    await click(isResolved ? "Unresolve thread" : "Resolve thread");
    expect(view.run).toHaveBeenCalledWith({
      action: "resolveThread",
      threadId: thread.id,
      resolved: !isResolved,
    });
    expect(button(isResolved ? "Unresolve thread" : "Resolve thread")).toBeDefined();
  });
  it("honors both the server permission and the per-thread canResolve flag", async () => {
    view = await mount(
      ui({
        permissions: {
          ...grants,
          resolveThreads: { allowed: false, reason: "Host refuses resolution" },
        },
      }),
    );
    expect(button("Unresolve thread").title).toBe("Host refuses resolution");
    await view.render(ui({ thread: { ...thread, canResolve: false } }));
    expect(button("Unresolve thread").disabled).toBe(true);
    await click("Unresolve thread");
    expect(view.run).not.toHaveBeenCalled();
  });
});
