import type {
  EnvironmentId,
  GitManagerCheckEntry,
  GitManagerPullRequestEntry,
  GitManagerPullRequestsResult,
} from "@bibcode/contracts";
import { CheckCircle2Icon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { randomUUID } from "../../../lib/utils";
import { gitManagerEnvironment } from "../../../state/gitManager";
import { useEnvironmentQuery } from "../../../state/query";
import { useGitStackedAction } from "../../../state/sourceControlActions";
import { Button } from "../../ui/button";
import {
  createPullRequestAction,
  resolveProviderPanePresentation,
} from "./GitManagerPullRequestPanel.logic";

const EMPTY_PULL_REQUESTS: ReadonlyArray<GitManagerPullRequestEntry> = Object.freeze([]);
const EMPTY_CHECKS: ReadonlyArray<GitManagerCheckEntry> = Object.freeze([]);

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

interface PullRequestRowProps {
  readonly pullRequest: GitManagerPullRequestEntry;
}

const PullRequestRow = memo(function PullRequestRow({ pullRequest }: PullRequestRowProps) {
  const url = safeExternalUrl(pullRequest.url);
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex min-w-0 items-start gap-2">
        <GitPullRequestIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          {url === null ? (
            <span className="block truncate text-sm font-medium">{pullRequest.title}</span>
          ) : (
            <a
              className="block truncate text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              href={url}
              rel="noreferrer"
              target="_blank"
            >
              {pullRequest.title}
            </a>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            #{pullRequest.number} · {pullRequest.headBranch} → {pullRequest.baseBranch} ·{` `}
            {pullRequest.state}
          </p>
        </div>
      </div>
    </li>
  );
});

interface CheckRowProps {
  readonly check: GitManagerCheckEntry;
}

const CheckRow = memo(function CheckRow({ check }: CheckRowProps) {
  const url = check.link === null ? null : safeExternalUrl(check.link);
  const content = (
    <>
      <CheckCircle2Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{check.name}</span>
      {check.workflow === null ? null : (
        <span className="truncate text-muted-foreground">{check.workflow}</span>
      )}
      <span className="font-mono text-[10px]">{check.state}</span>
    </>
  );
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md border border-border px-2.5 py-2 text-xs">
      {url === null ? (
        content
      ) : (
        <a
          className="flex min-w-0 flex-1 items-center gap-2 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          href={url}
          rel="noreferrer"
          target="_blank"
        >
          {content}
        </a>
      )}
    </li>
  );
});

export interface GitManagerPullRequestPanelProps {
  readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  readonly disabledReason?: string | null;
  readonly onRefresh: () => void;
}

export const GitManagerPullRequestPanel = memo(function GitManagerPullRequestPanel({
  scope,
  disabledReason = null,
  onRefresh,
}: GitManagerPullRequestPanelProps) {
  const [requested, setRequested] = useState(false);
  const queryAtom = useMemo(
    () =>
      requested && disabledReason === null
        ? gitManagerEnvironment.listPullRequests({
            environmentId: scope.environmentId,
            input: { cwd: scope.cwd },
          })
        : null,
    [disabledReason, requested, scope.cwd, scope.environmentId],
  );
  const query = useEnvironmentQuery(queryAtom);
  const result: GitManagerPullRequestsResult | null = query.data ?? null;
  const presentation = resolveProviderPanePresentation({
    requested,
    pending: query.isPending,
    error: query.error,
    result,
  });
  const pullRequests = result?.pullRequests ?? EMPTY_PULL_REQUESTS;
  const checks = result?.checks ?? EMPTY_CHECKS;
  const createPullRequest = useGitStackedAction(scope);
  const createPullRequestRun = createPullRequest.run;
  const createPullRequestPending = createPullRequest.isPending;

  const refresh = useCallback(() => {
    if (disabledReason !== null) return;
    onRefresh();
    if (requested) {
      query.refresh();
    } else {
      setRequested(true);
    }
  }, [disabledReason, onRefresh, query.refresh, requested]);
  const create = useCallback(() => {
    if (disabledReason !== null) return;
    void createPullRequestRun(createPullRequestAction(randomUUID()));
  }, [createPullRequestRun, disabledReason]);
  const disabledReasonId =
    disabledReason === null ? undefined : "git-manager-pull-request-panel-disabled-reason";

  return (
    <section aria-label="Pull requests and checks" className="flex min-h-0 flex-col gap-3 p-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Pull requests and checks</h2>
          <p className="text-[11px] text-muted-foreground">
            Provider data refreshes only on demand.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            aria-describedby={disabledReasonId}
            disabled={disabledReason !== null || createPullRequestPending}
            size="xs"
            title={disabledReason ?? undefined}
            variant="outline"
            onClick={create}
          >
            <GitPullRequestIcon aria-hidden="true" />
            Create pull request
          </Button>
          <Button
            aria-describedby={disabledReasonId}
            disabled={disabledReason !== null || query.isPending}
            size="xs"
            title={disabledReason ?? undefined}
            variant="outline"
            onClick={refresh}
          >
            <RefreshCwIcon aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </header>
      <p
        aria-live="polite"
        className={
          presentation.kind === "error"
            ? "text-xs text-destructive"
            : "text-xs text-muted-foreground"
        }
        id={disabledReasonId}
        role={presentation.kind === "loading" ? "status" : undefined}
      >
        {disabledReason ?? presentation.message}
      </p>
      {requested && pullRequests.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold">Current pull request</h3>
          <ul className="space-y-2">
            {pullRequests.map((pullRequest) => (
              <PullRequestRow key={pullRequest.number} pullRequest={pullRequest} />
            ))}
          </ul>
        </div>
      ) : null}
      {requested && checks.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold">Checks</h3>
          <ul className="space-y-1.5">
            {checks.map((check) => (
              <CheckRow key={`${check.workflow ?? ""}\u0000${check.name}`} check={check} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
});
