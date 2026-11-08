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
  useRef,
  useState,
  type Ref,
} from "react";
import { cn } from "../../../lib/utils";
import { useLocalStorage } from "~/hooks/useLocalStorage";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
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
import { PipelineJobLogPanel } from "./PipelineJobLogPanel";
import { PipelineLinksProvider, usePipelineLinks } from "./PipelineLinks";
import { PipelineStageColumns } from "./PipelineStageColumns";
import {
  QUIET_AFTER_MS,
  buildPipelineGetInput,
  detailSnapshotInput,
  detailTimerIntervalMs,
  pipelineAttemptOptions,
  pipelineFingerprint,
  hasJobDependencies,
  pipelineHostUrl,
  pipelineNeedsColumns,
  pipelineStageColumns,
} from "./pipelineDetail.logic";

export interface PipelinesDetailViewHandle {
  refresh: () => void;
}

const isOperationError = Schema.is(PullRequestsOperationError);
const GROUPING_KEY = "bibcode:pipelines-job-grouping";
const GroupingSchema = Schema.Literals(["stage", "needs"]);
type JobGrouping = typeof GroupingSchema.Type;
const GROUPING_ITEMS: readonly { readonly value: JobGrouping; readonly label: string }[] = [
  { value: "stage", label: "Stage" },
  { value: "needs", label: "Job dependencies" },
];

/** GitLab's "Group jobs by": stages, or layers of `needs`. Offered only when known. */
function JobGroupingSelect({
  value,
  onChange,
}: {
  value: JobGrouping;
  onChange: (value: JobGrouping) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span id="pipeline-job-grouping-label">Group jobs by</span>
      <div className="w-40">
        <Select
          modal={false}
          items={GROUPING_ITEMS}
          value={value}
          onValueChange={(next) => {
            if (next !== null) onChange(next);
          }}
        >
          <SelectTrigger aria-labelledby="pipeline-job-grouping-label" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {GROUPING_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}
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
  jobId,
  onJobChange,
  onBackoffChange,
  ref,
}: {
  pipelineId: number;
  /** A GitHub run's earlier attempt; `null` for the latest. */
  attempt: number | null;
  /** The job whose log shows beside the stages, from the route. */
  jobId: number | null;
  onJobChange: (jobId: number | null) => void;
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
  const [grouping, setGrouping] = useLocalStorage(GROUPING_KEY, "stage", GroupingSchema);
  const dependencies = shown !== null && hasJobDependencies(shown);
  const byNeeds = dependencies && grouping === "needs";
  const columns = useMemo(() => {
    const stages = shown === null ? null : pipelineStageColumns(shown, provider);
    return stages !== null && byNeeds ? pipelineNeedsColumns(stages) : stages;
  }, [byNeeds, provider, shown]);
  const selectedJobId = jobId;
  const outerLinks = usePipelineLinks();
  const links = useMemo(
    () => ({ ...outerLinks, selectJob: onJobChange, selectedJobId }),
    [onJobChange, outerLinks, selectedJobId],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const closeLog = useCallback(() => {
    // Focus goes back to the job's row, which stays on the page.
    rootRef.current?.querySelector<HTMLElement>('a[aria-current="true"]')?.focus();
    onJobChange(null);
  }, [onJobChange]);
  const logShown = selectedJobId !== null && shown !== null;
  return (
    <PipelineActions.Provider
      scope={scope}
      provider={provider}
      revision={shown?.revision ?? null}
      onSettled={onActionSettled}
    >
      <div
        ref={rootRef}
        className="@container/pipeline flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
        data-text-surface="background"
      >
        {/* With a log open on a wide page, the stages and the log scroll on their own. */}
        <div
          className={cn(
            "flex min-w-0 flex-col",
            logShown &&
              "@min-[960px]/pipeline:min-h-0 @min-[960px]/pipeline:flex-1 @min-[960px]/pipeline:flex-row",
          )}
        >
          <div
            className={cn(
              "min-w-0",
              logShown &&
                "@min-[960px]/pipeline:min-h-0 @min-[960px]/pipeline:flex-1 @min-[960px]/pipeline:overflow-y-auto",
            )}
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
                    <PipelineLinksProvider value={links}>
                      <PipelineStageColumns
                        stages={columns}
                        mutationsDisabledReason={mutationsDisabledReason}
                        controls={
                          dependencies ? (
                            <JobGroupingSelect value={grouping} onChange={setGrouping} />
                          ) : null
                        }
                      />
                    </PipelineLinksProvider>
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
          </div>
          {logShown ? (
            <PipelineJobLogPanel
              key={selectedJobId}
              detail={shown}
              jobId={selectedJobId}
              onClose={closeLog}
            />
          ) : null}
        </div>
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>
    </PipelineActions.Provider>
  );
}
