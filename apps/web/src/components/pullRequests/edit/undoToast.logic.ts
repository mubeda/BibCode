import type { toastManager } from "../../ui/toast";
import type { PullRequestsAction, PullRequestsActionRunner } from "../usePullRequestsAction";

export function inverseOf(
  action: PullRequestsAction,
  previous: { milestoneId?: string | null; lockReason?: string | null } = {},
): PullRequestsAction | null {
  switch (action.action) {
    case "setLabels":
    case "setReviewers":
    case "setAssignees":
      return { action: action.action, add: action.remove, remove: action.add };
    case "setMilestone":
      return { action: "setMilestone", milestoneId: previous.milestoneId ?? null };
    case "lock":
      return { action: "unlock" };
    case "unlock":
      return { action: "lock", reason: previous.lockReason ?? null };
    case "setDraft":
      return { action: "setDraft", draft: !action.draft };
    default:
      return null;
  }
}
export function scheduleUndo(
  run: PullRequestsActionRunner,
  inverse: PullRequestsAction,
  toast: Pick<typeof toastManager, "add" | "close">,
  title: string,
) {
  let active = true;
  const expiresAt = Date.now() + 5000;
  const expire = () => {
    active = false;
  };
  const timer = setTimeout(expire, 5000);
  const id = toast.add({
    title,
    type: "success",
    timeout: 5000,
    onClose: () => {
      expire();
      clearTimeout(timer);
    },
    actionProps: {
      children: "Undo",
      onClick: () => {
        if (!active || Date.now() >= expiresAt) return;
        expire();
        clearTimeout(timer);
        toast.close(id);
        // The shared write path reports failures. Never retry a host mutation automatically.
        void run(inverse, { waitForPending: true }).catch(() => undefined);
      },
    },
  });
}
