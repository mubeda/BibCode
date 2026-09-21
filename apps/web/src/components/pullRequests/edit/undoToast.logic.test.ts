import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PullRequestsAction } from "../usePullRequestsAction";
import { inverseOf, scheduleUndo } from "./undoToast.logic";

afterEach(() => vi.useRealTimers());
describe("metadata undo", () => {
  it.each(["setLabels", "setReviewers", "setAssignees"] as const)(
    "reverses %s exactly",
    (action) => {
      expect(inverseOf({ action, add: ["a", "b"], remove: ["c"] })).toEqual({
        action,
        add: ["c"],
        remove: ["a", "b"],
      });
    },
  );
  it.each([null, "17"])("restores the previous milestone %s", (milestoneId) => {
    expect(inverseOf({ action: "setMilestone", milestoneId: "23" }, { milestoneId })).toEqual({
      action: "setMilestone",
      milestoneId,
    });
  });
  it("reverses locks preserving the previous reason", () => {
    expect(inverseOf({ action: "lock", reason: "spam" })).toEqual({ action: "unlock" });
    expect(inverseOf({ action: "unlock" }, { lockReason: "spam" })).toEqual({
      action: "lock",
      reason: "spam",
    });
    expect(inverseOf({ action: "unlock" })).toEqual({ action: "lock", reason: null });
  });
  it.each([true, false])("reverses draft %s", (draft) => {
    expect(inverseOf({ action: "setDraft", draft })).toEqual({ action: "setDraft", draft: !draft });
  });
  it.each([
    "editPullRequest",
    "merge",
    "delete",
    "revert",
    "close",
    "reopen",
    "updateBranch",
    "disableAutoMerge",
    "comment",
  ])("does not invent an inverse for %s", (action) => {
    expect(inverseOf({ action } as PullRequestsAction)).toBeNull();
  });
  it("offers five seconds of Undo and runs the inverse exactly once", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue({ kind: "done" });
    const toast = { add: vi.fn().mockReturnValue("toast"), close: vi.fn() };
    const inverse = { action: "setLabels", add: [], remove: ["bug"] } as const;
    scheduleUndo(run, inverse, toast, "Added 1 label");
    expect(run).not.toHaveBeenCalled();
    const options = toast.add.mock.calls[0]![0];
    expect(options).toMatchObject({
      title: "Added 1 label",
      timeout: 5000,
      actionProps: { children: "Undo" },
    });
    await vi.advanceTimersByTimeAsync(4999);
    options.actionProps.onClick();
    options.actionProps.onClick();
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledExactlyOnceWith(inverse, { waitForPending: true });
    expect(toast.close).toHaveBeenCalledWith("toast");
  });
  it("expiry and dismissal never undo or allow a late click", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const toast = { add: vi.fn().mockReturnValue("toast"), close: vi.fn() };
    scheduleUndo(run, { action: "unlock" }, toast, "Locked");
    const options = toast.add.mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    options.actionProps.onClick();
    expect(run).not.toHaveBeenCalled();
    scheduleUndo(run, { action: "unlock" }, toast, "Locked");
    const dismissed = toast.add.mock.calls[1]![0];
    dismissed.onClose();
    dismissed.actionProps.onClick();
    expect(run).not.toHaveBeenCalled();
  });
});
