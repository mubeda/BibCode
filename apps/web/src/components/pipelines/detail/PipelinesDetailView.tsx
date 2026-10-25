import { projectKey } from "@bibcode/client-runtime/state/entities";
import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import {
  PullRequestsOperationError,
  type PipelinesDetail,
  type PipelinesRefusal,
  type PullRequestsProviderKind,
} from "@bibcode/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  useCallback,
  use,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useState,
  type Ref,
} from "react";
import { DEFAULT_PIPELINES_FILTERS, usePipelinesStore } from "../../../pipelinesStore";
import { pipelinesEnvironment } from "../../../state/pipelines";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../../state/query";
import { prefetchedWithin } from "../../pullRequests/hoverPrefetch.logic";
import { PullRequestsContextRefresh } from "../../pullRequests/pullRequestsContextRefresh";
import { usePullRequestsQuery } from "../../pullRequests/shared/usePullRequestsQuery";
import { useDocumentVisible } from "../../pullRequests/useDocumentVisible";
import { useRepositoryModule } from "../../repositoryModule/RepositoryModule";
import { RepositoryModuleExternalLink } from "../../repositoryModule/RepositoryModuleExternalLink";
import { keepNewestCopy, type KeptCopy } from "../../repositoryModule/snapshotDisplay.logic";
import { useVisibleModuleRefresh } from "../../repositoryModule/useVisibleModuleRefresh";
import { PermissionButton } from "../../ui/permission-button";
import { Skeleton } from "../../ui/skeleton";
import { PipelineActions, type PipelineActionOutcome } from "../actions/PipelineActions";
import { pipelineActionDestination } from "../actions/pipelineActions.logic";
import { pipelineJobLink } from "../job/pipelineJobRoute";
import { buildPipelinesListInput } from "../list/pipelinesList.logic";
import { pipelineStatusText } from "../shared/pipelineStatus.logic";
import { useFinishedAnnouncement } from "../shared/useFinishedAnnouncement";
import { useRateLimitCountdown } from "../shared/useRateLimitCountdown";
import { PipelineAttemptSelect } from "./PipelineAttemptSelect";
import { PipelineDetailHeader } from "./PipelineDetailHeader";
import { PipelineStageColumns } from "./PipelineStageColumns";
import {
  QUIET_AFTER_MS,
  buildPipelineGetInput,
  detailSnapshotInput,
  detailTimerIntervalMs,
  pipelineAttemptOptions,
  pipelineFingerprint,
  pipelineHostUrl,
  pipelineStageColumns,
} from "./pipelineDetail.logic";

export interface PipelinesDetailViewHandle {
  refresh: () => void;
}

const isOperationError = Schema.is(PullRequestsOperationError);
const HOST_NAMES: Record<PullRequestsProviderKind, string> = { github: "GitHub", gitlab: "GitLab" };
const WAIT_REASON = "The host asked BiBCode to wait before reading again.";

function operationError(query: EnvironmentQueryView<unknown>) {
  const failure =
    query.emission._tag === "Failure" ? squashAtomCommandFailure(query.emission) : null;
  return isOperationError(failure) ? failure : null;
}

function BackToPipelines({
  projectRef,
}: {
  projectRef: { environmentId: string; projectId: string };
}) {
  return (
    <Link
      to="/project/$environmentId/$projectId/pipelines"
      params={projectRef}
      className="text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
    >
      Back to pipelines
    </Link>
  );
}

/** Where the host's job truncation notice applies, in its own words. */
function TruncationNotice({
  detail,
  provider,
}: {
  detail: PipelinesDetail;
  provider: PullRequestsProviderKind;
}) {
  if (!detail.truncated) return null;
  const url = detail.pipeline.url;
  const message =
    provider === "github"
      ? detail.totalJobs !== null
        ? `Showing the first 1,000 of ${detail.totalJobs.toLocaleString()} jobs.`
        : "Showing the first 1,000 jobs."
      : "Showing the first 100 jobs of a stage. Open the pipeline for the rest.";
  return (
    <p className="text-xs text-muted-foreground">
      {message}{" "}
      {url ? (
        <RepositoryModuleExternalLink href={url}>
          Open on {HOST_NAMES[provider]}
        </RepositoryModuleExternalLink>
      ) : null}
    </p>
  );
}

