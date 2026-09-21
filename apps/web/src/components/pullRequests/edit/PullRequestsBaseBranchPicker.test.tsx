// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { detail } from "../detail/testFixtures";
import { allowed, button, click, input, mount, projectRef } from "../review/testHelpers";
const h = vi.hoisted(() => ({
  vocabulary: vi.fn((request: unknown) => request),
  data: {
    kind: "branches",
    truncated: false,
    entries: [{ id: "release", label: "release", color: null, description: null }],
  },
  refresh: vi.fn(),
}));
vi.mock("../../../state/pullRequests", () => ({
  pullRequestsEnvironment: { getVocabulary: h.vocabulary },
}));
vi.mock("../shared/usePullRequestsQuery", () => ({
  usePullRequestsQuery: () => ({ data: h.data, error: null, isPending: false, refresh: h.refresh }),
}));
import { PullRequestsBaseBranchPicker } from "./PullRequestsBaseBranchPicker";
let view: Awaited<ReturnType<typeof mount>>;
const scope = { environmentId: projectRef.environmentId, cwd: "/repo" };
const pendingComment = {
  id: "draft",
  path: "a.ts",
  line: 1,
  startLine: null,
  side: "right" as const,
  body: "Keep until success",
};
const editable = { ...detail, permissions: { ...detail.permissions, editPullRequest: allowed } };
beforeEach(() => {
  vi.clearAllMocks();
  usePullRequestsStore.setState({ byProjectKey: {} });
});
afterEach(async () => {
  await view?.unmount();
});
async function selectRelease() {
  await click("Change base branch");
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("release"),
  );
  expect(option).toBeDefined();
  await act(async () => option!.click());
}
describe("base branch picker", () => {
  it("loads branches only on open and changes base without confirmation when no comments are pending", async () => {
    view = await mount(
      <PullRequestsBaseBranchPicker detail={editable} scope={scope} projectRef={projectRef} />,
    );
    expect(h.vocabulary).not.toHaveBeenCalled();
    await selectRelease();
    expect(h.vocabulary).toHaveBeenCalledWith({
      environmentId: "env",
      input: { cwd: "/repo", kind: "branches", query: null },
    });
    expect(view.run).toHaveBeenCalledWith({
      action: "editPullRequest",
      title: null,
      body: null,
      baseBranch: "release",
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
  it("confirms pending-comment loss, preserves on cancel/failure, and clears only on success", async () => {
    usePullRequestsStore.getState().setPendingReview(projectRef, 14, [pendingComment]);
    view = await mount(
      <PullRequestsBaseBranchPicker detail={editable} scope={scope} projectRef={projectRef} />,
    );
    await selectRelease();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Changing the base clears 1 pending review comment",
    );
    expect(view.run).not.toHaveBeenCalled();
    await click("Cancel");
    expect(usePullRequestsStore.getState().selectDraft(projectRef, 14).pendingReview).toEqual([
      pendingComment,
    ]);
    await selectRelease();
    view.run.mockRejectedValueOnce({ message: "Base changed on host", code: "host_error" });
    await click("Change base");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Base changed on host");
    expect(usePullRequestsStore.getState().selectDraft(projectRef, 14).pendingReview).toEqual([
      pendingComment,
    ]);
    await click("Change base");
    expect(usePullRequestsStore.getState().selectDraft(projectRef, 14).pendingReview).toEqual([]);
  });
  it("filters a complete branch vocabulary without another host read", async () => {
    view = await mount(
      <PullRequestsBaseBranchPicker detail={editable} scope={scope} projectRef={projectRef} />,
    );
    await click("Change base branch");
    await input(document.querySelector<HTMLInputElement>('[role="combobox"]')!, "missing");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(h.vocabulary).toHaveBeenCalledOnce();
  });
  it("keeps a denied base chip disabled with the server reason", async () => {
    view = await mount(
      <PullRequestsBaseBranchPicker detail={detail} scope={scope} projectRef={projectRef} />,
    );
    expect(button("Change base branch").disabled).toBe(true);
    expect(button("Change base branch").title).toBe(detail.permissions.editPullRequest.reason);
    expect(h.vocabulary).not.toHaveBeenCalled();
  });
});
