import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PullRequestsActor,
  PullRequestsPipelineStage,
  PullRequestsPipelineStatus,
} from "./pullRequests.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

/**
 * A host's global pipeline or job id (GitLab `id`, GitHub run or job `id`).
 * `iid` and `run_number` are display only.
 */
export const PipelineId = PositiveInt;
export type PipelineId = typeof PipelineId.Type;

/**
 * Why a read runs: `user` opens a route, refreshes or loads more; `follow` catches a log up;
 * `timer` is a visible refresh. Every kind honors the host's backoff deadline.
 */
export const PipelinesRefresh = Schema.Literals(["user", "follow", "timer"]);
export type PipelinesRefresh = typeof PipelinesRefresh.Type;

/** When set, the status label comes from the reason, never from the status word. */
export const PipelinesReason = Schema.NullOr(
  Schema.Literals([
    "approval",
    "timed_out",
    "startup_failure",
    "action_required",
    "neutral",
    "stale",
    "yaml_error",
    "stuck",
    "failure_reason",
  ]),
);
export type PipelinesReason = typeof PipelinesReason.Type;

export const PipelinesBadge = Schema.Literals([
  "latest",
  "merge_request",
  "merged_results",
  "merge_train",
  "scheduled",
  "branch",
  "tag",
  "api",
  "trigger",
  "manual_run",
  "retried",
  "child",
  "yaml_invalid",
  "stuck",
]);
export type PipelinesBadge = typeof PipelinesBadge.Type;

export const PipelinesRef = Schema.Struct({
  kind: Schema.Literals(["branch", "tag", "merge_request", "other"]),
  name: Schema.String,
  /** The merge request or pull request number. */
  number: Schema.NullOr(Schema.Number),
  url: Schema.NullOr(Schema.String),
});
export type PipelinesRef = typeof PipelinesRef.Type;

/**
 * `granted`: the host said yes. `denied`: the host said no, or refused an earlier action.
 * `unknown`: enabled, and a refusal is shown at the button.
 */
export const PipelinesPermission = Schema.Literals(["granted", "denied", "unknown"]);
export type PipelinesPermission = typeof PipelinesPermission.Type;

export const PipelinesPermissions = Schema.Struct({
  retry: PipelinesPermission,
  cancel: PipelinesPermission,
});
export type PipelinesPermissions = typeof PipelinesPermissions.Type;

export const PipelinesRow = Schema.Struct({
  id: PipelineId,
  /** `#4821` on GitLab, `CI #312` on GitHub. */
  label: Schema.String,
  /** The commit title, pipeline name or run title. */
  title: Schema.NullOr(Schema.String),
  status: PullRequestsPipelineStatus,
  warnings: Schema.Boolean,
  reason: PipelinesReason,
  /** The provider says nothing more will run; timers and the poller stop on this. */
  terminal: Schema.Boolean,
  ref: PipelinesRef,
  sha: Schema.String,
  actor: Schema.NullOr(PullRequestsActor),
  badges: Schema.Array(PipelinesBadge),
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(Schema.Number),
  queuedSeconds: Schema.NullOr(Schema.Number),
  /** `null`: none (a GitHub list row) or hidden from this account. */
  stages: Schema.NullOr(Schema.Array(PullRequestsPipelineStage)),
  /** GitHub `run_attempt`. */
  attempt: Schema.NullOr(Schema.Number),
  /** `null`: the host gave no answer; mutations are shown disabled. */
  permissions: Schema.NullOr(PipelinesPermissions),
  url: Schema.NullOr(Schema.String),
});
export type PipelinesRow = typeof PipelinesRow.Type;

export const PipelinesListScope = Schema.Literals(["all", "running", "finished"]);
export type PipelinesListScope = typeof PipelinesListScope.Type;

export const PipelinesListInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  scope: PipelinesListScope,
  ref: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /** GitHub only; ignored on GitLab. */
  workflowId: Schema.NullOr(Schema.Number),
  cursor: Schema.NullOr(Schema.String),
  refresh: PipelinesRefresh,
});
export type PipelinesListInput = typeof PipelinesListInput.Type;

