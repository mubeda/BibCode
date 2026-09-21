// @vitest-environment happy-dom
import { projectRef } from "../review/testHelpers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { PullRequestsSideColumn } from "./PullRequestsSideColumn";
import { context, detail } from "./testFixtures";
import { allowed, button, click, mount } from "../review/testHelpers";
let view: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await view?.unmount();
});
const reviewer = {
  actor: { login: "reviewer-login", name: null, isBot: false },
  state: "approved" as const,
  canRerequest: true,
};
describe("reviewer re-request", () => {
  it("sends the reviewer login through runAction", async () => {
    view = await mount(
      <PullRequestsSideColumn
        scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
        projectRef={projectRef}
        detail={{
          ...detail,
          reviewers: [reviewer],
          permissions: { ...detail.permissions, rerequestReview: allowed },
        }}
        context={context}
      />,
    );
    await click("Re-request review from reviewer-login");
    expect(view.run).toHaveBeenCalledWith({ action: "rerequestReview", login: "reviewer-login" });
  });
  it("respects both canRerequest and the server reason", async () => {
    view = await mount(
      <PullRequestsSideColumn
        scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
        projectRef={projectRef}
        detail={{ ...detail, reviewers: [reviewer] }}
        context={context}
      />,
    );
    expect(button("Re-request review from reviewer-login").disabled).toBe(true);
    expect(button("Re-request review from reviewer-login").title).toBe(
      detail.permissions.rerequestReview.reason,
    );
    await view.render(
      <PullRequestsSideColumn
        scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
        projectRef={projectRef}
        detail={{ ...detail, reviewers: [{ ...reviewer, canRerequest: false }] }}
        context={context}
      />,
    );
    expect(
      view.container.querySelector('button[aria-label="Re-request review from reviewer-login"]'),
    ).toBeNull();
  });
});
