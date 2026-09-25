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
import { PermissionButton } from "~/components/ui/permission-button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  formatChangeRequestNumber,
  getChangeRequestTerminology,
  resolveChangeRequestPresentation,
} from "@bibcode/shared/sourceControl";
import { capitalize } from "effect/String";
import { randomUUID } from "~/lib/utils";
import { gitManagerEnvironment } from "~/state/gitManager";
import { useEnvironmentQuery } from "~/state/query";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { vcsEnvironment } from "~/state/vcs";

import {
  createPullRequestAction,
  failCreatePullRequestProgress,
  hintedProvider,
  presentCreatePullRequestProgress,
  reduceCreatePullRequestProgress,
  resolveCreatePullRequestReview,
  REVIEW_PROGRESS,
  type CreatePullRequestProgress,
  type CreatePullRequestProviderHint,
} from "./GitManagerPullRequestPanel.logic";

function safeExternalUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function failureMessage(error: unknown, noun: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : `The ${noun} could not be created.`;
}

export interface GitManagerCreatePullRequestDialogProps {
  readonly open: boolean;
  readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  readonly onOpenChange: (open: boolean) => void;
  /** Called once a pull request was created or found so the pane can refresh. */
  readonly onSettled: () => void;
  /**
   * A host the caller already identified (the Pull Requests panel). It stands in for a
   * status that has not named the host yet; the server validates it when creating.
   */
  readonly providerHint?: CreatePullRequestProviderHint | null;
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
  providerHint = null,
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
    () =>
      status === null
        ? null
        : resolveCreatePullRequestReview({ status, latestCommit, providerHint }),
    [latestCommit, providerHint, status],
  );
  const provider = review === null ? hintedProvider(providerHint) : review.provider;
  const noun = getChangeRequestTerminology(provider).singular;
  const waitReason = `Wait for the ${noun} to finish.`;

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [progress, setProgress] = useState<CreatePullRequestProgress>(REVIEW_PROGRESS);
  const seededDefaultsRef = useRef<string | null>(null);
  const running = progress.kind === "running";

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
          provider: review.provider,
        });
  const busy = presentation?.busy === true;
  const settled = presentation?.settled === true;
  const trimmedTitle = title.trim();
  const primaryDisabledReason =
    review === null
      ? "Reading repository status…"
      : busy
        ? waitReason
        : settled
          ? null
          : (review.blockedReason ??
            (review.existingPullRequest !== null
              ? `A ${noun} already exists for this branch.`
              : trimmedTitle.length === 0
                ? `Enter a title for the ${noun}.`
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
    setProgress((current) => failCreatePullRequestProgress(current, failureMessage(failure, noun)));
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
    noun,
  ]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && running) return;
      onOpenChange(nextOpen);
    },
    [onOpenChange, running],
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
      <DialogPopup
        aria-busy={busy ? "true" : "false"}
        className="max-w-xl"
        data-testid="git-manager-create-pr-dialog"
      >
        <DialogHeader className="pb-4">
          <DialogTitle>Create {noun}</DialogTitle>
          <DialogDescription>Review the {noun} before anything is published.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <section
            aria-label={`${capitalize(noun)} details`}
            className="rounded-xl border border-border/70 bg-muted/24 px-4"
            data-testid="create-pr-summary"
          >
            <dl className="divide-y divide-border/70 text-sm">
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-4 py-2.5">
                <dt className="whitespace-nowrap text-muted-foreground">Repository</dt>
                <dd className="min-w-0 break-all text-right" data-testid="create-pr-repository">
                  {provider !== null
                    ? `${resolveChangeRequestPresentation(provider).providerName} · ${provider.baseUrl}`
                    : review === null
                      ? "…"
                      : status?.hasPrimaryRemote === false
                        ? "No origin remote"
                        : "Not identified yet"}
                </dd>
              </div>
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-4 py-2.5">
                <dt className="whitespace-nowrap text-muted-foreground">Base branch</dt>
                <dd
                  className="min-w-0 justify-self-end break-all rounded-md bg-background px-2 py-1 font-mono text-xs"
                  data-testid="create-pr-base"
                >
                  {review?.base ?? "…"}
                </dd>
              </div>
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-4 py-2.5">
                <dt className="whitespace-nowrap text-muted-foreground">Head branch</dt>
                <dd
                  className="min-w-0 justify-self-end break-all rounded-md bg-background px-2 py-1 text-right font-mono text-xs"
                  data-testid="create-pr-head"
                >
                  {review?.head ?? "No branch checked out"}
                </dd>
              </div>
            </dl>
          </section>
          <div
            className="rounded-lg border border-border/70 px-3 py-2.5 text-xs"
            data-testid="create-pr-publish"
          >
            <p className="font-medium text-foreground">Branch publication</p>
            <p className="mt-1 text-muted-foreground">
              {review === null
                ? "Reading branch status…"
                : review.publishRequired
                  ? `${review.head ?? "The branch"} is not on the remote yet and will be published first.`
                  : "The branch is already published."}
            </p>
          </div>
          {review?.existingPullRequest === null ||
          review?.existingPullRequest === undefined ? null : (
            <p
              className="rounded-lg border border-border/70 px-3 py-2.5 text-xs"
              data-testid="create-pr-existing"
            >
              {capitalize(noun)}{" "}
              {formatChangeRequestNumber(provider?.kind ?? null, review.existingPullRequest.number)}{" "}
              already exists for this branch:{" "}
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
          <section aria-label={`${capitalize(noun)} content`} className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="git-manager-create-pr-title">Title</Label>
              <Input
                aria-invalid={trimmedTitle.length === 0 && review !== null ? "true" : undefined}
                disabled={fieldsDisabled}
                id="git-manager-create-pr-title"
                value={title}
                onChange={changeTitle}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="git-manager-create-pr-body">Description</Label>
              <Textarea
                disabled={fieldsDisabled}
                id="git-manager-create-pr-body"
                rows={4}
                value={body}
                onChange={changeBody}
              />
            </div>
          </section>
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
                    Open {noun}
                  </a>
                </>
              ) : null}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={busy}
            title={busy ? waitReason : undefined}
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            {settled ? "Close" : "Cancel"}
          </Button>
          <PermissionButton
            permission={{ allowed: primaryDisabledReason === null, reason: primaryDisabledReason }}
            onClick={() => {
              void submit();
            }}
          >
            <GitPullRequestIcon aria-hidden="true" />
            {presentation?.primaryLabel ?? `Create ${noun}`}
          </PermissionButton>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
