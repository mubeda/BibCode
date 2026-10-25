import type {
  PipelinesBadge,
  PipelinesReason,
  PullRequestsPipelineStatus,
} from "@bibcode/contracts";

const STATUS_LABELS: Record<PullRequestsPipelineStatus, string> = {
  created: "Created",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  manual: "Manual",
  scheduled: "Scheduled",
  canceling: "Canceling",
  success: "Passed",
  failed: "Failed",
  canceled: "Canceled",
  skipped: "Skipped",
  unknown: "Unknown",
};
const REASON_LABELS: Record<NonNullable<PipelinesReason>, string> = {
  approval: "Waiting for approval",
  timed_out: "Timed out",
  startup_failure: "Startup failure",
  action_required: "Action required",
  neutral: "Neutral",
  stale: "Stale",
  yaml_error: "YAML error",
  stuck: "Stuck",
  failure_reason: "Failed",
};

/**
 * A pipeline, stage or job status in words. A reason names the outcome when the
 * status alone would mislead (a neutral run is not "Passed"), so it wins.
 */
export function pipelineStatusText(
  status: PullRequestsPipelineStatus,
  warnings: boolean,
  reason: PipelinesReason = null,
): string {
  if (reason !== null) return REASON_LABELS[reason];
  return status === "success" && warnings ? "Passed with warnings" : STATUS_LABELS[status];
}

const BADGE_LABELS: Record<PipelinesBadge, string> = {
  latest: "latest",
  merge_request: "merge request",
  merged_results: "merged results",
  merge_train: "merge train",
  scheduled: "scheduled",
  branch: "branch",
  tag: "tag",
  api: "API",
  trigger: "trigger",
  manual_run: "manual run",
  retried: "retried",
  child: "child",
  yaml_invalid: "YAML invalid",
  stuck: "stuck",
};

export function pipelineBadgeLabel(badge: PipelinesBadge): string {
  return BADGE_LABELS[badge];
}

/** `4m 12s`, `1h 5m` or `12s`; durations from the host are whole or fractional seconds. */
export function formatPipelineDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}
