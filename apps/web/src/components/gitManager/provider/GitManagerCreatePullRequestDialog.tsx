import type {
  EnvironmentId,
  GitActionProgressEvent,
  GitManagerCommitEntry,
  VcsStatusResult,
} from "@bibcode/contracts";
import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { GitPullRequestIcon } from "lucide-react";
import { memo, type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { randomUUID } from "~/lib/utils";
import { gitManagerEnvironment } from "~/state/gitManager";
import { useEnvironmentQuery } from "~/state/query";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { vcsEnvironment } from "~/state/vcs";

import {
  createPullRequestAction,
  failCreatePullRequestProgress,
  presentCreatePullRequestProgress,
  reduceCreatePullRequestProgress,
  resolveCreatePullRequestReview,
  REVIEW_PROGRESS,
  type CreatePullRequestProgress,
} from "./GitManagerPullRequestPanel.logic";

const WAIT_REASON = "Wait for the pull request to finish.";

function safeExternalUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The pull request could not be created.";
}

export interface GitManagerCreatePullRequestDialogProps {
  readonly open: boolean;
  readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  readonly onOpenChange: (open: boolean) => void;
  /** Called once a pull request was created or found so the pane can refresh. */
  readonly onSettled: () => void;
}

/**
 * The review surface in front of `create_pr`. Opening it reads local status
 * only; nothing is published or created until the primary action is chosen.
 */
