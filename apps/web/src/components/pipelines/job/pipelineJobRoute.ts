/**
 * The job route's address. The pipeline page and the merge request tab link here with
 * `pipelineJobLink`, so no caller spells the path or its search by hand.
 */
export const PIPELINE_JOB_ROUTE =
  "/project/$environmentId/$projectId/pipelines/$pipelineId/jobs/$jobId" as const;

export interface PipelineJobRouteSearch {
  /** Byte offset of a linked log line's start. */
  readonly at?: number;
}

/** A route id: a positive integer that fits a JavaScript `Number`, or `null`. */
export function parsePipelineRouteId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

export function validatePipelineJobSearch(search: Record<string, unknown>): PipelineJobRouteSearch {
  const raw = typeof search.at === "string" ? Number(search.at) : search.at;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? { at: raw } : {};
}

/** The `Link`/`navigate` target for one job, optionally opened at a log line's byte offset. */
export function pipelineJobLink(target: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly pipelineId: number;
  readonly jobId: number;
  readonly at?: number | null;
}) {
  return {
    to: PIPELINE_JOB_ROUTE,
    params: {
      environmentId: target.environmentId,
      projectId: target.projectId,
      pipelineId: String(target.pipelineId),
      jobId: String(target.jobId),
    },
    search: (target.at ?? null) === null ? {} : { at: target.at! },
  };
}