/** A run's artifacts: each opens the host's page, where the download is. */
function PipelineArtifacts({ detail }: { detail: PipelinesDetail }) {
  if (detail.artifacts.length === 0) return null;
  return (
    <section aria-label="Artifacts" className="space-y-1">
      <h3 className="px-2 text-sm font-medium">Artifacts</h3>
      <ul className="space-y-1 px-2 text-sm">
        {detail.artifacts.map((artifact) => (
          <li key={artifact.name} className="flex flex-wrap items-center gap-x-2">
            {artifact.url ? (
              <RepositoryModuleExternalLink href={artifact.url}>
                {artifact.name}
              </RepositoryModuleExternalLink>
            ) : (
              <span>{artifact.name}</span>
            )}
            {artifact.sizeBytes !== null ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.max(1, Math.round(artifact.sizeBytes / 1024)).toLocaleString()} KB
              </span>
            ) : null}
            {artifact.expired ? (
              <span className="text-xs text-muted-foreground">Expired</span>
            ) : artifact.expiresAt !== null && Number.isFinite(Date.parse(artifact.expiresAt)) ? (
              <span className="text-xs text-muted-foreground">
                Expires {new Date(artifact.expiresAt).toLocaleDateString()}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One pipeline: its header, then its stages and jobs. The stored copy paints at
 * once, then the live one; whichever copy has the highest `revision` (live, stored
 * or polled) stays on screen. On GitLab the page joins the project list's poller
 * with its pipeline, and a `pipeline` change repaints from storage with no host
 * read; GitHub, and GitLab while its stream is down, re-read on the visible timer
 * until the pipeline is `terminal`.
 */
export function PipelinesDetailView({
  pipelineId,
  attempt,
  onBackoffChange,
  ref,
}: {
  pipelineId: number;
  /** A GitHub run's earlier attempt; `null` for the latest. */
  attempt: number | null;
  /** The host asked for a pause: a Refresh before it ends would only be refused. */
  onBackoffChange: (backedOff: boolean) => void;
  ref?: Ref<PipelinesDetailViewHandle> | undefined;
}) {
  const {
    context,
    state: { scope },
    meta: { projectRef, mutationsDisabledReason },
  } = useRepositoryModule();
  const { environmentId, cwd } = scope;
  const provider = context.provider;
  const isGitlab = provider === "gitlab";
  const request = useMemo(
    () => ({ environmentId, input: buildPipelineGetInput(cwd, pipelineId, attempt) }),
    [attempt, cwd, environmentId, pipelineId],
  );
  // A hover prefetch that answered within FRESH_MS is shown as is on open.
  const [prefetched] = useState(() => prefetchedWithin("pipelines.get", request, Date.now()));
  const detailAtom = useMemo(() => pipelinesEnvironment.get(request), [request]);
  const detailQuery = usePullRequestsQuery(detailAtom, { freshOnOpen: prefetched });
  // The list key the project's list shows, so this page joins that list's poller.
  const filters = usePipelinesStore(
    (state) => state.byProjectKey[projectKey(projectRef)]?.filters ?? DEFAULT_PIPELINES_FILTERS,
  );
  const snapshotTarget = useMemo(
    () => ({
      environmentId,
      input: detailSnapshotInput(buildPipelinesListInput(filters, cwd), pipelineId, attempt),
    }),
    [attempt, cwd, environmentId, filters, pipelineId],
  );
  // Both hosts paint the stored copy; only GitLab subscribes to changes.
  const snapshotAtom = useMemo(
    () => pipelinesEnvironment.readSnapshot(snapshotTarget),
    [snapshotTarget],
  );
  const snapshotQuery = useEnvironmentQuery(snapshotAtom);
  // An earlier attempt's read cannot say how many followed: the latest attempt's
  // stored copy can, with no host call.
  const latestSnapshotAtom = useMemo(
    () =>
      provider === "github" && attempt !== null
        ? pipelinesEnvironment.readSnapshot({
            environmentId,
            input: { ...snapshotTarget.input, attempt: null },
          })
        : null,
    [attempt, environmentId, provider, snapshotTarget],
  );
  const latestSnapshotQuery = useEnvironmentQuery(latestSnapshotAtom);
  const visible = useDocumentVisible();
  const subscribeAtom = useMemo(
    () => (isGitlab && visible ? pipelinesEnvironment.subscribe(snapshotTarget) : null),
    [isGitlab, snapshotTarget, visible],
  );
  const subscribeQuery = useEnvironmentQuery(subscribeAtom);
  // Any success on the stream, even its first all-false event, stands the timer down
  // until the stream fails or waits again.
  const paused = isGitlab && subscribeQuery.emission._tag === "Success";
  // The poller's read of this pipeline was refused and its stored row dropped: the
  // refusal replaces the copy on screen until a Refresh reads the host again.
  const [refusal, setRefusal] = useState<{
    readonly request: typeof request;
    readonly code: PipelinesRefusal;
  } | null>(null);
  // Each event is a new object: a refusal is taken from the event that carries it.
  const [seenChange, setSeenChange] = useState<typeof subscribeQuery.data>(null);
  if (subscribeQuery.data !== seenChange) {
    setSeenChange(subscribeQuery.data);
    if (subscribeQuery.data?.refused) setRefusal({ request, code: subscribeQuery.data.refused });
  }
  const refused = refusal !== null && refusal.request === request ? refusal.code : null;
  const applySubscribedChange = useEffectEvent(
    (changed: NonNullable<typeof subscribeQuery.data>) => {
      // The poller already stored the new detail: paint it, never read the host again.
      if (changed.pipeline) snapshotQuery.revalidate();
    },
  );
  useEffect(() => {
    if (subscribeQuery.data) applySubscribedChange(subscribeQuery.data);
  }, [subscribeQuery.data]);
  const [kept, setKept] = useState<KeptCopy<PipelinesDetail> | null>(null);
  const choice = keepNewestCopy(kept, request, [
    detailQuery.data,
    snapshotQuery.data?.detail?.payload,
  ]);
  if (choice.kept !== kept) setKept(choice.kept);
  const detail = choice.shown;

  // A pipeline unchanged for QUIET_AFTER_MS is read half as often, as the poller does.
  const fingerprint = detail === null ? null : pipelineFingerprint(detail);
  const [quietFingerprint, setQuietFingerprint] = useState<string | null>(null);
  useEffect(() => {
    if (fingerprint === null) return;
    const timer = window.setTimeout(() => setQuietFingerprint(fingerprint), QUIET_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [fingerprint]);
  const quiet = fingerprint !== null && quietFingerprint === fingerprint;
  const revalidateDetail = detailQuery.revalidate;
  const timerRead = useCallback(() => {
    pipelinesEnvironment.requestTimerRead(request);
    revalidateDetail();
  }, [request, revalidateDetail]);
  const succeeded =
    detailQuery.data !== null && detailQuery.error === null && !detailQuery.isPending;
  useVisibleModuleRefresh({
    // The read that sees the pipeline turn terminal is its last.
    enabled: detail !== null && !detail.pipeline.terminal,
    succeeded,
    paused,
    ...(detail === null ? {} : { intervalMs: detailTimerIntervalMs(provider, detail, quiet) }),
    revalidate: timerRead,
  });

  const error = operationError(detailQuery);
  const refreshContext = use(PullRequestsContextRefresh);
  useEffect(() => {
    if (error?.code === "not_authenticated") refreshContext?.();
  }, [error, refreshContext]);
  const waitSeconds = useRateLimitCountdown(error, timerRead);
  const backedOff = waitSeconds !== null;
  useEffect(() => {
    onBackoffChange(backedOff);
  }, [backedOff, onBackoffChange]);
  const refreshDetail = detailQuery.refresh;
  const refresh = useCallback(() => {
    setRefusal(null);
    refreshDetail();
  }, [refreshDetail]);
  useImperativeHandle(ref, () => ({ refresh }), [refresh]);

  // A GitLab job retry opens the new job; a GitHub re-run of an earlier attempt opens
  // the run's latest. Anything else re-reads this page.
  const navigate = useNavigate();
  const { environmentId: routeEnvironmentId, projectId } = projectRef;
  const onActionSettled = useCallback(
    ({ request, result }: PipelineActionOutcome) => {
      const destination =
        result === null
          ? null
          : pipelineActionDestination({
              provider,
              request,
              result,
              shown: { pipelineId, attempt, jobId: null },
            });
      if (destination?.kind === "job") {
        void navigate(
          pipelineJobLink({
            environmentId: routeEnvironmentId,
            projectId,
            pipelineId: destination.pipelineId,
            jobId: destination.jobId,
          }),
        );
        return;
      }
      if (destination?.kind === "pipeline") {
        void navigate({
          to: "/project/$environmentId/$projectId/pipelines/$pipelineId",
          params: {
            environmentId: routeEnvironmentId,
            projectId,
            pipelineId: String(destination.pipelineId),
          },
        });
        return;
      }
      revalidateDetail();
    },
    [attempt, navigate, pipelineId, projectId, provider, revalidateDetail, routeEnvironmentId],
  );

  const statusText =
    detail === null
      ? ""
      : pipelineStatusText(
          detail.pipeline.status,
          detail.pipeline.warnings,
          detail.pipeline.reason,
        );
  const announcement = useFinishedAnnouncement(
    detail === null
      ? null
      : {
          id: detail.pipeline.id,
          status: detail.pipeline.status,
          terminal: detail.pipeline.terminal,
          message: `Pipeline ${detail.pipeline.label} ${statusText.toLowerCase()}.`,
        },
    detailQuery.data !== null,
  );

  // A refused or missing pipeline is about this resource only: say so here, and keep
  // the shared sign-in state for a lost login.
  const resourceCode =
    error?.code === "forbidden" || error?.code === "not_found" ? error.code : refused;
  const resourceError = resourceCode !== null;
  const message =
    resourceCode === "forbidden"
      ? "You can't view this pipeline."
      : resourceCode === "not_found"
        ? "This pipeline no longer exists."
        : (error?.message ?? detailQuery.error);
  const hostName = HOST_NAMES[provider];
  const alert =
    message === null ? null : (
      <div role="alert" className="space-y-2 border-b border-border p-4 text-sm">
        <p>{message}</p>
        {waitSeconds !== null ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            Trying again in {waitSeconds} s.
          </p>
        ) : error?.hostDetail && !resourceError ? (
          <p className="text-xs text-muted-foreground">{error.hostDetail}</p>
        ) : null}
        {/* A missing pipeline has nothing to retry; Back to pipelines sits above. */}
        {resourceCode === "not_found" ? null : (
          <div className="flex flex-wrap items-center gap-3">
            {resourceCode === "forbidden" ? (
              <RepositoryModuleExternalLink href={pipelineHostUrl(context, pipelineId)}>
                Open on {hostName}
              </RepositoryModuleExternalLink>
            ) : (
              <PermissionButton
                size="sm"
                variant="outline"
                onClick={refresh}
                permission={
                  waitSeconds !== null
                    ? { allowed: false, reason: WAIT_REASON }
                    : {
                        allowed: !detailQuery.isPending,
                        reason: detailQuery.isPending ? "Loading…" : null,
                      }
                }
              >
                Retry
              </PermissionButton>
            )}
          </div>
        )}
      </div>
    );
  const shown = resourceError ? null : detail;
  const attemptOptions =
    provider === "github" && shown !== null
      ? pipelineAttemptOptions(
          attempt,
          attempt === null
            ? shown.pipeline.attempt
            : (latestSnapshotQuery.data?.detail?.payload.pipeline.attempt ?? null),
        )
      : null;
  // GitHub's one column is built here; keep it stable so the memoized stages skip a re-render.
  const columns = useMemo(
    () => (shown === null ? null : pipelineStageColumns(shown, provider)),
    [provider, shown],
  );
  return (
    <PipelineActions.Provider
      scope={scope}
      provider={provider}
      revision={shown?.revision ?? null}
      onSettled={onActionSettled}
    >
      <div
        className="@container/pipeline flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
        data-text-surface="background"
      >
        <div className="px-4 pt-2">
          <BackToPipelines projectRef={projectRef} />
        </div>
        {alert}
        {shown !== null ? (
          <>
            <PipelineDetailHeader
              detail={shown}
              provider={provider}
              projectRef={projectRef}
              mutationsDisabledReason={mutationsDisabledReason}
              repositoryPermission={context.repositoryPermission}
            >
              {attemptOptions ? (
                <PipelineAttemptSelect
                  options={attemptOptions}
                  projectRef={projectRef}
                  pipelineId={pipelineId}
                />
              ) : null}
            </PipelineDetailHeader>
            <div className="space-y-4 p-4">
              <TruncationNotice detail={shown} provider={provider} />
              {columns === null ? (
                <p className="text-sm text-muted-foreground">
                  You can't view this pipeline's jobs.
                </p>
              ) : (
                <PipelineStageColumns
                  stages={columns}
                  mutationsDisabledReason={mutationsDisabledReason}
                />
              )}
              <PipelineArtifacts detail={shown} />
            </div>
          </>
        ) : message === null ? (
          <div role="status" className="space-y-3 p-4">
            <span className="sr-only">Loading pipeline…</span>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : null}
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>
    </PipelineActions.Provider>
  );
}
