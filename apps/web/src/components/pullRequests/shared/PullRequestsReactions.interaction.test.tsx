// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PullRequestsReactions } from "./PullRequestsReactions";
import { allowed, button, click, mount } from "../review/testHelpers";
let view: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await view?.unmount();
});
describe("PullRequestsReactions interactions", () => {
  it("toggles an existing reaction and offers all eight contents", async () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    view = await mount(
      <PullRequestsReactions
        reactions={[{ content: "+1", count: 2, viewerReacted: true }]}
        permission={allowed}
        onToggle={onToggle}
      />,
    );
    await click("+1: 2, You reacted");
    expect(onToggle).toHaveBeenLastCalledWith("+1", false);
    for (const content of ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"]) {
      await click("Add reaction");
      await click(`React ${content}`);
      expect(onToggle).toHaveBeenLastCalledWith(content, content !== "+1");
    }
    expect(view.container.querySelector("img")).toBeNull();
  });
  it("renders the server permission reason and does not send denied reactions", async () => {
    const onToggle = vi.fn();
    view = await mount(
      <PullRequestsReactions
        reactions={[]}
        permission={{ allowed: false, reason: "Sign in to react" }}
        onToggle={onToggle}
      />,
    );
    expect(button("Add reaction").disabled).toBe(true);
    expect(button("Add reaction").title).toBe("Sign in to react");
    await click("Add reaction");
    expect(onToggle).not.toHaveBeenCalled();
  });
});