export const PipelinesListPage = Schema.Struct({
  /** The generation stamp taken before the read; equal to its stored row's. */
  revision: Schema.Number,
  rows: Schema.Array(PipelinesRow),
  nextCursor: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.Struct({ count: Schema.Number, capped: Schema.Boolean })),
  workflows: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
  ),
});
export type PipelinesListPage = typeof PipelinesListPage.Type;

export const PipelinesJobPermissions = Schema.Struct({
  retry: PipelinesPermission,
  cancel: PipelinesPermission,
  play: PipelinesPermission,
});
export type PipelinesJobPermissions = typeof PipelinesJobPermissions.Type;

export const PipelinesJob = Schema.Struct({
  id: PipelineId,
  name: Schema.String,
  stage: Schema.String,
  kind: Schema.Literals(["build", "trigger"]),
  status: PullRequestsPipelineStatus,
  warnings: Schema.Boolean,
  reason: PipelinesReason,
  terminal: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(Schema.Number),
  queuedSeconds: Schema.NullOr(Schema.Number),
  permissions: PipelinesJobPermissions,
  url: Schema.NullOr(Schema.String),
  downstreamUrl: Schema.NullOr(Schema.String),
});
export type PipelinesJob = typeof PipelinesJob.Type;

export const PipelinesGetInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  pipelineId: PipelineId,
  attempt: Schema.NullOr(Schema.Number),
  refresh: PipelinesRefresh,
});
export type PipelinesGetInput = typeof PipelinesGetInput.Type;

export const PipelinesArtifact = Schema.Struct({
  name: Schema.String,
  sizeBytes: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.String),
  expired: Schema.Boolean,
  /** A host web page, never an API URL. */
  url: Schema.NullOr(Schema.String),
});
export type PipelinesArtifact = typeof PipelinesArtifact.Type;

export const PipelinesJobGroup = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  status: PullRequestsPipelineStatus,
  jobs: Schema.Array(PipelinesJob),
});
export type PipelinesJobGroup = typeof PipelinesJobGroup.Type;

export const PipelinesDetailStage = Schema.Struct({
  name: Schema.String,
  status: PullRequestsPipelineStatus,
  warnings: Schema.Boolean,
  groups: Schema.Array(PipelinesJobGroup),
});
export type PipelinesDetailStage = typeof PipelinesDetailStage.Type;

export const PipelinesDetail = Schema.Struct({
  revision: Schema.Number,
  pipeline: PipelinesRow,
  commit: Schema.Struct({
    sha: Schema.String,
    title: Schema.NullOr(Schema.String),
    url: Schema.NullOr(Schema.String),
  }),
  totalJobs: Schema.NullOr(Schema.Number),
  /** `null`: this account cannot read the pipeline's jobs. */
  stages: Schema.NullOr(Schema.Array(PipelinesDetailStage)),
  /** GitLab: a group over 100 jobs. GitHub: a run over 1,000 jobs. */
  truncated: Schema.Boolean,
  /** Reserved for the deferred job dependencies view. */
  usesNeeds: Schema.Boolean,
  /** GitHub run artifacts; empty on GitLab, where artifacts belong to jobs. */
  artifacts: Schema.Array(PipelinesArtifact),
});
export type PipelinesDetail = typeof PipelinesDetail.Type;

export const PipelinesJobInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  jobId: PipelineId,
  refresh: PipelinesRefresh,
});
export type PipelinesJobInput = typeof PipelinesJobInput.Type;

export const PipelinesJobDetail = Schema.Struct({
  revision: Schema.Number,
  job: PipelinesJob,
  pipelineId: PipelineId,
  attempt: Schema.NullOr(Schema.Number),
  runner: Schema.NullOr(
    Schema.Struct({ name: Schema.String, description: Schema.NullOr(Schema.String) }),
  ),
  /** GitLab `tag_list`, GitHub `runs-on` labels. */
  tags: Schema.Array(Schema.String),
  /** The provider's own source literal, shown verbatim. */
  source: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** GitLab: the job's artifacts. GitHub: the run's. */
  artifacts: Schema.Array(PipelinesArtifact),
  /** GitHub steps; empty on GitLab. */
  steps: Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      name: Schema.String,
      status: PullRequestsPipelineStatus,
      startedAt: Schema.NullOr(Schema.String),
      completedAt: Schema.NullOr(Schema.String),
    }),
  ),
  logBytes: Schema.NullOr(Schema.Number),
  erased: Schema.Boolean,
  rawLogUrl: Schema.NullOr(Schema.String),
});
export type PipelinesJobDetail = typeof PipelinesJobDetail.Type;

