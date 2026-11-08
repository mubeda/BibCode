import type {
  PipelinesDetail,
  PipelinesDetailStage,
  PipelinesGetInput,
  PipelinesJob,
  PipelinesJobGroup,
  PipelinesListInput,
  PipelinesSubscribeInput,
  PullRequestsPipelineStatus,
  PullRequestsProviderKind,
} from "@bibcode/contracts";
import type { PipelineActionPermission } from "../list/pipelinesList.logic";

/**
 * The pipeline's `get` input. Every view reads it as `user`, exactly as a hovered
 * list row prefetched it, so an open within 5 s of that prefetch reuses its answer.
 */
export function buildPipelineGetInput(
  cwd: string,
  pipelineId: number,
  attempt: number | null,
): PipelinesGetInput {
  return { cwd, pipelineId, attempt, refresh: "user" };
}

/**
 * The `readSnapshot` and `subscribe` input of a pipeline page: the list key the
 * project's list shows, so the page joins that list's poller, plus the pipeline.
 */
export function detailSnapshotInput(
  list: PipelinesListInput,
  pipelineId: number,
  attempt: number | null,
): PipelinesSubscribeInput {
  return { ...list, cursor: null, refresh: "user", pipelineId, attempt, jobId: null };
}

/**
 * The columns a pipeline page shows, or `null` when the account cannot read the
 * jobs. GitLab keeps its stages in the host's order; GitHub has no stages, so all of
 * a run's jobs sit in one column titled "Jobs", in the order the host returned them.
 */
export function pipelineStageColumns(
  detail: Pick<PipelinesDetail, "pipeline" | "stages">,
  provider: PullRequestsProviderKind,
): readonly PipelinesDetailStage[] | null {
  if (detail.stages === null) return null;
  if (provider === "gitlab") return detail.stages;
  return [
    {
      name: "Jobs",
      status: detail.pipeline.status,
      warnings: detail.pipeline.warnings,
      groups: detail.stages.flatMap((stage) => stage.groups),
    },
  ];
}

/** The host knows how GitLab schedules some of this pipeline's jobs (absent or null: no). */
export function hasJobDependencies(detail: Pick<PipelinesDetail, "usesNeeds" | "stages">): boolean {
  if (!detail.usesNeeds) return false;
  for (const stage of detail.stages ?? [])
    for (const group of stage.groups)
      for (const job of group.jobs) if (job.scheduling != null) return true;
  return false;
}

/** The status a layer's header shows: the one needing attention first. */
const LAYER_STATUS_ORDER: readonly PullRequestsPipelineStatus[] = [
  "failed",
  "running",
  "canceling",
  "waiting",
  "queued",
  "created",
  "scheduled",
  "manual",
  "canceled",
  "success",
  "skipped",
  "unknown",
];

/**
 * GitLab's "Job dependencies" grouping: a `dag` group sits one layer after the latest
 * group it needs (layer 1 when it needs none shown); a `stage` or unknown group one
 * layer after every group of the earlier stages, when GitLab starts it. A need names a
 * job or a parallel group; one not shown is ignored, and a cycle is broken.
 */
export function pipelineNeedsColumns(
  stages: readonly PipelinesDetailStage[],
): readonly PipelinesDetailStage[] {
  const groups = stages.flatMap((stage, stageIndex) =>
    stage.groups.map((group) => ({ group, stageIndex })),
  );
  const byName = new Map<string, number>();
  groups.forEach(({ group }, index) => {
    byName.set(group.name, index);
    for (const job of group.jobs) byName.set(job.name, index);
  });
  const layers: (number | undefined)[] = [];
  const visiting = new Set<number>();
  const layerOf = (index: number): number => {
    const known = layers[index];
    if (known !== undefined) return known;
    if (visiting.has(index)) return 0;
    visiting.add(index);
    const { group, stageIndex } = groups[index]!;
    const dag = group.jobs.length > 0 && group.jobs.every((job) => job.scheduling === "dag");
    let after = -1;
    if (dag) {
      for (const job of group.jobs)
        for (const need of job.needs ?? []) {
          const needed = byName.get(need);
          if (needed !== undefined && needed !== index) after = Math.max(after, layerOf(needed));
        }
    } else {
      groups.forEach((other, otherIndex) => {
        if (other.stageIndex < stageIndex) after = Math.max(after, layerOf(otherIndex));
      });
    }
    visiting.delete(index);
    layers[index] = after + 1;
    return after + 1;
  };
  const columns: PipelinesJobGroup[][] = [];
  groups.forEach(({ group }, index) => {
    (columns[layerOf(index)] ??= []).push(group);
  });
  return columns.flatMap((column, layer) =>
    column === undefined
      ? []
      : [
          {
            name: `Layer ${layer + 1}`,
            status:
              LAYER_STATUS_ORDER.find((status) =>
                column.some((group) => group.status === status),
              ) ?? "unknown",
            warnings: column.some((group) => group.jobs.some((job) => job.warnings)),
            groups: column,
          },
        ],
  );
}

