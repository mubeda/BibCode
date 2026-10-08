// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { allowed, button, click, mockRun, mount, projectRef } from "../review/testHelpers";
import { context } from "../testFixtures";
import { detail, gitlabContext } from "./testFixtures";
import { PullRequestsApproveBar } from "./PullRequestsApproveBar";

const h = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../ui/toast", () => ({ toastManager: { add: h.toast } }));

const optional = {
  ...detail,
  permissions: { ...detail.permissions, approve: allowed },
  readiness: { ...detail.readiness, requiredApprovals: { approved: 0, required: 0 } },
};
let view: Awaited<ReturnType<typeof mount>> | undefined;

beforeEach(() => {
  usePullRequestsStore.setState({ byProjectKey: {} });
  h.toast.mockClear();
});
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

describe("PullRequestsApproveBar", () => {
  it("approves the live head without posting the pending review draft", async () => {
    usePullRequestsStore.getState().setPendingReview(projectRef, detail.number, [
      {
        id: "draft",
        path: "a.ts",
        line: 4,
        startLine: null,
        side: "right",
        body: "Pending",
      },
    ]);
    const run = mockRun().mockResolvedValue({
      kind: "reviewSubmitted",
      reviewPosted: true,
      landed: 0,
      failed: [],
    });
    view = await mount(
      <PullRequestsApproveBar
        detail={optional}
        live={{ ...optional, headSha: "live-sha" }}
        context={gitlabContext}
      />,
      run,
    );
    expect(document.body.textContent).toContain("Approval is optional");
    await click("Approve");
    expect(run).toHaveBeenCalledWith({
      action: "submitReview",
      event: "approve",
      body: null,
      headSha: "live-sha",
      comments: [],
    });
    expect(
      usePullRequestsStore.getState().selectDraft(projectRef, detail.number).pendingReview,
    ).toHaveLength(1);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Approved" }));
  });

  it("stays inactive with Loading… while only a snapshot would allow approval", async () => {
    view = await mount(
      <PullRequestsApproveBar detail={optional} live={null} context={gitlabContext} />,
    );
    const approve = button("Approve");
    expect(approve.disabled).toBe(true);
    expect(approve.title).toBe("Loading…");
    await click("Approve").catch(() => undefined);
    expect(view.run).not.toHaveBeenCalled();
  });

  it("revokes an existing approval from the same control", async () => {
    const run = mockRun().mockResolvedValue({ kind: "done" });
    view = await mount(
      <PullRequestsApproveBar
        detail={optional}
        live={{
          ...optional,
          permissions: { ...optional.permissions, revokeApproval: allowed },
        }}
        context={gitlabContext}
      />,
      run,
    );
    await click("Revoke approval");
    expect(run).toHaveBeenCalledWith({ action: "revokeApproval" });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Approval revoked" }));
  });

  it("keeps a denied Approve visible with the server reason", async () => {
    view = await mount(
      <PullRequestsApproveBar detail={detail} live={detail} context={gitlabContext} />,
    );
    const approve = button("Approve");
    expect(approve.disabled).toBe(true);
    expect(approve.title).toBe(detail.permissions.approve.reason);
    expect(document.body.textContent).toContain("0 of 1 approvals");
  });

  it("is absent for GitHub and for a closed GitLab request", async () => {
    view = await mount(<PullRequestsApproveBar detail={detail} context={context} />);
    expect(document.querySelector('[aria-label="Approval"]')).toBeNull();
    await view.render(
      <PullRequestsApproveBar detail={{ ...detail, state: "closed" }} context={gitlabContext} />,
    );
    expect(document.querySelector('[aria-label="Approval"]')).toBeNull();
  });
});