export const PipelinesLogFrom = Schema.Union([
  /** The last chunk. */
  Schema.TaggedStruct("tail", {}),
  /** Follow a running log, or load later text. */
  Schema.TaggedStruct("offset", { offset: Schema.Number }),
  /** Load earlier text. */
  Schema.TaggedStruct("before", { offset: Schema.Number }),
]);
export type PipelinesLogFrom = typeof PipelinesLogFrom.Type;

export const PipelinesJobLogInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  jobId: PipelineId,
  attempt: Schema.NullOr(Schema.Number),
  from: PipelinesLogFrom,
  refresh: PipelinesRefresh,
});
export type PipelinesJobLogInput = typeof PipelinesJobLogInput.Type;

export const PipelinesLogUnavailableReason = Schema.Literals([
  "not_started",
  "no_output",
  "erased",
  "expired",
  "live_on_host",
  "too_large_live",
]);
export type PipelinesLogUnavailableReason = typeof PipelinesLogUnavailableReason.Type;

export const PipelinesJobLog = Schema.Union([
  Schema.TaggedStruct("chunk", {
    text: Schema.String,
    /** Byte offset of the first byte of `text`. */
    offset: Schema.Number,
    /** Always a character start. */
    nextOffset: Schema.Number,
    /** `null` while unknown. */
    totalBytes: Schema.NullOr(Schema.Number),
    /** The job is terminal and `nextOffset` is the end. */
    complete: Schema.Boolean,
    /** Bytes before the earliest reachable offset are gone. */
    truncatedHead: Schema.Boolean,
    /** 0-based line index of the first line of `text`; `null` while the prefix is unread. */
    firstLine: Schema.NullOr(Schema.Number),
  }),
  Schema.TaggedStruct("unavailable", {
    reason: PipelinesLogUnavailableReason,
    url: Schema.NullOr(Schema.String),
  }),
]);
export type PipelinesJobLog = typeof PipelinesJobLog.Type;

/** The list key, plus the pipeline and job a route shows. `cursor` and `refresh` are ignored. */
export const PipelinesSubscribeInput = Schema.Struct({
  ...PipelinesListInput.fields,
  pipelineId: Schema.NullOr(PipelineId),
  attempt: Schema.NullOr(Schema.Number),
  /** `readSnapshot` only; the poller never reads jobs. */
  jobId: Schema.NullOr(PipelineId),
});
export type PipelinesSubscribeInput = typeof PipelinesSubscribeInput.Type;

const PipelinesStoredList = Schema.Struct({
  payload: PipelinesListPage,
  observedAt: Schema.Number,
});

const PipelinesStoredDetail = Schema.Struct({
  payload: PipelinesDetail,
  observedAt: Schema.Number,
});

const PipelinesStoredJob = Schema.Struct({
  payload: PipelinesJobDetail,
  observedAt: Schema.Number,
});

/** The last good copies, painted with no host call. */
export const PipelinesSnapshot = Schema.Struct({
  list: Schema.NullOr(PipelinesStoredList),
  detail: Schema.NullOr(PipelinesStoredDetail),
  job: Schema.NullOr(PipelinesStoredJob),
});
export type PipelinesSnapshot = typeof PipelinesSnapshot.Type;

/** Which stored copies changed: answer with `readSnapshot`. The first event is all false. */
export const PipelinesChanged = Schema.Struct({
  list: Schema.Boolean,
  pipeline: Schema.Boolean,
});
export type PipelinesChanged = typeof PipelinesChanged.Type;