/** The host's job total, or the jobs shown when it gave none. */
export function pipelineJobCount(detail: Pick<PipelinesDetail, "totalJobs" | "stages">) {
  if (detail.totalJobs !== null) return detail.totalJobs;
  if (detail.stages === null) return null;
  let count = 0;
  for (const stage of detail.stages) for (const group of stage.groups) count += group.jobs.length;
  return count;
}

export interface PipelineJobAction {
  readonly kind: "play" | "cancel" | "retry";
  readonly label: string;
  readonly permission: PipelineActionPermission;
}

/**
 * A job row's one trailing action: Run for a manual job, Cancel for one still
 * active, Retry for a finished one. GitLab's `retryable`, `cancelable` and
 * `playable` arrive as `denied` both for a refused account and for a job the action
 * does not apply to, so a refused action is left out rather than shown as forbidden.
 */
export function pipelineJobAction(
  job: Pick<PipelinesJob, "name" | "status" | "terminal" | "permissions">,
  mutationsDisabledReason: string | null,
): PipelineJobAction | null {
  const kind =
    job.status === "manual" && job.permissions.play !== "denied"
      ? "play"
      : !job.terminal && job.permissions.cancel !== "denied"
        ? "cancel"
        : job.terminal && job.permissions.retry !== "denied"
          ? "retry"
          : null;
  if (kind === null) return null;
  const verb = kind === "play" ? "Run" : kind === "cancel" ? "Cancel" : "Retry";
  return {
    kind,
    label: `${verb} ${job.name}`,
    permission:
      mutationsDisabledReason === null
        ? { allowed: true, reason: null }
        : { allowed: false, reason: mutationsDisabledReason },
  };
}

/** The poller's cadence for an active pipeline, and its quiet cadence after 30 unchanged minutes. */
export const ACTIVE_PIPELINE_REFRESH_MS = 10_000;
export const QUIET_AFTER_MS = 30 * 60_000;
const GITHUB_JOB_PAGE_SIZE = 100;
const GITHUB_MAX_JOB_PAGES = 10;

/**
 * How often a pipeline page's visible timer re-reads an active pipeline: GitLab
 * (the fallback while its stream is down) every 10 s, as its poller would; GitHub
 * every 10 s per page of jobs, since each read costs the run plus every jobs page.
 * Both double once the pipeline has not changed for `QUIET_AFTER_MS`.
 */
export function detailTimerIntervalMs(
  provider: PullRequestsProviderKind,
  detail: Pick<PipelinesDetail, "totalJobs" | "stages">,
  quiet: boolean,
): number {
  const jobs = pipelineJobCount(detail) ?? 0;
  const pages =
    provider === "github"
      ? Math.min(GITHUB_MAX_JOB_PAGES, Math.max(1, Math.ceil(jobs / GITHUB_JOB_PAGE_SIZE)))
      : 1;
  return ACTIVE_PIPELINE_REFRESH_MS * pages * (quiet ? 2 : 1);
}

/** What the poller compares: the pipeline's status and each job's id and status. */
export function pipelineFingerprint(detail: Pick<PipelinesDetail, "pipeline" | "stages">) {
  const parts: string[] = [detail.pipeline.status];
  for (const stage of detail.stages ?? [])
    for (const group of stage.groups)
      for (const job of group.jobs) parts.push(`${job.id}:${job.status}`);
  return parts.join(",");
}

export interface PipelineAttemptOptions {
  /** `latest`, or the shown earlier attempt's number. */
  readonly value: string;
  readonly items: readonly { readonly value: string; readonly label: string }[];
}

/**
 * A GitHub run's Attempt choices, or `null` for a run with one attempt. `shown` is the
 * route's earlier attempt (`null` on the latest); `latest` is the latest attempt's
 * number when known. An earlier attempt's own read cannot say how many followed, so
 * without it the choices are "Latest attempt" and the attempts up to the shown one.
 */
export function pipelineAttemptOptions(
  shown: number | null,
  latest: number | null,
): PipelineAttemptOptions | null {
  const newest = latest !== null && latest > (shown ?? 0) ? latest : null;
  if (shown === null && (newest === null || newest <= 1)) return null;
  const items: { value: string; label: string }[] = [
    {
      value: "latest",
      label: newest === null ? "Latest attempt" : `Attempt ${newest} (latest)`,
    },
  ];
  for (let attempt = newest === null ? shown! : newest - 1; attempt >= 1; attempt -= 1)
    items.push({ value: String(attempt), label: `Attempt ${attempt}` });
  return { value: shown === null ? "latest" : String(shown), items };
}

/** The host's page for a pipeline, for when no read has returned its own link. */
export function pipelineHostUrl(
  context: { readonly provider: PullRequestsProviderKind; readonly webUrl: string },
  pipelineId: number,
): string {
  const base = context.webUrl.replace(/\/+$/, "");
  return context.provider === "github"
    ? `${base}/actions/runs/${pipelineId}`
    : `${base}/-/pipelines/${pipelineId}`;
}
