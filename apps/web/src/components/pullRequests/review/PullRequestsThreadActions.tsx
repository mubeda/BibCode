import type {
  PullRequestsPermissions,
  PullRequestsTimelineItem,
  ScopedProjectRef,
} from "@bibcode/contracts";
import { useState } from "react";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import {
  PullRequestsPermissionButton,
  constrainPermission,
} from "../shared/PullRequestsPermissionButton";
import { usePullRequestsActions } from "../usePullRequestsAction";
import { PullRequestsCommentBox } from "./PullRequestsCommentBox";
export function PullRequestsThreadActions({
  thread,
  permissions,
  projectRef,
  number,
}: {
  thread: Extract<PullRequestsTimelineItem, { kind: "thread" }>;
  permissions: PullRequestsPermissions;
  projectRef: ScopedProjectRef;
  number: number;
}) {
  const { run, pending } = usePullRequestsActions();
  const draft = usePullRequestsStore(
    (s) => s.selectDraft(projectRef, number).replyDrafts[thread.id] ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const resolvePermission = constrainPermission(
    permissions.resolveThreads,
    !thread.canResolve
      ? "This thread cannot be resolved by your account"
      : pending
        ? "Wait for the current action to finish"
        : null,
  );
  return (
    <div className="space-y-3 p-3">
      <PullRequestsPermissionButton
        mutation
        permission={resolvePermission}
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          void run({
            action: "resolveThread",
            threadId: thread.id,
            resolved: !thread.isResolved,
          }).catch((cause) =>
            setError(
              cause instanceof Error ? cause.message : "Could not update the thread. Try again.",
            ),
          );
        }}
      >
        {thread.isResolved ? "Unresolve thread" : "Resolve thread"}
      </PullRequestsPermissionButton>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <PullRequestsCommentBox
        permission={permissions.comment}
        busy={pending}
        label="Reply to thread"
        submitLabel="Reply"
        draft={draft}
        onDraftChange={(value) =>
          usePullRequestsStore.getState().setReplyDraft(projectRef, number, thread.id, value)
        }
        onSubmit={async (body) => {
          await run({ action: "replyThread", threadId: thread.id, body });
          const store = usePullRequestsStore.getState();
          if (store.selectDraft(projectRef, number).replyDrafts[thread.id] === body)
            store.setReplyDraft(projectRef, number, thread.id, null);
        }}
      />
    </div>
  );
}
