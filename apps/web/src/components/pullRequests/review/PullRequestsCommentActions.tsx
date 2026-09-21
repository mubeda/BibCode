import type {
  PullRequestsPermissions,
  PullRequestsTimelineItem,
  ScopedProjectRef,
} from "@bibcode/contracts";
import { MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";
import { writeTextToClipboard } from "../../../hooks/useCopyToClipboard";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { Button } from "../../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../../ui/menu";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogFooter,
} from "../../ui/alert-dialog";
import { PullRequestsExternalLink } from "../shared/PullRequestsMarkdown";
import {
  PullRequestsPermissionButton,
  constrainPermission,
} from "../shared/PullRequestsPermissionButton";
import { usePullRequestsActions } from "../usePullRequestsAction";
import { PullRequestsCommentBox } from "./PullRequestsCommentBox";
type Comment =
  | Extract<PullRequestsTimelineItem, { kind: "comment" }>
  | Extract<PullRequestsTimelineItem, { kind: "thread" }>["comments"][number];
export function PullRequestsCommentActions({
  comment,
  permissions,
  projectRef,
  number,
  host,
  url,
}: {
  comment: Comment;
  permissions: PullRequestsPermissions;
  projectRef: ScopedProjectRef;
  number: number;
  host: string;
  url: string;
}) {
  const { run, pending } = usePullRequestsActions();
  const edit = usePullRequestsStore(
    (s) => s.selectDraft(projectRef, number).commentEdits[comment.id],
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const changeEdit = (value: string | null) =>
    usePullRequestsStore.getState().setCommentEdit(projectRef, number, comment.id, value);
  const permission = (key: "editOwnComment" | "deleteOwnComment" | "minimizeComment") =>
    constrainPermission(
      permissions[key],
      pending || deleting ? "Wait for the current action to finish" : null,
    );
  const minimized = comment.minimized;
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Comment actions" />}
          >
            <MoreHorizontalIcon aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            {comment.viewerIsAuthor ? (
              <>
                <MenuItem
                  nativeButton
                  disabled={!permission("editOwnComment").allowed}
                  render={
                    <PullRequestsPermissionButton
                      mutation
                      permission={permission("editOwnComment")}
                      variant="ghost"
                    />
                  }
                  onClick={() => changeEdit(edit ?? comment.body)}
                >
                  Edit
                </MenuItem>
                <MenuItem
                  nativeButton
                  disabled={!permission("deleteOwnComment").allowed}
                  render={
                    <PullRequestsPermissionButton
                      mutation
                      permission={permission("deleteOwnComment")}
                      variant="ghost"
                    />
                  }
                  onClick={() => {
                    setError(null);
                    setConfirmDelete(true);
                  }}
                >
                  Delete
                </MenuItem>
              </>
            ) : null}
            <MenuItem
              nativeButton
              disabled={!permission("minimizeComment").allowed}
              render={
                <PullRequestsPermissionButton
                  mutation
                  permission={permission("minimizeComment")}
                  variant="ghost"
                />
              }
              onClick={() => {
                void run({
                  action: "minimizeComment",
                  commentId: comment.id,
                  minimized: !minimized,
                }).catch(() => undefined);
              }}
            >
              {minimized ? "Unminimize" : "Minimize"}
            </MenuItem>
            <MenuItem
              onClick={() => {
                void writeTextToClipboard(url, "comment link").then(
                  () => setCopied(true),
                  () => setError("Could not copy the link. Use Open on host."),
                );
              }}
            >
              Copy link
            </MenuItem>
            <MenuItem render={<PullRequestsExternalLink href={url} />}>Open on host</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {copied ? (
        <p role="status" className="text-xs">
          Link copied
        </p>
      ) : null}
      {error && !confirmDelete ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {edit !== undefined && comment.viewerIsAuthor ? (
        <div className="space-y-2">
          <PullRequestsCommentBox
            permission={permissions.editOwnComment}
            busy={pending}
            label="Edit comment"
            submitLabel="Save"
            draft={edit}
            onDraftChange={changeEdit}
            onSubmit={async (body) => {
              await run({ action: "editComment", commentId: comment.id, body });
              if (
                usePullRequestsStore.getState().selectDraft(projectRef, number).commentEdits[
                  comment.id
                ] === body
              )
                changeEdit(null);
            }}
          />
          <Button variant="outline" size="sm" disabled={pending} onClick={() => changeEdit(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!deleting) setConfirmDelete(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this comment?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone on {host}.</AlertDialogDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <PullRequestsPermissionButton
              mutation
              permission={permission("deleteOwnComment")}
              variant="destructive"
              onClick={() => {
                if (deleting || pending) return;
                setDeleting(true);
                setError(null);
                void run({ action: "deleteComment", commentId: comment.id })
                  .then(
                    () => {
                      changeEdit(null);
                      setConfirmDelete(false);
                    },
                    (cause) =>
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not delete the comment. Try again.",
                      ),
                  )
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? "Deleting…" : "Delete comment"}
            </PullRequestsPermissionButton>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