export const GitManagerCreatePullRequestDialog = memo(function GitManagerCreatePullRequestDialog({
  open,
  scope,
  onOpenChange,
  onSettled,
}: GitManagerCreatePullRequestDialogProps) {
  const { environmentId, cwd } = scope;
  const statusAtom = useMemo(
    () => (open ? vcsEnvironment.status({ environmentId, input: { cwd } }) : null),
    [cwd, environmentId, open],
  );
  const latestCommitAtom = useMemo(
    () =>
      open
        ? gitManagerEnvironment.getCommits({ environmentId, input: { cwd, offset: 0, limit: 1 } })
        : null,
    [cwd, environmentId, open],
  );
  const statusQuery = useEnvironmentQuery(statusAtom);
  const latestCommitQuery = useEnvironmentQuery(latestCommitAtom);
  const status: VcsStatusResult | null = statusQuery.data ?? null;
  const latestCommit: GitManagerCommitEntry | null = latestCommitQuery.data?.commits[0] ?? null;
  const review = useMemo(
    () => (status === null ? null : resolveCreatePullRequestReview({ status, latestCommit })),
    [latestCommit, status],
  );

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [progress, setProgress] = useState<CreatePullRequestProgress>(REVIEW_PROGRESS);
  const seededDefaultsRef = useRef<string | null>(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  // Seed the editable fields from the latest commit once per opened review, and
  // start every review from a clean slate when the dialog closes.
  useEffect(() => {
    if (!open) {
      seededDefaultsRef.current = null;
      setTitle("");
      setBody("");
      setProgress(REVIEW_PROGRESS);
      return;
    }
    if (review === null || seededDefaultsRef.current !== null) return;
    seededDefaultsRef.current = latestCommit?.sha ?? "";
    setTitle(review.defaultTitle);
    setBody(review.defaultBody);
  }, [latestCommit?.sha, open, review]);

  const stackedAction = useGitStackedAction(scope);
  const runStackedAction = stackedAction.run;
  const presentation =
    review === null
      ? null
      : presentCreatePullRequestProgress(progress, {
          publishRequired: review.publishRequired,
          head: review.head,
        });
  const busy = presentation?.busy === true;
  const settled = presentation?.settled === true;
  const trimmedTitle = title.trim();
  const primaryDisabledReason =
    review === null
      ? "Reading repository status…"
      : busy
        ? WAIT_REASON
        : settled
          ? null
          : (review.blockedReason ??
            (review.existingPullRequest !== null
              ? "A pull request already exists for this branch."
              : trimmedTitle.length === 0
                ? "Enter a title for the pull request."
                : null));

  const onProgress = useCallback((event: GitActionProgressEvent) => {
    setProgress((current) => reduceCreatePullRequestProgress(current, event));
  }, []);

  const submit = useCallback(async () => {
    if (settled) {
      onOpenChange(false);
      return;
    }
    if (primaryDisabledReason !== null) return;
    setProgress({ kind: "running", phase: null, pushed: false });
    const result = await runStackedAction({
      ...createPullRequestAction(randomUUID(), { title: trimmedTitle, body }),
      onProgress,
    });
    if (AsyncResult.isSuccess(result)) {
      setProgress((current) =>
        current.kind === "created" || current.kind === "existing"
          ? current
          : reduceCreatePullRequestProgress(current, {
              actionId: "settled",
              cwd,
              action: "create_pr",
              kind: "action_finished",
              result: result.value,
            }),
      );
      onSettled();
      return;
    }
    const failure = squashAtomCommandFailure(result);
    setProgress((current) => failCreatePullRequestProgress(current, failureMessage(failure)));
  }, [
    body,
    cwd,
    onOpenChange,
    onProgress,
    onSettled,
    primaryDisabledReason,
    runStackedAction,
    settled,
    trimmedTitle,
  ]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && progressRef.current.kind === "running") return;
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );
  const changeTitle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value),
    [],
  );
  const changeBody = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setBody(event.target.value),
    [],
  );

  const outcomeUrl =
    progress.kind === "created" || progress.kind === "existing"
      ? safeExternalUrl(progress.url)
      : review?.existingPullRequest === null
        ? null
        : safeExternalUrl(review?.existingPullRequest?.url ?? null);
  const fieldsDisabled = busy || settled || review?.blockedReason !== null;
  const statusText =
    presentation?.status ?? (review === null ? "Reading repository status…" : null);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup aria-busy={busy ? "true" : "false"} data-testid="git-manager-create-pr-dialog">
        <DialogHeader>
          <DialogTitle>Create pull request</DialogTitle>
          <DialogDescription>
            Review the pull request before anything is published.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Repository</dt>
          <dd className="truncate" data-testid="create-pr-repository">
            {review?.provider === null || review?.provider === undefined
              ? "Not detected"
              : `${review.provider.name} · ${review.provider.baseUrl}`}
          </dd>
          <dt className="text-muted-foreground">Base</dt>
          <dd className="truncate font-mono" data-testid="create-pr-base">
            {review?.base ?? "…"}
          </dd>
          <dt className="text-muted-foreground">Head</dt>
          <dd className="truncate font-mono" data-testid="create-pr-head">
            {review?.head ?? "No branch checked out"}
          </dd>
          <dt className="text-muted-foreground">Publish</dt>
          <dd data-testid="create-pr-publish">
            {review === null
              ? "…"
              : review.publishRequired
                ? `${review.head ?? "The branch"} is not on the remote yet and will be published first.`
                : "The branch is already published."}
          </dd>
        </dl>
        {review?.existingPullRequest === null ||
        review?.existingPullRequest === undefined ? null : (
          <p className="text-xs" data-testid="create-pr-existing">
            Pull request #{review.existingPullRequest.number} already exists for this branch:{" "}
            {outcomeUrl === null ? (
              review.existingPullRequest.title
            ) : (
              <a
                className="underline-offset-2 hover:underline"
                href={outcomeUrl}
                rel="noreferrer"
                target="_blank"
              >
                {review.existingPullRequest.title}
              </a>
            )}
          </p>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="git-manager-create-pr-title">Title</Label>
          <Input
            aria-invalid={trimmedTitle.length === 0 && review !== null ? "true" : undefined}
            disabled={fieldsDisabled}
            id="git-manager-create-pr-title"
            value={title}
            onChange={changeTitle}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="git-manager-create-pr-body">Description</Label>
          <Textarea
            disabled={fieldsDisabled}
            id="git-manager-create-pr-body"
            rows={5}
            value={body}
            onChange={changeBody}
          />
        </div>
        {statusText === null && review?.blockedReason === null ? null : (
          <p
            aria-live="polite"
            className={
              presentation?.tone === "error"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
            data-testid="create-pr-status"
            role="status"
          >
            {statusText ?? review?.blockedReason}
            {outcomeUrl !== null && settled ? (
              <>
                {" "}
                <a
                  className="underline-offset-2 hover:underline"
                  href={outcomeUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open pull request
                </a>
              </>
            ) : null}
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={busy}
            title={busy ? WAIT_REASON : undefined}
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            {settled ? "Close" : "Cancel"}
          </Button>
          <Button
            disabled={primaryDisabledReason !== null}
            title={primaryDisabledReason ?? undefined}
            onClick={() => {
              void submit();
            }}
          >
            <GitPullRequestIcon aria-hidden="true" />
            {presentation?.primaryLabel ?? "Create pull request"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
